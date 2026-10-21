/**
 * Actions from a phone's notification (Complete, Snooze), without opening the
 * app: POST /api/devices/actions with the device's token, handed to a host's
 * module (`createModule().deviceActions`) or to an app on its own
 * (`createApp({ deviceActions })`), over real HTTP.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSuite, createApp, SuiteConfigError } from '../app.js';
import { createHost } from '../host.js';
import { deviceActionOf, deviceActionsProblem } from '../devices.js';
import { notFound } from '../http.js';
import { randomToken, sha256 } from '../crypto.js';

const BACK = 'com.example.work:/auth';
const DEVICES = { modules: { devices: true }, devices: { prefix: 'workdev_', redirectUris: [BACK] } };
const ENV = (dir) => ({ DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1' });

/** A phone connected for `user`, as the app does it: → { token, device }. */
function phoneOf(suite, user, name = 'Phone') {
  const verifier = randomToken(32);
  const issued = suite.devices.issueCode(user, { codeChallenge: sha256(verifier), redirectUri: BACK, name });
  return suite.devices.exchange({ code: issued.code, verifier, redirectUri: BACK });
}

function client(base, cookieName) {
  let cookie = '';
  const call = async (method, pathname, body, headers = {}) => {
    const res = await fetch(base + pathname, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith(`${cookieName}=`));
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, headers: res.headers };
  };
  const web = (method, pathname, body, headers = {}) => call(method, pathname, body, { Cookie: cookie, ...headers });
  return { call, web };
}

const fixture = (name, q) => new URL(`./fixtures/host/${name}/module.js${q}`, import.meta.url);
let fresh = 0;

