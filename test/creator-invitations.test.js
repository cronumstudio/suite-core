/**
 * Creators invited before they have an account (creator-invitations.js), over real HTTP on an app of
 * the suite, with the stand-in payment provider (its discounts) and, for the hosted suite's way, a
 * stand-in WorkOS:
 *
 * · The admin's invitation: its link, its list, «already invited», revoked, and its page's answer.
 * · Entering with a password: the account made then, its email confirmed, signed in, with the plan
 *   (a grant of the admin's that ends after the months given, or never), the creator's code and its
 *   discount made only then, and the sample data when asked; the invitation used once.
 * · An email that has an account: no second one, the invitation claimed once signed in.
 * · A code the provider already has: nothing kept, a free one offered, and the next try works.
 * · Over time: what is left of an invitation nobody used is its email's hash.
 * · WorkOS: the login made with its email verified and the app's mark, the password grant's session,
 *   a second step that only AuthKit takes, the way through Google, and the account's origin.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSuite, createApp } from '../app.js';
import { resolveAffiliates } from '../affiliates.js';
import { addMonths, codeFromName } from '../creator-invitations.js';
import { registerBillingProvider } from '../providers.js';
import { ID, SECRET, fakeBilling } from './fake-provider.js';

registerBillingProvider(fakeBilling);

const PRODUCTS = {
  'pro-monthly': { plan: 'pro', kind: 'subscription', price: 'pri_month' },
  'pro-yearly': { plan: 'pro', kind: 'subscription', price: 'pri_year' },
};
const PLANS = { free: { name: 'Free', features: {} }, pro: { name: 'Pro', features: {} } };
const PASSWORD = 'Creator-Pass-2026';
const DAY = 24 * 3600 * 1000;

/* --------------------------------- the parts --------------------------------- */

test('affiliates.invitations: off by default, true for the defaults, every setting checked', () => {
  assert.equal(resolveAffiliates(undefined).affiliates.invitations, null);
  assert.equal(resolveAffiliates({ invitations: false }).affiliates.invitations, null);
  assert.deepEqual(resolveAffiliates({ invitations: true }).affiliates.invitations,
    { days: 30, proMonths: 12, google: false, terms: null, privacy: null });
  const given = resolveAffiliates({
    invitations: {
      days: 14, proMonths: null, google: true, terms: 'https://example.com/terms/',
      privacy: { en: 'https://example.com/privacy/', es: 'https://example.com/es/privacy/' },
    },
  });
  assert.deepEqual(given.errors, []);
  assert.deepEqual(given.affiliates.invitations, {
    days: 14, proMonths: null, google: true, terms: 'https://example.com/terms/',
    privacy: { en: 'https://example.com/privacy/', es: 'https://example.com/es/privacy/' },
  });
  const wrong = resolveAffiliates({ invitations: { days: 0, proMonths: 0, google: 'yes', terms: 'http://x', privacy: { en: 'ftp://x' }, typo: 1 } });
  assert.deepEqual(wrong.errors.sort(), [
    'affiliates.invitations.days: whole days, 1 to 90',
    'affiliates.invitations.google must be true or false',
    'affiliates.invitations.privacy: an https address, or one per language ({ en, es })',
    'affiliates.invitations.proMonths: whole months, 1 to 120, or null for good',
    'affiliates.invitations.terms: an https address, or one per language ({ en, es })',
    'affiliates.invitations.typo is not a setting (a typo?)',
  ]);
  assert.deepEqual(resolveAffiliates({ invitations: 'yes' }).errors, ['affiliates.invitations: true, or an object such as { days: 30 }']);
});

test('a code from a name, as creators’ are made by hand; months that end where the month does', () => {
  assert.equal(codeFromName('María López', { type: 'percent', percent: 20 }), 'MARIA20');
  assert.equal(codeFromName('  jo  Ann ', { type: 'flat', amount: 390, currency: 'EUR' }), 'ANN');
  assert.equal(codeFromName('Al Bo', null), 'ALBO', 'the words together when none is long enough');
  assert.equal(codeFromName('Ñ', null), null, 'nothing of it can be one');
  assert.equal(codeFromName('Zoë-Élise Brontë', { type: 'percent', percent: 15 }), 'ZOE15');
  const at = (text) => Date.parse(text);
  assert.equal(new Date(addMonths(at('2026-01-31T10:00:00Z'), 1)).toISOString(), '2026-02-28T10:00:00.000Z');
  assert.equal(new Date(addMonths(at('2027-11-24T09:30:00Z'), 12)).toISOString(), '2028-11-24T09:30:00.000Z');
  assert.equal(new Date(addMonths(at('2026-08-31T00:00:00Z'), 6)).toISOString(), '2027-02-28T00:00:00.000Z');
});

/* ------------------------------------ HTTP ------------------------------------ */

/** The stand-in provider's API: its discounts, and a code it already has (TAKEN1). */
async function providerApi(t) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      calls.push([req.method, req.url, parsed]);
      const answer = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.method === 'POST' && req.url === '/discounts') {
        if (parsed.code === 'TAKEN1') return answer(409, { error: { code: 'conflict' } });
        return answer(200, { data: { id: `dsc_${parsed.code.toLowerCase()}` } });
      }
      return answer(200, { data: {} });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, url: `http://127.0.0.1:${server.address().port}` };
}

/**
 * WorkOS's users as an invitation asks for them: found by email, made (its password kept for the
 * grant), read, their metadata changed, and the password grant, with a second step when `mfa`.
 */
