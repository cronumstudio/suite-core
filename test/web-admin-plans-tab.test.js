/**
 * The admin panel's Plans (web/admin.js › Plans) on a fake page: in a host, the host's own catalog
 * (its one MCP) and, under it, each module's, with the same plans; an app on its own, its catalog
 * alone. The server is a stand-in; the texts are the core's English catalog. A file of its own:
 * admin.js starts the page as it is imported.
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

test('Plans: the host’s calls from assistants, then each module’s limits, a column per plan', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  globalThis.window = { location: { hash: '#/plans' }, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const plans = (free, pro) => [{ id: 'free', name: 'Free', features: free }, { id: 'pro', name: 'Pro', features: pro }];
  const server = {
    'GET /api/auth/config': { provider: 'local', app: { name: 'Work', languages: ['en'], modules: {} } },
    'GET /api/auth/me': { user: { username: 'root', display_name: 'Root', role: 'admin' } },
    'GET /api/admin/plans': {
      defaultPlan: 'free', several: true,
      features: { 'mcp.calls_per_week': { type: 'limit', label: 'calls from an assistant per week' } },
      plans: plans({ 'mcp.calls_per_week': 100 }, { 'mcp.calls_per_week': 2000 }),
    },
    'GET /api/admin/plans/modules': { modules: [
      {
        mount: 'tasks', name: 'Tasks',
        features: { 'lists.max': { type: 'limit', label: 'own lists' }, sharing: { type: 'flag', label: 'sharing lists' }, gizmos: { type: 'flag', label: 'gizmos' } },
        plans: plans({ 'lists.max': 20, sharing: true, gizmos: false }, { 'lists.max': null, sharing: true, gizmos: true }),
      },
      { mount: 'notes', name: 'Notes', features: { 'notebooks.max': { type: 'limit', label: 'more notebooks' } }, plans: plans({ 'notebooks.max': 10 }, { 'notebooks.max': null }) },
    ] },
  };
  globalThis.fetch = async (path, { method = 'GET' } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    const answer = server[`${method} ${path}`];
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, json: async () => answer ?? { error: 'not_found' } };
  };
  await import('../web/admin.js');
  let main = null;
  for (let turn = 0; turn < 50 && (!(main = byId('admin-main')) || main.find('table').length < 3); turn++) await settle();

  assert.deepEqual(main.find('h3').map((node) => node.textContent), ['Work', 'Tasks', 'Notes'], 'the host, then each module by its name');
  const cells = (table) => table.find('tr').map((row) => row.childNodes.map((cell) => cell.textContent));
  const [own, tasks, notes] = main.find('table');
  assert.deepEqual(cells(own), [
    [english['admin.plans.feature'], `Free · ${english['admin.plans.default']}`, 'Pro'],
    [english['features.mcp.calls_per_week'], '100', '2000'],
  ]);
  assert.deepEqual(cells(tasks).slice(1), [
    [english['features.lists.max'], '20', english['admin.plans.noLimit']],
    [english['features.sharing'], english['admin.plans.yes'], english['admin.plans.yes']],
    // A feature the suite has no words for: the module's own label.
    ['gizmos', english['admin.plans.no'], english['admin.plans.yes']],
  ]);
  assert.deepEqual(cells(notes).slice(1), [[english['features.notebooks.max'], '10', english['admin.plans.noLimit']]]);
  assert.equal(main.find('p').some((node) => node.textContent === english['admin.plans.nothingToLimit']), false);
});
