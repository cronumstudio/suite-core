/**
 * Copies of an account and of a whole install (portability.js): what goes in
 * someone's copy and what stays because it is shared; a whole install moved
 * into a clean one with its accounts mapped by email, created or left out,
 * keeping shares, numbers, dates, the trash, circular references and every
 * attachment byte for byte; "replace"; and a copy that isn't trusted —another
 * app's, a newer one, crafted columns, an HTML file posing as a photo, one
 * applied twice—. Last, the routes over real HTTP.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSuite, createApp } from '../app.js';
import { createZipWriter, openZip } from '../zip.js';
import { describeData, selectRows } from '../portability.js';
import { openDatabase } from '../db.js';
import { runDataCli } from '../tools/data-cli.js';

const PRODUCT = {
  app: { id: 'demo', name: 'Demo', port: 3999, languages: ['en', 'es'] },
  modules: { uploads: true, live: true },
  accounts: { minPasswordLength: 8 },
  features: { attachments: { type: 'flag', default: true, label: 'attachments' } },
  plans: { free: { name: 'Free', features: { attachments: false } }, full: { name: 'Full', features: {} } },
  defaultPlan: 'full',
};

/** A small app with what makes copies hard: groups, shares, numbers, trash, a tree, circles, files. */
const MIGRATIONS = [{
  version: 1,
  name: 'demo',
  up: (d) => d.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user',
      avatar_color TEXT NOT NULL DEFAULT '#000000', prefs TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL);
    CREATE TABLE lists (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL, name TEXT NOT NULL, next_number INTEGER NOT NULL DEFAULT 1,
      settings TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE shares (id INTEGER PRIMARY KEY AUTOINCREMENT, list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, UNIQUE (list_id, user_id));
    CREATE TABLE list_prefs (list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (list_id, user_id));
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE, title TEXT NOT NULL, number INTEGER,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      mime TEXT NOT NULL, size INTEGER NOT NULL);
    CREATE TABLE branches (id INTEGER PRIMARY KEY AUTOINCREMENT, list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES branches(id) ON DELETE SET NULL, fork_entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
      name TEXT);
    CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      merged_branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL, text TEXT NOT NULL);
  `),
}];

const DATA = {
  tables: {
    groups: { refs: { user_id: 'users' } },
    lists: { refs: { owner_id: 'users', group_id: 'groups' } },
    shares: { refs: { list_id: 'lists', user_id: 'users' } },
    list_prefs: { refs: { list_id: 'lists', user_id: 'users' } },
    tasks: { refs: { list_id: 'lists', parent_id: 'tasks', created_by: 'users' } },
    files: { refs: { task_id: 'tasks', user_id: 'users' }, file: { path: 'path', folder: 'user_id', feature: 'attachments' } },
    branches: { refs: { list_id: 'lists', parent_id: 'branches', fork_entry_id: 'entries' } },
    entries: { refs: { branch_id: 'branches', merged_branch_id: 'branches' } },
  },
  users: {
    columns: ['avatar_color'],
    prefs: (prefs, { ids, current }) => ({
      ...(current || {}), ...prefs,
      default_list: prefs.default_list ? ids('lists', prefs.default_list) : current?.default_list ?? null,
    }),
  },
};

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 31) % 256))]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
const HTML = Buffer.from('<!DOCTYPE html><script>alert(document.cookie)</script>');

/** An install of the demo app in its own folder; every new account gets a "Welcome" group, like Tasks' first lists. */
function install(t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-data-'));
  let suite = null;
  suite = createSuite({
    config: PRODUCT, migrations: MIGRATIONS, log: () => {}, exitOnError: false,
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', ...env },
    hooks: { onUserCreated: (user) => suite.database.run('INSERT INTO groups (user_id, name) VALUES (?, ?)', user.id, 'Welcome') },
  });
  t.after(() => { suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const portability = suite.portabilityFor(DATA, { version: '1.0.0' });
  const events = [];
  const publish = suite.live.publish;
  suite.live.publish = (event) => { events.push(event); return publish(event); };
  return { dir, suite, portability, db: suite.database, events };
}

/** Stores a file the way the app would, and returns its row values. */
function attach(box, userId, bytes, name) {
  const relative = `${userId}/${Math.random().toString(36).slice(2, 10)}-${name}`;
  const absolute = box.suite.uploads.resolve(relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, bytes);
  return relative;
}

/**
 * The source install: ana (admin, with an email) owns a list shared with ben,
 * with numbered tasks, a step, one in the trash, one ben added, a photo and a
 * PDF, and branches that point at each other; ben owns a list shared with ana
 * with a task ana added; carl has nothing.
 */
function seedSource(box) {
  const { suite, db } = box;
  // Quiet: the welcome group of new accounts would only blur the counts of the source.
  const ana = suite.accounts.create({ username: 'ana', displayName: 'Ana', role: 'admin', email: 'ana@example.com' }, { quiet: true });
  const ben = suite.accounts.create({ username: 'ben', displayName: 'Ben' }, { quiet: true });
  const carl = suite.accounts.create({ username: 'carl', displayName: 'Carl', email: 'carl@example.com' }, { quiet: true });
  db.run("UPDATE users SET avatar_color = '#ff0000', created_at = '2025-01-02T03:04:05.000Z' WHERE id = ?", ana.id);
  const group = db.run("INSERT INTO groups (user_id, name) VALUES (?, 'Home')", ana.id).lastInsertRowid;
  const l1 = db.run("INSERT INTO lists (owner_id, group_id, name, next_number, settings) VALUES (?, ?, 'Shopping', 5, '{\"numbers\":true}')", ana.id, group).lastInsertRowid;
  const l2 = db.run("INSERT INTO lists (owner_id, name, next_number) VALUES (?, 'Garden', 2)", ben.id).lastInsertRowid;
  db.run('INSERT INTO shares (list_id, user_id) VALUES (?, ?)', l1, ben.id);
  db.run('INSERT INTO shares (list_id, user_id) VALUES (?, ?)', l2, ana.id);
  db.run('INSERT INTO list_prefs (list_id, user_id, enabled) VALUES (?, ?, 0)', l1, ben.id);
  db.run('INSERT INTO list_prefs (list_id, user_id, enabled) VALUES (?, ?, 1)', l1, ana.id);
  const task = (list, title, number, by, extra = {}) => db.run(`INSERT INTO tasks (list_id, parent_id, title, number, created_by, created_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, list, extra.parent ?? null, title, number, by, extra.at ?? '2026-02-03T10:00:00.000Z', extra.deleted ?? null).lastInsertRowid;
  const t1 = task(l1, 'Bread', 1, ana.id);
  task(l1, 'Wholemeal', 2, ana.id, { parent: t1 });
  const t3 = task(l1, 'Milk', 3, ben.id);
  task(l1, 'Old thing', 4, ana.id, { deleted: '2026-03-01T00:00:00.000Z' });
  task(l2, 'Roses', 1, ana.id);
  const photo = attach(box, ana.id, JPEG, 'bread.jpg');
  const receipt = attach(box, ben.id, PDF, 'receipt.pdf');
  db.run("INSERT INTO files (task_id, user_id, path, name, mime, size) VALUES (?, ?, ?, 'bread.jpg', 'image/jpeg', ?)", t1, ana.id, photo, JPEG.length);
  db.run("INSERT INTO files (task_id, user_id, path, name, mime, size) VALUES (?, ?, ?, 'receipt.pdf', 'application/pdf', ?)", t3, ben.id, receipt, PDF.length);
  const main = db.run("INSERT INTO branches (list_id, name) VALUES (?, 'main')", l1).lastInsertRowid;
  const e1 = db.run("INSERT INTO entries (branch_id, text) VALUES (?, 'started')", main).lastInsertRowid;
  const side = db.run("INSERT INTO branches (list_id, parent_id, fork_entry_id, name) VALUES (?, ?, ?, 'side')", l1, main, e1).lastInsertRowid;
  db.run("INSERT INTO entries (branch_id, text) VALUES (?, 'on the side')", side);
  db.run("INSERT INTO entries (branch_id, merged_branch_id, text) VALUES (?, ?, 'merged')", main, side);
  db.run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify({ default_list: l1, lang: 'es' }), ana.id);
  db.run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify({ default_list: l2 }), ben.id);
  db.run("INSERT INTO entitlement_grants (subject_type, subject_id, plan, source, starts_at, created_at) VALUES ('user', ?, 'full', 'admin', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')", ben.id);
  return { ana, ben, carl, l1, l2, photo, receipt };
}

