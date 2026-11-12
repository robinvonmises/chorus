import { TelegramClient, Api, utils } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { EditedMessage, type EditedMessageEvent } from 'telegram/events/EditedMessage.js';
import { CustomFile } from 'telegram/client/uploads.js';
import bigInt from 'big-integer';
import type { Adapter, AdapterEvents, Attachment, OutgoingFile, Reaction } from '../types.js';
import type { AdapterFactory } from '../hub.js';

/**
 * Telegram über die offizielle Client-API (MTProto, GramJS).
 * Anmeldung per QR-Code (Telegram-App → Einstellungen → Geräte → Desktop-Gerät verbinden)
 * oder per Telefonnummer + Code.
 */
export class TelegramAdapter implements Adapter {
  readonly network = 'telegram' as const;
  private client: TelegramClient | null = null;
  private waiting = new Map<string, (v: string) => void>();
  private peers = new Map<string, Api.TypeInputPeer>();
  private stopped = false;

  constructor(
    private config: { apiId: number; apiHash: string; loginMethod?: 'qr' | 'phone' },
    private session: string | null,
    private ev: AdapterEvents,
  ) {}

  private prompt(field: 'phone' | 'code' | 'password', message?: string): Promise<string> {
    this.ev.status({ state: 'need_input', field, message });
    return new Promise((res) => this.waiting.set(field, res));
  }

  async input(field: string, value: string) {
    const r = this.waiting.get(field);
    if (!r) throw new Error('Gerade wird keine Eingabe erwartet');
    this.waiting.delete(field);
    this.ev.status({ state: 'connecting' });
    r(value.trim());
  }

  async start() {
    if (!this.config.apiId || !this.config.apiHash) {
      this.ev.status({ state: 'error', message: 'api_id und api_hash fehlen' });
      return;
    }
    this.stopped = false;
    this.ev.status({ state: 'connecting' });
    // Sitzung: früher nur der StringSession-Text, jetzt JSON mit gemerkten Peers (inkl. accessHash),
    // damit Gruppen/Kanäle auch nach einem Neustart sofort erreichbar sind
    let sess = this.session ?? '';
    if (sess.startsWith('{')) {
      try { const j = JSON.parse(sess); sess = j.s ?? ''; for (const [k, v] of Object.entries(j.peers ?? {})) { const p = inflatePeer(v as any); if (p) this.peers.set(k, p); } }
      catch { sess = ''; }
    }
    const client = new TelegramClient(new StringSession(sess), Number(this.config.apiId), this.config.apiHash, {
      connectionRetries: 10,
      deviceModel: 'Chorus Web',
      appVersion: '0.1',
      langCode: 'de',
      systemLangCode: 'de',
    });
    client.setLogLevel('warn' as any);
    this.client = client;
    await client.connect();

    if (!(await client.checkAuthorization())) {
      const creds = { apiId: Number(this.config.apiId), apiHash: this.config.apiHash };
      if (this.config.loginMethod === 'phone') {
        await client.start({
          phoneNumber: () => this.prompt('phone'),
          phoneCode: () => this.prompt('code', 'Code aus der Telegram-App eingeben'),
          password: (hint) => this.prompt('password', hint ? `Zwei-Schritt-Passwort (Hinweis: ${hint})` : 'Zwei-Schritt-Passwort'),
          onError: async (e) => {
            this.ev.log('Anmeldefehler: ' + e.message);
            this.ev.status({ state: 'need_input', field: 'phone', message: fehlertext(e.message) });
            return this.stopped;
          },
        });
      } else {
        await client.signInUserWithQrCode(creds, {
          qrCode: async ({ token }) => {
            this.ev.status({ state: 'qr', qr: 'tg://login?token=' + Buffer.from(token).toString('base64url'), message: 'In Telegram: Einstellungen → Geräte → Desktop-Gerät verbinden' });
          },
          password: (hint) => this.prompt('password', hint ? `Zwei-Schritt-Passwort (Hinweis: ${hint})` : 'Zwei-Schritt-Passwort'),
          onError: async (e) => {
            this.ev.log('QR-Anmeldefehler: ' + e.message);
            if (/PASSWORD_HASH_INVALID/.test(e.message)) return false;
            this.ev.status({ state: 'error', message: fehlertext(e.message) });
            return true;
          },
        });
      }
    }
    this.persist();
    const me = await client.getMe().catch(() => null) as Api.User | null;
    this.ev.status({ state: 'connected', self: me ? (me.phone ? `+${me.phone}` : me.username ? `@${me.username}` : undefined) : undefined });

    client.addEventHandler((e: NewMessageEvent) => { this.onMessage(e.message).catch((err) => this.ev.log('onMessage ' + err)); }, new NewMessage({}));
    client.addEventHandler((e: EditedMessageEvent) => { this.onMessage(e.message).catch(() => {}); }, new EditedMessage({}));
    client.addEventHandler((u: Api.TypeUpdate) => this.onRaw(u));
    await this.sync();
    this.persist();
  }

