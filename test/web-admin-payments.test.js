/**
 * The admin panel's account (web/admin.js › Users) on a fake page: what it pays. Each subscription
 * of the person's and of the groups they run, where and in what state, and «Manage charges», the
 * provider's own page for it, opened apart; one with no link names its ref. An install without
 * payments shows no such fold. The server is a stand-in; the texts are the core's English catalog.
 * A file of its own: admin.js starts the page as it is imported.
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
const text = (key, vars = {}, n = null) => {
  const value = english[key];
  const form = typeof value === 'string' ? value : value[`=${n}`] ?? value[n === 1 ? 'one' : 'other'];
  return form.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? n);
};

const PRO = { id: 'pro', name: 'Pro' };
const person = (id, username) => ({
  id, username, display_name: username, role: 'user', email: null, providers: [], plan: PRO, plan_ends: null, unlimited: false,
  plan_source: { kind: 'subscription', provider: 'paddle', ends: null, note: null },
});
const USERS = [person(1, 'ada'), person(2, 'ben')];
const PAYMENTS = [
  {
    kind: 'store', provider: 'revenuecat', ref: 'play_store:work_pro:yearly:abc', product: 'store-pro-yearly', plan: 'pro', plan_name: 'Pro',
    status: 'active', live: true, period_end: '2099-03-01T00:00:00.000Z', ending: false, store: 'play_store', sandbox: false,
    dashboard_url: 'https://app.revenuecat.com/projects/4924c524/customers/0b6c1e2a-1d5a-4b7e-9c1a-1f2e3d4c5b6a',
  },
  {
    kind: 'web', provider: 'paddle', ref: 'sub_01jfamily', organization_id: 7, organization_name: 'Home', product: 'family-yearly', plan: 'family',
    plan_name: 'Family', status: 'active', live: true, period_end: '2099-05-01T00:00:00.000Z', ending: true,
    dashboard_url: 'https://vendors.paddle.com/subscriptions-v2/sub_01jfamily',
  },
  {
    kind: 'web', provider: 'paddle', ref: 'sub_01jold', product: 'pro-monthly', plan: 'pro', plan_name: 'Pro',
    status: 'canceled', live: false, period_end: '2026-10-01T00:00:00.000Z', ending: null, dashboard_url: null,
  },
];

test('Users › an account: what it pays, where, in what state, and «Manage charges» opening the provider apart; nothing without payments', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  globalThis.window = { location: { hash: '#/users' }, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const server = {
    'GET /api/auth/config': { provider: 'local', app: { name: 'Work', languages: ['en'], modules: {} } },
    'GET /api/auth/me': { user: { username: 'root', display_name: 'Root', role: 'admin' } },
    'GET /api/admin/plans': { defaultPlan: 'free', plans: [{ id: 'free', name: 'Free', features: {} }, { ...PRO, features: {} }], features: {}, several: true },
    'GET /api/admin/users': { users: USERS },
    'GET /api/admin/users/1/grants': { grants: [] },
    'GET /api/admin/users/1/payments': { payments: PAYMENTS },
    'GET /api/admin/users/2/grants': { grants: [] },
  };
  globalThis.fetch = async (path, { method = 'GET' } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    const answer = server[`${method} ${path}`];
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, json: async () => answer ?? { error: 'not_found' } };
  };
  await import('../web/admin.js');
  let main = null;
  for (let turn = 0; turn < 50 && !(main = byId('admin-main'))?.find('tr').length; turn++) await settle();
  const rows = main.find('tr').slice(1);
  const open = async (row) => {
    row.dispatch('click');
    for (let turn = 0; turn < 20; turn++) await settle();
    return document.body.all().find((node) => node.tagName === 'DIALOG' && node.open);
  };
  const foldOf = (dialog, title) => dialog.find('details').find((node) => node.find('summary')[0]?.find('span')[0]?.textContent === title);

  const dialog = await open(rows[0]);
  const payments = foldOf(dialog, text('admin.payments.title'));
  assert.ok(payments, 'a fold of its own');
  const folds = dialog.find('details').filter((node) => node.getAttribute('class') === 'kit-fold');
  assert.equal(folds.indexOf(payments), folds.findIndex((node) => node.find('summary')[0].find('span')[0].textContent === text('admin.users.plan')) + 1,
    'right after the plan');
  assert.equal(payments.find('summary')[0].find('small')[0].textContent, text('admin.payments.liveCount', {}, 2), 'how many are live');

  // A row each (no table: on a phone its button stays in sight), the button at the row's end.
  assert.equal(payments.find('table').length, 0);
  const lines = payments.find('div').filter((node) => node.getAttribute('class') === 'kit-list__row');
  assert.equal(lines.length, 3);
  const texts = (line) => line.find('div')[0].childNodes.map((node) => node.textContent);
  const [store, group, over] = lines.map(texts);
  assert.equal(store[0], 'Pro · Google Play', 'the store bought in');
  assert.equal(store[1], 'store-pro-yearly · RevenueCat', 'through RevenueCat');
  assert.match(store[2], new RegExp(`^${text('admin.payments.status.active')} · Renews on .*2099`));
  assert.deepEqual(group.slice(0, 2), ['Family · Paddle', `${text('admin.payments.group', { name: 'Home' })} · family-yearly`]);
  assert.match(group[2], /^Active · Ends on .*2099/, 'cancelled for its period\'s end');
  assert.match(over[2], new RegExp(`^${text('admin.payments.status.canceled')} · Ended on `));

  // «Manage charges»: the provider's own page, apart, with nothing of the panel's sent along.
  const links = payments.find('a');
  assert.deepEqual(links.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]), [
    [text('admin.payments.manage'), PAYMENTS[0].dashboard_url, '_blank', 'noopener noreferrer'],
    [text('admin.payments.manage'), PAYMENTS[1].dashboard_url, '_blank', 'noopener noreferrer'],
  ]);
  assert.equal(links[0].getAttribute('title'), text('admin.payments.manageHint', { provider: 'RevenueCat' }));
  assert.equal(lines[0].childNodes.at(-1), links[0], 'at the row\'s end');
  // No link: where to look, and what for.
  assert.equal(over.at(-1), text('admin.payments.noLink', { provider: 'Paddle', ref: 'sub_01jold' }));
  assert.equal(lines[2].find('a').length, 0);
  dialog.close();

  // Another install's account, or one whose payments aren't on (404): no such fold at all.
  const other = await open(rows[1]);
  assert.equal(foldOf(other, text('admin.payments.title')), undefined);
  other.close();
});
