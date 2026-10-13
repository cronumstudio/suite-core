/**
 * Settings › Your data in the browser (web/settings.js), without a browser: a copy brought in
 * with "replace", when it would take the person out of groups they share with other people. The
 * groups are named before anything changes, again in the confirmation, and only then does the
 * import go with `hand_over`. The server is a stand-in for the suite's routes; the texts are the
 * core's English catalog.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom, FakeElement } from './fake-dom.js';

const document = installFakeDom();
FakeElement.prototype.focus = function focus() {};
const listeners = {};
Object.assign(document, {
  addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
});
const reloaded = [];
globalThis.location = { href: 'https://app.example.com/', origin: 'https://app.example.com', reload: () => reloaded.push(true) };
globalThis.window = { location: globalThis.location };

const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
let routes = {};
const sent = [];
globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
  const path = String(url);
  if (path.startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
  // An upload is the file itself; everything else, JSON.
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;
  sent.push({ method, path, body: parsed });
  const route = routes[`${method} ${path}`];
  const { status = 200, data = {} } = (typeof route === 'function' ? route(parsed) : route) || { status: 404, data: { error: 'not_found' } };
  return { ok: status < 400, status, json: async () => data };
};

const { loadLanguage, t } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
const { openSettings } = await import('../web/settings.js');

const settle = () => new Promise((done) => setTimeout(done, 0));
const visibleText = (node) => node.textContent;
const PLAN = {
  import_id: 'imp_0123456789abcdef', mode: 'account', account: 'ben',
  copy: { id: 'x', scope: 'account', created_at: '2026-10-01T10:00:00.000Z', tables: { fam_people: 4 }, organizations: 1 },
  replace: { fam_notes: 1 },
  organizations: [{ source: { id: 1, name: 'Casa Andersen', kind: 'family', members: 1 }, choice: { action: 'create' } }],
};

async function dataPage(plan) {
  routes = {
    'POST /api/me/import': { data: plan },
    [`POST /api/me/import/${plan.import_id}`]: (body) => ({ data: { imported: { tables: { fam_people: 4 } }, received: body } }),
  };
  sent.length = 0;
  const root = document.createElement('div');
  const settings = openSettings({
    app: { id: 'fam', name: 'Fam' }, user: { username: 'ben', role: 'user' }, root, start: 'data',
    config: { app: { id: 'fam', modules: { data: true } } },
  });
  await settle();
  const file = root.all().find((node) => node.getAttribute('id') === 'kit-data-file');
  file.files = [{ name: 'ben.zip', type: 'application/zip', size: 10 }];
  file.dispatch('change');
  root.all().find((node) => node.tagName === 'BUTTON' && node.textContent === t('kit.data.check')).dispatch('click');
  await settle();
  await settle();
  return { root, settings };
}

test('“replace” names the groups it hands over, asks again with them, and only then sends hand_over', async () => {
  const { root, settings } = await dataPage({ ...PLAN, hand_over: [{ id: 7, name: 'Shared home', kind: 'family' }, { id: 8, name: 'Grandma’s', kind: 'family' }] });
  const line = t('kit.data.handOver', { names: 'Shared home and Grandma’s' });
  assert.match(line, /Shared home and Grandma’s/, 'the names, as people wrote them, in a list of the language');
  assert.ok(root.all().some((node) => node.tagName === 'P' && node.textContent === line), 'said before anything is chosen');

  const replace = root.all().find((node) => node.getAttribute('id') === 'kit-data-replace');
  replace.checked = true;
  root.all().find((node) => node.tagName === 'BUTTON' && node.textContent === t('kit.data.apply')).dispatch('click');
  await settle();
  const dialog = document.body.all().find((node) => node.tagName === 'DIALOG' && node.open);
  assert.ok(dialog, 'asked first');
  assert.match(visibleText(dialog), /Shared home and Grandma’s/, 'the confirmation names them too');
  assert.equal(sent.filter((r) => r.path.startsWith('/api/me/import/')).length, 0, 'nothing sent before the answer');
  dialog.all().find((node) => node.tagName === 'BUTTON' && node.textContent === t('kit.data.replaceButton')).dispatch('click');
  await settle();
  await settle();
  const applied = sent.find((r) => r.path === `/api/me/import/${PLAN.import_id}`);
  assert.deepEqual(applied.body, { replace: true, hand_over: [7, 8] }, 'the ids of the groups it showed');
  settings.close();
});

test('without groups to hand over, “replace” goes as before; and a cancelled confirmation sends nothing', async () => {
  const { root, settings } = await dataPage({ ...PLAN, hand_over: [] });
  assert.ok(!root.all().some((node) => node.tagName === 'P' && /takes you out of/.test(node.textContent)));
  const replace = root.all().find((node) => node.getAttribute('id') === 'kit-data-replace');
  replace.checked = true;
  const apply = root.all().find((node) => node.tagName === 'BUTTON' && node.textContent === t('kit.data.apply'));
  apply.dispatch('click');
  await settle();
  let dialog = document.body.all().find((node) => node.tagName === 'DIALOG' && node.open);
  dialog.all().find((node) => node.tagName === 'BUTTON' && node.textContent === t('kit.cancel')).dispatch('click');
  await settle();
  assert.equal(sent.filter((r) => r.path.startsWith('/api/me/import/')).length, 0, 'cancelled: nothing');

  apply.dispatch('click');
  await settle();
  dialog = document.body.all().find((node) => node.tagName === 'DIALOG' && node.open);
  dialog.all().find((node) => node.tagName === 'BUTTON' && node.textContent === t('kit.data.replaceButton')).dispatch('click');
  await settle();
  await settle();
  assert.deepEqual(sent.find((r) => r.path === `/api/me/import/${PLAN.import_id}`).body, { replace: true, hand_over: [] },
    'none shown: none, so the server refuses if some are there by now');
  settings.close();
});

test('an app whose copies carry no groups sends what it always did', async () => {
  const { hand_over: _none, ...plain } = PLAN;
  const { root, settings } = await dataPage({ ...plain, replace: { lists: 2 } });
  root.all().find((node) => node.getAttribute('id') === 'kit-data-replace').checked = true;
  root.all().find((node) => node.tagName === 'BUTTON' && node.textContent === t('kit.data.apply')).dispatch('click');
  await settle();
  const dialog = document.body.all().find((node) => node.tagName === 'DIALOG' && node.open);
  dialog.all().find((node) => node.tagName === 'BUTTON' && node.textContent === t('kit.data.replaceButton')).dispatch('click');
  await settle();
  await settle();
  assert.deepEqual(sent.find((r) => r.path === `/api/me/import/${PLAN.import_id}`).body, { replace: true });
  settings.close();
});

test('someone who has nothing of their own but shared groups can still choose “replace”, told what it does', async () => {
  const { root, settings } = await dataPage({ ...PLAN, replace: {}, hand_over: [{ id: 7, name: 'Shared home', kind: 'family' }] });
  assert.ok(root.all().find((node) => node.getAttribute('id') === 'kit-data-replace'), 'the choice is there');
  assert.ok(root.all().some((node) => node.tagName === 'P' && /Shared home/.test(node.textContent)));
  settings.close();
});
