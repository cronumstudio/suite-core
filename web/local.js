/**
 * What an app keeps on the device: the copy of what it has shown (to work
 * without a signal) and the outbox of changes still to send. In IndexedDB,
 * not localStorage: notes and images don't fit in localStorage's few
 * megabytes, and a write there blocks the page.
 *
 * A database per app (`<app>-local`) with named stores of key → value. A
 * store the app adds later is created on the next open: the database's
 * version goes up by one, and other tabs let go of theirs so it can.
 *
 *   const local = openLocal('notes', ['notes', 'notebooks']);
 *   await local.put('notes', note.id, note);
 *   const all = await local.entries('notes');   // [[key, value]…], by key
 *
 * For a queue (the outbox), what doesn't read every value: `count` (keys
 * only), `first` (one record) and `rewrite` (one pass, in one transaction).
 *
 * IndexedDB can hang: an upgrade another tab blocks, a browser's bug, and the
 * open never answers. An app that draws itself from its copy before the server
 * answers waited for it with a blank page. With `patience` (LOCAL_PATIENCE_MS),
 * what waits for a database that hasn't opened by then gives up
 * (`local_store_slow`) and isn't done, and until that open answers whatever
 * comes next gives up at once: the app goes on as if the device kept nothing.
 * Once it opens, all is as before; a transaction that has started is waited for.
 *
 * Whose the copy is, and what goes when someone else signs in: createDeviceCopy.
 */

const BASE_STORES = ['outbox', 'meta'];

/** How long an app that draws from its copy waits for the device: past it, it goes on without. */
export const LOCAL_PATIENCE_MS = 1500;

const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** Rejects (`local_store_slow`) once `ms` have passed with `promise` still unsettled; otherwise never settles. */
function deadline(promise, ms) {
  const late = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('local_store_slow')), ms);
    // A page closes whenever it likes; a test or a worker isn't kept open by it.
    timer.unref?.();
    promise.then(() => clearTimeout(timer), () => clearTimeout(timer));
  });
  // Every operation races it: a rejection nobody was waiting for is no error.
  late.catch(() => {});
  return late;
}

/**
 * One transaction over `names`: the records `reads` asks for are read, and what `decide` makes of
 * them is done in it, from the last read's own callback (an await in between could let it end).
 */
function settle(database, names, reads, decide) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(names, 'readwrite');
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
    const asked = reads.map(([store, key]) => tx.objectStore(store).get(key));
    const apply = () => {
      let plan;
      try {
        plan = decide(asked.map((req) => req.result)) || {};
      } catch (err) {
        // All or nothing: nothing is written.
        reject(err);
        tx.abort();
        return;
      }
      for (const store of plan.clear === 'all' ? names : plan.clear || []) tx.objectStore(store).clear();
      for (const [store, key, value] of plan.put || []) tx.objectStore(store).put(value, key);
      result = plan.result;
    };
    // The requests of a transaction answer in order: the last one's answer says all the others came.
    if (asked.length) asked[asked.length - 1].onsuccess = apply;
    else apply();
  });
}

/**
 * @param {string} app          the app's id: the database is `<app>-local`
 * @param {Array<string>} stores the app's own stores, besides 'outbox' and 'meta'
 * @param {number} [options.patience] ms what is asked waits for the database to open; none: as long as it takes
 */
