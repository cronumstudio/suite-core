/**
 * The admin deleting an account that pays (api.js, account-deletion.js): what the person pays for
 * themselves on the web ends first, at the provider, and a provider that fails keeps the account
 * as it was; a store's subscription goes on, which the panel is told before; a group's stays with
 * the group. Over real HTTP, with the stand-ins of a web provider (fake-provider.js) and of a store
 * (fake-store.js).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSuite, createApp } from '../app.js';
import { registerBillingProvider, registerStoreProvider } from '../providers.js';
import { fakeServer } from '../tools/test-kit.mjs';
import { SECRET, fakeBilling } from './fake-provider.js';
import { PROVIDER, AUTH, KEY, PRODUCTS as STORE_PRODUCTS, fakeStore, storeProvider } from './fake-store.js';

// BILLING_PROVIDER=fakepay and STORE_BILLING=test-store for createSuite. Each test file runs in a
// process of its own: what is registered here stays here.
registerBillingProvider(fakeBilling);
registerStoreProvider(storeProvider(fakeStore({ get now() { return Date.now(); } })));

const DAY = 24 * 3600 * 1000;
const PLANS = { free: { name: 'Free', features: {} }, pro: { name: 'Pro', features: {} } };
const PRODUCTS = {
  'pro-web-yearly': { plan: 'pro', kind: 'subscription' },
  'team-web-yearly': { plan: 'pro', kind: 'subscription', for: 'organization' },
};

/** An install that sells on the web and in the stores, its provider's API, and the admin's browser. */
async function serve(t, { endSubscriptions = true } = {}) {
  // The provider's API (fake-provider.js): what it was asked, whether it answers, and what was
  // still here each time it was asked to cancel.
  const provider = { down: false, asked: [], whenCancelled: () => {} };
  const api = await fakeServer((req, res, { url, body, json }) => {
    provider.asked.push(`${req.method} ${url.pathname}${body ? ` ${body}` : ''}`);
    if (provider.down) return json(503, { error: { code: 'unavailable' } });
    if (req.method === 'POST' && url.pathname.endsWith('/cancel')) provider.whenCancelled();
    return json(200, { data: { id: url.pathname.split('/')[2], status: 'active', scheduled: null } });
  });
  t.after(() => api.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-admin-deletion-'));
  const suite = createSuite({
    config: {
      app: { id: 'demo', name: 'Demo', port: 3999, languages: ['en'] },
      modules: { billing: true, organizations: true }, plans: PLANS, products: PRODUCTS,
      stores: { products: STORE_PRODUCTS }, accounts: { minPasswordLength: 8, endSubscriptions },
    },
    env: {
      DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1',
      BILLING_PROVIDER: 'fakepay', FAKEPAY_SECRET: SECRET, FAKEPAY_API_BASE: api.url,
      STORE_BILLING: PROVIDER, TEST_STORE_AUTH: AUTH, TEST_STORE_KEY: KEY,
    },
    log: () => {}, exitOnError: false,
  });
  const app = createApp({ suite, version: '1.0.0', handleSignals: false, log: () => {} });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  /** A browser: its own cookie. */
  const browser = () => {
    let cookie = '';
    return async (method, pathname, body) => {
      const res = await fetch(base + pathname, {
        method, redirect: 'manual',
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('demo_sid='));
      if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    };
  };
  const admin = browser();
  assert.equal((await admin('POST', '/api/auth/login', { username: 'admin', password: 'root-password' })).status, 200);
  return { suite, provider, admin, browser };
}

/** A live subscription of the person's own, on the web or in the store, or of a group. */
const subscribe = (instance, subject, { ref, product, days = 365 }) => instance.apply({
  id: `evt_${ref}`, type: 'subscription', ref, subject, customer: `cus_${ref}`, product, status: 'active',
  periodEnd: new Date(Date.now() + days * DAY).toISOString(),
});

/** Ada pays Pro on the web and in Google Play, and owns a group that pays its own. */
function adaPays(suite) {
  const ada = suite.accounts.create({ username: 'ada', displayName: 'Ada', email: 'ada@example.com', password: 'ada-password' });
  subscribe(suite.billing, { type: 'user', id: ada.id }, { ref: 'sub_ada', product: 'pro-web-yearly' });
  subscribe(suite.stores, { type: 'user', id: ada.id }, { ref: 'play_store:pro-monthly:ada', product: 'pro-monthly', days: 30 });
  const team = suite.organizations.create({ name: 'Team', ownerId: ada.id });
  subscribe(suite.billing, { type: 'organization', id: team.id }, { ref: 'sub_team', product: 'team-web-yearly' });
  return ada;
}

test('before the question, what someone pays for themselves and what deleting the account does to each; not a group’s', async (t) => {
  const { suite, admin, browser } = await serve(t);
  const ada = adaPays(suite);
  const listed = await admin('GET', `/api/admin/users/${ada.id}/subscriptions`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.subscriptions.map((s) => [s.kind, s.product, s.store ?? null, s.plan_name, s.ends]), [
    ['web', 'pro-web-yearly', null, 'Pro', true],
    ['store', 'pro-monthly', 'play_store', 'Pro', false],
  ]);
  assert.equal(JSON.stringify(listed.data).includes('sub_ada'), false, 'never a ref');
  assert.equal((await admin('GET', '/api/admin/users/999/subscriptions')).status, 404);
  const ana = browser();
  suite.accounts.create({ username: 'ana', displayName: 'Ana', password: 'ana-password' });
  await ana('POST', '/api/auth/login', { username: 'ana', password: 'ana-password' });
  assert.equal((await ana('GET', `/api/admin/users/${ada.id}/subscriptions`)).status, 403, 'the admin’s only');
});

test('the admin deleting someone who pays: their own subscription ends first, at the provider, or nothing goes; a group’s stays', async (t) => {
  const { suite, provider, admin } = await serve(t);
  const ada = adaPays(suite);

  // The provider not answering: nothing goes, to try again; once gone, the renewal would be nobody's.
  provider.down = true;
  const refused = await admin('DELETE', `/api/admin/users/${ada.id}`);
  assert.deepEqual([refused.status, refused.data.error], [503, 'subscription_not_ended']);
  assert.ok(suite.accounts.byId(ada.id), 'the account is as it was');
  assert.equal(suite.database.get("SELECT status FROM billing_subscriptions WHERE ref = 'sub_ada'").status, 'active');
  assert.equal(suite.audit.list({ action: 'admin.user.remove' }).length, 0);

  // Answering: cancelled now, while the account is still here; the group's is never asked.
  provider.down = false;
  provider.asked.length = 0;
  const present = [];
  provider.whenCancelled = () => present.push(Boolean(suite.accounts.byId(ada.id)));
  const done = await admin('DELETE', `/api/admin/users/${ada.id}`);
  assert.deepEqual([done.status, done.data], [200, { ok: true }]);
  assert.deepEqual(provider.asked, ['POST /subscriptions/sub_ada/cancel {"at":"now"}'], 'hers, now; not the group’s');
  assert.deepEqual(present, [true], 'before the account went');
  assert.equal(suite.accounts.byId(ada.id), null);
  const [entry] = suite.audit.list({ action: 'admin.user.remove' });
  assert.deepEqual([entry.target_id, entry.meta], [String(ada.id), { subscriptions_ended: 1, store_subscriptions: 1 }],
    'what was ended, and the store’s that goes on');
  assert.equal(suite.database.get("SELECT COUNT(*) AS n FROM billing_subscriptions WHERE ref = 'sub_team' AND status = 'active'").n, 1,
    'the group keeps its own');
});

test('an install that doesn’t end subscriptions with the account: the admin is told, and the provider isn’t asked', async (t) => {
  const { suite, provider, admin } = await serve(t, { endSubscriptions: false });
  const bea = suite.accounts.create({ username: 'bea', displayName: 'Bea', password: 'bea-password' });
  subscribe(suite.billing, { type: 'user', id: bea.id }, { ref: 'sub_bea', product: 'pro-web-yearly' });
  assert.deepEqual((await admin('GET', `/api/admin/users/${bea.id}/subscriptions`)).data.subscriptions.map((s) => [s.kind, s.ends]),
    [['web', false]]);
  assert.equal((await admin('DELETE', `/api/admin/users/${bea.id}`)).status, 200);
  assert.deepEqual(provider.asked, [], 'as before');
  assert.deepEqual(suite.audit.list({ action: 'admin.user.remove' })[0].meta, {});
});

test('nobody paying, and nothing sold: the deletion is as it was', async (t) => {
  const { suite, provider, admin } = await serve(t);
  const cai = suite.accounts.create({ username: 'cai', displayName: 'Cai', password: 'cai-password' });
  assert.deepEqual((await admin('GET', `/api/admin/users/${cai.id}/subscriptions`)).data, { subscriptions: [] });
  assert.equal((await admin('DELETE', `/api/admin/users/${cai.id}`)).status, 200);
  assert.deepEqual(provider.asked, []);
  assert.equal(suite.accounts.byId(cai.id), null);

  // Without billing nor the stores there is nothing to list.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-admin-deletion-off-'));
  const plain = createSuite({
    config: { app: { id: 'demo', name: 'Demo', port: 3999, languages: ['en'] }, accounts: { minPasswordLength: 8 } },
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1' },
    log: () => {}, exitOnError: false,
  });
  const app = createApp({ suite: plain, version: '1.0.0', handleSignals: false, log: () => {} });
  const server = await app.listen();
  t.after(async () => { await app.close(); plain.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'root-password' }),
  });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('demo_sid=')).split(';')[0];
  assert.equal((await fetch(`${base}/api/admin/users/1/subscriptions`, { headers: { Cookie: cookie } })).status, 404);
});
