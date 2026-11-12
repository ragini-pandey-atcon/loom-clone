/**
 * Recorder settings that carry over to the next recording, kept in this browser only. Storage
 * can be blocked or cleared, so every read and write is guarded and every field is validated on
 * its own: one bad value never resets the rest.
 */
import { BUBBLE_FILTERS, BUBBLE_SHAPES, BUBBLE_SIZE_COUNT, type BubbleOptions, defaultBubble } from './bubble';
import { isQuality, type Quality } from './quality';

export interface RecorderPreferences {
  quality: Quality;
  countdown: boolean;
  showTimer: boolean;
  bubble: BubbleOptions;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const KEY = 'loom-clone.recorder';

export function defaultPreferences(): RecorderPreferences {
  return { quality: '1080p', countdown: true, showTimer: true, bubble: defaultBubble() };
}

function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const unit = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;

export function loadPreferences(storage: StorageLike | null = browserStorage()): RecorderPreferences {
  const d = defaultPreferences();
  let raw: Record<string, unknown> | null = null;
  try {
    const text = storage?.getItem(KEY);
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    raw = null;
  }
  if (!raw) return d;
  const b = (raw.bubble && typeof raw.bubble === 'object' ? raw.bubble : {}) as Record<string, unknown>;
  const size =
    typeof b.size === 'number' && Number.isInteger(b.size) && b.size >= 0 && b.size < BUBBLE_SIZE_COUNT
      ? b.size
      : d.bubble.size;
  return {
    quality: isQuality(raw.quality) ? raw.quality : d.quality,
    countdown: bool(raw.countdown, d.countdown),
    showTimer: bool(raw.showTimer, d.showTimer),
    bubble: {
      px: unit(b.px, d.bubble.px),
      py: unit(b.py, d.bubble.py),
      size,
      shape: BUBBLE_SHAPES.some((s) => s.value === b.shape) ? (b.shape as BubbleOptions['shape']) : d.bubble.shape,
      mirror: bool(b.mirror, d.bubble.mirror),
      filter: BUBBLE_FILTERS.some((f) => f.value === b.filter) ? (b.filter as BubbleOptions['filter']) : d.bubble.filter,
      // Take-only states: each recording starts with the camera on and the screen showing.
      visible: true,
      fullCamera: false,
    },
  };
}

export function savePreferences(p: RecorderPreferences, storage: StorageLike | null = browserStorage()): void {
  const { visible: _visible, fullCamera: _fullCamera, ...bubble } = p.bubble;
  try {
    storage?.setItem(KEY, JSON.stringify({ quality: p.quality, countdown: p.countdown, showTimer: p.showTimer, bubble }));
  } catch {
    /* storage blocked or full: the settings just don't carry over */
  }
}
