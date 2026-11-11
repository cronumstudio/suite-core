/**
 * The frame of every app: a sidebar with the app's name and icon, the live
 * dot and the app's own entries, and at its foot what makes a collection (a
 * list, a notebook) and the trash; the banners; and the app's views beside it,
 * with the floating button that creates an item over the list. There is no
 * button for the person: the app's icon and name at the sidebar's head open
 * Settings (or, with more to offer, a menu).
 *
 * On a phone the sidebar is a drawer, and a list and what is open from it are
 * two screens (`showDetail()`, and back). On a tablet or a computer it stays
 * beside the views, and can be folded away for more room: the button at its
 * head folds it, ☰ in the bar that then shows brings it back, and the choice
 * is remembered on the device. kit.css lays it out by the frame's own width.
 *
 * Each view can start with the kit's head (`shell.head()`): its title and the
 * app's «…», with ☰ (or ←) in it wherever the bar would have shown it. A pane
 * showing one doesn't show the bar. A detail's ends with × where its list is
 * beside it, and Escape closes it as ← and × do (`onBack`).
 *
 * As a module of a host (suite-core host.js, Cronum Work), where the sidebar
 * stays (a tablet, a computer), a rail at its start has the host's mark, the
 * modules the person uses and Settings at its foot, and the app's icon is only
 * its mark. On a phone the drawer keeps its width without the rail: the app's
 * icon and name are a button whose menu has the other modules and, last, Settings.
 *
 * A host with a split view (host.js `split`) has its views on the rail, over
 * Settings: this module alone, or two to four at once on the host's page. There
 * each module is a frame (base.js FRAMED), drawn without the rail: the page says
 * which module each frame shows, and the app's name keeps Settings at hand. A
 * host with a calendar (host.js `calendar`) has it on the rail too, just over
 * the split view: its page, with what has a date in every module.
 *
 * In a window of Cronum Work's one-document shell (`embedded`, mount.js), the
 * page is Work's and every module shares it: the rail, the person, the host's
 * notices and the history of the installed app are the shell's, drawn once, so
 * the frame draws none of them and asks the host nothing. Its sidebar, and its
 * fold, are the module's own and stay. Settings come when Work asks the window
 * (`kit:settings` on `root`), as the split view asks a frame.
 *
 *   const shell = createShell({
 *     panes: 'split', app: { id: 'notes', name: 'Notes', icon: '/icons/favicon.svg' },
 *     create: { label: newLabel, onClick: newNote },
 *     foot: { create: { items: [newNotebookItem, newGroupItem] }, trash: { onClick: openTrash } },
 *     search: { label: searchLabel, onInput: (text) => findNotes(text) },
 *     onSettings: openSettings, onSignOut: signOut,
 *   });
 *   shell.nav.append(navItem({ label: allLabel, iconName: 'notes', count: 24, current: true }));
 *   shell.list.append(…); shell.detail.append(…); shell.showDetail();
 */
import { el } from './dom.js';
import { t } from './i18n.js';
import { icon } from './icons.js';
import { at, BASE, FRAMED, SETTINGS_EVENT, DRAWER_EVENT, applyLook, LOOK_KEY, hostModules, installed, installedAlone } from './base.js';
import { banner as bannerNode, menu, closeMenu, heldBack, slideHidden } from './ui.js';
import { nativeReady, hostShellAddress } from './native.js';
import { billingReturn, lastDay } from './plan.js';
import { flushSettings } from './settings-queue.js';

/** From this width the sidebar sits beside the views instead of over them (kit.css). */
const BESIDE = 640;
/** The host's last answer of which modules there are (GET /api/modules), for the rail at once. */
const RAIL_KEY = 'host.modules';
/** The founder's notice closed on this device, for the date it named: it comes back for another. */
const FOUNDER_KEY = 'host.founder-offer';
/** How many modules the host's split view shows at once: one, two or three side by side, four in a grid. */
export const SPLIT_LAYOUTS = Object.freeze([1, 2, 3, 4]);

/**
 * @param {object} options
 * @param {'split'|'single'} [options.panes]  a list and its detail, or one view
 * @param {object} options.app               { id, name, icon }: the id names what the device remembers
 * @param {object} [options.create]          { label, onClick }: the floating button that creates an
 *   item (a note, a step), at every width: over the list on a phone, at the foot of the list's pane
 *   beside the views. Never in the sidebar, which makes collections only (`foot`).
 * @param {object} [options.foot]            { create, trash }, each optional: the sidebar's foot, which
 *   never scrolls away. `create` ({ label?, onClick } or { label?, items }, an array or a function
 *   that returns one, for a menu) makes a collection, a + at its start; `trash` ({ label?, onClick }
 *   or { label?, href, current? }) at its end. Their words are the kit's unless given.
 *   `shell.foot` is { element, create, trash }, the trash a place `setCurrent()` marks too.
 * @param {object} [options.search]          { label, placeholder?, onInput(text), onSubmit?(text) }: the
 *   module's search, at the top of its sidebar. It reads the kit's «Buscar» (`kit.side.search`) in
 *   every module, and `label`, the module's own words, names it (aria-label); `placeholder` would
 *   replace the word, and no module of the suite gives one. Escape empties it, Enter in the drawer
 *   closes it so the results show, and «/» goes to it, said nowhere. `shell.search` is its field.
 * @param {Function} [options.onSettings]
 * @param {Function} [options.onSignOut]
 * @param {Function} [options.onBack]        what closes the detail: its ←, its × and Escape (default: showList)
 * @param {Function} [options.onFold]        (folded) the sidebar folded or came back: the views' width changed
 * @param {Array}  [options.accountItems]    the app's own entries of the account menu
 * @param {Node}   [options.root]
 * @param {boolean} [options.embedded]      in a window of Cronum Work's shell: no rail, account or host notices
 * @param {Function} [options.active]       () → whether this frame has the keyboard when the focus is on no
 *   element (the page's body): Escape then closes its detail, and «/» goes to its search. In Work's
 *   shell `ctx.active`; by default yes on a page of its own, and in a window of Work's shell while it
 *   is the one in front (`data-focus="true"` on the window that holds `root`, windows.js)
 */
