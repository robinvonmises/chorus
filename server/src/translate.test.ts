import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessLang } from './translate.js';
import type { Chat } from './types.js';

const chat = (p: Partial<Chat>): Chat => ({ id: 'x', accountId: 'a', network: 'signal', remoteId: '', title: 'T', kind: 'direct', lastTs: 0, lastText: '', unread: 0, pinned: false, muted: false, ...p }) as Chat;

test('Sprache aus der Vorwahl', () => {
  assert.equal(guessLang(chat({ remoteId: '+31612345678' }))?.lang, 'nl');
  assert.equal(guessLang(chat({ network: 'whatsapp', remoteId: '31612345678@s.whatsapp.net' }))?.langName, 'Niederländisch');
  assert.equal(guessLang(chat({ remoteId: 'uuid-abc', info: { phone: '+44 7700 900123' } }))?.lang, 'en');
  assert.equal(guessLang(chat({ remoteId: '+380501234567' }))?.lang, 'uk'); // längste Vorwahl gewinnt
  assert.equal(guessLang(chat({ remoteId: '+491701234567' })), null); // Deutsch: nichts zu übersetzen
  assert.equal(guessLang(chat({ network: 'whatsapp', remoteId: '123456789012345@lid' })), null);
  assert.equal(guessLang(chat({ remoteId: '+31612345678', kind: 'group' })), null);
});
