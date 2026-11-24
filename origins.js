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
 * What is counted, for the figures by origin (`report`, the admin's Origins):
 *   visits     to the pages of a site that tells this install of them (`visited`, behind
 *              `POST /api/origins/visits` with the token of ORIGIN_VISITS_TOKEN): a number per day,
 *              link's tag or site. Never who: no address, no browser, nothing of the visitor
 *   marks      what an account did for the first time, once each (`account_marks`): `made`, the
 *              first thing it created (a route of the app's own answered it 201: in a host, a
 *              module's; never the suite's routes, where a token or a device is made); `mcp`,
 *              its first call from an assistant; `limit:<feature>`, each limit of its plan it ran into
 * `report({ weeks })` puts them together by the week the accounts were made and by origin: the
 * visits of that week, the accounts made, how many of them did something (`made` or `mcp`), how
 * many ran into a limit in their first 30 days, how many pay, by plan, and what they have paid.
 * An account's origin there is one (`originOf`): its link's tag, else the site it came from, else
 * what it answered to «How did you hear about us?» (a host's first questions), else how it was
 * made. The install's own website (a domain the install's host is under) is kept as the site like
 * any other, but counts after the answer: someone who reached it from nowhere a browser names and
 * went on to the app came «from the website», and what they answered says more.
 *
 *   const origins = createOrigins({ database, accounts, baseUrl, products, log });
 *   accounts.whenCreated(origins.noteCreated); accounts.whenRemoved(origins.forget);
 *   billing.whenPaid((paid) => origins.paid(paid, { provider: billing.provider }));
 *   billing.whenRefunded((refund) => origins.refunded(refund, { provider: billing.provider }));
 *   stores.whenApplied(origins.applied);
 *   entitlements.whenLimit(origins.limitReached);   // and each module's, in a host
 *   registerOriginsApi(api, { origins, accounts, visitsToken });   // /api/admin/origins…, /api/origins/visits
 */
import { sendJson, requireAdmin, notFound, unauthorized, int, parseCookies, readJson } from './http.js';
import { safeEqual } from './crypto.js';
import { currentRequest } from './request-scope.js';
import { iso } from './time.js';

/** A link's tag: what `?src=` may say. */
const TAG = /^[a-z0-9][a-z0-9._-]{0,39}$/;
/** A site's domain, or an app's package: labels of letters, digits and dashes, 80 characters at most. */
const HOST = /^(?=.{3,80}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9_-]{0,23}$/;
/** What an account's limit is called in its mark: a feature's key. */
const FEATURE = /^[a-z0-9][a-z0-9._-]{0,59}$/;
const DAY = 24 * 3600 * 1000;
/** The most origins a day's visits are told apart by: past them, the rest of that day are `(other)`. */
const ORIGINS_A_DAY = 500;
/** The days after it is made in which an account's limit counts in the figures. */
export const LIMIT_DAYS = 30;

/** The Monday of a moment's week, as a day (UTC): the week the figures put it in. */
export function weekOf(moment) {
  const at = new Date(typeof moment === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(moment) ? `${moment}T12:00:00Z` : moment);
  if (Number.isNaN(at.getTime())) return null;
  const monday = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - ((at.getUTCDay() + 6) % 7)));
  return monday.toISOString().slice(0, 10);
}

/**
 * The one origin of an account in the figures, by what is known of it: its link's tag, else the
 * site it came from, else its answer to how it heard of the app, else how it was made when that
 * says something (an assistant, the phone app). → [kind, origin], kind one of ORIGIN_KINDS.
 *
 * A site that is the install's own website (`ownSite(host)`) says the least: whoever reaches it
 * with no tag and from nowhere a browser names (an app on a phone, a link in a chat, an address
 * typed, a friend's word) and goes on to the app arrives «from the website», and their answer is
 * then the only thing that says how they found it. So that site counts after the answer.
 */
export const ORIGIN_KINDS = Object.freeze(['link', 'site', 'answer', 'entry', 'none']);
export function originOf({ src = null, referrer = null, heard = null, entry = null } = {}, { ownSite = () => false } = {}) {
  if (src) return ['link', src];
  const own = Boolean(referrer && ownSite(referrer));
  if (referrer && !own) return ['site', referrer];
  if (heard) return ['answer', heard];
  if (own) return ['site', referrer];
  if (entry === 'mcp' || entry === 'app') return ['entry', entry];
  return ['none', ''];
}

/**
 * The domains an install's own website is at, from the install's address: those its host is under
 * (`work.example.com` → `example.com`), where the website of an app at a subdomain lives. An app at
 * a domain of its own (`example.com`) has none.
 */
