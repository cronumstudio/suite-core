/**
 * Who the daily summary's notices look at (audit of 6/11, sc-feat-1 / sc-host-1): push.js
 * peopleWithDevices() against real tables (browsers subscribed, phones with a token on a device
 * not revoked), and the scheduler (day.js) reading only those accounts, looking at the checks of
 * a five-minute step and forgetting old notices once a day. The rest of the scheduler is in
 * day.test.js.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDay, createDayNotices, DAY_LOG_DAYS } from '../day.js';
import { createPush, generateVapidKeys } from '../push.js';
import { createNativePush } from '../native-push.js';
import { HOST_MIGRATIONS } from '../host.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { migrate } from '../migrate.js';
import { openDatabase } from '../db.js';
import { createAccounts } from '../accounts.js';
import { createDevices } from '../devices.js';
import { createTexts } from '../i18n.js';
import { addDays } from '../time.js';
import { randomToken, sha256 } from '../crypto.js';

const BACK = 'com.cronumstudio.work:/auth';
const texts = createTexts();

function keys() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  return {
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  };
}

/** A host's database: five people, some with a browser subscribed or a phone. */
function setUp(t) {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  migrate(database, HOST_MIGRATIONS, { scope: 'host', log: () => {} });
  const accounts = createAccounts({ database });
  const devices = createDevices({ database, prefix: 'workdev_', redirectUris: [BACK] });
  const people = ['ana', 'ben', 'cai', 'dan', 'eva'].map((username) => accounts.create({ username, displayName: username }));
  for (const person of people) database.run('UPDATE users SET prefs = ? WHERE id = ?', '{"tz":"Europe/Madrid","lang":"en"}', person.id);
  const native = createNativePush({ database, devices, senders: { apns: { send: async () => ({ ok: true, status: 200 }), close() {} } } });
  const push = createPush({ database, vapid: { ...generateVapidKeys(), subject: 'mailto:a@b.c' }, log: () => {}, native });
  const connect = (user) => {
    const verifier = randomToken(32);
    const issued = devices.issueCode(user, { codeChallenge: sha256(verifier), redirectUri: BACK, name: 'Phone', platform: 'ios' });
    return devices.exchange({ code: issued.code, verifier, redirectUri: BACK });
  };
  const [ana, ben, cai, dan] = people;
  // Ana: a browser. Ben: a phone. Cai: a phone she disconnected. Dan, Eva: nothing.
  push.subscribe(ana.id, { endpoint: 'https://fcm.googleapis.com/fcm/send/ana', ...keys() });
  native.register(connect(ben).device.id, { platform: 'ios', token: 'b'.repeat(64), environment: 'production' });
  const caisPhone = connect(cai).device.id;
  native.register(caisPhone, { platform: 'ios', token: 'c'.repeat(64), environment: 'production' });
  devices.revoke(cai.id, caisPhone);
  return { database, accounts, devices, push, people, dan };
}

test('peopleWithDevices: a browser subscribed or a phone still connected, each person once', (t) => {
  const { push, people } = setUp(t);
  const [ana, ben] = people;
  assert.deepEqual(push.peopleWithDevices().sort((a, b) => a - b), [ana.id, ben.id]);
  // Never fewer than the devices a notice reaches.
  const reached = new Set(push.subscriptionsOf(people.map((p) => p.id)).map((d) => Number(d.user_id)));
  for (const id of reached) assert.ok(push.peopleWithDevices().includes(id), `user ${id}`);
});

