import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from './db.js';

const store = () => new Store(mkdtempSync(join(tmpdir(), 'inbox-test-')), randomBytes(32));
const chat = (s: Store, remoteId: string) => s.upsertChat({ accountId: s.listAccountRows()[0]?.id ?? s.createAccount('signal', 'Test'), network: 'signal', remoteId, title: remoteId, kind: 'direct', lastTs: 0, lastText: '' } as any);
const own = (s: Store, chatId: string, text: string) => s.upsertMessage({ chatId, remoteId: 'r' + Math.random(), senderId: 'me', senderName: 'Ich', fromMe: true, ts: Date.now(), text,
  replyToRemoteId: null, edited: false, deleted: false, attachments: [], status: 'sent' });

test('Entwurf: gesendete Nachricht löscht passenden Entwurf, späte Speicherung holt ihn nicht zurück', () => {
  const s = store(); const c = chat(s, 'x');
  const future = Date.now() + 30_000; // Uhr eines anderen Geräts geht vor
  s.setDraft(c.id, 'Danke ich ruf ihn mal an', future);
  assert.deepEqual(s.clearSentDraft(c.id, ['Danke  ich ruf ihn mal an ']), [c.id]);
  assert.equal(s.getChat(c.id)!.draft, null);
  assert.equal(s.setDraft(c.id, 'Danke ich ruf ihn mal an', future), false);
});

test('Entwurf: anderer Text bleibt stehen, Geister werden beim Start aufgeräumt', () => {
  const s = store(); const a = chat(s, 'a'), b = chat(s, 'b');
  s.setDraft(a.id, 'Noch nicht fertig', Date.now());
  assert.deepEqual(s.clearSentDraft(a.id, ['Etwas anderes']), []);
  assert.equal(s.getChat(a.id)!.draft, 'Noch nicht fertig');
  s.setDraft(b.id, 'Schon gesendet', Date.now());
  own(s, b.id, 'Schon gesendet');
  assert.equal(s.clearGhostDrafts(), 1);
  assert.equal(s.getChat(b.id)!.draft, null);
  assert.equal(s.getChat(a.id)!.draft, 'Noch nicht fertig');
});

test('Entwurf: gerade gesendete Texte werden erkannt', () => {
  const s = store(); const c = chat(s, 'r');
  own(s, c.id, 'Bin gleich da');
  assert.deepEqual(s.recentOwnTexts(c.id, 60_000), ['Bin gleich da']);
});
