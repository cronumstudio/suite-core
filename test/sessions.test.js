/**
 * Sessions, the secret they are signed with, the brake and the suite's
 * migrations, against a real database file.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { createSessions, resolveSessionSecret } from '../sessions.js';
import { createRateLimiter } from '../rate-limit.js';

const quiet = { log: () => {} };
const DAY = 24 * 3600 * 1000;

function setup(t, prepare = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-sessions-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL)`);
  database.run("INSERT INTO users (id, username) VALUES (1, 'ada'), (2, 'bob')");
  prepare(database);
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', ...quiet });
  return database;
}

/** A request and a response good enough for the session module. */
const request = (cookie = '', headers = {}) => ({
  headers: { cookie, 'user-agent': 'Test browser', ...headers }, socket: { remoteAddress: '192.0.2.7' },
});
const response = () => {
  const headers = {};
  return {
    headers,
    getHeader: (name) => headers[name.toLowerCase()],
    setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
  };
};
const cookieFrom = (res) => [res.headers['set-cookie']].flat().pop().split(';')[0];

test('the secret: from the environment, else generated once, never an example', (t) => {
  const database = setup(t);
  assert.equal(resolveSessionSecret(database, { value: 'a-real-secret-of-a-real-install', ...quiet }),
    'a-real-secret-of-a-real-install');
  const generated = resolveSessionSecret(database, { value: '', ...quiet });
  assert.ok(generated.length >= 40);
  assert.equal(resolveSessionSecret(database, { value: undefined, ...quiet }), generated, 'kept for next time');
  assert.equal(resolveSessionSecret(database, { value: 'change-me', ...quiet }), generated, 'examples are ignored');
});

test('a session: opened, recognised, slid, closed', (t) => {
  const database = setup(t);
  let now = Date.parse('2026-01-01T10:00:00Z');
  const sessions = createSessions({ database, secret: 's3cret', cookieName: 'sid', idleDays: 30, maxDays: 365, clock: () => now });

  const res = response();
  const token = sessions.open(1, { req: request(), res });
  assert.equal(cookieFrom(res), `sid=${token}`);
  assert.match(res.headers['set-cookie'], /HttpOnly; SameSite=Lax/);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?', token).n, 0,
    'only a keyed hash is stored, never the token');
  assert.equal(sessions.userFrom(request(`sid=${token}`)).username, 'ada');
  assert.equal(sessions.userFrom(request('sid=forged')), null);

  now += 29 * DAY;
  assert.ok(sessions.userFrom(request(`sid=${token}`)), 'used on day 29: still alive, and pushed 30 days on');
  now += 29 * DAY;
  assert.ok(sessions.userFrom(request(`sid=${token}`)), 'day 58: alive thanks to the use on day 29');
  now += 31 * DAY;
  assert.equal(sessions.userFrom(request(`sid=${token}`)), null, 'a month without use: over');

  const again = sessions.open(1, { req: request() });
  assert.ok(sessions.userFrom(request(`sid=${again}`)));
  assert.equal(sessions.close(again), null);
  assert.equal(sessions.userFrom(request(`sid=${again}`)), null);
});

test('no session outlives maxDays, however much it is used', (t) => {
  const database = setup(t);
  let now = Date.parse('2026-01-01T10:00:00Z');
  const sessions = createSessions({ database, secret: 's', cookieName: 'sid', idleDays: 30, maxDays: 90, clock: () => now });
  const token = sessions.open(1);
  for (let day = 20; day < 90; day += 20) {
    now = Date.parse('2026-01-01T10:00:00Z') + day * DAY;
    assert.ok(sessions.userFrom(request(`sid=${token}`)), `day ${day}`);
  }
  now = Date.parse('2026-01-01T10:00:00Z') + 90 * DAY + 1000;
  assert.equal(sessions.userFrom(request(`sid=${token}`)), null);
});

test('signing in closes the browser’s previous session; a password change closes the others', (t) => {
  const database = setup(t);
  const sessions = createSessions({ database, secret: 's', cookieName: 'sid' });
  const planted = sessions.open(1);
  const fresh = sessions.open(1, { req: request(`sid=${planted}`) });
  assert.equal(sessions.userFrom(request(`sid=${planted}`)), null, 'the token from before the sign-in is dead');
  assert.ok(sessions.userFrom(request(`sid=${fresh}`)));

  const phone = sessions.open(1);
  const laptop = sessions.open(1);
  const bobs = sessions.open(2);
  assert.equal(sessions.closeAllOf(1, { exceptToken: laptop }), 2);
  assert.equal(sessions.userFrom(request(`sid=${phone}`)), null);
  assert.ok(sessions.userFrom(request(`sid=${laptop}`)));
  assert.ok(sessions.userFrom(request(`sid=${bobs}`)), 'other people are untouched');
});

