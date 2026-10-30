/**
 * Invitations by email to an address nobody has an account with (Martin, 2026-10-30: "si se
 * quiere invitar a alguien que no tiene cuenta, ¿cómo se haría?"). Something offered by email
 * already waits under the address until someone signs up with it; this tells that address,
 * once, so it isn't left to the person who offered it. It is the one email the suite sends to
 * someone who never asked for anything from the app, so it is held to what keeps the sender's
 * reputation (Martin: "nada sospechoso de spam"):
 *
 *   · only where an account can be made (an identity provider, or sign-up open), and only from
 *     someone whose own email is confirmed;
 *   · once for each address and person inviting, never sent again, whatever is offered later;
 *   · at most STRANGER_LIMITS.perInviterDay a day from one person, perAddressMonth in 30 days to
 *     one address, and perDay a day from the whole install (MAIL_STRANGERS_PER_DAY, 100 by
 *     default: a net against someone inviting in bulk from many accounts, not a rule for
 *     ordinary use; reaching it sends the install's alert, `onInstallLimit`, to raise it);
 *   · never to an address that asked for no more: every one carries a link and the one-click
 *     List-Unsubscribe headers (RFC 8058), which end them for that address for good.
 *
 * None of it shows to whoever offers: the answer is the same whether an email went or not, as
 * it is whether the address has an account (sharing.js), so it tells nothing about anyone.
 *
 * The link to stop them carries a random token of the email it came in (`token`), never the
 * address: GET /api/mail/unsubscribe?t=… asks, and a POST to the same address (the page's button,
 * or the mail client's one click) does it.
 */
import crypto from 'node:crypto';
import { renderMail } from './mail-layout.js';

export const STRANGER_LIMITS = Object.freeze({ perInviterDay: 10, perAddressMonth: 3, perDay: 100 });

const DAY_MS = 24 * 60 * 60 * 1000;