async function exportTo(box, file, options) {
  const job = box.portability.prepareExport(options);
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

/* --------------------------------- the model --------------------------------- */

test('the declaration is checked against the database: a mistake stops the start', () => {
  const database = openDatabase({ path: ':memory:' });
  MIGRATIONS[0].up(database);
  assert.doesNotThrow(() => describeData(database, DATA));
  assert.throws(() => describeData(database, { tables: { nothing: { refs: { user_id: 'users' } } } }), /no such table/);
  // A nullable reference to a later table is fine: it is set once that table is in.
  assert.doesNotThrow(() => describeData(database, { tables: { lists: { refs: { owner_id: 'users', group_id: 'groups' } }, groups: { refs: { user_id: 'users' } } } }));
  assert.throws(() => describeData(database, {
    tables: { lists: { refs: { owner_id: 'users' } }, entries: { refs: { branch_id: 'branches' } }, branches: { refs: { list_id: 'lists' } } },
  }), /entries\.branch_id points at branches.*must allow NULL/);
  assert.throws(() => describeData(database, { tables: { lists: { refs: { group_id: 'groups' } }, groups: { refs: { user_id: 'users' } } } }),
    /NOT NULL reference/);
  assert.throws(() => describeData(database, { tables: { groups: { refs: { user_id: 'users' } } }, users: { columns: ['password_hash'] } }),
    /not one of the app's own columns/);
  assert.throws(() => describeData(database, {
    tables: { lists: { refs: { owner_id: 'users' } }, tasks: { refs: { list_id: 'lists' } }, files: { refs: { task_id: 'tasks', user_id: 'users' }, file: { folder: 'task_id' } } },
  }), /file.folder/);
  database.close();
});

test('whose rows: required references decide, optional ones are emptied, shares stay behind', () => {
  const database = openDatabase({ path: ':memory:' });
  MIGRATIONS[0].up(database);
  const model = describeData(database, DATA);
  const rows = {
    groups: [{ id: 1, user_id: 1, name: 'A' }],
    lists: [{ id: 10, owner_id: 1, group_id: 1, name: 'mine' }, { id: 11, owner_id: 2, group_id: null, name: 'theirs' }],
    shares: [{ id: 5, list_id: 10, user_id: 2 }, { id: 6, list_id: 11, user_id: 1 }],
    list_prefs: [], files: [], entries: [], branches: [],
    tasks: [{ id: 100, list_id: 10, created_by: 2, title: 'x' }, { id: 101, list_id: 11, created_by: 1, title: 'y' }],
  };
  const { kept, leftOut } = selectRows(model, (name) => rows[name], (id) => id === 1, { account: 1 });
  assert.deepEqual(kept.get('lists').map((r) => r.id), [10]);
  assert.deepEqual(kept.get('shares'), []);
  assert.deepEqual(kept.get('tasks'), [{ id: 100, list_id: 10, created_by: null, title: 'x' }], 'who added it is someone else: emptied');
  // Their list shared with her and hers shared with them, and what she added to their list;
  // their list itself isn't hers to miss.
  assert.deepEqual(leftOut, { shares: 2, tasks: 1 });
  database.close();
});

/* ------------------------------ someone's copy ------------------------------- */

test('someone’s copy takes their lists with everything in them, and says what stays because it is shared', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const file = path.join(source.dir, 'ana.zip');
  const manifest = await exportTo(source, file, { scope: 'account', userId: s.ana.id });
  const { json, zip } = await readZip(t, file);

  assert.equal(manifest.format, 'cronum-suite-export');
  assert.deepEqual([manifest.scope, manifest.app.id, manifest.app.version, manifest.account.username], ['account', 'demo', '1.0.0', 'ana']);
  assert.deepEqual(manifest.schema, { app: 1, suite: 14 });
  assert.deepEqual(await json('manifest.json'), manifest);

  const users = await json('data/users.json');
  assert.equal(users.length, 1);
  assert.equal(users[0].username, 'ana');
  assert.equal(users[0].avatar_color, '#ff0000', 'the app’s own columns travel');
  assert.equal('password_hash' in users[0], false, 'never a password');

  const lists = await json('data/lists.json');
  assert.deepEqual(lists.map((l) => l.name), ['Shopping'], 'the list shared with her is not hers');
  const tasks = await json('data/tasks.json');
  assert.deepEqual(tasks.map((x) => [x.title, x.number]), [['Bread', 1], ['Wholemeal', 2], ['Milk', 3], ['Old thing', 4]]);
  assert.equal(tasks.find((x) => x.title === 'Milk').created_by, null, 'who added it isn’t in her copy');
  assert.ok(tasks.find((x) => x.title === 'Old thing').deleted_at, 'the trash travels');
  assert.equal(zip.has('data/shares.json'), false, 'shares stay with the people');
  assert.deepEqual((await json('data/list_prefs.json')).map((p) => p.user_id), [s.ana.id], 'her own setting, not ben’s');
  assert.deepEqual(manifest.left_out, { shares: 2, list_prefs: 1, tasks: 1 });

  const files = await json('data/files.json');
  assert.deepEqual(files.map((f) => f.name), ['bread.jpg', 'receipt.pdf'], 'what is in her list, whoever attached it');
  assert.equal(files[1].user_id, null);
  assert.deepEqual(await zip.read(`files/${s.photo}`), JPEG);
  assert.deepEqual(await zip.read(`files/${s.receipt}`), PDF);
  assert.deepEqual(manifest.files, { count: 2, bytes: JPEG.length + PDF.length, missing: 0 });
  assert.equal(zip.has('suite/grants.json'), false, 'plans are the install’s');
});

test('someone’s copy goes into another install as new data of the account that imports it', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const file = path.join(source.dir, 'ana.zip');
  await exportTo(source, file, { scope: 'account', userId: s.ana.id });

  const target = install(t);
  // Ids here are taken already: nothing of the copy may land on them.
  const other = target.suite.accounts.create({ username: 'zoe', displayName: 'Zoe' });
  target.db.run("INSERT INTO lists (owner_id, name) VALUES (?, 'Zoe list')", other.id);
  const me = target.suite.accounts.create({ username: 'ana.cloud', displayName: 'Ana C', email: 'ana@cloud.example', role: 'user' });

  const plan = await target.portability.planFile(file, { mode: 'account', user: me });
  assert.deepEqual(plan.copy.tables, { groups: 1, lists: 1, list_prefs: 1, tasks: 4, files: 2, branches: 2, entries: 3 });
  assert.deepEqual(plan.replace, { groups: 1 }, 'what she has now: the welcome group');
  assert.deepEqual(plan.copy.left_out, { shares: 2, list_prefs: 1, tasks: 1 });

  const result = await target.portability.applyFile(file, { mode: 'account', user: me });
  assert.deepEqual(result.imported.tables, { groups: 1, lists: 1, list_prefs: 1, tasks: 4, files: 2, branches: 2, entries: 3 });
  assert.equal(result.imported.files, 2);
  assert.deepEqual(result.accounts, [{ source: s.ana.id, user_id: me.id, username: 'ana.cloud', created: false }]);

  const db = target.db;
  const list = db.get("SELECT * FROM lists WHERE name = 'Shopping'");
  assert.equal(list.owner_id, me.id);
  assert.equal(list.next_number, 5, 'the next number goes on where it was');
  assert.equal(list.settings, '{"numbers":true}');
  assert.equal(db.get('SELECT name FROM groups WHERE id = ?', list.group_id).name, 'Home');
  const tasks = db.all('SELECT * FROM tasks WHERE list_id = ? ORDER BY number', list.id);
  assert.deepEqual(tasks.map((x) => [x.title, x.number]), [['Bread', 1], ['Wholemeal', 2], ['Milk', 3], ['Old thing', 4]]);
  assert.equal(tasks[1].parent_id, tasks[0].id, 'the step hangs from its new parent');
  assert.equal(tasks[0].created_by, me.id);
  assert.equal(tasks[2].created_by, null);
  assert.equal(tasks[0].created_at, '2026-02-03T10:00:00.000Z', 'dates as they were');
  assert.equal(tasks[3].deleted_at, '2026-03-01T00:00:00.000Z');

  const [main, side] = db.all('SELECT * FROM branches WHERE list_id = ? ORDER BY id', list.id);
  const entries = db.all('SELECT * FROM entries WHERE branch_id IN (?, ?) ORDER BY id', main.id, side.id);
  assert.equal(side.parent_id, main.id);
  assert.equal(side.fork_entry_id, entries[0].id, 'a reference to a later table, set once both exist');
  assert.equal(entries[2].merged_branch_id, side.id);

  const files = db.all('SELECT f.* FROM files f JOIN tasks x ON x.id = f.task_id WHERE x.list_id = ? ORDER BY f.id', list.id);
  assert.equal(files.length, 2);
  assert.match(files[0].path, new RegExp(`^${me.id}/[\\w-]{11}-bread\\.jpg$`));
  assert.match(files[1].path, /^shared\/[\w-]{11}-receipt\.pdf$/, 'whoever attached it isn’t here');
  assert.deepEqual(fs.readFileSync(target.suite.uploads.resolve(files[0].path)), JPEG, 'byte for byte');
  assert.deepEqual(fs.readFileSync(target.suite.uploads.resolve(files[1].path)), PDF);
  assert.deepEqual([files[0].mime, files[0].size], ['image/jpeg', JPEG.length]);

  const after = target.suite.accounts.byId(me.id);
  assert.deepEqual([after.username, after.email, after.role], ['ana.cloud', 'ana@cloud.example', 'user'], 'who she is here stays');
  assert.deepEqual([after.display_name, after.avatar_color], ['Ana', '#ff0000'], 'her preferences come');
  assert.deepEqual(JSON.parse(after.prefs), { default_list: list.id, lang: 'es' }, 'ids in the preferences, translated');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM lists WHERE name = 'Zoe list'").n, 1, 'nothing else touched');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM groups WHERE user_id = ?', me.id).n, 2, 'added, not replaced');
  assert.ok(target.events.some((e) => e.event === 'resync' && e.audience?.includes(me.id)), 'her open tabs reload');
  assert.deepEqual(fs.readdirSync(path.join(target.dir, 'imports')), [], 'nothing staged is left behind');

  await rejectsWith(target.portability.applyFile(file, { mode: 'account', user: me }), 'import_already_applied');
  const again = await target.portability.planFile(file, { mode: 'account', user: me });
  assert.ok(again.copy.applied_at, 'the plan says it was applied');
});

