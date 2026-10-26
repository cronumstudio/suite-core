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
import { HttpError, sendJson, readJson, badRequest, notFound, forbidden, unauthorized, conflict, int } from './http.js';
import { answeredOnce } from './idempotency.js';
import { WorkosUnavailable } from './workos.js';

const SETUP_MS = 10 * 60 * 1000;
/** How recent an admin's sign-in must be to change someone's identity without a password to give. */
const REAUTH_MS = 10 * 60 * 1000;
const STEP_SECONDS = 30;

/** Methods that are another account's sign-in: its password and second step are there. */
export const ELSEWHERE = Object.freeze(['google', 'apple', 'microsoft', 'github', 'sso', 'email_code']);

/** WorkOS's names of the accounts it links (identities), as signInMethod() names them. */
const fromIdentity = (provider) => String(provider || '').replace(/OAuth$/, '').toLowerCase() || null;

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
 *   identities, since a WorkOS user is the same in every product. Off, those two routes don't exist.
 */
export function registerWorkosSecurityApi(router, {
  workos, users, accounts, sessions, limiter = null, audit = null, appName = 'App', twoFactor = 'on',
  revokeAtProvider = () => {}, revokeEverything = null, adminIdentity = false, clock = () => Date.now(),
}) {
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
      userAgent: String(ctx.req.headers?.['user-agent'] || '').slice(0, 300) || null,
    });
    if (!right) {
      limiter?.loginFailed(ctx.req, user.username);
      throw forbidden('wrong_password');
    }
  }

  /** A code of the authenticator app they have at WorkOS. */
  async function confirmCode(id, code) {
    const clean = String(code ?? '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(clean)) throw badRequest('code_invalid');
    for (const factor of await workos.factors(id)) {
      if (await workos.checkCode(factor.id, clean)) return;
    }
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
    if (next.length < 8) throw badRequest('password_rejected');
    await confirmPassword(ctx, user, body.current_password);
    const done = await workos.setPassword(id, next);
    if (done.refused) throw badRequest('password_rejected', { detail: done.refused });
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
    await confirmCode(id, body.code);
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
   * Google or a company's sign-in, so there is no password to give: a recent sign-in instead).
   */
  async function reauthOf(admin) {
    const id = users.workosIdOf(admin.id);
    if (!id || ELSEWHERE.includes(await methodOf(admin, id))) return { kind: 'session', id };
    return { kind: (await workos.factors(id)).length ? 'password_code' : 'password', id };
  }

  /**
   * The admin again: their password and, with a second step, a code; or a session opened in the
   * last minutes, else `reauth_required` (the panel sends them to sign in again). A stolen
   * cookie alone isn't enough to change who someone is in every product.
   */
  async function confirmAdmin(ctx, body) {
    const { kind, id } = await reauthOf(ctx.user);
    if (kind === 'session') {
      const session = ctx.sessionToken ? sessions.alive(ctx.sessionToken) : null;
      if (!session || clock() - Date.parse(session.created_at) > REAUTH_MS) throw new HttpError(401, 'reauth_required');
      return;
    }
    await confirmPassword(ctx, ctx.user, body.admin_password);
    if (kind === 'password_code') await confirmCode(id, body.admin_code);
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
  if (!adminIdentity) return;

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
    if (next.length < 8) throw badRequest('password_rejected');
    const id = await ensureHere(user);
    await confirmAdmin(ctx, body);
    const done = await workos.setPassword(id, next);
    if (done.refused) throw badRequest('password_rejected', { detail: done.refused });
    const self = user.id === ctx.user.id;
    outEverywhere(ctx, user, self ? ctx.sessionToken : null, 'admin_password');
    accounts.changed?.(user.id);
    record(ctx, 'admin.user.update', 'user', user.id, { fields: [], password: true, provider: 'workos' });
    sendJson(ctx.res, 200, { ok: true });
  }));
}
