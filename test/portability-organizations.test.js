/**
 * Organizations in the copies of the data (portability.js): a family's tables,
 * which chain to its organization, in the copy of every adult in it; the whole
 * install's copy with every organization, its roles, the invitations still
 * waiting, its plans and who pays for them, so that a renewal still finds the
 * family; where an imported family goes; "replace" handing a shared family over
 * instead of emptying it; columns that never travel; and today's declarations,
 * which carry nothing of organizations.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSuite } from '../app.js';
import { openZip, createZipWriter } from '../zip.js';
import { describeData } from '../portability.js';
import { createBilling } from '../billing.js';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { runDataCli } from '../tools/data-cli.js';

const PRODUCT = {
  app: { id: 'fam', name: 'Fam', port: 3998, languages: ['en', 'es'] },
  modules: { live: true, organizations: true },
  accounts: { minPasswordLength: 8 },
  features: { 'routines.max': { type: 'limit', default: null, label: 'routines' } },
  plans: { free: { name: 'Free', features: { 'routines.max': 3 } }, pro: { name: 'Pro', features: {} } },
  defaultPlan: 'free',
};

/** A family app: a family per organization, its people (children without an account), routines, paired devices; and notes of one's own. */
const MIGRATIONS = [{
  version: 1,
  name: 'fam',
  up: (d) => d.exec(`
    CREATE TABLE fam_families (id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE, settings TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE fam_people (id INTEGER PRIMARY KEY AUTOINCREMENT, family_id INTEGER NOT NULL REFERENCES fam_families(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, name TEXT NOT NULL, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL);
    CREATE TABLE fam_routines (id INTEGER PRIMARY KEY AUTOINCREMENT, family_id INTEGER NOT NULL REFERENCES fam_families(id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES fam_people(id) ON DELETE CASCADE, name TEXT NOT NULL);
    CREATE TABLE fam_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, family_id INTEGER NOT NULL REFERENCES fam_families(id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES fam_people(id) ON DELETE CASCADE, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      push_endpoint TEXT, push_p256dh TEXT, push_auth TEXT, push_failures INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT);
    CREATE TABLE fam_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL);
  `),
}];

const left = [];
/** The app's declaration: the family chains to its organization, and the rest to the family. */
const DATA = {
  tables: {
    fam_families: { refs: { organization_id: 'organizations' } },
    fam_people: { refs: { family_id: 'fam_families', user_id: 'users' } },
    fam_routines: { refs: { family_id: 'fam_families', person_id: 'fam_people' } },
    fam_devices: {
      refs: { family_id: 'fam_families', person_id: 'fam_people' },
      // The key's hash can't be NULL: the device comes in unusable until it pairs again.
      omit: { token_hash: (row) => `unpaired-${row.person_id}-${Math.random().toString(36).slice(2)}`, push_endpoint: null, push_p256dh: null, push_auth: null, push_failures: null },
    },
    fam_notes: { refs: { user_id: 'users' } },
  },
  organizations: {
    kinds: ['family'],
    mapOntoOwn: ['family'],
    // The app's part of a hand-over: the adult's profile in that family loses its account.
    leave: (userId, organizationId) => left.push([userId, organizationId]),
  },
};

const SECRET_HASH = 'a'.repeat(64);
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/secret-endpoint';

