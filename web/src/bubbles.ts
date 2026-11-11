import type { Network } from './api';

/** Farbe der eigenen Sprechblasen: je Messenger oder einheitlich */
export type BubbleSettings = { mode: 'network' | 'single'; colors: Record<Network, string> };
export const BUBBLE_DEFAULTS: BubbleSettings = {
  mode: 'network',
  colors: { signal: '#3a76f0', whatsapp: '#1f9e5a', telegram: '#3390ec', email: '#ea580c', demo: '#4f46e5' },
};
export const BUBBLE_PALETTE = ['#3a76f0', '#3390ec', '#0891b2', '#1f9e5a', '#0f766e', '#4f46e5', '#7c3aed', '#db2777', '#e11d48', '#ea580c', '#a16207', '#374151'];

export function loadBubbles(): BubbleSettings {
  try {
    const j = JSON.parse(localStorage.getItem('inbox:bubbles') ?? '');
    return { mode: j.mode === 'single' ? 'single' : 'network', colors: { ...BUBBLE_DEFAULTS.colors, ...(j.colors ?? {}) } };
  } catch { return BUBBLE_DEFAULTS; }
}
export function saveBubbles(b: BubbleSettings) { localStorage.setItem('inbox:bubbles', JSON.stringify(b)); applyBubbles(b); }

/** Helle Farben bekommen dunkle Schrift */
function ink(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111827' : '#ffffff';
}

export function applyBubbles(b = loadBubbles()) {
  const root = document.documentElement;
  root.classList.toggle('bubbles-net', b.mode === 'network');
  for (const [n, c] of Object.entries(b.colors)) {
    root.style.setProperty(`--bubble-${n}`, c);
    root.style.setProperty(`--bubble-${n}-ink`, ink(c));
  }
}
