/**
 * The install's terms in the browser (web/terms.js) on a fake page: the box and its sentence with
 * one or both pages, the page of the terms (its «Continue» waiting for the box, accepting, signing
 * out), the box on the sign-in where it makes an account (signin-form.js), and the kit's client
 * going to that page when the server says `terms_required` (api.js).
 *
 *   npm test
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

const document = installFakeDom();
const storage = new Map();
globalThis.localStorage = globalThis.sessionStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
const went = [];
const page = {
  location: {
    href: 'https://work.example.com/', origin: 'https://work.example.com', pathname: '/', search: '', hash: '',
    replace: (url) => went.push(['replace', url]), assign: (url) => went.push(['assign', url]), reload: () => went.push(['reload']),
  },
  history: {
    state: null,
    replaceState: (state, title, url) => {
      const next = new URL(url, page.location.origin);
      Object.assign(page.location, { href: next.href, pathname: next.pathname, search: next.search });
    },
  },
  navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0', languages: ['en'] },
  addEventListener: () => {}, removeEventListener: () => {},
};
page.top = page.self = page;
globalThis.window = page;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: page.navigator });
globalThis.location = page.location;
const at = (where) => {
  const url = new URL(where, page.location.origin);
  Object.assign(page.location, { href: url.href, pathname: url.pathname, search: url.search, hash: url.hash });
};

const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
/** What the server answers, by path; every call is kept. */
let answers = {};
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
  let body;
  try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
  calls.push({ url: String(url), method: init.method || 'GET', body, headers: init.headers || {} });
  const [status, data] = answers[String(url)] || [404, { error: 'not_found' }];
  return { ok: status < 400, status, headers: new Map(), json: async () => data };
};

const { loadLanguage } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
const { termsBox, termsSentence, backOf, showTerms, TERMS_PATH } = await import('../web/terms.js');
const { signIn } = await import('../web/signin-form.js');
const { api, ApiError, SessionExpired } = await import('../web/api.js');

const LINKS = { terms: 'https://example.com/terms', privacy: 'https://example.com/privacy', version: '2026-12-08' };
const app = { name: 'Cronum Work', icon: '/icons/favicon.svg' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const ticked = (input, on = true) => { input.checked = on; input.dispatch('change'); };
const submitted = (form) => form.dispatch('submit', { preventDefault() {} });

beforeEach(() => {
  storage.clear();
  went.length = 0;
  calls.length = 0;
  answers = {};
  document.body.replaceChildren();
  at('/');
});

test('the box: a real checkbox named terms with its label, each page a link that opens apart; one page or none', () => {
  const box = termsBox(LINKS, { id: 'kit-x' });
  assert.equal(box.input.tagName, 'INPUT');
  assert.deepEqual(['type', 'id', 'name'].map((name) => box.input.getAttribute(name)), ['checkbox', 'kit-x', 'terms']);
  assert.equal(box.input.value, '1', 'posted ticked, the form says terms=1');
  const label = box.node.find('label')[0];
  assert.equal(label.getAttribute('for'), 'kit-x');
  assert.equal(label.textContent, 'I accept the terms and the privacy policy');
  const links = label.find('a');
  assert.deepEqual(links.map((a) => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel'), a.textContent]), [
    ['https://example.com/terms', '_blank', 'noopener', 'terms'], ['https://example.com/privacy', '_blank', 'noopener', 'privacy policy'],
  ]);
  assert.equal(termsBox({ terms: LINKS.terms }).node.textContent, 'I accept the terms');
  assert.equal(termsBox({ privacy: LINKS.privacy }).node.textContent, 'I accept the privacy policy');
  assert.equal(termsBox({}), null);
  assert.equal(termsBox(null), null);
  assert.equal(termsSentence({ terms: null, privacy: null }), null);
  const heard = [];
  const listened = termsBox(LINKS, { onChange: (on) => heard.push(on) });
  ticked(listened.input);
  ticked(listened.input, false);
  assert.deepEqual(heard, [true, false]);
});

test('where the page goes once they are accepted: a path of this site that isn’t the page itself, else /', () => {
  assert.equal(backOf(`?return=${encodeURIComponent('/tasks/?list=3#x')}`), '/tasks/?list=3#x');
  assert.equal(backOf(''), '/');
  for (const bad of ['//evil.example/', 'https://evil.example/', 'javascript:alert(1)', TERMS_PATH, `${TERMS_PATH}?return=/`, '/a b']) {
    assert.equal(backOf(`?return=${encodeURIComponent(bad)}`), '/', bad);
  }
});

test('the page: «Continue» waits for the box, records it and goes back; an error says itself; Sign out leaves', async () => {
  const root = document.createElement('div');
  const accepted = [];
  const gone = [];
  let left = 0;
  let fail = null;
  showTerms({
    app, root, back: '/notes/', answer: { required: true, ...LINKS },
    accept: async () => { accepted.push(true); if (fail) throw fail; return { required: false }; },
    go: (href) => gone.push(href), signOut: async () => { left += 1; return true; },
  });
  assert.match(root.textContent, /Before you start/);
  assert.match(root.textContent, /To use Cronum Work, tick the box below\./);
  const input = root.querySelector('input');
  const proceed = root.querySelector('[data-action="continue"]');
  const form = root.find('form')[0];
  assert.equal(proceed.hasAttribute('disabled') || proceed.disabled === true, true, 'waits for the box');
  submitted(form);
  await tick();
  assert.deepEqual(accepted, [], 'nothing sent without the box');
  ticked(input);
  assert.equal(proceed.disabled, false);
  ticked(input, false);
  assert.equal(proceed.disabled, true);
  ticked(input);

  fail = new ApiError(500, 'generic');
  submitted(form);
  await tick();
  const error = root.querySelector('.kit-error');
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /\S/);
  assert.equal(proceed.disabled, false, 'it can be tried again');

  fail = null;
  submitted(form);
  await tick();
  assert.deepEqual(gone, ['/notes/']);

  fail = new SessionExpired(401, 'unauthorized');
  submitted(form);
  await tick();
  assert.deepEqual(gone, ['/notes/', '/'], 'a session that ended: the sign-in again');

  root.querySelector('[data-action="sign-out"]').click();
  await tick();
  assert.equal(left, 1);
});

