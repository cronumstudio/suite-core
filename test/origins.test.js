/**
 * Where accounts come from (origins.js): what counts as a link's tag and as a site's domain, how
 * both reach the account made at the end of a sign-in, how an account is said to have been made,
 * and each payment noted with its account's origin: the web's with what was charged, the stores'
 * with their product's listed amount, a refund marking its payment. The whole sign-in over HTTP is
 * in oidc.test.js.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { createAccounts } from '../accounts.js';
import { createOrigins, cleanTag, cleanHost, ENTRIES } from '../origins.js';
import { inRequest } from '../request-scope.js';
import { resolveConfig } from '../config.js';

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-origins-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const clock = { now: Date.parse('2026-11-25T10:00:00Z') };
  const accounts = createAccounts({ database, clock: () => clock.now });
  const lines = [];
  const origins = createOrigins({
    database, baseUrl: 'https://work.example.com', ownHosts: ['https://login.example.com'],
    products: { 'pro-yearly': { plan: 'pro' }, 'pro-monthly': { plan: 'pro' } },
    storeProducts: { 'store-pro-yearly': { plan: 'pro', amount: 35, currency: 'EUR' }, 'store-pro-monthly': { plan: 'pro' } },
    appCookie: 'work_connect', clock: () => clock.now, log: (line) => lines.push(line), ...options,
  });
  accounts.whenCreated(origins.noteCreated);
  accounts.whenRemoved((userId) => origins.forget(userId));
  /** An account made in a request at `at`, with what its sign-in carried. */
  const arrive = (username, { at = '/auth/callback', login = null, referer = null, cookie = null } = {}) => {
    const req = { url: at, method: 'GET', headers: { ...(cookie ? { cookie } : {}) } };
    if (login) {
      const url = new URL(login, 'https://work.example.com');
      origins.arriving(req, origins.pack(origins.fromLogin({ headers: { ...(referer ? { referer } : {}) } }, url)));
    }
    return inRequest(req, () => accounts.create({ username, email: `${username}@example.com` }));
  };
  return { database, accounts, origins, clock, lines, arrive };
}

test('a link’s tag: 1 to 40 of a-z, 0-9, dot, underscore and dash, kept in lower case; anything else is none', () => {
  assert.equal(cleanTag('reddit-mcp'), 'reddit-mcp');
  assert.equal(cleanTag(' ProductHunt '), 'producthunt');
  assert.equal(cleanTag('blog-para_method.v2'), 'blog-para_method.v2');
  assert.equal(cleanTag('a'.repeat(40)), 'a'.repeat(40));
  for (const not of ['', ' ', 'a'.repeat(41), '-reddit', 'red dit', 'reddit/mcp', '<script>', 'réddit', 'a,b', "a'b", null, undefined, 7, ['reddit']]) {
    assert.equal(cleanTag(not), null, String(not));
  }
});

test('a site’s domain: from its address or its name, without www, never its page; this install’s own is no origin', () => {
  assert.equal(cleanHost('https://www.reddit.com/r/mcp/comments/1abc/?utm=x'), 'reddit.com');
  assert.equal(cleanHost('news.ycombinator.com'), 'news.ycombinator.com');
  assert.equal(cleanHost('HTTPS://ChatGPT.com'), 'chatgpt.com');
  assert.equal(cleanHost('android-app://com.reddit.frontpage/'), 'com.reddit.frontpage', 'an app on a phone, by its package');
  assert.equal(cleanHost('https://xn--caf-dma.example/'), 'xn--caf-dma.example');
  for (const not of ['', 'localhost', 'http://127.0.0.1:3000/', 'not a host', 'javascript:alert(1)', 'https://', `${'a'.repeat(90)}.com`, 'a..b', null, 5]) {
    assert.equal(cleanHost(not), null, String(not));
  }
  const own = ['work.example.com', 'example.org'];
  assert.equal(cleanHost('https://work.example.com/tasks/', own), null);
  assert.equal(cleanHost('https://auth.example.org/', own), null, 'and what is under one of them');
  assert.equal(cleanHost('https://example.com/', own), 'example.com', 'the site beside the app is an origin');
});

