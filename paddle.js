/**
 * Paddle as billing.js's provider (BILLING_PROVIDER=paddle): Paddle Billing is
 * a merchant of record, so it sells, charges the tax of each country, invoices
 * and refunds; the app only hears what happened. No SDK: a few JSON calls with
 * fetch, and the signature checked here.
 *
 * The checkout is a transaction made here, through the API, and paid on a page
 * with Paddle.js: Paddle answers the transaction's payment link, the install's
 * checkout page (PADDLE_CHECKOUT_URL, or the account's default payment link)
 * with `?_ptxn=txn_…`, and that page opens the checkout for it.
 *
 * Who pays travels in the transaction's `custom_data`, which Paddle copies to
 * the subscription it makes and sends back in every webhook:
 *
 *   { workos_user_id: 'user_01…', email, product: 'pro-yearly' }
 *
 * The WorkOS id, and not the app's own id of the person, because one
 * subscription (Cronum Work) is for every app of the suite and each app has its
 * own database: every app gets every webhook (a notification destination each)
 * and finds the person by who they are at WorkOS. One who hasn't opened that
 * app yet gets the plan when they first sign in there (billing.js keeps it
 * pending). An install without WorkOS says `subject: "user:12"` instead.
 *
 * The events used, and what they become:
 *   subscription.created / .updated / .canceled / .paused / .resumed / .activated → subscription
 *   transaction.completed, not for a subscription                                → purchase
 *   adjustment.created / .updated: a full refund or a chargeback, approved        → refund
 * Everything else is acknowledged and ignored. Paddle retries and may deliver
 * out of order: billing.js applies each event once and never lets an older one
 * undo a newer.
 */
import crypto from 'node:crypto';
import { HttpError, badRequest } from './http.js';

export const PADDLE_API = Object.freeze({
  sandbox: 'https://sandbox-api.paddle.com',
  production: 'https://api.paddle.com',
});

/**
 * Checks a `Paddle-Signature` header: `ts=<unix seconds>;h1=<hex HMAC-SHA256 of
 * "ts:body">`, maybe with several h1 (while a secret is being rotated), within
 * five minutes, so an old delivery can't be replayed.
 */
export function verifyPaddleSignature(secret, body, header, { toleranceSeconds = 300, now = Date.now() } = {}) {
  let ts = null;
  const signatures = [];
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 'ts') ts = Number(value);
    else if (key === 'h1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(Buffer.from(value, 'hex'));
  }
  if (!Number.isInteger(ts) || !signatures.length) return false;
  if (Math.abs(now / 1000 - ts) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest();
  return signatures.some((signature) => crypto.timingSafeEqual(expected, signature));
}

/** `ts=…;h1=…` for a body, as Paddle signs it: what the tests use. */
export function signPaddlePayload(secret, body, at = Date.now()) {
  const ts = Math.floor(at / 1000);
  return `ts=${ts};h1=${crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex')}`;
}

/** "user:12" → { type: 'user', id: 12 }; anything else → null. */
function subjectFrom(value) {
  const match = /^(user|organization):(\d+)$/.exec(String(value ?? ''));
  return match ? { type: match[1], id: Number(match[2]) } : null;
}

