import makeWASocket, {
  Browsers, BufferJSON, DisconnectReason, initAuthCreds, makeCacheableSignalKeyStore, downloadMediaMessage, normalizeMessageContent,
  jidNormalizedUser, isJidGroup, proto, type AuthenticationState, type SignalDataTypeMap, type WAMessage, type WAMessageKey, type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import type { Adapter, AdapterEvents, Attachment, OutgoingFile, Message } from '../types.js';
import type { AdapterFactory } from '../hub.js';
import { waveform } from '../audio.js';

const logger = pino({ level: process.env.WA_LOG_LEVEL ?? 'silent' });

/**
 * WhatsApp über Baileys (inoffiziell, wie WhatsApp Web als „verknüpftes Gerät“).
 * Achtung: verstößt gegen die WhatsApp-Nutzungsbedingungen; Sperren sind möglich.
 *
 * Chat-ID: JID (z. B. 4917012345@s.whatsapp.net oder …@g.us). Nachrichten-ID: WhatsApp-Key-ID.
 */
export class WhatsAppAdapter implements Adapter {
  readonly network = 'whatsapp' as const;
  private sock: WASocket | null = null;
  private auth: { creds: AuthenticationState['creds']; keys: Record<string, Record<string, unknown>> };
  private saveTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private names = new Map<string, string>();
  private keys = new Map<string, WAMessageKey>(); // id → key (für Reaktionen/Antworten)
  private waiting: ((v: string) => void) | null = null;
  private retry = 0;
  private phone: string | null = null; // für die Kopplung per Code

  constructor(private config: { loginMethod?: 'qr' | 'phone' }, session: string | null, private ev: AdapterEvents) {
    this.auth = session ? JSON.parse(session, BufferJSON.reviver) : { creds: initAuthCreds(), keys: {} };
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.ev.saveSession(JSON.stringify(this.auth, BufferJSON.replacer));
    }, 1500);
  }

  private authState(): AuthenticationState {
    const store = this.auth.keys;
    return {
      creds: this.auth.creds,
      keys: makeCacheableSignalKeyStore({
        get: async (type, ids) => {
          const out: Record<string, any> = {};
          for (const id of ids) {
            let v = store[type]?.[id];
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v as any);
            out[id] = v;
          }
          return out as any;
        },
        set: async (data) => {
          for (const type in data) {
            store[type] ??= {};
            for (const id in (data as any)[type]) {
              const v = (data as any)[type][id];
              if (v) store[type][id] = v; else delete store[type][id];
            }
          }
          this.scheduleSave();
        },
      }, logger),
    };
  }

  async input(field: string, value: string) {
    if (field !== 'phone' || !this.waiting) throw new Error('Gerade wird keine Eingabe erwartet');
    const w = this.waiting; this.waiting = null;
    w(value);
  }

  async start() {
    this.stopped = false;
    this.ev.status({ state: 'connecting' });
    const sock = makeWASocket({
      auth: this.authState(),
      logger,
      // Für die Kopplung per Code verlangt WhatsApp einen echten Plattformnamen, sonst „Gerät konnte nicht verknüpft werden“
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async (key) => {
        const m = key.remoteJid && key.id ? this.ev.getMessage(this.chatId(key), key.id) : null;
        return m ? { conversation: m.text } : undefined;
      },
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => this.scheduleSave());
    sock.ev.on('connection.update', async (u) => {
      if (u.qr && !this.auth.creds.registered) {
        if (this.config.loginMethod === 'phone') {
          // Die Nummer nur einmal abfragen. Den Code aber immer über die aktuelle Verbindung anfordern:
          // WhatsApp baut sie nach etwa einer Minute neu auf, ein alter Code gilt dann nicht mehr.
          if (!this.phone) {
            if (this.waiting) return;
            this.ev.status({ state: 'need_input', field: 'phone', message: 'Deine WhatsApp-Telefonnummer mit Ländervorwahl' });
            this.phone = (await new Promise<string>((r) => (this.waiting = r))).replace(/[^0-9]/g, '').replace(/^00/, '').replace(/^0(?=[1-9])/, '49') || null;
            if (!this.phone) return;
          }
          if (this.sock !== sock || (sock as any).__pairing) return;
          (sock as any).__pairing = true;
          try {
            const code = await sock.requestPairingCode(this.phone!);
            if (this.sock !== sock) return;
            this.ev.status({ state: 'qr', code: code.match(/.{1,4}/g)?.join('-') ?? code, message: 'In WhatsApp: Einstellungen → Verknüpfte Geräte → Gerät hinzufügen → „Stattdessen mit Telefonnummer verknüpfen“. Der Code gilt etwa eine Minute, danach erscheint hier ein neuer.' });
          } catch (e: any) {
            if (this.sock === sock) this.ev.status({ state: 'error', message: 'Kopplungscode fehlgeschlagen: ' + e.message });
          }
        } else {
          this.ev.status({ state: 'qr', qr: u.qr, message: 'In WhatsApp: Einstellungen → Verknüpfte Geräte → Gerät hinzufügen' });
        }
      }
      if (u.connection === 'open') {
        this.retry = 0;
        const own = sock.user?.id?.split(':')[0]?.split('@')[0];
        this.ev.status({ state: 'connected', self: own ? `+${own}` : undefined });
        this.scheduleSave();
        this.loadGroups().catch(() => {});
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
        this.sock = null;
        if (this.stopped) return;
        if (code === DisconnectReason.loggedOut) {
          this.auth = { creds: initAuthCreds(), keys: {} };
          this.ev.saveSession(JSON.stringify(this.auth, BufferJSON.replacer));
          this.ev.status({ state: 'error', message: 'Chorus wurde in WhatsApp abgemeldet. Bitte neu koppeln.' });
          return;
        }
        if (code === DisconnectReason.forbidden) {
          this.ev.status({ state: 'error', message: 'WhatsApp hat die Verbindung verweigert (Konto eventuell gesperrt).' });
          return;
        }
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 2000 * 2 ** this.retry++);
        this.ev.status({ state: 'connecting', message: 'Verbindung wird wiederhergestellt …' });
        setTimeout(() => { if (!this.stopped) this.start().catch((e) => this.ev.log('restart ' + e)); }, delay);
      }
    });

    sock.ev.on('contacts.upsert', (cs) => { for (const c of cs) this.setName(c.id, c.name || c.notify || c.verifiedName); });
    sock.ev.on('contacts.update', (cs) => { for (const c of cs) if (c.id) this.setName(c.id, c.name || c.notify || c.verifiedName); });
    sock.ev.on('chats.upsert', (chats) => { for (const c of chats) this.upsertChat(c.id ?? "", c.name ?? undefined, Number(c.conversationTimestamp ?? 0) * 1000, c.unreadCount ?? undefined); });
    sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
      for (const c of contacts) this.setName(c.id, c.name || c.notify || c.verifiedName);
      for (const c of chats) this.upsertChat(c.id ?? "", c.name ?? undefined, Number(c.conversationTimestamp ?? 0) * 1000, c.unreadCount ?? undefined);
      for (const m of messages) this.onMessage(m, true);
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => { for (const m of messages) this.onMessage(m, type !== 'notify'); });
    sock.ev.on('messages.update', (ups) => {
      for (const { key, update } of ups) {
        if (!key.id || !key.remoteJid) continue;
        const chat = this.chatId(key);
        if (update.status != null && key.fromMe) {
          const st = update.status >= 4 ? 'read' : update.status === 3 ? 'delivered' : 'sent';
          // Bestätigungen kommen oft mit der LID statt der Telefonnummer als Chat: dann über die Nachrichten-ID suchen
          this.ev.messageUpdate(chat.endsWith('@lid') ? '*' : chat, key.id, { status: st });
        }
        if (update.message) this.onMessage({ key, ...update } as WAMessage, true);
      }
    });
    // Gruppen: Zustell- und Lesebestätigungen kommen je Teilnehmer
    sock.ev.on('message-receipt.update', (rs) => {
      for (const { key, receipt } of rs) {
        if (!key.id || !key.fromMe) continue;
        const st = receipt.readTimestamp || receipt.playedTimestamp ? 'read' : receipt.receiptTimestamp ? 'delivered' : null;
        if (st) this.ev.messageUpdate('*', key.id, { status: st });
      }
    });
    sock.ev.on('messages.reaction', (rs) => {
      for (const { key, reaction } of rs) {
        if (!key.id || !key.remoteJid) continue;
        const sender = reaction.key?.fromMe ? 'me' : jidNormalizedUser(reaction.key?.participant || reaction.key?.remoteJid || '');
        this.ev.reactionChange(this.chatId(key), key.id, { emoji: reaction.text || '', senderId: sender, senderName: this.names.get(sender), fromMe: !!reaction.key?.fromMe }, !reaction.text);
      }
    });
  }

  private setName(jid: string | undefined, name: string | null | undefined) {
    if (!jid || !name) return;
    const id = jidNormalizedUser(jid);
    if (this.names.get(id) === name) return;
    this.names.set(id, name);
    if (!isJidGroup(id)) this.ev.chat({ remoteId: id, title: name, kind: 'direct', lastTs: 0, lastText: '' });
  }

  private upsertChat(jid: string, name: string | undefined, lastTs: number, unread?: number) {
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
    const id = jidNormalizedUser(jid);
    this.ev.chat({
      remoteId: id, title: name || this.names.get(id) || '+' + id.split('@')[0],
      kind: isJidGroup(id) ? 'group' : 'direct', lastTs, lastText: '', unread,
    });
  }

  private async loadGroups() {
    const groups = await this.sock!.groupFetchAllParticipating();
    for (const g of Object.values(groups)) this.upsertChat(g.id, g.subject, 0);
  }

  /** Bevorzugt die Telefonnummer-JID, damit ein Kontakt nicht doppelt auftaucht */
  private chatId(key: WAMessageKey): string {
    const j = key.remoteJid!;
    if (j.endsWith('@lid') && key.remoteJidAlt?.endsWith('@s.whatsapp.net')) return jidNormalizedUser(key.remoteJidAlt);
    return jidNormalizedUser(j);
  }

  private onMessage(m: WAMessage, historic: boolean) {
    const key = m.key;
    if (!key?.id || !key.remoteJid || key.remoteJid === 'status@broadcast' || key.remoteJid.endsWith('@newsletter')) return;
    const chat = this.chatId(key);
    const content = normalizeMessageContent(m.message);
    if (!content) return;
    this.keys.set(key.id, key);

    // Löschen / Bearbeiten
    const proto_ = content.protocolMessage;
    if (proto_) {
      const target = proto_.key?.id;
      if (target && proto_.type === proto.Message.ProtocolMessage.Type.REVOKE) this.ev.messageUpdate(chat, target, { deleted: true, text: '' });
      if (target && proto_.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
        const e = normalizeMessageContent(proto_.editedMessage);
        this.ev.messageUpdate(chat, target, { text: e?.conversation ?? e?.extendedTextMessage?.text ?? '', edited: true });
      }
      return;
    }
    if (content.reactionMessage) {
      const r = content.reactionMessage;
      const sender = key.fromMe ? 'me' : jidNormalizedUser(key.participant || key.remoteJid);
      if (r.key?.id) this.ev.reactionChange(chat, r.key.id, { emoji: r.text || '', senderId: sender, senderName: this.names.get(sender), fromMe: !!key.fromMe }, !r.text);
      return;
    }

    const senderJid = key.fromMe ? 'me' : jidNormalizedUser(key.participantAlt?.endsWith('@s.whatsapp.net') ? key.participantAlt : (key.participant || key.remoteJid));
    if (!key.fromMe && m.pushName) this.setName(senderJid, this.names.get(senderJid) ?? m.pushName);
    const senderName = key.fromMe ? 'Ich' : this.names.get(senderJid) ?? m.pushName ?? '+' + senderJid.split('@')[0];

    let text = content.conversation ?? content.extendedTextMessage?.text ?? '';
    const atts: Attachment[] = [];
    const ref = () => JSON.stringify({ key, message: m.message }, BufferJSON.replacer);
    if (content.imageMessage) { const i = content.imageMessage; text = i.caption ?? ''; atts.push({ fileId: null, remoteRef: ref(), name: `foto-${key.id}.jpg`, mime: i.mimetype ?? 'image/jpeg', size: Number(i.fileLength ?? 0), kind: 'image', width: i.width ?? undefined, height: i.height ?? undefined }); }
    if (content.videoMessage) { const v = content.videoMessage; text = v.caption ?? ''; atts.push({ fileId: null, remoteRef: ref(), name: `video-${key.id}.mp4`, mime: v.mimetype ?? 'video/mp4', size: Number(v.fileLength ?? 0), kind: 'video', durationSec: v.seconds ?? undefined }); }
    if (content.audioMessage) { const a = content.audioMessage; atts.push({ fileId: null, remoteRef: ref(), name: a.ptt ? 'sprachnachricht.ogg' : `audio-${key.id}`, mime: a.mimetype ?? 'audio/ogg', size: Number(a.fileLength ?? 0), kind: a.ptt ? 'voice' : 'audio', durationSec: a.seconds ?? undefined }); }
    if (content.documentMessage) { const d = content.documentMessage; text = d.caption ?? ''; atts.push({ fileId: null, remoteRef: ref(), name: d.fileName ?? 'datei', mime: d.mimetype ?? 'application/octet-stream', size: Number(d.fileLength ?? 0), kind: 'file' }); }
    if (content.stickerMessage) { const s = content.stickerMessage; atts.push({ fileId: null, remoteRef: ref(), name: 'sticker.webp', mime: s.mimetype ?? 'image/webp', size: Number(s.fileLength ?? 0), kind: 'sticker' }); }
    if (!text && !atts.length) {
      if (content.locationMessage) text = `📍 Standort: https://maps.google.com/?q=${content.locationMessage.degreesLatitude},${content.locationMessage.degreesLongitude}`;
      else if (content.contactMessage) text = `👤 Kontakt: ${content.contactMessage.displayName ?? ''}`;
      else if (content.pollCreationMessage || content.pollCreationMessageV3) text = `📊 Umfrage: ${(content.pollCreationMessage ?? content.pollCreationMessageV3)?.name ?? ''}`;
      else return;
    }
    const ctx = content.extendedTextMessage?.contextInfo ?? content.imageMessage?.contextInfo ?? content.videoMessage?.contextInfo
      ?? content.audioMessage?.contextInfo ?? content.documentMessage?.contextInfo ?? content.stickerMessage?.contextInfo;
    const ts = Number(m.messageTimestamp ?? Date.now() / 1000) * 1000;
    if (!isJidGroup(chat) && !this.names.has(chat) && !key.fromMe && m.pushName) this.setName(chat, m.pushName);
    this.ev.message({
      chatRemoteId: chat, remoteId: key.id, senderId: senderJid, senderName, fromMe: !!key.fromMe, ts, text,
      replyToRemoteId: ctx?.stanzaId ?? null, edited: false, deleted: false, attachments: atts,
      status: key.fromMe ? (m.status != null && m.status >= 4 ? 'read' : m.status === 3 ? 'delivered' : 'sent') : 'received',
    });
    void historic;
  }

  // ---------- Senden ----------
  async resolvePhone(phone: string) {
    const res = await this.s.onWhatsApp(phone.replace(/\D/g, ''));
    const hit = res?.[0];
    if (!hit?.exists) throw new Error('Diese Nummer ist nicht bei WhatsApp registriert.');
    return { remoteId: hit.jid, title: phone };
  }

  private get s() { if (!this.sock) throw new Error('WhatsApp ist nicht verbunden'); return this.sock; }

  /** Rekonstruiert den WhatsApp-Key einer Nachricht (für Antworten, Reaktionen, Löschen) */
  private keyFor(chat: string, id: string): WAMessageKey {
    const k = this.keys.get(id);
    if (k) return k;
    const m: Message | null = this.ev.getMessage(chat, id);
    return { remoteJid: chat, id, fromMe: m?.fromMe ?? false, participant: isJidGroup(chat) && m && !m.fromMe ? m.senderId : undefined };
  }
  private quoted(chat: string, replyTo?: string | null): WAMessage | undefined {
    if (!replyTo) return undefined;
    const m = this.ev.getMessage(chat, replyTo);
    return { key: this.keyFor(chat, replyTo), message: { conversation: m?.text ?? '' } } as WAMessage;
  }

  async sendText(chat: string, text: string, replyTo?: string | null) {
    const r = await this.s.sendMessage(chat, { text }, { quoted: this.quoted(chat, replyTo) });
    if (r?.key) this.keys.set(r.key.id!, r.key);
    return r!.key.id!;
  }

  async sendFile(chat: string, f: OutgoingFile, caption?: string, replyTo?: string | null) {
    const quoted = this.quoted(chat, replyTo);
    const wave = f.voice ? await waveform(f.data).catch(() => undefined) : undefined;
    const content = f.voice
      ? { audio: f.data, ptt: true, mimetype: 'audio/ogg; codecs=opus', seconds: Math.max(1, Math.round(f.durationSec ?? 1)), waveform: wave }
      : f.mime.startsWith('image/') && !f.mime.includes('svg') ? { image: f.data, caption, mimetype: f.mime }
      : f.mime.startsWith('video/') ? { video: f.data, caption, mimetype: f.mime }
      : f.mime.startsWith('audio/') ? { audio: f.data, mimetype: f.mime }
      : { document: f.data, fileName: f.name, mimetype: f.mime, caption };
    const r = await this.s.sendMessage(chat, content as any, { quoted });
    if (f.voice) {
      const a = r?.message?.audioMessage;
      console.log(`[whatsapp] Sprachnachricht: ${f.data.length} Bytes, ${Math.round(f.durationSec ?? 0)} s, Upload ${a?.directPath ? 'ok' : 'ohne directPath'}, ${a?.fileLength ?? '?'} Bytes verschlüsselt`);
    }
    if (r?.key) this.keys.set(r.key.id!, r.key);
    return r!.key.id!;
  }

  async react(chat: string, id: string, emoji: string | null) {
    await this.s.sendMessage(chat, { react: { text: emoji ?? '', key: this.keyFor(chat, id) } });
  }

  async edit(chat: string, id: string, text: string) {
    await this.s.sendMessage(chat, { text, edit: this.keyFor(chat, id) });
  }

  async delete(chat: string, id: string, forEveryone: boolean) {
    if (forEveryone) await this.s.sendMessage(chat, { delete: this.keyFor(chat, id) });
  }

  async markRead(chat: string, id: string) {
    await this.s.readMessages([this.keyFor(chat, id)]);
  }

  async loadHistory() { /* WhatsApp liefert den Verlauf beim Koppeln automatisch */ }

  async fetchAttachment(_chat: string, _id: string, _i: number, att?: Attachment) {
    if (!att?.remoteRef) throw new Error('Anhang nicht verfügbar');
    const msg = JSON.parse(att.remoteRef, BufferJSON.reviver) as WAMessage;
    const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: this.s.updateMediaMessage });
    return buf as Buffer;
  }

  async contactInfo(jid: string) {
    const s = this.s;
    const out: { phone?: string; about?: string; description?: string; members?: number; avatar?: Buffer | null } = {};
    if (isJidGroup(jid)) {
      const md = await s.groupMetadata(jid).catch(() => null);
      if (md) { if (md.desc) out.description = md.desc; out.members = md.participants?.length; }
    } else {
      if (jid.endsWith('@s.whatsapp.net')) out.phone = '+' + jid.split('@')[0];
      const st: any = await s.fetchStatus(jid).catch(() => null);
      const v = Array.isArray(st) ? st[0]?.status : st;
      const txt = typeof v === 'string' ? v : v?.status;
      if (typeof txt === 'string' && txt.trim()) out.about = txt.trim();
    }
    try {
      const url = await s.profilePictureUrl(jid, 'image', 15_000);
      if (url) { const r = await fetch(url); if (r.ok) out.avatar = Buffer.from(await r.arrayBuffer()); }
      else out.avatar = null;
    } catch (e: any) {
      if (/not-found|404|item-not-found|401|not-authorized/i.test(String(e?.message ?? e) + String(e?.data ?? ''))) out.avatar = null; // kein (sichtbares) Bild
      else this.ev.log('Profilbild: ' + (e?.message ?? e));
    }
    return out;
  }

  async resync() { await this.loadGroups().catch(() => {}); }

  async logout() { await this.sock?.logout().catch(() => {}); }

  async stop() {
    this.stopped = true;
    if (this.waiting) { this.waiting(''); this.waiting = null; }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; this.ev.saveSession(JSON.stringify(this.auth, BufferJSON.replacer)); }
    this.sock?.end(undefined);
    this.sock = null;
  }
}

export const whatsappFactory: AdapterFactory = ({ config, session, events }) => new WhatsAppAdapter(config as any, session, events);
