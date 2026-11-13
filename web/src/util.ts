import type { Network } from './api';
import { T, locale } from './i18n';

export const NETWORKS: Record<Network, { name: string; short: string; color: string }> = {
  telegram: { name: 'Telegram', short: 'T', color: 'var(--net-telegram)' },
  signal: { name: 'Signal', short: 'S', color: 'var(--net-signal)' },
  whatsapp: { name: 'WhatsApp', short: 'W', color: 'var(--net-whatsapp)' },
  email: { name: T('E-Mail'), short: '@', color: 'var(--net-email)' },
  demo: { name: 'Demo', short: 'D', color: 'var(--net-demo)' },
  notes: { name: T('Notizen'), short: '✎', color: 'var(--net-notes)' },
};

const dayFmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
const dateFmt = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: '2-digit' });
const timeFmt = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
const longDay = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' });

export function listTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return timeFmt.format(d);
  const diff = (now.getTime() - ts) / 864e5;
  if (diff < 6) return dayFmt.format(d);
  return dateFmt.format(d);
}
export const msgTime = (ts: number) => timeFmt.format(new Date(ts));
export function dayLabel(ts: number): string {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return T('Heute');
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return T('Gestern');
  return longDay.format(d);
}

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '#';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** Stabile, angenehme Farbe pro Name */
export function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function fileSize(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', T(','))} MB`;
}

export function duration(sec?: number): string {
  if (!sec && sec !== 0) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export const EMOJI_GROUPS: [string, string][] = [
  ['Smileys', '😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗😚😙😋😛😜🤪😝🤑🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬😮‍💨🤥😌😔😪🤤😴😷🤒🤕🤢🤮🥵🥶🥴😵🤯🤠🥳🥸😎🤓🧐😕😟🙁😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡😠🤬😈👿💀💩🤡👻👽🤖'],
  [T('Gesten'), '👋🤚🖐✋🖖👌🤌🤏✌🤞🤟🤘🤙👈👉👆👇☝👍👎✊👊🤛🤜👏🙌👐🤲🤝🙏✍💪🦾🧠👀👁👅👄'],
  [T('Herzen'), '❤️🧡💛💚💙💜🖤🤍🤎💔❣💕💞💓💗💖💘💝💟'],
  [T('Natur'), '🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🐔🐧🐦🦆🦅🦉🐴🦄🐝🦋🐌🐞🐢🐍🐙🐠🐬🐳🌵🌲🌳🌴🌱🌿🍀🍁🍂🌷🌹🌺🌸🌼🌻🌞🌝🌚⭐🌟✨⚡🔥🌈☀️⛅☁️🌧⛄❄️💧🌊'],
  [T('Essen'), '🍏🍎🍐🍊🍋🍌🍉🍇🍓🫐🍒🍑🥭🍍🥥🥝🍅🥑🥦🥕🌽🥔🥐🍞🥨🧀🥚🍳🥓🍔🍟🍕🌭🥪🌮🌯🥗🍝🍜🍣🍤🍦🍩🍪🎂🍰🧁🍫🍬🍭☕🍵🍺🍻🥂🍷🥃🍸🍹🧃'],
  [T('Aktivität'), '⚽🏀🏈⚾🎾🏐🏉🎱🏓🏸🥅⛳🏹🎣🥊🎽🛹⛸🎿🏂🏋🤸🚴🏊🧘🎯🎮🎲🧩🎨🎬🎤🎧🎼🎹🥁🎷🎺🎸🎉🎊🎁🏆🥇'],
  [T('Dinge'), '📱💻⌨🖥🖨🖱💾📷📸📹🎥📞☎📺📻⏰⌛💡🔦🕯💸💵💶💳💎🔧🔨🛠🔑🗝🚪🛏🛋🚿🛁🧸🎈📦📫✉📝📌📎✂🗓📅📈📉📊🔒🔓🚗🚕🚌🚲✈🚀⛵🏠🏡🏢🏥🏖⛰'],
  [T('Symbole'), '✅☑✔❌❎➕➖➗❓❔❗❕‼⁉💯🔴🟠🟡🟢🔵🟣⚫⚪🟥🟩🟦⬆⬇⬅➡↩↪🔁🔄🆗🆕🆒🆓ℹ🚫⛔⚠🔞♻💤'],
];

export function splitEmoji(s: string): string[] {
  // Intl.Segmenter trennt korrekt nach Graphem (inkl. zusammengesetzter Emojis)
  const seg = new Intl.Segmenter('de', { granularity: 'grapheme' });
  return [...seg.segment(s)].map((x) => x.segment);
}

export function isOnlyEmoji(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 16) return false;
  return /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(t) && !/^[0-9#*\s]+$/.test(t);
}

/** „Niederländisch“ → „Niederländischen“ (für „Aus dem …“) */
export const adjLang = (n: string) => (/e$/.test(n) ? n + 'n' : /isch$/.test(n) ? n + 'en' : n);

/** E-Mails vor dem Löschen bestätigen lassen? Standard aus, je Gerät. */
export const askMailDelete = () => localStorage.getItem('inbox:askMailDelete') === '1';
export const setAskMailDelete = (on: boolean) => localStorage.setItem('inbox:askMailDelete', on ? '1' : '0');
