import { crc32 } from 'node:zlib';
import type { Writable } from 'node:stream';
import { fixKind, type Hub } from './hub.js';
import type { Chat, Message } from './types.js';

/**
 * Chat-Export als ZIP: eine schöne, eigenständige HTML-Seite pro Chat plus Ordner mit allen Medien.
 * Öffnet sich in jedem Browser, ganz ohne Chorus. Gedacht als regelmäßige Sicherung.
 */

// ---------- Minimaler ZIP-Schreiber (unkomprimiert, UTF-8-Namen, ZIP64 nicht nötig bis 4 GB) ----------
class ZipWriter {
  private offset = 0;
  private entries: { name: Buffer; crc: number; size: number; offset: number; time: number; date: number }[] = [];
  constructor(private out: Writable) {}

  private write(b: Buffer): Promise<void> {
    this.offset += b.length;
    return new Promise((res, rej) => {
      if (this.out.write(b)) res();
      else { this.out.once('drain', res); this.out.once('error', rej); }
    });
  }

  async add(name: string, data: Buffer, when = new Date()) {
    if (this.offset + data.length > 0xfffff000) throw new Error('Export zu groß (über 4 GB). Bitte einzelne Chats exportieren.');
    const n = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const time = (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
    const date = ((Math.max(1980, when.getFullYear()) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26); h.writeUInt16LE(0, 28);
    this.entries.push({ name: n, crc, size: data.length, offset: this.offset, time, date });
    await this.write(Buffer.concat([h, n]));
    await this.write(data);
  }

  async finish() {
    const start = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
      c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.date, 14); c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.size, 20); c.writeUInt32LE(e.size, 24); c.writeUInt16LE(e.name.length, 28);
      c.writeUInt32LE(e.offset, 42);
      await this.write(Buffer.concat([c, e.name]));
    }
    const size = this.offset - start;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(this.entries.length, 8); end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12); end.writeUInt32LE(start, 16);
    await this.write(end);
    this.out.end();
  }
}

// ---------- HTML ----------
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const linkify = (s: string) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
const TZ = 'Europe/Berlin';
const fmtDay = (ts: number) => new Date(ts).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const NET: Record<string, string> = { whatsapp: 'WhatsApp', signal: 'Signal', telegram: 'Telegram', demo: 'Demo' };
export const slug = (s: string) => (s.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'chat');

const CSS = `
:root{--bg:#f4f5f8;--card:#fff;--in:#eef0f4;--out:#4f46e5;--out-ink:#fff;--ink:#0f172a;--ink2:#64748b;--line:#e5e7eb}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f19;--card:#111827;--in:#1f2937;--out:#4f46e5;--ink:#e5e7eb;--ink2:#94a3b8;--line:#1f2937}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{position:sticky;top:0;z-index:2;background:color-mix(in srgb,var(--card) 88%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--line);padding:14px 20px}
header h1{margin:0;font-size:19px}header p{margin:2px 0 0;color:var(--ink2);font-size:13px}header a{color:inherit}
main{max-width:820px;margin:0 auto;padding:16px 16px 60px;display:flex;flex-direction:column;gap:6px}
.day{align-self:center;margin:18px 0 8px;background:var(--card);color:var(--ink2);font-size:12px;font-weight:600;padding:4px 12px;border-radius:999px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.m{max-width:78%;display:flex;flex-direction:column}.m.in{align-self:flex-start}.m.out{align-self:flex-end;align-items:flex-end}
.b{background:var(--in);padding:8px 13px 6px;border-radius:18px;overflow-wrap:anywhere}.out .b{background:var(--out);color:var(--out-ink)}
.out .b a{color:inherit}.who{font-size:12.5px;font-weight:700;margin-bottom:2px;color:var(--ink2)}
.t{white-space:pre-wrap}.meta{font-size:11px;opacity:.65;text-align:right;margin-top:2px}
.b img,.b video{display:block;max-width:100%;max-height:420px;border-radius:12px;margin:2px 0 4px}
.b audio{display:block;width:260px;max-width:100%;margin:4px 0}
.file{display:inline-flex;gap:6px;align-items:center;padding:6px 10px;border-radius:10px;background:rgba(127,127,127,.15);color:inherit;text-decoration:none;margin:2px 0}
.gone{font-size:13px;opacity:.7;font-style:italic}.q{border-left:3px solid currentColor;padding:2px 8px;margin:0 0 6px;font-size:13px;opacity:.8;border-radius:4px;background:rgba(127,127,127,.12)}
.tr{font-size:13px;opacity:.85;margin-top:4px;padding-top:4px;border-top:1px solid rgba(127,127,127,.25)}
.r{display:flex;gap:4px;margin-top:-4px;padding:0 6px}.r span{background:var(--card);border:1px solid var(--line);border-radius:999px;font-size:12px;padding:0 6px}
.del{opacity:.6;font-style:italic}
ul.chats{list-style:none;padding:0;margin:0;display:grid;gap:8px}ul.chats a{display:flex;justify-content:space-between;gap:12px;padding:14px 16px;border-radius:14px;background:var(--card);color:inherit;text-decoration:none;border:1px solid var(--line)}
ul.chats small{color:var(--ink2)}
`;

