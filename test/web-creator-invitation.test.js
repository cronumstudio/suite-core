/**
 * A creator's invitation's page (web/creator-invitation.js, /i/<token>) on a fake page: the greeting,
 * the email fixed, the password, the code written already and checked as it changes (a free one
 * offered when it is taken), the sample data's box, «Enter» with what was chosen, and the terms'
 * line with its two links. The server is a stand-in; the texts are the core's English catalog. A
 * file of its own: the page starts as it is imported.
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
const TOKEN = 'ci_tokentokentokentokentoken';

test('the page: whom it is for, the code checked as it changes, and «Enter» with the password and what was chosen', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  document.querySelector = (selector) => (selector === '#invitation' ? root : null);
  document.querySelectorAll = () => [];
  const went = [];
  globalThis.window = {
    location: { pathname: `/i/${TOKEN}`, search: '', hash: '', href: `http://work.example/i/${TOKEN}`, replace: (url) => went.push(url), assign: (url) => went.push(url) },
    addEventListener: () => {}, matchMedia: () => ({ matches: false }), history: { replaceState: () => {} },
  };
  const sent = [];
  const base = `/api/creator-invitations/${TOKEN}`;
  const server = {
    'GET /api/auth/config': { provider: 'workos', app: { name: 'Work', languages: ['en'], modules: {} } },
    [`GET ${base}`]: {
      status: 'pending', name: 'María López', email: 'maria@example.com', creator: true, code: 'MARIA20', pro_months: 12, pro_until: null,
      expires_at: '2026-12-24T10:00:00.000Z', offer: { type: 'percent', percent: 20 }, reward: { cash: 600, currency: 'EUR' },
      products: ['pro-yearly'], existing: null, signed_in: null, password: true, password_min: 10, google: true, sample_data: true,
      terms: 'https://example.com/terms/', privacy: { en: 'https://example.com/privacy/', es: 'https://example.com/es/privacy/' },
    },
    [`GET ${base}/code?code=MARIA`]: { valid: true, available: false, code: 'MARIA', suggestion: 'MARIA2' },
    [`POST ${base}/accept`]: { code: 'MARIA2', discount: true, plan: 'pro', plan_ends: '2027-11-24T10:00:00.000Z', sample_data: true, signed_in: true },
  };
  globalThis.fetch = async (path, { method = 'GET', body } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    if (method !== 'GET') sent.push([method, path, JSON.parse(body)]);
    const answer = server[`${method} ${path}`];
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, json: async () => answer ?? { error: 'not_found' } };
  };
  await import('../web/creator-invitation.js');
  for (let turn = 0; turn < 50 && !root.find('form').length; turn++) await settle();

  assert.equal(root.find('h1')[0].textContent, 'Hi, María López.');
  assert.ok(root.find('p').some((p) => p.textContent === english['creatorInvite.ready']));
  assert.ok(root.find('p').some((p) => p.textContent === 'Pro free for 12 months.'));
  const inputs = root.find('input');
  const email = inputs.find((i) => i.getAttribute('type') === 'email');
  assert.equal(email.value, 'maria@example.com');
  assert.ok(email.readOnly || email.getAttribute('readonly') != null, 'the email is fixed');
  const password = inputs.find((i) => i.getAttribute('type') === 'password');
  assert.equal(password.getAttribute('autocomplete'), 'new-password');
  const code = inputs.find((i) => i.getAttribute('id') === 'invite-code');
  assert.equal(code.value, 'MARIA20');
  const sample = inputs.find((i) => i.getAttribute('type') === 'checkbox');
  assert.ok(sample, 'the sample data’s box');
  assert.ok(root.find('span').some((s) => s.textContent === english['creatorInvite.sample']));
  // The terms' line, its links where its placeholders were.
  const links = root.find('a').map((a) => [a.textContent, a.getAttribute('href')]);
  assert.deepEqual(links.filter(([, href]) => href?.startsWith('https://example.com')), [
    [english['creatorInvite.terms'], 'https://example.com/terms/'], [english['creatorInvite.privacy'], 'https://example.com/privacy/'],
  ]);
  assert.ok(root.find('button').some((b) => b.textContent === english['creatorInvite.google']));

  // Typed with a dash and in lower case: as a code is kept, checked, and a free one offered.
  code.value = 'mar-ia';
  code.dispatch('input');
  assert.equal(code.value, 'MARIA');
  for (let turn = 0; turn < 60 && !root.find('button').some((b) => b.textContent === 'Use MARIA2'); turn++) await new Promise((r) => setTimeout(r, 20));
  const use = root.find('button').find((b) => b.textContent === 'Use MARIA2');
  assert.ok(use, 'the free one offered');
  use.listeners.click[0]({ preventDefault() {} });
  assert.equal(code.value, 'MARIA2');

  // A password too short is said here, before anything is sent.
  const form = root.find('form')[0];
  password.value = 'short';
  form.listeners.submit[0]({ preventDefault() {} });
  await settle();
  assert.equal(sent.length, 0);
  assert.ok(root.find('p').some((p) => p.textContent === 'At least 10 characters.' && !p.hidden));

  password.value = 'Creator-Pass-2026';
  sample.checked = true;
  form.listeners.submit[0]({ preventDefault() {} });
  for (let turn = 0; turn < 50 && !went.length; turn++) await settle();
  assert.deepEqual(sent, [['POST', `${base}/accept`, { password: 'Creator-Pass-2026', code: 'MARIA2', sample_data: true, locale: 'en' }]]);
  assert.deepEqual(went, ['/'], 'into the app, signed in');
});
