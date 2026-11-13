import { randomUUID } from 'node:crypto';
import type { Store } from './db.js';
import { toOggOpusTimed } from './audio.js';
import type { Account, AccountStatus, Adapter, AdapterEvents, Attachment, Network, OutgoingFile, Message, Chat } from './types.js';

export type AdapterFactory = (opts: {
  accountId: string;
  config: Record<string, unknown>;
  session: string | null;
  events: AdapterEvents;
  dataDir: string;
}) => Adapter;

export type HubEvent =
  | { type: 'account'; account: Account }
  | { type: 'account_removed'; id: string }
  | { type: 'chat'; chat: Chat }
  | { type: 'chat_removed'; id: string }
  | { type: 'message'; message: Message; replacedId?: string }
  | { type: 'message_removed'; id: string; chatId: string }
  | { type: 'typing'; chatId: string; on: boolean }
  | { type: 'notify'; chat: Chat; message: Message }
  | { type: 'planned'; items: import('./planner.js').Planned[] }
  | { type: 'reminder'; item: import('./planner.js').Planned; chat: Chat | null }
  | { type: 'broadcast'; job: BroadcastJob };

/** Massen-Nachricht: Fortschritt (geht live an alle Geräte) */
export interface BroadcastJob { id: string; total: number; done: number; failed: number; running: boolean; current?: string | null }

/** Zentrale: hält alle Adapter, speichert Ereignisse, verteilt sie an verbundene Browser */
export { fixKind } from './kinds.js';
import { fixKind, sniffKind } from './kinds.js';
import { imageSize } from './imagesize.js';
import { thumbnail } from './thumbs.js';

/** Bildgröße nachtragen, wenn der Messenger keine geliefert hat: so kann die Oberfläche den Platz freihalten */
function withSize<T extends { kind: string; width?: number; height?: number }>(a: T, data: Buffer): T {
  if ((a.kind !== 'image' && a.kind !== 'sticker') || (a.width && a.height)) return a;
  const s = imageSize(data);
  return s ? { ...a, ...s } : a;
}

const rank: Record<string, number> = { pending: 0, failed: 0, sent: 1, delivered: 2, read: 3 };
const MAX_AUTO_MEDIA = Number(process.env.MAX_AUTO_MEDIA_MB ?? 200) * 1024 * 1024;

export class Hub {
  private adapters = new Map<string, Adapter>();
  private statuses = new Map<string, AccountStatus>();
  private subscribers = new Set<(e: HubEvent) => void>();
  /** Neue eingehende Nachrichten (für den Autopiloten) */
  readonly incoming = new Set<(chat: Chat, msg: Message) => void>();
  /** Neue eigene Nachrichten, aus Chorus oder vom Handy (für die Live-Übersetzung) */
  readonly own = new Set<(chat: Chat, msg: Message) => void>();
  private fire(set: Set<(chat: Chat, msg: Message) => void>, chat: Chat, msg: Message) { for (const f of set) { try { f(chat, msg); } catch { /* ignore */ } } }
  /** Eigene Nummern/Namen je Konto (für Erwähnungen) */
  selfOf(accountId: string): string | undefined { return this.statuses.get(accountId)?.self; }

  constructor(
    public store: Store,
    private factories: Partial<Record<Network, AdapterFactory>>,
    private dataDir: string,
  ) {}

  subscribe(fn: (e: HubEvent) => void) { this.subscribers.add(fn); return () => this.subscribers.delete(fn); }
  emit(e: HubEvent) { for (const s of this.subscribers) { try { s(e); } catch { /* ignore */ } } }

  get availableNetworks(): Network[] { return Object.keys(this.factories) as Network[]; }

  accounts(): Account[] {
    return this.store.listAccountRows().map((r) => ({
      id: r.id, network: r.network, label: r.label, createdAt: r.created_at,
      status: this.statuses.get(r.id) ?? { state: 'disconnected' },
    }));
  }
  private account(id: string): Account | undefined { return this.accounts().find((a) => a.id === id); }

  async startAll() {
    const ghosts = this.store.clearGhostDrafts();
    if (ghosts) console.log(`[hub] ${ghosts} alte Entwürfe gelöscht (schon gesendet)`);
    for (const r of this.store.listAccountRows()) await this.startAccount(r.id).catch((e) => console.error('[hub] start', r.id, e));
  }

  async stopAll() {
    clearInterval(this.staleTimer);
    clearInterval(this.expiryTimer);
    for (const a of this.adapters.values()) await a.stop().catch(() => {});
    this.adapters.clear();
  }