function install(t, env = {}, declaration = DATA) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-orgdata-'));
  const suite = createSuite({
    config: PRODUCT, migrations: MIGRATIONS, log: () => {}, exitOnError: false,
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', ...env },
  });
  t.after(() => { suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const portability = suite.portabilityFor(declaration, { version: '1.0.0' });
  const events = [];
  const publish = suite.live.publish;
  suite.live.publish = (event) => { events.push(event); return publish(event); };
  return { dir, suite, portability, db: suite.database, organizations: suite.organizations, events };
}

/** A family in this install, with its adults' profiles, a child, a routine and a paired device. */
function family(box, { name, owner, members = [], child = 'Lia' }) {
  const { db, organizations } = box;
  const org = organizations.create({ name, kind: 'family', ownerId: owner.id });
  for (const [user, role] of members) organizations.addMember(org.id, user.id, role);
  const familyId = db.run('INSERT INTO fam_families (organization_id, settings) VALUES (?, ?)', org.id, '{"week":"mon"}').lastInsertRowid;
  for (const user of [owner, ...members.map(([u]) => u)]) {
    db.run("INSERT INTO fam_people (family_id, kind, name, user_id) VALUES (?, 'adult', ?, ?)", familyId, user.display_name, user.id);
  }
  const kid = db.run("INSERT INTO fam_people (family_id, kind, name) VALUES (?, 'child', ?)", familyId, child).lastInsertRowid;
  db.run("INSERT INTO fam_routines (family_id, person_id, name) VALUES (?, ?, 'Morning')", familyId, kid);
  db.run("INSERT INTO fam_routines (family_id, person_id, name) VALUES (?, ?, 'Bedtime')", familyId, kid);
  db.run(`INSERT INTO fam_devices (family_id, person_id, name, token_hash, push_endpoint, push_p256dh, push_auth, push_failures, last_seen_at)
    VALUES (?, ?, 'Tablet', ?, ?, 'p256dh-key', 'auth-key', 2, '2026-09-01T08:00:00.000Z')`, familyId, kid,
  `${SECRET_HASH.slice(0, 60)}${String(familyId).padStart(4, '0')}`, `${ENDPOINT}-${familyId}`);
  return { org, familyId, kid };
}

/**
 * The source: the Andersen family has two owners (ana, ben) and an admin (cleo), a pending
 * invitation, one used and one expired; a Pro plan paid at Paddle and a trial with an end. Ana
 * and Ben are also in a team (another kind, another app's). Each adult has notes of their own.
 */
function seedSource(box) {
  const { suite, db, organizations } = box;
  const make = (username, extra = {}) => suite.accounts.create({ username, displayName: username[0].toUpperCase() + username.slice(1), ...extra }, { quiet: true });
  const ana = make('ana', { email: 'ana@example.com', role: 'admin' });
  const ben = make('ben', { email: 'ben@example.com' });
  const cleo = make('cleo', { email: 'cleo@example.com' });
  const dan = make('dan', { email: 'dan@example.com' });
  const home = family(box, { name: 'Casa Andersen', owner: ana, members: [[ben, 'admin'], [cleo, 'admin']] });
  organizations.setRole(home.org.id, ben.id, 'owner');
  db.run("UPDATE organizations SET settings = '{\"timezone\":\"Europe/Madrid\"}', branding = '{\"color\":\"#ff8800\"}', created_at = '2026-03-04T05:06:07.890Z' WHERE id = ?", home.org.id);
  const team = organizations.create({ name: 'Work team', kind: 'team', ownerId: ana.id });
  organizations.addMember(team.id, ben.id, 'member');
  const archived = organizations.create({ name: 'Old club', kind: 'family', ownerId: dan.id });
  organizations.archive(archived.id);
  const pending = organizations.invite(home.org.id, { role: 'admin', email: 'Gran@Example.com', invitedBy: ana.id });
  const used = organizations.invite(home.org.id, { invitedBy: ana.id });
  organizations.accept(used.token, dan.id);
  organizations.removeMember(home.org.id, dan.id);
  const expired = organizations.invite(home.org.id, { invitedBy: ana.id, days: -1 });
  for (const [user, text] of [[ana, 'Ana’s own'], [ben, 'Ben’s own'], [cleo, 'Cleo’s own']]) {
    db.run('INSERT INTO fam_notes (user_id, text) VALUES (?, ?)', user.id, text);
  }
  const at = '2026-05-01T10:00:00.000Z';
  db.run(`INSERT INTO entitlement_grants (subject_type, subject_id, plan, source, external_ref, starts_at, ends_at, created_at)
    VALUES ('organization', ?, 'pro', 'paddle', 'sub_FAMILY', ?, '2027-05-04T10:00:00.000Z', ?)`, home.org.id, at, at);
  db.run(`INSERT INTO entitlement_grants (subject_type, subject_id, plan, source, starts_at, ends_at, created_at, note)
    VALUES ('organization', ?, 'pro', 'trial', '2026-03-04T05:06:07.890Z', '2026-03-18T05:06:07.890Z', ?, 'trial')`, home.org.id, at);
  db.run(`INSERT INTO billing_customers (subject_type, subject_id, provider, customer_id, created_at)
    VALUES ('organization', ?, 'paddle', 'ctm_FAMILY', ?)`, home.org.id, at);
  db.run(`INSERT INTO billing_subscriptions (provider, ref, subject_type, subject_id, product, status, period_end, occurred_at, updated_at)
    VALUES ('paddle', 'sub_FAMILY', 'organization', ?, 'family-yearly', 'active', '2027-05-01T10:00:00.000Z', ?, ?)`, home.org.id, at, at);
  return { ana, ben, cleo, dan, home, team, archived, pending, expired };
}

async function exportTo(box, file, options, portability = box.portability) {
  const job = portability.prepareExport(options);
  return job.write(fs.createWriteStream(file));
}

async function readZip(t, file) {
  const zip = await openZip(file);
  t.after(() => zip.close());
  const json = async (name) => JSON.parse((await zip.read(name)).toString('utf8'));
  return { zip, json };
}

const rejectsWith = (promise, code) => assert.rejects(promise, (err) => {
  assert.equal(err.code, code, `${err.code}: ${err.message} ${JSON.stringify(err.extra || {})}`);
  return true;
});
const count = (db, sql, ...params) => Number(db.get(`SELECT COUNT(*) AS n FROM ${sql}`, ...params).n);

/* -------------------------------- the declaration -------------------------------- */

test('a group’s tables, what organizations do in copies and the columns that never travel are checked at the start', () => {
  const database = openDatabase({ path: ':memory:' });
  MIGRATIONS[0].up(database);
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const model = describeData(database, DATA);
  assert.deepEqual(model.byName.get('fam_families').refs, [{ column: 'organization_id', target: 'organizations', required: true, deferred: false }]);
  assert.deepEqual([...model.byName.get('fam_devices').omit.keys()], ['token_hash', 'push_endpoint', 'push_p256dh', 'push_auth', 'push_failures']);
  assert.deepEqual([...model.organizations.kinds], ['family']);
  // A table that points at organizations carries them by itself; today's declarations carry none.
  assert.ok(describeData(database, { tables: { fam_families: { refs: { organization_id: 'organizations' } } } }).organizations);
  assert.equal(describeData(database, { tables: { fam_notes: { refs: { user_id: 'users' } } } }).organizations, null);
  assert.ok(describeData(database, { tables: {}, organizations: {} }).organizations, 'or the option alone, for the install’s copy');

  const fails = (declaration, pattern) => assert.throws(() => describeData(database, declaration), pattern);
  fails({ tables: { fam_devices: { refs: { family_id: 'fam_families' }, omit: ['token_hash'] }, fam_families: { refs: { organization_id: 'organizations' } } } },
    /fam_devices\.family_id points at fam_families/);
  fails({ tables: { fam_families: { refs: { organization_id: 'organizations' } }, fam_devices: { refs: { family_id: 'fam_families' }, omit: ['token_hash'] } } },
    /fam_devices\.omit: token_hash is NOT NULL without a default/);
  fails({ tables: { fam_families: { refs: { organization_id: 'organizations' } }, fam_devices: { refs: { family_id: 'fam_families' }, omit: ['family_id'] } } },
    /fam_devices\.omit: family_id is the key, a reference or a file's/);
  fails({ tables: { fam_families: { refs: { organization_id: 'organizations' } }, fam_devices: { refs: { family_id: 'fam_families' }, omit: ['nothing'] } } },
    /"nothing" is not a column/);
  fails({ tables: { fam_families: { refs: { organization_id: 'organizations' } }, fam_devices: { refs: { family_id: 'fam_families' }, omit: { token_hash: {} } } } },
    /a plain value or a function/);
  fails({ tables: {}, organizations: { kind: ['family'] } }, /organizations\.kind is not an option/);
  fails({ tables: {}, organizations: { kinds: ['family'], mapOntoOwn: ['team'] } }, /"team" is not one of organizations\.kinds/);
  fails({ tables: {}, organizations: { roles: [] } }, /organizations\.roles: a list of names/);
  fails({ tables: {}, organizations: { leave: 'yes' } }, /organizations\.leave: a function/);
  fails({ tables: { memberships: { refs: { user_id: 'users' } } }, organizations: {} }, /memberships: the suite's own table/);
  fails({ tables: { fam_people: { refs: { user_id: 'users', family_id: 'organizationz' } } } }, /"organizationz" is not one of the tables declared/);
  database.close();
});

test('a declaration that carries organizations needs the module, or the app doesn’t start', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-orgdata-'));
  const suite = createSuite({
    config: { ...PRODUCT, modules: { live: true } }, migrations: MIGRATIONS, log: () => {}, exitOnError: false,
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1' },
  });
  t.after(() => { suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => suite.portabilityFor(DATA), /modules\.organizations is off/);
  assert.doesNotThrow(() => suite.portabilityFor({ tables: { fam_notes: { refs: { user_id: 'users' } } } }));
});

/* --------------------------------- someone's copy --------------------------------- */

test('a second adult’s own copy carries the family: its name, their membership and every row of it, never what is omitted', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const file = path.join(source.dir, 'ben.zip');
  const manifest = await exportTo(source, file, { scope: 'account', userId: s.ben.id });
  const { zip, json } = await readZip(t, file);

  assert.equal(manifest.organizations, 1);
  const [org] = await json('data/organizations.json');
  assert.deepEqual({ ...org, id: undefined }, {
    id: undefined, slug: 'casa-andersen', name: 'Casa Andersen', kind: 'family', settings: '{"timezone":"Europe/Madrid"}',
    branding: '{"color":"#ff8800"}', created_at: '2026-03-04T05:06:07.890Z', archived_at: null,
  }, 'the family, not the team: another kind');
  assert.deepEqual((await json('data/memberships.json')).map((m) => [m.user_id, m.role]), [[s.ben.id, 'owner']], 'only his own membership');
  assert.deepEqual(manifest.tables, { fam_families: 1, fam_people: 4, fam_routines: 2, fam_devices: 1, fam_notes: 1 });
  const people = await json('data/fam_people.json');
  assert.deepEqual(people.map((p) => [p.name, p.user_id]), [['Ana', null], ['Ben', s.ben.id], ['Cleo', null], ['Lia', null]],
    'the other adults are in it, without their accounts');
  assert.deepEqual((await json('data/fam_notes.json')).map((n) => n.text), ['Ben’s own'], 'never another adult’s own data');
  const [device] = await json('data/fam_devices.json');
  assert.deepEqual(Object.keys(device).sort(), ['family_id', 'id', 'last_seen_at', 'name', 'person_id']);
  for (const name of zip.entries.map((e) => e.name)) {
    const text = (await zip.read(name)).toString('utf8');
    assert.ok(!text.includes(SECRET_HASH.slice(0, 60)) && !text.includes(ENDPOINT) && !text.includes('p256dh-key'), `${name}: no secret in it`);
  }
  assert.equal(zip.has('suite/invitations.json'), false, 'invitations are the install’s');
  assert.equal(zip.has('suite/grants.json'), false, 'and so are plans');

  // Cleo, an admin, gets the same family; with copies only for owners she wouldn't.
  const cleo = await exportTo(source, path.join(source.dir, 'cleo.zip'), { scope: 'account', userId: s.cleo.id });
  assert.equal(cleo.tables.fam_routines, 2);
  const owners = source.suite.portabilityFor({ ...DATA, organizations: { ...DATA.organizations, roles: ['owner'] } });
  const narrowed = await exportTo(source, path.join(source.dir, 'cleo-owners.zip'), { scope: 'account', userId: s.cleo.id }, owners);
  assert.equal(narrowed.organizations, undefined);
  assert.deepEqual(narrowed.tables, { fam_notes: 1 });
});

test('someone’s own copy makes the family theirs in a fresh install, as its owner, with new ids', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const file = path.join(source.dir, 'ben.zip');
  await exportTo(source, file, { scope: 'account', userId: s.ben.id });

  const target = install(t);
  // Ids taken here already: nothing of the copy lands on them.
  const zoe = target.suite.accounts.create({ username: 'zoe', displayName: 'Zoe' });
  family(target, { name: 'Zoe home', owner: zoe });
  const me = target.suite.accounts.create({ username: 'ben.cloud', displayName: 'Ben C' });

  const plan = await target.portability.planFile(file, { mode: 'account', user: me });
  assert.equal(plan.copy.organizations, 1);
  assert.deepEqual(plan.organizations, [{ source: { id: s.home.org.id, name: 'Casa Andersen', kind: 'family', members: 1 }, choice: { action: 'create' } }]);
  assert.deepEqual(plan.hand_over, []);

  const result = await target.portability.applyFile(file, { mode: 'account', user: me });
  assert.deepEqual(result.imported.organizations, { created: 1, mapped: 0 });
  const [{ organization_id: orgId, created }] = result.organizations;
  assert.equal(created, true);
  const org = target.db.get('SELECT * FROM organizations WHERE id = ?', orgId);
  assert.deepEqual([org.name, org.kind, org.slug, org.settings, org.branding], ['Casa Andersen', 'family', 'casa-andersen', '{"timezone":"Europe/Madrid"}', '{"color":"#ff8800"}']);
  assert.deepEqual(target.organizations.membersOf(orgId).map((m) => [m.username, m.role]), [['ben.cloud', 'owner']], 'theirs, the only member');
  const fam = target.db.get('SELECT * FROM fam_families WHERE organization_id = ?', orgId);
  assert.equal(fam.settings, '{"week":"mon"}');
  assert.deepEqual(target.db.all('SELECT name, user_id FROM fam_people WHERE family_id = ? ORDER BY id', fam.id).map((p) => [p.name, p.user_id]),
    [['Ana', null], ['Ben', me.id], ['Cleo', null], ['Lia', null]]);
  const kid = target.db.get("SELECT id FROM fam_people WHERE family_id = ? AND name = 'Lia'", fam.id).id;
  assert.deepEqual(target.db.all('SELECT name FROM fam_routines WHERE person_id = ? ORDER BY id', kid).map((r) => r.name), ['Morning', 'Bedtime']);
  const device = target.db.get('SELECT * FROM fam_devices WHERE family_id = ?', fam.id);
  assert.match(device.token_hash, new RegExp(`^unpaired-${kid}-`), 'what the app says an omitted column takes');
  assert.deepEqual([device.push_endpoint, device.push_p256dh, device.push_auth, device.push_failures], [null, null, null, 0],
    'or NULL, or the column’s default');
  assert.equal(device.last_seen_at, '2026-09-01T08:00:00.000Z', 'what isn’t omitted comes as it was');
  assert.equal(count(target.db, "entitlement_grants WHERE subject_type = 'organization'"), 0, 'a person’s copy brings no plan');
  assert.equal(count(target.db, 'fam_families'), 2, 'Zoe’s is still there');
});

test('a family of that kind they own or run here takes the copy (mapOntoOwn); an app that doesn’t say so gets a new one', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const file = path.join(source.dir, 'ben.zip');
  await exportTo(source, file, { scope: 'account', userId: s.ben.id });

  const target = install(t);
  const me = target.suite.accounts.create({ username: 'ben', displayName: 'Ben' });
  const other = target.suite.accounts.create({ username: 'oli', displayName: 'Oli' });
  // A family where he is only a member doesn't count; his own team, of another kind, neither.
  const theirs = target.organizations.create({ name: 'Oli home', kind: 'family', ownerId: other.id });
  target.organizations.addMember(theirs.id, me.id, 'member');
  target.organizations.create({ name: 'Ben team', kind: 'team', ownerId: me.id });
  const mine = target.organizations.create({ name: 'Ben home', kind: 'family', ownerId: me.id });
  // His family here holds nothing of the app yet: the copy's family row joins it.
  const plan = await target.portability.planFile(file, { mode: 'account', user: me });
  assert.deepEqual(plan.organizations[0].choice, { action: 'map', organization_id: mine.id, name: 'Ben home' });

  const result = await target.portability.applyFile(file, { mode: 'account', user: me });
  assert.deepEqual(result.imported.organizations, { created: 0, mapped: 1 });
  assert.equal(target.db.get('SELECT organization_id FROM fam_families').organization_id, mine.id);
  assert.equal(target.db.get('SELECT name FROM organizations WHERE id = ?', mine.id).name, 'Ben home', 'his family keeps its own name');
  assert.equal(count(target.db, 'organizations'), 3, 'no new one');
  assert.equal(count(target.db, 'fam_routines'), 2);

  const plain = install(t, {}, { ...DATA, organizations: { kinds: ['family'] } });
  const ben = plain.suite.accounts.create({ username: 'ben', displayName: 'Ben' });
  const own = plain.organizations.create({ name: 'Ben home', kind: 'family', ownerId: ben.id });
  const again = await plain.portability.applyFile(file, { mode: 'account', user: ben });
  assert.deepEqual(again.imported.organizations, { created: 1, mapped: 0 });
  assert.notEqual(again.organizations[0].organization_id, own.id);
});

