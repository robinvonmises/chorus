import { randomUUID } from 'node:crypto';
import type { Chat, Message, OutgoingFile } from './types.js';
import { createRequire } from 'node:module';
import { Push } from './push.js';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import websocket from '@fastify/websocket';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { thumbnail } from './thumbs.js';
import { emojiCache } from './emoji.js';
import fastifyStatic from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault } from './vault.js';
import { ProfileRegistry, type ProfileEntry } from './profiles.js';
import { Store } from './db.js';
import { Hub, uiLang, type AdapterFactory } from './hub.js';
import type { Network } from './types.js';
import { telegramFactory } from './adapters/telegram.js';
import { demoFactory } from './adapters/demo.js';
import { signalFactory } from './adapters/signal.js';
import { whatsappFactory } from './adapters/whatsapp.js';
import { emailFactory } from './adapters/email.js';
import { notesFactory } from './adapters/notes.js';
import { computeStats } from './stats.js';
import { Ai, AiError } from './ai.js';
import { Storage, StorageError, type Target } from './storage.js';
import { GifError, fetchGif, gifPublic, gifSettings, searchGifs, setGifSettings } from './gifs.js';
import { AutopilotRunner } from './autopilot.js';
import { Translator, guessLang } from './translate.js';
import { Planner } from './planner.js';
import { toOggOpusTimed, toMp3, editVideo, parseVideoEdit } from './audio.js';
import { exportZip, slug } from './export.js';
import * as totp from './totp.js';

const VERSION = '0.5.1';
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const require_ = createRequire(import.meta.url);
let push: Push;
const DATA_DIR = resolve(process.env.DATA_DIR ?? './data');
const WEB_DIR = resolve(process.env.WEB_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../../web/dist'));
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 100);
mkdirSync(DATA_DIR, { recursive: true });

const factories: Partial<Record<Network, AdapterFactory>> = { telegram: telegramFactory, signal: signalFactory, whatsapp: whatsappFactory, email: emailFactory, notes: notesFactory };
if (process.env.DEMO === '1') factories.demo = demoFactory;

const registry = new ProfileRegistry(DATA_DIR);
push = new Push(DATA_DIR);

/** Laufzeit eines Profils: Tresor, Messenger, KI, offene Live-Verbindungen */
interface Ctx {
  p: ProfileEntry;
  vault: Vault;
  hub: Hub | null;
  ai: Ai | null;
  autopilot: AutopilotRunner | null;
  translator: Translator | null;
  planner: Planner | null;
  sockets: Set<import('ws').WebSocket>;
  pendingTotp: { secret: string; sid: string } | null;
  lastTotpStep: number;
}
const ctxs = new Map<string, Ctx>();
function ctxOf(p: ProfileEntry): Ctx {
  let c = ctxs.get(p.id);
  if (c) { c.p = p; return c; }
  const vault = registry.vault(p);
  const ctx: Ctx = { p, vault, hub: null, ai: null, autopilot: null, translator: null, planner: null, sockets: new Set(), pendingTotp: null, lastTotpStep: 0 };
  vault.onUnlock(async (dek) => {
    const dir = registry.dirOf(ctx.p);
    const store = new Store(dir, dek);
    const hub = new Hub(store, factories, dir);
    ctx.hub = hub;
    ctx.ai = new Ai(store);
    ctx.autopilot = new AutopilotRunner(hub, ctx.ai);
    ctx.translator = new Translator(hub, ctx.ai);
    ctx.planner?.stop();
    ctx.planner = new Planner(hub, (title, body, chatId) => { void push.send(store, { title, body, chatId, tag: 'reminder-' + chatId }, undefined, visibleEndpoints(ctx)); },
      (p) => sendMaybeTranslated(hub, ctx.ai!, p.chatId, p.text, p.replyTo ?? null, !!p.translate));
    hub.subscribe((e) => broadcast(ctx, e));
    // Push an jedes Gerät, auf dem Chorus gerade nicht offen und sichtbar ist. Das offene Gerät zeigt selbst einen dezenten Hinweis.
    // Früher reichte ein offenes Gerät (z. B. der Desktop), um die Push-Nachricht an alle Geräte zu unterdrücken.
    hub.subscribe((e) => { if (e.type === 'notify') push.notify(store, e.chat, e.message, visibleEndpoints(ctx)); });
    await hub.startAll();
    await hub.ensureNotes(uiLang(store) === 'de' ? 'Notizen an mich' : 'Notes to self').catch((e) => console.error('[notizen]', e));
    if (process.env.DEMO === '1' && !store.listAccountRows().some((a) => a.network === 'demo')) {
      await hub.addAccount('demo', 'Demo', {});
    }
  });
  ctxs.set(p.id, ctx);
  return ctx;
}
/** Sitzung → Profil */
const sessions = new Map<string, string>();


// Nur Proxys im eigenen Netz dürfen die Absenderadresse (X-Forwarded-For) setzen.
// Sonst könnte jeder die Login-Bremse mit erfundenen Adressen umgehen.
function trustProxySetting(v = process.env.TRUST_PROXY ?? 'loopback,linklocal,uniquelocal'): boolean | number | string {
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}
// Letzte Warnungen/Fehler für den Admin-Bereich (ohne Anfrage-Details, damit keine fremden Chat-IDs auftauchen)
const recentLogs: { t: number; level: number; msg: string }[] = [];
const logStream = {
  write(line: string) {
    process.stdout.write(line);
    try {
      const j = JSON.parse(line);
      if (j.level >= 40) { recentLogs.push({ t: j.time, level: j.level, msg: String(j.msg ?? '') + (j.err?.message ? `: ${j.err.message}` : j.err && typeof j.err === 'string' ? `: ${j.err}` : '') }); if (recentLogs.length > 200) recentLogs.shift(); }
    } catch { /* ignore */ }
  },
};
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', stream: logStream }, trustProxy: trustProxySetting() as boolean | string, bodyLimit: 2 * 1024 * 1024,
  // Nachrichten-IDs in Signal-Gruppen (Konto + Gruppen-ID + Zeit + UUID) sind länger als die Standardgrenze von 100 Zeichen → sonst „Bad Request“
  routerOptions: { maxParamLength: 1000 } });
await app.register(cookie);
await app.register(websocket);
await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });
await app.register(rateLimit, { global: false });
// Grundschutz für jede Antwort: kein Einbetten in fremde Seiten, kein Raten von Dateitypen, keine Referrer nach außen
app.addHook('onSend', async (_req, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  return payload;
});

// ---------- Hilfen ----------
/** keep = „Auf diesem Gerät angemeldet bleiben“: Cookie übersteht das Beenden der App (iOS beendet Web-Apps im Hintergrund oft) */
function newSession(reply: FastifyReply, req: FastifyRequest, profileId: string, keep = false) {
  const sid = randomBytes(32).toString('base64url');
  sessions.set(sid, profileId);
  reply.setCookie('sid', sid, { path: '/', httpOnly: true, sameSite: 'strict', secure: req.protocol === 'https', ...(keep ? { maxAge: 30 * 86400 } : {}) });
}
const isHttps = (req: FastifyRequest) => req.protocol === 'https';
const trustCookie = (c: Ctx) => `trust_${c.p.id}`;
function trustDevice(reply: FastifyReply, req: FastifyRequest, c: Ctx): string {
  const token = c.vault.addTrusted(30);
  reply.setCookie(trustCookie(c), token, { path: '/api/vault', httpOnly: true, sameSite: 'strict', secure: isHttps(req), maxAge: 30 * 86400 });
  return token;
}


// Login-Bremse: pro Adresse nach 10 Fehlversuchen in 10 Minuten 5 Minuten Pause.
// Global (gegen Angriffe von vielen Adressen) wird nur gebremst, nicht gesperrt,
// damit ein Fremder dich nicht aussperren kann.
const failures = new Map<string, number[]>();
const blocked = new Map<string, number>();
const GLOBAL = '*';
const recent = (k: string) => (failures.get(k) ?? []).filter((t) => t > Date.now() - 10 * 60_000);
async function guard(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if ((blocked.get(req.ip) ?? 0) > Date.now()) {
    reply.code(429).send({ error: 'Zu viele Fehlversuche. Bitte warte ein paar Minuten.' });
    return false;
  }
  const g = recent(GLOBAL).length;
  if (g > 20) await new Promise((r) => setTimeout(r, Math.min(10_000, (g - 20) * 250)));
  return true;
}
function failed(req: FastifyRequest) {
  const now = Date.now();
  const mine = [...recent(req.ip), now];
  if (mine.length >= 10) { blocked.set(req.ip, now + 5 * 60_000); failures.delete(req.ip); app.log.warn({ ip: req.ip }, 'Anmeldung für diese Adresse gesperrt: zu viele Fehlversuche'); }
  else failures.set(req.ip, mine);
  failures.set(GLOBAL, [...recent(GLOBAL), now].slice(-500));
  if (failures.size > 10_000) failures.clear();
}


function keyFrom(b64: unknown): Buffer {
  if (typeof b64 !== 'string') throw Object.assign(new Error('Schlüssel fehlt'), { statusCode: 400 });
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw Object.assign(new Error('Ungültiger Schlüssel'), { statusCode: 400 });
  return k;
}

