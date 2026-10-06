/**
 * The frame of every app: a sidebar (Tasks, Notes, Projects: many lists) or
 * a top bar with tabs (Next, Focus, Tracker, Talk: a few views), with the
 * same pieces in both —the app's name and icon, the live dot, the account
 * menu, the banners and the button that creates—.
 *
 * On a phone the sidebar is a drawer, and a list and what is open from it are
 * two screens (`showDetail()`, and back); the top bar's tabs go to the bottom,
 * within reach of the thumb. kit.css lays it out by the frame's own width.
 *
 *   const shell = createShell({
 *     layout: 'side', panes: 'split', app: { name: 'Notes', icon: '/icons/favicon.svg' },
 *     create: { label: newLabel, onClick: newNote },
 *     onSettings: openSettings, onSignOut: signOut,
 *   });
 *   shell.nav.append(navItem({ label: allLabel, iconName: 'notes', count: 24, current: true }));
 *   shell.list.append(…); shell.detail.append(…); shell.showDetail();
 */
import { el, clear } from './dom.js';
import { t } from './i18n.js';
import { icon } from './icons.js';
import { banner as bannerNode, menu, closeMenu, avatar } from './ui.js';

/**
 * @param {object} options
 * @param {'side'|'top'} [options.layout]
 * @param {'split'|'single'} [options.panes]  a list and its detail, or one view
 * @param {object} options.app               { name, icon, href }
 * @param {object} [options.create]          { label, onClick }: the button that creates
 * @param {Array}  [options.tabs]            top layout: [{ id, label, iconName, onSelect }]
 * @param {Function} [options.onSettings]
 * @param {Function} [options.onSignOut]
 * @param {Function} [options.onBack]        the detail's back button (default: showList)
 * @param {Array}  [options.accountItems]    the app's own entries of the account menu
 * @param {Node}   [options.root]
 */
