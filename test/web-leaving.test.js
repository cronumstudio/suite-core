/**
 * Changes made without a signal, and leaving the device (audit of 30/10): whose each queued change
 * is (outbox.js `owner`), how many wait in every app's copy (signin.js `pendingChanges`), and
 * signing out, which asks first when some wait and lets go of nothing when the server can't hear it.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

installFakeDom();
const storage = new Map();
globalThis.localStorage = globalThis.sessionStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
const happened = [];
const page = {
  location: { href: 'https://work.example.com/', origin: 'https://work.example.com', reload: () => happened.push('reload') },
  navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0' },
  addEventListener: () => {}, removeEventListener: () => {},
};
page.top = page.self = page;
globalThis.window = page;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: page.navigator });
globalThis.location = page.location;

const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
let routes = {};
const asked = [];
globalThis.fetch = async (url, { method = 'GET' } = {}) => {
  const path = String(url);
  if (path.startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
  asked.push(`${method} ${path}`);
  const route = routes[`${method} ${path}`];
  if (route === 'offline') throw new TypeError('Failed to fetch');
  const { status = 200, data = {} } = route || { status: 404, data: { error: 'not_found' } };
  return { ok: status < 400, status, headers: new Map(), json: async () => data };
};

const { loadLanguage } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
const { createOutbox } = await import('../web/outbox.js');
const { memoryLocal } = await import('../web/local.js');
const { ApiError } = await import('../web/api.js');
const { signOut, pendingChanges } = await import('../web/signin.js');
const { queueSetting, forgetSettings } = await import('../web/settings-queue.js');

/* --------------------------------- whose ---------------------------------- */

test('the outbox notes whose each change is and never sends one of another account', async () => {
  const local = memoryLocal();
  let who = 7;
  const sent = [];
  const dropped = [];
  const outbox = createOutbox({
    local, locks: null, owner: () => who,
    send: async (op) => { sent.push(op.path); return {}; },
    onDropped: ({ op, error }) => dropped.push([op.path, error.code]),
  });
  await outbox.add({ method: 'PATCH', path: '/api/tasks/1', body: {} });
  await outbox.add({ method: 'PATCH', path: '/api/tasks/2', body: {} });
  assert.deepEqual((await outbox.pending()).map((op) => op.owner), [7, 7], 'each change carries whose it is');

  // The session ended; nobody known yet: nothing goes, nothing is lost.
  who = null;
  // Drawn offline for whoever was signed in last, before the server has said so: theirs all the same.
  await outbox.add({ method: 'PATCH', path: '/api/tasks/5', body: {}, owner: 7 });
  assert.equal((await outbox.pending()).at(-1).owner, 7);
  let report = await outbox.flush();
  assert.equal(report.sent, 0);
  assert.equal(report.left, 3);
  assert.deepEqual(sent, []);

  // Someone else signed in on this device: theirs is not this, it goes nowhere.
  who = 8;
  await outbox.add({ method: 'PATCH', path: '/api/tasks/3', body: {} });
  report = await outbox.flush();
  assert.deepEqual(sent, ['/api/tasks/3'], 'only the account’s own change went');
  assert.deepEqual(report.others.map((op) => op.path), ['/api/tasks/1', '/api/tasks/2', '/api/tasks/5']);
  assert.deepEqual(dropped, [], 'another account’s changes are not this person’s errors');
  assert.equal(report.left, 0);
});

test('a change queued before it had an owner still goes; keepOnly() lets go of every other one', async () => {
  const local = memoryLocal();
  const sent = [];
  const old = createOutbox({ local, locks: null, send: async (op) => { sent.push(op.path); return {}; } });
  await old.add({ method: 'PATCH', path: '/api/tasks/1', body: {} });
  assert.equal('owner' in (await old.pending())[0], false, 'without the option, as before');

  const outbox = createOutbox({ local, locks: null, owner: () => 7, send: async (op) => { sent.push(op.path); return {}; } });
  await outbox.add({ method: 'PATCH', path: '/api/tasks/2', body: {} });
  const theirs = createOutbox({ local, locks: null, owner: () => 8 });
  await theirs.add({ method: 'PATCH', path: '/api/tasks/3', body: {} });
  assert.equal(await outbox.keepOnly(7), 2, 'the unowned one and the other account’s');
  assert.deepEqual((await outbox.pending()).map((op) => op.path), ['/api/tasks/2']);

  await old.add({ method: 'PATCH', path: '/api/tasks/4', body: {} });
  await outbox.flush();
  assert.deepEqual(sent, ['/api/tasks/2', '/api/tasks/4'], 'one without an owner goes, as it always did');
  outbox.stop(); old.stop(); theirs.stop();
});

