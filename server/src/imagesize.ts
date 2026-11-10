/**
 * Breite und Höhe eines Bildes aus den ersten Bytes lesen (PNG, JPEG, GIF, WebP).
 * Damit kann die Oberfläche den Platz für ein Bild freihalten, bevor es geladen ist, und der Chat springt nicht.
 * JPEG: Die EXIF-Drehung wird beachtet (Hochkant-Fotos vom Handy liegen oft quer in der Datei).
 */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  try {
    const ok = (w: number, h: number) => (w > 0 && h > 0 && w < 65536 && h < 65536 ? { width: w, height: h } : null);
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return ok(b.readUInt32BE(16), b.readUInt32BE(20));
    if (b.length > 10 && b.toString('latin1', 0, 3) === 'GIF') return ok(b.readUInt16LE(6), b.readUInt16LE(8));
    if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const t = b.toString('latin1', 12, 16);
      if (t === 'VP8X') return ok(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
      if (t === 'VP8 ') return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
      if (t === 'VP8L') { const n = b.readUInt32LE(21); return ok(1 + (n & 0x3fff), 1 + ((n >> 14) & 0x3fff)); }
      return null;
    }
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let rotated = false;
      for (let p = 2; p + 9 < b.length;) {
        if (b[p] !== 0xff) return null;
        const m = b[p + 1];
        if (m === 0xff) { p++; continue; }
        if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue; }
        const len = b.readUInt16BE(p + 2);
        if (m === 0xe1 && b.toString('latin1', p + 4, p + 8) === 'Exif') rotated = exifRotated(b.subarray(p + 10, p + 2 + len));
        // SOF0–SOF15 außer DHT (C4), JPG (C8) und DAC (CC)
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          const h = b.readUInt16BE(p + 5), w = b.readUInt16BE(p + 7);
          return rotated ? ok(h, w) : ok(w, h);
        }
        if (m === 0xda || len < 2) return null;
        p += 2 + len;
      }
    }
  } catch { /* abgeschnittene oder kaputte Datei */ }
  return null;
}

/** EXIF-Ausrichtung 5–8 = um 90° gedreht, Breite und Höhe tauschen */
function exifRotated(t: Buffer): boolean {
  if (t.length < 14) return false;
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ifd = u32(4);
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) break;
    if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 5 && v <= 8; }
  }
  return false;
}
