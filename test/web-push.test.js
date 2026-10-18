/**
 * The kit's push for a device with no account (web/push.js): what it can do
 * before asking, asking first, the subscription as JSON for the app's own
 * route, the browser's one reused or replaced, and never a request to the
 * server. A stand-in browser: Node has no service worker nor Push API.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateVapidKeys } from '../push.js';

const { pushSupport, devicePushSubscription } = await import('../web/push.js');

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const iphone = (version) => `Mozilla/5.0 (iPhone; CPU iPhone OS ${version} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version.replace('_', '.')} Mobile/15E148 Safari/604.1`;
const IPHONE = iphone('18_0');
// iPadOS asks for desktop pages and calls itself a Mac: only Safari's version says which system it runs.
const ipad = (version) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`;
const IPAD = ipad('18.0');
const OLD_IPAD = 'Mozilla/5.0 (iPad; CPU OS 12_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1';

const GLOBALS = ['navigator', 'Notification', 'PushManager', 'matchMedia', 'fetch'];
/** Node's own globals, to check every test puts them back. */
const REAL = Object.fromEntries(GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
/** What each test found before its first stand-in browser: saved once, so several in one test put back the real ones. */
const savedFor = new WeakMap();

const bytesOf = (key) => new Uint8Array(Buffer.from(key, 'base64url'));

/** A subscription as a browser hands it over. */
function fakeSubscription(key, endpoint = 'https://fcm.googleapis.com/fcm/send/tablet') {
  const subscription = {
    endpoint,
    options: { userVisibleOnly: true, applicationServerKey: key ? key.buffer.slice(0) : null },
    unsubscribed: false,
    unsubscribe: async () => { subscription.unsubscribed = true; return true; },
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'BP256dh', auth: 'auth' } }),
  };
  return subscription;
}

/**
 * The browser's globals for one test, put back after it: `push: false` is a
 * browser without the Push API (an iPhone's Safari tab), `existing` the
 * subscription it already has, `noWorker` a page that registered no service
 * worker (its `ready` never settles), `refuse` a push service that won't
 * subscribe. `seen.order` notes when permission is asked and when the worker is
 * waited for.
 */
