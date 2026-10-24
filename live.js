/**
 * Live updates through Server-Sent Events: one channel per browser tab
 * (`GET /api/events`, which createApp() serves when the app turns on
 * `modules.live`), and `publish()` for whatever changed.
 *
 * Next, Tasks and Projects each had this, the same way:
 *
 * · A notice says what changed, not the data (the apps' choice, and a good
 *   one: with the data came arrival order and per-field permissions, and one
 *   lost message left two screens telling different stories). The client
 *   reloads what it shows; the single source of truth is the same query as
 *   always. An app may still send state in `data` if it wants.
 * · `retry:` so the browser comes back quickly, a heartbeat every 25 s (a
 *   silent connection is cut by proxies), and `X-Accel-Buffering: no` or the
 *   reverse proxy holds the whole response.
 *
 * What the suite adds: every event carries an id (`<boot>.<n>`). A browser
 * that reconnects sends the last one it saw (`Last-Event-ID`, EventSource does
 * it by itself) and gets what it missed while it was away, from a short
 * memory; when that is not possible —too much was missed, or the server
 * restarted— it gets `event: resync` and reloads everything it shows.
 * `hello` carries an id too (where the server is now), so a tab that saw no
 * notice still comes back with one; a page that opens a new channel after
 * closing one sends that id as `?last=`, which EventSource can't send then.
 * When either came, `hello` says `replayed: true`: what was missed has been
 * said (or `resync`), so the page needn't reload everything on its own.
 *
 * A host's page that shows several modules at once (Cronum Work's
 * one-document shell) opens one channel for all of them instead of one each:
 * subscribeAll(), the host's `GET /api/events?all` (host.js `liveAll`).
 */
import { randomToken } from './crypto.js';

const HEARTBEAT_MS = 25000;
/** Channels per person: tabs and devices, with room to spare. More, and the oldest goes. */
const PER_USER = 10;
/** What may wait unread for one channel before it is closed (its browser reconnects and resyncs). */
const BACKLOG = 64 * 1024;

const STREAM_HEAD = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Without this the reverse proxy buffers the response and nothing arrives.
  'X-Accel-Buffering': 'no',
});

/**
 * @param {object} [options]
 * @param {number} [options.remember]   how many recent events a reconnecting tab can get back
 * @param {number} [options.heartbeatMs]
 */
