import { Link, NavLink, Outlet, Route, Routes, useLocation } from 'react-router';

import { BrandMark, IconRecord } from './components/Icons';
import { Toasts } from './components/ui';
import { formatClock } from './lib/format';
import { useIsOwnerDevice } from './lib/identity';
import { LibraryPage } from './pages/LibraryPage';
import { RecordPage } from './pages/RecordPage';
import { VideoPage } from './pages/VideoPage';
import { WatchLaterPage } from './pages/WatchLaterPage';
import { useActiveSession, useSessionState } from './recorder/session';

function Shell() {
  const owner = useIsOwnerDevice();
  const { pathname } = useLocation();
  const session = useActiveSession();
  const state = useSessionState(session);
  const recording = state && (state.phase === 'recording' || state.phase === 'paused' || state.phase === 'countdown');
  const onRecorder = pathname === '/record';
  // Viewers opening a shared link see the video, not the owner's library.
  const showNav =
    owner || pathname === '/' || pathname === '/archive' || pathname.startsWith('/folders/') || onRecorder;

  return (
    <>
      <header className="topbar">
        <Link className="brand" to={showNav ? '/' : pathname} aria-label="Async Video home">
          <BrandMark className="brand-mark" />
          <span className="brand-name">Async Video</span>
        </Link>
        {showNav && (
          <nav className="topnav" aria-label="Library">
            <NavLink to="/" end>
              Library
            </NavLink>
            <NavLink to="/watch-later">Watch later</NavLink>
            <NavLink to="/archive">Archive</NavLink>
          </nav>
        )}
        {!showNav && pathname !== '/watch-later' && (
          <nav className="topnav" aria-label="Your list">
            <NavLink to="/watch-later">Watch later</NavLink>
          </nav>
        )}
        <span className="topbar-spacer" />
        {recording && !onRecorder && (
          <Link className="btn btn-record" to="/record">
            <span className="rec-dot" style={{ background: 'currentColor' }} aria-hidden="true" />
            {state.phase === 'countdown' ? 'Starting' : state.phase === 'paused' ? 'Paused' : 'Recording'}{' '}
            {state.phase !== 'countdown' && formatClock(state.elapsedMs)}: back to recorder
          </Link>
        )}
        {showNav && !recording && !onRecorder && (
          <Link className="btn btn-record" to="/record">
            <IconRecord />
            New video
          </Link>
        )}
      </header>
      <Outlet />
      <Toasts />
    </>
  );
}

function NotFound() {
  return (
    <main className="page">
      <div className="empty">
        <h2>Page not found</h2>
        <Link className="btn" to="/">
          Go to the library
        </Link>
      </div>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<LibraryPage archived={false} />} />
        <Route path="archive" element={<LibraryPage archived />} />
        <Route path="folders/:folderId" element={<LibraryPage archived={false} />} />
        <Route path="watch-later" element={<WatchLaterPage />} />
        <Route path="record" element={<RecordPage />} />
        <Route path="v/:id" element={<VideoPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