// Zwei-Faktor: jeder Code nur einmal
function checkTotp(c: Ctx, code: unknown): boolean {
  const secret = c.vault.totpSecret;
  if (!secret) return true;
  const step = totp.verify(secret, code);
  if (step === null || step <= c.lastTotpStep) return false;
  c.lastTotpStep = step;
  return true;
}

/** Angemeldetes Profil dieser Anfrage (oder null) */
function authed(req: FastifyRequest): Ctx | null {
  const pid = req.cookies.sid ? sessions.get(req.cookies.sid) : undefined;
  const p = registry.get(pid);
  if (!p) return null;
  const c = ctxOf(p);
  return c.vault.unlocked && c.hub ? c : null;
}
const C = (req: FastifyRequest) => authed(req)!;
const H = (req: FastifyRequest) => C(req).hub!;
/** KI des Profils; merkt sich nebenbei die Oberflächensprache (für Hintergrundaufgaben wie Übersetzung und Autobot) */
const A = (req: FastifyRequest) => { const ai = C(req).ai!; ai.noteLang(req.headers['x-chorus-lang']); return ai; };
function profileFrom(id: unknown): Ctx {
  const p = registry.get(typeof id === 'string' ? id : null);
  if (!p) throw Object.assign(new Error('Profil nicht gefunden'), { statusCode: 404 });
  return ctxOf(p);
}
function needAdmin(req: FastifyRequest) {
  if (!C(req).p.admin) throw Object.assign(new Error('Nur für Admins'), { statusCode: 403 });
}
function publicProfile(p: ProfileEntry) {
  const v = registry.vault(p);
  const av = registry.avatarVersion(p);
  return { id: p.id, name: p.name, initialized: v.initialized, invite: !!p.invite, totp: !!v.totpSecret, kdf: v.kdfParams(), avatar: av ? `/api/profiles/${p.id}/avatar?v=${av}` : null };
}

// ---------- Öffentliche Routen (Anmeldung) ----------
app.get('/api/state', async (req) => {
  const c = authed(req);
  return {
    version: VERSION,
    networks: Object.keys(factories).filter((n) => n !== 'notes'),
    profiles: registry.all().map(publicProfile),
    authed: !!c,
    profile: c ? { id: c.p.id, name: c.p.name, admin: c.p.admin, comfort: c.vault.comfortMode, totp: !!c.vault.totpSecret, avatar: publicProfile(c.p).avatar } : null,
  };
});

const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

/** Passwort festlegen: erstes Profil überhaupt, oder ein eingeladenes Profil mit Einladungscode */
app.post('/api/vault/setup', strict, async (req, reply) => {
  const { profileId, name, invite, salt, key } = req.body as { profileId?: string; name?: string; invite?: string; salt: string; key: string };
  const kek = keyFrom(key);
  let c: Ctx;
  if (registry.empty) {
    c = ctxOf(registry.create(name ?? '', { admin: true }).profile);
  } else {
    if (!(await guard(req, reply))) return;
    c = profileFrom(profileId);
    if (c.vault.initialized) return reply.code(409).send({ error: 'Dieses Profil ist schon eingerichtet' });
    if (!registry.checkInvite(c.p, invite)) { failed(req); return reply.code(401).send({ error: 'Einladungscode falsch' }); }
  }
  const code = c.vault.setup(salt, kek);
  registry.clearInvite(c.p);
  newSession(reply, req, c.p.id);
  return { recoveryCode: code, profileId: c.p.id };
});

app.post('/api/vault/unlock', strict, async (req, reply) => {
  const { profileId, key, code, remember, trust } = req.body as { profileId: string; key: string; code?: string; remember?: boolean; trust?: string };
  const c = profileFrom(profileId);
  if (!c.vault.initialized) return reply.code(400).send({ error: 'Dieses Profil ist noch nicht eingerichtet' });
  if (!(await guard(req, reply))) return;
  const kek = keyFrom(key);
  if (!c.vault.check(kek)) { failed(req); return reply.code(401).send({ error: 'Passwort falsch' }); }
  // Vertrauenswürdiges Gerät: per Cookie oder (falls der Browser Cookies verliert, z. B. iOS-Web-App) aus dem lokalen Speicher
  let trustToken: string | undefined;
  if (c.vault.totpSecret && !c.vault.isTrusted(req.cookies[trustCookie(c)]) && !c.vault.isTrusted(trust)) {
    if (!code) return reply.code(401).send({ error: 'Bitte gib den Code aus deiner Authenticator-App ein.', need2fa: true });
    if (!checkTotp(c, code)) { failed(req); return reply.code(401).send({ error: 'Code falsch oder abgelaufen', need2fa: true }); }
    if (remember) trustToken = trustDevice(reply, req, c);
  }
  c.vault.unlock(kek);
  newSession(reply, req, c.p.id, remember === true);
  return { ok: true, trust: trustToken };
});

app.post('/api/vault/recover', strict, async (req, reply) => {
  const { profileId, code, salt, key } = req.body as { profileId: string; code: string; salt: string; key: string };
  const c = profileFrom(profileId);
  if (!(await guard(req, reply))) return;
  if (!c.vault.recover(code, salt, keyFrom(key))) { failed(req); return reply.code(401).send({ error: 'Wiederherstellungscode falsch' }); }
  c.pendingTotp = null;
  newSession(reply, req, c.p.id);
  return { ok: true };
});

/** Profilbild (öffentlich, für die Profilauswahl bei der Anmeldung) */
app.get('/api/profiles/:id/avatar', async (req, reply) => {
  const p = registry.get((req.params as any).id);
  const f = p && registry.avatarFile(p);
  if (!f || !existsSync(f)) return reply.code(404).send({ error: 'Kein Bild' });
  reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=31536000, immutable');
  return reply.send(readFileSync(f));
});

app.post('/api/logout', async (req, reply) => {
  if (req.cookies.sid) sessions.delete(req.cookies.sid);
  reply.clearCookie('sid', { path: '/' });
  return { ok: true };
});

// ---------- Ab hier nur angemeldet ----------
app.addHook('preHandler', async (req, reply) => {
  const url = req.url.split('?')[0];
  if (!url.startsWith('/api/') || url === '/api/state' || (req.method === 'GET' && /^\/api\/profiles\/[^/]+\/avatar$/.test(url)) || url.startsWith('/api/vault/setup') || url.startsWith('/api/vault/unlock') || url.startsWith('/api/vault/recover') || url === '/api/logout') return;
  if (!authed(req)) return reply.code(401).send({ error: 'Nicht angemeldet' });
});

app.post('/api/vault/password', async (req) => {
  const { salt, key } = req.body as { salt: string; key: string };
  C(req).vault.changePassword(salt, keyFrom(key));
  return { ok: true };
});
app.post('/api/vault/comfort', async (req) => {
  const { on } = req.body as { on: boolean };
  const c = C(req);
  c.vault.setComfort(!!on);
  return { comfort: c.vault.comfortMode };
});

// ---------- Zwei-Faktor einrichten ----------
app.post('/api/2fa/setup', async (req) => {
  const c = C(req);
  const secret = totp.newSecret();
  c.pendingTotp = { secret, sid: req.cookies.sid! };
  return { secret, uri: totp.otpauthUri(secret, `${c.p.name} (${req.hostname || 'Chorus'})`) };
});
app.post('/api/2fa/enable', strict, async (req, reply) => {
  const { code } = req.body as { code: string };
  const c = C(req);
  if (!c.pendingTotp || c.pendingTotp.sid !== req.cookies.sid) return reply.code(400).send({ error: 'Bitte die Einrichtung neu starten.' });
  const step = totp.verify(c.pendingTotp.secret, code);
  if (step === null) return reply.code(400).send({ error: 'Code stimmt nicht. Uhrzeit am Handy prüfen und den aktuellen Code eingeben.' });
  c.vault.setTotp(c.pendingTotp.secret);
  c.lastTotpStep = step;
  c.pendingTotp = null;
  // Alle anderen Geräte dieses Profils abmelden, sie müssen sich mit Code neu anmelden
  for (const [sid, pid] of [...sessions]) if (pid === c.p.id && sid !== req.cookies.sid) sessions.delete(sid);
  return { ok: true, trust: trustDevice(reply, req, c) };
});
app.post('/api/2fa/disable', strict, async (req, reply) => {
  const { code } = req.body as { code: string };
  const c = C(req);
  if (!(await guard(req, reply))) return;
  if (!checkTotp(c, code)) { failed(req); return reply.code(400).send({ error: 'Code falsch oder abgelaufen' }); }
  c.vault.setTotp(null);
  reply.clearCookie(trustCookie(c), { path: '/api/vault' });
  return { ok: true };
});

