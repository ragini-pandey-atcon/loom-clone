# Architecture: ATCON Async Video, local edition (a rebuild of Loom's core features)

Date: 2026-10-10. Reads `recon.md` and `features.csv`. Supersedes the Entra and Azure assumptions in the
recon for this edition: everything runs on one Windows machine.

## Constraints that shape everything

- **Local only.** No sign-in, no accounts, no cloud services, no email. Both servers bind to `127.0.0.1`,
  so nothing outside this machine can reach them.
- **One implicit owner.** The browser that opens the library is the owner's. Anyone opening `/v/:id` in
  another browser (or a private window) is a viewer, who types a display name once to comment or react.
  The name and a random viewer id live in `localStorage`.
- **No ffmpeg.** The browser records WebM with `MediaRecorder`. WebM from `MediaRecorder` has no duration
  and no seek index, so the browser repairs it: it walks the recording, then writes a new header with a
  `Duration` and a `Cues` index. Only that header (a few KB) is uploaded at Stop; the server splices it in
  front of the chunks it already has. The backend serves the file with HTTP range requests, so seeking works.
- **Chrome and Edge only for recording.** Compositing uses `MediaStreamTrackProcessor` and
  `MediaStreamTrackGenerator` (Chromium only). Other browsers see "Recording isn't supported in this
  browser" and can still watch.

## Stack

| layer | choice | why |
| --- | --- | --- |
| web | React 19 + Vite + TypeScript, React Router | the user's stack; one SPA, Vite proxies `/api` so the app has one origin |
| styling | plain CSS with tokens in `frontend/src/styles/tokens.css` | no build plugin needed; light and dark from one token file |
| api | FastAPI on Python 3.13, uvicorn | the user's stack |
| database | SQLite (`data/app.db`, WAL mode), stdlib `sqlite3`, no ORM | one local file, zero setup; six tables do not need an ORM |
| auth | none. Owner = this browser; viewers = name in `localStorage` | local only, no accounts |
| payments | none | internal tool |
| email | none | local only |
| jobs | none scheduled. Startup sweep removes orphaned folders | nothing needs a clock |
| files | `data/videos/<id>/` on disk: `chunks/*.part`, `video.webm`, `thumb.jpg` | local only; `data/` is gitignored |
| hosting | this machine. Web on 5310, API on 7310, started detached | the usual ports are taken here |

## Recording pipeline (hard parts 1 to 3)

```
getDisplayMedia (screen)  ──► MediaStreamTrackProcessor ─┐
getUserMedia (camera)     ──► MediaStreamTrackProcessor ─┼─► OffscreenCanvas: screen + round camera bubble
                                                         │      │  driven by camera frames (steady 30 fps),
                                                         │      ▼  so a static screen still records
                                                         └─► MediaStreamTrackGenerator (video track)
getUserMedia (mic)  ───────────────────────────────────────────► + audio track
                                                                  │
                                       MediaRecorder(webm, vp9/vp8 + opus).start(1000 ms)
                                                                  │ dataavailable every second
                                                     upload queue: PUT /api/videos/:id/chunks/:seq
                                                     (in order, retried with backoff, Blob kept until acked)
Stop ─► copy link (inside the click, so the clipboard is allowed) ─► drain queue
     ─► fixWebm(all chunks) ─► POST /finalize (new header + body offset) ─► server splices ─► ready
```

- Frame reading uses stream readers, not `requestAnimationFrame` or timers, so a hidden tab (the user is
  in another app) keeps recording at full rate.
- Screen only: the screen track is recorded directly. Camera only: the camera track is recorded directly.
- Crash or closed tab: the chunks are already on disk. The library shows the take as "Unfinished" with a
  Recover action, which downloads the raw chunks, runs the same `fixWebm`, and finalizes. One repair
  implementation, in the browser, as the brief asks.

## Schema

Tables: 6. Access rules: none to enforce (one owner, local only, loopback binding). The data layer still
checks that a comment delete comes from its author or the owner device, so viewers cannot remove each
other's comments by accident. SQLite has no `uuid` or `timestamptz`: ids are text, times are ISO 8601 UTC
text (`2026-10-10T19:04:05.123Z`), which sorts correctly as text.

See `replica/schema.sql` (the backend runs the same statements at startup).

## API

All JSON is camelCase. Errors are `{"detail": "..."}` with a real status code.

