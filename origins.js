/**
 * Where each account came from, and what each origin brought: for whoever runs an install to see
 * which of the places it is talked about bring people who stay and pay. Off unless the app says
 * `modules.origins`. It keeps no visitor: nothing is written on anyone's device for it (no cookie
 * of its own, no local storage), and no address, browser or identifier of a visit is kept.
 *
 * What it knows of an account, each kept apart and only when the account is made:
 *   src       the tag of the link they followed (`?src=reddit-mcp`), as whoever published the link
 *             wrote it: 1 to 40 of a-z, 0-9, `.`, `_` and `-`, in lower case. Text from outside,
 *             so anything else is no tag. `?utm_source=` and `?ref=` (what some sites add to the
 *             links they list) count when there is no `src`
 *   referrer  the site they came from, its domain alone (`reddit.com`), never the page; an app on a
 *             phone that opened the link is its package (`com.reddit.frontpage`)
 *   entry     how the account was made: `web` (signing in on a page), `app` (from the phone app's
 *             connect page), `mcp` (an assistant connected first, and the account was made for
 *             its token) or `other`
 * The first of each stays: an account is made once, and nothing later writes over it.
 *
 * How they get here without being kept in the browser: in the address. A page that links to the
 * sign-in says them in the link (`/auth/login?src=…&via=…`; the kit's sign-in adds them from the
 * page's own address and `document.referrer`, web/signin.js), and the sign-in carries them to the
 * provider and back in what it already keeps for that (the sign-in's own state: workos-accounts.js
 * and oidc.js, 30 minutes, gone on return). `fromLogin` reads them, `pack`/`arriving` carry them,
 * and `noteCreated` (accounts.whenCreated) writes them with the account, in its transaction.
 *
 * Every payment is noted with its account's origin as it was then (`origin_payments`), since
 * billing.js keeps what someone has now and not what they paid: the web provider's `payment`
 * events (billing.whenPaid, with what was charged, tax included, in the currency's smallest unit)
 * and the stores' purchases and renewals (stores.whenApplied), which bring no amount: theirs is
 * the product's `amount` in `stores.products`, marked `estimated`. A refund marks its payment. An
 * account that goes takes its origin with it; its payments stay as figures, with no one's name.
 *
 *   const origins = createOrigins({ database, accounts, baseUrl, products, log });
 *   accounts.whenCreated(origins.noteCreated); accounts.whenRemoved(origins.forget);
 *   billing.whenPaid((paid) => origins.paid(paid, { provider: billing.provider }));
 *   billing.whenRefunded((refund) => origins.refunded(refund, { provider: billing.provider }));
 *   stores.whenApplied(origins.applied);
 *   registerOriginsApi(api, { origins });   // GET /api/admin/users/:id/origin
 */
import { sendJson, requireAdmin, notFound, int, parseCookies } from './http.js';
import { currentRequest } from './request-scope.js';
import { iso } from './time.js';

/** A link's tag: what `?src=` may say. */
const TAG = /^[a-z0-9][a-z0-9._-]{0,39}$/;
/** A site's domain, or an app's package: labels of letters, digits and dashes, 80 characters at most. */
const HOST = /^(?=.{3,80}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9_-]{0,23}$/;
/** How an account can have been made. */
export const ENTRIES = Object.freeze(['web', 'app', 'mcp', 'other']);

/** The tag as it is kept, or null when it can't be one. */
export function cleanTag(value) {
  if (typeof value !== 'string') return null;
  const tag = value.trim().toLowerCase();
  return TAG.test(tag) ? tag : null;
}

/**
 * The domain of a site, from its address or its name, without `www.`; null when it is none, or one
 * of `own` (or under one): this install's and its sign-in's are nobody's origin.
 */
export function cleanHost(value, own = []) {
  if (typeof value !== 'string') return null;
  let host = value.trim().toLowerCase();
  if (!host || host.length > 2000) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try { host = new URL(host).hostname; } catch { return null; }
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (!HOST.test(host)) return null;
  return own.some((mine) => host === mine || host.endsWith(`.${mine}`)) ? null : host;
}

/**
 * Migration 36: each account's origin, and each payment with the origin its account had.
 * `origin_payments.amount` is in the currency's smallest unit; `estimated` when it is the
 * product's listed amount and not what the provider said it charged.
 */
