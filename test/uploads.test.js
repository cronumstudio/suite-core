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
import {
  detectType, safeName, isImage, createUploads, isPublicAddress, openUrl, nameFromResponse,
} from '../uploads.js';

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

/* ------------------------------ from a link ------------------------------- */

test('only addresses on the public internet are fetched from, in IPv4 and IPv6', () => {
  const pub = [
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '11.0.0.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1',
    '192.169.0.1', '198.20.0.1', '223.255.255.255',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::200e',
    '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1',
  ];
  const inside = [
    '0.0.0.0', '0.1.2.3', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.0.9', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.0.0.8', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.19.255.1',
    '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::127.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
    '64:ff9b::a00:1', '64:ff9b:1::1', '2002:c0a8:101::1', '2002:7f00:1::',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1', '100::1',
    '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1', '3fff::1',
    '', 'localhost', 'not an address', '1.2.3', '256.1.1.1', null, undefined,
  ];
  assert.deepEqual(pub.filter((ip) => !isPublicAddress(ip)), [], 'public ones are public');
  assert.deepEqual(inside.filter((ip) => isPublicAddress(ip)), [], 'everything else is somebody’s inside');
});

test('a file’s name from a link: what the site says, else the last part of the path, else "file"', () => {
  const at = (u) => new URL(u);
  assert.equal(nameFromResponse('attachment; filename="Factura marzo.pdf"', at('https://x.example/d?id=1')), 'Factura marzo.pdf');
  assert.equal(nameFromResponse("inline; filename=\"a.pdf\"; filename*=UTF-8''Se%C3%B1ora%20N%C3%BA%C3%B1ez.pdf", at('https://x.example/')),
    'Señora Núñez.pdf', 'the encoded one wins');
  assert.equal(nameFromResponse('attachment; filename=plain.png', at('https://x.example/')), 'plain.png');
  assert.equal(nameFromResponse('attachment; filename="../../etc/passwd"', at('https://x.example/')), 'passwd', 'a name, never a path');
  assert.equal(nameFromResponse(undefined, at('https://x.example/photos/Kitchen%20sink.jpg?size=2')), 'Kitchen sink.jpg');
  assert.equal(nameFromResponse('', at('https://x.example/')), 'file');
});

/**
 * A site with files to download, reached under made-up names that the test's
 * lookup sends to 127.0.0.1: `files.test` may be private (the test's
 * override), `inside.test` may not, as the real internet would have it.
 */
