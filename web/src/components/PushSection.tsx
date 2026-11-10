import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from './Icon';
import { b64, syncPush } from '../push';

const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;

/** Einstellungen → Benachrichtigungen: Web Push auf diesem Gerät */
export function PushSection() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [sub, setSub] = useState<PushSubscription | null>(null);
  const [preview, setPreview] = useState(true);
  const [noTitle, setNoTitle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!supported) return;
    // Erlaubnis da: Abo prüfen, notfalls neu anlegen und beim Server anmelden
    syncPush(true).then(async (s) => {
      if (!s) s = await navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).catch(() => null);
      setSub(s);
      if (!s) localStorage.removeItem('inbox:push');
    });
    api.push().then((p) => { setPreview(p.preview); setNoTitle(!!p.noTitle); }).catch(() => {});
  }, []);

  const enable = async () => {
    setBusy(true); setMsg('');
    try {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Benachrichtigungen sind im Browser bzw. in den iOS-Einstellungen blockiert.');
      const { key } = await api.push();
      const reg = await navigator.serviceWorker.ready;
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
      await api.pushSubscribe(s);
      localStorage.setItem('inbox:push', '1');
      setSub(s); setMsg('Eingeschaltet. Zum Ausprobieren „Test senden“ tippen.');
    } catch (e: any) { setMsg(e.message ?? String(e)); }
    finally { setBusy(false); }
  };
  const disable = async () => {
    if (!sub) return;
    await api.pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    localStorage.removeItem('inbox:push');
    setSub(null); setMsg('Auf diesem Gerät ausgeschaltet.');
  };

  return (
    <section className="set-section">
      <h3>Benachrichtigungen</h3>
      {!supported ? (
        <p className="muted">{ios && !standalone
          ? 'Auf dem iPhone kommen Benachrichtigungen nur in der installierten App: in Safari auf „Teilen“ → „Zum Home-Bildschirm“, dann Chorus von dort öffnen und hier einschalten.'
          : 'Dieser Browser unterstützt keine Push-Benachrichtigungen.'}</p>
      ) : sub ? (
        <>
          <p className="muted">Auf diesem Gerät aktiv, auch wenn Chorus geschlossen ist.</p>
          <label className="toggle">
            <input type="checkbox" checked={preview} onChange={async (e) => { setPreview(e.target.checked); await api.setPushPreview(e.target.checked).catch(() => {}); }} />
            <span><b>Absender und Text zeigen</b><small>Aus: nur „Neue Nachricht“, z. B. für den Sperrbildschirm.</small></span>
          </label>
          {ios && (
            <label className="toggle">
              <input type="checkbox" checked={noTitle} onChange={async (e) => { setNoTitle(e.target.checked); await api.setPushNoTitle(e.target.checked).catch(() => {}); }} />
              <span><b>Absender in den Text</b><small>Ohne Titel, damit iOS kein „from Chorus“ anhängt.</small></span>
            </label>
          )}
          <div className="row gap wrap">
            <button className="btn" onClick={() => api.pushTest(sub.endpoint).then(() => setMsg('Gesendet.')).catch((e) => setMsg(e.message))}><Icon name="bell" size={18} /> Test senden</button>
            <button className="btn ghost" onClick={disable}>Ausschalten</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">Chorus meldet neue Nachrichten, auch wenn die App geschlossen ist.{ios ? ' Auf dem iPhone nur in der installierten App vom Home-Bildschirm.' : ''}</p>
          <button className="btn" onClick={enable} disabled={busy}><Icon name="bell" size={18} /> {busy ? 'Einen Moment …' : 'Benachrichtigungen einschalten'}</button>
        </>
      )}
      {msg && <small className="muted">{msg}</small>}
    </section>
  );
}
