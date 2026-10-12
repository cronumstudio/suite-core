/**
 * The plan and its payments in the browser (web/plan.js and Settings' plan section), without a
 * browser: what is offered to whom, Upgrade and Manage with the answers the server can give (409
 * already_subscribed, 404 no_customer), a native app's web view, the call to action of a 402
 * anywhere, and the way back from the checkout. The server is a stand-in for the suite's routes;
 * the texts are the core's English catalog.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom, FakeElement } from './fake-dom.js';

const document = installFakeDom();
// Settings focuses the section it opens and listens on the page; the fake page takes both.
FakeElement.prototype.focus = function focus() {};
const listeners = {};
Object.assign(document, {
  addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
  dispatchEvent: (event) => { for (const fn of [...(listeners[event.type] || [])]) fn(event); return true; },
});

const storage = new Map();
globalThis.sessionStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
const followed = [];
globalThis.location = { href: 'https://app.example.com/', origin: 'https://app.example.com', assign: (url) => followed.push(url) };
// The AI section writes its address from the page's.
globalThis.window = { location: globalThis.location };

/* ------------------------------ the stand-in ------------------------------ */

const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
let routes = {};
let asked = [];
globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
  const path = String(url);
  if (path.startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
  asked.push(`${method} ${path}`);
  const route = routes[`${method} ${path}`];
  const answer = typeof route === 'function' ? route(body ? JSON.parse(body) : undefined) : route;
  const { status = 200, data = {} } = answer || { status: 404, data: { error: 'not_found' } };
  return { ok: status < 400, status, json: async () => data };
};

const { loadLanguage, t } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
const { openSettings } = await import('../web/settings.js');
const { productText, offerFor, offerPlan, isPlanError, billingReturn, PLAN_EVENT } = await import('../web/plan.js');
const { ApiError } = await import('../web/api.js');

const PLANS = [{ id: 'free', name: 'Free' }, { id: 'pro', name: 'Pro' }];
const FREE = { plan: { id: 'free', name: 'Free' }, ends: null, features: {}, unlimited: false, plans: PLANS };
const PRO = { plan: { id: 'pro', name: 'Pro' }, ends: '2027-01-15T00:00:00.000Z', features: {}, unlimited: false, plans: PLANS };
const PRODUCTS = {
  provider: 'remote', founder: true,
  products: [
    { key: 'pro-monthly', plan: 'pro', kind: 'subscription', days: null, for: 'user', name: null, founder_price: false },
    { key: 'pro-yearly', plan: 'pro', kind: 'subscription', days: null, for: 'user', name: null, founder_price: true },
    { key: 'team-yearly', plan: 'pro', kind: 'subscription', days: null, for: 'organization', name: null, founder_price: false },
  ],
};
const BILLING_ON = { app: { id: 'demo', modules: { billing: true, mcp: false } } };

const settle = () => new Promise((done) => setTimeout(done, 0));
const toasts = () => document.body.all().filter((node) => /\bkit-toast\b/.test(node.className) && node.parentNode);
const lastToast = () => toasts().at(-1);
const textOf = (node) => node?.textContent ?? '';
const click = (node) => node.dispatch('click');

/** Settings opened at its plan section, with what the stand-in answers. */
async function planPage(plan, { config = BILLING_ON, server = {}, start = 'plan' } = {}) {
  routes = server;
  asked = [];
  const root = document.createElement('div');
  const settings = openSettings({ app: { id: 'demo', name: 'Demo' }, user: { username: 'ada', role: 'user' }, config, root, plan, start });
  await settle();
  await settle();
  const page = root.all().find((node) => node.className === 'kit-settings__page');
  const visible = (node) => {
    for (let at = node; at && at !== page; at = at.parentNode) if (at.hidden) return false;
    return true;
  };
  const blocks = () => page.all().filter((node) => node.tagName === 'SECTION' && visible(node));
  const buttons = (text) => page.all().filter((node) => node.tagName === 'BUTTON' && node.textContent === text && visible(node));
  return { root, page, settings, blocks, buttons, visible };
}

