import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { type AppNotification, api, isOffline, type NotificationKind } from '../api/client';
import { IconBell } from '../components/Icons';
import { Avatar } from '../components/ui';
import { formatWhen } from '../lib/format';
import { viewerId } from '../lib/identity';
import { refreshUnread } from '../lib/unread';

const VERB: Record<NotificationKind, string> = {
  comment: 'commented on',
  reply: 'replied to your comment on',
  mention: 'mentioned you on',
  video_reply: 'recorded a video reply on',
};

/** Comments, replies, @mentions and video replies on videos you own or follow (Loom S16). */
export function NotificationsPage() {
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [error, setError] = useState<'offline' | 'error' | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listNotifications(viewerId())
      .then(async (list) => {
        if (cancelled) return;
        setItems(list);
        // Seen once listed. The rows keep their unread look until you leave the page.
        if (list.some((n) => !n.read)) {
          await api.markNotificationsRead(viewerId()).catch(() => {});
          refreshUnread();
        }
      })
      .catch((e) => !cancelled && setError(isOffline(e) ? 'offline' : 'error'));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="page">
      <div className="page-head">
        <h1>Notifications</h1>
      </div>
      {error && (
        <div className="banner is-danger" role="alert">
          {error === 'offline'
            ? "The local server on port 7310 isn't answering. Start it with scripts\\start.ps1, then reload."
            : 'Notifications could not be loaded.'}
        </div>
      )}
      {items === null && !error ? (
        <div className="stack" aria-busy="true" aria-label="Loading">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton" style={{ height: 'var(--space-16, 4rem)' }} />
          ))}
        </div>
      ) : items && items.length === 0 ? (
        <div className="empty">
          <IconBell style={{ width: 'var(--space-10)', height: 'var(--space-10)' }} />
          <h2>Nothing new</h2>
          <p>Comments, replies and @mentions on your videos, and on videos you follow, show up here.</p>
        </div>
      ) : (
        <ul className="notice-list">
          {items?.map((n) => {
            const at = n.timestampMs !== null && n.kind !== 'reply' ? `?t=${Math.floor(n.timestampMs / 1000)}` : '';
            return (
              <li key={n.id} className={n.read ? 'notice-row' : 'notice-row is-unread'}>
                <Avatar name={n.actorName} seed={n.actorName} />
                <div className="notice-text">
                  <Link to={`/v/${n.videoId}${at}`} className="notice-link">
                    <strong>{n.actorName}</strong> {VERB[n.kind]} <strong>{n.videoTitle}</strong>
                  </Link>
                  {n.preview && n.kind !== 'video_reply' && <p className="notice-preview">{n.preview}</p>}
                  <span className="muted">{formatWhen(n.createdAt)}</span>
                </div>
                {!n.read && <span className="unread-dot" aria-label="New" />}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
