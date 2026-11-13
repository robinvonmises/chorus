import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMailText, htmlToText, normSubject, sanitizeMailHtml, tidyPlainText } from './mailtext.js';

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

test('Beleg-HTML: Bilder, versteckter Vorschautext und lange Links fallen weg', () => {
  const html = '<html><head><style>p{}</style></head><body><span style="display:none;max-height:0">Vorschau</span>'
    + '<table><tr><td><img src="https://x/logo.png" alt="Logo"></td></tr><tr><td>Receipt from Anthropic</td><td>€21.42</td></tr>'
    + '<tr><td><a href="https://dashboard.stripe.com/receipts/invoices/CAcQARoXChVhY2N0XzFSeXJzQm51bmNzWmZzOS">Download receipt</a></td></tr></table></body></html>';
  assert.equal(htmlToText(html), 'Receipt from Anthropic €21.42\nDownload receipt');
});

test('Klartext: Bild-Platzhalter und lange Links in Klammern entfernt', () => {
  const t = 'Paid (invoice illustration [https://stripe-images.s3.amazonaws.com/emails/invoices_invoice_illustration.png])\nDownload receipt (https://dashboard.stripe.com/receipts/invoices/CAcQARoXChVhY2N0XzFSeXJzQm51bmNzWmZzOS)';
  assert.equal(tidyPlainText(t), 'Paid (invoice illustration)\nDownload receipt');
});

test('HTML für die Originalansicht ohne Skripte und Event-Attribute', () => {
  const s = sanitizeMailHtml('<p onclick="x()">Hi<script>alert(1)</script><a href="javascript:x()">a</a><img src="cid:logo@x"></p>', { 'logo@x': 'data:image/png;base64,AA' });
  assert.ok(!/script>|onclick|javascript:/i.test(s.replace(/script-src/g, '')));
  assert.ok(s.includes('src="data:image/png;base64,AA"'));
  assert.ok(s.includes('Content-Security-Policy'));
});
