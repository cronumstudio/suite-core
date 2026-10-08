/**
 * The browser's translations (web/i18n.js), the ones every app uses: run in Node
 * with `fetch`, `document`, `navigator` and `localStorage` made up here. The
 * scenarios come from Tasks' own tests, from when Tasks had a copy of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
let storageBroken = false;
globalThis.localStorage = {
  getItem: (key) => { if (storageBroken) throw new Error('no storage'); return storage.has(key) ? storage.get(key) : null; },
  setItem: (key, value) => { if (storageBroken) throw new Error('no storage'); storage.set(key, String(value)); },
  removeItem: (key) => storage.delete(key),
};
const page = { text: [], attrs: [] };
globalThis.document = {
  documentElement: { lang: '', dataset: { app: 'tasks' } },
  querySelectorAll: (selector) => (selector === '[data-i18n]' ? page.text : selector === '[data-i18n-attr]' ? page.attrs : []),
};
let browser = { languages: ['en-US'], language: 'en-US' };
Object.defineProperty(globalThis, 'navigator', { get: () => browser, configurable: true });
let catalogs = {};
globalThis.fetch = async (url) => {
  const lang = /\/i18n\/([a-z]+)\.json/.exec(String(url))?.[1];
  if (!catalogs[lang]) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => catalogs[lang] };
};
const events = [];
// The page's window, as far as the module uses it.
globalThis.dispatchEvent = (event) => { events.push({ type: event.type, ...event.detail }); return true; };

let fresh = 0;
/** A copy of the module of its own, with the catalogs the server would hand out. */
async function kit(served) {
  catalogs = served;
  return import(`../web/i18n.js?copy=${fresh++}`);
}
const node = (dataset) => ({ dataset, textContent: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });

const CATALOGS = {
  en: {
    'x.hello': 'Hello {name}', 'x.onlyEnglish': 'Only English', 'x.count': { one: '{n} cat', other: '{n} cats' },
    'x.left': { '=0': 'None left', one: '{n} left', other: '{n} left' }, 'x.size': '{name} is {mb} MB',
    'common.close': 'Close', 'common.cancel': 'Cancel',
  },
  es: { 'x.hello': 'Hola {name}', 'x.count': { one: '{n} gato', other: '{n} gatos' }, 'x.left': { '=0': 'No queda ninguno', one: 'Queda {n}', other: 'Quedan {n}' }, 'x.size': '{name} ocupa {mb} MB', 'common.close': 'Cerrar', 'common.cancel': 'Cancelar' },
  fr: { 'x.count': { one: '{n} chat', other: '{n} chats' } },
  de: { 'x.size': '{name} hat {mb} MB' },
};

test('t(): placeholders, numbers written for the language, plural rules, exact forms, and English key by key', async () => {
  const i18n = await kit(CATALOGS);
  assert.equal(await i18n.loadLanguage('es'), 'es');
  assert.equal(i18n.t('x.hello', { name: 'Ana' }), 'Hola Ana');
  assert.equal(i18n.t('x.onlyEnglish'), 'Only English', 'missing in Spanish: English');
  assert.deepEqual([1, 2].map((n) => i18n.t('x.count', { n })), ['1 gato', '2 gatos']);
  assert.deepEqual([0, 1, 4].map((n) => i18n.t('x.left', { n })), ['No queda ninguno', 'Queda 1', 'Quedan 4']);
  assert.equal(i18n.t('x.hello'), 'Hola {name}', 'an unknown placeholder stays');
  assert.equal(i18n.t('no.such.key'), 'no.such.key', 'a key missing everywhere shows itself');
  assert.equal(i18n.t('x.size', { name: 'a.pdf', mb: 1234.5 }), `a.pdf ocupa ${new Intl.NumberFormat('es').format(1234.5)} MB`);
  await i18n.loadLanguage('de');
  assert.equal(i18n.t('x.size', { name: 'a.pdf', mb: 1234.5 }), 'a.pdf hat 1.234,5 MB');
  await i18n.loadLanguage('fr');
  assert.equal(i18n.t('x.count', { n: 0 }), '0 chat', '0 is singular in French');
  assert.equal(i18n.t('x.count', { n: 1.5 }), '1,5 chat');
});

test('a language whose catalog cannot be had shows English in that language; without even English, the keys', async () => {
  const i18n = await kit({ en: CATALOGS.en });
  assert.equal(await i18n.loadLanguage('es'), 'es');
  assert.equal(document.documentElement.lang, 'es');
  assert.equal(i18n.currentLanguage(), 'es');
  assert.equal(i18n.t('x.hello', { name: 'Ana' }), 'Hello Ana');

  const offline = await kit({});
  assert.equal(await offline.loadLanguage('es'), 'es', 'it never throws');
  assert.equal(offline.t('x.hello'), 'x.hello');
  catalogs = { en: CATALOGS.en };
  await offline.loadLanguage('en');
  assert.equal(offline.t('x.hello', { name: 'Ana' }), 'Hello Ana', 'English is tried again once it can be had');
});

