/**
 * The install's terms (terms.js): what the settings say, which accounts are asked (those made from
 * this version on, never those already there), what an account that has yet to accept them may
 * reach, accepting them on their page or with the box of a sign-up, and the record of it on the
 * account, in its copy and for the admin. Over real HTTP on an app made of the suite: local
 * accounts, WorkOS with the test kit's fake and its posted box, and nothing of it without pages.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSuite, createApp } from '../app.js';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { createAccounts } from '../accounts.js';
import { termsFromEnv, createTerms, postedHere, TERMS_PATH, OPEN_ROUTES } from '../terms.js';
import { inRequest } from '../request-scope.js';
import { client, fakeWorkos } from '../tools/test-kit.mjs';
import { openZip } from '../zip.js';

const LEGAL = { TERMS_URL: 'https://example.com/terms', PRIVACY_URL: 'https://example.com/privacy', TERMS_VERSION: '2026-12-08' };

/** An app on the suite over HTTP, with `env` on top of a local install where anyone may sign up. */
async function serve(t, env = {}, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-terms-'));
  const suite = createSuite({
    config: { app: { id: 'demo', name: 'Demo', port: 3999, languages: ['en', 'es'] }, ...config },
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', SIGNUP: 'open', ADMIN_USER: 'root', ADMIN_PASSWORD: 'root-password-1', ...env },
    log: () => {}, exitOnError: false,
  });
  const app = createApp({ suite, version: '1.0.0', handleSignals: false, log: () => {}, portable: { tables: {} } });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { suite, base, call: client(base, { cookieName: 'demo_sid' }) };
}

/** A local sign-up: a client with its session, and the account's row. */
async function signUp(env, username, extra = {}) {
  const person = client(env.base, { cookieName: 'demo_sid' });
  const made = await person('POST', '/api/auth/signup', { username, email: `${username}@example.com`, password: 'a-long-password-1', ...extra });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  return { person, row: () => env.suite.database.get('SELECT * FROM users WHERE username = ?', username) };
}

test('the settings: the two pages About links and TERMS_VERSION; neither page, nothing; a version that is none is said and left out', () => {
  const links = { terms: 'https://example.com/terms', privacy: 'https://example.com/privacy' };
  let warnings = [];
  assert.deepEqual(termsFromEnv({ TERMS_VERSION: '2026-12-08' }, links, warnings), { ...links, version: '2026-12-08' });
  assert.deepEqual(warnings, []);
  assert.deepEqual(termsFromEnv({ TERMS_VERSION: 'v2.1_beta' }, { terms: links.terms }, warnings), { terms: links.terms, privacy: null, version: 'v2.1_beta' });
  assert.deepEqual(termsFromEnv({ TERMS_VERSION: 'x' }, { privacy: links.privacy }, warnings).privacy, links.privacy);
  assert.deepEqual(warnings, []);
  // Neither page: off, and a version alone is said to ask nobody.
  assert.equal(termsFromEnv({}, {}, warnings), null);
  assert.deepEqual(warnings, []);
  assert.equal(termsFromEnv({ TERMS_VERSION: '2026-12-08' }, {}, warnings), null);
  assert.match(warnings.pop(), /TERMS_VERSION is set but neither TERMS_URL nor PRIVACY_URL/);
  // Pages without a version: asked all the same, recorded without one, and said at the start.
  assert.equal(termsFromEnv({}, links, warnings).version, null);
  assert.match(warnings.pop(), /without TERMS_VERSION/);
  for (const bad of ['-2026', 'a b', 'x'.repeat(41), 'é']) {
    warnings = [];
    assert.equal(termsFromEnv({ TERMS_VERSION: bad }, links, warnings).version, null, bad);
    assert.match(warnings[0], /TERMS_VERSION .* is not a date or a short name/, bad);
  }
});

