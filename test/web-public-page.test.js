/**
 * A public page's dialog (web/public-page.js), without a browser: it reads the page without
 * turning it on, turns it on and off through its route, shows the code to embed it only on a plan
 * that embeds, copies saying so once, and takes the module's words. The texts are the core's
 * English catalog. And the page's stylesheet: the bar's phone rule (tasks-web-8).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom, FakeElement } from './fake-dom.js';

const document = installFakeDom();
FakeElement.prototype.focus = function focus() {};
FakeElement.prototype.select = function select() {};
Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {} });
globalThis.location = { href: 'https://app.example.com/', origin: 'https://app.example.com', pathname: '/', reload: () => {} };
globalThis.window = { location: globalThis.location, getSelection: () => ({ selectAllChildren() {} }) };

const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });

const { loadLanguage, t } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
const { publicDialog, embedCode, EMBED_HEIGHT } = await import('../web/public-page.js');

const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((done) => setTimeout(done, 0)); };
const openDialogs = () => document.body.all().filter((node) => node.tagName === 'DIALOG' && node.open);
const button = (root, text) => root.all().find((node) => node.tagName === 'BUTTON' && node.textContent === text);
const byClass = (root, name) => root.all().filter((node) => (node.getAttribute?.('class') || '').split(/\s+/).includes(name));
const closeAll = () => openDialogs().forEach((d) => d.close());
const toasts = () => document.body.all().filter((node) => node.getAttribute?.('role') === 'status' && (node.getAttribute?.('class') || '').split(/\s+/).includes('kit-toast'));

const LINK = 'https://app.example.com/shared.html?p=abcdefghijklmnopqrstuvwxyz012345';

/** The page's route as public-page.js answers it, recording what the dialog asks. */
function server({ on = false, embed = false } = {}) {
  const state = { url: on ? LINK : null, embed };
  const calls = [];
  globalThis.fetch = async (url, { method = 'GET' } = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    calls.push([method, path]);
    if (method === 'POST') state.url = LINK;
    if (method === 'DELETE') state.url = null;
    const answer = method === 'DELETE' ? { ok: true } : { url: state.url, since: state.url ? '2026-11-13T10:00:00Z' : null, embed: state.embed };
    return { ok: true, status: 200, json: async () => answer };
  };
  return { state, calls };
}

test('embedCode: the page\'s link with embed=1, escaped, as tall as asked', () => {
  const code = embedCode(LINK, 'Tom & "Jerry" <3');
  assert.match(code, /^<iframe src="https:\/\/app\.example\.com\/shared\.html\?p=[\w]+&amp;embed=1"/);
  assert.match(code, /title="Tom &amp; &quot;Jerry&quot; &lt;3"/);
  assert.match(code, new RegExp(`height="${EMBED_HEIGHT}"`));
  assert.match(embedCode(LINK, 'x', { height: 720 }), /height="720"/);
  assert.match(embedCode('https://a.example/p', 'x'), /src="https:\/\/a\.example\/p\?embed=1"/);
});

test('opened on a page that is off: read without turning it on; turned on, its link, the fold of Pro, and off again after asking', async () => {
  const { calls } = server({ on: false, embed: false });
  const changes = [];
  publicDialog({ base: '/api/lists/7/public', name: 'Groceries', url: null, onChange: (url) => changes.push(url) });
  await settle();
  const [dialog] = openDialogs();
  assert.equal(dialog.getAttribute('aria-label'), t('kit.public.title', { name: 'Groceries' }));
  assert.deepEqual(calls, [['GET', '/api/lists/7/public']], 'opening only reads');
  assert.match(dialog.textContent, new RegExp(t('kit.public.what').slice(0, 20)));
  assert.equal(byClass(dialog, 'kit-public__list').length, 0, 'no shows/hides without the module\'s words');
  assert.equal(byClass(dialog, 'kit-public__embed').length, 0);

  button(dialog, t('kit.public.turnOn')).dispatch('click');
  await settle();
  assert.deepEqual(calls.at(-1), ['POST', '/api/lists/7/public']);
  assert.deepEqual(changes, [LINK]);
  const link = byClass(dialog, 'kit-public__link')[0];
  assert.equal(link.value, LINK);
  const fold = byClass(dialog, 'kit-public__embed')[0];
  assert.ok(fold, 'the plan is known: the fold shows');
  assert.match(fold.textContent, new RegExp(t('kit.public.embedPro')));
  assert.equal(byClass(dialog, 'kit-public__code').length, 0, 'no code on a plan without embed');

  button(dialog, t('kit.public.turnOff')).dispatch('click');
  await settle();
  const question = openDialogs().at(-1);
  assert.notEqual(question, dialog);
  assert.ok(!calls.some(([m]) => m === 'DELETE'), 'nothing turned off before the answer');
  const confirm = button(question, t('kit.public.turnOff'));
  confirm.dispatch('click', { currentTarget: confirm });
  await settle();
  assert.deepEqual(calls.at(-1), ['DELETE', '/api/lists/7/public']);
  assert.deepEqual(changes, [LINK, null]);
  assert.ok(button(dialog, t('kit.public.turnOn')));
  closeAll();
});

