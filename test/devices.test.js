/**
 * Device tokens: a phone connected through the system browser with PKCE, its
 * token, what refuses it, and the routes, over real HTTP.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { createAccounts } from '../accounts.js';
import { createAudit } from '../audit.js';
import { createTokens } from '../tokens.js';
import { createDevices, redirectUriProblem } from '../devices.js';
import { resolveConfig } from '../config.js';
import { OAUTH_PREFIXES } from '../oauth.js';
import { createSuite, createApp } from '../app.js';
import { randomToken, sha256 } from '../crypto.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const BACK = 'com.example.tracker:/auth';

/** A PKCE pair, as the app makes it: a random verifier and its SHA-256. */
const pkce = () => {
  const verifier = randomToken(32);
  return { verifier, challenge: sha256(verifier) };
};
const code = (fn) => { try { fn(); } catch (err) { return `${err.status} ${err.code}`; } return 'ok'; };

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-devices-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const now = { ms: Date.parse('2026-10-11T08:00:00.000Z') };
  const clock = () => now.ms;
  const accounts = createAccounts({ database, clock });
  const audit = createAudit({ database, clock });
  const devices = createDevices({
    database, prefix: 'trackerdev_', redirectUris: [BACK], idleDays: 90, audit, clock, ...options,
  });
  const ana = accounts.create({ username: 'ana', displayName: 'Ana' });
  const bea = accounts.create({ username: 'bea', displayName: 'Bea' });
  /** The whole connection: a code for the signed-in person, exchanged by the app. */
  const connect = (user = ana, { name = 'Ana’s phone', platform = 'ios', appVersion = '0.2.0' } = {}) => {
    const pair = pkce();
    const issued = devices.issueCode(user, { codeChallenge: pair.challenge, redirectUri: BACK, name, platform });
    return devices.exchange({ code: issued.code, verifier: pair.verifier, redirectUri: BACK, appVersion });
  };
  return { database, accounts, audit, devices, ana, bea, now, connect, tokens: createTokens({ database, prefix: 'tracker_', clock }) };
}

const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });

test('the configuration: off by default, and with the module on, its own prefix and return addresses', () => {
  const app = { id: 'tracker', name: 'Tracker' };
  const off = resolveConfig({ app }, {});
  assert.deepEqual(off.errors, []);
  assert.equal(off.modules.devices, false);
  assert.equal(off.rateLimits.devices, 30);

  const on = resolveConfig({
    app, modules: { devices: true }, tokens: { prefix: 'tracker_' },
    devices: { prefix: 'trackerdev_', redirectUris: ['com.cronumstudio.tracker:/auth', 'com.cronumstudio.tracker:/auth'] },
  }, {});
  assert.deepEqual(on.errors, []);
  assert.deepEqual(on.devices, { prefix: 'trackerdev_', redirectUris: ['com.cronumstudio.tracker:/auth'], idleDays: 90 });

  assert.deepEqual(resolveConfig({ app, modules: { devices: true } }, {}).errors, [
    'modules.devices needs devices.prefix: how the app’s device tokens start ("appdev_")',
    'modules.devices needs devices.redirectUris: where the system browser hands the code back to the app (com.example.app:/auth)',
  ], 'nothing guessed: both become part of the installed apps');
  assert.deepEqual(resolveConfig({ app, modules: { devices: true }, devices: { prefix: 'mcp_', redirectUris: [BACK] } }, {}).errors,
    ['devices.prefix must differ from tokens.prefix ("mcp_"): a device token is not an API token']);
  // Nor the built-in OAuth's: the MCP refuses whatever starts with devices.prefix, so its tokens would stop working.
  assert.deepEqual(Object.values(OAUTH_PREFIXES), ['mcpat_', 'mcprt_', 'oc_', 'ocs_']);
  for (const taken of Object.values(OAUTH_PREFIXES)) {
    assert.deepEqual(resolveConfig({
      app, modules: { devices: true }, tokens: { prefix: 'tracker_' }, devices: { prefix: taken, redirectUris: [BACK] },
    }, {}).errors, [`devices.prefix can't be "${taken}": the built-in OAuth's values start with "${taken}", and the MCP would refuse them`]);
  }
  const wrong = resolveConfig({
    app, devices: { prefix: 'Dev-', redirectUris: ['javascript:alert(1)', 'http://phone.example/auth', 'https://a.example/#x', 'myapp:/auth'], idleDays: 0, maxDays: 3 },
  }, {});
  assert.deepEqual(wrong.errors, [
    'devices.maxDays is not a setting (a typo?)',
    'devices.prefix: a few lowercase letters and _ ("appdev_")',
    'devices.redirectUris: "javascript:alert(1)" is not valid: a reverse-domain scheme such as com.example.app:/auth, https, or http on loopback',
    'devices.redirectUris: "http://phone.example/auth" is not valid: http only on loopback',
    'devices.redirectUris: "https://a.example/#x" is not valid: no #fragment',
    'devices.redirectUris: "myapp:/auth" is not valid: a reverse-domain scheme such as com.example.app:/auth, https, or http on loopback',
    'devices.idleDays: a whole number of days from 1 to 3650',
  ]);
  assert.equal(redirectUriProblem('http://127.0.0.1:8123/auth'), null, 'a desktop app on loopback');
  assert.equal(redirectUriProblem('https://tracker.example.com/app/auth'), null);
  assert.deepEqual(resolveConfig({ app, rateLimits: { devices: 5 } }, {}).rateLimits.devices, 5);
});

