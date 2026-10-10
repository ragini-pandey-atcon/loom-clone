# Async Video (local edition)

Record your screen with your camera in a bubble, press Stop, and the share link is already on your
clipboard. People who open the link watch, react with emoji and leave comments pinned to a moment in
the video. Everything runs on this Windows machine: no sign-in, no accounts, no cloud, no email.

- Web app: <http://localhost:5310> (React 19, Vite, TypeScript)
- API: <http://127.0.0.1:7310> (FastAPI, Python 3.13, SQLite)
- Videos and the database: `data/` in this folder (gitignored)

Recording needs **Chrome or Edge**. Any browser can watch.

## Start

First time only, install the dependencies (a Python virtual environment and npm packages, nothing
global):

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

While recording: Pause and Resume (or Alt+Shift+P while the tab is focused), Restart (throws the take
away, keeps your devices), Delete. The bubble's corner and size can change mid-take.

The library lists your videos with search by title. Each card's menu has Copy link, Rename, Archive and
Delete. Archived videos keep working links and live under Archive until you restore or delete them.
Delete removes the files from disk; it cannot be undone.

### Owner and viewers

There are no accounts. The browser that opens the library is the owner's: it can rename, archive,
delete, and sees the Activity tab (who watched, reactions, comment and reaction switches). Anyone
else who opens a `/v/...` link is a viewer, who types a display name once (kept in that browser) to
comment or react.

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
real ones. Each test deletes the videos it made.

```powershell
cd frontend; npx playwright test
```

## Files

| path | what |
| --- | --- |
| `backend/app/main.py` | every API route |
| `backend/app/storage.py` | chunks, assembly, range-served files under `data/videos` |
| `backend/app/schema.sql` | SQLite schema (same as `replica/schema.sql`; a test keeps them equal) |
| `frontend/src/recorder/` | capture, compositing, chunk upload, the recording session |
| `frontend/src/lib/webmFix.ts` | the in-browser WebM repair |
| `frontend/src/pages/` | Library, Record, Video page |
| `replica/` | recon, architecture plan, feature matrix, build log, screenshots |
| `data/` | `app.db`, `videos/<id>/`, `logs/`. Delete it (with the servers stopped) to start fresh |

## Not in this edition

Left out because it is local-only: sign-in, access levels, sharing with specific people, email
notifications, embed codes. Not built yet (should-haves): folders, a floating bubble over other apps,
transcripts and captions (they need a speech model running on this machine), MP4 download, a
notifications page. See `replica/features.csv`.
