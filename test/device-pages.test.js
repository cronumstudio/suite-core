/**
 * The suite's pages for an app on a phone (device-pages.js): the connect page
 * (`devices.connectPage`) and sessions of the web from a device's token
 * (`devices.webSessions`), off unless the app turns them on; in an app on its
 * own and at a host's root, over real HTTP.
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
import { createSessions } from '../sessions.js';
import { createDevices } from '../devices.js';
import { resolveConfig } from '../config.js';
import { createSuite, createApp, SuiteConfigError } from '../app.js';
import { createHost } from '../host.js';
import {
  connectRequest, connectPath, createConnectCookie, createDevicePages, localNext, CONNECT_MS,
} from '../device-pages.js';
import { randomToken, sha256 } from '../crypto.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const BACK = 'com.example.work:/auth';
const pkce = () => {
  const verifier = randomToken(32);
  return { verifier, challenge: sha256(verifier) };
};
const ASK = (challenge = pkce().challenge) => ({ code_challenge: challenge, state: 'st-1', redirect_uri: BACK, name: 'Ana’s iPhone', platform: 'iOS' });
const query = (fields) => `?${new URLSearchParams(fields)}`;

/* ------------------------------ configuration ------------------------------ */

test('the options: off by default and absent from the configuration; booleans, and only with modules.devices', () => {
  const app = { id: 'work', name: 'Work' };
  const devices = { prefix: 'workdev_', redirectUris: [BACK] };
  const plain = resolveConfig({ app, modules: { devices: true }, devices }, {});
  assert.deepEqual(plain.errors, []);
  assert.deepEqual(plain.devices, { prefix: 'workdev_', redirectUris: [BACK], idleDays: 90 }, 'the shape an app had, unchanged');

  const on = resolveConfig({ app, modules: { devices: true }, devices: { ...devices, connectPage: true, webSessions: true } }, {});
  assert.deepEqual(on.errors, []);
  assert.equal(on.devices.connectPage, true);
  assert.equal(on.devices.webSessions, true);

  assert.deepEqual(resolveConfig({ app, devices: { connectPage: true, webSessions: false } }, {}).errors,
    ['devices.connectPage needs modules.devices: the device tokens it works with']);
  assert.deepEqual(resolveConfig({ app, modules: { devices: true }, devices: { ...devices, webSessions: 'yes' } }, {}).errors,
    ['devices.webSessions must be true or false']);
});

/* --------------------------- the connect request --------------------------- */

test('a connect request: the core’s shapes, an allowed return address exactly, one of each field', () => {
  const ask = ASK();
  const options = { redirectUris: [BACK] };
  assert.deepEqual(connectRequest(new URLSearchParams(ask), options), { ...ask, platform: 'ios' });
  assert.equal(connectRequest(new URLSearchParams({ ...ask, redirect_uri: 'com.evil.app:/auth' }), options), null);
  assert.equal(connectRequest(new URLSearchParams({ ...ask, code_challenge: 'short' }), options), null);
  assert.equal(connectRequest(new URLSearchParams({ ...ask, state: 'a b' }), options), null);
  assert.equal(connectRequest(new URLSearchParams({ ...ask, name: ' ' }), options), null);
  assert.equal(connectRequest(new URLSearchParams({ ...ask, name: 'x'.repeat(61) }), options), null);
  assert.equal(connectRequest(new URLSearchParams({ ...ask, name: 'a\u0007b' }), options), null);
  assert.equal(connectRequest(new URLSearchParams(`${new URLSearchParams(ask)}&state=again`), options), null, 'twice is no request');
  const { platform, ...bare } = ask;
  assert.equal(connectRequest(new URLSearchParams(bare), options).platform, null, 'the platform is optional');
  assert.match(connectPath(connectRequest(new URLSearchParams(ask), options)), /^\/devices\/connect\?code_challenge=/);
});

