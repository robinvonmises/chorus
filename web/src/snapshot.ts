import type { Account, Chat, Message, ServerState } from './api';

/**
 * Letzter Stand der Oberfläche auf diesem Gerät (Chatliste, Konten, zuletzt geöffnete Chats).
 * iOS beendet die Web-App im Hintergrund oft. Beim nächsten Öffnen zeigen wir sofort diesen Stand
 * und gleichen im Hintergrund mit dem Server ab, statt erst das Logo und dann eine leere Liste zu zeigen.
 * Nur gespeichert, wenn „Auf diesem Gerät angemeldet bleiben“ aktiv ist (Schlüssel liegt ohnehin auf dem Gerät).
 */
export interface Snapshot {
  v: 1;
  pid: string;
  server: ServerState;
  accounts: Account[];
  chats: Chat[];
  messages: [string, Message[]][];
}

const KEY = 'inbox:snap';
const MAX_CHATS = 300;
const MAX_OPEN = 8;
const MAX_MSGS = 60;
const MAX_BYTES = 1_500_000;

export function readSnapshot(pid: string | null): Snapshot | null {
  if (!pid) return null;
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Snapshot | null;
    if (!s || s.v !== 1 || s.pid !== pid || !s.server?.profile || !Array.isArray(s.chats)) return null;
    return s;
  } catch { return null; }
}

export function clearSnapshot() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** recent = zuletzt geöffnete Chats, neueste zuerst */
export function writeSnapshot(pid: string, server: ServerState, accounts: Account[], chats: Chat[], messages: Map<string, Message[]>, recent: string[]) {
  const top = [...chats].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastTs - a.lastTs).slice(0, MAX_CHATS);
  const ids = [...new Set([...recent, ...top.slice(0, 4).map((c) => c.id)])].filter((id) => messages.get(id)?.length).slice(0, MAX_OPEN);
  const msgs: [string, Message[]][] = ids.map((id) => [id, messages.get(id)!.slice(-MAX_MSGS)]);
  for (let n = msgs.length; n >= 0; n--) {
    const json = JSON.stringify({ v: 1, pid, server, accounts, chats: top, messages: msgs.slice(0, n) } satisfies Snapshot);
    if (json.length > MAX_BYTES && n > 0) continue;
    try { localStorage.setItem(KEY, json); } catch { if (n > 0) continue; clearSnapshot(); }
    return;
  }
}