test('“replace” hands a family others share over to them, whole, and empties only a family of one', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const file = path.join(source.dir, 'ben.zip');
  await exportTo(source, file, { scope: 'account', userId: s.ben.id });

  const target = install(t);
  const me = target.suite.accounts.create({ username: 'me', displayName: 'Me' });
  const partner = target.suite.accounts.create({ username: 'partner', displayName: 'Partner' });
  // A family they share, where they are the only owner and the partner an admin.
  const shared = family(target, { name: 'Shared home', owner: me, members: [[partner, 'admin']], child: 'Max' });
  target.db.run("INSERT INTO fam_notes (user_id, text) VALUES (?, 'mine'), (?, 'partner’s')", me.id, partner.id);
  const before = Object.fromEntries(['fam_people', 'fam_routines', 'fam_devices'].map((table) => [table, count(target.db, `${table} WHERE family_id = ?`, shared.familyId)]));

  const plan = await target.portability.planFile(file, { mode: 'account', user: me, replace: true });
  assert.deepEqual(plan.hand_over, [{ id: shared.org.id, name: 'Shared home', kind: 'family' }]);
  assert.deepEqual(plan.replace, { fam_notes: 1 }, 'what is theirs alone: never the shared family');
  assert.deepEqual(plan.organizations[0].choice, { action: 'create' }, 'a family they leave is no longer theirs to go into');

  left.length = 0;
  target.events.length = 0;
  const result = await target.portability.applyFile(file, { mode: 'account', user: me, replace: true });
  assert.deepEqual(left, [[me.id, shared.org.id]], 'the app’s part first');
  assert.deepEqual(result.handed_over, [{ organization_id: shared.org.id, name: 'Shared home', kind: 'family', user_id: me.id, heir: partner.id }]);
  assert.deepEqual(result.replaced, { fam_notes: 1 });
  assert.deepEqual(target.organizations.membersOf(shared.org.id).map((m) => [m.username, m.role]), [['partner', 'owner']],
    'the partner is its owner now: a family never loses its last owner');
  for (const [table, n] of Object.entries(before)) {
    assert.equal(count(target.db, `${table} WHERE family_id = ?`, shared.familyId), n, `${table}: the shared family is whole`);
  }
  assert.deepEqual(target.db.all('SELECT text FROM fam_notes ORDER BY id').map((n) => n.text), ['partner’s', 'Ben’s own']);
  const [{ organization_id: newOrg }] = result.organizations;
  assert.deepEqual(target.organizations.membersOf(newOrg).map((m) => [m.username, m.role]), [['me', 'owner']], 'the copy’s family is theirs');
  assert.ok(target.events.some((e) => e.event === 'resync' && e.audience === null), 'the partner’s tabs reload too');

  // A family of one: emptied, kept with its plan, and the copy goes into it.
  const solo = install(t);
  const alone = solo.suite.accounts.create({ username: 'alone', displayName: 'Alone' });
  const own = family(solo, { name: 'Just me', owner: alone, child: 'Kit' });
  solo.db.run("INSERT INTO entitlement_grants (subject_type, subject_id, plan, source, starts_at, created_at) VALUES ('organization', ?, 'pro', 'admin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')", own.org.id);
  const soloPlan = await solo.portability.planFile(file, { mode: 'account', user: alone, replace: true });
  assert.deepEqual(soloPlan.replace, { fam_families: 1, fam_people: 2, fam_routines: 2, fam_devices: 1 });
  assert.deepEqual(soloPlan.hand_over, []);
  const done = await solo.portability.applyFile(file, { mode: 'account', user: alone, replace: true });
  assert.deepEqual(done.imported.organizations, { created: 0, mapped: 1 });
  assert.equal(solo.db.get('SELECT organization_id FROM fam_families').organization_id, own.org.id);
  assert.equal(count(solo.db, "fam_people WHERE name = 'Kit'"), 0, 'what it had is gone');
  assert.equal(count(solo.db, "fam_people WHERE name = 'Lia'"), 1, 'the copy’s family is in it');
  assert.equal(count(solo.db, "entitlement_grants WHERE subject_type = 'organization' AND subject_id = ?", own.org.id), 1, 'its plan stays');
});

