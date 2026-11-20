/**
 * A public page (public-page.js): its token, turning it on and off, reading it without turning it
 * on, the plan asked again when it is served, an owner switched off, the embedding only Pro's, the
 * owner's name and never their username, a hand-over, and its routes with their headers.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createPublicPage, publicOwnerName, publicHeaders, PUBLIC_TOKEN, newPublicToken, auditPublic } from '../public-page.js';
import { createRouter, HttpError } from '../http.js';

function setup({ find = null, audit = null, kind = null } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, email TEXT, disabled_at TEXT, plan TEXT);
    CREATE TABLE things (id INTEGER PRIMARY KEY, owner_id INTEGER, name TEXT, deleted_at TEXT, public_token TEXT, public_since TEXT);
  `);
  const insert = database.prepare('INSERT INTO users VALUES (?, ?, ?, ?, NULL, ?)');
  insert.run(1, 'ana', 'Ana Ruiz', 'ana@example.com', 'free');
  insert.run(2, 'ben', 'ben', 'ben@example.com', 'pro');
  insert.run(3, 'cris', 'Cris', 'cris@example.com', 'none');
  for (const [id, owner, name] of [[10, 1, 'Garden'], [11, 2, 'Kitchen'], [12, 3, 'Attic']]) {
    database.prepare('INSERT INTO things (id, owner_id, name) VALUES (?, ?, ?)').run(id, owner, name);
  }
  const db = {
    get: (sql, ...params) => database.prepare(sql).get(...params),
    run: (sql, ...params) => database.prepare(sql).run(...params),
  };
  // The catalog in small: Free publishes, Pro publishes and embeds, "none" does neither.
  const has = { free: ['publish'], pro: ['publish', 'embed'], none: [] };
  const entitlements = {
    can: (user, key) => Boolean(user) && has[user.plan].includes(key),
    require(user, key) { if (!this.can(user, key)) throw new HttpError(403, 'plan_limit', { feature: key }); },
  };
  const told = [];
  const page = createPublicPage({
    db, entitlements, table: 'things',
    publicUrl: (token) => `https://example.com/shared.html?p=${token}`,
    find, audit, kind, module: audit ? 'demo' : null,
    changed: (row, userId) => told.push([row.id, userId]),
  });
  const row = (id) => db.get('SELECT * FROM things WHERE id = ?', id);
  const tokenOf = (url) => new URL(url).searchParams.get('p');
  return { database, db, page, row, told, tokenOf };
}

const codeOf = (fn) => {
  try { fn(); } catch (err) { return `${err.status} ${err.code}`; }
  return 'ok';
};

test('a token: long, random, of the shape the page accepts', () => {
  const a = newPublicToken();
  assert.equal(a.length, 32);
  assert.match(a, PUBLIC_TOKEN);
  assert.notEqual(a, newPublicToken());
  assert.doesNotMatch('../etc', PUBLIC_TOKEN);
});

test('read changes nothing; open turns it on once; close turns it off, and a new open is a new link', () => {
  const { page, row, told, tokenOf } = setup();
  assert.deepEqual(page.read(1, row(10)), { url: null, since: null, embed: false });
  assert.equal(row(10).public_token, null, 'reading never turns it on');
  assert.deepEqual(told, []);

  const on = page.open(1, row(10));
  assert.match(on.url, /^https:\/\/example\.com\/shared\.html\?p=/);
  assert.ok(on.since);
  assert.equal(on.embed, false, 'Free: no embedding');
  assert.deepEqual(told, [[10, 1]]);
  assert.deepEqual(page.open(1, row(10)), on, 'on already: the same link, nobody told again');
  assert.deepEqual(told, [[10, 1]]);
  assert.deepEqual(page.read(1, row(10)), on);
  // An old copy of the row (read before it was turned on) still reads it as it is.
  assert.equal(page.read(1, { id: 10, public_token: null }).url, on.url);

  assert.equal(page.close(1, row(10)), true);
  assert.equal(page.close(1, row(10)), false, 'off already');
  assert.deepEqual(told, [[10, 1], [10, 1]]);
  assert.equal(codeOf(() => page.serve(tokenOf(on.url))), '404 public_not_found');
  const again = page.open(1, row(10));
  assert.notEqual(again.url, on.url);
});

test('turning it on needs `publish`; embedding, `embed`', () => {
  const { page, row } = setup();
  assert.equal(codeOf(() => page.open(3, row(12))), '403 plan_limit');
  assert.equal(page.open(2, row(11)).embed, true, 'Pro embeds');
});

test('served: the row, its owner and the name it shows; refused as a page nobody has, or embedded without Pro', () => {
  const { database, page, row, tokenOf } = setup();
  const garden = tokenOf(page.open(1, row(10)).url);
  const kitchen = tokenOf(page.open(2, row(11)).url);

  const served = page.serve(garden);
  assert.equal(served.row.name, 'Garden');
  assert.equal(served.owner.id, 1);
  assert.equal(served.name, 'Ana Ruiz');
  assert.equal(page.serve(kitchen).name, null, 'a name that is the username is no name of theirs');

  assert.equal(codeOf(() => page.serve('A'.repeat(32))), '404 public_not_found');
  assert.equal(codeOf(() => page.serve('../etc')), '404 public_not_found');
  assert.equal(codeOf(() => page.serve(null)), '404 public_not_found');

  // Framed: Pro's only.
  assert.equal(codeOf(() => page.serve(garden, { embed: true })), '403 embed_not_allowed');
  assert.equal(page.serve(kitchen, { embed: true }).row.name, 'Kitchen');

  // The plan asked again when it is served: without `publish`, as if it were off; back, the same link.
  database.prepare("UPDATE users SET plan = 'none' WHERE id = 1").run();
  assert.equal(codeOf(() => page.serve(garden)), '404 public_not_found');
  database.prepare("UPDATE users SET plan = 'free' WHERE id = 1").run();
  assert.equal(page.serve(garden).row.name, 'Garden');

  // Its owner switched off (disabled, or its deletion asked for): nothing; switched on, the same link.
  database.prepare("UPDATE users SET disabled_at = '2026-11-13T10:00:00Z' WHERE id = 1").run();
  assert.equal(codeOf(() => page.serve(garden)), '404 public_not_found');
  database.prepare('UPDATE users SET disabled_at = NULL WHERE id = 1').run();
  assert.equal(page.serve(garden).row.name, 'Garden');

  // Its owner gone altogether.
  database.prepare('DELETE FROM users WHERE id = 1').run();
  assert.equal(codeOf(() => page.serve(garden)), '404 public_not_found');
});

test('find: a row in the trash shows nothing, and restored the same link works again', () => {
  let s = null;
  s = setup({ find: (token) => s.db.get('SELECT * FROM things WHERE public_token = ? AND deleted_at IS NULL', token) });
  const token = s.tokenOf(s.page.open(1, s.row(10)).url);
  s.database.prepare("UPDATE things SET deleted_at = 'now' WHERE id = 10").run();
  assert.equal(codeOf(() => s.page.serve(token)), '404 public_not_found');
  s.database.prepare('UPDATE things SET deleted_at = NULL WHERE id = 10').run();
  assert.equal(s.page.serve(token).row.id, 10);
});

test('a hand-over turns the page off, telling nobody', () => {
  const { page, row, told, tokenOf } = setup();
  const token = tokenOf(page.open(1, row(10)).url);
  page.open(1, row(11));
  told.length = 0;
  page.unpublish('owner_id = ? AND id = ?', 1, 10);
  assert.equal(row(10).public_token, null);
  assert.equal(row(10).public_since, null);
  assert.ok(row(11).public_token, 'only what it names');
  assert.deepEqual(told, []);
  assert.equal(codeOf(() => page.serve(token)), '404 public_not_found');
});

test('the name a page shows: the one its owner set, never their username nor their email’s start', () => {
  assert.equal(publicOwnerName({ display_name: ' Ana ', username: 'ana', email: 'x@y.z' }), 'Ana', 'Ana is not ana: written by them');
  assert.equal(publicOwnerName({ display_name: 'ana', username: 'ana' }), null);
  assert.equal(publicOwnerName({ display_name: 'eva.l', username: 'u1', email: 'eva.l@example.com' }), null);
  assert.equal(publicOwnerName({ display_name: '', username: 'ana' }), null);
  assert.equal(publicOwnerName({ display_name: null }), null);
  assert.equal(publicOwnerName(null), null);
});

test('createPublicPage takes a table name only', () => {
  assert.throws(() => createPublicPage({ db: {}, entitlements: {}, table: 'things; DROP TABLE users', publicUrl: String }));
});

/* --------------------------------- routes --------------------------------- */

