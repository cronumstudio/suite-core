/**
 * The install's terms and privacy policy, accepted once by every account made from this version on,
 * and the record of it on the account: when it accepted and which version (`TERMS_VERSION`).
 *
 * Off when the install links neither page (`TERMS_URL`, `PRIVACY_URL`, about.js): a copy run
 * without legal pages asks nobody and shows nothing of this.
 *
 * Who is asked: an account made in a request (signing up, a provider's first sign-in, an
 * assistant's first call, an administrator making it) is marked `terms_asked` as it is made
 * (`noteCreated`, accounts.whenCreated). Accounts made before this version are never asked: the
 * column comes with 0 for every row that was already there (suite migration 41), and so do those
 * an import brings (made `quiet`, they were already in use where they come from) or a script makes
 * (the first administrator). A marked account that has not accepted is `blocked`: its browser
 * sessions get 403 `terms_required` on every route of the API but the few the page of the terms
 * needs (`OPEN_ROUTES`), and the kit (web/api.js) takes the page there. Bearer tokens (the MCP, a
 * phone's device token, API tokens) are never asked: they are not someone in front of a screen.
 *
 * Where it is accepted:
 * - the kit's sign-in, where it makes an account: the box beside «Create an account» (a provider's
 *   sign-up) and in the form of a local sign-up. Under a provider, the form is posted to
 *   `/auth/login` and the tick is held on the server under the sign-in's state (`hold`), never in
 *   its cookie, and taken at the callback (`take`), where it is recorded; only when the post came
 *   from this site's own page (`postedHere`), so a link or another site's form can't tick it for
 *   someone. The kit posts it with `fetch` and is answered the provider's address as JSON
 *   (`answersWithAddress`), which it then opens: a form posted to the page's own server and
 *   redirected to the provider's would be stopped by the pages' `form-action 'self'`;
 * - `TERMS_PATH`, the page for whoever came in without that box (the provider's own «Sign up»,
 *   a phone, an assistant first): the callback sends a new account there before anything else.
 *
 *   const terms = createTerms({ database, settings: install.terms, audit });
 *   accounts.whenCreated(terms.noteCreated);
 *   registerTermsApi(api, { terms, serializeUser });   // GET and POST /api/auth/terms
 */
import { sendJson, readJson, requireUser, badRequest, localPath, SIGN_IN_FLOW_SECONDS } from './http.js';
import { ensureColumn } from './migrate.js';
import { currentRequest } from './request-scope.js';
import { iso } from './time.js';

/** The page where an account that has not accepted them accepts them. */
export const TERMS_PATH = '/auth/terms';

/** What that page needs while the account has not accepted: everything else answers 403 `terms_required`. */
export const OPEN_ROUTES = Object.freeze(['/api/auth/config', '/api/auth/logout', '/api/auth/terms']);

/** A version as TERMS_VERSION writes it: a date (2026-12-08) or a short name of letters, digits, `.`, `_`, `-`. */
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** The most sign-ins in progress whose tick is held: past them, the oldest goes first. */
const HELD_MAX = 10000;

/**
 * The install's terms, from the legal links about.js read and TERMS_VERSION: `{ terms, privacy,
 * version }`, or null when neither page is linked. A version that isn't one is said in `warnings`
 * and left out, as is a version without pages to go with it; without one, acceptances are recorded
 * without a version, and that is said too.
 */
export function termsFromEnv(env = {}, links = {}, warnings = []) {
  const terms = links?.terms ?? null;
  const privacy = links?.privacy ?? null;
  let version = String(env.TERMS_VERSION ?? '').trim() || null;
  if (version && !VERSION.test(version)) {
    warnings.push(`TERMS_VERSION "${version.slice(0, 60)}" is not a date or a short name (letters, digits, . _ -, 40 at most): it is left out`);
    version = null;
  }
  if (!terms && !privacy) {
    if (version) warnings.push('TERMS_VERSION is set but neither TERMS_URL nor PRIVACY_URL is: nobody is asked to accept anything');
    return null;
  }
  if (!version) warnings.push('TERMS_URL or PRIVACY_URL is set without TERMS_VERSION: new accounts accept them with no version recorded');
  return { terms, privacy, version };
}

