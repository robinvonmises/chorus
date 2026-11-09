import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Vault } from './vault.js';

/**
 * Profile: Jede Person hat ihren eigenen Tresor (eigenes Passwort, eigene Verschlüsselung,
 * eigene Messenger und KI-Schlüssel). Der Server kann die Daten anderer Profile nicht lesen.
 *
 * profiles.json (unverschlüsselt) enthält nur Name, Ordner und Admin-Kennzeichen.
 * Ein bestehender Einzel-Tresor (vault.json direkt im Datenordner) wird beim ersten Start
 * unverändert als erstes Profil übernommen (Ordner = Datenordner selbst).
 */
export interface ProfileEntry {
  id: string;
  name: string;
  dir: string;          // relativ zum Datenordner; '' = Datenordner selbst (übernommener Altbestand)
  admin: boolean;
  invite?: string;      // sha256 des Einladungscodes, solange noch kein Passwort gesetzt ist
  createdAt: string;
}

export class ProfileRegistry {
  private file: string;
  private list: ProfileEntry[] = [];
  private vaults = new Map<string, Vault>();

  constructor(private dataDir: string, firstName = process.env.FIRST_PROFILE_NAME ?? 'Ich') {
    this.file = join(dataDir, 'profiles.json');
    if (existsSync(this.file)) {
      this.list = JSON.parse(readFileSync(this.file, 'utf8'));
    } else if (existsSync(join(dataDir, 'vault.json'))) {
      // Übernahme: bisheriger Einzel-Tresor wird erstes Profil (Admin), Dateien bleiben, wo sie sind
      this.list = [{ id: 'p' + randomBytes(5).toString('hex'), name: firstName, dir: '', admin: true, createdAt: new Date().toISOString() }];
      this.save();
    }
  }

  private save() {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.list, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  all() { return [...this.list]; }
  get(id: string | undefined | null) { return id ? this.list.find((p) => p.id === id) : undefined; }
  get empty() { return this.list.length === 0; }
  dirOf(p: ProfileEntry) { return p.dir ? join(this.dataDir, p.dir) : this.dataDir; }

  vault(p: ProfileEntry): Vault {
    let v = this.vaults.get(p.id);
    if (!v) { mkdirSync(this.dirOf(p), { recursive: true }); v = new Vault(this.dirOf(p)); this.vaults.set(p.id, v); }
    return v;
  }

  /** Neues Profil. Ohne Einladung (erstes Profil) ist es sofort einrichtbar. */
  create(name: string, opts: { admin?: boolean; withInvite?: boolean } = {}): { profile: ProfileEntry; invite?: string } {
    const clean = name.trim().slice(0, 40);
    if (!clean) throw Object.assign(new Error('Bitte einen Namen eingeben'), { statusCode: 400 });
    if (this.list.some((p) => p.name.toLowerCase() === clean.toLowerCase())) throw Object.assign(new Error('Diesen Namen gibt es schon'), { statusCode: 409 });
    const id = 'p' + randomBytes(5).toString('hex');
    const invite = opts.withInvite ? makeInvite() : undefined;
    const profile: ProfileEntry = { id, name: clean, dir: join('profiles', id), admin: !!opts.admin, invite: invite ? hash(invite) : undefined, createdAt: new Date().toISOString() };
    this.list.push(profile);
    this.save();
    return { profile, invite };
  }

  newInvite(id: string): string {
    const p = this.get(id);
    if (!p) throw Object.assign(new Error('Profil nicht gefunden'), { statusCode: 404 });
    if (this.vault(p).initialized) throw Object.assign(new Error('Dieses Profil ist schon eingerichtet'), { statusCode: 400 });
    const invite = makeInvite();
    p.invite = hash(invite);
    this.save();
    return invite;
  }

  checkInvite(p: ProfileEntry, code: unknown): boolean {
    if (!p.invite) return true;
    if (typeof code !== 'string') return false;
    const a = Buffer.from(hash(code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')));
    const b = Buffer.from(p.invite);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  clearInvite(p: ProfileEntry) { delete p.invite; this.save(); }

  rename(id: string, name: string) {
    const p = this.get(id);
    if (!p) throw Object.assign(new Error('Profil nicht gefunden'), { statusCode: 404 });
    const clean = name.trim().slice(0, 40);
    if (!clean) throw Object.assign(new Error('Bitte einen Namen eingeben'), { statusCode: 400 });
    if (this.list.some((x) => x.id !== id && x.name.toLowerCase() === clean.toLowerCase())) throw Object.assign(new Error('Diesen Namen gibt es schon'), { statusCode: 409 });
    p.name = clean;
    this.save();
    return p;
  }

  /** Profilbild: liegt unverschlüsselt im Profilordner, weil es schon vor der Anmeldung angezeigt wird */
  avatarFile(p: ProfileEntry) { return join(this.dirOf(p), 'avatar.jpg'); }
  avatarVersion(p: ProfileEntry): number | null {
    const f = this.avatarFile(p);
    return existsSync(f) ? Math.round(statSync(f).mtimeMs) : null;
  }
  setAvatar(p: ProfileEntry, data: Buffer | null) {
    const f = this.avatarFile(p);
    if (!data) { rmSync(f, { force: true }); return; }
    mkdirSync(this.dirOf(p), { recursive: true });
    writeFileSync(f, data, { mode: 0o644 });
  }

  remove(id: string) {
    const p = this.get(id);
    if (!p) throw Object.assign(new Error('Profil nicht gefunden'), { statusCode: 404 });
    if (!p.dir) throw Object.assign(new Error('Das ursprüngliche Profil kann nicht gelöscht werden'), { statusCode: 400 });
    this.list = this.list.filter((x) => x.id !== id);
    this.save();
    this.vaults.delete(id);
    rmSync(this.dirOf(p), { recursive: true, force: true });
  }
}

const hash = (s: string) => createHash('sha256').update(s).digest('base64');
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeInvite(): string {
  const b = randomBytes(8);
  return [...b].map((x) => ALPHA[x % ALPHA.length]).join('');
}
