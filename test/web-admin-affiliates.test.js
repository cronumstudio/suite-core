/**
 * Administration › Affiliates (web/admin.js) on a fake page: the tab with payments on, a row per
 * code with its owner, kind, campaign, code, accounts, sales, earned, paid and balance, money for a
 * creator's and months for a referral's. The server is a stand-in; the texts are the core's English
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

test('Affiliates: the tab, and a row per code with its figures', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  globalThis.window = { location: { hash: '#/affiliates' }, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const figures = (more) => ({
    accounts: 0, pending: 0, confirmed: 0, reversed: 0, pending_amount: 0, earned: 0, paid: 0, balance: 0, months: 0, months_this_year: 0, ...more,
  });
  const server = {
    'GET /api/auth/config': { provider: 'local', app: { name: 'Work', languages: ['en'], modules: { affiliates: true } } },
    'GET /api/auth/me': { user: { username: 'root', display_name: 'Root', role: 'admin' } },
    'GET /api/admin/affiliates': {
      enabled: false, discounts: true, products: ['pro-monthly', 'pro-yearly'],
      rules: { creator: { offer: { type: 'percent', percent: 20 }, products: ['pro-yearly'], reward: { cash: 600, currency: 'EUR' }, payout_minimum: 3000 } },
      codes: [
        {
          id: 2, code: 'MARIA20', kind: 'creator', campaign: 'YouTube', active: true, cash: 600, currency: 'EUR',
          owner: { id: 5, email: 'maria@example.com', display_name: 'María' }, figures: figures({ accounts: 4, pending: 1, confirmed: 3, earned: 1800, paid: 1200, balance: 600 }),
        },
        {
          id: 1, code: 'WORKJKMN', kind: 'referral', campaign: null, active: false, cash: null, currency: null,
          owner: null, figures: figures({ accounts: 2, confirmed: 2, months: 2 }),
        },
      ],
      totals: {},
    },
  };
  globalThis.fetch = async (path, { method = 'GET' } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    const answer = server[`${method} ${path}`];
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, json: async () => answer ?? { error: 'not_found' } };
  };
  await import('../web/admin.js');
  let main = null;
  for (let turn = 0; turn < 50 && (!(main = byId('admin-main')) || !main.find('table').length); turn++) await settle();

  const tabs = root.find('a').filter((a) => a.getAttribute('data-tab')).map((a) => a.getAttribute('data-tab'));
  assert.ok(tabs.includes('affiliates'), tabs.join(', '));
  assert.equal(main.find('p').some((p) => p.textContent === english['admin.affiliates.leadOff']), true, 'the program off, said');
  const cells = main.find('tr').slice(1).map((row) => row.childNodes.map((cell) => cell.textContent));
  assert.equal(cells.length, 2);
  const [maria, referral] = cells;
  assert.deepEqual(maria.slice(1, 6), [english['affiliates.kind.creator'], 'YouTube', 'MARIA20', '4', '1 / 3 / 0']);
  assert.match(maria[0], /María/);
  assert.match(maria[6], /18[.,]00/);
  assert.match(maria[8], /6[.,]00/);
  assert.equal(referral[0], english['admin.affiliates.gone']);
  assert.equal(referral[3], `WORKJKMN${english['admin.affiliates.off']}`);
  assert.equal(referral[6], '2 months');
  assert.equal(referral[8], '', 'a referral owes no money');
});
