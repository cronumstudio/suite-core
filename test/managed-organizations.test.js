/**
 * Groups an app manages and their lifecycle (0.85.0): kinds the generic routes refuse, a cap per
 * person, the app's hooks inside the change's transaction, a group deleted when its last member
 * goes, invitations purged, and a deleted group's subscription stopped at the provider once.
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
import { createAccounts } from '../accounts.js';
import { createAudit } from '../audit.js';
import { createEntitlements } from '../entitlements.js';
import { createOrganizations, organizationKinds } from '../organizations.js';
import { createBilling } from '../billing.js';
import { resolveConfig } from '../config.js';
import { createSuite, createApp } from '../app.js';
import { paddleProvider, signPaddlePayload } from '../paddle.js';
import { stripeProvider } from '../stripe.js';

const DAY = 24 * 3600 * 1000;
const FAMILY = { family: { managed: true, maxPerUser: 1 } };
const SECRET = 'pdl_ntfset_01k0000000000000000000000_secretofthedestination';
const PRICE = 'pri_01m46hn0famfamfamfamfam0yr';
const PRODUCTS = { 'family-yearly': { plan: 'pro', kind: 'subscription', for: 'organization', price: PRICE } };
const PLANS = { free: { name: 'Free', features: {} }, pro: { name: 'Pro', features: {} } };

const code = (fn) => { try { fn(); } catch (err) { return `${err.status ?? 'Error'} ${err.code ?? err.message}`; } return 'ok'; };
const count = (database, sql, ...params) => Number(database.get(sql, ...params).n);

/** The suite's tables, five people, organizations with `options`, and an app's table of its own. */
function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-managed-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  // What an app keeps per member of a group (Focus's adult profiles).
  database.exec(`CREATE TABLE app_profiles (organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER, PRIMARY KEY (organization_id, user_id))`);
  const accounts = createAccounts({ database });
  const audit = createAudit({ database });
  const people = Object.fromEntries(['root', 'ada', 'bob', 'eve', 'dan'].map((name) =>
    [name, accounts.create({ username: name, role: name === 'root' ? 'admin' : 'user' }).id]));
  const organizations = createOrganizations({ database, audit, ...options });
  accounts.whenRemoved((id) => organizations.forgetUser(id));
  const profile = (organizationId, userId) => database.run('INSERT INTO app_profiles VALUES (?, ?)', organizationId, userId);
  const profiles = (organizationId) => database.all('SELECT user_id FROM app_profiles WHERE organization_id = ? ORDER BY user_id',
    organizationId).map((r) => r.user_id);
  return { database, accounts, audit, organizations, people, profile, profiles };
}

/* -------------------------------- the kinds ------------------------------- */

