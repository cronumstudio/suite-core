/**
 * The suite's REST routes, the same in every app:
 *
 * · `/api/me/…` for each person: where they are signed in, their plan, their
 *   API tokens, the apps they connected and their password.
 * · `/api/admin/…` for the instance admin: accounts, plans and grants,
 *   organizations and the audit log. The admin panel of the web kit is drawn
 *   on these, and so is anything that manages an install from outside.
 * · `/api/orgs/…` for people: their groups, members, roles and invitations.
 *
 * They are registered on the app's router (`createRouter()` of http.js) and
 * receive its request context: `{ req, res, params, query, user, sessionToken }`.
 * Every change is recorded in the audit log, without content.
 */
import {
  HttpError, sendJson, readJson, badRequest, notFound, forbidden, unauthorized, int, idOrNull, str,
} from './http.js';
import { verifyPassword } from './crypto.js';

const idOf = (value, field = 'id') => int(value, { field, min: 1 });
const countOrNull = (value, field) => (value == null ? null : int(value, { field, min: 0 }));

/**
 * Signing in and out with a username and password, and who is signed in.
 * With an identity provider (`idp`: WorkOS, OIDC) accounts are the
 * provider's: people sign in on its page (/auth/login), and signing out here
 * also returns the provider's sign-out address, or the next "Sign in" would
 * get straight in without asking.
 *
 * @param {object} deps
 * @param {object} deps.accounts, deps.sessions, deps.limiter   the suite's
 * @param {Function} deps.serializeUser   the account as the browser sees it
 * @param {string} [deps.signup]          who may create an account: admin | invite | open
 * @param {object} [deps.app]             { id, name, languages, modules }, told to the browser
 */
export function registerAuthApi(router, {
  accounts, sessions, limiter, audit = null, idp = null, serializeUser, signup = 'admin', app = null,
}) {
  /** Before signing in: the sign-in screen has to know what to show. */
  router.get('/api/auth/config', (ctx) => {
    // `signup`: who may create an account here (admin | invite | open); with a
    // provider, whoever it lets in.
    // `app`: which app this is, the languages it speaks and the modules it has on,
    // for the suite's own pages (the admin panel).
    sendJson(ctx.res, 200, {
      provider: idp?.id ?? 'local', name: idp?.name ?? null, signup: idp ? null : signup, ...(app ? { app } : {}),
    });
  });

  router.post('/api/auth/login', async (ctx) => {
    if (idp) throw badRequest('password_login_disabled');
    const body = await readJson(ctx.req);
    const username = String(body.username || '').trim();
    const allowed = limiter.checkLogin(ctx.req, username);
    if (!allowed.allowed) throw new HttpError(429, 'too_many_attempts', { retry_after: allowed.retryAfter });
    const user = accounts.verify(username, body.password);
    if (!user) {
      limiter.loginFailed(ctx.req, username);
      // Not which username: a password typed in the wrong box would end up here.
      audit?.record({ action: 'auth.login_failed', req: ctx.req });
      throw new HttpError(401, 'bad_credentials');
    }
    limiter.loginSucceeded(ctx.req, username);
    // With the request, the browser's previous session is closed and the device noted.
    sessions.open(user.id, { req: ctx.req, res: ctx.res });
    audit?.record({ action: 'auth.login', actor: user, req: ctx.req });
    sendJson(ctx.res, 200, { user: serializeUser(user) });
  });

  router.post('/api/auth/logout', async (ctx) => {
    const idpSession = sessions.close(ctx.sessionToken);
    sessions.clearCookie(ctx.res);
    if (ctx.user) audit?.record({ action: 'auth.logout', actor: ctx.user, req: ctx.req });
    const logoutUrl = idpSession && idp ? await idp.signOutUrl(idpSession) : null;
    sendJson(ctx.res, 200, { ok: true, ...(logoutUrl ? { logout_url: logoutUrl } : {}) });
  });

  router.get('/api/auth/me', (ctx) => {
    sendJson(ctx.res, 200, { user: serializeUser(ctx.user) });
  });
}

