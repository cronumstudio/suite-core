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
  generateVapidKeys, vapidKeyErrors, vapidKeys, encryptPayload, decryptPayload, checkEndpoint, checkSubscription, createPush,
  MAX_DEVICES, MAX_PAYLOAD,
} from '../push.js';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { createAccounts } from '../accounts.js';
import { resolveConfig } from '../config.js';
import { createSuite, createApp } from '../app.js';
import { readJson, sendJson } from '../http.js';

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

/** A push service on this machine that answers `status` (or `status(req)`) and keeps what it got. */
async function fakeService(t, status = 201) {
  const got = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(typeof status === 'function' ? status(req) : status).end();
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
    'http://fcm.googleapis.com/hook', 'no-soy-una-url',
    // A public-looking name is no push service, and DNS can point it anywhere.
    'https://algo.example.com/hook', 'https://fcm.googleapis.com.evil.example/x']) {
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

/* ------------------- a device the app keeps, with no user behind it ------------------- */

/** A browser's subscription made the way a browser makes it: an ECDH P-256 pair and a 16-byte auth secret. */
function browserSubscription(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const authSecret = crypto.randomBytes(16);
  return {
    ecdh, authSecret,
    json: {
      endpoint, expirationTime: null,
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') },
    },
  };
}

/**
 * What the browser does with the body (RFC 8291 §3.4 over RFC 8188 §2), with
 * HKDF written out as HMACs (RFC 5869) instead of push.js' decryptPayload: a
 * mistake shared by both sides of one module would pass a test that used it.
 */
function readAsTheBrowser(body, { ecdh, authSecret }) {
  const hmac = (key, ...parts) => crypto.createHmac('sha256', key).update(Buffer.concat(parts)).digest();
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const uaPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(asPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])).subarray(0, 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  return { recordSize, idlen, delimiter: plain[end], text: plain.subarray(0, end).toString('utf8') };
}

/**
 * The endpoint must be a real push service's (checked before anything is
 * sent), so the test's fetch carries each request, untouched, to the fake one
 * on this machine, and notes where it was asked to go.
 */
function throughFake(service) {
  const asked = [];
  const fetch = (url, options) => {
    asked.push(url);
    return globalThis.fetch(service.url(new URL(url).pathname), options);
  };
  return { asked, fetch };
}

test('a device the app keeps, with no user: the notice is signed with VAPID, only it can read it, nothing is kept here', async (t) => {
  const service = await fakeService(t, 201);
  const { asked, fetch } = throughFake(service);
  const vapid = { ...generateVapidKeys(), subject: 'mailto:ops@example.com' };
  const { database } = store();
  const push = createPush({ database, vapid, fetch, log: () => {} });
  assert.equal(push.publicKey, vapid.publicKey, 'what the browser subscribes with');
  assert.equal(database.get('SELECT COUNT(*) AS n FROM users').n, 0, 'nobody has an account');

  const tablet = browserSubscription('https://fcm.googleapis.com/fcm/send/tablet-leo');
  const kept = push.checkSubscription(tablet.json);
  assert.deepEqual(kept, { endpoint: tablet.json.endpoint, keys: tablet.json.keys }, 'the browser’s shape, without what is not needed');

  const launch = { title: 'Morning', body: 'Leo, time to start', url: '/?launch=7', tag: 'launch-7' };
  const result = await push.sendToSubscription(kept, launch, { ttl: 120, urgency: 'high', topic: 'launch-7' });
  assert.deepEqual(result, { ok: true, status: 201, gone: false });
  assert.deepEqual(asked, [tablet.json.endpoint], 'posted to the device’s endpoint, once');

  const [{ url, headers, body }] = service.got;
  assert.equal(url, '/fcm/send/tablet-leo');
  assert.equal(headers['content-encoding'], 'aes128gcm');
  assert.equal(headers['content-type'], 'application/octet-stream');
  assert.equal(headers.ttl, '120');
  assert.equal(headers.urgency, 'high');
  assert.equal(headers.topic, 'launch-7');

  // RFC 8292: `vapid t=<ES256 JWT>, k=<the public key>`, the JWT for the push service's origin.
  const [, jwt, key] = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(headers.authorization) || [];
  assert.equal(key, vapid.publicKey);
  const [head, claims, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const point = Buffer.from(vapid.publicKey, 'base64url');
  const verifier = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') },
    format: 'jwk',
  });
  assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: verifier, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url')), 'signed with the install’s VAPID key');
  const said = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(said.aud, 'https://fcm.googleapis.com', 'the audience is the push service’s origin');
  assert.equal(said.sub, 'mailto:ops@example.com');
  assert.ok(said.exp > Date.now() / 1000 && said.exp <= Date.now() / 1000 + 24 * 3600);

  const read = readAsTheBrowser(body, tablet);
  assert.equal(read.recordSize, 4096);
  assert.equal(read.idlen, 65, 'the sender’s ephemeral key, uncompressed');
  assert.equal(read.delimiter, 2, 'one record, the last');
  assert.deepEqual(JSON.parse(read.text), launch);
  const stranger = browserSubscription(tablet.json.endpoint);
  assert.throws(() => readAsTheBrowser(body, { ecdh: stranger.ecdh, authSecret: tablet.authSecret }), 'no other device can read it');

  // Without options, a person's defaults; a row's flat shape is taken too.
  const flat = await push.sendToSubscription({ endpoint: kept.endpoint, ...kept.keys }, 'plain text');
  assert.deepEqual(flat, { ok: true, status: 201, gone: false });
  assert.equal(service.got[1].headers.ttl, '3600');
  assert.equal(service.got[1].headers.urgency, 'normal');
  assert.equal(service.got[1].headers.topic, undefined, 'no topic unless asked');
  assert.equal(readAsTheBrowser(service.got[1].body, tablet).text, 'plain text');

  assert.equal(database.get('SELECT COUNT(*) AS n FROM push_subscriptions').n, 0, 'the app’s table holds it, not the suite’s');
});

