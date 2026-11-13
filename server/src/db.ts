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
    // Nur in Chorus: angepinnt (Zeitpunkt) und gemerkt (Lesezeichen), wird vom Messenger-Abgleich nie überschrieben
    if (!mcols.includes('pinned_at')) this.db.exec('ALTER TABLE messages ADD COLUMN pinned_at INTEGER');
    if (!mcols.includes('starred')) this.db.exec('ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0');
    if (!mcols.includes('summary')) this.db.exec('ALTER TABLE messages ADD COLUMN summary TEXT');
    if (!mcols.includes('expires_at')) { this.db.exec('ALTER TABLE messages ADD COLUMN expires_at INTEGER'); this.db.exec('CREATE INDEX IF NOT EXISTS messages_expiry ON messages(expires_at) WHERE expires_at IS NOT NULL'); }
    if (!mcols.includes('history')) this.db.exec('ALTER TABLE messages ADD COLUMN history TEXT');
    if (!cols.includes('autopilot')) this.db.exec('ALTER TABLE chats ADD COLUMN autopilot TEXT');
    for (const [c, t] of [['archived', 'INTEGER NOT NULL DEFAULT 0'], ['alias', 'TEXT'], ['custom_avatar', 'TEXT'], ['info', 'TEXT'], ['note', 'TEXT'], ['translate', 'TEXT'], ['link', 'TEXT'], ['send_via', 'TEXT'], ['peer', 'TEXT'], ['draft', 'TEXT'], ['draft_ts', 'INTEGER']] as const)
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
      customAvatar: !!r.custom_avatar, netTitle: r.title, alias: r.alias ?? null, archived: !!r.archived, info: r.info ? JSON.parse(r.info) : null, note: r.note ?? null, translate: r.translate ? JSON.parse(r.translate) : null, link: r.link ?? null, sendVia: r.link ? r.send_via ?? null : null, peer: r.peer ? JSON.parse(r.peer) : null, draft: r.draft || null, draftTs: r.draft_ts ?? null,
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
  listAllChats(): Chat[] {
    return this.db.prepare('SELECT c.*, a.network FROM chats c JOIN accounts a ON a.id=c.account_id').all().map((r) => this.rowToChat(r));
  }
  /** Chats/Kontakte nach Name, Alias oder Nummer suchen – auch solche ohne Nachrichten, die in listChats() wegen des Limits fehlen können */
  searchChats(q: string, limit = 100): Chat[] {
    const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
    return this.db.prepare(`SELECT c.*, a.network FROM chats c JOIN accounts a ON a.id=c.account_id
      WHERE c.title LIKE ? ESCAPE '\\' OR c.alias LIKE ? ESCAPE '\\' OR c.remote_id LIKE ? ESCAPE '\\' ORDER BY c.last_ts DESC LIMIT ?`).all(like, like, like, limit).map((r) => this.rowToChat(r));
  }
  setPinned(id: string, on: boolean) { this.db.prepare('UPDATE chats SET pinned=? WHERE id=?').run(Number(on), id); }
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
      translationFrom: r.translation_from ?? null, html: r.html ?? null, summary: r.summary ?? null, expiresAt: r.expires_at ?? null, history: r.history ? JSON.parse(r.history) : [],
      ...(r.pinned_at ? { pinnedAt: r.pinned_at } : {}), ...(r.starred ? { starred: true } : {}),
    };
  }
  /** true, wenn die Nachricht neu war */
  upsertMessage(m: Omit<Message, 'id' | 'reactions'> & { reactions?: Reaction[] }): { msg: Message; isNew: boolean } {
    const id = `${m.chatId}:${m.remoteId}`;
    const ex = this.db.prepare('SELECT id, text, deleted FROM messages WHERE id=?').get(id) as { id: string; text: string; deleted: number } | undefined;
    if (ex) {
      // Behaltene gelöschte Nachricht nicht durch einen späteren Abgleich überschreiben
      if (ex.deleted && !m.deleted) return { msg: this.getMessage(id)!, isNew: false };
      if (m.edited) this.keepVersion(id, ex.text, m.text);
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
  /** Bearbeitung: bisherigen Text als frühere Fassung merken (höchstens 20) */
  private keepVersion(id: string, oldText: string, newText: string | undefined) {
    if (newText === undefined || !oldText || oldText === newText) return;
    const r = this.db.prepare('SELECT history FROM messages WHERE id=?').get(id) as { history: string | null } | undefined;
    const h = r?.history ? JSON.parse(r.history) as { text: string; ts: number }[] : [];
    h.push({ text: oldText, ts: Date.now() });
    this.db.prepare('UPDATE messages SET history=? WHERE id=?').run(JSON.stringify(h.slice(-20)), id);
  }
  removeMessage(id: string) { this.db.prepare('DELETE FROM messages WHERE id=?').run(id); }
  /** Nachricht samt gespeicherter Anhänge endgültig löschen (selbstzerstörende Notizen) */
  purgeMessage(id: string) {
    const m = this.getMessage(id);
    if (!m) return;
    for (const a of m.attachments) if (a.fileId) this.deleteFile(a.fileId);
    this.removeMessage(id);
  }
  setExpiry(id: string, at: number | null) { this.db.prepare('UPDATE messages SET expires_at=? WHERE id=?').run(at, id); return this.getMessage(id); }
  expiredMessages(now: number): { id: string; chatId: string }[] {
    return this.db.prepare('SELECT id, chat_id AS chatId FROM messages WHERE expires_at IS NOT NULL AND expires_at<=? LIMIT 500').all(now) as { id: string; chatId: string }[];
  }
  /** Vorschau in der Chatliste nach dem Entfernen von Nachrichten neu setzen */
  resetPreview(chatId: string, text: string, ts: number) { this.db.prepare('UPDATE chats SET last_text=?, last_ts=? WHERE id=?').run(text, ts, chatId); }
  patchMessage(id: string, patch: Partial<Pick<Message, 'text' | 'edited' | 'deleted' | 'status' | 'transcript' | 'reactions' | 'attachments' | 'translation' | 'translationFrom' | 'summary'>>) {
    if (patch.edited && patch.text !== undefined) {
      const cur = this.db.prepare('SELECT text, deleted FROM messages WHERE id=?').get(id) as { text: string; deleted: number } | undefined;
      if (cur?.deleted) return this.getMessage(id);
      if (cur) this.keepVersion(id, cur.text, patch.text);
    }
    const map: Record<string, string> = { summary: 'summary', translation: 'translation', translationFrom: 'translation_from', text: 'text', edited: 'edited', deleted: 'deleted', status: 'status', transcript: 'transcript', reactions: 'reactions', attachments: 'attachments' };
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
  /** Entwurf pro Chat (geräteübergreifend). Ältere Stände (ts) werden ignoriert. true = geändert */
  setDraft(id: string, text: string, ts: number): boolean {
    const r = this.db.prepare('UPDATE chats SET draft=?, draft_ts=? WHERE id=? AND (draft_ts IS NULL OR draft_ts<?)').run(text.slice(0, 20000) || null, ts, id, ts);
    return r.changes > 0;
  }
  /** Eigene Nachricht gesendet: Entwurf löschen, wenn er dieser Nachricht entspricht (auch in verknüpften Chats).
   *  Der neue Zeitstempel liegt hinter dem alten Entwurf, damit verspätete Speicherungen ihn nicht zurückholen. */
  clearSentDraft(chatId: string, texts: (string | null | undefined)[]): string[] {
    const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
    const sent = texts.filter((t): t is string => !!t?.trim()).map(norm);
    if (!sent.length) return [];
    const link = (this.db.prepare('SELECT link FROM chats WHERE id=?').get(chatId) as { link: string | null } | undefined)?.link;
    const rows = this.db.prepare(`SELECT id, draft, draft_ts FROM chats WHERE (id=? ${link ? 'OR link=?' : ''}) AND draft IS NOT NULL`)
      .all(...(link ? [chatId, link] : [chatId])) as { id: string; draft: string; draft_ts: number | null }[];
    const done: string[] = [];
    for (const r of rows) {
      const d = norm(r.draft);
      if (d && !sent.some((t) => t === d || t.includes(d))) continue;
      this.db.prepare('UPDATE chats SET draft=NULL, draft_ts=? WHERE id=?').run(Math.max(Date.now(), (r.draft_ts ?? 0) + 1), r.id);
      done.push(r.id);
    }
    return done;
  }
  /** Alte Geister-Entwürfe: Entwurf steht schon als eigene Nachricht im Chat */
  clearGhostDrafts(): number {
    const rows = this.db.prepare('SELECT id FROM chats WHERE draft IS NOT NULL').all() as { id: string }[];
    let n = 0;
    for (const r of rows) {
      const own = (this.db.prepare('SELECT text FROM messages WHERE chat_id=? AND from_me=1 AND deleted=0 ORDER BY ts DESC LIMIT 30').all(r.id) as { text: string }[]).map((m) => m.text);
      n += this.clearSentDraft(r.id, own).filter((id) => id === r.id).length;
    }
    return n;
  }
  /** Anpinnen/Merken (nur in Chorus) */
  markMessage(id: string, patch: { pinned?: boolean; starred?: boolean }): Message | null {
    if (patch.pinned !== undefined) this.db.prepare('UPDATE messages SET pinned_at=? WHERE id=?').run(patch.pinned ? Date.now() : null, id);
    if (patch.starred !== undefined) this.db.prepare('UPDATE messages SET starred=? WHERE id=?').run(Number(patch.starred), id);
    return this.getMessage(id);
  }
  pinnedMessages(chatIds: string[]): Message[] {
    if (!chatIds.length) return [];
    return this.db.prepare(`SELECT * FROM messages WHERE pinned_at IS NOT NULL AND deleted=0 AND chat_id IN (${chatIds.map(() => '?').join(',')}) ORDER BY pinned_at DESC LIMIT 50`)
      .all(...chatIds).map((r) => this.rowToMsg(r));
  }
  /** Galerie: Bilder/Videos, Dateien, Sprachnachrichten, Links oder Gemerktes, neueste zuerst */
  media(kind: 'media' | 'files' | 'voice' | 'links' | 'starred', chatIds: string[] | null, beforeTs: number | undefined, limit: number): Message[] {
    const cond = {
      media: `(attachments LIKE '%"kind":"image"%' OR attachments LIKE '%"kind":"video"%')`,
      files: `(attachments LIKE '%"kind":"file"%' OR attachments LIKE '%"kind":"audio"%')`,
      voice: `attachments LIKE '%"kind":"voice"%'`,
      links: `(text LIKE '%http://%' OR text LIKE '%https://%' OR text LIKE '%www.%')`,
      starred: 'starred=1',
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
    if (/^[0-9a-f-]{36}$/.test(id) && existsSync(p + '.thumb')) unlinkSync(p + '.thumb');
  }
  /** Vorschaubild (?thumb=1) neben der Originaldatei, damit es nach einem Server-Neustart nicht neu erzeugt werden muss */
  readThumb(id: string): Buffer | null {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const p = join(this.filesDir, id + '.thumb');
    if (!existsSync(p)) return null;
    try { return open(this.dek, readFileSync(p)); } catch { return null; }
  }
  storeThumb(id: string, data: Buffer) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return;
    const p = join(this.filesDir, id + '.thumb');
    if (!existsSync(p)) writeFileSync(p, seal(this.dek, data));
  }

  close() { this.db.close(); }
}

export type { Account, AccountStatus, Attachment };
