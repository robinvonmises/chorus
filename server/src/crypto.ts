import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** AES-256-GCM. Ausgabe: iv(12) | tag(16) | ciphertext */
export function seal(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function open(key: Buffer, sealed: Buffer): Buffer {
  const iv = sealed.subarray(0, 12);
  const tag = sealed.subarray(12, 28);
  const ct = sealed.subarray(28);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export function sealString(key: Buffer, s: string): string {
  return seal(key, Buffer.from(s, 'utf8')).toString('base64');
}

export function openString(key: Buffer, b64: string): string {
  return open(key, Buffer.from(b64, 'base64')).toString('utf8');
}

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Wiederherstellungscode wie "K7QF-2M9D-…" (6 Blöcke à 4 Zeichen, ~120 Bit) */
export function makeRecoveryCode(): string {
  const bytes = randomBytes(24);
  let out = '';
  for (let i = 0; i < 24; i++) {
    out += B32[bytes[i] % B32.length];
    if (i % 4 === 3 && i < 23) out += '-';
  }
  return out;
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{4})(?=.)/g, '$1-');
}

export function recoveryKey(code: string, salt: Buffer): Buffer {
  return scryptSync(normalizeRecoveryCode(code), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
