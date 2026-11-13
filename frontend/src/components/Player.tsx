import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

import type { Comment, Reaction } from '../api/client';
import { formatClock } from '../lib/format';
import { IconCaptions, IconFullscreen, IconMute, IconPause, IconPlay, IconTheater, IconVolume } from './Icons';

const CAPTIONS_KEY = 'loom-clone.captions';

function captionsWanted(): boolean {
  try {
    return localStorage.getItem(CAPTIONS_KEY) === '1';
  } catch {
    return false;
  }
}
import { Menu } from './ui';

export interface PlayerHandle {
  seek(ms: number, play?: boolean): void;
  currentMs(): number;
  /** Shows an emoji floating up right now (your own reaction). */
  float(emoji: string, name: string): void;
  /** A JPEG of the frame on screen now (for a custom thumbnail). */
  snapshot(): Promise<Blob | null>;
}

interface Floater {
  key: number;
  emoji: string;
  name: string;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const MAX_REACTION_MARKERS = 50;
const IDLE_MS = 2500;

export function Player({
  ref,
  src,
  fallbackDurationMs,
  comments,
  reactions,
  onWatch,
  onEnded,
  windowStartMs = 0,
  windowEndMs = null,
  initialMs,
  initialRate,
  theater = false,
  onToggleTheater,
  captionsSrc,
  onTime,
}: {
  ref?: Ref<PlayerHandle>;
  src: string;
  fallbackDurationMs: number | null;
  comments: Comment[];
  reactions: Reaction[];
  /** Called with real playback time as it accumulates (for view counting). */
  onWatch?: (deltaMs: number, positionMs: number) => void;
  onEnded?: (positionMs: number) => void;
  /**
   * The trim window, in file time. Only this part plays, and the timeline and clock show it
   * from 0:00. Everything the player hands out (seek, currentMs, comment times) stays file time.
   */
  windowStartMs?: number;
  windowEndMs?: number | null;
  /** Start here (file time), for links shared at a timestamp. */
  initialMs?: number;
  /** The owner's recommended speed: playback starts at it. */
  initialRate?: number;
  theater?: boolean;
  onToggleTheater?: () => void;
  /** WebVTT captions from the transcript; a CC button appears when given. */
  captionsSrc?: string;
  /** The playhead (file time), whenever it moves. */
  onTime?: (ms: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const lastTime = useRef(0);
  const floaterKey = useRef(0);
  const dragging = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const [bufferedMs, setBufferedMs] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);
  const [idle, setIdle] = useState(false);
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [error, setError] = useState(false);

  const [captionsOn, setCaptionsOn] = useState(captionsWanted);
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;
  useEffect(() => onTimeRef.current?.(currentMs), [currentMs]);

  // Show or hide the caption track; "hidden" still loads it, so turning it on is instant.
  const applyCaptions = useCallback(() => {
    const track = video.current?.textTracks[0];
    if (track) track.mode = captionsOn ? 'showing' : 'hidden';
  }, [captionsOn]);
  useEffect(applyCaptions, [applyCaptions, captionsSrc]);

  const fileDurationMs = mediaDuration ?? fallbackDurationMs ?? 0;
  const startMs = Math.max(0, windowStartMs);
  const endMs = windowEndMs !== null && fileDurationMs > 0 ? Math.min(windowEndMs, fileDurationMs) : windowEndMs ?? fileDurationMs;
  /** What the viewer sees as the length. */
  const durationMs = Math.max(0, endMs - startMs);
  const clampToWindow = useCallback((ms: number) => Math.min(Math.max(ms, startMs), endMs || Infinity), [startMs, endMs]);
  const initialDone = useRef(false);

  const addFloater = useCallback((emoji: string, name: string) => {
    const key = ++floaterKey.current;
    setFloaters((list) => [...list.slice(-11), { key, emoji, name }]);
    setTimeout(() => setFloaters((list) => list.filter((f) => f.key !== key)), 2600);
  }, []);

  const seek = useCallback(
    (ms: number, play = false) => {
      const el = video.current;
      if (!el) return;
      el.currentTime = clampToWindow(ms) / 1000;
      lastTime.current = el.currentTime * 1000;
      setCurrentMs(el.currentTime * 1000);
      if (play) void el.play().catch(() => {});
    },
    [clampToWindow],
  );

  // A changed trim (the editor previews it live) moves the playhead inside the new window.
  useEffect(() => {
    const el = video.current;
    if (!el || el.readyState < 1) return;
    const now = el.currentTime * 1000;
    if (now < startMs - 1 || (endMs && now > endMs + 1)) seek(now < startMs ? startMs : endMs);
  }, [startMs, endMs, seek]);

  // Stop exactly at the end of the trim window: timeupdate fires only every ~250 ms, video
  // frames fire every frame.
  useEffect(() => {
    const el = video.current;
    if (!el || !playing || !windowEndMs || typeof el.requestVideoFrameCallback !== 'function') return;
    let handle = 0;
    const check = () => {
      if (el.currentTime * 1000 >= endMs) {
        el.pause();
        el.currentTime = endMs / 1000;
        setPlaying(false);
        setIdle(false);
        onEnded?.(endMs);
        return;
      }
      handle = el.requestVideoFrameCallback(check);
    };
    handle = el.requestVideoFrameCallback(check);
    return () => el.cancelVideoFrameCallback(handle);
  }, [playing, windowEndMs, endMs, onEnded]);

  useImperativeHandle(
    ref,
    () => ({
      seek,
      currentMs: () => (video.current?.currentTime ?? 0) * 1000,
      float: addFloater,
      snapshot: async () => {
        const el = video.current;
        if (!el || !el.videoWidth) return null;
        const w = Math.min(1280, el.videoWidth);
        const h = Math.round((el.videoHeight * w) / el.videoWidth);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d')!.drawImage(el, 0, 0, w, h);
        return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
      },
    }),
    [seek, addFloater],
  );

  const toggle = useCallback(() => {
    const el = video.current;
    if (!el) return;
    if (el.paused || el.ended) {
      // At the end of the window, play starts over from the beginning of it.
      if (el.ended || (endMs && el.currentTime * 1000 >= endMs - 50)) el.currentTime = startMs / 1000;
      void el.play().catch(() => {});
    } else el.pause();
  }, [startMs, endMs]);

  const wake = useCallback(() => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
  }, []);

  useEffect(() => () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
  }, []);

