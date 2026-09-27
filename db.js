/**
 * The database handle every suite module receives.
 *
 * One SQLite file per app, opened with the pragmas all the apps already use:
 * WAL (readers don't wait for a writer), foreign keys on (SQLite has them off
 * by default, and then the schema lies), and a busy timeout. The handle is a
 * plain object —`all`, `get`, `run`, `exec`, `tx`, `getMeta`, `setMeta`— so a
 * module never imports the app's database: it is handed this.
 *
 * An app that already opens its own `DatabaseSync` wraps it with
 * `wrapDatabase(db)` and keeps using its own helpers alongside.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Opens (and creates) the database. `path` defaults to
 * `DATA_DIR/<name>.db`, with DATA_DIR from the environment or `./data`.
 */
export function openDatabase({ path, name = 'app', dataDir = process.env.DATA_DIR || join(process.cwd(), 'data') } = {}) {
  const file = path || join(dataDir, `${name}.db`);
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return wrapDatabase(db, { path: file });
}

/** The suite's handle around a `DatabaseSync` the app already has. */
export function wrapDatabase(db, { path = null } = {}) {
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const run = (sql, ...params) => {
    const result = db.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  };

  // Installation settings: the session secret when the environment has none,
  // VAPID keys… Idempotent, so it is safe on a database that already has it.
  db.exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

  let depth = 0;
  /**
   * Runs `fn` in a transaction and returns what it returns. Nested calls
   * become savepoints, so a helper that opens its own transaction can be
   * called from inside another. `fn` must be synchronous: node:sqlite is, and
   * an await inside would let other requests write in the middle.
   */
  function tx(fn) {
    const savepoint = depth ? `sp_${depth}` : null;
    db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    depth++;
    try {
      const value = fn();
      if (value && typeof value.then === 'function') {
        throw new TypeError('Transactions must be synchronous');
      }
      db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
      return value;
    } catch (error) {
      try {
        db.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      } catch { /* the error that matters is the original one */ }
      throw error;
    } finally {
      depth--;
    }
  }

  return {
    db, path, all, get, run, tx,
    exec: (sql) => db.exec(sql),
    getMeta: (key) => get('SELECT value FROM app_meta WHERE key = ?', key)?.value ?? null,
    setMeta: (key, value) => run(
      'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key, String(value),
    ),
    /** Names of a table's columns (empty if the table doesn't exist). */
    columnsOf: (table) => all(`PRAGMA table_info("${String(table).replaceAll('"', '""')}")`).map((c) => c.name),
    close: () => db.close(),
  };
}
