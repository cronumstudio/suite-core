/**
 * What an app keeps on the device (web/local.js): an IndexedDB that never opens, or opens late,
 * makes nothing wait past the store's patience, and the change of whose the copy is happens anyway,
 * before anything after it reads (`update`); and the rules of whose the copy and the changes waiting
 * are (createDeviceCopy), as Notes, Next and Projects keep them on their devices.
 *
 *   npm test (node --test test/web-local.test.js for this alone)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openLocal, memoryLocal, deviceLocal, inTime, sameAccount, drawableFor, createDeviceCopy, LOCAL_PATIENCE_MS,
} from '../web/local.js';

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * IndexedDB as much as local.js uses, in memory. Opens wait while `hold()`s them (for good, unless
 * `release()`), and transactions take their turns as in a browser: one that shares a store with an
 * earlier one, either of them writing, starts once that one has finished.
 */
function fakeIndexedDB() {
  const dbs = new Map();
  const live = [];
  let held = null;
  let scheduled = false;
  const fake = { opens: 0, transactions: [], afterOpen: null };
  const clone = (value) => (value === undefined ? undefined : structuredClone(value));
  const sortedKeys = (data) => [...data.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const runnable = (tx) => !live.slice(0, live.indexOf(tx)).some((other) => other.names.some((n) => tx.names.includes(n))
    && (other.mode === 'readwrite' || tx.mode === 'readwrite'));
  const finish = (tx, how) => {
    live.splice(live.indexOf(tx), 1);
    if (how === 'abort') tx.onabort?.();
    else tx.oncomplete?.();
  };
  // One request a turn; a transaction with nothing more asked, once its turn comes, is done.
  function step() {
    scheduled = false;
    for (const tx of [...live]) {
      if (!runnable(tx)) continue;
      if (tx.aborted) finish(tx, 'abort');
      else if (tx.queue.length) tx.queue.shift()();
      else finish(tx, 'complete');
      schedule();
      return;
    }
  }
  function schedule() {
    if (scheduled || !live.length) return;
    scheduled = true;
    setTimeout(step, 0);
  }

  function objectStore(db, tx, name) {
    const data = db.stores.get(name);
    const ask = (work) => {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      tx.queue.push(() => {
        req.result = work();
        req.onsuccess?.();
      });
      schedule();
      return req;
    };
    return {
      get: (key) => ask(() => clone(data.get(key))),
      put: (value, key) => ask(() => { data.set(key, clone(value)); return key; }),
      delete: (key) => ask(() => { data.delete(key); }),
      clear: () => ask(() => { data.clear(); }),
      count: () => ask(() => data.size),
      getAll: () => ask(() => sortedKeys(data).map((key) => clone(data.get(key)))),
      getAllKeys: () => ask(() => sortedKeys(data)),
      openCursor: () => ask(() => {
        const [key] = sortedKeys(data);
        return key === undefined ? null : { key, value: clone(data.get(key)) };
      }),
    };
  }

  function connection(db) {
    return {
      get version() { return db.version; },
      objectStoreNames: { contains: (name) => db.stores.has(name) },
      createObjectStore: (name) => { db.stores.set(name, new Map()); },
      close() {},
      transaction(names, mode = 'readonly') {
        const tx = { names: [].concat(names), mode, queue: [], aborted: false, error: null };
        tx.objectStore = (name) => objectStore(db, tx, name);
        tx.abort = () => { tx.aborted = true; };
        live.push(tx);
        fake.transactions.push(`${mode}:${tx.names.join('+')}`);
        schedule();
        return tx;
      },
    };
  }

  fake.open = (name, version) => {
    fake.opens += 1;
    const req = { result: null, error: null };
    const answer = () => {
      if (!dbs.has(name)) dbs.set(name, { version: 0, stores: new Map() });
      const db = dbs.get(name);
      const wanted = version ?? Math.max(db.version, 1);
      req.result = connection(db);
      if (wanted > db.version) {
        db.version = wanted;
        req.onupgradeneeded?.();
      }
      req.onsuccess?.();
      fake.afterOpen?.();
    };
    (held ? held.promise : Promise.resolve()).then(() => setTimeout(answer, 0));
    return req;
  };
  fake.hold = () => {
    let release;
    held = { promise: new Promise((resolve) => { release = resolve; }), release };
  };
  fake.release = () => {
    held?.release();
    held = null;
  };
  return fake;
}

/** What a device kept before: `records` ([store, key, value]…) put through a store opened as always. */
async function seed(idb, app, stores, records) {
  const local = openLocal(app, stores, { indexedDB: idb });
  for (const [store, key, value] of records) await local.put(store, key, value);
}

/* ------------------------------ a hung IndexedDB ----------------------------- */

test('an open that never answers: what waits gives up after the store’s patience, what comes next at once, and nothing is done', async () => {
  const idb = fakeIndexedDB();
  idb.hold();
  const local = openLocal('next', ['views'], { indexedDB: idb, patience: 60 });
  let at = Date.now();
  await assert.rejects(local.get('meta', 'user'), /local_store_slow/);
  assert.ok(Date.now() - at >= 50, 'it waited its patience');
  at = Date.now();
  await assert.rejects(local.put('views', 'board:open', '[]'), /local_store_slow/);
  await assert.rejects(local.entries('outbox'), /local_store_slow/);
  await assert.rejects(local.clearAll(), /local_store_slow/);
  assert.ok(Date.now() - at < 40, 'with the open still late, at once');
  assert.equal(idb.opens, 1, 'no new open while that one is under way');

  // It opens at last: from then on all as before, and what gave up was never done.
  idb.release();
  await pause(20);
  assert.equal(await local.get('views', 'board:open'), undefined);
  await local.put('views', 'board:open', '[1]');
  assert.equal(await local.get('views', 'board:open'), '[1]');
});

test('without patience a slow open is waited for, as before', async () => {
  const idb = fakeIndexedDB();
  idb.hold();
  const local = openLocal('notes', ['notes'], { indexedDB: idb });
  const reading = local.get('meta', 'user');
  setTimeout(() => idb.release(), 80);
  assert.equal(await reading, undefined);
  await local.put('notes', 'n', { id: 1 });
  assert.deepEqual(await local.get('notes', 'n'), { id: 1 });
});

test('an open that answers in time keeps every operation in the order it was asked, an update among them', async () => {
  const idb = fakeIndexedDB();
  await seed(idb, 'next', ['views'], [['outbox', 'k1', { path: '/api/projects/1' }], ['meta', 'outbox-owner', 1]]);
  idb.hold();
  const local = openLocal('next', ['views'], { indexedDB: idb, patience: 500 });
  const before = local.entries('outbox');
  const claiming = local.update([['meta', 'outbox-owner']], ([holder]) => ({
    clear: holder === 1 ? 'all' : [], put: [['meta', 'outbox-owner', 2]], result: holder,
  }));
  const after = local.entries('outbox');
  idb.release();
  assert.equal((await before).length, 1, 'asked before the update: what was there');
  assert.equal(await claiming, 1);
  assert.deepEqual(await after, [], 'asked after it: what it left');
  assert.equal(await local.get('meta', 'outbox-owner'), 2);
});

test('an update asked while the open is late: its caller stops waiting, and it is done once the database opens, before what is asked then', async () => {
  const idb = fakeIndexedDB();
  await seed(idb, 'next', ['views'], [['outbox', 'k1', { path: '/api/projects/1' }], ['meta', 'outbox-owner', 1], ['views', 'board:open', '[]']]);
  idb.hold();
  const local = openLocal('next', ['views'], { indexedDB: idb, patience: 40 });
  await assert.rejects(local.count('outbox'), /local_store_slow/);
  // Ben signs in meanwhile: Ana's changes must go before anything reads what to send.
  const claiming = local.update([['meta', 'outbox-owner']], ([holder]) => (holder === 2 ? {} : { clear: 'all', put: [['meta', 'outbox-owner', 2]] }));
  await assert.rejects(claiming, /local_store_slow/, 'its caller doesn’t wait for it');
  await assert.rejects(local.entries('outbox'), /local_store_slow/, 'nothing reads the outbox meanwhile');

  let reading = null;
  idb.afterOpen = () => setTimeout(() => { reading = local.entries('outbox'); }, 0);
  idb.release();
  while (!reading) await pause(1);
  assert.deepEqual(await reading, [], 'the first read once open finds Ana’s changes gone');
  assert.equal(await local.get('meta', 'outbox-owner'), 2);
  assert.equal(await local.get('views', 'board:open'), undefined);
});

test('update reads, decides and writes in one transaction over every store; a decision that throws writes nothing', async () => {
  const idb = fakeIndexedDB();
  const local = openLocal('notes', ['notes', 'notebooks'], { indexedDB: idb, patience: 500 });
  await local.put('notes', 'list:all:', { notes: [1] });
  await local.put('notebooks', 'x', 1);
  await local.put('meta', 'owner', 3);
  idb.transactions.length = 0;
  const result = await local.update([['meta', 'owner'], ['meta', 'user']], ([tie, who]) => ({
    clear: ['notes'], put: [['meta', 'owner', 8], ['meta', 'seen', [tie, who ?? null]]], result: 'copy',
  }));
  assert.equal(result, 'copy');
  assert.deepEqual(idb.transactions, ['readwrite:outbox+meta+notes+notebooks'], 'one transaction');
  assert.equal(await local.get('notes', 'list:all:'), undefined);
  assert.equal(await local.get('notebooks', 'x'), 1);
  assert.deepEqual(await local.get('meta', 'seen'), [3, null]);
  assert.equal(await local.get('meta', 'owner'), 8);

  await assert.rejects(local.update([['meta', 'owner']], () => { throw new Error('no'); }), /no/);
  assert.equal(await local.get('meta', 'owner'), 8);
  assert.equal(await local.update([], () => ({ clear: 'all' })), undefined);
  assert.equal(await local.count('notebooks'), 0);
  assert.equal(await local.get('meta', 'owner'), undefined);
});

test('memoryLocal’s update does the same', async () => {
  const local = memoryLocal();
  await local.put('notes', 'a', 1);
  await local.put('meta', 'user', { id: 1 });
  const seen = await local.update([['meta', 'user'], ['meta', 'none']], (values) => ({ clear: ['notes'], put: [['meta', 'x', values]], result: values }));
  assert.deepEqual(seen, [{ id: 1 }, undefined]);
  assert.equal(await local.count('notes'), 0);
  assert.deepEqual(await local.get('meta', 'x'), [{ id: 1 }, undefined]);
  await local.update([], () => ({ clear: 'all' }));
  assert.equal(await local.get('meta', 'user'), undefined);
});

/* ------------------------------ whose the copy is ----------------------------- */

const ana = { id: 1, name: 'Ana', prefs: { lang: 'es' } };
const ben = { id: 2, name: 'Ben', prefs: {} };

test('the copy is given only to its account, and only when it is tied to it; an id as text is the same id', async () => {
  const local = memoryLocal();
  const notes = createDeviceCopy({ local, stores: ['notes'], owner: 'owner' });
  assert.equal(await notes.kept(), null, 'nothing kept');
  await local.put('meta', 'user', ana);
  assert.equal(await notes.kept(), null, 'a copy kept before it was tied to anyone');
  assert.deepEqual(await notes.account(), ana);
  await local.put('meta', 'owner', '1');
  assert.deepEqual(await notes.kept(), ana);
  // An app that keeps no tie: the account's own copy.
  assert.deepEqual(await createDeviceCopy({ local, stores: ['views'] }).kept(), ana);
  assert.equal(await createDeviceCopy({ local, stores: ['copy'], account: null }).kept(), null);
  await local.put('meta', 'user', { name: 'nobody' });
  assert.equal(await notes.kept(), null, 'an account without an id is nobody');
});

test('claim: the same person keeps everything; a copy not tied to them goes and their changes stay; someone else’s changes take everything with them', async () => {
  const local = memoryLocal();
  const notes = local.deviceCopy({ stores: ['notes', 'notebooks'], owner: 'owner' });
  await local.put('meta', 'user', ana);
  await local.put('notes', 'list:all:', { notes: [5] });
  await local.put('outbox', 'k1', { path: '/api/notes/5' });
  assert.equal(await notes.claim(ana), 'copy', 'kept before it was tied: the copy goes');
  assert.equal(await local.get('notes', 'list:all:'), undefined);
  assert.ok(await local.get('outbox', 'k1'), 'her changes stay');
  assert.equal(await local.get('meta', 'owner'), 1);

  await local.put('notes', 'list:all:', { notes: [5] });
  assert.equal(await notes.claim({ ...ana, name: 'Ana B.' }), null, 'the same person: nothing goes');
  assert.ok(await local.get('notes', 'list:all:'));

  assert.equal(await notes.claim(ben), 'all', 'someone else: everything goes');
  assert.equal(await local.count('outbox'), 0);
  assert.equal(await local.get('meta', 'user'), undefined, 'the account is the app’s to write');
  assert.equal(await local.get('meta', 'owner'), 2);
});

test('the changes waiting are whose the device says, else the copy’s account’s; forgetting the copy keeps that, signing out doesn’t', async () => {
  const local = memoryLocal();
  const next = local.deviceCopy({ stores: ['views'], outbox: 'outbox-owner' });
  assert.equal(await next.outboxOwner(), null);
  await local.put('meta', 'user', ana);
  assert.equal(await next.outboxOwner(), 1, 'kept before the outbox had an owner: the copy’s account’s');
  await local.put('views', 'board:open', '[]');
  await local.put('meta', 'recent', ['board:open']);
  await local.put('outbox', 'k1', { path: '/api/projects/1' });
  assert.equal(await next.claim(ana), null);
  assert.equal(await local.get('meta', 'outbox-owner'), 1);

  // A session gone: the copy goes, whose the changes are stays.
  await next.forget();
  assert.equal(await local.count('views'), 0);
  assert.equal(await local.get('meta', 'user'), undefined);
  assert.equal(await local.get('meta', 'recent'), undefined);
  assert.equal(await next.outboxOwner(), 1);
  assert.equal(await local.count('outbox'), 1);
  assert.equal(await next.claim(ana), 'copy', 'the same person again: their changes stay');
  assert.equal(await local.count('outbox'), 1);
  await next.forget();
  assert.equal(await next.claim(ben), 'all', 'anyone else: they go');
  assert.equal(await local.count('outbox'), 0);
  assert.equal(await next.outboxOwner(), 2);

  await local.put('outbox', 'k2', { path: '/api/projects/2' });
  await next.forget({ outbox: true });
  assert.equal(await local.count('outbox'), 0, 'signing out: everything');
  assert.equal(await next.outboxOwner(), null);
});

test('an app that keeps its account with the copy says whose it was (`was`); its changes are whose the device says, else that account’s', async () => {
  const local = memoryLocal();
  const projects = local.deviceCopy({ stores: ['copy'], account: null, outbox: 'queue-owner' });
  await local.put('copy', 'workspace', { owner: 1, user: ana });
  await local.put('outbox', 'a', { path: '/api/tasks/7' });
  assert.equal(await projects.claim(ana, { was: 1 }), null);
  assert.equal(await local.get('meta', 'queue-owner'), 1);
  assert.equal(await projects.claim(ana, { was: null }), 'copy', 'no copy of hers yet: nothing of anyone to keep');
  assert.equal(await local.count('outbox'), 1, 'her changes stay');

  // Kept before the queue had an owner: the copy's.
  await local.clearAll();
  await local.put('copy', 'workspace', { owner: 1, user: ana });
  await local.put('outbox', 'a', { path: '/api/tasks/7' });
  assert.equal(await projects.claim(ben, { was: 1 }), 'all');
  assert.equal(await local.count('outbox'), 0);
  assert.equal(await local.get('copy', 'workspace'), undefined);
  assert.equal(await local.get('meta', 'queue-owner'), 2);

  // Nobody known at all: nothing of anyone goes but the copy.
  await local.clearAll();
  await local.put('outbox', 'b', { path: '/api/tasks/8' });
  assert.equal(await projects.claim(ben), 'copy');
  assert.equal(await local.count('outbox'), 1);
  await projects.forget();
  assert.equal(await local.get('meta', 'queue-owner'), 2, 'a session gone keeps whose the queue is');
});

test('with the device hung, whose the copy is reads as nobody in time, and a claim still happens before anything reads once it opens', async () => {
  const idb = fakeIndexedDB();
  await seed(idb, 'next', ['views'], [['meta', 'user', ana], ['views', 'board:open', '[]'], ['outbox', 'k1', { path: '/api/projects/1' }]]);
  idb.hold();
  const local = openLocal('next', ['views'], { indexedDB: idb, patience: 40 });
  const next = local.deviceCopy({ stores: ['views'], outbox: 'outbox-owner', patience: 40 });
  const at = Date.now();
  assert.equal(await next.kept(), null);
  assert.equal(await next.outboxOwner(), null);
  await assert.rejects(next.claim(ben), /local_store_slow/);
  assert.ok(Date.now() - at < 400, 'nothing waited for good');

  let reading = null;
  idb.afterOpen = () => setTimeout(() => { reading = local.entries('outbox'); }, 0);
  idb.release();
  while (!reading) await pause(1);
  assert.deepEqual(await reading, [], 'Ana’s change never reaches the outbox’s next read');
  assert.equal(await next.outboxOwner(), 2);
});

/* --------------------------------- the pieces --------------------------------- */

test('drawableFor: not for someone else the shell says is signed in; without the shell, as always', () => {
  assert.equal(drawableFor(1, 2), false);
  assert.equal(drawableFor(1, 1), true);
  assert.equal(drawableFor(1, '1'), true, 'an id as text is the same id');
  assert.equal(drawableFor(1, null), true, 'on its own page, or before the shell knows');
  assert.equal(drawableFor(1, undefined), true);
  assert.equal(drawableFor(null, 2), false, 'nobody’s copy, someone signed in: not for them');
  assert.equal(sameAccount(null, null), false);
  assert.equal(sameAccount(0, '0'), true);
});

test('inTime: the answer, or null once past its time or failed; deviceLocal: memory without IndexedDB, patience with it', async () => {
  assert.equal(await inTime(Promise.resolve(7), 50), 7);
  assert.equal(await inTime(new Promise(() => {}), 20), null);
  assert.equal(await inTime(Promise.reject(new Error('x')), 50), null);
  assert.equal(LOCAL_PATIENCE_MS, 1500);

  const memory = deviceLocal('next', ['views']);
  await memory.put('views', 'a', 1);
  assert.equal(await memory.get('views', 'a'), 1);
  const idb = fakeIndexedDB();
  idb.hold();
  globalThis.indexedDB = idb;
  try {
    const local = deviceLocal('proyectos', ['copy']);
    const at = Date.now();
    await assert.rejects(local.get('copy', 'workspace'), /local_store_slow/);
    assert.ok(Date.now() - at >= LOCAL_PATIENCE_MS - 50, 'the apps’ patience');
  } finally {
    delete globalThis.indexedDB;
  }
});
