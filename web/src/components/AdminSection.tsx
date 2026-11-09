import { useEffect, useState } from 'react';
import { api } from '../api';
import { NETWORKS } from '../util';
import { Icon } from './Icon';

type Status = Awaited<ReturnType<typeof api.adminStatus>>;
const fmtUp = (s: number) => s < 3600 ? `${Math.round(s / 60)} Min.` : s < 86400 ? `${Math.floor(s / 3600)} Std. ${Math.round((s % 3600) / 60)} Min.` : `${Math.floor(s / 86400)} Tage`;
const STATE: Record<string, string> = { connected: 'verbunden', connecting: 'verbindet', disconnected: 'getrennt', need_input: 'Anmeldung offen', qr: 'QR-Code offen', error: 'Fehler' };

/** Einstellungen → Server (nur Admin): Zustand, Neustart, letzte Warnungen */
export function AdminSection() {
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [logs, setLogs] = useState(false);
  const load = () => api.adminStatus().then(setS).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const restart = async () => {
    if (!confirm('Chorus neu starten? Das dauert etwa 20 Sekunden. Profile ohne Komfort-Modus sind danach gesperrt, bis sich die Person wieder anmeldet. Signal und WhatsApp liefern verpasste Nachrichten nach.')) return;
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
      <h3>Server</h3>
      {err && <div className="error">{err}</div>}
      {s && (
        <div className="admin-grid">
          <div><small>Version</small><b>{s.version}</b></div>
          <div><small>Läuft seit</small><b>{fmtUp(s.uptimeSec)}</b></div>
          <div><small>Arbeitsspeicher</small><b>{s.memMB} MB</b><small>{s.hostFreeMB} von {s.hostMemMB} MB frei</small></div>
          <div><small>Speicherplatz</small><b>{s.disk ? `${s.disk.freeGB} GB frei` : '–'}</b>{s.disk && <small>von {s.disk.totalGB} GB</small>}</div>
          <div><small>Auslastung</small><b>{s.load.toFixed(2)}</b><small>{s.cpus} Kerne</small></div>
          <div><small>ffmpeg</small><b>{s.ffmpeg ? 'vorhanden' : 'fehlt'}</b></div>
        </div>
      )}
      {s && (
        <div className="admin-profiles">
          {s.profiles.map((p) => (
            <div key={p.name} className="admin-profile">
              <b>{p.name}</b>
              <small>{p.unlocked ? 'angemeldet' : 'gesperrt'}{p.comfort ? ' · Komfort-Modus' : ''}</small>
              <span className="admin-nets">{p.accounts.map((a, i) => (
                <span key={i} className={`admin-net ${a.state}`}><span className="dot" style={{ background: NETWORKS[a.network].color }} />{NETWORKS[a.network].name}: {STATE[a.state] ?? a.state}</span>
              ))}</span>
            </div>
          ))}
        </div>
      )}
      <div className="row gap wrap">
        <button className="btn" onClick={async () => { await api.reconnect().catch(() => {}); setTimeout(load, 3000); }}><Icon name="refresh" size={18} /> Meine Messenger neu verbinden</button>
        <button className="btn" onClick={async () => { await api.refreshContacts().catch(() => {}); alert('Profilbilder und Infos werden im Hintergrund neu geholt. Das dauert je nach Anzahl der Chats einige Minuten.'); }}><Icon name="user" size={18} /> Profilbilder neu laden</button>
        <button className="btn danger-ghost" onClick={restart} disabled={restarting}><Icon name="power" size={18} /> {restarting ? 'Startet neu …' : 'Server neu starten'}</button>
        <button className="btn ghost" onClick={load}>Aktualisieren</button>
      </div>
      {s && s.logs.length > 0 && (
        <>
          <button className="link" style={{ justifySelf: 'start' }} onClick={() => setLogs((v) => !v)}>{logs ? 'Meldungen ausblenden' : `Letzte Warnungen und Fehler (${s.logs.length})`}</button>
          {logs && <div className="admin-logs">{s.logs.map((l, i) => (
            <div key={i} className={l.level >= 50 ? 'e' : 'w'}><time>{new Date(l.t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>{l.msg}</div>
          ))}</div>}
        </>
      )}
    </section>
  );
}
