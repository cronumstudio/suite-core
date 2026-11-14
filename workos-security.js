/**
 * Password and two-step verification for accounts that sign in with WorkOS,
 * from the app's Settings instead of AuthKit's page.
 *
 * · How someone signs in decides what Settings offers. With Google, Apple,
 *   Microsoft or GitHub there is no password here to change, nor a second step
 *   to add: both are that account's, and Settings says so and where. With a
 *   password (or a passkey), the password can be changed here and an
 *   authenticator app added. The method is the one noted at their last
 *   sign-in (workos-accounts.js); for someone who hasn't signed in since it is
 *   noted, the accounts WorkOS links to them say it.
 * · The second step is WorkOS's own: an authenticator app (a TOTP factor) on
 *   their WorkOS user, which AuthKit asks for after the password, on the web
 *   and when an AI client is connected. It is optional, each person's choice.
 *   The secret is made and its first code checked here, and only then given to
 *   WorkOS, so that no factor is left there half set up (which AuthKit would
 *   ask for with nothing on the phone to answer it).
 * · WorkOS has no recovery codes. Whoever loses the phone is helped by an
 *   administrator, who takes the second step off (the admin panel, or WorkOS's
 *   dashboard); a forgotten password is AuthKit's "Forgot your password?".
 * · AuthKit asks for the code only when the WorkOS environment's Multi-Factor
 *   Auth is **Optional** (or Required) in its dashboard: with it Off, a factor
 *   is kept and never asked for.
 * · `twoFactor`: who is offered the second step: `on` (everyone, the default),
 *   `admins` (to try it out) or `off`. Changing the password is always offered.
 */
import crypto from 'node:crypto';
import { base32Encode, base32Decode, matchStep, totp } from './two-factor.js';
import { HttpError, sendJson, readJson, badRequest, notFound, forbidden, unauthorized, conflict, int, clientIp } from './http.js';
import { answeredOnce } from './idempotency.js';
import { WorkosUnavailable } from './workos.js';

const SETUP_MS = 10 * 60 * 1000;
/** How recent an admin's sign-in must be to change someone's identity without a password to give. */
const REAUTH_MS = 10 * 60 * 1000;
/** WorkOS's clock and this one's, which don't tick exactly together (as workos.js's tokens). */
const SKEW_MS = 30 * 1000;
/** How long the admin's password given again stands in their session, for what asks only that it was given lately. */
const CONFIRMED_MS = 10 * 60 * 1000;
const STEP_SECONDS = 30;

/** Methods that are another account's sign-in: its password and second step are there. */
export const ELSEWHERE = Object.freeze(['google', 'apple', 'microsoft', 'github', 'sso', 'email_code']);

/** WorkOS's names of the accounts it links (identities), as signInMethod() names them. */
const fromIdentity = (provider) => String(provider || '').replace(/OAuth$/, '').toLowerCase() || null;

/**
 * What an admin with no password to give (Google, Apple, a company's sign-in) shows instead: a sign-in
 * at WorkOS in which they actively signed in, after the server asked for it. AuthKit's access token
 * says when (`auth_time`: "a Unix timestamp, in seconds, of the user's most recent active
 * authentication", which a session AuthKit reuses or a refresh doesn't move: WorkOS, AuthKit ›
 * Re-authentication), and the panel asks for it with `max_age=0` (`/auth/login?prompt=login`). A
 * session opened in the last minutes proved nothing: AuthKit signs the browser in again without a
 * word while its own session lasts. createSuite notes each session a sign-in at WorkOS opens
 * (`note`); `ask` is the server asking an admin, and `fresh` whether a session's sign-in came after
 * the last question, within REAUTH_MS of it, and is no older than that now. In memory, kept those
 * minutes only: a restart asks again. Sessions by a hash of their token, never the token.
 */