test('“replace” deletes what the account had first —and its files—, never what is shared with it', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const file = path.join(source.dir, 'ana.zip');
  await exportTo(source, file, { scope: 'account', userId: s.ana.id });

  const target = install(t);
  const me = target.suite.accounts.create({ username: 'me', displayName: 'Me' });
  const friend = target.suite.accounts.create({ username: 'friend', displayName: 'Friend' });
  const mine = target.db.run("INSERT INTO lists (owner_id, name) VALUES (?, 'Old mine')", me.id).lastInsertRowid;
  const theirs = target.db.run("INSERT INTO lists (owner_id, name) VALUES (?, 'Friend list')", friend.id).lastInsertRowid;
  target.db.run('INSERT INTO shares (list_id, user_id) VALUES (?, ?)', theirs, me.id);
  const task = target.db.run("INSERT INTO tasks (list_id, title, created_at) VALUES (?, 'old', '2026-01-01T00:00:00Z')", mine).lastInsertRowid;
  const oldPhoto = attach(target, me.id, JPEG, 'old.jpg');
  target.db.run("INSERT INTO files (task_id, user_id, path, name, mime, size) VALUES (?, ?, ?, 'old.jpg', 'image/jpeg', 10)", task, me.id, oldPhoto);

  const result = await target.portability.applyFile(file, { mode: 'account', user: me, replace: true });
  assert.deepEqual(result.replaced, { files: 1, tasks: 1, lists: 1, groups: 1 });
  assert.deepEqual(target.db.all('SELECT name FROM lists WHERE owner_id = ?', me.id).map((l) => l.name), ['Shopping']);
  assert.equal(target.db.get('SELECT COUNT(*) AS n FROM shares WHERE user_id = ?', me.id).n, 1, 'the friend’s list is still shared with her');
  assert.equal(fs.existsSync(target.suite.uploads.resolve(oldPhoto)), false, 'the old photo left the disk');
  assert.deepEqual(target.db.all('SELECT name FROM groups WHERE user_id = ?', me.id).map((g) => g.name), ['Home']);
});