// ---------- Profile verwalten ----------
app.get('/api/profiles', async (req) => {
  needAdmin(req);
  return registry.all().map((p) => ({ ...publicProfile(p), admin: p.admin, createdAt: p.createdAt, online: !!ctxs.get(p.id)?.vault.unlocked }));
});
app.post('/api/profiles', async (req) => {
  needAdmin(req);
  const { profile, invite } = registry.create(String((req.body as any)?.name ?? ''), { withInvite: true });
  return { profile: publicProfile(profile), invite };
});
app.post('/api/profiles/:id/invite', async (req) => {
  needAdmin(req);
  return { invite: registry.newInvite((req.params as any).id) };
});
app.patch('/api/profiles/:id', async (req) => {
  const id = (req.params as any).id;
  const c = C(req);
  if (!c.p.admin && c.p.id !== id) throw Object.assign(new Error('Nur für Admins'), { statusCode: 403 });
  return publicProfile(registry.rename(id, String((req.body as any)?.name ?? '')));
});
app.put('/api/profiles/:id/avatar', async (req) => {
  const id = (req.params as any).id;
  const c = C(req);
  if (!c.p.admin && c.p.id !== id) throw Object.assign(new Error('Nur für Admins'), { statusCode: 403 });
  const p = registry.get(id);
  if (!p) throw Object.assign(new Error('Profil nicht gefunden'), { statusCode: 404 });
  const part = await req.file();
  if (!part) throw Object.assign(new Error('Kein Bild'), { statusCode: 400 });
  const data = await part.toBuffer();
  // Nur JPEG (der Browser verkleinert und wandelt vorher um), höchstens 512 KB
  if (data.length > 512 * 1024 || data[0] !== 0xff || data[1] !== 0xd8) throw Object.assign(new Error('Bitte ein Foto (JPEG, max. 512 KB)'), { statusCode: 400 });
  registry.setAvatar(p, data);
  return publicProfile(p);
});
app.delete('/api/profiles/:id/avatar', async (req) => {
  const id = (req.params as any).id;
  const c = C(req);
  if (!c.p.admin && c.p.id !== id) throw Object.assign(new Error('Nur für Admins'), { statusCode: 403 });
  const p = registry.get(id);
  if (!p) throw Object.assign(new Error('Profil nicht gefunden'), { statusCode: 404 });
  registry.setAvatar(p, null);
  return publicProfile(p);
});
app.delete('/api/profiles/:id', async (req) => {
  needAdmin(req);
  const id = (req.params as any).id;
  if (id === C(req).p.id) throw Object.assign(new Error('Du kannst dein eigenes Profil nicht löschen'), { statusCode: 400 });
  const other = ctxs.get(id);
  if (other) {
    other.planner?.stop(); await other.hub?.stopAll(); other.hub?.store.close();
    for (const ws of other.sockets) ws.close(4401, 'Profil gelöscht');
    ctxs.delete(id);
  }
  for (const [sid, pid] of [...sessions]) if (pid === id) sessions.delete(sid);
  registry.remove(id);
  return { ok: true };
});

app.get('/api/accounts', async (req) => H(req).accounts());
app.post('/api/accounts', async (req) => {
  const { network, label, config } = req.body as { network: Network; label: string; config?: Record<string, unknown> };
  return H(req).addAccount(network, label || network, config ?? {});
});
app.delete('/api/accounts/:id', async (req) => { await H(req).removeAccount((req.params as any).id); return { ok: true }; });
// E-Mail: Einstellungen (Server, Signaturen) lesen und ändern. Das Passwort wird nie zurückgegeben.
app.get('/api/accounts/:id/config', async (req) => {
  const row = H(req).store.getAccountRow((req.params as any).id);
  if (!row || row.network !== 'email') throw new Error('Nur für E-Mail-Konten');
  const { password: _p, ...cfg } = JSON.parse(row.config);
  return cfg;
});
app.patch('/api/accounts/:id/config', async (req) => {
  const id = (req.params as any).id;
  const row = H(req).store.getAccountRow(id);
  if (!row || row.network !== 'email') throw new Error('Nur für E-Mail-Konten');
  const allowed = ['name', 'user', 'password', 'imapHost', 'imapPort', 'smtpHost', 'smtpPort', 'signature', 'hideSignatures', 'hideBulk', 'days'];
  const body = (req.body ?? {}) as Record<string, unknown>;
  const cfg = JSON.parse(row.config);
  for (const k of allowed) if (k in body && !(k === 'password' && !body[k])) cfg[k] = body[k];
  H(req).store.setAccountConfig(id, cfg);
  await H(req).startAccount(id);
  return { ok: true };
});
app.post('/api/accounts/:id/restart', async (req) => { await H(req).startAccount((req.params as any).id); return { ok: true }; });
app.post('/api/accounts/:id/input', async (req) => {
  const { field, value } = req.body as { field: string; value: string };
  await H(req).input((req.params as any).id, field, value);
  return { ok: true };
});

app.get('/api/chats', async (req) => H(req).store.listChats());
app.get('/api/chats/search', async (req) => { const q = String((req.query as any)?.q ?? '').trim(); return q ? H(req).store.searchChats(q.slice(0, 100)) : []; });
app.patch('/api/chats/:id', async (req) => {
  const id = (req.params as any).id;
  const body = (req.body ?? {}) as any;
  // E-Mail: Archivieren verschiebt die Mails auch auf dem Server
  if ('archived' in body && H(req).store.getChat(id)?.network === 'email') await H(req).archiveChat(id, !!body.archived);
  H(req).store.updateChat(id, body);
  return H(req).emitChat(id);
});
app.delete('/api/chats/:id', async (req) => { await H(req).deleteChat((req.params as any).id); return { ok: true };
});
app.post('/api/chats/:id/unread', async (req) => {
  const id = (req.params as any).id; const h = H(req);
  const c = h.store.getChat(id); if (!c) return { ok: false };
  if (!c.unread) h.store.updateChat(id, { unread: 1 });
  return h.emitChat(id);
});
app.post('/api/chats/:id/contact', async (req) => H(req).refreshContact((req.params as any).id));
app.post('/api/sync', async (req) => { const h = H(req); await h.resync(); return h.store.listChats(); });
app.get('/api/chats/:id/avatar', async (req, reply) => {
  const h = H(req);
  const f = h.store.avatarFileOf((req.params as any).id);
  const data = f ? h.store.readFile(f) : null;
  if (!data) return reply.code(404).send({ error: 'Kein Bild' });
  const png = data[0] === 0x89;
  reply.header('Content-Type', png ? 'image/png' : data[0] === 0x52 ? 'image/webp' : 'image/jpeg');
  reply.header('Cache-Control', 'private, max-age=31536000, immutable');
  return reply.send(data);
});
app.get('/api/chats/:id/sender-avatars', async (req) => H(req).senderAvatars((req.params as any).id));
app.get('/api/chats/:id/people/:sid/avatar', async (req, reply) => {
  const h = H(req); const { id, sid } = req.params as any;
  const f = h.store.personAvatarFile(id, sid);
  const data = f ? h.store.readFile(f) : null;
  if (!data) return reply.code(404).send({ error: 'Kein Bild' });
  reply.header('Content-Type', data[0] === 0x89 ? 'image/png' : data[0] === 0x52 ? 'image/webp' : 'image/jpeg');
  reply.header('Cache-Control', 'private, max-age=31536000, immutable');
  return reply.send(data);
});
app.put('/api/chats/:id/avatar', async (req, reply) => {
  const h = H(req); const id = (req.params as any).id;
  const part = await req.file();
  const buf = part ? await part.toBuffer() : null;
  if (!buf || buf.length > 512 * 1024 || buf[0] !== 0xff || buf[1] !== 0xd8) return reply.code(400).send({ error: 'Bitte ein Foto (JPEG, max. 512 KB)' });
  h.store.setCustomAvatar(id, h.store.storeFile(buf));
  return h.emitChat(id);
});
app.delete('/api/chats/:id/avatar', async (req) => {
  const h = H(req); const id = (req.params as any).id;
  h.store.setCustomAvatar(id, null);
  return h.emitChat(id);
});
app.post('/api/chats/:id/read', async (req) => { await H(req).markRead((req.params as any).id); return { ok: true }; });
app.get('/api/chats/:id/messages', async (req) => {
  const q = req.query as { before?: string; limit?: string };
  return H(req).store.listMessages((req.params as any).id, q.before ? Number(q.before) : undefined, Math.min(Number(q.limit ?? 60), 200));
});
app.post('/api/chats/:id/history', async (req) => { await H(req).loadHistory((req.params as any).id); return { ok: true }; });
/** Senden, bei eingeschalteter Live-Übersetzung in der Sprache des Chatpartners; das deutsche Original bleibt sichtbar */
/** Endet ein Text auf 🤖 (KI-Vorschlag, „Schreib für mich“), wird das Zeichen zur Reaktion statt zum Text */
const BOT_MARK = /\s*[–-]?\s*🤖\s*$/u;
function splitBotMark(text: string): { text: string; bot: boolean } {
  const rest = text.replace(BOT_MARK, '').trim();
  return rest && rest !== text.trim() ? { text: rest, bot: true } : { text, bot: false };
}
/** Sprache, in die eigene Nachrichten in diesem Chat übersetzt werden, oder null */
function outLang(h: Hub, id: string, mine: string): string | null {
  const chat = h.store.getChat(id);
  // Bei zusammengeführten Kontakten gilt die Übersetzung des ganzen Kontakts
  const src = chat?.translate?.on ? chat : chat?.link ? h.store.linkedIds(chat.link).map((x) => h.store.getChat(x)).find((c) => c?.translate?.on) : chat;
  const tr = src?.translate;
  return tr?.on && tr.out !== false && tr.lang && tr.lang !== mine && tr.langName && src?.aiEnabled ? tr.langName : null;
}
async function sendMaybeTranslated(h: Hub, ai: Ai, id: string, raw: string, replyTo: string | null, translate: boolean) {
  const chat = h.store.getChat(id);
  const { text, bot } = splitBotMark(raw);
  const tg = chat?.network === 'telegram';
  const out = (t: string) => (bot && tg ? `${t} – 🤖` : t);
  const langName = translate ? outLang(h, id, ai.lang) : null;
  let m: Message | null;
  if (langName) {
    const t = await ai.translateOut(id, text, langName);
    m = await h.sendText(id, out(t), replyTo);
    if (m) { const u = h.store.patchMessage(m.id, { translation: text }); if (u) { m = u; h.emit({ type: 'message', message: u }); } }
  } else m = await h.sendText(id, out(text), replyTo);
  if (bot) void h.markBot(m);
}
app.post('/api/chats/:id/send', async (req) => {
  const { text, replyTo, translate } = req.body as { text: string; replyTo?: string | null; translate?: boolean };
  if (!text?.trim()) throw Object.assign(new Error('Leere Nachricht'), { statusCode: 400 });
  const id = (req.params as any).id;
  await sendMaybeTranslated(H(req), A(req), id, text, replyTo ?? null, !!translate);
  return { ok: true };
});
app.post('/api/chats/:id/upload', async (req) => {
  const part = await req.file();
  if (!part) throw Object.assign(new Error('Keine Datei'), { statusCode: 400 });
  let data = await part.toBuffer();
  const f = part.fields as Record<string, any>;
  const val = (k: string) => (f[k] && 'value' in f[k] ? String(f[k].value) : undefined);
  let name = part.filename || 'datei', mime = part.mimetype || 'application/octet-stream';
  const vEdit = parseVideoEdit(val('video'));
  if (vEdit) { // gekürzt/zugeschnitten im Video-Editor
    data = await editVideo(data, vEdit);
    name = name.replace(/\.[a-z0-9]+$/i, '') + '.mp4'; mime = 'video/mp4';
  }
  // Bildunterschrift mit Live-Übersetzung: übersetzt senden, das deutsche Original darunter zeigen
  const id = (req.params as any).id, h = H(req);
  const orig = val('caption')?.trim() || undefined;
  const langName = orig && val('translate') === '1' ? outLang(h, id, A(req).lang) : null;
  const caption = langName ? await A(req).translateOut(id, orig!, langName) : orig;
  const r = await h.sendFile(id, {
    data, name, mime,
    voice: val('voice') === '1', durationSec: val('duration') ? Number(val('duration')) : undefined,
    // Nach dem Zuschneiden im Video-Editor stimmen die gemessenen Maße nicht mehr
    ...(!vEdit?.crop && Number(val('width')) > 0 && Number(val('height')) > 0 ? { width: Math.round(Number(val('width'))), height: Math.round(Number(val('height'))) } : {}),
  }, caption, val('replyTo') || null);
  if (langName) {
    const mark = (m: Message | null) => { const u = m && h.store.patchMessage(m.id, { translation: orig!, translationFrom: null }); if (u) h.emit({ type: 'message', message: u }); };
    mark(r.pending);
    void r.done.then(mark);
  }
  return { ok: true };
});

