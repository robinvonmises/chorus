import type { Store } from './db.js';

/** GIF-Suche über GIPHY oder KLIPY. Beide brauchen einen (kostenlosen) API-Schlüssel.
 *  Der Schlüssel liegt verschlüsselt im Tresor (Einstellung „gifs“) oder für alle Profile in
 *  CHORUS_GIF_KEY (+ CHORUS_GIF_PROVIDER=giphy|klipy). Er verlässt den Server nie. */

export type GifProvider = 'giphy' | 'klipy';
export interface GifSettings { provider: GifProvider; key: string }
export interface GifItem { id: string; title: string; preview: string; width: number; height: number }
export class GifError extends Error { constructor(public statusCode: number, msg: string) { super(msg); } }

/** Was zum Senden gebraucht wird: MP4 (WhatsApp/Telegram als Animation) und GIF (Signal, E-Mail) */
interface GifFull { mp4?: string; gif?: string; width: number; height: number }
const known = new Map<string, GifFull>();
const KNOWN_MAX = 3000;
function remember(id: string, f: GifFull) {
  if (known.size >= KNOWN_MAX) known.delete(known.keys().next().value!);
  known.set(id, f);
}

const ENV_KEY = process.env.CHORUS_GIF_KEY?.trim() || '';
const ENV_PROVIDER: GifProvider = process.env.CHORUS_GIF_PROVIDER === 'klipy' ? 'klipy' : 'giphy';

export function gifSettings(store: Store): GifSettings | null {
  const s = store.getSetting<Partial<GifSettings>>('gifs', {});
  if (s.key) return { provider: s.provider === 'klipy' ? 'klipy' : 'giphy', key: s.key };
  return ENV_KEY ? { provider: ENV_PROVIDER, key: ENV_KEY } : null;
}
export function gifPublic(store: Store) {
  const own = store.getSetting<Partial<GifSettings>>('gifs', {});
  const s = gifSettings(store);
  return { enabled: !!s, provider: s?.provider ?? (own.provider === 'klipy' ? 'klipy' : 'giphy'), own: !!own.key, server: !!ENV_KEY };
}
/** key: '' = unverändert, null = löschen */
export function setGifSettings(store: Store, p: { provider?: string; key?: string | null }) {
  const cur = store.getSetting<Partial<GifSettings>>('gifs', {});
  const next = { provider: p.provider === 'klipy' ? 'klipy' : p.provider === 'giphy' ? 'giphy' : cur.provider ?? 'giphy', key: p.key === null ? '' : p.key?.trim() || cur.key || '' };
  store.setSetting('gifs', next);
  return gifPublic(store);
}

async function getJson(url: string): Promise<any> {
  let r: Response;
  try { r = await fetch(url, { signal: AbortSignal.timeout(15_000) }); }
  catch { throw new GifError(502, 'GIF-Dienst nicht erreichbar'); }
  const j = await r.json().catch(() => null);
  if (r.status === 401 || r.status === 403 || (j && j.result === false && /key/i.test(JSON.stringify(j.errors ?? '')))) throw new GifError(400, 'GIF-Schlüssel ungültig');
  if (!r.ok || !j) throw new GifError(502, `GIF-Dienst meldet einen Fehler (${r.status})`);
  return j;
}

const num = (v: unknown) => Number(v) || 0;

/** Suche (q leer = Trends). page ab 1 */
export async function searchGifs(s: GifSettings, q: string, page: number, lang: string, user: string): Promise<{ items: GifItem[]; next: number | null }> {
  const per = 30;
  const items: GifItem[] = [];
  if (s.provider === 'giphy') {
    const base = 'https://api.giphy.com/v1/gifs/';
    const qs = new URLSearchParams({ api_key: s.key, limit: String(per), offset: String((page - 1) * per), rating: 'pg-13', bundle: 'messaging_non_clips' });
    if (q) { qs.set('q', q); qs.set('lang', lang); }
    const j = await getJson(`${base}${q ? 'search' : 'trending'}?${qs}`);
    for (const g of j.data ?? []) {
      const im = g.images ?? {};
      const prev = im.fixed_width_small?.webp || im.fixed_width_small?.url || im.fixed_width?.webp || im.fixed_width?.url;
      const o = im.original ?? {};
      const gif = (num(im.downsized?.size) && num(im.downsized?.size) < 5e6 ? im.downsized?.url : null) || im.fixed_width?.url || o.url;
      if (!g.id || !prev) continue;
      remember(`giphy:${g.id}`, { mp4: o.mp4 || im.fixed_width?.mp4, gif, width: num(o.width) || num(im.fixed_width?.width), height: num(o.height) || num(im.fixed_width?.height) });
      items.push({ id: `giphy:${g.id}`, title: g.title ?? '', preview: prev, width: num(im.fixed_width_small?.width) || 100, height: num(im.fixed_width_small?.height) || 100 });
    }
    const total = num(j.pagination?.total_count), off = num(j.pagination?.offset) + num(j.pagination?.count);
    return { items, next: items.length && off < total ? page + 1 : null };
  }
  const qs = new URLSearchParams({ page: String(page), per_page: String(per), customer_id: user, locale: lang });
  if (q) qs.set('q', q);
  const j = await getJson(`https://api.klipy.com/api/v1/${encodeURIComponent(s.key)}/gifs/${q ? 'search' : 'trending'}?${qs}`);
  const d = j.data ?? {};
  for (const g of d.data ?? []) {
    const f = g.file ?? {};
    const sm = f.sm ?? f.xs ?? f.md ?? {}, md = f.md ?? f.hd ?? sm;
    const prev = sm.webp?.url || sm.gif?.url;
    const id = g.slug || g.id;
    if (!id || !prev) continue;
    remember(`klipy:${id}`, { mp4: md.mp4?.url || f.hd?.mp4?.url, gif: md.gif?.url || sm.gif?.url, width: num(md.mp4?.width ?? md.gif?.width), height: num(md.mp4?.height ?? md.gif?.height) });
    items.push({ id: `klipy:${id}`, title: g.title ?? '', preview: prev, width: num(sm.webp?.width ?? sm.gif?.width) || 100, height: num(sm.webp?.height ?? sm.gif?.height) || 100 });
  }
  return { items, next: d.has_next ? page + 1 : null };
}

/** GIF zum Senden herunterladen: als MP4 (Animation) oder als echtes GIF */
export async function fetchGif(id: string, want: 'mp4' | 'gif'): Promise<{ data: Buffer; mime: string; name: string; width: number; height: number }> {
  const f = known.get(id);
  if (!f) throw new GifError(410, 'GIF nicht mehr verfügbar, bitte neu suchen');
  const order = want === 'mp4' ? [['mp4', f.mp4], ['gif', f.gif]] : [['gif', f.gif], ['mp4', f.mp4]];
  for (const [kind, url] of order) {
    if (!url || !/^https:\/\/[a-z0-9.-]+\.(giphy\.com|klipy\.com)\//i.test(url)) continue;
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!r?.ok) continue;
    const data = Buffer.from(await r.arrayBuffer());
    if (data.length > 15e6) continue;
    return { data, mime: kind === 'mp4' ? 'video/mp4' : 'image/gif', name: kind === 'mp4' ? 'gif.mp4' : 'animation.gif', width: f.width, height: f.height };
  }
  throw new GifError(502, 'GIF konnte nicht geladen werden');
}
