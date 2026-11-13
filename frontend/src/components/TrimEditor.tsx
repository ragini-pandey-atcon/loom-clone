import { useRef, useState } from 'react';

import { formatClock } from '../lib/format';

const MIN_MS = 500;
const KEY_STEP = 100;
const KEY_STEP_BIG = 1000;

export interface TrimRange {
  startMs: number;
  endMs: number;
}

/**
 * Drag the two handles to keep the part between them. The player above previews the draft live.
 * Non-destructive, as in Loom: the file is kept whole and Revert to original always works.
 */
export function TrimEditor({
  durationMs,
  value,
  trimmed,
  busy,
  onChange,
  onSeek,
  onSave,
  onCancel,
  onRevert,
}: {
  durationMs: number;
  value: TrimRange;
  /** The saved video is trimmed, so Revert to original applies. */
  trimmed: boolean;
  busy: boolean;
  onChange: (range: TrimRange) => void;
  onSeek: (ms: number) => void;
  onSave: () => void;
  onCancel: () => void;
  onRevert: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null);
  const pct = (ms: number) => `${(ms / durationMs) * 100}%`;

  function set(handle: 'start' | 'end', ms: number) {
    const rounded = Math.round(ms / 10) * 10;
    const next =
      handle === 'start'
        ? { ...value, startMs: Math.min(Math.max(0, rounded), value.endMs - MIN_MS) }
        : { ...value, endMs: Math.max(Math.min(durationMs, rounded), value.startMs + MIN_MS) };
    onChange(next);
    onSeek(handle === 'start' ? next.startMs : Math.max(next.startMs, next.endMs - 1500));
  }

  function msAt(clientX: number) {
    const rect = bar.current!.getBoundingClientRect();
    return (Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * durationMs);
  }

  function handleProps(handle: 'start' | 'end') {
    const ms = handle === 'start' ? value.startMs : value.endMs;
    return {
      role: 'slider',
      tabIndex: 0,
      className: `trim-handle is-${handle}${dragging === handle ? ' is-dragging' : ''}`,
      style: { left: pct(ms) },
      'aria-label': handle === 'start' ? 'Trim start' : 'Trim end',
      'aria-valuemin': 0,
      'aria-valuemax': Math.round(durationMs),
      'aria-valuenow': Math.round(ms),
      'aria-valuetext': formatClock(ms),
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(handle);
      },
      onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
        if (dragging === handle) set(handle, msAt(e.clientX));
      },
      onPointerUp: () => setDragging(null),
      onPointerCancel: () => setDragging(null),
      onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
        const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') set(handle, ms - step);
        else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') set(handle, ms + step);
        else if (e.key === 'Home') set(handle, 0);
        else if (e.key === 'End') set(handle, durationMs);
        else return;
        e.preventDefault();
      },
    } as const;
  }

  const kept = value.endMs - value.startMs;
  const unchanged = value.startMs === 0 && value.endMs === durationMs;

  return (
    <section className="panel trim" aria-labelledby="trim-title">
      <div className="trim-head">
        <h2 id="trim-title">Trim</h2>
        <span className="muted">
          Keeping {formatClock(value.startMs)} to {formatClock(value.endMs)} ({formatClock(kept)})
        </span>
      </div>
      <div
        ref={bar}
        className="trim-bar"
        onPointerDown={(e) => {
          // A click on the bar moves the nearer handle there.
          const ms = msAt(e.clientX);
          set(Math.abs(ms - value.startMs) <= Math.abs(ms - value.endMs) ? 'start' : 'end', ms);
        }}
      >
        <div className="trim-cut" style={{ left: 0, width: pct(value.startMs) }} />
        <div className="trim-keep" style={{ left: pct(value.startMs), width: pct(kept) }} />
        <div className="trim-cut" style={{ left: pct(value.endMs), right: 0 }} />
        <div {...handleProps('start')} />
        <div {...handleProps('end')} />
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Drag the handles, or focus one and use the arrow keys (Shift for whole seconds). Viewers only see the part you
        keep. The file itself is kept whole, so you can revert at any time; downloads are the full recording.
      </p>
      <div className="dialog-actions">
        {trimmed && (
          <button type="button" className="btn btn-ghost" onClick={onRevert} disabled={busy} style={{ marginRight: 'auto' }}>
            Revert to original
          </button>
        )}
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy || (unchanged && !trimmed)}>
          Save trim
        </button>
      </div>
    </section>
  );
}
