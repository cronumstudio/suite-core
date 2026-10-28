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
 *   { workos_user_id: 'user_01…', email, product: 'pro-yearly', app?: 'work' }
 *
 * (`app` only when billing.js is given one: which app sold it.) Since 0.128.0 it also
 * carries `sig`, made here: an HMAC of who pays, the product, the price, the app
 * and the customer this server put on the transaction. Paddle.js lets anyone
 * open a checkout for any price with any custom_data from the browser, so an
 * event whose `sig` is missing or doesn't match its own price is `unsigned`, and
 * billing.js grants nothing for a subscription or purchase it has never heard of
 * on such an event (a founder's price bought by someone who isn't one). A known
 * subscription keeps going without it: one bought before 0.128.0 has none, and
 * a plan changed in the portal keeps the first checkout's custom_data on a new
 * price. A signature that holds but names another customer (or none) is
 * `customerUnsigned`: who pays is right, but the customer isn't proven theirs,
 * so billing.js doesn't move a customer link another account has to them.
 *
 * The key: `signingSecret` (PADDLE_CHECKOUT_SECRET) when given, else one derived
 * from the notification destination's secret. Installs that hear each other's
 * sales as their own (one subscription for several apps, a destination each)
 * must share PADDLE_CHECKOUT_SECRET; rotating the destination's secret without
 * it leaves unsigned only checkouts opened before and paid after the change.
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
 *
 * One Paddle account may sell other products (Tracker next to Cronum Work), and
 * every notification destination gets every event. Two options keep another
 * product's sales out, both off by default:
 *   strictPrices       the product comes only from this install's price ids
 *                      (`price`, `founderPrice`, `oldPrices`), never from
 *                      `custom_data.product`, which another product may name the same
 *   paddleProductIds   the Paddle products (pro_…) this install sells: an event
 *                      whose items are all of other products is marked foreign,
 *                      with nothing of who paid; one with an item of its own is
 *                      marked `own`, and when strictPrices finds none of this
 *                      install's prices in it, `unknownPrice` names the price, so
 *                      billing.js says a price is missing from the config instead
 *                      of calling this install's own sale another product's
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

/** The key that signs a checkout's custom_data: its own secret, or one derived from the destination's. */
export function checkoutSigningKey({ webhookSecret, signingSecret = '' }) {
  return crypto.createHmac('sha256', String(signingSecret || webhookSecret)).update('cronum paddle custom_data v1').digest();
}

/**
 * The `sig` of a checkout's custom_data: who pays (the WorkOS id, or "user:12" where there is
 * none: both fields, so neither can be added later), the product, the price, the app and the
 * customer, as this server put them on the transaction.
 */
