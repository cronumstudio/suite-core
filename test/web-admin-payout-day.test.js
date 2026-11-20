/**
 * Administration › Affiliates, a payout noted (web/admin.js): its date starts on the day it is
 * where the person noting it is, not on UTC's. At half past midnight in Madrid UTC is still on
 * yesterday, and the payout went down on the day before unless the date was changed by hand. On a
 * fake page with a stand-in server; the zone is this process's (TZ) and the clock node:test's. A
 * file of its own: admin.js starts the page as it is imported.
 *
 *   npm test
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

const zoneBefore = process.env.TZ;
after(() => {
  if (zoneBefore === undefined) delete process.env.TZ;
  else process.env.TZ = zoneBefore;
});
process.env.TZ = 'Europe/Madrid';

const document = installFakeDom();
const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a payout noted at 00:30 in Madrid starts on that day, not on UTC\'s yesterday', async (t) => {
  // 23:30 UTC on 20 November: 00:30 on the 21st in Madrid.
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 20, 23, 30) });
  const root = document.createElement('div');
  document.body.append(root);
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  globalThis.window = { location: { hash: '#/affiliates' }, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const code = {
    id: 2, code: 'MARIA20', kind: 'creator', campaign: 'YouTube', active: true, cash: 600, currency: 'EUR',
    offer: { type: 'percent', percent: 20 }, products: ['pro-yearly'],
    owner: { id: 5, email: 'maria@example.com', display_name: 'María' },
    figures: {
      accounts: 4, pending: 0, confirmed: 3, reversed: 0, pending_amount: 0, earned: 1800, paid: 1200, balance: 600, months: 0, months_this_year: 0,
    },
  };
  const server = {
    'GET /api/auth/config': { provider: 'local', app: { name: 'Work', languages: ['en'], modules: { affiliates: true } } },
    'GET /api/auth/me': { user: { username: 'root', display_name: 'Root', role: 'admin' } },
    'GET /api/admin/affiliates': {
      enabled: true, discounts: true, products: ['pro-yearly'], codes: [code], totals: {},
      rules: { creator: { offer: code.offer, products: code.products, reward: { cash: 600, currency: 'EUR' }, payout_minimum: 3000 } },
    },
    'GET /api/admin/affiliates/2/commissions': { code, commissions: [], payouts: [] },
  };
  globalThis.fetch = async (path, { method = 'GET' } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    const answer = server[`${method} ${path}`];
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, json: async () => answer ?? { error: 'not_found' } };
  };
  await import('../web/admin.js');
  let main = null;
  for (let turn = 0; turn < 50 && !(main = byId('admin-main'))?.find('table').length; turn++) await settle();
  const turns = async () => { for (let turn = 0; turn < 20; turn++) await settle(); };
  const button = (node, text) => node.find('button').find((b) => b.textContent === text);
  const openDialog = () => document.body.all().filter((node) => node.tagName === 'DIALOG' && node.open).at(-1);

  button(main, english['admin.affiliates.open']).dispatch('click');
  await turns();
  button(openDialog(), english['admin.affiliates.recordPayout']).dispatch('click');
  await turns();
  const form = openDialog();
  assert.equal(form.find('h2').concat(form.find('h1')).some((h) => h.textContent === english['admin.affiliates.recordPayout']), true, 'the payout\'s dialog');
  const day = form.find('input').find((input) => input.getAttribute('type') === 'date');
  assert.equal(day.value, '2026-11-21');
});
