/**
 * Two-step verification for local accounts: a code from an authenticator app
 * (TOTP, RFC 6238: Google Authenticator, 1Password, Aegis…) after the
 * password, or one of ten recovery codes when the phone is gone.
 *
 * · The secret is kept encrypted (AES-256-GCM, crypto.js) with a key derived
 *   from the session secret: a copy of the database alone doesn't give it.
 *   Changing SESSION_SECRET makes it unreadable; the recovery codes still
 *   work (they are hashes), and with one of them, or an administrator, the
 *   second step is turned off and set up again.
 * · A code works once: the time step it belongs to is remembered.
 * · Recovery codes are kept as hashes and each works once.
 * · Between the password and the code there is no session, only a signed
 *   challenge that lasts five minutes and says who passed the first step.
 *
 * With WorkOS or an OpenID Connect provider the second step is the provider's.
 */
import crypto from 'node:crypto';
import { sha256, safeEqual, encryptText, decryptText } from './crypto.js';
import { ensureColumn } from './migrate.js';
import { HttpError, badRequest, conflict } from './http.js';

const STEP_SECONDS = 30;
const DIGITS = 6;
const CHALLENGE_MS = 5 * 60 * 1000;
const RECOVERY_CODES = 10;
const iso = (ms) => new Date(ms).toISOString();