export function openLocal(app, stores = [], { indexedDB: idb = globalThis.indexedDB, patience = 0 } = {}) {
  const name = `${app}-local`;
  const wanted = [...new Set([...BASE_STORES, ...stores])];
  let opening = null;
  /** Rejects when the open under way takes longer than `patience`: what waits for it gives up. None once open. */
  let late = null;

  const open = (version) => new Promise((resolve, reject) => {
    const req = version ? idb.open(name, version) : idb.open(name);
    req.onupgradeneeded = () => {
      for (const store of wanted) if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab needs a newer version: let go, and open again when next asked.
      db.onversionchange = () => { db.close(); opening = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('local_store_blocked'));
  });

  /** The database, opened on first use (again after another tab's upgrade, or a failure), however long that takes. */
  function opened() {
    if (!opening) {
      const current = (async () => {
        const db = await open();
        if (wanted.every((store) => db.objectStoreNames.contains(store))) return db;
        const next = db.version + 1;
        db.close();
        return open(next);
      })().catch((err) => {
        if (opening === current) opening = null;
        throw err;
      });
      opening = current;
      late = patience > 0 ? deadline(current, patience) : null;
      // Open, nothing races the deadline any more: each race would stay waiting on it for good.
      current.then(() => { if (opening === current) late = null; }, () => {});
    }
    return opening;
  }

  /** The database for what gives up when it doesn't open in time; once it has opened, at once, late or not. */
  function db() {
    const current = opened();
    return late ? Promise.race([current, late]) : current;
  }

  async function run(store, mode, work) {
    const tx = (await db()).transaction(store, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
    done.catch(() => {});   // awaited below; when the work fails first, its error is the one that counts
    const result = await work(tx.objectStore(store));
    await done;
    return result;
  }

  const local = {
    get: (store, key) => run(store, 'readonly', (s) => request(s.get(key))),
    put: (store, key, value) => run(store, 'readwrite', (s) => request(s.put(value, key))),
    delete: (store, key) => run(store, 'readwrite', (s) => request(s.delete(key))),
    /** Every [key, value] of a store, in key order. */
    entries: (store) => run(store, 'readonly', async (s) => {
      const [keys, values] = await Promise.all([request(s.getAllKeys()), request(s.getAll())]);
      return keys.map((key, i) => [key, values[i]]);
    }),
    /** How many records a store has, without reading them. */
    count: (store) => run(store, 'readonly', (s) => request(s.count())),
    /** The first [key, value] in key order, or undefined: one record read, not the whole store. */
    first: (store) => run(store, 'readonly', async (s) => {
      const cursor = await request(s.openCursor());
      return cursor ? [cursor.key, cursor.value] : undefined;
    }),
    /**
     * One pass over a store in one transaction: `change(value, key)` returns the value to keep in
     * its place, or undefined to leave it. → how many changed.
     */
    rewrite: (store, change) => run(store, 'readwrite', (s) => new Promise((resolve, reject) => {
      // Read in two requests (a cursor is a round trip per record), written back in the same
      // transaction, from the requests' own callbacks: an await in between could let it end.
      const keys = s.getAllKeys();
      const values = s.getAll();
      keys.onerror = () => reject(keys.error);
      values.onerror = () => reject(values.error);
      values.onsuccess = () => {
        const writes = [];
        try {
          keys.result.forEach((key, i) => {
            const next = change(values.result[i], key);
            if (next !== undefined) writes.push([key, next]);
          });
        } catch (err) {
          // All or nothing: nothing is written.
          return reject(err);
        }
        for (const [key, next] of writes) s.put(next, key);
        return resolve(writes.length);
      };
    })),
    clear: (store) => run(store, 'readwrite', (s) => request(s.clear())),
    /** Everything, every store: on signing out, one person's notes don't stay for the next. */
    clearAll: async () => {
      for (const store of wanted) await run(store, 'readwrite', (s) => request(s.clear()));
    },
    /**
     * Some records read and, from what they say, the store changed, in one transaction over every
     * store: nothing else on the device comes in between. `reads`: [[store, key]…]; `decide(values)`
     * → { clear: [store…] or 'all', put: [[store, key, value]…], result }. → its `result`.
     *
     * Done once the database opens, however long that takes: its caller waits for the open no longer
     * than for anything else (`patience`), and it still happens then, before whatever is asked after
     * it. Whose the copy is (createDeviceCopy) must hold before the outbox reads what to send.
     */
    update: (reads, decide) => {
      const current = opened();
      const go = (database) => settle(database, wanted, reads, decide);
      // In its turn among what was asked, as `run` takes it; past `patience` it waits on for the open.
      const waited = late ? Promise.race([current, late]) : current;
      const done = waited.then(go, () => current.then(go));
      done.catch(() => {});
      return late ? waited.then(() => done) : done;
    },
    /** Whose what this store keeps is: createDeviceCopy on it, for code that is handed the store and imports nothing. */
    deviceCopy: (options) => createDeviceCopy({ ...options, local }),
  };
  return local;
}

/** The same, in memory: for tests, and for a browser that refuses IndexedDB (a private window). */
export function memoryLocal() {
  const stores = new Map();
  const of = (store) => {
    if (!stores.has(store)) stores.set(store, new Map());
    return stores.get(store);
  };
  const clone = (value) => (value === undefined ? undefined : structuredClone(value));
  const sorted = (store) => [...of(store)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const local = {
    get: async (store, key) => clone(of(store).get(key)),
    put: async (store, key, value) => { of(store).set(key, clone(value)); },
    delete: async (store, key) => { of(store).delete(key); },
    entries: async (store) => sorted(store).map(([k, v]) => [k, clone(v)]),
    count: async (store) => of(store).size,
    first: async (store) => {
      let first;
      for (const key of of(store).keys()) if (first === undefined || key < first) first = key;
      return first === undefined ? undefined : [first, clone(of(store).get(first))];
    },
    rewrite: async (store, change) => {
      let changed = 0;
      for (const [key, value] of sorted(store)) {
        const next = change(clone(value), key);
        if (next !== undefined) {
          of(store).set(key, clone(next));
          changed += 1;
        }
      }
      return changed;
    },
    clear: async (store) => { of(store).clear(); },
    clearAll: async () => { stores.clear(); },
    update: async (reads, decide) => {
      const plan = decide(reads.map(([store, key]) => clone(of(store).get(key)))) || {};
      if (plan.clear === 'all') stores.clear();
      else for (const store of plan.clear || []) of(store).clear();
      for (const [store, key, value] of plan.put || []) of(store).set(key, clone(value));
      return plan.result;
    },
    deviceCopy: (options) => createDeviceCopy({ ...options, local }),
  };
  return local;
}

/** An app's store as the apps that draw from it open it: IndexedDB with LOCAL_PATIENCE_MS, or memory without one. */
export const deviceLocal = (app, stores = []) => (globalThis.indexedDB
  ? openLocal(app, stores, { patience: LOCAL_PATIENCE_MS })
  : memoryLocal());

/**
 * What `promise` gives, or null once `ms` have passed without it (or when it fails): a read of the
 * device's copy that the start waits for, and may go on without.
 */
export function inTime(promise, ms = LOCAL_PATIENCE_MS) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, null);
    timer.unref?.();
  });
  return Promise.race([promise, late]).catch(() => null).finally(() => clearTimeout(timer));
}

