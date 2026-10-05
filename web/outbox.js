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
 *   waits. A conflict (409) goes to the app, which decides (Notes keeps a
 *   conflict copy); anything else that can't be fixed by retrying is dropped
 *   and reported.
 * - Several tabs share the queue: one sends at a time (a Web Lock), and a
 *   change leaves the queue by its id, never by its place.
 *
 *   const outbox = createOutbox({ local, onConflict, onDropped, onCount: (n) => … });
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

/**
 * @param {object} options
 * @param {object} options.local          from openLocal() (or memoryLocal())
 * @param {Function} [options.send]       (op) → the server's answer; default: api.js with the op's id as Idempotency-Key
 * @param {Function} [options.onConflict] ({ op, error }) → the server said 409: the app decides
 * @param {Function} [options.onDropped]  ({ op, error }) → a change that couldn't go and was dropped
 * @param {Function} [options.onCreated]  ({ op, tempId, id, answer }) → a provisional id became a real one
 * @param {Function} [options.onCount]    (n) → how many changes wait
 * @param {Function} [options.idOf]       (answer) → the real id of what a creation made (default: answer.id)
 * @param {string}   [options.lockName]
 */
export function createOutbox({
  local, send = (op) => api.write(op.method, op.path, op.body, { key: op.id }),
  onConflict = () => {}, onDropped = () => {}, onCreated = () => {}, onCount = () => {}, idOf = (answer) => answer?.id,
  lockName = 'kit-outbox', locks = globalThis.navigator?.locks, now = Date.now,
}) {
  let flushing = null;

  const entries = () => local.entries(STORE);
  const count = async () => {
    const n = (await entries()).length;
    onCount(n);
    return n;
  };

  /**
   * Keeps a change for later. `tempId`: the provisional id of what this
   * change creates, so later changes can point at it. Returns the change.
   */
  async function add({ method, path, body = null, tempId: provisional = null }) {
    const ts = now();
    const op = { id: newId(), method, path, body, ts, ...(provisional ? { tempId: provisional } : {}) };
    await local.put(STORE, orderKey(ts), op);
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
    const report = { sent: 0, dropped: [], conflicts: [], left: 0 };
    for (;;) {
      const [first] = await entries();
      if (!first) break;
      const [key, op] = first;

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
        // No signal, the session ended or the server is in trouble: the rest waits.
        if (error instanceof Offline || error instanceof SessionExpired || (error?.status >= 500) || error?.code === 'idempotency_in_progress') break;
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
        for (const [otherKey, other] of await entries()) {
          const swapped = swapId(other, op.tempId, String(realId));
          if (swapped.path !== other.path || JSON.stringify(swapped.body) !== JSON.stringify(other.body)) {
            await local.put(STORE, otherKey, swapped);
          }
        }
        await onCreated({ op, tempId: op.tempId, id: realId, answer });
      }
    }
    report.left = await count();
    return report;
  }

  // Back online: send what waits.
  const onOnline = () => { flush().catch(() => {}); };
  globalThis.addEventListener?.('online', onOnline);

  return {
    add, pending, flush, count,
    /** Forgets every change waiting (signing out). */
    clear: async () => { await local.clear(STORE); await count(); },
    stop: () => globalThis.removeEventListener?.('online', onOnline),
  };
}
