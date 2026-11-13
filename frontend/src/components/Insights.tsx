import { useEffect, useState } from 'react';

import { api, type Reaction, type Video, type Viewer } from '../api/client';
import { formatClock, formatWhen } from '../lib/format';
import { Avatar } from './ui';

/** Owner-only Activity tab (S15). The per-video switches are in the Settings tab (VideoSettings). */
export function Insights({
  video,
  reactions,
  onSeek,
}: {
  video: Video;
  reactions: Reaction[];
  onSeek: (ms: number) => void;
}) {
  const [viewers, setViewers] = useState<Viewer[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .listViews(video.id)
        .then((r) => !cancelled && (setViewers(r.viewers), setFailed(false)))
        .catch(() => !cancelled && setFailed(true));
    void load();
    window.addEventListener('focus', load);
    const timer = setInterval(load, 15000);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', load);
      clearInterval(timer);
    };
  }, [video.id]);

  const counts = new Map<string, number>();
  for (const r of reactions) counts.set(r.emoji, (counts.get(r.emoji) ?? 0) + 1);

  return (
    <div>
      <div className="stat">
        <strong>{viewers ? viewers.length : '·'}</strong>
        <span className="muted">
          {viewers && viewers.length === 1 ? 'view' : 'views'}. A view counts after 5 seconds, 75 %, or the end.
          Your own plays don't count.
        </span>
      </div>

      {failed && <p className="muted">Viewers could not be loaded.</p>}
      {viewers && viewers.length === 0 && <p className="muted">No views yet. Share the link to get some.</p>}
      {viewers?.map((v) => (
        <div className="viewer-row" key={v.viewerId}>
          <Avatar name={v.viewerName} seed={v.viewerId} />
          <div>
            <strong>{v.viewerName}</strong>
            <div className="muted">
              Watched {formatClock(v.watchedMs)}
              {v.completed ? ', to the end' : ''} · {formatWhen(v.lastSeenAt)}
            </div>
          </div>
        </div>
      ))}

      <h3 className="section-title">Reactions</h3>
      {reactions.length === 0 ? (
        <p className="muted">No reactions yet.</p>
      ) : (
        <>
          <p className="chip-row" style={{ margin: 0 }}>
            {[...counts].map(([emoji, n]) => (
              <span key={emoji} className="badge" style={{ background: 'var(--c-surface-2)' }}>
                {emoji} {n}
              </span>
            ))}
          </p>
          {reactions
            .slice(-20)
            .reverse()
            .map((r) => (
              <div className="viewer-row" key={r.id}>
                <span aria-hidden="true" style={{ fontSize: 'var(--text-lg)' }}>
                  {r.emoji}
                </span>
                <div>
                  {r.authorName} <span className="muted">{formatWhen(r.createdAt)}</span>
                </div>
                <button type="button" className="stamp" onClick={() => onSeek(r.timestampMs)}>
                  {formatClock(r.timestampMs)}
                </button>
              </div>
            ))}
        </>
      )}

    </div>
  );
}
