/**
 * API tokens: the apps' mcp_tokens adopted without breaking a connector,
 * scopes, expiry, and who a token is.
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
import { createTokens } from '../tokens.js';
import { createAccounts } from '../accounts.js';
import { sha256 } from '../crypto.js';

const DAY = 24 * 3600 * 1000;

function setup(t, prepare = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-tokens-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  prepare(database);
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  return database;
}

const code = (fn) => { try { fn(); } catch (err) { return `${err.status} ${err.code}`; } return 'ok'; };

test('an app’s mcp_tokens become api_tokens: same rows, same hashes, dates in ISO', (t) => {
  const old = 'mcp_the-token-claude-already-has';
  const database = setup(t, (d) => {
    // Next's and Tasks' table, as it is today.
    d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user');
      CREATE TABLE mcp_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT);
      CREATE INDEX idx_mcp_tokens_user ON mcp_tokens(user_id);`);
    d.run("INSERT INTO users (username, display_name) VALUES ('ada', 'Ada')");
    d.run(`INSERT INTO mcp_tokens (id, user_id, name, token_hash, prefix, created_at, last_used_at)
      VALUES (7, 1, 'Claude', ?, 'mcp_the-toke', '2026-03-01 10:00:00', '2026-03-02 11:30:00')`, sha256(old));
  });
  assert.equal(database.columnsOf('mcp_tokens').length, 0, 'renamed, not copied');
  const row = { ...database.get('SELECT * FROM api_tokens WHERE id = 7') };
  assert.equal(row.scopes, 'mcp');
  assert.equal(row.created_at, '2026-03-01T10:00:00.000Z');
  assert.equal(row.last_used_at, '2026-03-02T11:30:00.000Z');

  const tokens = createTokens({ database });
  const who = tokens.authenticate(old);
  assert.equal(who?.username, 'ada', 'the connector keeps working');
  assert.equal(who.token_id, 7);
  assert.equal(who.token_hash, undefined);
});

test('a token: shown once, kept as a hash, listed without it, revoked on its own', (t) => {
  const database = setup(t);
  let now = Date.parse('2026-05-01T10:00:00Z');
  const accounts = createAccounts({ database });
  const ada = accounts.create({ username: 'ada' });
  const bob = accounts.create({ username: 'bob' });
  const tokens = createTokens({ database, clock: () => now });

  const { token, row } = tokens.create(ada.id, { name: '  Claude  ' });
  assert.match(token, /^mcp_[\w-]{20,}$/);
  assert.equal(row.name, 'Claude');
  assert.equal(row.prefix, token.slice(0, 12));
  assert.deepEqual(row.scopes, ['mcp']);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM api_tokens WHERE token_hash = ?', token).n, 0, 'never in clear');
  assert.equal(tokens.list(ada.id)[0].token_hash, undefined);
  assert.equal(tokens.list(bob.id).length, 0);

  assert.equal(tokens.authenticate(token).id, ada.id);
  assert.equal(tokens.list(ada.id)[0].last_used_at, '2026-05-01T10:00:00.000Z');
  now += 30 * 1000;
  tokens.authenticate(token);
  assert.equal(tokens.list(ada.id)[0].last_used_at, '2026-05-01T10:00:00.000Z', 'at most once a minute');
  now += 60 * 1000;
  tokens.authenticate(token);
  assert.equal(tokens.list(ada.id)[0].last_used_at, '2026-05-01T10:01:30.000Z');

  assert.equal(tokens.revoke(bob.id, row.id), false, 'only its owner revokes it');
  assert.equal(tokens.revoke(ada.id, row.id), true);
  assert.equal(tokens.authenticate(token), null);
  assert.equal(tokens.authenticate('mcp_made-up'), null);
  assert.equal(tokens.authenticate(''), null);
  assert.equal(tokens.authenticate('x'.repeat(500)), null);
});

test('scopes, expiry, disabled accounts, limits', (t) => {
  const database = setup(t);
  let now = Date.parse('2026-05-01T10:00:00Z');
  const accounts = createAccounts({ database });
  const ada = accounts.create({ username: 'ada' });
  accounts.create({ username: 'root', role: 'admin' });
  const tokens = createTokens({ database, maxPerUser: 3, clock: () => now });

  const reader = tokens.create(ada.id, { name: 'Script', scopes: ['read'] });
  assert.equal(tokens.authenticate(reader.token), null, 'not for the MCP');
  assert.equal(tokens.authenticate(reader.token, { scope: 'read' }).id, ada.id);
  assert.equal(code(() => tokens.create(ada.id, { scopes: ['root'] })), '400 field_invalid');
  assert.equal(code(() => tokens.create(ada.id, { scopes: [] })), '400 field_invalid');
  assert.equal(code(() => tokens.create(ada.id, { name: ' ' })), '400 field_required');
  assert.equal(code(() => tokens.create(ada.id, { expiresAt: '2026-04-01T00:00:00Z' })), '400 field_invalid', 'not in the past');

  const brief = tokens.create(ada.id, { name: 'Brief', expiresAt: '2026-05-02T10:00:00Z' });
  assert.ok(tokens.authenticate(brief.token));
  assert.equal(code(() => tokens.create(ada.id, { name: 'One more' })), 'ok');
  assert.equal(code(() => tokens.create(ada.id, { name: 'Too many' })), '400 too_many_tokens');

  const lasting = tokens.list(ada.id).find((r) => r.name === 'One more');
  accounts.update(ada.id, { disabled: true });
  assert.equal(tokens.authenticate(brief.token), null, 'a disabled account’s tokens open nothing');
  accounts.update(ada.id, { disabled: false });

  now += 2 * DAY;
  assert.equal(tokens.authenticate(brief.token), null, 'expired');
  assert.equal(tokens.purge(), 0, 'kept a month, to be seen in the list');
  now += 31 * DAY;
  assert.equal(tokens.purge(), 1);
  assert.ok(tokens.list(ada.id).some((r) => r.id === lasting.id));

  // Tokens go with their account.
  accounts.remove(ada.id);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM api_tokens').n, 0);
});
