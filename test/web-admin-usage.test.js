/**
 * The admin panel's Usage (web/admin.js › Users) on a fake page: the list says how near each
 * account is to its nearest cap, and an account's dialog what it keeps in each module against its
 * plan, its storage and its calls from assistants, near and at a limit in words too. The server is
 * a stand-in (a host's answers, usage.js); the texts are the core's English catalog. A file of its
 * own: admin.js starts the page as it is imported.
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

const PRO = { id: 'pro', name: 'Pro' };
const person = (id, username) => ({ id, username, display_name: username, role: 'user', email: null, providers: [], plan: PRO, plan_ends: null, unlimited: false });
const days = Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, used: i === 29 ? 90 : i % 2 }));
const USAGE = {
  user_id: 1,
  modules: [
    { mount: 'tasks', name: 'Tasks', on: true, active_at: '2026-10-21T18:22:00.000Z', failed: false, bytes: 3 * 1024 * 1024,
      counts: [{ id: 'lists', count: 17, feature: 'lists.max', limit: 20, share: 0.85 }, { id: 'tasks', count: 340, feature: null, limit: null, share: null },
        { id: 'files', count: 7, feature: null, limit: null, share: null }] },
    { mount: 'notes', name: 'Notes', on: false, active_at: null, failed: true, counts: [], bytes: 0 },
    { mount: 'next', name: 'Next', on: true, active_at: null, failed: false, counts: [] },
  ],
  storage: { bytes: 3 * 1024 * 1024, files: 7, limit_mb: 50, share: 0.06 },
  mcp: { limit: 90, today: 90, share: 1, days, total: 104 },
  peak: { share: 1, id: 'mcp' },
};

test('Usage: each account’s nearest cap in the list, and in its dialog each module’s counts against the plan, the storage and the month of calls', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  globalThis.window = { location: { hash: '#/users' }, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const server = {
    'GET /api/auth/config': { provider: 'local', app: { name: 'Work', languages: ['en'], modules: {} } },
    'GET /api/auth/me': { user: { username: 'root', display_name: 'Root', role: 'admin' } },
    'GET /api/admin/plans': { defaultPlan: 'free', plans: [{ id: 'free', name: 'Free', features: {} }, { ...PRO, features: {} }], features: {}, several: true },
    'GET /api/admin/users': { users: [person(1, 'ada'), person(2, 'ben')] },
    'GET /api/admin/usage': { peaks: { 1: { share: 0.85, mount: 'tasks', name: 'Tasks', id: 'lists' }, 2: null } },
    'GET /api/admin/users/1/grants': { grants: [] },
    'GET /api/admin/users/1/usage': USAGE,
  };
  globalThis.fetch = async (path, { method = 'GET' } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    const answer = server[`${method} ${path}`];
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, json: async () => answer ?? { error: 'not_found' } };
  };
  await import('../web/admin.js');
  let main = null;
  for (let turn = 0; turn < 50 && !(main = byId('admin-main'))?.find('tr').length; turn++) await settle();
  for (let turn = 0; turn < 10; turn++) await settle();

  assert.equal(main.find('th').at(-1).textContent, t('admin.users.usage'));
  const rows = main.find('tr').slice(1);
  const usageCell = (row) => row.find('td').at(-1);
  assert.match(usageCell(rows[0]).textContent, /^85\s?%/);
  assert.match(usageCell(rows[0]).textContent, new RegExp(t('admin.usage.peakIn', { what: 'Lists', module: 'Tasks' })));
  assert.equal(usageCell(rows[0]).find('span').find((n) => n.getAttribute('role') === 'meter').getAttribute('aria-valuenow'), '85');
  assert.equal(usageCell(rows[1]).textContent, '—', 'no limits, nothing to be near');

  rows[0].dispatch('click');
  for (let turn = 0; turn < 20; turn++) await settle();
  const dialog = document.body.all().find((node) => node.tagName === 'DIALOG' && node.open);
  const fold = dialog.find('details').find((node) => node.find('summary')[0].textContent.startsWith(t('admin.usage.title')));
  assert.ok(fold, 'the account has its Usage');
  const now = fold.find('small').find((n) => (n.getAttribute('class') || '').includes('kit-fold__now'));
  assert.match(now.textContent, new RegExp(`^100\\s?% · ${t('admin.usage.mcp').replace(/[()]/g, '\\$&')}$`), 'the cap they are nearest to');
  assert.match(now.getAttribute('class'), /kit-fold__now--warn/);
  const text = fold.textContent;
  assert.match(text, /Lists17 of 20 · 85\s?%/);
  assert.match(text, new RegExp(t('admin.usage.near')), 'near the limit, in words');
  assert.match(text, /Tasks340/, 'a count without a limit, alone');
  assert.match(text, /Files7/);
  assert.match(text, new RegExp(t('admin.usage.off')), 'a module they turned off says so');
  assert.match(text, new RegExp(t('admin.usage.failed').replace(/[()]/g, '\\$&')));
  assert.match(text, new RegExp(t('admin.usage.nothing')));
  assert.match(text, /3 MB of 50 MB · 6\s?%/);
  assert.match(text, new RegExp(t('admin.usage.reached')), 'today’s calls at the limit, in words');
  assert.match(text, /Last 30 days: 104/);
  const bars = fold.find('div').find((n) => n.getAttribute('class') === 'kit-usage__days');
  assert.equal(bars.childNodes.length, 30);
  assert.equal(bars.childNodes.at(-1).getAttribute('style'), 'block-size: 100%', 'the busiest day reaches the top');
  assert.equal(bars.childNodes[0].getAttribute('class'), 'kit-usage__day--none', 'a day without calls is a stub');
  dialog.close();

  // Someone with no daily limit: their calls counted all the same, with no bar of a limit.
  server['GET /api/admin/users/2/grants'] = { grants: [] };
  server['GET /api/admin/users/2/usage'] = { ...USAGE, user_id: 2, mcp: { limit: null, today: 12, share: null, days, total: 104 }, peak: null };
  rows[1].dispatch('click');
  for (let turn = 0; turn < 20; turn++) await settle();
  const ben = document.body.all().find((node) => node.tagName === 'DIALOG' && node.open);
  const benText = ben.find('details').find((node) => node.find('summary')[0].textContent.startsWith(t('admin.usage.title'))).textContent;
  assert.match(benText, new RegExp(`${t('admin.usage.today')}12${t('admin.usage.noDailyLimit')}`));
  assert.match(benText, /Last 30 days: 104/);
  ben.close();
});
