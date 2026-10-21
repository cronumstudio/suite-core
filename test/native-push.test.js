/**
 * Native push (native-push.js): the credentials, the table and what takes its
 * rows away, the provider tokens (APNs' ES256, Google's RS256), what is sent to
 * Apple over HTTP/2 and to FCM, what each answer does to a token, the same
 * sends as Web Push reaching the phones (push.js, host-worker.js), and the
 * routes with `push.native`. A fake HTTP/2 server stands in for Apple and a
 * fake fetch for Google.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http2 from 'node:http2';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  nativePushFromEnv, noticeOf, apnsPayload, apnsHeaders, fcmMessage, createApnsSender, createFcmSender,
  createNativePush, apnsOutcome, fcmOutcome, APNS_MAX_PAYLOAD, FCM_MAX_PAYLOAD, APNS_PRODUCTION, APNS_SANDBOX, GOOGLE_OAUTH,
} from '../native-push.js';
import { createPush, generateVapidKeys } from '../push.js';
import { hostedPush } from '../host-worker.js';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { createAccounts } from '../accounts.js';
import { createDevices } from '../devices.js';
import { resolveConfig } from '../config.js';
import { createSuite, createApp } from '../app.js';
import { randomToken, sha256 } from '../crypto.js';

const BACK = 'com.cronumstudio.work:/auth';
const APNS_KEY = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const APNS_PEM = APNS_KEY.privateKey.export({ format: 'pem', type: 'pkcs8' });
const RSA_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const RSA_PEM = RSA_KEY.privateKey.export({ format: 'pem', type: 'pkcs8' });
const SERVICE_ACCOUNT = {
  type: 'service_account', project_id: 'cronum-work', client_email: 'push@cronum-work.iam.gserviceaccount.com', private_key: RSA_PEM,
};
const IOS_TOKEN = 'a'.repeat(64);
const ANDROID_TOKEN = `fcm-token:${'b'.repeat(140)}`;

const part = (jwt, i) => JSON.parse(Buffer.from(jwt.split('.')[i], 'base64url').toString('utf8'));
const verifies = (jwt, key, options = {}) => {
  const [h, c, s] = jwt.split('.');
  return crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, ...options }, Buffer.from(s, 'base64url'));
};

/** A database with two people, one phone each, connected as the app does it. */
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-native-push-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const now = { ms: Date.parse('2026-10-21T08:00:00.000Z') };
  const clock = () => now.ms;
  const accounts = createAccounts({ database, clock });
  const devices = createDevices({ database, prefix: 'workdev_', redirectUris: [BACK], clock });
  const ana = accounts.create({ username: 'ana', displayName: 'Ana' });
  const bea = accounts.create({ username: 'bea', displayName: 'Bea' });
  const connect = (user, platform = 'ios') => {
    const verifier = randomToken(32);
    const issued = devices.issueCode(user, { codeChallenge: sha256(verifier), redirectUri: BACK, name: 'Phone', platform });
    return devices.exchange({ code: issued.code, verifier, redirectUri: BACK });
  };
  return { database, accounts, devices, ana, bea, now, clock, connect };
}

/** Senders that answer what the test says and keep what they were asked. */
function fakeSenders(answers = {}) {
  const sent = [];
  const next = (platform) => {
    const answer = answers[platform];
    return typeof answer === 'function' ? answer() : answer;
  };
  return {
    sent,
    senders: {
      apns: { send: async (target, notice, options) => { sent.push({ platform: 'ios', target, notice, options }); return next('ios') ?? { status: 200 }; }, close() {} },
      fcm: { send: async (target, notice, options) => { sent.push({ platform: 'android', target, notice, options }); return next('android') ?? { status: 200 }; }, close() {} },
    },
  };
}

/* ------------------------------ configuration ----------------------------- */

test('the configuration: off by default and nothing read; on, it needs push and devices', () => {
  const app = { id: 'work', name: 'Work' };
  const off = resolveConfig({ app, modules: { push: true } }, { APNS_KEY_ID: 'junk', FCM_SERVICE_ACCOUNT: 'junk' });
  assert.deepEqual(off.errors, []);
  assert.deepEqual(off.push, { native: false, apnsTopic: null, androidChannel: 'default' });
  assert.equal('nativePush' in off.install, false, 'with the option off, the credentials are not even read');
  assert.equal(off.warnings.some((w) => w.includes('push.native')), false);

  const base = { app, modules: { push: true, devices: true }, devices: { prefix: 'workdev_', redirectUris: [BACK] } };
  assert.deepEqual(resolveConfig({ ...base, modules: { devices: true }, push: { native: true } }, {}).errors,
    ['push.native needs modules.push: native notices are the same sends as Web Push']);
  assert.deepEqual(resolveConfig({ ...base, modules: { push: true }, devices: undefined, push: { native: true } }, {}).errors,
    ['push.native needs modules.devices: a phone registers its token with its device token']);
  assert.deepEqual(resolveConfig({ ...base, push: { native: 'yes', nativ: true } }, {}).errors, [
    'push.nativ is not a setting (a typo?)', 'push.native must be true or false',
  ]);
  assert.deepEqual(resolveConfig({ ...base, push: { apnsTopic: 'not a bundle', androidChannel: '' } }, {}).errors, [
    'push.apnsTopic: the app’s bundle id, such as com.example.app',
    'push.androidChannel: the id of the Android notification channel the app creates, such as default',
  ]);
  assert.deepEqual(resolveConfig({ ...base, push: 'on' }, {}).errors, ["push: an object, such as { native: true, apnsTopic: 'com.example.app' }"]);
});

