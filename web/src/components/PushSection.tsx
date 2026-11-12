import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from './Icon';
import { b64, syncPush } from '../push';
import { T } from '../i18n';

const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;

/** Einstellungen → Benachrichtigungen: Web Push auf diesem Gerät */
export function PushSection() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [sub, setSub] = useState<PushSubscription | null>(null);
  const [preview, setPreview] = useState(true);
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
    api.push().then((p) => setPreview(p.preview)).catch(() => {});
  }, []);

  const enable = async () => {
    setBusy(true); setMsg('');
    try {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error(T('Benachrichtigungen sind im Browser bzw. in den iOS-Einstellungen blockiert.'));
      const { key } = await api.push();
      const reg = await navigator.serviceWorker.ready;
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
      await api.pushSubscribe(s);
      localStorage.setItem('inbox:push', '1');
      setSub(s); setMsg(T('Eingeschaltet. Zum Ausprobieren „Test senden“ tippen.'));
    } catch (e: any) { setMsg(e.message ?? String(e)); }
    finally { setBusy(false); }
  };
  const disable = async () => {
    if (!sub) return;
    await api.pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    localStorage.removeItem('inbox:push');
    setSub(null); setMsg(T('Auf diesem Gerät ausgeschaltet.'));
  };

  return (
    <section className="set-section">
      <h3>{T('Benachrichtigungen')}</h3>
      {!supported ? (
        <p className="muted">{ios && !standalone
          ? T('Auf dem iPhone kommen Benachrichtigungen nur in der installierten App: in Safari auf „Teilen“ → „Zum Home-Bildschirm“, dann Chorus von dort öffnen und hier einschalten.')
          : T('Dieser Browser unterstützt keine Push-Benachrichtigungen.')}</p>
      ) : sub ? (
        <>
          <p className="muted">{T('Auf diesem Gerät aktiv, auch wenn Chorus geschlossen ist.')}</p>
          <label className="toggle">
            <input type="checkbox" checked={preview} onChange={async (e) => { setPreview(e.target.checked); await api.setPushPreview(e.target.checked).catch(() => {}); }} />
            <span><b>{T('Absender und Text zeigen')}</b><small>{T('Aus: nur „Neue Nachricht“, z. B. für den Sperrbildschirm.')}</small></span>
          </label>
          <div className="row gap wrap">
            <button className="btn" onClick={() => api.pushTest(sub.endpoint).then(() => setMsg(T('Gesendet.'))).catch((e) => setMsg(e.message))}><Icon name="bell" size={18} /> {T('Test senden')}</button>
            <button className="btn ghost" onClick={disable}>{T('Ausschalten')}</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">{T('Chorus meldet neue Nachrichten, auch wenn die App geschlossen ist.')}{ios ? T(' Auf dem iPhone nur in der installierten App vom Home-Bildschirm.') : ''}</p>
          <button className="btn" onClick={enable} disabled={busy}><Icon name="bell" size={18} /> {busy ? T('Einen Moment …') : T('Benachrichtigungen einschalten')}</button>
        </>
      )}
      {msg && <small className="muted">{msg}</small>}
    </section>
  );
}