test('the tables: migration 22, beside a table of an app’s own called devices (Focus’s)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-devices-'));
  const database = openDatabase({ dataDir: dir, name: 'focus' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  database.exec("CREATE TABLE devices (id INTEGER PRIMARY KEY, household_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('kiosk')))");
  assert.ok(migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} }).includes(22));
  assert.equal(SUITE_MIGRATIONS[21].name, 'device-tokens');
  assert.ok(database.columnsOf('device_tokens').includes('token_hash'));
  assert.ok(database.columnsOf('device_codes').includes('code_challenge'));
  assert.deepEqual(database.columnsOf('devices'), ['id', 'household_id', 'kind'], 'the app’s own table is left alone');
  assert.deepEqual(migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} }), [], 'a second run changes nothing');
});

test('a code with the right verifier becomes a token: shown once, kept as a hash, of its own kind', (t) => {
  const { database, devices, ana, connect, tokens } = setup(t);
  const { token, device, user } = connect();
  assert.match(token, /^trackerdev_[A-Za-z0-9_-]{43}$/);
  assert.equal(user.id, ana.id);
  assert.deepEqual(Object.keys(device), ['id', 'name', 'platform', 'app_version', 'created_at', 'last_used_at', 'expires_at']);
  assert.equal(device.platform, 'ios');
  assert.equal(device.app_version, '0.2.0');
  assert.equal(device.expires_at, new Date(Date.parse(device.created_at) + 90 * DAY).toISOString());
  const row = database.get('SELECT * FROM device_tokens WHERE id = ?', device.id);
  assert.equal(row.token_hash, sha256(token));
  assert.equal(row.prefix, 'trackerdev_');
  assert.ok(!JSON.stringify(database.all('SELECT * FROM device_tokens')).includes(token), 'only the hash is kept');

  const who = devices.authenticate(bearer(token));
  assert.equal(who.username, 'ana');
  assert.equal(who.device_id, device.id);
  assert.equal(devices.authenticate(token)?.device_id, device.id, 'the token itself works too');
  assert.equal(devices.isActive(device.id), true);
  assert.deepEqual(devices.list(ana.id).map((d) => d.name), ['Ana’s phone']);

  // The prefix decides which kind of token it is: neither opens the other's door.
  assert.equal(tokens.authenticate(token, { scope: 'mcp' }), null, 'a device token is not an API token');
  const api = tokens.create(ana.id, { name: 'Claude' }).token;
  assert.equal(devices.authenticate(bearer(api)), null, 'nor an API token a device’s');
  assert.equal(devices.authenticate(bearer(token.replace('trackerdev_', 'otherdev_'))), null);
  assert.equal(devices.authenticate(bearer(`trackerdev_${randomToken(32)}`)), null, 'made up');
  assert.equal(devices.authenticate({ headers: { authorization: `Basic ${token}` } }), null);
  assert.equal(devices.authenticate({ headers: {} }), null);
});

