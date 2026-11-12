/**
 * Accounts the admin makes from Users › New account (POST /api/admin/users), over real HTTP on an
 * app made of the suite: a test account for a store's review or a tester, with its email, password,
 * role and plan, ready to sign in with no message to confirm it.
 *
 * · Passwords here: the account with its password, its email confirmed and the plan given, which
 *   Users › Plan shows as the admin's; every check before anything is made.
 * · WorkOS where the install owns the logins (accounts.adminIdentity): the login made there with
 *   its email verified and this app's mark, the account here linked to it, only with the admin's
 *   own password again; an email WorkOS already has is refused, and a login made for an account
 *   that couldn't be made after all goes too. Where the install doesn't own them, no password.
 * The password never comes back, nor reaches the log or the server's lines.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSuite, createApp } from '../app.js';

const SECRET = 'Review-Pass-2026!';
const ADMIN_SECRET = 'root-secret-at-workos';
const PRODUCT = {
  app: { id: 'demo', name: 'Demo', port: 3999, languages: ['en'] },
  features: { 'lists.max': { type: 'limit', default: null, label: 'more lists' } },
  plans: { free: { name: 'Free', features: { 'lists.max': 3 } }, pro: { name: 'Pro', features: {} } },
  defaultPlan: 'free',
};

/** WorkOS's users as these routes ask for them: found by email, made, read, changed, deleted, and a password checked. */
async function fakeWorkos(t) {
  const users = new Map();
  const calls = [];
  let down = false;
  let made = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://workos');
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, path: url.pathname, body });
      const answer = (status, payload = {}) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (down) return answer(503, { message: 'Service unavailable' });
      const byEmail = (email) => [...users.values()].find((u) => u.email === String(email).toLowerCase());
      if (url.pathname === '/user_management/authenticate') {
        const user = byEmail(body.email);
        return user && user.password === body.password ? answer(200, { user }) : answer(400, { code: 'invalid_credentials' });
      }
      if (url.pathname === '/user_management/users' && req.method === 'GET') {
        const found = byEmail(url.searchParams.get('email'));
        return answer(200, { object: 'list', data: found ? [found] : [], list_metadata: {} });
      }
      if (url.pathname === '/user_management/users' && req.method === 'POST') {
        if (byEmail(body.email)) return answer(422, { code: 'user_creation_error', errors: [{ code: 'email_not_available', message: 'This email is not available.' }] });
        if (body.password === 'password12') return answer(422, { code: 'password_strength_error', message: 'The password is too common.' });
        const user = {
          object: 'user', id: `user_new${++made}`, email: body.email.toLowerCase(), email_verified: Boolean(body.email_verified),
          first_name: body.first_name ?? null, last_name: null, metadata: body.metadata ?? {}, password: body.password,
        };
        users.set(user.id, user);
        return answer(201, user);
      }
      const id = decodeURIComponent(url.pathname.match(/^\/user_management\/users\/([^/]+)/)?.[1] || '');
      const user = users.get(id);
      if (url.pathname.endsWith('/identities')) return answer(200, []);
      if (url.pathname.endsWith('/auth_factors')) return answer(200, { data: [] });
      if (!user) return answer(404, { code: 'entity_not_found' });
      if (req.method === 'GET') return answer(200, user);
      if (req.method === 'DELETE') { users.delete(id); return answer(202); }
      if (req.method === 'PUT') { Object.assign(user.metadata, body.metadata || {}); return answer(200, user); }
      return answer(405);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const add = (id, email, password = null) => users.set(id, { object: 'user', id, email, email_verified: true, metadata: {}, password });
  return { url: `http://127.0.0.1:${server.address().port}`, users, calls, add, setDown: (value) => { down = value; } };
}

