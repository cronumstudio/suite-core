/**
 * A stand-in for RevenueCat for the tests (revenuecat.test.js, stores.test.js): its v1 API with
 * customers as it holds them, its webhooks as it delivers them, and secrets made at run time, so
 * nothing here looks like a real one.
 */
import crypto from 'node:crypto';
import { signPayload } from '../billing.js';

const iso = (ms) => new Date(ms).toISOString();

export const AUTH = `Bearer ${crypto.randomBytes(16).toString('hex')}`;
export const SIGNING = crypto.randomBytes(24).toString('hex');
export const API_KEY = ['sk', crypto.randomBytes(12).toString('hex')].join('_');

/** What a test app sells in the stores: two subscriptions (both stores) and a one-off purchase. */
export const PRODUCTS = Object.freeze({
  'pro-monthly': { plan: 'pro', kind: 'subscription', appStore: 'com.example.app.pro.monthly', playStore: 'app_pro:monthly' },
  'pro-yearly': { plan: 'pro', kind: 'subscription', appStore: 'com.example.app.pro.yearly', playStore: 'app_pro:yearly' },
  'pro-lifetime': { plan: 'pro', kind: 'once', appStore: 'com.example.app.pro.lifetime' },
});
export const MONTHLY = PRODUCTS['pro-monthly'].appStore;
export const YEARLY = PRODUCTS['pro-yearly'].appStore;
export const LIFETIME = PRODUCTS['pro-lifetime'].appStore;

/**
 * RevenueCat's API: customers as it holds them, and every call. GET makes a customer it doesn't
 * know, as RevenueCat's does. `fail(status | 'network')` makes the next call fail.
 */
export function fakeRevenueCat(clock) {
  const customers = new Map();
  const calls = [];
  let failure = null;
  const customer = (id) => {
    if (!customers.has(id)) customers.set(id, { subscriptions: {}, non_subscriptions: {} });
    return customers.get(id);
  };
  const answer = (pathname) => {
    if (failure) {
      const now = failure;
      failure = null;
      if (now === 'network') throw new TypeError('fetch failed');
      return { status: now, body: { code: 7225, message: `No luck for ${pathname}` } };
    }
    const id = decodeURIComponent(pathname.replace(/^\/v1\/subscribers\//, ''));
    const held = customer(id);
    return {
      status: 200,
      body: {
        request_date: iso(clock.now), request_date_ms: clock.now,
        subscriber: {
          original_app_user_id: id, entitlements: {}, management_url: null,
          subscriptions: structuredClone(held.subscriptions), non_subscriptions: structuredClone(held.non_subscriptions),
        },
      },
    };
  };
  const fetch = async (url, init) => {
    const { pathname } = new URL(url);
    calls.push({ url, pathname, method: init.method, headers: init.headers });
    const { status, body } = answer(pathname);
    return { ok: status === 200, status, json: async () => body };
  };
  return { customers, calls, fetch, answer, customer, fail: (how) => { failure = how; } };
}

/** A subscription as RevenueCat's v1 API shows it. */
export const subscription = ({ purchased, expires, store = 'app_store', sandbox = false, ...rest }) => ({
  store, purchase_date: iso(purchased), original_purchase_date: iso(purchased), expires_date: iso(expires), is_sandbox: sandbox,
  period_type: 'normal', ownership_type: 'PURCHASED', unsubscribe_detected_at: null, billing_issues_detected_at: null,
  grace_period_expires_date: null, refunded_at: null, auto_resume_date: null, store_transaction_id: '2000000000000001', ...rest,
});

/** A webhook as RevenueCat delivers it, `{ api_version, event }`, with its Authorization header. */
export function webhook(event, { auth = AUTH, secret = null, at = Date.now() } = {}) {
  const body = JSON.stringify({
    api_version: '1.0',
    event: { id: crypto.randomUUID(), event_timestamp_ms: at, environment: 'PRODUCTION', store: 'APP_STORE', ...event },
  });
  return { body, headers: { authorization: auth, ...(secret ? { 'x-revenuecat-webhook-signature': signPayload(secret, body, at) } : {}) } };
}
