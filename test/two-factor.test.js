/**
 * Two-step verification: the TOTP arithmetic against RFC 6238, the service
 * with a clock of its own, and the whole flow over HTTP on an app made of the
 * suite (sign-in, a new password from a link, the consent screen of the
 * built-in OAuth, Settings and the admin).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  totp, matchStep, base32Encode, base32Decode, createTwoFactor,
} from '../two-factor.js';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { createAccounts } from '../accounts.js';
import { createRateLimiter } from '../rate-limit.js';
import { hmac } from '../crypto.js';
import { createSuite, createApp } from '../app.js';

/* ------------------------------- arithmetic ------------------------------- */

test('TOTP gives the codes of RFC 6238 (SHA-1), and base32 goes both ways', () => {
  const secret = Buffer.from('12345678901234567890');
  // Appendix B: time → the 8-digit code; apps show its last six.
  const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [seconds, code] of vectors) {
    assert.equal(totp(secret, Math.floor(seconds / 30), 8), code, `T=${seconds}`);
    assert.equal(totp(secret, Math.floor(seconds / 30)), code.slice(2));
  }
  assert.equal(base32Encode(secret), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode('gezd gnbv-gy3t qojq gezdgnbvgy3tqojq'), secret, 'spaces, dashes and case are forgiven');
  assert.throws(() => base32Decode('GEZD1'), /not base32/);

  const now = 1111111111 * 1000;
  assert.equal(matchStep(secret, '050471', now), Math.floor(1111111111 / 30));
  assert.equal(matchStep(secret, '081804', now), Math.floor(1111111109 / 30), 'a step either side: clocks drift');
  assert.equal(matchStep(secret, '050 471', now), Math.floor(1111111111 / 30), 'a space in the middle, as apps show it');
  assert.equal(matchStep(secret, '287082', now), null, 'an old code is not');
  assert.equal(matchStep(secret, '05047', now), null);
  assert.equal(matchStep(null, '050471', now), null, 'no secret, no match');
});

/* -------------------------------- the service ------------------------------ */

function service({ secret = 'first-session-secret' } = {}) {
  const database = openDatabase({ path: ':memory:' });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const clock = { now: Date.UTC(2026, 8, 29, 12, 0, 10) };
  const accounts = createAccounts({ database, minPasswordLength: 8, clock: () => clock.now });
  const limiter = createRateLimiter({ database, secret: 'limits', clock: () => clock.now });
  const make = (sessionSecret) => createTwoFactor({
    database, sign: (value) => hmac(sessionSecret, `sign|${value}`), issuer: 'Demo & Co', limiter, clock: () => clock.now,
  });
  return { database, clock, accounts, limiter, twoFactor: make(secret), make };
}
const codeAt = (secret, ms, offset = 0) => totp(base32Decode(secret), Math.floor(ms / 30000) + offset);

