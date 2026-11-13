"""Per-video settings, tags, follow, notifications with @mentions, and video replies."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

HEADER = b"\x1a\x45\xdf\xa3" + b"NEWHEADER"
OWNER = "owner-00000000001"
ANA = "viewer-ana-000001"
BEN = "viewer-ben-000001"
CHLOE = "viewer-chloe-0001"


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("ASYNC_VIDEO_DATA_DIR", str(tmp_path))
    from app.main import create_app

    with TestClient(create_app()) as test_client:
        test_client.post("/api/owner/devices", json={"viewerId": OWNER})
        yield test_client


def ready_video(client: TestClient, title: str = "Demo") -> dict:
    video = client.post("/api/videos", json={"title": title, "sourceMode": "screen"}).json()
    client.put(f"/api/videos/{video['id']}/chunks/0", content=b"OLDHEADCLUSTERS")
    client.post(f"/api/videos/{video['id']}/finalize", params={"chunkCount": 1, "bodyOffset": 7, "durationMs": 9000}, content=HEADER)
    return client.get(f"/api/videos/{video['id']}").json()


def comment(client: TestClient, video_id: str, who: str, name: str, body: str, **extra) -> dict:
    res = client.post(
        f"/api/videos/{video_id}/comments",
        json={"authorId": who, "authorName": name, "body": body, "timestampMs": 1000, **extra},
    )
    assert res.status_code == 201, res.text
    return res.json()


def inbox(client: TestClient, viewer: str) -> list[tuple[str, str]]:
    return [(n["kind"], n["actorName"]) for n in client.get("/api/notifications", params={"viewerId": viewer}).json()]


def test_settings_defaults_validate_and_clear(client: TestClient) -> None:
    video = ready_video(client)
    assert (video["showViewCount"], video["downloadsEnabled"], video["recommendedSpeed"]) == (False, False, None)
    changed = client.patch(
        f"/api/videos/{video['id']}", json={"showViewCount": True, "downloadsEnabled": True, "recommendedSpeed": 1.5}
    ).json()
    assert (changed["showViewCount"], changed["downloadsEnabled"], changed["recommendedSpeed"]) == (True, True, 1.5)
    assert client.patch(f"/api/videos/{video['id']}", json={"recommendedSpeed": 3}).status_code == 422
    assert client.patch(f"/api/videos/{video['id']}", json={"recommendedSpeed": 1}).json()["recommendedSpeed"] is None
    client.patch(f"/api/videos/{video['id']}", json={"recommendedSpeed": 2})
    assert client.patch(f"/api/videos/{video['id']}", json={"recommendedSpeed": None}).json()["recommendedSpeed"] is None


def test_download_needs_owner_or_permission(client: TestClient) -> None:
    video = ready_video(client)
    url = f"/api/videos/{video['id']}/media"
    assert client.get(url, params={"download": 1, "viewerId": ANA}).status_code == 403
    assert client.get(url, params={"download": 1}).status_code == 403
    assert client.get(url, params={"download": 1, "viewerId": OWNER}).status_code == 200
    assert client.get(url).status_code == 200  # watching is never blocked
    client.patch(f"/api/videos/{video['id']}", json={"downloadsEnabled": True})
    assert client.get(url, params={"download": 1, "viewerId": ANA}).status_code == 200


def test_tags_clean_dedupe_filter_and_search(client: TestClient) -> None:
    a = ready_video(client, "Roadmap")
    b = ready_video(client, "Standup")
    tagged = client.put(f"/api/videos/{a['id']}/tags", json={"tags": [" #Onboarding ", "onboarding", "Q4  plans", "", "#"]}).json()
    assert tagged["tags"] == ["Onboarding", "Q4 plans"]
    client.put(f"/api/videos/{b['id']}/tags", json={"tags": ["ONBOARDING"]})
    # Tags group case-insensitively; the label is one of the spellings in use.
    listed = [(t["tag"].lower(), t["videoCount"]) for t in client.get("/api/tags").json()]
    assert listed == [("onboarding", 2), ("q4 plans", 1)]
    assert [v["id"] for v in client.get("/api/videos", params={"tag": "q4 plans"}).json()] == [a["id"]]
    assert {v["id"] for v in client.get("/api/videos", params={"q": "onboard"}).json()} == {a["id"], b["id"]}
    assert client.put(f"/api/videos/{a['id']}/tags", json={"tags": [str(i) for i in range(11)]}).status_code == 422
    assert client.put(f"/api/videos/{a['id']}/tags", json={"tags": []}).json()["tags"] == []


def test_owner_gets_comments_and_replies_but_not_their_own(client: TestClient) -> None:
    video = ready_video(client)
    top = comment(client, video["id"], ANA, "Ana", "Looks good")
    assert inbox(client, OWNER) == [("comment", "Ana")]
    assert inbox(client, ANA) == []
    # The owner replies: Ana hears about it, the owner does not hear about themselves.
    comment(client, video["id"], OWNER, "Ragini", "Thanks!", parentId=top["id"])
    assert inbox(client, ANA) == [("reply", "Ragini")]
    assert inbox(client, OWNER) == [("comment", "Ana")]


def test_followers_mentions_and_one_row_per_person(client: TestClient) -> None:
    video = ready_video(client)
    comment(client, video["id"], ANA, "Ana Lopez", "First")  # commenting follows the video
    client.put(f"/api/videos/{video['id']}/follow", json={"viewerId": CHLOE})
    client.post(
        f"/api/videos/{video['id']}/views",
        json={"viewerId": BEN, "viewerName": "Ben", "deltaMs": 1000, "positionMs": 1000},
    )
    assert client.get(f"/api/videos/{video['id']}/people").json() == ["Ana Lopez", "Ben"]

    comment(client, video["id"], CHLOE, "Chloe", "@ana lopez and @Ben, have a look. @Benjamin is not Ben.")
    assert inbox(client, ANA)[0] == ("mention", "Chloe")  # mention wins over "a follower's comment"
    assert len(inbox(client, ANA)) == 1
    assert inbox(client, BEN) == [("mention", "Chloe")]
    assert inbox(client, CHLOE) == []  # never your own comment
    assert inbox(client, OWNER)[0] == ("comment", "Chloe")

    assert client.get(f"/api/videos/{video['id']}", params={"viewerId": CHLOE}).json()["following"] is True
    client.delete(f"/api/videos/{video['id']}/follow", params={"viewerId": CHLOE})
    comment(client, video["id"], BEN, "Ben", "Another")
    assert len(inbox(client, CHLOE)) == 0


def test_unread_count_and_mark_read(client: TestClient) -> None:
    video = ready_video(client)
    comment(client, video["id"], ANA, "Ana", "One")
    comment(client, video["id"], BEN, "Ben", "Two")
    assert client.get("/api/notifications/unread", params={"viewerId": OWNER}).json() == {"count": 2}
    client.post("/api/notifications/read", json={"viewerId": OWNER})
    assert client.get("/api/notifications/unread", params={"viewerId": OWNER}).json() == {"count": 0}
    rows = client.get("/api/notifications", params={"viewerId": OWNER}).json()
    assert all(n["read"] for n in rows)
    assert rows[0]["videoTitle"] == "Demo"
    assert rows[0]["timestampMs"] == 1000


def test_video_reply_links_and_notifies(client: TestClient) -> None:
    video = ready_video(client, "Question")
    answer = ready_video(client, "My answer")
    c = comment(client, video["id"], ANA, "Ana", "Recorded a video reply", replyVideoId=answer["id"])
    assert c["replyVideoId"] == answer["id"]
    assert inbox(client, OWNER) == [("video_reply", "Ana")]
    assert client.post(
        f"/api/videos/{video['id']}/comments",
        json={"authorId": ANA, "authorName": "Ana", "body": "x", "replyVideoId": video["id"]},
    ).status_code == 422
    # Deleting the reply video keeps the comment, without the link.
    client.delete(f"/api/videos/{answer['id']}")
    assert client.get(f"/api/videos/{video['id']}/comments").json()[0]["replyVideoId"] is None
