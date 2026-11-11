/**
 * The admin panel deleting an account that pays (web/admin.js): the question says first what the
 * person pays for themselves, the web subscription the deletion cancels and a store's, which goes
 * on until they cancel it in the store; what they pay unknown, nothing is asked; a payment
 * provider that can't cancel keeps the account, and the panel says why; and when the server wants
 * a recent sign-in, it is a fresh one, back at the panel. On a fake page, with the core's English
 * catalog. A file of its own: admin.js starts the page as it is imported.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

const document = installFakeDom();
const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const t = (key, vars = {}) => english[key].replace(/\{(\w+)\}/g, (_, name) => vars[name]);

const ADA = { id: 1, username: 'ada', display_name: 'Ada', role: 'user', email: 'ada@example.com', providers: ['workos'], plan: null };
const PAYS = [
  {
    kind: 'web', provider: 'paddle', product: 'pro-yearly', plan: 'pro', plan_name: 'Pro', status: 'active',
    period_end: '2027-11-11T00:00:00.000Z', ending: false, ends: true,
  },
  {
    kind: 'store', provider: 'revenuecat', store: 'app_store', sandbox: false, product: 'store-pro-monthly', plan: 'pro',
    plan_name: 'Pro', status: 'active', period_end: '2026-12-11T00:00:00.000Z', ending: false, ends: false,
  },
];

test('deleting someone who pays: what is cancelled and what goes on in a store is said first; a provider that fails keeps the account', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  globalThis.window = { location: { hash: '#/users', href: '/admin' }, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const sent = [];
  // What each request answers, in turn where it is a list: { status, body }, or a body for a 200.
  const server = {
    'GET /api/auth/config': { provider: 'workos', name: 'WorkOS', app: { name: 'Work', languages: ['en'], modules: { billing: true, stores: true } } },
    'GET /api/auth/me': { user: { username: 'root', display_name: 'Root', role: 'admin' } },
    'GET /api/admin/users': { users: [ADA] },
    'GET /api/admin/users/1/sign-in': { method: 'google', password: false, two_factor: { enabled: false }, manage: true, reauth: 'session' },
    'GET /api/admin/users/1/subscriptions': [{ status: 500, body: { error: 'generic' } }, { subscriptions: PAYS }],
    'DELETE /api/admin/users/1': [
      { status: 503, body: { error: 'subscription_not_ended' } }, { status: 401, body: { error: 'reauth_required' } }, { ok: true },
    ],
  };
  globalThis.fetch = async (path, { method = 'GET' } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    sent.push(`${method} ${path}`);
    const route = server[`${method} ${path}`];
    const next = Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route;
    const { status, body } = next === undefined ? { status: 404, body: { error: 'not_found' } }
      : 'status' in next ? next : { status: 200, body: next };
    return { ok: status < 400, status, json: async () => body };
  };
  await import('../web/admin.js');
  let main = null;
  for (let turn = 0; turn < 50 && !(main = byId('admin-main'))?.find('tr').length; turn++) await settle();

  const newest = () => document.body.all().filter((node) => node.tagName === 'DIALOG' && node.open).at(-1);
  const errors = () => document.body.all().filter((node) => node.className.split(' ').includes('kit-toast--error')).map((node) => node.textContent);
  const wait = async () => { for (let turn = 0; turn < 20; turn++) await settle(); };
  main.find('tr')[1].dispatch('click');
  await wait();
  const account = newest();
  const pressDelete = async () => {
    account.find('button').find((node) => node.textContent === t('admin.users.delete')).dispatch('click');
    await wait();
    return newest();
  };

  // What she pays can't be known: nothing is asked, nothing deleted, and the panel says so.
  sent.length = 0;
  assert.equal(await pressDelete(), account, 'no question');
  assert.deepEqual(sent, ['GET /api/admin/users/1/subscriptions']);
  assert.equal(errors().length, 1);

  // Known: the question says what is cancelled now, and that the store's goes on until she cancels it there.
  const question = await pressDelete();
  assert.notEqual(question, account);
  const said = question.textContent;
  assert.ok(said.includes(t('admin.users.deleteConfirm', { name: 'Ada' })));
  assert.ok(said.includes(t('admin.users.deleteCancels', { plan: 'Pro', provider: 'Paddle' })), said);
  assert.ok(said.includes(t('admin.users.deleteStore.app_store', { plan: 'Pro' })), said);
  const warning = question.all().find((node) => node.className.split(' ').includes('kit-warning'));
  assert.equal(warning?.textContent, t('admin.users.deleteStore.app_store', { plan: 'Pro' }), 'the store’s, where it is seen');

  // The provider couldn't cancel: the account stays, and why is said, to try again.
  sent.length = 0;
  question.find('button').find((node) => node.className.split(' ').includes('kit-btn--danger')).dispatch('click');
  await wait();
  assert.deepEqual(sent, ['DELETE /api/admin/users/1']);
  assert.ok(errors().includes(t('errors.subscription_not_ended')), errors().join(' | '));
  assert.ok(account.open, 'the account’s dialog stays open');

  // A fresh sign-in wanted: at the provider, which asks again instead of taking its own session, and back here.
  (await pressDelete()).find('button').find((node) => node.className.split(' ').includes('kit-btn--danger')).dispatch('click');
  await wait();
  assert.equal(window.location.href, '/auth/login?prompt=login&return=%2Fadmin');

  // Deleted.
  window.location.href = '/admin';
  sent.length = 0;
  (await pressDelete()).find('button').find((node) => node.className.split(' ').includes('kit-btn--danger')).dispatch('click');
  await wait();
  assert.ok(sent.includes('DELETE /api/admin/users/1') && sent.includes('GET /api/admin/users'), 'and the list again, without her');
  assert.equal(account.open, false);
});
