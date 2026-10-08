/**
 * Entitlements: the catalog, grants from every source, the most generous
 * answer, the barriers, and plans moved in from an app's own columns.
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
import { createEntitlements, importUserPlans } from '../entitlements.js';
import { PLAN_CATALOGS, COMMON_FEATURES, pick } from '../plans.js';
import { HttpError } from '../http.js';

const DAY = 24 * 3600 * 1000;
const FEATURES = {
  'lists.max': { type: 'limit', default: null, label: 'more lists', aliases: ['listas_max'] },
  sharing: { type: 'flag', default: true, label: 'sharing lists', aliases: ['compartir'] },
  attachments: { type: 'flag', default: true, label: 'attaching files', aliases: ['adjuntos'] },
  mcp: { type: 'flag', default: true, label: 'using the app from an assistant' },
};
const PLANS = {
  free: { name: 'Free', features: { 'lists.max': 3, attachments: false, mcp: false } },
  plus: { name: 'Plus', features: { 'lists.max': 10, mcp: true } },
  pro: { name: 'Pro', features: {} },
};

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-entitlements-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT, plan TEXT, plan_expires_at TEXT)');
  database.run("INSERT INTO users (id, username, role) VALUES (1, 'ada', 'user'), (2, 'root', 'admin'), (3, 'eve', 'user')");
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  return database;
}
const ada = { id: 1, role: 'user' };
const root = { id: 2, role: 'admin' };

test('the catalog is validated: a typo stops the start instead of leaving a barrier open', (t) => {
  const database = setup(t);
  const bad = createEntitlements({ database, appId: 'tasks', features: FEATURES, plansJson: JSON.stringify({
    free: { name: 'Free', adjunto: false }, 'Bad Id': {}, pro: { name: 'Pro', 'lists.max': -1, sharing: 'yes' },
  }), defaultPlanOverride: 'gold' });
  assert.ok(bad.errors.some((e) => /"adjunto" is nothing that can be limited/.test(e)));
  assert.ok(bad.errors.some((e) => /Bad Id/.test(e)));
  assert.ok(bad.errors.some((e) => /"lists.max" must be a whole number/.test(e)));
  assert.ok(bad.errors.some((e) => /"sharing" must be true or false/.test(e)));
  assert.ok(bad.errors.some((e) => /default plan "gold"/.test(e)));
  assert.ok(createEntitlements({ database, appId: 'x', features: FEATURES, plansJson: '{nope' }).errors[0].startsWith('PLANS is not valid JSON'));
  const ok = createEntitlements({ database, appId: 'tasks', features: FEATURES, plans: PLANS, plansJson: '' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.describe().defaultPlan, 'free');
  assert.equal(ok.describe().several, true);
});

test('without a catalog: one plan, everything allowed (the open-source default)', (t) => {
  const database = setup(t);
  const e = createEntitlements({ database, appId: 'tasks', features: FEATURES, plansJson: '' });
  assert.deepEqual(e.errors, []);
  assert.equal(e.can(ada, 'attachments'), true);
  assert.equal(e.limit(ada, 'lists.max'), null);
  assert.equal(e.describe().several, false);
});

test('the old flat PLANS of Tasks, with its Spanish keys, still reads', (t) => {
  const database = setup(t);
  const e = createEntitlements({ database, appId: 'tasks', features: FEATURES, plansJson: JSON.stringify({
    free: { nombre: 'Gratis', listas_max: 5, adjuntos: false }, pro: { nombre: 'Pro' },
  }) });
  assert.deepEqual(e.errors, []);
  assert.equal(e.of(ada).plan.name, 'Gratis');
  assert.equal(e.limit(ada, 'lists.max'), 5);
  assert.equal(e.can(ada, 'attachments'), false);
});

test('the old plan id "gratis" in PLANS or DEFAULT_PLAN stops the start, naming "free"', (t) => {
  const database = setup(t);
  const inPlans = createEntitlements({ database, appId: 'tasks', features: FEATURES, plansJson: JSON.stringify({
    gratis: { name: 'Free' }, pro: { name: 'Pro' },
  }), defaultPlanOverride: '' });
  assert.deepEqual(inPlans.errors, ['PLANS: the plan "gratis" is called "free" now; rename it']);

  // Without PLANS too, and only that error: not also "not in the catalog".
  const asDefault = createEntitlements({
    database, appId: 'tasks', features: FEATURES, plans: { free: { name: 'Free' } }, plansJson: '', defaultPlanOverride: 'gratis',
  });
  assert.deepEqual(asDefault.errors, ['DEFAULT_PLAN: the plan "gratis" is called "free" now; set DEFAULT_PLAN=free']);

  const renamed = createEntitlements({ database, appId: 'tasks', features: FEATURES, plansJson: JSON.stringify({
    free: { name: 'Free' }, pro: { name: 'Pro' },
  }), defaultPlanOverride: 'free' });
  assert.deepEqual(renamed.errors, []);
});

test('grants: a window, the most generous wins, the admin is never limited', (t) => {
  const database = setup(t);
  let now = Date.parse('2026-03-01T12:00:00Z');
  const e = createEntitlements({ database, appId: 'tasks', features: FEATURES, plans: PLANS, plansJson: '', clock: () => now });
  assert.equal(e.of(ada).plan.id, 'free');
  assert.equal(e.limit(ada, 'lists.max'), 3);
  assert.equal(e.limit(root, 'lists.max'), null, 'the admin');
  assert.equal(e.can(root, 'attachments'), true);

  // A subscription for a month, and a one-off purchase of attachments for life.
  e.grant({ subjectId: 1, plan: 'plus', source: 'stripe', externalRef: 'sub_1', endsAt: new Date(now + 30 * DAY).toISOString() });
  e.grant({ subjectId: 1, feature: 'tasks.attachments', value: true, source: 'stripe', externalRef: 'order_9' });
  let entitled = e.of(ada);
  assert.equal(entitled.plan.id, 'plus');
  assert.ok(entitled.ends);
  assert.equal(entitled.features['lists.max'], 10);
  assert.equal(entitled.features.attachments, true, 'bought separately');
  assert.equal(e.can(ada, 'mcp'), true);

  // A gift of 50 lists and the admin's own limit of 5: the most generous wins.
  e.grant({ subjectId: 1, feature: 'lists.max', value: 50, source: 'promo' });
  e.grant({ subjectId: 1, feature: 'lists.max', value: 5, source: 'admin' });
  assert.equal(e.limit(ada, 'lists.max'), 50);

  // Rows for another app, or for a plan that no longer exists, are ignored
  // (grant() refuses to write them; a central service might).
  assert.throws(() => e.grant({ subjectId: 1, feature: 'next.projects.max', value: 999, source: 'remote' }),
    (err) => err.code === 'feature_unknown');
  const stamp = new Date(now).toISOString();
  database.run(`INSERT INTO entitlement_grants (subject_type, subject_id, feature, value, source, starts_at, created_at)
    VALUES ('user', 1, 'next.projects.max', '999', 'remote', ?, ?)`, stamp, stamp);
  database.run("INSERT INTO entitlement_grants (subject_type, subject_id, plan, source, starts_at, created_at) VALUES ('user', 1, 'gold', 'remote', ?, ?)",
    stamp, stamp);
  assert.equal(e.of(ada).plan.id, 'plus');

  // The subscription lapses on its own; the lifetime purchase stays.
  now += 31 * DAY;
  entitled = e.of(ada);
  assert.equal(entitled.plan.id, 'free');
  assert.equal(entitled.features.attachments, true);
  assert.equal(entitled.features.mcp, false);

  // Cancelled at the provider: revoked by its reference.
  assert.equal(e.revoke({ source: 'stripe', externalRef: 'order_9' }), 1);
  assert.equal(e.can(ada, 'attachments'), false);
});

test('PLANS=cronum-work: the suite’s catalog, read for the features the app has', (t) => {
  const database = setup(t);
  const features = { ...pick(COMMON_FEATURES, ['retention.days', 'assign', 'mcp', 'mcp.calls_per_day']), 'lists.max': FEATURES['lists.max'] };
  const e = createEntitlements({ database, appId: 'tasks', features, plansJson: 'cronum-work' });
  assert.deepEqual(e.errors, []);
  assert.deepEqual(e.describe().plans.map((p) => [p.id, p.name]), [['free', 'Free'], ['pro', 'Pro'], ['team', 'Team']]);
  assert.equal(e.describe().defaultPlan, 'free');
  assert.deepEqual(e.of(ada).features, { 'retention.days': 90, assign: false, mcp: true, 'mcp.calls_per_day': 100, 'lists.max': 20 });
  e.grant({ subjectId: 1, plan: 'pro', source: 'paddle' });
  assert.deepEqual(e.of(ada).features, { 'retention.days': null, assign: true, mcp: true, 'mcp.calls_per_day': 1000, 'lists.max': null });

  // A feature the catalog doesn't set would be left unlimited: the start stops instead.
  const loose = createEntitlements({ database, appId: 'x', features: { ...features, 'boards.max': { type: 'limit' } }, plansJson: 'cronum-work' });
  assert.ok(loose.errors.some((m) => /plan "free" says nothing of "boards.max"/.test(m)));
  assert.match(createEntitlements({ database, appId: 'x', features, plansJson: 'cronum-play' }).errors[0], /no catalog of the suite \(cronum-work\)/);
  assert.match(createEntitlements({ database, appId: 'x', features, plansJson: 'cronum-work', defaultPlanOverride: 'gratis' }).errors[0],
    /DEFAULT_PLAN=free/, 'an old DEFAULT_PLAN stops the start, naming the new one');
});

test('the suite’s catalog: every plan sets every feature, and each one gives at least what the one before it', () => {
  for (const [name, plans] of Object.entries(PLAN_CATALOGS)) {
    const ids = Object.keys(plans);
    const keys = Object.keys(plans[ids[0]].features);
    for (const key of Object.keys(COMMON_FEATURES)) assert.ok(keys.includes(key), `${name}: ${key}`);
    for (let i = 1; i < ids.length; i++) {
      const [before, after] = [plans[ids[i - 1]].features, plans[ids[i]].features];
      assert.deepEqual(Object.keys(after).sort(), [...keys].sort(), `${name}/${ids[i]} sets the same features`);
      for (const key of keys) {
        const more = typeof before[key] === 'boolean' ? (!before[key] || after[key])
          : after[key] === null || (before[key] !== null && after[key] >= before[key]);
        assert.ok(more, `${name}: ${ids[i]} gives no less ${key} than ${ids[i - 1]}`);
      }
    }
  }
  assert.throws(() => pick(COMMON_FEATURES, ['nope']), /not a common feature/);
});

test('cutoff: what Free keeps 90 days counts them from when Pro ended', (t) => {
  const database = setup(t);
  let now = Date.parse('2026-03-01T12:00:00Z');
  const features = pick(COMMON_FEATURES, ['retention.days', 'assign']);
  const e = createEntitlements({ database, appId: 'tasks', features, plansJson: 'cronum-work', clock: () => now });
  const edge = (days) => new Date(now - days * DAY).toISOString();
  assert.equal(e.cutoff(ada, 'retention.days'), edge(90), 'always on Free: older than 90 days goes');
  assert.equal(e.cutoff(root, 'retention.days'), null, 'the admin keeps everything');
  assert.throws(() => e.cutoff(ada, 'assign'), /not a limit/);

  // Pro for a month: nothing goes while it lasts, nor for 90 days after it ends.
  e.grant({ subjectId: 1, plan: 'pro', source: 'paddle', externalRef: 'sub_1', endsAt: new Date(now + 30 * DAY).toISOString() });
  assert.equal(e.cutoff(ada, 'retention.days'), null);
  now += 31 * DAY;
  assert.equal(e.of(ada).plan.id, 'free');
  assert.equal(e.cutoff(ada, 'retention.days'), null, 'a day after Pro ended');
  now += 88 * DAY;
  assert.equal(e.cutoff(ada, 'retention.days'), null, '89 days after');
  now += 2 * DAY;
  assert.equal(e.cutoff(ada, 'retention.days'), edge(90), '91 days after: back to the plain 90 days');

  // Revoked (a cancellation, a refund) counts as its end too, and so does a single feature given for a while.
  e.grant({ subjectId: 1, plan: 'pro', source: 'paddle', externalRef: 'sub_2' });
  now += DAY;
  e.revoke({ source: 'paddle', externalRef: 'sub_2' });
  now += DAY;
  assert.equal(e.cutoff(ada, 'retention.days'), null, 'cancelled yesterday');
  now += 100 * DAY;
  e.grant({ subjectId: 1, feature: 'retention.days', value: 365, source: 'promo', endsAt: new Date(now + DAY).toISOString() });
  now += 2 * DAY;
  assert.equal(e.cutoff(ada, 'retention.days'), null, 'a year of keeping, ended yesterday');
  // Something less generous ending changes nothing.
  now += 100 * DAY;
  e.grant({ subjectId: 1, feature: 'retention.days', value: 30, source: 'admin', endsAt: new Date(now + DAY).toISOString() });
  now += 2 * DAY;
  assert.equal(e.cutoff(ada, 'retention.days'), edge(90));
});

test('countDaily: calls of the day per person, refused ones not counted, back the next day', (t) => {
  const database = setup(t);
  let now = Date.parse('2026-03-01T23:00:00Z');
  const features = pick(COMMON_FEATURES, ['mcp.calls_per_day']);
  const e = createEntitlements({ database, appId: 'tasks', features,
    plansJson: JSON.stringify({ free: { name: 'Free', 'mcp.calls_per_day': 2 }, plus: { name: 'Plus', 'mcp.calls_per_day': 1 }, pro: { name: 'Pro', 'mcp.calls_per_day': 5 } }),
    clock: () => now });
  assert.deepEqual(e.errors, []);
  assert.equal(e.countDaily(ada, 'mcp.calls_per_day').used, 1);
  assert.equal(e.countDaily(ada, 'mcp.calls_per_day').allowed, true);
  const spent = e.countDaily(ada, 'mcp.calls_per_day');
  assert.deepEqual(spent, { allowed: false, used: 2, limit: 2, plan: 'free', plan_name: 'Free', more: { id: 'pro', name: 'Pro', limit: 5 } },
    'the next plan with more, skipping one with less');
  assert.equal(e.countDaily(ada, 'mcp.calls_per_day').used, 2, 'a refused call is not counted');
  assert.equal(e.countDaily({ id: 3, role: 'user' }, 'mcp.calls_per_day').allowed, true, 'each person has their own');
  assert.deepEqual(e.countDaily(root, 'mcp.calls_per_day'), { allowed: true, used: null, limit: null, plan: 'free', plan_name: 'Free', more: null });

  now += 2 * 3600 * 1000;   // past midnight UTC
  assert.equal(e.countDaily(ada, 'mcp.calls_per_day').used, 1);
  assert.deepEqual(database.all('SELECT day FROM entitlement_usage WHERE user_id = 1').map((r) => r.day), ['2026-03-02'], 'yesterday is cleared');
  e.grant({ subjectId: 1, plan: 'pro', source: 'paddle' });
  assert.deepEqual([e.countDaily(ada, 'mcp.calls_per_day').limit, e.countDaily(ada, 'mcp.calls_per_day').more], [5, null]);
});

test('an organization’s plan covers its members', (t) => {
  const database = setup(t);
  const e = createEntitlements({ database, appId: 'tasks', features: FEATURES, plans: PLANS, plansJson: '',
    organizationsOf: (user) => (user.id === 3 ? [7] : []) });
  e.grant({ subjectType: 'organization', subjectId: 7, plan: 'pro', quantity: 5, source: 'stripe' });
  assert.equal(e.of({ id: 3, role: 'user' }).plan.id, 'pro', 'a member of household 7');
  assert.equal(e.of(ada).plan.id, 'free', 'not a member');
  assert.equal(e.of(ada, { organizationId: 7 }).plan.id, 'pro', 'acting inside the organization');
});

test('the barriers: 402 with what the interface and the assistant need', (t) => {
  const database = setup(t);
  const e = createEntitlements({ database, appId: 'tasks', features: FEATURES, plans: PLANS, plansJson: '' });
  assert.throws(() => e.require(ada, 'attachments'),
    (err) => err instanceof HttpError && err.status === 402 && err.code === 'plan_feature'
      && err.extra.feature === 'attachments' && err.extra.plan === 'free');
  assert.throws(() => e.require(ada, 'lists.max', { current: 3 }),
    (err) => err.code === 'plan_limit' && err.extra.limit === 3 && err.extra.current === 3);
  e.require(ada, 'lists.max', { current: 2 });
  e.require(ada, 'sharing');
  assert.throws(() => e.can(ada, 'teleport'), /Unknown feature/);
  assert.equal(e.allows(ada, { name: 'list_lists' }), true, 'tools without a feature are always allowed');
  assert.equal(e.allows(ada, { name: 'list_lists', feature: 'mcp' }),
    'The Free plan does not include using the app from an assistant.');
  assert.equal(e.allows(root, { name: 'list_lists', feature: 'mcp' }), true);
});

test('the admin sets a plan: the previous admin grant ends, a subscription is left alone', (t) => {
  const database = setup(t);
  const e = createEntitlements({ database, appId: 'tasks', features: FEATURES, plans: PLANS, plansJson: '' });
  e.grant({ subjectId: 1, plan: 'plus', source: 'stripe', externalRef: 'sub_2' });
  e.setPlan(1, 'pro', { endsAt: '2099-01-01T00:00:00Z' });
  e.setPlan(1, 'plus');
  const active = e.grantsOf('user', 1).filter((g) => !g.revoked_at);
  assert.deepEqual(active.map((g) => [g.plan, g.source]).sort(), [['plus', 'admin'], ['plus', 'stripe']]);
  e.setPlan(1, null);
  assert.equal(e.grantsOf('user', 1).filter((g) => !g.revoked_at && g.source === 'admin').length, 0);
  assert.throws(() => e.setPlan(1, 'gold'), (err) => err.code === 'plan_unknown');
});

test('plans moved in from the users table of an app (Tasks)', (t) => {
  const database = setup(t);
  database.run("UPDATE users SET plan = 'pro', plan_expires_at = '2099-12-31 23:59:59' WHERE id = 1");
  database.run("UPDATE users SET plan = 'plus' WHERE id = 3");
  assert.equal(database.tx(() => importUserPlans(database)), 2);
  const e = createEntitlements({ database, appId: 'tasks', features: FEATURES, plans: PLANS, plansJson: '' });
  assert.equal(e.of(ada).plan.id, 'pro');
  assert.equal(e.of(ada).ends, '2099-12-31T23:59:59.000Z');
  assert.equal(e.of({ id: 3, role: 'user' }).plan.id, 'plus');
});
