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