test('erasing one’s data leaves a family others share whole, and empties a family of one but keeps it', (t) => {
  const box = install(t);
  const s = seedSource(box);
  const solo = family(box, { name: 'Dan home', owner: s.dan, child: 'Rio' });
  const before = count(box.db, 'fam_routines WHERE family_id = ?', s.home.familyId);
  const { erased } = box.portability.erase(s.ben);
  assert.deepEqual(erased, { fam_notes: 1 });
  assert.equal(count(box.db, 'fam_routines WHERE family_id = ?', s.home.familyId), before, 'the shared family is whole');
  assert.equal(box.organizations.roleOf(s.home.org.id, s.ben.id), 'owner', 'and he is still in it');

  const gone = box.portability.erase(s.dan);
  assert.deepEqual(gone.erased, { fam_families: 1, fam_people: 2, fam_routines: 2, fam_devices: 1 });
  assert.equal(count(box.db, 'fam_families WHERE id = ?', solo.familyId), 0);
  assert.ok(box.organizations.get(solo.org.id), 'the organization stays, with its plan, to start again');
});

/* ------------------------------- the whole install ------------------------------- */

test('a whole install moves every family: its name, two owners and an admin, the invitation waiting, its Pro plan and who pays for it', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const file = path.join(source.dir, 'install.zip');
  const manifest = await exportTo(source, file, { scope: 'install' });
  assert.equal(manifest.organizations, 3);
  const { json, zip } = await readZip(t, file);
  const invitations = await json('suite/invitations.json');
  assert.deepEqual(invitations.map((i) => [i.email, i.role]), [['gran@example.com', 'admin']], 'only the one still waiting');
  assert.equal((await json('suite/grants.json')).filter((g) => g.subject_type === 'organization').length, 2);
  assert.ok(!(await zip.read('data/fam_devices.json')).toString('utf8').includes(ENDPOINT), 'an omitted column isn’t in the install’s copy either');

  // The target already has people: every id of the copy is someone else's here.
  const target = install(t);
  for (const name of ['xia', 'yan', 'zed']) target.suite.accounts.create({ username: name, displayName: name });
  target.organizations.create({ name: 'Somebody', kind: 'family', ownerId: target.suite.accounts.byUsername('xia').id });

  const plan = await target.portability.planFile(file, { mode: 'install' });
  assert.deepEqual(plan.organizations.map((o) => [o.source.name, o.source.members, o.choice.action]),
    [['Casa Andersen', 3, 'create'], ['Work team', 2, 'create'], ['Old club', 1, 'create']]);

  const result = await target.portability.applyFile(file, { mode: 'install' });
  assert.deepEqual(result.imported.organizations, { created: 3, mapped: 0 });
  assert.equal(result.imported.memberships, 6);
  assert.equal(result.imported.invitations, 1);
  assert.equal(result.imported.grants, 2);
  assert.equal(result.imported.billing, 2);

  const db = target.db;
  const id = (username) => target.suite.accounts.byUsername(username).id;
  const home = db.get("SELECT * FROM organizations WHERE name = 'Casa Andersen'");
  assert.notEqual(home.id, s.home.org.id, 'renumbered');
  assert.deepEqual([home.slug, home.kind, home.settings, home.branding, home.created_at, home.archived_at],
    ['casa-andersen', 'family', '{"timezone":"Europe/Madrid"}', '{"color":"#ff8800"}', '2026-03-04T05:06:07.890Z', null]);
  assert.deepEqual(target.organizations.membersOf(home.id).map((m) => [m.username, m.role]).sort(),
    [['ana', 'owner'], ['ben', 'owner'], ['cleo', 'admin']], 'two owners and an admin');
  assert.ok(db.get("SELECT archived_at FROM organizations WHERE name = 'Old club'").archived_at, 'an archived one stays archived');
  assert.equal(db.get('SELECT organization_id FROM fam_families WHERE organization_id = ?', home.id).organization_id, home.id);
  assert.equal(count(db, 'fam_people WHERE user_id IS NOT NULL'), 3);

  // The link Gran was sent opens the family here.
  const gran = target.suite.accounts.create({ username: 'gran', displayName: 'Gran' });
  assert.equal(target.organizations.accept(s.pending.token, gran.id).id, home.id);
  assert.equal(target.organizations.roleOf(home.id, gran.id), 'admin');
  assert.equal(db.get('SELECT invited_by FROM memberships WHERE user_id = ?', gran.id).invited_by, id('ana'));

  const grants = db.all("SELECT * FROM entitlement_grants WHERE subject_type = 'organization' ORDER BY id");
  assert.deepEqual(grants.map((g) => [g.subject_id, g.plan, g.source, g.external_ref, g.ends_at]), [
    [home.id, 'pro', 'paddle', 'sub_FAMILY', '2027-05-04T10:00:00.000Z'],
    [home.id, 'pro', 'trial', null, '2026-03-18T05:06:07.890Z'],
  ]);
  assert.deepEqual({ ...db.get("SELECT subject_type, subject_id FROM billing_customers WHERE customer_id = 'ctm_FAMILY'") },
    { subject_type: 'organization', subject_id: home.id });
  assert.deepEqual({ ...db.get("SELECT subject_type, subject_id, status FROM billing_subscriptions WHERE ref = 'sub_FAMILY'") },
    { subject_type: 'organization', subject_id: home.id, status: 'active' });

  // The renewal names the family's old id, someone else's here: the customer finds the family.
  const billing = createBilling({
    database: db, entitlements: target.suite.entitlements, log: () => {},
    provider: { id: 'paddle', checkoutUrl: async () => '', portalUrl: async () => '', parseWebhook: async () => null },
    products: { 'family-yearly': { plan: 'pro', kind: 'subscription', for: 'organization' } },
  });
  assert.equal(billing.apply({
    id: 'evt_renewal', type: 'subscription', occurredAt: '2027-05-01T10:00:00.000Z', subject: { type: 'organization', id: s.home.org.id },
    customer: 'ctm_FAMILY', ref: 'sub_FAMILY', product: 'family-yearly', status: 'active', periodEnd: '2028-05-01T10:00:00.000Z',
  }), 'extended');
  assert.equal(count(db, "entitlement_grants WHERE source = 'paddle' AND subject_id <> ?", home.id), 0);
  assert.ok(db.get("SELECT ends_at FROM entitlement_grants WHERE external_ref = 'sub_FAMILY'").ends_at > '2028-05-01');
});

