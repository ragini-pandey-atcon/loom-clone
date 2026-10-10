"""ATCON Async Video API, local edition.

No authentication: the server binds to 127.0.0.1, there is one implicit owner, and viewers
identify themselves with a display name and a random id kept in their browser.
"""

from __future__ import annotations

import logging
import sqlite3
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from . import storage
from .db import connect, init_db, is_owner_device, new_id, new_video_id, now_iso

log = logging.getLogger("async_video")

MAX_CHUNK_BYTES = 64 * 1024 * 1024
MAX_HEADER_BYTES = 8 * 1024 * 1024
MAX_THUMB_BYTES = 5 * 1024 * 1024
EMOJIS = ("👍", "❤️", "😂", "😮", "🎉", "👏", "🔥", "🤔")

# A view counts once per viewer per video, after 5 s watched, 75 % of the length, or the end.
VIEW_MIN_MS = 5000
VIEW_MIN_FRACTION = 0.75
# A heartbeat can only add this much watch time, so a stuck tab cannot claim an hour at once.
MAX_HEARTBEAT_MS = 15000


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class OwnerDeviceIn(CamelModel):
    viewer_id: str = Field(min_length=8, max_length=64)


class VideoCreate(CamelModel):
    title: str | None = Field(default=None, max_length=200)
    source_mode: str = Field(default="screen_camera", pattern="^(screen_camera|screen|camera)$")
    mime_type: str = Field(default="video/webm", max_length=100)


class VideoPatch(CamelModel):
    title: str | None = Field(default=None, max_length=200)
    archived: bool | None = None
    comments_enabled: bool | None = None
    reactions_enabled: bool | None = None


class CommentIn(CamelModel):
    author_id: str = Field(min_length=8, max_length=64)
    author_name: str = Field(min_length=1, max_length=60)
    body: str = Field(min_length=1, max_length=4000)
    timestamp_ms: int | None = Field(default=None, ge=0)
    parent_id: str | None = None


class ReactionIn(CamelModel):
    author_id: str = Field(min_length=8, max_length=64)
    author_name: str = Field(min_length=1, max_length=60)
    emoji: str
    timestamp_ms: int = Field(ge=0)


class ViewIn(CamelModel):
    viewer_id: str = Field(min_length=8, max_length=64)
    viewer_name: str | None = Field(default=None, max_length=60)
    delta_ms: int = Field(ge=0)
    position_ms: int = Field(default=0, ge=0)
    ended: bool = False


VIDEO_COLUMNS = """
  v.*,
  (select count(*) from views w where w.video_id = v.id and w.counted = 1) as view_count,
  (select count(*) from comments c where c.video_id = v.id and c.deleted_at is null) as comment_count
"""


