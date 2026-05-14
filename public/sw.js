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
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      // tout client charon est le panel
      await c.focus();
      c.postMessage({ type: 'open-session', sessionId: event.notification.data?.sessionId });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
