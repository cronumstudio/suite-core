/**
 * The storage a plan allows (storage.js) and an upload with an app's limits
 * around it (uploads.js storeChecked): the 402 the apps answered, whose plan
 * pays, the cap per record counted before and after the file arrives, and an
 * app on its own counting its own files.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createStorage } from '../storage.js';
import { createUploads } from '../uploads.js';
import { createSuite, createApp } from '../app.js';
import { HttpError } from '../http.js';

const MB = 1024 * 1024;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]);

/** Plans by hand: each person carries their limit in MB (null: none) and their plan's name. */
const entitlements = {
  limit: (user, key) => (key === 'storage.mb' ? user.limit : null),
  of: (user) => ({ plan: { id: user.plan, name: user.plan.toUpperCase() } }),
};

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-storage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A request body that arrives as a stream, as an upload does. */
const body = (buffer) => {
  const stream = new PassThrough();
  stream.end(buffer);
  return stream;
};

const refusal = (status, code, extra = {}) => (err) => {
  assert.ok(err instanceof HttpError, String(err));
  assert.equal(err.status, status);
  assert.equal(err.code, code);
  for (const [key, value] of Object.entries(extra)) assert.deepEqual(err.extra[key], value, key);
  return true;
};

test('the storage a plan allows: nothing within it or without a limit, the apps’ 402 past it, against whoever pays', () => {
  const kept = { 1: 2 * MB, 2: 0, 3: 9 * MB };
  const storage = createStorage({ entitlements, used: (id) => kept[id] });
  const ana = { id: 1, limit: 3, plan: 'free' };
  const owner = { id: 3, limit: 10, plan: 'pro' };
  const free = { id: 2, limit: null, plan: 'admin' };

  storage.check(ana, MB);
  storage.check(free, 100 * MB);
  assert.throws(() => storage.check(ana, MB + 1), refusal(402, 'plan_limit', {
    feature: 'storage.mb', limit: '3 MB', current: '2 MB', plan: 'free', plan_name: 'FREE',
  }), 'the same shape Tasks, Projects and Notes answered');
  assert.throws(() => storage.check(ana, 2 * MB, { payer: owner }), refusal(402, 'plan_limit', { limit: '10 MB', current: '9 MB', plan: 'pro' }),
    'the payer’s plan and the payer’s files, not the uploader’s');
  storage.check(ana, MB, { payer: owner });
  storage.check(owner, 0, { payer: free });
  storage.check(ana, 10 * MB, { payer: null });
  assert.deepEqual(storage.of(ana), { used: 2 * MB, limit: 3 });
  assert.deepEqual(storage.of(free), { used: 0, limit: null });
});

