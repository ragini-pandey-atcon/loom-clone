import { describe, expect, it } from 'vitest';

import { bitrateFor, fitToQuality, QUALITIES } from './quality';

describe('fitToQuality', () => {
  it('keeps a 1080p screen at 1080p when 1080p is chosen', () => {
    expect(fitToQuality(1920, 1080, '1080p')).toEqual([1920, 1080]);
  });

  it('records a 1440p screen at full size when 1440p or 4K is chosen', () => {
    expect(fitToQuality(2560, 1440, '1440p')).toEqual([2560, 1440]);
    expect(fitToQuality(2560, 1440, '2160p')).toEqual([2560, 1440]);
  });

  it('scales a 4K screen down to the chosen quality, keeping its shape', () => {
    expect(fitToQuality(3840, 2160, '720p')).toEqual([1280, 720]);
    expect(fitToQuality(3840, 2160, '1080p')).toEqual([1920, 1080]);
  });

  it('never upscales a small window', () => {
    expect(fitToQuality(1000, 600, '2160p')).toEqual([1000, 600]);
  });

  it('fits portrait and ultrawide sources by their short and long sides', () => {
    expect(fitToQuality(1080, 1920, '720p')).toEqual([720, 1280]);
    expect(fitToQuality(5120, 1440, '1080p')).toEqual([3840, 1080]);
  });

  it('always returns even sizes, which the VP9 encoder needs', () => {
    const [w, h] = fitToQuality(1365, 767, '720p');
    expect(w % 2).toBe(0);
    expect(h % 2).toBe(0);
  });
});

describe('bitrateFor', () => {
  it('gives each quality more bits than the one below it', () => {
    const rates = QUALITIES.map((q) => bitrateFor(q.width, q.height));
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeGreaterThan(rates[i - 1]);
  });

  it('is far above the old 2.5 Mbps at 1080p, so screen text stays sharp', () => {
    expect(bitrateFor(1920, 1080)).toBeGreaterThanOrEqual(8_000_000);
  });

  it('stays within the floor and ceiling', () => {
    expect(bitrateFor(320, 240)).toBe(3_000_000);
    expect(bitrateFor(7680, 4320)).toBe(28_000_000);
  });
});