function fakeRes() {
  return {
    headers: {}, status: null, body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    writeHead(status, headers = {}) { this.status = status; for (const [k, v] of Object.entries(headers)) this.setHeader(k, v); },
    end(body) { this.body = body ? JSON.parse(String(body)) : null; },
  };
}

test('routes: the owner’s three and the page’s, answering as the module’s did, with no-store and noindex', async () => {
  const { db, page } = setup();
  const api = createRouter();
  // The module's own check and code: here, the owner alone, a 403 of its own for anyone else.
  const whats = [];
  page.routes(api, {
    path: '/api/things/:id/public',
    user: (ctx) => ctx.user,
    own: (userId, id, what) => {
      whats.push(what);
      const thing = db.get('SELECT * FROM things WHERE id = ?', id);
      if (!thing) throw new HttpError(404, 'not_found');
      if (thing.owner_id !== userId) throw new HttpError(403, 'thing_owner_only_public');
      return thing;
    },
    view: ({ row, name }) => ({ thing: { name: row.name, owner: name } }),
  });
  const call = async (method, path, user = { id: 1 }) => {
    const url = new URL(path, 'http://x');
    const found = api.match(method, url.pathname);
    const res = fakeRes();
    const ctx = { req: {}, res, params: found.params, query: url.searchParams, user };
    try {
      await found.handler(ctx);
    } catch (err) {
      return { status: err.status, error: err.code, headers: res.headers };
    }
    return { status: res.status, body: res.body, headers: res.headers };
  };

  assert.deepEqual((await call('GET', '/api/things/10/public')).body, { url: null, since: null, embed: false });
  const on = await call('POST', '/api/things/10/public');
  assert.equal(on.status, 200);
  assert.ok(on.body.url);
  assert.equal((await call('POST', '/api/things/10/public', { id: 2 })).error, 'thing_owner_only_public');
  assert.deepEqual(whats, ['read', 'open', 'open']);

  const token = new URL(on.body.url).searchParams.get('p');
  const shown = await call('GET', `/api/public/${token}`);
  assert.deepEqual(shown.body, { thing: { name: 'Garden', owner: 'Ana Ruiz' } });
  assert.equal(shown.headers['cache-control'], 'no-store');
  assert.equal(shown.headers['x-robots-tag'], 'noindex');
  const framed = await call('GET', `/api/public/${token}?embed=1`);
  assert.equal(framed.status, 403);
  assert.equal(framed.error, 'embed_not_allowed');
  assert.equal(framed.headers['cache-control'], 'no-store', 'a refusal is kept by nobody either');

  const off = await call('DELETE', '/api/things/10/public');
  assert.deepEqual(off.body, { ok: true });
  assert.equal(whats.at(-1), 'close');
  const gone = await call('GET', `/api/public/${token}`);
  assert.equal(gone.status, 404);
  assert.equal(gone.error, 'public_not_found');
  assert.equal(gone.headers['x-robots-tag'], 'noindex');
});

