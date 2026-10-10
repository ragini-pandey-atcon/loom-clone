/**
 * Who is looking at the page. There are no accounts: the browser that opens the library is the
 * owner's, and everyone else is a viewer with a random id and a display name they type once.
 * All of it lives in localStorage, which can throw (blocked storage), so every access is guarded.
 */
import { useSyncExternalStore } from 'react';

import { api } from '../api/client';

const KEYS = { viewerId: 'asv.viewerId', name: 'asv.name', owner: 'asv.owner' } as const;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the value lives for this page only */
  }
}

let memoryId: string | null = null;

export function viewerId(): string {
  const stored = read(KEYS.viewerId);
  if (stored) return stored;
  memoryId ??= crypto.randomUUID();
  write(KEYS.viewerId, memoryId);
  return memoryId;
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function displayName(): string | null {
  return read(KEYS.name)?.trim() || null;
}

export function setDisplayName(name: string): void {
  write(KEYS.name, name.trim().slice(0, 60));
  notify();
}

export function isOwnerDevice(): boolean {
  return read(KEYS.owner) === '1';
}

let claimed = false;

/** Called on owner surfaces (library, recorder). Also tells the API, so views from here never count. */
export function claimOwnerDevice(): void {
  if (!isOwnerDevice()) {
    write(KEYS.owner, '1');
    notify();
  }
  if (!claimed) {
    claimed = true;
    api.claimOwnerDevice(viewerId()).catch(() => {
      claimed = false;
    });
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = () => listener();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useDisplayName(): string | null {
  return useSyncExternalStore(subscribe, displayName, () => null);
}

export function useIsOwnerDevice(): boolean {
  return useSyncExternalStore(subscribe, isOwnerDevice, () => false);
}
