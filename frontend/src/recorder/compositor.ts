/**
 * Draws the screen and a round camera bubble into one video track.
 *
 * Frames are pulled with MediaStreamTrackProcessor readers and pushed into a
 * MediaStreamTrackGenerator. Nothing here uses requestAnimationFrame or timers: both stop or slow
 * to a crawl in a hidden tab, and while recording the user is almost always in another app.
 *
 * The camera drives the output (a steady ~30 fps) because screen capture only delivers a frame
 * when something on screen changes. Without a camera, the screen drives it.
 */

export type BubbleCorner = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
export type BubbleSize = 'small' | 'medium' | 'large';

export interface BubbleOptions {
  corner: BubbleCorner;
  size: BubbleSize;
  visible: boolean;
}

const BUBBLE_FRACTION: Record<BubbleSize, number> = { small: 0.16, medium: 0.22, large: 0.3 };
const MAX_W = 1920;
const MAX_H = 1080;

export interface Composite {
  track: MediaStreamTrack;
  width: number;
  height: number;
  bubble: BubbleOptions;
  /** A JPEG of the current output, about 640 px wide, for the library card. */
  snapshot(): Promise<Blob | null>;
  stop(): void;
}

function fitWithin(w: number, h: number): [number, number] {
  const scale = Math.min(1, MAX_W / w, MAX_H / h);
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return [even(w), even(h)];
}

async function firstFrame(reader: ReadableStreamDefaultReader<VideoFrame>): Promise<VideoFrame> {
  const { value, done } = await reader.read();
  if (done || !value) throw new Error('The video source ended before it started');
  return value;
}

export async function createComposite(
  screenTrack: MediaStreamTrack | null,
  cameraTrack: MediaStreamTrack | null,
  bubble: BubbleOptions,
): Promise<Composite> {
  if (!screenTrack && !cameraTrack) throw new Error('Nothing to record');

  const screenReader = screenTrack ? new MediaStreamTrackProcessor({ track: screenTrack }).readable.getReader() : null;
  const cameraReader = cameraTrack ? new MediaStreamTrackProcessor({ track: cameraTrack }).readable.getReader() : null;

  let latestScreen: VideoFrame | null = screenReader ? await firstFrame(screenReader) : null;
  let latestCamera: VideoFrame | null = cameraReader ? await firstFrame(cameraReader) : null;

  const base = latestScreen ?? latestCamera!;
  const [width, height] = fitWithin(base.displayWidth, base.displayHeight);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const writer = generator.writable.getWriter();

  let stopped = false;
  let driver: 'camera' | 'screen' = cameraReader ? 'camera' : 'screen';
  const options = bubble;

  function drawCover(frame: VideoFrame, dx: number, dy: number, dw: number, dh: number) {
    // Center-crop the frame to the destination's aspect ratio.
    const sw = frame.displayWidth;
    const sh = frame.displayHeight;
    const scale = Math.max(dw / sw, dh / sh);
    const cw = dw / scale;
    const ch = dh / scale;
    ctx.drawImage(frame, (sw - cw) / 2, (sh - ch) / 2, cw, ch, dx, dy, dw, dh);
  }

  function drawContain(frame: VideoFrame) {
    const scale = Math.min(width / frame.displayWidth, height / frame.displayHeight);
    const w = frame.displayWidth * scale;
    const h = frame.displayHeight * scale;
    ctx.drawImage(frame, (width - w) / 2, (height - h) / 2, w, h);
  }

  function render() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    if (latestScreen) {
      drawContain(latestScreen);
      if (latestCamera && options.visible) {
        const d = Math.round(Math.min(width, height) * BUBBLE_FRACTION[options.size]);
        const margin = Math.round(Math.min(width, height) * 0.03);
        const x = options.corner.endsWith('left') ? margin : width - margin - d;
        const y = options.corner.startsWith('top') ? margin : height - margin - d;
        ctx.save();
        ctx.beginPath();
        ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
        ctx.clip();
        drawCover(latestCamera, x, y, d, d);
        ctx.restore();
        ctx.beginPath();
        ctx.arc(x + d / 2, y + d / 2, d / 2 - 1.5, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
      }
    } else if (latestCamera) {
      drawCover(latestCamera, 0, 0, width, height);
    }
    // Drop a frame rather than queue it when the encoder is behind.
    if (writer.desiredSize !== null && writer.desiredSize <= 0) return;
    // Our own clock, so switching the driver (camera unplugged) never sends time backwards.
    // alpha: 'discard' keeps the encoder from recording an alpha plane nobody can see.
    const out = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000), alpha: 'discard' });
    writer.write(out).catch(() => out.close());
  }

  async function pump(source: 'screen' | 'camera', reader: ReadableStreamDefaultReader<VideoFrame>) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || stopped) {
          value?.close();
          break;
        }
        if (source === 'screen') {
          latestScreen?.close();
          latestScreen = value;
        } else {
          latestCamera?.close();
          latestCamera = value;
        }
        if (driver === source) render();
      }
    } catch {
      /* the track was stopped */
    }
    if (source === 'camera' && !stopped) {
      // Camera unplugged mid-take: keep recording the screen, without the bubble.
      latestCamera?.close();
      latestCamera = null;
      driver = 'screen';
    }
  }

  render();
  if (screenReader) void pump('screen', screenReader);
  if (cameraReader) void pump('camera', cameraReader);

  return {
    track: generator,
    width,
    height,
    bubble: options,
    async snapshot() {
      const w = Math.min(640, width);
      const h = Math.round((height * w) / width);
      const small = new OffscreenCanvas(w, h);
      small.getContext('2d')!.drawImage(canvas, 0, 0, w, h);
      try {
        return await small.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
      } catch {
        return null;
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      screenReader?.cancel().catch(() => {});
      cameraReader?.cancel().catch(() => {});
      latestScreen?.close();
      latestCamera?.close();
      latestScreen = latestCamera = null;
      writer.close().catch(() => {});
      generator.stop();
    },
  };
}
