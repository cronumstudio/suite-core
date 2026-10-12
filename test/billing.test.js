/**
 * Billing: signed webhooks turned into grants, once and in order; checkout
 * and portal; the routes. With the suite's own signed provider, which is what
 * the hosted suite's accounts service speaks.
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
  createBilling, registerBillingApi, signedProvider, signPayload, verifySignature,
} from '../billing.js';
import { resolveConfig } from '../config.js';
import { createSuite, SuiteConfigError } from '../app.js';

const DAY = 24 * 3600 * 1000;
const SECRET = 'a-shared-secret-of-the-accounts-service';
const PRODUCTS = {
  'pro-monthly': { plan: 'pro', kind: 'subscription', price: 'price_pro_m', name: 'Pro, monthly' },
  'pro-lifetime': { plan: 'pro', kind: 'once' },
  'pro-pass': { plan: 'pro', kind: 'once', days: 30 },
  'family-yearly': { plan: 'family', kind: 'subscription', for: 'organization' },
};

function setup(t, { now: start = '2026-05-01T10:00:00Z', provider = signedProvider({ secret: SECRET, baseUrl: 'https://accounts.example' }) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-billing-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const clock = { now: Date.parse(start) };
  const accounts = createAccounts({ database });
  let organizations = null;
  const entitlements = createEntitlements({
    database, appId: 'test', clock: () => clock.now,
    features: { 'lists.max': { type: 'limit', default: null }, sharing: { type: 'flag', default: true } },
    plans: {
      free: { name: 'Free', features: { 'lists.max': 3, sharing: false } },
      pro: { name: 'Pro', features: {} },
      family: { name: 'Family', features: {} },
    },
    plansJson: null, defaultPlanOverride: null,
    organizationsOf: (user) => organizations.organizationsOf(user),
  });
  organizations = createOrganizations({ database, seatsOf: entitlements.seatsOf, clock: () => clock.now });
  const audit = createAudit({ database, trustProxy: '', clock: () => clock.now });
  const billing = createBilling({ database, entitlements, provider, products: PRODUCTS, audit, clock: () => clock.now, log: () => {} });
  const ada = accounts.create({ username: 'ada', email: 'ada@example.com' });
  return { database, clock, accounts, entitlements, organizations, audit, billing, ada };
}

const planOf = (entitlements, user, context) => entitlements.of(user, context).plan.id;
const code = (fn) => { try { fn(); } catch (err) { return `${err.status} ${err.code}`; } return 'ok'; };

test('signatures: the right secret, the same body, not too old', () => {
  const body = '{"id":"evt_1"}';
  const now = Date.parse('2026-05-01T10:00:00Z');
  const header = signPayload(SECRET, body, now);
  assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.equal(verifySignature(SECRET, body, header, { now }), true);
  assert.equal(verifySignature(SECRET, `${body} `, header, { now }), false, 'another body');
  assert.equal(verifySignature('another-secret-entirely', body, header, { now }), false, 'another secret');
  assert.equal(verifySignature(SECRET, body, header, { now: now + 10 * 60 * 1000 }), false, 'replayed later');
  assert.equal(verifySignature(SECRET, body, 'garbage', { now }), false);
  assert.equal(verifySignature(SECRET, body, '', { now }), false);
});

test('the catalog is checked against the plans; without a provider billing is off', (t) => {
  const { database, entitlements } = setup(t);
  const bad = createBilling({
    database, entitlements, provider: signedProvider({ secret: SECRET }),
    products: { gold: { plan: 'gold', kind: 'subscription' }, 'pro-x': { plan: 'pro', kind: 'weekly' }, 'Pro!': { plan: 'pro', kind: 'once' } },
  });
  assert.equal(bad.errors.length, 3, bad.errors.join('; '));
  assert.equal(bad.enabled, false, 'a misspelled catalog never charges');
  const off = createBilling({ database, entitlements, products: PRODUCTS });
  assert.equal(off.enabled, false);
  assert.throws(() => signedProvider({ secret: 'short' }), /at least 16/);
});

test('a subscription: granted until the paid period ends, extended, lapsing on its own, ended', (t) => {
  const { clock, billing, entitlements, ada } = setup(t);
  const periodEnd = '2026-06-01T10:00:00.000Z';
  const sub = (id, fields) => billing.apply({
    id, type: 'subscription', ref: 'sub_1', subject: { type: 'user', id: ada.id }, customer: 'cus_ada',
    product: 'pro-monthly', occurredAt: new Date(clock.now).toISOString(), ...fields,
  });

  assert.equal(sub('evt_1', { status: 'active', periodEnd }), 'granted');
  assert.equal(planOf(entitlements, ada), 'pro');
  assert.equal(entitlements.of(ada).ends, '2026-06-04T10:00:00.000Z', 'three days of grace');
  assert.equal(billing.customerOf({ type: 'user', id: ada.id }), 'cus_ada');
  assert.equal(sub('evt_1', { status: 'active', periodEnd }), 'duplicate', 'providers retry');

  clock.now += 31 * DAY;
  assert.equal(sub('evt_2', { status: 'active', periodEnd: '2026-07-01T10:00:00.000Z' }), 'extended', 'renewed');
  assert.equal(entitlements.grantsOf('user', ada.id).length, 1, 'one grant, moved: not one a month');

  clock.now += 1000;
  assert.equal(sub('evt_3', { status: 'past_due', periodEnd: '2026-07-01T10:00:00.000Z' }), 'kept');
  clock.now = Date.parse('2026-07-05T00:00:00Z');
  assert.equal(planOf(entitlements, ada), 'free', 'an unpaid renewal lapses on its own');

  // A late renewal brings it back; then the person cancels for good.
  assert.equal(sub('evt_4', { status: 'active', periodEnd: '2026-08-05T00:00:00.000Z' }), 'extended');
  assert.equal(planOf(entitlements, ada), 'pro');
  clock.now += 1000;
  assert.equal(sub('evt_5', { status: 'canceled' }), 'revoked');
  assert.equal(planOf(entitlements, ada), 'free');
  assert.deepEqual(billing.subscriptionsOf({ type: 'user', id: ada.id }).map((s) => s.status), ['canceled']);
});

test('out of order: an older event never undoes a newer one', (t) => {
  const { clock, billing, entitlements, ada } = setup(t);
  const base = { type: 'subscription', ref: 'sub_2', subject: { type: 'user', id: ada.id }, product: 'pro-monthly' };
  const early = new Date(clock.now).toISOString();
  clock.now += 60 * 1000;
  const late = new Date(clock.now).toISOString();
  assert.equal(billing.apply({ ...base, id: 'evt_b', occurredAt: late, status: 'canceled' }), 'nothing');
  assert.equal(billing.apply({ ...base, id: 'evt_a', occurredAt: early, status: 'active', periodEnd: '2026-06-01T10:00:00Z' }), 'stale');
  assert.equal(planOf(entitlements, ada), 'free');
});

test('a change of product or seats replaces the grant; groups get their seats', (t) => {
  const { billing, entitlements, organizations, accounts, ada } = setup(t);
  const bob = accounts.create({ username: 'bob' });
  const home = organizations.create({ name: 'Home', ownerId: ada.id });
  const family = (id, quantity) => billing.apply({
    id, type: 'subscription', ref: 'sub_home', subject: { type: 'organization', id: home.id }, customer: 'cus_home',
    product: 'family-yearly', status: 'active', periodEnd: '2027-05-01T10:00:00Z', quantity,
  });
  assert.equal(family('evt_f1', 2), 'granted');
  assert.equal(entitlements.seatsOf(home.id), 2);
  organizations.addMember(home.id, bob.id);
  assert.equal(planOf(entitlements, bob), 'family', 'the group’s plan reaches its members');
  assert.equal(family('evt_f2', 4), 'changed', 'more seats bought');
  assert.equal(entitlements.seatsOf(home.id), 4);
  assert.equal(entitlements.grantsOf('organization', home.id).filter((g) => !g.revoked_at).length, 1);
});

test('one-off purchases: for good or for some days; a refund takes them back', (t) => {
  const { clock, billing, entitlements, accounts, ada } = setup(t);
  const bob = accounts.create({ username: 'bob' });
  const buy = (id, subject, product, ref) => billing.apply({
    id, type: 'purchase', ref, subject: { type: 'user', id: subject.id }, product, occurredAt: new Date(clock.now).toISOString(),
  });
  assert.equal(buy('evt_p1', ada, 'pro-lifetime', 'order_1'), 'granted');
  assert.equal(entitlements.of(ada).ends, null, 'for good');
  assert.equal(buy('evt_p1b', ada, 'pro-lifetime', 'order_1'), 'duplicate', 'the same order twice grants once');

  assert.equal(buy('evt_p2', bob, 'pro-pass', 'order_2'), 'granted');
  assert.equal(entitlements.of(bob).ends, '2026-05-31T10:00:00.000Z');
  clock.now += 31 * DAY;
  assert.equal(planOf(entitlements, bob), 'free', 'the pass is over');

  assert.equal(billing.apply({ id: 'evt_r1', type: 'refund', ref: 'order_1' }), 'revoked');
  assert.equal(planOf(entitlements, ada), 'free');
  assert.equal(billing.apply({ id: 'evt_x', type: 'purchase', ref: 'order_3', subject: { type: 'user', id: ada.id }, product: 'gold' }), 'ignored');
  assert.equal(billing.apply({ id: 'evt_y', type: 'purchase', ref: 'order_4', customer: 'cus_nobody', product: 'pro-lifetime' }), 'ignored');
});

test('the routes: offer, checkout, portal, and the signed webhook', async (t) => {
  const { billing, entitlements, organizations, accounts, audit, ada } = setup(t, { now: new Date().toISOString() });
  const bob = accounts.create({ username: 'bob' });
  const home = organizations.create({ name: 'Home', ownerId: ada.id });
  organizations.addMember(home.id, bob.id);

  const router = createRouter();
  registerBillingApi(router, { billing, organizations, baseUrl: 'https://app.example' });
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

  const offer = await call('GET', '/api/billing/products');
  assert.deepEqual(offer.body.products.map((p) => p.key), Object.keys(PRODUCTS));
  assert.equal(JSON.stringify(offer.body).includes('price_pro_m'), false, 'never the provider’s price ids');

  assert.equal((await call('POST', '/api/billing/checkout', { body: { product: 'pro-monthly' } })).status, 401);
  const checkout = await call('POST', '/api/billing/checkout', { as: ada.id, body: { product: 'pro-monthly' } });
  const link = new URL(checkout.body.url);
  assert.equal(link.origin + link.pathname, 'https://accounts.example/checkout');
  assert.equal(link.searchParams.get('subject'), `user:${ada.id}`);
  assert.equal(link.searchParams.get('return'), 'https://app.example/?billing=done');
  assert.equal((await call('POST', '/api/billing/checkout', { as: ada.id, body: { product: 'gold' } })).body.error, 'product_unknown');
  assert.equal((await call('POST', '/api/billing/checkout', { as: ada.id, body: { product: 'family-yearly' } })).body.error, 'product_for');
  assert.equal((await call('POST', '/api/billing/checkout', { as: bob.id, body: { product: 'family-yearly', organization_id: home.id } })).body.error,
    'organization_role', 'a member doesn’t pay for the group; its admins do');
  assert.equal((await call('POST', '/api/billing/checkout', { as: ada.id, body: { product: 'family-yearly', organization_id: home.id } })).status, 200);
  assert.equal((await call('POST', '/api/billing/portal', { as: ada.id, body: {} })).body.error, 'no_customer');

  // The accounts service says Ada paid.
  const event = JSON.stringify({
    id: 'evt_web_1', type: 'subscription', ref: 'sub_web', subject: { type: 'user', id: ada.id }, customer: 'cus_web',
    product: 'pro-monthly', status: 'active', periodEnd: new Date(Date.now() + 30 * DAY).toISOString(),
  });
  assert.equal((await call('POST', '/api/billing/webhook', { body: event, headers: { 'x-suite-signature': signPayload('not-the-secret-at-all', event) } })).body.error,
    'bad_signature');
  assert.equal(planOf(entitlements, ada), 'free');
  const delivered = await call('POST', '/api/billing/webhook', { body: event, headers: { 'x-suite-signature': signPayload(SECRET, event) } });
  assert.deepEqual(delivered.body, { received: 1, outcomes: ['granted'] });
  assert.equal(planOf(entitlements, ada), 'pro');
  assert.equal((await call('POST', '/api/billing/checkout', { as: ada.id, body: { product: 'pro-monthly' } })).body.error,
    'already_subscribed', 'plans are changed in the portal');
  const portal = await call('POST', '/api/billing/portal', { as: ada.id, body: {} });
  assert.equal(new URL(portal.body.url).searchParams.get('customer'), 'cus_web');
  assert.deepEqual((await call('GET', '/api/billing/subscriptions', { as: ada.id })).body.subscriptions.map((s) => s.product), ['pro-monthly']);
  assert.deepEqual(audit.list({ action: 'billing.' }).map((e) => e.action), ['billing.granted']);
});

test('another product\'s events: foreign before anything about who pays, with only their id, type and outcome kept', (t) => {
  const { database, entitlements, audit, clock, billing: plain, ada } = setup(t);
  const provider = signedProvider({ id: 'guarded', secret: SECRET });
  const logs = [];
  const billing = createBilling({
    database, entitlements, provider, products: PRODUCTS, audit, clock: () => clock.now, log: (line) => logs.push(line),
    ignoreUnknownProducts: true, app: 'work',
  });
  assert.deepEqual(billing.errors, []);
  const sale = (id, fields) => billing.apply({
    id, type: 'subscription', ref: `sub_${id}`, subject: { type: 'user', id: ada.id }, customer: `cus_${id}`,
    status: 'active', periodEnd: '2026-06-01T10:00:00Z', product: 'pro-monthly', ...fields,
  });
  assert.equal(sale('e1', { product: 'gold' }), 'foreign', 'a product this catalog doesn\'t have');
  assert.equal(sale('e2', { product: undefined }), 'foreign', 'or none');
  assert.equal(sale('e3', { product: 'constructor' }), 'foreign', 'only the catalog\'s own keys');
  assert.equal(sale('e4', { app: 'tracker' }), 'foreign', 'sold by another app');
  assert.equal(sale('e5', { foreign: true }), 'foreign', 'the provider says so');
  assert.equal(billing.apply({ id: 'e6', type: 'purchase', ref: 'order_6', customer: 'cus_e6', product: 'gold' }), 'foreign');
  assert.equal(billing.customerOf({ type: 'user', id: ada.id }), null, 'no customer linked');
  assert.equal(database.get("SELECT COUNT(*) AS n FROM billing_subscriptions WHERE provider = 'guarded'").n, 0);
  assert.deepEqual(database.all("SELECT event_id, type, outcome FROM billing_events WHERE provider = 'guarded'").map((r) => [r.event_id, r.type, r.outcome]), [
    ['e1', 'subscription', 'foreign'], ['e2', 'subscription', 'foreign'], ['e3', 'subscription', 'foreign'],
    ['e4', 'subscription', 'foreign'], ['e5', 'subscription', 'foreign'], ['e6', 'purchase', 'foreign'],
  ]);
  assert.equal(audit.list({ action: 'billing.' }).length, 0, 'nothing in the audit');
  assert.ok(logs.every((line) => !line.includes('cus_')), 'the log names no customer');

  // This app's own sales, with its name or from before checkouts said it; refunds as always.
  assert.equal(sale('e7', { app: 'work' }), 'granted');
  assert.equal(sale('e8', {}), 'granted');
  assert.equal(billing.apply({ id: 'e9', type: 'refund', ref: 'sub_e7' }), 'revoked');
  assert.equal(billing.apply({ id: 'e10', type: 'refund', ref: 'sub_e1' }), 'nothing');
  assert.equal(sale('e1', { product: 'gold' }), 'duplicate', 'applied once, like the rest');

  // Without the options, as before: an unknown product links the customer, then is ignored.
  assert.equal(plain.apply({ id: 'p1', type: 'subscription', ref: 'sub_p1', subject: { type: 'user', id: ada.id }, customer: 'cus_p1', product: 'gold' }), 'ignored');
  assert.equal(plain.customerOf({ type: 'user', id: ada.id }), 'cus_p1');
  assert.equal(plain.apply({ id: 'p2', type: 'subscription', ref: 'sub_p2', subject: { type: 'user', id: ada.id }, product: 'pro-monthly',
    status: 'active', periodEnd: '2026-06-01T10:00:00Z', app: 'tracker', foreign: false }), 'granted', 'an app is only compared where the install has one');
});

test('what waited for someone since before the guard was on is foreign when they arrive: nothing linked, nothing granted', (t) => {
  const { database, entitlements, accounts, clock } = setup(t);
  const provider = signedProvider({ id: 'paddle', secret: SECRET });
  const nobody = { of: () => null, user: () => null };
  const before = createBilling({ database, entitlements, provider, products: PRODUCTS, identities: nobody, clock: () => clock.now, log: () => {} });
  const event = (id, product, ref) => ({
    id, type: 'subscription', ref, identity: { provider: 'workos', subject: 'user_01JBEA0000000000000000000B' }, customer: 'cus_bea',
    product, status: 'active', periodEnd: '2026-06-01T10:00:00Z',
  });
  assert.equal(before.apply(event('w1', 'tracker-org-monthly', 'sub_other')), 'pending');
  assert.equal(before.apply(event('w2', 'pro-monthly', 'sub_own')), 'pending');

  const bea = accounts.create({ username: 'bea' });
  const after = createBilling({
    database, entitlements, provider, products: PRODUCTS, clock: () => clock.now, log: () => {}, ignoreUnknownProducts: true,
    identities: { of: () => null, user: () => bea.id },
  });
  assert.equal(after.claim('workos', 'user_01JBEA0000000000000000000B', bea.id), 2);
  assert.deepEqual(database.all('SELECT event_id, outcome FROM billing_events ORDER BY rowid').map((r) => [r.event_id, r.outcome]),
    [['w1', 'foreign'], ['w2', 'granted']]);
  assert.equal(entitlements.grantsOf('user', bea.id).length, 1, 'only its own product');
  assert.equal(database.get('SELECT COUNT(*) AS n FROM billing_pending').n, 0);
});

test('the guard\'s options are checked; the checkout tells the provider which app sells, only when there is one', async (t) => {
  const { database, entitlements, ada } = setup(t);
  const seen = [];
  const provider = {
    id: 'stub', checkoutUrl: async (args) => { seen.push(args); return 'https://pay.example/x'; },
    portalUrl: async () => 'https://pay.example/portal', parseWebhook: async () => null,
  };
  const make = (options) => createBilling({ database, entitlements, provider, products: PRODUCTS, log: () => {}, ...options });
  assert.match(make({ app: 'Cronum Work' }).errors.join(), /app "Cronum Work"/);
  assert.equal(make({ app: 'Cronum Work' }).enabled, false, 'a misspelled guard never runs half on');
  assert.match(make({ ignoreUnknownProducts: 'yes' }).errors.join(), /ignoreUnknownProducts/);
  assert.match(createBilling({ database, entitlements, provider, products: { p: { plan: 'pro', kind: 'once', oldPrices: 'pri_1' } } }).errors.join(),
    /oldPrices must be a list/);

  await make({ app: 'work' }).checkoutUrl({ type: 'user', id: ada.id }, 'pro-monthly', { user: ada, returnUrl: 'x' });
  await make({}).checkoutUrl({ type: 'user', id: ada.id }, 'pro-monthly', { user: ada, returnUrl: 'x' });
  assert.equal(seen[0].app, 'work');
  assert.equal('app' in seen[1], false, 'as before without one');
});

/* ------------------------- a family's plan: no seats ------------------------ */

