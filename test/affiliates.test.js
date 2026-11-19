/**
 * The affiliates (affiliates.js): referral codes made when first asked for, who brought whom (the
 * code's cookie when an account is made, the discount of a payment), the commission of a buyer's
 * first real payment, its confirmation and its reversal, a referral's months (a grant chained, or
 * the next renewal put off), the creators' campaigns and their payouts; billing.js's side (the
 * `payment` event, whenPaid, whenRefunded, the discount at a checkout); and the routes, with the
 * admin's guarded as the rest of /api/admin. A stand-in provider; no real ids anywhere.
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
import { HttpError } from '../http.js';
import { createAccounts } from '../accounts.js';
import { createEntitlements } from '../entitlements.js';
import { createAudit } from '../audit.js';
import { createBilling, signedProvider } from '../billing.js';
import { createAffiliates, resolveAffiliates, normalizeCode, REF_COOKIE } from '../affiliates.js';
import { inRequest } from '../request-scope.js';
import { resolveConfig } from '../config.js';
import { createSuite, createApp } from '../app.js';
import { registerBillingProvider } from '../providers.js';
import { ID, SECRET, fakeBilling, delivery } from './fake-provider.js';

registerBillingProvider(fakeBilling);

const DAY = 24 * 3600 * 1000;
const PRODUCTS = {
  'pro-monthly': { plan: 'pro', kind: 'subscription', price: 'pri_month' },
  'pro-yearly': { plan: 'pro', kind: 'subscription', price: 'pri_year', founderPrice: 'pri_year_founder' },
};
const PLANS = { free: { name: 'Free', features: {} }, pro: { name: 'Pro', features: {} } };

/** The engine on a database of its own, with billing and a provider that keeps what it was asked. */
function setup(t, { enabled = true, confirmDays = 30, adapter = {}, now = '2026-12-01T10:00:00Z', founder = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-affiliates-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const clock = { now: Date.parse(now) };
  const accounts = createAccounts({ database, clock: () => clock.now });
  const entitlements = createEntitlements({
    database, appId: 'work', clock: () => clock.now, features: {}, plans: PLANS,
    plansJson: null, defaultPlanOverride: null, organizationsOf: () => [],
  });
  const audit = createAudit({ database, trustProxy: '', clock: () => clock.now });
  const calls = [];
  const taken = new Set(adapter.taken || []);
  const provider = {
    ...signedProvider({ id: 'fakepay', secret: 'a-secret-of-the-stand-in-provider' }),
    checkoutUrl: async (args) => { calls.push(['checkout', args]); return 'https://pay.example/checkout'; },
    createDiscount: async (args) => {
      calls.push(['createDiscount', args]);
      if (taken.has(args.code)) throw new HttpError(409, 'discount_code_taken');
      return { id: `dsc_${args.code.toLowerCase()}` };
    },
    setDiscountActive: async (id, active) => { calls.push(['setDiscountActive', id, active]); },
    postponeRenewal: async (ref, days) => {
      calls.push(['postponeRenewal', ref, days]);
      return adapter.postpone ? adapter.postpone(ref, days) : { nextBilledAt: '2027-02-01T00:00:00Z' };
    },
    ...(adapter.without ? Object.fromEntries(adapter.without.map((name) => [name, undefined])) : {}),
  };
  const billing = createBilling({
    database, entitlements, provider, products: PRODUCTS, audit, clock: () => clock.now, log: () => {}, isFounder: () => founder,
  });
  const lines = [];
  const config = resolveAffiliates({ enabled, confirmDays }, { appId: 'work' }).affiliates;
  let n = 0;
  const affiliates = createAffiliates({
    database, billing, provider, discountKey: 'fakepay:sandbox', entitlements, accounts, audit, config,
    baseUrl: 'https://work.example', clock: () => clock.now, log: (line) => lines.push(line),
    // Codes that read the same every run: K, M, N… in turn.
    random: () => (n++ % 20) + 8,
  });
  billing.whenPaid(affiliates.paid);
  billing.whenRefunded(affiliates.refunded);
  billing.discountWith(affiliates.discountFor);
  accounts.whenCreated(affiliates.attributeLink);
  const person = (username, email = `${username}@example.com`) => accounts.create({ username, email });
  let event = 0;
  /** A payment, as the provider's adapter translates `transaction.completed`. */
  const pay = (buyer, {
    amount = 3500, product = 'pro-yearly', discount = null, ref = `txn_${++event}`, subscription = `sub_${buyer.username}`,
    customer = `ctm_${buyer.username}`, first = true,
  } = {}) => billing.apply({
    id: `ntf_${++event}:payment`, type: 'payment', occurredAt: new Date(clock.now).toISOString(), subject: { type: 'user', id: buyer.id },
    customer, ref, subscription, product, discount, amount, currency: 'EUR', first,
  });
  /** A subscription the person pays on the web, live until a year from now. */
  const subscribe = (buyer, { ref = `sub_${buyer.username}`, product = 'pro-yearly', status = 'active', ending = false } = {}) => billing.apply({
    id: `ntf_${++event}`, type: 'subscription', occurredAt: new Date(clock.now).toISOString(), subject: { type: 'user', id: buyer.id },
    customer: `ctm_${buyer.username}`, ref, product, status, ending, periodEnd: new Date(clock.now + 365 * DAY).toISOString(),
  });
  const refund = (ref, { subscription = false } = {}) => billing.apply({
    id: `ntf_${++event}:refund`, type: 'refund', occurredAt: new Date(clock.now).toISOString(), ref, subscription,
  });
  const commissions = () => database.all('SELECT * FROM affiliate_commissions ORDER BY id');
  const settle = () => new Promise((resolve) => { setImmediate(resolve); });
  return {
    database, clock, accounts, entitlements, billing, affiliates, calls, lines, person, pay, subscribe, refund, commissions, settle, audit,
  };
}

/** A browser's request with a cookie, and its answer's headers. */
function browser(cookie, path = '/auth/callback') {
  const headers = {};
  const req = { url: path, method: 'GET', headers: { cookie } };
  const res = {
    headersSent: false,
    getHeader: (name) => headers[name.toLowerCase()],
    setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
  };
  return { req, res, headers };
}

const code = async (fn) => {
  try { await fn(); } catch (err) { return `${err.status} ${err.code}`; }
  return 'ok';
};

/* ------------------------------- configuration ------------------------------ */

test('the configuration: the program’s defaults, off; what is given replaces them; a typo stops the start', () => {
  const { affiliates, errors } = resolveAffiliates(undefined, { appId: 'work' });
  assert.deepEqual(errors, []);
  assert.equal(affiliates.enabled, false);
  assert.equal(affiliates.confirmDays, 30);
  assert.deepEqual(affiliates.referral, {
    prefix: 'WORK', offer: { type: 'flat', amount: 390, currency: 'EUR' }, products: ['pro-monthly', 'pro-yearly'], reward: 'pro_month', yearlyCap: 12,
  });
  assert.deepEqual(affiliates.creator, {
    offer: { type: 'percent', percent: 20 }, products: ['pro-yearly'], reward: { cash: 600, currency: 'EUR' }, payoutMinimum: 3000,
  });
  const given = resolveAffiliates({
    enabled: true, confirmDays: 14, cookieDomain: '.example.com', pressKitUrl: 'https://example.com/press',
    referral: { yearlyCap: 6 }, creator: { reward: { cash: 800, currency: 'EUR' } },
  }, { appId: 'work' });
  assert.deepEqual(given.errors, []);
  assert.equal(given.affiliates.referral.yearlyCap, 6);
  assert.equal(given.affiliates.creator.reward.cash, 800);
  assert.equal(given.affiliates.cookieDomain, '.example.com');
  const bad = resolveAffiliates({ enable: true, confirmDays: -1, referral: { offer: { type: 'flat', amount: 3.9 } }, pressKitUrl: 'http://x' });
  assert.equal(bad.errors.length, 4, bad.errors.join('\n'));
  // Through suite.config.js, as an app writes it.
  const config = resolveConfig({ app: { id: 'work', name: 'Work' }, affiliates: { enabled: true } }, { DATA_DIR: os.tmpdir() });
  assert.equal(config.affiliates.enabled, true);
  assert.ok(resolveConfig({ app: { id: 'work', name: 'Work' }, affiliates: { enabeld: true } }, { DATA_DIR: os.tmpdir() })
    .errors.some((e) => e.includes('affiliates.enabeld')));
  assert.equal(normalizeCode(' maria20 '), 'MARIA20');
  assert.equal(normalizeCode('MA'), null);
  // Spaces and dashes go (Paddle has no dashes in codes): said out loud, it is the same code.
  assert.equal(normalizeCode('MARIA 20'), 'MARIA20');
  assert.equal(normalizeCode('work-7kq2'), 'WORK7KQ2');
  assert.equal(normalizeCode('MARIA_20'), null);
});

/* ---------------------------------- codes ---------------------------------- */

test('a referral code: made the first time it is asked for, at the provider first, one per account', async (t) => {
  const { affiliates, person, calls, database } = setup(t);
  const ana = person('ana');
  const [first, again] = await Promise.all([affiliates.referralOf(ana), affiliates.referralOf(ana)]);
  assert.match(first.code, /^WORK[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(again.code, first.code, 'two tabs at once make one code');
  const made = calls.filter(([what]) => what === 'createDiscount');
  assert.equal(made.length, 1);
  assert.deepEqual(made[0][1], {
    code: first.code, offer: { type: 'flat', amount: 390, currency: 'EUR' }, products: ['pro-monthly', 'pro-yearly'],
    description: `Referral ${first.code}`,
  });
  assert.equal(database.get('SELECT discount_id FROM affiliate_discounts').discount_id, `dsc_${first.code.toLowerCase()}`);
  const panel = await affiliates.me(ana);
  assert.equal(panel.codes.length, 1);
  assert.equal(panel.codes[0].link, `https://work.example/r/${first.code}`);
  assert.equal(panel.codes[0].discount, true);
  assert.equal(panel.rules.referral.yearly_cap, 12);
});

test('a referral code the provider already has is never kept: another is made', async (t) => {
  // The first random code (WORKJKMN) is taken there already.
  const { affiliates, person, calls } = setup(t, { adapter: { taken: ['WORKJKMN'] } });
  const made = await affiliates.referralOf(person('ana'));
  assert.equal(made.code, 'WORKPQRS');
  assert.equal(calls.filter(([what]) => what === 'createDiscount').length, 2);
});

test('without createDiscount a code still works by its link: no discount kept, the panel says so', async (t) => {
  const { affiliates, person, database } = setup(t, { adapter: { without: ['createDiscount', 'setDiscountActive'] } });
  const ana = person('ana');
  const panel = await affiliates.me(ana);
  assert.equal(panel.codes[0].discount, false);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM affiliate_discounts').n, 0);
  const made = await affiliates.createCampaign({ email: 'ana@example.com', code: 'ana20' }, null);
  assert.equal(made.code, 'ANA20');
  assert.equal(made.discount, false);
});

test('the program off: no codes nor panel, but the admin makes campaigns and a creator’s code typed at checkout earns', async (t) => {
  const { affiliates, person, pay, commissions } = setup(t, { enabled: false });
  const ana = person('ana');
  assert.equal(await code(() => affiliates.me(ana)), '404 affiliates_off');
  const campaign = await affiliates.createCampaign({ email: 'ana@example.com', code: 'MARIA20', campaign: 'YouTube' }, null);
  const bob = person('bob');
  pay(bob, { discount: 'dsc_maria20', amount: 2800 });
  const [sale] = commissions();
  assert.equal(sale.code_id, campaign.id);
  assert.equal(sale.amount, 600);
  assert.equal(sale.status, 'pending');
  // A link while off: nothing noted.
  const { req, res } = browser(`${REF_COOKIE}=MARIA20`);
  inRequest(req, () => person('cat'), res);
  assert.equal(affiliates.figuresOf(campaign.id).accounts, 1, 'only bob, by the checkout');
});

/* ------------------------------ who brought whom ----------------------------- */

test('a new account made with a code’s cookie is the code’s; the cookie goes; never the admin’s, never the owner', async (t) => {
  const { affiliates, person, database } = setup(t);
  const ana = person('ana');
  const { code: anaCode } = await affiliates.referralOf(ana);
  const signIn = browser(`other=1; ${REF_COOKIE}=${anaCode.toLowerCase()}`);
  const bob = inRequest(signIn.req, () => person('bob'), signIn.res);
  assert.deepEqual({ ...database.get('SELECT code_id, source FROM affiliate_attributions WHERE user_id = ?', bob.id) },
    { code_id: database.get('SELECT id FROM affiliate_codes WHERE code = ?', anaCode).id, source: 'link' });
  assert.match(String(signIn.headers['set-cookie']), new RegExp(`^${REF_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`));
  // An account the admin makes from the panel: the admin's own browser may carry a code.
  const fromAdmin = browser(`${REF_COOKIE}=${anaCode}`, '/api/admin/users');
  const cat = inRequest(fromAdmin.req, () => person('cat'), fromAdmin.res);
  assert.equal(database.get('SELECT 1 AS x FROM affiliate_attributions WHERE user_id = ?', cat.id), undefined);
  // A code nobody has, or none: nothing.
  const unknown = browser(`${REF_COOKIE}=NOPE-0000`);
  const dan = inRequest(unknown.req, () => person('dan'), unknown.res);
  assert.equal(database.get('SELECT 1 AS x FROM affiliate_attributions WHERE user_id = ?', dan.id), undefined);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM affiliate_attributions').n, 1);
});

test('the checkout: the code that brought someone gives its discount on their first purchase, at the regular price only', async (t) => {
  const { affiliates, person, billing, calls, pay } = setup(t);
  const ana = person('ana');
  const { code: anaCode } = await affiliates.referralOf(ana);
  const signIn = browser(`${REF_COOKIE}=${anaCode}`);
  const bob = inRequest(signIn.req, () => person('bob'), signIn.res);
  const checkout = async (who, product = 'pro-yearly') => {
    await billing.checkoutUrl({ type: 'user', id: who.id }, product, { returnUrl: 'https://work.example/', user: who });
    return calls.filter(([what]) => what === 'checkout').at(-1)[1];
  };
  assert.equal((await checkout(bob)).discount, `dsc_${anaCode.toLowerCase()}`);
  assert.equal((await checkout(bob, 'pro-monthly')).discount, `dsc_${anaCode.toLowerCase()}`);
  assert.equal('discount' in await checkout(ana), false, 'never the owner’s own');
  assert.equal('discount' in await checkout(person('cat')), false, 'nobody brought cat');
  // Once bob paid, never again.
  pay(bob, { amount: 3110 });
  assert.equal('discount' in await checkout(bob, 'pro-monthly').catch(() => ({})), false);
});

test('a founder’s price gets no discount: the provider’s discount is restricted to the regular one', async (t) => {
  const { affiliates, person, billing, calls } = setup(t, { founder: true });
  const { code: anaCode } = await affiliates.referralOf(person('ana'));
  const signIn = browser(`${REF_COOKIE}=${anaCode}`);
  const bob = inRequest(signIn.req, () => person('bob'), signIn.res);
  await billing.checkoutUrl({ type: 'user', id: bob.id }, 'pro-yearly', { returnUrl: 'https://work.example/', user: bob });
  const [, args] = calls.filter(([what]) => what === 'checkout').at(-1);
  assert.equal(args.price, 'pri_year_founder');
  assert.equal('discount' in args, false);
});

/* -------------------------------- commissions -------------------------------- */

test('the payment event: kept once, grants nothing, and the first real payment of whom a code brought is its commission', async (t) => {
  const { affiliates, person, pay, commissions, entitlements, database, billing } = setup(t);
  const ana = person('ana');
  const { code: anaCode } = await affiliates.referralOf(ana);
  const signIn = browser(`${REF_COOKIE}=${anaCode}`);
  const bob = inRequest(signIn.req, () => person('bob'), signIn.res);
  // The monthly's first month is free with a referral: nothing paid, nothing earned yet.
  assert.equal(pay(bob, { product: 'pro-monthly', amount: 0, discount: `dsc_${anaCode.toLowerCase()}`, ref: 'txn_free' }), 'paid');
  assert.equal(commissions().length, 0);
  assert.equal(entitlements.of(bob).plan.id, 'free', 'a payment grants nothing by itself');
  // Its first renewal is the first real payment.
  assert.equal(pay(bob, { product: 'pro-monthly', amount: 390, first: false, ref: 'txn_second' }), 'paid');
  const [sale] = commissions();
  assert.equal(sale.buyer_id, bob.id);
  assert.equal(sale.status, 'pending');
  assert.equal(sale.reward, 'pro_month');
  assert.equal(sale.ref, 'txn_second');
  assert.equal(sale.confirm_after, '2026-12-31T10:00:00.000Z');
  // Renewals never count again.
  pay(bob, { product: 'pro-monthly', amount: 390, first: false });
  assert.equal(commissions().length, 1);
  // The same delivery again: a duplicate, its hook not told twice.
  const heard = [];
  billing.whenPaid(({ event }) => heard.push(event.id));
  const again = {
    id: 'ntf_same:payment', type: 'payment', occurredAt: new Date().toISOString(), subject: { type: 'user', id: bob.id },
    ref: 'txn_same', product: 'pro-monthly', amount: 390,
  };
  assert.deepEqual([billing.apply(again), billing.apply(again)], ['paid', 'duplicate']);
  assert.deepEqual(heard, ['ntf_same:payment']);
  assert.equal(database.get("SELECT outcome FROM billing_events WHERE event_id = 'ntf_same:payment'").outcome, 'paid');
  assert.equal(database.get("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'billing.%'").n, 0, 'a payment is no audit entry');
});

test('the paid one wins: a discount typed at checkout takes the buyer from the link’s code', async (t) => {
  const { affiliates, person, pay, commissions, database } = setup(t);
  const { code: anaCode } = await affiliates.referralOf(person('ana'));
  const campaign = await affiliates.createCampaign({ email: 'ana@example.com', code: 'MARIA20' }, null);
  person('maria');
  const signIn = browser(`${REF_COOKIE}=${anaCode}`);
  const bob = inRequest(signIn.req, () => person('bob'), signIn.res);
  pay(bob, { discount: 'dsc_maria20', amount: 2800 });
  assert.equal(database.get('SELECT source FROM affiliate_attributions WHERE user_id = ?', bob.id).source, 'checkout');
  assert.equal(commissions()[0].code_id, campaign.id);
  assert.equal(commissions()[0].amount, 600);
});

test('a creator’s code earns only for the yearly; nobody earns from someone who paid before', async (t) => {
  const { affiliates, person, pay, subscribe, commissions } = setup(t);
  person('maria');
  await affiliates.createCampaign({ email: 'maria@example.com', code: 'MARIA20' }, null);
  const signIn = (who) => { const b = browser(`${REF_COOKIE}=MARIA20`); return inRequest(b.req, () => person(who), b.res); };
  pay(signIn('bob'), { product: 'pro-monthly', amount: 390 });
  assert.equal(commissions().length, 0, 'the monthly gives a creator nothing');
  // Someone who had a subscription here before the program noted payments.
  const cat = signIn('cat');
  subscribe(cat, { ref: 'sub_old', status: 'canceled' });
  pay(cat, { amount: 2800, subscription: 'sub_cat_new' });
  assert.equal(commissions().length, 0);
});

test('nobody refers themselves: the same account, the same customer at the provider, the same email', async (t) => {
  const { affiliates, person, pay, commissions, billing, database } = setup(t);
  const ana = person('ana', 'ana@example.com');
  const { code: anaCode } = await affiliates.referralOf(ana);
  const discount = `dsc_${anaCode.toLowerCase()}`;
  billing.linkCustomer({ type: 'user', id: ana.id }, 'ctm_ana');
  pay(person('twin', 'ANA+work@example.com'), { discount, amount: 3110 });
  // Another account paying with Ana's customer (who it is comes from the identity, at the provider).
  const alias = person('alias', 'alias@example.com');
  assert.equal(affiliates.paid({
    user: alias, event: { type: 'payment', id: 'ntf_alias', ref: 'txn_alias', customer: 'ctm_ana', product: 'pro-yearly', discount, amount: 3110 },
  }), 'own');
  pay(ana, { discount, amount: 3110, customer: 'ctm_ana' });
  assert.equal(commissions().length, 0);
  const why = database.all("SELECT meta FROM audit_log WHERE action = 'affiliates.self_referral' ORDER BY id").map((r) => JSON.parse(r.meta).why);
  assert.deepEqual(why, ['same_email', 'same_customer']);
  assert.equal(database.get('SELECT 1 AS x FROM affiliate_attributions WHERE user_id = ?', ana.id), undefined, 'a code is never its owner’s');
});

test('a group’s payment is nobody’s code', async (t) => {
  const { affiliates, person, commissions } = setup(t);
  const bob = person('bob');
  assert.equal(affiliates.paid({ user: bob, organization: { id: 3 }, event: { type: 'payment', amount: 3000, product: 'pro-yearly' } }), 'none');
  assert.equal(commissions().length, 0);
});

/* --------------------------- confirmation and refunds ------------------------ */

test('a refund before the confirmation reverses the sale; after it, a creator’s earns a negative entry, a referral’s is noted', async (t) => {
  const { affiliates, person, pay, refund, commissions, clock, settle } = setup(t);
  const { code: anaCode } = await affiliates.referralOf(person('ana'));
  person('maria');
  const campaign = await affiliates.createCampaign({ email: 'maria@example.com', code: 'MARIA20' }, null);
  const bob = person('bob');
  const cat = person('cat');
  const dan = person('dan');
  pay(bob, { discount: 'dsc_maria20', amount: 2800, ref: 'txn_bob' });
  pay(cat, { discount: 'dsc_maria20', amount: 2800, ref: 'txn_cat' });
  pay(dan, { discount: `dsc_${anaCode.toLowerCase()}`, amount: 3110, ref: 'txn_dan' });
  refund('txn_bob');
  await settle();
  assert.equal(commissions().find((c) => c.buyer_id === bob.id).status, 'reversed');
  clock.now += 31 * DAY;
  const swept = await affiliates.sweep();
  assert.equal(swept.confirmed, 2);
  assert.equal(swept.granted, 1, 'dan’s month for ana');
  refund('sub_cat', { subscription: true });
  refund('txn_dan');
  await settle();
  const rows = commissions();
  const adjustment = rows.find((c) => c.entry === 'adjustment');
  assert.equal(adjustment.amount, -600);
  assert.equal(adjustment.buyer_id, cat.id);
  assert.equal(rows.find((c) => c.buyer_id === dan.id).status, 'confirmed');
  assert.ok(rows.find((c) => c.buyer_id === dan.id).refunded_at, 'the month given stays, the refund is noted');
  const figures = affiliates.figuresOf(campaign.id);
  assert.deepEqual([figures.pending, figures.confirmed, figures.reversed, figures.earned, figures.balance], [0, 1, 1, 0, 0]);
  refund('sub_cat', { subscription: true });
  assert.equal(commissions().filter((c) => c.entry === 'adjustment').length, 1, 'once');
});

test('a referral’s months: 30 days each, chained; the next renewal put off for whoever pays; the yearly cap', async (t) => {
  const { affiliates, person, pay, subscribe, clock, entitlements, calls, database } = setup(t);
  const ana = person('ana');
  const { code: anaCode } = await affiliates.referralOf(ana);
  const discount = `dsc_${anaCode.toLowerCase()}`;
  const buyers = Array.from({ length: 14 }, (_, i) => person(`buyer${i}`));
  pay(buyers[0], { discount, amount: 3110 });
  pay(buyers[1], { discount, amount: 3110 });
  clock.now += 31 * DAY;
  const start = clock.now;
  assert.deepEqual(await affiliates.sweep(), { confirmed: 2, granted: 2, postponed: 0, failed: 0, waiting: 0 });
  const grants = entitlements.grantsOf('user', ana.id).filter((g) => g.source === 'referral').sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  assert.deepEqual(grants.map((g) => [g.plan, g.starts_at, g.ends_at]), [
    ['pro', new Date(start).toISOString(), new Date(start + 30 * DAY).toISOString()],
    ['pro', new Date(start + 30 * DAY).toISOString(), new Date(start + 60 * DAY).toISOString()],
  ]);
  assert.equal(entitlements.of(ana).plan.id, 'pro');
  assert.equal((await affiliates.sweep()).granted, 0, 'once each');
  // Ana pays on the web now: her next charge moves instead.
  subscribe(ana, { ref: 'sub_ana' });
  pay(buyers[2], { discount, amount: 3110 });
  clock.now += 31 * DAY;
  assert.equal((await affiliates.sweep()).postponed, 1);
  assert.deepEqual(calls.filter(([what]) => what === 'postponeRenewal').map(([, ref, days]) => [ref, days]), [['sub_ana', 30]]);
  // The cap: 12 a calendar year; the rest confirmed with nothing given.
  for (const buyer of buyers.slice(3)) pay(buyer, { discount, amount: 3110 });
  clock.now += 31 * DAY;
  const last = await affiliates.sweep();
  assert.equal(last.confirmed, 11);
  assert.equal(last.postponed, 9, '12 in the year, 3 of them already');
  assert.equal(database.get("SELECT COUNT(*) AS n FROM affiliate_commissions WHERE reason = 'yearly_cap'").n, 2);
  assert.equal(affiliates.figuresOf(database.get('SELECT id FROM affiliate_codes WHERE code = ?', anaCode).id).months, 12);
});

test('a renewal that can’t be put off waits for the next sweep; one that no longer renews is a grant instead', async (t) => {
  let fail = true;
  const { affiliates, person, pay, subscribe, clock, entitlements, database } = setup(t, {
    adapter: { postpone: () => { if (fail) throw new Error('provider down'); return { ended: true }; } },
  });
  const ana = person('ana');
  const { code: anaCode } = await affiliates.referralOf(ana);
  subscribe(ana, { ref: 'sub_ana' });
  pay(person('bob'), { discount: `dsc_${anaCode.toLowerCase()}`, amount: 3110 });
  clock.now += 31 * DAY;
  assert.equal((await affiliates.sweep()).waiting, 1);
  assert.deepEqual({ ...database.get('SELECT status, tries FROM affiliate_rewards') }, { status: 'pending', tries: 1 });
  fail = false;
  assert.equal((await affiliates.sweep()).granted, 1, 'ended there: a grant');
  assert.equal(entitlements.grantsOf('user', ana.id).filter((g) => g.source === 'referral').length, 1);
});

/* ---------------------------------- payouts ---------------------------------- */

test('a creator’s payout: never more than is owed; one that covers it all marks the sales paid; the CSV has both', async (t) => {
  const { affiliates, person, pay, clock } = setup(t);
  person('maria');
  const campaign = await affiliates.createCampaign({ email: 'maria@example.com', code: 'MARIA20', campaign: 'Shorts' }, null);
  for (const who of ['bob', 'cat', 'dan', 'eve', 'fay']) pay(person(who), { discount: 'dsc_maria20', amount: 2800 });
  clock.now += 31 * DAY;
  await affiliates.sweep();
  assert.equal(affiliates.figuresOf(campaign.id).balance, 3000);
  assert.equal(await code(() => affiliates.recordPayout(campaign.id, { amount: 3100 }, null)), '409 payout_over_balance');
  assert.equal(await code(() => affiliates.recordPayout(campaign.id, { amount: 12.5 }, null)), '400 field_invalid');
  const partial = affiliates.recordPayout(campaign.id, { amount: 1000, method: 'Bank transfer' }, null);
  assert.equal(partial.figures.balance, 2000);
  const rest = affiliates.recordPayout(campaign.id, { amount: 2000, method: 'Bank transfer', reference: '=HYPERLINK("x")' }, null);
  assert.equal(rest.figures.balance, 0);
  const { commissions, payouts } = affiliates.commissionsOf(campaign.id);
  assert.ok(commissions.every((c) => c.status === 'paid'));
  assert.equal(payouts.length, 2);
  const csv = affiliates.exportCsv({ kind: 'creator' });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 1 + 5 + 2);
  assert.match(lines[0], /^type,code,kind,campaign,owner_email/);
  assert.ok(lines.some((line) => line.includes('\'=HYPERLINK') && line.startsWith('payout,MARIA20')), 'no formula runs in a spreadsheet');
  // A referral code has no payouts.
  const { code: referral } = await affiliates.referralOf(person('ana'));
  const referralId = affiliates.codeOf(referral).id;
  assert.equal(await code(() => affiliates.recordPayout(referralId, { amount: 100 }, null)), '409 payout_not_cash');
});

test('campaigns: a code taken here or at the provider is refused; turned off it gives no discount and earns nothing', async (t) => {
  const { affiliates, person, pay, commissions, calls, billing } = setup(t, { adapter: { taken: ['TAKEN1'] } });
  person('maria');
  assert.equal(await code(() => affiliates.createCampaign({ email: 'nobody@example.com', code: 'MARIA20' }, null)), '404 user_not_found');
  assert.equal(await code(() => affiliates.createCampaign({ email: 'maria@example.com', code: 'M A' }, null)), '400 field_invalid');
  assert.equal(await code(() => affiliates.createCampaign({ email: 'maria@example.com', code: 'TAKEN1' }, null)), '409 discount_code_taken');
  assert.equal(await code(() => affiliates.createCampaign({ email: 'maria@example.com', code: 'MARIA20', products: ['pro-weekly'] }, null)), '400 field_invalid');
  const made = await affiliates.createCampaign({ email: 'maria@example.com', code: 'MARIA20' }, null);
  assert.equal(await code(() => affiliates.createCampaign({ email: 'maria@example.com', code: 'maria20' }, null)), '409 affiliate_code_taken');
  assert.deepEqual(calls.filter(([what]) => what === 'createDiscount').at(-1)[1], {
    code: 'MARIA20', offer: { type: 'percent', percent: 20 }, products: ['pro-yearly'], description: 'Creator MARIA20',
  });
  await affiliates.setActive(made.id, false);
  assert.deepEqual(calls.at(-1), ['setDiscountActive', 'dsc_maria20', false]);
  const b = browser(`${REF_COOKIE}=MARIA20`);
  const bob = inRequest(b.req, () => person('bob'), b.res);
  await billing.checkoutUrl({ type: 'user', id: bob.id }, 'pro-yearly', { returnUrl: 'https://work.example/', user: bob });
  assert.equal('discount' in calls.at(-1)[1], false);
  pay(bob, { discount: 'dsc_maria20', amount: 2800 });
  assert.equal(commissions().length, 0);
});

/* ---------------------------------- routes ----------------------------------- */

/** The stand-in provider's API: discounts, and renewals put off. */
async function apiServer(t) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      calls.push([req.method, req.url, parsed]);
      const answer = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.method === 'POST' && req.url === '/discounts') {
        if (parsed.code === 'TAKEN1') return answer(409, { error: { code: 'conflict' } });
        return answer(200, { data: { id: `dsc_${parsed.code.toLowerCase()}` } });
      }
      return answer(200, { data: {} });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, url: `http://127.0.0.1:${server.address().port}` };
}