async function fakeWorkos(t) {
  const users = new Map();
  const calls = [];
  const state = { mfa: false, refuse: false, mailed: [] };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signedIn = (user) => {
    const { password: _, ...shown } = user;
    return { status: 200, payload: {
      user: shown, authentication_method: 'Password', refresh_token: 'rt',
      access_token: `${b64({ alg: 'none' })}.${b64({ sid: `session_${user.id}`, sub: user.id, auth_time: Math.floor(Date.now() / 1000) })}.`,
    } };
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://workos');
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, path: url.pathname, body });
      const answer = (status, payload = {}) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      const byEmail = (email) => [...users.values()].find((u) => u.email === String(email).toLowerCase());
      if (url.pathname === '/user_management/authenticate' && body?.grant_type === 'password') {
        const user = byEmail(body.email);
        if (!user || user.password !== body.password) return answer(400, { code: 'invalid_credentials' });
        if (!user.email_verified) {
          // WorkOS mails a code then, and answers with what takes it.
          state.mailed.push({ email: user.email, code: '123456' });
          return answer(400, {
            code: 'email_verification_required', message: 'Email ownership must be verified.',
            pending_authentication_token: `pat_${user.id}`, email_verification_id: 'email_verification_1', email: user.email,
          });
        }
        if (state.mfa) return answer(400, { code: 'mfa_enrollment', message: 'The user must enroll in MFA.' });
        if (state.refuse) return answer(400, { code: 'invalid_credentials' });
        return answer(200, signedIn(user).payload);
      }
      if (url.pathname === '/user_management/authenticate' && body?.grant_type === 'urn:workos:oauth:grant-type:email-verification:code') {
        const user = users.get(String(body.pending_authentication_token || '').replace(/^pat_/, ''));
        if (!user) return answer(400, { code: 'invalid_pending_authentication_token' });
        if (body.code !== '123456') return answer(400, { code: 'email_verification_code_incorrect' });
        user.email_verified = true;
        return answer(200, signedIn(user).payload);
      }
      if (url.pathname === '/user_management/users' && req.method === 'GET') {
        const found = byEmail(url.searchParams.get('email'));
        return answer(200, { object: 'list', data: found ? [found] : [], list_metadata: {} });
      }
      if (url.pathname === '/user_management/users' && req.method === 'POST') {
        if (byEmail(body.email)) return answer(422, { code: 'user_creation_error', errors: [{ code: 'email_not_available', message: 'This email is not available.' }] });
        if (body.password === 'password1234') return answer(422, { code: 'password_strength_error', message: 'The password is too common.' });
        const user = {
          object: 'user', id: `user_${crypto.randomUUID().replace(/-/g, '')}`, email: body.email.toLowerCase(),
          email_verified: Boolean(body.email_verified), first_name: body.first_name ?? null, last_name: null,
          metadata: body.metadata ?? {}, password: body.password,
        };
        users.set(user.id, user);
        return answer(201, user);
      }
      const id = decodeURIComponent(url.pathname.match(/^\/user_management\/users\/([^/]+)/)?.[1] || '');
      const user = users.get(id);
      if (!user) return answer(404, { code: 'entity_not_found' });
      if (req.method === 'GET') return answer(200, user);
      if (req.method === 'PUT') { Object.assign(user.metadata, body.metadata || {}); return answer(200, user); }
      return answer(405);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, users, calls, state };
}

