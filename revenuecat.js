/**
 * RevenueCat as the store purchase adapter (STORE_BILLING=revenuecat, stores.js): what people buy
 * inside an app on a phone, in the App Store and in Google Play, read from RevenueCat and handed to
 * billing.js as the suite's events. No SDK: one JSON call with fetch, and the webhook checked here.
 *
 * Who buys. The app on the phone tells RevenueCat an App User ID: the opaque id this install gives
 * each account (`GET /api/billing/stores/customer`, a random UUID kept in `billing_customers`),
 * never the WorkOS id, an email or anything else RevenueCat could tie to the person elsewhere. Each
 * install has its own, so a sale in one product's app is nobody's in another's. In RevenueCat's
 * dashboard, restores are set to "Keep with original App User ID": a purchase stays with the
 * account that made it, and restoring it under another account is refused.
 *
 * The webhook is only a trigger. It is checked (the Authorization header set in RevenueCat's
 * dashboard, and with REVENUECAT_WEBHOOK_SECRET also `X-RevenueCat-Webhook-Signature`), and then
 * what it says is not believed: the adapter asks RevenueCat for the customer as it is now
 * (`GET /v1/subscribers/{app_user_id}`, with the project's secret key) and gives one event per
 * subscription or purchase found there. So a delivery that comes late, twice or out of order, or
 * one forged with a stolen header value, can only make the app look again at what RevenueCat
 * really holds. Only this install's customers are looked up: that call creates a customer at
 * RevenueCat for an id it doesn't know.
 *
 * What a subscription becomes, at the time RevenueCat answered:
 *   refunded (refunded_at after its last purchase, or a CANCELLATION of that transaction by
 *   customer support)                                  → refund: the grant ends, the period paid back
 *                                                        doesn't bring it back (REFUND_REVERSED does)
 *   paid until a later date, or in the store's grace   → active (trialing in a free trial) until then
 *   period after a failed charge (BILLING_ISSUE)
 *   past that date: paused (Google Play)               → paused
 *                   a charge failed and the store is   → past_due: nothing changes, the grant lapses
 *                   still retrying                       on its own
 *                   otherwise, or after EXPIRATION     → ended
 * A one-off purchase (non_subscriptions) is a purchase, for a product of kind `once`; one that
 * leaves the list (refunded) is taken back by stores.js, and one customer support refunded (the
 * CANCELLATION names its transaction) is refunded even while RevenueCat still lists it. A TRANSFER
 * is the same purchases under another App User ID: both customers are looked at again. A purchase
 * shared through Apple's Family Sharing (when the product allows it) counts for whoever it is
 * shared with, as the store says.
 *
 * What a later reading can't tell is noted (stores.js keeps the notes): a refunded_at the store
 * took back (REFUND_REVERSED) or that was an older renewal's (the CANCELLATION named another
 * transaction than the subscription's latest) no longer takes the period back; a one-off refunded
 * while still listed stays refunded until a REFUND_REVERSED of its transaction. Unverified until
 * the stores' sandbox tests (Tracker's A12): whether RevenueCat clears refunded_at when a refund is
 * reversed, whether it removes a refunded one-off from non_subscriptions, and that refunded_at
 * and store_transaction_id are the latest purchase's. Each answer is handled either way.
 *
 * Refs. RevenueCat's v1 API names no original transaction for a subscription, so the ref is made of
 * what it does name, the same for the webhook and for the app's sync: the store, `-sandbox` for a
 * test purchase (TestFlight, App Review, Google's license testers), the store's product id (with
 * Google's base plan) and a digest of the customer, `app_store:com.example.app.pro.monthly:3f…`.
 * It stays the same through renewals, lapses and a new purchase of that product; another product
 * (a change of plan) is another subscription.
 *
 * Another product's sales. A RevenueCat project may hold more than one app, and other stores (the
 * web through Stripe or Paddle, promotional grants): an event for a store other than the App Store
 * and Google Play, for a product none of `stores.products` names, or from the sandbox when
 * REVENUECAT_SANDBOX=off, is foreign (only its id, type and outcome are kept) and nobody is looked
 * up for it; the same purchases in a customer are left out. A subscription to one of this app's
 * store products on a base plan no product lists is said in the log and grants nothing.
 */
