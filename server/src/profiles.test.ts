import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Vault } from './vault.js';
import { ProfileRegistry } from './profiles.js';

test('Profile: bestehender Tresor wird erstes Profil, Einladungen, Löschen', () => {
  const d = mkdtempSync(join(tmpdir(), 'chorus-prof-'));
  const kek = randomBytes(32);
  new Vault(d).setup('c2FsdA==', kek);
  const r = new ProfileRegistry(d, 'Wayne');
  const [w] = r.all();
  assert.equal(w.name, 'Wayne');
  assert.equal(w.dir, '');
  assert.equal(w.admin, true);
  assert.equal(r.vault(w).check(kek), true);
  // nach Neustart gleiche Daten
  assert.deepEqual(new ProfileRegistry(d, 'Anders').all(), r.all());

  const { profile: a, invite } = r.create('Anna', { withInvite: true });
  assert.ok(invite && invite.length === 8);
  assert.equal(r.checkInvite(a, 'falsch'), false);
  assert.equal(r.checkInvite(a, invite!.toLowerCase().replace(/(.{4})/, '$1-')), true);
  assert.throws(() => r.create('anna'), /schon/);
  r.vault(a).setup('c2FsdA==', randomBytes(32));
  assert.ok(existsSync(join(d, a.dir, 'vault.json')));
  assert.throws(() => r.remove(w.id), /ursprüngliche/);
  r.remove(a.id);
  assert.equal(existsSync(join(d, a.dir)), false);
  assert.equal(r.all().length, 1);
});