/** Migration 29: what was sent to whom, and the addresses that asked for no more. */
export function strangerInvitesSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS mail_stranger_invites (
    id          INTEGER PRIMARY KEY,
    email       TEXT NOT NULL COLLATE NOCASE,
    inviter_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    token       TEXT NOT NULL UNIQUE,
    sent_at     TEXT NOT NULL
  )`);
  d.exec('CREATE INDEX IF NOT EXISTS idx_stranger_invites_email ON mail_stranger_invites(email, sent_at)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_stranger_invites_inviter ON mail_stranger_invites(inviter_id, sent_at)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_stranger_invites_sent ON mail_stranger_invites(sent_at)');
  d.exec(`CREATE TABLE IF NOT EXISTS mail_suppressions (
    email       TEXT PRIMARY KEY COLLATE NOCASE,
    created_at  TEXT NOT NULL
  )`);
}

/**
 * @param {object} options
 * @param {object} options.database   the suite's ({ get, all, run })
 * @param {string} options.baseUrl    the install's address: where the link to stop them goes
 * @param {boolean} [options.enabled] whether anyone can make an account here (idp, or sign-up open)
 * @param {object} [options.limits]   over STRANGER_LIMITS (tests)
 * @param {Function} [options.onInstallLimit]  (limit) → told each time perDay stops one (alerts.js `strangers`)
 * @param {Function} [options.clock]  → milliseconds
 * @returns {{ enabled, check(email, inviter) → string|null, record(email, inviterId, kind) → { token, url },
 *   unsubscribeUrl(token), suppress(token) → string|null, emailOf(token) → string|null }}
 */
export function createStrangerInvites({ database, baseUrl, enabled = true, limits = {}, onInstallLimit = null, clock = Date.now }) {
  const max = { ...STRANGER_LIMITS, ...limits };
  const iso = (ms) => new Date(ms).toISOString();
  const home = String(baseUrl || '').replace(/\/+$/, '');
  const count = (sql, ...params) => database.get(sql, ...params)?.n ?? 0;

  /** Why nothing may go to this address from this person now, or null when it may. */
  function check(email, inviter) {
    if (!enabled) return 'no_signup';
    const address = String(email || '').trim().toLowerCase();
    if (!address || !inviter?.id) return 'nobody';
    if (!inviter.email || !inviter.email_verified_at) return 'inviter_unconfirmed';
    if (database.get('SELECT 1 AS x FROM mail_suppressions WHERE email = ?', address)) return 'unsubscribed';
    if (database.get('SELECT 1 AS x FROM mail_stranger_invites WHERE email = ? AND inviter_id = ?', address, inviter.id)) return 'already_sent';
    const now = clock();
    if (count('SELECT COUNT(*) AS n FROM mail_stranger_invites WHERE inviter_id = ? AND sent_at > ?', inviter.id, iso(now - DAY_MS)) >= max.perInviterDay) return 'inviter_limit';
    if (count('SELECT COUNT(*) AS n FROM mail_stranger_invites WHERE email = ? AND sent_at > ?', address, iso(now - 30 * DAY_MS)) >= max.perAddressMonth) return 'address_limit';
    if (count('SELECT COUNT(*) AS n FROM mail_stranger_invites WHERE sent_at > ?', iso(now - DAY_MS)) >= max.perDay) {
      try { onInstallLimit?.(max.perDay); } catch { /* an alert that fails stops nothing */ }
      return 'install_limit';
    }
    return null;
  }

  const unsubscribeUrl = (token) => `${home}/api/mail/unsubscribe?t=${encodeURIComponent(token)}`;

  /** Notes one as sent, before it goes (two at once can't both pass check()). → its link to stop them. */
  function record(email, inviterId, kind) {
    const token = crypto.randomBytes(18).toString('base64url');
    database.run('INSERT INTO mail_stranger_invites (email, inviter_id, kind, token, sent_at) VALUES (?, ?, ?, ?, ?)',
      String(email).trim().toLowerCase(), inviterId, kind, token, iso(clock()));
    return { token, url: unsubscribeUrl(token) };
  }

  const emailOf = (token) => (token ? database.get('SELECT email FROM mail_stranger_invites WHERE token = ?', String(token))?.email ?? null : null);

  /** No more to the address its token went to. → the address, or null for a token nobody has. */
  function suppress(token) {
    const email = emailOf(token);
    if (email) database.run('INSERT OR IGNORE INTO mail_suppressions (email, created_at) VALUES (?, ?)', email, iso(clock()));
    return email;
  }

  // Nothing is purged: a row is what stops a second email to the same address from the same
  // person, and its token is what an old email's link to stop them finds (at most perDay a day).
  return { enabled, limits: max, check, record, unsubscribeUrl, suppress, emailOf };
}

/**
 * GET /api/mail/unsubscribe?t=… asks (a link scanner opening it changes nothing), and a POST to the
 * same address does it: the page's button, or a mail client's one click (List-Unsubscribe-Post),
 * which comes without a session and needs none. Both answer a page in the product's clothes, in
 * the language of whoever opens it; a token nobody has says the link isn't whole.
 */
export function registerUnsubscribeApi(router, { strangers, texts, brand }) {
  const page = (ctx, status, parts) => {
    const { html } = renderMail({ brand, footer: null, ...parts });
    ctx.res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
    });
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : html);
  };
  const answer = (ctx, done) => {
    const { lang, t } = texts(ctx.req, null);
    const token = ctx.query?.get('t') || '';
    const vars = { app: brand.name };
    const email = done ? strangers.suppress(token) : strangers.emailOf(token);
    if (!email) {
      return page(ctx, 404, { lang, heading: t('mail.unsubscribe.goneHeading', vars), lead: t('mail.unsubscribe.goneLead', vars) });
    }
    if (done) {
      return page(ctx, 200, { lang, heading: t('mail.unsubscribe.doneHeading', vars), lead: t('mail.unsubscribe.doneLead', { ...vars, email }) });
    }
    return page(ctx, 200, {
      lang,
      heading: t('mail.unsubscribe.heading', vars),
      lead: t('mail.unsubscribe.lead', { ...vars, email }),
      button: { label: t('mail.unsubscribe.button', vars), href: strangers.unsubscribeUrl(token), post: true },
    });
  };
  router.get('/api/mail/unsubscribe', (ctx) => answer(ctx, false));
  router.post('/api/mail/unsubscribe', (ctx) => answer(ctx, true));
}
