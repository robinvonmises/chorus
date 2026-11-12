import { useEffect, useState } from 'react';

/**
 * Kleine Design-Effekte zum Ausprobieren. Jeder ist einzeln in Einstellungen → Darstellung abschaltbar
 * (Standard: an). Bewusst nur CSS transform/opacity, keine Layout-Übergänge; bei „Bewegung reduzieren“
 * laufen keine Animationen.
 */
export type Fx = 'inboxZero' | 'daylight' | 'night' | 'burst';

export const FX: { id: Fx; title: string; hint: string }[] = [
  { id: 'inboxZero', title: 'Gelesen-Moment', hint: 'Wenn alles gelesen ist, schwingt das Chorus-Logo einmal aus' },
  { id: 'daylight', title: 'Tageszeit-Hintergrund', hint: 'Chat-Hintergrund färbt sich mit der Uhrzeit: morgens kühl, abends golden. Ersetzt den gewählten Hintergrund' },
  { id: 'night', title: 'Ruhemodus nachts', hint: 'Von 22 bis 6 Uhr wird alles leicht gedimmt und wärmer, Ungelesen-Zähler atmen langsam' },
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

/** Farbverlauf je Stunde (oben, Mitte, unten); dazwischen wird weich übergeblendet */
const DAY: [number, string, string, string][] = [
  [0, '#1e1b4b', '#1e293b', '#0f172a'],
  [5, '#312e81', '#475569', '#334155'],
  [7, '#e0f2fe', '#dbeafe', '#e0e7ff'],
  [10, '#f0f9ff', '#ecfeff', '#f0fdf4'],
  [15, '#fefce8', '#fef9c3', '#ffedd5'],
  [18, '#fde68a', '#fdba74', '#f9a8d4'],
  [20, '#c4b5fd', '#a78bfa', '#6366f1'],
  [22, '#312e81', '#1e293b', '#0f172a'],
  [24, '#1e1b4b', '#1e293b', '#0f172a'],
];
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a: string, b: string, t: number) => `rgb(${hex(a).map((x, i) => Math.round(x + (hex(b)[i] - x) * t)).join(',')})`;
export function daylightCss(d = new Date()): string {
  const h = d.getHours() + d.getMinutes() / 60;
  const i = DAY.findIndex((k, j) => j < DAY.length - 1 && h >= k[0] && h < DAY[j + 1][0]);
  const a = DAY[i], b = DAY[i + 1];
  const t = (h - a[0]) / (b[0] - a[0]);
  return `linear-gradient(170deg, ${mix(a[1], b[1], t)}, ${mix(a[2], b[2], t)} 50%, ${mix(a[3], b[3], t)})`;
}

/** Ruhemodus nachts: Klasse am <html> setzen (22–6 Uhr) */
export function applyNight(d = new Date()) {
  const h = d.getHours();
  document.documentElement.classList.toggle('fx-night', fxOn('night') && (h >= 22 || h < 6));
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
