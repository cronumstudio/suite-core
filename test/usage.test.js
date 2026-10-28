/**
 * The admin's list of accounts (usage.js peaksOf): every account's nearest cap, the same as each
 * account's own usage says, in a fixed number of queries where the modules can answer for many.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { createEntitlements } from '../entitlements.js';
import { createOrganizations } from '../organizations.js';
import { usageOf, peaksOf, registerUsageApi } from '../usage.js';

const PLANS = {
  free: { name: 'Free', features: { 'items.max': 5, 'storage.mb': 1, 'mcp.calls_per_day': 10 } },
  plus: { name: 'Plus', features: { 'items.max': 50, 'storage.mb': 10, 'mcp.calls_per_day': 100 } },
  pro: { name: 'Pro', features: { 'items.max': null, 'storage.mb': null, 'mcp.calls_per_day': null } },
};

/**
 * Accounts of every kind (on Free, with a plan of their own, in a group with a plan, the admin),
 * a module that counts items (alpha) and one that only weighs files (beta), every query counted.
 * `all`: whether alpha and beta answer for many at once ('some': leaving some out; 'throws').
 */
function setup(t, { accounts = 60, all = true } = {}) {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT)');
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, user_id INTEGER, bytes INTEGER)');
  const users = [];
  for (let id = 1; id <= accounts; id += 1) {
    database.run('INSERT INTO users (id, username, role) VALUES (?, ?, ?)', id, `u${id}`, id === 1 ? 'admin' : 'user');
    users.push({ id, role: id === 1 ? 'admin' : 'user' });
    for (let n = 0; n < id % 7; n += 1) database.run('INSERT INTO items (user_id, bytes) VALUES (?, ?)', id, 40_000 * (id % 5));
  }
  const counter = { queries: 0 };
  const c = (fn) => (...args) => {
    counter.queries += 1;
    return fn(...args);
  };
  const db = { ...database, all: c(database.all), get: c(database.get), run: c(database.run) };

  let organizations = null;
  const plansFor = (features) => createEntitlements({
    database: db, appId: 'alpha', features, plans: PLANS, plansJson: '', othersDeclare: true,
    organizationsOf: (user) => organizations.organizationsOf(user),
    organizationsOfMany: (ids) => organizations.organizationsOfMany(ids),
  });
  const host = plansFor({ 'mcp.calls_per_day': { type: 'limit', default: null, label: 'calls a day' } });
  const alphaPlans = plansFor({
    'items.max': { type: 'limit', default: null, label: 'items' },
    'storage.mb': { type: 'limit', default: null, label: 'storage' },
  });
  organizations = createOrganizations({ database: db, seatsOf: host.seatsOf });
  // Grants: some with Plus of their own, a group with Pro for others, one with Plus that ended.
  for (const user of users.filter((u) => u.id % 6 === 0)) host.grant({ subjectId: user.id, plan: 'plus' });
  const group = organizations.create({ name: 'Studio', ownerId: 9 });
  for (const id of [10, 11, 13]) organizations.addMember(group.id, id);
  host.grant({ subjectType: 'organization', subjectId: group.id, plan: 'pro' });
  host.grant({ subjectId: 14, plan: 'plus', endsAt: '2020-01-01T00:00:00.000Z', startsAt: '2019-01-01T00:00:00.000Z' });
  for (const user of users.filter((u) => u.id % 4 === 0)) for (let n = 0; n < user.id % 9; n += 1) host.countDaily(user, 'mcp.calls_per_day');

  const itemsOf = (id) => db.get('SELECT COUNT(*) AS n FROM items WHERE user_id = ?', id).n;
  const bytesOf = (id) => db.get('SELECT COALESCE(SUM(bytes), 0) AS b FROM items WHERE user_id = ?', id).b;
  const grouped = (sql, ids) => new Map(ids.map((id) => [id, 0]).concat(db.all(sql, ...ids).map((r) => [r.user_id, r.v])));
  const marks = (ids) => ids.map(() => '?').join(', ');
  const calls = { usage: 0, usageAll: 0, storage: 0, storageAll: 0 };
  const leaveOut = (map) => {
    if (all === 'some') for (const id of [...map.keys()].filter((id) => id % 5 === 0)) map.delete(id);
    return map;
  };
  const alpha = {
    mount: 'alpha', config: { app: { id: 'alpha', name: 'Alpha' } }, view: { entitlements: alphaPlans },
    parts: {
      usage: (id) => { calls.usage += 1; return { counts: [{ id: 'tasks', count: itemsOf(id), feature: 'items.max' }, { id: 'files', count: itemsOf(id) }], active_at: null }; },
      storage: (id) => { calls.storage += 1; return bytesOf(id); },
      ...(all ? {
        usageAll: (ids) => {
          calls.usageAll += 1;
          if (all === 'throws') throw new Error('broken');
          const counts = grouped(`SELECT user_id, COUNT(*) AS v FROM items WHERE user_id IN (${marks(ids)}) GROUP BY user_id`, ids);
          return leaveOut(new Map(ids.map((id) => [id, { counts: [{ id: 'tasks', count: counts.get(id), feature: 'items.max' }, { id: 'files', count: counts.get(id) }], active_at: null }])));
        },
        storageAll: (ids) => {
          calls.storageAll += 1;
          if (all === 'throws') throw new Error('broken');
          return leaveOut(grouped(`SELECT user_id, SUM(bytes) AS v FROM items WHERE user_id IN (${marks(ids)}) GROUP BY user_id`, ids));
        },
      } : {}),
    },
  };
  const beta = { mount: 'beta', config: { app: { id: 'beta', name: 'Beta' } }, view: { entitlements: null }, parts: { storage: () => 1000 } };
  const lines = [];
  const options = { modules: [alpha, beta], entitlements: host, log: (line) => lines.push(line) };
  return { users, options, counter, calls, lines, host, reset: () => { counter.queries = 0; Object.keys(calls).forEach((k) => { calls[k] = 0; }); } };
}

