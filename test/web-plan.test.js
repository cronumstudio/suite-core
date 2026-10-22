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
  // A route may answer later (a promise), to put answers out of order.
  const answer = await (typeof route === 'function' ? route(body ? JSON.parse(body) : undefined) : route);
  const { status = 200, data = {} } = answer || { status: 404, data: { error: 'not_found' } };
  return { ok: status < 400, status, json: async () => data };
};

const { loadLanguage, t } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
const { openSettings } = await import('../web/settings.js');
const { productText, offerFor, isLive, offerPlan, isPlanError, billingReturn, PLAN_EVENT } = await import('../web/plan.js');
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
  assert.deepEqual(offerFor(FREE, PRODUCTS.products, []).map((p) => p.key), ['pro-monthly', 'pro-yearly'], 'a group’s are bought for the group');
  assert.deepEqual(offerFor({ ...PRO, ends: null }, PRODUCTS.products, []), [], 'Pro for good: nothing above it');
  assert.deepEqual(offerFor(PRO, [monthly, yearly], []).map((p) => p.key), ['pro-monthly', 'pro-yearly'], 'Pro until a date, from a pass: kept on');
  assert.deepEqual(offerFor({ ...FREE, unlimited: true }, PRODUCTS.products, []), [], 'whom no plan limits');
  assert.deepEqual(offerFor({ ...FREE, plans: [] }, [monthly], []).map((p) => p.key), ['pro-monthly'], 'no order known: offered');
  assert.deepEqual(offerFor(null, [monthly], []), []);
  assert.equal(team.for, 'organization');

  // The subscriptions decide first: a subscriber's plan lapses on a date too, its period's end.
  const pass = { key: 'pro-pass', plan: 'pro', kind: 'once', days: 30, for: 'user', name: null, founder_price: false };
  for (const status of ['active', 'trialing', 'past_due']) {
    assert.deepEqual(offerFor(PRO, [monthly, pass], [{ ref: 'sub_1', product: 'pro-monthly', status }]), [], `${status}: nothing, not even a pass`);
    assert.equal(isLive({ status }), true);
  }
  assert.deepEqual(offerFor(PRO, [monthly, pass], [{ ref: 'sub_0', product: 'pro-monthly', status: 'canceled' }]).map((p) => p.key),
    ['pro-monthly', 'pro-pass'], 'what ended holds nothing');
  assert.deepEqual(offerFor(PRO, [monthly, pass]), [], 'not known: nothing, rather than twice');
  assert.deepEqual(offerFor(FREE, [monthly], null), []);
  assert.equal(isLive(null), false);

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

/* -------------------------------- Your usage ------------------------------- */

const IN_HOST = { app: { id: 'demo', modules: { billing: true, mcp: false }, host: { id: 'work', name: 'Work', mount: 'demo', base: '/demo/', plans: true } } };
const days = Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, used: i === 29 ? 3 : 0 }));
const MINE = {
  user_id: 7,
  modules: [
    { mount: 'tasks', name: 'Tasks', on: true, active_at: '2026-10-21T18:22:00.000Z', failed: false, bytes: 2048,
      counts: [{ id: 'lists', count: 17, feature: 'lists.max', limit: 20, share: 0.85 }, { id: 'tasks', count: 340, feature: null, limit: null, share: null }] },
    { mount: 'notes', name: 'Notes', on: false, active_at: null, failed: false, counts: [{ id: 'notes', count: 4, feature: null, limit: null, share: null }], bytes: 0 },
    { mount: 'next', name: 'Next', on: true, active_at: null, failed: true, counts: [] },
  ],
  storage: { bytes: 2048, files: 1, limit_mb: 50, share: 0.00004 },
  mcp: { limit: 50, today: 3, share: 0.06, days, total: 3 },
  peak: { share: 0.85, mount: 'tasks', name: 'Tasks', id: 'lists' },
};