  private async sync() {
    const dialogs = await this.client!.getDialogs({ limit: 200 });
    for (const d of dialogs) {
      if (!d.entity || !d.id) continue;
      const remoteId = d.id.toString();
      try { this.rememberPeer(remoteId, utils.getInputPeer(d.entity)); } catch { /* ignore */ }
      this.ev.chat({
        remoteId,
        title: d.title || d.name || 'Unbekannt',
        kind: d.isUser ? 'direct' : d.isChannel && !d.isGroup ? 'channel' : 'group',
        lastTs: (d.date ?? 0) * 1000,
        lastText: d.message?.message ?? '',
        unread: d.unreadCount ?? 0,
      });
      if (d.message) await this.onMessage(d.message, remoteId);
    }
  }

  private persistTimer: NodeJS.Timeout | null = null;
  private persist() {
    if (!this.client) return;
    const peers: Record<string, unknown> = {};
    for (const [k, v] of this.peers) { const f = flattenPeer(v); if (f) peers[k] = f; }
    this.ev.saveSession(JSON.stringify({ s: (this.client.session as StringSession).save(), peers }));
  }
  private rememberPeer(remoteId: string, p: Api.TypeInputPeer) {
    this.peers.set(remoteId, p);
    if (!this.persistTimer) this.persistTimer = setTimeout(() => { this.persistTimer = null; this.persist(); }, 5000);
  }

  private allPeersAt = 0;
  private allPeers: Promise<void> | null = null;
  private loadAllPeers(): Promise<void> {
    if (this.allPeers) return this.allPeers;
    if (Date.now() - this.allPeersAt < 30 * 60_000) return Promise.resolve();
    this.allPeers = (async () => {
      try {
        for await (const d of this.client!.iterDialogs({})) if (d.entity && d.id) { try { this.rememberPeer(d.id.toString(), utils.getInputPeer(d.entity)); } catch { /* ignore */ } }
      } finally { this.allPeersAt = Date.now(); this.allPeers = null; }
    })();
    return this.allPeers;
  }

  private async peer(remoteId: string): Promise<Api.TypeInputPeer> {
    const p = this.peers.get(remoteId);
    if (p) return p;
    let ip: Api.TypeInputPeer;
    try { ip = await this.client!.getInputEntity(bigInt(remoteId)); }
    catch {
      // Unbekannt (z. B. alte Gruppe jenseits der ersten Dialoge): einmal ALLE Dialoge laden (höchstens alle 30 Min.)
      await this.loadAllPeers();
      const again = this.peers.get(remoteId);
      if (!again) throw Object.assign(new Error('Telegram kennt diesen Chat nicht mehr (verlassen oder gelöscht?)'), { code: 'gone' });
      return again;
    }
    this.rememberPeer(remoteId, ip);
    return ip;
  }

