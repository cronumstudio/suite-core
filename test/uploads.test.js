/**
 * Files people attach (uploads.js): what is accepted by its first bytes, the
 * upload streamed to disk (never half a file, never a refused one), serving
 * with headers that keep it from running on the app's domain, and the sweep
 * with the brakes that once saved everyone's photos.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectType, safeName, isImage, createUploads } from '../uploads.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 '), Buffer.alloc(20)]);
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj << >> endobj\n');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-uploads-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('what a file is, by its first bytes; never SVG', () => {
  assert.deepEqual(detectType(JPEG), { mime: 'image/jpeg', ext: 'jpg' });
  assert.deepEqual(detectType(PNG), { mime: 'image/png', ext: 'png' });
  assert.deepEqual(detectType(WEBP), { mime: 'image/webp', ext: 'webp' });
  assert.deepEqual(detectType(PDF), { mime: 'application/pdf', ext: 'pdf' });
  assert.equal(detectType(SVG), null);
  assert.equal(detectType(Buffer.from('MZ\x90\x00 an executable')), null);
  assert.equal(isImage('image/png'), true);
  assert.equal(isImage('application/pdf'), false);
});

test('names that can be written without fear', () => {
  assert.equal(safeName('Factura de la señora Núñez.pdf'), 'Factura-de-la-senora-Nunez.pdf');
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('..\\..\\windows\\win.ini'), 'win.ini', 'the same on every server');
  assert.equal(safeName('.hidden'), 'hidden');
  assert.equal(safeName(''), 'file');
  assert.equal(safeName('a'.repeat(200)).length, 60);
});

/** A server whose only route stores the body with `uploads.store`. */
async function uploadServer(t, uploads) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const stored = await uploads.store(req, { folder: url.searchParams.get('folder') || '1', name: url.searchParams.get('name') });
      res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify(stored));
    } catch (err) {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(err.status || 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.code || err.message, ...err.extra }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return (body, query = '') => fetch(`${base}/?${query}`, { method: 'POST', body })
    .then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }))
    .catch((err) => ({ status: 0, error: err }));
}

test('an upload is streamed to disk under the person’s folder, with a name nobody can guess', async (t) => {
  const dir = tmp(t);
  const uploads = createUploads({ dir, log: () => {} });
  const send = await uploadServer(t, uploads);

  const photo = await send(JPEG, 'folder=7&name=Foto de la cocina.jpg');
  assert.equal(photo.status, 201);
  assert.match(photo.data.path, /^7\/[\w-]{11}-Foto-de-la-cocina\.jpg$/);
  assert.deepEqual([photo.data.name, photo.data.mime, photo.data.size], ['Foto de la cocina.jpg', 'image/jpeg', JPEG.length]);
  assert.deepEqual(fs.readFileSync(uploads.resolve(photo.data.path)), JPEG);

  const noExtension = await send(PDF, 'name=contrato');
  assert.match(noExtension.data.path, /-contrato\.pdf$/, 'the extension its bytes say');
  const twice = await send(JPEG, 'folder=7&name=Foto de la cocina.jpg');
  assert.notEqual(twice.data.path, photo.data.path, 'the same name twice never overwrites');
  assert.deepEqual(fs.readdirSync(path.join(dir, '7')).filter((f) => f.endsWith('.partial')), []);
});

test('what isn’t accepted never touches the disk, and the answer says why', async (t) => {
  const dir = tmp(t);
  const uploads = createUploads({ dir, maxBytes: 1024, log: () => {} });
  const send = await uploadServer(t, uploads);

  const svg = await send(SVG, 'name=dibujo.svg');
  assert.deepEqual([svg.status, svg.data?.error], [400, 'file_type'], 'the connection isn’t cut: the page reads the reason');
  const empty = await send(Buffer.alloc(0), 'name=nada.jpg');
  assert.deepEqual([empty.status, empty.data?.error], [400, 'file_empty']);
  const big = await send(Buffer.concat([JPEG, Buffer.alloc(4096)]), 'name=grande.jpg');
  assert.ok(big.status === 413 || big.status === 0, `too big: refused or cut (${big.status})`);
  if (big.status === 413) assert.deepEqual(big.data, { error: 'file_too_large', max_mb: 0 });
  const files = fs.existsSync(path.join(dir, '1')) ? fs.readdirSync(path.join(dir, '1')) : [];
  assert.deepEqual(files, [], 'nothing left behind, not even a .partial');
});