test('setting it up: a secret kept encrypted, on only after a first code, ten recovery codes', () => {
  const { database, clock, accounts, twoFactor } = service();
  const ada = accounts.create({ username: 'ada', password: 'ada-password' });

  assert.deepEqual(twoFactor.status(ada.id), { enabled: false, enabled_at: null, recovery_codes_left: 0 });
  const { secret, uri } = twoFactor.begin(ada);
  assert.match(secret, /^[A-Z2-7]{32}$/, '160 bits, as RFC 4226 recommends');
  assert.equal(uri, `otpauth://totp/Demo%20%26%20Co%3Aada?secret=${secret}&issuer=Demo%20%26%20Co&algorithm=SHA1&digits=6&period=30`);
  const stored = database.get('SELECT secret FROM user_two_factor WHERE user_id = ?', ada.id).secret;
  assert.match(stored, /^v1:/);
  assert.ok(!stored.includes(secret), 'the database never holds the secret in clear');
  assert.equal(twoFactor.isEnabled(ada.id), false, 'not on until a code confirms the app has it');
  assert.equal(twoFactor.verify(ada.id, codeAt(secret, clock.now)), null, 'and it does not ask for codes yet');

  // Starting again replaces the secret.
  const again = twoFactor.begin(ada);
  assert.notEqual(again.secret, secret);
  assert.throws(() => twoFactor.enable(ada.id, codeAt(secret, clock.now)), { status: 400, code: 'code_invalid' },
    'a code from the first secret no longer works');
  const codes = twoFactor.enable(ada.id, codeAt(again.secret, clock.now));
  assert.equal(codes.length, 10);
  for (const code of codes) assert.match(code, /^[a-z2-7]{4}-[a-z2-7]{4}$/);
  assert.equal(new Set(codes).size, 10);
  assert.equal(twoFactor.isEnabled(ada.id), true);
  assert.ok(accounts.byId(ada.id).two_factor_at, 'the account says so (publicUser → two_factor)');
  assert.equal(accounts.publicUser(accounts.byId(ada.id)).two_factor, true);
  assert.equal(twoFactor.status(ada.id).recovery_codes_left, 10);
  assert.ok(database.all('SELECT code_hash FROM user_recovery_codes').every((row) => !codes.includes(row.code_hash)),
    'recovery codes are kept as hashes');
  assert.throws(() => twoFactor.begin(ada), { status: 409, code: 'two_factor_enabled' });
  assert.throws(() => twoFactor.enable(ada.id, '123456'), { status: 409, code: 'two_factor_enabled' });

  const bob = accounts.create({ username: 'bob', password: 'bob-password' });
  assert.throws(() => twoFactor.enable(bob.id, '123456'), { status: 409, code: 'two_factor_not_started' });
  assert.throws(() => twoFactor.regenerateRecoveryCodes(bob.id), { status: 409, code: 'two_factor_off' });
});

test('signing in: each code once, a step either side, recovery codes once; off removes it all', () => {
  const { database, clock, accounts, twoFactor } = service();
  const ada = accounts.create({ username: 'ada', password: 'ada-password' });
  const { secret } = twoFactor.begin(ada);
  const codes = twoFactor.enable(ada.id, codeAt(secret, clock.now));

  assert.equal(twoFactor.verify(ada.id, codeAt(secret, clock.now)), null, 'the code that turned it on is spent');
  assert.equal(twoFactor.verify(ada.id, codeAt(secret, clock.now, 1)), 'totp', 'the next one works (a fast clock)');
  assert.equal(twoFactor.verify(ada.id, codeAt(secret, clock.now, 1)), null, 'once');
  clock.now += 60_000;
  assert.equal(twoFactor.verify(ada.id, codeAt(secret, clock.now, -2)), null, 'two steps back is too old');
  assert.equal(twoFactor.verify(ada.id, codeAt(secret, clock.now)), 'totp');
  assert.equal(twoFactor.verify(ada.id, codeAt(secret, clock.now, -1)), null, 'nor an older one after a newer');

  assert.equal(twoFactor.verify(ada.id, codes[0]), 'recovery');
  assert.equal(twoFactor.verify(ada.id, codes[0]), null, 'a recovery code works once');
  assert.equal(twoFactor.verify(ada.id, codes[1].toUpperCase().replace('-', ' ')), 'recovery', 'however it is typed');
  assert.equal(twoFactor.verify(ada.id, 'aaaa-aaaa'), null);
  assert.equal(twoFactor.status(ada.id).recovery_codes_left, 8);

  const fresh = twoFactor.regenerateRecoveryCodes(ada.id);
  assert.equal(twoFactor.status(ada.id).recovery_codes_left, 10);
  assert.equal(twoFactor.verify(ada.id, codes[2]), null, 'new codes: the old ones stop working');
  assert.equal(twoFactor.verify(ada.id, fresh[0]), 'recovery');

  assert.equal(twoFactor.disable(ada.id), true);
  assert.equal(twoFactor.disable(ada.id), false, 'nothing left to turn off');
  assert.equal(twoFactor.isEnabled(ada.id), false);
  assert.equal(accounts.byId(ada.id).two_factor_at, null);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM user_recovery_codes').n, 0);
  assert.equal(twoFactor.verify(ada.id, fresh[1]), null);

  // Removing the account takes everything with it.
  twoFactor.begin(ada);
  accounts.remove(ada.id);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM user_two_factor').n, 0);
});