async function serve(t, { workos = null, accounts = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-admin-create-'));
  const lines = [];
  const log = (line) => lines.push(String(line));
  const suite = createSuite({
    config: { ...PRODUCT, accounts: { minPasswordLength: 10, ...accounts } },
    env: {
      DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', PLANS: '', DEFAULT_PLAN: '',
      ...(workos ? {
        AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'sk_test', WORKOS_CLIENT_ID: 'client', WORKOS_AUTHKIT_DOMAIN: workos.url, WORKOS_API_URL: workos.url,
      } : {}),
    },
    log, exitOnError: false,
  });
  const app = createApp({ suite, version: '1.0.0', handleSignals: false, log });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  /** A browser with someone's session, or nobody's. */
  const as = (user) => {
    const cookie = user ? `demo_sid=${suite.sessions.open(user.id)}` : '';
    return async (method, pathname, body) => {
      const res = await fetch(base + pathname, {
        method,
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, text, data: text ? JSON.parse(text) : null };
    };
  };
  return { suite, base, lines, as };
}

const auditOf = (suite) => JSON.stringify(suite.audit.list({ limit: 200 }));

/* --------------------------------- passwords here -------------------------------- */

test('passwords here: email, password, role and plan, the email confirmed, and they sign in at once', async (t) => {
  const { suite, base, lines, as } = await serve(t);
  const root = suite.accounts.create({ username: 'root', password: 'root-password-1', role: 'admin' });
  const admin = as(root);

  const made = await admin('POST', '/api/admin/users', {
    email: 'Apple.Review@Example.com', display_name: 'App Review', password: SECRET, role: 'user',
    email_verified: true, plan: 'pro', ends_at: '2027-06-30T23:59:59.000Z', note: 'App Store review',
  });
  assert.equal(made.status, 201);
  assert.equal(made.data.username, 'apple.review', 'a username from the email');
  assert.equal(made.data.email, 'apple.review@example.com');
  assert.equal(made.data.email_verified, true, 'confirmed: no message to confirm it');
  assert.equal(made.data.has_password, true);
  assert.equal(made.data.plan.id, 'pro');
  assert.equal(made.data.plan_ends, '2027-06-30T23:59:59.000Z');
  assert.deepEqual([made.data.plan_source.kind, made.data.plan_source.note], ['admin', 'App Store review'], 'the admin’s plan, as Users › Plan shows it');
  assert.ok(!made.text.includes(SECRET) && !made.text.includes('password_hash'), 'the password never comes back');

  // In Users › Plan as any plan the admin gives: in the list, and in the grants.
  const listed = (await admin('GET', '/api/admin/users')).data.users.find((u) => u.id === made.data.id);
  assert.equal(listed.plan.id, 'pro');
  assert.equal(listed.plan_source.kind, 'admin');
  assert.equal((await admin('GET', `/api/admin/users/${made.data.id}/grants`)).data.grants.filter((g) => !g.revoked_at).length, 1);

  // They sign in with it now.
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'apple.review', password: SECRET }),
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.username, 'apple.review');

  // An administrator too, with a username of the admin's choosing.
  const second = await admin('POST', '/api/admin/users', { username: 'qa-admin', email: 'qa@example.com', password: SECRET, role: 'admin' });
  assert.equal(second.status, 201);
  assert.deepEqual([second.data.username, second.data.role, second.data.email_verified], ['qa-admin', 'admin', false],
    'confirmed only when the admin says so');

  const log = auditOf(suite);
  assert.match(log, /admin\.user\.create/);
  assert.match(log, /admin\.plan\.set/);
  assert.ok(!log.includes(SECRET), 'nor in the log');
  assert.ok(!lines.join('\n').includes(SECRET), 'nor in the server’s lines');
});

test('passwords here: every check before anything is made, and a clear answer for an email that has an account', async (t) => {
  const { suite, as } = await serve(t);
  const root = suite.accounts.create({ username: 'root', password: 'root-password-1', role: 'admin' });
  suite.accounts.create({ username: 'ada', email: 'ada@example.com' });
  const admin = as(root);
  const count = () => suite.accounts.list().length;
  const before = count();
  const refused = async (body) => (await admin('POST', '/api/admin/users', body)).data;

  assert.equal((await admin('POST', '/api/admin/users', { email: 'ADA@example.com', password: SECRET })).status, 409);
  assert.equal((await refused({ email: 'ADA@example.com', password: SECRET })).error, 'email_taken', 'whatever its case');
  assert.deepEqual(await refused({ email: 'not-an-email', password: SECRET }), { error: 'field_invalid', field: 'email' });
  assert.deepEqual(await refused({ email: 'short@example.com', password: 'short' }), { error: 'field_too_short', field: 'password', min: 10 });
  assert.deepEqual(await refused({ password: SECRET }), { error: 'field_required', field: 'email' });
  assert.deepEqual(await refused({ email: 'x@example.com', username: 'no spaces', password: SECRET }), { error: 'field_invalid', field: 'username' });
  assert.equal((await refused({ email: 'x@example.com', username: 'ada', password: SECRET })).error, 'username_taken');
  assert.equal((await refused({ email: 'x@example.com', role: 'owner', password: SECRET })).error, 'field_invalid');
  assert.equal((await refused({ email: 'x@example.com', password: SECRET, plan: 'platinum' })).error, 'plan_unknown');
  assert.deepEqual(await refused({ email: 'x@example.com', password: SECRET, plan: 'pro', ends_at: 'someday' }), { error: 'field_invalid', field: 'ends_at' });
  assert.deepEqual(await refused({ email: 'x@example.com', password: SECRET, email_verified: 'yes' }), { error: 'field_invalid', field: 'email_verified' });
  assert.equal(count(), before, 'nothing made by any of them');

  // Only an administrator of the instance.
  const ada = suite.accounts.byUsername('ada');
  assert.deepEqual((await as(ada)('POST', '/api/admin/users', { email: 'x@example.com', password: SECRET })).data, { error: 'admin_only' });
  assert.equal((await as(null)('POST', '/api/admin/users', { email: 'x@example.com', password: SECRET })).status, 401);
  assert.equal(count(), before);
});