export function createShell({
  layout = 'side', panes = 'split', app, create = null, tabs = [], onSettings = null, onSignOut = null,
  onBack = null, accountItems = [], root = document.body,
}) {
  let user = null;
  const appIcon = (size) => el('img', { class: 'kit-appicon', src: app.icon || '/icons/favicon.svg', alt: '', width: size, height: size });
  const liveDots = [];
  const liveDot = () => {
    const dot = el('span', { class: 'kit-live', 'data-state': 'closed', role: 'status', title: t('kit.live.closed') });
    liveDots.push(dot);
    return dot;
  };
  const accountButtons = [];
  const accountButton = (withText) => {
    const button = el('button', { type: 'button', class: 'kit-account', 'aria-haspopup': 'menu', 'aria-label': t('kit.account.menu') });
    button.addEventListener('click', () => openAccountMenu(button));
    accountButtons.push({ button, withText });
    return button;
  };

  /* --------------------------------- pieces --------------------------------- */

  const nav = el('nav', { class: 'kit-side__nav', 'aria-label': app.name });
  const side = el('aside', { class: 'kit-side' },
    el('div', { class: 'kit-side__head' }, appIcon(30), el('span', { class: 'kit-appname', text: app.name }), liveDot()),
    create ? el('div', { class: 'kit-side__create' },
      el('button', { type: 'button', class: 'kit-btn kit-btn--primary kit-btn--block', onClick: create.onClick },
        icon('plus'), create.label)) : null,
    nav,
    el('div', { class: 'kit-side__foot' }, accountButton(true)));
  const scrim = el('div', { class: 'kit-scrim', onClick: () => closeDrawer() });

  const title = el('span', { class: 'kit-bar__title' });
  const actions = el('div', { class: 'kit-bar__actions' });
  const tabButtons = new Map();
  const tabStrip = el('nav', { class: 'kit-bar__tabs', 'aria-label': app.name });
  const bottom = el('nav', { class: 'kit-bottom', 'aria-label': app.name });
  for (const tab of tabs) {
    const top = el('button', { type: 'button', class: 'kit-bar__tab', text: tab.label, onClick: () => selectTab(tab.id) });
    const below = el('button', { type: 'button', class: 'kit-bottom__tab', onClick: () => selectTab(tab.id) },
      icon(tab.iconName || 'grid'), el('span', { text: tab.label }));
    tabButtons.set(tab.id, [top, below]);
    tabStrip.append(top);
    bottom.append(below);
  }
  const bar = el('header', { class: 'kit-bar' },
    el('button', {
      type: 'button', class: 'kit-icon-btn kit-bar__menu', 'aria-label': t('kit.menu'), 'data-drag-spring': '',
      onClick: () => toggleDrawer(),
    }, icon('menu')),
    el('button', { type: 'button', class: 'kit-icon-btn kit-bar__back', 'aria-label': t('kit.back'), onClick: () => (onBack || showList)() }, icon('back')),
    el('a', { class: 'kit-bar__brand', href: app.href || '/?app' }, appIcon(28), el('span', { class: 'kit-appname', text: app.name })),
    tabStrip,
    title,
    actions,
    layout === 'top' && create ? el('button', {
      type: 'button', class: 'kit-btn kit-btn--primary kit-btn--small kit-bar__create', onClick: create.onClick,
    }, icon('plus'), create.label) : null,
    layout === 'top' ? liveDot() : null,
    accountButton(false));
  const banners = el('div', { class: 'kit-banners' });
  const list = el('section', { class: 'kit-pane kit-pane--list' });
  const detail = el('section', { class: 'kit-pane kit-pane--detail' });
  const fab = create ? el('button', { type: 'button', class: 'kit-fab', 'aria-label': create.label, onClick: create.onClick }, icon('plus')) : null;

  const shell = el('div', { class: 'kit-shell' },
    layout === 'side' ? side : null, layout === 'side' ? scrim : null, bar, banners, list, detail,
    layout === 'top' ? bottom : null, fab);
  const element = el('div', { class: 'kit-app', 'data-layout': layout, 'data-panes': panes, 'data-screen': 'list' }, shell);
  root.append(element);

  /* --------------------------------- screens -------------------------------- */

  function showList() {
    element.dataset.screen = 'list';
    list.focus?.({ preventScroll: true });
  }
  function showDetail() {
    element.dataset.screen = 'detail';
    detail.scrollTop = 0;
    closeDrawer();
  }

  function openDrawer() {
    element.setAttribute('data-drawer', '');
    nav.querySelector('[aria-current="page"], a, button')?.focus();
  }
  function closeDrawer() { element.removeAttribute('data-drawer'); }
  function toggleDrawer() { if (element.hasAttribute('data-drawer')) closeDrawer(); else openDrawer(); }
  // Choosing something in the drawer closes it, as on any phone.
  nav.addEventListener('click', (ev) => { if (ev.target.closest('a, button')) closeDrawer(); });
  element.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && element.hasAttribute('data-drawer')) closeDrawer(); });
  // On a phone the sidebar is a closed drawer, and a note or a task picked up from the list
  // (drag.js) would have nowhere to go: the drawer opens as the drag starts, when its places
  // are in it, and goes when the drag ends, dropped or not, as it came for it. Held over ☰
  // it opens too. Where the sidebar stays (a tablet, a computer) the ☰ isn't shown and nothing moves.
  let drawerForDrag = false;
  const drawerIsClosed = () => !element.hasAttribute('data-drawer')
    && getComputedStyle(bar.querySelector('.kit-bar__menu')).display !== 'none';
  const openForDrag = () => {
    element.setAttribute('data-drawer', '');
    drawerForDrag = true;
  };
  document.addEventListener('kit-dragstart', (ev) => {
    const { item, targets } = ev.detail || {};
    if (item && element.contains(item) && targets && nav.querySelector(targets) && drawerIsClosed()) openForDrag();
  });
  element.addEventListener('kit-drag-spring', (ev) => {
    if (ev.target.closest('.kit-bar__menu') && !element.hasAttribute('data-drawer')) openForDrag();
  });
  document.addEventListener('kit-dragend', () => {
    if (drawerForDrag) closeDrawer();
    drawerForDrag = false;
  });

  function selectTab(id, { silent = false } = {}) {
    for (const [key, buttons] of tabButtons) {
      for (const button of buttons) {
        if (key === id) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
    }
    if (!silent) tabs.find((tab) => tab.id === id)?.onSelect?.();
  }

  /* --------------------------------- account -------------------------------- */

  function paintAccount() {
    for (const { button, withText } of accountButtons) {
      clear(button);
      button.append(avatar(user?.display_name || user?.username || ''));
      if (withText && user) {
        button.append(el('span', { class: 'kit-account__text' },
          el('strong', { text: user.display_name || user.username }),
          el('small', { text: user.email || user.username })));
      }
    }
  }

  function openAccountMenu(anchor) {
    if (anchor.getAttribute('aria-expanded') === 'true') {
      closeMenu();
      return;
    }
    const items = [
      ...accountItems,
      onSettings ? { label: t('kit.account.settings'), iconName: 'sliders', onClick: onSettings } : null,
      user?.role === 'admin' ? { label: t('kit.account.admin'), iconName: 'shield', href: '/admin', external: true } : null,
      onSignOut ? 'separator' : null,
      onSignOut ? { label: t('kit.account.signOut'), iconName: 'logout', danger: true, onClick: onSignOut } : null,
    ].filter(Boolean);
    const header = user ? [el('strong', { text: user.display_name || user.username }), user.email || user.username] : null;
    menu(anchor, items, { header });
  }

  /* --------------------------------- notices -------------------------------- */

  const shown = new Map();
  /** A banner under the header, one per id: showing the same id again replaces it. */
  function showBanner(id, options) {
    hideBanner(id);
    const node = bannerNode({ ...options, onClose: options.onClose ? () => { shown.delete(id); options.onClose(); } : null });
    shown.set(id, node);
    banners.append(node);
    return node;
  }
  function hideBanner(id) {
    shown.get(id)?.remove();
    shown.delete(id);
  }

  /** 'open', 'connecting' or 'closed': the dot next to the app's name. */
  function setLive(state) {
    for (const dot of liveDots) {
      dot.dataset.state = state;
      dot.title = t(`kit.live.${state}`);
      dot.setAttribute('aria-label', t(`kit.live.${state}`));
    }
  }

  return {
    element, nav, list, detail, actions, banners,
    get screen() { return element.dataset.screen; },
    showList, showDetail, openDrawer, closeDrawer, toggleDrawer,
    selectTab: (id) => selectTab(id, { silent: true }),
    setTitle: (text) => { title.textContent = text || ''; },
    setUser: (next) => { user = next; paintAccount(); },
    setLive, showBanner, hideBanner,
  };
}