test('a code: the wrong verifier, used again, expired, or for another address gives nothing', (t) => {
  const { database, devices, ana, now, audit } = setup(t);
  const issue = (pair, extra = {}) => devices.issueCode(ana, { codeChallenge: pair.challenge, redirectUri: BACK, name: 'Phone', ...extra });

  // The wrong verifier, and the code is spent: the right one after it gets nothing either.
  const first = pkce();
  const one = issue(first);
  assert.equal(code(() => devices.exchange({ code: one.code, verifier: pkce().verifier, redirectUri: BACK })), '400 device_code_invalid');
  assert.equal(code(() => devices.exchange({ code: one.code, verifier: first.verifier, redirectUri: BACK })), '400 device_code_invalid');
  assert.equal(code(() => devices.exchange({ code: one.code, verifier: 'short', redirectUri: BACK })), '400 device_code_invalid');

  // Used again with only the code, which travels through the browser and can be seen there:
  // refused, and the phone that connected with it keeps working.
  const second = pkce();
  const two = issue(second);
  const { token, device } = devices.exchange({ code: two.code, verifier: second.verifier, redirectUri: BACK });
  assert.ok(devices.authenticate(token));
  assert.equal(code(() => devices.exchange({ code: two.code, verifier: pkce().verifier, redirectUri: BACK })), '400 device_code_invalid');
  assert.equal(code(() => devices.exchange({ code: two.code, verifier: 'x', redirectUri: 'com.evil.app:/x' })), '400 device_code_invalid');
  assert.equal(code(() => devices.exchange({ code: two.code, verifier: second.verifier, redirectUri: 'com.evil.app:/x' })), '400 device_code_invalid');
  assert.ok(devices.authenticate(token), 'a spent code without its verifier and address disconnects nobody');
  const unproven = audit.list({ action: 'device.' }).map((e) => [e.action, e.meta.reason ?? e.meta.by ?? null, e.meta.revoked ?? null]);
  assert.deepEqual(unproven.slice(0, 3), [['device.token_failed', 'reused', null], ['device.token_failed', 'reused', null], ['device.token_failed', 'reused', null]]);

  // Used again with its verifier and its address: the verifier got out too (or the app retries an
  // answer it lost), and the device it gave goes (OAuth 2.1 §4.1.3).
  assert.equal(code(() => devices.exchange({ code: two.code, verifier: second.verifier, redirectUri: BACK })), '400 device_code_invalid');
  assert.equal(devices.authenticate(token), null, 'the device of a code used twice is revoked');
  assert.equal(devices.isActive(device.id), false);
  const said = audit.list({ action: 'device.' }).map((e) => [e.action, e.meta.reason ?? e.meta.by ?? null, e.meta.revoked ?? null]);
  assert.deepEqual(said.slice(0, 2), [['device.revoke', 'code_reused', null], ['device.token_failed', 'reused', device.id]]);

  // Expired: five minutes.
  const third = pkce();
  const three = issue(third);
  now.ms += 5 * MINUTE;
  assert.equal(code(() => devices.exchange({ code: three.code, verifier: third.verifier, redirectUri: BACK })), '400 device_code_invalid');

  // Another return address: never issued for one outside the allowlist, never exchanged for another.
  assert.equal(code(() => issue(pkce(), { redirectUri: 'com.evil.app:/auth' })), '400 redirect_uri_not_allowed');
  assert.equal(code(() => issue(pkce(), { redirectUri: `${BACK}/more` })), '400 redirect_uri_not_allowed', 'exactly');
  const fourth = pkce();
  const four = issue(fourth);
  assert.equal(code(() => devices.exchange({ code: four.code, verifier: fourth.verifier, redirectUri: 'com.evil.app:/auth' })), '400 device_code_invalid');
  assert.equal(code(() => devices.exchange({ code: four.code, verifier: fourth.verifier, redirectUri: BACK })), '400 device_code_invalid', 'spent');

  // Unknown, and what the request must say.
  assert.equal(code(() => devices.exchange({ code: randomToken(32), verifier: fourth.verifier, redirectUri: BACK })), '400 device_code_invalid');
  assert.equal(code(() => devices.exchange({ verifier: fourth.verifier, redirectUri: BACK })), '400 field_required');
  assert.equal(code(() => devices.exchange({ code: four.code, verifier: fourth.verifier })), '400 field_required');
  assert.equal(code(() => issue({ challenge: 'plain-text' })), '400 field_invalid');
  assert.equal(code(() => issue(pkce(), { codeChallengeMethod: 'plain' })), '400 field_invalid');
  assert.equal(code(() => issue(pkce(), { name: ' ' })), '400 field_required');
  assert.equal(code(() => issue(pkce(), { platform: 'i os' })), '400 field_invalid');
  assert.equal(database.get('SELECT COUNT(*) AS n FROM device_tokens').n, 1, 'only the one exchanged right');
});