  private async onMessage(m: Api.Message, knownChatId?: string) {
    if (!(m instanceof Api.Message)) return; // Service-Nachrichten überspringen
    const chatRemoteId = knownChatId ?? utils.getPeerId(m.peerId).toString();
    if (!knownChatId && !this.peers.has(chatRemoteId)) {
      try {
        const ent = await m.getChat();
        if (ent) {
          this.rememberPeer(chatRemoteId, utils.getInputPeer(ent));
          const title = 'title' in ent ? ent.title : [(ent as Api.User).firstName, (ent as Api.User).lastName].filter(Boolean).join(' ');
          this.ev.chat({
            remoteId: chatRemoteId, title: title || 'Unbekannt',
            kind: ent instanceof Api.User ? 'direct' : ent instanceof Api.Channel && !ent.megagroup ? 'channel' : 'group',
            lastTs: m.date * 1000, lastText: m.message ?? '',
          });
        }
      } catch { /* ignore */ }
    }
    let senderName = '';
    try {
      const s = await m.getSender();
      if (s) senderName = 'title' in s ? s.title : [(s as Api.User).firstName, (s as Api.User).lastName].filter(Boolean).join(' ');
    } catch { /* ignore */ }
    this.ev.message({
      chatRemoteId,
      remoteId: String(m.id),
      senderId: m.senderId?.toString() ?? '',
      senderName,
      fromMe: !!m.out,
      ts: m.date * 1000,
      text: m.message ?? '',
      replyToRemoteId: m.replyTo?.replyToMsgId ? String(m.replyTo.replyToMsgId) : null,
      edited: !!m.editDate && !m.editHide,
      deleted: false,
      attachments: mediaToAttachments(m),
      reactions: mapReactions(m.reactions),
      status: m.out ? 'sent' : 'received',
    });
  }

  private onRaw(u: Api.TypeUpdate) {
    if (u instanceof Api.UpdateMessageReactions) {
      this.ev.reactions(utils.getPeerId(u.peer).toString(), String(u.msgId), mapReactions(u.reactions));
    } else if (u instanceof Api.UpdateDeleteChannelMessages) {
      const chat = utils.getPeerId(new Api.PeerChannel({ channelId: u.channelId })).toString();
      for (const id of u.messages) this.ev.messageUpdate(chat, String(id), { deleted: true, text: '' });
    } else if (u instanceof Api.UpdateDeleteMessages) {
      for (const id of u.messages) this.ev.messageUpdate('*', String(id), { deleted: true, text: '' });
    } else if (u instanceof Api.UpdateUserTyping || u instanceof Api.UpdateChatUserTyping || u instanceof Api.UpdateChannelUserTyping) {
      // Tippt gerade: Telegram wiederholt das alle paar Sekunden, Abbruch kommt als SendMessageCancelAction
      const peer = u instanceof Api.UpdateUserTyping ? new Api.PeerUser({ userId: u.userId })
        : u instanceof Api.UpdateChatUserTyping ? new Api.PeerChat({ chatId: u.chatId }) : new Api.PeerChannel({ channelId: u.channelId });
      this.ev.typing(utils.getPeerId(peer).toString(), !(u.action instanceof Api.SendMessageCancelAction));
    } else if (u instanceof Api.UpdateReadHistoryOutbox) {
      this.ev.messageUpdate(utils.getPeerId(u.peer).toString(), `<=${u.maxId}`, { status: 'read' });
    }
  }