/** A family's products (Focus's): one Pro for the family, however many adults it has. */
const FAMILY = {
  'family-pro': { plan: 'family', kind: 'subscription', for: 'organization', seats: false },
  'family-pass': { plan: 'family', kind: 'once', days: 30, for: 'organization', seats: false },
};

test('seats: false: a third and a fourth adult join a family after it buys, through a renewal and a cancellation at the period\'s end', (t) => {
  const { database, clock, entitlements, organizations, accounts, audit, ada } = setup(t);
  const billing = createBilling({
    database, entitlements, provider: signedProvider({ secret: SECRET }), products: { ...PRODUCTS, ...FAMILY },
    audit, clock: () => clock.now, log: () => {},
  });
  assert.deepEqual(billing.errors, []);
  const [bob, eve, dan, kim] = ['bob', 'eve', 'dan', 'kim'].map((username) => accounts.create({ username }));
  const home = organizations.create({ name: 'Andersen', kind: 'family', ownerId: ada.id });
  organizations.addMember(home.id, bob.id, 'admin');
  // Every event says one of the price, as Paddle's and Stripe's checkouts buy it.
  const family = (id, fields) => billing.apply({
    id, type: 'subscription', ref: 'sub_family', subject: { type: 'organization', id: home.id }, customer: 'cus_family',
    product: 'family-pro', status: 'active', quantity: 1, occurredAt: new Date(clock.now).toISOString(), ...fields,
  });

  assert.equal(family('evt_1', { periodEnd: '2027-05-01T10:00:00Z' }), 'granted');
  assert.equal(entitlements.seatsOf(home.id), null, 'no cap on the members');
  // Read again as a store reads (stores.js): quantity 1 again is what is already here, not a change.
  assert.equal(billing.apply({
    id: 'evt_1_read', type: 'subscription', ref: 'sub_family', subject: { type: 'organization', id: home.id }, customer: 'cus_family',
    product: 'family-pro', status: 'active', quantity: 1, occurredAt: new Date(clock.now).toISOString(), periodEnd: '2027-05-01T10:00:00Z',
  }, { reading: true }), 'unchanged');
  assert.equal(entitlements.grantsOf('organization', home.id)[0].quantity, null, 'the grant has no quantity');
  assert.equal(billing.subscriptionsOf({ type: 'organization', id: home.id })[0].quantity, null, 'nor the subscription');
  assert.equal(code(() => organizations.addMember(home.id, eve.id, 'admin')), 'ok', 'a third adult');
  const { token } = organizations.invite(home.id, { role: 'admin', invitedBy: ada.id });
  assert.equal(code(() => organizations.accept(token, dan.id)), 'ok', 'a fourth, by invitation');
  for (const adult of [ada, bob, eve, dan]) assert.equal(planOf(entitlements, adult), 'family');

  // Renewed: an update with the next period, and quantity 1 again. The same grant moves, still no seats.
  clock.now += 365 * DAY;
  assert.equal(family('evt_2', { periodEnd: '2028-05-01T10:00:00Z' }), 'extended');
  assert.equal(entitlements.seatsOf(home.id), null);
  assert.equal(entitlements.grantsOf('organization', home.id).length, 1, 'one grant, moved');
  // Cancelled in the portal: active until the period ends, and nobody is turned away meanwhile.
  clock.now += DAY;
  assert.equal(family('evt_3', { periodEnd: '2028-05-01T10:00:00Z' }), 'extended');
  const { token: another } = organizations.invite(home.id, { role: 'admin' });
  assert.equal(code(() => organizations.accept(another, kim.id)), 'ok', 'a fifth');
  assert.equal(organizations.membersOf(home.id).length, 5);
  clock.now = Date.parse('2028-05-01T10:00:01Z');
  assert.equal(family('evt_4', { status: 'canceled' }), 'revoked');
  assert.equal(planOf(entitlements, kim), 'free');
  assert.deepEqual(audit.list({ action: 'billing.' }).map((e) => e.action).sort(),
    ['billing.extended', 'billing.extended', 'billing.granted', 'billing.revoked']);
});

