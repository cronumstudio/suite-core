/**
 * Taking someone's second step off at WorkOS, from their account in the admin panel (web/admin.js),
 * as an admin with no password to give (Google, Apple, a company's sign-in: `reauth: 'session'`):
 * when the server wants a sign-in made after it asked (`reauth_required`), the panel says so and
 * goes to it, with AuthKit asking again instead of taking its own session (`prompt=login`), and
 * back to the panel. On a fake page, with the core's English catalog. A file of its own: admin.js
 * starts the page as it is imported.
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

test('an admin who signs in with Google takes someone’s second step off: asked to sign in again, the panel goes to it and back', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  globalThis.window = { location: { hash: '#/users', href: '/admin' }, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const sent = [];
  // What each request answers: { status, body }, or a body for a 200.
  const server = {
    'GET /api/auth/config': { provider: 'workos', name: 'WorkOS', app: { name: 'Work', languages: ['en'], modules: {} } },
    'GET /api/auth/me': { user: { id: 9, username: 'root', display_name: 'Root', role: 'admin' } },
    'GET /api/admin/users': { users: [ADA] },
    // Ada lost her phone. The admin signs in with Google: nothing of theirs to type, a fresh sign-in instead.
    'GET /api/admin/users/1/sign-in': { method: 'password', password: true, two_factor: { enabled: true }, manage: true, reauth: 'session' },
    'DELETE /api/admin/users/1/sign-in/two-factor': { status: 401, body: { error: 'reauth_required' } },
  };
  globalThis.fetch = async (path, { method = 'GET', body } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    sent.push({ call: `${method} ${path}`, body: body === undefined ? undefined : JSON.parse(body) });
    const route = server[`${method} ${path}`];
    const { status, body: answer } = route === undefined ? { status: 404, body: { error: 'not_found' } }
      : 'status' in route ? route : { status: 200, body: route };
    return { ok: status < 400, status, json: async () => answer };
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
  const off = account.find('button').find((node) => node.textContent === t('admin.users.twoFactorOff'));
  assert.ok(off, 'her second step can be taken off');
  assert.equal(account.find('input').filter((node) => node.getAttribute('autocomplete') === 'current-password').length, 0,
    'no password of the admin’s to give');

  off.dispatch('click');
  await wait();
  const question = newest();
  assert.ok(question.textContent.includes(t('admin.users.twoFactorOffConfirm', { name: 'Ada' })));
  question.find('button').find((node) => node.className.split(' ').includes('kit-btn--danger')).dispatch('click');
  await wait();
  assert.deepEqual(sent.filter((s) => s.call.startsWith('DELETE')), [{ call: 'DELETE /api/admin/users/1/sign-in/two-factor', body: {} }]);
  assert.deepEqual(errors(), [english['errors.reauth_required']], 'said as it goes');
  assert.equal(window.location.href, '/auth/login?prompt=login&return=%2Fadmin', 'to sign in again, with AuthKit asking, and back here');
});