test('the code comes back to the app with the state, and an account has a few codes open at most', (t) => {
  const { devices, ana } = setup(t);
  const issued = devices.issueCode(ana, { codeChallenge: pkce().challenge, redirectUri: BACK, name: 'Phone', state: 'xyz 1' });
  const back = new URL(issued.redirect_to);
  assert.equal(`${back.protocol}${back.pathname}`, BACK);
  assert.equal(back.searchParams.get('code'), issued.code);
  assert.equal(back.searchParams.get('state'), 'xyz 1');
  for (let i = 1; i < 10; i++) devices.issueCode(ana, { codeChallenge: pkce().challenge, redirectUri: BACK, name: 'Phone' });
  assert.equal(code(() => devices.issueCode(ana, { codeChallenge: pkce().challenge, redirectUri: BACK, name: 'Phone' })), '429 too_many_attempts');
});

test('revoked, unused for too long, of a disabled account, or past the limit: refused', (t) => {
  const { database, devices, accounts, ana, bea, now, connect } = setup(t, { maxPerUser: 3 });
  const phone = connect();
  const tablet = connect(ana, { name: 'Tablet', platform: 'android' });

  // Revoked by its owner, and only by them.
  assert.equal(devices.revoke(bea.id, phone.device.id), false, 'not Bea’s');
  assert.ok(devices.authenticate(phone.token));
  assert.equal(devices.revoke(ana.id, phone.device.id), true);
  assert.equal(devices.revoke(ana.id, phone.device.id), false, 'once');
  assert.equal(devices.authenticate(phone.token), null);
  assert.equal(devices.isActive(phone.device.id), false);
  assert.deepEqual(devices.list(ana.id).map((d) => d.name), ['Tablet']);

  // Its last use, at most once a minute; idle for idleDays, it ends.
  const usedAt = () => database.get('SELECT last_used_at FROM device_tokens WHERE id = ?', tablet.device.id).last_used_at;
  devices.authenticate(tablet.token);
  const first = usedAt();
  now.ms += 30 * 1000;
  devices.authenticate(tablet.token);
  assert.equal(usedAt(), first, 'not again within the minute');
  now.ms += 89 * DAY;
  assert.ok(devices.authenticate(tablet.token), 'used within 90 days');
  assert.notEqual(usedAt(), first);
  now.ms += 90 * DAY;
  assert.equal(devices.authenticate(tablet.token), null, 'idle for 90 days');
  assert.equal(devices.isActive(tablet.device.id), false);
  assert.deepEqual(devices.list(ana.id), []);

  // A disabled account's devices are refused, and work again when it comes back, like its API tokens.
  const watch = connect(bea, { name: 'Watch' });
  accounts.update(bea.id, { disabled: true });
  assert.equal(devices.authenticate(watch.token), null);
  assert.equal(devices.isActive(watch.device.id), false);
  assert.equal(code(() => devices.issueCode(accounts.byId(bea.id), { codeChallenge: pkce().challenge, redirectUri: BACK, name: 'x' })), '401 unauthorized');
  accounts.update(bea.id, { disabled: false });
  assert.ok(devices.authenticate(watch.token));

  // Past the limit of devices at once (the idle and the revoked don't count).
  connect(ana);
  connect(ana);
  connect(ana);
  assert.equal(code(() => connect(ana)), '400 too_many_devices');
});

test('the app can refuse people: when they connect and on every use', (t) => {
  const { devices, ana, bea, connect, audit } = setup(t);
  const phone = connect(bea);
  devices.setCanConnect((user) => user.username === 'ana');
  assert.equal(code(() => connect(bea)), '403 device_not_allowed');
  assert.equal(devices.authenticate(phone.token), null, 'no longer let in');
  assert.equal(devices.isActive(phone.device.id), false);
  assert.ok(connect(ana).token);

  // Let in when the code was issued, refused by the time it is exchanged.
  const pair = pkce();
  const issued = devices.issueCode(ana, { codeChallenge: pair.challenge, redirectUri: BACK, name: 'Phone' });
  devices.setCanConnect(() => false);
  assert.equal(code(() => devices.exchange({ code: issued.code, verifier: pair.verifier, redirectUri: BACK })), '403 device_not_allowed');
  assert.equal(audit.list({ action: 'device.token_failed' })[0].meta.reason, 'not_allowed');

  // An answer that comes later would always be "yes": refused loudly.
  devices.setCanConnect(async () => false);
  assert.throws(() => devices.authenticate(phone.token), /at once, not a promise/);
  assert.throws(() => devices.setCanConnect('ana'), /must be a function/);
});