// Weiterleiten: an beliebige Chats, auch über Messenger hinweg. Gesendet wird immer als neue Nachricht mit Text und Anhängen
// (native Weiterleitung gibt es nur innerhalb desselben Messengers und Kontos; so verhält es sich überall gleich).
app.post('/api/messages/:id/forward', async (req) => {
  const h = H(req);
  const msg = h.store.getMessage((req.params as any).id);
  if (!msg || msg.deleted) throw Object.assign(new Error('Nachricht nicht gefunden'), { statusCode: 404 });
  const ids = [...new Set(((req.body as any)?.chatIds ?? []) as string[])].filter((c) => typeof c === 'string' && h.store.getChat(c)).slice(0, 20);
  if (!ids.length) throw Object.assign(new Error('Kein Zielchat gewählt'), { statusCode: 400 });
  const text = (msg.text || '').trim();
  const files: OutgoingFile[] = [];
  for (let i = 0; i < msg.attachments.length; i++) {
    const a = msg.attachments[i];
    let data: Buffer;
    try { data = await h.attachmentData(msg, i); }
    catch (e: any) { throw Object.assign(new Error(`Anhang „${a.name}“ konnte nicht geladen werden: ${e?.message ?? e}`), { statusCode: 502 }); }
    files.push({ data, name: a.name || 'datei', mime: a.mime || 'application/octet-stream', voice: a.kind === 'voice', durationSec: a.durationSec,
      ...(a.width && a.height ? { width: a.width, height: a.height } : {}) });
  }
  if (!text && !files.length) throw Object.assign(new Error('Nichts zum Weiterleiten'), { statusCode: 400 });
  // Pro Ziel der Reihe nach (Reihenfolge der Anhänge bleibt), Ziele parallel. Fehler zeigt die Nachricht selbst als „fehlgeschlagen“.
  for (const id of ids) {
    void (async () => {
      try {
        if (!files.length) { await h.sendText(id, text); return; }
        // Text als Bildunterschrift des ersten Anhangs; Sprachnachrichten haben keine Unterschrift, dann Text extra
        const capFirst = !!text && !files[0].voice;
        for (let i = 0; i < files.length; i++) await (await h.sendFile(id, files[i], i === 0 && capFirst ? text : undefined)).done;
        if (text && !capFirst) await h.sendText(id, text);
      } catch (e: any) { req.log.warn({ id, err: e?.message }, 'Weiterleiten fehlgeschlagen'); }
    })();
  }
  return { ok: true, count: ids.length };
});
app.post('/api/messages/:id/react', async (req) => {
  const { emoji } = req.body as { emoji: string | null };
  await H(req).react((req.params as any).id, emoji);
  return { ok: true };
});
app.patch('/api/messages/:id', async (req) => {
  const { text } = req.body as { text: string };
  await H(req).edit((req.params as any).id, text);
  return { ok: true };
});
app.post('/api/messages/:id/retry', async (req) => {
  await H(req).retry((req.params as any).id);
  return { ok: true };
});
app.delete('/api/messages/:id/discard', async (req) => {
  H(req).discard((req.params as any).id);
  return { ok: true };
});
app.delete('/api/messages/:id', async (req) => {
  const everyone = (req.query as any).everyone === '1';
  await H(req).delete((req.params as any).id, everyone);
  return { ok: true };
});

app.post('/api/accounts/:id/start-chat', async (req) => H(req).startChat((req.params as any).id, String((req.body as any)?.phone ?? '')));

// ---------- KI ----------
function needAi(req: FastifyRequest, chatId: string) {
  const c = H(req).store.getChat(chatId);
  if (!c) throw new AiError(404, 'Chat nicht gefunden');
  if (!c.aiEnabled) throw new AiError(403, 'KI ist für diesen Chat ausgeschaltet.');
  return c;
}
app.get('/api/ai/settings', async (req) => A(req).publicSettings());
app.put('/api/ai/settings', async (req) => A(req).update(req.body as any));
app.get('/api/ai/voices', async (req) => A(req).voices());
app.get('/api/ai/openai-models', async (req) => A(req).openaiModels());
app.post('/api/chats/:id/ai', async (req) => {
  const id = (req.params as any).id;
  const on = !!(req.body as any)?.on;
  if (!on) A(req).forgetChat(id);
  return H(req).setChatAi(id, on);
});
app.post('/api/chats/:id/ai/summary', async (req) => {
  const id = (req.params as any).id;
  needAi(req, id);
  return { text: await A(req).summarize(id) };
});
app.post('/api/chats/:id/ai/suggest', async (req) => {
  const id = (req.params as any).id;
  needAi(req, id);
  const hint = String((req.body as any)?.hint ?? '').slice(0, 500).trim();
  return { suggestions: await A(req).suggest(id, hint || undefined) };
});
app.post('/api/chats/:id/ai/quick', async (req) => {
  const id = (req.params as any).id;
  needAi(req, id);
  return A(req).quick(id);
});
// ---------- Geplant: zeitversetzt senden, Erinnerungen ----------
const P = (req: FastifyRequest) => { const p = C(req).planner; if (!p) throw Object.assign(new Error('Nicht bereit'), { statusCode: 503 }); return p; };
// ---------- Notizen an mich ----------
app.get('/api/notes', async (req) => ({ ttl: H(req).notesTtl }));
app.put('/api/notes', async (req) => { const h = H(req); h.notesTtl = Number((req.body as any)?.ttl) || 0; return { ttl: h.notesTtl }; });

// ---------- Massen-Nachricht ----------
app.get('/api/broadcast', async (req) => H(req).broadcastJob);
app.post('/api/broadcast', async (req) => {
  const { chatIds, text } = (req.body ?? {}) as { chatIds?: string[]; text?: string };
  if (!Array.isArray(chatIds)) throw Object.assign(new Error('Keine Empfänger'), { statusCode: 400 });
  return H(req).startBroadcast(chatIds.map(String), String(text ?? '').slice(0, 4000));
});