test('nested catalogs read as well as flat ones', async () => {
  const i18n = await kit({ en: { x: { hello: 'Hi', deep: { er: 'Deeper' } }, 'y.flat': 'Flat' } });
  await i18n.loadLanguage('en');
  assert.deepEqual([i18n.t('x.hello'), i18n.t('x.deep.er'), i18n.t('y.flat')], ['Hi', 'Deeper', 'Flat']);
});

test('resolveLanguage: the choice if it is one of ours, else the browser’s first we have, else English', async () => {
  const i18n = await kit(CATALOGS);
  const resolve = (preference, languages, language) => { browser = { languages, language }; return i18n.resolveLanguage(preference); };
  assert.deepEqual([
    resolve('auto', ['pt-BR', 'de-AT', 'en'], 'pt-BR'), resolve('auto', ['pt-BR', 'pt'], 'pt-BR'), resolve('auto', [], 'es-ES'),
    resolve('auto', undefined, 'FR-ca'), resolve('es', ['de'], 'de'), resolve('xx', ['de'], 'de'), resolve('auto', [], ''), resolve(undefined, ['fr'], 'fr'),
  ], ['de', 'en', 'es', 'fr', 'es', 'de', 'en', 'fr']);
  assert.equal(i18n.pickLanguage([null, ['pt', 'de-CH'], 'fr'], ['en', 'fr', 'de']), 'de', 'pickLanguage takes lists within the list');
});

test('the choice is kept as <app>.lang, "auto" as "auto"; not at all when asked, and a storage that throws breaks nothing', async () => {
  const i18n = await kit(CATALOGS);
  storage.clear();
  browser = { languages: ['de-CH', 'en'], language: 'de-CH' };
  assert.equal(await i18n.loadLanguage('auto'), 'de');
  assert.equal(document.documentElement.lang, 'de');
  assert.equal(storage.get('tasks.lang'), 'auto');
  assert.equal(i18n.savedLanguage(), 'auto');
  await i18n.loadLanguage('fr');
  assert.equal(i18n.savedLanguage(), 'fr');
  await i18n.loadLanguage('es', { remember: false });
  assert.equal(i18n.savedLanguage(), 'fr', 'the admin panel follows the account without changing the app’s choice');
  storageBroken = true;
  assert.equal(await i18n.loadLanguage('es'), 'es');
  assert.equal(i18n.savedLanguage(), 'auto');
  storageBroken = false;
});

test('the page is translated as the language loads: data-i18n and data-i18n-attr, malformed pairs left alone', async () => {
  const i18n = await kit(CATALOGS);
  page.text = [node({ i18n: 'common.cancel' })];
  page.attrs = [node({ i18nAttr: 'title:common.close; aria-label:common.cancel;bogus;:common.cancel;title:' })];
  await i18n.loadLanguage('es');
  assert.equal(page.text[0].textContent, 'Cancelar');
  assert.deepEqual(page.attrs[0].attributes, { title: 'Cerrar', 'aria-label': 'Cancelar' });
  const own = [node({ i18n: 'common.close' }), node({ i18n: 'no.such.key' })];
  i18n.translateDom({ querySelectorAll: (selector) => (selector === '[data-i18n]' ? own : []) });
  assert.deepEqual(own.map((n) => n.textContent), ['Cerrar', 'no.such.key']);
  page.text = [];
  page.attrs = [];
});

test('changeLanguage loads it and tells the app, which draws itself again', async () => {
  const i18n = await kit(CATALOGS);
  events.length = 0;
  assert.equal(await i18n.changeLanguage('es'), 'es');
  assert.deepEqual(events, [{ type: 'app:language', lang: 'es' }]);
});

test('dates, lists, collation and "today" are Intl’s in the language, and change with it', async () => {
  const i18n = await kit(CATALOGS);
  const months = [];
  for (const lang of ['en', 'es', 'fr', 'de']) {
    await i18n.loadLanguage(lang);
    months.push(i18n.dateFormat({ month: 'long' }).format(new Date(2031, 2, 12)));
    assert.deepEqual([-3, -1, 0, 1].map((d) => i18n.relativeDay(d)),
      [null, ...[-1, 0, 1].map((d) => new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(d, 'day'))]);
    assert.equal(i18n.listFormat().format(['a', 'b', 'c']), new Intl.ListFormat(lang).format(['a', 'b', 'c']));
    assert.equal(i18n.numberFormat().format(1234.5), new Intl.NumberFormat(lang).format(1234.5));
    assert.equal(i18n.compareText('Árbol', 'arbol'), 0);
  }
  assert.equal(new Set(months).size, 4, months.join(' '));
  await i18n.loadLanguage('es');
  assert.deepEqual(['Zeta', 'Nube', 'Ñandú', 'Ana', 'Nata'].sort(i18n.compareText), ['Ana', 'Nata', 'Nube', 'Ñandú', 'Zeta']);
  assert.deepEqual([i18n.capitalize('hoy'), i18n.capitalize('ñandú'), i18n.capitalize('')], ['Hoy', 'Ñandú', '']);
  await i18n.loadLanguage('en');
  assert.deepEqual(['Zeta', 'Nube', 'Ñandú', 'Ana', 'Nata'].sort(i18n.compareText), ['Ana', 'Ñandú', 'Nata', 'Nube', 'Zeta']);
});
