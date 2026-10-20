/**
 * The app's service worker, registered from its page:
 *
 *   import { registerWorker } from '../suite/worker.js';
 *   window.addEventListener('load', () => { registerWorker(); });
 *
 * On its own an app registers its /sw.js, as it always did: same URL, same
 * scope, nothing else (suite-core CONVENTIONS.md §9). A module of a host
 * registers its own /<mount>/sw.js too, unless the host has one worker for
 * everything (host.js `worker`, which /api/auth/config says in `host.worker`):
 * then it registers the host's, at `/`, and retires every module's worker
 * this device still has. A module's scope (/tasks/) is narrower than `/` and
 * would go on serving its pages, with its own copy, its own notices and its
 * own notice of a new version.
 *
 * A worker retired takes its push subscription with it. Where the person had
 * notices on and the browser still allows them, the host's worker subscribes
 * in its place and the server is told, the old address forgotten: nothing to
 * do for the person. Where that can't be done (the browser won't subscribe
 * without a tap, as Safari may, or the permission went), the device remembers
 * it, and Settings › Notifications asks to turn them on again
 * (`noticesToRenew()`). A worker with a subscription whose page has no session
 * yet stays until a page with one comes: retired then, its notices go on.
 */
import { BASE, at } from './base.js';

/** What the device remembers of its host: { worker } or null, for a page that opens offline. */
const HOST_KEY = 'host.worker';
/** Notices a retired worker had that couldn't be carried over: '1' until they are turned on again. */
const RENEW_KEY = 'host.push.renew';
/** How long a new worker may take to become active before its push manager is used. */
const ACTIVE_WAIT_MS = 10000;

const remember = (key, value) => {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private mode */ }
};
const recall = (key) => {
  try { return localStorage.getItem(key); } catch { return null; }
};

let asked = null;

/**
 * The host's one worker, when this page is a module of a host that has one:
 * `{ worker: '/sw.js', name }`; null on its own (nothing is asked) or in a host
 * without one. Asked once per page; offline, what the device remembers.
 */
export function hostWorker({ fetch: get = (...args) => globalThis.fetch(...args), base = BASE } = {}) {
  if (base === '/') return Promise.resolve(null);
  asked ??= (async () => {
    try {
      const res = await get(`${base}api/auth/config`, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const host = (await res.json())?.app?.host;
      const found = host?.worker ? { worker: host.worker, name: host.name || null } : null;
      remember(HOST_KEY, found ? JSON.stringify(found) : null);
      return found;
    } catch {
      try { return JSON.parse(recall(HOST_KEY) || 'null'); } catch { return null; }
    }
  })();
  return asked;
}

/** The page's worker registered: the app's own, or the host's one with the modules' retired. */
export async function registerWorker() {
  const sw = globalThis.navigator?.serviceWorker;
  if (!sw) return null;
  const host = await hostWorker();
  // On its own, or in a host whose modules keep theirs: /sw.js at the app's base, as always.
  if (!host) return sw.register(at('/sw.js')).catch(() => null);
  const root = await sw.register(host.worker, { scope: '/' }).catch(() => null);
  if (!root) return null;
  await retireModuleWorkers(root).catch(() => {});
  return root;
}

/**
 * The registration that shows this page's notices: the host's at `/` where
 * there is one (registered now if it wasn't), else the page's own; once it is
 * active, for its push manager. Error('unsupported') when none comes.
 */
export async function workerRegistration() {
  const sw = globalThis.navigator?.serviceWorker;
  if (!sw) throw new Error('unsupported');
  const host = await hostWorker();
  if (!host) return sw.ready;
  const found = await sw.getRegistration('/').catch(() => null);
  const root = found?.scope === new URL('/', location.href).href ? found : await sw.register(host.worker, { scope: '/' });
  return activeOf(root);
}

/** Whether notices this device had were lost when the modules' workers were retired, and must be turned on again. */
export function noticesToRenew() {
  return recall(RENEW_KEY) === '1';
}

/** Notices are on again on this device (Settings): nothing to ask any more. */
export function noticesRenewed() {
  remember(RENEW_KEY, null);
}

/** A registration once its worker is active: a push manager needs one. */
function activeOf(registration) {
  if (registration.active) return Promise.resolve(registration);
  const coming = registration.installing || registration.waiting;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('unsupported')), ACTIVE_WAIT_MS);
    coming?.addEventListener('statechange', () => {
      if (registration.active) {
        clearTimeout(timer);
        resolve(registration);
      }
    });
  });
}

