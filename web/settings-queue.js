/**
 * Settings without a signal (settings.js): whether the server can be reached now, and the
 * preferences changed meanwhile, kept on this device until it can.
 *
 * `connection` says whether the server answers: offline when the browser says so or a request
 * found no signal (`noted(err)`), and back once a light question to `/version` (never a copy,
 * sw-core.js) is answered, asked again from 3 s up to 30 s apart, and at once on the browser's
 * `online`. It starts listening on first use, never on import (a module's mount does it, Cronum
 * Work's rule). Settings draws from it: what only the server knows says it needs a connection, and
 * what can't wait for it (a password, deleting) stays off until then.
 *
 * `save(method, path, body)` is a preference's change (the theme, the language, the name, the
 * modules in use…): sent now when it can be, else kept here (`suite.settings.queue`) and sent when
 * the server answers again, here or on the next page that starts the kit (shell.js
 * `flushSettings()`). One change per address: a later one replaces it, and a PATCH's fields are
 * merged, so the last choice is the one that stays. It is the account's: kept with whose it is,
 * sent only while the same person is signed in (`/api/auth/me`), and gone on signing out
 * (signin.js leave).
 */
import { api, Offline, SessionExpired } from './api.js';
import { at } from './base.js';

const KEY = 'suite.settings.queue';
/** Sent by a page when the modules or the calendar changed: the rails ask again (shell.js). */
const MODULES_EVENT = 'kit-modules';

/* ------------------------------- connection ------------------------------- */

const listeners = new Set();
let offline = false;
let listening = false;
let timer = null;
let pause = 3000;

function set(now) {
  if (now === offline) return;
  offline = now;
  if (!now) {
    clearTimeout(timer);
    timer = null;
    pause = 3000;
    flushSettings();
  }
  for (const fn of [...listeners]) fn(now);
}

/** Again in a while, a little longer each time, while there is no signal. */
function later() {
  if (timer || !offline) return;
  timer = setTimeout(() => {
    timer = null;
    pause = Math.min(pause * 2, 30000);
    check();
  }, pause);
  // Never what keeps a process alive (the tests run this in node).
  timer.unref?.();
}

/** Whether the server answers now (any answer counts): `connection` follows. → true when it does. */
async function check() {
  listen();
  try {
    await globalThis.fetch('/version', { cache: 'no-store', credentials: 'same-origin' });
    set(false);
    return true;
  } catch {
    set(true);
    later();
    return false;
  }
}

/** The browser's word, from the first use on: once, and what it says then is where it starts. */
function listen() {
  if (listening) return;
  listening = true;
  offline = globalThis.navigator?.onLine === false;
  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('online', () => { check(); });
    globalThis.addEventListener('offline', () => { set(true); later(); });
  }
}

/** Whether an error is a request that found no signal (the api's Offline). */
export const noSignal = (err) => err instanceof Offline;

export const connection = {
  get offline() { listen(); return offline; },
  /** `fn(offline)` each time it changes. → a function that stops it. */
  on(fn) {
    listen();
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  check,
  /** A request found no signal (`err`, when it says so): offline until the server answers again. */
  noted(err) {
    if (err !== undefined && !noSignal(err)) return;
    listen();
    set(true);
    later();
  },
};

/* ---------------------------------- queue --------------------------------- */

function read() {
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) || 'null');
    return kept && Array.isArray(kept.items) ? kept : null;
  } catch {
    return null;   // private mode, or not JSON
  }
}

function write(kept) {
  try {
    if (kept?.items.length) localStorage.setItem(KEY, JSON.stringify(kept));
    else localStorage.removeItem(KEY);
  } catch { /* private mode, or full: the change stays on this page only */ }
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
/** A PATCH's fields over the ones kept: `prefs` merged too, as the server merges them (prefs.js). */
const merged = (a, b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) =>
  [k, k in b ? (isObject(a[k]) && isObject(b[k]) ? { ...a[k], ...b[k] } : b[k]) : a[k]]));

/**
 * Keeps a change to send later: `path` the site's (`/tasks/api/me`), by `user`'s id. One for
 * each method and path: a PUT replaces the one before, a PATCH adds its fields to it.
 */
export function queueSetting(method, path, body, user) {
  const kept = read();
  const items = kept && kept.user === user ? kept.items : [];
  const index = items.findIndex((i) => i.method === method && i.path === path);
  const item = { method, path, body: index >= 0 && method === 'PATCH' ? merged(items[index].body, body) : body };
  if (index >= 0) items.splice(index, 1);
  items.push(item);
  write({ user, items });
}

/** The changes waiting on this device: [{ method, path, body }]. */
export function queuedSettings() {
  return read()?.items || [];
}

/** Forgets every change waiting (signing out). */
export function forgetSettings() {
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
}

/**
 * A preference's change at the app's `path` (`root`: the site's): sent now while the server
 * answers, kept for later when it doesn't. → `{ answer }` when it went, `{ queued: true }` when kept.
 * Any other failure (the server refused it) is thrown, as before.
 */
export async function save(method, path, body, { root = false, user = null } = {}) {
  // Tried even when a request found no signal a moment ago: it may be back, and a change that
  // reaches the server needn't wait. Only the browser saying it has no network keeps it here at once.
  if (globalThis.navigator?.onLine !== false) {
    try {
      return { answer: await api.request(method, path, body, { root }) };
    } catch (err) {
      if (!noSignal(err)) throw err;
      connection.noted();
    }
  }
  queueSetting(method, root ? path : at(path), body, user);
  return { queued: true };
}

let flushing = null;

/**
 * Sends what was kept, in order, while the same person is signed in; a change that the server
 * refuses goes (the server has the last word), one that finds no signal waits. → how many went.
 */
export function flushSettings() {
  if (flushing) return flushing;
  if (!read()?.items.length) return Promise.resolve(0);
  flushing = (async () => {
    let sent = 0;
    let modules = false;
    try {
      const kept = read();
      if (!kept?.items.length) return 0;
      let who;
      try {
        who = (await api.request('GET', '/api/auth/me', undefined, { root: true }))?.user?.id ?? null;
      } catch (err) {
        if (err instanceof SessionExpired) forgetSettings();   // no one signed in: whoever comes next starts clean
        else if (noSignal(err)) connection.noted();
        return 0;
      }
      if (who !== kept.user) { forgetSettings(); return 0; }
      for (const item of kept.items) {
        try {
          await api.request(item.method, item.path, item.body, { root: true });
          sent++;
          if (/^\/api\/me\/(modules|calendar)/.test(item.path)) modules = true;
        } catch (err) {
          if (noSignal(err)) { connection.noted(); break; }
          if (err instanceof SessionExpired) { forgetSettings(); return sent; }
          // Refused: it goes, the server's stays.
        }
        // Gone from the queue unless it changed while on its way (a newer choice waits its turn).
        const now = read();
        if (now) {
          now.items = now.items.filter((i) => !(i.method === item.method && i.path === item.path
            && JSON.stringify(i.body) === JSON.stringify(item.body)));
          write(now);
        }
      }
      return sent;
    } finally {
      flushing = null;
      if (modules) globalThis.document?.dispatchEvent?.(new CustomEvent(MODULES_EVENT));
    }
  })();
  return flushing;
}