test('a post from this site’s own page, and nothing else, counts as the box ticked', () => {
  const req = (method, headers) => ({ method, headers: { host: '127.0.0.1:4000', ...headers } });
  const base = 'https://work.example.com';
  assert.equal(postedHere(req('POST', { origin: 'https://work.example.com' }), base), true);
  assert.equal(postedHere(req('POST', { origin: 'http://127.0.0.1:4000' }), base), true, 'the host it came to');
  assert.equal(postedHere(req('POST', { origin: 'null', 'sec-fetch-site': 'same-origin' }), base), true, 'a no-referrer page’s own form');
  assert.equal(postedHere(req('POST', { 'sec-fetch-site': 'same-origin' }), base), true);
  assert.equal(postedHere(req('POST', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }), base), false);
  assert.equal(postedHere(req('POST', { origin: 'https://work.example.com', 'sec-fetch-site': 'same-site' }), base), false);
  assert.equal(postedHere(req('POST', { origin: 'null' }), base), false, 'a sandboxed frame elsewhere');
  assert.equal(postedHere(req('POST', {}), base), false, 'nothing that says where it came from');
  assert.equal(postedHere(req('GET', { origin: 'https://work.example.com', 'sec-fetch-site': 'same-origin' }), base), false, 'a link never ticks it');
});

