/**
 * Store purchases: what people buy inside an app on a phone, in the App Store and Google Play, as
 * grants next to the web's. Off unless an install sets STORE_BILLING (revenuecat.js today) with
 * `modules.billing` on; nothing changes for an app that doesn't.
 *
 * It is a second instance of billing.js, on the same tables under its own provider id: each event
 * is applied once and in order, `ignoreUnknownProducts` and another product's sales work as they do
 * for the web, and the account's plan (`/api/me/entitlements`) is every grant of both. People buy
 * for themselves here; a group buys on the web.
 *
 * Who buys is the opaque id this install gives each account (`customerFor()`, a random UUID kept
 * in `billing_customers`): the app on the phone hands it to the store's SDK. Never the WorkOS id,
 * an email or the account's number. A UUID is also what Apple's StoreKit takes as
 * `appAccountToken` and Google Play as `obfuscatedAccountId`, so the people who bought can stay
 * the same when the adapter changes.
 *
 * A store adapter (RevenueCat's is revenuecat.js; Apple's and Google's own server APIs could take
 * its place):
 *   {
 *     id: 'revenuecat', kind: 'store',
 *     parseWebhook({ headers, body }) → Promise<notice | null>   (throws on a bad signature)
 *       notice: { id, type, occurredAt, customers: [id…], foreign?: true, hints? }
 *     customerEvents(customer, { cause, hints, noted }) → Promise<{ at, events, present: Set<ref>, notes? }>
 *       what the customer has now at the store, as billing.js's events, with ids made from `cause`;
 *       `notes`: facts a later reading can't see at the store again (a refund the store took back),
 *       kept here and asked with `noted(note)`
 *     manage(ref) → { via: 'store', store, sandbox, url } | null
 *   }
 * What an install holds is keyed by the adapter's id (the customers in `billing_customers`, the
 * subscriptions and grants by `provider`/`source`) and by its refs. So an adapter that replaces
 * RevenueCat's either keeps the id `revenuecat` and its refs (`app_store:<product>:<digest>`), or
 * comes with a migration of `billing_customers`, `billing_subscriptions` and the grants'
 * `external_ref`: an adapter under another id would give everyone a new customer, which no longer
 * matches the `appAccountToken` of what they bought.
 *
 * The webhook only says whom to look at again: what they have is always read from the store
 * (customerEvents), and what this install holds for them that the store no longer has (moved to
 * another customer, a refunded one-off purchase) ends. The same reading follows a purchase, when
 * the app asks (`sync()`), so nothing waits for the webhook. A reading is applied as one
 * (billing.js's `reading`): what it says that is already here is 'unchanged' and writes nothing,
 * so reading again and again grows no table.
 *
 * The server can't refuse a store's sale: before it sells in the store, the app reads
 * `GET /api/billing/overview`, where a web subscription that already gives the plan is listed. The
 * other way round, the web's checkout answers 409 `already_subscribed` to a person with a live
 * store subscription (billing.js's `otherProviders`).
 */
import crypto from 'node:crypto';
import { HttpError, badRequest, notFound, unauthorized, sendJson, readBody } from './http.js';
import { createBilling } from './billing.js';

const LIVE = ['active', 'trialing', 'past_due'];
/** What a delivery's id may be: no `:` or `/`, so neither it nor its readings' ids ever name a note's row. */
const DELIVERY_ID = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * @param {object} options
 * @param {object} options.database
 * @param {object} options.entitlements
 * @param {object} [options.provider]   a store adapter; without one, store purchases are off
 * @param {object} [options.products]   stores.products: { key: { plan, kind, appStore?, playStore? } }
 * @param {boolean} [options.ignoreUnknownProducts]   as billing.js's
 * @param {number} [options.syncGapMs]  the least time between two syncs of one account
 */
