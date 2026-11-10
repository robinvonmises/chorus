import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSize } from './imagesize.js';

test('Bildgröße aus PNG, GIF, WebP und JPEG (mit EXIF-Drehung)', () => {
  const png = Buffer.alloc(33); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  assert.deepEqual(imageSize(png), { width: 640, height: 480 });

  const gif = Buffer.alloc(13); gif.write('GIF89a', 0, 'latin1'); gif.writeUInt16LE(320, 6); gif.writeUInt16LE(200, 8);
  assert.deepEqual(imageSize(gif), { width: 320, height: 200 });

  const webp = Buffer.alloc(40); webp.write('RIFF', 0, 'latin1'); webp.write('WEBP', 8, 'latin1'); webp.write('VP8X', 12, 'latin1');
  webp.writeUIntLE(799, 24, 3); webp.writeUIntLE(599, 27, 3);
  assert.deepEqual(imageSize(webp), { width: 800, height: 600 });

  // JPEG: SOI, APP0 (Füllung), SOF0 mit 3000×4000
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x0f, 0xa0, 0x0b, 0xb8, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // Höhe 4000, Breite 3000
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  assert.deepEqual(imageSize(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])), { width: 3000, height: 4000 });

  // Dasselbe mit EXIF-Ausrichtung 6 (um 90° gedreht): Breite und Höhe getauscht
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('MM', 0, 'latin1'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4); tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(6, 18);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  assert.deepEqual(imageSize(Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof])), { width: 4000, height: 3000 });

  assert.equal(imageSize(Buffer.from('kein Bild')), null);
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff])), null);
});