async function serve(t, { affiliates = { enabled: true, cookieDomain: '.example.test' } } = {}) {
  const api = await apiServer(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-affiliates-http-'));
  const suite = createSuite({
    config: {
      app: { id: 'demo', name: 'Demo', languages: ['en'] }, accounts: { minPasswordLength: 8 },
      modules: { billing: true }, plans: PLANS, defaultPlan: 'free', products: PRODUCTS, affiliates,
    },
    env: {
      DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1',
      BILLING_PROVIDER: ID, FAKEPAY_SECRET: SECRET, FAKEPAY_API_BASE: api.url,
    },
    log: () => {}, exitOnError: false,
  });
  const app = createApp({ suite, version: '1.0.0', handleSignals: false, log: () => {} });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const raw = (pathname, options = {}) => fetch(base + pathname, { redirect: 'manual', ...options });
  const as = async (username, password = `${username}-password`) => {
    let cookie = '';
    const call = async (method, pathname, body) => {
      const res = await fetch(base + pathname, {
        method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('demo_sid='));
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers };
    };
    assert.equal((await call('POST', '/api/auth/login', { username, password })).status, 200);
    return call;
  };
  return { suite, base, raw, as, api };
}

test('routes: /r/<CODE> and ?codigo= leave the cookie on the shared domain; the panel and its page; the payout note', async (t) => {
  const { suite, raw, as } = await serve(t);
  suite.accounts.create({ username: 'ana', password: 'ana-password', email: 'ana@example.com' });
  const ana = await as('ana');
  assert.equal((await raw('/api/affiliates/me')).status, 401);
  const mine = await ana('GET', '/api/affiliates/me');
  assert.equal(mine.status, 200);
  const [own] = mine.data.codes;
  assert.match(own.code, /^DEMO[A-Z2-9]{4}$/);
  assert.equal(own.link, `http://127.0.0.1/r/${own.code}`);

  const link = await raw(`/r/${own.code.toLowerCase()}`);
  assert.equal(link.status, 302);
  assert.equal(link.headers.get('location'), '/');
  assert.equal(link.headers.getSetCookie().find((c) => c.startsWith(`${REF_COOKIE}=`)),
    `${REF_COOKIE}=${own.code}; Path=/; Domain=.example.test; SameSite=Lax`);
  const unknown = await raw('/r/NOPE-1234');
  assert.equal(unknown.status, 302);
  assert.equal(unknown.headers.getSetCookie().some((c) => c.startsWith(`${REF_COOKIE}=`)), false);
  const page = await raw(`/?codigo=${own.code}`);
  assert.ok(page.headers.getSetCookie().some((c) => c.startsWith(`${REF_COOKIE}=${own.code};`)));
  assert.equal((await raw(`/api/auth/config?codigo=${own.code}`)).headers.getSetCookie().some((c) => c.startsWith(`${REF_COOKIE}=`)), false,
    'never on the API');
  // The website's «Sign up» goes to /auth/login with the code: the cookie rides on its redirect to the sign-in.
  const signup = await raw(`/auth/login?signup=1&codigo=${own.code}`);
  assert.ok(signup.headers.getSetCookie().some((c) => c.startsWith(`${REF_COOKIE}=${own.code};`)), 'from /auth/login');
  // Said with a dash or in lower case, it is the same code.
  const dashed = `${own.code.slice(0, 4)}-${own.code.slice(4).toLowerCase()}`;
  assert.ok((await raw(`/?codigo=${dashed}`)).headers.getSetCookie().some((c) => c.startsWith(`${REF_COOKIE}=${own.code};`)), dashed);

  const panelPage = await raw('/afiliados');
  assert.equal(panelPage.status, 200);
  assert.match(await panelPage.text(), /\/suite\/affiliates\.js/);
  const config = (await (await raw('/api/auth/config')).json()).app.modules;
  assert.equal(config.affiliates, true);
  assert.equal(config.recommend, true);

  // The note of how to be paid is a creator's.
  assert.deepEqual([(await ana('PUT', '/api/affiliates/me', { payout_note: 'IBAN …' })).status], [404]);
  const admin = await as('admin', 'root-password');
  assert.equal((await admin('POST', '/api/admin/affiliates', { email: 'ana@example.com', code: 'ANA20' })).status, 201);
  const saved = await ana('PUT', '/api/affiliates/me', { payout_note: '  PayPal ana@example.com ' });
  assert.deepEqual([saved.status, saved.data], [200, { payout_note: 'PayPal ana@example.com' }]);
  assert.equal((await ana('PUT', '/api/affiliates/me', { payout_note: 'x'.repeat(501) })).data.error, 'field_too_long');
});

test('routes: the admin’s are the admin’s alone; a campaign, its switch, its sales, a payout and the CSV', async (t) => {
  const { suite, raw, as, api } = await serve(t);
  suite.accounts.create({ username: 'maria', password: 'maria-password', email: 'maria@example.com' });
  const maria = await as('maria');
  for (const [method, pathname] of [['GET', '/api/admin/affiliates'], ['POST', '/api/admin/affiliates'], ['PUT', '/api/admin/affiliates/1'],
    ['GET', '/api/admin/affiliates/1/commissions'], ['POST', '/api/admin/affiliates/1/payouts'], ['GET', '/api/admin/affiliates/export']]) {
    assert.equal((await raw(pathname, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' })).status, 401, `${method} ${pathname}`);
    const refused = await maria(method, pathname, method === 'GET' ? undefined : {});
    assert.deepEqual([refused.status, refused.data.error], [403, 'admin_only'], `${method} ${pathname}`);
  }
  const admin = await as('admin', 'root-password');
  const taken = await admin('POST', '/api/admin/affiliates', { email: 'maria@example.com', code: 'TAKEN1' });
  assert.deepEqual([taken.status, taken.data.error], [409, 'discount_code_taken']);
  const made = await admin('POST', '/api/admin/affiliates', { email: 'maria@example.com', code: 'maria20', campaign: 'YouTube' });
  assert.equal(made.status, 201);
  assert.equal(made.data.code.code, 'MARIA20');
  assert.equal(made.data.code.discount, true);
  assert.deepEqual(api.calls.find(([method, url, body]) => method === 'POST' && url === '/discounts' && body.code === 'MARIA20')[2].products, ['pro-yearly']);
  const id = made.data.code.id;

  // A buyer it brought, paying the yearly through the webhook.
  suite.accounts.create({ username: 'bob', password: 'bob-password', email: 'bob@example.com' });
  const bob = suite.accounts.byUsername('bob');
  const { body, headers } = delivery([{
    id: 'ntf_1:payment', type: 'payment', occurredAt: new Date().toISOString(), subject: { type: 'user', id: bob.id }, customer: 'ctm_bob',
    ref: 'txn_bob', subscription: 'sub_bob', product: 'pro-yearly', first: true, discount: 'dsc_maria20', amount: 2800, currency: 'EUR',
  }]);
  const hook = await raw('/api/billing/webhook', { method: 'POST', body, headers });
  assert.deepEqual((await hook.json()).outcomes, ['paid']);

  const list = await admin('GET', '/api/admin/affiliates?kind=creator');
  assert.equal(list.status, 200);
  assert.equal(list.data.codes.length, 1);
  assert.deepEqual(list.data.codes[0].figures.pending, 1);
  assert.equal(list.data.codes[0].owner.email, 'maria@example.com');
  assert.equal((await admin('GET', '/api/admin/affiliates?kind=gizmo')).data.error, 'field_invalid');
  const sales = await admin('GET', `/api/admin/affiliates/${id}/commissions`);
  assert.equal(sales.data.commissions[0].buyer.email, 'bob@example.com');
  assert.equal((await admin('POST', `/api/admin/affiliates/${id}/payouts`, { amount: 600 })).data.error, 'payout_over_balance', 'still pending');
  const off = await admin('PUT', `/api/admin/affiliates/${id}`, { active: false });
  assert.equal(off.data.code.active, false);
  assert.ok(api.calls.some(([method, url, sent]) => method === 'PATCH' && url === '/discounts/dsc_maria20' && sent.active === false));
  const csv = await admin('GET', '/api/admin/affiliates/export');
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(csv.data, /^type,code/);
  assert.match(csv.data, /\r\nsale,MARIA20,creator,YouTube,maria@example.com/);
  assert.equal((await admin('GET', '/api/admin/affiliates/999/commissions')).status, 404);
  const actions = suite.database.all("SELECT action FROM audit_log WHERE action LIKE 'admin.affiliates.%' ORDER BY id").map((r) => r.action);
  assert.deepEqual(actions, ['admin.affiliates.create', 'admin.affiliates.update']);
});

test('routes: with the program off the panel answers 404 and Settings links nowhere, but the admin’s tab is there', async (t) => {
  const { suite, raw, as } = await serve(t, { affiliates: null });
  suite.accounts.create({ username: 'ana', password: 'ana-password' });
  const ana = await as('ana');
  assert.deepEqual((await ana('GET', '/api/affiliates/me')).data, { error: 'affiliates_off' });
  const modules = (await (await raw('/api/auth/config')).json()).app.modules;
  assert.equal(modules.affiliates, true);
  assert.equal(modules.recommend, undefined);
  const link = await raw('/r/ANYTHING');
  assert.equal(link.status, 302);
  assert.equal(link.headers.getSetCookie().length, 0);
  const admin = await as('admin', 'root-password');
  assert.equal((await admin('GET', '/api/admin/affiliates')).data.enabled, false);
});

test('routes: a checkout of someone a link brought carries the code’s discount', async (t) => {
  const { suite, base, as } = await serve(t);
  const ana = suite.accounts.create({ username: 'ana', password: 'ana-password' });
  const { code: anaCode } = await suite.affiliates.referralOf(ana);
  // Bob's account made with the cookie in his browser (the sign-in's request), then signed in.
  const req = { url: '/auth/callback', method: 'GET', headers: { cookie: `${REF_COOKIE}=${anaCode}` } };
  inRequest(req, () => suite.accounts.create({ username: 'bob', password: 'bob-password' }), null);
  const bob = await as('bob');
  const checkout = await bob('POST', '/api/billing/checkout', { product: 'pro-yearly' });
  assert.equal(checkout.status, 200);
  assert.ok(checkout.data.url.endsWith(`&discount=dsc_${anaCode.toLowerCase()}`), checkout.data.url);
  assert.ok(base);
});
