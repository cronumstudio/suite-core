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
 */

const BASE_STORES = ['outbox', 'meta'];

const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/**
 * @param {string} app          the app's id: the database is `<app>-local`
 * @param {Array<string>} stores the app's own stores, besides 'outbox' and 'meta'
 */
export function openLocal(app, stores = [], { indexedDB: idb = globalThis.indexedDB } = {}) {
  const name = `${app}-local`;
  const wanted = [...new Set([...BASE_STORES, ...stores])];
  let opening = null;

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

  async function db() {
    opening ??= (async () => {
      const current = await open();
      if (wanted.every((store) => current.objectStoreNames.contains(store))) return current;
      const next = current.version + 1;
      current.close();
      return open(next);
    })().catch((err) => { opening = null; throw err; });
    return opening;
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

  return {
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
  };
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
  return {
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
  };
}
