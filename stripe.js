/**
 * Stripe as billing.js's provider (BILLING_PROVIDER=stripe): its hosted
 * Checkout and Customer Portal, and its signed webhooks turned into the
 * suite's normalized events. No SDK: a few form-encoded calls with fetch, and
 * the signature checked here.
 *
 * What goes to Stripe says who pays and for what, so the webhooks can say it
 * back without the app keeping any state of its own: the checkout session, the
 * subscription and the payment carry `metadata.subject` ("user:12",
 * "organization:3") and `metadata.product` (the product key of the app's
 * configuration). A subscription changed later in the portal is recognised by
 * its price instead, from the products' `price`.
 *
 * The events used, and what they become:
 *   checkout.session.completed / .async_payment_succeeded, one-off payment → purchase
 *   customer.subscription.created / .updated / .deleted                    → subscription
 *   charge.refunded, in full                                                → refund
 * Everything else is acknowledged and ignored. Stripe retries and reorders;
 * billing.js applies each event once and never lets an older one undo a newer.
 */
import crypto from 'node:crypto';
import { HttpError, badRequest } from './http.js';

const iso = (seconds) => (Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null);

/**
 * Checks a `Stripe-Signature` header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of
 * "t.body">`, maybe with several v1 (while a secret is being rolled), within
 * five minutes, so an old delivery can't be replayed.
 */