test('the credentials: missing ones are said by name only, and that platform is off', () => {
  const base = {
    app: { id: 'work', name: 'Work' }, modules: { push: true, devices: true },
    devices: { prefix: 'workdev_', redirectUris: [BACK] }, push: { native: true },
  };
  const none = resolveConfig(base, {});
  assert.deepEqual(none.errors, []);
  assert.deepEqual(none.install.nativePush, { apns: null, fcm: null });
  assert.ok(none.warnings.includes('push.native: notices for iPhones are off, these are missing: APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY, APNS_TOPIC'));
  assert.ok(none.warnings.includes('push.native: notices for Android phones are off, this is missing: FCM_SERVICE_ACCOUNT'));

  const half = resolveConfig({ ...base, push: { native: true, apnsTopic: 'com.cronumstudio.work' } }, { APNS_KEY_ID: 'ABCDE12345', APNS_PRIVATE_KEY: APNS_PEM });
  assert.deepEqual(half.errors, []);
  assert.equal(half.install.nativePush.apns, null);
  const said = half.warnings.find((w) => w.includes('iPhones'));
  assert.equal(said, 'push.native: notices for iPhones are off, these are missing: APNS_TEAM_ID');
  assert.equal(said.includes('BEGIN'), false, 'never a value');

  // In one line of an .env, as panels keep it: \n for its line breaks.
  const env = {
    APNS_KEY_ID: 'ABCDE12345', APNS_TEAM_ID: 'TEAM123456', APNS_PRIVATE_KEY: APNS_PEM.replace(/\n/g, '\\n'),
    APNS_TOPIC: 'com.cronumstudio.work', FCM_SERVICE_ACCOUNT: JSON.stringify(SERVICE_ACCOUNT),
  };
  const all = resolveConfig(base, env);
  assert.deepEqual(all.errors, []);
  assert.equal(all.warnings.some((w) => w.includes('push.native')), false);
  assert.equal(all.install.nativePush.apns.topic, 'com.cronumstudio.work');
  assert.equal(all.install.nativePush.apns.privateKey.trim(), APNS_PEM.trim());
  assert.deepEqual({ ...all.install.nativePush.fcm, privateKey: '…' }, {
    projectId: 'cronum-work', clientEmail: SERVICE_ACCOUNT.client_email, privateKey: '…',
  });
  // The service account in base64, for a panel that takes one line only.
  assert.equal(resolveConfig(base, { FCM_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(SERVICE_ACCOUNT)).toString('base64') }).install.nativePush.fcm.projectId, 'cronum-work');
});

