/**
 * JSON Web Tokens signed by someone else —AuthKit, an OIDC provider— checked
 * against the keys they publish (JWKS), and the claims everyone checks.
 *
 * Only asymmetric signatures are accepted (RS256, ES256): never `none`, never
 * HS256, which would let the public key be used as the secret.
 */
import crypto from 'node:crypto';

/** Header and claims of a JWT, without checking anything. Null when it isn't one. */
export function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
      payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2], 'base64url'),
    };
  } catch {
    return null;
  }
}

/**
 * The published keys of an issuer, by `kid`. Kept an hour; an unknown key
 * forces a new fetch —that is how a rotation is picked up— but at most every
 * five minutes, so made-up tokens can't be used to hammer the issuer.
 *
 * When the issuer can't be reached, the keys in hand keep serving for up to
 * `staleMs` (an outage that falls on the hourly refresh must not refuse every
 * token) and it is asked again every `retryMs`; without a key in hand for that
 * token, again after `quickRetryMs`, so a blip doesn't refuse everyone for
 * minutes. An answer with no usable key counts as a failure, not as a rotation
 * to no keys.
 *
 * @param {() => Promise<object[]>} load   the `keys` of the JWKS document; throws when it can't
 * @param {(message: string) => Error} [unavailable]   the error for an answer with no usable key:
 *   the caller's "can't check now" class, so it is told apart from a bad token
 */
export function createKeySet({
  load, ttlMs = 3600 * 1000, retryMs = 5 * 60 * 1000, quickRetryMs = 10 * 1000, staleMs = 24 * 3600 * 1000,
  unavailable = (message) => new Error(message), clock = () => Date.now(),
}) {
  const state = { byKid: new Map(), at: 0, loading: null, failedAt: 0, failure: null };

  async function refresh() {
    const byKid = new Map();
    for (const jwk of await load()) {
      if (!['RSA', 'EC'].includes(jwk?.kty) || !jwk.kid || (jwk.use && jwk.use !== 'sig')) continue;
      try { byKid.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch { /* odd key: left out */ }
    }
    if (!byKid.size) throw unavailable('the issuer published no usable key');
    state.byKid = byKid;
    state.at = clock();
    state.failedAt = 0;
    state.failure = null;
  }

  /** A key still in hand, if the last good answer isn't too old. */
  const inHand = (kid) => (state.byKid.has(kid) && clock() - state.at < staleMs ? state.byKid.get(kid) : null);

  async function keyFor(kid) {
    const age = clock() - state.at;
    if (state.byKid.has(kid) && age < ttlMs) return state.byKid.get(kid);
    if (state.at && age < retryMs) return state.byKid.get(kid) || null;
    if (state.failedAt) {
      const since = clock() - state.failedAt;
      const key = inHand(kid);
      if (key && since < retryMs) return key;
      if (!key && since < quickRetryMs) throw state.failure;
    }
    state.loading ??= refresh().catch((err) => {
      state.failedAt = clock();
      state.failure = err;
    }).finally(() => { state.loading = null; });
    await state.loading;
    if (state.failure) {
      const key = inHand(kid);
      if (key) return key;
      throw state.failure;
    }
    return state.byKid.get(kid) || null;
  }

  return { keyFor };
}

const ALGORITHMS = {
  RS256: (key, input, signature) => crypto.verify('RSA-SHA256', input, key, signature),
  // A JWT carries an ECDSA signature as r‖s, not DER.
  ES256: (key, input, signature) => crypto.verify('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, signature),
};

/**
 * The claims of a valid token, or null: signed by one of the issuer's keys,
 * from that issuer, for that audience (when given), in date, with the nonce of
 * this sign-in (when given).
 * @throws whatever the key set throws when the keys can't be fetched
 */
export async function verifyJwt(token, {
  keys, issuer, audience = null, nonce = null, algorithms = ['RS256', 'ES256'], clockSkew = 60,
  clock = () => Date.now(),
}) {
  const jwt = decodeJwt(token);
  if (!jwt) return null;
  const { header, payload, signingInput, signature } = jwt;
  if (!algorithms.includes(header?.alg) || !ALGORITHMS[header.alg] || !header.kid) return null;
  const key = await keys.keyFor(header.kid);
  if (!key) return null;
  let valid = false;
  try { valid = ALGORITHMS[header.alg](key, Buffer.from(signingInput), signature); } catch { valid = false; }
  if (!valid) return null;

  const now = Math.floor(clock() / 1000);
  const noSlash = (value) => String(value || '').replace(/\/+$/, '');
  if (noSlash(payload.iss) !== noSlash(issuer)) return null;
  if (typeof payload.exp !== 'number' || payload.exp < now - clockSkew) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + clockSkew) return null;
  if (audience && ![].concat(payload.aud ?? []).includes(audience)) return null;
  if (nonce !== null && payload.nonce !== nonce) return null;
  if (!payload.sub) return null;
  return payload;
}
