# Build log: Async Video, local edition

Screens use the recon IDs. Screenshots are in `replica/clone-screens/`, taken at 1440 x 900 (plus 390 px
and dark variants) by `frontend/e2e/screenshots.mjs`, which records its own demo videos with Chromium's
fake devices and deletes them afterwards.

There are no reference screenshots of the original (the recon used public sources only), so replica-diff
can score features but not layout.

| ID | date | status | missing | harder than expected |
| --- | --- | --- | --- | --- |
| S03 Library | 2026-10-10 | done | folders (should) | nothing |
| S05 Recorder setup | 2026-10-10 | done | countdown on/off setting, flip camera (should) | permission errors need three messages, not one: blocked, busy in another app, missing |
| S06 Browser picker | 2026-10-10 | done | | the picker must open inside the click, before any await |
| S07 Countdown | 2026-10-10 | done | | |
| S08 Recording | 2026-10-10 | done | floating bubble over other apps (Document Picture-in-Picture, should); drag to move | see "Hard parts" below |
| S09 Finishing upload | 2026-10-10 | done | | the clipboard only accepts a write inside the Stop click, so the copy happens before any await |
| S10 Video page, owner | 2026-10-10 | done | transcript tab (should), download (should) | |
| S12 Video page, viewer | 2026-10-10 | done | watch later, captions | |
| S14 Video settings | 2026-10-10 | partial | only comments and reactions switches; the rest belong to skipped or unbuilt features | |
| S15 Insights | 2026-10-10 | done | | the final heartbeat is sent as the viewer leaves; it needs `keepalive` or the browser cancels it |
| S18 Archive | 2026-10-10 | done | | |
| S01, S11, S13, S16, S17, S20, S21, S22 | | skipped | local-only, or could-have | |

Must-haves: 20 of 20. Should-haves: 6 of 14 done or partial (see `features.csv`).

## Hard parts, as they turned out

- **Seeking without ffmpeg.** The repair writes Cues at video keyframes. The first real recording failed
  to seek with a decode error: the canvas frames carried an alpha channel, so Chrome wrote video as
  BlockGroups instead of SimpleBlocks, the parser found no video keyframes, and it fell back to cues at
  cluster starts, which are not keyframes. Fixed twice over: frames are created with
  `alpha: 'discard'`, and the parser reads keyframes from BlockGroups (no ReferenceBlock) as well.
  A unit test now covers both block kinds.
- **Recording in a hidden tab.** Timers and `requestAnimationFrame` stall when the user switches apps,
  so the compositor reads frames from stream readers and is driven by the camera, which delivers a
  steady frame rate even when the screen is static.
- **Crash recovery.** One repair implementation, in the browser: Recover downloads the saved chunks,
  repairs them and finalizes. Covered by an e2e test that closes the tab mid-take.

## Verified

- Backend: 14 pytest tests (upload, splice, idempotent finalize, missing chunks, range requests, search,
  archive, delete, comment rules, reactions, the view rule, orphan sweep).
- Frontend: WebM repair unit tests; typecheck clean.
- End to end in Chromium with fake camera, mic and screen (`npx playwright test`, 6 tests): record with
  pause, Stop copies the link, the repaired file reports its duration and seeks to 3.2 s; viewer reacts
  (name prompt), comments and counts as one view; owner replies and sees the viewer in Activity; rename,
  archive, restore, delete; recover after the tab closes; screen-only and camera-only modes.
- Not automated: the browser's own Stop sharing bar (headless Chromium has none) and Edge. Both use the
  same code paths as Chrome.

## Next

- `/replica-test` for a wider pass, then the should-haves in this order: folders, Document
  Picture-in-Picture bubble with controls, WebM download, countdown setting.

## 2026-11-12: recorder refresh

Reported in use: the bubble could not be customised, its size could not be edited, and screen
recordings were blurry with no quality choice. Recon refreshed from public help pages (recon.md,
"Recorder refresh"), then built:

- Bubble geometry in `recorder/bubble.ts`, shared by the compositor and the page, so the bubble you
  drag is exactly where it is recorded. Position is stored as a share of the free space (px, py),
  which stays valid for every shape, size and frame and can never leave the frame.
- Four shapes, five sizes, drag with snap, keyboard moves, double-click for full camera, flip,
  filters, camera off and on, all live mid-take (the compositor reads the options every frame).
- Quality 720p to 4K. The old output was capped at 1080p and 2.5 Mbps; it is now the chosen size
  (never upscaled) at about 0.13 bits per pixel: 8.1 Mbps at 1080p, 3.6 at 720p (checked on the
  real MediaRecorder). Screen track and output carry `contentHint = 'detail'`.
- Settings carry over in localStorage (`recorder/preferences.ts`), validated field by field.

Verified: 24 unit tests (geometry, quality, preferences, WebM repair), typecheck, and 8 e2e tests
including two new ones (bubble shape, size, drag-to-snap, keyboard and carry-over; a 720p take with
no countdown whose file is 720p after live shape, size, full camera and camera off/on changes).
Recorded frames were checked by eye: a change made mid-take shows in the file.
Not verified here: 1440p and 4K output, because the fake screen in headless Chromium is 1080p.

Next: floating bubble and controls over other apps (Document Picture-in-Picture).

