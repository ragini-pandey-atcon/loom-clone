/**
 * One recording session: the captured streams plus the current take. Restart throws the take away
 * and starts a new one on the same streams, so device choices survive. The session lives at module
 * level, not in a component, so it keeps finishing the upload after the app navigates to the
 * video page at Stop.
 */
import { useSyncExternalStore } from 'react';

import { api, ApiError, type SourceMode } from '../api/client';
import { viewerId } from '../lib/identity';
import { startTranscript } from '../lib/transcriptAudio';
import { fixWebm } from '../lib/webmFix';
import type { BubbleOptions } from './bubble';
import { type Composite, createComposite } from './compositor';
import { bitrateFor, type Quality } from './quality';
import { pickMimeType } from './support';
import { ChunkUploader, type UploadProgress } from './uploader';

export type Phase =
  | 'starting'
  | 'countdown'
  | 'recording'
  | 'paused'
  | 'finishing'
  | 'done'
  | 'failed'
  | 'discarded';

export interface SessionState {
  phase: Phase;
  videoId: string | null;
  countdown: number;
  /** Recorded time, excluding pauses, as of `measuredAt`. */
  elapsedMs: number;
  measuredAt: number;
  running: boolean;
  progress: UploadProgress | null;
  error: string | null;
  endedByBrowser: boolean;
  /** Stop was pressed in the floating controls; the recorder page opens the video page. */
  stoppedOutside: { linkCopied: boolean } | null;
  /** A video reply: null until finished, then whether it was posted on the original video. */
  replyPosted: boolean | null;
  previewStream: MediaStream | null;
}

export interface Streams {
  display: MediaStream | null;
  camera: MediaStream | null;
  mic: MediaStream | null;
}

const COUNTDOWN_SECONDS = 3;
const TIMESLICE_MS = 1000;

/** Recording in answer to another video (Loom: Record a video reply). */
export interface ReplyTarget {
  videoId: string;
  title: string;
  authorName: string;
}

function defaultTitle(): string {
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
  return `Recording, ${when}`;
}

export class RecordingSession {
  private state: SessionState = {
    phase: 'starting',
    videoId: null,
    countdown: COUNTDOWN_SECONDS,
    elapsedMs: 0,
    measuredAt: performance.now(),
    running: false,
    progress: null,
    error: null,
    endedByBrowser: false,
    stoppedOutside: null,
    replyPosted: null,
    previewStream: null,
  };
  private listeners = new Set<() => void>();
  private composite: Composite | null = null;
  private recorder: MediaRecorder | null = null;
  private uploader: ChunkUploader | null = null;
  private audioContext: AudioContext | null = null;
  private recordStream: MediaStream | null = null;
  private thumbnail: Blob | null = null;
  private thumbTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private countdownDone: (() => void) | null = null;
  private stopped: Promise<void> | null = null;
  private finalizing = false;
  private readonly mimeType = pickMimeType() ?? 'video/webm';

