/**
 * Reads an upload's length and size, and grabs a thumbnail, in the browser. If the browser
 * cannot play the file it cannot be watched here either, so that is the check for "supported".
 */

const BY_EXTENSION: Record<string, string> = {
  webm: 'video/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
};

export const UPLOAD_ACCEPT = '.webm,.mp4,.m4v,.mov,video/webm,video/mp4,video/quicktime';

/** Windows often reports an empty type for .mov; fall back to the extension. */
export function uploadMimeType(file: Pick<File, 'name' | 'type'>): string | null {
  const type = file.type.toLowerCase();
  if (type === 'video/webm' || type === 'video/mp4' || type === 'video/quicktime') return type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return BY_EXTENSION[ext] ?? null;
}

/** "Team update.final.mp4" becomes "Team update.final". */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').trim();
  return (base || 'Uploaded video').slice(0, 200);
}

export interface Probe {
  durationMs: number;
  width: number;
  height: number;
  thumbnail: Blob | null;
}

function once(el: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = () => {
      el.removeEventListener('error', fail);
      resolve();
    };
    const fail = () => {
      el.removeEventListener(event, ok);
      reject(new Error('This browser cannot play that file, so it cannot be watched here.'));
    };
    el.addEventListener(event, ok, { once: true });
    el.addEventListener('error', fail, { once: true });
  });
}

export async function probeVideo(file: Blob): Promise<Probe> {
  const url = URL.createObjectURL(file);
  const el = document.createElement('video');
  el.muted = true;
  el.preload = 'auto';
  el.src = url;
  try {
    await once(el, 'loadedmetadata');
    if (!Number.isFinite(el.duration)) {
      // WebM from some recorders has no duration in its header; seeking far ahead makes the
      // browser scan to the end and report it.
      el.currentTime = 1e101;
      await once(el, 'seeked');
    }
    const durationMs = Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0;
    const width = el.videoWidth;
    const height = el.videoHeight;
    if (!width || !height) throw new Error('That file has no video picture.');

    let thumbnail: Blob | null = null;
    try {
      el.currentTime = Math.min(1, el.duration / 4 || 0);
      await once(el, 'seeked');
      const w = Math.min(640, width);
      const h = Math.round((height * w) / width);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')!.drawImage(el, 0, 0, w, h);
      thumbnail = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    } catch {
      thumbnail = null;
    }
    return { durationMs, width, height, thumbnail };
  } finally {
    el.removeAttribute('src');
    el.load();
    URL.revokeObjectURL(url);
  }
}
