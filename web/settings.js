/**
 * Settings, the same in every app: a list of sections —on a phone, each one
 * a screen of its own— with what every account has (profile, language and
 * theme, password and sign-in, the AI where there is an MCP, notifications, plan, data, about) and
 * the app's own sections among them. Taken from Next's, on the suite's
 * routes: /api/me/*, /api/auth/*, /api/push/*.
 *
 *   openSettings({
 *     app: { id: 'notes', name: 'Notes', icon: '/icons/favicon.svg', tagline: tagline },
 *     user, config,                       // /api/auth/me's user, /api/auth/config
 *     live, updates,                      // from connectLive() and watchUpdates(), for About
 *     sections: [{ id: 'notes', label: sectionLabel, hint: …, iconName: 'notes', render: ({ close }) => node }],
 *     onUser: (user) => { state.user = user; },   // the account changed here
 *     onSignOut: () => signOut({ local }),
 *     applyTheme,                         // (theme) → paint it now
 *     setLanguage,                        // async (lang) → load the catalog and repaint the app
 *   });
 *
 * The profile is saved with PATCH /api/me (the app's: what it keeps of a
 * person, its preferences, is its own), with display_name, email, theme and
 * prefs.lang, as Next does.
 *
 * `shareNote`: what the app does with what the person shares with others when
 * their data or their account goes ("Your shared lists pass to…"), said in
 * Your data before they confirm.
 *
 * `plan`: true shows the plan and until when; `{ billing: true }` adds what
 * can be bought, "Upgrade" and "Change or cancel plan" where the server sells
 * (plan.js), and `hideCheckout: true` leaves those out again for a native
 * app's web view; `open()`, the app's own way to buy that a 402 met here
 * offers instead of the plan section (with hideCheckout, the only one);
 * `render(answer)` adds the app's own block. In a host that sells
 * (`app.host.billing`) every module's plan section sells too, as if it had
 * passed `{ billing: true }`: the plan is the host's, the same in all of them.
 *
 * Inside the suite's app on a phone (native.js) the plan is always shown as
 * `hideCheckout`, whatever the module passed: the stores' rules keep the web's
 * payments out of the app. Where the app sells (its 'purchase'), a plan's
 * barrier offers its store and the plan section has a way to it; where it
 * doesn't, only the reason. Notifications there are the app's: no Web Push,
 * and a way to the app's own settings.
 *
 * `standing`: the key, in the app's catalog, of the instruction to paste into
 * an assistant's own instructions. Your AI shows it, folded under the app's
 * name, with a way to copy it; in a host, one fold for each module in use. In
 * a host that builds one prompt for its modules (`/api/modules`' host
 * `aiInstruction`, createHost's), Your AI instead has a chip for each agent
 * with its steps (agents.js) and that prompt for the modules ticked, and each
 * module's `standingMore` under it.
 * `standingMore`: what goes under it, keys of the catalog (a paragraph each)
 * and pairs of keys (a line of a list: a label in bold, then its text).
 * `site`: the app's website, which About links to in a host.
 *
 * In a host (Cronum Work) Settings are one for the whole app, the same list
 * in every module: the account's sections, a group for each module in use and
 * the host's last (hostSections below). The module open draws its own; another
 * module's are named from the host's list and drawn there (`?settings=`,
 * settingsAsked()). About is the whole app's there: a card for the host and
 * one for each module, with its version.
 *
 * The list folds by group, one open at a time, so it stays short: the group
 * of the section open, or none on a phone until one is chosen.
 */
import { el, clear, append } from './dom.js';
import { t, formatDateTime, currentLanguage, listFormat, shareLanguage } from './i18n.js';
import { api, errorMessage } from './api.js';
import { at, FRAMED, SETTINGS_SHOWN_EVENT, SETTINGS_GOTO_EVENT, LOOKS, applyLook } from './base.js';
import { icon } from './icons.js';
import { toast, field, segmented, switchRow, confirmDialog, openDialog, signature, copyText, holdBack, slideHidden, slidingDetails, menu } from './ui.js';
import { makeDraggable } from './drag.js';
import { planPayments, offerPlan, storePurchase, PLAN_EVENT } from './plan.js';
import { usageGroups, atLimit } from './usage-view.js';
import { inApp, can, onNative, lastNative, openAppSettings, nativeInfo, openExternal } from './native.js';
import { hostWorker, workerRegistration, noticesToRenew, noticesRenewed } from './worker.js';
import { agentChips, agentSteps, aiPrompt } from './agents.js';
import { markOwned, workRegistry } from './mount.js';
import { leave } from './signin.js';
import { celebratePrefs, setCelebratePref, celebrate } from './celebrate.js';

