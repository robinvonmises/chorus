import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMailText, htmlToText, normSubject } from './mailtext.js';

test('Betreff ohne Re/AW/WG', () => {
  assert.equal(normSubject('AW: Re: WG: Angebot Küche'), 'Angebot Küche');
  assert.equal(normSubject('Re[2]: Termin'), 'Termin');
  assert.equal(normSubject('Rechnung 12'), 'Rechnung 12');
});

test('Zitat nach „Am … schrieb“ entfernt', () => {
  const t = 'Passt, bis Freitag!\n\nViele Grüße\nAnna\n\nAm 10.11.2026 um 14:02 schrieb Wayne <w@x.de>:\n> Wie wäre Freitag?\n> Gruß';
  assert.equal(cleanMailText(t), 'Passt, bis Freitag!\n\nViele Grüße\nAnna');
});

test('Outlook-Block und Signatur-Trenner', () => {
  const t = 'Danke dir.\n-- \nAnna Berger\nTel 0170\n\nVon: Wayne\nGesendet: Montag\nAn: Anna\nBetreff: x\n\nalt';
  assert.equal(cleanMailText(t), 'Danke dir.');
  const o = 'Hallo\n\nVon: Wayne <w@x.de>\nGesendet: Montag, 10. November\nAn: Anna\nBetreff: Test\n\nalter Text';
  assert.equal(cleanMailText(o), 'Hallo');
});

test('Eingetragene Signatur und „Von meinem iPhone gesendet“', () => {
  const sig = 'Wayne von Ometzinski\nIntersphere\nwww.intersphere.me';
  assert.equal(cleanMailText('Klingt gut!\n\nWayne von Ometzinski\nIntersphere\nwww.intersphere.me', [sig]), 'Klingt gut!');
  assert.equal(cleanMailText('Ok\n\nVon meinem iPhone gesendet'), 'Ok');
});

test('HTML ohne Gmail-Zitat', () => {
  const html = '<div dir="ltr">Hallo <b>Wayne</b>,<br>anbei die Datei.<p>Gruß&nbsp;Tom</p></div><div class="gmail_quote">On Mon wrote:<blockquote>alt</blockquote></div>';
  assert.equal(htmlToText(html), 'Hallo Wayne,\nanbei die Datei.\nGruß Tom');
});
