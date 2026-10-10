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
 * provider may also mark an event `foreign` itself (Paddle's `paddleProductIds`). Off by default:
 * as before, such an event links the customer and waits for its person, then is ignored.
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
 *     subject?: { type, id }, customer?, ref, product?, status?, periodEnd?, quantity?, app?, foreign? }
 */
import crypto from 'node:crypto';
import { HttpError, badRequest, notFound, unauthorized, sendJson, readBody, readJson } from './http.js';
import { ensureColumn } from './migrate.js';

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
 */
export function createBilling({
  database, entitlements, provider = null, products = {}, graceDays = 3, audit = null,
  identities = null, isFounder = () => false, clock = () => Date.now(), log = console.log,
  ignoreUnknownProducts = false, app = null,
}) {
  const errors = [];
  if (typeof ignoreUnknownProducts !== 'boolean') errors.push('ignoreUnknownProducts must be true or false');
  if (app !== null && !/^[a-z][a-z0-9-]{1,30}$/.test(String(app))) errors.push(`app "${app}": lowercase letters, digits and -, starting with a letter`);
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

  function applySubscription(event, subject, product) {
    const known = database.get('SELECT * FROM billing_subscriptions WHERE provider = ? AND ref = ?', source, event.ref);
    if (known && known.occurred_at > event.occurredAt) return 'stale';
    const now = iso(clock());
    database.run(`INSERT INTO billing_subscriptions (provider, ref, subject_type, subject_id, product, status, quantity,
        period_end, occurred_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (provider, ref) DO UPDATE SET subject_type = excluded.subject_type, subject_id = excluded.subject_id,
        product = excluded.product, status = excluded.status, quantity = excluded.quantity,
        period_end = excluded.period_end, occurred_at = excluded.occurred_at, updated_at = excluded.updated_at`,
    source, event.ref, subject.type, subject.id, product.key, event.status, event.quantity ?? null,
    event.periodEnd ?? null, event.occurredAt, now);

    if (SUBSCRIPTION_KEEPS.has(event.status)) {
      const end = Date.parse(event.periodEnd);
      if (Number.isNaN(end)) throw badRequest('field_invalid', { field: 'period_end' });
      // A period paid back doesn't give the plan again; the next one paid for does.
      if (known?.refunded_until && end <= Date.parse(known.refunded_until)) return 'refunded';
      return holdPlan(subject, product, event.ref, iso(end + graceDays * DAY), event.quantity);
    }
    if (SUBSCRIPTION_ENDS.has(event.status)) {
      return entitlements.revoke({ source, externalRef: event.ref }) ? 'revoked' : 'nothing';
    }
    return 'kept';   // past_due, incomplete…: the grant lapses on its own if nothing else comes
  }

  function applyPurchase(event, subject, product) {
    if (activeGrant(event.ref)) return 'duplicate';
    const endsAt = product.days ? iso(Date.parse(event.occurredAt) + product.days * DAY) : null;
    entitlements.grant({
      subjectType: subject.type, subjectId: subject.id, plan: product.plan, quantity: event.quantity ?? null,
      source, externalRef: event.ref, endsAt, note: product.key,
    });
    return 'granted';
  }

  /** A refund: the grant ends, and a subscription's refunded period can't bring it back. */
  function applyRefund(event) {
    database.run(`UPDATE billing_subscriptions SET refunded_until = COALESCE(period_end, ?)
      WHERE provider = ? AND ref = ?`, event.occurredAt, source, event.ref);
    return entitlements.revoke({ source, externalRef: event.ref }) ? 'revoked' : 'nothing';
  }

  /**
   * Whether an event (not a refund) is another product's: the provider says so, it names another
   * app, or —with ignoreUnknownProducts— its product isn't in this catalog. Each check is off
   * unless its option is on, so by default nothing is foreign.
   */
  function isForeign(event) {
    if (event.foreign === true) return true;
    if (app && typeof event.app === 'string' && event.app !== app) return true;
    return ignoreUnknownProducts && !Object.hasOwn(catalog, String(event.product ?? ''));
  }

  /** A subscription or a purchase, for an account here. */
  function applyTo(event, subject, { byIdentity = false } = {}) {
    // Before the customer is linked: another product's customer is nobody's here. This also
    // covers what was waiting since before the option was on (claim).
    if (isForeign(event)) return 'foreign';
    linkCustomer(subject, event.customer, { takeOver: byIdentity });
    const product = catalog[event.product];
    if (!product) {
      log(`[billing] ${source} event ${event.id}: unknown product "${event.product}", ignored`);
      return 'ignored';
    }
    if (event.type === 'subscription') return applySubscription(event, subject, product);
    if (event.type === 'purchase') return applyPurchase(event, subject, product);
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

  /** Keeps an event until that identity has an account here. */
  function hold(event, identity) {
    database.run(`INSERT INTO billing_pending (provider, identity_provider, identity_subject, ref, event, occurred_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, source, String(identity.provider), String(identity.subject),
    event.ref, JSON.stringify(event), event.occurredAt, iso(clock()));
    return 'pending';
  }

  /**
   * Applies one event, once. Returns what it did: granted, extended, changed,
   * revoked, refunded, kept, stale, pending, duplicate, ignored, nothing or
   * foreign (another product's, with the options at the top of this file).
   */
  function apply(event) {
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
        outcome = waiting ? hold(normalized, waiting) : applyRefund(normalized);
      } else if (isForeign(normalized)) {
        // Before whoIs(): nothing of the person is looked up, linked or kept for them.
        outcome = 'foreign';
        log(`[billing] ${source} event ${event.id}: another product's, ignored`);
      } else {
        const who = whoIs(normalized);
        if (who.waits) {
          outcome = hold(normalized, who.waits);
        } else if (who.subject) {
          subject = who.subject;
          outcome = applyTo(normalized, subject, { byIdentity: who.byIdentity });
        } else {
          log(`[billing] ${source} event ${event.id}: no known subject, ignored`);
        }
      }
      database.run('INSERT INTO billing_events (provider, event_id, type, outcome, received_at) VALUES (?, ?, ?, ?, ?)',
        source, String(event.id), normalized.type, outcome, iso(clock()));
      if (!['ignored', 'nothing', 'kept', 'stale', 'duplicate', 'pending', 'foreign'].includes(outcome)) {
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
    // A second subscription would charge twice: plans are changed in the portal.
    if (product.kind === 'subscription' && database.get(`SELECT 1 FROM billing_subscriptions WHERE provider = ?
      AND subject_type = ? AND subject_id = ? AND status IN ('active', 'trialing', 'past_due')`, source, subject.type, subject.id)) {
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

  return {
    enabled, errors, provider: source, offer, apply, claim, founder, checkoutUrl, portalUrl, handleWebhook,
    customerOf, linkCustomer, subscriptionsOf, stopRenewals, keepRenewals, endSubscriptions,
  };
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

  router.post('/api/billing/portal', async (ctx) => {
    const { subject } = await subjectOf(ctx);
    sendJson(ctx.res, 200, { url: await billing.portalUrl(subject, { returnUrl: back('/') }) });
  });

  router.get('/api/billing/subscriptions', (ctx) => {
    if (!ctx.user) throw unauthorized();
    sendJson(ctx.res, 200, { subscriptions: billing.subscriptionsOf({ type: 'user', id: ctx.user.id }) });
  });

  router.post('/api/billing/webhook', (ctx) => billing.handleWebhook(ctx.req, ctx.res));
}