test('a stored path must stay inside the folder', (t) => {
  const uploads = createUploads({ dir: tmp(t), log: () => {} });
  assert.ok(uploads.resolve('1/abc-foto.jpg').startsWith(uploads.dir));
  for (const bad of ['../outside.jpg', '1/../../outside.jpg', '/etc/passwd', '', null]) {
    assert.equal(uploads.resolve(bad), null, String(bad));
  }
  assert.equal(uploads.remove('../outside.jpg'), false);
});

test('serving: the type we say, never guessed; always revalidated; the name in UTF-8; a read that fails doesn’t kill the server', async (t) => {
  const dir = tmp(t);
  const lines = [];
  const uploads = createUploads({ dir, log: (l) => lines.push(l) });
  fs.mkdirSync(path.join(dir, '1'));
  fs.writeFileSync(path.join(dir, '1', 'abc-factura.pdf'), PDF);
  fs.mkdirSync(path.join(dir, '1', 'abc-carpeta.jpg'));   // stat works, reading doesn't (EISDIR)
  const files = {
    1: { id: 1, path: '1/abc-factura.pdf', name: 'Factura ñ "2026".pdf', mime: 'application/pdf' },
    2: { id: 2, path: '1/abc-no-esta.jpg', name: 'x.jpg', mime: 'image/jpeg' },
    3: { id: 3, path: '1/abc-carpeta.jpg', name: 'y.jpg', mime: 'image/jpeg' },
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      uploads.serve(req, res, files[url.searchParams.get('id')], { download: url.searchParams.get('download') === '1' });
    } catch (err) {
      res.writeHead(err.status || 500).end(err.code || err.message);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const shown = await fetch(`${base}/?id=1`);
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get('content-type'), 'application/pdf');
  assert.equal(shown.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(shown.headers.get('cache-control'), 'private, no-cache', 'the permission can change: always ask');
  assert.equal(shown.headers.get('content-disposition'),
    `inline; filename="Factura _ 2026.pdf"; filename*=UTF-8''${encodeURIComponent('Factura ñ "2026".pdf')}`);
  assert.deepEqual(Buffer.from(await shown.arrayBuffer()), PDF);
  const again = await fetch(`${base}/?id=1`, { headers: { 'If-None-Match': shown.headers.get('etag') } });
  assert.equal(again.status, 304);
  assert.match((await fetch(`${base}/?id=1&download=1`)).headers.get('content-disposition'), /^attachment; /);
  assert.deepEqual([(await fetch(`${base}/?id=2`)).status], [404], 'a record whose file is gone');

  // The headers already left, so the honest thing is to cut: a truncated download, and the server still up.
  const broken = await fetch(`${base}/?id=3`).then((r) => r.arrayBuffer()).then(() => 'read', () => 'cut');
  assert.equal(broken, 'cut');
  assert.equal((await fetch(`${base}/?id=1`)).status, 200, 'the server is still there');
  assert.ok(lines.some((l) => /could not read 1\/abc-carpeta\.jpg/.test(l)), lines.join(' | '));
});

test('the sweep takes loose old files, and refuses when the database looks wrong', (t) => {
  const dir = tmp(t);
  const lines = [];
  const uploads = createUploads({ dir, log: (l) => lines.push(l) });
  const folder = path.join(dir, '1');
  fs.mkdirSync(folder);
  const old = new Date(Date.now() - 5 * 86400e3);
  for (let i = 0; i < 12; i++) {
    fs.writeFileSync(path.join(folder, `foto${i}.jpg`), 'x');
    fs.utimesSync(path.join(folder, `foto${i}.jpg`), old, old);
  }
  const left = () => fs.readdirSync(folder).length;

  assert.equal(uploads.sweep([]), 0, 'a database that knows no file: nothing is deleted');
  assert.equal(left(), 12);
  assert.match(lines.at(-1), /SWEEP CANCELLED.*knows none/);
  assert.equal(uploads.sweep(['1/foto0.jpg', '1/foto1.jpg']), 0, 'more than half would go: nothing is deleted');
  assert.equal(left(), 12);
  assert.match(lines.at(-1), /SWEEP CANCELLED.*more than half/);

  const eleven = Array.from({ length: 11 }, (_, i) => `1/foto${i}.jpg`);
  assert.equal(uploads.sweep(eleven), 1, 'a loose file among live ones goes');
  assert.equal(left(), 11);
  fs.writeFileSync(path.join(folder, 'uploading-now.jpg'), 'x');
  assert.equal(uploads.sweep(eleven), 0, 'one written less than a day ago stays: it may be an upload halfway');
  assert.ok(fs.existsSync(path.join(folder, 'uploading-now.jpg')));
  assert.equal(createUploads({ dir: path.join(dir, 'nothing-here'), log: () => {} }).sweep(['a/b']), 0);
});
