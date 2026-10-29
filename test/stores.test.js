/**
 * Store purchases next to the web's (P6 and P7): the store instance of billing on the same tables,
 * its routes, the store's webhook as a trigger, the account's plan from both, the overview, the
 * account deletion and what goes with an account. With stand-ins for a store and its adapter
 * (fake-store.js) and for the web's provider (the suite's signed one); synthetic people and random
 * secrets.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { createRouter, sendJson, sendError } from '../http.js';
import { createAccounts } from '../accounts.js';
import { createEntitlements } from '../entitlements.js';
import { createOrganizations } from '../organizations.js';
import { createAudit } from '../audit.js';
import {
  createBilling, registerBillingApi, signedProvider, signPayload, combinedBilling, registerBillingOverviewApi,
} from '../billing.js';
import { createStoreBilling, registerStoreApi } from '../stores.js';
import { registerStoreProvider } from '../providers.js';
import { resolveConfig } from '../config.js';
import { createSuite, createApp, SuiteConfigError } from '../app.js';
import { randomToken, sha256 } from '../crypto.js';
import {
  PROVIDER, AUTH, SIGNING, KEY, PRODUCTS, MONTHLY, YEARLY, LIFETIME, MANAGE_URLS, fakeStore, storeAdapter, storeProvider,
  subscription, purchase, webhook,
} from './fake-store.js';

const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const SECRET = 'a-shared-secret-of-the-web-provider';
const WEB = 'web-provider';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WEB_PRODUCTS = {
  'pro-web-yearly': { plan: 'pro', kind: 'subscription' },
  'fleet-monthly': { plan: 'fleet', kind: 'subscription', for: 'organization' },
};
const PLANS = {
  free: { name: 'Free', features: { 'capture.native': false, 'viewers.max': 0 } },
  fleet: { name: 'Fleet', features: { 'capture.native': false, 'viewers.max': 0 } },
  pro: { name: 'Pro', features: { 'capture.native': true, 'viewers.max': 30 } },
};
const FEATURES = { 'capture.native': { type: 'flag', default: false }, 'viewers.max': { type: 'limit', default: 0 } };

// The stand-in as a provider STORE_BILLING names, reading this store's server. Each test file runs
// in a process of its own: what is registered here stays here.
const shop = fakeStore({ get now() { return Date.now(); } });
registerStoreProvider(storeProvider(shop));

/** One install: its database, the web's billing and the stores', and their routes over HTTP. */
async function setup(t, { now = '2026-11-01T10:00:00Z', sandbox = true, ignoreUnknownProducts = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-stores-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const clock = { now: Date.parse(now) };
  const time = () => clock.now;
  const api = fakeStore(clock);
  const logs = [];
  const log = (line) => logs.push(line);
  const accounts = createAccounts({ database, clock: time });
  let organizations = null;
  const entitlements = createEntitlements({
    database, appId: 'test', clock: time, features: FEATURES, plans: PLANS, plansJson: null, defaultPlanOverride: null,
    organizationsOf: (user) => organizations.organizationsOf(user),
  });
  organizations = createOrganizations({ database, seatsOf: entitlements.seatsOf, clock: time });
  const audit = createAudit({ database, trustProxy: '', clock: time });
  const provider = storeAdapter({ auth: AUTH, key: KEY, products: PRODUCTS, api, clock: time, sandbox });
  const stores = createStoreBilling({ database, entitlements, provider, products: PRODUCTS, audit, clock: time, log, ignoreUnknownProducts });
  assert.deepEqual(stores.errors, []);
  const web = createBilling({
    database, entitlements, provider: signedProvider({ id: WEB, secret: SECRET }), products: WEB_PRODUCTS, audit, clock: time, log,
  });
  const ada = accounts.create({ username: 'ada', email: 'ada@example.com' });
  const bob = accounts.create({ username: 'bob', email: 'bob@example.com' });

  const router = createRouter();
  registerBillingApi(router, { billing: web, organizations, baseUrl: 'https://app.example.com' });
  registerStoreApi(router, { stores });
  registerBillingOverviewApi(router, { instances: [web, stores], entitlements, organizations, clock: time });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const match = router.match(req.method, url.pathname);
      if (!match?.handler) return sendJson(res, 404, { error: 'not_found' });
      const user = req.headers['x-user'] ? accounts.byId(Number(req.headers['x-user'])) : null;
      await match.handler({ req, res, params: match.params, query: url.searchParams, user });
    } catch (err) {
      sendError(res, err);
    }
    return undefined;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, { as, body, headers = {} } = {}) => {
    const res = await fetch(base + pathname, {
      method,
      headers: { ...(as ? { 'x-user': String(as) } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  /** A webhook from the store, at the clock's time; `delivery` sends one again as it was. */
  const deliver = async (event, { delivery = webhook(event, { at: clock.now }) } = {}) => {
    const res = await call('POST', `/api/billing/${PROVIDER}/webhook`, { body: delivery.body, headers: delivery.headers });
    return { ...res, delivery };
  };
  const customerOf = async (user) => (await call('GET', '/api/billing/stores/customer', { as: user.id })).body.customer;
  const planOf = (user) => entitlements.of(accounts.byId(user.id)).plan.id;
  return {
    database, clock, api, logs, accounts, entitlements, organizations, audit, provider, stores, web, ada, bob, call, deliver,
    customerOf, planOf,
  };
}

const grantsOf = (database, user, source) => database.all(`SELECT * FROM entitlement_grants WHERE subject_type = 'user'
  AND subject_id = ? AND source = ? ORDER BY id`, user.id, source);

test('the customer: a random id per account, the same each time, another in another install; never who they are', async (t) => {
  const one = await setup(t);
  assert.equal((await one.call('GET', '/api/billing/stores/customer')).status, 401);
  const first = await one.call('GET', '/api/billing/stores/customer', { as: one.ada.id });
  assert.equal(first.status, 200);
  assert.equal(first.body.provider, PROVIDER);
  assert.match(first.body.customer, UUID, 'also what StoreKit takes as appAccountToken and Google Play as obfuscatedAccountId');
  assert.equal(await one.customerOf(one.ada), first.body.customer, 'made once');
  assert.notEqual(await one.customerOf(one.bob), first.body.customer);
  // Only these two fields, and nothing of the person: the id is random hex, so look for what hex can't hold.
  assert.deepEqual(Object.keys(first.body).sort(), ['customer', 'provider']);
  assert.equal(JSON.stringify(first.body).includes('ada@example.com'), false);
  assert.equal(Object.values(first.body).includes('ada'), false);
  assert.equal(one.api.calls.length, 0, 'the store hears of it from the app, when the person buys');
  const two = await setup(t);
  assert.notEqual(await two.customerOf(two.ada), first.body.customer, 'per install: another product\'s app never sees this id');
});

test('a purchase in the app: the webhook reads the customer again and grants; the plan is the store\'s and the web\'s together', async (t) => {
  const s = await setup(t);
  const now = s.clock.now;
  const ada = await s.customerOf(s.ada);
  s.api.customer(ada).subscriptions[MONTHLY] = subscription({ purchased: now, expires: now + 30 * DAY });
  assert.equal((await s.deliver({ type: 'purchased', customer: ada, product: MONTHLY }, {
    delivery: { ...webhook({ type: 'purchased', customer: ada, product: MONTHLY }), headers: { authorization: 'Bearer wrong-wrong-wrong' } },
  })).status, 401);
  const sold = await s.deliver({ type: 'purchased', customer: ada, product: MONTHLY });
  assert.deepEqual(sold.body, { received: 1, outcomes: ['granted'] });
  assert.equal(s.planOf(s.ada), 'pro');
  assert.equal(s.entitlements.can(s.accounts.byId(s.ada.id), 'capture.native'), true);
  const [grant] = grantsOf(s.database, s.ada, PROVIDER);
  assert.equal(grant.ends_at, iso(now + 33 * DAY), 'until the paid date, plus the grace days');
  assert.equal(grant.note, 'pro-monthly');
  assert.match(grant.external_ref, /^app_store:com\.example\.app\.pro\.monthly:[0-9a-f]{16}$/);
  assert.deepEqual(s.audit.list({ action: 'billing.' }).map((e) => [e.action, e.meta.provider]), [['billing.granted', PROVIDER]]);
  assert.deepEqual(s.api.calls.map((c) => c.customer), [ada], 'one look, at this customer');

  // Bob pays on the web; Ada on both: one plan, whichever source gives it.
  s.web.apply({
    id: 'web_1', type: 'subscription', ref: 'sub_bob', subject: { type: 'user', id: s.bob.id }, customer: 'ctm_bob',
    product: 'pro-web-yearly', status: 'active', periodEnd: iso(now + 365 * DAY),
  });
  s.web.apply({
    id: 'web_2', type: 'subscription', ref: 'sub_ada', subject: { type: 'user', id: s.ada.id }, customer: 'ctm_ada',
    product: 'pro-web-yearly', status: 'active', periodEnd: iso(now + 365 * DAY),
  });
  assert.equal(s.planOf(s.bob), 'pro');
  s.api.customer(ada).subscriptions[MONTHLY] = subscription({ purchased: now, expires: now + 30 * DAY, refundedAt: now });
  assert.deepEqual((await s.deliver({ type: 'refunded', customer: ada, product: MONTHLY })).body.outcomes, ['revoked']);
  assert.equal(s.planOf(s.ada), 'pro', 'the web\'s subscription still gives it');
  assert.deepEqual(s.database.all('SELECT provider, COUNT(*) AS n FROM billing_customers GROUP BY provider ORDER BY provider')
    .map((r) => [r.provider, r.n]), [[PROVIDER, 1], [WEB, 2]], 'one table, each under its provider');
});

test('renewals, the store\'s grace, a charge that keeps failing, a cancellation and the end', async (t) => {
  const s = await setup(t);
  const now = s.clock.now;
  const ada = await s.customerOf(s.ada);
  const held = s.api.customer(ada);
  const outcomes = async (type) => (await s.deliver({ type, customer: ada, product: YEARLY })).body.outcomes;
  held.subscriptions[YEARLY] = subscription({ purchased: now, expires: now + 7 * DAY, trial: true });
  assert.deepEqual(await outcomes('purchased'), ['granted']);
  assert.equal(s.stores.subscriptionsOf({ type: 'user', id: s.ada.id })[0].status, 'trialing');

  s.clock.now = now + 7 * DAY;
  held.subscriptions[YEARLY] = subscription({ purchased: s.clock.now, expires: s.clock.now + 365 * DAY });
  assert.deepEqual(await outcomes('renewed'), ['extended']);

  // A year on, the charge fails: the store's grace keeps it; then the store goes on trying.
  s.clock.now = now + 372 * DAY;
  const due = s.clock.now - DAY;
  held.subscriptions[YEARLY] = subscription({ purchased: now + 7 * DAY, expires: due, billingIssueAt: due, graceUntil: due + 16 * DAY });
  assert.deepEqual(await outcomes('billing_issue'), ['extended']);
  assert.equal(grantsOf(s.database, s.ada, PROVIDER)[0].ends_at, iso(due + 19 * DAY));
  s.clock.now = due + 17 * DAY;
  held.subscriptions[YEARLY].graceUntil = null;
  assert.deepEqual(await outcomes('billing_issue'), ['kept'], 'past due: nothing changes, the grant lapses on its own');
  s.clock.now = due + 20 * DAY;
  assert.equal(s.planOf(s.ada), 'free');
  assert.deepEqual(await outcomes('expired'), ['revoked'], 'the store gave up: the lapsed grant is closed');
  assert.equal(s.stores.subscriptionsOf({ type: 'user', id: s.ada.id })[0].status, 'ended');

  // Bought again, then cancelled: paid until the end, then ended.
  held.subscriptions[YEARLY] = subscription({ purchased: s.clock.now, expires: s.clock.now + 365 * DAY });
  assert.deepEqual(await outcomes('renewed'), ['granted']);
  held.subscriptions[YEARLY].cancelledAt = s.clock.now;
  const before = grantsOf(s.database, s.ada, PROVIDER)[0].ends_at;
  assert.deepEqual(await outcomes('cancelled'), ['extended'], 'renewal off: read again, now ending');
  assert.equal(grantsOf(s.database, s.ada, PROVIDER)[0].ends_at, before, 'paid until the end, as it was');
  assert.equal(s.stores.subscriptionsOf({ type: 'user', id: s.ada.id })[0].ending, true, 'it ends, it doesn’t renew');
  assert.equal(s.planOf(s.ada), 'pro');
  s.clock.now += 366 * DAY;
  assert.deepEqual(await outcomes('expired'), ['revoked']);
  assert.equal(s.planOf(s.ada), 'free');
});

test('a refund takes it back and the period it paid back doesn\'t return; the store taking the refund back does', async (t) => {
  const s = await setup(t);
  const now = s.clock.now;
  const ada = await s.customerOf(s.ada);
  const held = s.api.customer(ada);
  held.subscriptions[MONTHLY] = subscription({ purchased: now, expires: now + 30 * DAY, transaction: '2000000000000042' });
  await s.deliver({ type: 'purchased', customer: ada, product: MONTHLY });
  // Support refunded it; the store may not say so in the customer yet, the webhook names the transaction.
  assert.deepEqual((await s.deliver({
    type: 'refunded', customer: ada, product: MONTHLY, transaction: '2000000000000042',
  })).body.outcomes, ['revoked']);
  assert.equal(s.planOf(s.ada), 'free');
  assert.deepEqual(s.audit.list({ action: 'billing.' }).map((e) => e.action), ['billing.revoked', 'billing.granted']);
  // A later reading that says nothing of it: the period paid back gives nothing.
  s.clock.now += 3 * 1000;
  assert.deepEqual((await s.call('POST', '/api/billing/stores/sync', { as: s.ada.id })).body.outcomes, ['unchanged']);
  assert.equal(s.planOf(s.ada), 'free');
  held.subscriptions[MONTHLY].refundedAt = now + DAY;
  assert.deepEqual((await s.deliver({ type: 'renewed', customer: ada, product: MONTHLY })).body.outcomes, ['unchanged'],
    'refunded, said again');
  // The store reversed it.
  held.subscriptions[MONTHLY].refundedAt = null;
  assert.deepEqual((await s.deliver({ type: 'refund_reversed', customer: ada, product: MONTHLY })).body.outcomes, ['granted']);
  assert.equal(s.planOf(s.ada), 'pro');
});

test('a transfer: the account the purchase moved to gets it, the one it left loses it', async (t) => {
  const s = await setup(t);
  const now = s.clock.now;
  const ada = await s.customerOf(s.ada);
  const bob = await s.customerOf(s.bob);
  s.api.customer(ada).subscriptions[MONTHLY] = subscription({ purchased: now, expires: now + 30 * DAY });
  await s.deliver({ type: 'purchased', customer: ada, product: MONTHLY });
  assert.equal(s.planOf(s.ada), 'pro');
  // The store moved it (a restore under Bob's account, were restores allowed to transfer).
  s.api.customer(bob).subscriptions[MONTHLY] = s.api.customer(ada).subscriptions[MONTHLY];
  s.api.customer(ada).subscriptions = {};
  s.clock.now += 60 * 1000;
  const moved = await s.deliver({ type: 'transferred', customer: bob, customers: [ada] });
  assert.deepEqual(moved.body.outcomes, ['granted', 'revoked']);
  assert.deepEqual([s.planOf(s.ada), s.planOf(s.bob)], ['free', 'pro']);
  assert.deepEqual(s.stores.subscriptionsOf({ type: 'user', id: s.ada.id }).map((r) => r.status), ['ended']);
});

test('a one-off purchase: granted once, and refunded when the store no longer lists it', async (t) => {
  const s = await setup(t);
  const now = s.clock.now;
  const ada = await s.customerOf(s.ada);
  const held = s.api.customer(ada);
  held.purchases[LIFETIME] = [purchase({ id: 'cadba0c81b', purchased: now })];
  assert.deepEqual((await s.deliver({ type: 'purchased', customer: ada, product: LIFETIME })).body.outcomes, ['granted']);
  s.clock.now += 5000;
  assert.deepEqual((await s.call('POST', '/api/billing/stores/sync', { as: s.ada.id })).body.outcomes, ['unchanged']);
  assert.equal(grantsOf(s.database, s.ada, PROVIDER)[0].ends_at, null, 'for good');
  held.purchases = {};
  assert.deepEqual((await s.deliver({ type: 'refunded', customer: ada, product: LIFETIME })).body.outcomes, ['revoked']);
  assert.equal(s.planOf(s.ada), 'free');
});

test('a reading that answered before a purchase takes nothing back: a subscription\'s end is stale, a later one-off stays', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-stores-race-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const clock = { now: Date.parse('2026-11-01T10:00:00Z') };
  const accounts = createAccounts({ database, clock: () => clock.now });
  const entitlements = createEntitlements({
    database, appId: 'test', clock: () => clock.now, features: FEATURES, plans: PLANS, plansJson: null, defaultPlanOverride: null,
  });
  // A store whose answer comes when the test says, read at the time it was asked.
  const pending = [];
  const provider = {
    id: PROVIDER, kind: 'store', manage: () => null, parseWebhook: async () => null,
    customerEvents: (customer, { cause }) => {
      const asked = iso(clock.now);
      return new Promise((resolve) => pending.push(() => resolve({ at: asked, events: [], present: new Set(), customer, cause })));
    },
  };
  const stores = createStoreBilling({ database, entitlements, provider, products: PRODUCTS, clock: () => clock.now, log: () => {} });
  const ada = accounts.create({ username: 'ada' });
  const customer = stores.customerFor(ada.id);
  const reading = stores.sync(ada.id);
  // Meanwhile Ada buys, and the webhook's newer reading applies it.
  clock.now += 2000;
  assert.equal(stores.apply({ id: 'w/1', type: 'purchase', ref: 'app_store:life:k:1', customer, product: 'pro-lifetime', occurredAt: iso(clock.now) }), 'granted');
  assert.equal(stores.apply({
    id: 'w/2', type: 'subscription', ref: 'app_store:monthly:k', customer, product: 'pro-monthly', status: 'active',
    occurredAt: iso(clock.now), periodEnd: iso(clock.now + 30 * DAY),
  }), 'granted');
  pending.shift()();
  assert.deepEqual(await reading, { received: 1, outcomes: ['stale'] }, 'the subscription\'s end, older than what is known');
  assert.equal(entitlements.grantsOf('user', ada.id).filter((g) => !g.revoked_at).length, 2, 'both still there');
  assert.deepEqual(database.all('SELECT event_id FROM billing_events ORDER BY rowid').map((r) => r.event_id), ['w/1', 'w/2'],
    'a stale reading leaves no row');
});

test('reading again what is already here writes nothing: no event row, no audit, however often it is read', async (t) => {
  const s = await setup(t);
  const now = s.clock.now;
  const ada = await s.customerOf(s.ada);
  const held = s.api.customer(ada);
  held.subscriptions[MONTHLY] = subscription({ purchased: now, expires: now + 30 * DAY });
  held.subscriptions[YEARLY] = subscription({ purchased: now - 400 * DAY, expires: now - 35 * DAY });
  assert.deepEqual((await s.deliver({ type: 'purchased', customer: ada, product: MONTHLY })).body.outcomes, ['granted', 'nothing']);
  const rows = () => [
    s.database.get('SELECT COUNT(*) AS n FROM billing_events WHERE provider = ?', PROVIDER).n, s.audit.list({ action: 'billing.' }).length,
  ];
  const before = rows();
  for (let i = 0; i < 10; i += 1) {
    s.clock.now += 3000;
    assert.deepEqual((await s.call('POST', '/api/billing/stores/sync', { as: s.ada.id })).body.outcomes, ['unchanged', 'unchanged']);
  }
  assert.deepEqual((await s.deliver({ type: 'renewed', customer: ada, product: MONTHLY })).body.outcomes, ['unchanged', 'unchanged'],
    'a webhook that says nothing new');
  assert.deepEqual(rows(), before, 'the active one and the old ended one alike');
  assert.equal(s.database.get("SELECT occurred_at FROM billing_subscriptions WHERE product = 'pro-monthly'").occurred_at, iso(s.clock.now),
    'only the time it was last known moves on');
  // What changes is applied, and kept, as ever.
  held.subscriptions[MONTHLY] = subscription({ purchased: now + 30 * DAY, expires: now + 60 * DAY });
  s.clock.now += 3000;
  assert.deepEqual((await s.call('POST', '/api/billing/stores/sync', { as: s.ada.id })).body.outcomes, ['extended', 'unchanged']);
  assert.deepEqual(rows(), [before[0] + 1, before[1] + 1]);
});

test('what a later reading can\'t tell is noted: a refund taken back, an older renewal\'s refund, a one-off refunded while listed', async (t) => {
  const s = await setup(t);
  const now = s.clock.now;
  const ada = await s.customerOf(s.ada);
  const held = s.api.customer(ada);
  const sync = async (user = s.ada) => {
    s.clock.now += 3000;
    return (await s.call('POST', '/api/billing/stores/sync', { as: user.id })).body.outcomes;
  };
  const outcomes = async (event) => (await s.deliver(event)).body.outcomes;

  // Refunded, then the refund taken back while the store still says when it was refunded: Pro, now and after.
  held.subscriptions[MONTHLY] = subscription({ purchased: now, expires: now + 30 * DAY, transaction: '2000000000000101' });
  assert.deepEqual(await outcomes({ type: 'purchased', customer: ada, product: MONTHLY }), ['granted']);
  s.clock.now = now + DAY;
  held.subscriptions[MONTHLY].refundedAt = now + DAY;
  const support = { type: 'refunded', customer: ada, product: MONTHLY, transaction: '2000000000000101' };
  assert.deepEqual(await outcomes(support), ['revoked']);
  assert.deepEqual(await outcomes({ type: 'refund_reversed', customer: ada, product: MONTHLY, transaction: '2000000000000101' }), ['granted']);
  assert.deepEqual(await sync(), ['unchanged'], 'the refund date the store took back takes nothing again');
  assert.equal(s.planOf(s.ada), 'pro');
  held.subscriptions[MONTHLY].refundedAt = s.clock.now;
  assert.deepEqual(await sync(), ['revoked'], 'a new refund is one');
  assert.equal(s.planOf(s.ada), 'free');

  // An older renewal refunded after the latest purchase: the period paid now stays, now and after.
  held.subscriptions[YEARLY] = subscription({ purchased: s.clock.now, expires: s.clock.now + 365 * DAY, transaction: '2000000000000202' });
  assert.deepEqual(await sync(), ['unchanged', 'granted']);
  s.clock.now += 1000;
  held.subscriptions[YEARLY].refundedAt = s.clock.now;
  assert.deepEqual(await outcomes({ ...support, product: YEARLY, transaction: '2000000000000150' }), ['unchanged', 'unchanged']);
  assert.deepEqual(await sync(), ['unchanged', 'unchanged']);
  assert.equal(s.planOf(s.ada), 'pro');

  // A one-off refunded by support, still listed: refunded until the store takes it back.
  const bob = await s.customerOf(s.bob);
  s.api.customer(bob).purchases[LIFETIME] = [purchase({ id: 'f00dbabe01', purchased: s.clock.now, transaction: '2000000000000303' })];
  assert.deepEqual(await outcomes({ type: 'purchased', customer: bob, product: LIFETIME }), ['granted']);
  // A delivery whose id looks like a note (sent with a stolen header value) is refused, whatever the adapter, and writes none.
  const [lifetime] = grantsOf(s.database, s.bob, PROVIDER);
  const forged = await s.deliver({
    id: `note:refunded/${lifetime.external_ref}`, type: 'purchased', customer: 'f2c1d1a4-0000-4000-8000-000000000001', product: LIFETIME,
  });
  assert.deepEqual([forged.status, forged.body.error], [400, 'invalid_event']);
  assert.deepEqual(await sync(s.bob), ['unchanged']);
  assert.equal(s.planOf(s.bob), 'pro');
  assert.deepEqual(await outcomes({ ...support, customer: bob, product: LIFETIME, transaction: '2000000000000999' }), ['unchanged'],
    'another transaction\'s refund');
  assert.deepEqual(await outcomes({ ...support, customer: bob, product: LIFETIME, transaction: '2000000000000303' }), ['revoked']);
  assert.deepEqual(await sync(s.bob), ['unchanged']);
  assert.equal(s.planOf(s.bob), 'free');
  assert.deepEqual(await outcomes({ type: 'refund_reversed', customer: bob, product: LIFETIME, transaction: '2000000000000303' }), ['granted']);
  assert.deepEqual(await sync(s.bob), ['unchanged']);
  assert.equal(s.planOf(s.bob), 'pro');

  const notes = s.database.all("SELECT event_id FROM billing_events WHERE provider = ? AND type = 'note' ORDER BY rowid", PROVIDER)
    .map((r) => r.event_id.replace(/:[0-9a-f]{16}/, ':<key>').replace(/@\d+$/, '@<ms>'));
  assert.deepEqual(notes, [
    'note:refund-cleared/app_store:com.example.app.pro.monthly:<key>@<ms>',
    'note:refund-cleared/app_store:com.example.app.pro.yearly:<key>@<ms>',
    'note:refunded/app_store:com.example.app.pro.lifetime:<key>:f00dbabe01',
    'note:refund-reversed/app_store:com.example.app.pro.lifetime:<key>:f00dbabe01',
  ], 'refs and times only, never a customer');
});

test('a person with a live store subscription buys no second one on the web (otherProviders); a group still can', async (t) => {
  const s = await setup(t);
  const now = s.clock.now;
  const web = createBilling({
    database: s.database, entitlements: s.entitlements, provider: signedProvider({ id: WEB, secret: SECRET }), products: WEB_PRODUCTS,
    clock: () => s.clock.now, log: () => {}, otherProviders: [PROVIDER],
  });
  assert.deepEqual(web.errors, []);
  const checkout = async (billing, subject, product = 'pro-web-yearly') => {
    try {
      await billing.checkoutUrl(subject, product, { returnUrl: 'https://app.example.com/' });
      return 'ok';
    } catch (err) {
      return `${err.status} ${err.code}`;
    }
  };
  const ada = await s.customerOf(s.ada);
  s.api.customer(ada).subscriptions[MONTHLY] = subscription({ purchased: now, expires: now + 30 * DAY });
  assert.equal(await checkout(web, { type: 'user', id: s.ada.id }), 'ok');
  await s.deliver({ type: 'purchased', customer: ada, product: MONTHLY });
  assert.equal(await checkout(web, { type: 'user', id: s.ada.id }), '409 already_subscribed', 'it would charge twice');
  assert.equal(await checkout(s.web, { type: 'user', id: s.ada.id }), 'ok', 'without otherProviders, as before');
  const fleet = s.organizations.create({ name: 'Fleet A', ownerId: s.ada.id });
  assert.equal(await checkout(web, { type: 'organization', id: fleet.id }, 'fleet-monthly'), 'ok', 'a group\'s is another subscription');
  s.clock.now = now + 31 * DAY;
  assert.deepEqual((await s.deliver({ type: 'expired', customer: ada, product: MONTHLY })).body.outcomes, ['revoked']);
  assert.equal(await checkout(web, { type: 'user', id: s.ada.id }), 'ok', 'ended in the store: the web sells again');
  assert.deepEqual(createBilling({ database: s.database, entitlements: s.entitlements, otherProviders: PROVIDER }).errors,
    ['otherProviders must be a list of provider ids']);
});

test('an account that goes takes what waited under its identity; a renewal after it waits for that login, still paying', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-stores-pending-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const now = Date.parse('2026-11-01T10:00:00Z');
  const accounts = createAccounts({ database, clock: () => now });
  const entitlements = createEntitlements({
    database, appId: 'test', clock: () => now, features: FEATURES, plans: PLANS, plansJson: null, defaultPlanOverride: null,
  });
  const ada = accounts.create({ username: 'ada' });
  // The identity is not linked to the account here yet: what is paid for it waits.
  const identities = {
    of: (userId) => (userId === ada.id ? { provider: 'workos', subject: 'user_test_ada' } : null),
    user: () => null,
  };
  const web = createBilling({
    database, entitlements, provider: signedProvider({ id: WEB, secret: SECRET }), products: WEB_PRODUCTS, identities,
    clock: () => now, log: () => {},
  });
  const renewal = (id) => ({
    id, type: 'subscription', ref: 'sub_ada', identity: { provider: 'workos', subject: 'user_test_ada' }, customer: 'ctm_ada',
    product: 'pro-web-yearly', status: 'active', periodEnd: iso(now + 365 * DAY),
  });
  assert.equal(web.apply(renewal('evt_1')), 'pending', 'paid for before the identity was linked here');
  assert.deepEqual(web.forget(ada.id), { grants: 0, subscriptions: 0, customers: 0, pending: 1 });
  assert.equal(database.get('SELECT COUNT(*) AS n FROM billing_pending').n, 0);
  accounts.remove(ada.id);
  assert.equal(web.apply(renewal('evt_2')), 'pending', 'still paid for: it waits, as for anyone without an account here');
  assert.equal(database.get('SELECT COUNT(*) AS n FROM billing_pending').n, 1);
});

test('another product\'s sale, or this app\'s for a customer it never gave out: kept by id only, and the store isn\'t asked', async (t) => {
  for (const ignoreUnknownProducts of [false, true]) {
    const s = await setup(t, { ignoreUnknownProducts });
    const ada = await s.customerOf(s.ada);
    const other = await s.deliver({ id: 'evt-other', type: 'purchased', customer: ada, product: 'com.other.app.premium' });
    assert.deepEqual(other.body.outcomes, ['foreign']);
    const sideways = await s.deliver({ id: 'evt-web', type: 'purchased', customer: ada, product: MONTHLY, store: 'web' });
    assert.deepEqual(sideways.body.outcomes, ['foreign'], 'the web\'s sale through the same store account: the web\'s billing has it');
    const nobody = await s.deliver({ id: 'evt-nobody', type: 'purchased', customer: 'f2c1d1a4-0000-4000-8000-000000000000', product: MONTHLY });
    assert.deepEqual(nobody.body.outcomes, ['ignored'], 'nobody here, not another product\'s');
    assert.equal(s.api.calls.length, 0, 'no lookup: the store is never asked about an id this install didn\'t give out');
    assert.deepEqual(s.database.all('SELECT event_id, type, outcome FROM billing_events WHERE provider = ? ORDER BY rowid', PROVIDER)
      .map((r) => [r.event_id, r.type, r.outcome]), [
      ['evt-other', 'subscription', 'foreign'], ['evt-web', 'subscription', 'foreign'], ['evt-nobody', 'subscription', 'ignored'],
    ]);
    assert.equal(s.database.get('SELECT COUNT(*) AS n FROM billing_subscriptions WHERE provider = ?', PROVIDER).n, 0);
    assert.ok(s.logs.every((line) => !line.includes(ada)), 'the log names no customer');
  }
  const strict = await setup(t, { sandbox: false });
  const ada = await strict.customerOf(strict.ada);
  assert.deepEqual((await strict.deliver({ type: 'purchased', sandbox: true, customer: ada, product: MONTHLY })).body.outcomes,
    ['foreign'], 'test purchases off');
});

test('sent twice, or failing: applied once, and a failure answers an error so the store sends it again', async (t) => {
  const s = await setup(t);
  const now = s.clock.now;
  const ada = await s.customerOf(s.ada);
  s.api.customer(ada).subscriptions[MONTHLY] = subscription({ purchased: now, expires: now + 30 * DAY });
  s.api.fail();
  const failed = await s.deliver({ type: 'purchased', customer: ada, product: MONTHLY });
  assert.deepEqual([failed.status, failed.body.error], [502, 'billing_provider_unavailable']);
  assert.equal(s.planOf(s.ada), 'free');
  const again = await s.deliver(null, { delivery: failed.delivery });
  assert.deepEqual(again.body.outcomes, ['granted']);
  assert.deepEqual((await s.deliver(null, { delivery: failed.delivery })).body.outcomes, ['duplicate']);
  assert.equal(grantsOf(s.database, s.ada, PROVIDER).length, 1);
  assert.equal((await s.deliver({ type: 'test', customer: ada })).body.received, 0, 'the store\'s test');
});

test('the sync after a purchase: one at a time, not too often, and nothing asked for an account that never bought', async (t) => {
  const s = await setup(t);
  const now = s.clock.now;
  assert.equal((await s.call('POST', '/api/billing/stores/sync')).status, 401);
  assert.deepEqual((await s.call('POST', '/api/billing/stores/sync', { as: s.bob.id })).body, { received: 0, outcomes: [] });
  assert.equal(s.api.calls.length, 0);
  const ada = await s.customerOf(s.ada);
  s.api.customer(ada).subscriptions[MONTHLY] = subscription({ purchased: now, expires: now + 30 * DAY });
  assert.deepEqual((await s.call('POST', '/api/billing/stores/sync', { as: s.ada.id })).body, { received: 1, outcomes: ['granted'] });
  assert.equal(s.planOf(s.ada), 'pro', 'without waiting for the webhook');
  const soon = await s.call('POST', '/api/billing/stores/sync', { as: s.ada.id });
  assert.deepEqual([soon.status, soon.body.error, soon.body.retry_after], [429, 'too_many_attempts', 3]);
  s.clock.now += 3000;
  const [one, two] = await Promise.all([s.stores.sync(s.ada.id), s.stores.sync(s.ada.id)]);
  assert.equal(one, two, 'the same reading');
  assert.equal(s.api.calls.length, 2);
});

test('the overview: what each source holds and how to manage it, a group\'s plan and the admin\'s; never a ref or a customer', async (t) => {
  const s = await setup(t);
  const now = s.clock.now;
  const ada = await s.customerOf(s.ada);
  s.api.customer(ada).subscriptions[MONTHLY] = subscription({ purchased: now, expires: now + 30 * DAY });
  await s.deliver({ type: 'purchased', customer: ada, product: MONTHLY });
  const fleet = s.organizations.create({ name: 'Fleet A', ownerId: s.ada.id });
  s.organizations.addMember(fleet.id, s.bob.id);
  s.web.apply({
    id: 'web_1', type: 'subscription', ref: 'sub_fleet', subject: { type: 'organization', id: fleet.id }, customer: 'ctm_fleet',
    product: 'fleet-monthly', status: 'active', periodEnd: iso(now + 30 * DAY), quantity: 3,
  });
  s.entitlements.setPlan(s.bob.id, 'pro', { endsAt: iso(now + 10 * DAY) });

  assert.equal((await s.call('GET', '/api/billing/overview')).status, 401);
  const mine = (await s.call('GET', '/api/billing/overview', { as: s.ada.id })).body;
  assert.deepEqual(mine, {
    plan: { id: 'pro', name: 'Pro', ends: iso(now + 33 * DAY) },
    sources: [
      {
        kind: 'web', provider: WEB, organization_id: fleet.id, product: 'fleet-monthly', plan: 'fleet', plan_name: 'Fleet',
        status: 'active', period_end: iso(now + 30 * DAY), ending: null, manage: { via: 'portal', organization_id: fleet.id },
      },
      {
        kind: 'store', provider: PROVIDER, product: 'pro-monthly', plan: 'pro', plan_name: 'Pro', status: 'active',
        period_end: iso(now + 30 * DAY), ending: false, store: 'app_store', sandbox: false,
        manage: { via: 'store', store: 'app_store', url: MANAGE_URLS.app_store },
      },
      { kind: 'organization', organization_id: fleet.id, name: 'Fleet A', plan: 'fleet', plan_name: 'Fleet', ends: iso(now + 33 * DAY) },
    ],
  });
  const text = JSON.stringify(mine);
  assert.equal(text.includes(ada) || text.includes('sub_fleet') || text.includes('ctm_') || /:[0-9a-f]{16}/.test(text), false);
  const bobs = (await s.call('GET', '/api/billing/overview', { as: s.bob.id })).body;
  assert.deepEqual(bobs.sources.map((source) => source.kind), ['organization', 'admin'], 'a member doesn\'t manage the group\'s');
  assert.deepEqual(bobs.sources[1], { kind: 'admin', plan: 'pro', plan_name: 'Pro', ends: iso(now + 10 * DAY) });
});

test('an account that goes: each instance forgets its links, subscriptions and grants; the group\'s stay; deletion asks both', async (t) => {
  const s = await setup(t);
  const now = s.clock.now;
  const ada = await s.customerOf(s.ada);
  s.api.customer(ada).subscriptions[MONTHLY] = subscription({ purchased: now, expires: now + 30 * DAY });
  await s.deliver({ type: 'purchased', customer: ada, product: MONTHLY });
  s.web.apply({
    id: 'web_1', type: 'subscription', ref: 'sub_ada', subject: { type: 'user', id: s.ada.id }, customer: 'ctm_ada',
    product: 'pro-web-yearly', status: 'active', periodEnd: iso(now + 365 * DAY),
  });
  const fleet = s.organizations.create({ name: 'Fleet A', ownerId: s.ada.id });
  s.web.apply({
    id: 'web_2', type: 'subscription', ref: 'sub_fleet', subject: { type: 'organization', id: fleet.id }, customer: 'ctm_fleet',
    product: 'fleet-monthly', status: 'active', periodEnd: iso(now + 30 * DAY),
  });
  s.entitlements.setPlan(s.ada.id, 'pro');
  assert.deepEqual(s.stores.forget(s.ada.id), { grants: 1, subscriptions: 1, customers: 1, pending: 0 });
  assert.deepEqual(s.web.forget(s.ada.id), { grants: 1, subscriptions: 1, customers: 1, pending: 0 });
  assert.deepEqual(s.database.all("SELECT source, revoked_at IS NULL AS live FROM entitlement_grants WHERE subject_type = 'user' ORDER BY id")
    .map((g) => [g.source, g.live]), [[PROVIDER, 0], [WEB, 0], ['admin', 1]], 'only billing\'s: the admin\'s is the account\'s own');
  assert.equal(s.database.get("SELECT COUNT(*) AS n FROM billing_subscriptions WHERE subject_type = 'organization'").n, 1);
  assert.equal(s.stores.customerOf({ type: 'user', id: s.ada.id }), null);
  // A renewal that still comes for the old customer finds nobody: nothing is granted, nothing asked.
  const calls = s.api.calls.length;
  assert.deepEqual((await s.deliver({ type: 'renewed', customer: ada, product: MONTHLY })).body.outcomes, ['ignored']);
  assert.equal(s.api.calls.length, calls);

  // Deletion with both: each asked even if the other fails; a store stops nothing for the person.
  const asked = [];
  const failing = { enabled: true, stopRenewals: async () => { asked.push('web'); throw new Error('provider down'); }, keepRenewals: async () => 0, endSubscriptions: async () => 0 };
  const counting = { enabled: true, stopRenewals: async () => { asked.push('store'); return 2; }, keepRenewals: async () => 1, endSubscriptions: async () => 0 };
  await assert.rejects(combinedBilling([failing, counting]).stopRenewals(1), /provider down/);
  assert.deepEqual(asked, ['web', 'store']);
  assert.equal(await combinedBilling([{ enabled: false }, counting, null]).keepRenewals(1), 1);
  assert.equal(combinedBilling([{ enabled: false }, null]).enabled, false);
  assert.equal(await combinedBilling([s.web, s.stores]).stopRenewals(s.bob.id), 0, 'neither provider can stop anything here');
});

test('createSuite with STORE_BILLING: the store\'s routes beside the web\'s unchanged, a phone\'s token, and an account that goes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-stores-suite-'));
  const product = {
    app: { id: 'demo', name: 'Demo', languages: ['en'] }, modules: { billing: true, devices: true, mcp: false, oauth: false },
    features: FEATURES, plans: PLANS, products: WEB_PRODUCTS,
    tokens: { prefix: 'demo_' }, devices: { prefix: 'demodev_', redirectUris: ['com.example.demo:/auth'] },
    stores: { products: PRODUCTS, devices: true }, billing: { forgetOnRemove: true },
  };
  const suite = createSuite({
    config: product,
    env: {
      DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1',
      BILLING_PROVIDER: 'remote', BILLING_SECRET: SECRET,
      STORE_BILLING: PROVIDER, TEST_STORE_AUTH: AUTH, TEST_STORE_KEY: KEY, TEST_STORE_SECRET: SIGNING,
    },
    log: () => {}, exitOnError: false,
  });
  const server = createApp({ suite, version: '1.0.0', handleSignals: false, log: () => {} });
  const listening = await server.listen();
  t.after(async () => {
    await server.close();
    suite.database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${listening.address().port}`;
  const call = async (method, pathname, { token, body, headers = {} } = {}) => {
    const res = await fetch(base + pathname, {
      method, body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await call('GET', '/api/auth/config')).body.app.modules.stores, true);

  // Dee connects her phone, which asks for her customer and buys.
  const dee = suite.accounts.create({ username: 'dee', email: 'dee@example.com', password: randomToken(12) });
  const verifier = randomToken(32);
  const issued = suite.devices.issueCode(dee, { codeChallenge: sha256(verifier), redirectUri: 'com.example.demo:/auth', name: 'Phone' });
  const { token } = suite.devices.exchange({ code: issued.code, verifier, redirectUri: 'com.example.demo:/auth' });
  assert.equal((await call('GET', '/api/billing/stores/customer')).status, 401);
  const { customer } = (await call('GET', '/api/billing/stores/customer', { token })).body;
  assert.match(customer, UUID);
  shop.customer(customer).subscriptions[MONTHLY] = subscription({ purchased: Date.now(), expires: Date.now() + 30 * DAY });
  const unsigned = webhook({ type: 'purchased', customer, product: MONTHLY });
  assert.equal((await call('POST', `/api/billing/${PROVIDER}/webhook`, { body: unsigned.body, headers: unsigned.headers })).status, 400,
    'TEST_STORE_SECRET: the signature too');
  const signed = webhook({ type: 'purchased', customer, product: MONTHLY }, { secret: SIGNING });
  assert.deepEqual((await call('POST', `/api/billing/${PROVIDER}/webhook`, { body: signed.body, headers: signed.headers })).body,
    { received: 1, outcomes: ['granted'] });
  assert.equal(shop.calls[0].key, KEY, 'the adapter made from the install\'s own variables');
  assert.equal(suite.entitlements.of(suite.accounts.byId(dee.id)).plan.id, 'pro');
  assert.deepEqual((await call('POST', '/api/billing/stores/sync', { token })).body.outcomes, ['unchanged']);
  const overview = (await call('GET', '/api/billing/overview', { token })).body;
  assert.deepEqual(overview.sources.map((source) => [source.kind, source.product, source.manage.via]), [['store', 'pro-monthly', 'store']]);
  await assert.rejects(suite.billing.checkoutUrl({ type: 'user', id: dee.id }, 'pro-web-yearly', { returnUrl: 'http://127.0.0.1/' }),
    (err) => err.status === 409 && err.code === 'already_subscribed', 'the web sells no second subscription');

  // The web's webhook is the same as ever.
  const event = JSON.stringify({
    id: 'evt_web_1', type: 'subscription', ref: 'sub_web', subject: { type: 'user', id: dee.id }, customer: 'cus_web',
    product: 'pro-web-yearly', status: 'active', periodEnd: new Date(Date.now() + 365 * DAY).toISOString(),
  });
  assert.deepEqual((await call('POST', '/api/billing/webhook', { body: event, headers: { 'x-suite-signature': signPayload(SECRET, event) } })).body,
    { received: 1, outcomes: ['granted'] });

  // Dee's account goes: this install lets go of her billing, never of who she is elsewhere.
  suite.accounts.remove(dee.id);
  assert.equal(suite.database.get("SELECT COUNT(*) AS n FROM entitlement_grants WHERE revoked_at IS NULL AND source IN ('remote', ?)", PROVIDER).n, 0);
  assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM billing_customers').n, 0);
  assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM billing_subscriptions').n, 0);
});

test('without STORE_BILLING nothing changes: no store routes, the web’s overview alone, the same config answer, nothing kept from an account', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-stores-off-'));
  const suite = createSuite({
    config: { app: { id: 'demo', name: 'Demo', languages: ['en'] }, modules: { billing: true }, plans: PLANS, features: FEATURES, products: WEB_PRODUCTS },
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1', BILLING_PROVIDER: 'remote', BILLING_SECRET: SECRET },
    log: () => {}, exitOnError: false,
  });
  const server = createApp({ suite, version: '1.0.0', handleSignals: false, log: () => {} });
  const listening = await server.listen();
  t.after(async () => { await server.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${listening.address().port}`;
  assert.equal(suite.stores, null);
  for (const [method, pathname] of [['POST', `/api/billing/${PROVIDER}/webhook`], ['GET', '/api/billing/stores/customer'],
    ['POST', '/api/billing/stores/sync']]) {
    assert.equal((await fetch(base + pathname, { method })).status, 404, pathname);
  }
  // What holds the plan, for Settings › Plan: the web's alone, for whoever is signed in.
  assert.equal((await fetch(`${base}/api/billing/overview`)).status, 401);
  assert.equal('stores' in (await (await fetch(`${base}/api/auth/config`)).json()).app.modules, false);
  const eve = suite.accounts.create({ username: 'eve' });
  suite.billing.apply({
    id: 'evt_1', type: 'subscription', ref: 'sub_eve', subject: { type: 'user', id: eve.id }, customer: 'cus_eve',
    product: 'pro-web-yearly', status: 'active', periodEnd: new Date(Date.now() + 365 * DAY).toISOString(),
  });
  suite.accounts.remove(eve.id);
  assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM billing_customers').n, 1, 'without forgetOnRemove, as before');
});

test('the configuration: STORE_BILLING and stores, off by default, every mistake stops the start', (t) => {
  const app = { id: 'demo', name: 'Demo', languages: ['en'] };
  const product = (extra = {}) => ({ app, modules: { billing: true }, plans: PLANS, stores: { products: PRODUCTS }, ...extra });
  const env = (extra = {}) => ({ DATA_DIR: os.tmpdir(), STORE_BILLING: PROVIDER, TEST_STORE_AUTH: AUTH, TEST_STORE_KEY: KEY, ...extra });
  const plain = resolveConfig({ app }, {});
  assert.deepEqual(plain.errors, []);
  assert.deepEqual(plain.stores, { products: {}, devices: false });
  assert.equal(plain.install.stores, null);
  assert.equal('forgetOnRemove' in plain.billing, false, 'an app that says nothing has the rules it had');

  const on = resolveConfig(product(), env());
  assert.deepEqual(on.errors, []);
  assert.deepEqual(on.install.stores, { provider: PROVIDER, auth: AUTH, key: KEY, secret: null }, 'what its provider read, as it read it');

  const errorsOf = (p, e) => resolveConfig(p, e).errors;
  assert.deepEqual(errorsOf({ app, stores: { products: PRODUCTS } }, env()), ['STORE_BILLING is set, but this app has modules.billing off']);
  assert.match(errorsOf(product(), env({ STORE_BILLING: 'storekit' })).join('\n'), new RegExp(`^STORE_BILLING "storekit": use (.+ or )?${PROVIDER}$`),
    'the providers registered');
  assert.deepEqual(errorsOf(product(), env({ TEST_STORE_KEY: '' })), [`STORE_BILLING=${PROVIDER} needs TEST_STORE_KEY`], 'its own words');
  assert.match(errorsOf(product({ stores: {} }), env()).join(), /stores\.products sells nothing/);

  const stores = (given, extra = {}) => errorsOf({ app, modules: { billing: true, ...extra }, plans: PLANS, products: WEB_PRODUCTS, stores: given }, {});
  assert.deepEqual(stores({ product: {} }), ['stores.product is not a setting (a typo?)']);
  assert.deepEqual(stores('on'), ["stores: an object, such as { products: { 'pro-monthly': { plan: 'pro', kind: 'subscription', appStore: 'com.example.app.pro.monthly' } } }"]);
  assert.deepEqual(stores({ devices: true }), ['stores.devices needs modules.devices: the device tokens it takes']);
  assert.deepEqual(stores({ devices: 'yes' }), ['stores.devices must be true or false']);
  assert.deepEqual(stores({ products: { p: { plan: 'pro', kind: 'subscription', appstore: 'com.example.p' } } }), [
    'stores.products.p.appstore is not a setting (plan, kind, days, name, appStore, playStore)',
    'stores.products.p: its id in a store is needed (appStore or playStore)',
  ]);
  assert.deepEqual(stores({ products: { p: { plan: 'pro', kind: 'subscription', appStore: 'com.example.p', for: 'organization' } } }),
    ['stores.products.p.for: people buy in the stores for themselves; a group buys on the web']);
  assert.deepEqual(stores({ products: { 'pro-web-yearly': { plan: 'pro', kind: 'subscription', appStore: 'com.example.p' } } }),
    ["stores.products.pro-web-yearly: a web product has that key too; give the store's its own"]);
  assert.deepEqual(stores({ products: { p: { plan: 'pro', kind: 'subscription', appStore: 'com example', playStore: 'App_Pro:Monthly' } } }), [
    'stores.products.p.appStore: "com example" is not an App Store product id (letters, digits, . and _)',
    'stores.products.p.playStore: "App_Pro:Monthly" is not a Google Play product id (subscription:base-plan, lowercase)',
  ]);
  assert.deepEqual(stores({
    products: { a: { plan: 'pro', kind: 'subscription', playStore: 'app_pro:monthly' }, b: { plan: 'pro', kind: 'subscription', playStore: 'app_pro:monthly' } },
  }), ['stores.products.b.playStore: "app_pro:monthly" is already stores.products.a\'s']);

  assert.deepEqual(errorsOf({ app, billing: { forgetOnRemove: 'yes' } }, {}), ['billing.forgetOnRemove must be true or false']);
  assert.equal(resolveConfig({ app, billing: { forgetOnRemove: true } }, {}).billing.forgetOnRemove, true);

  // What only the catalog can say is checked when the store is on: a plan that isn't there.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-stores-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => createSuite({
    config: product({ stores: { products: { gold: { plan: 'gold', kind: 'subscription', appStore: 'com.example.gold' } } } }),
    env: env({ DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password' }), log: () => {}, exitOnError: false,
  }), (err) => err instanceof SuiteConfigError && err.errors.some((e) => /The store products \(stores\.products\) have errors: Product "gold": plan "gold" is not in the catalog/.test(e)));
});
