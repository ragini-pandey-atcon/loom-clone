import { useRef, useState } from 'react';

import { api, thumbnailUrl, type Video } from '../api/client';
import { IconImage, IconVideo } from './Icons';
import { toast } from './ui';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** Any image the browser can show, re-encoded as the JPEG the API stores (at most 1280 px wide). */
export async function imageToJpeg(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That file is not an image this browser can read.');
  });
  const w = Math.min(1280, bitmap.width);
  const h = Math.round((bitmap.height * w) / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  if (!blob) throw new Error('The image could not be converted.');
  return blob;
}

/** Owner-only Settings tab (Loom's S14): who sees and can do what on this one video. */
export function VideoSettings({
  video,
  onVideoChanged,
  grabFrame,
}: {
  video: Video;
  onVideoChanged: (v: Video) => void;
  /** A JPEG of the frame the player shows now, for "Use the current frame". */
  grabFrame: () => Promise<Blob | null>;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [thumbBusy, setThumbBusy] = useState(false);
  const [thumbVersion, setThumbVersion] = useState(0);

  // Saves go one at a time, and only the newest answer is shown: two quick switch flips must not
  // let the first answer (which predates the second flip) undo the second.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const seq = useRef(0);

  function patch(body: Parameters<typeof api.patchVideo>[1]) {
    const mine = ++seq.current;
    // Show the change at once.
    onVideoChanged({ ...video, ...body } as Video);
    queue.current = queue.current.then(async () => {
      try {
        const saved = await api.patchVideo(video.id, body);
        if (mine === seq.current) onVideoChanged(saved);
      } catch {
        toast('The setting was not saved', 'error');
        // Show what the server really has.
        if (mine === seq.current) await api.getVideo(video.id).then(onVideoChanged, () => {});
      }
    });
  }

  async function setThumbnail(source: () => Promise<Blob | null>) {
    setThumbBusy(true);
    try {
      const jpeg = await source();
      if (!jpeg) throw new Error('No frame to use yet. Play the video to the moment you want first.');
      await api.putThumbnail(video.id, jpeg);
      setThumbVersion((n) => n + 1);
      onVideoChanged(await api.getVideo(video.id));
      toast('Thumbnail updated');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The thumbnail was not saved', 'error');
    } finally {
      setThumbBusy(false);
    }
  }

  const switches: { field: 'commentsEnabled' | 'reactionsEnabled' | 'showViewCount' | 'downloadsEnabled'; label: string; help: string }[] = [
    { field: 'commentsEnabled', label: 'Comments', help: 'Turning it off keeps the comments already there.' },
    { field: 'reactionsEnabled', label: 'Emoji reactions', help: 'Turning it off hides reactions from viewers.' },
    { field: 'showViewCount', label: 'Show view count to viewers', help: 'You always see it.' },
    { field: 'downloadsEnabled', label: 'Viewers can download', help: 'You can always download your own videos.' },
  ];

  return (
    <div className="settings">
      {switches.map((s) => (
        <label key={s.field} className="toggle">
          <span>
            {s.label}
            <span className="muted toggle-help">{s.help}</span>
          </span>
          <input type="checkbox" role="switch" checked={video[s.field]} onChange={(e) => void patch({ [s.field]: e.target.checked })} />
        </label>
      ))}

      <div className="field">
        <label className="field-label" htmlFor="recommended-speed">
          Recommended playback speed
        </label>
        <select
          id="recommended-speed"
          className="select"
          value={video.recommendedSpeed ?? 1}
          onChange={(e) => {
            const speed = Number(e.target.value);
            void patch({ recommendedSpeed: speed === 1 ? null : speed });
          }}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s === 1 ? 'Normal' : `${s}x`}
            </option>
          ))}
        </select>
        <span className="muted">Viewers start at this speed and can still change it.</span>
      </div>

      <div className="field">
        <span className="field-label">Thumbnail</span>
        <div className="thumb-setting">
          <div className="thumb-preview">
            {video.hasThumbnail ? (
              <img src={`${thumbnailUrl(video)}&n=${thumbVersion}`} alt="Current thumbnail" />
            ) : (
              <IconVideo />
            )}
          </div>
          <div className="stack" style={{ gap: 'var(--space-2)' }}>
            <button
              type="button"
              className="btn"
              disabled={thumbBusy || video.status !== 'ready'}
              onClick={() => void setThumbnail(grabFrame)}
            >
              <IconVideo />
              Use the current frame
            </button>
            <button type="button" className="btn" disabled={thumbBusy} onClick={() => file.current?.click()}>
              <IconImage />
              Upload an image
            </button>
            <input
              ref={file}
              type="file"
              accept="image/*"
              hidden
              aria-label="Thumbnail image"
              data-testid="thumbnail-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void setThumbnail(() => imageToJpeg(f));
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