test('the cookie across the sign-in: signed, ten minutes, and only for a request still allowed', () => {
  let now = Date.parse('2026-10-20T10:00:00Z');
  const sign = (value) => sha256(`secret|${value}`);
  const cookie = createConnectCookie({ name: 'work_connect', sign, redirectUris: [BACK], clock: () => now });
  const request = connectRequest(new URLSearchParams(ASK()), { redirectUris: [BACK] });
  const req = (value) => ({ headers: { cookie: `work_connect=${value}` } });
  const value = cookie.value(request);
  assert.deepEqual(cookie.read(req(value)), request);
  const [payload, signature] = value.split('.');
  const changed = Buffer.from(JSON.stringify({ ...request, redirect_uri: 'com.evil.app:/auth', expires: now + 1000 })).toString('base64url');
  assert.equal(cookie.read(req(`${changed}.${signature}`)), null, 'changed');
  assert.equal(cookie.read(req(`${payload}.x`)), null);
  now += CONNECT_MS;
  assert.equal(cookie.read(req(value)), null, 'expired');
  assert.equal(createConnectCookie({ name: 'work_connect', sign, redirectUris: [] }).read(req(cookie.value(request))), null,
    'an address no longer allowed');
  const res = { headers: {}, getHeader(k) { return this.headers[k]; }, setHeader(k, v) { this.headers[k] = v; } };
  cookie.write(res, request);
  assert.match([].concat(res.headers['Set-Cookie'])[0], /^work_connect=.+; Max-Age=600; Path=\/; HttpOnly; SameSite=Lax$/);
});

test('`next`: a path of this site only', () => {
  const next = (value) => localNext(new URLSearchParams(value === undefined ? '' : { next: value }));
  assert.equal(next('/tasks/'), '/tasks/');
  assert.equal(next('/notes/?q=a%20b#x'), '/notes/?q=a%20b#x');
  for (const bad of [undefined, '', 'tasks', '//evil.example', '/\\evil.example', 'https://evil.example/', '/\tx', 'javascript:alert(1)', '/a b']) {
    assert.equal(next(bad), '/', String(bad));
  }
  assert.equal(localNext(new URLSearchParams('next=/a&next=/b')), '/', 'twice');
});

/* ------------------------- under a provider's sign-in ------------------------ */

/** The pages of a suite whose sign-in leaves the site, with stand-ins for what they use. */
function providerPages({ signedIn = false } = {}) {
  const sign = (value) => sha256(`k|${value}`);
  const suite = {
    config: {
      app: { id: 'my-work', name: 'Work' },
      devices: { redirectUris: [BACK], connectPage: true },
      install: { authProvider: 'workos', secureCookies: true },
    },
    sessions: { sign, userFrom: () => (signedIn ? { id: 1 } : null) },
    devices: {},
  };
  return createDevicePages({ suite });
}
function exchange(pages, pathname, cookie = null) {
  const headers = {};
  const res = {
    status: null,
    getHeader: (k) => headers[k.toLowerCase()],
    setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
    writeHead(status, extra) { this.status = status; for (const [k, v] of Object.entries(extra || {})) headers[k.toLowerCase()] = v; },
    end() {},
  };
  const req = { method: 'GET', headers: cookie ? { cookie } : {} };
  const url = new URL(pathname, 'http://work.example');
  const answered = pathname.startsWith('/devices/') ? pages.handle(req, res, url) : pages.back(req, res, url);
  return { answered, status: res.status, location: headers.location, cookies: [].concat(headers['set-cookie'] || []) };
}

