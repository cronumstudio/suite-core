/**
 * The suite's pages for an app on a phone (devices.js), each behind an option
 * of `devices` that is off unless the app turns it on: an app that sets none of
 * them serves nothing new.
 *
 * `devices.connectPage` — `/devices/connect`, where a signed-in account allows a
 * phone, ported from Tracker's own (its server/device-connect.js and
 * public/js/connect.js, which Tracker keeps). The native app opens the system
 * browser there with a PKCE challenge, a state, its return address and the
 * phone's name and platform; the person signs in and says yes; the page
 * (web/connect.js) asks `POST /api/devices/codes` for a code and goes back to
 * the app with it, which trades it for its token (`POST /api/devices/token`).
 * What the server does for it:
 *
 * - the request's check, on every GET of the page: anything that is not one
 *   gets the bare page (302), which says the link can't connect a device, so
 *   nothing else ever carries a bad request on;
 * - without a session, under a sign-in that leaves the site (WorkOS, OIDC), the
 *   request is kept in a host-only cookie, `<app id>_connect` (10 minutes,
 *   HttpOnly, SameSite=Lax, signed with the session secret), and the browser
 *   goes to /auth/login. The provider's callback lands on `/`, where `back()`
 *   finds the cookie and a session, sends the browser back to the page with the
 *   request, and clears the cookie. With local accounts the page signs in in
 *   place, so no cookie is needed;
 * - a cookie that was changed, has expired or no longer names an allowed return
 *   address is dropped, and `/` shows as it would without it;
 * - "Use another account" (web/connect.js): the page ends the browser's session
 *   (`POST /api/auth/logout`, the provider's logout_url left aside) and opens
 *   itself again with `prompt=login`. Under a provider's sign-in the browser
 *   then goes to `/auth/login?prompt=login`, which asks the provider to sign in
 *   again (OIDC `prompt=login`, AuthKit `max_age=0`) instead of taking the
 *   session it still holds; with local accounts the page signs in in place.
 *
 * The query and the cookie hold the challenge, the state, the return address
 * and the phone's name and platform, never a code or a secret: the code travels
 * only in the page's answer from `/api/devices/codes` and in the address back to
 * the app.
 *
 * `devices.webSessions` — `/devices/session?code=…&next=…`, where the device's
 * WebView turns a code of one minute (`POST /api/devices/web-session`, with the
 * device's token) into an ordinary session of the web, the same cookie a
 * sign-in sets, linked to the device so that it ends with it (sessions.js,
 * devices.js). Then to `next`, a path of this site only. A code that is not one,
 * was spent or expired, or a device that no longer works, opens nothing and
 * goes to `/`, where whoever is there signs in as usual; these failures count
 * against the address as the token's exchange does (`rateLimits.devices`).
 * Refused, without spending the code and without counting, and sent to
 * `/?device_session=refused` (so the app can clear its WebView's cookies and
 * try once more): a request that is not the app's own load (`Sec-Fetch-Site`
 * other than `none`: another site, or a link or an image in a note of this
 * one), one that is not the page itself (`Sec-Fetch-Dest` other than
 * `document`, `Sec-Fetch-Mode` other than `navigate`: an image, a frame, a
 * fetch; a WebView that sends none of the three is let through), and one from
 * a browser where someone else is signed in (only a session a device opened
 * before is replaced, and only by a load that says `Sec-Fetch-Site: none`).
 * Every opened session and every failure is in the audit log; of the
 * refusals, only someone else's session (`signed_in`), a few times per
 * address in the window.
 *
 * No second step is asked there: the token was given to a session that had
 * already passed it (`/api/devices/codes` takes only a session, and a session
 * only exists after the second step), and every session it opens dies with it.
 * Asking again would give nothing a stolen token doesn't already open.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appendHeader, parseCookies, serializeCookie } from './http.js';
import { safeEqual } from './crypto.js';
import { brandedAdmin } from './brand.js';

export const CONNECT_PATH = '/devices/connect';
export const SESSION_PATH = '/devices/session';
/** Where a refused `/devices/session` goes, so the app can tell it from a code that failed. */
export const REFUSED_PATH = '/?device_session=refused';
/** Where the sign-in starts for "another account": the provider asks again, whatever session it holds. */
export const FRESH_LOGIN_PATH = '/auth/login?prompt=login';
/** How long the request waits in the cookie for the sign-in to come back. */
export const CONNECT_MS = 10 * 60 * 1000;
const PAGE = fileURLToPath(new URL('./web/connect.html', import.meta.url));

