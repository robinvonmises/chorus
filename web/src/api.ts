import { trustStore } from './keys';
import { T, lang } from './i18n';
export type Network = 'telegram' | 'signal' | 'whatsapp' | 'email' | 'demo';

export interface AccountStatus {
  state: 'disconnected' | 'connecting' | 'need_input' | 'qr' | 'connected' | 'error';
  field?: 'phone' | 'code' | 'password' | 'api';
  qr?: string;
  code?: string;
  message?: string;
  self?: string;
}
export interface Account { id: string; network: Network; label: string; status: AccountStatus; createdAt: number }
export interface Chat {
  id: string; accountId: string; network: Network; remoteId: string; title: string;
  kind: 'direct' | 'group' | 'channel'; lastTs: number; lastText: string; unread: number; pinned: boolean; muted: boolean;
  aiEnabled?: boolean;
  autopilot?: Autopilot | null;
  translate?: { on: boolean; lang?: string | null; langName?: string | null; out?: boolean; fixed?: boolean } | null;
  link?: string | null;
  /** E-Mail: Gegenüber. Alle Betreffe eines Absenders erscheinen als ein Kontakt */
  peer?: { id: string; name: string } | null;
  sendVia?: string | null;
  avatar?: string | null; customAvatar?: boolean; netTitle?: string; alias?: string | null; archived?: boolean; note?: string | null;
  info?: { phone?: string; username?: string; about?: string; description?: string; members?: number; fetchedAt?: number } | null;
}
export interface EmailConfig {
  address: string; name?: string; user?: string; imapHost: string; imapPort?: number; smtpHost: string; smtpPort?: number;
  signature?: string; hideSignatures?: string[]; hideBulk?: boolean; days?: number;
}
export interface Autopilot {
  on: boolean; max: number; used: number; note: string; mark: boolean;
  trigger?: 'me' | 'direct' | 'all'; only?: string[]; rule?: string; style?: 'me' | 'short' | 'creative';
}
export interface Attachment {
  fileId: string | null; name: string; mime: string; size: number;
  kind: 'image' | 'video' | 'audio' | 'voice' | 'file' | 'sticker'; durationSec?: number; width?: number; height?: number;
}
export interface Reaction { emoji: string; senderId: string; senderName?: string; fromMe: boolean }
export interface Message {
  id: string; chatId: string; remoteId: string; senderId: string; senderName: string; fromMe: boolean; ts: number;
  text: string; replyToRemoteId?: string | null; edited: boolean; deleted: boolean; attachments: Attachment[];
  reactions: Reaction[]; status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'received'; transcript?: string | null;
  /** Nur live bei fehlgeschlagenem Senden: Grund */
  error?: string;
  translation?: string | null;
  /** Sprache des Texts, wenn translation die deutsche Übersetzung ist (bei eigenen übersetzt gesendeten leer: dann ist translation das Original) */
  translationFrom?: string | null;
}
export interface PublicProfile {
  id: string; name: string; initialized: boolean; invite: boolean; totp: boolean; avatar: string | null;
  kdf: { alg: string; iterations: number; salt: string } | null;
}
export interface ProfileInfo extends PublicProfile { admin: boolean; createdAt: string; online: boolean }
export interface ServerState {
  version: string; networks: Network[]; profiles: PublicProfile[]; authed: boolean;
  profile: { id: string; name: string; admin: boolean; comfort: boolean; totp: boolean; avatar: string | null } | null;
}
export type HubEvent =
  | { type: 'account'; account: Account }
  | { type: 'account_removed'; id: string }
  | { type: 'chat_removed'; id: string }
  | { type: 'chat'; chat: Chat }
  | { type: 'message'; message: Message; replacedId?: string }
  | { type: 'message_removed'; id: string; chatId: string }
  | { type: 'notify'; chat: Chat; message: Message }
  | { type: 'planned'; items: Planned[] }
  | { type: 'reminder'; item: Planned; chat: Chat | null };

export interface Planned {
  id: string; kind: 'send' | 'remind'; chatId: string; at: number; created: number; text: string;
  replyTo?: string | null; translate?: boolean; messageId?: string | null; note?: string; error?: string;
}
export type MediaKind = 'media' | 'files' | 'voice' | 'links';

