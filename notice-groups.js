/**
 * Notices grouped for a few seconds before they go, for the modules: someone dictating five things
 * to a shared list, or a plan with twelve tasks for one person, is one notice, not five or twelve.
 *
 * Each change is added under a key, which says whose notice it is (a list and who changed it; a
 * person, a project and who gave them the tasks…). The key's notice goes once nothing new has come
 * under it for `delayMs`: every change of the meantime merged into it, each one starting the wait
 * again. The module keeps what a change adds and what the notice says; this keeps the waiting.
 *
 * Kept in memory, so a restart would lose what waits: the module sends it when it stops
 * (`flushAll()` from its `start()`'s stop, which the host waits for).
 */

/** How long a group waits for more, unless the module says otherwise. */
export const NOTICE_DELAY_MS = 25_000;

/** A send started by the wait that failed, when the module doesn't say what to do with it. */
const logFailure = (err) => console.error(`[notices] ${err?.message}`);

/**
 * → { add(key, merge), flush(key), flushAll(), size }
 *
 * `send(value, key)`: what the module does with a group once it closes (it may return a promise).
 * `failed(err, key)`: what to do when one the wait started fails; flush()'s failures are its
 * caller's, as the promise it returns.
 */
export function createNoticeGroups({ send, delayMs = NOTICE_DELAY_MS, failed = logFailure } = {}) {
  if (typeof send !== 'function') throw new TypeError('createNoticeGroups: send is required');
  /** key → { value, timer } */
  const pending = new Map();

  /** The group of `key` now, without waiting for it to close; nothing when there is none. */
  async function flush(key) {
    const group = pending.get(key);
    if (!group) return;
    // Out before it is sent: a change that comes meanwhile starts a group of its own.
    pending.delete(key);
    clearTimeout(group.timer);
    await send(group.value, key);
  }

  const closeLater = (key) => {
    const timer = setTimeout(() => {
      flush(key).catch((err) => {
        try { failed(err, key); } catch { /* a report that fails must not become an unhandled rejection */ }
      });
    }, delayMs);
    // A group waiting never keeps the process alive.
    timer.unref?.();
    return timer;
  };

  return {
    /**
     * One more change under `key`: `merge(value)` gets what has piled up there (undefined for the
     * first change) and returns it with this one in. The wait starts again. → the merged value
     */
    add(key, merge) {
      const group = pending.get(key);
      // Merged first: a merge that throws leaves the group as it was, still waiting.
      const value = merge(group?.value);
      if (group) clearTimeout(group.timer);
      pending.set(key, { value, timer: closeLater(key) });
      return value;
    },
    flush,
    /** Every group now: for the module's stop, and for tests. */
    async flushAll() {
      await Promise.all([...pending.keys()].map((key) => flush(key)));
    },
    /** How many groups are waiting. */
    get size() { return pending.size; },
  };
}
