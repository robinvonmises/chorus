import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Encode, base32Decode, codeAt, verify, newSecret } from './totp.js';

test('TOTP: RFC-6238-Testwerte', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(codeAt(secret, Math.floor(59 / 30)), '287082');
  assert.equal(codeAt(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(codeAt(secret, Math.floor(2000000000 / 30)), '279037');
  assert.deepEqual(base32Decode(secret), Buffer.from('12345678901234567890'));
});

test('TOTP: prüfen mit Zeitfenster', () => {
  const s = newSecret();
  const t = Date.now();
  const step = Math.floor(t / 30000);
  assert.equal(verify(s, codeAt(s, step), t), step);
  assert.equal(verify(s, codeAt(s, step - 1), t), step - 1);
  assert.equal(verify(s, codeAt(s, step - 3), t), null);
  assert.equal(verify(s, '12a456', t), null);
  assert.equal(verify(s, undefined, t), null);
});
