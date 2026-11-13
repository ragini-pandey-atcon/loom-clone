/**
 * The unread notification count for the top bar. One poll for the whole app: every 30 s, when the
 * tab comes back into focus, and on demand (after marking read, after commenting).
 */
import { useEffect, useSyncExternalStore } from 'react';

import { api } from '../api/client';
import { viewerId } from './identity';

let count = 0;
const listeners = new Set<() => void>();

export function refreshUnread(): void {
  api.unreadCount(viewerId()).then(
    (r) => {
      if (r.count !== count) {
        count = r.count;
        listeners.forEach((l) => l());
      }
    },
    () => {},
  );
}

export function useUnreadCount(): number {
  useEffect(() => {
    refreshUnread();
    const timer = setInterval(refreshUnread, 30_000);
    window.addEventListener('focus', refreshUnread);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refreshUnread);
    };
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => count,
    () => 0,
  );
}
