import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Kleine Design-Effekte, einzeln abschaltbar in Einstellungen → Darstellung (Standard: an).
 * Bewusst nur transform/opacity; bei „Bewegung reduzieren“ laufen keine Animationen.
 */
export type Fx = 'burst';

export const FX: { id: Fx; title: string; hint: string }[] = [
  { id: 'burst', title: 'Reaktions-Burst', hint: 'Beim Reagieren platzt das Emoji in kleine Teilchen und landet federnd an der Blase' },
];

const key = (f: Fx) => `inbox:fx:${f}`;
export const fxOn = (f: Fx) => { try { return localStorage.getItem(key(f)) !== '0'; } catch { return true; } };
export const setFx = (f: Fx, on: boolean) => { localStorage.setItem(key(f), on ? '1' : '0'); window.dispatchEvent(new Event('chorus:fx')); };
export const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return true; } };

/** Ist der Effekt an? Aktualisiert sich, wenn er in den Einstellungen umgeschaltet wird. */
export function useFx(f: Fx) {
  const [on, setOn] = useState(() => fxOn(f));
  useEffect(() => {
    const h = () => setOn(fxOn(f));
    window.addEventListener('chorus:fx', h);
    return () => window.removeEventListener('chorus:fx', h);
  }, [f]);
  return on;
}

/** Reaktions-Burst: Emoji-Teilchen fliegen von der Blase aus (Web Animations, nur transform/opacity) */
const popped = new Map<string, number>();
export const justReacted = (id: string, emoji: string) => (popped.get(`${id}|${emoji}`) ?? 0) > Date.now() - 2500;
export function burst(messageId: string, emoji: string) {
  if (!fxOn('burst') || reducedMotion()) return;
  popped.set(`${messageId}|${emoji}`, Date.now());
  const msg = document.querySelector(`.msg[data-id="${CSS.escape(messageId)}"]`);
  const b = msg?.querySelector('.bubble');
  if (!b || typeof (b as HTMLElement).animate !== 'function') return;
  const r = b.getBoundingClientRect();
  const out = msg!.classList.contains('out');
  const layer = document.createElement('div');
  layer.className = 'fx-burst';
  layer.style.left = `${out ? r.right - 22 : r.left + 22}px`;
  layer.style.top = `${r.bottom - 4}px`;
  const n = 9;
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span');
    s.textContent = emoji;
    layer.appendChild(s);
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const d = 34 + Math.random() * 26;
    s.animate([
      { transform: 'translate(0,0) scale(.3)', opacity: 1 },
      { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d - 10}px) scale(${0.55 + Math.random() * 0.4})`, opacity: 0 },
    ], { duration: 650, easing: 'cubic-bezier(.2,.7,.3,1)', delay: i * 12, fill: 'forwards' });
  }
  document.body.appendChild(layer);
  window.setTimeout(() => layer.remove(), 900);
}

/** Wer tippt gerade? Nur live vom Server, läuft nach 12 s ohne Auffrischung von selbst ab */
const typingNow = new Map<string, number>();
const typingSubs = new Set<() => void>();
const typingPing = () => { for (const f of typingSubs) f(); };
export function setTyping(chatId: string, on: boolean) {
  const old = typingNow.get(chatId);
  if (old) clearTimeout(old);
  if (on) typingNow.set(chatId, window.setTimeout(() => { typingNow.delete(chatId); typingPing(); }, 12_000));
  else typingNow.delete(chatId);
  if (!!old !== on) typingPing();
}
const typingSub = (f: () => void) => { typingSubs.add(f); return () => { typingSubs.delete(f); }; };
export function useTyping(chatId: string) {
  return useSyncExternalStore(typingSub, () => typingNow.has(chatId));
}
/** Tippt in einem der Chats gerade jemand? (zusammengeführte Kontakte: mehrere Chat-IDs) */
export function useTypingAny(chatIds: string[]) {
  const k = chatIds.join('|');
  return useSyncExternalStore(typingSub, () => k.split('|').some((id) => typingNow.has(id)));
}
