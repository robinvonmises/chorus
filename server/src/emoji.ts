import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Animierte Emojis (Noto Animated Emoji, Apache 2.0, animiertes WebP) für Reaktionen.
 *  Der Server lädt jede Animation einmal von Google und legt sie auf die Platte: Browser fragen nur Chorus,
 *  Google sieht keine Geräte. Unbekannte Emojis merken wir uns als „gibt es nicht“. */
const missing = new Set<string>();
const inflight = new Map<string, Promise<Buffer | null>>();

export function emojiCache(dataDir: string) {
  const dir = join(dataDir, 'emoji');
  return async (code: string): Promise<Buffer | null> => {
    if (!/^[0-9a-f]{2,6}(_[0-9a-f]{2,6}){0,9}$/.test(code) || missing.has(code)) return null;
    const file = join(dir, `${code}.webp`);
    if (existsSync(file)) return readFile(file);
    let p = inflight.get(code);
    if (!p) {
      p = (async () => {
        // Noto führt manche Emojis ohne Variationszeichen FE0F
        for (const c of [code, code.replace(/_fe0f/g, '')]) {
          const r = await fetch(`https://fonts.gstatic.com/s/e/notoemoji/latest/${c}/512.webp`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
          if (r?.ok && (r.headers.get('content-type') ?? '').includes('webp')) {
            const b = Buffer.from(await r.arrayBuffer());
            mkdirSync(dir, { recursive: true });
            await writeFile(file, b).catch(() => {});
            return b;
          }
          if (r && r.status !== 404) return null; // Netzfehler: später nochmal versuchen
        }
        missing.add(code);
        return null;
      })().finally(() => inflight.delete(code));
      inflight.set(code, p);
    }
    return p;
  };
}
