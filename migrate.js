/**
 * Numbered migrations.
 *
 * The apps grew their schema by running `CREATE TABLE IF NOT EXISTS` and
 * adding missing columns on every start. It works, but every backfill runs
 * again at each start and the order lives in people's heads. From here on a
 * change to the schema is a numbered migration: applied once, in order, in its
 * own transaction, and recorded in `schema_migrations`.
 *
 * Two scopes share the table: `suite` (the tables of suite-core) and `app` (the
 * app's own). An app adopting this keeps its old schema code as migration 1,
 * `baseline`: it is idempotent, so an existing database passes through it
 * untouched and a new one is created whole; new changes are 2, 3…
 *
 * Rules: a migration that has been applied is never edited (a mistake is fixed
 * by a new one); versions go 1, 2, 3… without gaps; a database whose recorded
 * versions this code does not know was written by a newer release, and the
 * server refuses to start on it rather than guess.
 */

const TABLE = `CREATE TABLE schema_migrations (
  scope      TEXT NOT NULL,
  version    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (scope, version)
)`;

/**
 * Creates the table, or brings Focus's older one (without `scope`, whose rows
 * are all the app's) into this shape.
 */
function ensureTable(database) {
  const columns = database.columnsOf('schema_migrations');
  if (!columns.length) {
    database.exec(TABLE);
    return;
  }
  if (columns.includes('scope')) return;
  database.tx(() => {
    database.exec('ALTER TABLE schema_migrations RENAME TO schema_migrations_old');
    database.exec(TABLE);
    database.exec(`INSERT INTO schema_migrations (scope, version, name, applied_at)
      SELECT 'app', version, name, COALESCE(applied_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      FROM schema_migrations_old`);
    database.exec('DROP TABLE schema_migrations_old');
  });
}

/** Refuses a list with gaps, repeats or nameless steps: a typo must not skip a migration. */
function checkList(migrations, scope) {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`Migrations (${scope}): expected version ${i + 1}, found ${m.version}`);
    }
    if (!m.name || typeof m.up !== 'function') {
      throw new Error(`Migrations (${scope}): version ${m.version} needs a name and an up() function`);
    }
  });
}

/**
 * Applies the migrations of `scope` that are missing, in order, and returns
 * the versions it applied. `up(database)` gets the suite's database handle.
 */
export function migrate(database, migrations, { scope = 'app', log = console.log } = {}) {
  checkList(migrations, scope);
  ensureTable(database);

  const applied = new Map(database.all(
    'SELECT version, name FROM schema_migrations WHERE scope = ?', scope,
  ).map((row) => [row.version, row.name]));
  for (const [version, name] of applied) {
    const known = migrations[version - 1];
    if (!known || known.name !== name) {
      throw new Error(`The database has migration ${scope} ${version} (${name}), which this version `
        + 'of the application does not know: it was written by a newer release.');
    }
  }

  const done = [];
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.tx(() => {
      migration.up(database);
      database.run('INSERT INTO schema_migrations (scope, version, name, applied_at) VALUES (?, ?, ?, ?)',
        scope, migration.version, migration.name, new Date().toISOString());
    });
    done.push(migration.version);
    log(`[db] migration ${scope} ${migration.version} (${migration.name}) applied`);
  }
  return done;
}

/** Adds a column if the table lacks it: the building block of baseline migrations. */
export function ensureColumn(database, table, column, definition) {
  if (database.columnsOf(table).includes(column)) return false;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  return true;
}
