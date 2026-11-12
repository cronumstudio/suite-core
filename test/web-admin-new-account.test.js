/**
 * Users › New account (web/admin.js) on a fake page, with passwords here: the email first, the
 * username left to the server, the email sent as confirmed, the plan with its end and reason only
 * once one of its own is chosen, and what the server refuses said inside the dialog, which stays
 * open to be corrected. The server is a stand-in; the texts are the core's English catalog.
 * A file of its own: admin.js starts the page as it is imported.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

const document = installFakeDom();
const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
const settle = async (turns = 20) => { for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
/** Hidden as el() leaves it (an attribute) or as the page sets it later (the property, which a browser reflects). */
const hidden = (node) => node.hidden ?? node.hasAttribute('hidden');
const text = (key, vars = {}) => english[key].replace(/\{(\w+)\}/g, (_, name) => vars[name]);

test('Users › New account, passwords here: everything at once, the email confirmed, a refusal said in the dialog', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const byId = (id) => document.body.all().find((node) => node.getAttribute('id') === id) || root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  globalThis.window = { location: { hash: '#/users' }, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const posted = [];
  const answers = [{ status: 409, body: { error: 'email_taken' } }, { status: 201, body: { id: 9, username: 'tester' } }];
  const server = {
    'GET /api/auth/config': { provider: 'local', name: null, mail: true, password_min: 10, app: { name: 'Work', languages: ['en'], modules: {} } },
    'GET /api/auth/me': { user: { id: 1, username: 'root', display_name: 'Root', role: 'admin' } },
    'GET /api/admin/plans': { defaultPlan: 'free', plans: [{ id: 'free', name: 'Free', features: {} }, { id: 'pro', name: 'Pro', features: {} }], features: {}, several: true },
    'GET /api/admin/users': { users: [] },
  };
  globalThis.fetch = async (path, { method = 'GET', body } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    if (method === 'POST' && path === '/api/admin/users') {
      posted.push(JSON.parse(body));
      const { status, body: answer } = answers.shift();
      return { ok: status < 400, status, json: async () => answer };
    }
    const answer = server[`${method} ${path}`];
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, json: async () => answer ?? { error: 'not_found' } };
  };
  await import('../web/admin.js');
  let main = null;
  for (let turn = 0; turn < 50 && !(main = byId('admin-main'))?.find('button').length; turn++) await settle(1);

  main.find('button').find((b) => b.textContent === text('admin.users.new')).dispatch('click');
  await settle();
  const dialog = document.body.all().find((node) => node.tagName === 'DIALOG' && node.open);
  assert.ok(dialog, 'the dialog opens');
  assert.equal(dialog.find('h2')[0].textContent, text('admin.users.new'));
  assert.ok(dialog.find('p').some((p) => p.textContent === text('admin.users.newLeadLocal')), 'it says the email needs no confirming');
  const control = (label) => {
    const node = dialog.find('label').find((l) => l.textContent === label);
    assert.ok(node, `a field “${label}”`);
    // field() gives the control its id as a property, which a browser reflects and the fake page doesn't.
    return dialog.all().find((n) => n.id === node.getAttribute('for'));
  };
  const labels = dialog.find('label').map((l) => l.textContent);
  assert.deepEqual(labels.slice(0, 5), [english['fields.email'], english['fields.username'], english['fields.display_name'], english['fields.role'], english['fields.password']],
    'the email first');
  assert.ok(dialog.find('p').some((p) => p.textContent === text('admin.users.usernameHint')), 'the username may be left to the email');
  // The password with its eye: what is typed can be seen before creating.
  const typed = control(english['fields.password']);
  const eye = typed.parentNode.find('button')[0];
  assert.deepEqual([typed.parentNode.getAttribute('class'), eye.getAttribute('aria-label')], ['kit-password', english['kit.password.show']]);
  eye.dispatch('click');
  assert.equal(typed.getAttribute('type'), 'text');
  eye.dispatch('click');
  assert.equal(typed.getAttribute('type'), 'password');

  // The plan: the default one unless another is chosen; its end and reason only for one of its own.
  const plan = control(english['admin.users.planName']);
  assert.deepEqual(plan.find('option').map((o) => [o.getAttribute('value'), o.textContent]),
    [['', text('admin.users.newPlanDefault', { plan: 'Free' })], ['free', 'Free'], ['pro', 'Pro']]);
  const until = control(english['admin.users.planUntil']);
  const more = until.parentNode.parentNode;
  assert.equal(hidden(more), true, 'no end nor reason for the default plan');
  plan.value = 'pro';
  plan.dispatch('change');
  assert.equal(hidden(more), false);

  control(english['fields.email']).value = ' Tester@Example.com ';
  control(english['fields.display_name']).value = 'Fiverr tester';
  control(english['fields.role']).value = 'user';
  control(english['fields.password']).value = 'A-long-secret-1';
  until.value = '2027-01-31';
  control(english['admin.users.planNote']).value = 'Fiverr';

  const form = dialog.find('form')[0];
  form.dispatch('submit', { preventDefault() {} });
  await settle();
  const error = dialog.find('p').find((p) => p.getAttribute('class') === 'kit-dialog__error');
  assert.equal(error.textContent, english['errors.email_taken'], 'an email that has an account, said where it was typed');
  assert.equal(dialog.open, true, 'and the dialog stays open to correct it');
  assert.deepEqual(posted[0], {
    email: 'Tester@Example.com', display_name: 'Fiverr tester', role: 'user', password: 'A-long-secret-1', email_verified: true,
    plan: 'pro', ends_at: new Date('2027-01-31T23:59:59').toISOString(), note: 'Fiverr',
  }, 'no username: the server takes one from the email');

  form.dispatch('submit', { preventDefault() {} });
  await settle();
  assert.equal(posted.length, 2);
  assert.equal(dialog.open, false, 'made: the dialog goes');
});
