/**
 * The share dialog, the same in every app (audit 2026-10-23, A6): who has
 * something, and, for its owner, inviting by email or picking the people one
 * already shares with (people.js), changing what each may do and taking it
 * back; anyone else sees who has it and may leave it. It is Notes' dialog
 * (0.28–0.62), which already spoke to the server's sharing.js routes.
 *
 *   import { shareDialog } from '../suite/share.js';
 *   const outcome = await shareDialog({ base: `api/notebooks/${id}`, name: 'Work', me: state.user.id });
 *   if (outcome === 'left') …
 *
 * With `base` it talks to the routes as sharing.js makes them:
 *   GET <base>/shares → { role, owner, shares }, POST <base>/shares, PATCH and
 *   DELETE <base>/shares/:userId. An app whose routes differ passes its own
 *   `load`, `offer`, `setPermission`, `remove` and `leave` (Tasks, whose lists
 *   carry their shares).
 *
 * Its words are the kit's (`kit.share.*`); an app that has its own passes
 * `words(key) → catalog key` and keeps them. A share is
 * `{ user: { id, name, email? }, permission, accepted }`, as sharing.js answers.
 */
import { el, clear } from './dom.js';
import { t } from './i18n.js';
import { api, errorMessage } from './api.js';
import { icon } from './icons.js';
import { openDialog, field, toast, segmented, avatar as kitAvatar, confirmDialog } from './ui.js';
import { peopleChips, shareWithEach } from './people.js';

const fail = (err) => {
  toast(errorMessage(err), { error: true });
  return false;
};

/**
 * @param {object} options
 * @param {string} options.name   what is shared, as the title says it.
 * @param {string} [options.base]  where its shares answer (relative, no leading slash, or absolute).
 * @param {number} [options.me]   the signed-in person's id.
 * @param {Function} [options.words]  key → catalog key (default `kit.share.<key>`).
 * @param {string|Function|Array} [options.people]  one's people for the chips: a route
 *   answering { people }, a function → Promise<[{ id, name }]>, or the list itself.
 * @param {boolean} [options.email]  whether there is an email field (default true).
 * @param {string} [options.hint]  a sentence above the email: what accepting it brings.
 * @param {string} [options.empty]  said to an owner with nobody to add and no email field.
 * @param {Function} [options.avatar]  (person) → node; default the kit's initials.
 * @param {Function} [options.detail]  (share, owner) → the line under a name (default: the email
 *   the owner typed, else what they may do).
 * @param {Function} [options.load]  () → Promise<{ role, owner, shares }>.
 * @param {Function} [options.offer]  (target { id?, email?, name }, permission) → Promise<{ share?, invited }>;
 *   a share without an id (an offer by email) makes the dialog load who has it again.
 * @param {Function} [options.setPermission]  (share, permission) → Promise<share?>.
 * @param {Function} [options.remove]  (share) → Promise.
 * @param {Function} [options.leave]  () → Promise.
 * @returns {Promise<'left'|null>}
 */