export function createShell({
  panes = 'split', app, create = null, foot = null, search = null, onSettings = null, onSignOut = null,
  onBack = null, onFold = null, accountItems = [], root = document.body, dragTabs = {},
  embedded = false, active = null,
}) {
  // Every listener the frame adds goes with destroy(), through this one signal (all but the
  // click swallowed after a drag of the drawer, see `swallowing`). An app that draws its frame
  // again (a new language, a refresh) left the old frame listening on the document: a tap at the
  // screen's edge was then passed on once per frame ever made, and none was freed.
  const listening = new AbortController();
  const { signal } = listening;
  // Preferences changed in Settings without a signal go once a page starts and the server answers.
  flushSettings();
  const swallowing = new Set();
  let destroyed = false;
  let user = null;
  const appIcon = (size) => el('img', { class: 'kit-appicon', src: at(app.icon || '/icons/favicon.svg'), alt: '', width: size, height: size });
  // The person opens Settings, where everything about the account is, signing out included; a
  // menu only when the app has entries of its own for it or there is no Settings. There is no
  // button for the person: the app's icon and name open Settings (the switcher), or the rail does.
  const direct = Boolean(onSettings) && !accountItems.length;

  /* --------------------------------- pieces --------------------------------- */

  const live = el('span', { class: 'kit-live', 'data-state': 'closed', role: 'status', title: t('kit.live.closed') });
  const fold = el('button', {
    type: 'button', class: 'kit-icon-btn kit-side__fold', title: t('kit.side.fold'), 'aria-label': t('kit.side.fold'),
    onClick: () => setFolded(true),
  }, icon('back'));
  // tabindex: the drawer opened by a finger takes the focus itself (openDrawer).
  const nav = el('nav', { class: 'kit-side__nav', 'aria-label': app.name, tabindex: '-1' });
  const headIcon = appIcon(30);
  const headName = el('span', { class: 'kit-appname', text: app.name });
  // In Work's shell the window's head or the phone's tab already names the module, and the shell
  // shows the one live dot: the sidebar keeps only its button that folds it.
  const head = embedded ? el('div', { class: 'kit-side__head' }, fold) : el('div', { class: 'kit-side__head' }, headIcon, headName, live, fold);
  // The module's search, the same in every module: the sidebar's first line, reading the kit's
  // «Buscar». The module's own words name it: as the words in it they were cut short in two.
  const searchField = search ? el('input', {
    type: 'search', class: 'kit-side__search-input', placeholder: search.placeholder || t('kit.side.search'),
    'aria-label': search.label, enterkeyhint: 'search', autocomplete: 'off',
  }) : null;
  if (searchField) {
    searchField.addEventListener('input', () => search.onInput?.(searchField.value), { signal });
    searchField.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && searchField.value) {
        ev.stopPropagation();
        searchField.value = '';
        search.onInput?.('');
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        search.onSubmit?.(searchField.value);
        // In the drawer the results are behind it.
        if (element.hasAttribute('data-drawer')) closeDrawer();
      }
    }, { signal });
  }
  const searchBox = searchField ? el('div', { class: 'kit-side__search', role: 'search' }, icon('search'), searchField) : null;
  // The sidebar's foot, the same in every module: what makes a collection (a list, a notebook; an
  // item is the floating button's) at its start, the trash at its end. The + with a menu opens it
  // over the drawer, and each choice closes the drawer as an entry would; the trash closes it too.
  const addLabel = foot?.create ? foot.create.label || t('kit.side.create') : null;
  const add = foot?.create ? el('button', {
    type: 'button', class: 'kit-icon-btn kit-side__add', title: addLabel, 'aria-label': addLabel,
    ...(foot.create.items ? { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } : {}),
    onClick: () => {
      const { items, onClick } = foot.create;
      if (!items) {
        closeDrawer();
        onClick?.();
        return;
      }
      toggleMenu(add, (typeof items === 'function' ? items() : items).map((item) => (item && item !== 'separator'
        ? { ...item, onClick: () => { closeDrawer(); item.onClick?.(); } } : item)));
    },
  }, icon('plus')) : null;
  const trashLabel = foot?.trash ? foot.trash.label || t('kit.side.trash') : null;
  // A view of its own (Notes' `#/trash`) is a link, and the place open while it shows (setCurrent).
  const trash = foot?.trash ? el(foot.trash.href ? 'a' : 'button', {
    ...(foot.trash.href ? { href: foot.trash.href } : { type: 'button' }),
    class: 'kit-icon-btn kit-side__trash', title: trashLabel, 'aria-label': trashLabel,
    'aria-current': foot.trash.current ? 'page' : null,
    onClick: () => {
      closeDrawer();
      foot.trash.onClick?.();
    },
  }, icon('trash')) : null;
  const footer = add || trash ? el('div', { class: 'kit-side__foot' }, add, trash) : null;
  // In Work's shell, with a search, the button that folds shares its line instead of one of its own.
  const side = el('aside', { class: 'kit-side' },
    embedded && searchBox ? el('div', { class: 'kit-side__top' }, searchBox, fold) : [head, searchBox],
    nav, footer);
  const scrim = el('div', { class: 'kit-scrim', onClick: () => closeDrawer() });

  const title = el('span', { class: 'kit-bar__title' });
  const actions = el('div', { class: 'kit-bar__actions' });
  // The bar's buttons, made again for each view's head (head()): kit.css shows each one where
  // it applies, in the bar or in a head alike, by its class.
  const menuToggle = () => {
    // ☰ pressed with Enter or Space: the click that follows is the keyboard's. Not a click without
    // a pointer, which a tap at the screen's edge passed on is too.
    let byKeys = false;
    return el('button', {
      type: 'button', class: 'kit-icon-btn kit-bar__menu', 'aria-label': t('kit.menu'), 'data-drag-spring': '',
      onKeydown: (ev) => { byKeys = ev.key === 'Enter' || ev.key === ' '; },
      onClick: () => {
        const keyboard = byKeys;
        byKeys = false;
        toggleDrawer({ keyboard });
      },
    }, icon('menu'));
  };
  const backToggle = () => el('button', {
    type: 'button', class: 'kit-icon-btn kit-bar__back', 'aria-label': t('kit.back'), onClick: () => (onBack || showList)(),
  }, icon('back'));
  // A detail's × where ← doesn't show (beside its list, kit.css): the same way out.
  const closeToggle = () => el('button', {
    type: 'button', class: 'kit-icon-btn kit-head__close', title: t('kit.close'), 'aria-label': t('kit.close'),
    onClick: () => (onBack || showList)(),
  }, icon('x'));
  const menuButton = menuToggle();
  const bar = el('header', { class: 'kit-bar' }, menuButton, backToggle(), title, actions);
  const banners = el('div', { class: 'kit-banners' });
  const list = el('section', { class: 'kit-pane kit-pane--list' });
  const detail = el('section', { class: 'kit-pane kit-pane--detail' });
  // What creates an item, the same at every width and folded or not: kit.css puts it at the foot of
  // the pane that holds the list, inside the frame. Its words show to a pointer that rests on it.
  const fab = create ? el('button', {
    type: 'button', class: 'kit-fab', 'aria-label': create.label, title: create.label, onClick: create.onClick,
  }, icon('plus')) : null;

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
  const element = el('div', { class: 'kit-app', 'data-layout': 'side', 'data-panes': panes, 'data-screen': 'list', ...(embedded ? { 'data-embedded': '' } : {}) }, shell);
  root.append(element);

  /* --------------------------------- folding -------------------------------- */

  // Kept per app and device under `<id>.sidebar`, 'collapsed' or 'visible' (Projects' own key and
  // values from before the kit folded it, so nobody's choice is lost).
  const foldKey = `${app.id || app.name.toLowerCase()}.sidebar`;
  const beside = () => (element.clientWidth || window.innerWidth) >= BESIDE;
  /** Folded and beside the views: below that width the sidebar is a drawer, folded or not. */
  const folded = () => element.hasAttribute('data-folded') && beside();
  /** ☰ says what it does: with the sidebar folded beside the views, it brings it back. */
  const titleMenu = (button) => {
    if (element.hasAttribute('data-folded')) button.title = t('kit.side.unfold');
    else button.removeAttribute('title');
  };
  function paintFolded(value) {
    element.toggleAttribute('data-folded', value);
    for (const button of element.querySelectorAll('.kit-bar__menu')) titleMenu(button);
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

  /**
   * Opened from the keyboard, the focus goes to the current entry, to go on from there. Opened by
   * a finger or the mouse (☰, a swipe from the edge), it goes to the drawer itself: on a phone a
   * ring around the current entry looked like a frame drawn on it, its top cut under the create
   * button (Notes #41).
   */
  function openDrawer({ keyboard = false } = {}) {
    // Folded beside the views, what would open it over them (☰, a swipe from the edge) unfolds it.
    if (folded()) setFolded(false);
    else element.setAttribute('data-drawer', '');
    if (keyboard) nav.querySelector('[aria-current="page"], a, button')?.focus();
    else nav.focus({ preventScroll: true });
  }
  function closeDrawer() { element.removeAttribute('data-drawer'); }
  function toggleDrawer(how) { if (element.hasAttribute('data-drawer')) closeDrawer(); else openDrawer(how); }
  // Choosing something in the drawer closes it, as on any phone.
  nav.addEventListener('click', (ev) => { if (ev.target.closest('a, button')) closeDrawer(); }, { signal });
  element.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && element.hasAttribute('data-drawer')) closeDrawer(); }, { signal });
  // In a frame of the host's split view, the view's own Settings button (at its rail's foot)
  // opens this module's: the page asks with `kit:settings` on this frame's window, and may name
  // the section (`detail.start`), one of this module's chosen in Settings in another frame.
  if (FRAMED && onSettings) {
    window.addEventListener(SETTINGS_EVENT, (ev) => {
      closeDrawer();
      const start = ev?.detail?.start;
      if (typeof start === 'string' && start) onSettings(start);
      else onSettings();
    }, { signal });
  }
  // On a phone Work's shell has the one ☰, beside its brand: it asks the module in sight for its
  // drawer on the body of its window (ctx.root).
  if (embedded) root.addEventListener(DRAWER_EVENT, () => toggleDrawer(), { signal });
  // In Work's shell one window object is every module's: the shell asks the one it means on the
  // body of its window (ctx.root), naming the section or not, as the split view asks a frame.
  if (embedded && onSettings) {
    root.addEventListener(SETTINGS_EVENT, (ev) => {
      closeDrawer();
      const start = ev?.detail?.start;
      if (typeof start === 'string' && start) onSettings(start);
      else onSettings();
    }, { signal });
  }
  // On a phone the sidebar is a closed drawer, and a note or a task picked up from the list
  // (drag.js) would have nowhere to go. When its only places are in the drawer, the drawer opens
  // as the drag starts. When it may also go somewhere in the list (in order, another category:
  // `drawer: 'tabs'`), the list stays and a tab shows at the start edge: held there, the drawer
  // opens, and a tab at the end edge, beside it, closes it again. Held over ☰ it opens too. The
  // drawer goes when the drag ends, dropped or not, if it came for it. Where the sidebar stays
  // (a tablet, a computer) the ☰ isn't shown and nothing of this happens; folded away there, it
  // comes over the views as on a phone for the drag, and stays folded.
  let drawerForDrag = false;
  // In Work's shell on a phone its ☰ is the shell's and the window's is hidden: by the width then,
  // as kit.css decides it (`@container kit-app`).
  const asDrawer = () => (embedded ? !beside() : getComputedStyle(menuButton).display !== 'none');
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
  }, { signal });
  element.addEventListener('kit-drag-spring', (ev) => {
    const open = element.hasAttribute('data-drawer');
    if (!open && ev.target.closest('.kit-bar__menu, .kit-drag-tab--open')) openForDrag();
    else if (open && ev.target.closest('.kit-drag-tab--back')) {
      closeDrawer();
      drawerForDrag = false;
    }
  }, { signal });
  document.addEventListener('kit-dragend', () => {
    if (drawerForDrag) closeDrawer();
    drawerForDrag = false;
    element.removeAttribute('data-drag-tabs');
  }, { signal });

  /* ------------------------------- edge swipes ------------------------------ */
  /*
   * Safari takes a swipe from the screen's edge as back or forward in the
   * history, which leaves the app for whatever page came before. Here the
   * start edge does what the bar's button beside it does —opens the drawer,
   * or goes back from a detail— and the end edge does nothing. Over a page
   * with a way back of its own (Settings, ui.js holdBack) it goes back there. Only a
   * touchstart cancelled at once stops Safari, and that also cancels the tap
   * and the scroll, so a touch taken at an edge does them by hand: a tap is
   * passed on as a click, a vertical drag scrolls what is under the finger.
   * An edge is only taken when there is something to do or to stop.
   *
   * The drawer follows the finger: from the start edge it comes out as far as
   * the finger goes, over the open drawer it goes back the same way, and on
   * lifting the finger it opens or closes by how far the finger went. It was
   * Tasks' own gesture; the other apps' drawer came out all at once.
   *
   * Going back follows the finger too (Martin: the screen before appeared
   * instead of sliding in): the screen on top slides away with it, over the
   * one it goes back to, and on lifting the finger it goes all the way or
   * comes back, by how far or how fast the finger went. A detail on a phone
   * uncovers its list; Settings say what they uncover (ui.js holdBack).
   */
  // A little wider than the system's own strip seems to be: a swipe to open the drawer that began
  // just past 20 px went to the system, which took it as Back (the installed app, an iPhone).
  const EDGE = 28;
  /** How far a finger goes sideways before the drawer follows it. */
  const DRAG_ARM = 12;
  /**
   * How far the finger has to go for the drawer to open or close: the finger's path, not where
   * the drawer ends, so closing costs the same as opening. When the system takes the gesture
   * away midway, the intention that had begun is honoured, past a tremor.
   */
  const commitDistance = (width) => Math.min(90, width * 0.28);
  const CANCEL_COMMIT = 35;
  let swipe = null;
  const visible = (node) => node.offsetParent !== null;
  // In the bar or in a view's head: whichever shows.
  const showing = (selector) => [...element.querySelectorAll(selector)].some(visible);
  /** Going back from a phone's detail: the detail slides away over its list. */
  const detailSlide = () => (getComputedStyle(list).display === 'none' ? {
    moving: detail, under: list, show: (on) => element.toggleAttribute('data-back-swipe', on),
  } : null);
  const startAction = (target) => {
    if (!element.contains(target) || element.hasAttribute('data-drawer')) return null;
    if (showing('.kit-bar__back')) return () => (onBack || showList)();
    // In Work's shell on a phone the ☰ is the shell's, not in the window: the edge still opens it.
    if (showing('.kit-bar__menu') || (embedded && asDrawer())) return () => openDrawer();
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
    const held = atStart ? heldBack(target) : null;
    const action = held ? held.back : atStart ? startAction(target) : null;
    // What follows the finger back, if anything: asked when it starts to go (startSlide).
    const slide = held ? held.slide : action && showing('.kit-bar__back') ? detailSlide : null;
    // Without the Navigation API (older Safari) the history is assumed to have somewhere to go. In
    // Work's shell the page's edges are the shell's to keep from Safari: a window takes a touch only
    // for what it does itself, or every window mounted would pass the same tap on.
    const leaves = !embedded && ((atStart && window.navigation?.canGoBack !== false) || (atEnd && window.navigation?.canGoForward !== false));
    const taken = Boolean(action) || leaves;
    if (taken) ev.preventDefault();
    // The drawer to drag, on a phone (beside the views, folded, the edge unfolds the sidebar): out
    // from the edge where ☰ would open it, back from anywhere when open.
    const open = element.hasAttribute('data-drawer');
    const drawer = beside() || held ? null
      : open && element.contains(target) ? 'close'
        : action && !showing('.kit-bar__back') ? 'open' : null;
    swipe = {
      x, y, lastY: y, rtl, target, action, held, slide, taken, drawer, axis: null, done: false, dragging: false, dx: 0,
      pane: null, at: [],
      scroller: taken ? scrollerOf(target) : null,
    };
  }, { passive: false, signal });
  document.addEventListener('touchmove', (ev) => {
    if (!swipe || swipe.done || ev.touches.length !== 1) return;
    const { clientX, clientY } = ev.touches[0];
    const dx = (clientX - swipe.x) * (swipe.rtl ? -1 : 1);
    const dy = clientY - swipe.y;
    if (!swipe.axis && Math.hypot(dx, dy) > 10) swipe.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (swipe.axis === 'y' && swipe.taken) swipe.scroller.scrollTop -= clientY - swipe.lastY;
    swipe.lastY = clientY;
    if (swipe.axis !== 'x') return;
    if (swipe.drawer) {
      if (!swipe.dragging) {
        if (Math.abs(dx) < DRAG_ARM) return;
        // The other way is nothing to do: the closed drawer can't go further in, nor the open one out.
        if ((swipe.drawer === 'open') !== (dx > 0)) {
          swipe.done = true;
          return;
        }
        swipe.dragging = true;
        element.setAttribute('data-drawer-drag', '');
      }
      ev.preventDefault();
      swipe.dx = dx;
      dragDrawer(swipe.drawer, dx, swipe.rtl);
      return;
    }
    if (swipe.pane || (swipe.slide && dx >= DRAG_ARM && startSlide(swipe))) {
      ev.preventDefault();
      swipe.dx = dx;
      swipe.at = [...swipe.at.slice(-4), { dx, time: ev.timeStamp || Date.now() }];
      dragSlide(swipe.pane, dx, swipe.rtl);
      return;
    }
    if (swipe.action && !swipe.slide && dx > 40) {
      swipe.done = true;
      swipe.action();
    } else if (dx < -50 && !swipe.held && element.hasAttribute('data-drawer')) {
      // Beside the views, the drawer a drag brought over them goes back with the same gesture.
      swipe.done = true;
      closeDrawer();
    }
  }, { passive: false, signal });
  document.addEventListener('touchend', () => {
    if (swipe?.dragging) letGoDrawer(swipe, false);
    else if (swipe?.pane) letGoSlide(swipe, false);
    else if (swipe?.taken && !swipe.axis && !swipe.done) tap(swipe.target);
    swipe = null;
  }, { signal });
  document.addEventListener('touchcancel', () => {
    if (swipe?.dragging) letGoDrawer(swipe, true);
    else if (swipe?.pane) letGoSlide(swipe, true);
    swipe = null;
  }, { signal });
  // A finger that picks something up (drag.js) is no longer a swipe nor a tap: the drawer
  // it opens over ☰ must stay, and letting go must not open the row.
  document.addEventListener('kit-dragstart', () => {
    if (swipe?.dragging) letGoDrawer(swipe, true);
    else if (swipe?.pane) letGoSlide(swipe, true);
    swipe = null;
  }, { signal });

  /** How far back the screen beneath starts, as a share of its width: it comes in a little slower. */
  const UNDER_LAG = 0.3;
  /** How long the screen takes to finish going, or to come back, once the finger lifts. */
  const SLIDE_MS = 220;
  /** A flick: the finger went this fast (px/ms) at the end, and far enough to mean it. */
  const FLICK_SPEED = 0.45;
  const FLICK_MIN = 24;

  /** The finger starts to go back: what it moves, drawn by hand from now on. → whether there is one. */
  function startSlide(swipe) {
    const pane = swipe.slide?.();
    if (!pane?.moving) {
      // Nothing to follow: back at once, as before, once the finger has gone far enough.
      swipe.slide = null;
      return false;
    }
    pane.show?.(true);
    pane.width = pane.moving.getBoundingClientRect().width || innerWidth;
    for (const node of [pane.moving, pane.under]) {
      if (node) Object.assign(node.style, { transition: 'none', willChange: 'transform' });
    }
    pane.moving.style.boxShadow = `${swipe.rtl ? 8 : -8}px 0 24px rgba(0, 0, 0, .12)`;
    swipe.pane = pane;
    return true;
  }

  /** The screen where the finger is, and the one beneath a little behind it. */
  function dragSlide(pane, dx, rtl) {
    const at = Math.max(0, Math.min(pane.width, dx));
    const sign = rtl ? -1 : 1;
    pane.moving.style.transform = `translateX(${sign * at}px)`;
    if (pane.under) pane.under.style.transform = `translateX(${-sign * (1 - at / pane.width) * UNDER_LAG * pane.width}px)`;
  }

  /** The finger lifted: all the way back, or the screen returns, from where it is. */
  function letGoSlide(swipe, cancelled) {
    const { pane, dx, at, rtl, action } = swipe;
    const [first, last] = [at[0], at.at(-1)];
    const speed = first && last && last.time > first.time ? (last.dx - first.dx) / (last.time - first.time) : 0;
    const goes = dx >= (cancelled ? CANCEL_COMMIT : commitDistance(pane.width)) || (!cancelled && dx >= FLICK_MIN && speed >= FLICK_SPEED);
    const sign = rtl ? -1 : 1;
    const transition = `transform ${SLIDE_MS}ms cubic-bezier(.2, .7, .3, 1)`;
    for (const node of [pane.moving, pane.under]) if (node) node.style.transition = transition;
    pane.moving.style.transform = goes ? `translateX(${sign * pane.width}px)` : 'translateX(0px)';
    if (pane.under) pane.under.style.transform = goes ? 'translateX(0px)' : `translateX(${-sign * UNDER_LAG * pane.width}px)`;
    // Then the screens as they are, in one go: gone back (or not), and nothing drawn by hand. By a
    // timer, not only transitionend: a page that isn't drawing would leave the screen halfway.
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (goes) action();
      for (const node of [pane.moving, pane.under]) {
        if (node) Object.assign(node.style, { transition: '', willChange: '', transform: '', boxShadow: '' });
      }
      pane.show?.(false);
    };
    pane.moving.addEventListener('transitionend', finish, { once: true, signal });
    setTimeout(finish, SLIDE_MS + 40);
  }

  /** The drawer where the finger is: drawn by hand (no transition) while it leads. */
  function dragDrawer(mode, dx, rtl) {
    const width = side.getBoundingClientRect().width || 300;
    // 0 is open, -width closed, measured from the start edge.
    const offset = mode === 'open' ? Math.max(-width, Math.min(0, -width + dx)) : Math.max(-width, Math.min(0, dx));
    // The kit hides the closed drawer (visibility) and the scrim lets taps through: shown by hand.
    side.style.transform = `translateX(${rtl ? -offset : offset}px)`;
    side.style.visibility = 'visible';
    scrim.style.opacity = String(1 + offset / width);
    scrim.style.pointerEvents = 'auto';
  }

  /** The finger lifted (or was taken away): open or closed by how far it went, from where it is. */
  function letGoDrawer({ drawer: mode, dx }, cancelled) {
    const width = side.getBoundingClientRect().width || 300;
    const enough = Math.abs(dx) >= (cancelled ? CANCEL_COMMIT : commitDistance(width));
    const open = mode === 'open' ? enough : !enough;
    // The click that may come behind the finger would land on the scrim, closing what just opened.
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    document.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 400);
    // Not under the signal: the apps' smoke tests (Tasks) read the two lines above as they are. It
    // goes by itself within 400 ms; destroy() takes away one still waiting.
    swallowing.add(swallow);
    setTimeout(() => swallowing.delete(swallow), 400);
    // The CSS takes over on the next frame, so the slide goes on from where the finger left it;
    // and by a timer too, as a page that isn't drawing would leave the drawer halfway.
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      element.removeAttribute('data-drawer-drag');
      Object.assign(side.style, { transform: '', visibility: '' });
      Object.assign(scrim.style, { opacity: '', pointerEvents: '' });
      if (open) {
        element.setAttribute('data-drawer', '');
        nav.focus({ preventScroll: true });
      } else closeDrawer();
    };
    requestAnimationFrame(settle);
    setTimeout(settle, 80);
  }

  /* --------------------------------- Escape --------------------------------- */
  /*
   * Escape closes the detail open, as its ← or its × would (rule 5 of docs/web-kit.md): whichever
   * shows, so a detail with no × beside its list (`close: false`) stays. Not when something over it
   * had the key as it was pressed (a dialog, a menu, Settings, the drawer, a drag), looked at before
   * anyone answers it (the capture), as each of those closes itself with it; not once something on
   * the way answered it (`preventDefault`: a module's own layer, on itself or capturing); and not
   * from a field or an editor, where Escape keeps its own job and nothing typed is lost. With the
   * focus on no element, only the frame that has the keyboard (`active`: in Work's shell, the
   * window in front); else the one the focus is in. On the document: in Work's shell the window
   * is the page's, and a frame adds nothing to it.
   */
  const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
  // Told nothing, a window of Work's shell has the keyboard while windows.js marks it the one in
  // front (`data-focus` on the window that holds `root`, as `ctx.active` says it): Next passes no
  // `active`, and its Escape and «/» are its window's too. A page of its own always has it.
  const inFront = () => {
    const win = root.closest?.('[data-focus]');
    return win?.getAttribute('data-focus') === 'true' && !win.hidden;
  };
  const hasKeyboard = active || (embedded ? inFront : () => true);
  let covered = false;
  /** Over the frame, with the keys its own: a dialog, a menu, Settings, a drag. */
  const layerOver = () => document.documentElement.hasAttribute('data-kit-dragging')
    || Boolean(document.querySelector('dialog[open], .kit-menu, .kit-settings-page'));
  const coveredNow = () => element.hasAttribute('data-drawer') || layerOver();
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') covered = coveredNow(); }, { capture: true, signal });
  document.addEventListener('keydown', (ev) => {
    const over = covered;
    covered = false;
    if (ev.key !== 'Escape' || over || ev.defaultPrevented || ev.isComposing || element.dataset.screen !== 'detail') return;
    const focus = ev.target?.closest ? ev.target : null;
    if (focus?.closest(EDITABLE)) return;
    const nowhere = !focus || focus === document.body || focus === document.documentElement;
    if (nowhere ? !hasKeyboard() : !element.contains(focus)) return;
    if (!showing('.kit-bar__back, .kit-head__close')) return;
    ev.preventDefault?.();
    (onBack || showList)();
  }, { signal });

  /* ------------------------------ «/» to search ----------------------------- */
  /*
   * «/» goes to the module's search, as in most apps with one, the same in every module (Tasks and
   * Notes had their own, Projects and Next none). Nothing says so: no hint in the field, nor
   * anywhere else. On the document, without Ctrl, ⌘ or Alt (Shift is how some keyboards type it),
   * not while composing, not once something on the way answered it (`preventDefault`), and not from
   * a field or an editor, where it is typed; not with a dialog, a menu, Settings or a drag over the
   * frame either. Its own drawer open is no layer over it: the search is in it. Only the frame that
   * has the keyboard, as Escape: with the focus on no element `hasKeyboard()`, else the one the
   * focus is in. Over a phone's detail the list comes back, where the results show; where the
   * sidebar is a closed drawer or folded away it opens; then the field takes the focus, and the «/»
   * isn't typed in it.
   */
  if (searchField) {
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing || ev.defaultPrevented) return;
      const focus = ev.target?.closest ? ev.target : null;
      if (focus?.closest(EDITABLE) || focus?.isContentEditable || layerOver()) return;
      const nowhere = !focus || focus === document.body || focus === document.documentElement;
      if (nowhere ? !hasKeyboard() : !element.contains(focus)) return;
      ev.preventDefault?.();
      if (element.dataset.screen === 'detail' && getComputedStyle(list).display === 'none') showList();
      if (folded() || drawerIsClosed()) openDrawer({ keyboard: true });
      searchField.focus();
    }, { signal });
  }

  /* --------------------------------- account -------------------------------- */

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

  // Who is signed in is in Settings (the account's section), so the menu doesn't say it.
  const openAccountMenu = (anchor) => toggleMenu(anchor, accountMenuItems());

  /* --------------------------------- modules -------------------------------- */

  // This page's module, when it is one of a host's: its path's single segment.
  const mount = /^\/([a-z][a-z0-9-]{1,30})\/$/.exec(BASE)?.[1] || null;
  let rail = null;
  let switcher = null;
  let switcherIcon = null;   // its arrow, or Settings' icon where it opens them
  let hosted = false;     // drawn as a host's module
  let answered = false;   // the host said (or failed to say) which modules: the rail is known
  let others = [];        // the other modules the person uses, for the switcher's menu
  let calendarPath = null;   // the host's calendar, for the switcher's menu too
  let modulePaths = new Set();   // where each of the host's modules is, for going between them

  /** As a host's module (`on`), or off, as an app on its own. */
  function asModule(on) {
    hosted = on;
    element.toggleAttribute('data-module', on);
    syncSwitcher();
  }

  /**
   * In the installed app, going to another module takes this one's place in the history instead of
   * stacking on it. There is no Back button there, only the system's: on an iPhone a swipe from the
   * screen's edge, the same one that opens the drawer, and a finger that began a few pixels too far
   * in went back to the module used before instead of opening it. Each module is a place of its
   * own, as a tab is in a phone's app. In a browser, with its Back button, the history is as it was.
   */
  /** This module installed as an app of its own: the host's own app is its one-document page. */
  const alone = (host) => installedAlone(host, { embedded });
  if (!embedded) document.addEventListener('click', (ev) => {
    if (FRAMED || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const link = ev.target instanceof Element ? ev.target.closest('a[href]') : null;
    if (!link || link.target === '_blank' || !installed()) return;
    const to = new URL(link.href, window.location.href);
    if (to.origin !== window.location.origin || !modulePaths.has(to.pathname) || to.pathname === window.location.pathname) return;
    ev.preventDefault();
    window.location.replace(to.href);
  }, { capture: true, signal });

  /** Nothing but Settings for the switcher (no other modules, nor the calendar): a tap opens them. */
  const onlySettings = () => direct && !others.length && !calendarPath;

  /**
   * The app's icon and name are the switcher wherever the rail doesn't show: an app on its own, a
   * phone, or where the host didn't answer with one (offline), so Settings is always one tap away.
   * With nothing else to offer it opens Settings, and shows their icon instead of the menu's arrow.
   * Beside the views, under a module's path, it waits for the host's answer, so the rail doesn't
   * come with a switcher that goes.
   */
  function syncSwitcher() {
    // In a frame of the host's split view there is no rail: the view says which module is in it.
    const known = answered || !mount;
    const want = !embedded && Boolean(onSettings || accountItems.length || onSignOut)
      && (FRAMED || !beside() || (known && !rail));
    if (want && !switcher) {
      switcher = el('button', { type: 'button', class: 'kit-side__app' });
      // With the frame's signal: on its own the app draws it with every frame, and destroy() frees it.
      switcher.addEventListener('click', () => {
        if (onlySettings()) {
          closeDrawer();
          onSettings();
          return;
        }
        toggleMenu(switcher, [
          ...others.map((m) => ({ label: m.name, image: m.icon, href: m.path })),
          // The host's calendar, which the rail has where it shows.
          calendarPath ? { label: t('kit.calendar.title'), iconName: 'calendar', href: calendarPath } : null,
          others.length || calendarPath ? 'separator' : null,
          ...accountMenuItems(),
        ].filter(Boolean));
      }, { signal });
      switcherIcon = icon('chevron-down');
      head.prepend(switcher);
      switcher.append(headIcon, headName, switcherIcon);
    } else if (!want && switcher) {
      if (switcher.getAttribute('aria-expanded') === 'true') closeMenu();
      head.prepend(headIcon, headName);
      switcher.remove();
      switcher = null;
      switcherIcon = null;
    }
    if (!switcher) return;
    // The host's answer may bring other modules, or take them away: the button says what it opens.
    const settings = onlySettings();
    if (switcher.dataset.opens === (settings ? 'settings' : 'menu')) return;
    if (switcher.getAttribute('aria-expanded') === 'true') closeMenu();
    switcher.dataset.opens = settings ? 'settings' : 'menu';
    switcher.setAttribute('aria-label', settings ? t('kit.account.settings') : t('kit.modules.switch', { name: app.name }));
    if (settings) {
      switcher.removeAttribute('aria-haspopup');
      switcher.removeAttribute('aria-expanded');
    } else {
      switcher.setAttribute('aria-haspopup', 'menu');
      switcher.setAttribute('aria-expanded', 'false');
    }
    const next = icon(settings ? 'sliders' : 'chevron-down');
    switcherIcon.replaceWith(next);
    switcherIcon = next;
  }

  /** The views of the host's split view (at `page`): this module alone, as now, or two to four at once. */
  function splitMenuItems(page) {
    return SPLIT_LAYOUTS.map((n) => ({
      label: t(`kit.split.layout${n}`), iconName: `layout-${n}`, current: n === 1,
      href: n === 1 ? null : `${page}?layout=${n}&from=${encodeURIComponent(mount)}`,
    }));
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
    // A frame of the host's split view: the view has the modules, and remembers what it shows.
    if (FRAMED) {
      others = [];
      calendarPath = null;
      asModule(true);
      return null;
    }
    // Installed on its own (the host's app is its page at /, not this one): only this module, as an
    // app of its own. No rail and no other modules in the switcher, which keeps the person's menu;
    // it doesn't become the host's module used last either.
    if (alone(host)) {
      others = [];
      calendarPath = null;
      modulePaths = new Set();
      dropRail();
      asModule(true);
      return null;
    }
    // The host's home opens the module used last.
    try { localStorage.setItem('host.module', mount); } catch { /* private mode */ }
    const shown = modules.filter((m) => m.active || m.mount === mount);
    others = shown.filter((m) => m.mount !== mount);
    calendarPath = host.calendar || null;
    modulePaths = new Set(modules.map((m) => new URL(m.path, window.location.href).pathname));
    // With one module too: the rail has Settings, where more are chosen (Settings › Modules).
    const settingsLabel = direct ? t('kit.account.settings') : t('kit.account.menu');
    const next = el('nav', { class: 'kit-rail', 'aria-label': t('kit.modules.rail') },
      // The host's mark, and nothing more: as a link to the page that chooses the modules it only
      // took people out of what they were doing, and the modules are chosen in Settings.
      el('span', { class: 'kit-rail__home', role: 'img', 'aria-label': host.name || t('kit.modules.rail') },
        host.icon ? el('img', { src: host.icon, alt: '', width: 32, height: 32 }) : icon('grid')),
      ...shown.map((m) => el('a', {
        class: 'kit-rail__module', href: m.path, title: m.name, 'aria-current': m.mount === mount ? 'page' : null,
        style: m.color ? `--module: ${m.color}` : null,
      }, el('img', { src: m.icon, alt: '', width: 28, height: 28 }), el('span', { class: 'kit-rail__name', text: m.name }))),
      // The calendar, where the host has one: its own page, with what has a date in every module.
      host.calendar ? el('a', {
        class: 'kit-rail__calendar', href: host.calendar, title: t('kit.calendar.title'), 'aria-label': t('kit.calendar.title'),
      }, icon('calendar')) : null,
      // The split view, where the host has one: this module alone (now), or two to four at once.
      host.split ? el('button', {
        type: 'button', class: 'kit-rail__split', title: t('kit.split.title'), 'aria-label': t('kit.split.title'),
        'aria-haspopup': 'menu', 'aria-expanded': 'false',
        onClick: (ev) => toggleMenu(ev.currentTarget, splitMenuItems(host.split)),
      }, icon('layout-2')) : null,
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
  async function refreshModules({ fresh = true } = {}) {
    if (!mount || embedded) return null;
    try {
      const { status, answer } = await hostModules({ fresh });
      if (status === 404) {   // no host there: an app on its own under a path
        try { localStorage.removeItem(RAIL_KEY); } catch { /* private mode */ }
        applyLook(null);
        dropRail();
        return asModule(false);
      }
      // A frame destroyed while the host was asked has no rail to paint, nor a module to remember.
      if (destroyed || !answer) return null;
      try { localStorage.setItem(RAIL_KEY, JSON.stringify(answer)); } catch { /* private mode, full */ }
      if (toHostShell(answer)) return null;
      // The look the person chose, from any device: painted now and kept for the next page.
      if ('look' in answer) applyLook(answer.look);
      paintFounder(answer);
      return paintRail(answer);
    } catch {
      return null;   // offline: the rail stays as it was
    } finally {
      answered = true;
      if (!destroyed) syncSwitcher();
    }
  }
  /**
   * In the app, a module's page on its own leaves for the host's one-document page with itself in
   * a window (native.js hostShellAddress): what a notice tapped on the phone opens is the module's
   * address. From the host's answer of last time at once, else from the one that comes. → whether
   * it is leaving.
   */
  let leaving = false;
  function toHostShell(answer) {
    if (leaving) return true;
    const away = embedded ? null : hostShellAddress(answer?.host);
    if (!away) return false;
    leaving = true;
    window.location.replace(away);
    return true;
  }

  // In Work's shell a module of a host, and nothing more: the rail, the look, the founder's notice and
  // the modules turned on or off are the shell's, asked and drawn once for the page.
  if (embedded) asModule(true);
  // An app on its own, at its site's root: the app's icon opens Settings from the start.
  else if (!mount) syncSwitcher();
  else {
    // Under a module's path it is a host's, almost surely: as one from the start, so a switcher
    // beside the views doesn't show and go once the host answers with the rail.
    asModule(true);
    // The rail of last time at once, with the frame: coming from another module it is the same,
    // and drawn only once the host answered it came in late, pushing the sidebar aside. The
    // answer, when it comes, draws it again.
    let last = null;
    try { last = JSON.parse(localStorage.getItem(RAIL_KEY) || 'null'); } catch { /* none, or not JSON */ }
    if (!toHostShell(last)) {
      if (Array.isArray(last?.modules) && last.modules.some((m) => m?.mount === mount)) paintRail(last);
      refreshModules({ fresh: false });
    }
    // A phone turned, a window made narrower: the rail shows or not, and the switcher with it.
    window.addEventListener('resize', syncSwitcher, { signal });
    // Back to the page, the host is asked again; in a frame of the split view the view has the rail, not the frame.
    if (!FRAMED) document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshModules(); }, { signal });
    document.addEventListener('kit-modules', () => refreshModules(), { signal });
    // A look chosen in another tab, or in another frame of the split view: this page follows at once.
    window.addEventListener('storage', (ev) => {
      // Closed in another tab, or another frame of the split view: gone here too.
      if (ev.key === FOUNDER_KEY) hideBanner('founder-offer');
      if (ev.key !== LOOK_KEY) return;
      if (ev.newValue === 'clean') document.documentElement.setAttribute('data-look', 'clean');
      else document.documentElement.removeAttribute('data-look');
    }, { signal });
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

  /**
   * A founder, once the early access is over and while their price lasts (the host's GET
   * /api/modules, `founder_offer`): thanks, the news, and until when, with a way to the plan. Closed,
   * it stays closed on this device for that date.
   */
  function paintFounder({ founder_offer: offer = null, host = {} } = {}) {
    let closedFor = null;
    try { closedFor = localStorage.getItem(FOUNDER_KEY); } catch { /* private mode: shown each time */ }
    if (!offer?.until || closedFor === offer.until) {
      hideBanner('founder-offer');
      return;
    }
    if (shown.has('founder-offer')) return;
    showBanner('founder-offer', {
      kind: 'info', iconName: 'spark',
      text: t('kit.founder.notice', { app: host.name || app.name, date: lastDay(offer.until) }),
      action: onSettings ? { label: t('kit.founder.see'), onClick: () => onSettings('plan') } : null,
      onClose: () => { try { localStorage.setItem(FOUNDER_KEY, offer.until); } catch { /* private mode */ } },
    });
  }

  // Back from the host's checkout (Settings › Plan in a module): thanks, and the plan read again
  // until it arrives. Only a host's module comes back to its own path with `?billing=`.
  if (mount && !FRAMED && !embedded) billingReturn({ open: onSettings ? () => onSettings('plan') : null });

  /** 'open', 'connecting' or 'closed': the dot next to the app's name. */
  function setLive(state) {
    live.dataset.state = state;
    live.title = t(`kit.live.${state}`);
    live.setAttribute('aria-label', t(`kit.live.${state}`));
  }

  /* -------------------------------- teardown -------------------------------- */

  /**
   * The frame taken down whole, for an app that draws it again (Focus after a new language, Tracker
   * closing its frame) without reloading the page: its listeners on the document and the window
   * go, an account or modules menu it opened closes, and its DOM leaves the page, so nothing
   * holds the old frame and it can be collected. Twice, or after the page let it go, it does
   * nothing. What the app hung on the frame's nodes itself goes with them.
   */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    listening.abort();
    for (const swallow of swallowing) document.removeEventListener('click', swallow, { capture: true });
    swallowing.clear();
    swipe = null;
    // The menu lives in the page's body, not in the frame: only the one this frame opened.
    if (element.querySelector('[aria-haspopup="menu"][aria-expanded="true"]')) closeMenu();
    element.remove();
  }

  /* ---------------------------------- heads --------------------------------- */

  /**
   * A view's head, the same in every app: its title and, at its end, the app's «…» (ui.js
   * moreButton), which holds every action of the view; wherever the sidebar isn't beside the views
   * (a phone, or folded away), ☰ at its start, and over a phone's detail ← instead. A detail's head
   * (rule 5 of docs/web-kit.md) has ← where its list is a screen of its own and, last, × where the
   * list is beside it (kit.css): both, and Escape, close it the same way (`onBack`). Nothing that
   * creates: that is the floating button, at every width. A pane showing one takes the bar's place
   * (kit.css): one line less, and each view laid out alike in every app and on any screen. The app
   * puts it at the top of its view, and makes a new one when it draws the view again.
   *
   * @param {object} [options]
   * @param {'list'|'detail'} [options.pane]  the pane it heads: ☰ over a list, ← (and ×) over a detail
   * @param {string|null} [options.title]   null: none, where the view says it itself (a note's first line)
   * @param {Node|Node[]} [options.lead]      before the title (a list's icon, a note's notebook)
   * @param {Node|Node[]} [options.actions]   after it, at the end: the item's toggles (Notes' pin) and «…»
   * @param {Node} [options.below]            under the line, in the head (a search, chips, a toolbar)
   * @param {boolean} [options.close]         false: a detail with no ×, one that must not close beside its list
   */
  function viewHead({ pane = 'list', title: text = '', lead = null, actions: own = [], below = null, close = true } = {}) {
    const heading = text === null ? el('span', { class: 'kit-head__title' }) : el('h1', { class: 'kit-head__title', text });
    let start = null;
    if (pane === 'detail') start = backToggle();
    else {
      start = menuToggle();
      titleMenu(start);
    }
    const end = pane === 'detail' && close ? closeToggle() : null;
    const node = el('header', { class: 'kit-head', 'data-pane': pane },
      el('div', { class: 'kit-head__row' }, start, lead, heading, el('div', { class: 'kit-head__actions' }, own), end),
      below);
    return { element: node, setTitle: (value) => { if (text !== null) heading.textContent = value || ''; } };
  }

  // Inside the suite's app on a phone, the page is drawn and listens: the app's bridge (native.js), once a
  // page, which in Work's shell is the shell's to say.
  if (!embedded) nativeReady();

  return {
    element, nav, list, detail, actions, banners, head: viewHead, search: searchField,
    foot: footer ? { element: footer, create: add, trash } : null,
    get screen() { return element.dataset.screen; },
    showList, showDetail, openDrawer, closeDrawer, toggleDrawer,
    get folded() { return folded(); },
    setTitle: (text) => { title.textContent = text || ''; },
    setUser: (next) => { user = next; },
    setLive, showBanner, hideBanner, refreshModules, destroy,
  };
}