test('an account removed takes its devices and codes with it', (t) => {
  const { database, devices, accounts, ana, bea, connect } = setup(t);
  connect(ana);
  connect(bea);
  devices.issueCode(ana, { codeChallenge: pkce().challenge, redirectUri: BACK, name: 'Phone' });
  accounts.remove(ana.id);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM device_tokens WHERE user_id = ?', ana.id).n, 0);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM device_codes WHERE user_id = ?', ana.id).n, 0);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM device_tokens').n, 1, 'Bea’s stays');
});

test('the clean-up forgets old codes and devices gone a month ago', (t) => {
  const { database, devices, ana, now, connect } = setup(t);
  const kept = connect();
  const revoked = connect();
  devices.revoke(ana.id, revoked.device.id);
  devices.issueCode(ana, { codeChallenge: pkce().challenge, redirectUri: BACK, name: 'Phone' });
  now.ms += 2 * DAY;
  devices.authenticate(kept.token);
  assert.equal(devices.purge(), 3, 'the three codes, used or not');
  now.ms += 30 * DAY;
  assert.equal(devices.purge(), 1, 'the revoked device');
  assert.deepEqual(database.all('SELECT id FROM device_tokens').map((r) => r.id), [kept.device.id]);
});

/* ------------------------------- over HTTP ------------------------------- */

async function startApp(t, { product = {}, appOptions = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-devices-app-'));
  const lines = [];
  const suite = createSuite({
    config: {
      app: { id: 'tracker', name: 'Tracker', languages: ['en'] }, tokens: { prefix: 'tracker_' }, ...product,
    },
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1' },
    log: (line) => lines.push(line), exitOnError: false,
  });
  const app = createApp({
    suite, version: '1.0.0', handleSignals: false, log: (line) => lines.push(line),
    mcp: { instructions: 'Track.', tools: [] }, ...appOptions,
  });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, pathname, body, headers = {}) => {
    const res = await fetch(base + pathname, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('tracker_sid='));
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, headers: res.headers };
  };
  const web = (method, pathname, body, headers = {}) => call(method, pathname, body, { Cookie: cookie, ...headers });
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  return { suite, call, web, lines };
}

const DEVICES_ON = {
  modules: { devices: true },
  devices: { prefix: 'trackerdev_', redirectUris: [BACK] },
  rateLimits: { devices: 3 },
};

test('module off: no routes, and nothing of it in the suite', async (t) => {
  const { suite, call, web } = await startApp(t);
  assert.equal(suite.devices, null);
  assert.equal((await web('POST', '/api/devices/codes', { code_challenge: pkce().challenge, redirect_uri: BACK, name: 'x' })).status, 404);
  assert.equal((await call('POST', '/api/devices/token', { code: 'x', code_verifier: 'y', redirect_uri: BACK })).status, 404);
  assert.equal((await web('GET', '/api/me/devices')).status, 404);
  assert.equal((await call('DELETE', '/api/devices/current', undefined, { Authorization: 'Bearer trackerdev_x' })).status, 404);
});

