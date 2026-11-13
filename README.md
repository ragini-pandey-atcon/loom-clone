# Async Video (local edition)

Record your screen with your camera in a bubble, press Stop, and the share link is already on your
clipboard. People who open the link watch, react with emoji and leave comments pinned to a moment in
the video. Transcripts and captions are made by a speech model running on this computer. Everything
runs on this Windows machine: no sign-in, no accounts, no cloud, no email.

- Web app: <http://localhost:5310> (React 19, Vite, TypeScript)
- API: <http://127.0.0.1:7310> (FastAPI, Python 3.13, SQLite)
- Videos and the database: `data/` in this folder (gitignored)

Recording needs **Chrome or Edge**. Any browser can watch.

## Start

First time only, install the dependencies (a Python virtual environment and npm packages, nothing
global). The first transcript also downloads the speech model once, about 150 MB, into
`data\models`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

Start both servers detached, so they keep running after the window closes:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

Then open <http://localhost:5310> in Chrome or Edge. Logs are in `data\logs\api.log` and
`data\logs\web.log`.

Stop both:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
```

### The same thing without the scripts

From this folder, in PowerShell. These are exactly what `start.ps1` runs:

```powershell
New-Item -ItemType Directory -Force data\logs | Out-Null
Start-Process cmd.exe -WindowStyle Hidden -WorkingDirectory backend -ArgumentList '/c', 'set PYTHONUNBUFFERED=1&& .venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 7310 > ..\data\logs\api.log 2>&1'
Start-Process cmd.exe -WindowStyle Hidden -WorkingDirectory frontend -ArgumentList '/c', 'npm run dev > ..\data\logs\web.log 2>&1'
```

Or run each in the foreground in its own terminal (stops when you close it):

```powershell
cd backend; .venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 7310
```

```powershell
cd frontend; npm run dev
```

## Using it

1. **New video**: pick Screen and camera, Screen only or Camera only, check the camera and microphone
   (the bar under the microphone moves when it hears you), then Start recording.
2. Chrome asks which screen, window or tab to share. Tick "Also share tab audio" or "system audio" if
   you want that sound recorded too.
3. A 3 second countdown, then you are recording. Switch to whatever you want to show.
4. Come back to the tab and press **Stop and share**, or click the browser's own **Stop sharing** bar.
   The video page opens and the link is on your clipboard.

Before or during a take, the camera bubble can be dragged anywhere (it snaps to the sides and
corners), resized on a five-step slider, and shaped as a circle, rounded square, landscape or portrait;
double-click it for full camera. Flip camera, filters and turning the camera off work mid-take too.
Video quality is 720p, 1080p, 1440p or 4K (never more than what you share). Your choices carry over.

While recording: Pause and Resume (or Alt+Shift+P), Restart (throws the take away, keeps your
devices), Delete. **Pop out controls** opens a small window that stays on top of other apps, with the
timer, Pause, Stop and an optional view of your camera (Chrome and Edge).

The library has folders, tags, Upload (WebM, MP4, MOV), and search across titles, tags and what was
said. Each card's menu has Copy link, Rename, Move to folder, Duplicate, Download, Archive and Delete.
Archived videos keep working links. Delete removes the files from disk; it cannot be undone.

On a video page the owner can Trim (non-destructive, with Revert to original), copy a link that starts
at the current time, add tags, and use the Settings tab: comments, reactions, showing the view count,
viewer downloads, transcript and captions, a recommended speed, and the thumbnail.

### Transcripts and captions

Every recording and upload gets a transcript in the background: the browser decodes the sound (so no
ffmpeg is needed), and the API transcribes it with whisper.cpp (`pywhispercpp`) on this computer.
Nothing is sent anywhere. It takes roughly a fifth of the video's length. The Transcript tab follows
along as the video plays; click a line to jump there, search it, copy it, or download captions
(WebVTT). The CC button in the player shows captions. The owner can turn both off per video.

The default model is `base` (multilingual). Set `ASYNC_VIDEO_STT_MODEL=small` before starting the API
for better accuracy at about three times the time; it downloads once, about 470 MB.

### Owner and viewers

There are no accounts. The browser that opens the library is the owner's: it can edit, trim, move and
delete, and sees the Activity and Settings tabs. Anyone else who opens a `/v/...` link is a viewer,
who types a display name once (kept in that browser) to comment, react, @mention, follow the video,
save it to Watch later, or record a video reply. The bell shows new comments, replies and mentions.

To see a video the way a viewer does, open its link in an InPrivate window or another browser.

A view counts once per viewer, after 5 seconds of watching, 75 % of the video, or the end. Refreshing
does not add views, and the owner's own plays never count.

The servers listen on `127.0.0.1` only, so links work on this machine and nowhere else.

## How it works without ffmpeg

`MediaRecorder` writes WebM with no duration and no seek index, which players cannot seek well. The
app fixes that in the browser:

1. While recording, a 1 second chunk is uploaded every second (`PUT /api/videos/:id/chunks/:n`),
   retried until it lands, so the server already holds the recording when you press Stop.
2. At Stop, the browser walks the recording (`frontend/src/lib/webmFix.ts`) and builds a new header:
   a Duration and a Cues index that points at every video keyframe. Only that header, a few KB, is
   sent to `POST /api/videos/:id/finalize`.
3. The server writes `header + chunks` into `data/videos/<id>/video.webm` and serves it with HTTP
   range requests, which is what lets the player jump anywhere.

The camera bubble is drawn into the recording frame by frame (`frontend/src/recorder/compositor.ts`)
with Chrome's `MediaStreamTrackProcessor` and `MediaStreamTrackGenerator`. These read frames as the
camera delivers them rather than on a timer, so recording keeps its frame rate while the tab is in
the background.

If the tab closes or the browser crashes mid-take, the uploaded chunks are kept. The video shows as
**Unfinished** in the library; **Recover** runs the same repair on what was saved.

## Tests

```powershell
cd backend; .venv\Scripts\python.exe -m pytest -q
```

```powershell
cd frontend; npm test; npm run typecheck
```

End to end, with the servers running. Chromium's fake camera, microphone and screen stand in for the
real ones. Each test deletes the videos it made. The transcript test speaks a sentence with Windows'
built-in voice and checks what the real speech model writes.

```powershell
cd frontend; npx playwright test
```

## Files

| path | what |
| --- | --- |
| `backend/app/main.py` | every API route |
| `backend/app/storage.py` | chunks, assembly, range-served files under `data/videos` |
| `backend/app/transcribe.py` | the local speech model, the transcript queue, WebVTT |
| `backend/app/db.py` | connections, and `migrate()`, which adds new columns to an existing database |
| `backend/app/schema.sql` | SQLite schema (same as `replica/schema.sql`; a test keeps them equal) |
| `frontend/src/recorder/` | capture, compositing, bubble geometry, quality, chunk upload, the session |
| `frontend/src/lib/webmFix.ts` | the in-browser WebM repair |
| `frontend/src/lib/transcriptAudio.ts` | decoding a video's sound in the browser for the speech model |
| `frontend/src/pages/` | Library, Record, Video, Watch later, Notifications |
| `replica/` | recon, architecture plan, feature matrix, build log, screenshots |
| `data/` | `app.db`, `videos/<id>/`, `models/`, `logs/`. Delete it (servers stopped) to start fresh |

## Not in this edition

Left out because it is local-only: sign-in, access levels, sharing with specific people, email,
embed codes, a home feed. Left out because each needs ffmpeg: MP4 conversion for downloads (files
download as recorded or uploaded), a viewer quality selector, animated GIF thumbnails (library cards
preview on hover instead). Drawing over other apps needs a desktop app. See `replica/features.csv`.
