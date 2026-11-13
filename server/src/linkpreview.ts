import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Link-Vorschau (Titel, Beschreibung, Bild) für die Links-Ansicht der Galerie.
 * Der Server holt die Seite selbst, damit der Browser nicht jede Seite beim bloßen Ansehen der Liste kontaktiert.
 * Nur öffentliche Adressen (kein LAN, kein localhost), wenige Weiterleitungen, kleine Antworten, Zwischenspeicher im Speicher.
 */
export interface LinkPreview { url: string; title: string | null; description: string | null; image: string | null; site: string | null }

const cache = new Map<string, { at: number; p: LinkPreview | null }>();
const imgCache = new Map<string, { at: number; mime: string; data: Buffer }>();
const TTL = 6 * 3600_000;
const UA = 'Mozilla/5.0 (compatible; ChorusLinkPreview/1.0)';

function privateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('64:ff9b');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

async function assertPublic(u: URL) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Nur http(s)');
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) throw new Error('Port nicht erlaubt');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.local$|\.internal$|\.lan$|\.home$/i.test(host)) throw new Error('Private Adresse');
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length || ips.some(privateIp)) throw new Error('Private Adresse');
}

/** Holt eine öffentliche URL mit Größenlimit; folgt bis zu 3 Weiterleitungen (jede geprüft) */
async function safeFetch(raw: string, accept: string, maxBytes: number): Promise<{ url: string; mime: string; data: Buffer }> {
  let url = new URL(raw);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url);
    const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA, accept, 'accept-language': 'de,en;q=0.8' }, signal: AbortSignal.timeout(6000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location')!, url); continue; }
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    const mime = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const chunks: Buffer[] = []; let n = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value)); n += value.length;
      if (n >= maxBytes) { void reader.cancel(); break; }
    }
    return { url: url.toString(), mime, data: Buffer.concat(chunks) };
  }
  throw new Error('Zu viele Weiterleitungen');
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m);
const clean = (s: string | undefined | null, max: number) => { const t = s ? decode(s).replace(/\s+/g, ' ').trim() : ''; return t ? t.slice(0, max) : null; };

export function parseMeta(html: string, base: string): Omit<LinkPreview, 'url'> {
  const head = html.slice(0, 200_000);
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (n: string) => tag.match(new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(2).find((x) => x != null);
    const k = (attr('property') ?? attr('name') ?? '').toLowerCase();
    const v = attr('content');
    if (k && v != null && !meta.has(k)) meta.set(k, v);
  }
  const title = meta.get('og:title') ?? meta.get('twitter:title') ?? head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const desc = meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description');
  let image = meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image') ?? meta.get('twitter:image:src') ?? null;
  try { image = image ? new URL(decode(image), base).toString() : null; } catch { image = null; }
  if (image && !/^https?:/i.test(image)) image = null;
  return { title: clean(title, 200), description: clean(desc, 300), image, site: clean(meta.get('og:site_name'), 80) };
}

export async function linkPreview(raw: string): Promise<LinkPreview | null> {
  const hit = cache.get(raw);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  let p: LinkPreview | null = null;
  try {
    const r = await safeFetch(raw, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 400_000);
    if (r.mime.startsWith('image/')) p = { url: r.url, title: null, description: null, image: r.url, site: null };
    else if (!r.mime || r.mime.includes('html')) p = { url: r.url, ...parseMeta(r.data.toString('utf8'), r.url) };
  } catch { p = null; }
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  cache.set(raw, { at: Date.now(), p });
  return p;
}

/** Vorschaubild über den Server laden (Privatsphäre: Fremdseite sieht nur den Server) */
export async function previewImage(raw: string): Promise<{ mime: string; data: Buffer } | null> {
  const hit = imgCache.get(raw);
  if (hit && Date.now() - hit.at < TTL) return hit;
  try {
    const r = await safeFetch(raw, 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8', 3_000_000);
    if (!/^image\/(png|jpe?g|gif|webp|avif)$/.test(r.mime) || r.data.length >= 3_000_000) return null;
    const v = { at: Date.now(), mime: r.mime, data: r.data };
    let total = 0; for (const x of imgCache.values()) total += x.data.length;
    while (total > 60_000_000 && imgCache.size) { const k = imgCache.keys().next().value!; total -= imgCache.get(k)!.data.length; imgCache.delete(k); }
    imgCache.set(raw, v);
    return v;
  } catch { return null; }
}
