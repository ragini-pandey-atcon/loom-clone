import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';

import { api, isOffline, playedDurationMs, thumbnailUrl, type Video } from '../api/client';
import { IconClock, IconVideo, IconX } from '../components/Icons';
import { toast } from '../components/ui';
import { formatClock, formatWhen } from '../lib/format';
import { viewerId } from '../lib/identity';

/** Videos this browser saved for later, newest first (Loom: Playlists, Watch later). */
export function WatchLaterPage() {
  const [videos, setVideos] = useState<Video[] | null>(null);
  const [error, setError] = useState<'offline' | 'error' | null>(null);

  const load = useCallback(async () => {
    try {
      setVideos(await api.listWatchLater(viewerId()));
      setError(null);
    } catch (e) {
      setError(isOffline(e) ? 'offline' : 'error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(video: Video) {
    try {
      await api.removeWatchLater(video.id, viewerId());
      setVideos((list) => list?.filter((v) => v.id !== video.id) ?? null);
      toast('Removed from Watch later');
    } catch {
      toast('That did not save', 'error');
    }
  }

  return (
    <main className="page">
      <div className="page-head">
        <h1>Watch later</h1>
      </div>
      {error && (
        <div className="banner is-danger" role="alert">
          {error === 'offline'
            ? "The local server on port 7310 isn't answering. Start it with scripts\\start.ps1, then reload."
            : 'Your list could not be loaded.'}
        </div>
      )}
      {videos === null && !error ? (
        <div className="grid" aria-busy="true" aria-label="Loading">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="skeleton skeleton-card" />
          ))}
        </div>
      ) : videos && videos.length === 0 ? (
        <div className="empty">
          <IconClock style={{ width: 'var(--space-10)', height: 'var(--space-10)' }} />
          <h2>Nothing saved for later</h2>
          <p>Press Watch later under any video to keep it here until you have time.</p>
        </div>
      ) : (
        <ul className="later-list">
          {videos?.map((v) => {
            const length = playedDurationMs(v);
            return (
              <li key={v.id} className="later-row">
                <Link to={`/v/${v.id}`} className="later-thumb" tabIndex={-1} aria-hidden="true">
                  {v.hasThumbnail ? <img src={thumbnailUrl(v)} alt="" loading="lazy" /> : <IconVideo />}
                  {length !== null && <span className="badge">{formatClock(length)}</span>}
                </Link>
                <div className="later-text">
                  <Link className="card-title" to={`/v/${v.id}`}>
                    {v.title}
                  </Link>
                  <span className="muted">{formatWhen(v.createdAt)}</span>
                </div>
                <button type="button" className="icon-btn" aria-label={`Remove ${v.title} from Watch later`} onClick={() => void remove(v)}>
                  <IconX />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
