/**
 * Writes sent twice answer once: the same Idempotency-Key gets the first
 * answer back without the route running again, per account, for a day.
 * An answer that carries a secret is never kept: the same key runs it again.
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
import { createRouter } from '../http.js';
import { registerBillingApi } from '../billing.js';
import { totp, base32Decode } from '../two-factor.js';

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

/* ------------------------- answers that carry a secret ------------------------- */

test('an answer that carries a secret is never kept: the same key runs the route again', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-idem-'));
  const suite = createSuite({
    config: { ...PRODUCT, modules: { organizations: true } },
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1' },
    log: () => {}, exitOnError: false,
  });
  const app = createApp({ suite, version: '1.0.0', handleSignals: false, log: () => {} });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  /** A browser that keeps its session. */
  const call = async (method, pathname, body, key) => {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie().find((c) => c.startsWith('demo_sid='));
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json(), replayed: res.headers.get('idempotent-replayed') };
  };
  /** Every answer here is the route's own, never a replay. */
  const fresh = async (...args) => {
    const answer = await call(...args);
    assert.equal(answer.replayed, null, `${args[1]} is never replayed`);
    return answer;
  };
  const kept = () => suite.database.all('SELECT key FROM idempotency_keys ORDER BY key').map((r) => r.key);
  const password = 'root-password';
  await call('POST', '/api/auth/login', { username: 'admin', password });

  // A token: the same key makes another one; the first, never seen, stays in the list to revoke.
  const tokenA = await fresh('POST', '/api/me/tokens', { name: 'Script' }, 'token-key-0001');
  const tokenB = await fresh('POST', '/api/me/tokens', { name: 'Script' }, 'token-key-0001');
  assert.equal(tokenB.status, 201);
  assert.notEqual(tokenB.data.token, tokenA.data.token);
  assert.equal((await call('GET', '/api/me/tokens')).data.length, 2);

  // The two-step secret: a new one, which replaces the first.
  const setupA = await fresh('POST', '/api/me/two-factor/setup', { password }, 'two-factor-setup-1');
  const setupB = await fresh('POST', '/api/me/two-factor/setup', { password }, 'two-factor-setup-1');
  assert.notEqual(setupB.data.secret, setupA.data.secret);
  const code = totp(base32Decode(setupB.data.secret), Math.floor(Date.now() / 30000));
  const enabled = await fresh('POST', '/api/me/two-factor/enable', { code }, 'two-factor-enable-1');
  assert.equal(enabled.data.recovery_codes.length, 10);
  // On already: the route's own refusal, not the codes a second time.
  const again = await fresh('POST', '/api/me/two-factor/enable', { code }, 'two-factor-enable-1');
  assert.equal(again.status, 409);
  assert.equal(again.data.error, 'two_factor_enabled');
  assert.equal(again.data.recovery_codes, undefined);
  // New recovery codes: ten more each time, and the ones before stop working.
  const codesB = (await fresh('POST', '/api/me/two-factor/recovery-codes',
    { password, code: enabled.data.recovery_codes[0] }, 'recovery-codes-01')).data.recovery_codes;
  const codesC = (await fresh('POST', '/api/me/two-factor/recovery-codes',
    { password, code: codesB[0] }, 'recovery-codes-01')).data.recovery_codes;
  assert.equal(codesC.length, 10);
  assert.ok(!codesC.some((c) => codesB.includes(c)));

  // Signing in again from a browser with a session: the challenge is a way in too.
  const challenge = await fresh('POST', '/api/auth/login', { username: 'admin', password }, 'sign-in-again-01');
  assert.equal(challenge.data.two_factor_required, true);
  await fresh('POST', '/api/auth/login', { username: 'admin', password }, 'sign-in-again-01');
  const signedIn = await fresh('POST', '/api/auth/login/code',
    { challenge: challenge.data.challenge, code: codesC[1] }, 'sign-in-code-001');
  assert.equal(signedIn.data.user.username, 'admin');

  // Invitations: their link lets whoever opens it in.
  const signupA = await fresh('POST', '/api/admin/invitations', { email: 'bea@example.com' }, 'invite-bea-0001');
  const signupB = await fresh('POST', '/api/admin/invitations', { email: 'bea@example.com' }, 'invite-bea-0001');
  assert.equal(signupB.status, 201);
  assert.notEqual(signupB.data.url, signupA.data.url);
  const home = (await call('POST', '/api/orgs', { name: 'Home' })).data;
  const joinA = await fresh('POST', `/api/orgs/${home.id}/invitations`, {}, 'invite-home-001');
  const joinB = await fresh('POST', `/api/orgs/${home.id}/invitations`, {}, 'invite-home-001');
  assert.equal(joinB.status, 201);
  assert.notEqual(joinB.data.token, joinA.data.token);

  assert.deepEqual(kept(), [], 'none of those answers is in the table');
  // An ordinary write with a key is still kept and replayed.
  const revoke = await call('DELETE', `/api/me/tokens/${tokenA.data.id}`, undefined, 'revoke-token-01');
  const replay = await call('DELETE', `/api/me/tokens/${tokenA.data.id}`, undefined, 'revoke-token-01');
  assert.equal(revoke.status, 200);
  assert.equal(replay.replayed, 'true');
  assert.deepEqual(kept(), ['revoke-token-01']);
});

test('the routes whose answer is a secret are marked; the others replay as before', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-idem-'));
  const suite = createSuite({
    config: { ...PRODUCT, modules: { organizations: true } },
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1' },
    log: () => {}, exitOnError: false,
  });
  t.after(() => { suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { api } = createApp({ suite, version: '1.0.0', handleSignals: false, log: () => {} });
  const once = (router, method, pathname) => Boolean(router.match(method, pathname)?.handler?.answeredOnce);
  for (const pathname of ['/api/auth/login', '/api/auth/login/code', '/api/me/tokens', '/api/me/two-factor/setup',
    '/api/me/two-factor/enable', '/api/me/two-factor/recovery-codes', '/api/admin/invitations', '/api/orgs/7/invitations']) {
    assert.equal(once(api, 'POST', pathname), true, pathname);
  }
  for (const [method, pathname] of [['POST', '/api/orgs'], ['DELETE', '/api/me/tokens/7'], ['POST', '/api/me/password'],
    ['POST', '/api/me/two-factor/disable'], ['POST', '/api/orgs/join']]) {
    assert.equal(once(api, method, pathname), false, `${method} ${pathname}`);
  }
  // The provider's portal opens signed in from its link; a checkout's is only a page to pay.
  const router = createRouter();
  registerBillingApi(router, { billing: { enabled: true } });
  assert.equal(once(router, 'POST', '/api/billing/portal'), true);
  assert.equal(once(router, 'POST', '/api/billing/checkout'), false);
});
