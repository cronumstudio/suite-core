/**
 * Stripe as billing's provider: what goes to its API for Checkout and the
 * portal, its webhook signature, and its events turned into grants — with a
 * stand-in for the API (no network) and events signed as Stripe signs them.
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
import { stripeProvider, verifyStripeSignature, signStripePayload } from '../stripe.js';

const DAY = 24 * 3600 * 1000;
const WEBHOOK_SECRET = 'whsec_test_signing_secret_of_the_endpoint';
const PRODUCTS = {
  'pro-monthly': { plan: 'pro', kind: 'subscription', price: 'price_pro_m' },
  'pro-yearly': { plan: 'pro', kind: 'subscription', price: 'price_pro_y' },
  'pro-lifetime': { plan: 'pro', kind: 'once', price: 'price_pro_life' },
};

/** A stand-in for Stripe's API: records each call and answers with a hosted page's URL. */
function fakeStripe({ status = 200, answer = null } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, form: new URLSearchParams(init.body) });
    const data = answer ?? { id: 'cs_test_1', url: `https://checkout.stripe.test/${calls.length}` };
    return { ok: status < 300, status, json: async () => data };
  };
  return { calls, fetch };
}

function setup(t, { now = '2026-05-01T10:00:00Z', stripe = fakeStripe(), products = PRODUCTS } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-stripe-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const clock = { now: Date.parse(now) };
  const accounts = createAccounts({ database });
  const entitlements = createEntitlements({
    database, appId: 'test', clock: () => clock.now,
    features: { sharing: { type: 'flag', default: true } },
    plans: { free: { name: 'Free', features: { sharing: false } }, pro: { name: 'Pro', features: {} } },
    plansJson: null, defaultPlanOverride: null, organizationsOf: () => [],
  });
  const logs = [];
  const provider = stripeProvider({
    secretKey: 'sk_test_123', webhookSecret: WEBHOOK_SECRET, products, fetch: stripe.fetch,
    clock: () => clock.now, log: (line) => logs.push(line),
  });
  const billing = createBilling({ database, entitlements, provider, products, clock: () => clock.now, log: () => {} });
  const ada = accounts.create({ username: 'ada', email: 'ada@example.com' });
  /** An event as Stripe delivers it: signed, at the clock's time. */
  const deliver = async (event) => {
    const body = JSON.stringify({ created: Math.floor(clock.now / 1000), ...event });
    const parsed = await provider.parseWebhook({
      headers: { 'stripe-signature': signStripePayload(WEBHOOK_SECRET, body, clock.now) }, body,
    });
    return parsed ? billing.apply(parsed) : null;
  };
  const planOf = (user) => entitlements.of(user).plan.id;
  return { database, clock, accounts, entitlements, billing, provider, stripe, ada, deliver, planOf, logs };
}

test('the webhook signature: Stripe\'s scheme, several v1 while a secret rolls, five minutes', () => {
  const body = '{"id":"evt_1"}';
  const now = Date.parse('2026-05-01T10:00:00Z');
  const header = signStripePayload(WEBHOOK_SECRET, body, now);
  assert.equal(verifyStripeSignature(WEBHOOK_SECRET, body, header, { now }), true);
  assert.equal(verifyStripeSignature('whsec_other', body, header, { now }), false, 'another secret');
  assert.equal(verifyStripeSignature(WEBHOOK_SECRET, `${body} `, header, { now }), false, 'another body');
  assert.equal(verifyStripeSignature(WEBHOOK_SECRET, body, header, { now: now + 6 * 60 * 1000 }), false, 'replayed later');
  const rolled = `${header.replace(/v1=[0-9a-f]+/, `v1=${'0'.repeat(64)}`)},${header.split(',')[1]}`;
  assert.equal(verifyStripeSignature(WEBHOOK_SECRET, body, rolled, { now }), true, 'one good v1 among several');
  assert.equal(verifyStripeSignature(WEBHOOK_SECRET, body, `t=${Math.floor(now / 1000)}`, { now }), false, 'no v1');
  assert.equal(verifyStripeSignature(WEBHOOK_SECRET, body, undefined, { now }), false);
});