test('without seats: false a group\'s purchase caps its members as before, by addMember and by invitation, across an update', (t) => {
  const { clock, billing, entitlements, organizations, accounts, ada } = setup(t);
  const [bob, eve] = ['bob', 'eve'].map((username) => accounts.create({ username }));
  const home = organizations.create({ name: 'Home', ownerId: ada.id });
  const group = (id, fields) => billing.apply({
    id, type: 'subscription', ref: 'sub_home', subject: { type: 'organization', id: home.id }, customer: 'cus_home',
    product: 'family-yearly', status: 'active', quantity: 1, occurredAt: new Date(clock.now).toISOString(), ...fields,
  });
  assert.equal(group('evt_1', { periodEnd: '2027-05-01T10:00:00Z' }), 'granted');
  assert.equal(entitlements.seatsOf(home.id), 1, 'the quantity bought is its seats');
  assert.equal(code(() => organizations.addMember(home.id, bob.id, 'admin')), '402 seats_full');
  const { token } = organizations.invite(home.id, { role: 'admin' });
  assert.equal(code(() => organizations.accept(token, eve.id)), '402 seats_full');
  clock.now += 365 * DAY;
  assert.equal(group('evt_2', { periodEnd: '2028-05-01T10:00:00Z' }), 'extended');
  assert.equal(entitlements.seatsOf(home.id), 1);
  assert.equal(code(() => organizations.addMember(home.id, bob.id, 'admin')), '402 seats_full');
  const { token: renewed } = organizations.invite(home.id, { role: 'admin' });
  assert.equal(code(() => organizations.accept(renewed, eve.id)), '402 seats_full');
  assert.equal(organizations.membersOf(home.id).length, 1);
});

