/**
 * Recording quality. The choice caps the output's short side (720, 1080, 1440 or 2160 lines);
 * the recording is never larger than what is shared, so 4K on a 1080p screen records at 1080p.
 */

export type Quality = '720p' | '1080p' | '1440p' | '2160p';

export const QUALITIES: { value: Quality; label: string; width: number; height: number }[] = [
  { value: '720p', label: '720p', width: 1280, height: 720 },
  { value: '1080p', label: '1080p (Full HD)', width: 1920, height: 1080 },
  { value: '1440p', label: '1440p (2K)', width: 2560, height: 1440 },
  { value: '2160p', label: '4K', width: 3840, height: 2160 },
];

export function isQuality(value: unknown): value is Quality {
  return QUALITIES.some((q) => q.value === value);
}

function box(quality: Quality) {
  return QUALITIES.find((q) => q.value === quality) ?? QUALITIES[1];
}

/** Output size for a source of w x h: short side capped, long side at most twice the 16:9 width. */
export function fitToQuality(w: number, h: number, quality: Quality): [number, number] {
  const q = box(quality);
  const scale = Math.min(1, q.height / Math.min(w, h), (q.width * 2) / Math.max(w, h));
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return [even(w), even(h)];
}

/**
 * Video bits per second for an output size. About 0.13 bits per pixel at 30 fps: 8 Mbps at
 * 1080p, where the first build used 2.5 Mbps and small text smeared on every scroll.
 */
export function bitrateFor(width: number, height: number): number {
  const target = width * height * 30 * 0.13;
  return Math.round(Math.min(28_000_000, Math.max(3_000_000, target)));
}

/** The largest quality the user's main screen can fill, to label options above it. */
export function screenQuality(): Quality | null {
  if (typeof window === 'undefined' || !window.screen) return null;
  const ratio = window.devicePixelRatio || 1;
  const short = Math.round(Math.min(window.screen.width, window.screen.height) * ratio);
  const fits = QUALITIES.filter((q) => q.height <= short + 8);
  return fits.length ? fits[fits.length - 1].value : '720p';
}
