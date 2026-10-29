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
 * Where the identity provider's users are shared with other apps (`shared`,
 * config.accounts.sharedIdentity), the login goes too unless the person uses
 * another of them: the request says so (`identity`: `all`, the person chose to;
 * `none`, they chose not to; `auto`, they weren't asked, as no other app was
 * theirs), and with `auto` it is asked again when the account goes. Whatever
 * stays there no longer names this app (`idp.unmark`).
 *
 * An account the admin deletes in /admin goes at once, as before.
 *
 * Who else hears it: `whenRequested(hook)` and `whenCancelled(hook)`, after the
 * account is disabled or enabled again (`hook(user)`, awaited in turn; one that
 * fails is logged and never undoes the request). createSuite hooks the groups
 * that would go with the account there (billing.stopOnOrganizationDeleted), and
 * an app its own (createSuite's `onDeletionRequested`, `onDeletionCancelled`).
 */
import { badRequest, HttpError } from './http.js';
import { safeEqual } from './crypto.js';
import { accountMail } from './mail-layout.js';

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
 * @param {boolean} [options.endSubscriptions]  whether their subscriptions end, without going at the
 *   identity provider (config.accounts.endSubscriptions); left out, as atProviders
 * @param {boolean} [options.shared]   whether the login there is shared with other apps and goes
 *   only as the person decides (config.accounts.sharedIdentity); atProviders still always takes it
 * @param {object} [options.idp]        the identity provider: deleteIdentity(userId), when it can,
 *   and with `shared` otherApps(userId) and unmark(userId)
 * @param {object} [options.billing]    from createBilling(): stopRenewals, keepRenewals, endSubscriptions
 * @param {object} [options.mailer], options.texts, options.appName, options.baseUrl   the message
 * @param {object} [options.brand]   from mailBrand(): with it, the message also goes as HTML
 * @param {object} [options.audit]
 */
export function createAccountDeletion({
  accounts, sign, days = 30, atProviders = false, endSubscriptions = atProviders, shared = false, idp = null, billing = null, audit = null,
  mailer = null, texts = null, appName = '', baseUrl = '', brand = null, clock = () => Date.now(), log = console.log,
}) {
  const subscriptions = endSubscriptions && billing?.enabled ? billing : null;
  const requestedHooks = [];
  const cancelledHooks = [];

  /** The hooks of a request or of its taking back, in turn: one that fails is said, never the request's failure. */
  async function tellHooks(hooks, user, what) {
    for (const hook of hooks) {
      try {
        await hook(user);
      } catch (err) {
        log(`[accounts] a hook of account #${user.id}'s deletion ${what} failed: ${err?.message || err}`);
      }
    }
  }

  /** The message that says until when, in the person's language: never a reason to fail. */
  async function tell(user, req) {
    if (!user.email || !mailer || mailer.provider === 'log' || !texts) return;
    const { lang, t } = texts(req, user);
    const vars = {
      app: appName, name: user.display_name, link: String(baseUrl).replace(/\/+$/, '') || appName,
      date: new Intl.DateTimeFormat(lang, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(user.delete_after)),
    };
    try {
      const subject = t('mail.deletion.subject', vars);
      const text = t('mail.deletion.body', vars);
      const html = brand
        ? accountMail({ lang, brand, subject, body: text, link: vars.link, button: t('mail.deletion.button', vars) }) : null;
      await mailer.send({ to: user.email, subject, text, html });
    } catch (err) {
      log(`[mail] to ${user.email}: not sent (deletion): ${err.message}`);
    }
  }

  // Only where the login is shared and the provider can say who else uses it.
  const choosing = Boolean(shared && !atProviders && idp?.otherApps && idp?.deleteIdentity);
  const IDENTITY = ['all', 'none', 'auto'];

  /**
   * The owner asks: disabled now, gone in `days`. `identity` (all, none or auto) is whether their
   * shared login goes too; left out, `auto`. → the account, with `delete_after`.
   */
  async function request(user, { req = null, identity = 'auto' } = {}) {
    if (choosing && !IDENTITY.includes(identity)) throw badRequest('identity_invalid');
    const waiting = accounts.requestDeletion(user.id, { days, identity: choosing ? identity : null });
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
    await tellHooks(requestedHooks, waiting, 'request');
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
    await tellHooks(cancelledHooks, user, 'taken back');
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
        else if (choosing) await identityGoes(user);
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

  /**
   * The shared login of an account going for good: deleted if the person chose so, or wasn't asked
   * and still uses no other app; otherwise only this app is taken off it. The provider not
   * answering whether another app is theirs throws: the account waits for the next sweep.
   */
  async function identityGoes(user) {
    const choice = user.delete_identity || 'auto';
    const goes = choice === 'all' || (choice === 'auto' && (await idp.otherApps(user.id)).length === 0);
    if (goes) await idp.deleteIdentity(user.id);
    else await idp.unmark(user.id);
  }

  return {
    days, request, restore, sweep, choosing,
    ticketFor: (userId) => deletionTicket(sign, userId, clock),
    whenRequested: (hook) => { requestedHooks.push(hook); },
    whenCancelled: (hook) => { cancelledHooks.push(hook); },
  };
}
