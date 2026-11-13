import { useEffect, useState } from 'react';
import { organize, type OrganizeSettings } from '../api';
import { Icon } from './Icon';
import { T } from '../i18n';

type Cal = { href: string; name: string; events: boolean; tasks: boolean };

/** Einstellungen → Speicherorte: Ziele für erkannte Termine, Aufgaben und Einkäufe */
export function OrganizeSection() {
  const [s, setS] = useState<OrganizeSettings | null>(null);
  const [cals, setCals] = useState<Cal[] | null>(null);
  const [lists, setLists] = useState<{ id: string; name: string }[] | null>(null);
  const [bring, setBring] = useState<{ email?: string; pass: string }>({ pass: '' });
  const [msg, setMsg] = useState({ cal: '', bring: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { organize.get().then(setS, () => {}); }, []);
  useEffect(() => { if (s?.nextcloud && !cals) organize.calendars().then(setCals, (e: any) => setMsg((m) => ({ ...m, cal: e.message }))); }, [s?.nextcloud]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (s?.bring.email && s.bring.hasPass && !lists) organize.bringLists().then(setLists, (e: any) => setMsg((m) => ({ ...m, bring: e.message }))); }, [s?.bring.email, s?.bring.hasPass]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;

  const save = async (k: 'cal' | 'bring', patch: Record<string, unknown>, ok = T('Gespeichert.')) => {
    setBusy(true); setMsg((m) => ({ ...m, [k]: '' }));
    try { setS(await organize.set(patch)); setMsg((m) => ({ ...m, [k]: ok })); return true; }
    catch (e: any) { setMsg((m) => ({ ...m, [k]: e.message ?? T('Fehler') })); return false; }
    finally { setBusy(false); }
  };
  const connectBring = async () => {
    if (!(await save('bring', { bring: { email: bring.email ?? s.bring.email, pass: bring.pass } }, ''))) return;
    setBring({ pass: '' }); setLists(null);
    try { const l = await organize.bringLists(); setLists(l); setMsg((m) => ({ ...m, bring: l.length ? T('Verbunden. Jetzt eine Liste wählen.') : T('Verbunden, aber keine Listen gefunden.') })); }
    catch (e: any) { setMsg((m) => ({ ...m, bring: e.message })); }
  };
  const pickCal = (kind: 'calendar' | 'tasks', href: string) => save('cal', { [kind]: href, [kind + 'Name']: cals?.find((c) => c.href === href)?.name ?? '' });

  return (<>
    <div className="stack">
      <b>{T('Kalender und Aufgaben (Nextcloud)')}</b>
      <small className="muted">{T('Erkannte Termine trägt Chorus mit einem Tipp in deinen Nextcloud-Kalender ein, Aufgaben in eine Liste von Nextcloud Tasks. Ohne Kalender öffnet Chorus eine Kalenderdatei, ohne Aufgabenliste legt es eine Chorus-Erinnerung an.')}</small>
      {!s.nextcloud ? <small className="muted">{T('Dafür zuerst oben Nextcloud verknüpfen.')}</small> : !cals ? <small className="muted">{msg.cal || T('Lade Kalender …')}</small> : (<>
        <label className="row"><span>{T('Kalender')}</span>
          <select className="input" value={s.calendar} disabled={busy} onChange={(e) => pickCal('calendar', e.target.value)}>
            <option value="">{T('– keiner (Kalenderdatei) –')}</option>
            {cals.filter((c) => c.events).map((c) => <option key={c.href} value={c.href}>{c.name}</option>)}
          </select></label>
        <label className="row"><span>{T('Aufgaben')}</span>
          <select className="input" value={s.tasks} disabled={busy} onChange={(e) => pickCal('tasks', e.target.value)}>
            <option value="">{T('– Chorus-Erinnerung –')}</option>
            {cals.filter((c) => c.tasks).map((c) => <option key={c.href} value={c.href}>{c.name}</option>)}
          </select></label>
        {msg.cal && <small>{msg.cal}</small>}
      </>)}
    </div>

    <div className="stack">
      <b>{T('Bring! (Einkaufsliste)')}{' '}{s.bring.enabled && <small className="state connected">{T('· verknüpft')}</small>}</b>
      <small className="muted">{T('Erkannte Einkäufe setzt Chorus auf deine Bring!-Liste. Bring! hat keine offizielle Schnittstelle: Chorus meldet sich wie die App mit E-Mail und Passwort an (liegen verschlüsselt im Tresor). Bei Konten mit Google- oder Apple-Anmeldung vorher in Bring! ein Passwort setzen.')}</small>
      <input className="input" type="email" autoComplete="off" autoCapitalize="none" placeholder={T('E-Mail')} value={bring.email ?? s.bring.email} onChange={(e) => setBring({ ...bring, email: e.target.value })} />
      <input className="input" type="password" autoComplete="off" placeholder={s.bring.hasPass ? T('•••••••• gespeichert') : T('Passwort')} value={bring.pass} onChange={(e) => setBring({ ...bring, pass: e.target.value })} />
      <div className="row">
        <button className="btn" disabled={busy || !(bring.email ?? s.bring.email) || (!bring.pass && !s.bring.hasPass)} onClick={connectBring}><Icon name="check" size={18} /> {s.bring.hasPass ? T('Speichern und prüfen') : T('Verknüpfen')}</button>
        {s.bring.hasPass && <button className="btn ghost" disabled={busy} onClick={() => { setLists(null); void save('bring', { bring: { email: '', pass: null } }, T('Bring! getrennt.')); }}>{T('Trennen')}</button>}
      </div>
      {lists && lists.length > 0 && (
        <label className="row"><span>{T('Liste')}</span>
          <select className="input" value={s.bring.list} disabled={busy} onChange={(e) => save('bring', { bring: { list: e.target.value, listName: lists.find((l) => l.id === e.target.value)?.name ?? '' } })}>
            <option value="">{T('– Liste wählen –')}</option>
            {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select></label>
      )}
      {msg.bring && <small>{msg.bring}</small>}
    </div>
  </>);
}