test('a page the app had on but turned off elsewhere: the dialog says so, and tells the app', async () => {
  const { calls } = server({ on: false, embed: true });
  const changes = [];
  publicDialog({ base: '/api/notes/3/public', name: 'Recipe', url: LINK, onChange: (url) => changes.push(url) });
  await settle();
  const [dialog] = openDialogs();
  assert.deepEqual(calls, [['GET', '/api/notes/3/public']], 'never a POST that would turn it on again');
  assert.deepEqual(changes, [null]);
  assert.ok(button(dialog, t('kit.public.turnOn')));
  closeAll();
});

test('on Pro: the code to embed, copied with one notice; the module\'s words and its own calls', async () => {
  const words = { what: 'kit.close', shows: 'kit.copy', hides: 'kit.cancel', onText: 'kit.confirm', embedText: 'kit.delete' };
  const seen = [];
  globalThis.fetch = async () => { throw new Error('the module\'s functions, not the route'); };
  const copied = [];
  const clipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { copied.push(text); } } });
  publicDialog({
    name: 'Garden', url: LINK, words, embedHeight: 720,
    read: async () => { seen.push('read'); return { url: LINK, embed: true }; },
    turnOn: async () => { seen.push('on'); return { url: LINK, embed: true }; },
    turnOff: async () => { seen.push('off'); },
  });
  await settle();
  const [dialog] = openDialogs();
  assert.deepEqual(seen, ['read']);
  assert.match(dialog.textContent, new RegExp(t('kit.confirm')), 'its onText');
  assert.match(dialog.textContent, new RegExp(t('kit.cancel')), 'its hides, under the link');
  const code = byClass(dialog, 'kit-public__code')[0];
  assert.match(code.value, /height="720"/);
  assert.match(code.value, /&amp;embed=1/);
  assert.match(dialog.textContent, new RegExp(t('kit.delete')), 'its embedText');

  const copies = dialog.all().filter((node) => node.tagName === 'BUTTON' && node.textContent === t('kit.copy'));
  assert.equal(copies.length, 2, 'the link\'s and the code\'s');
  const before = toasts().length;
  copies[0].dispatch('click');
  await settle();
  copies[1].dispatch('click');
  await settle();
  assert.deepEqual(copied, [LINK, code.value]);
  assert.equal(toasts().length - before, 2, 'one notice per copy, not two');
  closeAll();
  if (clipboard) Object.defineProperty(globalThis.navigator, 'clipboard', clipboard);
  else delete globalThis.navigator.clipboard;
});

test('the page\'s stylesheet: on a phone the bar keeps the icon and lets the button shrink, nothing past the screen', () => {
  const css = fs.readFileSync(new URL('../web/public-page.css', import.meta.url), 'utf8');
  const phone = css.match(/@media \(max-width: 420px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(phone, /\.sp-bar__name \{ display: none; \}/);
  assert.match(phone, /\.sp-bar__cta \{[^}]*min-width: 0;[^}]*flex: 0 1 auto;[^}]*text-overflow: ellipsis/);
  assert.doesNotMatch(css, /margin-left|margin-right|padding-left|padding-right/, 'logical properties only');
  // Every class a module's page draws its frame with is here.
  for (const name of ['sp-body', 'sp-bar', 'sp-bar__brand', 'sp-bar__name', 'sp-bar__pitch', 'sp-bar__cta', 'sp-foot', 'sp-foot__made', 'sp-foot__link', 'sp-embedded', 'sp-refused', 'sp-gone', 'sp-loading']) {
    assert.match(css, new RegExp(`\\.${name}\\b`), name);
  }
});