/* ------------------------------ sidebar pieces ------------------------------ */

/** A heading between groups of the sidebar ("Notebooks", "Tags"). */
export const navSection = (label) => el('div', { class: 'kit-nav__section', text: label });

/**
 * A group of the sidebar that folds under its heading ("Tags"), sliding: the heading, with a
 * chevron, folds and unfolds it, and the choice is kept on the device under `key`. `open` is how
 * it starts until one is made; `keep` unfolds it whatever was chosen (the entry open is in it).
 * Folding isn't going anywhere: the drawer stays open. → the group; its entries go in `children`.
 */
export function navFold({ label, key, open = false, keep = false, children = [] }) {
  let chosen = null;
  try { chosen = localStorage.getItem(key); } catch { /* private mode */ }
  const unfolded = keep || (chosen ? chosen === 'open' : open);
  const body = el('div', { class: 'kit-nav__fold-body', hidden: !unfolded }, children);
  const heading = el('button', {
    type: 'button', class: 'kit-nav__section kit-nav__fold', 'aria-expanded': String(unfolded),
    onClick: (ev) => {
      ev.stopPropagation();
      const now = heading.getAttribute('aria-expanded') !== 'true';
      heading.setAttribute('aria-expanded', String(now));
      slideHidden(body, !now);
      try { localStorage.setItem(key, now ? 'open' : 'folded'); } catch { /* private mode */ }
    },
  }, el('span', { text: label }), icon('chevron', { className: 'kit-nav__fold-chevron' }));
  return el('div', { class: 'kit-nav__group' }, heading, body);
}