async function serve(t, { invitations = true, workos = null, minPasswordLength = 10 } = {}) {
  const provider = await providerApi(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-invitations-'));
  const lines = [];
  const suite = createSuite({
    config: {
      app: { id: 'demo', name: 'Demo', languages: ['en', 'es'] },
      accounts: { minPasswordLength, ...(workos ? { adminIdentity: true, sharedIdentity: true } : {}) },
      modules: { billing: true }, plans: PLANS, defaultPlan: 'free', products: PRODUCTS,
      affiliates: { enabled: false, invitations },
    },
    env: {
      DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', BILLING_PROVIDER: ID, FAKEPAY_SECRET: SECRET, FAKEPAY_API_BASE: provider.url,
      ...(workos ? {
        AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'sk_test', WORKOS_CLIENT_ID: 'client_test',
        WORKOS_AUTHKIT_DOMAIN: workos.url, WORKOS_API_URL: workos.url, WORKOS_MCP_AUDIENCE: 'http://127.0.0.1/mcp',
      } : { ADMIN_PASSWORD: 'root-password-1' }),
    },
    log: (line) => lines.push(String(line)), exitOnError: false,
  });
  const app = createApp({ suite, version: '1.0.0', handleSignals: false, log: () => {} });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  /** A browser: its cookie kept from one answer to the next. */
  const browser = (cookie = '') => {
    const call = async (method, pathname, body, headers = {}) => {
      const res = await fetch(base + pathname, {
        method, redirect: 'manual',
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(call.cookie ? { Cookie: call.cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('demo_sid='));
      if (set) call.cookie = set.split(';')[0];
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers };
    };
    call.cookie = cookie;
    return call;
  };
  const as = (user) => browser(`demo_sid=${suite.sessions.open(user.id)}`);
  let admin = suite.accounts.byUsername('admin');
  if (!admin) admin = suite.accounts.create({ username: 'root', role: 'admin', email: 'root@example.com' });
  return { suite, base, browser, as, admin: as(admin), adminUser: admin, provider, lines };
}

const tokenOf = (link) => link.split('/i/')[1];
const grantsOf = (suite, userId) => suite.database.all(`SELECT * FROM entitlement_grants WHERE subject_type = 'user' AND subject_id = ?
  AND revoked_at IS NULL`, userId);

test('the admin’s invitation: its link, its page’s answer, and nothing made before anyone enters', async (t) => {
  const { suite, admin, browser, base, provider } = await serve(t, {
    invitations: { terms: 'https://example.com/terms/', privacy: { en: 'https://example.com/privacy/' } },
  });
  const before = suite.accounts.list().length;
  const made = await admin('POST', '/api/admin/creator-invitations', {
    name: 'María López', email: 'Maria@Example.com', pro_months: 6, campaign: 'YouTube', note: 'Met at the fair',
  });
  assert.equal(made.status, 201);
  const inv = made.data.invitation;
  assert.equal(inv.status, 'pending');
  assert.equal(inv.email, 'maria@example.com');
  assert.equal(inv.code, 'MARIA20', 'a code from the name and the offer');
  assert.deepEqual(inv.offer, { type: 'percent', percent: 20 }, 'the program’s offer by default');
  assert.deepEqual(inv.reward, { cash: 600, currency: 'EUR' }, 'and its reward');
  assert.match(inv.link, /^http:\/\/127\.0\.0\.1\/i\/ci_[A-Za-z0-9_-]{40,}$/);
  assert.equal(Date.parse(inv.expires_at) - Date.parse(inv.created_at), 30 * DAY, '30 days');
  assert.equal(suite.accounts.list().length, before, 'no account');
  assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM affiliate_codes').n, 0, 'no code');
  assert.equal(provider.calls.length, 0, 'nothing asked of the provider');
  assert.equal(suite.database.get('SELECT seed FROM creator_invitations').seed !== tokenOf(inv.link), true, 'the token itself is not kept');

  // The same link, copied again from the list while it is pending.
  const list = await admin('GET', '/api/admin/creator-invitations');
  assert.equal(list.data.invitations[0].link, inv.link);
  assert.deepEqual(list.data.defaults, {
    days: 30, pro_months: 12, offer: { type: 'percent', percent: 20 }, products: ['pro-yearly'], reward: { cash: 600, currency: 'EUR' },
    google: false, sample_data: false, password: true, uses_max: 1000,
  });
  assert.equal((await admin('GET', `/api/admin/creator-invitations/${inv.id}`)).data.invitation.link, inv.link);

  // Its page, and what the page is told.
  const visitor = browser();
  const html = await visitor('GET', `/i/${tokenOf(inv.link)}`);
  assert.equal(html.status, 200);
  assert.match(html.data, /\/suite\/creator-invitation\.js/);
  assert.equal(html.headers.get('cache-control'), 'no-store');
  assert.equal(html.headers.get('referrer-policy'), 'no-referrer');
  const page = await visitor('GET', `/api/creator-invitations/${tokenOf(inv.link)}`);
  assert.equal(page.status, 200);
  assert.deepEqual(page.data, {
    status: 'pending', name: 'María López', email: 'maria@example.com', creator: true, pro_months: 6, pro_until: null,
    expires_at: inv.expires_at, code: 'MARIA20',
    offer: { type: 'percent', percent: 20 }, reward: { cash: 600, currency: 'EUR' }, products: ['pro-yearly'], existing: null,
    signed_in: null, password: true, password_min: 10, google: false, sample_data: false,
    terms: 'https://example.com/terms/', privacy: { en: 'https://example.com/privacy/' },
  });
  assert.equal((await visitor('GET', '/api/creator-invitations/ci_nottherealtokenatallxx')).status, 404);
  assert.equal((await visitor('GET', '/api/creator-invitations/whatever')).data.error, 'invitation_not_found');
  assert.equal((await browser()('GET', '/i/a/b')).status, 404, 'only /i/<token>');

  // Someone else signed in in that browser, an account with no email: told by its name.
  assert.deepEqual((await admin('GET', `/api/creator-invitations/${tokenOf(inv.link)}`)).data.signed_in,
    { email: null, name: 'admin', same: false });
  const nameless = suite.accounts.create({ username: 'nameless' });
  assert.deepEqual((await browser(`demo_sid=${suite.sessions.open(nameless.id)}`)('GET', `/api/creator-invitations/${tokenOf(inv.link)}`)).data.signed_in,
    { email: null, name: 'nameless', same: false });

  // The admin's alone.
  const ana = suite.accounts.create({ username: 'ana', email: 'ana@example.com' });
  assert.equal((await visitor('GET', '/api/admin/creator-invitations')).status, 401);
  assert.equal((await (await browser(`demo_sid=${suite.sessions.open(ana.id)}`))('GET', '/api/admin/creator-invitations')).data.error, 'admin_only');
  assert.match(fs.readFileSync(new URL('../web/creator-invitation.html', import.meta.url), 'utf8'), /noindex/);
  void base;
});

test('the admin’s checks: every field, «already invited» unless forced, a code that is taken, and revoking', async (t) => {
  const { suite, admin, browser } = await serve(t);
  const refused = async (body) => (await admin('POST', '/api/admin/creator-invitations', body)).data;
  assert.deepEqual(await refused({ name: 'X', email: 'nope' }), { error: 'field_invalid', field: 'email' });
  assert.deepEqual(await refused({ name: 'x'.repeat(81) }), { error: 'field_too_long', field: 'name', max: 80 });
  assert.deepEqual(await refused({ creator: 'yes' }), { error: 'field_invalid', field: 'creator' });
  // Several accounts from one link: only for the plan alone, and for nobody named by their email.
  assert.deepEqual(await refused({ uses: 5 }), { error: 'field_invalid', field: 'uses' });
  assert.deepEqual(await refused({ creator: false, email: 'x@example.com', uses: 5 }), { error: 'field_invalid', field: 'uses' });
  assert.deepEqual(await refused({ creator: false, uses: 1001 }), { error: 'field_invalid', field: 'uses' });
  // Until a day: one to come, and not with months besides.
  assert.deepEqual(await refused({ pro_until: '2001-01-01T00:00:00Z' }), { error: 'field_invalid', field: 'pro_until' });
  assert.deepEqual(await refused({ pro_until: '2099-01-01T00:00:00Z', pro_months: 3 }), { error: 'field_invalid', field: 'pro_until' });
  assert.deepEqual(await refused({ pro_until: 'soon' }), { error: 'field_invalid', field: 'pro_until' });
  assert.deepEqual(await refused({ name: 'X', email: 'x@example.com', pro_months: 0 }), { error: 'field_invalid', field: 'pro_months' });
  assert.deepEqual(await refused({ name: 'X', email: 'x@example.com', days: 91 }), { error: 'field_invalid', field: 'days' });
  assert.deepEqual(await refused({ name: 'X', email: 'x@example.com', code: 'NO' }), { error: 'field_invalid', field: 'code' });
  assert.deepEqual(await refused({ name: 'X', email: 'x@example.com', reward: { cash: -1, currency: 'EUR' } }), { error: 'field_invalid', field: 'reward' });
  assert.deepEqual(await refused({ name: 'X', email: 'x@example.com', products: ['pro-weekly'] }), { error: 'field_invalid', field: 'products' });
  assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM creator_invitations').n, 0);

  // The comission raised for one creator, their Pro for good, ten days to use it.
  const first = await admin('POST', '/api/admin/creator-invitations', {
    name: 'Ada', email: 'ada@example.com', code: 'ada-10', pro_months: null, days: 10, reward: { cash: 1000, currency: 'EUR' },
  });
  assert.equal(first.status, 201);
  assert.deepEqual([first.data.invitation.code, first.data.invitation.pro_months, first.data.invitation.reward.cash], ['ADA10', null, 1000]);
  assert.equal(Date.parse(first.data.invitation.expires_at) - Date.parse(first.data.invitation.created_at), 10 * DAY);

  const again = await admin('POST', '/api/admin/creator-invitations', { name: 'Ada L.', email: 'ADA@example.com' });
  assert.equal(again.status, 409);
  assert.deepEqual([again.data.error, again.data.status], ['already_invited', 'pending']);
  const forced = await admin('POST', '/api/admin/creator-invitations', { name: 'Ada L.', email: 'ada@example.com', force: true });
  assert.equal(forced.status, 201);

  // Revoked: its link opens nothing, the page says so, and it can't be revoked twice.
  const revoked = await admin('DELETE', `/api/admin/creator-invitations/${first.data.invitation.id}`);
  assert.deepEqual([revoked.status, revoked.data.invitation.status, revoked.data.invitation.link], [200, 'revoked', undefined]);
  assert.equal((await admin('DELETE', `/api/admin/creator-invitations/${first.data.invitation.id}`)).data.error, 'invitation_not_pending');
  const token = tokenOf(first.data.invitation.link);
  assert.deepEqual((await browser()('GET', `/api/creator-invitations/${token}`)).data, { status: 'revoked' });
  const late = await browser()('POST', `/api/creator-invitations/${token}/accept`, { password: PASSWORD });
  assert.deepEqual([late.status, late.data.error], [410, 'invitation_invalid']);
  assert.equal((await admin('GET', '/api/admin/creator-invitations?status=revoked')).data.invitations.length, 1);
  assert.equal((await admin('GET', '/api/admin/creator-invitations?status=lost')).data.error, 'field_invalid');

  // A code already someone's can't be suggested: the admin is offered a free one.
  const owner = suite.accounts.create({ username: 'bea', email: 'bea@example.com' });
  await suite.affiliates.createCampaign({ email: 'bea@example.com', code: 'BEA20' }, null);
  const taken = await admin('POST', '/api/admin/creator-invitations', { name: 'Bea', email: 'bea2@example.com', code: 'BEA20' });
  assert.deepEqual([taken.status, taken.data.error, taken.data.suggestion], [409, 'affiliate_code_taken', 'BEA202']);
  // And an email whose account is a creator's already is said as such.
  const creator = await admin('POST', '/api/admin/creator-invitations', { name: 'Bea', email: 'bea@example.com' });
  assert.deepEqual([creator.data.error, creator.data.status, creator.data.code], ['already_invited', 'creator', 'BEA20']);
  void owner;
});

test('entering with a password: the account, signed in, its Pro until the months end, the code and its discount made then', async (t) => {
  const { suite, admin, browser, provider, adminUser } = await serve(t);
  const seeded = [];
  suite.sampleData = { seed: async (user, options) => { seeded.push([user.id, options]); } };
  const made = (await admin('POST', '/api/admin/creator-invitations', { name: 'María López', email: 'maria@example.com', pro_months: 12 })).data.invitation;
  const token = tokenOf(made.link);
  const page = browser();
  assert.equal((await page('GET', `/api/creator-invitations/${token}`)).data.sample_data, true, 'the box, with sample data');

  // The code checked as it is typed.
  assert.deepEqual((await page('GET', `/api/creator-invitations/${token}/code?code=maria-20`)).data,
    { valid: true, available: true, code: 'MARIA20', suggestion: null });
  assert.equal((await page('GET', `/api/creator-invitations/${token}/code?code=x`)).data.valid, false);

  // Too short a password, a code that can't be one: nothing made.
  assert.deepEqual((await page('POST', `/api/creator-invitations/${token}/accept`, { password: 'short' })).data,
    { error: 'field_too_short', field: 'password', min: 10 });
  assert.equal((await page('POST', `/api/creator-invitations/${token}/accept`, { password: PASSWORD, code: '!!' })).data.error, 'field_invalid');
  assert.equal(suite.accounts.byEmail('maria@example.com'), null);
  // Only from the app's own page.
  const forged = await page('POST', `/api/creator-invitations/${token}/accept`, { password: PASSWORD }, { Origin: 'https://evil.example' });
  assert.deepEqual([forged.status, forged.data.error], [403, 'cross_site_request']);

  const started = Date.now();
  const done = await page('POST', `/api/creator-invitations/${token}/accept`, {
    password: PASSWORD, code: 'maria2026', sample_data: true, locale: 'es',
  });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.code, 'MARIA2026');
  assert.equal(done.data.discount, true);
  assert.equal(done.data.signed_in, true);
  assert.equal(done.data.sample_data, true);
  assert.ok(page.cookie.startsWith('demo_sid='), 'signed in');

  const user = suite.accounts.byEmail('maria@example.com');
  assert.equal(user.display_name, 'María López');
  assert.ok(user.email_verified_at, 'its email confirmed: the link reached it');
  assert.equal(user.locale, 'es');
  assert.equal((await page('GET', '/api/auth/me')).data.user.id, user.id);
  // The plan: the admin's, ending 12 calendar months after.
  const [grant] = grantsOf(suite, user.id);
  assert.deepEqual([grant.plan, grant.source, grant.external_ref], ['pro', 'admin', `creator-invitation:${made.id}`]);
  assert.equal(grant.ends_at, new Date(addMonths(Date.parse(grant.starts_at), 12)).toISOString());
  assert.ok(Date.parse(grant.starts_at) >= started - 1000);
  assert.equal(suite.entitlements.of(user).plan.id, 'pro');
  // The creator's code, its terms the invitation's, and its discount at the provider made now.
  const code = suite.affiliates.codeOf('MARIA2026');
  assert.deepEqual([code.kind, code.user_id, code.cash, code.products], ['creator', user.id, 600, ['pro-yearly']]);
  assert.deepEqual(provider.calls.filter(([method, url]) => method === 'POST' && url === '/discounts').map(([, , body]) => body.code), ['MARIA2026']);
  assert.deepEqual(seeded, [[user.id, { locale: 'es' }]]);

  // Used: its page says so, no one enters again, and the admin sees whose it is.
  assert.deepEqual((await browser()('GET', `/api/creator-invitations/${token}`)).data, { status: 'claimed' });
  const twice = await browser()('POST', `/api/creator-invitations/${token}/accept`, { password: PASSWORD });
  assert.deepEqual([twice.status, twice.data.error], [409, 'invitation_claimed']);
  const listed = (await admin('GET', '/api/admin/creator-invitations')).data.invitations[0];
  assert.deepEqual([listed.status, listed.name, listed.email, listed.user.email, listed.code_id, listed.code], ['claimed', null, null, 'maria@example.com', code.id, 'MARIA2026'],
    'the name and the email are the account’s now');
  const row = suite.database.get('SELECT * FROM creator_invitations WHERE id = ?', made.id);
  assert.deepEqual([row.name, row.email], [null, null]);
  const audit = JSON.stringify(suite.audit.list({ limit: 50 }));
  assert.match(audit, /admin\.creator_invitation\.create/);
  assert.match(audit, /creator_invitation\.claim/);
  assert.ok(!audit.includes(PASSWORD), 'the password nowhere');

  // An account that goes no longer has the invitation naming it.
  suite.accounts.remove(user.id);
  assert.equal(suite.database.get('SELECT user_id FROM creator_invitations WHERE id = ?', made.id).user_id, null);
  void adminUser;
});

test('Pro for good, and an email that has an account: no second one, the invitation added once signed in', async (t) => {
  const { suite, admin, browser, as } = await serve(t);
  const ana = suite.accounts.create({ username: 'ana', email: 'ana@example.com', password: 'ana-password-1' });
  const made = (await admin('POST', '/api/admin/creator-invitations', { name: 'Ana', email: 'ana@example.com', pro_months: null, force: true })).data.invitation;
  const token = tokenOf(made.link);
  const visitor = browser();
  const page = (await visitor('GET', `/api/creator-invitations/${token}`)).data;
  assert.equal(page.existing, 'here');
  const refused = await visitor('POST', `/api/creator-invitations/${token}/accept`, { password: PASSWORD });
  assert.deepEqual([refused.status, refused.data.error], [409, 'account_exists']);
  assert.equal(suite.accounts.list().filter((u) => u.email === 'ana@example.com').length, 1);
  // Signed out, claiming asks for a session.
  assert.equal((await visitor('POST', `/api/creator-invitations/${token}/claim`, {})).status, 401);

  const signed = as(ana);
  assert.deepEqual((await signed('GET', `/api/creator-invitations/${token}`)).data.signed_in, { email: 'ana@example.com', name: 'ana', same: true });
  const claimed = await signed('POST', `/api/creator-invitations/${token}/claim`, { code: 'ANA20' });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.data));
  assert.deepEqual([claimed.data.code, claimed.data.plan_ends, claimed.data.signed_in], ['ANA20', null, true]);
  const [grant] = grantsOf(suite, ana.id);
  assert.equal(grant.ends_at, null, 'for good');
  assert.equal((await signed('POST', `/api/creator-invitations/${token}/claim`, { code: 'ANA21' })).data.error, 'invitation_claimed');
});