  private makeEvents(accountId: string, network: Network): AdapterEvents {
    const store = this.store;
    const chatId = (remote: string) => `${accountId}:${remote}`;
    return {
      status: (s) => {
        const was = this.statuses.get(accountId)?.state;
        this.statuses.set(accountId, s);
        if (s.state === 'connected' && was !== 'connected') setTimeout(() => this.queueStaleContacts(accountId), 20_000);
        const a = this.account(accountId);
        if (a) this.emit({ type: 'account', account: a });
      },
      chat: (c) => {
        const chat = store.upsertChat({ ...c, accountId, network });
        this.emit({ type: 'chat', chat });
      },
      message: (m) => {
        const cid = chatId(m.chatRemoteId);
        if (!store.getChat(cid)) {
          store.upsertChat({ accountId, network, remoteId: m.chatRemoteId, title: m.senderName || m.chatRemoteId, kind: 'direct', lastTs: 0, lastText: '' });
        }
        const { chatRemoteId: _c, ...rest } = m;
        rest.attachments = rest.attachments.map(fixKind);
        const prevLastTs = store.getChat(cid)!.lastTs;
        const { msg, isNew } = store.upsertMessage({ ...rest, chatId: cid });
        if (isNew) {
          const preview = previewText(msg);
          // Ungelesen nur zählen, wenn die Nachricht neuer ist als alles Bekannte (nicht beim Nachladen)
          store.touchChat(cid, msg.ts, preview, !msg.fromMe && msg.ts > prevLastTs);
          // Archivierte Chats bleiben im Archiv und melden sich nicht
          const chat = store.getChat(cid)!;
          if (!chat.info?.fetchedAt) this.queueContact(cid);
          this.emit({ type: 'chat', chat });
          if (!msg.fromMe && Date.now() - msg.ts < 60_000 && !chat.muted && !chat.archived) this.emit({ type: 'notify', chat, message: msg });
          if (Date.now() - msg.ts < 5 * 60_000) this.fire(msg.fromMe ? this.own : this.incoming, chat, msg);
          if (msg.attachments.some((a) => !a.fileId)) this.queueMedia(msg.id);
          this.draftSent(cid, msg);
        }
        this.emit({ type: 'message', message: msg });
      },
      messageUpdate: (chatRemote, remoteId, patch) => {
        // Sonderformen: '<=123' = alle eigenen bis ID 123 (Lesebestätigung), Chat '*' = Chat unbekannt
        const ids = remoteId.startsWith('<=')
          ? store.outgoingUpTo(chatId(chatRemote), Number(remoteId.slice(2)))
          : chatRemote === '*' || !store.getMessage(`${chatId(chatRemote)}:${remoteId}`) ? store.findByRemote(accountId, remoteId) : [`${chatId(chatRemote)}:${remoteId}`];
        if (patch.status && !remoteId.startsWith('<=')) console.log(`[status] ${remoteId} → ${patch.status} (${ids.length ? 'gefunden' : 'nicht gefunden'})`);
        for (const id of ids) {
          // Status nie zurückstufen (z. B. „gelesen“ → „zugestellt“, wenn Bestätigungen in falscher Reihenfolge kommen)
          if (patch.status && rank[patch.status] > 0) {
            const cur = store.getMessage(id)?.status;
            if (cur && (rank[cur] ?? -1) >= rank[patch.status]) continue;
          }
          // Vom Gegenüber zurückgezogen: Inhalt behalten und nur als gelöscht markieren (abschaltbar)
          let p = patch;
          if (patch.deleted && this.keepDeleted && !store.getMessage(id)?.fromMe) { const { text: _t, ...rest } = patch; p = rest; }
          const msg = store.patchMessage(id, p);
          if (msg) this.emit({ type: 'message', message: msg });
        }
      },
      reactions: (chatRemote, remoteId, reactions) => {
        const msg = store.patchMessage(`${chatId(chatRemote)}:${remoteId}`, { reactions });
        if (msg) this.emit({ type: 'message', message: msg });
      },
      reactionChange: (chatRemote, remoteId, r, remove) => {
        const id = `${chatId(chatRemote)}:${remoteId}`;
        const cur = store.getMessage(id);
        if (!cur) return;
        const others = cur.reactions.filter((x) => x.senderId !== r.senderId && !(r.fromMe && x.fromMe));
        const msg = store.patchMessage(id, { reactions: remove ? others : [...others, r] });
        if (msg) this.emit({ type: 'message', message: msg });
      },
      typing: (chatRemote, on) => { const cid = chatId(chatRemote); if (store.getChat(cid)) this.emit({ type: 'typing', chatId: cid, on }); },
      storeFile: (data) => store.storeFile(data),
      getMessage: (chatRemote, remoteId) => store.getMessage(`${chatId(chatRemote)}:${remoteId}`),
      saveSession: (data) => store.saveSession(accountId, data),
      log: (msg) => console.log(`[${network}:${accountId}] ${msg}`),
    };
  }

  async startAccount(id: string) {
    const row = this.store.getAccountRow(id);
    if (!row) throw new Error('Konto nicht gefunden');
    const f = this.factories[row.network];
    if (!f) throw new Error(`Messenger ${row.network} ist in dieser Version nicht verfügbar`);
    const old = this.adapters.get(id);
    if (old) await old.stop().catch(() => {});
    const adapter = f({ accountId: id, config: JSON.parse(row.config), session: row.session, events: this.makeEvents(id, row.network), dataDir: this.dataDir });
    this.adapters.set(id, adapter);
    this.statuses.set(id, { state: 'connecting' });
    adapter.start().catch((e) => {
      this.statuses.set(id, { state: 'error', message: String(e?.message ?? e) });
      const a = this.account(id); if (a) this.emit({ type: 'account', account: a });
    });
  }

