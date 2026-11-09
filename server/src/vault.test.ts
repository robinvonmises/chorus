import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Vault } from './vault.js';
import { Store } from './db.js';

const dir = () => mkdtempSync(join(tmpdir(), 'inbox-test-'));

test('Tresor: einrichten, entsperren, falsches Passwort', () => {
  const d = dir();
  const kek = randomBytes(32);
  const v = new Vault(d);
  const code = v.setup('c2FsdA==', kek);
  assert.match(code, /^([A-Z0-9]{4}-){5}[A-Z0-9]{4}$/);
  const dek = v.key;

  const v2 = new Vault(d);
  assert.equal(v2.unlocked, false);
  assert.equal(v2.unlock(randomBytes(32)), false);
  assert.equal(v2.unlock(kek), true);
  assert.deepEqual(v2.key, dek);
  // Der Datenschlüssel steht nirgends im Klartext
  assert.equal(readFileSync(join(d, 'vault.json'), 'utf8').includes(dek.toString('base64')), false);
});

test('Tresor: Wiederherstellungscode setzt neues Passwort', () => {
  const d = dir();
  const v = new Vault(d);
  const code = v.setup('c2FsdA==', randomBytes(32));
  const dek = v.key;
  const v2 = new Vault(d);
  assert.equal(v2.recover('FALSCH', 'bmV1', randomBytes(32)), false);
  const newKek = randomBytes(32);
  assert.equal(v2.recover(code.toLowerCase().replace(/-/g, ' '), 'bmV1', newKek), true);
  const v3 = new Vault(d);
  assert.equal(v3.unlock(newKek), true);
  assert.deepEqual(v3.key, dek);
});

test('Tresor: Komfort-Modus entsperrt nach Neustart automatisch', () => {
  const d = dir();
  const v = new Vault(d);
  v.setup('c2FsdA==', randomBytes(32));
  assert.equal(new Vault(d).tryAutoUnlock(), false);
  v.setComfort(true);
  assert.equal(new Vault(d).tryAutoUnlock(), true);
  v.setComfort(false);
  assert.equal(new Vault(d).tryAutoUnlock(), false);
});

test('Datenbank und Dateien sind verschlüsselt', () => {
  const d = dir();
  const key = randomBytes(32);
  const s = new Store(d, key);
  const acc = s.createAccount('demo', 'Demo');
  s.upsertChat({ accountId: acc, network: 'demo', remoteId: 'x', title: 'Geheimer Chat', kind: 'direct', lastTs: 1, lastText: 'streng geheim' });
  const fid = s.storeFile(Buffer.from('Dateiinhalt geheim'));
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  s.close();
  const raw = readFileSync(join(d, 'inbox.db'));
  assert.equal(raw.includes(Buffer.from('Geheimer Chat')), false);
  assert.equal(raw.subarray(0, 13).toString('latin1') === 'SQLite format', false);
  const f = readFileSync(join(d, 'files', fid));
  assert.equal(f.includes(Buffer.from('geheim')), false);
  // Mit richtigem Schlüssel lesbar, mit falschem nicht
  const s2 = new Store(d, key);
  assert.equal(s2.listChats()[0].title, 'Geheimer Chat');
  assert.equal(s2.readFile(fid)!.toString(), 'Dateiinhalt geheim');
  s2.close();
  assert.throws(() => new Store(d, randomBytes(32)));
  assert.ok(readdirSync(join(d, 'files')).length === 1);
});

test('Tresor: Zwei-Faktor und vertraute Geräte', () => {
  const d = dir();
  const kek = randomBytes(32);
  const v = new Vault(d);
  const code = v.setup('c2FsdA==', kek);
  assert.equal(v.totpSecret, null);
  assert.equal(v.check(kek), true);
  assert.equal(v.check(randomBytes(32)), false);
  v.setTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(new Vault(d).totpSecret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const tok = v.addTrusted();
  assert.equal(v.isTrusted(tok), true);
  assert.equal(v.isTrusted('falsch'), false);
  assert.equal(v.isTrusted(undefined), false);
  // Wiederherstellung schaltet 2FA ab
  assert.equal(v.recover(code, 'c2FsdA==', randomBytes(32)), true);
  assert.equal(v.totpSecret, null);
  assert.equal(v.isTrusted(tok), false);
});
