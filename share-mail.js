/**
 * The email that tells someone a thing was offered to them (a list, a
 * notebook, a group of notebooks, a note, a place in a project, a Next project
 * to follow): one message
 * for every module, in the product's clothes (mail-layout.js), in the language
 * of whoever receives it, with the button that takes them to answer it.
 *
 * The module decides when it goes (sharing.js `notify.email`, or its own
 * offers): only to someone with an account, and only when no device of theirs
 * takes a push. What it says of the thing is its name, and who offered it.
 *
 *   await suite.shareMail({ to: userRow, actor: 'Lucía García', kind: 'list', name: 'Launch', icon: '🚀', permission: 'edit' });
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
 * @returns {Function} send({ to, actor, kind, name, icon?, permission?, role?, url? }) → Promise<boolean>
 */
export function createShareMail({ mailer, texts, brand, module = null, baseUrl, log = console.log }) {
  const home = `${String(baseUrl || '').replace(/\/+$/, '')}/`;
  const part = module || { name: brand.name, color: brand.color, icon: brand.icon };

  /** The parts of the message for one person: what the tests and send() use. */
  function compose({ to, actor, kind, name, icon = null, permission = 'edit', role = null, url = null }) {
    if (!SHARE_KINDS.includes(kind)) throw new TypeError(`shareMail: no kind "${kind}"`);
    const { lang, t } = texts(null, to);
    const thing = String(name ?? '').trim() || t('mail.share.untitled');
    const vars = { name: actor, thing, module: part.name, app: brand.name, role: role ?? '' };
    // A place in a project is given with a role (the module's word for it); the rest, to read or to edit.
    const access = kind === 'project' ? role : t(permission === 'view' ? 'mail.share.access.view' : 'mail.share.access.edit');
    const about = brand.about ? brand.about[lang] || brand.about.en || null : null;
    const parts = {
      lang,
      brand,
      eyebrow: { text: t('mail.share.eyebrow', vars), color: part.color },
      heading: t(`mail.share.${kind}.heading`, vars),
      lead: t(`mail.share.${kind}.${kind === 'project' ? 'lead' : permission === 'view' ? 'leadView' : 'leadEdit'}`, vars),
      card: {
        icon: part.icon,
        title: icon ? `${icon} ${thing}` : thing,
        meta: [t(`mail.share.${kind}.label`, vars), access].filter(Boolean).join(' · '),
      },
      button: { label: t('mail.share.button', vars), href: url || home },
      note: t('mail.share.note', vars),
      about: about ? { title: t('mail.share.about', vars), text: about } : null,
      footer: t('mail.share.footer', vars),
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

  send.compose = compose;
  return send;
}
