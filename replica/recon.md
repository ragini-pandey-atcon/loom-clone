# Recon map: Loom (web)

Scope: the core loop. Record screen + camera bubble + mic in the browser, upload while recording, get an instant share link, viewers watch, react and leave timestamped comments, the owner sees who watched. Plus a personal video library with folders, search, archive and delete.
For: an internal ATCON tool. Async video for ATCON teams, sign-in with Microsoft Entra, data kept in ATCON's own Azure tenant in the EU.
Date: 2026-10-10

## Ground rules for this recon

- **Public sources only.** The Atlassian Customer Agreement (effective 1 Oct 2026), section 2.2(d), forbids customers to "use the Products to develop a similar or competing product or service", and 2.2(e) forbids access to non-public APIs. So no ATCON or personal Loom account was used, and none should be used for the rest of this project.
- **No screenshots of the product UI.** With no account allowed, `replica/screens/` is empty. Screens below are inferred from the help centre and marketing site, so layouts are a guess and replica-diff's layout score cannot be run against the original. The feature score still works.
- Nothing was scraped. About 25 public help articles were read one by one.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | help centre index | https://support.atlassian.com/loom/resources/ | full article map, 8 sections, ~200 articles. The most complete feature list there is |
| 2 | pricing page | https://www.loom.com/pricing | Starter $0, Business $18, Business + AI $24, Enterprise. Shows what is gated |
| 3 | marketing site | https://www.loom.com/ | positioning: record, edit, share, collaborate. Replace meetings and long emails |
| 4 | chrome extension recording | https://support.atlassian.com/loom/docs/get-started-with-the-loom-chrome-extension/ | source picker (full screen, window, tab, camera only), mic level meter, countdown setting |
| 5 | capture modes | https://support.atlassian.com/loom/docs/use-looms-different-capture-modes/ | camera bubble: drag + snap, 5 sizes, 4 shapes, filters, double-click to fullscreen |
| 6 | pause and resume | https://support.atlassian.com/loom/docs/pause-and-resume-while-recording/ | pause button by the bubble, shortcut alt+shift+P |
| 7 | restart a recording | https://support.atlassian.com/loom/docs/restart-a-recording/ | restart keeps preferences |
| 8 | how long can I record | https://support.atlassian.com/loom/docs/how-long-can-i-record/ | 5 min on free plan with a countdown under Stop; 2 h "still recording?" check-in |
| 9 | encoding settings | https://support.atlassian.com/loom/docs/loom-video-encoding-settings-by-platform/ | extension records WebM (VP8/VP9 + Opus) up to 1080p 30 fps; server re-encodes to an adaptive ladder 360p to 2160p; downloads are MP4 |
| 10 | share your recording | https://support.atlassian.com/loom/docs/share-your-recording/ | copy link, workspace members (view/edit), email, space, embed (responsive/fixed), share at a timestamp |
| 11 | permissions and privacy | https://support.atlassian.com/loom/docs/manage-the-permissions-and-privacy-of-your-videos/ | link access levels, admin default privacy for new videos |
| 12 | share with specific people | https://support.atlassian.com/loom/docs/share-your-recording-with-specific-people/ | "only people added can access", invitee must sign in with that email |
| 13 | reactions and comments | https://support.atlassian.com/loom/docs/react-to-videos-with-emojis-and-in-video-comments/ | timeline markers, last 50 reactions in player, replies, @mentions, follow a video, anonymous reactions |
| 14 | video settings | https://support.atlassian.com/loom/docs/edit-your-video-settings-disable-comments-emoji-reactions-downloads-and-more/ | Settings tab: Enhancement and Audience toggles |
| 15 | views and analytics | https://support.atlassian.com/loom/docs/understand-your-videos-views-and-analytics/ | view = 5 s watched, or 75 %, or scrub to end; owner's own views and cookie-blocked views not counted; up to 12 avatars then "+N" |
| 16 | library | https://support.atlassian.com/loom/docs/understand-your-library/ | Videos, folders, search by name, tag, space or transcript phrase |
| 17 | home | https://support.atlassian.com/loom/docs/understand-your-loom-home/ | feed: trending, from people and tags you follow |
| 18 | manage your videos | https://support.atlassian.com/loom/docs/manage-videos-you-created/ | move, rename, duplicate, download MP4, archive, delete (irreversible) |
| 19 | notifications page | https://support.atlassian.com/loom/docs/understand-the-notifications-page/ | Overview, Shared with me, Comments; reply inline |
| 20 | transcripts and captions | https://support.atlassian.com/loom/docs/loom-video-transcription-and-closed-captions/ | auto transcript on all plans, click a line to seek, search, copy, captions from transcript, SRT download |
| 21 | watch later | https://support.atlassian.com/loom/docs/save-looms-to-watch-later/ | toggle under the player, lives in Playlists |
| 22 | browser support | https://support.atlassian.com/loom/docs/can-i-use-loom-with-firefox-safari-and-other-browsers/ | recording: Chrome and Brave only; viewing: Chrome, Firefox, Safari, Edge. No extension-free web recorder |
| 23 | open API | https://support.atlassian.com/loom/docs/does-loom-have-an-open-api/ | no open API; an SDK for record and embed only. No data model to borrow |
| 24 | terms | https://www.atlassian.com/legal/atlassian-customer-agreement | section 2.2(d) and (e), see ground rules |

