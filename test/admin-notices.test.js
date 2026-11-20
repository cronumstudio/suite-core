/**
 * The admin's notices of new accounts and payments (admin-notices.js): templates with parts left
 * out when what they name isn't known, the country only from Cloudflare's own addresses, an account
 * only when someone made it themselves, payments by group, a run gathered into one notice, the
 * daily summary once a day at its hour, the pause, the token never shown; then an app with
 * modules.notices over real HTTP: /admin › Notifications' routes and a sign-up from Brazil.
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
import { createTexts } from '../i18n.js';
import { cloudflareCountry } from '../http.js';
import { inRequest } from '../request-scope.js';
import { createSuite, createApp } from '../app.js';
import {
  createAdminNotices, renderTemplate, unknownVariables, countryCode, flagOf, countryName, localClock, ntfyUrl,
  NOTICE_BURST, NOTICE_VARIABLES,
} from '../admin-notices.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/* ------------------------------- plain pieces ------------------------------- */

test('a template: variables by their values, a part in brackets left out when one it names is unknown', () => {
  const t = '🎉 New account[ from {country} {flag}].[ {users} accounts in all.]';
  assert.equal(renderTemplate(t, { country: 'Brazil', flag: '🇧🇷', users: '4,682' }), '🎉 New account from Brazil 🇧🇷. 4,682 accounts in all.');
  assert.equal(renderTemplate(t, { users: '4,682' }), '🎉 New account. 4,682 accounts in all.');
  assert.equal(renderTemplate(t, {}), '🎉 New account.');
  // An empty value is as unknown as a missing one; a variable outside brackets leaves nothing.
  assert.equal(renderTemplate('{reason}: {plan}[ · {amount}].', { reason: 'Refunded', plan: 'Pro', amount: '' }), 'Refunded: Pro.');
  // Lines are kept, and those a part left empty go.
  assert.equal(renderTemplate('Summary:[\nNew: {a}][\nPaid: {b}][\nEnded: {c}]', { a: '3', c: '0' }), 'Summary:\nNew: 3\nEnded: 0');
});

test('the variables a template may name are its group’s', () => {
  assert.deepEqual(unknownVariables('New account from {pais}, {users}', 'signup'), ['pais']);
  assert.deepEqual(unknownVariables('{signups} new, {top_country}', 'digest'), []);
  assert.deepEqual(unknownVariables('{plan}', 'signup'), ['plan'], 'an account has no plan');
  for (const vars of Object.values(NOTICE_VARIABLES)) assert.ok(vars.includes('app'));
});

test('countries: ISO codes only, the unknown and Tor none, a flag and a name in the language', () => {
  assert.equal(countryCode('br'), 'BR');
  for (const none of ['XX', 'T1', 'ZZ', 'EU', '', null, 'BRA', '1A']) assert.equal(countryCode(none), null, String(none));
  assert.equal(flagOf('BR'), '🇧🇷');
  assert.equal(flagOf('XX'), '');
  assert.equal(countryName('BR', 'es'), 'Brasil');
  assert.equal(countryName('DE', 'en'), 'Germany');
});

test('the country Cloudflare says, believed only from its addresses and with TRUST_PROXY=cloudflare', () => {
  const req = (hop, country = 'BR') => ({ headers: { 'x-forwarded-for': `203.0.113.9, ${hop}`, 'cf-ipcountry': country }, socket: { remoteAddress: '10.0.0.2' } });
  assert.equal(cloudflareCountry(req('104.16.0.1'), { trustProxy: 'cloudflare' }), 'BR', 'a Cloudflare edge');
  assert.equal(cloudflareCountry(req('2a06:98c1:3120::5'), { trustProxy: 'cloudflare' }), 'BR', 'over IPv6 too');
  assert.equal(cloudflareCountry(req('198.51.100.7'), { trustProxy: 'cloudflare' }), null, 'anyone else could have written it');
  assert.equal(cloudflareCountry(req('104.16.0.1'), { trustProxy: 'true' }), null, 'without Cloudflare said, never');
  assert.equal(cloudflareCountry(req('104.16.0.1'), { trustProxy: '' }), null);
});

