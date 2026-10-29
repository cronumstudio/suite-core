/**
 * Payment providers the suite knows only by what is registered (providers.js): one that lives
 * outside this repository, as the hosted suite's do, is named by BILLING_PROVIDER or
 * STORE_BILLING like the ones of this copy, reads its own variables and settings, and is the
 * one the app charges through.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../config.js';
import { createSuite } from '../app.js';
import { signedProvider } from '../billing.js';
import {
  registerBillingProvider, registerStoreProvider, billingProviderOf, billingProviders, storeProviderOf,
} from '../providers.js';

// Each test file runs in a process of its own: what is registered here stays here.
const created = [];
const acme = registerBillingProvider({
  id: 'acme',
  name: 'Acme Pay',
  fromEnv(env, { errors }) {
    if (!env.ACME_SECRET) {
      errors.push('BILLING_PROVIDER=acme needs ACME_SECRET');
      return null;
    }
    return { provider: 'acme', secret: env.ACME_SECRET, environment: env.ACME_ENV || 'production' };
  },
  create(install, options) {
    created.push({ install, ...options });
    return signedProvider({ id: 'acme', secret: install.secret });
  },
  environment: (install) => install.environment,
  priceId: { pattern: /^acp_\d+$/, name: 'an Acme price id (acp_…)' },
  honors: ['app'],
  rules: {
    keys: ['acmeAccounts'],
    read(given, install, errors) {
      if (given.acmeAccounts == null) return {};
      if (!Array.isArray(given.acmeAccounts)) {
        errors.push('billing.acmeAccounts: a list');
        return {};
      }
      return { acmeAccounts: [...given.acmeAccounts] };
    },
  },
});

const product = (extra = {}) => ({
  app: { id: 'demo', name: 'Demo', languages: ['en'] }, modules: { billing: true },
  plans: { free: { name: 'Free', features: {} }, pro: { name: 'Pro', features: {} } },
  products: { 'pro-yearly': { plan: 'pro', kind: 'subscription', price: { sandbox: 'acp_1', production: 'acp_2' } } },
  ...extra,
});
const env = (extra) => ({ DATA_DIR: os.tmpdir(), BILLING_PROVIDER: 'acme', ACME_SECRET: 'a-secret-of-sixteen-chars', ...extra });

test('a provider registered from outside is named like the built-in ones and reads its own variables', () => {
  assert.equal(billingProviderOf('acme'), acme);
  assert.deepEqual(billingProviders().map((p) => p.id), ['stripe', 'remote', 'acme']);
  const ok = resolveConfig(product(), env({ ACME_ENV: 'sandbox' }));
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.install.billing, { provider: 'acme', secret: 'a-secret-of-sixteen-chars', environment: 'sandbox' });
  // Its environment chooses the side of a price given per environment.
  assert.equal(ok.products['pro-yearly'].price, 'acp_1');
  assert.equal(resolveConfig(product(), env({})).products['pro-yearly'].price, 'acp_2');
  // What its variables lack is its own words.
  assert.ok(resolveConfig(product(), env({ ACME_SECRET: '' })).errors.includes('BILLING_PROVIDER=acme needs ACME_SECRET'));
  // A name nobody registered lists the ones there are.
  assert.ok(resolveConfig(product(), env({ BILLING_PROVIDER: 'paypal' })).errors
    .some((e) => e === 'BILLING_PROVIDER "paypal": use stripe, remote or acme'));
});

test('its price ids are checked at the start, and so are the old ones', () => {
  const bad = resolveConfig(product({
    products: { 'pro-yearly': { plan: 'pro', kind: 'subscription', price: 'pri_01', oldPrices: ['acp_7', 'nope'] } },
  }), env({}));
  assert.ok(bad.errors.includes('products.pro-yearly.price: "pri_01" is not an Acme price id (acp_…)'));
  assert.ok(bad.errors.includes('products.pro-yearly.oldPrices: "nope" is not an Acme price id (acp_…)'));
  assert.ok(!bad.errors.some((e) => /acp_7/.test(e)));
  // Off, nobody's price ids are checked: a self-hosted copy with the hosted suite's catalog starts.
  const off = resolveConfig(product({ products: { 'pro-yearly': { plan: 'pro', kind: 'subscription', price: 'anything' } } }),
    { DATA_DIR: os.tmpdir() });
  assert.deepEqual(off.errors, []);
});

test('its own settings in suite.config.js billing are read by it; another provider\'s are said to do nothing', () => {
  const read = resolveConfig(product({ billing: { acmeAccounts: ['north'], app: 'work' } }), env({}));
  assert.deepEqual(read.errors, []);
  assert.deepEqual(read.billing.acmeAccounts, ['north']);
  assert.equal(read.billing.app, 'work');
  // Acme honors `app`: nothing to warn about.
  assert.ok(!read.warnings.some((w) => /billing\.app/.test(w)), read.warnings.join('\n'));
  assert.ok(resolveConfig(product({ billing: { acmeAccounts: 'north' } }), env({})).errors.includes('billing.acmeAccounts: a list'));
  // A setting no provider registered is still a typo.
  assert.ok(resolveConfig(product({ billing: { acmeAcounts: [] } }), env({})).errors.includes('billing.acmeAcounts is not a setting (a typo?)'));
  // With Stripe, Acme's settings are Acme's.
  const stripe = resolveConfig(product({ billing: { acmeAccounts: ['north'] }, products: {} }),
    env({ BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: 'whsec_1' }));
  assert.ok(stripe.warnings.includes("billing.acmeAccounts is Acme Pay's: with BILLING_PROVIDER=stripe it does nothing"), stripe.warnings.join('\n'));
  // Without billing on, its settings are only checked: nothing to warn about.
  assert.deepEqual(resolveConfig(product({ billing: { acmeAccounts: ['north'] } }), { DATA_DIR: os.tmpdir() }).warnings
    .filter((w) => /acmeAccounts/.test(w)), []);
});

test('the suite charges through it: created with the install, the products of its environment and the rules', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-providers-'));
  created.length = 0;
  const suite = createSuite({
    config: product({ billing: { acmeAccounts: ['north'], ignoreUnknownProducts: true } }),
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1', BILLING_PROVIDER: 'acme',
      ACME_SECRET: 'a-secret-of-sixteen-chars', ACME_ENV: 'sandbox' },
    log: () => {}, exitOnError: false,
  });
  t.after(() => { suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].install, { provider: 'acme', secret: 'a-secret-of-sixteen-chars', environment: 'sandbox' });
  assert.equal(created[0].products['pro-yearly'].price, 'acp_1');
  assert.deepEqual(created[0].rules.acmeAccounts, ['north']);
  assert.equal(created[0].rules.ignoreUnknownProducts, true);
  assert.equal(suite.billing.enabled, true);
  assert.equal(suite.billing.provider, 'acme');
});

test('a store provider registered from outside is named by STORE_BILLING', () => {
  const store = registerStoreProvider({
    id: 'acme-store',
    fromEnv: (variables, { errors }) => (variables.ACME_STORE_KEY ? { provider: 'acme-store', key: variables.ACME_STORE_KEY }
      : (errors.push('STORE_BILLING=acme-store needs ACME_STORE_KEY'), null)),
    create: () => ({ id: 'acme-store', kind: 'store' }),
  });
  assert.equal(storeProviderOf('acme-store'), store);
  const stores = { products: { 'pro-ios': { plan: 'pro', kind: 'subscription', appStore: 'pro.yearly' } } };
  const base = { DATA_DIR: os.tmpdir(), STORE_BILLING: 'acme-store' };
  const ok = resolveConfig(product({ stores }), { ...base, ACME_STORE_KEY: 'k' });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.install.stores, { provider: 'acme-store', key: 'k' });
  assert.ok(resolveConfig(product({ stores }), base).errors.includes('STORE_BILLING=acme-store needs ACME_STORE_KEY'));
  assert.ok(resolveConfig(product({ stores }), { ...base, STORE_BILLING: 'apple' }).errors
    .includes('STORE_BILLING "apple": use acme-store'));
  // Selling nothing in the stores is still the suite's to say.
  assert.ok(resolveConfig(product(), { ...base, ACME_STORE_KEY: 'k' }).errors
    .includes('STORE_BILLING is set, but suite.config.js stores.products sells nothing'));
});

test('a definition without an id, fromEnv or create is refused when it is registered', () => {
  assert.throws(() => registerBillingProvider({ id: 'Bad Id', fromEnv() {}, create() {} }), /an id of lowercase letters/);
  assert.throws(() => registerBillingProvider({ id: 'nofrom', create() {} }), /fromEnv\(\) is missing/);
  assert.throws(() => registerStoreProvider({ id: 'nocreate', fromEnv() {} }), /create\(\) is missing/);
});

test('a provider may keep an app\'s ids itself: its catalog fills in the prices and its settings', () => {
  registerBillingProvider({
    id: 'kept',
    name: 'Kept Pay',
    fromEnv: () => ({ provider: 'kept' }),
    create: () => signedProvider({ id: 'kept', secret: 'a-secret-of-sixteen-chars' }),
    priceId: { pattern: /^kp_\d+$/, name: 'a Kept price id (kp_…)' },
    rules: { keys: ['keptAccount'], read: (given) => (given.keptAccount ? { keptAccount: given.keptAccount } : {}) },
    catalog: (appId) => (appId !== 'demo' ? null : {
      products: { 'pro-yearly': { price: 'kp_1', oldPrices: ['kp_0'] } },
      billing: { keptAccount: 'north' },
    }),
  });
  const bare = { 'pro-yearly': { plan: 'pro', kind: 'subscription' } };
  const kept = { DATA_DIR: os.tmpdir(), BILLING_PROVIDER: 'kept' };
  const ok = resolveConfig(product({ products: bare }), kept);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.products['pro-yearly'].price, 'kp_1');
  assert.deepEqual(ok.products['pro-yearly'].oldPrices, ['kp_0']);
  assert.equal(ok.billing.keptAccount, 'north');
  // Its ids are checked like the app's own would be.
  assert.equal(resolveConfig(product({ products: bare }), { ...kept, BILLING_PROVIDER: 'acme', ACME_SECRET: 'a-secret-of-sixteen-chars' })
    .products['pro-yearly'].price, undefined, 'another provider keeps nothing of it');
  assert.equal(resolveConfig(product({ products: bare, app: { id: 'other', name: 'Other', languages: ['en'] } }), kept)
    .products['pro-yearly'].price, undefined, 'another app gets nothing');
  // Said twice, or for a product the app doesn't have: an error, never a silent choice.
  assert.ok(resolveConfig(product({ products: { 'pro-yearly': { ...bare['pro-yearly'], price: 'kp_9' } } }), kept).errors
    .includes('products.pro-yearly.price: given both here and by Kept Pay'));
  assert.ok(resolveConfig(product({ products: bare, billing: { keptAccount: 'south' } }), kept).errors
    .includes('billing.keptAccount: given both here and by Kept Pay'));
  assert.ok(resolveConfig(product({ products: {} }), kept).errors
    .includes('Kept Pay sells "pro-yearly", which suite.config.js products doesn\'t have'));
});
