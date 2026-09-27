/**
 * Accounts: the people who can sign in, and what the admin can do with them.
 *
 * The `users` table is the suite's; each app keeps its own columns in it
 * (Tasks' avatar colour, say), which this module leaves alone, and can set
 * some on creation through `extraColumns`. What happens around an account in
 * the app —seeding a new person's first lists, forgetting their OAuth grants
 * when they go— is handed in as `onCreate` and `onRemove`.
 *
 * Rules that hold whoever calls: an install never runs out of administrators;
 * a disabled account can't sign in and its sessions end; changing a password
 * closes the other sessions; a password hash made with less than today's cost
 * is redone at the next sign-in.
 */
import { badRequest, notFound, conflict } from './http.js';
import { hashPassword, verifyPassword, needsRehash } from './crypto.js';
import { ensureColumn } from './migrate.js';

const iso = (ms) => new Date(ms).toISOString();

/** The `users` table in the suite's shape: created whole, or completed on an app's own. */
export function usersSchema(d) {
  if (!d.columnsOf('users').length) {
    d.exec(`CREATE TABLE users (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      username          TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name      TEXT NOT NULL,
      email             TEXT,
      email_verified_at TEXT,
      password_hash     TEXT,
      role              TEXT NOT NULL DEFAULT 'user',
      locale            TEXT,
      theme             TEXT NOT NULL DEFAULT 'system',
      prefs             TEXT NOT NULL DEFAULT '{}',
      created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_login_at     TEXT,
      disabled_at       TEXT
    )`);
    return;
  }
  ensureColumn(d, 'users', 'email', 'email TEXT');
  ensureColumn(d, 'users', 'email_verified_at', 'email_verified_at TEXT');
  ensureColumn(d, 'users', 'locale', 'locale TEXT');
  ensureColumn(d, 'users', 'theme', "theme TEXT NOT NULL DEFAULT 'system'");
  ensureColumn(d, 'users', 'prefs', "prefs TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(d, 'users', 'last_login_at', 'last_login_at TEXT');
  ensureColumn(d, 'users', 'disabled_at', 'disabled_at TEXT');
  // The apps only ever stored an email that WorkOS had verified.
  d.exec("UPDATE users SET email_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE email IS NOT NULL AND email_verified_at IS NULL");
  // SQLite's datetime('now') (UTC, without the T) to ISO, like every other date of the suite.
  if (d.columnsOf('users').includes('created_at')) {
    d.exec("UPDATE users SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at) WHERE created_at NOT LIKE '%T%' AND strftime('%s', created_at) IS NOT NULL");
  }
}

/** A date as ISO, also when it comes in SQLite's `YYYY-MM-DD HH:MM:SS` (UTC). */
const isoOf = (value) => (typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(value)
  ? `${value.replace(' ', 'T')}${value.endsWith('Z') ? '' : 'Z'}` : value ?? null);

const USERNAME = /^[a-zA-Z0-9._-]{2,32}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {object} options
 * @param {object} options.database
 * @param {object} [options.sessions]           to close sessions on password changes and when disabling
 * @param {number} [options.minPasswordLength]
 * @param {(user) => object} [options.extraColumns]   the app's own columns to set on creation
 * @param {(user) => void} [options.onCreate]
 * @param {(userId) => void} [options.onRemove]
 * @param {string[]} [options.roles]            instance roles
 *
 * More can be hooked later with `whenCreated` and `whenRemoved` (organizations
 * do, to hand over the groups of whoever goes). They run inside the same
 * transaction as the change: if one throws, nothing happened.
 */
export function createAccounts({
  database, sessions = null, minPasswordLength = 10, extraColumns = () => ({}),
  onCreate = () => {}, onRemove = () => {}, roles = ['admin', 'user'], clock = () => Date.now(),
}) {
  const created = [onCreate];
  const removed = [onRemove];
  const byId = (id) => database.get('SELECT * FROM users WHERE id = ?', id) || null;
  const byUsername = (name) => database.get('SELECT * FROM users WHERE username = ?', String(name || '').trim()) || null;
  const mustExist = (id) => {
    const user = byId(id);
    if (!user) throw notFound('user_not_found');
    return user;
  };

  /** What may be shown about an account: never its hash. */
  const publicUser = (user) => user && ({
    id: user.id, username: user.username, display_name: user.display_name, email: user.email ?? null,
    role: user.role, locale: user.locale ?? null, theme: user.theme ?? 'system',
    created_at: isoOf(user.created_at), last_login_at: isoOf(user.last_login_at),
    disabled: Boolean(user.disabled_at), has_password: Boolean(user.password_hash && user.password_hash !== '!'),
  });

  const activeAdmins = () => Number(database.get(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL").n);

  function checkPassword(password) {
    if (typeof password !== 'string') throw badRequest('field_invalid', { field: 'password' });
    if (password.length < minPasswordLength) throw badRequest('field_too_short', { field: 'password', min: minPasswordLength });
    if (password.length > 1024) throw badRequest('field_too_long', { field: 'password', max: 1024 });
  }
  function checkEmail(email) {
    if (email == null || email === '') return null;
    const clean = String(email).trim().toLowerCase();
    if (!EMAIL.test(clean) || clean.length > 254) throw badRequest('field_invalid', { field: 'email' });
    return clean;
  }
  function checkName(name) {
    const clean = String(name ?? '').trim();
    if (!clean) throw badRequest('field_required', { field: 'display_name' });
    if (clean.length > 80) throw badRequest('field_too_long', { field: 'display_name', max: 80 });
    return clean;
  }
  function checkRole(role) {
    if (!roles.includes(role)) throw badRequest('field_invalid', { field: 'role', options: roles });
    return role;
  }

  /** Creates an account. Without a password it can only sign in elsewhere (WorkOS, OIDC). */
  function create({ username, displayName, password = null, role = 'user', email = null, locale = null }) {
    const name = String(username || '').trim();
    if (!USERNAME.test(name)) throw badRequest('field_invalid', { field: 'username' });
    if (byUsername(name)) throw conflict('username_taken');
    if (password != null) checkPassword(password);
    const row = {
      username: name, display_name: checkName(displayName ?? name), email: checkEmail(email),
      password_hash: password == null ? null : hashPassword(password), role: checkRole(role),
      locale, created_at: iso(clock()),
    };
    return database.tx(() => {
      const extra = extraColumns(row) || {};
      const columns = [...Object.keys(row), ...Object.keys(extra)];
      const { lastInsertRowid } = database.run(
        `INSERT INTO users (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        ...Object.values(row), ...Object.values(extra),
      );
      const user = byId(lastInsertRowid);
      for (const hook of created) hook(user);
      return user;
    });
  }

  /** Changes what the admin (or the person) may change. `disabled: true` also ends their sessions. */
  function update(id, fields = {}) {
    const user = mustExist(id);
    return database.tx(() => {
      const sets = [];
      const params = [];
      if (fields.displayName !== undefined) { sets.push('display_name = ?'); params.push(checkName(fields.displayName)); }
      if (fields.email !== undefined) { sets.push('email = ?', 'email_verified_at = NULL'); params.push(checkEmail(fields.email)); }
      if (fields.locale !== undefined) { sets.push('locale = ?'); params.push(fields.locale || null); }
      if (fields.role !== undefined && fields.role !== user.role) {
        checkRole(fields.role);
        if (user.role === 'admin' && !user.disabled_at && activeAdmins() <= 1) throw conflict('last_admin');
        sets.push('role = ?'); params.push(fields.role);
      }
      if (fields.disabled !== undefined && Boolean(fields.disabled) !== Boolean(user.disabled_at)) {
        if (fields.disabled && user.role === 'admin' && activeAdmins() <= 1) throw conflict('last_admin');
        sets.push('disabled_at = ?'); params.push(fields.disabled ? iso(clock()) : null);
        if (fields.disabled) sessions?.closeAllOf(id);
      }
      if (sets.length) database.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
      return byId(id);
    });
  }

  /** Sets a password and closes every other session of the person (all, without `exceptToken`). */
  function setPassword(id, password, { exceptToken = null } = {}) {
    mustExist(id);
    checkPassword(password);
    database.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), id);
    sessions?.closeAllOf(id, { exceptToken });
  }

  /**
   * The account of a username and password, or null. A disabled account never
   * signs in; a hash below today's cost is redone now that the password is known.
   */
  function verify(username, password) {
    const user = byUsername(username);
    if (!user?.password_hash || user.disabled_at) {
      // Same work either way: the time taken doesn't say whether the account exists.
      verifyPassword(String(password || ''), 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      return null;
    }
    if (!verifyPassword(String(password || ''), user.password_hash)) return null;
    const rehash = needsRehash(user.password_hash) ? hashPassword(String(password)) : null;
    database.run(`UPDATE users SET last_login_at = ?${rehash ? ', password_hash = ?' : ''} WHERE id = ?`,
      iso(clock()), ...(rehash ? [rehash] : []), user.id);
    return byId(user.id);
  }

  /** Notes a sign-in that happened elsewhere (WorkOS, OIDC), for the admin panel. */
  const signedIn = (id) => database.run('UPDATE users SET last_login_at = ? WHERE id = ?', iso(clock()), id);

  /** Deletes an account and what hangs from it; never the last administrator. */
  function remove(id) {
    const user = mustExist(id);
    if (user.role === 'admin' && !user.disabled_at && activeAdmins() <= 1) throw conflict('last_admin');
    return database.tx(() => {
      for (const hook of removed) hook(id);
      database.run('DELETE FROM users WHERE id = ?', id);
      return true;
    });
  }

  const list = () => database.all('SELECT * FROM users ORDER BY id');

  return {
    create, update, setPassword, verify, signedIn, remove, byId, byUsername, list, publicUser, activeAdmins,
    whenCreated: (hook) => { created.push(hook); },
    whenRemoved: (hook) => { removed.push(hook); },
  };
}

