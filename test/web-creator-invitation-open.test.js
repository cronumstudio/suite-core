/**
 * An invitation's page (web/creator-invitation.js) for a link that names nobody: the plan alone,
 * until a day. It greets anyone, says until when the plan lasts, asks for the email instead of
 * showing one, has no code to choose, and sends what was written; an email that has an account is
 * told to sign in with it. The server is a stand-in; the texts are the core's English catalog. A
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
const TOKEN = 'ci_opentokenopentokenopentoken';

test('a link for anyone: «Hi there», the plan until a day, the email to write and no code', async () => {
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
  globalThis.fetch = async (path, { method = 'GET', body } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    if (method !== 'GET') sent.push([method, path, JSON.parse(body)]);
    const answers = {
      'GET /api/auth/config': [200, { provider: 'workos', app: { name: 'Work', languages: ['en'], modules: {} } }],
      [`GET ${base}`]: [200, {
        status: 'pending', name: null, email: null, creator: false, pro_months: null, pro_until: '2026-12-31T22:59:59.000Z',
        expires_at: '2026-12-24T10:00:00.000Z', existing: null, signed_in: null, password: true, password_min: 10, google: false,
        sample_data: false, terms: null, privacy: null,
      }],
      [`POST ${base}/accept`]: [409, { error: 'account_exists' }],
      [`GET ${base}/sign-in?email=reader%40example.com`]: [200, { url: '/auth/login?hint=reader%40example.com' }],
    };
    const [status, answer] = answers[`${method} ${path}`] ?? [404, { error: 'not_found' }];
    return { ok: status < 300, status, json: async () => answer };
  };
  await import('../web/creator-invitation.js');
  for (let turn = 0; turn < 50 && !root.find('form').length; turn++) await settle();

  assert.equal(root.find('h1')[0].textContent, english['creatorInvite.helloAnyone']);
  assert.ok(root.find('p').some((p) => /^Pro free until /.test(p.textContent) && /2026/.test(p.textContent)), 'until when');
  const inputs = root.find('input');
  const email = inputs.find((i) => i.getAttribute('type') === 'email');
  assert.ok(!email.readOnly && email.getAttribute('readonly') == null, 'theirs to write');
  assert.equal(inputs.some((i) => i.getAttribute('id') === 'invite-code'), false, 'no code for the plan alone');
  const password = inputs.find((i) => i.getAttribute('type') === 'password');

  // No email: said before anything is sent.
  const form = root.find('form')[0];
  password.value = 'Reader-Pass-2026';
  form.listeners.submit[0]({ preventDefault() {} });
  await settle();
  assert.equal(sent.length, 0);
  assert.ok(root.find('p').some((p) => p.textContent === english['creatorInvite.emailNeeded'] && !p.hidden));

  // An email that has an account: told, and «Enter» signs in with it.
  email.value = 'reader@example.com';
  form.listeners.submit[0]({ preventDefault() {} });
  for (let turn = 0; turn < 50 && !root.find('p').some((p) => p.textContent.includes('already have an account')); turn++) await settle();
  assert.deepEqual(sent, [['POST', `${base}/accept`, { password: 'Reader-Pass-2026', email: 'reader@example.com', sample_data: false, locale: 'en' }]]);
  assert.ok(root.find('p').some((p) => p.textContent === english['creatorInvite.existing'].replace('{email}', 'reader@example.com')));
  root.find('form')[0].listeners.submit[0]({ preventDefault() {} });
  for (let turn = 0; turn < 50 && !went.length; turn++) await settle();
  assert.deepEqual(went, ['/auth/login?hint=reader%40example.com']);
});
