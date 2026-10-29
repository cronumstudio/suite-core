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

/** WorkOS's users: read, their metadata changed partially (null deletes a key), deleted. */
async function fakeWorkos(t) {
  const users = new Map();
  const calls = [];
  let down = false;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const id = decodeURIComponent(req.url.match(/^\/user_management\/users\/([^/?]+)$/)?.[1] || '');
      calls.push(`${req.method} ${id}`);
      const answer = (status, body = {}) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
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
  return { url: `http://127.0.0.1:${server.address().port}`, users, calls, add, setDown: (value) => { down = value; } };
}

async function serve(t, workos, { sharedIdentity = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-shared-identity-'));
  const suite = createSuite({
    config: { app: { id: 'demo', name: 'Démo', port: 3999, languages: ['en'] }, accounts: { minPasswordLength: 8, sharedIdentity } },
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
  /** Someone with an account here linked to a WorkOS user, and their browser. */
  const person = (username, workosId, role = 'user') => {
    const user = suite.accounts.create({ username, displayName: username, role, email: `${workosId}@example.com` });
    suite.accounts.linkIdentity(user.id, 'workos', workosId, { email: `${workosId}@example.com` });
    const cookie = `demo_sid=${suite.sessions.open(user.id)}`;
    const call = async (method, pathname, body) => {
      const res = await fetch(base + pathname, {
        method, redirect: 'manual',
        headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    return { user, call };
  };
  return { suite, person };
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
  const { suite, person } = await serve(t, workos);
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
  assert.equal((await admin.call('DELETE', `/api/admin/users/${eve.user.id}?identity=1`)).status, 200);
  assert.equal(workos.users.has('user_eve'), false);
  assert.equal(suite.accounts.byId(eve.user.id), null);
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
