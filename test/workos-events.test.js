/**
 * A password reset on AuthKit's own page revokes everything here
 * (workos-events.js): WorkOS's Events API, asked every minute, with the place
 * it got to kept in app_meta. The audit's last row of the revocation matrix
 * (verify-a: "olvidé mi contraseña" en AuthKit).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSuite } from '../app.js';
import { createRevoker } from '../revoke.js';
import { createWorkosClient, WorkosUnavailable } from '../workos.js';
import { workosUsers } from '../workos-accounts.js';
import { watchPasswordResets, PASSWORD_RESET } from '../workos-events.js';

function makeSuite(t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-workos-events-'));
  const suite = createSuite({
    config: { app: { id: 'demo', name: 'Demo', languages: ['en'] }, accounts: { minPasswordLength: 8 } },
    env: {
      DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', SECURE_COOKIES: 'false',
      ADMIN_PASSWORD: 'root-password', ADMIN_EMAIL: 'root@example.com', ...env,
    },
    log: () => {}, exitOnError: false,
  });
  t.after(() => { suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return suite;
}

/** WorkOS's Events API, faked: the events it holds, and what it is asked. */
function fakeEvents() {
  const held = [];
  const asked = [];
  let n = 0;
  let down = null;
  return {
    held, asked,
    add: (event, userId) => {
      n += 1;
      held.push({ object: 'event', id: `event_${String(n).padStart(4, '0')}`, event,
        data: { object: 'password_reset', id: `password_reset_${n}`, user_id: userId, email: 'x@example.com' },
        created_at: new Date(Date.UTC(2026, 9, 23, 10, 0, n)).toISOString() });
    },
    fail: (err) => { down = err; },
    listEvents: async (q) => {
      asked.push(q);
      if (down) throw down;
      let list = held.filter((e) => q.events.includes(e.event));
      if (q.after) list = list.slice(list.findIndex((e) => e.id === q.after) + 1);
      if (q.order === 'desc') list = [...list].reverse();
      const data = list.slice(0, q.limit);
      return { data, after: data.at(-1)?.id ?? null };
    },
  };
}

function setUp(t) {
  const suite = makeSuite(t);
  const ada = suite.accounts.create({ username: 'ada', password: 'ada-password', email: 'ada@example.com' });
  suite.accounts.linkIdentity(ada.id, 'workos', 'user_ada');
  const bob = suite.accounts.create({ username: 'bob', password: 'bob-password', email: 'bob@example.com' });
  suite.accounts.linkIdentity(bob.id, 'workos', 'user_bob');
  const users = workosUsers(suite.accounts, { database: suite.database });
  const reasons = [];
  const revoker = createRevoker({
    database: suite.database, sessions: suite.sessions, tokens: suite.tokens, workosPeople: users, audit: suite.audit,
    log: () => {},
  });
  const revokeEverything = (id, options) => { reasons.push([id, options]); return revoker.revokeEverything(id, options); };
  const workos = fakeEvents();
  const lines = [];
  const resets = watchPasswordResets({ workos, users, database: suite.database, revokeEverything, log: (l) => lines.push(l) });
  const armed = (user) => ({
    session: suite.sessions.open(user.id),
    token: suite.tokens.create(user.id, { name: 'Script' }).token,
  });
  return { suite, ada, bob, workos, resets, reasons, lines, armed, cursor: () => JSON.parse(suite.database.getMeta('suite.workos_password_resets') || 'null') };
}

test('the first time it starts from now: an older reset is not acted on', async (t) => {
  const { suite, ada, workos, resets, reasons, armed, cursor } = setUp(t);
  workos.add(PASSWORD_RESET, 'user_ada');
  const before = armed(ada);
  const first = await resets.poll();
  assert.equal(first.started, true);
  assert.deepEqual(cursor(), { after: 'event_0001' });
  assert.equal(workos.asked[0].order, 'desc');
  assert.equal(reasons.length, 0);
  assert.ok(suite.sessions.alive(before.session));
  assert.ok(suite.tokens.authenticate(before.token, { scope: 'mcp' }));
});