Not used: Loom's own account, app screenshots, network traffic, JavaScript bundles.

## Core loop

Hit record, talk over your screen with your face in a bubble, stop, and a link is already on your clipboard; teammates watch when it suits them and answer with timestamped comments and emoji instead of a meeting.

## Screens

States legend: E empty, L loading, F filled, X error, P permission denied, M mobile width.

| ID | screen | route / how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Sign in | `/signin`, any route when signed out | Entra sign-in (Loom: email, Google, Slack, Apple, SAML SSO) | Button, logo | L, X |
| S02 | Home | `/` | feed of recent and trending videos in the workspace | VideoCard grid, SidebarNav, New video button | E, L, F |
| S03 | Library: My videos | `/library` | every video I made | VideoCard grid, FolderCard, SearchInput, sort menu, kebab Menu, New video button | E, L, F, M |
| S04 | Folder | `/library/folders/:id` | videos in a folder | Breadcrumbs, VideoCard grid, rename/delete folder | E, F |
| S05 | Recorder setup | New video button, opens as a panel or modal | choose source and devices before recording | segmented control (screen, window, tab, camera only), camera toggle + Select, mic Select + AudioLevelMeter, settings menu (countdown, flip camera, show timer), Start recording | F, P (camera or mic blocked), X (no devices) |
| S06 | Browser share picker | after Start recording | the browser's own dialog to pick screen, window or tab. Not ours, but our flow must handle cancel | native | F, cancelled |
| S07 | Countdown | after the picker | 3, 2, 1 before capture starts | Countdown overlay | F |
| S08 | Recording | during capture | controls while recording | RecordingControlBar (stop, pause/resume, restart, delete, timer), CameraBubble (drag, snap, 5 sizes, 4 shapes) | recording, paused, near limit, X (stream ended by browser "Stop sharing") |
| S09 | Finishing upload | right after Stop | upload finishes, video page opens, link copied | ProgressBar, Toast "Link copied" | L, X (upload failed, retry) |
| S10 | Video page, owner | `/v/:id` as owner | watch, rename, share, see activity | VideoPlayer, editable title, Share button, kebab Menu, side panel Tabs (Activity, Transcript, Settings), AvatarStack of viewers | processing, F, X (processing failed) |
| S11 | Share dialog | Share button on S10 | link access, invite people, copy link, embed | Modal, Tabs (Link, Embed), access Select (workspace, specific people, anyone with link), email chips input with view/edit role, "start at mm:ss" checkbox, Copy link, embed code (responsive or fixed) | F, X (invalid email) |
| S12 | Video page, viewer | `/v/:id` as a viewer | watch and respond | VideoPlayer (speed, captions, quality, theater, fullscreen), EmojiReactionBar, timeline markers, CommentThread, CommentComposer, Watch later toggle, Transcript panel, sign-in prompt | L, F, comments off, reactions off |
| S13 | No access / password | `/v/:id` without rights | stop people who are not invited | EmptyState with message, Request access button (inferred), PasswordGate | P, X (wrong password) |
| S14 | Video settings | Settings tab in the S10 side panel | per-video toggles | Toggle list: comments + email on comment, emoji reactions, show view count to viewers, downloads, transcript, recommended playback speed, GIF thumbnail, custom thumbnail | F |
| S15 | Insights | Activity tab on S10 | who watched and how | view count, viewer list (named or Anonymous), AvatarStack "+N", all reactions list | E (no views yet), F |
| S16 | Notifications | `/notifications` | comments, replies, mentions, shares | Tabs (Overview, Shared with me, Comments), NotificationRow with transcript snippet and inline reply | E, F |
| S17 | Shared with me | sidebar | videos others sent me | VideoCard grid | E, F |
| S18 | Archive | sidebar or library filter | archived videos, restore or delete | VideoCard grid, Restore, Delete | E, F |
| S19 | Watch later | sidebar "Playlists" | saved videos | VideoCard list, remove | E, F |
| S20 | Embed player | `/embed/:id` in an iframe | play inside Confluence, SharePoint, a web page | VideoPlayer only, restricted-video message | F, P |
| S21 | Settings | `/settings` | profile, notification preferences, recording defaults | form, Toggle | F |
| S22 | Upload a video | New video menu | upload an existing file instead of recording | dropzone, ProgressBar | L, X (too large, wrong type) |

