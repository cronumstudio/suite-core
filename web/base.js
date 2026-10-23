/**
 * Where the app is served from: `/` on its own, `/tasks/` as a module of a
 * host (suite-core host.js). Read from the kit's own address, because an app
 * loads the kit from `<its base>suite/`: there is nothing for an app to set,
 * and an app on its own sees no change.
 *
 *   import { at, BASE } from '../suite/base.js';
 *   fetch(at('/api/lists'));            // /api/lists on its own, /tasks/api/lists in a host
 *   location.pathname.slice(BASE.length - 1)   // the app's own path, wherever it is
 *
 * What is the whole host's stays at the root and is not passed through at():
 * /admin, /auth/… and /mcp.
 */

/** The base for a kit loaded from `kitUrl` (`…/suite/base.js`): its folder's parent, on a web page. */
export function baseOf(kitUrl) {
  try {
    const folder = new URL('../', kitUrl);
    return /^https?:$/.test(folder.protocol) ? folder.pathname : '/';
  } catch {
    return '/';
  }
}

export const BASE = baseOf(import.meta.url);

/** A path of the app (`/api/me`) at `base`; anything that isn't one (relative, another site) as it is. */
export const pathAt = (base, path) => (base !== '/' && typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')
  ? base + path.slice(1) : path);

/** A path of the app at this page's base. */
export const at = (path) => pathAt(BASE, path);

/**
 * Whether this page is a frame of another page of the same site: a host's module in its split
 * view (host.js `split`). Another site can't frame it (http.js), and its page can't be read here.
 */
export function framedIn(win = globalThis.window) {
  try {
    return Boolean(win) && win.top !== win.self && win.top.location.origin === win.location.origin;
  } catch {
    return false;
  }
}

export const FRAMED = framedIn();

/**
 * Between the host's split view and a module in one of its frames, both pages of the same site:
 * the view asks the module for its Settings with `kit:settings` on the frame's window (shell.js),
 * and the module says on its parent's when they open and close, `kit:settings-shown` with
 * `{ open, source }`, `source` its window (settings.js), so the view gives them the whole space.
 */
export const SETTINGS_EVENT = 'kit:settings';
export const SETTINGS_SHOWN_EVENT = 'kit:settings-shown';
/**
 * Settings in a frame sending the person to another module's section, on its parent's window:
 * `{ mount, start, source, handled }`, `source` the frame's window. The view opens it in the frame
 * that shows that module (with `kit:settings` and `{ start }`), or brings that module into the
 * frame that asked, and says `handled = true`; otherwise the whole window goes there.
 */
export const SETTINGS_GOTO_EVENT = 'kit:settings-goto';
/**
 * A link in a frame to another module's item (the Linked row, links.js), on its parent's window:
 * `{ url, mount, source, handled }`. The view opens it in the section that already shows that
 * module and says `handled = true`; otherwise the frame goes there itself, as any link.
 */
export const OPEN_EVENT = 'kit:open';

let modulesAsked = null;
/**
 * The host's answer of which modules there are (GET /api/modules at the root), asked once per page
 * by whoever needs it first (the rail, the Linked row): `{ status, answer }`, `answer` null unless
 * the host said yes. `fresh` asks again (back to the page, a module turned on or off).
 */
export function hostModules({ fresh = false, fetch: get = (...args) => globalThis.fetch(...args) } = {}) {
  if (fresh || !modulesAsked) {
    const asking = get('/api/modules', { credentials: 'same-origin' })
      .then(async (res) => ({ status: res.status, answer: res.ok ? await res.json() : null }));
    // Offline: the next one asks again.
    asking.catch(() => { if (modulesAsked === asking) modulesAsked = null; });
    modulesAsked = asking;
  }
  return modulesAsked;
}

/** The looks a host offers each person (host.js `LOOKS`): the suite's own, and Clean. */
export const LOOKS = Object.freeze(['cronum', 'clean']);
/** Where this browser keeps the look of last time, for theme.js to paint it before anything shows. */
export const LOOK_KEY = 'host.look';

/**
 * Paints a look now and keeps it for the next page (theme.js): `clean` sets `<html data-look>`,
 * anything else is the suite's own look, which needs nothing.
 */
export function applyLook(look, doc = globalThis.document) {
  const clean = look === 'clean';
  const root = doc?.documentElement;
  if (root) {
    if (clean) root.setAttribute('data-look', 'clean');
    else root.removeAttribute('data-look');
  }
  try {
    if (clean) localStorage.setItem(LOOK_KEY, 'clean');
    else localStorage.removeItem(LOOK_KEY);
  } catch { /* private mode: this page only */ }
}
