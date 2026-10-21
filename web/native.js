/**
 * The bridge between a page and the suite's app on a phone (Cronum Work for iPhone and Android:
 * an Expo app whose main screen is a web view of the web, with the native pieces the web can't
 * have). Outside the app every function here does nothing and says so (false, null, a no-op), so a
 * page behaves exactly as it always did.
 *
 * In the app when the user agent carries `CronumWorkApp/<version>` (appended by the app's web
 * view) or the app injected `window.CronumNative` before the page loaded:
 *
 *   window.CronumNative = { v: 1, platform: 'ios' | 'android', version: '1.2.0',
 *                           capabilities: ['push', 'reminders', 'badge', 'purchase', 'biometrics', 'share'] }
 *
 *   import { inApp, nativeInfo, can, setBadge, setReminders, onNative } from '../suite/native.js';
 *   if (can('badge')) setBadge(7);
 *   const stop = onNative('push-state', ({ state }) => paint(state));
 *
 * Web → app: `window.ReactNativeWebView.postMessage(JSON.stringify({ v: 1, type, ...payload }))`
 *
 *   ready              {}                                       the page is drawn and listening (createShell)
 *   badge              { count }                                the icon's number, an integer ≥ 0
 *   reminders          { items: [{ id, module, title, at, url }] }
 *                      every reminder of the next days, the full set: it replaces the one before.
 *                      `at` ISO 8601 in UTC, `url` a path of this site the reminder opens
 *   purchase           { product }                              buy in the store: a product key
 *                      (stores.products), or null for the app's own choice
 *   open-external      { url }                                  an address the app opens outside itself
 *   sign-out           {}                                       the person signed out here (signin.js)
 *   haptic             { style }                                light, medium, heavy, selection, success, warning, error
 *   open-app-settings  {}                                       the app's own settings (Settings › Notifications)
 *
 * App → web: a `cronum-native` CustomEvent on the window, its `detail` `{ v: 1, type, ... }`:
 *
 *   purchase-result    { product, status }                      purchased | pending | canceled | failed
 *   push-state         { state }                                granted | denied | undetermined
 *
 * THE MESSAGES ARE ONLY EVER ADDED: never renamed, never given another meaning, never a payload
 * field taken away or changed. A build of the app lives for months on people's phones next to a
 * web that changes every day, so either side may meet a message it doesn't know: it ignores it,
 * and neither side may need an answer to go on. Each carries `v: 1`; a message with another `v` is
 * ignored as unknown. A new message, or a new optional field, is a new line above, in
 * docs/web-kit.md and in the CHANGELOG.
 *
 * In a frame of a host's split view (base.js FRAMED) the app's objects are its parent's, on the same
 * site: the bridge is the top window's.
 */
import { FRAMED } from './base.js';

/** The event the app sends its messages with, on the window. */
export const NATIVE_EVENT = 'cronum-native';

/** The bridge's one version: messages are added, never changed, so it stays 1. */
export const BRIDGE_VERSION = 1;

/** What the app appends to its web view's user agent: `CronumWorkApp/<version>`. */
const USER_AGENT = /\bCronumWorkApp\/([0-9A-Za-z.+-]{1,40})/;

/** What a page may ask the app to do: a haptic's styles, the addresses opened outside. */
const HAPTICS = new Set(['light', 'medium', 'heavy', 'selection', 'success', 'warning', 'error']);
const OUTSIDE = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:']);

/** iOS keeps 64 local notifications per app: the soonest are sent, the rest come in a later set. */
export const MAX_REMINDERS = 64;
const REMINDER_TEXT = 200;

const injectedOf = (win) => {
  const given = win?.CronumNative;
  return given && typeof given === 'object' ? given : null;
};

/**
 * The window the app's objects are on: this one, or in a frame of the same site the top one (the
 * app injects into the page it loaded).
 */
function appWindow(win) {
  if (!win) return null;
  if (injectedOf(win) || win.ReactNativeWebView || (win === globalThis.window && !FRAMED)) return win;
  try {
    const top = win.top;
    if (top && top !== win && top.location.origin === win.location.origin) return top;
  } catch { /* another site: not the app's */ }
  return win;
}

function userAgentOf(win) {
  return String(win?.navigator?.userAgent ?? globalThis.navigator?.userAgent ?? '');
}

/** Whether this page runs inside the app. */
export function inApp(win = globalThis.window) {
  if (!win) return false;
  return USER_AGENT.test(userAgentOf(win)) || Boolean(injectedOf(appWindow(win)));
}

/**
 * What the app says of itself: `{ v, platform, version, capabilities }` (frozen), or null outside
 * it. Known from the user agent alone (an app that injects nothing yet), it has no capabilities.
 */
export function nativeInfo(win = globalThis.window) {
  if (!inApp(win)) return null;
  const given = injectedOf(appWindow(win)) || {};
  const agent = userAgentOf(win);
  const platform = typeof given.platform === 'string' ? given.platform
    : /iPhone|iPad|iPod/.test(agent) ? 'ios' : /Android/.test(agent) ? 'android' : null;
  const version = typeof given.version === 'string' ? given.version : USER_AGENT.exec(agent)?.[1] || null;
  const capabilities = Array.isArray(given.capabilities) ? given.capabilities.filter((c) => typeof c === 'string') : [];
  return Object.freeze({
    v: Number.isInteger(given.v) ? given.v : BRIDGE_VERSION, platform, version, capabilities: Object.freeze(capabilities),
  });
}