test('the credentials: a value that can’t be used turns its platform off, named, never stopping the start', () => {
  const problemsOf = (env) => {
    const { problems } = nativePushFromEnv(env, { topic: 'com.cronumstudio.work' });
    return [...problems.apns, ...problems.fcm];
  };
  const good = { APNS_KEY_ID: 'ABCDE12345', APNS_TEAM_ID: 'TEAM123456', APNS_PRIVATE_KEY: APNS_PEM };
  assert.deepEqual(problemsOf(good), []);
  assert.deepEqual(problemsOf({ ...good, APNS_KEY_ID: 'abc' }), ['APNS_KEY_ID is not an APNs key id (10 letters and digits, from the key in Apple Developer)']);
  assert.deepEqual(problemsOf({ ...good, APNS_TEAM_ID: 'team' }), ['APNS_TEAM_ID is not an Apple team id (10 letters and digits)']);
  assert.match(problemsOf({ ...good, APNS_PRIVATE_KEY: 'not a key' })[0], /^APNS_PRIVATE_KEY is not the \.p8 key/);
  assert.match(problemsOf({ ...good, APNS_PRIVATE_KEY: RSA_PEM })[0], /^APNS_PRIVATE_KEY/, 'an RSA key is not Apple’s');
  assert.deepEqual(problemsOf({ ...good, APNS_TOPIC: 'nodots' }), ['APNS_TOPIC (or push.apnsTopic) is not a bundle id, such as com.example.app']);
  assert.equal(nativePushFromEnv({ ...good, APNS_KEY_ID: 'abc' }, { topic: 'com.cronumstudio.work' }).apns, null);
  assert.deepEqual(problemsOf({ FCM_SERVICE_ACCOUNT: '{nope' }), ['FCM_SERVICE_ACCOUNT is not JSON (the service account key file from Firebase, or it in base64)']);
  assert.deepEqual(problemsOf({ FCM_SERVICE_ACCOUNT: JSON.stringify({ ...SERVICE_ACCOUNT, project_id: undefined }) }), ['FCM_SERVICE_ACCOUNT has no project_id']);
  assert.deepEqual(problemsOf({ FCM_SERVICE_ACCOUNT: JSON.stringify({ ...SERVICE_ACCOUNT, client_email: 'x' }) }), ['FCM_SERVICE_ACCOUNT has no client_email']);
  assert.deepEqual(problemsOf({ FCM_SERVICE_ACCOUNT: JSON.stringify({ ...SERVICE_ACCOUNT, private_key: APNS_PEM }) }), ['FCM_SERVICE_ACCOUNT: its private_key is not an RSA private key in PEM']);

  const config = resolveConfig({
    app: { id: 'work', name: 'Work' }, modules: { push: true, devices: true },
    devices: { prefix: 'workdev_', redirectUris: [BACK] }, push: { native: true },
  }, { ...good, APNS_TOPIC: 'com.cronumstudio.work', APNS_PRIVATE_KEY: 'secret-typo-value', FCM_SERVICE_ACCOUNT: '{secret-typo-value' });
  assert.deepEqual(config.errors, [], 'a typo in the panel never takes the app down');
  assert.deepEqual(config.install.nativePush, { apns: null, fcm: null });
  const said = config.warnings.filter((w) => w.startsWith('push.native'));
  assert.deepEqual(said.map((w) => w.replace(/ \(.*$/, '')), [
    'push.native: notices for iPhones are off: APNS_PRIVATE_KEY is not the .p8 key Apple gives',
    'push.native: notices for Android phones are off: FCM_SERVICE_ACCOUNT is not JSON',
  ]);
  assert.equal(said.some((w) => w.includes('secret-typo-value')), false, 'never the value');
});

/* ---------------------------------- table --------------------------------- */

test('the table: migration 24, one token per device, gone with the device, its revocation or its account', (t) => {
  const { database, accounts, devices, ana, bea, connect, now } = setup(t);
  assert.ok(database.get("SELECT 1 AS ok FROM schema_migrations WHERE scope = 'suite' AND version = 24 AND name = 'device-push-tokens'")
    ?? database.get("SELECT 1 AS ok FROM sqlite_master WHERE name = 'device_push_tokens'"));
  const native = createNativePush({ database, devices, ...fakeSenders() });
  const one = connect(ana);
  const two = connect(ana, 'android');
  const three = connect(bea);
  native.register(one.device.id, { platform: 'ios', token: IOS_TOKEN, environment: 'sandbox', lang: 'es' });
  native.register(one.device.id, { platform: 'ios', token: IOS_TOKEN, environment: 'production', lang: 'es' });
  native.register(two.device.id, { platform: 'android', token: ANDROID_TOKEN });
  assert.deepEqual(database.all('SELECT device_id, environment FROM device_push_tokens ORDER BY device_id').map((r) => ({ ...r })),
    [{ device_id: one.device.id, environment: 'production' }, { device_id: two.device.id, environment: null }], 'one row per device');
  // The same phone's token on another device (the app connected again): it moves, so each notice arrives once.
  native.register(three.device.id, { platform: 'ios', token: IOS_TOKEN, environment: 'production' });
  assert.deepEqual(database.all('SELECT device_id FROM device_push_tokens ORDER BY device_id').map((r) => r.device_id), [two.device.id, three.device.id]);
  native.register(one.device.id, { platform: 'ios', token: 'c'.repeat(64), environment: 'production' });
  assert.deepEqual(native.targetsOf([ana.id]).map((r) => [r.platform, r.native, r.user_id]), [['android', true, ana.id], ['ios', true, ana.id]]);
  assert.deepEqual([...native.withTokens([one.device.id, 999])], [one.device.id]);

  // Revoked: its token goes at once.
  devices.revoke(ana.id, two.device.id);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM device_push_tokens WHERE device_id = ?', two.device.id).n, 0);
  // Gone idle: no notice, and the purge that forgets the device takes the row.
  now.ms += 91 * 24 * 3600 * 1000;
  assert.deepEqual(native.targetsOf([ana.id, bea.id]), []);
  now.ms -= 91 * 24 * 3600 * 1000;
  assert.equal(native.targetsOf([ana.id]).length, 1);
  database.run('DELETE FROM device_tokens WHERE id = ?', one.device.id);
  assert.equal(native.targetsOf([ana.id]).length, 0, 'the row hangs on the device (ON DELETE CASCADE)');
  // A disabled account's, and a deleted one's.
  assert.equal(native.targetsOf([bea.id]).length, 1);
  accounts.update(bea.id, { disabled: true });
  assert.equal(database.get('SELECT COUNT(*) AS n FROM device_push_tokens').n, 0);
  accounts.update(bea.id, { disabled: false });
  const four = connect(bea, 'android');
  native.register(four.device.id, { platform: 'android', token: ANDROID_TOKEN });
  accounts.remove(bea.id);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM device_push_tokens').n, 0);
  assert.equal(native.unregister(four.device.id), false);
});

/* ---------------------------------- payload -------------------------------- */

test('what a Web Push payload becomes on a phone: texts, badge, category, and the rest as data', () => {
  const notice = noticeOf({
    title: '🔔 Buy bread', body: 'In Shopping', url: '/tasks/?list=4&task=9', tag: 'reminder-9', module: 'tasks',
    list_id: 4, task_id: 9, badge: 3, category: 'task-reminder', icon: '/i.png', actions: [{ action: 'x' }], nested: { a: 1 },
  });
  assert.deepEqual(notice, {
    title: '🔔 Buy bread', body: 'In Shopping', badge: 3, category: 'task-reminder', tag: 'reminder-9', module: 'tasks',
    data: { url: '/tasks/?list=4&task=9', tag: 'reminder-9', module: 'tasks', list_id: 4, task_id: 9 },
  });
  assert.equal(noticeOf({ badge: '/icons/badge.png', category: 'bad category!' }).badge, null, 'a Web Push badge is an image, not a count');
  assert.equal(noticeOf({ category: 'bad category!' }).category, null);
  assert.deepEqual(noticeOf('plain text'), { title: '', body: 'plain text', badge: null, category: null, tag: null, module: null, data: {} });
  assert.equal(noticeOf('{"title":"T","body":"B"}').title, 'T');

  const aps = JSON.parse(apnsPayload(notice));
  assert.deepEqual(aps.aps, {
    alert: { title: '🔔 Buy bread', body: 'In Shopping' }, sound: 'default', badge: 3, category: 'task-reminder', 'thread-id': 'tasks',
  });
  assert.equal(aps['mutable-content'], undefined);
  assert.equal(aps.aps['mutable-content'], undefined);
  assert.equal(aps.url, '/tasks/?list=4&task=9');
  assert.equal(aps.task_id, 9);
  assert.deepEqual(aps.body, notice.data, 'where expo-notifications reads content.data');
  assert.deepEqual(apnsHeaders(notice, { topic: 'com.cronumstudio.work', ttl: 60, clock: () => 1_000_000, collapse: 'reminder-9' }), {
    'apns-push-type': 'alert', 'apns-topic': 'com.cronumstudio.work', 'apns-priority': '10', 'apns-expiration': '1060', 'apns-collapse-id': 'reminder-9',
  });
  assert.equal(apnsHeaders(notice, { topic: 'x.y', urgency: 'low' })['apns-priority'], '5');

  const fcm = fcmMessage(notice, { ttl: 120, channel: 'reminders', collapse: 'reminder-9' });
  assert.deepEqual(fcm.notification, { title: '🔔 Buy bread', body: 'In Shopping' });
  assert.deepEqual(fcm.android, {
    priority: 'HIGH', ttl: '120s', collapse_key: 'reminder-9',
    notification: { channel_id: 'reminders', tag: 'reminder-9', notification_count: 3 },
  });
  assert.ok(Object.values(fcm.data).every((v) => typeof v === 'string'), 'FCM data takes strings only');
  assert.equal(fcm.data.task_id, '9');
  assert.equal(fcm.data.category, 'task-reminder');
  assert.deepEqual(JSON.parse(fcm.data.body), notice.data);
  assert.equal(fcmMessage(noticeOf({ from: 'x', google_x: 1, gcm: 2, title: 'T' })).data.from, undefined, 'keys FCM keeps for itself');
});

test('a long notice is shortened to fit, never refused: APNs 4 KB, FCM 4 KB', () => {
  const body = 'é'.repeat(5000);
  const notice = noticeOf({ title: 'Long', body, url: '/x' });
  const aps = apnsPayload(notice);
  assert.ok(Buffer.byteLength(aps) <= APNS_MAX_PAYLOAD);
  const parsed = JSON.parse(aps);
  assert.ok(parsed.aps.alert.body.endsWith('…'));
  assert.ok(parsed.aps.alert.body.length > 1000, 'only what doesn’t fit goes');
  assert.equal(parsed.url, '/x');
  const fcm = fcmMessage(notice);
  assert.ok(Buffer.byteLength(JSON.stringify(fcm)) <= FCM_MAX_PAYLOAD);
  assert.ok(fcm.notification.body.endsWith('…'));
  // Quotes count twice in JSON; a title too long goes down too.
  const quoted = apnsPayload(noticeOf({ title: '"'.repeat(3000), body: '"'.repeat(3000) }));
  assert.ok(Buffer.byteLength(quoted) <= APNS_MAX_PAYLOAD);
});

/* ----------------------------------- APNs ---------------------------------- */

/** Apple on this machine: an HTTP/2 server without TLS that answers `answer(headers, body)`. */
async function fakeApple(t, answer = () => ({ status: 200 })) {
  const got = [];
  let sessions = 0;
  const server = http2.createServer();
  server.on('session', () => { sessions += 1; });
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      got.push({ headers, body: body ? JSON.parse(body) : null });
      const { status, reason } = answer(headers, body);
      stream.respond({ ':status': status, 'apns-id': 'id-1', ...(reason ? { 'content-type': 'application/json' } : {}) });
      stream.end(reason ? JSON.stringify({ reason }) : undefined);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const authorities = [];
  const connect = (authority) => {
    authorities.push(authority);
    return http2.connect(`http://127.0.0.1:${server.address().port}`);
  };
  return { got, connect, authorities, sessions: () => sessions };
}

test('APNs: the provider token is an ES256 JWT of the key and team, kept 50 minutes', () => {
  const now = { ms: Date.parse('2026-10-21T08:00:00.000Z') };
  const sender = createApnsSender({
    keyId: 'ABCDE12345', teamId: 'TEAM123456', privateKey: APNS_PEM, topic: 'com.cronumstudio.work', clock: () => now.ms,
  });
  const first = sender.providerToken();
  assert.deepEqual(part(first, 0), { alg: 'ES256', kid: 'ABCDE12345' });
  assert.deepEqual(part(first, 1), { iss: 'TEAM123456', iat: Math.floor(now.ms / 1000) });
  assert.ok(verifies(first, APNS_KEY.publicKey, { dsaEncoding: 'ieee-p1363' }), 'r||s, as JOSE wants it');
  now.ms += 49 * 60 * 1000;
  assert.equal(sender.providerToken(), first, 'reused: Apple refuses new ones too often');
  now.ms += 2 * 60 * 1000;
  const second = sender.providerToken();
  assert.notEqual(second, first);
  assert.equal(part(second, 1).iat, Math.floor(now.ms / 1000));
  sender.close();
});

test('APNs over HTTP/2: the request Apple expects, one connection kept, the host by the token’s environment', async (t) => {
  const apple = await fakeApple(t);
  const sender = createApnsSender({
    keyId: 'ABCDE12345', teamId: 'TEAM123456', privateKey: APNS_PEM, topic: 'com.cronumstudio.work', connect: apple.connect,
  });
  t.after(() => sender.close());
  const notice = noticeOf({ title: 'Hi', body: 'There', tag: 'tasks-lista-4', module: 'tasks', url: '/tasks/?list=4', badge: 2 });
  assert.deepEqual(await sender.send({ token: IOS_TOKEN, environment: 'production' }, notice, { topic: 'list4' }), { status: 200, reason: null });
  assert.deepEqual(await sender.send({ token: IOS_TOKEN, environment: 'production' }, notice), { status: 200, reason: null });
  assert.deepEqual(apple.authorities, [APNS_PRODUCTION], 'one connection for both');
  assert.equal(apple.sessions(), 1);
  const [first, second] = apple.got;
  assert.equal(first.headers[':method'], 'POST');
  assert.equal(first.headers[':path'], `/3/device/${IOS_TOKEN}`);
  assert.equal(first.headers['apns-push-type'], 'alert');
  assert.equal(first.headers['apns-topic'], 'com.cronumstudio.work');
  assert.equal(first.headers['apns-priority'], '10');
  assert.equal(first.headers['apns-collapse-id'], 'list4', 'the send’s topic first');
  assert.equal(second.headers['apns-collapse-id'], 'tasks-lista-4', 'else the notice’s tag');
  assert.match(first.headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(first.headers.authorization, second.headers.authorization);
  assert.deepEqual(first.body.aps.alert, { title: 'Hi', body: 'There' });
  assert.equal(first.body.aps.badge, 2);
  assert.equal(first.body.url, '/tasks/?list=4');

  await sender.send({ token: IOS_TOKEN, environment: 'sandbox' }, notice);
  assert.deepEqual(apple.authorities, [APNS_PRODUCTION, APNS_SANDBOX], 'a development build’s token goes to the sandbox');
});

test('APNs: a refused provider token is made again at once; Apple down is an answer, never a throw', async (t) => {
  let refuse = true;
  const apple = await fakeApple(t, () => (refuse ? { status: 403, reason: 'ExpiredProviderToken' } : { status: 200 }));
  const now = { ms: Date.parse('2026-10-21T08:00:00.000Z') };
  const sender = createApnsSender({
    keyId: 'ABCDE12345', teamId: 'TEAM123456', privateKey: APNS_PEM, topic: 'com.cronumstudio.work', connect: apple.connect, clock: () => now.ms,
  });
  t.after(() => sender.close());
  const notice = noticeOf({ title: 'Hi' });
  assert.deepEqual(await sender.send({ token: IOS_TOKEN }, notice), { status: 403, reason: 'ExpiredProviderToken' });
  now.ms += 1000;
  refuse = false;
  await sender.send({ token: IOS_TOKEN }, notice);
  assert.notEqual(apple.got[0].headers.authorization, apple.got[1].headers.authorization);

  const nowhere = createApnsSender({
    keyId: 'ABCDE12345', teamId: 'TEAM123456', privateKey: APNS_PEM, topic: 'com.cronumstudio.work',
    connect: () => http2.connect('http://127.0.0.1:1'), log: () => {},
  });
  const res = await nowhere.send({ token: IOS_TOKEN }, notice);
  assert.equal(res.status, 0);
  nowhere.close();
});

test('what Apple’s and Google’s answers say of a token', () => {
  assert.equal(apnsOutcome({ status: 200 }), 'ok');
  assert.equal(apnsOutcome({ status: 410, reason: 'Unregistered' }), 'gone');
  assert.equal(apnsOutcome({ status: 400, reason: 'BadDeviceToken' }), 'gone');
  assert.equal(apnsOutcome({ status: 400, reason: 'DeviceTokenNotForTopic' }), 'rejected');
  assert.equal(apnsOutcome({ status: 400, reason: 'BadCollapseId' }), 'ours');
  assert.equal(apnsOutcome({ status: 403, reason: 'InvalidProviderToken' }), 'ours');
  assert.equal(apnsOutcome({ status: 429, reason: 'TooManyRequests' }), 'ours');
  assert.equal(apnsOutcome({ status: 503 }), 'later');
  assert.equal(apnsOutcome({ status: 0, reason: 'timeout' }), 'later');
  assert.equal(fcmOutcome({ status: 200 }), 'ok');
  assert.equal(fcmOutcome({ status: 404, code: 'UNREGISTERED' }), 'gone');
  assert.equal(fcmOutcome({ status: 400, code: 'INVALID_ARGUMENT', token: true }), 'gone');
  assert.equal(fcmOutcome({ status: 400, code: 'INVALID_ARGUMENT', token: false }), 'ours');
  assert.equal(fcmOutcome({ status: 403, code: 'SENDER_ID_MISMATCH' }), 'rejected');
  assert.equal(fcmOutcome({ status: 401, code: 'THIRD_PARTY_AUTH_ERROR' }), 'ours');
  assert.equal(fcmOutcome({ status: 0, code: 'OAUTH', ours: true }), 'ours');
  assert.equal(fcmOutcome({ status: 429, code: 'QUOTA_EXCEEDED' }), 'later');
  assert.equal(fcmOutcome({ status: 503, code: 'UNAVAILABLE' }), 'later');
});

/* ----------------------------------- FCM ----------------------------------- */

/** Google on a fake fetch: its OAuth and FCM's send, answering `send(body)` for each message. */
function fakeGoogle({ send = () => ({ status: 200, body: { name: 'projects/cronum-work/messages/1' } }), expiresIn = 3600 } = {}) {
  const calls = [];
  let issued = 0;
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === GOOGLE_OAUTH) {
      issued += 1;
      return new Response(JSON.stringify({ access_token: `google-access-${issued}`, expires_in: expiresIn, token_type: 'Bearer' }), { status: 200 });
    }
    const answer = send(JSON.parse(init.body));
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
  };
  return { fetch, calls, oauth: () => calls.filter((c) => c.url === GOOGLE_OAUTH), sends: () => calls.filter((c) => c.url !== GOOGLE_OAUTH) };
}