const LANGUAGE_NAMES = { en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano' };

const block = (title, ...children) => el('section', { class: 'kit-settings__block' },
  title ? el('h3', { text: title }) : null, ...children);
const hint = (text) => el('p', { class: 'kit-hint', text });
const row = (...children) => el('div', { class: 'kit-row' }, ...children);
const button = (text, onClick, kind = '') => el('button', {
  type: 'button', class: `kit-btn kit-btn--small${kind ? ` kit-btn--${kind}` : ''}`, text, onClick,
});
const showError = (err) => toast(errorMessage(err), { error: true });
const input = (props) => el('input', { class: 'kit-input', ...props });

/** A section's id, as `?settings=` names it (host.js moduleSettings). */
const SECTION_ID = /^[a-z][a-z0-9-]{0,40}$/;

/**
 * The modules or the calendar turned on or off: this page's rail and Linked rows ask again
 * (shell.js, links.js), and so does the page that frames it, when one does (Cronum Work's shell
 * with a module in a frame, the split view).
 */
function modulesChanged() {
  document.dispatchEvent(new CustomEvent('kit-modules'));
  if (!FRAMED) return;
  try {
    window.parent.document.dispatchEvent(new window.parent.CustomEvent('kit-modules'));
  } catch { /* the page that framed it went */ }
}

/**
 * How this device installs a web app, for Settings › Modules' steps: 'ios' (an iPhone or an iPad,
 * the suite's app on one too: Share › Add to Home Screen), 'android', 'mac-safari' (File › Add to
 * Dock), 'firefox' (on a computer it installs none) or 'desktop' (the install button of the address
 * bar, Chrome's and Edge's).
 */
export function installKind(win = globalThis.window) {
  const native = nativeInfo(win)?.platform;
  if (native === 'ios' || native === 'android') return native;
  const nav = win?.navigator || {};
  const agent = String(nav.userAgent || '');
  // iPadOS says it is a Mac; a Mac with a touch screen is an iPad.
  if (/iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && nav.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(agent)) return 'android';
  if (/Firefox\//.test(agent)) return 'firefox';
  if (/Macintosh/.test(agent) && /Version\/[\d.]+.*Safari\//.test(agent) && !/Chrome|Chromium|Edg\//.test(agent)) return 'mac-safari';
  return 'desktop';
}

/** The host's last answer of its modules that the frame keeps (shell.js RAIL_KEY), or none. */
function hostModulesKept() {
  try {
    const kept = JSON.parse(localStorage.getItem('host.modules') || 'null');
    return Array.isArray(kept?.modules) ? kept : { modules: [] };
  } catch {
    return { modules: [] };   // private mode, or not JSON
  }
}

/**
 * Another module's words, for naming its sections of Settings here: its catalog in `lang`
 * (`/<module>/i18n/<lang>.json`), asked for once per page and kept. → the words; undefined while
 * they are on their way (`then` is called when they come); null when they couldn't be had, which
 * is asked again the next time Settings opens.
 */
const moduleCatalogs = new Map();
function moduleWords(m, lang, then) {
  const key = `${m.mount}:${lang}`;
  const known = moduleCatalogs.get(key);
  if (known instanceof Promise) {
    known.then(then);
    return undefined;
  }
  if (known) return known;
  if (known === null) {
    moduleCatalogs.delete(key);
    return null;
  }
  const asking = fetch(`${m.path}i18n/${lang}.json`, { credentials: 'same-origin' })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null)
    .then((words) => {
      moduleCatalogs.set(key, words && typeof words === 'object' ? words : null);
    });
  moduleCatalogs.set(key, asking);
  asking.then(then);
  return undefined;
}

/**
 * The section of Settings this page was opened for (`?settings=<id>`): another module's Settings
 * sent the person here, to one of this module's sections. Taken off the address, so going back or
 * reloading doesn't open Settings again. A module opens its Settings on it once it has started:
 *
 *   const asked = settingsAsked();
 *   if (asked) settings(asked);
 */
export function settingsAsked(win = globalThis.window) {
  try {
    const url = new URL(win.location.href);
    const id = url.searchParams.get('settings');
    if (id === null) return null;
    url.searchParams.delete('settings');
    win.history.replaceState(win.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    return SECTION_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Opens Settings over the app. Returns { close, show(sectionId) }.
 */
export function openSettings(options) {
  const {
    app, config = {}, sections = [], onSignOut = null, root = document.body, start = null,
  } = options;
  const state = { user: options.user };
  const setUser = (user) => {
    state.user = user;
    options.onUser?.(user);
  };
  const provider = state.user?.auth_provider || config.provider || 'local';
  const local = provider === 'local';
  const modules = config.app?.modules || {};
  // A module of a host (Cronum Work): the person chooses which modules they use.
  const host = config.app?.host || null;
  // Deleting one's own account: how many days it waits before it goes (none: the install doesn't offer it).
  const deletionDays = config.deletion_days ?? null;
  // What the plan section sells (plan.js): only when the app asks for it, or in a host when the host
  // sells (the same in every module), and the server doesn't say it can't.
  const planOptions = options.plan && typeof options.plan === 'object' ? options.plan : {};
  const selling = (planOptions.billing === true || host?.billing === true) && modules.billing !== false;
  // Inside the suite's app the web's checkout never shows (the stores' rules), whatever the module passed.
  const inTheApp = inApp();
  const hideCheckout = planOptions.hideCheckout === true || inTheApp;
  // The app's own store, where the app sells and so does this install: its way to buy here.
  const store = inTheApp && can('purchase') && Boolean(options.plan || host?.plans) && modules.billing !== false;
  // Where it sells, a plan's barrier met here offers a way to buy: the app's own (`plan.open`, a native
  // app's store) when it gives one, else the plan section, unless that sells nothing here (hideCheckout).
  // Inside the suite's app, its store, or only the reason. Elsewhere a notice, as always.
  const openPlan = inTheApp ? (store ? () => storePurchase() : null)
    : !selling ? null
      : typeof planOptions.open === 'function' ? planOptions.open
        : hideCheckout ? null : () => show('plan');
  const fail = (err) => (openPlan && offerPlan(err, { open: openPlan })) || showError(err);
  // What Settings listens to while it is open, let go when it closes.
  const cleanups = [];
  // The host's modules, with the ones this person uses (GET /api/modules): the last answer the
  // frame kept (shell.js), at once, and the server's when it comes. With them, what the host is
  // (its name and icon, for About).
  const kept = host ? hostModulesKept() : { modules: [] };
  let inUse = kept.modules;
  let hostInfo = kept.host || {};
  // How an assistant gets the host's tools ('door': some on demand; 'all'), when the host keeps some on demand.
  let aiTools = kept.ai_tools || null;
  // What is drawn from the modules in use, drawn again when the server's answer comes.
  const onModules = [];
  let closed = false;

  /* -------------------------------- sections -------------------------------- */

  // What every account has. In a host (Cronum Work) these are the same in every module: notices
  // and the plan are the host's to say, not each module's.
  const common = () => [
    { group: t('kit.settings.groups.account'), id: 'profile', iconName: 'user', label: t('kit.profile.title'),
      hint: () => [state.user?.display_name, state.user?.email].filter(Boolean).join(' · '), render: () => profile() },
    // The password and two-step verification are the account's, next to who it is.
    { group: t('kit.settings.groups.account'), id: 'security', iconName: 'shield', label: t('kit.security.title'),
      hint: () => t(local || provider === 'workos' ? 'kit.security.hint' : 'kit.security.hintProvider'), render: () => security() },
    host ? { group: t('kit.settings.groups.account'), id: 'modules', iconName: 'grid', label: t('kit.modules.title'),
      hint: () => inUse.filter((m) => m.active).map((m) => m.name).join(' · ') || t('kit.modules.hint'), render: () => moduleChoice() } : null,
    { group: t('kit.settings.groups.account'), id: 'appearance', iconName: 'globe', label: t('kit.appearance.title'),
      hint: () => `${LANGUAGE_NAMES[currentLanguage()] || currentLanguage()} · ${t(`kit.appearance.theme.${state.user?.theme || 'system'}`)}`,
      render: () => appearance() },
    // The plan is the account's: what it is and what it includes, with the account's other things.
    options.plan || host?.plans ? { group: t('kit.settings.groups.account'), id: 'plan', iconName: 'card', label: t('kit.plan.title'),
      hint: () => t('kit.plan.hint'), render: () => plan() } : null,
    // In a host, deleting the account (every module's) is the account's too, last. An app on its
    // own says it in Your data, with its data.
    host && deletionDays != null ? { group: t('kit.settings.groups.account'), id: 'account', iconName: 'trash', label: t('kit.data.deleteTitle'),
      hint: () => t('kit.settings.accountHint', { app: host.name }), render: () => data({ module: false }) } : null,
    // Only where there is an AI connector to set up; a server from before the flag says nothing and keeps it.
    modules.mcp !== false ? { group: t('kit.settings.groups.connections'), id: 'ai', iconName: 'spark', label: t('kit.ai.title'),
      hint: () => t('kit.ai.hint'), render: () => ai() } : null,
    options.push || host?.push ? { group: t('kit.settings.groups.connections'), id: 'notifications', iconName: 'bell', label: t('kit.notifications.title'),
      hint: () => t('kit.notifications.hint'), render: () => notifications() } : null,
    // The devices and browsers signed in to the account, with the other things connected to it.
    { group: t('kit.settings.groups.connections'), id: 'sessions', iconName: 'device', label: t('kit.security.sessions'),
      hint: () => t('kit.sessions.hint'), render: () => sessionsBlock() },
  ];
  const own = (group) => sections.map((section) => ({ group, ...section, hint: typeof section.hint === 'function' ? section.hint : () => section.hint || '' }));
  const admin = (group) => (state.user?.role === 'admin'
    ? { group, id: 'admin', iconName: 'shield', label: t('kit.admin.title'), hint: () => t('kit.admin.hint'), href: '/admin' } : null);

  /** An app on its own: the account's sections, then the app's, its data, administration and about. */
  const appSections = () => [
    ...common(),
    ...own(app.name),
    modules.data || deletionDays != null
      ? { group: app.name, id: 'data', iconName: 'box', label: t('kit.data.title'), hint: () => t(modules.data ? 'kit.data.hint' : 'kit.data.hintDelete'), render: () => data() }
      : null,
    admin(app.name),
    { group: app.name, id: 'about', iconName: 'info', label: t('kit.about.title', { app: app.name }), hint: () => t('kit.about.hint', { app: app.name }), render: () => about() },
  ];

  /**
   * A module of a host: one Settings for the whole app, the same list in every module. The
   * account's sections, deleting it (every module's) among them; then a group for each module the
   * person uses, in the host's order, with that module's own sections and its data; last the
   * host's: administration and about the whole app. This module draws its own sections here;
   * another's are named here and drawn in that module (goTo).
   */
  const hostSections = () => [
    ...common(),
    ...modulesHere().flatMap((m) => (m.mount === host.mount ? thisModule() : otherModule(m))),
    admin(host.name),
    { group: host.name, id: 'about', iconName: 'info', label: t('kit.about.title', { app: host.name }), hint: () => t('kit.about.hostHint'), render: () => about() },
  ];

  /** The host's modules this person uses, in the host's order, and always the one open here. */
  function modulesHere() {
    const shown = inUse.filter((m) => m.active || m.mount === host.mount);
    return shown.some((m) => m.mount === host.mount) ? shown : [{ mount: host.mount }];
  }

  /**
   * This module's group: its sections, drawn here. What it adds to Your AI is out of the list when
   * Your AI has its instruction (`standing`), and what it is always (About has its card): both are
   * still opened from there.
   */
  const thisModule = () => [
    ...own(app.name),
    modules.data ? { group: app.name, id: 'data', iconName: 'box', label: t('kit.data.title'),
      hint: () => t('kit.settings.dataHint', { app: app.name }), render: () => data({ account: false }) } : null,
    options.aiExtra ? { group: app.name, id: 'ai-extra', iconName: 'spark', label: t('kit.settings.moduleAi'), unlisted: Boolean(options.standing),
      hint: () => t('kit.settings.moduleAiHint', { app: app.name }), render: () => [options.aiExtra()] } : null,
    options.aboutExtra ? { group: app.name, id: 'about-extra', iconName: 'info', label: t('kit.about.title', { app: app.name }), unlisted: true,
      hint: () => t('kit.settings.moduleAboutHint', { app: app.name }), render: () => [options.aboutExtra()] } : null,
  ];

  /**
   * Another module's group: its sections as the host lists them (host.js moduleSettings), named
   * in this language from its own catalog. Choosing one goes there, with Settings open on it.
   */
  function otherModule(m) {
    const declared = m.settings;
    if (!declared || !m.path) return [];
    const words = moduleWords(m, currentLanguage(), () => { if (!closed) repaint(); });
    if (words === undefined) return [];   // on its way: painted when it comes
    const go = (id, iconName, label, text = '') => ({
      group: m.name, id: `${m.mount}:${id}`, iconName, label, hint: () => text, go: () => goTo(m, id),
    });
    // Without its words (offline, say), one way into its Settings all the same.
    if (words === null) {
      const first = declared.sections[0]?.id || (declared.data ? 'data' : null);
      return first ? [go(first, 'sliders', t('kit.settings.moduleOpen', { app: m.name }))] : [];
    }
    const say = (key) => (key && typeof words[key] === 'string' ? words[key] : '');
    // Its instruction is in Your AI, and what it is in About's card: there they are opened from.
    return [
      ...declared.sections.filter((s) => say(s.label)).map((s) => go(s.id, s.icon || 'sliders', say(s.label), say(s.hint))),
      declared.data ? go('data', 'box', t('kit.data.title'), t('kit.settings.dataHint', { app: m.name })) : null,
      declared.ai && !declared.standing ? go('ai-extra', 'spark', t('kit.settings.moduleAi'), t('kit.settings.moduleAiHint', { app: m.name })) : null,
    ];
  }

  /**
   * To another module's section: there, with Settings open on it (`?settings=`, settingsAsked()).
   * In a frame of the host's split view, the view opens it in the frame that shows that module, if
   * one does (`kit:settings-goto`), so the view stays; otherwise the whole window goes. In Work's
   * shell, the same event on this window: the shell opens it in that module's window, and the page
   * stays.
   */
  function goTo(m, id) {
    const address = `${m.path}?settings=${encodeURIComponent(id)}`;
    if (FRAMED) {
      const detail = { mount: m.mount, start: id, source: window, handled: false };
      close();
      try {
        window.parent.dispatchEvent(new window.parent.CustomEvent(SETTINGS_GOTO_EVENT, { detail }));
      } catch { /* the view went */ }
      if (!detail.handled) window.top.location.assign(address);
      return;
    }
    if (workRegistry()) {
      const detail = { mount: m.mount, start: id, source: window, handled: false };
      close();
      window.dispatchEvent(new CustomEvent(SETTINGS_GOTO_EVENT, { detail }));
      if (detail.handled) return;
    }
    window.location.assign(address);
  }

  const sectionsNow = () => (host ? hostSections() : appSections()).filter(Boolean);
  let all = sectionsNow();
  /** The list again, with what is known now: the modules in use, another module's words. */
  function repaint() {
    all = sectionsNow();
    paintList();
    // The groups that came in above may have pushed the open section out of sight.
    reveal();
  }
  if (host) {
    fetch('/api/modules', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((answer) => {
        if (closed || !Array.isArray(answer?.modules)) return;
        inUse = answer.modules;
        hostInfo = answer.host || hostInfo;
        aiTools = answer.ai_tools || null;
        repaint();
        for (const paint of onModules) paint();
      })
      .catch(() => { /* offline: the modules of last time */ });
  }

  /* ---------------------------------- frame --------------------------------- */

  const list = el('nav', { class: 'kit-settings__list', 'aria-label': t('kit.settings.title') });
  const page = el('div', { class: 'kit-settings__page', tabindex: '-1' });
  const frame = el('div', { class: 'kit-settings' }, el('div', { class: 'kit-settings__grid' }, list, page));
  const title = el('h1', { class: 'kit-settings-page__title', text: t('kit.settings.title') });
  const backButton = el('button', { type: 'button', class: 'kit-icon-btn', 'aria-label': t('kit.back'), onClick: () => back() }, icon('back'));
  const scroller = el('div', { class: 'kit-settings-page__body' }, frame);
  const overlay = el('div', { class: 'kit-settings-page', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('kit.settings.title') },
    el('header', { class: 'kit-settings-page__bar' }, backButton, title), scroller);
  // In Work's shell they are the whole app's, over every window, whatever `root` the module gave: a
  // window keeps what it holds inside it (windows.css `contain`). On the page's body it says whose it
  // is, so the module's sheet reaches it (mount.js).
  const place = workRegistry() ? document.body : root;
  place.append(place === document.body ? markOwned(overlay) : overlay);
  // A swipe from the screen's start edge goes back as the bar's ← does: to the list, then out (shell.js).
  // The screen follows the finger: a section on a phone uncovers the list beneath it, where the
  // page had scrolled to; the list, or Settings beside a section, uncovers the app.
  cleanups.push(holdBack(overlay, () => back(), () => (!wide() && frame.hasAttribute('data-open') ? {
    moving: page,
    under: list,
    show: (on) => {
      frame.toggleAttribute('data-swipe', on);
      list.style.top = on ? `${scroller.scrollTop}px` : '';
      // As tall as the screen at least: a short section would show the list under its foot.
      page.style.minHeight = on ? `${scroller.scrollTop + scroller.clientHeight}px` : '';
    },
  } : { moving: overlay })));
  // In a frame of the host's split view, the view gives this module's section the whole space while they are open.
  const shown = (open) => {
    if (!FRAMED) return;
    try {
      window.parent.dispatchEvent(new window.parent.CustomEvent(SETTINGS_SHOWN_EVENT, { detail: { open, source: window } }));
    } catch { /* the view went */ }
  };
  shown(true);

  const items = new Map();
  // Each group's heading and what it folds, by its name, to slide one open and the other shut.
  const folders = new Map();
  const built = new Map();
  let current = null;
  // The group unfolded in the list, by its name: one at a time.
  let unfolded = null;
  const wide = () => frame.clientWidth >= 720;

  /**
   * The list, folded by group: a group's heading unfolds it and folds the one that was open, or
   * folds it again, both sliding (unfold). A group with one section is that section's way in, with
   * no fold of its own. Sections marked `unlisted` are opened from another one, never from the list.
   */
  function paintList() {
    clear(list);
    items.clear();
    folders.clear();
    const groups = [];
    for (const section of all.filter((s) => !s.unlisted)) {
      const last = groups.at(-1);
      if (last?.name === section.group) last.sections.push(section);
      else groups.push({ name: section.group, sections: [section] });
    }
    for (const { name, sections } of groups) {
      if (sections.length === 1) {
        const [section] = sections;
        const heading = el('button', {
          type: 'button', class: 'kit-settings__group', 'aria-current': section.id === current ? 'page' : null,
          onClick: () => (section.go ? section.go() : show(section.id)),
        }, el('span', { class: 'kit-settings__group-name', text: name }), icon('chevron', { className: 'kit-settings__fold' }));
        items.set(section.id, heading);
        list.append(heading);
        continue;
      }
      const open = name === unfolded;
      const folder = el('div', { class: 'kit-settings__folder', role: 'group', 'aria-label': name, hidden: !open });
      const heading = el('button', {
        type: 'button', class: 'kit-settings__group', 'aria-expanded': String(open),
        onClick: () => unfold(unfolded === name ? null : name),
      }, el('span', { class: 'kit-settings__group-name', text: name }), icon('chevron', { className: 'kit-settings__fold' }));
      for (const section of sections) {
        const props = { class: 'kit-settings__item', 'aria-current': section.id === current ? 'page' : null };
        const content = [
          el('span', { class: 'kit-settings__icon' }, icon(section.iconName || 'sliders')),
          el('span', { class: 'kit-settings__text' }, el('span', { class: 'kit-settings__label', text: section.label }), el('small', { text: section.hint() })),
          icon(section.href ? 'external' : 'chevron', { className: 'kit-settings__chevron' }),
        ];
        const item = section.href
          ? el('a', { ...props, href: section.href, target: '_blank', rel: 'noopener' }, content)
          : el('button', { ...props, type: 'button', onClick: () => (section.go ? section.go() : show(section.id)) }, content);
        items.set(section.id, item);
        folder.append(item);
      }
      folders.set(name, { heading, folder });
      list.append(heading, folder);
    }
  }

  /** Unfolds the group of that name (null: none), sliding it open and the one that was open shut. */
  function unfold(name) {
    unfolded = name;
    return Promise.all([...folders].map(([group, { heading, folder }]) => {
      heading.setAttribute('aria-expanded', String(group === name));
      return slideHidden(folder, group !== name);
    }));
  }

  /**
   * Opens a section: built the first time and kept, so what was typed survives a visit to another.
   * → whether there was one of that id to open here.
   */
  function show(id) {
    const section = all.find((s) => s.id === id && !s.href && !s.go);
    if (!section) return false;
    current = id;
    if (!built.has(id)) built.set(id, el('div', {}, el('h2', { text: section.label }), section.render({ close })));
    clear(page).append(built.get(id));
    frame.setAttribute('data-open', '');
    // Its group unfolds in the list, folding the one that was open; one opened from another stays as it was.
    if (!section.unlisted && unfolded !== section.group) unfold(section.group).then(reveal);
    for (const [key, item] of items) {
      if (key === id) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    reveal();
    title.textContent = wide() ? t('kit.settings.title') : section.label;
    // Side by side the section scrolls on its own; on a phone the whole page does.
    page.scrollTop = 0;
    if (!wide()) scroller.scrollTop = 0;
    page.focus({ preventScroll: true });
    return true;
  }

  /**
   * Beside the list, the section open is in sight in it: one far down, reached from another
   * module's Settings, would otherwise be open with nothing in the list saying which. Only the
   * list scrolls, never the page around it (a frame's view).
   */
  function reveal() {
    const item = current && items.get(current);
    if (!item || !wide() || typeof item.getBoundingClientRect !== 'function') return;
    const box = list.getBoundingClientRect();
    const at = item.getBoundingClientRect();
    if (at.top >= box.top && at.bottom <= box.bottom) return;
    list.scrollTop += at.top - box.top - Math.max(0, (box.height - at.height) / 2);
  }

  /** Back: from a section to the list on a phone; out of Settings otherwise. */
  function back() {
    if (!wide() && frame.hasAttribute('data-open')) {
      frame.removeAttribute('data-open');
      title.textContent = t('kit.settings.title');
      paintList();
      return;
    }
    close();
  }

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    for (const cleanup of cleanups.splice(0)) cleanup();
    overlay.remove();
    shown(false);
    options.onClose?.();
  }
  const onKey = (ev) => { if (ev.key === 'Escape') back(); };
  document.addEventListener('keydown', onKey);

  paintList();
  // On a computer a section is always open beside the list: the one asked for, if it is here.
  if (!(start && show(start)) && wide()) show('profile');

  /* --------------------------------- profile -------------------------------- */

  function profile() {
    const name = input({ id: 'kit-profile-name', autocomplete: 'name', maxlength: '60', value: state.user?.display_name || '' });
    const saveName = button(t('kit.save'), async () => {
      try {
        const { user } = await api.patch('/api/me', { display_name: name.value.trim() });
        setUser(user);
        toast(t('kit.saved'));
      } catch (err) { fail(err); }
    });
    const parts = [block(null, field(t('kit.profile.name'), name, t('kit.profile.nameHint')), row(saveName))];
    if (local) parts.push(emailBlock());
    else parts.push(block(t('kit.profile.email.title'), el('p', { text: state.user?.email || '—' }), hint(t('kit.profile.email.provider'))));
    parts.push(block(null, row(el('span', { class: 'kit-hint', text: t('kit.profile.username', { username: state.user?.username || '' }) }))));
    // Signing out closes the page of the account, as on a phone's own settings: the account
    // button of the frame opens Settings, with no menu of its own any more.
    if (onSignOut) parts.push(block(null, row(button(t('kit.account.signOut'), onSignOut, 'danger-quiet'))));
    return parts;
  }

  /** The email: what a forgotten password is recovered with. A new one gets a link to confirm it. */
  function emailBlock() {
    const mail = config.mail !== false;
    const email = input({ id: 'kit-profile-email', type: 'email', autocomplete: 'email', maxlength: '254', value: state.user?.email || '' });
    const status = hint('');
    const resend = el('button', {
      type: 'button', class: 'kit-link', text: t('kit.profile.email.resend'),
      onClick: async () => {
        try {
          await api.post('/api/me/email/verify');
          toast(t('kit.profile.email.sent', { email: state.user.email }));
        } catch (err) { fail(err); }
      },
    });
    const paint = () => {
      const u = state.user || {};
      // Without a mail server no link arrives: say so, and who can confirm it instead.
      status.textContent = !u.email ? t('kit.profile.email.help')
        : u.email_verified ? t('kit.profile.email.confirmed')
          : !mail ? t(u.role === 'admin' ? 'kit.profile.email.noMailAdmin' : 'kit.profile.email.noMail')
            : t('kit.profile.email.unconfirmed');
      resend.hidden = !mail || !u.email || Boolean(u.email_verified);
    };
    paint();
    const save = button(t('kit.save'), async () => {
      try {
        const { user, verification } = await api.patch('/api/me', { email: email.value.trim() || null });
        setUser(user);
        paint();
        // Saved either way; the link went out, or why not.
        if (verification && verification !== 'sent') {
          const reason = t(`errors.${verification}`);
          toast(`${t('kit.saved')} ${reason.startsWith('errors.') ? t('errors.generic') : reason}`, { error: true });
        } else {
          toast(mail && verification === 'sent' ? t('kit.profile.email.sent', { email: user.email }) : t('kit.saved'));
        }
      } catch (err) { fail(err); }
    });
    // Confirmed from the mail's link, often in another tab: the account changes there and this repaints.
    options.watchUser?.((user) => {
      state.user = user;
      if (document.activeElement !== email) email.value = user?.email || '';
      paint();
    });
    return block(t('kit.profile.email.title'), field(t('kit.profile.email.title'), email), status, row(save, resend));
  }

  /* ------------------------------- appearance ------------------------------- */

  function appearance() {
    const languages = config.app?.languages || ['en'];
    const choice = state.user?.prefs?.lang || 'auto';
    const select = el('select', { class: 'kit-input', id: 'kit-language' },
      el('option', { value: 'auto', text: t('kit.appearance.languageAuto') }),
      languages.map((code) => el('option', { value: code, text: LANGUAGE_NAMES[code] || code })));
    select.value = choice;
    select.addEventListener('change', async () => {
      try {
        const { user } = await api.patch('/api/me', { prefs: { lang: select.value } });
        setUser(user);
        // The apps load it themselves (loadLanguage): in Work's shell every module speaks it, not this one
        // alone. An app that loads nothing here has nothing new to tell the shell.
        if (options.setLanguage) {
          await options.setLanguage(select.value);
          shareLanguage(currentLanguage());
        }
        // Everything here is written again in the new language.
        close();
        openSettings({ ...options, user, start: 'appearance' });
      } catch (err) { fail(err); }
    });
    const theme = segmented(['system', 'light', 'dark'].map((value) => ({ value, label: t(`kit.appearance.theme.${value}`) })),
      // In Work's shell the theme shown is the page's, which the shell keeps (`suite.theme`), not this module's account's.
      workRegistry()?.theme?.current?.() || state.user?.theme || 'system', async (value) => {
        // In Cronum Work's shell the theme is the page's, one for every module (`suite.theme`): the
        // shell paints it and tells the windows. A module painting <html> with its own key would win
        // over the others until the next one did.
        const shared = workRegistry()?.theme;
        if (shared) shared.set(value);
        else options.applyTheme?.(value);
        try {
          const { user } = await api.patch('/api/me', { theme: value });
          setUser(user);
        } catch (err) { fail(err); }
      });
    return [
      block(null, field(t('kit.appearance.language'), select)),
      block(t('kit.appearance.themeTitle'), theme, hint(t('kit.appearance.themeHint'))),
      host ? lookBlock() : null,
      celebrateBlock(),
    ];
  }

  /**
   * The celebration when something is done (celebrate.js), the same in every module and in the
   * host's calendar: on this device, as the theme kept in this browser.
   */
  function celebrateBlock() {
    const prefs = celebratePrefs();
    return block(t('kit.appearance.celebrate.title'),
      switchRow(t('kit.appearance.celebrate.animation'), {
        hint: t('kit.appearance.celebrate.animationHint'),
        checked: prefs.animation,
        onChange: (on) => setCelebratePref('animation', on),
      }),
      switchRow(t('kit.appearance.celebrate.sound'), {
        hint: t('kit.appearance.celebrate.soundHint'),
        checked: prefs.sound,
        onChange: (on) => setCelebratePref('sound', on),
      }),
      row(button(t('kit.appearance.celebrate.test'), (ev) => celebrate(ev.currentTarget))),
      hint(t('kit.appearance.celebrate.hint')));
  }

  /** In a host, the look of every module (host.js LOOKS): the suite's own, or Clean. */
  function lookBlock() {
    let saved = document.documentElement.getAttribute('data-look') === 'clean' ? 'clean' : 'cronum';
    const look = segmented(LOOKS.map((value) => ({ value, label: t(`kit.appearance.look.${value}`) })), saved, async (value) => {
      applyLook(value);
      try {
        const res = await fetch('/api/me/look', {
          method: 'PUT', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ look: value }),
        });
        if (!res.ok) throw new Error(String(res.status));
        saved = value;
      } catch (err) {
        applyLook(saved);   // not saved: the page goes back to the look this account has
        fail(err);
      }
    });
    return block(t('kit.appearance.lookTitle'), look, hint(t('kit.appearance.lookHint', { app: hostInfo.name || host.name })));
  }

  /* -------------------------------- security -------------------------------- */

  function security() {
    const parts = [];
    if (local) {
      const current = input({ id: 'kit-password-current', type: 'password', autocomplete: 'current-password' });
      const next = input({ id: 'kit-password-new', type: 'password', autocomplete: 'new-password', minlength: String(config.password_min || 10) });
      parts.push(block(t('kit.security.password'),
        state.user?.has_password === false ? null : field(t('kit.security.currentPassword'), current),
        field(t('kit.security.newPassword'), next, t('kit.security.newPasswordHint', { n: config.password_min || 10 })),
        row(button(t('kit.security.changePassword'), async () => {
          try {
            await api.post('/api/me/password', { current_password: current.value, password: next.value });
            current.value = '';
            next.value = '';
            toast(t('kit.security.passwordChanged'));
          } catch (err) { fail(err); }
        }))));
      if (config.two_factor) parts.push(twoFactor());
    } else if (provider === 'workos') {
      parts.push(workosSecurity());
    } else {
      parts.push(block(null, hint(t('kit.security.provider'))));
    }
    return parts;
  }

  /**
   * With WorkOS, what fits how the person signs in (workos-security.js): with
   * a password, changing it and the second step; with Google, Apple… a plain
   * word that there is no password here, and where it is.
   */
  function workosSecurity() {
    const box = el('div', { class: 'kit-contents' });
    const appName = hostInfo.name || host?.name || app.name;
    (async () => {
      let answer;
      try { answer = await api.get('/api/me/sign-in'); } catch (err) { fail(err); return; }
      if (!answer.password) {
        clear(box).append(elsewhereBlock(answer.method));
        return;
      }
      const current = input({ id: 'kit-password-current', type: 'password', autocomplete: 'current-password' });
      const next = input({ id: 'kit-password-new', type: 'password', autocomplete: 'new-password', minlength: '8' });
      append(clear(box), block(t('kit.security.password'),
        field(t('kit.security.currentPassword'), current),
        field(t('kit.security.newPassword'), next, t('kit.security.workosPasswordHint')),
        row(button(t('kit.security.changePassword'), async () => {
          try {
            await api.post('/api/me/sign-in/password', { current_password: current.value, password: next.value });
            current.value = '';
            next.value = '';
            toast(t('kit.security.passwordChanged'));
          } catch (err) { fail(err); }
        }))),
      answer.two_factor?.available ? twoFactor({ base: '/api/me/sign-in/two-factor', recovery: false, appName }) : null);
    })();
    return box;
  }

  /** Signing in with another account: its password and second step are there, and this says where. */
  function elsewhereBlock(method) {
    const where = {
      google: ['Google', 'https://myaccount.google.com/security'],
      apple: ['Apple', 'https://account.apple.com/account/manage'],
      microsoft: ['Microsoft', 'https://account.microsoft.com/security'],
      github: ['GitHub', 'https://github.com/settings/security'],
    }[method];
    if (where) {
      const [name, href] = where;
      return block(t('kit.security.elsewhere.title', { provider: name }),
        hint(t('kit.security.elsewhere.body', { provider: name })),
        el('a', { class: 'kit-link', href, target: '_blank', rel: 'noopener', text: t('kit.security.elsewhere.open', { provider: name }) }));
    }
    return block(null, hint(t(method === 'sso' ? 'kit.security.sso' : method === 'email_code' ? 'kit.security.emailCode' : 'kit.security.provider')));
  }

  /**
   * Where the person is signed in, each one closable. A session opened before
   * the device was noted (a sign-in through WorkOS before 0.35.0) says so, and
   * when it began, instead of a dash.
   */
  function sessionsBlock() {
    const box = el('div', { class: 'kit-list' });
    const paint = async () => {
      let sessions = [];
      try { sessions = await api.get('/api/me/sessions'); } catch (err) { fail(err); return; }
      clear(box).append(...sessions.map((s) => el('div', { class: 'kit-list__row' },
        icon(/mobile|android|iphone/i.test(s.user_agent || '') ? 'phone' : 'device'),
        el('span', { class: 'kit-list__text' },
          el('strong', { text: deviceName(s.user_agent, t('kit.security.unknownDevice')) }),
          el('small', { text: [
            s.ip,
            s.user_agent ? null : t('kit.security.openedAt', { when: formatDateTime(s.created_at) }),
            t('kit.security.lastUsed', { when: formatDateTime(s.last_used_at) }),
          ].filter(Boolean).join(' · ') })),
        s.current ? el('span', { class: 'kit-badge kit-badge--accent', text: t('kit.security.thisDevice') })
          : button(t('kit.security.signOutDevice'), async () => {
            try {
              await api.delete(`/api/me/sessions/${encodeURIComponent(s.key)}`);
              paint();
            } catch (err) { fail(err); }
          }, 'quiet'))));
    };
    paint();
    // A section of its own, named by its title: the block needs none.
    return block(null, hint(t('kit.security.sessionsHint')), box);
  }

  /**
   * A code from an app on the phone after the password. Setting it up: the
   * password again, the QR code (or the key typed by hand), a first code, and
   * ten recovery codes shown only then. Turning it off, or new recovery
   * codes, asks for the password and a code.
   *
   * With WorkOS (`recovery: false`) the same steps at its own routes, with
   * no recovery codes: WorkOS has none, and whoever loses the phone is helped
   * by an administrator, which the texts say.
   */
  function twoFactor({ base = '/api/me/two-factor', recovery = true, appName = app.name } = {}) {
    const body = el('div', { class: 'kit-stack' });
    const cancel = () => el('button', { type: 'button', class: 'kit-link', text: t('kit.cancel'), onClick: paint });
    const code = (id) => input({ id, autocomplete: 'one-time-code', autocapitalize: 'none', spellcheck: 'false', maxlength: '12' });
    const password = (id) => input({ id, type: 'password', autocomplete: 'current-password' });
    const setOn = (on) => setUser({ ...state.user, two_factor: on });
    // Whether it is on, said in so many words above what it means, not left to the buttons.
    const status = (on) => el('p', {},
      el('span', { class: `kit-badge ${on ? 'kit-badge--on' : ''}`.trim() }, on ? icon('check') : null,
        t(on ? 'kit.twoFactor.statusOn' : 'kit.twoFactor.statusOff')));

    async function paint() {
      let current;
      try {
        current = recovery ? await api.get(base) : (await api.get('/api/me/sign-in')).two_factor;
      } catch (err) { fail(err); return; }
      if (!current.enabled) {
        clear(body).append(status(false), hint(t('kit.twoFactor.off')), row(button(t('kit.twoFactor.setUp'), askPassword, 'primary')));
        return;
      }
      if (!recovery) {
        clear(body).append(status(true), hint(t('kit.twoFactor.onNoCodes', { app: appName })),
          row(button(t('kit.twoFactor.turnOff'), () => confirmWith('off'), 'danger-quiet')));
        return;
      }
      clear(body).append(status(true),
        hint(t('kit.twoFactor.on', { n: current.recovery_codes_left })),
        row(button(t('kit.twoFactor.newCodes'), () => confirmWith('codes')), button(t('kit.twoFactor.turnOff'), () => confirmWith('off'), 'danger-quiet')));
    }

    function askPassword() {
      const pass = password('kit-2fa-password');
      clear(body).append(hint(t('kit.twoFactor.passwordFirst')), field(t('kit.security.currentPassword'), pass),
        row(button(t('kit.twoFactor.continue'), async () => {
          try { await showSecret(await api.post(`${base}/setup`, { password: pass.value })); } catch (err) { fail(err); }
        }, 'primary'), cancel()));
      pass.focus();
    }

    async function showSecret({ secret, uri }) {
      let qr = null;
      try {
        const { qrSvg } = await import('./qr.js');
        qr = el('div', {}, qrSvg(uri, { label: t('kit.twoFactor.qrLabel', { app: app.name }) }));
      } catch { /* the key typed by hand does the same */ }
      const first = code('kit-2fa-first');
      const key = el('code', { class: 'kit-mono', text: secret.match(/.{1,4}/g).join(' ') });
      // Without a QR (an address too long for one) nothing stands in its place, not the text "null".
      append(clear(body),
        hint(t(qr ? 'kit.twoFactor.scan' : 'kit.twoFactor.typeKey')), qr,
        qr ? hint(t('kit.twoFactor.orKey')) : null,
        el('div', { class: 'kit-copy' }, key, el('button', { type: 'button', class: 'kit-link', text: t('kit.copy'), onClick: () => copyText(secret, key) })),
        // On the phone itself, the app opens with everything filled in.
        el('a', { class: 'kit-link', href: uri, text: t('kit.twoFactor.openApp') }),
        field(t('kit.twoFactor.firstCode'), first),
        recovery ? null : hint(t('kit.twoFactor.noCodesHint', { app: appName })),
        row(button(t('kit.twoFactor.turnOn'), async () => {
          try {
            const done = await api.post(`${base}/enable`, { code: first.value.trim() });
            setOn(true);
            if (!recovery) {
              toast(t('kit.twoFactor.onNow'));
              paint();
              return;
            }
            showRecovery(done.recovery_codes, t('kit.twoFactor.onNow'));
          } catch (err) { fail(err); }
        }, 'primary'), cancel()));
      first.focus();
    }

    function showRecovery(codes, lead) {
      const listNode = el('ul', { class: 'kit-codes' }, codes.map((c) => el('li', {}, el('code', { text: c }))));
      const who = state.user ? `${state.user.display_name} (${state.user.username})` : '';
      const file = `${t('kit.twoFactor.fileTitle', { app: app.name, user: who, host: window.location.host })}\n\n${codes.join('\n')}\n`;
      clear(body).append(hint(lead), hint(t('kit.twoFactor.recoveryHint')), listNode,
        row(el('button', { type: 'button', class: 'kit-link', text: t('kit.copy'), onClick: () => copyText(codes.join('\n'), listNode) }),
          el('button', { type: 'button', class: 'kit-link', text: t('kit.twoFactor.download'), onClick: () => download(`${app.id || 'app'}-recovery-codes.txt`, file) })),
        row(button(t('kit.twoFactor.saved'), paint, 'primary')));
    }

    function confirmWith(what) {
      const off = what === 'off';
      const pass = password('kit-2fa-confirm-password');
      const second = code('kit-2fa-confirm-code');
      clear(body).append(hint(t(!recovery ? 'kit.twoFactor.offAskNoCodes' : off ? 'kit.twoFactor.offAsk' : 'kit.twoFactor.newCodesAsk')),
        field(t('kit.security.currentPassword'), pass), field(t(recovery ? 'kit.twoFactor.codeOrRecovery' : 'kit.twoFactor.code'), second),
        row(button(t(off ? 'kit.twoFactor.turnOff' : 'kit.twoFactor.newCodes'), async () => {
          try {
            if (off) {
              await api.post(`${base}/disable`, { password: pass.value, code: second.value.trim() });
              setOn(false);
              toast(t('kit.twoFactor.offNow'));
              paint();
            } else {
              const done = await api.post(`${base}/recovery-codes`, { password: pass.value, code: second.value.trim() });
              showRecovery(done.recovery_codes, t('kit.twoFactor.newCodesDone'));
            }
          } catch (err) { fail(err); }
        }, off ? 'danger' : 'primary'), cancel()));
      pass.focus();
    }

    paint();
    return block(t('kit.twoFactor.title'), body);
  }

  /* ----------------------------------- AI ----------------------------------- */

  /**
   * Connecting an assistant: the MCP address; with the built-in OAuth or
   * WorkOS pasting it is enough and the apps connected that way are listed,
   * each one disconnectable here; manual tokens for clients that can't sign in.
   */
  /**
   * Which modules of the host this person uses (PUT /api/me/modules at the host's root). One
   * stays on; one turned off keeps its data and only leaves their menus. Each can have its own
   * icon on a phone's home screen, installed from its own page. Their order on the rail and a
   * phone's tabs (PUT /api/me/modules/order): each row dragged by its grip, or moved from the
   * grip's menu, which the keyboard and a screen reader reach too.
   */
  function moduleChoice() {
    const switches = el('div', { class: 'kit-stack' });
    const calendarSwitch = el('div', { hidden: true });
    const icons = el('div', { class: 'kit-row' });
    // What the switches say now: two pressed one after the other both count.
    const shownOn = () => [...switches.querySelectorAll('.kit-switch')]
      .filter((s) => s.getAttribute('aria-checked') === 'true').map((s) => s.dataset.mount);
    // One change at a time, in the order they were made: the last one sent is what stays.
    let sending = Promise.resolve();
    const send = (active) => {
      sending = sending.catch(() => {}).then(async () => {
        const res = await fetch('/api/me/modules', {
          method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active }),
        });
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      });
      return sending;
    };
    const sendOrder = (order) => {
      sending = sending.catch(() => {}).then(async () => {
        const res = await fetch('/api/me/modules/order', {
          method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order }),
        });
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      });
      return sending;
    };
    /** The modules in a new order: drawn in it, kept, and the rail of every page follows. */
    const reorder = async (order) => {
      try {
        paint(await sendOrder(order));
        repaint();
        modulesChanged();
      } catch (err) {
        fail(err);
      }
    };
    const mounts = () => inUse.map((m) => m.mount);
    /** The order with `mount` taken to `index` among the others. */
    const moved = (mount, index) => {
      const rest = mounts().filter((x) => x !== mount);
      rest.splice(Math.max(0, Math.min(index, rest.length)), 0, mount);
      return rest;
    };
    /** Where a row let go before or after another lands: the new order, or null where it already is. */
    const dropped = (row, place, zone) => {
      const rest = mounts().filter((x) => x !== row.dataset.mount);
      const at = rest.indexOf(place.dataset.mount);
      if (at < 0) return null;
      const order = moved(row.dataset.mount, zone === 'after' ? at + 1 : at);
      return order.join() === mounts().join() ? null : order;
    };
    const nameOf = (mount) => inUse.find((m) => m.mount === mount)?.name || mount;
    const dragging = makeDraggable(switches, {
      items: '.kit-switch-row[data-mount]',
      handle: '.kit-module-grip',
      targets: '.kit-switch-row[data-mount]',
      zones: 'between',
      label: (row) => nameOf(row.dataset.mount),
      check: (row, place, { zone }) => (dropped(row, place, zone)
        ? { ok: true, text: t(zone === 'after' ? 'kit.modules.after' : 'kit.modules.before', { name: nameOf(place.dataset.mount) }) }
        : { ok: false, text: t('kit.modules.here') }),
      onDrop: (row, place, { zone }) => {
        const order = dropped(row, place, zone);
        if (order) reorder(order);
      },
    });
    cleanups.push(() => dragging.destroy());
    const paint = (answer) => {
      inUse = answer.modules || [];
      clear(switches);
      for (const m of inUse) {
        const row = switchRow(m.name, {
          checked: m.active,
          onChange: async () => {
            const active = shownOn();
            if (!active.length) {
              toast(t('kit.modules.last'), { error: true });
              throw new Error('one stays on');   // the switch goes back
            }
            try {
              const answer = await send(active);
              // A later change still on its way repaints when it arrives.
              if (shownOn().join() === active.join()) paint(answer);
              repaint();
              // The frame's rail, in this tab, at once (shell.js); other tabs ask when they come back.
              modulesChanged();
            } catch (err) {
              toast(t('errors.generic'), { error: true });
              throw err;
            }
          },
        });
        row.querySelector('.kit-switch').dataset.mount = m.mount;
        row.dataset.mount = m.mount;
        row.classList.add('kit-switch-row--swatch');
        const at = inUse.indexOf(m);
        const grip = el('button', {
          type: 'button', class: 'kit-module-grip', 'aria-haspopup': 'menu',
          'aria-label': t('kit.modules.move', { name: m.name }), title: t('kit.modules.move', { name: m.name }),
          onClick: (ev) => menu(ev.currentTarget, [
            at > 0 ? { label: t('kit.modules.moveUp'), onClick: () => reorder(moved(m.mount, at - 1)) } : null,
            at < inUse.length - 1 ? { label: t('kit.modules.moveDown'), onClick: () => reorder(moved(m.mount, at + 1)) } : null,
          ].filter(Boolean)),
        }, icon('grip'));
        row.firstChild.prepend(grip, el('span', { class: 'kit-nav__swatch', style: m.color ? `background:${m.color}` : null }));
        switches.append(row);
      }
      // The host's calendar, where it has one: its button on the rail only for whoever wants it.
      clear(calendarSwitch);
      calendarSwitch.hidden = typeof answer.calendar_shown !== 'boolean';
      if (!calendarSwitch.hidden) {
        calendarSwitch.append(switchRow(t('kit.calendar.show'), {
          checked: answer.calendar_shown,
          hint: t('kit.calendar.showHint'),
          onChange: async (shown) => {
            try {
              // The host's root, as the modules' switches: a module's api.js would ask its own path.
              const res = await fetch('/api/me/calendar', {
                method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shown }),
              });
              if (!res.ok) throw new Error(String(res.status));
              // The rail, in this tab, at once (shell.js); other tabs ask when they come back.
              modulesChanged();
            } catch (err) {
              fail(err);
              throw err;   // the switch goes back
            }
          },
        }));
      }
      clear(icons);
      // In the suite's app each one opens outside it, in the browser, where it can be installed.
      const native = inApp();
      const link = (href, image, name) => el('a', {
        class: 'kit-btn kit-btn--small', href, target: '_blank', rel: 'noopener',
        onClick: (ev) => { if (native && openExternal(new URL(href, window.location.href).href)) ev.preventDefault(); },
      }, image ? el('img', { src: image, alt: '', width: 18, height: 18 }) : null, name);
      // The host itself first, but not in its own app, which is it installed: one icon for all of it,
      // opening on the module used last. Its page at /?modules stays put instead of going on to a
      // module, so it can be installed from there.
      if (answer.host?.name && !native) icons.append(link('/?modules', answer.host.icon, answer.host.name));
      for (const m of inUse.filter((x) => x.active)) icons.append(link(m.path, m.icon, m.name));
    };
    fetch('/api/modules', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((answer) => { paint(answer); repaint(); }, fail);
    return el('div', {},
      block(null, hint(t('kit.modules.hint')), switches, hint(t('kit.modules.order')), hint(t('kit.modules.one')), hint(t('kit.modules.off')), calendarSwitch),
      installing(icons));
  }

  /**
   * Installing on this device: on the web Cronum Work or each module on its own, in the suite's
   * app (Cronum Work already) only the modules. First which one (`icons`), then this device's way,
   * then what installing it gives: it opens as an app and keeps what was seen, for without a signal.
   */
  function installing(icons) {
    const native = inApp();
    const kind = installKind();
    const pick = native ? 'kit.modules.installPickApp'
      : kind === 'ios' || kind === 'android' ? 'kit.modules.installPickTap' : 'kit.modules.installPickClick';
    const how = {
      ios: 'kit.modules.installIos', android: 'kit.modules.installAndroid',
      'mac-safari': 'kit.modules.installMacSafari', firefox: 'kit.modules.installFirefox',
    }[kind] || 'kit.modules.installDesktop';
    return block(t('kit.modules.installTitle'),
      hint(t(native ? 'kit.modules.installApp' : 'kit.modules.installWeb', { host: host.name })),
      el('ol', { class: 'kit-steps' },
        el('li', {}, el('p', { text: t(pick) }), icons),
        el('li', {}, el('p', { text: t(how) })),
        el('li', {}, el('p', { text: t('kit.modules.installOffline') }))));
  }

  function ai() {
    // What the assistant connects to: in a host, the whole app, at its one /mcp.
    const connected = host?.name || app.name;
    const endpoint = el('code', { text: `${window.location.origin}/mcp` });
    const intro = hint(t('kit.ai.intro', { app: connected }));
    const apps = el('div', { class: 'kit-list' });
    const appsBlock = block(t('kit.ai.apps'), apps);
    appsBlock.hidden = true;
    const tokens = el('div', { class: 'kit-list' });
    const created = el('div', { hidden: true });

    const paintApps = async () => {
      let answer = { enabled: false, grants: [] };
      try { answer = await api.get('/api/me/apps'); } catch { /* without the built-in OAuth: tokens only */ }
      intro.textContent = t(answer.enabled ? 'kit.ai.introOAuth' : 'kit.ai.intro', { app: connected });
      appsBlock.hidden = !answer.enabled;
      const rows = answer.grants.map((g) => el('div', { class: 'kit-list__row' },
        icon('spark'),
        el('span', { class: 'kit-list__text' }, el('strong', { text: g.client_name }),
          // Through WorkOS, when it was last used is only known since 0.35.0: no "never used" before.
          el('small', { text: [g.redirect_host, g.provider && !g.last_used_at ? null : used(g.last_used_at)].filter(Boolean).join(' · ') })),
        button(t('kit.ai.disconnect'), async () => {
          if (!(await confirmDialog(t('kit.ai.confirmDisconnect', { name: g.client_name }), { confirm: t('kit.ai.disconnect') }))) return;
          try { await api.delete(`/api/me/apps/${encodeURIComponent(g.id)}`); paintApps(); } catch (err) { fail(err); }
        }, 'danger-quiet')));
      if (answer.unavailable) rows.push(el('div', { class: 'kit-list__row' }, hint(t('kit.ai.appsUnavailable'))));
      else if (!rows.length) rows.push(el('div', { class: 'kit-list__row' }, hint(t('kit.ai.noApps'))));
      clear(apps).append(...rows);
    };

    const paintTokens = async () => {
      let rows = [];
      try { rows = await api.get('/api/me/tokens'); } catch (err) { fail(err); }
      clear(tokens).append(...(rows.length ? rows.map((tk) => el('div', { class: 'kit-list__row' },
        icon('key'),
        el('span', { class: 'kit-list__text' }, el('strong', { text: tk.name }), el('small', { text: `${tk.prefix || ''}… · ${used(tk.last_used_at)}` })),
        button(t('kit.ai.revoke'), async () => {
          if (!(await confirmDialog(t('kit.ai.confirmRevoke', { name: tk.name }), { confirm: t('kit.ai.revoke') }))) return;
          try { await api.delete(`/api/me/tokens/${tk.id}`); paintTokens(); } catch (err) { fail(err); }
        }, 'danger-quiet'))) : [el('div', { class: 'kit-list__row' }, hint(t('kit.ai.noTokens')))]));
    };

    const name = input({ id: 'kit-token-name', maxlength: '60', placeholder: 'Claude' });   // i18n-exempt: a product name, as an example
    const create = button(t('kit.ai.createToken'), async () => {
      try {
        const tk = await api.post('/api/me/tokens', { name: name.value.trim() || 'Claude' });   // i18n-exempt: a product name
        name.value = '';
        const value = el('code', { text: tk.token });
        // The value is only seen now: afterwards only its fingerprint remains.
        clear(created).append(hint(t('kit.ai.tokenCreated')),
          el('div', { class: 'kit-copy' }, value, el('button', { type: 'button', class: 'kit-link', text: t('kit.copy'), onClick: () => copyText(tk.token, value) })));
        created.hidden = false;
        paintTokens();
      } catch (err) { fail(err); }
    });

    paintApps();
    paintTokens();
    return [
      block(null, intro, el('div', { class: 'kit-copy' }, endpoint, el('button', {
        type: 'button', class: 'kit-link', text: t('kit.copy'), onClick: () => copyText(endpoint.textContent, endpoint),
      }))),
      ...hostAgents(endpoint.textContent, connected),
      toolsBlock(),
      appsBlock,
      instructions(),
      block(t('kit.ai.tokens'), hint(t('kit.ai.tokensHint')), tokens, field(t('kit.ai.tokenName'), name), row(create), created),
      // In a host, what a module adds is a section of its own group: Your AI is the same in every one.
      ...(options.aiExtra && !host ? [options.aiExtra()] : []),
    ];
  }

  /**
   * In a host that keeps the tools used now and then on demand: whether the person's assistants
   * get every tool listed from the start instead. Hidden while the host says nothing of it.
   */
  function toolsBlock() {
    const section = block(t('kit.ai.toolsTitle'));
    const paint = () => {
      section.hidden = !aiTools;
      section.querySelector('.kit-switch-row')?.remove();
      if (!aiTools) return;
      section.append(switchRow(t('kit.ai.toolsAll'), {
        checked: aiTools === 'all',
        hint: t('kit.ai.toolsHint'),
        onChange: async (on) => {
          try {
            const answer = await api.put('/api/me/ai-tools', { ai_tools: on ? 'all' : 'door' });
            aiTools = answer.ai_tools;
          } catch (err) {
            fail(err);
            throw err;   // the switch goes back
          }
        },
      }));
    };
    paint();
    onModules.push(paint);
    return section;
  }

  const used = (when) => (when ? t('kit.ai.lastUsed', { when: formatDateTime(when) }) : t('kit.ai.neverUsed'));

  /**
   * What to paste into the assistant's own instructions, for each app: connecting is not enough,
   * an assistant only reaches for an app when it is named. A fold for each, one open at a time:
   * this app's alone, open, or in a host one for every module in use, each in its own words
   * (another module's from its catalog). Hidden while no app has one.
   */
  function instructions() {
    const folds = el('div', { class: 'kit-folds' });
    const section = block(t('kit.ai.standingTitle'), hint(t('kit.ai.standingIntro')),
      el('ul', { class: 'kit-hint' }, ['claude', 'chatgpt', 'claudeCode'].map((k) => el('li', { text: t(`kit.ai.standingWhere.${k}`) }))),
      folds);
    const paint = () => {
      // The host's one prompt says it for every module (hostAgents).
      const shown = hostPrompt() ? [] : saying(paint).filter((a) => a.text);
      section.hidden = !shown.length;
      clear(folds).append(...shown.map((a) => fold(a, shown.length === 1)));
    };
    paint();
    onModules.push(paint);
    return section;
  }

  /** The path of the host's one prompt for its modules (`aiInstruction`), or null. */
  function hostPrompt() {
    return host && typeof hostInfo.aiInstruction === 'string' ? hostInfo.aiInstruction : null;
  }

  /**
   * What each app says for an assistant: its instruction and what goes under it, this app's
   * alone or in a host every module's in use, each in its own words (another module's from its
   * catalog, asked for once: `then` paints again when it comes).
   */
  function saying(then) {
    // This app's words from its own catalog; another module's from its own (moduleWords).
    const said = (key) => {
      const text = key ? t(key) : '';
      return text === key ? '' : text;
    };
    const mine = { mount: host?.mount, name: app.name, src: at(app.icon || '/icons/favicon.svg'), text: said(options.standing), more: notesOf(options.standingMore, said) };
    if (!host) return [mine];
    return modulesHere().map((m) => {
      if (m.mount === host.mount) return mine;
      const key = m.settings?.standing;
      const words = key ? moduleWords(m, currentLanguage(), () => { if (!closed) then(); }) : null;
      const say = (k) => (typeof words?.[k] === 'string' ? words[k] : '');
      return { mount: m.mount, name: m.name, src: m.icon, text: say(key), more: notesOf(m.settings?.standingMore, say) };
    });
  }

  /**
   * In a host with one prompt for its modules: a chip for each agent, whose steps to add the
   * connector open in a dialog, the last one sending the person to the prompt below; the prompt,
   * built by the host for the modules ticked (the ones in use at first); and under it what each
   * module in use says of it (`standingMore`), folded under its name. Hidden in a host without it.
   */
  function hostAgents(endpoint, connected) {
    const open = (agent) => openDialog({
      title: t('kit.ai.agentTitle', { agent: agent.name }),
      content: agentSteps(agent.id, { endpoint, app: connected, last: t('kit.agents.lastSection', { agent: agent.name, app: connected }) }),
    });
    const agents = block(t('kit.ai.agentsTitle'), hint(t('kit.ai.agentsHint', { app: connected })),
      agentChips({ onPick: open, label: t('kit.ai.agentsTitle') }));
    const prompt = el('div');
    const promptBlock = block(t('kit.ai.promptTitle'), hint(t('kit.ai.promptHint', { app: connected })), prompt);
    const folds = el('div', { class: 'kit-folds' });
    const more = block(t('kit.ai.moreTitle'), folds);
    let drawn = '';
    const paint = () => {
      const path = hostPrompt();
      agents.hidden = !path;
      promptBlock.hidden = !path;
      // The modules: the host's, in its order, the ones in use ticked; drawn again only when they change.
      const list = !path ? [] : inUse.length ? inUse : modulesHere();
      const key = path ? `${path}|${list.map((m) => `${m.mount}:${m.active ? 1 : 0}`).join(',')}` : '';
      if (key !== drawn) {
        drawn = key;
        clear(prompt).append(path ? aiPrompt({ path, modules: list.map((m) => ({ ...m, name: m.name || app.name })) }) : []);
      }
      const shown = path ? saying(paint).filter((a) => a.more.length) : [];
      more.hidden = !shown.length;
      clear(folds).append(...shown.map((a) => fold({ ...a, text: '' }, false)));
    };
    paint();
    onModules.push(paint);
    return [agents, promptBlock, more];
  }

  /**
   * What an app says under its instruction (`standingMore`): each entry a key of its catalog, a
   * paragraph, or a pair of keys, a line of a list (a label in bold, then its text); pairs in a row
   * are one list. What its catalog doesn't have is left out.
   */
  function notesOf(entries, say) {
    const nodes = [];
    let list = null;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (Array.isArray(entry)) {
        const [label, text] = entry.map((key) => say(key));
        if (!label && !text) continue;
        if (!list) nodes.push(list = el('ul', { class: 'kit-hint kit-fold__list' }));
        list.append(el('li', {}, label ? el('strong', { text: label }) : null, label && text ? ' ' : null, text || null));
        continue;
      }
      list = null;
      const text = say(entry);
      if (text) nodes.push(hint(text));
    }
    return nodes;
  }

  /**
   * One app's instruction, folded under its name, with what it says about it (without `text`, only
   * that); opening it folds the others.
   */
  function fold({ name, src, text, more = [] }, open) {
    const instruction = text ? el('pre', { class: 'kit-instruction', text }) : null;
    const node = slidingDetails(el('details', { class: 'kit-fold', name: 'kit-standing', open },
      el('summary', {}, src ? el('img', { src, alt: '', width: 22, height: 22 }) : null, el('span', { text: name }),
        icon('chevron-down', { className: 'kit-fold__chevron' })),
      el('div', { class: 'kit-fold__body' }, instruction,
        instruction ? row(button(t('kit.ai.standingCopy'), () => copyText(text, instruction), 'primary')) : null,
        ...more)));
    return node;
  }

  /* ------------------------------ notifications ----------------------------- */

  function notifications() {
    if (inTheApp) return appNotifications();
    const box = el('div', { class: 'kit-list' });
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const status = hint('');
    const paint = async () => {
      let devices = [];
      try { devices = await (await pushApi()).get('/api/push/devices'); } catch (err) { fail(err); }
      clear(box).append(...(devices.length ? devices.map((d) => el('div', { class: 'kit-list__row' },
        icon(/mobile|android|iphone/i.test(d.label || '') ? 'phone' : 'device'),
        el('span', { class: 'kit-list__text' }, el('strong', { text: deviceName(d.label, t('kit.security.unknownDevice')) }),
          el('small', { text: t('kit.notifications.since', { when: formatDateTime(d.created_at) }) }))))
        : [el('div', { class: 'kit-list__row' }, hint(t('kit.notifications.none')))]));
      status.textContent = !supported ? t('kit.notifications.unsupported')
        : Notification.permission === 'denied' ? t('kit.notifications.denied')
          // The modules' own workers were retired for the host's one, and their notices couldn't follow (worker.js).
          : noticesToRenew() ? t('kit.notifications.renew') : '';
    };
    const enable = button(t('kit.notifications.enable'), async () => {
      try {
        await subscribePush();
        toast(t('kit.notifications.enabled'));
        paint();
      } catch (err) {
        if (err?.code) fail(err);
        else toast(t('kit.notifications.notAllowed'), { error: true });
      }
    }, 'primary');
    enable.disabled = !supported;
    const test = button(t('kit.notifications.test'), async () => {
      try {
        const result = await (await pushApi()).post('/api/push/test');
        toast(t(result.no_devices ? 'kit.notifications.none' : 'kit.notifications.testSent'));
      } catch (err) { fail(err); }
    });
    paint();
    return [block(null, hint(t('kit.notifications.intro', { app: app.name })), status, row(enable, test)),
      block(t('kit.notifications.devices'), box)];
  }

  /**
   * Inside the suite's app on a phone: its notices are the app's own, never Web Push (the web view
   * has none, and a notice would come twice). An app that notifies (its 'push') says whether the
   * phone allows them (`push-state`) and opens its own settings; one from before says they come
   * with an update. The devices and the test, as anywhere.
   */
  function appNotifications() {
    const product = host?.name || app.name;
    const pushing = can('push');
    const status = hint('');
    const paintState = () => {
      const state = lastNative('push-state')?.state;
      status.textContent = pushing && state === 'denied' ? t('kit.notifications.appDenied', { app: product }) : '';
      status.hidden = !status.textContent;
    };
    paintState();
    if (pushing) {
      const stop = onNative('push-state', paintState);
      cleanups.push(stop);
    }
    const box = el('div', { class: 'kit-list' });
    const paint = async () => {
      let devices = [];
      try { devices = await (await pushApi()).get('/api/push/devices'); } catch (err) { fail(err); }
      clear(box).append(...(devices.length ? devices.map((d) => el('div', { class: 'kit-list__row' },
        icon(/mobile|android|iphone/i.test(d.label || '') ? 'phone' : 'device'),
        el('span', { class: 'kit-list__text' }, el('strong', { text: deviceName(d.label, t('kit.security.unknownDevice')) }),
          el('small', { text: t('kit.notifications.since', { when: formatDateTime(d.created_at) }) }))))
        : [el('div', { class: 'kit-list__row' }, hint(t('kit.notifications.none')))]));
    };
    const test = button(t('kit.notifications.test'), async () => {
      try {
        const result = await (await pushApi()).post('/api/push/test');
        toast(t(result.no_devices ? 'kit.notifications.none' : 'kit.notifications.testSent'));
      } catch (err) { fail(err); }
    });
    const settings = pushing ? button(t('kit.notifications.appSettings'), () => openAppSettings(), 'primary') : null;
    paint();
    return [block(null, hint(t(pushing ? 'kit.notifications.inApp' : 'kit.notifications.appUpdate', { app: product })), status, row(settings, test)),
      block(t('kit.notifications.devices'), box)];
  }

  /* ---------------------------------- plan ---------------------------------- */

  function plan() {
    const box = el('div', { class: 'kit-stack' });
    const payments = selling ? planPayments({
      hideCheckout, fail, refresh: () => load(), appName: host?.name || app.name, benefit: benefitText,
    }) : null;
    // Inside the suite's app that sells: its store, for whoever has a plan above theirs to go to.
    const storeBlock = store ? block(t('kit.plan.upgradeTitle'), hint(t('kit.plan.storeHint')),
      row(button(t('kit.plan.see'), () => storePurchase(), 'primary'))) : null;
    if (storeBlock) storeBlock.hidden = true;
    const benefits = el('div', {});
    const usage = host ? yourUsage({ offer: payments?.blocks[1] || null, storeBlock }) : null;
    const paint = (answer) => {
      const name = answer.plan?.name ? t(answer.plan.name) : '—';
      const until = answer.ends
        ? el('p', { class: 'kit-plan-card__until', text: t('kit.plan.untilDate', { date: formatDateTime(answer.ends, { dateStyle: 'long' }) }) }) : null;
      // The plan as a card of its own: its name large, and until when, under what it is.
      clear(box).append(el('div', { class: 'kit-plan-card' },
        el('span', { class: 'kit-plan-card__label', text: t('kit.plan.current') }),
        el('strong', { class: 'kit-plan-card__name', text: answer.unlimited ? t('kit.plan.unlimited') : name }),
        until, payments?.status), benefits);
      paintBenefits(benefits, answer);
      if (options.plan?.render) box.append(options.plan.render(answer));
      if (storeBlock) {
        const order = (answer.plans || []).map((p) => p.id);
        storeBlock.hidden = Boolean(answer.unlimited) || (order.length > 0 && order.at(-1) === (answer.plan?.id ?? null));
        usage?.sync();
      }
      if (!payments) return;
      // Held by a live subscription, the plan's end is its period's (said under it), not the grace after it.
      if (until) until.hidden = true;
      payments.paint(answer).then((state) => {
        if (state && until) until.hidden = state.holds || state.noted;
        usage?.sync();
      });
    };
    // The newest answer wins: one read before the plan arrived from billingReturn mustn't paint over it.
    let reading = 0;
    const load = async () => {
      const turn = ++reading;
      try {
        const answer = await api.get('/api/me/entitlements');
        if (turn === reading) paint(answer);
      } catch (err) { if (turn === reading) fail(err); }
    };
    load();
    if (payments || storeBlock) {
      // Back from the checkout, or from the app's store (plan.js storePurchase), the plan read again is painted here too.
      const onPlan = (event) => {
        if (!event?.detail) return;
        reading++;
        paint(event.detail);
      };
      document.addEventListener(PLAN_EVENT, onPlan);
      cleanups.push(() => document.removeEventListener(PLAN_EVENT, onPlan));
    }
    return [block(null, box), ...(usage ? [usage.node] : []), ...(payments ? payments.blocks : []), ...(storeBlock ? [storeBlock] : [])];
  }

  /**
   * What the person uses, under their plan: in a host, what they keep in each module in use against
   * the plan's caps, their storage and their calls from assistants (GET /api/me/usage at the host's
   * root, usage.js), drawn as the admin sees it. Near a cap it says so first, with the way to a
   * bigger plan when there is one here: the plans on offer below (`offer`) or the app's store
   * (`storeBlock`), as they show; `sync()` looks again once they have. Where nothing answers (an
   * app on its own, an older host, offline), the block goes.
   */
  function yourUsage({ offer, storeBlock }) {
    const body = el('div', { class: 'kit-stack' }, hint(t('kit.usage.loading')));
    const node = block(t('kit.usage.title'), body);
    const way = button(t('kit.plan.see'), () => {
      if (storeBlock && !storeBlock.hidden) return storePurchase();
      offer.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      offer.querySelector?.('button')?.focus({ preventScroll: true });
      return undefined;
    }, 'primary');
    const sync = () => { way.hidden = !((storeBlock && !storeBlock.hidden) || (offer && !offer.hidden)); };
    sync();
    api.root.get('/api/me/usage').then((usage) => {
      if (closed) return;
      // What is at a cap, as they count it ("2 projects"), the worst first: which module is plain.
      const capped = atLimit(usage);
      const level = capped[0]?.level;
      const alert = level
        ? el('div', { class: `kit-notice kit-usage__alert kit-usage__alert--${level}`, role: 'status' },
          el('p', { text: t(`kit.usage.${level}Notice`) }),
          el('div', { class: 'kit-usage__at' }, capped.map((c) => el('span', {
            class: `kit-badge kit-badge--${c.level === 'reached' ? 'danger' : 'warn'}`, 'data-level': c.level, text: c.text,
          }))), way) : null;
      clear(body).append(...(alert ? [alert] : []), hint(t('kit.usage.lead')), usageGroups(usage));
    }).catch(() => { node.hidden = true; });
    return { node, sync };
  }

  /**
   * What the plan includes, line by line: the features this app declares and, in a host, those of
   * every other module in use and the host's own too (each answers for its own, at its
   * /api/me/entitlements), once they come. Without any the kit can name, nothing.
   */
  let othersFeatures = null;
  function paintBenefits(node, answer) {
    const draw = (features) => {
      const lines = planBenefits(features, { app: host?.name || app.name });
      clear(node).append(...(lines.length ? [
        el('h3', { class: 'kit-benefits__title', text: t('kit.plan.benefitsTitle') }),
        el('ul', { class: 'kit-benefits' }, lines.map(({ text, included }) => el('li', { class: included ? null : 'kit-benefits__no' },
          icon(included ? 'check' : 'minus'), el('span', { text })))),
      ] : []));
    };
    const own = answer.features || {};
    draw(own);
    if (!host) return;
    const others = inUse.filter((m) => m.active && m.mount !== host.mount && m.path);
    // The host's own too, at its root: what is its alone, such as the calls from assistants of its
    // one MCP, which no module answers for (a module may still declare its own daily ones).
    othersFeatures ||= Promise.all([
      api.root.get('/api/me/entitlements').catch(() => null),
      ...others.map((m) => fetch(`${m.path}api/me/entitlements`, { credentials: 'same-origin' })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null)),
    ])
      .then((answers) => Object.assign({}, ...answers.map((a) => a?.features || {})));
    othersFeatures.then((more) => { if (!closed && node.isConnected !== false) draw({ ...more, ...own }); });
  }

  /* ---------------------------------- data ---------------------------------- */

  /**
   * Asks before what can't be undone from here: the word typed, and the
   * password and code of an account that has them here. `run(body)` is the
   * request; while it fails the dialog stays open and says why. Resolves with
   * its answer, or null when the person leaves it.
   */
  function sure({ title, lines, confirm, run }) {
    return new Promise((resolve) => {
      let answer = null;
      const word = t('kit.data.confirmWord');
      const typed = input({ id: 'kit-sure-word', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' });
      // Not every app tells the browser whether the account has a password: only "none" leaves it out.
      const pass = local && state.user?.has_password !== false
        ? input({ id: 'kit-sure-password', type: 'password', autocomplete: 'current-password' }) : null;
      const code = local ? input({ id: 'kit-sure-code', autocomplete: 'one-time-code', autocapitalize: 'none', spellcheck: 'false', maxlength: '12' }) : null;
      const codeRow = code ? field(t('kit.twoFactor.codeOrRecovery'), code) : null;
      if (codeRow) codeRow.hidden = !state.user?.two_factor;
      const error = el('p', { class: 'kit-error', role: 'alert', hidden: true });
      const { dialog } = openDialog({
        title,
        content: el('div', { class: 'kit-stack kit-sure' },
          ...lines.filter(Boolean).map((line) => (typeof line === 'string' ? el('p', { text: line }) : line)),
          field(t('kit.data.typeWord', { word }), typed),
          pass ? field(t('kit.security.currentPassword'), pass) : null,
          codeRow,
          error),
        actions: [
          { label: t('kit.cancel') },
          {
            label: confirm, danger: true,
            onClick: async () => {
              try {
                answer = await run({
                  confirm: true, ...(pass ? { password: pass.value } : {}), ...(codeRow && !codeRow.hidden ? { code: code.value.trim() } : {}),
                });
                return true;
              } catch (err) {
                // A second step the page didn't know of: its code is asked for now.
                if (err.code === 'code_invalid' && codeRow?.hidden) { codeRow.hidden = false; code.focus(); }
                error.textContent = errorMessage(err);
                error.hidden = false;
                return false;
              }
            },
          },
        ],
        onClose: () => resolve(answer),
      });
      // The button waits for the word: a slip of the finger is not a decision.
      const go = dialog.querySelector('.kit-btn--danger');
      const check = () => { go.disabled = typed.value.trim().toLocaleUpperCase() !== word.toLocaleUpperCase(); };
      typed.addEventListener('input', check);
      check();
      typed.focus();
    });
  }

  /**
   * Your data: everything of yours in a zip, and a copy made that way brought
   * in, here or in another install (suite-core portability.js). What a copy
   * brings, and what "replace" would delete, is said before anything changes.
   * Last, what goes for good: erasing what one has in this app and keeping the
   * account, and deleting the account, which waits the install's days first.
   */
  function data({ module: withModule = true, account: withAccount = true } = {}) {
    const describe = options.describeData || ((tables = {}) => t('kit.data.rows', { n: Object.values(tables).reduce((a, b) => a + b, 0) }));
    const area = el('div', { class: 'kit-stack' });
    const file = el('input', { type: 'file', accept: '.zip,application/zip', id: 'kit-data-file' });
    const check = button(t('kit.data.check'), async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      check.disabled = true;
      try {
        showPlan(await api.upload('/api/me/import', chosen));
      } catch (err) { fail(err); } finally { check.disabled = !file.files?.length; }
    });
    check.disabled = true;
    file.addEventListener('change', () => { check.disabled = !file.files?.length; clear(area); });

    function showPlan(answer) {
      const copy = answer.copy;
      const has = answer.replace || {};
      const owned = Object.values(has).reduce((a, b) => a + b, 0);
      // The groups shared with other people that "replace" takes them out of, by their names
      // (people's own words, never translated): said before, and confirmed with the rest.
      const shown = answer.hand_over || [];
      const leaving = shown.map((o) => o.name);
      const handOver = leaving.length ? t('kit.data.handOver', { names: listFormat({ type: 'conjunction' }).format(leaving) }) : '';
      const replace = el('input', { type: 'checkbox', id: 'kit-data-replace' });
      const apply = button(t('kit.data.apply'), async () => {
        const text = [t('kit.data.replaceText', { what: describe(has) }), handOver].filter(Boolean).join(' ');
        if (replace.checked && !(await confirmDialog(text, {
          title: t('kit.data.replaceTitle'), confirm: t('kit.data.replaceButton'),
        }))) return;
        apply.disabled = true;
        try {
          // The groups as they were shown: if they have changed since, the server says so (409) and nothing is done.
          const result = await api.post(`/api/me/import/${encodeURIComponent(answer.import_id)}`, {
            replace: replace.checked, ...(replace.checked && Array.isArray(answer.hand_over) ? { hand_over: shown.map((o) => o.id) } : {}),
          });
          toast(t('kit.data.done', { what: describe(result.imported.tables) }));
          // Everything shown comes back with what arrived.
          setTimeout(() => window.location.reload(), 1200);
        } catch (err) { fail(err); apply.disabled = false; }
      }, 'primary');
      apply.disabled = Boolean(copy.applied_at);
      const discard = button(t('kit.data.discard'), async () => {
        // If it doesn't reach the server, it expires by itself in a day.
        await api.delete(`/api/me/import/${encodeURIComponent(answer.import_id)}`).catch(() => {});
        clear(area);
        file.value = '';
        check.disabled = true;
      }, 'quiet');
      // The kit's append and not the area's own: that one writes a line left out as the text "null".
      append(clear(area),
        el('p', { text: t('kit.data.plan', { account: answer.account || '', date: formatDateTime(copy.created_at, { dateStyle: 'medium' }), what: describe(copy.tables) }) }),
        copy.applied_at ? hint(t('kit.data.applied')) : null,
        owned || leaving.length ? el('label', { class: 'kit-check' }, replace, el('span', { text: t('kit.data.replace', { what: describe(has) }) })) : null,
        leaving.length ? hint(handOver) : null,
        row(discard, apply));
    }

    const note = () => (options.shareNote ? hint(options.shareNote) : null);
    // In a host the account is the host's: deleting it takes every module. What is shared, said
    // for all of them: each module's own note speaks only of its things.
    const product = host?.name || app.name;
    const sharedOnDelete = host ? t('kit.data.deleteShared') : options.shareNote;
    const downloadFirst = () => (modules.data
      ? el('p', {}, t('kit.data.downloadFirst'), ' ', el('a', { class: 'kit-link', href: at('/api/me/export'), download: '', text: t('kit.data.export') }))
      : null);

    const erase = button(t('kit.data.eraseButton'), async () => {
      const done = await sure({
        title: t('kit.data.eraseAsk', { app: app.name }),
        lines: [t('kit.data.eraseText', { app: app.name }), options.shareNote, downloadFirst()],
        confirm: t('kit.data.eraseConfirm'),
        run: (body) => api.post('/api/me/erase', body),
      });
      if (!done) return;
      toast(t('kit.data.erased'));
      // Everything shown goes with it.
      setTimeout(() => window.location.reload(), 1200);
    }, 'danger-quiet');

    const remove = button(t('kit.data.deleteButton'), async () => {
      const done = await sure({
        title: t('kit.data.deleteAsk'),
        lines: [
          t('kit.data.deleteText', { app: product, n: deletionDays }), sharedOnDelete,
          modules.billing ? t('kit.data.deleteBilling') : null, downloadFirst(),
        ],
        confirm: t('kit.data.deleteConfirm'),
        run: async (body) => {
          // The sign-in screen says until when (signin.js farewell). Left before asking: the
          // session ends with the request, and the app may reload for that before the answer.
          const remember = (value) => { try { sessionStorage.setItem('suite.deletion', value); } catch { /* private mode */ } };
          remember(new Date(Date.now() + deletionDays * 24 * 60 * 60 * 1000).toISOString());
          try {
            const answer = await api.post('/api/me/deletion', body);
            remember(answer.delete_after || '');
            return answer;
          } catch (err) {
            try { sessionStorage.removeItem('suite.deletion'); } catch { /* private mode */ }
            throw err;
          }
        },
      });
      if (!done) return;
      // As signing out leaves (signin.js): every app's copy on this device goes with the account, the
      // suite's app is told, and the whole window goes to the provider's page or this site's sign-in
      // (in the suite's app, its own, without the farewell notice). Its notices went at the server.
      await leave({ answer: done });
    }, 'danger-quiet');

    return [
      ...(modules.data && withModule ? [
        // A link, not a fetch: the browser saves the zip as it arrives, whatever its size.
        block(t('kit.data.exportTitle'), hint(t('kit.data.exportHint', { app: app.name })),
          row(el('a', { class: 'kit-btn kit-btn--small', href: at('/api/me/export'), download: '' }, icon('download'), t('kit.data.export')))),
        block(t('kit.data.importTitle'), hint(t('kit.data.importHint')), field(t('kit.data.file'), file), row(check), area),
        block(t('kit.data.eraseTitle'), hint(t('kit.data.eraseHint', { app: app.name })), note(), row(erase)),
      ] : []),
      ...(deletionDays != null && withAccount ? [
        // In a host it is a section of its own, already named: no second title.
        block(host ? null : t('kit.data.deleteTitle'), hint(t('kit.data.deleteHint', { app: product, n: deletionDays })),
          sharedOnDelete ? hint(sharedOnDelete) : null, row(remove)),
      ] : []),
    ];
  }

  /* ---------------------------------- about --------------------------------- */

  /**
   * What is running and whether it is the latest, the live channel, what the
   * app is and "by Cronum Studio". An installed app has no reload button, so
   * the new version can be checked by hand here.
   */
  function about() {
    // A module mounted in Work's shell watches no version of its own: the shell's watcher is the
    // whole app's, and so is its update (mount.js `workRegistry().updates`).
    const shell = options.updates ? null : workRegistry();
    const updates = options.updates || shell?.updates || null;
    const applyUpdate = shell?.updates ? shell.applyUpdate : options.applyUpdate;
    const serverLine = el('div', { class: 'kit-fact__value' });
    let running = el('div', { class: 'kit-fact' });
    let liveFact = el('div', { class: 'kit-fact' });
    // What runs and the live channel are known a moment after opening: painted again after each check.
    const paintFacts = () => {
      const loaded = updates?.loaded?.() || null;
      // In a host with one worker for everything, the whole app's version, with its name (update.js).
      running.replaceWith(running = fact(t('kit.about.version'), loaded?.app ? `${loaded.name ? `${loaded.name} ` : ''}v${loaded.app}` : '—',
        [loaded?.built ? formatDateTime(loaded.built) : null, loaded?.version].filter(Boolean).join(' · ')));
      liveFact.replaceWith(liveFact = fact(t('kit.about.live'), t(`kit.live.${options.live?.state || 'closed'}`)));
    };
    const check = async () => {
      clear(serverLine).append(hint(t('kit.about.checking')));
      const isNew = updates ? await updates.check({ announce: true }) : null;
      paintFacts();
      paintCards?.();
      clear(serverLine).append(...(isNew === null ? [hint(t('kit.about.unknown'))]
        : isNew ? newest() : [el('strong', { class: 'kit-fact__ok', text: t('kit.about.upToDate') })]));
    };
    // The number the server has, and the button to bring it in. The same number as the one running
    // means a new build of it: its date tells them apart.
    const newest = () => {
      const theirs = updates?.latest?.() || null;
      const loaded = updates?.loaded?.() || null;
      const sameNumber = theirs?.app && theirs.app === loaded?.app;
      return [
        el('strong', { text: theirs?.app ? `v${theirs.app}` : t('kit.about.newVersion') }),
        sameNumber && theirs.built ? el('span', { class: 'kit-hint', text: formatDateTime(theirs.built) }) : null,
        button(t('kit.about.update'), (event) => applyUpdate?.(event), 'primary'),
      ].filter(Boolean);
    };
    // In a host, the host's: its source, its icon, its name. A module's own are its card's below.
    const source = host ? hostInfo.source || `https://github.com/cronumstudio/${host.id}` : app.source || `https://github.com/cronumstudio/${app.id}`;
    const facts = el('div', { class: 'kit-facts' },
      running,
      liveFact,
      el('div', { class: 'kit-fact' }, el('span', { text: t('kit.about.latest') }), serverLine, button(t('kit.about.check'), check)),
      // The AGPL asks modified versions to offer their source.
      el('div', { class: 'kit-fact' }, el('span', { text: t('kit.about.source') }), el('a', { href: source, target: '_blank', rel: 'noopener', text: source.replace(/^https?:\/\//, '') })));
    const cards = host ? el('div', { class: 'kit-about-cards' }) : null;
    // The host's icon and its modules' names come with its answer of the modules: painted again then.
    const hostIcon = el('img', { alt: '', width: 54, height: 54 });
    const hostLine = el('p', {});
    const paintCards = host ? () => {
      if (closed) return;
      hostIcon.setAttribute('src', hostInfo.icon || '/icons/favicon.svg');
      const names = modulesHere().map((m) => (m.mount === host.mount ? app.name : m.name || m.mount));
      hostLine.textContent = t('kit.about.hostTagline', { apps: listFormat({ type: 'conjunction' }).format(names) });
      clear(cards).append(...modulesHere().map((m) => moduleCard(m)));
    } : null;
    paintFacts();
    paintCards?.();
    if (host) onModules.push(paintCards);
    check();
    const head = host
      ? el('div', { class: 'kit-about' }, hostIcon, el('div', {}, el('strong', { text: host.name }), hostLine))
      : el('div', { class: 'kit-about' },
        el('img', { src: at(app.icon || '/icons/favicon.svg'), alt: '', width: 54, height: 54 }),
        el('div', {}, el('strong', { text: app.name }), app.tagline ? el('p', { text: app.tagline }) : null));
    return [
      block(null, head),
      block(null, facts),
      // In a host, a card for each module in use, with its version: the whole app updates as one.
      ...(host ? [block(t('kit.about.modulesTitle'), hint(t('kit.about.modulesHint', { app: host.name })), cards)] : []),
      ...(options.aboutExtra && !host ? [options.aboutExtra()] : []),
      block(null, el('div', { class: 'kit-signature' }, signature())),
    ];
  }

  /**
   * A module's card in the host's About: its icon, name and line, the version of it this tab runs
   * (the server's until the tab has said), and a link to its website, where what it is is told.
   */
  function moduleCard(m) {
    const here = m.mount === host.mount;
    const name = here ? app.name : m.name || m.mount;
    const words = here ? null : moduleWords(m, currentLanguage(), () => paintCards());
    const taglineKey = m.settings?.tagline || 'app.tagline';
    const tagline = here ? app.tagline : typeof words?.[taglineKey] === 'string' ? words[taglineKey] : '';
    const updates = options.updates || workRegistry()?.updates;
    const version = (updates?.loaded?.()?.modules || updates?.latest?.()?.modules || {})[m.mount]?.app;
    // What it is, on its own website (`site`), in a tab of its own: not a page of Settings.
    const site = here ? options.site : m.settings?.site;
    return el('div', { class: 'kit-about-card' },
      el('img', { src: here ? at(app.icon || '/icons/favicon.svg') : m.icon, alt: '', width: 36, height: 36 }),
      el('div', { class: 'kit-about-card__text' },
        el('strong', { text: name }),
        tagline ? el('p', { text: tagline }) : null,
        el('small', { text: version ? `v${version}` : '—' }),
        typeof site === 'string' && site.startsWith('https://')
          ? el('a', { class: 'kit-link', href: site, target: '_blank', rel: 'noopener', text: t('kit.about.more', { app: name }) }) : null));
  }

  return { close, show };
}

/* --------------------------------- helpers --------------------------------- */

/**
 * The plan's features the kit can name (plans.js), in the order they are read, each with its
 * name in the catalogs (`kit.plan.benefits.<name>`, and `<name>Unlimited` for a limit without one).
 */
const BENEFITS = Object.freeze([
  ['lists.max', 'lists'], ['projects.max', 'projects'], ['notebooks.max', 'notebooks'],
  ['storage.mb', 'storage'], ['attachments', 'attachments'], ['files.per_note', 'filesPerNote'],
  ['sharing', 'sharing'], ['assign', 'assign'], ['publish', 'publish'], ['templates', 'templates'], ['activity', 'activity'],
  ['retention.days', 'retention'], ['history.days', 'history'], ['mcp', 'mcp'], ['mcp.calls_per_day', 'calls'],
  ['mcp.calls_per_week', 'callsWeek'],
]);

/**
 * What a plan includes as people read it: `features` as /api/me/entitlements gives them →
 * [{ text, included }], what is included first. A limit is a number, or null for none; a flag,
 * whether it is in. A key the kit doesn't name is left out, and so are the assistant's calls when
 * the assistant isn't included, and those of the day when they are counted by the week (a host's,
 * while a module of it still declares the daily ones).
 */
export function planBenefits(features = {}, { app = '' } = {}) {
  const lines = [];
  for (const [key, name] of BENEFITS) {
    if (!(key in features)) continue;
    const value = features[key];
    if (key.startsWith('mcp.calls_per_') && features.mcp === false) continue;
    if (key === 'mcp.calls_per_day' && 'mcp.calls_per_week' in features) continue;
    if (typeof value === 'boolean') {
      lines.push({ text: t(`kit.plan.benefits.${name}`, { app }), included: value });
    } else if (value === null) {
      lines.push({ text: t(`kit.plan.benefits.${name}Unlimited`, { app }), included: true });
    } else if (typeof value === 'number') {
      const size = key === 'storage.mb' ? (value >= 1024 ? `${numberText(value / 1024)} GB` : `${numberText(value)} MB`) : null;
      lines.push({ text: t(`kit.plan.benefits.${name}`, { n: value, size, app }), included: value > 0 });
    }
  }
  return [...lines.filter((l) => l.included), ...lines.filter((l) => !l.included)];
}

/**
 * An extra given on top of the plan as people read it ("Up to 100 lists"): `feature` as the grant
 * names it, perhaps with an app's prefix (`tasks.lists.max`). Empty for one the kit can't name.
 */
function benefitText(feature, value) {
  const key = String(feature || '');
  const known = (name) => BENEFITS.some(([k]) => k === name);
  const local = known(key) ? key : key.split('.').slice(1).join('.');
  return known(local) ? planBenefits({ [local]: value })[0]?.text || '' : '';
}

const numberText = (n) => new Intl.NumberFormat(currentLanguage(), { maximumFractionDigits: 1 }).format(n);

function fact(label, value, detail = '') {
  return el('div', { class: 'kit-fact' }, el('span', { text: label }), el('strong', { text: value }), detail ? el('small', { text: detail }) : null);
}

/** A browser and system from a user agent, short: "Chrome · Windows"; `unknown` without one. */
export function deviceName(agent = '', unknown = '—') {
  const text = String(agent || '');
  const browser = /Edg\//.test(text) ? 'Edge' : /OPR\//.test(text) ? 'Opera' : /Firefox\//.test(text) ? 'Firefox'
    : /Chrome\//.test(text) ? 'Chrome' : /Safari\//.test(text) ? 'Safari' : null;
  const system = /iPhone|iPad/.test(text) ? 'iOS' : /Android/.test(text) ? 'Android' : /Windows/.test(text) ? 'Windows'
    : /Mac OS X/.test(text) ? 'macOS' : /Linux/.test(text) ? 'Linux' : null;
  return [browser, system].filter(Boolean).join(' · ') || text.slice(0, 40) || unknown;
}

/** A text file saved on the device, made here: nothing goes to the server. */
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = el('a', { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Where a page's notices are kept: the app's /api/push/…, or in a host with one worker for
 * everything (worker.js) the host's at the root, one for every module, which a module without
 * notices of its own (Next, Notes) doesn't have under its path.
 */
async function pushApi() {
  return (await hostWorker()) ? api.root : api;
}

/**
 * Notices on this device: permission, the browser's subscription with the
 * install's key, and the server told, with the device's language.
 */
export async function subscribePush() {
  // Inside the suite's app its own notices are the device's one channel: never Web Push there too.
  if (inApp()) throw new Error('in_app');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('not_allowed');
  const push = await pushApi();
  const { public_key: key } = await push.get('/api/push/config');
  // The host's one worker where there is one, not a module's about to be retired (worker.js).
  const registration = await workerRegistration();
  const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (key.length % 4)) % 4));
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)),
  });
  const json = subscription.toJSON();
  await push.post('/api/push/subscribe', {
    endpoint: json.endpoint, keys: json.keys, label: navigator.userAgent.slice(0, 120), lang: currentLanguage(),
  });
  noticesRenewed();
  return subscription;
}
