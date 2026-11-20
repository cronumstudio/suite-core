/**
 * What every module's page does as it starts, written once where each module wrote its own, and
 * what Cronum Work's shell shares with them:
 *
 * - `applyAppTheme(app, theme, place)`: the theme chosen, painted on the module's own page and kept
 *   for theme.js as `<app>.theme`; in a window of Cronum Work, told to the shell, whose theme is the
 *   page's. `followSystemTheme(app, { theme, signal })`: "the system's" followed while the page is
 *   open. `savedTheme(app)`: the one this browser keeps.
 * - `watchAppVersion({ app, show })`: the notice of a new version, under the frame's header.
 * - `askedSettings({ ready, open })`: Settings at the section another module sent the person to
 *   (`?settings=`, settings.js settingsAsked), opened once the module is ready for them.
 * - `markCroppedCanvas()`: an iPhone's Home Screen app drawn short of the screen, marked on `<html>`.
 * - `rgbOf(color)` and `PAINT_ATTRIBUTES`: a page's ground as a theme-color takes it, and the
 *   attributes that say how a page is painted.
 *
 *   applyAppTheme('notes', user.theme, place);
 *   followSystemTheme('notes', { theme: () => user.theme, signal });
 *   const updates = watchAppVersion({ app, show: (id, options) => shell.showBanner(id, options) });
 *
 * Nothing runs on import: a module's mount, or its boot.js, calls what it needs.
 */
import { t } from './i18n.js';
import { installed } from './base.js';
import { watchUpdates, applyUpdate } from './update.js';

/* --------------------------------- theme ---------------------------------- */

/** The themes a person chooses from in Settings: 'system' follows the device's. */
export const THEMES = Object.freeze(['light', 'dark', 'system']);

/** The attributes of `<html>` that say how a page is painted: its theme and its look (kit.css). */
export const PAINT_ATTRIBUTES = Object.freeze(['data-theme', 'data-look']);

const darkScreen = () => globalThis.matchMedia?.('(prefers-color-scheme: dark)') ?? null;

/** The theme this browser keeps for an app (`<app>.theme`, the one theme.js paints first): 'system' with none. */
export function savedTheme(app) {
  try { return globalThis.localStorage?.getItem(`${app}.theme`) || 'system'; } catch { return 'system'; }
}

/**
 * A theme chosen ('light', 'dark' or 'system'; anything else is 'system'). On an app's own page,
 * `<html data-theme>` resolved to light or dark, never "system", and the choice kept as
 * `<app>.theme`, which theme.js reads before the first paint of the next start. In a window of
 * Cronum Work (`embedded`) the page's theme is the shell's, one for every window: the shell is told
 * (`services.theme`), and paints and keeps it; with `ifOther`, only a theme other than the one it
 * has. `place` is the module's own (its `embedded` and `services`).
 * @returns {string} the theme chosen
 */
export function applyAppTheme(app, theme, { embedded = false, services = null, ifOther = false } = {}) {
  const chosen = THEMES.includes(theme) ? theme : 'system';
  if (embedded) {
    const shared = services?.theme;
    if (!ifOther || shared?.current?.() !== chosen) shared?.set?.(chosen);
    return chosen;
  }
  try { globalThis.localStorage?.setItem(`${app}.theme`, chosen); } catch { /* private mode: this page only */ }
  const dark = chosen === 'dark' || (chosen === 'system' && Boolean(darkScreen()?.matches));
  globalThis.document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  return chosen;
}

/**
 * "The system's" followed while an app's own page is open: the phone turning dark at nightfall
 * shows at once. `theme()` is the choice in force (by default the one this browser keeps). In
 * Cronum Work the shell follows the system for every window: a module there calls none. Its
 * listener goes with `signal`.
 */
export function followSystemTheme(app, { theme = () => savedTheme(app), signal } = {}) {
  darkScreen()?.addEventListener('change', () => { if (theme() === 'system') applyAppTheme(app, 'system'); }, { signal });
}

/**
 * A colour as `rgb()`, as a theme-color takes it (the kit's grounds are mixed in oklab, which it
 * may not). A colour with nothing of it showing gives `transparent`: by default null, nothing to
 * paint.
 */