function fakeBrowser(t, { userAgent = ANDROID, push = true, permission = 'default', answer = 'granted', existing = null,
  standalone = false, maxTouchPoints = 0, noWorker = false, refuse = false } = {}) {
  const seen = { asked: 0, subscribed: [], fetched: 0, order: [] };
  let current = existing;
  const registration = {
    pushManager: {
      getSubscription: async () => current,
      subscribe: async (options) => {
        seen.subscribed.push(options);
        if (refuse) throw Object.assign(new Error('Registration failed - push service error'), { name: 'AbortError' });
        current = fakeSubscription(options.applicationServerKey, 'https://fcm.googleapis.com/fcm/send/new');
        return current;
      },
    },
  };
  if (!savedFor.has(t)) {
    const saved = Object.fromEntries(GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    savedFor.set(t, saved);
    t.after(() => {
      for (const [name, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    });
  }
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const serviceWorker = {
    get ready() {
      seen.order.push('ready');
      return noWorker ? new Promise(() => {}) : Promise.resolve(registration);
    },
  };
  define('navigator', { userAgent, maxTouchPoints, standalone, ...(push ? { serviceWorker } : {}) });
  define('matchMedia', (query) => ({ matches: standalone && query === '(display-mode: standalone)' }));
  define('fetch', async () => { seen.fetched++; throw new Error('no request to the server'); });
  if (push) {
    define('PushManager', function PushManager() {});
    const notification = {
      permission,
      requestPermission: async () => {
        seen.asked++;
        seen.order.push('ask');
        notification.permission = answer;
        return answer;
      },
    };
    define('Notification', notification);
  } else {
    delete globalThis.PushManager;
    delete globalThis.Notification;
  }
  return seen;
}

test('a device with no account gets its subscription as JSON for the app’s own route: asked first, the install’s key, no request', async (t) => {
  const { publicKey } = generateVapidKeys();
  const seen = fakeBrowser(t);
  assert.equal(pushSupport(), 'prompt');
  const pending = devicePushSubscription(publicKey);
  // An async function runs until its first await at once: the tap's activation is still there.
  assert.equal(seen.asked, 1, 'permission is asked before anything is awaited');
  const json = await pending;
  assert.deepEqual(seen.order, ['ask', 'ready'], 'the service worker is waited for only after asking');
  assert.deepEqual(json, { endpoint: 'https://fcm.googleapis.com/fcm/send/new', expirationTime: null, keys: { p256dh: 'BP256dh', auth: 'auth' } });
  assert.equal(seen.subscribed.length, 1);
  assert.equal(seen.subscribed[0].userVisibleOnly, true, 'every notice is shown: browsers require it');
  assert.deepEqual([...seen.subscribed[0].applicationServerKey], [...bytesOf(publicKey)], 'the install’s VAPID key');
  assert.equal(seen.fetched, 0, 'the app posts it; the kit asks nothing of the server');
  assert.equal(pushSupport(), 'granted');
});

test('the browser’s subscription is reused for the same key, replaced for another, and asking can be left out', async (t) => {
  const { publicKey } = generateVapidKeys();
  const same = fakeSubscription(bytesOf(publicKey), 'https://fcm.googleapis.com/fcm/send/same');
  const seen = fakeBrowser(t, { permission: 'granted', existing: same });
  assert.equal((await devicePushSubscription(publicKey)).endpoint, same.endpoint);
  assert.deepEqual([seen.asked, seen.subscribed.length, same.unsubscribed], [0, 0, false], 'nothing asked, nothing new');

  const other = generateVapidKeys().publicKey;
  assert.equal((await devicePushSubscription(other, { ask: false })).endpoint, 'https://fcm.googleapis.com/fcm/send/new');
  assert.equal(same.unsubscribed, true, 'made with keys that no longer send: the browser refuses a second one');
  assert.deepEqual([...seen.subscribed[0].applicationServerKey], [...bytesOf(other)]);
});

test('a browser that doesn’t say which key keeps the subscription it has', async (t) => {
  const { publicKey } = generateVapidKeys();
  const unknown = fakeSubscription(null, 'https://web.push.apple.com/QKept');
  const seen = fakeBrowser(t, { permission: 'granted', existing: unknown });
  assert.equal((await devicePushSubscription(publicKey)).endpoint, 'https://web.push.apple.com/QKept');
  assert.deepEqual([seen.subscribed.length, unknown.unsubscribed], [0, false]);
});

test('without permission there is no subscription: a no, a no asked for, and never asking with ask: false', async (t) => {
  const { publicKey } = generateVapidKeys();
  const quiet = fakeBrowser(t);
  await assert.rejects(devicePushSubscription(publicKey, { ask: false }), { message: 'not_allowed' });
  assert.deepEqual([quiet.asked, quiet.subscribed.length], [0, 0], 'an app starting up never prompts');

  const denied = fakeBrowser(t, { permission: 'denied' });
  assert.equal(pushSupport(), 'denied');
  await assert.rejects(devicePushSubscription(publicKey), { message: 'not_allowed' });
  assert.equal(denied.asked, 0, 'only the browser’s settings undo a no');

  const declined = fakeBrowser(t, { answer: 'denied' });
  await assert.rejects(devicePushSubscription(publicKey), { message: 'not_allowed' });
  assert.deepEqual([declined.asked, declined.subscribed.length, declined.order], [1, 0, ['ask']]);
});

// With a time limit of its own: a regression that waits for the worker before asking would hang here, not fail.
test('no service worker, or a push service that won’t subscribe: a reason, not a wait forever nor the browser’s own error', { timeout: 5000 }, async (t) => {
  const { publicKey } = generateVapidKeys();
  const lonely = fakeBrowser(t, { permission: 'granted', noWorker: true });
  await assert.rejects(devicePushSubscription(publicKey, { wait: 20 }), { message: 'unsupported' });
  assert.equal(lonely.subscribed.length, 0);

  fakeBrowser(t, { permission: 'granted', refuse: true });
  await assert.rejects(devicePushSubscription(publicKey), (err) => {
    assert.equal(err.message, 'subscribe_failed');
    assert.equal(err.cause?.name, 'AbortError', 'the browser’s error, for the console');
    return true;
  });
});

test('an iPhone or iPad tab is told to install first, from iOS 16.4 on; a browser without push says so', async (t) => {
  const { publicKey } = generateVapidKeys();
  fakeBrowser(t, { userAgent: IPHONE, push: false });
  assert.equal(pushSupport(), 'install', 'Safari gives Web Push only to the app on the home screen');
  await assert.rejects(devicePushSubscription(publicKey), { message: 'install' });
  fakeBrowser(t, { userAgent: iphone('16_4'), push: false });
  assert.equal(pushSupport(), 'install', 'the first iOS with Web Push');
  fakeBrowser(t, { userAgent: iphone('16_3'), push: false });
  assert.equal(pushSupport(), 'unsupported', 'before 16.4, installing doesn’t help');
  fakeBrowser(t, { userAgent: iphone('15_7'), push: false });
  assert.equal(pushSupport(), 'unsupported');
  fakeBrowser(t, { userAgent: IPAD, push: false, maxTouchPoints: 5 });
  assert.equal(pushSupport(), 'install', 'iPadOS says it is a Mac');
  fakeBrowser(t, { userAgent: ipad('16.3'), push: false, maxTouchPoints: 5 });
  assert.equal(pushSupport(), 'unsupported', 'an iPad before 16.4, by Safari’s version');
  fakeBrowser(t, { userAgent: OLD_IPAD, push: false });
  assert.equal(pushSupport(), 'unsupported');
  fakeBrowser(t, { userAgent: IPHONE, push: false, standalone: true });
  assert.equal(pushSupport(), 'unsupported', 'on the home screen without push: nothing more to do');
  fakeBrowser(t, { userAgent: IPHONE, push: true, standalone: true });
  assert.equal(pushSupport(), 'prompt', 'installed: it can be asked');
  fakeBrowser(t, { userAgent: IPAD, push: false });
  assert.equal(pushSupport(), 'unsupported', 'a Mac without touch is a Mac');
  fakeBrowser(t, { push: false });
  assert.equal(pushSupport(), 'unsupported');
  await assert.rejects(devicePushSubscription(publicKey), { message: 'unsupported' });
});

test('a key that isn’t the install’s is the app’s mistake: a TypeError, before asking anything', async (t) => {
  const { publicKey } = generateVapidKeys();
  const seen = fakeBrowser(t);
  const keys = [undefined, '', 'not a key', 42, Buffer.alloc(64, 4).toString('base64url'), Buffer.alloc(65, 2).toString('base64url'),
    publicKey.slice(0, 40),
    // 4k + 1 characters: no base64 is that long, and atob would throw a DOMException of its own.
    publicKey.slice(0, 85)];
  for (const key of keys) {
    await assert.rejects(devicePushSubscription(key), TypeError, String(key));
  }
  assert.deepEqual([seen.asked, seen.order], [0, []], 'refused before asking anything');
});

test('every test puts the real globals back, however many stand-in browsers it used', () => {
  for (const name of GLOBALS) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, name), REAL[name], name);
  }
});
