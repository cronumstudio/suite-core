/**
 * What accounts do by mail, over real HTTP on an app made of the suite, with
 * the log provider: the messages (and their links) are read from the log.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSuite, createApp } from '../app.js';

async function start(t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-account-mail-'));
  const lines = [];
  const suite = createSuite({
    config: { app: { id: 'demo', name: 'Demo', languages: ['en', 'es'] }, accounts: { minPasswordLength: 8 } },
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'https://demo.example', SECURE_COOKIES: 'false',
      ADMIN_PASSWORD: 'root-password', ADMIN_EMAIL: 'root@example.com', ...env },
    log: (line) => lines.push(line), exitOnError: false,
  });
  const app = createApp({ suite, handleSignals: false, log: () => {} });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** A browser: keeps its session cookie. */
  const browser = () => {
    let cookie = '';
    return async (method, pathname, body, headers = {}) => {
      const res = await fetch(base + pathname, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('demo_sid='));
      if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    };
  };
  /** The mail sent since `from`, with the token of its link. */
  const mails = (from = 0) => lines.slice(from).filter((l) => l.startsWith('[mail] to ')).map((text) => ({
    text, to: /^\[mail\] to (\S+):/.exec(text)?.[1], token: /\?(?:reset|verify|signup)=([\w-]+)/.exec(text)?.[1],
  }));
  return { suite, lines, browser, mails, base };
}

test('a forgotten password: a link by mail, one hour, once; the same answer for nobody', async (t) => {
  const { suite, lines, browser, mails } = await start(t);
  const ada = suite.accounts.create({ username: 'ada', password: 'old-password', email: 'ada@example.com' });
  const phone = browser();
  await phone('POST', '/api/auth/login', { username: 'ada', password: 'old-password' });

  const anyone = browser();
  const mark = lines.length;
  assert.deepEqual((await anyone('POST', '/api/auth/forgot', { login: 'ADA' })).data, { ok: true });
  assert.deepEqual((await anyone('POST', '/api/auth/forgot', { login: 'nobody@example.com' })).data, { ok: true },
    'the same answer whether the account exists or not');
  const [message] = mails(mark);
  assert.equal(message.to, 'ada@example.com');
  assert.match(message.text, /A new password for Demo/);
  assert.match(message.text, /https:\/\/demo\.example\/\?reset=pr_/);
  assert.match(message.text, /“ada”/);

  assert.equal((await anyone('POST', '/api/auth/reset', { token: message.token, password: 'short' })).data.error, 'field_too_short',
    'a password that doesn’t pass leaves the link as it was');
  const reset = await anyone('POST', '/api/auth/reset', { token: message.token, password: 'a-brand-new-one' });
  assert.equal(reset.data.user.username, 'ada', 'and this browser is signed in');
  assert.equal((await anyone('GET', '/api/auth/me')).data.user.id, ada.id);
  assert.equal((await phone('GET', '/api/auth/me')).data.user, null, 'every other session ends');
  assert.equal((await anyone('POST', '/api/auth/reset', { token: message.token, password: 'another-one-9' })).data.error, 'link_invalid');
  assert.ok(suite.accounts.byId(ada.id).email_verified_at, 'the email is now known to be theirs');
  assert.ok(suite.accounts.verify('ada', 'a-brand-new-one'));

  // A newer link replaces the older one; an old one expires.
  const again = lines.length;
  await anyone('POST', '/api/auth/forgot', { login: 'ada@example.com' });
  await anyone('POST', '/api/auth/forgot', { login: 'ada' });
  const [first, second] = mails(again);
  assert.equal((await anyone('POST', '/api/auth/reset', { token: first.token, password: 'yet-another-1' })).data.error, 'link_invalid');
  suite.database.run("UPDATE account_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE purpose = 'reset'");
  const expired = await anyone('POST', '/api/auth/reset', { token: second.token, password: 'yet-another-1' });
  assert.equal(expired.status, 410);
  assert.equal(expired.data.error, 'link_expired');

  // Three links to one inbox in the window: a fourth isn't sent, and the answer
  // doesn't change, whether asked by username or by email.
  const full = lines.length;
  assert.deepEqual((await anyone('POST', '/api/auth/forgot', { login: 'ADA@example.com' })).data, { ok: true });
  assert.equal(mails(full).length, 0);
  // And one address can ask ten times in the window, whoever it is for.
  let status = 200;
  for (let i = 0; i < 6 && status === 200; i++) status = (await anyone('POST', '/api/auth/forgot', { login: `x${i}@example.com` })).status;
  assert.equal(status, 429);
});

