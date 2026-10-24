/**
 * A photo made ready to upload (web/images.js) without a browser: the canvas,
 * the decoder and the files are played by hand. What goes as it is (a PDF, a
 * GIF, a small picture the server takes, a drawing the page made), what is
 * reduced to a JPEG, what is refused before spending data, and a file's weight
 * written in the person's language, unit included.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom, FakeElement } from './fake-dom.js';

const document = installFakeDom();
document.documentElement.dataset = { app: 'demo' };
document.querySelectorAll = () => [];
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
let browser = { languages: ['en'], language: 'en' };
Object.defineProperty(globalThis, 'navigator', { get: () => browser, configurable: true });
// The suite's own catalogs, as the server hands them out.
globalThis.fetch = async (url) => {
  const lang = /\/i18n\/([a-z]+)\.json/.exec(String(url))?.[1];
  const file = new URL(`../i18n/${lang}.json`, import.meta.url);
  if (!lang || !fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
};

// A canvas that keeps what is drawn and hands back a JPEG of the size the test says.
let jpegSize = 300 * 1024;
const drawn = [];
Object.defineProperties(FakeElement.prototype, Object.getOwnPropertyDescriptors({
  get width() { return Number(this.getAttribute('width')); },
  get height() { return Number(this.getAttribute('height')); },
  getContext() {
    const canvas = this;
    return {
      set fillStyle(value) { drawn.push(['fill', value]); },
      fillRect: (...args) => drawn.push(['rect', ...args]),
      drawImage: (_bitmap, ...args) => drawn.push(['image', canvas.width, canvas.height, ...args]),
    };
  },
  toBlob(done, type, quality) { done(jpegSize == null ? null : { size: jpegSize, type, quality }); },
}));
// The decoder: a bitmap of the size the file claims, asked for with its orientation applied.
const decoded = [];
globalThis.createImageBitmap = async (file, options) => {
  decoded.push(options);
  return { width: file.w, height: file.h, close() { this.closed = true; } };
};

const i18n = await import('../web/i18n.js');
const { prepareUpload, fileSize, uploadLimit, MAX_BYTES, MAX_SIDE, JPEG_QUALITY } = await import('../web/images.js');
await i18n.loadLanguage('en', { remember: false });

const MB = 1024 * 1024;
const file = (name, type, size, w = 1000, h = 800) => ({ name, type, size, w, h });

test('what goes as it is: a PDF, a GIF that may move, a small picture the server takes, a drawing the page made', async () => {
  for (const sent of [
    file('invoice.pdf', 'application/pdf', 4 * MB),
    file('cat.gif', 'image/gif', 3 * MB, 4000, 3000),
    file('shot.png', 'image/png', 200 * 1024),
    file('drawing.png', 'image/png', 2 * MB, 4000, 3000),
  ]) {
    const asIs = sent.name === 'drawing.png';
    const ready = await prepareUpload(sent, { asIs });
    assert.equal(ready.blob, sent, sent.name);
    assert.equal(ready.name, sent.name);
  }
  assert.deepEqual(decoded, [{ imageOrientation: 'from-image' }], 'only the small PNG was looked at, turned as the photo says');
});

test('what is made a JPEG: a big photo, reduced to MAX_SIDE on a white ground; a small one the server wouldn’t take; a GIF, if asked', async () => {
  drawn.length = 0;
  const big = await prepareUpload(file('IMG_0001.HEIC', 'image/heic', 4 * MB, 4032, 3024));
  assert.equal(big.name, 'IMG_0001.jpg', 'the name says what it is now');
  assert.deepEqual([big.blob.type, big.blob.quality], ['image/jpeg', JPEG_QUALITY]);
  assert.deepEqual(drawn, [['fill', '#ffffff'], ['rect', 0, 0, MAX_SIDE, 1500], ['image', MAX_SIDE, 1500, 0, 0, MAX_SIDE, 1500]]);

  const small = await prepareUpload(file('tiny.heic', 'image/heic', 100 * 1024));
  assert.equal(small.name, 'tiny.jpg', 'small, but the server takes no HEIC');
  const still = await prepareUpload(file('cat.gif', 'image/gif', 3 * MB), { keepGif: false });
  assert.equal(still.name, 'cat.jpg');
  const nameless = await prepareUpload(file('', 'image/bmp', 2 * MB));
  assert.equal(nameless.name, 'photo.jpg');
});

test('what is refused before spending data, with the sentence to show', async () => {
  await assert.rejects(prepareUpload(file('notes.txt', 'text/plain', 10)), { message: 'Only photos and PDFs can be attached.' });
  await assert.rejects(prepareUpload(file('scan.pdf', 'application/pdf', 16 * MB)), { message: '“scan.pdf” is over 15 MB.' });
  await assert.rejects(prepareUpload(file('scan.pdf', 'application/pdf', 6 * MB), { maxBytes: 5 * MB }), { message: '“scan.pdf” is over 5 MB.' },
    'the server’s own limit, when the page has it');
  await assert.rejects(prepareUpload(file('huge.gif', 'image/gif', 20 * MB)), { message: '“huge.gif” is over 15 MB.' });
  jpegSize = 16 * MB;
  await assert.rejects(prepareUpload(file('poster.png', 'image/png', 14 * MB, 8000, 8000)), { message: '“poster.png” is over 15 MB.' }, 'still too big once reduced');
  jpegSize = null;
  await assert.rejects(prepareUpload(file('odd.png', 'image/png', 14 * MB, 8000, 8000)), { message: '“odd.png” can’t be read as a picture.' });
  jpegSize = 300 * 1024;
});

test('the server’s limit from /api/auth/config; the default where it says none', () => {
  assert.equal(MAX_BYTES, 15 * MB, 'uploads.js’s default maxBytes');
  assert.equal(uploadLimit({ app: { uploads: { max_bytes: 5 * MB } } }), 5 * MB);
  assert.equal(uploadLimit({ app: {} }), MAX_BYTES);
  assert.equal(uploadLimit(null), MAX_BYTES);
});

test('what a file weighs, written in the language, the unit too', async () => {
  assert.deepEqual([fileSize(512), fileSize(340 * 1024), fileSize(1.5 * MB), fileSize('nonsense')], ['512 B', '340 kB', '1.5 MB', '0 B']);
  await i18n.loadLanguage('fr', { remember: false });
  assert.deepEqual([fileSize(512), fileSize(340 * 1024), fileSize(1.5 * MB)], ['512 o', '340 ko', '1,5 Mo']);
  await i18n.loadLanguage('es', { remember: false });
  assert.equal(fileSize(1.5 * MB), '1,5 MB');
  await assert.rejects(prepareUpload(file('notes.txt', 'text/plain', 10)), { message: 'Solo se pueden adjuntar fotos y PDF.' });
  await i18n.loadLanguage('en', { remember: false });
});
