/**
 * Copies of an account or of a whole install, and bringing them into another
 * install: from local accounts on a NAS to the cloud and back, or someone's
 * own data to take elsewhere (the GDPR's portability).
 *
 * A copy is a zip anyone can open (zip.js):
 *
 *   manifest.json        what it is: app, version, schema, scope, date, counts
 *   data/users.json      the accounts in it and their profile —never a password—
 *   data/<table>.json    the rows of every table the app declares, as they are
 *   suite/grants.json    (whole install) the plans given: by the administrator or paid for
 *   suite/billing.json   (whole install) who each account is at the payment provider, and its
 *                        subscriptions, so that payments still find them (billing.js)
 *   files/<path>         the attachments, byte for byte
 *
 * The app says what its data is —its tables, which column points at which
 * table or at an account, which column is a file— and the rest is done here,
 * the same way for every app:
 *
 * · **Whose rows.** A row belongs to a copy when every reference it can't do
 *   without (NOT NULL) points at something in the copy: a list whose owner is
 *   in it, a task whose list is, a share whose list and person both are. An
 *   optional reference that points outside is emptied (who added a task to my
 *   list, when that person isn't in the copy). So someone's copy takes their
 *   lists with everything in them, and leaves out what they share with other
 *   people —lists shared with them, their own shares—, counted and said.
 * · **New ids.** Importing never writes an id from the file: every row gets a
 *   new one and every reference is translated, so a copy can't touch what was
 *   already there; references that close a circle (Next's branches and
 *   entries) are set once both ends exist. What people see —the numbers of
 *   tasks, dates, the order, the trash— is plain data, and travels as it is.
 * · **Accounts.** A person's copy goes into the account that imports it. A
 *   whole install's goes, account by account, where the administrator says:
 *   an account already here (the one with the same email, by default), a new
 *   one —with WorkOS it is linked by itself when that person signs in with
 *   that email—, or nowhere. An existing account takes the preferences of the
 *   copy (name shown, theme, language, the app's own) and keeps who it is
 *   (username, email, role). Passwords, second steps, sessions, API tokens,
 *   OAuth grants and push subscriptions never travel: they are made again.
 * · **The file isn't trusted.** It could come from anyone: only the columns
 *   this install has, only plain values, references only inside the file,
 *   attachments only when their first bytes say image or PDF (as on upload),
 *   ceilings on every size, and a copy is applied once.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomToken } from './crypto.js';
import {
  HttpError, badRequest, notFound, conflict, forbidden, unauthorized, readJson, sendJson, int,
} from './http.js';
import { createZipWriter, openZip } from './zip.js';
import { detectType, storedName } from './uploads.js';
import { USERNAME } from './accounts.js';

export const EXPORT_FORMAT = 'cronum-suite-export';
export const EXPORT_VERSION = 1;

/** The profile of an account that travels: never its password, second step or identities elsewhere. */
const USER_COLUMNS = ['id', 'username', 'display_name', 'email', 'email_verified_at', 'role', 'locale', 'theme',
  'prefs', 'created_at', 'disabled_at'];

const MB = 1024 * 1024;
const DAY = 24 * 3600 * 1000;
/** An account's preferences, and each of the app's own columns of it, in a copy. */
const MAX_PREFS = 64 * 1024;
const MAX_USER_VALUE = 1024;
/**
 * Any text in a row, unless the app gives that column its own limit: far
 * above what the apps write (Tasks' notes, 10,000 characters; Next's
 * details, 4,000), far below what one value could take of a copy's memory.
 */
const MAX_TEXT = 100_000;
/** A pending import waits this long for its "apply"; then it goes. */
const PENDING_MS = DAY;
const TOKEN = /^[\w-]{16,64}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;
const invalidData = (table, extra = {}) => badRequest('import_invalid_data', { table, ...extra });

/** Which copies were imported here, so the same one is never applied twice. */
export function dataImportsSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS data_imports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    export_id   TEXT NOT NULL,
    scope       TEXT NOT NULL,
    target      TEXT NOT NULL,
    imported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    app_version TEXT,
    counts      TEXT NOT NULL DEFAULT '{}',
    imported_at TEXT NOT NULL,
    UNIQUE (export_id, target)
  )`);
}

/* ------------------------------- the declaration ------------------------------ */

/**
 * The app's declaration, checked against its database. A mistake here is the
 * app's, and stops the start: copies that silently miss data are worse.
 *
 *   {
 *     tables: {                      // in the order rows are created on import
 *       lists: { refs: { owner_id: 'users', group_id: 'list_groups' } },
 *       tasks: { refs: { list_id: 'lists', created_by: 'users' }, clean(row) { … },
 *                limits: { title: 500, color: /^#[0-9a-f]{6}$/i } },
 *       task_files: { refs: { task_id: 'tasks', user_id: 'users' },
 *                     file: { path: 'path', folder: 'user_id', feature: 'attachments' } },
 *     },
 *     users: { columns: ['avatar_color'], limits: { avatar_color: /^#[0-9a-f]{6}$/i },
 *              prefs(prefs, { ids, current, created }) { … } },
 *     check({ user, counts, replaced }) { … },   // limits of the plan, for someone's own import
 *   }
 *
 * `limits` are what the app's own screens accept, per column: a number is the
 * most characters, and longer text is cut there; a pattern is the shape, and
 * a value without it is left out (the column's default; for a profile, what
 * the account has). A copy is a file anyone can write: without them, a name
 * of megabytes reached everyone the list was shared with. Text without a
 * limit is cut at MAX_TEXT.
 *
 * A reference to a table declared later, or to the same one, is set after
 * every row exists, so its column must allow NULL. Every table needs a NOT NULL
 * reference to an account or to an earlier table: that is how whose rows they
 * are is told.
 */
export function describeData(database, declaration = {}) {
  const errors = [];
  const names = Object.keys(declaration.tables || {});
  const tables = [];
  names.forEach((name, index) => {
    const spec = declaration.tables[name] || {};
    const info = database.all(`PRAGMA table_info(${quote(name)})`);
    if (!info.length) { errors.push(`${name}: there is no such table`); return; }
    const columns = new Map(info.map((c) => [c.name, c]));
    const key = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    const keyed = key.length === 1 && key[0].name === 'id' && /^integer$/i.test(key[0].type);
    if (!key.length) errors.push(`${name}: a table needs a primary key`);
    const refs = [];
    for (const [column, target] of Object.entries(spec.refs || {})) {
      const col = columns.get(column);
      if (!col) { errors.push(`${name}.${column}: there is no such column`); continue; }
      const at = target === 'users' ? -1 : names.indexOf(target);
      if (target !== 'users' && at < 0) { errors.push(`${name}.${column}: "${target}" is not one of the tables declared`); continue; }
      const deferred = at >= index;
      const required = Number(col.notnull) === 1;
      if (deferred && required) errors.push(`${name}.${column} points at ${target}, declared at or after ${name}: the column must allow NULL`);
      if (deferred && !keyed) errors.push(`${name}.${column}: a table without an integer id can only point at earlier tables`);
      refs.push({ column, target, required, deferred });
    }
    if (!refs.some((r) => r.required)) {
      errors.push(`${name}: it needs a NOT NULL reference to users or to an earlier table, or whose rows they are can't be told`);
    }
    let file = null;
    if (spec.file) {
      file = {
        path: spec.file.path || 'path', name: spec.file.name || 'name', mime: spec.file.mime || 'mime',
        size: spec.file.size || 'size', folder: spec.file.folder || null, feature: spec.file.feature || null,
      };
      for (const role of ['path', 'name', 'mime', 'size']) {
        if (!columns.has(file[role])) errors.push(`${name}: file.${role} "${file[role]}" is not a column`);
      }
      if (file.folder && !refs.some((r) => r.column === file.folder && r.target === 'users')) {
        errors.push(`${name}: file.folder must be a column that points at users`);
      }
    }
    tables.push({
      name, keyed, key: key.map((c) => c.name), columns: new Set(columns.keys()), refs, file,
      clean: typeof spec.clean === 'function' ? spec.clean : null,
      limits: limitsOf(spec.limits, columns, name, errors),
    });
  });
  for (const table of tables) {
    for (const ref of table.refs) {
      const target = tables.find((t) => t.name === ref.target);
      if (target && !target.keyed) errors.push(`${table.name}.${ref.column}: ${ref.target} has no integer id to point at`);
      // Attachments that can't be imported are left out after the rows are chosen: nothing may hang from them.
      if (target?.file) errors.push(`${table.name}.${ref.column}: nothing may point at a table of files (${ref.target})`);
    }
  }
  const inUsers = new Set(database.columnsOf('users'));
  const appColumns = [...(declaration.users?.columns || [])];
  for (const column of appColumns) {
    if (!inUsers.has(column)) errors.push(`users.${column}: there is no such column`);
    if (USER_COLUMNS.includes(column) || ['password_hash', 'two_factor_secret'].includes(column)) {
      errors.push(`users.${column}: not one of the app's own columns`);
    }
  }
  const userLimits = limitsOf(declaration.users?.limits, new Map(appColumns.map((c) => [c, true])), 'users', errors);
  if (errors.length) throw new Error(`The app's data declaration (portable) has errors:\n  ${errors.join('\n  ')}`);
  return {
    tables,
    byName: new Map(tables.map((t) => [t.name, t])),
    userColumns: [...USER_COLUMNS.filter((c) => inUsers.has(c)), ...appColumns],
    appColumns,
    userLimits,
    prefs: typeof declaration.users?.prefs === 'function' ? declaration.users.prefs : null,
    check: typeof declaration.check === 'function' ? declaration.check : null,
  };
}