export interface AiSettings {
  provider: 'anthropic' | 'openai'; hasOpenaiKey: boolean; openaiModel: string; openaiBase: string;
  model: string; models: { id: string; label: string }[]; hasAnthropicKey: boolean; hasElevenKey: boolean;
  voiceId: string; voiceName: string; features: { text: boolean; transcribe: boolean; voice: boolean };
}
export interface Voice { id: string; name: string; category: string; previewUrl: string | null }

/** Fehlermeldungen des Servers sind Deutsch: übersetzen, bei „Text: Detail“ zumindest den Anfang */
export function serverText(m: string): string {
  const full = T(m);
  if (full !== m) return full;
  const i = m.indexOf(': ');
  return i > 0 ? `${T(m.slice(0, i))}: ${m.slice(i + 2)}` : m;
}
export class ApiError extends Error { constructor(public status: number, msg: string, public data: any = null) { super(msg); } }

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { 'x-chorus-lang': lang, ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) {
    if (r.status === 401 && !url.startsWith('/api/vault')) window.dispatchEvent(new Event('inbox:unauthorized'));
    // Fastify-Rahmenfehler liefern error: "Bad Request" und den eigentlichen Grund in message
    const generic = !data?.error || /^(Bad Request|Not Found|Internal Server Error|Payload Too Large)$/i.test(data.error);
    throw new ApiError(r.status, serverText((generic && data?.message) || data?.error || `${r.status} ${r.statusText}`.trim()), data);
  }
  return data as T;
}

