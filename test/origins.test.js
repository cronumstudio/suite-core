/**
 * Where accounts come from (origins.js): what counts as a link's tag and as a site's domain, how
 * both reach the account made at the end of a sign-in, how an account is said to have been made,
 * and each payment noted with its account's origin: the web's with what was charged, the stores'
 * with their product's listed amount, a refund marking its payment. The whole sign-in over HTTP is
 * in oidc.test.js. And what is counted for the figures: what an account did first, the limits it ran
 * into, the visits a site tells of, and the table by week and origin with its CSV.
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
import { createOrigins, cleanTag, cleanHost, ENTRIES, weekOf, originOf, LIMIT_DAYS } from '../origins.js';
import { createSuite, createApp } from '../app.js';
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
  assert.deepEqual({ ...database.get("SELECT src, referrer, entry, heard FROM origin_payments WHERE ref = 'txn_1'") },
    { src: 'reddit-mcp', referrer: 'reddit.com', entry: 'web', heard: null }, 'the origin as it was when they paid');

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

test('a first questions’ answer is noted with a payment where the host asks them', (t) => {
  const { origins, arrive, database } = setup(t);
  database.exec('CREATE TABLE host_first_answers (user_id INTEGER PRIMARY KEY, heard_from TEXT, has_channel INTEGER, channel TEXT, answered_at TEXT NOT NULL)');
  const ana = arrive('ana');
  database.run("INSERT INTO host_first_answers (user_id, heard_from, answered_at) VALUES (?, 'producthunt', 'now')", ana.id);
  assert.equal(origins.heardOf(ana.id), 'producthunt');
  origins.paid({ user: ana, event: { type: 'payment', ref: 'txn_9', amount: 390, currency: 'EUR', product: 'pro-monthly', first: true } }, { provider: 'paddle' });
  assert.equal(database.get("SELECT heard FROM origin_payments WHERE ref = 'txn_9'").heard, 'producthunt');
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

/* ----------------------------------- figures ----------------------------------- */

const DAY = 24 * 3600 * 1000;
const settle = () => new Promise((resolve) => { setImmediate(resolve); });

test('a week is Monday to Sunday, and an account has one origin: its link’s tag, else the site, else its answer, else how it was made', () => {
  assert.equal(weekOf('2026-11-23T00:00:00.000Z'), '2026-11-23');
  assert.equal(weekOf('2026-11-29T23:59:59.999Z'), '2026-11-23');
  assert.equal(weekOf('2026-11-30'), '2026-11-30');
  assert.equal(weekOf(Date.parse('2027-01-01T10:00:00Z')), '2026-12-28', 'across a year');
  assert.equal(weekOf('nonsense'), null);
  assert.deepEqual(originOf({ src: 'reddit-mcp', referrer: 'reddit.com', heard: 'reddit', entry: 'web' }), ['link', 'reddit-mcp']);
  assert.deepEqual(originOf({ referrer: 'reddit.com', heard: 'friend', entry: 'web' }), ['site', 'reddit.com']);
  assert.deepEqual(originOf({ heard: 'store', entry: 'app' }), ['answer', 'store']);
  assert.deepEqual(originOf({ entry: 'mcp' }), ['entry', 'mcp']);
  assert.deepEqual(originOf({ entry: 'web' }), ['none', '']);
  assert.deepEqual(originOf(), ['none', '']);
});

test('what an account did first is noted once: the first thing made, the first call from an assistant, each limit met', async (t) => {
  const { origins, arrive, database, clock, accounts } = setup(t);
  const ana = arrive('ana');
  origins.made(ana);
  clock.now += DAY;
  origins.made(ana);
  origins.usedMcp(ana);
  origins.limitReached(ana, 'lists.max');
  assert.deepEqual(origins.marksOf(ana.id).map((m) => m.mark), ['made', 'mcp'], 'a limit is written after what refused it');
  await settle();
  origins.limitReached(ana, 'lists.max');
  origins.limitReached(ana, 'storage.mb');
  origins.limitReached(ana, 'not a feature!');
  origins.limitReached(null, 'lists.max');
  origins.made(null);
  await settle();
  assert.deepEqual(origins.marksOf(ana.id).map((m) => [m.mark, m.at.slice(0, 10)]),
    [['made', '2026-11-25'], ['limit:lists.max', '2026-11-26'], ['limit:storage.mb', '2026-11-26'], ['mcp', '2026-11-26']]);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM account_marks').n, 4);
  // Gone with the account, and noted again for whoever comes with that number.
  accounts.remove(ana.id);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM account_marks').n, 0);
});

