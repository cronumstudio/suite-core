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
import { HttpError, sendJson, localPath, signInFlowCookies, signedOutHere } from './http.js';
import { safeEqual } from './crypto.js';
import { answersWithAddress } from './terms.js';

const METADATA_PATH = '/.well-known/oauth-protected-resource';
const AS_METADATA_PATH = '/.well-known/oauth-authorization-server';
/** The metadata is read from browsers too (the MCP inspector, for instance). */
const CORS = { 'Access-Control-Allow-Origin': '*' };

function redirect(res, target) {
  res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
  res.end();
}

/** `/auth/login?provider=`: the accounts elsewhere a sign-in may go straight to, as WorkOS names them. */
const STRAIGHT_TO = Object.freeze({ __proto__: null, google: 'GoogleOAuth' });
/** `/auth/login?hint=`: an email to start AuthKit's page with, or null when it isn't one. */
const hintOf = (value) => {
  const email = String(value ?? '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null;
};

/**
 * The `users` that `createWorkosAccounts` needs, made on the suite's accounts
 * and identities (accounts.js), so an app doesn't write its own. Links an
 * older version kept in `users.workos_user_id` are adopted the first time
 * they are asked for, and such accounts are never taken as unlinked.
 *
 * @param {object} accounts   from createAccounts()
 * @param {object} [options.database]   to read the old column, when there is one
 */
/**
 * How WorkOS says someone signed in (`authentication_method`), as the suite
 * names it: password, passkey, email_code, sso, google, apple, microsoft,
 * github. An administrator acting as them (Impersonation) is not how they sign
 * in: null, and what was noted before stays.
 */
export function signInMethod(value) {
  const known = {
    Password: 'password', Passkey: 'passkey', MagicAuth: 'email_code', SSO: 'sso',
    GoogleOAuth: 'google', AppleOAuth: 'apple', MicrosoftOAuth: 'microsoft', GitHubOAuth: 'github',
  };
  if (!value || value === 'Impersonation') return null;
  return known[value] || String(value).replace(/OAuth$/, '').toLowerCase().slice(0, 40) || null;
}

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
    signedIn: (user, account, method = null) => accounts.usedIdentity(PROVIDER, account.id, { method: signInMethod(method) }),
    // Whether WorkOS was told this app is the person's (createWorkosAccounts' `mark`).
    markedAt: (workosId) => accounts.markedIdentity(PROVIDER, workosId),
    marked: (workosId, at) => accounts.markedIdentity(PROVIDER, workosId, at),
    unmarked: (limit) => accounts.unmarkedIdentities(PROVIDER, limit),
    /** How they last signed in through WorkOS (signInMethod), or null when it isn't known yet. */
    methodOf: (userId) => accounts.identitiesOf(userId).find((i) => i.provider === PROVIDER)?.method ?? null,
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
    /** Disconnected here now (or as of `at`): the tokens issued until then, and those of its consent, are refused. */
    revoke(subject, clientId, at = null) {
      database.run(`INSERT INTO idp_connections (provider, subject, client_id, revoked_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (provider, subject, client_id) DO UPDATE SET revoked_at = excluded.revoked_at, revoked_sid = sid`,
      provider, String(subject), String(clientId), at || iso(clock()));
    },
    /**
     * The account of `subject` went (audit portable-20): what was kept of its AI clients goes with it
     * (when each was last used, its session). A client disconnected here stays refused —only its
     * revocation is kept—, or its old tokens would work again on an account made later with that login.
     */
    forget(subject) {
      database.run('DELETE FROM idp_connections WHERE provider = ? AND subject = ? AND revoked_at IS NULL', provider, String(subject));
      database.run('UPDATE idp_connections SET last_used_at = NULL, sid = NULL WHERE provider = ? AND subject = ?', provider, String(subject));
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
 *   open(res, userId, { workosSessionId, req, authTime }) opens the app's browser session;
 *   `authTime` (ms, or null) is when the person last actively signed in, as AuthKit says
 * @param {object} [options.connections]  used, of, revoke, refuses: the AI clients that
 *   come to the MCP (`workosConnections(database)`); without it, nothing is listed or refused
 * @param {boolean} [options.secureCookies]
 * @param {string} [options.stateCookie]   name of the cookie holding state and PKCE verifier
 * @param {(user) => string} [options.pendingDeletion]   the ticket that offers back an account
 *   its owner asked to delete (account-deletion.js); without it, it is just disabled
 * @param {(req, res) => string|null} [options.afterSignIn]   where a sign-in that would land on
 *   `/` goes instead, once the session is open: a phone's connect page (device-pages.js
 *   connectAfterSignIn), or null for `/`
 * @param {object} [options.mark]   where the WorkOS users are shared with other apps
 *   (`accounts.sharedIdentity`): `{ key, name }`, this app's key in a user's metadata (`app_<id>`)
 *   and its name there. Signing in here sets it, once (`users.marked`), and `markAll` sets it for
 *   whoever signed in before; `otherApps(userId)` reads the names the others set, and
 *   `unmark(userId)` takes this app's off when the account here goes but the user there stays.
 * @param {object} [options.origins]   where accounts come from (origins.js): what `/auth/login` says
 *   of it (`src`, `via`) is held on the server under the sign-in's state (`hold`), never in its
 *   cookie, and handed back at the callback (`take`), for the account made there
 * @param {object} [options.terms]   the install's terms (terms.js): the box ticked in the kit's form,
 *   posted to `/auth/login`, is held under the sign-in's state and recorded at the callback, and an
 *   account that has yet to accept them goes to their page before anything else
 * @param {boolean} [options.mcp]   false when the app has no MCP: the OAuth metadata for AI
 *   clients isn't served, so its paths answer the app's JSON 404 and no client is sent to AuthKit
 *   for a connector that isn't there. Sign-in on the web is the same either way.
 */
export function createWorkosAccounts({
  baseUrl, appName, workos, adminEmail = '', users, sessions, connections = null,
  secureCookies = false, stateCookie = 'suite_auth', pendingDeletion = null, mcp = true, mark = null, afterSignIn = null,
  origins = null, terms = null, log = console.log,
}) {
  const BASE_URL = String(baseUrl).replace(/\/$/, '');
  const RESOURCE = `${BASE_URL}/mcp`;
  const forThisApp = (resource) => [RESOURCE, BASE_URL].includes(String(resource || '').replace(/\/+$/, ''));
  const ADMIN_EMAIL = String(adminEmail || '').trim().toLowerCase();

  // One cookie per sign-in, for 30 minutes (http.js signInFlowCookies, audit sc-auth-6). Read with
  // the suite's parseCookies: a malformed cookie is skipped, where a copy without its try threw
  // before the callback's and answered 500 to anyone (audit sc-auth-10).
  const flows = signInFlowCookies({ cookie: stateCookie, secure: secureCookies });

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
    markOnce(data.sub);
    return user;
  }

  /* ----------------- the apps that share the WorkOS users ----------------- */

  const marking = new Set();

  /** Tells WorkOS this app is the person's. → false if the user is gone there. */
  async function markUser(workosId) {
    const done = await workos.setMetadata(workosId, { [mark.key]: mark.name });
    if (done) users.marked(workosId, new Date().toISOString());
    return done;
  }

  /** The first time someone comes here (or since it was taken off), told in the background: never a reason to fail. */
  function markOnce(workosId) {
    if (!mark || !users.marked || marking.has(workosId) || users.markedAt(workosId)) return;
    marking.add(workosId);
    markUser(workosId)
      .catch((err) => log(`[workos] this app could not be noted on a user: ${err.message}`))
      .finally(() => marking.delete(workosId));
  }

  /**
   * Whoever has an account here and WorkOS wasn't told of yet (signed in before this app noted
   * it), a hundred at a time until none is left. WorkOS not answering stops it until the next time.
   * → how many were noted.
   */
  async function markAll() {
    if (!mark || !users.unmarked) return 0;
    let done = 0;
    for (;;) {
      const batch = users.unmarked(100).filter((id) => !marking.has(id));
      if (!batch.length) return done;
      for (const workosId of batch) {
        // Gone at WorkOS: noted all the same, nothing more to tell it.
        if (!(await markUser(workosId))) users.marked(workosId, new Date().toISOString());
        done += 1;
      }
    }
  }

  /**
   * The other apps that share this person's WorkOS user, by the names they noted on it
   * (`['Acme']`), or [] with none, or no WorkOS user.
   * @throws {WorkosUnavailable}
   */
  async function otherApps(userId) {
    const workosId = users.workosIdOf?.(userId);
    if (!workosId) return [];
    const account = await workos.account(workosId);
    return Object.entries(account?.metadata || {})
      .filter(([key, value]) => key.startsWith('app_') && key !== mark.key && value)
      .map(([, value]) => String(value));
  }

  /** The account here goes and their WorkOS user stays: this app is no longer theirs there. Never a reason to fail. */
  async function unmark(userId) {
    const workosId = users.workosIdOf?.(userId);
    if (!workosId) return;
    try {
      await workos.setMetadata(workosId, { [mark.key]: null });
    } catch (err) {
      log(`[workos] this app could not be taken off user #${userId} at WorkOS: ${err.message}`);
    }
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

  /**
   * Every AI client the person authorized for this app, withdrawn at WorkOS
   * (revoke.js, after a new password): the ones already refused here too,
   * since refusing their tokens here doesn't stop AuthKit from refreshing
   * them. Like revokeConnection, a client still authorized for another app
   * stays authorized there. → how many were withdrawn.
   * @throws {WorkosUnavailable}
   */
  async function revokeAllConnections(userId) {
    const subject = users.workosIdOf?.(userId);
    if (!subject) return 0;
    const here = connections?.of(subject) || {};
    const all = await workos.authorizedApplications(subject);
    const ours = all.filter((a) => forThisApp(a.resource) || (!a.resource && a.client_id && a.client_id in here));
    let n = 0;
    for (const a of ours) {
      if (a.client_id) connections?.revoke(subject, a.client_id);
      const sameClient = (b) => (a.application_id ? b.application_id === a.application_id : b.client_id === a.client_id);
      if (all.some((b) => b.id !== a.id && sameClient(b) && !forThisApp(b.resource))) continue;
      await workos.revokeApplication(subject, a.application_id || a.client_id);
      n += 1;
    }
    return n;
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
      // Back where sign-in began (`return`): a module installed on its own (`/notes/`) back in
      // its own app, not at `/`, which in Cronum Work is the whole of it.
      const back = Buffer.from(localPath(url.searchParams.get('return'))).toString('base64url');
      // Where they come from (a link's tag, the site before), for an account made on the way back:
      // held on the server under the state (origins.js), never in a cookie. The sign-in's cookie
      // keeps only what the sign-in needs, so it stays a strictly necessary one.
      origins?.hold(state, origins.pack(origins.fromLogin(req, url)));
      // The box of the terms ticked in the kit's form beside «Create an account» (posted from this
      // site's page, never a link): held on the server under the state too, and recorded on return.
      if (terms && await terms.tickedAt(req)) terms.hold(state);
      flows.start(res, state, `${state}.${verifier}.${back}`);
      const target = workos.signInUrl({
        redirectUri: `${BASE_URL}/auth/callback`,
        state,
        challenge: pkceChallenge,
        signUp: url.searchParams.get('signup') === '1',
        // The device connect page asks for it (device-pages.js), to sign in as someone else, and the
        // admin panel, for an admin who must sign in again (workos-security.js confirmAdmin). And
        // after someone signed out in this browser (http.js SIGNED_OUT_COOKIE): AuthKit asks who it
        // is, rather than letting in whoever it still remembers.
        fresh: url.searchParams.get('prompt') === 'login' || signedOutHere(req),
        // Straight to Google rather than AuthKit's page (a creator's invitation's «or with Google»).
        ...(STRAIGHT_TO[url.searchParams.get('provider')] ? { provider: STRAIGHT_TO[url.searchParams.get('provider')] } : {}),
        // AuthKit's page with their email already written (an invitation to an email that has a login).
        ...(hintOf(url.searchParams.get('hint')) ? { loginHint: hintOf(url.searchParams.get('hint')) } : {}),
      });
      // The kit's sign-up posts its box of the terms and opens the address itself (terms.js).
      if (answersWithAddress(req)) sendJson(res, 200, { location: target });
      else redirect(res, target);
      return true;
    }

    if (path === '/auth/callback') {
      const [state, verifier, back] = String(flows.take(req, res, url.searchParams.get('state')) || '').split('.');
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
        const { account, sessionId, method, authTime } = await workos.exchangeCode({ code, verifier });
        origins?.arriving(req, origins.take(state));
        const ticked = terms?.take(state) ?? false;
        const user = await localUser(account);
        // Its owner asked to delete it: no session, the offer to take it back.
        if (user.disabled_at && user.delete_after && pendingDeletion) {
          redirect(res, `/?account_deletion=${encodeURIComponent(pendingDeletion(user))}&until=${encodeURIComponent(user.delete_after)}`);
          return true;
        }
        // An account the admin disabled stays out, whatever AuthKit says.
        if (user.disabled_at) {
          log(`[workos] user #${user.id} is disabled: not signed in`);
          redirect(res, '/?auth_error=disabled');
          return true;
        }
        users.signedIn?.(user, account, method);
        markOnce(account.id);
        // With when they last actively signed in: an admin's sign-in again is one (workos-security.js).
        sessions.open(res, user.id, { workosSessionId: sessionId, req, authTime });
        const target = localPath(Buffer.from(back || '', 'base64url').toString('utf8') || '/');
        // A phone's connect page that sent here: straight back to it, not by `/` (device-pages.js).
        const next = (target === '/' && afterSignIn?.(req, res)) || target;
        // The terms first, for an account that has yet to accept them (terms.js), then on to the same place.
        redirect(res, terms ? terms.afterSignIn(user.id, { ticked, req, next }) : next);
      } catch (err) {
        log(`[workos] sign-in could not be completed: ${err.message}`);
        redirect(res, `/?auth_error=${err instanceof WorkosUnavailable ? 'unavailable' : 'failed'}`);
      }
      return true;
    }

    // Without an MCP there is no resource to describe: these are the AI clients' paths, not the web's.
    if (!mcp) return false;

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

  /**
   * A sign-in with a password typed on a page of this app, not AuthKit's: a creator's invitation,
   * which has just made their login (creator-invitations.js). The password grant at WorkOS, then the
   * same as a return from AuthKit: the account here (made now if it isn't yet, with the request's
   * hooks: its origin, a code's link), how they signed in, this app's mark, and the session.
   * → `{ user }` signed in; `{ user: null, step }` when WorkOS wants one more step first (a second
   * factor), which only AuthKit's page takes, so no session is opened (with `pendingToken` when the
   * step is the email's code, which signInWithEmailCode takes); 401 `bad_credentials` for a
   * password that isn't theirs, 403 `account_disabled` for an account that is.
   * @throws {WorkosUnavailable}
   */
  async function signInWithPassword(req, res, { email, password, ip = null }) {
    const answer = await workos.authenticateWithPassword({
      email, password, ip, userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 400) || null,
    });
    if (answer.step) return { user: null, step: answer.step, pendingToken: answer.pendingToken ?? null };
    if (!answer.account) throw new HttpError(401, 'bad_credentials');
    return openFrom(req, res, answer);
  }

  /**
   * The code WorkOS mailed to confirm the email, after signInWithPassword's `email_verification_required`:
   * the email confirmed (and so kept on the account here), and the session, as signInWithPassword
   * opens it. → `{ user }`; `{ user: null, refused }` for a wrong or old code; `{ user: null, step }`
   * when WorkOS wants yet another step (AuthKit's page then).
   * @throws {WorkosUnavailable}
   */
  async function signInWithEmailCode(req, res, { code, pendingToken, ip = null }) {
    const answer = await workos.authenticateWithEmailCode({
      code, pendingToken, ip, userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 400) || null,
    });
    if (answer.step) return { user: null, step: answer.step };
    if (!answer.account) return { user: null, refused: answer.refused || 'refused' };
    return openFrom(req, res, answer);
  }

  async function openFrom(req, res, answer) {
    const { account, sessionId, method, authTime } = answer;
    const user = await localUser(account);
    if (user.disabled_at) throw new HttpError(403, 'account_disabled');
    users.signedIn?.(user, account, method);
    markOnce(account.id);
    sessions.open(res, user.id, { workosSessionId: sessionId, req, authTime });
    return { user };
  }

  /**
   * The person goes at WorkOS too, when the account here is deleted and the
   * login goes with it (config.accounts.sharedIdentity, account-deletion.js).
   */
  async function deleteIdentity(userId) {
    const id = users.workosIdOf?.(userId);
    if (id) await workos.deleteUser(id);
  }

  return {
    id: 'workos', name: 'WorkOS', handle, userFromToken, challenge, localUser, signInWithPassword, signInWithEmailCode,
    ...(users.workosIdOf ? { connectionsOf, revokeConnection, revokeAllConnections, deleteIdentity } : {}),
    ...(mark && users.workosIdOf ? { markAll, otherApps, unmark } : {}),
    signOutUrl: workos.signOutUrl, revokeSession: workos.revokeSession,
  };
}