export function createLive({ remember = 256, heartbeatMs = HEARTBEAT_MS } = {}) {
  /** This run of the server: an id from another one can't be replayed. */
  const boot = randomToken(6);
  const clients = new Set();
  /** The last events, oldest first: { n, event, body, audience: Set | null }. */
  const recent = [];
  let last = 0;

  const frame = (n, event, body) => `id: ${boot}.${n}\nevent: ${event}\ndata: ${body}\n\n`;
  const reaches = (entry, userId) => !entry.audience || entry.audience.has(userId);

  function drop(client) {
    if (!clients.delete(client)) return;
    clearInterval(client.timer);
    try {
      if (client.end) client.end();
      else client.res.end();
    } catch { /* already closed */ }
  }
  function send(client, text) {
    try {
      // A channel that stops reading piled every notice up in memory, without end.
      if (!client.res.write(text) && client.res.writableLength > BACKLOG) drop(client);
    } catch { drop(client); }
  }
  /** A notice to one channel: written to its tab, or handed to whoever reads it for another (relay). */
  function tell(client, { n = null, event, body }) {
    if (client.deliver) {
      try { client.deliver({ id: n ? `${boot}.${n}` : null, event, body }); } catch { drop(client); }
    } else {
      send(client, n ? frame(n, event, body) : `event: ${event}\ndata: ${body}\n\n`);
    }
  }

  /**
   * Tells the people in `audience` (user ids; null: everyone connected) that
   * something changed. `data` goes as the event's JSON; `event` is its name
   * (`change` by default, the one the apps' pages listen to).
   */
  function publish({ audience = null, data = {}, event = 'change' } = {}) {
    last += 1;
    const entry = {
      n: last, event, body: JSON.stringify(data),
      audience: audience == null ? null : new Set([...audience].map(Number)),
    };
    recent.push(entry);
    if (recent.length > remember) recent.shift();
    for (const client of clients) {
      if (reaches(entry, client.userId)) tell(client, entry);
    }
  }

  /**
   * What someone missed since the id `seen` (`<boot>.<n>`): the notices for them still
   * remembered, oldest first; null when that can't be told (too much missed, another run of the
   * server, nonsense), and they must reload everything.
   */
  function missedSince(seen, userId) {
    const [seenBoot, seenN] = String(seen).split('.');
    const n = Number(seenN);
    const oldest = recent.length ? recent[0].n : last + 1;
    if (seenBoot !== boot || !Number.isInteger(n) || n > last || n < oldest - 1) return null;
    return recent.filter((entry) => entry.n > n && reaches(entry, Number(userId)));
  }

  /** A new channel of someone's: their oldest goes if they have too many already. */
  function admit(client) {
    // Opening channels without end held a socket, a timer and a buffer each.
    const theirs = [...clients].filter((other) => other.userId === client.userId);
    for (const old of theirs.slice(0, Math.max(0, theirs.length - PER_USER + 1))) drop(old);
    clients.add(client);
  }

  /**
   * Opens the channel of a signed-in person and keeps it open while the tab
   * is. Exempt from the socket's timeout: it lives open on purpose.
   * `sessionToken`, the session it was opened with, lets dropUser() keep the
   * tab where the person just changed their password.
   */
  function subscribe(req, res, user, { sessionToken = null } = {}) {
    res.setTimeout?.(0);
    res.writeHead(200, STREAM_HEAD);
    res.write('retry: 3000\n\n');

    // Coming back: what was missed, if it is still here; if not, reload everything.
    const seen = lastSeenOf(req);
    if (seen) {
      const missed = missedSince(seen, user.id);
      if (!missed) res.write('event: resync\ndata: {}\n\n');
      else for (const entry of missed) res.write(frame(entry.n, entry.event, entry.body));
    }
    // With an id: where this run is now, so a tab that saw no notice still comes back with one.
    res.write(frame(last, 'hello', JSON.stringify(seen ? { user_id: user.id, replayed: true } : { user_id: user.id })));

    const client = { res, userId: Number(user.id), sessionToken };
    admit(client);
    client.timer = setInterval(() => send(client, ': ping\n\n'), heartbeatMs);
    client.timer.unref?.();
    req.on('close', () => drop(client));
    req.on('error', () => drop(client));
  }

  /**
   * This channel read for another one (subscribeAll): the same notices a tab of `user` would get,
   * handed to `deliver({ id, event, body })` (`body` the data's JSON; no id for a last word before
   * closing) instead of written. It counts as one of their channels, and dropUser() and close()
   * end it as they end a tab: `end()` is then called. `since` is the last id it saw here.
   * @returns {{ at: string, missed: Array|null, stop: Function }} where this channel is now, what
   *   was missed since `since` (null: reload everything; [] without `since`), and how to let go
   */
  function relay(user, { since = '', sessionToken = null, deliver, end = () => {} }) {
    const missed = since ? missedSince(since, user.id) : [];
    const client = { userId: Number(user.id), sessionToken, deliver, end };
    admit(client);
    return {
      at: `${boot}.${last}`,
      missed: missed && missed.map((entry) => ({ id: `${boot}.${entry.n}`, event: entry.event, body: entry.body })),
      stop: () => {
        // Let go by its reader: nothing to tell it back.
        client.end = () => {};
        drop(client);
      },
    };
  }

  /** Closes every channel (an orderly shutdown doesn't wait for open tabs). */
  function close() {
    for (const client of [...clients]) drop(client);
  }

  /**
   * Closes a person's channels, all but the one opened with the session
   * `except` (revoke.js): a tab of a session that was just closed stopped
   * being theirs, and the browser coming back with it finds no one. `last`
   * ({ event, data }) is said to each before it closes: the account's notice,
   * so the page looks again at who is signed in, and finds no one.
   */
  function dropUser(userId, { except = null, last: word = null } = {}) {
    let n = 0;
    for (const client of [...clients]) {
      if (client.userId !== Number(userId) || (except && client.sessionToken === except)) continue;
      if (word) tell(client, { event: word.event || 'change', body: JSON.stringify(word.data ?? {}) });
      drop(client);
      n += 1;
    }
    return n;
  }

  return { publish, subscribe, relay, dropUser, close, connected: () => clients.size };
}

