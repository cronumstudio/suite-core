/**
 * The live channel in the browser: `/api/events` (suite-core live.js), so
 * what changes on the phone, in another tab, in a shared list or through the
 * AI shows up without reloading.
 *
 * - Changes in a row are grouped: five steps logged at once reload once.
 * - EventSource reconnects by itself and sends `Last-Event-ID`, so the server
 *   replays what was missed; when it can't (too much missed, or it restarted)
 *   it says `resync` and the page reloads what it shows. On `hello` after a
 *   cut, the same: something may have been missed while it was closed.
 * - `account`: the person's account changed elsewhere (email confirmed in
 *   another tab, a new password, signed out everywhere).
 * - A closed channel (the session expired, the server restarting) is opened
 *   again with a growing wait, up to a minute.
 *
 *   const live = connectLive({
 *     onChange: (events) => reload(events), onResync: reloadAll, onAccount: refreshUser,
 *     onState: (state) => shell.setLive(state),
 *   });
 */

const GROUP_MS = 300;
const FIRST_WAIT = 2000;
const MAX_WAIT = 60000;

/**
 * @param {object} handlers
 * @param {Function} [handlers.onChange]   (events: Array<{ event, id, data }>) → grouped changes
 * @param {Function} [handlers.onResync]   reload everything shown
 * @param {Function} [handlers.onAccount]  reload the account
 * @param {Function} [handlers.onState]    ('connecting' | 'open' | 'closed')
 * @param {object} [options]
 * @param {string} [options.url]
 * @param {Array<string>} [options.events]  other event names the app publishes
 * @param {Function} [options.EventSource] for tests
 */
export function connectLive({ onChange = () => {}, onResync = () => {}, onAccount = () => {}, onState = () => {} } = {}, {
  url = '/api/events', events = [], EventSource: Source = globalThis.EventSource, timers = globalThis,
} = {}) {
  let source = null;
  let state = 'closed';
  let waited = 0;
  let retry = null;
  let groupTimer = null;
  let pending = [];
  let opened = false;   // a hello after the first one means a cut: things may have been missed
  let stopped = false;

  const setState = (next) => {
    if (next === state) return;
    state = next;
    onState(next);
  };

  const flush = () => {
    groupTimer = null;
    const batch = pending;
    pending = [];
    if (batch.length) onChange(batch);
  };

  const receive = (name) => (message) => {
    let data = null;
    try { data = message.data ? JSON.parse(message.data) : null; } catch { data = message.data; }
    pending.push({ event: name, id: message.lastEventId || null, data });
    if (!groupTimer) groupTimer = timers.setTimeout(flush, GROUP_MS);
  };

  function open() {
    if (stopped) return;
    if (!Source) return;   // no EventSource: the app works the same, without live changes
    close();
    setState('connecting');
    source = new Source(url, { withCredentials: true });
    source.addEventListener('hello', () => {
      waited = 0;
      setState('open');
      if (opened) onResync();
      opened = true;
    });
    source.addEventListener('change', receive('change'));
    for (const name of events) source.addEventListener(name, receive(name));
    source.addEventListener('resync', () => onResync());
    source.addEventListener('account', () => onAccount());
    source.addEventListener('error', () => {
      if (!source) return;
      // CONNECTING: EventSource is retrying on its own, with Last-Event-ID.
      if (source.readyState !== 2) {
        setState('connecting');
        return;
      }
      // CLOSED: it won't retry by itself (a 401, a refused connection).
      close();
      setState('closed');
      waited = waited ? Math.min(waited * 2, MAX_WAIT) : FIRST_WAIT;
      retry = timers.setTimeout(open, waited);
    });
  }

  function close() {
    if (retry) timers.clearTimeout(retry);
    retry = null;
    if (source) {
      source.close();
      source = null;
    }
  }

  open();

  return {
    get state() { return state; },
    /** Open again now (a "Retry" button, or after signing in again). */
    reconnect: () => { stopped = false; waited = 0; open(); },
    /** Closes for good (signing out). */
    stop: () => {
      stopped = true;
      close();
      if (groupTimer) timers.clearTimeout(groupTimer);
      groupTimer = null;
      pending = [];
      setState('closed');
    },
  };
}
