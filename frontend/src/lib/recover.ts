/**
 * Finishes a take whose tab closed or crashed mid-recording. The chunks are already on disk; this
 * downloads them, runs the same WebM repair the normal Stop uses, and finalizes. One repair
 * implementation, in the browser.
 */
import { api, type Video } from '../api/client';
import { fixWebm } from './webmFix';

export async function recoverVideo(id: string): Promise<Video> {
  const { contiguous } = await api.getChunks(id);
  if (contiguous === 0) throw new Error('Nothing was saved from this recording.');
  const raw = await api.getRaw(id);
  let header: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let bodyOffset = 0;
  let durationMs: number | undefined;
  try {
    const fix = await fixWebm(raw);
    header = fix.header;
    bodyOffset = fix.bodyOffset;
    durationMs = fix.durationMs;
  } catch (error) {
    console.warn('WebM repair failed during recovery; keeping the raw recording', error);
  }
  const fixed = new Blob([header as BlobPart, raw.slice(bodyOffset)], { type: 'video/webm' });
  const frame = await grabFrame(fixed).catch(() => null);
  const video = await api.finalize(id, header, {
    chunkCount: contiguous,
    bodyOffset,
    durationMs,
    width: frame?.width,
    height: frame?.height,
  });
  if (frame?.jpeg) await api.putThumbnail(id, frame.jpeg).catch(() => {});
  return video;
}

/** A JPEG from about one second in, plus the video's size. */
function grabFrame(blob: Blob): Promise<{ jpeg: Blob | null; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const el = document.createElement('video');
    el.muted = true;
    el.preload = 'auto';
    const done = (fn: () => void) => {
      URL.revokeObjectURL(url);
      fn();
    };
    el.onloadedmetadata = () => {
      el.currentTime = Math.min(1, Number.isFinite(el.duration) ? el.duration / 2 : 1);
    };
    el.onseeked = () => {
      const w = Math.min(640, el.videoWidth);
      const h = Math.round((el.videoHeight * w) / el.videoWidth);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')!.drawImage(el, 0, 0, w, h);
      const size = { width: el.videoWidth, height: el.videoHeight };
      canvas.toBlob((jpeg) => done(() => resolve({ jpeg, ...size })), 'image/jpeg', 0.82);
    };
    el.onerror = () => done(() => reject(new Error('Could not read the recording')));
    el.src = url;
  });
}
