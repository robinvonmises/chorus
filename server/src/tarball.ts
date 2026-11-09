import { spawn } from 'node:child_process';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Arbeitsverzeichnis für Messenger-Schlüssel: bevorzugt /dev/shm (nur Arbeitsspeicher),
 * damit unverschlüsselte Schlüssel nie auf der Festplatte landen.
 */
export function secureTmpDir(): string {
  for (const base of ['/dev/shm', tmpdir()]) {
    try {
      accessSync(base, constants.W_OK);
      const d = join(base, 'inbox');
      mkdirSync(d, { recursive: true, mode: 0o700 });
      return d;
    } catch { /* nächster Versuch */ }
  }
  return tmpdir();
}

function run(cmd: string, args: string[], input?: Buffer, okCodes: number[] = [0]): Promise<{ out: Buffer; code: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (okCodes.includes(code ?? -1) ? resolve({ out: Buffer.concat(out), code: code ?? 0 }) : reject(new Error(`${cmd}: ${err.trim()}`))));
    p.stdin.on('error', () => {});
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

/**
 * Verzeichnis → base64(tar.gz).
 * Läuft der Messenger noch, ändern sich Dateien (z. B. die SQLite-WAL) während des Lesens.
 * GNU tar meldet das mit Code 1. Dann kurz warten und neu versuchen, beim letzten Versuch den Stand übernehmen.
 */
export async function packDir(dir: string, exclude: string[] = []): Promise<string> {
  for (let i = 0; ; i++) {
    const { out, code } = await run('tar', ['--warning=no-file-changed', '--warning=no-file-removed', ...exclude.map((e) => `--exclude=${e}`), '-czf', '-', '-C', dir, '.'], undefined, [0, 1]);
    if (code === 0 || i >= 4) return out.toString('base64');
    await new Promise((r) => setTimeout(r, 500 + i * 500));
  }
}

/** base64(tar.gz) → Verzeichnis */
export async function unpackDir(b64: string, dir: string): Promise<void> {
  await run('tar', ['-xzf', '-', '-C', dir], Buffer.from(b64, 'base64'));
}