/** A declaration's `limits`, checked: a Map of column → most characters, or pattern. */
function limitsOf(spec, columns, name, errors) {
  const limits = new Map();
  for (const [column, limit] of Object.entries(spec || {})) {
    if (!columns.has(column)) errors.push(`${name}.${column}: a limit for a column that isn't there`);
    else if (!(limit instanceof RegExp) && !(Number.isSafeInteger(limit) && limit > 0)) {
      errors.push(`${name}.${column}: a limit is a number of characters or a pattern`);
    } else limits.set(column, limit);
  }
  return limits;
}

/** Text cut to `max` characters, never through the middle of one (an emoji is two). */
function cut(text, max) {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * A value of a copy within the limit the app gives its column (see
 * describeData), or undefined when it doesn't have the shape the column takes.
 */
function within(value, limit) {
  if (typeof value !== 'string') return value;
  if (limit instanceof RegExp) return limit.test(value) ? value : undefined;
  return cut(value, limit ?? MAX_TEXT);
}

/* ------------------------------- whose rows are ------------------------------- */

/**
 * The rows that go into a copy —or into this install— given which accounts
 * are in it. `rowsOf(name, ids)` gives a table's rows, at least those that can
 * concern the accounts inside (`ids`: per earlier table, the ids kept so far);
 * `inside(userId)` says whether
 * an account is. Returns the rows kept (copies: optional references pointing
 * outside are emptied) and, with `account`, how many rows that concern that
 * person were left out, per table: what is shared with other people.
 */
export function selectRows(model, rowsOf, inside, { account = null } = {}) {
  const kept = new Map();
  const ids = new Map();
  const leftOut = {};
  for (const table of model.tables) {
    const rows = [];
    const keptIds = new Set();
    let left = 0;
    for (const source of rowsOf(table.name, ids)) {
      const row = { ...source };
      let belongs = true;
      let concerns = false;
      for (const ref of table.refs) {
        const value = row[ref.column];
        // A reference to a later table is settled below, once that table is decided.
        if (value == null || ref.deferred) continue;
        const isIn = ref.target === 'users' ? inside(value) : ids.get(ref.target).has(value);
        if (account != null && (ref.target === 'users' ? value === account : isIn && ref.required)) concerns = true;
        if (isIn) continue;
        if (ref.required) belongs = false;
        else row[ref.column] = null;
      }
      if (belongs) {
        rows.push(row);
        if (table.keyed) keptIds.add(row.id);
      } else if (concerns) {
        left += 1;
      }
    }
    kept.set(table.name, rows);
    ids.set(table.name, keptIds);
    if (left) leftOut[table.name] = left;
  }
  for (const table of model.tables) {
    for (const ref of table.refs.filter((r) => r.deferred)) {
      for (const row of kept.get(table.name)) {
        if (row[ref.column] != null && !ids.get(ref.target).has(row[ref.column])) row[ref.column] = null;
      }
    }
  }
  return { kept, leftOut };
}

/** Per account, how many rows of each table are theirs alone: what their own copy would take. */
export function ownership(model, rowsOf) {
  const owners = new Map();
  const counts = new Map();
  for (const table of model.tables) {
    const byId = new Map();
    for (const row of rowsOf(table.name)) {
      let set = null;
      for (const ref of table.refs) {
        if (!ref.required) continue;
        const value = row[ref.column];
        const of = ref.target === 'users' ? new Set([value]) : owners.get(ref.target).get(value) || new Set();
        set = set ? new Set([...set].filter((user) => of.has(user))) : of;
      }
      if (table.keyed) byId.set(row.id, set || new Set());
      for (const user of set || []) {
        const count = counts.get(user) || {};
        count[table.name] = (count[table.name] || 0) + 1;
        counts.set(user, count);
      }
    }
    owners.set(table.name, byId);
  }
  return counts;
}

const countsOf = (kept) => Object.fromEntries([...kept].filter(([, rows]) => rows.length).map(([name, rows]) => [name, rows.length]));

/* ------------------------------ values in the file ----------------------------- */

/** A value as it goes into JSON: blobs (none of the apps has one today) as base64. */
const toJson = (value) => (value instanceof Uint8Array ? { $blob: Buffer.from(value).toString('base64') } : value);

/** A value from the file as SQLite takes it, or undefined when it isn't a plain value. */
function fromJson(value) {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (isObject(value) && Object.keys(value).length === 1 && typeof value.$blob === 'string') return Buffer.from(value.$blob, 'base64');
  return undefined;
}

const isId = (value) => Number.isSafeInteger(value) && value > 0;
/** Where a grant came from (admin, paddle, stripe…), and how long a payment provider's id may be. */
const SOURCE = /^[a-z0-9_-]{1,40}$/;
const MAX_REF = 200;

/**
 * How many values JSON text can hold at most. Every value but the first comes
 * after a comma, and an object or array opens with a brace or bracket; those
 * inside strings only make the count higher, never lower.
 */
function countValues(bytes) {
  let count = 1;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0x2c || byte === 0x7b || byte === 0x5b) count += 1;
  }
  return count;
}

/* -------------------------------- the service ---------------------------------- */

/**
 * @param {object} options
 * @param {object} options.database, options.accounts         the suite's
 * @param {object} [options.uploads]      where attachments live (modules.uploads)
 * @param {object} [options.entitlements] to leave attachments out of an import a plan doesn't allow
 * @param {object} [options.live]         to tell open tabs to reload after an import
 * @param {object} [options.audit]
 * @param {object} options.app            { id, name, version }
 * @param {string[]} [options.roles]      the install's roles: an unknown one comes in as 'user'
 * @param {string} options.dataDir        pending imports wait in DATA_DIR/imports
 * @param {object} options.declaration    what the app's data is (see describeData)
 */