test('under a provider’s sign-in: the request waits in a cookie, and `/` brings the browser back to it', () => {
  const ask = ASK();
  const out = exchange(providerPages(), `/devices/connect${query(ask)}`);
  assert.deepEqual([out.answered, out.status, out.location], [true, 302, '/auth/login']);
  assert.match(out.cookies[0], /^my_work_connect=.+; Max-Age=600; Path=\/; HttpOnly; SameSite=Lax; Secure$/);
  const value = out.cookies[0].split(';')[0];

  // Back from the provider, signed in: to the page with the same request, the cookie cleared.
  const back = exchange(providerPages({ signedIn: true }), '/', value);
  assert.equal(back.status, 302);
  assert.deepEqual(Object.fromEntries(new URL(back.location, 'http://x').searchParams), { ...ask, platform: 'ios' });
  assert.match(back.cookies[0], /^my_work_connect=; Max-Age=0/);
  // Not signed in yet, or no cookie: `/` is the app's.
  assert.equal(exchange(providerPages(), '/', value).answered, false);
  assert.equal(exchange(providerPages({ signedIn: true }), '/').answered, false);
  // A cookie someone changed: cleared, and `/` shows as always.
  const bad = exchange(providerPages({ signedIn: true }), '/', 'my_work_connect=abc.def');
  assert.equal(bad.answered, false);
  assert.match(bad.cookies[0], /^my_work_connect=; Max-Age=0/);

  // Signed in already: the page, with no cookie.
  const page = exchange(providerPages({ signedIn: true }), `/devices/connect${query(ask)}`);
  assert.deepEqual([page.status, page.cookies], [200, []]);
  // A request that is not one: the bare page, which says so.
  assert.equal(exchange(providerPages(), `/devices/connect${query({ ...ask, redirect_uri: 'https://evil.example/' })}`).location, '/devices/connect');
});

test('no options, no pages', () => {
  const suite = { config: { devices: { redirectUris: [BACK] }, install: {} }, sessions: {}, devices: {} };
  assert.equal(createDevicePages({ suite }), null);
  assert.equal(createDevicePages({ suite: { ...suite, config: { ...suite.config, devices: { connectPage: true } }, devices: null } }), null);
});

/* ------------------------------ the codes alone ------------------------------ */

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-device-pages-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const now = { ms: Date.parse('2026-10-20T08:00:00.000Z') };
  const clock = () => now.ms;
  const accounts = createAccounts({ database, clock });
  const sessions = createSessions({ database, secret: 's3cret', cookieName: 'work_sid', clock });
  const devices = createDevices({ database, prefix: 'workdev_', redirectUris: [BACK], clock });
  sessions.checkDevices((id) => devices.sessionAlive(id));
  const ana = accounts.create({ username: 'ana', displayName: 'Ana' });
  const connect = () => {
    const pair = pkce();
    const issued = devices.issueCode(ana, { codeChallenge: pair.challenge, redirectUri: BACK, name: 'Phone' });
    return devices.exchange({ code: issued.code, verifier: pair.verifier, redirectUri: BACK });
  };
  return { database, accounts, sessions, devices, ana, now, connect };
}

test('a web-session code: one minute, once, a hash in the table, and only for a device that still works', (t) => {
  const { database, devices, ana, now, connect } = setup(t);
  const phone = connect();
  const principal = devices.authenticate(phone.token);
  const { code, expires_at: expires } = devices.issueWebCode(principal);
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Date.parse(expires) - now.ms, MINUTE);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM device_web_codes WHERE code_hash = ?', sha256(code)).n, 1, 'its hash only');
  assert.throws(() => devices.issueWebCode({ ...ana }), { status: 401 }, 'a person is not a device');

  const taken = devices.takeWebCode(code);
  assert.deepEqual([taken.user.username, taken.deviceId], ['ana', phone.device.id]);
  assert.deepEqual(devices.takeWebCode(code), { failed: 'reused', userId: ana.id }, 'once');
  assert.ok(devices.authenticate(phone.token), 'a code back again revokes nothing: a WebView goes back in its history');
  assert.deepEqual(devices.takeWebCode('nope'), { failed: 'unknown', userId: null });
  assert.deepEqual(devices.takeWebCode(null), { failed: 'unknown', userId: null });

  const late = devices.issueWebCode(principal).code;
  now.ms += MINUTE;
  assert.equal(devices.takeWebCode(late).failed, 'expired');
  const revoked = devices.issueWebCode(principal).code;
  devices.revoke(ana.id, phone.device.id);
  assert.equal(devices.takeWebCode(revoked).failed, 'device');

  // Ten waiting at once is the most: a script can't fill the table.
  const other = devices.authenticate(connect().token);
  for (let i = 0; i < 10; i++) devices.issueWebCode(other);
  assert.throws(() => devices.issueWebCode(other), { status: 429, code: 'too_many_attempts' });
  now.ms += 2 * DAY;
  assert.ok(devices.purge() >= 13, 'the codes go a day after they expired');
  assert.equal(database.get('SELECT COUNT(*) AS n FROM device_web_codes').n, 0);
});