test('a visit is a number for its day and origin: the tag, else the site, else from nowhere known; nothing of the visitor', (t) => {
  const { origins, database, clock } = setup(t);
  origins.visited({ src: 'Reddit-MCP', via: 'https://www.reddit.com/r/mcp/' });
  origins.visited({ src: 'reddit-mcp' });
  origins.visited({ via: 'news.ycombinator.com' });
  origins.visited({ src: '<script>', via: 'not a site' });
  origins.visited({ via: 'https://work.example.com/tasks/' });
  origins.visited();
  clock.now += DAY;
  origins.visited({ src: 'reddit-mcp' });
  assert.deepEqual(database.all('SELECT day, src, referrer, n FROM origin_visits ORDER BY day, src, referrer').map((r) => ({ ...r })), [
    { day: '2026-11-25', src: '', referrer: '', n: 3 },
    { day: '2026-11-25', src: '', referrer: 'news.ycombinator.com', n: 1 },
    { day: '2026-11-25', src: 'reddit-mcp', referrer: '', n: 2 },
    { day: '2026-11-26', src: 'reddit-mcp', referrer: '', n: 1 },
  ]);
  assert.deepEqual(database.columnsOf('origin_visits').map((c) => c.name ?? c), ['day', 'src', 'referrer', 'n'], 'a day, an origin and a number: no more');
  // Tags nobody published can't grow a day without end: past 500 origins, the rest are one.
  for (let i = 0; i < 520; i++) origins.visited({ src: `junk-${i}` });
  const day = database.get("SELECT COUNT(*) AS rows, SUM(n) AS visits FROM origin_visits WHERE day = '2026-11-26'");
  assert.deepEqual({ ...day }, { rows: 501, visits: 521 });
  assert.equal(database.get("SELECT n FROM origin_visits WHERE day = '2026-11-26' AND src = '(other)'").n, 21);
  origins.visited({ src: 'reddit-mcp' });
  assert.equal(database.get("SELECT n FROM origin_visits WHERE day = '2026-11-26' AND src = 'reddit-mcp'").n, 2, 'one already there still counts as itself');
});