test('a new session secret: the app’s codes can no longer be read, the recovery codes still work', () => {
  const { clock, accounts, twoFactor, make } = service();
  const ada = accounts.create({ username: 'ada', password: 'ada-password' });
  const { secret } = twoFactor.begin(ada);
  const codes = twoFactor.enable(ada.id, codeAt(secret, clock.now));

  const after = make('another-session-secret');
  clock.now += 30_000;
  assert.equal(after.verify(ada.id, codeAt(secret, clock.now)), null, 'no error: just no match');
  assert.equal(after.verify(ada.id, codes[0]), 'recovery');
  assert.throws(() => after.readChallenge(twoFactor.challengeFor(ada.id)), { code: 'challenge_invalid' });

  // Half set up when the secret changed: it has to start again.
  const bob = accounts.create({ username: 'bob', password: 'bob-password' });
  const pending = twoFactor.begin(bob);
  assert.throws(() => after.enable(bob.id, codeAt(pending.secret, clock.now)), { code: 'two_factor_not_started' });
});

test('the challenge between the steps: signed, five minutes', () => {
  const { clock, accounts, twoFactor } = service();
  const ada = accounts.create({ username: 'ada', password: 'ada-password' });
  const challenge = twoFactor.challengeFor(ada.id);
  assert.equal(twoFactor.readChallenge(challenge), ada.id);
  const [, expires, signature] = challenge.split('.');
  assert.throws(() => twoFactor.readChallenge(`2.${expires}.${signature}`), { status: 400, code: 'challenge_invalid' },
    'another account with the same signature');
  assert.throws(() => twoFactor.readChallenge(`${ada.id}.${Number(expires) + 60_000}.${signature}`), { code: 'challenge_invalid' },
    'nor longer');
  for (const bad of [undefined, '', 'x', '1.2', `${ada.id}.${expires}.`]) {
    assert.throws(() => twoFactor.readChallenge(bad), { code: 'challenge_invalid' });
  }
  clock.now += 5 * 60_000 + 1;
  assert.throws(() => twoFactor.readChallenge(challenge), { status: 410, code: 'challenge_expired' });
});

test('the brake: five wrong codes and the account waits, even with the right one', () => {
  const { clock, accounts, twoFactor } = service();
  const ada = accounts.create({ username: 'ada', password: 'ada-password' });
  const bob = accounts.create({ username: 'bob', password: 'bob-password' });
  const { secret } = twoFactor.begin(ada);
  twoFactor.enable(ada.id, codeAt(secret, clock.now));
  const req = { headers: {}, socket: { remoteAddress: '203.0.113.9' } };

  clock.now += 30_000;
  const right = codeAt(secret, clock.now);
  const wrong = String((Number(right) + 500_000) % 1_000_000).padStart(6, '0');
  for (let i = 0; i < 5; i++) {
    assert.throws(() => twoFactor.pass(req, ada.id, wrong), { status: 400, code: 'code_invalid' });
  }
  assert.throws(() => twoFactor.pass(req, ada.id, right), (err) => err.status === 429
    && err.code === 'too_many_attempts' && err.extra.retry_after > 0);
  assert.throws(() => twoFactor.pass(req, bob.id, '123456'), { code: 'code_invalid' }, 'per account: bob is not held up');
  clock.now += 15 * 60_000;
  assert.equal(twoFactor.pass(req, ada.id, codeAt(secret, clock.now)), 'totp', 'after the window it works');
});

/* ---------------------------------- HTTP ---------------------------------- */

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-two-factor-'));
  const lines = [];
  const suite = createSuite({
    config: { app: { id: 'demo', name: 'Demo', languages: ['en', 'es'] }, accounts: { minPasswordLength: 8 } },
    env: {
      DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', SECURE_COOKIES: 'false',
      ADMIN_PASSWORD: 'root-password', ADMIN_EMAIL: 'root@example.com',
    },
    log: (line) => lines.push(line), exitOnError: false,
  });
  suite.ensureAdmin();
  const app = createApp({ suite, handleSignals: false, log: (line) => lines.push(line) });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** A browser: keeps its session cookie. */
  const browser = () => {
    let cookie = '';
    const call = async (method, pathname, body, headers = {}) => {
      const res = await fetch(base + pathname, {
        method,
        redirect: 'manual',
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('demo_sid='));
      if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    /** A form posted like the consent screen does it. */
    call.form = async (pathname, data) => {
      const res = await fetch(base + pathname, {
        method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
        body: new URLSearchParams(data).toString(),
      });
      const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('demo_sid='));
      if (set) cookie = set.split(';')[0];
      return { status: res.status, location: res.headers.get('location'), html: await res.text() };
    };
    return call;
  };
  const mails = (from = 0) => lines.slice(from).filter((l) => l.startsWith('[mail] to '))
    .map((text) => ({ text, token: /\?(?:reset|verify|signup)=([\w-]+)/.exec(text)?.[1] }));
  return { suite, lines, browser, mails, base };
}