test('Your usage, in a host: under the plan, the modules in use against their caps, the storage and the calls; near a cap, said first with the way to the plans', async () => {
  const view = await planPage({ billing: true }, {
    config: IN_HOST,
    server: {
      'GET /api/me/entitlements': { data: FREE },
      'GET /api/me/usage': { data: MINE },
      'GET /api/billing/products': { data: PRODUCTS },
      'GET /api/billing/subscriptions': { data: { subscriptions: [] } },
    },
  });
  await settle();
  assert.ok(asked.includes('GET /api/me/usage'), 'at the host’s root');
  const blocks = view.blocks();
  const usage = blocks.find((b) => b.find('h3')[0]?.textContent === t('kit.usage.title'));
  assert.ok(usage, 'the block');
  assert.equal(blocks.indexOf(usage), 1, 'right under the plan, before what can be bought');
  const text = textOf(usage);
  assert.match(text, /Lists17 of 20 · 85\s?%/);
  assert.match(text, /Tasks340/, 'a count without a limit, alone');
  assert.doesNotMatch(text, /Notes/, 'only the modules they use');
  assert.match(text, new RegExp(t('kit.usage.failed')), 'a module that couldn’t count says so, to them');
  assert.match(text, /2 kB of 50 MB/);
  assert.match(text, /Today3 of 50 · 6\s?%/);
  assert.doesNotMatch(text, /Last change/, 'the admin’s detail stays the admin’s');
  const meters = usage.all().filter((n) => n.getAttribute('role') === 'meter');
  assert.deepEqual(meters.map((m) => m.getAttribute('aria-valuenow')), ['85', '6'], 'the storage is its own bar');

  // The storage as a phone shows it: a part for each module that keeps something, and the room left.
  const parts = usage.all().filter((n) => n.getAttribute('class') === 'kit-storage__part');
  assert.deepEqual(parts.map((n) => [n.getAttribute('data-module'), n.getAttribute('title')]), [['tasks', 'Tasks: 2 kB']]);
  const legend = usage.all().find((n) => n.getAttribute('class') === 'kit-storage__legend');
  assert.deepEqual(legend.find('li').map(textOf), ['Tasks2 kB', `${t('kit.usage.free')}50 MB`], 'each part named with its size, not by colour alone');

  const alert = usage.all().find((n) => /kit-usage__alert--near/.test(n.className || ''));
  assert.ok(alert, 'near a cap, said first');
  assert.equal(textOf(alert.find('p')[0]), t('kit.usage.nearNotice'));
  const capped = alert.all().filter((n) => n.getAttribute('data-level'));
  assert.deepEqual(capped.map((n) => [textOf(n), n.getAttribute('data-level')]), [['17 lists', 'near']], 'what is near, as they count it, without the module');
  const see = view.buttons(t('kit.plan.see'));
  assert.equal(see.length, 1, 'with the way to the plans on offer');
  let scrolled = 0;
  const offer = blocks.find((b) => /Upgrade/.test(textOf(b.find('h3')[0])));
  offer.scrollIntoView = () => { scrolled++; };
  click(see[0]);
  assert.equal(scrolled, 1);
  view.settings.close();
});

