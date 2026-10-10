from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

VIEWER = "viewer-0000000001"
OWNER = "owner-00000000001"
HEADER = b"\x1a\x45\xdf\xa3" + b"NEWHEADER"


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("ASYNC_VIDEO_DATA_DIR", str(tmp_path))
    from app.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client


def make_ready_video(client: TestClient, raw: bytes = b"OLDHEADCLUSTERS-AND-MORE") -> dict:
    video = client.post("/api/videos", json={"title": "Demo", "sourceMode": "screen"}).json()
    half = len(raw) // 2
    client.put(f"/api/videos/{video['id']}/chunks/0", content=raw[:half])
    client.put(f"/api/videos/{video['id']}/chunks/1", content=raw[half:])
    res = client.post(
        f"/api/videos/{video['id']}/finalize",
        params={"chunkCount": 2, "bodyOffset": 7, "durationMs": 4000, "width": 1280, "height": 720},
        content=HEADER,
    )
    assert res.status_code == 200, res.text
    return res.json()


def test_schema_copy_matches_replica() -> None:
    backend = Path(__file__).resolve().parents[1] / "app" / "schema.sql"
    replica = Path(__file__).resolve().parents[2] / "replica" / "schema.sql"
    assert backend.read_bytes() == replica.read_bytes()


def test_create_upload_finalize_splices_header(client: TestClient, tmp_path: Path) -> None:
    video = make_ready_video(client)
    assert video["status"] == "ready"
    assert video["seekable"] is True
    assert video["durationMs"] == 4000
    media = (tmp_path / "videos" / video["id"] / "video.webm").read_bytes()
    assert media == HEADER + b"CLUSTERS-AND-MORE"
    assert not (tmp_path / "videos" / video["id"] / "chunks").exists()


def test_finalize_reports_missing_chunks(client: TestClient) -> None:
    video = client.post("/api/videos", json={}).json()
    client.put(f"/api/videos/{video['id']}/chunks/0", content=b"abc")
    client.put(f"/api/videos/{video['id']}/chunks/2", content=b"ghi")
    res = client.post(f"/api/videos/{video['id']}/finalize", params={"chunkCount": 3})
    assert res.status_code == 409
    assert res.json()["detail"]["missing"] == [1]
    assert client.get(f"/api/videos/{video['id']}/chunks").json()["received"] == [0, 2]


def test_finalize_is_idempotent_and_closes_upload(client: TestClient) -> None:
    video = make_ready_video(client)
    again = client.post(f"/api/videos/{video['id']}/finalize", params={"chunkCount": 2})
    assert again.status_code == 200
    assert again.json()["sizeBytes"] == video["sizeBytes"]
    late = client.put(f"/api/videos/{video['id']}/chunks/5", content=b"x")
    assert late.status_code == 409


def test_finalize_without_header_keeps_raw(client: TestClient, tmp_path: Path) -> None:
    video = client.post("/api/videos", json={}).json()
    client.put(f"/api/videos/{video['id']}/chunks/0", content=b"RAW")
    res = client.post(f"/api/videos/{video['id']}/finalize", params={"chunkCount": 1})
    assert res.json()["seekable"] is False
    assert (tmp_path / "videos" / video["id"] / "video.webm").read_bytes() == b"RAW"


def test_raw_returns_chunks_in_order(client: TestClient) -> None:
    video = client.post("/api/videos", json={}).json()
    for seq, part in enumerate([b"aa", b"bb", b"cc"]):
        client.put(f"/api/videos/{video['id']}/chunks/{seq}", content=part)
    assert client.get(f"/api/videos/{video['id']}/raw").content == b"aabbcc"
    # A gap ends the playable part: Recover uses everything before it.
    client.put(f"/api/videos/{video['id']}/chunks/4", content=b"ee")
    assert client.get(f"/api/videos/{video['id']}/raw").content == b"aabbcc"
    assert client.get(f"/api/videos/{video['id']}/chunks").json()["contiguous"] == 3


def test_media_supports_range_requests(client: TestClient) -> None:
    video = make_ready_video(client)
    res = client.get(f"/api/videos/{video['id']}/media", headers={"Range": "bytes=0-3"})
    assert res.status_code == 206
    assert res.content == HEADER[:4]
    assert res.headers["content-range"].startswith("bytes 0-3/")
    assert res.headers["accept-ranges"] == "bytes"


def test_media_refuses_unfinished_recording(client: TestClient) -> None:
    video = client.post("/api/videos", json={}).json()
    assert client.get(f"/api/videos/{video['id']}/media").status_code == 409


