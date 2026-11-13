import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

import {
  api,
  ApiError,
  type Comment,
  downloadVideo,
  EMOJIS,
  type Folder,
  isOffline,
  mediaUrl,
  playedDurationMs,
  playWindow,
  type Reaction,
  shareUrl,
  shareUrlAt,
  type Video,
} from '../api/client';
import { Comments } from '../components/Comments';
import {
  IconArchive,
  IconBell,
  IconCheck,
  IconClock,
  IconCopy,
  IconDownload,
  IconLink,
  IconMore,
  IconMove,
  IconRestore,
  IconScissors,
  IconTrash,
  IconWrench,
} from '../components/Icons';
import { MoveDialog } from '../components/LibraryDialogs';
import { TagEditor } from '../components/TagEditor';
import { TrimEditor, type TrimRange } from '../components/TrimEditor';
import { VideoSettings } from '../components/VideoSettings';
import { Insights } from '../components/Insights';
import { NamePrompt } from '../components/NamePrompt';
import { Player, type PlayerHandle } from '../components/Player';
import { ConfirmDialog, copyText, Menu, toast } from '../components/ui';
import { formatBytes, formatClock, formatWhen, plural } from '../lib/format';
import { displayName, useIsOwnerDevice, viewerId } from '../lib/identity';
import { recoverVideo } from '../lib/recover';
import { useActiveSession, useSessionState } from '../recorder/session';

const HEARTBEAT_MS = 5000;