export function createFreshSignIns({ clock = () => Date.now() } = {}) {
  const signedIn = new Map();
  const asked = new Map();
  const keyOf = (token) => crypto.createHash('sha256').update(String(token)).digest('base64url');
  // Past these, neither can make a session fresh again.
  const prune = () => {
    const now = clock();
    for (const [key, at] of signedIn) if (now - at > REAUTH_MS) signedIn.delete(key);
    for (const [id, at] of asked) if (now - at > 2 * REAUTH_MS) asked.delete(id);
  };
  return {
    /** A session a sign-in at WorkOS just opened (its token), and when they last actively signed in (ms). */
    note(token, authTime) {
      if (!token || !Number.isFinite(authTime)) return;
      prune();
      signedIn.set(keyOf(token), authTime);
    },
    /** The server asks an admin to sign in again: only a sign-in after now counts. */
    ask(userId) {
      prune();
      asked.set(Number(userId), clock());
    },
    /** Whether this session's sign-in was active after the admin was last asked, in the minutes after, and still recent. */
    fresh(userId, token) {
      const at = token ? signedIn.get(keyOf(token)) : undefined;
      const since = asked.get(Number(userId));
      if (at == null || since == null) return false;
      return at + SKEW_MS >= since && at - since <= REAUTH_MS && clock() - at <= REAUTH_MS;
    },
  };
}

/**
 * @param {object} router
 * @param {object} deps
 * @param {object} deps.workos     from createWorkosClient()
 * @param {object} deps.users      from workosUsers(): workosIdOf, methodOf
 * @param {object} deps.accounts   from createAccounts()
 * @param {object} deps.sessions   from createSessions()
 * @param {string} deps.appName    how the authenticator app names the account
 * @param {'on'|'admins'|'off'} [deps.twoFactor]
 * @param {boolean} [deps.adminIdentity]  whether the admin may set someone's password and take
 *   their second step off at WorkOS (config.accounts.adminIdentity): only the install that owns the
 *   identities, since a WorkOS user is the same in every product. Off, those two routes don't exist,
 *   and neither do the logins the admin makes for new accounts (`logins`, returned).
 * @param {object} [deps.mark]  `{ key, name }` (app.js identityMark), where the logins are shared
 *   with other apps: what a login the admin makes carries in its metadata.
 * @param {object} [deps.freshSignIns]  from createFreshSignIns(), which createSuite fills from each
 *   sign-in at WorkOS: an admin with no password to give is confirmed by a fresh one. Without it,
 *   nothing counts as one and such an admin is always asked to sign in again.
 * @param {number} [deps.minPasswordLength]  the shortest password taken here before WorkOS is
 *   asked (config.accounts.minPasswordLength, which createApp passes): the one Settings says, and
 *   the one WorkOS's own policy should have. 8 when nobody says, as before.
 * @param {*} [deps.trustProxy]  see proxyHops() in http.js: the address WorkOS is told a password
 *   check comes from (its sign-in log and its brakes).
 */