async function fileSite(t) {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    const port = server.address().port;
    const send = (status, body, headers = {}) => res.writeHead(status, { 'Content-Length': body.length, ...headers }).end(body);
    switch (pathname) {
      case '/photo.jpg': return send(200, JPEG, { 'Content-Type': 'image/jpeg' });
      case '/download': return send(200, PDF, { 'Content-Disposition': 'attachment; filename="Receipt.pdf"' });
      case '/moved': return send(302, Buffer.alloc(0), { Location: '/photo.jpg' });
      case '/far': return send(301, Buffer.alloc(0), { Location: `http://files.test:${port}/moved` });
      case '/loop': return send(302, Buffer.alloc(0), { Location: '/loop' });
      case '/inside': return send(302, Buffer.alloc(0), { Location: `http://inside.test:${port}/photo.jpg` });
      case '/loopback': return send(307, Buffer.alloc(0), { Location: `http://127.0.0.1:${port}/photo.jpg` });
      case '/ftp': return send(302, Buffer.alloc(0), { Location: 'ftp://files.test/photo.jpg' });
      case '/page': return send(200, Buffer.from('<!doctype html><title>A photo, honestly</title>'), { 'Content-Type': 'image/jpeg' });
      case '/huge': return send(200, Buffer.alloc(5000, 1), { 'Content-Type': 'application/pdf' });
      case '/growing':
        // No Content-Length: only reading tells how big it is.
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.write(JPEG);
        res.end(Buffer.alloc(5000, 7));
        return undefined;
      case '/cut':
        res.writeHead(200, { 'Content-Length': 500 });
        res.write(JPEG);
        setTimeout(() => res.socket.destroy(), 50);
        return undefined;
      case '/slow': return undefined;   // never answers
      case '/drip':
        res.writeHead(200, { 'Content-Length': 500 });
        res.write(JPEG);
        return undefined;               // and nothing more
      default: return send(404, Buffer.from('no'));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const asked = [];
  const options = {
    lookup: async (host) => { asked.push(host); return [{ address: '127.0.0.1', family: 4 }]; },
    allowPrivate: (host) => host === 'files.test',
  };
  return { base: `http://files.test:${server.address().port}`, port: server.address().port, options, asked };
}

const failure = (promise) => promise.then(() => null, (err) => ({ status: err.status, code: err.code, ...err.extra }));

test('a file from a link is downloaded into the folder like an upload, and only what is an image or a PDF is kept', async (t) => {
  const dir = tmp(t);
  const uploads = createUploads({ dir, maxBytes: 1000, log: () => {} });
  const site = await fileSite(t);
  const fetchInto = async (pathname, extra = {}) => {
    const file = await uploads.fromUrl(`${site.base}${pathname}`, { ...site.options, ...extra });
    return { name: file.name, stored: await uploads.store(file.stream, { folder: '3', name: file.name }) };
  };

  const photo = await fetchInto('/photo.jpg');
  assert.equal(photo.name, 'photo.jpg');
  assert.deepEqual([photo.stored.mime, photo.stored.size], ['image/jpeg', JPEG.length]);
  assert.deepEqual(fs.readFileSync(uploads.resolve(photo.stored.path)), JPEG);
  assert.equal((await fetchInto('/download')).stored.name, 'Receipt.pdf', 'the name the site gives');

  site.asked.length = 0;
  const moved = await fetchInto('/far');
  assert.equal(moved.name, 'photo.jpg', 'two redirects followed');
  assert.equal(site.asked.length, 3, 'every hop is looked up and checked again');

  assert.deepEqual(await failure(fetchInto('/loop')), { status: 400, code: 'file_url_unreachable' }, 'at most three redirects');
  assert.deepEqual(await failure(fetchInto('/inside')), { status: 400, code: 'file_url_private' },
    'a link that redirects inside a network is refused');
  assert.deepEqual(await failure(fetchInto('/loopback')), { status: 400, code: 'file_url_private' });
  assert.deepEqual(await failure(fetchInto('/ftp')), { status: 400, code: 'file_url' });
  assert.deepEqual(await failure(fetchInto('/missing')), { status: 400, code: 'file_url_status', status: 404 });
  assert.deepEqual(await failure(fetchInto('/huge')), { status: 413, code: 'file_too_large', max_mb: 0 },
    'its Content-Length says too big: refused before reading');
  assert.deepEqual(await failure(fetchInto('/growing')), { status: 413, code: 'file_too_large', max_mb: 0 },
    'too big once read');
  assert.deepEqual(await failure(fetchInto('/page')), { status: 400, code: 'file_type' }, 'a page is not a photo, whatever it says');
  assert.deepEqual(await failure(fetchInto('/cut')), { status: 400, code: 'upload_cut' }, 'a download cut halfway');
  assert.deepEqual(await failure(fetchInto('/slow', { headersTimeout: 100 })), { status: 400, code: 'file_url_unreachable' },
    'a site that doesn’t answer');
  assert.deepEqual(await failure(fetchInto('/drip', { timeout: 300 })), { status: 400, code: 'file_url_unreachable' },
    'a download that never ends runs out of time');
  // Nothing refused was left behind, not even half.
  assert.deepEqual(fs.readdirSync(path.join(dir, '3')).filter((f) => f.endsWith('.partial')), []);
  assert.equal(fs.readdirSync(path.join(dir, '3')).length, 3);
});

test('a link to a private address is refused without the test’s override, and a download nobody reads is closed', async (t) => {
  const site = await fileSite(t);
  for (const url of [`http://127.0.0.1:${site.port}/photo.jpg`, `http://[::1]:${site.port}/photo.jpg`,
    'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:10.0.0.1]/']) {
    assert.deepEqual(await failure(openUrl(url)), { status: 400, code: 'file_url_private' }, url);
  }
  assert.deepEqual(await failure(openUrl(`http://localhost:${site.port}/photo.jpg`)), { status: 400, code: 'file_url_private' },
    'a name that resolves inside, by the real resolver');
  assert.deepEqual(await failure(openUrl(`${site.base}/photo.jpg`, { lookup: site.options.lookup })),
    { status: 400, code: 'file_url_private' }, 'the override is what lets the test server in');
  assert.deepEqual(await failure(openUrl(`${site.base}/photo.jpg`, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }],
  })), { status: 400, code: 'file_url_private' }, 'one private address among public ones is enough');
  for (const url of ['ftp://files.example/a.jpg', 'file:///etc/passwd', 'https://user:secret@files.example/a.jpg',
    'not a link', '', `https://files.example/${'a'.repeat(2100)}`]) {
    assert.deepEqual(await failure(openUrl(url)), { status: 400, code: 'file_url' }, url);
  }
  assert.deepEqual(await failure(openUrl('https://nowhere.example/a.jpg', { lookup: async () => { throw new Error('ENOTFOUND'); } })),
    { status: 400, code: 'file_url_unreachable' });

  // Opened, then refused by the app before reading: destroyed, and `store` answers at once instead of waiting.
  const uploads = createUploads({ dir: tmp(t), log: () => {} });
  const file = await uploads.fromUrl(`${site.base}/drip`, site.options);
  file.stream.destroy();
  assert.deepEqual(await failure(uploads.store(file.stream, { folder: '1', name: 'x' })), { status: 400, code: 'upload_cut' });
});