const isoOf = (value) => {
  const ms = Date.parse(value ?? '');
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

/**
 * @param {object} options
 * @param {string} options.apiKey          the API key of the environment (Developer tools → Authentication)
 * @param {string} options.webhookSecret   the secret of this app's notification destination
 * @param {'sandbox'|'production'} [options.environment]
 * @param {string} [options.checkoutUrl]   the page with Paddle.js that pays a transaction; empty, the
 *   account's default payment link
 * @param {object} [options.products]      the app's products, to recognise a price changed in the portal
 * @param {string} [options.apiBase]       the environment's API, or a stand-in for tests
 * @param {Function} [options.fetch]
 */
export function paddleProvider({
  apiKey, webhookSecret, environment = 'production', checkoutUrl = '', products = {},
  apiBase = PADDLE_API[environment], fetch = globalThis.fetch, clock = () => Date.now(), log = console.log,
}) {
  if (!apiKey) throw new Error('paddleProvider: an API key is needed');
  if (!webhookSecret) throw new Error('paddleProvider: the notification destination\'s secret is needed');
  if (!PADDLE_API[environment]) throw new Error(`paddleProvider: environment "${environment}" is not sandbox or production`);
  const base = String(apiBase).replace(/\/+$/, '');
  // A founder's price is the same product as the regular one: both are recognised.
  const productOfPrice = {};
  for (const [key, spec] of Object.entries(products || {})) {
    for (const price of [spec?.price, spec?.founderPrice]) if (price) productOfPrice[price] = key;
  }

  async function call(method, path, body = undefined) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Paddle-Version': '1',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      log(`[billing] paddle ${method} ${path}: ${err.message}`);
      throw new HttpError(502, 'billing_provider_unavailable');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      // Paddle says what was wrong (a price that doesn't exist, a key without
      // the permission): it goes to the log, never to the person paying.
      log(`[billing] paddle ${method} ${path}: ${res.status} ${data?.error?.code || ''} ${data?.error?.detail || ''}`.trim());
      throw new HttpError(502, 'billing_provider_error');
    }
    return data?.data;
  }

  /**
   * The person's customer at Paddle by their email, made if there is none, so
   * the checkout opens with it filled in and every purchase of theirs is one
   * customer. Only for an email the app knows is theirs: billing.js only hands
   * in a verified one.
   */
  async function customerByEmail(email) {
    const found = await call('GET', `/customers?${new URLSearchParams({ email, per_page: '1' })}`);
    if (found?.[0]?.id) return found[0].id;
    return (await call('POST', '/customers', { email }))?.id ?? null;
  }

  /**
   * A transaction for the product, and its payment link. The price is the one
   * billing.js chose (the founder's, for whoever is one): the person never
   * names a price.
   */
  async function checkout({
    subject, identity = null, customer = null, product, price, email = null, returnUrl,
  }) {
    if (!price) throw badRequest('product_unknown', { product });
    const customData = {
      ...(identity?.provider === 'workos' ? { workos_user_id: identity.subject } : { subject: `${subject.type}:${subject.id}` }),
      ...(email ? { email } : {}),
      product,
    };
    const customerId = customer || (email ? await customerByEmail(email) : null);
    const page = checkoutUrl ? new URL(checkoutUrl) : null;
    if (page) {
      if (returnUrl) page.searchParams.set('return', returnUrl);
      // The page can't tell which environment a transaction is from, and Paddle.js needs to know.
      if (environment === 'sandbox') page.searchParams.set('env', 'sandbox');
    }
    const transaction = await call('POST', '/transactions', {
      items: [{ price_id: price, quantity: 1 }],
      ...(customerId ? { customer_id: customerId } : {}),
      custom_data: customData,
      ...(page ? { checkout: { url: page.toString() } } : {}),
    });
    const url = transaction?.checkout?.url;
    if (!url) {
      log(`[billing] paddle POST /transactions: no payment link (is a default payment link set for ${environment}?)`);
      throw new HttpError(502, 'billing_provider_error');
    }
    return url;
  }

  /** The customer portal: invoices, payment method, changing plan or cancelling. */
  async function portalUrl({ customer }) {
    const session = await call('POST', `/customers/${encodeURIComponent(customer)}/portal-sessions`, {});
    const url = session?.urls?.general?.overview;
    if (!url) {
      log('[billing] paddle portal session without a link');
      throw new HttpError(502, 'billing_provider_error');
    }
    return url;
  }

  /** Who an entity's custom_data says pays: their WorkOS id, or the subject of an install without it. */
  function whoOf(customData) {
    const workosId = customData?.workos_user_id;
    return {
      identity: typeof workosId === 'string' && /^user_[A-Za-z0-9]{10,64}$/.test(workosId) ? { provider: 'workos', subject: workosId } : null,
      subject: subjectFrom(customData?.subject),
    };
  }

  /** One Paddle notification as the suite's event, or null when it says nothing billing.js needs. */
  function translate(notification) {
    const type = notification?.event_type;
    const object = notification?.data || {};
    const occurredAt = isoOf(notification.occurred_at) || new Date(clock()).toISOString();
    const customer = object.customer_id ?? null;

    if (/^subscription\.(created|updated|canceled|paused|resumed|activated|past_due|trialing)$/.test(type)) {
      const item = object.items?.[0] || {};
      const price = item.price?.id || null;
      return {
        id: notification.event_id, type: 'subscription', occurredAt, customer,
        ...whoOf(object.custom_data),
        ref: object.id,
        product: productOfPrice[price] || object.custom_data?.product,
        status: object.status,
        periodEnd: isoOf(object.current_billing_period?.ends_at),
        quantity: item.quantity ?? null,
      };
    }

    if (type === 'transaction.completed') {
      // A subscription's transactions are followed by its own subscription.* events.
      if (object.subscription_id) return null;
      const price = object.items?.[0]?.price?.id || null;
      return {
        id: notification.event_id, type: 'purchase', occurredAt, customer,
        ...whoOf(object.custom_data),
        ref: object.id,
        product: productOfPrice[price] || object.custom_data?.product,
        quantity: object.items?.[0]?.quantity ?? null,
      };
    }

    if (type === 'adjustment.created' || type === 'adjustment.updated') {
      // A refund waits for Paddle's approval; only a full one, or a chargeback,
      // takes the plan back: a partial refund or a credit is a gesture.
      if (object.status !== 'approved' || object.type !== 'full') return null;
      if (!['refund', 'chargeback'].includes(object.action)) return null;
      return {
        id: notification.event_id, type: 'refund', occurredAt, customer,
        // What the plan was granted for: the subscription, or the one-off transaction.
        ref: object.subscription_id || object.transaction_id,
        subscription: Boolean(object.subscription_id),
      };
    }
    return null;
  }

  async function parseWebhook({ headers, body }) {
    if (!verifyPaddleSignature(webhookSecret, body, headers['paddle-signature'], { now: clock() })) {
      throw new HttpError(400, 'bad_signature');
    }
    let notification;
    try {
      notification = JSON.parse(body);
    } catch {
      throw badRequest('invalid_json');
    }
    return translate(notification);
  }

  return {
    id: providerId(environment), needsPrice: true, environment, checkoutUrl: checkout, portalUrl, parseWebhook, translate,
  };
}

/**
 * The provider's id, which billing.js writes on customers, subscriptions,
 * events and grants: one per environment. The sandbox's customers and
 * subscriptions don't exist in the live account, so an install that moves
 * from one to the other must not find the old ones (a sandbox customer handed
 * to the live API fails the checkout; a sandbox subscription would say
 * "already subscribed").
 */
export const providerId = (environment) => (environment === 'sandbox' ? 'paddle-sandbox' : 'paddle');

/**
 * Migration 19: before 0.48.0 both environments wrote "paddle", and the only
 * Paddle data any install has from then is the sandbox's (the live account
 * sold nothing before this version), so it becomes "paddle-sandbox".
 */
export function paddleEnvironmentsSchema(d) {
  const has = (table) => d.columnsOf(table).length > 0;
  for (const table of ['billing_customers', 'billing_subscriptions', 'billing_events', 'billing_pending']) {
    if (has(table)) d.run(`UPDATE ${table} SET provider = 'paddle-sandbox' WHERE provider = 'paddle'`);
  }
  if (has('entitlement_grants')) d.run("UPDATE entitlement_grants SET source = 'paddle-sandbox' WHERE source = 'paddle'");
}
