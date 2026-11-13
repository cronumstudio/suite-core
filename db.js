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

/** Statements kept prepared per handle, by their text: the most used stay, the oldest unused go first. */
const STATEMENTS_KEPT = 500;
/** What is kept prepared: reads and writes of rows. Never a PRAGMA (some answer what they found when prepared) nor DDL. */
const KEEPABLE = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i;

/** The suite's handle around a `DatabaseSync` the app already has. */
export function wrapDatabase(db, { path = null } = {}) {
  // Each call prepared its statement again, and preparing was up to half of a route's CPU
  // (audit of 6/11, perf-srv-6). A statement here is only ever run whole (all, get, run: never
  // iterated), so one kept is never in use when it is asked for again; SQLite prepares it again by
  // itself when the schema changes, and every call binds all its parameters anew (those not given
  // are null, as in a new one). Text made with a varying number of `?` is kept too, up to the cap.
  const kept = new Map();
  const statement = (sql) => {
    // A connection whose prepare() was replaced on it (the modules' tests count statements so)
    // prepares each one as before: what it counts stays the statements run.
    if (Object.hasOwn(db, 'prepare')) return db.prepare(sql);
    let found = kept.get(sql);
    if (found) {
      // Most recently used last: what goes first is what was used least recently.
      kept.delete(sql);
      kept.set(sql, found);
      return found;
    }
    found = db.prepare(sql);
    if (typeof sql === 'string' && KEEPABLE.test(sql)) {
      if (kept.size >= STATEMENTS_KEPT) kept.delete(kept.keys().next().value);
      kept.set(sql, found);
    }
    return found;
  };
  const all = (sql, ...params) => statement(sql).all(...params);
  const get = (sql, ...params) => statement(sql).get(...params);
  const run = (sql, ...params) => {
    const result = statement(sql).run(...params);
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
    /**
     * Lets SQLite gather what its planner needs (`PRAGMA optimize`): without it, it has no
     * statistics and chooses blind (perf-srv-6). `first`, at the start: every table that has none
     * yet (0x10002), ~0.1 s on the audit's database of 70 MB; later (the clean-ups), only the tables
     * whose data changed enough to matter. Whole tables, never a sample (`analysis_limit`): sampled
     * statistics made My Day's queries choose a date index over the list's, ten times slower.
     */
    optimize: ({ first = false } = {}) => {
      db.exec(first ? 'PRAGMA optimize = 0x10002' : 'PRAGMA optimize');
    },
    close: () => {
      kept.clear();
      db.close();
    },
  };
}
