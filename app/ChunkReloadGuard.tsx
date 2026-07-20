'use client';

import { useEffect } from 'react';
import { isChunkLoadError, reloadOnceForChunkError } from './chunkReload';

// Window-level net for stale-chunk failures that React error boundaries never
// see (§14.57): a rejected dynamic `import()` inside an async handler (e.g. the
// xterm load in ShellTerminal/LoginConsole) becomes an unhandledrejection, and
// a failed <script> chunk fires a window 'error' — neither reaches
// global-error.tsx / error.tsx. Mounted once in the root layout.
export default function ChunkReloadGuard() {
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isChunkLoadError(e.reason)) reloadOnceForChunkError('unhandledrejection');
    };
    const onError = (e: ErrorEvent) => {
      if (isChunkLoadError(e.error) || isChunkLoadError(e.message)) {
        reloadOnceForChunkError('window.error');
      }
    };
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, []);
  return null;
}
