import type { Message } from './api';

export type Hint = 'event' | 'task' | 'shop';

// Rein lokal, ohne KI: nur ein Fingerzeig, ob sich das Erkennen lohnt. Die KI läuft erst beim Antippen.
const TIME = /\b([01]?\d|2[0-3])([:.][0-5]\d)?\s*(uhr|h\b)|\b([01]?\d|2[0-3]):[0-5]\d\b|\b\d{1,2}\.\d{1,2}\.(\d{2,4})?(?!\d)|\b\d{1,2}\.\s*(jan|feb|mär|apr|mai|jun|jul|aug|sep|okt|nov|dez)|\b(at|um)\s+\d{1,2}\s*(am|pm)\b|\b\d{1,2}\s*(am|pm)\b/i;
const DAY = /\b(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|morgen|übermorgen|heute abend|nächste[nr]? woche|wochenende|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|next week|weekend)\b/i;
const MEET = /\b(treffen|termin|essen|frühstück|kaffee|party|feier|geburtstag|kino|konzert|arzt|besuch|abholen|vorbeikommen|kommst du|kommt ihr|zeit\??|date|meeting|call|dinner|lunch|appointment|meet|visit)\b/i;
const SHOP = /\b(einkauf\w*|einkaufen|mitbringen|besorgen|kaufen|supermarkt|edeka|rewe|aldi|lidl|penny|netto|kaufland|dm\b|einkaufsliste|grocer\w*|shopping list|pick up some|buy)\b/i;
const TASK = /\b(kannst du|könntest du|würdest du|denk (bitte )?(dran|daran)|vergiss nicht|nicht vergessen|erinner\w* mich|bitte (noch )?\w+ (machen|erledigen|schicken|anrufen|bezahlen|überweisen|abgeben)|bis (morgen|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|ende)|can you|could you|please (call|send|pay|bring)|don'?t forget|remember to)\b/i;

const MAX_AGE = 14 * 24 * 3600_000;

/** Lohnt sich ein „Erkennen“-Hinweis an dieser Nachricht? */
export function hintOf(m: Message): Hint | null {
  if (m.fromMe || m.deleted || Date.now() - m.ts > MAX_AGE) return null;
  const t = [m.text, m.transcript].filter(Boolean).join(' ');
  if (t.length < 8 || t.length > 1500) return null;
  if (SHOP.test(t)) return 'shop';
  if (TIME.test(t) || (DAY.test(t) && MEET.test(t))) return 'event';
  if (TASK.test(t)) return 'task';
  return null;
}
