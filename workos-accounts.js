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
import { ensureColumn } from './migrate.js';

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

/**
 * The `users` that `createWorkosAccounts` needs, made on the suite's accounts
 * and identities (accounts.js), so an app doesn't write its own. Links an
 * older version kept in `users.workos_user_id` are adopted the first time
 * they are asked for, and such accounts are never taken as unlinked.
 *
 * @param {object} accounts   from createAccounts()
 * @param {object} [options.database]   to read the old column, when there is one
 */
export function workosUsers(accounts, { database = null } = {}) {
  const PROVIDER = 'workos';
  const legacy = Boolean(database?.columnsOf('users').includes('workos_user_id'));
  const unlinked = (user) => (user && (!legacy || user.workos_user_id == null) ? user : null);

  function byWorkosId(id) {
    const user = accounts.byIdentity(PROVIDER, id);
    if (user || !legacy) return user;
    const old = database.get('SELECT id FROM users WHERE workos_user_id = ?', String(id));
    if (!old) return null;
    try {
      accounts.linkIdentity(old.id, PROVIDER, id);
    } catch {
      // Adopted by another request in the meantime.
    }
    return accounts.byIdentity(PROVIDER, id);
  }

  /** The WorkOS id of an account here, or null. */
  function workosIdOf(userId) {
    const identity = accounts.identitiesOf(userId).find((i) => i.provider === PROVIDER);
    if (identity) return identity.subject;
    return legacy ? database.get('SELECT workos_user_id FROM users WHERE id = ?', userId)?.workos_user_id ?? null : null;
  }

  return {
    byWorkosId,
    workosIdOf,
    unlinkedByEmail: (email) => unlinked(accounts.unlinkedByEmail(PROVIDER, email)),
    firstUnlinkedAdmin: () => unlinked(accounts.firstUnlinkedAdmin(PROVIDER)),
    linkedByEmail: (email) => accounts.linkedByEmail(PROVIDER, email),
    link: (userId, { workosId, email }) => accounts.linkIdentity(userId, PROVIDER, workosId, { email }),
    relink: (userId, { from, workosId, email }) => {
      accounts.relinkIdentity(userId, PROVIDER, from, workosId, { email });
      // The old column would bring the old id back the next time it is asked for.
      if (legacy) database.run('UPDATE users SET workos_user_id = NULL WHERE id = ? AND workos_user_id = ?', userId, String(from));
    },
    setEmail: (userId, email) => accounts.setVerifiedEmail(userId, email),
    usernameTaken: (name) => Boolean(accounts.byUsername(name)),
    create: ({ username, displayName, role, email, workosId }) =>
      accounts.create({ username, displayName, role, identity: { provider: PROVIDER, subject: workosId, email } }),
    signedIn: (user, account) => accounts.usedIdentity(PROVIDER, account.id),
  };
}

/**
 * The AI clients that reached this app's MCP with an AuthKit token, per
 * person: when each was last used, and when the person disconnected it here.
 * WorkOS knows who was authorized, not when they came, and an access token it
 * already issued keeps working after the authorization is withdrawn, until it
 * expires: what was issued before `revoked_at` is refused (migration 16).
 */
