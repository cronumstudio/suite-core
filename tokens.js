/**
 * API tokens: what someone pastes into Claude, ChatGPT or a script instead of
 * signing in. One per client, each revocable on its own, shown once and kept
 * only as a hash.
 *
 * The apps' `mcp_tokens` table becomes `api_tokens` with the same rows and the
 * same hashes: no connector stops working. A token has scopes (`mcp` is the
 * only one the apps use today) and may expire.
 */
import { randomToken, sha256 } from './crypto.js';
import { badRequest } from './http.js';
import { ensureColumn } from './migrate.js';

const iso = (ms) => new Date(ms).toISOString();

export function tokensSchema(d) {
  if (!d.columnsOf('api_tokens').length && d.columnsOf('mcp_tokens').length) {
    d.exec('ALTER TABLE mcp_tokens RENAME TO api_tokens');
    d.exec('DROP INDEX IF EXISTS idx_mcp_tokens_user');
  }
  d.exec(`CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    scopes       TEXT NOT NULL DEFAULT 'mcp',
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    expires_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_api_tokens_user ON api_tokens (user_id)`);
  ensureColumn(d, 'api_tokens', 'scopes', "scopes TEXT NOT NULL DEFAULT 'mcp'");
  ensureColumn(d, 'api_tokens', 'expires_at', 'expires_at TEXT');
  // SQLite's datetime('now') (UTC, without the T) to ISO, like every other date of the suite.
  for (const column of ['created_at', 'last_used_at']) {
    d.exec(`UPDATE api_tokens SET ${column} = strftime('%Y-%m-%dT%H:%M:%fZ', ${column})
      WHERE ${column} NOT LIKE '%T%' AND strftime('%s', ${column}) IS NOT NULL`);
  }
}

/** The scopes the suite knows. An app may add its own. */
export const SCOPES = Object.freeze(['mcp', 'read', 'write']);

/**
 * @param {object} options
 * @param {object} options.database
 * @param {string} [options.prefix]    how the app's tokens start (`mcp_`), to recognise them
 * @param {string[]} [options.scopes]
 * @param {number} [options.maxPerUser]
 */
export function createTokens({
  database, prefix = 'mcp_', scopes: known = SCOPES, maxPerUser = 50, clock = () => Date.now(),
}) {
  const columns = 'id, name, prefix, scopes, created_at, last_used_at, expires_at';
  const view = (row) => row && { ...row, scopes: String(row.scopes || '').split(' ').filter(Boolean) };

  function checkScopes(scopes) {
    const list = [...new Set(Array.isArray(scopes) ? scopes : [scopes])];
    if (!list.length || list.some((s) => !known.includes(s))) throw badRequest('field_invalid', { field: 'scopes', options: known });
    return list;
  }

  /** A new token. Its value is returned here, once; only its hash is kept. */
  function create(userId, { name = 'MCP', scopes = ['mcp'], expiresAt = null } = {}) {
    const clean = String(name ?? '').trim().slice(0, 60);
    if (!clean) throw badRequest('field_required', { field: 'name' });
    const list = checkScopes(scopes);
    let ends = null;
    if (expiresAt != null) {
      const ms = Date.parse(expiresAt);
      if (Number.isNaN(ms) || ms <= clock()) throw badRequest('field_invalid', { field: 'expires_at' });
      ends = iso(ms);
    }
    const count = Number(database.get('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?', userId).n);
    if (count >= maxPerUser) throw badRequest('too_many_tokens', { max: maxPerUser });
    const token = `${prefix}${randomToken(24)}`;
    const { lastInsertRowid } = database.run(`INSERT INTO api_tokens
      (user_id, name, token_hash, prefix, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    userId, clean, sha256(token), token.slice(0, 12), list.join(' '), iso(clock()), ends);
    return { token, row: view(database.get(`SELECT ${columns} FROM api_tokens WHERE id = ?`, lastInsertRowid)) };
  }

  const list = (userId) => database.all(`SELECT ${columns} FROM api_tokens WHERE user_id = ?
    ORDER BY created_at DESC, id DESC`, userId).map(view);

  const revoke = (userId, id) => database.run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', id, userId).changes > 0;

  const revokeAllOf = (userId) => database.run('DELETE FROM api_tokens WHERE user_id = ?', userId).changes;

  /**
   * The account of a token, or null: unknown, expired, without the scope, or
   * of a disabled account. Its last use is noted, at most once a minute.
   */
  function authenticate(token, { scope = 'mcp' } = {}) {
    if (!token || typeof token !== 'string' || token.length > 200) return null;
    const now = iso(clock());
    const row = database.get(`SELECT t.id AS token_id, t.scopes AS token_scopes, t.last_used_at AS token_used_at, u.*
      FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND (t.expires_at IS NULL OR t.expires_at > ?)`, sha256(token), now);
    if (!row || row.disabled_at) return null;
    if (scope && !String(row.token_scopes).split(' ').includes(scope)) return null;
    if (!row.token_used_at || clock() - Date.parse(row.token_used_at) > 60 * 1000) {
      database.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now, row.token_id);
    }
    // The account, plus which token it came with (`token_id`), for the log.
    const user = { ...row };
    delete user.token_scopes;
    delete user.token_used_at;
    return user;
  }

  /** Forgets tokens that expired more than a month ago. */
  const purge = () => database.run('DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at < ?',
    iso(clock() - 30 * 24 * 3600 * 1000)).changes;

  return { create, list, revoke, revokeAllOf, authenticate, purge, prefix };
}