test('a plan that doesn’t allow attachments brings the copy without them', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const file = path.join(source.dir, 'ana.zip');
  await exportTo(source, file, { scope: 'account', userId: s.ana.id });
  // An install whose plan leaves attachments out.
  const target = install(t, { DEFAULT_PLAN: 'free' });
  const me = target.suite.accounts.create({ username: 'me', displayName: 'Me' });
  assert.equal(target.suite.entitlements.can(me, 'attachments'), false);
  const result = await target.portability.applyFile(file, { mode: 'account', user: me });
  assert.equal(result.imported.files, 0);
  assert.deepEqual(result.left_out.files, { missing: 0, refused: 0, too_large: 0, plan: 2 });
  assert.equal(result.imported.tables.tasks, 4, 'the rest comes all the same');
});

/* ------------------------------ the whole install ----------------------------- */

test('a whole install into a clean one: accounts by email, new or left out; shares, numbers, grants and files kept', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const file = path.join(source.dir, 'install.zip');
  const manifest = await exportTo(source, file, { scope: 'install' });
  assert.equal(manifest.users, 3);
  assert.deepEqual(manifest.files, { count: 2, bytes: JPEG.length + PDF.length, missing: 0 });

  // The cloud: Ana already signed in there (a welcome group was made for her), Ben not yet.
  const cloud = install(t, { AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'sk_test', WORKOS_CLIENT_ID: 'client', WORKOS_AUTHKIT_DOMAIN: 'auth.example' });
  const anaHere = cloud.suite.accounts.create({ username: 'ana.cloud', displayName: 'Ana Cloud', email: 'ANA@example.com' });

  const plan = await cloud.portability.planFile(file, { mode: 'install' });
  const choice = (name) => plan.accounts.find((a) => a.source.username === name).choice;
  assert.deepEqual(choice('ana'), { action: 'map', user_id: anaHere.id, replace: false }, 'the same email, whatever its case');
  assert.deepEqual(choice('ben'), { action: 'create', username: 'ben', email: null });
  assert.deepEqual(choice('carl'), { action: 'create', username: 'carl', email: 'carl@example.com' });
  assert.deepEqual(plan.targets.find((u) => u.id === anaHere.id).owns, { groups: 1 });
  assert.equal(plan.accounts.find((a) => a.source.username === 'ana').rows.lists, 1);

  // A decision wins over a default (Ben into Ana's account leaves Ana as a new one), but two decisions can't share an account.
  const yielded = await cloud.portability.planFile(file, { mode: 'install', decisions: [{ source: 'ben', user_id: anaHere.id }] });
  assert.deepEqual(yielded.accounts.find((a) => a.source.username === 'ana').choice, { action: 'create', username: 'ana', email: null });
  await rejectsWith(cloud.portability.applyFile(file, {
    mode: 'install', decisions: [{ source: 'ben', user_id: anaHere.id }, { source: 'ana', user_id: anaHere.id }],
  }), 'import_target_taken');
  await rejectsWith(cloud.portability.applyFile(file, {
    mode: 'install', decisions: [{ source: 'ben', create: { email: 'ana@example.com' } }],
  }), 'import_email_taken');

  const result = await cloud.portability.applyFile(file, {
    mode: 'install', user: anaHere,
    decisions: [{ source: 'ben', create: { email: 'Ben@Example.com' } }, { source: 'carl', skip: true }],
  });
  assert.deepEqual(result.skipped, ['carl']);
  assert.deepEqual(result.imported.accounts, { created: 1, mapped: 1 });
  assert.deepEqual(result.imported.tables, { groups: 1, lists: 2, shares: 2, list_prefs: 2, tasks: 5, files: 2, branches: 2, entries: 3 });
  assert.equal(result.imported.grants, 1);

  const db = cloud.db;
  const ben = db.get("SELECT * FROM users WHERE username = 'ben'");
  assert.equal(ben.email, 'ben@example.com');
  assert.equal(ben.email_verified_at, null, 'an address typed now isn’t confirmed');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM groups WHERE user_id = ?', ben.id).n, 0, 'an imported account gets no welcome content');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM users WHERE username = 'carl'").n, 0);
  assert.equal(ben.password_hash === null || ben.password_hash === '!', true, 'no password travels');

  const shopping = db.get("SELECT * FROM lists WHERE name = 'Shopping'");
  const garden = db.get("SELECT * FROM lists WHERE name = 'Garden'");
  assert.equal(shopping.owner_id, anaHere.id);
  assert.equal(garden.owner_id, ben.id);
  assert.deepEqual(db.all('SELECT list_id, user_id FROM shares ORDER BY list_id').map((r) => ({ ...r })),
    [{ list_id: shopping.id, user_id: ben.id }, { list_id: garden.id, user_id: anaHere.id }], 'shared between the same people');
  assert.deepEqual(db.all('SELECT user_id, enabled FROM list_prefs WHERE list_id = ? ORDER BY user_id', shopping.id).map((r) => ({ ...r })),
    [{ user_id: anaHere.id, enabled: 1 }, { user_id: ben.id, enabled: 0 }]);
  assert.equal(db.get("SELECT created_by FROM tasks WHERE title = 'Milk'").created_by, ben.id);
  assert.equal(db.get("SELECT created_by FROM tasks WHERE title = 'Roses'").created_by, anaHere.id);
  const receipt = db.get("SELECT * FROM files WHERE name = 'receipt.pdf'");
  assert.equal(receipt.user_id, ben.id);
  assert.match(receipt.path, new RegExp(`^${ben.id}/`));
  assert.deepEqual(fs.readFileSync(cloud.suite.uploads.resolve(receipt.path)), PDF);
  assert.equal(JSON.parse(db.get('SELECT prefs FROM users WHERE id = ?', ben.id).prefs).default_list, garden.id);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM entitlement_grants WHERE subject_id = ? AND plan = 'full'", ben.id).n, 1);
  assert.equal(db.get("SELECT created_at FROM users WHERE id = ?", anaHere.id).created_at !== '2025-01-02T03:04:05.000Z', true,
    'an existing account keeps its own age');
  assert.deepEqual(db.all("SELECT action FROM audit_log WHERE action LIKE 'data.%'").map((a) => a.action), ['data.import']);
  assert.ok(cloud.events.some((e) => e.event === 'resync' && e.audience === null), 'everyone’s tabs reload');

  // The migration: when Ben signs in with WorkOS and that email, the account is his (workos-accounts.js).
  assert.equal(cloud.suite.accounts.unlinkedByEmail('workos', 'ben@example.com').id, ben.id);
  await rejectsWith(cloud.portability.applyFile(file, { mode: 'install', user: anaHere }), 'import_already_applied');
});

