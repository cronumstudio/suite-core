/**
 * Zip archives (zip.js): what is written reads back byte for byte, deflated
 * or stored; ZIP64 past 65,535 entries; and what reading refuses — not a zip,
 * a damaged entry, an entry bigger than it promised (a zip bomb), entries
 * that share their bytes (the overlapping bomb), encryption.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createZipWriter, openZip } from '../zip.js';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-zip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Writes the entries into a zip file and returns its path. */
async function zipFile(dir, entries, name = 'a.zip') {
  const file = path.join(dir, name);
  const zip = createZipWriter(fs.createWriteStream(file));
  for (const [entry, content, options] of entries) await zip.add(entry, content, options);
  await zip.finish();
  return file;
}

const rejectsWith = (promise, code) => assert.rejects(promise, (err) => {
  assert.equal(err.code, code, err.message);
  return true;
});

const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 251))]);

test('what is written reads back byte for byte: text deflated, photos stored, names in UTF-8', async (t) => {
  const dir = tmp(t);
  const text = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, title: `Comprar pan nº ${i}` })));
  const file = await zipFile(dir, [
    ['manifest.json', '{"format":"test"}'],
    ['data/tasks.json', text],
    ['files/7/abc-Café.jpg', PHOTO, { compress: false }],
    ['empty.txt', ''],
  ]);
  const zip = await openZip(file);
  t.after(() => zip.close());
  assert.deepEqual(zip.entries.map((e) => e.name), ['manifest.json', 'data/tasks.json', 'files/7/abc-Café.jpg', 'empty.txt']);
  const tasks = zip.entries.find((e) => e.name === 'data/tasks.json');
  assert.ok(tasks.compressed < tasks.size / 3, 'text is deflated');
  const photo = zip.entries.find((e) => e.name === 'files/7/abc-Café.jpg');
  assert.equal(photo.compressed, photo.size, 'a photo is stored as it is');
  assert.equal((await zip.read('data/tasks.json')).toString('utf8'), text);
  assert.deepEqual(await zip.read('files/7/abc-Café.jpg'), PHOTO);
  assert.equal((await zip.read('empty.txt')).length, 0);
  assert.equal(await zip.read('nothing/here'), null);
  assert.equal(zip.has('manifest.json'), true);
  assert.equal(zip.sizeOf('files/7/abc-Café.jpg'), PHOTO.length);
});

test('an entry is refused twice, or with a name that climbs out', async (t) => {
  const zip = createZipWriter(fs.createWriteStream(path.join(tmp(t), 'b.zip')));
  await zip.add('a.txt', 'x');
  await assert.rejects(zip.add('a.txt', 'y'), /twice/);
  await assert.rejects(zip.add('../evil.txt', 'y'), /not a name/);
  await assert.rejects(zip.add('/etc/passwd', 'y'), /not a name/);
  await zip.finish();
});

test('past 65,535 entries the ZIP64 records are written, and read', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'many.zip');
  const zip = createZipWriter(fs.createWriteStream(file));
  for (let i = 0; i < 65540; i++) await zip.add(`f/${i}`, String(i), { compress: false });
  await zip.finish();
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.readUInt16LE(bytes.length - 22 + 10), 0xffff, 'the plain record says "see ZIP64"');
  const back = await openZip(file);
  t.after(() => back.close());
  assert.equal(back.entries.length, 65540);
  assert.equal((await back.read('f/65539')).toString(), '65539');
  assert.equal((await back.read('f/0')).toString(), '0');
});

test('what isn’t a zip, or is damaged, is refused with a reason', async (t) => {
  const dir = tmp(t);
  const text = path.join(dir, 'notes.txt');
  fs.writeFileSync(text, 'just some text, long enough to have no end record in it at all');
  await rejectsWith(openZip(text), 'zip_invalid');
  fs.writeFileSync(text, 'short');
  await rejectsWith(openZip(text), 'zip_invalid');

  // One byte changed inside a stored entry: the CRC catches it.
  const file = await zipFile(dir, [['files/p.jpg', PHOTO, { compress: false }]]);
  const bytes = fs.readFileSync(file);
  bytes[30 + 'files/p.jpg'.length + 100] ^= 0xff;
  fs.writeFileSync(file, bytes);
  const zip = await openZip(file);
  t.after(() => zip.close());
  await assert.rejects(zip.read('files/p.jpg'), (err) => err.code === 'zip_invalid' && err.extra.reason === 'crc');

  // Cut in half: the directory is gone.
  const whole = fs.readFileSync(await zipFile(dir, [['a.txt', 'hello'.repeat(100)]], 'c.zip'));
  fs.writeFileSync(path.join(dir, 'cut.zip'), whole.subarray(0, whole.length - 30));
  await rejectsWith(openZip(path.join(dir, 'cut.zip')), 'zip_invalid');
});

