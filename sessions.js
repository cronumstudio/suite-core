/**
 * Browser sessions.
 *
 * The cookie carries a random token; the database keeps only its HMAC with the
 * session secret, so whoever copies the database file cannot sign anyone in.
 *
 * A session lives while it is used: every use pushes its end `idleDays`
 * further, up to `maxDays` after it was opened, when it ends however much it is
 * used. Signing in opens a new one and closes the one the browser had (a token
 * someone planted before the sign-in is worth nothing after it). Each session
 * remembers the device it came from, so a person can see where they are signed
 * in and close any of them.
 *
 * The secret comes from SESSION_SECRET; without it —or with a value copied from
 * an example, which anyone reading the repositories knows— one is generated
 * the first time and kept in `app_meta`.
 */
import { hmac, randomToken } from './crypto.js';
import { ensureColumn } from './migrate.js';
import { parseCookies, serializeCookie, appendHeader, clientIp } from './http.js';

/** Example values and old defaults of the suite's apps: never used as a secret. */
export const KNOWN_EXAMPLE_SECRETS = Object.freeze([
  'change-me', 'changeme', 'cambia-esto', 'put-a-long-random-string-here',
  'pon-aqui-una-cadena-larga-y-aleatoria', 'next-without-secret', 'proyectos-sin-secreto',
]);

const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/**
 * The session secret of this install: SESSION_SECRET when it is a real one;
 * else the one generated before; else a new one, kept for next time.
 */
export function resolveSessionSecret(database, {
  value = process.env.SESSION_SECRET, known = KNOWN_EXAMPLE_SECRETS, log = console.log, tag = '[suite]',
} = {}) {
  const fromEnv = String(value || '').trim();
  if (fromEnv && !known.includes(fromEnv)) return fromEnv;
  if (fromEnv) log(`${tag} SESSION_SECRET holds an example value: it is ignored.`);
  const stored = database.getMeta('session_secret');
  if (stored) return stored;
  const generated = randomToken(32);
  database.setMeta('session_secret', generated);
  log(`${tag} SESSION_SECRET was not set: generated one and stored it in the database.`);
  return generated;
}

/**
 * The `sessions` table in its suite shape, created or brought from the shape
 * the apps had (token, workos_sid, dates written by datetime('now')).
 */
export function sessionsSchema(d) {
  const columns = d.columnsOf('sessions');
  if (!columns.length) {
    d.exec(`CREATE TABLE sessions (
      token_hash          TEXT PRIMARY KEY,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at          TEXT NOT NULL,
      last_used_at        TEXT NOT NULL,
      expires_at          TEXT NOT NULL,
      absolute_expires_at TEXT NOT NULL,
      user_agent          TEXT,
      ip                  TEXT,
      idp_session_id      TEXT
    )`);
  } else {
    if (columns.includes('token') && !columns.includes('token_hash')) {
      d.exec('ALTER TABLE sessions RENAME COLUMN token TO token_hash');
    }
    if (columns.includes('workos_sid') && !columns.includes('idp_session_id')) {
      d.exec('ALTER TABLE sessions RENAME COLUMN workos_sid TO idp_session_id');
    }
    ensureColumn(d, 'sessions', 'idp_session_id', 'idp_session_id TEXT');
    ensureColumn(d, 'sessions', 'last_used_at', 'last_used_at TEXT');
    ensureColumn(d, 'sessions', 'absolute_expires_at', 'absolute_expires_at TEXT');
    ensureColumn(d, 'sessions', 'user_agent', 'user_agent TEXT');
    ensureColumn(d, 'sessions', 'ip', 'ip TEXT');
    // Dates written by datetime('now') become ISO 8601 with Z, like the rest:
    // mixed formats compare wrongly as text.
    const toIso = (column) => `${column} = CASE WHEN ${column} LIKE '% %'
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) ELSE ${column} END`;
    d.exec(`UPDATE sessions SET ${toIso('created_at')}, ${toIso('expires_at')}`);
    d.exec(`UPDATE sessions SET
      last_used_at = COALESCE(last_used_at, created_at),
      absolute_expires_at = COALESCE(absolute_expires_at, strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+365 days'))`);
  }
  d.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
}

/**
 * @param {object} options
 * @param {object} options.database     the suite's database handle
 * @param {string} options.secret       from resolveSessionSecret()
 * @param {string} options.cookieName   e.g. 'next_sid'
 * @param {boolean} [options.secureCookies]
 * @param {number} [options.idleDays]   a session unused this long ends
 * @param {number} [options.maxDays]    and none lasts longer than this
 * @param {() => number} [options.clock]
 */