// The core's own rules for a code (devices.js, issueCode), so a request the page carries on is one
// the core takes: a SHA-256 in base64url, a name of up to 60 characters and a platform such as
// `ios` or `android`. The state is the app's own, echoed back: URL-safe only.
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[A-Za-z0-9._~-]{1,200}$/;
const PLATFORM = /^[a-z0-9][a-z0-9_-]{0,19}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** The request's fields, in the order the page's address carries them. */
export const CONNECT_FIELDS = Object.freeze(['code_challenge', 'state', 'redirect_uri', 'name', 'platform']);

/**
 * The connect request in `input` (the page's URLSearchParams, or the cookie's object), checked,
 * or null when it is not one: `{ code_challenge, state, redirect_uri, name, platform }`, the name
 * trimmed and the platform in lower case (null when not given). `redirectUris` is the install's
 * list (`devices.redirectUris`): the address must be one of them, exactly. A field given twice is
 * no request; anything else in the query is ignored.
 *
 * @param {URLSearchParams|Record<string, unknown>} input
 * @param {{ redirectUris?: string[] }} [options]
 */
export function connectRequest(input, { redirectUris = [] } = {}) {
  const read = (name) => {
    if (input instanceof URLSearchParams) {
      const all = input.getAll(name);
      return all.length > 1 ? undefined : all[0] ?? null;
    }
    const value = input?.[name];
    return value == null ? null : typeof value === 'string' ? value : undefined;
  };
  const values = Object.fromEntries(CONNECT_FIELDS.map((name) => [name, read(name)]));
  if (Object.values(values).includes(undefined)) return null;
  const name = values.name?.trim() ?? '';
  const platform = values.platform || null;
  if (!CHALLENGE.test(values.code_challenge ?? '') || !STATE.test(values.state ?? '')
      || !redirectUris.includes(values.redirect_uri) || !name || name.length > 60 || CONTROL.test(name)
      || (platform !== null && !PLATFORM.test(platform))) return null;
  return {
    code_challenge: values.code_challenge, state: values.state, redirect_uri: values.redirect_uri, name,
    platform: platform && platform.toLowerCase(),
  };
}

/** The page's address for a checked request: `/devices/connect?code_challenge=…`. */
export function connectPath(request) {
  const query = new URLSearchParams();
  for (const name of CONNECT_FIELDS) if (request[name] != null) query.set(name, request[name]);
  return `${CONNECT_PATH}?${query}`;
}

/**
 * The cookie that carries a request across the sign-in: `<payload>.<signature>`, the payload the
 * request and its end in base64url JSON, the signature the session secret's (`sign`, sessions.sign).
 * Host-only (no Domain), on `/`, HttpOnly, SameSite=Lax, Secure on https.
 */
