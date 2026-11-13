"""Transcripts made on this computer.

The browser decodes a video's audio (no ffmpeg here) and sends it as 16 kHz mono 16-bit PCM.
A single background thread turns it into timed segments with whisper.cpp (pywhispercpp), one
video at a time, and stores them. The audio file is deleted once it has been transcribed.

Model: ASYNC_VIDEO_STT_MODEL, default "base" (multilingual, about 150 MB, downloaded once into
data/models). "small" is more accurate and about three times slower.
"""

from __future__ import annotations

import logging
import os
import queue
import re
import sqlite3
import threading
from collections.abc import Callable
from pathlib import Path

import numpy as np

from . import storage
from .db import connect, models_dir, now_iso

log = logging.getLogger("async_video.transcribe")

SAMPLE_RATE = 16_000
# Up to three hours of audio.
MAX_AUDIO_BYTES = 3 * 60 * 60 * SAMPLE_RATE * 2
DEFAULT_MODEL = "base"

Segment = tuple[int, int, str]
# Takes float32 samples in [-1, 1] at 16 kHz; returns segments (start ms, end ms, text) and the
# language if known.
Transcriber = Callable[[np.ndarray], tuple[list[Segment], str | None]]

# whisper.cpp writes these for silence, music and noise. They are not speech.
_NOT_SPEECH = re.compile(r"^\s*[\[(][^\])]*[\])]\s*$")


def model_name() -> str:
    return os.environ.get("ASYNC_VIDEO_STT_MODEL") or DEFAULT_MODEL


def whisper_transcriber(name: str | None = None) -> Transcriber:
    """The real engine. The model loads on first use, so the API starts instantly and a model
    download only happens when someone actually asks for a transcript."""
    lock = threading.Lock()
    loaded: dict[str, object] = {}

    def run(samples: np.ndarray) -> tuple[list[Segment], str | None]:
        from pywhispercpp.model import Model  # heavy import, only when needed

        with lock:
            if "model" not in loaded:
                models_dir().mkdir(parents=True, exist_ok=True)
                loaded["model"] = Model(
                    name or model_name(),
                    models_dir=str(models_dir()),
                    print_realtime=False,
                    print_progress=False,
                    print_timestamps=False,
                )
            model = loaded["model"]
            raw = model.transcribe(samples, language="auto")  # type: ignore[attr-defined]
        # whisper.cpp times are in 10 ms units.
        return [(int(s.t0) * 10, int(s.t1) * 10, s.text) for s in raw], None

    return run


def clean_segments(segments: list[Segment]) -> list[Segment]:
    out: list[Segment] = []
    for start, end, text in segments:
        text = " ".join(text.split())
        if not text or _NOT_SPEECH.match(text):
            continue
        start = max(0, int(start))
        out.append((start, max(start, int(end)), text))
    return out


def pcm_to_float(data: bytes) -> np.ndarray:
    usable = len(data) - (len(data) % 2)
    return np.frombuffer(data[:usable], dtype="<i2").astype(np.float32) / 32768.0


class TranscriptQueue:
    """One job at a time: transcription uses every core, and two at once would only be slower."""

    def __init__(self, transcriber: Transcriber, inline: bool = False) -> None:
        self.transcriber = transcriber
        self.inline = inline
        self.jobs: queue.Queue[str | None] = queue.Queue()
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        if self.inline or self.thread:
            return
        self.thread = threading.Thread(target=self._loop, name="transcripts", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        if self.thread:
            self.jobs.put(None)
            self.thread.join(timeout=5)
            self.thread = None

    def submit(self, video_id: str) -> None:
        if self.inline:
            self.run_one(video_id)
        else:
            self.jobs.put(video_id)

    def resume(self) -> None:
        """After a restart: queue what was waiting, fail what lost its audio."""
        with connect() as conn:
            rows = conn.execute("select video_id from transcripts where status in ('pending', 'running')").fetchall()
        for row in rows:
            video_id = row["video_id"]
            if storage.audio_path(video_id).is_file():
                self._set(video_id, "pending")
                self.submit(video_id)
            else:
                self._set(video_id, "failed", error="The audio was not kept. Create the transcript again.")

    def _loop(self) -> None:
        while True:
            video_id = self.jobs.get()
            if video_id is None:
                return
            try:
                self.run_one(video_id)
            except Exception:  # noqa: BLE001 - one bad job must not stop the worker
                log.exception("Transcript job for %s crashed", video_id)

    def _set(self, video_id: str, status: str, error: str | None = None, conn: sqlite3.Connection | None = None) -> None:
        def write(c: sqlite3.Connection) -> None:
            c.execute(
                "update transcripts set status = ?, error = ?, updated_at = ? where video_id = ?",
                (status, error, now_iso(), video_id),
            )

        if conn is not None:
            write(conn)
        else:
            with connect() as c:
                write(c)

    def run_one(self, video_id: str) -> None:
        path: Path = storage.audio_path(video_id)
        if not path.is_file():
            self._set(video_id, "failed", error="The audio was not kept. Create the transcript again.")
            return
        self._set(video_id, "running")
        try:
            samples = pcm_to_float(path.read_bytes())
            segments, language = self.transcriber(samples)
            segments = clean_segments(segments)
        except Exception as exc:  # noqa: BLE001 - shown to the owner, who can try again
            log.exception("Transcription failed for %s", video_id)
            self._set(video_id, "failed", error=f"Transcription failed: {exc}"[:300])
            path.unlink(missing_ok=True)
            return
        with connect() as conn:
            exists = conn.execute("select 1 from videos where id = ?", (video_id,)).fetchone()
            if exists:
                with conn:
                    conn.execute("delete from transcript_segments where video_id = ?", (video_id,))
                    conn.executemany(
                        "insert into transcript_segments (video_id, idx, start_ms, end_ms, text) values (?, ?, ?, ?, ?)",
                        [(video_id, i, s, e, t) for i, (s, e, t) in enumerate(segments)],
                    )
                    conn.execute(
                        "update transcripts set status = 'ready', language = ?, model = ?, error = null,"
                        " updated_at = ? where video_id = ?",
                        (language, model_name(), now_iso(), video_id),
                    )
        path.unlink(missing_ok=True)


def to_vtt(segments: list[sqlite3.Row]) -> str:
    def stamp(ms: int) -> str:
        h, rest = divmod(ms, 3_600_000)
        m, rest = divmod(rest, 60_000)
        s, milli = divmod(rest, 1000)
        return f"{h:02d}:{m:02d}:{s:02d}.{milli:03d}"

    lines = ["WEBVTT", ""]
    for i, seg in enumerate(segments, start=1):
        end = max(seg["end_ms"], seg["start_ms"] + 500)
        lines += [str(i), f"{stamp(seg['start_ms'])} --> {stamp(end)}", seg["text"].replace("-->", "->"), ""]
    return "\n".join(lines)