export function VideoPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const owner = useIsOwnerDevice();
  const session = useActiveSession();
  const sessionState = useSessionState(session);
  const ownSession = sessionState?.videoId === id ? sessionState : null;

  const [video, setVideo] = useState<Video | null>(null);
  const [loadError, setLoadError] = useState<'missing' | 'offline' | 'error' | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [people, setPeople] = useState<string[]>([]);
  const [tab, setTab] = useState<'comments' | 'activity' | 'settings'>('comments');
  const [theater, setTheater] = useState(() => {
    try {
      return localStorage.getItem('loom-clone.theater') === '1';
    } catch {
      return false;
    }
  });
  const toggleTheater = () =>
    setTheater((on) => {
      try {
        localStorage.setItem('loom-clone.theater', on ? '0' : '1');
      } catch {
        /* the choice just isn't remembered */
      }
      return !on;
    });
  const [linkPending, setLinkPending] = useState(params.get('copy') === '1');
  const [nameOpen, setNameOpen] = useState(false);
  const [trimDraft, setTrimDraft] = useState<TrimRange | null>(null);
  const [trimBusy, setTrimBusy] = useState(false);
  const [moveFolders, setMoveFolders] = useState<Folder[] | null>(null);
  // ?t=83 (seconds, file time): a link shared at a timestamp starts there.
  const [initialMs] = useState(() => {
    const t = Number(params.get('t'));
    return Number.isFinite(t) && t > 0 ? t * 1000 : undefined;
  });
  const nameResolver = useRef<((name: string | null) => void) | null>(null);
  const player = useRef<PlayerHandle>(null);

  const loadVideo = useCallback(async () => {
    try {
      const v = await api.getVideo(id, viewerId());
      setVideo(v);
      setLoadError(null);
      return v;
    } catch (error) {
      setLoadError(error instanceof ApiError && error.status === 404 ? 'missing' : isOffline(error) ? 'offline' : 'error');
      return null;
    }
  }, [id]);

  const loadSocial = useCallback(async () => {
    const [c, r] = await Promise.all([api.listComments(id), api.listReactions(id)]).catch(() => [null, null]);
    if (c) setComments(c);
    if (r) setReactions(r);
    api.listPeople(id).then(setPeople, () => {});
  }, [id]);

  useEffect(() => {
    setVideo(null);
    setComments([]);
    setReactions([]);
    void loadVideo();
    void loadSocial();
  }, [loadVideo, loadSocial]);

  // While the take is still uploading (or someone else is recording it), check back.
  const status = video?.status;
  useEffect(() => {
    if (status !== 'recording') return;
    const timer = setInterval(() => void loadVideo(), ownSession ? 700 : 2500);
    return () => clearInterval(timer);
  }, [status, ownSession, loadVideo]);

  useEffect(() => {
    if (ownSession?.phase === 'done') void loadVideo();
  }, [ownSession?.phase, loadVideo]);

  // Comments and reactions from other viewers show up when you come back to the tab.
  useEffect(() => {
    const onFocus = () => void loadSocial();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadSocial]);

  // ?copy=1: the take ended from the browser's Stop sharing bar, outside a click on this page.
  useEffect(() => {
    if (!linkPending) return;
    void copyText(shareUrl(id)).then((ok) => {
      if (ok) {
        toast('Link copied');
        setLinkPending(false);
      }
    });
    setParams((p) => {
      p.delete('copy');
      return p;
    }, { replace: true });
  }, [linkPending, id, setParams]);

  // ---- view counting (viewers only) --------------------------------------------------------

  const pendingMs = useRef(0);
  const lastPos = useRef(0);
  const sendView = useCallback(
    (ended = false) => {
      if (owner || !video || video.status !== 'ready') return;
      if (pendingMs.current <= 0 && !ended) return;
      const deltaMs = Math.round(pendingMs.current);
      pendingMs.current = 0;
      void api
        .sendView(id, {
          viewerId: viewerId(),
          viewerName: displayName(),
          deltaMs,
          positionMs: Math.round(lastPos.current),
          ended,
        })
        .catch(() => {
          pendingMs.current += deltaMs;
        });
    },
    [owner, video, id],
  );

  useEffect(() => {
    const timer = setInterval(() => sendView(), HEARTBEAT_MS);
    const onHide = () => sendView();
    window.addEventListener('pagehide', onHide);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', onHide);
      sendView();
    };
  }, [sendView]);

  // ---- name gate ---------------------------------------------------------------------------

  const requireName = useCallback((): Promise<string | null> => {
    const known = displayName();
    if (known) return Promise.resolve(known);
    setNameOpen(true);
    return new Promise((resolve) => {
      nameResolver.current = resolve;
    });
  }, []);

  async function toggleFollow() {
    if (!video) return;
    const on = !!video.following;
    setVideo({ ...video, following: !on });
    try {
      if (on) await api.unfollow(video.id, viewerId());
      else await api.follow(video.id, viewerId());
      toast(on ? 'You will not hear about new comments' : 'You will be told about new comments');
    } catch {
      setVideo({ ...video, following: on });
      toast('That did not save', 'error');
    }
  }

  async function toggleWatchLater() {
    if (!video) return;
    const saved = !!video.watchLater;
    setVideo({ ...video, watchLater: !saved });
    try {
      if (saved) await api.removeWatchLater(video.id, viewerId());
      else await api.addWatchLater(video.id, viewerId());
      toast(saved ? 'Removed from Watch later' : 'Saved to Watch later');
    } catch {
      setVideo({ ...video, watchLater: saved });
      toast('That did not save', 'error');
    }
  }

  async function saveTrim(range: TrimRange | null) {
    if (!video) return;
    setTrimBusy(true);
    try {
      const updated = await api.patchVideo(video.id, {
        trimStartMs: range ? range.startMs : null,
        trimEndMs: range ? range.endMs : null,
      });
      setVideo({ ...updated, watchLater: video.watchLater });
      setTrimDraft(null);
      toast(range && updated.trimStartMs !== null ? 'Trim saved' : 'Back to the original');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The trim was not saved', 'error');
    } finally {
      setTrimBusy(false);
    }
  }

  async function react(emoji: string) {
    if (!video) return;
    const name = await requireName();
    if (!name) return;
    const timestampMs = Math.round(player.current?.currentMs() ?? 0);
    player.current?.float(emoji, name);
    try {
      const r = await api.addReaction(video.id, { authorId: viewerId(), authorName: name, emoji, timestampMs });
      setReactions((list) => [...list, r]);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'The reaction was not saved', 'error');
    }
  }

  // ---- render ------------------------------------------------------------------------------

  if (loadError === 'missing')
    return (
      <main className="page">
        <div className="empty">
          <h2>This video isn't here</h2>
          <p>It was deleted, or the link is wrong.</p>
          {owner && (
            <Link className="btn" to="/">
              Go to your library
            </Link>
          )}
        </div>
      </main>
    );

  return (
    <main className="page">
      {loadError === 'offline' && <OfflineBanner />}
      {linkPending && video && (
        <div className="banner is-info" role="status">
          <span style={{ flex: 1 }}>Your video is ready to share.</span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              void copyText(shareUrl(id)).then((ok) => {
                toast(ok ? 'Link copied' : 'Copy failed. Select the address bar and copy it from there.', ok ? 'success' : 'error');
                if (ok) setLinkPending(false);
              })
            }
          >
            <IconLink />
            Copy link
          </button>
        </div>
      )}
      {ownSession && session?.replyTo && ownSession.replyPosted !== null && (
        <div className={ownSession.replyPosted ? "banner is-info" : "banner is-danger"} role="status">
          <span style={{ flex: 1 }}>
            {ownSession.replyPosted
              ? `Posted as a video reply on "${session.replyTo.title}".`
              : `This video is saved, but it could not be posted as a reply on "${session.replyTo.title}".`}
          </span>
          <Link className="btn" to={`/v/${session.replyTo.videoId}`}>
            Back to that video
          </Link>
        </div>
      )}
      {video?.archivedAt && owner && (
        <div className="banner" role="status">
          <span style={{ flex: 1 }}>This video is archived. It is hidden from your library but the link still works.</span>
          <button
            type="button"
            className="btn"
            onClick={async () => setVideo(await api.patchVideo(id, { archived: false }))}
          >
            <IconRestore />
            Restore
          </button>
        </div>
      )}

      <div className={theater ? 'watch is-theater' : 'watch'}>
        <div className="watch-main">
          {!video ? (
            <div className="player skeleton" aria-busy="true" aria-label="Loading video" />
          ) : video.status === 'ready' ? (
            <Player
              ref={player}
              src={mediaUrl(video.id)}
              fallbackDurationMs={video.durationMs}
              windowStartMs={(trimDraft ?? playWindow(video)).startMs}
              windowEndMs={trimDraft ? trimDraft.endMs : video.trimEndMs}
              initialMs={initialMs}
              initialRate={owner ? undefined : (video.recommendedSpeed ?? undefined)}
              theater={theater}
              onToggleTheater={toggleTheater}
              comments={comments}
              reactions={video.reactionsEnabled ? reactions : []}
              onWatch={(delta, pos) => {
                pendingMs.current += delta;
                lastPos.current = pos;
              }}
              onEnded={(pos) => {
                lastPos.current = pos;
                sendView(true);
              }}
            />
          ) : (
            <NotReady video={video} owner={owner} ownSession={ownSession} onRecovered={setVideo} onRetry={() => void session?.finish()} />
          )}

          {video && trimDraft && video.durationMs && (
            <TrimEditor
              durationMs={video.durationMs}
              value={trimDraft}
              trimmed={video.trimStartMs !== null}
              busy={trimBusy}
              onChange={setTrimDraft}
              onSeek={(ms) => player.current?.seek(ms)}
              onSave={() => void saveTrim(trimDraft)}
              onCancel={() => setTrimDraft(null)}
              onRevert={() => void saveTrim(null)}
            />
          )}

          {video && (
            <TitleRow
              video={video}
              owner={owner}
              onChanged={(v) => setVideo({ ...v, watchLater: video.watchLater, following: video.following })}
              onDeleted={() => navigate('/')}
              currentMs={() => player.current?.currentMs() ?? 0}
              onTrim={() => {
                const w = playWindow(video);
                setTrimDraft({ startMs: w.startMs, endMs: w.endMs ?? video.durationMs ?? 0 });
              }}
              onMove={async () => {
                try {
                  setMoveFolders(await api.listFolders());
                } catch {
                  toast('Folders could not be loaded', 'error');
                }
              }}
              onDuplicated={(copy) => navigate(`/v/${copy.id}`)}
            />
          )}

          {video?.status === 'ready' && (
            <div className="under-player">
              {video.reactionsEnabled ? (
                <div className="reaction-bar" role="group" aria-label="React at this moment">
                  {EMOJIS.map((e) => (
                    <button key={e} type="button" onClick={() => void react(e)} aria-label={`React ${e}`}>
                      {e}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="muted">Reactions are turned off for this video.</p>
              )}
              <span className="chip-row">
                {!owner && (
                  <button type="button" className="btn" aria-pressed={!!video.following} onClick={() => void toggleFollow()}>
                    {video.following ? <IconCheck /> : <IconBell />}
                    {video.following ? 'Following' : 'Follow'}
                  </button>
                )}
                {!owner && video.downloadsEnabled && (
                  <button type="button" className="btn" onClick={() => downloadVideo(video.id, viewerId())}>
                    <IconDownload />
                    Download
                  </button>
                )}
                <button type="button" className="btn" aria-pressed={!!video.watchLater} onClick={() => void toggleWatchLater()}>
                  {video.watchLater ? <IconCheck /> : <IconClock />}
                  {video.watchLater ? 'Saved for later' : 'Watch later'}
                </button>
              </span>
            </div>
          )}
        </div>

        <aside className="side" aria-label="Comments and activity">
          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'comments'} onClick={() => setTab('comments')}>
              Comments{comments.length ? ` (${comments.filter((c) => !c.deleted).length})` : ''}
            </button>
            {owner && (
              <button type="button" role="tab" aria-selected={tab === 'activity'} onClick={() => setTab('activity')}>
                Activity
              </button>
            )}
            {owner && (
              <button type="button" role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>
                Settings
              </button>
            )}
          </div>
          <div className="tab-panel" role="tabpanel">
            {tab === 'settings' && owner && video ? (
              <VideoSettings
                video={video}
                onVideoChanged={(v) => setVideo({ ...v, watchLater: video.watchLater, following: video.following })}
                grabFrame={() => player.current?.snapshot() ?? Promise.resolve(null)}
              />
            ) : tab === 'activity' && owner && video ? (
              <Insights video={video} reactions={reactions} onSeek={(ms) => player.current?.seek(ms)} />
            ) : video?.status === 'ready' ? (
              <Comments
                videoId={id}
                offsetMs={(trimDraft ?? playWindow(video)).startMs}
                people={people}
                comments={comments}
                enabled={video.commentsEnabled}
                ownerDevice={owner}
                currentMs={() => player.current?.currentMs() ?? 0}
                onSeek={(ms) => player.current?.seek(ms, true)}
                requireName={requireName}
                onChanged={() => {
                  void loadSocial();
                  // Commenting follows the video on the server; show it here too.
                  void loadVideo();
                }}
              />
            ) : (
              <p className="muted">Comments open once the video is ready.</p>
            )}
          </div>
        </aside>
      </div>

      {video && (
        <MoveDialog
          video={moveFolders ? video : null}
          folders={moveFolders ?? []}
          onClose={() => setMoveFolders(null)}
          onMoved={(v, name) => {
            setMoveFolders(null);
            setVideo({ ...v, watchLater: video.watchLater });
            toast(name ? `Moved to ${name}` : 'Moved to My videos');
          }}
        />
      )}

      <NamePrompt
        open={nameOpen}
        onDone={(name) => {
          setNameOpen(false);
          nameResolver.current?.(name);
          nameResolver.current = null;
        }}
      />
    </main>
  );
}

