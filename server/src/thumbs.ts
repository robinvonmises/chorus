import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Kleine Vorschaubilder für Fotos und Videos im Chat (max. 720 px breit, JPEG).
 *  Ein Handyfoto hat oft 3–5 MB und 12 Megapixel; iOS braucht spürbar Zeit, so ein Bild bei jedem Öffnen
 *  eines Chats zu laden und zu entpacken. Die Vorschau ist ~50 KB groß und sofort da. */

const MAX_W = 720;
const cache = new Map<string, Buffer>();
const CACHE_MAX = 400; // ~50 KB je Bild → ~20 MB
const inflight = new Map<string, Promise<Buffer | null>>();
let running = 0;
const queue: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => queue.push(r));
  running++;
  try { return await fn(); } finally { running--; queue.shift()?.(); }
}

/** EXIF-Ausrichtung eines JPEG (1 = normal). ffmpeg 5 dreht Fotos nicht von selbst. */
function exifOrientation(b: Buffer): number {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let o = 2;
  while (o + 4 < b.length && b[o] === 0xff) {
    const marker = b[o + 1];
    const len = b.readUInt16BE(o + 2);
    if (marker === 0xe1 && b.toString('latin1', o + 4, o + 10) === 'Exif\0\0') {
      const t = o + 10;
      const le = b.toString('latin1', t, t + 2) === 'II';
      const u16 = (p: number) => (le ? b.readUInt16LE(p) : b.readUInt16BE(p));
      const u32 = (p: number) => (le ? b.readUInt32LE(p) : b.readUInt32BE(p));
      const ifd = t + u32(t + 4);
      if (ifd + 2 > b.length) return 1;
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 10 > b.length) break;
        if (u16(e) === 0x0112) return u16(e + 8) || 1;
      }
      return 1;
    }
    if (marker === 0xda) break;
    o += 2 + len;
  }
  return 1;
}
const ROTATE: Record<number, string> = { 2: 'hflip,', 3: 'hflip,vflip,', 4: 'vflip,', 5: 'transpose=0,', 6: 'transpose=1,', 7: 'transpose=3,', 8: 'transpose=2,' };

function run(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args]);
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 20000);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg: ' + err.trim().slice(-200))); });
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

const OUT = (rot = '') => ['-frames:v', '1', '-vf', `${rot}scale='min(${MAX_W},iw)':-2`, '-q:v', '5', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'];

async function make(data: Buffer, kind: 'image' | 'video'): Promise<Buffer | null> {
  if (kind === 'image') {
    // Schon klein genug: nichts zu gewinnen
    if (data.length < 150_000) return null;
    return run(['-noautorotate', '-i', 'pipe:0', ...OUT(ROTATE[exifOrientation(data)])], data);
  }
  // Videos brauchen eine echte Datei (MP4 vom iPhone hat das Inhaltsverzeichnis oft am Ende)
  const dir = await mkdtemp(join(tmpdir(), 'chorus-thumb-'));
  try {
    const f = join(dir, 'v');
    await writeFile(f, data);
    return await run(['-ss', '0.1', '-i', f, ...OUT()]).catch(() => run(['-i', f, ...OUT()]));
  } finally { rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/** Vorschau holen oder erzeugen. null = Original verwenden. */
export async function thumbnail(key: string, kind: 'image' | 'video', load: () => Promise<Buffer>): Promise<Buffer | null> {
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  let p = inflight.get(key);
  if (!p) {
    p = slot(async () => make(await load(), kind)).catch(() => null).then((b) => {
      inflight.delete(key);
      if (b) { cache.set(key, b); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!); }
      return b;
    });
    inflight.set(key, p);
  }
  return p;
}
