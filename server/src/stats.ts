import type { Store } from './db.js';
import type { Chat, Network } from './types.js';

export interface StatsContact { key: string; title: string; avatar: string | null; networks: Network[]; kind: Chat['kind']; sent: number; received: number; chatId: string }
export interface Stats {
  year: number | null; years: number[];
  sent: number; received: number; words: number; chats: number;
  voice: number; photos: number;
  /** Median der eigenen Antwortzeit in Sekunden (Einzelchats, Antworten innerhalb von 24 h); null = zu wenig Daten */
  replyMedian: number | null; replyCount: number;
  /** Wie schnell andere dir antworten */
  theirMedian: number | null;
  top: StatsContact[]; groups: StatsContact[];
  networks: { network: Network; count: number }[];
  hours: number[]; weekdays: number[];
  busiestDay: { day: string; count: number } | null;
  emojis: { emoji: string; count: number }[];
}

const EMOJI = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu;
const median = (a: number[]) => { if (a.length < 3) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.floor(s.length / 2)] / 1000); };

/** Statistik über die gespeicherten Nachrichten (ohne Notizen an mich). year = null: alles */
export function computeStats(store: Store, year: number | null, tzOffsetMin = 0): Stats {
  const db = store.db;
  const from = year ? Date.UTC(year, 0, 1) + tzOffsetMin * 60_000 : 0;
  const to = year ? Date.UTC(year + 1, 0, 1) + tzOffsetMin * 60_000 : 8.64e15;
  const chats = new Map(store.listAllChats().map((c) => [c.id, c]));
  const range = db.prepare(`SELECT MIN(m.ts) AS a FROM messages m JOIN chats c ON c.id=m.chat_id JOIN accounts x ON x.id=c.account_id WHERE x.network<>'notes' AND m.ts>0`).get() as { a: number | null };
  const nowY = new Date().getFullYear();
  const firstY = range.a ? Math.max(2000, new Date(range.a).getFullYear()) : nowY;
  const years = Array.from({ length: nowY - firstY + 1 }, (_, i) => nowY - i);

  const st: Stats = { year, years, sent: 0, received: 0, words: 0, chats: 0, voice: 0, photos: 0, replyMedian: null, replyCount: 0, theirMedian: null, top: [], groups: [], networks: [], hours: Array(24).fill(0), weekdays: Array(7).fill(0), busiestDay: null, emojis: [] };
  const people = new Map<string, StatsContact>();
  const nets = new Map<Network, number>();
  const days = new Map<string, number>();
  const emo = new Map<string, number>();
  const mine: number[] = [], theirs: number[] = [];
  const active = new Set<string>();
  let curChat = '', turnStart = 0, turnMine = false, lastTs = 0;

  const rows = db.prepare(`SELECT m.chat_id AS c, m.from_me AS me, m.ts AS ts,
      CASE WHEN m.from_me=1 THEN substr(m.text,1,4000) ELSE '' END AS text,
      CASE WHEN m.attachments LIKE '%"kind":"voice"%' THEN 1 WHEN m.attachments LIKE '%"kind":"image"%' THEN 2 ELSE 0 END AS att
    FROM messages m WHERE m.deleted=0 AND m.ts>=? AND m.ts<? AND m.remote_id NOT LIKE 'local-%' ORDER BY m.chat_id, m.ts`).iterate(from, to) as Iterable<{ c: string; me: number; ts: number; text: string; att: number }>;
  for (const r of rows) {
    const chat = chats.get(r.c);
    if (!chat || chat.network === 'notes') continue;
    active.add(r.c);
    // Wer gehört zusammen: zusammengeführte Kontakte, bei E-Mail alle Betreffe eines Absenders
    const key = chat.link ? 'l:' + chat.link : chat.peer ? 'p:' + chat.accountId + ':' + chat.peer.id : r.c;
    let p = people.get(key);
    if (!p) people.set(key, p = { key, title: chat.peer?.name || chat.title, avatar: chat.avatar ?? null, networks: [], kind: chat.kind, sent: 0, received: 0, chatId: chat.id });
    if (!p.networks.includes(chat.network)) p.networks.push(chat.network);
    if (!p.avatar && chat.avatar) p.avatar = chat.avatar;
    if (r.me) {
      p.sent++; st.sent++;
      if (r.text) { st.words += r.text.split(/\s+/).filter(Boolean).length; for (const e of r.text.match(EMOJI) ?? []) emo.set(e, (emo.get(e) ?? 0) + 1); }
      if (r.att === 1) st.voice++; else if (r.att === 2) st.photos++;
    } else { p.received++; st.received++; }
    nets.set(chat.network, (nets.get(chat.network) ?? 0) + 1);
    const d = new Date(r.ts - tzOffsetMin * 60_000);
    st.hours[d.getUTCHours()]++;
    st.weekdays[(d.getUTCDay() + 6) % 7]++; // Montag zuerst
    const day = d.toISOString().slice(0, 10);
    days.set(day, (days.get(day) ?? 0) + 1);

    // Antwortzeiten: nur Einzelchats bei Messengern (E-Mail läuft in anderem Takt)
    if (r.c !== curChat) { curChat = r.c; turnStart = 0; lastTs = 0; }
    if (chat.kind === 'direct' && chat.network !== 'email') {
      const isMine = !!r.me;
      if (!turnStart || isMine !== turnMine) {
        if (turnStart && lastTs) {
          const gap = r.ts - lastTs; // Wartezeit seit der letzten Nachricht des anderen
          if (gap > 0 && gap < 864e5) (isMine ? mine : theirs).push(gap);
        }
        turnStart = r.ts; turnMine = isMine;
      }
      lastTs = r.ts;
    }
  }
  st.chats = active.size;
  st.replyMedian = median(mine); st.replyCount = mine.length; st.theirMedian = median(theirs);
  const all = [...people.values()].sort((a, b) => b.sent + b.received - (a.sent + a.received));
  // E-Mail-Absender nur, wenn du ihnen auch geschrieben hast (sonst landen Newsletter ganz oben)
  st.top = all.filter((p) => p.kind === 'direct' && (p.sent > 0 || !p.networks.every((n) => n === 'email'))).slice(0, 10);
  st.groups = all.filter((p) => p.kind !== 'direct').slice(0, 5);
  st.networks = [...nets].map(([network, count]) => ({ network, count })).sort((a, b) => b.count - a.count);
  const bd = [...days].sort((a, b) => b[1] - a[1])[0];
  st.busiestDay = bd ? { day: bd[0], count: bd[1] } : null;
  st.emojis = [...emo].map(([emoji, count]) => ({ emoji, count })).sort((a, b) => b.count - a.count).slice(0, 8);
  return st;
}
