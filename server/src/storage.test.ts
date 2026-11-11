import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Storage, baseUrl, folderParts, numbered, parsePropfind } from './storage.js';

const fakeStore = () => {
  const m = new Map<string, unknown>();
  return { getSetting: (k: string, f: unknown) => (m.has(k) ? m.get(k) : f), setSetting: (k: string, v: unknown) => m.set(k, JSON.parse(JSON.stringify(v))) } as any;
};

test('Hilfen', () => {
  assert.equal(baseUrl('photos.example.com/api/', true), 'https://photos.example.com');
  assert.equal(baseUrl('http://10.0.0.2:2283'), 'http://10.0.0.2:2283');
  assert.deepEqual(folderParts('/Chorus/../Bilder//2026/'), ['Chorus', 'Bilder', '2026']);
  assert.equal(numbered('foto.jpg', 2), 'foto (2).jpg');
  assert.equal(numbered('README', 3), 'README (3)');
});

test('PROPFIND lesen', () => {
  const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/w/Fotos/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
<d:response><d:href>/remote.php/dav/files/w/Fotos/Urlaub%202026/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
<d:response><d:href>/remote.php/dav/files/w/Fotos/a&amp;b.pdf</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1234</d:getcontentlength><d:getcontenttype>application/pdf</d:getcontenttype><d:getlastmodified>Wed, 11 Nov 2026 10:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response></d:multistatus>`;
  const e = parsePropfind(xml);
  assert.equal(e.length, 3);
  assert.deepEqual(e[1], { name: 'Urlaub 2026', dir: true, size: 0, mime: '', modified: 0 });
  assert.equal(e[2].name, 'a&b.pdf');
  assert.equal(e[2].size, 1234);
  assert.equal(e[2].dir, false);
});

test('Schlüssel bleiben auf dem Server, leere Eingabe ändert nichts', () => {
  const s = new Storage(fakeStore());
  s.update({ immich: { enabled: true, url: 'x.de', key: 'geheim' } });
  const p = s.update({ immich: { key: '' } });
  assert.equal(JSON.stringify(p).includes('geheim'), false);
  assert.equal(p.immich.hasKey, true);
  assert.equal(p.immich.enabled, true);
});

test('Immich-Upload und Nextcloud-WebDAV gegen Attrappe', async () => {
  const seen: string[] = [];
  const files = new Set<string>();
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      seen.push(`${req.method} ${req.url}`);
      if (req.url === '/api/assets') {
        assert.equal(req.headers['x-api-key'], 'k1');
        assert.match(body, /name="deviceAssetId"[\s\S]*chorus-m1:0/);
        assert.match(body, /name="assetData"; filename="bild.jpg"/);
        res.writeHead(201, { 'Content-Type': 'application/json' }).end('{"id":"a","status":"created"}');
        return;
      }
      if (req.url?.startsWith('/remote.php/dav/files/wayne/')) {
        assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('wayne:pw').toString('base64'));
        if (req.method === 'MKCOL') { res.writeHead(files.has(req.url) ? 405 : 201).end(); files.add(req.url); return; }
        if (req.method === 'PUT') {
          if (files.has(req.url!) && req.headers['if-none-match'] === '*') { res.writeHead(412).end(); return; }
          files.add(req.url!); res.writeHead(201).end(); return;
        }
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const s = new Storage(fakeStore());
    s.update({ immich: { enabled: true, url: url + '/api', key: 'k1' }, nextcloud: { enabled: true, url, user: 'wayne', pass: 'pw', folder: 'Chorus/Dateien' } });
    const file = { data: Buffer.from('xyz'), name: 'bild.jpg', mime: 'image/jpeg', ts: 1_700_000_000_000, id: 'm1:0' };
    assert.equal(await s.save('immich', file), 'In Immich gespeichert');
    assert.equal(await s.save('nextcloud', { ...file, name: 'brief.pdf' }), 'In Nextcloud gespeichert (Chorus/Dateien/brief.pdf)');
    assert.equal(await s.save('nextcloud', { ...file, name: 'brief.pdf' }), 'In Nextcloud gespeichert (Chorus/Dateien/brief (2).pdf)');
    assert.ok(seen.includes('MKCOL /remote.php/dav/files/wayne/Chorus'));
    assert.equal(await s.save('nextcloud', { ...file, name: 'x.pdf', folder: '' }), 'In Nextcloud gespeichert (x.pdf)');
  } finally { srv.close(); }
});