export const api = {
  state: () => req<ServerState>('GET', '/api/state'),
  setup: (b: { profileId?: string; name?: string; invite?: string; salt: string; key: string }) => req<{ recoveryCode: string; profileId: string }>('POST', '/api/vault/setup', b),
  unlock: (profileId: string, key: string, code?: string, remember?: boolean) => req<{ ok: true; trust?: string }>('POST', '/api/vault/unlock', { profileId, key, code, remember, trust: trustStore.get(profileId) }),
  profiles: () => req<ProfileInfo[]>('GET', '/api/profiles'),
  createProfile: (name: string) => req<{ profile: PublicProfile; invite: string }>('POST', '/api/profiles', { name }),
  newInvite: (id: string) => req<{ invite: string }>('POST', `/api/profiles/${id}/invite`),
  renameProfile: (id: string, name: string) => req<PublicProfile>('PATCH', `/api/profiles/${id}`, { name }),
  deleteProfile: (id: string) => req('DELETE', `/api/profiles/${id}`),
  setAvatar: (id: string, jpeg: Blob) => { const f = new FormData(); f.append('file', jpeg, 'avatar.jpg'); return req<PublicProfile>('PUT', `/api/profiles/${id}/avatar`, f); },
  storage: () => req<StorageSettings>('GET', '/api/storage'),
  setStorage: (patch: { immich?: Record<string, unknown>; nextcloud?: Record<string, unknown> }) => req<StorageSettings>('PUT', '/api/storage', patch),
  testStorage: (target: StorageTarget) => req<{ message: string }>('POST', '/api/storage/test', { target }),
  saveTo: (m: Message, i: number, target: StorageTarget, opt: { folder?: string; name?: string } = {}) => req<{ message: string }>('POST', '/api/storage/save', { message: m.id, index: i, target, ...opt }),
  immichAssets: (o: { page?: number; album?: string; q?: string }) => req<{ items: ImmichAsset[]; next: number | null }>('GET', `/api/storage/immich/assets?page=${o.page ?? 1}${o.album ? `&album=${enc(o.album)}` : ''}${o.q ? `&q=${enc(o.q)}` : ''}`),
  immichAlbums: () => req<ImmichAlbum[]>('GET', '/api/storage/immich/albums'),
  immichThumb: (id: string) => `/api/storage/immich/assets/${enc(id)}/thumb`,
  async immichFile(a: ImmichAsset): Promise<File> {
    const r = await fetch(`/api/storage/immich/assets/${enc(a.id)}/send`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as any).error ?? T('Fehler {0}', r.status));
    const cd = r.headers.get('Content-Disposition') ?? '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i);
    return new File([await r.blob()], m ? decodeURIComponent(m[1]) : a.name || 'Foto', { type: r.headers.get('X-File-Mime') || 'application/octet-stream' });
  },
  ncList: (path: string) => req<NcListing>('GET', `/api/storage/nextcloud/list?path=${enc(path)}`),
  ncMkdir: (path: string) => req<{ path: string }>('POST', '/api/storage/nextcloud/mkdir', { path }),
  async ncFile(path: string): Promise<File> {
    const r = await fetch(`/api/storage/nextcloud/file?path=${enc(path)}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as any).error ?? T('Fehler {0}', r.status));
    return new File([await r.blob()], path.split('/').pop() || 'Datei', { type: r.headers.get('X-File-Mime') || 'application/octet-stream' });
  },
  media: () => req<{ autoSave: boolean }>('GET', '/api/media'),
  setMedia: (autoSave: boolean) => req<{ autoSave: boolean }>('PUT', '/api/media', { autoSave }),
  removeAvatar: (id: string) => req<PublicProfile>('DELETE', `/api/profiles/${id}/avatar`),
  totpSetup: () => req<{ secret: string; uri: string }>('POST', '/api/2fa/setup'),
  totpEnable: (code: string) => req<{ ok: true; trust?: string }>('POST', '/api/2fa/enable', { code }),
  totpDisable: (code: string) => req<{ ok: true }>('POST', '/api/2fa/disable', { code }),
  recover: (profileId: string, code: string, salt: string, key: string) => req('POST', '/api/vault/recover', { profileId, code, salt, key }),
  changePassword: (salt: string, key: string) => req('POST', '/api/vault/password', { salt, key }),
  setComfort: (on: boolean) => req<{ comfort: boolean }>('POST', '/api/vault/comfort', { on }),
  logout: () => req('POST', '/api/logout'),

  accounts: () => req<Account[]>('GET', '/api/accounts'),
  addAccount: (network: Network, label: string, config: Record<string, unknown>) => req<Account>('POST', '/api/accounts', { network, label, config }),
  removeAccount: (id: string) => req('DELETE', `/api/accounts/${id}`),
  emailConfig: (id: string) => req<EmailConfig>('GET', `/api/accounts/${id}/config`),
  setEmailConfig: (id: string, cfg: Partial<EmailConfig> & { password?: string }) => req('PATCH', `/api/accounts/${id}/config`, cfg),
  restartAccount: (id: string) => req('POST', `/api/accounts/${id}/restart`),
  input: (id: string, field: string, value: string) => req('POST', `/api/accounts/${id}/input`, { field, value }),

  chats: () => req<Chat[]>('GET', '/api/chats'),
  deleteChat: (id: string) => req('DELETE', `/api/chats/${enc(id)}`),
  patchChat: (id: string, patch: Partial<Pick<Chat, 'pinned' | 'muted' | 'archived' | 'alias' | 'note'>>) => req<Chat>('PATCH', `/api/chats/${enc(id)}`, patch),
  markUnread: (id: string) => req<Chat>('POST', `/api/chats/${enc(id)}/unread`),
  /** Profilbilder der Absender in einer Gruppe (senderId → Bild-URL); pending: weitere werden gerade geholt */
  senderAvatars: (id: string) => req<{ avatars: Record<string, string>; pending: boolean }>('GET', `/api/chats/${enc(id)}/sender-avatars`),
  refreshContact: (id: string) => req<Chat>('POST', `/api/chats/${enc(id)}/contact`),
  adminStatus: () => req<{
    version: string; node: string; uptimeSec: number; memMB: number; hostMemMB: number; hostFreeMB: number; load: number; cpus: number;
    disk: { freeGB: number; totalGB: number } | null; ffmpeg: boolean; logs: { t: number; level: number; msg: string }[];
    profiles: { name: string; unlocked: boolean; comfort: boolean; accounts: { network: Network; state: string }[] }[];
  }>('GET', '/api/admin/status'),
  adminRestart: () => req('POST', '/api/admin/restart'),
  reconnect: () => req('POST', '/api/reconnect'),
  refreshContacts: () => req('POST', '/api/contacts/refresh'),
  push: () => req<{ key: string; preview: boolean; devices: number }>('GET', '/api/push'),
  pushSubscribe: (s: PushSubscription) => req('POST', '/api/push/subscribe', { subscription: s.toJSON() }),
  pushUnsubscribe: (endpoint: string) => req('POST', '/api/push/unsubscribe', { endpoint }),
  pushTest: (endpoint: string) => req('POST', '/api/push/test', { endpoint }),
  setPushPreview: (preview: boolean) => req('PUT', '/api/push', { preview }),
  sync: () => req<Chat[]>('POST', '/api/sync'),
  setChatAvatar: (id: string, jpeg: Blob) => { const f = new FormData(); f.append('file', jpeg, 'avatar.jpg'); return req<Chat>('PUT', `/api/chats/${enc(id)}/avatar`, f); },
  removeChatAvatar: (id: string) => req<Chat>('DELETE', `/api/chats/${enc(id)}/avatar`),
  markRead: (id: string) => req('POST', `/api/chats/${enc(id)}/read`),
  messages: (id: string, before?: number) => req<Message[]>('GET', `/api/chats/${enc(id)}/messages${before ? `?before=${before}` : ''}`),
  history: (id: string) => req('POST', `/api/chats/${enc(id)}/history`),
  send: (id: string, text: string, replyTo?: string | null, translate?: boolean) => req('POST', `/api/chats/${enc(id)}/send`, { text, replyTo, translate }),
  translate: (id: string, on: boolean, out?: boolean, lang?: { lang: string | null; langName?: string | null }) => req<Chat>('PUT', `/api/chats/${enc(id)}/translate`, { on, out, ...(lang ?? {}) }),
  translateGuess: (id: string) => req<{ guess: { lang: string; langName: string } | null }>('GET', `/api/chats/${enc(id)}/translate`),
  planned: () => req<Planned[]>('GET', '/api/planned'),
  plan: (p: Partial<Planned> & { kind: Planned['kind']; chatId: string; at: number }) => req<Planned>('POST', '/api/planned', p),
  replan: (id: string, patch: { at?: number; text?: string }) => req<Planned>('PATCH', `/api/planned/${enc(id)}`, patch),
  unplan: (id: string) => req('DELETE', `/api/planned/${enc(id)}`),
  planNow: (id: string) => req('POST', `/api/planned/${enc(id)}/now`, {}),
  gallery: (kind: MediaKind, chats?: string[], before?: number) => req<Message[]>('GET', `/api/gallery?kind=${kind}${chats ? `&chats=${chats.map(enc).join(',')}` : ''}${before ? `&before=${before}` : ''}`),
  aiSearch: (question: string) => req<{ answer: string; messages: Message[]; terms: string[]; scope: 'all' | 'ai' }>('POST', '/api/search/ai', { question }),
  aiSearchScope: () => req<{ all: boolean }>('GET', '/api/search/ai'),
  setAiSearchScope: (all: boolean) => req<{ all: boolean }>('PUT', '/api/search/ai', { all }),
  links: (id: string) => req<{ linked: Chat[]; suggestions: Chat[] }>('GET', `/api/chats/${enc(id)}/link`),
  link: (id: string, other: string) => req<Chat[]>('POST', `/api/chats/${enc(id)}/link`, { other }),
  unlink: (id: string) => req('DELETE', `/api/chats/${enc(id)}/link`),
  setVia: (id: string, via: string | null) => req<Chat[]>('PUT', `/api/chats/${enc(id)}/via`, { via }),
  upload: (id: string, file: Blob, name: string, opts: { caption?: string; width?: number; height?: number; translate?: boolean; replyTo?: string | null; voice?: boolean; duration?: number; video?: { start: number; end: number; crop?: { x: number; y: number; w: number; h: number } }; onProgress?: (p: number) => void } = {}) => {
    const fd = new FormData();
    if (opts.caption) fd.append('caption', opts.caption);
    if (opts.translate) fd.append('translate', '1');
    if (opts.width && opts.height) { fd.append('width', String(opts.width)); fd.append('height', String(opts.height)); }
    if (opts.replyTo) fd.append('replyTo', opts.replyTo);
    if (opts.voice) fd.append('voice', '1');
    if (opts.duration) fd.append('duration', String(opts.duration));
    if (opts.video) fd.append('video', JSON.stringify(opts.video));
    fd.append('file', file, name); // Datei zuletzt, damit die Felder vorher gelesen werden
    if (!opts.onProgress) return req('POST', `/api/chats/${enc(id)}/upload`, fd);
    // Mit Fortschritt: fetch kann das beim Hochladen nicht, daher XHR
    const url = `/api/chats/${enc(id)}/upload`, onProgress = opts.onProgress;
    return new Promise<unknown>((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', url);
      x.withCredentials = true;
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.upload.onload = () => onProgress(1);
      x.onerror = () => reject(new ApiError(0, T('Keine Verbindung zum Server')));
      x.onload = () => {
        let data: any = null;
        try { data = JSON.parse(x.responseText); } catch { /* keine JSON-Antwort */ }
        if (x.status >= 200 && x.status < 300) return resolve(data);
        if (x.status === 401) window.dispatchEvent(new Event('inbox:unauthorized'));
        reject(new ApiError(x.status, data?.error ?? x.statusText, data));
      };
      x.send(fd);
    });
  },
  react: (msgId: string, emoji: string | null) => req('POST', `/api/messages/${enc(msgId)}/react`, { emoji }),
  forward: (msgId: string, chatIds: string[]) => req<{ ok: boolean; count: number }>('POST', `/api/messages/${enc(msgId)}/forward`, { chatIds }),
  edit: (msgId: string, text: string) => req('PATCH', `/api/messages/${enc(msgId)}`, { text }),
  retry: (msgId: string) => req('POST', `/api/messages/${enc(msgId)}/retry`),
  discard: (msgId: string) => req('DELETE', `/api/messages/${enc(msgId)}/discard`),
  remove: (msgId: string, everyone: boolean) => req('DELETE', `/api/messages/${enc(msgId)}${everyone ? '?everyone=1' : ''}`),
  searchChats: (q: string) => req<Chat[]>('GET', `/api/chats/search?q=${encodeURIComponent(q)}`),
  startChat: (accountId: string, phone: string) => req<Chat>('POST', `/api/accounts/${accountId}/start-chat`, { phone }),
  search: (q: string, chats?: string[]) => req<Message[]>('GET', `/api/search?q=${encodeURIComponent(q)}${chats ? `&chats=${chats.map(enc).join(',')}` : ''}`),

  ai: {
    settings: () => req<AiSettings>('GET', '/api/ai/settings'),
    save: (patch: Record<string, string | null>) => req<AiSettings>('PUT', '/api/ai/settings', patch),
    voices: () => req<Voice[]>('GET', '/api/ai/voices'),
    openaiModels: () => req<string[]>('GET', '/api/ai/openai-models'),
    setChat: (id: string, on: boolean) => req<Chat>('POST', `/api/chats/${enc(id)}/ai`, { on }),
    summary: (id: string) => req<{ text: string }>('POST', `/api/chats/${enc(id)}/ai/summary`, {}),
    quick: (id: string) => req<{ key: string | null; suggestions: string[] }>('POST', `/api/chats/${enc(id)}/ai/quick`, {}),
    suggest: (id: string, hint?: string) => req<{ suggestions: string[] }>('POST', `/api/chats/${enc(id)}/ai/suggest`, { hint }),
    voice: (id: string, text: string, replyTo?: string | null) => req<{ ok: true }>('POST', `/api/chats/${enc(id)}/ai/voice`, { text, replyTo }),
    preview: (id: string, text: string) => req<{ audio: string; mime: string }>('POST', `/api/chats/${enc(id)}/ai/voice`, { text, preview: true }),
    autopilot: (id: string, patch: Partial<Autopilot> & { reset?: boolean }) => req<Chat>('PUT', `/api/chats/${enc(id)}/autopilot`, patch),
    participants: (id: string) => req<{ id: string; name: string }[]>('GET', `/api/chats/${enc(id)}/participants`),
    compose: (id: string, instruction: string, mode: 'text' | 'voice') => req<{ text: string }>('POST', `/api/chats/${enc(id)}/ai/compose`, { instruction, mode }),
    dictate: (audio: Blob) => { const fd = new FormData(); fd.append('file', audio, 'auftrag.' + (audio.type.includes('mp4') ? 'm4a' : audio.type.includes('ogg') ? 'ogg' : 'webm')); return req<{ text: string }>('POST', '/api/ai/dictate', fd); },
    transcribe: (msgId: string) => req<Message>('POST', `/api/messages/${enc(msgId)}/transcribe`, {}),
    translateOne: (msgId: string) => req<{ message: Message; already: boolean }>('POST', `/api/messages/${enc(msgId)}/translate`, {}),
  },
};

export const enc = encodeURIComponent;
export type StorageTarget = 'immich' | 'nextcloud';
export interface StorageSettings {
  immich: { enabled: boolean; url: string; hasKey: boolean };
  nextcloud: { enabled: boolean; url: string; user: string; hasPass: boolean; folder: string };
}
export interface ImmichAsset { id: string; video: boolean; name: string; taken: number; duration: string }
export interface ImmichAlbum { id: string; name: string; count: number; cover: string | null; updated: number }
export interface NcListing { path: string; folders: string[]; files: { name: string; size: number; mime: string; modified: number }[] }
export const attachmentUrl = (m: Message, i: number, download = false) => `/api/attachment?m=${enc(m.id)}&i=${i}${download ? '&download=1' : ''}`;
/** Kleine Vorschau (max. 720 px) für die Chat-Ansicht; GIFs und Sticker bleiben im Original (Animation) */
export const thumbUrl = (m: Message, i: number) => {
  const a = m.attachments[i];
  if (!a || a.kind === 'sticker' || /gif/i.test(a.mime)) return attachmentUrl(m, i);
  return `${attachmentUrl(m, i)}&thumb=1`;
};

/** WebSocket mit automatischem Wiederverbinden */
export function connectEvents(onEvent: (e: HubEvent) => void, onStatus: (online: boolean) => void, onUnauthorized: () => void, onReconnect?: () => void) {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let opened = false;
  let hiddenAt = 0;
  const open = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/api/ws`);
    ws = sock;
    sock.onopen = () => {
      delay = 1000; onStatus(true); sendVisibility();
      // Nach einer Unterbrechung verpasste Nachrichten nachholen
      if (opened) onReconnect?.();
      opened = true;
    };
    sock.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch { /* ignore */ } };
    sock.onclose = (e) => {
      if (ws !== sock) return; // schon durch eine neue Verbindung ersetzt
      onStatus(false);
      if (closed) return;
      if (e.code === 4401) { onUnauthorized(); return; }
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, 15000);
    };
  };
  // Zurück aus dem Hintergrund: iOS hält die Verbindung eingefroren und meldet oft nicht, dass sie tot ist.
  // Deshalb nach einer Pause sofort neu verbinden; das holt auch alles nach, was in der Zwischenzeit kam.
  const wake = () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    if (closed) return;
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (!ws || ws.readyState > 1 || away > 3000) {
      const old = ws; ws = null;
      if (old) { old.onclose = null; old.onmessage = null; try { old.close(); } catch { /* egal */ } }
      delay = 1000;
      open();
    }
  };
  // Dem Server sagen, ob die App gerade sichtbar ist: dann kommt keine Push-Benachrichtigung
  const sendVisibility = () => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'visibility', visible: document.visibilityState === 'visible' })); };
  const onVis = () => { sendVisibility(); wake(); };
  // Solange die App offen ist, regelmäßig „sichtbar“ melden; bleibt das aus (App eingefroren), schickt der Server wieder Push
  const beat = setInterval(() => { if (document.visibilityState === 'visible') sendVisibility(); }, 20_000);
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', sendVisibility);
  window.addEventListener('pageshow', wake);
  window.addEventListener('online', wake);
  open();
  return () => {
    closed = true; if (timer) clearTimeout(timer); clearInterval(beat);
    document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', sendVisibility);
    window.removeEventListener('pageshow', wake); window.removeEventListener('online', wake); ws?.close();
  };
}