test('the notices read only the accounts with a device, and ask nobody else for devices', async (t) => {
  const { database, push, people } = setUp(t);
  const asked = [];
  const read = [];
  const subscriptionsOf = push.subscriptionsOf;
  const watched = {
    ...push,
    subscriptionsOf: (ids) => { asked.push(...ids.map(Number)); return subscriptionsOf(ids); },
    deliver: async () => ({ sent: 1, gone: 0, failed: 0 }),
  };
  const all = database.all;
  const db = { ...database, all: (sql, ...params) => { if (/FROM users/.test(sql)) read.push(sql); return all(sql, ...params); } };
  const module = { mount: 'tasks', config: { app: { name: 'Tasks' } }, parts: { day: { agenda: () => [{ type: 'task', id: 1, title: 'Call', date: '2026-11-04' }] } } };
  const notices = createDayNotices({
    database: db, push: watched, day: createDay({ modules: () => [module] }), texts, languages: ['en', 'es'],
    userById: (id) => database.get('SELECT * FROM users WHERE id = ?', id),
  });
  // 08:00 in Madrid: everyone's morning.
  assert.deepEqual(await notices.check({ now: new Date('2026-11-04T07:00:00Z') }), { sent: 2, empty: 0 }, 'Ana and Ben');
  assert.deepEqual([...new Set(asked)].sort(), [people[0].id, people[1].id].sort(), 'only those with a device were asked for theirs');
  assert.ok(read.every((sql) => /id IN/.test(sql)), 'and only their rows read');
  // A minute later, the rest still have nothing: nobody asked again.
  asked.length = 0;
  await notices.check({ now: new Date('2026-11-04T07:01:00Z') });
  assert.deepEqual(asked, [], 'whoever has no device is not asked every minute of the window');
});

test('everyMinutes: checks between the steps look at nothing, and a late one still looks', async (t) => {
  const { database, push } = setUp(t);
  let looks = 0;
  const counting = { ...push, peopleWithDevices: () => { looks += 1; return push.peopleWithDevices(); }, deliver: async () => ({ sent: 1 }) };
  const notices = createDayNotices({
    database, push: counting, day: createDay({ modules: () => [] }), texts, everyMinutes: 5,
    userById: (id) => database.get('SELECT * FROM users WHERE id = ?', id),
  });
  const at = (iso) => notices.check({ now: new Date(iso) });
  await at('2026-11-04T07:00:20Z');
  assert.equal(looks, 1, 'the first one looks');
  for (const minute of ['01', '02', '03', '04']) await at(`2026-11-04T07:${minute}:20Z`);
  assert.equal(looks, 1, 'off the step: nothing');
  await at('2026-11-04T07:05:20Z');
  assert.equal(looks, 2, 'on it');
  // The 07:10 check never came (a busy minute): the next one looks all the same.
  await at('2026-11-04T07:11:21Z');
  assert.equal(looks, 3, 'a step after the last that looked');
});

test('the notices sent are forgotten once a day, after DAY_LOG_DAYS days', async (t) => {
  const { database, push } = setUp(t);
  const notices = createDayNotices({
    database, push, day: createDay({ modules: () => [] }), texts,
    userById: (id) => database.get('SELECT * FROM users WHERE id = ?', id),
  });
  const keep = (day) => database.run("INSERT OR IGNORE INTO host_day_notices (user_id, kind, day, claimed_at) VALUES (1, 'morning', ?, '2026-01-01T00:00:00Z')", day);
  const days = () => database.all('SELECT day FROM host_day_notices ORDER BY day').map((r) => r.day);
  keep(addDays('2026-11-04', -DAY_LOG_DAYS - 1));
  keep(addDays('2026-11-04', -DAY_LOG_DAYS));
  await notices.check({ now: new Date('2026-11-04T03:00:00Z') });
  assert.deepEqual(days(), [addDays('2026-11-04', -DAY_LOG_DAYS)], 'the first check of the day forgets');
  keep('2026-01-01');
  await notices.check({ now: new Date('2026-11-04T03:01:00Z') });
  assert.deepEqual(days(), ['2026-01-01', addDays('2026-11-04', -DAY_LOG_DAYS)], 'not the next minute');
  await notices.check({ now: new Date('2026-11-05T00:00:00Z') });
  assert.deepEqual(days(), [], 'the next day, again: one day older than kept');
  assert.ok(database.all("PRAGMA index_list('host_day_notices')").some((index) => index.name === 'ix_host_day_notices_day'),
    'and they are read by their day through an index');
});
