import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMentions, replaceMentions } from './mentions.js';

const people = [{ id: 'a', name: 'Anna' }, { id: 'al', name: 'Anna Lena' }, { id: 'm', name: 'Max Müller' }];

test('findet Erwähnungen, längster Name zuerst', () => {
  assert.deepEqual(findMentions('Hi @Anna Lena und @Max Müller!', people), [{ start: 3, length: 10, id: 'al' }, { start: 18, length: 11, id: 'm' }]);
  assert.deepEqual(findMentions('@anna kommst du?', people), [{ start: 0, length: 5, id: 'a' }]);
});

test('ignoriert E-Mail-Adressen und längere Wörter', () => {
  assert.deepEqual(findMentions('mail@Anna.de', people), []);
  assert.deepEqual(findMentions('@Annabell', people), []);
  assert.deepEqual(findMentions('ohne', people), []);
});

test('ersetzt Bereiche von hinten', () => {
  const t = 'Hi @Anna und @Max Müller';
  assert.equal(replaceMentions(t, findMentions(t, people), (m) => '@' + m.id), 'Hi @a und @m');
});
