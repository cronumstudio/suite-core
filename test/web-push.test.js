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
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

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
 * subscription it already has.
 */
function fakeBrowser(t, { userAgent = ANDROID, push = true, permission = 'default', answer = 'granted', existing = null,
  standalone = false, maxTouchPoints = 0 } = {}) {
  const seen = { asked: 0, subscribed: [], fetched: 0 };
  let current = existing;
  const registration = {
    pushManager: {
      getSubscription: async () => current,
      subscribe: async (options) => {
        seen.subscribed.push(options);
        current = fakeSubscription(options.applicationServerKey, 'https://fcm.googleapis.com/fcm/send/new');
        return current;
      },
    },
  };
  const saved = Object.fromEntries(['navigator', 'Notification', 'PushManager', 'matchMedia', 'fetch']
    .map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define('navigator', {
    userAgent, maxTouchPoints, standalone,
    ...(push || userAgent !== IPHONE ? { serviceWorker: { ready: Promise.resolve(registration) } } : {}),
  });
  define('matchMedia', (query) => ({ matches: standalone && query === '(display-mode: standalone)' }));
  define('fetch', async () => { seen.fetched++; throw new Error('no request to the server'); });
  if (push) {
    define('PushManager', function PushManager() {});
    const notification = {
      permission,
      requestPermission: async () => { seen.asked++; notification.permission = answer; return answer; },
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
  const json = await devicePushSubscription(publicKey);
  assert.deepEqual(json, { endpoint: 'https://fcm.googleapis.com/fcm/send/new', expirationTime: null, keys: { p256dh: 'BP256dh', auth: 'auth' } });
  assert.equal(seen.asked, 1);
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
  assert.deepEqual([declined.asked, declined.subscribed.length], [1, 0]);
});

test('an iPhone or iPad tab is told to install first; a browser without push says so; a bad key is the app’s mistake', async (t) => {
  const { publicKey } = generateVapidKeys();
  fakeBrowser(t, { userAgent: IPHONE, push: false });
  assert.equal(pushSupport(), 'install', 'Safari gives Web Push only to the app on the home screen');
  await assert.rejects(devicePushSubscription(publicKey), { message: 'install' });
  fakeBrowser(t, { userAgent: IPAD, push: false, maxTouchPoints: 5 });
  assert.equal(pushSupport(), 'install', 'iPadOS says it is a Mac');
  fakeBrowser(t, { userAgent: IPHONE, push: false, standalone: true });
  assert.equal(pushSupport(), 'unsupported', 'on the home screen without push: an iOS before 16.4');
  fakeBrowser(t, { userAgent: IPHONE, push: true, standalone: true });
  assert.equal(pushSupport(), 'prompt', 'installed: it can be asked');
  fakeBrowser(t, { userAgent: IPAD, push: false });
  assert.equal(pushSupport(), 'unsupported', 'a Mac without touch is a Mac');
  fakeBrowser(t, { push: false });
  assert.equal(pushSupport(), 'unsupported');
  await assert.rejects(devicePushSubscription(publicKey), { message: 'unsupported' });

  const seen = fakeBrowser(t);
  for (const key of [undefined, '', 'not a key', Buffer.alloc(64, 4).toString('base64url'), Buffer.alloc(65, 2).toString('base64url'), publicKey.slice(0, 40)]) {
    await assert.rejects(devicePushSubscription(key), TypeError, String(key));
  }
  assert.equal(seen.asked, 0, 'refused before asking anything');
});