export function verifyStripeSignature(secret, body, header, { toleranceSeconds = 300, now = Date.now() } = {}) {
  let t = null;
  const signatures = [];
  for (const part of String(header || '').split(',')) {
    const i = part.indexOf('=');
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 't') t = Number(value);
    else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(Buffer.from(value, 'hex'));
  }
  if (!Number.isInteger(t) || !signatures.length) return false;
  if (Math.abs(now / 1000 - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest();
  return signatures.some((signature) => crypto.timingSafeEqual(expected, signature));
}

/** `t=…,v1=…` for a body, as Stripe signs it: what the tests use. */
export function signStripePayload(secret, body, at = Date.now()) {
  const t = Math.floor(at / 1000);
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/** "user:12" → { type: 'user', id: 12 }; anything else → null. */
function subjectFrom(value) {
  const match = /^(user|organization):(\d+)$/.exec(String(value ?? ''));
  return match ? { type: match[1], id: Number(match[2]) } : null;
}

/** Stripe's form encoding of nested parameters: metadata[subject]=…, line_items[0][price]=… */
function formOf(params, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') formOf(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

/**
 * @param {object} options
 * @param {string} options.secretKey       sk_… (or a restricted rk_… with Checkout and Portal)
 * @param {string} options.webhookSecret   whsec_…, the signing secret of the webhook endpoint
 * @param {object} [options.products]      the app's products, to recognise a price changed in the portal
 * @param {string} [options.apiBase]       https://api.stripe.com, or a stand-in for tests
 * @param {Function} [options.fetch]
 */
export function stripeProvider({
  secretKey, webhookSecret, products = {}, apiBase = 'https://api.stripe.com',
  fetch = globalThis.fetch, clock = () => Date.now(), log = console.log,
}) {
  if (!secretKey) throw new Error('stripeProvider: a secret key is needed');
  if (!webhookSecret) throw new Error('stripeProvider: the webhook signing secret is needed');
  const base = String(apiBase).replace(/\/+$/, '');
  const productOfPrice = Object.fromEntries(Object.entries(products || {})
    .filter(([, spec]) => spec?.price).map(([key, spec]) => [spec.price, key]));

  async function call(path, params) {
    let res;
    try {
      res = await fetch(`${base}/v1${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formOf(params).toString(),
      });
    } catch (err) {
      log(`[billing] stripe ${path}: ${err.message}`);
      throw new HttpError(502, 'billing_provider_unavailable');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.url) {
      // Stripe says what was wrong (a price that doesn't exist, a key without
      // access): it goes to the log, never to the person paying.
      log(`[billing] stripe ${path}: ${res.status} ${data?.error?.message || ''}`.trim());
      throw new HttpError(502, 'billing_provider_error');
    }
    return data.url;
  }

  /** A call that answers an object, not a page: what a subscription's changes need. */
  async function request(method, path, params = null) {
    let res;
    try {
      res = await fetch(`${base}/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(params ? { body: formOf(params).toString() } : {}),
      });
    } catch (err) {
      log(`[billing] stripe ${method} ${path}: ${err.message}`);
      throw new HttpError(502, 'billing_provider_unavailable');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      log(`[billing] stripe ${method} ${path}: ${res.status} ${data?.error?.message || ''}`.trim());
      throw new HttpError(502, 'billing_provider_error');
    }
    return data;
  }

  /**
   * A subscription that stops: at the end of the period already paid (`cancel_at_period_end`), or
   * `now`. Stripe answers the change through the webhook. → `{ already }`: whether it was so before
   * this asked, the payer's own cancellation, which billing.js never renews again. Stripe takes the
   * same change twice without a word, so at the period's end the subscription is read first; one
   * already canceled, which Stripe won't change, is read after it refuses.
   */
  async function cancelSubscription(ref, { now = false } = {}) {
    const path = `/subscriptions/${encodeURIComponent(ref)}`;
    if (!now) {
      const subscription = await request('GET', path);
      if (subscription?.status === 'canceled' || subscription?.cancel_at_period_end === true) return { already: true };
    }
    try {
      await (now ? request('DELETE', path) : request('POST', path, { cancel_at_period_end: true }));
      return { already: false };
    } catch (err) {
      if (err?.code !== 'billing_provider_error') throw err;
      const subscription = await request('GET', path).catch(() => null);
      if (subscription?.status !== 'canceled') throw err;
      return { already: true };
    }
  }

  /** A cancellation at the period's end taken back: it renews again. */
  async function keepSubscription(ref) {
    await request('POST', `/subscriptions/${encodeURIComponent(ref)}`, { cancel_at_period_end: false });
  }

  /** A hosted Checkout page: a subscription or a one-off payment, for a person or a group. */
  function checkoutUrl({ subject, customer = null, product, price, kind = 'subscription', email = null, returnUrl }) {
    if (!price) throw badRequest('product_unknown', { product });
    const who = `${subject.type}:${subject.id}`;
    const metadata = { subject: who, product };
    const cancelUrl = String(returnUrl).replace('billing=done', 'billing=canceled');
    const params = {
      mode: kind === 'once' ? 'payment' : 'subscription',
      line_items: [{ price, quantity: 1 }],
      success_url: returnUrl,
      cancel_url: cancelUrl,
      client_reference_id: who,
      metadata,
      ...(customer ? { customer } : { customer_email: email ?? undefined }),
      ...(kind === 'once'
        // A customer is made for one-off payments too, so the portal and refunds find them.
        ? { payment_intent_data: { metadata }, ...(customer ? {} : { customer_creation: 'always' }) }
        : { subscription_data: { metadata } }),
    };
    return call('/checkout/sessions', params);
  }

  /** The Customer Portal: invoices, payment method, changing plan or cancelling. */
  const portalUrl = ({ customer, returnUrl }) => call('/billing_portal/sessions', { customer, return_url: returnUrl });

  /** One Stripe event as the suite's, or null when it says nothing billing.js needs. */
  function translate(event) {
    const object = event?.data?.object || {};
    const occurredAt = iso(event.created) || new Date(clock()).toISOString();
    const customer = typeof object.customer === 'string' ? object.customer : object.customer?.id ?? null;

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      // A subscription is followed by its own customer.subscription.* events.
      if (object.mode !== 'payment' || object.payment_status !== 'paid') return null;
      return {
        id: event.id, type: 'purchase', occurredAt, customer,
        subject: subjectFrom(object.metadata?.subject || object.client_reference_id),
        ref: object.payment_intent || object.id, product: object.metadata?.product,
      };
    }

    if (/^customer\.subscription\.(created|updated|deleted)$/.test(event.type)) {
      const item = object.items?.data?.[0] || {};
      const price = item.price?.id || null;
      return {
        id: event.id, type: 'subscription', occurredAt, customer,
        subject: subjectFrom(object.metadata?.subject),
        ref: object.id,
        product: productOfPrice[price] || object.metadata?.product,
        status: event.type.endsWith('deleted') ? 'canceled' : object.status,
        // Where the paid period ends moved from the subscription to its items in newer API versions.
        periodEnd: iso(object.current_period_end ?? item.current_period_end),
        ending: object.cancel_at_period_end === true,
        quantity: item.quantity ?? object.quantity ?? null,
      };
    }

    if (event.type === 'charge.refunded') {
      // Only a full refund takes the purchase back; a partial one is a gesture.
      if (!object.refunded) return null;
      return { id: event.id, type: 'refund', occurredAt, customer, ref: object.payment_intent || object.id };
    }
    return null;
  }

  async function parseWebhook({ headers, body }) {
    if (!verifyStripeSignature(webhookSecret, body, headers['stripe-signature'], { now: clock() })) {
      throw new HttpError(400, 'bad_signature');
    }
    let event;
    try {
      event = JSON.parse(body);
    } catch {
      throw badRequest('invalid_json');
    }
    return translate(event);
  }

  return {
    id: 'stripe', needsPrice: true, checkoutUrl, portalUrl, parseWebhook, translate, cancelSubscription, keepSubscription,
  };
}

/** BILLING_PROVIDER=stripe, as providers.js registers it. */
export const stripeBilling = Object.freeze({
  id: 'stripe',
  name: 'Stripe',
  fromEnv(env, { baseUrl = '', errors, warnings }) {
    const missing = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'].filter((name) => !env[name]);
    if (missing.length) errors.push(`BILLING_PROVIDER=stripe needs ${missing.join(' and ')}`);
    else if (!/^(sk|rk)_(test|live)_\S+$/.test(env.STRIPE_SECRET_KEY)) errors.push('STRIPE_SECRET_KEY must be a Stripe secret key (sk_test_…, sk_live_…) or a restricted one (rk_…)');
    else if (!/^whsec_\S+$/.test(env.STRIPE_WEBHOOK_SECRET)) errors.push('STRIPE_WEBHOOK_SECRET must be the webhook endpoint\'s signing secret (whsec_…)');
    else {
      if (env.STRIPE_SECRET_KEY.includes('_live_') && !baseUrl.startsWith('https://')) {
        warnings.push('STRIPE_SECRET_KEY is a live key but BASE_URL is not https: Stripe will not reach the webhook');
      }
      return {
        provider: 'stripe', secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET,
        apiBase: String(env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, ''),
      };
    }
    return null;
  },
  create: (install, { products, log }) => stripeProvider({
    secretKey: install.secretKey, webhookSecret: install.webhookSecret, apiBase: install.apiBase, products, log,
  }),
});
