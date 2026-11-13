/**
 * Floating recording controls (and, optionally, your camera) in a small always-on-top window, so
 * you can pause or stop while working in another app. Chrome and Edge's Document
 * Picture-in-Picture: a real window the page renders into, which stays above every other app.
 *
 * It is its own React root: the PiP document is not inside the app's DOM, so a portal would not
 * receive events there. State comes from the recording session store, which both roots read.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';

import { shareUrl } from '../api/client';
import { formatClock } from '../lib/format';
import { filterCss } from '../recorder/bubble';
import { loadPreferences } from '../recorder/preferences';
import { type RecordingSession, useSessionState } from '../recorder/session';
import { IconPause, IconPlay, IconStop } from './Icons';
import { LiveVideo } from './LiveVideo';

declare global {
  interface DocumentPictureInPicture extends EventTarget {
    requestWindow(options?: { width?: number; height?: number; disallowReturnToOpener?: boolean }): Promise<Window>;
    readonly window: Window | null;
  }
  var documentPictureInPicture: DocumentPictureInPicture | undefined;
}

export function floatingSupported(): boolean {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
}

// ---- the one floating window ------------------------------------------------------------------

let current: Window | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function useFloatingWindow(): Window | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}

export function closeFloating() {
  current?.close();
}

/** Copies the page's styles into the PiP document, so the controls look like the app. */
function copyStyles(target: Document) {
  for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
    target.head.append(node.cloneNode(true));
  }
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme) target.documentElement.setAttribute('data-theme', theme);
}

/**
 * Opens the floating controls. Needs a user gesture (a click), so call it straight from one.
 * Resolves false when the browser refused (no gesture left, or not supported).
 */
export async function openFloating(session: RecordingSession): Promise<boolean> {
  if (!floatingSupported() || current) return !!current;
  // A whole shared screen captures this window too, so the camera starts hidden there:
  // the recording already has the bubble, and a second face would be recorded.
  const showCamera = session.hasCamera && session.displaySurface !== 'monitor';
  let pip: Window;
  try {
    pip = await window.documentPictureInPicture!.requestWindow(
      showCamera ? { width: 300, height: 340 } : { width: 360, height: 96 },
    );
  } catch {
    return false;
  }
  copyStyles(pip.document);
  pip.document.title = 'Recording controls';
  const mount = pip.document.createElement('div');
  pip.document.body.style.margin = '0';
  pip.document.body.append(mount);
  const root = createRoot(mount);
  root.render(<FloatingBar session={session} pip={pip} initialCamera={showCamera} />);
  current = pip;
  emit();
  pip.addEventListener('pagehide', () => {
    root.unmount();
    if (current === pip) current = null;
    emit();
  });
  return true;
}

function FloatingBar({ session, pip, initialCamera }: { session: RecordingSession; pip: Window; initialCamera: boolean }) {
  const state = useSessionState(session)!;
  const [showCamera, setShowCamera] = useState(initialCamera);
  const [, tick] = useState(0);
  const [showTimer] = useState(() => loadPreferences().showTimer);
  const live = state.phase === 'recording' || state.phase === 'paused';

  useEffect(() => {
    if (!state.running) return;
    const id = pip.setInterval(() => tick((n) => n + 1), 250);
    return () => pip.clearInterval(id);
  }, [state.running, pip]);

  // The take ended (here, on the recorder page, or by the browser's Stop sharing bar).
  useEffect(() => {
    if (state.phase === 'finishing' || state.phase === 'done' || state.phase === 'discarded' || state.phase === 'failed') {
      pip.close();
    }
  }, [state.phase, pip]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && e.code === 'KeyP') {
        e.preventDefault();
        if (state.phase === 'recording') session.pause();
        else if (state.phase === 'paused') session.resume();
      }
    };
    pip.addEventListener('keydown', onKey);
    return () => pip.removeEventListener('keydown', onKey);
  }, [pip, session, state.phase]);

  async function stop() {
    const id = state.videoId;
    if (!id) return;
    // Inside the click, so the clipboard accepts it; the video page offers Copy if it did not.
    let copied = false;
    try {
      await pip.navigator.clipboard.writeText(shareUrl(id));
      copied = true;
    } catch {
      try {
        await navigator.clipboard.writeText(shareUrl(id));
        copied = true;
      } catch {
        copied = false;
      }
    }
    void session.stopOutside(copied);
  }

  const elapsed = state.elapsedMs + (state.running ? performance.now() - state.measuredAt : 0);
  const camera = showCamera ? session.cameraStream : null;
  const bubble = session.bubble;

  return (
    <div className={camera ? 'float-root' : 'float-root no-camera'}>
      {camera && (
        <div className="float-camera bubble-video" style={{ filter: filterCss(bubble.filter) }} data-mirror={bubble.mirror}>
          <LiveVideo stream={camera} label="Your camera" />
        </div>
      )}
      <div className="float-bar" role="toolbar" aria-label="Recording controls">
        <span className={state.phase === 'paused' ? 'rec-dot is-paused' : 'rec-dot'} aria-hidden="true" />
        {showTimer && <span className="timer">{state.phase === 'countdown' ? state.countdown : formatClock(elapsed)}</span>}
        <button
          type="button"
          className="btn"
          disabled={!live}
          onClick={() => (state.phase === 'paused' ? session.resume() : session.pause())}
        >
          {state.phase === 'paused' ? <IconPlay /> : <IconPause />}
          {state.phase === 'paused' ? 'Resume' : 'Pause'}
        </button>
        <button type="button" className="btn btn-record" disabled={!live} onClick={() => void stop()}>
          <IconStop />
          Stop
        </button>
        {session.hasCamera && (
          <button
            type="button"
            className="btn btn-ghost"
            aria-pressed={showCamera}
            onClick={() => {
              const next = !showCamera;
              setShowCamera(next);
              pip.resizeTo(next ? 300 : 360, next ? 340 : 96);
            }}
            style={{ color: 'inherit' }}
          >
            {showCamera ? 'Hide me' : 'Show me'}
          </button>
        )}
      </div>
      {camera && session.displaySurface === 'monitor' && (
        <p className="float-note">This window is in the recording when you share your whole screen.</p>
      )}
    </div>
  );
}