export function registerWorkosSecurityApi(router, {
  workos, users, accounts, sessions, limiter = null, audit = null, appName = 'App', twoFactor = 'on',
  revokeAtProvider = () => {}, revokeEverything = null, adminIdentity = false, mark = null, freshSignIns = null,
  minPasswordLength = 8, trustProxy = process.env.TRUST_PROXY, clock = () => Date.now(),
}) {
  // `n`: the shortest it takes, which the sentence says (errors.password_rejected), WorkOS's reason
  // too when it refuses one (`detail`): the person is told what to change (audit sc-auth-7).
  const rejected = (detail) => badRequest('password_rejected', { n: minPasswordLength, ...(detail ? { detail } : {}) });
  const record = (ctx, action, targetType, targetId, meta) =>
    audit?.record({ action, actor: ctx.user, req: ctx.req, targetType, targetId, meta });
  const requireUser = (ctx) => {
    if (!ctx.user) throw unauthorized();
    return ctx.user;
  };
  const requireAdmin = (ctx) => {
    const user = requireUser(ctx);
    if (user.role !== 'admin') throw forbidden('admin_only');
    return user;
  };
  const workosId = (user) => {
    const id = users.workosIdOf(user.id);
    if (!id) throw conflict('no_workos_account');
    return id;
  };
  // WorkOS not answering is not the request's fault: the person is told to try again in a while.
  const route = (fn) => async (ctx) => {
    try {
      return await fn(ctx);
    } catch (err) {
      if (err instanceof WorkosUnavailable) throw new HttpError(503, 'provider_unavailable');
      throw err;
    }
  };
  const offered = (user) => twoFactor === 'on' || (twoFactor === 'admins' && user.role === 'admin');

  /** How they sign in: noted at their last sign-in, else the accounts WorkOS links to them. */
  async function methodOf(user, id) {
    const noted = users.methodOf?.(user.id);
    if (noted) return noted;
    const linked = await workos.identities(id);
    return linked.length ? fromIdentity(linked[0]) : 'password';
  }

  /** What Settings shows: how they sign in, whether the password is changed here, the second step. */
  async function describe(user) {
    const id = workosId(user);
    const method = await methodOf(user, id);
    const here = !ELSEWHERE.includes(method);
    const two = here && offered(user);
    return {
      method, password: here,
      two_factor: two ? { available: true, enabled: (await workos.factors(id)).length > 0 } : { available: false },
    };
  }

  /** The password again, with the brake of sign-in: an open session isn't a way to try them without limit. */
  async function confirmPassword(ctx, user, password) {
    const allowed = limiter ? limiter.checkLogin(ctx.req, user.username) : { allowed: true };
    if (!allowed.allowed) throw new HttpError(429, 'too_many_attempts', { retry_after: allowed.retryAfter });
    const account = await workos.account(workosId(user));
    const right = await workos.checkPassword({
      email: account?.email, password: String(password ?? ''),
      // Where it comes from, which WorkOS logs and brakes by (audit sc-auth-13: it went as null).
      ip: clientIp(ctx.req, { trustProxy }) || null,
      userAgent: String(ctx.req.headers?.['user-agent'] || '').slice(0, 300) || null,
    });
    if (!right) {
      limiter?.loginFailed(ctx.req, user.username);
      throw forbidden('wrong_password');
    }
  }

  /**
   * A code of the authenticator app they have at WorkOS (`id`), given by whoever is signed in: with
   * the brake of the second step's codes (rate-limit.js checkCode, per account and address), as a
   * local one has. A million values and an open session (or the admin's password known) were no
   * reason to let them be tried without limit (audit sc-auth-13).
   */
  async function confirmCode(ctx, id, code) {
    const allowed = limiter ? limiter.checkCode(ctx.req, ctx.user.id) : { allowed: true };
    if (!allowed.allowed) throw new HttpError(429, 'too_many_attempts', { retry_after: allowed.retryAfter });
    const clean = String(code ?? '').replace(/\s/g, '');
    if (/^\d{6}$/.test(clean)) {
      for (const factor of await workos.factors(id)) {
        if (await workos.checkCode(factor.id, clean)) {
          limiter?.codeSucceeded(ctx.req, ctx.user.id);
          return;
        }
      }
    }
    limiter?.codeFailed(ctx.req, ctx.user.id);
    throw badRequest('code_invalid');
  }

  /** Every factor off: what turning it off does, and what an administrator does for whoever lost the phone. */
  async function removeFactors(id) {
    const found = await workos.factors(id);
    for (const factor of found) await workos.deleteFactor(factor.id);
    return found.length;
  }

  /**
   * After a new password: everyone else out (revoke.js: the sessions here and at
   * WorkOS, API tokens, phones, AI clients…), but `keep`'s session. Without
   * revokeEverything (a caller from before), the sessions alone, as it was.
   */
  const outEverywhere = (ctx, user, keep, reason) => {
    if (revokeEverything) {
      revokeEverything(user.id, { keep: keep ? { sessionToken: keep } : null, reason, actor: ctx.user, req: ctx.req });
      return;
    }
    const atProvider = sessions.idpSessionsOf?.(user.id, { exceptToken: keep }) || [];
    sessions.closeAllOf(user.id, { exceptToken: keep });
    revokeAtProvider(atProvider);
  };

  /**
   * Before what can't be undone from the account (erasing its data, a copy that replaces it,
   * deleting it; api.js identityCheck): the password they have at WorkOS, when they sign in with
   * one, with the brake of sign-in. Whoever signs in with Google & co. has none to give: their
   * open session, as before. Without one it erased everything (audit authz-9).
   */
  async function confirmIdentity(ctx, user, password) {
    const id = users.workosIdOf(user.id);
    if (!id || ELSEWHERE.includes(await methodOf(user, id))) return;
    await confirmPassword(ctx, user, password);
  }

  const ensureHere = async (user) => {
    const id = workosId(user);
    if (ELSEWHERE.includes(await methodOf(user, id))) throw badRequest('password_elsewhere');
    return id;
  };

  router.get('/api/me/sign-in', route(async (ctx) => {
    sendJson(ctx.res, 200, await describe(requireUser(ctx)));
  }));

  /** A new password, given the current one. Everything else that lets them in ends (revoke.js), here and at WorkOS. */
  router.post('/api/me/sign-in/password', route(async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    const id = await ensureHere(user);
    const next = String(body.password ?? '');
    if (next.length < minPasswordLength) throw rejected();
    await confirmPassword(ctx, user, body.current_password);
    const done = await workos.setPassword(id, next);
    if (done.refused) throw rejected(done.refused);
    outEverywhere(ctx, user, ctx.sessionToken, 'password');
    record(ctx, 'auth.password', 'user', user.id, { provider: 'workos' });
    sendJson(ctx.res, 200, { ok: true });
  }));

  // The secrets being set up, a few minutes each; a restart only means starting again.
  const pending = new Map();
  const forget = () => {
    for (const [userId, entry] of pending) if (clock() - entry.at > SETUP_MS) pending.delete(userId);
  };
  const ensureOffered = (user) => {
    if (!offered(user)) throw notFound('not_found');
  };

  router.post('/api/me/sign-in/two-factor/setup', answeredOnce(route(async (ctx) => {
    const user = requireUser(ctx);
    ensureOffered(user);
    const body = await readJson(ctx.req);
    const id = await ensureHere(user);
    await confirmPassword(ctx, user, body.password);
    if ((await workos.factors(id)).length) throw conflict('two_factor_enabled');
    forget();
    const secret = base32Encode(crypto.randomBytes(20));
    pending.set(user.id, { secret, at: clock() });
    const who = (await workos.account(id))?.email || user.username;
    const label = encodeURIComponent(`${appName}:${who}`);
    const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(appName)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
    sendJson(ctx.res, 200, { secret, uri });
  })));

  router.post('/api/me/sign-in/two-factor/enable', route(async (ctx) => {
    const user = requireUser(ctx);
    ensureOffered(user);
    const body = await readJson(ctx.req);
    forget();
    const entry = pending.get(user.id);
    if (!entry) throw badRequest('two_factor_not_started');
    const key = base32Decode(entry.secret);
    if (matchStep(key, body.code, clock()) == null) throw badRequest('code_invalid');
    const id = workosId(user);
    if ((await workos.factors(id)).length) throw conflict('two_factor_enabled');
    const who = (await workos.account(id))?.email || user.username;
    await workos.enrollTotp(id, {
      secret: entry.secret, issuer: appName, user: who,
      code: totp(key, Math.floor(clock() / 1000 / STEP_SECONDS)),
    });
    pending.delete(user.id);
    record(ctx, 'auth.two_factor.enable', 'user', user.id, { provider: 'workos' });
    sendJson(ctx.res, 200, { enabled: true });
  }));

  /** Off, with the password and a code: an open session alone must not be a way around it. */
  router.post('/api/me/sign-in/two-factor/disable', route(async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    const id = workosId(user);
    await confirmPassword(ctx, user, body.password);
    if (!(await workos.factors(id)).length) throw conflict('two_factor_off');
    await confirmCode(ctx, id, body.code);
    await removeFactors(id);
    record(ctx, 'auth.two_factor.disable', 'user', user.id, { provider: 'workos' });
    sendJson(ctx.res, 200, { enabled: false });
  }));

  /* ------------------------------- the admin ------------------------------ */

  const someone = (ctx) => {
    requireAdmin(ctx);
    const user = accounts.byId(int(ctx.params.id, { field: 'id', min: 1 }));
    if (!user) throw notFound('user_not_found');
    return user;
  };

  /**
   * What the admin gives again before changing someone's identity: `password` (theirs at
   * WorkOS), `password_code` (and a code of their second step), or `session` (they sign in with
   * Google or a company's sign-in, so there is no password to give: a fresh sign-in instead).
   */
  async function reauthOf(admin) {
    const id = users.workosIdOf(admin.id);
    if (!id || ELSEWHERE.includes(await methodOf(admin, id))) return { kind: 'session', id };
    return { kind: (await workos.factors(id)).length ? 'password_code' : 'password', id };
  }

  /**
   * The sessions whose admin was confirmed lately (confirmAdmin), by a hash of the token, with
   * whose and when. Kept in memory: a restart only means giving the password once more.
   */
  const confirmedAt = new Map();
  const sessionKey = (ctx) => (ctx.sessionToken
    ? crypto.createHash('sha256').update(String(ctx.sessionToken)).digest('base64url') : null);
  const remember = (ctx) => {
    const key = sessionKey(ctx);
    if (!key) return;
    for (const [other, entry] of confirmedAt) if (clock() - entry.at > CONFIRMED_MS) confirmedAt.delete(other);
    confirmedAt.set(key, { userId: ctx.user.id, at: clock() });
  };
  const confirmedLately = (ctx) => {
    const entry = confirmedAt.get(sessionKey(ctx));
    return Boolean(entry && entry.userId === ctx.user.id && clock() - entry.at <= CONFIRMED_MS && sessions.alive(ctx.sessionToken));
  };

  /**
   * The admin again: their password and, with a second step, a code; or this session's sign-in at
   * WorkOS, if they actively signed in after the server last asked them to and in the minutes since
   * (createFreshSignIns), else `reauth_required`, and they are asked: the panel sends them to sign
   * in again, with AuthKit asking again too. A stolen cookie alone isn't enough to change who
   * someone is in every product, nor is a session AuthKit opened by itself.
   *
   * Each time it passes, it stands for that session for 10 minutes (CONFIRMED_MS) for what asks
   * only that the admin was confirmed lately (`recent`: a new account's login), so making several
   * accounts asks once. Such a request that comes with nothing to check, outside those minutes, is
   * `403 admin_confirm_required` with what to give (`reauth`): the panel asks for it apart
   * (POST /api/admin/confirm) and sends the request again. What changes someone who already
   * exists (their password, their second step, their login gone) still asks every time.
   */
  async function confirmAdmin(ctx, body, { recent = false } = {}) {
    if (recent && confirmedLately(ctx)) return;
    const { kind, id } = await reauthOf(ctx.user);
    if (kind === 'session') {
      if (!freshSignIns?.fresh(ctx.user.id, ctx.sessionToken)) {
        freshSignIns?.ask(ctx.user.id);
        throw new HttpError(401, 'reauth_required');
      }
      remember(ctx);
      return;
    }
    if (recent && body?.admin_password == null) throw new HttpError(403, 'admin_confirm_required', { reauth: kind });
    await confirmPassword(ctx, ctx.user, body?.admin_password);
    if (kind === 'password_code') await confirmCode(ctx, id, body?.admin_code);
    remember(ctx);
  }

  /**
   * How someone signs in and whether they have a second step, for their page in the admin panel.
   * With adminIdentity, `reauth`: what the admin gives again to change them (reauthOf); without
   * it, `manage: false`: this install doesn't change them.
   */
  router.get('/api/admin/users/:id/sign-in', route(async (ctx) => {
    const user = someone(ctx);
    const id = users.workosIdOf(user.id);
    const manage = adminIdentity ? { manage: true, reauth: (await reauthOf(ctx.user)).kind } : { manage: false };
    if (!id) {
      sendJson(ctx.res, 200, { method: null, password: false, two_factor: { enabled: false }, ...manage });
      return;
    }
    const method = await methodOf(user, id);
    sendJson(ctx.res, 200, {
      method, password: !ELSEWHERE.includes(method), two_factor: { enabled: (await workos.factors(id)).length > 0 },
      ...manage,
    });
  }));

  // Changing someone's WorkOS identity changes it in every product: only the install that owns
  // the identities does it, and only with the admin's own password (and code) again.
  // The password again, for api.js identityCheck: WorkOS not answering is a 503, as here.
  const identity = (ctx, user, password) => route(() => confirmIdentity(ctx, user, password))(ctx);
  if (!adminIdentity) return { confirmIdentity: identity };

  /**
   * The admin's own password (and code) given apart, when a request answered `admin_confirm_required`:
   * it stands 10 minutes in this session (confirmAdmin), so the panel sends that request again
   * and the next ones go through. An admin who signs in elsewhere (Google) has nothing to give:
   * a fresh sign-in (createFreshSignIns), else `reauth_required`. → { ok, until }
   */
  router.post('/api/admin/confirm', route(async (ctx) => {
    requireAdmin(ctx);
    await confirmAdmin(ctx, await readJson(ctx.req));
    sendJson(ctx.res, 200, { ok: true, until: new Date(clock() + CONFIRMED_MS).toISOString() });
  }));

  /**
   * Whoever lost the phone: their second step off. They sign in with the password alone until
   * they set it up again; whatever else let them in ends (revoke.js), in case it wasn't them.
   */
  router.delete('/api/admin/users/:id/sign-in/two-factor', route(async (ctx) => {
    const user = someone(ctx);
    const body = await readJson(ctx.req);
    const id = workosId(user);
    await confirmAdmin(ctx, body);
    const removed = await removeFactors(id);
    if (!removed) throw conflict('two_factor_off');
    outEverywhere(ctx, user, user.id === ctx.user.id ? ctx.sessionToken : null, 'admin_two_factor_off');
    accounts.changed?.(user.id);
    record(ctx, 'admin.user.two_factor_off', 'user', user.id, { provider: 'workos' });
    sendJson(ctx.res, 200, { ok: true });
  }));

  /**
   * A password the admin sets for them: they are signed out everywhere. Not for whoever signs in
   * with Google & co.: it would give them a password they never had.
   */
  router.put('/api/admin/users/:id/sign-in/password', route(async (ctx) => {
    const user = someone(ctx);
    const body = await readJson(ctx.req);
    const next = String(body.password ?? '');
    if (next.length < minPasswordLength) throw rejected();
    const id = await ensureHere(user);
    await confirmAdmin(ctx, body);
    const done = await workos.setPassword(id, next);
    if (done.refused) throw rejected(done.refused);
    const self = user.id === ctx.user.id;
    outEverywhere(ctx, user, self ? ctx.sessionToken : null, 'admin_password');
    accounts.changed?.(user.id);
    record(ctx, 'admin.user.update', 'user', user.id, { fields: [], password: true, provider: 'workos' });
    sendJson(ctx.res, 200, { ok: true });
  }));

  /** WorkOS not answering, as the routes here say it (route()), for what the admin API calls. */
  const answered = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof WorkosUnavailable) throw new HttpError(503, 'provider_unavailable');
      throw err;
    }
  };

  /**
   * Logins the admin makes at WorkOS for the accounts they create (registerAdminApi's `logins`):
   * a test account for a store's review, a tester. Its email is taken as verified, so it signs in
   * at once with the password the admin chose, and it carries this app's mark (`mark`, where the
   * logins are shared) as if it had signed in here. `taken(email)`, whether WorkOS has one with
   * that email already (someone of another app of the suite): theirs, never made again. `make`
   * → the WorkOS id, or 400 `password_rejected` with WorkOS's reason. `undo(id)`: the account
   * here couldn't be made after all, so the login goes too.
   */
  const logins = {
    provider: 'workos', name: 'WorkOS',
    // The shortest password one takes (api.js checks it before asking WorkOS).
    minPasswordLength,
    taken: (email) => answered(async () => Boolean(await workos.userByEmail(email))),
    make: ({ email, password, displayName = null }) => answered(async () => {
      const done = await workos.createUser({
        email, password, firstName: displayName, emailVerified: true,
        metadata: mark ? { [mark.key]: mark.name } : null,
      });
      if (done.refused) {
        // Someone took the email between the question and now: said as the question would have.
        if (await workos.userByEmail(email)) throw conflict('email_taken_provider', { provider: 'WorkOS' });
        throw rejected(done.refused);
      }
      return done.user.id;
    }),
    undo: (id) => workos.deleteUser(id),
  };

  return { confirmAdmin: (ctx, body, options) => route(() => confirmAdmin(ctx, body, options))(ctx), logins, confirmIdentity: identity };
}