// ---------- Statistik ----------
app.get('/api/stats', async (req) => {
  const q = req.query as { year?: string; tz?: string };
  const year = q.year && q.year !== 'all' ? Number(q.year) : null;
  return computeStats(H(req).store, year && year > 1999 && year < 3000 ? year : null, Math.max(-900, Math.min(900, Number(q.tz) || 0)));
});

app.get('/api/planned', async (req) => P(req).list());
app.post('/api/planned', async (req) => {
  const b = (req.body ?? {}) as any;
  const kind = b.kind === 'remind' ? 'remind' : 'send';
  const text = String(b.text ?? '').slice(0, 8000);
  if (kind === 'send' && !text.trim()) throw Object.assign(new Error('Leere Nachricht'), { statusCode: 400 });
  return P(req).add({ kind, chatId: String(b.chatId ?? ''), at: Number(b.at), text, replyTo: b.replyTo ?? null, translate: !!b.translate,
    messageId: b.messageId ?? null, note: String(b.note ?? '').slice(0, 300) || undefined });
});
app.patch('/api/planned/:id', async (req) => {
  const b = (req.body ?? {}) as any;
  return P(req).update((req.params as any).id, { ...(b.at ? { at: Number(b.at) } : {}), ...(typeof b.text === 'string' ? { text: b.text.slice(0, 8000) } : {}) });
});
app.delete('/api/planned/:id', async (req) => { P(req).remove((req.params as any).id); return { ok: true }; });
/** Jetzt sofort senden */
app.post('/api/planned/:id/now', async (req) => {
  const p = P(req).list().find((x) => x.id === (req.params as any).id);
  if (!p) throw Object.assign(new Error('Nicht gefunden'), { statusCode: 404 });
  await sendMaybeTranslated(H(req), A(req), p.chatId, p.text, p.replyTo ?? null, !!p.translate);
  P(req).remove(p.id);
  return { ok: true };
});

/** Vorschlag für die Sprache aus der Ländervorwahl (für die Sprachauswahl) */
app.get('/api/chats/:id/translate', async (req) => {
  const c = H(req).store.getChat((req.params as any).id);
  if (!c) throw new AiError(404, 'Chat nicht gefunden');
  return { guess: guessLang(c) };
});
/** Live-Übersetzung ein/aus und Sprache wählen. Schaltet die KI für den Chat mit ein und übersetzt die letzten Nachrichten.
 *  lang: Sprachcode und langName = feste Sprache, lang: null = automatisch erkennen, fehlt = unverändert */
app.put('/api/chats/:id/translate', async (req) => {
  const id = (req.params as any).id;
  const h = H(req);
  const c = h.store.getChat(id);
  if (!c) throw new AiError(404, 'Chat nicht gefunden');
  const b = (req.body ?? {}) as { on?: boolean; out?: boolean; lang?: string | null; langName?: string | null };
  const on = !!b.on;
  if (on && !A(req).publicSettings().features.text) throw new AiError(400, 'Für die Übersetzung bitte zuerst in den Einstellungen einen KI-Schlüssel (Claude oder ChatGPT) eintragen.');
  if (on && !c.aiEnabled) h.setChatAi(id, true);
  const t: NonNullable<Chat['translate']> = { ...(c.translate ?? {}), on, ...(typeof b.out === 'boolean' ? { out: b.out } : {}) };
  // Zurück auf automatisch: die von Hand gewählte Sprache gilt nicht mehr, bis wieder etwas erkannt ist
  if (b.lang === null) { if (t.fixed) { const g = guessLang(c); t.lang = g?.lang ?? null; t.langName = g?.langName ?? null; } t.fixed = false; }
  else if (typeof b.lang === 'string' || typeof b.langName === 'string') {
    const name = String(b.langName ?? '').trim().slice(0, 40);
    if (!name) throw new AiError(400, 'Bitte eine Sprache angeben.');
    const code = String(b.lang ?? '').trim().toLowerCase().slice(0, 8) || 'x-' + name.toLowerCase().replace(/[^a-zäöüß]/g, '').slice(0, 6);
    Object.assign(t, { lang: code, langName: name, fixed: true });
  }
  // Noch keine Sprache bekannt: aus der Ländervorwahl vorschlagen, damit schon die erste eigene Nachricht übersetzt wird
  if (on && !t.fixed && !t.lang) { const g = guessLang(c); if (g) Object.assign(t, g); }
  h.store.setTranslate(id, t);
  const chat = h.store.getChat(id)!;
  h.emit({ type: 'chat', chat });
  if (on) void C(req).translator!.run(id, 30);
  return chat;
});
/** Autopilot ein/aus, Limit und Hinweise */
app.put('/api/chats/:id/autopilot', async (req) => {
  const id = (req.params as any).id;
  const c = needAi(req, id);
  if (c.kind === 'channel') throw new AiError(400, 'In Kanälen gibt es keinen Autobot.');
  if (!A(req).publicSettings().features.text) throw new AiError(400, 'Bitte zuerst einen KI-Schlüssel (Claude oder ChatGPT) eintragen.');
  const b = (req.body ?? {}) as { on?: boolean; max?: number; note?: string; mark?: boolean; reset?: boolean; trigger?: string; only?: string[]; rule?: string; style?: string };
  const cur = c.autopilot ?? { on: false, max: 5, used: 0, note: '', mark: true };
  const max = Math.max(1, Math.min(50, Math.round(Number(b.max ?? cur.max) || 5)));
  const turningOn = b.on === true && !cur.on;
  const used = b.reset || turningOn ? 0 : cur.used;
  const pick = <T extends string>(v: unknown, ok: readonly T[], d: T | undefined) => (ok.includes(v as T) ? (v as T) : d);
  return C(req).autopilot!.set(id, {
    on: b.on ?? cur.on, max, used, note: String(b.note ?? cur.note).slice(0, 1000), mark: b.mark ?? cur.mark,
    trigger: pick(b.trigger, ['me', 'direct', 'all'] as const, cur.trigger ?? 'me'),
    only: Array.isArray(b.only) ? b.only.map(String).slice(0, 100) : cur.only ?? [],
    rule: String(b.rule ?? cur.rule ?? '').slice(0, 500),
    style: pick(b.style, ['me', 'short', 'creative'] as const, cur.style ?? 'me'),
  });
});
app.get('/api/chats/:id/participants', async (req) => H(req).store.participants((req.params as any).id));
app.post('/api/chats/:id/ai/compose', async (req) => {
  const id = (req.params as any).id;
  const c = H(req).store.getChat(id);
  if (!c) throw new AiError(404, 'Chat nicht gefunden');
  const b = (req.body ?? {}) as { instruction?: string; mode?: string };
  const text = await A(req).compose(id, String(b.instruction ?? '').slice(0, 1000), b.mode === 'voice' ? 'voice' : 'text', !!c.aiEnabled);
  return { text };
});
/** Gesprochenen Auftrag abtippen (Aufnahme aus dem Browser) */
app.post('/api/ai/dictate', async (req) => {
  const part = await req.file();
  if (!part) throw new AiError(400, 'Keine Aufnahme');
  const data = await part.toBuffer();
  return { text: await A(req).transcribe(data, part.mimetype, part.filename || 'auftrag.webm') };
});
/** Text als Sprachnachricht in der eigenen ElevenLabs-Stimme senden */
app.post('/api/chats/:id/ai/voice', async (req) => {
  const id = (req.params as any).id;
  const { text, replyTo, preview } = (req.body ?? {}) as { text?: string; replyTo?: string | null; preview?: boolean };
  const mp3 = await A(req).speak(String(text ?? ''));
  if (preview) return { audio: mp3.toString('base64'), mime: 'audio/mpeg' };
  const { data, durationSec } = await toOggOpusTimed(mp3);
  const h = H(req);
  const { done } = await h.sendFile(id, { data, name: 'sprachnachricht.ogg', mime: 'audio/ogg', voice: true, durationSec }, undefined, replyTo || null);
  void done.then((m) => h.markBot(m)); // KI-Stimme: immer mit 🤖 kennzeichnen
  return { ok: true };
});
app.post('/api/messages/:id/transcribe', async (req) => {
  const h = H(req);
  const msg = h.store.getMessage((req.params as any).id);
  if (!msg) throw new AiError(404, 'Nachricht nicht gefunden');
  // Bewusst ohne KI-Freigabe des Chats: der Nutzer stößt das pro Nachricht selbst an.
  if (!A(req).publicSettings().features.transcribe) throw new AiError(400, 'Zum Transkribieren bitte zuerst einen ElevenLabs-Schlüssel eintragen.');
  const i = msg.attachments.findIndex((a) => a.kind === 'voice' || a.kind === 'audio' || a.kind === 'video');
  if (i < 0) throw new AiError(400, 'Diese Nachricht enthält keine Sprachnachricht.');
  const att = msg.attachments[i];
  const data = await h.attachmentData(msg, i);
  const text = await A(req).transcribe(data, att.mime, att.name);
  return h.setTranscript(msg.id, text);
});

/** Eine einzelne Nachricht ins Deutsche übersetzen (Langdruck → „Übersetzen“).
 *  Bewusst ohne KI-Freigabe des Chats: der Nutzer stößt das pro Nachricht selbst an, und nur der Text dieser einen Nachricht geht an die KI. */