export function twoFactorSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS user_two_factor (
    user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret       TEXT NOT NULL,
    confirmed_at TEXT,
    last_step    INTEGER,
    created_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_recovery_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    used_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_recovery_codes_user ON user_recovery_codes (user_id)`);
  // When it was turned on: what the account says about itself (publicUser).
  ensureColumn(d, 'users', 'two_factor_at', 'two_factor_at TEXT');
}

/* --------------------------------- TOTP --------------------------------- */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code of a time step (HOTP, RFC 4226, with HMAC-SHA1 as every authenticator app does). */
export function totp(secret, step, digits = DIGITS) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const number = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(number).padStart(digits, '0');
}

/** The step a code belongs to within one step either side (clocks drift), or null. */
export function matchStep(secret, code, now = Date.now(), window = 1) {
  const clean = String(code ?? '').replace(/\s/g, '');
  if (!secret?.length || !/^\d{6}$/.test(clean)) return null;
  const current = Math.floor(now / 1000 / STEP_SECONDS);
  for (let step = current - window; step <= current + window; step++) {
    if (safeEqual(totp(secret, step), clean)) return step;
  }
  return null;
}

/* ------------------------------- the service ------------------------------ */

/**
 * @param {object} options
 * @param {object} options.database
 * @param {Function} options.sign      the session secret's signature (sessions.sign)
 * @param {string} options.issuer      how the authenticator app names the account's app
 * @param {object} [options.limiter]   from createRateLimiter(): the brake on wrong codes
 * @param {Function} [options.onChange]  (userId) when it is turned on or off, or the codes renewed
 */
export function createTwoFactor({
  database, sign, issuer, limiter = null, onChange = () => {}, clock = () => Date.now(),
}) {
  // The key that encrypts the secrets, derived from the session secret.
  const key = crypto.createHash('sha256').update(sign('two-factor-secrets')).digest();

  const row = (userId) => database.get('SELECT * FROM user_two_factor WHERE user_id = ?', userId);
  const isEnabled = (userId) => Boolean(row(userId)?.confirmed_at);
  const secretOf = (found) => {
    const text = found && decryptText(key, found.secret);
    return text ? base32Decode(text) : null;
  };

  function status(userId) {
    const found = row(userId);
    return {
      enabled: Boolean(found?.confirmed_at),
      enabled_at: found?.confirmed_at ?? null,
      recovery_codes_left: found?.confirmed_at
        ? Number(database.get('SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL', userId).n)
        : 0,
    };
  }

  /** A new secret to set up, not in use until a code from it is confirmed. */
  function begin(user) {
    if (isEnabled(user.id)) throw conflict('two_factor_enabled');
    const secret = base32Encode(crypto.randomBytes(20));
    database.run(`INSERT INTO user_two_factor (user_id, secret, created_at) VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET secret = excluded.secret, confirmed_at = NULL, last_step = NULL,
        created_at = excluded.created_at`, user.id, encryptText(key, secret), iso(clock()));
    const label = encodeURIComponent(`${issuer}:${user.username}`);
    const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
    return { secret, uri };
  }

  function newRecoveryCodes(userId) {
    database.run('DELETE FROM user_recovery_codes WHERE user_id = ?', userId);
    const codes = [];
    for (let i = 0; i < RECOVERY_CODES; i++) {
      const code = base32Encode(crypto.randomBytes(5)).toLowerCase();   // 8 characters
      const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
      database.run('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)', userId, sha256(code));
      codes.push(shown);
    }
    return codes;
  }

  /** Turns it on with a code from the new secret; returns the recovery codes, shown once. */
  function enable(userId, code) {
    return database.tx(() => {
      const found = row(userId);
      if (found?.confirmed_at) throw conflict('two_factor_enabled');
      // Nothing to confirm, or a secret the key no longer opens (SESSION_SECRET changed).
      const secret = secretOf(found);
      if (!secret) throw conflict('two_factor_not_started');
      const step = matchStep(secret, code, clock());
      if (step == null) throw badRequest('code_invalid');
      const now = iso(clock());
      database.run('UPDATE user_two_factor SET confirmed_at = ?, last_step = ? WHERE user_id = ?', now, step, userId);
      database.run('UPDATE users SET two_factor_at = ? WHERE id = ?', now, userId);
      const codes = newRecoveryCodes(userId);
      onChange(userId);
      return codes;
    });
  }

  /**
   * A code at sign-in: from the app (once per time step) or a recovery code
   * (once). Returns 'totp', 'recovery' or null.
   */
  function verify(userId, code) {
    return database.tx(() => {
      const found = row(userId);
      if (!found?.confirmed_at) return null;
      const step = matchStep(secretOf(found), code, clock());
      if (step != null && (found.last_step == null || step > found.last_step)) {
        database.run('UPDATE user_two_factor SET last_step = ? WHERE user_id = ?', step, userId);
        return 'totp';
      }
      const recovery = String(code ?? '').toLowerCase().replace(/[\s-]/g, '');
      if (!/^[a-z2-7]{8}$/.test(recovery)) return null;
      const used = database.run(`UPDATE user_recovery_codes SET used_at = ? WHERE id = (SELECT id FROM user_recovery_codes
        WHERE user_id = ? AND code_hash = ? AND used_at IS NULL LIMIT 1)`, iso(clock()), userId, sha256(recovery));
      return used.changes ? 'recovery' : null;
    });
  }

  /**
   * The second step of a sign-in, with the brake: how it was passed ('totp'
   * or 'recovery'), or 429 too_many_attempts, or 400 code_invalid.
   */
  function pass(req, userId, code) {
    const allowed = limiter ? limiter.checkCode(req, userId) : { allowed: true };
    if (!allowed.allowed) throw new HttpError(429, 'too_many_attempts', { retry_after: allowed.retryAfter });
    const how = verify(userId, code);
    if (!how) {
      limiter?.codeFailed(req, userId);
      throw badRequest('code_invalid');
    }
    limiter?.codeSucceeded(req, userId);
    return how;
  }

  /** Off: the secret and the recovery codes go. */
  function disable(userId) {
    return database.tx(() => {
      const removed = database.run('DELETE FROM user_two_factor WHERE user_id = ?', userId).changes;
      database.run('DELETE FROM user_recovery_codes WHERE user_id = ?', userId);
      database.run('UPDATE users SET two_factor_at = NULL WHERE id = ?', userId);
      if (removed > 0) onChange(userId);
      return removed > 0;
    });
  }

  /** Ten new recovery codes; the old ones stop working. */
  function regenerateRecoveryCodes(userId) {
    if (!isEnabled(userId)) throw conflict('two_factor_off');
    const codes = database.tx(() => newRecoveryCodes(userId));
    onChange(userId);
    return codes;
  }

  /* ------------------------------ challenges ----------------------------- */

  /** Proof that someone passed the password, for the second step: five minutes. */
  function challengeFor(userId) {
    const expires = clock() + CHALLENGE_MS;
    const body = `${userId}.${expires}`;
    return `${body}.${sign(`two-factor|${body}`)}`;
  }

  /** The user id of a challenge, or an error: `challenge_invalid` or `challenge_expired` (410). */
  function readChallenge(token) {
    const [userId, expires, signature] = String(token ?? '').split('.');
    const body = `${userId}.${expires}`;
    if (!/^\d+$/.test(userId || '') || !/^\d+$/.test(expires || '') || !signature
      || !safeEqual(signature, sign(`two-factor|${body}`))) throw badRequest('challenge_invalid');
    if (Number(expires) < clock()) throw new HttpError(410, 'challenge_expired');
    return Number(userId);
  }

  return {
    status, isEnabled, begin, enable, verify, pass, disable, regenerateRecoveryCodes, challengeFor, readChallenge,
  };
}
