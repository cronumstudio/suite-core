/**
 * Settings in a host (web/settings.js), without a browser: another module's catalog, which names
 * its sections and About's card, is asked for once while Settings are open, even when it fails, and
 * each one that comes paints the list again once (sc-ui-1). About's cards get their line when it
 * comes, with nothing thrown (sc-ui-4).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

const document = installFakeDom();
const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });
const { loadLanguage } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
globalThis.fetch = realFetch;

const MODULES = ['tasks', 'notes', 'projects', 'next'].map((mount) => ({
  mount, path: `/${mount}/`, name: mount[0].toUpperCase() + mount.slice(1), icon: `/${mount}/icons/favicon.svg`, active: true,
  settings: { sections: [{ id: 'look', label: 'settings.look', icon: 'sliders' }], data: true, about: true },
}));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The page in `lang`, the kit's words English's: another module's catalogs are kept by language. */
async function speak(lang) {
  const serve = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });
  try { await loadLanguage(lang, { remember: false }); } finally { globalThis.fetch = serve; }
}

/** Settings of Tasks in the host, with `catalog(mount)` answering the others' catalogs after `ms`. */
async function openWith({ start = null, catalog, ms }) {
  const { openSettings } = await import('../web/settings.js');
  const asked = [];
  globalThis.fetch = async (path) => {
    asked.push(path);
    const mount = /^\/([a-z]+)\/i18n\//.exec(path)?.[1];
    if (mount) {
      await wait(ms);
      const words = catalog(mount);
      if (words === 'offline') throw new TypeError('Failed to fetch');
      return { ok: Boolean(words), status: words ? 200 : 503, json: async () => words };
    }
    const data = path === '/api/modules' ? { host: { name: 'Cronum Work' }, modules: MODULES } : undefined;
    return { ok: data !== undefined, status: data ? 200 : 404, json: async () => data ?? {} };
  };
  const root = document.createElement('div');
  const settings = openSettings({
    app: { id: 'tasks', name: 'Tasks', icon: '/icons/favicon.svg', tagline: 'Your lists' }, user: { username: 'ada', role: 'user' }, root, start,
    config: { app: { modules: {}, host: { id: 'work', name: 'Cronum Work', mount: 'tasks', base: '/tasks/', push: false, plans: false } } },
    updates: { check: async () => false, loaded: () => null, latest: () => null },
  });
  return { root, asked, settings };
}

test('two or more catalogs that fail are asked for once each while Settings are open, and the page goes on (sc-ui-1)', { timeout: 20000 }, async () => {
  globalThis.window = { location: { origin: 'https://work.example', assign: () => {} } };
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {} });
  try {
    // In English two failing, in French all three: each in a language of its own, nothing kept between them.
    for (const [lang, failing] of [['en', ['notes', 'projects']], ['fr', ['notes', 'projects', 'next']]]) {
      await speak(lang);
      const began = Date.now();
      const { root, asked, settings } = await openWith({ ms: 5, catalog: (mount) => (failing.includes(mount) ? (mount === 'next' ? 'offline' : null) : { 'settings.look': `${mount} look` }) });
      // Between the answers, the timers run: a tab whose microtasks never end would never come back here.
      for (let i = 0; i < 10; i++) await wait(10);
      const catalogs = asked.filter((path) => path.includes('/i18n/'));
      assert.deepEqual(catalogs.sort(), ['next', 'notes', 'projects'].map((mount) => `/${mount}/i18n/${lang}.json`), `each catalog once, ${failing.length} failing`);
      assert.ok(Date.now() - began < 5000, 'the page is not held');
      const labels = root.all().filter((node) => ['kit-settings__label', 'kit-settings__group-name'].includes(node.className)).map((node) => node.textContent);
      for (const mount of failing) {
        const name = mount[0].toUpperCase() + mount.slice(1);
        assert.ok(labels.some((label) => label.includes(name)), `${name}: one way into its Settings all the same`);
      }
      if (lang === 'en') assert.ok(labels.includes('next look'), 'the one that came names its section');
      settings.close();
    }
    // Opened again, the ones that failed are asked for again; the one that came is kept.
    await speak('en');
    const { root, asked, settings } = await openWith({ ms: 5, catalog: (mount) => ({ 'settings.look': `${mount} look` }) });
    for (let i = 0; i < 5; i++) await wait(10);
    assert.deepEqual(asked.filter((path) => path.includes('/i18n/')).sort(), ['/notes/i18n/en.json', '/projects/i18n/en.json']);
    const labels = root.all().filter((node) => node.className === 'kit-settings__label').map((node) => node.textContent);
    assert.ok(['notes look', 'projects look', 'next look'].every((label) => labels.includes(label)));
    settings.close();
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete document.addEventListener;
    delete document.removeEventListener;
  }
});

test('About opened while the other modules\' catalogs are on their way: each card gets its line when it comes, with nothing thrown (sc-ui-4)', { timeout: 20000 }, async () => {
  globalThis.window = { location: { origin: 'https://work.example', assign: () => {} } };
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {} });
  const thrown = [];
  const note = (err) => thrown.push(err);
  process.on('unhandledRejection', note);
  process.on('uncaughtException', note);
  try {
    // Asked in German, which no test above asked for: these catalogs are on their way as About opens.
    await speak('de');
    const { currentLanguage } = await import('../web/i18n.js');
    const lang = currentLanguage();
    const { root, settings } = await openWith({ start: 'about', ms: 30, catalog: (mount) => ({ 'app.tagline': `${mount} in ${lang}` }) });
    for (let i = 0; i < 10; i++) await wait(10);
    const cards = root.all().filter((node) => node.className === 'kit-about-card');
    assert.deepEqual(cards.map((card) => card.find('p')[0]?.textContent),
      ['Your lists', `notes in ${lang}`, `projects in ${lang}`, `next in ${lang}`]);
    assert.deepEqual(thrown, []);
    settings.close();
  } finally {
    process.off('unhandledRejection', note);
    process.off('uncaughtException', note);
    await speak('en');
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete document.addEventListener;
    delete document.removeEventListener;
  }
});