/**
 * What accounts do by mail (account-mail.js): a new password when the old one
 * is forgotten, confirming an email, signing up with an invitation or, when
 * the install leaves it open, without one; and the admin's invitations. The
 * links in the messages come back to the app's page (/?reset=…, /?verify=…,
 * /?signup=…), which posts the token here.
 */
export function registerAccountMailApi(router, { accountMail, sessions, serializeUser, admin = true }) {
  const requireUser = (ctx) => {
    if (!ctx.user) throw unauthorized();
    return ctx.user;
  };

  /** Always the same answer: it never says whether an account exists. */
  router.post('/api/auth/forgot', async (ctx) => {
    const body = await readJson(ctx.req);
    await accountMail.requestReset(body.login ?? body.username ?? body.email, { req: ctx.req });
    sendJson(ctx.res, 200, { ok: true });
  });

  /** A new password from a link: every other session ends and this browser is signed in. */
  router.post('/api/auth/reset', async (ctx) => {
    const body = await readJson(ctx.req);
    const user = accountMail.resetPassword(body.token, body.password, { req: ctx.req });
    sessions.open(user.id, { req: ctx.req, res: ctx.res });
    sendJson(ctx.res, 200, { user: serializeUser(user) });
  });

  router.post('/api/auth/verify', async (ctx) => {
    const body = await readJson(ctx.req);
    const user = accountMail.verifyEmail(body.token, { req: ctx.req });
    sendJson(ctx.res, 200, { ok: true, ...(ctx.user?.id === user.id ? { user: serializeUser(user) } : {}) });
  });

  /** Sends the person a new link to confirm their email. */
  router.post('/api/me/email/verify', async (ctx) => {
    const user = requireUser(ctx);
    await accountMail.sendVerification(user, { req: ctx.req });
    sendJson(ctx.res, 200, { ok: true });
  });

  /** A new account, with an invitation's token or, when sign-up is open, without; signed in right away. */
  router.post('/api/auth/signup', async (ctx) => {
    const body = await readJson(ctx.req);
    const user = await accountMail.signUp({
      token: body.token ?? null, username: body.username, displayName: body.display_name ?? null,
      email: body.email ?? null, password: body.password, locale: body.locale ?? null,
    }, { req: ctx.req });
    sessions.open(user.id, { req: ctx.req, res: ctx.res });
    sendJson(ctx.res, 201, { user: serializeUser(user) });
  });

  if (!admin) return;
  const requireAdmin = (ctx) => {
    const user = requireUser(ctx);
    if (user.role !== 'admin') throw forbidden('admin_only');
    return user;
  };

  router.get('/api/admin/invitations', (ctx) => {
    requireAdmin(ctx);
    sendJson(ctx.res, 200, { invitations: accountMail.invitations() });
  });

  router.post('/api/admin/invitations', async (ctx) => {
    const admin = requireAdmin(ctx);
    const body = await readJson(ctx.req);
    const invitation = await accountMail.invite({ email: body.email, role: body.role ?? 'user', by: admin, req: ctx.req });
    sendJson(ctx.res, 201, invitation);
  });

  router.delete('/api/admin/invitations/:id', (ctx) => {
    requireAdmin(ctx);
    if (!accountMail.revokeInvitation(idOf(ctx.params.id))) throw notFound('invitation_invalid');
    sendJson(ctx.res, 200, { ok: true });
  });
}

/**
 * Each person's own routes. Every dependency is optional: an app without
 * plans or OAuth simply doesn't get those routes.
 *
 * @param {object} router
 * @param {object} deps
 * @param {object} [deps.accounts]      from createAccounts(), for the password
 * @param {object} [deps.sessions]      from createSessions()
 * @param {object} [deps.tokens]        from createTokens()
 * @param {object} [deps.entitlements]  from createEntitlements()
 * @param {object} [deps.oauth]         from createOAuthServer(), for connected apps
 * @param {object} [deps.audit]         from createAudit()
 * @param {boolean} [deps.localPasswords]  false when accounts sign in elsewhere (WorkOS)
 * @param {object} [deps.alsoAt]        older paths an app keeps answering:
 *   `{ tokens: '/api/mcp-tokens', apps: '/api/oauth-grants' }`
 */