test('FCM: an RS256 assertion for Google’s OAuth, its access token kept until near its end', async () => {
  const google = fakeGoogle();
  const now = { ms: Date.parse('2026-10-21T08:00:00.000Z') };
  const sender = createFcmSender({
    projectId: 'cronum-work', clientEmail: SERVICE_ACCOUNT.client_email, privateKey: RSA_PEM, fetch: google.fetch, clock: () => now.ms,
  });
  const notice = noticeOf({ title: 'Hi', body: 'There', url: '/projects/?p=1', tag: 'projects-done-1', task_id: 5 });
  await Promise.all([sender.send({ token: ANDROID_TOKEN }, notice), sender.send({ token: ANDROID_TOKEN }, notice)]);
  assert.equal(google.oauth().length, 1, 'one request asks, the others wait for it');
  const form = new URLSearchParams(google.oauth()[0].init.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const assertion = form.get('assertion');
  assert.deepEqual(part(assertion, 0), { alg: 'RS256', typ: 'JWT' });
  const claims = part(assertion, 1);
  assert.deepEqual(claims, {
    iss: SERVICE_ACCOUNT.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: GOOGLE_OAUTH,
    iat: Math.floor(now.ms / 1000), exp: Math.floor(now.ms / 1000) + 3600,
  });
  assert.ok(verifies(assertion, RSA_KEY.publicKey));

  const [send] = google.sends();
  assert.equal(send.url, 'https://fcm.googleapis.com/v1/projects/cronum-work/messages:send');
  assert.equal(send.init.headers.Authorization, 'Bearer google-access-1');
  const { message } = JSON.parse(send.init.body);
  assert.equal(message.token, ANDROID_TOKEN);
  assert.deepEqual(message.notification, { title: 'Hi', body: 'There' });
  assert.equal(message.android.collapse_key, 'projects-done-1');
  assert.equal(message.android.notification.channel_id, 'default');
  assert.equal(message.data.url, '/projects/?p=1');
  assert.equal(message.data.task_id, '5');

  now.ms += 54 * 60 * 1000;
  await sender.send({ token: ANDROID_TOKEN }, notice);
  assert.equal(google.oauth().length, 1, 'still good');
  now.ms += 2 * 60 * 1000;
  await sender.send({ token: ANDROID_TOKEN }, notice);
  assert.equal(google.oauth().length, 2, 'five minutes before its end, another');
  assert.equal(google.sends().at(-1).init.headers.Authorization, 'Bearer google-access-2');
});

test('FCM: a 401 asks for another access token; the token Google refuses is told apart from our message', async () => {
  let answer = { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } };
  const google = fakeGoogle({ send: () => answer });
  const sender = createFcmSender({ projectId: 'cronum-work', clientEmail: SERVICE_ACCOUNT.client_email, privateKey: RSA_PEM, fetch: google.fetch });
  const notice = noticeOf({ title: 'Hi' });
  assert.equal((await sender.send({ token: ANDROID_TOKEN }, notice)).status, 401);
  answer = { status: 200 };
  await sender.send({ token: ANDROID_TOKEN }, notice);
  assert.equal(google.oauth().length, 2);

  answer = { status: 404, body: { error: { status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } } };
  assert.deepEqual(await sender.send({ token: ANDROID_TOKEN }, notice), { status: 404, code: 'UNREGISTERED', token: false });
  answer = {
    status: 400,
    body: {
      error: {
        status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token',
        details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.token' }] }],
      },
    },
  };
  assert.deepEqual(await sender.send({ token: ANDROID_TOKEN }, notice), { status: 400, code: 'INVALID_ARGUMENT', token: true });
  answer = { status: 400, body: { error: { status: 'INVALID_ARGUMENT', message: 'Invalid value at message.android.ttl' } } };
  assert.deepEqual(await sender.send({ token: ANDROID_TOKEN }, notice), { status: 400, code: 'INVALID_ARGUMENT', token: false });

  const down = createFcmSender({
    projectId: 'cronum-work', clientEmail: SERVICE_ACCOUNT.client_email, privateKey: RSA_PEM, log: () => {},
    fetch: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.deepEqual(await down.send({ token: ANDROID_TOKEN }, notice), { status: 0, code: 'OAUTH', token: false, ours: true });
});

/* ------------------------------ the service ------------------------------- */

test('delivering keeps the table clean: gone ones dropped, three refusals dropped, ours and outages kept', async (t) => {
  const { database, devices, ana, connect } = setup(t);
  const queue = { ios: [], android: [] };
  const fake = fakeSenders({ ios: () => queue.ios.shift(), android: () => queue.android.shift() });
  const lines = [];
  const native = createNativePush({ database, devices, ...fake, log: (line) => lines.push(line) });
  const phone = connect(ana);
  const tablet = connect(ana, 'android');
  native.register(phone.device.id, { platform: 'ios', token: IOS_TOKEN, environment: 'production' });
  native.register(tablet.device.id, { platform: 'android', token: ANDROID_TOKEN });
  const failures = () => database.all('SELECT platform, failures FROM device_push_tokens ORDER BY platform').map((r) => `${r.platform}:${r.failures}`);

  queue.ios.push({ status: 200 });
  queue.android.push({ status: 200 });
  assert.deepEqual(await native.deliver(native.targetsOf([ana.id]), { title: 'A' }), { sent: 2, gone: 0, failed: 0 });
  assert.equal(database.all('SELECT last_ok_at FROM device_push_tokens').every((r) => r.last_ok_at), true);

  // Our credentials or our message: nothing against the devices.
  queue.ios.push({ status: 403, reason: 'InvalidProviderToken' });
  queue.android.push({ status: 400, code: 'INVALID_ARGUMENT', token: false });
  assert.deepEqual(await native.deliver(native.targetsOf([ana.id]), { title: 'A' }), { sent: 0, gone: 0, failed: 2 });
  // The services down: nothing against them either.
  queue.ios.push({ status: 503 });
  queue.android.push({ status: 0, code: 'ETIMEDOUT' });
  await native.deliver(native.targetsOf([ana.id]), { title: 'A' });
  assert.deepEqual(failures(), ['android:0', 'ios:0']);

  // Refused three times in a row: dropped.
  for (let i = 0; i < 3; i++) {
    queue.ios.push({ status: 400, reason: 'DeviceTokenNotForTopic' });
    queue.android.push({ status: 200 });
    await native.deliver(native.targetsOf([ana.id]), { title: 'A' });
  }
  assert.deepEqual(failures(), ['android:0']);
  // Gone: dropped at once.
  queue.android.push({ status: 404, code: 'UNREGISTERED' });
  assert.deepEqual(await native.deliver(native.targetsOf([ana.id]), { title: 'A' }), { sent: 0, gone: 1, failed: 0 });
  assert.deepEqual(failures(), []);
  assert.ok(lines.some((l) => l.includes('reason of ours')));

  // A sender that throws, or a payload function that does, is that device’s failure only.
  const again = connect(ana);
  native.register(again.device.id, { platform: 'ios', token: IOS_TOKEN, environment: 'production' });
  const broken = createNativePush({
    database, devices, log: () => {},
    senders: { apns: { send: async () => { throw new Error('boom'); }, close() {} } },
  });
  assert.deepEqual(await broken.deliver(broken.targetsOf([ana.id]), { title: 'A' }), { sent: 0, gone: 0, failed: 1 });
});

test('a platform without credentials is skipped and said once, the other still sent', async (t) => {
  const { database, devices, ana, connect } = setup(t);
  const lines = [];
  const google = fakeGoogle();
  const native = createNativePush({
    database, devices, fcm: { projectId: 'cronum-work', clientEmail: SERVICE_ACCOUNT.client_email, privateKey: RSA_PEM },
    fetch: google.fetch, log: (line) => lines.push(line),
  });
  assert.deepEqual(native.platforms, { ios: false, android: true });
  native.register(connect(ana).device.id, { platform: 'ios', token: IOS_TOKEN, environment: 'production' });
  native.register(connect(ana, 'android').device.id, { platform: 'android', token: ANDROID_TOKEN });
  assert.deepEqual(await native.deliver(native.targetsOf([ana.id]), { title: 'A' }), { sent: 1, gone: 0, failed: 1 });
  await native.deliver(native.targetsOf([ana.id]), { title: 'B' });
  assert.equal(lines.filter((l) => l.includes('APNs has no credentials')).length, 1);
  assert.equal(database.get("SELECT COUNT(*) AS n FROM device_push_tokens WHERE platform = 'ios'").n, 1, 'kept for when they are set');
  native.close();
});

/* --------------------------- the same sends as Web Push --------------------------- */

test('one send reaches both: subscriptionsOf gives the phones, deliver sends each where it goes', async (t) => {
  const { database, devices, ana, bea, connect } = setup(t);
  const fake = fakeSenders();
  const native = createNativePush({ database, devices, ...fake });
  const webSent = [];
  const fetch = async (url) => { webSent.push(String(url)); return new Response(null, { status: 201 }); };
  const push = createPush({ database, vapid: { ...generateVapidKeys(), subject: 'mailto:a@b.c' }, fetch, log: () => {}, native });
  const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
  const p256dh = Buffer.concat([Buffer.from([4]), Buffer.from(keys.x, 'base64url'), Buffer.from(keys.y, 'base64url')]).toString('base64url');
  push.subscribe(ana.id, { endpoint: 'https://fcm.googleapis.com/fcm/send/ana-desktop', p256dh, auth: crypto.randomBytes(16).toString('base64url'), lang: 'en' });
  native.register(connect(ana).device.id, { platform: 'ios', token: IOS_TOKEN, environment: 'production', lang: 'es' });
  native.register(connect(bea, 'android').device.id, { platform: 'android', token: ANDROID_TOKEN, lang: 'fr' });

  // As Projects does it: the person's devices, then deliver.
  const devicesOfAna = push.subscriptionsOf([ana.id]);
  assert.deepEqual(devicesOfAna.map((s) => (s.native ? s.platform : 'web')), ['web', 'ios']);
  const result = await push.deliver(devicesOfAna, (sub) => ({ title: `Hi ${sub.lang}`, body: 'B', tag: 't', task_id: 3 }));
  assert.deepEqual(result, { sent: 2, gone: 0, failed: 0 });
  assert.deepEqual(webSent, ['https://fcm.googleapis.com/fcm/send/ana-desktop']);
  assert.equal(fake.sent.length, 1, 'each target once');
  assert.equal(fake.sent[0].notice.title, 'Hi es', 'the payload function sees the phone’s language');
  assert.equal(fake.sent[0].notice.data.task_id, 3);

  // As Tasks does it: its own SELECT of push_subscriptions. The people in it get their phones too.
  fake.sent.length = 0;
  const rows = database.all('SELECT * FROM push_subscriptions WHERE user_id = ?', ana.id);
  assert.deepEqual(await push.deliver(rows, { title: 'Reminder' }, { topic: 'reminder-3' }), { sent: 2, gone: 0, failed: 0 });
  assert.deepEqual(fake.sent.map((s) => [s.platform, s.options.topic]), [['ios', 'reminder-3']]);

  // sendTo, and a person with a phone only.
  fake.sent.length = 0;
  assert.deepEqual(await push.sendTo([bea.id], { title: 'Only the phone' }), { sent: 1, gone: 0, failed: 0 });
  assert.deepEqual(fake.sent.map((s) => s.platform), ['android']);
  // send() with a phone's row goes to the phone.
  assert.equal((await push.send(push.subscriptionsOf([bea.id])[0], { title: 'one' })).ok, true);
  // A topic written wrong is the app's mistake for every device, phones included.
  await assert.rejects(push.deliver(push.subscriptionsOf([bea.id]), { title: 'x' }, { topic: 'not valid!' }), TypeError);
});

test('without push.native, push sends to Web Push only, as before', async (t) => {
  const { database, devices, ana, connect } = setup(t);
  const fake = fakeSenders();
  const native = createNativePush({ database, devices, ...fake });
  native.register(connect(ana).device.id, { platform: 'ios', token: IOS_TOKEN, environment: 'production' });
  const push = createPush({ database, vapid: { ...generateVapidKeys(), subject: 'mailto:a@b.c' }, fetch: async () => new Response(null, { status: 201 }), log: () => {} });
  assert.deepEqual(push.subscriptionsOf([ana.id]), []);
  assert.deepEqual(await push.sendTo([ana.id], { title: 'x' }), { sent: 0, gone: 0, failed: 0 });
  assert.equal(fake.sent.length, 0);
});

test('in a host, a module’s notice reaches the phone at the module’s path, through deliver and sendTo', async (t) => {
  const { database, devices, ana, connect } = setup(t);
  const fake = fakeSenders();
  const native = createNativePush({ database, devices, ...fake });
  const push = createPush({ database, vapid: { ...generateVapidKeys(), subject: 'mailto:a@b.c' }, fetch: async () => new Response(null, { status: 201 }), log: () => {}, native });
  native.register(connect(ana).device.id, { platform: 'ios', token: IOS_TOKEN, environment: 'production' });
  const tasks = hostedPush(push, 'tasks');
  await tasks.deliver(tasks.subscriptionsOf([ana.id]), { title: 'T', url: '/?list=4', tag: 'lista-4' });
  await tasks.sendTo([ana.id], { title: 'T', url: '/?list=5', tag: 'lista-5' });
  assert.deepEqual(fake.sent.map((s) => [s.notice.data.url, s.notice.module, s.notice.tag]), [
    ['/tasks/?list=4', 'tasks', 'tasks-lista-4'], ['/tasks/?list=5', 'tasks', 'tasks-lista-5'],
  ]);
});

/* ---------------------------------- over HTTP ------------------------------- */

async function startApp(t, { push = { native: true }, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-native-push-app-'));
  const lines = [];
  const suite = createSuite({
    config: {
      app: { id: 'work', name: 'Work', languages: ['en'] }, tokens: { prefix: 'work_' },
      modules: { push: true, devices: true }, devices: { prefix: 'workdev_', redirectUris: [BACK] },
      rateLimits: { devices: 5 }, ...(push ? { push } : {}),
    },
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1', ...env },
    log: (line) => lines.push(line), exitOnError: false,
  });
  const app = createApp({ suite, version: '1.0.0', handleSignals: false, log: (line) => lines.push(line), mcp: { instructions: 'Work.', tools: [] } });
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
    const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('work_sid='));
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data };
  };
  const web = (method, pathname, body, headers = {}) => call(method, pathname, body, { Cookie: cookie, ...headers });
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  /** A device connected as the app does it: a code from the session, exchanged with its verifier. */
  const device = async (platform = 'ios') => {
    const verifier = randomToken(32);
    const issued = await web('POST', '/api/devices/codes', { code_challenge: sha256(verifier), redirect_uri: BACK, name: 'Phone', platform });
    const done = await call('POST', '/api/devices/token', { code: issued.data.code, code_verifier: verifier, redirect_uri: BACK });
    return { id: done.data.device.id, auth: { Authorization: `Bearer ${done.data.token}` } };
  };
  return { suite, call, web, device, lines };
}

