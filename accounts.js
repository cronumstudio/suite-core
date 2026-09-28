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

/**
 * The accounts people have elsewhere and sign in with: WorkOS, an OIDC
 * provider, Google… one row per provider and account, instead of a column per
 * provider in `users`. The WorkOS links the apps kept in `users.workos_user_id`
 * are copied over; the column stays, unused.
 */
export function identitiesSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS user_identities (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider     TEXT NOT NULL,
    subject      TEXT NOT NULL,
    email        TEXT,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    UNIQUE (provider, subject)
  );
  CREATE INDEX IF NOT EXISTS ix_identities_user ON user_identities (user_id)`);
  if (d.columnsOf('users').includes('workos_user_id')) {
    d.exec(`INSERT OR IGNORE INTO user_identities (user_id, provider, subject, email, created_at)
      SELECT id, 'workos', workos_user_id, email, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM users WHERE workos_user_id IS NOT NULL`);
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
  // An app's own table may say `password_hash NOT NULL` (Tasks): there an
  // account without a password stores `!`, which no password ever matches.
  const noPassword = database.all('PRAGMA table_info(users)')
    .some((c) => c.name === 'password_hash' && c.notnull) ? '!' : null;
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

  /**
   * Creates an account. Without a password it can only sign in elsewhere; with
   * `identity: { provider, subject, email }` it is linked to that account in
   * the same transaction, and the provider's email is taken as verified.
   */
  function create({ username, displayName, password = null, role = 'user', email = null, locale = null, identity = null }) {
    const name = String(username || '').trim();
    if (!USERNAME.test(name)) throw badRequest('field_invalid', { field: 'username' });
    if (byUsername(name)) throw conflict('username_taken');
    if (password != null) checkPassword(password);
    const row = {
      username: name, display_name: checkName(displayName ?? name), email: checkEmail(email ?? identity?.email),
      password_hash: password == null ? noPassword : hashPassword(password), role: checkRole(role),
      locale, created_at: iso(clock()),
    };
    if (identity?.email && row.email === checkEmail(identity.email)) row.email_verified_at = row.created_at;
    return database.tx(() => {
      const extra = extraColumns(row) || {};
      const columns = [...Object.keys(row), ...Object.keys(extra)];
      const { lastInsertRowid } = database.run(
        `INSERT INTO users (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        ...Object.values(row), ...Object.values(extra),
      );
      if (identity) insertIdentity(lastInsertRowid, identity.provider, identity.subject, row.email_verified_at ? row.email : null);
      const user = byId(lastInsertRowid);
      for (const hook of created) hook(user);
      return user;
    });
  }

  /* ----------------------------- identities ----------------------------- */

  /** The account linked to someone's account at a provider, or null. */
  const byIdentity = (provider, subject) => database.get(`SELECT u.* FROM user_identities i
    JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?`, provider, String(subject)) || null;

  /**
   * Links an account to one at a provider. A provider's account belongs to one
   * account only: linking it twice fails on the table's unique key, which is
   * what settles two sign-ins racing to create the same person.
   */
  const insertIdentity = (userId, provider, subject, email) => database.run(`INSERT INTO user_identities
    (user_id, provider, subject, email, created_at) VALUES (?, ?, ?, ?, ?)`, userId, provider, String(subject), email, iso(clock()));

  function linkIdentity(userId, provider, subject, { email = null } = {}) {
    database.tx(() => {
      insertIdentity(userId, provider, subject, email);
      if (email) setVerifiedEmail(userId, email);
    });
  }

  const unlinkIdentity = (userId, provider) => database.run(
    'DELETE FROM user_identities WHERE user_id = ? AND provider = ?', userId, provider).changes > 0;

  const identitiesOf = (userId) => database.all(`SELECT provider, subject, email, created_at, last_used_at
    FROM user_identities WHERE user_id = ? ORDER BY provider`, userId);

  /** Notes a sign-in through a provider, on the identity and the account. */
  function usedIdentity(provider, subject) {
    const now = iso(clock());
    database.run('UPDATE user_identities SET last_used_at = ? WHERE provider = ? AND subject = ?', now, provider, String(subject));
    database.run(`UPDATE users SET last_login_at = ? WHERE id =
      (SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?)`, now, provider, String(subject));
  }

  /** An account with that email not linked to the provider yet: someone who had one before it. */
  const unlinkedByEmail = (provider, email) => database.get(`SELECT * FROM users u
    WHERE u.email = ? COLLATE NOCASE AND NOT EXISTS
      (SELECT 1 FROM user_identities i WHERE i.user_id = u.id AND i.provider = ?)
    ORDER BY u.id LIMIT 1`, String(email || '').trim().toLowerCase(), provider) || null;

  /** The oldest administrator not linked to the provider: whose account the admin email takes over. */
  const firstUnlinkedAdmin = (provider) => database.get(`SELECT * FROM users u
    WHERE u.role = 'admin' AND NOT EXISTS
      (SELECT 1 FROM user_identities i WHERE i.user_id = u.id AND i.provider = ?)
    ORDER BY u.id LIMIT 1`, provider) || null;

  /** An email a provider vouches for: stored as verified. */
  function setVerifiedEmail(userId, email) {
    const clean = checkEmail(email);
    database.run('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?', clean, clean ? iso(clock()) : null, userId);
  }

  /** A free username from a seed (an email, a provider's username): ana.perez, ana.perez2… */
  function freeUsername(seed) {
    let base = String(seed || '').split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 28);
    if (base.length < 2) base = 'user';
    let name = base;
    for (let n = 2; byUsername(name); n++) name = `${base}${n}`;
    return name;
  }

  /**
   * The account of someone who signed in at a provider (an OIDC one, Google…),
   * created if there is none yet:
   *   · already linked: that account, its email refreshed when the provider vouches for a new one;
   *   · a verified email of an account not linked to the provider: that account, now linked
   *     (someone who had an account before the provider). Only a verified email: otherwise
   *     signing up there with someone else's address would be enough to take their data;
   *   · the admin email, verified, with nobody linked yet: the oldest administrator;
   *   · otherwise a new account, an administrator when it is the admin email.
   * A disabled account is returned as it is: whoever calls keeps it out.
   */
  function fromIdentity({ provider, subject, email = null, emailVerified = false, displayName = null, username = null },
    { adminEmail = '' } = {}) {
    let verified = null;
    if (emailVerified && email) {
      try { verified = checkEmail(email); } catch { verified = null; }
    }
    const admin = String(adminEmail || '').trim().toLowerCase();
    return database.tx(() => {
      let user = byIdentity(provider, subject);
      if (user) {
        if (verified && verified !== user.email) setVerifiedEmail(user.id, verified);
      } else {
        const previous = verified
          ? unlinkedByEmail(provider, verified) || (verified === admin ? firstUnlinkedAdmin(provider) : null)
          : null;
        if (previous) {
          linkIdentity(previous.id, provider, subject, { email: verified });
          user = previous;
        } else {
          const name = freeUsername(username || verified || 'user');
          user = create({
            username: name, displayName: String(displayName || name).trim().slice(0, 80) || name,
            role: verified && verified === admin ? 'admin' : 'user',
            identity: { provider, subject, email: verified },
          });
        }
      }
      usedIdentity(provider, subject);
      return byId(user.id);
    });
  }

  /** Changes what the admin (or the person) may change. `disabled: true` also ends their sessions. */
  function update(id, fields = {}) {
    const user = mustExist(id);
    return database.tx(() => {
      const sets = [];
      const params = [];
      if (fields.displayName !== undefined) { sets.push('display_name = ?'); params.push(checkName(fields.displayName)); }
      if (fields.email !== undefined) {
        const email = checkEmail(fields.email);
        // Only another address has to be confirmed again.
        if (email !== (user.email ?? null)) { sets.push('email = ?', 'email_verified_at = NULL'); params.push(email); }
      }
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
    if (!user?.password_hash || user.password_hash === '!' || user.disabled_at) {
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
    byIdentity, linkIdentity, unlinkIdentity, identitiesOf, usedIdentity, unlinkedByEmail, firstUnlinkedAdmin,
    setVerifiedEmail, fromIdentity, freeUsername,
    whenCreated: (hook) => { created.push(hook); },
    whenRemoved: (hook) => { removed.push(hook); },
  };
}

