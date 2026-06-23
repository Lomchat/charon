'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Listens for `open-session` messages sent by the service worker (sw.js)
// when the user clicks a push notification. We do the routing here, at
// the root layout level, so it works on every Charon page: push
// `/?session=<id>` and ClaudePanel's useSearchParams effect switches
// selectedId (no full reload, draft state preserved). Middleware redirects
// to /login first if the session expired. Now that the UI is a single
// responsive app at `/`, there is no longer a mobile (`/m/...`) branch.
//
// The service worker prefers focus+postMessage to opening a new tab — this
// handler is what gives "focused tab + correct session" its meaning. If
// no Charon tab existed, the SW falls back to openWindow(`/?session=<id>`),
// and ClaudePanel still picks the session up on mount.
//
// Note: ClaudePanel.tsx has its own duplicate listener that calls
// setSelectedId directly. Harmless redundancy on desktop; we keep it as
// a safety net but the canonical routing path is now this one.
export default function NotificationClickHandler() {
  const router = useRouter();

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.type !== 'open-session' || typeof d.sessionId !== 'string' || !d.sessionId) return;
      const sessionId = d.sessionId as string;
      router.push(`/?session=${encodeURIComponent(sessionId)}`);
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, [router]);

  return null;
}
