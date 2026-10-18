/**
 * The admin panel (web/admin.js) on a fake page, with the server's answers by
 * path. A file of its own: admin.js starts the page as it is imported, so
 * each import here, with its own query, is a page load.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';

const document = installFakeDom();
let loads = 0;

/** The panel of an install with `config`, opened at a tab; its <main> once it has drawn. */
async function adminAt(tab, config, answers = {}) {
  const root = document.createElement('div');
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  globalThis.window = { location: { hash: `#/${tab}` }, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const server = { 'GET /api/auth/config': config, 'GET /api/auth/me': { user: { username: 'ada', display_name: 'Ada', role: 'admin' } }, ...answers };
  globalThis.fetch = async (path, { method = 'GET' } = {}) => {
    const answer = server[`${method} ${path}`];
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, json: async () => answer ?? { error: 'not_found' } };
  };
  await import(`../web/admin.js?load=${++loads}`);
  // It draws as its answers arrive: the tab is done when its last part is there.
  for (let turn = 0; turn < 50 && !byId('admin-main')?.find('p').some((node) => node.className === 'kit-empty'); turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return byId('admin-main');
}

test('Invitations: the notice that mail is off only when it is, and no "null" in its place when it isn\'t', async () => {
  const install = { provider: 'local', signup: 'invite', app: { name: 'Demo', languages: ['en'], modules: {} } };
  const answers = { 'GET /api/admin/invitations': { invitations: [] } };
  const shape = (main) => main.childNodes.map((child) => child.tagName || `text "${child.textContent}"`);

  const withMail = await adminAt('invitations', { ...install, mail: true }, answers);
  assert.deepEqual(shape(withMail), ['H2', 'P', 'DIV', 'DIV', 'DIV'], 'title, lead, the form, the result, the list');
  assert.doesNotMatch(withMail.textContent, /null/);

  const noMail = await adminAt('invitations', { ...install, mail: false }, answers);
  assert.deepEqual(shape(noMail), ['H2', 'P', 'P', 'DIV', 'DIV', 'DIV']);
  assert.ok(noMail.children[2].className.includes('kit-notice'), 'the notice, third');
});