/* ------------------------------ what is sold ------------------------------ */

test('what is offered: products for one person above their plan, theirs again when it lapses, nothing without limits', () => {
  const [monthly, yearly, team] = PRODUCTS.products;
  assert.deepEqual(offerFor(FREE, PRODUCTS.products).map((p) => p.key), ['pro-monthly', 'pro-yearly'], 'a group’s are bought for the group');
  assert.deepEqual(offerFor({ ...PRO, ends: null }, PRODUCTS.products), [], 'Pro for good: nothing above it');
  assert.deepEqual(offerFor(PRO, [monthly, yearly]).map((p) => p.key), ['pro-monthly', 'pro-yearly'], 'Pro until a date: kept on');
  assert.deepEqual(offerFor({ ...FREE, unlimited: true }, PRODUCTS.products), [], 'whom no plan limits');
  assert.deepEqual(offerFor({ ...FREE, plans: [] }, [monthly]).map((p) => p.key), ['pro-monthly'], 'no order known: offered');
  assert.deepEqual(offerFor(null, [monthly]), []);
  assert.equal(team.for, 'organization');

  assert.deepEqual(productText(monthly, PLANS), { name: 'Pro', detail: 'Monthly subscription' });
  assert.deepEqual(productText(yearly, PLANS), { name: 'Pro', detail: 'Yearly subscription' });
  assert.deepEqual(productText({ key: 'pro', plan: 'pro', kind: 'subscription' }, PLANS).detail, 'Subscription');
  assert.deepEqual(productText({ key: 'pro-pass', plan: 'pro', kind: 'once', days: 30 }, PLANS).detail, 'One payment, for 30 days');
  assert.deepEqual(productText({ key: 'pro-lifetime', plan: 'pro', kind: 'once' }, PLANS).detail, 'One payment, for good');
  assert.equal(productText({ key: 'x-yearly', plan: 'pro', kind: 'subscription', name: 'kit.plan.title' }, PLANS).name, 'Plan',
    'its own name, a key of the catalogs');
  assert.equal(productText({ key: 'x', plan: 'family', kind: 'subscription', name: 'Family plus' }, []).name, 'Family plus', 'or the name itself');
  assert.equal(productText({ key: 'x', plan: 'family', kind: 'subscription' }, []).name, 'family', 'an unnamed plan: its id');
});

/* --------------------------- Settings, unchanged --------------------------- */

test('Settings without the option: the plan and until when, as always, and nothing asked of billing', async () => {
  for (const plan of [true, { render: (answer) => document.createElement('aside') }]) {
    const view = await planPage(plan, { server: { 'GET /api/me/entitlements': { data: PRO } } });
    assert.deepEqual(asked, ['GET /api/me/entitlements']);
    assert.equal(view.blocks().length, 1, 'one block');
    assert.match(textOf(view.page), /Your plan\s*Pro/);
    assert.match(textOf(view.page), /Until/);
    assert.equal(view.page.find('aside').length, plan === true ? 0 : 1, 'the app’s own block');
    view.settings.close();
  }
  // Asked for, but the server says it doesn't sell: the same.
  const off = await planPage({ billing: true }, { config: { app: { modules: { billing: false } } }, server: { 'GET /api/me/entitlements': { data: FREE } } });
  assert.deepEqual(asked, ['GET /api/me/entitlements']);
  off.settings.close();
  // A server without the payments' routes: only the plan shows.
  const gone = await planPage({ billing: true }, { config: {}, server: { 'GET /api/me/entitlements': { data: FREE } } });
  assert.deepEqual(asked.sort(), ['GET /api/billing/products', 'GET /api/billing/subscriptions', 'GET /api/me/entitlements']);
  assert.equal(gone.blocks().length, 1);
  gone.settings.close();
});

