import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import {
  api,
  ApiError,
  downloadVideo,
  type Folder,
  isOffline,
  playedDurationMs,
  shareUrl,
  thumbnailUrl,
  uploadVideo,
  type Video,
} from '../api/client';
import {
  IconArchive,
  IconComment,
  IconCopy,
  IconDownload,
  IconEye,
  IconFolder,
  IconFolderPlus,
  IconLink,
  IconMore,
  IconMove,
  IconPencil,
  IconRecord,
  IconRestore,
  IconSearch,
  IconTrash,
  IconUpload,
  IconVideo,
  IconWrench,
} from '../components/Icons';
import { MoveDialog, TextDialog } from '../components/LibraryDialogs';
import { ConfirmDialog, copyText, Menu, type MenuItem, toast } from '../components/ui';
import { formatClock, formatWhen, plural } from '../lib/format';
import { claimOwnerDevice } from '../lib/identity';
import { probeVideo, titleFromFileName, UPLOAD_ACCEPT, uploadMimeType } from '../lib/probeVideo';
import { recoverVideo } from '../lib/recover';
import { activeSession, isBusy } from '../recorder/session';

type Dialog =
  | { kind: 'rename-video'; video: Video }
  | { kind: 'delete-video'; video: Video }
  | { kind: 'new-folder' }
  | { kind: 'rename-folder'; folder: Folder }
  | { kind: 'delete-folder'; folder: Folder }
  | null;