## Flows

```
F01 Record and share a screen + camera video (the core loop)
    S03 -> S05 -> S06 -> S07 -> S08 -> S09 -> S10
    happy path clicks: 5 (New video, Start recording, pick a screen, Share, Stop). Link is on the clipboard with no extra click.
    edge: camera or mic permission denied; no camera; user cancels the browser picker; user ends capture
          from the browser's own "Stop sharing" bar; tab closed or browser crashes mid-recording;
          network drops mid-upload; very long recording (2 h check-in); a second recording tab open;
          Firefox or Safari (recording unsupported in Loom too); window or tab capture with the bubble
          hidden behind other apps
F02 Fix a take while recording
    S08 pause -> resume -> Stop  |  S08 restart (confirm) -> S07  |  S08 delete (confirm) -> S03
    happy path clicks: 2 for pause and resume
    edge: restart after a long take (confirm before discarding); pause for a long time
F03 Watch a shared video and respond
    link -> S01 (if signed out) -> S12 -> play -> react -> pause -> comment at the timestamp
    happy path clicks: 4 (play, emoji, pause, send comment), plus typing
    edge: no access (S13); video still processing; comments or reactions turned off; very long comment;
          seeking to a comment's timestamp; slow network (lower quality); mobile width
F04 Reply to a comment
    email or S16 -> S10 at the comment's timestamp -> reply -> send
    happy path clicks: 3
    edge: comment deleted meanwhile; reply to a reply; @mention someone without access
F05 See who watched
    S03 -> S10 -> Activity tab (S15)
    happy path clicks: 2
    edge: no views yet; only anonymous views; owner's own views must not count
F06 Share with specific people or change access
    S10 -> Share (S11) -> set access -> add emails -> send
    happy path clicks: 4, plus typing
    edge: person not in the ATCON tenant; changing from workspace to specific people while
          viewers have the link open; share at a timestamp
F07 Turn off comments or reactions on one video
    S10 -> Settings tab (S14) -> toggle
    happy path clicks: 2
    edge: turning reactions off hides existing ones (Loom behaviour)
F08 Organise the library
    S03 -> create folder -> move video (menu) -> rename -> archive -> S18 restore -> delete
    happy path clicks: 3 per action
    edge: delete is permanent (confirm); deleting a folder that has videos; duplicate names; search with no results
F09 Find a video by what was said
    S03 search -> results include transcript matches -> S10 seeks to the phrase
    happy path clicks: 1, plus typing
    edge: transcript not ready yet; no speech in the video
F10 Read along with the transcript
    S12 -> Transcript tab -> click a line -> player seeks; captions toggle in the player
    happy path clicks: 2
    edge: transcript failed; non-English speech
F11 Save for later
    S12 -> Watch later -> S19
    happy path clicks: 1
F12 Embed a video in another tool
    S10 -> Share -> Embed tab -> copy code -> paste into Confluence or SharePoint -> S20
    happy path clicks: 3
    edge: restricted video inside an embed (viewer identity unknown)
F13 Download a video
    S10 -> menu -> Download MP4
    happy path clicks: 2
    edge: downloads disabled on the video; video still processing
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Button | primary, secondary, ghost, danger | default, hover, active, focus-visible, disabled, loading | all |
| IconButton | default, toggle | default, hover, pressed, focus-visible, disabled | S08, S10, S12 |
| New video button | primary with menu (record, upload) | default, open | S02, S03, S04 |
| Select / device picker | camera, mic, access level | closed, open, disabled, no options | S05, S11 |
| Segmented control | 2 to 4 options | selected, focus | S05 |
| Toggle switch | on, off | default, focus, disabled | S05, S14, S21 |
| AudioLevelMeter | horizontal | silent, active, muted | S05 |
| Countdown overlay | 3 s | counting | S07 |
| RecordingControlBar | expanded, collapsed | recording, paused, near limit | S08 |
| CameraBubble | circle, squircle, landscape, portrait; 5 sizes | dragging, snapped, hidden, fullscreen | S05, S08 |
| Modal / Dialog | default, confirm (danger) | open, submitting | S11, S08 (restart, delete), S03 (delete) |
| Tabs | top, side panel | selected, focus | S10, S11, S16 |
| VideoCard | grid, list | default, hover (preview), processing, selected | S02, S03, S04, S17, S18, S19 |
| FolderCard | grid | default, hover, renaming | S03 |
| SearchInput | default | empty, typing, results, no results | S03 |
| Menu (kebab) | video actions, folder actions | open, item disabled | S03, S10 |
| VideoPlayer | full page, embed | loading, playing, paused, buffering, ended, error | S10, S12, S20 |
| Timeline with markers | reactions, comments | hover expands a comment | S10, S12 |
| EmojiReactionBar | default | idle, reacted (animation), disabled | S12 |
| CommentThread | top-level, reply | default, own (edit, delete), deleted | S10, S12, S16 |
| CommentComposer | with timestamp chip, @mention | empty, typing, sending, error | S10, S12 |
| TranscriptPanel | default | loading, ready, failed, searching | S10, S12 |
| Avatar / AvatarStack | single, stack with "+N", anonymous | default | S10, S15 |
| Toast | success, error | shown, dismissed | S09, S11 |
| ProgressBar | determinate, indeterminate | progress, error | S09, S22 |
| EmptyState | with action, without | default | S02, S03, S13, S15, S16, S17, S18, S19 |
| Skeleton | card, row, player | loading | S02, S03, S10 |
| SidebarNav | expanded, collapsed (mobile drawer) | item active | all signed-in pages |
| Breadcrumbs | default | default | S04 |
| PasswordGate | default | default, wrong password | S13 |

## Inferred data model

```
User         id, entra_object_id, name, email, avatar_url, role (admin | member), created_at
             evidence: sign-in articles, "understand workspaces, roles and permissions", S15 named viewers
             confidence: high (Entra as identity is our choice, not Loom's default)

Workspace    id, name, default_privacy, allowed_email_domains
             evidence: "default privacy settings", "share with workspace members", custom domains rule
             confidence: medium. For an internal tool there is one workspace: ATCON.

Folder       id, owner_id, parent_id (nullable), name, created_at
             evidence: "organize your library folders", S04
             confidence: high for folders, guess for nesting

Video        id, owner_id, folder_id (nullable), title, duration_ms,
             status (recording | uploading | processing | ready | failed),
             source_mode (screen_camera | screen | camera), width, height,
             privacy (workspace | specific_people | anyone_with_link), password_hash (nullable),
             comments_enabled, notify_on_comment, reactions_enabled, show_view_count,
             downloads_enabled, transcript_enabled, recommended_speed,
             thumbnail_key, gif_key, original_key, rendition_keys,
             archived_at (nullable), created_at, updated_at
             evidence: S09-S14, video settings article, encoding article, manage-videos article
             confidence: high for settings and privacy; medium for storage fields

VideoShare   video_id, user_id or email, role (view | edit), created_at
             evidence: "share with workspace members" (view or edit), "only people added can access"
             confidence: high

Comment      id, video_id, author_id, parent_id (nullable), body, timestamp_ms, created_at,
             edited_at (guess), deleted_at (guess)
             evidence: timestamped comments, replies, @mentions
             confidence: high for core fields, guess for edit and delete

Reaction     id, video_id, user_id (nullable), anon_name (nullable), emoji, timestamp_ms, created_at
             evidence: timeline reactions, "anonymous" reactions, last 50 shown
             confidence: high

View         id, video_id, viewer_id (nullable), anon_id (cookie), started_at,
             watched_ms, counted (5 s, 75 %, or ended), completed
             evidence: views-and-analytics article (counting rule, owner excluded, cookie-blocked excluded)
             confidence: high for the rule, medium for fields

Transcript   video_id, language, segments (json: start_ms, end_ms, text), status
             evidence: transcript article (timestamps, click to seek, search)
             confidence: high

Notification id, user_id, type (comment | reply | mention | share), video_id, comment_id, read_at, created_at
             evidence: notifications page article
             confidence: medium

Follow       user_id, video_id
             evidence: "follow a Loom to get notified of new comments"
             confidence: medium

WatchLater   user_id, video_id, created_at
             evidence: watch-later article
             confidence: high
```

Relationships: User 1-n Video, User 1-n Folder, Folder 1-n Video, Video 1-n VideoShare, Video 1-n Comment, Comment 1-n Comment (replies), Video 1-n Reaction, Video 1-n View, Video 1-1 Transcript, User n-n Video via Follow and WatchLater.

## Feature matrix

See `features.csv`. Must: 22, should: 16, could: 20, skip: 13.

## Out of scope (cannot or should not be cloned)

- **Loom AI**: auto titles, summaries, chapters, tasks, filler-word removal, meeting notes, record for agents. Out of the agreed slice, not impossible. A later slice could do it inside ATCON's Azure tenant.
- **Desktop app and Chrome extension**: out of the agreed slice (web only). A pure web page cannot show the camera bubble over other apps the way the desktop app does; see hard part 1.
- **Teams slice**: spaces, all-company space, roles beyond admin and member, admin insights, activity log, SCIM.
- **Meeting recorder** (the notetaker that joins calls), Zoom import, Rewatch migration.
- **The Atlassian network**: Jira, Confluence and Atlassian search integration, Slack, Salesforce, Gmail, Calendly, Teams apps, the MCP tools. Our clone can still be embedded by link.
- **Plans and billing**: internal tool, no tiers, no 5-minute or 25-video limits.
- **Mobile apps** (iOS, Android).
- **Loom's content and users**: Community Looms, trending across Loom's user base. Our Home feed can only show ATCON's own videos.
- **Their look**: player chrome, purple brand, icons, copy. Rebuilt fresh in replica-design and replica-brand.

## Size

Screens 22, flows 13, entities 11.

Hard parts:

1. **The camera bubble in a web-only recorder.** The browser captures the screen and the camera as two streams. To get the bubble into the video, both must be drawn onto a canvas every frame and the canvas recorded. And so the user can see their own bubble while working in another app, the bubble needs a floating window (Chrome's Document Picture-in-Picture API, Chrome and Edge only). Get this wrong and it's either no bubble or a bubble nobody can see.
2. **The instant link.** Loom's link is ready the moment you stop because it uploads while you record. That means chunked upload during recording, resumable after a network drop, then server-side processing: browser WebM files have no duration or seek index, so they must be repaired and re-encoded (MP4 or HLS) before the player can seek properly.
3. **Recording that never loses a take.** Pause and resume, restart, the browser's own "Stop sharing" bar, a closed tab, a crash. Chunks already uploaded must survive, and an orphaned upload must be finished or cleaned up.
4. **Honest view counts.** The 5 s / 75 % / ended rule, anonymous viewers by cookie, owner views excluded, without counting every refresh.
5. **Transcripts with EU data residency.** Speech-to-text has to run in an EU region on ATCON's own Azure, because the videos hold faces, voices and whatever is on screen (personal data under GDPR).

Size: **M** (a few weeks) for the 22 must-haves. Adding the should-haves (transcripts, captions, notifications, mentions, downloads) pushes it towards the top of M.