/** Whether two ids are the same account's: the server's numbers, or the same as text. */
export const sameAccount = (a, b) => a != null && b != null && String(a) === String(b);

/**
 * Whether the copy kept for account `id` may be drawn while Cronum Work's shell says account `host`
 * (its id: a window's `services.user()`) is signed in: not for someone else, not even for the moment
 * the server takes to answer. The session of whoever was here last can end without signing out (it
 * expires, «sign out everywhere», an admin), and the next person signing in saw their copy. Without
 * the shell, or before it knows (null), the server's answer decides, as always.
 */
export const drawableFor = (id, host) => host == null || sameAccount(id, host);

/**
 * Whose the copy on this device is, and what goes when someone else signs in: the rules of every app
 * that draws itself from its copy before the server answers. The copy and the changes waiting in the
 * outbox are one person's. A session can end without signing out and someone else sign in on the
 * same browser: nothing of the first is drawn for the second (drawableFor, until the server says
 * who it is), and nothing they left unsent goes as the second.
 *
 * - `kept()`: the account the copy is of, as the server last gave it; null when there is none, when
 *   the copy isn't tied to it (kept before it was), or when the device doesn't answer in time.
 * - `claim(user)`: the server said `user` is signed in. Changes of someone else waiting: they go, and
 *   everything of theirs with them. A copy that isn't `user`'s: it goes, the changes stay (theirs).
 *   One transaction, done even when the device answers late, before anything asked after it:
 *   nothing waiting is sent as someone else. → 'all', 'copy', or null when it was all theirs.
 * - `forget()`: a session gone. The copy goes, and whose the changes are stays: the same person
 *   signing in again sends them, someone else's claim lets them go. `{ outbox: true }`: signing
 *   out, everything goes.
 *
 * Where in `meta` an app keeps whose its copy is stays its own: a device's copy from before is read
 * as it was. Each key is null when the app doesn't keep that apart.
 * @param {object} options.local          the app's store (openLocal, memoryLocal)
 * @param {Array<string>} options.stores  the stores the copy is in: emptied when it goes
 * @param {string|null} [options.account] the account the copy is of ({ id, … }); null: the app keeps it
 *                                        with the copy, and tells `claim` whose it was (`was`)
 * @param {string|null} [options.owner]   the id the copy is tied to, apart from the account
 * @param {string|null} [options.outbox]  whose the changes waiting are, apart from the account: needed
 *                                        to forget the copy and keep the changes
 * @param {number} [options.patience]     ms a read of these is waited for, past which there is none
 */
