/**
 * A login shared with other apps (`accounts.sharedIdentity`): each app notes
 * itself on the person's WorkOS user, and deleting an account here takes that
 * user too only when the person uses no other app, or chooses so; the admin's
 * deletion only when the admin ticks it. Over real HTTP against a fake WorkOS,
 * then the deletion service on its own.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSuite, createApp, identityMark } from '../app.js';
import { createAccountDeletion } from '../account-deletion.js';
import { createAccounts, usersSchema, accountDeletionSchema, identitiesSchema, identityDeletionSchema } from '../accounts.js';
import { resolveConfig } from '../config.js';
import { openDatabase } from '../db.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * WorkOS's users: read, their metadata changed partially (null deletes a key), deleted. And the
 * code of a sign-in exchanged for its user, with an access token saying when they last actively
 * signed in (`auth_time`, in seconds), as `codes` holds it for each code.
 */
async function fakeWorkos(t) {
  const users = new Map();
  const calls = [];
  const codes = new Map();
  let down = false;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const answer = (status, body = {}) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/user_management/authenticate' && req.method === 'POST') {
        const code = codes.get(JSON.parse(raw).code);
        if (!code) return answer(400, { error: 'invalid_grant' });
        const token = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sid: `session_${code.id}`, sub: code.id, auth_time: code.authTime })}.x`;
        return answer(200, { user: users.get(code.id), access_token: token, authentication_method: 'GoogleOAuth' });
      }
      const id = decodeURIComponent(req.url.match(/^\/user_management\/users\/([^/?]+)$/)?.[1] || '');
      calls.push(`${req.method} ${id}`);
      if (down) return answer(503);
      const user = users.get(id);
      if (!user) return answer(404, { code: 'entity_not_found' });
      if (req.method === 'GET') return answer(200, user);
      if (req.method === 'DELETE') { users.delete(id); return answer(202); }
      if (req.method === 'PUT') {
        for (const [key, value] of Object.entries(JSON.parse(raw).metadata || {})) {
          if (value === null) delete user.metadata[key];
          else user.metadata[key] = value;
        }
        return answer(200, user);
      }
      return answer(405);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const add = (id, metadata = {}) => users.set(id, { id, object: 'user', email: `${id}@example.com`, email_verified: true, metadata: { ...metadata } });
  return { url: `http://127.0.0.1:${server.address().port}`, users, calls, codes, add, setDown: (value) => { down = value; } };
}

