/**
 * A stand-in web billing provider for the tests (managed-organizations.test.js): the adapter
 * billing.js describes, on a small API of its own that a test answers (its own `fetch`, or a local
 * server), and its registration as providers.js takes it (BILLING_PROVIDER=fakepay). Its webhooks
 * are the suite's own events signed with a shared secret (signedProvider), and its secret is made
 * at run time, so nothing here looks like a real one.
 *
 * Its API, all it is asked:
 *   POST  /subscriptions/:ref/cancel  { at: 'period_end' | 'now' }   refused with a 4xx or 5xx
 *   PATCH /subscriptions/:ref         { scheduled: null }             a scheduled cancellation taken back
 *   GET   /subscriptions/:ref         → { data: { id, status, scheduled: 'cancel' | 'pause' | null } }
 */
import crypto from 'node:crypto';
import { HttpError } from '../http.js';
import { signedProvider, signPayload } from '../billing.js';

export const ID = 'fakepay';
export const SECRET = crypto.randomBytes(24).toString('hex');

/**
 * The adapter. A cancellation it refuses may be so already (the payer cancelled in the portal, or an
 * answer was lost): it is read, and counts (`already`) when it is, as Stripe's and others' do.
 */
export function fakeProvider({ secret = SECRET, apiBase, fetch = globalThis.fetch, log = () => {} }) {
  if (!apiBase) throw new Error('fakeProvider: the address of its API is needed');
  const base = String(apiBase).replace(/\/+$/, '');

  async function call(method, path, body = undefined) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      log(`[billing] ${ID} ${method} ${path}: ${err.message}`);
      throw new HttpError(502, 'billing_provider_error');
    }
    const answer = await res.json().catch(() => null);
    if (!res.ok) {
      log(`[billing] ${ID} ${method} ${path}: ${res.status} ${answer?.error?.code || ''}`.trim());
      throw new HttpError(502, 'billing_provider_error');
    }
    return answer?.data ?? null;
  }

  async function cancelSubscription(ref, { now = false } = {}) {
    const path = `/subscriptions/${encodeURIComponent(ref)}`;
    try {
      await call('POST', `${path}/cancel`, { at: now ? 'now' : 'period_end' });
      return { already: false };
    } catch (err) {
      const subscription = await call('GET', path).catch(() => null);
      const done = subscription?.status === 'canceled' || (!now && subscription?.scheduled === 'cancel');
      if (!done) throw err;
      return { already: true };
    }
  }

  async function keepSubscription(ref) {
    await call('PATCH', `/subscriptions/${encodeURIComponent(ref)}`, { scheduled: null });
  }

  return { ...signedProvider({ id: ID, secret }), cancelSubscription, keepSubscription };
}

/** A webhook delivery of the suite's own events, signed as signedProvider reads it. */
export function delivery(events, secret = SECRET) {
  const body = JSON.stringify(events);
  return { body, headers: { 'Content-Type': 'application/json', 'X-Suite-Signature': signPayload(secret, body) } };
}

/** BILLING_PROVIDER=fakepay, for registerBillingProvider: FAKEPAY_SECRET and FAKEPAY_API_BASE. */
export const fakeBilling = Object.freeze({
  id: ID,
  name: 'Fake Pay',
  fromEnv(env, { errors }) {
    if (!env.FAKEPAY_SECRET || env.FAKEPAY_SECRET.length < 16) errors.push('BILLING_PROVIDER=fakepay needs FAKEPAY_SECRET (16 characters or more)');
    else if (!env.FAKEPAY_API_BASE) errors.push('BILLING_PROVIDER=fakepay needs FAKEPAY_API_BASE');
    else return { provider: ID, secret: env.FAKEPAY_SECRET, apiBase: env.FAKEPAY_API_BASE };
    return null;
  },
  create: (install, { log }) => fakeProvider({ secret: install.secret, apiBase: install.apiBase, log }),
});
