import { createHash, randomUUID } from 'node:crypto';
import { ImapFlow, type FetchMessageObject } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { Adapter, AdapterEvents, Attachment, OutgoingFile } from '../types.js';
import type { AdapterFactory } from '../hub.js';
import { cleanMailText, htmlToText, normSubject } from '../mailtext.js';

/**
 * E-Mail über IMAP (Empfang, IDLE) und SMTP (Senden).
 * Ein „Chat“ ist ein Betreff mit einem Gegenüber: remoteId = `${adresse}|${hash(betreff)}`.
 * Die Oberfläche fasst alle Betreffe eines Absenders zu einem Kontakt zusammen (Chat.peer).
 * Nachrichten-ID = Hash der Message-ID, damit gesendete Mails im Ordner „Gesendet“ wiedererkannt werden.
 */
export interface EmailConfig {
  address: string; name?: string; user?: string; password: string;
  imapHost: string; imapPort?: number; smtpHost: string; smtpPort?: number;
  /** Eigene Signatur: wird beim Senden angehängt und in den Blasen ausgeblendet */
  signature?: string;
  /** Signaturen anderer (oder alte eigene), die in den Blasen ausgeblendet werden */
  hideSignatures?: string[];
  /** Newsletter und automatische Mails nicht als Chat zeigen (Standard: an) */
  hideBulk?: boolean;
  /** Wie weit zurück beim ersten Abruf (Tage) */
  days?: number;
}

interface Thread { subj: string; peer: string; name: string; replyTo?: string; lastMid?: string; refs: string[]; unseen: number[]; lastTs: number }
interface Session { boxes: Record<string, { v: string; last: number }>; threads: Record<string, Thread> }

const h = (s: string, n: number) => createHash('sha1').update(s).digest('hex').slice(0, n);
const lc = (s?: string | null) => (s ?? '').trim().toLowerCase();
const first = (a?: AddressObject | AddressObject[]) => (Array.isArray(a) ? a.flatMap((x) => x.value) : a?.value ?? []);
const MAX_SOURCE = 30 * 1024 * 1024;

export class EmailAdapter implements Adapter {
  readonly network = 'email' as const;
  private imap: ImapFlow | null = null;
  private s: Session;
  private stopped = false;
  private chain: Promise<unknown> = Promise.resolve();
  private poll: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private saveT: NodeJS.Timeout | null = null;
  private backoff = 5_000;
  private sentPath: string | null = null;
  /** Zuletzt geparste Mails (für Anhänge, damit sie nicht gleich nochmal geladen werden) */
  private cache = new Map<string, { at: number; mail: ParsedMail }>();

  constructor(private cfg: EmailConfig, session: string | null, private ev: AdapterEvents) {
    let s: Session | null = null;
    try { s = session ? JSON.parse(session) : null; } catch { /* neu anfangen */ }
    this.s = s && s.boxes && s.threads ? s : { boxes: {}, threads: {} };
  }

  private get me() { return lc(this.cfg.address); }
  private sigs() { return [this.cfg.signature ?? '', ...(this.cfg.hideSignatures ?? [])].filter((x) => x.trim()); }
  private save() {
    if (this.saveT) return;
    this.saveT = setTimeout(() => { this.saveT = null; this.ev.saveSession(JSON.stringify(this.s)); }, 2000);
  }
  /** Nacheinander abarbeiten: IMAP kann immer nur einen Ordner gleichzeitig offen haben */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  async input() { throw new Error('Zugangsdaten bitte in den Einstellungen ändern'); }

