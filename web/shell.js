/**
 * The frame of every app: a sidebar with the app's name and icon, the live
 * dot, the button that creates, the app's own entries and the person at its
 * foot; the banners; and the app's views beside it.
 *
 * On a phone the sidebar is a drawer, and a list and what is open from it are
 * two screens (`showDetail()`, and back). On a tablet or a computer it stays
 * beside the views, and can be folded away for more room: the button at its
 * head folds it, ☰ in the bar that then shows brings it back, and the choice
 * is remembered on the device. kit.css lays it out by the frame's own width.
 *
 * As a module of a host (suite-core host.js, Cronum Work), the person's button
 * at the sidebar's foot gives way, and Settings is reached another way. Where
 * the sidebar stays (a tablet, a computer), a rail at its start has the host's
 * home, the modules the person uses and Settings at its foot. On a phone the
 * drawer keeps its width without the rail: the app's icon and name at its head
 * are a button whose menu has the other modules and, last, Settings.
 *
 *   const shell = createShell({
 *     panes: 'split', app: { id: 'notes', name: 'Notes', icon: '/icons/favicon.svg' },
 *     create: { label: newLabel, onClick: newNote },
 *     onSettings: openSettings, onSignOut: signOut,
 *   });
 *   shell.nav.append(navItem({ label: allLabel, iconName: 'notes', count: 24, current: true }));
 *   shell.list.append(…); shell.detail.append(…); shell.showDetail();
 */
import { el, clear } from './dom.js';
import { t } from './i18n.js';
import { icon } from './icons.js';
import { at, BASE } from './base.js';
import { banner as bannerNode, menu, closeMenu, avatar } from './ui.js';

/** From this width the sidebar sits beside the views instead of over them (kit.css). */
const BESIDE = 640;

/**
 * @param {object} options
 * @param {'split'|'single'} [options.panes]  a list and its detail, or one view
 * @param {object} options.app               { id, name, icon }: the id names what the device remembers
 * @param {object} [options.create]          { label, onClick }: the button that creates
 * @param {Function} [options.onSettings]
 * @param {Function} [options.onSignOut]
 * @param {Function} [options.onBack]        the detail's back button (default: showList)
 * @param {Function} [options.onFold]        (folded) the sidebar folded or came back: the views' width changed
 * @param {Array}  [options.accountItems]    the app's own entries of the account menu
 * @param {Node}   [options.root]
 */
