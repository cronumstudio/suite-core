/**
 * The admin panel's import of a whole install (web/admin.js › Data) on a fake page: an account
 * of the copy going into one here with "replace", when that would take it out of groups it shares
 * with other people. The groups are named under the choice and again in the confirmation. The
 * server is a stand-in; the texts are the core's English catalog. A file of its own: admin.js
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

const PLAN = {
  import_id: 'imp_0123456789abcdef', mode: 'install',
  copy: { id: 'x', scope: 'install', created_at: '2026-10-01T10:00:00.000Z', app: { name: 'Fam', version: '1.0.0' }, tables: { fam_people: 4 }, files: { count: 0 } },
  accounts: [{
    source: { id: 1, username: 'ben', display_name: 'Ben', email: 'ben@example.com', role: 'user', disabled: false },
    rows: { fam_notes: 1 }, choice: { action: 'map', user_id: 5, replace: false },
  }],
  targets: [{ id: 5, username: 'ben', display_name: 'Ben', email: 'ben@example.com', role: 'user', owns: {},
    hand_over: [{ id: 9, name: 'Shared here', kind: 'family' }, { id: 10, name: 'Grandma’s', kind: 'family' }] }],
  provider: 'local',
};

test('the administrator’s “replace” names the groups it takes the account out of, under the choice and in the confirmation', async () => {
  const root = document.createElement('div');
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  globalThis.window = { location: { hash: '#/data' }, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const sent = [];
  const server = {
    'GET /api/auth/config': { provider: 'local', app: { name: 'Fam', languages: ['en'], modules: { data: true } } },
    'GET /api/auth/me': { user: { username: 'ada', display_name: 'Ada', role: 'admin' } },
    'POST /api/admin/import': PLAN,
    [`POST /api/admin/import/${PLAN.import_id}`]: { accounts: [], imported: { tables: {}, files: 0 }, left_out: {}, file_tables: [] },
  };
  globalThis.fetch = async (path, { method = 'GET', body } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    sent.push({ method, path, body: typeof body === 'string' ? JSON.parse(body) : body });
    const answer = server[`${method} ${path}`];
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, json: async () => answer ?? { error: 'not_found' } };
  };
  await import('../web/admin.js');
  const t = (key, vars = {}) => english[key].replace(/\{(\w+)\}/g, (_, name) => vars[name]);
  let main = null;
  for (let turn = 0; turn < 50 && !(main = byId('admin-main'))?.find('input').length; turn++) await settle();

  const file = main.find('input').find((node) => node.getAttribute('type') === 'file');
  file.files = [{ name: 'install.zip', type: 'application/zip', size: 10 }];
  file.dispatch('change');
  main.find('button').find((node) => node.textContent === t('admin.data.upload')).dispatch('click');
  for (let turn = 0; turn < 20; turn++) await settle();

  const line = t('admin.data.handOver', { names: 'Shared here and Grandma’s' });
  assert.ok(main.find('p').some((node) => node.textContent === line), 'said under the choice');
  const replace = main.find('input').find((node) => node.getAttribute('type') === 'checkbox');
  assert.ok(replace, 'offered though it owns nothing of its own: it would leave groups');
  replace.checked = true;
  main.find('button').find((node) => node.textContent === t('admin.data.apply')).dispatch('click');
  await settle();
  const dialog = document.body.all().find((node) => node.tagName === 'DIALOG' && node.open);
  assert.ok(dialog, 'asked first');
  assert.match(dialog.textContent, /@ben also leaves Shared here and Grandma’s/);
  assert.equal(sent.filter((r) => r.path === `/api/admin/import/${PLAN.import_id}`).length, 0);
  dialog.all().find((node) => node.tagName === 'BUTTON' && node.textContent === english['kit.confirm']).dispatch('click');
  for (let turn = 0; turn < 10; turn++) await settle();
  assert.deepEqual(sent.find((r) => r.path === `/api/admin/import/${PLAN.import_id}`).body,
    { accounts: [{ source: 1, user_id: 5, replace: true }] });
});
