/**
 * Signing in with a provider (WorkOS, OpenID Connect) at its page straight away, without this
 * site's card and its button first (Martin, 5/11: the app's card, then the provider's page of
 * another colour, read as one redirection too many): when it does, and when the card stays.
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
  history: {
    state: null,
    replaceState: (state, title, url) => {
      const next = new URL(url, page.location.origin);
      Object.assign(page.location, { href: next.href, pathname: next.pathname, search: next.search });
    },
  },
  navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0' },
  addEventListener: () => {}, removeEventListener: () => {},
};
page.top = page.self = page;
globalThis.window = page;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: page.navigator });
globalThis.location = page.location;

const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
globalThis.fetch = async (url) => {
  if (String(url).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
  return { ok: false, status: 404, headers: new Map(), json: async () => ({ error: 'not_found' }) };
};

const { loadLanguage } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
const { signIn, straightToProvider, leave } = await import('../web/signin.js');

const app = { name: 'Cronum Work', icon: '/icons/favicon.svg' };
const workos = { provider: 'workos', name: 'WorkOS' };
const at = (path) => {
  const url = new URL(path, page.location.origin);
  Object.assign(page.location, { href: url.href, pathname: url.pathname, search: url.search });
};
/** The card drawn, if any: its buttons' texts (not the signature's link) and its whole text. */
function card() {
  const screen = document.body.childNodes.at(-1);
  if (!screen) return null;
  const links = screen.querySelector('.kit-signin__card').querySelectorAll('a').map((a) => a.textContent);
  return { links, text: screen.textContent };
}

beforeEach(() => {
  storage.clear();
  went.length = 0;
  document.body.replaceChildren();
  at('/');
});

test('with WorkOS and nothing to say first, its page opens at once, coming back to where it was', () => {
  at('/tasks/?list=3');
  signIn({ app, config: workos });
  assert.deepEqual(went, [`/auth/login?return=${encodeURIComponent('/tasks/?list=3')}`]);
  // In place of the page, not after it: Back from the provider's page doesn't come here.
  assert.deepEqual(card().links, [], 'no card drawn on the way');
});

test('a second time within the minute the card stays, and its button no longer names WorkOS', () => {
  signIn({ app, config: workos });
  assert.equal(went.length, 1);
  document.body.replaceChildren();
  signIn({ app, config: workos });
  assert.equal(went.length, 1, 'no going round in circles (a session that never takes, or Back)');
  assert.deepEqual(card().links, ['Sign in', 'Create an account']);
  assert.doesNotMatch(card().text, /WorkOS/);
});

test('just after signing out here, the card, once', async () => {
  await leave({ answer: { logout_url: 'https://auth.example.com/logout' } });
  assert.equal(storage.get('suite.signedOut'), '1', 'leave() marks this tab');
  signIn({ app, config: workos });
  assert.deepEqual(went, [], 'whoever left sees the card, not the provider\'s page');
  assert.deepEqual(card().links, ['Sign in', 'Create an account']);
  assert.equal(storage.has('suite.signedOut'), false, 'the mark is read once');
  document.body.replaceChildren();
  signIn({ app, config: workos });
  assert.deepEqual(went, ['/auth/login']);
});

test('a failed return from the provider stays on the card, with why', () => {
  at('/?auth_error=failed');
  signIn({ app, config: workos });
  assert.deepEqual(went, []);
  assert.match(card().text, /Signing in could not be completed/);
  assert.equal(storage.has('suite.signInStraight'), false, 'the minute is not spent on a card');
});

test('an OpenID Connect provider opens at once too, and its card keeps its name', () => {
  const oidc = { provider: 'oidc', name: 'Authentik' };
  signIn({ app, config: oidc });
  assert.deepEqual(went, ['/auth/login']);
  document.body.replaceChildren();
  signIn({ app, config: oidc });
  assert.deepEqual(card().links, ['Sign in with Authentik']);
});

test('straightToProvider: never in a frame nor in the suite\'s app, once a minute, and the card without storage', () => {
  const kept = new Map();
  const box = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) };
  const now = 1_800_000_000_000;
  assert.equal(straightToProvider({ storage: box, now, framed: true, app: false }), false);
  assert.equal(straightToProvider({ storage: box, now, framed: false, app: true }), false);
  assert.equal(kept.size, 0, 'neither spends the minute');
  assert.equal(straightToProvider({ storage: box, now, framed: false, app: false }), true);
  assert.equal(straightToProvider({ storage: box, now: now + 50_000, framed: false, app: false }), false);
  assert.equal(straightToProvider({ storage: box, now: now + 60_001, framed: false, app: false }), true);
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => {}, removeItem: () => {} };
  assert.equal(straightToProvider({ storage: broken, now, framed: false, app: false }), false);
});
