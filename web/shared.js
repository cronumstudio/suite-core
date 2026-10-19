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
 *     open: (item) => {},                        // go to it (optional; the app closes Settings)
 *   })] });
 *
 * An item: { kind, id, name, color, icon, path }. What the person shares
 * (`mine`) carries `people: [{ user: { id, name, email }, permission, accepted }]`;
 * what is shared with them (`withMe`), `owner: { name }`, `permission` and
 * `accepted`. A permission is 'view' or 'edit'. After every change the section
 * asks `load()` again, so what it shows is always the server's.
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
    render: () => sharedPage(options),
  };
}

/** The page itself, for an app that shows it somewhere else too. */
export function sharedPage({ load, kinds = {}, setPermission, remove, leave, accept = null, open = null }) {
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
      ? el('button', { type: 'button', class: 'kit-shared__name kit-shared__name--link', text: item.name, onClick: () => open(item) })
      : el('strong', { class: 'kit-shared__name', text: item.name });
    return el('div', { class: 'kit-shared__head' }, mark,
      el('span', { class: 'kit-shared__title' }, name, where ? el('small', { text: where }) : null), ...after);
  };

  const permissionChoice = (value, onChange) => segmented(
    [{ value: 'view', label: t('kit.shared.view') }, { value: 'edit', label: t('kit.shared.edit') }], value, onChange);

  function mineItem(item) {
    const people = (item.people || []).map((person) => {
      const who = person.user?.name || person.user?.email || '—';
      const email = person.user?.email && person.user.email !== who ? person.user.email : null;
      return el('div', { class: 'kit-shared__person' },
        avatar(who),
        el('span', { class: 'kit-shared__who' }, el('span', { text: who }), email ? el('small', { text: email }) : null),
        person.accepted ? null : el('span', { class: 'kit-badge kit-badge--warn', text: t('kit.shared.pending') }),
        permissionChoice(person.permission, (permission) => change(() => setPermission(item, person, permission))()),
        el('button', {
          type: 'button', class: 'kit-icon-btn', 'aria-label': t('kit.shared.remove', { name: who }), title: t('kit.shared.remove', { name: who }),
          onClick: async () => {
            const sure = await confirmDialog(t('kit.shared.removeConfirm', { name: who, item: item.name }), { confirm: t('kit.shared.stop') });
            if (sure) await change(() => remove(item, person))();
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
      : [button(t('kit.shared.leave'), async () => {
        const sure = await confirmDialog(t('kit.shared.leaveConfirm', { item: item.name }), { confirm: t('kit.shared.leave') });
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