test('another module’s copy of the same install finds its organizations here instead of making them twice', async (t) => {
  // The same install moving into a host one module at a time: the second copy brings the same groups.
  const NOTES = { tables: { fam_notes: { refs: { user_id: 'users' } } }, organizations: {} };
  const source = install(t);
  seedSource(source);
  const first = path.join(source.dir, 'fam.zip');
  const second = path.join(source.dir, 'notes.zip');
  await exportTo(source, first, { scope: 'install' });
  await exportTo(source, second, { scope: 'install' }, source.suite.portabilityFor(NOTES));

  const target = install(t);
  await target.portability.applyFile(first, { mode: 'install' });
  const notes = target.suite.portabilityFor(NOTES);
  const plan = await notes.planFile(second, { mode: 'install' });
  assert.deepEqual(plan.organizations.map((o) => o.choice.action), ['map', 'map', 'map']);
  const result = await notes.applyFile(second, { mode: 'install' });
  assert.deepEqual(result.imported.organizations, { created: 0, mapped: 3 });
  assert.deepEqual([result.imported.memberships, result.imported.invitations, result.imported.grants, result.imported.billing], [0, 0, 0, 0]);
  assert.equal(count(target.db, 'organizations'), 3);
  assert.equal(count(target.db, "entitlement_grants WHERE subject_type = 'organization'"), 2);
});