def test_library_search_archive_and_delete(client: TestClient, tmp_path: Path) -> None:
    a = client.post("/api/videos", json={"title": "Quarterly plan 100%"}).json()
    b = client.post("/api/videos", json={"title": "Onboarding tour"}).json()
    assert [v["id"] for v in client.get("/api/videos").json()] == [b["id"], a["id"]]
    assert [v["id"] for v in client.get("/api/videos", params={"q": "100%"}).json()] == [a["id"]]
    assert client.get("/api/videos", params={"q": "_"}).json() == []

    renamed = client.patch(f"/api/videos/{a['id']}", json={"title": "  Plan v2 "}).json()
    assert renamed["title"] == "Plan v2"
    assert client.patch(f"/api/videos/{a['id']}", json={"title": "  "}).status_code == 422

    client.patch(f"/api/videos/{a['id']}", json={"archived": True})
    assert [v["id"] for v in client.get("/api/videos").json()] == [b["id"]]
    assert [v["id"] for v in client.get("/api/videos", params={"archived": 1}).json()] == [a["id"]]

    client.put(f"/api/videos/{a['id']}/chunks/0", content=b"x")
    assert client.delete(f"/api/videos/{a['id']}").status_code == 204
    assert client.get(f"/api/videos/{a['id']}").status_code == 404
    assert not (tmp_path / "videos" / a["id"]).exists()


def test_comments_threads_and_delete_rules(client: TestClient) -> None:
    client.post("/api/owner/devices", json={"viewerId": OWNER})
    video = make_ready_video(client)
    url = f"/api/videos/{video['id']}/comments"
    top = client.post(url, json={"authorId": VIEWER, "authorName": "Sam", "body": "Nice", "timestampMs": 1500}).json()
    assert top["timestampMs"] == 1500 and top["isOwner"] is False
    reply = client.post(url, json={"authorId": OWNER, "authorName": "Me", "body": "Thanks", "parentId": top["id"]}).json()
    assert reply["parentId"] == top["id"] and reply["isOwner"] is True
    nested = client.post(url, json={"authorId": VIEWER, "authorName": "Sam", "body": "x", "parentId": reply["id"]}).json()
    assert nested["parentId"] == top["id"]

    assert client.delete(f"/api/comments/{reply['id']}", params={"authorId": VIEWER}).status_code == 403
    assert client.delete(f"/api/comments/{top['id']}", params={"authorId": OWNER}).status_code == 204
    listed = client.get(url).json()
    assert listed[0]["deleted"] is True and listed[0]["body"] == ""
    assert client.get(f"/api/videos/{video['id']}").json()["commentCount"] == 2

    client.patch(f"/api/videos/{video['id']}", json={"commentsEnabled": False})
    off = client.post(url, json={"authorId": VIEWER, "authorName": "Sam", "body": "late"})
    assert off.status_code == 403


def test_reactions(client: TestClient) -> None:
    video = make_ready_video(client)
    url = f"/api/videos/{video['id']}/reactions"
    ok = client.post(url, json={"authorId": VIEWER, "authorName": "Sam", "emoji": "🎉", "timestampMs": 900})
    assert ok.status_code == 201
    bad = client.post(url, json={"authorId": VIEWER, "authorName": "Sam", "emoji": "x", "timestampMs": 900})
    assert bad.status_code == 422
    assert [r["emoji"] for r in client.get(url).json()] == ["🎉"]


def test_view_counting_rule(client: TestClient) -> None:
    client.post("/api/owner/devices", json={"viewerId": OWNER})
    video = make_ready_video(client)  # 4000 ms long
    url = f"/api/videos/{video['id']}/views"
    beat = {"viewerId": VIEWER, "viewerName": "Sam", "deltaMs": 1000, "positionMs": 1000}
    assert client.post(url, json=beat).json()["counted"] is False
    # 75 % of 4000 ms is 3000 ms.
    assert client.post(url, json={**beat, "deltaMs": 2000}).json()["counted"] is True
    # A refresh and more watching never adds a second view.
    client.post(url, json={**beat, "deltaMs": 5000})
    owner = client.post(url, json={**beat, "viewerId": OWNER, "deltaMs": 9000}).json()
    assert owner == {"counted": False, "owner": True}
    listed = client.get(url).json()
    assert listed["count"] == 1 and listed["viewers"][0]["viewerName"] == "Sam"
    assert client.get(f"/api/videos/{video['id']}").json()["viewCount"] == 1


def test_ended_counts_a_view(client: TestClient) -> None:
    video = make_ready_video(client)
    url = f"/api/videos/{video['id']}/views"
    res = client.post(url, json={"viewerId": VIEWER, "deltaMs": 100, "positionMs": 4000, "ended": True})
    assert res.json()["counted"] is True


def test_startup_sweep_removes_orphans(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ASYNC_VIDEO_DATA_DIR", str(tmp_path))
    (tmp_path / "videos" / "ghost").mkdir(parents=True)
    from app.main import create_app

    with TestClient(create_app()):
        pass
    assert not (tmp_path / "videos" / "ghost").exists()