export function siteDomainsOf(baseUrl) {
  const host = cleanHost(baseUrl);
  if (!host) return [];
  const labels = host.split('.');
  return labels.slice(1).map((_, i) => labels.slice(i + 1).join('.')).filter((domain) => domain.split('.').length >= 2);
}

/** A cell of a CSV: quoted when it must be, and never read as a formula by a spreadsheet. */
const csvCell = (value) => {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

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

/**
 * Migration 37: what an account did for the first time (`made`, `mcp`, `limit:<feature>`), once
 * each, and the visits a site tells of, a number per day and origin.
 */
export function originFiguresSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS account_marks (
    user_id INTEGER NOT NULL,
    mark    TEXT NOT NULL,
    at      TEXT NOT NULL,
    PRIMARY KEY (user_id, mark)
  );
  CREATE TABLE IF NOT EXISTS origin_visits (
    day      TEXT NOT NULL,
    src      TEXT NOT NULL DEFAULT '',
    referrer TEXT NOT NULL DEFAULT '',
    n        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, src, referrer)
  )`);
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
  // The install's own website, and anything else under its domain: kept as the site someone came
  // from, and counted after their own answer in the figures (originOf).
  const siteDomains = siteDomainsOf(baseUrl);
  const ownSite = (host) => siteDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  /** The one origin of an account, as the figures, the summary and the admin's card all say it. */
  const oneOf = (row) => originOf(row ?? {}, { ownSite });
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

  /* ------------------------- what an account did first ------------------------- */

  /** The marks already written since the start: asked first, so a mark costs one write an account. */
  const marked = new Set();
  function mark(userId, name, { later = false } = {}) {
    const id = Number(userId);
    const key = `${id}:${name}`;
    if (!Number.isInteger(id) || id < 1 || marked.has(key)) return;
    marked.add(key);
    const write = () => {
      try {
        database.run('INSERT OR IGNORE INTO account_marks (user_id, mark, at) VALUES (?, ?, ?)', id, name, iso(clock()));
      } catch (err) {
        marked.delete(key);
        log(`[origins] a mark could not be noted: ${err?.message || err}`);
      }
    };
    // A limit is met inside what refuses it, often a transaction about to be undone: written after it.
    if (later) setImmediate(write);
    else write();
  }
  /** The first thing an account creates (createApp: a route of the app's own answered it 201). Never throws. */
  const made = (user) => mark(user?.id, 'made');
  /** Its first call from an assistant (the MCP's quota, when the call goes ahead). */
  const usedMcp = (user) => mark(user?.id, 'mcp');
  /** entitlements.whenLimit: a limit of its plan it ran into (a list more than its plan has, its storage, its calls). */
  const limitReached = (user, feature) => { if (FEATURE.test(String(feature ?? ''))) mark(user?.id, `limit:${feature}`, { later: true }); };
  const marksOf = (userId) => database.all('SELECT mark, at FROM account_marks WHERE user_id = ? ORDER BY at, mark', userId);

  /* ---------------------------------- visits ---------------------------------- */

  /**
   * A visit a site tells of: one more for today and its origin, the link's tag or else the site
   * (neither: a visit from nowhere known). Nothing of the visitor comes with it. A day's origins
   * are told apart up to ORIGINS_A_DAY, so tags nobody published can't grow the table without end.
   * → whether it was counted.
   */
  function visited({ src = null, via = null } = {}) {
    const tag = cleanTag(src) || '';
    const site = tag ? '' : cleanHost(via, own) || '';
    const day = iso(clock()).slice(0, 10);
    const known = database.get('SELECT 1 AS x FROM origin_visits WHERE day = ? AND src = ? AND referrer = ?', day, tag, site);
    const full = !known && database.get('SELECT COUNT(*) AS n FROM origin_visits WHERE day = ?', day).n >= ORIGINS_A_DAY;
    database.run(`INSERT INTO origin_visits (day, src, referrer, n) VALUES (?, ?, ?, 1)
      ON CONFLICT (day, src, referrer) DO UPDATE SET n = n + 1`, day, full ? '(other)' : tag, full ? '' : site);
    return true;
  }

  /* ---------------------------------- figures --------------------------------- */

  const heardJoin = () => (asksHeard()
    ? { column: 'a.heard_from AS heard', join: 'LEFT JOIN host_first_answers a ON a.user_id = u.id' }
    : { column: 'NULL AS heard', join: '' });

  /**
   * The figures by week and origin, for the last `weeks` weeks (this one included), newest first
   * and, in a week, the origin with most accounts first. A week is Monday to Sunday (UTC). Of the
   * accounts made in a week from an origin: how many (`signups`), how many did something
   * (`activated`: created something, or called from an assistant), how many ran into a limit of
   * their plan within LIMIT_DAYS of being made (`limited`), how many have paid (`paying`, and by
   * plan in `plans`) and what, refunds left out (`income`, by currency, in its smallest unit).
   * `visits` are that week's, by the same origin. → { weeks: [monday…], rows, answers }
   */
  function report({ weeks = 8 } = {}) {
    const span = Math.min(Math.max(Math.trunc(Number(weeks)) || 8, 1), 52);
    const last = weekOf(clock());
    const first = iso(Date.parse(`${last}T00:00:00Z`) - (span - 1) * 7 * DAY);
    const rows = new Map();
    const rowOf = (week, [kind, origin]) => {
      const key = `${week}|${kind}|${origin}`;
      if (!rows.has(key)) rows.set(key, { week, kind, origin, visits: 0, signups: 0, activated: 0, limited: 0, paying: 0, plans: {}, payments: 0, income: {} });
      return rows.get(key);
    };
    for (const visit of database.all('SELECT day, src, referrer, n FROM origin_visits WHERE day >= ?', first.slice(0, 10))) {
      rowOf(weekOf(visit.day), originOf({ src: visit.src, referrer: visit.referrer })).visits += visit.n;
    }
    const heard = heardJoin();
    const people = new Map();
    const answers = new Map();
    for (const user of database.all(`SELECT u.id, u.created_at, o.src, o.referrer, o.entry, ${heard.column}
      FROM users u LEFT JOIN account_origins o ON o.user_id = u.id ${heard.join} WHERE u.created_at >= ?`, first)) {
      const week = weekOf(user.created_at);
      const row = rowOf(week, oneOf(user));
      row.signups += 1;
      people.set(user.id, { row, madeAt: Date.parse(user.created_at), did: false, limited: false, plan: null, paid: false });
      if (user.heard) answers.set(`${week}|${user.heard}`, (answers.get(`${week}|${user.heard}`) || 0) + 1);
    }
    for (const m of database.all(`SELECT m.user_id, m.mark, m.at FROM account_marks m JOIN users u ON u.id = m.user_id
      WHERE u.created_at >= ?`, first)) {
      const person = people.get(m.user_id);
      if (!person) continue;
      if (m.mark === 'made' || m.mark === 'mcp') person.did = true;
      else if (m.mark.startsWith('limit:') && Date.parse(m.at) - person.madeAt <= LIMIT_DAYS * DAY) person.limited = true;
    }
    for (const payment of database.all(`SELECT p.user_id, p.plan, p.amount, p.currency FROM origin_payments p
      JOIN users u ON u.id = p.user_id WHERE u.created_at >= ? AND p.refunded_at IS NULL ORDER BY p.at, p.id`, first)) {
      const person = people.get(payment.user_id);
      if (!person) continue;
      person.row.payments += 1;
      if (payment.amount != null && payment.currency) person.row.income[payment.currency] = (person.row.income[payment.currency] || 0) + payment.amount;
      // A first month a discount paid whole is no payment yet; a store's without a figure is one.
      if (payment.amount == null || payment.amount > 0) { person.paid = true; person.plan = payment.plan || person.plan; }
    }
    for (const person of people.values()) {
      if (person.did) person.row.activated += 1;
      if (person.limited) person.row.limited += 1;
      if (person.paid) {
        person.row.paying += 1;
        const plan = person.plan || '';
        person.row.plans[plan] = (person.row.plans[plan] || 0) + 1;
      }
    }
    const monday = (n) => iso(Date.parse(`${last}T00:00:00Z`) - n * 7 * DAY).slice(0, 10);
    return {
      weeks: Array.from({ length: span }, (_, n) => monday(n)),
      rows: [...rows.values()].sort((a, b) => b.week.localeCompare(a.week) || b.signups - a.signups || b.visits - a.visits
        || a.origin.localeCompare(b.origin)),
      answers: [...answers].map(([key, n]) => ({ week: key.split('|')[0], heard: key.split('|')[1], n }))
        .sort((a, b) => b.week.localeCompare(a.week) || b.n - a.n || a.heard.localeCompare(b.heard)),
    };
  }

  /** The same figures as a CSV: a line per week and origin, a column per plan and per currency there is. */
  function exportCsv({ weeks = 8 } = {}) {
    const { rows } = report({ weeks });
    const plans = [...new Set(rows.flatMap((row) => Object.keys(row.plans)))].sort();
    const currencies = [...new Set(rows.flatMap((row) => Object.keys(row.income)))].sort();
    const lines = [['week', 'kind', 'origin', 'visits', 'signups', 'activated', 'limited', 'paying',
      ...plans.map((plan) => `paying_${plan || 'unknown'}`), 'payments', ...currencies.map((currency) => `income_${currency}`)]];
    for (const row of rows) {
      lines.push([row.week, row.kind, row.origin, row.visits, row.signups, row.activated, row.limited, row.paying,
        ...plans.map((plan) => row.plans[plan] || 0), row.payments,
        ...currencies.map((currency) => ((row.income[currency] || 0) / minorUnits(currency)).toFixed(Math.round(Math.log10(minorUnits(currency)))))]);
    }
    return `${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
  }

  /**
   * Where the accounts made between two moments came from, the three origins with most, for the
   * admin's daily summary: `reddit-mcp 4, google.com 2`, or null with none known.
   */
  function topSince(from, to) {
    const heard = heardJoin();
    const counts = new Map();
    for (const user of database.all(`SELECT o.src, o.referrer, o.entry, ${heard.column} FROM users u
      LEFT JOIN account_origins o ON o.user_id = u.id ${heard.join} WHERE u.created_at >= ? AND u.created_at < ?`, from, to)) {
      const [kind, origin] = oneOf(user);
      if (kind !== 'none') counts.set(origin, (counts.get(origin) || 0) + 1);
    }
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
    return top.length ? top.map(([origin, n]) => `${origin} ${n}`).join(', ') : null;
  }

  /** accounts.whenRemoved: the account's origin goes with it; its payments stay as figures, nobody's. */
  function forget(userId) {
    database.run('DELETE FROM account_marks WHERE user_id = ?', userId);
    for (const key of marked) if (key.startsWith(`${Number(userId)}:`)) marked.delete(key);
    database.run('DELETE FROM account_origins WHERE user_id = ?', userId);
    database.run('UPDATE origin_payments SET user_id = NULL WHERE user_id = ?', userId);
  }

  return {
    fromLogin, pack, arriving, noteCreated, of, heardOf, paid, refunded, applied, paymentsOf, forget, ownHosts: own,
    made, usedMcp, limitReached, marksOf, visited, report, exportCsv, topSince,
    /** An account's one origin in the figures: { kind, origin }. */
    oneOf: (userId) => {
      const [kind, origin] = oneOf({ ...(of(userId) ?? {}), heard: heardOf(userId) });
      return { kind, origin };
    },
  };
}

