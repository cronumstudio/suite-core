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
