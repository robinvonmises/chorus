import type { Store } from './db.js';

/** Speicherziele (Immich für Fotos/Videos, Nextcloud per WebDAV für Dateien), verschlüsselt im Tresor (Tabelle settings) */
export interface StorageSettings {
  immich: { enabled: boolean; url: string; key: string };
  nextcloud: { enabled: boolean; url: string; user: string; pass: string; folder: string };
}
const DEFAULTS: StorageSettings = {
  immich: { enabled: false, url: '', key: '' },
  nextcloud: { enabled: false, url: '', user: '', pass: '', folder: 'Chorus' },
};

/** Öffentliche Sicht: Schlüssel und Passwörter verlassen den Server nie */
export interface StoragePublic {
  immich: { enabled: boolean; url: string; hasKey: boolean };
  nextcloud: { enabled: boolean; url: string; user: string; hasPass: boolean; folder: string };
}
export type Target = 'immich' | 'nextcloud';
export class StorageError extends Error { constructor(public statusCode: number, msg: string) { super(msg); } }

/** Basis-URL ohne abschließenden Schrägstrich; bei Immich auch ohne „/api“ (wird oft mitkopiert) */
export function baseUrl(u: string, stripApi = false) {
  let s = u.trim().replace(/\/+$/, '');
  if (stripApi) s = s.replace(/\/api$/i, '');
  if (s && !/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s;
}
/** Ordnerpfad in einzelne, sichere Teile zerlegen (kein „..“) */
export function folderParts(f: string) {
  return f.split('/').map((p) => p.trim()).filter((p) => p && p !== '.' && p !== '..');
}
/** „foto.jpg“ → „foto (2).jpg“ */
export function numbered(name: string, n: number) {
  if (n < 2) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

const TIMEOUT = 120_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Storage {
  constructor(private store: Store) {}

  get settings(): StorageSettings {
    const s = this.store.getSetting<Partial<StorageSettings>>('storage', {});
    return { immich: { ...DEFAULTS.immich, ...s.immich }, nextcloud: { ...DEFAULTS.nextcloud, ...s.nextcloud } };
  }

  publicSettings(): StoragePublic {
    const { immich: i, nextcloud: n } = this.settings;
    return {
      immich: { enabled: i.enabled && !!i.url && !!i.key, url: i.url, hasKey: !!i.key },
      nextcloud: { enabled: n.enabled && !!n.url && !!n.user && !!n.pass, url: n.url, user: n.user, hasPass: !!n.pass, folder: n.folder },
    };
  }

  /** Leere Zeichenkette bei Schlüssel/Passwort = unverändert lassen, null = löschen */
  update(patch: { immich?: Record<string, unknown>; nextcloud?: Record<string, unknown> }) {
    const cur = this.settings;
    const str = (v: unknown) => (v == null ? '' : String(v).trim());
    if (patch.immich) {
      const p = patch.immich, i = cur.immich;
      if ('enabled' in p) i.enabled = !!p.enabled;
      if ('url' in p) i.url = baseUrl(str(p.url), true);
      if ('key' in p && p.key !== '') i.key = str(p.key);
    }
    if (patch.nextcloud) {
      const p = patch.nextcloud, n = cur.nextcloud;
      if ('enabled' in p) n.enabled = !!p.enabled;
      if ('url' in p) n.url = baseUrl(str(p.url));
      if ('user' in p) n.user = str(p.user);
      if ('pass' in p && p.pass !== '') n.pass = str(p.pass);
      if ('folder' in p) n.folder = folderParts(str(p.folder)).join('/'); // leer = oberster Ordner
    }
    this.store.setSetting('storage', cur);
    return this.publicSettings();
  }

  /** Zugang prüfen, ohne etwas hochzuladen */
  async test(target: Target): Promise<string> {
    if (target === 'immich') {
      const { url, key } = this.settings.immich;
      if (!url || !key) throw new StorageError(400, 'Adresse und API-Schlüssel fehlen');
      const r = await this.call(`${url}/api/users/me`, { headers: { 'x-api-key': key, Accept: 'application/json' } }, 'Immich');
      if (r.status === 401) throw new StorageError(400, 'Immich lehnt den API-Schlüssel ab');
      // Schlüssel nur mit „asset.upload“-Recht: /users/me ist verboten, Hochladen geht trotzdem
      if (r.status === 403) return 'Verbunden (Schlüssel mit eingeschränkten Rechten)';
      if (!r.ok) throw new StorageError(502, `Immich antwortet mit ${r.status}`);
      const me = await r.json().catch(() => ({})) as { name?: string; email?: string };
      return `Verbunden als ${me.name || me.email || 'Immich-Nutzer'}`;
    }
    const n = this.settings.nextcloud;
    if (!n.url || !n.user || !n.pass) throw new StorageError(400, 'Adresse, Nutzer und App-Passwort fehlen');
    const r = await this.call(this.davUrl([]), { method: 'PROPFIND', headers: { ...this.davAuth(), Depth: '0' } }, 'Nextcloud');
    if (r.status === 401) throw new StorageError(400, 'Nextcloud lehnt Nutzer oder App-Passwort ab');
    if (r.status !== 207 && !r.ok) throw new StorageError(502, `Nextcloud antwortet mit ${r.status}`);
    return `Verbunden als ${n.user}`;
  }

  /** Inhalt eines Nextcloud-Ordners (Pfad relativ zum Benutzerordner), Ordner zuerst */
  async list(path: string): Promise<{ path: string; folders: string[]; files: { name: string; size: number; mime: string; modified: number }[] }> {
    this.ncReady();
    const parts = folderParts(path);
    const r = await this.call(this.davUrl(parts), {
      method: 'PROPFIND', headers: { ...this.davAuth(), Depth: '1', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/></d:prop></d:propfind>',
    }, 'Nextcloud');
    if (r.status === 401) throw new StorageError(400, 'Nextcloud lehnt Nutzer oder App-Passwort ab');
    if (r.status === 404) throw new StorageError(404, 'Ordner nicht gefunden');
    if (r.status !== 207) throw new StorageError(502, `Nextcloud: ${await errText(r)}`);
    const entries = parsePropfind(await r.text());
    entries.shift(); // erster Eintrag = der Ordner selbst
    const folders = entries.filter((e) => e.dir).map((e) => e.name).sort((a, b) => a.localeCompare(b, 'de'));
    const files = entries.filter((e) => !e.dir).map(({ name, size, mime, modified }) => ({ name, size, mime, modified })).sort((a, b) => a.name.localeCompare(b.name, 'de'));
    return { path: parts.join('/'), folders, files };
  }
  async mkdir(path: string) {
    this.ncReady();
    const parts = folderParts(path);
    if (!parts.length) throw new StorageError(400, 'Kein Ordnername');
    const r = await this.call(this.davUrl(parts), { method: 'MKCOL', headers: this.davAuth() }, 'Nextcloud');
    if (r.status === 405) throw new StorageError(409, 'Den Ordner gibt es schon');
    if (!r.ok) throw new StorageError(502, `Nextcloud: Ordner ließ sich nicht anlegen (${r.status})`);
    return { path: parts.join('/') };
  }
  /** Datei aus Nextcloud holen (zum Verschicken als Anhang) */
  async read(path: string, max = 100 * 1024 * 1024): Promise<{ data: Buffer; name: string; mime: string }> {
    this.ncReady();
    const parts = folderParts(path);
    if (!parts.length) throw new StorageError(400, 'Keine Datei');
    const r = await this.call(this.davUrl(parts), { headers: this.davAuth() }, 'Nextcloud');
    if (r.status === 404) throw new StorageError(404, 'Datei nicht gefunden');
    if (!r.ok) throw new StorageError(502, `Nextcloud: ${await errText(r)}`);
    if (Number(r.headers.get('content-length') ?? 0) > max) throw new StorageError(413, 'Datei ist zu groß (max. 100 MB)');
    const data = Buffer.from(await r.arrayBuffer());
    if (data.length > max) throw new StorageError(413, 'Datei ist zu groß (max. 100 MB)');
    return { data, name: parts[parts.length - 1], mime: (r.headers.get('content-type') ?? 'application/octet-stream').split(';')[0] };
  }

  async save(target: Target, file: { data: Buffer; name: string; mime: string; ts: number; id: string; durationSec?: number; folder?: string }): Promise<string> {
    return target === 'immich' ? this.toImmich(file) : this.toNextcloud(file);
  }

  // ---------- Immich ----------
  private async toImmich(f: { data: Buffer; name: string; mime: string; ts: number; id: string; durationSec?: number }) {
    const { url, key } = this.settings.immich;
    if (!url || !key) throw new StorageError(400, 'Immich ist nicht eingerichtet');
    const when = new Date(f.ts || Date.now()).toISOString();
    const form = new FormData();
    form.append('deviceAssetId', `chorus-${f.id}`.slice(0, 200));
    form.append('deviceId', 'Chorus');
    form.append('fileCreatedAt', when);
    form.append('fileModifiedAt', when);
    form.append('filename', f.name);
    if (f.durationSec) form.append('duration', durationStr(f.durationSec));
    form.append('assetData', new Blob([new Uint8Array(f.data)], { type: f.mime || 'application/octet-stream' }), f.name);
    const r = await this.call(`${url}/api/assets`, { method: 'POST', headers: { 'x-api-key': key, Accept: 'application/json' }, body: form }, 'Immich');
    if (r.status === 401 || r.status === 403) throw new StorageError(400, 'Immich lehnt den API-Schlüssel ab (Recht „asset.upload“ nötig)');
    if (!r.ok) throw new StorageError(502, `Immich: ${await errText(r)}`);
    const j = await r.json().catch(() => ({})) as { status?: string };
    return j.status === 'duplicate' ? 'Schon in Immich' : 'In Immich gespeichert';
  }

  /** Fotos/Videos aus Immich zum Anhängen: neueste zuerst, optional Album oder Suche (Smart-Suche braucht Immichs ML) */
  async immichAssets(o: { page?: number; album?: string; q?: string; size?: number }) {
    const { url, key } = this.immichReady();
    const page = Math.max(1, Math.floor(o.page ?? 1)), size = Math.min(200, o.size ?? 120);
    const base: Record<string, unknown> = { page, size, withExif: false };
    if (o.album) { if (!UUID.test(o.album)) throw new StorageError(400, 'Ungültiges Album'); base.albumIds = [o.album]; }
    const q = o.q?.trim();
    const r = await this.immichJson(url, key, q ? '/api/search/smart' : '/api/search/metadata', { method: 'POST', body: JSON.stringify(q ? { ...base, query: q } : { ...base, order: 'desc' }) });
    const a = (r as any)?.assets ?? {};
    const items = ((a.items ?? []) as any[]).filter((x) => x.type === 'IMAGE' || x.type === 'VIDEO').map((x) => ({
      id: String(x.id), video: x.type === 'VIDEO', name: String(x.originalFileName ?? ''), taken: Date.parse(x.localDateTime ?? x.fileCreatedAt ?? '') || 0,
      duration: typeof x.duration === 'string' && x.duration !== '0:00:00.00000' ? x.duration.replace(/\.\d+$/, '').replace(/^0:/, '') : '',
    }));
    return { items, next: a.nextPage ? page + 1 : null };
  }
  async immichAlbums() {
    const { url, key } = this.immichReady();
    const own = await this.immichJson(url, key, '/api/albums') as any[];
    const shared = await this.immichJson(url, key, '/api/albums?shared=true').catch(() => []) as any[];
    const seen = new Set<string>();
    return [...own, ...shared].filter((x) => x?.id && !seen.has(x.id) && seen.add(x.id)).map((x) => ({
      id: String(x.id), name: String(x.albumName ?? 'Album'), count: Number(x.assetCount ?? 0), cover: x.albumThumbnailAssetId ? String(x.albumThumbnailAssetId) : null,
      updated: Date.parse(x.lastModifiedAssetTimestamp ?? x.updatedAt ?? '') || 0,
    })).sort((a, b) => b.updated - a.updated);
  }
  /** Vorschaubild (klein) oder Original eines Immich-Fotos */
  async immichFile(id: string, kind: 'thumb' | 'preview' | 'fullsize' | 'original' | 'send', max = 200 * 1024 * 1024): Promise<{ data: Buffer; mime: string; name: string }> {
    if (kind === 'send') {
      // HEIC/HEIF verstehen viele Empfänger nicht: dann Immichs JPEG in voller Größe (ältere Immich: große Vorschau)
      const o = await this.immichFile(id, 'original', max);
      if (!/^image\/hei[cf]/i.test(o.mime)) return o;
      const jpg = await this.immichFile(id, 'fullsize', max).catch(() => this.immichFile(id, 'preview', max)).catch(() => null);
      return jpg ? { ...jpg, name: o.name.replace(/\.hei[cf]$/i, '') + '.jpg', mime: 'image/jpeg' } : o;
    }
    const { url, key } = this.immichReady();
    if (!UUID.test(id)) throw new StorageError(400, 'Ungültige Kennung');
    const path = kind === 'original' ? `/api/assets/${id}/original` : `/api/assets/${id}/thumbnail?size=${kind === 'thumb' ? 'thumbnail' : kind}`;
    const r = await this.call(url + path, { headers: { 'x-api-key': key } }, 'Immich');
    if (r.status === 401 || r.status === 403) throw new StorageError(400, 'Immich verweigert den Zugriff (Schlüssel braucht „asset.read“, „asset.view“ und „asset.download“)');
    if (r.status === 404 || r.status === 400) throw new StorageError(404, 'Foto nicht gefunden');
    if (!r.ok) throw new StorageError(502, `Immich: ${await errText(r)}`);
    if (kind !== 'original' && !/^image\//i.test(r.headers.get('content-type') ?? '')) throw new StorageError(502, 'Immich liefert kein Bild');
    if (Number(r.headers.get('content-length') ?? 0) > max) throw new StorageError(413, 'Datei ist zu groß');
    const data = Buffer.from(await r.arrayBuffer());
    const cd = r.headers.get('content-disposition') ?? '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) ?? cd.match(/filename="?([^";]+)"?/i);
    let name = m ? m[1] : `${id}`;
    try { name = decodeURIComponent(name); } catch { /* so lassen */ }
    return { data, mime: (r.headers.get('content-type') ?? 'application/octet-stream').split(';')[0], name };
  }
  private immichReady() {
    if (!this.publicSettings().immich.enabled) throw new StorageError(400, 'Immich ist nicht eingerichtet');
    return this.settings.immich;
  }
  private async immichJson(url: string, key: string, path: string, init: RequestInit = {}) {
    const r = await this.call(url + path, { ...init, headers: { 'x-api-key': key, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } }, 'Immich');
    if (r.status === 401 || r.status === 403) throw new StorageError(400, 'Immich verweigert den Zugriff. Der API-Schlüssel braucht zum Durchsuchen zusätzlich „asset.read“, „asset.view“, „asset.download“ und „album.read“');
    if (!r.ok) throw new StorageError(502, `Immich: ${await errText(r)}`);
    return r.json();
  }

  // ---------- Nextcloud (WebDAV) ----------
  private davAuth() {
    const { user, pass } = this.settings.nextcloud;
    return { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') };
  }
  private davUrl(parts: string[]) {
    const { url, user } = this.settings.nextcloud;
    return `${url}/remote.php/dav/files/${encodeURIComponent(user)}/${parts.map(encodeURIComponent).join('/')}`;
  }
  private ncReady() {
    if (!this.publicSettings().nextcloud.enabled) throw new StorageError(400, 'Nextcloud ist nicht eingerichtet');
  }
  private async toNextcloud(f: { data: Buffer; name: string; mime: string; folder?: string }) {
    this.ncReady();
    const dir = folderParts(f.folder ?? this.settings.nextcloud.folder);
    // Ordner Stück für Stück anlegen (405 = gibt es schon)
    for (let k = 1; k <= dir.length; k++) {
      const r = await this.call(this.davUrl(dir.slice(0, k)), { method: 'MKCOL', headers: this.davAuth() }, 'Nextcloud');
      if (r.status === 401) throw new StorageError(400, 'Nextcloud lehnt Nutzer oder App-Passwort ab');
      if (!r.ok && r.status !== 405) throw new StorageError(502, `Nextcloud: Ordner ließ sich nicht anlegen (${r.status})`);
    }
    const safe = f.name.replace(/[\\/]/g, '_').trim() || 'Datei';
    // Nichts überschreiben: If-None-Match: * → 412, wenn der Name schon belegt ist
    for (let i = 1; i <= 50; i++) {
      const name = numbered(safe, i);
      const r = await this.call(this.davUrl([...dir, name]), {
        method: 'PUT', headers: { ...this.davAuth(), 'Content-Type': f.mime || 'application/octet-stream', 'If-None-Match': '*' }, body: new Uint8Array(f.data),
      }, 'Nextcloud');
      if (r.status === 412) continue;
      if (r.status === 401) throw new StorageError(400, 'Nextcloud lehnt Nutzer oder App-Passwort ab');
      if (!r.ok) throw new StorageError(502, `Nextcloud: ${await errText(r)}`);
      return `In Nextcloud gespeichert (${[...dir, name].join('/')})`;
    }
    throw new StorageError(409, 'Nextcloud: zu viele Dateien mit diesem Namen');
  }

  private async call(url: string, init: RequestInit, who: string) {
    try { return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) }); }
    catch (e: any) { throw new StorageError(502, `${who} nicht erreichbar: ${e?.cause?.code ?? e?.message ?? e}`); }
  }
}

function durationStr(sec: number) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}
async function errText(r: Response) {
  const t = await r.text().catch(() => '');
  try { const j = JSON.parse(t); return String(j.message ?? j.error ?? r.status); } catch { return `${r.status} ${t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140)}`; }
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** Schlanker PROPFIND-Leser: Namensraum-Präfixe (d:, D:, ohne) egal */
export function parsePropfind(xml: string) {
  const out: { name: string; dir: boolean; size: number; mime: string; modified: number }[] = [];
  for (const m of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
    const body = m[1];
    const tag = (t: string) => body.match(new RegExp(`<(?:[\\w-]+:)?${t}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${t}>`, 'i'))?.[1]?.trim() ?? '';
    const href = unxml(tag('href')).replace(/\/+$/, '');
    let name = href.slice(href.lastIndexOf('/') + 1);
    try { name = decodeURIComponent(name); } catch { /* so lassen */ }
    const dir = /<(?:[\w-]+:)?collection\b/i.test(body);
    const t = Date.parse(tag('getlastmodified'));
    out.push({ name, dir, size: Number(tag('getcontentlength')) || 0, mime: tag('getcontenttype') || '', modified: Number.isFinite(t) ? t : 0 });
  }
  return out;
}