test('a phone connects over HTTP: code from the session, token from the code, signed out with its own token', async (t) => {
  const { suite, call, web } = await startApp(t, { product: DEVICES_ON });
  const pair = pkce();
  const ask = { code_challenge: pair.challenge, code_challenge_method: 'S256', redirect_uri: BACK, name: 'Bus 3', platform: 'android', state: 's1' };

  // The code: for the person signed in on the web, from the app's own pages.
  assert.equal((await call('POST', '/api/devices/codes', ask)).status, 401, 'no session, no code');
  assert.equal((await web('POST', '/api/devices/codes', ask, { Origin: 'https://evil.example' })).data.error, 'cross_site_request');
  assert.equal((await web('POST', '/api/devices/codes', { ...ask, redirect_uri: 'com.evil.app:/auth' })).data.error, 'redirect_uri_not_allowed');
  const issued = await web('POST', '/api/devices/codes', ask);
  assert.equal(issued.status, 201);
  assert.equal(issued.headers.get('cache-control'), 'no-store');
  assert.equal(new URL(issued.data.redirect_to).searchParams.get('state'), 's1');

  // The token: the code and the verifier, with no cookie.
  const exchanged = await call('POST', '/api/devices/token', { code: issued.data.code, code_verifier: pair.verifier, redirect_uri: BACK, app_version: '0.2.0' });
  assert.equal(exchanged.status, 200);
  assert.equal(exchanged.headers.get('cache-control'), 'no-store');
  assert.equal(exchanged.data.token_type, 'Bearer');
  assert.equal(exchanged.data.device.name, 'Bus 3');
  const auth = { Authorization: `Bearer ${exchanged.data.token}` };

  // No route of the suite takes it: only the ones the app chooses, through authenticate().
  assert.equal((await call('GET', '/api/auth/me', undefined, auth)).data.user, null);
  assert.equal((await call('GET', '/api/me/devices', undefined, auth)).status, 401);
  assert.equal((await call('GET', '/api/me/tokens', undefined, auth)).status, 401);
  assert.equal((await call('DELETE', `/api/me/devices/${exchanged.data.device.id}`, undefined, auth)).status, 401);
  const mcp = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, auth);
  assert.equal(mcp.status, 401, 'never the MCP');
  assert.equal(suite.devices.authenticate({ headers: { authorization: auth.Authorization } }).username, 'admin');

  // Settings lists it; the device signs itself out with its token, never with a session.
  assert.deepEqual((await web('GET', '/api/me/devices')).data.map((d) => [d.name, d.platform, d.app_version]), [['Bus 3', 'android', '0.2.0']]);
  assert.equal((await web('DELETE', '/api/devices/current')).status, 401, 'a session is not a device');
  assert.equal((await call('DELETE', '/api/devices/current', undefined, auth)).status, 200);
  assert.equal((await call('DELETE', '/api/devices/current', undefined, auth)).status, 401, 'once');
  assert.deepEqual((await web('GET', '/api/me/devices')).data, []);

  // Revoked from Settings.
  const again = pkce();
  const code2 = (await web('POST', '/api/devices/codes', { ...ask, code_challenge: again.challenge })).data.code;
  const second = (await call('POST', '/api/devices/token', { code: code2, code_verifier: again.verifier, redirect_uri: BACK })).data;
  assert.equal((await web('DELETE', '/api/me/devices/999')).data.error, 'device_not_found');
  assert.equal((await web('DELETE', '/api/me/devices/abc')).data.error, 'device_not_found');
  assert.equal((await web('DELETE', `/api/me/devices/${second.device.id}`)).status, 200);
  assert.equal(suite.devices.authenticate(second.token), null);

  const actions = suite.audit.list({ action: 'device.' }).map((e) => `${e.action} ${e.meta.by ?? e.meta.platform ?? ''}`.trim()).reverse();
  assert.deepEqual(actions, ['device.create android', 'device.revoke device', 'device.create android', 'device.revoke owner']);
});

test('exchanging codes: only failures count against the address, and past the limit it waits', async (t) => {
  const { call, web } = await startApp(t, { product: DEVICES_ON });
  const connect = async () => {
    const pair = pkce();
    const issued = (await web('POST', '/api/devices/codes', { code_challenge: pair.challenge, redirect_uri: BACK, name: 'Bus' })).data;
    return { ...pair, code: issued.code };
  };
  for (let i = 0; i < 4; i++) {
    const ok = await connect();
    assert.equal((await call('POST', '/api/devices/token', { code: ok.code, code_verifier: ok.verifier, redirect_uri: BACK })).status, 200, 'a fleet connects');
  }
  for (let i = 0; i < 3; i++) {
    const bad = await call('POST', '/api/devices/token', { code: randomToken(32), code_verifier: randomToken(32), redirect_uri: BACK });
    assert.equal(bad.data.error, 'device_code_invalid');
  }
  const good = await connect();
  const stopped = await call('POST', '/api/devices/token', { code: good.code, code_verifier: good.verifier, redirect_uri: BACK });
  assert.equal(stopped.status, 429);
  assert.equal(stopped.data.error, 'too_many_attempts');
  assert.ok(stopped.data.retry_after > 0);
});