export function LibraryPage({ archived }: { archived: boolean }) {
  const { folderId } = useParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [videos, setVideos] = useState<Video[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folder, setFolder] = useState<Folder | null>(null);
  const [error, setError] = useState<'offline' | 'error' | 'no-folder' | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [moving, setMoving] = useState<Video | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);
  const atRoot = !archived && !folderId;

  useEffect(() => {
    claimOwnerDevice();
  }, []);

  const load = useCallback(async () => {
    const mine = ++requestId.current;
    try {
      const q = query.trim();
      // At the top level, videos in folders show inside their folder; a search looks everywhere.
      const scope = folderId ?? (atRoot && !q ? 'none' : undefined);
      const [list, allFolders, current] = await Promise.all([
        api.listVideos({ q, archived, folder: scope }),
        archived ? Promise.resolve([] as Folder[]) : api.listFolders(),
        folderId ? api.getFolder(folderId) : Promise.resolve(null),
      ]);
      if (mine !== requestId.current) return;
      setVideos(list);
      setFolders(allFolders);
      setFolder(current);
      setError(null);
    } catch (e) {
      if (mine !== requestId.current) return;
      setError(e instanceof ApiError && e.status === 404 ? 'no-folder' : isOffline(e) ? 'offline' : 'error');
    }
  }, [query, archived, folderId, atRoot]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 200 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  useEffect(() => {
    setVideos(null);
    setQuery('');
  }, [archived, folderId]);

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

  async function duplicate(video: Video) {
    try {
      await api.duplicateVideo(video.id);
      toast('Duplicated');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The video was not duplicated', 'error');
    }
  }

  const upload = useUploader(folderId, (video) => navigate(`/v/${video.id}`));

  const recordingNow = isBusy(activeSession()) ? activeSession()?.getState().videoId : null;

  function itemsFor(video: Video): MenuItem[] {
    const unfinished = video.status === 'recording' && video.id !== recordingNow;
    const ready = video.status === 'ready';
    const items: MenuItem[] = [];
    if (unfinished) items.push({ label: 'Recover', icon: <IconWrench />, onSelect: () => void recover(video) });
    items.push(
      {
        label: 'Copy link',
        icon: <IconLink />,
        onSelect: () => void copyText(shareUrl(video.id)).then((ok) => toast(ok ? 'Link copied' : 'Copy failed', ok ? 'success' : 'error')),
      },
      { label: 'Rename', icon: <IconPencil />, onSelect: () => setDialog({ kind: 'rename-video', video }) },
    );
    if (!archived) items.push({ label: 'Move to folder', icon: <IconMove />, onSelect: () => setMoving(video) });
    if (ready) {
      items.push(
        { label: 'Duplicate', icon: <IconCopy />, onSelect: () => void duplicate(video) },
        { label: 'Download', icon: <IconDownload />, onSelect: () => downloadVideo(video.id) },
      );
    }
    items.push(
      archived
        ? { label: 'Restore', icon: <IconRestore />, onSelect: () => void patch(video, { archived: false }, 'Restored') }
        : { label: 'Archive', icon: <IconArchive />, onSelect: () => void patch(video, { archived: true }, 'Archived') },
      { label: 'Delete…', icon: <IconTrash />, danger: true, onSelect: () => setDialog({ kind: 'delete-video', video }) },
    );
    return items;
  }

  const searching = query.trim().length > 0;
  const showFolders = atRoot && !searching && folders.length > 0;

  if (error === 'no-folder')
    return (
      <main className="page">
        <div className="empty">
          <h2>This folder isn't here</h2>
          <p>It was deleted. Its videos are back in My videos.</p>
          <Link className="btn" to="/">
            Go to My videos
          </Link>
        </div>
      </main>
    );

  return (
    <main className="page">
      <div className="page-head">
        {folderId ? (
          <div className="crumbs">
            <Link to="/">My videos</Link>
            <span aria-hidden="true">/</span>
            <h1>{folder?.name ?? '…'}</h1>
            {folder && (
              <Menu
                label={`Actions for folder ${folder.name}`}
                trigger={<IconMore />}
                items={[
                  { label: 'Rename folder', icon: <IconPencil />, onSelect: () => setDialog({ kind: 'rename-folder', folder }) },
                  { label: 'Delete folder…', icon: <IconTrash />, danger: true, onSelect: () => setDialog({ kind: 'delete-folder', folder }) },
                ]}
              />
            )}
          </div>
        ) : (
          <h1>{archived ? 'Archive' : 'My videos'}</h1>
        )}
        <div className="head-actions">
          <div className="search" role="search">
            <IconSearch />
            <label className="sr-only" htmlFor="search">
              Search by title
            </label>
            <input
              id="search"
              className="input"
              type="search"
              placeholder={folderId ? 'Search this folder' : 'Search by title'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {atRoot && (
            <button type="button" className="btn" onClick={() => setDialog({ kind: 'new-folder' })}>
              <IconFolderPlus />
              New folder
            </button>
          )}
          {!archived && (
            <button type="button" className="btn" onClick={upload.pick} disabled={upload.progress !== null}>
              <IconUpload />
              Upload
            </button>
          )}
          {upload.input}
        </div>
      </div>

      {upload.progress !== null && (
        <div className="banner is-info" role="status">
          <span style={{ flex: 1 }}>
            {upload.progress < 0 ? 'Reading the video…' : `Uploading ${upload.name}: ${Math.round(upload.progress * 100)}%`}
          </span>
          <div className="progress" style={{ width: '12rem' }}>
            <span style={{ width: `${Math.max(0, upload.progress) * 100}%` }} />
          </div>
        </div>
      )}
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

      {showFolders && (
        <section aria-labelledby="folders-title" className="folders">
          <h2 id="folders-title" className="section-title">
            Folders
          </h2>
          <div className="folder-grid">
            {folders.map((f) => (
              <div key={f.id} className="folder-card">
                <Link to={`/folders/${f.id}`} className="folder-link">
                  <IconFolder />
                  <span className="folder-name">{f.name}</span>
                  <span className="muted">{plural(f.videoCount, 'video')}</span>
                </Link>
                <Menu
                  label={`Actions for folder ${f.name}`}
                  trigger={<IconMore />}
                  items={[
                    { label: 'Rename folder', icon: <IconPencil />, onSelect: () => setDialog({ kind: 'rename-folder', folder: f }) },
                    { label: 'Delete folder…', icon: <IconTrash />, danger: true, onSelect: () => setDialog({ kind: 'delete-folder', folder: f }) },
                  ]}
                />
              </div>
            ))}
          </div>
          <h2 className="section-title">Videos</h2>
        </section>
      )}

      {videos === null && !error ? (
        <div className="grid" aria-busy="true" aria-label="Loading videos">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="skeleton skeleton-card" />
          ))}
        </div>
      ) : videos && videos.length === 0 ? (
        searching ? (
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
        ) : folderId ? (
          <div className="empty">
            <IconFolder style={{ width: 'var(--space-10)', height: 'var(--space-10)' }} />
            <h2>This folder is empty</h2>
            <p>Use Move to folder on any video, or upload one straight into this folder.</p>
          </div>
        ) : folders.length > 0 ? (
          <p className="muted">Every video is in a folder.</p>
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
            <VideoCard
              key={v.id}
              video={v}
              recordingNow={v.id === recordingNow}
              items={itemsFor(v)}
              folderName={searching && atRoot ? folders.find((f) => f.id === v.folderId)?.name : undefined}
            />
          ))}
        </div>
      )}

      <TextDialog
        open={dialog?.kind === 'rename-video'}
        title="Rename video"
        label="Title"
        initial={dialog?.kind === 'rename-video' ? dialog.video.title : ''}
        submitLabel="Save"
        maxLength={200}
        onClose={() => setDialog(null)}
        onSave={async (title) => {
          if (dialog?.kind === 'rename-video') await patch(dialog.video, { title }, 'Renamed');
          setDialog(null);
        }}
      />
      <TextDialog
        open={dialog?.kind === 'new-folder' || dialog?.kind === 'rename-folder'}
        title={dialog?.kind === 'rename-folder' ? 'Rename folder' : 'New folder'}
        label="Folder name"
        initial={dialog?.kind === 'rename-folder' ? dialog.folder.name : ''}
        submitLabel={dialog?.kind === 'rename-folder' ? 'Save' : 'Create folder'}
        maxLength={100}
        onClose={() => setDialog(null)}
        onSave={async (name) => {
          try {
            if (dialog?.kind === 'rename-folder') {
              await api.renameFolder(dialog.folder.id, name);
              toast('Folder renamed');
            } else {
              await api.createFolder(name);
              toast('Folder created');
            }
            setDialog(null);
            await load();
          } catch (e) {
            toast(e instanceof Error ? e.message : 'The folder was not saved', 'error');
          }
        }}
      />
      <MoveDialog
        video={moving}
        folders={folders}
        onClose={() => setMoving(null)}
        onMoved={(_, name) => {
          setMoving(null);
          toast(name ? `Moved to ${name}` : 'Moved to My videos');
          void load();
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === 'delete-folder'}
        title="Delete this folder?"
        body={
          dialog?.kind === 'delete-folder'
            ? `"${dialog.folder.name}" is removed. ${
                dialog.folder.videoCount
                  ? `Its ${plural(dialog.folder.videoCount, 'video')} move back to My videos; none are deleted.`
                  : 'It has no videos.'
              }`
            : ''
        }
        confirmLabel="Delete folder"
        danger
        busy={busy}
        onConfirm={async () => {
          if (dialog?.kind !== 'delete-folder') return;
          setBusy(true);
          try {
            await api.deleteFolder(dialog.folder.id);
            toast('Folder deleted');
            setDialog(null);
            if (folderId) navigate('/');
            else await load();
          } catch {
            toast('The folder was not deleted', 'error');
          } finally {
            setBusy(false);
          }
        }}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === 'delete-video'}
        title="Delete this video for good?"
        body={`"${dialog?.kind === 'delete-video' ? dialog.video.title : ''}" and its comments, reactions and views are removed from this computer. This can't be undone.`}
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={async () => {
          if (dialog?.kind !== 'delete-video') return;
          setBusy(true);
          try {
            await api.deleteVideo(dialog.video.id);
            toast('Video deleted');
            await load();
          } catch {
            toast('The video was not deleted', 'error');
          } finally {
            setBusy(false);
            setDialog(null);
          }
        }}
        onCancel={() => setDialog(null)}
      />
    </main>
  );
}