export function originsSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS account_origins (
    user_id  INTEGER PRIMARY KEY,
    src      TEXT,
    referrer TEXT,
    entry    TEXT NOT NULL,
    at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_account_origins_at ON account_origins (at);
  CREATE TABLE IF NOT EXISTS origin_payments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER,
    provider     TEXT NOT NULL,
    ref          TEXT NOT NULL,
    subscription TEXT,
    product      TEXT,
    plan         TEXT,
    amount       INTEGER,
    currency     TEXT,
    first        INTEGER NOT NULL DEFAULT 0,
    estimated    INTEGER NOT NULL DEFAULT 0,
    src          TEXT,
    referrer     TEXT,
    entry        TEXT,
    heard        TEXT,
    at           TEXT NOT NULL,
    refunded_at  TEXT,
    UNIQUE (provider, ref)
  );
  CREATE INDEX IF NOT EXISTS ix_origin_payments_user ON origin_payments (user_id);
  CREATE INDEX IF NOT EXISTS ix_origin_payments_at ON origin_payments (at);`);
}

/** How many of a currency's smallest unit make one: 100 for EUR, 1 for JPY. */
function minorUnits(currency) {
  try {
    return 10 ** new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 100;
  }
}

/**
 * @param {object} options
 * @param {object} options.database
 * @param {string} [options.baseUrl]        this install's address: its own host is nobody's origin
 * @param {string[]} [options.ownHosts]     other hosts that are no origin (the sign-in provider's)
 * @param {object} [options.products]       the web's catalog (`products`): each product's plan
 * @param {object} [options.storeProducts]  the stores' (`stores.products`): plan, and `amount` and `currency`
 * @param {string} [options.appCookie]      the cookie of the phone app's connect page: a sign-in
 *   that carries it was started from the app (device-pages.js)
 */
export function createOrigins({
  database, baseUrl = '', ownHosts = [], products = {}, storeProducts = {}, appCookie = null,
  clock = () => Date.now(), log = console.log,
}) {
  const own = [...new Set([cleanHost(baseUrl), ...ownHosts.map((host) => cleanHost(host))].filter(Boolean))];
  /** What a sign-in brought, by its request, until the account is made in it (noteCreated). */
  const arrivals = new WeakMap();

  /* --------------------------- from a link to the account --------------------------- */

  /**
   * What `/auth/login` says of where someone comes from: `src` and `via` in its own address, else
   * in the address of the page it goes back to (`return`, where the kit's sign-in puts the page it
   * was on), and for the site, at last, the request's Referer. → { src, via }, each or null.
   */
  function fromLogin(req, url) {
    let back = new URLSearchParams();
    try { back = new URL(url.searchParams.get('return') || '/', 'http://local').searchParams; } catch { /* none */ }
    const tagOf = (name) => cleanTag(url.searchParams.get(name)) || cleanTag(back.get(name));
    return {
      src: tagOf('src') || tagOf('utm_source') || tagOf('ref'),
      via: cleanHost(url.searchParams.get('via'), own) || cleanHost(back.get('via'), own) || cleanHost(req?.headers?.referer, own),
    };
  }

  /** What the sign-in carries of it to the provider and back, in its own state: a short text, or ''. */
  function pack({ src = null, via = null } = {}) {
    return src || via ? Buffer.from(JSON.stringify([src, via])).toString('base64url') : '';
  }

  /** Back from the provider: what the sign-in carried, checked again, kept for the account made in this request. */
  function arriving(req, packed) {
    if (!req || !packed) return;
    try {
      const [src, via] = JSON.parse(Buffer.from(String(packed), 'base64url').toString('utf8'));
      const came = { src: cleanTag(src), via: cleanHost(via, own) };
      if (came.src || came.via) arrivals.set(req, came);
    } catch {
      // Not what pack() wrote: nothing.
    }
  }

  /**
   * accounts.whenCreated: the account's origin, written with it. Inside the account's transaction,
   * so it never throws. Not for an account the admin makes, nor for one made outside a request (an
   * import, a script): those came from nowhere a link or a site could say.
   */
  function noteCreated(user) {
    if (!user?.id) return;
    try {
      const scope = currentRequest();
      if (!scope?.req || scope.path.startsWith('/api/admin/')) return;
      const came = arrivals.get(scope.req) || {};
      arrivals.delete(scope.req);
      const fromApp = Boolean(appCookie && parseCookies(scope.req)[appCookie] != null);
      const entry = /(^|\/)mcp$/.test(scope.path) ? 'mcp'
        : fromApp ? 'app'
          : /^\/(api\/)?auth\//.test(scope.path) ? 'web' : 'other';
      database.run('INSERT OR IGNORE INTO account_origins (user_id, src, referrer, entry, at) VALUES (?, ?, ?, ?, ?)',
        user.id, came.src ?? null, came.via ?? null, entry, iso(clock()));
    } catch (err) {
      log(`[origins] a new account's origin could not be noted: ${err?.stack || err}`);
    }
  }

  const of = (userId) => database.get('SELECT src, referrer, entry, at FROM account_origins WHERE user_id = ?', userId) ?? null;

  /** How they said they heard of the app, where a host asks at the first start (host.js firstQuestions). */
  const asksHeard = () => database.columnsOf('host_first_answers').length > 0;
  const heardOf = (userId) => (asksHeard()
    ? database.get('SELECT heard_from FROM host_first_answers WHERE user_id = ?', userId)?.heard_from ?? null : null);

  /* ---------------------------------- payments --------------------------------- */

  function note({ userId, provider, ref, subscription = null, product = null, plan = null, amount = null, currency = null, first = false, estimated = false, at }) {
    const origin = of(userId);
    return database.run(`INSERT OR IGNORE INTO origin_payments (user_id, provider, ref, subscription, product, plan, amount, currency,
        first, estimated, src, referrer, entry, heard, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    userId, String(provider), String(ref), subscription ? String(subscription) : null, product, plan,
    Number.isFinite(amount) ? Math.round(amount) : null, currency ? String(currency).toUpperCase() : null,
    first ? 1 : 0, estimated ? 1 : 0, origin?.src ?? null, origin?.referrer ?? null, origin?.entry ?? null, heardOf(userId), at).changes > 0;
  }

  /**
   * billing.whenPaid: a payment on the web, a first one or a renewal, with what was charged. A
   * group's is nobody's account. → whether it was noted (false for one already here).
   */
  function paid({ user, organization = null, event }, { provider }) {
    if (!user?.id || organization || event?.type !== 'payment' || !event.ref) return false;
    const key = String(event.product ?? '');
    return note({
      userId: user.id, provider, ref: event.ref, subscription: event.subscription ?? null, product: key || null,
      plan: Object.hasOwn(products, key) ? products[key]?.plan ?? null : null,
      amount: Number.isFinite(Number(event.amount)) && event.amount != null ? Number(event.amount) : null,
      currency: event.currency ?? null, first: event.first === true, at: event.occurredAt ?? iso(clock()),
    });
  }

  /** billing.whenRefunded: its payment marked, by its transaction or, for a subscription's, its last payment. → how many */
  function refunded({ event }, { provider }) {
    if (!event?.ref) return 0;
    const at = event.occurredAt ?? iso(clock());
    if (event.subscription === true) {
      return database.run(`UPDATE origin_payments SET refunded_at = ? WHERE id = (SELECT id FROM origin_payments
        WHERE provider = ? AND subscription = ? AND refunded_at IS NULL ORDER BY at DESC, id DESC LIMIT 1)`, at, String(provider), String(event.ref)).changes;
    }
    return database.run('UPDATE origin_payments SET refunded_at = ? WHERE provider = ? AND ref = ? AND refunded_at IS NULL',
      at, String(provider), String(event.ref)).changes;
  }

  /**
   * stores.whenApplied: a purchase in a store (`granted`, or `changed` to another product) and each
   * renewal (`extended`), one per paid period; a refund marks the last one. A store says no amount:
   * the product's listed one, when the app gives it, marked as estimated.
   */
  function applied({ outcome, event, subject, product = null, provider }) {
    if (subject?.type !== 'user' || !event?.ref || !['subscription', 'purchase', 'refund'].includes(event.type)) return false;
    const at = event.occurredAt ?? iso(clock());
    if (outcome === 'refunded') {
      database.run(`UPDATE origin_payments SET refunded_at = ? WHERE id = (SELECT id FROM origin_payments
        WHERE provider = ? AND subscription = ? AND refunded_at IS NULL ORDER BY at DESC, id DESC LIMIT 1)`, at, String(provider), String(event.ref));
      return false;
    }
    if (!['granted', 'changed', 'extended'].includes(outcome) || event.type === 'refund') return false;
    const key = String(event.product ?? '');
    const listed = Object.hasOwn(storeProducts, key) ? storeProducts[key] : null;
    const currency = event.currency ?? listed?.currency ?? null;
    const said = typeof event.amount === 'number' && Number.isFinite(event.amount);
    const units = said ? event.amount : typeof listed?.amount === 'number' ? listed.amount : null;
    return note({
      userId: subject.id, provider, ref: `${event.ref}@${event.periodEnd ?? at}`, subscription: event.ref, product: key || null,
      plan: product?.plan ?? listed?.plan ?? null,
      amount: units == null || !currency ? null : units * minorUnits(currency), currency,
      first: outcome !== 'extended', estimated: !said && units != null, at,
    });
  }

  const paymentsOf = (userId) => database.all(`SELECT at, provider, product, plan, amount, currency, first, estimated, refunded_at
    FROM origin_payments WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT 200`, userId)
    .map((row) => ({ ...row, first: Boolean(row.first), estimated: Boolean(row.estimated) }));

  /** accounts.whenRemoved: the account's origin goes with it; its payments stay as figures, nobody's. */
  function forget(userId) {
    database.run('DELETE FROM account_origins WHERE user_id = ?', userId);
    database.run('UPDATE origin_payments SET user_id = NULL WHERE user_id = ?', userId);
  }

  return { fromLogin, pack, arriving, noteCreated, of, heardOf, paid, refunded, applied, paymentsOf, forget, ownHosts: own };
}

/** The admin's route: an account's origin and the payments noted for it. Administrators only. */
export function registerOriginsApi(router, { origins, accounts }) {
  router.get('/api/admin/users/:id/origin', (ctx) => {
    requireAdmin(ctx);
    const user = accounts.byId(int(ctx.params.id, { field: 'id', min: 1 }));
    if (!user) throw notFound('user_not_found');
    sendJson(ctx.res, 200, { origin: origins.of(user.id), payments: origins.paymentsOf(user.id) });
  });
}