async function startHost(t, { product = DEVICES, acting = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-device-actions-'));
  fresh += 1;
  const entry = fixture('acting', `?case=${fresh}${acting}`);
  const lines = [];
  let host;
  try {
    host = await createHost({
      config: { app: { id: 'work', name: 'Work', languages: ['en'] }, ...product },
      modules: [{ mount: 'tasks', entry }, { mount: 'beta', entry: fixture('beta', `?actions=${fresh}`) }],
      env: ENV(dir), version: '9.9.9', handleSignals: false, exitOnError: false, log: (line) => lines.push(line),
    });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const server = await host.listen();
  t.after(async () => {
    await host.close();
    host.suite.database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { received } = await import(entry);
  return { host, suite: host.suite, received, lines, ...client(`http://127.0.0.1:${server.address().port}`, 'work_sid') };
}

/** A reminder of `user`'s in the module at /tasks/: its id. */
const reminder = (host, user, title = 'Call Ana') => {
  const tasks = host.modules.find((m) => m.mount === 'tasks').suite;
  return Number(tasks.database.run('INSERT INTO acting_reminders (user_id, title) VALUES (?, ?)', user.id, title).lastInsertRowid);
};
const rowOf = (host, id) => host.suite.database.get('SELECT * FROM acting_reminders WHERE id = ?', id);

/* ------------------------------ the declaration ------------------------------ */

test('deviceActions: an object of handlers or a function; anything else is said at the start', () => {
  const complete = () => ({ done: true });
  assert.equal(deviceActionOf({ complete }, 'complete'), complete);
  assert.equal(deviceActionOf({ complete }, 'snooze'), null);
  assert.equal(deviceActionOf((action) => (action === 'complete' ? complete : null), 'complete'), complete);
  assert.equal(deviceActionOf((action) => (action === 'complete' ? complete : null), 'snooze'), null);
  assert.equal(deviceActionOf(() => 'not a function', 'complete'), null);
  // Never what every object has.
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(deviceActionOf({ complete }, name), null, name);
  for (const name of ['', 'Complete', '1st', 'a b', 'x'.repeat(64)]) assert.equal(deviceActionOf({ [name]: complete }, name), null, name);
  assert.equal(deviceActionOf(null, 'complete'), null);

  assert.equal(deviceActionsProblem(undefined), null);
  assert.equal(deviceActionsProblem({ complete, 'tasks.snooze': complete }), null);
  assert.equal(deviceActionsProblem(() => complete), null);
  assert.match(deviceActionsProblem([]), /must be an object/);
  assert.match(deviceActionsProblem('complete'), /must be an object/);
  assert.match(deviceActionsProblem({ Complete: complete }), /^deviceActions\.Complete: an action's name/);
  assert.match(deviceActionsProblem({ complete: true }), /^deviceActions\.complete must be a function/);
});

/* --------------------------------- in a host --------------------------------- */

test('in a host: the module named acts as the device’s person, with its params, and says what it did', async (t) => {
  const { host, suite, received, call } = await startHost(t);
  const ana = suite.accounts.create({ username: 'ana', displayName: 'Ana', password: 'ana-password-123' });
  const { token, device } = phoneOf(suite, ana);
  const auth = { Authorization: `Bearer ${token}` };
  const id = reminder(host, ana);

  const done = await call('POST', '/api/devices/actions', { module: 'tasks', action: 'complete', id: String(id) }, auth);
  assert.equal(done.status, 200);
  assert.deepEqual(done.data, { id, done: true, ok: true });
  assert.equal(done.headers.get('cache-control'), 'no-store');
  assert.equal(rowOf(host, id).done, 1);
  const [first] = received;
  assert.deepEqual([first.user.id, first.user.device_id, first.id, first.params, first.action], [ana.id, device.id, String(id), {}, 'complete']);
  assert.equal(first.suite, host.modules.find((m) => m.mount === 'tasks').suite, 'the module’s own suite: its live channel, its plans');

  // Params are the rest of the body; a number id arrives as text.
  const later = reminder(host, ana, 'Water the plants');
  const snoozed = await call('POST', '/api/devices/actions', { module: 'tasks', action: 'snooze', id: later, minutes: 60 }, auth);
  assert.deepEqual(snoozed.data, { id: later, snoozed_until: '2026-10-21T09:00:00.000Z', ok: true });
  // What isn't an object answers { ok: true } alone.
  assert.deepEqual((await call('POST', '/api/devices/actions', { module: 'tasks', action: 'ping' }, auth)).data, { ok: true });

  // The audit log says what was done and to what, never with which words.
  const logged = suite.audit.list({ action: 'device.action' }).reverse();
  assert.deepEqual(logged.map((e) => [e.actor_user_id, e.target_type, e.target_id, e.meta]), [
    [ana.id, 'device', String(device.id), { module: 'tasks', action: 'complete', id: String(id) }],
    [ana.id, 'device', String(device.id), { module: 'tasks', action: 'snooze', id: String(later) }],
    [ana.id, 'device', String(device.id), { module: 'tasks', action: 'ping', id: null }],
  ]);
});

test('in a host: what nobody declared is a 404, and the module’s own errors pass as they are', async (t) => {
  const { host, suite, call } = await startHost(t);
  const ana = suite.accounts.create({ username: 'ana', displayName: 'Ana', password: 'ana-password-123' });
  const bea = suite.accounts.create({ username: 'bea', displayName: 'Bea', password: 'bea-password-123' });
  const auth = { Authorization: `Bearer ${phoneOf(suite, ana).token}` };
  const act = (body) => call('POST', '/api/devices/actions', body, auth);
  const hers = reminder(host, bea, 'Bea’s');

  for (const body of [
    { module: 'nowhere', action: 'complete', id: '1' },        // no such module
    { module: 'tasks', action: 'archive', id: '1' },           // no such action
    { module: 'beta', action: 'complete', id: '1' },           // a module that declares none
    { action: 'complete', id: '1' },                           // in a host the module is named
    { module: 'tasks', action: 'constructor', id: '1' },       // never what every object has
    { module: 'tasks', action: 'Complete', id: '1' },
  ]) {
    const answer = await act(body);
    assert.deepEqual([answer.status, answer.data], [404, { error: 'action_not_found' }], JSON.stringify(body));
  }
  // Someone else's reminder doesn't exist for this person, as on the web; nothing changed.
  assert.deepEqual((await act({ module: 'tasks', action: 'complete', id: String(hers) })).data, { error: 'not_found' });
  assert.equal(rowOf(host, hers).done, 0);
  const wrong = await act({ module: 'tasks', action: 'snooze', id: String(reminder(host, ana)), minutes: 'soon' });
  assert.deepEqual([wrong.status, wrong.data], [400, { error: 'field_invalid', field: 'minutes' }]);
  const broke = await act({ module: 'tasks', action: 'explode' });
  assert.deepEqual([broke.status, broke.data], [500, { error: 'internal' }]);
  // The body: an action named, an id as text or a number.
  assert.deepEqual((await act({ module: 'tasks' })).data, { error: 'field_required', field: 'action' });
  assert.deepEqual((await act({ module: 'tasks', action: 'complete', id: { x: 1 } })).data, { error: 'field_invalid', field: 'id' });
  assert.deepEqual((await act({ module: 7, action: 'complete' })).data, { error: 'field_invalid', field: 'module' });
  assert.equal((await act([])).data.error, 'invalid_json');
  // Only what was done is in the log.
  assert.equal(suite.audit.list({ action: 'device.action' }).length, 0);
});

test('in a host: only a device’s token that still works, never a session', async (t) => {
  const { host, suite, call, web } = await startHost(t);
  const ana = suite.accounts.create({ username: 'ana', displayName: 'Ana', password: 'ana-password-123' });
  const id = reminder(host, ana);
  const body = { module: 'tasks', action: 'complete', id: String(id) };
  const act = (token) => call('POST', '/api/devices/actions', body, token ? { Authorization: `Bearer ${token}` } : {});

  assert.equal((await act(null)).status, 401, 'no token');
  assert.equal((await act('workdev_nope')).status, 401, 'not a device’s');
  // Signed in on the web: the cookie is not a device.
  assert.equal((await call('POST', '/api/auth/login', { username: 'ana', password: 'ana-password-123' })).status, 200);
  assert.equal((await web('POST', '/api/devices/actions', body)).status, 401);
  // Nor an API token of the person's.
  assert.equal((await act(suite.tokens.create(ana.id, { name: 'Script' }).token)).status, 401);

  const revoked = phoneOf(suite, ana);
  suite.devices.revoke(ana.id, revoked.device.id);
  assert.equal((await act(revoked.token)).status, 401, 'revoked');
  const disabled = phoneOf(suite, ana);
  suite.database.run('UPDATE users SET disabled_at = ? WHERE id = ?', new Date().toISOString(), ana.id);
  assert.equal((await act(disabled.token)).status, 401, 'a disabled account');
  assert.equal(rowOf(host, id).done, 0, 'nothing was done');
});

test('in a host: failures count against the address in the devices’ bucket, and past the limit it waits', async (t) => {
  const { host, suite, call } = await startHost(t, { product: { ...DEVICES, rateLimits: { devices: 3 } } });
  const ana = suite.accounts.create({ username: 'ana', displayName: 'Ana' });
  const { token } = phoneOf(suite, ana);
  const body = { module: 'tasks', action: 'complete', id: String(reminder(host, ana)) };
  // A module's refusal is no failure of the token's.
  for (let i = 0; i < 4; i++) {
    assert.equal((await call('POST', '/api/devices/actions', { ...body, action: 'archive' }, { Authorization: `Bearer ${token}` })).status, 404);
  }
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/devices/actions', body, { Authorization: 'Bearer workdev_nope' })).status, 401);
  const stopped = await call('POST', '/api/devices/actions', body, { Authorization: `Bearer ${token}` });
  assert.deepEqual([stopped.status, stopped.data.error], [429, 'too_many_attempts']);
  assert.ok(stopped.data.retry_after > 0);
});

test('in a host: with an Idempotency-Key a retried action runs once, keyed by the device’s account', async (t) => {
  const { host, suite, received, call, web } = await startHost(t);
  const admin = suite.accounts.byUsername('admin');
  const auth = { Authorization: `Bearer ${phoneOf(suite, admin).token}` };
  const body = { module: 'tasks', action: 'complete', id: String(reminder(host, admin)) };
  const first = await call('POST', '/api/devices/actions', body, { ...auth, 'Idempotency-Key': 'remind-42-complete' });
  const again = await call('POST', '/api/devices/actions', body, { ...auth, 'Idempotency-Key': 'remind-42-complete' });
  assert.equal(received.length, 1, 'run once');
  assert.deepEqual(again.data, first.data);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(suite.database.all('SELECT user_id, path FROM idempotency_keys').map((r) => [r.user_id, r.path]),
    [[admin.id, '/api/devices/actions']]);
  // With the person's session cookie beside the token (a WebView's request), keyed once all the same.
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  const both = await web('POST', '/api/devices/actions', body, { ...auth, 'Idempotency-Key': 'remind-42-again' });
  assert.equal(both.status, 200);
  assert.equal(received.length, 2);
  // A failure is not kept: the phone may try again.
  const other = { ...body, action: 'snooze', minutes: 0 };
  assert.equal((await call('POST', '/api/devices/actions', other, { ...auth, 'Idempotency-Key': 'snooze-1' })).status, 400);
  assert.equal(suite.database.get("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = 'snooze-1'").n, 0);
});

test('a host without modules.devices has no such route; a module that declares them wrong stops the start', async (t) => {
  const { call } = await startHost(t, { product: {} });
  const answer = await call('POST', '/api/devices/actions', { module: 'tasks', action: 'complete', id: '1' }, { Authorization: 'Bearer workdev_x' });
  assert.deepEqual([answer.status, answer.data], [404, { error: 'not_found' }]);

  for (const [bad, said] of [
    ['array', /^tasks: deviceActions must be an object/],
    ['name', /^tasks: deviceActions\.Complete!: an action's name/],
    ['handler', /^tasks: deviceActions\.complete must be a function/],
  ]) {
    await assert.rejects(startHost(t, { acting: `&bad=${bad}` }), (err) => err instanceof SuiteConfigError && said.test(err.errors[0]), bad);
  }
});

/* ------------------------------- an app on its own ------------------------------- */

async function startApp(t, { product = DEVICES, deviceActions } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-device-actions-app-'));
  const lines = [];
  const suite = createSuite({
    config: { app: { id: 'tracker', name: 'Tracker', languages: ['en'] }, ...product },
    env: ENV(dir), log: (line) => lines.push(line), exitOnError: false,
  });
  const app = createApp({ suite, version: '1.0.0', handleSignals: false, log: (line) => lines.push(line), deviceActions });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { suite, lines, ...client(`http://127.0.0.1:${server.address().port}`, 'tracker_sid') };
}

test('an app on its own offers them through createApp({ deviceActions }): the module, if named, is the app', async (t) => {
  const seen = [];
  // The function form: the app builds its handlers itself.
  const deviceActions = (action) => (action === 'arrive'
    ? ({ user, id, params, suite }) => {
      seen.push([user.username, id, params, Boolean(suite.devices)]);
      if (id === 'missing') throw notFound('route_not_found');
      return { arrived: id };
    } : null);
  const { suite, call } = await startApp(t, { deviceActions });
  const admin = suite.accounts.byUsername('admin');
  const auth = { Authorization: `Bearer ${phoneOf(suite, admin).token}` };
  const act = (body) => call('POST', '/api/devices/actions', body, auth);

  assert.deepEqual((await act({ action: 'arrive', id: 'stop-3', at: 'gate' })).data, { arrived: 'stop-3', ok: true });
  assert.deepEqual((await act({ module: 'tracker', action: 'arrive', id: 'stop-4' })).data, { arrived: 'stop-4', ok: true });
  assert.deepEqual(seen, [['admin', 'stop-3', { at: 'gate' }, true], ['admin', 'stop-4', {}, true]]);
  assert.deepEqual((await act({ module: 'tasks', action: 'arrive' })).data, { error: 'action_not_found' }, 'another module is not this app');
  assert.deepEqual((await act({ action: 'leave' })).data, { error: 'action_not_found' });
  assert.deepEqual((await act({ action: 'arrive', id: 'missing' })).data, { error: 'route_not_found' });
  assert.deepEqual(suite.audit.list({ action: 'device.action' }).map((e) => e.meta).reverse(), [
    { module: 'tracker', action: 'arrive', id: 'stop-3' }, { module: 'tracker', action: 'arrive', id: 'stop-4' },
  ]);
});

test('an app with devices and no deviceActions answers 404; without the module, no route (an app spreads its module’s parts)', async (t) => {
  const plain = await startApp(t);
  const auth = { Authorization: `Bearer ${phoneOf(plain.suite, plain.suite.accounts.byUsername('admin')).token}` };
  assert.deepEqual((await plain.call('POST', '/api/devices/actions', { action: 'arrive' }, auth)).data, { error: 'action_not_found' });

  const off = await startApp(t, { product: {}, deviceActions: { arrive: () => null } });
  assert.equal((await off.call('POST', '/api/devices/actions', { action: 'arrive' }, { Authorization: 'Bearer trackerdev_x' })).status, 404);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-device-actions-app-'));
  const suite = createSuite({ config: { app: { id: 'tracker', name: 'Tracker' }, ...DEVICES }, env: ENV(dir), log: () => {}, exitOnError: false });
  t.after(() => { suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => createApp({ suite, handleSignals: false, log: () => {}, deviceActions: { arrive: 'yes' } }),
    /createApp: deviceActions\.arrive must be a function/);
});
