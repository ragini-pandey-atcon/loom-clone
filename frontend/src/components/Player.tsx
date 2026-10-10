import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

import type { Comment, Reaction } from '../api/client';
import { formatClock } from '../lib/format';
import { IconFullscreen, IconMute, IconPause, IconPlay, IconVolume } from './Icons';
import { Menu } from './ui';

export interface PlayerHandle {
  seek(ms: number, play?: boolean): void;
  currentMs(): number;
  /** Shows an emoji floating up right now (your own reaction). */
  float(emoji: string, name: string): void;
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
}: {
  ref?: Ref<PlayerHandle>;
  src: string;
  fallbackDurationMs: number | null;
  comments: Comment[];
  reactions: Reaction[];
  /** Called with real playback time as it accumulates (for view counting). */
  onWatch?: (deltaMs: number, positionMs: number) => void;
  onEnded?: (positionMs: number) => void;
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

  const durationMs = mediaDuration ?? fallbackDurationMs ?? 0;

  const addFloater = useCallback((emoji: string, name: string) => {
    const key = ++floaterKey.current;
    setFloaters((list) => [...list.slice(-11), { key, emoji, name }]);
    setTimeout(() => setFloaters((list) => list.filter((f) => f.key !== key)), 2600);
  }, []);

  const seek = useCallback((ms: number, play = false) => {
    const el = video.current;
    if (!el) return;
    el.currentTime = Math.max(0, ms) / 1000;
    lastTime.current = el.currentTime * 1000;
    setCurrentMs(el.currentTime * 1000);
    if (play) void el.play().catch(() => {});
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      seek,
      currentMs: () => (video.current?.currentTime ?? 0) * 1000,
      float: addFloater,
    }),
    [seek, addFloater],
  );

  const toggle = useCallback(() => {
    const el = video.current;
    if (!el) return;
    if (el.paused || el.ended) void el.play().catch(() => {});
    else el.pause();
  }, []);

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

  function msAt(clientX: number): number {
    const rect = timeline.current!.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * durationMs;
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

  const pct = (ms: number) => `${durationMs > 0 ? Math.min(100, (ms / durationMs) * 100) : 0}%`;
  const topLevel = comments.filter((c) => !c.parentId && !c.deleted && c.timestampMs !== null);
  const recentReactions = reactions.slice(-MAX_REACTION_MARKERS);

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
        onLoadedMetadata={readDuration}
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
      />

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
          aria-valuenow={Math.round(currentMs / 1000)}
          aria-valuetext={`${formatClock(currentMs)} of ${formatClock(durationMs)}`}
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
              aria-label={`Comment by ${c.authorName} at ${formatClock(c.timestampMs)}`}
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
              aria-label={`${r.authorName} reacted ${r.emoji} at ${formatClock(r.timestampMs)}`}
              title={`${r.authorName} at ${formatClock(r.timestampMs)}`}
              onClick={() => seek(r.timestampMs)}
            >
              {r.emoji}
            </button>
          ))}
          {hoverMs !== null && (
            <span className="timeline-hover" style={{ left: pct(hoverMs) }}>
              {formatClock(hoverMs)}
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
            {formatClock(currentMs)} / {formatClock(durationMs)}
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
          <button type="button" className="icon-btn" onClick={toggleFullscreen} aria-label="Full screen">
            <IconFullscreen />
          </button>
        </div>
      </div>
    </div>
  );
}
