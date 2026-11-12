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
import { BubbleLayer, CameraControls, CameraFill, useLiveBubble } from '../components/CameraBubble';
import { LiveVideo } from '../components/LiveVideo';
import { ConfirmDialog, copyText, toast } from '../components/ui';
import { formatClock } from '../lib/format';
import { claimOwnerDevice } from '../lib/identity';
import type { BubbleOptions } from '../recorder/bubble';
import { loadPreferences, type RecorderPreferences, savePreferences } from '../recorder/preferences';
import { QUALITIES, type Quality, screenQuality } from '../recorder/quality';
import { RecordingSession, setActiveSession, useActiveSession, useSessionState } from '../recorder/session';
import { recordingSupport } from '../recorder/support';

type DeviceProblem = 'denied' | 'missing' | 'busy' | 'error' | null;

const MODES: { value: SourceMode; label: string; icon: React.ReactNode }[] = [
  { value: 'screen_camera', label: 'Screen and camera', icon: <IconScreenCamera /> },
  { value: 'screen', label: 'Screen only', icon: <IconScreen /> },
  { value: 'camera', label: 'Camera only', icon: <IconCamera /> },
];

/** Setup has no screen yet: the stage stands in for a 1080p screen, and positions carry over. */
const SETUP_FRAME = { width: 1920, height: 1080 };

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
  const [prefs, setPrefs] = useState<RecorderPreferences>(loadPreferences);
  const bubble = prefs.bubble;
  const [pickerMessage, setPickerMessage] = useState<string | null>(null);

  // Settings carry over to the next recording (Loom: "Defaults").
  useEffect(() => savePreferences(prefs), [prefs]);
  const updatePrefs = (patch: Partial<RecorderPreferences>) => setPrefs((p) => ({ ...p, ...patch }));
  const updateBubble = (patch: Partial<BubbleOptions>) => setPrefs((p) => ({ ...p, bubble: { ...p.bubble, ...patch } }));
  const fitsScreen = screenQuality();
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
          // Full HD, so a large bubble, full camera and camera-only recordings stay sharp.
          width: { ideal: 1920 },
          height: { ideal: 1080 },
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
        // Capture at the chosen quality (never above the screen's own size); the compositor
        // fits the output to the same box.
        const q = QUALITIES.find((x) => x.value === prefs.quality) ?? QUALITIES[1];
        display = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: q.width * 2 }, height: { ideal: q.height } },
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
      { ...bubble, visible: mode === 'screen_camera' && !!cameraStream, fullCamera: false },
      prefs.quality,
      prefs.countdown,
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
              <CameraFill stream={cameraStream} bubble={bubble} />
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
              {mode === 'screen_camera' && cameraStream && (
                <BubbleLayer
                  outWidth={SETUP_FRAME.width}
                  outHeight={SETUP_FRAME.height}
                  bubble={bubble}
                  onChange={updateBubble}
                  cameraStream={cameraStream}
                />
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
          <div className="segmented is-stacked" role="group" aria-labelledby="mode-label">
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

        {mode !== 'screen' && cameraStream && (
          <fieldset className="option-group">
            <legend>{mode === 'screen_camera' ? 'Camera bubble' : 'Camera'}</legend>
            {mode === 'screen_camera' && (
              <p className="muted" style={{ margin: 0 }}>
                Drag the bubble on the preview to place it. It snaps to the sides and corners.
              </p>
            )}
            <CameraControls bubble={bubble} onChange={updateBubble} showBubble={mode === 'screen_camera'} />
          </fieldset>
        )}

        <fieldset className="option-group">
          <legend>Recording</legend>
          <div className="field">
            <label className="field-label" htmlFor="quality">
              Video quality
            </label>
            <select
              id="quality"
              className="select"
              value={prefs.quality}
              onChange={(e) => updatePrefs({ quality: e.target.value as Quality })}
            >
              {QUALITIES.map((q) => (
                <option key={q.value} value={q.value}>
                  {q.label}
                </option>
              ))}
            </select>
            <span className="muted">
              {mode === 'camera'
                ? 'Camera recordings go up to your camera’s own resolution, usually 1080p.'
                : `Never larger than what you share${
                    fitsScreen ? `: this screen fills up to ${QUALITIES.find((x) => x.value === fitsScreen)?.label}` : ''
                  }. 1440p and 4K need a fast computer.`}
            </span>
          </div>
          <label className="toggle">
            <span>3 second countdown</span>
            <input
              type="checkbox"
              role="switch"
              checked={prefs.countdown}
              onChange={(e) => updatePrefs({ countdown: e.target.checked })}
            />
          </label>
          <label className="toggle">
            <span>Show recording time</span>
            <input
              type="checkbox"
              role="switch"
              checked={prefs.showTimer}
              onChange={(e) => updatePrefs({ showTimer: e.target.checked })}
            />
          </label>
        </fieldset>

        <button type="button" className="btn btn-record btn-lg" onClick={start} disabled={!canStart}>
          <span className="rec-dot" style={{ background: 'currentColor' }} aria-hidden="true" />
          Start recording
        </button>
        <p className="muted" style={{ margin: 0 }}>
          {prefs.countdown ? 'A 3 second countdown runs first. ' : ''}Pause with Alt+Shift+P. Your settings are kept for
          next time.
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
  // The compositor reads session.bubble on every frame, so changes apply mid-take; they are also
  // remembered for the next recording.
  const [bubble, updateBubble] = useLiveBubble(session.bubble, (b) => {
    if (session.hasCamera) savePreferences({ ...loadPreferences(), bubble: b });
  });
  const [showTimer] = useState(() => loadPreferences().showTimer);
  const live = state.phase === 'recording' || state.phase === 'paused';
  const output = state.previewStream ? session.outputSize : null;
  useTicker(state.running);

  const elapsed = state.elapsedMs + (state.running ? performance.now() - state.measuredAt : 0);

  useEffect(() => {
    if (!live) return;
    const previous = document.title;
    document.title = `${state.phase === 'paused' ? 'Paused' : 'Recording'}${showTimer ? ` ${formatClock(elapsed)}` : ''} · Async Video`;
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

  const hasBubble = session.mode === 'screen_camera' && session.hasCamera;

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
        {output && (
          <span className="chip" title={`Recording quality chosen: ${session.quality}`}>
            {output.width} × {output.height}
          </span>
        )}
      </div>

      <div className="stage">
        {state.previewStream ? (
          <LiveVideo stream={state.previewStream} label="What is being recorded" />
        ) : (
          <div className="stage-hint">Starting…</div>
        )}
        {hasBubble && output && bubble.visible && (
          <BubbleLayer
            outWidth={output.width}
            outHeight={output.height}
            bubble={bubble}
            onChange={updateBubble}
            allowFullCamera
          />
        )}
        {state.phase === 'countdown' && (
          <div className="countdown" aria-live="assertive">
            {state.countdown}
          </div>
        )}
      </div>

      <div className="control-bar" role="toolbar" aria-label="Recording controls">
        <span className={state.phase === 'paused' ? 'rec-dot is-paused' : 'rec-dot'} aria-hidden="true" />
        {showTimer && (
          <span className="timer" aria-label={`Recorded ${formatClock(elapsed)}`}>
            {formatClock(elapsed)}
          </span>
        )}
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
        <button type="button" className="btn btn-record btn-lg" onClick={stop} disabled={!live}>
          <IconStop />
          Stop and share
        </button>
      </div>
      {session.hasCamera && (
        <div className="panel live-camera" aria-label="Camera">
          <CameraControls bubble={bubble} onChange={updateBubble} showBubble={hasBubble} live />
        </div>
      )}
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
