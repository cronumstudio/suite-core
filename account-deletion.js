/**
 * Someone deleting their own account (the GDPR's right to erasure), and what
 * goes with it:
 *
 * · Asking (`request`): the account is disabled at once —its sessions and
 *   devices end, and tokens and connected assistants stop working, since every
 *   way in refuses a disabled account— and kept `accounts.deletionDays` (30)
 *   before it goes. Where the install deletes at the providers, the
 *   subscriptions the person pays stop renewing. A message says until when, if
 *   mail leaves the server and the account has an email.
 * · Taking it back: signing in again within those days offers it, with a
 *   ticket the sign-in hands over (`ticketFor`, 15 minutes): the account is as
 *   it was, and its subscriptions renew again.
 * · Going for good (`sweep`, with the clean-ups): at the providers first, where
 *   the install says so (the WorkOS user, the subscriptions), then here:
 *   `accounts.remove()` runs every hook —each app hands over what others share
 *   with the person and deletes their files— and the audit keeps only that
 *   account #n went.
 *
 * An account the admin deletes in /admin goes at once, as before.
 */
import { badRequest, HttpError } from './http.js';
import { safeEqual } from './crypto.js';

const TICKET_MS = 15 * 60 * 1000;

/** Proof that whoever signs in is the owner of an account waiting to be deleted: 15 minutes. */
export function deletionTicket(sign, userId, clock = Date.now) {
  const body = `${userId}.${clock() + TICKET_MS}`;
  return `${body}.${sign(`account-deletion|${body}`)}`;
}

/** The user id of a ticket, or an error: `ticket_invalid` or `ticket_expired` (410). */
export function readDeletionTicket(sign, token, clock = Date.now) {
  const [userId, expires, signature] = String(token ?? '').split('.');
  const body = `${userId}.${expires}`;
  if (!/^\d+$/.test(userId || '') || !/^\d+$/.test(expires || '') || !signature
    || !safeEqual(signature, sign(`account-deletion|${body}`))) throw badRequest('ticket_invalid');
  if (Number(expires) < clock()) throw new HttpError(410, 'ticket_expired');
  return Number(userId);
}

/**
 * @param {object} options
 * @param {object} options.accounts     from createAccounts()
 * @param {Function} options.sign       the sessions' signature (sessions.sign), for the tickets
 * @param {number} [options.days]       how long an account waits, disabled, before it goes
 * @param {boolean} [options.atProviders]  whether the person also goes at the identity provider
 *   and their subscriptions end (config.accounts.deleteAtProviders)
 * @param {object} [options.idp]        the identity provider: deleteIdentity(userId), when it can
 * @param {object} [options.billing]    from createBilling(): stopRenewals, keepRenewals, endSubscriptions
 * @param {object} [options.mailer], options.texts, options.appName, options.baseUrl   the message
 * @param {object} [options.audit]
 */
export function createAccountDeletion({
  accounts, sign, days = 30, atProviders = false, idp = null, billing = null, audit = null,
  mailer = null, texts = null, appName = '', baseUrl = '', clock = () => Date.now(), log = console.log,
}) {
  const subscriptions = atProviders && billing?.enabled ? billing : null;

  /** The message that says until when, in the person's language: never a reason to fail. */
  async function tell(user, req) {
    if (!user.email || !mailer || mailer.provider === 'log' || !texts) return;
    const { lang, t } = texts(req, user);
    const vars = {
      app: appName, name: user.display_name, link: String(baseUrl).replace(/\/+$/, '') || appName,
      date: new Intl.DateTimeFormat(lang, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(user.delete_after)),
    };
    try {
      await mailer.send({ to: user.email, subject: t('mail.deletion.subject', vars), text: t('mail.deletion.body', vars) });
    } catch (err) {
      log(`[mail] to ${user.email}: not sent (deletion): ${err.message}`);
    }
  }

  /** The owner asks: disabled now, gone in `days`. → the account, with `delete_after`. */
  async function request(user, { req = null } = {}) {
    const waiting = accounts.requestDeletion(user.id, { days });
    audit?.record({
      action: 'account.deletion.request', actor: user, req, targetType: 'user', targetId: user.id,
      meta: { delete_after: waiting.delete_after },
    });
    if (subscriptions) {
      try {
        await subscriptions.stopRenewals(user.id);
      } catch (err) {
        // It is said and tried again when the account goes, where they end for good.
        log(`[accounts] the subscriptions of account #${user.id} could not be stopped: ${err.message}`);
      }
    }
    await tell(waiting, req);
    return waiting;
  }

  /** The owner takes it back with a ticket from signing in. → the account, enabled. */
  async function restore(ticket, { req = null } = {}) {
    const userId = readDeletionTicket(sign, ticket, clock);
    if (!accounts.cancelDeletion(userId)) throw badRequest('ticket_invalid');
    const user = accounts.byId(userId);
    audit?.record({ action: 'account.deletion.cancel', actor: user, req, targetType: 'user', targetId: userId });
    if (subscriptions) {
      try {
        await subscriptions.keepRenewals(userId);
      } catch (err) {
        log(`[accounts] the subscriptions of account #${userId} could not be renewed again: ${err.message}`);
      }
    }
    return user;
  }

  /**
   * The accounts whose days are over go for good. At the identity provider
   * first: if it can't be reached the account waits for the next sweep, since
   * once gone here nothing would say whom to delete there. A subscription that
   * can't be ended is logged and left to lapse: it stopped renewing when the
   * person asked. → how many went.
   */
  async function sweep() {
    let gone = 0;
    for (const user of accounts.dueForDeletion()) {
      try {
        if (subscriptions) {
          try {
            await subscriptions.endSubscriptions(user.id);
          } catch (err) {
            log(`[accounts] the subscriptions of account #${user.id} could not be ended: ${err.message}`);
          }
        }
        if (atProviders && idp?.deleteIdentity) await idp.deleteIdentity(user.id);
        accounts.remove(user.id);
        audit?.record({ action: 'account.delete', targetType: 'user', targetId: user.id, meta: { requested: true } });
        gone += 1;
      } catch (err) {
        log(`[accounts] account #${user.id} could not be deleted yet: ${err.message}`);
      }
    }
    if (gone) log(`[accounts] ${gone} account(s) deleted at their owners' request`);
    return gone;
  }

  return {
    days, request, restore, sweep,
    ticketFor: (userId) => deletionTicket(sign, userId, clock),
  };
}
