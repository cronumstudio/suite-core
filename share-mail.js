/**
 * The email that tells someone a thing was offered to them (a list, a
 * notebook, a group of notebooks, a note, a place in a project, a Next project
 * to follow): one message
 * for every module, in the product's clothes (mail-layout.js), in the language
 * of whoever receives it, with the button that takes them to answer it.
 *
 * The module decides when it goes (sharing.js `notify.email`, or its own
 * offers): to someone with an account, besides the push where a device of
 * theirs takes one. What it says of the thing is its name, and who offered it.
 *
 *   await suite.shareMail({ to: userRow, actor: 'Lucía García', kind: 'list', name: 'Launch', icon: '🚀', permission: 'edit' });
 *
 * To an address nobody has an account with, `shareMail.stranger({ email, inviter, … })`: the
 * same message, in the inviter's language, saying to make an account with that address, with a
 * button to sign up and a link to get no more. Whether it goes is stranger-invites.js': once per
 * address and person, within the day's limits, never to an address that asked for no more.
 *
 * In a host (host.js) the product is the host's —Cronum Work— and the module
 * —Tasks— shows in the line over the heading, in its colour, and in the card,
 * with its icon; on its own the product and the module are the same app.
 */
import { renderMail } from './mail-layout.js';

export const SHARE_KINDS = ['list', 'notebook', 'group', 'note', 'project', 'plan'];

/**
 * @param {object} options
 * @param {object} options.mailer      from createMailer()
 * @param {Function} options.texts     (req, user) → { lang, t }: the module's (its words over the suite's)
 * @param {object} options.brand       from mailBrand(): the product that signs it
 * @param {object} [options.module]    { name, color, icon }: the module, when it isn't the product
 * @param {string} options.baseUrl     the module's address: where the button goes
 * @param {object} [options.strangers] from createStrangerInvites(): without it, no email to an address without an account
 * @param {string} [options.signupUrl] where a new account is made, then back to the module
 * @returns {Function} send({ to, actor, kind, name, icon?, permission?, role?, url? }) → Promise<boolean>,
 *   with send.stranger({ email, inviter, kind, name, icon?, permission?, role? }) → Promise<boolean>
 */
export function createShareMail({ mailer, texts, brand, module = null, baseUrl, strangers = null, signupUrl = null, log = console.log }) {
  const home = `${String(baseUrl || '').replace(/\/+$/, '')}/`;
  const part = module || { name: brand.name, color: brand.color, icon: brand.icon };

  /**
   * The parts of the message for one person: what the tests and send() use. `stranger`
   * ({ email, signup, unsubscribe }): to an address without an account, in the language of `to`,
   * who invited them.
   */
  function compose({ to, actor, kind, name, icon = null, permission = 'edit', role = null, url = null, stranger = null }) {
    if (!SHARE_KINDS.includes(kind)) throw new TypeError(`shareMail: no kind "${kind}"`);
    const { lang, t } = texts(null, to);
    const thing = String(name ?? '').trim() || t('mail.share.untitled');
    const vars = { name: actor, thing, module: part.name, app: brand.name, role: role ?? '', email: stranger?.email ?? '' };
    // A place in a project is given with a role (the module's word for it); the rest, to read or to edit.
    const access = kind === 'project' ? role : t(permission === 'view' ? 'mail.share.access.view' : 'mail.share.access.edit');
    const about = brand.about ? brand.about[lang] || brand.about.en || null : null;
    const parts = {
      lang,
      brand,
      eyebrow: { text: t('mail.share.eyebrow', vars), color: part.color },
      heading: t(`mail.share.${kind}.heading`, vars),
      lead: [
        t(`mail.share.${kind}.${kind === 'project' ? 'lead' : permission === 'view' ? 'leadView' : 'leadEdit'}`, vars),
        stranger ? t('mail.share.stranger.lead', vars) : null,
      ].filter(Boolean).join('\n\n'),
      card: {
        icon: part.icon,
        title: icon ? `${icon} ${thing}` : thing,
        meta: [t(`mail.share.${kind}.label`, vars), access].filter(Boolean).join(' · '),
      },
      button: stranger
        ? { label: t('mail.share.stranger.button', vars), href: stranger.signup }
        : { label: t('mail.share.button', vars), href: url || home },
      note: t(stranger ? 'mail.share.stranger.note' : 'mail.share.note', vars),
      about: about ? { title: t('mail.share.about', vars), text: about } : null,
      footer: t(stranger ? 'mail.share.stranger.footer' : 'mail.share.footer', vars),
      unsubscribe: stranger
        ? { text: t('mail.share.stranger.unsubscribe', vars), label: t('mail.share.stranger.unsubscribeLink', vars), href: stranger.unsubscribe }
        : null,
    };
    return { subject: t(`mail.share.${kind}.subject`, vars), ...renderMail(parts) };
  }

  /** Sends it; false when there was nobody to send it to. One that fails is said in the log. */
  async function send(notice) {
    if (!mailer || !notice?.to?.email) return false;
    const { subject, text, html } = compose(notice);
    try {
      await mailer.send({ to: notice.to.email, subject, text, html });
      return true;
    } catch (err) {
      log(`[mail] to ${notice.to.email}: not sent (a ${notice.kind} offered): ${err.message}`);
      return false;
    }
  }

  /**
   * To an address nobody has an account with (sharing.js `notify.stranger`, or a module's own
   * offers): only where an account can be made, and only as stranger-invites.js allows; noted
   * before it goes. `inviter` is the user row of whoever offered it. → whether it went.
   */
  async function stranger({ email, inviter, kind, name, icon = null, permission = 'edit', role = null }) {
    if (!mailer || !strangers || !signupUrl || !email || !inviter) return false;
    const why = strangers.check(email, inviter);
    if (why) {
      if (why !== 'already_sent' && why !== 'no_signup') log(`[mail] an invitation to an address without an account was not sent: ${why}`);
      return false;
    }
    const { url: unsubscribe } = strangers.record(email, inviter.id, kind);
    const { subject, text, html } = compose({
      to: inviter, actor: inviter.display_name || inviter.username, kind, name, icon, permission, role,
      stranger: { email, signup: signupUrl, unsubscribe },
    });
    try {
      await mailer.send({ to: email, subject, text, html, unsubscribe });
      return true;
    } catch (err) {
      // Never the address in the log: it is someone's who has no account here.
      log(`[mail] an invitation to an address without an account (a ${kind}) was not sent: ${err.message}`);
      return false;
    }
  }

  send.compose = compose;
  send.stranger = stranger;
  return send;
}
