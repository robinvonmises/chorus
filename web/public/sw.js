// Minimaler Service Worker: macht die App installierbar und zeigt Benachrichtigungen an.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const chat = e.notification.data && e.notification.data.chatId;
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
    for (const c of cs) { c.focus(); c.postMessage({ openChat: chat }); return; }
    return self.clients.openWindow('/' + (chat ? '#chat=' + encodeURIComponent(chat) : ''));
  }));
});

// Echte Push-Benachrichtigungen vom Chorus-Server
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    // Chat ist gerade offen und sichtbar: keine Benachrichtigung (außer auf iOS, das verlangt immer eine)
    const ios = /iPhone|iPad|iPod/.test(self.navigator.userAgent);
    const open = d.chatId && cs.some((c) => c.visibilityState === 'visible' && c.focused && decodeURIComponent((c.url.split('#chat=')[1] || '').split('&')[0]) === d.chatId);
    if (open && !ios) return;
    return self.registration.showNotification(d.title || 'Chorus', {
      body: d.body || '', tag: d.tag || d.chatId || undefined, renotify: true,
      data: { chatId: d.chatId || null }, icon: '/icon-192.png', badge: '/icon-192.png',
    });
  }));
});
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const r = await fetch('/api/push', { credentials: 'include' });
    if (!r.ok) return;
    const { key } = await r.json();
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await fetch('/api/push/subscribe', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub }) });
  })());
});
