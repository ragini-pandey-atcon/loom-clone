"""SQLite access. One short-lived connection per call site; WAL so readers never block the writer."""

from __future__ import annotations

import os
import secrets
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

SCHEMA_PATH = Path(__file__).with_name("schema.sql")
REPO_ROOT = Path(__file__).resolve().parents[2]


def data_dir() -> Path:
    """`loom-clone/data`, or ASYNC_VIDEO_DATA_DIR (tests point it at a temp folder)."""
    return Path(os.environ.get("ASYNC_VIDEO_DATA_DIR") or REPO_ROOT / "data")


def db_path() -> Path:
    return data_dir() / "app.db"


def videos_dir() -> Path:
    return data_dir() / "videos"


def now_iso() -> str:
    """UTC, millisecond precision, fixed width, so it sorts correctly as text."""
    moment = datetime.now(UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


_ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"


def new_video_id() -> str:
    """Short and unambiguous (no 0/o, 1/l), because people read these links aloud."""
    return "".join(secrets.choice(_ID_ALPHABET) for _ in range(10))


def new_id() -> str:
    return secrets.token_hex(12)


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(db_path(), timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("pragma foreign_keys = on")
    conn.execute("pragma busy_timeout = 10000")
    return conn


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """Autocommit connection. Use `with conn:` inside for a transaction."""
    conn = _connect()
    try:
        yield conn
    finally:
        conn.close()


def init_db() -> None:
    data_dir().mkdir(parents=True, exist_ok=True)
    videos_dir().mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.execute("pragma journal_mode = wal")
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        migrate(conn)


# Columns added after the first release. `create table if not exists` leaves an existing table
# alone, so a database made before them gets each one added here, in place.
_ADDED_COLUMNS: dict[str, dict[str, str]] = {
    "videos": {
        "folder_id": "folder_id text references folders (id) on delete set null",
        "trim_start_ms": "trim_start_ms integer check (trim_start_ms is null or trim_start_ms >= 0)",
        "trim_end_ms": "trim_end_ms integer check (trim_end_ms is null or trim_end_ms > 0)",
        "uploaded": "uploaded integer not null default 0 check (uploaded in (0, 1))",
        "show_view_count": "show_view_count integer not null default 0 check (show_view_count in (0, 1))",
        "downloads_enabled": "downloads_enabled integer not null default 0 check (downloads_enabled in (0, 1))",
        "recommended_speed": (
            "recommended_speed real check (recommended_speed is null or recommended_speed between 0.5 and 2)"
        ),
    },
    "comments": {
        "reply_video_id": "reply_video_id text references videos (id) on delete set null",
    },
}


def migrate(conn: sqlite3.Connection) -> None:
    for table, columns in _ADDED_COLUMNS.items():
        have = {row["name"] for row in conn.execute(f"pragma table_info({table})")}
        for name, definition in columns.items():
            if name not in have:
                conn.execute(f"alter table {table} add column {definition}")
    # Here, not in schema.sql: on an old database the column does not exist until the line above.
    conn.execute("create index if not exists videos_folder_idx on videos (folder_id, created_at)")


def is_owner_device(conn: sqlite3.Connection, viewer_id: str | None) -> bool:
    if not viewer_id:
        return False
    row = conn.execute("select 1 from owner_devices where viewer_id = ?", (viewer_id,)).fetchone()
    return row is not None