test('an ntfy server: https only, no user, query or fragment', () => {
  assert.equal(ntfyUrl('https://ntfy.example.com'), 'https://ntfy.example.com/');
  for (const bad of ['http://ntfy.example.com', 'https://u:p@ntfy.example.com', 'https://ntfy.example.com/?a=1', 'ftp://x', 'nope', '']) {
    assert.equal(ntfyUrl(bad), null, bad);
  }
});

test('a moment as the day and hour of a time zone', () => {
  const at = Date.parse('2026-11-18T23:30:00Z');
  assert.deepEqual(localClock(at, 'UTC'), { day: '2026-11-18', hour: 23 });
  assert.deepEqual(localClock(at, 'Europe/Madrid'), { day: '2026-11-19', hour: 0 });
});

/* ---------------------------------- notices --------------------------------- */

/** Notices on a database of their own, with ntfy and the mail as fakes and a clock that moves. */
function setup(t, { countryOf = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-notices-'));
  const database = openDatabase({ path: path.join(dir, 'test.db') });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const now = { at: Date.parse('2026-11-18T10:00:00Z') };
  const posted = [];
  const fetch = async (url, options) => {
    posted.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return { ok: !fetch.refuse, status: fetch.refuse ? 401 : 200, body: null };
  };
  const mailer = { provider: 'smtp', sent: [], async send(message) { mailer.sent.push(message); } };
  const lines = [];
  const notices = createAdminNotices({
    database, texts: createTexts(), mailer, sign: (v) => `signed:${v}`, appName: 'Demo', baseUrl: 'https://demo.example',
    countryOf, planName: (id) => ({ pro: 'Pro' }[id] || id), fetch, clock: () => now.at, log: (line) => lines.push(line),
  });
  const addUsers = (n) => {
    for (let i = 0; i < n; i++) {
      database.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, '!', 'user', ?)",
        `u${Math.random().toString(36).slice(2)}`, 'U', new Date(now.at).toISOString());
    }
  };
  const settle = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  return { database, notices, posted, mailer, now, fetch, lines, addUsers, settle };
}

const signupReq = (country = 'BR', url = '/auth/callback?code=1') => ({ url, headers: { 'cf-ipcountry': country } });
const fromHeader = (req) => req.headers['cf-ipcountry'];

test('settings: checked as a whole, the token kept encrypted and never shown', (t) => {
  const { notices, database } = setup(t);
  const view = notices.save({ ntfy: { url: 'https://ntfy.example.com', topic: 'cronum-admin', token: 'tk_secret' }, lang: 'es' });
  assert.equal(view.ntfy.has_token, true);
  assert.equal(JSON.stringify(view).includes('tk_secret'), false, 'the panel never gets it back');
  assert.equal(database.getMeta('admin_notices').includes('tk_secret'), false, 'nor does the database have it in the clear');
  for (const [body, field] of [
    [{ ntfy: { url: 'http://ntfy.example.com' } }, 'ntfy_url'],
    [{ ntfy: { topic: 'no spaces' } }, 'ntfy_topic'],
    [{ groups: { signup: 'loud' } }, 'groups'],
    [{ templates: { signup: 'From {pais}' } }, 'template'],
    [{ templates: { signup: 'From [{country}' } }, 'template'],
    [{ digest: { hour: 24 } }, 'digest_hour'],
    [{ digest: { zone: 'Mars/Olympus' } }, 'zone'],
    [{ email: 'not an address' }, 'email'],
  ]) {
    assert.throws(() => notices.save(body), (err) => err.status === 400 && err.extra?.field === field, field);
  }
  // A token left out stays; given empty, it goes.
  assert.equal(notices.save({ ntfy: { topic: 'other' } }).ntfy.has_token, true);
  assert.equal(notices.save({ ntfy: { token: '' } }).ntfy.has_token, false);
});

