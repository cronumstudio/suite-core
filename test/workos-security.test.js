/**
 * Password and two-step verification for WorkOS accounts, from Settings
 * (workos-security.js), with WorkOS faked: what each person is offered by how
 * they sign in, the checks before each change, and the admin's way out for
 * whoever lost the phone. And the client's calls to WorkOS (workos.js), with
 * fetch faked.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { createRouter } from '../http.js';
import { createAccounts } from '../accounts.js';
import { createSessions } from '../sessions.js';
import { workosUsers, signInMethod } from '../workos-accounts.js';
import { registerWorkosSecurityApi } from '../workos-security.js';
import { createWorkosClient, WorkosUnavailable } from '../workos.js';
import { base32Decode, totp } from '../two-factor.js';

const now = () => Math.floor(Date.now() / 1000 / 30);

/** WorkOS as far as these routes see it: users with a password, linked accounts and factors. */
function fakeWorkos() {
  const people = new Map();
  let down = false;
  let factorIds = 0;
  const person = (id) => people.get(id);
  const fail = () => { if (down) throw new WorkosUnavailable('WorkOS answered 503'); };
  return {
    people,
    set down(value) { down = value; },
    add: (id, { email, password = null, identities = [] }) => people.set(id, { email, password, identities, factors: [] }),
    account: async (id) => { fail(); return person(id) ? { id, email: person(id).email } : null; },
    checkPassword: async ({ email, password }) => {
      fail();
      return [...people.values()].some((p) => p.email === email && p.password && p.password === password);
    },
    setPassword: async (id, password) => {
      fail();
      if (password === 'password1') return { refused: 'Password is too common' };
      person(id).password = password;
      return { ok: true };
    },
    identities: async (id) => { fail(); return person(id)?.identities || []; },
    factors: async (id) => { fail(); return person(id)?.factors.map(({ id: fid }) => ({ id: fid })) || []; },
    enrollTotp: async (id, { secret }) => {
      fail();
      const factor = { id: `auth_factor_${++factorIds}`, secret };
      person(id).factors.push(factor);
      return { id: factor.id };
    },
    checkCode: async (factorId, code) => {
      const factor = [...people.values()].flatMap((p) => p.factors).find((f) => f.id === factorId);
      return Boolean(factor) && totp(base32Decode(factor.secret), now()) === code;
    },
    deleteFactor: async (factorId) => {
      for (const p of people.values()) p.factors = p.factors.filter((f) => f.id !== factorId);
    },
  };
}

