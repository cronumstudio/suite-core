/**
 * Web Push (push.js): the encryption a device can read, the VAPID signature a
 * push service checks, what happens with each answer, where a subscription may
 * point, the install's keys, and the routes with `modules.push`. A fake push
 * service stands in for Google's or Apple's.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateVapidKeys, vapidKeyErrors, vapidKeys, encryptPayload, decryptPayload, checkEndpoint, createPush, MAX_DEVICES,
} from '../push.js';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { createAccounts } from '../accounts.js';
import { resolveConfig } from '../config.js';
import { createSuite, createApp } from '../app.js';

/** A browser's subscription keys: the device's key pair and its auth secret. */
function deviceKeys() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  return {
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
    d: pair.privateKey.export({ format: 'jwk' }).d,
  };
}

/** A push service on this machine that answers `status` and keeps what it got. */
async function fakeService(t, status = 201) {
  const got = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(typeof status === 'function' ? status() : status).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { got, url: (p = '/push/abc') => `http://127.0.0.1:${server.address().port}${p}` };
}

function store() {
  const database = openDatabase({ path: ':memory:' });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const accounts = createAccounts({ database, minPasswordLength: 8 });
  return { database, accounts };
}

test('what is sent can only be read with the device’s keys, and every message is different', () => {
  const device = deviceKeys();
  const message = JSON.stringify({ title: 'Compra', body: 'Laura ha añadido 3 cosas' });
  const body = encryptPayload(device.p256dh, device.auth, Buffer.from(message));
  assert.equal(body.readUInt32BE(16), 4096, 'the aes128gcm record size');
  assert.equal(body.readUInt8(20), 65, 'followed by our ephemeral public key');
  assert.equal(decryptPayload(body, device.d, device.p256dh, device.auth).toString(), message);
  assert.ok(!encryptPayload(device.p256dh, device.auth, Buffer.from(message)).equals(body), 'new keys and salt each time');
  const other = deviceKeys();
  assert.throws(() => decryptPayload(body, other.d, other.p256dh, device.auth), 'another device cannot read it');
  assert.throws(() => encryptPayload('abc', device.auth, Buffer.from('x')), /p256dh/);
});

test('the install’s VAPID keys: the environment’s, or generated once and kept', () => {
  const pair = generateVapidKeys();
  assert.equal(vapidKeyErrors(pair), null);
  assert.match(vapidKeyErrors({ ...pair, publicKey: 'short' }), /VAPID_PUBLIC_KEY/);
  assert.match(vapidKeyErrors({ ...pair, privateKey: 'short' }), /VAPID_PRIVATE_KEY/);
  assert.match(vapidKeyErrors({ ...pair, privateKey: generateVapidKeys().privateKey }), /does not go with/);

  const { database } = store();
  const lines = [];
  const fromEnv = vapidKeys(database, { ...pair, subject: 'mailto:a@b.c' }, { log: (l) => lines.push(l) });
  assert.deepEqual(fromEnv, { ...pair, subject: 'mailto:a@b.c', source: 'environment' });
  assert.equal(database.getMeta('vapid_keys'), null, 'the environment’s are never copied into the database');

  const first = vapidKeys(database, { subject: 'https://app.example' }, { log: (l) => lines.push(l) });
  const again = vapidKeys(database, { subject: 'https://app.example' }, { log: (l) => lines.push(l) });
  assert.equal(first.source, 'database');
  assert.equal(vapidKeyErrors(first), null);
  assert.equal(again.publicKey, first.publicKey, 'the same keys on every start: subscriptions depend on them');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /generated them and stored them in the database/);
});