test('publicHeaders: no-store and noindex', () => {
  const res = fakeRes();
  publicHeaders(res);
  assert.deepEqual(res.headers, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
});

test('turning a page on and off is in the audit log, once each, with the request but never the token (authz-8)', async () => {
  const lines = [];
  const all = [];
  const audit = { record: (line) => { lines.push(line); all.push(line); } };
  const { page, row } = setup({ audit, kind: 'thing' });
  const shown = () => lines.splice(0).map(({ action, actor, targetType, targetId, meta, req }) => [action, actor, targetType, targetId, meta, req]);
  const req = { headers: {} };
  const { url } = page.open(1, row(10), { req });
  page.open(1, row(10), { req });
  assert.deepEqual(shown(), [['public.open', 1, 'thing', 10, { module: 'demo' }, req]], 'on already: no second line');
  page.read(1, row(10));
  assert.deepEqual(shown(), [], 'reading it changes nothing');
  assert.equal(page.close(1, row(10)), true);
  assert.equal(page.close(1, row(10)), false);
  assert.deepEqual(shown(), [['public.close', 1, 'thing', 10, { module: 'demo' }, null]]);
  assert.throws(() => page.open(3, row(12)), /plan_limit|publish/);
  assert.deepEqual(shown(), [], 'refused by the plan: nothing');
  const token = new URL(url).searchParams.get('p');
  page.open(1, row(10));
  page.unpublish('id = ?', 10);
  assert.deepEqual(shown().map((line) => line[0]), ['public.open'], 'a hand-over turns it off inside its own change, unlogged');
  assert.ok(all.length && all.every((line) => !JSON.stringify(line).includes(token)));

  // A module whose page doesn't go through the engine yet: the same line from where it turns one on or off.
  auditPublic(audit, { open: true, actor: 2, kind: 'list', id: 5, module: 'tasks' });
  auditPublic(audit, { open: false, actor: 2, kind: 'list', id: 5 });
  auditPublic(null, { open: true, actor: 2, kind: 'list', id: 5 });
  assert.deepEqual(shown(), [['public.open', 2, 'list', 5, { module: 'tasks' }, null], ['public.close', 2, 'list', 5, {}, null]]);

  // Without a kind, the table names them.
  const plain = setup({ audit });
  plain.page.open(1, plain.row(10));
  assert.equal(lines.pop().targetType, 'things');
});
