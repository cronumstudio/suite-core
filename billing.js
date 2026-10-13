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
 * A group's purchase (its `subject` names an organization, or its product is `for: 'organization'`)
 * is the group's, never a person's: the group its subscription is known for here (a copy of the
 * install carries it with the groups' new ids), else the group it names, else the group its
 * customer is linked to; no identity is looked up for it, and a customer linked here counts only
 * when it is a group's. One provider customer often pays both, a person's own plan and
 * their family's (Paddle finds the customer by email), and the customer can be linked to only one
 * of them; before, whichever was linked first took the other's purchases too. The same holds the
 * other way round: a customer linked to a group never takes a person's purchase.
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
 * Each stop is asked of the provider once: a row of `billing_events` of its own
 * (`stop:organization:<id>:<ref>`, type `stop`), in one of these states:
 *   pending    to ask; made in the deletion's transaction, so a deletion undone leaves none
 *   sending    taken by a sweep that is asking now, so two sweeps never ask twice; one whose
 *              sweep never said how it went (the process ended) is taken again after 15 minutes
 *   requested  the provider took it
 *   already    the provider had it already: the payer cancelled themselves (in the portal), and
 *              taking it back is theirs, never this install's
 *   ended      the subscription ended before it was asked
 *   keeping    being taken back now
 *   restop     wanted stopped again while it was being taken back (from here or another process):
 *              only that taking back's end makes it `pending` again (or, if the process asking it
 *              ended, 15 minutes)
 *   rekeep     taken back, and the provider refused: the sweep asks again
 *   keep       taken back while another process was asking it: taken back once it lands
 * One group's stops and their taking back are asked one at a time in this process, in the order
 * they came (a keep waits for a stop on its way, and the other way round).
 * One that fails stays pending and the hourly `sendStops()` asks again. Who wanted each group
 * stopped is kept too (`stop-by:<who>:organization:<id>`, type `stop-by`: `app`, or `members`
 * when all of them are waiting to be deleted): taking it back renews it only when nobody else
 * still wants it stopped. An event for a group that is no longer here (`organizationGone`) is
 * `'gone'`: nothing is linked, granted or kept for it beyond its id, a subscription row still
 * kept follows its status, and, with `organizationWasDeleted`, a live one of a group deleted here
 * that nobody had stopped (its first webhook came after the group went) is stopped too.
 *
 * A person's own subscriptions, when they ask to delete their account (`stopRenewals`, with
 * `accounts.deleteAtProviders`): each stop is noted the same way (`stop:user:<id>:<ref>`:
 * `requested`, `already` or `failed`), so taking the account back renews only what this install
 * stopped, never a cancellation the person made themselves (`keepRenewals`).
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
 * @param {(organizationId) => boolean} [options.organizationWasDeleted]   whether a group was here
 *   and was deleted: a live subscription of one, heard of after it went, is stopped
 *   (createSuite gives it with billing.stopOnOrganizationDeleted)
 */
