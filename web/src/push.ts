import { api } from './api';

export const b64 = (s: string) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/**
 * Push-Abo beim App-Start und beim Zurückkommen prüfen: Ist die Erlaubnis erteilt, das Abo aber weg
 * (z. B. App neu zum Home-Bildschirm hinzugefügt, iOS hat das Abo verworfen), still neu abonnieren
 * und dem Server melden. So gehen Benachrichtigungen nicht unbemerkt verloren.
 */
let last = 0;
export async function syncPush(force = false): Promise<PushSubscription | null> {
  if (!pushSupported() || Notification.permission !== 'granted') return null;
  if (!force && Date.now() - last < 60_000) return null;
  last = Date.now();
  try {
    const reg = await navigator.serviceWorker.ready;
    let s = await reg.pushManager.getSubscription();
    const { key } = await api.push();
    // Abo zu einem anderen Schlüssel passt nicht mehr: neu anlegen
    const cur = s?.options?.applicationServerKey;
    if (s && cur && btoa(String.fromCharCode(...new Uint8Array(cur))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== key.replace(/=+$/, '')) { await s.unsubscribe().catch(() => {}); s = null; }
    if (!s) s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
    await api.pushSubscribe(s);
    localStorage.setItem('inbox:push', '1');
    return s;
  } catch { return null; }
}
