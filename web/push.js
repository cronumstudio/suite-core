/**
 * Notices on a device that belongs to the app rather than to a signed-in
 * person: a child's tablet paired to a profile (Focus), a kiosk. Settings'
 * subscribePush() is for a person: it asks /api/push/config and posts to
 * /api/push/subscribe, both behind a session, so a device without one can't
 * use it. Nothing here talks to the server: the app hands the device the
 * install's public key its own way (`suite.push.publicKey`, say in the answer
 * that paired it), gets the browser's subscription from here and posts it to
 * its own route, which checks it with `suite.push.checkSubscription()` and
 * keeps it with the device; the server sends with
 * `suite.push.sendToSubscription()`.
 *
 *   import { pushSupport, devicePushSubscription } from '../suite/push.js';   // from public/js/
 *   if (pushSupport() === 'install') showHomeScreenHint();   // iPhone, iPad: the home screen first
 *   button.addEventListener('click', async () => {
 *     const subscription = await devicePushSubscription(publicKey);
 *     await api.post('/api/<the app’s route>', { subscription });
 *   });
 *
 * What arrives is shown by the app's service worker (sw-core.js, with `push`
 * in suiteWorker()). A browser has one subscription per service worker: a
 * person who turns notices on in Settings on the same device gets this same
 * one, so neither side should unsubscribe the browser to forget the other.
 *
 * Inside the suite's app on a phone (native.js) there is no Web Push: the app's
 * own notifications are the device's one channel, so a notice never comes twice.
 */
import { inApp } from './native.js';

/** How long to wait for the page's service worker: `ready` never settles on a page that registered none. */
const WORKER_WAIT_MS = 10000;

/**
 * The version of iOS or iPadOS a browser says it runs, or null when it doesn't
 * say. An iPhone writes `OS 18_0`; an iPad asking for desktop pages calls itself
 * a Mac, and only Safari's `Version/18.0`, which follows the system's, is left.
 */
function appleVersion(agent) {
  const found = /\bOS (\d+)_(\d+)/.exec(agent) || /\bVersion\/(\d+)\.(\d+)/.exec(agent);
  return found ? [Number(found[1]), Number(found[2])] : null;
}

/**
 * Whether this is an iPhone or iPad tab where Web Push would work once
 * installed: Apple gives it only to a web app added to the home screen and
 * opened from there, from iOS 16.4 on. Before 16.4 there is nothing to install
 * for; a system that doesn't say its version gets the benefit of the doubt.
 */
function appleTab() {
  const nav = globalThis.navigator || {};
  const agent = String(nav.userAgent || '');
  // iPadOS says it is a Mac; a Mac with a touch screen is an iPad.
  const apple = /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && nav.maxTouchPoints > 1);
  const standalone = nav.standalone === true || Boolean(globalThis.matchMedia?.('(display-mode: standalone)')?.matches);
  if (!apple || standalone) return false;
  const version = appleVersion(agent);
  return !version || version[0] > 16 || (version[0] === 16 && version[1] >= 4);
}

/**
 * Whether this browser can get notices, before asking anything:
 *   'granted'      allowed already: devicePushSubscription() won't ask
 *   'prompt'       it can be asked (from a tap)
 *   'denied'       the person said no: only the browser's settings undo it
 *   'install'      an iPhone or iPad tab (iOS 16.4+): add the app to the home
 *                  screen and open it from there
 *   'unsupported'  no service worker or no Push API (also an iPhone or iPad
 *                  before 16.4, and inside the suite's app, whose notices are its own)
 */
export function pushSupport() {
  // In the app's web view an iPhone isn't a Safari tab to install from, and the app notifies itself.
  if (inApp()) return 'unsupported';
  const nav = globalThis.navigator;
  const able = Boolean(nav && 'serviceWorker' in nav) && 'PushManager' in globalThis && 'Notification' in globalThis;
  if (!able) return appleTab() ? 'install' : 'unsupported';
  const { permission } = globalThis.Notification;
  return permission === 'granted' ? 'granted' : permission === 'denied' ? 'denied' : 'prompt';
}

/** The install's VAPID public key (base64url, as the server gives it) as the bytes the browser takes. */
function keyBytes(publicKey) {
  let bytes = null;
  if (typeof publicKey === 'string' && /^[A-Za-z0-9_-]+$/.test(publicKey)) {
    // A length that no base64 has makes atob throw a DOMException: the same mistake as any other bad key.
    try {
      const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (publicKey.length % 4)) % 4));
      bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    } catch {
      bytes = null;
    }
  }
  // A P-256 point, uncompressed: anything else and the browser's refusal would say much less.
  if (!bytes || bytes.length !== 65 || bytes[0] !== 4) {
    throw new TypeError('publicKey must be the install VAPID public key (suite.push.publicKey)');
  }
  return bytes;
}

/** Whether a subscription was made with this key; a browser that doesn't say keeps the one it has. */
function sameKey(current, wanted) {
  if (!current) return true;
  const bytes = new Uint8Array(current);
  return bytes.length === wanted.length && bytes.every((byte, i) => byte === wanted[i]);
}

/** The page's service worker, or Error('unsupported') when none comes in `wait` ms. */
function workerReady(wait) {
  let timer;
  const late = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('unsupported')), wait);
  });
  return Promise.race([navigator.serviceWorker.ready, late]).finally(() => clearTimeout(timer));
}

/**
 * The browser's subscription for this device, as the JSON the app posts to
 * its own route: `{ endpoint, expirationTime, keys: { p256dh, auth } }`.
 *
 * It asks for permission first, before it waits for anything. Call it from a
 * tap, with the key already at hand: Safari asks only from one, and a request
 * awaited before asking (to fetch the key) can use the tap up. `ask: false`
 * never asks and only goes on where permission was given before: an app
 * refreshing the subscription when it starts, in case the browser renewed it.
 *
 * The subscription the browser already has is reused while it is for this
 * key; one made with another key (the install's keys changed, so nothing
 * reaches it any more) is replaced, since the browser refuses a second.
 *
 * Throws Error('unsupported') (also when no service worker is ready within
 * `wait`, 10 s), Error('install') (see pushSupport), Error('not_allowed'), or
 * Error('subscribe_failed') when the browser or its push service refuses to
 * subscribe (offline, the push service down; its own error is the `cause`);
 * a TypeError for a key that isn't one.
 */
export async function devicePushSubscription(publicKey, { ask = true, wait = WORKER_WAIT_MS } = {}) {
  const support = pushSupport();
  if (support === 'unsupported' || support === 'install') throw new Error(support);
  const key = keyBytes(publicKey);
  // The first thing awaited, so the tap that called this still counts when Safari asks.
  const permission = ask && support === 'prompt'
    ? await globalThis.Notification.requestPermission()
    : globalThis.Notification.permission;
  if (permission !== 'granted') throw new Error('not_allowed');
  const registration = await workerReady(wait);
  try {
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !sameKey(subscription.options?.applicationServerKey, key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    return subscription.toJSON();
  } catch (err) {
    throw new Error('subscribe_failed', { cause: err });
  }
}
