/**
 * Organizations in the copies of the data (portability.js): a family's tables,
 * which chain to its organization, in the copy of every adult in it; the whole
 * install's copy with every organization, its roles, the invitations still
 * waiting, its plans and who pays for them, so that a renewal still finds the
 * family; where an imported family goes, and why a file can never choose a
 * group already here; a family's one row; "replace" handing a shared family
 * over, and only once the person was told; columns that never travel; and
 * today's declarations, which carry nothing of organizations.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSuite, createApp } from '../app.js';
import { openZip, createZipWriter } from '../zip.js';
import { describeData } from '../portability.js';
import { createBilling } from '../billing.js';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { sha256 } from '../crypto.js';
import { runDataCli } from '../tools/data-cli.js';

const PRODUCT = {
  app: { id: 'fam', name: 'Fam', port: 3998, languages: ['en', 'es'] },
  modules: { live: true, organizations: true },
  accounts: { minPasswordLength: 8 },
  features: { 'routines.max': { type: 'limit', default: null, label: 'routines' } },
  plans: { free: { name: 'Free', features: { 'routines.max': 3 } }, pro: { name: 'Pro', features: {} } },
  defaultPlan: 'free',
};
/** Tracker's shape: drivers take a seat, viewers don't. */
const FLEET = { ...PRODUCT, organizations: { roles: ['owner', 'admin', 'member', 'driver', 'viewer'], seatRoles: ['driver'] } };

/**
 * A family app shaped as Focus is: a family per organization (one row each, with the account
 * that anchors it), its people (children without an account), routines, paired devices; and
 * notes of one's own.
 */