test('a session from a device lives while the device does, and keeps it in use', (t) => {
  const { database, accounts, sessions, devices, ana, now, connect } = setup(t);
  const cookie = (token) => ({ headers: { cookie: `work_sid=${token}` } });
  const phone = connect();
  const linked = sessions.open(ana.id, { deviceId: phone.device.id });
  assert.equal(sessions.userFrom(cookie(linked)).username, 'ana');

  // Used through the WebView alone, the phone never goes idle.
  for (let day = 0; day < 100; day += 20) {
    now.ms += 20 * DAY;
    assert.equal(sessions.userFrom(cookie(linked))?.username, 'ana', `day ${day + 20}`);
  }
  assert.ok(devices.authenticate(phone.token), 'its token too');
  const web = sessions.open(ana.id);

  // Revoked: its sessions go with it, the others stay.
  assert.ok(devices.revoke(ana.id, phone.device.id));
  assert.equal(sessions.userFrom(cookie(linked)), null);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM sessions WHERE device_id IS NOT NULL').n, 0, 'deleted, not only refused');
  assert.equal(sessions.userFrom(cookie(web))?.username, 'ana', 'a session of the web stays');

  // Ended any other way (idle, a disabled account, the app's own rule): refused at its next use.
  const second = connect();
  const again = sessions.open(ana.id, { deviceId: second.device.id });
  devices.setCanConnect(() => false);
  assert.equal(sessions.userFrom(cookie(again)), null, 'the app no longer lets the person connect');
  assert.equal(database.get('SELECT COUNT(*) AS n FROM sessions WHERE device_id = ?', second.device.id).n, 0);
  devices.setCanConnect(() => true);

  const third = connect();
  const idle = sessions.open(ana.id, { deviceId: third.device.id });
  database.run('UPDATE device_tokens SET last_used_at = ? WHERE id = ?', new Date(now.ms - 91 * DAY).toISOString(), third.device.id);
  assert.equal(sessions.userFrom(cookie(idle)), null, 'idle');

  // Revoked everywhere (the admin): every device's sessions.
  const fourth = connect();
  const lost = sessions.open(ana.id, { deviceId: fourth.device.id });
  assert.equal(devices.revokeAllOf(ana.id), 3, 'this one, and the two that stopped working without being revoked');
  assert.equal(sessions.userFrom(cookie(lost)), null);

  // A suite that never said how to check a device opens none of these sessions.
  const bare = createSessions({ database, secret: 's3cret', cookieName: 'work_sid', clock: () => now.ms });
  const fifth = connect();
  assert.equal(bare.userFrom(cookie(sessions.open(ana.id, { deviceId: fifth.device.id }))), null);
  assert.equal(accounts.byId(ana.id).username, 'ana');
});

/* --------------------------------- over HTTP -------------------------------- */

