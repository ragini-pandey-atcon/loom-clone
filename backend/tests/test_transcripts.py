"""Transcripts: audio in, segments out, captions, search, the off switch, restarts."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.transcribe import clean_segments, pcm_to_float, to_vtt

HEADER = b"\x1a\x45\xdf\xa3" + b"NEWHEADER"
OWNER = "owner-00000000001"
VIEWER = "viewer-0000000001"
# One second of a quiet tone as 16-bit PCM: the fake engine only checks that samples arrived.
PCM = (np.sin(np.arange(16_000) / 8) * 3000).astype("<i2").tobytes()

calls: list[int] = []


def fake_engine(samples: np.ndarray) -> tuple[list[tuple[int, int, str]], str | None]:
    calls.append(len(samples))
    assert samples.dtype == np.float32 and float(np.abs(samples).max()) <= 1.0
    return [
        (0, 1800, " Hello team, this is the export step. "),
        (1800, 2400, "[BLANK_AUDIO]"),
        (2400, 5200, "Open settings and press download."),
    ], "en"


def broken_engine(samples: np.ndarray) -> tuple[list[tuple[int, int, str]], str | None]:
    raise RuntimeError("model file is damaged")


def make_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, engine=fake_engine) -> TestClient:
    monkeypatch.setenv("ASYNC_VIDEO_DATA_DIR", str(tmp_path))
    from app.main import create_app

    return TestClient(create_app(transcriber=engine, inline_transcripts=True))


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    calls.clear()
    with make_client(tmp_path, monkeypatch) as c:
        c.post("/api/owner/devices", json={"viewerId": OWNER})
        yield c


def ready_video(client: TestClient, title: str = "Demo") -> dict:
    video = client.post("/api/videos", json={"title": title, "sourceMode": "screen"}).json()
    client.put(f"/api/videos/{video['id']}/chunks/0", content=b"OLDHEADCLUSTERS")
    client.post(f"/api/videos/{video['id']}/finalize", params={"chunkCount": 1, "bodyOffset": 7, "durationMs": 6000}, content=HEADER)
    return video


def test_audio_becomes_segments_and_the_audio_file_goes(client: TestClient, tmp_path: Path) -> None:
    video = ready_video(client)
    assert client.get(f"/api/videos/{video['id']}").json()["transcriptStatus"] == "none"
    res = client.put(f"/api/videos/{video['id']}/audio", content=PCM)
    assert res.status_code == 202
    body = client.get(f"/api/videos/{video['id']}/transcript").json()
    assert body["status"] == "ready"
    assert body["language"] == "en"
    # Whitespace tidied, the [BLANK_AUDIO] marker dropped.
    assert body["segments"] == [
        {"startMs": 0, "endMs": 1800, "text": "Hello team, this is the export step."},
        {"startMs": 2400, "endMs": 5200, "text": "Open settings and press download."},
    ]
    assert calls == [16_000]
    assert not (tmp_path / "videos" / video["id"] / "audio.pcm").exists()
    assert client.get(f"/api/videos/{video['id']}").json()["transcriptStatus"] == "ready"


def test_no_sound_means_an_empty_ready_transcript(client: TestClient) -> None:
    video = ready_video(client)
    client.put(f"/api/videos/{video['id']}/audio", content=b"")
    assert client.get(f"/api/videos/{video['id']}/transcript").json() == {
        "status": "ready", "language": None, "error": None, "segments": [],
    }
    assert calls == []


def test_captions_are_webvtt(client: TestClient) -> None:
    video = ready_video(client)
    client.put(f"/api/videos/{video['id']}/audio", content=PCM)
    res = client.get(f"/api/videos/{video['id']}/captions.vtt")
    assert res.headers["content-type"].startswith("text/vtt")
    assert res.text.startswith("WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.800\nHello team, this is the export step.\n")
    assert "00:00:02.400 --> 00:00:05.200" in res.text


def test_search_finds_what_was_said_and_where(client: TestClient) -> None:
    video = ready_video(client, "Weekly update")
    other = ready_video(client, "Unrelated")
    client.put(f"/api/videos/{video['id']}/audio", content=PCM)
    hits = client.get("/api/videos", params={"q": "press download"}).json()
    assert [v["id"] for v in hits] == [video["id"]]
    assert hits[0]["transcriptMatch"] == {"startMs": 2400, "text": "Open settings and press download."}
    # A title match has no transcript line to show.
    assert client.get("/api/videos", params={"q": "Unrelated"}).json()[0]["transcriptMatch"] is None
    assert other["id"]


def test_transcript_off_hides_it_from_viewers_and_search(client: TestClient) -> None:
    video = ready_video(client)
    client.put(f"/api/videos/{video['id']}/audio", content=PCM)
    client.patch(f"/api/videos/{video['id']}", json={"transcriptEnabled": False})
    assert client.get(f"/api/videos/{video['id']}/transcript", params={"viewerId": VIEWER}).status_code == 403
    assert client.get(f"/api/videos/{video['id']}/captions.vtt", params={"viewerId": VIEWER}).status_code == 403
    assert client.get(f"/api/videos/{video['id']}/transcript", params={"viewerId": OWNER}).status_code == 200
    assert client.get("/api/videos", params={"q": "press download"}).json() == []


def test_unfinished_videos_and_double_requests_are_refused(client: TestClient) -> None:
    unfinished = client.post("/api/videos", json={}).json()
    assert client.put(f"/api/videos/{unfinished['id']}/audio", content=PCM).status_code == 409
    video = ready_video(client)
    from app.db import connect, now_iso

    with connect() as conn:
        conn.execute(
            "insert into transcripts (video_id, status, created_at, updated_at) values (?, 'running', ?, ?)",
            (video["id"], now_iso(), now_iso()),
        )
    assert client.put(f"/api/videos/{video['id']}/audio", content=PCM).status_code == 409


def test_a_broken_engine_fails_the_transcript_not_the_api(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with make_client(tmp_path, monkeypatch, engine=broken_engine) as c:
        video = ready_video(c)
        assert c.put(f"/api/videos/{video['id']}/audio", content=PCM).status_code == 202
        body = c.get(f"/api/videos/{video['id']}/transcript").json()
        assert body["status"] == "failed"
        assert "model file is damaged" in body["error"]
        assert not (tmp_path / "videos" / video["id"] / "audio.pcm").exists()


def test_a_restart_resumes_waiting_work_and_fails_lost_audio(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with make_client(tmp_path, monkeypatch) as c:
        kept = ready_video(c, "Kept")
        lost = ready_video(c, "Lost")
    from app.db import connect, now_iso

    with connect() as conn:
        for vid in (kept["id"], lost["id"]):
            conn.execute(
                "insert into transcripts (video_id, status, created_at, updated_at) values (?, 'running', ?, ?)",
                (vid, now_iso(), now_iso()),
            )
    (tmp_path / "videos" / kept["id"] / "audio.pcm").write_bytes(PCM)
    with make_client(tmp_path, monkeypatch) as c:
        assert c.get(f"/api/videos/{kept['id']}/transcript").json()["status"] == "ready"
        lost_body = c.get(f"/api/videos/{lost['id']}/transcript").json()
        assert lost_body["status"] == "failed"
        assert "not kept" in lost_body["error"]


def test_duplicate_keeps_the_transcript(client: TestClient) -> None:
    video = ready_video(client)
    client.put(f"/api/videos/{video['id']}/audio", content=PCM)
    copy = client.post(f"/api/videos/{video['id']}/duplicate").json()
    assert copy["transcriptStatus"] == "ready"
    assert len(client.get(f"/api/videos/{copy['id']}/transcript").json()["segments"]) == 2


def test_helpers() -> None:
    assert clean_segments([(-5, -1, " (music) "), (10, 5, "  hi  there ")]) == [(10, 10, "hi there")]
    assert pcm_to_float(b"\x00\x80\xff\x7f\x01").tolist() == [-1.0, 32767 / 32768]
    vtt = to_vtt([{"start_ms": 3_723_004, "end_ms": 3_723_100, "text": "a --> b"}])
    assert "01:02:03.004 --> 01:02:03.504" in vtt  # at least half a second on screen
    assert "a -> b" in vtt
