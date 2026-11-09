import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Adapter, AdapterEvents, Attachment, OutgoingFile } from '../types.js';
import type { AdapterFactory } from '../hub.js';
import { packDir, unpackDir, secureTmpDir } from '../tarball.js';

/**
 * Signal über signal-cli (JSON-RPC), angemeldet als „gekoppeltes Gerät“ wie Signal Desktop.
 * Die Schlüssel von signal-cli liegen nur im Arbeitsspeicher (tmpfs) und werden verschlüsselt
 * im Tresor gesichert.
 *
 * Nachrichten-ID: `${timestamp}:${autorUuid}` – so lassen sich Reaktionen, Antworten und Löschungen zuordnen.
 * Chat-ID: Kontakt-UUID (bzw. Nummer) oder `g:${groupId}` für Gruppen.
 */
export class SignalAdapter implements Adapter {
  readonly network = 'signal' as const;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private nextId = 1;
  private account: string | null = null; // Nummer oder ACI
  private me: string | null = null; // eigene ACI (UUID)
  private dir: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private names = new Map<string, string>();
  private pruneTimer: NodeJS.Timeout | null = null;
  private lastRescue = 0;

  constructor(private accountId: string, private session: string | null, private ev: AdapterEvents, private bin: string) {
    this.dir = join(secureTmpDir(), `signal-${accountId}`);
  }

  async input() { throw new Error('Signal wird per QR-Code gekoppelt'); }

