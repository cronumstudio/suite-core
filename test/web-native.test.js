/**
 * The kit's bridge to the suite's app on a phone (web/native.js), without a phone: knowing it runs
 * there, the messages it sends as the app reads them, the app's messages it hears and the ones it
 * ignores, and Settings inside the app (the web's checkout never, its store where it sells, its
 * notices instead of Web Push). Outside the app every page is as before: the same Settings ask
 * the same things.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom, FakeElement, FakeEventTarget } from './fake-dom.js';

const document = installFakeDom();
FakeElement.prototype.focus = function focus() {};
const listeners = {};
Object.assign(document, {
  addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
  dispatchEvent: (event) => { for (const fn of [...(listeners[event.type] || [])]) fn(event); return true; },
});
globalThis.CustomEvent ??= class CustomEvent {
  constructor(type, { detail = null } = {}) { this.type = type; this.detail = detail; }
};

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const IN_APP = `${IPHONE} CronumWorkApp/1.2.0`;

/** A page's window: its address, its browser, what the app injected, and what it was sent. */
function fakeWindow({ userAgent = IPHONE, native = undefined, bridge = true, href = 'https://work.example.com/tasks/' } = {}) {
  const win = new FakeEventTarget();
  const url = new URL(href);
  win.sent = [];
  win.location = { href, origin: url.origin, assign: () => {} };
  win.navigator = { userAgent };
  win.top = win;
  win.self = win;
  if (native !== undefined) win.CronumNative = native;
  if (bridge) win.ReactNativeWebView = { postMessage: (text) => win.sent.push(JSON.parse(text)) };
  win.tell = (detail) => win.dispatch('cronum-native', { detail });
  return win;
}

// The page the kit loads in is the app's, with everything it can do: Settings and the kit's own
// listener read it from here. Each test of Settings says what the app gives, and outside it.
const page = fakeWindow({ userAgent: IN_APP, native: { v: 1, platform: 'ios', version: '1.2.0', capabilities: ['push', 'purchase', 'badge', 'reminders'] } });
globalThis.window = page;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: page.navigator });
globalThis.location = page.location;
const storage = new Map();
globalThis.sessionStorage = globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
/** As the app is, or as a browser: its capabilities, or none of it. */
function asApp(capabilities) {
  page.navigator.userAgent = capabilities ? IN_APP : IPHONE;
  if (capabilities) page.CronumNative = { v: 1, platform: 'ios', version: '1.2.0', capabilities };
  else delete page.CronumNative;
  page.sent.length = 0;
}

const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
let routes = {};
let asked = [];
globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
  const path = String(url);
  if (path.startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
  asked.push(`${method} ${path}`);
  const route = routes[`${method} ${path}`];
  const answer = await (typeof route === 'function' ? route(body ? JSON.parse(body) : undefined) : route);
  const { status = 200, data = {} } = answer || { status: 404, data: { error: 'not_found' } };
  return { ok: status < 400, status, json: async () => data };
};

const native = await import('../web/native.js');
const { inApp, nativeInfo, can, postNative, onNative, messageOf, setBadge, setReminders, nativePurchase, openExternal,
  nativeSignOut, haptic, openAppSettings, nativeReady, lastNative, NATIVE_EVENT, MAX_REMINDERS } = native;
const { loadLanguage, t } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
const { openSettings, subscribePush } = await import('../web/settings.js');
const { storePurchase, PLAN_EVENT } = await import('../web/plan.js');
const { pushSupport } = await import('../web/push.js');

const PLANS = [{ id: 'free', name: 'Free' }, { id: 'pro', name: 'Pro' }];
const FREE = { plan: { id: 'free', name: 'Free' }, ends: null, features: {}, unlimited: false, plans: PLANS };
const PRO = { plan: { id: 'pro', name: 'Pro' }, ends: null, features: {}, unlimited: false, plans: PLANS };
const PRODUCTS = {
  provider: 'remote', founder: true,
  products: [{ key: 'pro-monthly', plan: 'pro', kind: 'subscription', days: null, for: 'user', name: null, founder_price: true }],
};
const BILLING_ON = { app: { id: 'demo', modules: { billing: true, mcp: true } } };

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((done) => setTimeout(done, 0)); };
const toasts = () => document.body.all().filter((node) => /\bkit-toast\b/.test(node.className) && node.parentNode);
const lastToast = () => toasts().at(-1);
const textOf = (node) => node?.textContent ?? '';
const click = (node) => node.dispatch('click');

