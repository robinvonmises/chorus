import type { Network } from './api';
import { T } from './i18n';

/** App-Farbe (Knöpfe, Markierungen, eigene Sprechblasen). Standard: Ozeanblau */
export type Accent = { id: string; name: string; brand: string; soft: string; dark: string; darkSoft: string };
export const ACCENTS: Accent[] = [
  { id: 'ocean', name: T('Ozeanblau'), brand: '#2563eb', soft: '#eff6ff', dark: '#60a5fa', darkSoft: '#172340' },
  { id: 'emerald', name: T('Smaragd'), brand: '#059669', soft: '#ecfdf5', dark: '#34d399', darkSoft: '#0f2a22' },
  { id: 'petrol', name: T('Petrol'), brand: '#0d9488', soft: '#f0fdfa', dark: '#2dd4bf', darkSoft: '#0f2a29' },
  { id: 'indigo', name: T('Indigo'), brand: '#4f46e5', soft: '#eef2ff', dark: '#818cf8', darkSoft: '#23264a' },
  { id: 'violet', name: T('Violett'), brand: '#9333ea', soft: '#faf5ff', dark: '#c084fc', darkSoft: '#2d1a45' },
  { id: 'coral', name: T('Koralle'), brand: '#e11d48', soft: '#fff1f2', dark: '#fb7185', darkSoft: '#3a1520' },
  { id: 'orange', name: T('Orange'), brand: '#ea580c', soft: '#fff7ed', dark: '#fb923c', darkSoft: '#3a2012' },
  { id: 'graphite', name: T('Graphit'), brand: '#334155', soft: '#f1f5f9', dark: '#94a3b8', darkSoft: '#1f2630' },
];
const ACCENT_KEY = 'inbox:accent';
export function loadAccent(): Accent {
  // Smaragd war nur kurz Standard (v1): wer es da gespeichert hat, bekommt einmalig den neuen Standard
  if (localStorage.getItem('inbox:accentV') !== '2') {
    if (localStorage.getItem(ACCENT_KEY) === 'emerald') localStorage.removeItem(ACCENT_KEY);
    localStorage.setItem('inbox:accentV', '2');
  }
  const id = localStorage.getItem(ACCENT_KEY);
  return ACCENTS.find((a) => a.id === id) ?? ACCENTS[0];
}
export function applyAccent(a = loadAccent()) {
  const st = document.documentElement.style;
  if (a.id === ACCENTS[0].id) { for (const k of ['--brand', '--brand-soft', '--brand-dark', '--brand-dark-soft']) st.removeProperty(k); return; }
  st.setProperty('--brand', a.brand); st.setProperty('--brand-soft', a.soft);
  st.setProperty('--brand-dark', a.dark); st.setProperty('--brand-dark-soft', a.darkSoft);
}
export function saveAccent(id: string) { localStorage.setItem(ACCENT_KEY, id); applyAccent(); }

/** Farbe der eigenen Sprechblasen: App-Farbe (Standard), eigene Farbe oder je Messenger.
 *  single = 'accent' heißt: folgt der App-Farbe. */
export type BubbleSettings = { mode: 'network' | 'single'; colors: Record<Network, string>; single: string };
export const BUBBLE_DEFAULTS: BubbleSettings = {
  mode: 'single', single: 'accent',
  colors: { signal: '#3a76f0', whatsapp: '#1f9e5a', telegram: '#3390ec', email: '#ea580c', demo: '#4f46e5', notes: '#ca8a04' },
};
export const BUBBLE_PALETTE = ['#3a76f0', '#3390ec', '#0891b2', '#1f9e5a', '#0f766e', '#4f46e5', '#7c3aed', '#db2777', '#e11d48', '#ea580c', '#a16207', '#374151'];
/** Tatsächliche Farbe der Einstellung (für Vorschau) */
export function bubbleHex(c: string) { return c === 'accent' ? loadAccent().brand : c; }

export function loadBubbles(): BubbleSettings {
  try {
    const j = JSON.parse(localStorage.getItem('inbox:bubbles') ?? '');
    // Bis v2 war „je Messenger“ Standard und Indigo die Einheitsfarbe: einmalig auf den neuen Standard (App-Farbe) umstellen,
    // eigene Farben je Messenger bleiben gespeichert.
    const old = j.v !== 2;
    const single = !old && /^#[0-9a-f]{6}$/i.test(j.single) ? j.single : old && /^#[0-9a-f]{6}$/i.test(j.single) && j.single.toLowerCase() !== '#4f46e5' ? j.single : 'accent';
    return { mode: !old && j.mode === 'network' ? 'network' : 'single', colors: { ...BUBBLE_DEFAULTS.colors, ...(j.colors ?? {}) }, single };
  } catch { return BUBBLE_DEFAULTS; }
}
export function saveBubbles(b: BubbleSettings) { localStorage.setItem('inbox:bubbles', JSON.stringify({ ...b, v: 2 })); applyBubbles(b); }