| method path | does | who | input | output | flow |
| --- | --- | --- | --- | --- | --- |
| GET /api/health | liveness | any | | `{ok}` | |
| POST /api/owner/devices | marks this browser as the owner's | owner | `{viewerId}` | 204 | F05 (owner views excluded) |
| GET /api/videos | library list, newest first | owner | `?q=` title search, `?archived=1` | `Video[]` | F08 |
| POST /api/videos | creates a draft at record start, so the link exists before Stop | owner | `{sourceMode, mimeType}` | `Video` | F01 |
| GET /api/videos/:id | one video | any | | `Video` | F01, F03 |
| PATCH /api/videos/:id | rename, archive/restore, toggle comments/reactions | owner | `{title?, archived?, commentsEnabled?, reactionsEnabled?}` | `Video` | F07, F08 |
| DELETE /api/videos/:id | permanent delete: row, comments, reactions, views, files | owner | | 204 | F02, F08 |
| PUT /api/videos/:id/chunks/:seq | stores one recording chunk; idempotent per seq | owner | raw bytes | `{seq, bytes}` | F01 |
| GET /api/videos/:id/chunks | which chunks arrived (resume after a drop) | owner | | `{received[], bytes}` | F01 |
| GET /api/videos/:id/raw | the unrepaired recording, for Recover | owner | | `video/webm` stream | F01 edge |
| POST /api/videos/:id/finalize | splices the repaired header in front of the chunks; idempotent | owner | header bytes, `?bodyOffset&durationMs&chunkCount&width&height` | `Video` (409 lists missing chunks) | F01 |
| PUT /api/videos/:id/thumbnail | stores a JPEG grabbed in the browser | owner | `image/jpeg` | 204 | F08 |
| GET /api/videos/:id/thumbnail | the thumbnail | any | | `image/jpeg` | |
| GET /api/videos/:id/media | the video, with Range support (206) | any | `Range` | `video/webm` | F03 |
| GET /api/videos/:id/comments | comments with replies | any | | `Comment[]` | F03, F04 |
| POST /api/videos/:id/comments | add a comment or reply | any named viewer | `{authorId, authorName, body, timestampMs?, parentId?}` | `Comment` | F03, F04 |
| DELETE /api/comments/:id | soft delete (keeps the thread) | author or owner | `?authorId=` | 204 | F04 |
| GET /api/videos/:id/reactions | all reactions | any | | `Reaction[]` | F03 |
| POST /api/videos/:id/reactions | react at a timestamp | any named viewer | `{authorId, authorName, emoji, timestampMs}` | `Reaction` | F03 |
| POST /api/videos/:id/views | watch heartbeat | any viewer | `{viewerId, viewerName, watchedMs, positionMs, ended}` | `{counted}` | F05 |
| GET /api/videos/:id/views | viewer list for Insights | owner | | `{count, viewers[]}` | F05 |

Webhooks in: none. Webhooks out: none. Jobs: a startup sweep deletes `data/videos/<id>` folders with no row
(left behind when Windows refused to delete a file that was still being streamed).

## The parts that bite

- **Time zones:** stored in UTC, shown with `Intl` in the browser's zone. Video timestamps are integer ms.
- **Idempotency:** a chunk is keyed by its sequence number and written to a temp file then `os.replace`d,
  so a retried PUT overwrites itself. Finalize on a ready video returns it unchanged.
- **Races:** finalize while a chunk PUT is in flight. The client drains its queue first; the server also
  checks for a contiguous `0..n-1` and answers 409 with the missing list, and the client resends them.
- **Background tabs:** Chrome throttles timers and stops `requestAnimationFrame` in hidden tabs. The
  compositor never uses either (see pipeline).
- **Clipboard:** `navigator.clipboard.writeText` needs a user gesture. The link is copied inside the Stop
  click. When the browser's own "Stop sharing" bar ends the take there is no gesture, so the video page
  shows a Copy link prompt instead.
- **File size:** a chunk is capped at 64 MB. Long takes are held as `Blob`s, which Chrome spills to disk,
  and the repair reads them in 4 MB windows, so a one-hour take does not need a gigabyte of JS memory.
- **Windows file locks:** a file being streamed cannot be deleted. Delete removes the row first, then tries
  the folder; the startup sweep finishes the job.
- **SQLite concurrency:** WAL mode, a `busy_timeout`, one connection per request.
- **Honest view counts:** a viewer counts once per video, when they pass 5 s watched, 75 % of the
  duration, or the end. Refreshing never adds a view. Owner devices are excluded on the server.
- **Personal data:** recordings hold faces, voices and screens. They never leave `data/`, nothing is sent
  to a third party, and delete removes the files, not just the row.
- **Search:** `LIKE` on title, case-insensitive. Enough for one person's library.
- Not applicable here: payments, email deliverability, multi-tenancy, rate limits, realtime (the viewer
  list refreshes on focus).

## Build order

1. **Vertical slice (the core loop).** S05 recorder setup, S06 browser picker, S07 countdown,
   S08 recording bar, S09 finishing, S10 video page with player. Tables `videos`. Routes: create video,
   chunks, finalize, thumbnail, media (range), get video. The link is on the clipboard at Stop.
2. **Must-haves, by area.**
   - Recording: device pickers with level meter, permission-denied guidance, pause/resume (alt+shift+P),
     restart and delete take with confirm, timer, "Stop sharing" handling, Recover for unfinished takes.
   - Library (S03, S18): grid, search by title, rename, archive/restore, permanent delete with confirm.
   - Collaboration (S12): name prompt, timestamped comments with replies and timeline markers, emoji
     reactions on the timeline (last 50 float in the player). Tables `comments`, `reactions`.
   - Insights (S15): view count and viewer list with the 5 s / 75 % / ended rule. Tables `views`,
     `owner_devices`.
3. **Should-haves** (not in this pass): folders, draggable bubble, Document Picture-in-Picture bubble,
   tab and system audio, per-video settings beyond comments and reactions, notifications page, WebM
   download. Transcripts need a local speech model: the browser's speech API sends audio to a cloud
   service, which this edition rules out.
4. **Fixes from replica-entrepreneur:** not run yet.

Screens in this edition: S03, S05 to S10, S12, S15, S18. Skipped as local-only: S01, S11 (access and
email parts), S13, S16, S17, S20, S21 (no profile), S22 (could).
