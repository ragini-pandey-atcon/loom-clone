import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { type SourceMode, shareUrl } from '../api/client';
import { AudioMeter } from '../components/AudioMeter';
import {
  IconCamera,
  IconMic,
  IconPause,
  IconPlay,
  IconRestart,
  IconScreen,
  IconScreenCamera,
  IconStop,
  IconTrash,
} from '../components/Icons';
import { LiveVideo } from '../components/LiveVideo';
import { ConfirmDialog, copyText, toast } from '../components/ui';
import { formatClock } from '../lib/format';
import { claimOwnerDevice } from '../lib/identity';
import type { BubbleCorner, BubbleOptions, BubbleSize } from '../recorder/compositor';
import { RecordingSession, setActiveSession, useActiveSession, useSessionState } from '../recorder/session';
import { recordingSupport } from '../recorder/support';

type DeviceProblem = 'denied' | 'missing' | 'busy' | 'error' | null;

const MODES: { value: SourceMode; label: string; icon: React.ReactNode }[] = [
  { value: 'screen_camera', label: 'Screen and camera', icon: <IconScreenCamera /> },
  { value: 'screen', label: 'Screen only', icon: <IconScreen /> },
  { value: 'camera', label: 'Camera only', icon: <IconCamera /> },
];

const CORNERS: { value: BubbleCorner; label: string }[] = [
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' },
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
];