/** Patches the sizes a zip declares for its only entry, in its directory and its local header. */
function declareSize(file, name, size) {
  const bytes = fs.readFileSync(file);
  bytes.writeUInt32LE(size, 22);                                         // local header
  const central = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(size, central + 24);
  fs.writeFileSync(file, bytes);
  return name;
}

test('a zip bomb stops at the size it declared; one declaring too much isn’t even opened', async (t) => {
  const dir = tmp(t);
  // Ten megabytes of zeros deflate to a few kilobytes; the directory then lies that it is 100 bytes.
  const file = await zipFile(dir, [['data/tasks.json', Buffer.alloc(10 * 1024 * 1024)]]);
  declareSize(file, 'data/tasks.json', 100);
  const zip = await openZip(file);
  t.after(() => zip.close());
  await assert.rejects(zip.read('data/tasks.json'), (err) => err.code === 'zip_invalid');

  const honest = await zipFile(dir, [['data/tasks.json', Buffer.alloc(2 * 1024 * 1024)]], 'honest.zip');
  const second = await openZip(honest);
  t.after(() => second.close());
  await rejectsWith(second.read('data/tasks.json', { maxBytes: 1024 * 1024 }), 'zip_too_large');
  assert.equal((await second.read('data/tasks.json', { maxBytes: 4 * 1024 * 1024 })).length, 2 * 1024 * 1024);
});

/** The offset of the `index`th record of the directory. */
function centralRecord(bytes, index) {
  let at = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  for (let i = 0; i < index; i++) at += 46 + bytes.readUInt16LE(at + 28) + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  return at;
}

test('entries that share their bytes are refused: the overlapping zip bomb', async (t) => {
  const dir = tmp(t);
  // Two names over the first one's bytes: thousands of them would inflate the same block thousands of times.
  const file = await zipFile(dir, [['files/a.jpg', PHOTO, { compress: false }], ['files/b.jpg', PHOTO, { compress: false }]]);
  const bytes = fs.readFileSync(file);
  bytes.writeUInt32LE(0, centralRecord(bytes, 1) + 42);
  fs.writeFileSync(file, bytes);
  await assert.rejects(openZip(file), (err) => err.code === 'zip_invalid' && err.extra.reason === 'overlap');

  // An entry whose data runs into the directory.
  const long = await zipFile(dir, [['files/a.jpg', PHOTO, { compress: false }]], 'long.zip');
  const longBytes = fs.readFileSync(long);
  longBytes.writeUInt32LE(PHOTO.length + 100, centralRecord(longBytes, 0) + 20);
  fs.writeFileSync(long, longBytes);
  await assert.rejects(openZip(long), (err) => err.code === 'zip_invalid' && err.extra.reason === 'overlap');
});

test('an entry is read only from its own header, with sizes a real entry could have', async (t) => {
  const dir = tmp(t);
  // The directory names b.txt where a.txt's header is; the names are the same length, so nothing overlaps.
  const file = await zipFile(dir, [['a.txt', 'x'.repeat(200)]]);
  const bytes = fs.readFileSync(file);
  const at = centralRecord(bytes, 0);
  bytes.write('b', at + 46);
  fs.writeFileSync(file, bytes);
  const zip = await openZip(file);
  t.after(() => zip.close());
  await assert.rejects(zip.read('b.txt'), (err) => err.code === 'zip_invalid' && err.extra.reason === 'entry');

  // Stored, but declaring fewer bytes than it holds; deflated, but far bigger than its data.
  const stored = await zipFile(dir, [['files/p.jpg', PHOTO, { compress: false }]], 'stored.zip');
  const storedBytes = fs.readFileSync(stored);
  storedBytes.writeUInt32LE(PHOTO.length - 10, centralRecord(storedBytes, 0) + 20);
  fs.writeFileSync(stored, storedBytes);
  const second = await openZip(stored);
  t.after(() => second.close());
  await assert.rejects(second.read('files/p.jpg'), (err) => err.code === 'zip_invalid' && err.extra.reason === 'size');
});

test('encrypted entries are not read', async (t) => {
  const dir = tmp(t);
  const file = await zipFile(dir, [['secret.txt', 'x'.repeat(200)]]);
  const bytes = fs.readFileSync(file);
  const central = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 1, central + 8);
  fs.writeFileSync(file, bytes);
  const zip = await openZip(file);
  t.after(() => zip.close());
  await rejectsWith(zip.read('secret.txt'), 'zip_unsupported');
});

test('an output that closes halfway stops the writer instead of filling memory', async () => {
  const output = new PassThrough({ highWaterMark: 1024 });
  const zip = createZipWriter(output);
  // Nobody reads: the output fills up and the writer waits for it to drain...
  const writing = (async () => {
    for (let i = 0; i < 50; i++) await zip.add(`f/${i}.jpg`, PHOTO, { compress: false });
  })();
  await new Promise((r) => setTimeout(r, 50));
  // ...until the client goes away.
  output.destroy();
  await assert.rejects(writing, /closed/);
});
