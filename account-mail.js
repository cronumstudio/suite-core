/**
 * What accounts send by mail: a link to confirm an email, a link to choose a
 * new password when the old one is forgotten, invitations to create an
 * account, and sign-up when an install leaves it open.
 *
 * Every link carries a single-use token, kept only as a hash, for a while: a
 * confirmation 48 hours, a new password one hour, an invitation seven days.
 * Asking for a new password answers the same whether the account exists or
 * not, and the brake limits both who asks and how often one inbox receives.
 */
import { randomToken, sha256 } from './crypto.js';
import { HttpError, badRequest, forbidden } from './http.js';

const HOUR = 3600 * 1000;
const LIFETIME = { verify: 48 * HOUR, reset: HOUR, invite: 7 * 24 * HOUR };
const PREFIX = { verify: 'ev_', reset: 'pr_', invite: 'ai_' };
const iso = (ms) => new Date(ms).toISOString();

export function accountTokensSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS account_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    purpose     TEXT NOT NULL,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    email       TEXT,
    role        TEXT,
    token_hash  TEXT NOT NULL UNIQUE,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used_at     TEXT,
    revoked_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_account_tokens_user ON account_tokens (user_id, purpose)`);
}

/**
 * @param {object} options
 * @param {object} options.accounts     from createAccounts()
 * @param {object} options.mailer       from createMailer()
 * @param {Function} options.texts      (req, user) → { lang, t }, for the messages
 * @param {string} options.baseUrl, options.appName
 * @param {'admin'|'invite'|'open'} [options.signup]   who may create an account
 * @param {boolean} [options.localPasswords]   false when accounts sign in elsewhere
 * @param {string[]} [options.roles]    the roles an invitation may give
 */
export function createAccountMail({
  database, accounts, mailer, texts, baseUrl, appName, limiter = null, audit = null,
  signup = 'admin', localPasswords = true, roles = ['admin', 'user'], clock = () => Date.now(), log = console.log,
}) {
  const BASE_URL = String(baseUrl).replace(/\/+$/, '');
  const link = (param, token) => `${BASE_URL}/?${param}=${encodeURIComponent(token)}`;
  const refuse = (allowed) => {
    if (allowed && !allowed.allowed) throw new HttpError(429, 'too_many_attempts', { retry_after: allowed.retryAfter });
  };
  /** Per address: said openly, the same whoever it is for. */
  const brake = (kind, req) => refuse(limiter?.allow(kind, req));
  /** Per inbox. */
  const inboxAllows = (email) => limiter?.allowTo('mail', email)?.allowed ?? true;
  const cleanEmail = (value) => {
    const email = String(value ?? '').trim().toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email.length > 254) throw badRequest('field_invalid', { field: 'email' });
    return email;
  };

  function issue(purpose, { userId = null, email = null, role = null, createdBy = null }) {
    const now = clock();
    // A new link of the same kind replaces the ones still open.
    if (userId) {
      database.run(`UPDATE account_tokens SET revoked_at = ? WHERE user_id = ? AND purpose = ?
        AND used_at IS NULL AND revoked_at IS NULL`, iso(now), userId, purpose);
    }
    const token = `${PREFIX[purpose]}${randomToken(24)}`;
    const { lastInsertRowid: id } = database.run(`INSERT INTO account_tokens
      (purpose, user_id, email, role, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    purpose, userId, email, role, sha256(token), createdBy, iso(now), iso(now + LIFETIME[purpose]));
    return { id, token, expiresAt: iso(now + LIFETIME[purpose]) };
  }

  /** The open token of a link, or why it can't be used. */
  function open(purpose, token) {
    const row = database.get('SELECT * FROM account_tokens WHERE token_hash = ? AND purpose = ?',
      sha256(String(token || '')), purpose);
    if (!row || row.used_at || row.revoked_at) throw badRequest('link_invalid');
    if (row.expires_at <= iso(clock())) throw new HttpError(410, 'link_expired');
    return row;
  }
  const used = (id) => database.run('UPDATE account_tokens SET used_at = ? WHERE id = ?', iso(clock()), id);

  /**
   * Sends one of the suite's messages. When the mail server fails, the reason
   * goes to the log (whoever runs the install can read it) and the request
   * gets `mail_failed`: a person can't fix it, but knows it wasn't sent.
   */
  async function send(to, key, vars, { req = null, user = null } = {}) {
    const { t } = texts(req, user);
    const all = { app: appName, ...vars };
    try {
      await mailer.send({ to, subject: t(`mail.${key}.subject`, all), text: t(`mail.${key}.body`, all) });
    } catch (err) {
      log(`[mail] to ${to}: not sent (${key}): ${err.message}`);
      throw new HttpError(502, 'mail_failed');
    }
  }

  /* ----------------------------- confirming ---------------------------- */

  /** Sends the account a link to confirm its email. */
  async function sendVerification(user, { req = null } = {}) {
    if (!user.email) throw badRequest('no_email');
    if (user.email_verified_at) throw badRequest('already_verified');
    brake('mail', req);
    // Someone signed in asks for it: saying it's too soon reveals nothing.
    refuse(limiter?.allowTo('mail', user.email));
    const { token } = issue('verify', { userId: user.id, email: user.email });
    await send(user.email, 'verify', { name: user.display_name, email: user.email, link: link('verify', token) }, { req, user });
    audit?.record({ action: 'account.verify.sent', actor: user, req });
  }

  /** Confirms an email; the link must still be for the account's current one. */
  function verifyEmail(token, { req = null } = {}) {
    return database.tx(() => {
      const row = open('verify', token);
      const user = accounts.byId(row.user_id);
      if (!user || user.email !== row.email) throw badRequest('link_invalid');
      used(row.id);
      database.run('UPDATE users SET email_verified_at = ? WHERE id = ?', iso(clock()), user.id);
      audit?.record({ action: 'account.verify', actor: user, req });
      return accounts.byId(user.id);
    });
  }

  /* ---------------------------- new password ---------------------------- */

  /**
   * "I forgot my password": a link to every active account with that username
   * or email, sent to its email. The answer is the same whether there is one
   * or not, so it can't be used to find out who has an account.
   */
  async function requestReset(login, { req = null } = {}) {
    if (!localPasswords) throw badRequest('passwords_managed_elsewhere');
    const clean = String(login ?? '').trim().toLowerCase();
    if (!clean) throw badRequest('field_required', { field: 'login' });
    brake('mail', req);
    const found = database.all(`SELECT * FROM users WHERE (username = ? COLLATE NOCASE OR email = ?)
      AND email IS NOT NULL AND disabled_at IS NULL`, clean, clean);
    for (const user of found) {
      // A full inbox gets nothing more for a while, and the answer stays the same.
      if (!inboxAllows(user.email)) {
        log(`[mail] no new-password link for user #${user.id}: too many in a short while`);
        continue;
      }
      const { token } = issue('reset', { userId: user.id, email: user.email });
      try {
        await send(user.email, 'reset', {
          name: user.display_name, username: user.username, link: link('reset', token),
        }, { req, user });
        audit?.record({ action: 'account.reset.sent', actor: user, req });
      } catch {
        // Logged by send(); the answer stays the same, or it would tell who has an account.
      }
    }
  }

  /** A new password from a link: every session ends, and the email is now known to be theirs. */
  function resetPassword(token, password, { req = null } = {}) {
    if (!localPasswords) throw badRequest('passwords_managed_elsewhere');
    return database.tx(() => {
      const row = open('reset', token);
      const user = accounts.byId(row.user_id);
      if (!user || user.disabled_at || user.email !== row.email) throw badRequest('link_invalid');
      // A password that doesn't pass leaves the link as it was, for another try.
      accounts.setPassword(user.id, password);
      used(row.id);
      if (!user.email_verified_at) database.run('UPDATE users SET email_verified_at = ? WHERE id = ?', iso(clock()), user.id);
      audit?.record({ action: 'account.reset', actor: user, req });
      return accounts.byId(user.id);
    });
  }

  /* ------------------------ invitations and sign-up ------------------------ */

  /**
   * The admin invites someone to create their own account. The link is also
   * returned, to pass on by hand when there is no mail server.
   */
  async function invite({ email, role = 'user', by = null, req = null }) {
    if (!localPasswords) throw badRequest('passwords_managed_elsewhere');
    const address = cleanEmail(email);
    if (!roles.includes(role)) throw badRequest('field_invalid', { field: 'role', options: roles });
    const { id, token, expiresAt } = issue('invite', { email: address, role, createdBy: by?.id ?? null });
    const url = link('signup', token);
    // With the log provider the message only reaches the server's log: it is
    // not "sent", and the admin passes the link on.
    let sent = mailer.provider !== 'log';
    try {
      await send(address, 'invite', { inviter: by?.display_name || appName, link: url }, { req, user: by });
    } catch {
      sent = false;   // logged by send(); the link is returned to pass on by hand
    }
    audit?.record({ action: 'admin.invite', actor: by, req, targetType: 'invitation', targetId: id, meta: { role } });
    return { id, email: address, role, url, expires_at: expiresAt, sent };
  }

  const invitations = () => database.all(`SELECT id, email, role, created_by, created_at, expires_at, used_at, revoked_at
    FROM account_tokens WHERE purpose = 'invite' ORDER BY id DESC`);

  const revokeInvitation = (id) => database.run(`UPDATE account_tokens SET revoked_at = ? WHERE id = ? AND purpose = 'invite'
    AND used_at IS NULL AND revoked_at IS NULL`, iso(clock()), id).changes > 0;

  /**
   * Creates an account: with an invitation (its email, already confirmed, and
   * its role), or —only when sign-up is open— by anyone, whose email is then
   * sent a confirmation link.
   */
  async function signUp({ token = null, username, displayName = null, email = null, password, locale = null }, { req = null } = {}) {
    if (!localPasswords) throw badRequest('passwords_managed_elsewhere');
    if (password == null || password === '') throw badRequest('field_required', { field: 'password' });
    if (token) {
      const user = database.tx(() => {
        const row = open('invite', token);
        const created = accounts.create({ username, displayName, password, email: row.email, role: row.role || 'user', locale });
        database.run('UPDATE users SET email_verified_at = ? WHERE id = ?', iso(clock()), created.id);
        used(row.id);
        return accounts.byId(created.id);
      });
      audit?.record({ action: 'account.signup', actor: user, req, meta: { invited: true } });
      return user;
    }
    if (signup !== 'open') throw forbidden('signup_closed');
    const address = cleanEmail(email);
    brake('signup', req);
    const user = accounts.create({ username, displayName, password, email: address, role: 'user', locale });
    audit?.record({ action: 'account.signup', actor: user, req, meta: { invited: false } });
    try {
      await sendVerification(user, { req });
    } catch (err) {
      // A failed send was logged by send(); anything else (the brake) is said here.
      if (err.code !== 'mail_failed') log(`[mail] the confirmation for user #${user.id} was not sent: ${err.message}`);
    }
    return user;
  }

  /** Forgets links that ended more than a month ago. */
  const purge = () => database.run('DELETE FROM account_tokens WHERE expires_at < ?',
    iso(clock() - 30 * 24 * HOUR)).changes;

  return {
    signup, sendVerification, verifyEmail, requestReset, resetPassword, invite, invitations, revokeInvitation,
    signUp, purge,
  };
}
