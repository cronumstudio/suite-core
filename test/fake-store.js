/**
 * A stand-in store for the tests (stores.test.js): a store's server with customers as it holds
 * them, its webhooks as it delivers them, and the store adapter stores.js describes that reads
 * them, with secrets made at run time, so nothing here looks like a real one. What the adapter
 * hands to stores.js has the shapes a real adapter's has: notices, billing.js's events with refs
 * of `<store>:<product>:<digest>`, `present`, `notes` and `manage`.
 */
import crypto from 'node:crypto';
import { HttpError, badRequest, unauthorized } from '../http.js';
import { signPayload, verifySignature } from '../billing.js';
import { STORE_FIELDS } from '../stores.js';

const iso = (ms) => new Date(ms).toISOString();
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

/** The adapter's id: what STORE_BILLING names, and the `provider` of what it holds. */
export const PROVIDER = 'test-store';

export const AUTH = `Bearer ${crypto.randomBytes(16).toString('hex')}`;
export const SIGNING = crypto.randomBytes(24).toString('hex');
export const KEY = crypto.randomBytes(12).toString('hex');

/** What a test app sells in the stores: two subscriptions (both stores) and a one-off purchase. */
export const PRODUCTS = Object.freeze({
  'pro-monthly': { plan: 'pro', kind: 'subscription', appStore: 'com.example.app.pro.monthly', playStore: 'app_pro:monthly' },
  'pro-yearly': { plan: 'pro', kind: 'subscription', appStore: 'com.example.app.pro.yearly', playStore: 'app_pro:yearly' },
  'pro-lifetime': { plan: 'pro', kind: 'once', appStore: 'com.example.app.pro.lifetime' },
});
export const MONTHLY = PRODUCTS['pro-monthly'].appStore;
export const YEARLY = PRODUCTS['pro-yearly'].appStore;
export const LIFETIME = PRODUCTS['pro-lifetime'].appStore;

/** The stores whose purchases count (stores.js's names), and where people manage a subscription. */
const STORES = Object.values(STORE_FIELDS);
export const MANAGE_URLS = Object.freeze(Object.fromEntries(STORES.map((store) => [store, `https://${store.replace('_', '-')}.example/subscriptions`])));

/** The webhooks that may change what someone has; a `test` changes nothing. */
const TRIGGERS = new Set(['purchased', 'renewed', 'cancelled', 'billing_issue', 'expired', 'refunded', 'refund_reversed', 'transferred']);

/**
 * The store's server: customers as it holds them, and every reading. `fail()` makes the next one
 * fail. `clock.now` is the time it answers.
 */
export function fakeStore(clock) {
  const customers = new Map();
  const calls = [];
  let failing = false;
  const customer = (id) => {
    if (!customers.has(id)) customers.set(id, { subscriptions: {}, purchases: {} });
    return customers.get(id);
  };
  const read = async (id, { key }) => {
    calls.push({ customer: id, key });
    if (failing) {
      failing = false;
      throw new Error('the store is down');
    }
    const held = customers.get(id) ?? { subscriptions: {}, purchases: {} };
    return { at: clock.now, ...structuredClone(held) };
  };
  return { customers, calls, customer, read, fail: () => { failing = true; } };
}

/** A subscription as the store holds it: times in ms, the store's names for what happened to it. */
export const subscription = ({
  purchased, expires, store = 'app_store', sandbox = false, trial = false, graceUntil = null, billingIssueAt = null,
  cancelledAt = null, refundedAt = null, transaction = '2000000000000001',
}) => ({ store, sandbox, purchased, expires, trial, graceUntil, billingIssueAt, cancelledAt, refundedAt, transaction });

/** A one-off purchase as the store holds it. */
export const purchase = ({ id, purchased, store = 'app_store', sandbox = false, transaction = null }) => ({
  id, purchased, store, sandbox, transaction,
});

/**
 * A webhook as the store delivers it: `{ id, type, at, customer, customers?, product?, transaction?,
 * store?, sandbox? }`, with its Authorization header and, given a secret, its signature.
 */
export function webhook(event, { auth = AUTH, secret = null, at = Date.now() } = {}) {
  const body = JSON.stringify({ id: crypto.randomUUID(), at, ...event });
  return { body, headers: { authorization: auth, ...(secret ? { 'x-store-signature': signPayload(secret, body, at) } : {}) } };
}

