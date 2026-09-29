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
 */
import { randomToken } from './crypto.js';

const HEARTBEAT_MS = 25000;

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
    try { client.res.end(); } catch { /* already closed */ }
  }
  function send(client, text) {
    try { client.res.write(text); } catch { drop(client); }
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
      if (reaches(entry, client.userId)) send(client, frame(entry.n, entry.event, entry.body));
    }
  }

  /**
   * Opens the channel of a signed-in person and keeps it open while the tab
   * is. Exempt from the socket's timeout: it lives open on purpose.
   */
  function subscribe(req, res, user) {
    res.setTimeout?.(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Without this the reverse proxy buffers the response and nothing arrives.
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    // Coming back: what was missed, if it is still here; if not, reload everything.
    const seen = String(req.headers['last-event-id'] || '');
    if (seen) {
      const [seenBoot, seenN] = seen.split('.');
      const n = Number(seenN);
      const oldest = recent.length ? recent[0].n : last + 1;
      if (seenBoot !== boot || !Number.isInteger(n) || n > last || n < oldest - 1) {
        res.write('event: resync\ndata: {}\n\n');
      } else {
        for (const entry of recent) {
          if (entry.n > n && reaches(entry, user.id)) res.write(frame(entry.n, entry.event, entry.body));
        }
      }
    }
    res.write(`event: hello\ndata: ${JSON.stringify({ user_id: user.id })}\n\n`);

    const client = { res, userId: Number(user.id) };
    client.timer = setInterval(() => send(client, ': ping\n\n'), heartbeatMs);
    client.timer.unref?.();
    clients.add(client);
    req.on('close', () => drop(client));
    req.on('error', () => drop(client));
  }

  /** Closes every channel (an orderly shutdown doesn't wait for open tabs). */
  function close() {
    for (const client of [...clients]) drop(client);
  }

  return { publish, subscribe, close, connected: () => clients.size };
}