test('a new account: noted with its country, told to ntfy at once with the token, and nobody’s name', async (t) => {
  const { notices, posted, addUsers, settle } = setup(t, { countryOf: fromHeader });
  notices.save({ ntfy: { url: 'https://ntfy.example.com', topic: 'cronum-admin', token: 'tk_secret' }, lang: 'es' });
  addUsers(4682);
  inRequest(signupReq('BR'), () => notices.signedUp({ id: 1, role: 'user', email: 'ana@example.com', display_name: 'Ana' }));
  await settle();
  assert.equal(posted.length, 1);
  const [{ url, headers, body }] = posted;
  assert.equal(url, 'https://ntfy.example.com/');
  assert.equal(headers.authorization, 'Bearer tk_secret');
  assert.equal(body.topic, 'cronum-admin');
  assert.equal(body.title, 'Nueva alta');
  assert.equal(body.message, '🎉 ¡Felicidades! Nueva alta desde Brasil 🇧🇷. 4682 usuarios en total.');
  assert.equal(body.click, 'https://demo.example/admin');
  assert.ok(!JSON.stringify(body).includes('ana'), 'no email, no name');
});

test('only accounts people make: not outside a request, not the admin’s, not one made or imported from /admin', async (t) => {
  const { notices, posted, database, settle } = setup(t, { countryOf: fromHeader });
  notices.save({ ntfy: { url: 'https://ntfy.example.com', topic: 'admin' } });
  notices.signedUp({ id: 1, role: 'user' });
  inRequest(signupReq('BR'), () => notices.signedUp({ id: 2, role: 'admin' }));
  inRequest(signupReq('BR', '/api/admin/users'), () => notices.signedUp({ id: 3, role: 'user' }));
  inRequest(signupReq('BR', '/api/admin/data/import'), () => notices.signedUp({ id: 4, role: 'user' }));
  await settle();
  assert.equal(posted.length, 0);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM admin_notice_events').n, 0);
});

test('without a country, the part that names it goes; with the country off, too', async (t) => {
  const { notices, posted, settle } = setup(t, { countryOf: fromHeader });
  notices.save({ ntfy: { url: 'https://ntfy.example.com', topic: 'admin' }, totals: false });
  inRequest(signupReq('XX'), () => notices.signedUp({ id: 1, role: 'user' }));
  notices.save({ country: false });
  inRequest(signupReq('BR'), () => notices.signedUp({ id: 2, role: 'user' }));
  await settle();
  assert.deepEqual(posted.map((p) => p.body.message), ['🎉 New account.', '🎉 New account.']);
});

test('payments by group: a purchase with its amount, a renewal to the summary, a refund at once', async (t) => {
  const { notices, posted, database, settle } = setup(t);
  notices.save({ ntfy: { url: 'https://ntfy.example.com', topic: 'admin' }, totals: false });
  notices.billed({ outcome: 'granted', event: { country: 'mx', amount: 35, currency: 'EUR' }, product: { plan: 'pro' } });
  notices.billed({ outcome: 'extended', event: { amount: 35, currency: 'EUR' }, product: { plan: 'pro' } });
  notices.billed({ outcome: 'refunded', event: {}, product: null });
  // What changes no plan is no group's.
  for (const outcome of ['unchanged', 'duplicate', 'stale', 'ignored', 'foreign', 'pending']) notices.billed({ outcome, event: {} });
  await settle();
  assert.deepEqual(posted.map((p) => [p.body.title, p.body.message]), [
    ['New purchase', '💰 New purchase: Pro · €35.00 from Mexico 🇲🇽.'],
    ['Ended', '👋 Refunded.'],
  ]);
  assert.deepEqual(database.all('SELECT grp, kind FROM admin_notice_events ORDER BY id').map((r) => `${r.grp}:${r.kind}`),
    ['purchase:granted', 'renewal:extended', 'cancel:refunded']);
});

test('a run: five at once, the rest held and told as one when it is over', async (t) => {
  const { notices, posted, now, settle } = setup(t);
  notices.save({ ntfy: { url: 'https://ntfy.example.com', topic: 'admin' }, totals: false });
  for (let i = 0; i < NOTICE_BURST.count + 3; i++) {
    inRequest(signupReq(), () => notices.signedUp({ id: i, role: 'user' }));
    await settle();
    now.at += 30 * 1000;
  }
  assert.equal(posted.length, NOTICE_BURST.count, 'the first ones, one by one');
  await notices.tick();
  assert.equal(posted.length, NOTICE_BURST.count, 'nothing while the run goes on');
  now.at += NOTICE_BURST.withinMs;
  await notices.tick();
  assert.equal(posted.length, NOTICE_BURST.count + 1);
  assert.match(posted.at(-1).body.message, /^🎉 3 more new accounts in the last \d+ min\.$/);
});

