/** E-Mail-Text für die Sprechblase aufbereiten: Zitate, Antwortverläufe und Signaturen entfernen */

/** Betreff ohne „Re:“, „AW:“, „Fwd:“, „WG:“ … (auch mehrfach und mit [Zähler]) */
export function normSubject(s: string | undefined | null): string {
  let t = (s ?? '').replace(/\s+/g, ' ').trim();
  for (;;) {
    const n = t.replace(/^(re|aw|antw|wg|fw|fwd|sv|vs|tr|rif|r)(\[\d+\]|\(\d+\))?\s*:\s*/i, '').trim();
    if (n === t) break;
    t = n;
  }
  return t;
}

/** Zeilen, ab denen der zitierte Verlauf beginnt */
const QUOTE_HEADERS: RegExp[] = [
  /^\s*(am|on|le|el|il|op)\s.{4,200}(schrieb|wrote|a écrit|escribió|ha scritto|schreef)[^\n]*:\s*$/i,
  /^\s*-{2,}\s*(original message|ursprüngliche nachricht|originalnachricht|weitergeleitete nachricht|forwarded message)\s*-{2,}\s*$/i,
  /^\s*_{10,}\s*$/,
  /^\s*(von|from)\s*:\s.+$/i, // Outlook-Block „Von: … Gesendet: …“ (nur wenn kurz danach „Gesendet/Sent/An/To“ folgt, siehe unten)
];

/** Übliche automatische Zusätze am Ende */
const AUTO_SIGS: RegExp[] = [
  /^\s*(von meinem|gesendet von meinem|sent from my|get outlook for|outlook für|gesendet mit der|sent with)\b.{0,80}$/i,
];

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Sichtbarer Text einer Mail. `signatures` sind frei eingetragene Signaturen (eigene und fremde),
 * die irgendwo im Text vorkommen dürfen und dann samt allem danach entfernt werden.
 */
export function cleanMailText(raw: string, signatures: string[] = []): string {
  let lines = raw.replace(/\r\n?/g, '\n').replace(/ /g, ' ').split('\n');

  // 1. Zitierten Verlauf abschneiden
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (QUOTE_HEADERS.slice(0, 3).some((r) => r.test(l))) { cut = i; break; }
    // „Am … schrieb“ über zwei Zeilen umbrochen
    if (i + 1 < lines.length && /^\s*(am|on)\s/i.test(l) && /(schrieb|wrote)[^\n]*:\s*$/i.test(lines[i + 1]) && (l + lines[i + 1]).length < 250) { cut = i; break; }
    if (QUOTE_HEADERS[3].test(l) && lines.slice(i + 1, i + 5).some((n) => /^\s*(gesendet|sent|datum|date|an|to|betreff|subject)\s*:/i.test(n))) { cut = i; break; }
    // Erste zitierte Zeile („> …“) nach eigenem Text: alles danach ist Verlauf
    if (/^\s*>/.test(l)) {
      const rest = lines.slice(i);
      const quoted = rest.filter((x) => /^\s*>/.test(x)).length;
      if (quoted >= rest.filter((x) => x.trim()).length * 0.6) { cut = i; break; }
    }
  }
  lines = lines.slice(0, cut).filter((l) => !/^\s*>/.test(l));

  // 2. Signatur-Trenner „-- “
  const sep = lines.findIndex((l) => /^--\s?$/.test(l) || /^—\s*$/.test(l));
  if (sep >= 0) lines = lines.slice(0, sep);

  // 3. Automatische Zusätze am Ende („Von meinem iPhone gesendet“)
  while (lines.length && (!lines.at(-1)!.trim() || AUTO_SIGS.some((r) => r.test(lines.at(-1)!)))) lines.pop();

  let text = lines.join('\n');

  // 4. Eingetragene Signaturen: an der ersten Zeile erkennen, ab dort abschneiden (wenn der Rest dazu passt)
  for (const sig of signatures) {
    const sl = sig.replace(/\r\n?/g, '\n').split('\n').map((x) => x.trim()).filter(Boolean);
    if (!sl.length) continue;
    const tl = text.split('\n');
    for (let i = tl.length - 1; i >= 0; i--) {
      if (squash(tl[i]) !== squash(sl[0])) continue;
      const tail = squash(tl.slice(i).join(' '));
      const want = squash(sl.join(' '));
      // ganz gleich, oder die Signatur ist in der Mail leicht gekürzt/erweitert
      if (tail === want || tail.startsWith(want) || want.startsWith(tail) || sl.length === 1) { text = tl.slice(0, i).join('\n'); break; }
    }
  }

  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/** HTML in lesbaren Text (Absätze, Zeilenumbrüche, Listen, Links), ohne Stile/Skripte */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Gmail/Apple/Outlook-Zitate komplett entfernen
    .replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi, '\n')
    .replace(/<div[^>]*class="?[^">]*gmail_quote[\s\S]*$/i, '')
    .replace(/<div[^>]*id="?(divRplyFwdMsg|appendonsend|mail-editor-reference-message-container)[\s\S]*$/i, '')
    .replace(/<a\s[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const t = inner.replace(/<[^>]+>/g, '').trim();
      return t && t !== href && !href.includes(t) ? `${t} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|tr|h[1-6]|li|table|ul|ol)>/gi, '\n')
    .replace(/<(p|div|tr|h[1-6]|table)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', euro: '€', ndash: '–', mdash: '—', hellip: '…', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©', reg: '®', zwnj: '' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return named[e] ?? m;
  });
}