test('where someone is signed in: listed with the device, and revocable one by one', (t) => {
  const database = setup(t);
  const sessions = createSessions({ database, secret: 's', cookieName: 'sid' });
  const here = sessions.open(1, { req: request('', { 'user-agent': 'Laptop' }) });
  sessions.open(1, { req: request('', { 'user-agent': 'Phone' }) });
  const list = sessions.list(1, here);
  assert.equal(list.length, 2);
  assert.deepEqual(list.filter((s) => s.current).map((s) => s.user_agent), ['Laptop']);
  assert.ok(list.every((s) => s.key.length === 16 && s.ip === '192.0.2.7'));
  const phone = list.find((s) => !s.current);
  assert.equal(sessions.revoke(2, phone.key), false, 'nobody closes someone else’s session');
  assert.equal(sessions.revoke(1, phone.key), true);
  assert.equal(sessions.list(1, here).length, 1);
});

test('the sessions of an app before suite-core carry on, signed in', (t) => {
  // The table as Tasks, Projects and Next had it, with a live session in it.
  const token = 'old-token';
  const secret = 'install-secret';
  const hash = crypto.createHmac('sha256', secret).update(token).digest('base64url');
  const database = setup(t, (d) => {
    d.exec(`CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, workos_sid TEXT)`);
    d.run("INSERT INTO sessions (token, user_id, expires_at, workos_sid) VALUES (?, 1, datetime('now', '+20 days'), 'authkit_1')", hash);
  });
  assert.deepEqual(database.columnsOf('sessions').sort(), ['absolute_expires_at', 'created_at', 'expires_at',
    'idp_session_id', 'ip', 'last_used_at', 'token_hash', 'user_agent', 'user_id']);
  const row = database.get('SELECT * FROM sessions');
  assert.match(row.expires_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, 'dates become ISO 8601 with Z');
  const sessions = createSessions({ database, secret, cookieName: 'sid' });
  assert.equal(sessions.userFrom(request(`sid=${token}`)).username, 'ada', 'nobody is signed out');
  assert.equal(sessions.close(token), 'authkit_1', 'the identity provider’s session is still known');
});

test('the suite’s migrations run once and then change nothing', (t) => {
  const database = setup(t);
  assert.deepEqual(migrate(database, SUITE_MIGRATIONS, { scope: 'suite', ...quiet }), []);
});

test('the brake: per account, per address, tokens only on failure, persisted', (t) => {
  const database = setup(t);
  let now = Date.parse('2026-01-01T10:00:00Z');
  const limiter = createRateLimiter({ database, secret: 'k', clock: () => now, trustProxy: false });
  const from = (ip) => ({ headers: {}, socket: { remoteAddress: ip } });

  for (let i = 0; i < 10; i++) {
    assert.equal(limiter.checkLogin(from(`198.51.100.${i}`), 'Ada').allowed, true);
    limiter.loginFailed(from(`198.51.100.${i}`), 'Ada');
  }
  const refused = limiter.checkLogin(from('198.51.100.99'), 'ada');
  assert.equal(refused.allowed, false, 'ten failures lock the account, from any address');
  assert.ok(refused.retryAfter > 0 && refused.retryAfter <= 900);
  assert.equal(limiter.checkLogin(from('198.51.100.99'), 'bob').allowed, true, 'other accounts are not locked');
  assert.equal(database.get("SELECT COUNT(*) AS n FROM login_attempts WHERE bucket LIKE '%ada%'").n, 0,
    'the table does not say which account');

  const reopened = createRateLimiter({ database, secret: 'k', clock: () => now, trustProxy: false });
  assert.equal(reopened.checkLogin(from('203.0.113.1'), 'ada').allowed, false, 'a restart does not forget');
  now += 15 * 60 * 1000 + 1000;
  assert.equal(reopened.checkLogin(from('203.0.113.1'), 'ada').allowed, true, 'after the window, free again');

  for (let i = 0; i < 30; i++) limiter.tokenFailed(from('192.0.2.50'));
  assert.equal(limiter.checkToken(from('192.0.2.50')).allowed, true, 'thirty bad tokens are still allowed');
  limiter.tokenFailed(from('192.0.2.50'));
  assert.equal(limiter.checkToken(from('192.0.2.50')).allowed, false, 'the next one is not');
  limiter.tokenSucceeded(from('192.0.2.50'));
  assert.equal(limiter.checkToken(from('192.0.2.50')).allowed, true, 'a good token clears the address');

  for (let i = 0; i < 30; i++) assert.equal(limiter.allowRegistration(from('192.0.2.60')).allowed, true);
  assert.equal(limiter.allowRegistration(from('192.0.2.60')).allowed, false);
  now += 16 * 60 * 1000;
  assert.ok(limiter.purge() > 0, 'what left the window is purged');
});
