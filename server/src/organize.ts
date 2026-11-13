import { randomUUID } from 'node:crypto';
import type { Store } from './db.js';
import { Storage, StorageError } from './storage.js';

/** Ziele für erkannte Termine, Aufgaben und Einkäufe: Nextcloud-Kalender (CalDAV), Nextcloud Tasks (VTODO), Bring! */
export interface OrganizeSettings {
  calendar: string; calendarName: string;
  /** Leer = Chorus-Erinnerung statt Nextcloud Tasks */
  tasks: string; tasksName: string;
  bring: { email: string; pass: string; list: string; listName: string };
}
const DEFAULTS: OrganizeSettings = { calendar: '', calendarName: '', tasks: '', tasksName: '', bring: { email: '', pass: '', list: '', listName: '' } };
export interface OrganizePublic {
  nextcloud: boolean; calendar: string; calendarName: string; tasks: string; tasksName: string;
  bring: { email: string; hasPass: boolean; list: string; listName: string; enabled: boolean };
}
export interface CalEvent { title: string; start: string; end: string; allDay: boolean; location: string; note?: string }
export interface Task { title: string; due: string; note?: string }

const TZ = () => process.env.TZ || 'Europe/Berlin';
const BRING = 'https://api.getbring.com/rest/';
// Öffentlich bekannter Schlüssel der Bring!-Web-/Android-App (die API ist inoffiziell)
const BRING_KEY = 'cof4Nc6D8saplXjE3h3HXqHH8m7VU2i1Gs0g85Sp';

export class Organize {
  constructor(private store: Store) {}
  private storage() { return new Storage(this.store); }

  get settings(): OrganizeSettings {
    const s = this.store.getSetting<Partial<OrganizeSettings>>('organize', {});
    return { ...DEFAULTS, ...s, bring: { ...DEFAULTS.bring, ...s.bring } };
  }
  publicSettings(): OrganizePublic {
    const s = this.settings, b = s.bring;
    return {
      nextcloud: this.storage().publicSettings().nextcloud.enabled,
      calendar: s.calendar, calendarName: s.calendarName, tasks: s.tasks, tasksName: s.tasksName,
      bring: { email: b.email, hasPass: !!b.pass, list: b.list, listName: b.listName, enabled: !!(b.email && b.pass && b.list) },
    };
  }
  /** Leeres Passwort = unverändert, null = löschen */
  update(p: Record<string, any>) {
    const cur = this.settings;
    const str = (v: unknown, n = 300) => (v == null ? '' : String(v).trim().slice(0, n));
    for (const k of ['calendar', 'calendarName', 'tasks', 'tasksName'] as const) if (k in p) cur[k] = str(p[k]);
    if ((cur.calendar && !okHref(cur.calendar)) || (cur.tasks && !okHref(cur.tasks))) throw new StorageError(400, 'Ungültiger Kalender');
    if (p.bring) {
      const b = p.bring, c = cur.bring;
      if ('email' in b && str(b.email) !== c.email) { c.email = str(b.email); this.store.setSetting('bringToken', null); }
      if ('pass' in b && b.pass !== '') { c.pass = b.pass == null ? '' : String(b.pass); this.store.setSetting('bringToken', null); }
      if ('list' in b) c.list = str(b.list, 80);
      if ('listName' in b) c.listName = str(b.listName, 80);
      if (!c.email || !c.pass) { c.list = ''; c.listName = ''; }
    }
    this.store.setSetting('organize', cur);
    return this.publicSettings();
  }