test('a code the provider already has: nothing kept, a free one offered, and the next try, signed in, works', async (t) => {
  const { suite, admin, browser } = await serve(t);
  const made = (await admin('POST', '/api/admin/creator-invitations', { name: 'Taken', email: 'taken@example.com', code: 'TAKEN1' })).data.invitation;
  const token = tokenOf(made.link);
  const page = browser();
  const first = await page('POST', `/api/creator-invitations/${token}/accept`, { password: PASSWORD });
  assert.deepEqual([first.status, first.data.error, first.data.suggestion], [409, 'discount_code_taken', 'TAKEN12']);
  const user = suite.accounts.byEmail('taken@example.com');
  assert.ok(user, 'the account was made, and they are signed in');
  assert.equal(grantsOf(suite, user.id).length, 0, 'no plan yet');
  assert.equal(suite.affiliates.codeOf('TAKEN1'), null, 'no code');
  assert.equal(suite.database.get('SELECT status FROM creator_invitations WHERE id = ?', made.id).status, 'pending');
  // The page, as they are now: signed in, it claims with the code offered.
  assert.deepEqual((await page('GET', `/api/creator-invitations/${token}`)).data.signed_in, { email: 'taken@example.com', name: 'Taken', same: true });
  const second = await page('POST', `/api/creator-invitations/${token}/claim`, { code: 'TAKEN12' });
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal(grantsOf(suite, user.id).length, 1);
});

