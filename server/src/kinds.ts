import type { Attachment } from './types.js';

/** Als Datei gesendete Fotos/Videos (z. B. „als Dokument“ oder ohne Typ) trotzdem als Bild/Video zeigen */
const EXT: Record<string, Attachment['kind']> = { jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', heic: 'image', heif: 'image', mp4: 'video', mov: 'video', m4v: 'video', webm: 'video', mp3: 'audio', m4a: 'audio', ogg: 'audio', opus: 'audio', aac: 'audio', wav: 'audio' };
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', aac: 'audio/aac', wav: 'audio/wav' };
export function fixKind(a: Attachment): Attachment {
  if (a.kind !== 'file') return a;
  const ext = (a.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  const generic = !a.mime || a.mime === 'application/octet-stream';
  const mime = generic && MIME[ext] ? MIME[ext] : a.mime;
  const kind = mime.startsWith('image/') && mime !== 'image/svg+xml' ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : generic ? EXT[ext] ?? 'file' : 'file';
  return kind === 'file' && mime === a.mime ? a : { ...a, kind, mime };
}

/** Anhand der ersten Bytes erkennen, ob eine „Datei“ eigentlich ein Bild/Video/Audio ist */
export function sniffKind(a: Attachment, data: Buffer): Attachment {
  if (a.kind !== 'file') return a;
  const h = data.subarray(0, 12);
  const is = (sig: number[], off = 0) => sig.every((b, i) => h[off + i] === b);
  let mime: string | null = null;
  if (is([0xff, 0xd8, 0xff])) mime = 'image/jpeg';
  else if (is([0x89, 0x50, 0x4e, 0x47])) mime = 'image/png';
  else if (is([0x47, 0x49, 0x46, 0x38])) mime = 'image/gif';
  else if (is([0x52, 0x49, 0x46, 0x46]) && is([0x57, 0x45, 0x42, 0x50], 8)) mime = 'image/webp';
  else if (is([0x66, 0x74, 0x79, 0x70], 4)) { const brand = h.subarray(8, 12).toString('latin1'); mime = /hei|mif/.test(brand) ? 'image/heic' : /M4A/.test(brand) ? 'audio/mp4' : brand === 'qt  ' ? 'video/quicktime' : 'video/mp4'; }
  else if (is([0x4f, 0x67, 0x67, 0x53])) mime = 'audio/ogg';
  else if (is([0x49, 0x44, 0x33]) || is([0xff, 0xfb])) mime = 'audio/mpeg';
  return mime ? fixKind({ ...a, mime }) : a;
}