test('seats: false: a one-off purchase has no quantity either; a family that bought before the option is uncapped by its next event', (t) => {
  const { database, clock, entitlements, organizations, accounts, ada } = setup(t);
  const provider = signedProvider({ secret: SECRET });
  const bob = accounts.create({ username: 'bob' });
  const home = organizations.create({ name: 'Home', kind: 'family', ownerId: ada.id });
  const before = createBilling({
    database, entitlements, provider, clock: () => clock.now, log: () => {},
    products: { 'family-pro': { plan: 'family', kind: 'subscription', for: 'organization' } },
  });
  const event = (id) => ({
    id, type: 'subscription', ref: 'sub_old', subject: { type: 'organization', id: home.id }, product: 'family-pro',
    status: 'active', quantity: 1, periodEnd: '2027-05-01T10:00:00Z', occurredAt: new Date(clock.now).toISOString(),
  });
  assert.equal(before.apply(event('evt_old')), 'granted');
  assert.equal(entitlements.seatsOf(home.id), 1, 'as every group\'s purchase was');
  // The app adds `seats: false` to the same product: its next event (a renewal, a change) replaces the grant.
  const after = createBilling({ database, entitlements, provider, products: FAMILY, clock: () => clock.now, log: () => {} });
  clock.now += DAY;
  assert.equal(after.apply(event('evt_new')), 'changed');
  assert.equal(entitlements.seatsOf(home.id), null);
  assert.equal(code(() => organizations.addMember(home.id, bob.id, 'admin')), 'ok');

  const other = organizations.create({ name: 'Other', kind: 'family', ownerId: bob.id });
  assert.equal(after.apply({
    id: 'evt_pass', type: 'purchase', ref: 'order_pass', subject: { type: 'organization', id: other.id }, product: 'family-pass', quantity: 1,
  }), 'granted');
  assert.equal(entitlements.seatsOf(other.id), null);
  assert.equal(entitlements.ofOrganization(other.id).plan.id, 'family');
});