test('the figures by week and origin: visits, accounts, who did something, who met a limit in 30 days, who pays and what', async (t) => {
  const { origins, arrive, database, clock } = setup(t);
  database.exec('CREATE TABLE host_first_answers (user_id INTEGER PRIMARY KEY, heard_from TEXT, has_channel INTEGER, channel TEXT, answered_at TEXT NOT NULL)');
  const answer = (user, heard) => database.run('INSERT INTO host_first_answers (user_id, heard_from, answered_at) VALUES (?, ?, ?)', user.id, heard, 'now');
  const pay = (user, ref, amount, extra = {}) => origins.paid({ user, event: { type: 'payment', ref, amount, currency: 'EUR', product: 'pro-yearly', first: true, ...extra } }, { provider: 'paddle' });

  // The week of 16 Nov: one account from Hacker News, which pays later.
  clock.now = Date.parse('2026-11-18T10:00:00Z');
  origins.visited({ via: 'news.ycombinator.com' });
  const old = arrive('old', { login: '/auth/login', referer: 'https://news.ycombinator.com/item?id=1' });
  // The week of 23 Nov.
  clock.now = Date.parse('2026-11-25T10:00:00Z');
  for (let i = 0; i < 40; i++) origins.visited({ src: 'reddit-mcp' });
  for (let i = 0; i < 7; i++) origins.visited({ via: 'google.com' });
  origins.visited();
  const ana = arrive('ana', { login: '/auth/login?src=reddit-mcp&via=reddit.com' });
  const bob = arrive('bob', { login: '/auth/login?src=reddit-mcp' });
  const cat = arrive('cat', { login: '/auth/login?via=google.com' });
  const dan = arrive('dan');
  const eve = arrive('eve', { at: '/mcp' });
  const fay = arrive('fay');
  answer(ana, 'reddit');
  answer(dan, 'producthunt');
  answer(fay, 'producthunt');
  origins.made(ana);
  origins.usedMcp(bob);
  origins.made(bob);
  origins.usedMcp(eve);
  origins.limitReached(ana, 'lists.max');
  origins.limitReached(ana, 'storage.mb');
  await settle();
  pay(ana, 'txn_a1', 1900);
  pay(bob, 'txn_b1', 0, { product: 'pro-monthly' });
  pay(cat, 'txn_c1', 3500);
  pay(cat, 'txn_c2', 3500);
  origins.refunded({ event: { type: 'refund', ref: 'txn_c2' } }, { provider: 'paddle' });
  origins.applied({ outcome: 'granted', event: { type: 'subscription', ref: 'app_store:m:1', product: 'store-pro-monthly', periodEnd: '2026-12-25T00:00:00Z' },
    subject: { type: 'user', id: dan.id }, product: { plan: 'pro' }, provider: 'revenuecat' });
  // A limit met long after the first 30 days doesn't count; a payment of the older account does, in its own week.
  clock.now = Date.parse('2026-11-25T10:00:00Z') + (LIMIT_DAYS + 1) * DAY;
  origins.limitReached(bob, 'lists.max');
  await settle();
  clock.now = Date.parse('2026-11-27T10:00:00Z');
  pay(old, 'txn_o1', 3500);

  const { weeks, rows, answers } = origins.report({ weeks: 2 });
  assert.deepEqual(weeks, ['2026-11-23', '2026-11-16']);
  const brief = (row) => [row.week, row.kind, row.origin, row.visits, row.signups, row.activated, row.limited, row.paying, row.plans, row.payments, row.income];
  assert.deepEqual(rows.map(brief), [
    ['2026-11-23', 'link', 'reddit-mcp', 40, 2, 2, 1, 1, { pro: 1 }, 2, { EUR: 1900 }],
    ['2026-11-23', 'answer', 'producthunt', 0, 2, 0, 0, 1, { pro: 1 }, 1, {}],
    ['2026-11-23', 'site', 'google.com', 7, 1, 0, 0, 1, { pro: 1 }, 1, { EUR: 3500 }],
    ['2026-11-23', 'entry', 'mcp', 0, 1, 1, 0, 0, {}, 0, {}],
    ['2026-11-23', 'none', '', 1, 0, 0, 0, 0, {}, 0, {}],
    ['2026-11-16', 'site', 'news.ycombinator.com', 1, 1, 0, 0, 1, { pro: 1 }, 1, { EUR: 3500 }],
  ]);
  assert.deepEqual(answers, [{ week: '2026-11-23', heard: 'producthunt', n: 2 }, { week: '2026-11-23', heard: 'reddit', n: 1 }]);
  assert.deepEqual(origins.report({ weeks: 1 }).weeks, ['2026-11-23']);
  assert.equal(origins.report({ weeks: 1 }).rows.some((row) => row.week === '2026-11-16'), false);
  assert.equal(origins.report({ weeks: 999 }).weeks.length, 52);

  assert.deepEqual(origins.exportCsv({ weeks: 2 }).split('\r\n'), [
    'week,kind,origin,visits,signups,activated,limited,paying,paying_pro,payments,income_EUR',
    '2026-11-23,link,reddit-mcp,40,2,2,1,1,1,2,19.00',
    '2026-11-23,answer,producthunt,0,2,0,0,1,1,1,0.00',
    '2026-11-23,site,google.com,7,1,0,0,1,1,1,35.00',
    '2026-11-23,entry,mcp,0,1,1,0,0,0,0,0.00',
    '2026-11-23,none,,1,0,0,0,0,0,0,0.00',
    '2026-11-16,site,news.ycombinator.com,1,1,0,0,1,1,1,35.00',
    '',
  ]);

  // For the daily summary: where the accounts made between two moments came from, the three with most.
  assert.equal(origins.topSince('2026-11-25T00:00:00.000Z', '2026-11-26T00:00:00.000Z'), 'producthunt 2, reddit-mcp 2, google.com 1');
  assert.equal(origins.topSince('2026-11-18T00:00:00.000Z', '2026-11-19T00:00:00.000Z'), 'news.ycombinator.com 1');
  assert.equal(origins.topSince('2026-12-25T00:00:00.000Z', '2026-12-26T00:00:00.000Z'), null);
});