test('the configuration: both keys or neither (else a warning and the install’s own), and the subject', () => {
  const pair = generateVapidKeys();
  const product = { app: { id: 'demo', name: 'Demo' } };
  const plain = resolveConfig(product, {}, { cwd: os.tmpdir() });
  assert.deepEqual(plain.install.push, { publicKey: null, privateKey: null, subject: 'mailto:admin@localhost' });
  assert.equal(resolveConfig(product, { ADMIN_EMAIL: 'boss@example.com' }, { cwd: os.tmpdir() }).install.push.subject,
    'mailto:boss@example.com');
  assert.equal(resolveConfig(product, { BASE_URL: 'https://app.example' }, { cwd: os.tmpdir() }).install.push.subject,
    'https://app.example');
  // Notifications are an extra: a mistake is said, never a reason not to start.
  const half = resolveConfig(product, { VAPID_PUBLIC_KEY: pair.publicKey }, { cwd: os.tmpdir() });
  assert.deepEqual(half.errors, []);
  assert.ok(half.warnings.some((w) => /go together.*keys generated for this install/.test(w)), half.warnings.join(' | '));
  assert.equal(half.install.push.publicKey, null);
  const wrong = resolveConfig(product, { VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: generateVapidKeys().privateKey },
    { cwd: os.tmpdir() });
  assert.deepEqual(wrong.errors, []);
  assert.ok(wrong.warnings.some((w) => /does not go with/.test(w)), wrong.warnings.join(' | '));
  assert.equal(wrong.install.push.privateKey, null);
  const good = resolveConfig(product, { VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey }, { cwd: os.tmpdir() });
  assert.deepEqual([good.errors, good.install.push.publicKey], [[], pair.publicKey]);
});

