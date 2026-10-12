/**
 * Billing: payments turned into grants. Off unless the app hands in a provider
 * (BILLING_PROVIDER), so the open-source image never charges anybody.
 *
 * The suite takes no money itself. A provider —Stripe, a merchant of record
 * like Paddle, or the private accounts service of the hosted suite— hosts the
 * checkout and the customer portal and tells the app what happened through a
 * signed webhook. This module turns what it says into grants of
 * entitlements.js, which is all the rest of the app ever looks at:
 *
 *   subscription active or trialing → the plan until the end of the paid period
 *                                     (plus a few days of grace), extended on renewal
 *   subscription past due           → nothing changes: the grant lapses on its own
 *   subscription canceled or ended  → the grant ends now
 *   one-off purchase                → the plan for good, or for the product's days
 *   refund                          → the purchase's grant ends now; a subscription's too,
 *                                     and the period it paid for doesn't bring it back
 *
 * Providers retry and may deliver out of order: each event is applied once
 * (`billing_events`), and a subscription event older than the state already
 * known for it is ignored (`billing_subscriptions`).
 *
 * Who pays. An event says it, best first, by:
 *   1. `identity`, who the person is where they sign in ({ provider: 'workos', subject: 'user_01…' }):
 *      the same in every app of the suite, so one subscription bought in one app reaches all of
 *      them, each with its own database and its own webhook. Someone who hasn't opened this app
 *      yet has no account here: the event waits (`billing_pending`) and is applied when that
 *      identity first signs in (`claim`, from the accounts' `whenLinked`).
 *   2. the customer already linked here to an account (`billing_customers`);
 *   3. `subject` ("user:12"), the app's own id, which only means something in the install that
 *      made the checkout: a copy of the install renumbers accounts (portability.js), so it comes
 *      last, after the customer, which the copy carries with the new ids.
 *
 * Another product's events. A provider account may sell more than one product (Cronum Work and
 * Tracker), and it sends every event to every app's webhook: this app hears of sales that aren't
 * its own, often for people it knows by the same identity. With `ignoreUnknownProducts`, an event
 * (not a refund) for a product this catalog doesn't have is `'foreign'`: decided before anything
 * about who pays, so no customer is linked, nothing waits in `billing_pending` and only the
 * event's id, type and outcome are kept (`billing_events`). With `app`, the checkout says which
 * app sells (Paddle's `custom_data.app`), and an event that names another is foreign too. A
 * provider may also mark an event `foreign` itself (Paddle's `paddleProductIds`), or `own` when
 * it knows the event is of this install's product: then a product the catalog can't place is a
 * price missing from the config (`unknownPrice`), logged as such and `'ignored'`, never foreign.
 * Off by default: as before, such an event links the customer and waits for its person, then is
 * ignored.
 *
 * A provider adapter is:
 *   {
 *     id: 'stripe',
 *     checkoutUrl({ subject, identity, customer, product, price, kind, email, returnUrl, app? }) → Promise<url>,
 *     portalUrl({ customer, returnUrl }) → Promise<url>,
 *     parseWebhook({ headers, body }) → Promise<event | event[] | null>   (throws on a bad signature)
 *   }
 * and an event, whatever the provider called it:
 *   { id, type: 'subscription' | 'purchase' | 'refund', occurredAt, identity?: { provider, subject },
 *     subject?: { type, id }, customer?, ref, product?, status?, periodEnd?, quantity?, app?, foreign?,
 *     own?, unknownPrice?, sandbox?, refundReversed? }
 * (`refundReversed`: the store took a refund back, so the period it had paid back counts again.)
 *
 * Several providers in one install (P6): the web's (BILLING_PROVIDER) and the stores' (STORE_BILLING,
 * stores.js) are two instances of this, on the same tables, each under its own provider id. An
 * account's plan is every grant of both (entitlements.js), `GET /api/billing/overview` lists what
 * each one holds for the person and how to manage it, `combinedBilling()` hands both to the
 * account deletion, the web's checkout counts the stores' live subscriptions too (`otherProviders`),
 * and `forget()` (with `billing.forgetOnRemove`) lets go of an account's links, subscriptions,
 * grants and waiting events here when it goes, never of who the person is at the identity provider.
 *
 * A reading (`apply(event, { reading: true })`, stores.js) is not a delivery: it is what the store
 * holds now, read again after a webhook or when the app asks. One that says what is already here
 * is `'unchanged'` and leaves no trace (no event row, no audit), so reading again costs nothing.
 *
 * A group that goes (organizations.remove, or its last member gone with `onEmpty: 'delete'`). Its
 * subscription would go on renewing at the provider with nobody left to use it, so a group's live
 * subscriptions can be stopped at the end of the period already paid (`stopOrganization(id)`, or on
 * its deletion with `billing.stopOnOrganizationDeleted`), and taken back (`keepOrganization(id)`).
 * Each stop is asked of the provider once: it is a row of `billing_events` of its own
 * (`stop:organization:<id>:<ref>`, type `stop`), made `pending` in the deletion's transaction, so a
 * deletion undone leaves none, and made `requested` once the provider took it; one that fails
 * stays pending and the hourly `sendStops()` asks again, and one whose subscription ended first is
 * `ended`. An event for a group that is no longer here (`organizationGone`) is `'gone'`: nothing is
 * linked, granted or kept for it beyond its id, and a subscription row still kept follows its status.
 */
import crypto from 'node:crypto';
import { HttpError, badRequest, notFound, unauthorized, sendJson, readBody, readJson } from './http.js';
import { ensureColumn } from './migrate.js';
import { answeredOnce } from './idempotency.js';

const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

