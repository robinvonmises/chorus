import en from './locales/en.json';

/** Sprache der Oberfläche. Quelltexte sind Deutsch, Übersetzungen liegen in locales/*.json (Schlüssel = deutscher Text). */
export type Lang = 'en' | 'de';
export type LangChoice = Lang | 'auto';
export const LANGS: { id: Lang; name: string }[] = [{ id: 'en', name: 'English' }, { id: 'de', name: 'Deutsch' }];

const DICTS: Record<Lang, Record<string, string> | null> = { de: null, en };
const KEY = 'inbox:lang';

export function langChoice(): LangChoice {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
  return v === 'en' || v === 'de' ? v : 'auto';
}
/** Automatisch: Deutsch auf deutschen Geräten, sonst Englisch */
function resolve(c: LangChoice): Lang {
  if (c !== 'auto') return c;
  const list = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  return list.some((l) => /^de\b/i.test(l ?? '')) ? 'de' : 'en';
}
export const lang: Lang = resolve(langChoice());
/** Gebietsschema für Datum, Zahlen, Vergleiche */
export const locale = lang === 'de' ? 'de-DE' : (typeof navigator !== 'undefined' && /^en/i.test(navigator.language) ? navigator.language : 'en-US');
if (typeof document !== 'undefined') document.documentElement.lang = lang;

export function setLangChoice(c: LangChoice) {
  if (c === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, c);
  location.reload();
}

const dict = DICTS[lang];
/** Text übersetzen; {0}, {1} … werden durch die Argumente ersetzt */
export function T(s: string, ...args: unknown[]): string {
  const out = (dict && dict[s]) || s;
  return args.length ? out.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? '')) : out;
}