export function createConnectCookie({
  name, sign, secure = false, redirectUris = [], clock = () => Date.now(),
}) {
  const signature = (payload) => sign(`device-connect|${payload}`);
  const cookie = (value, maxAge) => serializeCookie(name, value, { maxAge, httpOnly: true, sameSite: 'Lax', secure });
  return {
    name,
    /** The value for a request: what `write` sets (tests build changed and expired ones from it). */
    value(request, expires = clock() + CONNECT_MS) {
      const payload = Buffer.from(JSON.stringify({ ...request, expires })).toString('base64url');
      return `${payload}.${signature(payload)}`;
    },
    write(res, request) { appendHeader(res, 'Set-Cookie', cookie(this.value(request), CONNECT_MS / 1000)); },
    clear(res) { appendHeader(res, 'Set-Cookie', cookie('', 0)); },
    /** Whether the request carries the cookie at all, good or not. */
    present: (req) => Object.hasOwn(parseCookies(req), name),
    /** The request the cookie carries, or null: none, changed, expired or no longer allowed. */
    read(req) {
      const value = parseCookies(req)[name];
      if (typeof value !== 'string' || !value || value.length > 4096) return null;
      const dot = value.lastIndexOf('.');
      if (dot <= 0) return null;
      const payload = value.slice(0, dot);
      if (!safeEqual(value.slice(dot + 1), signature(payload))) return null;
      let data = null;
      try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
      if (!data || typeof data !== 'object' || !Number.isSafeInteger(data.expires) || data.expires <= clock()) return null;
      return connectRequest(data, { redirectUris });
    },
  };
}

/**
 * Where a session from a device goes: `next` when it is a path of this site (`/tasks/`,
 * `/notes/?q=a`), and `/` for anything else (another site, `//elsewhere`, a backslash that a
 * browser reads as a slash, a control character, a value given twice).
 */
export function localNext(params) {
  const all = params.getAll('next');
  const value = all.length === 1 ? all[0] : null;
  if (typeof value !== 'string' || value.length > 2000 || !/^\/(?![/\\])/.test(value)
      || /[\\\u0000-\u001f\u007f\s]/.test(value)) return '/';
  try {
    const base = 'http://this.invalid';
    return new URL(value, base).origin === base ? value : '/';
  } catch {
    return '/';
  }
}

/**
 * The pages, for createApp's dispatch. → { handle(req, res, url), back(req, res, url) }, each
 * answering true when it has answered; null when the app turned none of them on.
 *
 * @param {object} options
 * @param {object} options.suite   from createSuite(): config, sessions, devices, accounts, limiter, audit
 */