/**
 * Migration 41: whether an account must accept the terms (made from this version on), and when it
 * accepted them and which version. Every account already there gets 0: it is never asked.
 */
export function termsSchema(d) {
  ensureColumn(d, 'users', 'terms_asked', 'terms_asked INTEGER NOT NULL DEFAULT 0');
  ensureColumn(d, 'users', 'terms_accepted_at', 'terms_accepted_at TEXT');
  ensureColumn(d, 'users', 'terms_version', 'terms_version TEXT');
}

/**
 * Whether a post to `/auth/login` came from this site's own page: its Origin is this server, or the
 * browser says the request is same-origin (Sec-Fetch-Site, which no page can forge; under
 * `Referrer-Policy: no-referrer` a form posted to its own server sends `Origin: null`). Without
 * either, it is not taken as this site's.
 */
export function postedHere(req, baseUrl = '') {
  if (req?.method !== 'POST') return false;
  const origin = req.headers?.origin;
  const site = req.headers?.['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  if (origin && origin !== 'null') {
    let host = null;
    let own = null;
    try { host = new URL(origin).host; } catch { return false; }
    try { own = baseUrl ? new URL(baseUrl).host : null; } catch { /* no base URL */ }
    return host === req.headers?.host || host === own;
  }
  return site === 'same-origin';
}

/**
 * Whether `/auth/login` answers the provider's address as JSON (`{ location }`) instead of a
 * redirect: a post from the kit's sign-in, which asks for it, then opens it itself.
 */
export function answersWithAddress(req) {
  return req?.method === 'POST' && /application\/json/i.test(String(req.headers?.accept || ''));
}

/** A small form's body (`terms=1`), read whole up to 2 KB: anything bigger or broken is no tick. */
function readSmallForm(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2048) { resolve(new URLSearchParams()); req.destroy?.(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(new URLSearchParams()); }
    });
    req.on('error', () => resolve(new URLSearchParams()));
  });
}

/**
 * @param {object} options
 * @param {object} options.database
 * @param {object|null} options.settings   termsFromEnv()'s: null, off
 * @param {object} [options.audit]         each acceptance in the activity log, with its version
 */