/* ------------------------------------- WorkOS ------------------------------------- */

/** An install with WorkOS that owns its logins, its admin linked to a WorkOS user with a password. */
async function withWorkos(t, accounts = { adminIdentity: true, sharedIdentity: true }) {
  const workos = await fakeWorkos(t);
  const served = await serve(t, { workos, accounts });
  const root = served.suite.accounts.create({ username: 'root', displayName: 'Root', role: 'admin', email: 'root@example.com' });
  served.suite.accounts.linkIdentity(root.id, 'workos', 'user_root', { email: 'root@example.com' });
  workos.add('user_root', 'root@example.com', ADMIN_SECRET);
  return { ...served, workos, root, admin: served.as(root) };
}

test('WorkOS: the login made there with its email verified, the account here linked to it, the plan given', async (t) => {
  const { suite, lines, workos, root, admin } = await withWorkos(t);

  // What the dialog asks first: the admin's own password, to be given again (workos-security.js).
  const asked = await admin('GET', `/api/admin/users/${root.id}/sign-in`);
  assert.deepEqual([asked.data.manage, asked.data.reauth], [true, 'password']);

  const made = await admin('POST', '/api/admin/users', {
    email: 'play.review@example.com', display_name: 'Play Review', password: SECRET, role: 'user',
    plan: 'pro', note: 'Google Play review', admin_password: ADMIN_SECRET,
  });
  assert.equal(made.status, 201, made.text);
  const sent = workos.calls.find((c) => c.method === 'POST' && c.path === '/user_management/users').body;
  assert.deepEqual(sent, {
    email: 'play.review@example.com', password: SECRET, email_verified: true, first_name: 'Play Review',
    metadata: { app_demo: 'Demo' },
  }, 'verified at WorkOS, with this app’s mark');
  const [login] = [...workos.users.values()].filter((u) => u.email === 'play.review@example.com');

  assert.deepEqual([made.data.username, made.data.email, made.data.email_verified, made.data.providers],
    ['play.review', 'play.review@example.com', true, ['workos']]);
  assert.equal(made.data.has_password, false, 'no password here: it is the login’s at WorkOS');
  assert.deepEqual([made.data.plan.id, made.data.plan_source.kind, made.data.plan_source.note], ['pro', 'admin', 'Google Play review']);
  assert.ok(!made.text.includes(SECRET));

  // Signing in at AuthKit finds this account, not a new one.
  const account = await suite.idp.localUser({ id: login.id, email: login.email, email_verified: true, first_name: 'Play Review' });
  assert.equal(account.id, made.data.id);
  assert.equal(suite.accounts.list().filter((u) => u.email === 'play.review@example.com').length, 1);

  const log = auditOf(suite);
  assert.match(log, /"provider":"workos"/);
  assert.ok(!log.includes(SECRET) && !log.includes(ADMIN_SECRET), 'neither password in the log');
  assert.ok(!lines.join('\n').includes(SECRET), 'nor in the server’s lines');
});

