import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { seal, open, makeRecoveryCode, recoveryKey } from './crypto.js';

/**
 * Tresor: Ein zufälliger Datenschlüssel (DEK) verschlüsselt alles auf der Platte.
 * Der DEK liegt nur verpackt auf dem Server:
 *  - mit dem Browser-Schlüssel (KEK, im Browser per PBKDF2 aus dem Passwort abgeleitet)
 *  - mit dem Wiederherstellungscode
 *  - optional (Komfort-Modus) mit einem Server-Schlüssel, damit nach Neustart sofort empfangen wird
 * Der Server kennt den DEK nur im Arbeitsspeicher, solange entsperrt.
 */
export interface VaultFile {
  version: 1;
  kdf: { alg: 'PBKDF2-SHA256'; iterations: number; salt: string };
  wrapped: string; // DEK mit KEK
  recovery: { salt: string; wrapped: string };
  comfort?: { wrapped: string }; // DEK mit server.key
  totp?: { secret: string; since: string }; // Zwei-Faktor (Authenticator-App)
  trusted?: { hash: string; exp: number }[]; // Geräte, die 30 Tage keinen Code brauchen
  createdAt: string;
}

export const PBKDF2_ITERATIONS = 600_000;

export class Vault {
  private file: string;
  private keyFile: string;
  private dek: Buffer | null = null;
  private listeners: ((dek: Buffer) => void)[] = [];

  constructor(private dataDir: string) {
    this.file = join(dataDir, 'vault.json');
    this.keyFile = join(dataDir, 'server.key');
  }

  get initialized() { return existsSync(this.file); }
  get unlocked() { return this.dek !== null; }
  get key(): Buffer {
    if (!this.dek) throw new Error('Tresor ist gesperrt');
    return this.dek;
  }

  private read(): VaultFile { return JSON.parse(readFileSync(this.file, 'utf8')); }
  private write(v: VaultFile) {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Öffentliche Parameter, damit der Browser seinen Schlüssel ableiten kann */
  kdfParams() {
    if (!this.initialized) return null;
    return this.read().kdf;
  }

  get comfortMode() { return this.initialized && !!this.read().comfort; }

  onUnlock(fn: (dek: Buffer) => void) { this.listeners.push(fn); }
  private fireUnlock() { for (const l of this.listeners) l(this.dek!); }

  /** Ersteinrichtung. salt kommt vom Browser, kek ist bereits abgeleitet. */
  setup(saltB64: string, kek: Buffer): string {
    if (this.initialized) throw new Error('Tresor existiert bereits');
    if (kek.length !== 32) throw new Error('Ungültiger Schlüssel');
    const dek = randomBytes(32);
    const code = makeRecoveryCode();
    const rsalt = randomBytes(16);
    this.write({
      version: 1,
      kdf: { alg: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: saltB64 },
      wrapped: seal(kek, dek).toString('base64'),
      recovery: { salt: rsalt.toString('base64'), wrapped: seal(recoveryKey(code, rsalt), dek).toString('base64') },
      createdAt: new Date().toISOString(),
    });
    this.dek = dek;
    this.fireUnlock();
    return code;
  }

  /** Prüft das Passwort, ohne zu entsperren */
  check(kek: Buffer): boolean {
    try { open(kek, Buffer.from(this.read().wrapped, 'base64')); return true; } catch { return false; }
  }

  // ---------- Zwei-Faktor ----------
  get totpSecret(): string | null { return this.initialized ? this.read().totp?.secret ?? null : null; }
  setTotp(secret: string | null) {
    const v = this.read();
    if (secret) v.totp = { secret, since: new Date().toISOString() }; else delete v.totp;
    delete v.trusted;
    this.write(v);
  }
  private static h(t: string) { return createHash('sha256').update(t).digest('base64'); }
  addTrusted(days = 30): string {
    const v = this.read();
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    v.trusted = [...(v.trusted ?? []).filter((t) => t.exp > now), { hash: Vault.h(token), exp: now + days * 86_400_000 }].slice(-20);
    this.write(v);
    return token;
  }
  isTrusted(token: string | undefined): boolean {
    if (!token) return false;
    const h = Vault.h(token);
    return (this.read().trusted ?? []).some((t) => t.hash === h && t.exp > Date.now());
  }

  unlock(kek: Buffer): boolean {
    try {
      const dek = open(kek, Buffer.from(this.read().wrapped, 'base64'));
      if (!this.dek) { this.dek = dek; this.fireUnlock(); }
      return true;
    } catch { return false; }
  }

  /** Mit Wiederherstellungscode entsperren und neuen Browser-Schlüssel (neues Passwort) setzen */
  recover(code: string, newSaltB64: string, newKek: Buffer): boolean {
    const v = this.read();
    let dek: Buffer;
    try {
      dek = open(recoveryKey(code, Buffer.from(v.recovery.salt, 'base64')), Buffer.from(v.recovery.wrapped, 'base64'));
    } catch { return false; }
    v.kdf = { alg: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: newSaltB64 };
    v.wrapped = seal(newKek, dek).toString('base64');
    delete v.totp; // Wiederherstellung = Zugang verloren, 2FA wird neu eingerichtet
    delete v.trusted;
    this.write(v);
    if (!this.dek) { this.dek = dek; this.fireUnlock(); }
    return true;
  }

  changePassword(newSaltB64: string, newKek: Buffer) {
    const v = this.read();
    v.kdf = { alg: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: newSaltB64 };
    v.wrapped = seal(newKek, this.key).toString('base64');
    this.write(v);
  }

  /** Komfort-Modus: DEK zusätzlich mit Server-Schlüssel ablegen → Auto-Entsperren nach Neustart */
  setComfort(on: boolean) {
    const v = this.read();
    if (on) {
      let sk: Buffer;
      if (existsSync(this.keyFile)) sk = readFileSync(this.keyFile);
      else { sk = randomBytes(32); writeFileSync(this.keyFile, sk, { mode: 0o600 }); }
      v.comfort = { wrapped: seal(sk, this.key).toString('base64') };
    } else {
      delete v.comfort;
    }
    this.write(v);
  }

  /** Beim Start: im Komfort-Modus automatisch entsperren */
  tryAutoUnlock(): boolean {
    if (!this.initialized) return false;
    const v = this.read();
    if (!v.comfort || !existsSync(this.keyFile)) return false;
    try {
      this.dek = open(readFileSync(this.keyFile), Buffer.from(v.comfort.wrapped, 'base64'));
      this.fireUnlock();
      return true;
    } catch { return false; }
  }

  lock() { this.dek = null; }
}