import crypto from 'node:crypto';
import { HttpError, badRequest, unauthorized } from './http.js';
import { verifySignature } from './billing.js';
import { STORE_FIELDS } from './stores.js';

export const REVENUECAT_API = 'https://api.revenuecat.com';

/** The stores whose purchases count, as the API names them; the webhook says them in capitals. */
export const STORES = Object.freeze(['app_store', 'play_store']);

/** Where each store lets people manage or cancel a subscription: the server can't do it for them. */
export const STORE_MANAGE_URLS = Object.freeze({
  app_store: 'https://apps.apple.com/account/subscriptions',
  play_store: 'https://play.google.com/store/account/subscriptions',
});

/** What `stores.products` calls each store, and the store's own name (stores.js). */
export { STORE_FIELDS };

/** The webhooks that may change what someone has; the rest (experiments, aliases…) are acknowledged. */
const TRIGGERS = new Set([
  'INITIAL_PURCHASE', 'RENEWAL', 'CANCELLATION', 'UNCANCELLATION', 'NON_RENEWING_PURCHASE', 'SUBSCRIPTION_PAUSED',
  'EXPIRATION', 'BILLING_ISSUE', 'PRODUCT_CHANGE', 'SUBSCRIPTION_EXTENDED', 'REFUND_REVERSED', 'TRANSFER',
]);

const iso = (ms) => new Date(ms).toISOString();
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const msOf = (value) => {
  const ms = Date.parse(value ?? '');
  return Number.isNaN(ms) ? null : ms;
};
/** Google's `subscription:base-plan` and an older product's `subscription`: the same subscription. */
const baseOf = (id) => String(id ?? '').split(':')[0];
/** The store's name as the API says it (`app_store`), from the webhook's (`APP_STORE`) too. */
const storeOf = (value) => {
  const name = String(value ?? '').toLowerCase();
  return STORES.includes(name) ? name : null;
};
/** Two secrets compared in constant time, whatever their lengths. */
const sameSecret = (given, expected) => typeof given === 'string' && crypto.timingSafeEqual(
  crypto.createHash('sha256').update(given).digest(), crypto.createHash('sha256').update(String(expected)).digest(),
);
/** What stands for a customer in its refs: never the App User ID itself. */
const customerKey = (customer) => crypto.createHash('sha256').update(`revenuecat|${customer}`).digest('hex').slice(0, 16);

/**
 * @param {object} options
 * @param {string} options.webhookAuth     the Authorization header value set in the webhook (RevenueCat's dashboard)
 * @param {string} [options.webhookSecret] the webhook's signing secret: then its signature is required too
 * @param {string} options.apiKey          a secret API key of the project (sk_…), for GET /v1/subscribers
 * @param {object} [options.products]      stores.products: { key: { plan, kind, appStore?, playStore? } }
 * @param {boolean} [options.sandbox]      whether test purchases count (TestFlight, App Review): marked as such
 * @param {string} [options.apiBase]       the API, or a stand-in for tests
 * @param {Function} [options.fetch]
 * @param {number} [options.timeoutMs]     how long to wait for RevenueCat's answer
 */