async function settingsPage(options, { config = BILLING_ON, server = {}, start } = {}) {
  routes = server;
  asked = [];
  const root = document.createElement('div');
  const settings = openSettings({ app: { id: 'demo', name: 'Demo' }, user: { username: 'ada', role: 'user' }, config, root, start, ...options });
  await settle();
  const body = root.all().find((node) => node.className === 'kit-settings__page');
  const visible = (node) => {
    for (let at = node; at && at !== body; at = at.parentNode) if (at.hidden) return false;
    return true;
  };
  const buttons = (text) => body.all().filter((node) => node.tagName === 'BUTTON' && node.textContent === text && visible(node));
  const shown = () => body.all().filter((n) => !n.children.length && visible(n)).map((n) => n.textContent).join('\n');
  return { root, body, settings, buttons, shown, visible };
}

/* -------------------------------- knowing it -------------------------------- */

test('in the app by its user agent or by what it injected; elsewhere nothing, whatever else the page has', () => {
  assert.equal(inApp(null), false, 'no window: not a page');
  const browser = fakeWindow({ userAgent: ANDROID });
  assert.equal(inApp(browser), false, 'a browser, even one with a React Native bridge of someone else’s');
  assert.equal(nativeInfo(browser), null);
  assert.equal(can('push', browser), false);
  assert.equal(postNative('badge', { count: 1 }, browser), false);
  assert.equal(setBadge(1, browser), false);
  assert.equal(nativeReady(browser), false);
  assert.deepEqual(browser.sent, [], 'nothing sent outside the app');
  let heard = 0;
  onNative('push-state', () => heard++, browser)();
  assert.equal(browser.listenerCount(), 0, 'nothing listened to outside the app');
  assert.equal(heard, 0);

  const byAgent = fakeWindow({ userAgent: `${ANDROID} CronumWorkApp/0.1.0` });
  assert.equal(inApp(byAgent), true);
  assert.deepEqual(nativeInfo(byAgent), { v: 1, platform: 'android', version: '0.1.0', capabilities: [] },
    'from the user agent alone: no capabilities');
  assert.equal(can('push', byAgent), false);

  const injected = fakeWindow({ userAgent: IPHONE, native: { v: 1, platform: 'ios', version: '1.3.0', capabilities: ['push', 'share', 7, null] } });
  assert.equal(inApp(injected), true, 'what the app injected is enough');
  const info = nativeInfo(injected);
  assert.deepEqual(info, { v: 1, platform: 'ios', version: '1.3.0', capabilities: ['push', 'share'] });
  assert.ok(Object.isFrozen(info) && Object.isFrozen(info.capabilities), 'nobody changes what the app said');
  assert.equal(can('push', injected), true);
  assert.equal(can('purchase', injected), false);
  assert.equal(inApp(fakeWindow({ userAgent: IPHONE, native: 'yes' })), false, 'only an object counts');
});

test('a frame of the split view uses its parent’s bridge, on the same site only', () => {
  const top = fakeWindow({ userAgent: IN_APP, native: { v: 1, platform: 'ios', version: '1.2.0', capabilities: ['badge'] } });
  const frame = fakeWindow({ userAgent: IN_APP, bridge: false });
  frame.top = top;
  assert.equal(can('badge', frame), true, 'what its parent was given');
  assert.equal(setBadge(4, frame), true);
  assert.deepEqual(top.sent, [{ v: 1, type: 'badge', count: 4 }]);

  const elsewhere = fakeWindow({ userAgent: IN_APP, bridge: false });
  elsewhere.top = { get location() { throw new Error('another site'); } };
  assert.equal(postNative('ready', {}, elsewhere), false, 'no bridge of its own, none of another site’s');
});

/* ------------------------------ what it sends ------------------------------ */