test('the command line shows where each organization goes, and brings them in', async (t) => {
  const source = install(t);
  seedSource(source);
  const file = path.join(source.dir, 'cli.zip');
  const out = [];
  const run = (box, ...argv) => runDataCli({ suite: box.suite, declaration: DATA, version: '1.0.0', argv, log: (line) => out.push(line), error: (line) => out.push(`ERR ${line}`) });
  assert.equal(await run(source, 'export', file), 0);
  assert.match(out.join('\n'), /organizations: 3/);
  const target = install(t);
  out.length = 0;
  assert.equal(await run(target, 'import', file, '--skip', 'dan'), 0);
  assert.match(out.join('\n'), /Organizations:\n {2}Casa Andersen \(family\), 3 member\(s\)\n {4}→ a new one/);
  assert.match(out.join('\n'), /Old club \(family\), 1 member\(s\)\n {4}→ left out/);
  out.length = 0;
  assert.equal(await run(target, 'import', file, '--skip', 'dan', '--apply'), 0);
  assert.match(out.join('\n'), /organizations: 2 new, 0 into one here; memberships 5; invitations 1/);
  // Dan, the only member of the old club, was left out: the group goes with him, as what is only his does.
  assert.equal(count(target.db, "organizations WHERE name = 'Old club'"), 0);
});