app.post('/api/messages/:id/translate', async (req) => {
  const h = H(req);
  const msg = h.store.getMessage((req.params as any).id);
  if (!msg) throw new AiError(404, 'Nachricht nicht gefunden');
  if (!A(req).publicSettings().features.text) throw new AiError(400, 'Zum Übersetzen bitte zuerst in den Einstellungen einen KI-Schlüssel eintragen.');
  const text = [msg.text, msg.transcript].filter(Boolean).join('\n').trim();
  if (!text) throw new AiError(400, 'Diese Nachricht enthält keinen Text.');
  const [r] = await A(req).translateIn([{ id: msg.id, text }]);
  if (!r?.translation) return { message: msg, already: true };
  const upd = h.store.patchMessage(msg.id, { translation: r.translation, translationFrom: r.langName || null });
  if (upd) h.emit({ type: 'message', message: upd });
  return { message: upd ?? msg, already: false };
});

/** Anhang ausliefern; wird bei Bedarf erst beim Messenger abgeholt.
 *  ?play=1: Audio in einem Format, das jeder Browser abspielt (Opus/OGG → MP3 für Safari/iOS).
 *  Unterstützt Range-Anfragen (Safari braucht sie für Audio und Video). */
const playCache = new Map<string, Buffer>();
// Auch als /api/attachment?m=<id>&i=<n>: Gruppen-IDs (Signal: Base64 mit „/“) überstehen so jeden Reverse Proxy
app.get('/api/attachment', async (req, reply) => {
  const q = req.query as { m?: string; i?: string };
  return serveAttachment(req, reply, String(q.m ?? ''), String(q.i ?? '0'));
});
// E-Mail im Original (bereinigtes HTML); die Oberfläche zeigt es in einem iframe ohne Skripte
app.get('/api/mailhtml', async (req, reply) => {
  const id = String((req.query as { m?: string }).m ?? '');
  const h = H(req);
  const msg = h.store.getMessage(id);
  const data = msg?.html ? h.store.readFile(msg.html) : null;
  if (!data) return reply.code(404).send({ error: 'Nicht gefunden' });
  return reply.header('Content-Type', 'text/html; charset=utf-8')
    .header('Content-Security-Policy', "sandbox; script-src 'none'")
    .header('Cache-Control', 'private, max-age=86400').send(data);
});
app.get('/api/messages/:id/attachments/:idx', async (req, reply) => {
  const { id, idx } = req.params as { id: string; idx: string };
  return serveAttachment(req, reply, id, idx);
});
async function serveAttachment(req: FastifyRequest, reply: FastifyReply, id: string, idx: string) {
  const q = req.query as { download?: string; play?: string; thumb?: string };
  const h = H(req);
  const msg = h.store.getMessage(id);
  const i = Number(idx);
  const att = msg?.attachments[i];
  if (!msg || !att) return reply.code(404).send({ error: 'Nicht gefunden' });
  let data: Buffer;
  try { data = await h.attachmentData(msg, i); }
  catch (e: any) {
    req.log.warn({ id, i, err: e?.message }, 'Anhang nicht abrufbar');
    return reply.code(502).send({ error: 'Anhang konnte nicht vom Messenger geladen werden: ' + (e?.message ?? e) });
  }
  let mime = att.mime;
  // ?thumb=1: kleine Vorschau für die Chat-Ansicht (Fotos, Video-Standbild); Original bleibt für Großansicht/Download
  if (q.thumb === '1') {
    const isVideo = att.kind === 'video' || /^video\//i.test(mime);
    const isImage = !isVideo && att.kind !== 'sticker' && /^image\/(jpe?g|png|webp|heic|heif|avif|bmp)/i.test(mime);
    const t = isVideo || isImage ? await thumbnail(`${C(req).p.id}:${id}:${i}`, isVideo ? 'video' : 'image', async () => data) : null;
    if (t) return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'private, max-age=31536000, immutable').send(t);
    if (isVideo) return reply.code(404).send({ error: 'Keine Vorschau' });
  }
  if (q.play === '1' && (/ogg|opus|webm|amr|3gpp/i.test(att.mime) || ((att.kind === 'voice' || att.kind === 'audio') && !/mpeg|mp4|aac|m4a|wav/i.test(att.mime)))) {
    const key = `${C(req).p.id}:${id}:${i}`;
    let mp3 = playCache.get(key);
    if (!mp3) {
      mp3 = await toMp3(data).catch(() => undefined);
      if (mp3) { playCache.set(key, mp3); if (playCache.size > 50) playCache.delete(playCache.keys().next().value!); }
    }
    if (mp3) { data = mp3; mime = 'audio/mpeg'; }
  }
  // Anhänge kommen von Fremden: nie als Seite auf unserer Adresse ausführen (HTML/SVG könnten Skripte enthalten)
  const safeInline = /^(image\/(png|jpe?g|gif|webp|avif|heic|heif|bmp)|video\/|audio\/|application\/pdf$)/i.test(mime);
  reply.header('Content-Type', safeInline ? mime : 'application/octet-stream');
  if (!/pdf/i.test(mime)) reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"); // PDF-Ansicht im Browser verträgt kein sandbox
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Cache-Control', 'private, max-age=31536000, immutable');
  const disp = q.download === '1' || !safeInline ? 'attachment' : 'inline';
  reply.header('Content-Disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(att.name)}`);
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    const size = data.length;
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start); end = Math.min(size - 1, end);
    if (start > end || start >= size) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`);
    return reply.send(data.subarray(start, end + 1));
  }
  return reply.send(data);
}

// ---------- Sicherung / Export ----------
/** ZIP mit HTML-Seiten und allen Medien. ?chat=<id> für einen Chat, sonst alle Chats. */
app.get('/api/export', async (req, reply) => {
  const h = H(req);
  const chatId = (req.query as any).chat as string | undefined;
  const chat = chatId ? h.store.getChat(chatId) : null;
  if (chatId && !chat) return reply.code(404).send({ error: 'Chat nicht gefunden' });
  const day = new Date().toISOString().slice(0, 10);
  const name = chat ? `chorus-${slug(chat.title)}-${day}.zip` : `chorus-sicherung-${C(req).p.name}-${day}.zip`;
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  });
  try { await exportZip(h, reply.raw, chat ? [chat.id] : null); }
  catch (e) { app.log.error(e); reply.raw.destroy(e as Error); }
});
// ---------- Animierte Emojis für Reaktionen ----------
const emojiFile = emojiCache(DATA_DIR);
app.get('/api/emoji/:file', async (req, reply) => {
  const code = String((req.params as any).file).replace(/\.webp$/, '');
  const b = await emojiFile(code);
  if (!b) return reply.code(404).header('cache-control', 'max-age=86400').send({ error: 'Nicht gefunden' });
  return reply.header('content-type', 'image/webp').header('cache-control', 'private, max-age=31536000, immutable').send(b);
});
// ---------- GIFs (GIPHY oder KLIPY) ----------
app.get('/api/gifs/settings', async (req) => gifPublic(H(req).store));
app.put('/api/gifs/settings', async (req) => setGifSettings(H(req).store, (req.body ?? {}) as any));
app.get('/api/gifs', async (req) => {
  const s = gifSettings(H(req).store);
  if (!s) throw new GifError(400, 'Kein GIF-Schlüssel eingerichtet');
  const q = req.query as { q?: string; page?: string };
  return searchGifs(s, String(q.q ?? '').trim().slice(0, 100), Math.max(1, Math.min(50, Number(q.page) || 1)), A(req).lang, C(req).p.id);
});
// Senden: WhatsApp und Telegram bekommen MP4 als Animation (spielt in Schleife wie ein GIF), Signal und E-Mail ein echtes GIF
app.post('/api/chats/:id/gif', async (req) => {
  const { gif, replyTo } = (req.body ?? {}) as { gif?: string; replyTo?: string | null };
  const id = (req.params as any).id, h = H(req);
  const chat = h.store.getChat(id);
  if (!chat || !gif) throw Object.assign(new Error('Nicht gefunden'), { statusCode: 404 });
  const f = await fetchGif(String(gif), chat.network === 'whatsapp' || chat.network === 'telegram' ? 'mp4' : 'gif');
  await h.sendFile(id, { ...f, gif: true, ...(f.width && f.height ? { width: f.width, height: f.height } : {}) }, undefined, replyTo || null);
  return { ok: true };
});

// ---------- Speicherziele: Immich (Fotos/Videos), Nextcloud (Dateien) ----------
const S = (req: FastifyRequest) => new Storage(H(req).store);
const target = (v: unknown): Target => { if (v === 'immich' || v === 'nextcloud') return v; throw new StorageError(400, 'Unbekanntes Speicherziel'); };
app.get('/api/storage', async (req) => S(req).publicSettings());
app.put('/api/storage', async (req) => S(req).update((req.body ?? {}) as any));
app.post('/api/storage/test', async (req) => ({ message: await S(req).test(target((req.body as any)?.target)) }));
app.get('/api/storage/immich/assets', async (req) => {
  const q = req.query as { page?: string; album?: string; q?: string };
  return S(req).immichAssets({ page: Number(q.page ?? 1), album: q.album || undefined, q: q.q || undefined });
});
app.get('/api/storage/immich/albums', async (req) => S(req).immichAlbums());
app.get('/api/storage/immich/assets/:id/:kind', async (req, reply) => {
  const { id, kind } = req.params as { id: string; kind: string };
  if (kind !== 'thumb' && kind !== 'send') throw new StorageError(404, 'Nicht gefunden');
  const f = await S(req).immichFile(id, kind);
  // nur Bilder direkt anzeigen, alles andere als Download (Inhalte kommen von außen)
  const inline = kind === 'thumb' && /^image\/(jpeg|webp|png)$/i.test(f.mime);
  reply.header('Content-Type', inline ? f.mime : 'application/octet-stream').header('X-File-Mime', f.mime).header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', kind === 'thumb' ? 'private, max-age=86400' : 'no-store');
  if (!inline) reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  return reply.send(f.data);
});
app.get('/api/storage/nextcloud/list', async (req) => S(req).list(String((req.query as any)?.path ?? '')));
app.post('/api/storage/nextcloud/mkdir', async (req) => S(req).mkdir(String((req.body as any)?.path ?? '')));
app.get('/api/storage/nextcloud/file', async (req, reply) => {
  const f = await S(req).read(String((req.query as any)?.path ?? ''));
  return reply.header('Content-Type', 'application/octet-stream').header('X-File-Mime', f.mime)
    .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`).header('Cache-Control', 'no-store').send(f.data);
});
// Nachrichten-ID im Body statt im Pfad: lange Signal-/WhatsApp-IDs und Sonderzeichen machen im Pfad Ärger
app.post('/api/storage/save', async (req) => saveToStorage(req, String((req.body as any)?.message ?? ''), String((req.body as any)?.index ?? '0')));
app.post('/api/messages/:id/attachments/:idx/save', async (req) => {
  const { id, idx } = req.params as { id: string; idx: string };
  return saveToStorage(req, id, idx);
});
async function saveToStorage(req: FastifyRequest, id: string, idx: string) {
  const h = H(req);
  const msg = h.store.getMessage(id);
  const i = Number(idx);
  const att = msg?.attachments[i];
  if (!msg || !att) throw new StorageError(404, 'Nicht gefunden');
  const s = S(req), pub = s.publicSettings();
  const t = target((req.body as any)?.target);
  if (!pub[t].enabled) throw new StorageError(400, t === 'immich' ? 'Immich ist nicht eingerichtet' : 'Nextcloud ist nicht eingerichtet');
  let data: Buffer;
  try { data = await h.attachmentData(msg, i); }
  catch (e: any) { throw new StorageError(502, 'Anhang konnte nicht vom Messenger geladen werden: ' + (e?.message ?? e)); }
  const b = (req.body ?? {}) as { folder?: unknown; name?: unknown };
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 200) : att.name || `chorus-${i}`;
  const folder = typeof b.folder === 'string' ? b.folder : undefined;
  try { return { message: await s.save(t, { data, name, mime: att.mime, ts: msg.ts, id: `${id}:${i}`, durationSec: att.durationSec, folder }) }; }
  catch (e: any) { req.log.warn({ target: t, err: e?.message }, 'Speichern fehlgeschlagen'); throw e; }
}
app.get('/api/media', async (req) => ({ autoSave: H(req).autoSaveMedia }));
app.put('/api/media', async (req) => { H(req).autoSaveMedia = !!(req.body as any)?.autoSave; return { autoSave: H(req).autoSaveMedia }; });
app.get('/api/keep-deleted', async (req) => ({ on: H(req).keepDeleted }));
app.put('/api/keep-deleted', async (req) => { H(req).keepDeleted = !!(req.body as any)?.on; return { on: H(req).keepDeleted }; });