  // ---------- Nextcloud CalDAV ----------
  private nc() {
    const st = this.storage();
    if (!st.publicSettings().nextcloud.enabled) throw new StorageError(400, 'Nextcloud ist nicht eingerichtet (Einstellungen → Speicherorte).');
    const n = st.settings.nextcloud;
    return { origin: new URL(n.url).origin, base: n.url, user: n.user, auth: 'Basic ' + Buffer.from(`${n.user}:${n.pass}`).toString('base64') };
  }
  async calendars(): Promise<{ href: string; name: string; events: boolean; tasks: boolean }[]> {
    const n = this.nc();
    const r = await call(`${n.base}/remote.php/dav/calendars/${encodeURIComponent(n.user)}/`, {
      method: 'PROPFIND', headers: { Authorization: n.auth, Depth: '1', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>',
    }, 'Nextcloud');
    if (r.status === 401) throw new StorageError(400, 'Nextcloud lehnt Nutzer oder App-Passwort ab');
    if (r.status !== 207) throw new StorageError(422, `Nextcloud antwortet mit ${r.status}`);
    return parseCalendars(await r.text());
  }
  private async put(href: string, uid: string, ics: string, who: string) {
    if (!okHref(href)) throw new StorageError(400, `Bitte zuerst in den Einstellungen einen ${who} wählen.`);
    const n = this.nc();
    const r = await call(`${n.origin}${href.endsWith('/') ? href : href + '/'}${uid}.ics`, {
      method: 'PUT', headers: { Authorization: n.auth, 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' }, body: ics,
    }, 'Nextcloud');
    if (r.status === 401) throw new StorageError(400, 'Nextcloud lehnt Nutzer oder App-Passwort ab');
    if (r.status === 404) throw new StorageError(404, `Der gewählte ${who} existiert nicht mehr. Bitte in den Einstellungen neu wählen.`);
    if (!r.ok) throw new StorageError(422, `Nextcloud: Eintrag ließ sich nicht anlegen (${r.status})`);
  }
  async addEvent(e: CalEvent): Promise<string> {
    const s = this.settings;
    const uid = randomUUID();
    await this.put(s.calendar, uid, eventIcs(e, uid), 'Kalender');
    return `Im Kalender „${s.calendarName || 'Nextcloud'}“ eingetragen`;
  }
  /** true = in Nextcloud Tasks angelegt; false = keine Aufgabenliste gewählt */
  async addTask(t: Task): Promise<string | null> {
    const s = this.settings;
    if (!s.tasks) return null;
    const uid = randomUUID();
    await this.put(s.tasks, uid, todoIcs(t, uid), 'Aufgabenliste');
    return `In „${s.tasksName || 'Aufgaben'}“ angelegt`;
  }

  // ---------- Bring! (inoffizielle API) ----------
  private async bringLogin(force = false): Promise<{ uuid: string; token: string }> {
    const b = this.settings.bring;
    if (!b.email || !b.pass) throw new StorageError(400, 'Bring! ist nicht eingerichtet (Einstellungen → Speicherorte).');
    const cached = this.store.getSetting<{ uuid: string; token: string; exp: number } | null>('bringToken', null);
    if (!force && cached && cached.exp > Date.now() + 60_000) return cached;
    const r = await call(`${BRING}v2/bringauth`, { method: 'POST', headers: { ...bringHead(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: b.email, password: b.pass }).toString() }, 'Bring!');
    if (r.status === 401 || r.status === 400 || r.status === 404) throw new StorageError(400, 'Bring! lehnt E-Mail oder Passwort ab');
    if (!r.ok) throw new StorageError(422, `Bring! antwortet mit ${r.status}`);
    const j = await r.json().catch(() => ({})) as { uuid?: string; access_token?: string; expires_in?: number };
    if (!j.uuid || !j.access_token) throw new StorageError(422, 'Bring!: unerwartete Antwort beim Anmelden');
    const tok = { uuid: j.uuid, token: j.access_token, exp: Date.now() + Math.max(600, Number(j.expires_in) || 3600) * 1000 };
    this.store.setSetting('bringToken', tok);
    return tok;
  }
  private async bring(path: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await this.bringLogin(attempt > 0);
      const r = await call(BRING + path, { ...init, headers: { ...bringHead(), Authorization: `Bearer ${t.token}`, 'X-BRING-USER-UUID': t.uuid, ...(init.headers ?? {}) } }, 'Bring!');
      if (r.status === 401 && attempt === 0) continue;
      if (!r.ok) throw new StorageError(422, `Bring! antwortet mit ${r.status}`);
      return r;
    }
    throw new StorageError(400, 'Bring! lehnt die Anmeldung ab');
  }
  async bringLists(): Promise<{ id: string; name: string }[]> {
    const { uuid } = await this.bringLogin();
    const j = await (await this.bring(`bringusers/${encodeURIComponent(uuid)}/lists`)).json() as { lists?: { listUuid: string; name: string }[] };
    return (j.lists ?? []).map((l) => ({ id: String(l.listUuid), name: String(l.name ?? 'Liste') }));
  }
  async bringAdd(items: { name: string; spec: string }[]): Promise<string> {
    const b = this.settings.bring;
    if (!b.list) throw new StorageError(400, 'Bitte zuerst in den Einstellungen eine Bring!-Liste wählen.');
    const list = items.map((i) => ({ name: String(i.name ?? '').trim().slice(0, 80), spec: String(i.spec ?? '').trim().slice(0, 80) })).filter((i) => i.name).slice(0, 40);
    if (!list.length) throw new StorageError(400, 'Keine Artikel ausgewählt');
    await this.bring(`v2/bringlists/${encodeURIComponent(b.list)}/items`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: list.map((i) => ({ accuracy: '0.0', altitude: '0.0', latitude: '0.0', longitude: '0.0', itemId: i.name, spec: i.spec, uuid: randomUUID(), operation: 'TO_PURCHASE' })), sender: '' }),
    });
    return list.length === 1 ? `„${list[0].name}“ steht auf „${b.listName || 'Bring!'}“` : `${list.length} Artikel auf „${b.listName || 'Bring!'}“ gesetzt`;
  }
}