test('an account waiting to be deleted goes on waiting after a whole install’s move, until the same day', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const waiting = source.suite.accounts.requestDeletion(s.cleo.id, { days: 30 });
  assert.ok(waiting.delete_after);
  const file = path.join(source.dir, 'install.zip');
  await exportTo(source, file, { scope: 'install' });
  const { json } = await readZip(t, file);
  assert.equal((await json('data/users.json')).find((u) => u.username === 'cleo').delete_after, waiting.delete_after);

  const target = install(t);
  await target.portability.applyFile(file, { mode: 'install' });
  const cleo = target.suite.accounts.byUsername('cleo');
  assert.ok(cleo.disabled_at, 'still disabled');
  assert.equal(cleo.delete_after, waiting.delete_after, 'and still going on the same day');
  assert.equal(target.suite.accounts.byUsername('ben').delete_after, null);

  // A date alone, written into a copy by hand, never sends an active account to the sweep.
  const tampered = path.join(source.dir, 'tampered.zip');
  const zip = await openZip(file);
  const out = createZipWriter(fs.createWriteStream(tampered));
  for (const { name } of zip.entries) {
    let bytes = await zip.read(name);
    if (name === 'data/users.json') {
      bytes = Buffer.from(JSON.stringify(JSON.parse(bytes.toString('utf8')).map((u) => (u.username === 'ben' ? { ...u, delete_after: '2000-01-01T00:00:00.000Z' } : u))));
    }
    if (name === 'manifest.json') bytes = Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString('utf8')), id: 'tampered-copy-0000000' }));
    await out.add(name, bytes);
  }
  await out.finish();
  await zip.close();
  const other = install(t);
  await other.portability.applyFile(tampered, { mode: 'install' });
  assert.equal(other.suite.accounts.byUsername('ben').delete_after, null);
  assert.deepEqual(other.suite.accounts.dueForDeletion().map((u) => u.username), []);
});