test('seats: false next to seatRoles: no seats to take, so drivers join freely; a product with seats caps only the drivers', (t) => {
  const { database, clock, entitlements, accounts, ada } = setup(t);
  const organizations = createOrganizations({
    database, roles: ['owner', 'admin', 'member', 'driver'], seatRoles: ['driver'], seatsOf: entitlements.seatsOf, clock: () => clock.now,
  });
  const billing = createBilling({
    database, entitlements, provider: signedProvider({ secret: SECRET }), clock: () => clock.now, log: () => {},
    products: { ...FAMILY, 'fleet-yearly': { plan: 'family', kind: 'subscription', for: 'organization' } },
  });
  const [bob, eve, dan, kim, lee] = ['bob', 'eve', 'dan', 'kim', 'lee'].map((username) => accounts.create({ username }));
  const buy = (organization, product) => billing.apply({
    id: `evt_${organization.id}`, type: 'subscription', ref: `sub_${organization.id}`, subject: { type: 'organization', id: organization.id },
    product, status: 'active', quantity: 1, periodEnd: '2027-05-01T10:00:00Z',
  });

  const family = organizations.create({ name: 'Family', ownerId: ada.id });
  assert.equal(buy(family, 'family-pro'), 'granted');
  for (const person of [bob, eve, dan]) assert.equal(code(() => organizations.addMember(family.id, person.id, 'driver')), 'ok');
  const { token } = organizations.invite(family.id, { role: 'member' });
  organizations.accept(token, kim.id);
  assert.equal(code(() => organizations.setRole(family.id, kim.id, 'driver')), 'ok', 'moved into a seat role: there are no seats to take');
  assert.equal(organizations.seatsTaken(family.id), 4);

  // A product with seats: only the drivers count against them, as seatRoles says.
  const fleet = organizations.create({ name: 'Fleet', ownerId: ada.id });
  assert.equal(buy(fleet, 'fleet-yearly'), 'granted');
  assert.equal(entitlements.seatsOf(fleet.id), 1);
  assert.equal(code(() => organizations.addMember(fleet.id, bob.id, 'driver')), 'ok');
  assert.equal(code(() => organizations.addMember(fleet.id, eve.id, 'driver')), '402 seats_full');
  assert.equal(code(() => organizations.addMember(fleet.id, eve.id, 'admin')), 'ok', 'an admin takes no seat');
  assert.equal(code(() => organizations.setRole(fleet.id, eve.id, 'driver')), '402 seats_full');

  // A grant without a quantity sets no seats, like an admin's gift: one with a quantity still caps the group.
  const gift = entitlements.grant({ subjectType: 'organization', subjectId: family.id, plan: 'family', quantity: 4, source: 'admin' });
  assert.equal(entitlements.seatsOf(family.id), 4);
  assert.equal(code(() => organizations.addMember(family.id, lee.id, 'driver')), '402 seats_full');
  entitlements.revoke({ id: gift });
  assert.equal(entitlements.seatsOf(family.id), null);
});

