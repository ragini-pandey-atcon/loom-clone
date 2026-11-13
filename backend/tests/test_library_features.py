"""Folders, move, trim, upload, download, duplicate, watch later, and migrating an old database."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import unquote

import pytest
from fastapi.testclient import TestClient

HEADER = b"\x1a\x45\xdf\xa3" + b"NEWHEADER"
VIEWER = "viewer-0000000001"
MP4 = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 64


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("ASYNC_VIDEO_DATA_DIR", str(tmp_path))
    from app.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client


def ready_video(client: TestClient, title: str = "Demo", duration_ms: int = 10_000) -> dict:
    video = client.post("/api/videos", json={"title": title, "sourceMode": "screen"}).json()
    client.put(f"/api/videos/{video['id']}/chunks/0", content=b"OLDHEADCLUSTERS")
    res = client.post(
        f"/api/videos/{video['id']}/finalize",
        params={"chunkCount": 1, "bodyOffset": 7, "durationMs": duration_ms},
        content=HEADER,
    )
    assert res.status_code == 200, res.text
    return res.json()


def ids(res) -> list[str]:
    return [v["id"] for v in res.json()]


def test_folders_move_filter_and_delete_keeps_videos(client: TestClient) -> None:
    a = ready_video(client, "A")
    b = ready_video(client, "B")
    folder = client.post("/api/folders", json={"name": "  Onboarding  "}).json()
    assert folder["name"] == "Onboarding"
    assert folder["videoCount"] == 0

    moved = client.patch(f"/api/videos/{a['id']}", json={"folderId": folder["id"]}).json()
    assert moved["folderId"] == folder["id"]
    assert ids(client.get("/api/videos", params={"folder": folder["id"]})) == [a["id"]]
    assert ids(client.get("/api/videos", params={"folder": "none"})) == [b["id"]]
    assert set(ids(client.get("/api/videos"))) == {a["id"], b["id"]}
    assert client.get(f"/api/folders/{folder['id']}").json()["videoCount"] == 1

    renamed = client.patch(f"/api/folders/{folder['id']}", json={"name": "Sales"}).json()
    assert renamed["name"] == "Sales"
    assert client.patch(f"/api/folders/{folder['id']}", json={"name": "   "}).status_code == 422
    assert client.patch(f"/api/videos/{b['id']}", json={"folderId": "nope"}).status_code == 404

    # Back to the library: an explicit null, which is different from leaving the field out.
    client.patch(f"/api/videos/{a['id']}", json={"title": "A2"})
    assert client.get(f"/api/videos/{a['id']}").json()["folderId"] == folder["id"]
    client.patch(f"/api/videos/{a['id']}", json={"folderId": None})
    assert client.get(f"/api/videos/{a['id']}").json()["folderId"] is None

    client.patch(f"/api/videos/{a['id']}", json={"folderId": folder["id"]})
    assert client.delete(f"/api/folders/{folder['id']}").status_code == 204
    assert client.get("/api/folders").json() == []
    assert client.get(f"/api/videos/{a['id']}").json()["folderId"] is None


def test_trim_validates_reverts_and_ignores_full_length(client: TestClient) -> None:
    video = ready_video(client, duration_ms=10_000)
    trimmed = client.patch(f"/api/videos/{video['id']}", json={"trimStartMs": 1500, "trimEndMs": 8000}).json()
    assert (trimmed["trimStartMs"], trimmed["trimEndMs"]) == (1500, 8000)

    assert client.patch(f"/api/videos/{video['id']}", json={"trimStartMs": 0, "trimEndMs": 12_000}).status_code == 422
    assert client.patch(f"/api/videos/{video['id']}", json={"trimStartMs": 4000, "trimEndMs": 4200}).status_code == 422

    full = client.patch(f"/api/videos/{video['id']}", json={"trimStartMs": 0, "trimEndMs": 10_000}).json()
    assert (full["trimStartMs"], full["trimEndMs"]) == (None, None)

    client.patch(f"/api/videos/{video['id']}", json={"trimStartMs": 2000})
    assert client.get(f"/api/videos/{video['id']}").json()["trimEndMs"] == 10_000
    reverted = client.patch(f"/api/videos/{video['id']}", json={"trimStartMs": None, "trimEndMs": None}).json()
    assert (reverted["trimStartMs"], reverted["trimEndMs"]) == (None, None)

    unfinished = client.post("/api/videos", json={}).json()
    assert client.patch(f"/api/videos/{unfinished['id']}", json={"trimStartMs": 0, "trimEndMs": 900}).status_code == 409


def test_upload_mp4_and_webm(client: TestClient, tmp_path: Path) -> None:
    folder = client.post("/api/folders", json={"name": "Imports"}).json()
    res = client.post(
        "/api/videos/upload",
        params={"title": "Demo.mp4", "mimeType": "video/mp4", "durationMs": 3000, "width": 640, "height": 360,
                "folderId": folder["id"]},
        content=MP4,
    )
    assert res.status_code == 201, res.text
    video = res.json()
    assert video | {"id": None, "createdAt": None, "updatedAt": None} == video | {
        "id": None, "createdAt": None, "updatedAt": None,
        "status": "ready", "uploaded": True, "mimeType": "video/mp4", "durationMs": 3000, "seekable": True,
        "sizeBytes": len(MP4), "folderId": folder["id"],
    }
    media = client.get(f"/api/videos/{video['id']}/media")
    assert media.headers["content-type"] == "video/mp4"
    assert media.content == MP4

    webm = client.post("/api/videos/upload", params={"title": "Clip", "mimeType": "video/webm"}, content=HEADER + b"x")
    assert webm.status_code == 201


def test_upload_rejects_wrong_files_and_leaves_nothing(client: TestClient, tmp_path: Path) -> None:
    assert client.post("/api/videos/upload", params={"title": "x", "mimeType": "video/avi"}, content=b"RIFF").status_code == 415
    bad = client.post("/api/videos/upload", params={"title": "x", "mimeType": "video/mp4"}, content=b"not a video at all")
    assert bad.status_code == 422
    empty = client.post("/api/videos/upload", params={"title": "x", "mimeType": "video/webm"}, content=b"")
    assert empty.status_code == 422
    assert client.get("/api/videos").json() == []
    assert list((tmp_path / "videos").iterdir()) == []


def test_download_names_the_file(client: TestClient) -> None:
    video = ready_video(client, 'Q3: plan / "draft"?')
    res = client.get(f"/api/videos/{video['id']}/media", params={"download": 1})
    assert res.status_code == 200
    assert res.headers["content-disposition"].startswith("attachment")
    # RFC 5987 form, percent-encoded: browsers decode it back to the plain name.
    assert unquote(res.headers["content-disposition"]).endswith("''Q3_ plan _ _draft__.webm")
    assert "content-disposition" not in client.get(f"/api/videos/{video['id']}/media").headers


def test_duplicate_copies_file_not_activity(client: TestClient, tmp_path: Path) -> None:
    video = ready_video(client)
    client.patch(f"/api/videos/{video['id']}", json={"trimStartMs": 1000, "trimEndMs": 5000})
    client.post(
        f"/api/videos/{video['id']}/comments",
        json={"authorId": VIEWER, "authorName": "Viewer", "body": "Nice", "timestampMs": 100},
    )
    copy = client.post(f"/api/videos/{video['id']}/duplicate").json()
    assert copy["id"] != video["id"]
    assert copy["title"] == "Demo (copy)"
    assert (copy["trimStartMs"], copy["trimEndMs"]) == (1000, 5000)
    assert copy["commentCount"] == 0
    original = (tmp_path / "videos" / video["id"] / "video.webm").read_bytes()
    assert (tmp_path / "videos" / copy["id"] / "video.webm").read_bytes() == original

    unfinished = client.post("/api/videos", json={}).json()
    assert client.post(f"/api/videos/{unfinished['id']}/duplicate").status_code == 409


def test_watch_later_per_viewer(client: TestClient) -> None:
    a = ready_video(client, "A")
    b = ready_video(client, "B")
    assert client.put(f"/api/watch-later/{a['id']}", json={"viewerId": VIEWER}).status_code == 204
    client.put(f"/api/watch-later/{a['id']}", json={"viewerId": VIEWER})  # twice is fine
    client.put(f"/api/watch-later/{b['id']}", json={"viewerId": "someone-else-0001"})
    assert ids(client.get("/api/watch-later", params={"viewerId": VIEWER})) == [a["id"]]
    assert client.get(f"/api/videos/{a['id']}", params={"viewerId": VIEWER}).json()["watchLater"] is True
    assert client.get(f"/api/videos/{b['id']}", params={"viewerId": VIEWER}).json()["watchLater"] is False
    assert "watchLater" not in client.get(f"/api/videos/{a['id']}").json()
    client.delete(f"/api/watch-later/{a['id']}", params={"viewerId": VIEWER})
    assert client.get("/api/watch-later", params={"viewerId": VIEWER}).json() == []
    # Deleting a video removes it from every list.
    client.put(f"/api/watch-later/{a['id']}", json={"viewerId": VIEWER})
    client.delete(f"/api/videos/{a['id']}")
    assert client.get("/api/watch-later", params={"viewerId": VIEWER}).json() == []


OLD_VIDEOS_TABLE = """
create table videos (
  id text primary key, title text not null, status text not null default 'recording',
  source_mode text not null default 'screen_camera', mime_type text not null default 'video/webm',
  duration_ms integer, width integer, height integer, size_bytes integer not null default 0,
  chunk_count integer not null default 0, seekable integer not null default 0,
  has_thumbnail integer not null default 0, comments_enabled integer not null default 1,
  reactions_enabled integer not null default 1, archived_at text,
  created_at text not null, updated_at text not null
);
insert into videos (id, title, status, created_at, updated_at)
  values ('oldvideo22', 'Made before folders', 'ready', '2026-10-10T10:00:00.000Z', '2026-10-10T10:00:00.000Z');
"""


def test_migrates_a_database_from_before_folders(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ASYNC_VIDEO_DATA_DIR", str(tmp_path))
    (tmp_path / "videos").mkdir()
    (tmp_path / "videos" / "oldvideo22").mkdir()
    with sqlite3.connect(tmp_path / "app.db") as conn:
        conn.executescript(OLD_VIDEOS_TABLE)
    from app.main import create_app

    with TestClient(create_app()) as c:
        old = c.get("/api/videos/oldvideo22").json()
        assert old["title"] == "Made before folders"
        assert (old["folderId"], old["trimStartMs"], old["uploaded"]) == (None, None, False)
        folder = c.post("/api/folders", json={"name": "F"}).json()
        assert c.patch("/api/videos/oldvideo22", json={"folderId": folder["id"]}).json()["folderId"] == folder["id"]
    # Starting again on the migrated database changes nothing.
    with TestClient(create_app()) as c:
        assert c.get("/api/videos/oldvideo22").json()["folderId"] == folder["id"]
