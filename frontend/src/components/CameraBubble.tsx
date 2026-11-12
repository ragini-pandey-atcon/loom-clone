import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  BUBBLE_FILTERS,
  BUBBLE_SHAPES,
  BUBBLE_SIZE_COUNT,
  BUBBLE_SIZE_LABELS,
  type BubbleFilter,
  type BubbleOptions,
  type BubbleShape,
  bubbleRect,
  cornerRadius,
  dragTo,
  filterCss,
  snapPosition,
} from '../recorder/bubble';
import { LiveVideo } from './LiveVideo';

/** Size of an element, kept current with a ResizeObserver. */
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** Where a frame of outW x outH sits inside a box of w x h with object-fit: contain. */
function containRect(outW: number, outH: number, w: number, h: number) {
  const scale = Math.min(w / outW, h / outH) || 0;
  const fw = outW * scale;
  const fh = outH * scale;
  return { left: (w - fw) / 2, top: (h - fh) / 2, scale };
}

const KEY_STEP = 0.05;

interface BubbleLayerProps {
  /** The recording's size (or a stand-in during setup), so positions match the real output. */
  outWidth: number;
  outHeight: number;
  bubble: BubbleOptions;
  onChange: (patch: Partial<BubbleOptions>) => void;
  /** Setup: draw the camera here. Recording: the composite already shows it; this is a handle. */
  cameraStream?: MediaStream | null;
  /** Double-click (or Enter) toggles full camera. Only while recording. */
  allowFullCamera?: boolean;
  children?: ReactNode;
}

/**
 * Fills its positioned parent (the stage) and puts a draggable bubble on top: drag to move, drop
 * near a side or corner to snap, the slider above it to resize, double-click for full camera.
 */