/* --------------------------- Upgrade and Manage --------------------------- */

test('Upgrade: the products with their names, the founder’s price marked, and the checkout followed', async () => {
  let sent = null;
  const view = await planPage({ billing: true }, {
    server: {
      'GET /api/me/entitlements': { data: FREE },
      'GET /api/billing/products': { data: PRODUCTS },
      'GET /api/billing/subscriptions': { data: { subscriptions: [] } },
      'POST /api/billing/checkout': (body) => { sent = body; return { data: { url: 'https://pay.example.com/checkout?x=1' } }; },
    },
  });
  const rows = view.page.all().filter((node) => node.className === 'kit-list__row' && view.visible(node));
  assert.deepEqual(rows.map((row) => row.find('strong')[0].textContent), ['Pro', 'Pro']);
  assert.deepEqual(rows.map((row) => row.find('small')[0].textContent), ['Monthly subscription', 'Yearly subscription']);
  assert.deepEqual(rows.map((row) => row.all().some((n) => n.textContent === 'Founder’s price' && /kit-badge/.test(n.className))), [false, true]);
  const upgrades = view.buttons('Upgrade');
  assert.equal(upgrades.length, 2);
  assert.match(upgrades[0].className, /kit-btn--primary/, 'one primary button');
  assert.doesNotMatch(upgrades[1].className, /kit-btn--primary/);
  assert.equal(view.buttons('Manage subscription').length, 0, 'nothing to manage before a payment');

  followed.length = 0;
  click(upgrades[1]);
  assert.equal(upgrades[1].getAttribute('disabled') !== null || upgrades[1].disabled, true, 'not pressed twice');
  await settle();
  assert.deepEqual(sent, { product: 'pro-yearly' }, 'only the product: the price is the server’s');
  assert.deepEqual(followed, ['https://pay.example.com/checkout?x=1']);
  assert.equal(storage.get('app.billing'), JSON.stringify(['free', null]), 'the plan from before, to tell the new one');
  view.settings.close();
});

test('Upgrade answered 409 already_subscribed: why, with Manage at hand, and the section read again', async () => {
  let reads = 0;
  const subscriptions = [];
  const view = await planPage({ billing: true }, {
    server: {
      'GET /api/me/entitlements': () => { reads++; return { data: FREE }; },
      'GET /api/billing/products': { data: PRODUCTS },
      'GET /api/billing/subscriptions': () => ({ data: { subscriptions } }),
      'POST /api/billing/checkout': { status: 409, data: { error: 'already_subscribed' } },
      'POST /api/billing/portal': { data: { url: 'https://pay.example.com/portal' } },
    },
  });
  storage.clear();
  subscriptions.push({ ref: 'sub_1', product: 'pro-monthly', status: 'active', period_end: '2026-11-12T00:00:00.000Z' });
  click(view.buttons('Upgrade')[0]);
  await settle();
  await settle();
  assert.equal(textOf(lastToast()).startsWith(english['errors.already_subscribed']), true);
  assert.equal(storage.has('app.billing'), false, 'no checkout: nothing kept');
  assert.equal(reads, 2, 'read again');
  await settle();
  assert.equal(view.buttons('Upgrade').length, 0, 'paying already: no second checkout');
  assert.equal(view.buttons('Manage subscription').length, 1);
  followed.length = 0;
  click(lastToast().find('button')[0]);
  await settle();
  assert.deepEqual(followed, ['https://pay.example.com/portal'], 'the notice’s button opens the portal');
  view.settings.close();
});