test('an account left out takes what is only theirs; what they shared with others loses them', async (t) => {
  const source = install(t);
  seedSource(source);
  const file = path.join(source.dir, 'install.zip');
  await exportTo(source, file, { scope: 'install' });
  const target = install(t);
  const result = await target.portability.applyFile(file, {
    mode: 'install', decisions: [{ source: 'ben', skip: true }, { source: 'carl', skip: true }],
  });
  assert.deepEqual(result.left_out.tables, { lists: 1, shares: 2, list_prefs: 1, tasks: 1 });
  const db = target.db;
  assert.deepEqual(db.all('SELECT name FROM lists').map((l) => l.name), ['Shopping']);
  assert.equal(db.get("SELECT created_by FROM tasks WHERE title = 'Milk'").created_by, null);
  assert.equal(db.get("SELECT user_id FROM files WHERE name = 'receipt.pdf'").user_id, null);
});

test('a whole install’s copy can’t go into someone’s account, and an account’s can go into an install', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const whole = path.join(source.dir, 'install.zip');
  const own = path.join(source.dir, 'ana.zip');
  await exportTo(source, whole, { scope: 'install' });
  await exportTo(source, own, { scope: 'account', userId: s.ana.id });
  const target = install(t);
  const me = target.suite.accounts.create({ username: 'me', displayName: 'Me' });
  await rejectsWith(target.portability.planFile(whole, { mode: 'account', user: me }), 'import_wrong_scope');
  const result = await target.portability.applyFile(own, { mode: 'install', decisions: [{ source: 'ana', create: { username: 'ana2' } }] });
  assert.deepEqual(result.accounts.map((a) => [a.username, a.created]), [['ana2', true]]);
});

