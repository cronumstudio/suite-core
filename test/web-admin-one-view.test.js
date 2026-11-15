/**
 * The admin panel (web/admin.js) asked for a view while another is on its way, as a tab chosen
 * after another or two saves of an account one after the other do: the page shows one view, the
 * last one asked for, never two one under the other (sc-ui-5). On a fake page, with the core's
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
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('two views asked for one after the other: the page shows the last one, once', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  const listeners = {};
  globalThis.window = {
    location: { hash: '#/users', href: '/admin' }, matchMedia: () => ({ matches: false }),
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  // The accounts are slow to come, the first time slower than the second.
  const delays = [60, 10];
  globalThis.fetch = async (path, { method = 'GET' } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    const body = {
      'GET /api/auth/config': { provider: 'local', app: { name: 'Work', languages: ['en'], modules: {} } },
      'GET /api/auth/me': { user: { username: 'root', display_name: 'Root', role: 'admin' } },
      'GET /api/admin/users': { users: [{ id: 1, username: 'ada', display_name: 'Ada', role: 'user', email: 'ada@example.com', plan: null }] },
    }[`${method} ${path}`];
    if (path === '/api/admin/users') await wait(delays.shift() ?? 0);
    return { ok: Boolean(body), status: body ? 200 : 404, json: async () => body ?? { error: 'not_found' } };
  };
  await import('../web/admin.js');
  for (let turn = 0; turn < 50 && !listeners.hashchange; turn++) await wait(0);
  assert.ok(listeners.hashchange, 'the panel listens to its address');
  // While the first view waits for the accounts, the same tab again (a save's refresh).
  listeners.hashchange();
  await wait(120);
  const main = byId('admin-main');
  assert.equal(main.find('h2').length, 1, 'one view');
  assert.equal(main.find('input').filter((node) => node.getAttribute('type') === 'search').length, 1, 'one search');
  assert.equal(main.find('tr').length, 2, 'its heading and Ada');
  delete globalThis.window;
});