function OfflineBanner() {
  return (
    <div className="banner is-danger" role="alert">
      The local server on port 7310 isn't answering. Start it with scripts\start.ps1, then reload.
    </div>
  );
}

function NotReady({
  video,
  owner,
  ownSession,
  onRecovered,
  onRetry,
}: {
  video: Video;
  owner: boolean;
  ownSession: ReturnType<typeof useSessionState>;
  onRecovered: (v: Video) => void;
  onRetry: () => void;
}) {
  const [recovering, setRecovering] = useState(false);
  const [recoverError, setRecoverError] = useState<string | null>(null);

  if (ownSession && ownSession.phase !== 'failed') {
    const p = ownSession.progress;
    const pct = p && p.bytes > 0 ? Math.round((p.uploadedBytes / p.bytes) * 100) : null;
    return (
      <div className="player" aria-live="polite">
        <div className="player-message">
          <strong>Finishing your video…</strong>
          <div className={pct === null || pct >= 100 ? 'progress is-indeterminate' : 'progress'}>
            <span style={pct === null || pct >= 100 ? undefined : { width: `${pct}%` }} />
          </div>
          <span>
            {p && p.uploaded < p.chunks
              ? `Uploading ${formatBytes(p.bytes - p.uploadedBytes)} more`
              : 'Making it seekable. The link already works.'}
          </span>
        </div>
      </div>
    );
  }

  if (ownSession?.phase === 'failed')
    return (
      <div className="player">
        <div className="player-message" role="alert">
          <strong>The upload didn't finish.</strong>
          <span>{ownSession.error} Nothing is lost: the recording is still in this tab.</span>
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );

  if (!owner)
    return (
      <div className="player">
        <div className="player-message">
          <strong>This video is still being recorded.</strong>
          <span>It plays here as soon as it is finished.</span>
          <div className="progress is-indeterminate">
            <span />
          </div>
        </div>
      </div>
    );

  return (
    <div className="player">
      <div className="player-message" role="status">
        <strong>This recording didn't finish.</strong>
        <span>The tab closed or the browser stopped before Stop was pressed. What was saved can be recovered.</span>
        {recoverError && <span role="alert">{recoverError}</span>}
        <button
          type="button"
          className="btn btn-primary"
          disabled={recovering}
          onClick={async () => {
            setRecovering(true);
            setRecoverError(null);
            try {
              onRecovered(await recoverVideo(video.id));
              toast('Recording recovered');
            } catch (error) {
              setRecoverError(error instanceof Error ? error.message : 'Recovery failed.');
            } finally {
              setRecovering(false);
            }
          }}
        >
          <IconWrench />
          {recovering ? 'Recovering…' : 'Recover recording'}
        </button>
      </div>
    </div>
  );
}

