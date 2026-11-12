/**
 * Users › New account (web/admin.js) on a fake page, with WorkOS: where the install owns the logins
 * (the sign-in answer's `manage`), a password makes one there and the admin's own password is asked
 * as they type it; a recent sign-in instead goes to sign in again when the server wants it; an
 * email WorkOS already has is said in the dialog. Where the install doesn't own them, no password
 * at all: the account waits for its person. No username anywhere: the server takes it from the
 * email. The server is a stand-in; the texts are the core's English catalog.
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
const hidden = (node) => node.hidden ?? node.hasAttribute('hidden');
const text = (key, vars = {}) => english[key].replace(/\{(\w+)\}/g, (_, name) => vars[name]);

test('Users › New account with WorkOS: a login there with the admin’s password again, or none where the install doesn’t own them', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  const location = { hash: '#/users', href: '/admin#/users' };
  globalThis.window = { location, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const posted = [];
  const answers = [];
  let signIn = { method: 'password', password: true, two_factor: { enabled: false }, manage: true, reauth: 'password' };
  const server = {
    'GET /api/auth/config': { provider: 'workos', name: 'WorkOS', app: { name: 'Work', languages: ['en'], modules: {} } },
    'GET /api/auth/me': { user: { id: 1, username: 'root', display_name: 'Root', role: 'admin' } },
    'GET /api/admin/plans': { defaultPlan: 'free', plans: [{ id: 'free', name: 'Free', features: {} }, { id: 'pro', name: 'Pro', features: {} }], features: {}, several: true },
    'GET /api/admin/users': { users: [] },
  };
  globalThis.fetch = async (path, { method = 'GET', body } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    if (path === '/api/admin/users/1/sign-in') return { ok: true, status: 200, json: async () => signIn };
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

  const open = async () => {
    main.find('button').find((b) => b.textContent === text('admin.users.new')).dispatch('click');
    await settle();
    const dialog = document.body.all().find((node) => node.tagName === 'DIALOG' && node.open);
    const control = (label) => {
      const node = dialog.find('label').find((l) => l.textContent === label);
      return node ? dialog.all().find((n) => n.id === node.getAttribute('for')) : null;
    };
    const error = () => dialog.find('p').find((p) => p.getAttribute('class') === 'kit-dialog__error').textContent;
    const submit = async () => { dialog.find('form')[0].dispatch('submit', { preventDefault() {} }); await settle(); };
    return { dialog, control, error, submit };
  };

  // Where the install owns the logins.
  const owner = await open();
  assert.ok(owner.dialog.find('p').some((p) => p.textContent === text('admin.users.newLeadWorkos', { provider: 'WorkOS' })));
  assert.equal(owner.control(english['fields.username']), null, 'no username: the server takes it from the email');
  const password = owner.control(english['fields.password']);
  assert.ok(password, 'a password for the login');
  assert.ok(owner.dialog.find('p').some((p) => p.textContent === text('admin.users.passwordHintWorkos', { provider: 'WorkOS' })));
  const mine = owner.control(english['admin.users.yourPassword']);
  const asked = mine.parentNode.parentNode.parentNode;
  assert.equal(hidden(asked), true, 'the admin’s own password only once one is typed');
  password.value = 'A-long-secret-1';
  password.dispatch('input');
  assert.equal(hidden(asked), false);
  assert.ok(asked.find('p').some((p) => p.textContent === text('admin.users.reauthCreate', { provider: 'WorkOS' })));

  owner.control(english['fields.email']).value = 'play.review@example.com';
  owner.control(english['fields.role']).value = 'user';
  mine.value = 'my-own-password';
  answers.push({ status: 409, body: { error: 'email_taken_provider', provider: 'WorkOS' } });
  await owner.submit();
  assert.equal(owner.error(), text('errors.email_taken_provider', { provider: 'WorkOS' }), 'a login WorkOS already has, said in the dialog');
  assert.equal(owner.dialog.open, true);
  assert.deepEqual(posted.at(-1), { email: 'play.review@example.com', role: 'user', password: 'A-long-secret-1', admin_password: 'my-own-password' },
    'no email_verified to send: the login’s is WorkOS’s');
  answers.push({ status: 201, body: { id: 5, username: 'play.review' } });
  await owner.submit();
  assert.equal(owner.dialog.open, false);

  // An admin who signs in with Google gives no password: a recent sign-in, or off to sign in again.
  signIn = { ...signIn, reauth: 'session' };
  const google = await open();
  assert.ok(google.control(english['fields.password']));
  assert.equal(google.control(english['admin.users.yourPassword']), null, 'nothing of their own to type');
  google.control(english['fields.email']).value = 'x@example.com';
  google.control(english['fields.password']).value = 'A-long-secret-1';
  answers.push({ status: 401, body: { error: 'reauth_required' } });
  await google.submit();
  assert.equal(location.href, '/auth/login', 'to sign in again, and back');
  google.dialog.close();

  // Where the install doesn't own them: no password, and the email is how the person is found.
  signIn = { method: 'password', password: true, two_factor: { enabled: false }, manage: false };
  const other = await open();
  assert.equal(other.control(english['fields.password']), null);
  assert.ok(other.dialog.find('p').some((p) => p.textContent === text('admin.users.idpEmailHint', { provider: 'WorkOS' })));
  other.control(english['fields.email']).value = 'later@example.com';
  other.control(english['fields.role']).value = 'user';
  answers.push({ status: 201, body: { id: 6, username: 'later' } });
  await other.submit();
  assert.deepEqual(posted.at(-1), { email: 'later@example.com', role: 'user' });
  assert.equal(other.dialog.open, false);
});