export function createDevicePages({ suite, clock = () => Date.now() }) {
  const { config, sessions, devices, accounts, limiter, audit } = suite;
  const options = config.devices || {};
  if (!devices || (!options.connectPage && !options.webSessions)) return null;
  const { install } = config;
  const external = install.authProvider !== 'local';
  const cookie = options.connectPage ? createConnectCookie({
    name: `${config.app.id.replace(/-/g, '_')}_connect`, sign: sessions.sign, secure: install.secureCookies,
    redirectUris: options.redirectUris, clock,
  }) : null;

  const send = (res, location) => {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Content-Length': 0 });
    res.end();
    return true;
  };

  /** The page itself: the kit draws it (web/connect.js), in the product's colours and name. */
  function page(req, res) {
    // Read on every request, as /admin is: small, and a new suite-core is served without a restart.
    const body = brandedAdmin(fs.readFileSync(PAGE, 'utf8'), config.app);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  function connect(req, res, url) {
    if (url.search) {
      const request = connectRequest(url.searchParams, { redirectUris: options.redirectUris });
      if (!request) return send(res, CONNECT_PATH);
      if (external && !sessions.userFrom(req)) {
        cookie.write(res, request);
        // "Use another account" (web/connect.js): the provider must not sign the same person in again.
        const fresh = url.searchParams.getAll('prompt').length === 1 && url.searchParams.get('prompt') === 'login';
        return send(res, fresh ? FRESH_LOGIN_PATH : '/auth/login');
      }
    }
    return page(req, res);
  }

  function session(req, res, url) {
    // A HEAD (a link preview) spends nothing.
    if (req.method === 'HEAD') return send(res, '/');
    const fail = (reason, userId = null) => {
      limiter.noteFailure('devices', req);
      audit?.record({ action: 'device.web_session_failed', actor: userId, req, meta: { reason } });
      return send(res, '/');
    };
    // A refusal is no guess at a code (the code is not spent, often not even looked at), so it
    // doesn't count against the address: a page that loads the address many times over would
    // otherwise lock the reader's own phone out of the token's bucket. Nor does one that only the
    // headers decided write to the audit log, or anyone could fill it with no code and no brake.
    const refuse = () => send(res, REFUSED_PATH);
    const brake = limiter.checkFailures('devices', req);
    if (!brake.allowed) return send(res, '/');
    // Only the app's own load of the page, the way its WebView opens it: `Sec-Fetch-Site: none`.
    // Never from another site, nor from a page of this one (a note shared with someone can hold
    // `[open](/devices/session?…)` or `![](/devices/session?…)`), nor as an image, a frame or a
    // fetch: any of them would sign the reader into the account of whoever made the code. Nothing
    // of this site links here. A WebView too old to send these headers sends none, and goes on.
    const site = req.headers['sec-fetch-site'];
    const dest = req.headers['sec-fetch-dest'];
    const mode = req.headers['sec-fetch-mode'];
    if (site !== undefined && site !== 'none') return refuse();
    if ((dest !== undefined && dest !== 'document') || (mode !== undefined && mode !== 'navigate')) return refuse();
    // A live session of someone else is replaced only by the app's own load as the browser vouches
    // for it (`none`), and only when a device opened it (its WebView kept the cookie of the account
    // it had, after signing out as best it could; the app would never get back in otherwise). An
    // ordinary session of the web never is, and with no headers at all (an old WebView, a page over
    // http://, where an image in a note sends none either) no session of someone else is: the app
    // clears its WebView's cookies and opens the address again, now with nothing in the way.
    const current = sessions.alive(sessions.tokenFrom(req));
    const replaceable = current != null && current.device_id != null && site === 'none';
    const holder = current && !replaceable ? sessions.userFrom(req)?.id ?? null : null;
    const codes = url.searchParams.getAll('code');
    const outcome = devices.takeWebCode(codes.length === 1 ? codes[0] : null, {
      refuse: (userId) => (holder != null && holder !== userId ? 'signed_in' : null),
    });
    if (outcome.refused) {
      // Only a good code gets here, and it stays good for its minute: written down a few times per
      // address in the window (their own bucket, not the token's), never as often as it is opened.
      if (limiter.checkFailures('devicesRefused', req).allowed) {
        limiter.noteFailure('devicesRefused', req);
        audit?.record({ action: 'device.web_session_failed', actor: outcome.userId, req, meta: { reason: outcome.refused } });
      }
      return refuse();
    }
    if (outcome.failed) return fail(outcome.failed, outcome.userId);
    sessions.open(outcome.user.id, { req, res, deviceId: outcome.deviceId });
    accounts.signedIn(outcome.user.id);
    audit?.record({ action: 'device.web_session', actor: outcome.user, req, targetType: 'device', targetId: outcome.deviceId });
    return send(res, localNext(url.searchParams));
  }

  return {
    connectPage: Boolean(options.connectPage),
    webSessions: Boolean(options.webSessions),
    /** `/devices/connect` and `/devices/session`, for a GET or HEAD; false for anything else. */
    handle(req, res, url) {
      if (!['GET', 'HEAD'].includes(req.method)) return false;
      if (cookie && url.pathname === CONNECT_PATH) return connect(req, res, url);
      if (options.webSessions && url.pathname === SESSION_PATH) return session(req, res, url);
      return false;
    },
    /**
     * `/` after the provider's sign-in, with a session and the cookie: back to the page with the
     * cookie's request, the cookie cleared. A bad cookie is cleared and `/` shows as it would.
     */
    back(req, res, url) {
      if (!cookie || url.pathname !== '/' || !['GET', 'HEAD'].includes(req.method) || !cookie.present(req)) return false;
      if (!sessions.userFrom(req)) return false;
      const request = cookie.read(req);
      cookie.clear(res);
      return request ? send(res, connectPath(request)) : false;
    },
  };
}