/** Helle Farben bekommen dunkle Schrift */
export function ink(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111827' : '#ffffff';
}

export function applyBubbles(b = loadBubbles()) {
  const root = document.documentElement;
  root.classList.toggle('bubbles-net', b.mode === 'network');
  if (b.single !== 'accent') { root.style.setProperty('--bubble-out', b.single); root.style.setProperty('--bubble-out-ink', ink(b.single)); }
  else { root.style.removeProperty('--bubble-out'); root.style.removeProperty('--bubble-out-ink'); }
  for (const [n, c] of Object.entries(b.colors)) {
    root.style.setProperty(`--bubble-${n}`, c);
    root.style.setProperty(`--bubble-${n}-ink`, ink(c));
  }
}

/** Chat-Hintergrund: Vorlage oder eigenes Bild (verkleinert im Browser gespeichert) */
export const CHAT_BACKGROUNDS: { id: string; name: string; css: string }[] = [
  { id: 'none', name: T('Ohne'), css: '' },
  { id: 'dots', name: T('Punkte'), css: 'radial-gradient(color-mix(in srgb, var(--ink) 9%, transparent) 1.2px, transparent 1.4px) 0 0 / 18px 18px, var(--bg)' },
  { id: 'sky', name: T('Himmel'), css: 'linear-gradient(160deg, #dbeafe, #e0e7ff 45%, #fce7f3)' },
  { id: 'sea', name: T('Meer'), css: 'linear-gradient(170deg, #cffafe, #a5f3fc 40%, #93c5fd)' },
  { id: 'meadow', name: T('Wiese'), css: 'linear-gradient(165deg, #ecfccb, #d9f99d 45%, #bbf7d0)' },
  { id: 'sand', name: T('Sand'), css: 'linear-gradient(160deg, #fef3c7, #fde68a 40%, #fed7aa)' },
  { id: 'dusk', name: T('Dämmerung'), css: 'linear-gradient(165deg, #fbcfe8, #c4b5fd 50%, #818cf8)' },
  { id: 'night', name: T('Nacht'), css: 'radial-gradient(circle at 20% 10%, #312e81, transparent 55%), radial-gradient(circle at 90% 90%, #164e63, transparent 50%), #0b1020' },
  { id: 'graphite', name: T('Graphit'), css: 'linear-gradient(170deg, #374151, #111827)' },
];
const BG_KEY = 'inbox:chatbg';
const BG_IMG = 'inbox:chatbgImg';
export function loadChatBg(): string { return localStorage.getItem(BG_KEY) || 'none'; }
export function customBgImage(): string | null { return localStorage.getItem(BG_IMG); }
export function chatBgCss(id = loadChatBg()): string {
  if (id === 'custom') { const img = customBgImage(); return img ? `center / cover no-repeat url("${img}")` : ''; }
  return CHAT_BACKGROUNDS.find((b) => b.id === id)?.css ?? '';
}
export function applyChatBg(id = loadChatBg()) {
  const root = document.documentElement;
  const css = chatBgCss(id);
  root.classList.toggle('has-chat-bg', !!css);
  if (css) root.style.setProperty('--chat-bg', css); else root.style.removeProperty('--chat-bg');
}
export function saveChatBg(id: string) { localStorage.setItem(BG_KEY, id); applyChatBg(id); }

/** Bild verkleinern (lange Seite 1600 px, JPEG) und als eigenen Hintergrund speichern */
export async function setCustomBg(file: File): Promise<void> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error(T('Bild konnte nicht gelesen werden.'))); i.src = url; });
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    let q = 0.82, data = c.toDataURL('image/jpeg', q);
    while (data.length > 1_500_000 && q > 0.4) { q -= 0.12; data = c.toDataURL('image/jpeg', q); }
    try { localStorage.setItem(BG_IMG, data); } catch { throw new Error(T('Das Bild ist zu groß für den Speicher des Browsers.')); }
    saveChatBg('custom');
  } finally { URL.revokeObjectURL(url); }
}