test('every message is { v: 1, type, …payload }, its payload checked, and the payload never changes v or type', () => {
  const win = fakeWindow({ userAgent: IN_APP, native: { v: 1, platform: 'ios', version: '1.2.0', capabilities: ['badge', 'reminders', 'purchase'] } });
  assert.equal(postNative('some-later-message', { a: 1, v: 9, type: 'badge' }, win), true);
  assert.equal(postNative('', {}, win), false);
  assert.equal(setBadge(3.4, win), true);
  setBadge(-2, win);
  setBadge('lots', win);
  assert.equal(nativePurchase('pro-yearly', win), true);
  nativePurchase(undefined, win);
  assert.equal(openExternal('https://example.org/help?x=1', win), true);
  assert.equal(openExternal('mailto:hello@example.org', win), true);
  assert.equal(openExternal('javascript:alert(1)', win), false, 'only what the app may open outside');
  assert.equal(openExternal('/tasks/', win), true, 'a path is this site’s address');
  assert.equal(nativeSignOut(win), true);
  assert.equal(haptic('success', win), true);
  assert.equal(haptic('earthquake', win), false);
  assert.equal(openAppSettings(win), true);
  assert.deepEqual(win.sent, [
    { v: 1, type: 'some-later-message', a: 1 },
    { v: 1, type: 'badge', count: 3 },
    { v: 1, type: 'badge', count: 0 },
    { v: 1, type: 'badge', count: 0 },
    { v: 1, type: 'purchase', product: 'pro-yearly' },
    { v: 1, type: 'purchase', product: null },
    { v: 1, type: 'open-external', url: 'https://example.org/help?x=1' },
    { v: 1, type: 'open-external', url: 'mailto:hello@example.org' },
    { v: 1, type: 'open-external', url: 'https://work.example.com/tasks/' },
    { v: 1, type: 'sign-out' },
    { v: 1, type: 'haptic', style: 'success' },
    { v: 1, type: 'open-app-settings' },
  ]);

  const without = fakeWindow({ userAgent: IN_APP, native: { v: 1, platform: 'ios', version: '1.0.0', capabilities: [] } });
  assert.equal(setBadge(2, without), false, 'an app without the badge');
  assert.equal(setReminders([], without), false);
  assert.equal(nativePurchase(null, without), false);
  assert.deepEqual(without.sent, []);
  assert.equal(postNative('ready', {}, fakeWindow({ userAgent: IN_APP, bridge: false })), false, 'an app whose web view has no bridge');
});

test('reminders: the full set, soonest first, in UTC, with paths of this site; the rest left out', () => {
  const win = fakeWindow({ userAgent: IN_APP, native: { v: 1, platform: 'android', version: '1.2.0', capabilities: ['reminders'] } });
  setReminders([
    { id: 12, module: 'tasks', title: '  Call Ada ', at: '2026-10-21T09:30:00+02:00', url: '/tasks/?task=12' },
    { id: 'a', module: 'tasks', title: 'Earlier', at: new Date('2026-10-21T06:00:00Z'), url: 'https://work.example.com/tasks/#a' },
    { id: 'b', module: 'tasks', title: 'Elsewhere', at: '2026-10-21T06:00:00Z', url: 'https://evil.example/' },
    { id: 'c', module: 'tasks', title: '', at: '2026-10-21T06:00:00Z' },
    { id: 'd', module: 'tasks', title: 'No time', at: 'soon' },
    { module: 'tasks', title: 'No id', at: '2026-10-21T06:00:00Z' },
    { id: 'e', title: 'No address', at: '2026-10-22T06:00:00Z' },
    null,
  ], win);
  assert.deepEqual(win.sent, [{ v: 1, type: 'reminders', items: [
    { id: 'a', module: 'tasks', title: 'Earlier', at: '2026-10-21T06:00:00.000Z', url: '/tasks/#a' },
    { id: '12', module: 'tasks', title: 'Call Ada', at: '2026-10-21T07:30:00.000Z', url: '/tasks/?task=12' },
    { id: 'e', module: null, title: 'No address', at: '2026-10-22T06:00:00.000Z', url: null },
  ] }]);

  win.sent.length = 0;
  setReminders('not a list', win);
  const many = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, module: 'tasks', title: `R${i}`, at: new Date(Date.UTC(2026, 10, 1) - i * 60000) }));
  setReminders(many, win);
  assert.deepEqual(win.sent[0].items, [], 'an empty set clears them');
  assert.equal(win.sent[1].items.length, MAX_REMINDERS);
  assert.equal(win.sent[1].items[0].id, 'r99', 'the soonest');
});

test('ready: once a page, and the frame the kit draws says it', async () => {
  const { createShell } = await import('../web/shell.js');
  asApp(['push']);
  const shell = createShell({ app: { id: 'demo', name: 'Demo' }, root: document.createElement('div') });
  const again = createShell({ app: { id: 'demo', name: 'Demo' }, root: document.createElement('div') });
  assert.deepEqual(page.sent, [{ v: 1, type: 'ready' }], 'once, however many frames');
  assert.equal(nativeReady(), false);
  shell.destroy();
  again.destroy();
});

/* ------------------------------ what it hears ------------------------------ */