test('a subscription: its state and period, Manage first, a failed payment said; 404 no_customer takes Manage away', async () => {
  const view = await planPage({ billing: true }, {
    server: {
      'GET /api/me/entitlements': { data: PRO },
      'GET /api/billing/products': { data: PRODUCTS },
      'GET /api/billing/subscriptions': { data: { subscriptions: [
        { ref: 'sub_1', product: 'pro-yearly', status: 'past_due', period_end: '2027-01-12T00:00:00.000Z' },
        { ref: 'sub_0', product: 'pro-monthly', status: 'canceled', period_end: '2026-01-12T00:00:00.000Z' },
      ] } },
      'POST /api/billing/portal': { status: 404, data: { error: 'no_customer' } },
    },
  });
  const text = textOf(view.page);
  assert.match(text, /Subscription/);
  assert.match(text, /Payment pending/);
  assert.match(text, /Current period until/);
  assert.ok(!/Active/.test(text), 'what ended is not listed');
  assert.ok(view.page.all().some((n) => n.textContent === english['kit.plan.pastDue'] && view.visible(n)), 'what to do about it');
  assert.equal(view.buttons('Upgrade').length, 0);
  const [manage] = view.buttons('Manage subscription');
  assert.match(manage.className, /kit-btn--primary/);
  click(manage);
  await settle();
  assert.equal(textOf(lastToast()), english['errors.no_customer']);
  assert.equal(view.buttons('Manage subscription').length, 0, 'nothing to manage: the button goes');
  view.settings.close();
});

test('without a subscription now: past payments and invoices, last and quiet, where there were some or can be', async () => {
  const pass = { key: 'pro-pass', plan: 'pro', kind: 'once', days: 30, for: 'user', name: null, founder_price: false };
  const view = await planPage({ billing: true }, {
    server: {
      'GET /api/me/entitlements': { data: FREE },
      'GET /api/billing/products': { data: { ...PRODUCTS, founder: false, products: [...PRODUCTS.products, pass] } },
      'GET /api/billing/subscriptions': { data: { subscriptions: [] } },
      'POST /api/billing/portal': { data: { url: 'https://pay.example.com/portal' } },
    },
  });
  assert.equal(view.buttons('Manage subscription').length, 0);
  const [payments] = view.buttons('Payments and invoices');
  assert.doesNotMatch(payments.className, /kit-btn--primary/, 'quiet: Upgrade is the one');
  const shown = view.blocks();
  assert.ok(shown.indexOf(payments.parentNode.parentNode) > shown.findIndex((b) => /Upgrade/.test(b.textContent)), 'after what can be bought');
  assert.equal(view.page.all().filter((n) => /kit-badge/.test(n.className) && view.visible(n)).length, 0, 'no founder’s price for whoever isn’t one');
  followed.length = 0;
  click(payments);
  await settle();
  assert.deepEqual(followed, ['https://pay.example.com/portal']);
  view.settings.close();
  // A subscription that ended: its invoices too.
  const ended = await planPage({ billing: true }, {
    server: {
      'GET /api/me/entitlements': { data: FREE },
      'GET /api/billing/products': { data: PRODUCTS },
      'GET /api/billing/subscriptions': { data: { subscriptions: [{ ref: 'sub_0', product: 'pro-monthly', status: 'canceled', period_end: null }] } },
    },
  });
  assert.equal(ended.buttons('Payments and invoices').length, 1);
  assert.equal(ended.buttons('Upgrade').length, 2, 'and the offer again');
  ended.settings.close();
});

test('only the provider’s pages are followed', async () => {
  const view = await planPage({ billing: true }, {
    server: {
      'GET /api/me/entitlements': { data: FREE },
      'GET /api/billing/products': { data: PRODUCTS },
      'GET /api/billing/subscriptions': { data: { subscriptions: [] } },
      'POST /api/billing/checkout': { data: { url: 'javascript:alert(1)' } },
    },
  });
  followed.length = 0;
  click(view.buttons('Upgrade')[0]);
  await settle();
  assert.deepEqual(followed, []);
  assert.equal(textOf(lastToast()), english['errors.generic']);
  view.settings.close();
});