async function serve(t, workos, { sharedIdentity = true, adminIdentity = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-shared-identity-'));
  const suite = createSuite({
    config: { app: { id: 'demo', name: 'Démo', port: 3999, languages: ['en'] }, accounts: { minPasswordLength: 8, sharedIdentity, adminIdentity } },
    env: {
      DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'sk_test',
      WORKOS_CLIENT_ID: 'client', WORKOS_AUTHKIT_DOMAIN: workos.url, WORKOS_API_URL: workos.url,
    },
    log: () => {}, exitOnError: false,
  });
  const app = createApp({ suite, version: '1.0.0', handleSignals: false, log: () => {} });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  /** A browser with this session's cookie. */
  const callWith = (cookie) => async (method, pathname, body) => {
    const res = await fetch(base + pathname, {
      method, redirect: 'manual',
      headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  /** Someone with an account here linked to a WorkOS user, and their browser. */
  const person = (username, workosId, role = 'user') => {
    const user = suite.accounts.create({ username, displayName: username, role, email: `${workosId}@example.com` });
    suite.accounts.linkIdentity(user.id, 'workos', workosId, { email: `${workosId}@example.com` });
    return { user, call: callWith(`demo_sid=${suite.sessions.open(user.id)}`) };
  };
  /**
   * A sign-in at WorkOS through the app, as the admin panel sends someone to it (`prompt=login`, back
   * at /admin): AuthKit's address, where it lands, and the browser it leaves signed in. `authTime`:
   * when, AuthKit's token says, they last actively signed in (seconds).
   */
  const signIn = async (workosId, { authTime }) => {
    const out = await fetch(`${base}/auth/login?prompt=login&return=%2Fadmin`, { redirect: 'manual' });
    const target = new URL(out.headers.get('location'));
    const state = (out.headers.getSetCookie?.() || []).find((c) => c.startsWith('demo_auth='))?.split(';')[0] ?? '';
    const code = `code-${workosId}-${Math.random()}`;
    workos.codes.set(code, { id: workosId, authTime });
    const back = await fetch(`${base}/auth/callback?code=${code}&state=${target.searchParams.get('state')}`,
      { redirect: 'manual', headers: { Cookie: state } });
    const cookie = (back.headers.getSetCookie?.() || []).find((c) => c.startsWith('demo_sid='))?.split(';')[0];
    return { target, back: back.headers.get('location'), call: callWith(cookie) };
  };
  return { suite, person, signIn };
}

test('identityMark: app_<id> and the name in ASCII, as WorkOS takes them', () => {
  assert.deepEqual(identityMark({ id: 'work', name: 'Cronum Work' }), { key: 'app_work', name: 'Cronum Work' });
  assert.deepEqual(identityMark({ id: 'demo', name: 'Démo ✓' }), { key: 'app_demo', name: 'Demo' });
  assert.deepEqual(identityMark({ id: 'notes', name: '日本' }), { key: 'app_notes', name: 'notes' }, 'nothing left: its id');
  const errors = (accounts) => resolveConfig({ app: { id: 'demo', name: 'Demo' }, accounts }, {}).errors ?? [];
  assert.ok(errors({ sharedIdentity: 'yes' }).some((e) => e.includes('accounts.sharedIdentity')));
  assert.ok(errors({ sharedIdentity: true, deleteAtProviders: true }).some((e) => e.includes('one or the other')));
});

test('a shared login: noted at WorkOS, asked about when the person uses another app, deleted with the account only so', async (t) => {
  const workos = await fakeWorkos(t);
  workos.add('user_ana');
  workos.add('user_bea', { app_focus: 'Focus' });
  workos.add('user_cai', { app_focus: 'Focus', app_tracker: 'Tracker' });
  workos.add('user_root');
  const { suite, person, signIn } = await serve(t, workos);
  const admin = person('root', 'user_root', 'admin');
  const ana = person('ana', 'user_ana');
  const bea = person('bea', 'user_bea');
  const cai = person('cai', 'user_cai');

  // Whoever was here before this app noted itself is noted once, by its name in ASCII.
  assert.equal(await suite.workos.markAll(), 4);
  assert.equal(workos.users.get('user_bea').metadata.app_demo, 'Demo');
  assert.equal(workos.users.get('user_bea').metadata.app_focus, 'Focus', 'what other apps noted stays');
  assert.equal(await suite.workos.markAll(), 0, 'and never again');

  assert.equal((await ana.call('GET', '/api/auth/config')).data.deletion_identity, true);
  assert.deepEqual((await ana.call('GET', '/api/me/deletion')).data, { other_apps: [] });
  assert.deepEqual((await bea.call('GET', '/api/me/deletion')).data, { other_apps: ['Focus'] }, 'its own name is not another app');

  // Ana uses only this app: not asked. Bea keeps her login for Focus. Cai lets it go.
  assert.equal((await ana.call('POST', '/api/me/deletion', { confirm: true })).status, 200);
  assert.equal((await bea.call('POST', '/api/me/deletion', { confirm: true, identity: false })).status, 200);
  assert.equal((await cai.call('POST', '/api/me/deletion', { confirm: true, identity: 'yes' })).status, 400, 'true or false only');
  assert.equal((await cai.call('POST', '/api/me/deletion', { confirm: true, identity: true })).status, 200);
  assert.deepEqual([ana, bea, cai].map(({ user }) => suite.accounts.byId(user.id).delete_identity), ['auto', 'none', 'all']);

  // When their days are over: Ana's and Cai's WorkOS users go; Bea's stays, no longer naming this app.
  suite.database.run('UPDATE users SET delete_after = ? WHERE delete_after IS NOT NULL', new Date(Date.now() - DAY).toISOString());
  assert.equal(await suite.deletion.sweep(), 3);
  assert.equal(workos.users.has('user_ana'), false);
  assert.equal(workos.users.has('user_cai'), false);
  assert.deepEqual(workos.users.get('user_bea').metadata, { app_focus: 'Focus' });

  // The admin: the login stays unless ticked.
  workos.add('user_dan', { app_focus: 'Focus' });
  workos.add('user_eve');
  const dan = person('dan', 'user_dan');
  const eve = person('eve', 'user_eve');
  await suite.workos.markAll();
  assert.deepEqual((await admin.call('GET', `/api/admin/users/${dan.user.id}/other-apps`)).data, { other_apps: ['Focus'] });
  assert.equal((await admin.call('DELETE', `/api/admin/users/${dan.user.id}`)).status, 200);
  assert.equal(suite.accounts.byId(dan.user.id), null);
  assert.deepEqual(workos.users.get('user_dan').metadata, { app_focus: 'Focus' }, 'unticked: their login stays, without this app');
  workos.setDown(true);
  assert.equal((await admin.call('DELETE', `/api/admin/users/${eve.user.id}?identity=1`)).status, 503, 'WorkOS down: nothing goes');
  assert.ok(suite.accounts.byId(eve.user.id));
  assert.deepEqual((await admin.call('GET', `/api/admin/users/${eve.user.id}/other-apps`)).data, { other_apps: null }, 'not known');
  workos.setDown(false);
  // A stolen cookie is not enough: the admin's own password again, or nothing goes.
  const wrong = await admin.call('DELETE', `/api/admin/users/${eve.user.id}?identity=1`, { admin_password: 'not-it' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.data.error, 'wrong_password');
  assert.ok(workos.users.has('user_eve') && suite.accounts.byId(eve.user.id), 'nothing went');
  // Who signs in elsewhere (Google…) has no password here: a sign-in at WorkOS instead, in which they
  // actively signed in after the server asked (AuthKit's auth_time). A session alone, however new,
  // isn't one: AuthKit signs a browser in again without a word while its own session lasts.
  suite.accounts.usedIdentity('workos', 'user_root', { method: 'google' });
  const seconds = () => Math.floor(Date.now() / 1000);
  const bare = await admin.call('DELETE', `/api/admin/users/${eve.user.id}?identity=1`);
  assert.deepEqual([bare.status, bare.data.error], [401, 'reauth_required'], 'a session opened a moment ago');
  assert.ok(workos.users.has('user_eve') && suite.accounts.byId(eve.user.id), 'nothing went');
  // Where the panel sends them: AuthKit asks again (max_age=0), and back at the panel. Here AuthKit
  // took the session it held: the last active sign-in is from before the question.
  const silent = await signIn('user_root', { authTime: seconds() - 3600 });
  assert.equal(silent.target.searchParams.get('max_age'), '0');
  assert.equal(silent.back, '/admin');
  const reused = await silent.call('DELETE', `/api/admin/users/${eve.user.id}?identity=1`);
  assert.deepEqual([reused.status, reused.data.error], [401, 'reauth_required']);
  assert.ok(workos.users.has('user_eve') && suite.accounts.byId(eve.user.id), 'nothing went');
  // Signed in again: it counts.
  const fresh = await signIn('user_root', { authTime: seconds() });
  assert.equal((await fresh.call('DELETE', `/api/admin/users/${eve.user.id}?identity=1`)).status, 200);
  assert.equal(workos.users.has('user_eve'), false);
  assert.equal(suite.accounts.byId(eve.user.id), null);
});

test('an install that does not own the identities cannot delete someone\'s login', async (t) => {
  const workos = await fakeWorkos(t);
  workos.add('user_root');
  workos.add('user_eve');
  const { suite, person } = await serve(t, workos, { adminIdentity: false });
  const admin = person('root', 'user_root', 'admin');
  const eve = person('eve', 'user_eve');
  const refused = await admin.call('DELETE', `/api/admin/users/${eve.user.id}?identity=1`);
  assert.equal(refused.status, 403);
  assert.equal(refused.data.error, 'identity_not_here');
  assert.ok(workos.users.has('user_eve') && suite.accounts.byId(eve.user.id), 'nothing went');
});

test('without sharedIdentity nothing of this: no notes at WorkOS, no question, no route', async (t) => {
  const workos = await fakeWorkos(t);
  workos.add('user_ana');
  const { suite, person } = await serve(t, workos, { sharedIdentity: false });
  const ana = person('ana', 'user_ana');
  assert.equal(suite.workos.markAll, undefined);
  assert.equal((await ana.call('GET', '/api/auth/config')).data.deletion_identity, undefined);
  assert.equal((await ana.call('GET', '/api/me/deletion')).status, 405, 'only the request itself');
  assert.deepEqual(workos.calls, []);
});

test('the deletion on its own: auto asks again when the account goes, and waits while the provider can’t say', async () => {
  const database = openDatabase({ path: ':memory:' });
  usersSchema(database);
  accountDeletionSchema(database);
  identitiesSchema(database);
  identityDeletionSchema(database);
  let now = Date.parse('2026-10-29T10:00:00Z');
  const accounts = createAccounts({ database, clock: () => now });
  const calls = [];
  const others = new Map();
  let down = false;
  const idp = {
    otherApps: async (id) => { if (down) throw new Error('WorkOS does not answer'); return others.get(id) || []; },
    deleteIdentity: async (id) => { calls.push(['delete', id]); },
    unmark: async (id) => { calls.push(['unmark', id]); },
  };
  const deletion = createAccountDeletion({ accounts, sign: (v) => v.length.toString(36), days: 30, shared: true, idp, clock: () => now, log: () => {} });
  assert.equal(deletion.choosing, true);
  await assert.rejects(deletion.request(accounts.create({ username: 'xan', displayName: 'Xan' }), { identity: 'maybe' }), /identity_invalid/);

  const fay = accounts.create({ username: 'fay', displayName: 'Fay' });
  const gus = accounts.create({ username: 'gus', displayName: 'Gus' });
  const hal = accounts.create({ username: 'hal', displayName: 'Hal' });
  await deletion.request(fay);
  await deletion.request(gus, { identity: 'all' });
  await deletion.request(hal, { identity: 'none' });
  // Taken back and asked again: the first choice is gone with the first request.
  await deletion.restore(deletion.ticketFor(gus.id));
  assert.equal(accounts.byId(gus.id).delete_identity, null);
  await deletion.request(gus, { identity: 'all' });

  // Fay started using another app in her days: her login stays. WorkOS down: everyone with a question waits.
  others.set(fay.id, ['Focus']);
  now += 31 * DAY;
  down = true;
  assert.equal(await deletion.sweep(), 2, 'Fay waits: whether another app is hers can’t be known');
  assert.ok(accounts.byId(fay.id));
  down = false;
  assert.equal(await deletion.sweep(), 1);
  assert.deepEqual(calls, [['delete', gus.id], ['unmark', hal.id], ['unmark', fay.id]]);

  // An install that always deletes at the providers never asks.
  const always = createAccountDeletion({ accounts, sign: (v) => v, atProviders: true, shared: true, idp, clock: () => now, log: () => {} });
  assert.equal(always.choosing, false);
  database.close();
});