  function onTimeUpdate() {
    const el = video.current!;
    const now = el.currentTime * 1000;
    // Fallback for the frame check above (and for browsers without it).
    if (windowEndMs && now >= endMs && !el.paused) {
      el.pause();
      el.currentTime = endMs / 1000;
      onEnded?.(endMs);
    }
    const delta = now - lastTime.current;
    // Small forward steps are playback; anything else is a seek and shows no reactions.
    if (delta > 0 && delta < 1500 && !el.paused) {
      onWatch?.(delta / el.playbackRate, now);
      for (const r of reactions) {
        if (r.timestampMs > lastTime.current && r.timestampMs <= now) addFloater(r.emoji, r.authorName);
      }
    }
    lastTime.current = now;
    setCurrentMs(now);
    if (el.buffered.length) setBufferedMs(el.buffered.end(el.buffered.length - 1) * 1000);
  }

  function readDuration() {
    const d = video.current?.duration;
    setMediaDuration(d && Number.isFinite(d) ? d * 1000 : null);
  }

  function onMetadata() {
    readDuration();
    if (initialDone.current) return;
    initialDone.current = true;
    if (initialRate && video.current) video.current.playbackRate = initialRate;
    const at = initialMs ?? startMs;
    if (at > 0) seek(at);
  }

  /** File time under the pointer. */
  function msAt(clientX: number): number {
    const rect = timeline.current!.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return startMs + frac * durationMs;
  }