test('the app’s messages: each type to its listeners; another type, version or shape ignored', () => {
  const win = fakeWindow({ userAgent: IN_APP });
  const heard = [];
  const stop = onNative('push-state', (detail) => heard.push(detail), win);
  win.tell({ v: 1, type: 'push-state', state: 'granted' });
  win.tell(JSON.stringify({ v: 1, type: 'push-state', state: 'denied' }));
  win.tell({ v: 1, type: 'something-new', state: 'x' });
  win.tell({ v: 2, type: 'push-state', state: 'other' });
  win.tell({ type: 'push-state', state: 'unversioned' });
  win.tell('not json');
  win.tell(null);
  win.tell([1, 2]);
  assert.deepEqual(heard, [{ v: 1, type: 'push-state', state: 'granted' }, { v: 1, type: 'push-state', state: 'denied' }]);
  stop();
  win.tell({ v: 1, type: 'push-state', state: 'granted' });
  assert.equal(heard.length, 2, 'stopped');
  assert.equal(win.listenerCount(), 0);
  assert.equal(messageOf({ v: 1, type: '' }), null);
  assert.equal(NATIVE_EVENT, 'cronum-native');

  // The page's last word of each kind is kept from the start: Settings opens later.
  page.tell({ v: 1, type: 'push-state', state: 'denied' });
  page.tell({ v: 1, type: 'unknown-thing' });
  assert.deepEqual(lastNative('push-state'), { v: 1, type: 'push-state', state: 'denied' });
  page.tell({ v: 1, type: 'push-state', state: 'granted' });
  assert.equal(lastNative('push-state').state, 'granted');
});

/* --------------------------------- Settings -------------------------------- */

const planServer = (answer = FREE) => ({
  'GET /api/me/entitlements': { data: answer },
  'GET /api/billing/products': { data: PRODUCTS },
  'GET /api/billing/subscriptions': { data: { subscriptions: [] } },
  'GET /api/me/apps': { data: { enabled: false, grants: [] } },
  'GET /api/me/tokens': { data: [] },
  'POST /api/me/tokens': { status: 402, data: { error: 'plan_feature', feature: 'mcp', plan: 'free', plan_name: 'Free' } },
});

test('outside the app Settings sell as always: the web’s products and Upgrade, Web Push offered', async () => {
  asApp(null);
  const plan = await settingsPage({ plan: { billing: true } }, { server: planServer(), start: 'plan' });
  assert.equal(plan.buttons('Upgrade').length, 1);
  assert.match(plan.shown(), /Founder/);
  assert.equal(plan.buttons(t('kit.plan.see')).length, 0);
  plan.settings.close();

  const notices = await settingsPage({ push: true }, { server: { 'GET /api/push/devices': { data: [] } }, start: 'notifications' });
  assert.equal(notices.buttons(t('kit.notifications.enable')).length, 1);
  assert.equal(notices.buttons(t('kit.notifications.appSettings')).length, 0);
  notices.settings.close();
  assert.deepEqual(page.sent, []);
});

test('in the app: never the web’s checkout, whatever the module passed; its store where it sells', async () => {
  asApp(['purchase']);
  const view = await settingsPage({ plan: { billing: true } }, { server: planServer(), start: 'plan' });
  assert.equal(view.buttons('Upgrade').length, 0, 'no web product');
  assert.equal(view.buttons('Manage subscription').length, 0);
  assert.doesNotMatch(view.shown(), /Founder|provider/);
  assert.match(view.shown(), /App Store or Google Play/);
  const [see] = view.buttons(t('kit.plan.see'));
  click(see);
  await settle();
  assert.deepEqual(page.sent, [{ v: 1, type: 'purchase', product: null }]);

  // Bought: the plan is read again and Settings shows it, with thanks.
  routes['GET /api/me/entitlements'] = { data: PRO };
  page.tell({ v: 1, type: 'purchase-result', product: 'pro-monthly', status: 'purchased' });
  await settle();
  assert.equal(textOf(lastToast().find('span')[0]) || textOf(lastToast()), english['kit.plan.returned']);
  assert.match(view.shown(), /Your plan\s*\n?Pro/);
  assert.equal(view.buttons(t('kit.plan.see')).length, 0, 'nothing above Pro to go to');
  view.settings.close();

  // A 402 met in Settings offers the store.
  page.sent.length = 0;
  const ai = await settingsPage({ plan: { billing: true } }, { server: planServer(), start: 'ai' });
  click(ai.buttons(t('kit.ai.createToken'))[0]);
  await settle();
  const [action] = lastToast().find('button');
  assert.equal(action.textContent, 'See plans');
  click(action);
  assert.deepEqual(page.sent, [{ v: 1, type: 'purchase', product: null }]);
  ai.settings.close();
  page.tell({ v: 1, type: 'purchase-result', product: null, status: 'canceled' });
  await settle();
  assert.match(textOf(lastToast()), /nothing was charged/);
});

