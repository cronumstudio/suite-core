/**
 * Signing out inside Cronum Work's one-document shell: one way out for every module (audit of 6/11,
 * work-web-1). A module's Settings signed out on its own, and deleted the other modules' queues
 * without a word.
 *
 *   npm test
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

installFakeDom();
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
    replace: (url) => went.push(url), reload: () => went.push('reload'),
  },
  navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0' },
  addEventListener: () => {}, removeEventListener: () => {},
};
page.top = page.self = page;
globalThis.window = page;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: page.navigator });
globalThis.location = page.location;

const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
const posted = [];
let logout = async () => ({ ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => ({}) });
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
  posted.push(String(url));
  if (String(url).endsWith('/api/auth/logout')) return logout(init);
  return { ok: false, status: 404, headers: new Map(), json: async () => ({ error: 'not_found' }) };
};

const { loadLanguage } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
const { signOut, signOutHere } = await import('../web/signin.js');

const REGISTRY = Symbol.for('cronum.work');

beforeEach(() => {
  delete document[REGISTRY];
  storage.clear();
  went.length = posted.length = 0;
});

test('in the shell the module’s sign-out is the shell’s, with its own clean-up, and the kit does nothing itself', async () => {
  const asked = [];
  document[REGISTRY] = { signOut: async (options) => { asked.push(options); return true; } };
  const local = { clearAll: async () => {} };
  const before = () => {};
  assert.equal(await signOut({ local, ask: true, before }), true, 'what the shell answers');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].local, local);
  assert.equal(asked[0].before, before);
  assert.deepEqual(posted, [], 'the server is the shell’s to tell');
  assert.deepEqual(went, []);
});

test('on any other page it signs out here, and `before` waits for the server', async () => {
  const order = [];
  logout = async () => {
    order.push('server');
    return { ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => ({}) };
  };
  assert.equal(await signOut({ before: () => order.push('before') }), true);
  assert.deepEqual(order, ['server', 'before']);
  assert.deepEqual(went, ['reload']);
});

test('the shell’s own way out doesn’t come back to itself', async () => {
  let calls = 0;
  document[REGISTRY] = { signOut: async () => { calls += 1; return true; } };
  assert.equal(await signOutHere(), true);
  assert.equal(calls, 0);
  assert.deepEqual(went, ['reload']);
});

test('without a signal nothing of the device goes, and the module’s clean-up doesn’t run', async () => {
  logout = async () => { throw new TypeError('Failed to fetch'); };
  let cleaned = false;
  assert.equal(await signOutHere({ before: () => { cleaned = true; } }), false);
  assert.equal(cleaned, false);
  assert.deepEqual(went, []);
});
