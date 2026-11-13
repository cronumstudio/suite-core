/**
 * Settings › Sharing, the same in every app: everything the person shares and
 * everything shared with them, in one place, to see it at a glance and change
 * it there. The app says what it shares (Tasks its lists; Notes its groups,
 * notebooks and notes) and how each change is made; the kit draws it.
 *
 *   import { sharedSection } from '../suite/shared.js';
 *   openSettings({ …, sections: [sharedSection({
 *     load: async () => ({ mine, withMe }),
 *     kinds: { list: { label: t('…'), iconName: 'list' } },
 *     setPermission: async (item, person, permission) => {},
 *     remove: async (item, person) => {},        // take it back from one person
 *     leave: async (item) => {},                 // decline it, or leave it, when it is shared with me
 *     accept: async (item) => {},                // take up an invitation (optional)
 *     open: (item, { close }) => {},             // go to it (optional; `close` closes Settings)
 *     permissions: [{ value, label, offered }],  // the app's own roles (optional), as the share dialog's
 *   })] });
 *
 * An item: { kind, id, name, color, icon, path }. What the person shares
 * (`mine`) carries `people: [{ user: { id, name, email }, permission, accepted }]`;
 * what is shared with them (`withMe`), `owner: { name }`, `permission` and
 * `accepted`. A permission is 'view' or 'edit', unless the app has roles of its
 * own for the people of what it shares: `permissions`, broadest first, the same
 * list the share dialog takes (Projects: manages, can edit, read only), or a
 * function of the item when they differ from one to another (naming a manager
 * is a project's owner's alone). What is shared with the person still says
 * 'view' or 'edit'. After every change the section asks `load()` again, so what
 * it shows is always the server's.
 */
import { el, clear } from './dom.js';
import { t } from './i18n.js';
import { errorMessage } from './api.js';
import { icon } from './icons.js';
import { toast, segmented, confirmDialog, avatar, blank } from './ui.js';

const showError = (err) => toast(errorMessage(err), { error: true });
const button = (text, onClick, kind = '') => el('button', {
  type: 'button', class: `kit-btn kit-btn--small${kind ? ` kit-btn--${kind}` : ''}`, text, onClick,
});

/** The Settings section (openSettings' `sections`). */
export function sharedSection(options) {
  return {
    id: 'shared',
    iconName: 'users',
    label: t('kit.shared.title'),
    hint: () => t('kit.shared.hint'),
    render: ({ close } = {}) => sharedPage({ ...options, close }),
  };
}

