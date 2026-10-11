/**
 * Organizations: groups, roles, invitations, seats, and what happens to the
 * groups of whoever goes.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { createAccounts } from '../accounts.js';
import { createOrganizations } from '../organizations.js';
import { createEntitlements } from '../entitlements.js';
import { resolveConfig } from '../config.js';
import { createSuite } from '../app.js';

const DAY = 24 * 3600 * 1000;

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-organizations-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const accounts = createAccounts({ database });
  const people = Object.fromEntries(['root', 'ada', 'bob', 'eve', 'dan'].map((name) =>
    [name, accounts.create({ username: name, role: name === 'root' ? 'admin' : 'user' }).id]));
  const organizations = createOrganizations({ database, roles: ['owner', 'admin', 'member', 'monitor'], ...options });
  accounts.whenRemoved((id) => organizations.forgetUser(id));
  return { database, accounts, organizations, people };
}

const code = (fn) => { try { fn(); } catch (err) { return `${err.status} ${err.code}`; } return 'ok'; };

test('a group: its slug, its owner, and the roles in order of power', (t) => {
  const { organizations, people } = setup(t);
  const home = organizations.create({ name: 'Casa Andersén', kind: 'household', ownerId: people.ada });
  assert.equal(home.slug, 'casa-andersen');
  assert.equal(organizations.create({ name: 'Casa  Andersen!', ownerId: people.bob }).slug, 'casa-andersen-2');
  assert.equal(organizations.create({ name: '¿¿??' }).slug, 'group');
  assert.equal(code(() => organizations.create({ name: '  ' })), '400 field_required');

  organizations.addMember(home.id, people.bob, 'admin');
  organizations.addMember(home.id, people.eve, 'monitor');
  assert.equal(organizations.requireRole(home.id, people.ada, 'owner'), 'owner');
  assert.equal(organizations.requireRole(home.id, people.bob, 'admin'), 'admin');
  assert.equal(organizations.requireRole(home.id, people.eve, 'member'), 'monitor', 'an app role ranks as a member');
  assert.equal(code(() => organizations.requireRole(home.id, people.eve, 'admin')), '403 organization_role');
  assert.equal(code(() => organizations.requireRole(home.id, people.dan)), '404 organization_not_found', 'outsiders don’t see it');
  assert.equal(code(() => organizations.addMember(home.id, people.bob)), '409 already_member');
  assert.equal(code(() => organizations.addMember(home.id, people.dan, 'king')), '400 field_invalid');

  assert.deepEqual(organizations.ofUser(people.bob).map((o) => [o.slug, o.role]).sort(),
    [['casa-andersen', 'admin'], ['casa-andersen-2', 'owner']]);
  assert.deepEqual(organizations.organizationsOf({ id: people.eve }), [home.id]);
  assert.deepEqual(organizations.membersOf(home.id).map((m) => m.username), ['ada', 'bob', 'eve']);
  assert.equal(organizations.list().find((o) => o.id === home.id).members, 3);

  organizations.update(home.id, { name: 'The Andersens', settings: { weekStart: 1 } });
  assert.equal(organizations.get(home.id).name, 'The Andersens');
  assert.equal(organizations.get(home.id).slug, 'casa-andersen', 'the slug stays: links keep working');
  assert.equal(organizations.get(home.id).settings, '{"weekStart":1}');
});

test('a group never loses its last owner', (t) => {
  const { organizations, people } = setup(t);
  const team = organizations.create({ name: 'Team', ownerId: people.ada });
  organizations.addMember(team.id, people.bob);
  assert.equal(code(() => organizations.setRole(team.id, people.ada, 'admin')), '409 last_owner');
  assert.equal(code(() => organizations.removeMember(team.id, people.ada)), '409 last_owner');
  organizations.setRole(team.id, people.bob, 'owner');
  organizations.removeMember(team.id, people.ada);
  assert.equal(organizations.roleOf(team.id, people.ada), null);
  assert.equal(code(() => organizations.removeMember(team.id, people.ada)), '404 member_not_found');
});

test('invitations: once, before they expire, unless revoked; only the hash is kept', (t) => {
  let now = Date.parse('2026-05-01T10:00:00Z');
  const { database, organizations, people } = setup(t, { clock: () => now });
  const home = organizations.create({ name: 'Home', ownerId: people.ada });

  const { token, invitation } = organizations.invite(home.id, { role: 'admin', email: 'Bob@Example.com', invitedBy: people.ada });
  assert.match(token, /^inv_/);
  assert.equal(invitation.email, 'bob@example.com');
  assert.equal(invitation.expires_at, '2026-05-08T10:00:00.000Z');
  assert.equal(database.get('SELECT COUNT(*) AS n FROM invitations WHERE token_hash = ?', token).n, 0, 'never in clear');

  assert.equal(organizations.accept(token, people.bob).id, home.id);
  assert.equal(organizations.roleOf(home.id, people.bob), 'admin');
  assert.equal(code(() => organizations.accept(token, people.eve)), '404 invitation_invalid', 'used once');
  assert.equal(code(() => organizations.accept('inv_made-up', people.eve)), '404 invitation_invalid');

  const late = organizations.invite(home.id);
  now += 8 * DAY;
  assert.equal(code(() => organizations.accept(late.token, people.eve)), '410 invitation_expired');

  const revoked = organizations.invite(home.id);
  assert.equal(organizations.revokeInvitation(home.id, revoked.invitation.id), true);
  assert.equal(organizations.revokeInvitation(home.id, revoked.invitation.id), false);
  assert.equal(code(() => organizations.accept(revoked.token, people.eve)), '404 invitation_invalid');
  assert.equal(organizations.invitationsOf(home.id).length, 3);
  assert.equal(organizations.invitationsOf(home.id)[0].token_hash, undefined);
});

test('seats: a grant with a quantity on the group caps its members', (t) => {
  let entitlements;
  const { database, organizations, people } = setup(t, { seatsOf: (id) => entitlements.seatsOf(id) });
  entitlements = createEntitlements({
    database, appId: 'test', features: { 'lists.max': { type: 'limit', default: null } },
    plans: { free: { name: 'Free', features: {} }, family: { name: 'Family', features: {} } },
    plansJson: null, defaultPlanOverride: null,
  });
  const home = organizations.create({ name: 'Home', ownerId: people.ada });
  organizations.addMember(home.id, people.bob);
  organizations.addMember(home.id, people.eve);
  assert.equal(entitlements.seatsOf(home.id), null, 'no grant with a quantity: no cap');

  const grant = entitlements.grant({ subjectType: 'organization', subjectId: home.id, plan: 'family', quantity: 3 });
  assert.equal(entitlements.seatsOf(home.id), 3);
  assert.equal(code(() => organizations.addMember(home.id, people.dan)), '402 seats_full');
  const { token } = organizations.invite(home.id);
  assert.equal(code(() => organizations.accept(token, people.dan)), '402 seats_full');

  entitlements.revoke({ id: grant });
  assert.equal(code(() => organizations.accept(token, people.dan)), 'ok', 'the invitation still works once there is room');
  assert.equal(organizations.seatsTaken(home.id), 4, 'without seatRoles every member takes a seat');
  assert.equal(organizations.takesSeat('admin'), true);
  organizations.setRole(home.id, people.bob, 'admin');
  entitlements.grant({ subjectType: 'organization', subjectId: home.id, plan: 'family', quantity: 4 });
  organizations.setRole(home.id, people.bob, 'member');
  assert.equal(organizations.roleOf(home.id, people.bob), 'member', 'a role change takes no seat: the person had one');
});

test('seats by role: only the roles named take a seat (Tracker pays per driver)', (t) => {
  let entitlements;
  const { database, organizations, people } = setup(t, {
    roles: ['owner', 'admin', 'member', 'driver'], seatRoles: ['driver'], seatsOf: (id) => entitlements.seatsOf(id),
  });
  entitlements = createEntitlements({
    database, appId: 'tracker', features: {},
    plans: { free: { name: 'Free', features: {} }, org: { name: 'Fleet', features: {} } }, plansJson: null, defaultPlanOverride: null,
  });
  const school = organizations.create({ name: 'School', ownerId: people.ada });
  entitlements.grant({ subjectType: 'organization', subjectId: school.id, plan: 'org', quantity: 2, source: 'paddle', externalRef: 'sub_1' });
  assert.equal(organizations.takesSeat('driver'), true);
  assert.equal(organizations.takesSeat('owner'), false);
  assert.equal(organizations.takesSeat('member'), false);
  assert.equal(organizations.seatsTaken(school.id), 0, 'the owner takes no seat');

  organizations.addMember(school.id, people.bob, 'driver');
  organizations.addMember(school.id, people.eve, 'driver');
  assert.equal(organizations.seatsTaken(school.id), 2);
  assert.equal(code(() => organizations.addMember(school.id, people.dan, 'driver')), '402 seats_full');
  assert.deepEqual((() => { try { organizations.addMember(school.id, people.dan, 'driver'); } catch (err) { return err.extra; } })(), { seats: 2 });

  // Admins and viewers are free: they join whatever the seats.
  const viewer = organizations.invite(school.id, { role: 'member' });
  assert.equal(organizations.accept(viewer.token, people.dan).id, school.id);
  const driver = organizations.invite(school.id, { role: 'driver' });
  assert.equal(code(() => organizations.accept(driver.token, people.root)), '402 seats_full', 'a driver’s invitation needs a seat');
  organizations.addMember(school.id, people.root, 'admin');
  assert.equal(organizations.membersOf(school.id).length, 5);
  assert.equal(organizations.seatsTaken(school.id), 2);

  // Making a viewer a driver takes a seat, as joining as one does; the refusal changes nothing.
  assert.equal(code(() => organizations.setRole(school.id, people.dan, 'driver')), '402 seats_full');
  assert.equal(organizations.roleOf(school.id, people.dan), 'member');
  organizations.setRole(school.id, people.eve, 'member');   // a driver who stops driving frees theirs
  assert.equal(organizations.seatsTaken(school.id), 1);
  organizations.setRole(school.id, people.dan, 'driver');
  organizations.setRole(school.id, people.bob, 'driver');   // already one: nothing to check
  organizations.removeMember(school.id, people.bob);
  assert.equal(organizations.seatsTaken(school.id), 1, 'whoever leaves frees theirs');
  assert.equal(code(() => organizations.accept(driver.token, people.bob)), 'ok');
  assert.equal(organizations.seatsTaken(school.id), 2);

  // Fewer seats bought takes nobody's away: past the cap, no one more drives.
  entitlements.revoke({ source: 'paddle', externalRef: 'sub_1' });
  entitlements.grant({ subjectType: 'organization', subjectId: school.id, plan: 'org', quantity: 1, source: 'paddle', externalRef: 'sub_1' });
  assert.equal(organizations.seatsTaken(school.id), 2);
  assert.equal(code(() => organizations.setRole(school.id, people.eve, 'driver')), '402 seats_full');

  // The roles that take a seat are some of the group's roles, never none.
  for (const seatRoles of [['pilot'], [], 'driver']) {
    assert.throws(() => createOrganizations({ database, roles: ['owner', 'admin', 'member', 'driver'], seatRoles }), /seatRoles/);
  }
});

test('seats by role are counted per group: one fleet’s drivers never take another’s seats', (t) => {
  let entitlements;
  const { database, organizations, people } = setup(t, {
    roles: ['owner', 'admin', 'member', 'driver'], seatRoles: ['driver'], seatsOf: (id) => entitlements.seatsOf(id),
  });
  entitlements = createEntitlements({
    database, appId: 'tracker', features: {},
    plans: { free: { name: 'Free', features: {} }, org: { name: 'Fleet', features: {} } }, plansJson: null, defaultPlanOverride: null,
  });
  const north = organizations.create({ name: 'North', ownerId: people.ada });
  const south = organizations.create({ name: 'South', ownerId: people.root });
  entitlements.grant({ subjectType: 'organization', subjectId: north.id, plan: 'org', quantity: 2, source: 'paddle', externalRef: 'sub_n' });
  entitlements.grant({ subjectType: 'organization', subjectId: south.id, plan: 'org', quantity: 1, source: 'paddle', externalRef: 'sub_s' });

  organizations.addMember(south.id, people.bob, 'driver');
  assert.equal(code(() => organizations.addMember(south.id, people.eve, 'driver')), '402 seats_full', 'South is full');
  assert.deepEqual([organizations.seatsTaken(north.id), organizations.seatsTaken(south.id)], [0, 1],
    'South’s driver takes none of North’s seats');

  // A full South blocks nobody in North, not even someone who drives for South.
  organizations.addMember(north.id, people.eve, 'driver');
  organizations.addMember(north.id, people.bob, 'driver');
  assert.deepEqual([organizations.seatsTaken(north.id), organizations.seatsTaken(south.id)], [2, 1]);

  // A role change checks the seats of its own group only.
  organizations.addMember(north.id, people.dan, 'member');
  organizations.addMember(south.id, people.dan, 'member');
  assert.equal(code(() => organizations.setRole(north.id, people.dan, 'driver')), '402 seats_full');
  organizations.removeMember(south.id, people.bob);
  organizations.setRole(south.id, people.dan, 'driver');
  assert.equal(code(() => organizations.setRole(north.id, people.dan, 'driver')), '402 seats_full', 'North is still full');
  assert.deepEqual([organizations.seatsTaken(north.id), organizations.seatsTaken(south.id)], [2, 1]);
});

test('with seat roles, a group passes to someone outside them first: a driver made owner stops driving', (t) => {
  const { accounts, organizations, people } = setup(t, { roles: ['owner', 'admin', 'member', 'driver'], seatRoles: ['driver'] });
  const fleet = organizations.create({ name: 'Fleet', ownerId: people.ada });
  organizations.addMember(fleet.id, people.bob, 'driver');   // older than the viewer
  organizations.addMember(fleet.id, people.eve, 'member');
  const depot = organizations.create({ name: 'Depot', ownerId: people.ada });
  organizations.addMember(depot.id, people.bob, 'driver');
  organizations.addMember(depot.id, people.eve, 'member');
  organizations.addMember(depot.id, people.root, 'admin');
  const solo = organizations.create({ name: 'Solo', ownerId: people.ada });
  organizations.addMember(solo.id, people.dan, 'driver');

  accounts.remove(people.ada);
  assert.equal(organizations.roleOf(fleet.id, people.eve), 'owner', 'the viewer, not the older driver');
  assert.equal(organizations.roleOf(fleet.id, people.bob), 'driver');
  assert.equal(organizations.seatsTaken(fleet.id), 1, 'the driver keeps their seat');
  assert.equal(organizations.roleOf(depot.id, people.root), 'owner', 'an admin still comes first');
  assert.deepEqual([organizations.roleOf(depot.id, people.bob), organizations.roleOf(depot.id, people.eve)], ['driver', 'member']);
  assert.equal(organizations.roleOf(solo.id, people.dan), 'owner', 'a driver only when nobody else is left: the group keeps an owner');
  assert.equal(organizations.seatsTaken(solo.id), 0);
});

test('seatRoles in suite.config.js: checked on start and handed to the organizations', (t) => {
  const product = {
    app: { id: 'demo', name: 'Demo' }, modules: { organizations: true },
    organizations: { roles: ['owner', 'admin', 'member', 'driver'], seatRoles: ['driver'] },
  };
  const config = resolveConfig(product, { DATA_DIR: '/data' });
  assert.deepEqual(config.errors, []);
  assert.deepEqual(config.organizations.seatRoles, ['driver']);
  assert.equal(resolveConfig({ ...product, organizations: { roles: ['owner', 'admin', 'member'] } }, {}).organizations.seatRoles, null,
    'left out: every member takes a seat, as before');
  for (const seatRoles of [['pilot'], [], 'driver']) {
    assert.ok(resolveConfig({ ...product, organizations: { ...product.organizations, seatRoles } }, {}).errors
      .some((e) => e.startsWith('organizations.seatRoles:')), JSON.stringify(seatRoles));
  }
  // A misspelt key would put every member in a seat without a word: it stops the start instead.
  for (const key of ['seatRole', 'toString']) {
    const { errors } = resolveConfig({ ...product, organizations: { roles: product.organizations.roles, [key]: ['driver'] } }, {});
    assert.ok(errors.includes(`organizations.${key} is not a setting (roles, invitationDays, seatRoles)`), key);
  }
  assert.deepEqual(resolveConfig({ ...product, organizations: { ...product.organizations, invitationDays: 3 } }, { DATA_DIR: '/data' }).errors, []);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-organizations-'));
  const suite = createSuite({ config: product, env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1' }, log: () => {}, exitOnError: false });
  t.after(() => { suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(suite.organizations.takesSeat('driver'), true);
  assert.equal(suite.organizations.takesSeat('admin'), false);
});

test('whoever goes hands their groups over; a group left empty is archived', (t) => {
  const { accounts, organizations, people } = setup(t);
  const home = organizations.create({ name: 'Home', ownerId: people.ada });
  organizations.addMember(home.id, people.bob, 'member');
  organizations.addMember(home.id, people.eve, 'admin');
  const alone = organizations.create({ name: 'Just me', ownerId: people.ada });
  const shared = organizations.create({ name: 'Shared', ownerId: people.ada });
  organizations.addMember(shared.id, people.dan, 'owner');

  accounts.remove(people.ada);
  assert.equal(organizations.roleOf(home.id, people.eve), 'owner', 'the oldest admin first');
  assert.equal(organizations.roleOf(home.id, people.bob), 'member');
  assert.equal(organizations.get(alone.id), null, 'archived');
  assert.equal(organizations.roleOf(shared.id, people.dan), 'owner', 'another owner was there already');
  assert.equal(organizations.roleOf(home.id, people.ada), null);
});