test('the daily summary: at its hour, once a day, the summary’s groups only, and none on a day with nothing', async (t) => {
  const { notices, posted, now, mailer, settle } = setup(t, { countryOf: fromHeader });
  notices.save({
    ntfy: { url: 'https://ntfy.example.com', topic: 'admin' }, email: 'ops@example.com', totals: false,
    groups: { signup: 'digest', purchase: 'instant', renewal: 'digest', cancel: 'off' },
    via: { instant: ['ntfy'], digest: ['ntfy', 'email'] }, digest: { hour: 9, zone: 'Europe/Madrid' },
  });
  await notices.tick();   // the first one marks where the summary starts
  for (const country of ['BR', 'BR', 'AR']) inRequest(signupReq(country), () => notices.signedUp({ id: 1, role: 'user' }));
  notices.billed({ outcome: 'extended', event: {}, product: { plan: 'pro' } });
  notices.billed({ outcome: 'granted', event: {}, product: { plan: 'pro' } });
  notices.billed({ outcome: 'revoked', event: {}, product: { plan: 'pro' } });
  await settle();
  assert.equal(posted.length, 1, 'only the purchase, at once');
  now.at = Date.parse('2026-11-19T07:30:00Z');   // 8:30 in Madrid
  await notices.tick();
  assert.equal(posted.length, 1, 'not before its hour');
  now.at = Date.parse('2026-11-19T08:05:00Z');   // 9:05 in Madrid
  await notices.tick();
  assert.equal(posted.length, 2);
  assert.equal(posted[1].body.title, 'Daily summary');
  assert.equal(posted[1].body.message, '📊 Since the last summary:\nNew accounts: 3\nRenewals: 1\nMost from: Brazil 🇧🇷');
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].subject, 'Demo · Daily summary');
  now.at += HOUR;
  await notices.tick();
  assert.equal(posted.length, 2, 'once a day');
  now.at = Date.parse('2026-11-20T08:05:00Z');
  await notices.tick();
  assert.equal(posted.length, 2, 'a day with nothing sends nothing');
});

test('paused: nothing at once nor in the summary until it is over', async (t) => {
  const { notices, posted, now, settle } = setup(t);
  notices.save({ ntfy: { url: 'https://ntfy.example.com', topic: 'admin' }, paused_until: new Date(now.at + HOUR).toISOString() });
  inRequest(signupReq(), () => notices.signedUp({ id: 1, role: 'user' }));
  await settle();
  assert.equal(posted.length, 0);
  now.at += 2 * HOUR;
  inRequest(signupReq(), () => notices.signedUp({ id: 2, role: 'user' }));
  await settle();
  assert.equal(posted.length, 1);
});

test('a test to every destination; a refusal kept for the panel, never thrown', async (t) => {
  const { notices, posted, mailer, fetch } = setup(t);
  assert.throws(() => notices.test(), (err) => err.code === 'notices_no_destination');
  notices.save({ ntfy: { url: 'https://ntfy.example.com', topic: 'admin' }, email: 'ops@example.com' });
  assert.deepEqual(await notices.test(), [{ channel: 'ntfy', ok: true }, { channel: 'email', ok: true }]);
  assert.equal(posted.length, 1);
  assert.equal(mailer.sent.length, 1);
  fetch.refuse = true;
  const results = await notices.test();
  assert.deepEqual(results[0], { channel: 'ntfy', ok: false, error: 'ntfy answered 401' });
  assert.equal(notices.view().last.results[0].ok, false);
});