export function connectionsSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS idp_connections (
    provider     TEXT NOT NULL,
    subject      TEXT NOT NULL,
    client_id    TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT,
    PRIMARY KEY (provider, subject, client_id)
  )`);
}

/**
 * The consent behind each connection (the tokens' `sid`): it stays the same
 * when the client refreshes its token and changes when the person connects
 * again. Claude is one client for every app, and WorkOS withdraws a client
 * from all of them at once; disconnected here only, what comes with the
 * consent that was disconnected is refused (migration 17).
 */
export function connectionConsentsSchema(d) {
  ensureColumn(d, 'idp_connections', 'sid', 'sid TEXT');
  ensureColumn(d, 'idp_connections', 'revoked_sid', 'revoked_sid TEXT');
}

/**
 * The `connections` that `createWorkosAccounts` needs, on that table.
 * @param {object} database
 * @param {object} [options]
 * @param {Function} [options.clock]
 */
export function workosConnections(database, { provider = 'workos', clock = () => Date.now() } = {}) {
  const iso = (ms) => new Date(ms).toISOString();
  const rowOf = (subject, clientId) => database.get(
    'SELECT * FROM idp_connections WHERE provider = ? AND subject = ? AND client_id = ?',
    provider, String(subject), String(clientId));
  return {
    /**
     * Notes a use, at most once a minute per client (every MCP request brings
     * its token), and at once when it comes with another consent.
     */
    used(subject, clientId, sid = null) {
      const now = clock();
      database.run(`INSERT INTO idp_connections (provider, subject, client_id, last_used_at, sid) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (provider, subject, client_id) DO UPDATE SET last_used_at = excluded.last_used_at, sid = excluded.sid
        WHERE last_used_at IS NULL OR last_used_at < ? OR sid IS NOT excluded.sid`,
      provider, String(subject), String(clientId), iso(now), sid, iso(now - 60 * 1000));
    },
    /** A person's clients here: { client_id: { last_used_at, revoked_at } }. */
    of(subject) {
      const out = {};
      for (const row of database.all('SELECT client_id, last_used_at, revoked_at FROM idp_connections WHERE provider = ? AND subject = ?',
        provider, String(subject))) out[row.client_id] = { last_used_at: row.last_used_at, revoked_at: row.revoked_at };
      return out;
    },
    /** Disconnected here now: the tokens issued until now, and those of its consent, are refused. */
    revoke(subject, clientId) {
      database.run(`INSERT INTO idp_connections (provider, subject, client_id, revoked_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (provider, subject, client_id) DO UPDATE SET revoked_at = excluded.revoked_at, revoked_sid = sid`,
      provider, String(subject), String(clientId), iso(clock()));
    },
    /** Whether a token of that client is refused: issued before it was disconnected, or of the consent disconnected. */
    refuses(subject, clientId, { iat = 0, sid = null } = {}) {
      const row = rowOf(subject, clientId);
      if (!row?.revoked_at) return false;
      if ((Number(iat) || 0) * 1000 <= Date.parse(row.revoked_at)) return true;
      return Boolean(sid && row.revoked_sid && sid === row.revoked_sid);
    },
  };
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
 *   optionally linkedByEmail(email) → { user, subject } | null and
 *   relink(userId, { from, workosId, email }), to follow someone WorkOS knows by a new id;
 *   create({ username, displayName, role, email, workosId }) → user (throws on a duplicate
 *   workosId, which the unique index of the app's table should enforce);
 *   optionally signedIn(user, account) after a web sign-in, and workosIdOf(userId) → id | null,
 *   for the connected AI clients.
 *   `workosUsers(accounts)` makes all of them on the suite's accounts.
 * @param {object} options.sessions
 *   open(res, userId, { workosSessionId, req }) opens the app's browser session
 * @param {object} [options.connections]  used, of, revoke, refuses: the AI clients that
 *   come to the MCP (`workosConnections(database)`); without it, nothing is listed or refused
 * @param {boolean} [options.secureCookies]
 * @param {string} [options.stateCookie]   name of the cookie holding state and PKCE verifier
 */
export function createWorkosAccounts({
  baseUrl, appName, workos, adminEmail = '', users, sessions, connections = null,
  secureCookies = false, stateCookie = 'suite_auth', log = console.log,
}) {
  const BASE_URL = String(baseUrl).replace(/\/$/, '');
  const RESOURCE = `${BASE_URL}/mcp`;
  const forThisApp = (resource) => [RESOURCE, BASE_URL].includes(String(resource || '').replace(/\/+$/, ''));
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
   * Someone WorkOS now knows by a new id keeps their account (see relinked()).
   *
   * `adminEmail` decides who administers. In an install that already existed,
   * that person takes over the previous admin account, with all its data.
   * @throws {WorkosUnavailable} if WorkOS can't say whether an old id still exists.
   */
  async function localUser(account) {
    const verified = account.email_verified === true && !!account.email;
    const email = verified ? String(account.email).trim().toLowerCase() : null;

    const known = users.byWorkosId(account.id);
    if (known) {
      if (email && email !== known.email) users.setEmail(known.id, email);
      return users.byWorkosId(account.id);
    }

    if (email) {
      let previous = users.unlinkedByEmail(email);
      if (!previous) {
        const moved = await relinked(account, email);
        if (moved) return moved;
        previous = email === ADMIN_EMAIL ? users.firstUnlinkedAdmin() : null;
      }
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
   * The account of someone WorkOS now knows by a new id, moved over to it: an
   * account with their verified email is linked to an id this WorkOS doesn't
   * know. That happens when the install moves to another WorkOS environment
   * (each has its own ids) or their account there is deleted and made again;
   * before, every such person got a new, empty account, and the admin email
   * the account of another administrator. While the old id still exists it is
   * someone else, who had the email first: null, and the newcomer gets an
   * account of their own.
   */
  async function relinked(account, email) {
    const linked = users.linkedByEmail?.(email);
    if (!linked || linked.subject === account.id) return null;
    if (await workos.knows(linked.subject)) return null;
    try {
      users.relink(linked.user.id, { from: linked.subject, workosId: account.id, email });
      log(`[workos] user #${linked.user.id} linked to their new WorkOS account`);
    } catch (err) {
      // The web and the MCP may move the same person at once.
      if (!users.byWorkosId(account.id)) throw err;
    }
    return users.byWorkosId(account.id);
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
    // Disconnected in the app: what AuthKit issued before that, or since with the same consent, is no one.
    if (connections && data.client_id && connections.refuses(data.sub, data.client_id, data)) return null;
    let user = users.byWorkosId(data.sub);
    if (!user) {
      const account = await workos.account(data.sub);
      user = account ? await localUser(account) : null;
    }
    // An account the admin disabled is no one, whatever AuthKit says.
    if (!user || user.disabled_at) return null;
    if (connections && data.client_id) connections.used(data.sub, data.client_id, data.sid || null);
    return user;
  }

  /**
   * The AI clients a person has authorized for this app, so they can be seen
   * and disconnected here without going to WorkOS: those whose authorization
   * names this app's /mcp. Claude is one client for every app, with an
   * authorization per app; one without a resource is taken as this app's if
   * that client has come here. One disconnected here is no longer listed,
   * until a token of a new consent comes.
   * `[{ id, application_id, client_id, client_name, last_used_at }]`, and
   * every authorization of the person in `all`.
   * @throws {WorkosUnavailable}
   */
  async function authorizationsOf(subject) {
    const here = connections?.of(subject) || {};
    const all = await workos.authorizedApplications(subject);
    const mine = all
      .filter((a) => forThisApp(a.resource) || (!a.resource && a.client_id && a.client_id in here))
      .filter((a) => {
        const row = here[a.client_id];
        return !row?.revoked_at || (row.last_used_at && row.last_used_at > row.revoked_at);
      })
      .map((a) => ({
        id: a.id, application_id: a.application_id, client_id: a.client_id,
        client_name: a.name || a.client_id || appName, last_used_at: here[a.client_id]?.last_used_at || null,
      }));
    return { mine, all };
  }

  async function connectionsOf(userId) {
    const subject = users.workosIdOf?.(userId);
    return subject ? (await authorizationsOf(subject)).mine : [];
  }

  /**
   * Disconnects one of those clients: here, its tokens are refused from now
   * on, even refreshed; at WorkOS, its authorization is withdrawn unless the
   * client is still authorized for another app, since WorkOS withdraws a
   * client from every app at once. False if the person has no such
   * connection with this app.
   * @returns {Promise<false|{ client_id, client_name, everywhere }>}
   * @throws {WorkosUnavailable}
   */
  async function revokeConnection(userId, id) {
    const subject = users.workosIdOf?.(userId);
    if (!subject) return false;
    const { mine, all } = await authorizationsOf(subject);
    const connection = mine.find((c) => c.id === id);
    if (!connection) return false;
    const sameClient = (a) => (connection.application_id ? a.application_id === connection.application_id : a.client_id === connection.client_id);
    const elsewhere = all.some((a) => a.id !== connection.id && sameClient(a) && !forThisApp(a.resource));
    if (connection.client_id) connections?.revoke(subject, connection.client_id);
    if (!elsewhere) await workos.revokeApplication(subject, connection.application_id || connection.client_id);
    log(`[workos] user #${userId} disconnected ${connection.client_name}${elsewhere ? ' here (still authorized for other apps)' : ''}`);
    return { client_id: connection.client_id, client_name: connection.client_name, everywhere: !elsewhere };
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
        const user = await localUser(account);
        // An account the admin disabled stays out, whatever AuthKit says.
        if (user.disabled_at) {
          log(`[workos] user #${user.id} is disabled: not signed in`);
          redirect(res, '/?auth_error=disabled');
          return true;
        }
        users.signedIn?.(user, account);
        sessions.open(res, user.id, { workosSessionId: sessionId, req });
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

  return {
    id: 'workos', name: 'WorkOS', handle, userFromToken, challenge, localUser,
    ...(users.workosIdOf ? { connectionsOf, revokeConnection } : {}),
    signOutUrl: workos.signOutUrl, revokeSession: workos.revokeSession,
  };
}