export function createPortability({
  database, accounts, uploads = null, entitlements = null, live = null, audit = null, app, roles = ['admin', 'user'],
  baseUrl = null, authProvider = 'local', dataDir, declaration, log = console.log, clock = () => Date.now(),
  limits = {},
}) {
  const model = describeData(database, declaration);
  const importsDir = path.join(dataDir, 'imports');
  // Ceilings by who brings the copy in: anyone with an account ('account'), or the
  // administrator and the command line ('install'). Someone's own data is a few MB;
  // these leave room for years of it and keep one upload from filling the memory.
  const byWho = (value, account, install) => (isObject(value) ? { account, install, ...value }
    : value != null ? { account: value, install: value } : { account, install });
  const max = {
    upload: { account: 512 * MB, install: 4096 * MB, ...(limits.upload || {}) },
    // Bytes of data once inflated, in all and per file.
    data: byWho(limits.data, 64 * MB, 512 * MB),
    entry: byWho(limits.entry, 32 * MB, 256 * MB),
    // Values in the data (rows, fields), counted before parsing: an empty row is
    // three bytes of JSON and some sixty of memory, so bytes alone don't bound it.
    values: byWho(limits.values, 2_000_000, 50_000_000),
    // Attachments in one copy.
    files: byWho(limits.files, 20_000, 1_000_000),
  };
  const iso = () => new Date(clock()).toISOString();
  const rowsOfDb = (name) => {
    const table = model.byName.get(name);
    return database.all(`SELECT * FROM ${quote(name)} ORDER BY ${table.key.map(quote).join(', ')}`);
  };

  /**
   * rowsOf() for selectRows() when the copy is of a few accounts (`userIds`):
   * only the rows that point at one of them, or whose required reference
   * points at a row already kept. Those are all that can belong to the copy
   * or concern it; the rest of the install stays in the database. Reading
   * every table whole made one person's copy cost, in time with the server
   * stopped and in memory, as much as everybody's data (x-stability-1).
   */
  const rowsNear = (userIds) => (name, ids) => {
    const table = model.byName.get(name);
    const where = [];
    const params = [];
    for (const ref of table.refs) {
      if (ref.deferred || (ref.target !== 'users' && !ref.required)) continue;
      where.push(`${quote(ref.column)} IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(ref.target === 'users' ? userIds : [...ids.get(ref.target)]));
    }
    return database.all(`SELECT * FROM ${quote(name)} WHERE ${where.join(' OR ')}
      ORDER BY ${table.key.map(quote).join(', ')}`, ...params);
  };
  /** What an account owns alone, per table: what its own copy takes and "replace" empties. */
  const ownedBy = (userId) => selectRows(model, rowsNear([userId]), (id) => id === userId).kept;

  /** The versions of this database's schema, the app's and the suite's. */
  function schemaVersions() {
    const rows = database.all('SELECT scope, MAX(version) AS version FROM schema_migrations GROUP BY scope');
    const of = (scope) => rows.find((r) => r.scope === scope)?.version ?? 0;
    return { app: of('app'), suite: of('suite') };
  }

  /* ---------------------------------- busy ---------------------------------- */

  // Exports and imports are heavy and rare: one at a time per account, and one for the install.
  const running = new Set();
  function begin(key) {
    if (running.has(key) || running.size >= 3) throw conflict('data_busy');
    running.add(key);
    return () => running.delete(key);
  }

  /* --------------------------------- export --------------------------------- */

  /**
   * Gathers a copy and returns what to write it with. Everything is read now,
   * in one read transaction: nothing else runs on this connection meanwhile,
   * and a script writing from another process can't slip in halfway. The
   * attachments are read while writing; one gone by then is counted as
   * missing in the manifest instead of breaking the copy.
   *
   * @param {object} options
   * @param {'account'|'install'} options.scope
   * @param {number} [options.userId]   whose, for an account's copy
   */
  function prepareExport({ scope, userId = null }) {
    if (!['account', 'install'].includes(scope)) throw new Error(`export: unknown scope ${scope}`);
    const userSql = `SELECT ${model.userColumns.map(quote).join(', ')} FROM users`;
    let users;
    let kept;
    let leftOut;
    let grants = [];
    let billing = null;
    const versions = schemaVersions();
    database.exec('BEGIN');
    try {
      users = scope === 'install' ? database.all(`${userSql} ORDER BY id`) : [database.get(`${userSql} WHERE id = ?`, userId)].filter(Boolean);
      if (!users.length) throw notFound('user_not_found');
      const inside = scope === 'install' ? () => true : (id) => id === userId;
      ({ kept, leftOut } = selectRows(model, scope === 'install' ? rowsOfDb : rowsNear([userId]), inside,
        { account: scope === 'account' ? userId : null }));
      if (scope === 'install' && database.columnsOf('entitlement_grants').length) {
        // Every source, not only the administrator's: a paid plan moves with its account,
        // which the new install numbers anew (audit sc-data-48).
        grants = database.all(`SELECT subject_id, plan, feature, value, quantity, source, external_ref, starts_at, ends_at,
          created_at, note FROM entitlement_grants WHERE subject_type = 'user' AND revoked_at IS NULL ORDER BY id`);
      }
      if (scope === 'install' && database.columnsOf('billing_customers').length) {
        const refunded = database.columnsOf('billing_subscriptions').includes('refunded_until');
        billing = {
          customers: database.all(`SELECT subject_id, provider, customer_id, created_at FROM billing_customers
            WHERE subject_type = 'user' ORDER BY subject_id`),
          subscriptions: database.all(`SELECT subject_id, provider, ref, product, status, quantity, period_end, occurred_at,
            updated_at${refunded ? ', refunded_until' : ''} FROM billing_subscriptions WHERE subject_type = 'user' ORDER BY updated_at`),
        };
        if (!billing.customers.length && !billing.subscriptions.length) billing = null;
      }
    } finally {
      database.exec('COMMIT');
    }
    const id = randomToken(18);
    const createdAt = iso();
    const account = scope === 'account' ? users[0] : null;

    async function write(output) {
      const zip = createZipWriter(output, { now: () => new Date(clock()) });
      const json = (value) => JSON.stringify(value, null, 1);
      await zip.add('data/users.json', json(users.map((u) => Object.fromEntries(Object.entries(u).map(([k, v]) => [k, toJson(v)])))));
      for (const table of model.tables) {
        const rows = kept.get(table.name);
        if (rows.length) await zip.add(`data/${table.name}.json`, json(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toJson(v)])))));
      }
      if (grants.length) await zip.add('suite/grants.json', json(grants));
      if (billing) await zip.add('suite/billing.json', json(billing));
      const files = { count: 0, bytes: 0, missing: 0 };
      const added = new Set();
      for (const table of model.tables.filter((t) => t.file)) {
        for (const row of kept.get(table.name)) {
          const stored = row[table.file.path];
          if (added.has(stored)) continue;
          // Only the plain relative paths uploads.js makes: anything else can't be named in a zip.
          const plain = typeof stored === 'string' && !stored.startsWith('/') && !stored.split(/[\\/]/).includes('..');
          const absolute = plain ? uploads?.resolve(stored) : null;
          let bytes = null;
          try { bytes = absolute ? await fs.promises.readFile(absolute) : null; } catch { bytes = null; }
          if (!bytes) { files.missing += 1; continue; }
          await zip.add(`files/${stored}`, bytes, { compress: false });
          added.add(stored);
          files.count += 1;
          files.bytes += bytes.length;
        }
      }
      const manifest = {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        id,
        created_at: createdAt,
        scope,
        app: { id: app.id, name: app.name, version: app.version || null },
        schema: versions,
        source: { base_url: baseUrl, auth: authProvider },
        ...(account ? { account: { id: account.id, username: account.username, display_name: account.display_name, email: account.email ?? null } } : {}),
        users: users.length,
        tables: countsOf(kept),
        files,
        ...(scope === 'account' ? { left_out: leftOut } : {}),
      };
      // Last, so what it says about the attachments is what really went in.
      await zip.add('manifest.json', json(manifest));
      await zip.finish();
      return manifest;
    }

    const day = createdAt.slice(0, 10);
    return {
      filename: `${app.id}-${account ? account.username : 'install'}-${day}.zip`,
      counts: { users: users.length, ...countsOf(kept) },
      write,
    };
  }

  /* ------------------------------ reading a copy ------------------------------ */

  function checkManifest(manifest) {
    if (!isObject(manifest) || manifest.format !== EXPORT_FORMAT || !Number.isInteger(manifest.version)
      || typeof manifest.id !== 'string' || !TOKEN.test(manifest.id) || !['account', 'install'].includes(manifest.scope)) {
      throw badRequest('import_not_export');
    }
    if (manifest.version > EXPORT_VERSION) throw conflict('import_newer_version');
    if (manifest.app?.id !== app.id) {
      throw badRequest('import_other_app', { app: String(manifest.app?.name || manifest.app?.id || '?').slice(0, 60) });
    }
    const there = isObject(manifest.schema) ? manifest.schema : {};
    if (!Number.isInteger(there.app) || !Number.isInteger(there.suite)) throw badRequest('import_not_export');
    // An older copy comes in when every column it has is still here (checked table by table);
    // a newer one may hold what this version can't keep.
    const here = schemaVersions();
    if (there.app > here.app || there.suite > here.suite) throw conflict('import_newer_version');
  }

  function checkRows(table, rows) {
    if (!Array.isArray(rows)) throw invalidData(table.name);
    const seen = new Set();
    return rows.map((raw) => {
      if (!isObject(raw)) throw invalidData(table.name);
      const row = {};
      for (const [column, value] of Object.entries(raw)) {
        if (!table.columns.has(column)) throw invalidData(table.name, { column });
        const clean = fromJson(value);
        if (clean === undefined) throw invalidData(table.name, { column });
        const kept = within(clean, table.limits.get(column));
        if (kept !== undefined) row[column] = kept;
      }
      if (table.keyed) {
        if (!isId(row.id) || seen.has(row.id)) throw invalidData(table.name, { column: 'id' });
        seen.add(row.id);
      }
      for (const ref of table.refs) {
        if (row[ref.column] != null && !isId(row[ref.column])) throw invalidData(table.name, { column: ref.column });
      }
      if (table.file && (typeof row[table.file.path] !== 'string' || !row[table.file.path])) {
        throw invalidData(table.name, { column: table.file.path });
      }
      return row;
    });
  }

  function checkUsers(rows) {
    if (!Array.isArray(rows)) throw invalidData('users');
    const allowed = new Set(model.userColumns);
    const seen = new Set();
    return rows.map((raw) => {
      if (!isObject(raw)) throw invalidData('users');
      const user = {};
      for (const [column, value] of Object.entries(raw)) {
        // A column this install doesn't have (an older app, a newer suite) is left out, never written.
        if (!allowed.has(column)) continue;
        const clean = fromJson(value);
        if (clean === undefined || clean instanceof Buffer) throw invalidData('users', { column });
        user[column] = clean;
      }
      if (!isId(user.id) || seen.has(user.id)) throw invalidData('users', { column: 'id' });
      if (typeof user.username !== 'string' || !user.username.trim()) throw invalidData('users', { column: 'username' });
      for (const text of ['display_name', 'email', 'role', 'locale', 'theme', 'prefs', 'created_at', 'disabled_at', 'email_verified_at']) {
        if (user[text] != null && typeof user[text] !== 'string') throw invalidData('users', { column: text });
      }
      // The account's row is read whole on every request it makes: what comes in
      // here must stay the size the app's own screens would ever write.
      if (user.prefs != null && user.prefs.length > MAX_PREFS) throw invalidData('users', { column: 'prefs' });
      for (const column of model.appColumns) {
        if (typeof user[column] === 'string' && user[column].length > MAX_USER_VALUE) throw invalidData('users', { column });
        if (model.userLimits.has(column)) {
          const kept = within(user[column], model.userLimits.get(column));
          if (kept === undefined) delete user[column];
          else user[column] = kept;
        }
      }
      seen.add(user.id);
      return user;
    });
  }

  function checkGrants(rows) {
    if (!Array.isArray(rows)) throw invalidData('grants');
    return rows.map((raw) => {
      if (!isObject(raw) || !isId(raw.subject_id)) throw invalidData('grants');
      const grant = {};
      for (const column of ['subject_id', 'plan', 'feature', 'value', 'quantity', 'source', 'external_ref', 'starts_at', 'ends_at', 'created_at', 'note']) {
        const clean = fromJson(raw[column] ?? null);
        if (clean === undefined || clean instanceof Buffer) throw invalidData('grants', { column });
        grant[column] = clean;
      }
      if ((grant.plan == null) === (grant.feature == null)) throw invalidData('grants');
      // Copies made before suite-core 0.38 only carried the administrator's, without saying so.
      grant.source ??= 'admin';
      if (!SOURCE.test(String(grant.source))) throw invalidData('grants', { column: 'source' });
      if (grant.external_ref != null && (typeof grant.external_ref !== 'string' || grant.external_ref.length > MAX_REF)) {
        throw invalidData('grants', { column: 'external_ref' });
      }
      return grant;
    });
  }

  /** suite/billing.json: plain rows, every id a provider's and every account one of the copy. */
  function checkBilling(raw) {
    if (raw == null) return { customers: [], subscriptions: [] };
    if (!isObject(raw) || !Array.isArray(raw.customers ?? []) || !Array.isArray(raw.subscriptions ?? [])) throw invalidData('billing');
    const text = (value, max, column, { optional = false } = {}) => {
      if (value == null && optional) return null;
      if (typeof value !== 'string' || !value || value.length > max) throw invalidData('billing', { column });
      return value;
    };
    const owner = (row) => {
      if (!isObject(row) || !isId(row.subject_id)) throw invalidData('billing', { column: 'subject_id' });
      if (!SOURCE.test(String(row.provider))) throw invalidData('billing', { column: 'provider' });
    };
    const customers = (raw.customers ?? []).map((row) => {
      owner(row);
      return {
        subject_id: row.subject_id, provider: row.provider, customer_id: text(row.customer_id, MAX_REF, 'customer_id'),
        created_at: text(row.created_at, 40, 'created_at', { optional: true }),
      };
    });
    const subscriptions = (raw.subscriptions ?? []).map((row) => {
      owner(row);
      if (row.quantity != null && !Number.isSafeInteger(row.quantity)) throw invalidData('billing', { column: 'quantity' });
      return {
        subject_id: row.subject_id, provider: row.provider, ref: text(row.ref, MAX_REF, 'ref'),
        product: text(row.product, 40, 'product'), status: text(row.status, 40, 'status'), quantity: row.quantity ?? null,
        period_end: text(row.period_end, 40, 'period_end', { optional: true }),
        occurred_at: text(row.occurred_at, 40, 'occurred_at'), updated_at: text(row.updated_at, 40, 'updated_at'),
        refunded_until: text(row.refunded_until, 40, 'refunded_until', { optional: true }),
      };
    });
    return { customers, subscriptions };
  }

  /**
   * Opens a copy and checks all of it but the attachments, which are read when
   * applied. `by` says whose ceilings hold (see `max`).
   */
  async function readArchive(file, { by = 'account' } = {}) {
    const zip = await openZip(file);
    try {
      const manifestBytes = await zip.read('manifest.json', { maxBytes: MB }).catch(() => null);
      if (!manifestBytes) throw badRequest('import_not_export');
      let manifest;
      try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw badRequest('import_not_export'); }
      checkManifest(manifest);
      // Data this install doesn't know would be lost without anybody noticing: better to say so.
      for (const entry of zip.entries) {
        const table = /^data\/(.+)\.json$/.exec(entry.name)?.[1];
        if (table && table !== 'users' && !model.byName.has(table)) throw invalidData(table, { reason: 'unknown_table' });
      }
      let budget = max.data[by];
      let values = max.values[by];
      const readJsonEntry = async (name) => {
        const size = zip.sizeOf(name);
        if (size == null) return null;
        budget -= size;
        if (budget < 0) throw new HttpError(413, 'zip_too_large');
        const bytes = await zip.read(name, { maxBytes: max.entry[by] });
        // Parsing builds every value at once, before any of it is checked: they are
        // counted first, on the bytes, which costs a few milliseconds.
        values -= countValues(bytes);
        if (values < 0) throw new HttpError(413, 'zip_too_large', { entry: name });
        try { return JSON.parse(bytes.toString('utf8')); } catch { throw invalidData(name.replace(/^\w+\/|\.json$/g, '')); }
      };
      const users = checkUsers((await readJsonEntry('data/users.json')) ?? []);
      if (!users.length || (manifest.scope === 'account' && users.length !== 1)) throw invalidData('users');
      const tables = new Map();
      for (const table of model.tables) tables.set(table.name, checkRows(table, (await readJsonEntry(`data/${table.name}.json`)) ?? []));
      const grants = manifest.scope === 'install' ? checkGrants((await readJsonEntry('suite/grants.json')) ?? []) : [];
      const billing = checkBilling(manifest.scope === 'install' ? await readJsonEntry('suite/billing.json') : null);
      return { zip, manifest, users, tables, grants, billing };
    } catch (err) {
      await zip.close();
      throw err;
    }
  }

  const alreadyApplied = (manifest, target) => database.get(
    'SELECT imported_at FROM data_imports WHERE export_id = ? AND target = ?', manifest.id, target)?.imported_at ?? null;
  const targetOf = (mode, user) => (mode === 'account' ? `user:${user.id}` : 'install');

  /* ------------------------------ where accounts go ----------------------------- */

  const byEmail = (email) => (email ? database.get('SELECT * FROM users WHERE email = ? COLLATE NOCASE ORDER BY id LIMIT 1',
    String(email).trim().toLowerCase()) : null);
  /** The copy's username when it is valid and free here, else the next free one like it (ana, ana2…). */
  const freeName = (name) => (USERNAME.test(name) && !accounts.byUsername(name) ? name : accounts.freeUsername(name));

  /**
   * Where each account of the copy goes: `decisions` (the administrator's,
   * or the command line's) over the default, which is the account here with
   * the same email or else a new one. With an account's own import, the copy's
   * only account goes into whoever imports it.
   *
   * A decision is { source, user_id, replace } (into that account here),
   * { source, create: { username, email, role } } (a new one; with no role, a plain user when
   * applied from the panel), { source, email }
   * (the one here with that email, or a new one with it) or
   * { source, skip: true } (left out, with everything only theirs).
   */
  function decide(archive, { mode, user = null, decisions = [], replace = false }) {
    const choices = new Map();
    if (mode === 'account') {
      if (archive.manifest.scope !== 'account') throw badRequest('import_wrong_scope');
      choices.set(archive.users[0].id, { action: 'map', userId: user.id, replace: Boolean(replace) });
      return choices;
    }
    const sources = new Map(archive.users.map((u) => [u.id, u]));
    const sourceOf = (value) => {
      const text = String(value ?? '').trim();
      const found = sources.get(Number(text)) || archive.users.find((u) => u.username.toLowerCase() === text.toLowerCase());
      if (!found) throw badRequest('field_invalid', { field: 'source' });
      return found;
    };
    const byAddress = (email) => {
      const clean = email == null || email === '' ? null : String(email).trim().toLowerCase();
      const here = byEmail(clean);
      return here ? { action: 'map', userId: here.id, replace: false }
        : { action: 'create', username: null, email: clean };
    };
    for (const decision of Array.isArray(decisions) ? decisions : []) {
      if (!isObject(decision)) throw badRequest('field_invalid', { field: 'accounts' });
      const source = sourceOf(decision.source);
      if (decision.skip) choices.set(source.id, { action: 'skip' });
      else if (decision.user_id != null) {
        const target = accounts.byId(int(decision.user_id, { field: 'user_id', min: 1 }));
        if (!target) throw notFound('user_not_found');
        choices.set(source.id, { action: 'map', userId: target.id, replace: Boolean(decision.replace) });
      } else if (isObject(decision.create)) {
        const { username = null, email, role = null } = decision.create;
        choices.set(source.id, {
          action: 'create', username: username == null || username === '' ? null : String(username).trim(),
          role: typeof role === 'string' ? role : null,
          email: email === undefined ? source.email ?? null : email === null || email === '' ? null : String(email).trim().toLowerCase(),
        });
      } else if ('email' in decision) {
        choices.set(source.id, byAddress(decision.email));
      } else {
        throw badRequest('field_invalid', { field: 'accounts' });
      }
    }
    // The rest, by their email; a default never takes what a decision already took,
    // so the plan always opens, and whatever clashes is left for the administrator to say.
    const taken = new Set([...choices.values()].filter((c) => c.action === 'map').map((c) => c.userId));
    const emailsTaken = new Set([...choices.values()].filter((c) => c.action === 'create' && c.email).map((c) => c.email));
    for (const source of archive.users) {
      if (choices.has(source.id)) continue;
      let choice = byAddress(source.email);
      if (choice.action === 'map' && taken.has(choice.userId)) choice = { action: 'create', username: null, email: null };
      if (choice.action === 'create' && choice.email && emailsTaken.has(choice.email)) choice.email = null;
      if (choice.action === 'map') taken.add(choice.userId);
      if (choice.email) emailsTaken.add(choice.email);
      choices.set(source.id, choice);
    }
    // Two accounts of the copy can't become one here: their shares would clash.
    const mapped = [...choices.values()].filter((c) => c.action === 'map').map((c) => c.userId);
    if (new Set(mapped).size !== mapped.length) throw conflict('import_target_taken');
    const emails = new Set();
    for (const choice of choices.values()) {
      if (choice.action !== 'create' || !choice.email) continue;
      // An email another account here already has would link the wrong person on their first sign-in.
      if (byEmail(choice.email) || emails.has(choice.email)) throw conflict('import_email_taken', { email: choice.email });
      emails.add(choice.email);
    }
    return choices;
  }

  /* ---------------------------------- plan ----------------------------------- */

  /** What an import would do, before doing it: for the screen and for the command line. */
  function planFor(archive, { mode, user = null, decisions = [], replace = false }) {
    const { manifest } = archive;
    const target = targetOf(mode, user);
    const summary = {
      id: manifest.id, scope: manifest.scope, created_at: manifest.created_at,
      app: manifest.app, source: isObject(manifest.source) ? manifest.source : null,
      tables: countsOf(archive.tables),
      files: isObject(manifest.files) ? { count: manifest.files.count ?? 0, bytes: manifest.files.bytes ?? 0, missing: manifest.files.missing ?? 0 } : null,
      left_out: manifest.scope === 'account' && isObject(manifest.left_out) ? manifest.left_out : {},
      // Which tables are the attachments' rows, so a screen counts them once, as files.
      file_tables: model.tables.filter((t) => t.file).map((t) => t.name),
      applied_at: alreadyApplied(manifest, target),
    };
    const choices = decide(archive, { mode, user, decisions, replace });
    if (mode === 'account') {
      return { mode, copy: summary, account: archive.users[0].username, replace: countsOf(ownedBy(user.id)) };
    }
    const own = ownership(model, rowsOfDb);
    const fileOwners = ownership(model, (name) => archive.tables.get(name));
    return {
      mode,
      copy: summary,
      accounts: archive.users.map((source) => {
        const choice = choices.get(source.id);
        return {
          source: {
            id: source.id, username: source.username, display_name: source.display_name ?? source.username,
            email: source.email ?? null, role: source.role ?? 'user', disabled: Boolean(source.disabled_at),
          },
          rows: fileOwners.get(source.id) || {},
          choice: choice.action === 'map' ? { action: 'map', user_id: choice.userId, replace: choice.replace }
            : choice.action === 'create' ? { action: 'create', username: choice.username || freeName(source.username), email: choice.email }
              : { action: 'skip' },
        };
      }),
      // Where they can go: the accounts here, with what "replace" would take from each.
      targets: accounts.list().map((u) => ({
        id: u.id, username: u.username, display_name: u.display_name, email: u.email ?? null, role: u.role,
        owns: own.get(u.id) || {},
      })),
      provider: authProvider,
    };
  }

  /* ---------------------------------- apply ---------------------------------- */

  /**
   * Applies a copy. Attachments are read and checked first, into a staging
   * folder beside the pending import; then one transaction creates the
   * accounts, empties the accounts that are replaced, writes every row with
   * new ids, the profiles and the record that it was applied; and only after
   * it commits are the files moved into place. A failure anywhere before the
   * commit leaves the install as it was.
   */
  async function applyArchive(archive, { mode, user = null, decisions = [], replace = false, req = null, staging, by = 'account' }) {
    const { manifest } = archive;
    const target = targetOf(mode, user);
    const when = alreadyApplied(manifest, target);
    if (when) throw conflict('import_already_applied', { at: when });
    const choices = decide(archive, { mode, user, decisions, replace });
    const sources = new Map(archive.users.map((u) => [u.id, u]));
    const inside = (id) => choices.has(id) && choices.get(id).action !== 'skip';
    const { kept } = selectRows(model, (name) => archive.tables.get(name), inside);
    const problems = { missing: 0, refused: 0, too_large: 0, plan: 0 };

    // What someone's plan doesn't allow them to attach doesn't come in with their copy either.
    for (const table of model.tables.filter((t) => t.file)) {
      if (mode === 'account' && table.file.feature && entitlements && !entitlements.can(user, table.file.feature)) {
        problems.plan += kept.get(table.name).length;
        kept.set(table.name, []);
      }
    }

    // The attachments: read, checked by their first bytes like any upload, and staged.
    // A copy stores them as they are, so they never add up to much more than the
    // file that was uploaded: that is what they may take on disk, whatever the
    // entries declare. (Twice, and some, for a copy someone zipped again.)
    const staged = new Map();
    let stagedCount = 0;
    // Every row gets a file of its own once applied (two rows that share one are
    // written twice), so it is the rows that are counted, not the distinct files:
    // a thousand rows over one photo in the copy are a thousand photos on disk.
    let diskBudget = 2 * archive.zip.size + 16 * MB;
    let filesLeft = max.files[by];
    const cleanStaging = () => fs.rmSync(staging, { recursive: true, force: true });
    try {
      for (const table of model.tables.filter((t) => t.file)) {
        const usable = [];
        for (const row of kept.get(table.name)) {
          const old = row[table.file.path];
          const entry = `files/${old}`;
          if (!staged.has(old)) {
            const size = archive.zip.sizeOf(entry);
            if (size == null) { problems.missing += 1; continue; }
            if (uploads && size > uploads.maxBytes) { problems.too_large += 1; continue; }
            if (size > diskBudget) throw new HttpError(413, 'zip_too_large', { entry });
            const bytes = await archive.zip.read(entry, { maxBytes: uploads?.maxBytes ?? 15 * MB });
            const type = detectType(bytes.subarray(0, 16));
            if (!type) { problems.refused += 1; continue; }
            fs.mkdirSync(staging, { recursive: true });
            stagedCount += 1;
            const file = path.join(staging, String(stagedCount));
            fs.writeFileSync(file, bytes);
            staged.set(old, { file, mime: type.mime, ext: type.ext, size: bytes.length });
          }
          diskBudget -= staged.get(old).size;
          filesLeft -= 1;
          if (diskBudget < 0 || filesLeft < 0) throw new HttpError(413, 'zip_too_large', { entry });
          usable.push(row);
        }
        kept.set(table.name, usable);
      }
      if (!uploads && staged.size) throw new Error('import: the app declares files but modules.uploads is off');

      const replacedFiles = [];
      const moves = [];
      const result = database.tx(() => {
        // Accounts: the ones mapped here, and the new ones, without the app's welcome content.
        const userMap = new Map();
        const created = [];
        for (const [sourceId, choice] of choices) {
          if (choice.action === 'map') userMap.set(sourceId, choice.userId);
          if (choice.action !== 'create') continue;
          const source = sources.get(sourceId);
          const username = choice.username ?? freeName(source.username);
          const account = accounts.create({
            username,
            displayName: String(source.display_name || username).trim().slice(0, 80) || username,
            // From the panel a copy never makes an admin by itself: whoever applies
            // it says so per account (\`create.role\`); a file could carry any role.
            // The command line, run by whoever runs the server, keeps the copy's.
            role: roles.includes(choice.role) ? choice.role
              : req ? 'user' : roles.includes(source.role) ? source.role : 'user',
            email: choice.email || null,
            locale: typeof source.locale === 'string' ? source.locale.slice(0, 16) : null,
          }, { quiet: true });
          // Its age, whether it was disabled, and whether its email was confirmed there (only the same address).
          const verified = choice.email && source.email && choice.email === String(source.email).trim().toLowerCase()
            ? source.email_verified_at ?? null : null;
          database.run('UPDATE users SET created_at = COALESCE(?, created_at), disabled_at = ?, email_verified_at = ? WHERE id = ?',
            source.created_at ?? null, mode === 'install' ? source.disabled_at ?? null : null, verified, account.id);
          userMap.set(sourceId, account.id);
          created.push(account.id);
        }

        // "Replace": what those accounts own goes first, exactly what their own copy would take.
        const replaced = {};
        for (const choice of choices.values()) {
          if (choice.action !== 'map' || !choice.replace) continue;
          const owned = ownedBy(choice.userId);
          for (const table of [...model.tables].reverse()) {
            const rows = owned.get(table.name);
            if (!rows.length) continue;
            if (table.file) replacedFiles.push(...rows.map((r) => r[table.file.path]));
            const where = table.key.map((c) => `${quote(c)} = ?`).join(' AND ');
            const remove = database.db.prepare(`DELETE FROM ${quote(table.name)} WHERE ${where}`);
            for (const row of rows) remove.run(...table.key.map((c) => row[c]));
            replaced[table.name] = (replaced[table.name] || 0) + rows.length;
          }
        }

        // The rows, table by table, with new ids and every reference translated.
        const newIds = new Map(model.tables.map((t) => [t.name, new Map()]));
        const later = [];
        const imported = {};
        for (const table of model.tables) {
          const statements = new Map();
          for (const row of kept.get(table.name)) {
            let values = { ...row };
            if (table.keyed) delete values.id;
            for (const ref of table.refs) {
              const old = row[ref.column];
              if (old == null) continue;
              values[ref.column] = ref.target === 'users' ? userMap.get(old) ?? null
                : ref.deferred ? null : newIds.get(ref.target).get(old) ?? null;
            }
            if (table.file) {
              const file = staged.get(row[table.file.path]);
              const folder = table.file.folder && values[table.file.folder] != null ? String(values[table.file.folder]) : 'shared';
              const relative = storedName({ folder, name: row[table.file.name], ext: file.ext });
              moves.push({ from: file.file, to: relative });
              values[table.file.path] = relative;
              values[table.file.mime] = file.mime;
              values[table.file.size] = file.size;
            }
            if (table.clean) values = table.clean(values, { mode }) ?? values;
            const columns = Object.keys(values);
            const signature = columns.join('\u0000');
            let statement = statements.get(signature);
            if (!statement) {
              statement = database.db.prepare(`INSERT INTO ${quote(table.name)} (${columns.map(quote).join(', ')})
                VALUES (${columns.map(() => '?').join(', ')})`);
              statements.set(signature, statement);
            }
            let info;
            try {
              info = statement.run(...columns.map((c) => values[c]));
            } catch (err) {
              throw invalidData(table.name, { reason: String(err.message || '').slice(0, 120) });
            }
            const id = Number(info.lastInsertRowid);
            if (table.keyed) newIds.get(table.name).set(row.id, id);
            for (const ref of table.refs) {
              if (ref.deferred && row[ref.column] != null) later.push({ table, id, ref, old: row[ref.column] });
            }
            imported[table.name] = (imported[table.name] || 0) + 1;
          }
        }
        for (const { table, id, ref, old } of later) {
          const to = newIds.get(ref.target).get(old);
          if (to != null) database.run(`UPDATE ${quote(table.name)} SET ${quote(ref.column)} = ? WHERE id = ?`, to, id);
        }

        // Profiles: the preferences of the copy; who each account is stays as it is here.
        const ids = (table, old) => newIds.get(table)?.get(Number(old)) ?? null;
        for (const [sourceId, userId] of userMap) {
          const source = sources.get(sourceId);
          const isNew = created.includes(userId);
          const sets = {};
          if (typeof source.display_name === 'string' && source.display_name.trim()) sets.display_name = source.display_name.trim().slice(0, 80);
          if (typeof source.theme === 'string' && model.userColumns.includes('theme')) sets.theme = source.theme.slice(0, 20);
          if (source.locale !== undefined && model.userColumns.includes('locale')) sets.locale = source.locale ? String(source.locale).slice(0, 16) : null;
          // An empty one keeps what the account has: the app's columns may not allow it.
          for (const column of model.appColumns) if (source[column] != null) sets[column] = source[column];
          // Preferences hold ids of the app's rows: only the app knows where, so without its hook they stay.
          if (model.prefs && model.userColumns.includes('prefs')) {
            const parse = (text) => { try { return JSON.parse(text || '{}'); } catch { return {}; } };
            const current = isNew ? null : parse(database.get('SELECT prefs FROM users WHERE id = ?', userId)?.prefs);
            const prefs = model.prefs(parse(source.prefs), { ids, current, created: isNew });
            sets.prefs = typeof prefs === 'string' ? prefs : JSON.stringify(prefs ?? {});
          }
          const columns = Object.keys(sets);
          if (columns.length) {
            try {
              database.run(`UPDATE users SET ${columns.map((c) => `${quote(c)} = ?`).join(', ')} WHERE id = ?`,
                ...columns.map((c) => sets[c]), userId);
            } catch (err) {
              throw invalidData('users', { reason: String(err.message || '').slice(0, 120) });
            }
          }
        }

        // The plans given there, by the administrator or paid for, to whoever came along.
        let grantsImported = 0;
        if (mode === 'install' && archive.grants.length && database.columnsOf('entitlement_grants').length) {
          for (const grant of archive.grants) {
            const userId = userMap.get(grant.subject_id);
            if (!userId) continue;
            // A payment's grant already here (its webhook came first) isn't doubled.
            if (grant.external_ref != null && database.get(`SELECT 1 FROM entitlement_grants WHERE source = ?
              AND external_ref = ? AND revoked_at IS NULL`, grant.source, grant.external_ref)) continue;
            try {
              database.run(`INSERT INTO entitlement_grants (subject_type, subject_id, plan, feature, value, quantity, source,
                external_ref, starts_at, ends_at, created_at, note) VALUES ('user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              userId, grant.plan, grant.feature, grant.value, grant.quantity, grant.source, grant.external_ref,
              grant.starts_at ?? iso(), grant.ends_at, grant.created_at ?? iso(), grant.note);
            } catch (err) {
              throw invalidData('grants', { reason: String(err.message || '').slice(0, 120) });
            }
            grantsImported += 1;
          }
        }

        // Who each account is at the payment provider, under its id here: a renewal finds them by it,
        // not by the id the copy had, which here may be someone else's (audit sc-data-48).
        let billingImported = 0;
        if (mode === 'install' && database.columnsOf('billing_customers').length) {
          const refunded = database.columnsOf('billing_subscriptions').includes('refunded_until');
          for (const row of archive.billing.customers) {
            const userId = userMap.get(row.subject_id);
            if (!userId) continue;
            billingImported += database.run(`INSERT OR IGNORE INTO billing_customers (subject_type, subject_id, provider,
              customer_id, created_at) VALUES ('user', ?, ?, ?, ?)`, userId, row.provider, row.customer_id, row.created_at ?? iso()).changes;
          }
          for (const row of archive.billing.subscriptions) {
            const userId = userMap.get(row.subject_id);
            if (!userId) continue;
            billingImported += database.run(`INSERT OR IGNORE INTO billing_subscriptions (provider, ref, subject_type, subject_id,
              product, status, quantity, period_end, occurred_at, updated_at${refunded ? ', refunded_until' : ''})
              VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?${refunded ? ', ?' : ''})`, row.provider, row.ref, userId, row.product,
            row.status, row.quantity, row.period_end, row.occurred_at, row.updated_at, ...(refunded ? [row.refunded_until] : [])).changes;
          }
        }

        const counts = { accounts: { created: created.length, mapped: userMap.size - created.length }, tables: imported, files: moves.length };
        try {
          database.run(`INSERT INTO data_imports (export_id, scope, target, imported_by, app_version, counts, imported_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, manifest.id, manifest.scope, target, user?.id ?? null,
          manifest.app?.version == null ? null : String(manifest.app.version).slice(0, 40), JSON.stringify(counts), iso());
        } catch {
          throw conflict('import_already_applied', { at: alreadyApplied(manifest, target) });
        }
        // The plan's limits, with the rows already in: the app counts what the person has now.
        if (model.check && mode === 'account') model.check({ user, counts: imported, replaced });
        const leftOut = {};
        for (const [name, rows] of archive.tables) {
          const missing = rows.length - (imported[name] || 0);
          if (missing > 0) leftOut[name] = missing;
        }
        return {
          accounts: [...userMap].map(([sourceId, userId]) => ({
            source: sourceId, user_id: userId, username: accounts.byId(userId)?.username ?? null, created: created.includes(userId),
          })),
          skipped: [...choices].filter(([, c]) => c.action === 'skip').map(([sourceId]) => sources.get(sourceId).username),
          imported: { ...counts, grants: grantsImported, billing: billingImported },
          file_tables: model.tables.filter((t) => t.file).map((t) => t.name),
          replaced,
          left_out: { tables: leftOut, files: problems },
        };
      });

      // Committed: the files go where their rows say, and what was replaced leaves the disk.
      // A staged file two rows share is copied for the first and moved for the last.
      const uses = new Map();
      for (const move of moves) uses.set(move.from, (uses.get(move.from) || 0) + 1);
      for (const move of moves) {
        const destination = uploads.resolve(move.to);
        try {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          const left = uses.get(move.from) - 1;
          uses.set(move.from, left);
          if (left > 0) fs.copyFileSync(move.from, destination);
          else {
            try { fs.renameSync(move.from, destination); } catch (err) {
              if (err.code !== 'EXDEV') throw err;
              fs.copyFileSync(move.from, destination);
            }
          }
        } catch (err) {
          log(`[data] an imported file could not be put in place (${move.to}): ${err.code || err.message}`);
        }
      }
      for (const old of replacedFiles) uploads?.remove(old);
      cleanStaging();

      audit?.record({
        action: 'data.import', actor: user, req,
        meta: { scope: manifest.scope, into: mode, accounts: result.accounts.length, rows: Object.values(result.imported.tables).reduce((a, b) => a + b, 0), files: result.imported.files },
      });
      // Whoever has the app open sees it all without reloading by hand.
      live?.publish({ audience: mode === 'account' && !Object.keys(result.replaced).length ? [user.id] : null, event: 'resync', data: {} });
      for (const { user_id: id } of result.accounts) accounts.changed?.(id);
      return result;
    } catch (err) {
      cleanStaging();
      throw err;
    }
  }

  /* ----------------------------- pending imports ----------------------------- */

  const pendingFiles = (id) => ({
    zip: path.join(importsDir, `${id}.zip`), meta: path.join(importsDir, `${id}.json`), staging: path.join(importsDir, `${id}.files`),
  });
  function forget(id) {
    const files = pendingFiles(id);
    for (const file of [files.zip, files.meta, `${files.zip}.partial`]) fs.rmSync(file, { force: true });
    fs.rmSync(files.staging, { recursive: true, force: true });
  }
  /** The pending import `id` of this person in this mode, or 404: another person's is never found. */
  function pending(id, { mode, user }) {
    if (!TOKEN.test(String(id))) throw notFound('import_not_found');
    const files = pendingFiles(id);
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(files.meta, 'utf8')); } catch { meta = null; }
    if (!meta || meta.owner !== user.id || meta.mode !== mode || !fs.existsSync(files.zip)) throw notFound('import_not_found');
    if (clock() - Date.parse(meta.created_at) > PENDING_MS) {
      forget(id);
      throw notFound('import_not_found');
    }
    return files;
  }

  /** Streams an upload to disk, refusing more than `limit` bytes. */
  async function receiveFile(req, target, limit) {
    let size = 0;
    const counter = new Transform({
      transform(chunk, _encoding, done) {
        size += chunk.length;
        if (size > limit) done(new HttpError(413, 'body_too_large'));
        else done(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, fs.createWriteStream(target));
    } catch (err) {
      fs.rmSync(target, { force: true });
      throw err instanceof HttpError ? err : badRequest('upload_cut');
    }
    if (!size) {
      fs.rmSync(target, { force: true });
      throw badRequest('file_empty');
    }
  }

  /**
   * Takes an uploaded copy, checks it and answers what importing it would do.
   * It waits in DATA_DIR/imports for a day, for this person only.
   */
  async function receive(req, { mode, user }) {
    const release = begin(mode === 'install' ? 'install' : `user:${user.id}`);
    const id = randomToken(18);
    const files = pendingFiles(id);
    try {
      fs.mkdirSync(importsDir, { recursive: true });
      await receiveFile(req, `${files.zip}.partial`, max.upload[mode]);
      fs.renameSync(`${files.zip}.partial`, files.zip);
      fs.writeFileSync(files.meta, JSON.stringify({ owner: user.id, mode, created_at: iso() }));
      const archive = await readArchive(files.zip, { by: mode });
      try {
        return { import_id: id, ...planFor(archive, { mode, user }) };
      } finally {
        await archive.zip.close();
      }
    } catch (err) {
      forget(id);
      throw err;
    } finally {
      release();
    }
  }

  /** Applies a pending import, and lets its file go. */
  async function apply(id, { mode, user, decisions = [], replace = false, req = null }) {
    const files = pending(id, { mode, user });
    const release = begin(mode === 'install' ? 'install' : `user:${user.id}`);
    try {
      const archive = await readArchive(files.zip, { by: mode });
      let result;
      try {
        result = await applyArchive(archive, { mode, user, decisions, replace, req, staging: files.staging, by: mode });
      } finally {
        await archive.zip.close();
      }
      // Applied: the upload has done its job. A refusal keeps it, to try again with other choices.
      forget(id);
      return result;
    } finally {
      release();
    }
  }

  function discard(id, { mode, user }) {
    pending(id, { mode, user });
    forget(id);
  }

  /** What an import of a file on disk would do (the command line, with the administrator's ceilings). */
  async function planFile(file, { mode, user = null, decisions = [], replace = false, by = 'install' }) {
    const archive = await readArchive(file, { by });
    try {
      return planFor(archive, { mode, user, decisions, replace });
    } finally {
      await archive.zip.close();
    }
  }

  /** Applies a file on disk (the command line, with the administrator's ceilings). */
  async function applyFile(file, { mode, user = null, decisions = [], replace = false, by = 'install' }) {
    const release = begin(mode === 'install' ? 'install' : `user:${user.id}`);
    try {
      fs.mkdirSync(importsDir, { recursive: true });
      const archive = await readArchive(file, { by });
      try {
        return await applyArchive(archive, {
          mode, user, decisions, replace, staging: path.join(importsDir, `${randomToken(12)}.files`), by,
        });
      } finally {
        await archive.zip.close();
      }
    } finally {
      release();
    }
  }

  /** Pending imports nobody applied, after a day. */
  function purge() {
    let names = [];
    try { names = fs.readdirSync(importsDir); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
      const full = path.join(importsDir, name);
      try {
        if (clock() - fs.statSync(full).mtimeMs <= PENDING_MS) continue;
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      } catch { /* taken meanwhile */ }
    }
    return removed;
  }

  return {
    model, max, prepareExport, receive, apply, discard, planFile, applyFile, purge, begin,
    /** For tests and tools: the pieces under the service. */
    readArchive, schemaVersions,
  };
}

/* ---------------------------------- the routes --------------------------------- */

/**
 * `GET /api/me/export` (someone's own copy), `POST /api/me/import` (upload →
 * what it would do), `POST /api/me/import/:id` (apply, `{ replace }`) and
 * `DELETE /api/me/import/:id`; and the same under `/api/admin/` for the whole
 * install, whose apply takes `{ accounts: [decisions] }`.
 */
export function registerPortabilityApi(router, { portability, audit = null, limiter = null, log = console.log }) {
  const signedIn = (ctx) => {
    if (!ctx.user) throw unauthorized();
    return ctx.user;
  };
  // Opening a copy is the heaviest thing anyone with an account can ask for: a
  // few times every quarter of an hour is plenty to bring one's data in, retries included.
  const brake = (user) => {
    const allowed = limiter?.allowTo('import', `user:${user.id}`);
    if (allowed && !allowed.allowed) throw new HttpError(429, 'too_many_attempts', { retry_after: allowed.retryAfter });
    return user;
  };
  const admin = (ctx) => {
    const user = signedIn(ctx);
    if (user.role !== 'admin') throw forbidden('admin_only');
    return user;
  };

  async function download(ctx, { scope, user }) {
    const release = portability.begin(scope === 'install' ? 'install' : `user:${user.id}`);
    try {
      const job = portability.prepareExport({ scope, userId: user.id });
      const ascii = job.filename.replace(/[^\w.-]/g, '_');
      ctx.res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(job.filename)}`,
        'Cache-Control': 'no-store',
      });
      try {
        const manifest = await job.write(ctx.res);
        audit?.record({
          action: 'data.export', actor: user, req: ctx.req,
          meta: { scope, users: manifest.users, files: manifest.files.count, missing: manifest.files.missing },
        });
      } catch (err) {
        // The headers are gone: cutting is the honest answer, or the browser keeps half a zip as if whole.
        log(`[data] export cut: ${err.message}`);
        ctx.res.destroy();
      }
    } finally {
      release();
    }
  }

  router.get('/api/me/export', (ctx) => download(ctx, { scope: 'account', user: signedIn(ctx) }));
  router.post('/api/me/import', async (ctx) => {
    sendJson(ctx.res, 200, await portability.receive(ctx.req, { mode: 'account', user: brake(signedIn(ctx)) }));
  });
  router.post('/api/me/import/:id', async (ctx) => {
    const user = brake(signedIn(ctx));
    const body = await readJson(ctx.req);
    sendJson(ctx.res, 200, await portability.apply(ctx.params.id, { mode: 'account', user, replace: body.replace === true, req: ctx.req }));
  });
  router.delete('/api/me/import/:id', (ctx) => {
    portability.discard(ctx.params.id, { mode: 'account', user: signedIn(ctx) });
    sendJson(ctx.res, 204, null);
  });

  router.get('/api/admin/export', (ctx) => download(ctx, { scope: 'install', user: admin(ctx) }));
  router.post('/api/admin/import', async (ctx) => {
    sendJson(ctx.res, 200, await portability.receive(ctx.req, { mode: 'install', user: admin(ctx) }));
  });
  router.post('/api/admin/import/:id', async (ctx) => {
    const user = admin(ctx);
    const body = await readJson(ctx.req);
    sendJson(ctx.res, 200, await portability.apply(ctx.params.id, { mode: 'install', user, decisions: body.accounts, req: ctx.req }));
  });
  router.delete('/api/admin/import/:id', (ctx) => {
    portability.discard(ctx.params.id, { mode: 'install', user: admin(ctx) });
    sendJson(ctx.res, 204, null);
  });
}
