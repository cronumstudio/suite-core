/**
 * What every module's Settings say the same way (web/settings.js): what the module is, under About
 * on its own and in a section of its own in a host (`aboutExtra: { text, tips }`, keys drawn by the
 * kit, or the module's own function), and what a copy holds in words (`summaryOf(parts)`). Without
 * a browser: the kit's fake DOM and the core's catalogs.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

const document = installFakeDom();
const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => { memory.set(key, String(value)); },
  removeItem: (key) => { memory.delete(key); },
};
const catalog = (lang) => JSON.parse(fs.readFileSync(new URL(`../i18n/${lang}.json`, import.meta.url), 'utf8'));
const realFetch = globalThis.fetch;
const { loadLanguage, t } = await import('../web/i18n.js');
/** The kit's own words in `lang`, as a page loads them. */
async function speak(lang) {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => catalog(lang) });
  try {
    await loadLanguage(lang, { remember: false });
  } finally {
    globalThis.fetch = realFetch;
  }
}
await speak('en');
const { openSettings, summaryOf } = await import('../web/settings.js');
const { el } = await import('../web/dom.js');

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const HOST = { id: 'work', name: 'Cronum Work', mount: 'notes', base: '/notes/', push: false, plans: false };
/** What a module says it is: keys this catalog has, for the test. */
const ABOUT = { text: 'kit.about.hostHint', tips: ['kit.about.version', 'kit.about.live'] };

function open({ start, host = null, aboutExtra }) {
  globalThis.fetch = async (path) => ({
    ok: path === '/api/modules', status: path === '/api/modules' ? 200 : 404,
    json: async () => (path === '/api/modules' ? { host: { name: 'Cronum Work' }, modules: [] } : {}),
  });
  globalThis.window = { location: { origin: 'https://app.example', href: 'https://app.example/' } };
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });
  const root = document.createElement('div');
  const settings = openSettings({
    app: { id: 'notes', name: 'Notes', tagline: 'Your notes' }, user: { id: 7, username: 'ada', role: 'user' }, root, start,
    config: { app: { modules: {}, ...(host ? { host } : {}) } },
    aboutExtra,
  });
  return { root, settings };
}

function cleanUp(settings) {
  settings.close();
  globalThis.fetch = realFetch;
  delete globalThis.window;
  delete document.addEventListener;
  delete document.removeEventListener;
  delete document.dispatchEvent;
}

/** The block that says what the module is, in the page open: its paragraph and its lines. */
function aboutBlockIn(root) {
  const page = root.all().find((node) => node.className === 'kit-settings__page');
  const block = page.all().find((node) => node.className === 'kit-settings__block' && node.find('p')[0]?.textContent === t(ABOUT.text));
  return block && { tag: block.tagName, text: block.find('p')[0].textContent, tips: block.find('li').map((li) => li.textContent), lists: block.find('ul').map((ul) => ul.className) };
}

test('on its own, About says what the module is from its keys: a paragraph and a line for each tip, in a block as every module drew it', async () => {
  const { root, settings } = open({ start: 'about', aboutExtra: ABOUT });
  await settle();
  try {
    assert.deepEqual(aboutBlockIn(root), {
      tag: 'SECTION', text: t('kit.about.hostHint'), tips: [t('kit.about.version'), t('kit.about.live')], lists: ['kit-hint'],
    });
  } finally { cleanUp(settings); }
});

test('in a host it is the module\'s own section, drawn the same', async () => {
  const { root, settings } = open({ start: 'about-extra', host: HOST, aboutExtra: ABOUT });
  await settle();
  try {
    assert.deepEqual(aboutBlockIn(root)?.tips, [t('kit.about.version'), t('kit.about.live')]);
  } finally { cleanUp(settings); }
});

test('a module that draws it itself still does (its own button, what only an administrator sees)', async () => {
  const { root, settings } = open({ start: 'about', aboutExtra: () => el('p', { class: 'own-about', text: 'What Notes is' }) });
  await settle();
  try {
    assert.ok(root.all().some((node) => node.className === 'own-about' && node.textContent === 'What Notes is'));
  } finally { cleanUp(settings); }
});

test('a copy\'s parts in words, joined as each language joins quantities, the same in every module', async () => {
  const parts = ['3 a', '10 b', '5 c'];
  for (const lang of ['en', 'es', 'fr', 'de', 'it']) {
    await speak(lang);
    const intl = new Intl.ListFormat(lang, { style: 'short', type: 'unit' });
    assert.equal(summaryOf(parts), intl.format(parts), lang);
    assert.equal(summaryOf(parts.slice(0, 2)), intl.format(parts.slice(0, 2)), lang);
  }
  await speak('es');
  assert.equal(summaryOf(['2 proyectos', '9 tareas']), '2 proyectos y 9 tareas');
  assert.equal(summaryOf(['5 listas', 0, '17 tareas', null, '']), '5 listas y 17 tareas', 'a count left out is no part');
  assert.equal(summaryOf(['1 libreta']), '1 libreta');
  await speak('en');
});
