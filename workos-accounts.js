/**
 * Signing in with WorkOS: the routes the browser and AI clients use, and how a
 * WorkOS account becomes a user of the app.
 *
 * Part of the shared suite code: it imports nothing from any app. `workos.js`
 * talks to WorkOS; this decides who is who, through the users and sessions
 * the app passes in. Everything else in the app —permissions, its data,
 * manual MCP tokens— stays exactly the same.
 */
import crypto from 'node:crypto';
import { WorkosUnavailable } from './workos.js';

const METADATA_PATH = '/.well-known/oauth-protected-resource';
const AS_METADATA_PATH = '/.well-known/oauth-authorization-server';
/** The metadata is read from browsers too (the MCP inspector, for instance). */
const CORS = { 'Access-Control-Allow-Origin': '*' };

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function redirect(res, target) {
  res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
  res.end();
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function addCookie(res, cookie) {
  const previous = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', previous == null ? cookie : [].concat(previous, cookie));
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** A free username from an email: ana.perez, ana.perez2… */
function freeUsername(seed, taken) {
  let base = String(seed).split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30);
  if (base.length < 2) base = 'user';
  let name = base;
  for (let n = 2; taken(name); n++) name = `${base}${n}`;
  return name;
}

/**
 * @param {object} options
 * @param {string} options.baseUrl     public URL of the app; BASE_URL/mcp is the MCP resource
 * @param {string} options.appName
 * @param {object} options.workos      a client from createWorkosClient
 * @param {string} [options.adminEmail] whoever signs in with this verified email administers
 * @param {object} options.users
 *   byWorkosId(id), unlinkedByEmail(email), firstUnlinkedAdmin() → user | null;
 *   link(userId, { workosId, email }); setEmail(userId, email); usernameTaken(name) → bool;
 *   create({ username, displayName, role, email, workosId }) → user (throws on a duplicate
 *   workosId, which the unique index of the app's table should enforce)
 * @param {object} options.sessions
 *   open(res, userId, { workosSessionId }) opens the app's browser session
 * @param {boolean} [options.secureCookies]
 * @param {string} [options.stateCookie]   name of the cookie holding state and PKCE verifier
 */
export function createWorkosAccounts({
  baseUrl, appName, workos, adminEmail = '', users, sessions,
  secureCookies = false, stateCookie = 'suite_auth', log = console.log,
}) {
  const BASE_URL = String(baseUrl).replace(/\/$/, '');
  const RESOURCE = `${BASE_URL}/mcp`;
  const ADMIN_EMAIL = String(adminEmail || '').trim().toLowerCase();

  const stateCookieHeader = (value, maxAge) => [
    `${stateCookie}=${encodeURIComponent(value)}`, `Max-Age=${maxAge}`, 'Path=/auth',
    'HttpOnly', 'SameSite=Lax', ...(secureCookies ? ['Secure'] : []),
  ].join('; ');

  /**
   * The app user matching a WorkOS account; created if there is none.
   *
   * An account that existed before moving to WorkOS is linked by its email,
   * but only if WorkOS says that email is verified: otherwise signing up there
   * with someone else's address would be enough to take their data. For the
   * same reason only a verified email is stored.
   *
   * `adminEmail` decides who administers. In an install that already existed,
   * that person takes over the previous admin account, with all its data.
   */
  function localUser(account) {
    const verified = account.email_verified === true && !!account.email;
    const email = verified ? String(account.email).trim().toLowerCase() : null;

    const known = users.byWorkosId(account.id);
    if (known) {
      if (email && email !== known.email) users.setEmail(known.id, email);
      return users.byWorkosId(account.id);
    }

    if (email) {
      const previous = users.unlinkedByEmail(email)
        || (email === ADMIN_EMAIL ? users.firstUnlinkedAdmin() : null);
      if (previous) {
        users.link(previous.id, { workosId: account.id, email });
        log(`[workos] user #${previous.id} linked to their WorkOS account`);
        return users.byWorkosId(account.id);
      }
    }

    const displayName = [account.first_name, account.last_name].filter(Boolean).join(' ').trim()
      || account.name || (account.email ? String(account.email).split('@')[0] : 'User');
    try {
      const created = users.create({
        username: freeUsername(account.email || 'user', users.usernameTaken),
        displayName: displayName.slice(0, 60),
        role: email && email === ADMIN_EMAIL ? 'admin' : 'user',
        email,
        workosId: account.id,
      });
      log(`[workos] new account: user #${created.id}`);
      return created;
    } catch (err) {
      // The web and the MCP may open the same account at once: the unique
      // index lets one through and the other finds the row already there.
      const other = users.byWorkosId(account.id);
      if (other) return other;
      throw err;
    }
  }

  /**
   * The user of an MCP OAuth token, or null if the token isn't valid. The
   * first time someone connects a client without ever opening the web app,
   * their account is created here, with what WorkOS says about them.
   * @throws {WorkosUnavailable} if the token can't be checked right now.
   */
  async function userFromToken(token) {
    const data = await workos.verifyToken(token);
    if (!data) return null;
    const known = users.byWorkosId(data.sub);
    if (known) return known;
    const account = await workos.account(data.sub);
    return account ? localUser(account) : null;
  }

  /** The MCP's 401 header: where the metadata is, so the client opens AuthKit. */
  const challenge = (hadToken) =>
    `Bearer resource_metadata="${BASE_URL}${METADATA_PATH}/mcp"${hadToken ? ', error="invalid_token"' : ''}`;

  /** Handles the sign-in routes and the metadata. Returns false for other paths. */
  async function handle(req, res, url) {
    const path = url.pathname;

    if (path === '/auth/login') {
      const { verifier, challenge: pkceChallenge } = workos.pkcePair();
      const state = crypto.randomBytes(16).toString('base64url');
      addCookie(res, stateCookieHeader(`${state}.${verifier}`, 600));
      redirect(res, workos.signInUrl({
        redirectUri: `${BASE_URL}/auth/callback`,
        state,
        challenge: pkceChallenge,
        signUp: url.searchParams.get('signup') === '1',
      }));
      return true;
    }

    if (path === '/auth/callback') {
      const [state, verifier] = String(cookieValue(req, stateCookie) || '').split('.');
      addCookie(res, stateCookieHeader('', 0));
      const code = url.searchParams.get('code');
      // Without a state matching the cookie's, this return wasn't started by
      // this browser: it could be someone slipping their own account into the
      // session.
      if (url.searchParams.get('error') || !code || !state || !verifier
        || !safeEqual(state, url.searchParams.get('state') || '')) {
        redirect(res, '/?auth_error=failed');
        return true;
      }
      try {
        const { account, sessionId } = await workos.exchangeCode({ code, verifier });
        const user = localUser(account);
        sessions.open(res, user.id, { workosSessionId: sessionId });
        redirect(res, '/');
      } catch (err) {
        log(`[workos] sign-in could not be completed: ${err.message}`);
        redirect(res, `/?auth_error=${err instanceof WorkosUnavailable ? 'unavailable' : 'failed'}`);
      }
      return true;
    }

    if (path === METADATA_PATH || path === `${METADATA_PATH}/mcp`) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...CORS, 'Access-Control-Allow-Headers': '*', 'Access-Control-Max-Age': '86400' });
        res.end();
        return true;
      }
      sendJson(res, 200, workos.resourceMetadata({ resource: RESOURCE, name: appName }), CORS);
      return true;
    }

    if (path === AS_METADATA_PATH || path.startsWith(`${AS_METADATA_PATH}/`)) {
      try {
        sendJson(res, 200, await workos.authorizationServerMetadata(), CORS);
      } catch (err) {
        log(`[workos] ${err.message}`);
        sendJson(res, 502, { error: 'server_error', error_description: 'AuthKit does not answer' }, CORS);
      }
      return true;
    }

    return false;
  }

  return { handle, userFromToken, challenge, localUser, signOutUrl: workos.signOutUrl };
}