/** The page itself, for an app that shows it somewhere else too. */
export function sharedPage({
  load, kinds = {}, setPermission, remove, leave, accept = null, open = null, close = () => {}, permissions = null,
}) {
  const page = el('div', { class: 'kit-shared', 'aria-busy': 'true' });
  const kindOf = (item) => kinds[item.kind] || { label: '', iconName: 'folder' };

  async function refresh() {
    page.setAttribute('aria-busy', 'true');
    try {
      const { mine = [], withMe = [] } = await load();
      paint(mine, withMe);
    } catch (err) {
      clear(page).append(el('p', { class: 'kit-hint', text: errorMessage(err) }), button(t('kit.shared.retry'), refresh));
    } finally {
      page.removeAttribute('aria-busy');
    }
  }

  /** Each change, then what the server says now; a refusal is said and the page shows it as it was. */
  const change = (work) => async () => {
    try { await work(); } catch (err) { showError(err); }
    await refresh();
  };

  const head = (item, ...after) => {
    const kind = kindOf(item);
    const mark = item.icon
      ? el('span', { class: 'kit-shared__emoji', text: item.icon })
      : el('span', { class: 'kit-shared__icon', style: item.color ? `color: ${item.color}` : null }, icon(kind.iconName || 'folder'));
    const where = [kind.label, item.path].filter(Boolean).join(' · ');
    const name = open
      ? el('button', { type: 'button', class: 'kit-shared__name kit-shared__name--link', text: item.name, onClick: () => open(item, { close }) })
      : el('strong', { class: 'kit-shared__name', text: item.name });
    return el('div', { class: 'kit-shared__head' }, mark,
      el('span', { class: 'kit-shared__title' }, name, where ? el('small', { text: where }) : null), ...after);
  };

  /** The roles of the app for this item's people (`permissions`), or null for the kit's two. */
  const rolesOf = (item) => {
    const roles = typeof permissions === 'function' ? permissions(item) : permissions;
    return Array.isArray(roles) && roles.length ? roles : null;
  };

  /**
   * What a person may do, changed there: the kit's two (can view, can edit) as buttons, or the
   * app's roles, as buttons when they are two and as a list when they are more, as the share
   * dialog has them. A role with `offered: false` is never one of the choices.
   */
  const permissionChoice = (roles, value, onChange) => {
    if (!roles) {
      // The share dialog's words and order: can edit first, then read only.
      return segmented([{ value: 'edit', label: t('kit.share.edit') }, { value: 'view', label: t('kit.share.view') }], value, onChange);
    }
    const offered = roles.filter((role) => role.offered !== false);
    if (roles.length <= 2) return segmented(offered, value, onChange);
    const list = el('select', { class: 'kit-input kit-share__permission', 'aria-label': t('kit.share.permission') },
      ...offered.map((role) => el('option', { value: role.value, text: role.label, selected: role.value === value })));
    list.addEventListener('change', () => onChange(list.value));
    return list;
  };

  function mineItem(item) {
    const roles = rolesOf(item);
    const people = (item.people || []).map((person) => {
      const who = person.user?.name || person.user?.email || '—';
      const email = person.user?.email && person.user.email !== who ? person.user.email : null;
      // Someone with a role not offered here (a manager, to whoever isn't the owner) keeps it as it
      // is, said in words: whoever may not give it may not change it nor take it back either.
      const role = roles?.find((r) => r.value === person.permission);
      const kept = role?.offered === false;
      return el('div', { class: 'kit-shared__person' },
        avatar(person.user || who),
        el('span', { class: 'kit-shared__who' }, el('span', { text: who }), email ? el('small', { text: email }) : null),
        person.accepted ? null : el('span', { class: 'kit-badge kit-badge--warn', text: t('kit.share.pending') }),
        kept ? el('span', { class: 'kit-share__role', text: role.label })
          : permissionChoice(roles, person.permission, (permission) => change(() => setPermission(item, person, permission))()),
        kept ? null : el('button', {
          type: 'button', class: 'kit-icon-btn', 'aria-label': t('kit.share.remove', { name: who }), title: t('kit.share.remove', { name: who }),
          onClick: async () => {
            // As the share dialog (rule 7 of docs/web-kit.md): someone who accepted is asked about,
            // an invitation nobody answered goes at once.
            if (person.accepted && !await confirmDialog(t('kit.share.removeAsk', { name: who }), { confirm: t('kit.share.takeBack') })) return;
            await change(() => remove(item, person))();
          },
        }, icon('x')));
    });
    return el('article', { class: 'kit-shared__item' }, head(item), el('div', { class: 'kit-shared__people' }, people));
  }

  function withMeItem(item) {
    const from = item.owner?.name ? t('kit.shared.from', { name: item.owner.name }) : null;
    const actions = !item.accepted
      ? [accept ? button(t('kit.shared.accept'), change(() => accept(item)), 'primary') : null,
        button(t('kit.shared.decline'), change(() => leave(item)), 'quiet')]
      : [button(t('kit.share.leave'), async () => {
        const sure = await confirmDialog(t('kit.share.leaveConfirm', { name: item.name }), { title: t('kit.share.leaveAsk', { name: item.name }), confirm: t('kit.share.leave') });
        if (sure) await change(() => leave(item))();
      }, 'danger-quiet')];
    return el('article', { class: 'kit-shared__item' },
      head(item),
      el('div', { class: 'kit-shared__about' },
        from ? el('span', { class: 'kit-hint', text: from }) : null,
        el('span', { class: 'kit-badge', text: t(item.permission === 'edit' ? 'kit.shared.canEdit' : 'kit.shared.canView') }),
        item.accepted ? null : el('span', { class: 'kit-badge kit-badge--warn', text: t('kit.shared.invited') }),
        el('span', { class: 'kit-shared__actions' }, ...actions)));
  }

  function paint(mine, withMe) {
    clear(page);
    if (!mine.length && !withMe.length) {
      page.append(blank({ iconName: 'users', title: t('kit.shared.none'), text: t('kit.shared.noneHint') }));
      return;
    }
    const section = (title, text, items, draw, empty) => el('section', { class: 'kit-settings__block' },
      el('h3', { text: title }), el('p', { class: 'kit-hint', text }),
      items.length ? el('div', { class: 'kit-shared__list' }, items.map(draw)) : el('p', { class: 'kit-hint', text: empty }));
    // Invitations still to answer first: they are what asks for something.
    const waiting = [...withMe].sort((a, b) => Number(Boolean(a.accepted)) - Number(Boolean(b.accepted)));
    page.append(
      section(t('kit.shared.mine'), t('kit.shared.mineHint'), mine, mineItem, t('kit.shared.mineNone')),
      section(t('kit.shared.withMe'), t('kit.shared.withMeHint'), waiting, withMeItem, t('kit.shared.withMeNone')));
  }

  refresh();
  return page;
}