test('what the sign-in says of where someone comes from: its own address first, then the page it goes back to, then the Referer', (t) => {
  const { origins } = setup(t);
  const read = (login, referer = null) => origins.fromLogin({ headers: { ...(referer ? { referer } : {}) } }, new URL(login, 'https://work.example.com'));
  assert.deepEqual(read('/auth/login?signup=1&src=Reddit-MCP&via=reddit.com'), { src: 'reddit-mcp', via: 'reddit.com' });
  // The kit's sign-in sends the page it was on in `return`: its tag counts.
  assert.deepEqual(read(`/auth/login?return=${encodeURIComponent('/?settings=plan&src=hn')}`), { src: 'hn', via: null });
  assert.deepEqual(read(`/auth/login?src=first&return=${encodeURIComponent('/?src=second')}`).src, 'first');
  // What other sites add to the links they list, when there is no src.
  assert.equal(read('/auth/login?ref=producthunt').src, 'producthunt');
  assert.equal(read('/auth/login?utm_source=newsletter&ref=producthunt').src, 'newsletter');
  assert.equal(read('/auth/login?src=reddit&utm_source=newsletter').src, 'reddit');
  assert.equal(read('/auth/login?src=not%20a%20tag&ref=producthunt').src, 'producthunt', 'one that is no tag gives way');
  // The site before: said in the link, else the request's own Referer; never this install or its sign-in.
  assert.equal(read('/auth/login?signup=1', 'https://www.producthunt.com/posts/cronum-work').via, 'producthunt.com');
  assert.equal(read('/auth/login?via=chatgpt.com', 'https://example.net/').via, 'chatgpt.com');
  assert.equal(read('/auth/login', 'https://work.example.com/tasks/').via, null);
  assert.equal(read('/auth/login?via=login.example.com').via, null);
  assert.deepEqual(read('/auth/login?return=%2F%2Fevil.example%2F%3Fsrc%3Dx'), { src: 'x', via: null }, 'an odd return is only read for its query');
  assert.deepEqual(read('/auth/login'), { src: null, via: null });
});

test('carried with the sign-in and written with the account: the first origin stays, and what was tampered with is nothing', (t) => {
  const { origins, arrive, accounts, database } = setup(t);
  assert.equal(origins.pack({}), '', 'nothing to carry: nothing added to the sign-in');
  assert.match(origins.pack({ src: 'reddit.mcp', via: 'reddit.com' }), /^[A-Za-z0-9_-]+$/, 'one word, whatever dots the tag has');

  const ana = arrive('ana', { login: '/auth/login?signup=1&src=reddit-mcp&via=old.reddit.com' });
  assert.deepEqual({ ...origins.of(ana.id), at: null }, { src: 'reddit-mcp', referrer: 'old.reddit.com', entry: 'web', at: null });
  // Only the site, from the Referer of whoever came straight to the sign-in.
  const bob = arrive('bob', { login: '/auth/login?signup=1', referer: 'https://news.ycombinator.com/item?id=1' });
  assert.deepEqual([origins.of(bob.id).src, origins.of(bob.id).referrer], [null, 'news.ycombinator.com']);
  // Nothing known: a row all the same, with how the account was made.
  const cat = arrive('cat');
  assert.deepEqual({ ...origins.of(cat.id), at: null }, { src: null, referrer: null, entry: 'web', at: null });

  // What comes back from the provider is checked again: a state someone wrote by hand is nothing.
  for (const forged of ['!!!', Buffer.from('{"src":"x"}').toString('base64url'), Buffer.from(JSON.stringify(['<b>', 'not a host'])).toString('base64url')]) {
    const req = { url: '/auth/callback', method: 'GET', headers: {} };
    origins.arriving(req, forged);
    const made = inRequest(req, () => accounts.create({ username: `u${database.get('SELECT COUNT(*) AS n FROM users').n}` }));
    assert.deepEqual([origins.of(made.id).src, origins.of(made.id).referrer], [null, null], forged);
  }

  // Nothing later writes over it.
  database.run('INSERT OR IGNORE INTO account_origins (user_id, src, referrer, entry, at) VALUES (?, ?, ?, ?, ?)', ana.id, 'other', 'x.example', 'web', 'now');
  assert.equal(origins.of(ana.id).src, 'reddit-mcp');
});