test('kinds in suite.config.js: checked on start, filled in, and the same in createOrganizations', (t) => {
  const product = { app: { id: 'demo', name: 'Demo' }, modules: { organizations: true } };
  const config = resolveConfig({ ...product, organizations: { kinds: { family: { managed: true, maxPerUser: 1 }, team: { onEmpty: 'delete' } } } },
    { DATA_DIR: '/data' });
  assert.deepEqual(config.errors, []);
  assert.deepEqual(config.organizations.kinds, {
    family: { managed: true, maxPerUser: 1, onEmpty: 'delete' },
    team: { managed: false, maxPerUser: null, onEmpty: 'delete' },
  }, 'a managed kind is deleted when empty unless it says otherwise; any other is archived unless it says delete');
  assert.deepEqual(resolveConfig(product, {}).organizations.kinds, {}, 'left out: no kind, as before');
  assert.deepEqual(organizationKinds({ family: { managed: true, onEmpty: 'archive' } }).kinds.family.onEmpty, 'archive');

  const errorsOf = (kinds) => resolveConfig({ ...product, organizations: { kinds } }, {}).errors;
  for (const [kinds, error] of [
    ['family', 'organizations.kinds: an object of kinds, such as { family: { managed: true, maxPerUser: 1 } }'],
    [{ Family: {} }, 'organizations.kinds: "Family" is not a kind\'s name (lowercase letters, digits, - and _, starting with a letter)'],
    [{ constructor: {} }, 'organizations.kinds: "constructor" is not a kind\'s name (lowercase letters, digits, - and _, starting with a letter)'],
    [{ family: true }, 'organizations.kinds.family: an object, such as { managed: true, maxPerUser: 1 }'],
    // A misspelt key would leave the generic routes open to the kind without a word.
    [{ family: { manage: true } }, 'organizations.kinds.family.manage is not a setting (managed, maxPerUser, onEmpty)'],
    [{ family: { managed: 'yes' } }, 'organizations.kinds.family.managed must be true or false'],
    [{ family: { maxPerUser: 0 } }, 'organizations.kinds.family.maxPerUser: a whole number from 1 to 1000, or left out for no limit'],
    [{ family: { maxPerUser: 1.5 } }, 'organizations.kinds.family.maxPerUser: a whole number from 1 to 1000, or left out for no limit'],
    [{ family: { onEmpty: 'keep' } }, "organizations.kinds.family.onEmpty: 'archive' or 'delete'"],
  ]) {
    assert.ok(errorsOf(kinds).includes(error), `${JSON.stringify(kinds)}: ${errorsOf(kinds).join(' | ')}`);
  }
  // The billing option is a boolean, kept only when given.
  assert.equal(resolveConfig({ ...product, billing: { stopOnOrganizationDeleted: true } }, {}).billing.stopOnOrganizationDeleted, true);
  assert.equal('stopOnOrganizationDeleted' in resolveConfig({ ...product, billing: {} }, {}).billing, false);
  assert.ok(resolveConfig({ ...product, billing: { stopOnOrganizationDeleted: 'yes' } }, {}).errors
    .includes('billing.stopOnOrganizationDeleted must be true or false'));
  assert.ok(resolveConfig({ ...product, billing: { stopOnOrganizationDelete: true } }, {}).errors
    .includes('billing.stopOnOrganizationDelete is not a setting (a typo?)'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-managed-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => createOrganizations({ database, kinds: { family: { manage: true } } }), /family\.manage is not a setting/);
  const organizations = createOrganizations({ database, kinds: FAMILY });
  assert.equal(organizations.isManaged('family'), true);
  assert.equal(organizations.isManaged('team'), false);
  assert.equal(organizations.isManaged(null), false);
  assert.equal(organizations.isManaged('constructor'), false, 'never one of Object\'s own');
  assert.deepEqual(organizations.rulesFor('team'), { managed: false, maxPerUser: null, onEmpty: 'archive' });
});

test('maxPerUser: one family per person, whoever creates, adds or accepts; other kinds and archived ones don’t count', (t) => {
  const { organizations, people } = setup(t, { kinds: FAMILY });
  const home = organizations.create({ name: 'Home', kind: 'family', ownerId: people.ada });
  assert.equal(code(() => organizations.create({ name: 'Second home', kind: 'family', ownerId: people.ada })), '409 organization_limit');
  assert.deepEqual((() => { try { organizations.create({ name: 'Again', kind: 'family', ownerId: people.ada }); } catch (err) { return err.extra; } })(),
    { kind: 'family', max: 1 });
  assert.equal(organizations.list().filter((o) => o.kind === 'family').length, 1, 'nothing was made');
  organizations.create({ name: 'Team', kind: 'team', ownerId: people.ada });
  organizations.create({ name: 'Club', ownerId: people.ada });

  const other = organizations.create({ name: 'Other home', kind: 'family', ownerId: people.bob });
  assert.equal(code(() => organizations.addMember(other.id, people.ada, 'admin')), '409 organization_limit');
  const { token } = organizations.invite(other.id, { role: 'admin' });
  assert.equal(code(() => organizations.accept(token, people.ada)), '409 organization_limit');
  assert.equal(organizations.accept(token, people.eve).id, other.id, 'the invitation was not spent by the refusal');
  organizations.addMember(home.id, people.dan, 'admin');

  // A group nobody sees any more takes no place.
  organizations.archive(home.id);
  assert.equal(organizations.create({ name: 'New home', kind: 'family', ownerId: people.ada }).kind, 'family');
});

/* ---------------------------- hooks and deletion --------------------------- */

test('the app hears of each member who goes and each group deleted, inside the transaction', (t) => {
  const { database, accounts, organizations, people, profile, profiles } = setup(t, { kinds: FAMILY });
  const heard = [];
  organizations.whenMemberRemoved(({ organization, userId, role, reason, by }) => {
    heard.push(['member', organization.name, userId, role, reason, by]);
    database.run('DELETE FROM app_profiles WHERE organization_id = ? AND user_id = ?', organization.id, userId);
  });
  organizations.whenDeleted(({ organization, reason, by }) => {
    heard.push(['deleted', organization.name, reason, by]);
    // The group is still there for the hook to read.
    assert.equal(count(database, 'SELECT COUNT(*) AS n FROM organizations WHERE id = ?', organization.id), 1);
  });
  const home = organizations.create({ name: 'Home', kind: 'family', ownerId: people.ada });
  organizations.addMember(home.id, people.bob, 'admin');
  organizations.addMember(home.id, people.eve, 'admin');
  for (const id of [people.ada, people.bob, people.eve]) profile(home.id, id);

  assert.deepEqual(organizations.removeMember(home.id, people.bob, { by: people.bob }), { organizationDeleted: false });
  organizations.removeMember(home.id, people.eve, { by: people.ada });
  assert.deepEqual(profiles(home.id), [people.ada]);
  assert.deepEqual(heard, [
    ['member', 'Home', people.bob, 'admin', 'left', people.bob],
    ['member', 'Home', people.eve, 'admin', 'removed', people.ada],
  ]);

  // A hook that throws undoes the whole change, the other hooks' writes included.
  organizations.addMember(home.id, people.dan, 'admin');
  profile(home.id, people.dan);
  let fail = true;
  organizations.whenMemberRemoved(() => { if (fail) throw new Error('the app says no'); });
  assert.throws(() => organizations.removeMember(home.id, people.dan, { by: people.ada }), /the app says no/);
  assert.equal(organizations.roleOf(home.id, people.dan), 'admin');
  assert.deepEqual(profiles(home.id), [people.ada, people.dan], 'the first hook’s delete was undone');
  // The same through an account's deletion: the account stays.
  assert.throws(() => accounts.remove(people.dan), /the app says no/);
  assert.ok(accounts.byId(people.dan));
  assert.equal(organizations.roleOf(home.id, people.dan), 'admin');
  fail = false;

  heard.length = 0;
  accounts.remove(people.dan);
  assert.deepEqual(heard, [['member', 'Home', people.dan, 'admin', 'account_deleted', null]]);

  // A failing deletion hook keeps the group, its grants and its member.
  let refuseDeletion = true;
  organizations.whenDeleted(({ reason }) => { if (reason === 'empty' && refuseDeletion) throw new Error('not yet'); });
  assert.throws(() => organizations.removeMember(home.id, people.ada, { by: people.ada }), /not yet/);
  assert.equal(organizations.roleOf(home.id, people.ada), 'owner');
  assert.deepEqual(profiles(home.id), [people.ada]);
});

test('the last member out deletes a group of a kind that says so, whole; other kinds are archived as before', (t) => {
  const { database, accounts, audit, organizations, people, profile } = setup(t, {
    kinds: { ...FAMILY, team: { onEmpty: 'delete' } },
  });
  const entitlements = createEntitlements({ database, appId: 'test', features: {}, plans: PLANS, plansJson: null, defaultPlanOverride: null });
  const deleted = [];
  organizations.whenDeleted(({ organization, reason }) => deleted.push([organization.name, reason]));
  const leftWith = (organization) => ({
    row: count(database, 'SELECT COUNT(*) AS n FROM organizations WHERE id = ?', organization.id),
    members: count(database, 'SELECT COUNT(*) AS n FROM memberships WHERE organization_id = ?', organization.id),
    invitations: count(database, 'SELECT COUNT(*) AS n FROM invitations WHERE organization_id = ?', organization.id),
    grants: count(database, "SELECT COUNT(*) AS n FROM entitlement_grants WHERE subject_type = 'organization' AND subject_id = ?", organization.id),
    profiles: count(database, 'SELECT COUNT(*) AS n FROM app_profiles WHERE organization_id = ?', organization.id),
  });
  const gone = { row: 0, members: 0, invitations: 0, grants: 0, profiles: 0 };

  // Leaving: the family's only adult, an owner, takes it with them (a plain group refuses, as before).
  const home = organizations.create({ name: 'Home', kind: 'family', ownerId: people.ada });
  profile(home.id, people.ada);
  organizations.invite(home.id, { email: 'someone@example.com' });
  entitlements.grant({ subjectType: 'organization', subjectId: home.id, plan: 'pro', endsAt: new Date(Date.now() + 14 * DAY).toISOString() });
  assert.deepEqual(organizations.removeMember(home.id, people.ada, { by: people.ada }), { organizationDeleted: true });
  assert.deepEqual(leftWith(home), gone);
  const entry = audit.list({ action: 'org.delete' })[0];
  assert.deepEqual([entry.target_id, entry.organization_id, entry.actor_user_id, entry.meta],
    [String(home.id), null, people.ada, { kind: 'family', reason: 'empty' }]);
  const club = organizations.create({ name: 'Club', ownerId: people.ada });
  assert.equal(code(() => organizations.removeMember(club.id, people.ada, { by: people.ada })), '409 last_owner', 'archive kinds: as before');

  // Removed: a group of the kind with no owner left, its last member removed by the app.
  const team = organizations.create({ name: 'Team', kind: 'team' });
  organizations.addMember(team.id, people.bob, 'member');
  assert.deepEqual(organizations.removeMember(team.id, people.bob), { organizationDeleted: true });
  assert.deepEqual(leftWith(team), gone);
  const plain = organizations.create({ name: 'Plain' });
  organizations.addMember(plain.id, people.bob, 'member');
  organizations.removeMember(plain.id, people.bob);
  assert.equal(leftWith(plain).row, 1, 'a plain group left empty stays, as before');

  // An account deleted: its family goes whole when nobody else is in it, and passes on otherwise.
  const alone = organizations.create({ name: 'Alone', kind: 'family', ownerId: people.eve });
  profile(alone.id, people.eve);
  const shared = organizations.create({ name: 'Shared', kind: 'family', ownerId: people.dan });
  organizations.addMember(shared.id, people.bob, 'admin');
  const archived = organizations.create({ name: 'Old', ownerId: people.eve });
  accounts.remove(people.eve);
  accounts.remove(people.dan);
  assert.deepEqual(leftWith(alone), gone);
  assert.equal(organizations.roleOf(shared.id, people.bob), 'owner', 'the admin inherits, as before');
  assert.equal(organizations.get(archived.id), null);
  assert.equal(leftWith(archived).row, 1, 'archived, not deleted: as before');
  assert.deepEqual(deleted, [['Home', 'empty'], ['Team', 'empty'], ['Alone', 'empty']]);

  // The app deletes a group itself, with people in it: its hook does its rows.
  assert.equal(organizations.remove(shared.id, { reason: 'owner_asked', by: people.bob }), true);
  assert.deepEqual(leftWith(shared), gone);
  assert.deepEqual(deleted.at(-1), ['Shared', 'owner_asked']);
  assert.equal(organizations.remove(shared.id), false, 'once');
  assert.equal(organizations.exists(shared.id), false);
  assert.equal(organizations.exists(archived.id), true, 'an archived group is still here');
});

test('the purge deletes invitations used, withdrawn or expired over two weeks ago, in every app', (t) => {
  let now = Date.parse('2026-05-01T10:00:00Z');
  const { database, organizations, people } = setup(t, { clock: () => now });
  const home = organizations.create({ name: 'Home', ownerId: people.ada });
  const accepted = organizations.invite(home.id, { email: 'bob@example.com' });
  organizations.accept(accepted.token, people.bob);
  const revoked = organizations.invite(home.id, { email: 'eve@example.com' });
  organizations.revokeInvitation(home.id, revoked.invitation.id);
  const pending = organizations.invite(home.id, { email: 'dan@example.com' });
  const expired = organizations.invite(home.id, { email: 'old@example.com', days: 1 });
  now += 2 * DAY;
  assert.equal(organizations.purge(), 2, 'the used and the withdrawn: they answer 404 either way');
  assert.deepEqual(organizations.invitationsOf(home.id).map((i) => i.email), ['old@example.com', 'dan@example.com']);
  assert.equal(code(() => organizations.accept(expired.token, people.eve)), '410 invitation_expired', 'a late reader still hears it expired');
  now += 13 * DAY;
  assert.equal(organizations.purge(), 0);
  now += 1 * DAY;
  assert.equal(organizations.purge(), 1, 'expired over fourteen days ago');
  assert.equal(code(() => organizations.accept(expired.token, people.eve)), '404 invitation_invalid');
  assert.equal(code(() => organizations.accept(pending.token, people.eve)), '410 invitation_expired', 'the 7-day one, expired since');
  assert.equal(count(database, 'SELECT COUNT(*) AS n FROM invitations'), 1);
});

/* ---------------------------- the generic routes --------------------------- */

async function serve(t, { product = {}, env = {}, hooks = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-managed-'));
  const suite = createSuite({
    config: {
      app: { id: 'demo', name: 'Demo', languages: ['en'] }, accounts: { minPasswordLength: 8 },
      modules: { organizations: true }, organizations: { kinds: FAMILY }, ...product,
    },
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1', ...env },
    hooks, log: () => {}, exitOnError: false,
  });
  const app = createApp({ suite, version: '1.0.0', handleSignals: false, log: () => {} });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  /** A browser signed in as `username`. */
  const as = async (username, password = `${username}-password`) => {
    let cookie = '';
    const call = async (method, pathname, body) => {
      const res = await fetch(base + pathname, {
        method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('demo_sid='));
      if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    assert.equal((await call('POST', '/api/auth/login', { username, password })).status, 200);
    return call;
  };
  return { suite, base, as };
}

test('the generic routes refuse a kind the app manages, and let every other kind through as before', async (t) => {
  const left = [];
  const { suite, as } = await serve(t, { hooks: { onMemberRemoved: ({ userId, reason }) => left.push([userId, reason]) } });
  const ada = suite.accounts.create({ username: 'ada', password: 'ada-password' });
  const bob = suite.accounts.create({ username: 'bob', password: 'bob-password' });
  const adaWeb = await as('ada');
  const bobWeb = await as('bob');

  const refused = await adaWeb('POST', '/api/orgs', { name: 'Home', kind: 'family' });
  assert.deepEqual([refused.status, refused.data], [403, { error: 'organization_managed', kind: 'family' }]);
  assert.equal(suite.organizations.list().length, 0);
  const team = await adaWeb('POST', '/api/orgs', { name: 'Team', kind: 'team' });
  assert.equal(team.status, 201);
  assert.equal((await adaWeb('POST', '/api/orgs', { name: 'Club' })).status, 201);

  // The app makes the family through the suite's functions; an invitation can come from the generic route.
  const home = suite.organizations.create({ name: 'Home', kind: 'family', ownerId: ada.id });
  const invitation = await adaWeb('POST', `/api/orgs/${home.id}/invitations`, { role: 'admin' });
  assert.equal(invitation.status, 201);
  const join = await bobWeb('POST', '/api/orgs/join', { token: invitation.data.token });
  assert.deepEqual([join.status, join.data.error], [403, 'organization_managed']);
  assert.equal(suite.organizations.roleOf(home.id, bob.id), null);
  assert.equal(suite.organizations.accept(invitation.data.token, bob.id).id, home.id, 'unspent: the app’s own route takes it');

  // Leaving or removing: refused for the family (an outsider still sees nothing), allowed for the team.
  assert.equal((await bobWeb('DELETE', `/api/orgs/${home.id}/members/${bob.id}`)).data.error, 'organization_managed');
  assert.equal((await adaWeb('DELETE', `/api/orgs/${home.id}/members/${bob.id}`)).data.error, 'organization_managed');
  const outsider = suite.accounts.create({ username: 'eve', password: 'eve-password' });
  assert.equal((await (await as('eve'))('DELETE', `/api/orgs/${home.id}/members/${outsider.id}`)).status, 404);
  assert.equal(suite.organizations.roleOf(home.id, bob.id), 'admin', 'still in');
  // What doesn't take anyone in or out answers as before: reading, renaming, a role (the suite's rules).
  assert.equal((await adaWeb('GET', `/api/orgs/${home.id}`)).status, 200);
  assert.equal((await adaWeb('PATCH', `/api/orgs/${home.id}`, { name: 'The Andersens' })).status, 200);
  assert.equal((await adaWeb('PATCH', `/api/orgs/${home.id}/members/${bob.id}`, { role: 'owner' })).status, 200);
  assert.equal(suite.organizations.roleOf(home.id, bob.id), 'owner');

  const teamInvite = await adaWeb('POST', `/api/orgs/${team.data.id}/invitations`, {});
  assert.equal((await bobWeb('POST', '/api/orgs/join', { token: teamInvite.data.token })).status, 200);
  assert.deepEqual((await bobWeb('DELETE', `/api/orgs/${team.data.id}/members/${bob.id}`)).data, { ok: true });
  assert.deepEqual(left, [[bob.id, 'left']], 'the hook hears the generic route too');
  assert.equal((await bobWeb('POST', '/api/orgs/join', { token: 'inv_made-up' })).data.error, 'invitation_invalid', 'as before');
});

test('the generic leave route of a kind deleted when empty: the group goes, and its audit entry points at nothing', async (t) => {
  const { suite, as } = await serve(t, { product: { organizations: { kinds: { team: { onEmpty: 'delete' } } } } });
  suite.accounts.create({ username: 'ada', password: 'ada-password' });
  const adaWeb = await as('ada');
  const team = (await adaWeb('POST', '/api/orgs', { name: 'Team', kind: 'team' })).data;
  const me = suite.database.get("SELECT id FROM users WHERE username = 'ada'");
  assert.deepEqual((await adaWeb('DELETE', `/api/orgs/${team.id}/members/${me.id}`)).data, { ok: true, organization_deleted: true });
  assert.equal(suite.organizations.exists(team.id), false);
  const leave = suite.audit.list({ action: 'org.leave' })[0];
  assert.deepEqual([leave.organization_id, leave.target_id], [null, String(me.id)]);
  assert.equal(suite.audit.list({ action: 'org.delete' })[0].target_id, String(team.id));

  // suite.purge() takes the invitations of every app.
  const club = suite.organizations.create({ name: 'Club', ownerId: me.id });
  const { invitation } = suite.organizations.invite(club.id);
  suite.organizations.revokeInvitation(club.id, invitation.id);
  suite.purge();
  assert.equal(suite.organizations.invitationsOf(club.id).length, 0);
});

/* --------------------------- a group's renewals --------------------------- */

/** A stand-in for Paddle's API: records each call; `refuse` makes a cancellation fail as Paddle does. */
function fakePaddle() {
  const calls = [];
  const state = { refuse: null, subscription: {} };
  const fetch = async (url, init) => {
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push([init.method, pathname, body]);
    if (init.method === 'POST' && pathname.endsWith('/cancel') && state.refuse) {
      return { ok: false, status: state.refuse.status, json: async () => ({ error: { code: state.refuse.code, detail: 'x' } }) };
    }
    const data = init.method === 'GET' ? { id: pathname.split('/')[2], ...state.subscription } : { id: pathname.split('/')[2] };
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return { calls, state, fetch };
}

function withBilling(t, { provider = null, paddle = fakePaddle() } = {}) {
  const base = setup(t, { kinds: FAMILY });
  const { database, audit, organizations } = base;
  const entitlements = createEntitlements({ database, appId: 'test', features: {}, plans: PLANS, plansJson: null, defaultPlanOverride: null });
  const logs = [];
  const billing = createBilling({
    database, entitlements, audit, products: PRODUCTS, log: (line) => logs.push(line),
    provider: provider || paddleProvider({
      apiKey: 'pdl_sdbx_apikey_test', webhookSecret: SECRET, environment: 'sandbox', products: PRODUCTS, fetch: paddle.fetch, log: () => {},
    }),
    organizationGone: (id) => !organizations.exists(id),
  });
  assert.deepEqual(billing.errors, []);
  const subscribe = (organizationId, { id = 'evt_1', ref = 'sub_01home', status = 'active', at = '2026-10-01T10:00:00Z' } = {}) => billing.apply({
    // A customer of each subscription's own: a customer already linked says who pays before the subject does.
    id, type: 'subscription', occurredAt: at, customer: `ctm_${ref}`, subject: { type: 'organization', id: organizationId },
    ref, product: 'family-yearly', status, periodEnd: '2027-10-01T10:00:00Z',
  });
  const stops = () => database.all("SELECT event_id, outcome FROM billing_events WHERE type = 'stop' ORDER BY event_id")
    .map((r) => `${r.event_id} ${r.outcome}`);
  return { ...base, entitlements, billing, paddle, subscribe, stops, logs };
}

test('stopOrganization: a group’s subscription stops renewing at the period’s end, asked of Paddle once', async (t) => {
  const { billing, organizations, people, paddle, subscribe, stops, audit } = withBilling(t);
  const home = organizations.create({ name: 'Home', kind: 'family', ownerId: people.ada });
  assert.equal(subscribe(home.id), 'granted');
  subscribe(home.id, { id: 'evt_old', ref: 'sub_01gone', status: 'canceled' });

  assert.deepEqual(await billing.stopOrganization(home.id), { requested: 1, waiting: 0 });
  assert.deepEqual(paddle.calls, [['POST', '/subscriptions/sub_01home/cancel', { effective_from: 'next_billing_period' }]],
    'only the live one, at the end of the period');
  assert.deepEqual(await billing.stopOrganization(home.id), { requested: 0, waiting: 0 });
  assert.deepEqual(await billing.sendStops(), { requested: 0, waiting: 0 });
  assert.equal(paddle.calls.length, 1, 'idempotent: Paddle refuses a second cancellation anyway');
  assert.deepEqual(stops(), [`stop:organization:${home.id}:sub_01home requested`]);
  const entry = audit.list({ action: 'billing.organization.stop' })[0];
  assert.deepEqual([entry.organization_id, entry.target_id, entry.meta], [home.id, String(home.id), { provider: 'paddle-sandbox', ref: 'sub_01home' }]);
  assert.equal(await billing.stopOrganization(organizations.create({ name: 'Free', ownerId: people.bob }).id).then((r) => r.requested), 0,
    'a group that pays nothing: nothing to ask');

  // Taken back (the owner undoes a deletion): it renews again, and can be stopped again later.
  assert.equal(await billing.keepOrganization(home.id), 1);
  assert.deepEqual(paddle.calls.at(-1), ['PATCH', '/subscriptions/sub_01home', { scheduled_change: null }]);
  assert.deepEqual(stops(), []);
  assert.equal((await billing.stopOrganization(home.id)).requested, 1);
  assert.equal(audit.list({ action: 'billing.organization.keep' }).length, 1);
  // Once it ended there is nothing to renew: the mark goes without asking Paddle.
  subscribe(home.id, { id: 'evt_end', status: 'canceled', at: '2027-10-01T10:00:01Z' });
  const before = paddle.calls.length;
  assert.equal(await billing.keepOrganization(home.id), 0);
  assert.equal(paddle.calls.length, before);
  assert.deepEqual(stops(), []);
});

test('a stop that fails waits for the sweep; one already scheduled at Paddle counts; one that ended is closed', async (t) => {
  const { billing, organizations, people, paddle, subscribe, stops, logs, database } = withBilling(t);
  const home = organizations.create({ name: 'Home', kind: 'family', ownerId: people.ada });
  subscribe(home.id);
  paddle.state.refuse = { status: 503, code: 'internal_error' };
  assert.deepEqual(await billing.stopOrganization(home.id), { requested: 0, waiting: 1 });
  assert.match(logs.at(-1), /could not be stopped yet, tried again later/);
  assert.deepEqual(stops(), [`stop:organization:${home.id}:sub_01home pending`]);

  // Paddle refuses a second cancellation while one is scheduled (cancelled in the portal, or an answer lost).
  paddle.state.refuse = { status: 400, code: 'subscription_locked_pending_changes' };
  paddle.state.subscription = { status: 'active', scheduled_change: { action: 'cancel', effective_at: '2027-10-01T10:00:00Z' } };
  assert.deepEqual(await billing.sendStops(), { requested: 1, waiting: 0 });
  assert.deepEqual(paddle.calls.slice(-2).map(([method, pathname]) => `${method} ${pathname}`),
    ['POST /subscriptions/sub_01home/cancel', 'GET /subscriptions/sub_01home']);
  assert.deepEqual(stops(), [`stop:organization:${home.id}:sub_01home requested`]);

  // Another change pending (a pause): it is not a cancellation, so it waits.
  const away = organizations.create({ name: 'Away', kind: 'family', ownerId: people.bob });
  subscribe(away.id, { id: 'evt_2', ref: 'sub_01away' });
  paddle.state.subscription = { status: 'active', scheduled_change: { action: 'pause' } };
  assert.deepEqual(await billing.stopOrganization(away.id), { requested: 0, waiting: 1 });

  // A sweep that never said how it went (the process ended) is taken again after a while.
  database.run("UPDATE billing_events SET outcome = 'sending' WHERE type = 'stop' AND outcome = 'pending'");
  paddle.state.refuse = null;
  assert.deepEqual(await billing.sendStops(), { requested: 0, waiting: 0 }, 'not yet: maybe still on its way');
  database.run("UPDATE billing_events SET received_at = '2026-01-01T00:00:00.000Z' WHERE type = 'stop' AND outcome = 'sending'");
  assert.deepEqual(await billing.sendStops(), { requested: 1, waiting: 0 });

  // One whose subscription ended before it was asked is closed without asking.
  const third = organizations.create({ name: 'Third', kind: 'family', ownerId: people.eve });
  subscribe(third.id, { id: 'evt_3', ref: 'sub_01third' });
  paddle.state.refuse = { status: 503, code: 'internal_error' };
  await billing.stopOrganization(third.id);
  subscribe(third.id, { id: 'evt_4', ref: 'sub_01third', status: 'canceled', at: '2026-10-02T10:00:00Z' });
  const before = paddle.calls.length;
  assert.deepEqual(await billing.sendStops(), { requested: 0, waiting: 0 });
  assert.equal(paddle.calls.length, before);
  assert.ok(stops().includes(`stop:organization:${third.id}:sub_01third ended`));
});

test('events for a group deleted here are gone: nothing granted or linked, no 500, the kept row follows', async (t) => {
  const { billing, organizations, people, subscribe, database, stops, paddle } = withBilling(t);
  const home = organizations.create({ name: 'Home', kind: 'family', ownerId: people.ada });
  subscribe(home.id);
  paddle.state.refuse = { status: 503, code: 'internal_error' };
  await billing.stopOrganization(home.id);
  organizations.remove(home.id);
  assert.equal(count(database, 'SELECT COUNT(*) AS n FROM entitlement_grants'), 0, 'its grants went with it');

  // Its renewal, and its end: before, each failed at the audit's reference to the group.
  assert.equal(subscribe(home.id, { id: 'evt_2', at: '2026-11-01T10:00:00Z' }), 'gone');
  assert.equal(count(database, 'SELECT COUNT(*) AS n FROM entitlement_grants'), 0);
  assert.equal(subscribe(home.id, { id: 'evt_3', status: 'canceled', at: '2027-10-01T10:00:01Z' }), 'gone');
  assert.equal(database.get("SELECT status FROM billing_subscriptions WHERE ref = 'sub_01home'").status, 'canceled', 'the kept row follows');
  assert.deepEqual(stops(), [`stop:organization:${home.id}:sub_01home ended`], 'nothing left to stop');
  assert.deepEqual(database.all("SELECT outcome FROM billing_events WHERE type = 'subscription' ORDER BY event_id").map((r) => r.outcome),
    ['granted', 'gone', 'gone']);
  // A subject that was never here, the same.
  assert.equal(subscribe(999, { id: 'evt_9', ref: 'sub_09' }), 'gone');
  assert.equal(count(database, "SELECT COUNT(*) AS n FROM billing_customers WHERE subject_type = 'organization' AND subject_id = 999"), 0);
});

test('Stripe stops a subscription at the period’s end, takes it back, ends it now, and counts one already canceled', async (t) => {
  const calls = [];
  let canceled = false;
  const fetch = async (url, init) => {
    calls.push([init.method, new URL(url).pathname, init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null]);
    if (canceled && init.method !== 'GET') return { ok: false, status: 400, json: async () => ({ error: { message: 'canceled' } }) };
    return { ok: true, status: 200, json: async () => ({ id: 'sub_1', status: canceled ? 'canceled' : 'active' }) };
  };
  const stripe = stripeProvider({ secretKey: 'sk_test_1', webhookSecret: 'whsec_1', fetch, log: () => {} });
  await stripe.cancelSubscription('sub_1');
  await stripe.keepSubscription('sub_1');
  await stripe.cancelSubscription('sub_1', { now: true });
  assert.deepEqual(calls, [
    ['POST', '/v1/subscriptions/sub_1', { cancel_at_period_end: 'true' }],
    ['POST', '/v1/subscriptions/sub_1', { cancel_at_period_end: 'false' }],
    ['DELETE', '/v1/subscriptions/sub_1', null],
  ]);
  canceled = true;
  await stripe.cancelSubscription('sub_1');
  assert.deepEqual(calls.at(-1), ['GET', '/v1/subscriptions/sub_1', null], 'read, and already so');

  const { billing, organizations, people, subscribe } = withBilling(t, { provider: stripeProvider({ secretKey: 'sk_test_1', webhookSecret: 'whsec_1', fetch, log: () => {} }) });
  canceled = false;
  const home = organizations.create({ name: 'Home', kind: 'family', ownerId: people.ada });
  subscribe(home.id);
  assert.deepEqual(await billing.stopOrganization(home.id), { requested: 1, waiting: 0 });
});

/* ------------------------- createSuite, end to end ------------------------- */

/** Paddle's API as a local server, for createSuite's provider (PADDLE_API_BASE). */
async function paddleServer(t) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push([req.method, req.url, body ? JSON.parse(body) : null]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { id: req.url.split('/')[2] } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, url: `http://127.0.0.1:${server.address().port}` };
}

async function familySuite(t, { billing = {}, hooks = {} } = {}) {
  const api = await paddleServer(t);
  const { suite, base } = await serve(t, {
    product: { modules: { organizations: true, billing: true }, plans: PLANS, products: PRODUCTS, billing },
    env: {
      BILLING_PROVIDER: 'paddle', PADDLE_API_KEY: 'pdl_sdbx_apikey_test', PADDLE_WEBHOOK_SECRET: SECRET, PADDLE_ENV: 'sandbox',
      PADDLE_API_BASE: api.url,
    },
    hooks,
  });
  /** A Paddle notification about the family's subscription, signed, through the webhook. */
  const notify = async (id, organizationId, {
    status = 'active', type = 'subscription.created', sub = 'sub_01home', customer = 'ctm_01home',
  } = {}) => {
    const body = JSON.stringify({
      event_id: id, event_type: type, occurred_at: new Date().toISOString(),
      data: {
        id: sub, status, customer_id: customer,
        items: [{ quantity: 1, price: { id: PRICE, product_id: 'pro_01' } }],
        current_billing_period: { starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 365 * DAY).toISOString() },
        custom_data: { subject: `organization:${organizationId}`, product: 'family-yearly' },
      },
    });
    const res = await fetch(`${base}/api/billing/webhook`, {
      method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Paddle-Signature': signPaddlePayload(SECRET, body) },
    });
    return { status: res.status, outcomes: (await res.json()).outcomes };
  };
  /** Until `calls` requests sent after the deletion's transaction reached the stand-in; with none, a while. */
  const settle = async (calls = 0) => {
    const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
    for (const until = Date.now() + 5000; api.calls.length < calls && Date.now() < until;) await sleep(20);
    if (!calls) await sleep(150);
  };
  const family = (owner = 'ada') => {
    const user = suite.accounts.create({ username: owner, password: `${owner}-password` });
    return { user, home: suite.organizations.create({ name: 'Home', kind: 'family', ownerId: user.id }) };
  };
  return { suite, api, notify, settle, family };
}

test('createSuite: the last adult’s account goes, the family is deleted and its subscription stops renewing, once', async (t) => {
  const deleted = [];
  const { suite, api, notify, settle, family } = await familySuite(t, {
    billing: { stopOnOrganizationDeleted: true },
    hooks: { onOrganizationDeleted: ({ organization }) => deleted.push(organization.id) },
  });
  const { user, home } = family();
  assert.deepEqual((await notify('evt_1', home.id)).outcomes, ['granted']);
  assert.equal(suite.entitlements.grantsOf('organization', home.id).length, 1);

  suite.accounts.remove(user.id);
  assert.equal(suite.organizations.exists(home.id), false, 'deleted, not archived');
  assert.deepEqual(deleted, [home.id], 'the app’s hook first');
  await settle(1);
  assert.deepEqual(api.calls, [['POST', '/subscriptions/sub_01home/cancel', { effective_from: 'next_billing_period' }]]);
  // Paddle answers the cancellation through the webhook: the family is gone, so nothing is granted again.
  assert.deepEqual((await notify('evt_2', home.id, { type: 'subscription.updated' })), { status: 200, outcomes: ['gone'] });
  assert.equal(suite.entitlements.grantsOf('organization', home.id).length, 0);
  assert.deepEqual((await suite.billing.sendStops()), { requested: 0, waiting: 0 });
  assert.equal(api.calls.length, 1, 'asked once');
  assert.equal(suite.audit.list({ action: 'billing.organization.stop' })[0].organization_id, null, 'named by id only');
  // The billing rows stay without forgetOnRemove, as a person's do.
  assert.equal(suite.database.get("SELECT COUNT(*) AS n FROM billing_subscriptions WHERE subject_type = 'organization'").n, 1);
});

test('createSuite: a deletion undone asks nothing; without the option nothing is asked; forgetOnRemove lets the rows go', async (t) => {
  let refuse = true;
  const strict = await familySuite(t, { billing: { stopOnOrganizationDeleted: true, forgetOnRemove: true } });
  const ada = strict.family('ada');
  await strict.notify('evt_1', ada.home.id);
  // A hook that runs after the family was deleted and its stop marked refuses: everything is undone,
  // the mark too, so the stop sent after the transaction finds nothing to ask.
  strict.suite.accounts.whenRemoved(() => { if (refuse) throw new Error('not now'); });
  assert.throws(() => strict.suite.accounts.remove(ada.user.id), /not now/);
  assert.equal(strict.suite.organizations.exists(ada.home.id), true);
  assert.equal(strict.suite.entitlements.grantsOf('organization', ada.home.id).length, 1);
  await strict.settle();
  assert.deepEqual(strict.api.calls, []);
  assert.equal(strict.suite.database.get("SELECT COUNT(*) AS n FROM billing_events WHERE type = 'stop'").n, 0);
  refuse = false;
  strict.suite.accounts.remove(ada.user.id);
  await strict.settle(1);
  assert.equal(strict.api.calls.length, 1);
  assert.deepEqual(['billing_subscriptions', 'billing_customers'].map((table) =>
    strict.suite.database.get(`SELECT COUNT(*) AS n FROM ${table} WHERE subject_type = 'organization'`).n), [0, 0],
  'its billing links went, as a person’s do');

  const loose = await familySuite(t);
  const bob = loose.family('bob');
  await loose.notify('evt_1', bob.home.id);
  loose.suite.accounts.remove(bob.user.id);
  assert.equal(loose.suite.organizations.exists(bob.home.id), false);
  await loose.settle();
  assert.deepEqual(loose.api.calls, [], 'today’s installs ask Paddle nothing');
  assert.deepEqual((await loose.notify('evt_2', bob.home.id, { type: 'subscription.updated' })).outcomes, ['gone']);
});

test('createSuite: the only adult asks to delete their account: the family stops renewing then, renews if they come back, once', async (t) => {
  const asked = [];
  const { suite, api, notify, settle, family } = await familySuite(t, {
    billing: { stopOnOrganizationDeleted: true },
    hooks: { onDeletionRequested: (user) => asked.push(['requested', user.id]), onDeletionCancelled: (user) => asked.push(['cancelled', user.id]) },
  });
  const { user, home } = family('ada');
  await notify('evt_1', home.id);
  // A family with two adults doesn't go with either: asking stops nothing.
  const shared = family('bob');
  const eve = suite.accounts.create({ username: 'eve', password: 'eve-password' });
  suite.organizations.addMember(shared.home.id, eve.id, 'admin');
  await notify('evt_2', shared.home.id, { sub: 'sub_01shared', customer: 'ctm_01shared' });

  await suite.deletion.request(suite.accounts.byId(eve.id));
  assert.deepEqual(api.calls, [], 'Bob is still there');

  await suite.deletion.request(suite.accounts.byId(user.id));
  assert.deepEqual(api.calls, [['POST', '/subscriptions/sub_01home/cancel', { effective_from: 'next_billing_period' }]],
    'at the request, not thirty days later: no renewal falls in the wait');
  assert.equal(suite.organizations.exists(home.id), true, 'the family waits with the account');

  // Taken back within the days: it renews again.
  await suite.deletion.restore(suite.deletion.ticketFor(user.id));
  assert.deepEqual(api.calls.at(-1), ['PATCH', '/subscriptions/sub_01home', { scheduled_change: null }]);
  assert.equal(suite.database.get("SELECT COUNT(*) AS n FROM billing_events WHERE type = 'stop'").n, 0);

  // Asked again and left to go: the deletion finds the stop already asked, and asks nothing more.
  await suite.deletion.request(suite.accounts.byId(user.id));
  assert.equal(api.calls.length, 3);
  suite.database.run("UPDATE users SET delete_after = '2026-01-01T00:00:00.000Z' WHERE id = ?", user.id);
  assert.equal(await suite.deletion.sweep(), 1);
  assert.equal(suite.organizations.exists(home.id), false);
  await settle();
  assert.equal(api.calls.length, 3, 'no second cancellation');
  assert.deepEqual(asked, [['requested', eve.id], ['requested', user.id], ['cancelled', user.id], ['requested', user.id]],
    'the app hears each request and each taking back');
});

test('createSuite: without stopOnOrganizationDeleted, asking to delete an account asks Paddle nothing', async (t) => {
  const { suite, api, notify, family } = await familySuite(t);
  const { user, home } = family('ada');
  await notify('evt_1', home.id);
  await suite.deletion.request(suite.accounts.byId(user.id));
  await suite.deletion.restore(suite.deletion.ticketFor(user.id));
  assert.deepEqual(api.calls, []);
});

/* ------------------------- who pays: a person or a group ------------------------- */

test('one customer pays a person’s plan and their family’s: each purchase goes where it is for, in either order', (t) => {
  const PERSONAL = 'pri_01m46hn0personalpersonal0y';
  const products = { ...PRODUCTS, 'pro-yearly': { plan: 'pro', kind: 'subscription', price: PERSONAL } };
  const ADA = 'user_01JADA0000000000000000000A';
  const make = () => {
    const base = setup(t, { kinds: FAMILY });
    const { database, audit, organizations, people } = base;
    const entitlements = createEntitlements({ database, appId: 'test', features: {}, plans: PLANS, plansJson: null, defaultPlanOverride: null });
    const billing = createBilling({
      database, entitlements, audit, products, log: () => {},
      identities: { of: () => null, user: (provider, subject) => (subject === ADA ? people.ada : null) },
      organizationGone: (id) => !organizations.exists(id),
    });
    const home = organizations.create({ name: 'Home', kind: 'family', ownerId: people.ada });
    let n = 0;
    const event = (fields) => {
      n += 1;
      return billing.apply({
        id: `evt_${n}`, type: 'subscription', occurredAt: `2026-10-${String(n).padStart(2, '0')}T10:00:00Z`, customer: 'ctm_shared',
        status: 'active', periodEnd: '2027-10-01T10:00:00Z', ...fields,
      });
    };
    const grants = () => ({
      ada: entitlements.grantsOf('user', people.ada).filter((g) => !g.revoked_at).map((g) => g.note),
      home: entitlements.grantsOf('organization', home.id).filter((g) => !g.revoked_at).map((g) => g.note),
    });
    return { ...base, billing, home, event, grants };
  };
  const family = (home) => ({ type: 'organization', id: home.id });

  // The person's own first: the customer is linked to them, and the family's purchase still goes to the family.
  const first = make();
  assert.equal(first.event({ ref: 'sub_ada', product: 'pro-yearly', identity: { provider: 'workos', subject: ADA } }), 'granted');
  assert.equal(first.billing.customerOf({ type: 'user', id: first.people.ada }), 'ctm_shared');
  assert.equal(first.event({ ref: 'sub_home', product: 'family-yearly', subject: family(first.home) }), 'granted');
  assert.equal(first.event({ ref: 'sub_home', product: 'family-yearly', subject: family(first.home), periodEnd: '2028-10-01T10:00:00Z' }),
    'extended', 'its renewal too');
  assert.deepEqual(first.grants(), { ada: ['pro-yearly'], home: ['family-yearly'] }, 'before, both went to Ada');
  // A group's product that names no group, paid by a person's customer, is nobody's here: never the person's.
  assert.equal(first.event({ ref: 'sub_odd', product: 'family-yearly' }), 'ignored');
  // An identity on a group's purchase doesn't make it the person's either.
  assert.equal(first.event({ ref: 'sub_home2', product: 'family-yearly', subject: family(first.home), identity: { provider: 'workos', subject: ADA } }),
    'granted');
  assert.deepEqual(first.grants().ada, ['pro-yearly']);

  // The family's first: the customer is linked to it, and the person's own purchases still go to them.
  const second = make();
  assert.equal(second.event({ ref: 'sub_home', product: 'family-yearly', subject: family(second.home) }), 'granted');
  assert.equal(second.billing.customerOf({ type: 'organization', id: second.home.id }), 'ctm_shared');
  assert.equal(second.event({ ref: 'sub_ada', product: 'pro-yearly', subject: { type: 'user', id: second.people.ada } }), 'granted');
  // A group's renewal that names no group still finds it by its customer.
  assert.equal(second.event({ ref: 'sub_home', product: 'family-yearly', periodEnd: '2028-10-01T10:00:00Z' }), 'extended');
  assert.equal(second.event({ ref: 'sub_ada2', product: 'pro-yearly', identity: { provider: 'workos', subject: ADA } }), 'granted');
  assert.deepEqual(second.grants(), { ada: ['pro-yearly', 'pro-yearly'], home: ['family-yearly'] }, 'before, the first went to the family');
});
