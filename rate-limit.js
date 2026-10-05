/**
 * The brake against brute force, kept in the database.
 *
 * Every app is on the internet, so without it anyone could try passwords and
 * tokens without limit. Failures are counted over the last 15 minutes, in the
 * `login_attempts` table: kept in memory, restarting the container would wipe
 * them, and making it restart is sometimes within an attacker's reach.
 *
 * Several limits at once:
 *   · per account → the real protection for a password (10 failures)
 *   · the second step's code, per account (5): whoever gets there already
 *     knows the password, and a code has only a million values
 *   · per address → stops someone trying many accounts at once (60: high on
 *     purpose, because a household behind one router shares its address)
 *   · tokens and client registration → per address, counting only failures
 *     (or registrations), so a valid client is never locked out because a
 *     neighbour on the same address got something wrong.
 *
 * Buckets are stored as keyed hashes: the table says how many failures there
 * were, never which account or address they were for.
 */
import { hmac, sha256 } from './crypto.js';
import { clientIp } from './http.js';

export const DEFAULT_LIMITS = Object.freeze({
  account: 10, ip: 60, token: 30, registration: 30,
  // Mail anyone can make the app send (a reset link), per address and per recipient,
  // and accounts anyone can create (open sign-up), per address.
  mail: 10, mailTo: 3, signup: 5,
  // Wrong codes of the second step (two-factor.js), per account.
  code: 5,
  // Someone's own copies opened or applied (portability.js), per account.
  importTo: 10,
});

export function rateLimitSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS login_attempts (bucket TEXT NOT NULL, at TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS ix_login_attempts ON login_attempts (bucket, at)`);
}

/**
 * @param {object} options
 * @param {object} options.database  the suite's database handle
 * @param {string} [options.secret]  keys the bucket hashes (the session secret)
 * @param {object} [options.limits]  { account, ip, token, registration, mail, mailTo, signup, code, importTo }
 * @param {number} [options.windowMs]
 * @param {*} [options.trustProxy]   see proxyHops() in http.js
 */
export function createRateLimiter({
  database, secret = '', limits = {}, windowMs = 15 * 60 * 1000,
  trustProxy = process.env.TRUST_PROXY, clock = () => Date.now(),
}) {
  const max = { ...DEFAULT_LIMITS, ...limits };
  const key = (kind, value) => `${kind}:${secret ? hmac(secret, value) : sha256(value)}`;
  const ipOf = (req) => clientIp(req, { trustProxy }) || 'unknown';
  const accountOf = (name) => String(name || '').trim().toLowerCase();

  /** How many in the window, and when the oldest of them leaves it. */
  function state(bucket) {
    const since = new Date(clock() - windowMs).toISOString();
    const row = database.get('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM login_attempts WHERE bucket = ? AND at > ?',
      bucket, since);
    return { count: Number(row.n), oldest: row.oldest };
  }
  const retryAfter = (oldest) =>
    Math.max(1, Math.ceil((Date.parse(oldest) + windowMs - clock()) / 1000));

  function blocked(bucket, limit) {
    const { count, oldest } = state(bucket);
    return count >= limit ? { allowed: false, retryAfter: retryAfter(oldest) } : null;
  }
  function add(...buckets) {
    const at = new Date(clock()).toISOString();
    database.tx(() => {
      for (const bucket of buckets) database.run('INSERT INTO login_attempts (bucket, at) VALUES (?, ?)', bucket, at);
    });
  }
  const clear = (...buckets) => {
    for (const bucket of buckets) database.run('DELETE FROM login_attempts WHERE bucket = ?', bucket);
  };

  return {
    /** Whether a sign-in may be tried. → { allowed, retryAfter? } */
    checkLogin(req, username) {
      const account = accountOf(username);
      return blocked(key('ip', ipOf(req)), max.ip)
        || (account && blocked(key('account', account), max.account))
        || { allowed: true };
    },
    loginFailed(req, username) {
      const account = accountOf(username);
      add(key('ip', ipOf(req)), ...(account ? [key('account', account)] : []));
    },
    /** A good sign-in clears that account and that address. */
    loginSucceeded(req, username) {
      const account = accountOf(username);
      clear(key('ip', ipOf(req)), ...(account ? [key('account', account)] : []));
    },

    /** Whether the second step's code may be tried: the account's wrong codes, and its address. */
    checkCode(req, userId) {
      return blocked(key('ip', ipOf(req)), max.ip)
        || blocked(key('code', String(userId)), max.code)
        || { allowed: true };
    },
    codeFailed(req, userId) { add(key('ip', ipOf(req)), key('code', String(userId))); },
    codeSucceeded(req, userId) { clear(key('ip', ipOf(req)), key('code', String(userId))); },

    /** Only consulted after a token has turned out to be invalid. */
    checkToken(req) {
      return blocked(key('token', ipOf(req)), max.token + 1) || { allowed: true };
    },
    tokenFailed(req) { add(key('token', ipOf(req))); },
    tokenSucceeded(req) { clear(key('token', ipOf(req))); },

    /**
     * Dynamic client registration asks for no credentials: anyone can sign
     * up as a client. Claude registers one on every new connection, so the
     * limit is generous, but it stops the table being filled by a script.
     */
    allowRegistration(req) {
      const bucket = key('registration', ipOf(req));
      const refused = blocked(bucket, max.registration);
      if (refused) return refused;
      add(bucket);
      return { allowed: true };
    },

    /**
     * Something a stranger can make happen that costs someone else —an email
     * sent, an account created—, per address. Counted when allowed. `kind` is
     * 'mail' or 'signup'.
     */
    allow(kind, req) {
      const bucket = key(kind, ipOf(req));
      const refused = blocked(bucket, max[kind] ?? 10);
      if (refused) return refused;
      add(bucket);
      return { allowed: true };
    },

    /** The same per recipient ('mail' → mailTo): nobody can bury an inbox in links. */
    allowTo(kind, target) {
      const bucket = key(`${kind}To`, accountOf(target));
      const refused = blocked(bucket, max[`${kind}To`] ?? 3);
      if (refused) return refused;
      add(bucket);
      return { allowed: true };
    },

    /** Forgets what is older than the window. */
    purge() {
      return database.run('DELETE FROM login_attempts WHERE at <= ?', new Date(clock() - windowMs).toISOString()).changes;
    },
  };
}