/* ------------------------------ a copy isn't trusted ------------------------------ */

/** Copies the zip at `from` into `to`, changing its entries with `edit(name, bytes) → bytes | null`. */
async function tamper(from, to, edit, extra = []) {
  const zip = await openZip(from);
  const out = createZipWriter(fs.createWriteStream(to));
  for (const { name } of zip.entries) {
    const bytes = edit(name, await zip.read(name));
    if (bytes) await out.add(name, bytes);
  }
  for (const [name, bytes] of extra) await out.add(name, bytes);
  await out.finish();
  await zip.close();
  return to;
}
const editJson = (wanted, change) => (name, bytes) => (name === wanted
  ? Buffer.from(JSON.stringify(change(JSON.parse(bytes.toString('utf8'))))) : bytes);

test('a copy that isn’t right is refused, and says why', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const dir = source.dir;
  const own = path.join(dir, 'ana.zip');
  await exportTo(source, own, { scope: 'account', userId: s.ana.id });
  const target = install(t);
  const me = target.suite.accounts.create({ username: 'me', displayName: 'Me' });
  const plan = (file) => target.portability.planFile(file, { mode: 'account', user: me });

  const text = path.join(dir, 'notes.txt');
  fs.writeFileSync(text, 'not a zip at all, just words');
  await rejectsWith(plan(text), 'zip_invalid');
  await rejectsWith(plan(await tamper(own, path.join(dir, 'a.zip'), (n, b) => (n === 'manifest.json' ? null : b))), 'import_not_export');
  await rejectsWith(plan(await tamper(own, path.join(dir, 'b.zip'), editJson('manifest.json', (m) => ({ ...m, app: { id: 'tracker', name: 'Tracker' } })))), 'import_other_app');
  await rejectsWith(plan(await tamper(own, path.join(dir, 'c.zip'), editJson('manifest.json', (m) => ({ ...m, schema: { app: 1, suite: 99 } })))), 'import_newer_version');
  await rejectsWith(plan(await tamper(own, path.join(dir, 'd.zip'), editJson('data/lists.json', (rows) => rows.map((r) => ({ ...r, owner_is_admin: 1 }))))), 'import_invalid_data');
  await rejectsWith(plan(await tamper(own, path.join(dir, 'e.zip'), editJson('data/tasks.json', (rows) => [...rows, rows[0]]))), 'import_invalid_data');
  await rejectsWith(plan(await tamper(own, path.join(dir, 'f.zip'), editJson('data/tasks.json', (rows) => rows.map((r) => ({ ...r, title: { $gt: '' } }))))), 'import_invalid_data');
  await rejectsWith(plan(await tamper(own, path.join(dir, 'g.zip'), (n, b) => b, [['data/sessions.json', '[]']])), 'import_invalid_data');
  await rejectsWith(plan(await tamper(own, path.join(dir, 'h.zip'), editJson('data/users.json', (rows) => [...rows, { ...rows[0], id: 99, username: 'eve' }]))), 'import_invalid_data');
});

