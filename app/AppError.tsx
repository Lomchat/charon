'use client';

import { useEffect } from 'react';
import { isChunkLoadError, reloadOnceForChunkError } from './chunkReload';

// What THE page error boundary shows (§14.57, web/mount.tsx): render errors in
// the app shell (HubPanel, Sidebar, TabBar, modals) that fall outside
// SessionErrorBoundary. On a stale-chunk error, reload onto the fresh build;
// otherwise offer reset.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (isChunkLoadError(error)) reloadOnceForChunkError('app-error');
  }, [error]);

  const chunk = isChunkLoadError(error);
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        // The theme tokens come from <html data-theme> (server-rendered).
        background: 'var(--bg)',
        color: 'var(--text)',
        fontFamily: 'var(--body)',
      }}
    >
      <div style={{ textAlign: 'center', padding: 24, maxWidth: 420 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
          {chunk ? 'Updating…' : 'Something went wrong'}
        </div>
        <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 20, lineHeight: 1.5 }}>
          {chunk
            ? 'A new version has been deployed. This page will reload automatically.'
            : "This view encountered an error. Try again to recover."}
        </div>
        <button
          onClick={() => (chunk ? window.location.reload() : reset())}
          style={{
            background: 'var(--accent)',
            color: 'var(--bg)',
            border: 'none',
            borderRadius: 8,
            padding: '9px 18px',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {chunk ? 'Reload' : 'Try again'}
        </button>
      </div>
    </div>
  );
}