const MIGRATIONS = [{
  version: 1,
  name: 'fam',
  up: (d) => d.exec(`
    CREATE TABLE fam_families (id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
      owner_user_id INTEGER NOT NULL REFERENCES users(id), settings TEXT NOT NULL DEFAULT '{}');
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
const cleaned = [];
const checked = [];
/** The oldest owner of a group here: what the family's anchor is filled with (an omitted column). */
const oldestOwner = (db, organizationId) => db.get(`SELECT user_id FROM memberships WHERE organization_id = ? AND role = 'owner'
  ORDER BY joined_at, user_id LIMIT 1`, organizationId)?.user_id;

/** The app's declaration: the family chains to its organization, and the rest to the family. */
const DATA = (db) => ({
  tables: {
    // The anchor is the app's own, never a reference a copy decides by: filled here on import.
    fam_families: {
      refs: { organization_id: 'organizations' }, onePerOrganization: true,
      omit: { owner_user_id: (row) => oldestOwner(db, row.organization_id) },
    },
    fam_people: {
      refs: { family_id: 'fam_families', user_id: 'users' },
      clean: (values, { organizations }) => { cleaned.push(organizations); return values; },
    },
    fam_routines: { refs: { family_id: 'fam_families', person_id: 'fam_people' } },
    fam_devices: {
      refs: { family_id: 'fam_families', person_id: 'fam_people' },
      // The key's hash can't be NULL: the device comes in unusable until it pairs again.
      omit: {
        token_hash: (row) => `unpaired-${row.person_id}-${Math.random().toString(36).slice(2)}`,
        push_endpoint: null, push_p256dh: null, push_auth: null, push_failures: () => undefined,
      },
    },
    fam_notes: { refs: { user_id: 'users' } },
  },
  organizations: {
    copyKinds: ['family'],
    mapOntoOwn: ['family'],
    // The app's part of a hand-over: the adult's profile in that family loses its account.
    leave: (userId, organizationId) => left.push([userId, organizationId]),
  },
  check: (args) => checked.push(args),
});

const SECRET_HASH = 'a'.repeat(60);
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/secret-endpoint';

function install(t, { env = {}, declaration = DATA, config = PRODUCT } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-orgdata-'));
  const suite = createSuite({
    config, migrations: MIGRATIONS, log: () => {}, exitOnError: false,
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', ...env },
  });
  t.after(() => { suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const portability = suite.portabilityFor(declaration(suite.database), { version: '1.0.0' });
  const events = [];
  const publish = suite.live.publish;
  suite.live.publish = (event) => { events.push(event); return publish(event); };
  return { dir, suite, portability, db: suite.database, organizations: suite.organizations, events, declaration };
}

/** A family in this install, with its adults' profiles, a child, two routines and a paired device. */
function family(box, { name, owner, members = [], child = 'Lia' }) {
  const { db, organizations } = box;
  const org = organizations.create({ name, kind: 'family', ownerId: owner.id });
  for (const [user, role] of members) organizations.addMember(org.id, user.id, role);
  const familyId = db.run('INSERT INTO fam_families (organization_id, owner_user_id, settings) VALUES (?, ?, ?)',
    org.id, owner.id, '{"week":"mon"}').lastInsertRowid;
  for (const user of [owner, ...members.map(([u]) => u)]) {
    db.run("INSERT INTO fam_people (family_id, kind, name, user_id) VALUES (?, 'adult', ?, ?)", familyId, user.display_name, user.id);
  }
  const kid = db.run("INSERT INTO fam_people (family_id, kind, name) VALUES (?, 'child', ?)", familyId, child).lastInsertRowid;
  db.run("INSERT INTO fam_routines (family_id, person_id, name) VALUES (?, ?, 'Morning')", familyId, kid);
  db.run("INSERT INTO fam_routines (family_id, person_id, name) VALUES (?, ?, 'Bedtime')", familyId, kid);
  db.run(`INSERT INTO fam_devices (family_id, person_id, name, token_hash, push_endpoint, push_p256dh, push_auth, push_failures, last_seen_at)
    VALUES (?, ?, 'Tablet', ?, ?, 'p256dh-key', 'auth-key', 2, '2026-09-01T08:00:00.000Z')`, familyId, kid,
  `${SECRET_HASH}${String(familyId).padStart(4, '0')}`, `${ENDPOINT}-${familyId}`);
  return { org, familyId, kid };
}

/**
 * The source: the Andersen family has two owners (ana, ben) and an admin (cleo), a pending
 * invitation, one used and one expired; a Pro plan paid at Paddle and a trial with an end. Ana
 * and Ben are also in a team (another kind, another app's). Dan has an archived family of his
 * own. Each adult has notes of their own.
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
  const old = family(box, { name: 'Old club', owner: dan, child: 'Rio' });
  organizations.archive(old.org.id);
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
  return { ana, ben, cleo, dan, home, team, old, pending, expired };
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

/** Copies the zip at `from` into `to`, changing its JSON entries with `edits[name](value)`. */
async function rewrite(from, to, edits) {
  const zip = await openZip(from);
  const out = createZipWriter(fs.createWriteStream(to));
  for (const { name } of zip.entries) {
    const bytes = await zip.read(name);
    await out.add(name, edits[name] ? Buffer.from(JSON.stringify(edits[name](JSON.parse(bytes.toString('utf8'))))) : bytes);
  }
  await out.finish();
  await zip.close();
  return to;
}

const rejectsWith = (promise, code) => assert.rejects(promise, (err) => {
  assert.equal(err.code, code, `${err.code}: ${err.message} ${JSON.stringify(err.extra || {})}`);
  return true;
});
const count = (db, sql, ...params) => Number(db.get(`SELECT COUNT(*) AS n FROM ${sql}`, ...params).n);
const membersOf = (box, id) => box.organizations.membersOf(id).map((m) => [m.username, m.role]).sort();

/* -------------------------------- the declaration -------------------------------- */

test('a group’s tables, what organizations do in copies and the columns that never travel are checked at the start', () => {
  const database = openDatabase({ path: ':memory:' });
  MIGRATIONS[0].up(database);
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const roles = { organizationRoles: ['owner', 'admin', 'member'] };
  const model = describeData(database, DATA(database), roles);
  assert.deepEqual(model.byName.get('fam_families').refs, [{ column: 'organization_id', target: 'organizations', required: true, deferred: false }]);
  assert.equal(model.byName.get('fam_families').onePer, 'organization_id');
  assert.deepEqual([...model.byName.get('fam_devices').omit.keys()], ['token_hash', 'push_endpoint', 'push_p256dh', 'push_auth', 'push_failures']);
  assert.deepEqual([...model.organizations.copyKinds], ['family']);
  // A table that points at organizations carries them by itself; today's declarations carry none.
  assert.ok(describeData(database, { tables: { fam_families: { refs: { organization_id: 'organizations' }, omit: { owner_user_id: () => 1 } } } }).organizations);
  assert.equal(describeData(database, { tables: { fam_notes: { refs: { user_id: 'users' } } } }).organizations, null);
  assert.ok(describeData(database, { tables: {}, organizations: {} }).organizations, 'or the option alone, for the install’s copy');
  assert.doesNotThrow(() => describeData(database, { tables: {}, organizations: { copyRoles: ['owner', 'admin'] } }, roles));

  const fails = (declaration, pattern, options = roles) => assert.throws(() => describeData(database, declaration, options), pattern);
  const families = { refs: { organization_id: 'organizations' }, omit: { owner_user_id: () => 1 } };
  fails({ tables: { fam_families: families, fam_devices: { refs: { family_id: 'fam_families' }, omit: ['token_hash'] } } },
    /fam_devices\.omit: token_hash is NOT NULL without a default/);
  fails({ tables: { fam_families: families, fam_devices: { refs: { family_id: 'fam_families' }, omit: ['family_id'] } } },
    /fam_devices\.omit: family_id is the key, a reference or a file's/);
  fails({ tables: { fam_families: families, fam_devices: { refs: { family_id: 'fam_families' }, omit: ['nothing'] } } },
    /"nothing" is not a column/);
  fails({ tables: { fam_families: families, fam_devices: { refs: { family_id: 'fam_families' }, omit: { token_hash: {} } } } },
    /a plain value or a function/);
  fails({ tables: { fam_families: { ...families, onePerOrganization: 'yes' } } }, /fam_families\.onePerOrganization: true, or left out/);
  fails({ tables: { fam_notes: { refs: { user_id: 'users' }, onePerOrganization: true } } },
    /fam_notes\.onePerOrganization: a table with an integer id and one NOT NULL reference to organizations/);
  fails({ tables: {}, organizations: { kind: ['family'] } }, /organizations\.kind is not an option/);
  fails({ tables: {}, organizations: { roles: ['owner'] } }, /organizations\.roles is not an option \(copyKinds, copyRoles, mapOntoOwn, leave\)/);
  fails({ tables: {}, organizations: { kinds: ['family'] } }, /organizations\.kinds is not an option/, roles);
  fails({ tables: {}, organizations: { copyKinds: ['family'], mapOntoOwn: ['team'] } }, /"team" is not one of organizations\.copyKinds/);
  // A kind is written as organizations.js writes it: starting with a letter.
  fails({ tables: {}, organizations: { copyKinds: ['1family'] } }, /organizations\.copyKinds: a list of kinds/);
  // A misspelt role would carry the group in nobody's copy: refused, naming the install's.
  fails({ tables: {}, organizations: { copyRoles: ['ownr'] } },
    /organizations\.copyRoles: some of organizations\.roles \(owner, admin, member\), such as \['owner', 'admin'\], or left out for every member/);
  fails({ tables: {}, organizations: { copyRoles: [] } }, /organizations\.copyRoles: some of organizations\.roles/);
  fails({ tables: {}, organizations: { leave: 'yes' } }, /organizations\.leave: a function/);
  fails({ tables: { memberships: { refs: { user_id: 'users' } } }, organizations: {} }, /memberships: the suite's own table/);
  fails({ tables: { fam_notes: { was: ['memberships'], refs: { user_id: 'users' } } } }, /fam_notes\.was: "memberships" is not a table's name/);
  fails({ tables: { fam_notes: { was: 'organizations', refs: { user_id: 'users' } } } }, /fam_notes\.was: "organizations" is not a table's name/);
  fails({ tables: { fam_people: { refs: { user_id: 'users', family_id: 'organizationz' } } } }, /"organizationz" is not one of the tables declared/);
  // With the module off, said with everything else that is wrong.
  fails({ tables: {}, organizations: {} }, /organizations needs modules\.organizations: the groups, members and plans its copies carry/,
    { organizationRoles: null });
  database.close();
});

test('a declaration that carries organizations needs the module, or the app doesn’t start', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-orgdata-'));
  const suite = createSuite({
    config: { ...PRODUCT, modules: { live: true } }, migrations: MIGRATIONS, log: () => {}, exitOnError: false,
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1' },
  });
  t.after(() => { suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => suite.portabilityFor(DATA(suite.database)), /organizations needs modules\.organizations/);
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
  assert.equal(manifest.source.install, undefined, 'someone’s own copy never says which install it is');
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
  assert.deepEqual(Object.keys((await json('data/fam_families.json'))[0]).sort(), ['id', 'organization_id', 'settings'], 'nor its anchor');
  const [device] = await json('data/fam_devices.json');
  assert.deepEqual(Object.keys(device).sort(), ['family_id', 'id', 'last_seen_at', 'name', 'person_id']);
  for (const name of zip.entries.map((e) => e.name)) {
    const text = (await zip.read(name)).toString('utf8');
    assert.ok(!text.includes(SECRET_HASH) && !text.includes(ENDPOINT) && !text.includes('p256dh-key'), `${name}: no secret in it`);
  }
  assert.equal(zip.has('suite/invitations.json'), false, 'invitations are the install’s');
  assert.equal(zip.has('suite/grants.json'), false, 'and so are plans');

  // Cleo, an admin, gets the same family; with copies only for owners she wouldn't.
  const cleo = await exportTo(source, path.join(source.dir, 'cleo.zip'), { scope: 'account', userId: s.cleo.id });
  assert.equal(cleo.tables.fam_routines, 2);
  const owners = source.suite.portabilityFor({ ...DATA(source.db), organizations: { ...DATA(source.db).organizations, copyRoles: ['owner'] } });
  const narrowed = await exportTo(source, path.join(source.dir, 'cleo-owners.zip'), { scope: 'account', userId: s.cleo.id }, owners);
  assert.equal(narrowed.organizations, undefined);
  assert.deepEqual(narrowed.tables, { fam_notes: 1 });

  // Dan's archived family of his own is his, marked archived: never counted as shared.
  const danFile = path.join(source.dir, 'dan.zip');
  const dan = await exportTo(source, danFile, { scope: 'account', userId: s.dan.id });
  const danZip = await readZip(t, danFile);
  assert.ok((await danZip.json('data/organizations.json'))[0].archived_at);
  assert.deepEqual(dan.tables, { fam_families: 1, fam_people: 2, fam_routines: 2, fam_devices: 1 });
  assert.deepEqual(dan.left_out, {});
});

test('someone’s own copy makes the family theirs in a fresh install, as its owner, with new ids, a date of its own and the defaults of what is omitted', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const file = path.join(source.dir, 'ben.zip');
  await exportTo(source, file, { scope: 'account', userId: s.ben.id });
  // A copy written by hand carries the device's secrets anyway: they never come in.
  const crafted = await rewrite(file, path.join(source.dir, 'ben-secrets.zip'), {
    'data/fam_devices.json': (rows) => rows.map((r) => ({ ...r, token_hash: 'planted-hash', push_endpoint: 'https://evil.example/push', push_failures: 99 })),
    'data/fam_families.json': (rows) => rows.map((r) => ({ ...r, owner_user_id: 1 })),
  });

  const target = install(t);
  // Ids taken here already: nothing of the copy lands on them.
  const zoe = target.suite.accounts.create({ username: 'zoe', displayName: 'Zoe' });
  family(target, { name: 'Zoe home', owner: zoe });
  const me = target.suite.accounts.create({ username: 'ben.cloud', displayName: 'Ben C' });

  const plan = await target.portability.planFile(crafted, { mode: 'account', user: me });
  assert.equal(plan.copy.organizations, 1);
  assert.deepEqual(plan.organizations, [{ source: { id: s.home.org.id, name: 'Casa Andersen', kind: 'family', members: 1 }, choice: { action: 'create' } }]);
  assert.deepEqual(plan.hand_over, []);

  cleaned.length = 0;
  checked.length = 0;
  const result = await target.portability.applyFile(crafted, { mode: 'account', user: me });
  assert.deepEqual(result.imported.organizations, { created: 1, mapped: 0 });
  const [{ organization_id: orgId, created }] = result.organizations;
  assert.equal(created, true);
  const org = target.db.get('SELECT * FROM organizations WHERE id = ?', orgId);
  assert.deepEqual([org.name, org.kind, org.settings, org.branding], ['Casa Andersen', 'family', '{"timezone":"Europe/Madrid"}', '{"color":"#ff8800"}']);
  assert.notEqual(org.created_at, '2026-03-04T05:06:07.890Z', 'a date of its own: the copy’s is anyone’s to write');
  assert.equal(org.slug, 'casa-andersen', 'a slug made from its name, as any new group’s');
  assert.deepEqual(membersOf(target, orgId), [['ben.cloud', 'owner']], 'theirs, the only member');
  const fam = target.db.get('SELECT * FROM fam_families WHERE organization_id = ?', orgId);
  assert.equal(fam.settings, '{"week":"mon"}');
  assert.equal(fam.owner_user_id, me.id, 'the app filled its anchor, never the copy');
  assert.deepEqual(target.db.all('SELECT name, user_id FROM fam_people WHERE family_id = ? ORDER BY id', fam.id).map((p) => [p.name, p.user_id]),
    [['Ana', null], ['Ben', me.id], ['Cleo', null], ['Lia', null]]);
  const kid = target.db.get("SELECT id FROM fam_people WHERE family_id = ? AND name = 'Lia'", fam.id).id;
  assert.deepEqual(target.db.all('SELECT name FROM fam_routines WHERE person_id = ? ORDER BY id', kid).map((r) => r.name), ['Morning', 'Bedtime']);
  const device = target.db.get('SELECT * FROM fam_devices WHERE family_id = ?', fam.id);
  assert.match(device.token_hash, new RegExp(`^unpaired-${kid}-`), 'what the app says an omitted column takes');
  assert.deepEqual([device.push_endpoint, device.push_p256dh, device.push_auth], [null, null, null], 'null: the column’s default');
  assert.equal(device.push_failures, 0, 'a function that answers nothing: the column’s default too');
  assert.equal(device.last_seen_at, '2026-09-01T08:00:00.000Z', 'what isn’t omitted comes as it was');
  assert.equal(count(target.db, "entitlement_grants WHERE subject_type = 'organization'"), 0, 'a person’s copy brings no plan');
  assert.equal(count(target.db, 'fam_families'), 2, 'Zoe’s is still there');
  // clean and check are told the same thing: which groups were made, which were here.
  assert.deepEqual(cleaned.map((o) => [[...o.created], [...o.mapped]]), Array(4).fill([[orgId], []]));
  assert.deepEqual([...checked[0].organizations.created], [orgId]);
  assert.deepEqual([...checked[0].organizations.mapped], []);
});

test('a family of that kind they own or run here takes the copy, and its one row is the copy’s (Focus’ case)', async (t) => {
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
  // His family here, as the app made it on his first visit: its one row and his profile.
  const mine = target.organizations.create({ name: 'Ben home', kind: 'family', ownerId: me.id });
  const famId = target.db.run("INSERT INTO fam_families (organization_id, owner_user_id, settings) VALUES (?, ?, '{\"week\":\"sun\"}')",
    mine.id, me.id).lastInsertRowid;
  target.db.run("INSERT INTO fam_people (family_id, kind, name, user_id) VALUES (?, 'adult', 'Ben here', ?)", famId, me.id);

  const plan = await target.portability.planFile(file, { mode: 'account', user: me });
  assert.deepEqual(plan.organizations[0].choice, { action: 'map', organization_id: mine.id, name: 'Ben home' });

  cleaned.length = 0;
  const result = await target.portability.applyFile(file, { mode: 'account', user: me });
  assert.deepEqual(result.imported.organizations, { created: 0, mapped: 1 });
  assert.deepEqual(result.merged, { fam_families: 1 }, 'the copy’s family row is the one here');
  assert.deepEqual(result.left_out.tables, {});
  assert.equal(count(target.db, 'fam_families'), 1, 'no second row, no UNIQUE refused');
  assert.equal(target.db.get('SELECT settings FROM fam_families WHERE id = ?', famId).settings, '{"week":"sun"}', 'what it had stays');
  assert.deepEqual(target.db.all('SELECT name FROM fam_people WHERE family_id = ? ORDER BY id', famId).map((p) => p.name),
    ['Ben here', 'Ana', 'Ben', 'Cleo', 'Lia'], 'the copy’s people came into it');
  assert.equal(count(target.db, 'fam_routines WHERE family_id = ?', famId), 2);
  assert.equal(target.db.get('SELECT name FROM organizations WHERE id = ?', mine.id).name, 'Ben home', 'his family keeps its own name');
  assert.equal(count(target.db, 'organizations'), 3, 'no new one');
  assert.deepEqual([...cleaned[0].mapped], [mine.id]);

  const plain = install(t, { declaration: (db) => ({ ...DATA(db), organizations: { copyKinds: ['family'] } }) });
  const ben = plain.suite.accounts.create({ username: 'ben', displayName: 'Ben' });
  const own = plain.organizations.create({ name: 'Ben home', kind: 'family', ownerId: ben.id });
  const again = await plain.portability.applyFile(file, { mode: 'account', user: ben });
  assert.deepEqual(again.imported.organizations, { created: 1, mapped: 0 }, 'an app that doesn’t say so gets a new one');
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
  assert.deepEqual(membersOf(target, shared.org.id), [['partner', 'owner']], 'the partner is its owner now: a family never loses its last owner');
  for (const [table, n] of Object.entries(before)) {
    assert.equal(count(target.db, `${table} WHERE family_id = ?`, shared.familyId), n, `${table}: the shared family is whole`);
  }
  assert.deepEqual(target.db.all('SELECT text FROM fam_notes ORDER BY id').map((n) => n.text), ['partner’s', 'Ben’s own']);
  const [{ organization_id: newOrg }] = result.organizations;
  assert.deepEqual(membersOf(target, newOrg), [['me', 'owner']], 'the copy’s family is theirs');
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
  assert.deepEqual(done.merged, {}, 'its row went with what it had: the copy’s is written');
  assert.equal(solo.db.get('SELECT organization_id FROM fam_families').organization_id, own.org.id);
  assert.equal(count(solo.db, "fam_people WHERE name = 'Kit'"), 0, 'what it had is gone');
  assert.equal(count(solo.db, "fam_people WHERE name = 'Lia'"), 1, 'the copy’s family is in it');
  assert.equal(count(solo.db, "entitlement_grants WHERE subject_type = 'organization' AND subject_id = ?", own.org.id), 1, 'its plan stays');
});

test('someone’s own “replace” answers 409 until they confirm the families it hands over, by name, over HTTP', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const zip = path.join(source.dir, 'ben.zip');
  await exportTo(source, zip, { scope: 'account', userId: s.ben.id });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-orgdata-http-'));
  const suite = createSuite({
    config: PRODUCT, migrations: MIGRATIONS, log: () => {}, exitOnError: false,
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1' },
  });
  const app = createApp({ suite, version: '1.0.0', handleSignals: false, log: () => {}, portable: DATA(suite.database) });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const me = suite.accounts.create({ username: 'me', displayName: 'Me', password: 'me-password' });
  const partner = suite.accounts.create({ username: 'partner', displayName: 'Partner' });
  const shared = family({ db: suite.database, organizations: suite.organizations }, { name: 'Shared home', owner: me, members: [[partner, 'admin']] });
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username: 'me', password: 'me-password' }),
  });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('fam_sid=')).split(';')[0];
  const call = (method, pathname, body, type = 'application/json') => fetch(base + pathname, {
    method, headers: { Cookie: cookie, Origin: base, 'Content-Type': type },
    body: type === 'application/json' ? JSON.stringify(body) : body,
  });

  const plan = await (await call('POST', '/api/me/import', fs.readFileSync(zip), 'application/zip')).json();
  assert.deepEqual(plan.hand_over, [{ id: shared.org.id, name: 'Shared home', kind: 'family' }], 'the plan names them');
  const refused = await call('POST', `/api/me/import/${plan.import_id}`, { replace: true });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'import_hand_over', organizations: ['Shared home'] });
  assert.deepEqual(membersOf({ organizations: suite.organizations }, shared.org.id), [['me', 'owner'], ['partner', 'admin']], 'nothing changed');
  const applied = await call('POST', `/api/me/import/${plan.import_id}`, { replace: true, hand_over: true });
  assert.equal(applied.status, 200, 'the upload waited: the same one, confirmed');
  assert.equal((await applied.json()).handed_over[0].heir, partner.id);
  assert.deepEqual(membersOf({ organizations: suite.organizations }, shared.org.id), [['partner', 'owner']]);
});

test('erasing one’s data leaves a family others share whole, and empties a family of one —archived too— but keeps it', (t) => {
  const box = install(t);
  const s = seedSource(box);
  const solo = family(box, { name: 'Dan home', owner: s.dan, child: 'Kai' });
  const before = count(box.db, 'fam_routines WHERE family_id = ?', s.home.familyId);
  const { erased } = box.portability.erase(s.ben);
  assert.deepEqual(erased, { fam_notes: 1 });
  assert.equal(count(box.db, 'fam_routines WHERE family_id = ?', s.home.familyId), before, 'the shared family is whole');
  assert.equal(box.organizations.roleOf(s.home.org.id, s.ben.id), 'owner', 'and he is still in it');

  const gone = box.portability.erase(s.dan);
  assert.deepEqual(gone.erased, { fam_families: 2, fam_people: 4, fam_routines: 4, fam_devices: 2 }, 'his family and his archived one');
  assert.equal(count(box.db, 'fam_families WHERE id IN (?, ?)', solo.familyId, s.old.familyId), 0);
  assert.ok(box.organizations.get(solo.org.id), 'the organization stays, with its plan, to start again');
});

/* ------------------------------- the whole install ------------------------------- */

test('a whole install moves every family: its name, two owners and an admin, the invitation waiting, its Pro plan and who pays for it', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const file = path.join(source.dir, 'install.zip');
  const manifest = await exportTo(source, file, { scope: 'install' });
  assert.equal(manifest.organizations, 3);
  assert.match(manifest.source.install, /^[\w-]{24}$/, 'it says which install it is');
  assert.equal(source.db.getMeta('suite.install_id'), manifest.source.install, 'and keeps saying the same');
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
  assert.deepEqual(membersOf(target, home.id), [['ana', 'owner'], ['ben', 'owner'], ['cleo', 'admin']], 'two owners and an admin');
  assert.ok(db.get("SELECT archived_at FROM organizations WHERE name = 'Old club'").archived_at, 'an archived one stays archived');
  const fam = db.get('SELECT * FROM fam_families WHERE organization_id = ?', home.id);
  assert.equal(fam.owner_user_id, id('ana'), 'the anchor, the oldest owner here');
  assert.equal(count(db, 'fam_people WHERE user_id IS NOT NULL'), 4);

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

test('another module’s copy of the same install finds the organizations the first one made, and adds nothing to them', async (t) => {
  // The same install moving into a host one module at a time: the second copy brings the same groups.
  const NOTES = () => ({ tables: { fam_notes: { refs: { user_id: 'users' } } }, organizations: {} });
  const source = install(t);
  seedSource(source);
  const first = path.join(source.dir, 'fam.zip');
  const second = path.join(source.dir, 'notes.zip');
  await exportTo(source, first, { scope: 'install' });
  await exportTo(source, second, { scope: 'install' }, source.suite.portabilityFor(NOTES()));

  const target = install(t);
  await target.portability.applyFile(first, { mode: 'install' });
  const notes = target.suite.portabilityFor(NOTES());
  const plan = await notes.planFile(second, { mode: 'install' });
  assert.deepEqual(plan.organizations.map((o) => o.choice.action), ['map', 'map', 'map']);
  const result = await notes.applyFile(second, { mode: 'install' });
  assert.deepEqual(result.imported.organizations, { created: 0, mapped: 3 });
  assert.deepEqual([result.imported.memberships, result.imported.invitations, result.imported.grants, result.imported.billing], [0, 0, 0, 0]);
  assert.equal(count(target.db, 'organizations'), 3);
  assert.equal(count(target.db, 'memberships'), 6);
  assert.equal(count(target.db, "entitlement_grants WHERE subject_type = 'organization'"), 2);
});

test('someone’s own copy can never set up a group a whole install’s move goes into: the family comes once, whole, to its own members', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const mal = source.suite.accounts.create({ username: 'mal', displayName: 'Mal', email: 'mal@example.com' }, { quiet: true });
  source.organizations.addMember(s.home.org.id, mal.id, 'admin');
  // Mal takes her copy, and leaves the family (or is taken out of it); Ben, who stays, takes his.
  const malFile = path.join(source.dir, 'mal.zip');
  const benFile = path.join(source.dir, 'ben.zip');
  await exportTo(source, malFile, { scope: 'account', userId: mal.id });
  await exportTo(source, benFile, { scope: 'account', userId: s.ben.id });
  source.organizations.removeMember(s.home.org.id, mal.id);

  // On the new install both bring their copies before the administrator moves the install.
  const target = install(t);
  const malHere = target.suite.accounts.create({ username: 'mal', displayName: 'Mal', email: 'mal@example.com' });
  const benHere = target.suite.accounts.create({ username: 'ben', displayName: 'Ben', email: 'ben@example.com' });
  const hers = (await target.portability.applyFile(malFile, { mode: 'account', user: malHere })).organizations[0].organization_id;
  const his = (await target.portability.applyFile(benFile, { mode: 'account', user: benHere })).organizations[0].organization_id;
  assert.notEqual(target.db.get('SELECT created_at FROM organizations WHERE id = ?', hers).created_at, '2026-03-04T05:06:07.890Z');
  const hersBefore = count(target.db, 'fam_people p JOIN fam_families f ON f.id = p.family_id WHERE f.organization_id = ?', hers);

  const whole = path.join(source.dir, 'install.zip');
  await exportTo(source, whole, { scope: 'install' });
  const plan = await target.portability.planFile(whole, { mode: 'install' });
  assert.equal(plan.organizations.find((o) => o.source.name === 'Casa Andersen').choice.action, 'create');
  const result = await target.portability.applyFile(whole, { mode: 'install' });
  assert.deepEqual(result.imported.organizations, { created: 3, mapped: 0 });
  const real = result.organizations.find((o) => o.source === s.home.org.id).organization_id;
  assert.ok(![hers, his].includes(real));
  assert.deepEqual(membersOf(target, real), [['ana', 'owner'], ['ben', 'owner'], ['cleo', 'admin']], 'Mal isn’t in the family she left');
  assert.deepEqual(membersOf(target, hers), [['mal', 'owner']], 'and her group gets nobody');
  assert.equal(count(target.db, 'fam_people p JOIN fam_families f ON f.id = p.family_id WHERE f.organization_id = ?', hers), hersBefore, 'nor any row');
  assert.deepEqual(target.db.all("SELECT DISTINCT subject_id FROM entitlement_grants WHERE subject_type = 'organization'").map((g) => g.subject_id), [real],
    'the family’s Pro is the family’s');
  assert.equal(count(target.db, 'fam_families WHERE organization_id = ?', real), 1, 'the family came once, whole');
  assert.deepEqual(membersOf(target, his), [['ben', 'owner']], 'Ben’s own import stays his, beside it');
});

test('a crafted whole-install copy adds nobody to a group here: no member, no invitation, no plan, whatever it says', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const target = install(t);
  const first = path.join(source.dir, 'install.zip');
  await exportTo(source, first, { scope: 'install' });
  await target.portability.applyFile(first, { mode: 'install' });
  const home = target.db.get("SELECT id FROM organizations WHERE name = 'Casa Andersen'").id;
  const grants = count(target.db, "entitlement_grants WHERE subject_type = 'organization'");
  const token = 'inv_known-to-the-attacker-0000000000';

  // Eve writes herself into the family as its owner, with an owner's invitation she holds the link of.
  const forge = async (name, manifest) => {
    const fresh = path.join(source.dir, `${name}-base.zip`);
    await exportTo(source, fresh, { scope: 'install' });
    return rewrite(fresh, path.join(source.dir, `${name}.zip`), {
      'manifest.json': manifest,
      'data/users.json': (rows) => [...rows, { ...rows[0], id: 999, username: 'eve', display_name: 'Eve', email: 'eve@example.com', role: 'user' }],
      'data/memberships.json': (rows) => [...rows, { organization_id: s.home.org.id, user_id: 999, role: 'owner', joined_at: '2020-01-01T00:00:00.000Z' }],
      'suite/invitations.json': () => [{ organization_id: s.home.org.id, email: null, role: 'owner', token_hash: sha256(token),
        created_at: '2026-01-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z' }],
      'suite/grants.json': (rows) => [...rows, { subject_type: 'organization', subject_id: s.home.org.id, plan: 'pro', source: 'admin',
        starts_at: '2026-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z' }],
    });
  };
  // Saying it comes from the same install, with its id: the family is found, and nothing is added to it.
  const same = await forge('same-install', (m) => m);
  const result = await target.portability.applyFile(same, { mode: 'install' });
  assert.equal(result.organizations.find((o) => o.source === s.home.org.id).organization_id, home);
  const eve = target.suite.accounts.byUsername('eve');
  assert.equal(target.organizations.roleOf(home, eve.id), null, 'not a member');
  assert.equal(count(target.db, "entitlement_grants WHERE subject_type = 'organization'"), grants, 'no plan given');
  assert.throws(() => target.organizations.accept(token, eve.id), (err) => err.code === 'invitation_invalid', 'her link opens nothing');

  // Without it, a slug, a kind and a date like the family's find nothing: a new group, hers alone.
  const other = await forge('no-install', (m) => ({ ...m, source: { ...m.source, install: undefined } }));
  const second = await target.portability.applyFile(other, {
    mode: 'install', decisions: [{ source: 'eve', user_id: eve.id }],
  });
  const made = second.organizations.find((o) => o.source === s.home.org.id).organization_id;
  assert.notEqual(made, home);
  assert.equal(target.organizations.roleOf(home, eve.id), null);
  assert.equal(target.db.get('SELECT slug FROM organizations WHERE id = ?', made).slug, 'casa-andersen-2');
});

test('a group whose owners are left out gets its heir by the one rule: drivers last; a role this install lacks becomes member', async (t) => {
  const source = install(t, { config: FLEET });
  const make = (username) => source.suite.accounts.create({ username, displayName: username, email: `${username}@example.com` }, { quiet: true });
  const [olga, dave, vic] = ['olga', 'dave', 'vic'].map(make);
  const fleet = source.organizations.create({ name: 'Fleet', kind: 'fleet', ownerId: olga.id });
  source.organizations.addMember(fleet.id, dave.id, 'driver');
  source.organizations.addMember(fleet.id, vic.id, 'viewer');
  source.db.run("UPDATE memberships SET joined_at = '2026-01-02T00:00:00.000Z' WHERE user_id = ?", dave.id);
  source.db.run("UPDATE memberships SET joined_at = '2026-01-03T00:00:00.000Z' WHERE user_id = ?", vic.id);
  const file = path.join(source.dir, 'install.zip');
  await exportTo(source, file, { scope: 'install' });

  // The same product: the viewer inherits, though the driver joined first —a driver made owner would stop driving.
  const same = install(t, { config: FLEET });
  await same.portability.applyFile(file, { mode: 'install', decisions: [{ source: 'olga', skip: true }] });
  const here = same.db.get("SELECT id FROM organizations WHERE name = 'Fleet'").id;
  assert.deepEqual(membersOf(same, here), [['dave', 'driver'], ['vic', 'owner']]);
  const id = (box, username) => box.suite.accounts.byUsername(username).id;
  assert.equal(same.organizations.heirOf(here, id(same, 'vic')), id(same, 'dave'), 'a driver inherits only when nobody else is left');

  // An install without those roles: they come in as members.
  const plain = install(t);
  const result = await plain.portability.applyFile(file, { mode: 'install' });
  assert.equal(result.imported.memberships, 3);
  const there = plain.db.get("SELECT id FROM organizations WHERE name = 'Fleet'").id;
  assert.deepEqual(membersOf(plain, there), [['dave', 'member'], ['olga', 'owner'], ['vic', 'member']]);
});

test('the command line shows where each organization goes, and brings them in', async (t) => {
  const source = install(t);
  seedSource(source);
  const file = path.join(source.dir, 'cli.zip');
  const out = [];
  const run = (box, ...argv) => runDataCli({ suite: box.suite, declaration: DATA(box.db), version: '1.0.0', argv, log: (line) => out.push(line), error: (line) => out.push(`ERR ${line}`) });
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

  // Someone's own, with --replace: the families handed over, said before.
  const own = path.join(source.dir, 'ben.zip');
  await exportTo(source, own, { scope: 'account', userId: source.suite.accounts.byUsername('ben').id });
  out.length = 0;
  assert.equal(await run(target, 'import', own, '--as', 'ben', '--replace', 'ben'), 0);
  assert.match(out.join('\n'), /handed over to the others, who keep what is in them: "Casa Andersen"/);
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
  const tampered = await rewrite(file, path.join(source.dir, 'tampered.zip'), {
    'data/users.json': (rows) => rows.map((u) => (u.username === 'ben' ? { ...u, delete_after: '2000-01-01T00:00:00.000Z' } : u)),
    'manifest.json': (m) => ({ ...m, id: 'tampered-copy-0000000' }),
  });
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

  // The copy says its family is the victim's organization, with a long name, and that the victim is in it.
  const crafted = await rewrite(file, path.join(source.dir, 'crafted.zip'), {
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

  await rejectsWith(target.portability.planFile(await rewrite(file, path.join(source.dir, 'kind.zip'), {
    'data/organizations.json': (rows) => rows.map((o) => ({ ...o, kind: 'Family<script>' })),
  }), { mode: 'account', user: me }), 'import_invalid_data');
  await rejectsWith(target.portability.planFile(await rewrite(file, path.join(source.dir, 'many.zip'), {
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
  assert.deepEqual(manifest.source, { base_url: 'http://127.0.0.1', auth: 'local' }, 'nor which install it is');
  assert.equal(source.db.getMeta('suite.install_id'), null, 'nothing written for it');
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