test('what the push service answers about an app’s device: 404 and 410 are gone, nothing else is', async (t) => {
  const statuses = { '/gone': 410, '/unknown': 404, '/down': 500, '/busy': 429, '/refused': 400, '/ok': 201 };
  const service = await fakeService(t, (req) => statuses[new URL(req.url, 'http://x').pathname.replace('/fcm/send', '')]);
  const { fetch } = throughFake(service);
  const push = createPush({ database: store().database, vapid: { ...generateVapidKeys(), subject: 'mailto:a@b.c' }, fetch, log: () => {} });
  const tablet = browserSubscription('https://fcm.googleapis.com/fcm/send/x');
  const to = (name) => push.sendToSubscription({ ...tablet.json, endpoint: `https://fcm.googleapis.com/fcm/send${name}` }, { title: 'x' });
  assert.deepEqual(await to('/gone'), { ok: false, status: 410, gone: true }, 'the app drops it');
  assert.deepEqual(await to('/unknown'), { ok: false, status: 404, gone: true });
  assert.deepEqual(await to('/down'), { ok: false, status: 500, gone: false }, 'an outage is not the device’s');
  assert.deepEqual(await to('/busy'), { ok: false, status: 429, gone: false });
  assert.deepEqual(await to('/refused'), { ok: false, status: 400, gone: false }, 'a refusal, for the app to count: not gone at once');
  assert.deepEqual(await to('/ok'), { ok: true, status: 201, gone: false });

  const offline = createPush({
    database: store().database, vapid: { ...generateVapidKeys(), subject: 'mailto:a@b.c' }, log: () => {},
    fetch: async () => { throw new TypeError('fetch failed'); },
  });
  assert.deepEqual(await offline.sendToSubscription(tablet.json, { title: 'x' }), { ok: false, status: 0, gone: false, reason: 'fetch failed' });
});

