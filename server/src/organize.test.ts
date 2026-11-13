import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventIcs, todoIcs, localToUtc, parseCalendars, icsText } from './organize.js';
import { cleanExtract, isoLocal } from './ai.js';

test('localToUtc: Sommer- und Winterzeit Berlin', () => {
  assert.equal(new Date(localToUtc('2026-07-10T19:00', 'Europe/Berlin')).toISOString(), '2026-07-10T17:00:00.000Z');
  assert.equal(new Date(localToUtc('2026-11-14T19:00', 'Europe/Berlin')).toISOString(), '2026-11-14T18:00:00.000Z');
  assert.equal(isoLocal(Date.parse('2026-11-14T18:00:00Z'), 'Europe/Berlin'), '2026-11-14T19:00');
});

test('eventIcs: Uhrzeit, Standarddauer, ganztägig, Escaping', () => {
  process.env.TZ = 'Europe/Berlin';
  const a = eventIcs({ title: 'Essen, bei Max; ok', start: '2026-11-14T19:00', end: '', allDay: false, location: 'Max' }, 'u1');
  assert.match(a, /DTSTART:20261114T180000Z\r\n/);
  assert.match(a, /DTEND:20261114T190000Z\r\n/);
  assert.ok(a.includes('SUMMARY:Essen\\, bei Max\\; ok'));
  const b = eventIcs({ title: 'Urlaub', start: '2026-12-24', end: '2026-12-26', allDay: true, location: '' }, 'u2');
  assert.match(b, /DTSTART;VALUE=DATE:20261224/);
  assert.match(b, /DTEND;VALUE=DATE:20261227/);
  const long = eventIcs({ title: 'ä'.repeat(100), start: '2026-12-24', end: '', allDay: true, location: '' });
  for (const l of long.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75);
  assert.equal(icsText('a\nb'), 'a\\nb');
  assert.match(todoIcs({ title: 'Milch', due: '2026-11-14' }), /DUE;VALUE=DATE:20261114/);
});

test('parseCalendars: nur Kalender, Komponenten erkannt', () => {
  const xml = `<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response><d:href>/remote.php/dav/calendars/w/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
  <d:response><d:href>/remote.php/dav/calendars/w/personal/</d:href><d:propstat><d:prop><d:displayname>Persönlich</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set></d:prop></d:propstat></d:response>
  <d:response><d:href>/remote.php/dav/calendars/w/tasks/</d:href><d:propstat><d:prop><d:displayname>Aufgaben</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set></d:prop></d:propstat></d:response>
  </d:multistatus>`;
  assert.deepEqual(parseCalendars(xml), [
    { href: '/remote.php/dav/calendars/w/tasks/', name: 'Aufgaben', events: false, tasks: true },
    { href: '/remote.php/dav/calendars/w/personal/', name: 'Persönlich', events: true, tasks: false },
  ]);
});

test('cleanExtract verwirft Ungültiges', () => {
  const r = cleanExtract({ events: [{ title: 'X', start: 'morgen', end: '', allDay: false, location: '' }, { title: 'Y', start: '2026-11-14T19:00', end: '2026-11-14T18:00', allDay: false, location: '' }],
    tasks: [{ title: '', due: '' }, { title: 'Milch holen', due: 'bald' }], shopping: [{ name: 'Milch', spec: '2 l' }] });
  assert.deepEqual(r.events, [{ title: 'Y', start: '2026-11-14T19:00', end: '', allDay: false, location: '' }]);
  assert.deepEqual(r.tasks, [{ title: 'Milch holen', due: '' }]);
  assert.equal(r.shopping.length, 1);
});
