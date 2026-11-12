/**
 * Users › New account (web/admin.js) on a fake page, with WorkOS: where the install owns the logins
 * (the sign-in answer's `manage`), a password makes one there. The admin's own password isn't in
 * the form: when the server asks for it (`admin_confirm_required`) a dialog of its own does, over
 * the form, and the account is sent again; a wrong one is said in it; given up, the form stays as
 * it was. An admin who signs in with Google is confirmed before the form shows: asked to sign in
 * again, the panel goes to it with no form; confirmed, the form's accounts go in. An
 * email WorkOS already has is said in the form. Where the install doesn't own the logins, no
 * password at all. No username anywhere: the server takes it from the email. The server is a
 * stand-in; the texts are the core's English catalog.
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
const text = (key, vars = {}) => english[key].replace(/\{(\w+)\}/g, (_, name) => vars[name]);

test('Users › New account with WorkOS: the admin’s password asked apart when the server wants it, or none where the install doesn’t own logins', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  const location = { hash: '#/users', href: '/admin#/users' };
  globalThis.window = { location, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const sent = [];
  const answers = { '/api/admin/users': [], '/api/admin/confirm': [] };
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
    if (method === 'POST' && answers[path]) {
      sent.push({ path, body: JSON.parse(body) });
      const { status, body: answer } = answers[path].shift();
      return { ok: status < 400, status, json: async () => answer };
    }
    const answer = server[`${method} ${path}`];
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, json: async () => answer ?? { error: 'not_found' } };
  };
  await import('../web/admin.js');
  let main = null;
  for (let turn = 0; turn < 50 && !(main = byId('admin-main'))?.find('button').length; turn++) await settle(1);

  const opened = () => document.body.all().filter((node) => node.tagName === 'DIALOG' && node.open);
  const parts = (dialog) => {
    const control = (label) => {
      const node = dialog.find('label').find((l) => l.textContent === label);
      return node ? dialog.all().find((n) => n.id === node.getAttribute('for')) : null;
    };
    const error = () => dialog.find('p').find((p) => p.getAttribute('class') === 'kit-dialog__error').textContent;
    const submit = async () => { dialog.find('form')[0].dispatch('submit', { preventDefault() {} }); await settle(); };
    return { dialog, control, error, submit };
  };
  const open = async () => {
    main.find('button').find((b) => b.textContent === text('admin.users.new')).dispatch('click');
    await settle();
    return parts(opened().at(-1));
  };
  const fill = (form, email) => {
    form.control(english['fields.email']).value = email;
    form.control(english['fields.role']).value = 'user';
    form.control(english['fields.password']).value = 'A-long-secret-1';
  };

  // Where the install owns the logins: a password for the login, and none of the admin's own.
  const form = await open();
  assert.ok(form.dialog.find('p').some((p) => p.textContent === text('admin.users.newLeadWorkos', { provider: 'WorkOS' })));
  assert.equal(form.control(english['fields.username']), null, 'no username: the server takes it from the email');
  assert.ok(form.control(english['fields.password']), 'a password for the login');
  assert.equal(form.control(english['admin.users.yourPassword']), null, 'the admin’s own isn’t in the form');

  // The server wants it: a dialog of its own, over the form; a wrong one said there; then sent again.
  fill(form, 'play.review@example.com');
  answers['/api/admin/users'].push({ status: 403, body: { error: 'admin_confirm_required', reauth: 'password' } });
  answers['/api/admin/confirm'].push({ status: 403, body: { error: 'wrong_password' } }, { status: 200, body: { ok: true } });
  answers['/api/admin/users'].push({ status: 201, body: { id: 5, username: 'play.review' } });
  form.dialog.find('form')[0].dispatch('submit', { preventDefault() {} });
  await settle();
  assert.equal(opened().length, 2, 'over the form');
  const confirm = parts(opened().at(-1));
  assert.equal(confirm.dialog.find('h2')[0].textContent, english['admin.confirm.title']);
  assert.ok(confirm.dialog.find('p').some((p) => p.textContent === english['admin.confirm.lead']));
  assert.equal(confirm.control(english['admin.users.yourCode']), null, 'no code without a second step');
  assert.equal(confirm.control(english['admin.users.yourPassword']).parentNode.find('button')[0].getAttribute('aria-label'), english['kit.password.show'],
    'the admin’s own with its eye too');
  confirm.control(english['admin.users.yourPassword']).value = 'not-mine';
  await confirm.submit();
  assert.equal(confirm.error(), english['errors.wrong_password'], 'a wrong one, said where it was typed');
  assert.equal(confirm.dialog.open, true);
  confirm.control(english['admin.users.yourPassword']).value = 'my-own-password';
  await confirm.submit();
  await settle();
  assert.deepEqual(sent.map((s) => s.path), ['/api/admin/users', '/api/admin/confirm', '/api/admin/confirm', '/api/admin/users']);
  assert.deepEqual(sent[2].body, { admin_password: 'my-own-password' });
  assert.deepEqual(sent[0].body, sent[3].body, 'the same account sent again');
  assert.deepEqual(sent[3].body, { email: 'play.review@example.com', role: 'user', password: 'A-long-secret-1' },
    'no email_verified to send (the login’s is WorkOS’s), and no password of the admin’s');
  assert.equal(opened().length, 0, 'both gone: made');

  // The next one, within the ten minutes: straight in. An email WorkOS has is said in the form.
  const next = await open();
  fill(next, 'focus.person@example.com');
  answers['/api/admin/users'].push({ status: 409, body: { error: 'email_taken_provider', provider: 'WorkOS' } });
  await next.submit();
  assert.equal(opened().length, 1, 'no dialog asking for the password');
  assert.equal(next.error(), text('errors.email_taken_provider', { provider: 'WorkOS' }));
  answers['/api/admin/users'].push({ status: 201, body: { id: 6, username: 'apple.review' } });
  next.control(english['fields.email']).value = 'apple.review@example.com';
  await next.submit();
  assert.equal(opened().length, 0);

  // Given up: the form stays as it was, with nothing said against it.
  const quit = await open();
  fill(quit, 'later@example.com');
  answers['/api/admin/users'].push({ status: 403, body: { error: 'admin_confirm_required', reauth: 'password_code' } });
  await quit.submit();
  const asked = parts(opened().at(-1));
  assert.ok(asked.control(english['admin.users.yourCode']), 'with a second step, its code too');
  asked.dialog.find('button').find((b) => b.textContent === english['admin.cancel']).dispatch('click');
  await settle();
  assert.deepEqual(opened(), [quit.dialog]);
  assert.equal(quit.error(), '');
  quit.dialog.close();

  // An admin who signs in with Google gives no password: a sign-in made after the server asked,
  // which leaves the page, so it is asked before the form shows and nothing typed in it is lost.
  // Not signed in again since: off to it, with AuthKit asking again (prompt=login), and back to the
  // panel, with no form on the way.
  signIn = { ...signIn, reauth: 'session' };
  sent.length = 0;
  answers['/api/admin/confirm'].push({ status: 401, body: { error: 'reauth_required' } });
  await open();
  assert.deepEqual(sent, [{ path: '/api/admin/confirm', body: {} }], 'asked first, with nothing to give');
  assert.equal(opened().length, 0, 'no form');
  assert.equal(location.href, '/auth/login?prompt=login&return=%2Fadmin', 'to sign in again, and back');
  // Back from it: confirmed, then the form, whose account goes in with nothing more asked.
  location.href = '/admin#/users';
  sent.length = 0;
  answers['/api/admin/confirm'].push({ status: 200, body: { ok: true, until: new Date(Date.now() + 10 * 60 * 1000).toISOString() } });
  const google = await open();
  assert.ok(google.control(english['fields.password']), 'a password for the login');
  assert.equal(google.control(english['admin.users.yourPassword']), null, 'none of the admin’s');
  fill(google, 'x@example.com');
  answers['/api/admin/users'].push({ status: 201, body: { id: 8, username: 'x' } });
  await google.submit();
  assert.deepEqual(sent.map((s) => s.path), ['/api/admin/confirm', '/api/admin/users']);
  assert.equal(opened().length, 0, 'made');
  assert.equal(location.href, '/admin#/users', 'with no sign-in on the way');
  // Those minutes over with the form still open: off to sign in again, as before.
  answers['/api/admin/confirm'].push({ status: 200, body: { ok: true } });
  const late = await open();
  fill(late, 'y@example.com');
  answers['/api/admin/users'].push({ status: 401, body: { error: 'reauth_required' } });
  await late.submit();
  assert.equal(location.href, '/auth/login?prompt=login&return=%2Fadmin');
  late.dialog.close();

  // Where the install doesn't own them: no password, and the email is how the person is found.
  signIn = { method: 'password', password: true, two_factor: { enabled: false }, manage: false };
  const other = await open();
  assert.equal(other.control(english['fields.password']), null);
  assert.ok(other.dialog.find('p').some((p) => p.textContent === text('admin.users.idpEmailHint', { provider: 'WorkOS' })));
  other.control(english['fields.email']).value = 'later@example.com';
  other.control(english['fields.role']).value = 'user';
  answers['/api/admin/users'].push({ status: 201, body: { id: 7, username: 'later' } });
  await other.submit();
  assert.deepEqual(sent.at(-1).body, { email: 'later@example.com', role: 'user' });
  assert.equal(other.dialog.open, false);
});
