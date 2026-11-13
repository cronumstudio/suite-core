/**
 * A database that ran suite migration 13 before 0.255.0 put `session_key` into it: migration 30
 * brings the column, and turning notices on and the clean-up work there again.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { createPush, generateVapidKeys } from '../push.js';

function deviceKeys() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  return {
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  };
}

test('a database from before 0.255.0 gets push_subscriptions.session_key', () => {
  const database = openDatabase({ path: ':memory:' });
  const log = () => {};
  migrate(database, SUITE_MIGRATIONS.filter((m) => m.version <= 29), { scope: 'suite', log });
  // As version 13 left it before 0.255.0.
  database.exec('ALTER TABLE push_subscriptions DROP COLUMN session_key');
  assert.ok(!database.columnsOf('push_subscriptions').includes('session_key'));

  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log });
  assert.ok(database.columnsOf('push_subscriptions').includes('session_key'));

  const user = database.run("INSERT INTO users (username, password_hash, display_name) VALUES ('ana', 'x', 'Ana')").lastInsertRowid;
  const push = createPush({ database, vapid: { ...generateVapidKeys(), subject: 'mailto:a@b.c' }, log });
  const n = push.subscribe(Number(user), {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc', ...deviceKeys(), sessionKey: '0123456789abcdef0123',
  });
  assert.equal(n, 1);
  assert.equal(database.get('SELECT session_key FROM push_subscriptions').session_key, '0123456789abcdef');
  assert.doesNotThrow(() => push.purgeSessions());
});

test('a new database runs migration 30 without changing anything', () => {
  const database = openDatabase({ path: ':memory:' });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const columns = database.columnsOf('push_subscriptions');
  assert.equal(columns.filter((c) => c === 'session_key').length, 1);
  assert.ok(columns.includes('lang'));
});
