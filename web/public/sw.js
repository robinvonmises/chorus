// Minimaler Service Worker: macht die App installierbar und zeigt Benachrichtigungen an.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
// Die App-Seite selbst immer frisch vom Server holen: iOS öffnet sonst (z. B. beim Tipp auf eine Benachrichtigung)
// eine alte, aufgehobene Startseite, deren Skripte es nach einem Update nicht mehr gibt, und zeigt nur Weiß.
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate' || e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(() => fetch(e.request)));
});
// Ziel einer angetippten Benachrichtigung. iOS weckt eine eingefrorene App nur langsam auf und verliert dabei
// manchmal die Nachricht. Deshalb merkt sich der Service Worker das Ziel, und die App fragt beim Aufwachen nach.
let pendingOpen = null;
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const chat = e.notification.data && e.notification.data.chatId;
  pendingOpen = chat ? { chat, at: Date.now() } : null;
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
    if (!cs.length) return self.clients.openWindow('/' + (chat ? '#chat=' + encodeURIComponent(chat) : ''));
    const c = cs.find((x) => x.focused) || cs[0];
    for (const x of cs) x.postMessage({ openChat: chat });
    return c.focus().catch(() => {});
  }));
});
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'pending-open') {
    const p = pendingOpen && Date.now() - pendingOpen.at < 15000 ? pendingOpen.chat : null;
    pendingOpen = null;
    if (p && e.source) e.source.postMessage({ openChat: p });
  }
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