def video_json(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "status": row["status"],
        "sourceMode": row["source_mode"],
        "mimeType": row["mime_type"],
        "durationMs": row["duration_ms"],
        "width": row["width"],
        "height": row["height"],
        "sizeBytes": row["size_bytes"],
        "chunkCount": row["chunk_count"],
        "seekable": bool(row["seekable"]),
        "hasThumbnail": bool(row["has_thumbnail"]),
        "commentsEnabled": bool(row["comments_enabled"]),
        "reactionsEnabled": bool(row["reactions_enabled"]),
        "archivedAt": row["archived_at"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "viewCount": row["view_count"],
        "commentCount": row["comment_count"],
    }


def comment_json(row: sqlite3.Row) -> dict[str, Any]:
    deleted = row["deleted_at"] is not None
    return {
        "id": row["id"],
        "videoId": row["video_id"],
        "parentId": row["parent_id"],
        "authorId": row["author_id"],
        "authorName": row["author_name"],
        "isOwner": bool(row["is_owner"]),
        "body": "" if deleted else row["body"],
        "deleted": deleted,
        "timestampMs": row["timestamp_ms"],
        "createdAt": row["created_at"],
    }


def reaction_json(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "videoId": row["video_id"],
        "authorId": row["author_id"],
        "authorName": row["author_name"],
        "emoji": row["emoji"],
        "timestampMs": row["timestamp_ms"],
        "createdAt": row["created_at"],
    }


def load_video(conn: sqlite3.Connection, video_id: str) -> sqlite3.Row:
    row = conn.execute(f"select {VIDEO_COLUMNS} from videos v where v.id = ?", (video_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Video not found")
    return row


def _require_recording(row: sqlite3.Row) -> None:
    if row["status"] != "recording":
        raise HTTPException(409, "This recording is already finished")


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    with connect() as conn:
        known = {r["id"] for r in conn.execute("select id from videos")}
    removed = storage.sweep_orphans(known)
    if removed:
        log.info("Removed %d orphaned video folders", removed)
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="ATCON Async Video (local)", lifespan=lifespan)

    @app.get("/api/health")
    def health() -> dict[str, bool]:
        return {"ok": True}

    # Owner device -------------------------------------------------------------------------

    @app.post("/api/owner/devices", status_code=204)
    def add_owner_device(body: OwnerDeviceIn) -> Response:
        with connect() as conn:
            conn.execute(
                "insert or ignore into owner_devices (viewer_id, created_at) values (?, ?)",
                (body.viewer_id, now_iso()),
            )
        return Response(status_code=204)

    # Videos -------------------------------------------------------------------------------

    @app.get("/api/videos")
    def list_videos(
        q: Annotated[str | None, Query(max_length=200)] = None,
        archived: bool = False,
    ) -> list[dict[str, Any]]:
        sql = f"select {VIDEO_COLUMNS} from videos v where "
        sql += "v.archived_at is not null" if archived else "v.archived_at is null"
        params: list[Any] = []
        if q and q.strip():
            escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            sql += " and v.title like ? escape '\\'"
            params.append(f"%{escaped}%")
        sql += " order by v.created_at desc"
        with connect() as conn:
            return [video_json(r) for r in conn.execute(sql, params)]

    @app.post("/api/videos", status_code=201)
    def create_video(body: VideoCreate) -> dict[str, Any]:
        title = (body.title or "").strip() or "Untitled recording"
        stamp = now_iso()
        with connect() as conn:
            video_id = new_video_id()
            conn.execute(
                "insert into videos (id, title, source_mode, mime_type, created_at, updated_at)"
                " values (?, ?, ?, ?, ?, ?)",
                (video_id, title, body.source_mode, body.mime_type, stamp, stamp),
            )
            return video_json(load_video(conn, video_id))

    @app.get("/api/videos/{video_id}")
    def get_video(video_id: str) -> dict[str, Any]:
        with connect() as conn:
            return video_json(load_video(conn, video_id))

    @app.patch("/api/videos/{video_id}")
    def patch_video(video_id: str, body: VideoPatch) -> dict[str, Any]:
        sets: list[str] = []
        params: list[Any] = []
        if body.title is not None:
            title = body.title.strip()
            if not title:
                raise HTTPException(422, "Title can't be empty")
            sets.append("title = ?")
            params.append(title)
        if body.archived is not None:
            sets.append("archived_at = ?")
            params.append(now_iso() if body.archived else None)
        if body.comments_enabled is not None:
            sets.append("comments_enabled = ?")
            params.append(int(body.comments_enabled))
        if body.reactions_enabled is not None:
            sets.append("reactions_enabled = ?")
            params.append(int(body.reactions_enabled))
        with connect() as conn:
            load_video(conn, video_id)
            if sets:
                sets.append("updated_at = ?")
                params.extend([now_iso(), video_id])
                conn.execute(f"update videos set {', '.join(sets)} where id = ?", params)
            return video_json(load_video(conn, video_id))

    @app.delete("/api/videos/{video_id}", status_code=204)
    def delete_video(video_id: str) -> Response:
        with connect() as conn:
            load_video(conn, video_id)
            conn.execute("delete from videos where id = ?", (video_id,))
        # Row first, files second: a file still open in a player cannot be deleted on Windows,
        # and the startup sweep removes any folder that has no row.
        if not storage.remove_video_files(video_id):
            log.warning("Video %s files are in use; the next start removes them", video_id)
        return Response(status_code=204)

    # Recording upload ---------------------------------------------------------------------

    @app.put("/api/videos/{video_id}/chunks/{seq}")
    async def put_chunk(video_id: str, seq: int, request: Request) -> dict[str, int]:
        if seq < 0 or seq > 999_999:
            raise HTTPException(422, "Chunk number out of range")
        declared = int(request.headers.get("content-length") or 0)
        if declared > MAX_CHUNK_BYTES:
            raise HTTPException(413, "Chunk too large")
        with connect() as conn:
            _require_recording(load_video(conn, video_id))
        data = await request.body()
        if len(data) > MAX_CHUNK_BYTES:
            raise HTTPException(413, "Chunk too large")
        await run_in_threadpool(storage.write_chunk, video_id, seq, data)
        return {"seq": seq, "bytes": len(data)}

    @app.get("/api/videos/{video_id}/chunks")
    def get_chunks(video_id: str) -> dict[str, Any]:
        with connect() as conn:
            load_video(conn, video_id)
        have = storage.received_chunks(video_id)
        return {
            "received": sorted(have),
            "bytes": sum(have.values()),
            "contiguous": storage.contiguous_count(video_id),
        }

    @app.get("/api/videos/{video_id}/raw")
    def get_raw(video_id: str) -> StreamingResponse:
        with connect() as conn:
            _require_recording(load_video(conn, video_id))
        return StreamingResponse(
            storage.iter_raw(video_id),
            media_type="video/webm",
            headers={"Content-Length": str(storage.raw_size(video_id))},
        )

    @app.post("/api/videos/{video_id}/finalize")
    async def finalize(
        video_id: str,
        request: Request,
        chunk_count: Annotated[int, Query(alias="chunkCount", ge=1)],
        body_offset: Annotated[int, Query(alias="bodyOffset", ge=0)] = 0,
        duration_ms: Annotated[int | None, Query(alias="durationMs", ge=0)] = None,
        width: Annotated[int | None, Query(ge=1, le=16384)] = None,
        height: Annotated[int | None, Query(ge=1, le=16384)] = None,
    ) -> dict[str, Any]:
        with connect() as conn:
            row = load_video(conn, video_id)
            if row["status"] == "ready":
                return video_json(row)
        header = await request.body()
        if len(header) > MAX_HEADER_BYTES:
            raise HTTPException(413, "Header too large")
        if header and not header.startswith(storage.EBML_MAGIC):
            raise HTTPException(422, "Header is not WebM")
        missing = storage.missing_chunks(video_id, chunk_count)
        if missing:
            raise HTTPException(409, {"message": "Some chunks have not arrived", "missing": missing})
        try:
            size = await run_in_threadpool(storage.assemble, video_id, chunk_count, header, body_offset)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        with connect() as conn:
            conn.execute(
                "update videos set status = 'ready', size_bytes = ?, chunk_count = ?, seekable = ?,"
                " duration_ms = ?, width = coalesce(?, width), height = coalesce(?, height),"
                " updated_at = ? where id = ?",
                (size, chunk_count, int(bool(header)), duration_ms, width, height, now_iso(), video_id),
            )
            return video_json(load_video(conn, video_id))

    @app.put("/api/videos/{video_id}/thumbnail", status_code=204)
    async def put_thumbnail(video_id: str, request: Request) -> Response:
        with connect() as conn:
            load_video(conn, video_id)
        data = await request.body()
        if not data or len(data) > MAX_THUMB_BYTES:
            raise HTTPException(422, "Thumbnail must be a JPEG under 5 MB")
        if not data.startswith(b"\xff\xd8"):
            raise HTTPException(422, "Thumbnail must be a JPEG")
        await run_in_threadpool(storage.write_thumbnail, video_id, data)
        with connect() as conn:
            conn.execute(
                "update videos set has_thumbnail = 1, updated_at = ? where id = ?", (now_iso(), video_id)
            )
        return Response(status_code=204)

    @app.get("/api/videos/{video_id}/thumbnail")
    def get_thumbnail(video_id: str) -> FileResponse:
        path = storage.thumb_path(video_id)
        if not path.is_file():
            raise HTTPException(404, "No thumbnail")
        return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-cache"})

    @app.get("/api/videos/{video_id}/media")
    def get_media(video_id: str) -> FileResponse:
        with connect() as conn:
            row = load_video(conn, video_id)
        if row["status"] != "ready":
            raise HTTPException(409, "This video is still being recorded")
        path = storage.media_path(video_id)
        if not path.is_file():
            raise HTTPException(404, "Video file is missing")
        # Starlette's FileResponse answers Range requests with 206, which is what makes seeking work.
        return FileResponse(path, media_type=row["mime_type"].split(";")[0] or "video/webm")

    # Comments -----------------------------------------------------------------------------

    @app.get("/api/videos/{video_id}/comments")
    def list_comments(video_id: str) -> list[dict[str, Any]]:
        with connect() as conn:
            load_video(conn, video_id)
            rows = conn.execute(
                "select * from comments where video_id = ? order by created_at, id", (video_id,)
            )
            return [comment_json(r) for r in rows]

    @app.post("/api/videos/{video_id}/comments", status_code=201)
    def add_comment(video_id: str, body: CommentIn) -> dict[str, Any]:
        text = body.body.strip()
        name = body.author_name.strip()
        if not text or not name:
            raise HTTPException(422, "Comment and name can't be empty")
        with connect() as conn:
            video = load_video(conn, video_id)
            if not video["comments_enabled"]:
                raise HTTPException(403, "Comments are turned off for this video")
            parent_id = body.parent_id
            if parent_id:
                parent = conn.execute(
                    "select id, parent_id, video_id from comments where id = ?", (parent_id,)
                ).fetchone()
                if parent is None or parent["video_id"] != video_id:
                    raise HTTPException(404, "The comment you replied to is gone")
                # One level of replies: a reply to a reply joins the same thread.
                parent_id = parent["parent_id"] or parent["id"]
            comment_id = new_id()
            conn.execute(
                "insert into comments (id, video_id, parent_id, author_id, author_name, is_owner,"
                " body, timestamp_ms, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    comment_id,
                    video_id,
                    parent_id,
                    body.author_id,
                    name,
                    int(is_owner_device(conn, body.author_id)),
                    text,
                    None if parent_id else body.timestamp_ms,
                    now_iso(),
                ),
            )
            row = conn.execute("select * from comments where id = ?", (comment_id,)).fetchone()
            return comment_json(row)

    @app.delete("/api/comments/{comment_id}", status_code=204)
    def delete_comment(comment_id: str, author_id: Annotated[str, Query(alias="authorId")]) -> Response:
        with connect() as conn:
            row = conn.execute("select author_id from comments where id = ?", (comment_id,)).fetchone()
            if row is None:
                raise HTTPException(404, "Comment not found")
            if row["author_id"] != author_id and not is_owner_device(conn, author_id):
                raise HTTPException(403, "Only the author or the owner can delete this comment")
            conn.execute(
                "update comments set deleted_at = ? where id = ? and deleted_at is null",
                (now_iso(), comment_id),
            )
        return Response(status_code=204)

    # Reactions ----------------------------------------------------------------------------

    @app.get("/api/videos/{video_id}/reactions")
    def list_reactions(video_id: str) -> list[dict[str, Any]]:
        with connect() as conn:
            load_video(conn, video_id)
            rows = conn.execute(
                "select * from reactions where video_id = ? order by created_at, id", (video_id,)
            )
            return [reaction_json(r) for r in rows]

    @app.post("/api/videos/{video_id}/reactions", status_code=201)
    def add_reaction(video_id: str, body: ReactionIn) -> dict[str, Any]:
        if body.emoji not in EMOJIS:
            raise HTTPException(422, "Unknown reaction")
        name = body.author_name.strip()
        if not name:
            raise HTTPException(422, "Name can't be empty")
        with connect() as conn:
            video = load_video(conn, video_id)
            if not video["reactions_enabled"]:
                raise HTTPException(403, "Reactions are turned off for this video")
            reaction_id = new_id()
            conn.execute(
                "insert into reactions (id, video_id, author_id, author_name, emoji, timestamp_ms,"
                " created_at) values (?, ?, ?, ?, ?, ?, ?)",
                (reaction_id, video_id, body.author_id, name, body.emoji, body.timestamp_ms, now_iso()),
            )
            row = conn.execute("select * from reactions where id = ?", (reaction_id,)).fetchone()
            return reaction_json(row)

    # Views --------------------------------------------------------------------------------

    @app.post("/api/videos/{video_id}/views")
    def record_view(video_id: str, body: ViewIn) -> dict[str, bool]:
        with connect() as conn:
            video = load_video(conn, video_id)
            if is_owner_device(conn, body.viewer_id):
                return {"counted": False, "owner": True}
            stamp = now_iso()
            delta = min(body.delta_ms, MAX_HEARTBEAT_MS)
            conn.execute(
                "insert into views (video_id, viewer_id, viewer_name, first_seen_at, last_seen_at)"
                " values (?, ?, ?, ?, ?) on conflict (video_id, viewer_id) do nothing",
                (video_id, body.viewer_id, body.viewer_name, stamp, stamp),
            )
            conn.execute(
                "update views set watched_ms = watched_ms + ?, max_position_ms = max(max_position_ms, ?),"
                " completed = max(completed, ?), viewer_name = coalesce(?, viewer_name),"
                " last_seen_at = ? where video_id = ? and viewer_id = ?",
                (delta, body.position_ms, int(body.ended), body.viewer_name, stamp, video_id, body.viewer_id),
            )
            row = conn.execute(
                "select watched_ms, completed, counted from views where video_id = ? and viewer_id = ?",
                (video_id, body.viewer_id),
            ).fetchone()
            duration = video["duration_ms"] or 0
            qualifies = (
                row["watched_ms"] >= VIEW_MIN_MS
                or (duration > 0 and row["watched_ms"] >= duration * VIEW_MIN_FRACTION)
                or bool(row["completed"])
            )
            if qualifies and not row["counted"]:
                conn.execute(
                    "update views set counted = 1 where video_id = ? and viewer_id = ?",
                    (video_id, body.viewer_id),
                )
            return {"counted": bool(qualifies or row["counted"]), "owner": False}

    @app.get("/api/videos/{video_id}/views")
    def list_views(video_id: str) -> dict[str, Any]:
        with connect() as conn:
            load_video(conn, video_id)
            rows = conn.execute(
                "select * from views where video_id = ? and counted = 1 order by last_seen_at desc",
                (video_id,),
            ).fetchall()
        viewers = [
            {
                "viewerId": r["viewer_id"],
                "viewerName": r["viewer_name"] or "Anonymous",
                "watchedMs": r["watched_ms"],
                "completed": bool(r["completed"]),
                "firstSeenAt": r["first_seen_at"],
                "lastSeenAt": r["last_seen_at"],
            }
            for r in rows
        ]
        return {"count": len(viewers), "viewers": viewers}

    return app


app = create_app()