/* --------------------------- what waits, counted --------------------------- */

/** IndexedDB as much as counting needs: databases with stores of so many records. */
function fakeIndexedDB(dbs) {
  const deleted = [];
  const later = (req, result) => { setTimeout(() => { req.result = result; req.onsuccess?.(); }, 1); return req; };
  return {
    deleted,
    databases: async () => Object.keys(dbs).map((name) => ({ name })),
    open(name) {
      const stores = dbs[name] || {};
      return later({}, {
        objectStoreNames: { contains: (store) => store in stores },
        transaction: (store) => ({ objectStore: () => ({ count: () => later({}, stores[store]) }) }),
        close() {},
      });
    },
    deleteDatabase(name) { deleted.push(name); return later({}, undefined); },
  };
}

test('pendingChanges counts what waits in every app’s copy, and the preferences kept, without opening anything else', async () => {
  const idb = fakeIndexedDB({
    'tasks-local': { outbox: 2, cache: 40 }, 'notes-local': { outbox: 1 }, 'next-local': { meta: 1 }, 'other-db': { outbox: 9 },
  });
  assert.equal(await pendingChanges({ indexedDB: idb }), 3);
  queueSetting('PUT', '/api/me/look', { look: 'clean' }, 7);
  assert.equal(await pendingChanges({ indexedDB: idb }), 4, 'a preference waiting is a change too');
  forgetSettings();
  assert.equal(await pendingChanges({ indexedDB: {} }), 0, 'a browser that can’t list them: nothing to count');
});

/* -------------------------------- signing out ------------------------------- */

test('signing out with changes waiting asks first; no means nothing happens', async () => {
  globalThis.indexedDB = fakeIndexedDB({ 'tasks-local': { outbox: 2 }, 'proyectos-local': { outbox: 1 } });
  routes = { 'POST /api/auth/logout': { data: { ok: true } } };
  try {
    const counts = [];
    happened.length = 0;
    asked.length = 0;
    assert.equal(await signOut({ ask: async (n) => { counts.push(n); return false; } }), false);
    assert.deepEqual(counts, [3], 'told how many, of every module');
    assert.deepEqual(asked, [], 'the server is not asked');
    assert.deepEqual(globalThis.indexedDB.deleted, [], 'and nothing is deleted');
    assert.deepEqual(happened, []);

    let before = 0;
    assert.equal(await signOut({ ask: async () => true, before: () => { before++; } }), true);
    assert.deepEqual(asked, ['POST /api/auth/logout']);
    assert.equal(before, 1, 'what the app does before letting go, once the server has heard');
    assert.deepEqual(globalThis.indexedDB.deleted.sort(), ['proyectos-local', 'tasks-local']);
    assert.deepEqual(happened, ['reload']);
  } finally {
    delete globalThis.indexedDB;
  }
});

test('without a signal signing out lets go of nothing: the session still counts at the server', async () => {
  globalThis.indexedDB = fakeIndexedDB({ 'tasks-local': { outbox: 0 } });
  try {
    for (const route of ['offline', { status: 503, data: { error: 'unavailable' } }]) {
      routes = { 'POST /api/auth/logout': route };
      happened.length = 0;
      let before = 0;
      assert.equal(await signOut({ before: () => { before++; } }), false, `${route.status || route}: it stays`);
      assert.deepEqual(globalThis.indexedDB.deleted, [], 'every copy and its queue stay');
      assert.deepEqual(happened, [], 'and the page stays');
      assert.equal(before, 0);
    }
    // A session that had already ended has nothing left at the server: the device lets go, as always.
    routes = { 'POST /api/auth/logout': { status: 401, data: { error: 'unauthorized' } } };
    assert.equal(await signOut(), true);
    assert.deepEqual(globalThis.indexedDB.deleted, ['tasks-local']);
    assert.deepEqual(happened, ['reload']);
  } finally {
    delete globalThis.indexedDB;
  }
});

test('the strings of leaving are in every language', () => {
  for (const lang of ['en', 'es', 'de', 'fr', 'it']) {
    const words = JSON.parse(fs.readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const key of ['kit.account.unsent', 'kit.account.signOutAnyway', 'kit.account.unsentDetail', 'kit.account.signOutOffline']) {
      assert.ok(words[key], `${lang}: ${key}`);
    }
  }
  assert.ok(ApiError);
});
