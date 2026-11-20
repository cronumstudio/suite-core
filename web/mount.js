/**
 * A module mounted in a page that isn't its own: Cronum Work's one-document shell opens each
 * module in a window of one page with `mount(root, ctx)` (the module's main.js), instead of a page
 * or a frame per module (architecture §21, Work's r2/ventanas.md). What the kit needs for it:
 *
 * - `workRegistry()`: the shell's services for the whole page (`document[Symbol.for('cronum.work')]`:
 *   `open`, `live`, `theme`, `language`, `signOut`, the one way out, and `updates` and `applyUpdate`,
 *   the whole app's version for Settings' About), which the kit reaches without a ctx. Null on any other page, where the
 *   kit does what it always did.
 * - `ownerOf()`: the module this copy of the kit belongs to (`/notes/suite/…` → `notes`): each module
 *   loads the kit from its own address, so each has its own copy in the page.
 * - `markOwned(node)`: what this copy hangs on the page's body (toasts, dialogs, menus, the drag
 *   ghost) says whose it is, with the page's theme, look and language, so the module's sheet
 *   scoped to its windows (`?scope=work`) reaches it. Only in the shell's page.
 * - `createPlace()`: where a module is, its place.js, written once: the ctx a window's mount() is
 *   given, and on its own page what that ctx would be.
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
 * Where a module is: the whole page on its own (its boot.js mounts it without a ctx), or a window
 * of Cronum Work's one-document shell, whose ctx its `mount(root, ctx)` is given (Work's
 * shell/work.js `contextOf`). Every route the module reads and every move it makes goes through
 * here instead of `location` and `history`, and what it hangs goes where it is drawn, so modules in
 * one document don't take each other's address, listeners or body. A module's place.js is then
 * only what is its own:
 *
 *   const here = createPlace({ hash: true, own: { get hash() { return here.route(); } } });
 *   export const { place } = here;   // here.placeIn(root, ctx) in mount(), here.placeOut() in unmount()
 *
 * `place`, what the module's code reads: `embedded`, `root`, `mounted`, `services`, `active`,
 * `signal` (the mount's), `retitle()`, `lateCode()`, `reload()` with `reload: true`, and the
 * module's `own` members, getters and methods, which may stand for one of these (Projects' and
 * Next's `lateCode` is a getter: `here.lateCode()` is still the kit's).
 * `route()`, `navigate(route, { replace })` and `onRoute(fn, { signal })` go through the ctx in a
 * window. On its own page the route is the page's hash (`hash: true`), or its address after its
 * base, which the view never moves there: only a `replace` writes it, and nothing is watched.
 *
 * @param {object} [options]
 * @param {boolean} [options.hash]  on its own page its routes are the page's hash (Notes, Next)
 * @param {(said: *) => boolean} [options.active]  what the shell's `active()` answer means (Boolean)
 * @param {boolean} [options.reload]  `place.reload({ fresh })`: the page again
 * @param {object} [options.own]  the module's own members of `place`
 * @param {string} [options.base]  its base, where its address starts (BASE)
 */
export function createPlace({ hash = false, active = Boolean, reload = false, own = {}, base = BASE } = {}) {
  let ctx = null;
  let root = null;
  let signal;
  /** The mount's own signal, when placeIn() wasn't given one. */
  let listening = null;
  const page = () => globalThis.window;

  /** The route: the window's, or on its own page its hash, or its address after its base. */
  function route() {
    if (ctx) return String(ctx.route() ?? '');
    const { pathname = '', search = '', hash: fragment = '' } = page().location;
    return hash ? fragment : pathname.slice(base.length) + search + fragment;
  }

  /** To `to`: a new step of the history, which Back undoes, or written over the last one (`replace`). */
  function navigate(to, { replace = false } = {}) {
    if (ctx) {
      if (replace) ctx.navigate(to, { replace: true });
      else ctx.navigate(to);
      return;
    }
    const win = page();
    if (replace) win.history.replaceState(null, '', hash ? to : new URL(to, win.location.href).href);
    else if (hash) win.location.hash = to;
  }

  /** `fn(route)` when the route changes under the module (the shell's Back, a link), until `signal` aborts. */
  function onRoute(fn, { signal: until } = {}) {
    if (ctx) ctx.onRoute?.(fn, { signal: until });
    else if (hash) page().addEventListener('hashchange', () => fn(route()), { signal: until });
  }

  /** Whether newer code took over the page: then nothing loads late (the shell shows its notice of the new version). */
  const lateCode = () => Boolean(ctx?.lateCode?.());

  const place = {
    /** Inside Cronum Work's shell: no worker, version notice or address of its own, the shell's theme. */
    get embedded() { return Boolean(ctx); },
    /** What it draws in and hangs its own sheets and menus from: its window, or the page's body. */
    get root() { return root ?? globalThis.document?.body ?? null; },
    /** Whether it is drawn somewhere now (between placeIn and placeOut). */
    get mounted() { return root !== null; },
    /** The shell's services (theme, language, who is signed in), when it gives them. */
    get services() { return ctx?.services ?? null; },
    /** Whether the keyboard is its: always on its own page, in Cronum Work while its window has the focus. */
    get active() { return ctx ? active(ctx.active?.()) : true; },
    /** Aborted when it is taken off the page: every listener on `window`, `document` or a media query carries it. */
    get signal() { return signal; },
    /** Its window's name changed: the shell asks the handle's title() again (one from before `retitle` only when it moves). */
    retitle() { ctx?.retitle?.(); },
    lateCode,
    ...(reload ? {
      /**
       * The page again, as at the start (the session ended, someone else signed in). `fresh`, on its
       * own page, skips what the browser kept (`?fresh=`). In Cronum Work the page is the shell's,
       * and loading it again starts every window.
       */
      reload({ fresh = false } = {}) {
        const { location } = page();
        if (fresh && !ctx) location.replace(`${location.pathname}?fresh=${Date.now()}`);
        else location.reload();
      },
    } : {}),
  };
  Object.defineProperties(place, Object.getOwnPropertyDescriptors(own));

  /**
   * Set by mount(): from now on the module is drawn in `where`, with the window's `context` in Cronum
   * Work (or null). The mount's signal is `signal` when given; else one of its own, which the next
   * placeIn(), placeOut() and the shell's own signal abort. → the mount's signal
   */
  function placeIn(where, context = null, { signal: given } = {}) {
    listening?.abort();
    listening = null;
    root = where ?? null;
    ctx = context || null;
    if (given !== undefined) {
      signal = given;
      return signal;
    }
    const mounted = new AbortController();
    // The shell aborts its own after unmount(): whatever the module still listened to goes with it.
    ctx?.signal?.addEventListener('abort', () => mounted.abort(), { once: true, signal: mounted.signal });
    listening = mounted;
    signal = mounted.signal;
    return signal;
  }

  /** Set by unmount(): every listener of that mount goes, and the module is nowhere until mounted again. */
  function placeOut() {
    listening?.abort();
    listening = null;
    signal = undefined;
    root = null;
    ctx = null;
  }

  return { place, placeIn, placeOut, route, navigate, onRoute, lateCode };
}
