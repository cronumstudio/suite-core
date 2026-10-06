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
import { paddleProvider, verifyPaddleSignature, signPaddlePayload } from '../paddle.js';

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
    }
    return { ok: Boolean(data), status: data ? 200 : 404, json: async () => ({ data }) };
  };
  return { calls, fetch };
}

/** One app of the suite: its own database, accounts, plans and Paddle webhook. */
function app(t, { now = '2026-11-01T10:00:00Z', paddle = fakePaddle(), founderUntil = null, clock = null, checkoutUrl = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-paddle-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const time = clock || { now: Date.parse(now) };
  const accounts = createAccounts({ database, clock: () => time.now });
  const entitlements = createEntitlements({
    database, appId: 'test', clock: () => time.now,
    features: { assign: { type: 'flag', default: true } },
    plans: { gratis: { name: 'Free', features: { assign: false } }, pro: { name: 'Pro', features: {} } },
    plansJson: null, defaultPlanOverride: null, organizationsOf: () => [],
  });
  const logs = [];
  const provider = paddleProvider({
    apiKey: 'pdl_sdbx_apikey_test', webhookSecret: SECRET, environment: 'sandbox', checkoutUrl, products: PRODUCTS,
    fetch: paddle.fetch, clock: () => time.now, log: (line) => logs.push(line),
  });
  const identities = {
    of: (userId) => {
      const subject = accounts.identitiesOf(userId).find((i) => i.provider === 'workos')?.subject;
      return subject ? { provider: 'workos', subject } : null;
    },
    user: (provider, subject) => accounts.byIdentity(provider, subject)?.id ?? null,
  };
  const billing = createBilling({
    database, entitlements, provider, products: PRODUCTS, identities, clock: () => time.now, log: (line) => logs.push(line),
    isFounder: (user) => Boolean(founderUntil) && Date.parse(user.created_at) < Date.parse(founderUntil),
  });
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

/** A subscription.* notification, shaped like Paddle's. */
function subscriptionEvent(id, {
  type = 'subscription.created', occurredAt, status = 'active', price = PRICES.yearly, endsAt,
  workosId = ADA, sub = 'sub_01ada', customer = 'ctm_01ada', scheduled = null,
}) {
  return {
    event_id: id, event_type: type, occurred_at: occurredAt, notification_id: `ntf_${id}`,
    data: {
      id: sub, status, customer_id: customer, address_id: 'add_01', currency_code: 'EUR',
      items: [{ status: 'active', quantity: 1, recurring: true, price: { id: price, product_id: 'pro_01' } }],
      current_billing_period: endsAt ? { starts_at: occurredAt, ends_at: endsAt } : null,
      scheduled_change: scheduled,
      custom_data: { workos_user_id: workosId, email: 'ada@example.com', product: 'pro-yearly' },
    },
  };
}

const refundEvent = (id, { type = 'adjustment.updated', occurredAt, status = 'approved', kind = 'full', action = 'refund' }) => ({
  event_id: id, event_type: type, occurred_at: occurredAt,
  data: {
    id: 'adj_01', action, type: kind, status, transaction_id: 'txn_01ada', subscription_id: 'sub_01ada',
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
  assert.equal(planOf(ada), 'gratis');
  assert.equal(await deliver(subscriptionEvent('evt_1', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z' })), 'granted');
  assert.equal(planOf(ada), 'pro');
  assert.equal(await deliver(subscriptionEvent('evt_1', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z' })), 'duplicate');
  // The renewal: a new period.
  clock.now = Date.parse('2027-11-01T10:00:05Z');
  assert.equal(await deliver(subscriptionEvent('evt_2', {
    type: 'subscription.updated', occurredAt: '2027-11-01T10:00:01Z', endsAt: '2028-11-01T10:00:00Z',
  })), 'extended');
  const grant = database.get("SELECT * FROM entitlement_grants WHERE source = 'paddle'");
  assert.equal(grant.ends_at, new Date(Date.parse('2028-11-01T10:00:00Z') + 3 * DAY).toISOString(), 'the paid period and three days of grace');
  // Cancelled in the portal: active until the period ends.
  assert.equal(await deliver(subscriptionEvent('evt_3', {
    type: 'subscription.updated', occurredAt: '2027-12-01T10:00:00Z', endsAt: '2028-11-01T10:00:00Z',
    scheduled: { action: 'cancel', effective_at: '2028-11-01T10:00:00Z' },
  })), 'extended');
  assert.equal(planOf(ada), 'pro');
  assert.equal(await deliver(subscriptionEvent('evt_4', { type: 'subscription.canceled', status: 'canceled', occurredAt: '2028-11-01T10:00:01Z' })), 'revoked');
  assert.equal(planOf(ada), 'gratis');
  // An older update arriving late doesn't bring it back.
  assert.equal(await deliver(subscriptionEvent('evt_late', {
    type: 'subscription.updated', occurredAt: '2027-12-02T10:00:00Z', endsAt: '2028-11-01T10:00:00Z',
  })), 'stale');
  assert.equal(planOf(ada), 'gratis');
});

test('paused is not paid for; resumed, Pro again; a founder\'s price is still Pro', async (t) => {
  const { deliver, signIn, planOf } = app(t);
  const ada = signIn(ADA, 'ada');
  await deliver(subscriptionEvent('evt_1', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z', price: PRICES.founder }));
  assert.equal(planOf(ada), 'pro');
  assert.equal(await deliver(subscriptionEvent('evt_2', { type: 'subscription.paused', status: 'paused', occurredAt: '2026-12-01T10:00:00Z' })), 'revoked');
  assert.equal(planOf(ada), 'gratis');
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
  assert.equal(planOf(ada), 'gratis');
  // Paddle may still say the subscription is active for that period (the refund doesn't cancel it).
  assert.equal(await deliver(subscriptionEvent('evt_2', {
    type: 'subscription.updated', occurredAt: '2026-11-05T10:00:01Z', endsAt: '2027-11-01T10:00:00Z',
  })), 'refunded');
  assert.equal(planOf(ada), 'gratis');
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
  assert.equal(planOf(ada), 'gratis');
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
  assert.equal(planOf(ada), 'gratis');
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
  assert.equal(next.planOf(bea), 'gratis', 'not to whoever has her id in Tasks');
  // A renewal while she still hasn't: it waits too, in order.
  const renewed = subscriptionEvent('evt_2', { type: 'subscription.updated', occurredAt: '2027-11-01T10:00:01Z', endsAt: '2028-11-01T10:00:00Z' });
  assert.equal(await next.deliver(renewed), 'pending');
  assert.equal(await tasks.deliver(renewed), 'extended');

  const adaInNext = next.signIn(ADA, 'ada');
  assert.equal(next.planOf(adaInNext), 'pro', 'Pro at her first sign-in');
  const grant = next.database.get("SELECT * FROM entitlement_grants WHERE source = 'paddle' AND revoked_at IS NULL");
  assert.equal(grant.subject_id, adaInNext.id);
  assert.equal(grant.ends_at, new Date(Date.parse('2028-11-01T10:00:00Z') + 3 * DAY).toISOString(), 'with the latest period');
  assert.equal(next.database.get('SELECT COUNT(*) AS n FROM billing_pending').n, 0);
  assert.equal(next.database.get("SELECT outcome FROM billing_events WHERE event_id = 'evt_1'").outcome, 'granted');
  assert.equal(next.billing.customerOf({ type: 'user', id: adaInNext.id }), 'ctm_01ada', 'and her portal');
  // Cancelling reaches both.
  const ended = subscriptionEvent('evt_3', { type: 'subscription.canceled', status: 'canceled', occurredAt: '2028-11-01T10:00:01Z' });
  assert.equal(await tasks.deliver(ended), 'revoked');
  assert.equal(await next.deliver(ended), 'revoked');
  assert.equal(tasks.planOf(adaInTasks), 'gratis');
  assert.equal(next.planOf(adaInNext), 'gratis');
});

test('a refund of what is still waiting waits with it: at the first sign-in, nothing is given', async (t) => {
  const next = app(t);
  await next.deliver(subscriptionEvent('evt_1', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z' }));
  assert.equal(await next.deliver(refundEvent('evt_r', { occurredAt: '2026-11-03T10:00:00Z' })), 'pending');
  const ada = next.signIn(ADA, 'ada');
  assert.equal(next.planOf(ada), 'gratis');
  assert.equal(next.database.get("SELECT outcome FROM billing_events WHERE event_id = 'evt_r'").outcome, 'revoked');
});

test('the identity outranks an older link: a customer linked to someone else here moves to whom WorkOS says', async (t) => {
  const tasks = app(t);
  const other = tasks.accounts.create({ username: 'carl' });
  tasks.billing.linkCustomer({ type: 'user', id: other.id }, 'ctm_01ada');
  const ada = tasks.signIn(ADA, 'ada');
  assert.equal(await tasks.deliver(subscriptionEvent('evt_1', { occurredAt: '2026-11-01T10:00:00Z', endsAt: '2027-11-01T10:00:00Z' })), 'granted');
  assert.equal(tasks.planOf(ada), 'pro');
  assert.equal(tasks.planOf(other), 'gratis');
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
