import Database from 'better-sqlite3-multiple-ciphers';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { seal, open } from './crypto.js';
import { fixKind } from './kinds.js';
import type { Account, Chat, Message, Network, AccountStatus, Reaction, Attachment } from './types.js';

/** Verschlüsselte Datenbank (SQLCipher) + verschlüsselte Dateiablage */
export class Store {
  db: Database.Database;
  private filesDir: string;

  constructor(dataDir: string, private dek: Buffer) {
    this.filesDir = join(dataDir, 'files');
    mkdirSync(this.filesDir, { recursive: true });
    this.db = new Database(join(dataDir, 'inbox.db'));
    this.db.pragma(`cipher='sqlcipher'`);
    this.db.pragma(`key="x'${dek.toString('hex')}'"`);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, network TEXT NOT NULL, label TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}', session TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        remote_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL,
        last_ts INTEGER NOT NULL DEFAULT 0, last_text TEXT NOT NULL DEFAULT '',
        unread INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0,
        avatar_file_id TEXT, ai_enabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS chats_order ON chats(pinned DESC, last_ts DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        remote_id TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, from_me INTEGER NOT NULL,
        ts INTEGER NOT NULL, text TEXT NOT NULL, reply_to TEXT, edited INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0, attachments TEXT NOT NULL DEFAULT '[]',
        reactions TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, transcript TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat_id, ts);
      CREATE TABLE IF NOT EXISTS people (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, remote_id TEXT NOT NULL,
        avatar_file_id TEXT, no_avatar INTEGER NOT NULL DEFAULT 0, fetched_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, remote_id)
      );
    `);
    const cols = (this.db.prepare('PRAGMA table_info(chats)').all() as { name: string }[]).map((c) => c.name);
    const mcols = (this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name);
    if (!mcols.includes('translation')) this.db.exec('ALTER TABLE messages ADD COLUMN translation TEXT');
    if (!mcols.includes('translation_from')) this.db.exec('ALTER TABLE messages ADD COLUMN translation_from TEXT');
    if (!mcols.includes('html')) this.db.exec('ALTER TABLE messages ADD COLUMN html TEXT');
    if (!cols.includes('autopilot')) this.db.exec('ALTER TABLE chats ADD COLUMN autopilot TEXT');
    for (const [c, t] of [['archived', 'INTEGER NOT NULL DEFAULT 0'], ['alias', 'TEXT'], ['custom_avatar', 'TEXT'], ['info', 'TEXT'], ['note', 'TEXT'], ['translate', 'TEXT'], ['link', 'TEXT'], ['send_via', 'TEXT'], ['peer', 'TEXT']] as const)
      if (!cols.includes(c)) this.db.exec(`ALTER TABLE chats ADD COLUMN ${c} ${t}`);
  }

  // ---------- Einstellungen ----------
  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
    return r ? JSON.parse(r.value) : fallback;
  }
  setSetting(key: string, value: unknown) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }

  // ---------- Konten ----------
  createAccount(network: Network, label: string, config: Record<string, unknown> = {}): string {
    const id = randomUUID().slice(0, 8);
    this.db.prepare('INSERT INTO accounts(id,network,label,config,created_at) VALUES(?,?,?,?,?)').run(id, network, label, JSON.stringify(config), Date.now());
    return id;
  }
  listAccountRows() {
    return this.db.prepare('SELECT * FROM accounts ORDER BY created_at').all() as { id: string; network: Network; label: string; config: string; session: string | null; created_at: number }[];
  }
  getAccountRow(id: string) {
    return this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as { id: string; network: Network; label: string; config: string; session: string | null; created_at: number } | undefined;
  }
  setAccountConfig(id: string, config: Record<string, unknown>) {
    this.db.prepare('UPDATE accounts SET config=? WHERE id=?').run(JSON.stringify(config), id);
  }
  saveSession(id: string, session: string | null) {
    this.db.prepare('UPDATE accounts SET session=? WHERE id=?').run(session, id);
  }
  deleteAccount(id: string) {
    this.db.prepare('DELETE FROM accounts WHERE id=?').run(id);
  }

  // ---------- Chats ----------
  upsertChat(c: Omit<Chat, 'id' | 'unread' | 'pinned' | 'muted'> & { unread?: number }): Chat {
    const id = `${c.accountId}:${c.remoteId}`;
    const ex = this.db.prepare('SELECT last_ts FROM chats WHERE id=?').get(id) as { last_ts: number } | undefined;
    if (!ex) {
      this.db.prepare(`INSERT INTO chats(id,account_id,remote_id,title,kind,last_ts,last_text,unread,avatar_file_id) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(id, c.accountId, c.remoteId, c.title, c.kind, c.lastTs, c.lastText, c.unread ?? 0, c.avatarFileId ?? null);
    } else {
      const newer = c.lastTs >= ex.last_ts;
      this.db.prepare(`UPDATE chats SET title=?, kind=?, avatar_file_id=COALESCE(?, avatar_file_id)
        ${newer ? ', last_ts=?, last_text=?' : ''} ${c.unread !== undefined ? ', unread=' + Number(c.unread) : ''} WHERE id=?`)
        .run(...([c.title, c.kind, c.avatarFileId ?? null, ...(newer ? [c.lastTs, c.lastText] : []), id] as unknown[]));
    }
    if (c.peer) this.db.prepare('UPDATE chats SET peer=? WHERE id=?').run(JSON.stringify(c.peer), id);
    return this.getChat(id)!;
  }
  private rowToChat(r: any): Chat {
    const c: Chat = {
      id: r.id, accountId: r.account_id, network: r.network, remoteId: r.remote_id, title: r.title, kind: r.kind,
      lastTs: r.last_ts, lastText: r.last_text, unread: r.unread, pinned: !!r.pinned, muted: !!r.muted,
      avatarFileId: r.avatar_file_id, aiEnabled: !!r.ai_enabled, autopilot: r.autopilot ? JSON.parse(r.autopilot) : null,
      customAvatar: !!r.custom_avatar, netTitle: r.title, alias: r.alias ?? null, archived: !!r.archived, info: r.info ? JSON.parse(r.info) : null, note: r.note ?? null, translate: r.translate ? JSON.parse(r.translate) : null, link: r.link ?? null, sendVia: r.link ? r.send_via ?? null : null, peer: r.peer ? JSON.parse(r.peer) : null,
      avatar: (r.custom_avatar || r.avatar_file_id) ? `/api/chats/${encodeURIComponent(r.id)}/avatar?v=${String(r.custom_avatar || r.avatar_file_id).slice(0, 8)}` : null,
    };
    if (r.alias) c.title = r.alias;
    return c;
  }
  /** Chat samt Nachrichten und gespeicherten Anhängen entfernen */
  deleteChat(id: string) {
    const rows = this.db.prepare('SELECT attachments FROM messages WHERE chat_id=?').all(id) as { attachments: string }[];
    for (const r of rows) for (const a of JSON.parse(r.attachments) as Attachment[]) if (a.fileId) this.deleteFile(a.fileId);
    const c = this.db.prepare('SELECT avatar_file_id, custom_avatar FROM chats WHERE id=?').get(id) as { avatar_file_id: string | null; custom_avatar: string | null } | undefined;
    if (c?.avatar_file_id) this.deleteFile(c.avatar_file_id);
    if (c?.custom_avatar) this.deleteFile(c.custom_avatar);
    this.db.prepare('DELETE FROM chats WHERE id=?').run(id);
  }
  getChat(id: string): Chat | null {
    const r = this.db.prepare('SELECT c.*, a.network FROM chats c JOIN accounts a ON a.id=c.account_id WHERE c.id=?').get(id);
    return r ? this.rowToChat(r) : null;
  }
  listChats(): Chat[] {
    return this.db.prepare('SELECT c.*, a.network FROM chats c JOIN accounts a ON a.id=c.account_id ORDER BY c.pinned DESC, c.last_ts DESC LIMIT 1000').all().map((r) => this.rowToChat(r));
  }
  /** Chats/Kontakte nach Name, Alias oder Nummer suchen – auch solche ohne Nachrichten, die in listChats() wegen des Limits fehlen können */
  searchChats(q: string, limit = 100): Chat[] {
    const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    return this.db.prepare(`SELECT c.*, a.network FROM chats c JOIN accounts a ON a.id=c.account_id
      WHERE c.title LIKE ? ESCAPE '\\' OR c.alias LIKE ? ESCAPE '\\' OR c.remote_id LIKE ? ESCAPE '\\' ORDER BY c.last_ts DESC LIMIT ?`).all(like, like, like, limit).map((r) => this.rowToChat(r));
  }
  updateChat(id: string, patch: Partial<Pick<Chat, 'pinned' | 'muted' | 'unread' | 'archived' | 'alias' | 'note'>> & { aiEnabled?: boolean }) {
    const cols: Record<string, string> = { pinned: 'pinned', muted: 'muted', unread: 'unread', aiEnabled: 'ai_enabled', archived: 'archived', alias: 'alias', note: 'note' };
    for (const [k, v] of Object.entries(patch)) {
      if (cols[k] === undefined) continue;
      let val: unknown = typeof v === 'boolean' ? Number(v) : v;
      if ((k === 'alias' || k === 'note') && typeof val === 'string') val = val.trim().slice(0, k === 'note' ? 2000 : 100) || null;
      if (k === 'unread') val = Math.max(0, Number(val) || 0);
      this.db.prepare(`UPDATE chats SET ${cols[k]}=? WHERE id=?`).run(val ?? null, id);
    }
  }
  /** Profil-Infos/-Bild vom Messenger, eigenes Bild */
  setChatInfo(id: string, info: unknown, avatarFileId?: string | null) {
    const old = this.db.prepare('SELECT avatar_file_id FROM chats WHERE id=?').get(id) as { avatar_file_id: string | null } | undefined;
    if (avatarFileId !== undefined) {
      this.db.prepare('UPDATE chats SET info=?, avatar_file_id=? WHERE id=?').run(JSON.stringify(info), avatarFileId, id);
      if (old?.avatar_file_id && old.avatar_file_id !== avatarFileId) this.deleteFile(old.avatar_file_id);
    } else this.db.prepare('UPDATE chats SET info=? WHERE id=?').run(JSON.stringify(info), id);
  }
  setCustomAvatar(id: string, fileId: string | null) {
    const old = this.db.prepare('SELECT custom_avatar FROM chats WHERE id=?').get(id) as { custom_avatar: string | null } | undefined;
    this.db.prepare('UPDATE chats SET custom_avatar=? WHERE id=?').run(fileId, id);
    if (old?.custom_avatar && old.custom_avatar !== fileId) this.deleteFile(old.custom_avatar);
  }
  avatarFileOf(id: string): string | null {
    const r = this.db.prepare('SELECT custom_avatar, avatar_file_id FROM chats WHERE id=?').get(id) as { custom_avatar: string | null; avatar_file_id: string | null } | undefined;
    return r?.custom_avatar || r?.avatar_file_id || null;
  }
  setAutopilot(id: string, a: import('./types.js').Autopilot | null) {
    this.db.prepare('UPDATE chats SET autopilot=? WHERE id=?').run(a ? JSON.stringify(a) : null, id);
  }
  setTranslate(id: string, t: Chat['translate']) {
    this.db.prepare('UPDATE chats SET translate=? WHERE id=?').run(t ? JSON.stringify(t) : null, id);
  }
  /** Neueste eingehende Nachrichten mit Text, aber ohne Übersetzung */
  /** Wer in einem Chat zuletzt geschrieben hat (für die Autobot-Einstellungen in Gruppen) */
  participants(chatId: string): { id: string; name: string }[] {
    return (this.db.prepare(`SELECT sender_id AS id, sender_name AS name, MAX(ts) AS t FROM messages WHERE chat_id=? AND from_me=0 GROUP BY sender_id ORDER BY t DESC LIMIT 100`)
      .all(chatId) as { id: string; name: string }[]).map(({ id, name }) => ({ id, name }));
  }
  /** Profilbilder der Absender in einer Gruppe. Gibt es mit der Person einen Einzelchat mit Bild, wird dessen Bild genommen,
   *  sonst das eigens geholte (Tabelle people). `fetch`: diese Absender sollten (neu) beim Messenger nachgefragt werden. */
  senderAvatars(chatId: string): { avatars: Record<string, string>; fetch: string[] } {
    const chat = this.db.prepare('SELECT account_id FROM chats WHERE id=?').get(chatId) as { account_id: string } | undefined;
    if (!chat) return { avatars: {}, fetch: [] };
    const rows = this.db.prepare(`
      SELECT s.sender_id AS sid, d.id AS did, COALESCE(d.custom_avatar, d.avatar_file_id) AS dfile,
             p.avatar_file_id AS pfile, p.no_avatar AS pnone, p.fetched_at AS pat
      FROM (SELECT sender_id, MAX(ts) AS t FROM messages WHERE chat_id=? AND from_me=0 AND sender_id<>'' GROUP BY sender_id ORDER BY t DESC LIMIT 200) s
      LEFT JOIN chats d ON d.account_id=? AND d.remote_id=s.sender_id AND d.kind='direct'
      LEFT JOIN people p ON p.account_id=? AND p.remote_id=s.sender_id`).all(chatId, chat.account_id, chat.account_id) as
      { sid: string; did: string | null; dfile: string | null; pfile: string | null; pnone: number | null; pat: number | null }[];
    const avatars: Record<string, string> = {}; const fetch: string[] = [];
    const now = Date.now();
    for (const r of rows) {
      if (r.dfile && r.did) { avatars[r.sid] = `/api/chats/${encodeURIComponent(r.did)}/avatar?v=${r.dfile.slice(0, 8)}`; continue; }
      if (r.pfile) avatars[r.sid] = `/api/chats/${encodeURIComponent(chatId)}/people/${encodeURIComponent(r.sid)}/avatar?v=${r.pfile.slice(0, 8)}`;
      if (r.did) continue; // Einzelchat ohne Bild: den frischt die normale Kontaktabfrage auf
      const age = now - (r.pat ?? 0);
      if (age > 7 * 864e5 || (!r.pfile && !r.pnone && age > 20 * 60_000)) fetch.push(r.sid);
    }
    return { avatars, fetch };
  }
  personAvatarFile(chatId: string, remoteId: string): string | null {
    const r = this.db.prepare('SELECT p.avatar_file_id AS f FROM people p JOIN chats c ON c.account_id=p.account_id WHERE c.id=? AND p.remote_id=?').get(chatId, remoteId) as { f: string | null } | undefined;
    return r?.f ?? null;
  }
  getPerson(accountId: string, remoteId: string) {
    return this.db.prepare('SELECT avatar_file_id AS fileId FROM people WHERE account_id=? AND remote_id=?').get(accountId, remoteId) as { fileId: string | null } | undefined;
  }
  /** fileId undefined: Bild unverändert lassen (Fehler beim Abholen), null: Person hat kein Bild */
  setPerson(accountId: string, remoteId: string, fileId: string | null | undefined) {
    const old = this.getPerson(accountId, remoteId);
    const keep = fileId === undefined ? old?.fileId ?? null : fileId;
    this.db.prepare(`INSERT INTO people(account_id,remote_id,avatar_file_id,no_avatar,fetched_at) VALUES(?,?,?,?,?)
      ON CONFLICT(account_id,remote_id) DO UPDATE SET avatar_file_id=excluded.avatar_file_id, no_avatar=excluded.no_avatar, fetched_at=excluded.fetched_at`)
      .run(accountId, remoteId, keep, fileId === null ? 1 : 0, Date.now());
    if (old?.fileId && old.fileId !== keep) this.deleteFile(old.fileId);
  }
  untranslated(chatId: string, limit: number): Message[] {
    return this.db.prepare(`SELECT * FROM messages WHERE chat_id=? AND deleted=0 AND translation IS NULL AND remote_id NOT LIKE 'local-%' AND (text<>'' OR transcript IS NOT NULL) ORDER BY ts DESC LIMIT ?`)
      .all(chatId, limit).map((r) => this.rowToMsg(r)).reverse();
  }
  chatAiEnabled(id: string): boolean {
    const r = this.db.prepare('SELECT ai_enabled FROM chats WHERE id=?').get(id) as { ai_enabled: number } | undefined;
    return !!r?.ai_enabled;
  }
  touchChat(id: string, ts: number, text: string, incUnread: boolean) {
    this.db.prepare(`UPDATE chats SET last_ts=MAX(last_ts, ?), last_text=CASE WHEN ? >= last_ts THEN ? ELSE last_text END,
      unread = unread + ? WHERE id=?`).run(ts, ts, text, incUnread ? 1 : 0, id);
  }

  // ---------- Nachrichten ----------
  private rowToMsg(r: any): Message {
    return {
      id: r.id, chatId: r.chat_id, remoteId: r.remote_id, senderId: r.sender_id, senderName: r.sender_name,
      fromMe: !!r.from_me, ts: r.ts, text: r.text, replyToRemoteId: r.reply_to, edited: !!r.edited, deleted: !!r.deleted,
      attachments: (JSON.parse(r.attachments) as Attachment[]).map(fixKind), reactions: JSON.parse(r.reactions), status: r.status, transcript: r.transcript, translation: r.translation ?? null,
      translationFrom: r.translation_from ?? null, html: r.html ?? null,
    };
  }
  /** true, wenn die Nachricht neu war */
  upsertMessage(m: Omit<Message, 'id' | 'reactions'> & { reactions?: Reaction[] }): { msg: Message; isNew: boolean } {
    const id = `${m.chatId}:${m.remoteId}`;
    const ex = this.db.prepare('SELECT id FROM messages WHERE id=?').get(id);
    if (ex) {
      this.db.prepare(`UPDATE messages SET text=?, edited=?, deleted=?, attachments=?, status=CASE WHEN ?='pending' THEN status ELSE ? END,
        reactions=COALESCE(?, reactions), html=COALESCE(?, html) WHERE id=?`).run(m.text, Number(m.edited), Number(m.deleted), JSON.stringify(m.attachments),
        m.status, m.status, m.reactions ? JSON.stringify(m.reactions) : null, m.html ?? null, id);
    } else {
      this.db.prepare(`INSERT INTO messages(id,chat_id,remote_id,sender_id,sender_name,from_me,ts,text,reply_to,edited,deleted,attachments,reactions,status,transcript,html)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, m.chatId, m.remoteId, m.senderId, m.senderName, Number(m.fromMe), m.ts, m.text,
        m.replyToRemoteId ?? null, Number(m.edited), Number(m.deleted), JSON.stringify(m.attachments), JSON.stringify(m.reactions ?? []),
        m.status, m.transcript ?? null, m.html ?? null);
    }
    return { msg: this.getMessage(id)!, isNew: !ex };
  }
  outgoingUpTo(chatId: string, maxNumericId: number): string[] {
    return (this.db.prepare(`SELECT id FROM messages WHERE chat_id=? AND from_me=1 AND status IN ('sent','delivered')
      AND remote_id GLOB '[0-9]*' AND CAST(remote_id AS INTEGER) <= ?`).all(chatId, maxNumericId) as { id: string }[]).map((r) => r.id);
  }
  findByRemote(accountId: string, remoteId: string): string[] {
    return (this.db.prepare('SELECT m.id FROM messages m JOIN chats c ON c.id=m.chat_id WHERE c.account_id=? AND m.remote_id=?')
      .all(accountId, remoteId) as { id: string }[]).map((r) => r.id);
  }
  getMessage(id: string): Message | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    return r ? this.rowToMsg(r) : null;
  }
  /** Ersetzt eine temporäre (ausstehende) Nachricht durch die echte ID */
  renameMessage(oldId: string, newRemoteId: string, chatId: string): Message | null {
    const newId = `${chatId}:${newRemoteId}`;
    if (this.getMessage(newId)) { this.db.prepare('DELETE FROM messages WHERE id=?').run(oldId); return this.getMessage(newId); }
    this.db.prepare('UPDATE messages SET id=?, remote_id=? WHERE id=?').run(newId, newRemoteId, oldId);
    return this.getMessage(newId);
  }
  removeMessage(id: string) { this.db.prepare('DELETE FROM messages WHERE id=?').run(id); }
  patchMessage(id: string, patch: Partial<Pick<Message, 'text' | 'edited' | 'deleted' | 'status' | 'transcript' | 'reactions' | 'attachments' | 'translation' | 'translationFrom'>>) {
    const map: Record<string, string> = { translation: 'translation', translationFrom: 'translation_from', text: 'text', edited: 'edited', deleted: 'deleted', status: 'status', transcript: 'transcript', reactions: 'reactions', attachments: 'attachments' };
    for (const [k, v] of Object.entries(patch)) {
      if (!map[k]) continue;
      const val = typeof v === 'boolean' ? Number(v) : Array.isArray(v) ? JSON.stringify(v) : v;
      this.db.prepare(`UPDATE messages SET ${map[k]}=? WHERE id=?`).run(val, id);
    }
    return this.getMessage(id);
  }
  listMessages(chatId: string, beforeTs?: number, limit = 60): Message[] {
    const rows = beforeTs
      ? this.db.prepare('SELECT * FROM messages WHERE chat_id=? AND ts<? ORDER BY ts DESC LIMIT ?').all(chatId, beforeTs, limit)
      : this.db.prepare('SELECT * FROM messages WHERE chat_id=? ORDER BY ts DESC LIMIT ?').all(chatId, limit);
    return rows.map((r) => this.rowToMsg(r)).reverse();
  }
  oldestMessage(chatId: string): Message | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE chat_id=? ORDER BY ts ASC LIMIT 1').get(chatId);
    return r ? this.rowToMsg(r) : null;
  }
  /** Volltextsuche über Text, Abschrift, Übersetzung und Dateinamen; optional nur bestimmte Chats */
  search(q: string, limit = 50, chatIds?: string[], beforeTs?: number): Message[] {
    const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const inChats = chatIds ? `AND chat_id IN (${chatIds.map(() => '?').join(',') || "''"})` : '';
    return this.db.prepare(`SELECT * FROM messages WHERE deleted=0 ${inChats} ${beforeTs ? 'AND ts<?' : ''}
      AND (text LIKE ? ESCAPE '\\' OR transcript LIKE ? ESCAPE '\\' OR translation LIKE ? ESCAPE '\\' OR attachments LIKE ? ESCAPE '\\')
      ORDER BY ts DESC LIMIT ?`).all(...([...(chatIds ?? []), ...(beforeTs ? [beforeTs] : []), like, like, like, like, limit] as unknown[])).map((r) => this.rowToMsg(r))
      // Dateinamen: nur echte Treffer im Namen, nicht in Typ/IDs
      .filter((m) => [m.text, m.transcript, m.translation].some((t) => t?.toLowerCase().includes(q.toLowerCase())) || m.attachments.some((a) => a.name?.toLowerCase().includes(q.toLowerCase())));
  }
  /** Galerie: Bilder/Videos, Dateien, Sprachnachrichten oder Links, neueste zuerst */
  media(kind: 'media' | 'files' | 'voice' | 'links', chatIds: string[] | null, beforeTs: number | undefined, limit: number): Message[] {
    const cond = {
      media: `(attachments LIKE '%"kind":"image"%' OR attachments LIKE '%"kind":"video"%')`,
      files: `(attachments LIKE '%"kind":"file"%' OR attachments LIKE '%"kind":"audio"%')`,
      voice: `attachments LIKE '%"kind":"voice"%'`,
      links: `(text LIKE '%http://%' OR text LIKE '%https://%' OR text LIKE '%www.%')`,
    }[kind];
    const inChats = chatIds ? `AND chat_id IN (${chatIds.map(() => '?').join(',') || "''"})` : '';
    return this.db.prepare(`SELECT * FROM messages WHERE deleted=0 AND ${cond} ${inChats} ${beforeTs ? 'AND ts<?' : ''} ORDER BY ts DESC LIMIT ?`)
      .all(...([...(chatIds ?? []), ...(beforeTs ? [beforeTs] : []), limit] as unknown[])).map((r) => this.rowToMsg(r));
  }
  setLink(id: string, link: string | null) { this.db.prepare(link ? 'UPDATE chats SET link=? WHERE id=?' : 'UPDATE chats SET link=?, send_via=NULL WHERE id=?').run(link, id); }
  /** Zusammengeführter Kontakt: fester Messenger zum Senden (null = wo zuletzt geschrieben wurde) */
  setSendVia(link: string, via: string | null) { this.db.prepare('UPDATE chats SET send_via=? WHERE link=?').run(via, link); }
  linkedIds(link: string): string[] { return (this.db.prepare('SELECT id FROM chats WHERE link=?').all(link) as { id: string }[]).map((r) => r.id); }

  // ---------- Dateien (AES-GCM verschlüsselt) ----------
  storeFile(data: Buffer): string {
    const id = randomUUID();
    writeFileSync(join(this.filesDir, id), seal(this.dek, data));
    return id;
  }
  readFile(id: string): Buffer | null {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const p = join(this.filesDir, id);
    if (!existsSync(p)) return null;
    return open(this.dek, readFileSync(p));
  }
  deleteFile(id: string) {
    const p = join(this.filesDir, id);
    if (/^[0-9a-f-]{36}$/.test(id) && existsSync(p)) unlinkSync(p);
  }

  close() { this.db.close(); }
}

export type { Account, AccountStatus, Attachment };