test('over time: an invitation nobody used keeps only its email’s hash, and «already invited» stays', async (t) => {
  const { suite, admin, browser } = await serve(t);
  const made = (await admin('POST', '/api/admin/creator-invitations', { name: 'Late', email: 'late@example.com', campaign: 'Blog', note: 'x' })).data.invitation;
  const kept = (await admin('POST', '/api/admin/creator-invitations', { name: 'Soon', email: 'soon@example.com' })).data.invitation;
  const past = new Date(Date.now() - 1000).toISOString();
  suite.database.run('UPDATE creator_invitations SET expires_at = ? WHERE id = ?', past, made.id);
  // Expired before the sweep comes: the page and the admin already say so.
  assert.deepEqual((await browser()('GET', `/api/creator-invitations/${tokenOf(made.link)}`)).data, { status: 'expired' });
  assert.equal((await browser()('POST', `/api/creator-invitations/${tokenOf(made.link)}/accept`, { password: PASSWORD })).data.error, 'invitation_expired');
  assert.equal(suite.creatorInvitations.sweep(), 1);
  const row = suite.database.get('SELECT * FROM creator_invitations WHERE id = ?', made.id);
  const left = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
  assert.deepEqual(Object.keys(left).sort(), ['created_at', 'created_by', 'creator', 'email_hash', 'ended_at', 'expires_at', 'id', 'status', 'used', 'uses']);
  assert.equal(row.status, 'expired');
  assert.ok(!JSON.stringify(row).includes('late'), 'nothing of the person');
  assert.equal(suite.database.get('SELECT status FROM creator_invitations WHERE id = ?', kept.id).status, 'pending', 'the other stays');
  assert.equal(suite.creatorInvitations.sweep(), 0, 'once');
  // Its link opens nothing now, and the admin still learns the email was invited.
  assert.equal((await browser()('GET', `/api/creator-invitations/${tokenOf(made.link)}`)).status, 404);
  const again = await admin('POST', '/api/admin/creator-invitations', { name: 'Late', email: 'late@example.com' });
  assert.deepEqual([again.data.error, again.data.status], ['already_invited', 'expired']);
  const listed = (await admin('GET', '/api/admin/creator-invitations')).data.invitations.find((inv) => inv.id === made.id);
  assert.deepEqual([listed.status, listed.ended, listed.name, listed.email, listed.link], ['expired', true, null, null, undefined]);
});