test('how an account was made: on the web, from the phone app, by an assistant’s token; never noted for the admin’s or a script’s', (t) => {
  const { origins, arrive, accounts } = setup(t);
  assert.deepEqual(ENTRIES, ['web', 'app', 'mcp', 'other']);
  assert.equal(origins.of(arrive('web').id).entry, 'web');
  assert.equal(origins.of(arrive('local', { at: '/api/auth/signup' }).id).entry, 'web');
  assert.equal(origins.of(arrive('phone', { cookie: 'x=1; work_connect=abc' }).id).entry, 'app');
  assert.equal(origins.of(arrive('agent', { at: '/mcp' }).id).entry, 'mcp');
  assert.equal(origins.of(arrive('module', { at: '/tasks/mcp' }).id).entry, 'mcp');
  assert.equal(origins.of(arrive('odd', { at: '/api/somewhere' }).id).entry, 'other');
  assert.equal(origins.of(arrive('byadmin', { at: '/api/admin/users', login: '/auth/login?src=reddit' }).id), null);
  assert.equal(origins.of(accounts.create({ username: 'script' }).id), null, 'outside a request');
});

test('a payment on the web is noted with what was charged and its account’s origin; a refund marks it; a renewal is not a first', (t) => {
  const { origins, arrive, database } = setup(t);
  const ana = arrive('ana', { login: '/auth/login?src=reddit-mcp&via=reddit.com' });
  const pay = (user, event) => origins.paid({ user, organization: null, event: { type: 'payment', currency: 'EUR', ...event } }, { provider: 'paddle' });
  assert.equal(pay(ana, { ref: 'txn_1', subscription: 'sub_1', product: 'pro-yearly', amount: 1900, first: true, occurredAt: '2026-11-26T09:00:00.000Z' }), true);
  assert.equal(pay(ana, { ref: 'txn_1', subscription: 'sub_1', product: 'pro-yearly', amount: 1900, first: true }), false, 'the same transaction once');
  assert.equal(pay(ana, { ref: 'txn_2', subscription: 'sub_1', product: 'pro-yearly', amount: 3500, first: false, occurredAt: '2027-11-26T09:00:00.000Z' }), true);
  assert.deepEqual(origins.paymentsOf(ana.id).map((p) => [p.product, p.plan, p.amount, p.currency, p.first, p.estimated, p.refunded_at]), [
    ['pro-yearly', 'pro', 3500, 'EUR', false, false, null],
    ['pro-yearly', 'pro', 1900, 'EUR', true, false, null],
  ]);
  assert.deepEqual({ ...database.get("SELECT src, referrer, entry FROM origin_payments WHERE ref = 'txn_1'") },
    { src: 'reddit-mcp', referrer: 'reddit.com', entry: 'web' }, 'the origin as it was when they paid');

  // A group's payment, something that is no payment, or one of nobody: not noted.
  assert.equal(origins.paid({ user: null, organization: { id: 3 }, event: { type: 'payment', ref: 'txn_g', amount: 100 } }, { provider: 'paddle' }), false);
  assert.equal(origins.paid({ user: ana, event: { type: 'subscription', ref: 'sub_1' } }, { provider: 'paddle' }), false);

  // A refund: by its transaction, or for a subscription refunded whole, its last payment.
  assert.equal(origins.refunded({ event: { type: 'refund', ref: 'txn_1', occurredAt: '2026-11-27T09:00:00.000Z' } }, { provider: 'paddle' }), 1);
  assert.equal(origins.refunded({ event: { type: 'refund', ref: 'txn_1' } }, { provider: 'paddle' }), 0, 'once');
  assert.equal(origins.refunded({ event: { type: 'refund', ref: 'sub_1', subscription: true } }, { provider: 'paddle' }), 1);
  assert.equal(origins.refunded({ event: { type: 'refund', ref: 'txn_1' } }, { provider: 'another' }), 0);
  assert.deepEqual(origins.paymentsOf(ana.id).map((p) => Boolean(p.refunded_at)), [true, true]);
});

