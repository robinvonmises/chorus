// Minimaler Service Worker: macht die App installierbar und zeigt Benachrichtigungen an.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); trimMedia(true); });
// Die App-Seite selbst immer frisch vom Server holen: iOS öffnet sonst (z. B. beim Tipp auf eine Benachrichtigung)
// eine alte, aufgehobene Startseite, deren Skripte es nach einem Update nicht mehr gibt, und zeigt nur Weiß.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (e.request.mode === 'navigate') { e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(() => fetch(e.request))); return; }
  if (isMedia(e.request)) e.respondWith(fromMediaCache(e.request));
});

// Bilder im Chat (Vorschaubilder, Video-Standbilder, Profilbilder) dauerhaft auf dem Gerät aufheben.
// iOS wirft den normalen Browser-Cache weg, wenn es die Homescreen-App im Hintergrund beendet; danach luden
// alle Bilder beim Öffnen sichtbar neu. Diese Adressen ändern ihren Inhalt nie (neue Version = neue Adresse).
// Alles ist abgesichert: Klappt am Cache etwas nicht, geht die Anfrage ganz normal an den Server.
const MEDIA_CACHE = 'chorus-media-v1';
const MEDIA_MAX = 2500;             // Einträge; Vorschaubilder sind ~50 KB → grob 100 MB
const MEDIA_MAX_BYTES = 3000000;    // größere Einzeldateien (Originale) nicht aufheben
function isMedia(req) {
  if (req.headers.has('range')) return false;
  let u;
  try { u = new URL(req.url); } catch { return false; }
  if (u.origin !== self.location.origin) return false;
  if (u.pathname === '/api/attachment') return u.searchParams.get('thumb') === '1' || req.destination === 'image';
  // Profilbilder: nur mit Versionsangabe (?v=…), sonst könnte ein altes Bild hängen bleiben
  return /^\/api\/(chats|profiles)\/.+\/avatar$/.test(u.pathname) && u.searchParams.has('v');
}
async function fromMediaCache(req) {
  let cache = null;
  try {
    cache = await caches.open(MEDIA_CACHE);
    const hit = await cache.match(req.url);
    if (hit) return hit;
  } catch { cache = null; }
  const res = await fetch(req);
  try {
    const len = Number(res.headers.get('content-length') || 0);
    if (cache && res.status === 200 && res.type === 'basic' && /^image\//.test(res.headers.get('content-type') || '') && len <= MEDIA_MAX_BYTES) {
      const copy = res.clone();
      cache.put(req.url, copy).then(() => trimMedia(false)).catch(() => {});
    }
  } catch { /* nur nicht aufgehoben */ }
  return res;
}
let trimming = false, puts = 0;
function trimMedia(force) {
  if (trimming || (!force && ++puts % 20)) return; // nicht bei jedem Bild durchzählen
  trimming = true;
  caches.open(MEDIA_CACHE).then(async (c) => {
    const keys = await c.keys(); // älteste zuerst
    for (let i = 0; i < keys.length - MEDIA_MAX; i++) await c.delete(keys[i]);
  }).catch(() => {}).finally(() => { trimming = false; });
}

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
    // Vorschaubild: selbst laden (mit Anmelde-Cookie) und als data:-URL übergeben. iOS kann keine Bilder in Benachrichtigungen.
    const img = d.image && !ios ? loadImage(d.image) : Promise.resolve(undefined);
    return img.then((image) => self.registration.showNotification(d.title || 'Chorus', {
      body: d.body || '', tag: d.tag || d.chatId || undefined, renotify: true, image,
      data: { chatId: d.chatId || null }, icon: '/icon-192.png?v=4', badge: '/icon-192.png?v=4',
    }));
  }));
});
function loadImage(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  return fetch(url, { credentials: 'include', signal: ctl.signal })
    .then((r) => (r.ok && /^image\//.test(r.headers.get('content-type') || '') ? r.arrayBuffer() : null))
    .then((buf) => {
      if (!buf || buf.byteLength > 1500000) return undefined;
      const b = new Uint8Array(buf); let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return 'data:image/jpeg;base64,' + btoa(s);
    })
    .catch(() => undefined)
    .finally(() => clearTimeout(t));
}
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const r = await fetch('/api/push', { credentials: 'include' });
    if (!r.ok) return;
    const { key } = await r.json();
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await fetch('/api/push/subscribe', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub }) });
  })());
});
