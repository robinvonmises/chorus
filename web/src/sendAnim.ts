/**
 * Sende-Animation wie bei iMessage: die eigene neue Blase steigt aus dem Eingabefeld in den Chat.
 * Bewusst minimal: nur transform/opacity auf genau dieser einen Blase, kein Layout-Übergang.
 * Abschaltbar in Einstellungen → Darstellung; bei „Bewegung reduzieren“ immer aus.
 */
const KEY = 'inbox:sendAnim';

export const sendAnimEnabled = () => localStorage.getItem(KEY) !== '0';
export const setSendAnim = (on: boolean) => localStorage.setItem(KEY, on ? '1' : '0');

const active = () => {
  try { return sendAnimEnabled() && !matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

// Textnachrichten erscheinen erst, wenn der Server sie zurückmeldet: beim Senden vormerken,
// damit nur die eigene gerade gesendete Nachricht animiert wird (nicht z. B. eine vom Handy aus gesendete)
let armedAt = 0;
export const armRise = () => { armedAt = Date.now(); };
export const takeRise = () => { const ok = Date.now() - armedAt < 15000; armedAt = 0; return ok; };

export function rise(msg: Element | null | undefined) {
  if (!(msg instanceof HTMLElement) || !active()) return;
  const bubble = msg.querySelector('.bubble') ?? msg;
  const inner = msg.parentElement;
  const field = document.querySelector('.composer textarea, .composer');
  // Start dort, wo im Eingabefeld der Text stand (links unten), dann nach rechts und hoch an ihren Platz
  const f = field?.getBoundingClientRect(), b = bubble.getBoundingClientRect();
  const dy = f ? Math.max(24, Math.min(220, f.top - b.top)) : 60;
  const dx = f ? Math.max(-480, Math.min(0, f.left - b.left)) : 0;
  msg.style.setProperty('--rise-y', `${Math.round(dy)}px`);
  msg.style.setProperty('--rise-x', `${Math.round(dx)}px`);
  // Unteren Rand des Inhalts kappen, solange die Blase unterhalb startet: sonst wächst die Scrollhöhe kurz und es springt
  inner?.classList.add('rising');
  msg.classList.add('rise');
  const done = () => { msg.classList.remove('rise'); inner?.classList.remove('rising'); msg.style.removeProperty('--rise-y'); msg.style.removeProperty('--rise-x'); };
  msg.addEventListener('animationend', done, { once: true });
  setTimeout(done, 800);
}