test('a native app’s web view (hideCheckout): what is paid for shows, and no way to the provider', async () => {
  const view = await planPage({ billing: true, hideCheckout: true }, {
    server: {
      'GET /api/me/entitlements': { data: FREE },
      'GET /api/billing/products': { data: PRODUCTS },
      'GET /api/billing/subscriptions': { data: { subscriptions: [{ ref: 'sub_1', product: 'pro-yearly', status: 'past_due', period_end: '2027-01-12T00:00:00.000Z' }] } },
    },
  });
  assert.match(textOf(view.page), /Payment pending/);
  assert.equal(view.buttons('Upgrade').length, 0);
  assert.equal(view.buttons('Manage subscription').length, 0);
  assert.ok(!view.page.all().some((n) => n.textContent === english['kit.plan.pastDue'] && view.visible(n)), 'no "from Manage subscription" without it');
  const shown = view.page.all().filter((n) => !n.children.length && view.visible(n)).map((n) => n.textContent);
  assert.ok(!shown.some((text) => /Founder|provider/.test(text)), 'no founder’s price, no word of the provider');
  view.settings.close();
});

/* --------------------------- anywhere in an app --------------------------- */

test('a 402 anywhere: why, in words, with a button to the plan; anything else is the app’s', () => {
  const before = toasts().length;
  assert.equal(offerPlan(new ApiError(409, 'already_subscribed')), false);
  assert.equal(offerPlan(new Error('x')), false);
  assert.equal(offerPlan(null), false);
  assert.equal(toasts().length, before, 'nothing said for them');
  assert.ok(isPlanError(new ApiError(402, 'seats_full', { seats: 3 })));

  let opened = 0;
  assert.equal(offerPlan(new ApiError(402, 'plan_limit', { feature: 'lists.max', limit: 3, current: 3, plan: 'free', plan_name: 'Free' }), { open: () => opened++ }), true);
  assert.equal(textOf(lastToast().find('span')[0]), 'Your plan (Free) allows 3, and you already have 3.');
  const action = lastToast().find('button')[0];
  assert.equal(action.textContent, 'See plans');
  click(action);
  assert.equal(opened, 1);
  assert.equal(offerPlan(new ApiError(402, 'plan_feature', { plan_name: 'Free' })), true);
  assert.equal(lastToast().find('button').length, 0, 'without `open`, the words alone');
});

test('in Settings that sells, a 402 met in another section offers the plan section; without the option, a notice as always', async () => {
  const server = {
    'GET /api/me/entitlements': { data: FREE },
    'GET /api/billing/products': { data: PRODUCTS },
    'GET /api/billing/subscriptions': { data: { subscriptions: [] } },
    'GET /api/me/apps': { data: { enabled: false, grants: [] } },
    'GET /api/me/tokens': { data: [] },
    'POST /api/me/tokens': { status: 402, data: { error: 'plan_feature', feature: 'mcp', plan: 'free', plan_name: 'Free' } },
  };
  for (const [plan, offered] of [[{ billing: true }, true], [true, false]]) {
    const view = await planPage(plan, { config: { app: { modules: { billing: true, mcp: true } } }, server, start: 'ai' });
    click(view.buttons(t('kit.ai.createToken'))[0]);
    await settle();
    assert.equal(textOf(lastToast().find('span')[0]), 'Your plan (Free) doesn’t include this.');
    assert.equal(lastToast().find('button').length, offered ? 1 : 0);
    if (offered) {
      click(lastToast().find('button')[0]);
      await settle();
      assert.equal(view.page.find('h2')[0].textContent, 'Plan', 'the plan section opens');
    }
    view.settings.close();
  }
});

/* ----------------------------- back from paying ----------------------------- */