const now = (secret, offset = 0) => codeAt(secret, Date.now(), offset);
/** A code none of the three steps around now gives. */
function wrongCode(secret) {
  const near = new Set([-1, 0, 1].map((offset) => now(secret, offset)));
  for (let n = 0; ; n++) {
    const code = String(n).padStart(6, '0');
    if (!near.has(code)) return code;
  }
}

test('over HTTP: turning it on, signing in in two steps, a recovery code, turning it off', async (t) => {
  const { suite, browser } = await start(t);
  const ada = suite.accounts.create({ username: 'ada', password: 'ada-password', email: 'ada@example.com' });
  const phone = browser();

  assert.equal((await phone('GET', '/api/auth/config')).data.two_factor, true, 'the screens learn it is there');
  assert.equal((await phone('GET', '/api/me/two-factor')).status, 401);
  await phone('POST', '/api/auth/login', { username: 'ada', password: 'ada-password' });
  assert.deepEqual((await phone('GET', '/api/me/two-factor')).data, { enabled: false, enabled_at: null, recovery_codes_left: 0 });

  assert.equal((await phone('POST', '/api/me/two-factor/setup', { password: 'not-hers' })).data.error, 'wrong_password',
    'an open session is not enough: the password again');
  const setup = await phone('POST', '/api/me/two-factor/setup', { password: 'ada-password' });
  assert.equal(setup.status, 200);
  assert.match(setup.data.uri, /^otpauth:\/\/totp\/Demo%3Aada\?secret=[A-Z2-7]{32}&issuer=Demo&/);
  const { secret } = setup.data;
  assert.equal((await phone('POST', '/api/me/two-factor/enable', { code: wrongCode(secret) })).data.error, 'code_invalid');
  // The very code that turned it on, kept: recomputing it a step later would give the next one.
  const firstCode = now(secret);
  const enabled = await phone('POST', '/api/me/two-factor/enable', { code: firstCode });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.enabled, true);
  assert.equal(enabled.data.recovery_codes.length, 10);
  const recovery = enabled.data.recovery_codes;
  assert.equal((await phone('GET', '/api/auth/me')).data.user.two_factor, true, 'the session that turned it on goes on');

  // Another device: the password earns a challenge, not a session.
  const laptop = browser();
  const before = suite.accounts.byId(ada.id).last_login_at;
  const first = await laptop('POST', '/api/auth/login', { username: 'ada', password: 'ada-password' });
  assert.equal(first.status, 200);
  assert.equal(first.data.two_factor_required, true);
  assert.equal(first.data.user, undefined);
  assert.match(first.data.challenge, /^\d+\.\d+\.[\w-]+$/);
  assert.equal((await laptop('GET', '/api/auth/me')).data.user, null, 'no session yet');
  assert.equal(suite.accounts.byId(ada.id).last_login_at, before, 'nor a sign-in to show in the admin panel');

  assert.equal((await laptop('POST', '/api/auth/login/code', { challenge: `${first.data.challenge}x`, code: now(secret, 1) })).data.error,
    'challenge_invalid');
  const replay = await laptop('POST', '/api/auth/login/code', { challenge: first.data.challenge, code: firstCode });
  assert.equal(replay.data.error, 'code_invalid', 'the code that turned it on is spent');
  const second = await laptop('POST', '/api/auth/login/code', { challenge: first.data.challenge, code: now(secret, 1) });
  assert.equal(second.status, 200);
  assert.equal(second.data.user.username, 'ada');
  assert.equal(second.data.recovery_codes_left, undefined);
  assert.equal((await laptop('GET', '/api/auth/me')).data.user.id, ada.id);
  assert.notEqual(suite.accounts.byId(ada.id).last_login_at, before);
  const failed = suite.database.all("SELECT meta FROM audit_log WHERE action = 'auth.login_failed'");
  assert.equal(failed.length, 1, 'a wrong code is in the audit log (a forged challenge names nobody)');
  assert.match(failed[0].meta, /"step":"code"/);

  // Without the phone: a recovery code, and how many are left.
  const borrowed = browser();
  const challenge = (await borrowed('POST', '/api/auth/login', { username: 'ada', password: 'ada-password' })).data.challenge;
  const rescued = await borrowed('POST', '/api/auth/login/code', { challenge, code: recovery[0] });
  assert.equal(rescued.status, 200);
  assert.equal(rescued.data.recovery_codes_left, 9);
  const other = browser();
  const challenge2 = (await other('POST', '/api/auth/login', { username: 'ada', password: 'ada-password' })).data.challenge;
  assert.equal((await other('POST', '/api/auth/login/code', { challenge: challenge2, code: recovery[0] })).data.error, 'code_invalid',
    'each recovery code once');

  // New recovery codes: the password and a code, or a session and a password would be enough.
  assert.equal((await phone('POST', '/api/me/two-factor/recovery-codes', { password: 'ada-password' })).data.error, 'code_invalid');
  const renewed = await phone('POST', '/api/me/two-factor/recovery-codes', { password: 'ada-password', code: recovery[1] });
  assert.equal(renewed.data.recovery_codes.length, 10);
  assert.equal(renewed.data.recovery_codes_left, 10);
  assert.equal((await other('POST', '/api/auth/login/code', { challenge: challenge2, code: recovery[2] })).data.error, 'code_invalid',
    'the old ones stop working');

  // Off: the password and a code (here a recovery one).
  assert.equal((await phone('POST', '/api/me/two-factor/disable', { password: 'ada-password', code: wrongCode(secret) })).data.error,
    'code_invalid');
  assert.equal((await phone('POST', '/api/me/two-factor/disable', { password: 'nope-nope', code: renewed.data.recovery_codes[0] })).data.error,
    'wrong_password');
  const off = await phone('POST', '/api/me/two-factor/disable', { password: 'ada-password', code: renewed.data.recovery_codes[0] });
  assert.deepEqual(off.data, { enabled: false, enabled_at: null, recovery_codes_left: 0 });
  const plain = await browser()('POST', '/api/auth/login', { username: 'ada', password: 'ada-password' });
  assert.equal(plain.data.user.username, 'ada', 'the password alone again');
  assert.equal(plain.data.user.two_factor, false);
  assert.equal((await phone('POST', '/api/me/two-factor/disable', { password: 'ada-password', code: '123456' })).status, 409);

  const actions = suite.database.all("SELECT action FROM audit_log WHERE action LIKE 'auth.two_factor.%' ORDER BY id").map((r) => r.action);
  assert.deepEqual(actions, ['auth.two_factor.enable', 'auth.two_factor.recovery_codes', 'auth.two_factor.disable']);
});