  async stop() {
    this.stopped = true;
    for (const r of this.waiting.values()) r('');
    this.waiting.clear();
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; this.persist(); }
    await this.client?.destroy().catch(() => {});
    this.client = null;
  }

  private get c() {
    if (!this.client) throw new Error('Telegram ist nicht verbunden');
    return this.client;
  }

  async sendText(chat: string, text: string, replyTo?: string | null) {
    const r = await this.c.sendMessage(await this.peer(chat), { message: text, replyTo: replyTo ? Number(replyTo) : undefined });
    return String(r.id);
  }

  async sendFile(chat: string, f: OutgoingFile, caption?: string, replyTo?: string | null) {
    const r = await this.c.sendFile(await this.peer(chat), {
      file: new CustomFile(f.name, f.data.length, '', f.data),
      caption: caption ?? '',
      replyTo: replyTo ? Number(replyTo) : undefined,
      voiceNote: !!f.voice,
      forceDocument: !f.voice && !/^(image|video)\//.test(f.mime),
      attributes: f.voice ? [new Api.DocumentAttributeAudio({ voice: true, duration: Math.round(f.durationSec ?? 0) })] : undefined,
    });
    return String(r.id);
  }

  async react(chat: string, id: string, emoji: string | null) {
    await this.c.invoke(new Api.messages.SendReaction({
      peer: await this.peer(chat), msgId: Number(id),
      reaction: emoji ? [new Api.ReactionEmoji({ emoticon: emoji })] : [],
    }));
  }

  async edit(chat: string, id: string, text: string) {
    await this.c.editMessage(await this.peer(chat), { message: Number(id), text });
  }

  async delete(chat: string, id: string, forEveryone: boolean) {
    await this.c.deleteMessages(await this.peer(chat), [Number(id)], { revoke: forEveryone });
  }

  async markRead(chat: string) {
    await this.c.markAsRead(await this.peer(chat));
  }

  async loadHistory(chat: string, before?: string | null, limit = 50) {
    const msgs = await this.c.getMessages(await this.peer(chat), { limit, offsetId: before && /^\d+$/.test(before) ? Number(before) : 0 });
    for (const m of msgs) await this.onMessage(m, chat);
  }

  async fetchAttachment(chat: string, id: string) {
    const [m] = await this.c.getMessages(await this.peer(chat), { ids: Number(id) });
    if (!m) throw new Error('Nachricht nicht gefunden');
    const buf = await this.c.downloadMedia(m, {});
    if (!buf || typeof buf === 'string') throw new Error('Anhang nicht verfügbar');
    return buf;
  }

  async contactInfo(remoteId: string) {
    const c = this.c;
    const ent: any = await c.getEntity(await this.peer(remoteId)).catch(() => null);
    const out: { phone?: string; username?: string; about?: string; description?: string; members?: number; avatar?: Buffer | null } = {};
    if (!ent) return out;
    if (ent.username) out.username = '@' + ent.username;
    if (ent instanceof Api.User) {
      if (ent.phone) out.phone = '+' + ent.phone;
      const full: any = await c.invoke(new Api.users.GetFullUser({ id: ent })).catch(() => null);
      if (full?.fullUser?.about) out.about = full.fullUser.about;
    } else if (ent instanceof Api.Channel) {
      const full: any = await c.invoke(new Api.channels.GetFullChannel({ channel: ent })).catch(() => null);
      if (full?.fullChat?.about) out.description = full.fullChat.about;
      if (full?.fullChat?.participantsCount) out.members = full.fullChat.participantsCount;
    } else if (ent instanceof Api.Chat) {
      const full: any = await c.invoke(new Api.messages.GetFullChat({ chatId: ent.id })).catch(() => null);
      if (full?.fullChat?.about) out.description = full.fullChat.about;
      if (ent.participantsCount) out.members = ent.participantsCount;
    }
    const empty = !ent.photo || ent.photo instanceof Api.ChatPhotoEmpty || ent.photo instanceof Api.UserProfilePhotoEmpty;
    if (empty) out.avatar = null;
    else {
      const b = await c.downloadProfilePhoto(ent, { isBig: true }).catch(() => undefined);
      if (Buffer.isBuffer(b) && b.length) out.avatar = b;
    }
    return out;
  }

  async resync() { await this.sync(); this.persist(); }

  async logout() {
    await this.c.invoke(new Api.auth.LogOut()).catch(() => {});
  }
}

