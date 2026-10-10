/**
 * Device tokens: what an app on a phone holds instead of a browser session
 * (Tracker's native app), with `modules.devices`.
 *
 * The phone never sees a password or a session. It opens the system browser
 * on the app's own connect page with a PKCE challenge (RFC 7636, S256) and the
 * address to come back to (RFC 8252: a private-use scheme of the app's, such as
 * `com.example.app:/auth`). The person signs in there as on the web and says
 * yes; the page asks for a code (`issueCode`, session only, the address in the
 * product's allowlist) and sends the browser back to the app with it. The app
 * exchanges the code and its verifier for a token (`exchange`), which only the
 * app that started can do: whoever catches the code on its way back has no
 * verifier.
 *
 * · A code lasts five minutes and is spent by its first exchange, right or
 *   wrong. One that comes back after being spent was copied: the device it gave
 *   is revoked (OAuth 2.1 §4.1.2 does the same with its grants).
 * · A token starts with the product's own prefix (`devices.prefix`, never the
 *   API tokens'), carries 256 random bits and is kept as a hash. It ends when
 *   revoked, from Settings or from the device itself, when it goes unused for
 *   `devices.idleDays` (90), and with the account; a disabled account's are
 *   refused, as its API tokens are.
 * · No route of the suite takes one: `ctx.user` only ever comes from the
 *   session cookie. An app accepts a device on the routes it chooses with
 *   `authenticate(req)`, and the app can refuse people (`canConnect`, through
 *   `createApp({ devices })`) when they connect and on every use.
 *
 * Focus pairs kiosks and its future screens another way (a code shown on the
 * signed-in screen and typed or scanned on the device, bound to a profile with
 * runner-only scopes, in its `X-Focus-Device` header) and keeps its own pairing
 * and its own `devices` table: these tables are named so that both can live in
 * its database.
 */
import { randomToken, sha256, safeEqual } from './crypto.js';
import {
  HttpError, badRequest, forbidden, notFound, unauthorized, readJson, sendJson, str,
} from './http.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
/** How long a code waits for its exchange: the browser hands it back to the app at once. */
const CODE_MS = 5 * MINUTE;
/** Codes waiting at once per account: a page reloaded a few times, never a table filled by a script. */
const OPEN_CODES = 10;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const iso = (ms) => new Date(ms).toISOString();

export function deviceTokensSchema(d) {
  // Not `devices`: Focus has a table of its own by that name, for its kiosks.
  d.exec(`CREATE TABLE device_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    platform     TEXT,
    app_version  TEXT,
    token_hash   TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT
  );
  CREATE INDEX ix_device_tokens_user ON device_tokens (user_id);
  CREATE TABLE device_codes (
    code_hash      TEXT PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_challenge TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    name           TEXT NOT NULL,
    platform       TEXT,
    created_at     TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    used_at        TEXT,
    device_id      INTEGER REFERENCES device_tokens(id) ON DELETE SET NULL
  );
  CREATE INDEX ix_device_codes_user ON device_codes (user_id)`);
}

/**
 * Why `uri` can't be an address a device comes back to, or null. A private-use
 * scheme must be a reverse domain name (RFC 8252 §7.1: `com.example.app:/auth`),
 * so it is the app's own and not `javascript:`; otherwise https, or http on
 * loopback for a desktop app. Never a fragment: the code goes in the query.
 */
export function redirectUriProblem(uri) {
  if (typeof uri !== 'string' || !uri || uri.length > 300) return 'a URI of up to 300 characters';
  let u;
  try { u = new URL(uri); } catch { return 'not a URI'; }
  if (u.hash || uri.includes('#')) return 'no #fragment';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname) ? null : 'http only on loopback';
  if (/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+:$/.test(u.protocol)) return null;
  return 'a reverse-domain scheme such as com.example.app:/auth, https, or http on loopback';
}

/**
 * @param {object} options
 * @param {object} options.database
 * @param {string} options.prefix          how the app's device tokens start (`trackerdev_`)
 * @param {string[]} options.redirectUris  where a device may come back to, exactly
 * @param {number} [options.idleDays]      a token unused this long ends
 * @param {number} [options.maxPerUser]    devices connected at once per account
 * @param {object} [options.audit]
 */