test('over HTTP: a new password from a link needs the code too; the admin can turn it off', async (t) => {
  const { suite, browser, lines, mails } = await start(t);
  const ada = suite.accounts.create({ username: 'ada', password: 'ada-password', email: 'ada@example.com' });
  const phone = browser();
  await phone('POST', '/api/auth/login', { username: 'ada', password: 'ada-password' });
  const { secret } = (await phone('POST', '/api/me/two-factor/setup', { password: 'ada-password' })).data;
  const { recovery_codes: recovery } = (await phone('POST', '/api/me/two-factor/enable', { code: now(secret) })).data;

  const stranger = browser();
  const mark = lines.length;
  await stranger('POST', '/api/auth/forgot', { login: 'ada' });
  const [message] = mails(mark);
  assert.ok(message?.token, 'the link went out');
  const bare = await stranger('POST', '/api/auth/reset', { token: message.token, password: 'taken-over-1' });
  assert.equal(bare.status, 400);
  assert.equal(bare.data.error, 'two_factor_required', 'whoever reads the mail isn’t enough');
  const guessed = await stranger('POST', '/api/auth/reset', { token: message.token, password: 'taken-over-1', code: wrongCode(secret) });
  assert.equal(guessed.data.error, 'code_invalid');
  assert.ok(suite.accounts.verify('ada', 'ada-password'), 'the password is still hers');
  assert.equal((await phone('GET', '/api/auth/me')).data.user.id, ada.id, 'and her sessions are still open');
  const short = await stranger('POST', '/api/auth/reset', { token: message.token, password: 'short', code: recovery[0] });
  assert.equal(short.data.error, 'field_too_short', 'a password too short spends no code');
  const reset = await stranger('POST', '/api/auth/reset', { token: message.token, password: 'a-brand-new-one', code: recovery[0] });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.user.username, 'ada');
  assert.ok(suite.accounts.verify('ada', 'a-brand-new-one'));
  assert.equal(suite.twoFactor.isEnabled(ada.id), true, 'a new password leaves the second step on');

  // The admin: for someone who lost the phone and the codes.
  const admin = browser();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  const listed = (await admin('GET', '/api/admin/users')).data.users.find((u) => u.id === ada.id);
  assert.equal(listed.two_factor, true, 'the panel sees who has it');
  assert.equal((await stranger('DELETE', `/api/admin/users/${ada.id}/two-factor`)).status, 403);
  const removed = await admin('DELETE', `/api/admin/users/${ada.id}/two-factor`);
  assert.equal(removed.status, 200);
  assert.equal(removed.data.two_factor, false);
  assert.equal((await admin('DELETE', `/api/admin/users/${ada.id}/two-factor`)).data.error, 'two_factor_off');
  assert.equal((await admin('DELETE', '/api/admin/users/999/two-factor')).status, 404);
  const back = await browser()('POST', '/api/auth/login', { username: 'ada', password: 'a-brand-new-one' });
  assert.equal(back.data.user.username, 'ada');
});

