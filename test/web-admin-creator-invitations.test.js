/**
 * Administration › Affiliates › Creators' invitations (web/admin.js) on a fake page: the block with
 * the invitations on, a row per invitation with whom it is for, its Pro, its code and its state, the
 * link to copy and the way to revoke while pending, those that are over only counted, and «Invite a
 * creator» sending what the dialog says. The server is a stand-in; the texts are the core's English
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

test('Creators’ invitations: a row each, the ended ones counted, and a new one with the dialog’s terms', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  globalThis.window = { location: { hash: '#/affiliates' }, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const sent = [];
  const pending = {
    id: 3, status: 'pending', name: 'María López', email: 'maria@example.com', creator: true, pro_months: 12, pro_until: null,
    uses: 1, used: 0, code: 'MARIA20',
    created_at: '2026-11-24T10:00:00.000Z', expires_at: '2026-12-24T10:00:00.000Z', ended: false, user: null,
    link: 'https://work.example/i/ci_abc',
  };
  const server = {
    'GET /api/auth/config': { provider: 'workos', app: { name: 'Work', languages: ['en'], modules: { affiliates: true, creator_invitations: true } } },
    'GET /api/auth/me': { user: { username: 'root', display_name: 'Root', role: 'admin' } },
    'GET /api/admin/affiliates': {
      enabled: false, discounts: true, products: ['pro-monthly', 'pro-yearly'],
      rules: { creator: { offer: { type: 'percent', percent: 20 }, products: ['pro-yearly'], reward: { cash: 600, currency: 'EUR' }, payout_minimum: 3000 } },
      codes: [], totals: {},
    },
    'GET /api/admin/creator-invitations': {
      invitations: [
        pending,
        {
          id: 2, status: 'claimed', name: null, email: null, creator: true, pro_months: null, pro_until: null, uses: 1, used: 1,
          code: 'LEO20', ended: false, code_id: 7,
          created_at: '2026-11-20T10:00:00.000Z', expires_at: '2026-12-20T10:00:00.000Z', claimed_at: '2026-11-21T10:00:00.000Z',
          user: { id: 9, email: 'leo@example.com', display_name: 'Leo' },
        },
        { id: 1, status: 'expired', name: null, email: null, creator: true, pro_months: null, code: null, uses: 1, used: 0, ended: true, created_at: '2026-10-01T10:00:00.000Z', expires_at: '2026-10-31T10:00:00.000Z' },
        {
          id: 5, status: 'pending', name: 'Reddit r/mcp', email: null, creator: false, pro_months: null, pro_until: '2026-12-31T22:59:59.000Z',
          uses: 50, used: 3, code: null, ended: false, created_at: '2026-11-24T10:00:00.000Z', expires_at: '2026-12-24T10:00:00.000Z',
          link: 'https://work.example/i/ci_many',
        },
      ],
      defaults: {
        days: 30, pro_months: 12, offer: { type: 'percent', percent: 20 }, products: ['pro-yearly'], reward: { cash: 600, currency: 'EUR' },
        google: true, sample_data: false, password: true,
      },
    },
    'POST /api/admin/creator-invitations': { invitation: { ...pending, id: 4, name: 'Ada', email: 'ada@example.com', link: 'https://work.example/i/ci_new' } },
  };
  globalThis.fetch = async (path, { method = 'GET', body } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    if (method !== 'GET') sent.push([method, path, body ? JSON.parse(body) : null]);
    const answer = server[`${method} ${path}`];
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 201, json: async () => answer ?? { error: 'not_found' } };
  };
  await import('../web/admin.js');
  let main = null;
  for (let turn = 0; turn < 80 && (!(main = byId('admin-main')) || !main.find('table').length); turn++) await settle();

  assert.ok(main.find('h2').some((h) => h.textContent === english['admin.creatorInvites.title']));
  assert.ok(main.find('p').some((p) => p.textContent === english['admin.creatorInvites.lead'].replace('{days}', '30')));
  const rows = main.find('tr').slice(1).map((row) => row.childNodes.map((cell) => cell.textContent));
  assert.equal(rows.length, 3, 'the ended one is only counted');
  const [maria, leo, reddit] = rows;
  assert.match(reddit[0], /Reddit r\/mcp.*For 50 people/, 'a link for many, by its label');
  assert.match(reddit[1], /^Until /, 'Pro until a day');
  assert.equal(reddit[2], english['admin.creatorInvites.planOnly']);
  assert.match(reddit[3], /3 of 50 used/);
  assert.match(maria[0], /María López.*maria@example\.com/);
  assert.equal(maria[1], '12 months');
  assert.equal(maria[2], 'MARIA20');
  assert.match(maria[3], new RegExp(`^${english['admin.creatorInvites.status.pending']}`));
  assert.ok(maria[4].includes(english['admin.creatorInvites.copy']) && maria[4].includes(english['admin.creatorInvites.revoke']));
  assert.match(leo[0], /Leo.*leo@example\.com/, 'a claimed one by its account');
  assert.equal(leo[1], english['admin.creatorInvites.forever']);
  assert.ok(leo[4].includes(english['admin.affiliates.open']) && !leo[4].includes(english['admin.creatorInvites.copy']));
  assert.ok(main.find('p').some((p) => p.textContent === '1 more is over: only its email’s hash is kept.'));

  // A new one: whom, its Pro for good, the code, a raised reward.
  main.find('button').find((b) => b.textContent === english['admin.creatorInvites.new']).listeners.click[0]({ preventDefault() {} });
  await settle();
  const shown = document.body.all().find((node) => node.tagName === 'DIALOG' && node.open);
  assert.ok(shown, 'the dialog');
  const dialog = shown.find('form')[0];
  const inputs = dialog.find('input');
  const selects = dialog.find('select');
  inputs[0].value = 'Ada';
  inputs[1].value = 'ada@example.com';
  selects[0].value = 'forever';
  inputs.find((i) => i.getAttribute('placeholder') === 'MARIA20').value = 'ada10';
  const reward = inputs.find((i) => i.value === '6');
  reward.value = '10';
  dialog.dispatch('submit', { preventDefault() {} });
  for (let turn = 0; turn < 50 && !sent.length; turn++) await settle();
  const [[method, path, body]] = sent;
  assert.deepEqual([method, path], ['POST', '/api/admin/creator-invitations']);
  assert.deepEqual(body, {
    name: 'Ada', email: 'ada@example.com', creator: true, code: 'ada10', pro_months: null, campaign: null, note: null, days: 30,
    offer: { type: 'percent', percent: 20 }, products: ['pro-yearly'], reward: { cash: 1000, currency: 'EUR' },
  });
});
