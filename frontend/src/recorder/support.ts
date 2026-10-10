/**
 * Recording needs Chromium's "breakout box" (MediaStreamTrackProcessor and Generator) to composite
 * the camera bubble without timers, which hidden tabs throttle. Chrome and Edge have it; other
 * browsers can still watch videos.
 */

declare global {
  interface MediaStreamTrackProcessorInit {
    track: MediaStreamTrack;
    maxBufferSize?: number;
  }
  var MediaStreamTrackProcessor: {
    prototype: { readable: ReadableStream<VideoFrame> };
    new (init: MediaStreamTrackProcessorInit): { readable: ReadableStream<VideoFrame> };
  };
  /** Conditional Focus: lets the recorder keep its own tab in front during the countdown. */
  class CaptureController {
    setFocusBehavior(behavior: 'focus-captured-surface' | 'no-focus-change'): void;
  }
  interface MediaStreamVideoTrackGenerator extends MediaStreamTrack {
    writable: WritableStream<VideoFrame>;
  }
  var MediaStreamTrackGenerator: {
    prototype: MediaStreamVideoTrackGenerator;
    new (init: { kind: 'video' }): MediaStreamVideoTrackGenerator;
  };
}

const MIME_CANDIDATES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

export function recordingSupport(): { ok: true } | { ok: false; reason: string } {
  if (!window.isSecureContext) return { ok: false, reason: 'Open the app on localhost to record.' };
  if (!navigator.mediaDevices?.getDisplayMedia) return { ok: false, reason: 'This browser cannot capture the screen.' };
  if (typeof MediaStreamTrackProcessor === 'undefined' || typeof MediaStreamTrackGenerator === 'undefined')
    return { ok: false, reason: 'Recording needs Chrome or Edge.' };
  if (!pickMimeType()) return { ok: false, reason: 'This browser cannot record WebM video.' };
  return { ok: true };
}