test('Your usage: at a cap with nothing more to buy, no way to it; without limits, numbers and no bars; nowhere to ask, no block', async () => {
  // Nothing more to buy: no button; the notice stays.
  const top = await planPage({ billing: true }, {
    config: IN_HOST,
    server: {
      'GET /api/me/entitlements': { data: PRO },
      'GET /api/me/usage': { data: { ...MINE, mcp: { ...MINE.mcp, today: 50, share: 1 }, peak: { share: 1, id: 'mcp' } } },
      'GET /api/billing/products': { data: { ...PRODUCTS, products: [] } },
      'GET /api/billing/subscriptions': { data: { subscriptions: [] } },
    },
  });
  await settle();
  const reached = top.page.all().find((n) => /kit-usage__alert--reached/.test(n.className || ''));
  assert.ok(reached && top.visible(reached));
  assert.equal(textOf(reached.find('p')[0]), t('kit.usage.reachedNotice'));
  assert.deepEqual(reached.all().filter((n) => n.getAttribute('data-level')).map((n) => [textOf(n), n.getAttribute('data-level')]),
    [['50 assistant calls today', 'reached'], ['17 lists', 'near']], 'the worst first, each in its own colour');
  assert.equal(top.buttons(t('kit.plan.see')).length, 0);
  top.settings.close();

  // No limits (the instance's administrator): what they keep, without a meter or a notice.
  const free = { ...MINE, modules: [{ ...MINE.modules[0], counts: [{ id: 'lists', count: 17, feature: 'lists.max', limit: null, share: null }] }],
    storage: { bytes: 2048, files: 1, limit_mb: null, share: null }, mcp: { limit: null, today: 3, share: null, days, total: 3 }, peak: null };
  const unlimited = await planPage(true, { config: IN_HOST, server: { 'GET /api/me/entitlements': { data: { ...PRO, unlimited: true } }, 'GET /api/me/usage': { data: free } } });
  await settle();
  const block = unlimited.blocks().find((b) => b.find('h3')[0]?.textContent === t('kit.usage.title'));
  assert.match(textOf(block), /Lists17/);
  assert.match(textOf(block), new RegExp(t('kit.usage.noDailyLimit')));
  assert.equal(block.all().filter((n) => n.getAttribute('role') === 'meter').length, 0);
  assert.equal(block.all().filter((n) => /kit-usage__alert/.test(n.className || '')).length, 0);
  unlimited.settings.close();

  // A host that doesn't answer (older, or offline): the block goes.
  const older = await planPage(true, { config: IN_HOST, server: { 'GET /api/me/entitlements': { data: FREE } } });
  await settle();
  assert.ok(asked.includes('GET /api/me/usage'));
  assert.ok(!older.blocks().some((b) => b.find('h3')[0]?.textContent === t('kit.usage.title')));
  older.settings.close();

  // An app on its own: nothing asked.
  const alone = await planPage(true, { server: { 'GET /api/me/entitlements': { data: FREE } } });
  assert.ok(!asked.includes('GET /api/me/usage'));
  assert.ok(!alone.page.all().some((n) => n.textContent === t('kit.usage.title')));
  alone.settings.close();
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
  assert.deepEqual(upgrades.map((b) => b.getAttribute('aria-label')), ['Upgrade: Pro (Monthly subscription)', 'Upgrade: Pro (Yearly subscription)'],
    'a name of its own for each, starting with what it shows');
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

test('after 404 no_customer, a subscription that appears (paid in another tab) brings Manage back', async () => {
  const subscriptions = [];
  const view = await planPage({ billing: true }, {
    server: {
      'GET /api/me/entitlements': { data: FREE },
      'GET /api/billing/products': { data: { ...PRODUCTS, products: [...PRODUCTS.products, { key: 'pro-pass', plan: 'pro', kind: 'once', days: 30, for: 'user' }] } },
      'GET /api/billing/subscriptions': () => ({ data: { subscriptions } }),
      'POST /api/billing/portal': { status: 404, data: { error: 'no_customer' } },
      'POST /api/billing/checkout': { status: 409, data: { error: 'already_subscribed' } },
    },
  });
  click(view.buttons('Payments and invoices')[0]);
  await settle();
  assert.equal(view.buttons('Payments and invoices').length, 0, 'nothing to manage yet');
  subscriptions.push({ ref: 'sub_1', product: 'pro-monthly', status: 'active', period_end: '2026-11-12T00:00:00.000Z' });
  click(view.buttons('Upgrade')[0]);
  await settle();
  await settle();
  await settle();
  assert.match(textOf(view.page), /Active/);
  assert.equal(view.buttons('Manage subscription').length, 1, 'a subscription now: there is a customer');
  view.settings.close();
});

test('the subscriptions unknown (the server didn’t answer): nothing offered, rather than a second payment', async () => {
  const pass = { key: 'pro-pass', plan: 'pro', kind: 'once', days: 30, for: 'user', name: null, founder_price: false };
  for (const answer of [PRO, FREE]) {
    const view = await planPage({ billing: true }, {
      server: {
        'GET /api/me/entitlements': { data: answer },
        'GET /api/billing/products': { data: { ...PRODUCTS, products: [...PRODUCTS.products, pass] } },
        'GET /api/billing/subscriptions': { status: 500, data: { error: 'internal' } },
      },
    });
    assert.equal(view.buttons('Upgrade').length, 0, answer.plan.id);
    assert.match(textOf(view.page), new RegExp(`Your plan\\s*${answer.plan.name}`), 'the plan still shows');
    view.settings.close();
  }
});

test('"Until" beside a live subscription that holds the plan is its period, shown there; a pass keeps it', async () => {
  const until = (view) => view.page.all().filter((n) => n.className === 'kit-plan-card__until' && /^Until/.test(n.textContent) && view.visible(n)).length;
  const server = (subscriptions) => ({
    'GET /api/me/entitlements': { data: PRO },
    'GET /api/billing/products': { data: PRODUCTS },
    'GET /api/billing/subscriptions': { data: { subscriptions } },
  });
  const live = [{ ref: 'sub_1', product: 'pro-yearly', status: 'active', period_end: '2027-01-12T00:00:00.000Z' }];
  const held = await planPage({ billing: true }, { server: server(live) });
  assert.equal(until(held), 0, 'not the grace after the period');
  assert.match(textOf(held.page), /Current period until/);
  held.settings.close();
  const passed = await planPage({ billing: true }, { server: server([{ ref: 'sub_0', product: 'pro-monthly', status: 'canceled', period_end: null }]) });
  assert.equal(until(passed), 1, 'no live subscription: the plan’s own end');
  passed.settings.close();
  const native = await planPage({ billing: true, hideCheckout: true }, { server: server(live) });
  assert.equal(until(native), 0, 'the same in a native app’s web view');
  native.settings.close();
  const plain = await planPage(true, { server: server(live) });
  assert.equal(until(plain), 1, 'without the option, as always');
  plain.settings.close();
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

test('a native app’s web view: a 402 met in Settings offers the app’s own way to buy (plan.open), or only says why', async () => {
  const server = {
    'GET /api/me/entitlements': { data: FREE },
    'GET /api/billing/products': { data: PRODUCTS },
    'GET /api/billing/subscriptions': { data: { subscriptions: [] } },
    'GET /api/me/apps': { data: { enabled: false, grants: [] } },
    'GET /api/me/tokens': { data: [] },
    'POST /api/me/tokens': { status: 402, data: { error: 'plan_feature', feature: 'mcp', plan: 'free', plan_name: 'Free' } },
  };
  const config = { app: { modules: { billing: true, mcp: true } } };
  const bare = await planPage({ billing: true, hideCheckout: true }, { config, server, start: 'ai' });
  click(bare.buttons(t('kit.ai.createToken'))[0]);
  await settle();
  assert.equal(textOf(lastToast().find('span')[0]), 'Your plan (Free) doesn’t include this.');
  assert.equal(lastToast().find('button').length, 0, 'no “See plans” to a section with nothing to buy');
  bare.settings.close();

  let opened = 0;
  const own = await planPage({ billing: true, hideCheckout: true, open: () => opened++ }, { config, server, start: 'ai' });
  click(own.buttons(t('kit.ai.createToken'))[0]);
  await settle();
  const [action] = lastToast().find('button');
  assert.equal(action.textContent, 'See plans');
  click(action);
  await settle();
  assert.equal(opened, 1, 'the app’s own way, a store’s');
  assert.notEqual(own.page.find('h2')[0].textContent, 'Plan', 'Settings stays where it was');
  own.settings.close();
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

test('back from a checkout left unpaid (?billing=canceled): a tidy address, a plain word, nothing read', async () => {
  const replaced = [];
  globalThis.history = { state: null, replaceState: (state, title, url) => replaced.push(url) };
  routes = {};
  asked = [];
  storage.set('app.billing', JSON.stringify(['free', null]));
  globalThis.location.href = 'https://app.example.com/?billing=canceled#list';
  let opened = 0;
  const done = billingReturn({ onPlan: () => assert.fail('no plan to tell'), open: () => opened++, waits: [0], wait: async () => {} });
  assert.ok(done, 'a return');
  assert.equal(await done, null);
  assert.deepEqual(replaced, ['/#list']);
  assert.equal(storage.has('app.billing'), false, 'the plan from before goes with it');
  assert.equal(textOf(lastToast().find('span')[0]), english['kit.plan.canceled']);
  click(lastToast().find('button')[0]);
  assert.equal(opened, 1, 'the plans at hand, to try again');
  assert.deepEqual(asked, [], 'nothing asked of the server');
  globalThis.location.href = 'https://app.example.com/?billing=other';
  assert.equal(billingReturn(), false);
});

test('a plan read before the one from the checkout arrives late: the newer stays', async () => {
  let late = null;
  const view = await planPage({ billing: true }, {
    server: {
      'GET /api/me/entitlements': { data: FREE },
      'GET /api/billing/products': { data: PRODUCTS },
      'GET /api/billing/subscriptions': { data: { subscriptions: [] } },
      'POST /api/billing/checkout': { status: 409, data: { error: 'already_subscribed' } },
    },
  });
  // A read that takes its time (a 409's refresh), then the plan from billingReturn.
  routes['GET /api/me/entitlements'] = () => new Promise((resolve) => { late = resolve; });
  click(view.buttons('Upgrade')[0]);
  await settle();
  await settle();
  assert.ok(late, 'reading');
  routes['GET /api/billing/subscriptions'] = { data: { subscriptions: [{ ref: 'sub_1', product: 'pro-yearly', status: 'active', period_end: '2027-01-12T00:00:00.000Z' }] } };
  document.dispatchEvent(new globalThis.CustomEvent(PLAN_EVENT, { detail: PRO }));
  await settle();
  await settle();
  late({ data: FREE });
  await settle();
  await settle();
  await settle();
  assert.match(textOf(view.page), /Your plan\s*Pro/, 'not painted over by the older answer');
  assert.equal(view.buttons('Upgrade').length, 0);
  assert.equal(view.buttons('Manage subscription').length, 1);
  view.settings.close();
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
  assert.match(sw, /'\/suite\/settings\.js', '\/suite\/plan\.js', '\/suite\/usage-view\.js'/);
  const code = fs.readFileSync(new URL('../web/plan.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /fetch\(|import\(['`]\//, 'everything through api.js, at the app’s base');
  assert.doesNotMatch(code, /\b(?:Cronum Work|Tasks|Projects|Next|Notes|Tracker|Paddle|Stripe)\b/, 'nothing of one app or provider');
});
