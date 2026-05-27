'use client';
import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';

// Listens for `open-session` messages sent by the service worker (sw.js)
// when the user clicks a push notification. We do the routing here, at
// the root layout level, so it works on every Charon page:
//
//   - Desktop (`/`)           → push `?session=<id>`, ClaudePanel's
//                               useSearchParams effect switches selectedId.
//   - Mobile (`/m/...`)       → push `/m/chat?id=<id>` via Next router
//                               (client-side route, no full reload, draft
//                               state preserved).
//   - Anywhere else (login,
//     setup, etc.)            → same routing rules; middleware redirects
//                               to /login if needed.
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
  const pathname = usePathname() ?? '';
  const router = useRouter();

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.type !== 'open-session' || typeof d.sessionId !== 'string' || !d.sessionId) return;
      const sessionId = d.sessionId as string;
      const target = pathname.startsWith('/m')
        ? `/m/chat?id=${encodeURIComponent(sessionId)}`
        : `/?session=${encodeURIComponent(sessionId)}`;
      router.push(target);
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, [pathname, router]);

  return null;
}
