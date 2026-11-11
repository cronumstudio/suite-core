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
 *
 * What one may do with it is "can edit" or "read only", unless the app has roles
 * of its own (`permissions`, Projects: manages, can edit, read only). Its owner
 * manages who has it, and so does whoever `load` answers `manage: true` for
 * (Projects' managers): the same dialog, minus the rows `fixed` keeps as they are.
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
 * @param {Array} [options.permissions]  what one may be given, `[{ value, label, offered? }]`, broadest
 *   first (default: can edit, read only). With more than two, a list to choose from instead of buttons.
 *   `offered: false`: said on the rows that have it, never given here (a role only the owner gives).
 * @param {string} [options.invitePermission]  what an invitation gives unless changed (default the first).
 * @param {Function} [options.fixed]  (share) → true for a row whoever manages can't change or take
 *   back (a manager's, for another manager); one's own row always is.
 * @param {Function} [options.confirmRemove]  (share) → the question to ask before taking it back,
 *   or nothing to take it back at once. By default someone who accepted it is asked about
 *   («¿Quitárselo a X?»), and an invitation not answered yet goes at once (Martin, 10/11).
 * @param {Element} [options.parent]  where the dialog and its questions hang, as openDialog's (a
 *   module that keeps its dialogs in its own place, its window in Cronum Work).
 * @param {Function} [options.load]  () → Promise<{ role, owner, shares, manage? }>.
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
  permissions = null, invitePermission = null, fixed = null, confirmRemove = null, parent = null,
} = {}) {
  const w = (key, vars) => t(words(key), vars);
  confirmRemove ||= (share) => (share.accepted ? w('removeAsk', { name: share.user.name }) : null);
  const kinds = permissions?.length ? permissions : [{ value: 'edit', label: w('edit') }, { value: 'view', label: w('view') }];
  // What may be given here: a role with `offered: false` is said on the rows that have it, never chosen.
  const offered = kinds.filter((k) => k.offered !== false);
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
  const manages = owner || data.manage === true;
  const contacts = manages ? await contactsAsked : [];
  return new Promise((resolve) => {
    let result = null;
    const list = el('div', { class: 'kit-list kit-share__people' });
    const can = (permission) => kinds.find((k) => k.value === permission)?.label ?? w(permission === 'view' ? 'view' : 'edit');
    // The chips of whoever manages, drawn again with the list: whoever has it now leaves them.
    let paintChips = () => {};

    const lineUnder = (share) => {
      if (detail) return detail(share, manages);
      if (!manages) return can(share.permission);
      return share.user.email && share.user.email !== share.user.name ? share.user.email : null;
    };
    // A row whoever manages leaves as it is: their own, and those the app keeps (another manager's).
    const locked = (share) => !manages || (share.user.id != null && share.user.id === me) || Boolean(fixed?.(share));

    const paint = () => {
      clear(list);
      const mine = data.owner?.id === me;
      list.append(el('div', { class: 'kit-list__row' }, avatar(data.owner),
        el('span', { class: 'kit-list__text' },
          el('span', { text: mine ? w('you', { name: data.owner.name }) : data.owner?.name }),
          el('small', { text: w(mine ? 'ownerYou' : 'owner') }))));
      for (const share of data.shares) {
        const permission = el('select', { class: 'kit-input kit-share__permission', 'aria-label': w('permission') },
          ...offered.map((k) => el('option', { value: k.value, text: k.label, selected: share.permission === k.value })));
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
            const question = confirmRemove?.(share);
            if (question && !await confirmDialog(question, { confirm: w('takeBack'), parent })) return;
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
        const keep = locked(share);
        list.append(el('div', { class: 'kit-list__row' }, avatar(share.user),
          el('span', { class: 'kit-list__text' },
            // The whole name in its title: on a phone it keeps one line, cut with "…" (kit.css).
            el('span', { class: 'kit-share__name', title: share.user.name, text: share.user.id != null && share.user.id === me ? w('you', { name: share.user.name }) : share.user.name }),
            under ? el('small', { text: under }) : null,
            manages && !share.accepted ? el('small', { class: 'kit-share__pending', text: w('pending') }) : null),
          // A row kept as it is says what they may do where the others let it be changed.
          manages && keep ? el('span', { class: 'kit-share__role', text: can(share.permission) }) : null,
          manages && !keep ? permission : null,
          manages && !keep ? takeBack : null));
      }
      paintChips();
    };
    paint();

    let form = null;
    if (manages) {
      const email = byEmail ? el('input', {
        type: 'email', class: 'kit-input', placeholder: w('emailPlaceholder'), autocomplete: 'off',
        autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'send', 'aria-label': w('email'),
      }) : null;
      let permission = offered.some((k) => k.value === invitePermission) ? invitePermission : offered[0].value;
      // Two choices fit as buttons beside Invite; an app with more roles, on a phone, only as a list
      // (for whoever may give fewer of them too: the dialog looks the same for its owner and its managers).
      const asList = kinds.length > 2;
      const choice = asList
        ? el('select', { class: 'kit-input kit-share__permission kit-share__choice', 'aria-label': w('permission') },
          ...offered.map((k) => el('option', { value: k.value, text: k.label, selected: k.value === permission })))
        : segmented(offered, permission, (value) => { permission = value; });
      if (asList) choice.addEventListener('change', () => { permission = choice.value; });
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
          // One person: said by the name the dialog showed, the chip's or the address typed, never
          // another the answer brings (an app that answered a chip with the email told it).
          try {
            const { invited } = await offer(targets[0]);
            toast(w(invited ? 'invited' : 'changed', { name: targets[0].name }));
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
      title: manages ? w('title', { name }) : w('people'),
      content: el('div', { class: 'kit-stack' }, form,
        manages ? el('h3', { class: 'kit-share__heading', text: w('withAccess') }) : null, list),
      // Someone who reaches it some other way (a notebook through its group) has nothing here to leave.
      actions: owner || !data.shares.some((s) => s.user.id === me) ? [{ label: t('kit.close') }] : [{
        label: w('leave'), danger: true,
        onClick: async () => {
          if (!await confirmDialog(w('leaveConfirm', { name }), { title: w('leaveAsk', { name }), confirm: w('leave'), parent })) return false;
          try {
            await leave();
            result = 'left';
            return true;
          } catch (err) {
            return fail(err);
          }
        },
      }, { label: t('kit.close'), primary: true }],
      parent,
      onClose: () => resolve(result),
    });
  });
}