export function billingSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS billing_customers (
    subject_type TEXT NOT NULL,
    subject_id   INTEGER NOT NULL,
    provider     TEXT NOT NULL,
    customer_id  TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (subject_type, subject_id, provider)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ix_billing_customer ON billing_customers (provider, customer_id);
  CREATE TABLE IF NOT EXISTS billing_subscriptions (
    provider     TEXT NOT NULL,
    ref          TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id   INTEGER NOT NULL,
    product      TEXT NOT NULL,
    status       TEXT NOT NULL,
    quantity     INTEGER,
    period_end   TEXT,
    occurred_at  TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (provider, ref)
  );
  CREATE INDEX IF NOT EXISTS ix_billing_subscriptions_subject ON billing_subscriptions (subject_type, subject_id);
  CREATE TABLE IF NOT EXISTS billing_events (
    provider    TEXT NOT NULL,
    event_id    TEXT NOT NULL,
    type        TEXT NOT NULL,
    outcome     TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (provider, event_id)
  )`);
}

/**
 * Migration 18: what was paid for by someone who has no account here yet, kept
 * until they first sign in, and the period a subscription's refund paid back.
 */
export function billingPendingSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS billing_pending (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    provider          TEXT NOT NULL,
    identity_provider TEXT NOT NULL,
    identity_subject  TEXT NOT NULL,
    ref               TEXT NOT NULL,
    event             TEXT NOT NULL,
    occurred_at       TEXT NOT NULL,
    received_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_billing_pending_identity ON billing_pending (identity_provider, identity_subject);
  CREATE INDEX IF NOT EXISTS ix_billing_pending_ref ON billing_pending (provider, ref)`);
  ensureColumn(d, 'billing_subscriptions', 'refunded_until', 'refunded_until TEXT');
}

/* ------------------------------ signatures ------------------------------ */

/**
 * `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`, the scheme Stripe uses:
 * the timestamp inside the signature stops an old delivery from being replayed.
 */
export function signPayload(secret, body, at = Date.now()) {
  const t = Math.floor(at / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

export function verifySignature(secret, body, header, { toleranceSeconds = 300, now = Date.now() } = {}) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 || '')) return false;
  if (Math.abs(now / 1000 - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(parts.v1, 'hex'));
}

/**
 * A provider that speaks the suite's own events, signed with a shared secret:
 * what the private accounts service of the hosted suite sends to each app, and
 * what the tests and development use. Its checkout and portal are pages of
 * that service (`baseUrl`), which gets a signed link saying who and what.
 */
export function signedProvider({ id = 'remote', secret, baseUrl = '' }) {
  if (!secret || String(secret).length < 16) throw new Error('signedProvider: a secret of at least 16 characters is needed');
  const link = (path, params) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
    query.set('sig', signPayload(secret, query.toString()));
    return `${String(baseUrl).replace(/\/$/, '')}${path}?${query}`;
  };
  return {
    id,
    checkoutUrl: async ({ subject, customer, product, email, returnUrl }) => link('/checkout', {
      subject: `${subject.type}:${subject.id}`, customer, product, email, return: returnUrl,
    }),
    portalUrl: async ({ customer, returnUrl }) => link('/portal', { customer, return: returnUrl }),
    parseWebhook: async ({ headers, body }) => {
      if (!verifySignature(secret, body, headers['x-suite-signature'])) throw new HttpError(400, 'bad_signature');
      try {
        return JSON.parse(body);
      } catch {
        throw badRequest('invalid_json');
      }
    },
  };
}

/* -------------------------------- billing ------------------------------- */

const SUBSCRIPTION_KEEPS = new Set(['active', 'trialing']);
// Paused (Paddle) is not paid for either: resumed, it is active again.
const SUBSCRIPTION_ENDS = new Set(['canceled', 'ended', 'unpaid', 'incomplete_expired', 'paused']);
/** An event waiting for someone who never comes is dropped after this long. */
const PENDING_DAYS = 400;
/** What still charges: a group's subscription in one of these is stopped when the group goes. */
const RENEWS = new Set(['active', 'trialing', 'past_due']);
/** A stop taken by a sweep that never said how it went (the process ended) is taken again after this. */
const SENDING_MS = 15 * 60 * 1000;
const STOP_ID = /^stop:organization:(\d+):(.+)$/;
const stopId = (organizationId, ref) => `stop:organization:${organizationId}:${ref}`;

/**
 * @param {object} options
 * @param {object} options.database
 * @param {object} options.entitlements   from createEntitlements()
 * @param {object} [options.provider]     an adapter; without one billing is off
 * @param {object} [options.products]     what can be bought:
 *   { 'pro-monthly': { plan: 'pro', kind: 'subscription', price: 'price_…' },
 *     'pro-yearly': { plan: 'pro', kind: 'subscription', price: 'pri_…', founderPrice: 'pri_…' },
 *     'pro-lifetime': { plan: 'pro', kind: 'once' }, 'pro-pass': { plan: 'pro', kind: 'once', days: 30 },
 *     'family-yearly': { plan: 'family', kind: 'subscription', for: 'organization' } }
 *   A founder's price is chosen here, for whoever `isFounder` says: the browser only names the product.
 *   `oldPrices`: prices it no longer sells that subscriptions may still renew on (Paddle reads them).
 * @param {object} [options.identities]   who people are where they sign in:
 *   { of(userId) → { provider, subject } | null, user(provider, subject) → userId | null }
 * @param {(user) => boolean|Promise<boolean>} [options.isFounder]   who gets the founder's price
 * @param {number} [options.graceDays]    after the paid period, before a subscription lapses
 * @param {object} [options.audit]
 * @param {boolean} [options.ignoreUnknownProducts]   an event for a product not in `products` is
 *   another product's ('foreign'), before anything about who pays (see the top of this file)
 * @param {string} [options.app]   which app sells, written in the checkout (Paddle's custom_data.app);
 *   an event that names another app is foreign. The same in every install that sells one
 *   subscription together (the apps of Cronum Work), or their sales would be foreign to each other
 * @param {string[]} [options.otherProviders]   the other instances on these tables (the stores'): a
 *   person's live subscription there also makes the web's checkout of a second one `already_subscribed`
 * @param {(organizationId) => boolean} [options.organizationGone]   whether a group is no longer
 *   here (deleted); its events are then 'gone' (see the top of this file). Without it, as before.
 */