const SIZES: { value: BubbleSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

function problemOf(error: unknown): DeviceProblem {
  const name = (error as DOMException)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'error';
}

function DeviceNotice({ kind, problem, onRetry }: { kind: 'camera' | 'microphone'; problem: DeviceProblem; onRetry: () => void }) {
  if (!problem) return null;
  if (problem === 'denied')
    return (
      <div className="notice" role="alert">
        <strong>The browser is blocking your {kind}.</strong>
        <ol>
          <li>Click the site settings icon at the left end of the address bar.</li>
          <li>Set {kind === 'camera' ? 'Camera' : 'Microphone'} to Allow.</li>
          <li>
            If it is already allowed, check Windows Settings, Privacy and security, {kind === 'camera' ? 'Camera' : 'Microphone'}.
          </li>
        </ol>
        <div>
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  if (problem === 'busy')
    return (
      <div className="notice" role="alert">
        <strong>Your {kind} is in use by another app.</strong>
        <span>Close the other app (a call, for example), then try again.</span>
        <div>
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  if (problem === 'missing')
    return (
      <div className="notice" role="status">
        <strong>No {kind} found.</strong>
        <span>{kind === 'camera' ? 'You can still record your screen.' : 'The recording will have no sound.'}</span>
      </div>
    );
  return (
    <div className="notice is-danger" role="alert">
      <strong>The {kind} could not start.</strong>
      <div>
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

/** Re-renders a few times a second while `on`, for the timer. */
function useTicker(on: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [on]);
}

export function RecordPage() {
  const support = recordingSupport();
  const session = useActiveSession();
  const state = useSessionState(session);

  useEffect(() => {
    claimOwnerDevice();
  }, []);

  // A finished or discarded session leaves the page in setup mode for the next recording.
  const phase = state?.phase;
  const inSetup = !session || phase === 'discarded' || phase === 'done' || phase === 'failed';

  if (!support.ok)
    return (
      <main className="page">
        <div className="empty">
          <h2>Recording isn't supported in this browser</h2>
          <p>{support.reason} You can still watch and comment on videos here.</p>
          <Link className="btn" to="/">
            Back to library
          </Link>
        </div>
      </main>
    );

  return <main className="page">{inSetup ? <Setup /> : <Recording session={session!} />}</main>;
}

// ---- setup (S05, S06) --------------------------------------------------------------------

function Setup() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<SourceMode>('screen_camera');
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState<string>('default');
  const [micId, setMicId] = useState<string>('default');
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [cameraProblem, setCameraProblem] = useState<DeviceProblem>(null);
  const [micProblem, setMicProblem] = useState<DeviceProblem>(null);
  const [cameraAttempt, setCameraAttempt] = useState(0);
  const [micAttempt, setMicAttempt] = useState(0);
  const [bubble, setBubble] = useState<BubbleOptions>({ corner: 'bottom-left', size: 'medium', visible: true });
  const [pickerMessage, setPickerMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const handedOver = useRef(false);

  const wantsCamera = mode !== 'screen' && cameraId !== 'none';

  const refreshDevices = useCallback(async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    setCameras(all.filter((d) => d.kind === 'videoinput' && d.deviceId));
    setMics(all.filter((d) => d.kind === 'audioinput' && d.deviceId));
  }, []);

  useEffect(() => {
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
  }, [refreshDevices]);

  // Camera preview. The stream is handed to the recording session at Start.
  useEffect(() => {
    if (!wantsCamera) {
      setCameraStream(null);
      setCameraProblem(null);
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({
        video: {
          deviceId: cameraId === 'default' ? undefined : { exact: cameraId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        setCameraStream(s);
        setCameraProblem(null);
        void refreshDevices();
      })
      .catch((e) => {
        if (!cancelled) {
          setCameraStream(null);
          setCameraProblem(problemOf(e));
        }
      });
    return () => {
      cancelled = true;
      if (!handedOver.current) stream?.getTracks().forEach((t) => t.stop());
    };
  }, [wantsCamera, cameraId, cameraAttempt, refreshDevices]);

  useEffect(() => {
    if (micId === 'none') {
      setMicStream(null);
      setMicProblem(null);
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({
        audio: {
          deviceId: micId === 'default' ? undefined : { exact: micId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        setMicStream(s);
        setMicProblem(null);
        void refreshDevices();
      })
      .catch((e) => {
        if (!cancelled) {
          setMicStream(null);
          setMicProblem(problemOf(e));
        }
      });
    return () => {
      cancelled = true;
      if (!handedOver.current) stream?.getTracks().forEach((t) => t.stop());
    };
  }, [micId, micAttempt, refreshDevices]);

  const cameraMissing = mode === 'camera' && !cameraStream;
  const canStart = !starting && !cameraMissing;

  async function start() {
    setPickerMessage(null);
    let display: MediaStream | null = null;
    if (mode !== 'camera') {
      // Must run inside the click: the browser only opens its picker for a user gesture.
      const controller = typeof CaptureController !== 'undefined' ? new CaptureController() : undefined;
      try {
        display = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: true,
          controller,
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
          systemAudio: 'include',
          monitorTypeSurfaces: 'include',
        } as DisplayMediaStreamOptions);
        // Stay on this tab for the countdown; the user switches when ready.
        try {
          controller?.setFocusBehavior('no-focus-change');
        } catch {
          /* not supported for this surface */
        }
      } catch (error) {
        const name = (error as DOMException)?.name;
        setPickerMessage(
          name === 'NotAllowedError'
            ? 'Screen sharing was cancelled. Pick a screen, window or tab to record.'
            : 'The screen could not be captured.',
        );
        return;
      }
    }

    setStarting(true);
    handedOver.current = true;
    const session = new RecordingSession(
      { display, camera: mode === 'screen' ? null : cameraStream, mic: micStream },
      mode,
      { ...bubble, visible: mode === 'screen_camera' && !!cameraStream },
    );
    if (mode === 'screen') cameraStream?.getTracks().forEach((t) => t.stop());
    setActiveSession(session);
    try {
      await session.prepare();
      if (await session.countdown()) await session.beginTake();
    } catch (error) {
      console.error(error);
      toast(error instanceof Error ? error.message : 'Recording could not start', 'error');
      await session.discard();
    }
  }

  return (
    <div className="recorder">
      <section aria-labelledby="setup-title">
        <div className="page-head">
          <h1 id="setup-title">New video</h1>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/')}>
            Cancel
          </button>
        </div>
        <div className="stage">
          {mode === 'camera' ? (
            cameraStream ? (
              <div className="camera-full" style={{ position: 'absolute', inset: 0 }}>
                <LiveVideo stream={cameraStream} label="Camera preview" />
              </div>
            ) : (
              <div className="stage-hint">
                <IconCamera />
                <span>Turn on a camera to record yourself.</span>
              </div>
            )
          ) : (
            <>
              <div className="stage-hint">
                <IconScreen />
                <span>Your browser asks which screen, window or tab to share when you start.</span>
              </div>
              {mode === 'screen_camera' && cameraStream && bubble.visible && (
                <div className={`bubble-preview corner-${bubble.corner} size-${bubble.size}`}>
                  <LiveVideo stream={cameraStream} label="Camera bubble preview" />
                </div>
              )}
            </>
          )}
        </div>
        {pickerMessage && (
          <div className="banner is-info" role="status" style={{ marginTop: 'var(--space-4)' }}>
            {pickerMessage}
          </div>
        )}
      </section>

      <aside className="panel stack" aria-label="Recording options">
        <div className="field">
          <span className="field-label" id="mode-label">
            Record
          </span>
          <div className="segmented" role="group" aria-labelledby="mode-label">
            {MODES.map((m) => (
              <button key={m.value} type="button" aria-pressed={mode === m.value} onClick={() => setMode(m.value)}>
                {m.icon}
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {mode !== 'screen' && (
          <div className="field">
            <label className="field-label" htmlFor="camera">
              <IconCamera width="1em" height="1em" style={{ verticalAlign: '-0.125em' }} /> Camera
            </label>
            <select id="camera" className="select" value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
              <option value="default">Default camera</option>
              {cameras.map((c, i) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label || `Camera ${i + 1}`}
                </option>
              ))}
              {mode === 'screen_camera' && <option value="none">No camera</option>}
            </select>
            <DeviceNotice kind="camera" problem={cameraProblem} onRetry={() => setCameraAttempt((n) => n + 1)} />
          </div>
        )}

        <div className="field">
          <label className="field-label" htmlFor="mic">
            <IconMic width="1em" height="1em" style={{ verticalAlign: '-0.125em' }} /> Microphone
          </label>
          <select id="mic" className="select" value={micId} onChange={(e) => setMicId(e.target.value)}>
            <option value="default">Default microphone</option>
            {mics.map((m, i) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label || `Microphone ${i + 1}`}
              </option>
            ))}
            <option value="none">No microphone</option>
          </select>
          {micStream && <AudioMeter stream={micStream} label="Microphone level" />}
          <DeviceNotice kind="microphone" problem={micProblem} onRetry={() => setMicAttempt((n) => n + 1)} />
        </div>

        {mode === 'screen_camera' && cameraStream && (
          <div className="field">
            <span className="field-label">Camera bubble</span>
            <div className="chip-row">
              <select
                className="select"
                aria-label="Bubble position"
                value={bubble.corner}
                onChange={(e) => setBubble((b) => ({ ...b, corner: e.target.value as BubbleCorner }))}
              >
                {CORNERS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <select
                className="select"
                aria-label="Bubble size"
                value={bubble.size}
                onChange={(e) => setBubble((b) => ({ ...b, size: e.target.value as BubbleSize }))}
              >
                {SIZES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <button type="button" className="btn btn-record btn-lg" onClick={start} disabled={!canStart}>
          <span className="rec-dot" style={{ background: 'currentColor' }} aria-hidden="true" />
          Start recording
        </button>
        <p className="muted" style={{ margin: 0 }}>
          A 3 second countdown runs first. Pause with Alt+Shift+P.
        </p>
      </aside>
    </div>
  );
}

// ---- recording (S07, S08) -----------------------------------------------------------------

function Recording({ session }: { session: RecordingSession }) {
  const navigate = useNavigate();
  const state = useSessionState(session)!;
  const [confirm, setConfirm] = useState<'restart' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const [bubble, setBubble] = useState<BubbleOptions>({ ...session.bubble });
  const live = state.phase === 'recording' || state.phase === 'paused';
  useTicker(state.running);

  const elapsed = state.elapsedMs + (state.running ? performance.now() - state.measuredAt : 0);

  useEffect(() => {
    if (!live) return;
    const previous = document.title;
    document.title = `${state.phase === 'paused' ? 'Paused' : 'Recording'} ${formatClock(elapsed)} · Async Video`;
    return () => {
      document.title = previous;
    };
  });

  // Leaving the page mid-take would lose the end of it.
  useEffect(() => {
    if (!live) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [live]);

  // The browser's own "Stop sharing" bar ended the take: open the video page.
  useEffect(() => {
    if (state.endedByBrowser && state.videoId && (state.phase === 'finishing' || state.phase === 'done')) {
      navigate(`/v/${state.videoId}?copy=1`);
    }
  }, [state.endedByBrowser, state.phase, state.videoId, navigate]);

  useEffect(() => {
    if (state.phase === 'discarded') {
      setActiveSession(null);
    }
  }, [state.phase]);

  const togglePause = useCallback(() => {
    if (state.phase === 'recording') session.pause();
    else if (state.phase === 'paused') session.resume();
  }, [session, state.phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && e.code === 'KeyP') {
        e.preventDefault();
        togglePause();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePause]);

  function stop() {
    const id = state.videoId;
    if (!id) return;
    // Copy inside the click: the clipboard only accepts writes during a user gesture.
    void copyText(shareUrl(id)).then((ok) => ok && toast('Link copied'));
    void session.stop();
    navigate(`/v/${id}`);
  }

  async function confirmAction() {
    setBusy(true);
    try {
      if (confirm === 'delete') {
        await session.discard();
        navigate('/');
      } else if (confirm === 'restart') {
        setConfirm(null);
        await session.restart();
      }
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  function updateBubble(patch: Partial<BubbleOptions>) {
    // The compositor reads these options on every frame, so changes apply mid-take.
    Object.assign(session.bubble, patch);
    setBubble({ ...session.bubble });
  }

  const hasBubble = session.mode === 'screen_camera' && session.bubble.visible;

  return (
    <section aria-labelledby="rec-title">
      <div className="page-head">
        <h1 id="rec-title">
          {state.phase === 'countdown' || state.phase === 'starting'
            ? 'Get ready'
            : state.phase === 'paused'
              ? 'Paused'
              : 'Recording'}
        </h1>
        <span className="muted">
          Switch to what you want to show. Come back here, or use the browser's Stop sharing bar, to finish.
        </span>
      </div>

      <div className="stage">
        {state.previewStream ? (
          <LiveVideo stream={state.previewStream} label="What is being recorded" />
        ) : (
          <div className="stage-hint">Starting…</div>
        )}
        {state.phase === 'countdown' && (
          <div className="countdown" aria-live="assertive">
            {state.countdown}
          </div>
        )}
      </div>

      <div className="control-bar" role="toolbar" aria-label="Recording controls">
        <span className={state.phase === 'paused' ? 'rec-dot is-paused' : 'rec-dot'} aria-hidden="true" />
        <span className="timer" aria-label={`Recorded ${formatClock(elapsed)}`}>
          {formatClock(elapsed)}
        </span>
        <button type="button" className="btn" onClick={togglePause} disabled={!live}>
          {state.phase === 'paused' ? <IconPlay /> : <IconPause />}
          {state.phase === 'paused' ? 'Resume' : 'Pause'}
        </button>
        <button type="button" className="btn" onClick={() => setConfirm('restart')} disabled={!live}>
          <IconRestart />
          Restart
        </button>
        <button type="button" className="btn btn-danger" onClick={() => setConfirm('delete')} disabled={busy}>
          <IconTrash />
          Delete
        </button>
        <span className="topbar-spacer" />
        {hasBubble && (
          <>
            <select
              className="select"
              style={{ width: 'auto' }}
              aria-label="Bubble position"
              value={bubble.corner}
              onChange={(e) => updateBubble({ corner: e.target.value as BubbleCorner })}
            >
              {CORNERS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <select
              className="select"
              style={{ width: 'auto' }}
              aria-label="Bubble size"
              value={bubble.size}
              onChange={(e) => updateBubble({ size: e.target.value as BubbleSize })}
            >
              {SIZES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </>
        )}
        <button type="button" className="btn btn-record btn-lg" onClick={stop} disabled={!live}>
          <IconStop />
          Stop and share
        </button>
      </div>
      {state.progress?.retrying && (
        <div className="banner" role="status" style={{ marginTop: 'var(--space-4)' }}>
          The local server isn't answering. Keep recording: chunks are kept and sent when it is back.
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'delete' ? 'Delete this recording?' : 'Start over?'}
        body={
          confirm === 'delete'
            ? 'The take is thrown away and cannot be recovered.'
            : 'This take is thrown away and a new countdown starts. Your screen and devices stay the same.'
        }
        confirmLabel={confirm === 'delete' ? 'Delete' : 'Start over'}
        danger
        busy={busy}
        onConfirm={confirmAction}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}