  function onKey(e: React.KeyboardEvent) {
    const el = video.current;
    if (!el || (e.target as HTMLElement).closest('.menu')) return;
    const step = (ms: number) => seek(el.currentTime * 1000 + ms);
    switch (e.key) {
      case ' ':
      case 'k':
        if ((e.target as HTMLElement).tagName === 'BUTTON' && e.key === ' ') return;
        e.preventDefault();
        toggle();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        step(-5000);
        break;
      case 'ArrowRight':
        e.preventDefault();
        step(5000);
        break;
      case 'j':
        step(-10000);
        break;
      case 'l':
        step(10000);
        break;
      case 'm':
        el.muted = !el.muted;
        break;
      case 'f':
        toggleFullscreen();
        break;
      default:
        return;
    }
    wake();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen().catch(() => {});
  }

  /** Position of a file time on the timeline. */
  const pct = (ms: number) =>
    `${durationMs > 0 ? Math.min(100, Math.max(0, ((ms - startMs) / durationMs) * 100)) : 0}%`;
  const inWindow = (ms: number) => ms >= startMs && (!endMs || ms <= endMs);
  const shown = (ms: number) => formatClock(Math.max(0, ms - startMs));
  const topLevel = comments.filter((c) => !c.parentId && !c.deleted && c.timestampMs !== null && inWindow(c.timestampMs));
  const recentReactions = reactions.filter((r) => inWindow(r.timestampMs)).slice(-MAX_REACTION_MARKERS);

  return (
    <div
      ref={root}
      className={playing && idle ? 'player is-idle' : 'player'}
      tabIndex={0}
      aria-label="Video player. Space to play or pause, arrow keys to skip 5 seconds."
      onKeyDown={onKey}
      onPointerMove={wake}
      onPointerLeave={() => playing && setIdle(true)}
    >
      <video
        ref={video}
        src={src}
        preload="metadata"
        playsInline
        onClick={toggle}
        onDoubleClick={toggleFullscreen}
        onPlay={() => {
          setPlaying(true);
          setStarted(true);
          wake();
        }}
        onPause={() => {
          setPlaying(false);
          setIdle(false);
        }}
        onEnded={() => {
          setPlaying(false);
          setIdle(false);
          onEnded?.((video.current?.currentTime ?? 0) * 1000);
        }}
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onMetadata}
        onDurationChange={readDuration}
        onProgress={() => {
          const el = video.current;
          if (el?.buffered.length) setBufferedMs(el.buffered.end(el.buffered.length - 1) * 1000);
        }}
        onVolumeChange={() => {
          setMuted(video.current!.muted);
          setVolume(video.current!.volume);
        }}
        onRateChange={() => setRate(video.current!.playbackRate)}
        onError={() => setError(true)}
      >
        {captionsSrc && <track key={captionsSrc} kind="captions" label="Captions" src={captionsSrc} default={captionsOn} onLoad={applyCaptions} />}
      </video>

      {error && (
        <div className="player-message" role="alert">
          <strong>This video can't be played.</strong>
          <span>The file may still be finishing, or it was removed.</span>
        </div>
      )}

      {!started && !error && (
        <button type="button" className="player-big-play" onClick={toggle} aria-label="Play video">
          <span>
            <IconPlay />
          </span>
        </button>
      )}

      <div className="floaters" aria-hidden="true">
        {floaters.map((f) => (
          <span key={f.key} className="floater" style={{ marginLeft: `calc(var(--space-2) * ${((f.key * 37) % 5) - 2})` }}>
            {f.emoji}
            <small>{f.name}</small>
          </span>
        ))}
      </div>