/** One page at a time (the split view loads several modules at once), where the browser can say so. */
function alone(fn) {
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request('host.worker', fn) : fn();
}

/** The install's VAPID public key as the bytes the browser takes. */
function keyBytes(key) {
  const raw = atob(String(key).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(key).length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const NOT_YET = 'not_yet';

/**
 * The modules' workers this device has (every scope but `/`) retired, their
 * notices carried over to the host's worker and their copies cleared.
 */
async function retireModuleWorkers(root) {
  const sw = navigator.serviceWorker;
  const rootScope = new URL('/', location.href).href;
  if (!(await sw.getRegistrations()).some((r) => r.scope !== rootScope)) return;
  await alone(async () => {
    const others = (await sw.getRegistrations()).filter((r) => r.scope !== rootScope);
    if (!others.length) return;
    const endpoints = [];
    for (const registration of others) {
      const subscription = await registration.pushManager?.getSubscription().catch(() => null);
      if (subscription) endpoints.push(subscription.endpoint);
    }
    if (endpoints.length) {
      try {
        await carryNotices(root, endpoints);
      } catch (err) {
        // No session or no network: they stay, and a page that has them does it.
        if (err?.message === NOT_YET) return;
        remember(RENEW_KEY, '1');
      }
    }
    await Promise.all(others.map((r) => r.unregister().catch(() => false)));
    // Their copies: each module's is named after its path (sw-core.js).
    const paths = others.map((r) => new URL(r.scope).pathname);
    const keys = await globalThis.caches?.keys?.().catch(() => []) || [];
    await Promise.all(keys.filter((k) => paths.some((p) => p !== '/' && k.startsWith(p))).map((k) => caches.delete(k)));
  });
}

/**
 * The host's worker subscribed in place of the modules', and the server told:
 * the new address kept (with the device's language), the old ones forgotten.
 * Throws Error('not_yet') when there is no session or no network, any other
 * error when the browser won't.
 */
async function carryNotices(root, endpoints) {
  const send = async (method, path, body) => {
    let res;
    try {
      res = await fetch(at(path), {
        method, credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error(NOT_YET);
    }
    if (res.status === 401 || res.status === 403 || res.status >= 500) throw new Error(NOT_YET);
    return res.ok ? res.json().catch(() => ({})) : null;
  };
  const config = await send('GET', '/api/push/config');
  if (!config?.public_key) throw new Error(NOT_YET);
  // Without the permission there is nothing to carry: the old addresses are forgotten all the same.
  const allowed = globalThis.Notification?.permission === 'granted';
  let kept = null;
  if (allowed) {
    try {
      const registration = await activeOf(root);
      const key = keyBytes(config.public_key);
      let subscription = await registration.pushManager.getSubscription();
      const current = subscription?.options?.applicationServerKey;
      if (subscription && current && !new Uint8Array(current).every((b, i) => b === key[i])) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      kept = subscription.toJSON();
    } catch {
      kept = null;
    }
  }
  if (kept) {
    await send('POST', '/api/push/subscribe', {
      endpoint: kept.endpoint, keys: kept.keys, label: navigator.userAgent.slice(0, 120),
      lang: document.documentElement.lang || null,
    });
  }
  for (const endpoint of endpoints) {
    if (endpoint !== kept?.endpoint) await send('DELETE', `/api/push/subscribe?endpoint=${encodeURIComponent(endpoint)}`);
  }
  if (!kept) throw new Error('not_carried');
}