test('off without affiliates.invitations: no routes, no page, no tab', async (t) => {
  const { suite, browser } = await serve(t, { invitations: false });
  assert.equal(suite.creatorInvitations, null);
  assert.equal((await browser()('GET', '/api/creator-invitations/ci_abcdefghijklmnopqrstuvwxyz')).status, 404);
  assert.equal((await browser()('GET', '/i/ci_abcdefghijklmnopqrstuvwxyz')).status, 404);
  assert.equal((await browser()('GET', '/api/auth/config')).data.app.modules.creator_invitations, undefined);
});

test('a link for many with the plan alone: no name, no email, a month of Pro for each account, once each', async (t) => {
  const { suite, admin, browser, as, provider } = await serve(t);
  const made = await admin('POST', '/api/admin/creator-invitations', { name: 'Reddit r/mcp', creator: false, pro_months: 1, uses: 2 });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const inv = made.data.invitation;
  assert.deepEqual([inv.creator, inv.code, inv.offer, inv.uses, inv.used, inv.email], [false, null, null, 2, 0, null]);
  const token = tokenOf(inv.link);
  const page = (await browser()('GET', `/api/creator-invitations/${token}`)).data;
  assert.deepEqual([page.name, page.email, page.creator, page.pro_months, page.code, page.existing], [null, null, false, 1, undefined, null],
    'its label is the admin’s, never a greeting; no code to choose');
  assert.equal((await browser()('GET', `/api/creator-invitations/${token}/code?code=ABC`)).status, 404, 'no code for the plan alone');

  // Whoever enters writes their email: an account made with it, not taken as confirmed.
  const first = browser();
  assert.deepEqual((await first('POST', `/api/creator-invitations/${token}/accept`, { password: PASSWORD })).data,
    { error: 'field_required', field: 'email' });
  const one = await first('POST', `/api/creator-invitations/${token}/accept`, { password: PASSWORD, email: 'Reader.One@example.com' });
  assert.equal(one.status, 200, JSON.stringify(one.data));
  assert.deepEqual([one.data.code, one.data.discount, one.data.signed_in], [null, false, true]);
  const reader = suite.accounts.byEmail('reader.one@example.com');
  assert.equal(reader.email_verified_at, null, 'an email the link didn’t name is not taken as confirmed');
  const [grant] = grantsOf(suite, reader.id);
  assert.equal(grant.ends_at, new Date(addMonths(Date.parse(grant.starts_at), 1)).toISOString(), 'a month');
  assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM affiliate_codes').n, 0, 'no code');
  assert.deepEqual(provider.calls, [], 'nothing at the provider');
  // The same account can't take it twice; an email with an account is told to sign in.
  assert.equal((await first('POST', `/api/creator-invitations/${token}/claim`, {})).data.error, 'invitation_claimed');
  assert.equal((await browser()('POST', `/api/creator-invitations/${token}/accept`, { password: PASSWORD, email: 'reader.one@example.com' })).data.error,
    'account_exists');
  // Still pending, one use left; the sign-in elsewhere carries the email they wrote.
  const listed = (await admin('GET', '/api/admin/creator-invitations')).data.invitations[0];
  assert.deepEqual([listed.status, listed.used, listed.name], ['pending', 1, 'Reddit r/mcp'], 'the label stays on a link for many');
  assert.equal((await browser()('GET', `/api/creator-invitations/${token}/sign-in?email=reader.one@example.com`)).status, 404,
    'no provider to sign in at, with passwords here');

  // An account someone already has takes the second use; then the link is used up.
  const ben = suite.accounts.create({ username: 'ben', email: 'ben@example.com' });
  assert.equal((await as(ben)('POST', `/api/creator-invitations/${token}/claim`, {})).status, 200);
  const full = await browser()('POST', `/api/creator-invitations/${token}/accept`, { password: PASSWORD, email: 'third@example.com' });
  assert.deepEqual([full.status, full.data.error], [409, 'invitation_claimed']);
  assert.deepEqual((await browser()('GET', `/api/creator-invitations/${token}`)).data, { status: 'claimed' });
  const detail = (await admin('GET', `/api/admin/creator-invitations/${inv.id}`)).data.invitation;
  assert.deepEqual([detail.status, detail.used, detail.accounts.map((a) => a.user.email).sort()],
    ['claimed', 2, ['ben@example.com', 'reader.one@example.com']]);
  // An account that goes is no longer listed among them.
  suite.accounts.remove(ben.id);
  assert.deepEqual((await admin('GET', `/api/admin/creator-invitations/${inv.id}`)).data.invitation.accounts.map((a) => a.user.email),
    ['reader.one@example.com']);
});

