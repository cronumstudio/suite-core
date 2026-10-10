/**
 * Paddle as billing's provider: the transaction and the portal session it
 * asks for, its webhook signature, its notifications turned into grants, and
 * what makes it the suite's: one subscription for every app, each with its own
 * database and webhook, applied by the WorkOS id and kept for whoever hasn't
 * opened the app yet. With a stand-in for the API (no network) and
 * notifications shaped and signed as Paddle sends them.
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
import { createEntitlements } from '../entitlements.js';
import { createBilling } from '../billing.js';
import { resolveConfig } from '../config.js';
import { createSuite, createApp } from '../app.js';
import { paddleProvider, verifyPaddleSignature, signPaddlePayload, providerId } from '../paddle.js';

const DAY = 24 * 3600 * 1000;
const SECRET = 'pdl_ntfset_01k0000000000000000000000_secretofthedestination';
const PRICES = {
  monthly: 'pri_01m46hn0s8qytrppech12h839e',
  yearly: 'pri_01m46hn0yc7jf84rt3bwbs80xk',
  founder: 'pri_01m46hn12r1e5c9n40a54jkh4g',
  pass: 'pri_01passpasspasspasspasspa',
};
const PRODUCTS = {
  'pro-monthly': { plan: 'pro', kind: 'subscription', price: PRICES.monthly },
  'pro-yearly': { plan: 'pro', kind: 'subscription', price: PRICES.yearly, founderPrice: PRICES.founder },
  'pro-pass': { plan: 'pro', kind: 'once', days: 30, price: PRICES.pass },
};
const ADA = 'user_01JADA0000000000000000000A';

/*
 * Two products on one Paddle account: Cronum Work (the PRODUCTS above, sold by Tasks and Next) and
 * Tracker, each with its own Paddle product. Every destination of the account gets every event.
 */
const WORK_PRODUCT_ID = 'pro_01m46hm0workprodct00000001';
const TRACKER_PRODUCT_ID = 'pro_01m46hm0trackerprod0000001';
const TRACKER_PRICES = { monthly: 'pri_01m46hm0trackermonth000001', org: 'pri_01m46hm0trackerorg00000001' };
const TRACKER_PRODUCTS = {
  'tracker-pro-monthly': { plan: 'pro', kind: 'subscription', price: TRACKER_PRICES.monthly },
  'tracker-org-monthly': { plan: 'pro', kind: 'subscription', price: TRACKER_PRICES.org, for: 'organization' },
};
/** What each install sets once it keeps the other product's sales out. */
const WORK_GUARD = { ignoreUnknownProducts: true, app: 'work', strictPrices: true, paddleProductIds: [WORK_PRODUCT_ID] };
const TRACKER_GUARD = { ignoreUnknownProducts: true, app: 'tracker', strictPrices: true, paddleProductIds: [TRACKER_PRODUCT_ID] };

/** A stand-in for Paddle's API: records each call and answers as Paddle does. */
function fakePaddle({ customers = [] } = {}) {
  const calls = [];
  const known = [...customers];
  const fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, pathname, method: init.method, headers: init.headers, body });
    let data;
    if (init.method === 'GET' && pathname === '/customers') {
      data = known.filter((c) => c.email === searchParams.get('email'));
    } else if (pathname === '/customers') {
      data = { id: `ctm_new${known.length}`, email: body.email };
      known.push(data);
    } else if (pathname === '/transactions') {
      const base = body.checkout?.url || 'https://pay.example/default';
      data = { id: 'txn_01test', checkout: { url: `${base}${base.includes('?') ? '&' : '?'}_ptxn=txn_01test` } };
    } else if (/^\/customers\/[^/]+\/portal-sessions$/.test(pathname)) {
      data = { id: 'cpls_1', urls: { general: { overview: 'https://customer-portal.paddle.com/cpl_1?token=x' } } };
    } else if (/^\/subscriptions\/[^/]+(\/cancel)?$/.test(pathname)) {
      data = { id: pathname.split('/')[2] };
    }
    return { ok: Boolean(data), status: data ? 200 : 404, json: async () => ({ data }) };
  };
  return { calls, fetch };
}

/**
 * One app of the suite: its own database, accounts, plans and Paddle webhook. `guard`: what keeps
 * another product's sales out, { ignoreUnknownProducts, app } for billing.js and
 * { strictPrices, paddleProductIds } for paddle.js; none by default, as the apps run today.
 */
function app(t, {
  now = '2026-11-01T10:00:00Z', paddle = fakePaddle(), founderUntil = null, clock = null, checkoutUrl = '',
  products = PRODUCTS, guard = {}, database: reused = null,
} = {}) {
  // `database`: another app()'s, for the same install started again with other options.
  let database = reused;
  if (!database) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-paddle-'));
    database = openDatabase({ dataDir: dir, name: 'test' });
    t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  }
  const time = clock || { now: Date.parse(now) };
  const accounts = createAccounts({ database, clock: () => time.now });
  const entitlements = createEntitlements({
    database, appId: 'test', clock: () => time.now,
    features: { assign: { type: 'flag', default: true } },
    plans: { free: { name: 'Free', features: { assign: false } }, pro: { name: 'Pro', features: {} } },
    plansJson: null, defaultPlanOverride: null, organizationsOf: () => [],
  });
  const logs = [];
  const provider = paddleProvider({
    apiKey: 'pdl_sdbx_apikey_test', webhookSecret: SECRET, environment: 'sandbox', checkoutUrl, products,
    fetch: paddle.fetch, clock: () => time.now, log: (line) => logs.push(line),
    ...(guard.strictPrices !== undefined ? { strictPrices: guard.strictPrices } : {}),
    ...(guard.paddleProductIds !== undefined ? { paddleProductIds: guard.paddleProductIds } : {}),
  });
  const identities = {
    of: (userId) => {
      const subject = accounts.identitiesOf(userId).find((i) => i.provider === 'workos')?.subject;
      return subject ? { provider: 'workos', subject } : null;
    },
    user: (provider, subject) => accounts.byIdentity(provider, subject)?.id ?? null,
  };
  const billing = createBilling({
    database, entitlements, provider, products, identities, clock: () => time.now, log: (line) => logs.push(line),
    isFounder: (user) => Boolean(founderUntil) && Date.parse(user.created_at) < Date.parse(founderUntil),
    ...(guard.ignoreUnknownProducts !== undefined ? { ignoreUnknownProducts: guard.ignoreUnknownProducts } : {}),
    ...(guard.app !== undefined ? { app: guard.app } : {}),
  });
  assert.deepEqual(billing.errors, []);
  accounts.whenLinked(({ userId, provider: p, subject }) => billing.claim(p, subject, userId));
  /** Signs in for the first time with WorkOS: the account is made with its identity. */
  const signIn = (workosId, username) => accounts.create({
    username, email: `${username}@example.com`, identity: { provider: 'workos', subject: workosId, email: `${username}@example.com` },
  });
  /** A notification as Paddle delivers it: signed, at the clock's time. */
  const deliver = async (notification) => {
    const body = JSON.stringify(notification);
    const parsed = await provider.parseWebhook({
      headers: { 'paddle-signature': signPaddlePayload(SECRET, body, time.now) }, body,
    });
    return parsed ? billing.apply(parsed) : null;
  };
  const planOf = (user) => entitlements.of(accounts.byId(user.id)).plan.id;
  return { database, clock: time, accounts, entitlements, billing, provider, paddle, deliver, planOf, signIn, logs };
}

/** A subscription.* notification, shaped like Paddle's. `custom`: its whole custom_data instead. */
function subscriptionEvent(id, {
  type = 'subscription.created', occurredAt, status = 'active', price = PRICES.yearly, endsAt,
  workosId = ADA, sub = 'sub_01ada', customer = 'ctm_01ada', scheduled = null, productId = 'pro_01', custom = null,
}) {
  return {
    event_id: id, event_type: type, occurred_at: occurredAt, notification_id: `ntf_${id}`,
    data: {
      id: sub, status, customer_id: customer, address_id: 'add_01', currency_code: 'EUR',
      items: [{ status: 'active', quantity: 1, recurring: true, price: { id: price, product_id: productId } }],
      current_billing_period: endsAt ? { starts_at: occurredAt, ends_at: endsAt } : null,
      scheduled_change: scheduled,
      custom_data: custom || { workos_user_id: workosId, email: 'ada@example.com', product: 'pro-yearly' },
    },
  };
}

