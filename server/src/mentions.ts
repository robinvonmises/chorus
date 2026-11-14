import type { Mention } from './types.js';

const wordChar = /[\p{L}\p{N}_]/u;

/** Findet „@Name“ von Gruppenmitgliedern im Text. Längere Namen zuerst („@Anna Lena“ vor „@Anna“);
 *  vor dem @ muss Anfang, Leerraum oder Klammer stehen, nach dem Namen kein Buchstabe/Ziffer. */
export function findMentions(text: string, people: { id: string; name: string }[]): Mention[] {
  if (!text.includes('@')) return [];
  const byLen = people.filter((p) => p.id && p.name.trim()).sort((a, b) => b.name.length - a.name.length);
  const out: Mention[] = [];
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    if (i > 0 && !/[\s(\[{"'„“]/.test(text[i - 1])) continue;
    const rest = text.slice(i + 1);
    const p = byLen.find((x) => rest.toLowerCase().startsWith(x.name.toLowerCase()) && !wordChar.test(rest[x.name.length] ?? ''));
    if (p) { out.push({ start: i, length: p.name.length + 1, id: p.id }); i += p.name.length; }
  }
  return out;
}

/** Ersetzt die Bereiche der Erwähnungen (z.B. „@Name“ → „@491701234“ für WhatsApp) */
export function replaceMentions(text: string, mentions: Mention[], by: (m: Mention) => string): string {
  let out = text;
  for (const m of [...mentions].sort((a, b) => b.start - a.start)) out = out.slice(0, m.start) + by(m) + out.slice(m.start + m.length);
  return out;
}
