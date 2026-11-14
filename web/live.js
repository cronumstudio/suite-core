/**
 * The live channel in the browser: `/api/events` (suite-core live.js), so
 * what changes on the phone, in another tab, in a shared list or through the
 * AI shows up without reloading.
 *
 * - Changes in a row are grouped: five steps logged at once reload once.
 * - EventSource reconnects by itself and sends `Last-Event-ID`, so the server
 *   replays what was missed; when it can't (too much missed, or it restarted)
 *   it says `resync` and the page reloads what it shows. A channel opened
 *   again after closing sends the last id it saw as `?last=`, for the same.
 *   A `hello` after a cut that says `replayed` needs nothing more: what was
 *   missed came before it. One without (a server that doesn't replay, or a
 *   page that had no id yet), or for someone else, reloads what is shown.
 * - `account`: the person's account changed elsewhere (email confirmed in
 *   another tab, a new password, signed out everywhere).
 * - A closed channel (the session expired, the server restarting) is opened
 *   again with a growing wait, up to a minute.
 *
 * - In Cronum Work's one-document shell, a module's channel is the shell's:
 *   one connection for every module of the page (the host's
 *   `/api/events?all`), each module's notices handed to its own handlers
 *   (mount.js `workRegistry().live`). The same object comes back.
 *
 *   const live = connectLive({
 *     onChange: (events) => reload(events), onResync: reloadAll, onAccount: refreshUser,
 *     onState: (state) => shell.setLive(state),
 *   });
 */
import { at } from './base.js';
import { workRegistry, ownerOf } from './mount.js';

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
 * @param {object} [options.shared]  the shell's channel for every module (`workRegistry().live`), for tests
 * @param {string} [options.owner]   the module whose notices these are (`ownerOf()`), for tests
 */
export function connectLive(handlers = {}, options = {}) {
  const { shared = workRegistry()?.live, owner = ownerOf() } = options;
  // A module of the shell's page with its own channel: an address of its own was asked for, it keeps it.
  if (shared && owner && options.url === undefined) return throughShell(shared, owner, handlers, options);
  return ownChannel(handlers, options);
}

/**
 * The module's notices from the shell's one channel: `shared.subscribe(module, handlers)` →
 * `{ stop() }`, wrapped in what connectLive() gives (`state`, `reconnect()`, `stop()`).
 */
function throughShell(shared, owner, { onChange = () => {}, onResync = () => {}, onAccount = () => {}, onState = () => {} }, { events = [] }) {
  let state = 'closed';
  let subscription = null;
  let stopped = false;
  // Nothing reaches the module once it stopped, whatever the shell still has in flight.
  const live = (fn) => (...args) => { if (!stopped) fn(...args); };
  const setState = (next) => {
    if (next === state) return;
    state = next;
    onState(next);
  };
  const handlers = {
    onChange: live(onChange), onResync: live(onResync), onAccount: live(onAccount), onState: live(setState),
  };
  const open = () => {
    subscription?.stop();
    subscription = shared.subscribe(owner, handlers, { events });
  };
  open();
  return {
    get state() { return state; },
    reconnect: () => { stopped = false; open(); },
    stop: () => {
      stopped = true;
      subscription?.stop();
      subscription = null;
      setState('closed');
    },
  };
}

/**
 * The machine of a live channel, shared by a module's own channel (below) and Cronum Work's one
 * channel for every module (its shell's live-hub.js, audit of 6/11, sc-shell-22): one EventSource at
 * `url`, the last id it saw (`?last=` when it opens again), its state, and, closed for good, opened
 * again after a wait that grows up to a minute. What each message means is the caller's: `onEvent(name,
 * message)` for each of `names` (and `listen(name)` later); a `hello` it reads is told to `hello(info)`,
 * which says whether what is shown must be read again (a cut the server couldn't replay, or another
 * person's channel). `ready()`: whether it may open now.
 * @returns {{ open, close, listen, hello, reset, readonly state }}
 */