test('confirming an email: the link is for that email only', async (t) => {
  const { suite, lines, browser, mails } = await start(t);
  suite.accounts.create({ username: 'bob', password: 'bob-password', email: 'bob@example.com' });
  const bob = browser();
  await bob('POST', '/api/auth/login', { username: 'bob', password: 'bob-password' });

  const mark = lines.length;
  assert.deepEqual((await bob('POST', '/api/me/email/verify')).data, { ok: true });
  const [message] = mails(mark);
  assert.equal(message.to, 'bob@example.com');
  assert.match(message.text, /To confirm that bob@example\.com is yours/);
  const confirmed = await bob('POST', '/api/auth/verify', { token: message.token });
  assert.equal(confirmed.data.ok, true);
  assert.equal(confirmed.data.user.username, 'bob');
  assert.equal((await bob('POST', '/api/me/email/verify')).data.error, 'already_verified');

  // A link for an email the account no longer has is worth nothing.
  suite.accounts.update(confirmed.data.user.id, { email: 'robert@example.com' });
  const next = lines.length;
  await bob('POST', '/api/me/email/verify');
  const [fresh] = mails(next);
  suite.accounts.update(confirmed.data.user.id, { email: 'bobby@example.com' });
  assert.equal((await bob('POST', '/api/auth/verify', { token: fresh.token })).data.error, 'link_invalid');
});

test('invitations: the admin invites, the person creates their own account, once', async (t) => {
  const { suite, lines, browser, mails } = await start(t, { SIGNUP: 'invite' });
  const admin = browser();
  await admin('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  assert.equal((await admin('GET', '/api/auth/config')).data.signup, 'invite');

  const mark = lines.length;
  const invited = await admin('POST', '/api/admin/invitations', { email: 'Carol@Example.com', role: 'user' });
  assert.equal(invited.status, 201);
  assert.equal(invited.data.email, 'carol@example.com');
  assert.match(invited.data.url, /^https:\/\/demo\.example\/\?signup=ai_/);
  assert.equal(invited.data.sent, true);
  const [message] = mails(mark);
  assert.equal(message.to, 'carol@example.com');
  assert.match(message.text, /admin invites you to Demo|admin has invited you to Demo/);

  const carol = browser();
  assert.equal((await carol('POST', '/api/auth/signup', { username: 'carol', password: 'carol-password' })).data.error,
    'signup_closed', 'without the invitation, no');
  const created = await carol('POST', '/api/auth/signup', { token: message.token, username: 'carol', display_name: 'Carol', password: 'carol-password' });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.username, 'carol');
  assert.equal((await carol('GET', '/api/auth/me')).data.user.email, 'carol@example.com');
  assert.ok(suite.accounts.byUsername('carol').email_verified_at, 'the invitation reached that inbox: confirmed');
  assert.equal((await browser()('POST', '/api/auth/signup', { token: message.token, username: 'mallory', password: 'mallory-pass' })).data.error,
    'link_invalid', 'once');

  const withdrawn = await admin('POST', '/api/admin/invitations', { email: 'dan@example.com' });
  assert.deepEqual((await admin('DELETE', `/api/admin/invitations/${withdrawn.data.id}`)).data, { ok: true });
  const token = new URL(withdrawn.data.url).searchParams.get('signup');
  assert.equal((await browser()('POST', '/api/auth/signup', { token, username: 'dan', password: 'dan-password' })).data.error, 'link_invalid');
  assert.deepEqual((await admin('GET', '/api/admin/invitations')).data.invitations.map((i) => [i.email, Boolean(i.used_at), Boolean(i.revoked_at)]),
    [['dan@example.com', false, true], ['carol@example.com', true, false]]);
  assert.equal((await carol('POST', '/api/admin/invitations', { email: 'x@example.com' })).data.error, 'admin_only');
});

test('open sign-up: anyone, with an email to confirm, and a brake', async (t) => {
  const { lines, browser, mails } = await start(t, { SIGNUP: 'open' });
  const erin = browser();
  const mark = lines.length;
  const created = await erin('POST', '/api/auth/signup', { username: 'erin', display_name: 'Erin', email: 'erin@example.com', password: 'erin-password' });
  assert.equal(created.status, 201);
  assert.equal((await erin('GET', '/api/auth/me')).data.user.username, 'erin', 'signed in right away');
  const [message] = mails(mark);
  assert.equal(message.to, 'erin@example.com');
  assert.match(message.text, /\?verify=ev_/);
  assert.equal((await browser()('POST', '/api/auth/signup', { username: 'frank', password: 'frank-password' })).data.error,
    'field_invalid', 'an email is needed');
  let status = 201;
  for (let i = 0; i < 6 && status === 201; i++) {
    status = (await browser()('POST', '/api/auth/signup', { username: `bot${i}`, email: `bot${i}@example.com`, password: 'bot-password' })).status;
  }
  assert.equal(status, 429, 'five accounts per address in the window');
});