test('an app that keeps origins: what a route answers 201 to, a limit refused and a call from an assistant are noted; a site tells its visits with the token', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-origins-app-'));
  const TOKEN = `visits-${'x'.repeat(24)}`;
  const lines = [];
  const suite = createSuite({
    config: {
      app: { id: 'demo', name: 'Demo', languages: ['en'] }, accounts: { minPasswordLength: 8 }, modules: { origins: true },
      features: { 'notes.max': { type: 'limit', default: null, label: 'more notes' }, 'mcp.calls_per_week': { type: 'limit', default: null, label: 'more calls' } },
      plans: { free: { name: 'Free', features: { 'notes.max': 1, 'mcp.calls_per_week': 1 } } }, defaultPlan: 'free',
    },
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1', ORIGIN_VISITS_TOKEN: TOKEN },
    migrations: [{ version: 1, name: 'notes', up: (d) => d.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT)') }],
    log: (line) => lines.push(line), exitOnError: false,
  });
  const app = createApp({
    suite, version: '1.0.0', handleSignals: false, log: () => {},
    routes: (api) => {
      api.post('/api/notes', (ctx) => {
        // As an app does it: the limit asked inside the change's own transaction.
        suite.database.tx(() => {
          suite.entitlements.require(ctx.user, 'notes.max', { current: suite.database.get('SELECT COUNT(*) AS n FROM notes WHERE user_id = ?', ctx.user.id).n });
          suite.database.run('INSERT INTO notes (user_id, text) VALUES (?, ?)', ctx.user.id, 'a note');
        });
        ctx.res.writeHead(201, { 'Content-Type': 'application/json' });
        ctx.res.end('{}');
      });
      api.post('/api/seen', (ctx) => { ctx.res.writeHead(200, { 'Content-Type': 'application/json' }); ctx.res.end('{}'); });
    },
    mcp: { instructions: 'Notes.', tools: [{ name: 'ping', title: 'Ping', description: 'Answers', inputSchema: { type: 'object', properties: {} }, handler: () => ({ content: [{ type: 'text', text: 'pong' }] }) }] },
  });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username, password) => {
    let cookie = '';
    const call = async (method, pathname, body, headers = {}) => {
      const res = await fetch(base + pathname, {
        method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('demo_sid='));
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let data = text;
      try { data = JSON.parse(text); } catch { /* text */ }
      return { status: res.status, data, headers: res.headers };
    };
    assert.equal((await call('POST', '/api/auth/login', { username, password })).status, 200);
    return call;
  };
  const ana = suite.accounts.create({ username: 'ana', password: 'ana-password' });
  const admin = await as('admin', 'root-password');
  const call = await as('ana', 'ana-password');
  const marks = async () => (await admin('GET', `/api/admin/users/${ana.id}/origin`)).data.marks.map((m) => m.mark);
  assert.equal((await admin('GET', '/api/auth/config')).data.app.modules.origins, true, 'the admin’s panel has its tab');

  // Nothing yet; a route that answers 200 makes nothing; the first 201 is the first thing made.
  assert.deepEqual(await marks(), []);
  assert.equal((await call('POST', '/api/seen', {})).status, 200);
  assert.deepEqual(await marks(), []);
  assert.equal((await call('POST', '/api/notes', {})).status, 201);
  assert.deepEqual(await marks(), ['made']);
  // The plan's limit: refused, its transaction undone, and noted all the same.
  const refused = await call('POST', '/api/notes', {});
  assert.deepEqual([refused.status, refused.data.error, refused.data.feature], [402, 'plan_limit', 'notes.max']);
  await settle();
  assert.deepEqual(await marks(), ['made', 'limit:notes.max']);
  assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM notes').n, 1);

  // A call from an assistant: the first is noted; past the week's calls, the limit is.
  const token = (await call('POST', '/api/me/tokens', { name: 'Assistant' })).data.token;
  const rpc = async () => (await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: {} } }),
  })).json();
  assert.equal((await rpc()).result.content[0].text, 'pong');
  assert.match((await rpc()).result.content[0].text, /limit/i);
  await settle();
  assert.deepEqual((await marks()).sort(), ['limit:mcp.calls_per_week', 'limit:notes.max', 'made', 'mcp']);

  // A site tells of its visits: with the install's token and nothing else.
  const visit = (body, authorization) => fetch(`${base}/api/origins/visits`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await visit({ src: 'reddit-mcp' })).status, 401);
  assert.equal((await visit({ src: 'reddit-mcp' }, 'Bearer nope')).status, 401);
  assert.equal((await visit({ src: 'reddit-mcp' }, `Bearer ${TOKEN.slice(0, -1)}`)).status, 401);
  assert.equal((await visit({ src: 'Reddit-MCP', via: 'reddit.com' }, `Bearer ${TOKEN}`)).status, 204);
  assert.equal((await visit({ via: 'https://www.google.com/search?q=cronum' }, `Bearer ${TOKEN}`)).status, 204);
  assert.deepEqual(suite.database.all('SELECT src, referrer, n FROM origin_visits ORDER BY src').map((r) => ({ ...r })),
    [{ src: '', referrer: 'google.com', n: 1 }, { src: 'reddit-mcp', referrer: '', n: 1 }]);

  // The figures and their CSV are the admin's alone.
  const figures = (await admin('GET', '/api/admin/origins?weeks=4')).data;
  assert.equal(figures.weeks.length, 4);
  const mine = figures.rows.find((row) => row.kind === 'none' && row.signups);
  assert.deepEqual([mine.signups, mine.activated, mine.limited], [2, 1, 1], 'the admin and ana, made outside a sign-in');
  assert.equal(figures.rows.find((row) => row.origin === 'reddit-mcp').visits, 1);
  const csv = await admin('GET', '/api/admin/origins/export?weeks=4');
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /origins\.csv/);
  assert.match(String(csv.data), /^week,kind,origin,visits,signups,activated,limited,paying,payments\r\n/);
  assert.equal((await admin('GET', '/api/admin/origins?weeks=0')).data.field, 'weeks');
  assert.equal((await call('GET', '/api/admin/origins')).status, 403);
  assert.equal((await call('GET', '/api/admin/origins/export')).status, 403);
});

test('without ORIGIN_VISITS_TOKEN no one can tell of a visit; a short one is left out with a warning', async () => {
  const product = { app: { id: 'demo', name: 'Demo', languages: ['en'] }, modules: { origins: true } };
  const env = { DATA_DIR: os.tmpdir(), BASE_URL: 'http://127.0.0.1' };
  assert.equal(resolveConfig(product, env).install.originVisitsToken, '');
  assert.equal(resolveConfig(product, { ...env, ORIGIN_VISITS_TOKEN: 'x'.repeat(24) }).install.originVisitsToken, 'x'.repeat(24));
  const short = resolveConfig(product, { ...env, ORIGIN_VISITS_TOKEN: 'short' });
  assert.equal(short.install.originVisitsToken, '');
  assert.match(short.warnings.join('\n'), /ORIGIN_VISITS_TOKEN must be 24 characters or more/);
  const off = resolveConfig({ app: product.app }, { ...env, ORIGIN_VISITS_TOKEN: 'x'.repeat(24) });
  assert.equal(off.install.originVisitsToken, '');
  assert.match(off.warnings.join('\n'), /keeps no origins/);
});