  async addAccount(network: Network, label: string, config: Record<string, unknown>) {
    if (!this.factories[network]) throw new Error('Messenger nicht verfügbar');
    const id = this.store.createAccount(network, label, config);
    await this.startAccount(id);
    return this.account(id)!;
  }

  async removeAccount(id: string) {
    const a = this.adapters.get(id);
    if (a) { await a.logout().catch(() => {}); await a.stop().catch(() => {}); }
    this.adapters.delete(id);
    this.statuses.delete(id);
    this.store.deleteAccount(id);
    this.emit({ type: 'account_removed', id });
  }

  async input(id: string, field: string, value: string) {
    const a = this.adapters.get(id);
    if (!a) throw new Error('Konto läuft nicht');
    await a.input(field, value);
  }

  private adapterFor(chat: Chat): Adapter {
    const a = this.adapters.get(chat.accountId);
    if (!a) throw new Error('Konto ist nicht verbunden');
    return a;
  }

  private chatOrThrow(chatId: string): Chat {
    const c = this.store.getChat(chatId);
    if (!c) throw new Error('Chat nicht gefunden');
    return c;
  }

  /** Optimistisch: Nachricht sofort anzeigen, dann senden */
  private pending(chat: Chat, text: string, replyTo: string | null | undefined, attachments: Message['attachments']): Message {
    const tmp = 'local-' + randomUUID();
    const { msg } = this.store.upsertMessage({
      chatId: chat.id, remoteId: tmp, senderId: 'me', senderName: 'Ich', fromMe: true, ts: Date.now(), text,
      replyToRemoteId: replyTo ?? null, edited: false, deleted: false, attachments, status: 'pending',
    });
    this.emit({ type: 'message', message: msg });
    this.draftSent(chat.id, msg);
    return msg;
  }
  /** Gesendet (aus Chorus oder vom Handy): passenden Entwurf löschen und den Geräten melden */
  private draftSent(chatId: string, msg: Message) {
    if (!msg.fromMe) return;
    for (const id of this.store.clearSentDraft(chatId, [msg.text, msg.translation])) this.emitChat(id);
  }

  private async finish(chat: Chat, tmp: Message, send: () => Promise<string>): Promise<Message | null> {
    try {
      const remoteId = await send();
      const msg = this.store.renameMessage(tmp.id, remoteId, chat.id);
      if (msg) {
        let m2 = msg.status === 'pending' ? this.store.patchMessage(msg.id, { status: 'sent' })! : msg;
        // Notizen an mich: eingestellte Lebensdauer anhängen (selbstzerstörend)
        const ttl = chat.network === 'notes' ? this.notesTtl : 0;
        if (ttl > 0) m2 = this.store.setExpiry(m2.id, Date.now() + ttl * 1000) ?? m2;
        this.emit({ type: 'message', message: m2, replacedId: tmp.id });
        this.store.touchChat(chat.id, m2.ts, previewText(m2), false);
        this.emit({ type: 'chat', chat: this.store.getChat(chat.id)! });
        this.fire(this.own, chat, m2);
        return m2;
      }
      return null;
    } catch (e: any) {
      const error = String(e?.message ?? e).slice(0, 300);
      console.error(`[${chat.network}] Senden fehlgeschlagen: ${error}`);
      const msg = this.store.patchMessage(tmp.id, { status: 'failed' });
      // Grund nur live mitschicken (nicht gespeichert): das Menü der Nachricht zeigt ihn an
      if (msg) this.emit({ type: 'message', message: { ...msg, error } });
      throw e;
    }
  }

  /** Fehlgeschlagene eigene Nachricht erneut senden (gleiche Blase, wieder „wird gesendet“) */
  async retry(messageId: string): Promise<Message | null> {
    const msg = this.store.getMessage(messageId);
    if (!msg || !msg.fromMe || msg.status !== 'failed' || !msg.remoteId.startsWith('local-')) throw Object.assign(new Error('Nachricht kann nicht erneut gesendet werden'), { statusCode: 400 });
    const chat = this.chatOrThrow(msg.chatId);
    const a = this.adapterFor(chat);
    let send: () => Promise<string>;
    if (!msg.attachments.length) send = () => a.sendText(chat.remoteId, msg.text, msg.replyToRemoteId);
    else {
      const att = msg.attachments[0];
      const data = att.fileId ? this.store.readFile(att.fileId) : null;
      if (!data) throw Object.assign(new Error('Anhang ist nicht mehr vorhanden'), { statusCode: 410 });
      const file: OutgoingFile = { data, name: att.name || 'datei', mime: att.mime || 'application/octet-stream', voice: att.kind === 'voice', gif: !!att.gif, durationSec: att.durationSec,
        ...(att.width && att.height ? { width: att.width, height: att.height } : {}) };
      send = () => a.sendFile(chat.remoteId, file, msg.text || undefined, msg.replyToRemoteId);
    }
    const tmp = this.store.patchMessage(msg.id, { status: 'pending' })!;
    this.emit({ type: 'message', message: tmp });
    return this.finish(chat, tmp, send);
  }