  // ---------- JSON-RPC ----------
  private call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    if (!this.proc) return Promise.reject(new Error('Signal ist nicht verbunden'));
    const id = this.nextId++;
    const p = this.account && !['startLink', 'finishLink', 'listAccounts'].includes(method) ? { account: this.account, ...params } : params;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: p }) + '\n');
    return new Promise<T>((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`Zeitüberschreitung bei ${method}`)); }, timeoutMs);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    });
  }

  private onLine(line: string) {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message ?? 'Signal-Fehler'));
      else p.res(msg.result);
    } else if (msg.method === 'receive') {
      const env = msg.params?.envelope ?? msg.params?.result?.envelope;
      if (env) this.onEnvelope(env).catch((e) => this.ev.log('envelope: ' + e));
    }
  }

  // ---------- Start / Kopplung ----------
  async start() {
    this.stopped = false;
    this.ev.status({ state: 'connecting' });
    // Nach einem Absturz von signal-cli den laufenden Stand behalten (er ist neuer als die letzte Sicherung).
    // Nur beim ersten Start (leeres tmpfs) aus dem Tresor auspacken.
    if (!existsSync(join(this.dir, 'data'))) {
      if (existsSync(this.dir)) rmSync(this.dir, { recursive: true, force: true });
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if (this.session) await unpackDir(this.session, this.dir);
    }
    this.prune();

    this.proc = spawn(this.bin, ['--config', this.dir, '--trust-new-identities', 'always', 'jsonRpc'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.on('error', (e) => this.ev.status({ state: 'error', message: 'signal-cli fehlt oder startet nicht: ' + e.message }));
    createInterface({ input: this.proc.stdout }).on('line', (l) => this.onLine(l));
    createInterface({ input: this.proc.stderr }).on('line', (l) => {
      if (!/INFO|DEBUG/.test(l)) this.ev.log(l);
      // Speicher voll oder Empfang abgestürzt: signal-cli läuft dann weiter, empfängt aber nichts mehr
      if (/SQLITE_FULL|No space left on device|Exception in thread "receive/.test(l)) this.rescue(l);
    });
    this.proc.on('exit', (code) => {
      for (const p of this.pending.values()) p.rej(new Error('signal-cli beendet'));
      this.pending.clear();
      this.proc = null;
      if (!this.stopped) {
        this.ev.status({ state: 'error', message: `signal-cli wurde beendet (Code ${code}). Neustart in 10 s …` });
        setTimeout(() => { if (!this.stopped) this.start().catch(() => {}); }, 10_000);
      }
    });

    const accounts = await this.call<{ number: string | null; aci?: string }[]>('listAccounts').catch(() => []);
    if (accounts.length) {
      this.account = accounts[0].number ?? accounts[0].aci ?? null;
      this.me = accounts[0].aci ?? null;
    } else {
      await this.link();
    }
    if (this.stopped) return;
    this.ev.status({ state: 'connected', self: this.account && this.account.startsWith('+') ? this.account : undefined });
    await this.persist().catch((e) => this.ev.log('Sichern fehlgeschlagen: ' + e.message));
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveTimer = setInterval(() => this.persist().catch(() => {}), 5 * 60_000);
    if (!this.pruneTimer) this.pruneTimer = setInterval(() => this.prune(), 30 * 60_000);
    await this.loadDirectory();
  }

  private async link() {
    while (!this.stopped) {
      const { deviceLinkUri } = await this.call<{ deviceLinkUri: string }>('startLink');
      this.ev.status({ state: 'qr', qr: deviceLinkUri, message: 'In Signal: Einstellungen → Gekoppelte Geräte → +' });
      try {
        const r = await this.call<{ number: string | null; aci: string }>('finishLink', { deviceLinkUri, deviceName: 'Chorus' }, 5 * 60_000);
        this.account = r.number ?? r.aci;
        this.me = r.aci;
        this.ev.status({ state: 'connecting', message: 'Gekoppelt. Kontakte werden geladen …' });
        await this.call('sendSyncRequest').catch(() => {});
        await new Promise((r) => setTimeout(r, 3000));
        return;
      } catch (e: any) {
        if (this.stopped) return;
        this.ev.log('Kopplung: ' + e.message); // abgelaufen → neuer QR-Code
      }
    }
  }

  private async loadDirectory() {
    const contacts = await this.call<any[]>('listContacts', {}).catch(() => []);
    for (const c of contacts) {
      const id = c.uuid ?? c.number;
      const name = c.name || [c.profile?.givenName, c.profile?.familyName].filter(Boolean).join(' ') || c.username || c.number;
      if (id && name) {
        this.names.set(id, name);
        // Kontakte als (leere) Einzelchats bekannt machen: über Suche und „Neue Nachricht“ auffindbar
        if (!c.isBlocked && !c.isHidden && id !== this.me) this.ev.chat({ remoteId: id, title: name, kind: 'direct', lastTs: 0, lastText: '' });
      }
    }
    const groups = await this.call<any[]>('listGroups', {}).catch(() => []);
    for (const g of groups) {
      if (g.isMember === false) continue;
      this.ev.chat({ remoteId: 'g:' + g.id, title: g.name || 'Gruppe', kind: 'group', lastTs: 0, lastText: '' });
    }
  }

  private async persist() {
    if (!existsSync(join(this.dir, 'data'))) return;
    // Sticker-Pakete lädt signal-cli bei Bedarf neu, sie gehören nicht in die Sicherung
    this.ev.saveSession(await packDir(this.dir, ['./stickers', './outgoing']));
  }

  /**
   * signal-cli legt Anhänge und Sticker im Arbeitsspeicher (tmpfs) ab und räumt nie auf.
   * Chorus speichert Anhänge selbst (verschlüsselt), daher hier alte Dateien löschen,
   * sonst läuft der Speicher voll und Signal empfängt nichts mehr.
   */
  private prune(hard = false) {
    const now = Date.now();
    const maxAge: Record<string, number> = hard
      ? { attachments: 60 * 60_000, stickers: 0 }
      : { attachments: 3 * 86_400_000, stickers: 86_400_000 };
    // Profilbilder bleiben: fehlt eins, hielte Chorus den Kontakt sonst für „ohne Bild“
    let n = 0;
    for (const [sub, age] of Object.entries(maxAge)) {
      const d = join(this.dir, sub);
      let names: string[] = [];
      try { names = readdirSync(d); } catch { continue; }
      for (const f of names) {
        const p = join(d, f);
        try {
          if (now - statSync(p).mtimeMs >= age) { rmSync(p, { recursive: true, force: true }); n++; }
        } catch { /* schon weg */ }
      }
    }
    if (n) this.ev.log(`Signal: ${n} alte Dateien aus dem Zwischenspeicher gelöscht`);
  }

  /** Speicher voll: aufräumen und signal-cli neu starten (höchstens alle 2 Minuten) */
  private rescue(line: string) {
    if (this.stopped || Date.now() - this.lastRescue < 2 * 60_000) return;
    this.lastRescue = Date.now();
    this.ev.log('Signal hängt (' + line.slice(0, 120) + '), räume auf und starte neu');
    this.prune(true);
    const p = this.proc;
    if (p && p.exitCode === null) { p.stdin.end(); p.kill('SIGTERM'); } // exit-Handler startet nach 10 s neu
  }

  // ---------- Empfang ----------
  private nameOf(uuid: string | undefined, fallback?: string) {
    if (!uuid) return fallback ?? 'Unbekannt';
    if (fallback && !this.names.has(uuid)) this.names.set(uuid, fallback);
    return this.names.get(uuid) ?? fallback ?? 'Unbekannt';
  }

  private async onEnvelope(env: any) {
    const author: string = env.sourceUuid ?? env.sourceNumber;
    const authorName = this.nameOf(author, env.sourceName || env.sourceNumber);

    // Lesebestätigungen für eigene Nachrichten
    if (env.receiptMessage && this.me) {
      const status = env.receiptMessage.isRead || env.receiptMessage.isViewed ? 'read' : 'delivered';
      for (const ts of env.receiptMessage.timestamps ?? []) this.ev.messageUpdate(author, `${ts}:${this.me}`, { status });
      return;
    }

    // Vom eigenen Handy gesendet (Sync)
    const sent = env.syncMessage?.sentMessage;
    if (sent) {
      const chat = sent.groupInfo?.groupId ? 'g:' + sent.groupInfo.groupId : (sent.destinationUuid ?? sent.destinationNumber);
      if (!chat) return;
      if (sent.editMessage) return this.handleData(chat, this.me ?? author, 'Ich', true, sent.editMessage.dataMessage, sent.editMessage.targetSentTimestamp);
      return this.handleData(chat, this.me ?? author, 'Ich', true, sent);
    }

    const data = env.dataMessage ?? env.editMessage?.dataMessage;
    if (!data) return;
    const chat = data.groupInfo?.groupId ? 'g:' + data.groupInfo.groupId : author;
    if (!data.groupInfo) this.ev.chat({ remoteId: chat, title: authorName, kind: 'direct', lastTs: 0, lastText: '' });
    else if (data.groupInfo.groupName) this.ev.chat({ remoteId: chat, title: data.groupInfo.groupName, kind: 'group', lastTs: 0, lastText: '' });
    await this.handleData(chat, author, authorName, false, data, env.editMessage?.targetSentTimestamp);
  }

  private async handleData(chat: string, author: string, authorName: string, fromMe: boolean, d: any, editOf?: number) {
    if (d.reaction) {
      const r = d.reaction;
      const target = `${r.targetSentTimestamp}:${r.targetAuthorUuid ?? r.targetAuthorNumber}`;
      this.ev.reactionChange(chat, target, { emoji: r.emoji, senderId: author, senderName: authorName, fromMe }, !!r.isRemove);
      return;
    }
    if (d.remoteDelete) {
      this.ev.messageUpdate(chat, `${d.remoteDelete.targetTimestamp}:${author}`, { deleted: true, text: '' });
      return;
    }
    if (editOf) {
      this.ev.messageUpdate(chat, `${editOf}:${author}`, { text: d.message ?? '', edited: true });
      return;
    }
    if (d.message == null && !d.attachments?.length && !d.sticker) return; // z.B. Profil-Updates
    const attachments: Attachment[] = (d.attachments ?? []).map((a: any) => ({
      fileId: null, remoteRef: a.id, name: a.filename || `datei-${a.id}`, mime: a.contentType || 'application/octet-stream', size: a.size ?? 0,
      kind: a.isVoiceNote ? 'voice' : a.contentType?.startsWith('image/') ? 'image' : a.contentType?.startsWith('video/') ? 'video' : a.contentType?.startsWith('audio/') ? 'audio' : 'file',
      width: a.width ?? undefined, height: a.height ?? undefined,
    }));
    if (d.sticker?.attachment) {
      const a = d.sticker.attachment;
      attachments.push({ fileId: null, remoteRef: a.id, name: 'sticker.webp', mime: a.contentType || 'image/webp', size: a.size ?? 0, kind: 'sticker' });
    }
    this.ev.message({
      chatRemoteId: chat,
      remoteId: `${d.timestamp}:${author}`,
      senderId: author,
      senderName: authorName,
      fromMe,
      ts: d.timestamp,
      text: d.message ?? '',
      replyToRemoteId: d.quote ? `${d.quote.id}:${d.quote.authorUuid ?? d.quote.authorNumber}` : null,
      edited: false,
      deleted: false,
      attachments,
      status: fromMe ? 'sent' : 'received',
    });
  }

  // ---------- Senden ----------
  async resolvePhone(phone: string) {
    const r = await this.call<{ number: string; uuid?: string; isRegistered: boolean }[]>('getUserStatus', { recipient: [phone] }).catch(() => null);
    if (r && r[0] && r[0].isRegistered === false) throw new Error('Diese Nummer ist nicht bei Signal registriert.');
    return { remoteId: phone, title: phone };
  }

  private target(chat: string): Record<string, unknown> {
    return chat.startsWith('g:') ? { groupId: chat.slice(2) } : { recipient: [chat] };
  }
  private split(remoteId: string) {
    const i = remoteId.indexOf(':');
    return { ts: Number(remoteId.slice(0, i)), author: remoteId.slice(i + 1) };
  }
  private quote(replyTo?: string | null) {
    if (!replyTo) return {};
    const { ts, author } = this.split(replyTo);
    return { quoteTimestamp: ts, quoteAuthor: author };
  }

  async sendText(chat: string, text: string, replyTo?: string | null) {
    const r = await this.call<{ timestamp: number }>('send', { ...this.target(chat), message: text, ...this.quote(replyTo) });
    return `${r.timestamp}:${this.me}`;
  }

  async sendFile(chat: string, f: OutgoingFile, caption?: string, replyTo?: string | null) {
    // Große Dateien (Videos) nicht als Base64 durch JSON-RPC schicken, sondern als Datei im Arbeitsverzeichnis von signal-cli.
    // Der Dateiname bleibt erhalten, damit der Empfänger ihn sieht.
    const dir = join(this.dir, 'outgoing', randomUUID());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, f.name.replace(/[\/\\]/g, '_') || 'datei');
    writeFileSync(path, f.data, { mode: 0o600 });
    try {
      const r = await this.call<{ timestamp: number }>('send', { ...this.target(chat), message: caption ?? '', attachments: [path], ...this.quote(replyTo) }, 10 * 60_000);
      return `${r.timestamp}:${this.me}`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async react(chat: string, remoteId: string, emoji: string | null) {
    const { ts, author } = this.split(remoteId);
    if (emoji) await this.call('sendReaction', { ...this.target(chat), emoji, targetAuthor: author, targetTimestamp: ts });
    else {
      // Zum Entfernen braucht Signal das bisherige Emoji – „remove“ mit beliebigem Emoji wird akzeptiert
      await this.call('sendReaction', { ...this.target(chat), emoji: '👍', targetAuthor: author, targetTimestamp: ts, remove: true });
    }
  }

  async edit(chat: string, remoteId: string, text: string) {
    await this.call('send', { ...this.target(chat), message: text, editTimestamp: this.split(remoteId).ts });
  }

  async delete(chat: string, remoteId: string, forEveryone: boolean) {
    if (forEveryone) await this.call('remoteDelete', { ...this.target(chat), targetTimestamp: this.split(remoteId).ts });
  }

  async markRead(chat: string, remoteId: string) {
    const { ts, author } = this.split(remoteId);
    if (author && author !== this.me) await this.call('sendReceipt', { recipient: author, targetTimestamp: [ts], type: 'read' });
  }

  async loadHistory() { /* Signal überträgt keinen alten Verlauf an gekoppelte Geräte */ }

  async fetchAttachment(chat: string, _remoteId: string, _index: number, att?: Attachment) {
    if (!att?.remoteRef) throw new Error('Anhang nicht verfügbar');
    const data = await this.call<{ data: string } | string>('getAttachment', { id: att.remoteRef, ...(chat.startsWith('g:') ? { groupId: chat.slice(2) } : { recipient: chat }) });
    const buf = Buffer.from(typeof data === 'string' ? data : data.data, 'base64');
    // Chorus hebt den Anhang ab jetzt selbst auf: Kopie im Arbeitsspeicher von signal-cli freigeben
    if (!/[/\\]|\.\./.test(att.remoteRef)) rmSync(join(this.dir, 'attachments', att.remoteRef), { force: true });
    return buf;
  }

  async contactInfo(chat: string) {
    const out: { phone?: string; username?: string; about?: string; description?: string; members?: number; avatar?: Buffer | null } = {};
    const b64 = (r: any) => { const d = typeof r === 'string' ? r : r?.data; return d ? Buffer.from(d, 'base64') : null; };
    const missing = (e: any) => /not found|no avatar|does not have|could not find|keine?/i.test(String(e?.message ?? e));
    if (chat.startsWith('g:')) {
      const gid = chat.slice(2);
      const gs = await this.call<any[]>('listGroups', { groupId: gid, detailed: true }).catch(() => null);
      const g = Array.isArray(gs) ? gs.find((x) => x.id === gid) ?? gs[0] : null;
      if (g) { if (g.description) out.description = g.description; if (Array.isArray(g.members)) out.members = g.members.length; }
      try { out.avatar = b64(await this.call('getAvatar', { groupId: gid })); } catch (e: any) { if (missing(e)) out.avatar = null; else this.ev.log('Gruppenbild: ' + (e?.message ?? e)); }
      return out;
    }
    const cs = await this.call<any[]>('listContacts', { recipient: [chat], detailed: true }).catch(() => null);
    const c = Array.isArray(cs) ? cs.find((x) => x.uuid === chat || x.number === chat) ?? cs[0] : null;
    if (c) {
      if (c.number) out.phone = c.number;
      if (c.username) out.username = c.username;
      const about = [c.profile?.aboutEmoji, c.profile?.about].filter(Boolean).join(' ');
      if (about) out.about = about;
    } else if (chat.startsWith('+')) out.phone = chat;
    try { out.avatar = b64(await this.call('getAvatar', { contact: chat })); }
    catch {
      try { out.avatar = b64(await this.call('getAvatar', { profile: chat })); } catch (e: any) { if (missing(e)) out.avatar = null; else this.ev.log('Profilbild: ' + (e?.message ?? e)); }
    }
    return out;
  }

  async resync() { await this.call('sendSyncRequest').catch(() => {}); await this.loadDirectory(); }

  async logout() {
    await this.call('unregister', {}).catch(() => {}); // entfernt nur dieses gekoppelte Gerät
  }

  async stop() {
    this.stopped = true;
    if (this.saveTimer) clearInterval(this.saveTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.saveTimer = this.pruneTimer = null;
    // Erst signal-cli sauber beenden, dann den ruhenden Stand sichern
    const p = this.proc;
    this.proc = null;
    if (p && p.exitCode === null) {
      const exited = new Promise<void>((r) => p.once('exit', () => r()));
      p.stdin.end();
      p.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
    }
    await this.persist().catch(() => {});
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export const signalFactory: AdapterFactory = ({ accountId, session, events }) =>
  new SignalAdapter(accountId, session, events, process.env.SIGNAL_CLI ?? 'signal-cli');
