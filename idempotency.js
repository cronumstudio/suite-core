/**
 * Writes that may arrive twice. A phone sends a change, the answer is lost on
 * the way back (a tunnel, a lift), and the outbox sends it again: without
 * this, the note would be created twice. Every write the web kit's outbox
 * sends carries an `Idempotency-Key`; the first answer that succeeded is kept
 * a day under that key, and the same key again gets the same answer without
 * the write running a second time.
 *
 * Keys belong to one account: another person's key, even the same string,
 * is another key. A key used for a different method or path is a mistake of
 * the client and is refused rather than answered with something unrelated.
 * Only successful answers are kept: a 409 or a 503 may well go another way
 * on the next try, and the client is right to try.
 */
import { HttpError, badRequest } from './http.js';

const HOUR = 3600 * 1000;
const KEY = /^[\w.:-]{8,128}$/;
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** An answer bigger than this is not kept: replaying it is not worth the database. */
const MAX_BODY = 256 * 1024;

export function idempotencySchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS idempotency_keys (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    method      TEXT NOT NULL,
    path        TEXT NOT NULL,
    status      INTEGER NOT NULL,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  )`);
  d.exec('CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at)');
}

/**
 * @param {object} deps
 * @param {object} deps.database
 * @param {number} [deps.hours]   how long an answer is kept (24)
 * @param {Function} [deps.now]
 */
export function createIdempotency({ database, hours = 24, now = Date.now }) {
  // The same key while its first request is still running: a second tab, or a
  // retry that didn't wait. It must not run beside the first.
  const running = new Set();

  /**
   * Runs `handler` once per key. `ctx` is the API route's context (req, res,
   * user, url); without a key, a user or a write method, it just runs.
   */
  async function run(ctx, handler) {
    const raw = ctx.req.headers['idempotency-key'];
    if (raw === undefined || !ctx.user || !WRITES.has(ctx.req.method)) return handler();
    const key = String(raw);
    if (!KEY.test(key)) throw badRequest('idempotency_key_invalid');
    const method = ctx.req.method;
    const path = ctx.url.pathname;
    const userId = ctx.user.id;

    const kept = database.get(
      'SELECT method, path, status, body, created_at FROM idempotency_keys WHERE user_id = ? AND key = ?', userId, key);
    if (kept && kept.created_at > now() - hours * HOUR) {
      if (kept.method !== method || kept.path !== path) throw new HttpError(422, 'idempotency_key_reused');
      ctx.res.writeHead(kept.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(kept.body),
        'Cache-Control': 'no-store',
        'Idempotent-Replayed': 'true',
      });
      ctx.res.end(kept.body);
      return undefined;
    }

    const slot = `${userId}:${key}`;
    if (running.has(slot)) throw new HttpError(409, 'idempotency_in_progress');
    running.add(slot);
    const answer = capture(ctx.res);
    try {
      const result = await handler();
      const { status, body, json } = answer();
      if (status >= 200 && status < 300 && json && body.length <= MAX_BODY) {
        database.run(
          `INSERT INTO idempotency_keys (user_id, key, method, path, status, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, key) DO UPDATE SET method = excluded.method, path = excluded.path,
             status = excluded.status, body = excluded.body, created_at = excluded.created_at`,
          userId, key, method, path, status, body, now());
      }
      return result;
    } finally {
      running.delete(slot);
    }
  }

  /** Answers older than the window go. */
  function purge() {
    database.run('DELETE FROM idempotency_keys WHERE created_at < ?', now() - hours * HOUR);
  }

  return { run, purge };
}

/**
 * Listens to what a route writes, without changing it: the status, whether it
 * is JSON and the body. Returns a function that reads what was written.
 */
function capture(res) {
  const chunks = [];
  let size = 0;
  const keep = (chunk) => {
    if (chunk == null || typeof chunk === 'function' || size > MAX_BODY) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size <= MAX_BODY) chunks.push(buffer);
  };
  // Headers handed to writeHead() as an object never reach getHeader(): read them on the way.
  let type = '';
  const writeHead = res.writeHead.bind(res);
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  res.writeHead = (status, ...rest) => {
    const headers = rest.find((arg) => arg && typeof arg === 'object');
    if (headers) {
      const entry = Array.isArray(headers) ? null : Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type');
      if (entry) type = String(entry[1]);
    }
    return writeHead(status, ...rest);
  };
  res.write = (chunk, ...rest) => { keep(chunk); return write(chunk, ...rest); };
  res.end = (chunk, ...rest) => { keep(chunk); return end(chunk, ...rest); };
  return () => ({
    status: res.statusCode,
    json: /application\/json/.test(type || String(res.getHeader('content-type') || '')),
    body: size > MAX_BODY ? '' : Buffer.concat(chunks).toString('utf8'),
  });
}