export function createStoreBilling({
  database, entitlements, provider = null, products = {}, audit = null, clock = () => Date.now(), log = console.log,
  ignoreUnknownProducts = false, syncGapMs = 3000,
}) {
  const billing = createBilling({ database, entitlements, provider, products, audit, clock, log, ignoreUnknownProducts });
  const errors = [...billing.errors];
  if (provider && provider.kind !== 'store') errors.push(`${provider.id} is not a store adapter`);
  for (const [key, spec] of Object.entries(products || {})) {
    if (spec?.for === 'organization') errors.push(`Store product "${key}": people buy in the stores for themselves; a group buys on the web`);
  }
  const enabled = billing.enabled && !errors.length;
  const source = billing.provider;

  const mustBeOn = () => {
    if (!enabled) throw notFound('billing_off');
  };

  /** The account a store customer is, here: only people. */
  const userOf = (customer) => database.get(`SELECT subject_id FROM billing_customers
    WHERE provider = ? AND customer_id = ? AND subject_type = 'user'`, source, String(customer))?.subject_id ?? null;

  /** The opaque id an account buys with: made the first time it is asked for, then always the same. */
  function customerFor(userId) {
    mustBeOn();
    const subject = { type: 'user', id: userId };
    return database.tx(() => {
      const known = billing.customerOf(subject);
      if (known) return known;
      billing.linkCustomer(subject, crypto.randomUUID());
      return billing.customerOf(subject);
    });
  }

  /**
   * What this install holds for an account that the store no longer has for its customer: a
   * subscription that went to another customer ends, a one-off purchase that left (refunded) is
   * refunded. What the adapter still sees, even unpriced, is left to the events. A reading older
   * than what it would take back doesn't: a subscription's end is then stale (billing.js), and a
   * purchase granted after the store answered was bought after it.
   */
  function goneEvents(userId, present, { cause, at, customer }) {
    const gone = [];
    const subscriptions = database.all(`SELECT ref, product FROM billing_subscriptions WHERE provider = ?
      AND subject_type = 'user' AND subject_id = ? AND status IN (${LIVE.map(() => '?').join(', ')})`, source, userId, ...LIVE);
    for (const row of subscriptions) {
      if (present.has(row.ref)) continue;
      gone.push({
        id: `${cause}/${row.ref}`, type: 'subscription', occurredAt: at, customer, ref: row.ref, product: row.product,
        status: 'ended',
      });
    }
    const purchases = database.all(`SELECT DISTINCT external_ref AS ref FROM entitlement_grants WHERE source = ?
      AND subject_type = 'user' AND subject_id = ? AND revoked_at IS NULL AND external_ref IS NOT NULL AND created_at <= ?
      AND external_ref NOT IN (SELECT ref FROM billing_subscriptions WHERE provider = ?)`, source, userId, at, source);
    for (const row of purchases) {
      if (!present.has(row.ref)) gone.push({ id: `${cause}/${row.ref}`, type: 'refund', occurredAt: at, ref: row.ref });
    }
    return gone;
  }

  /**
   * What the adapter noted (`notes`), kept as rows of `billing_events` of their own (`note:…`,
   * type and outcome `note`): no table or migration more, and only ids and refs, never a customer.
   * No delivery can write one: a delivery's id holds no `:` or `/` (DELIVERY_ID), so neither its
   * row nor its readings' (`<id>/<ref>`) start with `note:`, and only a row of type `note` counts.
   */
  const NOTE = /^[\w.:@/-]{1,400}$/;
  const noted = (note) => typeof note === 'string' && NOTE.test(note)
    && Boolean(database.get(`SELECT 1 FROM billing_events WHERE provider = ? AND event_id = ? AND type = 'note'`,
      source, `note:${note}`));
  const keepNote = (note) => {
    if (typeof note !== 'string' || !NOTE.test(note)) return;
    database.run(`INSERT OR IGNORE INTO billing_events (provider, event_id, type, outcome, received_at)
      VALUES (?, ?, 'note', 'note', ?)`, source, `note:${note}`, new Date(clock()).toISOString());
  };

  /** One customer read again from the store and applied: what it has, and what it no longer has. */
  async function reconcile(customer, { cause, hints = null }) {
    if (!userOf(customer)) return [];
    const { at, events, present, notes = [] } = await provider.customerEvents(customer, { cause, hints, noted });
    // At once, after the store answered: what was read and what is gone, against the same state.
    return database.tx(() => {
      const userId = userOf(customer);
      if (!userId) return [];
      for (const note of Array.isArray(notes) ? notes : []) keepNote(note);
      return [...events, ...goneEvents(userId, present, { cause, at, customer })]
        .map((event) => billing.apply(event, { reading: true }));
    });
  }

  /**
   * The store's webhook: checked by the adapter, then each of this install's customers it names
   * read again. Another product's, or nobody's here, keeps only its id, type and outcome, and
   * nothing is asked of the store. A failure answers an error, so the store sends it again; what
   * was already applied is then a duplicate.
   */
  async function handleWebhook(req, res) {
    mustBeOn();
    const body = (await readBody(req, { limit: 512 * 1024 })).toString('utf8');
    const notice = await provider.parseWebhook({ headers: req.headers, body });
    if (!notice) {
      sendJson(res, 200, { received: 0, outcomes: [] });
      return;
    }
    // Its id names rows here: never one of the notes' (`note:…`), whatever the adapter.
    if (typeof notice.id !== 'string' || !DELIVERY_ID.test(notice.id)) throw badRequest('invalid_event');
    const known = notice.foreign ? [] : notice.customers.filter((customer) => userOf(customer));
    let outcomes = [];
    if (!known.length) {
      // This app's product for a customer it never gave out is nobody's here ('ignored'), not another product's.
      outcomes = [billing.apply({
        id: notice.id, type: 'subscription', ref: notice.id, occurredAt: notice.occurredAt,
        ...(notice.foreign ? { foreign: true } : { own: true }),
      })];
    } else {
      for (const customer of known) outcomes.push(...await reconcile(customer, { cause: notice.id, hints: notice.hints }));
    }
    sendJson(res, 200, { received: outcomes.length, outcomes });
  }

  // One sync at a time per account, and not again within syncGapMs: each one asks the store.
  const running = new Map();
  const lastSync = new Map();

  /** After a purchase or a restore in the app: the account's customer read again from the store. */
  async function sync(userId) {
    mustBeOn();
    if (running.has(userId)) return running.get(userId);
    const since = clock() - (lastSync.get(userId) ?? -Infinity);
    if (since < syncGapMs) throw new HttpError(429, 'too_many_attempts', { retry_after: Math.ceil((syncGapMs - since) / 1000) });
    const customer = billing.customerOf({ type: 'user', id: userId });
    // Nobody bought anything with this account yet: nothing to read, and the store isn't asked.
    if (!customer) return { received: 0, outcomes: [] };
    lastSync.set(userId, clock());
    const work = reconcile(customer, { cause: `sync-${crypto.randomUUID()}` })
      .then((outcomes) => ({ received: outcomes.length, outcomes }))
      .finally(() => running.delete(userId));
    running.set(userId, work);
    if (lastSync.size > 10000) lastSync.clear();
    return work;
  }

  return {
    enabled, errors, provider: source, kind: 'store', customerFor, sync, handleWebhook, apply: billing.apply,
    offer: billing.offer, customerOf: billing.customerOf, subscriptionsOf: billing.subscriptionsOf, forget: billing.forget,
    stopRenewals: billing.stopRenewals, keepRenewals: billing.keepRenewals, endSubscriptions: billing.endSubscriptions,
    manage: (ref) => provider?.manage?.(ref) ?? null,
  };
}

/**
 * The stores' routes: the adapter's webhook (`/api/billing/<adapter id>/webhook`, no cookie: what
 * the adapter checks is what counts), and for the phone's app the account's customer and a sync
 * after a purchase. `principal(ctx)`: who asks (the session's account, or with `stores.devices` the
 * phone's device token).
 */
export function registerStoreApi(router, { stores, principal = (ctx) => ctx.user }) {
  if (!stores?.enabled) return;
  const who = (ctx) => {
    const user = principal(ctx);
    if (!user) throw unauthorized();
    return user;
  };
  router.post(`/api/billing/${stores.provider}/webhook`, (ctx) => stores.handleWebhook(ctx.req, ctx.res));
  router.get('/api/billing/stores/customer', (ctx) => {
    const user = who(ctx);
    sendJson(ctx.res, 200, { provider: stores.provider, customer: stores.customerFor(user.id) });
  });
  router.post('/api/billing/stores/sync', async (ctx) => {
    const user = who(ctx);
    sendJson(ctx.res, 200, await stores.sync(user.id));
  });
}
