/**
 * Changes made without a signal, kept on the device and sent when it comes
 * back. Taken from Tasks (offline.js) and moved to IndexedDB (local.js).
 *
 * The things that look like details and are not, all learnt in Tasks:
 *
 * - Every change has an id, sent as its `Idempotency-Key`: if the answer is
 *   lost and the change goes again, the server answers what it did the first
 *   time instead of doing it twice (suite-core idempotency.js).
 * - Something created offline has a provisional id (`tempId`), and what was
 *   done to it afterwards points at that id. When the creation goes through,
 *   the real id replaces it in every change still queued —stored, not only
 *   in memory, or closing the app half way lost them—.
 * - It stops when the signal goes again or the session has ended (401), and
 *   leaves the rest for later: a queue, not a burst. A server error (5xx) also
 *   waits, and so does a server that says it is busy (429, also 408 and 425):
 *   with the signal back the page, the new worker and the queue start at once,
 *   and something before the server answered a burst with 429, which dropped
 *   the changes one after another (audit of 6/11, sc-shell-11). Listening, it
 *   tries again when the server said (`Retry-After`), or in half a minute. A
 *   conflict (409) goes to the app, which decides (Notes keeps a conflict
 *   copy); anything else that can't be fixed by retrying is dropped and
 *   reported.
 * - The browser may clear what a site keeps when the disk fills up, and Safari
 *   does after a week unused in a tab: a change kept here is the only copy of
 *   it, so the first one asks for the storage to be kept (`persist()`; Chrome
 *   decides alone, Firefox asks, and at that moment the question makes sense).
 * - With the app off the page (a module of Cronum Work not on screen), what
 *   goes cleanly is sent by `sendWhileAway`, and the rest waits for the app.
 * - Several tabs share the queue: one sends at a time (a Web Lock), and a
 *   change leaves the queue by its id, never by its place.
 * - Nothing reads the whole queue to count it or to take the next change: an
 *   afternoon without a signal is hundreds of changes (whole notes, in
 *   Notes), and reading them all on every change made adding and sending
 *   them quadratic, just when the signal came back. Counting reads keys only,
 *   the next change is one record, and a provisional id is swapped in one
 *   pass in one transaction (local.js `count`, `first`, `rewrite`).
 * - A change is someone's (`owner`): a session can end with changes waiting
 *   and someone else sign in on the same browser, and the cookie then is
 *   theirs. Each change keeps whose it is, nothing goes while the app doesn't
 *   know who is signed in, and one of another account never goes: it leaves
 *   the queue (`report.others`), and `keepOnly(id)` lets go of them at once.
 *   A change kept before it had an owner goes as it always did.
 *
 *   const outbox = createOutbox({ local, owner: () => user?.id, onConflict, onDropped, onCount: (n) => … });
 *   await outbox.add({ method: 'POST', path: '/api/notes', body, tempId: 'tmp-…' });
 *   outbox.flush();   // also by itself when the browser says it is online again
 */
import { api, Offline, SessionExpired, ApiError } from './api.js';

const STORE = 'outbox';
let counter = 0;

/** A key that sorts by time of creation, then by order within the same millisecond. */
const orderKey = (ts) => `${ts.toString(36).padStart(10, '0')}-${(counter++).toString(36).padStart(4, '0')}`;

const newId = () => (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

/** A provisional id: what the app uses for something created offline until the server gives its own. */
export const tempId = () => `tmp-${newId()}`;
export const isTempId = (value) => typeof value === 'string' && value.startsWith('tmp-');

/** Replaces a provisional id in a path (a whole segment) and in a body (values equal to it). */
function swapId(op, from, to) {
  const segment = new RegExp(`/${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=/|\\?|$)`, 'g');
  const swap = (value) => {
    if (value === from) return to;
    if (Array.isArray(value)) return value.map(swap);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)]));
    return value;
  };
  return { ...op, path: op.path.replace(segment, `/${to}`), body: swap(op.body) };
}

const TEMP_IN_PATH = /\/tmp-[\w-]+(?=\/|\?|$)/;

/** A server that says it is busy, or that took too long or too early: the change waits, it isn't refused. */
const BUSY = new Set([408, 425, 429]);
/** When the server said nothing of how long: half a minute. Never more than five. */
const RETRY_MS = 30000;
const RETRY_MAX_MS = 300000;

/** Whether an error leaves the change, and the rest, for later: no signal, a session ended, the server in trouble or busy. */
export const waits = (error) => error instanceof Offline || error instanceof SessionExpired
  || error?.status >= 500 || BUSY.has(error?.status) || error?.code === 'idempotency_in_progress';

/**
 * How long to wait before trying again after `error`, or null when it isn't the server being busy: a
 * 429, 408 or 425, or a 503 that says when (one that doesn't, a deploy or an app not ready yet, waits
 * for the signal or the app's own next send).
 */
const busyFor = (error) => (BUSY.has(error?.status) || (error?.status === 503 && error.retryAfter != null)
  ? Math.min(Math.max(Number(error.retryAfter) || RETRY_MS, 1000), RETRY_MAX_MS)
  : null);