export function createDeviceCopy({ local, stores = [], account = 'user', owner = null, outbox = null, patience = LOCAL_PATIENCE_MS }) {
  /** A record the app keeps in `meta` beside the copy (its settings, whose it is), or null: none, or not in time. */
  const read = (key) => inTime(local.get('meta', key), patience);

  /** The account the copy is of, or null. */
  async function accountOf() {
    if (!account) return null;
    const kept = await read(account);
    return kept?.id != null ? kept : null;
  }

  async function kept() {
    const [who, tie] = await Promise.all([accountOf(), owner ? read(owner) : null]);
    return who && (!owner || sameAccount(tie, who.id)) ? who : null;
  }

  /** Whose the changes waiting are: as the device says, else the copy's account's (kept before it said so), or null. */
  async function outboxOwner() {
    const [holder, who] = await Promise.all([outbox ? read(outbox) : null, accountOf()]);
    return holder ?? who?.id ?? null;
  }

  /** Reads `keys` of `meta` in one update, and hands `decide` a getter of each. */
  const updateMeta = (keys, decide) => {
    const asked = keys.filter(Boolean);
    return local.update(asked.map((key) => ['meta', key]), (values) => decide((key) => (key ? values[asked.indexOf(key)] : undefined)));
  };

  /** `was`: whose the copy was, for an app that keeps its account with the copy (`account` null). */
  function claim(user, { was = null } = {}) {
    return updateMeta([account, owner, outbox], (at) => {
      // Who used the app here last: whose the changes are, when the device doesn't keep that apart.
      const last = account ? at(account)?.id ?? null : was;
      const tied = owner ? at(owner) ?? null : last;
      const changes = (outbox ? at(outbox) : null) ?? last;
      const theirs = [owner, outbox].filter(Boolean).map((key) => ['meta', key, user.id]);
      if (changes != null && !sameAccount(changes, user.id)) return { clear: 'all', put: theirs, result: 'all' };
      const put = theirs.filter(([, key]) => at(key) !== user.id);
      if (!sameAccount(tied, user.id)) return { clear: stores, put, result: 'copy' };
      return { put, result: null };
    });
  }

  function forget({ outbox: changes = false } = {}) {
    if (changes) return local.update([], () => ({ clear: 'all' }));
    return updateMeta([outbox, account], (at) => {
      const holder = (outbox ? at(outbox) : null) ?? (account ? at(account)?.id : null) ?? null;
      return { clear: [...stores, 'meta'], put: outbox && holder != null ? [['meta', outbox, holder]] : [] };
    });
  }

  return { account: accountOf, kept, outboxOwner, read, claim, forget };
}
