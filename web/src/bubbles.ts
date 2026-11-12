import type { Network } from './api';

/** Farbe der eigenen Sprechblasen: je Messenger oder einheitlich */
export type BubbleSettings = { mode: 'network' | 'single'; colors: Record<Network, string>; single: string };
export const BUBBLE_DEFAULTS: BubbleSettings = {
  mode: 'network', single: '#4f46e5',
  colors: { signal: '#3a76f0', whatsapp: '#1f9e5a', telegram: '#3390ec', email: '#ea580c', demo: '#4f46e5' },
};
export const BUBBLE_PALETTE = ['#3a76f0', '#3390ec', '#0891b2', '#1f9e5a', '#0f766e', '#4f46e5', '#7c3aed', '#db2777', '#e11d48', '#ea580c', '#a16207', '#374151'];

export function loadBubbles(): BubbleSettings {
  try {
    const j = JSON.parse(localStorage.getItem('inbox:bubbles') ?? '');
    return { mode: j.mode === 'single' ? 'single' : 'network', colors: { ...BUBBLE_DEFAULTS.colors, ...(j.colors ?? {}) }, single: /^#[0-9a-f]{6}$/i.test(j.single) ? j.single : BUBBLE_DEFAULTS.single };
  } catch { return BUBBLE_DEFAULTS; }
}
export function saveBubbles(b: BubbleSettings) { localStorage.setItem('inbox:bubbles', JSON.stringify(b)); applyBubbles(b); }

/** Helle Farben bekommen dunkle Schrift */
export function ink(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111827' : '#ffffff';
}

export function applyBubbles(b = loadBubbles()) {
  const root = document.documentElement;
  root.classList.toggle('bubbles-net', b.mode === 'network');
  if (b.single !== BUBBLE_DEFAULTS.single) { root.style.setProperty('--bubble-out', b.single); root.style.setProperty('--bubble-out-ink', ink(b.single)); }
  else { root.style.removeProperty('--bubble-out'); root.style.removeProperty('--bubble-out-ink'); }
  for (const [n, c] of Object.entries(b.colors)) {
    root.style.setProperty(`--bubble-${n}`, c);
    root.style.setProperty(`--bubble-${n}-ink`, ink(c));
  }
}

/** Chat-Hintergrund: Vorlage oder eigenes Bild (verkleinert im Browser gespeichert) */
export const CHAT_BACKGROUNDS: { id: string; name: string; css: string }[] = [
  { id: 'none', name: 'Ohne', css: '' },
  { id: 'dots', name: 'Punkte', css: 'radial-gradient(color-mix(in srgb, var(--ink) 9%, transparent) 1.2px, transparent 1.4px) 0 0 / 18px 18px, var(--bg)' },
  { id: 'sky', name: 'Himmel', css: 'linear-gradient(160deg, #dbeafe, #e0e7ff 45%, #fce7f3)' },
  { id: 'sea', name: 'Meer', css: 'linear-gradient(170deg, #cffafe, #a5f3fc 40%, #93c5fd)' },
  { id: 'meadow', name: 'Wiese', css: 'linear-gradient(165deg, #ecfccb, #d9f99d 45%, #bbf7d0)' },
  { id: 'sand', name: 'Sand', css: 'linear-gradient(160deg, #fef3c7, #fde68a 40%, #fed7aa)' },
  { id: 'dusk', name: 'Dämmerung', css: 'linear-gradient(165deg, #fbcfe8, #c4b5fd 50%, #818cf8)' },
  { id: 'night', name: 'Nacht', css: 'radial-gradient(circle at 20% 10%, #312e81, transparent 55%), radial-gradient(circle at 90% 90%, #164e63, transparent 50%), #0b1020' },
  { id: 'graphite', name: 'Graphit', css: 'linear-gradient(170deg, #374151, #111827)' },
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
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('Bild konnte nicht gelesen werden.')); i.src = url; });
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    let q = 0.82, data = c.toDataURL('image/jpeg', q);
    while (data.length > 1_500_000 && q > 0.4) { q -= 0.12; data = c.toDataURL('image/jpeg', q); }
    try { localStorage.setItem(BG_IMG, data); } catch { throw new Error('Das Bild ist zu groß für den Speicher des Browsers.'); }
    saveChatBg('custom');
  } finally { URL.revokeObjectURL(url); }
}