test('over HTTP: the consent screen of the built-in OAuth asks for the code after the password', async (t) => {
  const { suite, browser, base } = await start(t);
  suite.accounts.create({ username: 'ada', password: 'ada-password' });
  const phone = browser();
  await phone('POST', '/api/auth/login', { username: 'ada', password: 'ada-password' });
  const { secret } = (await phone('POST', '/api/me/two-factor/setup', { password: 'ada-password' })).data;
  await phone('POST', '/api/me/two-factor/enable', { code: now(secret) });

  const client = await (await fetch(`${base}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Client', redirect_uris: ['https://client.example/cb'], token_endpoint_auth_method: 'none' }),
  })).json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const params = {
    response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client.example/cb', state: 's1',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    // BASE_URL, not the test's port: the resource is the app's public address.
    resource: 'http://127.0.0.1/mcp',
  };

  const claude = browser();
  const step = await claude.form('/oauth/authorize', { ...params, username: 'ada', password: 'ada-password', decision: 'allow' });
  assert.equal(step.status, 200, 'the password is right, but there is no code yet');
  assert.match(step.html, /name="code"/);
  assert.match(step.html, /Code from your authenticator app/);
  assert.doesNotMatch(step.html, /name="password"/);
  const challenge = /name="challenge" value="([^"]+)"/.exec(step.html)?.[1];
  assert.ok(challenge);
  assert.equal((await claude('GET', '/api/auth/me')).data.user, null, 'no session on the way yet');

  const wrong = await claude.form('/oauth/authorize', { ...params, challenge, code: wrongCode(secret), decision: 'allow' });
  assert.equal(wrong.status, 200);
  assert.match(wrong.html, /That code isn’t right/);
  assert.match(wrong.html, /name="challenge"/, 'the same screen, to try again');
  const forged = await claude.form('/oauth/authorize', { ...params, challenge: `${challenge}x`, code: now(secret, 1), decision: 'allow' });
  assert.match(forged.html, /Sign in again/);
  assert.match(forged.html, /name="password"/, 'back to the password');

  const ok = await claude.form('/oauth/authorize', { ...params, challenge, code: now(secret, 1), decision: 'allow' });
  assert.equal(ok.status, 302);
  const back = new URL(ok.location);
  assert.ok(back.searchParams.get('code'));
  assert.equal(back.searchParams.get('state'), 's1');
  assert.equal((await claude('GET', '/api/auth/me')).data.user.username, 'ada', 'and the browser session opened with it');

  const token = await (await fetch(`${base}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: 'https://client.example/cb',
      client_id: client.client_id, code_verifier: verifier, resource: 'http://127.0.0.1/mcp',
    }).toString(),
  })).json();
  assert.match(token.access_token, /^mcpat_/);
});