/* ------------------------------- a copy isn't trusted ------------------------------ */

test('a crafted copy’s organizations reach nothing here: new ones, names cut, kinds checked, a ceiling on how many', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const file = path.join(source.dir, 'ben.zip');
  await exportTo(source, file, { scope: 'account', userId: s.ben.id });
  const target = install(t);
  const victim = target.suite.accounts.create({ username: 'victim', displayName: 'Victim' });
  const theirs = family(target, { name: 'Victim home', owner: victim });
  const me = target.suite.accounts.create({ username: 'me', displayName: 'Me' });

  const rewrite = async (name, edits) => {
    const zip = await openZip(file);
    const to = path.join(source.dir, name);
    const out = createZipWriter(fs.createWriteStream(to));
    for (const { name: entry } of zip.entries) {
      const bytes = await zip.read(entry);
      await out.add(entry, edits[entry] ? Buffer.from(JSON.stringify(edits[entry](JSON.parse(bytes.toString('utf8'))))) : bytes);
    }
    await out.finish();
    await zip.close();
    return to;
  };
  // The copy says its family is the victim's organization, with a long name, and that "me" is in it already.
  const crafted = await rewrite('crafted.zip', {
    'data/organizations.json': (rows) => rows.map((o) => ({ ...o, id: theirs.org.id, name: `${'x'.repeat(200)}` })),
    'data/memberships.json': (rows) => [...rows.map((m) => ({ ...m, organization_id: theirs.org.id })),
      { organization_id: theirs.org.id, user_id: victim.id, role: 'owner', joined_at: '2026-01-01T00:00:00.000Z' }],
    'data/fam_families.json': (rows) => rows.map((f) => ({ ...f, organization_id: theirs.org.id })),
  });
  const result = await target.portability.applyFile(crafted, { mode: 'account', user: me });
  const [{ organization_id: made }] = result.organizations;
  assert.notEqual(made, theirs.org.id);
  assert.equal(target.db.get('SELECT name FROM organizations WHERE id = ?', made).name.length, 80);
  assert.deepEqual(target.organizations.membersOf(theirs.org.id).map((m) => m.username), ['victim'], 'nobody joined theirs');
  assert.equal(count(target.db, 'fam_people WHERE family_id = ?', theirs.familyId), 2, 'nothing came into theirs');

  await rejectsWith(target.portability.planFile(await rewrite('kind.zip', {
    'data/organizations.json': (rows) => rows.map((o) => ({ ...o, kind: 'Family<script>' })),
  }), { mode: 'account', user: me }), 'import_invalid_data');
  await rejectsWith(target.portability.planFile(await rewrite('many.zip', {
    'data/organizations.json': (rows) => Array.from({ length: 101 }, (_, i) => ({ ...rows[0], id: i + 1 })),
  }), { mode: 'account', user: me, by: 'account' }), 'zip_too_large');
});

test('today’s declarations carry nothing of organizations, and refuse a copy that has them', async (t) => {
  const TODAY = { tables: { fam_notes: { refs: { user_id: 'users' } } } };
  const source = install(t);
  const s = seedSource(source);
  const today = source.suite.portabilityFor(TODAY);
  const whole = path.join(source.dir, 'today.zip');
  const manifest = await exportTo(source, whole, { scope: 'install' }, today);
  assert.equal(manifest.organizations, undefined);
  const { zip, json } = await readZip(t, whole);
  assert.equal(zip.has('data/organizations.json'), false);
  assert.equal(zip.has('suite/invitations.json'), false);
  assert.equal(zip.has('suite/grants.json'), false, 'only the accounts’ grants, and there are none');
  assert.equal(zip.has('suite/billing.json'), false);
  assert.equal((await json('data/users.json')).length, 4);

  const own = path.join(source.dir, 'ben.zip');
  await exportTo(source, own, { scope: 'account', userId: s.ben.id });
  const target = install(t);
  const me = target.suite.accounts.create({ username: 'me', displayName: 'Me' });
  await rejectsWith(target.suite.portabilityFor(TODAY).planFile(own, { mode: 'account', user: me }), 'import_invalid_data');
});
