/**
 * A module mounted in a page that isn't its own: Cronum Work's one-document shell opens each
 * module in a window of one page with `mount(root, ctx)` (the module's main.js), instead of a page
 * or a frame per module (architecture §21, Work's r2/ventanas.md). What the kit needs for it:
 *
 * - `workRegistry()`: the shell's services for the whole page (`document[Symbol.for('cronum.work')]`:
 *   `open`, `live`, `theme`, `language`, and `updates` and `applyUpdate`, the whole app's version
 *   for Settings' About), which the kit reaches without a ctx. Null on any other page, where the
 *   kit does what it always did.
 * - `ownerOf()`: the module this copy of the kit belongs to (`/notes/suite/…` → `notes`): each module
 *   loads the kit from its own address, so each has its own copy in the page.
 * - `markOwned(node)`: what this copy hangs on the page's body (toasts, dialogs, menus, the drag
 *   ghost) says whose it is, with the page's theme, look and language, so the module's sheet
 *   scoped to its windows (`?scope=work`) reaches it. Only in the shell's page.
 * - `standaloneCtx()`: the ctx of an app on its own page, from its address and its history.
 */
import { BASE } from './base.js';

const REGISTRY = Symbol.for('cronum.work');

/** The shell's services for the page, or null outside Cronum Work's one-document shell. */
export function workRegistry(doc = globalThis.document) {
  return doc?.[REGISTRY] || null;
}

/** The module a base belongs to (`/notes/` → notes); null at the root, an app on its own. */
export const ownerOf = (base = BASE) => /^\/([a-z][a-z0-9-]{1,30})\/$/.exec(base)?.[1] || null;

/** The page's attributes a piece of a module carries, read by its scoped sheet (`:scope[data-theme]`). */
export const COPIED = Object.freeze(['data-theme', 'data-look', 'lang']);

/**
 * Marks `node` as this copy's module's, in the shell's page; anywhere else it is left as it is.
 * @returns {Element} the node
 */
export function markOwned(node, { base = BASE, doc = globalThis.document } = {}) {
  const owner = ownerOf(base);
  if (!node || !owner || !workRegistry(doc)) return node;
  node.setAttribute('data-owner', owner);
  const html = doc.documentElement;
  for (const name of COPIED) {
    const value = html?.getAttribute(name);
    if (value == null) node.removeAttribute(name);
    else node.setAttribute(name, value);
  }
  return node;
}

/**
 * The ctx of an app on its own page: its route is its address after its base (`#/n/55`,
 * `list/12`), moved with the history; it always has the keyboard; a link elsewhere is a page.
 * @param {object} [options]
 * @param {string} [options.base]  the app's base
 * @param {boolean} [options.hash] the app's routes live in the hash (Notes, Next)
 */
export function standaloneCtx({ base = BASE, hash = false, win = globalThis.window } = {}) {
  const loc = () => win.location;
  const route = () => (hash ? loc().hash : loc().pathname.slice(base.length) + loc().search + loc().hash);
  return {
    embedded: false,
    module: ownerOf(base),
    base,
    root: win.document.body,
    signal: undefined,
    route,
    navigate(next, { replace = false } = {}) {
      if (route() === next) return;
      if (hash && !replace) { loc().hash = next; return; }
      const url = hash ? next : base + String(next).replace(/^\//, '');
      win.history[replace ? 'replaceState' : 'pushState'](null, '', url);
    },
    onRoute(fn, { signal } = {}) {
      const on = () => fn(route());
      win.addEventListener(hash ? 'hashchange' : 'popstate', on, { signal });
    },
    active: () => true,
    open(target) {
      if (typeof target === 'string' && target.startsWith('/')) { loc().assign(target); return Promise.resolve(true); }
      return Promise.resolve(false);
    },
    services: undefined,
  };
}