/* ------------------------------ sidebar pieces ------------------------------ */

/** A heading between groups of the sidebar ("Notebooks", "Tags"). */
export const navSection = (label) => el('div', { class: 'kit-nav__section', text: label });

/**
 * An entry of the sidebar: `iconName` or `color` (a swatch for a list or a
 * notebook), a `count` on the right; `now` paints it yolk (today, my day).
 * `data` becomes data-* attributes: `{ drop: '', notebook: 7 }` makes it a
 * place to drop things on (drag.js) that knows which notebook it is.
 */
export function navItem({ label, iconName = null, color = null, count = null, current = false, now = false, href = null, onClick = null, data = null }) {
  const props = {
    class: `kit-nav__item${now ? ' kit-nav__item--now' : ''}`,
    'aria-current': current ? 'page' : null,
    onClick,
  };
  for (const [key, value] of Object.entries(data || {})) {
    props[`data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`] = value;
  }
  const children = [
    color ? el('span', { class: 'kit-nav__swatch', style: `background:${color}` }) : iconName ? icon(iconName) : null,
    el('span', { class: 'kit-nav__label', text: label }),
    count != null ? el('span', { class: 'kit-nav__count', text: String(count) }) : null,
  ];
  return href ? el('a', { ...props, href }, children) : el('button', { ...props, type: 'button' }, children);
}

/** Marks one entry of the sidebar as the current one. */
export function setCurrent(nav, item) {
  for (const node of nav.querySelectorAll('.kit-nav__item')) {
    if (node === item) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  }
}