/**
 * The last id a tab saw: the `Last-Event-ID` EventSource sends when it retries by itself, or
 * `?last=` when the page opened a new channel after closing one (EventSource can't send the
 * header then). '' when neither: a tab opening for the first time.
 */
function lastSeenOf(req) {
  const header = req.headers?.['last-event-id'];
  if (header) return String(header);
  try {
    return new URL(String(req.url || ''), 'http://host.invalid').searchParams.get('last') || '';
  } catch {
    return '';
  }
}

/**
 * One channel for every module of a host's page (`GET /api/events?all`): what each module's own
 * channel would tell this person, in one stream, each notice as a message whose data is
 * `{ module, event, data }`. The same rules as a module's channel, module by module: only what
 * reaches them, what a tab coming back missed (or `resync` for that module), `account`, and its
 * end when their sessions are revoked.
 *
 * Every message is unnamed (`message`, the EventSource's `onmessage`): the page can't know every
 * module's names. It opens with each module's `resync` or missed notices, then
 * `{ module: null, event: 'hello', data: { user_id } }`, with `replayed: true` when it came back with
 * an id, as a module's channel. Its id is where it is in every module
 * (`notes=<boot>.<n>,next=<boot>.<n>`), which the browser sends back on its own when it comes back,
 * or the page as `&last=` on a new channel.
 *
 * @param {Array<[string, object]>} channels  [[mount, createLive()], …]
 * @param {object} [options]
 * @param {string} [options.sessionToken]  the session it is opened with, as subscribe()'s
 * @param {number} [options.heartbeatMs]
 */
export function subscribeAll(channels, req, res, user, { sessionToken = null, heartbeatMs = HEARTBEAT_MS } = {}) {
  res.setTimeout?.(0);
  res.writeHead(200, STREAM_HEAD);
  res.write('retry: 3000\n\n');

  /** Where it is in each module: what its id says. */
  const at = new Map();
  const idOf = () => [...at].map(([mount, id]) => `${mount}=${id}`).join(',');
  const message = (mount, event, body, id = null) => `${id ? `id: ${id}\n` : ''}data: {"module":${JSON.stringify(mount)},"event":${JSON.stringify(event)},"data":${body}}\n\n`;

  let open = true;
  let timer = null;
  const relays = [];
  function finish() {
    if (!open) return;
    open = false;
    clearInterval(timer);
    for (const each of relays) each.stop();
    try { res.end(); } catch { /* already closed */ }
  }
  function write(text) {
    if (!open) return;
    try {
      // A stream that stops reading piled every module's notices up in memory.
      if (!res.write(text) && res.writableLength > BACKLOG) finish();
    } catch { finish(); }
  }

  // Coming back: the id it had, module by module. A module it has no place in may have said anything.
  const seen = lastSeenOf(req);
  const before = new Map(seen.split(',').map((part) => part.split('=')).filter(([mount, id]) => mount && id));
  const opening = [];
  for (const [mount, live] of channels) {
    const since = seen ? before.get(mount) || 'none.0' : '';
    const each = live.relay(user, {
      since, sessionToken, end: finish,
      deliver: ({ id, event, body }) => {
        if (id) at.set(mount, id);
        write(message(mount, event, body, id && idOf()));
      },
    });
    relays.push(each);
    at.set(mount, each.at);
    if (!each.missed) opening.push(message(mount, 'resync', '{}'));
    else for (const missed of each.missed) opening.push(message(mount, missed.event, missed.body));
  }
  for (const text of opening) write(text);
  write(message(null, 'hello', JSON.stringify(seen ? { user_id: user.id, replayed: true } : { user_id: user.id }), idOf()));

  timer = setInterval(() => write(': ping\n\n'), heartbeatMs);
  timer.unref?.();
  req.on('close', finish);
  req.on('error', finish);
}