function mediaToAttachments(m: Api.Message): Attachment[] {
  const media = m.media;
  if (!media) return [];
  if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
    const big = media.photo.sizes.filter((s): s is Api.PhotoSize => s instanceof Api.PhotoSize).at(-1);
    return [{ fileId: null, name: `foto-${m.id}.jpg`, mime: 'image/jpeg', size: big?.size ?? 0, kind: 'image', width: big?.w, height: big?.h }];
  }
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const d = media.document;
    let name = `datei-${m.id}`;
    let kind: Attachment['kind'] = 'file';
    let durationSec: number | undefined, width: number | undefined, height: number | undefined;
    for (const a of d.attributes) {
      if (a instanceof Api.DocumentAttributeFilename) name = a.fileName;
      else if (a instanceof Api.DocumentAttributeAudio) { kind = a.voice ? 'voice' : 'audio'; durationSec = a.duration; }
      else if (a instanceof Api.DocumentAttributeVideo) { kind = a.roundMessage ? 'video' : 'video'; durationSec = a.duration; width = a.w; height = a.h; }
      else if (a instanceof Api.DocumentAttributeSticker) kind = 'sticker';
      else if (a instanceof Api.DocumentAttributeImageSize) { width = a.w; height = a.h; }
    }
    if (kind === 'file' && d.mimeType.startsWith('image/')) kind = 'image';
    return [{ fileId: null, name, mime: d.mimeType, size: Number(d.size.toString()), kind, durationSec, width, height }];
  }
  return [];
}

function mapReactions(r?: Api.TypeMessageReactions): Reaction[] {
  if (!r) return [];
  const out: Reaction[] = [];
  // Wenn Telegram die Absender kennt (kleine Chats), diese nutzen
  const recent = r.recentReactions ?? [];
  if (recent.length) {
    for (const rr of recent) {
      if (!(rr.reaction instanceof Api.ReactionEmoji)) continue;
      out.push({ emoji: rr.reaction.emoticon, senderId: utils.getPeerId(rr.peerId).toString(), fromMe: !!rr.my });
    }
    return out;
  }
  for (const rc of r.results) {
    if (!(rc.reaction instanceof Api.ReactionEmoji)) continue;
    const mine = rc.chosenOrder !== undefined;
    for (let i = 0; i < rc.count; i++) out.push({ emoji: rc.reaction.emoticon, senderId: mine && i === 0 ? 'me' : `n${i}`, fromMe: mine && i === 0 });
  }
  return out;
}

function fehlertext(msg: string): string {
  if (/PHONE_CODE_INVALID/.test(msg)) return 'Der Code stimmt nicht. Bitte nochmal.';
  if (/PHONE_NUMBER_INVALID/.test(msg)) return 'Die Telefonnummer ist ungültig. Bitte mit Ländervorwahl, z. B. +49…';
  if (/PASSWORD_HASH_INVALID/.test(msg)) return 'Das Passwort stimmt nicht.';
  if (/FLOOD_WAIT/.test(msg)) return 'Zu viele Versuche. Telegram verlangt eine Pause.';
  if (/API_ID_INVALID/.test(msg)) return 'api_id oder api_hash ist falsch.';
  return msg;
}

export const telegramFactory: AdapterFactory = ({ config, session, events }) =>
  new TelegramAdapter(config as any, session, events);

function flattenPeer(p: Api.TypeInputPeer): { t: string; id: string; h?: string } | null {
  if (p instanceof Api.InputPeerUser) return { t: 'u', id: p.userId.toString(), h: p.accessHash.toString() };
  if (p instanceof Api.InputPeerChannel) return { t: 'c', id: p.channelId.toString(), h: p.accessHash.toString() };
  if (p instanceof Api.InputPeerChat) return { t: 'g', id: p.chatId.toString() };
  return null;
}
function inflatePeer(f: { t: string; id: string; h?: string }): Api.TypeInputPeer | null {
  try {
    if (f.t === 'u') return new Api.InputPeerUser({ userId: bigInt(f.id), accessHash: bigInt(f.h ?? '0') });
    if (f.t === 'c') return new Api.InputPeerChannel({ channelId: bigInt(f.id), accessHash: bigInt(f.h ?? '0') });
    if (f.t === 'g') return new Api.InputPeerChat({ chatId: bigInt(f.id) });
  } catch { /* ignore */ }
  return null;
}
