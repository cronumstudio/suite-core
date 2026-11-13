/**
 * An invitation waiting for an answer, the same in every module (audit of 6/11, ux-compartir-5,
 * Martin's choice of 14/11): a card at the very top of the sidebar, before the views, with who
 * offers what and the two answers. Until it is accepted nothing of the thing shows nor reaches
 * the person, so all it says is its name and mark, whose it is and what accepting it gives.
 * On a phone the sidebar is a drawer: the shell marks its ☰ while any wait (`shell.setMark`).
 *
 *   import { invitationCard, invitationCards } from '../suite/invitation.js';
 *   nav.prepend(invitationCards(state.invitations.map((inv) => ({
 *     from: inv.owner,                      // { name, avatar_color? } or null
 *     name: inv.name, icon: inv.icon,       // an emoji, or a colour swatch (`color`)
 *     what: kindLabel,                      // what kind of thing, when the module has several (optional)
 *     permission: inv.permission,           // 'view' | 'edit' → the kit's words; or `detail`, the app's own line
 *     onAccept: (ev) => accept(inv), onDecline: () => decline(inv),
 *   }))));
 *
 * Each answer turns both buttons off while it is on its way, and back on if it fails (the
 * module's function throws: the kit says why).
 */
import { el } from './dom.js';
import { t } from './i18n.js';
import { errorMessage } from './api.js';
import { avatar, toast } from './ui.js';

/**
 * @param {object} options
 * @param {object|string} [options.from]  who offers it: a person ({ name, avatar_color }) or a name.
 * @param {string} options.name           what is offered, as its owner called it.
 * @param {string} [options.icon]         its emoji; without one, `color` as a swatch.
 * @param {string} [options.color]        its colour (a CSS colour), the card's edge too.
 * @param {string} [options.what]         what kind of thing it is (Notes: a group, a note).
 * @param {'view'|'edit'} [options.permission]  what accepting it gives, in the kit's words.
 * @param {string} [options.detail]       the app's own line for that instead (Projects' roles).
 * @param {Function} options.onAccept     (event) → Promise: the event, to anchor a menu (Tasks' group).
 * @param {Function} options.onDecline    () → Promise.
 * @returns {HTMLElement}
 */
export function invitationCard({
  from = null, name, icon = null, color = null, what = null, permission = null, detail = null, onAccept, onDecline,
}) {
  const who = typeof from === 'string' ? from : from?.name || from?.display_name || '';
  const decline = el('button', { type: 'button', class: 'kit-btn kit-btn--small', text: t('kit.invite.decline') });
  const accept = el('button', { type: 'button', class: 'kit-btn kit-btn--small kit-btn--primary', text: t('kit.invite.accept') });
  const answer = (work) => async (ev) => {
    ev?.stopPropagation?.();
    decline.disabled = true;
    accept.disabled = true;
    try {
      await work(ev);
    } catch (err) {
      toast(errorMessage(err), { error: true });
    } finally {
      // Answered, the module draws the sidebar without it; still there, it can be answered again.
      decline.disabled = false;
      accept.disabled = false;
    }
  };
  decline.addEventListener('click', answer(() => onDecline?.()));
  accept.addEventListener('click', answer((ev) => onAccept?.(ev)));
  const gives = detail || (permission === 'view' ? t('kit.invite.readOnly') : permission === 'edit' ? t('kit.invite.canEdit') : null);
  const mark = icon
    ? el('span', { class: 'kit-invite__icon', 'aria-hidden': 'true', text: icon })
    : el('span', { class: 'kit-invite__swatch', 'aria-hidden': 'true', style: color ? { background: color } : null });
  return el('article', {
    class: 'kit-invite', style: color ? `--invite-color: ${color}` : null,
    'aria-label': t('kit.invite.label', { name }),
  },
  el('div', { class: 'kit-invite__from' },
    avatar(from && typeof from === 'object' ? from : who, { size: 'tiny' }),
    el('span', { text: who ? t('kit.invite.from', { name: who }) : t('kit.invite.fromSomeone') })),
  el('strong', { class: 'kit-invite__name' }, mark, el('span', { text: name })),
  what || gives ? el('small', { class: 'kit-invite__about', text: [what, gives].filter(Boolean).join(' · ') }) : null,
  el('div', { class: 'kit-invite__actions' }, decline, accept));
}

/** Several of them, in their place at the top of the sidebar; null with none, to append nothing. */
export function invitationCards(invitations = []) {
  if (!invitations.length) return null;
  return el('section', { class: 'kit-invites', 'aria-label': t('kit.invite.title') }, invitations.map(invitationCard));
}
