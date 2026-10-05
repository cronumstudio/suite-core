/**
 * The suite's REST routes over real HTTP: the admin's and people's own groups,
 * with everything recorded in the audit log.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { createRouter, sendJson, sendError } from '../http.js';
import { createAccounts } from '../accounts.js';
import { createSessions } from '../sessions.js';
import { createEntitlements } from '../entitlements.js';
import { createOrganizations } from '../organizations.js';
import { createAudit } from '../audit.js';
import { registerAdminApi, registerOrganizationsApi, registerProfileApi } from '../api.js';
import { createTokens } from '../tokens.js';

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-api-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });

  const sessions = createSessions({ database, secret: 's3cret', cookieName: 'sid' });
  const accounts = createAccounts({ database, sessions });
  let organizations = null;
  const entitlements = createEntitlements({
    database, appId: 'test',
    features: { 'lists.max': { type: 'limit', default: null }, sharing: { type: 'flag', default: true } },
    plans: { free: { name: 'Free', features: { 'lists.max': 3, sharing: false } }, pro: { name: 'Pro', features: {} } },
    plansJson: null, defaultPlanOverride: null,
    organizationsOf: (user) => organizations.organizationsOf(user),
  });
  organizations = createOrganizations({ database, seatsOf: entitlements.seatsOf });
  accounts.whenRemoved((id) => organizations.forgetUser(id));
  const audit = createAudit({ database, trustProxy: '' });

  const router = createRouter();
  const tokens = createTokens({ database });
  // The identity provider: which of its sessions were ended from here.
  const revokedAtProvider = [];
  const idp = { name: 'WorkOS', revokeSession: async (id) => { revokedAtProvider.push(id); } };
  const pushed = { unsubscribed: [] };
  const push = { unsubscribe: (id) => { pushed.unsubscribed.push(id); return 1; } };
  const forgotten = [];
  registerAdminApi(router, {
    accounts, entitlements, organizations, sessions, audit, tokens, idp, push,
    oauth: { forgetUser: (id) => forgotten.push(id) },
  });
  registerOrganizationsApi(router, { organizations, audit, baseUrl: 'https://app.example/' });
  // Connected apps: a stand-in for the OAuth server with one grant per person.
  const grants = new Map();
  const oauth = { enabled: true, grantsOf: (id) => grants.get(id) || [], revokeGrant: (grant, id) => grant === 1 && grants.delete(id) };
  registerProfileApi(router, { accounts, sessions, tokens, entitlements, oauth, audit, idp, alsoAt: { tokens: '/api/mcp-tokens', apps: '/api/oauth-grants' } });

  // Who is asking comes in a header: signing in is not what is tested here.
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const match = router.match(req.method, url.pathname);
      if (!match) return sendJson(res, 404, { error: 'not_found' });
      if (match.methodMismatch) return sendJson(res, 405, { error: 'method_not_allowed' });
      const user = req.headers['x-user'] ? accounts.byId(Number(req.headers['x-user'])) : null;
      await match.handler({ req, res, params: match.params, query: url.searchParams, user, sessionToken: req.headers['x-session'] || null });
    } catch (err) {
      sendError(res, err);
    }
    return undefined;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = async (method, pathname, { as = null, body, session } = {}) => {
    const headers = {};
    if (as) headers['x-user'] = String(as);
    if (session) headers['x-session'] = session;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const root = accounts.create({ username: 'root', password: 'correct horse', role: 'admin' });
  return { call, root: root.id, accounts, sessions, entitlements, organizations, audit, database, tokens, grants, revokedAtProvider, pushed, forgotten };
}

test('only the admin reaches /api/admin', async (t) => {
  const { call, accounts } = await start(t);
  const ada = accounts.create({ username: 'ada' });
  assert.equal((await call('GET', '/api/admin/users')).status, 401);
  assert.deepEqual(await call('GET', '/api/admin/users', { as: ada.id }), { status: 403, body: { error: 'admin_only' } });
  assert.equal((await call('GET', '/api/admin/audit', { as: ada.id })).status, 403);
});

test('the admin manages accounts, and every change is in the log', async (t) => {
  const { call, root, sessions, audit, tokens, database, revokedAtProvider, pushed, forgotten } = await start(t);

  const created = await call('POST', '/api/admin/users', { as: root, body: { username: 'ada', display_name: 'Ada', password: 'correct horse', email: 'ada@example.com' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.username, 'ada');
  assert.equal(created.body.plan.id, 'free');
  assert.equal(created.body.has_password, true);
  assert.equal(created.body.password_hash, undefined);
  const ada = created.body.id;

  assert.deepEqual((await call('POST', '/api/admin/users', { as: root, body: { username: 'ada' } })).body, { error: 'username_taken' });
  assert.equal((await call('POST', '/api/admin/users', { as: root, body: { username: 'bob', password: 'short' } })).body.error, 'field_too_short');

  const phone = sessions.open(ada, {});
  const patched = await call('PATCH', `/api/admin/users/${ada}`, { as: root, body: { display_name: 'Ada L.', password: 'a much better one' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.display_name, 'Ada L.');
  assert.equal(sessions.alive(phone), null, 'a new password signs them out');

  // A lost phone: out everywhere, not just of the sessions here.
  const again = sessions.open(ada, { idpSessionId: 'session_lost_phone' });
  const assistant = tokens.create(ada, { name: 'Claude' });
  assert.deepEqual((await call('DELETE', `/api/admin/users/${ada}/sessions`, { as: root })).body, { ok: true, closed: 1, tokens: 1 });
  assert.equal(sessions.alive(again), null);
  assert.equal(tokens.authenticate(assistant.token), null, 'its API tokens are revoked');
  assert.deepEqual([forgotten.at(-1), pushed.unsubscribed.at(-1), revokedAtProvider.at(-1)], [ada, ada, 'session_lost_phone'],
    'and its assistants’ grants, its devices’ notices and the provider’s session');
  // Disabled: its devices stop getting notices too (apps read the table directly).
  database.run("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, 'https://push.example/x', 'k', 'a')", ada);
  await call('PATCH', `/api/admin/users/${ada}`, { as: root, body: { disabled: true } });
  assert.equal(database.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', ada).n, 0, 'a disabled account gets no notices');
  await call('PATCH', `/api/admin/users/${ada}`, { as: root, body: { disabled: false } });

  // Never on yourself: the admin panel would lock its own admin out.
  assert.deepEqual((await call('PATCH', `/api/admin/users/${root}`, { as: root, body: { role: 'user' } })).body, { error: 'not_on_yourself' });
  assert.deepEqual((await call('DELETE', `/api/admin/users/${root}`, { as: root })).body, { error: 'not_on_yourself' });
  assert.equal((await call('PATCH', '/api/admin/users/abc', { as: root, body: {} })).body.error, 'field_invalid');
  assert.equal((await call('DELETE', '/api/admin/users/999', { as: root })).body.error, 'user_not_found');

  assert.deepEqual((await call('DELETE', `/api/admin/users/${ada}`, { as: root })).body, { ok: true });
  const log = audit.list();
  assert.deepEqual(log.map((e) => e.action),
    ['admin.user.remove', 'admin.user.update', 'admin.user.update', 'admin.user.signout', 'admin.user.update', 'admin.user.create']);
  assert.deepEqual(log[4].meta, { fields: ['display_name'], password: true }, 'that it changed, never to what');
  assert.equal(JSON.stringify(log).includes('much better'), false);

  const page = await call('GET', `/api/admin/audit?limit=2&before=${log[0].id}`, { as: root });
  assert.deepEqual(page.body.entries.map((e) => e.action), ['admin.user.update', 'admin.user.update']);
});

test('plans and grants from the admin', async (t) => {
  const { call, root, accounts, entitlements } = await start(t);
  const ada = accounts.create({ username: 'ada' }).id;

  const catalog = await call('GET', '/api/admin/plans', { as: root });
  assert.deepEqual(catalog.body.plans.map((p) => p.id), ['free', 'pro']);

  const set = await call('PUT', `/api/admin/users/${ada}/plan`, { as: root, body: { plan: 'pro', ends_at: '2099-01-01T00:00:00Z' } });
  assert.equal(set.body.plan.id, 'pro');
  assert.equal(set.body.plan_ends, '2099-01-01T00:00:00.000Z');
  assert.equal((await call('PUT', `/api/admin/users/${ada}/plan`, { as: root, body: { plan: 'gold' } })).body.error, 'plan_unknown');
  assert.equal((await call('PUT', `/api/admin/users/${ada}/plan`, { as: root, body: { plan: null } })).body.plan.id, 'free');

  const bonus = await call('POST', '/api/admin/grants', { as: root, body: { subject_id: ada, feature: 'lists.max', value: 10, note: 'beta tester' } });
  assert.equal(bonus.status, 201);
  assert.equal(entitlements.limit(accounts.byId(ada), 'lists.max'), 10);
  assert.equal((await call('POST', '/api/admin/grants', { as: root, body: { subject_id: ada, plan: 'pro', feature: 'sharing' } })).body.error, 'field_invalid');
  assert.equal((await call('POST', '/api/admin/grants', { as: root, body: { subject_id: ada, feature: 'lists.max', value: 'many' } })).body.error, 'field_invalid');
  assert.equal((await call('POST', '/api/admin/grants', { as: root, body: { subject_id: ada, feature: 'teleport', value: true } })).body.error, 'feature_unknown');
  assert.equal((await call('POST', '/api/admin/grants', { as: root, body: { subject_id: 999, plan: 'pro' } })).body.error, 'user_not_found');

  const grants = await call('GET', `/api/admin/users/${ada}/grants`, { as: root });
  assert.deepEqual(grants.body.grants.map((g) => [g.plan ?? g.feature, Boolean(g.revoked_at)]),
    [['lists.max', false], ['pro', true]], 'the bonus, and the plan the admin took back');
  assert.deepEqual((await call('DELETE', `/api/admin/grants/${bonus.body.id}`, { as: root })).body, { ok: true });
  assert.equal((await call('DELETE', `/api/admin/grants/${bonus.body.id}`, { as: root })).body.error, 'grant_not_found');
  assert.equal(entitlements.limit(accounts.byId(ada), 'lists.max'), 3);
});

test('people’s own groups: create, invite, join, roles, leave', async (t) => {
  const { call, root, accounts, entitlements, audit } = await start(t);
  const [ada, bob, eve] = ['ada', 'bob', 'eve'].map((name) => accounts.create({ username: name }).id);

  assert.equal((await call('GET', '/api/orgs')).status, 401);
  const home = (await call('POST', '/api/orgs', { as: ada, body: { name: 'Home', kind: 'household' } })).body;
  assert.equal(home.role, 'owner');
  assert.equal(home.slug, 'home');

  const invitation = await call('POST', `/api/orgs/${home.id}/invitations`, { as: ada, body: { role: 'admin', email: 'bob@example.com' } });
  assert.equal(invitation.status, 201);
  assert.match(invitation.body.url, /^https:\/\/app\.example\/\?invitation=inv_/);
  assert.equal((await call('POST', `/api/orgs/${home.id}/invitations`, { as: bob })).body.error, 'organization_not_found', 'not a member yet');

  const joined = await call('POST', '/api/orgs/join', { as: bob, body: { token: invitation.body.token } });
  assert.equal(joined.body.role, 'admin');
  assert.deepEqual((await call('GET', '/api/orgs', { as: bob })).body.organizations.map((o) => o.name), ['Home']);

  // An admin invites members, not owners, and can't touch the owner.
  assert.equal((await call('POST', `/api/orgs/${home.id}/invitations`, { as: bob, body: { role: 'owner' } })).body.error, 'organization_role');
  const member = await call('POST', `/api/orgs/${home.id}/invitations`, { as: bob, body: {} });
  await call('POST', '/api/orgs/join', { as: eve, body: { token: member.body.token } });
  assert.equal((await call('PATCH', `/api/orgs/${home.id}/members/${ada}`, { as: bob, body: { role: 'member' } })).body.error, 'organization_role');
  assert.equal((await call('DELETE', `/api/orgs/${home.id}/members/${ada}`, { as: bob })).body.error, 'organization_role');
  assert.equal((await call('PATCH', `/api/orgs/${home.id}`, { as: eve, body: { name: 'Mine now' } })).body.error, 'organization_role');

  const detail = await call('GET', `/api/orgs/${home.id}`, { as: eve });
  assert.deepEqual(detail.body.members.map((m) => [m.username, m.role]), [['ada', 'owner'], ['bob', 'admin'], ['eve', 'member']]);

  // Owners make owners; the last one can't leave.
  assert.equal((await call('DELETE', `/api/orgs/${home.id}/members/${ada}`, { as: ada })).body.error, 'last_owner');
  await call('PATCH', `/api/orgs/${home.id}/members/${bob}`, { as: ada, body: { role: 'owner' } });
  assert.deepEqual((await call('DELETE', `/api/orgs/${home.id}/members/${ada}`, { as: ada })).body, { ok: true });
  assert.equal((await call('GET', `/api/orgs/${home.id}`, { as: ada })).status, 404, 'gone for whoever left');

  // A plan on the group reaches its members, and its seats cap them.
  entitlements.grant({ subjectType: 'organization', subjectId: home.id, plan: 'pro', quantity: 2 });
  assert.equal(entitlements.can(accounts.byId(eve), 'sharing'), true);
  assert.equal(entitlements.can(accounts.byId(ada), 'sharing'), false);
  const full = await call('POST', `/api/orgs/${home.id}/invitations`, { as: bob, body: {} });
  assert.deepEqual((await call('POST', '/api/orgs/join', { as: ada, body: { token: full.body.token } })).body, { error: 'seats_full', seats: 2 });

  const admin = await call('GET', '/api/admin/organizations', { as: root });
  assert.deepEqual(admin.body.organizations.map((o) => [o.name, o.members]), [['Home', 2]]);
  assert.deepEqual(audit.list({ action: 'org.' }).map((e) => e.action).reverse(),
    ['org.create', 'org.invite', 'org.join', 'org.invite', 'org.join', 'org.member.role', 'org.leave', 'org.invite']);
  assert.equal(audit.list({ action: 'org.join' })[0].organization_id, home.id);
});

test('each person’s own: sessions, plan, tokens, connected apps and password', async (t) => {
  const { call, accounts, sessions, tokens, grants, audit } = await start(t);
  const ada = accounts.create({ username: 'ada', password: 'correct horse' }).id;
  const bob = accounts.create({ username: 'bob' }).id;
  assert.equal((await call('GET', '/api/me/sessions')).status, 401);

  const here = sessions.open(ada, { req: { headers: { 'user-agent': 'Laptop' }, socket: {} } });
  sessions.open(ada, { req: { headers: { 'user-agent': 'Phone' }, socket: {} } });
  const listed = await call('GET', '/api/me/sessions', { as: ada, session: here });
  assert.equal(listed.body.length, 2);
  const phone = listed.body.find((s) => !s.current);
  assert.deepEqual((await call('DELETE', `/api/me/sessions/${phone.key}`, { as: ada })).body, { ok: true });
  assert.equal((await call('DELETE', `/api/me/sessions/${phone.key}`, { as: ada })).body.error, 'session_not_found');

  const plan = await call('GET', '/api/me/entitlements', { as: ada });
  assert.equal(plan.body.plan.id, 'free');
  assert.deepEqual(plan.body.plans.map((p) => p.id), ['free', 'pro'], 'there is a choice');

  // Tokens, at the suite's path and at the one the app always had.
  const made = await call('POST', '/api/mcp-tokens', { as: ada, body: { name: 'Claude' } });
  assert.equal(made.status, 201);
  assert.match(made.body.token, /^mcp_/);
  assert.equal(made.body.token_hash, undefined);
  assert.equal(tokens.authenticate(made.body.token).id, ada);
  assert.deepEqual((await call('GET', '/api/me/tokens', { as: ada })).body.map((r) => r.name), ['Claude']);
  assert.deepEqual((await call('GET', '/api/me/tokens', { as: bob })).body, []);
  assert.equal((await call('DELETE', `/api/me/tokens/${made.body.id}`, { as: bob })).body.error, 'token_not_found');
  assert.deepEqual((await call('DELETE', `/api/mcp-tokens/${made.body.id}`, { as: ada })).body, { ok: true });
  assert.equal(tokens.authenticate(made.body.token), null);

  grants.set(ada, [{ id: 1, client_name: 'Claude' }]);
  assert.deepEqual((await call('GET', '/api/oauth-grants', { as: ada })).body, { enabled: true, grants: [{ id: 1, client_name: 'Claude' }] });
  assert.equal((await call('DELETE', '/api/me/apps/2', { as: ada })).body.error, 'app_not_found');
  assert.deepEqual((await call('DELETE', '/api/me/apps/1', { as: ada })).body, { ok: true });

  // The password: the current one first; every session ends and this browser gets a new one.
  assert.equal((await call('POST', '/api/me/password', { as: ada, body: { current_password: 'wrong', password: 'a much better one' } })).body.error, 'wrong_password');
  assert.equal((await call('POST', '/api/me/password', { as: ada, body: { current_password: 'correct horse', password: 'short' } })).body.error, 'field_too_short');
  const changed = await call('POST', '/api/me/password', { as: ada, body: { current_password: 'correct horse', password: 'a much better one' } });
  assert.deepEqual(changed.body, { ok: true });
  assert.equal(sessions.alive(here), null);
  assert.equal(sessions.list(ada, null).length, 1, 'the new one');
  assert.ok(accounts.verify('ada', 'a much better one'));
  // Someone without a password sets their first without a current one.
  assert.deepEqual((await call('POST', '/api/me/password', { as: bob, body: { password: 'bob’s first one' } })).body, { ok: true });

  assert.deepEqual(audit.list({ actorId: ada }).map((e) => e.action).reverse(),
    ['auth.session.revoke', 'token.create', 'token.revoke', 'oauth.grant.revoke', 'auth.password']);
});
