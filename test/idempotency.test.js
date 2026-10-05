/**
 * Writes sent twice answer once: the same Idempotency-Key gets the first
 * answer back without the route running again, per account, for a day.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSuite, createApp } from '../app.js';
import { createIdempotency, idempotencySchema } from '../idempotency.js';
import { openDatabase } from '../db.js';

const PRODUCT = { app: { id: 'demo', name: 'Demo', port: 3999, languages: ['en'] } };

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-idem-'));
  const suite = createSuite({
    config: PRODUCT,
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1' },
    migrations: [{ version: 1, name: 'notes', up: (d) => d.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT)') }],
    log: () => {}, exitOnError: false,
  });
  let runs = 0;
  const app = createApp({
    suite, version: '1.0.0', handleSignals: false, log: () => {},
    routes: (api) => {
      api.post('/api/notes', async (ctx) => {
        runs += 1;
        const { lastInsertRowid } = suite.database.run('INSERT INTO notes (user_id, text) VALUES (?, ?)', ctx.user.id, 'x');
        ctx.res.writeHead(201, { 'Content-Type': 'application/json' });
        ctx.res.end(JSON.stringify({ id: Number(lastInsertRowid) }));
      });
      api.post('/api/fails', (ctx) => {
        runs += 1;
        ctx.res.writeHead(409, { 'Content-Type': 'application/json' });
        ctx.res.end(JSON.stringify({ error: 'note_conflict' }));
      });
    },
  });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = async (username, password) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    return res.headers.getSetCookie().find((c) => c.startsWith('demo_sid=')).split(';')[0];
  };
  const call = async (cookie, method, pathname, key) => {
    const res = await fetch(base + pathname, {
      method, headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: '{}',
    });
    return { status: res.status, data: await res.json(), replayed: res.headers.get('idempotent-replayed') };
  };
  return { suite, session, call, runs: () => runs };
}

test('the same key answers once; another key, another write', async (t) => {
  const { session, call, runs } = await start(t);
  const admin = await session('admin', 'root-password');
  const first = await call(admin, 'POST', '/api/notes', 'note-key-0001');
  assert.equal(first.status, 201);
  const again = await call(admin, 'POST', '/api/notes', 'note-key-0001');
  assert.deepEqual(again.data, first.data, 'the same answer');
  assert.equal(again.status, 201);
  assert.equal(again.replayed, 'true');
  assert.equal(runs(), 1, 'the route ran once');
  const other = await call(admin, 'POST', '/api/notes', 'note-key-0002');
  assert.notEqual(other.data.id, first.data.id);
  await call(admin, 'POST', '/api/notes');
  await call(admin, 'POST', '/api/notes');
  assert.equal(runs(), 4, 'without a key every write runs');
});

test('keys are per account, tied to their path, and failures are not kept', async (t) => {
  const { suite, session, call, runs } = await start(t);
  suite.accounts.create({ username: 'ana', display_name: 'Ana', password: 'ana-password-1' });
  const admin = await session('admin', 'root-password');
  const ana = await session('ana', 'ana-password-1');
  const mine = await call(admin, 'POST', '/api/notes', 'shared-key-01');
  const hers = await call(ana, 'POST', '/api/notes', 'shared-key-01');
  assert.notEqual(hers.data.id, mine.data.id, 'the same string from someone else is another key');
  assert.equal((await call(admin, 'POST', '/api/fails', 'shared-key-01')).data.error, 'idempotency_key_reused');
  assert.equal((await call(admin, 'POST', '/api/notes', 'bad key!')).data.error, 'idempotency_key_invalid');

  const before = runs();
  assert.equal((await call(admin, 'POST', '/api/fails', 'retry-me-001')).status, 409);
  assert.equal((await call(admin, 'POST', '/api/fails', 'retry-me-001')).status, 409);
  assert.equal(runs(), before + 2, 'a 409 may go another way next time: it runs again');
});

test('answers older than a day are swept', () => {
  const database = openDatabase({ path: ':memory:' });
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  database.run('INSERT INTO users (id) VALUES (1)');
  idempotencySchema(database);
  const clock = Date.parse('2026-10-05T10:00:00Z');
  const idem = createIdempotency({ database, now: () => clock });
  database.run("INSERT INTO idempotency_keys VALUES (1, 'old-key-0001', 'POST', '/api/x', 200, '{}', ?)", clock - 25 * 3600 * 1000);
  database.run("INSERT INTO idempotency_keys VALUES (1, 'new-key-0001', 'POST', '/api/x', 200, '{}', ?)", clock - 3600 * 1000);
  idem.purge();
  assert.deepEqual(database.all('SELECT key FROM idempotency_keys').map((r) => r.key), ['new-key-0001']);
});