  constructor(
    private readonly streams: Streams,
    readonly mode: SourceMode,
    readonly bubble: BubbleOptions,
    readonly quality: Quality,
    private readonly useCountdown: boolean,
    readonly replyTo: ReplyTarget | null = null,
  ) {
    // The browser's own "Stop sharing" bar ends the screen track. Finish the take cleanly.
    streams.display?.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.state.phase === 'recording' || this.state.phase === 'paused') {
        this.set({ endedByBrowser: true });
        void this.stop();
      } else if (this.state.phase === 'countdown' || this.state.phase === 'starting') {
        void this.discard();
      }
    });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getState = () => this.state;

  private set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Builds the composite track and the recorded stream. Called once per session. */
  async prepare(): Promise<void> {
    const screen = this.streams.display?.getVideoTracks()[0] ?? null;
    const camera = this.streams.camera?.getVideoTracks()[0] ?? null;
    this.composite = await createComposite(screen, camera, this.bubble, this.quality);

    const audio = this.mixAudio();
    this.recordStream = new MediaStream([this.composite.track, ...(audio ? [audio] : [])]);
    this.set({ previewStream: new MediaStream([this.composite.track]) });
  }

  /** Mic, the shared tab or system audio, or both mixed into one track. */
  private mixAudio(): MediaStreamTrack | null {
    const sources = [this.streams.mic, this.streams.display].filter(
      (s): s is MediaStream => !!s && s.getAudioTracks().length > 0,
    );
    if (sources.length === 0) return null;
    if (sources.length === 1) return sources[0].getAudioTracks()[0];
    this.audioContext = new AudioContext();
    const out = this.audioContext.createMediaStreamDestination();
    for (const s of sources) this.audioContext.createMediaStreamSource(s).connect(out);
    return out.stream.getAudioTracks()[0];
  }

  /** The camera stream, for the floating window's own preview. */
  get cameraStream(): MediaStream | null {
    return this.streams.camera;
  }

  /** What was shared: 'monitor' (a whole screen), 'window' or 'browser' (a tab), or null. */
  get displaySurface(): string | null {
    const track = this.streams.display?.getVideoTracks()[0];
    return (track?.getSettings() as { displaySurface?: string } | undefined)?.displaySurface ?? null;
  }

  /** Stop from the floating controls, which live outside the app's router. */
  stopOutside(linkCopied: boolean): Promise<void> {
    this.set({ stoppedOutside: { linkCopied } });
    return this.stop();
  }

  /** A camera was captured for this session (it may be turned off in the recording mid-take). */
  get hasCamera(): boolean {
    return (this.streams.camera?.getVideoTracks().length ?? 0) > 0;
  }

  /** The size actually being recorded: the chosen quality, or smaller when the source is smaller. */
  get outputSize(): { width: number; height: number } | null {
    return this.composite ? { width: this.composite.width, height: this.composite.height } : null;
  }

  /** 3, 2, 1. Resolves false when the countdown was cancelled. Instant when the setting is off. */
  countdown(): Promise<boolean> {
    if (!this.useCountdown) return Promise.resolve(true);
    this.set({ phase: 'countdown', countdown: COUNTDOWN_SECONDS });
    return new Promise((resolve) => {
      this.countdownDone = () => resolve(false);
      this.countdownTimer = setInterval(() => {
        const next = this.state.countdown - 1;
        if (next <= 0) {
          this.clearCountdown();
          resolve(true);
        } else {
          this.set({ countdown: next });
        }
      }, 1000);
    });
  }

  private clearCountdown() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    this.countdownDone = null;
  }

  /** Starts a take: the video row (and so the link) exists from the first second. */
  async beginTake(): Promise<void> {
    if (!this.recordStream || !this.composite) throw new Error('Session not prepared');
    const title = this.replyTo ? `Reply to ${this.replyTo.title}`.slice(0, 200) : defaultTitle();
    const video = await api.createVideo({ title, sourceMode: this.mode, mimeType: this.mimeType });
    const uploader = new ChunkUploader(video.id, (progress) => this.set({ progress }));
    const recorder = new MediaRecorder(this.recordStream, {
      mimeType: this.mimeType,
      videoBitsPerSecond: bitrateFor(this.composite.width, this.composite.height),
      audioBitsPerSecond: 128_000,
      // A keyframe at least every 2 s keeps seeking precise. Ignored where unsupported.
      videoKeyFrameIntervalDuration: 2000,
    } as MediaRecorderOptions);
    recorder.ondataavailable = (e) => uploader.push(e.data);
    this.stopped = new Promise((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.onerror = () => {
      this.set({ error: 'The browser stopped the recording.' });
      void this.stop();
    };
    this.uploader = uploader;
    this.recorder = recorder;
    this.thumbnail = null;
    recorder.start(TIMESLICE_MS);
    this.set({
      phase: 'recording',
      videoId: video.id,
      elapsedMs: 0,
      measuredAt: performance.now(),
      running: true,
      progress: uploader.progress(),
      error: null,
    });
    this.thumbTimer = setTimeout(() => void this.grabThumbnail(), 1200);
  }

  private async grabThumbnail() {
    const blob = await this.composite?.snapshot();
    if (blob) this.thumbnail = blob;
  }

  private freezeClock(): number {
    const now = performance.now();
    return this.state.running ? this.state.elapsedMs + (now - this.state.measuredAt) : this.state.elapsedMs;
  }

  pause() {
    if (this.state.phase !== 'recording' || this.recorder?.state !== 'recording') return;
    this.recorder.pause();
    this.set({ phase: 'paused', elapsedMs: this.freezeClock(), measuredAt: performance.now(), running: false });
  }

  resume() {
    if (this.state.phase !== 'paused' || this.recorder?.state !== 'paused') return;
    this.recorder.resume();
    this.set({ phase: 'recording', measuredAt: performance.now(), running: true });
  }

  /** Ends the take and finishes the upload. Safe to call twice. */
  async stop(): Promise<void> {
    const { phase } = this.state;
    if (phase !== 'recording' && phase !== 'paused') return;
    const elapsed = this.freezeClock();
    this.set({ phase: 'finishing', elapsedMs: elapsed, measuredAt: performance.now(), running: false });
    if (this.thumbTimer) clearTimeout(this.thumbTimer);
    if (!this.thumbnail) await this.grabThumbnail();
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    await this.stopped;
    this.release();
    await this.finish();
  }

  /** Repairs the WebM and finalizes. Re-runnable after a failure (the Retry button). */
  async finish(): Promise<void> {
    const uploader = this.uploader;
    const videoId = this.state.videoId;
    if (!uploader || !videoId || this.finalizing) return;
    this.finalizing = true;
    this.set({ phase: 'finishing', error: null });
    try {
      await uploader.drain();
      const recording = new Blob(uploader.chunks, { type: this.mimeType });
      let header: Uint8Array<ArrayBuffer> = new Uint8Array(0);
      let bodyOffset = 0;
      let durationMs = Math.round(this.state.elapsedMs);
      try {
        const fix = await fixWebm(recording);
        header = fix.header;
        bodyOffset = fix.bodyOffset;
        durationMs = fix.durationMs;
      } catch (error) {
        // The video still plays without the repair, it just cannot seek well.
        console.warn('WebM repair failed; saving the recording unrepaired', error);
      }
      const query = {
        chunkCount: uploader.chunks.length,
        bodyOffset,
        durationMs,
        width: this.composite?.width,
        height: this.composite?.height,
      };
      try {
        await api.finalize(videoId, header, query);
      } catch (error) {
        const missing = (error as ApiError).detail as { missing?: number[] } | null;
        if (!(error instanceof ApiError) || error.status !== 409 || !missing?.missing) throw error;
        await uploader.resend(missing.missing);
        await api.finalize(videoId, header, query);
      }
      if (this.thumbnail) await api.putThumbnail(videoId, this.thumbnail).catch(() => {});
      if (this.replyTo && this.state.replyPosted === null) {
        // Posted only once the reply plays, so nobody follows a link to a half-uploaded video.
        const posted = await api
          .addComment(this.replyTo.videoId, {
            authorId: viewerId(),
            authorName: this.replyTo.authorName,
            body: 'Recorded a video reply',
            replyVideoId: videoId,
          })
          .then(() => true, () => false);
        this.set({ replyPosted: posted });
      }
      this.set({ phase: 'done' });
      // The transcript follows in the background: the video is watchable already. The repaired
      // file decodes most reliably; a take with no microphone has no audio and gets an empty one.
      const playable = header.length ? new Blob([header, recording.slice(bodyOffset)], { type: this.mimeType }) : recording;
      void startTranscript(videoId, playable).catch((e) => console.warn('Transcript not started', e));
    } catch (error) {
      this.set({
        phase: 'failed',
        error: error instanceof Error ? error.message : 'The upload did not finish.',
      });
    } finally {
      this.finalizing = false;
    }
  }

  /** Throws the current take away (confirmed in the UI) and counts down to a new one. */
  async restart(): Promise<void> {
    await this.dropTake();
    if (await this.countdown()) await this.beginTake();
  }

  /** Deletes the take and releases the camera, mic and screen. */
  async discard(): Promise<void> {
    if (this.countdownDone) {
      const done = this.countdownDone;
      this.clearCountdown();
      done();
    }
    await this.dropTake();
    this.release();
    this.set({ phase: 'discarded' });
  }

  private async dropTake() {
    if (this.thumbTimer) clearTimeout(this.thumbTimer);
    const videoId = this.state.videoId;
    this.uploader?.cancel();
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.ondataavailable = null;
      this.recorder.stop();
      await this.stopped;
    }
    this.recorder = null;
    this.uploader = null;
    this.set({ videoId: null, progress: null, elapsedMs: 0, running: false });
    if (videoId) await api.deleteVideo(videoId).catch(() => {});
  }

  private release() {
    this.composite?.stop();
    for (const s of [this.streams.display, this.streams.camera, this.streams.mic]) s?.getTracks().forEach((t) => t.stop());
    void this.audioContext?.close().catch(() => {});
    this.audioContext = null;
    this.set({ previewStream: null });
  }
}

// ---- the one active session ----------------------------------------------------------------

let current: RecordingSession | null = null;
const storeListeners = new Set<() => void>();

export function setActiveSession(session: RecordingSession | null) {
  current = session;
  storeListeners.forEach((l) => l());
}

export function activeSession(): RecordingSession | null {
  return current;
}

const subscribeActive = (listener: () => void) => {
  storeListeners.add(listener);
  return () => storeListeners.delete(listener);
};

export function useActiveSession(): RecordingSession | null {
  return useSyncExternalStore(subscribeActive, activeSession, () => null);
}

const idleState = (): SessionState | null => null;

export function useSessionState(session: RecordingSession | null): SessionState | null {
  return useSyncExternalStore(session?.subscribe ?? subscribeActive, session?.getState ?? idleState, idleState);
}

export function isBusy(session: RecordingSession | null): boolean {
  const phase = session?.getState().phase;
  return phase === 'countdown' || phase === 'recording' || phase === 'paused' || phase === 'finishing';
}