app.get('/api/search', async (req) => {
  const qs = req.query as { q?: string; chats?: string; before?: string };
  const q = String(qs.q ?? '').trim();
  const chats = qs.chats ? String(qs.chats).split(',').filter(Boolean) : undefined;
  return q.length < 2 ? [] : H(req).store.search(q, 60, chats, qs.before ? Number(qs.before) : undefined);
});
/** Galerie: ?kind=media|files|voice|links&chats=a,b&before=ts */
app.get('/api/gallery', async (req) => {
  const qs = req.query as { kind?: string; chats?: string; before?: string };
  const kind = (['media', 'files', 'voice', 'links'] as const).find((k) => k === qs.kind) ?? 'media';
  const chats = qs.chats ? String(qs.chats).split(',').filter(Boolean) : null;
  return H(req).store.media(kind, chats, qs.before ? Number(qs.before) : undefined, 120);
});
/** KI-Suche: Frage in Alltagssprache. Standard: nur Chats mit eingeschalteter KI; „all“ nach Freigabe in den Einstellungen */
app.post('/api/search/ai', async (req) => {
  const h = H(req), ai = A(req);
  const question = String((req.body as any)?.question ?? '').trim().slice(0, 500);
  if (question.length < 3) throw new AiError(400, 'Bitte eine Frage eingeben.');
  if (!ai.publicSettings().features.text) throw new AiError(400, 'Für die KI-Suche bitte zuerst einen KI-Schlüssel (Claude oder ChatGPT) eintragen.');
  const all = h.store.getSetting('aiSearchAll', false);
  const allowed = h.store.listChats().filter((c) => all || c.aiEnabled);
  if (!allowed.length) throw new AiError(400, 'Die KI darf noch in keinem Chat suchen. Schalte die KI in einzelnen Chats ein oder erlaube die Suche in allen Chats.');
  const byId = new Map(allowed.map((c) => [c.id, c]));
  const terms = await ai.searchTerms(question);
  const hits = new Map<string, Message>();
  for (const t of terms) for (const m of h.store.search(t, 60, [...byId.keys()])) hits.set(m.id, m);
  const list = [...hits.values()].sort((a, b) => b.ts - a.ts).slice(0, 150);
  if (!list.length) return { answer: 'Dazu habe ich in deinen Chats nichts gefunden.', messages: [], terms, scope: all ? 'all' : 'ai' };
  const fmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: process.env.TZ || 'Europe/Berlin' });
  const lines = list.map((m) => `${m.id} | ${fmt.format(m.ts)} | ${byId.get(m.chatId)?.title ?? ''} | ${m.fromMe ? 'Ich' : m.senderName}: ${(m.text || m.transcript || m.attachments.map((a) => a.name).join(', ')).slice(0, 600)}`).join('\n');
  const r = await ai.searchAnswer(question, lines);
  return { answer: r.answer, messages: r.ids.map((id) => hits.get(id)).filter(Boolean), terms, scope: all ? 'all' : 'ai' };
});
app.get('/api/search/ai', async (req) => ({ all: H(req).store.getSetting('aiSearchAll', false) }));
app.put('/api/search/ai', async (req) => { H(req).store.setSetting('aiSearchAll', !!(req.body as any)?.all); return { all: !!(req.body as any)?.all }; });

// ---------- Kontakte über Messenger hinweg zusammenführen ----------
const digits = (s?: string | null) => (s ?? '').replace(/[^\d]/g, '').slice(-9);
function phoneOf(c: Chat): string {
  if (c.info?.phone) return digits(c.info.phone);
  const r = c.remoteId.split('@')[0];
  return /^\+?\d{7,}$/.test(r) ? digits(r) : '';
}
app.get('/api/chats/:id/link', async (req) => {
  const h = H(req);
  const c = h.store.getChat((req.params as any).id);
  if (!c) throw Object.assign(new Error('Chat nicht gefunden'), { statusCode: 404 });
  const linked = c.link ? h.store.linkedIds(c.link).filter((x) => x !== c.id).map((x) => h.store.getChat(x)).filter(Boolean) : [];
  const ph = phoneOf(c), name = c.title.trim().toLowerCase();
  const suggestions = h.store.listChats().filter((o) => o.id !== c.id && o.kind === 'direct' && (!c.link || o.link !== c.link)
    && ((ph && phoneOf(o) === ph) || (name.length > 2 && o.title.trim().toLowerCase() === name))).slice(0, 10);
  return { linked, suggestions };
});
app.post('/api/chats/:id/link', async (req) => {
  const h = H(req);
  const a = h.store.getChat((req.params as any).id), b = h.store.getChat(String((req.body as any)?.other ?? ''));
  if (!a || !b || a.id === b.id) throw Object.assign(new Error('Chat nicht gefunden'), { statusCode: 404 });
  if (a.kind !== 'direct' || b.kind !== 'direct') throw Object.assign(new Error('Nur Einzelchats lassen sich zusammenführen.'), { statusCode: 400 });
  const link = a.link || b.link || randomUUID().slice(0, 12);
  // Hatte b schon eine eigene Gruppe, die ganze Gruppe mitnehmen
  for (const id of [a.id, b.id, ...(b.link && b.link !== link ? h.store.linkedIds(b.link) : [])]) h.store.setLink(id, link);
  const out = h.store.linkedIds(link).map((id) => h.store.getChat(id)!);
  for (const c of out) h.emit({ type: 'chat', chat: c });
  return out;
});
app.delete('/api/chats/:id/link', async (req) => {
  const h = H(req);
  const c = h.store.getChat((req.params as any).id);
  if (!c?.link) return { ok: true };
  h.store.setLink(c.id, null);
  const rest = h.store.linkedIds(c.link);
  if (rest.length === 1) h.store.setLink(rest[0], null); // Einzelner Rest ist keine Gruppe mehr
  else if (rest.length && h.store.getChat(rest[0])?.sendVia === c.id) h.store.setSendVia(c.link, null);
  for (const id of [c.id, ...rest]) h.emit({ type: 'chat', chat: h.store.getChat(id)! });
  return { ok: true };
});
app.put('/api/chats/:id/via', async (req) => {
  const h = H(req);
  const c = h.store.getChat((req.params as any).id);
  if (!c?.link) throw Object.assign(new Error('Dieser Chat ist mit keinem anderen zusammengeführt.'), { statusCode: 400 });
  const via = (req.body as any)?.via ? String((req.body as any).via) : null;
  const ids = h.store.linkedIds(c.link);
  if (via && !ids.includes(via)) throw Object.assign(new Error('Chat gehört nicht zu diesem Kontakt.'), { statusCode: 400 });
  h.store.setSendVia(c.link, via);
  const out = ids.map((id) => h.store.getChat(id)!);
  for (const x of out) h.emit({ type: 'chat', chat: x });
  return out;
});