export function createDevices({
  database, prefix, redirectUris = [], idleDays = 90, maxPerUser = 100, audit = null, clock = () => Date.now(),
}) {
  if (!/^[a-z]{2,10}_$/.test(String(prefix))) throw new Error('createDevices needs a prefix such as "appdev_"');
  const allowedRedirects = new Set(redirectUris);
  const idleMs = idleDays * DAY;
  /** Whether the app lets this person connect devices (createApp's `devices.canConnect`); everyone by default. */
  let canConnect = () => true;
  const allowed = (user) => {
    const answer = canConnect(user);
    // A promise is always truthy: an async check would let everyone in without a word.
    if (answer && typeof answer.then === 'function') throw new Error('devices.canConnect must answer true or false at once, not a promise');
    return Boolean(answer);
  };

  const columns = 'id, name, platform, app_version, created_at, last_used_at';
  /** The end of a token that goes on unused: its last use (or its creation) plus idleDays. */
  const endOf = (row) => Date.parse(row.last_used_at || row.created_at) + idleMs;
  const view = (row) => row && {
    id: row.id, name: row.name, platform: row.platform ?? null, app_version: row.app_version ?? null,
    created_at: row.created_at, last_used_at: row.last_used_at ?? null, expires_at: iso(endOf(row)),
  };
  const activeCount = (userId) => Number(database.get(`SELECT COUNT(*) AS n FROM device_tokens
    WHERE user_id = ? AND revoked_at IS NULL AND COALESCE(last_used_at, created_at) > ?`,
  userId, iso(clock() - idleMs)).n);

  const platformOf = (value) => {
    const text = str(value, { field: 'platform', max: 20, allowNull: true });
    if (text && !/^[a-z0-9][a-z0-9_-]*$/i.test(text)) throw badRequest('field_invalid', { field: 'platform' });
    return text ? text.toLowerCase() : null;
  };
  const versionOf = (value) => {
    const text = str(value, { field: 'app_version', max: 40, allowNull: true });
    if (text && !/^[\x20-\x7e]+$/.test(text)) throw badRequest('field_invalid', { field: 'app_version' });
    return text || null;
  };

  /**
   * A code for the browser to hand back to the app, for someone signed in here.
   * → { code, expires_at, redirect_uri, redirect_to }: `redirect_to` is the
   * address with the code (and `state`, when given) in its query.
   */
  function issueCode(user, {
    codeChallenge, codeChallengeMethod = 'S256', redirectUri, name, platform = null, state = null,
  } = {}) {
    if (!user || user.disabled_at) throw unauthorized();
    if (!allowed(user)) throw forbidden('device_not_allowed');
    if (codeChallengeMethod !== 'S256') throw badRequest('field_invalid', { field: 'code_challenge_method', options: ['S256'] });
    // A SHA-256 in base64url without padding is always 43 characters.
    const challenge = str(codeChallenge, { field: 'code_challenge', max: 200, min: 1 });
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw badRequest('field_invalid', { field: 'code_challenge' });
    const redirect = str(redirectUri, { field: 'redirect_uri', max: 300, min: 1 });
    if (!allowedRedirects.has(redirect)) throw badRequest('redirect_uri_not_allowed');
    const label = str(name, { field: 'name', max: 60, min: 1 });
    const kind = platformOf(platform);
    const echo = str(state, { field: 'state', max: 200, allowNull: true });
    if (activeCount(user.id) >= maxPerUser) throw badRequest('too_many_devices', { max: maxPerUser });
    const now = clock();
    const open = Number(database.get('SELECT COUNT(*) AS n FROM device_codes WHERE user_id = ? AND used_at IS NULL AND expires_at > ?',
      user.id, iso(now)).n);
    if (open >= OPEN_CODES) throw new HttpError(429, 'too_many_attempts', { retry_after: Math.ceil(CODE_MS / 1000) });
    const code = randomToken(32);
    database.run(`INSERT INTO device_codes (code_hash, user_id, code_challenge, redirect_uri, name, platform, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, sha256(code), user.id, challenge, redirect, label, kind, iso(now), iso(now + CODE_MS));
    const back = new URL(redirect);
    back.searchParams.set('code', code);
    if (echo) back.searchParams.set('state', echo);
    return { code, expires_at: iso(now + CODE_MS), redirect_uri: redirect, redirect_to: back.href };
  }

  /**
   * The code, its verifier and the address it was issued for, exchanged for a
   * token: shown here once, kept as a hash. → { token, device, user }
   */
  function exchange({ code, verifier, redirectUri, appVersion = null } = {}, { req = null } = {}) {
    const given = str(code, { field: 'code', max: 200, min: 1 });
    const proof = str(verifier, { field: 'code_verifier', max: 128, min: 1 });
    const redirect = str(redirectUri, { field: 'redirect_uri', max: 300, min: 1 });
    const version = versionOf(appVersion);
    const now = clock();
    // Decided in one transaction and thrown after it: a spent code stays spent, and a
    // device revoked because its code came back stays revoked, whatever is answered.
    const outcome = database.tx(() => {
      const row = database.get('SELECT * FROM device_codes WHERE code_hash = ?', sha256(given));
      if (!row) return { failed: 'unknown' };
      if (row.used_at) {
        const revoked = row.device_id
          ? database.run('UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', iso(now), row.device_id).changes > 0
          : false;
        return { failed: 'reused', row, revoked: revoked ? row.device_id : null };
      }
      database.run('UPDATE device_codes SET used_at = ? WHERE code_hash = ?', iso(now), row.code_hash);
      if (Date.parse(row.expires_at) <= now) return { failed: 'expired', row };
      if (row.redirect_uri !== redirect) return { failed: 'redirect', row };
      // RFC 7636 S256: the challenge is the verifier's SHA-256, which is what sha256() gives.
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(proof) || !safeEqual(sha256(proof), row.code_challenge)) {
        return { failed: 'verifier', row };
      }
      const user = database.get('SELECT * FROM users WHERE id = ?', row.user_id);
      if (!user || user.disabled_at) return { failed: 'account', row };
      if (!allowed(user)) return { refused: true, row };
      if (activeCount(user.id) >= maxPerUser) return { full: true, row };
      const token = `${prefix}${randomToken(32)}`;
      const { lastInsertRowid } = database.run(`INSERT INTO device_tokens
        (user_id, name, platform, app_version, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      user.id, row.name, row.platform, version, sha256(token), prefix, iso(now));
      database.run('UPDATE device_codes SET device_id = ? WHERE code_hash = ?', lastInsertRowid, row.code_hash);
      return { token, user, device: database.get(`SELECT ${columns} FROM device_tokens WHERE id = ?`, lastInsertRowid) };
    });
    const actor = outcome.row?.user_id ?? null;
    if (outcome.failed) {
      audit?.record({
        action: 'device.token_failed', actor, req,
        meta: { reason: outcome.failed, ...(outcome.revoked ? { revoked: outcome.revoked } : {}) },
      });
      if (outcome.revoked) {
        audit?.record({ action: 'device.revoke', actor, req, targetType: 'device', targetId: outcome.revoked, meta: { by: 'code_reused' } });
      }
      throw badRequest('device_code_invalid');
    }
    if (outcome.refused) {
      audit?.record({ action: 'device.token_failed', actor, req, meta: { reason: 'not_allowed' } });
      throw forbidden('device_not_allowed');
    }
    if (outcome.full) throw badRequest('too_many_devices', { max: maxPerUser });
    audit?.record({
      action: 'device.create', actor: outcome.user, req, targetType: 'device', targetId: outcome.device.id,
      meta: { platform: outcome.device.platform ?? null },
    });
    return { token: outcome.token, device: view(outcome.device), user: outcome.user };
  }

  /** The bearer token of a request (or the token itself) when it is one of this app's devices'. */
  function tokenOf(reqOrToken) {
    const value = typeof reqOrToken === 'string' ? reqOrToken
      : /^Bearer\s+(\S+)\s*$/i.exec(String(reqOrToken?.headers?.authorization || ''))?.[1];
    return value && value.length <= 200 && value.startsWith(prefix) ? value : null;
  }

  /**
   * The account of a request's device token (`Authorization: Bearer <prefix>…`),
   * with `device_id`, or null: not a device token, unknown, revoked, unused for
   * too long, of a disabled account or of someone the app no longer lets in.
   * Its last use is noted at most once a minute. A failure costs one lookup and
   * writes nothing: a revoked phone that keeps retrying in the background fills
   * no table.
   */
  function authenticate(reqOrToken) {
    const token = tokenOf(reqOrToken);
    if (!token) return null;
    const now = clock();
    const row = database.get(`SELECT d.id AS device_id, d.created_at AS device_created_at, d.last_used_at AS device_used_at,
        d.revoked_at AS device_revoked_at, u.*
      FROM device_tokens d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?`, sha256(token));
    if (!row || row.device_revoked_at || row.disabled_at) return null;
    if (endOf({ created_at: row.device_created_at, last_used_at: row.device_used_at }) <= now) return null;
    const user = { ...row };
    for (const key of ['device_created_at', 'device_used_at', 'device_revoked_at']) delete user[key];
    if (!allowed(user)) return null;
    if (!row.device_used_at || now - Date.parse(row.device_used_at) > MINUTE) {
      database.run('UPDATE device_tokens SET last_used_at = ? WHERE id = ?', iso(now), row.device_id);
    }
    return user;
  }

  /** Whether a device still works: for a connection the app keeps open (a socket's heartbeat). */
  function isActive(id) {
    const row = database.get(`SELECT d.created_at, d.last_used_at, d.revoked_at, u.disabled_at, u.id AS user_id
      FROM device_tokens d JOIN users u ON u.id = d.user_id WHERE d.id = ?`, id);
    if (!row || row.revoked_at || row.disabled_at || endOf(row) <= clock()) return false;
    return allowed(database.get('SELECT * FROM users WHERE id = ?', row.user_id));
  }

  /** A person's devices that still work, last used first. */
  const list = (userId) => database.all(`SELECT ${columns} FROM device_tokens
    WHERE user_id = ? AND revoked_at IS NULL AND COALESCE(last_used_at, created_at) > ?
    ORDER BY COALESCE(last_used_at, created_at) DESC, id DESC`, userId, iso(clock() - idleMs)).map(view);

  /** Revokes one of a person's devices. False if it isn't theirs or no longer works. */
  const revoke = (userId, id) => database.run(`UPDATE device_tokens SET revoked_at = ?
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL`, iso(clock()), id, userId).changes > 0;

  /**
   * Forgets codes a day after they expired, and devices a month after they
   * were revoked or stopped working: the audit log says what happened.
   */
  function purge() {
    const now = clock();
    const codes = database.run('DELETE FROM device_codes WHERE expires_at < ?', iso(now - DAY)).changes;
    const gone = database.run(`DELETE FROM device_tokens WHERE revoked_at < ? OR COALESCE(last_used_at, created_at) < ?`,
      iso(now - 30 * DAY), iso(now - idleMs - 30 * DAY)).changes;
    return codes + gone;
  }

  return {
    prefix, idleDays, maxPerUser, issueCode, exchange, authenticate, isActive, list, revoke, purge,
    /** createApp's `devices.canConnect(user)`: whether the app lets that person connect devices. */
    setCanConnect(fn) {
      if (typeof fn !== 'function') throw new Error('devices.canConnect must be a function (user) => boolean');
      canConnect = fn;
    },
  };
}

