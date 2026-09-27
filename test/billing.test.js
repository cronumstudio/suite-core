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