export function createSessions({
  database, secret, cookieName, secureCookies = false, idleDays = 30, maxDays = 365,
  trustProxy = process.env.TRUST_PROXY, clock = () => Date.now(),
}) {
  if (!secret) throw new Error('createSessions needs a secret');
  const hashOf = (token) => hmac(secret, token);
  /** Public handle of a session, for lists and revocation: never enough to sign in. */
  const keyOf = (tokenHash) => tokenHash.slice(0, 16);
  const withoutDisabled = database.columnsOf('users').includes('disabled_at') ? ' AND u.disabled_at IS NULL' : '';

  const tokenFrom = (req) => parseCookies(req)[cookieName] || null;

  function setCookie(res, token) {
    appendHeader(res, 'Set-Cookie', serializeCookie(cookieName, token, {
      maxAge: maxDays * 24 * 3600, httpOnly: true, sameSite: 'Lax', secure: secureCookies,
    }));
  }
  function clearCookie(res) {
    appendHeader(res, 'Set-Cookie', serializeCookie(cookieName, '', {
      maxAge: 0, httpOnly: true, sameSite: 'Lax', secure: secureCookies,
    }));
  }

  /**
   * Opens a session for `userId` and returns its token. With `req`, the
   * browser's previous session is closed (rotation) and the device noted.
   * With `res`, the cookie is set too.
   */
  function open(userId, { req = null, res = null, idpSessionId = null } = {}) {
    const now = clock();
    const token = randomToken(32);
    database.tx(() => {
      const previous = req ? tokenFrom(req) : null;
      if (previous) database.run('DELETE FROM sessions WHERE token_hash = ?', hashOf(previous));
      database.run(`INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at,
          absolute_expires_at, user_agent, ip, idp_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      hashOf(token), userId, iso(now), iso(now), iso(now + Math.min(idleDays, maxDays) * DAY),
      iso(now + maxDays * DAY),
      req ? String(req.headers['user-agent'] || '').slice(0, 300) : null,
      req ? clientIp(req, { trustProxy }) : null,
      idpSessionId);
    });
    if (res) setCookie(res, token);
    return token;
  }

  /** The session row of a token if it is alive, sliding its end when used. */
  function alive(token) {
    if (!token || typeof token !== 'string' || token.length > 200) return null;
    const now = clock();
    const row = database.get(
      'SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ? AND absolute_expires_at > ?',
      hashOf(token), iso(now), iso(now),
    );
    if (!row) return null;
    // At most once a minute: a page load makes several requests.
    if (now - Date.parse(row.last_used_at) > 60 * 1000) {
      const end = Math.min(now + idleDays * DAY, Date.parse(row.absolute_expires_at));
      database.run('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?',
        iso(now), iso(end), row.token_hash);
    }
    return row;
  }

  /** The user of the request's session, or null. */
  function userFrom(req) {
    const token = tokenFrom(req);
    if (!alive(token)) return null;
    return database.get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?${withoutDisabled}`, hashOf(token)) || null;
  }

  /** Closes the session of a token; returns the identity provider's session it came from, if any. */
  function close(token) {
    if (!token) return null;
    const row = database.get('SELECT idp_session_id FROM sessions WHERE token_hash = ?', hashOf(token));
    database.run('DELETE FROM sessions WHERE token_hash = ?', hashOf(token));
    return row?.idp_session_id || null;
  }

  /**
   * Closes every session of a person, except the one of `exceptToken`: what a
   * password change wants — out with whoever had the old one, without signing
   * out the browser where it was just typed.
   */
  function closeAllOf(userId, { exceptToken = null } = {}) {
    if (exceptToken) {
      return database.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?',
        userId, hashOf(exceptToken)).changes;
    }
    return database.run('DELETE FROM sessions WHERE user_id = ?', userId).changes;
  }

  /**
   * The identity provider's sessions behind some of a person's sessions here
   * (all, all but `exceptToken`'s, or the one of `key`): closing ours alone
   * leaves that browser signed in at the provider, back in with one click.
   */
  function idpSessionsOf(userId, { key = null, exceptToken = null } = {}) {
    const rows = database.all('SELECT token_hash, idp_session_id FROM sessions WHERE user_id = ? AND idp_session_id IS NOT NULL', userId);
    return rows
      .filter((r) => (key ? r.token_hash.slice(0, 16) === key : !exceptToken || r.token_hash !== hashOf(exceptToken)))
      .map((r) => r.idp_session_id);
  }

  /** Where a person is signed in, newest use first; `current` marks this browser. */
  function list(userId, currentToken = null) {
    const current = currentToken ? hashOf(currentToken) : null;
    return database.all(`SELECT token_hash, created_at, last_used_at, expires_at, user_agent, ip
      FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_used_at DESC`, userId, iso(clock()))
      .map((row) => ({
        key: keyOf(row.token_hash), created_at: row.created_at, last_used_at: row.last_used_at,
        expires_at: row.expires_at, user_agent: row.user_agent, ip: row.ip,
        current: row.token_hash === current,
      }));
  }

  /** Closes one session of a person by its public key. */
  function revoke(userId, key) {
    if (typeof key !== 'string' || key.length !== 16) return false;
    return database.run("DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?",
      userId, key).changes > 0;
  }

  /** Deletes the sessions that have ended. */
  const purge = () => database.run('DELETE FROM sessions WHERE expires_at <= ? OR absolute_expires_at <= ?',
    iso(clock()), iso(clock())).changes;

  /** A keyed signature, for values that must come back untouched (the OAuth consent CSRF). */
  const sign = (value) => hmac(secret, `sign|${value}`);

  return {
    cookieName, open, alive, userFrom, tokenFrom, close, closeAllOf, idpSessionsOf, list, revoke, purge, sign,
    setCookie, clearCookie,
  };
}