export function createBilling({
  database, entitlements, provider = null, products = {}, graceDays = 3, audit = null,
  identities = null, isFounder = () => false, clock = () => Date.now(), log = console.log,
  ignoreUnknownProducts = false, app = null, otherProviders = [], organizationGone = null,
}) {
  const errors = [];
  if (typeof ignoreUnknownProducts !== 'boolean') errors.push('ignoreUnknownProducts must be true or false');
  if (app !== null && !/^[a-z][a-z0-9-]{1,30}$/.test(String(app))) errors.push(`app "${app}": lowercase letters, digits and -, starting with a letter`);
  if (!(Array.isArray(otherProviders) && otherProviders.every((id) => typeof id === 'string' && id))) {
    errors.push('otherProviders must be a list of provider ids');
  }
  const planIds = new Set(entitlements.describe().plans.map((p) => p.id));
  const catalog = {};
  for (const [key, spec] of Object.entries(products || {})) {
    if (!/^[a-z0-9_-]{1,40}$/.test(key)) errors.push(`Product "${key}": ids take lowercase letters, digits, - and _`);
    if (!spec || !planIds.has(spec.plan)) { errors.push(`Product "${key}": plan "${spec?.plan}" is not in the catalog`); continue; }
    if (!['subscription', 'once'].includes(spec.kind)) { errors.push(`Product "${key}": kind must be "subscription" or "once"`); continue; }
    if (spec.days != null && !(Number.isInteger(spec.days) && spec.days > 0)) errors.push(`Product "${key}": days must be a whole number above 0`);
    // Stripe and Paddle sell prices: each product says which one (price_…, pri_…).
    if (provider?.needsPrice && !spec.price) errors.push(`Product "${key}": ${provider.id} needs its price`);
    for (const field of ['price', 'founderPrice']) {
      if (spec[field] != null && typeof spec[field] !== 'string') errors.push(`Product "${key}": ${field} must be the provider's price id`);
    }
    if (spec.oldPrices != null && !(Array.isArray(spec.oldPrices) && spec.oldPrices.every((p) => typeof p === 'string' && p))) {
      errors.push(`Product "${key}": oldPrices must be a list of the provider's price ids`);
    }
    catalog[key] = {
      key, plan: spec.plan, kind: spec.kind, days: spec.days ?? null, for: spec.for === 'organization' ? 'organization' : 'user',
      price: spec.price ?? null, founderPrice: spec.founderPrice ?? null, name: spec.name ?? null,
    };
  }
  const enabled = Boolean(provider) && !errors.length;
  const source = provider?.id || 'billing';

  const record = (action, subject, meta) => audit?.record({
    action, organizationId: subject?.type === 'organization' ? subject.id : null,
    targetType: subject?.type ?? null, targetId: subject?.id ?? null, meta,
  });

  /* ------------------------------ customers ----------------------------- */

  const customerOf = (subject) => database.get(`SELECT customer_id FROM billing_customers
    WHERE subject_type = ? AND subject_id = ? AND provider = ?`, subject.type, subject.id, source)?.customer_id ?? null;

  const subjectOfCustomer = (customer) => {
    const row = customer && database.get(`SELECT subject_type, subject_id FROM billing_customers
      WHERE provider = ? AND customer_id = ?`, source, customer);
    return row ? { type: row.subject_type, id: row.subject_id } : null;
  };

  /**
   * Links a provider's customer to an account. `takeOver`: the event said who
   * by their identity, which outranks a link made before (one a copy of the
   * install or an older checkout may have got wrong).
   */
  function linkCustomer(subject, customer, { takeOver = false } = {}) {
    if (!customer) return;
    const owner = subjectOfCustomer(customer);
    if (owner && owner.type === subject.type && owner.id === subject.id) return;
    if (owner && !takeOver) return;
    if (owner) database.run('DELETE FROM billing_customers WHERE provider = ? AND customer_id = ?', source, customer);
    if (customerOf(subject)) return;
    database.run(`INSERT OR IGNORE INTO billing_customers (subject_type, subject_id, provider, customer_id, created_at)
      VALUES (?, ?, ?, ?, ?)`, subject.type, subject.id, source, customer, iso(clock()));
  }

  /* ------------------------------- grants ------------------------------- */

  const activeGrant = (ref) => database.get(`SELECT * FROM entitlement_grants WHERE source = ? AND external_ref = ?
    AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`, source, ref);

  /** The subscription's grant, extended in place when only its end moves. */
  function holdPlan(subject, product, ref, endsAt, quantity) {
    const current = activeGrant(ref);
    if (current && current.subject_type === subject.type && current.subject_id === subject.id
      && current.plan === product.plan && (current.quantity ?? null) === (quantity ?? null)) {
      database.run('UPDATE entitlement_grants SET ends_at = ? WHERE id = ?', endsAt, current.id);
      return 'extended';
    }
    if (current) entitlements.revoke({ source, externalRef: ref });
    entitlements.grant({
      subjectType: subject.type, subjectId: subject.id, plan: product.plan, quantity: quantity ?? null,
      source, externalRef: ref, endsAt, note: product.key,
    });
    return current ? 'changed' : 'granted';
  }

  /**
   * Whether a subscription event says what is already here: the same row, and the grant applying
   * it would leave (the same end, or none). Only asked of readings: a delivery is applied as ever.
   */
  function sameSubscription(known, event, subject, product) {
    if (!known || known.subject_type !== subject.type || known.subject_id !== subject.id || known.product !== product.key
      || known.status !== event.status || (known.quantity ?? null) !== (event.quantity ?? null)
      || (known.period_end ?? null) !== (event.periodEnd ?? null)) return false;
    if (event.refundReversed === true && known.refunded_until) return false;
    const current = activeGrant(event.ref);
    if (SUBSCRIPTION_KEEPS.has(event.status)) {
      const end = Date.parse(event.periodEnd);
      if (Number.isNaN(end)) return false;
      if (known.refunded_until && end <= Date.parse(known.refunded_until)) return !current;
      return Boolean(current) && current.subject_type === subject.type && current.subject_id === subject.id
        && current.plan === product.plan && (current.quantity ?? null) === (event.quantity ?? null)
        && current.ends_at === iso(end + graceDays * DAY);
    }
    if (SUBSCRIPTION_ENDS.has(event.status)) return !current;
    return true;
  }

  function applySubscription(event, subject, product, { reading = false } = {}) {
    const known = database.get('SELECT * FROM billing_subscriptions WHERE provider = ? AND ref = ?', source, event.ref);
    if (known && known.occurred_at > event.occurredAt) return 'stale';
    if (reading && sameSubscription(known, event, subject, product)) {
      // Only the time it was last known moves on: what an older reading, answered late, is stale against.
      if (event.occurredAt > known.occurred_at) {
        database.run('UPDATE billing_subscriptions SET occurred_at = ? WHERE provider = ? AND ref = ?', event.occurredAt, source, event.ref);
      }
      return 'unchanged';
    }
    const now = iso(clock());
    database.run(`INSERT INTO billing_subscriptions (provider, ref, subject_type, subject_id, product, status, quantity,
        period_end, occurred_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (provider, ref) DO UPDATE SET subject_type = excluded.subject_type, subject_id = excluded.subject_id,
        product = excluded.product, status = excluded.status, quantity = excluded.quantity,
        period_end = excluded.period_end, occurred_at = excluded.occurred_at, updated_at = excluded.updated_at`,
    source, event.ref, subject.type, subject.id, product.key, event.status, event.quantity ?? null,
    event.periodEnd ?? null, event.occurredAt, now);

    // A refund the store took back: the period it paid back is paid for again.
    const refundedUntil = event.refundReversed === true ? null : known?.refunded_until;
    if (event.refundReversed === true && known?.refunded_until) {
      database.run('UPDATE billing_subscriptions SET refunded_until = NULL WHERE provider = ? AND ref = ?', source, event.ref);
    }
    if (SUBSCRIPTION_KEEPS.has(event.status)) {
      const end = Date.parse(event.periodEnd);
      if (Number.isNaN(end)) throw badRequest('field_invalid', { field: 'period_end' });
      // A period paid back doesn't give the plan again; the next one paid for does.
      if (refundedUntil && end <= Date.parse(refundedUntil)) return 'refunded';
      return holdPlan(subject, product, event.ref, iso(end + graceDays * DAY), event.quantity);
    }
    if (SUBSCRIPTION_ENDS.has(event.status)) {
      return entitlements.revoke({ source, externalRef: event.ref }) ? 'revoked' : 'nothing';
    }
    return 'kept';   // past_due, incomplete…: the grant lapses on its own if nothing else comes
  }

  function applyPurchase(event, subject, product, { reading = false } = {}) {
    if (activeGrant(event.ref)) return reading ? 'unchanged' : 'duplicate';
    const endsAt = product.days ? iso(Date.parse(event.occurredAt) + product.days * DAY) : null;
    entitlements.grant({
      subjectType: subject.type, subjectId: subject.id, plan: product.plan, quantity: event.quantity ?? null,
      source, externalRef: event.ref, endsAt, note: product.key,
    });
    return 'granted';
  }

  /** A refund: the grant ends, and a subscription's refunded period can't bring it back. */
  function applyRefund(event, { reading = false } = {}) {
    if (reading && !activeGrant(event.ref)) {
      // Said again by a reading: nothing granted, and the period already marked as paid back.
      const row = database.get('SELECT period_end, refunded_until FROM billing_subscriptions WHERE provider = ? AND ref = ?',
        source, event.ref);
      if (!row || (row.refunded_until && (row.period_end == null || row.refunded_until === row.period_end))) return 'unchanged';
    }
    database.run(`UPDATE billing_subscriptions SET refunded_until = COALESCE(period_end, ?)
      WHERE provider = ? AND ref = ?`, event.occurredAt, source, event.ref);
    return entitlements.revoke({ source, externalRef: event.ref }) ? 'revoked' : 'nothing';
  }

  /**
   * Whether an event (not a refund) is another product's: the provider says so, it names another
   * app, or —with ignoreUnknownProducts— its product isn't in this catalog, unless the provider
   * knows it is this install's own. Each check is off unless its option is on, so by default
   * nothing is foreign.
   */
  function isForeign(event) {
    if (event.foreign === true) return true;
    if (app && typeof event.app === 'string' && event.app !== app) return true;
    // This install's own product (Paddle's paddleProductIds) on a price no product lists: a price
    // missing from the config, which must not look like another product's sale.
    if (event.own === true) return false;
    return ignoreUnknownProducts && !Object.hasOwn(catalog, String(event.product ?? ''));
  }

  /** The loud line for this install's own sale on a price none of its products lists. */
  const unpricedLine = (event) => `[billing] ${source} event ${event.id}: this app's own product, on price ${event.unknownPrice ?? '(none)'}, which none of its products lists (price, founderPrice or oldPrices): not granted until the price is added`;
  const unpriced = (event) => event.own === true && !Object.hasOwn(catalog, String(event.product ?? ''));

  /** A subscription or a purchase, for an account here. */
  function applyTo(event, subject, { byIdentity = false, reading = false } = {}) {
    // Before the customer is linked: another product's customer is nobody's here. This also
    // covers what was waiting since before the option was on (claim).
    if (isForeign(event)) return 'foreign';
    linkCustomer(subject, event.customer, { takeOver: byIdentity });
    const product = catalog[event.product];
    if (!product) {
      log(unpriced(event) ? unpricedLine(event) : `[billing] ${source} event ${event.id}: unknown product "${event.product}", ignored`);
      return 'ignored';
    }
    if (event.type === 'subscription') return applySubscription(event, subject, product, { reading });
    if (event.type === 'purchase') return applyPurchase(event, subject, product, { reading });
    return 'ignored';
  }

  const validSubject = (s) => (s?.type && Number.isInteger(s.id)
    ? { type: s.type === 'organization' ? 'organization' : 'user', id: s.id } : null);

  /** Who an event is for here (see the top of this file), or that it has to wait for them. */
  function whoIs(event) {
    const { identity } = event;
    if (identity?.provider && identity.subject && identities) {
      const userId = identities.user(String(identity.provider), String(identity.subject));
      return userId ? { subject: { type: 'user', id: userId }, byIdentity: true } : { waits: identity };
    }
    // An event that names a person by an identity this app can't look up is not
    // for an id of its own: that would be the id in whichever app made the checkout.
    const linked = subjectOfCustomer(event.customer);
    if (linked) return { subject: linked };
    return { subject: identity?.subject ? null : validSubject(event.subject) };
  }

  /** Whether an event's subject is a group that is no longer here (only with `organizationGone`). */
  const isGone = (subject) => subject?.type === 'organization' && typeof organizationGone === 'function'
    && Boolean(organizationGone(subject.id));

  /**
   * An event for a group deleted here: nothing linked, granted or kept for it. A subscription row
   * still kept of it (without forgetOnRemove) follows its status, and a stop asked for it that the
   * subscription's end makes moot is closed. Before, such an event failed at the audit's reference
   * to the group: a 500 the provider retried.
   */
  function applyGone(event, subject) {
    if (event.type === 'subscription') {
      const known = database.get('SELECT occurred_at FROM billing_subscriptions WHERE provider = ? AND ref = ?', source, event.ref);
      if (known && known.occurred_at <= event.occurredAt) {
        database.run(`UPDATE billing_subscriptions SET status = ?, quantity = ?, period_end = ?, occurred_at = ?, updated_at = ?
          WHERE provider = ? AND ref = ?`, String(event.status ?? ''), event.quantity ?? null, event.periodEnd ?? null,
        event.occurredAt, iso(clock()), source, event.ref);
      }
      if (!RENEWS.has(event.status)) {
        database.run(`UPDATE billing_events SET outcome = 'ended', received_at = ? WHERE provider = ? AND event_id = ?
          AND type = 'stop' AND outcome = 'pending'`, iso(clock()), source, stopId(subject.id, event.ref));
      }
    }
    log(`[billing] ${source} event ${event.id}: for organization #${subject.id}, which is no longer here`);
    return 'gone';
  }

  /** Keeps an event until that identity has an account here. */
  function hold(event, identity) {
    database.run(`INSERT INTO billing_pending (provider, identity_provider, identity_subject, ref, event, occurred_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, source, String(identity.provider), String(identity.subject),
    event.ref, JSON.stringify(event), event.occurredAt, iso(clock()));
    return 'pending';
  }

  /**
   * Applies one event, once. Returns what it did: granted, extended, changed,
   * revoked, refunded, kept, stale, pending, duplicate, ignored, nothing,
   * foreign (another product's, with the options at the top of this file) or
   * gone (for a group deleted here, with `organizationGone`).
   * `reading`: the event is what the store holds now (stores.js), not a
   * delivery; one that changes nothing is 'unchanged', and it and a stale one
   * leave no row and no audit.
   */
  function apply(event, { reading = false } = {}) {
    if (!event?.id || !event.type || !event.ref) throw badRequest('invalid_event');
    const at = Date.parse(event.occurredAt);
    const normalized = { ...event, ref: String(event.ref), occurredAt: iso(Number.isNaN(at) ? clock() : at) };
    return database.tx(() => {
      if (database.get('SELECT 1 FROM billing_events WHERE provider = ? AND event_id = ?', source, String(event.id))) return 'duplicate';
      database.run('DELETE FROM billing_pending WHERE received_at < ?', iso(clock() - PENDING_DAYS * DAY));
      let outcome = 'ignored';
      let subject = null;
      if (normalized.type === 'refund') {
        // A refund names no one: if what it refunds is waiting for someone, it waits with it.
        const waiting = database.get(`SELECT identity_provider AS provider, identity_subject AS subject FROM billing_pending
          WHERE provider = ? AND ref = ? LIMIT 1`, source, normalized.ref);
        outcome = waiting ? hold(normalized, waiting) : applyRefund(normalized, { reading });
      } else if (isForeign(normalized)) {
        // Before whoIs(): nothing of the person is looked up, linked or kept for them.
        outcome = 'foreign';
        log(`[billing] ${source} event ${event.id}: another product's, ignored`);
      } else {
        const who = whoIs(normalized);
        if (who.waits) {
          if (unpriced(normalized)) log(`${unpricedLine(normalized)} (it waits for its person)`);
          outcome = hold(normalized, who.waits);
        } else if (who.subject) {
          subject = who.subject;
          outcome = isGone(subject) ? applyGone(normalized, subject)
            : applyTo(normalized, subject, { byIdentity: who.byIdentity, reading });
        } else {
          log(`[billing] ${source} event ${event.id}: no known subject, ignored`);
        }
      }
      // A store read again and again (each sync, each webhook) must not grow a table each time.
      if (reading && (outcome === 'unchanged' || outcome === 'stale')) return outcome;
      database.run('INSERT INTO billing_events (provider, event_id, type, outcome, received_at) VALUES (?, ?, ?, ?, ?)',
        source, String(event.id), normalized.type, outcome, iso(clock()));
      if (!['ignored', 'nothing', 'kept', 'stale', 'duplicate', 'pending', 'foreign', 'gone'].includes(outcome)) {
        record(`billing.${outcome}`, subject, { provider: source, product: normalized.product ?? null, ref: normalized.ref });
      }
      return outcome;
    });
  }

  /**
   * What was waiting for someone who now has an account here (their first
   * sign-in), applied in the order it happened. Runs inside the sign-in's
   * transaction: an event that fails is noted and dropped, never the sign-in.
   * Returns how many were applied.
   */
  function claim(identityProvider, identitySubject, userId) {
    const rows = database.all(`SELECT * FROM billing_pending WHERE provider = ? AND identity_provider = ?
      AND identity_subject = ? ORDER BY occurred_at, id`, source, String(identityProvider), String(identitySubject));
    const subject = { type: 'user', id: userId };
    for (const row of rows) {
      database.run('DELETE FROM billing_pending WHERE id = ?', row.id);
      let outcome;
      try {
        const event = JSON.parse(row.event);
        outcome = database.tx(() => (event.type === 'refund' ? applyRefund(event) : applyTo(event, subject, { byIdentity: true })));
        if (!['ignored', 'nothing', 'kept', 'stale', 'foreign'].includes(outcome)) {
          record(`billing.${outcome}`, subject, { provider: source, product: event.product ?? null, ref: event.ref });
        }
        database.run('UPDATE billing_events SET outcome = ? WHERE provider = ? AND event_id = ?', outcome, source, String(event.id));
      } catch (err) {
        log(`[billing] ${source} pending event ${row.id} for user #${userId} could not be applied: ${err.message}`);
      }
    }
    return rows.length;
  }

  /* ------------------------------- the web ------------------------------ */

  function mustBeOn() {
    if (!enabled) throw notFound('billing_off');
  }

  /** Whether this person pays a founder's price: never an error, at worst the regular one. */
  async function founder(user) {
    if (!user) return false;
    try {
      return Boolean(await isFounder(user));
    } catch (err) {
      log(`[billing] could not tell whether user #${user.id} is a founder: ${err.message}`);
      return false;
    }
  }

  /**
   * The provider's checkout for a product. `user` is who asks (for a group,
   * its admin): the founder's price is theirs to have, and an email is only
   * handed to the provider when it is verified.
   */
  async function checkoutUrl(subject, productKey, { email = null, returnUrl, user = null }) {
    mustBeOn();
    const product = catalog[productKey];
    if (!product) throw badRequest('product_unknown', { product: productKey });
    if (product.for !== subject.type) throw badRequest('product_for', { for: product.for });
    // A second subscription would charge twice: plans are changed in the portal. A person's in a
    // store counts too (otherProviders): the store can't be asked to stop it, the person cancels there.
    const providers = [source, ...(subject.type === 'user' && Array.isArray(otherProviders) ? otherProviders : [])];
    if (product.kind === 'subscription' && database.get(`SELECT 1 FROM billing_subscriptions
      WHERE provider IN (${providers.map(() => '?').join(', ')}) AND subject_type = ? AND subject_id = ?
      AND status IN ('active', 'trialing', 'past_due')`, ...providers, subject.type, subject.id)) {
      throw new HttpError(409, 'already_subscribed');
    }
    const price = product.founderPrice && await founder(user) ? product.founderPrice : product.price;
    const identity = subject.type === 'user' ? identities?.of(subject.id) ?? null : null;
    return provider.checkoutUrl({
      subject, identity, customer: customerOf(subject), product: product.key, price, kind: product.kind, email, returnUrl,
      ...(app ? { app } : {}),
    });
  }

  async function portalUrl(subject, { returnUrl }) {
    mustBeOn();
    const customer = customerOf(subject);
    if (!customer) throw notFound('no_customer');
    return provider.portalUrl({ customer, returnUrl });
  }

  /** The webhook: raw body, the provider's signature, then each event applied once. */
  async function handleWebhook(req, res) {
    mustBeOn();
    const body = (await readBody(req, { limit: 512 * 1024 })).toString('utf8');
    const parsed = await provider.parseWebhook({ headers: req.headers, body });
    const events = [parsed].flat().filter(Boolean);
    const outcomes = events.map((event) => apply(event));
    sendJson(res, 200, { received: events.length, outcomes });
  }

  /** What can be bought, for a pricing page: never the provider's price ids. */
  const offer = () => Object.values(catalog).map(({ key, plan, kind, days, for: forWhom, name, founderPrice }) => ({
    key, plan, kind, days, for: forWhom, name, founder_price: Boolean(founderPrice),
  }));

  const subscriptionsOf = (subject) => database.all(`SELECT ref, product, status, quantity, period_end, updated_at
    FROM billing_subscriptions WHERE provider = ? AND subject_type = ? AND subject_id = ? ORDER BY updated_at DESC`,
  source, subject.type, subject.id);

  /**
   * Someone deleting their account (account-deletion.js): the subscriptions
   * they pay for themselves stop renewing when they ask, renew again if they
   * take the account back, and end when it goes. A group's are left alone, and
   * a provider that can't do it (the remote one) is skipped. → how many.
   */
  async function eachLiveSubscription(userId, act) {
    if (!enabled || typeof provider?.cancelSubscription !== 'function') return 0;
    const live = database.all(`SELECT ref FROM billing_subscriptions WHERE provider = ? AND subject_type = 'user'
      AND subject_id = ? AND status IN ('active', 'trialing', 'past_due')`, source, userId);
    for (const { ref } of live) await act(ref);
    return live.length;
  }
  const stopRenewals = (userId) => eachLiveSubscription(userId, (ref) => provider.cancelSubscription(ref));
  const keepRenewals = (userId) => eachLiveSubscription(userId, (ref) => provider.keepSubscription(ref));
  const endSubscriptions = (userId) => eachLiveSubscription(userId, (ref) => provider.cancelSubscription(ref, { now: true }));

  /**
   * An account that goes (`accounts.whenRemoved`, with `billing.forgetOnRemove`): this install lets
   * go of what it kept of the person at this provider. Their grants from it end now, and their
   * subscriptions, their customer link and anything still waiting under their identity are deleted.
   * A renewal that still comes is then nobody's account here: one that names only the old customer
   * is ignored; one that names who they are at the identity provider (Paddle's, by the WorkOS id)
   * waits, as for anyone without an account here, and goes to an account opened again with that
   * login, who is still paying for it. Nothing is asked of the provider (that is
   * `deleteAtProviders`), nor of the identity provider, whose login other apps share; a group's
   * subscription stays with the group. Runs inside the removal's transaction, before the account's
   * identities go. → what went: { grants, subscriptions, customers, pending }
   */
  function forget(userId) {
    const identity = identities?.of(userId) ?? null;
    return database.tx(() => {
      const grants = database.run(`UPDATE entitlement_grants SET revoked_at = ? WHERE source = ? AND subject_type = 'user'
        AND subject_id = ? AND revoked_at IS NULL`, iso(clock()), source, userId).changes;
      const subscriptions = database.run(`DELETE FROM billing_subscriptions WHERE provider = ? AND subject_type = 'user'
        AND subject_id = ?`, source, userId).changes;
      const customers = database.run(`DELETE FROM billing_customers WHERE provider = ? AND subject_type = 'user'
        AND subject_id = ?`, source, userId).changes;
      const pending = identity?.provider && identity.subject ? database.run(`DELETE FROM billing_pending WHERE provider = ?
        AND identity_provider = ? AND identity_subject = ?`, source, String(identity.provider), String(identity.subject)).changes : 0;
      return { grants, subscriptions, customers, pending };
    });
  }

  /* --------------------------- a group's renewals ------------------------- */

  const canStop = () => enabled && typeof provider?.cancelSubscription === 'function';
  const setStop = (eventId, outcome) => database.run(`UPDATE billing_events SET outcome = ?, received_at = ?
    WHERE provider = ? AND event_id = ? AND type = 'stop'`, outcome, iso(clock()), source, eventId);
  const stopsOf = (organizationId) => database.all(`SELECT event_id, outcome FROM billing_events WHERE provider = ?
    AND type = 'stop' AND event_id LIKE ?`, source, `stop:organization:${Number(organizationId)}:%`);
  /**
   * Whether the audit may name the group: one deleted (or never here) would break the audit's
   * reference to it, so its entry names it by id only. Without organizationGone, it is asked here.
   */
  const groupHere = (id) => (typeof organizationGone === 'function' ? !organizationGone(Number(id))
    : Boolean(database.get('SELECT 1 AS here FROM organizations WHERE id = ?', Number(id))));

  /**
   * Marks the live subscriptions a group pays here to stop renewing, each once (see the top of
   * this file): synchronous, so it runs inside the group's deletion and is undone with it. A
   * provider that can't stop one (the remote one) marks nothing. → how many were marked now
   */
  function markOrganizationStop(organizationId) {
    if (!canStop()) return 0;
    const id = Number(organizationId);
    let marked = 0;
    for (const { ref } of database.all(`SELECT ref FROM billing_subscriptions WHERE provider = ? AND subject_type = 'organization'
      AND subject_id = ? AND status IN (${[...RENEWS].map(() => '?').join(', ')})`, source, id, ...RENEWS)) {
      marked += database.run(`INSERT OR IGNORE INTO billing_events (provider, event_id, type, outcome, received_at)
        VALUES (?, ?, 'stop', 'pending', ?)`, source, stopId(id, ref), iso(clock())).changes;
    }
    return marked;
  }

  /**
   * Asks the provider to stop, at the end of the period paid, every subscription marked and not
   * asked yet (of one group, or all: the hourly sweep). Each is taken before the provider is asked,
   * so two sweeps at once never ask twice; one that fails is logged and stays for the next sweep;
   * one whose subscription ended meanwhile is closed without asking. Each stop asked is audited
   * (`billing.organization.stop`). → { requested, waiting }: asked now, and still to ask
   */
  async function sendStops({ organizationId = null } = {}) {
    if (!canStop()) return { requested: 0, waiting: 0 };
    const stale = iso(clock() - SENDING_MS);
    const due = database.all(`SELECT event_id FROM billing_events WHERE provider = ? AND type = 'stop'
      AND (outcome = 'pending' OR (outcome = 'sending' AND received_at < ?)) ORDER BY received_at, event_id`, source, stale);
    let requested = 0;
    let waiting = 0;
    for (const { event_id: eventId } of due) {
      const [, id, ref] = STOP_ID.exec(eventId) || [];
      if (!ref || (organizationId != null && Number(id) !== Number(organizationId))) continue;
      const taken = database.run(`UPDATE billing_events SET outcome = 'sending', received_at = ? WHERE provider = ? AND event_id = ?
        AND type = 'stop' AND (outcome = 'pending' OR (outcome = 'sending' AND received_at < ?))`, iso(clock()), source, eventId, stale).changes;
      if (!taken) continue;
      const known = database.get('SELECT status FROM billing_subscriptions WHERE provider = ? AND ref = ?', source, ref);
      if (known && !RENEWS.has(known.status)) {
        setStop(eventId, 'ended');
        continue;
      }
      try {
        await provider.cancelSubscription(ref);
      } catch (err) {
        setStop(eventId, 'pending');
        waiting += 1;
        log(`[billing] ${source}: organization #${id}'s subscription ${ref} could not be stopped yet, tried again later: ${err.message}`);
        continue;
      }
      setStop(eventId, 'requested');
      requested += 1;
      audit?.record({
        action: 'billing.organization.stop', organizationId: groupHere(id) ? Number(id) : null, targetType: 'organization',
        targetId: Number(id), meta: { provider: source, ref },
      });
    }
    return { requested, waiting };
  }

  /**
   * A group's subscriptions stop renewing at the end of the period they paid for (the app asks:
   * its own "delete the family", or the group's deletion with `billing.stopOnOrganizationDeleted`).
   * Asked of the provider once each, however many times this is called. → { requested, waiting }
   */
  async function stopOrganization(organizationId) {
    database.tx(() => markOrganizationStop(organizationId));
    return sendStops({ organizationId });
  }

  /**
   * Taken back: what was asked to stop renews again (`keepSubscription`), and a stop not asked yet
   * is dropped. Each provider call is tried even if another fails; the first failure is thrown after.
   * → how many renew again
   */
  async function keepOrganization(organizationId) {
    if (!canStop()) return 0;
    let kept = 0;
    let failure = null;
    for (const { event_id: eventId, outcome } of stopsOf(organizationId)) {
      const [, id, ref] = STOP_ID.exec(eventId) || [];
      if (!ref || outcome === 'sending') continue;
      // One that ended meanwhile has nothing to renew: the provider would refuse.
      const known = database.get('SELECT status FROM billing_subscriptions WHERE provider = ? AND ref = ?', source, ref);
      if (outcome === 'requested' && !(known && !RENEWS.has(known.status))) {
        try {
          await provider.keepSubscription(ref);
        } catch (err) {
          failure ??= err;
          continue;
        }
        kept += 1;
        audit?.record({
          action: 'billing.organization.keep', organizationId: groupHere(id) ? Number(id) : null, targetType: 'organization',
          targetId: Number(id), meta: { provider: source, ref },
        });
      }
      database.run('DELETE FROM billing_events WHERE provider = ? AND event_id = ? AND type = \'stop\'', source, eventId);
    }
    if (failure) throw failure;
    return kept;
  }

  /**
   * A group deleted, with `billing.forgetOnRemove`: its customer link and subscription rows go,
   * as a person's do (forget). Its grants went with it (organizations.remove), and a stop marked
   * for it keeps the ref it needs. → { subscriptions, customers }
   */
  function forgetOrganization(organizationId) {
    const id = Number(organizationId);
    return database.tx(() => ({
      subscriptions: database.run(`DELETE FROM billing_subscriptions WHERE provider = ? AND subject_type = 'organization'
        AND subject_id = ?`, source, id).changes,
      customers: database.run(`DELETE FROM billing_customers WHERE provider = ? AND subject_type = 'organization'
        AND subject_id = ?`, source, id).changes,
    }));
  }

  return {
    enabled, errors, provider: source, offer, apply, claim, founder, checkoutUrl, portalUrl, handleWebhook,
    customerOf, linkCustomer, subscriptionsOf, stopRenewals, keepRenewals, endSubscriptions, forget,
    markOrganizationStop, sendStops, stopOrganization, keepOrganization, forgetOrganization,
  };
}

