import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, captionsUrl, type Transcript, type Video } from '../api/client';
import { formatClock } from '../lib/format';
import { viewerId } from '../lib/identity';
import { startTranscript } from '../lib/transcriptAudio';
import { IconCopy, IconDownload, IconSearch } from './Icons';
import { copyText, toast } from './ui';

const POLL_MS = 2000;

/** Splits text around case-insensitive matches of `query`, for highlighting. */
function highlight(text: string, query: string) {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, at)) {
    if (i > at) parts.push(text.slice(at, i));
    parts.push(<mark key={i}>{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/**
 * The Transcript tab (Loom S12/S10): every line with its time, the line being spoken highlighted,
 * click to jump, search, copy, captions file. Times are file time; `offsetMs` (the trim start)
 * makes the shown times match the player clock.
 */
export function TranscriptPanel({
  video,
  owner,
  currentMs,
  offsetMs,
  onSeek,
  onChanged,
}: {
  video: Video;
  owner: boolean;
  currentMs: number;
  offsetMs: number;
  onSeek: (ms: number) => void;
  /** The transcript changed (ready, redone): the player reloads its captions. */
  onChanged: (t: Transcript) => void;
}) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [starting, setStarting] = useState(false);
  const [follow, setFollow] = useState(true);
  const list = useRef<HTMLOListElement>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const last = useRef<Transcript | null>(null);

  const load = useCallback(async () => {
    try {
      const t = await api.getTranscript(video.id, viewerId());
      const prev = last.current;
      if (!prev || prev.status !== t.status || prev.segments.length !== t.segments.length) onChangedRef.current(t);
      last.current = t;
      setTranscript(t);
      setFailed(false);
      return t;
    } catch {
      setFailed(true);
      return null;
    }
  }, [video.id]);

  useEffect(() => {
    setTranscript(null);
    last.current = null;
    void load();
  }, [load]);

  // While the model works, check back.
  const busy = transcript?.status === 'pending' || transcript?.status === 'running';
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);

  async function create() {
    setStarting(true);
    try {
      setTranscript(await startTranscript(video.id));
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The transcript could not be started', 'error');
    } finally {
      setStarting(false);
    }
  }

  const segments = useMemo(() => transcript?.segments ?? [], [transcript]);
  const q = query.trim();
  const shown = q ? segments.filter((s) => s.text.toLowerCase().includes(q.toLowerCase())) : segments;
  const active = segments.findIndex((s, i) => currentMs >= s.startMs && currentMs < (segments[i + 1]?.startMs ?? s.endMs + 1500));

  // Keep the spoken line in view while playing, unless the person scrolled away to read.
  useEffect(() => {
    if (!follow || q || active < 0) return;
    const el = list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, follow, q]);

  if (failed && !transcript) return <p className="muted">The transcript could not be loaded.</p>;
  if (!transcript) return <p className="muted">Loading the transcript…</p>;

  if (transcript.status === 'none' || transcript.status === 'failed')
    return (
      <div className="transcript-empty">
        {transcript.status === 'failed' ? (
          <p className="notice is-danger" role="alert">
            {transcript.error ?? 'The transcript could not be made.'}
          </p>
        ) : (
          <p className="muted">No transcript yet.</p>
        )}
        {owner && (
          <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={starting}>
            {starting ? 'Reading the sound…' : transcript.status === 'failed' ? 'Try again' : 'Create transcript'}
          </button>
        )}
        {owner && (
          <p className="muted">Made on this computer by a local speech model. Nothing is sent anywhere else.</p>
        )}
      </div>
    );

  if (busy)
    return (
      <div className="transcript-empty" aria-live="polite">
        <p>
          <strong>Writing the transcript…</strong>
        </p>
        <div className="progress is-indeterminate">
          <span />
        </div>
        <p className="muted">A local speech model is listening on this computer. It takes about a fifth of the video's length.</p>
      </div>
    );

  if (segments.length === 0)
    return (
      <div className="transcript-empty">
        <p className="muted">No speech was found in this video.</p>
        {owner && (
          <button type="button" className="btn" onClick={() => void create()} disabled={starting}>
            Try again
          </button>
        )}
      </div>
    );

  const fullText = segments.map((s) => s.text).join('\n');

  return (
    <div className="transcript">
      <div className="transcript-tools">
        <div className="search" role="search">
          <IconSearch />
          <label className="sr-only" htmlFor="transcript-search">
            Search the transcript
          </label>
          <input
            id="transcript-search"
            className="input"
            type="search"
            placeholder="Search the transcript"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="Copy the transcript"
          title="Copy the transcript"
          onClick={() => void copyText(fullText).then((ok) => toast(ok ? 'Transcript copied' : 'Copy failed', ok ? 'success' : 'error'))}
        >
          <IconCopy />
        </button>
        <a
          className="icon-btn"
          href={captionsUrl(video.id, viewerId())}
          download={`${video.title.replace(/[<>:"/\\|?*]/g, '_')}.vtt`}
          aria-label="Download captions"
          title="Download captions (.vtt)"
        >
          <IconDownload />
        </a>
      </div>
      {q && (
        <p className="muted" role="status">
          {shown.length === 0 ? `"${q}" is not said in this video.` : `${shown.length} ${shown.length === 1 ? 'line' : 'lines'}`}
        </p>
      )}
      <ol ref={list} className="transcript-lines" onWheel={() => setFollow(false)} onPointerLeave={() => setFollow(true)}>
        {shown.map((s) => {
          const index = segments.indexOf(s);
          return (
            <li key={s.startMs + ':' + index} data-index={index} className={index === active ? 'is-active' : undefined}>
              <button type="button" onClick={() => onSeek(s.startMs)} aria-label={`${formatClock(Math.max(0, s.startMs - offsetMs))}: ${s.text}`}>
                <span className="stamp">{formatClock(Math.max(0, s.startMs - offsetMs))}</span>
                <span className="transcript-text">{highlight(s.text, q)}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {owner && (
        <button type="button" className="link-btn" onClick={() => void create()} disabled={starting}>
          Redo the transcript
        </button>
      )}
    </div>
  );
}