export function rgbOf(color, { transparent = null } = {}) {
  const pen = globalThis.document?.createElement('canvas').getContext?.('2d', { willReadFrequently: true });
  if (!pen) return null;
  pen.fillStyle = color;
  pen.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = pen.getImageData(0, 0, 1, 1).data;
  return a ? `rgb(${r}, ${g}, ${b})` : transparent;
}

/* ----------------------------- a new version ------------------------------ */

/**
 * The notice of a new version, for an app on its own page: an installed app has no reload button,
 * so without it an old version of the code could run for days without anyone knowing. The banner
 * stays until it is acted on or closed, and comes back on the next round. `show(id, options)`
 * draws it, `options` a function that writes it in the language of the moment (the frame's
 * showBanner takes one). In Cronum Work the notice is the whole app's, named after it (update.js);
 * the rest of `options` goes to watchUpdates.
 * @returns the watcher (update.js watchUpdates: `check`, `dismiss`, `stop`…)
 */
export function watchAppVersion({ app, show, ...options }) {
  const updates = watchUpdates({
    ...options,
    onUpdate: (latest) => show('update', () => ({
      kind: 'accent', iconName: 'refresh', text: t('kit.update.availableNamed', { app: latest?.name || app.name }),
      action: { label: t('kit.update.apply'), onClick: applyUpdate },
      onClose: () => updates.dismiss(),
    })),
  });
  return updates;
}

/* ---------------------------- Settings asked for --------------------------- */

/**
 * A section of Settings asked for (`?settings=<id>`: another module's Settings sent the person to
 * one of this one's sections), opened once the module can show them: `ready()` says whether it
 * can now (its frame drawn, who is signed in known), and the module calls `open()` again whenever
 * that may have changed. Settings open once for each section asked.
 *
 *   const asked = askedSettings({ ready: () => Boolean(frame()), open: (start) => settings(start) });
 *   asked.fromAddress();          // on its own page, with a `?settings=` in the address
 *   asked.ask(route.settings);    // a route the shell gave, opened by the next open()
 *
 * → { ask(section), open(), fromAddress() }
 */
export function askedSettings({ ready, open }) {
  let section = null;
  const asked = {
    /** The section asked for, or none: open() opens it once the module is ready. */
    ask(id) { section = id || null; },
    /** Settings at the section asked for, if one is and the module is ready. → whether they opened. */
    open() {
      if (!section || !ready()) return false;
      const start = section;
      section = null;
      open(start);
      return true;
    },
    /** The section the page's address names, taken off it, then opened as open() does: Settings' code loads only then. */
    fromAddress() {
      return import('./settings.js').then((m) => { asked.ask(m.settingsAsked()); asked.open(); }).catch(() => {});
    },
  };
  return asked;
}

/* ---------------------------- the iPhone canvas ---------------------------- */

/**
 * Installed on an iPhone, iOS draws only the first `innerHeight` points of the screen and fills the
 * rest with the document's background: measured on one with a dynamic island, 812 drawn of 874,
 * anchored at the top. That dead strip already keeps the home indicator clear, so the room kept
 * for it inside the app counted it twice, and the add bar floated high above the bottom.
 *
 * It is marked on the document and the app's sheet decides (`data-canvas="cropped"`). It is
 * checked rather than assumed for every installed app: on Android the app is drawn to the edge
 * and there that room is needed. A module's own page checks it once and on every `resize`.
 */
export function markCroppedCanvas() {
  // Installed on the home screen: the kit's one way of telling.
  const onHomeScreen = installed();
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // In landscape it can't be compared: `screen` still gives the portrait measures. The mark is
  // left as it was and checked again when the phone is turned back.
  const portrait = window.innerHeight > window.innerWidth;
  if (!onHomeScreen || !isIOS || !portrait || !window.screen?.height) return;

  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;visibility:hidden;'
    + 'height:env(safe-area-inset-top,0px)';
  document.body.append(probe);
  const inset = probe.getBoundingClientRect().height;
  probe.remove();

  // The crop's signature: screen left over, and exactly the clock's gap. Where the app is drawn
  // to the edge nothing is left over and this stays off.
  const extra = Math.round(window.screen.height - window.innerHeight);
  const cropped = inset > 0 && Math.abs(extra - inset) <= 2;
  if (cropped) document.documentElement.dataset.canvas = 'cropped';
  else delete document.documentElement.dataset.canvas;
}
