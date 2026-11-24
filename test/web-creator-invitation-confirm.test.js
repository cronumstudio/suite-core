/**
 * An invitation's page (web/creator-invitation.js) when the email was one they wrote: the identity
 * provider mailed a code to confirm it, and the page asks for it there and then, instead of sending
 * them to the provider's page, where someone else's session could answer. A wrong code is said and
 * can be typed again; the right one opens the app; one that can't be used any more sends them to
 * sign in with that email. The server is a stand-in; the texts are the core's English catalog. A
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
const TOKEN = 'ci_confirmtokenconfirmtoken';

test('an email they wrote: the code it just got asked for on the page, then the app', async () => {
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
  let confirmAnswer = [400, { error: 'confirm_code_wrong' }];
  globalThis.fetch = async (path, { method = 'GET', body } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    if (method !== 'GET') sent.push([method, path, JSON.parse(body)]);
    const answers = {
      'GET /api/auth/config': [200, { provider: 'workos', app: { name: 'Work', languages: ['en'], modules: {} } }],
      [`GET ${base}`]: [200, {
        status: 'pending', name: null, email: null, creator: false, pro_months: 1, pro_until: null,
        expires_at: '2026-12-24T10:00:00.000Z', existing: null, signed_in: null, password: true, password_min: 10, google: false,
        sample_data: false, terms: null, privacy: null,
      }],
      [`POST ${base}/accept`]: [200, { plan: 'pro', signed_in: false, confirm: { id: 'wait-id', email: 'ana@example.com' } }],
      [`POST ${base}/confirm`]: confirmAnswer,
    };
    const [status, data] = answers[`${method} ${path}`] ?? [404, { error: 'not_found' }];
    return { ok: status < 400, status, json: async () => data };
  };
  await import('../web/creator-invitation.js');
  for (let turn = 0; turn < 50 && !root.find('form').length; turn++) await settle();

  const inputs = root.find('input');
  inputs.find((i) => i.getAttribute('type') === 'email').value = 'ana@example.com';
  inputs.find((i) => i.getAttribute('type') === 'password').value = 'Creator-Pass-2026';
  root.find('form')[0].listeners.submit[0]({ preventDefault() {} });
  for (let turn = 0; turn < 50 && !root.find('input').some((i) => i.getAttribute('id') === 'invite-confirm'); turn++) await settle();

  // The code's screen: what to do, where it went, and no trip to the provider's page.
  assert.deepEqual(went, [], 'still on the page');
  assert.ok(root.find('p').some((p) => p.textContent === english['creatorInvite.confirmTitle']));
  assert.ok(root.find('p').some((p) => p.textContent === english['creatorInvite.confirmText'].replace('{email}', 'ana@example.com')));
  const code = root.find('input').find((i) => i.getAttribute('id') === 'invite-confirm');
  assert.equal(code.getAttribute('autocomplete'), 'one-time-code');
  assert.equal(code.getAttribute('inputmode'), 'numeric');
  const form = root.find('form')[0];

  // Not six digits: said here, nothing sent.
  sent.length = 0;
  code.value = '12a';
  form.listeners.submit[0]({ preventDefault() {} });
  await settle();
  assert.equal(sent.length, 0);
  const error = () => root.find('p').find((p) => p.getAttribute('role') === 'alert');
  assert.equal(error().textContent, english['errors.confirm_code_wrong']);

  // A wrong one: the server says so, and they type again.
  code.value = '000000';
  form.listeners.submit[0]({ preventDefault() {} });
  for (let turn = 0; turn < 50 && sent.length < 1; turn++) await settle();
  await settle();
  assert.deepEqual(sent, [['POST', `${base}/confirm`, { id: 'wait-id', code: '000000' }]]);
  assert.equal(error().hidden, false);
  assert.deepEqual(went, []);

  // The right one, with a space as an email may show it: the app, signed in.
  confirmAnswer = [200, { signed_in: true }];
  code.value = '123 456';
  form.listeners.submit[0]({ preventDefault() {} });
  for (let turn = 0; turn < 50 && !went.length; turn++) await settle();
  assert.deepEqual(sent.at(-1), ['POST', `${base}/confirm`, { id: 'wait-id', code: '123456' }]);
  assert.deepEqual(went, ['/']);

  // One that can't be used any more: signing in with that email, which mails a new one.
  confirmAnswer = [410, { error: 'confirm_expired' }];
  went.length = 0;
  code.value = '123456';
  form.listeners.submit[0]({ preventDefault() {} });
  for (let turn = 0; turn < 50 && !went.length; turn++) await settle();
  assert.deepEqual(went, ['/auth/login?return=%2F&hint=ana%40example.com']);
});