test('with no reset at all yet, it starts from a moment, and moves it along while none comes', async (t) => {
  const { workos, resets, reasons, cursor } = setUp(t);
  await resets.poll();
  const since = cursor().since;
  assert.match(since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  await resets.poll();
  assert.equal(workos.asked[1].rangeStart, since);
  assert.equal(workos.asked[1].order, 'asc');
  assert.ok(cursor().since >= since);
  // The first reset after it is acted on, and from then on it goes by the event's id.
  workos.add(PASSWORD_RESET, 'user_ada');
  assert.equal((await resets.poll()).revoked, 1);
  assert.deepEqual(cursor(), { after: 'event_0001' });
  assert.equal(reasons.length, 1);
});

test('a reset at WorkOS revokes everything of that person here, nothing kept; others stay', async (t) => {
  const { suite, ada, bob, workos, resets, reasons, armed, cursor, lines } = setUp(t);
  await resets.poll();                             // starts from now
  const a = armed(ada);
  const b = armed(bob);
  workos.add(PASSWORD_RESET, 'user_ada');
  workos.add(PASSWORD_RESET, 'user_somebody_else');   // no account here: skipped
  const result = await resets.poll();
  assert.equal(result.revoked, 1);
  assert.equal(workos.asked.at(-1).order, 'asc');
  assert.deepEqual(reasons, [[ada.id, { keep: null, reason: 'workos_password_reset' }]]);
  assert.equal(suite.sessions.alive(a.session), null);
  assert.equal(suite.tokens.authenticate(a.token, { scope: 'mcp' }), null);
  assert.ok(suite.sessions.alive(b.session));
  assert.ok(suite.tokens.authenticate(b.token, { scope: 'mcp' }));
  assert.deepEqual(cursor(), { after: 'event_0002' });
  assert.ok(lines.some((l) => l.includes(`user #${ada.id} reset their password`)));
  const audit = suite.database.get("SELECT meta FROM audit_log WHERE action = 'auth.revoke_everything' AND target_id = ?", String(ada.id));
  assert.equal(JSON.parse(audit.meta).reason, 'workos_password_reset');
  // Asked again, the same reset is not acted on twice.
  assert.equal((await resets.poll()).revoked, 0);
  assert.equal(workos.asked.at(-1).after, 'event_0002');
  assert.equal(reasons.length, 1);
});

test('more than a page of resets: every page, oldest first', async (t) => {
  const { workos, resets, reasons, cursor, bob } = setUp(t);
  await resets.poll();
  for (let i = 0; i < 150; i++) workos.add(PASSWORD_RESET, i === 149 ? 'user_bob' : `user_${i}`);
  assert.equal((await resets.poll()).revoked, 1);
  assert.deepEqual(reasons.map(([id]) => id), [bob.id]);
  assert.deepEqual(cursor(), { after: 'event_0150' });
});

test('WorkOS failing or refusing: nothing thrown, the place kept, logged once, tried again', async (t) => {
  const { workos, resets, reasons, cursor, lines } = setUp(t);
  workos.add(PASSWORD_RESET, 'user_ada');
  await resets.poll();
  workos.add(PASSWORD_RESET, 'user_ada');
  workos.fail(new WorkosUnavailable('WorkOS does not answer (ECONNREFUSED)'));
  const failed = await resets.poll();
  assert.match(failed.error, /ECONNREFUSED/);
  await resets.poll();
  assert.equal(lines.filter((l) => l.includes('ECONNREFUSED')).length, 1);
  assert.deepEqual(cursor(), { after: 'event_0001' });
  assert.equal(reasons.length, 0);
  // A key without permission to list events: the same.
  workos.fail(Object.assign(new Error('WorkOS did not list the events (403)'), { status: 403 }));
  assert.match((await resets.poll()).error, /403/);
  assert.deepEqual(cursor(), { after: 'event_0001' });
  // Back: the reset missed meanwhile is acted on.
  workos.fail(null);
  assert.equal((await resets.poll()).revoked, 1);
  assert.ok(lines.some((l) => l.includes('heard again')));
  // A place WorkOS no longer takes (past its 90 days): it starts again from now.
  workos.fail(Object.assign(new Error('WorkOS did not list the events (400)'), { status: 400 }));
  await resets.poll();
  assert.equal(cursor(), null);
});

test('listEvents asks WorkOS for one kind of event, after a place or since a moment', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const asked = [];
  globalThis.fetch = async (url, options) => {
    asked.push({ url: new URL(url), auth: options.headers.Authorization });
    return new Response(JSON.stringify({ object: 'list', data: [{ id: 'event_1', event: PASSWORD_RESET }], list_metadata: { after: 'event_1' } }));
  };
  const workos = createWorkosClient({ apiUrl: 'https://api.workos.test', apiKey: 'sk_test' });
  const page = await workos.listEvents({ events: [PASSWORD_RESET], after: 'event_0', rangeStart: '2026-10-23T10:00:00Z' });
  assert.deepEqual(page, { data: [{ id: 'event_1', event: PASSWORD_RESET }], after: 'event_1' });
  const [{ url, auth }] = asked;
  assert.equal(url.pathname, '/events');
  assert.equal(auth, 'Bearer sk_test');
  assert.deepEqual(url.searchParams.getAll('events'), [PASSWORD_RESET]);
  assert.equal(url.searchParams.get('after'), 'event_0');
  assert.equal(url.searchParams.get('range_start'), null, 'after and range_start do not go together');
  assert.equal(url.searchParams.get('order'), 'asc');
  assert.equal(url.searchParams.get('limit'), '100');
  await workos.listEvents({ events: [PASSWORD_RESET], rangeStart: '2026-10-23T10:00:00Z', order: 'desc', limit: 1 });
  assert.equal(asked[1].url.searchParams.get('range_start'), '2026-10-23T10:00:00Z');
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
  await assert.rejects(workos.listEvents({ events: [PASSWORD_RESET] }), (err) => err.status === 401);
  globalThis.fetch = async () => new Response('{}', { status: 503 });
  await assert.rejects(workos.listEvents({ events: [PASSWORD_RESET] }), WorkosUnavailable);
});

test('createSuite listens for the resets only with WorkOS and its key', (t) => {
  assert.equal(makeSuite(t).workosResets, null);
  const withWorkos = makeSuite(t, {
    AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'sk_test', WORKOS_CLIENT_ID: 'client_x', WORKOS_AUTHKIT_DOMAIN: 'https://x.authkit.app',
  });
  assert.equal(typeof withWorkos.workosResets?.poll, 'function');
});