test('a crafted copy can’t reach anything already here, nor plant a page on the app’s domain', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const own = path.join(source.dir, 'ana.zip');
  await exportTo(source, own, { scope: 'account', userId: s.ana.id });
  const target = install(t);
  // So that ids here and in the copy don't happen to match: the copy's ids are its own anyway.
  target.suite.accounts.create({ username: 'first', displayName: 'First' });
  target.suite.accounts.create({ username: 'second', displayName: 'Second' });
  const victim = target.suite.accounts.create({ username: 'victim', displayName: 'Victim' });
  const victimList = target.db.run("INSERT INTO lists (owner_id, name) VALUES (?, 'Private')", victim.id).lastInsertRowid;
  const me = target.suite.accounts.create({ username: 'me', displayName: 'Me' });
  assert.notEqual(victim.id, s.ana.id);

  const crafted = await tamper(own, path.join(source.dir, 'crafted.zip'), (name, bytes) => {
    // The "photo" is a web page, a task points at a list that isn't in the copy, a share hands the list to the victim.
    if (name === `files/${s.photo}`) return HTML;
    if (name === 'data/tasks.json') {
      const rows = JSON.parse(bytes.toString('utf8'));
      return Buffer.from(JSON.stringify([...rows, { ...rows[0], id: 999, list_id: 777, title: 'planted' }]));
    }
    if (name === 'data/users.json') {
      const [ana] = JSON.parse(bytes.toString('utf8'));
      return Buffer.from(JSON.stringify([{ ...ana, role: 'admin', username: 'root', email: 'x@example.com', avatar_color: null }]));
    }
    // Two rows share one file: each gets its own copy.
    if (name === 'data/files.json') {
      const rows = JSON.parse(bytes.toString('utf8'));
      const receipt = rows.find((r) => r.name === 'receipt.pdf');
      return Buffer.from(JSON.stringify([...rows, { ...receipt, id: 999 }]));
    }
    return bytes;
  }, [['data/shares.json', JSON.stringify([{ id: 1, list_id: s.l1, user_id: victim.id }])]]);
  const result = await target.portability.applyFile(crafted, { mode: 'account', user: me });
  assert.deepEqual(result.left_out.files, { missing: 0, refused: 1, too_large: 0, plan: 0 });
  assert.equal(result.imported.files, 2);
  assert.equal(target.db.get("SELECT COUNT(*) AS n FROM files WHERE name = 'bread.jpg'").n, 0, 'the page never became an attachment');
  const receipts = target.db.all("SELECT path FROM files WHERE name = 'receipt.pdf'");
  assert.equal(receipts.length, 2);
  for (const { path: stored } of receipts) assert.deepEqual(fs.readFileSync(target.suite.uploads.resolve(stored)), PDF);
  assert.equal(target.suite.accounts.byId(me.id).avatar_color, '#000000', 'an empty value keeps what the account had');
  assert.equal(target.db.get("SELECT COUNT(*) AS n FROM tasks WHERE title = 'planted'").n, 0, 'a reference outside the copy goes nowhere');
  assert.equal(target.db.get('SELECT COUNT(*) AS n FROM tasks WHERE list_id = ?', victimList).n, 0, 'nothing lands in the victim’s list');
  assert.equal(target.db.get('SELECT COUNT(*) AS n FROM shares').n, 0, 'nothing is shared with anyone here');
  assert.deepEqual(target.db.all('SELECT name FROM lists WHERE owner_id = ?', victim.id).map((l) => l.name), ['Private']);
  const after = target.suite.accounts.byId(me.id);
  assert.deepEqual([after.username, after.role, after.email], ['me', 'user', null], 'a copy never changes who someone is');
  const everything = fs.readdirSync(target.suite.uploads.dir, { recursive: true }).map(String);
  assert.ok(everything.every((f) => !f.endsWith('.html')), 'no page on disk');
});

test('someone’s own copy can’t fill the memory, the account’s row or the disk', async (t) => {
  const source = install(t);
  const s = seedSource(source);
  const own = path.join(source.dir, 'ana.zip');
  await exportTo(source, own, { scope: 'account', userId: s.ana.id });
  const target = install(t);
  const me = target.suite.accounts.create({ username: 'me', displayName: 'Me' });
  const plan = (file) => target.portability.planFile(file, { mode: 'account', user: me, by: 'account' });
  const at = (name) => path.join(source.dir, name);

  // A few kB that would parse into seven million objects, gigabytes of memory: counted first, never parsed.
  const empties = Buffer.from(`[${'{},'.repeat(7_000_000)}{}]`);
  const values = await tamper(own, at('values.zip'), (name, bytes) => (name === 'data/tasks.json' ? empties : bytes));
  assert.ok(fs.statSync(values).size < 256 * 1024, 'the upload itself is small');
  await rejectsWith(plan(values), 'zip_too_large');

  // The account's row is read on every request: its preferences and the app's columns stay small.
  const user = (change) => editJson('data/users.json', ([ana]) => [{ ...ana, ...change }]);
  await rejectsWith(plan(await tamper(own, at('prefs.zip'), user({ prefs: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }) }))), 'import_invalid_data');
  await rejectsWith(plan(await tamper(own, at('color.zip'), user({ avatar_color: '#'.repeat(2000) }))), 'import_invalid_data');

  // Attachments: no more on disk than about twice what was uploaded. Ten MB "photos" of zeros deflate to almost nothing.
  const blank = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(10 * 1024 * 1024)]);
  const swollen = await tamper(own, at('files.zip'), (name, bytes) => (name.startsWith('files/') ? blank : bytes));
  await rejectsWith(target.portability.applyFile(swollen, { mode: 'account', user: me, by: 'account' }), 'zip_too_large');
  // And no more of them than the ceiling says.
  const one = target.suite.portabilityFor(DATA, { version: '1.0.0', limits: { files: { account: 1 } } });
  await rejectsWith(one.applyFile(own, { mode: 'account', user: me, by: 'account' }), 'zip_too_large');
  assert.equal(target.db.get('SELECT COUNT(*) AS n FROM lists').n, 0, 'nothing came in');
  assert.deepEqual(fs.readdirSync(path.join(target.dir, 'imports')), [], 'nothing left staged');

  // A real copy passes every ceiling.
  const result = await target.portability.applyFile(own, { mode: 'account', user: me, by: 'account' });
  assert.equal(result.imported.files, 2);
});

/* -------------------------------- command line -------------------------------- */

