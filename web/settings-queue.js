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
 *
 * Learnt (audit of 30/10): a choice that reaches the server takes out of the queue what it says
 * again (the older one, sent later, undid it); in a host every module's copy of the kit shares the
 * queue and the person's row (`/tasks/api/me` and `/notes/api/me` are one), so one copy sends at a
 * time (a Web Lock) and reads each change from the queue as it goes; a change kept more than a day
 * doesn't go (changed since on another device, perhaps); the server in trouble (5xx, 429) keeps it
 * and only a refusal (4xx) drops it; and a browser that keeps nothing in `localStorage` keeps it on
 * this page.
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

/** A change kept longer than this doesn't go: it would undo what was chosen since, on another device. */
const MAX_AGE_MS = 24 * 3600 * 1000;
/** The queue when `localStorage` keeps nothing (blocked, full, some private windows): this page's. */
let onPage = null;

function read() {
  if (onPage) return onPage;
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
    onPage = null;
  } catch {
    // Private mode, or full: kept on this page, and sent from it.
    onPage = kept?.items.length ? kept : null;
  }
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
/** A PATCH's fields over the ones kept: `prefs` merged too, as the server merges them (prefs.js). */
const merged = (a, b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) =>
  [k, k in b ? (isObject(a[k]) && isObject(b[k]) ? { ...a[k], ...b[k] } : b[k]) : a[k]]));

/** What a path changes: in a host `/tasks/api/me` and `/notes/api/me` are the same person's row. */
const target = (path) => { const at = path.indexOf('/api/'); return at >= 0 ? path.slice(at) : path; };
const ACCOUNT = /^\/api\/me$/;

/** `body` without what `sent` said (`prefs` key by key); null when nothing is left. */
function without(body, sent) {
  const left = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (!(k in sent)) { left[k] = v; continue; }
    if (isObject(v) && isObject(sent[k])) {
      const rest = Object.fromEntries(Object.entries(v).filter(([key]) => !(key in sent[k])));
      if (Object.keys(rest).length) left[k] = rest;
    }
  }
  return Object.keys(left).length ? left : null;
}

/**
 * A change that reached the server: what waits for the same thing is older, and goes. A PUT's
 * address goes whole; a PATCH of the person takes out only the fields it said.
 */
function settled(method, path, body) {
  const kept = read();
  if (!kept?.items.length) return;
  const sentTo = target(path);
  const items = [];
  for (const item of kept.items) {
    if (item.method !== method || target(item.path) !== sentTo) { items.push(item); continue; }
    if (method !== 'PATCH' || !ACCOUNT.test(sentTo) || !isObject(body)) continue;
    const left = without(item.body, body);
    if (left) items.push({ ...item, body: left });
  }
  if (items.length !== kept.items.length || items.some((item, i) => item !== kept.items[i])) write({ ...kept, items });
}

/**
 * Keeps a change to send later: `path` the site's (`/tasks/api/me`), by `user`'s id. One for
 * each method and path: a PUT replaces the one before, a PATCH adds its fields to it.
 */
export function queueSetting(method, path, body, user) {
  const kept = read();
  const items = kept && kept.user === user ? kept.items : [];
  const index = items.findIndex((i) => i.method === method && i.path === path);
  const item = { method, path, body: index >= 0 && method === 'PATCH' ? merged(items[index].body, body) : body, at: Date.now() };
  if (index >= 0) items.splice(index, 1);
  items.push(item);
  write({ user, items });
}

/** The changes waiting on this device: [{ method, path, body }]. */
export function queuedSettings() {
  return (read()?.items || []).map(({ method, path, body }) => ({ method, path, body }));
}

/** Forgets every change waiting (signing out). */
export function forgetSettings() {
  onPage = null;
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
      const answer = await api.request(method, path, body, { root });
      settled(method, root ? path : at(path), body);
      return { answer };
    } catch (err) {
      if (!noSignal(err)) throw err;
      connection.noted();
    }
  }
  queueSetting(method, root ? path : at(path), body, user);
  return { queued: true };
}

let flushing = null;
const LOCK = 'suite.settings.queue';

/**
 * Sends what was kept, in order, while the same person is signed in; a change that the server
 * refuses goes (the server has the last word), one that finds no signal or a server in trouble
 * waits. One copy of the kit at a time, every module's in a host. → how many went.
 */
export function flushSettings() {
  if (flushing) return flushing;
  if (!read()?.items.length) return Promise.resolve(0);
  const locks = globalThis.navigator?.locks;
  // Another copy of the kit (another module's, another tab) holding it is sending the same queue.
  flushing = (locks ? locks.request(LOCK, { ifAvailable: true }, (lock) => (lock ? sendKept() : 0)) : sendKept())
    .finally(() => { flushing = null; });
  return flushing;
}

async function sendKept() {
  let sent = 0;
  let modules = false;
  try {
    const kept = read();
    if (!kept?.items.length) return 0;
    let who;
    try {
      who = (await api.request('GET', '/api/auth/me', undefined, { root: true }))?.user?.id ?? null;
    } catch (err) {
      // No one signed in now: kept with whose it is, for the same person signing in again.
      if (noSignal(err)) connection.noted();
      return 0;
    }
    if (who !== kept.user) { forgetSettings(); return 0; }
    for (;;) {
      // Read again each time: a choice that went straight to the server meanwhile took its own out.
      const now = read();
      const item = now?.user === who ? now.items[0] : null;
      if (!item) break;
      if (item.at == null || Date.now() - item.at <= MAX_AGE_MS) {
        try {
          await api.request(item.method, item.path, item.body, { root: true });
          sent++;
          if (/^\/api\/me\/(modules|calendar)/.test(target(item.path))) modules = true;
        } catch (err) {
          if (noSignal(err)) { connection.noted(); break; }
          // The session ended, or the server is in trouble: it waits. Refused (4xx): it goes, the server's stays.
          if (err instanceof SessionExpired || !(err?.status < 500) || err.status === 429) break;
        }
      }
      // Gone from the queue unless it changed while on its way (a newer choice waits its turn).
      const after = read();
      if (after) {
        after.items = after.items.filter((i) => !(i.method === item.method && i.path === item.path
          && JSON.stringify(i.body) === JSON.stringify(item.body)));
        write(after);
      }
    }
    return sent;
  } finally {
    if (modules) globalThis.document?.dispatchEvent?.(new CustomEvent(MODULES_EVENT));
  }
}
