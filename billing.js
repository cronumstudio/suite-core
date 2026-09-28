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
 *   refund                          → the purchase's grant ends now
 *
 * Providers retry and may deliver out of order: each event is applied once
 * (`billing_events`), and a subscription event older than the state already
 * known for it is ignored (`billing_subscriptions`).
 *
 * A provider adapter is:
 *   {
 *     id: 'stripe',
 *     checkoutUrl({ subject, customer, product, price, kind, email, returnUrl }) → Promise<url>,
 *     portalUrl({ customer, returnUrl }) → Promise<url>,
 *     parseWebhook({ headers, body }) → Promise<event | event[] | null>   (throws on a bad signature)
 *   }
 * and an event, whatever the provider called it:
 *   { id, type: 'subscription' | 'purchase' | 'refund', occurredAt, subject?: { type, id },
 *     customer?, ref, product?, status?, periodEnd?, quantity? }
 */
import crypto from 'node:crypto';
import { HttpError, badRequest, notFound, unauthorized, sendJson, readBody, readJson } from './http.js';

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
const SUBSCRIPTION_ENDS = new Set(['canceled', 'ended', 'unpaid', 'incomplete_expired']);

/**
 * @param {object} options
 * @param {object} options.database
 * @param {object} options.entitlements   from createEntitlements()
 * @param {object} [options.provider]     an adapter; without one billing is off
 * @param {object} [options.products]     what can be bought:
 *   { 'pro-monthly': { plan: 'pro', kind: 'subscription', price: 'price_…' },
 *     'pro-lifetime': { plan: 'pro', kind: 'once' }, 'pro-pass': { plan: 'pro', kind: 'once', days: 30 },
 *     'family-yearly': { plan: 'family', kind: 'subscription', for: 'organization' } }
 * @param {number} [options.graceDays]    after the paid period, before a subscription lapses
 * @param {object} [options.audit]
 */
export function createBilling({
  database, entitlements, provider = null, products = {}, graceDays = 3, audit = null,
  clock = () => Date.now(), log = console.log,
}) {
  const errors = [];
  const planIds = new Set(entitlements.describe().plans.map((p) => p.id));
  const catalog = {};
  for (const [key, spec] of Object.entries(products || {})) {
    if (!/^[a-z0-9_-]{1,40}$/.test(key)) errors.push(`Product "${key}": ids take lowercase letters, digits, - and _`);
    if (!spec || !planIds.has(spec.plan)) { errors.push(`Product "${key}": plan "${spec?.plan}" is not in the catalog`); continue; }
    if (!['subscription', 'once'].includes(spec.kind)) { errors.push(`Product "${key}": kind must be "subscription" or "once"`); continue; }
    if (spec.days != null && !(Number.isInteger(spec.days) && spec.days > 0)) errors.push(`Product "${key}": days must be a whole number above 0`);
    // Stripe sells prices: each product says which one (price_…).
    if (provider?.needsPrice && !spec.price) errors.push(`Product "${key}": ${provider.id} needs its price (price_…)`);
    catalog[key] = { key, plan: spec.plan, kind: spec.kind, days: spec.days ?? null, for: spec.for === 'organization' ? 'organization' : 'user', price: spec.price ?? null, name: spec.name ?? null };
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

  function linkCustomer(subject, customer) {
    if (!customer || customerOf(subject)) return;
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

  /**
   * Applies one event, once. Returns what it did: granted, extended, changed,
   * revoked, kept, stale, duplicate, ignored or nothing.
   */
  function apply(event) {
    if (!event?.id || !event.type || !event.ref) throw badRequest('invalid_event');
    const at = Date.parse(event.occurredAt);
    const normalized = { ...event, ref: String(event.ref), occurredAt: iso(Number.isNaN(at) ? clock() : at) };
    return database.tx(() => {
      if (database.get('SELECT 1 FROM billing_events WHERE provider = ? AND event_id = ?', source, String(event.id))) return 'duplicate';
      let outcome = 'ignored';
      const subject = normalized.subject?.type && Number.isInteger(normalized.subject.id)
        ? { type: normalized.subject.type === 'organization' ? 'organization' : 'user', id: normalized.subject.id }
        : subjectOfCustomer(normalized.customer);
      if (normalized.type === 'refund') {
        outcome = entitlements.revoke({ source, externalRef: normalized.ref }) ? 'revoked' : 'nothing';
      } else if (subject) {
        linkCustomer(subject, normalized.customer);
        const product = catalog[normalized.product];
        if (!product) {
          log(`[billing] ${source} event ${event.id}: unknown product "${normalized.product}", ignored`);
        } else if (normalized.type === 'subscription') {
          outcome = applySubscription(normalized, subject, product);
        } else if (normalized.type === 'purchase') {
          outcome = applyPurchase(normalized, subject, product);
        }
      } else {
        log(`[billing] ${source} event ${event.id}: no known subject, ignored`);
      }
      database.run('INSERT INTO billing_events (provider, event_id, type, outcome, received_at) VALUES (?, ?, ?, ?, ?)',
        source, String(event.id), normalized.type, outcome, iso(clock()));
      if (!['ignored', 'nothing', 'kept', 'stale', 'duplicate'].includes(outcome)) {
        record(`billing.${outcome}`, subject, { provider: source, product: normalized.product ?? null, ref: normalized.ref });
      }
      return outcome;
    });
  }

  /* ------------------------------- the web ------------------------------ */

  function mustBeOn() {
    if (!enabled) throw notFound('billing_off');
  }

  async function checkoutUrl(subject, productKey, { email = null, returnUrl }) {
    mustBeOn();
    const product = catalog[productKey];
    if (!product) throw badRequest('product_unknown', { product: productKey });
    if (product.for !== subject.type) throw badRequest('product_for', { for: product.for });
    // A second subscription would charge twice: plans are changed in the portal.
    if (product.kind === 'subscription' && database.get(`SELECT 1 FROM billing_subscriptions WHERE provider = ?
      AND subject_type = ? AND subject_id = ? AND status IN ('active', 'trialing', 'past_due')`, source, subject.type, subject.id)) {
      throw new HttpError(409, 'already_subscribed');
    }
    return provider.checkoutUrl({
      subject, customer: customerOf(subject), product: product.key, price: product.price, kind: product.kind, email, returnUrl,
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
  const offer = () => Object.values(catalog).map(({ key, plan, kind, days, for: forWhom, name }) => ({
    key, plan, kind, days, for: forWhom, name,
  }));

  const subscriptionsOf = (subject) => database.all(`SELECT ref, product, status, quantity, period_end, updated_at
    FROM billing_subscriptions WHERE provider = ? AND subject_type = ? AND subject_id = ? ORDER BY updated_at DESC`,
  source, subject.type, subject.id);

  return {
    enabled, errors, provider: source, offer, apply, checkoutUrl, portalUrl, handleWebhook,
    customerOf, linkCustomer, subscriptionsOf,
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

  router.get('/api/billing/products', (ctx) => {
    sendJson(ctx.res, 200, { provider: billing.provider, products: billing.offer() });
  });

  router.post('/api/billing/checkout', async (ctx) => {
    const { subject, body } = await subjectOf(ctx);
    const url = await billing.checkoutUrl(subject, body.product, { email: ctx.user.email ?? null, returnUrl: back('/?billing=done') });
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
