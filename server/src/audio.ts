import { spawn } from 'node:child_process';

/** Opus/Ogg wie von WhatsApp-Apps: Mono, 48 kHz, Sprachmodus, saubere Zeitstempel, keine fremden Metadaten */
const OPUS_ARGS = ['-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-avoid_negative_ts', 'make_zero', '-f', 'ogg', 'pipe:1'];

/** Wandelt beliebiges Audio in OGG/Opus (Mono, 48 kHz) – das Format, das alle Messenger für Sprachnachrichten erwarten. */
export function toOggOpus(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...OPUS_ARGS]);
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg: ' + err.trim()))));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

/** Wie toOggOpus, liefert zusätzlich die Länge in Sekunden (für Sprachnachrichten). */
export function toOggOpusTimed(input: Buffer): Promise<{ data: Buffer; durationSec: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-i', 'pipe:0', ...OPUS_ARGS]);
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg: ' + err.trim().split('\n').slice(-3).join(' ')));
      const t = [...err.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop();
      const durationSec = t ? Math.max(1, Math.round(+t[1] * 3600 + +t[2] * 60 + +t[3])) : 1;
      resolve({ data: Buffer.concat(out), durationSec });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

/** Signal-Sprachnachricht: AAC (ADTS), Mono – so nehmen die Signal-Apps selbst auf und können es überall abspielen.
 *  OGG/Opus zeigt Signal auf dem iPhone nur als Datei an. */
export function toAac(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0', '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '44100', '-c:a', 'aac', '-b:a', '48k', '-f', 'adts', 'pipe:1']);
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg: ' + err.trim()))));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

/** Für Safari/iOS: Opus/OGG (WhatsApp, Telegram) in MP3 umwandeln, das jeder Browser abspielt. */
export function toMp3(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1']);
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg: ' + err.trim()))));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

export type VideoEdit = { start: number; end: number; crop?: { x: number; y: number; w: number; h: number } };

/** Prüft die Angaben aus dem Browser (Zeiten in Sekunden, Zuschnitt in Anteilen 0–1) */
export function parseVideoEdit(raw: string | undefined): VideoEdit | null {
  if (!raw) return null;
  let v: any;
  try { v = JSON.parse(raw); } catch { return null; }
  const num = (x: any, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : null);
  const start = num(v?.start, 0, 86_400), end = num(v?.end, 0, 86_400);
  if (start == null || end == null || end - start < 0.2) return null;
  let crop: VideoEdit['crop'];
  if (v.crop) {
    const x = num(v.crop.x, 0, 1), y = num(v.crop.y, 0, 1), w = num(v.crop.w, 0.02, 1), h = num(v.crop.h, 0.02, 1);
    if (x != null && y != null && w != null && h != null) crop = { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
  }
  return { start, end, crop };
}

/**
 * Video kürzen und zuschneiden → MP4 (H.264/AAC), das jeder Messenger und jedes Handy abspielt.
 * Die lange Seite wird auf höchstens 1920 px begrenzt, damit es auf dem kleinen Server zügig geht.
 * MP4/MOV lassen sich nicht aus einer Pipe lesen (Index am Dateiende), daher kurz als Temp-Datei.
 */
export async function editVideo(input: Buffer, e: VideoEdit): Promise<Buffer> {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'chorus-video-'));
  const src = join(dir, 'in'), dst = join(dir, 'out.mp4');
  try {
    await writeFile(src, input, { mode: 0o600 });
    const vf: string[] = [];
    if (e.crop) {
      const { x, y, w, h } = e.crop;
      vf.push(`crop=trunc(iw*${w.toFixed(5)}/2)*2:trunc(ih*${h.toFixed(5)}/2)*2:trunc(iw*${x.toFixed(5)}):trunc(ih*${y.toFixed(5)})`);
    }
    vf.push("scale=w='if(gte(iw,ih),min(1920,iw),-2)':h='if(gte(iw,ih),-2,min(1920,ih))'", 'format=yuv420p');
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-ss', e.start.toFixed(3), '-i', src, '-t', (e.end - e.start).toFixed(3),
      '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-map_metadata', '-1', dst];
    await new Promise<void>((resolve, reject) => {
      const p = spawn('ffmpeg', args);
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Video konnte nicht geschnitten werden: ' + err.trim().split('\n').slice(-2).join(' ')))));
    });
    return await readFile(dst);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Wellenform für Sprachnachrichten: 64 Werte von 0 bis 100 (WhatsApp zeigt sie als Balken) */
export function waveform(input: Buffer, bars = 64): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg: ' + err.trim()));
      const pcm = Buffer.concat(out);
      const n = Math.floor(pcm.length / 2);
      const per = Math.max(1, Math.floor(n / bars));
      const avg: number[] = [];
      for (let b = 0; b < bars; b++) {
        let sum = 0, cnt = 0;
        for (let i = b * per; i < Math.min(n, (b + 1) * per); i++) { sum += Math.abs(pcm.readInt16LE(i * 2)); cnt++; }
        avg.push(cnt ? sum / cnt : 0);
      }
      const max = Math.max(1, ...avg);
      resolve(Uint8Array.from(avg.map((v) => Math.round((v / max) * 100))));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}
