/**
 * Haptik: kurzes Antippen des Vibrationsmotors beim Senden, Reagieren und Wischen.
 * Android/Chrome: navigator.vibrate. iOS Safari kennt das nicht; ab iOS 18 gibt aber ein
 * <input type="checkbox" switch> beim Umschalten ein Haptik-Feedback. Wir schalten einen
 * unsichtbaren Schalter per label.click() um. Klappt nur innerhalb einer Nutzer-Geste (Tippen, Loslassen).
 * Abschaltbar in Einstellungen → Darstellung (Standard: an).
 */
const KEY = 'inbox:haptics';
export const hapticsOn = () => { try { return localStorage.getItem(KEY) !== '0'; } catch { return true; } };
export const setHaptics = (on: boolean) => localStorage.setItem(KEY, on ? '1' : '0');

let label: HTMLLabelElement | null = null;
function iosSwitch() {
  if (label) return label;
  label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden';
  const i = document.createElement('input');
  i.type = 'checkbox'; i.setAttribute('switch', ''); i.tabIndex = -1;
  label.appendChild(i);
  document.body.appendChild(label);
  return label;
}

let last = 0;
export function haptic() {
  if (!hapticsOn()) return;
  const now = Date.now();
  if (now - last < 60) return; // nicht doppelt (z. B. Tippen + Klick)
  last = now;
  try {
    if (typeof navigator.vibrate === 'function') { navigator.vibrate(10); return; }
    iosSwitch().click();
  } catch { /* egal */ }
}