test('back from the checkout: the mark leaves the address, thanks, and the plan is read until it changes', async () => {
  const replaced = [];
  globalThis.history = { state: null, replaceState: (state, title, url) => replaced.push(url) };
  globalThis.CustomEvent = class CustomEvent { constructor(type, { detail } = {}) { this.type = type; this.detail = detail; } };
  const heard = [];
  document.addEventListener(PLAN_EVENT, (event) => heard.push(event.detail.plan.id));

  globalThis.location.href = 'https://app.example.com/?x=1';
  assert.equal(billingReturn(), false, 'not a return');

  // The webhook comes after the person: free, free, then Pro.
  const answers = [FREE, FREE, PRO];
  routes = { 'GET /api/me/entitlements': () => ({ data: answers.shift() || PRO }) };
  storage.set('app.billing', JSON.stringify(['free', null]));
  globalThis.location.href = 'https://app.example.com/?billing=done&x=1#list';
  let opened = 0;
  const plans = [];
  const done = billingReturn({ onPlan: (answer) => plans.push(answer.plan.id), open: () => opened++, waits: [0, 0, 0, 0], wait: async () => {} });
  assert.ok(done);
  assert.deepEqual(replaced, ['/?x=1#list'], 'not again on a reload');
  assert.equal(textOf(lastToast().find('span')[0]), english['kit.plan.returned']);
  click(lastToast().find('button')[0]);
  assert.equal(opened, 1, 'a button to the plan');
  assert.equal((await done).plan.id, 'pro');
  assert.deepEqual(plans, ['free', 'pro'], 'told at once, and when it changed');
  assert.deepEqual(heard, ['free', 'pro'], 'an open Settings hears it too');
  assert.equal(textOf(lastToast()), 'Your plan is now Pro.');
  assert.equal(storage.has('app.billing'), false);

  // Never confirmed while it looked: said so, when the plan from before is known.
  routes = { 'GET /api/me/entitlements': { data: FREE } };
  storage.set('app.billing', JSON.stringify(['free', null]));
  globalThis.location.href = 'https://app.example.com/?billing=done';
  assert.equal(await billingReturn({ waits: [0, 0], wait: async () => {} }), null);
  assert.equal(textOf(lastToast()), english['kit.plan.notYet']);
  // Not known (another tab, private mode): no such claim, since it may have come before the first look.
  const count = toasts().length;
  globalThis.location.href = 'https://app.example.com/?billing=done';
  assert.equal(await billingReturn({ waits: [0, 0], wait: async () => {} }), null);
  assert.equal(toasts().length, count + 1, 'only the thanks');
});

test('an open Settings that sells paints the plan read again after the checkout', async () => {
  const view = await planPage({ billing: true }, {
    server: {
      'GET /api/me/entitlements': { data: FREE },
      'GET /api/billing/products': { data: PRODUCTS },
      'GET /api/billing/subscriptions': { data: { subscriptions: [] } },
    },
  });
  assert.match(textOf(view.page), /Your plan\s*Free/);
  routes['GET /api/billing/subscriptions'] = { data: { subscriptions: [{ ref: 'sub_1', product: 'pro-yearly', status: 'active', period_end: '2027-01-12T00:00:00.000Z' }] } };
  document.dispatchEvent(new globalThis.CustomEvent(PLAN_EVENT, { detail: PRO }));
  await settle();
  await settle();
  assert.match(textOf(view.page), /Your plan\s*Pro/);
  assert.equal(view.buttons('Upgrade').length, 0);
  assert.equal(view.buttons('Manage subscription').length, 1);
  view.settings.close();
  assert.equal((listeners[PLAN_EVENT] || []).length, 1, 'closed, it listens no more (the test’s own listener stays)');
});

test('the kit caches plan.js for offline use, and it fetches nothing at the site’s root', () => {
  const sw = fs.readFileSync(new URL('../web/sw-core.js', import.meta.url), 'utf8');
  assert.match(sw, /'\/suite\/settings\.js', '\/suite\/plan\.js'/);
  const code = fs.readFileSync(new URL('../web/plan.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /fetch\(|import\(['`]\//, 'everything through api.js, at the app’s base');
  assert.doesNotMatch(code, /\b(?:Cronum Work|Tasks|Projects|Next|Notes|Tracker|Paddle|Stripe)\b/, 'nothing of one app or provider');
});
