/** notes = „Notizen an mich“: eingebauter Chat nur auf dem Server, ohne Messenger */
export type Network = 'telegram' | 'signal' | 'whatsapp' | 'email' | 'demo' | 'notes';

export type AccountState =
  | 'disconnected'
  | 'connecting'
  | 'need_input' // z.B. Telefonnummer/Code/Passwort
  | 'qr' // QR-Code scannen
  | 'connected'
  | 'error';

export interface AccountStatus {
  state: AccountState;
  /** bei need_input: welches Feld */
  field?: 'phone' | 'code' | 'password' | 'api';
  /** bei qr: Inhalt des QR-Codes */
  qr?: string;
  /** Kopplungscode zum Eintippen am Handy (Alternative zum QR-Code) */
  code?: string;
  message?: string;
  /** eigene Nummer bzw. Benutzername bei diesem Messenger (wenn verbunden) */
  self?: string;
}

export interface Account {
  id: string;
  network: Network;
  label: string;
  status: AccountStatus;
  createdAt: number;
}

export interface Chat {
  id: string; // intern: `${accountId}:${remoteId}`
  accountId: string;
  network: Network;
  remoteId: string;
  title: string;
  kind: 'direct' | 'group' | 'channel';
  lastTs: number;
  lastText: string;
  unread: number;
  pinned: boolean;
  muted: boolean;
  avatarFileId?: string | null;
  /** E-Mail: Gegenüber (Adresse und Name). Die Oberfläche fasst alle Betreffe eines Absenders zu einem Kontakt zusammen */
  peer?: { id: string; name: string } | null;
  /** Bild-URL (eigenes Bild hat Vorrang vor dem vom Messenger) */
  avatar?: string | null;
  /** Name beim Messenger (title ist der angezeigte, ggf. eigener Name) */
  netTitle?: string;
  customAvatar?: boolean;
  alias?: string | null;
  archived?: boolean;
  info?: ContactInfo | null;
  note?: string | null;
  aiEnabled?: boolean;
  autopilot?: Autopilot | null;
  /** Live-Übersetzung: lang = Sprache des Chatpartners (ISO-Code), langName auf Deutsch */
  /** Verknüpfter Kontakt: Chats mit derselben link-ID gehören zu einer Person (über mehrere Messenger) */
  link?: string | null;
  /** Bei zusammengeführten Kontakten: Chat, über den gesendet wird (null = automatisch) */
  sendVia?: string | null;
  /** out = eigene Nachrichten übersetzen (Standard: ja). fixed = Sprache von Hand gewählt, nicht automatisch erkennen */
  translate?: { on: boolean; lang?: string | null; langName?: string | null; out?: boolean; fixed?: boolean } | null;
}

/** Was der Messenger über einen Kontakt oder eine Gruppe verrät */
export interface ContactInfo {
  phone?: string;
  username?: string;
  about?: string;
  description?: string;
  members?: number;
  fetchedAt?: number;
  noAvatar?: boolean;
}

/** Claude antwortet selbstständig, höchstens `max` Mal */
export interface Autopilot {
  on: boolean; max: number; used: number; note: string; mark: boolean;
  /** Gruppen: worauf reagieren. me = Frage in die Runde, Erwähnung oder Antwort auf mich; direct = nur Erwähnung oder Antwort auf mich; all = jede Nachricht (KI entscheidet) */
  trigger?: 'me' | 'direct' | 'all';
  /** Gruppen: nur auf diese Teilnehmer (senderId) reagieren; leer = alle */
  only?: string[];
  /** Eigene Bedingung, z. B. „nur wenn es um das Training geht“ */
  rule?: string;
  /** Stil: me = wie ich, short = kurz und sachlich, creative = kreativ und witzig */
  style?: 'me' | 'short' | 'creative';
}

export interface Attachment {
  /** intern, verschlüsselt gespeichert; null = noch nicht heruntergeladen (wird bei Bedarf geholt) */
  fileId: string | null;
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'video' | 'audio' | 'voice' | 'file' | 'sticker';
  durationSec?: number;
  width?: number;
  height?: number;
  /** Animation (GIF): ohne Ton in Schleife abspielen */
  gif?: boolean;
  /** Kennung beim Messenger, um den Anhang später abzuholen */
  remoteRef?: string;
}

export interface Reaction {
  emoji: string;
  senderId: string;
  senderName?: string;
  fromMe: boolean;
}