const refundEvent = (id, { type = 'adjustment.updated', occurredAt, status = 'approved', kind = 'full', action = 'refund', sub = 'sub_01ada' }) => ({
  event_id: id, event_type: type, occurred_at: occurredAt,
  data: {
    id: 'adj_01', action, type: kind, status, transaction_id: 'txn_01ada', subscription_id: sub,
    customer_id: 'ctm_01ada', items: [], totals: { total: '3500' },
  },
});

/* ------------------------------- signature ------------------------------ */

test('Paddle-Signature: ts and h1 over "ts:body", within five minutes, any h1 while a secret rotates', () => {
  const now = Date.parse('2026-11-01T10:00:00Z');
  const body = '{"event_type":"subscription.created"}';
  const header = signPaddlePayload(SECRET, body, now);
  assert.match(header, /^ts=\d+;h1=[0-9a-f]{64}$/);
  assert.equal(verifyPaddleSignature(SECRET, body, header, { now }), true);
  assert.equal(verifyPaddleSignature(SECRET, `${body} `, header, { now }), false, 'another body');
  assert.equal(verifyPaddleSignature('pdl_ntfset_other', body, header, { now }), false, 'another secret');
  assert.equal(verifyPaddleSignature(SECRET, body, header, { now: now + 6 * 60 * 1000 }), false, 'too old');
  const rotating = `${signPaddlePayload('pdl_ntfset_old', body, now)};h1=${header.split('h1=')[1]}`;
  assert.equal(verifyPaddleSignature(SECRET, body, rotating, { now }), true);
  assert.equal(verifyPaddleSignature(SECRET, body, '', { now }), false);
  assert.equal(verifyPaddleSignature(SECRET, body, 'ts=abc;h1=zz', { now }), false);
});

test('a bad signature is refused; what billing doesn\'t need is acknowledged and ignored', async (t) => {
  const { provider, deliver } = app(t);
  const body = JSON.stringify(subscriptionEvent('evt_x', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z' }));
  await assert.rejects(provider.parseWebhook({ headers: { 'paddle-signature': signPaddlePayload('pdl_ntfset_wrong', body) }, body }),
    (err) => err.status === 400 && err.code === 'bad_signature');
  await assert.rejects(provider.parseWebhook({ headers: {}, body }), (err) => err.code === 'bad_signature');
  assert.equal(await deliver({ event_id: 'evt_c', event_type: 'customer.created', occurred_at: '2026-11-01T10:00:00Z', data: { id: 'ctm_1' } }), null);
  assert.equal(await deliver({
    event_id: 'evt_t', event_type: 'transaction.completed', occurred_at: '2026-11-01T10:00:00Z',
    data: { id: 'txn_1', subscription_id: 'sub_01ada', items: [{ price: { id: PRICES.yearly } }], custom_data: { workos_user_id: ADA } },
  }), null, 'a subscription\'s transaction is followed by its own subscription events');
  assert.equal(await deliver(refundEvent('evt_r0', { occurredAt: '2026-11-01T10:00:00Z', status: 'pending_approval' })), null,
    'a refund waits for Paddle\'s approval');
  assert.equal(await deliver(refundEvent('evt_r1', { occurredAt: '2026-11-01T10:00:00Z', kind: 'partial' })), null, 'a partial refund is a gesture');
  assert.equal(await deliver(refundEvent('evt_r2', { occurredAt: '2026-11-01T10:00:00Z', action: 'credit' })), null);
});

/* -------------------------------- checkout ------------------------------- */

test('checkout: a transaction with the WorkOS id in custom_data, the customer found by email, and the page\'s link', async (t) => {
  const paddle = fakePaddle({ customers: [{ id: 'ctm_known', email: 'ada@example.com' }] });
  const { billing, signIn } = app(t, { paddle, checkoutUrl: 'https://cronumstudio.com/pay/' });
  const ada = signIn(ADA, 'ada');
  const url = await billing.checkoutUrl({ type: 'user', id: ada.id }, 'pro-monthly', {
    email: 'ada@example.com', user: ada, returnUrl: 'https://tasks.example/?billing=done',
  });
  assert.equal(url, 'https://cronumstudio.com/pay/?return=https%3A%2F%2Ftasks.example%2F%3Fbilling%3Ddone&env=sandbox&_ptxn=txn_01test');
  const lookup = paddle.calls[0];
  assert.equal(lookup.method, 'GET');
  assert.equal(new URL(lookup.url).searchParams.get('email'), 'ada@example.com');
  const tx = paddle.calls[1];
  assert.equal(tx.url, 'https://sandbox-api.paddle.com/transactions');
  assert.equal(tx.headers.Authorization, 'Bearer pdl_sdbx_apikey_test');
  assert.equal(tx.headers['Paddle-Version'], '1');
  assert.deepEqual(tx.body.items, [{ price_id: PRICES.monthly, quantity: 1 }]);
  assert.equal(tx.body.customer_id, 'ctm_known');
  assert.deepEqual(tx.body.custom_data, { workos_user_id: ADA, email: 'ada@example.com', product: 'pro-monthly' },
    'who pays by their WorkOS id, never by this app\'s own id');
});

test('checkout: a new customer is made for a verified email; without one Paddle\'s checkout asks; without WorkOS the subject goes', async (t) => {
  const paddle = fakePaddle();
  const { billing, accounts, signIn } = app(t, { paddle });
  const ada = signIn(ADA, 'ada');
  const url = await billing.checkoutUrl({ type: 'user', id: ada.id }, 'pro-monthly', { email: 'ada@example.com', user: ada, returnUrl: 'x' });
  assert.equal(url, 'https://pay.example/default?_ptxn=txn_01test', 'without a checkout page, the account\'s default payment link');
  assert.equal(paddle.calls[1].method, 'POST');
  assert.equal(paddle.calls[1].pathname, '/customers');
  assert.equal(paddle.calls[2].body.customer_id, 'ctm_new0');
  assert.equal(paddle.calls[2].body.checkout, undefined);

  const local = accounts.create({ username: 'bob' });
  paddle.calls.length = 0;
  await billing.checkoutUrl({ type: 'user', id: local.id }, 'pro-monthly', { user: local, returnUrl: 'x' });
  assert.equal(paddle.calls.length, 1, 'no email, no customer lookup');
  assert.equal(paddle.calls[0].body.customer_id, undefined);
  assert.deepEqual(paddle.calls[0].body.custom_data, { subject: `user:${local.id}`, product: 'pro-monthly' });
});

test('the founder\'s price: chosen on the server for whoever joined in the early access, never named by the browser', async (t) => {
  const clock = { now: Date.parse('2026-10-01T10:00:00Z') };
  const paddle = fakePaddle();
  const { billing, signIn } = app(t, { paddle, clock, founderUntil: '2026-12-01T00:00:00Z' });
  const early = signIn(ADA, 'ada');
  clock.now = Date.parse('2026-12-15T10:00:00Z');
  const late = signIn('user_01JLATE000000000000000000L', 'leo');
  const priceFor = async (user, product) => {
    paddle.calls.length = 0;
    await billing.checkoutUrl({ type: 'user', id: user.id }, product, { user, returnUrl: 'x' });
    return paddle.calls.at(-1).body.items[0].price_id;
  };
  assert.equal(await priceFor(early, 'pro-yearly'), PRICES.founder);
  assert.equal(await priceFor(late, 'pro-yearly'), PRICES.yearly);
  assert.equal(await priceFor(early, 'pro-monthly'), PRICES.monthly, 'only the products that have one');
  assert.equal(await billing.founder(early), true);
  assert.equal(await billing.founder(late), false);
  assert.deepEqual(billing.offer().map((p) => [p.key, p.founder_price]), [['pro-monthly', false], ['pro-yearly', true], ['pro-pass', false]]);
  assert.ok(!JSON.stringify(billing.offer()).includes('pri_'), 'the offer never shows price ids');
});

test('the portal: a session for the person\'s customer, with its link', async (t) => {
  const paddle = fakePaddle();
  const { billing, deliver, signIn } = app(t, { paddle });
  const ada = signIn(ADA, 'ada');
  await assert.rejects(billing.portalUrl({ type: 'user', id: ada.id }, { returnUrl: 'x' }), (err) => err.code === 'no_customer');
  await deliver(subscriptionEvent('evt_1', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z' }));
  assert.equal(await billing.portalUrl({ type: 'user', id: ada.id }, { returnUrl: 'x' }), 'https://customer-portal.paddle.com/cpl_1?token=x');
  assert.equal(paddle.calls.at(-1).pathname, '/customers/ctm_01ada/portal-sessions');
});

test('Paddle\'s errors go to the log, never to the person paying', async (t) => {
  const paddle = {
    fetch: async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 'not_found', detail: 'price pri_x not found' } }) }),
  };
  const { billing, signIn, logs } = app(t, { paddle });
  const ada = signIn(ADA, 'ada');
  await assert.rejects(billing.checkoutUrl({ type: 'user', id: ada.id }, 'pro-monthly', { user: ada, returnUrl: 'x' }),
    (err) => err.status === 502 && err.code === 'billing_provider_error' && !/pri_x/.test(err.message));
  assert.ok(logs.some((line) => /price pri_x not found/.test(line)));
});