test('over HTTP, option off: no routes, the device list as before, and nothing native in the suite', async (t) => {
  const { suite, call, web, device } = await startApp(t, { push: null });
  assert.equal(suite.nativePush, null);
  const phone = await device();
  assert.equal((await call('POST', '/api/devices/push', { platform: 'ios', token: IOS_TOKEN }, phone.auth)).status, 404);
  assert.equal((await call('DELETE', '/api/devices/push', undefined, phone.auth)).status, 404);
  assert.equal((await call('POST', '/api/devices/push/test', {}, phone.auth)).status, 404);
  assert.equal('notifications' in (await web('GET', '/api/me/devices')).data[0], false);
});

test('over HTTP: the app registers its token with its device token, checked, and Settings says it gets notices', async (t) => {
  const { suite, call, web, device, lines } = await startApp(t);
  assert.ok(lines.some((l) => l.includes('notices for iPhones are off, these are missing: APNS_KEY_ID')));
  const phone = await device();
  const register = (body, auth = phone.auth) => call('POST', '/api/devices/push', body, auth);

  assert.equal((await register({ platform: 'ios', token: IOS_TOKEN }, {})).status, 401);
  assert.equal((await web('POST', '/api/devices/push', { platform: 'ios', token: IOS_TOKEN })).status, 401, 'a session is not a device');
  assert.equal((await register({ token: IOS_TOKEN })).data.error, 'field_required');
  assert.deepEqual((await register({ platform: 'web', token: IOS_TOKEN })).data.field, 'platform');
  assert.equal((await register({ platform: 'ios', token: 'xyz' })).data.field, 'token');
  assert.equal((await register({ platform: 'android', token: 'short' })).data.field, 'token');
  assert.equal((await register({ platform: 'ios', token: IOS_TOKEN, environment: 'staging' })).data.field, 'environment');
  assert.equal((await register({ platform: 'ios', token: IOS_TOKEN, lang: 'not a language' })).data.field, 'lang');

  assert.equal((await web('GET', '/api/me/devices')).data[0].notifications, false);
  const ok = await register({ platform: 'ios', token: IOS_TOKEN.toUpperCase(), environment: 'sandbox', lang: 'es-ES' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data, { ok: true, platform: 'ios', environment: 'sandbox', sending: false });
  assert.deepEqual(suite.database.all('SELECT platform, token, environment, lang FROM device_push_tokens').map((r) => ({ ...r })),
    [{ platform: 'ios', token: IOS_TOKEN, environment: 'sandbox', lang: 'es-ES' }]);
  assert.equal((await web('GET', '/api/me/devices')).data[0].notifications, true);
  assert.equal((await register({ platform: 'ios', token: IOS_TOKEN })).data.environment, 'production', 'production unless it says');

  // Without APNs' credentials the test notice is a failure, said, and the token kept.
  assert.deepEqual((await call('POST', '/api/devices/push/test', {}, phone.auth)).data, { sent: 0, gone: 0, failed: 1 });
  // Web Push's own test reaches the phone too: one send for both.
  assert.deepEqual((await web('POST', '/api/push/test', {})).data, { sent: 0, gone: 0, failed: 1 });

  assert.equal((await call('DELETE', '/api/devices/push', undefined, phone.auth)).status, 200);
  assert.equal((await web('GET', '/api/me/devices')).data[0].notifications, false);
  assert.deepEqual((await call('POST', '/api/devices/push/test', {}, phone.auth)).data, { sent: 0, gone: 0, failed: 0, no_token: true });

  const tablet = await device('android');
  assert.equal((await register({ platform: 'android', token: ANDROID_TOKEN, environment: 'production' }, tablet.auth)).data.environment, null);
  // Revoked from Settings: its token goes, and the device can no longer register.
  assert.equal((await web('DELETE', `/api/me/devices/${tablet.id}`)).status, 200);
  assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM device_push_tokens').n, 0);
  assert.equal((await register({ platform: 'android', token: ANDROID_TOKEN }, tablet.auth)).status, 401);
});

test('over HTTP: bad device tokens count against the address, in the devices’ bucket', async (t) => {
  const { call } = await startApp(t);
  const bad = { Authorization: 'Bearer workdev_nope' };
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/devices/push', { platform: 'ios', token: IOS_TOKEN }, bad)).status, 401);
  assert.equal((await call('POST', '/api/devices/push', { platform: 'ios', token: IOS_TOKEN }, bad)).status, 429);
});

test('over HTTP: credentials that can’t be used start the app anyway, that platform off and its tokens kept', async (t) => {
  const { suite, call, device, lines } = await startApp(t, {
    env: {
      APNS_KEY_ID: 'ABCDE12345', APNS_TEAM_ID: 'TEAM123456', APNS_PRIVATE_KEY: 'secret-typo-value', APNS_TOPIC: 'com.cronumstudio.work',
      FCM_SERVICE_ACCOUNT: JSON.stringify(SERVICE_ACCOUNT),
    },
  });
  assert.deepEqual(suite.nativePush.platforms, { ios: false, android: true });
  assert.ok(lines.some((l) => l.includes('notices for iPhones are off: APNS_PRIVATE_KEY')));
  assert.equal(lines.some((l) => l.includes('secret-typo-value')), false, 'never the value');
  const phone = await device();
  assert.equal((await call('POST', '/api/devices/push', { platform: 'ios', token: IOS_TOKEN }, phone.auth)).data.sending, false);
  assert.deepEqual((await call('POST', '/api/devices/push/test', {}, phone.auth)).data, { sent: 0, gone: 0, failed: 1 });
  assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM device_push_tokens').n, 1, 'kept for when the key is fixed');
});