/** Whether the app can do `capability` ('push', 'reminders', 'badge', 'purchase', 'biometrics', 'share'). */
export function can(capability, win = globalThis.window) {
  return Boolean(nativeInfo(win)?.capabilities.includes(capability));
}

/**
 * Sends one message to the app: `{ v: 1, type, ...payload }`. → whether it went (false outside the
 * app, or in an app whose web view has no bridge). The typed helpers below check their payload;
 * this one is for a message the kit has no helper for yet, and the rules are the same.
 */
export function postNative(type, payload = {}, win = globalThis.window) {
  if (typeof type !== 'string' || !type || !inApp(win)) return false;
  const bridge = appWindow(win)?.ReactNativeWebView;
  if (typeof bridge?.postMessage !== 'function') return false;
  const { v: _v, type: _type, ...rest } = payload && typeof payload === 'object' ? payload : {};
  try {
    bridge.postMessage(JSON.stringify({ v: BRIDGE_VERSION, type, ...rest }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Listens to one type of the app's messages: `handler(detail)` for each, while it lasts. → the
 * function that stops it. Anything else that arrives (another type, another `v`, not an object)
 * is ignored. Outside the app it listens to nothing.
 */
export function onNative(type, handler, win = globalThis.window) {
  const target = inApp(win) ? appWindow(win) : null;
  if (typeof target?.addEventListener !== 'function' || typeof handler !== 'function') return () => {};
  const listener = (event) => {
    const detail = messageOf(event?.detail);
    if (detail?.type === type) handler(detail);
  };
  target.addEventListener(NATIVE_EVENT, listener);
  return () => target.removeEventListener(NATIVE_EVENT, listener);
}

/** A message from the app, or null for anything that isn't one this version reads. */
export function messageOf(detail) {
  let value = detail;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.v !== BRIDGE_VERSION || typeof value.type !== 'string' || !value.type) return null;
  return value;
}

/* ------------------------------ what a page sends ------------------------------ */

/** The page is drawn and listens (createShell calls it). Once per page, never from a frame. */
let readySent = false;
export function nativeReady(win = globalThis.window) {
  if (readySent || (FRAMED && win === globalThis.window)) return false;
  readySent = postNative('ready', {}, win);
  return readySent;
}

/** The number on the app's icon, with the app's 'badge'. */
export function setBadge(count, win = globalThis.window) {
  if (!can('badge', win)) return false;
  const n = Number(count);
  return postNative('badge', { count: Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 99999) : 0 }, win);
}

/**
 * Every reminder of the next days, with the app's 'reminders': the full set, which replaces the one
 * sent before (an empty list clears them). Each `{ id, module, title, at, url }`: `at` a date or an
 * ISO string, `url` an address of this site (sent as its path). One without an id, a time or a
 * title, or with an address elsewhere, is left out; the soonest MAX_REMINDERS go.
 */
export function setReminders(items, win = globalThis.window) {
  if (!can('reminders', win)) return false;
  const here = win?.location?.href;
  const clean = [];
  for (const item of Array.isArray(items) ? items : []) {
    const at = new Date(item?.at ?? NaN);
    const id = item?.id == null ? '' : String(item.id);
    const title = typeof item?.title === 'string' ? item.title.trim().slice(0, REMINDER_TEXT) : '';
    if (!id || !title || Number.isNaN(at.getTime())) continue;
    let url = null;
    if (item.url != null) {
      try {
        const address = new URL(String(item.url), here);
        if (address.origin !== new URL(here).origin) continue;
        url = `${address.pathname}${address.search}${address.hash}`;
      } catch { continue; }
    }
    clean.push({ id, module: typeof item.module === 'string' ? item.module : null, title, at: at.toISOString(), url });
  }
  clean.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return postNative('reminders', { items: clean.slice(0, MAX_REMINDERS) }, win);
}

/** Buy in the app's store, with the app's 'purchase': a product key, or null for the app's choice. */
export function nativePurchase(product = null, win = globalThis.window) {
  if (!can('purchase', win)) return false;
  return postNative('purchase', { product: typeof product === 'string' && product ? product : null }, win);
}

/** An address for the app to open outside itself: the system browser, or mail and the phone. */
export function openExternal(url, win = globalThis.window) {
  let address;
  try { address = new URL(String(url), win?.location?.href); } catch { return false; }
  if (!OUTSIDE.has(address.protocol)) return false;
  return postNative('open-external', { url: address.href }, win);
}

/** The person signed out here: the app lets go of its device and shows its own sign-in. */
export function nativeSignOut(win = globalThis.window) {
  return postNative('sign-out', {}, win);
}

/** A touch the hand feels: `light`, `medium`, `heavy`, `selection`, `success`, `warning` or `error`. */
export function haptic(style = 'light', win = globalThis.window) {
  return HAPTICS.has(style) ? postNative('haptic', { style }, win) : false;
}

/** The app's own settings (its notifications there). */
export function openAppSettings(win = globalThis.window) {
  return postNative('open-app-settings', {}, win);
}

/* ------------------------------ what the app said ------------------------------ */

/**
 * The last message of each type the app sent this page (say, `push-state` before Settings opened),
 * or null. Kept from the moment the kit loads, in the app only.
 */
const heard = new Map();
export function lastNative(type) {
  return heard.get(type) || null;
}

if (inApp()) {
  try {
    appWindow(globalThis.window)?.addEventListener?.(NATIVE_EVENT, (event) => {
      const detail = messageOf(event?.detail);
      if (detail) heard.set(detail.type, detail);
    });
  } catch { /* a window that won't be listened to: nothing kept */ }
}