function start({ twoFactor = 'on', adminIdentity = false, clock = () => Date.now() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-workos-security-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const sessions = createSessions({ database, secret: 's3cret', cookieName: 'sid' });
  const accounts = createAccounts({ database, sessions });
  const users = workosUsers(accounts, { database });
  const workos = fakeWorkos();
  const revoked = [];
  // With adminIdentity, revoke.js as createApp gives it: who was revoked, keeping what, and why.
  const revokedAll = [];
  const revokeEverything = (id, { keep = null, reason = null } = {}) => {
    revokedAll.push({ id, keep: keep?.sessionToken ?? null, reason });
    sessions.closeAllOf(id, { exceptToken: keep?.sessionToken ?? null });
    return {};
  };
  const router = createRouter();
  registerWorkosSecurityApi(router, {
    workos, users, accounts, sessions, appName: 'Cronum Work', twoFactor, revokeAtProvider: (ids) => revoked.push(...ids),
    ...(adminIdentity ? { adminIdentity, revokeEverything } : {}), clock,
  });

  /** Someone who signs in with WorkOS: their account here and at WorkOS, with a session. */
  const person = ({ username, role = 'user', method = null, ...atWorkos }) => {
    const workosId = `user_${username}`;
    const user = users.create({ username, displayName: username, role, email: `${username}@example.com`, workosId });
    workos.add(workosId, { email: `${username}@example.com`, ...atWorkos });
    if (method) users.signedIn(user, { id: workosId }, method);
    const token = sessions.open(user.id, { idpSessionId: `session_${username}` });
    return { user: accounts.byId(user.id), token, workosId };
  };

  /** A request to one of the routes, as the router hands it over. */
  async function call(method, pathname, { as, body = null } = {}) {
    const found = router.match(method, pathname);
    if (!found?.handler) return { status: 404, body: { error: 'not_found' } };
    const raw = body == null ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Object.assign(Readable.from(raw), {
      headers: body == null ? {} : { 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' },
    });
    const answer = { status: 0, body: null };
    const res = {
      writeHead: (status) => { answer.status = status; },
      end: (text) => { answer.body = text ? JSON.parse(text) : null; },
    };
    const ctx = { req, res, params: found.params, user: as ? accounts.byId(as.user.id) : null, sessionToken: as?.token ?? null };
    try {
      await found.handler(ctx);
    } catch (err) {
      return { status: err.status || 500, body: { error: err.code || err.message } };
    }
    return answer;
  }

  return { database, sessions, accounts, users, workos, revoked, revokedAll, call, person };
}

/* ------------------------------ how they sign in ------------------------------ */

test('the sign-in method WorkOS names is noted as the suite names it', () => {
  assert.equal(signInMethod('Password'), 'password');
  assert.equal(signInMethod('GoogleOAuth'), 'google');
  assert.equal(signInMethod('AppleOAuth'), 'apple');
  assert.equal(signInMethod('MagicAuth'), 'email_code');
  assert.equal(signInMethod('SSO'), 'sso');
  assert.equal(signInMethod('SomethingNewOAuth'), 'somethingnew');
  assert.equal(signInMethod('Impersonation'), null, 'an admin acting as them is not how they sign in');
  assert.equal(signInMethod(null), null);

  const { person, users, workos } = start();
  const ada = person({ username: 'ada', password: 'correct horse', method: 'GoogleOAuth' });
  assert.equal(users.methodOf(ada.user.id), 'google');
  // The next sign-in, with the password, says so; an impersonation leaves it as it was.
  users.signedIn(ada.user, { id: ada.workosId }, 'Password');
  users.signedIn(ada.user, { id: ada.workosId }, 'Impersonation');
  assert.equal(users.methodOf(ada.user.id), 'password');
  assert.ok(workos.people.has(ada.workosId));
});

test('Google or Apple: no password here, nor a second step, and Settings says where they are', async () => {
  const { person, call } = start();
  const google = person({ username: 'gus', method: 'GoogleOAuth' });
  assert.deepEqual((await call('GET', '/api/me/sign-in', { as: google })).body,
    { method: 'google', password: false, two_factor: { available: false } });
  const apple = person({ username: 'ana', method: 'AppleOAuth' });
  assert.equal((await call('GET', '/api/me/sign-in', { as: apple })).body.method, 'apple');
  // Nothing to change here: the routes refuse it too.
  const tried = await call('POST', '/api/me/sign-in/password', { as: google, body: { current_password: 'x', password: 'a much longer one' } });
  assert.deepEqual([tried.status, tried.body.error], [400, 'password_elsewhere']);
  const setup = await call('POST', '/api/me/sign-in/two-factor/setup', { as: google, body: { password: 'x' } });
  assert.deepEqual([setup.status, setup.body.error], [400, 'password_elsewhere']);
});

test('someone who hasn\'t signed in since the method is noted: the accounts WorkOS links to them say it', async () => {
  const { person, call } = start();
  const linked = person({ username: 'lin', identities: ['AppleOAuth'] });
  assert.equal((await call('GET', '/api/me/sign-in', { as: linked })).body.method, 'apple');
  const plain = person({ username: 'pat', password: 'correct horse' });
  assert.deepEqual((await call('GET', '/api/me/sign-in', { as: plain })).body,
    { method: 'password', password: true, two_factor: { available: true, enabled: false } });
});

/* --------------------------------- password ---------------------------------- */

test('a new password, given the current one: WorkOS takes it and the other sessions end', async () => {
  const { person, call, sessions, revoked, workos } = start();
  const ada = person({ username: 'ada', password: 'correct horse', method: 'Password' });
  const other = sessions.open(ada.user.id, { idpSessionId: 'session_phone' });

  const wrong = await call('POST', '/api/me/sign-in/password', { as: ada, body: { current_password: 'nope', password: 'battery staple 42' } });
  assert.deepEqual([wrong.status, wrong.body.error], [403, 'wrong_password']);
  const short = await call('POST', '/api/me/sign-in/password', { as: ada, body: { current_password: 'correct horse', password: 'short' } });
  assert.deepEqual([short.status, short.body.error], [400, 'password_rejected']);
  const weak = await call('POST', '/api/me/sign-in/password', { as: ada, body: { current_password: 'correct horse', password: 'password1' } });
  assert.deepEqual([weak.status, weak.body.error], [400, 'password_rejected'], 'what WorkOS refuses');

  const done = await call('POST', '/api/me/sign-in/password', { as: ada, body: { current_password: 'correct horse', password: 'battery staple 42' } });
  assert.equal(done.status, 200);
  assert.equal(workos.people.get(ada.workosId).password, 'battery staple 42');
  assert.ok(sessions.userFrom({ headers: { cookie: `sid=${ada.token}` } }), 'this browser stays in');
  assert.equal(sessions.userFrom({ headers: { cookie: `sid=${other}` } }), null, 'the phone is out');
  assert.deepEqual(revoked, ['session_phone'], 'and at WorkOS too');
});

test('WorkOS not answering is a 503 to try again, not a wrong password', async () => {
  const { person, call, workos } = start();
  const ada = person({ username: 'ada', password: 'correct horse', method: 'Password' });
  workos.down = true;
  const answer = await call('POST', '/api/me/sign-in/password', { as: ada, body: { current_password: 'correct horse', password: 'battery staple 42' } });
  assert.deepEqual([answer.status, answer.body.error], [503, 'provider_unavailable']);
});

/* ------------------------------ two-step verification ------------------------------ */

test('two-step verification: optional, checked here before WorkOS gets it, off with the password and a code', async () => {
  const { person, call, workos } = start();
  const ada = person({ username: 'ada', password: 'correct horse', method: 'Password' });

  const noPassword = await call('POST', '/api/me/sign-in/two-factor/setup', { as: ada, body: { password: 'nope' } });
  assert.deepEqual([noPassword.status, noPassword.body.error], [403, 'wrong_password']);
  const setup = await call('POST', '/api/me/sign-in/two-factor/setup', { as: ada, body: { password: 'correct horse' } });
  assert.equal(setup.status, 200);
  assert.match(setup.body.uri, /^otpauth:\/\/totp\/Cronum%20Work%3Aada%40example\.com\?secret=[A-Z2-7]+&issuer=Cronum%20Work/);
  // Nothing at WorkOS until the first code is right: no factor half set up for AuthKit to ask for.
  assert.equal(workos.people.get(ada.workosId).factors.length, 0);
  const bad = await call('POST', '/api/me/sign-in/two-factor/enable', { as: ada, body: { code: '000000' } });
  assert.deepEqual([bad.status, bad.body.error], [400, 'code_invalid']);
  assert.equal(workos.people.get(ada.workosId).factors.length, 0);

  const key = base32Decode(setup.body.secret);
  const on = await call('POST', '/api/me/sign-in/two-factor/enable', { as: ada, body: { code: totp(key, now()) } });
  assert.equal(on.status, 200);
  assert.equal(workos.people.get(ada.workosId).factors.length, 1);
  assert.equal(workos.people.get(ada.workosId).factors[0].secret, setup.body.secret, 'the secret the phone has');
  assert.equal((await call('GET', '/api/me/sign-in', { as: ada })).body.two_factor.enabled, true);
  const again = await call('POST', '/api/me/sign-in/two-factor/setup', { as: ada, body: { password: 'correct horse' } });
  assert.deepEqual([again.status, again.body.error], [409, 'two_factor_enabled']);

  // Off: the password alone is not enough, nor a wrong code.
  const noCode = await call('POST', '/api/me/sign-in/two-factor/disable', { as: ada, body: { password: 'correct horse', code: '123456' } });
  assert.deepEqual([noCode.status, noCode.body.error], [400, 'code_invalid']);
  const off = await call('POST', '/api/me/sign-in/two-factor/disable', { as: ada, body: { password: 'correct horse', code: totp(key, now()) } });
  assert.equal(off.status, 200);
  assert.equal(workos.people.get(ada.workosId).factors.length, 0);
});

test('while it is tried out, only administrators are offered the second step', async () => {
  const { person, call } = start({ twoFactor: 'admins' });
  const user = person({ username: 'pat', password: 'correct horse', method: 'Password' });
  const admin = person({ username: 'ada', role: 'admin', password: 'correct horse', method: 'Password' });
  assert.deepEqual((await call('GET', '/api/me/sign-in', { as: user })).body.two_factor, { available: false });
  assert.equal((await call('POST', '/api/me/sign-in/two-factor/setup', { as: user, body: { password: 'correct horse' } })).status, 404);
  assert.deepEqual((await call('GET', '/api/me/sign-in', { as: admin })).body.two_factor, { available: true, enabled: false });
  // Changing the password is for everyone.
  assert.equal((await call('POST', '/api/me/sign-in/password', { as: user, body: { current_password: 'correct horse', password: 'battery staple 42' } })).status, 200);
});

/* ---------------------------------- the admin ---------------------------------- */

test('the admin: how someone signs in, their second step off when they lost the phone, a new password', async () => {
  const { person, call, workos, sessions, revokedAll } = start({ adminIdentity: true });
  const admin = person({ username: 'root', role: 'admin', password: 'correct horse', method: 'Password' });
  const ada = person({ username: 'ada', password: 'correct horse', method: 'Password' });
  const gus = person({ username: 'gus', method: 'GoogleOAuth' });
  workos.people.get(ada.workosId).factors.push({ id: 'auth_factor_lost', secret: 'JBSWY3DPEHPK3PXP' });
  const again = { admin_password: 'correct horse' };

  assert.equal((await call('GET', `/api/admin/users/${ada.user.id}/sign-in`, { as: ada })).status, 403, 'only for admins');
  assert.deepEqual((await call('GET', `/api/admin/users/${ada.user.id}/sign-in`, { as: admin })).body,
    { method: 'password', password: true, two_factor: { enabled: true }, manage: true, reauth: 'password' });
  assert.deepEqual((await call('GET', `/api/admin/users/${gus.user.id}/sign-in`, { as: admin })).body,
    { method: 'google', password: false, two_factor: { enabled: false }, manage: true, reauth: 'password' });

  // The admin's cookie alone is not enough: their password again.
  const bare = await call('DELETE', `/api/admin/users/${ada.user.id}/sign-in/two-factor`, { as: admin });
  assert.deepEqual([bare.status, bare.body.error], [403, 'wrong_password']);
  assert.equal(workos.people.get(ada.workosId).factors.length, 1, 'nothing changed');
  assert.equal((await call('DELETE', `/api/admin/users/${ada.user.id}/sign-in/two-factor`, { as: admin, body: again })).status, 200);
  assert.equal(workos.people.get(ada.workosId).factors.length, 0);
  assert.deepEqual(revokedAll.at(-1), { id: ada.user.id, keep: null, reason: 'admin_two_factor_off' }, 'whatever let them in ends');
  const twice = await call('DELETE', `/api/admin/users/${ada.user.id}/sign-in/two-factor`, { as: admin, body: again });
  assert.deepEqual([twice.status, twice.body.error], [409, 'two_factor_off']);

  const ada2 = sessions.open(ada.user.id, { idpSessionId: 'session_ada_2' });
  const wrong = await call('PUT', `/api/admin/users/${ada.user.id}/sign-in/password`,
    { as: admin, body: { password: 'a brand new one', admin_password: 'not it' } });
  assert.deepEqual([wrong.status, wrong.body.error], [403, 'wrong_password']);
  assert.equal(workos.people.get(ada.workosId).password, 'correct horse', 'WorkOS was not asked to change it');
  assert.equal((await call('PUT', `/api/admin/users/${ada.user.id}/sign-in/password`,
    { as: admin, body: { password: 'a brand new one', ...again } })).status, 200);
  assert.equal(workos.people.get(ada.workosId).password, 'a brand new one');
  assert.equal(sessions.userFrom({ headers: { cookie: `sid=${ada2}` } }), null, 'they are signed out');
  assert.deepEqual(revokedAll.at(-1), { id: ada.user.id, keep: null, reason: 'admin_password' });

  // Whoever signs in with Google gets no password from the admin: it would be one they never had.
  const google = await call('PUT', `/api/admin/users/${gus.user.id}/sign-in/password`,
    { as: admin, body: { password: 'a brand new one', ...again } });
  assert.deepEqual([google.status, google.body.error], [400, 'password_elsewhere']);
  assert.equal(workos.people.get(gus.workosId).password, null);
  assert.equal((await call('GET', '/api/admin/users/999/sign-in', { as: admin })).status, 404);
});

test('the admin with a second step gives a code too; one who signs in with Google, a recent sign-in', async () => {
  const later = { ms: 0 };
  const { person, call, workos, revokedAll } = start({ adminIdentity: true, clock: () => Date.now() + later.ms });
  const root = person({ username: 'root', role: 'admin', password: 'correct horse', method: 'Password' });
  const ada = person({ username: 'ada', password: 'correct horse', method: 'Password' });
  const secret = 'JBSWY3DPEHPK3PXP';
  workos.people.get(root.workosId).factors.push({ id: 'auth_factor_root', secret });
  assert.equal((await call('GET', `/api/admin/users/${ada.user.id}/sign-in`, { as: root })).body.reauth, 'password_code');
  const noCode = await call('PUT', `/api/admin/users/${ada.user.id}/sign-in/password`,
    { as: root, body: { password: 'a brand new one', admin_password: 'correct horse' } });
  assert.deepEqual([noCode.status, noCode.body.error], [400, 'code_invalid']);
  assert.equal(workos.people.get(ada.workosId).password, 'correct horse');
  const code = totp(base32Decode(secret), now());
  assert.equal((await call('PUT', `/api/admin/users/${ada.user.id}/sign-in/password`,
    { as: root, body: { password: 'a brand new one', admin_password: 'correct horse', admin_code: code } })).status, 200);

  // An admin who signs in with Google: a session opened in the last minutes, else sign in again.
  const gia = person({ username: 'gia', role: 'admin', method: 'GoogleOAuth' });
  assert.equal((await call('GET', `/api/admin/users/${ada.user.id}/sign-in`, { as: gia })).body.reauth, 'session');
  assert.equal((await call('PUT', `/api/admin/users/${ada.user.id}/sign-in/password`,
    { as: gia, body: { password: 'another new one' } })).status, 200, 'just signed in');
  later.ms = 11 * 60 * 1000;
  const stale = await call('PUT', `/api/admin/users/${ada.user.id}/sign-in/password`, { as: gia, body: { password: 'a third new one' } });
  assert.deepEqual([stale.status, stale.body.error], [401, 'reauth_required']);
  assert.equal(workos.people.get(ada.workosId).password, 'another new one');
  assert.equal(revokedAll.length, 2);
});

test('an install that does not own the identities: the admin sees how they sign in, and changes nothing', async () => {
  const { person, call, workos } = start();
  const admin = person({ username: 'root', role: 'admin', password: 'correct horse', method: 'Password' });
  const ada = person({ username: 'ada', password: 'correct horse', method: 'Password' });
  workos.people.get(ada.workosId).factors.push({ id: 'auth_factor_lost', secret: 'JBSWY3DPEHPK3PXP' });
  assert.deepEqual((await call('GET', `/api/admin/users/${ada.user.id}/sign-in`, { as: admin })).body,
    { method: 'password', password: true, two_factor: { enabled: true }, manage: false });
  const again = { admin_password: 'correct horse' };
  assert.equal((await call('DELETE', `/api/admin/users/${ada.user.id}/sign-in/two-factor`, { as: admin, body: again })).status, 404);
  assert.equal((await call('PUT', `/api/admin/users/${ada.user.id}/sign-in/password`,
    { as: admin, body: { password: 'a brand new one', ...again } })).status, 404);
  assert.equal(workos.people.get(ada.workosId).factors.length, 1);
  assert.equal(workos.people.get(ada.workosId).password, 'correct horse');
});

/* --------------------------------- the client --------------------------------- */

test('the client: the password asked as a sign-in and its session closed, factors, a new password', async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  const payload = Buffer.from(JSON.stringify({ sid: 'session_check' })).toString('base64url');
  const answers = [];
  globalThis.fetch = async (url, options = {}) => {
    asked.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    const [status, body] = answers.shift() || [200, {}];
    return { status, ok: status < 300, json: async () => body };
  };
  try {
    const workos = createWorkosClient({ apiKey: 'sk_test', clientId: 'client_1', authkitDomain: 'x.authkit.app' });
    answers.push([200, { user: { id: 'user_1' }, access_token: `e30.${payload}.sig` }], [200, {}]);
    assert.equal(await workos.checkPassword({ email: 'a@b.c', password: 'right' }), true);
    assert.deepEqual(asked[0].body, { grant_type: 'password', client_id: 'client_1', client_secret: 'sk_test', email: 'a@b.c', password: 'right' });
    assert.match(asked[1].url, /\/user_management\/sessions\/revoke$/);
    assert.deepEqual(asked[1].body, { session_id: 'session_check' }, 'the session the check opened is closed');

    answers.push([403, { code: 'mfa_challenge' }]);
    assert.equal(await workos.checkPassword({ email: 'a@b.c', password: 'right' }), true, 'only a second step to go');
    answers.push([400, { error: 'invalid_credentials' }]);
    assert.equal(await workos.checkPassword({ email: 'a@b.c', password: 'wrong' }), false);
    answers.push([503, {}]);
    await assert.rejects(workos.checkPassword({ email: 'a@b.c', password: 'x' }), WorkosUnavailable);

    answers.push([200, { data: [{ id: 'auth_factor_1', type: 'totp' }, { id: 'auth_factor_2', type: 'sms' }] }]);
    assert.deepEqual(await workos.factors('user_1'), [{ id: 'auth_factor_1', created_at: null }], 'authenticator apps only');

    asked.length = 0;
    answers.push([201, { authentication_factor: { id: 'auth_factor_3' }, authentication_challenge: { id: 'auth_challenge_1' } }], [200, { valid: true }]);
    assert.deepEqual(await workos.enrollTotp('user_1', { secret: 'JBSWY3DPEHPK3PXP', issuer: 'Cronum Work', user: 'a@b.c', code: '123456' }), { id: 'auth_factor_3' });
    assert.deepEqual(asked[0].body, { type: 'totp', totp_secret: 'JBSWY3DPEHPK3PXP', totp_issuer: 'Cronum Work', totp_user: 'a@b.c' });
    assert.match(asked[1].url, /\/auth\/challenges\/auth_challenge_1\/verify$/);

    asked.length = 0;
    answers.push([404, {}]);
    await workos.deleteFactor('auth_factor_gone');
    assert.deepEqual([asked[0].method, new URL(asked[0].url).pathname], ['DELETE', '/auth/factors/auth_factor_gone']);

    answers.push([422, { message: 'Password does not meet strength requirements' }]);
    assert.deepEqual(await workos.setPassword('user_1', 'weak'), { refused: 'Password does not meet strength requirements' });
    answers.push([200, [{ type: 'OAuth', provider: 'GoogleOAuth' }]]);
    assert.deepEqual(await workos.identities('user_1'), ['GoogleOAuth']);
  } finally {
    globalThis.fetch = realFetch;
  }
});
