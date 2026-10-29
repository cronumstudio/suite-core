/**
 * The admin panel deleting an account whose login is shared with other apps
 * (web/admin.js, `deletion_identity`): the confirmation says which other apps
 * the person uses, and only a ticked box deletes the login too. On a fake page,
 * with the core's English catalog. A file of its own: admin.js starts the page
 * as it is imported.
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

test('deleting someone whose login other apps share: they are named, and the login goes only when ticked', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  globalThis.window = { location: { hash: '#/users' }, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const sent = [];
  let others = ['Focus'];
  const server = {
    'GET /api/auth/config': { provider: 'workos', name: 'WorkOS', deletion_identity: true, app: { name: 'Work', languages: ['en'], modules: {} } },
    'GET /api/auth/me': { user: { username: 'root', display_name: 'Root', role: 'admin' } },
    'GET /api/admin/users': { users: [ADA] },
    'GET /api/admin/users/1/other-apps': () => ({ other_apps: others }),
    'DELETE /api/admin/users/1': { ok: true },
    'DELETE /api/admin/users/1?identity=1': { ok: true },
  };
  globalThis.fetch = async (path, { method = 'GET', body } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    sent.push(`${method} ${path}`);
    const route = server[`${method} ${path}`];
    const answer = typeof route === 'function' ? route(body) : route;
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, json: async () => answer ?? { error: 'not_found' } };
  };
  await import('../web/admin.js');
  let main = null;
  for (let turn = 0; turn < 50 && !(main = byId('admin-main'))?.find('tr').length; turn++) await settle();

  const newest = () => document.body.all().filter((node) => node.tagName === 'DIALOG' && node.open).at(-1);
  const deleteAda = async (tick) => {
    main.find('tr')[1].dispatch('click');
    for (let turn = 0; turn < 20; turn++) await settle();
    newest().find('button').find((node) => node.textContent === t('admin.users.delete')).dispatch('click');
    for (let turn = 0; turn < 20; turn++) await settle();
    const confirm = newest();
    const said = confirm.textContent;
    const box = confirm.find('input').find((node) => node.getAttribute('type') === 'checkbox');
    if (tick) box.checked = true;
    sent.length = 0;
    confirm.find('button').find((node) => node.className.split(' ').includes('kit-btn--danger')).dispatch('click');
    for (let turn = 0; turn < 20; turn++) await settle();
    return { said, box, deleted: sent.find((line) => line.startsWith('DELETE')) };
  };

  const kept = await deleteAda(false);
  assert.ok(kept.box, 'the choice is there');
  assert.ok(kept.said.includes(t('admin.users.identityGoes', { provider: 'WorkOS' })));
  assert.ok(kept.said.includes(t('admin.users.identityUsed', { apps: 'Focus' })), 'it names the other app');
  assert.equal(kept.deleted, 'DELETE /api/admin/users/1', 'unticked: the account here only');

  others = [];
  const gone = await deleteAda(true);
  assert.ok(gone.said.includes(t('admin.users.identityAlone')));
  assert.equal(gone.deleted, 'DELETE /api/admin/users/1?identity=1', 'ticked: the login too');
});
