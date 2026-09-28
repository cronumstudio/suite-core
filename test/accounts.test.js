/**
 * Accounts: the users table in the suite's shape, the rules that hold whoever
 * calls, and the audit log.
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
import { createSessions } from '../sessions.js';
import { createAudit } from '../audit.js';
import { hashPassword } from '../crypto.js';
import { workosUsers } from '../workos-accounts.js';

const quiet = { log: () => {} };
const plain = (rows) => rows.map((row) => ({ ...row }));

function setup(t, prepare = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-accounts-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  prepare(database);
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', ...quiet });
  return database;
}

const request = (ip = '192.0.2.7') => ({ headers: { 'user-agent': 'Test browser' }, socket: { remoteAddress: ip } });

test('the users table: created whole, or an app’s own completed and its dates made ISO', (t) => {
  const fresh = setup(t);
  for (const column of ['username', 'email', 'email_verified_at', 'locale', 'theme', 'prefs', 'last_login_at', 'disabled_at']) {
    assert.ok(fresh.columnsOf('users').includes(column), column);
  }

  const old = setup(t, (d) => {
    // Next's table before the suite, with its own column the suite leaves alone.
    d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', email TEXT,
      workos_user_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    d.run(`INSERT INTO users (username, display_name, role, email, workos_user_id, created_at)
      VALUES ('ada', 'Ada', 'admin', 'ada@example.com', 'user_01', '2025-03-01 09:30:00'), ('bob', 'Bob', 'user', NULL, NULL, '2025-04-02 18:00:05')`);
  });
  const rows = plain(old.all('SELECT username, email_verified_at, created_at, workos_user_id, theme FROM users ORDER BY id'));
  assert.equal(rows[0].created_at, '2025-03-01T09:30:00.000Z');
  assert.equal(rows[1].created_at, '2025-04-02T18:00:05.000Z');
  assert.ok(rows[0].email_verified_at, 'an email WorkOS gave is verified');
  assert.equal(rows[1].email_verified_at, null);
  assert.equal(rows[0].workos_user_id, 'user_01', 'the app’s own columns stay');
  assert.equal(rows[0].theme, 'system');
});

test('creating: names, passwords, emails and roles checked; the app’s columns and hooks', (t) => {
  const database = setup(t, (d) => d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'user', color TEXT, created_at TEXT)`));
  const seen = [];
  const accounts = createAccounts({
    database, extraColumns: () => ({ color: '#3366ff' }), onCreate: (user) => seen.push(`options:${user.username}`),
  });
  accounts.whenCreated((user) => seen.push(`hook:${user.username}`));

  const ada = accounts.create({ username: 'ada', displayName: 'Ada Lovelace', password: 'correct horse', role: 'admin', email: ' Ada@Example.com ' });
  assert.equal(ada.color, '#3366ff');
  assert.equal(ada.email, 'ada@example.com');
  assert.match(ada.created_at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(seen, ['options:ada', 'hook:ada']);

  const code = (fn) => { try { fn(); } catch (err) { return `${err.status} ${err.code}${err.extra?.field ? ` ${err.extra.field}` : ''}`; } return 'ok'; };
  assert.equal(code(() => accounts.create({ username: 'ADA', password: 'another one!' })), '409 username_taken');
  assert.equal(code(() => accounts.create({ username: 'a b', password: 'correct horse' })), '400 field_invalid username');
  assert.equal(code(() => accounts.create({ username: 'eve', password: 'short' })), '400 field_too_short password');
  assert.equal(code(() => accounts.create({ username: 'eve', email: 'not-an-email' })), '400 field_invalid email');
  assert.equal(code(() => accounts.create({ username: 'eve', role: 'root' })), '400 field_invalid role');

  const sso = accounts.create({ username: 'sso-only' });
  assert.equal(sso.password_hash, null, 'no password: signs in elsewhere');
  assert.equal(accounts.publicUser(sso).has_password, false);
  assert.equal(accounts.publicUser(ada).password_hash, undefined, 'the hash never leaves');
});

test('signing in: the right password, never a disabled account, old hashes redone', (t) => {
  const database = setup(t);
  let now = Date.parse('2026-05-01T10:00:00Z');
  const accounts = createAccounts({ database, clock: () => now });
  const ada = accounts.create({ username: 'ada', password: 'correct horse', role: 'admin' });
  accounts.create({ username: 'bob', password: 'battery staple', role: 'admin' });

  assert.equal(accounts.verify('ada', 'wrong horse'), null);
  assert.equal(accounts.verify('nobody', 'correct horse'), null);
  assert.equal(accounts.verify('ADA', 'correct horse').id, ada.id, 'usernames ignore case');
  assert.equal(accounts.byId(ada.id).last_login_at, '2026-05-01T10:00:00.000Z');

  // A hash made with less than today's cost is redone once the password is known.
  database.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword('correct horse', { N: 1024 }), ada.id);
  now += 1000;
  assert.ok(accounts.verify('ada', 'correct horse'));
  assert.match(accounts.byId(ada.id).password_hash, /^scrypt\$16384\$/);

  accounts.update(ada.id, { disabled: true });
  assert.equal(accounts.verify('ada', 'correct horse'), null, 'a disabled account never signs in');

  accounts.signedIn(ada.id);
  assert.equal(accounts.byId(ada.id).last_login_at, '2026-05-01T10:00:01.000Z');
});

test('the admin’s rules: never without an administrator, sessions end when they should', (t) => {
  const database = setup(t);
  const sessions = createSessions({ database, secret: 's3cret', cookieName: 'sid' });
  const accounts = createAccounts({ database, sessions });
  const root = accounts.create({ username: 'root', password: 'correct horse', role: 'admin' });
  const ada = accounts.create({ username: 'ada', password: 'correct horse' });
  const code = (fn) => { try { fn(); } catch (err) { return `${err.status} ${err.code}`; } return 'ok'; };

  assert.equal(code(() => accounts.update(root.id, { role: 'user' })), '409 last_admin');
  assert.equal(code(() => accounts.update(root.id, { disabled: true })), '409 last_admin');
  assert.equal(code(() => accounts.remove(root.id)), '409 last_admin');
  assert.equal(code(() => accounts.update(999, { displayName: 'x' })), '404 user_not_found');

  // Disabling ends every session of the person.
  const phone = sessions.open(ada.id, { req: request() });
  const laptop = sessions.open(ada.id, { req: request() });
  accounts.update(ada.id, { disabled: true });
  assert.equal(sessions.alive(phone), null);
  assert.equal(sessions.alive(laptop), null);
  accounts.update(ada.id, { disabled: false, role: 'admin', email: 'ada@example.com', displayName: 'Ada L.' });
  const back = accounts.byId(ada.id);
  assert.equal(back.disabled_at, null);
  assert.equal(back.role, 'admin');
  assert.equal(back.display_name, 'Ada L.');
  assert.equal(back.email_verified_at, null, 'an email the admin types is not verified');

  // A new password closes the other sessions, not the one that changed it.
  const mine = sessions.open(ada.id, { req: request() });
  const other = sessions.open(ada.id, { req: request() });
  accounts.setPassword(ada.id, 'a much better one', { exceptToken: mine });
  assert.ok(sessions.alive(mine));
  assert.equal(sessions.alive(other), null);
  assert.ok(accounts.verify('ada', 'a much better one'));

  // Now there are two administrators: one of them can go.
  const removed = [];
  accounts.whenRemoved((id) => removed.push(id));
  assert.equal(code(() => accounts.remove(root.id)), 'ok');
  assert.deepEqual(removed, [root.id]);
  assert.equal(accounts.activeAdmins(), 1);
});

test('a hook that fails undoes the change', (t) => {
  const database = setup(t);
  const accounts = createAccounts({ database });
  accounts.whenCreated((user) => { if (user.username === 'mallory') throw new Error('refused by the app'); });
  assert.throws(() => accounts.create({ username: 'mallory' }), /refused by the app/);
  assert.equal(accounts.byUsername('mallory'), null);
});

test('the audit log: who, what, from where, never content; newest first, paged', (t) => {
  const database = setup(t);
  let now = Date.parse('2026-05-01T10:00:00Z');
  const accounts = createAccounts({ database });
  const ada = accounts.create({ username: 'ada', role: 'admin' });
  const audit = createAudit({ database, trustProxy: '1', clock: () => now });

  audit.record({ action: 'auth.login', actor: ada, req: { headers: { 'x-forwarded-for': '198.51.100.4' }, socket: { remoteAddress: '10.0.0.2' } } });
  now += 1000;
  audit.record({ action: 'admin.user.create', actor: ada.id, targetType: 'user', targetId: 7, meta: { role: 'user' } });
  now += 1000;
  audit.record({ action: 'admin.plan.set', actor: ada, targetType: 'user', targetId: 7, meta: { plan: 'pro' } });

  const all = audit.list();
  assert.deepEqual(all.map((e) => e.action), ['admin.plan.set', 'admin.user.create', 'auth.login']);
  assert.equal(all[2].ip, '198.51.100.4', 'the address the proxy saw');
  assert.equal(all[2].actor_username, 'ada');
  assert.deepEqual(all[1].meta, { role: 'user' });
  assert.equal(all[1].target_id, '7');
  assert.deepEqual(audit.list({ action: 'admin.' }).map((e) => e.action), ['admin.plan.set', 'admin.user.create']);
  assert.deepEqual(audit.list({ before: all[0].id, limit: 1 }).map((e) => e.action), ['admin.user.create']);

  // The actor may go; what they did stays, without them.
  accounts.create({ username: 'root', role: 'admin' });
  accounts.remove(ada.id);
  assert.equal(audit.list()[0].actor_user_id, null);

  now += 400 * 24 * 3600 * 1000;
  assert.equal(audit.purge(365), 3);
});

test('identities: one row per provider and account, taken over from the old column', (t) => {
  const database = setup(t, (d) => {
    // Next's table with a WorkOS link kept the old way.
    d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', email TEXT,
      workos_user_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    d.run(`INSERT INTO users (username, display_name, role, email, workos_user_id)
      VALUES ('ada', 'Ada', 'admin', 'ada@example.com', 'user_01ADA'), ('bob', 'Bob', 'user', 'bob@example.com', NULL)`);
  });
  const accounts = createAccounts({ database });
  assert.equal(accounts.byIdentity('workos', 'user_01ADA')?.username, 'ada', 'copied by the migration');
  assert.deepEqual(accounts.identitiesOf(1).map((i) => i.provider), ['workos']);

  // Bob had an account before the provider: found by his email, then linked.
  assert.equal(accounts.unlinkedByEmail('workos', 'BOB@example.com')?.username, 'bob');
  accounts.linkIdentity(2, 'workos', 'user_02BOB', { email: 'bob@example.com' });
  assert.equal(accounts.unlinkedByEmail('workos', 'bob@example.com'), null);
  assert.ok(accounts.byId(2).email_verified_at, 'the provider vouches for the email');
  assert.throws(() => accounts.linkIdentity(1, 'workos', 'user_02BOB'), /UNIQUE/, 'one account per provider account');

  // Someone new, created and linked at once.
  const eve = accounts.create({ username: 'eve', displayName: 'Eve', identity: { provider: 'oidc', subject: 'abc', email: 'Eve@Example.com' } });
  assert.equal(eve.email, 'eve@example.com');
  assert.ok(eve.email_verified_at);
  assert.equal(accounts.byIdentity('oidc', 'abc').id, eve.id);
  accounts.usedIdentity('oidc', 'abc');
  assert.ok(accounts.byId(eve.id).last_login_at);
  assert.ok(accounts.identitiesOf(eve.id)[0].last_used_at);

  assert.equal(accounts.unlinkIdentity(eve.id, 'oidc'), true);
  assert.equal(accounts.byIdentity('oidc', 'abc'), null);
  accounts.remove(2);
  assert.equal(accounts.byIdentity('workos', 'user_02BOB'), null, 'identities go with their account');
});

test('the WorkOS users on the suite: links from an older version adopted, never taken as unlinked', (t) => {
  const database = setup(t, (d) => {
    d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', email TEXT,
      workos_user_id TEXT, mcp_token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    d.run(`INSERT INTO users (username, display_name, password_hash, role, email, mcp_token)
      VALUES ('root', 'Root', '!', 'admin', NULL, 'h1')`);
  });
  // Tasks: password_hash NOT NULL and a column of its own that must be set.
  let n = 1;
  const accounts = createAccounts({ database, extraColumns: () => ({ mcp_token: `h${++n}` }) });
  const users = workosUsers(accounts, { database });

  // A link made by the old code after the migration ran: adopted when asked for.
  database.run("UPDATE users SET workos_user_id = 'user_ROOT' WHERE id = 1");
  assert.equal(users.firstUnlinkedAdmin(), null, 'already linked the old way');
  assert.equal(users.byWorkosId('user_ROOT')?.username, 'root');
  assert.equal(accounts.byIdentity('workos', 'user_ROOT')?.id, 1);

  const ada = users.create({ username: 'ada', displayName: 'Ada', role: 'user', email: 'ada@example.com', workosId: 'user_ADA' });
  assert.equal(ada.password_hash, '!', 'no password, where the table wants one');
  assert.equal(ada.mcp_token, 'h2');
  assert.equal(users.byWorkosId('user_ADA').id, ada.id);
  assert.equal(accounts.verify('ada', '!'), null);
  assert.throws(() => users.create({ username: 'ada2', displayName: 'Ada', role: 'user', email: null, workosId: 'user_ADA' }), /UNIQUE/);
  assert.equal(accounts.byUsername('ada2'), null, 'the losing race leaves nothing behind');

  users.signedIn(ada, { id: 'user_ADA' });
  assert.ok(accounts.byId(ada.id).last_login_at);
  assert.equal(users.usernameTaken('ADA'), true);
});

test('the same email again stays confirmed; another one has to be confirmed', (t) => {
  const database = setup(t);
  const accounts = createAccounts({ database });
  const ada = accounts.create({ username: 'ada', email: 'ada@example.com' });
  accounts.setVerifiedEmail(ada.id, 'ada@example.com');
  accounts.update(ada.id, { email: ' ADA@example.com ' });
  assert.ok(accounts.byId(ada.id).email_verified_at, 'the same address, written differently');
  accounts.update(ada.id, { email: 'ada@work.example' });
  assert.equal(accounts.byId(ada.id).email_verified_at, null);
  assert.equal(accounts.byId(ada.id).email, 'ada@work.example');
  accounts.update(ada.id, { email: null });
  assert.equal(accounts.byId(ada.id).email, null);
});
