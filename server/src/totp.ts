import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** TOTP nach RFC 6238 (SHA-1, 6 Stellen, 30 s), kompatibel mit allen gängigen Authenticator-Apps. */
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHA[(val << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const c of clean) {
    val = (val << 5) | ALPHA.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function newSecret(): string { return base32Encode(randomBytes(20)); }

export function codeAt(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return n.toString().padStart(6, '0');
}

export const stepNow = (t = Date.now()) => Math.floor(t / 30_000);

/** Prüft den Code (±1 Zeitfenster). Gibt das passende Zeitfenster zurück oder null. */
export function verify(secret: string, code: unknown, t = Date.now()): number | null {
  if (typeof code !== 'string') return null;
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = stepNow(t);
  for (const s of [now, now - 1, now + 1]) {
    if (timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(c))) return s;
  }
  return null;
}

export function otpauthUri(secret: string, account: string, issuer = 'Chorus'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