test('WorkOS’s card: with the install’s terms, the box goes before «Create an account», which is posted to /auth/login once ticked', async () => {
  // The card, not the provider's page at once.
  storage.set('suite.signedOut', '1');
  signIn({ app, config: { provider: 'workos', name: 'WorkOS', terms: LINKS } });
  const screen = document.body.childNodes.at(-1);
  const form = screen.find('form')[0];
  assert.equal(form.getAttribute('method'), 'post');
  assert.match(form.getAttribute('action'), /^\/auth\/login\?signup=1/);
  const input = form.querySelector('input');
  assert.equal(input.getAttribute('name'), 'terms');
  const make = form.querySelector('button');
  assert.equal(make.textContent, 'Create an account');
  assert.equal(make.hasAttribute('disabled'), true, 'waits for the box');
  ticked(input);
  assert.equal(make.disabled, false);
  // Signing in is as before: a link, no box in the way.
  assert.deepEqual(screen.querySelector('.kit-signin__card').querySelectorAll('a').filter((a) => /^\/auth\/login/.test(a.getAttribute('href') || ''))
    .map((a) => a.textContent), ['Sign in']);

  // Sent: the tick posted with fetch, and the provider's address it answers opened here (a form
  // redirected to another site would meet the pages' form-action 'self').
  const href = form.getAttribute('action');
  answers[href] = [200, { location: 'https://auth.example.com/user_management/authorize?screen_hint=sign-up' }];
  submitted(form);
  await tick();
  const sent = calls.find((c) => c.url === href);
  assert.deepEqual([sent.method, sent.body, sent.headers.Accept], ['POST', 'terms=1', 'application/json']);
  assert.deepEqual(went.at(-1), ['assign', 'https://auth.example.com/user_management/authorize?screen_hint=sign-up']);
  // No answer (the server in trouble, an older one): the provider's page all the same, asked after it.
  answers[href] = [500, { error: 'generic' }];
  make.disabled = false;
  submitted(form);
  await tick();
  assert.deepEqual(went.at(-1), ['assign', href]);
});

test('WorkOS’s card without terms: «Create an account» is the link it always was, and no box', () => {
  storage.set('suite.signedOut', '1');
  signIn({ app, config: { provider: 'workos', name: 'WorkOS' } });
  const screen = document.body.childNodes.at(-1);
  assert.equal(screen.find('form').length, 0);
  assert.equal(screen.find('input').length, 0);
  assert.deepEqual(screen.querySelector('.kit-signin__card').querySelectorAll('a').map((a) => a.textContent).filter((text) => /account|Sign in/.test(text)),
    ['Sign in', 'Create an account']);
});

test('a local sign-up: the box in its form, the button waits for it, and the account is made with it accepted', async () => {
  at('/?signup=invite-token');
  answers['/api/auth/signup'] = [201, { user: { id: 7, username: 'ana' } }];
  const made = signIn({ app, config: { provider: 'local', signup: 'invite', mail: true, terms: LINKS } });
  await tick();
  const screen = document.body.childNodes.at(-1);
  const form = screen.find('form')[0];
  const box = form.querySelector('input[name="terms"]');
  const create = form.querySelector('button[type="submit"]');
  assert.equal(create.hasAttribute('disabled') || create.disabled === true, true);
  form.querySelector('input[autocomplete="username"]').value = 'ana';
  form.querySelector('input[autocomplete="new-password"]').value = 'a-long-password-1';
  ticked(box);
  assert.equal(create.disabled, false);
  submitted(form);
  assert.deepEqual(await made, { id: 7, username: 'ana' });
  const sent = calls.find((c) => c.url === '/api/auth/signup');
  assert.equal(sent.body.accept_terms, true);
  assert.equal(sent.body.username, 'ana');
});

test('the kit’s client: `terms_required` takes the whole window to the page, back here after; on the page itself it is an error', async () => {
  at('/tasks/?list=3');
  answers['/api/lists'] = [403, { error: 'terms_required' }];
  const pending = api.get('/api/lists');
  const settled = await Promise.race([pending.then(() => 'settled', () => 'settled'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 20))]);
  assert.equal(settled, 'waiting', 'nothing behind it draws meanwhile');
  assert.deepEqual(went, [['assign', `/auth/terms?return=${encodeURIComponent('/tasks/?list=3')}`]]);

  at(TERMS_PATH);
  went.length = 0;
  await assert.rejects(api.get('/api/lists'), (err) => err instanceof ApiError && err.code === 'terms_required');
  assert.deepEqual(went, []);
  // Any other 403 is as before.
  answers['/api/lists'] = [403, { error: 'forbidden' }];
  await assert.rejects(api.get('/api/lists'), (err) => err.status === 403 && err.code === 'forbidden');
});