export function signCustomData(key, { workosUserId = null, subject = null, product, price, app = null, customer = null }) {
  return crypto.createHmac('sha256', key)
    .update(['v1', workosUserId ?? '', subject ?? '', product ?? '', price ?? '', app ?? '', customer ?? ''].map(String).join('|'))
    .digest('hex');
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
 * @param {boolean} [options.strictPrices] the product only from the products' prices (see above)
 * @param {string[]} [options.paddleProductIds]   the Paddle products this install sells (see above)
 * @param {string} [options.signingSecret]  the key of the checkouts' `sig` (see above); empty, one
 *   derived from webhookSecret
 * @param {string} [options.apiBase]       the environment's API, or a stand-in for tests
 * @param {Function} [options.fetch]
 */
export function paddleProvider({
  apiKey, webhookSecret, environment = 'production', checkoutUrl = '', products = {},
  strictPrices = false, paddleProductIds = null, signingSecret = '',
  apiBase = PADDLE_API[environment], fetch = globalThis.fetch, clock = () => Date.now(), log = console.log,
}) {
  if (!apiKey) throw new Error('paddleProvider: an API key is needed');
  if (!webhookSecret) throw new Error('paddleProvider: the notification destination\'s secret is needed');
  if (!PADDLE_API[environment]) throw new Error(`paddleProvider: environment "${environment}" is not sandbox or production`);
  if (typeof strictPrices !== 'boolean') throw new Error('paddleProvider: strictPrices is true or false');
  // An empty list would make every sale of the account foreign, this install's too.
  if (paddleProductIds !== null && !(Array.isArray(paddleProductIds) && paddleProductIds.length
    && paddleProductIds.every((id) => typeof id === 'string' && /^pro_[a-z0-9]{26}$/.test(id)))) {
    throw new Error('paddleProvider: paddleProductIds is a list of at least one Paddle product id (pro_…)');
  }
  const ownProducts = paddleProductIds ? new Set(paddleProductIds) : null;
  const signingKey = checkoutSigningKey({ webhookSecret, signingSecret });
  const base = String(apiBase).replace(/\/+$/, '');
  // A founder's price is the same product as the regular one: both are recognised, and so are
  // the old prices that subscriptions bought before a change of price still renew on.
  const productOfPrice = {};
  for (const [key, spec] of Object.entries(products || {})) {
    const old = Array.isArray(spec?.oldPrices) ? spec.oldPrices : [];
    for (const price of [spec?.price, spec?.founderPrice, ...old]) if (price) productOfPrice[price] = key;
  }
  /** The product of a price; without strictPrices, what custom_data names when the price is unknown. */
  const productOf = (price, customData) => (strictPrices ? productOfPrice[price] : productOfPrice[price] || customData?.product);
  /**
   * Whose a notification's items are, by their Paddle products: 'other' when every one is of a
   * product this install doesn't sell, 'own' when one is of its own, null when it can't tell
   * (no paddleProductIds, or items without a product id).
   */
  const ownerOf = (items) => {
    if (!ownProducts) return null;
    const ids = (Array.isArray(items) ? items : []).map((item) => item?.price?.product_id).filter((id) => typeof id === 'string');
    if (!ids.length) return null;
    return ids.some((id) => ownProducts.has(id)) ? 'own' : 'other';
  };
  /**
   * The event's product. An item of this install's own Paddle product also says `own`, and when
   * no product here lists its price (strictPrices) `unknownPrice`: a price left out of the
   * config, which billing.js reports as such and never as another product's sale.
   */
  const productFields = (owner, price, customData) => {
    const product = productOf(price, customData);
    if (owner !== 'own') return { product };
    return { product, own: true, ...(product ? {} : { unknownPrice: price }) };
  };
  /** Another product's event: what billing.js needs to keep it once, and nothing of who paid. */
  const foreignEvent = (notification, type, occurredAt, ref) => ({
    id: notification.event_id, type, occurredAt, ref, foreign: true,
  });

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
    subject, identity = null, customer = null, product, price, email = null, returnUrl, app = null,
  }) {
    if (!price) throw badRequest('product_unknown', { product });
    const customerId = customer || (email ? await customerByEmail(email) : null);
    const who = identity?.provider === 'workos' ? { workos_user_id: identity.subject } : { subject: `${subject.type}:${subject.id}` };
    const customData = {
      ...who,
      ...(email ? { email } : {}),
      product,
      ...(app ? { app } : {}),
      sig: signCustomData(signingKey, {
        workosUserId: who.workos_user_id, subject: who.subject, product, price, app, customer: customerId,
      }),
    };
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

  /**
   * A subscription that stops: at the end of the period already paid (it
   * won't renew), or `now`. Paddle answers the subscription's change through
   * the webhook, as when the person cancels in the portal. → `{ already }`:
   * whether Paddle had it so before this asked (billing.js never renews one of
   * those again: it is the payer's own cancellation).
   */
  async function cancelSubscription(ref, { now = false } = {}) {
    const path = `/subscriptions/${encodeURIComponent(ref)}`;
    try {
      await call('POST', `${path}/cancel`, { effective_from: now ? 'immediately' : 'next_billing_period' });
      return { already: false };
    } catch (err) {
      // Paddle refuses to cancel again one whose cancellation is already scheduled (in the portal, or
      // by a request whose answer never came: subscription_locked_pending_changes), and any change
      // to one already canceled. What was asked may be so already: it is read, and counts if it is.
      if (err?.code !== 'billing_provider_error') throw err;
      const subscription = await call('GET', path).catch(() => null);
      const done = subscription?.status === 'canceled' || (!now && subscription?.scheduled_change?.action === 'cancel');
      if (!done) throw err;
      return { already: true };
    }
  }

  /** A cancellation scheduled for the period's end taken back: it renews again. */
  async function keepSubscription(ref) {
    await call('PATCH', `/subscriptions/${encodeURIComponent(ref)}`, { scheduled_change: null });
  }

  /**
   * Who an entity's custom_data says pays: their WorkOS id, or the subject of an install without it;
   * and which app sold it, when the checkout said (only then, so events stay as they were).
   */
  function whoOf(customData) {
    const workosId = customData?.workos_user_id;
    const app = customData?.app;
    return {
      identity: typeof workosId === 'string' && /^user_[A-Za-z0-9]{10,64}$/.test(workosId) ? { provider: 'workos', subject: workosId } : null,
      subject: subjectFrom(customData?.subject),
      // Any text counts, cut short: one that isn't this app's id is another app's.
      ...(typeof app === 'string' && app ? { app: app.slice(0, 64) } : {}),
    };
  }

  /**
   * Whether an entity's custom_data carries this server's `sig` for its price: `{}` when it does,
   * for its customer too; `{ customerUnsigned: true }` when it does but was made for another
   * customer, or none; `{ unsigned: true }` when it is missing or made for anything else.
   */
  function signatureOf(customData, price, customer) {
    const sig = customData?.sig;
    if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return { unsigned: true };
    const text = (value) => (typeof value === 'string' ? value : null);
    const fields = {
      workosUserId: text(customData.workos_user_id), subject: text(customData.subject),
      product: text(customData.product), price, app: text(customData.app),
    };
    const matches = (customerId) => crypto.timingSafeEqual(Buffer.from(sig, 'hex'),
      Buffer.from(signCustomData(signingKey, { ...fields, customer: customerId }), 'hex'));
    if (!(fields.workosUserId || fields.subject) || !price) return { unsigned: true };
    if (customer && matches(customer)) return {};
    return matches(null) ? { customerUnsigned: true } : { unsigned: true };
  }

  /** One Paddle notification as the suite's event, or null when it says nothing billing.js needs. */
  function translate(notification) {
    const type = notification?.event_type;
    const object = notification?.data || {};
    const occurredAt = isoOf(notification.occurred_at) || new Date(clock()).toISOString();
    const customer = object.customer_id ?? null;

    if (/^subscription\.(created|updated|canceled|paused|resumed|activated|past_due|trialing)$/.test(type)) {
      const owner = ownerOf(object.items);
      if (owner === 'other') return foreignEvent(notification, 'subscription', occurredAt, object.id);
      const item = object.items?.[0] || {};
      const price = item.price?.id || null;
      return {
        id: notification.event_id, type: 'subscription', occurredAt, customer,
        ...whoOf(object.custom_data),
        ...signatureOf(object.custom_data, price, customer),
        ref: object.id,
        ...productFields(owner, price, object.custom_data),
        status: object.status,
        periodEnd: isoOf(object.current_billing_period?.ends_at),
        // Cancelled for the period's end (in the portal, or by billing.js): it won't renew.
        ending: object.scheduled_change?.action === 'cancel',
        quantity: item.quantity ?? null,
      };
    }

    if (type === 'transaction.completed') {
      // A subscription's transactions are followed by its own subscription.* events.
      if (object.subscription_id) return null;
      const owner = ownerOf(object.items);
      if (owner === 'other') return foreignEvent(notification, 'purchase', occurredAt, object.id);
      const price = object.items?.[0]?.price?.id || null;
      return {
        id: notification.event_id, type: 'purchase', occurredAt, customer,
        ...whoOf(object.custom_data),
        ...signatureOf(object.custom_data, price, customer),
        ref: object.id,
        ...productFields(owner, price, object.custom_data),
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
    cancelSubscription, keepSubscription,
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

const ENVIRONMENTS = Object.keys(PADDLE_API);
const PRODUCT_ID = /^pro_[a-z0-9]{26}$/;

/**
 * BILLING_PROVIDER=paddle, as providers.js registers it: PADDLE_ENV (production by default),
 * PADDLE_API_KEY, PADDLE_WEBHOOK_SECRET, and optionally PADDLE_CHECKOUT_URL (the page with
 * Paddle.js), PADDLE_CHECKOUT_SECRET and PADDLE_API_BASE. Its own setting of suite.config.js
 * `billing`, `paddleProductIds`, is given per environment: a sandbox product's id is never the
 * live one's, so one list for both would be right in one of them and, in the other, make every
 * sale of this install foreign without a word. With Paddle on, the ones of PADDLE_ENV are used
 * and must be there: a guard asked for and left without them would let every other product's
 * sale in.
 */
export const paddleBilling = Object.freeze({
  id: 'paddle',
  name: 'Paddle',
  fromEnv(env, { errors }) {
    const environment = env.PADDLE_ENV || 'production';
    const missing = ['PADDLE_API_KEY', 'PADDLE_WEBHOOK_SECRET'].filter((name) => !env[name]);
    if (missing.length) errors.push(`BILLING_PROVIDER=paddle needs ${missing.join(' and ')}`);
    else if (!PADDLE_API[environment]) errors.push(`PADDLE_ENV "${env.PADDLE_ENV}": use sandbox or production`);
    else if (!/^pdl_(sdbx|live)_apikey_\S+$/.test(env.PADDLE_API_KEY)) errors.push('PADDLE_API_KEY must be a Paddle API key (pdl_sdbx_apikey_…, pdl_live_apikey_…)');
    // A sandbox key against the live API (or the other way round) only fails at the first checkout.
    else if ((environment === 'sandbox') !== env.PADDLE_API_KEY.startsWith('pdl_sdbx_')) {
      errors.push(`PADDLE_API_KEY is a ${env.PADDLE_API_KEY.startsWith('pdl_sdbx_') ? 'sandbox' : 'live'} key but PADDLE_ENV is ${environment}`);
    } else if (!/^pdl_ntfset_\S+$/.test(env.PADDLE_WEBHOOK_SECRET)) errors.push('PADDLE_WEBHOOK_SECRET must be the secret of the app\'s notification destination (pdl_ntfset_…)');
    else if (env.PADDLE_CHECKOUT_URL && !/^https:\/\/[^/\s]+\/\S*$/.test(env.PADDLE_CHECKOUT_URL)
      && !(environment === 'sandbox' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\S*$/.test(env.PADDLE_CHECKOUT_URL))) {
      errors.push(`PADDLE_CHECKOUT_URL "${env.PADDLE_CHECKOUT_URL}" must be an https address (the page with Paddle.js)`);
    } else if (env.PADDLE_CHECKOUT_SECRET && String(env.PADDLE_CHECKOUT_SECRET).length < 32) {
      errors.push('PADDLE_CHECKOUT_SECRET must be at least 32 characters (it signs what each checkout says, paddle.js)');
    } else {
      return {
        provider: 'paddle', apiKey: env.PADDLE_API_KEY, webhookSecret: env.PADDLE_WEBHOOK_SECRET, environment,
        apiBase: String(env.PADDLE_API_BASE || PADDLE_API[environment]).replace(/\/+$/, ''),
        checkoutUrl: env.PADDLE_CHECKOUT_URL || '',
        // The key of each checkout's signature; empty, one derived from PADDLE_WEBHOOK_SECRET. Installs
        // that grant one subscription together, a notification destination each, share it.
        signingSecret: env.PADDLE_CHECKOUT_SECRET || '',
      };
    }
    return null;
  },
  environment: (install) => install.environment,
  priceId: { pattern: /^pri_[a-z0-9]{26}$/, name: 'a Paddle price id (pri_…)' },
  // Only Paddle's checkout writes the app, and only Paddle's events carry it with a price and a product id.
  honors: ['app', 'strictPrices'],
  rules: {
    keys: ['paddleProductIds'],
    read(given, install, errors) {
      if (given.paddleProductIds == null) return {};
      const paddle = install?.provider === 'paddle';
      const environment = paddle ? install.environment : 'production';
      let ids = given.paddleProductIds;
      if (ids && typeof ids === 'object' && !Array.isArray(ids)) {
        for (const name of Object.keys(ids)) {
          if (!ENVIRONMENTS.includes(name)) errors.push(`billing.paddleProductIds: "${name}" is not sandbox or production`);
        }
        ids = ids[environment] ?? null;
      }
      if (paddle && Array.isArray(given.paddleProductIds)) {
        errors.push("billing.paddleProductIds: one list per environment, { sandbox: ['pro_…'], production: ['pro_…'] }, as Paddle's product ids differ between them");
      } else if (ids != null && !(Array.isArray(ids) && ids.every((id) => typeof id === 'string' && PRODUCT_ID.test(id)))) {
        errors.push('billing.paddleProductIds: a list of Paddle product ids (pro_…) for each environment');
      } else if (paddle && !ids?.length) {
        errors.push(`billing.paddleProductIds: none for PADDLE_ENV ${environment}`);
      } else return { paddleProductIds: ids?.length ? [...ids] : null };
      return {};
    },
  },
  create: (install, { products, rules = {}, log }) => paddleProvider({
    apiKey: install.apiKey, webhookSecret: install.webhookSecret, environment: install.environment,
    apiBase: install.apiBase, checkoutUrl: install.checkoutUrl, signingSecret: install.signingSecret, products, log,
    strictPrices: rules.strictPrices ?? false, paddleProductIds: rules.paddleProductIds ?? null,
  }),
});