/**
 * The store adapter: the webhook checked and read as a notice, a customer read from the store's
 * server as billing.js's events, and where people manage what they bought.
 */
export function storeAdapter({
  auth, secret = null, key = null, products = {}, sandbox = true, api, clock = () => Date.now(),
}) {
  // Each store's product ids → the product: what tells this app's products from another app's.
  const byStore = Object.fromEntries(STORES.map((store) => [store, new Map()]));
  const own = new Set();
  for (const [productKey, spec] of Object.entries(products || {})) {
    for (const [field, store] of Object.entries(STORE_FIELDS)) {
      if (typeof spec?.[field] !== 'string' || !spec[field]) continue;
      byStore[store].set(spec[field], { key: productKey, kind: spec.kind });
      own.add(spec[field]);
    }
  }
  /** What stands for a customer in its refs: never its id itself. */
  const customerKey = (customer) => crypto.createHash('sha256').update(`${PROVIDER}|${customer}`).digest('hex').slice(0, 16);

  /** One subscription at `now`: a refund, or its status and until when; what a later reading can't tell goes into `notes`. */
  function stateOf(entry, hint, now, { ref, noted, notes }) {
    const reversed = hint?.type === 'refund_reversed';
    // The transaction support refunded, as the webhook names it: this period's, or an older one's.
    const named = hint?.type === 'refund' && hint.transaction ? hint.transaction : null;
    const cleared = entry.refundedAt == null ? null : `refund-cleared/${ref}@${entry.refundedAt}`;
    let byDate = entry.refundedAt != null && entry.refundedAt >= entry.purchased && !noted(cleared);
    if (byDate && (reversed || (named !== null && entry.transaction && named !== entry.transaction))) {
      // The store keeps the refund's date after taking it back, or says it for an older period's.
      notes.push(cleared);
      byDate = false;
    }
    if (!reversed && (byDate || (named !== null && named === entry.transaction))) return { refund: true };
    // The store's grace after a failed charge keeps what was paid for.
    const end = Math.max(entry.expires, entry.graceUntil ?? entry.expires);
    const extra = reversed ? { refundReversed: true } : {};
    if (end > now) return { status: entry.trial ? 'trialing' : 'active', periodEnd: iso(end), ending: entry.cancelledAt != null, ...extra };
    const finished = hint?.type === 'ended' && entry.purchased <= (hint.at ?? now);
    if (entry.billingIssueAt != null && entry.billingIssueAt >= entry.purchased && !finished) {
      return { status: 'past_due', periodEnd: iso(entry.expires), ...extra };
    }
    return { status: 'ended', periodEnd: iso(entry.expires), ...extra };
  }

  async function customerEvents(customer, { cause, hints = null, noted = () => false } = {}) {
    let held;
    try {
      held = await api.read(customer, { key });
    } catch {
      throw new HttpError(502, 'billing_provider_unavailable');
    }
    const now = held.at;
    const digest = customerKey(customer);
    const events = [];
    const present = new Set();
    const notes = [];
    const wasNoted = (note) => Boolean(note) && Boolean(noted(note));
    const hintFor = (product) => (isObject(hints) ? hints[product] ?? null : null);
    for (const [storeProduct, entry] of Object.entries(held.subscriptions)) {
      if (!STORES.includes(entry.store) || (entry.sandbox && !sandbox)) continue;
      const ref = `${entry.store}${entry.sandbox ? '-sandbox' : ''}:${storeProduct}:${digest}`;
      present.add(ref);
      const product = byStore[entry.store].get(storeProduct);
      if (product?.kind !== 'subscription') continue;
      const state = stateOf(entry, hintFor(storeProduct), now, { ref, noted: wasNoted, notes });
      const fields = { id: `${cause}/${ref}`, occurredAt: iso(now), customer, ref, product: product.key, sandbox: entry.sandbox };
      events.push(state.refund ? { ...fields, type: 'refund' } : { ...fields, type: 'subscription', ...state });
    }
    for (const [storeProduct, list] of Object.entries(held.purchases)) {
      for (const bought of list) {
        if (!STORES.includes(bought.store) || (bought.sandbox && !sandbox)) continue;
        const ref = `${bought.store}${bought.sandbox ? '-sandbox' : ''}:${storeProduct}:${digest}:${bought.id}`;
        present.add(ref);
        const product = byStore[bought.store].get(storeProduct);
        if (product?.kind !== 'once') continue;
        const fields = { id: `${cause}/${ref}`, customer, ref, product: product.key, sandbox: bought.sandbox };
        // Refunded by support while the store goes on listing it: refunded in every reading after,
        // until the store takes the refund back.
        const hint = hintFor(storeProduct);
        const named = bought.transaction && hint?.transaction === bought.transaction ? hint.type : null;
        const refunded = `refunded/${ref}`;
        const reversed = `refund-reversed/${ref}`;
        if (named === 'refund') {
          notes.push(refunded);
          events.push({ ...fields, type: 'refund', occurredAt: iso(now) });
          continue;
        }
        if (named === 'refund_reversed') {
          if (wasNoted(refunded)) notes.push(reversed);
        } else if (wasNoted(refunded) && !wasNoted(reversed)) {
          events.push({ ...fields, type: 'refund', occurredAt: iso(now) });
          continue;
        }
        events.push({ ...fields, type: 'purchase', occurredAt: iso(bought.purchased) });
      }
    }
    return { at: iso(now), events, present, notes };
  }

  /** Another product's sale: another store, a test purchase when they don't count, a product none of this app's. */
  const foreignOf = (event) => (event.sandbox === true && !sandbox) || (event.store != null && !STORES.includes(event.store))
    || (typeof event.product === 'string' && !own.has(event.product));

  /** What the webhook knows that the customer's state may not say yet, per product. */
  function hintsOf(event, at) {
    if (typeof event.product !== 'string') return {};
    const transaction = typeof event.transaction === 'string' ? event.transaction : null;
    if (event.type === 'refunded') return { [event.product]: { type: 'refund', transaction, at } };
    if (event.type === 'expired') return { [event.product]: { type: 'ended', at } };
    if (event.type === 'refund_reversed') return { [event.product]: { type: 'refund_reversed', transaction, at } };
    return {};
  }

  async function parseWebhook({ headers, body }) {
    if (headers.authorization !== auth) throw unauthorized();
    if (secret && !verifySignature(secret, body, headers['x-store-signature'], { now: clock() })) throw new HttpError(400, 'bad_signature');
    let event;
    try {
      event = JSON.parse(body);
    } catch {
      throw badRequest('invalid_json');
    }
    if (!isObject(event) || typeof event.id !== 'string' || !event.id) throw badRequest('invalid_event');
    if (!TRIGGERS.has(event.type)) return null;
    const at = Number(event.at) || clock();
    // The id goes as the store gave it: stores.js refuses one that could name its rows.
    const notice = { id: event.id, type: event.type, occurredAt: iso(at) };
    if (foreignOf(event)) return { ...notice, foreign: true, customers: [] };
    const customers = [...new Set([event.customer, ...(Array.isArray(event.customers) ? event.customers : [])]
      .filter((id) => typeof id === 'string' && id))];
    return { ...notice, customers, hints: hintsOf(event, at) };
  }

  function manage(ref) {
    const match = /^(app_store|play_store)(-sandbox)?:/.exec(String(ref ?? ''));
    return match ? { via: 'store', store: match[1], sandbox: Boolean(match[2]), url: MANAGE_URLS[match[1]] } : null;
  }

  return { id: PROVIDER, kind: 'store', sandbox, parseWebhook, customerEvents, manage };
}

/**
 * The stand-in as providers.js registers a store provider, reading the store's server `api`:
 * STORE_BILLING=test-store with TEST_STORE_AUTH and TEST_STORE_KEY, and optionally
 * TEST_STORE_SECRET (then the webhook's signature is required too).
 */
export const storeProvider = (api) => ({
  id: PROVIDER,
  name: 'Test Store',
  fromEnv(env, { errors }) {
    const missing = ['TEST_STORE_AUTH', 'TEST_STORE_KEY'].filter((name) => !env[name]);
    if (missing.length) {
      errors.push(`STORE_BILLING=${PROVIDER} needs ${missing.join(' and ')}`);
      return null;
    }
    return { provider: PROVIDER, auth: env.TEST_STORE_AUTH, key: env.TEST_STORE_KEY, secret: env.TEST_STORE_SECRET || null };
  },
  create: (install, { products }) => storeAdapter({ auth: install.auth, secret: install.secret, key: install.key, products, api }),
});
