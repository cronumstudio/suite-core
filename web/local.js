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
  return {
    get: async (store, key) => clone(of(store).get(key)),
    put: async (store, key, value) => { of(store).set(key, clone(value)); },
    delete: async (store, key) => { of(store).delete(key); },
    entries: async (store) => [...of(store)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, clone(v)]),
    clear: async (store) => { of(store).clear(); },
    clearAll: async () => { stores.clear(); },
  };
}