/** `{ drop: '', notebookId: 7 }` as data-* attributes: `data-drop`, `data-notebook-id`. */
const dataAttributes = (data) => Object.fromEntries(Object.entries(data || {})
  .map(([key, value]) => [`data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value]));

/**
 * A group of the sidebar's collections (Tasks' lists, Notes' notebooks), the same in every module:
 * a head in the group's `color`, and under it its collections (`children`) a step in, or `empty`
 * saying there are none. The chevron folds it, sliding, and tells `onToggle(open)`: the module keeps
 * the choice its own way. `keep` opens it whatever `open` says (the collection open is in it);
 * folded, the head shows `count`. The name opens the group's menu, `onName(event, name)`, where a
 * new collection in the group is too; without it, the name folds the group as the chevron does.
 * Neither closes the drawer: folding or opening a menu isn't going anywhere. `icon` (an emoji, or a
 * node) or `iconName` (the kit's) go before the name, `extra` after it (a badge: shared). `data`,
 * `headData` and `bodyData` become data-* attributes of the group, its head and its body, for the
 * module's drags (drag.js): what picks it up, what takes a collection dropped on it. → the group.
 */
export function navGroup({
  name, color = null, icon: glyph = null, iconName = null, count = null, open = true, keep = false,
  onToggle = null, onName = null, empty = '', extra = null, data = null, headData = null, bodyData = null,
  children = [],
}) {
  const unfolded = keep || open;
  const kept = [children].flat(Infinity).filter(Boolean);
  const body = el('div', { class: 'kit-nav-group__body', hidden: !unfolded, ...dataAttributes(bodyData) },
    kept.length ? kept : empty ? el('div', { class: 'kit-nav-group__empty', text: empty }) : null);
  const total = count ? el('span', { class: 'kit-nav__count', text: String(count), hidden: unfolded }) : null;
  const toggle = el('button', {
    type: 'button', class: 'kit-nav-group__toggle',
    onClick: (ev) => {
      ev.stopPropagation();
      fold();
    },
  }, icon('chevron'));
  /** The chevron says what it does next: fold the group, or unfold it. */
  const paint = (now) => {
    const words = t(now ? 'kit.side.groupFold' : 'kit.side.groupUnfold', { name });
    toggle.setAttribute('aria-expanded', String(now));
    toggle.setAttribute('aria-label', words);
    toggle.setAttribute('title', words);
  };
  paint(unfolded);
  const fold = () => {
    const now = toggle.getAttribute('aria-expanded') !== 'true';
    paint(now);
    slideHidden(body, !now);
    total?.toggleAttribute('hidden', now);
    onToggle?.(now);
  };
  const press = (ev) => (onName ? onName(ev, label) : fold());
  // Not a <button>: the group is picked up by its head (drag.js starts on no button), and the name
  // is most of it. Enter and Space press it, as they would a button.
  const label = el('span', {
    class: 'kit-nav-group__name', role: 'button', tabindex: '0',
    ...(onName ? { 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: t('kit.side.groupOptions', { name }) } : {}),
    onClick: (ev) => {
      ev.stopPropagation();
      press(ev);
    },
    onKeydown: (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      press(ev);
    },
  },
  iconName || glyph ? el('span', { class: 'kit-nav-group__icon', 'aria-hidden': 'true' }, iconName ? icon(iconName) : glyph) : null,
  el('span', { class: 'kit-nav-group__label', text: name }),
  extra);
  return el('div', { class: 'kit-nav-group', style: color ? `--group-color: ${color}` : null, ...dataAttributes(data) },
    el('div', { class: 'kit-nav-group__head', ...dataAttributes(headData) }, toggle, label, total),
    body);
}

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
    ...dataAttributes(data),
  };
  const children = [
    color ? el('span', { class: 'kit-nav__swatch', style: `background:${color}` }) : iconName ? icon(iconName) : null,
    el('span', { class: 'kit-nav__label', text: label }),
    count != null ? el('span', { class: 'kit-nav__count', text: String(count) }) : null,
  ];
  return href ? el('a', { ...props, href }, children) : el('button', { ...props, type: 'button' }, children);
}

/**
 * Marks one entry of the sidebar as the current one: one of `nav`'s, or the trash at its foot
 * (`shell.foot.trash`, a view of its own in Notes). Null marks none.
 */
export function setCurrent(nav, item) {
  const side = nav.closest?.('.kit-side') || nav;
  for (const node of side.querySelectorAll('.kit-nav__item, .kit-side__trash')) {
    if (node === item) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  }
}