export function revenuecatProvider({
  webhookAuth, webhookSecret = null, apiKey, products = {}, sandbox = true,
  apiBase = REVENUECAT_API, fetch = globalThis.fetch, clock = () => Date.now(), log = console.log, timeoutMs = 10000,
}) {
  if (typeof webhookAuth !== 'string' || webhookAuth.length < 16) {
    throw new Error('revenuecatProvider: the webhook\'s Authorization header value is needed, 16 characters or more');
  }
  if (webhookSecret !== null && !(typeof webhookSecret === 'string' && webhookSecret.length >= 16)) {
    throw new Error('revenuecatProvider: the webhook\'s signing secret, when given, has 16 characters or more');
  }
  if (typeof apiKey !== 'string' || !/^sk_\S{8,}$/.test(apiKey)) {
    throw new Error('revenuecatProvider: a secret API key of the project (sk_…) is needed, never an app\'s public key');
  }
  if (typeof sandbox !== 'boolean') throw new Error('revenuecatProvider: sandbox is true or false');
  const base = String(apiBase).replace(/\/+$/, '');

  // Each store's product ids → the product, and every product's subscription id (Google's base
  // part): what tells this app's products from another app's in the same project.
  const byStore = Object.fromEntries(STORES.map((store) => [store, new Map()]));
  const ownBases = new Set();
  for (const [key, spec] of Object.entries(products || {})) {
    for (const [field, store] of Object.entries(STORE_FIELDS)) {
      if (typeof spec?.[field] !== 'string' || !spec[field]) continue;
      byStore[store].set(spec[field], { key, kind: spec.kind });
      ownBases.add(baseOf(spec[field]));
    }
  }

  /** The customer as RevenueCat holds it now. The id goes in the path only, never in the log. */
  async function subscriber(customer) {
    const path = '/v1/subscribers/…';
    let res;
    try {
      res = await fetch(`${base}/v1/subscribers/${encodeURIComponent(customer)}`, {
        method: 'GET',
        // No X-Platform: looking someone up from the server is not their app being opened.
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      log(`[billing] revenuecat GET ${path}: ${err?.name === 'TimeoutError' ? `no answer in ${timeoutMs} ms` : err?.message}`);
      throw new HttpError(502, 'billing_provider_unavailable');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      // A wrong key, a limit: the status and RevenueCat's code go to the log, never its message,
      // which may repeat the id.
      log(`[billing] revenuecat GET ${path}: ${res.status} ${data?.code ?? ''}`.trim());
      throw new HttpError(502, res.status === 429 || res.status >= 500 ? 'billing_provider_unavailable' : 'billing_provider_error');
    }
    if (!isObject(data?.subscriber)) {
      log(`[billing] revenuecat GET ${path}: an answer without a subscriber`);
      throw new HttpError(502, 'billing_provider_error');
    }
    return data;
  }

  /** What a hint of the webhook says about one subscription, if it is about that one. */
  const hintFor = (hints, storeProduct) => (isObject(hints) ? hints[baseOf(storeProduct)] ?? null : null);

  /** The transaction a store entry names, if it names one. */
  const transactionOf = (entry) => (typeof entry?.store_transaction_id === 'string' && entry.store_transaction_id
    ? entry.store_transaction_id : null);

  /**
   * One subscription of the customer, at `now`: a refund, or its status and until when. `noted`
   * asks what an earlier reading noted, and what this one finds goes into `notes`.
   */
  function stateOf(entry, hint, now, { ref, noted, notes }) {
    const purchased = msOf(entry.purchase_date) ?? 0;
    const expires = msOf(entry.expires_date);
    if (expires === null) return null;
    const transaction = transactionOf(entry);
    const reversed = hint?.type === 'refund_reversed';
    // The transaction customer support refunded, as the webhook names it: this period's, or an older one's.
    const named = hint?.type === 'refund' && hint.transaction ? hint.transaction : null;
    const refundedAt = msOf(entry.refunded_at);
    const cleared = refundedAt === null ? null : `refund-cleared/${ref}@${refundedAt}`;
    let byDate = refundedAt !== null && refundedAt >= purchased && !noted(cleared);
    if (byDate && (reversed || (named !== null && transaction !== null && named !== transaction))) {
      // RevenueCat may keep refunded_at after the store took the refund back, or say it for an
      // older renewal's refund: from now on that date doesn't take this period back.
      notes.push(cleared);
      byDate = false;
    }
    const refunded = !reversed && (byDate || (named !== null && named === transaction));
    if (refunded) return { refund: true };
    // The store's grace period after a failed charge keeps what was paid for, as the store does.
    const end = Math.max(expires, msOf(entry.grace_period_expires_date) ?? expires);
    const extra = reversed ? { refundReversed: true } : {};
    // Turned off in the store's settings: it lasts until the period's end and doesn't renew.
    const ending = msOf(entry.unsubscribe_detected_at) !== null;
    if (end > now) {
      return { status: String(entry.period_type).toLowerCase() === 'trial' ? 'trialing' : 'active', periodEnd: iso(end), ending, ...extra };
    }
    if (entry.auto_resume_date) return { status: 'paused', periodEnd: iso(expires), ...extra };
    const issue = msOf(entry.billing_issues_detected_at);
    const finished = hint?.type === 'ended' && purchased <= (hint.at ?? now);
    if (issue !== null && issue >= purchased && !finished) return { status: 'past_due', periodEnd: iso(expires), ...extra };
    return { status: 'ended', periodEnd: iso(expires), ...extra };
  }

  /**
   * What a customer has now, as the suite's events. `cause` names them (the webhook's id, or a
   * sync), so a delivery sent again is applied once. `present`: the refs of everything of the
   * customer in these stores, granted or not, so stores.js takes back only what is gone. `notes`:
   * what the readings after must remember (the top of this file), asked again with `noted`.
   */
  async function customerEvents(customer, { cause, hints = null, noted = () => false } = {}) {
    const data = await subscriber(customer);
    const answered = Number(data.request_date_ms);
    const now = Number.isFinite(answered) && answered > 0 ? answered : (msOf(data.request_date) ?? clock());
    const key = customerKey(customer);
    const events = [];
    const present = new Set();
    const notes = [];
    const wasNoted = (note) => Boolean(note) && Boolean(noted(note));
    const subscriptions = isObject(data.subscriber.subscriptions) ? data.subscriber.subscriptions : {};
    for (const [productId, entry] of Object.entries(subscriptions)) {
      const store = storeOf(entry?.store);
      if (!store || (entry.is_sandbox === true && !sandbox)) continue;
      const plan = typeof entry.product_plan_identifier === 'string' && entry.product_plan_identifier && !productId.includes(':')
        ? `:${entry.product_plan_identifier}` : '';
      const storeProduct = `${productId}${plan}`;
      const ref = `${store}${entry.is_sandbox === true ? '-sandbox' : ''}:${storeProduct}:${key}`;
      present.add(ref);
      const product = byStore[store].get(storeProduct) ?? byStore[store].get(productId);
      if (product?.kind !== 'subscription') {
        if (ownBases.has(baseOf(productId))) {
          log(`[billing] revenuecat: a subscription to ${storeProduct}, this app's store product on a base plan or kind none of stores.products lists: not granted until it is added`);
        }
        continue;
      }
      const state = stateOf(entry, hintFor(hints, storeProduct), now, { ref, noted: wasNoted, notes });
      if (!state) continue;
      const fields = { id: `${cause}/${ref}`, occurredAt: iso(now), customer, ref, product: product.key, sandbox: entry.is_sandbox === true };
      events.push(state.refund ? { ...fields, type: 'refund' } : { ...fields, type: 'subscription', ...state });
    }
    const purchases = isObject(data.subscriber.non_subscriptions) ? data.subscriber.non_subscriptions : {};
    for (const [productId, list] of Object.entries(purchases)) {
      for (const purchase of Array.isArray(list) ? list : []) {
        const store = storeOf(purchase?.store);
        if (!store || (purchase.is_sandbox === true && !sandbox) || !purchase.id) continue;
        const ref = `${store}${purchase.is_sandbox === true ? '-sandbox' : ''}:${productId}:${key}:${String(purchase.id).slice(0, 64)}`;
        present.add(ref);
        const product = byStore[store].get(productId);
        if (product?.kind !== 'once') continue;
        const fields = { id: `${cause}/${ref}`, customer, ref, product: product.key, sandbox: purchase.is_sandbox === true };
        // Customer support refunded it (the webhook names its transaction), and RevenueCat may go on
        // listing it: refunded now and in every reading after, until the store takes the refund back.
        const hint = hintFor(hints, productId);
        const transaction = transactionOf(purchase);
        const named = transaction !== null && hint?.transaction === transaction ? hint.type : null;
        const refundedNote = `refunded/${ref}`;
        const reversedNote = `refund-reversed/${ref}`;
        if (named === 'refund') {
          notes.push(refundedNote);
          events.push({ ...fields, type: 'refund', occurredAt: iso(now) });
          continue;
        }
        if (named === 'refund_reversed') {
          if (wasNoted(refundedNote)) notes.push(reversedNote);
        } else if (wasNoted(refundedNote) && !wasNoted(reversedNote)) {
          events.push({ ...fields, type: 'refund', occurredAt: iso(now) });
          continue;
        }
        events.push({ ...fields, type: 'purchase', occurredAt: iso(msOf(purchase.purchase_date) ?? now) });
      }
    }
    return { at: iso(now), events, present, notes };
  }

  /** Whether a webhook is about another product's sale: another store, the sandbox when off, other products. */
  function foreignOf(event) {
    if (event.environment === 'SANDBOX' && !sandbox) return true;
    if (event.store != null && !storeOf(event.store)) return true;
    const named = [event.product_id, event.new_product_id].filter((id) => typeof id === 'string' && id);
    return named.length > 0 && !named.some((id) => ownBases.has(baseOf(id)));
  }

  /** What the webhook knows that the customer's state may not say yet, per subscription. */
  function hintsOf(event, at) {
    const product = typeof event.product_id === 'string' ? baseOf(event.product_id) : '';
    if (!product) return {};
    const transaction = typeof event.transaction_id === 'string' && event.transaction_id ? event.transaction_id.slice(0, 100) : null;
    const bySupport = event.cancel_reason === 'CUSTOMER_SUPPORT' || event.expiration_reason === 'CUSTOMER_SUPPORT';
    if ((event.type === 'CANCELLATION' || event.type === 'EXPIRATION') && bySupport) {
      return { [product]: { type: 'refund', transaction, at } };
    }
    if (event.type === 'EXPIRATION') return { [product]: { type: 'ended', at } };
    if (event.type === 'REFUND_REVERSED') return { [product]: { type: 'refund_reversed', transaction, at } };
    return {};
  }

  /**
   * The webhook, checked and read: which customers to look at again, or that it is another
   * product's (`foreign`), or null when it changes nothing (a test, an experiment).
   */
  async function parseWebhook({ headers, body }) {
    if (!sameSecret(headers.authorization, webhookAuth)) throw unauthorized();
    if (webhookSecret && !verifySignature(webhookSecret, body, headers['x-revenuecat-webhook-signature'], { now: clock() })) {
      throw new HttpError(400, 'bad_signature');
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw badRequest('invalid_json');
    }
    const event = payload?.event;
    if (!isObject(event) || typeof event.id !== 'string' || !event.id) throw badRequest('invalid_event');
    if (!TRIGGERS.has(event.type)) return null;
    const stamp = Number(event.event_timestamp_ms);
    const at = Number.isFinite(stamp) && stamp > 0 ? stamp : clock();
    // The id names this delivery's rows in billing_events (and, as their cause, its readings'), so it
    // takes only letters, digits, - _ and . (RevenueCat's are UUIDs): never `:` or `/`, which the
    // store's notes use (stores.js). Any other id is replaced by its digest, the same each time.
    const id = /^[A-Za-z0-9._-]{1,100}$/.test(event.id) ? event.id
      : `rc-${crypto.createHash('sha256').update(event.id).digest('hex').slice(0, 32)}`;
    const notice = { id, type: event.type, occurredAt: iso(at), sandbox: event.environment === 'SANDBOX' };
    if (foreignOf(event)) return { ...notice, foreign: true, customers: [] };
    const ids = [event.app_user_id, event.original_app_user_id, ...[event.aliases, event.transferred_to, event.transferred_from]
      .flatMap((list) => (Array.isArray(list) ? list : []))];
    const customers = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 100
      && !id.startsWith('$RCAnonymousID:')))];
    return { ...notice, customers, hints: hintsOf(event, at) };
  }

  /** The store of a ref, whether it was a test purchase, and where people manage it. */
  function manage(ref) {
    const match = /^(app_store|play_store)(-sandbox)?:/.exec(String(ref ?? ''));
    return match ? { via: 'store', store: match[1], sandbox: Boolean(match[2]), url: STORE_MANAGE_URLS[match[1]] } : null;
  }

  return { id: 'revenuecat', kind: 'store', sandbox, parseWebhook, customerEvents, manage };
}

