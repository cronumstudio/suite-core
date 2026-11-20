/**
 * The affiliate's panel (web/affiliates.js, /afiliados) on a fake page: a referral code and a
 * creator's campaign, each with its code and link to copy and its figures, the note of how to be
 * paid for a creator, the rules and the press kit. The server is a stand-in; the texts are the
 * core's English catalog. A file of its own: the page starts as it is imported.
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

test('the panel: each code with its link and figures, how to be paid, the rules', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  document.querySelector = (selector) => (selector === '#affiliates' ? root : null);
  document.querySelectorAll = () => [];
  globalThis.window = { location: { hash: '' }, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const figures = (more) => ({
    accounts: 0, pending: 0, confirmed: 0, reversed: 0, pending_amount: 0, earned: 0, paid: 0, balance: 0, months: 0, months_this_year: 0, ...more,
  });
  const sent = [];
  const server = {
    'GET /api/auth/config': { provider: 'workos', app: { name: 'Work', languages: ['en'], modules: {} } },
    'GET /api/auth/me': { user: { id: 5, username: 'maria', display_name: 'María', role: 'user' } },
    'GET /api/affiliates/me': {
      codes: [
        {
          code: 'WORKJKMN', kind: 'referral', campaign: null, active: true, link: 'https://work.example/r/WORKJKMN', discount: true,
          offer: { type: 'flat', amount: 390, currency: 'EUR' }, products: ['pro-monthly', 'pro-yearly'], reward: 'pro_month',
          figures: figures({ accounts: 3, confirmed: 2, months: 2, months_this_year: 2 }),
        },
        {
          code: 'MARIA20', kind: 'creator', campaign: 'YouTube', active: true, link: 'https://work.example/r/MARIA20', discount: false,
          offer: { type: 'percent', percent: 20 }, products: ['pro-yearly'], reward: { cash: 600, currency: 'EUR' },
          figures: figures({ accounts: 9, pending: 2, confirmed: 5, earned: 3000, paid: 1800, balance: 1200 }),
          payouts: [{ id: 1, amount: 1800, currency: 'EUR', method: 'PayPal', paid_at: '2027-02-01T12:00:00Z' }], payout_note: 'PayPal maria@example.com',
        },
      ],
      rules: {
        enabled: true, confirm_days: 30, press_kit_url: 'https://example.com/press',
        referral: { offer: { type: 'flat', amount: 390, currency: 'EUR' }, products: ['pro-monthly', 'pro-yearly'], reward: 'pro_month', reward_days: 30, yearly_cap: 12 },
        creator: { offer: { type: 'percent', percent: 20 }, products: ['pro-yearly'], reward: { cash: 600, currency: 'EUR' }, payout_minimum: 3000 },
      },
    },
    'PUT /api/affiliates/me': { payout_note: 'IBAN' },
  };
  globalThis.fetch = async (path, { method = 'GET', body } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    if (method !== 'GET') sent.push([method, path, JSON.parse(body)]);
    const answer = server[`${method} ${path}`];
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, json: async () => answer ?? { error: 'not_found' } };
  };
  await import('../web/affiliates.js');
  for (let turn = 0; turn < 50 && !root.find('h2').length; turn++) await settle();

  assert.deepEqual(root.find('h2').map((h) => h.textContent), [
    english['affiliates.referral.title'], english['affiliates.creator.titleOf'].replace('{campaign}', 'YouTube'),
    english['affiliates.payoutNote.title'], english['affiliates.rules.title'],
  ]);
  const codes = root.find('code').map((c) => c.textContent);
  assert.deepEqual(codes, ['WORKJKMN', 'https://work.example/r/WORKJKMN', 'MARIA20', 'https://work.example/r/MARIA20']);
  const facts = root.all().filter((n) => n.getAttribute?.('class') === 'kit-fact').map((f) => f.childNodes.map((n) => n.textContent));
  assert.ok(facts.some(([label, value]) => label === english['affiliates.figures.months'] && value === '2 months'));
  assert.ok(facts.some(([label, value]) => label === english['affiliates.figures.thisYear'] && value === '2 of 12'));
  assert.ok(facts.some(([label, value]) => label === english['affiliates.figures.balance'] && /12[.,]00/.test(value)));
  const texts = root.find('p').map((p) => p.textContent);
  assert.ok(texts.includes(english['affiliates.linkOnly']), 'a code without its discount says so');
  assert.ok(texts.includes(english['affiliates.creator.tip'].replace('{code}', 'MARIA20')));
  assert.equal(root.find('li').length, 6, 'the rules, for both kinds');
  assert.equal(root.find('a').find((a) => a.getAttribute('href') === 'https://example.com/press')?.textContent, english['affiliates.pressKit']);
  const note = root.find('textarea')[0];
  assert.equal(note.value, 'PayPal maria@example.com');
  note.value = '  IBAN  ';
  root.find('button').find((b) => b.textContent === english['affiliates.payoutNote.save']).listeners.click[0]({ preventDefault() {} });
  for (let turn = 0; turn < 20 && !sent.length; turn++) await settle();
  assert.deepEqual(sent, [['PUT', '/api/affiliates/me', { payout_note: 'IBAN' }]]);
});