test('in a host, the app’s store comes with the host’s plan, without the module asking', async () => {
  asApp(['purchase']);
  const config = { app: { id: 'tasks', modules: { billing: true, mcp: false }, host: { id: 'work', name: 'Cronum Work', mount: 'tasks', plans: true } } };
  routes = { 'GET /api/modules': { data: { modules: [] } } };
  const view = await settingsPage({}, { config, server: { ...planServer(), 'GET /api/modules': { data: { modules: [] } } }, start: 'plan' });
  assert.equal(view.buttons(t('kit.plan.see')).length, 1);
  view.settings.close();
});

test('in an app that doesn’t sell: the plan, and a 402 says only why', async () => {
  asApp([]);
  const view = await settingsPage({ plan: { billing: true } }, { server: planServer(), start: 'plan' });
  assert.equal(view.buttons('Upgrade').length, 0);
  assert.equal(view.buttons(t('kit.plan.see')).length, 0);
  view.settings.close();
  const ai = await settingsPage({ plan: { billing: true, open: () => assert.fail('not the web’s way') } }, { server: planServer(), start: 'ai' });
  click(ai.buttons(t('kit.ai.createToken'))[0]);
  await settle();
  assert.equal(lastToast().find('button').length, 0, 'only the reason');
  ai.settings.close();
  assert.deepEqual(page.sent, []);
  assert.equal(await storePurchase('pro-monthly'), null, 'nothing sent, nothing waited for');
});

test('a purchase waits for its answer; a second takes its place, and every outcome is said', async () => {
  asApp(['purchase']);
  routes = { 'GET /api/me/entitlements': { data: PRO } };
  const repainted = [];
  document.addEventListener(PLAN_EVENT, (event) => repainted.push(event.detail));
  const first = storePurchase('pro-monthly');
  const second = storePurchase('pro-yearly');
  assert.equal(await first, null, 'replaced');
  page.tell({ v: 1, type: 'purchase-result', product: 'pro-yearly', status: 'pending' });
  assert.deepEqual(await second, { v: 1, type: 'purchase-result', product: 'pro-yearly', status: 'pending' });
  assert.match(textOf(lastToast()), /waiting for approval/);
  const third = storePurchase();
  page.tell({ v: 1, type: 'purchase-result', product: null, status: 'failed' });
  await third;
  assert.match(textOf(lastToast()), /couldn’t be completed/);
  const fourth = storePurchase();
  page.tell({ v: 1, type: 'purchase-result', product: 'pro-monthly', status: 'purchased' });
  await fourth;
  await settle();
  assert.deepEqual(repainted, [PRO], 'the plan read again for whoever shows it');
  assert.deepEqual(page.sent.map((m) => m.product), ['pro-monthly', 'pro-yearly', null, null]);
});

test('notifications in the app: the app’s own, never Web Push', async () => {
  asApp(['push']);
  page.tell({ v: 1, type: 'push-state', state: 'denied' });
  let asked = 0;
  globalThis.Notification = { permission: 'default', requestPermission: async () => { asked++; return 'granted'; } };
  const server = { 'GET /api/push/devices': { data: [{ label: IPHONE, created_at: '2026-10-01T10:00:00Z' }] } };
  const view = await settingsPage({ push: true }, { server, start: 'notifications' });
  assert.equal(view.buttons(t('kit.notifications.enable')).length, 0, 'no Web Push to turn on');
  assert.match(view.shown(), /the Demo app sends your notifications/);
  assert.match(view.shown(), /turned off in the phone’s settings/, 'what the app said before Settings opened');
  page.tell({ v: 1, type: 'push-state', state: 'granted' });
  assert.doesNotMatch(view.shown(), /turned off/, 'and what it says while they are open');
  click(view.buttons(t('kit.notifications.appSettings'))[0]);
  assert.deepEqual(page.sent, [{ v: 1, type: 'open-app-settings' }]);
  assert.equal(view.buttons(t('kit.notifications.test')).length, 1, 'the test, as anywhere');
  assert.match(view.shown(), /iOS/, 'the devices, as anywhere');
  view.settings.close();
  assert.equal(page.listeners['cronum-native'].length, 1, 'only the kit’s own listener is left');

  await assert.rejects(subscribePush(), /in_app/);
  assert.equal(asked, 0, 'not even the permission asked');
  assert.equal(pushSupport(), 'unsupported', 'no Safari tab to install from either');

  asApp([]);
  const old = await settingsPage({ push: true }, { server, start: 'notifications' });
  assert.match(old.shown(), /come with an update of the Demo app/);
  assert.equal(old.buttons(t('kit.notifications.appSettings')).length, 0);
  assert.equal(old.buttons(t('kit.notifications.enable')).length, 0);
  old.settings.close();
  delete globalThis.Notification;
});
