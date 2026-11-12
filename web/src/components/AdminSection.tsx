import { useEffect, useState } from 'react';
import { api } from '../api';
import { NETWORKS } from '../util';
import { Icon } from './Icon';
import { T, lang, locale } from '../i18n';

type Status = Awaited<ReturnType<typeof api.adminStatus>>;
const fmtUp = (s: number) => s < 3600 ? T('{0} Min.', Math.round(s / 60)) : s < 86400 ? T('{0} Std. {1} Min.', Math.floor(s / 3600), Math.round((s % 3600) / 60)) : T('{0} Tage', Math.floor(s / 86400));
const STATE: Record<string, string> = { connected: 'verbunden', connecting: 'verbindet', disconnected: 'getrennt', need_input: T('Anmeldung offen'), qr: T('QR-Code offen'), error: T('Fehler') };

/** Einstellungen → Server (nur Admin): Zustand, Neustart, letzte Warnungen */
export function AdminSection() {
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [logs, setLogs] = useState(false);
  const load = () => api.adminStatus().then(setS).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const restart = async () => {
    if (!confirm(T('Chorus neu starten? Das dauert etwa 20 Sekunden. Profile ohne Komfort-Modus sind danach gesperrt, bis sich die Person wieder anmeldet. Signal und WhatsApp liefern verpasste Nachrichten nach.'))) return;
    setRestarting(true);
    await api.adminRestart().catch(() => {});
    // Warten, bis der Server wieder antwortet, dann neu laden
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 3000));
    while (Date.now() - t0 < 120_000) {
      try { const r = await fetch('/api/state', { cache: 'no-store' }); if (r.ok) break; } catch { /* noch nicht da */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
    location.reload();
  };

  return (
    <section className="set-section">
      <h3>{T('Server')}</h3>
      {err && <div className="error">{err}</div>}
      {s && (
        <div className="admin-grid">
          <div><small>{T('Version')}</small><b>{s.version}</b></div>
          <div><small>{T('Läuft seit')}</small><b>{fmtUp(s.uptimeSec)}</b></div>
          <div><small>{T('Arbeitsspeicher')}</small><b>{s.memMB} {T('MB')}</b><small>{s.hostFreeMB} {T('von')}{' '}{s.hostMemMB} {T('MB frei')}</small></div>
          <div><small>{T('Speicherplatz')}</small><b>{s.disk ? T('{0} GB frei', s.disk.freeGB) : '–'}</b>{s.disk && <small>{T('von')}{' '}{s.disk.totalGB} {T('GB')}</small>}</div>
          <div><small>{T('Auslastung')}</small><b>{s.load.toFixed(2)}</b><small>{s.cpus} {T('Kerne')}</small></div>
          <div><small>{T('ffmpeg')}</small><b>{s.ffmpeg ? 'vorhanden' : 'fehlt'}</b></div>
        </div>
      )}
      {s && (
        <div className="admin-profiles">
          {s.profiles.map((p) => (
            <div key={p.name} className="admin-profile">
              <b>{p.name}</b>
              <small>{p.unlocked ? 'angemeldet' : 'gesperrt'}{p.comfort ? T(' · Komfort-Modus') : ''}</small>
              <span className="admin-nets">{p.accounts.map((a, i) => (
                <span key={i} className={`admin-net ${a.state}`}><span className="dot" style={{ background: NETWORKS[a.network].color }} />{NETWORKS[a.network].name}: {STATE[a.state] ?? a.state}</span>
              ))}</span>
            </div>
          ))}
        </div>
      )}
      <div className="row gap wrap">
        <button className="btn" onClick={async () => { await api.reconnect().catch(() => {}); setTimeout(load, 3000); }}><Icon name="refresh" size={18} /> {T('Meine Messenger neu verbinden')}</button>
        <button className="btn" onClick={async () => { await api.refreshContacts().catch(() => {}); alert(T('Profilbilder und Infos werden im Hintergrund neu geholt. Das dauert je nach Anzahl der Chats einige Minuten.')); }}><Icon name="user" size={18} /> {T('Profilbilder neu laden')}</button>
        <button className="btn danger-ghost" onClick={restart} disabled={restarting}><Icon name="power" size={18} /> {restarting ? T('Startet neu …') : T('Server neu starten')}</button>
        <button className="btn ghost" onClick={load}>{T('Aktualisieren')}</button>
      </div>
      {s && s.logs.length > 0 && (
        <>
          <button className="link" style={{ justifySelf: 'start' }} onClick={() => setLogs((v) => !v)}>{logs ? T('Meldungen ausblenden') : T('Letzte Warnungen und Fehler ({0})', s.logs.length)}</button>
          {logs && <div className="admin-logs">{s.logs.map((l, i) => (
            <div key={i} className={l.level >= 50 ? 'e' : 'w'}><time>{new Date(l.t).toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>{l.msg}</div>
          ))}</div>}
        </>
      )}
    </section>
  );
}