test('a code or a token is never kept to replay an Idempotency-Key: the database keeps hashes only', async (t) => {
  const { suite, web } = await startApp(t, { product: DEVICES_ON });
  const pair = pkce();
  const key = { 'Idempotency-Key': 'connect-phone-1' };
  const ask = { code_challenge: pair.challenge, redirect_uri: BACK, name: 'Bus' };
  const first = await web('POST', '/api/devices/codes', ask, key);
  const again = await web('POST', '/api/devices/codes', ask, key);
  assert.equal(again.headers.get('idempotent-replayed'), null);
  assert.notEqual(first.data.code, again.data.code, 'a new code, not the first one replayed');
  // Even sent with a session and a key, which the app never does.
  const token = await web('POST', '/api/devices/token', { code: first.data.code, code_verifier: pair.verifier, redirect_uri: BACK },
    { 'Idempotency-Key': 'exchange-1' });
  assert.equal(token.status, 200);
  assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM idempotency_keys').n, 0);
  // An ordinary write with a key is still kept.
  const apiToken = (await web('POST', '/api/me/tokens', { name: 'Script' })).data;
  assert.equal((await web('DELETE', `/api/me/tokens/${apiToken.id}`, undefined, { 'Idempotency-Key': 'revoke-1' })).status, 200);
  assert.deepEqual(suite.database.all('SELECT key FROM idempotency_keys').map((r) => r.key), ['revoke-1']);
});

test('the admin signing someone out everywhere, or setting their password, revokes their phones too', async (t) => {
  const { suite, web } = await startApp(t, { product: DEVICES_ON });
  const ana = suite.accounts.create({ username: 'ana', displayName: 'Ana', password: 'ana-password-123' });
  const connect = (name) => {
    const pair = pkce();
    const issued = suite.devices.issueCode(ana, { codeChallenge: pair.challenge, redirectUri: BACK, name });
    return suite.devices.exchange({ code: issued.code, verifier: pair.verifier, redirectUri: BACK }).token;
  };
  const phone = connect('Lost phone');
  const tablet = connect('Tablet');
  const script = suite.tokens.create(ana.id, { name: 'Script' }).token;
  assert.ok(suite.devices.authenticate(phone));

  const out = await web('DELETE', `/api/admin/users/${ana.id}/sessions`);
  assert.equal(out.status, 200);
  assert.deepEqual(out.data, { ok: true, closed: 0, tokens: 1, devices: 2 });
  assert.equal(suite.devices.authenticate(phone), null, 'the lost phone is out');
  assert.equal(suite.devices.authenticate(tablet), null);
  assert.equal(suite.tokens.authenticate(script, { scope: 'mcp' }), null, 'as its API tokens are');
  assert.deepEqual(suite.devices.list(ana.id), []);
  assert.deepEqual(suite.audit.list({ action: 'admin.user.signout' })[0].meta, { closed: 0, tokens: 1, devices: 2 });

  // A password the admin sets for someone else is that person out everywhere, phones included.
  const next = connect('New phone');
  assert.ok(suite.devices.authenticate(next));
  assert.equal((await web('PATCH', `/api/admin/users/${ana.id}`, { password: 'new-password-456' })).status, 200);
  assert.equal(suite.devices.authenticate(next), null);
});

test('the admin’s activity log names every device entry, in every language', () => {
  const actions = ['device.create', 'device.revoke', 'device.token_failed', 'device.web_session', 'device.web_session_failed', 'device.action'];
  for (const lang of ['en', 'es', 'fr', 'de']) {
    const catalog = JSON.parse(fs.readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const action of actions) {
      const key = `admin.actions.${action.replace(/\./g, '_')}`;
      assert.ok(catalog[key], `${lang}: ${key}`);
    }
  }
});

test('createApp({ devices: { canConnect } }) refuses whom the app doesn’t let in; without the module it only says so', async (t) => {
  const refused = await startApp(t, { product: DEVICES_ON, appOptions: { devices: { canConnect: (user) => user.username !== 'admin' } } });
  const answer = await refused.web('POST', '/api/devices/codes', { code_challenge: pkce().challenge, redirect_uri: BACK, name: 'Bus' });
  assert.equal(answer.status, 403);
  assert.equal(answer.data.error, 'device_not_allowed');

  const off = await startApp(t, { appOptions: { devices: { canConnect: () => true } } });
  assert.ok(off.lines.includes('[tracker] createApp({ devices }) is given, but modules.devices is off: no phone can connect'));
});