test('Pro until a day, for a friend by name and email: the grant ends that day, and the page says so', async (t) => {
  const { suite, admin, browser } = await serve(t);
  const until = new Date(Date.now() + 40 * DAY).toISOString();
  const inv = (await admin('POST', '/api/admin/creator-invitations', { name: 'Ana', email: 'ana@example.com', creator: false, pro_until: until })).data.invitation;
  assert.deepEqual([inv.pro_until, inv.pro_months], [until, null]);
  const page = browser();
  const answer = (await page('GET', `/api/creator-invitations/${tokenOf(inv.link)}`)).data;
  assert.deepEqual([answer.name, answer.email, answer.pro_until, answer.pro_months], ['Ana', 'ana@example.com', until, null]);
  const done = await page('POST', `/api/creator-invitations/${tokenOf(inv.link)}/accept`, { password: PASSWORD });
  assert.equal(done.data.plan_ends, until);
  const user = suite.accounts.byEmail('ana@example.com');
  assert.ok(user.email_verified_at, 'the email the link named is confirmed');
  assert.equal(grantsOf(suite, user.id)[0].ends_at, until);
  // A day that has come: the invitation is over too, whatever its own days say.
  const late = (await admin('POST', '/api/admin/creator-invitations', { creator: false, pro_until: new Date(Date.now() + DAY).toISOString() })).data.invitation;
  suite.database.run('UPDATE creator_invitations SET pro_until = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), late.id);
  assert.deepEqual((await browser()('GET', `/api/creator-invitations/${tokenOf(late.link)}`)).data, { status: 'expired' });
  assert.equal((await browser()('POST', `/api/creator-invitations/${tokenOf(late.link)}/accept`, { password: PASSWORD, email: 'x@example.com' })).data.error,
    'invitation_expired');
});

/* ----------------------------------- WorkOS ----------------------------------- */

test('WorkOS: the login made with its email verified and the app’s mark, the session the password grant opens', async (t) => {
  const workos = await fakeWorkos(t);
  const { suite, admin, browser } = await serve(t, { workos });
  // Where accounts come from, as origins.js keeps it where the install has it: what each sign-up says of its own.
  const arrived = [];
  suite.origins = { pack: (from) => JSON.stringify(from), arriving: (req, packed) => arrived.push(JSON.parse(packed)) };
  assert.equal((await browser()('GET', '/api/auth/config')).data.app.modules.creator_invitations, true);
  const made = (await admin('POST', '/api/admin/creator-invitations', { name: 'Leo Vidal', email: 'leo@example.com' })).data.invitation;
  const token = tokenOf(made.link);
  const page = browser();
  assert.equal((await page('GET', `/api/creator-invitations/${token}`)).data.existing, null);
  // WorkOS's own rule for passwords: its reason said, nothing kept.
  const weak = await page('POST', `/api/creator-invitations/${token}/accept`, { password: 'password1234' });
  assert.deepEqual([weak.status, weak.data.error, weak.data.detail], [400, 'password_rejected', 'The password is too common.']);
  assert.equal(suite.accounts.byEmail('leo@example.com'), null);

  const done = await page('POST', `/api/creator-invitations/${token}/accept`, { password: PASSWORD, locale: 'es' });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.signed_in, true);
  const [login] = [...workos.users.values()];
  assert.deepEqual([login.email, login.email_verified, login.first_name, login.metadata], ['leo@example.com', true, 'Leo Vidal', { app_demo: 'Demo' }]);
  const user = suite.accounts.byEmail('leo@example.com');
  assert.deepEqual(suite.accounts.identitiesOf(user.id).map((i) => [i.provider, i.subject]), [['workos', login.id]]);
  assert.equal(user.display_name, 'Leo Vidal');
  assert.equal(user.locale, 'es');
  assert.equal((await page('GET', '/api/auth/me')).data.user.id, user.id, 'signed in');
  assert.equal(suite.database.get('SELECT idp_session_id FROM sessions WHERE user_id = ?', user.id)?.idp_session_id, `session_${login.id}`,
    'the WorkOS session, to close it there too');
  assert.equal(suite.affiliates.codeOf('LEO20').user_id, user.id);
  // Where it came from, for the figures by origin.
  // Said for each request that went on to make the login: the refused password’s too, which made no account.
  assert.deepEqual(arrived, [{ src: 'creator' }, { src: 'creator' }], 'a creator’s invitation, as the account’s origin');
});

test('WorkOS: an email they wrote is confirmed on the page with the mailed code, not on AuthKit’s, and opens their own account', async (t) => {
  const workos = await fakeWorkos(t);
  const { suite, admin, browser } = await serve(t, { workos });
  const made = (await admin('POST', '/api/admin/creator-invitations', { name: 'Reddit', creator: false, pro_months: 1 })).data.invitation;
  const token = tokenOf(made.link);
  const page = browser();
  const done = await page('POST', `/api/creator-invitations/${token}/accept`, { password: PASSWORD, email: 'Ana@Example.com' });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.signed_in, false);
  assert.equal(done.data.confirm.email, 'ana@example.com');
  assert.match(done.data.confirm.id, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(workos.state.mailed.map((m) => m.email), ['ana@example.com'], 'WorkOS mailed the code');
  assert.equal(page.cookie, '', 'no session before the code');
  const [login] = [...workos.users.values()];
  assert.equal(login.email_verified, false);
  const user = suite.accounts.byIdentity('workos', login.id);
  assert.equal(user.email, null, 'an email nobody confirmed is not kept yet');
  assert.equal(suite.entitlements.of(user).plan.id, 'pro', 'its Pro, already');

  // Wrong: said, and another try. Another link's, a made-up id, or none: gone.
  const confirm = (body, who = page, at = token) => who('POST', `/api/creator-invitations/${at}/confirm`, body);
  assert.deepEqual([(await confirm({ id: done.data.confirm.id, code: '000000' })).data.error], ['confirm_code_wrong']);
  assert.equal((await confirm({ id: done.data.confirm.id, code: 'abc' })).data.error, 'confirm_code_wrong');
  assert.equal((await confirm({ id: 'nope', code: '123456' })).status, 410);
  assert.equal((await confirm({ id: done.data.confirm.id, code: '123456' }, page, 'ci_other')).status, 410);

  // Someone else signed in in this browser does not matter: the code opens the new account.
  const it = suite.accounts.create({ username: 'it', email: 'it@example.com', role: 'admin' });
  page.cookie = `demo_sid=${suite.sessions.open(it.id)}`;
  const right = await confirm({ id: done.data.confirm.id, code: '123 456' });
  assert.equal(right.status, 200, JSON.stringify(right.data));
  assert.equal(right.data.signed_in, true);
  assert.equal((await page('GET', '/api/auth/me')).data.user.id, user.id, 'signed in as the new account');
  assert.equal(suite.accounts.byId(user.id).email, 'ana@example.com', 'the email kept, now confirmed');
  assert.equal(login.email_verified, true);
  assert.equal((await confirm({ id: done.data.confirm.id, code: '123456' })).status, 410, 'once');

  // Five wrong codes and it goes: signing in from the start mails a new one.
  const many = (await admin('POST', '/api/admin/creator-invitations', { creator: false, pro_months: 1, uses: 3 })).data.invitation;
  const other = browser();
  const next = (await other('POST', `/api/creator-invitations/${tokenOf(many.link)}/accept`, { password: PASSWORD, email: 'bo@example.com' })).data;
  for (let i = 0; i < 5; i += 1) assert.equal((await confirm({ id: next.confirm.id, code: '111111' }, other, tokenOf(many.link))).status, 400);
  assert.equal((await confirm({ id: next.confirm.id, code: '123456' }, other, tokenOf(many.link))).status, 410);
});

