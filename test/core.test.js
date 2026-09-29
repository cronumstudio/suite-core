/**
 * The kernel: crypto, the database handle, migrations and the HTTP layer.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hashPassword, verifyPassword, needsRehash, sha256, hmac, safeEqual, randomToken,
} from '../crypto.js';
import { openDatabase } from '../db.js';
import { migrate, ensureColumn } from '../migrate.js';
import {
  HttpError, createRouter, readJson, serveStatic, securityHeaders, checkOrigin, sendError,
  parseCookies, serializeCookie, str, clientIp,
} from '../http.js';

/* --------------------------------- crypto --------------------------------- */

test('passwords: the format every app already stores', () => {
  const stored = hashPassword('correct horse');
  assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(verifyPassword('correct horse', stored));
  assert.ok(!verifyPassword('wrong horse', stored));
  assert.ok(!needsRehash(stored));
});

test('passwords: a hash made by the apps before suite-core still verifies', () => {
  // Exactly what crypto-utils.js of Tasks, Projects and Next write.
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync('legacy pass', salt, 32, { N: 16384, r: 8, p: 1 });
  const legacy = ['scrypt', 16384, 8, 1, salt.toString('base64'), key.toString('base64')].join('$');
  assert.ok(verifyPassword('legacy pass', legacy));
});

test('passwords: what is not a valid hash never matches', () => {
  for (const stored of ['!', '', null, undefined, 'scrypt$1$1$1$x$y', 'bcrypt$whatever',
    'scrypt$1048576$8$1$c2FsdHNhbHRzYWx0c2FsdA==$a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5']) {
    assert.equal(verifyPassword('anything', stored), false, String(stored));
  }
  assert.equal(verifyPassword('x'.repeat(2000), hashPassword('x')), false, 'absurdly long input');
});

test('passwords: a cheaper hash asks to be redone', () => {
  assert.ok(needsRehash(hashPassword('p', { N: 4096 })));
  assert.ok(needsRehash('!'));
});

test('tokens and keyed hashes', () => {
  assert.equal(sha256('abc'), crypto.createHash('sha256').update('abc').digest('base64url'));
  assert.equal(hmac('secret', 'v'), crypto.createHmac('sha256', 'secret').update('v').digest('base64url'));
  assert.ok(safeEqual('same', 'same'));
  assert.ok(!safeEqual('same', 'diff'));
  assert.ok(!safeEqual('short', 'longer value'));
  assert.equal(randomToken(24).length, 32);
});

/* -------------------------------- database -------------------------------- */

const tempDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-db-'));
  return { database: openDatabase({ dataDir: dir, name: 'test' }), dir };
};