/* ------------------------------- webhooks -------------------------------- */

test('a subscription: bought, renewed, cancelled at the end of the period, and ended', async (t) => {
  const { deliver, signIn, planOf, clock, database } = app(t);
  const ada = signIn(ADA, 'ada');
  assert.equal(planOf(ada), 'free');
  assert.equal(await deliver(subscriptionEvent('evt_1', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z' })), 'granted');
  assert.equal(planOf(ada), 'pro');
  assert.equal(await deliver(subscriptionEvent('evt_1', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z' })), 'duplicate');
  // The renewal: a new period.
  clock.now = Date.parse('2027-11-01T10:00:05Z');
  assert.equal(await deliver(subscriptionEvent('evt_2', {
    type: 'subscription.updated', occurredAt: '2027-11-01T10:00:01Z', endsAt: '2028-11-01T10:00:00Z',
  })), 'extended');
  const grant = database.get("SELECT * FROM entitlement_grants WHERE source = 'paddle-sandbox'");
  assert.equal(grant.ends_at, new Date(Date.parse('2028-11-01T10:00:00Z') + 3 * DAY).toISOString(), 'the paid period and three days of grace');
  // Cancelled in the portal: active until the period ends.
  assert.equal(await deliver(subscriptionEvent('evt_3', {
    type: 'subscription.updated', occurredAt: '2027-12-01T10:00:00Z', endsAt: '2028-11-01T10:00:00Z',
    scheduled: { action: 'cancel', effective_at: '2028-11-01T10:00:00Z' },
  })), 'extended');
  assert.equal(planOf(ada), 'pro');
  assert.equal(await deliver(subscriptionEvent('evt_4', { type: 'subscription.canceled', status: 'canceled', occurredAt: '2028-11-01T10:00:01Z' })), 'revoked');
  assert.equal(planOf(ada), 'free');
  // An older update arriving late doesn't bring it back.
  assert.equal(await deliver(subscriptionEvent('evt_late', {
    type: 'subscription.updated', occurredAt: '2027-12-02T10:00:00Z', endsAt: '2028-11-01T10:00:00Z',
  })), 'stale');
  assert.equal(planOf(ada), 'free');
});

test('someone deleting their account: their subscription stops renewing, renews again, and ends (account-deletion.js)', async (t) => {
  const { deliver, signIn, billing, paddle, database } = app(t);
  const ada = signIn(ADA, 'ada');
  const bob = signIn('user_01JBOB0000000000000000000B', 'bob');
  await deliver(subscriptionEvent('evt_1', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z' }));
  const before = paddle.calls.length;
  assert.equal(await billing.stopRenewals(ada.id), 1);
  assert.equal(await billing.keepRenewals(ada.id), 1);
  assert.equal(await billing.endSubscriptions(ada.id), 1);
  assert.deepEqual(paddle.calls.slice(before).map((c) => [c.method, c.pathname, c.body]), [
    ['POST', '/subscriptions/sub_01ada/cancel', { effective_from: 'next_billing_period' }],
    ['PATCH', '/subscriptions/sub_01ada', { scheduled_change: null }],
    ['POST', '/subscriptions/sub_01ada/cancel', { effective_from: 'immediately' }],
  ]);
  assert.equal(await billing.stopRenewals(bob.id), 0, 'someone without a subscription: nothing to ask Paddle');
  database.run("UPDATE billing_subscriptions SET status = 'canceled'");
  assert.equal(await billing.endSubscriptions(ada.id), 0, 'one already over is left alone');
});

test('paused is not paid for; resumed, Pro again; a founder\'s price is still Pro', async (t) => {
  const { deliver, signIn, planOf } = app(t);
  const ada = signIn(ADA, 'ada');
  await deliver(subscriptionEvent('evt_1', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z', price: PRICES.founder }));
  assert.equal(planOf(ada), 'pro');
  assert.equal(await deliver(subscriptionEvent('evt_2', { type: 'subscription.paused', status: 'paused', occurredAt: '2026-12-01T10:00:00Z' })), 'revoked');
  assert.equal(planOf(ada), 'free');
  assert.equal(await deliver(subscriptionEvent('evt_3', {
    type: 'subscription.resumed', occurredAt: '2027-01-01T10:00:00Z', endsAt: '2028-01-01T10:00:00Z',
  })), 'granted');
  assert.equal(planOf(ada), 'pro');
});

test('a refund takes Pro back, and the period it paid back doesn\'t return it; the next one paid does', async (t) => {
  const { deliver, signIn, planOf } = app(t);
  const ada = signIn(ADA, 'ada');
  await deliver(subscriptionEvent('evt_1', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z' }));
  assert.equal(await deliver(refundEvent('evt_r', { occurredAt: '2026-11-05T10:00:00Z' })), 'revoked');
  assert.equal(planOf(ada), 'free');
  // Paddle may still say the subscription is active for that period (the refund doesn't cancel it).
  assert.equal(await deliver(subscriptionEvent('evt_2', {
    type: 'subscription.updated', occurredAt: '2026-11-05T10:00:01Z', endsAt: '2027-11-01T10:00:00Z',
  })), 'refunded');
  assert.equal(planOf(ada), 'free');
  assert.equal(await deliver(subscriptionEvent('evt_3', {
    type: 'subscription.updated', occurredAt: '2027-11-01T10:00:01Z', endsAt: '2028-11-01T10:00:00Z',
  })), 'granted', 'renewed and paid: Pro again');
  assert.equal(planOf(ada), 'pro');
});

test('a chargeback takes Pro back too; created already approved', async (t) => {
  const { deliver, signIn, planOf } = app(t);
  const ada = signIn(ADA, 'ada');
  await deliver(subscriptionEvent('evt_1', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z' }));
  assert.equal(await deliver(refundEvent('evt_cb', { type: 'adjustment.created', action: 'chargeback', occurredAt: '2026-11-09T10:00:00Z' })), 'revoked');
  assert.equal(planOf(ada), 'free');
});

test('a one-off purchase: transaction.completed without a subscription, for the product\'s days; refunded, gone', async (t) => {
  const { deliver, signIn, planOf, database } = app(t);
  const ada = signIn(ADA, 'ada');
  const completed = (id, txn, price, product) => deliver({
    event_id: id, event_type: 'transaction.completed', occurred_at: '2026-11-01T10:00:00Z',
    data: {
      id: txn, status: 'completed', subscription_id: null, customer_id: 'ctm_01ada',
      items: [{ price: { id: price }, quantity: 1 }], custom_data: { workos_user_id: ADA, product },
    },
  });
  assert.equal(await completed('evt_x', 'txn_x', 'pri_unknown', 'nothing'), 'ignored', 'a product this app doesn\'t sell');
  assert.equal(await completed('evt_t', 'txn_once', PRICES.pass, 'pro-pass'), 'granted');
  assert.equal(planOf(ada), 'pro');
  assert.equal(database.get("SELECT ends_at FROM entitlement_grants WHERE external_ref = 'txn_once'").ends_at, '2026-12-01T10:00:00.000Z');
  assert.equal(await deliver({
    event_id: 'evt_r', event_type: 'adjustment.updated', occurred_at: '2026-11-02T10:00:00Z',
    data: { id: 'adj_2', action: 'refund', type: 'full', status: 'approved', transaction_id: 'txn_once', subscription_id: null },
  }), 'revoked');
  assert.equal(planOf(ada), 'free');
});

/* ------------------------- one subscription, every app ------------------------ */

test('one subscription for every app: each applies it by the WorkOS id, and one not opened yet gets it at the first sign-in', async (t) => {
  const tasks = app(t);
  const next = app(t);
  // Tasks has other people first: Ada is #3 there, and #1 in Next is someone else.
  tasks.accounts.create({ username: 'zoe' });
  tasks.accounts.create({ username: 'yan' });
  const adaInTasks = tasks.signIn(ADA, 'ada');
  const bea = next.signIn('user_01JBEA0000000000000000000B', 'bea');
  assert.notEqual(adaInTasks.id, bea.id);

  const bought = subscriptionEvent('evt_1', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z' });
  assert.equal(await tasks.deliver(bought), 'granted');
  assert.equal(await next.deliver(bought), 'pending', 'Ada hasn\'t opened Next yet');
  assert.equal(next.planOf(bea), 'free', 'not to whoever has her id in Tasks');
  // A renewal while she still hasn't: it waits too, in order.
  const renewed = subscriptionEvent('evt_2', { type: 'subscription.updated', occurredAt: '2027-11-01T10:00:01Z', endsAt: '2028-11-01T10:00:00Z' });
  assert.equal(await next.deliver(renewed), 'pending');
  assert.equal(await tasks.deliver(renewed), 'extended');

  const adaInNext = next.signIn(ADA, 'ada');
  assert.equal(next.planOf(adaInNext), 'pro', 'Pro at her first sign-in');
  const grant = next.database.get("SELECT * FROM entitlement_grants WHERE source = 'paddle-sandbox' AND revoked_at IS NULL");
  assert.equal(grant.subject_id, adaInNext.id);
  assert.equal(grant.ends_at, new Date(Date.parse('2028-11-01T10:00:00Z') + 3 * DAY).toISOString(), 'with the latest period');
  assert.equal(next.database.get('SELECT COUNT(*) AS n FROM billing_pending').n, 0);
  assert.equal(next.database.get("SELECT outcome FROM billing_events WHERE event_id = 'evt_1'").outcome, 'granted');
  assert.equal(next.billing.customerOf({ type: 'user', id: adaInNext.id }), 'ctm_01ada', 'and her portal');
  // Cancelling reaches both.
  const ended = subscriptionEvent('evt_3', { type: 'subscription.canceled', status: 'canceled', occurredAt: '2028-11-01T10:00:01Z' });
  assert.equal(await tasks.deliver(ended), 'revoked');
  assert.equal(await next.deliver(ended), 'revoked');
  assert.equal(tasks.planOf(adaInTasks), 'free');
  assert.equal(next.planOf(adaInNext), 'free');
});

test('a refund of what is still waiting waits with it: at the first sign-in, nothing is given', async (t) => {
  const next = app(t);
  await next.deliver(subscriptionEvent('evt_1', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z' }));
  assert.equal(await next.deliver(refundEvent('evt_r', { occurredAt: '2026-11-03T10:00:00Z' })), 'pending');
  const ada = next.signIn(ADA, 'ada');
  assert.equal(next.planOf(ada), 'free');
  assert.equal(next.database.get("SELECT outcome FROM billing_events WHERE event_id = 'evt_r'").outcome, 'revoked');
});

test('the identity outranks an older link: a customer linked to someone else here moves to whom WorkOS says', async (t) => {
  const tasks = app(t);
  const other = tasks.accounts.create({ username: 'carl' });
  tasks.billing.linkCustomer({ type: 'user', id: other.id }, 'ctm_01ada');
  const ada = tasks.signIn(ADA, 'ada');
  assert.equal(await tasks.deliver(subscriptionEvent('evt_1', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z' })), 'granted');
  assert.equal(tasks.planOf(ada), 'pro');
  assert.equal(tasks.planOf(other), 'free');
  assert.equal(tasks.billing.customerOf({ type: 'user', id: ada.id }), 'ctm_01ada');
  assert.equal(tasks.billing.customerOf({ type: 'user', id: other.id }), null, 'Carl no longer opens Ada\'s portal');
});

test('an identity that never comes: the event is dropped after a while; a broken one never stops a sign-in', async (t) => {
  const next = app(t);
  await next.deliver(subscriptionEvent('evt_1', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z', workosId: 'user_01JNOBODY00000000000000000' }));
  assert.equal(next.database.get('SELECT COUNT(*) AS n FROM billing_pending').n, 1);
  next.clock.now += 401 * DAY;
  await next.deliver({ event_id: 'evt_other', event_type: 'customer.created', occurred_at: '2027-12-01T10:00:00Z', data: {} });
  await next.deliver(subscriptionEvent('evt_2', { occurredAt: '2027-12-06T10:00:00Z', endsAt: '2028-12-06T10:00:00Z', workosId: ADA, sub: 'sub_2' }));
  assert.equal(next.database.get("SELECT COUNT(*) AS n FROM billing_pending WHERE identity_subject = 'user_01JNOBODY00000000000000000'").n, 0);
  next.database.run("UPDATE billing_pending SET event = '{not json' WHERE identity_subject = ?", ADA);
  const ada = next.signIn(ADA, 'ada');
  assert.ok(ada.id, 'signed in all the same');
  assert.ok(next.logs.some((line) => /could not be applied/.test(line)));
});

/* ------------------------- another product's sales ------------------------- */

const START = '2026-11-01T10:00:00Z';
const END = '2027-11-01T10:00:00Z';
const count = (install, table) => install.database.get(`SELECT COUNT(*) AS n FROM ${table}`).n;
const outcomes = (install) => install.database.all('SELECT event_id, type, outcome FROM billing_events ORDER BY rowid')
  .map((r) => [r.event_id, r.type, r.outcome]);

/** A Cronum Work sale, as an install that writes custom_data.app sends it (`seller: null`: one from before). */
const workSale = (id, { price = PRICES.yearly, product = 'pro-yearly', seller = 'work', sub = 'sub_01ada' } = {}) => subscriptionEvent(id, {
  occurredAt: START, endsAt: END, price, productId: WORK_PRODUCT_ID, sub,
  custom: { workos_user_id: ADA, email: 'ada@example.com', product, ...(seller ? { app: seller } : {}) },
});
/** A Tracker sale to Ada, who also uses Cronum Work: the same WorkOS id, the same Paddle customer. */
const trackerSale = (id, { product = 'tracker-pro-monthly' } = {}) => subscriptionEvent(id, {
  occurredAt: START, endsAt: END, price: TRACKER_PRICES.monthly, productId: TRACKER_PRODUCT_ID, sub: 'sub_01trk',
  custom: { workos_user_id: ADA, email: 'ada@example.com', product, app: 'tracker' },
});
/** A Tracker sale to a group: a group's checkout names it by its id in the install that sold it. */
const trackerGroupSale = (id) => subscriptionEvent(id, {
  occurredAt: START, endsAt: END, price: TRACKER_PRICES.org, productId: TRACKER_PRODUCT_ID, sub: 'sub_01org', customer: 'ctm_01org',
  custom: { subject: 'organization:1', product: 'tracker-org-monthly', app: 'tracker' },
});

test('A · a Work sale in a Tracker install is foreign: no customer linked, nothing of the person kept', async (t) => {
  // Without the options, as the apps run today: Ada's Work customer is linked in Tracker, and only then ignored.
  const before = app(t, { products: TRACKER_PRODUCTS });
  const adaBefore = before.signIn(ADA, 'ada');
  assert.equal(await before.deliver(workSale('evt_w1')), 'ignored');
  assert.equal(before.billing.customerOf({ type: 'user', id: adaBefore.id }), 'ctm_01ada');

  // Any one guard keeps it out; an install sets them all.
  const guards = {
    all: TRACKER_GUARD,
    ignoreUnknownProducts: { ignoreUnknownProducts: true },
    paddleProductIds: { paddleProductIds: [TRACKER_PRODUCT_ID] },
    app: { app: 'tracker' },
  };
  for (const [name, guard] of Object.entries(guards)) {
    const tracker = app(t, { products: TRACKER_PRODUCTS, guard });
    const ada = tracker.signIn(ADA, 'ada');
    assert.equal(await tracker.deliver(workSale('evt_w1')), 'foreign', name);
    assert.equal(tracker.billing.customerOf({ type: 'user', id: ada.id }), null, `${name}: Ada's Work customer is nobody's here`);
    for (const table of ['billing_customers', 'billing_subscriptions', 'billing_pending', 'entitlement_grants']) {
      assert.equal(count(tracker, table), 0, `${name}: nothing in ${table}`);
    }
    assert.deepEqual(outcomes(tracker), [['evt_w1', 'subscription', 'foreign']], `${name}: only its id, type and outcome`);
    const said = tracker.logs.join('\n');
    assert.ok(said.includes('evt_w1') && !said.includes(ADA) && !said.includes('ctm_01ada') && !said.includes('@'),
      `${name}: the log says the event, and no one`);
    assert.equal(tracker.planOf(ada), 'free');
    // Its own sale still counts.
    assert.equal(await tracker.deliver(trackerSale('evt_t1')), 'granted', name);
    assert.equal(tracker.planOf(ada), 'pro');
  }
});

test('B · someone who never opened an app: another product\'s sale leaves nothing waiting there, either way', async (t) => {
  // Without the options, as today: a Work sale waits in Tracker for 400 days, with Ada's WorkOS id.
  const before = app(t, { products: TRACKER_PRODUCTS });
  assert.equal(await before.deliver(workSale('evt_w1')), 'pending');
  assert.equal(before.database.get('SELECT identity_subject FROM billing_pending').identity_subject, ADA);

  const tracker = app(t, { products: TRACKER_PRODUCTS, guard: TRACKER_GUARD });
  assert.equal(await tracker.deliver(workSale('evt_w1')), 'foreign', 'a Work payer who never opened Tracker');
  assert.equal(count(tracker, 'billing_pending'), 0);
  const tasks = app(t, { guard: WORK_GUARD });
  assert.equal(await tasks.deliver(trackerSale('evt_t1')), 'foreign', 'a Tracker payer who never opened Tasks');
  assert.equal(count(tasks, 'billing_pending'), 0);
  // When they do, nothing comes with them.
  const adaInTracker = tracker.signIn(ADA, 'ada');
  const adaInTasks = tasks.signIn(ADA, 'ada');
  assert.equal(tracker.planOf(adaInTracker), 'free');
  assert.equal(tasks.planOf(adaInTasks), 'free');
  assert.equal(count(tracker, 'billing_customers') + count(tasks, 'billing_customers'), 0);

  // A sale of its own product still waits for its person: one subscription for every app of Cronum Work.
  const next = app(t, { guard: WORK_GUARD });
  assert.equal(await next.deliver(workSale('evt_w2')), 'pending');
  const adaInNext = next.signIn(ADA, 'ada');
  assert.equal(next.planOf(adaInNext), 'pro');
  assert.equal(next.billing.customerOf({ type: 'user', id: adaInNext.id }), 'ctm_01ada');
  // One sold before checkouts said the app counts too: the app is only compared when it is there.
  assert.equal(await next.deliver(workSale('evt_w3', { seller: null, sub: 'sub_02ada' })), 'granted');
});

test('C · a key two products share: the price says whose it is, not custom_data.product, and nothing is granted', async (t) => {
  // Tracker names a product "pro-monthly" too, with a price of its own.
  const shared = (id) => trackerSale(id, { product: 'pro-monthly' });
  // Without the options, as today: Tasks reads custom_data.product and gives Pro for a Tracker sale.
  const before = app(t);
  const adaBefore = before.signIn(ADA, 'ada');
  assert.equal(await before.deliver(shared('evt_t1')), 'granted');
  assert.equal(before.planOf(adaBefore), 'pro');

  for (const [name, guard] of Object.entries({
    all: WORK_GUARD,
    'strictPrices with ignoreUnknownProducts': { strictPrices: true, ignoreUnknownProducts: true },
    paddleProductIds: { paddleProductIds: [WORK_PRODUCT_ID] },
    app: { app: 'work' },
  })) {
    const tasks = app(t, { guard });
    const ada = tasks.signIn(ADA, 'ada');
    assert.equal(await tasks.deliver(shared('evt_t1')), 'foreign', name);
    assert.equal(tasks.planOf(ada), 'free', `${name}: not granted`);
    assert.equal(count(tasks, 'billing_customers'), 0, name);
  }
  // strictPrices alone doesn't grant either, but the customer is linked first: it goes with ignoreUnknownProducts.
  const strict = app(t, { guard: { strictPrices: true } });
  const adaStrict = strict.signIn(ADA, 'ada');
  assert.equal(await strict.deliver(shared('evt_t1')), 'ignored');
  assert.equal(strict.planOf(adaStrict), 'free');

  // The other way round: Tracker's own "pro-monthly" is granted there, Work's isn't.
  const tracker = app(t, { products: { 'pro-monthly': TRACKER_PRODUCTS['tracker-pro-monthly'] }, guard: TRACKER_GUARD });
  const ada = tracker.signIn(ADA, 'ada');
  assert.equal(await tracker.deliver(workSale('evt_w1', { price: PRICES.monthly, product: 'pro-monthly' })), 'foreign');
  assert.equal(tracker.planOf(ada), 'free');
  assert.equal(await tracker.deliver(shared('evt_t2')), 'granted');
  assert.equal(tracker.planOf(ada), 'pro');
});

test('D · a group\'s sale in another install: no customer row for whichever group has that number there', async (t) => {
  // Without the options, as today: Tasks links Tracker's group customer to its own "organization 1".
  const before = app(t);
  assert.equal(await before.deliver(trackerGroupSale('evt_g1')), 'ignored');
  assert.deepEqual(before.database.all('SELECT subject_type, subject_id, customer_id FROM billing_customers')
    .map((r) => [r.subject_type, r.subject_id, r.customer_id]), [['organization', 1, 'ctm_01org']]);

  for (const [name, guard] of Object.entries({
    all: WORK_GUARD,
    ignoreUnknownProducts: { ignoreUnknownProducts: true },
    paddleProductIds: { paddleProductIds: [WORK_PRODUCT_ID] },
    app: { app: 'work' },
  })) {
    const tasks = app(t, { guard });
    assert.equal(await tasks.deliver(trackerGroupSale('evt_g1')), 'foreign', name);
    for (const table of ['billing_customers', 'billing_subscriptions', 'entitlement_grants']) {
      assert.equal(count(tasks, table), 0, `${name}: nothing in ${table}`);
    }
  }
  // In Tracker, the group it sold to gets it.
  const tracker = app(t, { products: TRACKER_PRODUCTS, guard: TRACKER_GUARD });
  assert.equal(await tracker.deliver(trackerGroupSale('evt_g1')), 'granted');
  assert.equal(tracker.billing.customerOf({ type: 'organization', id: 1 }), 'ctm_01org');
  assert.equal(tracker.database.get('SELECT subject_type FROM entitlement_grants').subject_type, 'organization');
});

test('refunds are not checked: an install\'s own is still taken back, waiting or not; another product\'s finds nothing', async (t) => {
  const tracker = app(t, { products: TRACKER_PRODUCTS, guard: TRACKER_GUARD });
  const ada = tracker.signIn(ADA, 'ada');
  assert.equal(await tracker.deliver(trackerSale('evt_t1')), 'granted');
  assert.equal(await tracker.deliver(refundEvent('evt_r1', { occurredAt: '2026-11-03T10:00:00Z', sub: 'sub_01trk' })), 'revoked');
  assert.equal(tracker.planOf(ada), 'free');
  assert.equal(await tracker.deliver(refundEvent('evt_r2', { occurredAt: '2026-11-04T10:00:00Z' })), 'nothing',
    'a refund of a Work sale touches nothing here');
  // In Next, a refund of what still waits for Ada waits with it.
  const next = app(t, { guard: WORK_GUARD });
  assert.equal(await next.deliver(workSale('evt_w1')), 'pending');
  assert.equal(await next.deliver(refundEvent('evt_r3', { occurredAt: '2026-11-03T10:00:00Z' })), 'pending');
  const adaInNext = next.signIn(ADA, 'ada');
  assert.equal(next.planOf(adaInNext), 'free');
  assert.equal(next.database.get("SELECT outcome FROM billing_events WHERE event_id = 'evt_r3'").outcome, 'revoked');
});

test('with strictPrices, a price no longer sold still renews as its product (oldPrices); the checkout says which app sells', async (t) => {
  const NEW_YEARLY = 'pri_01m46hm0workyearlynew00001';
  const products = { ...PRODUCTS, 'pro-yearly': { ...PRODUCTS['pro-yearly'], price: NEW_YEARLY, oldPrices: [PRICES.yearly] } };
  const paddle = fakePaddle();
  const tasks = app(t, { products, guard: WORK_GUARD, paddle });
  const ada = tasks.signIn(ADA, 'ada');
  assert.equal(await tasks.deliver(workSale('evt_w1')), 'granted', 'bought on the old price');
  assert.equal(tasks.planOf(ada), 'pro');

  const bob = tasks.signIn('user_01JBOB0000000000000000000B', 'bob');
  await tasks.billing.checkoutUrl({ type: 'user', id: bob.id }, 'pro-yearly', { user: bob, returnUrl: 'x' });
  assert.deepEqual(paddle.calls.at(-1).body.custom_data, { workos_user_id: 'user_01JBOB0000000000000000000B', product: 'pro-yearly', app: 'work' });
  assert.deepEqual(paddle.calls.at(-1).body.items, [{ price_id: NEW_YEARLY, quantity: 1 }], 'sold at the current price');
});

test('its own Paddle product on a price no product lists: a price missing from the config, said loudly, never foreign', async (t) => {
  const UNLISTED = 'pri_01m46hm0unlistedprice00001';
  const renewal = (id, sub) => workSale(id, { price: UNLISTED, sub });
  const tasks = app(t, { guard: WORK_GUARD });
  const ada = tasks.signIn(ADA, 'ada');
  assert.equal(await tasks.deliver(renewal('evt_w1', 'sub_01ada')), 'ignored', 'paddleProductIds knows it is Work\'s');
  assert.deepEqual(outcomes(tasks), [['evt_w1', 'subscription', 'ignored']], 'not filed as another product\'s');
  assert.equal(tasks.planOf(ada), 'free', 'not granted on a price it can\'t place');
  assert.equal(tasks.billing.customerOf({ type: 'user', id: ada.id }), 'ctm_01ada', 'its own customer');
  const said = tasks.logs.join('\n');
  assert.ok(said.includes(UNLISTED) && /own product/.test(said) && /oldPrices/.test(said), 'the log names the price to add');
  assert.ok(!/another product/.test(said));

  // Someone who hasn't opened the app yet: it waits for them, as any own sale, and says so now.
  const next = app(t, { guard: WORK_GUARD });
  assert.equal(await next.deliver(renewal('evt_w2', 'sub_02ada')), 'pending');
  assert.ok(next.logs.some((line) => line.includes(UNLISTED) && /waits/.test(line)));

  // Once the price is listed (oldPrices), the next renewal counts.
  const listed = { ...PRODUCTS, 'pro-yearly': { ...PRODUCTS['pro-yearly'], oldPrices: [UNLISTED] } };
  const fixed = app(t, { products: listed, guard: WORK_GUARD });
  const adaFixed = fixed.signIn(ADA, 'ada');
  assert.equal(await fixed.deliver(renewal('evt_w3', 'sub_01ada')), 'granted');
  assert.equal(fixed.planOf(adaFixed), 'pro');

  // Without paddleProductIds nothing tells it is Work's: strictPrices with ignoreUnknownProducts calls it foreign.
  const blind = app(t, { guard: { strictPrices: true, ignoreUnknownProducts: true } });
  blind.signIn(ADA, 'ada');
  assert.equal(await blind.deliver(renewal('evt_w4', 'sub_01ada')), 'foreign', 'which is why P5 sets all three');

  // What the provider says: `own`, and the price only when it found no product for it.
  const base = { apiKey: 'pdl_sdbx_apikey_test', webhookSecret: SECRET, environment: 'sandbox', products: PRODUCTS, strictPrices: true };
  const provider = paddleProvider({ ...base, paddleProductIds: [WORK_PRODUCT_ID] });
  assert.deepEqual([renewal('e1', 's1'), workSale('e2')].map((n) => provider.translate(n)).map((e) => [e.product, e.own, e.unknownPrice]),
    [[undefined, true, UNLISTED], ['pro-yearly', true, undefined]]);
  const plain = paddleProvider(base).translate(renewal('e3', 's3'));
  assert.equal('own' in plain || 'unknownPrice' in plain, false, 'without paddleProductIds, as before');
});

test('what waited in an install since before its guard was on is foreign when its person arrives, through Paddle', async (t) => {
  // Tracker before the guard: a Work sale for Ada, who never opened Tracker, waits with her WorkOS id.
  const before = app(t, { products: TRACKER_PRODUCTS });
  assert.equal(await before.deliver(workSale('evt_w1')), 'pending');
  assert.equal(count(before, 'billing_pending'), 1);
  // The same install restarted with the guard on: the same database, the new options.
  const after = app(t, { products: TRACKER_PRODUCTS, guard: TRACKER_GUARD, database: before.database });
  const ada = after.signIn(ADA, 'ada');
  assert.deepEqual(outcomes(after), [['evt_w1', 'subscription', 'foreign']]);
  for (const table of ['billing_customers', 'billing_subscriptions', 'billing_pending', 'entitlement_grants']) {
    assert.equal(count(after, table), 0, `nothing in ${table}`);
  }
  assert.equal(after.planOf(ada), 'free');
});

test('paddleProvider: a guard it can\'t keep is refused; an event it can\'t tell goes on to the price; another product\'s keeps no one', () => {
  const base = { apiKey: 'pdl_sdbx_apikey_test', webhookSecret: SECRET, environment: 'sandbox', products: PRODUCTS };
  assert.throws(() => paddleProvider({ ...base, paddleProductIds: [] }), /paddleProductIds/, 'an empty list would keep out its own sales');
  assert.throws(() => paddleProvider({ ...base, paddleProductIds: ['pro_short'] }), /paddleProductIds/);
  assert.throws(() => paddleProvider({ ...base, paddleProductIds: WORK_PRODUCT_ID }), /paddleProductIds/);
  assert.throws(() => paddleProvider({ ...base, strictPrices: 'yes' }), /strictPrices/);

  const provider = paddleProvider({ ...base, paddleProductIds: [WORK_PRODUCT_ID] });
  const unmarked = subscriptionEvent('evt_1', { occurredAt: START, endsAt: END });
  delete unmarked.data.items[0].price.product_id;
  assert.equal(provider.translate(unmarked).product, 'pro-yearly');
  assert.equal(provider.translate(unmarked).foreign, undefined);
  const other = provider.translate({
    event_id: 'evt_t', event_type: 'transaction.completed', occurred_at: START,
    data: {
      id: 'txn_1', subscription_id: null, customer_id: 'ctm_01ada',
      items: [{ price: { id: TRACKER_PRICES.monthly, product_id: TRACKER_PRODUCT_ID }, quantity: 1 }],
      custom_data: { workos_user_id: ADA, email: 'ada@example.com', product: 'tracker-pass' },
    },
  });
  assert.deepEqual(other, { id: 'evt_t', type: 'purchase', occurredAt: '2026-11-01T10:00:00.000Z', ref: 'txn_1', foreign: true });
  // Without the options an event reads as before: no app unless the checkout wrote one.
  assert.equal('app' in paddleProvider(base).translate(unmarked), false);
});

test('createSuite reads the guards from suite.config.js billing: its webhook answers foreign for another product\'s sales', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-paddle-suite-'));
  const suite = createSuite({
    config: {
      app: { id: 'demo', name: 'Demo', languages: ['en'] }, modules: { billing: true },
      plans: { free: { name: 'Free', features: {} }, pro: { name: 'Pro', features: {} } },
      products: { 'pro-yearly': PRODUCTS['pro-yearly'] },
      billing: { ignoreUnknownProducts: true, app: 'work', strictPrices: true, paddleProductIds: { sandbox: [WORK_PRODUCT_ID] } },
    },
    env: {
      DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1',
      BILLING_PROVIDER: 'paddle', PADDLE_API_KEY: 'pdl_sdbx_apikey_test', PADDLE_WEBHOOK_SECRET: SECRET, PADDLE_ENV: 'sandbox',
    },
    log: () => {}, exitOnError: false,
  });
  const server = createApp({ suite, version: '1.0.0', handleSignals: false, log: () => {} });
  const listening = await server.listen();
  t.after(async () => { await server.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const deliver = async (notification) => {
    const body = JSON.stringify(notification);
    const res = await fetch(`http://127.0.0.1:${listening.address().port}/api/billing/webhook`, {
      method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Paddle-Signature': signPaddlePayload(SECRET, body) },
    });
    return (await res.json()).outcomes;
  };
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 365 * DAY).toISOString();
  const sale = (id, { productId = WORK_PRODUCT_ID, price = PRICES.yearly, custom, sub }) => subscriptionEvent(id, {
    occurredAt: now, endsAt: later, productId, price, custom, sub,
  });
  const mine = { subject: 'user:1', product: 'pro-yearly', app: 'work' };
  assert.deepEqual(await deliver(sale('evt_1', { productId: TRACKER_PRODUCT_ID, custom: mine, sub: 'sub_1' })), ['foreign'], 'paddleProductIds');
  assert.deepEqual(await deliver(sale('evt_2', { custom: { ...mine, app: 'tracker' }, sub: 'sub_2' })), ['foreign'], 'app');
  // An item without its product id leaves it to the price.
  assert.deepEqual(await deliver(sale('evt_3', { productId: null, price: TRACKER_PRICES.monthly, custom: { subject: 'user:1', product: 'pro-yearly' }, sub: 'sub_3' })),
    ['foreign'], 'strictPrices with ignoreUnknownProducts');
  assert.deepEqual(await deliver(sale('evt_4', { custom: mine, sub: 'sub_4' })), ['granted'], 'its own sale');
  assert.deepEqual(await deliver(sale('evt_5', { price: TRACKER_PRICES.monthly, custom: mine, sub: 'sub_5' })), ['ignored'],
    'its own Paddle product on a price it doesn\'t list: a missing price, not another product\'s');
  assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM billing_customers').n, 1);
});

/* ----------------------------- environments ----------------------------- */

test('sandbox and live apart: moving an install to live finds none of the sandbox\'s customers or subscriptions', async (t) => {
  const sandbox = app(t);
  const ada = sandbox.signIn(ADA, 'ada');
  await sandbox.deliver(subscriptionEvent('evt_1', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z' }));
  assert.equal(sandbox.billing.provider, 'paddle-sandbox');
  assert.equal(sandbox.billing.customerOf({ type: 'user', id: ada.id }), 'ctm_01ada');

  // The same database, now with the live account.
  const paddle = fakePaddle();
  const live = paddleProvider({
    apiKey: 'pdl_live_apikey_test', webhookSecret: SECRET, environment: 'production', products: PRODUCTS, fetch: paddle.fetch,
  });
  assert.equal(live.id, 'paddle');
  assert.deepEqual([providerId('sandbox'), providerId('production')], ['paddle-sandbox', 'paddle']);
  const billing = createBilling({
    database: sandbox.database, entitlements: sandbox.entitlements, provider: live, products: PRODUCTS, log: () => {},
    identities: { of: () => ({ provider: 'workos', subject: ADA }), user: () => ada.id },
  });
  assert.equal(billing.customerOf({ type: 'user', id: ada.id }), null, 'no sandbox customer for the live API');
  await billing.checkoutUrl({ type: 'user', id: ada.id }, 'pro-yearly', { email: 'ada@example.com', user: ada, returnUrl: 'x' });
  assert.equal(paddle.calls.at(-1).body.customer_id, 'ctm_new0', 'a live customer, found or made by email');
});

test('migration 19: what Paddle wrote before 0.48.0 was the sandbox\'s', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-paddle-env-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  migrate(database, SUITE_MIGRATIONS.filter((m) => m.version <= 18), { scope: 'suite', log: () => {} });
  const at = '2026-10-08T13:22:24.000Z';
  database.run(`INSERT INTO billing_customers (subject_type, subject_id, provider, customer_id, created_at)
    VALUES ('user', 1, 'paddle', 'ctm_old', ?), ('user', 2, 'stripe', 'cus_1', ?)`, at, at);
  database.run(`INSERT INTO billing_subscriptions (provider, ref, subject_type, subject_id, product, status, occurred_at, updated_at)
    VALUES ('paddle', 'sub_old', 'user', 1, 'pro-yearly', 'canceled', ?, ?)`, at, at);
  database.run("INSERT INTO billing_events (provider, event_id, type, outcome, received_at) VALUES ('paddle', 'evt_old', 'subscription', 'granted', ?)", at);
  database.run(`INSERT INTO entitlement_grants (subject_type, subject_id, plan, source, external_ref, starts_at, created_at)
    VALUES ('user', 1, 'pro', 'paddle', 'sub_old', ?, ?)`, at, at);
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  assert.deepEqual(database.all('SELECT provider FROM billing_customers ORDER BY subject_id').map((r) => r.provider), ['paddle-sandbox', 'stripe']);
  assert.equal(database.get('SELECT provider FROM billing_subscriptions').provider, 'paddle-sandbox');
  assert.equal(database.get('SELECT provider FROM billing_events').provider, 'paddle-sandbox');
  assert.equal(database.get('SELECT source FROM entitlement_grants').source, 'paddle-sandbox');
});

/* ---------------------------- configuration ---------------------------- */

test('the configuration: BILLING_PROVIDER=paddle, its key, its secret, its environment and prices per environment', () => {
  const product = {
    app: { id: 'demo', name: 'Demo', languages: ['en'] }, modules: { billing: true },
    products: {
      'pro-yearly': {
        plan: 'pro', kind: 'subscription',
        price: { sandbox: PRICES.yearly, production: 'pri_01m492bw9r8hfy34wzxkkcgz48' },
        founderPrice: { sandbox: PRICES.founder, production: 'pri_01m492bwfzycb0r0b5nm68qbgv' },
      },
    },
  };
  const env = (extra) => ({
    DATA_DIR: os.tmpdir(), BILLING_PROVIDER: 'paddle', PADDLE_API_KEY: 'pdl_sdbx_apikey_abc', PADDLE_WEBHOOK_SECRET: SECRET,
    PADDLE_ENV: 'sandbox', ...extra,
  });
  const errorsOf = (extra) => resolveConfig(product, env(extra)).errors;
  assert.ok(errorsOf({ PADDLE_API_KEY: '' }).some((e) => /needs PADDLE_API_KEY/.test(e)));
  assert.ok(errorsOf({ PADDLE_ENV: 'staging' }).some((e) => /PADDLE_ENV "staging"/.test(e)));
  assert.ok(errorsOf({ PADDLE_API_KEY: 'sk_test_1' }).some((e) => /must be a Paddle API key/.test(e)));
  assert.ok(errorsOf({ PADDLE_ENV: 'production' }).some((e) => /sandbox key but PADDLE_ENV is production/.test(e)));
  assert.ok(errorsOf({ PADDLE_WEBHOOK_SECRET: 'whsec_1' }).some((e) => /PADDLE_WEBHOOK_SECRET/.test(e)));
  assert.ok(errorsOf({ PADDLE_CHECKOUT_URL: 'http://example.com/pay/' }).some((e) => /PADDLE_CHECKOUT_URL/.test(e)));
  assert.deepEqual(errorsOf({ PADDLE_CHECKOUT_URL: 'http://localhost:8096/' }), [], 'a local page, only in the sandbox');
  assert.ok(errorsOf({ EARLY_ACCESS_UNTIL: 'soon' }).some((e) => /EARLY_ACCESS_UNTIL/.test(e)));

  const sandbox = resolveConfig(product, env({ PADDLE_CHECKOUT_URL: 'https://cronumstudio.com/pay/', EARLY_ACCESS_UNTIL: '2026-12-01' }));
  assert.deepEqual(sandbox.errors, []);
  assert.equal(sandbox.install.billing.provider, 'paddle');
  assert.equal(sandbox.install.billing.apiBase, 'https://sandbox-api.paddle.com');
  assert.equal(sandbox.install.billing.earlyAccessUntil, '2026-12-01T00:00:00.000Z');
  assert.equal(sandbox.products['pro-yearly'].price, PRICES.yearly, 'the sandbox\'s price');
  assert.equal(sandbox.products['pro-yearly'].founderPrice, PRICES.founder);

  const live = resolveConfig(product, env({ PADDLE_API_KEY: 'pdl_live_apikey_abc', PADDLE_ENV: 'production' }));
  assert.deepEqual(live.errors, []);
  assert.equal(live.install.billing.apiBase, 'https://api.paddle.com');
  assert.equal(live.products['pro-yearly'].price, 'pri_01m492bw9r8hfy34wzxkkcgz48', 'the live account\'s price');

  const typo = { ...product, products: { 'pro-yearly': { plan: 'pro', kind: 'subscription', price: { sandbox: 'pri_short', live: 'pri_x' } } } };
  const wrong = resolveConfig(typo, env({}));
  assert.ok(wrong.errors.some((e) => /"live" is not sandbox or production/.test(e)));
  assert.ok(wrong.errors.some((e) => /"pri_short" is not a Paddle price id/.test(e)));
  assert.equal(resolveConfig(product, { DATA_DIR: os.tmpdir() }).products['pro-yearly'].price, 'pri_01m492bw9r8hfy34wzxkkcgz48',
    'billing off: the live price, unused');
});

test('the configuration: billing\'s guards in suite.config.js, all off by default, checked on start', () => {
  const product = (billing, products = { 'pro-yearly': { plan: 'pro', kind: 'subscription', price: PRICES.yearly } }) => ({
    app: { id: 'demo', name: 'Demo', languages: ['en'] }, modules: { billing: true }, products, ...(billing ? { billing } : {}),
  });
  const paddle = (extra) => ({
    DATA_DIR: os.tmpdir(), BILLING_PROVIDER: 'paddle', PADDLE_API_KEY: 'pdl_sdbx_apikey_abc', PADDLE_WEBHOOK_SECRET: SECRET,
    PADDLE_ENV: 'sandbox', ...extra,
  });
  const live = { PADDLE_API_KEY: 'pdl_live_apikey_abc', PADDLE_ENV: 'production' };
  const off = { ignoreUnknownProducts: false, app: null, strictPrices: false, paddleProductIds: null };
  assert.deepEqual(resolveConfig(product(null), paddle({})).billing, off, 'nothing changes for an app that says nothing');
  assert.deepEqual(resolveConfig(product({}), paddle({})).billing, off);

  const LIVE_WORK_PRODUCT_ID = 'pro_01m492bwworkprodct00000001';
  const guarded = product({ ignoreUnknownProducts: true, app: 'work', strictPrices: true,
    paddleProductIds: { sandbox: [WORK_PRODUCT_ID], production: [LIVE_WORK_PRODUCT_ID] } });
  const sandbox = resolveConfig(guarded, paddle({}));
  assert.deepEqual(sandbox.errors, []);
  assert.deepEqual(sandbox.billing, { ignoreUnknownProducts: true, app: 'work', strictPrices: true, paddleProductIds: [WORK_PRODUCT_ID] });
  assert.deepEqual(resolveConfig(guarded, paddle(live)).billing.paddleProductIds, [LIVE_WORK_PRODUCT_ID], 'the live account\'s');
  // One list for both would be right in one environment only: Paddle's product ids differ between them.
  const flat = resolveConfig(product({ paddleProductIds: [WORK_PRODUCT_ID] }), paddle({}));
  assert.ok(flat.errors.some((e) => /billing\.paddleProductIds: one list per environment/.test(e)), 'a flat list stops the start with Paddle');
  assert.equal(flat.billing.paddleProductIds, null);

  const errorsOf = (billing, env = paddle({})) => resolveConfig(product(billing), env).errors;
  assert.ok(errorsOf({ ignoreUnknownProduct: true }).some((e) => /billing\.ignoreUnknownProduct is not a setting/.test(e)), 'a typo stops the start');
  assert.ok(errorsOf({ ignoreUnknownProducts: 'yes' }).some((e) => /billing\.ignoreUnknownProducts must be true or false/.test(e)));
  assert.ok(errorsOf({ strictPrices: 1 }).some((e) => /billing\.strictPrices must be true or false/.test(e)));
  assert.ok(errorsOf({ app: 'Cronum Work' }).some((e) => /billing\.app/.test(e)));
  assert.ok(errorsOf({ paddleProductIds: ['pro_short'] }).some((e) => /billing\.paddleProductIds: one list per environment/.test(e)));
  assert.ok(errorsOf({ paddleProductIds: { live: [WORK_PRODUCT_ID] } }).some((e) => /"live" is not sandbox or production/.test(e)));
  assert.ok(errorsOf({ paddleProductIds: { production: [LIVE_WORK_PRODUCT_ID] } }).some((e) => /none for PADDLE_ENV sandbox/.test(e)),
    'a guard asked for and left without products would let every sale in');
  assert.ok(errorsOf({ paddleProductIds: { sandbox: [] } }).some((e) => /none for PADDLE_ENV sandbox/.test(e)));
  assert.ok(errorsOf({ paddleProductIds: { sandbox: ['pro_short'] } }).some((e) => /a list of Paddle product ids/.test(e)));
  assert.ok(errorsOf('on').some((e) => /^billing: an object/.test(e)));
  const stripeEnv = { DATA_DIR: os.tmpdir(), BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: 'whsec_1' };
  const stripe = resolveConfig(product({ strictPrices: true }), stripeEnv);
  assert.deepEqual(stripe.errors, []);
  assert.ok(stripe.warnings.some((w) => /^billing\.strictPrices is Paddle's: with BILLING_PROVIDER=stripe it does nothing/.test(w)));
  const stripeAll = resolveConfig(product({ ignoreUnknownProducts: true, app: 'work', paddleProductIds: [WORK_PRODUCT_ID] }), stripeEnv);
  assert.deepEqual(stripeAll.errors, [], 'a flat list is only refused where Paddle reads it');
  assert.ok(stripeAll.warnings.some((w) => /^billing\.app, billing\.paddleProductIds are Paddle's: with BILLING_PROVIDER=stripe they do nothing/.test(w)),
    'the app too: only Paddle\'s checkout writes it');
  assert.ok(!stripeAll.warnings.some((w) => /ignoreUnknownProducts/.test(w)), 'ignoreUnknownProducts works with any provider');
  assert.deepEqual(resolveConfig(product({ paddleProductIds: { sandbox: [WORK_PRODUCT_ID] } }), { DATA_DIR: os.tmpdir() }).errors, [],
    'billing off: nothing to check against');

  // Old prices, a list or one per environment like the rest, checked as Paddle's.
  const oldPrices = (value) => product(null, { 'pro-yearly': { plan: 'pro', kind: 'subscription', price: PRICES.yearly, oldPrices: value } });
  assert.deepEqual(resolveConfig(oldPrices({ sandbox: [PRICES.monthly], production: [] }), paddle({})).products['pro-yearly'].oldPrices, [PRICES.monthly]);
  assert.deepEqual(resolveConfig(oldPrices({ sandbox: [PRICES.monthly] }), paddle(live)).products['pro-yearly'].oldPrices, []);
  assert.deepEqual(resolveConfig(oldPrices([PRICES.monthly]), paddle({})).errors, []);
  assert.ok(resolveConfig(oldPrices(['pri_x']), paddle({})).errors.some((e) => /oldPrices: "pri_x" is not a Paddle price id/.test(e)));
  assert.ok(resolveConfig(oldPrices('pri_x'), paddle({})).errors.some((e) => /oldPrices: a list/.test(e)));
});