function page(title: string, sub: string, body: string, back?: string) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<header>${back ? `<p><a href="${back}">← Alle Chats</a></p>` : ''}<h1>${esc(title)}</h1><p>${sub}</p></header>
<main>${body}</main></body></html>`;
}

async function allMessages(hub: Hub, chatId: string): Promise<Message[]> {
  const out: Message[] = [];
  let before: number | undefined;
  for (;;) {
    const batch = hub.store.listMessages(chatId, before, 500);
    if (!batch.length) break;
    out.unshift(...batch);
    if (batch.length < 500) break;
    before = batch[0].ts;
  }
  return out;
}

/** Einen Chat in das ZIP schreiben. dir = Ordner im ZIP ('' = Wurzel). Gibt Kennzahlen zurück. */
async function writeChat(zip: ZipWriter, hub: Hub, chat: Chat, dir: string, back?: string) {
  const msgs = await allMessages(hub, chat.id);
  const byRemote = new Map(msgs.map((m) => [m.remoteId, m]));
  const used = new Set<string>();
  let html = '';
  let lastDay = '';
  let media = 0, missing = 0;

  for (const m of msgs) {
    const day = fmtDay(m.ts);
    if (day !== lastDay) { html += `<div class="day">${esc(day)}</div>`; lastDay = day; }
    let inner = '';
    if (chat.kind === 'group' && !m.fromMe) inner += `<div class="who">${esc(m.senderName)}</div>`;
    if (m.replyToRemoteId) {
      const r = byRemote.get(m.replyToRemoteId);
      inner += `<div class="q">${r ? `<b>${esc(r.fromMe ? 'Du' : r.senderName)}</b>: ${esc((r.text || '[Anhang]').slice(0, 120))}` : 'Antwort auf eine ältere Nachricht'}</div>`;
    }
    if (m.deleted) inner += `<div class="del">Diese Nachricht wurde gelöscht.</div>`;
    else {
      for (let i = 0; i < m.attachments.length; i++) {
        const a = fixKind(m.attachments[i]);
        let data: Buffer | null = null;
        try { data = await Promise.race([hub.attachmentData(m, i), new Promise<null>((r) => setTimeout(() => r(null), 60_000))]); } catch { data = null; }
        if (!data) { missing++; inner += `<div class="gone">📎 ${esc(a.name)} – beim Messenger nicht mehr verfügbar</div>`; continue; }
        let name = `${new Date(m.ts).toISOString().slice(0, 10)}-${slug(a.name.replace(/\.[^.]+$/, ''))}${(a.name.match(/\.[a-z0-9]{1,5}$/i) ?? [''])[0]}`;
        for (let n = 2; used.has(name); n++) name = name.replace(/(-\d+)?(\.[^.]*)?$/, `-${n}$2`);
        used.add(name);
        await zip.add(`${dir}media/${name}`, data, new Date(m.ts));
        media++;
        const src = `media/${encodeURIComponent(name)}`;
        if (a.kind === 'image' || a.kind === 'sticker') inner += `<a href="${src}"><img src="${src}" alt="" loading="lazy"></a>`;
        else if (a.kind === 'video') inner += `<video src="${src}" controls preload="metadata"></video>`;
        else if (a.kind === 'voice' || a.kind === 'audio') inner += `<audio src="${src}" controls preload="none"></audio>`;
        else inner += `<a class="file" href="${src}" download>📄 ${esc(a.name)}</a>`;
      }
      if (m.text) inner += `<div class="t">${linkify(m.text)}</div>`;
      if (m.transcript) inner += `<div class="tr">📝 ${esc(m.transcript)}</div>`;
    }
    inner += `<div class="meta">${fmtTime(m.ts)}${m.edited && !m.deleted ? ' · bearbeitet' : ''}</div>`;
    const reacts = m.reactions.length ? `<div class="r">${[...new Set(m.reactions.map((r) => r.emoji))].map((e) => `<span>${e} ${m.reactions.filter((r) => r.emoji === e).length > 1 ? m.reactions.filter((r) => r.emoji === e).length : ''}</span>`).join('')}</div>` : '';
    html += `<div class="m ${m.fromMe ? 'out' : 'in'}"><div class="b">${inner}</div>${reacts}</div>`;
  }
  const first = msgs[0]?.ts, last = msgs[msgs.length - 1]?.ts;
  const sub = `${NET[chat.network] ?? chat.network} · ${msgs.length} Nachrichten${media ? ` · ${media} Medien` : ''}${first ? ` · ${new Date(first).toLocaleDateString('de-DE', { timeZone: TZ })} bis ${new Date(last!).toLocaleDateString('de-DE', { timeZone: TZ })}` : ''} · exportiert am ${new Date().toLocaleString('de-DE', { timeZone: TZ })}${missing ? ` · ${missing} Anhänge nicht mehr verfügbar` : ''}`;
  await zip.add(`${dir}index.html`, Buffer.from(page(chat.title, esc(sub), html || '<p>Keine Nachrichten.</p>', back)));
  return { count: msgs.length, media, first, last };
}

/** Export starten. chatIds leer = alle Chats mit Nachrichten. */
export async function exportZip(hub: Hub, out: Writable, chatIds: string[] | null) {
  const zip = new ZipWriter(out);
  const chats = (chatIds ? chatIds.map((id) => hub.store.getChat(id)).filter((c): c is Chat => !!c) : hub.store.listChats().filter((c) => c.lastTs > 0));
  if (chats.length === 1 && chatIds) {
    await writeChat(zip, hub, chats[0], '');
  } else {
    const rows: string[] = [];
    const used = new Set<string>();
    for (const c of chats.sort((a, b) => b.lastTs - a.lastTs)) {
      let s = slug(c.title);
      for (let n = 2; used.has(s); n++) s = `${slug(c.title)}-${n}`;
      used.add(s);
      const r = await writeChat(zip, hub, c, `chats/${s}/`, '../../index.html');
      if (!r.count) continue;
      rows.push(`<li><a href="chats/${encodeURIComponent(s)}/index.html"><span><b>${esc(c.title)}</b><br><small>${NET[c.network] ?? c.network} · ${r.count} Nachrichten${r.media ? ` · ${r.media} Medien` : ''}</small></span><small>${r.last ? new Date(r.last).toLocaleDateString('de-DE', { timeZone: TZ }) : ''}</small></a></li>`);
    }
    await zip.add('index.html', Buffer.from(page('Chorus – Sicherung', `${rows.length} Chats · exportiert am ${new Date().toLocaleString('de-DE', { timeZone: TZ })}`, `<ul class="chats">${rows.join('')}</ul>`)));
  }
  await zip.finish();
}