export async function shareDialog({
  name, base = null, me = null, words = (key) => `kit.share.${key}`, people = null, email: byEmail = true,
  hint = null, empty = null, avatar = (person) => kitAvatar(person?.name), detail = null,
  load = null, offer: offerOne = null, setPermission = null, remove = null, leave = null,
} = {}) {
  const w = (key, vars) => t(words(key), vars);
  load ||= () => api.get(`${base}/shares`);
  offerOne ||= (target, permission) => api.post(`${base}/shares`, target.id != null ? { user_id: target.id, permission } : { email: target.email, permission });
  setPermission ||= (share, permission) => api.patch(`${base}/shares/${share.user.id}`, { permission });
  remove ||= (share) => api.delete(`${base}/shares/${share.user.id}`);
  leave ||= () => api.delete(`${base}/shares/${me}`);
  const peopleList = typeof people === 'function' ? people
    : Array.isArray(people) ? async () => people
      : people ? () => api.get(people).then((res) => res.people || []) : async () => [];
  // The people one already shares with, asked at the same time: chips under the email. Without them it still shares by email.
  const contactsAsked = Promise.resolve().then(peopleList).then((list) => list || [], () => []);
  let data;
  try {
    data = await load();
  } catch (err) {
    fail(err);
    return null;
  }
  const owner = data.role === 'owner';
  const contacts = owner ? await contactsAsked : [];
  return new Promise((resolve) => {
    let result = null;
    const list = el('div', { class: 'kit-list kit-share__people' });
    const can = (permission) => w(permission === 'view' ? 'view' : 'edit');
    // The owner's chips, drawn again with the list: whoever has it now leaves them.
    let paintChips = () => {};

    const lineUnder = (share) => {
      if (detail) return detail(share, owner);
      if (!owner) return can(share.permission);
      return share.user.email && share.user.email !== share.user.name ? share.user.email : null;
    };

    const paint = () => {
      clear(list);
      const mine = data.owner?.id === me;
      list.append(el('div', { class: 'kit-list__row' }, avatar(data.owner),
        el('span', { class: 'kit-list__text' },
          el('span', { text: mine ? w('you', { name: data.owner.name }) : data.owner?.name }),
          el('small', { text: w(mine ? 'ownerYou' : 'owner') }))));
      for (const share of data.shares) {
        const permission = el('select', { class: 'kit-input kit-share__permission', 'aria-label': w('permission') },
          ...['edit', 'view'].map((p) => el('option', { value: p, text: can(p), selected: share.permission === p })));
        permission.addEventListener('change', async () => {
          try {
            const changed = await setPermission(share, permission.value);
            Object.assign(share, changed && typeof changed === 'object' ? changed : { permission: permission.value });
          } catch (err) {
            permission.value = share.permission;
            fail(err);
          }
        });
        const takeBack = el('button', {
          type: 'button', class: 'kit-icon-btn', 'aria-label': w('remove', { name: share.user.name }), title: w('remove', { name: share.user.name }),
          onClick: async () => {
            try {
              await remove(share);
              data.shares = data.shares.filter((s) => s !== share);
              paint();
            } catch (err) {
              fail(err);
            }
          },
        }, icon('x'));
        const under = lineUnder(share);
        list.append(el('div', { class: 'kit-list__row' }, avatar(share.user),
          el('span', { class: 'kit-list__text' },
            // The whole name in its title: on a phone it keeps one line, cut with "…" (kit.css).
            el('span', { class: 'kit-share__name', title: share.user.name, text: share.user.id != null && share.user.id === me ? w('you', { name: share.user.name }) : share.user.name }),
            under ? el('small', { text: under }) : null,
            owner && !share.accepted ? el('small', { class: 'kit-share__pending', text: w('pending') }) : null),
          owner ? permission : null,
          owner ? takeBack : null));
      }
      paintChips();
    };
    paint();

    let form = null;
    if (owner) {
      const email = byEmail ? el('input', {
        type: 'email', class: 'kit-input', placeholder: w('emailPlaceholder'), autocomplete: 'off',
        autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'send', 'aria-label': w('email'),
      }) : null;
      let permission = 'edit';
      const choice = segmented([{ value: 'edit', label: w('edit') }, { value: 'view', label: w('view') }], permission, (value) => { permission = value; });
      const invite = el('button', { type: 'submit', class: 'kit-btn kit-btn--primary', text: w('invite') });
      const typed = () => (email ? email.value.trim() : '');
      // Nothing to share until there is an email or a chip chosen.
      const ready = () => { invite.disabled = !typed() && !chips.selected().length; };
      // One's people, the kit's chips under the email: one or several at once.
      const chips = peopleChips([], { onChange: ready, ...(byEmail ? {} : { label: '' }) });
      email?.addEventListener('input', ready);
      const nobody = empty ? el('p', { class: 'kit-hint', text: empty }) : null;
      // Those who don't have it yet (the owner aside); whoever was picked and still lacks it stays picked.
      paintChips = () => {
        const has = new Set([data.owner?.id, ...data.shares.map((s) => s.user.id)]);
        const left = contacts.filter((p) => !has.has(p.id)).map(({ id, name: who }) => ({ id, name: who }));
        chips.set(left);
        // Nobody to add and no email to type: the form has nothing to offer.
        if (!byEmail) {
          invitation.hidden = !left.length;
          if (nobody) nobody.hidden = Boolean(left.length);
        }
        ready();
      };
      const invitation = el('form', { class: 'kit-share__invite' },
        hint ? el('p', { class: 'kit-hint', text: hint }) : null,
        email ? field(w('email'), email, w('emailHint')) : null,
        chips.node,
        el('div', { class: 'kit-row kit-share__row' }, choice, invite));
      const offer = async (target) => {
        const { share, invited } = await offerOne(target, permission);
        if (share?.user?.id == null) {
          // An offer by email answers the same whoever the address belongs to, without an id: who has it is read again.
          try { data.shares = (await load()).shares; } catch { /* the list stays as it was */ }
        } else {
          data.shares = [...data.shares.filter((s) => s.user.id !== share.user.id), share];
        }
        if (target.id == null && email) email.value = '';
        return { share, invited };
      };
      invitation.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const address = typed();
        const chosen = new Set(chips.selected());
        const targets = [
          ...contacts.filter((p) => chosen.has(p.id)).map(({ id, name: who }) => ({ id, name: who })),
          ...(address ? [{ name: address, email: address }] : []),
        ];
        if (!targets.length) {
          email?.focus();
          return;
        }
        invite.disabled = true;
        if (targets.length === 1) {
          // One person: said by name, as it always was.
          try {
            const { share, invited } = await offer(targets[0]);
            toast(w(invited ? 'invited' : 'changed', { name: share?.user?.name || targets[0].name }));
          } catch (err) {
            fail(err);
          }
        } else {
          // Several: one request each, in order; the kit says how many went and each refusal by name.
          await shareWithEach(targets, offer);
        }
        paint();
      });
      paintChips();
      if (email) setTimeout(() => email.focus(), 50);
      form = nobody ? el('div', { class: 'kit-stack' }, invitation, nobody) : invitation;
    }

    openDialog({
      title: owner ? w('title', { name }) : w('people'),
      content: el('div', { class: 'kit-stack' }, form,
        owner ? el('h3', { class: 'kit-share__heading', text: w('withAccess') }) : null, list),
      // Someone who reaches it some other way (a notebook through its group) has nothing here to leave.
      actions: owner || !data.shares.some((s) => s.user.id === me) ? [{ label: t('kit.close') }] : [{
        label: w('leave'), danger: true,
        onClick: async () => {
          if (!await confirmDialog(w('leaveConfirm', { name }), { confirm: w('leave') })) return false;
          try {
            await leave();
            result = 'left';
            return true;
          } catch (err) {
            return fail(err);
          }
        },
      }, { label: t('kit.close'), primary: true }],
      onClose: () => resolve(result),
    });
  });
}