test('WorkOS: an email with a login elsewhere signs in there and claims on the way back; Google straight; a second step left to AuthKit', async (t) => {
  const workos = await fakeWorkos(t);
  const { suite, admin, browser, base } = await serve(t, { workos, invitations: { google: true } });
  workos.users.set('user_other', {
    object: 'user', id: 'user_other', email: 'eve@example.com', email_verified: true, first_name: 'Eve', metadata: { app_acme: 'Acme' }, password: 'x',
  });
  const eve = (await admin('POST', '/api/admin/creator-invitations', { name: 'Eve', email: 'eve@example.com' })).data.invitation;
  const page = browser();
  const answer = (await page('GET', `/api/creator-invitations/${tokenOf(eve.link)}`)).data;
  assert.deepEqual([answer.existing, answer.google], ['provider', true]);
  assert.equal((await page('POST', `/api/creator-invitations/${tokenOf(eve.link)}/accept`, { password: PASSWORD })).data.error, 'account_exists');
  // The way there and back: AuthKit with their email written, or Google; back at the page, which claims.
  const there = (await page('GET', `/api/creator-invitations/${tokenOf(eve.link)}/sign-in?code=eve30&sample=1`)).data.url;
  const url = new URL(there, base);
  assert.equal(url.pathname, '/auth/login');
  assert.deepEqual([url.searchParams.get('hint'), url.searchParams.get('src'), url.searchParams.get('provider')], ['eve@example.com', 'creator', null]);
  assert.equal(url.searchParams.get('return'), `/i/${tokenOf(eve.link)}?claim=1&code=EVE30&sample=1`);
  const google = new URL((await page('GET', `/api/creator-invitations/${tokenOf(eve.link)}/sign-in?provider=google`)).data.url, base);
  assert.equal(google.searchParams.get('provider'), 'google');
  const authorize = await page('GET', `${google.pathname}${google.search}`);
  assert.equal(authorize.status, 302);
  const at = new URL(authorize.headers.get('location'));
  assert.deepEqual([at.pathname, at.searchParams.get('provider'), at.searchParams.get('login_hint')],
    ['/user_management/authorize', 'GoogleOAuth', 'eve@example.com']);
  // An unknown provider is AuthKit's own page; a hint that is no email, none.
  const plain = new URL((await page('GET', '/auth/login?provider=myspace&hint=nope')).headers.get('location'));
  assert.deepEqual([plain.searchParams.get('provider'), plain.searchParams.get('login_hint')], ['authkit', null]);

  // A second step WorkOS wants: the account and the invitation all the same, and AuthKit's page for the rest.
  workos.state.mfa = true;
  const max = (await admin('POST', '/api/admin/creator-invitations', { name: 'Max', email: 'max@example.com' })).data.invitation;
  const other = browser();
  const done = await other('POST', `/api/creator-invitations/${tokenOf(max.link)}/accept`, { password: PASSWORD });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.signed_in, false);
  assert.equal(other.cookie, '', 'no session here');
  const user = suite.accounts.byEmail('max@example.com');
  assert.ok(user);
  assert.equal(suite.entitlements.of(user).plan.id, 'pro');
  assert.equal(suite.database.get('SELECT status FROM creator_invitations WHERE id = ?', max.id).status, 'claimed');

  // A grant WorkOS refuses right after making the login: the same, with no session here.
  workos.state.mfa = false;
  workos.state.refuse = true;
  const zoe = (await admin('POST', '/api/admin/creator-invitations', { name: 'Zoe', email: 'zoe@example.com' })).data.invitation;
  const third = browser();
  const refused = await third('POST', `/api/creator-invitations/${tokenOf(zoe.link)}/accept`, { password: PASSWORD });
  assert.deepEqual([refused.status, refused.data.signed_in, third.cookie], [200, false, '']);
  assert.equal(suite.entitlements.of(suite.accounts.byEmail('zoe@example.com')).plan.id, 'pro');


  // A link for many: the email they write is WorkOS's to confirm, with a code on AuthKit's page.
  workos.state.refuse = false;
  const many = (await admin('POST', '/api/admin/creator-invitations', { creator: false, pro_months: 1, uses: 10 })).data.invitation;
  const reader = browser();
  const read = await reader('POST', `/api/creator-invitations/${tokenOf(many.link)}/accept`, { password: PASSWORD, email: 'reader@example.com' });
  assert.deepEqual([read.status, read.data.signed_in], [200, false], JSON.stringify(read.data));
  const login = [...workos.users.values()].find((u) => u.email === 'reader@example.com');
  assert.equal(login.email_verified, false, 'not taken as confirmed');
  const account = suite.accounts.identitiesOf(suite.database.get("SELECT user_id FROM user_identities WHERE subject = ?", login.id).user_id);
  assert.equal(account.length, 1, 'the account here, linked, waiting for its email to be confirmed');
  assert.equal(suite.database.get('SELECT used FROM creator_invitations WHERE id = ?', many.id).used, 1);
});