/**
 * The routes, with `modules.devices`. Codes and the list are for the person
 * signed in on the web (`ctx.user` comes only from the session cookie); the
 * token is for the app with its code and verifier, with the brake per address
 * for failures; and a device signs itself out with its own token.
 */
export function registerDevicesApi(router, { devices, limiter, audit = null }) {
  const requireUser = (ctx) => {
    if (!ctx.user) throw unauthorized();
    return ctx.user;
  };

  /** A code for the connect page to hand back to the app (its body is the PKCE request). */
  router.post('/api/devices/codes', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    sendJson(ctx.res, 201, devices.issueCode(user, {
      codeChallenge: body.code_challenge, codeChallengeMethod: body.code_challenge_method ?? 'S256',
      redirectUri: body.redirect_uri, name: body.name, platform: body.platform ?? null, state: body.state ?? null,
    }), { 'Cache-Control': 'no-store' });
  });

  /**
   * The code and its verifier for a token. Only failures count against the
   * address, so a fleet of phones connected from one office is never stopped.
   */
  router.post('/api/devices/token', async (ctx) => {
    const brake = limiter.checkFailures('devices', ctx.req);
    if (!brake.allowed) throw new HttpError(429, 'too_many_attempts', { retry_after: brake.retryAfter });
    let result;
    try {
      const body = await readJson(ctx.req);
      result = devices.exchange({
        code: body.code, verifier: body.code_verifier, redirectUri: body.redirect_uri, appVersion: body.app_version ?? null,
      }, { req: ctx.req });
    } catch (err) {
      if (err instanceof HttpError && err.status < 500) limiter.noteFailure('devices', ctx.req);
      throw err;
    }
    // The value travels once, here. After that only its hash remains.
    sendJson(ctx.res, 200, { token: result.token, token_type: 'Bearer', device: result.device }, { 'Cache-Control': 'no-store' });
  });

  router.get('/api/me/devices', (ctx) => {
    const user = requireUser(ctx);
    sendJson(ctx.res, 200, devices.list(user.id));
  });

  router.delete('/api/me/devices/:id', (ctx) => {
    const user = requireUser(ctx);
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0 || !devices.revoke(user.id, id)) throw notFound('device_not_found');
    audit?.record({ action: 'device.revoke', actor: user, req: ctx.req, targetType: 'device', targetId: id, meta: { by: 'owner' } });
    sendJson(ctx.res, 200, { ok: true });
  });

  /** The device signs itself out with its own token (the app's sign-out): never a session's. */
  router.delete('/api/devices/current', (ctx) => {
    const user = devices.authenticate(ctx.req);
    if (!user) throw unauthorized();
    devices.revoke(user.id, user.device_id);
    audit?.record({
      action: 'device.revoke', actor: user, req: ctx.req, targetType: 'device', targetId: user.device_id, meta: { by: 'device' },
    });
    sendJson(ctx.res, 200, { ok: true });
  });
}