test('the command line: a whole install out, and in with emails given and an account left out', async (t) => {
  const source = install(t);
  seedSource(source);
  const file = path.join(source.dir, 'cli.zip');
  const out = [];
  const run = (box, ...argv) => runDataCli({
    suite: box.suite, declaration: DATA, version: '1.0.0', argv, log: (line) => out.push(line), error: (line) => out.push(`ERR ${line}`),
  });
  assert.equal(await run(source, 'export', file), 0);
  assert.match(out.join('\n'), /the whole install, 3 account\(s\)/);

  const cloud = install(t, { AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'sk_test', WORKOS_CLIENT_ID: 'client', WORKOS_AUTHKIT_DOMAIN: 'auth.example' });
  out.length = 0;
  assert.equal(await run(cloud, 'import', file, '--email', 'ben=ben@example.com', '--skip', 'carl'), 0);
  const shown = out.join('\n');
  assert.match(shown, /ben \(Ben, no email, \d+ of their own\)\n {4}→ a new account "ben" <ben@example.com>/);
  assert.match(shown, /carl .*\n {4}→ left out/);
  assert.match(shown, /Nothing done yet/);
  assert.equal(cloud.db.get('SELECT COUNT(*) AS n FROM lists').n, 0, 'only shown');

  out.length = 0;
  assert.equal(await run(cloud, 'import', file, '--email=ben=ben@example.com', '--skip', 'carl', '--apply'), 0);
  assert.match(out.join('\n'), /Imported: groups 1, lists 2, shares 2/);
  assert.equal(cloud.db.get("SELECT email FROM users WHERE username = 'ben'").email, 'ben@example.com');
  assert.equal(cloud.db.get("SELECT COUNT(*) AS n FROM users WHERE username = 'carl'").n, 0);

  out.length = 0;
  assert.equal(await run(cloud, 'import', file, '--apply'), 1, 'the same copy twice is refused');
  assert.match(out.join('\n'), /ALREADY IMPORTED HERE|Refused: import_already_applied/);
  out.length = 0;
  assert.equal(await run(cloud, 'import', file, '--bogus'), 2);
  assert.match(out.join('\n'), /--bogus is not an option/);
});

/* ----------------------------------- routes ----------------------------------- */

test('the routes: someone’s own data down and up, the whole install for the admin only, nobody else’s pending import', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-data-http-'));
  const suite = createSuite({
    config: PRODUCT, migrations: MIGRATIONS, log: () => {}, exitOnError: false,
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', ADMIN_PASSWORD: 'root-password' },
  });
  const app = createApp({ suite, version: '1.0.0', handleSignals: false, log: () => {}, portable: DATA });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const ana = suite.accounts.create({ username: 'ana', displayName: 'Ana', password: 'ana-password' });
  const ben = suite.accounts.create({ username: 'ben', displayName: 'Ben', password: 'ben-password' });
  suite.database.run("INSERT INTO lists (owner_id, name, next_number) VALUES (?, 'Mine', 3)", ana.id);

  const signIn = async (username, password) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username, password }),
    });
    assert.equal(res.status, 200);
    return res.headers.getSetCookie().find((c) => c.startsWith('demo_sid=')).split(';')[0];
  };
  const asAna = await signIn('ana', 'ana-password');
  const asBen = await signIn('ben', 'ben-password');
  const asAdmin = await signIn('admin', 'root-password');
  const call = (cookie, method, pathname, body, type = 'application/json') => fetch(base + pathname, {
    method, headers: { Cookie: cookie, Origin: base, ...(body !== undefined ? { 'Content-Type': type } : {}) },
    body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body,
  });

  assert.equal((await fetch(`${base}/api/me/export`)).status, 401);
  const download = await call(asAna, 'GET', '/api/me/export');
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/zip');
  assert.match(download.headers.get('content-disposition'), /attachment; filename="demo-ana-\d{4}-\d\d-\d\d\.zip"/);
  const zip = Buffer.from(await download.arrayBuffer());
  assert.equal(zip.subarray(0, 2).toString(), 'PK');

  assert.equal((await call(asAna, 'GET', '/api/admin/export')).status, 403, 'the whole install is the admin’s');
  const whole = await call(asAdmin, 'GET', '/api/admin/export');
  assert.equal(whole.status, 200);
  await whole.arrayBuffer();

  // Ben brings in Ana's copy (she gave it to him): first what it would do, then doing it.
  const upload = await call(asBen, 'POST', '/api/me/import', zip, 'application/zip');
  assert.equal(upload.status, 200);
  const plan = await upload.json();
  assert.equal(plan.mode, 'account');
  assert.deepEqual(plan.copy.tables, { lists: 1 });
  assert.match(plan.import_id, /^[\w-]{24}$/);
  assert.equal((await call(asAna, 'POST', `/api/me/import/${plan.import_id}`, {})).status, 404, 'someone else’s upload is never found');
  assert.equal((await call(asAdmin, 'POST', `/api/admin/import/${plan.import_id}`, {})).status, 404, 'nor under the other mode');
  const applied = await call(asBen, 'POST', `/api/me/import/${plan.import_id}`, { replace: false });
  assert.equal(applied.status, 200);
  assert.deepEqual((await applied.json()).imported.tables, { lists: 1 });
  assert.equal(suite.database.get("SELECT owner_id FROM lists WHERE name = 'Mine' AND owner_id = ?", ben.id).owner_id, ben.id);
  assert.equal((await call(asBen, 'POST', `/api/me/import/${plan.import_id}`, {})).status, 404, 'an applied upload is gone');

  const again = await (await call(asBen, 'POST', '/api/me/import', zip, 'application/zip')).json();
  assert.ok(again.copy.applied_at);
  assert.equal((await call(asBen, 'DELETE', `/api/me/import/${again.import_id}`)).status, 204);
  assert.equal((await call(asBen, 'POST', '/api/me/import', Buffer.from('nope'), 'application/zip')).status, 400);
  assert.equal((await call(asBen, 'POST', '/api/admin/import', zip, 'application/zip')).status, 403);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'imports')), [], 'no upload left waiting');

  const config = await (await fetch(`${base}/api/auth/config`)).json();
  assert.equal(config.app.modules.data, true);

  // Opening copies is braked per account: ben runs out, ana doesn't.
  const statuses = [];
  for (let i = 0; i < 10; i++) statuses.push((await call(asBen, 'POST', '/api/me/import', Buffer.from('nope'), 'application/zip')).status);
  assert.equal(statuses.at(-1), 429, statuses.join(' '));
  assert.equal((await call(asAna, 'POST', '/api/me/import', Buffer.from('nope'), 'application/zip')).status, 400);
});