test('Checkout: a subscription or a payment, saying who pays and for what', async (t) => {
  const { billing, stripe, ada, logs } = setup(t);
  const url = await billing.checkoutUrl({ type: 'user', id: ada.id }, 'pro-monthly',
    { email: 'ada@example.com', returnUrl: 'https://app.example/?billing=done' });
  assert.equal(url, 'https://checkout.stripe.test/1');
  const [call] = stripe.calls;
  assert.equal(call.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(call.headers.Authorization, 'Bearer sk_test_123');
  const f = Object.fromEntries(call.form);
  assert.equal(f.mode, 'subscription');
  assert.equal(f['line_items[0][price]'], 'price_pro_m');
  assert.equal(f['line_items[0][quantity]'], '1');
  assert.equal(f.client_reference_id, `user:${ada.id}`);
  assert.equal(f['metadata[subject]'], `user:${ada.id}`);
  assert.equal(f['subscription_data[metadata][product]'], 'pro-monthly');
  assert.equal(f.customer_email, 'ada@example.com');
  assert.equal(f.cancel_url, 'https://app.example/?billing=canceled');

  await billing.checkoutUrl({ type: 'user', id: ada.id }, 'pro-lifetime', { returnUrl: 'https://app.example/?billing=done' });
  const once = Object.fromEntries(stripe.calls[1].form);
  assert.equal(once.mode, 'payment');
  assert.equal(once['payment_intent_data[metadata][product]'], 'pro-lifetime');
  assert.equal(once.customer_creation, 'always', 'a customer for the portal and refunds');
  assert.equal(once.customer_email, undefined, 'no email, none sent');

  billing.linkCustomer({ type: 'user', id: ada.id }, 'cus_ada');
  await billing.checkoutUrl({ type: 'user', id: ada.id }, 'pro-lifetime', { returnUrl: 'https://app.example/?billing=done' });
  const known = Object.fromEntries(stripe.calls[2].form);
  assert.equal(known.customer, 'cus_ada');
  assert.equal(known.customer_creation, undefined);

  const portal = await billing.portalUrl({ type: 'user', id: ada.id }, { returnUrl: 'https://app.example/' });
  assert.equal(portal, 'https://checkout.stripe.test/4');
  assert.equal(stripe.calls[3].url, 'https://api.stripe.com/v1/billing_portal/sessions');
  assert.deepEqual(Object.fromEntries(stripe.calls[3].form), { customer: 'cus_ada', return_url: 'https://app.example/' });
  assert.equal(logs.length, 0);
});

test('Checkout: what Stripe refuses goes to the log, not to the person paying', async (t) => {
  const stripe = fakeStripe({ status: 400, answer: { error: { message: 'No such price: price_pro_m' } } });
  const { billing, ada, logs } = setup(t, { stripe });
  await assert.rejects(billing.checkoutUrl({ type: 'user', id: ada.id }, 'pro-monthly', { returnUrl: 'https://app.example/' }),
    (err) => err.status === 502 && err.code === 'billing_provider_error');
  assert.match(logs[0], /400 No such price/);
});

test('every product needs its Stripe price', (t) => {
  const { billing } = setup(t, { products: { ...PRODUCTS, 'pro-pass': { plan: 'pro', kind: 'once', days: 30 } } });
  assert.equal(billing.enabled, false);
  assert.ok(billing.errors.some((e) => /"pro-pass": stripe needs its price/.test(e)), billing.errors.join('; '));
});

test('a subscription: granted, renewed, a late event ignored, changed in the portal, cancelled', async (t) => {
  const { clock, ada, deliver, planOf, billing } = setup(t);
  const subject = `user:${ada.id}`;
  const subscription = (status, periodEnd, extra = {}) => ({
    object: 'subscription', id: 'sub_1', customer: 'cus_ada', status,
    metadata: { subject, product: 'pro-monthly' },
    items: { data: [{ price: { id: 'price_pro_m' }, quantity: 1, current_period_end: Math.floor(periodEnd / 1000) }] },
    ...extra,
  });
  const start = clock.now;
  assert.equal(planOf(ada), 'free');
  assert.equal(await deliver({ id: 'evt_1', type: 'customer.subscription.created', data: { object: subscription('active', start + 30 * DAY) } }), 'granted');
  assert.equal(planOf(ada), 'pro');
  assert.equal(billing.customerOf({ type: 'user', id: ada.id }), 'cus_ada', 'the customer is linked for the portal');
  assert.equal(await deliver({ id: 'evt_1', type: 'customer.subscription.created', data: { object: subscription('active', start + 30 * DAY) } }), 'duplicate');

  clock.now = start + 30 * DAY;
  const renewal = subscription('active', start + 60 * DAY);
  assert.equal(await deliver({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: renewal } }), 'extended');
  clock.now = start + 20 * DAY;
  assert.equal(await deliver({ id: 'evt_0', type: 'customer.subscription.updated', data: { object: subscription('past_due', start + 30 * DAY) } }),
    'stale', 'an older event never undoes a newer one');

  // Changed to yearly in the portal: the metadata still say monthly, the price says yearly.
  clock.now = start + 31 * DAY;
  const yearly = subscription('active', start + 400 * DAY, {
    items: { data: [{ price: { id: 'price_pro_y' }, quantity: 1, current_period_end: Math.floor((start + 400 * DAY) / 1000) }] },
  });
  // The same plan: the grant only moves its end; the subscription now says yearly.
  assert.equal(await deliver({ id: 'evt_3', type: 'customer.subscription.updated', data: { object: yearly } }), 'extended');
  assert.equal(billing.subscriptionsOf({ type: 'user', id: ada.id })[0].product, 'pro-yearly');

  // Older API versions keep the period end on the subscription itself.
  clock.now = start + 32 * DAY;
  const older = subscription('active', 0, { items: { data: [{ price: { id: 'price_pro_y' }, quantity: 1 }] },
    current_period_end: Math.floor((start + 401 * DAY) / 1000) });
  assert.equal(await deliver({ id: 'evt_4', type: 'customer.subscription.updated', data: { object: older } }), 'extended');

  clock.now = start + 33 * DAY;
  assert.equal(await deliver({ id: 'evt_5', type: 'customer.subscription.deleted', data: { object: subscription('canceled', start + 401 * DAY) } }), 'revoked');
  assert.equal(planOf(ada), 'free');
});