export function BubbleLayer({ outWidth, outHeight, bubble, onChange, cameraStream, allowFullCamera, children }: BubbleLayerProps) {
  const [ref, box] = useElementSize<HTMLDivElement>();
  const drag = useRef<{ x: number; y: number; start: BubbleOptions; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  const frame = containRect(outWidth, outHeight, box.w, box.h);
  const full = allowFullCamera && bubble.fullCamera;
  const r = bubbleRect(bubble, outWidth, outHeight);
  const s = frame.scale;
  const style: CSSProperties = full
    ? { left: frame.left, top: frame.top, width: outWidth * s, height: outHeight * s, borderRadius: 0 }
    : {
        left: frame.left + r.x * s,
        top: frame.top + r.y * s,
        width: r.w * s,
        height: r.h * s,
        borderRadius: cornerRadius(bubble.shape, r) * s,
      };
  const toolbarBelow = !full && r.y * s < 56;

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (full || e.button !== 0 || (e.target as HTMLElement).closest('.bubble-tools')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, start: { ...bubble }, moved: false };
    setDragging(true);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || !s) return;
    const dx = (e.clientX - d.x) / s;
    const dy = (e.clientY - d.y) / s;
    if (!d.moved && Math.hypot(dx, dy) * s < 3) return;
    d.moved = true;
    onChange(dragTo(d.start, dx, dy, outWidth, outHeight));
  }

  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (d?.moved) onChange(snapPosition(bubble));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest('.bubble-tools')) return;
    // No snap here: a small keyboard step off a side would snap straight back onto it.
    const move = (px: number, py: number) => {
      e.preventDefault();
      const round = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
      onChange({ px: round(px), py: round(py) });
    };
    if (e.key === 'ArrowLeft') move(bubble.px - KEY_STEP, bubble.py);
    else if (e.key === 'ArrowRight') move(bubble.px + KEY_STEP, bubble.py);
    else if (e.key === 'ArrowUp') move(bubble.px, bubble.py - KEY_STEP);
    else if (e.key === 'ArrowDown') move(bubble.px, bubble.py + KEY_STEP);
    else if (e.key === '+' || e.key === '=') onChange({ size: Math.min(BUBBLE_SIZE_COUNT - 1, bubble.size + 1) });
    else if (e.key === '-') onChange({ size: Math.max(0, bubble.size - 1) });
    else if (e.key === 'Enter' && allowFullCamera) onChange({ fullCamera: !bubble.fullCamera });
  }

  const hint = allowFullCamera
    ? full
      ? 'Camera fills the recording. Double-click or press Enter to go back to your screen.'
      : 'Camera bubble. Drag or use the arrow keys to move it, plus and minus to resize, double-click or Enter for full camera.'
    : 'Camera bubble. Drag or use the arrow keys to move it, plus and minus to resize.';

  return (
    <div ref={ref} className="bubble-layer">
      {children}
      {box.w > 0 && (
        <div
          className={`bubble${cameraStream ? ' has-camera' : ' is-handle'}${dragging ? ' is-dragging' : ''}${full ? ' is-full' : ''}`}
          style={style}
          role="button"
          tabIndex={0}
          aria-roledescription="movable camera bubble"
          aria-label={hint}
          title={full ? 'Double-click to go back to your screen' : 'Drag to move. Double-click for full camera.'}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={() => allowFullCamera && onChange({ fullCamera: !bubble.fullCamera })}
          onKeyDown={onKeyDown}
        >
          {cameraStream && (
            <div className="bubble-video" style={{ filter: filterCss(bubble.filter) }} data-mirror={bubble.mirror}>
              <LiveVideo stream={cameraStream} label="Camera bubble preview" />
            </div>
          )}
          {!full && (
            <div className={`bubble-tools${toolbarBelow ? ' is-below' : ''}`}>
              <SizeSlider value={bubble.size} onChange={(size) => onChange({ size })} compact />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SizeSlider({ value, onChange, compact }: { value: number; onChange: (size: number) => void; compact?: boolean }) {
  return (
    <input
      type="range"
      className={compact ? 'range is-compact' : 'range'}
      min={0}
      max={BUBBLE_SIZE_COUNT - 1}
      step={1}
      value={value}
      aria-label="Bubble size"
      aria-valuetext={BUBBLE_SIZE_LABELS[value]}
      title={`Size: ${BUBBLE_SIZE_LABELS[value]}`}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

function ShapeGlyph({ shape }: { shape: BubbleShape }) {
  return <span className={`shape-glyph shape-${shape}`} aria-hidden="true" />;
}

interface CameraControlsProps {
  bubble: BubbleOptions;
  onChange: (patch: Partial<BubbleOptions>) => void;
  /** Shape, size and position only matter when there is a screen behind the bubble. */
  showBubble: boolean;
  /** Recording: the camera can be turned off and on, and switched to full camera. */
  live?: boolean;
}

/** Shape, size, flip and filter, plus camera on/off and full camera while recording. */
export function CameraControls({ bubble, onChange, showBubble, live }: CameraControlsProps) {
  return (
    <div className={live ? 'camera-controls is-live' : 'camera-controls'}>
      {live && showBubble && (
        <label className="toggle">
          <span>Camera on</span>
          <input
            type="checkbox"
            role="switch"
            checked={bubble.visible}
            onChange={(e) => onChange({ visible: e.target.checked, fullCamera: e.target.checked && bubble.fullCamera })}
          />
        </label>
      )}
      {live && showBubble && (
        <label className="toggle">
          <span>Full camera</span>
          <input
            type="checkbox"
            role="switch"
            checked={bubble.fullCamera}
            disabled={!bubble.visible}
            onChange={(e) => onChange({ fullCamera: e.target.checked })}
          />
        </label>
      )}
      {showBubble && (
        <div className="field">
          <span className="field-label" id="shape-label">
            Shape
          </span>
          <div className="segmented shape-picker" role="group" aria-labelledby="shape-label">
            {BUBBLE_SHAPES.map((s) => (
              <button
                key={s.value}
                type="button"
                aria-pressed={bubble.shape === s.value}
                aria-label={s.label}
                title={s.label}
                onClick={() => onChange({ shape: s.value })}
                disabled={live && !bubble.visible}
              >
                <ShapeGlyph shape={s.value} />
              </button>
            ))}
          </div>
        </div>
      )}
      {showBubble && (
        <div className="field">
          <span className="field-label">
            Size <span className="muted">{BUBBLE_SIZE_LABELS[bubble.size]}</span>
          </span>
          <SizeSlider value={bubble.size} onChange={(size) => onChange({ size })} />
        </div>
      )}
      <div className="field">
        <label className="field-label" htmlFor={live ? 'filter-live' : 'filter'}>
          Filter
        </label>
        <select
          id={live ? 'filter-live' : 'filter'}
          className="select"
          value={bubble.filter}
          onChange={(e) => onChange({ filter: e.target.value as BubbleFilter })}
        >
          {BUBBLE_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      <label className="toggle">
        <span>
          Flip camera
          {!live && <span className="muted toggle-help">Turn on so text behind you reads the right way round</span>}
        </span>
        <input type="checkbox" role="switch" checked={!bubble.mirror} onChange={(e) => onChange({ mirror: !e.target.checked })} />
      </label>
    </div>
  );
}

/** Camera-only preview with the same mirror and filter the recording will get. */
export function CameraFill({ stream, bubble }: { stream: MediaStream; bubble: BubbleOptions }) {
  return (
    <div className="camera-full bubble-video" style={{ filter: filterCss(bubble.filter) }} data-mirror={bubble.mirror}>
      <LiveVideo stream={stream} label="Camera preview" />
    </div>
  );
}

/** Keeps a mutable options object (read by the compositor every frame) and React state in step. */
export function useLiveBubble(target: BubbleOptions, onPersist: (b: BubbleOptions) => void) {
  const [bubble, setBubble] = useState<BubbleOptions>({ ...target });
  const persist = useRef(onPersist);
  persist.current = onPersist;
  useEffect(() => {
    const id = setTimeout(() => persist.current(bubble), 300);
    return () => clearTimeout(id);
  }, [bubble]);
  return [
    bubble,
    (patch: Partial<BubbleOptions>) => {
      Object.assign(target, patch);
      setBubble({ ...target });
    },
  ] as const;
}