/**
 * Several billing instances as one, for the account deletion (account-deletion.js): the web's and
 * the stores'. Each is asked even when another fails; the first failure is thrown after. A store
 * can't stop a subscription for the person (Apple doesn't let a server do it), so it counts none.
 */
export function combinedBilling(instances) {
  const on = instances.filter((instance) => instance?.enabled);
  const each = (method) => async (userId) => {
    let count = 0;
    let failure = null;
    for (const instance of on) {
      try {
        count += Number(await instance[method](userId)) || 0;
      } catch (err) {
        failure ??= err;
      }
    }
    if (failure) throw failure;
    return count;
  };
  return {
    enabled: on.length > 0,
    stopRenewals: each('stopRenewals'), keepRenewals: each('keepRenewals'), endSubscriptions: each('endSubscriptions'),
  };
}

const LIVE = new Set(['active', 'trialing', 'past_due']);

/**
 * Everything that gives someone their plan, or charges them, and how to manage each: the web's
 * subscriptions (the portal, for the person or a group they administer), the stores' (only in the
 * store: Apple lets no server cancel one), a group's plan that covers them and the admin's gifts.
 * Never a ref, a customer or a price id. What an app shows before an account is deleted, and what
 * "Covered by <group>" reads.
 */
export function billingOverview(user, { instances, entitlements, organizations = null, clock = () => Date.now() }) {
  const now = new Date(clock()).toISOString();
  const entitled = entitlements.of(user);
  const plans = Object.fromEntries(entitlements.describe().plans.map((plan) => [plan.id, plan.name]));
  const groups = organizations ? organizations.ofUser(user.id) : [];
  const subjects = [
    { type: 'user', id: user.id },
    ...groups.filter((group) => ['owner', 'admin'].includes(group.role)).map((group) => ({ type: 'organization', id: group.id })),
  ];
  const sources = [];
  for (const instance of instances.filter((one) => one?.enabled)) {
    const planOf = Object.fromEntries(instance.offer().map((product) => [product.key, product.plan]));
    const kind = instance.kind === 'store' ? 'store' : 'web';
    for (const subject of subjects) {
      for (const row of instance.subscriptionsOf(subject).filter((one) => LIVE.has(one.status))) {
        const manage = kind === 'store' ? instance.manage(row.ref) : null;
        sources.push({
          kind, provider: instance.provider,
          ...(subject.type === 'organization' ? { organization_id: subject.id } : {}),
          product: row.product, plan: planOf[row.product] ?? null, status: row.status, period_end: row.period_end,
          ...(manage ? { store: manage.store, sandbox: manage.sandbox } : {}),
          manage: manage ? { via: 'store', store: manage.store, url: manage.url }
            : { via: 'portal', ...(subject.type === 'organization' ? { organization_id: subject.id } : {}) },
        });
      }
    }
  }
  const active = (grant) => grant.plan && !grant.revoked_at && grant.starts_at <= now && (!grant.ends_at || grant.ends_at > now);
  for (const group of groups) {
    for (const grant of entitlements.grantsOf('organization', group.id).filter(active)) {
      sources.push({ kind: 'organization', organization_id: group.id, name: group.name, plan: grant.plan, ends: grant.ends_at });
    }
  }
  for (const grant of entitlements.grantsOf('user', user.id).filter((one) => active(one) && one.source === 'admin')) {
    sources.push({ kind: 'admin', plan: grant.plan, ends: grant.ends_at });
  }
  for (const source of sources) if (source.plan) source.plan_name = plans[source.plan] ?? source.plan;
  return { plan: { id: entitled.plan.id, name: entitled.plan.name, ends: entitled.ends }, sources };
}

