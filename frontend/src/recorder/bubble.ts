/**
 * Camera bubble geometry, shared by the compositor (canvas pixels) and the recorder page (CSS
 * percentages of the stage), so what you drag is exactly what gets recorded.
 *
 * Position is stored as px/py in 0..1: how far across the free space (frame minus margins minus
 * bubble) the bubble sits. That stays valid whatever the shape, size or frame, so a bubble moved
 * to the right edge stays on the right edge after a resize, and can never leave the frame.
 */

export type BubbleShape = 'circle' | 'squircle' | 'landscape' | 'portrait';
export type BubbleFilter = 'none' | 'vivid' | 'mono' | 'warm' | 'cool' | 'bright';

export interface BubbleOptions {
  px: number;
  py: number;
  /** 0 (smallest) to BUBBLE_SIZE_COUNT - 1. */
  size: number;
  shape: BubbleShape;
  /** Mirror the camera, like a mirror shows you. Flip camera turns it off. */
  mirror: boolean;
  filter: BubbleFilter;
  /** The bubble is in the recording at all. Camera off mid-take sets it false. */
  visible: boolean;
  /** Double-click: the camera fills the frame instead of the screen. */
  fullCamera: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bubble diameter as a share of the frame's short side, for each of the five sizes. */
const SIZE_FRACTIONS = [0.13, 0.18, 0.24, 0.31, 0.4];
export const BUBBLE_SIZE_COUNT = SIZE_FRACTIONS.length;
export const BUBBLE_SIZE_LABELS = ['Extra small', 'Small', 'Medium', 'Large', 'Extra large'];
const MARGIN_FRACTION = 0.03;
/** Dropped within this share of the free space from a side, the bubble snaps to it. */
const SNAP = 0.06;

export const BUBBLE_SHAPES: { value: BubbleShape; label: string }[] = [
  { value: 'circle', label: 'Circle' },
  { value: 'squircle', label: 'Rounded square' },
  { value: 'landscape', label: 'Landscape' },
  { value: 'portrait', label: 'Portrait' },
];

export const BUBBLE_FILTERS: { value: BubbleFilter; label: string; css: string }[] = [
  { value: 'none', label: 'None', css: 'none' },
  { value: 'vivid', label: 'Vivid', css: 'saturate(1.45) contrast(1.08)' },
  { value: 'mono', label: 'Mono', css: 'grayscale(1) contrast(1.08)' },
  { value: 'warm', label: 'Warm', css: 'sepia(0.28) saturate(1.25) hue-rotate(-8deg)' },
  { value: 'cool', label: 'Cool', css: 'saturate(1.1) hue-rotate(12deg) brightness(1.03)' },
  { value: 'bright', label: 'Bright', css: 'brightness(1.18) contrast(1.05)' },
];

export function filterCss(filter: BubbleFilter): string {
  return BUBBLE_FILTERS.find((f) => f.value === filter)?.css ?? 'none';
}

export function defaultBubble(): BubbleOptions {
  return {
    px: 0,
    py: 1,
    size: 2,
    shape: 'circle',
    mirror: true,
    filter: 'none',
    visible: true,
    fullCamera: false,
  };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function margin(width: number, height: number): number {
  return Math.round(Math.min(width, height) * MARGIN_FRACTION);
}

/** Width and height of the bubble, before it is placed. */
function bubbleSize(o: Pick<BubbleOptions, 'size' | 'shape'>, width: number, height: number): [number, number] {
  const m = margin(width, height);
  const fraction = SIZE_FRACTIONS[Math.min(BUBBLE_SIZE_COUNT - 1, Math.max(0, Math.round(o.size)))];
  const d = Math.min(width, height) * fraction;
  let [w, h] =
    o.shape === 'landscape' ? [d * 1.6, d * 0.9] : o.shape === 'portrait' ? [d * 0.75, d * 1.33] : [d, d];
  // A big portrait bubble on a short frame (or the reverse) is scaled down to fit inside the margins.
  const fit = Math.min(1, (width - 2 * m) / w, (height - 2 * m) / h);
  w = Math.round(w * fit);
  h = Math.round(h * fit);
  return [w, h];
}

export function bubbleRect(o: BubbleOptions, width: number, height: number): Rect {
  const m = margin(width, height);
  const [w, h] = bubbleSize(o, width, height);
  return {
    x: Math.round(m + clamp01(o.px) * (width - 2 * m - w)),
    y: Math.round(m + clamp01(o.py) * (height - 2 * m - h)),
    w,
    h,
  };
}

/** The new px/py after the pointer moved dx, dy (in the same units as width and height). */
export function dragTo(
  start: BubbleOptions,
  dx: number,
  dy: number,
  width: number,
  height: number,
): Pick<BubbleOptions, 'px' | 'py'> {
  const m = margin(width, height);
  const [w, h] = bubbleSize(start, width, height);
  const freeX = width - 2 * m - w;
  const freeY = height - 2 * m - h;
  return {
    px: freeX > 0 ? clamp01(clamp01(start.px) + dx / freeX) : 0,
    py: freeY > 0 ? clamp01(clamp01(start.py) + dy / freeY) : 0,
  };
}

/** On drop: a bubble close to a side or a corner snaps onto it. */
export function snapPosition(p: Pick<BubbleOptions, 'px' | 'py'>): Pick<BubbleOptions, 'px' | 'py'> {
  const snap = (n: number) => (n < SNAP ? 0 : n > 1 - SNAP ? 1 : n);
  return { px: snap(p.px), py: snap(p.py) };
}

/** Corner radius for the shape's outline, in the rect's units. */
export function cornerRadius(shape: BubbleShape, r: Pick<Rect, 'w' | 'h'>): number {
  const short = Math.min(r.w, r.h);
  if (shape === 'circle') return short / 2;
  if (shape === 'squircle') return short * 0.28;
  return short * 0.14;
}