export function registerProfileApi(router, {
  accounts = null, sessions = null, tokens = null, entitlements = null, oauth = null, audit = null,
  localPasswords = true, alsoAt = {},
}) {
  const requireUser = (ctx) => {
    if (!ctx.user) throw unauthorized();
    return ctx.user;
  };
  const record = (ctx, action, targetType, targetId, meta) =>
    audit?.record({ action, actor: ctx.user, req: ctx.req, targetType, targetId, meta });
  const at = (path, legacy, add) => [path, ...(legacy ? [legacy] : [])].forEach(add);

  if (sessions) {
    /** Where the person is signed in: device, address and last use; `current` is this browser. */
    router.get('/api/me/sessions', (ctx) => {
      const user = requireUser(ctx);
      sendJson(ctx.res, 200, sessions.list(user.id, ctx.sessionToken));
    });

    /** Signs one of those devices out. */
    router.delete('/api/me/sessions/:key', (ctx) => {
      const user = requireUser(ctx);
      if (!sessions.revoke(user.id, ctx.params.key)) throw notFound('session_not_found');
      record(ctx, 'auth.session.revoke', 'session', null);
      sendJson(ctx.res, 200, { ok: true });
    });
  }

  if (entitlements) {
    /** The person's plan and what it allows; the other plans only when there is a choice. */
    router.get('/api/me/entitlements', (ctx) => {
      const user = requireUser(ctx);
      const { plans, several } = entitlements.describe();
      sendJson(ctx.res, 200, {
        ...entitlements.of(user),
        plans: several ? plans.map(({ id, name }) => ({ id, name })) : [],
      });
    });
  }

  if (tokens) {
    at('/api/me/tokens', alsoAt.tokens, (path) => {
      router.get(path, (ctx) => {
        const user = requireUser(ctx);
        sendJson(ctx.res, 200, tokens.list(user.id));
      });
      router.post(path, async (ctx) => {
        const user = requireUser(ctx);
        const body = await readJson(ctx.req);
        const { token, row } = tokens.create(user.id, {
          name: str(body.name ?? 'MCP', { field: 'name', max: 60, min: 1 }),
          scopes: body.scopes ?? ['mcp'], expiresAt: body.expires_at ?? null,
        });
        record(ctx, 'token.create', 'token', row.id, { scopes: row.scopes });
        // The value travels once, here. After that only its hash remains.
        sendJson(ctx.res, 201, { ...row, token });
      });
      router.delete(`${path}/:id`, (ctx) => {
        const user = requireUser(ctx);
        const id = idOf(ctx.params.id);
        if (!tokens.revoke(user.id, id)) throw notFound('token_not_found');
        record(ctx, 'token.revoke', 'token', id);
        sendJson(ctx.res, 200, { ok: true });
      });
    });
  }

  if (oauth) {
    /** Apps connected through the built-in OAuth (Claude, ChatGPT…); `enabled` says whether pasting the URL is enough. */
    at('/api/me/apps', alsoAt.apps, (path) => {
      router.get(path, (ctx) => {
        const user = requireUser(ctx);
        sendJson(ctx.res, 200, { enabled: oauth.enabled, grants: oauth.enabled ? oauth.grantsOf(user.id) : [] });
      });
      router.delete(`${path}/:id`, (ctx) => {
        const user = requireUser(ctx);
        const id = idOf(ctx.params.id);
        if (!oauth.revokeGrant(id, user.id)) throw notFound('app_not_found');
        record(ctx, 'oauth.grant.revoke', 'oauth_grant', id);
        sendJson(ctx.res, 200, { ok: true });
      });
    });
  }

  if (accounts && sessions) {
    /**
     * A new password, given the current one (an account without a password,
     * made by the admin or elsewhere, sets its first). Every session ends and
     * this browser gets a new one.
     */
    router.post('/api/me/password', async (ctx) => {
      const user = requireUser(ctx);
      if (!localPasswords) throw badRequest('passwords_managed_elsewhere');
      const body = await readJson(ctx.req);
      const hasOne = Boolean(user.password_hash && user.password_hash !== '!');
      if (hasOne && !verifyPassword(String(body.current_password ?? ''), user.password_hash)) {
        throw forbidden('wrong_password');
      }
      accounts.setPassword(user.id, body.password);
      sessions.open(user.id, { req: ctx.req, res: ctx.res });
      record(ctx, 'auth.password', 'user', user.id);
      sendJson(ctx.res, 200, { ok: true });
    });
  }
}

