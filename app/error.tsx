'use client';

import { useEffect } from 'react';
import { isChunkLoadError, reloadOnceForChunkError } from './chunkReload';

// Route-segment error boundary (§14.57). Catches render errors in the app shell
// (ClaudePanel, Sidebar, TabBar, modals) that fall OUTSIDE SessionErrorBoundary,
// so a bad render recovers here instead of white-screening to global-error.
// On a stale-chunk error, reload onto the fresh build; otherwise offer reset.
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
        background: '#181b24',
        color: '#dcdcdc',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <div style={{ textAlign: 'center', padding: 24, maxWidth: 420 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
          {chunk ? 'Mise à jour en cours…' : 'Une erreur est survenue'}
        </div>
        <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 20, lineHeight: 1.5 }}>
          {chunk
            ? 'Une nouvelle version a été déployée. La page se recharge automatiquement.'
            : "Cette vue a rencontré une erreur. Réessayer devrait la résoudre."}
        </div>
        <button
          onClick={() => (chunk ? window.location.reload() : reset())}
          style={{
            background: '#3b82f6',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            padding: '9px 18px',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {chunk ? 'Recharger' : 'Réessayer'}
        </button>
      </div>
    </div>
  );
}