test('a one-off purchase, a partial refund that changes nothing and a full one that does', async (t) => {
  const { ada, deliver, planOf } = setup(t);
  const session = (extra = {}) => ({
    object: 'checkout.session', id: 'cs_1', mode: 'payment', payment_status: 'paid', customer: 'cus_ada',
    payment_intent: 'pi_1', client_reference_id: `user:${ada.id}`, metadata: { subject: `user:${ada.id}`, product: 'pro-lifetime' },
    ...extra,
  });
  assert.equal(await deliver({ id: 'evt_u', type: 'checkout.session.completed', data: { object: session({ payment_status: 'unpaid' }) } }),
    null, 'a delayed payment method is not paid yet');
  assert.equal(await deliver({ id: 'evt_p', type: 'checkout.session.async_payment_succeeded', data: { object: session() } }), 'granted');
  assert.equal(planOf(ada), 'pro');
  assert.equal(await deliver({ id: 'evt_q', type: 'checkout.session.completed', data: { object: session() } }), 'duplicate',
    'the same payment told twice grants once');
  assert.equal(await deliver({ id: 'evt_r1', type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: 'pi_1', refunded: false, amount_refunded: 100 } } }), null);
  assert.equal(planOf(ada), 'pro');
  assert.equal(await deliver({ id: 'evt_r2', type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: 'pi_1', refunded: true } } }), 'revoked');
  assert.equal(planOf(ada), 'free');
});

test('what billing doesn\'t need is acknowledged and ignored; a bad signature is refused', async (t) => {
  const { provider, deliver } = setup(t);
  assert.equal(await deliver({ id: 'evt_i', type: 'invoice.paid', data: { object: { id: 'in_1' } } }), null);
  assert.equal(await deliver({ id: 'evt_s', type: 'checkout.session.completed',
    data: { object: { id: 'cs_2', mode: 'subscription', payment_status: 'paid', subscription: 'sub_2' } } }), null,
  'a subscription\'s checkout is followed by its own events');
  const body = '{"id":"evt_x","type":"customer.subscription.created"}';
  await assert.rejects(provider.parseWebhook({ headers: { 'stripe-signature': signStripePayload('whsec_wrong', body) }, body }),
    (err) => err.status === 400 && err.code === 'bad_signature');
  await assert.rejects(provider.parseWebhook({ headers: {}, body }), (err) => err.code === 'bad_signature');
});

test('the configuration: BILLING_PROVIDER=stripe with its two secrets, checked on start', () => {
  const product = { app: { id: 'demo', name: 'Demo', languages: ['en'] }, modules: { billing: true } };
  const env = (extra) => ({ DATA_DIR: os.tmpdir(), BILLING_PROVIDER: 'stripe', ...extra });
  assert.ok(resolveConfig(product, env({})).errors.some((e) => /needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET/.test(e)));
  assert.ok(resolveConfig(product, env({ STRIPE_SECRET_KEY: 'pk_test_1', STRIPE_WEBHOOK_SECRET: 'whsec_1' })).errors
    .some((e) => /STRIPE_SECRET_KEY must be a Stripe secret key/.test(e)), 'a publishable key is not a secret one');
  assert.ok(resolveConfig(product, env({ STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: 'secret' })).errors
    .some((e) => /STRIPE_WEBHOOK_SECRET/.test(e)));
  const ok = resolveConfig(product, env({ STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: 'whsec_1', BASE_URL: 'https://demo.example' }));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.install.billing.provider, 'stripe');
  assert.equal(ok.install.billing.apiBase, 'https://api.stripe.com');
  const live = resolveConfig(product, env({ STRIPE_SECRET_KEY: 'sk_live_1', STRIPE_WEBHOOK_SECRET: 'whsec_1', BASE_URL: 'http://localhost:3000' }));
  assert.ok(live.warnings.some((w) => /live key but BASE_URL is not https/.test(w)));
  assert.ok(resolveConfig(product, env({ BILLING_PROVIDER: 'paypal' })).errors.some((e) => /use stripe or remote/.test(e)));
});
