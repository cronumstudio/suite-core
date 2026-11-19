/**
 * The admin panel (web/admin.js) asks before what is hard to take back: making someone an admin or
 * not, turning an account off, setting a password, and «Close their sessions», which ends their
 * tokens, assistants and phones too and says so (sc-ui-11). On a fake page, with the core's
 * English catalog. A file of its own: admin.js starts the page as it is imported.
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
const wait = async () => { for (let turn = 0; turn < 20; turn++) await settle(); };
const t = (key, vars = {}) => {
  const value = english[key];
  const text = typeof value === 'string' ? value : value[vars.n === 1 ? 'one' : vars.n === 0 && value['=0'] ? '=0' : 'other'];
  return text.replace(/\{(\w+)\}/g, (_, name) => vars[name]);
};

test('role, access, a password and closing their sessions are asked about first', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  globalThis.window = { location: { hash: '#/users', href: '/admin' }, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const ada = { id: 1, username: 'ada', display_name: 'Ada', role: 'user', email: 'ada@example.com', plan: null };
  const sent = [];
  globalThis.fetch = async (path, { method = 'GET', body } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    sent.push([`${method} ${path}`, body ? JSON.parse(body) : undefined]);
    const answer = {
      'GET /api/auth/config': { provider: 'local', app: { name: 'Work', languages: ['en'], modules: {} } },
      'GET /api/auth/me': { user: { id: 9, username: 'root', display_name: 'Root', role: 'admin' } },
      'GET /api/admin/users': { users: [ada] },
      'PATCH /api/admin/users/1': { ...ada, role: 'admin' },
      'DELETE /api/admin/users/1/sessions': { ok: true, closed: 2, tokens: 1 },
    }[`${method} ${path}`];
    return { ok: Boolean(answer), status: answer ? 200 : 404, json: async () => answer ?? { error: 'not_found' } };
  };
  await import('../web/admin.js');
  let main = null;
  for (let turn = 0; turn < 50 && !(main = byId('admin-main'))?.find('tr').length; turn++) await settle();
  const newest = () => document.body.all().filter((node) => node.tagName === 'DIALOG' && node.open).at(-1);
  const press = (dialog, text) => dialog.find('button').find((node) => node.textContent === text).dispatch('click');
  const writes = () => sent.filter(([what]) => !what.startsWith('GET '));
  main.find('tr')[1].dispatch('click');
  await wait();
  const account = newest();

  // Made an admin: asked, and «Cancel» keeps her a user, Save still there to press.
  const role = account.find('select')[0];
  role.value = 'admin';
  role.dispatch('change');
  press(account, t('admin.save'));
  await wait();
  let question = newest();
  assert.notEqual(question, account);
  assert.ok(question.textContent.includes(t('admin.users.roleAdminConfirm', { name: 'Ada', app: 'Work' })));
  press(question, english['kit.cancel']);
  await wait();
  assert.deepEqual(writes(), [], 'nothing saved');
  press(account, t('admin.save'));
  await wait();
  press(newest(), t('admin.save'));
  await wait();
  assert.deepEqual(writes().map(([what, body]) => [what, body.role]), [['PATCH /api/admin/users/1', 'admin']]);

  // A password: asked, saying it ends everything that lets her in.
  sent.length = 0;
  const password = account.find('input').find((node) => node.getAttribute('type') === 'password');
  password.value = 'a new one, long';
  press(account, t('admin.users.setPassword'));
  await wait();
  question = newest();
  assert.ok(question.textContent.includes(t('admin.users.passwordConfirm', { name: 'Ada' })));
  press(question, english['kit.cancel']);
  await wait();
  assert.deepEqual(writes(), []);

  // Closing her sessions: asked, and what went is said, all of it.
  press(account, t('admin.users.signOut'));
  await wait();
  question = newest();
  assert.ok(question.textContent.includes(t('admin.users.signOutConfirm', { name: 'Ada' })));
  press(question, t('admin.users.signOut'));
  await wait();
  assert.deepEqual(writes().map(([what]) => what), ['DELETE /api/admin/users/1/sessions']);
  const toasts = document.body.all().filter((node) => (node.className || '').split(' ').includes('kit-toast')).map((node) => node.textContent);
  assert.ok(toasts.some((text) => text.includes(t('admin.users.signedOut', { n: 2 })) && text.includes(t('admin.users.signedOutMore'))), toasts.join(' | '));
  delete globalThis.window;
});