test('what is not an app’s subscription is refused with a code, and nothing is sent', async (t) => {
  const service = await fakeService(t, 201);
  const { asked, fetch } = throughFake(service);
  const push = createPush({ database: store().database, vapid: { ...generateVapidKeys(), subject: 'mailto:a@b.c' }, fetch, log: () => {} });
  const { json } = browserSubscription('https://fcm.googleapis.com/fcm/send/tablet');
  const { keys } = json;
  const refused = async (subscription, extra, code = 'field_invalid') => {
    const expected = { status: 400, code, extra };
    assert.throws(() => push.checkSubscription(subscription), expected, JSON.stringify(subscription)?.slice(0, 80));
    await assert.rejects(push.sendToSubscription(subscription, { title: 'x' }), expected);
  };
  await refused(null, { field: 'subscription' }, 'field_required');
  await refused(undefined, { field: 'subscription' }, 'field_required');
  await refused(json.endpoint, { field: 'subscription' });
  await refused([json], { field: 'subscription' });
  await refused({ keys }, { field: 'endpoint' }, 'field_required');
  await refused({ endpoint: '', keys }, { field: 'endpoint' }, 'field_required');
  await refused({ endpoint: 42, keys }, { field: 'endpoint', reason: 'not_a_url' });
  await refused({ endpoint: 'not a url', keys }, { field: 'endpoint', reason: 'not_a_url' });
  await refused({ endpoint: 'http://fcm.googleapis.com/fcm/send/x', keys }, { field: 'endpoint', reason: 'not_https' });
  await refused({ endpoint: 'https://127.0.0.1/hook', keys }, { field: 'endpoint', reason: 'ip_address' });
  await refused({ endpoint: 'https://kiosk.local/hook', keys }, { field: 'endpoint', reason: 'local_name' });
  await refused({ endpoint: 'https://push.example.com/hook', keys }, { field: 'endpoint', reason: 'push_service' });
  await refused({ endpoint: `https://fcm.googleapis.com/fcm/send/${'a'.repeat(1000)}`, keys }, { field: 'endpoint', max: 1000 }, 'field_too_long');
  await refused({ endpoint: json.endpoint }, { field: 'p256dh' });
  await refused({ endpoint: json.endpoint, keys: { ...keys, p256dh: 'short' } }, { field: 'p256dh' });
  // 65 bytes that don't start with 0x04 are no uncompressed point, and that byte goes into the keys.
  const compressedMark = Buffer.from(keys.p256dh, 'base64url');
  compressedMark[0] = 2;
  await refused({ endpoint: json.endpoint, keys: { ...keys, p256dh: compressedMark.toString('base64url') } }, { field: 'p256dh' });
  // The auth secret is 16 bytes (RFC 8291 §3.2), no more and no less.
  for (const size of [0, 8, 15, 17, 1 << 20]) {
    await refused({ endpoint: json.endpoint, keys: { ...keys, auth: crypto.randomBytes(size).toString('base64url') } }, { field: 'auth' });
  }
  await refused({ endpoint: json.endpoint, keys: { ...keys, auth: 42 } }, { field: 'auth' });
  assert.deepEqual([asked, service.got], [[], []], 'nothing went anywhere');

  // A key off the curve has the right size: refused before keeping it, gone if it was kept anyway.
  const offCurve = { endpoint: json.endpoint, keys: { ...keys, p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url') } };
  assert.throws(() => push.checkSubscription(offCurve), { code: 'field_invalid', extra: { field: 'p256dh' } });
  const result = await push.sendToSubscription(offCurve, { title: 'x' });
  assert.deepEqual([result.ok, result.status, result.gone], [false, 0, true], 'no message will ever reach it: the app drops it');
  assert.deepEqual(asked, []);

  // A topic is the app's to write right (RFC 8030): its mistake, not the device's.
  for (const topic of ['', 'x'.repeat(33), 'with space', 'acentuación', 'a+b', 'a/b', 'abc=']) {
    await assert.rejects(push.sendToSubscription(json, { title: 'x' }, { topic }), TypeError, JSON.stringify(topic));
  }
  assert.deepEqual(asked, []);

  // So is a notice too long for any push service: refused before it is encrypted or sent.
  await assert.rejects(push.sendToSubscription(json, 'x'.repeat(MAX_PAYLOAD + 1)), /push payload: 3994 bytes/);
  assert.deepEqual(asked, []);

  // What is kept is plain base64url: padding, the other alphabet or a stray line break don't reach the table.
  const standard = (text) => Buffer.from(text, 'base64url').toString('base64');
  const messy = { endpoint: json.endpoint, keys: { p256dh: `${keys.p256dh.slice(0, 40)}\n${keys.p256dh.slice(40)}=`, auth: standard(keys.auth) } };
  assert.ok(messy.keys.auth.endsWith('=='), 'the test sends padding');
  assert.deepEqual(push.checkSubscription(messy), { endpoint: json.endpoint, keys });
  // The check is the module's too, for an app that checks before it has a push service.
  assert.deepEqual(checkSubscription(json), { endpoint: json.endpoint, keys });
});

test('a notice as long as a push service takes is sent whole; one longer costs nobody a device', async (t) => {
  const service = await fakeService(t, 201);
  const { asked, fetch } = throughFake(service);
  const { database, accounts } = store();
  const ada = accounts.create({ username: 'ada', password: 'ada-password' });
  const push = createPush({ database, vapid: { ...generateVapidKeys(), subject: 'mailto:a@b.c' }, fetch, log: () => {} });
  const tablet = browserSubscription('https://fcm.googleapis.com/fcm/send/tablet');
  const longest = 'x'.repeat(MAX_PAYLOAD);
  assert.deepEqual(await push.sendToSubscription(tablet.json, longest), { ok: true, status: 201, gone: false });
  assert.equal(service.got[0].body.length, 4096, 'the 4096 bytes every push service takes (RFC 8030 §7.2)');
  assert.equal(readAsTheBrowser(service.got[0].body, tablet).text, longest);

  // A person's device: the notice fails, and the device keeps its place and its count.
  push.subscribe(ada.id, { endpoint: tablet.json.endpoint, ...tablet.json.keys });
  assert.deepEqual(await push.sendTo([ada.id], { body: 'x'.repeat(MAX_PAYLOAD) }), { sent: 0, gone: 0, failed: 1 });
  assert.deepEqual(database.all('SELECT failures FROM push_subscriptions').map((r) => r.failures), [0]);
  assert.equal(asked.length, 1, 'only the first one went out');

  // A topic written wrong is said once, for everyone, and nobody is sent anything.
  await assert.rejects(push.sendTo([ada.id], { title: 'x' }, { topic: 'a b' }), TypeError);
  await assert.rejects(push.deliver(push.subscriptionsOf([ada.id]), { title: 'x' }, { topic: '' }), TypeError);
  assert.equal(asked.length, 1);
  assert.deepEqual(await push.sendTo([ada.id], { title: 'x' }, { topic: 'list-7' }), { sent: 1, gone: 0, failed: 0 });
  assert.equal(service.got[1].headers.topic, 'list-7', 'a good one goes with every notice');
});

test('a person’s subscription stored before the keys were checked so closely still gets its notices', async (t) => {
  const service = await fakeService(t, 201);
  const { fetch } = throughFake(service);
  const { database, accounts } = store();
  const ada = accounts.create({ username: 'ada', password: 'ada-password' });
  const push = createPush({ database, vapid: { ...generateVapidKeys(), subject: 'mailto:a@b.c' }, fetch, log: () => {} });
  // Before 0.81.0 subscribe() took a secret of 8 bytes or more and kept the keys as they came.
  const device = deviceKeys();
  const shortSecret = crypto.randomBytes(12).toString('base64url');
  const endpoint = 'https://fcm.googleapis.com/fcm/send/old-phone';
  database.run('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)',
    ada.id, endpoint, `${device.p256dh}=`, shortSecret);
  assert.deepEqual(await push.sendTo([ada.id], { title: 'Still here' }), { sent: 1, gone: 0, failed: 0 });
  assert.equal(JSON.parse(decryptPayload(service.got[0].body, device.d, device.p256dh, shortSecret).toString()).title, 'Still here');
  // Subscribing anew is checked as a browser makes keys: 16 bytes, kept in plain base64url.
  assert.throws(() => push.subscribe(ada.id, { endpoint, p256dh: device.p256dh, auth: shortSecret }), { extra: { field: 'auth' } });
  const padded = Buffer.from(device.auth, 'base64url').toString('base64');
  push.subscribe(ada.id, { endpoint, p256dh: `${device.p256dh}=`, auth: padded });
  assert.deepEqual({ ...database.get('SELECT p256dh, auth FROM push_subscriptions WHERE endpoint = ?', endpoint) },
    { p256dh: device.p256dh, auth: device.auth });
});

async function start(t, modules, env = {}, appOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-push-'));
  const suite = createSuite({
    config: { app: { id: 'demo', name: 'Demo', languages: ['en', 'es'] }, modules, accounts: { minPasswordLength: 8 } },
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', SECURE_COOKIES: 'false', ADMIN_PASSWORD: 'root-password', ...env },
    log: () => {}, exitOnError: false,
  });
  const app = createApp({ suite, handleSignals: false, log: () => {}, ...(typeof appOptions === 'function' ? appOptions(suite) : appOptions) });
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

test('over HTTP: signing out forgets this browser’s notices, only its own and only this person’s', async (t) => {
  for (const modules of [{ push: true }, {}]) {
    // Without modules.push too: in a host, a module that sends none (Notes) signs out of the host's table.
    const { suite, browser } = await start(t, modules);
    const ada = suite.accounts.create({ username: 'ada', password: 'ada-password' });
    const bob = suite.accounts.create({ username: 'bob', password: 'bob-password' });
    const device = deviceKeys();
    const row = (user, endpoint) => suite.database.run(
      'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)', user.id, endpoint, device.p256dh, device.auth);
    const LAPTOP = 'https://fcm.googleapis.com/fcm/send/shared-laptop';
    const PHONE = 'https://fcm.googleapis.com/fcm/send/ada-phone';
    const BOBS = 'https://fcm.googleapis.com/fcm/send/bob-tablet';
    row(ada, LAPTOP);
    row(ada, PHONE);
    row(bob, BOBS);
    const endpoints = () => suite.database.all('SELECT endpoint FROM push_subscriptions ORDER BY endpoint').map((r) => r.endpoint);

    const laptop = browser();
    await laptop('POST', '/api/auth/login', { username: 'ada', password: 'ada-password' });
    const out = await laptop('POST', '/api/auth/logout', { push_endpoints: [LAPTOP, BOBS, 42] });
    assert.deepEqual([out.status, out.data.ok], [200, true]);
    assert.deepEqual(endpoints(), [PHONE, BOBS].sort(), 'the laptop’s gone; her phone and Bob’s tablet stay');
    assert.equal((await laptop('GET', '/api/auth/me')).data.user, null, 'and the session with it');

    // Without the addresses, or without a session, signing out is as before.
    const again = browser();
    await again('POST', '/api/auth/login', { username: 'ada', password: 'ada-password' });
    assert.equal((await again('POST', '/api/auth/logout')).status, 200);
    assert.equal((await browser()('POST', '/api/auth/logout', { push_endpoints: [PHONE] })).status, 200);
    assert.deepEqual(endpoints(), [PHONE, BOBS].sort());
  }
});

test('over HTTP: without modules.push the app keeps /api/push/* for itself, and no keys are made', async (t) => {
  const { suite, browser } = await start(t, {});
  assert.equal((await browser()('GET', '/api/push/config')).status, 404);
  assert.equal(suite.push, null);
  assert.equal(suite.database.getMeta('vapid_keys'), null);
});

test('over HTTP: an app’s own route keeps a device’s subscription with no session, checked by the suite', async (t) => {
  const kept = new Map();
  const { suite, browser } = await start(t, { push: true }, {}, (s) => ({
    routes: (api) => {
      // The app's route and its storage (Focus: its paired device, by its own token); the suite only checks.
      api.post('/api/demo/devices/:id/push', async (ctx) => {
        const body = await readJson(ctx.req);
        kept.set(ctx.params.id, s.push.checkSubscription(body.subscription));
        sendJson(ctx.res, 201, { ok: true });
      });
    },
  }));
  assert.equal(suite.push.publicKey, JSON.parse(suite.database.getMeta('vapid_keys')).publicKey, 'the key the device subscribes with');
  const tablet = browser();
  const { json } = browserSubscription('https://web.push.apple.com/QTablet123');
  const refused = await tablet('POST', '/api/demo/devices/7/push', { subscription: { ...json, endpoint: 'https://192.168.1.10/hook' } });
  assert.deepEqual([refused.status, refused.data], [400, { error: 'field_invalid', field: 'endpoint', reason: 'ip_address' }]);
  const missing = await tablet('POST', '/api/demo/devices/7/push', {});
  assert.deepEqual([missing.status, missing.data], [400, { error: 'field_required', field: 'subscription' }]);
  const saved = await tablet('POST', '/api/demo/devices/7/push', { subscription: json });
  assert.equal(saved.status, 201);
  assert.deepEqual(kept.get('7'), { endpoint: json.endpoint, keys: json.keys });
  assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM push_subscriptions').n, 0, 'the suite keeps nothing of it');
  assert.equal(typeof suite.push.sendToSubscription, 'function');
});