/**
 * STORE_BILLING=revenuecat, as providers.js registers it: REVENUECAT_WEBHOOK_AUTH (the
 * Authorization header value set in the webhook), REVENUECAT_API_KEY (a secret key of the
 * project, sk_…), optionally REVENUECAT_WEBHOOK_SECRET (the webhook's signing secret: then its
 * signature is required too) and REVENUECAT_SANDBOX (`on` by default: test purchases count, marked
 * as such, as App Review buys in the sandbox; `off` makes them another product's).
 */
export const revenuecatStores = Object.freeze({
  id: 'revenuecat',
  name: 'RevenueCat',
  fromEnv(env, { errors }) {
    const missing = ['REVENUECAT_WEBHOOK_AUTH', 'REVENUECAT_API_KEY'].filter((name) => !env[name]);
    const sandbox = env.REVENUECAT_SANDBOX || 'on';
    const apiBase = String(env.REVENUECAT_API_BASE || REVENUECAT_API).replace(/\/+$/, '');
    // The values themselves are never repeated: they are secrets.
    if (missing.length) errors.push(`STORE_BILLING=revenuecat needs ${missing.join(' and ')}`);
    else if (env.REVENUECAT_WEBHOOK_AUTH.length < 16) {
      errors.push('REVENUECAT_WEBHOOK_AUTH: the Authorization header value set in RevenueCat\'s webhook, 16 characters or more');
    } else if (!/^sk_\S{8,}$/.test(env.REVENUECAT_API_KEY)) {
      errors.push('REVENUECAT_API_KEY must be a secret API key of the RevenueCat project (sk_…), never an app\'s public key');
    } else if (env.REVENUECAT_WEBHOOK_SECRET && env.REVENUECAT_WEBHOOK_SECRET.length < 16) {
      errors.push('REVENUECAT_WEBHOOK_SECRET: the webhook\'s signing secret, 16 characters or more, or left empty');
    } else if (!['on', 'off'].includes(sandbox)) {
      errors.push(`REVENUECAT_SANDBOX "${sandbox}": use on or off`);
    } else if (!/^https?:\/\/[^/\s]+(\/\S*)?$/.test(apiBase)) {
      errors.push(`REVENUECAT_API_BASE "${env.REVENUECAT_API_BASE}" is not an http(s) address`);
    } else {
      return {
        provider: 'revenuecat', webhookAuth: env.REVENUECAT_WEBHOOK_AUTH, webhookSecret: env.REVENUECAT_WEBHOOK_SECRET || null,
        apiKey: env.REVENUECAT_API_KEY, apiBase, sandbox: sandbox === 'on',
      };
    }
    return null;
  },
  create: (install, { products, log }) => revenuecatProvider({
    webhookAuth: install.webhookAuth, webhookSecret: install.webhookSecret, apiKey: install.apiKey,
    apiBase: install.apiBase, sandbox: install.sandbox, products, log,
  }),
});