/**
 * The routes. The admin's, administrators only: an account's origin, what it did first and its
 * payments; the figures by week and origin, and the same as a CSV. And, with `visitsToken` (the
 * install's ORIGIN_VISITS_TOKEN), `POST /api/origins/visits { src, via }` for a site's own server
 * to tell of a visit: whoever carries the token in `Authorization: Bearer`, no one else, and
 * without a token set the route isn't there.
 */
export function registerOriginsApi(router, { origins, accounts, visitsToken = '' }) {
  const weeksOf = (ctx) => int(ctx.query?.get('weeks') ?? 8, { field: 'weeks', min: 1, max: 52 });
  router.get('/api/admin/origins', (ctx) => {
    requireAdmin(ctx);
    sendJson(ctx.res, 200, origins.report({ weeks: weeksOf(ctx) }));
  });
  router.get('/api/admin/origins/export', (ctx) => {
    requireAdmin(ctx);
    const body = origins.exportCsv({ weeks: weeksOf(ctx) });
    ctx.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="origins.csv"',
    });
    ctx.res.end(body);
  });
  if (visitsToken) {
    router.post('/api/origins/visits', async (ctx) => {
      const given = /^Bearer\s+(.+)$/i.exec(String(ctx.req.headers.authorization || ''))?.[1] || '';
      if (!given || !safeEqual(given, visitsToken)) throw unauthorized();
      const body = await readJson(ctx.req);
      origins.visited({ src: body?.src, via: body?.via });
      ctx.res.writeHead(204, { 'Cache-Control': 'no-store' });
      ctx.res.end();
    });
  }
  router.get('/api/admin/users/:id/origin', (ctx) => {
    requireAdmin(ctx);
    const user = accounts.byId(int(ctx.params.id, { field: 'id', min: 1 }));
    if (!user) throw notFound('user_not_found');
    sendJson(ctx.res, 200, {
      origin: origins.of(user.id), one: origins.oneOf(user.id), marks: origins.marksOf(user.id), payments: origins.paymentsOf(user.id),
    });
  });
}
