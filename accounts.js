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
 *
 * Someone can ask for their own account to be deleted: it is disabled at once
 * and kept `delete_after` a grace period (account-deletion.js deletes it then),
 * so that whoever asked by mistake, or never asked because someone else was in
 * their session, can sign in and take it back.
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
 * When an account its owner asked to delete goes for good: until then it is
 * disabled, and signing in offers to take it back.
 */
export function accountDeletionSchema(d) {
  ensureColumn(d, 'users', 'delete_after', 'delete_after TEXT');
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

export const USERNAME = /^[a-zA-Z0-9._-]{2,32}$/;
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
 * More can be hooked later with `whenCreated`, `whenRemoved` (organizations
 * do, to hand over the groups of whoever goes) and `whenLinked` (billing).
 * They run inside the same transaction as the change: if one throws, nothing
 * happened.
 */
export function createAccounts({
  database, sessions = null, minPasswordLength = 10, extraColumns = () => ({}),
  onCreate = () => {}, onRemove = () => {}, roles = ['admin', 'user'], clock = () => Date.now(),
}) {
  const created = [onCreate];
  const removed = [onRemove];
  /**
   * Who hears that an account was linked to one at a provider: made with it,
   * linked by its email or moved to a new id. Inside the same transaction, like
   * whenCreated: billing gives then what was paid for by that identity before
   * it had an account here.
   */
  const linked = [];
  /**
   * Who hears that an account changed (its email confirmed, a new password,
   * the second step, what the admin changed): the live channel tells the
   * person's open tabs, which reload what they show of it. Other modules that
   * change an account (account-mail, two-factor) say so with `changed(id)`.
   */
  const changes = [];
  const changed = (id) => {
    for (const hook of changes) {
      try { hook(Number(id)); } catch { /* a listener never breaks the change */ }
    }
  };
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
    email_verified: Boolean(user.email_verified_at),
    role: user.role, locale: user.locale ?? null, theme: user.theme ?? 'system',
    created_at: isoOf(user.created_at), last_login_at: isoOf(user.last_login_at),
    disabled: Boolean(user.disabled_at), has_password: Boolean(user.password_hash && user.password_hash !== '!'),
    two_factor: Boolean(user.two_factor_at),
    // Its owner asked to delete it: it goes for good then, unless they take it back.
    ...(user.delete_after ? { delete_after: isoOf(user.delete_after) } : {}),
  });

  const activeAdmins = () => Number(database.get(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL").n);

  /**
   * A disabled account's sessions end, and its devices go too: notices carry
   * task titles and list names, and an app picks whom to notify from that
   * table without asking who is disabled.
   */
  function shutOut(id) {
    sessions?.closeAllOf(id);
    if (database.columnsOf('push_subscriptions').length) database.run('DELETE FROM push_subscriptions WHERE user_id = ?', id);
  }

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
   * `quiet`: the account arrives with its data (an import), so what the app
   * makes for a newcomer —Tasks' first lists— isn't made for it.
   */
  function create({
    username, displayName, password = null, role = 'user', email = null, locale = null, identity = null,
  }, { quiet = false } = {}) {
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
      if (!quiet) for (const hook of created) hook(user);
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
  function insertIdentity(userId, provider, subject, email) {
    database.run(`INSERT INTO user_identities (user_id, provider, subject, email, created_at)
      VALUES (?, ?, ?, ?, ?)`, userId, provider, String(subject), email, iso(clock()));
    for (const hook of linked) hook({ userId: Number(userId), provider, subject: String(subject) });
  }

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

  /**
   * The account with that verified email linked to the provider under another
   * subject, and that subject: someone the provider may now know by a new id
   * (another environment of it, or their account there made again).
   */
  function linkedByEmail(provider, email) {
    const row = database.get(`SELECT i.user_id, i.subject FROM users u
      JOIN user_identities i ON i.user_id = u.id AND i.provider = ?
      WHERE u.email = ? COLLATE NOCASE AND u.email_verified_at IS NOT NULL
      ORDER BY u.id, i.id LIMIT 1`, provider, String(email || '').trim().toLowerCase());
    return row ? { user: byId(row.user_id), subject: row.subject } : null;
  }

  /** Moves an account's link at a provider from the subject it had to a new one. */
  function relinkIdentity(userId, provider, from, to, { email = null } = {}) {
    database.tx(() => {
      database.run('DELETE FROM user_identities WHERE user_id = ? AND provider = ? AND subject = ?',
        userId, provider, String(from));
      insertIdentity(userId, provider, to, email);
      if (email) setVerifiedEmail(userId, email);
    });
  }

  /**
   * The oldest administrator not linked to the provider: whose account the
   * admin email takes over when an install moves to the provider. Only while
   * nobody is linked to it yet, or one with no email: an administrator with an
   * email, made once people sign in there, is that person's, and taking it
   * gave the admin email someone else's account and data.
   */
  const firstUnlinkedAdmin = (provider) => database.get(`SELECT * FROM users u
    WHERE u.role = 'admin' AND NOT EXISTS
      (SELECT 1 FROM user_identities i WHERE i.user_id = u.id AND i.provider = ?)
      AND (u.email IS NULL OR NOT EXISTS (SELECT 1 FROM user_identities WHERE provider = ?))
    ORDER BY u.id LIMIT 1`, provider, provider) || null;

  /** An email a provider vouches for: stored as verified. */
  function setVerifiedEmail(userId, email) {
    const clean = checkEmail(email);
    database.run('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?', clean, clean ? iso(clock()) : null, userId);
    changed(userId);
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

  /**
   * Changes what the admin (or the person) may change. `disabled: true` also
   * ends their sessions; `emailVerified` is the admin's alone: it confirms the
   * email by hand, or takes that back.
   */
  function update(id, fields = {}) {
    const user = mustExist(id);
    return database.tx(() => {
      const sets = [];
      const params = [];
      // Only what really changes is written, and said (whenChanged).
      if (fields.displayName !== undefined) {
        const name = checkName(fields.displayName);
        if (name !== user.display_name) { sets.push('display_name = ?'); params.push(name); }
      }
      let email = user.email ?? null;
      let verifiedAt = user.email_verified_at ?? null;
      if (fields.email !== undefined) {
        const given = checkEmail(fields.email);
        // Only another address has to be confirmed again.
        if (given !== email) { email = given; verifiedAt = null; sets.push('email = ?'); params.push(email); }
      }
      // An administrator vouches for an address (without a mail server there
      // is no other way to confirm it), or takes that back.
      if (fields.emailVerified !== undefined) {
        if (fields.emailVerified && !email) throw badRequest('field_required', { field: 'email' });
        verifiedAt = fields.emailVerified ? verifiedAt || iso(clock()) : null;
      }
      if (verifiedAt !== (user.email_verified_at ?? null)) { sets.push('email_verified_at = ?'); params.push(verifiedAt); }
      if (fields.locale !== undefined && (fields.locale || null) !== (user.locale ?? null)) {
        sets.push('locale = ?'); params.push(fields.locale || null);
      }
      if (fields.role !== undefined && fields.role !== user.role) {
        checkRole(fields.role);
        if (user.role === 'admin' && !user.disabled_at && activeAdmins() <= 1) throw conflict('last_admin');
        sets.push('role = ?'); params.push(fields.role);
      }
      if (fields.disabled !== undefined && Boolean(fields.disabled) !== Boolean(user.disabled_at)) {
        if (fields.disabled && user.role === 'admin' && activeAdmins() <= 1) throw conflict('last_admin');
        sets.push('disabled_at = ?'); params.push(fields.disabled ? iso(clock()) : null);
        // The admin enabling an account its owner asked to delete takes the deletion back too.
        if (!fields.disabled && user.delete_after) sets.push('delete_after = NULL');
        if (fields.disabled) shutOut(id);
      }
      if (sets.length) {
        database.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
        changed(id);
      }
      return byId(id);
    });
  }

  /** Sets a password and closes every other session of the person (all, without `exceptToken`). */
  function setPassword(id, password, { exceptToken = null } = {}) {
    mustExist(id);
    checkPassword(password);
    database.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), id);
    sessions?.closeAllOf(id, { exceptToken });
    changed(id);
  }

  /**
   * The account of a username and password, or null. A disabled account never
   * signs in; a hash below today's cost is redone now that the password is known.
   * With `signIn: false` the sign-in isn't noted yet (a second step comes).
   * With `pending: true` an account waiting to be deleted is returned as well,
   * for the caller to offer it back (it has `delete_after`): it doesn't sign in.
   */
  function verify(username, password, { signIn = true, pending = false } = {}) {
    const user = byUsername(username);
    const waiting = pending && user?.disabled_at && user.delete_after;
    if (!user?.password_hash || user.password_hash === '!' || (user.disabled_at && !waiting)) {
      // Same work either way: the time taken doesn't say whether the account exists.
      verifyPassword(String(password || ''), 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      return null;
    }
    if (!verifyPassword(String(password || ''), user.password_hash)) return null;
    const rehash = needsRehash(user.password_hash) ? hashPassword(String(password)) : null;
    if (rehash) database.run('UPDATE users SET password_hash = ? WHERE id = ?', rehash, user.id);
    if (signIn) signedIn(user.id);
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

  /**
   * Its owner asks to delete the account: disabled now (sessions and devices
   * out, as when the admin disables it) and deleted for good once `days` have
   * passed. Asked again, it keeps the first date. Never the last administrator.
   */
  function requestDeletion(id, { days = 30 } = {}) {
    const user = mustExist(id);
    if (user.delete_after) return user;
    if (user.disabled_at) throw conflict('account_disabled');
    if (user.role === 'admin' && activeAdmins() <= 1) throw conflict('last_admin');
    const now = clock();
    database.tx(() => {
      database.run('UPDATE users SET disabled_at = ?, delete_after = ? WHERE id = ?',
        iso(now), iso(now + days * 24 * 60 * 60 * 1000), id);
      shutOut(id);
    });
    changed(id);
    return byId(id);
  }

  /** The owner takes the account back before it goes: enabled again, as it was. False if it wasn't waiting. */
  function cancelDeletion(id) {
    const done = database.run(`UPDATE users SET disabled_at = NULL, delete_after = NULL
      WHERE id = ? AND delete_after IS NOT NULL`, id).changes > 0;
    if (done) changed(id);
    return done;
  }

  /** The accounts whose grace period is over, the oldest request first. */
  const dueForDeletion = () => database.all(`SELECT * FROM users
    WHERE delete_after IS NOT NULL AND delete_after <= ? ORDER BY delete_after, id`, iso(clock()));

  const list = () => database.all('SELECT * FROM users ORDER BY id');

  return {
    create, update, setPassword, checkPassword, verify, signedIn, remove, byId, byUsername, list, publicUser, activeAdmins,
    requestDeletion, cancelDeletion, dueForDeletion,
    byIdentity, linkIdentity, unlinkIdentity, identitiesOf, usedIdentity, unlinkedByEmail, firstUnlinkedAdmin,
    linkedByEmail, relinkIdentity,
    setVerifiedEmail, fromIdentity, freeUsername,
    whenCreated: (hook) => { created.push(hook); },
    whenRemoved: (hook) => { removed.push(hook); },
    whenLinked: (hook) => { linked.push(hook); },
    whenChanged: (hook) => { changes.push(hook); },
    changed,
  };
}