export function createShell({
  panes = 'split', app, create = null, onSettings = null, onSignOut = null,
  onBack = null, onFold = null, accountItems = [], root = document.body, dragTabs = {},
}) {
  let user = null;
  const appIcon = (size) => el('img', { class: 'kit-appicon', src: at(app.icon || '/icons/favicon.svg'), alt: '', width: size, height: size });
  // The person opens Settings, where everything about the account is, signing out included; a
  // menu only when the app has entries of its own for it or there is no Settings.
  const direct = Boolean(onSettings) && !accountItems.length;
  const account = direct
    ? el('button', { type: 'button', class: 'kit-account', 'aria-label': t('kit.account.settings') })
    : el('button', { type: 'button', class: 'kit-account', 'aria-haspopup': 'menu', 'aria-label': t('kit.account.menu') });
  account.addEventListener('click', () => (direct ? onSettings() : openAccountMenu(account)));

  /* --------------------------------- pieces --------------------------------- */

  const live = el('span', { class: 'kit-live', 'data-state': 'closed', role: 'status', title: t('kit.live.closed') });
  const fold = el('button', {
    type: 'button', class: 'kit-icon-btn kit-side__fold', title: t('kit.side.fold'), 'aria-label': t('kit.side.fold'),
    onClick: () => setFolded(true),
  }, icon('back'));
  const nav = el('nav', { class: 'kit-side__nav', 'aria-label': app.name });
  const headIcon = appIcon(30);
  const headName = el('span', { class: 'kit-appname', text: app.name });
  const head = el('div', { class: 'kit-side__head' }, headIcon, headName, live, fold);
  const foot = el('div', { class: 'kit-side__foot' }, account);
  const side = el('aside', { class: 'kit-side' },
    head,
    create ? el('div', { class: 'kit-side__create' },
      el('button', { type: 'button', class: 'kit-btn kit-btn--primary kit-btn--block', onClick: create.onClick },
        icon('plus'), create.label)) : null,
    nav,
    foot);
  const scrim = el('div', { class: 'kit-scrim', onClick: () => closeDrawer() });

  const title = el('span', { class: 'kit-bar__title' });
  const actions = el('div', { class: 'kit-bar__actions' });
  const menuButton = el('button', {
    type: 'button', class: 'kit-icon-btn kit-bar__menu', 'aria-label': t('kit.menu'), 'data-drag-spring': '',
    onClick: () => toggleDrawer(),
  }, icon('menu'));
  const backButton = el('button', {
    type: 'button', class: 'kit-icon-btn kit-bar__back', 'aria-label': t('kit.back'), onClick: () => (onBack || showList)(),
  }, icon('back'));
  // With the sidebar folded away, its button that creates comes to the bar.
  const barCreate = create ? el('button', {
    type: 'button', class: 'kit-btn kit-btn--primary kit-btn--small kit-bar__create', onClick: create.onClick,
  }, icon('plus'), create.label) : null;
  const bar = el('header', { class: 'kit-bar' }, menuButton, backButton, title, actions, barCreate);
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

  const shell = el('div', { class: 'kit-shell' },
    side, scrim, bar, banners, list, detail, fab, tab('open', dragTabs.open || 'menu'), tab('back', dragTabs.back || 'back'));
  // `data-layout` stays for the apps' own CSS, which names it.
  const element = el('div', { class: 'kit-app', 'data-layout': 'side', 'data-panes': panes, 'data-screen': 'list' }, shell);
  root.append(element);

  /* --------------------------------- folding -------------------------------- */

  // Kept per app and device under `<id>.sidebar`, 'collapsed' or 'visible' (Projects' own key and
  // values from before the kit folded it, so nobody's choice is lost).
  const foldKey = `${app.id || app.name.toLowerCase()}.sidebar`;
  const beside = () => (element.clientWidth || window.innerWidth) >= BESIDE;
  /** Folded and beside the views: below that width the sidebar is a drawer, folded or not. */
  const folded = () => element.hasAttribute('data-folded') && beside();
  function paintFolded(value) {
    element.toggleAttribute('data-folded', value);
    if (value) menuButton.title = t('kit.side.unfold');
    else menuButton.removeAttribute('title');
  }
  function setFolded(value) {
    try { localStorage.setItem(foldKey, value ? 'collapsed' : 'visible'); } catch { /* private mode */ }
    closeDrawer();
    paintFolded(value);
    onFold?.(value);
  }
  try { paintFolded(localStorage.getItem(foldKey) === 'collapsed'); } catch { /* private mode */ }

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
    // Folded beside the views, what would open it over them (☰, a swipe from the edge) unfolds it.
    if (folded()) setFolded(false);
    else element.setAttribute('data-drawer', '');
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
  // (a tablet, a computer) the ☰ isn't shown and nothing of this happens; folded away there, it
  // comes over the views as on a phone for the drag, and stays folded.
  let drawerForDrag = false;
  const asDrawer = () => getComputedStyle(menuButton).display !== 'none';
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
  const startAction = (target) => {
    if (!element.contains(target) || element.hasAttribute('data-drawer')) return null;
    if (visible(backButton)) return () => (onBack || showList)();
    if (visible(menuButton)) return openDrawer;
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

  /* --------------------------------- account -------------------------------- */

  function paintAccount() {
    clear(account);
    account.append(avatar(user?.display_name || user?.username || ''));
    if (user) {
      account.append(el('span', { class: 'kit-account__text' },
        el('strong', { text: user.display_name || user.username }),
        el('small', { text: user.email || user.username })));
    }
  }

  /** The account menu's entries; with Settings and nothing of the app's own, Settings alone. */
  function accountMenuItems() {
    const settings = onSettings ? { label: t('kit.account.settings'), iconName: 'sliders', onClick: () => { closeDrawer(); onSettings(); } } : null;
    if (direct) return [settings];
    return [
      ...accountItems,
      settings,
      user?.role === 'admin' ? { label: t('kit.account.admin'), iconName: 'shield', href: '/admin', external: true } : null,
      onSignOut ? 'separator' : null,
      onSignOut ? { label: t('kit.account.signOut'), iconName: 'logout', danger: true, onClick: onSignOut } : null,
    ].filter(Boolean);
  }

  /** A menu from `anchor`, or none if it was open: a second tap closes it. */
  function toggleMenu(anchor, items) {
    if (anchor.getAttribute('aria-expanded') === 'true') {
      closeMenu();
      return;
    }
    menu(anchor, items);
  }

  // The button already shows the name and address, so its menu doesn't repeat them.
  const openAccountMenu = (anchor) => toggleMenu(anchor, accountMenuItems());

  /* --------------------------------- modules -------------------------------- */

  // This page's module, when it is one of a host's: its path's single segment.
  const mount = /^\/([a-z][a-z0-9-]{1,30})\/$/.exec(BASE)?.[1] || null;
  let rail = null;
  let switcher = null;
  let hosted = false;     // drawn as a host's module
  let answered = false;   // the host said (or failed to say) which modules: the rail is known
  let others = [];        // the other modules the person uses, for the switcher's menu

  /** As a host's module (`on`) the person's button gives way; off, it is as in an app on its own. */
  function asModule(on) {
    hosted = on;
    element.toggleAttribute('data-module', on);
    foot.hidden = on;
    syncSwitcher();
  }

  /**
   * The app's icon and name are the switcher where the rail doesn't show: on a phone, or where
   * the host didn't answer with one (offline), so Settings is always one tap away. Beside the
   * views it waits for the host's answer, so the rail doesn't come with a switcher that goes.
   */
  function syncSwitcher() {
    const want = hosted && !(beside() && (rail || !answered));
    if (want && !switcher) {
      switcher = el('button', {
        type: 'button', class: 'kit-side__app', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
        'aria-label': t('kit.modules.switch', { name: app.name }),
        onClick: () => toggleMenu(switcher, [
          ...others.map((m) => ({ label: m.name, image: m.icon, href: m.path })),
          others.length ? 'separator' : null,
          ...accountMenuItems(),
        ].filter(Boolean)),
      });
      head.prepend(switcher);
      switcher.append(headIcon, headName, icon('chevron-down'));
    } else if (!want && switcher) {
      if (switcher.getAttribute('aria-expanded') === 'true') closeMenu();
      head.prepend(headIcon, headName);
      switcher.remove();
      switcher = null;
    }
  }

  /** Takes the rail away, and the sidebar's content back to where it was. */
  function dropRail() {
    if (!rail) return;
    rail.remove();
    rail = null;
    side.removeAttribute('data-rail');
    element.removeAttribute('data-rail');
  }

  /** The modules beside this one, as the host lists them for this person (GET /api/modules at its root). */
  function paintRail({ host = {}, modules = [] } = {}) {
    if (!modules.some((m) => m.mount === mount)) {   // not a module of this host
      dropRail();
      return asModule(false);
    }
    // The host's home opens the module used last.
    try { localStorage.setItem('host.module', mount); } catch { /* private mode */ }
    const shown = modules.filter((m) => m.active || m.mount === mount);
    others = shown.filter((m) => m.mount !== mount);
    // With one module too: the rail has Settings, and the host's home to choose more.
    const settingsLabel = direct ? t('kit.account.settings') : t('kit.account.menu');
    const next = el('nav', { class: 'kit-rail', 'aria-label': t('kit.modules.rail') },
      // The host's home: where the modules are chosen.
      el('a', { class: 'kit-rail__home', href: '/?modules', title: t('kit.modules.home'), 'aria-label': t('kit.modules.home') },
        host.icon ? el('img', { src: host.icon, alt: '', width: 32, height: 32 }) : icon('grid')),
      ...shown.map((m) => el('a', {
        class: 'kit-rail__module', href: m.path, title: m.name, 'aria-current': m.mount === mount ? 'page' : null,
        style: m.color ? `--module: ${m.color}` : null,
      }, el('img', { src: m.icon, alt: '', width: 28, height: 28 }), el('span', { class: 'kit-rail__name', text: m.name }))),
      // Settings at its foot, in place of the person's button.
      onSettings || accountItems.length || onSignOut ? el('button', {
        type: 'button', class: 'kit-rail__settings', title: settingsLabel, 'aria-label': settingsLabel,
        ...(direct ? {} : { 'aria-haspopup': 'menu' }),
        onClick: (ev) => (direct ? onSettings() : openAccountMenu(ev.currentTarget)),
      }, icon('sliders')) : null);
    if (!side.querySelector(':scope > .kit-side__main')) {
      const main = el('div', { class: 'kit-side__main' });
      while (side.firstChild) main.append(side.firstChild);
      side.append(main);
    }
    if (rail) rail.replaceWith(next);
    else side.prepend(next);
    rail = next;
    side.setAttribute('data-rail', '');
    element.setAttribute('data-rail', '');
    asModule(true);
    return rail;
  }

  /** Asks the host again: someone may have turned a module on or off in another tab. */
  async function refreshModules() {
    if (!mount) return null;
    try {
      const res = await fetch('/api/modules', { credentials: 'same-origin' });
      if (res.status === 404) {   // no host there: an app on its own under a path
        dropRail();
        return asModule(false);
      }
      if (!res.ok) return null;
      return paintRail(await res.json());
    } catch {
      return null;   // offline: the rail stays as it was
    } finally {
      answered = true;
      syncSwitcher();
    }
  }
  if (mount) {
    // Under a module's path it is a host's, almost surely: as one from the start, so the
    // person's button doesn't show and go once the host answers.
    asModule(true);
    refreshModules();
    // A phone turned, a window made narrower: the rail shows or not, and the switcher with it.
    window.addEventListener('resize', syncSwitcher);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshModules(); });
    document.addEventListener('kit-modules', () => refreshModules());
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
    live.dataset.state = state;
    live.title = t(`kit.live.${state}`);
    live.setAttribute('aria-label', t(`kit.live.${state}`));
  }

  return {
    element, nav, list, detail, actions, banners,
    get screen() { return element.dataset.screen; },
    showList, showDetail, openDrawer, closeDrawer, toggleDrawer,
    get folded() { return folded(); },
    setTitle: (text) => { title.textContent = text || ''; },
    setUser: (next) => { user = next; paintAccount(); },
    setLive, showBanner, hideBanner, refreshModules,
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