/**
 * @param {object} router
 * @param {object} deps
 * @param {object} deps.accounts        from createAccounts()
 * @param {object} [deps.entitlements]  from createEntitlements()
 * @param {object} [deps.organizations] from createOrganizations()
 * @param {object} [deps.sessions]      from createSessions()
 * @param {object} [deps.audit]         from createAudit()
 */
export function registerAdminApi(router, { accounts, entitlements = null, organizations = null, sessions = null, audit = null }) {
  const requireAdmin = (ctx) => {
    if (!ctx.user) throw unauthorized();
    if (ctx.user.role !== 'admin') throw forbidden('admin_only');
    return ctx.user;
  };
  const record = (ctx, action, targetType, targetId, meta) =>
    audit?.record({ action, actor: ctx.user, req: ctx.req, targetType, targetId, meta });
  const withPlan = (user) => {
    // Where the account signs in besides its password (workos, oidc…).
    const view = { ...accounts.publicUser(user), providers: accounts.identitiesOf(user.id).map((i) => i.provider) };
    if (!entitlements) return view;
    const { plan, ends, unlimited } = entitlements.of(user);
    return { ...view, plan, plan_ends: ends, unlimited };
  };

  router.get('/api/admin/users', (ctx) => {
    requireAdmin(ctx);
    sendJson(ctx.res, 200, { users: accounts.list().map(withPlan) });
  });

  router.post('/api/admin/users', async (ctx) => {
    requireAdmin(ctx);
    const body = await readJson(ctx.req);
    const user = accounts.create({
      username: body.username, displayName: body.display_name, password: body.password ?? null,
      role: body.role ?? 'user', email: body.email ?? null, locale: body.locale ?? null,
    });
    record(ctx, 'admin.user.create', 'user', user.id, { role: user.role });
    sendJson(ctx.res, 201, withPlan(user));
  });

  router.patch('/api/admin/users/:id', async (ctx) => {
    requireAdmin(ctx);
    const id = idOf(ctx.params.id);
    const body = await readJson(ctx.req);
    if (id === ctx.user.id && (body.disabled === true || (body.role && body.role !== 'admin'))) {
      throw badRequest('not_on_yourself');
    }
    const user = accounts.update(id, {
      displayName: body.display_name, email: body.email, role: body.role, locale: body.locale, disabled: body.disabled,
    });
    if (body.password !== undefined) {
      accounts.setPassword(id, body.password, { exceptToken: id === ctx.user.id ? ctx.sessionToken : null });
    }
    record(ctx, 'admin.user.update', 'user', id, {
      fields: Object.keys(body).filter((k) => k !== 'password'), password: body.password !== undefined,
    });
    sendJson(ctx.res, 200, withPlan(accounts.byId(user.id)));
  });

  router.delete('/api/admin/users/:id', (ctx) => {
    requireAdmin(ctx);
    const id = idOf(ctx.params.id);
    if (id === ctx.user.id) throw badRequest('not_on_yourself');
    accounts.remove(id);
    record(ctx, 'admin.user.remove', 'user', id);
    sendJson(ctx.res, 200, { ok: true });
  });

  /** Signs someone out everywhere (a lost phone, a departure). */
  router.delete('/api/admin/users/:id/sessions', (ctx) => {
    requireAdmin(ctx);
    const id = idOf(ctx.params.id);
    if (!accounts.byId(id)) throw notFound('user_not_found');
    const closed = sessions ? sessions.closeAllOf(id, { exceptToken: id === ctx.user.id ? ctx.sessionToken : null }) : 0;
    record(ctx, 'admin.user.signout', 'user', id, { closed });
    sendJson(ctx.res, 200, { ok: true, closed });
  });

  if (entitlements) {
    router.get('/api/admin/plans', (ctx) => {
      requireAdmin(ctx);
      sendJson(ctx.res, 200, entitlements.describe());
    });

    /** The admin's way to set someone's plan; `plan: null` returns them to the default one. */
    router.put('/api/admin/users/:id/plan', async (ctx) => {
      requireAdmin(ctx);
      const id = idOf(ctx.params.id);
      if (!accounts.byId(id)) throw notFound('user_not_found');
      const body = await readJson(ctx.req);
      entitlements.setPlan(id, body.plan ?? null, { endsAt: body.ends_at ?? null, note: body.note ?? null });
      record(ctx, 'admin.plan.set', 'user', id, { plan: body.plan ?? null, ends_at: body.ends_at ?? null });
      sendJson(ctx.res, 200, withPlan(accounts.byId(id)));
    });

    router.get('/api/admin/users/:id/grants', (ctx) => {
      requireAdmin(ctx);
      sendJson(ctx.res, 200, { grants: entitlements.grantsOf('user', idOf(ctx.params.id)) });
    });

    router.post('/api/admin/grants', async (ctx) => {
      requireAdmin(ctx);
      const body = await readJson(ctx.req);
      const subjectType = body.subject_type === 'organization' ? 'organization' : 'user';
      const subjectId = idOf(body.subject_id, 'subject_id');
      if (subjectType === 'user' && !accounts.byId(subjectId)) throw notFound('user_not_found');
      if (subjectType === 'organization' && !organizations?.get(subjectId)) throw notFound('organization_not_found');
      // A plan or a single feature, never both.
      if (!body.plan === !body.feature) throw badRequest('field_invalid', { field: body.plan ? 'feature' : 'plan' });
      const id = entitlements.grant({
        subjectType, subjectId, plan: body.plan || null, feature: body.feature || null, value: body.value,
        quantity: countOrNull(body.quantity, 'quantity'), source: 'admin',
        startsAt: body.starts_at ?? null, endsAt: body.ends_at ?? null, note: body.note ?? null,
      });
      record(ctx, 'admin.grant.add', subjectType, subjectId, { grant: id, plan: body.plan || null, feature: body.feature || null });
      sendJson(ctx.res, 201, { id });
    });

    router.delete('/api/admin/grants/:id', (ctx) => {
      requireAdmin(ctx);
      const id = idOf(ctx.params.id);
      if (!entitlements.revoke({ id })) throw notFound('grant_not_found');
      record(ctx, 'admin.grant.revoke', 'grant', id);
      sendJson(ctx.res, 200, { ok: true });
    });
  }

  if (organizations) {
    router.get('/api/admin/organizations', (ctx) => {
      requireAdmin(ctx);
      sendJson(ctx.res, 200, { organizations: organizations.list() });
    });
  }

  if (audit) {
    router.get('/api/admin/audit', (ctx) => {
      requireAdmin(ctx);
      const q = ctx.query || new URLSearchParams();
      sendJson(ctx.res, 200, {
        entries: audit.list({
          limit: q.get('limit') ?? 100, before: idOrNull(q.get('before'), 'before'),
          actorId: idOrNull(q.get('actor'), 'actor'), action: q.get('action') || null,
        }),
      });
    });
  }
}

