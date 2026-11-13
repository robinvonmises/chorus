import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Kleine Design-Effekte, einzeln abschaltbar in Einstellungen → Darstellung (Standard: an).
 * Bewusst nur transform/opacity; bei „Bewegung reduzieren“ laufen keine Animationen.
 */
export type Fx = 'animoji' | 'animEmoji';

export const FX: { id: Fx; title: string; hint: string }[] = [
  { id: 'animoji', title: 'Animierte Reaktionen', hint: 'Dein Reaktions-Emoji spielt einmal kurz groß über der Blase ab' },
  { id: 'animEmoji', title: 'Animierte Emojis', hint: 'Nachrichten nur aus Emojis bewegen sich, solange sie zu sehen sind' },
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

/** Codepunkte eines Emojis wie bei Noto Animated Emoji: „2764_fe0f“, „1f44d_1f3fb“ */
export function emojiCode(e: string) {
  return [...e].map((c) => c.codePointAt(0)!.toString(16)).join('_');
}

/** Animierte Reaktion: Noto-Animation (animiertes WebP, über den eigenen Server zwischengespeichert)
 *  erscheint einmal kurz über der Blase. Gibt es keine Animation oder lädt sie zu lange, passiert nichts. */
export function animoji(messageId: string, emoji: string) {
  if (!fxOn('animoji') || reducedMotion()) return;
  const img = new Image();
  const t0 = Date.now();
  img.decoding = 'async';
  img.onload = () => {
    if (Date.now() - t0 > 2500) return; // zu spät, der Moment ist vorbei
    const b = document.querySelector(`.msg[data-id="${CSS.escape(messageId)}"] .bubble`);
    if (!b) return;
    const r = b.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    const out = !!b.closest('.msg.out');
    const S = 96;
    img.className = 'fx-animoji';
    img.alt = '';
    img.style.width = img.style.height = `${S}px`;
    img.style.left = `${Math.max(4, Math.min(innerWidth - S - 4, out ? r.left - S * 0.35 : r.right - S * 0.65))}px`;
    img.style.top = `${Math.max(4, r.top - S * 0.6)}px`;
    document.body.appendChild(img);
    if (typeof img.animate === 'function') {
      img.animate([
        { transform: 'scale(.4)', opacity: 0 }, { transform: 'scale(1.05)', opacity: 1, offset: 0.12 },
        { transform: 'scale(1)', opacity: 1, offset: 0.8 }, { transform: 'scale(.85)', opacity: 0 },
      ], { duration: 1700, easing: 'ease-out', fill: 'forwards' });
    }
    window.setTimeout(() => img.remove(), 1750);
  };
  img.src = `/api/emoji/${emojiCode(emoji)}.webp`;
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