let keepAsked = false;
/** The storage kept, asked once per page: the browser decides, and asks the person if it wants to. */
function askToKeep(storage = globalThis.navigator?.storage) {
  if (keepAsked || typeof storage?.persist !== 'function') return;
  keepAsked = true;
  Promise.resolve(storage.persisted?.()).then((kept) => (kept ? true : storage.persist())).catch(() => {});
}

/** The queue's reads on a store: its own where it has them (local.js), everything read where it doesn't (an app's own). */
function queueOf(local) {
  const entries = () => local.entries(STORE);
  return {
    entries,
    size: () => (local.count ? local.count(STORE) : entries().then((all) => all.length)),
    first: () => (local.first ? local.first(STORE) : entries().then(([head]) => head)),
    rewrite: async (change) => {
      if (local.rewrite) return local.rewrite(STORE, change);
      let changed = 0;
      for (const [key, value] of await entries()) {
        const next = change(value, key);
        if (next !== undefined) { await local.put(STORE, key, next); changed += 1; }
      }
      return changed;
    },
  };
}

/** What was done offline to something just created now points at its real id, in the stored queue. */
const pointAtReal = (queue, provisional, realId) => queue.rewrite((other) => {
  const swapped = swapId(other, provisional, String(realId));
  return swapped.path !== other.path || JSON.stringify(swapped.body) !== JSON.stringify(other.body) ? swapped : undefined;
});

/**
 * @param {object} options
 * @param {object} options.local          from openLocal() (or memoryLocal())
 * @param {Function} [options.send]       (op) → the server's answer; default: api.js with the op's id as Idempotency-Key
 * @param {Function} [options.onConflict] ({ op, error }) → the server said 409: the app decides
 * @param {Function} [options.onDropped]  ({ op, error }) → a change that couldn't go and was dropped
 * @param {Function} [options.onCreated]  ({ op, tempId, id, answer }) → a provisional id became a real one
 * @param {Function} [options.onCount]    (n) → how many changes wait
 * @param {Function} [options.idOf]       (answer) → the real id of what a creation made (default: answer.id)
 * @param {Function} [options.owner]      () → the id of whoever is signed in, as the server said (null: not known
 *                                        yet); each change keeps it, and only theirs is sent. Without it, as before.
 * @param {string}   [options.lockName]
 */
export function createOutbox({
  local, send = (op) => api.write(op.method, op.path, op.body, { key: op.id }),
  onConflict = () => {}, onDropped = () => {}, onCreated = () => {}, onCount = () => {}, idOf = (answer) => answer?.id,
  lockName = 'kit-outbox', locks = globalThis.navigator?.locks, now = Date.now, owner = null,
}) {
  let flushing = null;
  let listening = true;
  /** The try again a busy server asked for (Retry-After), while the queue listens. */
  let again = null;

  // A store without the queue's own reads (an app's own) still works, reading everything as before.
  const queue = queueOf(local);
  const { entries, size, first } = queue;
  const count = async () => {
    const n = await size();
    onCount(n);
    return n;
  };

  /**
   * Keeps a change for later. `tempId`: the provisional id of what this
   * change creates, so later changes can point at it. `owner`: whose it is, when
   * the app knows it before the server has said so (drawn offline for them). Returns the change.
   */
  async function add({ method, path, body = null, tempId: provisional = null, owner: given = null }) {
    const ts = now();
    const who = given ?? owner?.() ?? null;
    const op = { id: newId(), method, path, body, ts, ...(provisional ? { tempId: provisional } : {}), ...(who != null ? { owner: who } : {}) };
    await local.put(STORE, orderKey(ts), op);
    askToKeep();
    await count();
    return op;
  }

  /** What waits, oldest first. */
  const pending = async () => (await entries()).map(([, op]) => op);

  /**
   * Sends what waits, in order. → { sent, dropped, conflicts, left }, or null
   * when another tab (or this one) is already sending.
   */
  function flush() {
    if (flushing) return flushing.then(() => null);
    // Another tab holding the lock is sending the same queue: nothing to do here.
    flushing = locks ? locks.request(lockName, { ifAvailable: true }, (lock) => (lock ? sendAll() : null)) : sendAll();
    flushing = flushing.finally(() => { flushing = null; });
    return flushing;
  }

  async function sendAll() {
    const report = { sent: 0, dropped: [], conflicts: [], others: [], left: 0 };
    for (;;) {
      // Whose the session is, asked for each change: it can end half way.
      const who = owner ? owner() ?? null : undefined;
      if (who === null) break;
      const head = await first();
      if (!head) break;
      const [key, op] = head;

      // Another account's, from before this session: never sent with it.
      if (who !== undefined && op.owner != null && op.owner !== who) {
        await local.delete(STORE, key);
        report.others.push(op);
        continue;
      }

      // A provisional id still here has no creation left to come: it went wrong earlier.
      if (TEMP_IN_PATH.test(op.path)) {
        await local.delete(STORE, key);
        const error = new ApiError(0, 'lost_creation');
        report.dropped.push({ op, error });
        onDropped({ op, error });
        continue;
      }

      let answer;
      try {
        answer = await send(op);
      } catch (error) {
        // No signal, the session ended, the server in trouble or busy: the rest waits.
        if (waits(error)) {
          const wait = busyFor(error);
          if (wait != null) {
            report.retryAfter = wait;
            tryAgainIn(wait);
          }
          break;
        }
        await local.delete(STORE, key);
        if (error?.status === 409) {
          report.conflicts.push({ op, error });
          await onConflict({ op, error });
        } else {
          report.dropped.push({ op, error });
          onDropped({ op, error });
        }
        continue;
      }

      await local.delete(STORE, key);
      report.sent += 1;
      const realId = idOf(answer);
      if (op.tempId && realId != null) {
        // What was done to it offline now points at the real id, in the stored queue.
        await pointAtReal(queue, op.tempId, realId);
        await onCreated({ op, tempId: op.tempId, id: realId, answer });
      }
    }
    report.left = await count();
    return report;
  }

  /** Once, after a busy server's wait, and only while the queue listens: an app that sends itself (Tasks) decides when. */
  function tryAgainIn(ms) {
    if (!listening || again) return;
    again = setTimeout(() => {
      again = null;
      if (listening) flush().catch(() => {});
    }, ms);
    // A page closes whenever it likes; a test or a worker isn't kept open by it.
    again.unref?.();
  }

  // Back online: send what waits.
  const onOnline = () => { flush().catch(() => {}); };
  globalThis.addEventListener?.('online', onOnline);

  return {
    add, pending, flush, count,
    /** Forgets every change waiting (signing out). */
    clear: async () => { await local.clear(STORE); await count(); },
    /** Forgets every change that isn't `id`'s, one kept without an owner too (someone else signed in). → how many. */
    keepOnly: async (id) => {
      let gone = 0;
      for (const [key, op] of await entries()) {
        if (op.owner === id) continue;
        await local.delete(STORE, key);
        gone += 1;
      }
      if (gone) await count();
      return gone;
    },
    stop: () => {
      listening = false;
      clearTimeout(again);
      again = null;
      globalThis.removeEventListener?.('online', onOnline);
    },
  };
}