## 2026-11-13: library and sharing batch

Built from the public help pages (manage videos, trim, revert a trim):

- **Floating controls**: Document Picture-in-Picture window with timer, Pause/Resume, Stop and an
  optional camera view, above every other app. Opens on Start when the browser still allows it,
  otherwise from Pop out controls. Its own React root (events in the PiP document never reach the
  app's root), fed by the same session store. The camera starts hidden when the whole screen is
  shared, because that window is captured too.
- **Folders**: one level, a Folders row above My videos, a folder page, Move to folder (with a new
  folder made in the dialog), rename, delete (videos go back to My videos). Search at the top level
  looks in every folder and labels each result with its folder.
- **Upload** WebM/MP4/MOV up to 4 GB, streamed to disk; the browser reads length, size and the
  thumbnail, which also proves the file is playable here.
- **Download** (the file as recorded or uploaded), **Duplicate** (file copied, activity not).
- **Trim**: non-destructive, as in Loom. A playback window over the untouched file, with Revert to
  original; the player starts at the trim start, stops at the trim end (frame callback), and shows
  the clock, timeline, markers and comment times from the trimmed 0:00.
- **Link at the current time** (`?t=seconds`) and **Watch later** per browser, with its own page.
- Database: `folders` and `watch_later` tables, four new `videos` columns added in place by
  `db.migrate()` on start (tested from a pre-folder database; the real one migrated cleanly).

Verified: 22 backend tests, 31 unit tests, typecheck, 11 e2e tests (3 new: upload, trim and
revert with the player stopping at the trim end, download name, duplicate, timestamp link, watch
later; folders end to end; floating controls pausing and stopping from their own window). A real
layout bug was caught there (the Watch later title link covered its Remove button).
Not done: MP4 conversion for downloads (no ffmpeg), middle cuts in trim.

## 2026-11-13: settings, tags and collaboration batch

- **Per-video settings tab** (Loom S14): comments, reactions, show view count to viewers, viewers
  can download (enforced by the API, not just hidden), recommended playback speed, and a custom
  thumbnail from an uploaded image or the current frame. Switches apply at once and saves run one
  at a time; the e2e run caught two quick flips undoing each other before that.
- **Theater mode**, remembered per browser.
- **Tags**: up to 10 per video, case-insensitive; a tag bar filters the library across folders,
  and search matches tags.
- **Notifications** with a bell and unread count: comments, replies, @mentions and video replies,
  one row per person with the most specific kind, never for your own comment. The owner's rows
  go to every owner device. **Follow** a video; commenting follows it.
- **@mentions**: suggestions while typing (keyboard and mouse), names with spaces, highlighted in
  comments. Front end (`lib/mentions.ts`) and API (`mentioned_ids`) apply the same boundary rule.
- **Video replies**: "Video reply" in the comment box opens the recorder; the reply is posted as a
  comment with a video card only once it plays. Reply mode does not mark the viewer's browser as
  the owner's.
- **Hover preview** on library cards, in place of an animated GIF (a GIF needs ffmpeg).
- Also fixed: length badges sat outside the thumbnail on Watch later rows (previous batch).

Verified: 29 backend tests, 38 unit tests, typecheck, 13 e2e tests (2 new, with an owner and a
viewer in separate browsers). Skipped with reasons: viewer quality selector (no transcoding), home
feed (no workspace). Still to do: transcripts, captions and transcript search.

## 2026-11-13: transcripts and captions, on this computer

- Engine: whisper.cpp through `pywhispercpp` 1.5.1, model `base` (multilingual, 148 MB, downloaded
  once into `data/models`). Chosen over faster-whisper, which installs PyAV (ffmpeg's libraries) and
  onnxruntime; pywhispercpp takes raw samples and needs only numpy, requests, tqdm, platformdirs.
  Measured here: 2.1 s for 10.6 s of speech, word for word.
- The browser decodes the sound (`decodeAudioData` into a 16 kHz OfflineAudioContext), mixes to
  mono 16-bit PCM and `PUT`s it to `/api/videos/:id/audio`. Near-silence is sent as "no sound",
  because Whisper invents words on silence. No audio track means an empty, ready transcript.
- One background thread transcribes one video at a time; `[BLANK_AUDIO]`-style markers are
  dropped; the audio file is deleted afterwards. After a restart, waiting work is queued again and
  work whose audio is gone is marked failed with a retry. The engine is injected, so the 10 API
  tests use a fake.
- Recordings start their transcript when the upload finishes; uploads after upload; older videos
  from "Create transcript". Transcript tab: follows playback, click to seek, search with
  highlights, copy, WebVTT download, Redo. Captions via `<track>` and a CC button, lifted above the
  control bar while it shows. Library search matches what was said and shows the line.
- Owner switch "Transcript and captions": enforced by the API for viewers and for search.
- The e2e run caught a race this batch introduced: polling the video while a transcript is made
  could undo a just-clicked Watch later. Stale re-reads are now dropped, and toggles re-apply
  after their save (15/15 across three repeats).

Verified: 39 backend tests, 41 unit tests, typecheck, 14 e2e tests including one with the real
model (Windows voice speaks a sentence; transcript, click-to-seek, search, captions, library
search, and the off switch for a viewer). The feature matrix has no "no" rows left.
