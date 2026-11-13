"""Video files on disk: data/videos/<id>/{chunks/NNNNNN.part, video.webm, thumb.jpg}.

Every write goes to a temp file first and is moved into place with os.replace, so a retried
or interrupted request never leaves half a file under the real name.
"""

from __future__ import annotations

import os
import shutil
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

from .db import videos_dir

EBML_MAGIC = b"\x1a\x45\xdf\xa3"
_COPY_BLOCK = 1024 * 1024


def video_folder(video_id: str) -> Path:
    return videos_dir() / video_id


def chunks_folder(video_id: str) -> Path:
    return video_folder(video_id) / "chunks"


def media_path(video_id: str) -> Path:
    return video_folder(video_id) / "video.webm"


def thumb_path(video_id: str) -> Path:
    return video_folder(video_id) / "thumb.jpg"


def _write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def write_chunk(video_id: str, seq: int, data: bytes) -> None:
    _write_atomic(chunks_folder(video_id) / f"{seq:06d}.part", data)


def write_thumbnail(video_id: str, data: bytes) -> None:
    _write_atomic(thumb_path(video_id), data)


def received_chunks(video_id: str) -> dict[int, int]:
    """seq -> size in bytes, for every chunk that fully arrived."""
    folder = chunks_folder(video_id)
    if not folder.is_dir():
        return {}
    found: dict[int, int] = {}
    for entry in folder.iterdir():
        if entry.suffix == ".part" and entry.stem.isdigit():
            found[int(entry.stem)] = entry.stat().st_size
    return found


def missing_chunks(video_id: str, chunk_count: int) -> list[int]:
    have = received_chunks(video_id)
    return [seq for seq in range(chunk_count) if seq not in have]


def contiguous_count(video_id: str) -> int:
    """How many chunks arrived without a gap from 0. A crash can lose a chunk in flight;
    everything after a gap cannot be played anyway, because WebM clusters are sequential."""
    have = received_chunks(video_id)
    count = 0
    while count in have:
        count += 1
    return count


def _chunk_paths(video_id: str, chunk_count: int) -> list[Path]:
    return [chunks_folder(video_id) / f"{seq:06d}.part" for seq in range(chunk_count)]


def iter_raw(video_id: str) -> Iterator[bytes]:
    """The recording exactly as MediaRecorder produced it, for the browser-side Recover."""
    for path in _chunk_paths(video_id, contiguous_count(video_id)):
        with path.open("rb") as handle:
            while block := handle.read(_COPY_BLOCK):
                yield block


def assemble(video_id: str, chunk_count: int, header: bytes, body_offset: int) -> int:
    """Writes video.webm = header + raw[body_offset:], or the raw recording when there is no header.

    The header is the repaired WebM metadata the browser built (EBML header, Segment, SeekHead,
    Info with Duration, Tracks, Cues). body_offset is where the first Cluster starts in the raw
    recording, so everything before it is replaced. Returns the final size in bytes.
    """
    target = media_path(video_id)
    tmp = target.with_name(target.name + ".tmp")
    skip = body_offset if header else 0
    with tmp.open("wb") as out:
        out.write(header)
        for path in _chunk_paths(video_id, chunk_count):
            with path.open("rb") as handle:
                size = path.stat().st_size
                if skip >= size:
                    skip -= size
                    continue
                if skip:
                    handle.seek(skip)
                    skip = 0
                shutil.copyfileobj(handle, out, _COPY_BLOCK)
    if skip:
        tmp.unlink(missing_ok=True)
        raise ValueError("bodyOffset is past the end of the recording")
    os.replace(tmp, target)
    shutil.rmtree(chunks_folder(video_id), ignore_errors=True)
    return target.stat().st_size


def audio_path(video_id: str) -> Path:
    """16 kHz mono 16-bit PCM from the browser, kept only until it is transcribed."""
    return video_folder(video_id) / "audio.pcm"


async def write_stream(video_id: str, chunks: AsyncIterator[bytes], limit: int, path: Path | None = None) -> int:
    """Writes an uploaded body to `path` (the media file by default). Raises ValueError past
    `limit` bytes; the partial file is removed and nothing appears under the real name."""
    path = path or media_path(video_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".upload")
    size = 0
    try:
        with tmp.open("wb") as out:
            async for chunk in chunks:
                size += len(chunk)
                if size > limit:
                    raise ValueError("File too large")
                out.write(chunk)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    return size


def read_head(video_id: str, n: int = 16) -> bytes:
    with media_path(video_id).open("rb") as f:
        return f.read(n)


def copy_video_files(source_id: str, target_id: str) -> None:
    """Duplicate: the media and thumbnail, never the chunks of an unfinished take."""
    target = video_folder(target_id)
    target.mkdir(parents=True, exist_ok=True)
    for src in (media_path(source_id), thumb_path(source_id)):
        if src.is_file():
            tmp = target / (src.name + ".tmp")
            shutil.copyfile(src, tmp)
            os.replace(tmp, target / src.name)


def raw_size(video_id: str) -> int:
    have = received_chunks(video_id)
    return sum(have[seq] for seq in range(contiguous_count(video_id)))


def remove_video_files(video_id: str) -> bool:
    """True when the folder is gone. Windows refuses to delete a file that is still being
    streamed to a player; the startup sweep removes what is left."""
    shutil.rmtree(video_folder(video_id), ignore_errors=True)
    return not video_folder(video_id).exists()


def sweep_orphans(known_ids: set[str]) -> int:
    root = videos_dir()
    if not root.is_dir():
        return 0
    removed = 0
    for entry in root.iterdir():
        if entry.is_dir() and entry.name not in known_ids:
            shutil.rmtree(entry, ignore_errors=True)
            removed += 1
    return removed