/**
 * `GET /api/billing/overview`: billingOverview() for whoever asks. `principal(ctx)` is who that is
 * (the session's account, or with `stores.devices` the phone's device token).
 */
export function registerBillingOverviewApi(router, {
  instances, entitlements, organizations = null, principal = (ctx) => ctx.user, clock = () => Date.now(),
}) {
  router.get('/api/billing/overview', (ctx) => {
    const user = principal(ctx);
    if (!user) throw unauthorized();
    sendJson(ctx.res, 200, billingOverview(user, { instances, entitlements, organizations, clock }));
  });
}

/**
 * The routes: what is on offer, checkout and portal for a person or for a
 * group they administer, and the provider's webhook (no cookie: its signature
 * is what counts).
 */
export function registerBillingApi(router, { billing, organizations = null, baseUrl = '' }) {
  if (!billing?.enabled) return;
  const back = (path) => `${String(baseUrl).replace(/\/$/, '')}${path}`;

  async function subjectOf(ctx) {
    if (!ctx.user) throw unauthorized();
    const body = await readJson(ctx.req);
    if (body.organization_id == null) return { subject: { type: 'user', id: ctx.user.id }, body };
    if (!organizations) throw notFound('organization_not_found');
    const id = Number(body.organization_id);
    organizations.requireRole(id, ctx.user.id, 'admin');
    return { subject: { type: 'organization', id }, body };
  }

  // `founder`: whether the person asking gets the founder's price of the products that have one.
  router.get('/api/billing/products', async (ctx) => {
    sendJson(ctx.res, 200, { provider: billing.provider, products: billing.offer(), founder: await billing.founder(ctx.user) });
  });

  router.post('/api/billing/checkout', async (ctx) => {
    const { subject, body } = await subjectOf(ctx);
    // Only an email that is theirs: the provider may file the purchase under it.
    const email = ctx.user.email && ctx.user.email_verified_at ? ctx.user.email : null;
    const url = await billing.checkoutUrl(subject, body.product, { email, user: ctx.user, returnUrl: back('/?billing=done') });
    sendJson(ctx.res, 200, { url });
  });

  // The provider's portal opens signed in from this link, valid for a short while: never kept.
  router.post('/api/billing/portal', answeredOnce(async (ctx) => {
    const { subject } = await subjectOf(ctx);
    sendJson(ctx.res, 200, { url: await billing.portalUrl(subject, { returnUrl: back('/') }) });
  }));

  router.get('/api/billing/subscriptions', (ctx) => {
    if (!ctx.user) throw unauthorized();
    sendJson(ctx.res, 200, { subscriptions: billing.subscriptionsOf({ type: 'user', id: ctx.user.id }) });
  });

  router.post('/api/billing/webhook', (ctx) => billing.handleWebhook(ctx.req, ctx.res));
}
