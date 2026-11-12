/**
 * Draws the screen and the camera bubble into one video track.
 *
 * Frames are pulled with MediaStreamTrackProcessor readers and pushed into a
 * MediaStreamTrackGenerator. Nothing here uses requestAnimationFrame or timers: both stop or slow
 * to a crawl in a hidden tab, and while recording the user is almost always in another app.
 *
 * The camera drives the output (a steady ~30 fps) because screen capture only delivers a frame
 * when something on screen changes. Without a camera, the screen drives it.
 *
 * The bubble options object is read on every frame, so the recorder page changes shape, size,
 * position, mirror, filter and full camera mid-take by mutating it.
 */
import { type BubbleOptions, bubbleRect, cornerRadius, filterCss } from './bubble';
import { fitToQuality, type Quality } from './quality';

export interface Composite {
  track: MediaStreamTrack;
  width: number;
  height: number;
  bubble: BubbleOptions;
  /** A JPEG of the current output, about 640 px wide, for the library card. */
  snapshot(): Promise<Blob | null>;
  stop(): void;
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
  quality: Quality,
): Promise<Composite> {
  if (!screenTrack && !cameraTrack) throw new Error('Nothing to record');

  // Ask the capture pipeline to keep resolution over frame rate: text on screen stays legible.
  if (screenTrack) screenTrack.contentHint = 'detail';

  const screenReader = screenTrack ? new MediaStreamTrackProcessor({ track: screenTrack }).readable.getReader() : null;
  const cameraReader = cameraTrack ? new MediaStreamTrackProcessor({ track: cameraTrack }).readable.getReader() : null;

  let latestScreen: VideoFrame | null = screenReader ? await firstFrame(screenReader) : null;
  let latestCamera: VideoFrame | null = cameraReader ? await firstFrame(cameraReader) : null;

  const base = latestScreen ?? latestCamera!;
  const [width, height] = fitToQuality(base.displayWidth, base.displayHeight, quality);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  generator.contentHint = screenReader ? 'detail' : 'motion';
  const writer = generator.writable.getWriter();

  let stopped = false;
  let driver: 'camera' | 'screen' = cameraReader ? 'camera' : 'screen';
  const options = bubble;

  /** Center-crops the camera to the destination's aspect ratio, mirrored and filtered as set. */
  function drawCamera(frame: VideoFrame, dx: number, dy: number, dw: number, dh: number) {
    const sw = frame.displayWidth;
    const sh = frame.displayHeight;
    const scale = Math.max(dw / sw, dh / sh);
    const cw = dw / scale;
    const ch = dh / scale;
    ctx.save();
    ctx.filter = filterCss(options.filter);
    if (options.mirror) {
      ctx.translate(dx + dw, dy);
      ctx.scale(-1, 1);
      ctx.drawImage(frame, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, dw, dh);
    } else {
      ctx.drawImage(frame, (sw - cw) / 2, (sh - ch) / 2, cw, ch, dx, dy, dw, dh);
    }
    ctx.restore();
  }

  function drawContain(frame: VideoFrame) {
    const scale = Math.min(width / frame.displayWidth, height / frame.displayHeight);
    const w = frame.displayWidth * scale;
    const h = frame.displayHeight * scale;
    ctx.drawImage(frame, (width - w) / 2, (height - h) / 2, w, h);
  }

  function drawBubble(camera: VideoFrame) {
    const r = bubbleRect(options, width, height);
    const radius = cornerRadius(options.shape, r);
    const ring = Math.max(2, Math.round(Math.min(width, height) / 360));
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = ring * 6;
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, radius);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, radius);
    ctx.clip();
    drawCamera(camera, r.x, r.y, r.w, r.h);
    ctx.restore();
    ctx.beginPath();
    ctx.roundRect(r.x + ring / 2, r.y + ring / 2, r.w - ring, r.h - ring, Math.max(0, radius - ring / 2));
    ctx.lineWidth = ring;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
  }

  function render() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    const cameraShown = latestCamera && options.visible;
    if (latestScreen && !(cameraShown && options.fullCamera)) {
      drawContain(latestScreen);
      if (cameraShown) drawBubble(latestCamera!);
    } else if (latestCamera && (cameraShown || !latestScreen)) {
      drawCamera(latestCamera, 0, 0, width, height);
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
      const sctx = small.getContext('2d')!;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(canvas, 0, 0, w, h);
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
