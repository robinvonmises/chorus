import { useEffect, useState } from 'react';
import { api, organize, type CalEvent, type Extracted, type Message, type OrganizeSettings } from '../api';
import { Icon } from './Icon';
import { T, locale } from '../i18n';

type Status = Record<string, 'busy' | 'done'>;

/** Termine, Aufgaben und Einkäufe aus einer Nachricht: prüfen, anpassen, mit einem Tipp eintragen */
export function OrganizeSheet({ m, chatTitle, onClose, onInfo }: { m: Message; chatTitle: string; onClose: () => void; onInfo: (t: string) => void }) {
  const [data, setData] = useState<Extracted | null>(null);
  const [err, setErr] = useState('');
  const [cfg, setCfg] = useState<OrganizeSettings | null>(null);
  const [st, setSt] = useState<Status>({});
  const [pick, setPick] = useState<boolean[]>([]);

  useEffect(() => {
    api.ai.extract(m.id).then((d) => { setData(d); setPick(d.shopping.map(() => true)); }, (e: any) => setErr(e.message ?? T('Fehler')));
    organize.get().then(setCfg, () => {});
  }, [m.id]);

  const note = `${T('Aus Chorus')} · ${chatTitle}${m.fromMe ? '' : ` · ${m.senderName}`}\n„${(m.text || m.transcript || '').slice(0, 400)}“`;
  const run = async (key: string, fn: () => Promise<string>) => {
    setSt((s) => ({ ...s, [key]: 'busy' }));
    try { onInfo(await fn()); setSt((s) => ({ ...s, [key]: 'done' })); }
    catch (e: any) { onInfo(e.message ?? T('Fehler')); setSt((s) => { const n = { ...s }; delete n[key]; return n; }); }
  };
  const setEv = (i: number, p: Partial<CalEvent>) => setData((d) => d && { ...d, events: d.events.map((e, k) => (k === i ? { ...e, ...p } : e)) });
  const setTask = (i: number, p: Partial<Extracted['tasks'][number]>) => setData((d) => d && { ...d, tasks: d.tasks.map((t, k) => (k === i ? { ...t, ...p } : t)) });

  const addEvent = (e: CalEvent) => cfg?.calendar
    ? organize.event({ ...e, note }).then(() => T('Im Kalender „{0}“ eingetragen', cfg.calendarName || 'Nextcloud'))
    : organize.ics({ ...e, note }).then(async (r) => { await openIcs(r.ics, e.title); return T('Kalenderdatei geöffnet'); });

  const empty = data && !data.events.length && !data.tasks.length && !data.shopping.length;
  const btn = (key: string, label: string, fn: () => Promise<string>, disabled = false) => (
    <button className="btn small" disabled={disabled || !!st[key]} onClick={() => run(key, fn)}>
      {st[key] === 'busy' ? <span className="spinner" /> : <Icon name="check" size={16} />} {st[key] === 'done' ? T('Erledigt') : label}
    </button>
  );

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal organize-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={T('Erkannt')}>
        <header className="modal-head"><h2>{T('Termine, Aufgaben, Einkäufe')}</h2><button className="icon-btn" onClick={onClose} aria-label={T('Schließen')}><Icon name="close" /></button></header>
        <div className="modal-body">
          {!data && !err && <p className="muted"><span className="spinner" /> {T('KI liest die Nachricht …')}</p>}
          {err && <p className="muted">{err}</p>}
          {empty && <p className="muted">{T('In dieser Nachricht stehen keine Termine, Aufgaben oder Einkäufe.')}</p>}

          {data?.events.map((e, i) => (
            <div key={`e${i}`} className="org-card">
              <b>📅 {T('Termin')}</b>
              <input className="input" value={e.title} onChange={(x) => setEv(i, { title: x.target.value })} />
              <div className="row">
                <input className="input" type={e.allDay ? 'date' : 'datetime-local'} value={e.start} onChange={(x) => setEv(i, { start: x.target.value })} />
                <label className="org-allday"><input type="checkbox" checked={e.allDay} onChange={(x) => setEv(i, x.target.checked ? { allDay: true, start: e.start.slice(0, 10), end: '' } : { allDay: false, start: `${e.start.slice(0, 10)}T19:00`, end: '' })} /> {T('ganztägig')}</label>
              </div>
              {e.location && <input className="input" value={e.location} placeholder={T('Ort')} onChange={(x) => setEv(i, { location: x.target.value })} />}
              <small className="muted">{fmtWhen(e)}</small>
              {btn(`e${i}`, cfg?.calendar ? T('In „{0}“ eintragen', cfg.calendarName || 'Nextcloud') : T('Im Kalender öffnen'), () => addEvent(e), !e.title.trim() || !e.start)}
            </div>
          ))}

          {data?.tasks.map((t, i) => (
            <div key={`t${i}`} className="org-card">
              <b>✅ {T('Aufgabe')}</b>
              <input className="input" value={t.title} onChange={(x) => setTask(i, { title: x.target.value })} />
              <label className="row"><span className="muted">{T('Fällig')}</span>
                <input className="input" type={t.due.length === 10 ? 'date' : 'datetime-local'} value={t.due} onChange={(x) => setTask(i, { due: x.target.value })} /></label>
              {btn(`t${i}`, cfg?.tasks ? T('In „{0}“ anlegen', cfg.tasksName || T('Aufgaben')) : T('Als Erinnerung anlegen'),
                () => organize.task({ title: t.title, due: t.due, note, messageId: m.id }).then(() => cfg?.tasks ? T('In „{0}“ angelegt', cfg.tasksName || T('Aufgaben')) : T('Erinnerung angelegt')), !t.title.trim())}
              {!cfg?.tasks && <small className="muted">{t.due ? T('Chorus erinnert dich zur Fälligkeit an diese Nachricht.') : T('Ohne Fälligkeit erinnert Chorus dich morgen um 9 Uhr.')}</small>}
            </div>
          ))}

          {data && data.shopping.length > 0 && (
            <div className="org-card">
              <b>🛒 {T('Einkauf')}</b>
              {data.shopping.map((s, i) => (
                <label key={i} className="org-item"><input type="checkbox" checked={pick[i] ?? true} onChange={(x) => setPick((p) => p.map((v, k) => (k === i ? x.target.checked : v)))} />
                  <span>{s.name}{s.spec && <small className="muted"> · {s.spec}</small>}</span></label>
              ))}
              {cfg?.bring.enabled
                ? btn('shop', T('Auf „{0}“ setzen', cfg.bring.listName || 'Bring!'), () => organize.bring(data.shopping.filter((_, i) => pick[i])).then(() => T('{0} Artikel auf „{1}“ gesetzt', pick.filter(Boolean).length, cfg.bring.listName || 'Bring!')), !pick.some(Boolean))
                : <>
                    {btn('shop', T('Liste kopieren'), async () => { await navigator.clipboard?.writeText(data.shopping.filter((_, i) => pick[i]).map((s) => s.spec ? `${s.name} (${s.spec})` : s.name).join('\n')); return T('Kopiert'); }, !pick.some(Boolean))}
                    <small className="muted">{T('Mit Bring! verknüpfen: Einstellungen → Speicherorte.')}</small>
                  </>}
            </div>
          )}

          {data && !empty && !cfg?.calendar && data.events.length > 0 && <p className="muted small">{T('Tipp: In Einstellungen → Speicherorte einen Nextcloud-Kalender wählen, dann trägt Chorus Termine direkt ein.')}</p>}
        </div>
      </div>
    </div>
  );
}

function fmtWhen(e: CalEvent) {
  const d = new Date(e.allDay ? `${e.start}T12:00` : e.start);
  if (Number.isNaN(d.getTime())) return '';
  return e.allDay ? d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })
    : d.toLocaleString(locale, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

/** Ohne Nextcloud-Kalender: .ics teilen (iPhone: „Kalender“ wählen) oder herunterladen */
async function openIcs(ics: string, title: string) {
  const name = `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'Termin'}.ics`;
  const file = new File([ics], name, { type: 'text/calendar' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e: any) { if (e?.name === 'AbortError') throw new Error(T('Abgebrochen')); }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