test('seats is checked on start: only for a group\'s product, true or false, never misspelt; with or without a provider', (t) => {
  const { database, entitlements } = setup(t);
  const products = {
    person: { plan: 'family', kind: 'subscription', seats: false },
    typo: { plan: 'family', kind: 'subscription', for: 'organisation', seats: false },
    text: { plan: 'family', kind: 'subscription', for: 'organization', seats: 'no' },
    seat: { plan: 'family', kind: 'subscription', for: 'organization', seat: false },
    fine: { plan: 'family', kind: 'subscription', for: 'organization', seats: true },
    free: { plan: 'family', kind: 'subscription', for: 'organization', seats: false },
  };
  const bad = createBilling({ database, entitlements, provider: signedProvider({ secret: SECRET }), products });
  assert.deepEqual(bad.errors, [
    'Product "person": seats is only for a product for: \'organization\' (a person\'s plan has no seats)',
    'Product "typo": seats is only for a product for: \'organization\' (a person\'s plan has no seats)',
    'Product "text": seats must be true or false',
    'Product "seat": "seat" is not a setting (seats?)',
  ]);
  assert.equal(bad.enabled, false, 'a misspelt product never charges');

  // config.js says it too, before any provider: what a family bought must not depend on the install.
  const product = (given) => ({
    app: { id: 'focus', name: 'Focus', languages: ['en'] }, modules: { organizations: true, billing: true },
    plans: { free: { name: 'Free', features: {} }, family: { name: 'Family', features: {} } }, products: given,
  });
  const errorsOf = (given, env = {}) => resolveConfig(product(given), { DATA_DIR: os.tmpdir(), ...env }).errors;
  assert.deepEqual(errorsOf(products), [
    'products.person: seats is only for a product for: \'organization\' (a person\'s plan has no seats)',
    'products.typo: seats is only for a product for: \'organization\' (a person\'s plan has no seats)',
    'products.text: seats must be true or false',
    'products.seat: "seat" is not a setting (seats?)',
  ]);
  assert.deepEqual(errorsOf({ free: products.free, fine: products.fine, old: { plan: 'family', kind: 'once', for: 'organization' } }), []);
  assert.deepEqual(errorsOf(FAMILY, { BILLING_PROVIDER: 'remote', BILLING_SECRET: SECRET }), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-seats-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => createSuite({ config: product({ text: products.text }), env: { DATA_DIR: dir, PORT: '0' }, log: () => {}, exitOnError: false }),
    (err) => err instanceof SuiteConfigError && /products\.text: seats must be true or false/.test(err.message), 'the start stops');
});

