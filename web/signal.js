/**
 * «Is there a signal again?»: the light question a page asks the server while it has none.
 *
 * Every module found out the same way, each with its own copy (audit of 6/11, sc-shell-22): once
 * a request finds no signal, nothing waits for the server, and a question to `/version` (never a
 * copy, sw-core.js) now and then says when it is back: first after a moment, then twice as long
 * each time up to a ceiling, and at once when someone asks (`check()`: the browser's `online`, the
 * page in front again, a change made). Tasks, Projects, Notes and Next ask it through here, and so
 * does Settings' `connection` (settings-queue.js); what differs between them stays theirs, as
 * options: how long they wait, what they ask, what counts as an answer, and what they do with it.
 *
 * It only asks: whether the page is offline, and what it draws for it, is the caller's. Nothing
 * happens on import, nor until `lost()` or `check()` (Cronum Work's rule: a module acts at its
 * mount), and `stop()` (the module taken off the page) leaves nothing asking or scheduled; an
 * answer that comes after it is not told.
 *
 *   const watch = watchSignal({ onBack: () => setOffline(false) });
 *   watch.lost();     // a request found no signal: asked in a while, then less often
 *   watch.check();    // asked now → a promise of whether the server answered
 *   watch.found();    // another request got an answer: nothing more to ask
 *   watch.stop();     // taken off the page
 */
import { at } from './base.js';

/** The first wait, and the longest one, of every module until now. */
export const SIGNAL_FIRST_MS = 3000;
export const SIGNAL_MAX_MS = 30000;

/** The default question: any answer of the server's (even an error) is a server that can be reached. */
const askVersion = (url, patienceMs) => () => globalThis.fetch(url, {
  cache: 'no-store',
  credentials: 'same-origin',
  signal: patienceMs > 0 && typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(patienceMs) : undefined,
});

/**
 * @param {object} [options]
 * @param {Function} [options.ask]       → a promise, settled by the server's answer: the module's own
 *   client (`api.get('/version')`) when it has one; by default a `fetch` of `url`
 * @param {string} [options.url]         what the default question asks: the app's `/version` (`at()`)
 * @param {number} [options.patienceMs]  how long the default question waits for its answer (0: as the browser)
 * @param {Function} [options.answered]  `(err)` → whether a question that failed still heard the server
 *   (an HTTP error is an answer: `(err) => !(err instanceof Offline)`); by default none did
 * @param {Function} [options.onBack]    the server answered a question of this watch
 * @param {Function} [options.active]    whether to ask at all (the module still on the page), read
 *   before every question and after its answer
 * @param {Function} [options.again]     after a question without an answer, whether to ask again later
 * @param {number} [options.firstMs]     the first wait
 * @param {number} [options.maxMs]       the longest one
 */
export function watchSignal({
  ask = null, url = null, patienceMs = 0, answered = () => false,
  onBack = () => {}, active = () => true, again = () => true,
  firstMs = SIGNAL_FIRST_MS, maxMs = SIGNAL_MAX_MS,
} = {}) {
  const question = ask || askVersion(url ?? at('/version'), patienceMs);
  let wait = firstMs;
  let timer = null;
  let asking = null;
  // A question asked before stop() (or before an answer came some other way) says nothing after it.
  let round = 0;

  const clear = () => {
    clearTimeout(timer);
    timer = null;
  };

  /** In a while, unless a question is already scheduled or under way. */
  function later() {
    if (timer || asking || !active()) return;
    timer = setTimeout(() => { timer = null; check(); }, wait);
    // Never what keeps a process alive (the kit's tests run this in node).
    timer.unref?.();
  }

  /** Asked now (or the question under way): → a promise of whether the server answered. */
  function check() {
    clear();
    if (asking) return asking;
    if (!active()) return Promise.resolve(false);
    const mine = round;
    asking = (async () => {
      let back = true;
      try {
        await question();
      } catch (err) {
        back = Boolean(answered(err));
      }
      if (mine !== round) return back;
      asking = null;
      if (!active()) return back;
      if (back) {
        wait = firstMs;
        onBack();
      } else {
        wait = Math.min(wait * 2, maxMs);
        if (again()) later();
      }
      return back;
    })();
    return asking;
  }

  return {
    /** A request found no signal: the server is asked in a while, then less and less often. */
    lost: later,
    check,
    /** Another request got an answer: nothing is asked any more, and the next loss starts from the first wait. */
    found() {
      clear();
      wait = firstMs;
    },
    /** Taken off the page: nothing scheduled, nothing under way that will be told, the first wait again. */
    stop() {
      clear();
      round += 1;
      asking = null;
      wait = firstMs;
    },
    /** Whether a question is scheduled or under way. */
    get watching() { return Boolean(timer || asking); },
  };
}