  async start() {
    this.stopped = false;
    this.ev.status({ state: 'connecting' });
    const c = new ImapFlow({
      host: this.cfg.imapHost, port: this.cfg.imapPort ?? 993, secure: (this.cfg.imapPort ?? 993) !== 143,
      auth: { user: this.cfg.user || this.cfg.address, pass: this.cfg.password }, logger: false,
      maxIdleTime: 5 * 60_000, autoIdleDelay: 2000,
    });
    c.on('error', (e: Error) => this.ev.log(`IMAP-Fehler: ${e.message}`));
    c.on('close', () => { if (this.imap === c) { this.imap = null; this.reconnect(); } });
    c.on('exists', (d: { path: string }) => { if (d.path === 'INBOX') void this.queue(() => this.syncBox('INBOX')).catch((e) => this.ev.log(`Abruf: ${e.message}`)); });
    c.on('flags', (d: { path: string; uid?: number; flags: Set<string> }) => { if (d.path === 'INBOX' && d.uid && d.flags.has('\\Seen')) this.seen([d.uid]); });
    try { await c.connect(); }
    catch (e: any) {
      const msg = e?.authenticationFailed || /auth/i.test(e?.responseText ?? '') ? 'Anmeldung abgelehnt. Stimmen Benutzername und App-Passwort?' : `IMAP-Server nicht erreichbar: ${e?.responseText || e?.message || e}`;
      this.ev.status({ state: 'error', message: msg });
      if (!e?.authenticationFailed) this.reconnect();
      return;
    }
    this.imap = c;
    this.backoff = 5_000;
    try {
      const boxes = await c.list();
      this.sentPath = boxes.find((b) => b.specialUse === '\\Sent')?.path ?? boxes.find((b) => /^(sent|gesendet|gesendete)/i.test(b.name))?.path ?? null;
    } catch { this.sentPath = null; }
    this.ev.status({ state: 'connected', self: this.cfg.address });
    await this.syncAll().catch((e) => this.ev.log(`Erster Abruf: ${e.message}`));
    if (!this.poll) this.poll = setInterval(() => void this.syncAll().catch(() => {}), 3 * 60_000);
  }

  private reconnect() {
    if (this.stopped || this.retry) return;
    this.ev.status({ state: 'connecting', message: 'Verbindung unterbrochen, neuer Versuch …' });
    this.retry = setTimeout(() => { this.retry = null; void this.start(); }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 5 * 60_000);
  }

  /** Gesendet, dann Posteingang: so bleibt am Ende der Posteingang geöffnet und IDLE meldet neue Mails */
  private syncAll() {
    return this.queue(async () => {
      if (this.sentPath) await this.syncBox(this.sentPath).catch((e) => this.ev.log(`Gesendet: ${e.message}`));
      await this.syncBox('INBOX');
    });
  }