const oneByOne = (users, options) => new Map(users.map((user) => [user.id, usageOf(user, options).peak]));

test('the list’s peaks are what each account’s own usage says, in a fixed number of queries', (t) => {
  const { users, options, counter, calls, reset } = setup(t);
  const expected = oneByOne(users, options);
  // The kinds of accounts are all there: on a count, on storage, on today's calls, the admin with none.
  assert.equal(expected.get(1), null, 'the admin has no limits');
  assert.ok([...expected.values()].some((p) => p?.id === 'tasks'));
  assert.ok([...expected.values()].some((p) => p?.id === 'storage'));
  assert.ok([...expected.values()].some((p) => p?.id === 'mcp'));
  assert.equal(expected.get(10), null, 'the group’s Pro counts for its members: no caps');
  assert.equal(expected.get(9), null, 'its owner too');
  assert.notEqual(expected.get(5), null, 'someone on Free has a cap');
  reset();
  const before = counter.queries;
  assert.deepEqual(peaksOf(users, options), expected);
  const queries = counter.queries - before;
  assert.deepEqual(calls, { usage: 0, usageAll: 1, storage: 0, storageAll: 1 });
  // usageAll and storageAll; each plan's groups and grants (of the people, of their groups); today's calls.
  assert.ok(queries <= 9, `60 accounts in a few queries (${queries})`);

  // Per account, as before: dozens of queries each.
  reset();
  oneByOne(users, options);
  assert.ok(counter.queries > users.length * 8, `one by one: ${counter.queries}`);
});

test('a module without usageAll, or one that leaves ids out or fails, is asked one by one: the same peaks', (t) => {
  for (const all of [false, 'some', 'throws']) {
    const { users, options, calls, lines, reset } = setup(t, { accounts: 30, all });
    const expected = oneByOne(users, options);
    reset();
    assert.deepEqual(peaksOf(users, options), expected, String(all));
    const asked = all === 'some' ? users.filter((u) => u.id % 5 === 0).length : users.length;
    assert.equal(calls.usage, asked, `${all}: usage() for the ones it didn't say`);
    assert.equal(calls.storage, asked, `${all}: storage() too`);
    if (all === 'throws') assert.ok(lines.some((line) => /\[alpha\] usageAll failed: broken/.test(line)));
  }
});

test('the plans of many at once are what of() says of each', (t) => {
  const { users, host } = setup(t, { accounts: 40 });
  const many = host.ofMany(users);
  for (const user of users) assert.deepEqual(many.get(user.id), host.of(user), `user ${user.id}`);
  assert.deepEqual(host.usedToday(users.map((u) => u.id), 'mcp.calls_per_day').get(8),
    host.dailyUsage(8, 'mcp.calls_per_day').at(-1).used);
});

test('the admin’s list counts in batches, letting the process answer in between, with the same answer', async (t) => {
  const { users, options } = setup(t, { accounts: 450 });
  const routes = {};
  const api = { get: (route, handler) => { routes[route] = handler; } };
  registerUsageApi(api, {
    accounts: { list: () => users, byId: (id) => users.find((u) => u.id === id) },
    usageFor: (user) => usageOf(user, options),
    peaksFor: (batch) => peaksOf(batch, options),
  });
  let sent = null;
  const order = [];
  const res = { writeHead() {}, end(body) { sent = JSON.parse(body); order.push('answered'); } };
  // Someone else's request, arriving while the list is being counted.
  setImmediate(() => order.push('someone else'));
  await routes['/api/admin/usage']({ user: { id: 1, role: 'admin' }, res });
  assert.deepEqual(order, ['someone else', 'answered'], 'answered in between the batches');
  assert.deepEqual(sent.peaks, Object.fromEntries(oneByOne(users, options)));
  await assert.rejects(async () => routes['/api/admin/usage']({ user: { id: 2, role: 'user' }, res }), /admin_only/);
});

test('the calls of the month say the day the account was made, in either way it is kept', (t) => {
  const { users, options } = setup(t, { accounts: 16 });
  const user = users.find((u) => u.id === 8);
  assert.equal(usageOf({ ...user, created_at: '2026-10-26T09:15:00.000Z' }, options).mcp.since, '2026-10-26');
  assert.equal(usageOf({ ...user, created_at: '2026-10-26 09:15:00' }, options).mcp.since, '2026-10-26', 'SQLite’s own format too');
  assert.equal(usageOf(user, options).mcp.since, null, 'unknown: the whole month counts');
});