// ---------- Live-Ereignisse ----------
/** Wann eine App zuletzt gemeldet hat, dass sie im Vordergrund ist. Die App wiederholt das alle 20 s.
 *  Ein eingefrorenes iPhone meldet sich nicht ab, die Verbindung wirkt aber noch offen.
 *  Deshalb gilt eine App nur als sichtbar, solange die letzte Meldung frisch ist, sonst kommt die Push-Benachrichtigung. */
const visibleSince = new WeakMap<object, number>();
/** Push-Abo (Endpoint) des Geräts hinter einer Verbindung, damit nur dieses Gerät keine Push-Nachricht bekommt. */
const socketEndpoint = new WeakMap<object, string>();
const VISIBLE_FRESH_MS = 45_000;
function visibleEndpoints(c: Ctx) {
  const now = Date.now(), out = new Set<string>();
  for (const ws of c.sockets) {
    const t = visibleSince.get(ws), ep = socketEndpoint.get(ws);
    if (ws.readyState === 1 && t && now - t < VISIBLE_FRESH_MS && ep) out.add(ep);
  }
  return out;
}
function broadcast(c: Ctx, e: unknown) {
  const s = JSON.stringify(e);
  for (const ws of c.sockets) if (ws.readyState === 1) ws.send(s);
}
app.register(async (f) => {
  f.get('/api/ws', { websocket: true }, (socket, req) => {
    const c = authed(req);
    if (!c) { socket.close(4401, 'Nicht angemeldet'); return; }
    c.sockets.add(socket);
    socket.on('close', () => c.sockets.delete(socket));
    socket.on('message', (d) => {
      try {
        const m = JSON.parse(String(d));
        if (m?.type === 'visibility') {
          if (typeof m.endpoint === 'string' && m.endpoint.length < 2000) socketEndpoint.set(socket, m.endpoint);
          if (m.visible) visibleSince.set(socket, Date.now()); else visibleSince.delete(socket);
        }
      } catch { /* ignorieren */ }
    });
    // Tote Verbindungen (Handy eingefroren, Netz weg) erkennen und schließen: wer auf zwei Pings nicht antwortet, fliegt raus
    let alive = true;
    socket.on('pong', () => { alive = true; });
    const ping = setInterval(() => {
      if (socket.readyState !== 1) return;
      if (!alive) { visibleSince.delete(socket); socket.terminate(); return; }
      alive = false; socket.ping();
    }, 25_000);
    socket.on('close', () => clearInterval(ping));
  });
});

// ---------- Oberfläche ----------
if (existsSync(WEB_DIR)) {
  await app.register(fastifyStatic, {
    root: WEB_DIR, wildcard: false, cacheControl: false,
    // index.html und Service Worker immer frisch prüfen, die Dateien unter /assets/ tragen eine Prüfsumme im Namen und ändern sich nie
    setHeaders: (res: any, path: string) => {
      const v = /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache';
      if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', v); else res.header('Cache-Control', v);
    },
  });
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/')) return reply.code(404).send({ error: 'Nicht gefunden' });
    // Fehlende Dateien (z. B. Skripte einer alten Version) ehrlich mit 404 beantworten, nicht mit der Startseite:
    // sonst bekommt der Browser HTML statt JavaScript und die App bleibt leer
    // Altes App-Skript angefragt (iOS hat eine alte Startseite aufgehoben, z. B. beim Tipp auf eine Benachrichtigung):
    // statt 404 ein Mini-Skript, das die aktuelle Version frisch lädt. Der Chat aus der Benachrichtigung (#chat=…) bleibt erhalten.
    if (/^\/assets\/index-[\w-]+\.js$/.test(path)) {
      return reply.code(200).header('Cache-Control', 'no-store').type('application/javascript; charset=utf-8')
        .send("(function(){var k='inbox:stale',t=+(sessionStorage.getItem(k)||0);if(Date.now()-t<15000)return;sessionStorage.setItem(k,String(Date.now()));location.replace('/?r='+Date.now()+location.hash);})();");
    }
    if (path.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(path)) return reply.code(404).type('text/plain').send('Nicht gefunden');
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });
}

app.setErrorHandler((err: any, _req, reply) => {
  const code = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  if (code >= 500) app.log.error(err);
  reply.code(code).send({ error: err.message || (code >= 500 ? 'Unbekannter Fehler auf dem Server' : 'Fehler') });
});

for (const p of registry.all()) {
  if (ctxOf(p).vault.tryAutoUnlock()) app.log.info(`Komfort-Modus: Profil „${p.name}“ automatisch entsperrt`);
}

// ---------- Push-Benachrichtigungen ----------
app.get('/api/push', async (req) => {
  const h = H(req);
  return { key: push.publicKey, preview: push.preview(h.store), devices: push.subs(h.store).length };
});
app.post('/api/push/subscribe', async (req) => {
  const h = H(req);
  const b = req.body as { subscription?: any };
  const sub = b?.subscription;
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw Object.assign(new Error('Ungültige Anmeldung'), { statusCode: 400 });
  push.add(h.store, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, ua: String(req.headers['user-agent'] ?? '').slice(0, 200), created: Date.now() });
  return { ok: true };
});
app.post('/api/push/unsubscribe', async (req) => { push.remove(H(req).store, String((req.body as any)?.endpoint ?? '')); return { ok: true }; });
app.post('/api/push/test', async (req) => {
  await push.send(H(req).store, { title: 'Chorus', body: 'So sehen Benachrichtigungen aus. 🎉', tag: 'test' }, (req.body as any)?.endpoint);
  return { ok: true };
});
app.put('/api/push', async (req) => { H(req).store.setSetting('pushPreview', !!(req.body as any)?.preview); return { ok: true }; });

// ---------- Admin: Server ----------
const STARTED = Date.now();
app.get('/api/admin/status', async (req) => {
  needAdmin(req);
  const { statfs } = await import('node:fs/promises');
  const fs = await statfs(DATA_DIR).catch(() => null);
  const os = await import('node:os');
  const has = async (cmd: string, args: string[]) => new Promise<boolean>((res) => { try { const { spawn } = require_('node:child_process'); const p = spawn(cmd, args); p.on('error', () => res(false)); p.on('exit', (c: number) => res(c === 0)); } catch { res(false); } });
  return {
    version: VERSION, node: process.version, uptimeSec: Math.round((Date.now() - STARTED) / 1000),
    memMB: Math.round(process.memoryUsage().rss / 1048576), hostMemMB: Math.round(os.totalmem() / 1048576), hostFreeMB: Math.round(os.freemem() / 1048576),
    load: os.loadavg()[0], cpus: os.cpus().length,
    disk: fs ? { freeGB: +(fs.bavail * fs.bsize / 1e9).toFixed(1), totalGB: +(fs.blocks * fs.bsize / 1e9).toFixed(1) } : null,
    profiles: registry.all().map((p) => {
      const c = ctxs.get(p.id);
      return { name: p.name, unlocked: !!c?.vault.unlocked, comfort: !!c?.vault.comfortMode, accounts: c?.hub ? c.hub.accounts().filter((a) => a.network !== 'notes').map((a) => ({ network: a.network, state: a.status.state })) : [] };
    }),
    ffmpeg: await has('ffmpeg', ['-version']),
    logs: recentLogs.slice(-60).reverse(),
  };
});
app.post('/api/admin/restart', async (req) => {
  needAdmin(req);
  app.log.warn(`Neustart angefordert von „${C(req).p.name}“`);
  setTimeout(() => { void shutdown(); }, 400);
  return { ok: true };
});
app.post('/api/contacts/refresh', async (req) => { H(req).queueStaleContacts(undefined, true); return { ok: true }; });
app.post('/api/reconnect', async (req) => {
  const h = H(req);
  await h.stopAll(); await h.startAll();
  return { ok: true };
});

const shutdown = async () => {
  for (const c of ctxs.values()) { await c.hub?.stopAll(); c.hub?.store.close(); }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: PORT, host: HOST });
app.log.info(`Chorus ${VERSION} läuft auf Port ${PORT}`);