test('WorkOS: only with the admin’s own password again, and never over a login WorkOS already has', async (t) => {
  const { suite, workos, admin } = await withWorkos(t);
  workos.add('user_focus', 'focus.person@example.com');
  const before = suite.accounts.list().length;
  const posts = () => workos.calls.filter((c) => c.method === 'POST' && c.path === '/user_management/users').length;
  const ask = (body) => admin('POST', '/api/admin/users', { password: SECRET, admin_password: ADMIN_SECRET, ...body });

  const wrong = await ask({ email: 'new@example.com', admin_password: 'not-mine' });
  assert.deepEqual([wrong.status, wrong.data.error], [403, 'wrong_password']);
  assert.equal(posts(), 0, 'WorkOS isn’t asked to make anything');

  const there = await ask({ email: 'Focus.Person@example.com' });
  assert.equal(there.status, 409);
  assert.deepEqual(there.data, { error: 'email_taken_provider', provider: 'WorkOS' }, 'someone’s login, maybe of another app');
  assert.equal(posts(), 0);

  const here = await ask({ email: 'root@example.com' });
  assert.deepEqual([here.status, here.data.error], [409, 'email_taken']);

  const weak = await ask({ email: 'weak@example.com', password: 'password12' });
  assert.deepEqual([weak.status, weak.data.error, weak.data.detail], [400, 'password_rejected', 'The password is too common.']);
  assert.deepEqual((await ask({ email: 'short@example.com', password: 'seven77' })).data, { error: 'field_too_short', field: 'password', min: 8 },
    'WorkOS’s shortest, not this app’s');

  workos.setDown(true);
  const down = await ask({ email: 'later@example.com' });
  workos.setDown(false);
  assert.deepEqual([down.status, down.data.error], [503, 'provider_unavailable']);
  assert.equal(suite.accounts.list().length, before, 'no account here for any of them');
});

test('WorkOS: a login made for an account that then couldn’t be made goes too', async (t) => {
  const { suite, workos, admin } = await withWorkos(t);
  let broken = true;
  // Something the app makes for a newcomer fails (accounts.whenCreated runs in the account's transaction).
  suite.accounts.whenCreated(() => { if (broken) throw new Error('the app could not set up the newcomer'); });
  const before = suite.accounts.list().length;
  // The server prints what failed (app.js), here kept out of the test's output and read instead.
  const printed = t.mock.method(console, 'error', () => {});
  const failed = await admin('POST', '/api/admin/users', { email: 'half@example.com', password: SECRET, admin_password: ADMIN_SECRET, plan: 'pro' });
  printed.mock.restore();
  assert.equal(failed.status, 500);
  const said = printed.mock.calls.map((call) => call.arguments.map(String).join(' ')).join('\n');
  assert.match(said, /POST \/api\/admin\/users/);
  assert.ok(!said.includes(SECRET), 'what is printed carries no password');
  assert.equal(suite.accounts.list().length, before, 'no account here');
  assert.equal([...workos.users.values()].some((u) => u.email === 'half@example.com'), false, 'nor its login at WorkOS');
  assert.ok(workos.calls.some((c) => c.method === 'DELETE'));

  broken = false;
  assert.equal((await admin('POST', '/api/admin/users', { email: 'half@example.com', password: SECRET, admin_password: ADMIN_SECRET })).status, 201,
    'and it can be made again');
});

test('WorkOS without a password: the account waits for its person, as before', async (t) => {
  const { suite, workos, admin } = await withWorkos(t);
  const made = await admin('POST', '/api/admin/users', { email: 'later@example.com', role: 'user', plan: 'pro' });
  assert.equal(made.status, 201);
  assert.deepEqual([made.data.username, made.data.providers, made.data.email_verified, made.data.plan.id], ['later', [], false, 'pro']);
  assert.equal(workos.calls.filter((c) => c.method === 'POST' && c.path === '/user_management/users').length, 0, 'nothing made at WorkOS');
  // Their own sign-in at WorkOS, verified, takes it.
  workos.add('user_later', 'later@example.com');
  assert.equal((await suite.idp.localUser({ id: 'user_later', email: 'later@example.com', email_verified: true })).id, made.data.id);
});

test('WorkOS where the install doesn’t own the logins: no password can be given', async (t) => {
  const { suite, workos, admin, root } = await withWorkos(t, { adminIdentity: false, sharedIdentity: true });
  assert.equal((await admin('GET', `/api/admin/users/${root.id}/sign-in`)).data.manage, false, 'the dialog offers none');
  const before = suite.accounts.list().length;
  const refused = await admin('POST', '/api/admin/users', { email: 'x@example.com', password: SECRET, admin_password: ADMIN_SECRET });
  assert.deepEqual([refused.status, refused.data.error], [400, 'password_not_here']);
  assert.equal(suite.accounts.list().length, before);
  assert.equal(workos.calls.filter((c) => c.method === 'POST' && c.path === '/user_management/users').length, 0);
});