  private async syncBox(path: string) {
    const c = this.imap; if (!c) return;
    const lock = await c.getMailboxLock(path);
    try {
      const mb = c.mailbox; if (!mb) return;
      const v = String(mb.uidValidity);
      let st = this.s.boxes[path];
      if (!st || st.v !== v) {
        // Erster Abruf: nur die letzten Tage, höchstens 300 Mails
        const since = new Date(Date.now() - (this.cfg.days ?? 30) * 864e5);
        const uids = ((await c.search({ since }, { uid: true })) || []).sort((a, b) => a - b).slice(-300);
        st = { v, last: uids.length ? uids[0] - 1 : (mb.uidNext ?? 1) - 1 };
        this.s.boxes[path] = st;
      }
      if (mb.exists === 0) return;
      const list: FetchMessageObject[] = [];
      for await (const m of c.fetch(`${st.last + 1}:*`, { uid: true, flags: true, size: true, envelope: true, headers: ['list-unsubscribe', 'precedence', 'auto-submitted', 'list-id'] }, { uid: true })) {
        if (m.uid > st.last) list.push(m);
      }
      for (const m of list.sort((a, b) => a.uid - b.uid)) {
        try {
          if (!this.isBulk(m) || path !== 'INBOX') {
            const src = await c.fetchOne(String(m.uid), { source: (m.size ?? 0) > MAX_SOURCE ? { maxLength: 2 * 1024 * 1024 } : true }, { uid: true });
            if (src && src.source) await this.handle(path, m, await simpleParser(src.source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true }));
          }
        } catch (e: any) { this.ev.log(`Mail ${path}/${m.uid}: ${e.message}`); }
        st.last = m.uid;
        this.save();
      }
    } finally { lock.release(); }
  }

  private isBulk(m: FetchMessageObject): boolean {
    if (this.cfg.hideBulk === false) return false;
    const hd = m.headers?.toString('utf8').toLowerCase() ?? '';
    return /^(list-unsubscribe|list-id):/m.test(hd) || /^precedence:\s*(bulk|list|junk)/m.test(hd) || /^auto-submitted:\s*auto-/m.test(hd);
  }

  private async handle(path: string, m: FetchMessageObject, mail: ParsedMail) {
    const from = first(mail.from)[0];
    const fromAddr = lc(from?.address);
    const fromMe = fromAddr === this.me || path === this.sentPath;
    const other = fromMe ? first(mail.to).find((a) => lc(a.address) !== this.me) ?? first(mail.to)[0] : from;
    const peer = lc(other?.address);
    if (!peer) return;
    const name = (other?.name || peer.split('@')[0]).trim();
    const subjRaw = mail.subject ?? '';
    const subj = normSubject(subjRaw) || '(kein Betreff)';
    const chatRemote = `${peer}|${h(lc(subj), 10)}`;
    const mid = mail.messageId || `<${m.uid}.${path}@chorus.local>`;
    const remoteId = h(mid, 16);
    const ts = new Date(mail.date ?? m.envelope?.date ?? Date.now()).getTime() || Date.now();

    const t: Thread = this.s.threads[chatRemote] ?? { subj, peer, name, refs: [], unseen: [], lastTs: 0 };
    if (!fromMe) { t.name = name; const rt = first(mail.replyTo)[0]?.address; t.replyTo = rt ? lc(rt) : undefined; }
    if (ts >= t.lastTs) {
      t.lastTs = ts; t.lastMid = mid;
      const refs = typeof mail.references === 'string' ? [mail.references] : mail.references ?? [];
      t.refs = [...refs, mid].slice(-10);
    }
    const isSeen = fromMe || m.flags?.has('\\Seen');
    if (!isSeen && path === 'INBOX' && !t.unseen.includes(m.uid)) t.unseen.push(m.uid);
    this.s.threads[chatRemote] = t;

    const body = mail.text?.trim() ? mail.text : mail.html ? htmlToText(mail.html) : '';
    let text = cleanMailText(body, this.sigs());
    const atts = this.attachmentsOf(mail).map((a, i): Attachment => ({
      fileId: null, name: a.filename || `anhang-${i + 1}`, mime: a.contentType || 'application/octet-stream', size: a.size ?? a.content?.length ?? 0, kind: 'file', remoteRef: `${path}|${m.uid}|${i}`,
    }));
    if (atts.length) this.cache.set(`${path}|${m.uid}`, { at: Date.now(), mail });
    if (!text && !atts.length) text = subjRaw || '(leere E-Mail)';

    this.ev.chat({ remoteId: chatRemote, title: subj, kind: 'direct', lastTs: 0, lastText: '', peer: { id: peer, name: t.name } });
    this.ev.message({
      chatRemoteId: chatRemote, remoteId, senderId: fromMe ? 'me' : peer, senderName: fromMe ? 'Ich' : t.name, fromMe, ts, text,
      edited: false, deleted: false, attachments: atts, status: fromMe ? 'sent' : 'received',
    });
    // Ungelesen genau wie im Postfach (die Zentrale zählt sonst jede neu geladene Mail)
    this.ev.chat({ remoteId: chatRemote, title: subj, kind: 'direct', lastTs: 0, lastText: '', unread: t.unseen.length, peer: { id: peer, name: t.name } });
    this.prune();
  }

  /** Echte Anhänge: eingebettete kleine Bilder (Logos, Signaturbilder) weglassen */
  private attachmentsOf(mail: ParsedMail) {
    return mail.attachments.filter((a) => !(a.related && (a.size ?? 0) < 40_000) && a.contentType !== 'application/pgp-signature' && a.contentType !== 'application/pkcs7-signature');
  }
  private prune() { const now = Date.now(); for (const [k, v] of this.cache) if (now - v.at > 120_000) this.cache.delete(k); }

  /** In einem anderen Programm gelesen: Ungelesen-Zähler nachziehen */
  private seen(uids: number[]) {
    for (const [remote, t] of Object.entries(this.s.threads)) {
      const before = t.unseen.length;
      t.unseen = t.unseen.filter((u) => !uids.includes(u));
      if (before && !t.unseen.length) this.ev.chat({ remoteId: remote, title: t.subj, kind: 'direct', lastTs: 0, lastText: '', unread: 0, peer: { id: t.peer, name: t.name } });
      if (before !== t.unseen.length) this.save();
    }
  }

  async markRead(chatRemote: string) {
    const t = this.s.threads[chatRemote];
    if (!t?.unseen.length || !this.imap) return;
    const uids = [...t.unseen];
    await this.queue(async () => {
      const lock = await this.imap!.getMailboxLock('INBOX');
      try { await this.imap!.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true }); } finally { lock.release(); }
    });
    t.unseen = t.unseen.filter((u) => !uids.includes(u));
    this.save();
  }

  // ---------- Senden ----------
  private async send(chatRemote: string, text: string, files: OutgoingFile[]): Promise<string> {
    const t = this.s.threads[chatRemote];
    if (!t) throw new Error('Zu diesem Chat fehlt die Ursprungs-Mail');
    const domain = this.me.split('@')[1] || 'chorus.local';
    const mid = `<${randomUUID()}@${domain}>`;
    const sig = this.cfg.signature?.trim();
    const opts = {
      from: this.cfg.name ? { name: this.cfg.name, address: this.cfg.address } : this.cfg.address,
      to: t.replyTo || t.peer, subject: `Re: ${t.subj}`, messageId: mid, date: new Date(),
      inReplyTo: t.lastMid, references: t.refs.length ? t.refs : undefined,
      text: sig ? `${text}\n\n-- \n${sig}` : text,
      attachments: files.map((f) => ({ filename: f.name, content: f.data, contentType: f.mime })),
    };
    const raw = await new MailComposer(opts).compile().build();
    const port = this.cfg.smtpPort ?? 465;
    const tr = nodemailer.createTransport({ host: this.cfg.smtpHost, port, secure: port === 465, auth: { user: this.cfg.user || this.cfg.address, pass: this.cfg.password } });
    try { await tr.sendMail({ envelope: { from: this.cfg.address, to: [t.replyTo || t.peer] }, raw }); }
    catch (e: any) { throw new Error(`E-Mail nicht gesendet: ${e?.response || e?.message || e}`); }
    finally { tr.close(); }
    t.lastMid = mid; t.refs = [...t.refs, mid].slice(-10); t.lastTs = Date.now();
    this.save();
    // In „Gesendet“ ablegen, falls der Server das nicht selbst tut (Gmail tut es, die meisten anderen nicht)
    setTimeout(() => void this.storeSent(mid, raw).catch((e) => this.ev.log(`Gesendet ablegen: ${e.message}`)), 5000);
    return h(mid, 16);
  }

  private storeSent(mid: string, raw: Buffer) {
    const path = this.sentPath; const c = this.imap;
    if (!path || !c) return Promise.resolve();
    return this.queue(async () => {
      const lock = await c.getMailboxLock(path);
      try {
        const found = await c.search({ header: { 'message-id': mid } }, { uid: true });
        if (!found || !found.length) await c.append(path, raw, ['\\Seen']);
      } finally { lock.release(); }
      // Posteingang wieder öffnen, damit IDLE weiterläuft
      const l2 = await c.getMailboxLock('INBOX'); l2.release();
    });
  }

  sendText(chatRemote: string, text: string) { return this.send(chatRemote, text, []); }
  sendFile(chatRemote: string, file: OutgoingFile, caption?: string) { return this.send(chatRemote, caption ?? '', [file]); }

  async fetchAttachment(_chat: string, _remoteId: string, index: number, att?: Attachment): Promise<Buffer> {
    const [path, uidS, idxS] = (att?.remoteRef ?? '').split('|');
    const uid = Number(uidS); const i = idxS !== undefined ? Number(idxS) : index;
    if (!path || !uid) throw new Error('Anhang nicht gefunden');
    let mail = this.cache.get(`${path}|${uid}`)?.mail;
    if (!mail) {
      const c = this.imap; if (!c) throw new Error('E-Mail ist nicht verbunden');
      const src = await this.queue(async () => {
        const lock = await c.getMailboxLock(path);
        try { return await c.fetchOne(String(uid), { source: true }, { uid: true }); } finally { lock.release(); }
      });
      if (!src || !src.source) throw new Error('Mail nicht mehr im Postfach');
      mail = await simpleParser(src.source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
      this.cache.set(`${path}|${uid}`, { at: Date.now(), mail });
    }
    const a = this.attachmentsOf(mail)[i];
    if (!a) throw new Error('Anhang nicht gefunden');
    return a.content;
  }

  async react() { throw new Error('Reaktionen gibt es bei E-Mails nicht'); }
  async edit() { throw new Error('Gesendete E-Mails lassen sich nicht bearbeiten'); }
  async delete(_c: string, _r: string, forEveryone: boolean) { if (forEveryone) throw new Error('Gesendete E-Mails lassen sich nicht zurückholen'); }
  async loadHistory() {}
  async contactInfo(chatRemote: string) { return { username: chatRemote.split('|')[0], noAvatar: true }; }
  async resync() { await this.syncAll(); }
  async stop() {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll); this.poll = null;
    if (this.retry) clearTimeout(this.retry); this.retry = null;
    if (this.saveT) { clearTimeout(this.saveT); this.saveT = null; this.ev.saveSession(JSON.stringify(this.s)); }
    const c = this.imap; this.imap = null;
    await c?.logout().catch(() => c.close());
  }
  async logout() {}
}

export const emailFactory: AdapterFactory = ({ config, session, events }) => new EmailAdapter(config as unknown as EmailConfig, session, events);