function TitleRow({
  video,
  owner,
  onChanged,
  onDeleted,
  currentMs,
  onTrim,
  onMove,
  onDuplicated,
}: {
  video: Video;
  owner: boolean;
  onChanged: (v: Video) => void;
  onDeleted: () => void;
  currentMs: () => number;
  onTrim: () => void;
  onMove: () => void;
  onDuplicated: (copy: Video) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(video.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  async function saveTitle() {
    const title = draft.trim();
    setEditing(false);
    if (!title || title === video.title) {
      setDraft(video.title);
      return;
    }
    try {
      onChanged(await api.patchVideo(video.id, { title }));
    } catch {
      toast('The title was not saved', 'error');
      setDraft(video.title);
    }
  }

  async function copyLink() {
    const ok = await copyText(shareUrl(video.id));
    toast(ok ? 'Link copied' : 'Copy failed', ok ? 'success' : 'error');
  }

  async function copyLinkAtTime() {
    const at = currentMs();
    const shownAt = formatClock(Math.max(0, at - playWindow(video).startMs));
    const ok = await copyText(shareUrlAt(video.id, at));
    toast(ok ? `Link copied: starts at ${shownAt}` : 'Copy failed', ok ? 'success' : 'error');
  }

  async function duplicate() {
    try {
      const copy = await api.duplicateVideo(video.id);
      toast('Duplicated. This is the copy.');
      onDuplicated(copy);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The video was not duplicated', 'error');
    }
  }

  const ready = video.status === 'ready';

  return (
    <div>
      <div className="title-row">
        {owner && editing ? (
          <input
            className="title-input"
            aria-label="Video title"
            value={draft}
            maxLength={200}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                setDraft(video.title);
                setEditing(false);
              }
            }}
          />
        ) : owner ? (
          <h1>
            <button
              type="button"
              className="title-button"
              onClick={() => {
                setDraft(video.title);
                setEditing(true);
              }}
              title="Rename"
            >
              {video.title}
            </button>
          </h1>
        ) : (
          <h1>{video.title}</h1>
        )}
        <button type="button" className="btn btn-primary" onClick={copyLink}>
          <IconLink />
          Copy link
        </button>
        {ready && (
          <Menu
            label="Share options"
            triggerClassName="btn"
            trigger={<IconClock />}
            items={[{ label: 'Copy link at the current time', icon: <IconClock />, onSelect: () => void copyLinkAtTime() }]}
          />
        )}
        {owner && (
          <Menu
            label="More actions"
            trigger={<IconMore />}
            items={[
              ...(ready
                ? [
                    { label: video.trimStartMs !== null ? 'Edit trim' : 'Trim', icon: <IconScissors />, onSelect: onTrim },
                    { label: 'Move to folder', icon: <IconMove />, onSelect: onMove },
                    { label: 'Duplicate', icon: <IconCopy />, onSelect: () => void duplicate() },
                    { label: 'Download', icon: <IconDownload />, onSelect: () => downloadVideo(video.id, viewerId()) },
                  ]
                : []),
              video.archivedAt
                ? {
                    label: 'Restore',
                    icon: <IconRestore />,
                    onSelect: async () => onChanged(await api.patchVideo(video.id, { archived: false })),
                  }
                : {
                    label: 'Archive',
                    icon: <IconArchive />,
                    onSelect: async () => {
                      onChanged(await api.patchVideo(video.id, { archived: true }));
                      toast('Archived');
                    },
                  },
              { label: 'Delete…', icon: <IconTrash />, danger: true, onSelect: () => setConfirmDelete(true) },
            ]}
          />
        )}
      </div>
      <div className="meta-row">
        <span>{formatWhen(video.createdAt)}</span>
        {playedDurationMs(video) !== null && <span>{formatClock(playedDurationMs(video))}</span>}
        {owner && video.trimStartMs !== null && <span>Trimmed from {formatClock(video.durationMs)}</span>}
        {owner && video.uploaded && <span>Uploaded</span>}
        {(owner || video.showViewCount) && <span>{plural(video.viewCount, 'view')}</span>}
        {owner && video.status === 'ready' && <span>{formatBytes(video.sizeBytes)}</span>}
        {owner && video.status === 'ready' && !video.seekable && <span>Seeking may be slow: the file could not be indexed.</span>}
      </div>

      <TagEditor video={video} owner={owner} onChanged={onChanged} />

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this video for good?"
        body={`"${video.title}" and its comments, reactions and views are removed from this computer. This can't be undone.`}
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={async () => {
          setBusy(true);
          try {
            await api.deleteVideo(video.id);
            toast('Video deleted');
            onDeleted();
          } catch {
            toast('The video was not deleted', 'error');
          } finally {
            setBusy(false);
            setConfirmDelete(false);
          }
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