async function startApp(t, { product = {}, appOptions = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-device-pages-app-'));
  const lines = [];
  const suite = createSuite({
    config: { app: { id: 'work', name: 'Work', languages: ['en'] }, tokens: { prefix: 'work_' }, ...product },
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1' },
    log: (line) => lines.push(line), exitOnError: false,
  });
  const app = createApp({ suite, version: '1.0.0', handleSignals: false, log: (line) => lines.push(line), ...appOptions });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { suite, lines, ...client(`http://127.0.0.1:${server.address().port}`, 'work_sid') };
}

/** fetch with a jar of one cookie, the session's, as a browser keeps it; `fresh()` is another browser. */
function client(base, cookieName) {
  const make = () => {
    let cookie = '';
    const call = async (method, pathname, body, headers = {}) => {
      const res = await fetch(base + pathname, {
        method, redirect: 'manual',
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith(`${cookieName}=`));
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let data = text;
      try { data = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, data, headers: res.headers, setCookies: res.headers.getSetCookie?.() || [] };
    };
    return { call, cookie: () => cookie };
  };
  const first = make();
  return { call: first.call, cookie: first.cookie, fresh: make };
}

const DEVICES = { prefix: 'workdev_', redirectUris: [BACK] };
const ON = { modules: { devices: true }, devices: { ...DEVICES, connectPage: true, webSessions: true }, rateLimits: { devices: 4 } };

/** A phone connected for `user`: its token. */
function phoneOf(suite, user, name = 'Phone') {
  const pair = pkce();
  const issued = suite.devices.issueCode(user, { codeChallenge: pair.challenge, redirectUri: BACK, name });
  return suite.devices.exchange({ code: issued.code, verifier: pair.verifier, redirectUri: BACK });
}

test('without the options nothing new answers: an app with devices (Tracker) is as it was', async (t) => {
  const { suite, call } = await startApp(t, { product: { modules: { devices: true }, devices: DEVICES } });
  assert.equal((await call('GET', '/devices/connect')).status, 404);
  assert.equal((await call('GET', `/devices/connect${query(ASK())}`)).status, 404);
  assert.equal((await call('GET', '/devices/session?code=x')).status, 404);
  const admin = suite.accounts.byUsername('admin');
  const { token } = phoneOf(suite, admin);
  assert.equal((await call('POST', '/api/devices/web-session', undefined, { Authorization: `Bearer ${token}` })).status, 404);
});

test('the connect page: the suite’s, with local accounts in place; a request that is not one goes to the bare page', async (t) => {
  const { call } = await startApp(t, { product: { ...ON, app: { id: 'work', name: 'Work', color: '#3A4660', icon: '/icons/work.svg', languages: ['en'] } } });
  const bare = await call('GET', '/devices/connect');
  assert.equal(bare.status, 200);
  assert.match(bare.headers.get('content-type'), /^text\/html/);
  assert.equal(bare.headers.get('cache-control'), 'no-store');
  assert.ok(bare.headers.get('content-security-policy'), 'the security headers');
  assert.match(bare.data, /<script type="module" src="\/suite\/connect\.js"><\/script>/);
  assert.match(bare.data, /<title>Work<\/title>/);
  assert.match(bare.data, /data-app="work" style="--app: #3A4660/);
  assert.match(bare.data, /href="\/icons\/work\.svg"/);
  const ask = ASK();
  const page = await call('GET', `/devices/connect${query(ask)}`);
  assert.equal(page.status, 200, 'signed out with local accounts: the page signs in in place');
  assert.deepEqual(page.setCookies, [], 'no cookie needed');
  const wrong = await call('GET', `/devices/connect${query({ ...ask, redirect_uri: 'com.evil.app:/auth' })}`);
  assert.deepEqual([wrong.status, wrong.headers.get('location')], [302, '/devices/connect']);
  assert.equal((await call('HEAD', '/devices/connect')).status, 200);
  assert.equal((await call('POST', '/devices/connect')).status, 405);
  // The kit's code for it is served with the rest.
  assert.match((await call('GET', '/suite/connect.js')).data, /export function showConnect/);
});

test('a web session from a device: the token asks, the WebView opens it once, signed in where `next` says', async (t) => {
  const { suite, call, fresh } = await startApp(t, { product: ON });
  const ana = suite.accounts.create({ username: 'ana', displayName: 'Ana', password: 'ana-password-123' });
  const phone = phoneOf(suite, ana, 'Ana’s iPhone');
  const auth = { Authorization: `Bearer ${phone.token}` };

  // The token only: no session, no other kind of token, nothing at all.
  assert.equal((await call('POST', '/api/devices/web-session')).status, 401);
  const asked = await call('POST', '/api/devices/web-session', undefined, auth);
  assert.equal(asked.status, 201);
  assert.equal(asked.headers.get('cache-control'), 'no-store');
  assert.match(asked.data.url, /^\/devices\/session\?code=[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(asked.data.expires_at) > Date.now());

  // The WebView: another browser, with no session.
  const webview = fresh();
  const opened = await webview.call('GET', `${asked.data.url}&next=${encodeURIComponent('/tasks/?view=today')}`);
  assert.equal(opened.status, 302);
  assert.equal(opened.headers.get('location'), '/tasks/?view=today');
  assert.equal(opened.headers.get('cache-control'), 'no-store');
  const set = opened.setCookies.find((c) => c.startsWith('work_sid='));
  assert.match(set, /^work_sid=[^;]+; Max-Age=31536000; Path=\/; HttpOnly; SameSite=Lax$/, 'the same cookie as a sign-in');
  assert.equal((await webview.call('GET', '/api/auth/me')).data.user.username, 'ana');
  const row = suite.database.get('SELECT device_id FROM sessions WHERE device_id IS NOT NULL');
  assert.equal(row.device_id, phone.device.id, 'linked to its device');
  assert.equal(suite.accounts.byId(ana.id).last_login_at !== null, true, 'noted as a sign-in');

  // Once: the same address again opens nothing, and goes to `/` without a cookie.
  const another = fresh();
  const spent = await another.call('GET', asked.data.url);
  assert.deepEqual([spent.status, spent.headers.get('location')], [302, '/']);
  assert.equal(spent.setCookies.length, 0);
  assert.equal((await another.call('GET', '/api/auth/me')).data.user, null);

  // `next` elsewhere goes home.
  const elsewhere = (await call('POST', '/api/devices/web-session', undefined, auth)).data.url;
  assert.equal((await fresh().call('GET', `${elsewhere}&next=${encodeURIComponent('//evil.example/x')}`)).headers.get('location'), '/');

  // Started by another site: refused, and the code isn't spent by it.
  const lured = (await call('POST', '/api/devices/web-session', undefined, auth)).data.url;
  const cross = await fresh().call('GET', lured, undefined, { 'Sec-Fetch-Site': 'cross-site' });
  assert.deepEqual([cross.status, cross.headers.get('location'), cross.setCookies.length], [302, '/', 0]);
  assert.equal((await fresh().call('GET', lured, undefined, { 'Sec-Fetch-Site': 'none' })).setCookies.length, 1, 'the app’s own still works');

  // The device signs out with its token: the WebView's session ends with it.
  assert.equal((await call('DELETE', '/api/devices/current', undefined, auth)).status, 200);
  assert.equal((await webview.call('GET', '/api/auth/me')).data.user, null);
  assert.equal((await call('POST', '/api/devices/web-session', undefined, auth)).status, 401, 'and asks for no more');

  const actions = suite.audit.list({ action: 'device.web_session' }).map((e) => `${e.action}${e.meta?.reason ? ` ${e.meta.reason}` : ''}`).reverse();
  assert.deepEqual(actions, ['device.web_session', 'device.web_session_failed reused', 'device.web_session',
    'device.web_session_failed cross_site', 'device.web_session']);
});

test('revoked from Settings, by the admin, a disabled account or the app’s rule: the session goes, and no new one opens', async (t) => {
  let allowed = true;
  const { suite, call, fresh } = await startApp(t, { product: ON, appOptions: { devices: { canConnect: () => allowed } } });
  const ana = suite.accounts.create({ username: 'ana', displayName: 'Ana', password: 'ana-password-123' });
  const signIn = async (token, browser = fresh()) => {
    const { url } = (await call('POST', '/api/devices/web-session', undefined, { Authorization: `Bearer ${token}` })).data;
    await browser.call('GET', url);
    return browser;
  };
  const me = async (browser) => (await browser.call('GET', '/api/auth/me')).data.user?.username ?? null;

  // Settings: the owner disconnects the phone.
  const owner = fresh();
  await owner.call('POST', '/api/auth/login', { username: 'ana', password: 'ana-password-123' });
  const first = phoneOf(suite, ana);
  const webview = await signIn(first.token);
  assert.equal(await me(webview), 'ana');
  assert.equal((await owner.call('DELETE', `/api/me/devices/${first.device.id}`)).status, 200);
  assert.equal(await me(webview), null);
  assert.equal(await me(owner), 'ana', 'the owner’s own session stays');

  // The admin signs Ana out everywhere.
  const second = phoneOf(suite, ana);
  const other = await signIn(second.token);
  assert.equal(await me(other), 'ana');
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  assert.equal((await call('DELETE', `/api/admin/users/${ana.id}/sessions`)).data.devices, 1);
  assert.equal(await me(other), null);

  // The app's own rule: a person it no longer lets in.
  const third = phoneOf(suite, ana);
  const ruled = await signIn(third.token);
  allowed = false;
  assert.equal(await me(ruled), null);
  assert.equal((await call('POST', '/api/devices/web-session', undefined, { Authorization: `Bearer ${third.token}` })).status, 401);
  allowed = true;

  // A code asked before the account was disabled opens nothing after.
  const fourth = phoneOf(suite, ana);
  const { url } = (await call('POST', '/api/devices/web-session', undefined, { Authorization: `Bearer ${fourth.token}` })).data;
  assert.equal((await call('PATCH', `/api/admin/users/${ana.id}`, { disabled: true })).status, 200);
  const late = fresh();
  const refused = await late.call('GET', url);
  assert.deepEqual([refused.headers.get('location'), refused.setCookies.length], ['/', 0]);
  assert.equal(suite.audit.list({ action: 'device.web_session_failed' })[0].meta.reason, 'device');
});

test('failures count against the address, as the token’s exchange does, and past the limit it waits', async (t) => {
  const { suite, call, fresh } = await startApp(t, { product: ON });
  const admin = suite.accounts.byUsername('admin');
  const { token } = phoneOf(suite, admin);
  for (let i = 0; i < 2; i++) assert.equal((await call('POST', '/api/devices/web-session', undefined, { Authorization: 'Bearer workdev_nope' })).status, 401);
  for (let i = 0; i < 2; i++) assert.equal((await fresh().call('GET', `/devices/session?code=${randomToken(32)}`)).headers.get('location'), '/');
  const stopped = await call('POST', '/api/devices/web-session', undefined, { Authorization: `Bearer ${token}` });
  assert.equal(stopped.status, 429);
  assert.equal(stopped.data.error, 'too_many_attempts');
  // The page waits too: a right code is not even looked at, and stays good for later.
  assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM device_web_codes').n, 0);
});

/* ------------------------------- at a host's root ------------------------------- */

const fixture = (name, q) => new URL(`./fixtures/host/${name}/module.js${q}`, import.meta.url);
let fresh = 0;

async function startHost(t, product = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-device-pages-host-'));
  fresh += 1;
  const host = await createHost({
    config: { app: { id: 'work', name: 'Work', color: '#3A4660', icon: '/icons/work.svg', languages: ['en', 'es'] }, ...ON, ...product },
    modules: [{ mount: 'alpha', entry: fixture('alpha', `?devices=${fresh}`) }, { mount: 'beta', entry: fixture('beta', `?devices=${fresh}`) }],
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1' },
    version: '9.9.9', handleSignals: false, exitOnError: false, log: () => {},
  });
  const server = await host.listen();
  t.after(async () => {
    await host.close();
    host.suite.database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { host, ...client(`http://127.0.0.1:${server.address().port}`, 'work_sid') };
}

test('at a host’s root: the connect page, the web session with the host’s cookie, and back from the sign-in', async (t) => {
  const { host, call, cookie: session, fresh: browser } = await startHost(t);
  const { suite } = host;
  assert.ok(suite.devices, 'the host’s own configuration turns devices on');
  const page = await call('GET', `/devices/connect${query(ASK())}`);
  assert.equal(page.status, 200);
  assert.match(page.data, /src="\/suite\/connect\.js"/);
  assert.match((await call('GET', '/suite/connect.js')).data, /showConnect/);

  // The page's Allow, signed in at the root.
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  const pair = pkce();
  const issued = await call('POST', '/api/devices/codes', { ...ASK(pair.challenge), code_challenge_method: 'S256' });
  assert.equal(issued.status, 201);
  const { token } = (await call('POST', '/api/devices/token', { code: issued.data.code, code_verifier: pair.verifier, redirect_uri: BACK })).data;
  assert.match(token, /^workdev_/);

  // The WebView: one module's page, signed in with the host's one cookie.
  const { url } = (await call('POST', '/api/devices/web-session', undefined, { Authorization: `Bearer ${token}` })).data;
  const webview = browser();
  const opened = await webview.call('GET', `${url}&next=/beta/`);
  assert.deepEqual([opened.status, opened.headers.get('location')], [302, '/beta/']);
  assert.equal((await webview.call('GET', '/alpha/api/auth/me')).data.user.username, 'admin', 'in every module');
  assert.equal((await webview.call('GET', '/beta/api/auth/me')).data.user.username, 'admin');
  assert.equal((await call('DELETE', '/api/devices/current', undefined, { Authorization: `Bearer ${token}` })).status, 200);
  assert.equal((await webview.call('GET', '/beta/api/auth/me')).data.user, null, 'gone with its device');

  // Back from a provider's sign-in: `/` with the request's cookie goes to the page, not to the first module.
  const ask = ASK();
  const cookie = createConnectCookie({ name: 'work_connect', sign: suite.sessions.sign, redirectUris: [BACK] });
  const value = cookie.value(connectRequest(new URLSearchParams(ask), { redirectUris: [BACK] }));
  const back = await call('GET', '/', undefined, { Cookie: `${session()}; work_connect=${value}` });
  assert.equal(back.status, 302);
  assert.match(back.headers.get('location'), /^\/devices\/connect\?code_challenge=/);
  assert.ok(back.setCookies.some((c) => /^work_connect=; Max-Age=0/.test(c)));
  assert.equal((await call('GET', '/')).headers.get('location'), '/alpha/', 'without it, as before');
});

test('a host without the options keeps `/` and /devices/ as they were; a module can’t take that path when they are on', async (t) => {
  const { call } = await startHost(t, { devices: DEVICES });
  assert.equal((await call('GET', '/devices/connect')).status, 404);
  assert.equal((await call('GET', '/')).headers.get('location'), '/alpha/');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-device-pages-host-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(createHost({
    config: { app: { id: 'work', name: 'Work' }, ...ON },
    modules: [{ mount: 'devices', entry: fixture('alpha', '?devices=mount') }],
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1' },
    handleSignals: false, exitOnError: false, log: () => {},
  }), (err) => err instanceof SuiteConfigError
    && err.errors[0] === 'modules: "devices" is the path of the host’s phone pages (devices.connectPage, devices.webSessions)');
});