export function liveSource({
  url, names = [], onEvent = () => {}, onState = () => {}, ready = () => true,
  EventSource: Source = globalThis.EventSource, timers = globalThis,
} = {}) {
  let source = null;
  let state = 'closed';
  let waited = 0;
  let retry = null;
  let opened = false;   // a hello after the first one means a cut: things may have been missed
  let lastId = '';      // the last id the server gave: where to come back from
  let who = null;       // whose channel it was, from hello
  const listened = new Set(names);

  const setState = (next) => {
    if (next === state) return;
    state = next;
    onState(next);
  };
  const hear = (name) => (message = {}) => {
    if (message.lastEventId) lastId = message.lastEventId;
    onEvent(name, message);
  };

  function open() {
    if (!Source || !ready()) return;   // no EventSource: the app works the same, without live changes
    close();
    setState('connecting');
    // A new EventSource can't send Last-Event-ID: the id it would have sent goes in the address.
    const address = lastId ? `${url}${url.includes('?') ? '&' : '?'}last=${encodeURIComponent(lastId)}` : url;
    source = new Source(address, { withCredentials: true });
    for (const name of listened) source.addEventListener(name, hear(name));
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

  return {
    get state() { return state; },
    /** Whether a channel is open now, or waiting to open again. */
    get running() { return Boolean(source || retry); },
    /** Whether a channel is open now (not only waiting to). */
    get connected() { return Boolean(source); },
    setState,
    open,
    close,
    /** Another name heard from now on, on the channel open now too. */
    listen(name) {
      if (listened.has(name)) return;
      listened.add(name);
      source?.addEventListener(name, hear(name));
    },
    /** The channel's hello (its data): open, and whether what is shown must be read again. */
    hello(info) {
      waited = 0;
      setState('open');
      // Back after a cut: what was missed came before this hello, unless the server couldn't say.
      const someoneElse = who != null && info?.user_id != null && String(info.user_id) !== who;
      const cut = opened && (!info?.replayed || someoneElse);
      if (info?.user_id != null) who = String(info.user_id);
      opened = true;
      return cut;
    },
    /** From scratch: no wait, and nothing to come back from (a "Retry", a sign-in again). */
    reset() {
      waited = 0;
      lastId = '';
    },
  };
}

/** The module's own channel: its `/api/events`. */
function ownChannel({ onChange = () => {}, onResync = () => {}, onAccount = () => {}, onState = () => {} } = {}, {
  url = at('/api/events'), events = [], EventSource: Source = globalThis.EventSource, timers = globalThis,
} = {}) {
  let groupTimer = null;
  let pending = [];
  let stopped = false;

  const flush = () => {
    groupTimer = null;
    const batch = pending;
    pending = [];
    if (batch.length) onChange(batch);
  };

  const read = (message) => {
    try { return message.data ? JSON.parse(message.data) : null; } catch { return undefined; }
  };
  const channel = liveSource({
    url, names: ['hello', 'change', ...events, 'resync', 'account'], onState, ready: () => !stopped, EventSource: Source, timers,
    onEvent(name, message) {
      if (name === 'hello') {
        if (channel.hello(read(message) ?? null)) onResync();
      } else if (name === 'resync') onResync();
      else if (name === 'account') onAccount();
      else {
        const data = read(message);
        pending.push({ event: name, id: message.lastEventId || null, data: data === undefined ? message.data : data });
        if (!groupTimer) groupTimer = timers.setTimeout(flush, GROUP_MS);
      }
    },
  });

  channel.open();

  return {
    get state() { return channel.state; },
    /** Open again now (a "Retry" button, or after signing in again): from scratch, everything reloaded. */
    reconnect: () => { stopped = false; channel.reset(); channel.open(); },
    /** Closes for good (signing out). */
    stop: () => {
      stopped = true;
      channel.close();
      if (groupTimer) timers.clearTimeout(groupTimer);
      groupTimer = null;
      pending = [];
      channel.setState('closed');
    },
  };
}
