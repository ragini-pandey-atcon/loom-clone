import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

import { api, isOffline, shareUrl, thumbnailUrl, type Video } from '../api/client';
import {
  IconArchive,
  IconComment,
  IconEye,
  IconLink,
  IconMore,
  IconPencil,
  IconRecord,
  IconRestore,
  IconSearch,
  IconTrash,
  IconVideo,
  IconWrench,
} from '../components/Icons';
import { ConfirmDialog, copyText, Menu, type MenuItem, toast } from '../components/ui';
import { formatClock, formatWhen } from '../lib/format';
import { claimOwnerDevice } from '../lib/identity';
import { recoverVideo } from '../lib/recover';
import { activeSession, isBusy } from '../recorder/session';

export function LibraryPage({ archived }: { archived: boolean }) {
  const [query, setQuery] = useState('');
  const [videos, setVideos] = useState<Video[] | null>(null);
  const [error, setError] = useState<'offline' | 'error' | null>(null);
  const [renaming, setRenaming] = useState<Video | null>(null);
  const [deleting, setDeleting] = useState<Video | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    claimOwnerDevice();
  }, []);

  const load = useCallback(async () => {
    const mine = ++requestId.current;
    try {
      const list = await api.listVideos({ q: query.trim(), archived });
      if (mine === requestId.current) {
        setVideos(list);
        setError(null);
      }
    } catch (e) {
      if (mine === requestId.current) setError(isOffline(e) ? 'offline' : 'error');
    }
  }, [query, archived]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 200 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  useEffect(() => {
    setVideos(null);
    setQuery('');
  }, [archived]);

  useEffect(() => {
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  async function patch(video: Video, body: Parameters<typeof api.patchVideo>[1], message: string) {
    try {
      await api.patchVideo(video.id, body);
      toast(message);
      await load();
    } catch {
      toast('That did not save', 'error');
    }
  }

  async function recover(video: Video) {
    toast('Recovering…');
    try {
      await recoverVideo(video.id);
      toast('Recording recovered');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Recovery failed', 'error');
    }
  }

  const recordingNow = isBusy(activeSession()) ? activeSession()?.getState().videoId : null;

  function itemsFor(video: Video): MenuItem[] {
    const unfinished = video.status === 'recording' && video.id !== recordingNow;
    const items: MenuItem[] = [];
    if (unfinished) items.push({ label: 'Recover', icon: <IconWrench />, onSelect: () => void recover(video) });
    items.push(
      {
        label: 'Copy link',
        icon: <IconLink />,
        onSelect: () => void copyText(shareUrl(video.id)).then((ok) => toast(ok ? 'Link copied' : 'Copy failed', ok ? 'success' : 'error')),
      },
      { label: 'Rename', icon: <IconPencil />, onSelect: () => setRenaming(video) },
      archived
        ? { label: 'Restore', icon: <IconRestore />, onSelect: () => void patch(video, { archived: false }, 'Restored') }
        : { label: 'Archive', icon: <IconArchive />, onSelect: () => void patch(video, { archived: true }, 'Archived') },
      { label: 'Delete…', icon: <IconTrash />, danger: true, onSelect: () => setDeleting(video) },
    );
    return items;
  }

  return (
    <main className="page">
      <div className="page-head">
        <h1>{archived ? 'Archive' : 'My videos'}</h1>
        <div className="search" role="search">
          <IconSearch />
          <label className="sr-only" htmlFor="search">
            Search by title
          </label>
          <input
            id="search"
            className="input"
            type="search"
            placeholder="Search by title"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {error === 'offline' && (
        <div className="banner is-danger" role="alert">
          The local server on port 7310 isn't answering. Start it with scripts\start.ps1, then reload.
        </div>
      )}
      {error === 'error' && (
        <div className="banner is-danger" role="alert">
          The library could not be loaded.
        </div>
      )}

      {videos === null && !error ? (
        <div className="grid" aria-busy="true" aria-label="Loading videos">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="skeleton skeleton-card" />
          ))}
        </div>
      ) : videos && videos.length === 0 ? (
        query ? (
          <div className="empty">
            <h2>No titles match "{query}"</h2>
            <p>Check the spelling, or search for a shorter part of the title.</p>
            <button type="button" className="btn" onClick={() => setQuery('')}>
              Clear search
            </button>
          </div>
        ) : archived ? (
          <div className="empty">
            <h2>Nothing archived</h2>
            <p>Archive a video to hide it from your library without breaking its link.</p>
          </div>
        ) : (
          <div className="empty">
            <IconVideo style={{ width: 'var(--space-10)', height: 'var(--space-10)' }} />
            <h2>No videos yet</h2>
            <p>Record your screen and camera, then share the link. It is copied the moment you stop.</p>
            <Link className="btn btn-record btn-lg" to="/record">
              <IconRecord />
              Record your first video
            </Link>
          </div>
        )
      ) : (
        <div className="grid">
          {videos?.map((v) => (
            <VideoCard key={v.id} video={v} recordingNow={v.id === recordingNow} items={itemsFor(v)} />
          ))}
        </div>
      )}

      <RenameDialog
        video={renaming}
        onClose={() => setRenaming(null)}
        onSave={async (title) => {
          if (renaming) await patch(renaming, { title }, 'Renamed');
          setRenaming(null);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this video for good?"
        body={`"${deleting?.title ?? ''}" and its comments, reactions and views are removed from this computer. This can't be undone.`}
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={async () => {
          if (!deleting) return;
          setBusy(true);
          try {
            await api.deleteVideo(deleting.id);
            toast('Video deleted');
            await load();
          } catch {
            toast('The video was not deleted', 'error');
          } finally {
            setBusy(false);
            setDeleting(null);
          }
        }}
        onCancel={() => setDeleting(null)}
      />
    </main>
  );
}

function VideoCard({ video, recordingNow, items }: { video: Video; recordingNow: boolean; items: MenuItem[] }) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const unfinished = video.status === 'recording';
  return (
    <article className="card">
      <div className="card-thumb">
        {video.hasThumbnail && !thumbFailed ? (
          <img src={thumbnailUrl(video)} alt="" loading="lazy" onError={() => setThumbFailed(true)} />
        ) : (
          <div className="placeholder">
            <IconVideo />
          </div>
        )}
        {unfinished && <span className="badge is-warning">{recordingNow ? 'Recording now' : 'Unfinished'}</span>}
        {video.durationMs !== null && <span className="badge">{formatClock(video.durationMs)}</span>}
      </div>
      <div className="card-body">
        <div className="card-text">
          <Link className="card-title" to={`/v/${video.id}`}>
            {video.title}
          </Link>
          <div className="card-meta">
            {formatWhen(video.createdAt)} ·{' '}
            <span aria-label={`${video.viewCount} views`}>
              <IconEye width="1em" height="1em" style={{ verticalAlign: '-0.125em' }} /> {video.viewCount}
            </span>{' '}
            ·{' '}
            <span aria-label={`${video.commentCount} comments`}>
              <IconComment width="1em" height="1em" style={{ verticalAlign: '-0.125em' }} /> {video.commentCount}
            </span>
          </div>
        </div>
        <Menu label={`Actions for ${video.title}`} trigger={<IconMore />} items={items} />
      </div>
    </article>
  );
}

function RenameDialog({
  video,
  onClose,
  onSave,
}: {
  video: Video | null;
  onClose: () => void;
  onSave: (title: string) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (video && !dialog.open) {
      setValue(video.title);
      dialog.showModal();
    }
    if (!video && dialog.open) dialog.close();
  }, [video]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="rename-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) void onSave(value.trim());
        }}
      >
        <h2 id="rename-title">Rename video</h2>
        <div className="field">
          <label className="field-label" htmlFor="rename-input">
            Title
          </label>
          <input
            id="rename-input"
            className="input"
            value={value}
            maxLength={200}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}