  /** Nie gesendete Nachricht ganz entfernen (nur lokal vorhanden) */
  discard(messageId: string) {
    const msg = this.store.getMessage(messageId);
    if (!msg || !msg.fromMe || !msg.remoteId.startsWith('local-')) throw Object.assign(new Error('Nur nicht gesendete Nachrichten können verworfen werden'), { statusCode: 400 });
    this.store.removeMessage(msg.id);
    this.emit({ type: 'message_removed', id: msg.id, chatId: msg.chatId });
  }

  async sendText(chatId: string, text: string, replyTo?: string | null) {
    const chat = this.chatOrThrow(chatId);
    const a = this.adapterFor(chat);
    const tmp = this.pending(chat, text, replyTo, []);
    return this.finish(chat, tmp, () => a.sendText(chat.remoteId, text, replyTo));
  }

  async sendFile(chatId: string, file: OutgoingFile, caption?: string, replyTo?: string | null) {
    const chat = this.chatOrThrow(chatId);
    const a = this.adapterFor(chat);
    if (file.voice) {
      // Immer neu kodieren: Browser-Aufnahmen (auch „audio/ogg“) haben oft fehlende Längenangaben oder andere Abtastraten, die WhatsApp nicht laden kann
      const { data, durationSec } = await toOggOpusTimed(file.data);
      file = { ...file, data, mime: 'audio/ogg', name: file.name.replace(/\.[^.]+$/, '') + '.ogg', durationSec: Math.max(1, Math.round(file.durationSec || durationSec)) };
    }
    const fileId = this.store.storeFile(file.data);
    const kind = file.voice ? 'voice' : file.mime.startsWith('image/') ? 'image' : file.mime.startsWith('video/') ? 'video' : file.mime.startsWith('audio/') ? 'audio' : 'file';
    const dims = kind === 'image' ? imageSize(file.data) : file.width && file.height ? { width: file.width, height: file.height } : null;
    const tmp = this.pending(chat, caption ?? '', replyTo, [{ fileId, name: file.name, mime: file.mime, size: file.data.length, kind, durationSec: file.durationSec, ...(file.gif ? { gif: true } : {}), ...(dims ?? {}) }]);
    // Nicht auf den Messenger warten: Die Nachricht steht ab jetzt im Chat und zeigt selbst „wird gesendet“, „gesendet“ oder „fehlgeschlagen“.
    const done = this.finish(chat, tmp, () => a.sendFile(chat.remoteId, file, caption, replyTo))
      .catch((e) => { console.error(`[${chat.network}] Datei senden fehlgeschlagen: ${e?.message || e}`); return null; });
    return { pending: tmp, done };
  }

  /** KI-Nachricht kennzeichnen: 🤖 als eigene Reaktion (Telegram erlaubt 🤖 nicht als Reaktion, dort steht es im Text) */
  async markBot(m: Message | null | undefined) {
    if (!m) return;
    const chat = this.store.getChat(m.chatId);
    if (!chat || chat.network === 'telegram') return;
    await new Promise((r) => setTimeout(r, 800));
    await this.react(m.id, '🤖').catch((e) => console.error('[bot-reaktion]', e?.message ?? e));
  }

  async react(messageId: string, emoji: string | null) {
    const msg = this.store.getMessage(messageId);
    if (!msg) throw new Error('Nachricht nicht gefunden');
    const chat = this.chatOrThrow(msg.chatId);
    await this.adapterFor(chat).react(chat.remoteId, msg.remoteId, emoji);
    // Lokal sofort aktualisieren (Adapter meldet ggf. später die echte Liste)
    const others = msg.reactions.filter((r) => !r.fromMe);
    const reactions = emoji ? [...others, { emoji, senderId: 'me', fromMe: true }] : others;
    const m = this.store.patchMessage(messageId, { reactions });
    if (m) this.emit({ type: 'message', message: m });
  }

  async edit(messageId: string, text: string) {
    const msg = this.store.getMessage(messageId);
    if (!msg || !msg.fromMe) throw new Error('Nur eigene Nachrichten können bearbeitet werden');
    const chat = this.chatOrThrow(msg.chatId);
    await this.adapterFor(chat).edit(chat.remoteId, msg.remoteId, text);
    const m = this.store.patchMessage(messageId, { text, edited: true });
    if (m) this.emit({ type: 'message', message: m });
  }