test('a notice reaches the push service signed with VAPID, and the device can read it', async (t) => {
  const service = await fakeService(t);
  const vapid = { ...generateVapidKeys(), subject: 'mailto:ops@example.com' };
  const { database } = store();
  const push = createPush({ database, vapid, log: () => {} });
  const device = deviceKeys();
  const result = await push.send({ endpoint: service.url(), ...device }, { title: 'Hola', body: 'Prueba' }, { ttl: 60 });
  assert.deepEqual(result, { ok: true, status: 201, gone: false });

  const [{ headers, body }] = service.got;
  assert.equal(headers['content-encoding'], 'aes128gcm');
  assert.equal(headers.ttl, '60');
  assert.equal(headers.urgency, 'normal');
  const [, jwt, key] = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(headers.authorization) || [];
  assert.equal(key, vapid.publicKey);
  const [head, claims, signature] = jwt.split('.');
  const publicKey = crypto.createPublicKey({
    key: {
      kty: 'EC', crv: 'P-256',
      x: Buffer.from(vapid.publicKey, 'base64url').subarray(1, 33).toString('base64url'),
      y: Buffer.from(vapid.publicKey, 'base64url').subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
  assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url')), 'the push service can check who sends');
  const said = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(said.aud, new URL(service.url()).origin);
  assert.equal(said.sub, 'mailto:ops@example.com');
  assert.ok(said.exp > Date.now() / 1000 && said.exp <= Date.now() / 1000 + 24 * 3600, 'expires within a day, as RFC 8292 asks');
  assert.deepEqual(JSON.parse(decryptPayload(body, device.d, device.p256dh, device.auth).toString()), { title: 'Hola', body: 'Prueba' });
});

test('delivering keeps the table clean: gone ones dropped, three refusals dropped, outages kept, good ones noted', async (t) => {
  const ok = await fakeService(t, 201);
  const gone = await fakeService(t, 410);
  const broken = await fakeService(t, 500);
  const refused = await fakeService(t, 403);
  const { database, accounts } = store();
  const ada = accounts.create({ username: 'ada', password: 'ada-password' });
  const push = createPush({ database, vapid: { ...generateVapidKeys(), subject: 'mailto:a@b.c' }, log: () => {} });
  const add = (endpoint, lang = null) => {
    const device = deviceKeys();
    database.run('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, lang) VALUES (?, ?, ?, ?, ?)',
      ada.id, endpoint, device.p256dh, device.auth, lang);
    return device;
  };
  const phone = add(ok.url('/phone'), 'es');
  add(gone.url('/old'));
  add(broken.url('/flaky'));
  add(refused.url('/wrong-keys'));

  const said = [];
  const result = await push.sendTo([ada.id], (sub) => {
    said.push(sub.lang);
    return { title: sub.lang === 'es' ? 'Hola' : 'Hello' };
  });
  assert.deepEqual(result, { sent: 1, gone: 1, failed: 2 });
  assert.equal(said.length, 4, 'the payload is asked per device');
  assert.equal(said.filter((lang) => lang === 'es').length, 1);
  assert.equal(JSON.parse(decryptPayload(ok.got[0].body, phone.d, phone.p256dh, phone.auth).toString()).title, 'Hola',
    'each device in its language');
  const rows = () => database.all('SELECT endpoint, failures, last_ok_at FROM push_subscriptions ORDER BY id');
  assert.deepEqual(rows().map((r) => r.endpoint), [ok.url('/phone'), broken.url('/flaky'), refused.url('/wrong-keys')], 'the gone one is dropped');
  assert.ok(rows()[0].last_ok_at, 'the good one is noted');
  await push.sendTo([ada.id], { title: 'x' });
  await push.sendTo([ada.id], { title: 'x' });
  // A service that is down says nothing about the device: counted, an outage of minutes dropped everyone's.
  assert.deepEqual(rows().map((r) => r.endpoint), [ok.url('/phone'), broken.url('/flaky')], 'three refusals in a row and it goes; an outage, never');
  assert.deepEqual(rows().map((r) => r.failures), [0, 0]);
  assert.deepEqual(await push.sendTo([], { title: 'x' }), { sent: 0, gone: 0, failed: 0 });
});

test('where a subscription may point: real push services, never inside the network', () => {
  const accepted = (url) => { try { checkEndpoint(url); return true; } catch { return false; } };
  for (const url of ['https://192.168.1.1/hook', 'https://169.254.169.254/latest/meta-data/', 'https://127.0.0.1/hook',
    'https://[::1]/hook', 'https://nas.local/hook', 'https://router.home.arpa/x', 'https://algo.example.com:8080/hook',
    'http://fcm.googleapis.com/hook', 'no-soy-una-url']) {
    assert.equal(accepted(url), false, url);
  }
  for (const url of ['https://fcm.googleapis.com/fcm/send/abc123', 'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QABC123', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
    assert.equal(accepted(url), true, url);
  }
  assert.throws(() => checkEndpoint('https://10.0.0.1/x'), { code: 'field_invalid', extra: { field: 'endpoint', reason: 'ip_address' } });
});

test('subscribing: one row per device, checked; the list never shows the keys', () => {
  const { database, accounts } = store();
  const ada = accounts.create({ username: 'ada', password: 'ada-password' });
  const push = createPush({ database, vapid: { ...generateVapidKeys(), subject: 'mailto:a@b.c' }, log: () => {} });
  const device = deviceKeys();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
  assert.equal(push.subscribe(ada.id, { endpoint, p256dh: device.p256dh, auth: device.auth, label: 'Móvil', lang: 'es' }), 1);
  assert.equal(push.subscribe(ada.id, { endpoint, p256dh: device.p256dh, auth: device.auth, label: 'Móvil' }), 1,
    'the same device again is the same row');
  assert.throws(() => push.subscribe(ada.id, { endpoint: 'https://192.168.1.1/x', p256dh: device.p256dh, auth: device.auth }),
    { code: 'field_invalid' });
  assert.throws(() => push.subscribe(ada.id, { endpoint, p256dh: 'short', auth: device.auth }), { extra: { field: 'p256dh' } });
  assert.throws(() => push.subscribe(ada.id, { endpoint, p256dh: device.p256dh, auth: 'x' }), { extra: { field: 'auth' } });
  const [listed] = push.devices(ada.id);
  assert.equal(listed.label, 'Móvil');
  assert.equal(listed.endpoint_hint, endpoint.slice(0, 40));
  assert.ok(!('p256dh' in listed) && !('auth' in listed) && !('endpoint' in listed));
  assert.equal(push.unsubscribe(ada.id, endpoint), 1);
  assert.deepEqual(push.devices(ada.id), []);
});

test('a key off the curve is refused, and one stored before does not stop the others’ notices', async (t) => {
  const ok = await fakeService(t, 201);
  const { database, accounts } = store();
  const ada = accounts.create({ username: 'ada', password: 'ada-password' });
  const push = createPush({ database, vapid: { ...generateVapidKeys(), subject: 'mailto:a@b.c' }, log: () => {} });
  const device = deviceKeys();
  // 0x04 and 64 bytes: the right length, but no point of P-256.
  const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
  assert.throws(() => push.subscribe(ada.id, { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: offCurve, auth: device.auth }),
    { extra: { field: 'p256dh' } });

  database.run('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)',
    ada.id, ok.url('/broken'), offCurve, device.auth);
  database.run('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)',
    ada.id, ok.url('/phone'), device.p256dh, device.auth);
  assert.deepEqual(await push.sendTo([ada.id], { title: 'x' }), { sent: 1, gone: 1, failed: 0 },
    'the good device gets it; the broken one is dropped instead of failing the whole send');
  assert.deepEqual(database.all('SELECT endpoint FROM push_subscriptions').map((r) => r.endpoint), [ok.url('/phone')]);
});

test('a person keeps at most MAX_DEVICES devices: the oldest go, never the newest', () => {
  const { database, accounts } = store();
  const ada = accounts.create({ username: 'ada', password: 'ada-password' });
  const push = createPush({ database, vapid: { ...generateVapidKeys(), subject: 'mailto:a@b.c' }, log: () => {} });
  const device = deviceKeys();
  const endpoint = (n) => `https://fcm.googleapis.com/fcm/send/device-${n}`;
  for (let n = 1; n <= MAX_DEVICES + 3; n++) {
    database.run("UPDATE push_subscriptions SET created_at = datetime(created_at, '-1 minute')");
    push.subscribe(ada.id, { endpoint: endpoint(n), p256dh: device.p256dh, auth: device.auth });
  }
  const kept = database.all('SELECT endpoint FROM push_subscriptions WHERE user_id = ?', ada.id).map((r) => r.endpoint);
  assert.equal(kept.length, MAX_DEVICES);
  assert.ok(kept.includes(endpoint(MAX_DEVICES + 3)), 'the one that just subscribed stays');
  assert.ok(!kept.includes(endpoint(1)) && !kept.includes(endpoint(3)), 'the three oldest went');
  // An old device subscribing again counts as recent: the next newcomer pushes out another one.
  const oldest = endpoint(4);
  database.run("UPDATE push_subscriptions SET created_at = datetime(created_at, '-1 minute')");
  push.subscribe(ada.id, { endpoint: oldest, p256dh: device.p256dh, auth: device.auth });
  database.run("UPDATE push_subscriptions SET created_at = datetime(created_at, '-1 minute')");
  push.subscribe(ada.id, { endpoint: endpoint(99), p256dh: device.p256dh, auth: device.auth });
  assert.ok(database.get('SELECT 1 AS x FROM push_subscriptions WHERE endpoint = ?', oldest), 'the one subscribed again stays');
  assert.ok(!database.get('SELECT 1 AS x FROM push_subscriptions WHERE endpoint = ?', endpoint(5)), 'the next oldest went');
  // One that keeps working counts as used, however long ago it subscribed.
  database.run("UPDATE push_subscriptions SET last_ok_at = datetime('now', '+1 minute') WHERE endpoint = ?", endpoint(6));
  database.run("UPDATE push_subscriptions SET created_at = datetime(created_at, '-1 minute')");
  push.subscribe(ada.id, { endpoint: endpoint(100), p256dh: device.p256dh, auth: device.auth });
  assert.ok(database.get('SELECT 1 AS x FROM push_subscriptions WHERE endpoint = ?', endpoint(6)));
});

test('a notice that can’t be written is the app’s mistake: nobody loses a device for it', async (t) => {
  const ok = await fakeService(t, 201);
  const { database, accounts } = store();
  const ada = accounts.create({ username: 'ada', password: 'ada-password' });
  const push = createPush({ database, vapid: { ...generateVapidKeys(), subject: 'mailto:a@b.c' }, log: () => {} });
  const device = deviceKeys();
  database.run('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)',
    ada.id, ok.url('/phone'), device.p256dh, device.auth);
  assert.deepEqual(await push.sendTo([ada.id], { n: 1n }), { sent: 0, gone: 0, failed: 1 });
  assert.deepEqual(await push.sendTo([ada.id], () => undefined), { sent: 0, gone: 0, failed: 1 });
  assert.equal(database.all('SELECT 1 FROM push_subscriptions').length, 1);
});

test('a push service that redirects or never answers: a failure, not a request elsewhere', async (t) => {
  const seen = [];
  const fetch = async (url, options) => {
    seen.push(options);
    if (url.endsWith('/slow')) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    throw new TypeError('fetch failed: redirect mode is set to error');
  };
  const { database, accounts } = store();
  const ada = accounts.create({ username: 'ada', password: 'ada-password' });
  const push = createPush({ database, vapid: { ...generateVapidKeys(), subject: 'mailto:a@b.c' }, fetch, log: () => {} });
  const device = deviceKeys();
  for (const p of ['/moved', '/slow']) {
    database.run('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)',
      ada.id, `https://push.example${p}`, device.p256dh, device.auth);
  }
  assert.deepEqual(await push.sendTo([ada.id], { title: 'x' }), { sent: 0, gone: 0, failed: 2 });
  assert.ok(seen.every((o) => o.redirect === 'error'), 'redirects are never followed');
  assert.ok(seen.every((o) => o.signal instanceof AbortSignal), 'every send has a time limit');
});

async function start(t, modules, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-push-'));
  const suite = createSuite({
    config: { app: { id: 'demo', name: 'Demo', languages: ['en', 'es'] }, modules, accounts: { minPasswordLength: 8 } },
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', SECURE_COOKIES: 'false', ADMIN_PASSWORD: 'root-password', ...env },
    log: () => {}, exitOnError: false,
  });
  const app = createApp({ suite, handleSignals: false, log: () => {} });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = () => {
    let cookie = '';
    return async (method, pathname, body) => {
      const res = await fetch(base + pathname, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('demo_sid='));
      if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    };
  };
  return { suite, browser, base };
}

test('over HTTP: /api/push/* with modules.push', async (t) => {
  const { suite, browser } = await start(t, { push: true });
  const ada = suite.accounts.create({ username: 'ada', password: 'ada-password', locale: 'es' });
  const phone = browser();
  assert.equal((await phone('GET', '/api/push/config')).status, 401);
  await phone('POST', '/api/auth/login', { username: 'ada', password: 'ada-password' });

  const config = (await phone('GET', '/api/push/config')).data;
  assert.equal(config.enabled, true);
  assert.equal(config.public_key, JSON.parse(suite.database.getMeta('vapid_keys')).publicKey, 'the keys generated on start');

  const device = deviceKeys();
  const subscribed = await phone('POST', '/api/push/subscribe', {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: device.p256dh, auth: device.auth }, label: 'Móvil', lang: 'es',
  });
  assert.deepEqual([subscribed.status, subscribed.data], [201, { ok: true, devices: 1 }]);
  const refused = await phone('POST', '/api/push/subscribe', { endpoint: 'https://192.168.1.1/hook/x/y/z', p256dh: device.p256dh, auth: device.auth });
  assert.deepEqual([refused.status, refused.data.error, refused.data.field], [400, 'field_invalid', 'endpoint']);
  assert.equal((await phone('GET', '/api/push/devices')).data[0].label, 'Móvil');

  // The test notice, to a device whose push service is on this machine (https is required to subscribe).
  const service = await fakeService(t);
  const other = deviceKeys();
  suite.database.run('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, lang) VALUES (?, ?, ?, ?, ?)',
    ada.id, service.url('/laptop'), other.p256dh, other.auth, 'en');
  suite.database.run('DELETE FROM push_subscriptions WHERE endpoint LIKE ?', 'https://fcm.googleapis.com/%');
  const tested = await phone('POST', '/api/push/test');
  assert.deepEqual(tested.data, { sent: 1, gone: 0, failed: 0 });
  const notice = JSON.parse(decryptPayload(service.got[0].body, other.d, other.p256dh, other.auth).toString());
  assert.deepEqual(notice, { title: '✅ Demo', body: 'Los avisos funcionan. Este es un mensaje de prueba.', tag: 'test' },
    'in the person’s language');

  await phone('DELETE', '/api/push/subscribe');
  assert.deepEqual((await phone('GET', '/api/push/devices')).data, []);
  assert.deepEqual((await phone('POST', '/api/push/test')).data, { sent: 0, gone: 0, failed: 0, no_devices: true });
});

test('over HTTP: without modules.push the app keeps /api/push/* for itself, and no keys are made', async (t) => {
  const { suite, browser } = await start(t, {});
  assert.equal((await browser()('GET', '/api/push/config')).status, 404);
  assert.equal(suite.push, null);
  assert.equal(suite.database.getMeta('vapid_keys'), null);
});