/**
 * People's own groups. `baseUrl` builds invitation links:
 * `${baseUrl}/?invitation=<token>`, which the web kit accepts after sign-in.
 */
export function registerOrganizationsApi(router, { organizations, audit = null, baseUrl = '' }) {
  const requireUser = (ctx) => {
    if (!ctx.user) throw unauthorized();
    return ctx.user;
  };
  const record = (ctx, action, organizationId, targetType, targetId, meta) =>
    audit?.record({ action, actor: ctx.user, req: ctx.req, organizationId, targetType, targetId, meta });

  router.get('/api/orgs', (ctx) => {
    const user = requireUser(ctx);
    sendJson(ctx.res, 200, { organizations: organizations.ofUser(user.id) });
  });

  router.post('/api/orgs', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    const organization = organizations.create({ name: body.name, kind: body.kind ?? null, ownerId: user.id });
    record(ctx, 'org.create', organization.id, 'organization', organization.id);
    sendJson(ctx.res, 201, { ...organization, role: 'owner' });
  });

  router.get('/api/orgs/:id', (ctx) => {
    const user = requireUser(ctx);
    const id = idOf(ctx.params.id);
    const role = organizations.requireRole(id, user.id, 'member');
    sendJson(ctx.res, 200, { ...organizations.get(id), role, members: organizations.membersOf(id) });
  });

  router.patch('/api/orgs/:id', async (ctx) => {
    const user = requireUser(ctx);
    const id = idOf(ctx.params.id);
    organizations.requireRole(id, user.id, 'admin');
    const body = await readJson(ctx.req);
    const organization = organizations.update(id, { name: body.name, settings: body.settings, branding: body.branding });
    record(ctx, 'org.update', id, 'organization', id, { fields: Object.keys(body) });
    sendJson(ctx.res, 200, organization);
  });

  router.post('/api/orgs/:id/invitations', async (ctx) => {
    const user = requireUser(ctx);
    const id = idOf(ctx.params.id);
    const myRole = organizations.requireRole(id, user.id, 'admin');
    const body = await readJson(ctx.req);
    const role = body.role ?? 'member';
    if (role === 'owner' && myRole !== 'owner') throw forbidden('organization_role');
    const { token, invitation } = organizations.invite(id, { role, email: body.email ?? null, invitedBy: user.id });
    record(ctx, 'org.invite', id, 'invitation', invitation.id, { role });
    sendJson(ctx.res, 201, {
      id: invitation.id, role, expires_at: invitation.expires_at, token,
      url: `${String(baseUrl).replace(/\/$/, '')}/?invitation=${encodeURIComponent(token)}`,
    });
  });

  router.get('/api/orgs/:id/invitations', (ctx) => {
    const user = requireUser(ctx);
    const id = idOf(ctx.params.id);
    organizations.requireRole(id, user.id, 'admin');
    sendJson(ctx.res, 200, { invitations: organizations.invitationsOf(id) });
  });

  router.delete('/api/orgs/:id/invitations/:invitation', (ctx) => {
    const user = requireUser(ctx);
    const id = idOf(ctx.params.id);
    organizations.requireRole(id, user.id, 'admin');
    if (!organizations.revokeInvitation(id, idOf(ctx.params.invitation, 'invitation'))) throw notFound('invitation_invalid');
    record(ctx, 'org.invitation.revoke', id, 'invitation', ctx.params.invitation);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.post('/api/orgs/join', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    const organization = organizations.accept(body.token, user.id);
    record(ctx, 'org.join', organization.id, 'user', user.id);
    sendJson(ctx.res, 200, { ...organization, role: organizations.roleOf(organization.id, user.id) });
  });

  router.patch('/api/orgs/:id/members/:user', async (ctx) => {
    const user = requireUser(ctx);
    const id = idOf(ctx.params.id);
    const myRole = organizations.requireRole(id, user.id, 'admin');
    const target = idOf(ctx.params.user, 'user');
    const body = await readJson(ctx.req);
    const theirs = organizations.roleOf(id, target);
    // Only owners make or unmake owners; an admin can't touch an owner.
    if ((body.role === 'owner' || theirs === 'owner') && myRole !== 'owner') throw forbidden('organization_role');
    organizations.setRole(id, target, body.role);
    record(ctx, 'org.member.role', id, 'user', target, { role: body.role });
    sendJson(ctx.res, 200, { members: organizations.membersOf(id) });
  });

  router.delete('/api/orgs/:id/members/:user', (ctx) => {
    const user = requireUser(ctx);
    const id = idOf(ctx.params.id);
    const target = idOf(ctx.params.user, 'user');
    // Anyone may leave; removing someone else takes an admin, and an owner takes an owner.
    if (target !== user.id) {
      const myRole = organizations.requireRole(id, user.id, 'admin');
      if (organizations.roleOf(id, target) === 'owner' && myRole !== 'owner') throw forbidden('organization_role');
    } else {
      organizations.requireRole(id, user.id, 'member');
    }
    organizations.removeMember(id, target);
    record(ctx, target === user.id ? 'org.leave' : 'org.member.remove', id, 'user', target);
    sendJson(ctx.res, 200, { ok: true });
  });
}
