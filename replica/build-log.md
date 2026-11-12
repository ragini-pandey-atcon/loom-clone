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
