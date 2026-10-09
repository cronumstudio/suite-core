/**
 * Someone deleting their own account (account-deletion.js): asked from
 * Settings with the password (and the code), disabled at once and gone after
 * the install's days; signing in before then offers it back; the sweep deletes
 * it with every hook, and at the providers only where the install says so.
 * Over real HTTP, then the service on its own with providers that fail.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSuite, createApp } from '../app.js';
import { createAccountDeletion, deletionTicket, readDeletionTicket } from '../account-deletion.js';
import { createAccounts, usersSchema, accountDeletionSchema } from '../accounts.js';
import { openDatabase } from '../db.js';
import { totp, base32Decode } from '../two-factor.js';

const PRODUCT = {
  app: { id: 'demo', name: 'Demo', port: 3999, languages: ['en', 'es'] },
  accounts: { minPasswordLength: 8 },
};
const DAY = 24 * 60 * 60 * 1000;

async function serve(t, { product = PRODUCT, hooks = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-deletion-'));
  const suite = createSuite({
    config: product, hooks, log: () => {}, exitOnError: false,
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1' },
    migrations: [{ version: 1, name: 'notes', up: (d) => d.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, text TEXT)') }],
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
  return { suite, browser };
}

test('deleting one’s own account: asked again, disabled at once, offered back, gone after its days', async (t) => {
  const removed = [];
  const { suite, browser } = await serve(t, { hooks: { onUserRemoved: (id) => removed.push(id) } });
  const ana = suite.accounts.create({ username: 'ana', displayName: 'Ana', password: 'ana-password', email: 'ana@example.com' });
  suite.database.run('INSERT INTO notes (user_id, text) VALUES (?, ?)', ana.id, 'mine');
  suite.tokens.create(ana.id, { name: 'Claude' });

  const anaTab = browser();
  const phone = browser();
  assert.equal((await anaTab('POST', '/api/auth/login', { username: 'ana', password: 'ana-password' })).status, 200);
  assert.equal((await phone('POST', '/api/auth/login', { username: 'ana', password: 'ana-password' })).status, 200);
  assert.equal((await anaTab('GET', '/api/auth/config')).data.deletion_days, 30, 'the sign-in screen and Settings know the days');

  // Asked again: the word's confirmation, and the password of an account that has one here.
  assert.equal((await anaTab('POST', '/api/me/deletion', { password: 'ana-password' })).data.error, 'confirm_required');
  assert.equal((await anaTab('POST', '/api/me/deletion', { confirm: true, password: 'nope' })).data.error, 'wrong_password');
  assert.ok(suite.accounts.byId(ana.id).disabled_at == null, 'nothing happened yet');

  const before = Date.now();
  const asked = await anaTab('POST', '/api/me/deletion', { confirm: true, password: 'ana-password' });
  assert.equal(asked.status, 200);
  const when = Date.parse(asked.data.delete_after);
  assert.ok(when >= before + 30 * DAY - 1000 && when <= Date.now() + 30 * DAY + 1000, 'thirty days from now');
  const row = suite.accounts.byId(ana.id);
  assert.ok(row.disabled_at && row.delete_after, 'disabled, with the day it goes');
  assert.equal((await anaTab('GET', '/api/auth/me')).data.user, null, 'this browser is out');
  assert.equal((await phone('GET', '/api/auth/me')).data.user, null, 'and every other device');
  assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM notes WHERE user_id = ?', ana.id).n, 1, 'the data waits with it');
  const audit = suite.audit.list({ action: 'account.deletion' });
  assert.equal(audit[0].action, 'account.deletion.request');

  // The admin panel says when it goes.
  assert.equal(suite.accounts.publicUser(row).delete_after, new Date(when).toISOString());

  // Signing in again: no session, the offer to take it back.
  const back = browser();
  assert.equal((await back('POST', '/api/auth/login', { username: 'ana', password: 'wrong' })).data.error, 'bad_credentials',
    'a wrong password says nothing of it');
  const offer = await back('POST', '/api/auth/login', { username: 'ana', password: 'ana-password' });
  assert.equal(offer.data.deletion_pending, true);
  assert.equal(offer.data.delete_after, new Date(when).toISOString());
  assert.equal(offer.data.user, undefined);
  assert.equal((await back('GET', '/api/auth/me')).data.user, null);
  assert.equal((await back('POST', '/api/auth/restore', { ticket: `${offer.data.ticket}x` })).data.error, 'ticket_invalid');
  const restored = await back('POST', '/api/auth/restore', { ticket: offer.data.ticket });
  assert.equal(restored.data.user.username, 'ana');
  assert.equal((await back('GET', '/api/auth/me')).data.user.username, 'ana', 'signed in, as it was');
  assert.equal(suite.accounts.byId(ana.id).disabled_at, null);
  assert.equal(suite.accounts.byId(ana.id).delete_after, null);
  assert.equal((await back('POST', '/api/auth/restore', { ticket: offer.data.ticket })).data.error, 'ticket_invalid',
    'a ticket takes back an account waiting, once');

  // Asked again, and this time the days go by.
  await back('POST', '/api/me/deletion', { confirm: true, password: 'ana-password' });
  assert.equal(await suite.deletion.sweep(), 0, 'nothing is due yet');
  suite.database.run("UPDATE users SET delete_after = '2020-01-01T00:00:00.000Z' WHERE id = ?", ana.id);
  assert.equal(await suite.deletion.sweep(), 1);
  assert.equal(suite.accounts.byId(ana.id), null, 'gone');
  assert.deepEqual(removed, [ana.id], 'with every hook, as when the admin deletes it');
  assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM notes').n, 0);
  assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM api_tokens').n, 0);
  const gone = suite.audit.list({ action: 'account.delete' })[0];
  assert.deepEqual([gone.actor_user_id, gone.target_id, gone.meta], [null, String(ana.id), { requested: true }]);
  assert.equal((await back('POST', '/api/auth/login', { username: 'ana', password: 'ana-password' })).data.error, 'bad_credentials');
});

test('the last administrator can’t delete their account; the admin enabling one takes the deletion back', async (t) => {
  const { suite, browser } = await serve(t);
  const root = browser();
  await root('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  assert.equal((await root('POST', '/api/me/deletion', { confirm: true, password: 'root-password' })).data.error, 'last_admin');
  assert.equal((await root('GET', '/api/auth/me')).data.user.username, 'admin', 'and stays signed in');

  const ben = suite.accounts.create({ username: 'ben', displayName: 'Ben', password: 'ben-password' });
  suite.accounts.requestDeletion(ben.id, { days: 30 });
  assert.equal((await root('GET', '/api/admin/users')).data.users.find((u) => u.id === ben.id).delete_after != null, true);
  await root('PATCH', `/api/admin/users/${ben.id}`, { disabled: false });
  const after = suite.accounts.byId(ben.id);
  assert.deepEqual([after.disabled_at, after.delete_after], [null, null]);
  // An account the admin disabled is not offered back: only one its owner asked to delete.
  suite.accounts.update(ben.id, { disabled: true });
  assert.equal((await browser()('POST', '/api/auth/login', { username: 'ben', password: 'ben-password' })).data.error, 'bad_credentials');
});

test('with a second step, the code too: to ask, and before the offer to take it back', async (t) => {
  const { suite, browser } = await serve(t);
  const cleo = suite.accounts.create({ username: 'cleo', displayName: 'Cleo', password: 'cleo-password' });
  const { secret } = suite.twoFactor.begin(cleo);
  const codeAt = (offset) => totp(base32Decode(secret), Math.floor(Date.now() / 30000) + offset);
  // A code from the app works once: the recovery codes do the rest.
  const recovery = suite.twoFactor.enable(cleo.id, codeAt(0));
  const tab = browser();
  const first = await tab('POST', '/api/auth/login', { username: 'cleo', password: 'cleo-password' });
  await tab('POST', '/api/auth/login/code', { challenge: first.data.challenge, code: codeAt(1) });
  assert.equal((await tab('POST', '/api/me/deletion', { confirm: true, password: 'cleo-password' })).data.error, 'code_invalid');
  assert.equal((await tab('POST', '/api/me/deletion', { confirm: true, password: 'cleo-password', code: recovery[0] })).status, 200);

  const back = browser();
  const again = await back('POST', '/api/auth/login', { username: 'cleo', password: 'cleo-password' });
  assert.equal(again.data.two_factor_required, true, 'the password alone doesn’t say it is waiting');
  const offer = await back('POST', '/api/auth/login/code', { challenge: again.data.challenge, code: recovery[1] });
  assert.equal(offer.data.deletion_pending, true);
  assert.equal((await back('POST', '/api/auth/restore', { ticket: offer.data.ticket })).data.user.username, 'cleo');
});

test('tickets: signed, for one account, for a quarter of an hour', () => {
  const sign = (v) => `sig(${v})`.replace(/[^\w]/g, '');
  const now = Date.parse('2026-10-09T10:00:00Z');
  const ticket = deletionTicket(sign, 7, () => now);
  assert.equal(readDeletionTicket(sign, ticket, () => now + 14 * 60 * 1000), 7);
  assert.throws(() => readDeletionTicket(sign, ticket, () => now + 16 * 60 * 1000), { code: 'ticket_expired' });
  assert.throws(() => readDeletionTicket(sign, ticket.replace(/^7\./, '8.'), () => now), { code: 'ticket_invalid' });
  assert.throws(() => readDeletionTicket(sign, 'nonsense', () => now), { code: 'ticket_invalid' });
});

test('at the providers only where the install says so; one that can’t be reached keeps the account for the next sweep', async () => {
  const database = openDatabase({ path: ':memory:' });
  usersSchema(database);
  accountDeletionSchema(database);
  let now = Date.parse('2026-10-09T10:00:00Z');
  const accounts = createAccounts({ database, clock: () => now });
  const calls = [];
  const billing = {
    enabled: true,
    stopRenewals: async (id) => { calls.push(['stop', id]); },
    keepRenewals: async (id) => { calls.push(['keep', id]); },
    endSubscriptions: async (id) => { calls.push(['end', id]); throw new Error('Paddle is down'); },
  };
  let idpDown = true;
  const idp = { deleteIdentity: async (id) => { calls.push(['identity', id]); if (idpDown) throw new Error('WorkOS does not answer'); } };
  const lines = [];
  const make = (atProviders) => createAccountDeletion({
    accounts, sign: (v) => v.length.toString(36), days: 30, atProviders, idp, billing, clock: () => now, log: (l) => lines.push(l),
  });

  // Where other apps share the provider's accounts: here only.
  const shared = make(false);
  const dan = accounts.create({ username: 'dan', displayName: 'Dan' });
  await shared.request(dan);
  now += 31 * DAY;
  assert.equal(await shared.sweep(), 1);
  assert.deepEqual(calls, [], 'neither the subscriptions nor the identity are touched');

  // Where this install is all the person has.
  const whole = make(true);
  const eve = accounts.create({ username: 'eve', displayName: 'Eve' });
  await whole.request(eve);
  assert.deepEqual(calls, [['stop', eve.id]], 'the subscriptions stop renewing when they ask');
  await whole.restore(whole.ticketFor(eve.id));
  assert.deepEqual(calls.at(-1), ['keep', eve.id], 'and renew again when they come back');
  await whole.request(eve);
  now += 31 * DAY;
  assert.equal(await whole.sweep(), 0, 'WorkOS down: it waits');
  assert.ok(accounts.byId(eve.id), 'still here, to know whom to delete there');
  assert.ok(lines.some((l) => l.includes('could not be deleted yet')));
  idpDown = false;
  assert.equal(await whole.sweep(), 1);
  assert.equal(accounts.byId(eve.id), null);
  assert.deepEqual(calls.filter(([what]) => what !== 'stop' && what !== 'keep').map(([what]) => what),
    ['end', 'identity', 'end', 'identity'], 'a subscription that can’t be ended doesn’t keep the account');
  database.close();
});