export function createTerms({ database, settings = null, audit = null, baseUrl = '', clock = () => Date.now(), log = console.log }) {
  const on = Boolean(settings && (settings.terms || settings.privacy));
  let columns = null;
  const hasColumns = () => (columns ??= database.columnsOf('users').includes('terms_asked'));

  /** The account must accept them and has not: its sessions see only the page of the terms. */
  function blocks(user) {
    return on && Boolean(user) && Number(user.terms_asked) === 1 && !user.terms_accepted_at;
  }

  /** The same, for an account by its id, read now (one just made, whose row came before its mark). */
  function blocksId(userId) {
    if (!on || !hasColumns()) return false;
    return blocks(database.get('SELECT terms_asked, terms_accepted_at FROM users WHERE id = ?', userId));
  }

  /**
   * accounts.whenCreated: an account made in a request is asked, whether the install links its
   * pages yet or not (one that links them later asks those made since, who never accepted them).
   * Inside the account's transaction, so it never throws.
   */
  function noteCreated(user) {
    if (!user?.id || !hasColumns() || !currentRequest()) return;
    try {
      database.run('UPDATE users SET terms_asked = 1 WHERE id = ?', user.id);
      user.terms_asked = 1;
    } catch (err) {
      log(`[terms] a new account could not be marked to accept the terms: ${err?.message || err}`);
    }
  }

  /**
   * The account accepts them now, in the version in force: recorded once (a second time changes
   * nothing) and in the activity log. → whether it was recorded.
   */
  function accept(userId, { req = null } = {}) {
    if (!on || !hasColumns()) return false;
    const at = iso(clock());
    const done = database.run('UPDATE users SET terms_accepted_at = ?, terms_version = ? WHERE id = ? AND terms_accepted_at IS NULL',
      at, settings.version ?? null, userId).changes > 0;
    if (done) audit?.record({ action: 'auth.terms_accept', actor: userId, req, meta: { version: settings.version ?? null } });
    return done;
  }

  /** What the browser needs to draw the box: the two links and the version, or null when off. */
  const links = () => (on ? { terms: settings.terms ?? null, privacy: settings.privacy ?? null, version: settings.version ?? null } : null);

  /** The page of the terms, coming back to `next` (a path of this site) once they are accepted. */
  const pageFor = (next = '/') => {
    const back = localPath(next);
    return back === '/' ? TERMS_PATH : `${TERMS_PATH}?return=${encodeURIComponent(back)}`;
  };

  /* ------------------- the tick, across a provider's sign-in ------------------- */

  /** The sign-ins in progress whose form had the box ticked, by state: when each stops counting. */
  const held = new Map();
  const heldFor = SIGN_IN_FLOW_SECONDS * 1000;
  const dropExpired = () => {
    const now = clock();
    for (const [state, until] of held) {
      if (until > now) break;
      held.delete(state);
    }
  };

  /**
   * `/auth/login`: whether the request is this site's form with the box ticked (`terms=1` posted
   * from its own page). Reads the body of a post; a GET, a link or another site's form never ticks it.
   */
  async function tickedAt(req) {
    if (!on || !postedHere(req, baseUrl)) return false;
    if (!/application\/x-www-form-urlencoded/i.test(String(req.headers?.['content-type'] || ''))) return false;
    return (await readSmallForm(req)).get('terms') === '1';
  }

  /** Keeps that the sign-in of `state` had the box ticked, for as long as a sign-in may take. */
  function hold(state) {
    if (!on || !state) return;
    dropExpired();
    held.delete(String(state));
    while (held.size >= HELD_MAX) held.delete(held.keys().next().value);
    held.set(String(state), clock() + heldFor);
  }

  /** Back from the provider with that state: whether its box was ticked, forgotten now. */
  function take(state) {
    dropExpired();
    const key = String(state ?? '');
    const ticked = held.has(key);
    held.delete(key);
    return ticked;
  }

  /**
   * The callback's last step, once the session is open: the tick recorded, and where the browser
   * goes, the page of the terms first for an account that has yet to accept them.
   */
  function afterSignIn(userId, { ticked = false, req = null, next = '/' } = {}) {
    if (ticked) accept(userId, { req });
    return blocksId(userId) ? pageFor(next) : next;
  }

  return { on, links, blocks, blocksId, noteCreated, accept, pageFor, tickedAt, hold, take, afterSignIn };
}

/**
 * The routes of the page of the terms, open to an account that has yet to accept them:
 * GET says whether it must and what (with who is signed in, for the page's language and theme);
 * POST `{ accept: true }` records it.
 */
export function registerTermsApi(router, { terms, accounts, serializeUser }) {
  const answer = (user) => ({
    required: terms.blocks(user), ...(terms.links() || { terms: null, privacy: null, version: null }),
    accepted_at: user.terms_accepted_at ?? null, accepted_version: user.terms_version ?? null,
    user: serializeUser(user),
  });

  router.get('/api/auth/terms', (ctx) => {
    sendJson(ctx.res, 200, answer(requireUser(ctx)));
  });

  router.post('/api/auth/terms', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    if (body?.accept !== true) throw badRequest('field_required', { field: 'accept' });
    terms.accept(user.id, { req: ctx.req });
    sendJson(ctx.res, 200, answer(accounts.byId(user.id)));
  });
}