test('createSuite: a family bought through the webhook has no seats, and its own plan reads without a person', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-family-'));
  const suite = createSuite({
    config: {
      app: { id: 'focus', name: 'Focus', languages: ['en'] }, modules: { organizations: true, billing: true },
      features: { 'routines.max': { type: 'limit', default: null }, live: { type: 'flag', default: true } },
      plans: { free: { name: 'Free', features: { 'routines.max': 5, live: false } }, pro: { name: 'Pro', features: {} } },
      products: { 'focus-pro-yearly': { plan: 'pro', kind: 'subscription', for: 'organization', seats: false } },
    },
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', BILLING_PROVIDER: 'remote', BILLING_SECRET: SECRET },
    log: () => {}, exitOnError: false,
  });
  t.after(() => { suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const [ada, bob, eve, dan] = ['ada', 'bob', 'eve', 'dan'].map((username) => suite.accounts.create({ username }));
  const home = suite.organizations.create({ name: 'Andersen', kind: 'family', ownerId: ada.id });
  suite.organizations.addMember(home.id, bob.id, 'admin');
  assert.equal(suite.billing.apply({
    id: 'evt_1', type: 'subscription', ref: 'sub_1', subject: { type: 'organization', id: home.id }, product: 'focus-pro-yearly',
    status: 'active', quantity: 1, periodEnd: new Date(Date.now() + 365 * DAY).toISOString(),
  }), 'granted');
  suite.organizations.addMember(home.id, eve.id, 'admin');
  const { token } = suite.organizations.invite(home.id, { role: 'admin' });
  suite.organizations.accept(token, dan.id);
  assert.equal(suite.organizations.membersOf(home.id).length, 4);
  assert.deepEqual(suite.entitlements.ofOrganization(home.id).features, { 'routines.max': null, live: true });
  assert.equal(suite.entitlements.of(dan).plan.id, 'pro');

  // Archived, the family has no plan of its own, whatever grants it kept.
  suite.organizations.archive(home.id);
  assert.equal(suite.entitlements.ofOrganization(home.id).plan.id, 'free');
  assert.deepEqual(suite.entitlements.ofOrganization(home.id).features, { 'routines.max': 5, live: false });
});
