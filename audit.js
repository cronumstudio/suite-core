/**
 * Who did what, and when: the audit log.
 *
 * Sign-ins and failures, sessions and tokens, what the admin changes, plans and
 * payments. It says who, when, what and from where — never what anybody wrote:
 * no titles, no notes, no passwords. A log is no place for people's content.
 */
import { clientIp } from './http.js';

export function auditSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    at              TEXT NOT NULL,
    actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    action          TEXT NOT NULL,
    target_type     TEXT,
    target_id       TEXT,
    ip              TEXT,
    meta            TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS ix_audit_at ON audit_log (at);
  CREATE INDEX IF NOT EXISTS ix_audit_actor ON audit_log (actor_user_id)`);
}

export function createAudit({ database, trustProxy = process.env.TRUST_PROXY, clock = () => Date.now() }) {
  /**
   * Records an action: `auth.login`, `admin.user.create`, `billing.grant`…
   * `meta` holds small facts (a plan id, a role), never content.
   */
  function record({ action, actor = null, req = null, organizationId = null, targetType = null, targetId = null, meta = {} }) {
    database.run(`INSERT INTO audit_log (at, actor_user_id, organization_id, action, target_type, target_id, ip, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    new Date(clock()).toISOString(), actor?.id ?? actor ?? null, organizationId, action, targetType,
    targetId == null ? null : String(targetId), req ? clientIp(req, { trustProxy }) : null, JSON.stringify(meta || {}));
  }

  /** The newest entries first, optionally before an id (paging), of an actor or an action. */
  function list({ limit = 100, before = null, actorId = null, action = null } = {}) {
    const where = [];
    const params = [];
    if (before) { where.push('a.id < ?'); params.push(before); }
    if (actorId) { where.push('a.actor_user_id = ?'); params.push(actorId); }
    if (action) { where.push('a.action LIKE ?'); params.push(`${action}%`); }
    return database.all(`SELECT a.*, u.username AS actor_username FROM audit_log a
      LEFT JOIN users u ON u.id = a.actor_user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`,
    ...params, Math.min(Math.max(1, Number(limit) || 100), 500))
      .map((row) => ({ ...row, meta: JSON.parse(row.meta || '{}') }));
  }

  /** Forgets entries older than `days`. */
  const purge = (days = 365) => database.run('DELETE FROM audit_log WHERE at < ?',
    new Date(clock() - days * 24 * 3600 * 1000).toISOString()).changes;

  return { record, list, purge };
}