test('a preview in the panel’s language, with an example where an event puts its facts', (t) => {
  const { notices } = setup(t, { countryOf: fromHeader });
  assert.match(notices.preview('signup', null, 'es'), /^🎉 ¡Felicidades! Nueva alta desde Brasil 🇧🇷\. [\d.]+ usuarios en total\.$/);
  assert.equal(notices.preview('purchase', '{plan} {amount}', 'en'), 'Pro €35.00');
  assert.throws(() => notices.preview('signup', 'From {plan}'), (err) => err.extra?.field === 'template');
});

/* ------------------------------- in an app ------------------------------- */

test('an app with modules.notices: the routes for admins only, and a sign-up from Brazil behind Cloudflare', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-notices-app-'));
  const realFetch = globalThis.fetch;
  const posted = [];
  // ntfy is a fake; the rest is the app over real HTTP.
  globalThis.fetch = (url, options) => {
    if (String(url).startsWith('https://ntfy.test/')) {
      posted.push(JSON.parse(options.body));
      return Promise.resolve(new Response('{}', { status: 200 }));
    }
    return realFetch(url, options);
  };
  const suite = createSuite({
    config: { app: { id: 'demo', name: 'Demo', languages: ['en', 'es'] }, modules: { notices: true } },
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', SIGNUP: 'open', TRUST_PROXY: 'cloudflare', PLANS: '', DEFAULT_PLAN: '' },
    log: () => {}, exitOnError: false,
  });
  globalThis.fetch = realFetch;
  const app = createApp({ suite, version: '1.0.0', handleSignals: false, log: () => {} });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, pathname, body, headers = {}) => realFetch(base + pathname, {
    method, headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }));
  const root = suite.accounts.create({ username: 'root', password: 'root-password-1', role: 'admin' });
  const someone = suite.accounts.create({ username: 'someone', password: 'some-password-1', role: 'user' });
  const as = (user) => ({ Cookie: `demo_sid=${suite.sessions.open(user.id)}` });

  assert.equal((await call('GET', '/api/auth/config')).data.app.modules.notices, true);
  assert.equal((await call('GET', '/api/admin/notices')).status, 401);
  assert.equal((await call('GET', '/api/admin/notices', undefined, as(someone))).status, 403);
  const view = await call('GET', '/api/admin/notices', undefined, as(root));
  assert.equal(view.status, 200);
  assert.equal(view.data.country_available, true, 'behind Cloudflare');
  const saved = await call('PUT', '/api/admin/notices', { ntfy: { url: 'https://ntfy.test', topic: 'demo-admin' }, lang: 'es' }, as(root));
  assert.equal(saved.status, 200);
  assert.equal((await call('PUT', '/api/admin/notices', { ntfy: { url: 'http://ntfy.test' } }, as(root))).data.field, 'ntfy_url');

  const signed = await call('POST', '/api/auth/signup', { username: 'ana', email: 'ana@example.com', password: 'ana-password-1' }, {
    'X-Forwarded-For': '203.0.113.9, 104.16.0.1', 'CF-IPCountry': 'BR',
  });
  assert.equal(signed.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].topic, 'demo-admin');
  // The first administrator the start made, root, someone and Ana.
  assert.equal(posted[0].message, '🎉 ¡Felicidades! Nueva alta desde Brasil 🇧🇷. 4 usuarios en total.');
  const audit = suite.audit.list({ limit: 50 }).map((row) => row.action);
  assert.ok(audit.includes('admin.notices.update'));
});

test('without modules.notices nothing changes: no tab, no routes, no notices', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-notices-off-'));
  const suite = createSuite({
    config: { app: { id: 'demo', name: 'Demo', languages: ['en'] } },
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', PLANS: '', DEFAULT_PLAN: '' },
    log: () => {}, exitOnError: false,
  });
  const app = createApp({ suite, version: '1.0.0', handleSignals: false, log: () => {} });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(suite.notices, null);
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = suite.accounts.create({ username: 'root', password: 'root-password-1', role: 'admin' });
  const config = await (await fetch(`${base}/api/auth/config`)).json();
  assert.equal(config.app.modules.notices, undefined);
  const res = await fetch(`${base}/api/admin/notices`, { headers: { Cookie: `demo_sid=${suite.sessions.open(root.id)}` } });
  assert.equal(res.status, 404);
});