export interface Message {
  id: string; // intern: `${chatId}:${remoteId}`
  chatId: string;
  remoteId: string;
  senderId: string;
  senderName: string;
  fromMe: boolean;
  ts: number;
  text: string;
  replyToRemoteId?: string | null;
  edited: boolean;
  deleted: boolean;
  attachments: Attachment[];
  reactions: Reaction[];
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'received';
  transcript?: string | null;
  /** Sprachnachricht: Kernaussage in einem Satz (auf Knopfdruck, aus dem Transkript) */
  summary?: string | null;
  /** Eingehend: deutsche Übersetzung. Eigene: der deutsche Originaltext vor dem Übersetzen */
  translation?: string | null;
  /** Sprache des Nachrichtentexts (deutscher Name), wenn translation eine Übersetzung ins Deutsche ist.
   *  Bei eigenen, übersetzt gesendeten Nachrichten leer: dann ist translation das deutsche Original. */
  translationFrom?: string | null;
  /** Nur live bei fehlgeschlagenem Senden: Grund (wird nicht gespeichert) */
  error?: string;
  /** E-Mail: bereinigtes Original-HTML (verschlüsselt gespeichert, fileId); abrufbar über /api/messages/:id/html */
  html?: string | null;
  /** Selbstzerstörende Notiz: wird zu diesem Zeitpunkt (ms) endgültig gelöscht */
  expiresAt?: number | null;
  /** Frühere Fassungen einer bearbeiteten Nachricht (älteste zuerst; ts = wann ersetzt) */
  history?: { text: string; ts: number }[];
}

/** Ereignisse, die Adapter an die Zentrale melden */
export interface AdapterEvents {
  status(s: AccountStatus): void;
  chat(c: Omit<Chat, 'id' | 'accountId' | 'network' | 'unread' | 'pinned' | 'muted'> & { unread?: number }): void;
  message(m: Omit<Message, 'id' | 'chatId' | 'reactions'> & { chatRemoteId: string; reactions?: Reaction[] }): void;
  messageUpdate(chatRemoteId: string, remoteId: string, patch: Partial<Pick<Message, 'text' | 'edited' | 'deleted' | 'status'>>): void;
  reactions(chatRemoteId: string, remoteId: string, reactions: Reaction[]): void;
  /** Einzelne Reaktion setzen/entfernen (ersetzt vorherige Reaktion desselben Absenders) */
  reactionChange(chatRemoteId: string, remoteId: string, r: Reaction, remove: boolean): void;
  /** Jemand tippt gerade (on) oder hat aufgehört; wird nicht gespeichert, nur live weitergegeben */
  typing(chatRemoteId: string, on: boolean): void;
  /** Speichert Bytes verschlüsselt und gibt eine fileId zurück */
  storeFile(data: Buffer): string;
  /** Bereits gespeicherte Nachricht nachschlagen */
  getMessage(chatRemoteId: string, remoteId: string): Message | null;
  /** Persistente, verschlüsselte Sitzungsdaten des Adapters */
  saveSession(data: string): void;
  log(msg: string): void;
}

export interface OutgoingFile {
  data: Buffer;
  name: string;
  mime: string;
  voice?: boolean;
  /** Als GIF/Animation senden (WhatsApp gifPlayback, Telegram Animation) */
  gif?: boolean;
  durationSec?: number;
  /** Bildmaße eines Videos (vom Browser gemessen), damit der Platz im Chat freigehalten wird */
  width?: number;
  height?: number;
}

export interface Adapter {
  readonly network: Network;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Eingabe aus dem Einrichtungsassistenten (Telefonnummer, Code …) */
  input(field: string, value: string): Promise<void>;
  sendText(chatRemoteId: string, text: string, replyTo?: string | null): Promise<string>;
  sendFile(chatRemoteId: string, file: OutgoingFile, caption?: string, replyTo?: string | null): Promise<string>;
  react(chatRemoteId: string, remoteId: string, emoji: string | null): Promise<void>;
  edit(chatRemoteId: string, remoteId: string, text: string): Promise<void>;
  delete(chatRemoteId: string, remoteId: string, forEveryone: boolean): Promise<void>;
  markRead(chatRemoteId: string, remoteId: string): Promise<void>;
  loadHistory(chatRemoteId: string, beforeRemoteId?: string | null, limit?: number): Promise<void>;
  /** Lädt einen Anhang nachträglich herunter */
  fetchAttachment(chatRemoteId: string, remoteId: string, index: number, attachment?: Attachment): Promise<Buffer>;
  logout(): Promise<void>;
  /** Profil eines Chats: Nummer, Status, Bild … (so weit der Messenger es hergibt) */
  contactInfo?(chatRemoteId: string, kind: Chat['kind']): Promise<ContactInfo & { avatar?: Buffer | null }>;
  /** E-Mail: Mails eines Chats auf dem Server archivieren bzw. zurück in den Posteingang */
  archiveChat?(chatRemoteId: string, archived: boolean): Promise<void>;
  /** E-Mail: Mails eines Chats in den Papierkorb */
  deleteChat?(chatRemoteId: string): Promise<void>;
  /** Chatliste neu vom Messenger holen */
  resync?(): Promise<void>;
  /** Neuen Einzelchat über Telefonnummer (internationales Format, nur Ziffern mit +) */
  resolvePhone?(phone: string): Promise<{ remoteId: string; title: string }>;
}
