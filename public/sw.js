// Service worker pour les notifications push de Charon.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || 'Charon';
  const opts = {
    body: data.body || '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: data.tag || data.sessionId || 'charon',
    renotify: true,
    data: { url: data.url || '/', sessionId: data.sessionId || null },
  };
  event.waitUntil((async () => {
    await self.registration.showNotification(title, opts);
    // Ask an open tab to play the custom in-app sound (/notif.wav). We
    // target a single client (focused/visible preferred) to avoid
    // multi-playing across tabs. The OS still plays its own (non-
    // customizable) notification sound on top when the tab isn't focused;
    // that's a web-platform limitation. Background tabs may have their
    // audio throttled by the browser — best-effort.
    try {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const target =
        all.find((c) => c.focused) ||
        all.find((c) => c.visibilityState === 'visible') ||
        all[0];
      if (target) target.postMessage({ type: 'notif-sound' });
    } catch {}
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const sessionId = data.sessionId || null;
  // Fallback URL: only used when no Charon tab is open. Server-side this
  // is `/?session=<id>` (see sessionOps.ts § _maybePush) — desktop hub
  // ClaudePanel reads ?session=… via useSearchParams.
  const fallbackUrl = data.url || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length > 0) {
      // Prefer the tab the user is actively looking at, then any visible
      // tab, then the first one. This avoids stealing focus from a tab
      // the user already cares about (e.g. cross-device, multi-tab).
      const target =
        all.find((c) => c.focused) ||
        all.find((c) => c.visibilityState === 'visible') ||
        all[0];
      try { await target.focus(); } catch {}
      // The root layout (`NotificationClickHandler`) receives this and
      // routes via Next router — desktop → `/?session=…`,
      // mobile → `/m/chat?id=…`. We pass the fallback URL too so the
      // handler can use it as last resort if pathname detection fails.
      try {
        target.postMessage({ type: 'open-session', sessionId, url: fallbackUrl });
      } catch {}
      return;
    }
    // No Charon tab is open — open one. The page will switch to the
    // right session on mount via ?session=… (desktop). Mobile users
    // hitting this branch (rare) get the MobileRedirectPrompt.
    try { await self.clients.openWindow(fallbackUrl); } catch {}
  })());
});
