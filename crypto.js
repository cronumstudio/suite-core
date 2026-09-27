/**
 * Passwords, tokens and their hashes.
 *
 * Every app of the suite already stores passwords the same way —
 * `scrypt$N$r$p$<salt base64>$<key base64>` with N=16384, r=8, p=1, a 16-byte
 * salt and a 32-byte key— and tokens as SHA-256 in base64url. This module keeps
 * both formats exactly, so moving an app onto it asks nobody for a new
 * password and invalidates no token.
 *
 * The hash says which parameters made it, so they can be raised one day
 * without breaking the passwords stored before: verification re-derives with
 * the stored ones.
 */
import crypto from 'node:crypto';

/** Today's cost. `needsRehash()` says when a stored hash is below it. */
export const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 32, saltLength: 16 });

/** Enough for N up to 2^17 with r=8; bounds what a stored hash can make us spend. */
const MAX_MEMORY = 256 * 1024 * 1024;

/** A random value for tokens, codes and secrets: `bytes` of entropy, base64url. */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/**
 * The hash of a token, which is all that is stored. Plain SHA-256 is enough: a
 * token carries 192 bits or more of randomness, so there is nothing to guess.
 * It does not depend on any secret on purpose: changing SESSION_SECRET must not
 * break the connectors already set up.
 */
export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('base64url');

/** A keyed hash (HMAC-SHA256, base64url): session tokens and signatures. */
export const hmac = (secret, value) =>
  crypto.createHmac('sha256', String(secret)).update(String(value)).digest('base64url');

/** Constant-time comparison of two strings. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** A password hash in the self-describing format. */
export function hashPassword(password, { N = SCRYPT.N, r = SCRYPT.r, p = SCRYPT.p } = {}) {
  const salt = crypto.randomBytes(SCRYPT.saltLength);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keyLength, { N, r, p, maxmem: MAX_MEMORY });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** The parameters of a stored hash, or null when it is not one this module can check. */
function parse(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  // Bounds on what a stored value can ask for: a corrupt or planted hash must
  // fail closed, not make the server spend minutes and gigabytes on it.
  if (!Number.isInteger(N) || N < 1024 || N > 131072 || (N & (N - 1))) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 8) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const key = Buffer.from(parts[5], 'base64');
  if (salt.length < 8 || key.length < 16 || key.length > 64) return null;
  return { N, r, p, salt, key };
}

/**
 * Whether `password` matches `stored`. Anything that is not a valid hash —an
 * empty value, the `!` that marks an account without a password— never does.
 */
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 1024) return false;
  const hash = parse(stored);
  if (!hash) return false;
  try {
    const actual = crypto.scryptSync(password, hash.salt, hash.key.length,
      { N: hash.N, r: hash.r, p: hash.p, maxmem: MAX_MEMORY });
    return crypto.timingSafeEqual(actual, hash.key);
  } catch {
    return false;
  }
}

/** Whether a stored hash was made with less than today's cost (rehash it on the next sign-in). */
export function needsRehash(stored) {
  const hash = parse(stored);
  return !hash || hash.N < SCRYPT.N || hash.r < SCRYPT.r || hash.p < SCRYPT.p
    || hash.key.length < SCRYPT.keyLength;
}
