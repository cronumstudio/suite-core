/**
 * The admin panel's accounts (web/admin.js › Users) on a fake page: where each plan comes from.
 * The install's default plan reads as such, never as one that was given; a gift says until when
 * and why; a subscription, where it is paid. The plan form sends its reason. The server is a
 * stand-in; the texts are the core's English catalog. A file of its own: admin.js starts the page
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

const PRO = { id: 'pro', name: 'Pro' };
const person = (id, username, more) => ({ id, username, display_name: username, role: 'user', email: null, providers: [], plan: PRO, plan_ends: null, unlimited: false, ...more });
const USERS = [
  person(1, 'ada', { plan_source: { kind: 'default' } }),
  person(2, 'ben', { plan_source: { kind: 'admin', ends: null, note: 'early tester' } }),
  person(3, 'cleo', { plan_ends: '2099-01-01T00:00:00.000Z', plan_source: { kind: 'subscription', provider: 'paddle', ends: '2099-01-01T00:00:00.000Z', note: null } }),
  person(4, 'dan', { plan_source: { kind: 'subscription', provider: 'stripe', ends: null, note: null, organization_id: 7 } }),
  // A server from before plan_source: the plan as it was.
  person(5, 'eve', {}),
];

test('Users: the default plan says it is the default, a gift for good and why, a subscription where it is paid; the reason goes with the plan', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  globalThis.window = { location: { hash: '#/users' }, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const sent = [];
  const server = {
    'GET /api/auth/config': { provider: 'local', app: { name: 'Work', languages: ['en'], modules: {} } },
    'GET /api/auth/me': { user: { username: 'root', display_name: 'Root', role: 'admin' } },
    'GET /api/admin/plans': { defaultPlan: 'pro', plans: [{ id: 'free', name: 'Free', features: {} }, { ...PRO, features: {} }], features: { 'lists.max': { type: 'limit', label: 'more lists' } }, several: true },
    'GET /api/admin/users': { users: USERS },
    'GET /api/admin/users/1/grants': { grants: [] },
    'PUT /api/admin/users/1/plan': USERS[0],
  };
  globalThis.fetch = async (path, { method = 'GET', body } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    sent.push({ method, path, body: typeof body === 'string' ? JSON.parse(body) : body });
    const answer = server[`${method} ${path}`];
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, json: async () => answer ?? { error: 'not_found' } };
  };
  await import('../web/admin.js');
  let main = null;
  for (let turn = 0; turn < 50 && !(main = byId('admin-main'))?.find('tr').length; turn++) await settle();

  const rows = main.find('tr').slice(1);   // under the header
  assert.equal(rows.length, USERS.length);
  const planCell = (row) => row.find('td')[3].childNodes.map((node) => node.textContent);
  assert.deepEqual(planCell(rows[0]), [t('admin.users.byDefault', { plan: 'Pro' })], 'Pro (by default), and nothing that reads as a gift');
  assert.deepEqual(planCell(rows[1]), ['Pro', t('admin.users.forever'), 'early tester']);
  assert.equal(planCell(rows[2]).length, 2);
  assert.match(planCell(rows[2]).join(' | '), /^Pro \| paid with Paddle · until .*2099/);
  assert.deepEqual(planCell(rows[3]), ['Pro', `${t('admin.users.viaProvider', { provider: 'Stripe' })} · ${t('admin.users.viaGroup')} · ${t('admin.users.forever')}`]);
  assert.deepEqual(planCell(rows[4]), ['Pro'], 'an older server: the plan alone, as before');

  // The dialog of the account on the default plan: it says so, and the plan form takes a reason.
  rows[0].dispatch('click');
  for (let turn = 0; turn < 20; turn++) await settle();
  const dialog = document.body.all().find((node) => node.tagName === 'DIALOG' && node.open);
  assert.ok(dialog, 'the account opens');
  assert.match(dialog.textContent, new RegExp(t('admin.users.planIsDefault', { plan: 'Pro' }).replace(/[()]/g, '\\$&')));
  const reasonIn = (box) => {
    const label = box.find('label').find((node) => node.textContent === t('admin.users.planNote'));
    return box.find('input').find((node) => node.id === label.getAttribute('for'));
  };
  const buttonIn = (box, key) => box.find('button').find((node) => node.textContent === t(key));
  assert.equal(buttonIn(dialog, 'admin.users.defaultPlan'), undefined, 'nothing to take back: it already is the default');
  const reason = reasonIn(dialog);
  assert.equal(reason.value, '');
  reason.value = '  lifetime, early tester ';
  buttonIn(dialog, 'admin.users.setPlan').dispatch('click');
  for (let turn = 0; turn < 10; turn++) await settle();
  const put = sent.find((r) => r.method === 'PUT');
  assert.deepEqual(put, { method: 'PUT', path: '/api/admin/users/1/plan', body: { plan: 'pro', ends_at: null, note: 'lifetime, early tester' } });
  dialog.close();

  // A gift's account: closed, each fold says what it holds and the plan's is open; its reason stays
  // in the form, it can be taken back, and the extras show what is in force, the rest under History.
  server['GET /api/admin/users/2/grants'] = { grants: [
    { id: 5, plan: null, feature: 'lists.max', value: '50', source: 'admin', ends_at: null, revoked_at: null, note: 'big project' },
    { id: 4, plan: 'pro', feature: null, value: null, source: 'admin', ends_at: null, revoked_at: null, note: 'early tester' },
    { id: 3, plan: 'pro', feature: null, value: null, source: 'admin', ends_at: null, revoked_at: '2026-10-20T00:00:00Z', note: null },
  ] };
  rows[1].dispatch('click');
  for (let turn = 0; turn < 20; turn++) await settle();
  const ben = document.body.all().find((node) => node.tagName === 'DIALOG' && node.open);
  const folds = ben.find('details').filter((node) => node.className === 'kit-fold');
  assert.deepEqual(folds.map((node) => node.find('summary')[0].childNodes.map((n) => n.textContent).filter(Boolean)),
    [[t('admin.users.profile'), t('admin.roles.user')], [t('admin.users.plan'), `Pro · ${t('admin.users.forever')}`],
      [t('admin.grants.title'), '1 in force'], [t('admin.users.password')]]);
  assert.deepEqual(folds.map((node) => node.hasAttribute('open')), [false, true, false, false], 'the plan, open');
  assert.equal(reasonIn(ben).value, 'early tester', 'changing the end keeps the reason');
  assert.ok(buttonIn(ben, 'admin.users.defaultPlan'), 'a gift can be taken back');
  const extras = folds[2];
  assert.deepEqual(extras.find('table')[0].find('tr').slice(1).map((row) => row.find('td')[0].textContent), [`${t('features.lists.max')}: 50big project`], 'the suite’s words for a common feature, in the admin’s language');
  assert.ok(extras.find('summary').some((node) => node.textContent === t('admin.grants.history', { n: 2 })), 'the plans and what was taken back');

  // Its profile's Save: grey with nothing changed, pressable once something is, and once saved
  // grey again with "Saved" beside it (the dialog covers the page's notices).
  const profile = folds[0];
  const save = buttonIn(profile, 'admin.save');
  const savedNote = profile.find('span').find((node) => node.className === 'kit-saved');
  assert.equal(save.disabled, true, 'nothing to save yet');
  assert.equal(savedNote.hidden, true);
  const nameInput = profile.find('input')[0];
  nameInput.value = 'Ben B.';
  nameInput.dispatch('input');
  assert.equal(save.disabled, false, 'a change to save');
  nameInput.value = 'ben';
  nameInput.dispatch('input');
  assert.equal(save.disabled, true, 'back as it was: nothing to save');
  nameInput.value = 'Ben B.';
  nameInput.dispatch('input');
  server['PATCH /api/admin/users/2'] = { ...USERS[1], display_name: 'Ben B.' };
  save.dispatch('click');
  for (let turn = 0; turn < 10; turn++) await settle();
  assert.equal(sent.find((r) => r.method === 'PATCH')?.body.display_name, 'Ben B.');
  assert.equal(save.disabled, true, 'saved: grey until the next change');
  assert.equal(savedNote.hidden, false);
  assert.match(savedNote.textContent, new RegExp(t('kit.saveState.saved')));
  nameInput.value = 'Ben';
  nameInput.dispatch('input');
  assert.equal(save.disabled, false);
  assert.equal(savedNote.hidden, true, 'a new change is not saved yet');
});