      <div className="player-controls">
        <div
          ref={timeline}
          className="timeline"
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(durationMs / 1000)}
          aria-valuenow={Math.round(Math.max(0, currentMs - startMs) / 1000)}
          aria-valuetext={`${shown(currentMs)} of ${formatClock(durationMs)}`}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('.timeline-marker')) return;
            dragging.current = true;
            timeline.current?.setPointerCapture(e.pointerId);
            seek(msAt(e.clientX));
          }}
          onPointerMove={(e) => {
            setHoverMs(msAt(e.clientX));
            if (dragging.current) seek(msAt(e.clientX));
          }}
          onPointerUp={(e) => {
            dragging.current = false;
            timeline.current?.releasePointerCapture(e.pointerId);
          }}
          onPointerLeave={() => setHoverMs(null)}
        >
          <div className="timeline-track">
            <div className="timeline-buffered" style={{ width: pct(bufferedMs) }} />
            <div className="timeline-fill" style={{ width: pct(currentMs) }} />
          </div>
          <div className="timeline-thumb" style={{ left: pct(currentMs) }} />
          {topLevel.map((c) => (
            <button
              key={c.id}
              type="button"
              className="timeline-marker is-comment"
              style={{ left: pct(c.timestampMs!) }}
              aria-label={`Comment by ${c.authorName} at ${shown(c.timestampMs!)}`}
              title={`${c.authorName}: ${c.body.slice(0, 80)}`}
              onClick={() => seek(c.timestampMs!)}
            />
          ))}
          {recentReactions.map((r) => (
            <button
              key={r.id}
              type="button"
              className="timeline-marker"
              style={{ left: pct(r.timestampMs) }}
              aria-label={`${r.authorName} reacted ${r.emoji} at ${shown(r.timestampMs)}`}
              title={`${r.authorName} at ${shown(r.timestampMs)}`}
              onClick={() => seek(r.timestampMs)}
            >
              {r.emoji}
            </button>
          ))}
          {hoverMs !== null && (
            <span className="timeline-hover" style={{ left: pct(hoverMs) }}>
              {shown(hoverMs)}
            </span>
          )}
        </div>

        <div className="player-row">
          <button type="button" className="icon-btn" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <IconPause /> : <IconPlay />}
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              if (video.current) video.current.muted = !video.current.muted;
            }}
            aria-label={muted ? 'Unmute' : 'Mute'}
          >
            {muted || volume === 0 ? <IconMute /> : <IconVolume />}
          </button>
          <input
            className="player-volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            aria-label="Volume"
            onChange={(e) => {
              const el = video.current;
              if (!el) return;
              el.volume = Number(e.target.value);
              el.muted = el.volume === 0;
            }}
            style={{ width: 'var(--space-12)', accentColor: 'var(--c-player-fill)' }}
          />
          <span className="player-time">
            {shown(currentMs)} / {formatClock(durationMs)}
          </span>
          <span className="player-spacer" />
          <Menu
            label="Playback speed"
            up
            triggerClassName="speed-btn"
            trigger={`${rate}x`}
            items={SPEEDS.map((s) => ({
              label: s === 1 ? 'Normal' : `${s}x`,
              onSelect: () => {
                if (video.current) video.current.playbackRate = s;
              },
            }))}
          />
          {captionsSrc && (
            <button
              type="button"
              className="icon-btn"
              aria-label={captionsOn ? 'Hide captions' : 'Show captions'}
              aria-pressed={captionsOn}
              title={captionsOn ? 'Hide captions' : 'Show captions'}
              onClick={() =>
                setCaptionsOn((on) => {
                  try {
                    localStorage.setItem(CAPTIONS_KEY, on ? '0' : '1');
                  } catch {
                    /* the choice just isn't remembered */
                  }
                  return !on;
                })
              }
            >
              <IconCaptions />
            </button>
          )}
          {onToggleTheater && (
            <button
              type="button"
              className="icon-btn"
              onClick={onToggleTheater}
              aria-label={theater ? 'Default view' : 'Theater mode'}
              aria-pressed={theater}
              title={theater ? 'Default view' : 'Theater mode'}
            >
              <IconTheater />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={toggleFullscreen} aria-label="Full screen">
            <IconFullscreen />
          </button>
        </div>
      </div>
    </div>
  );
}