  async delete(messageId: string, forEveryone: boolean) {
    const msg = this.store.getMessage(messageId);
    if (!msg) throw new Error('Nachricht nicht gefunden');
    const chat = this.chatOrThrow(msg.chatId);
    if (chat.network === 'notes') return this.purge([msg.id]); // Notizen: ganz weg statt „Nachricht gelöscht“
    if (!msg.remoteId.startsWith('local-') && !msg.deleted) await this.adapterFor(chat).delete(chat.remoteId, msg.remoteId, forEveryone);
    const m = this.store.patchMessage(messageId, { deleted: true, text: '', attachments: [] });
    if (m) this.emit({ type: 'message', message: m });
  }

  async markRead(chatId: string) {
    const chat = this.chatOrThrow(chatId);
    this.store.updateChat(chatId, { unread: 0 });
    this.emit({ type: 'chat', chat: this.store.getChat(chatId)! });
    const last = this.store.listMessages(chatId, undefined, 1)[0];
    if (last && !last.fromMe) await this.adapters.get(chat.accountId)?.markRead(chat.remoteId, last.remoteId).catch(() => {});
  }

  async fetchAttachment(chat: Chat, remoteId: string, index: number, att?: Attachment): Promise<Buffer> {
    return this.adapterFor(chat).fetchAttachment(chat.remoteId, remoteId, index, att);
  }

