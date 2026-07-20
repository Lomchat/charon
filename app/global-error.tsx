'use client';

import { useEffect } from 'react';
import { isChunkLoadError, reloadOnceForChunkError } from './chunkReload';

// Root error boundary (§14.57). Replaces the ENTIRE document (including the root
// layout) when an error reaches the top, so it must render its own <html>/<body>.
// Without this file Next.js shows its raw "Application error: a client-side
// exception has occurred" white screen. Here: auto-reload onto the fresh build
// on a stale-chunk error, otherwise a controlled recover screen — never the raw
// white page.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (isChunkLoadError(error)) reloadOnceForChunkError('global-error');
  }, [error]);

  const chunk = isChunkLoadError(error);
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
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
              : "L'interface a rencontré une erreur inattendue. Recharger devrait la résoudre."}
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
            Recharger
          </button>
        </div>
      </body>
    </html>
  );
}