test('who is asked: an account made in a request from this version on; those already there, a script’s and an import’s never', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-terms-db-'));
  const database = openDatabase({ dataDir: dir, name: 'test' });
  t.after(() => { database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  // An install from before: its accounts, then this version's migration.
  migrate(database, SUITE_MIGRATIONS.filter((m) => m.version < 41), { scope: 'suite', log: () => {} });
  database.run("INSERT INTO users (username, display_name, created_at) VALUES ('old', 'Old', '2026-01-01T00:00:00.000Z')");
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  assert.deepEqual({ ...database.get("SELECT terms_asked, terms_accepted_at, terms_version FROM users WHERE username = 'old'") },
    { terms_asked: 0, terms_accepted_at: null, terms_version: null });

  const lines = [];
  const recorded = [];
  const clock = { now: Date.parse('2026-12-08T09:30:00Z') };
  const accounts = createAccounts({ database, clock: () => clock.now });
  const terms = createTerms({
    database, settings: { terms: 'https://example.com/terms', privacy: null, version: '2026-12-08' },
    audit: { record: (entry) => recorded.push(entry) }, clock: () => clock.now, log: (line) => lines.push(line),
  });
  accounts.whenCreated(terms.noteCreated);
  const old = accounts.byUsername('old');
  assert.equal(terms.blocks(old), false, 'an account from before is never asked');

  const req = { url: '/api/auth/signup', method: 'POST', headers: {} };
  const ana = inRequest(req, () => accounts.create({ username: 'ana' }));
  assert.equal(ana.terms_asked, 1, 'the row handed back says it too');
  assert.equal(terms.blocks(accounts.byId(ana.id)), true);
  assert.equal(terms.blocksId(ana.id), true);
  // Outside a request (the first administrator, a script), or brought by an import: never asked.
  const script = accounts.create({ username: 'script' });
  const imported = inRequest(req, () => accounts.create({ username: 'imported' }, { quiet: true }));
  assert.equal(terms.blocksId(script.id), false);
  assert.equal(terms.blocksId(imported.id), false);

  assert.equal(terms.accept(ana.id, { req }), true);
  assert.deepEqual({ ...database.get('SELECT terms_accepted_at, terms_version FROM users WHERE id = ?', ana.id) },
    { terms_accepted_at: '2026-12-08T09:30:00.000Z', terms_version: '2026-12-08' });
  assert.deepEqual(recorded.map((r) => [r.action, r.actor, r.meta]), [['auth.terms_accept', ana.id, { version: '2026-12-08' }]]);
  clock.now += 60_000;
  assert.equal(terms.accept(ana.id), false, 'once: a second time changes nothing');
  assert.equal(database.get('SELECT terms_accepted_at FROM users WHERE id = ?', ana.id).terms_accepted_at, '2026-12-08T09:30:00.000Z');
  assert.equal(terms.blocksId(ana.id), false);
  // Its profile says it, for the admin's card and the person's own.
  assert.deepEqual([accounts.publicUser(accounts.byId(ana.id)).terms_accepted_at, accounts.publicUser(accounts.byId(ana.id)).terms_version],
    ['2026-12-08T09:30:00.000Z', '2026-12-08']);
  assert.equal('terms_accepted_at' in accounts.publicUser(old), false, 'nothing said of one that never accepted');

  // The page the callback sends to, coming back to where it was going; no page to a page of another site.
  assert.equal(terms.pageFor('/'), TERMS_PATH);
  assert.equal(terms.pageFor('/tasks/?list=3'), `${TERMS_PATH}?return=${encodeURIComponent('/tasks/?list=3')}`);
  assert.equal(terms.pageFor('//evil.example/'), TERMS_PATH);
  // The tick across a sign-in: once, and never after the sign-in's 30 minutes.
  terms.hold('state-1');
  terms.hold('state-2');
  assert.equal(terms.take('state-1'), true);
  assert.equal(terms.take('state-1'), false);
  assert.equal(terms.take('nothing'), false);
  clock.now += 31 * 60_000;
  assert.equal(terms.take('state-2'), false);
  assert.deepEqual(lines, []);

  // Off (no pages): nobody is blocked, nothing is recorded, nothing is held; accounts are still marked.
  const off = createTerms({ database, settings: null });
  const bea = inRequest(req, () => { const made = accounts.create({ username: 'bea' }); off.noteCreated(made); return made; });
  assert.equal(off.on, false);
  assert.equal(off.blocksId(bea.id), false);
  assert.equal(off.accept(bea.id), false);
  off.hold('s');
  assert.equal(off.take('s'), false);
  assert.equal(off.links(), null);
});

test('without TERMS_URL and PRIVACY_URL nothing of it appears: no box, no page, nobody kept out', async (t) => {
  const env = await serve(t);
  const config = (await env.call('GET', '/api/auth/config')).data;
  assert.equal('terms' in config, false);
  const { person, row } = await signUp(env, 'ana');
  assert.equal(row().terms_asked, 1, 'marked all the same: an install that links them later asks it');
  assert.equal((await person('GET', '/api/auth/me')).status, 200);
  assert.equal((await person('GET', '/api/auth/terms')).data.required, false);
  const page = await fetch(`${env.base}${TERMS_PATH}`, { redirect: 'manual' });
  assert.deepEqual([page.status, page.headers.get('location')], [302, '/']);
});

test('local accounts: the box of the sign-up records it; without it, only the page of the terms until it is accepted', async (t) => {
  const env = await serve(t, LEGAL);
  const config = (await env.call('GET', '/api/auth/config')).data;
  assert.deepEqual(config.terms, { terms: LEGAL.TERMS_URL, privacy: LEGAL.PRIVACY_URL, version: '2026-12-08' });

  // Ticked in the sign-up's form: accepted with the account, never asked again.
  const ticked = await signUp(env, 'ana', { accept_terms: true });
  assert.equal(ticked.row().terms_version, '2026-12-08');
  assert.match(ticked.row().terms_accepted_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal((await ticked.person('GET', '/api/auth/me')).status, 200);
  assert.equal((await ticked.person('GET', '/api/auth/me')).data.user.terms_version, '2026-12-08');

  // Not ticked (an API client, an older page): the account waits on the page.
  const later = await signUp(env, 'bob');
  assert.equal(later.row().terms_accepted_at, null);
  for (const [method, url] of [['GET', '/api/auth/me'], ['GET', '/api/me/sessions'], ['GET', '/api/me/entitlements'], ['GET', '/api/me/export']]) {
    const answer = await later.person(method, url);
    assert.deepEqual([answer.status, answer.data?.error], [403, 'terms_required'], url);
  }
  // What the page needs stays open.
  assert.ok(OPEN_ROUTES.includes('/api/auth/config'));
  assert.equal((await later.person('GET', '/api/auth/config')).status, 200);
  const asked = await later.person('GET', '/api/auth/terms');
  assert.equal(asked.status, 200);
  assert.deepEqual({ ...asked.data, user: asked.data.user.username }, {
    required: true, terms: LEGAL.TERMS_URL, privacy: LEGAL.PRIVACY_URL, version: '2026-12-08', accepted_at: null, accepted_version: null, user: 'bob',
  });
  const page = await fetch(`${env.base}${TERMS_PATH}?return=%2F`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<script type="module" src="\/suite\/terms\.js"><\/script>/);
  assert.match(html, /<div id="terms"><\/div>/);
  assert.match(page.headers.get('cache-control'), /no-store/);
  assert.equal((await fetch(`${env.base}/suite/terms.js`)).status, 200);

  // Accepting needs saying so.
  assert.deepEqual([(await later.person('POST', '/api/auth/terms', {})).status, (await later.person('POST', '/api/auth/terms', {})).data.error], [400, 'field_required']);
  const accepted = await later.person('POST', '/api/auth/terms', { accept: true });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.required, false);
  assert.equal(accepted.data.accepted_version, '2026-12-08');
  assert.equal(later.row().terms_version, '2026-12-08');
  assert.equal((await later.person('GET', '/api/auth/me')).status, 200, 'the app opens');

  // In the activity log, with its version.
  const logged = env.suite.database.get("SELECT actor_user_id, meta FROM audit_log WHERE action = 'auth.terms_accept' AND actor_user_id = ?", later.row().id);
  assert.deepEqual(JSON.parse(logged.meta), { version: '2026-12-08' });
  // Signing out stays open to whoever has yet to accept.
  const third = await signUp(env, 'cat');
  assert.equal((await third.person('POST', '/api/auth/logout', {})).status, 200);
  assert.equal((await third.person('GET', '/api/auth/terms')).status, 401);
});

test('an account from before this version (the first administrator) is never asked; the admin sees who accepted, and when', async (t) => {
  const env = await serve(t, LEGAL);
  const root = client(env.base, { cookieName: 'demo_sid' });
  const login = await root('POST', '/api/auth/login', { username: 'root', password: 'root-password-1' });
  assert.equal(login.status, 200);
  assert.equal((await root('GET', '/api/auth/me')).status, 200);
  assert.equal((await root('GET', '/api/auth/terms')).data.required, false);

  // An account the admin makes for someone is asked when that person signs in.
  const made = await root('POST', '/api/admin/users', { username: 'dee', display_name: 'Dee', password: 'a-long-password-1' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const dee = client(env.base, { cookieName: 'demo_sid' });
  await dee('POST', '/api/auth/login', { username: 'dee', password: 'a-long-password-1' });
  assert.equal((await dee('GET', '/api/auth/me')).data.error, 'terms_required');
  await dee('POST', '/api/auth/terms', { accept: true });

  const listed = (await root('GET', '/api/admin/users')).data.users.find((u) => u.username === 'dee');
  assert.equal(listed.terms_version, '2026-12-08');
  assert.match(listed.terms_accepted_at, /^\d{4}-/);
  assert.equal('terms_accepted_at' in (await root('GET', '/api/admin/users')).data.users.find((u) => u.username === 'root'), false);

  // The person's own copy of their data says it too.
  const zip = await fetch(`${env.base}/api/me/export`, { headers: { Cookie: dee.cookie } });
  assert.equal(zip.status, 200);
  const file = path.join(env.suite.config.install.dataDir, 'copy.zip');
  fs.writeFileSync(file, Buffer.from(await zip.arrayBuffer()));
  const archive = await openZip(file);
  const [user] = JSON.parse((await archive.read('data/users.json')).toString('utf8'));
  await archive.close?.();
  assert.deepEqual([user.username, user.terms_version, typeof user.terms_accepted_at], ['dee', '2026-12-08', 'string']);
  assert.equal('terms_asked' in user, false, 'whether this install asks is no part of the copy');
});

test('WorkOS: the box posted with «Create an account» is recorded at the callback; AuthKit’s own sign-up goes to the page first', async (t) => {
  await using workos = await fakeWorkos({
    accounts: {
      user_ana: { object: 'user', id: 'user_ana', email: 'ana@example.com', email_verified: true, first_name: 'Ana' },
      user_bob: { object: 'user', id: 'user_bob', email: 'bob@example.com', email_verified: true, first_name: 'Bob' },
      user_cat: { object: 'user', id: 'user_cat', email: 'cat@example.com', email_verified: true, first_name: 'Cat' },
      user_dan: { object: 'user', id: 'user_dan', email: 'dan@example.com', email_verified: true, first_name: 'Dan' },
    },
  });
  const env = await serve(t, {
    ...LEGAL, AUTH_PROVIDER: 'workos', WORKOS_API_KEY: workos.apiKey, WORKOS_CLIENT_ID: workos.clientId,
    WORKOS_AUTHKIT_DOMAIN: workos.url, WORKOS_API_URL: workos.url, SIGNUP: '', ADMIN_USER: '', ADMIN_PASSWORD: '',
  });
  assert.deepEqual((await env.call('GET', '/api/auth/config')).data.terms.version, '2026-12-08');

  /** A whole sign-in: /auth/login as asked (`init`), AuthKit, and back. → where the callback sends, and the session. */
  const signIn = async (id, search = '', init = {}) => {
    const out = await fetch(`${env.base}/auth/login${search}`, { redirect: 'manual', ...init });
    // The kit asks for the address as JSON and opens it; anything else is redirected there.
    const asked = /json/.test(init.headers?.Accept || '');
    assert.equal(out.status, asked ? 200 : 302);
    const target = asked ? (await out.json()).location : out.headers.get('location');
    const cookies = (out.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
    const code = workos.grant(id, target);
    const back = await fetch(`${env.base}/auth/callback?code=${encodeURIComponent(code)}&state=${new URL(target).searchParams.get('state')}`,
      { redirect: 'manual', headers: { Cookie: cookies } });
    const session = (back.headers.getSetCookie?.() || []).find((c) => c.startsWith('demo_sid='))?.split(';')[0];
    return { location: back.headers.get('location'), person: client(env.base, { cookieName: 'demo_sid', cookie: session }), authorize: target };
  };
  const row = (email) => env.suite.database.get('SELECT terms_asked, terms_accepted_at, terms_version FROM users WHERE email = ?', email);
  const form = (fields) => ({
    method: 'POST', body: new URLSearchParams(fields).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: env.base, 'Sec-Fetch-Site': 'same-origin' },
  });

  // The kit's sign-up, posted from this site with the box ticked: AuthKit's address back, accepted on return, and straight on.
  const kit = form({ terms: '1' });
  const ana = await signIn('user_ana', `?signup=1&return=${encodeURIComponent('/tasks/')}`, { ...kit, headers: { ...kit.headers, Accept: 'application/json' } });
  assert.equal(new URL(ana.authorize).searchParams.get('screen_hint'), 'sign-up', 'still AuthKit’s sign-up');
  assert.equal(ana.location, '/tasks/');
  assert.equal(row('ana@example.com').terms_version, '2026-12-08');
  assert.equal((await ana.person('GET', '/api/auth/me')).status, 200);
  // A form posted there and redirected works the same, for a page without the kit's script.
  const dan = await signIn('user_dan', '?signup=1', form({ terms: '1' }));
  assert.equal(dan.location, '/');
  assert.equal(row('dan@example.com').terms_version, '2026-12-08');

  // AuthKit's own «Sign up» (or a link): the page of the terms first, then where it was going.
  const bob = await signIn('user_bob', `?return=${encodeURIComponent('/notes/')}`);
  assert.equal(bob.location, `${TERMS_PATH}?return=${encodeURIComponent('/notes/')}`);
  assert.equal(row('bob@example.com').terms_accepted_at, null);
  assert.equal((await bob.person('GET', '/api/auth/me')).data.error, 'terms_required');
  await bob.person('POST', '/api/auth/terms', { accept: true });
  assert.equal(row('bob@example.com').terms_version, '2026-12-08');
  // Signing in again: nothing more to accept, nothing asked.
  assert.equal((await signIn('user_bob', `?return=${encodeURIComponent('/notes/')}`)).location, '/notes/');

  // A tick from anywhere but this site's own page is no tick: a link, or another site's form.
  const cat = await signIn('user_cat', '?signup=1&terms=1', {
    method: 'POST', body: 'terms=1',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(cat.location, TERMS_PATH);
  assert.equal(row('cat@example.com').terms_accepted_at, null);
});