export function createBilling({
  database, entitlements, provider = null, products = {}, graceDays = 3, audit = null,
  identities = null, isFounder = () => false, clock = () => Date.now(), log = console.log,
  ignoreUnknownProducts = false, app = null, otherProviders = [], organizationGone = null,
  organizationWasDeleted = null,
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
    // A link to a group deleted here names nobody: the customer is whoever's it pays for now.
    if (owner && !takeOver && !isGone(owner)) return;
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

  /** The product an event names, when this catalog has it (never one of Object's own names). */
  const productOf = (event) => {
    const key = String(event.product ?? '');
    return Object.hasOwn(catalog, key) ? catalog[key] : null;
  };

  /** Who an event is for here (see the top of this file), or that it has to wait for them. */
  function whoIs(event) {
    const { identity } = event;
    const named = validSubject(event.subject);
    const forGroup = named?.type === 'organization' || productOf(event)?.for === 'organization';
    const linked = subjectOfCustomer(event.customer);
    if (forGroup) {
      // The group this subscription is known for here, while it is: what a renewal renews, and what a
      // copy of the install carries with its groups' new ids (portability.js), where the id the
      // checkout named may be another group's.
      const known = database.get('SELECT subject_type, subject_id FROM billing_subscriptions WHERE provider = ? AND ref = ?',
        source, String(event.ref));
      const ours = known?.subject_type === 'organization' ? { type: 'organization', id: Number(known.subject_id) } : null;
      if (ours && !isGone(ours)) return { subject: ours };
      // Else the group the checkout named: one customer pays for one group after another (a family
      // left, or deleted, and a new one made), and its link may still name the first. One no longer
      // here takes its own events ('gone'), never another group's, nor a person's.
      if (named?.type === 'organization') return { subject: named };
      // An event that names none: the group the customer is linked to, while it is here.
      return { subject: linked?.type === 'organization' && !isGone(linked) ? linked : null };
    }
    if (identity?.provider && identity.subject && identities) {
      const userId = identities.user(String(identity.provider), String(identity.subject));
      return userId ? { subject: { type: 'user', id: userId }, byIdentity: true } : { waits: identity };
    }
    // A customer linked to a group never takes a person's purchase (see the top of this file).
    if (linked?.type === 'user') return { subject: linked };
    // An event that names a person by an identity this app can't look up is not
    // for an id of its own: that would be the id in whichever app made the checkout.
    return { subject: identity?.subject ? null : named };
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
      const product = productOf(event);
      const known = database.get('SELECT occurred_at FROM billing_subscriptions WHERE provider = ? AND ref = ?', source, event.ref);
      if (known && known.occurred_at <= event.occurredAt) {
        // A product without seats (`seats: false`, a family's) keeps no quantity, as applyTo does.
        database.run(`UPDATE billing_subscriptions SET status = ?, quantity = ?, period_end = ?, occurred_at = ?, updated_at = ?
          WHERE provider = ? AND ref = ?`, String(event.status ?? ''), product?.seats === false ? null : event.quantity ?? null,
        event.periodEnd ?? null, event.occurredAt, iso(clock()), source, event.ref);
      }
      if (!RENEWS.has(event.status)) {
        database.run(`UPDATE billing_events SET outcome = 'ended', received_at = ? WHERE provider = ? AND event_id = ?
          AND type = 'stop' AND outcome = 'pending'`, iso(clock()), source, stopId(subject.id, event.ref));
      } else if (typeof organizationWasDeleted === 'function' && canStop() && product?.for === 'organization'
        && organizationWasDeleted(subject.id)) {
        // Bought for a group deleted here before its first webhook came: it would renew for nobody. It is
        // stopped by the next sweep, as one marked at the deletion is; only for this catalog's product and a
        // group this install had, never another product's sale that names an id of its own.
        const marked = database.run(`INSERT OR IGNORE INTO billing_events (provider, event_id, type, outcome, received_at)
          VALUES (?, ?, 'stop', 'pending', ?)`, source, stopId(subject.id, event.ref), iso(clock())).changes;
        if (marked) log(`[billing] ${source}: organization #${subject.id} was deleted before its subscription ${event.ref} was heard of: it is stopped`);
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

  const canStop = () => enabled && typeof provider?.cancelSubscription === 'function';
  /** Whether a subscription still charges, as far as this install knows (one it never heard of: yes). */
  const renews = (ref) => {
    const known = database.get('SELECT status FROM billing_subscriptions WHERE provider = ? AND ref = ?', source, ref);
    return !known || RENEWS.has(known.status);
  };

  /**
   * Someone deleting their account (account-deletion.js): the subscriptions
   * they pay for themselves stop renewing when they ask, renew again if they
   * take the account back, and end when it goes. A group's are left alone, and
   * a provider that can't do it (the remote one) is skipped. → how many.
   */
  async function eachLiveSubscription(userId, act) {
    if (!canStop()) return 0;
    const live = database.all(`SELECT ref FROM billing_subscriptions WHERE provider = ? AND subject_type = 'user'
      AND subject_id = ? AND status IN ('active', 'trialing', 'past_due')`, source, userId);
    for (const { ref } of live) await act(ref);
    return live.length;
  }

  /*
   * Each stop of a person's is noted (`stop:user:<id>:<ref>`, see the top of this file): taking the
   * account back renews only what this install stopped. The person may have cancelled in the portal
   * before asking to go (`already`): renewing that would charge them against their own word.
   */
  const personalPrefix = (userId) => `stop:user:${Number(userId)}:`;
  const notePersonalStop = (userId, ref, outcome) => database.run(`INSERT INTO billing_events
      (provider, event_id, type, outcome, received_at) VALUES (?, ?, 'stop', ?, ?)
    ON CONFLICT (provider, event_id) DO UPDATE SET outcome = excluded.outcome, received_at = excluded.received_at`,
  source, `${personalPrefix(userId)}${ref}`, outcome, iso(clock()));
  const personalStops = (userId) => database.all(`SELECT event_id, outcome FROM billing_events WHERE provider = ?
    AND type = 'stop' AND event_id LIKE ?`, source, `${personalPrefix(userId)}%`);
  const forgetPersonalStops = (userId) => database.run(`DELETE FROM billing_events WHERE provider = ? AND type = 'stop'
    AND event_id LIKE ?`, source, `${personalPrefix(userId)}%`).changes;

  const stopRenewals = (userId) => eachLiveSubscription(userId, async (ref) => {
    let answer;
    try {
      answer = await provider.cancelSubscription(ref);
    } catch (err) {
      notePersonalStop(userId, ref, 'failed');
      throw err;
    }
    notePersonalStop(userId, ref, answer?.already === true ? 'already' : 'requested');
  });

  /** → how many renew again. A request made before 0.85.0 noted nothing: every live one, as then. */
  async function keepRenewals(userId) {
    if (!canStop()) return 0;
    const noted = personalStops(userId);
    if (!noted.length) return eachLiveSubscription(userId, (ref) => provider.keepSubscription(ref));
    let kept = 0;
    for (const { event_id: eventId, outcome } of noted) {
      const ref = eventId.slice(personalPrefix(userId).length);
      if (outcome === 'requested' && renews(ref)) {
        await provider.keepSubscription(ref);
        kept += 1;
      }
      database.run('DELETE FROM billing_events WHERE provider = ? AND event_id = ? AND type = \'stop\'', source, eventId);
    }
    return kept;
  }

  async function endSubscriptions(userId) {
    const ended = await eachLiveSubscription(userId, (ref) => provider.cancelSubscription(ref, { now: true }));
    forgetPersonalStops(userId);
    return ended;
  }

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
      forgetPersonalStops(userId);
      return { grants, subscriptions, customers, pending };
    });
  }

  /* --------------------------- a group's renewals ------------------------- */

  const outcomeOf = (eventId) => database.get(`SELECT outcome FROM billing_events WHERE provider = ? AND event_id = ?
    AND type = 'stop'`, source, eventId)?.outcome ?? null;
  /** A stop moved from one state to another, only when it is still in the first. → whether it moved */
  const moveStop = (eventId, from, to) => database.run(`UPDATE billing_events SET outcome = ?, received_at = ?
    WHERE provider = ? AND event_id = ? AND type = 'stop' AND outcome = ?`, to, iso(clock()), source, eventId, from).changes > 0;
  /** A stop dropped, only when it is still in that state. → whether it was */
  const dropStop = (eventId, from) => database.run(`DELETE FROM billing_events WHERE provider = ? AND event_id = ?
    AND type = 'stop' AND outcome = ?`, source, eventId, from).changes > 0;
  const stopsOf = (organizationId) => database.all(`SELECT event_id FROM billing_events WHERE provider = ?
    AND type = 'stop' AND event_id LIKE ? ORDER BY event_id`, source, `stop:organization:${Number(organizationId)}:%`);
  /**
   * Whether the audit may name the group: one deleted (or never here) would break the audit's
   * reference to it, so its entry names it by id only. Without organizationGone, it is asked here.
   */
  const groupHere = (id) => (typeof organizationGone === 'function' ? !organizationGone(Number(id))
    : Boolean(database.get('SELECT 1 AS here FROM organizations WHERE id = ?', Number(id))));
  const recordStop = (action, id, ref) => audit?.record({
    action, organizationId: groupHere(id) ? Number(id) : null, targetType: 'organization', targetId: Number(id),
    meta: { provider: source, ref },
  });

  /** Who wants a group stopped: `app`, `members`, or such a word with an id (`user:12`). */
  const ORIGIN = /^[a-z][a-z0-9_-]{0,30}(:\d{1,15})?$/;
  const originId = (organizationId, by) => `stop-by:${by}:organization:${Number(organizationId)}`;
  const checkOrigin = (by) => {
    if (typeof by !== 'string' || !ORIGIN.test(by)) throw new TypeError(`billing: "${by}" is not who stops a group (app, members…)`);
    return by;
  };
  /** Who still wants a group stopped. */
  const stopOriginsOf = (organizationId) => database.all(`SELECT event_id FROM billing_events WHERE provider = ?
    AND type = 'stop-by' AND event_id LIKE ?`, source, `stop-by:%:organization:${Number(organizationId)}`)
    .map(({ event_id: eventId }) => eventId.slice('stop-by:'.length, eventId.lastIndexOf(':organization:')));

  /**
   * One group's provider calls, one at a time and in order: a keep that comes while its stop is on
   * its way waits for it, and lands after it; a stop that comes while a keep is on its way, after.
   */
  const queues = new Map();
  async function oneAtATime(organizationId, fn) {
    const key = Number(organizationId);
    const before = queues.get(key) ?? Promise.resolve();
    let done;
    const mine = new Promise((resolve) => { done = resolve; });
    const tail = before.then(() => mine);
    queues.set(key, tail);
    await before;
    try {
      return await fn();
    } finally {
      done();
      if (queues.get(key) === tail) queues.delete(key);
    }
  }

  /**
   * Marks the live subscriptions a group pays here to stop renewing, each once (see the top of
   * this file): synchronous, so it runs inside the group's deletion and is undone with it. One being
   * taken back is wanted stopped again instead (`restop`, asked again once that taking back has
   * landed); one whose taking back the provider refused is simply stopped; one taken back while
   * another process asks it keeps that cancellation. A provider that can't stop one (the remote
   * one) marks nothing. → how many were marked now
   */
  function markOrganizationStop(organizationId) {
    if (!canStop()) return 0;
    const id = Number(organizationId);
    let marked = 0;
    for (const { ref } of database.all(`SELECT ref FROM billing_subscriptions WHERE provider = ? AND subject_type = 'organization'
      AND subject_id = ? AND status IN (${[...RENEWS].map(() => '?').join(', ')})`, source, id, ...RENEWS)) {
      const eventId = stopId(id, ref);
      const made = database.run(`INSERT OR IGNORE INTO billing_events (provider, event_id, type, outcome, received_at)
        VALUES (?, ?, 'stop', 'pending', ?)`, source, eventId, iso(clock())).changes;
      marked += made;
      if (!made) {
        moveStop(eventId, 'keeping', 'restop') || moveStop(eventId, 'rekeep', 'requested') || moveStop(eventId, 'keep', 'sending');
      }
    }
    return marked;
  }

  /**
   * Renewing again, asked of the provider for a stop in force there. The row is taken first
   * (`keeping`), so a stop that comes meanwhile, from here or from another process, waits for it
   * (`restop`) and is asked again once it has landed: never dropped by it, never sent beside it.
   * Throws what the provider answered when it refused: the row is then `rekeep`, for the sweep, or
   * simply stopped when it was wanted stopped again. → whether it renews again
   */
  async function keepNow(eventId, from, id, ref, stale) {
    if (!moveStop(eventId, from, 'keeping')) return false;
    try {
      await provider.keepSubscription(ref);
    } catch (err) {
      moveStop(eventId, 'keeping', 'rekeep') || moveStop(eventId, 'restop', 'requested');
      log(`[billing] ${source}: organization #${id}'s subscription ${ref} could not renew again yet, tried again later: ${err.message}`);
      throw err;
    }
    if (dropStop(eventId, 'keeping')) {
      recordStop('billing.organization.keep', id, ref);
      return true;
    }
    // Wanted stopped again while this was on its way: asked again, now that it has landed.
    if (moveStop(eventId, 'restop', 'pending')) await sendStop(eventId, id, ref, stale);
    return false;
  }

  /** A stop's state and when it got there. */
  const stateOf = (eventId) => database.get(`SELECT outcome, received_at FROM billing_events WHERE provider = ? AND event_id = ?
    AND type = 'stop'`, source, eventId) ?? null;

  /** One marked stop, asked or taken back as its state says, read again under its group's turn. */
  async function sendStop(eventId, id, ref, stale) {
    const state = stateOf(eventId);
    if (!state) return null;
    const old = state.received_at < stale;
    if (state.outcome === 'rekeep') {
      if (!renews(ref)) dropStop(eventId, 'rekeep');
      else await keepNow(eventId, 'rekeep', id, ref, stale).catch(() => {});
      return null;
    }
    if ((state.outcome === 'keep' || state.outcome === 'keeping') && old) {
      // Taken back by a process that never said how that ended (it stopped): whether the provider
      // still has the cancellation is not known here, and asking to renew one that may be the
      // payer's own would charge them against their word. Said, and dropped.
      if (dropStop(eventId, state.outcome)) {
        log(`[billing] ${source}: organization #${id}'s subscription ${ref} was being taken back by a process that stopped: check at the provider whether it still renews`);
      }
      return null;
    }
    // Wanted stopped again while a process that stopped was taking it back: asked again now.
    if (state.outcome === 'restop' && old) moveStop(eventId, 'restop', 'pending');
    // Taken before the provider is asked: another sweep, even of another process, leaves it alone.
    const taken = database.run(`UPDATE billing_events SET outcome = 'sending', received_at = ? WHERE provider = ? AND event_id = ?
      AND type = 'stop' AND (outcome = 'pending' OR (outcome = 'sending' AND received_at < ?))`, iso(clock()), source, eventId, stale).changes;
    if (!taken) return null;
    if (!renews(ref)) {
      moveStop(eventId, 'sending', 'ended');
      return null;
    }
    let answer;
    try {
      answer = await provider.cancelSubscription(ref);
    } catch (err) {
      // Taken back meanwhile by another process: nothing was stopped, so nothing is left to do.
      if (dropStop(eventId, 'keep')) return null;
      moveStop(eventId, 'sending', 'pending');
      log(`[billing] ${source}: organization #${id}'s subscription ${ref} could not be stopped yet, tried again later: ${err.message}`);
      return 'waiting';
    }
    const already = answer?.already === true;
    if (moveStop(eventId, 'sending', already ? 'already' : 'requested')) {
      if (already) return null;
      recordStop('billing.organization.stop', id, ref);
      return 'requested';
    }
    // Taken back by another process while the cancellation was on its way: it landed, so it is taken
    // back now. One the payer had made themselves is theirs, and stays.
    if (stateOf(eventId)?.outcome === 'keep') {
      if (already) dropStop(eventId, 'keep');
      else await keepNow(eventId, 'keep', id, ref, stale).catch(() => {});
    }
    return null;
  }

  /**
   * Asks the provider to stop, at the end of the period paid, every subscription marked and not
   * asked yet (of one group, or all: the hourly sweep), and again what it refused to renew. Each is
   * taken (`sending`) before the provider is asked, so two sweeps never ask twice; one that fails is
   * logged and stays for the next sweep; one whose subscription ended meanwhile is closed without
   * asking; one the provider already had is `already`. Each stop asked is audited
   * (`billing.organization.stop`). → { requested, waiting }: asked now, and still to ask
   */
  async function sendStops({ organizationId = null } = {}) {
    if (!canStop()) return { requested: 0, waiting: 0 };
    const stale = iso(clock() - SENDING_MS);
    const due = database.all(`SELECT event_id FROM billing_events WHERE provider = ? AND type = 'stop'
      AND event_id LIKE 'stop:organization:%' AND (outcome IN ('pending', 'rekeep')
        OR (outcome IN ('sending', 'keep', 'keeping', 'restop') AND received_at < ?)) ORDER BY received_at, event_id`, source, stale);
    let requested = 0;
    let waiting = 0;
    for (const { event_id: eventId } of due) {
      const [, id, ref] = STOP_ID.exec(eventId) || [];
      if (!ref || (organizationId != null && Number(id) !== Number(organizationId))) continue;
      const done = await oneAtATime(id, () => sendStop(eventId, id, ref, stale));
      if (done === 'requested') requested += 1;
      if (done === 'waiting') waiting += 1;
    }
    return { requested, waiting };
  }

  /**
   * A group's subscriptions stop renewing at the end of the period they paid for, asked of the
   * provider once each however many times this is called. `by`: who wants it (`app`, its own
   * "delete the family" with a grace; `members`, createSuite's, when all of them are waiting to be
   * deleted). → { requested, waiting }
   */
  async function stopOrganization(organizationId, { by = 'app' } = {}) {
    const origin = checkOrigin(by);
    if (!canStop()) return { requested: 0, waiting: 0 };
    database.tx(() => {
      database.run(`INSERT OR IGNORE INTO billing_events (provider, event_id, type, outcome, received_at)
        VALUES (?, ?, 'stop-by', 'wanted', ?)`, source, originId(organizationId, origin), iso(clock()));
      markOrganizationStop(organizationId);
    });
    // What is on its way for the group lands first: a keep then asks this stop itself, once landed.
    await oneAtATime(organizationId, async () => {});
    return sendStops({ organizationId });
  }

  /**
   * Taken back by `by` (one, or a list): when nobody else still wants the group stopped, what this
   * install asked to stop renews again (`keepSubscription`), a stop not asked yet is dropped, one on
   * its way is waited for and then taken back, and a cancellation the payer made themselves
   * (`already`) stays theirs. Whether anyone else wants it stopped is asked again once its turn
   * comes: a stop that came while it waited wins. Each provider call is tried even if another
   * fails; the first failure is thrown after. → how many renew again (0 while another still wants
   * it stopped)
   */
  async function keepOrganization(organizationId, { by = 'app' } = {}) {
    const origins = [by].flat().map(checkOrigin);
    if (!canStop()) return 0;
    const id = Number(organizationId);
    database.tx(() => {
      for (const origin of origins) {
        database.run('DELETE FROM billing_events WHERE provider = ? AND event_id = ? AND type = \'stop-by\'', source, originId(id, origin));
      }
    });
    if (stopOriginsOf(id).length) return 0;
    return oneAtATime(id, async () => {
      // Asked again in its turn: someone may have wanted it stopped while this waited.
      if (stopOriginsOf(id).length) return 0;
      const stale = iso(clock() - SENDING_MS);
      let kept = 0;
      let failure = null;
      for (const { event_id: eventId } of stopsOf(id)) {
        const [, , ref] = STOP_ID.exec(eventId) || [];
        if (!ref) continue;
        // Read again for each: what came before it may have moved it.
        const outcome = stateOf(eventId)?.outcome ?? null;
        if (outcome === 'sending') {
          // Another process is asking it: taken back once it lands, there.
          if (moveStop(eventId, 'sending', 'keep')) kept += 1;
          continue;
        }
        if ((outcome === 'requested' || outcome === 'rekeep') && renews(ref)) {
          try {
            if (await keepNow(eventId, outcome, id, ref, stale)) kept += 1;
          } catch (err) {
            failure ??= err;
          }
          continue;
        }
        // Another process is taking it back, or wants it stopped again meanwhile: left to it.
        if (outcome === 'keeping' || outcome === 'restop') continue;
        if (['pending', 'already', 'ended', 'requested', 'rekeep'].includes(outcome)) dropStop(eventId, outcome);
      }
      if (failure) throw failure;
      return kept;
    });
  }

  /**
   * A group deleted (organizations.remove, hooked by createSuite after the app's own hooks), inside
   * its transaction. `stop` (billing.stopOnOrganizationDeleted): its live subscriptions are marked
   * to stop, sent once the transaction is over (and by the hourly sweep if that fails). Who wanted
   * it stopped no longer matters, nobody can take it back. Its customer link goes whatever the
   * options say: it names nobody now, and the customer is whoever's it pays for next. `forget`
   * (billing.forgetOnRemove): its subscription rows go too, as a person's do.
   * → { marked, customers, subscriptions }
   */
  function organizationDeleted(organizationId, { stop = false, forget = false } = {}) {
    const id = Number(organizationId);
    return database.tx(() => {
      const marked = stop ? markOrganizationStop(id) : 0;
      database.run(`DELETE FROM billing_events WHERE provider = ? AND type = 'stop-by' AND event_id LIKE ?`,
        source, `stop-by:%:organization:${id}`);
      const customers = database.run(`DELETE FROM billing_customers WHERE provider = ? AND subject_type = 'organization'
        AND subject_id = ?`, source, id).changes;
      const subscriptions = forget ? database.run(`DELETE FROM billing_subscriptions WHERE provider = ?
        AND subject_type = 'organization' AND subject_id = ?`, source, id).changes : 0;
      // A deletion undone leaves no mark, and the sweep finds nothing to send.
      if (marked) setImmediate(() => sendStops().catch((err) => log(`[billing] ${source}: stopping a group's renewals failed: ${err?.stack || err}`)));
      return { marked, customers, subscriptions };
    });
  }

  return {
    enabled, errors, provider: source, offer, apply, claim, founder, checkoutUrl, portalUrl, handleWebhook,
    customerOf, linkCustomer, subscriptionsOf, stopRenewals, keepRenewals, endSubscriptions, forget,
    markOrganizationStop, sendStops, stopOrganization, keepOrganization, stopOriginsOf, organizationDeleted,
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