/**
 * What an app left in its queue on this device, sent while the app isn't on the page: Cronum Work's
 * shell asks each module that isn't on screen to bring its copy up to date (its fresh.js), and a
 * change made in a module the person then left waited until that module was opened again on this
 * device: days, for ticks made on a phone (audit of 6/11, sc-shell-3).
 *
 * Only what goes through cleanly, oldest first. A creation swaps its provisional id in the stored
 * queue, as the outbox does, and `onCreated` hears it. The first change that doesn't get a plain yes
 * stops it, and that change and the rest stay for the app's own queue, which settles them with the
 * person in front (a conflict copy, a notice): no signal, the server busy or in trouble, a conflict,
 * a refusal, a provisional id whose creation is gone, or a change of an account other than `owner`
 * (the id of whoever the server says is signed in; without it, nothing goes). `skip(op)`: a change
 * the app must send itself (a drawing whose picture is its own), which stops it too. Under the
 * outbox's lock: a tab with the app on the page sends the same queue, and one does at a time.
 *
 * → { sent, left, stopped }: `stopped` is null when the queue is empty, else why it stopped
 * ('locked', 'offline', 'owner', 'skip', 'provisional', or the error the server answered).
 */
export async function sendWhileAway({
  local, owner, send = (op) => api.write(op.method, op.path, op.body, { key: op.id }),
  idOf = (answer) => answer?.id, onCreated = () => {}, skip = () => false,
  lockName = 'kit-outbox', locks = globalThis.navigator?.locks, online = () => globalThis.navigator?.onLine !== false,
}) {
  const queue = queueOf(local);
  const report = { sent: 0, left: 0, stopped: null };
  const sendAll = async () => {
    for (;;) {
      const head = await queue.first();
      if (!head) break;
      const [key, op] = head;
      if (op.owner != null && String(op.owner) !== String(owner)) { report.stopped = 'owner'; break; }
      if (TEMP_IN_PATH.test(op.path)) { report.stopped = 'provisional'; break; }
      if (skip(op)) { report.stopped = 'skip'; break; }
      let answer;
      try {
        answer = await send(op);
      } catch (error) {
        report.stopped = error;
        break;
      }
      await local.delete(STORE, key);
      report.sent += 1;
      const realId = idOf(answer);
      if (op.tempId && realId != null) {
        await pointAtReal(queue, op.tempId, realId);
        await onCreated({ op, tempId: op.tempId, id: realId, answer });
      }
    }
  };
  if (owner == null) report.stopped = 'owner';
  else if (!online()) report.stopped = 'offline';
  else if (!locks) await sendAll();
  else if (!(await locks.request(lockName, { ifAvailable: true }, async (lock) => { if (lock) await sendAll(); return Boolean(lock); }))) report.stopped = 'locked';
  report.left = await queue.size();
  return report;
}
