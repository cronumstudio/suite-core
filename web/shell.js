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
  onBack = null, accountItems = [], root = document.body, dragTabs = {},
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
  // The person opens Settings, where everything about the account is, signing out included; a
  // menu only when the app has entries of its own for it or there is no Settings.
  const direct = Boolean(onSettings) && !accountItems.length;
  const accountButton = (withText) => {
    const button = direct
      ? el('button', { type: 'button', class: 'kit-account', 'aria-label': t('kit.account.settings') })
      : el('button', { type: 'button', class: 'kit-account', 'aria-haspopup': 'menu', 'aria-label': t('kit.account.menu') });
    button.addEventListener('click', () => (direct ? onSettings() : openAccountMenu(button)));
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
    // The person's button: the sidebar has it at its foot, with the name —on a phone, in the
    // drawer—, so only the top layout, which has no sidebar, puts it in the bar.
    layout === 'top' ? accountButton(false) : null);
  const banners = el('div', { class: 'kit-banners' });
  const list = el('section', { class: 'kit-pane kit-pane--list' });
  const detail = el('section', { class: 'kit-pane kit-pane--detail' });
  const fab = create ? el('button', { type: 'button', class: 'kit-fab', 'aria-label': create.label, onClick: create.onClick }, icon('plus')) : null;

  // While something is carried on a phone, a tab at each edge: the start one opens the drawer
  // when held, the end one, beside the open drawer, closes it, without letting go (drag.js).
  // Reaching one is enough, no waiting (`at-once`), and it takes more than what is drawn: a
  // finger carrying something doesn't aim at a strip a few pixels wide against the edge.
  const tab = (kind, name) => el('div', {
    class: `kit-drag-tab kit-drag-tab--${kind}`, 'data-drag-spring': 'at-once', 'aria-hidden': 'true',
  }, el('span', { class: 'kit-drag-tab__pill' }, icon(name)));
  const edgeTabs = layout === 'side'
    ? [tab('open', dragTabs.open || 'menu'), tab('back', dragTabs.back || 'back')]
    : [];

  const shell = el('div', { class: 'kit-shell' },
    layout === 'side' ? side : null, layout === 'side' ? scrim : null, bar, banners, list, detail,
    layout === 'top' ? bottom : null, fab, ...edgeTabs);
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
  // (drag.js) would have nowhere to go. When its only places are in the drawer, the drawer opens
  // as the drag starts. When it may also go somewhere in the list (in order, another category:
  // `drawer: 'tabs'`), the list stays and a tab shows at the start edge: held there, the drawer
  // opens, and a tab at the end edge, beside it, closes it again. Held over ☰ it opens too. The
  // drawer goes when the drag ends, dropped or not, if it came for it. Where the sidebar stays
  // (a tablet, a computer) the ☰ isn't shown and nothing of this happens.
  let drawerForDrag = false;
  const asDrawer = () => getComputedStyle(bar.querySelector('.kit-bar__menu')).display !== 'none';
  const drawerIsClosed = () => !element.hasAttribute('data-drawer') && asDrawer();
  const openForDrag = () => {
    element.setAttribute('data-drawer', '');
    drawerForDrag = true;
  };
  document.addEventListener('kit-dragstart', (ev) => {
    const { item, targets, drawer = 'open' } = ev.detail || {};
    if (!item || !element.contains(item) || !targets || !nav.querySelector(targets) || !drawerIsClosed()) return;
    if (drawer === 'tabs') element.setAttribute('data-drag-tabs', '');
    else openForDrag();
  });
  element.addEventListener('kit-drag-spring', (ev) => {
    const open = element.hasAttribute('data-drawer');
    if (!open && ev.target.closest('.kit-bar__menu, .kit-drag-tab--open')) openForDrag();
    else if (open && ev.target.closest('.kit-drag-tab--back')) {
      closeDrawer();
      drawerForDrag = false;
    }
  });
  document.addEventListener('kit-dragend', () => {
    if (drawerForDrag) closeDrawer();
    drawerForDrag = false;
    element.removeAttribute('data-drag-tabs');
  });

  /* ------------------------------- edge swipes ------------------------------ */
  /*
   * Safari takes a swipe from the screen's edge as back or forward in the
   * history, which leaves the app for whatever page came before. Here the
   * start edge does what the bar's button beside it does —opens the drawer,
   * or goes back from a detail— and the end edge does nothing. Only a
   * touchstart cancelled at once stops Safari, and that also cancels the tap
   * and the scroll, so a touch taken at an edge does them by hand: a tap is
   * passed on as a click, a vertical drag scrolls what is under the finger.
   * An edge is only taken when there is something to do or to stop.
   */
  const EDGE = 20;
  let swipe = null;
  const visible = (node) => node.offsetParent !== null;
  const menuButton = bar.querySelector('.kit-bar__menu');
  const backButton = bar.querySelector('.kit-bar__back');
  const startAction = (target) => {
    if (!element.contains(target) || element.hasAttribute('data-drawer')) return null;
    if (visible(backButton)) return () => (onBack || showList)();
    if (layout === 'side' && visible(menuButton)) return openDrawer;
    return null;
  };
  const scrollerOf = (node) => {
    for (let at = node; at && at !== document.body; at = at.parentElement) {
      const { overflowY } = getComputedStyle(at);
      if ((overflowY === 'auto' || overflowY === 'scroll') && at.scrollHeight > at.clientHeight) return at;
    }
    return document.scrollingElement;
  };
  function tap(target) {
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')?.focus();
    target.click();
  }
  document.addEventListener('touchstart', (ev) => {
    swipe = null;
    if (ev.touches.length !== 1) return;
    const { clientX: x, clientY: y } = ev.touches[0];
    const target = ev.target instanceof Element ? ev.target : ev.target.parentElement;
    const rtl = getComputedStyle(element).direction === 'rtl';
    const atStart = rtl ? x > innerWidth - EDGE : x < EDGE;
    const atEnd = rtl ? x < EDGE : x > innerWidth - EDGE;
    const action = atStart ? startAction(target) : null;
    // Without the Navigation API (older Safari) the history is assumed to have somewhere to go.
    const leaves = (atStart && window.navigation?.canGoBack !== false) || (atEnd && window.navigation?.canGoForward !== false);
    const taken = Boolean(action) || leaves;
    if (taken) ev.preventDefault();
    swipe = { x, y, lastY: y, rtl, target, action, taken, axis: null, done: false, scroller: taken ? scrollerOf(target) : null };
  }, { passive: false });
  document.addEventListener('touchmove', (ev) => {
    if (!swipe || swipe.done || ev.touches.length !== 1) return;
    const { clientX, clientY } = ev.touches[0];
    const dx = (clientX - swipe.x) * (swipe.rtl ? -1 : 1);
    const dy = clientY - swipe.y;
    if (!swipe.axis && Math.hypot(dx, dy) > 10) swipe.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (swipe.axis === 'y' && swipe.taken) swipe.scroller.scrollTop -= clientY - swipe.lastY;
    swipe.lastY = clientY;
    if (swipe.axis !== 'x') return;
    if (swipe.action && dx > 40) {
      swipe.done = true;
      swipe.action();
    } else if (dx < -50 && element.hasAttribute('data-drawer')) {
      // An open drawer goes back where it came from with the same gesture, from anywhere.
      swipe.done = true;
      closeDrawer();
    }
  }, { passive: true });
  document.addEventListener('touchend', () => {
    if (swipe?.taken && !swipe.axis && !swipe.done) tap(swipe.target);
    swipe = null;
  });
  document.addEventListener('touchcancel', () => { swipe = null; });
  // A finger that picks something up (drag.js) is no longer a swipe nor a tap: the drawer
  // it opens over ☰ must stay, and letting go must not open the row.
  document.addEventListener('kit-dragstart', () => { swipe = null; });

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
    // The sidebar's button already shows the name and address, so its menu doesn't repeat them;
    // the bar's button is only the initials, and its menu says who it is.
    const withText = accountButtons.find((entry) => entry.button === anchor)?.withText;
    const header = user && !withText ? [el('strong', { text: user.display_name || user.username }), user.email || user.username] : null;
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
