/**
 * RevenueCat as the store purchase adapter: its webhook checked and read as a trigger, and a
 * customer read again from RevenueCat's API and turned into the suite's events. With a stand-in
 * for the API (no network); every secret is made at run time.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revenuecatProvider, STORE_MANAGE_URLS } from '../revenuecat.js';
import {
  AUTH, SIGNING, API_KEY, PRODUCTS, MONTHLY, fakeRevenueCat, subscription, webhook,
} from './fake-revenuecat.js';

const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function setup({ now = '2026-11-01T10:00:00Z', ...options } = {}) {
  const clock = { now: Date.parse(now) };
  const api = fakeRevenueCat(clock);
  const logs = [];
  const provider = revenuecatProvider({
    webhookAuth: AUTH, apiKey: API_KEY, products: PRODUCTS, fetch: api.fetch, clock: () => clock.now,
    log: (line) => logs.push(line), ...options,
  });
  return { clock, api, logs, provider };
}

const fails = async (promise) => {
  try { await promise; } catch (err) { return `${err.status} ${err.code}`; }
  return 'ok';
};

test('the webhook: the Authorization header set in RevenueCat, and with a signing secret its signature too', async () => {
  const { provider, clock } = setup();
  const sale = { type: 'INITIAL_PURCHASE', app_user_id: 'c-1', product_id: MONTHLY };
  assert.equal(await fails(provider.parseWebhook(webhook(sale, { auth: 'Bearer not-the-one-set-in-the-dashboard' }))), '401 unauthorized');
  assert.equal(await fails(provider.parseWebhook({ ...webhook(sale), headers: {} })), '401 unauthorized');
  const notice = await provider.parseWebhook(webhook(sale, { at: clock.now }));
  assert.equal(notice.type, 'INITIAL_PURCHASE');
  assert.equal(notice.occurredAt, iso(clock.now));
  assert.deepEqual(notice.customers, ['c-1']);
  assert.equal(notice.foreign, undefined);

  const signed = setup({ webhookSecret: SIGNING });
  assert.equal(await fails(signed.provider.parseWebhook(webhook(sale))), '400 bad_signature', 'unsigned, once a secret is set');
  assert.equal(await fails(signed.provider.parseWebhook(webhook(sale, { secret: 'another-signing-secret-entirely' }))), '400 bad_signature');
  assert.equal(await fails(signed.provider.parseWebhook(webhook(sale, { secret: SIGNING, at: signed.clock.now - 10 * 60 * 1000 }))),
    '400 bad_signature', 'an old delivery replayed');
  assert.deepEqual((await signed.provider.parseWebhook(webhook(sale, { secret: SIGNING, at: signed.clock.now }))).customers, ['c-1']);

  assert.equal(await fails(provider.parseWebhook({ body: '{not json', headers: { authorization: AUTH } })), '400 invalid_json');
  assert.equal(await fails(provider.parseWebhook({ body: '{"api_version":"1.0"}', headers: { authorization: AUTH } })), '400 invalid_event');
  assert.equal(await provider.parseWebhook(webhook({ type: 'TEST', app_user_id: 'c-1' })), null, 'a test from the dashboard');
  assert.equal(await provider.parseWebhook(webhook({ type: 'EXPERIMENT_ENROLLMENT', app_user_id: 'c-1' })), null);
  assert.equal(await provider.parseWebhook(webhook({ type: 'SUBSCRIBER_ALIAS', app_user_id: 'c-1' })), null);
  // The id names rows: only letters, digits, - _ and ., any other one by its digest, the same each time.
  const odd = { ...sale, id: 'note:refunded/app_store:x:0123456789abcdef' };
  const [first, again] = [await provider.parseWebhook(webhook(odd)), await provider.parseWebhook(webhook(odd))];
  assert.match(first.id, /^rc-[0-9a-f]{32}$/);
  assert.equal(again.id, first.id);
  assert.equal((await provider.parseWebhook(webhook({ ...sale, id: 'D3ADB33F-0000-4000-8000-000000000000' }))).id, 'D3ADB33F-0000-4000-8000-000000000000');
});

test('another product\'s sale is foreign and names nobody: another store, a product of another app, the sandbox when off', async () => {
  const { provider } = setup();
  const read = async (event, p = provider) => p.parseWebhook(webhook({ type: 'RENEWAL', app_user_id: 'c-1', ...event }));
  const other = await read({ id: 'evt-other', product_id: 'com.other.app.premium', event_timestamp_ms: Date.parse('2026-11-01T10:00:00Z') });
  assert.deepEqual(other, { id: 'evt-other', type: 'RENEWAL', occurredAt: '2026-11-01T10:00:00.000Z', sandbox: false, foreign: true, customers: [] });
  assert.equal((await read({ product_id: MONTHLY, store: 'STRIPE' })).foreign, true, 'the web, through RevenueCat: the web\'s own billing has it');
  assert.equal((await read({ product_id: MONTHLY, store: 'PADDLE' })).foreign, true);
  assert.equal((await read({ product_id: MONTHLY, store: 'PROMOTIONAL' })).foreign, true);
  assert.equal((await read({ product_id: 'app_pro', store: 'PLAY_STORE' })).foreign, undefined, 'Google\'s subscription without its base plan');
  assert.equal((await read({ product_id: 'app_pro:weekly', store: 'PLAY_STORE' })).foreign, undefined,
    'this app\'s subscription on a base plan it doesn\'t list: its own, said when it is read');
  assert.equal((await read({ product_id: MONTHLY, new_product_id: 'com.other.app.premium', type: 'PRODUCT_CHANGE' })).foreign, undefined);
  assert.equal((await read({ product_id: MONTHLY, environment: 'SANDBOX' })).foreign, undefined, 'test purchases count by default');
  assert.equal((await read({ product_id: MONTHLY, environment: 'SANDBOX' })).sandbox, true);
  const strict = setup({ sandbox: false }).provider;
  assert.equal((await read({ product_id: MONTHLY, environment: 'SANDBOX' }, strict)).foreign, true, 'REVENUECAT_SANDBOX=off');
  assert.equal((await read({ product_id: MONTHLY }, strict)).foreign, undefined);
});

test('the customers a webhook names: the buyer, its aliases and both sides of a transfer, never an anonymous id', async () => {
  const { provider } = setup();
  const transfer = await provider.parseWebhook(webhook({
    type: 'TRANSFER', store: undefined, app_user_id: 'c-new', original_app_user_id: 'c-new',
    aliases: ['$RCAnonymousID:0123abcd', 'c-new'], transferred_from: ['c-old', '$RCAnonymousID:4567'], transferred_to: ['c-new'],
  }));
  assert.deepEqual(transfer.customers, ['c-new', 'c-old']);
  assert.equal(transfer.foreign, undefined, 'a transfer names no product');
  const long = await provider.parseWebhook(webhook({ type: 'RENEWAL', app_user_id: 'x'.repeat(101), product_id: MONTHLY }));
  assert.deepEqual(long.customers, [], 'nothing this install could have given out');
});

test('a customer read again: active or trialing until the paid date, the store\'s grace, past due, paused or ended', async () => {
  const { provider, api, clock } = setup();
  const now = clock.now;
  const held = api.customer('c-1');
  held.subscriptions[MONTHLY] = subscription({ purchased: now - 10 * DAY, expires: now + 20 * DAY });
  held.subscriptions[PRODUCTS['pro-yearly'].appStore] = subscription({ purchased: now - 3 * DAY, expires: now + 4 * DAY, period_type: 'trial' });
  let read = await provider.customerEvents('c-1', { cause: 'evt-1' });
  assert.equal(read.at, iso(now));
  assert.deepEqual(read.events.map((e) => [e.type, e.product, e.status, e.periodEnd]), [
    ['subscription', 'pro-monthly', 'active', iso(now + 20 * DAY)],
    ['subscription', 'pro-yearly', 'trialing', iso(now + 4 * DAY)],
  ]);
  const [first] = read.events;
  assert.equal(first.customer, 'c-1');
  assert.equal(first.occurredAt, iso(now), 'when RevenueCat answered: a newer reading wins');
  assert.match(first.ref, /^app_store:com\.example\.app\.pro\.monthly:[0-9a-f]{16}$/);
  assert.equal(first.ref.includes('c-1'), false, 'the ref never carries the customer');
  assert.equal(first.id, `evt-1/${first.ref}`);
  assert.equal(read.present.has(first.ref), true);
  api.customer('c-2').subscriptions[MONTHLY] = subscription({ purchased: now, expires: now + DAY });
  const [theirs] = (await provider.customerEvents('c-2', { cause: 'evt-1' })).events;
  assert.notEqual(theirs.ref, first.ref, 'the same product is another subscription for another customer');

  // A charge failed: within the store's grace period it is still paid for; after it, past due.
  delete held.subscriptions[PRODUCTS['pro-yearly'].appStore];
  held.subscriptions[MONTHLY] = subscription({
    purchased: now - 31 * DAY, expires: now - DAY, billing_issues_detected_at: iso(now - DAY), grace_period_expires_date: iso(now + 15 * DAY),
  });
  read = await provider.customerEvents('c-1', { cause: 'evt-2' });
  assert.deepEqual(read.events.map((e) => [e.status, e.periodEnd]), [['active', iso(now + 15 * DAY)]]);
  held.subscriptions[MONTHLY].grace_period_expires_date = null;
  read = await provider.customerEvents('c-1', { cause: 'evt-3' });
  assert.deepEqual(read.events.map((e) => [e.status, e.periodEnd]), [['past_due', iso(now - DAY)]], 'the store still tries to charge');
  read = await provider.customerEvents('c-1', { cause: 'evt-4', hints: { [MONTHLY]: { type: 'ended', at: now } } });
  assert.deepEqual(read.events.map((e) => e.status), ['ended'], 'after EXPIRATION it has stopped trying');

  // Cancelled: paid until the end; then ended. Paused on Google Play: paused.
  held.subscriptions[MONTHLY] = subscription({ purchased: now - 40 * DAY, expires: now - 10 * DAY, unsubscribe_detected_at: iso(now - 20 * DAY) });
  assert.deepEqual((await provider.customerEvents('c-1', { cause: 'evt-5' })).events.map((e) => e.status), ['ended']);
  held.subscriptions.app_pro = subscription({
    store: 'play_store', purchased: now - 40 * DAY, expires: now - 10 * DAY, auto_resume_date: iso(now + 20 * DAY),
    product_plan_identifier: 'monthly',
  });
  assert.deepEqual((await provider.customerEvents('c-1', { cause: 'evt-6' })).events.map((e) => [e.ref.split(':')[0], e.status]),
    [['app_store', 'ended'], ['play_store', 'paused']]);
  assert.equal(api.calls.every((call) => call.method === 'GET' && call.headers.Authorization === `Bearer ${API_KEY}` && !('X-Platform' in call.headers)),
    true, 'the secret key, and never as if the person had opened the app');
});

test('refunds: refunded after the last purchase, or a support cancellation of that same transaction; and taken back', async () => {
  const { provider, api, clock } = setup();
  const now = clock.now;
  const held = api.customer('c-1');
  held.subscriptions[MONTHLY] = subscription({ purchased: now - 5 * DAY, expires: now + 25 * DAY, refunded_at: iso(now - DAY) });
  assert.deepEqual((await provider.customerEvents('c-1', { cause: 'e1' })).events.map((e) => [e.type, e.product]), [['refund', 'pro-monthly']]);

  // Bought again after the refund: that earlier refund is not this period's.
  held.subscriptions[MONTHLY] = subscription({ purchased: now - DAY, expires: now + 29 * DAY, refunded_at: iso(now - 3 * DAY) });
  assert.deepEqual((await provider.customerEvents('c-1', { cause: 'e2' })).events.map((e) => e.type), ['subscription']);

  // CANCELLATION by customer support names the transaction: a refund of the period it paid for.
  held.subscriptions[MONTHLY] = subscription({ purchased: now - 2 * DAY, expires: now + 28 * DAY, store_transaction_id: '2000000000000077' });
  const notice = await provider.parseWebhook(webhook({
    type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', app_user_id: 'c-1', product_id: MONTHLY, transaction_id: '2000000000000077',
  }));
  assert.equal(notice.hints[MONTHLY].type, 'refund');
  assert.deepEqual((await provider.customerEvents('c-1', { cause: 'e3', hints: notice.hints })).events.map((e) => e.type), ['refund']);
  const older = await provider.parseWebhook(webhook({
    type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', app_user_id: 'c-1', product_id: MONTHLY, transaction_id: '2000000000000001',
  }));
  assert.deepEqual((await provider.customerEvents('c-1', { cause: 'e4', hints: older.hints })).events.map((e) => e.type), ['subscription'],
    'a refund of an earlier transaction leaves the period paid now');
  const unsubscribe = await provider.parseWebhook(webhook({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', app_user_id: 'c-1', product_id: MONTHLY }));
  assert.deepEqual(unsubscribe.hints, {}, 'turning renewal off is no refund: paid until the end');

  // REFUND_REVERSED: the store took the refund back.
  held.subscriptions[MONTHLY] = subscription({ purchased: now - 2 * DAY, expires: now + 28 * DAY, refunded_at: iso(now - DAY) });
  const reversed = await provider.parseWebhook(webhook({ type: 'REFUND_REVERSED', app_user_id: 'c-1', product_id: MONTHLY }));
  const [event] = (await provider.customerEvents('c-1', { cause: 'e5', hints: reversed.hints })).events;
  assert.deepEqual([event.type, event.status, event.refundReversed], ['subscription', 'active', true]);
});

test('notes: what a later reading can\'t see again, given back by whoever keeps them, and never a customer', async () => {
  const { provider, api, clock } = setup();
  const now = clock.now;
  const held = api.customer('c-1');
  const kept = new Set();
  const read = async (cause, hints = null) => {
    const result = await provider.customerEvents('c-1', { cause, hints, noted: (note) => kept.has(note) });
    for (const note of result.notes) kept.add(note);
    return result;
  };
  const hint = async (event) => (await provider.parseWebhook(webhook({ app_user_id: 'c-1', ...event }))).hints;

  // A refund the store took back while RevenueCat still says refunded_at: noted once, then not a refund.
  held.subscriptions[MONTHLY] = subscription({ purchased: now - 2 * DAY, expires: now + 28 * DAY, refunded_at: iso(now - DAY) });
  let result = await read('e1', await hint({ type: 'REFUND_REVERSED', product_id: MONTHLY, transaction_id: '2000000000000001' }));
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /^refund-cleared\/app_store:com\.example\.app\.pro\.monthly:[0-9a-f]{16}@\d+$/);
  assert.equal(result.notes[0].includes('c-1'), false);
  result = await read('e2');
  assert.deepEqual([result.events.map((e) => [e.type, e.status]), result.notes], [[['subscription', 'active']], []]);
  assert.deepEqual((await provider.customerEvents('c-1', { cause: 'e3' })).events.map((e) => e.type), ['refund'], 'without the note: a refund');

  // A one-off: refunded by the transaction the webhook names, and so while it is still listed.
  held.subscriptions = {};
  held.non_subscriptions[PRODUCTS['pro-lifetime'].appStore] = [{
    id: 'abc123', purchase_date: iso(now - DAY), store: 'app_store', is_sandbox: false, store_transaction_id: '2000000000000404',
  }];
  const support = { type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', product_id: PRODUCTS['pro-lifetime'].appStore };
  assert.deepEqual((await read('e4', await hint({ ...support, transaction_id: '2000000000000405' }))).events.map((e) => e.type), ['purchase'],
    'another transaction');
  result = await read('e5', await hint({ ...support, transaction_id: '2000000000000404' }));
  assert.deepEqual([result.events.map((e) => e.type), result.notes.map((n) => n.split('/')[0])], [['refund'], ['refunded']]);
  assert.deepEqual((await read('e6')).events.map((e) => e.type), ['refund']);
  result = await read('e7', await hint({ type: 'REFUND_REVERSED', product_id: PRODUCTS['pro-lifetime'].appStore, transaction_id: '2000000000000404' }));
  assert.deepEqual([result.events.map((e) => e.type), result.notes.map((n) => n.split('/')[0])], [['purchase'], ['refund-reversed']]);
  assert.deepEqual((await read('e8')).events.map((e) => e.type), ['purchase']);
});

test('Google Play: the base plan names the product; one on a base plan no product lists is said in the log and grants nothing', async () => {
  const { provider, api, clock, logs } = setup();
  const now = clock.now;
  const held = api.customer('c-1');
  held.subscriptions.app_pro = subscription({ store: 'play_store', purchased: now, expires: now + 365 * DAY, product_plan_identifier: 'yearly' });
  let read = await provider.customerEvents('c-1', { cause: 'e1' });
  assert.deepEqual(read.events.map((e) => [e.product, e.ref.split(':').slice(0, 3).join(':')]), [['pro-yearly', 'play_store:app_pro:yearly']]);
  held.subscriptions['app_pro:monthly'] = subscription({ store: 'play_store', purchased: now, expires: now + 30 * DAY });
  delete held.subscriptions.app_pro;
  assert.deepEqual((await provider.customerEvents('c-1', { cause: 'e2' })).events.map((e) => e.product), ['pro-monthly'], 'or in the key');

  held.subscriptions = { app_pro: subscription({ store: 'play_store', purchased: now, expires: now + 7 * DAY, product_plan_identifier: 'weekly' }) };
  read = await provider.customerEvents('c-1', { cause: 'e3' });
  assert.deepEqual(read.events, []);
  assert.equal(read.present.size, 1, 'its own: what it holds here lapses on its own instead of ending at once');
  assert.ok(logs.some((line) => /app_pro:weekly, this app's store product on a base plan or kind none of stores\.products lists/.test(line)));

  held.subscriptions = { 'com.other.app.premium': subscription({ purchased: now, expires: now + 7 * DAY }) };
  read = await provider.customerEvents('c-1', { cause: 'e4' });
  assert.deepEqual(read.events, []);
  assert.equal(logs.filter((line) => line.includes('com.other.app')).length, 0, 'another app\'s product, without a word');
});

test('test purchases: marked as such in the ref, or left out with sandbox off; other stores never count', async () => {
  const { provider, api, clock } = setup();
  const now = clock.now;
  const held = api.customer('c-1');
  held.subscriptions[MONTHLY] = subscription({ purchased: now, expires: now + DAY, sandbox: true });
  held.subscriptions.rc_promo_pro_monthly = subscription({ store: 'promotional', purchased: now, expires: now + 30 * DAY });
  held.subscriptions[PRODUCTS['pro-yearly'].appStore] = subscription({ store: 'stripe', purchased: now, expires: now + 365 * DAY });
  const read = await provider.customerEvents('c-1', { cause: 'e1' });
  assert.deepEqual(read.events.map((e) => [e.product, e.sandbox]), [['pro-monthly', true]]);
  assert.match(read.events[0].ref, /^app_store-sandbox:/);
  assert.deepEqual(provider.manage(read.events[0].ref), { via: 'store', store: 'app_store', sandbox: true, url: STORE_MANAGE_URLS.app_store });
  assert.equal(read.present.size, 1, 'the other stores are not this adapter\'s');

  const strict = revenuecatProvider({ webhookAuth: AUTH, apiKey: API_KEY, products: PRODUCTS, sandbox: false, fetch: api.fetch, clock: () => now });
  const without = await strict.customerEvents('c-1', { cause: 'e2' });
  assert.deepEqual(without.events, []);
  assert.equal(without.present.size, 0, 'what a test purchase gave here then ends');
  assert.equal(provider.manage('paddle:sub_1'), null);
  assert.deepEqual(provider.manage('play_store:app_pro:monthly:0123456789abcdef'),
    { via: 'store', store: 'play_store', sandbox: false, url: STORE_MANAGE_URLS.play_store });
});

test('one-off purchases: RevenueCat\'s non-subscriptions, by its own id, for products of kind once', async () => {
  const { provider, api, clock } = setup();
  const now = clock.now;
  const held = api.customer('c-1');
  held.non_subscriptions[PRODUCTS['pro-lifetime'].appStore] = [
    { id: 'cadba0c81b', purchase_date: iso(now - DAY), store: 'app_store', is_sandbox: false },
  ];
  held.non_subscriptions[MONTHLY] = [{ id: 'f00dfeed12', purchase_date: iso(now), store: 'app_store', is_sandbox: false }];
  const read = await provider.customerEvents('c-1', { cause: 'e1' });
  assert.deepEqual(read.events.map((e) => [e.type, e.product, e.occurredAt]), [['purchase', 'pro-lifetime', iso(now - DAY)]],
    'a subscription\'s product bought as a one-off grants nothing');
  assert.match(read.events[0].ref, /^app_store:com\.example\.app\.pro\.lifetime:[0-9a-f]{16}:cadba0c81b$/);
  assert.equal(read.present.size, 2);
});

test('RevenueCat\'s errors and silence: 502, and the log has the status and code, never the customer', async () => {
  const { provider, api, logs } = setup({ timeoutMs: 50 });
  api.fail(401);
  assert.equal(await fails(provider.customerEvents('c-secret-1', { cause: 'e1' })), '502 billing_provider_error');
  api.fail(429);
  assert.equal(await fails(provider.customerEvents('c-secret-1', { cause: 'e2' })), '502 billing_provider_unavailable');
  api.fail(503);
  assert.equal(await fails(provider.customerEvents('c-secret-1', { cause: 'e3' })), '502 billing_provider_unavailable');
  api.fail('network');
  assert.equal(await fails(provider.customerEvents('c-secret-1', { cause: 'e4' })), '502 billing_provider_unavailable');
  const slow = revenuecatProvider({
    webhookAuth: AUTH, apiKey: API_KEY, products: PRODUCTS, timeoutMs: 20, log: (line) => logs.push(line),
    fetch: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
  });
  assert.equal(await fails(slow.customerEvents('c-secret-1', { cause: 'e5' })), '502 billing_provider_unavailable');
  const empty = revenuecatProvider({
    webhookAuth: AUTH, apiKey: API_KEY, products: PRODUCTS, log: (line) => logs.push(line),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ request_date_ms: 1 }) }),
  });
  assert.equal(await fails(empty.customerEvents('c-secret-1', { cause: 'e6' })), '502 billing_provider_error');
  assert.equal(logs.length, 6);
  assert.ok(logs.every((line) => !line.includes('c-secret-1') && !line.includes(API_KEY)), 'neither the id nor the key');
  assert.ok(logs.some((line) => /GET \/v1\/subscribers\/…: 401 7225/.test(line)));
  assert.ok(logs.some((line) => /no answer in 20 ms/.test(line)));
});

test('revenuecatProvider: what it needs is checked', () => {
  const make = (options) => () => revenuecatProvider({ webhookAuth: AUTH, apiKey: API_KEY, ...options });
  assert.throws(make({ webhookAuth: 'short' }), /Authorization header value/);
  assert.throws(make({ webhookAuth: undefined }), /Authorization header value/);
  assert.throws(make({ apiKey: 'appl_publicKeyOfTheApp' }), /secret API key/);
  assert.throws(make({ webhookSecret: 'short' }), /signing secret/);
  assert.throws(make({ sandbox: 'yes' }), /sandbox/);
  const provider = make({})();
  assert.deepEqual([provider.id, provider.kind, provider.sandbox], ['revenuecat', 'store', true]);
});