test('storeChecked: the cap and the storage before a byte is read and again with the file on disk', async (t) => {
  const dir = tmp(t);
  let kept = 0;
  const storage = createStorage({ entitlements, used: () => kept });
  const uploads = createUploads({ dir, log: () => {}, storage: () => storage });
  const ana = { id: 1, limit: 1, plan: 'free' };
  const files = () => fs.readdirSync(path.join(dir, '1')).filter((name) => !name.endsWith('.partial'));
  let count = 0;

  const stored = await uploads.storeChecked(body(JPEG), { folder: '1', name: 'a.jpg', user: ana, count: () => count, max: 2 });
  assert.equal(stored.size, JPEG.length);
  assert.equal(stored.mime, 'image/jpeg');
  assert.equal(files().length, 1);

  count = 2;
  const full = body(JPEG);
  await assert.rejects(uploads.storeChecked(full, { folder: '1', name: 'b.jpg', user: ana, count: () => count, max: 2 }),
    refusal(400, 'too_many_files', { max: 2 }));
  assert.equal(files().length, 1, 'refused before a byte reached the disk');
  assert.equal(full.readableFlowing, true, 'the body is swallowed, so the answer can be sent');

  // Two uploads sent together both pass the first count: the second count refuses the late one.
  count = 1;
  const late = uploads.storeChecked(body(JPEG), { folder: '1', name: 'c.jpg', user: ana, count: () => count++, max: 2 });
  await assert.rejects(late, refusal(400, 'too_many_files'));
  assert.equal(files().length, 1, 'and its file goes from the disk');

  count = 0;
  kept = MB - 10;
  await assert.rejects(uploads.storeChecked(body(JPEG), { folder: '1', name: 'd.jpg', user: ana, count: () => count, max: 2 }),
    refusal(402, 'plan_limit', { feature: 'storage.mb' }), 'one byte fitted, the whole file doesn’t');
  assert.equal(files().length, 1);
  kept = MB;
  await assert.rejects(uploads.storeChecked(body(JPEG), { folder: '1', name: 'e.jpg', user: ana }), refusal(402, 'plan_limit'));

  const owner = { id: 9, limit: null, plan: 'pro' };
  await uploads.storeChecked(body(JPEG), { folder: '1', name: 'f.jpg', user: ana, payer: owner });
  assert.equal(files().length, 2, 'the owner pays, and the owner’s plan has room');
  await uploads.storeChecked(body(JPEG), { folder: '1', name: 'g.jpg' });
  assert.equal(files().length, 3, 'without a user nor a cap, a plain store');

  const plain = createUploads({ dir, log: () => {} });
  await assert.rejects(plain.storeChecked(body(JPEG), { folder: '1', name: 'h.jpg', user: ana }), /no storage/,
    'a payer with nothing to check against is a mistake in the app, said, not a free pass');
});

test('an app on its own: suite.storage counts what the app says it keeps; /api/auth/config says the most a file weighs', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-storage-'));
  const suite = createSuite({
    config: {
      app: { id: 'demo', name: 'Demo', languages: ['en'] },
      modules: { uploads: true },
      features: { 'storage.mb': { type: 'limit', default: null, label: 'storage (MB)' } },
    },
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', ADMIN_PASSWORD: 'root-password', PLANS: JSON.stringify({ free: { name: 'Free', 'storage.mb': 1 } }) },
    log: () => {}, exitOnError: false,
  });
  let app = null;
  t.after(async () => {
    await app?.close();
    suite.database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(suite.storage, undefined, 'nothing until the app says what it keeps');
  const ana = suite.accounts.create({ username: 'ana' });
  // Said where the app counts its files, at import: its scripts have it without createApp.
  const counted = suite.countStorage((id) => (id === ana.id ? MB - 10 : 0));
  assert.equal(suite.storage, counted);
  assert.equal(suite.countStorage(() => 0), counted, 'said once');
  app = createApp({ suite, storage: () => 0, handleSignals: false, log: () => {} });
  assert.equal(suite.storage, counted, 'createApp keeps what was said');
  assert.throws(() => suite.storage.check(ana, 11), refusal(402, 'plan_limit', { limit: '1 MB', current: '1 MB', plan: 'free' }));
  suite.storage.check(ana, 10);
  await assert.rejects(suite.uploads.storeChecked(body(JPEG), { folder: String(ana.id), name: 'x.jpg', user: ana }), refusal(402, 'plan_limit'),
    'its uploads check against it');
  const bare = createSuite({
    config: { app: { id: 'bare', name: 'Bare', languages: ['en'] }, modules: { uploads: true } },
    env: { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-storage-')), PORT: '0', BASE_URL: 'http://127.0.0.1' },
    log: () => {}, exitOnError: false,
  });
  createApp({ suite: bare, storage: () => 5, handleSignals: false, log: () => {} });
  assert.equal(bare.storage.used(1), 5, 'createApp alone says it too');
  bare.database.close();

  const server = await app.listen();
  const config = await (await fetch(`http://127.0.0.1:${server.address().port}/api/auth/config`)).json();
  assert.deepEqual(config.app.uploads, { max_bytes: 15 * MB });
});