test('a store’s purchase and each renewal: one per paid period, with the product’s listed amount, marked as an estimate', (t) => {
  const { origins, arrive } = setup(t);
  const ana = arrive('ana', { login: '/auth/login?src=appstore-campaign', cookie: 'work_connect=1' });
  const subject = { type: 'user', id: ana.id };
  const event = (extra) => ({ type: 'subscription', ref: 'app_store:yearly:abc', product: 'store-pro-yearly', status: 'active', ...extra });
  const apply = (outcome, extra, product = { plan: 'pro' }) => origins.applied({ outcome, event: event(extra), subject, product, provider: 'revenuecat' });
  assert.equal(apply('granted', { periodEnd: '2027-11-25T00:00:00Z', occurredAt: '2026-11-25T10:00:00.000Z' }), true);
  assert.equal(apply('changed', { periodEnd: '2027-11-25T00:00:00Z', occurredAt: '2026-11-26T10:00:00.000Z' }), false, 'the same period again (it stopped renewing, say)');
  for (const quiet of ['unchanged', 'duplicate', 'stale', 'kept', 'revoked']) assert.equal(apply(quiet, { periodEnd: '2029-01-01T00:00:00Z' }), false, quiet);
  assert.equal(apply('extended', { periodEnd: '2028-11-25T00:00:00Z', occurredAt: '2027-11-25T10:00:00.000Z' }), true);
  assert.deepEqual(origins.paymentsOf(ana.id).map((p) => [p.provider, p.amount, p.currency, p.first, p.estimated]), [
    ['revenuecat', 3500, 'EUR', false, true],
    ['revenuecat', 3500, 'EUR', true, true],
  ]);
  // A product without a listed amount: the payment counts, with no figure. One the store says: that one.
  origins.applied({ outcome: 'granted', event: event({ ref: 'play_store:monthly:x', product: 'store-pro-monthly', periodEnd: '2026-12-25T00:00:00Z' }), subject, product: { plan: 'pro' }, provider: 'revenuecat' });
  origins.applied({ outcome: 'granted', event: event({ ref: 'play_store:yearly:y', periodEnd: '2027-12-01T00:00:00Z', amount: 29.99, currency: 'USD' }), subject, product: { plan: 'pro' }, provider: 'revenuecat' });
  const [said, bare] = origins.paymentsOf(ana.id).filter((p) => p.product && p.amount !== 3500 || p.amount == null);
  assert.deepEqual([[said.amount, said.currency, said.estimated], [bare.amount, bare.currency, bare.estimated]], [[2999, 'USD', false], [null, null, false]]);
  // A refund marks the last period paid of that subscription; a group's purchase is nobody's.
  apply('refunded', { type: 'refund', occurredAt: '2027-12-01T10:00:00.000Z' });
  assert.equal(origins.paymentsOf(ana.id).filter((p) => p.refunded_at).length, 1);
  assert.equal(origins.applied({ outcome: 'granted', event: event({ ref: 'z' }), subject: { type: 'organization', id: 1 }, provider: 'revenuecat' }), false);
});

test('an account that goes takes its origin with it; its payments stay as figures of nobody', (t) => {
  const { origins, arrive, accounts, database } = setup(t);
  const ana = arrive('ana', { login: '/auth/login?src=reddit-mcp' });
  origins.paid({ user: ana, event: { type: 'payment', ref: 'txn_1', amount: 1900, currency: 'EUR', product: 'pro-yearly', first: true } }, { provider: 'paddle' });
  accounts.remove(ana.id);
  assert.equal(origins.of(ana.id), null);
  assert.deepEqual({ ...database.get('SELECT user_id, src, amount FROM origin_payments') }, { user_id: null, src: 'reddit-mcp', amount: 1900 });
});

test('the configuration: off unless the app says modules.origins; a store product’s amount and currency go together', () => {
  const base = { app: { id: 'demo', name: 'Demo', languages: ['en'] } };
  const env = { DATA_DIR: os.tmpdir(), BASE_URL: 'http://127.0.0.1' };
  assert.equal(resolveConfig(base, env).modules.origins, false);
  assert.equal(resolveConfig({ ...base, modules: { origins: true } }, env).modules.origins, true);
  const stores = (product) => resolveConfig({
    ...base, modules: { billing: true, devices: true }, plans: { free: { name: 'Free' }, pro: { name: 'Pro' } }, defaultPlan: 'free',
    stores: { products: { 'store-pro': { plan: 'pro', kind: 'subscription', appStore: 'com.example.pro', ...product } } },
  }, env).errors.filter((line) => line.includes('store-pro'));
  assert.deepEqual(stores({ amount: 35, currency: 'EUR' }), []);
  assert.deepEqual(stores({}), []);
  assert.match(stores({ amount: 35 })[0], /amount and currency go together/);
  assert.match(stores({ amount: -1, currency: 'EUR' })[0], /a number above 0/);
  assert.match(stores({ amount: 35, currency: 'euro' })[0], /three capital letters/);
});
