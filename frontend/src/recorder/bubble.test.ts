import { describe, expect, it } from 'vitest';

import { BUBBLE_SIZE_COUNT, bubbleRect, defaultBubble, dragTo, snapPosition } from './bubble';

const W = 1920;
const H = 1080;

describe('bubbleRect', () => {
  it('puts the default bubble in the bottom-left corner, inside the margin', () => {
    const r = bubbleRect(defaultBubble(), W, H);
    const margin = Math.round(H * 0.03);
    expect(r.x).toBe(margin);
    expect(r.y + r.h).toBe(H - margin);
  });

  it('grows with each of the five sizes', () => {
    const widths = Array.from({ length: BUBBLE_SIZE_COUNT }, (_, size) => bubbleRect({ ...defaultBubble(), size }, W, H).w);
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThan(widths[i - 1]);
  });

  it('gives each shape its own proportions', () => {
    const at = (shape: 'circle' | 'squircle' | 'landscape' | 'portrait') => bubbleRect({ ...defaultBubble(), shape }, W, H);
    expect(at('circle').w).toBe(at('circle').h);
    expect(at('squircle').w).toBe(at('squircle').h);
    expect(at('landscape').w).toBeGreaterThan(at('landscape').h);
    expect(at('portrait').h).toBeGreaterThan(at('portrait').w);
  });

  it('keeps every shape and size inside the frame at the far corner', () => {
    for (const shape of ['circle', 'squircle', 'landscape', 'portrait'] as const) {
      for (let size = 0; size < BUBBLE_SIZE_COUNT; size++) {
        for (const [w, h] of [
          [W, H],
          [1080, 1920],
          [1280, 720],
        ]) {
          const r = bubbleRect({ ...defaultBubble(), shape, size, px: 1, py: 1 }, w, h);
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(w);
          expect(r.y + r.h).toBeLessThanOrEqual(h);
        }
      }
    }
  });
});

describe('dragTo and snapPosition', () => {
  it('moves the bubble by the pointer delta', () => {
    const start = { ...defaultBubble(), px: 0.5, py: 0.5 };
    const before = bubbleRect(start, W, H);
    const after = bubbleRect({ ...start, ...dragTo(start, 100, -50, W, H) }, W, H);
    expect(after.x - before.x).toBeCloseTo(100, 0);
    expect(after.y - before.y).toBeCloseTo(-50, 0);
  });

  it('stops at the edges instead of leaving the frame', () => {
    const start = defaultBubble();
    expect(dragTo(start, -5000, 5000, W, H)).toEqual({ px: 0, py: 1 });
    expect(dragTo(start, 5000, -5000, W, H)).toEqual({ px: 1, py: 0 });
  });

  it('snaps to a side or corner when dropped close to it, and leaves the middle alone', () => {
    expect(snapPosition({ px: 0.03, py: 0.97 })).toEqual({ px: 0, py: 1 });
    expect(snapPosition({ px: 0.98, py: 0.4 })).toEqual({ px: 1, py: 0.4 });
    expect(snapPosition({ px: 0.4, py: 0.6 })).toEqual({ px: 0.4, py: 0.6 });
  });
});