test('database: pragmas, helpers and app_meta', () => {
  const { database, dir } = tempDb();
  try {
    assert.equal(database.get('PRAGMA foreign_keys').foreign_keys, 1);
    assert.equal(database.get('PRAGMA journal_mode').journal_mode, 'wal');
    database.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const { changes, lastInsertRowid } = database.run('INSERT INTO t (v) VALUES (?)', 'a');
    assert.equal(changes, 1);
    assert.equal(typeof lastInsertRowid, 'number');
    assert.equal(database.get('SELECT v FROM t WHERE id = ?', lastInsertRowid).v, 'a');
    assert.equal(database.getMeta('missing'), null);
    database.setMeta('k', 'one');
    database.setMeta('k', 'two');
    assert.equal(database.getMeta('k'), 'two');
    assert.deepEqual(database.columnsOf('t'), ['id', 'v']);
    assert.deepEqual(database.columnsOf('nope'), []);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('database: transactions roll back whole, and nest', () => {
  const { database, dir } = tempDb();
  try {
    database.exec('CREATE TABLE t (v TEXT)');
    assert.throws(() => database.tx(() => {
      database.run("INSERT INTO t VALUES ('lost')");
      throw new Error('boom');
    }), /boom/);
    assert.equal(database.get('SELECT COUNT(*) AS n FROM t').n, 0);

    database.tx(() => {
      database.run("INSERT INTO t VALUES ('outer')");
      assert.throws(() => database.tx(() => {
        database.run("INSERT INTO t VALUES ('inner')");
        throw new Error('inner fails');
      }));
      database.tx(() => database.run("INSERT INTO t VALUES ('inner ok')"));
    });
    assert.deepEqual(database.all('SELECT v FROM t ORDER BY rowid').map((r) => r.v), ['outer', 'inner ok']);

    assert.throws(() => database.tx(async () => {}), /synchronous/);
    assert.equal(database.get('SELECT COUNT(*) AS n FROM t').n, 2, 'the async attempt changed nothing');
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------- migrations ------------------------------- */

test('migrations: applied once, in order, per scope', () => {
  const { database, dir } = tempDb();
  const quiet = { log: () => {} };
  try {
    const app = [
      { version: 1, name: 'baseline', up: (db) => db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY)') },
      { version: 2, name: 'notes-title', up: (db) => ensureColumn(db, 'notes', 'title', "title TEXT NOT NULL DEFAULT ''") },
    ];
    assert.deepEqual(migrate(database, app, quiet), [1, 2]);
    assert.deepEqual(migrate(database, app, quiet), [], 'the second run changes nothing');
    assert.deepEqual(database.columnsOf('notes'), ['id', 'title']);

    const suite = [{ version: 1, name: 'core', up: (db) => db.exec('CREATE TABLE s (id INTEGER)') }];
    assert.deepEqual(migrate(database, suite, { ...quiet, scope: 'suite' }), [1], 'scopes count apart');

    const failing = [...app, { version: 3, name: 'broken', up: (db) => {
      db.exec('CREATE TABLE half (id INTEGER)');
      throw new Error('broken');
    } }];
    assert.throws(() => migrate(database, failing, quiet), /broken/);
    assert.deepEqual(database.columnsOf('half'), [], 'a failed migration leaves nothing behind');

    assert.throws(() => migrate(database, [app[0]], quiet), /newer release/,
      'code that does not know a recorded migration refuses the database');
    assert.throws(() => migrate(database, [{ ...app[0], version: 2 }], quiet), /expected version 1/);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrations: Focus’s older table is adopted as the app’s', () => {
  const { database, dir } = tempDb();
  try {
    database.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    database.run("INSERT INTO schema_migrations (version, name) VALUES (1, 'core')");
    const applied = migrate(database, [
      { version: 1, name: 'core', up: () => { throw new Error('must not run again'); } },
      { version: 2, name: 'more', up: () => {} },
    ], { log: () => {} });
    assert.deepEqual(applied, [2]);
    // Rows from node:sqlite have no prototype: compare them as plain objects.
    assert.deepEqual(database.all('SELECT scope, version FROM schema_migrations ORDER BY version').map((r) => ({ ...r })),
      [{ scope: 'app', version: 1 }, { scope: 'app', version: 2 }]);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------- http ---------------------------------- */

test('router: params, 405 with Allow, and nothing for unknown paths', () => {
  const router = createRouter();
  const one = () => 'one';
  router.get('/api/lists/:id', one);
  router.patch('/api/lists/:id', () => 'patch');
  assert.deepEqual(router.match('GET', '/api/lists/7'), { handler: one, params: { id: '7' } });
  assert.equal(router.match('HEAD', '/api/lists/7').handler, one, 'HEAD is served as GET');
  assert.deepEqual(router.match('DELETE', '/api/lists/7'), { methodMismatch: true, allow: 'GET, PATCH' });
  assert.equal(router.match('GET', '/api/other'), null);
  assert.equal(router.match('GET', '/api/lists/%E0%A4%A'), null, 'a malformed escape matches nothing');
});

test('cookies and text fields', () => {
  assert.deepEqual(parseCookies({ headers: { cookie: 'a=1; b=x%20y; bad=%E0%A4%A; =z' } }), { a: '1', b: 'x y' });
  assert.equal(serializeCookie('sid', 'v', { maxAge: 60, secure: true }), 'sid=v; Max-Age=60; Path=/; HttpOnly; SameSite=Lax; Secure');
  assert.equal(str('  hi  ', { field: 'name' }), 'hi');
  assert.throws(() => str('x'.repeat(5), { field: 'name', max: 3 }), (e) => e.code === 'field_too_long' && e.extra.max === 3);
  assert.throws(() => str(null, { field: 'name' }), (e) => e.code === 'field_required');
  assert.throws(() => str(5, { field: 'name' }), (e) => e.code === 'field_invalid');
});

test('client address: X-Forwarded-For only as far as the trusted proxies go', () => {
  // The client sent a made-up first entry; the reverse proxy appended the address it saw.
  const req = { headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, socket: { remoteAddress: '10.0.0.2' } };
  assert.equal(clientIp(req, { trustProxy: false }), '10.0.0.2', 'no trusted proxy: the socket');
  assert.equal(clientIp(req, { trustProxy: undefined }), '10.0.0.2');
  assert.equal(clientIp(req, { trustProxy: 'true' }), '203.0.113.9', 'one proxy: the entry it appended');
  assert.equal(clientIp(req, { trustProxy: '2' }), '6.6.6.6', 'two proxies (say Cloudflare and the NAS)');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.2' } }, { trustProxy: true }), '10.0.0.2');
});

test('cross-site requests on the session cookie are refused', () => {
  const req = (method, headers) => ({ method, headers: { host: 'app.example', ...headers } });
  const opts = { baseUrl: 'https://app.example', cookieName: 'sid' };
  const refused = (fn) => assert.throws(fn, (e) => e instanceof HttpError && e.code === 'cross_site_request');
  // Safe methods, and requests without the cookie, are never checked.
  checkOrigin(req('GET', { cookie: 'sid=1', origin: 'https://evil.example' }), opts);
  checkOrigin(req('POST', { origin: 'https://evil.example' }), opts);
  checkOrigin(req('POST', { authorization: 'Bearer x', origin: 'https://evil.example' }), opts);
  // Same origin, by Origin or by Sec-Fetch-Site; the LAN address the request came to counts too.
  checkOrigin(req('POST', { cookie: 'sid=1', origin: 'https://app.example' }), opts);
  checkOrigin({ method: 'PATCH', headers: { host: '192.168.1.5:3456', cookie: 'sid=1', origin: 'http://192.168.1.5:3456' } }, opts);
  checkOrigin(req('DELETE', { cookie: 'sid=1', 'sec-fetch-site': 'same-origin' }), opts);
  checkOrigin(req('POST', { cookie: 'sid=1' }), opts);
  refused(() => checkOrigin(req('POST', { cookie: 'sid=1', origin: 'https://evil.example' }), opts));
  refused(() => checkOrigin(req('POST', { cookie: 'sid=1', origin: 'null' }), opts));
  refused(() => checkOrigin(req('POST', { cookie: 'sid=1', 'sec-fetch-site': 'cross-site' }), opts));
  // A page of its own under `Referrer-Policy: no-referrer` posts with Origin: null (the OAuth
  // consent screen did): the browser's Sec-Fetch-Site, which no page can forge, says it is ours.
  checkOrigin(req('POST', { cookie: 'sid=1', origin: 'null', 'sec-fetch-site': 'same-origin' }), opts);
  refused(() => checkOrigin(req('POST', { cookie: 'sid=1', origin: 'null', 'sec-fetch-site': 'cross-site' }), opts));
  refused(() => checkOrigin(req('POST', { cookie: 'sid=1', origin: 'null', 'sec-fetch-site': 'same-site' }), opts));
});

test('a real server: JSON bodies, errors as codes, static files and headers', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-static-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>x</title>');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
  const server = http.createServer(async (req, res) => {
    securityHeaders(res, { https: true });
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/echo') {
        sendError(res, new HttpError(418, 'teapot', { body: await readJson(req, { limit: 64 }) }));
        return;
      }
      if (url.pathname === '/boom') throw new Error('internal detail');
      if (!serveStatic(root, url.pathname === '/' ? '/index.html' : url.pathname, res)) {
        sendError(res, new HttpError(404, 'not_found'));
      }
    } catch (err) {
      sendError(res, err);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const echo = await fetch(`${base}/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
  assert.equal(echo.status, 418);
  assert.deepEqual(await echo.json(), { error: 'teapot', body: { a: 1 } });
  const asForm = await fetch(`${base}/echo`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"a":1}' });
  assert.equal(asForm.status, 415, 'a body that does not say it is JSON is refused');
  const bad = await fetch(`${base}/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.deepEqual([bad.status, (await bad.json()).error], [400, 'invalid_json']);
  const big = await fetch(`${base}/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(200) }) });
  assert.deepEqual([big.status, (await big.json()).error], [413, 'body_too_large']);
  const boom = await fetch(`${base}/boom`);
  assert.deepEqual([boom.status, await boom.text()], [500, '{"error":"internal"}'], 'no internals leak');

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /script-src[^;]*unsafe-inline/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.headers.get('strict-transport-security'), /max-age=/);
  const again = await fetch(`${base}/`, { headers: { 'If-None-Match': page.headers.get('etag') } });
  assert.equal(again.status, 304);
  assert.equal((await fetch(`${base}/.env`)).status, 404, 'dotfiles are never served');
  assert.equal((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status, 404, 'nor anything outside the root');
});