  /** Inhalt eines Anhangs: aus dem Tresor oder einmalig beim Messenger abholen und speichern */
  // ---------- Medien automatisch sichern ----------
  // Messenger halten Anhänge nur begrenzt bereit (Signal z. B. etwa 45 Tage). Damit Chorus als Archiv taugt,
  // werden neue Anhänge im Hintergrund heruntergeladen und verschlüsselt gespeichert.
  private mediaQueue: string[] = [];
  private mediaBusy = false;
  get autoSaveMedia(): boolean { return this.store.getSetting('media', { autoSave: true }).autoSave; }
  set autoSaveMedia(on: boolean) { this.store.setSetting('media', { autoSave: on }); }
  /** Vom Gegenüber gelöschte Nachrichten sichtbar behalten */
  get keepDeleted(): boolean { return this.store.getSetting('keepDeleted', true); }
  set keepDeleted(on: boolean) { this.store.setSetting('keepDeleted', on); }
  private queueMedia(messageId: string) {
    if (!this.autoSaveMedia) return;
    this.mediaQueue.push(messageId);
    if (!this.mediaBusy) this.drainMedia();
  }
  private async drainMedia() {
    this.mediaBusy = true;
    while (this.mediaQueue.length) {
      const id = this.mediaQueue.shift()!;
      const msg = this.store.getMessage(id);
      if (!msg) continue;
      for (let i = 0; i < msg.attachments.length; i++) {
        const a = msg.attachments[i];
        if (a.fileId || (a.size && a.size > MAX_AUTO_MEDIA)) continue;
        const data = await this.attachmentData(this.store.getMessage(id) ?? msg, i).catch(() => null);
        if (data) await this.prepareThumb(id, i, data).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    this.mediaBusy = false;
  }

  /** Vorschaubild (Foto, Video-Standbild) gleich nach dem Herunterladen erzeugen und speichern,
   *  damit es schon beim ersten Öffnen des Chats sofort da ist */
  private async prepareThumb(id: string, i: number, data: Buffer) {
    const a = this.store.getMessage(id)?.attachments[i];
    if (!a?.fileId || a.gif || this.store.readThumb(a.fileId)) return;
    const isVideo = a.kind === 'video' || /^video\//i.test(a.mime);
    const isImage = !isVideo && a.kind !== 'sticker' && /^image\/(jpe?g|png|webp|heic|heif|avif|bmp)/i.test(a.mime);
    if (!isVideo && !isImage) return;
    const t = await thumbnail(`pre:${a.fileId}`, isVideo ? 'video' : 'image', async () => data);
    if (t) this.store.storeThumb(a.fileId, t);
  }

  async attachmentData(msg: Message, index: number): Promise<Buffer> {
    const att = msg.attachments[index];
    if (!att) throw new Error('Anhang nicht gefunden');
    const cached = att.fileId ? this.store.readFile(att.fileId) : null;
    if (cached) {
      // Ältere Bilder ohne gespeicherte Größe: einmal nachtragen
      const sized = withSize(att, cached);
      if (sized !== att) {
        const cur = this.store.getMessage(msg.id) ?? msg;
        const m2 = this.store.patchMessage(msg.id, { attachments: cur.attachments.map((a, j) => (j === index ? { ...a, width: sized.width, height: sized.height } : a)) });
        if (m2) this.emit({ type: 'message', message: m2 });
      }
      return cached;
    }
    const data = await this.fetchAttachment(this.chatOrThrow(msg.chatId), msg.remoteId, index, att);
    const fileId = this.store.storeFile(data);
    const cur = this.store.getMessage(msg.id) ?? msg;
    const fixed = withSize(sniffKind(cur.attachments[index] ?? att, data), data);
    const m2 = this.store.patchMessage(msg.id, { attachments: cur.attachments.map((a, j) => (j === index ? { ...fixed, fileId, size: data.length } : a)) });
    if (m2 && (fixed.kind !== att.kind || fixed.width !== att.width)) this.emit({ type: 'message', message: m2 });
    return data;
  }

  // ---------- Kontaktprofile (Bild, Nummer, Status) ----------
  // Langsam im Hintergrund, damit kein Messenger wegen zu vieler Anfragen bremst.
  private contactQueue: string[] = [];
  private contactBusy = false;
  queueContact(chatId: string, front = false) {
    if (this.contactQueue.includes(chatId)) return;
    if (front) this.contactQueue.unshift(chatId); else this.contactQueue.push(chatId);
    if (!this.contactBusy) this.drainContacts();
  }
  /** Profile ohne Bild öfter neu versuchen (6 h), sonst wöchentlich auffrischen */
  private staleTimer = setInterval(() => this.queueStaleContacts(), 10 * 60_000);
  queueStaleContacts(accountId?: string, all = false) {
    const now = Date.now();
    for (const c of this.store.listChats()) {
      if (accountId && c.accountId !== accountId) continue;
      if (this.statuses.get(c.accountId)?.state !== 'connected') continue;
      const age = now - (c.info?.fetchedAt ?? 0);
      // Bild fehlt, ohne dass der Messenger „kein Bild“ gemeldet hat (Fehler, Zeitlimit): nach 20 Min. erneut
      if (all || age > 7 * 864e5 || (!c.avatar && !c.info?.noAvatar && age > 20 * 60_000)) this.queueContact(c.id);
    }
  }
  private async drainContacts() {
    this.contactBusy = true;
    while (this.contactQueue.length) {
      const id = this.contactQueue.shift()!;
      const person = id.startsWith('p\u0000') ? id.split('\u0000') : null;
      await (person ? this.refreshPerson(person[1], person[2]) : this.refreshContact(id)).catch(async (e) => {
        if (person) { this.store.setPerson(person[1], person[2], e?.code === 'gone' ? null : undefined); console.warn(`[profil] Absender: ${e?.message ?? e}`); return; }
        const c = this.store.getChat(id);
        if (e?.code === 'gone' && c) { // Chat existiert beim Messenger nicht mehr: erst in 7 Tagen wieder fragen
          this.store.setChatInfo(id, { ...(c.info ?? {}), fetchedAt: Date.now(), noAvatar: true });
          return;
        }
        console.warn(`[profil] ${c?.network ?? '?'} ${c?.kind ?? ''}: ${e?.message ?? e}`);
        const wait = Number(e?.seconds) || (/FLOOD|rate-overlimit|429/i.test(String(e?.message)) ? 60 : 0);
        if (wait) await new Promise((r) => setTimeout(r, Math.min(wait, 600) * 1000)); // Messenger bremst: Pause
      });
      await new Promise((r) => setTimeout(r, 1500));
    }
    this.contactBusy = false;
  }
  async refreshContact(chatId: string) {
    const chat = this.chatOrThrow(chatId);
    const a = this.adapters.get(chat.accountId);
    if (!a?.contactInfo || this.statuses.get(chat.accountId)?.state !== 'connected') throw new Error('Der Messenger ist gerade nicht verbunden');
    const { avatar, ...info } = await a.contactInfo(chat.remoteId, chat.kind);
    const merged = { ...(chat.info ?? {}), ...info, fetchedAt: Date.now(), noAvatar: avatar === null };
    if (avatar === undefined) this.store.setChatInfo(chatId, merged);
    else if (avatar === null) this.store.setChatInfo(chatId, merged, null);
    else {
      const same = chat.avatarFileId && this.store.readFile(chat.avatarFileId)?.equals(avatar);
      this.store.setChatInfo(chatId, merged, same ? chat.avatarFileId! : this.store.storeFile(avatar));
    }
    return this.emitChat(chatId)!;
  }
  /** Profilbilder der Absender einer Gruppe; fehlende werden langsam im Hintergrund nachgeholt */
  senderAvatars(chatId: string) {
    const chat = this.chatOrThrow(chatId);
    const { avatars, fetch } = this.store.senderAvatars(chatId);
    const live = this.statuses.get(chat.accountId)?.state === 'connected' && !!this.adapters.get(chat.accountId)?.contactInfo;
    if (live) for (const sid of fetch.slice(0, 50)) this.queueContact(`p\u0000${chat.accountId}\u0000${sid}`);
    return { avatars, pending: live && fetch.length > 0 };
  }
  private async refreshPerson(accountId: string, remoteId: string) {
    const a = this.adapters.get(accountId);
    if (!a?.contactInfo || this.statuses.get(accountId)?.state !== 'connected') throw new Error('Der Messenger ist gerade nicht verbunden');
    const { avatar } = await a.contactInfo(remoteId, 'direct');
    if (!avatar) return this.store.setPerson(accountId, remoteId, avatar);
    const old = this.store.getPerson(accountId, remoteId)?.fileId;
    const same = old && this.store.readFile(old)?.equals(avatar);
    this.store.setPerson(accountId, remoteId, same ? old! : this.store.storeFile(avatar));
  }
  async resync() {
    for (const [id, a] of this.adapters) if (this.statuses.get(id)?.state === 'connected') await a.resync?.().catch(() => {});
    this.queueStaleContacts();
  }

  // ---------- Notizen an mich ----------
  /** Lebensdauer neuer Notizen in Sekunden (0 = bleiben) */
  get notesTtl(): number { return Number(this.store.getSetting('notes', { ttl: 0 }).ttl) || 0; }
  set notesTtl(ttl: number) { this.store.setSetting('notes', { ttl: Math.max(0, Math.min(ttl, 365 * 86400)) }); }
  /** Den Notizen-Chat anlegen, falls es ihn noch nicht gibt (einmal je Profil, angeheftet) */
  async ensureNotes(title: string) {
    if (!this.factories.notes || this.store.listAccountRows().some((a) => a.network === 'notes')) return;
    const a = await this.addAccount('notes', title, { title });
    // Der Adapter legt den Chat beim Start an; danach anheften, damit man ihn findet
    const id = `${a.id}:self`;
    for (let i = 0; i < 20 && !this.store.getChat(id); i++) await new Promise((r) => setTimeout(r, 50));
    if (this.store.getChat(id)) { this.store.setPinned(id, true); this.emitChat(id); }
  }
  /** Nachrichten endgültig löschen und die Chat-Vorschau nachziehen */
  purge(ids: string[]) {
    const chats = new Set<string>();
    for (const id of ids) {
      const m = this.store.getMessage(id);
      if (!m) continue;
      this.store.purgeMessage(id);
      chats.add(m.chatId);
      this.emit({ type: 'message_removed', id, chatId: m.chatId });
    }
    for (const cid of chats) {
      const c = this.store.getChat(cid);
      if (!c) continue;
      const last = this.store.listMessages(cid, undefined, 1)[0];
      this.store.resetPreview(cid, last ? previewText(last) : '', last?.ts ?? c.lastTs);
      this.emitChat(cid);
    }
  }
  private expiryTimer = setInterval(() => {
    try { const ids = this.store.expiredMessages(Date.now()).map((x) => x.id); if (ids.length) this.purge(ids); } catch { /* DB geschlossen */ }
  }, 20_000);

  // ---------- Massen-Nachricht ----------
  // Jede Nachricht geht einzeln über den Messenger des Kontakts. Damit WhatsApp & Co. das nicht für Spam halten:
  // höchstens 50 Empfänger, immer nur ein Durchlauf, zufällige Pausen zwischen den Sendungen.
  private job: BroadcastJob | null = null;
  get broadcastJob() { return this.job; }
  startBroadcast(chatIds: string[], text: string): BroadcastJob {
    if (this.job?.running) throw Object.assign(new Error('Es läuft schon eine Massen-Nachricht'), { statusCode: 409 });
    const ids = [...new Set(chatIds)].filter((id) => this.store.getChat(id)).slice(0, 50);
    if (!ids.length) throw Object.assign(new Error('Keine Empfänger'), { statusCode: 400 });
    if (!text.trim()) throw Object.assign(new Error('Leere Nachricht'), { statusCode: 400 });
    const job: BroadcastJob = { id: randomUUID().slice(0, 8), total: ids.length, done: 0, failed: 0, running: true, current: null };
    this.job = job;
    void (async () => {
      for (let i = 0; i < ids.length; i++) {
        const chat = this.store.getChat(ids[i]);
        if (!chat) { job.failed++; continue; }
        job.current = chat.title; this.emit({ type: 'broadcast', job: { ...job } });
        const first = (chat.peer?.name || chat.title).trim().split(/\s+/)[0] || '';
        try { await this.sendText(chat.id, text.replace(/\{name\}/gi, chat.kind === 'direct' ? first : '').replace(/[ \t]+([,.!?])/g, '$1').trim()); job.done++; }
        catch (e: any) { job.failed++; console.warn(`[massen-nachricht] ${chat.network}: ${e?.message ?? e}`); }
        this.emit({ type: 'broadcast', job: { ...job } });
        if (i < ids.length - 1) {
          const next = this.store.getChat(ids[i + 1])?.network;
          const [min, max] = next === 'whatsapp' ? [4000, 9000] : next === 'signal' ? [2000, 4500] : [1200, 2500];
          await new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
        }
      }
      job.running = false; job.current = null;
      this.emit({ type: 'broadcast', job: { ...job } });
    })();
    return { ...job };
  }

  setTranscript(messageId: string, transcript: string) {
    const m = this.store.patchMessage(messageId, { transcript });
    if (m) this.emit({ type: 'message', message: m });
    return m;
  }

  /** E-Mail: auf dem Server archivieren (bzw. zurückholen), dann in Chorus */
  async archiveChat(chatId: string, archived: boolean) {
    const chat = this.chatOrThrow(chatId);
    const a = this.adapters.get(chat.accountId);
    if (a?.archiveChat) await a.archiveChat(chat.remoteId, archived);
  }
  /** E-Mail: Mails in den Papierkorb; andere Messenger: Chat nur aus Chorus entfernen (kommt bei neuer Nachricht wieder) */
  async deleteChat(chatId: string) {
    const chat = this.chatOrThrow(chatId);
    const a = this.adapters.get(chat.accountId);
    if (a?.deleteChat) await a.deleteChat(chat.remoteId);
    else if (chat.network === 'email') throw new Error('E-Mail ist nicht verbunden');
    this.store.deleteChat(chatId);
    this.emit({ type: 'chat_removed', id: chatId });
  }
  emitChat(chatId: string) {
    const c = this.store.getChat(chatId);
    if (c) this.emit({ type: 'chat', chat: c });
    return c;
  }

  setChatAi(chatId: string, on: boolean) {
    this.store.updateChat(chatId, { aiEnabled: on });
    const before = this.store.getChat(chatId);
    if (!on && before?.autopilot?.on) this.store.setAutopilot(chatId, { ...before.autopilot, on: false });
    // Freigabe zurückgenommen: auch die Live-Übersetzung aus, sonst stünde sie weiter als „an“ da
    if (!on && before?.translate?.on) this.store.setTranslate(chatId, { ...before.translate, on: false });
    const c = this.store.getChat(chatId);
    if (c) this.emit({ type: 'chat', chat: c });
    return c;
  }

  /** Neuen Chat per Telefonnummer anlegen (Signal, WhatsApp) */
  async startChat(accountId: string, phoneRaw: string): Promise<Chat> {
    let phone = phoneRaw.replace(/[\s\-\/()]/g, '');
    if (phone.startsWith('00')) phone = '+' + phone.slice(2);
    else if (phone.startsWith('0')) phone = '+49' + phone.slice(1);
    if (!/^\+\d{7,15}$/.test(phone)) throw Object.assign(new Error('Bitte die Nummer mit Ländervorwahl eingeben, z. B. +49 170 1234567.'), { statusCode: 400 });
    const a = this.adapters.get(accountId);
    if (!a) throw new Error('Konto ist nicht verbunden');
    if (!a.resolvePhone) throw Object.assign(new Error('Bei diesem Messenger geht das nicht über die Nummer. Suche den Kontakt in der Liste.'), { statusCode: 400 });
    const { remoteId, title } = await a.resolvePhone(phone);
    const row = this.store.getAccountRow(accountId)!;
    const existing = this.store.getChat(`${accountId}:${remoteId}`);
    const chat = existing ?? this.store.upsertChat({ accountId, network: row.network, remoteId, title, kind: 'direct', lastTs: 0, lastText: '' });
    this.emit({ type: 'chat', chat });
    return chat;
  }

  async loadHistory(chatId: string) {
    const chat = this.chatOrThrow(chatId);
    const oldest = this.store.oldestMessage(chatId);
    await this.adapters.get(chat.accountId)?.loadHistory(chat.remoteId, oldest?.remoteId ?? null, 50);
  }
}

/** Sprache der Oberfläche des Profils (gemerkt aus den Anfragen der App) */
export function uiLang(store: { getSetting<T>(k: string, f: T): T }): 'en' | 'de' {
  return store.getSetting<{ lang?: string }>('ai', {}).lang === 'de' ? 'de' : 'en';
}
const PREVIEW_EN: Record<string, string> = {
  'Nachricht gelöscht': 'Message deleted', '📷 Foto': '📷 Photo', '🎤 Sprachnachricht': '🎤 Voice message', 'Neue Nachricht': 'New message', 'Erinnerung': 'Reminder',
};
/** Kurztexte des Servers für Benachrichtigungen in die Sprache des Profils bringen */
export function localize(text: string, lang: 'en' | 'de'): string { return lang === 'en' ? PREVIEW_EN[text] ?? text : text; }

const ATT_ICON = { image: '📷', video: '🎬', audio: '🎵', voice: '🎤', file: '📎', sticker: '' } as const;

export function previewText(m: Message): string {
  if (m.deleted) return 'Nachricht gelöscht';
  const a = m.attachments[0];
  // Text mit Anhang (z. B. Video mit Bildunterschrift): Symbol davor, damit man den Anhang in Liste und Push sieht
  if (m.text) return (a && a.kind !== 'sticker' ? ATT_ICON[a.kind] + ' ' : '') + m.text.slice(0, 200);
  if (!a) return '';
  if (a.gif || /^image\/gif/i.test(a.mime)) return 'GIF';
  return { image: '📷 Foto', video: '🎬 Video', audio: '🎵 Audio', voice: '🎤 Sprachnachricht', file: '📎 ' + a.name, sticker: 'Sticker' }[a.kind];
}