function bringHead() { return { 'X-BRING-API-KEY': BRING_KEY, 'X-BRING-CLIENT': 'android', 'X-BRING-APPLICATION': 'bring', 'X-BRING-COUNTRY': 'DE', Accept: 'application/json' }; }
const okHref = (h: string) => /^\/[^?#]*\/calendars\/[^?#]+$/.test(h) && !h.includes('..');

async function call(url: string, init: RequestInit, who: string) {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) }); }
  catch (e: any) { throw new StorageError(422, `${who} nicht erreichbar: ${e?.cause?.code ?? e?.message ?? e}`); }
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
export function parseCalendars(xml: string) {
  const out: { href: string; name: string; events: boolean; tasks: boolean }[] = [];
  for (const m of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
    const body = m[1];
    const rt = body.match(/<(?:[\w-]+:)?resourcetype\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?resourcetype>/i)?.[1] ?? '';
    if (!/<(?:[\w-]+:)?calendar\b/i.test(rt)) continue;
    const href = unxml(body.match(/<(?:[\w-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i)?.[1]?.trim() ?? '');
    const name = unxml(body.match(/<(?:[\w-]+:)?displayname\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?displayname>/i)?.[1]?.trim() ?? '');
    const comps = [...body.matchAll(/<(?:[\w-]+:)?comp\b[^>]*name="([A-Z]+)"/gi)].map((c) => c[1].toUpperCase());
    // Ohne Angabe: alles erlaubt
    const events = !comps.length || comps.includes('VEVENT'), tasks = !comps.length || comps.includes('VTODO');
    if (!okHref(href) || (!events && !tasks)) continue;
    let fallback = href.replace(/\/+$/, '').split('/').pop() ?? '';
    try { fallback = decodeURIComponent(fallback); } catch { /* so lassen */ }
    out.push({ href, name: name || fallback, events, tasks });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

// ---------- iCalendar ----------
/** Lokale Zeit „YYYY-MM-DDTHH:MM“ in der Server-Zeitzone → UTC-Zeitstempel */
export function localToUtc(local: string, tz = TZ()): number {
  const [d, t = '00:00'] = local.split('T');
  const [y, mo, da] = d.split('-').map(Number), [h, mi] = t.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  const off = (ts: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(ts).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ts;
  };
  let ts = guess - off(guess);
  ts = guess - off(ts);
  return ts;
}
const utc = (ts: number) => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateOnly = (d: string) => d.replace(/-/g, '');
const nextDay = (d: string) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
export const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Zeilen nach RFC 5545 auf 75 Bytes falten */
function fold(line: string) {
  const out: string[] = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
function wrap(kind: 'VEVENT' | 'VTODO', lines: string[]) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Chorus//DE', 'CALSCALE:GREGORIAN', `BEGIN:${kind}`, ...lines, `END:${kind}`, 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n';
}
export function eventIcs(e: CalEvent, uid = randomUUID()) {
  const lines = [`UID:${uid}`, `DTSTAMP:${utc(Date.now())}`, `SUMMARY:${icsText(e.title)}`];
  if (e.allDay) {
    const s = e.start.slice(0, 10);
    const end = e.end && e.end.length === 10 && e.end >= s ? nextDay(e.end) : nextDay(s);
    lines.push(`DTSTART;VALUE=DATE:${dateOnly(s)}`, `DTEND;VALUE=DATE:${dateOnly(end)}`);
  } else {
    const s = localToUtc(e.start);
    const end = e.end && e.end.length === 16 ? localToUtc(e.end) : NaN;
    lines.push(`DTSTART:${utc(s)}`, `DTEND:${utc(end > s ? end : s + 3600_000)}`);
  }
  if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
  if (e.note) lines.push(`DESCRIPTION:${icsText(e.note)}`);
  return wrap('VEVENT', lines);
}
export function todoIcs(t: Task, uid = randomUUID()) {
  const lines = [`UID:${uid}`, `DTSTAMP:${utc(Date.now())}`, `CREATED:${utc(Date.now())}`, `SUMMARY:${icsText(t.title)}`, 'STATUS:NEEDS-ACTION'];
  if (t.due) lines.push(t.due.length === 10 ? `DUE;VALUE=DATE:${dateOnly(t.due)}` : `DUE:${utc(localToUtc(t.due))}`);
  if (t.note) lines.push(`DESCRIPTION:${icsText(t.note)}`);
  return wrap('VTODO', lines);
}