/** A hidden file input plus the upload itself: read the file, send it, save its thumbnail. */
function useUploader(folderId: string | undefined, onDone: (video: Video) => void) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [name, setName] = useState('');

  async function handle(file: File) {
    const mimeType = uploadMimeType(file);
    if (!mimeType) {
      toast('Upload a WebM, MP4 or MOV video', 'error');
      return;
    }
    setName(file.name);
    setProgress(-1);
    try {
      const probe = await probeVideo(file);
      setProgress(0);
      const video = await uploadVideo(
        file,
        {
          title: titleFromFileName(file.name),
          mimeType,
          durationMs: probe.durationMs || undefined,
          width: probe.width,
          height: probe.height,
          folderId,
        },
        setProgress,
      );
      if (probe.thumbnail) await api.putThumbnail(video.id, probe.thumbnail).catch(() => {});
      toast('Uploaded');
      onDone(video);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The upload failed', 'error');
    } finally {
      setProgress(null);
    }
  }

  return {
    progress,
    name,
    pick: () => input.current?.click(),
    input: (
      <input
        ref={input}
        type="file"
        accept={UPLOAD_ACCEPT}
        hidden
        aria-label="Video file to upload"
        data-testid="upload-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void handle(file);
        }}
      />
    ),
  };
}

function VideoCard({
  video,
  recordingNow,
  items,
  folderName,
}: {
  video: Video;
  recordingNow: boolean;
  items: MenuItem[];
  folderName?: string;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const unfinished = video.status === 'recording';
  const length = playedDurationMs(video);
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
        {length !== null && <span className="badge">{formatClock(length)}</span>}
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
            {folderName && (
              <>
                {' '}
                · <IconFolder width="1em" height="1em" style={{ verticalAlign: '-0.125em' }} /> {folderName}
              </>
            )}
          </div>
        </div>
        <Menu label={`Actions for ${video.title}`} trigger={<IconMore />} items={items} />
      </div>
    </article>
  );
}
