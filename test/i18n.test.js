/**
 * Translations: negotiation, fallback, plurals, the app's overrides, and that
 * every language of the suite has every key with the same placeholders.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANGUAGES, SUITE_CATALOGS, flatten, unflatten, mergeCatalogs, negotiate, translator, createTexts,
} from '../i18n.js';
import { parity, catalogsOf } from '../tools/i18n.mjs';

test('negotiation follows the order and the q values', () => {
  assert.equal(negotiate('es-ES,es;q=0.9,en;q=0.8'), 'es');
  assert.equal(negotiate('en;q=0.5, fr;q=0.9'), 'fr');
  assert.equal(negotiate('de-CH'), 'de');
  assert.equal(negotiate([null, 'fr']), 'fr');
  assert.equal(negotiate(['pt', 'es']), 'es');
  assert.equal(negotiate('pt-BR'), 'en');
  assert.equal(negotiate(undefined), 'en');
  assert.equal(negotiate('es', ['en']), 'en', 'only what the app supports');
});

test('nested catalogs become dotted keys; plural objects stay whole', () => {
  assert.deepEqual(flatten({ a: { b: 'x', c: { one: '1', other: 'n' } }, $meta: { locale: 'en' } }),
    { 'a.b': 'x', 'a.c': { one: '1', other: 'n' } });
});

test('t() fills placeholders, picks plurals and falls back to English key by key', () => {
  const sets = {
    en: { hello: 'Hello {name}', steps: { one: '{n} step', other: '{n} steps' }, only: 'English only' },
    es: { hello: 'Hola {name}', steps: { '=0': 'Ningún paso', one: '{n} paso', other: '{n} pasos' } },
  };
  const es = translator('es', sets);
  assert.equal(es('hello', { name: 'Ada' }), 'Hola Ada');
  assert.equal(es('steps', { n: 0 }), 'Ningún paso');
  assert.equal(es('steps', { n: 1 }), '1 paso');
  assert.equal(es('steps', { n: 1200 }), '1200 pasos'.replace('1200', new Intl.NumberFormat('es').format(1200)));
  assert.equal(es('only'), 'English only');
  assert.equal(es('missing.key'), 'missing.key');
  assert.equal(es('hello'), 'Hola {name}', 'a placeholder without a value stays visible');
});

test('later catalog sets override earlier ones', () => {
  const t = translator('en', { en: { a: 'suite' } }, { en: { a: 'app' } });
  assert.equal(t('a'), 'app');
});

test('texts: the user’s choice, then the browser, then English; the app overrides keys', () => {
  const texts = createTexts({ catalogs: { en: { oauth: { wants: '{client} wants your lists.' } } } });
  const req = (lang) => ({ headers: { 'accept-language': lang } });
  assert.equal(texts(req('fr'), { locale: 'es' }).lang, 'es');
  assert.equal(texts(req('fr'), { prefs: '{"lang":"de"}' }).lang, 'de');
  assert.equal(texts(req('fr'), null).lang, 'fr');
  assert.equal(texts(req(''), null).lang, 'en');
  const { t } = texts(req('en'));
  assert.equal(t('oauth.wants', { client: 'Claude' }), 'Claude wants your lists.');
  assert.equal(t('oauth.allow'), 'Allow');
});

test('every language of the suite has every key, with the same placeholders', () => {
  const markers = (value) => JSON.stringify(value).match(/\{\w+\}/g)?.sort().join(',') ?? '';
  const english = SUITE_CATALOGS.en;
  assert.ok(Object.keys(english).length > 20, 'the English catalog is there');
  for (const lang of LANGUAGES) {
    const catalog = SUITE_CATALOGS[lang];
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(english).sort(), `${lang}: same keys`);
    for (const [key, value] of Object.entries(catalog)) {
      assert.equal(markers(value), markers(english[key]), `${lang}: ${key} placeholders`);
    }
  }
});

test('an app’s catalog merged over the suite’s: the app’s texts win, its shape is kept', () => {
  const nested = { errors: { not_found: 'Gone.' }, count: { steps: { one: '{n} step', other: '{n} steps' } } };
  const merged = mergeCatalogs(SUITE_CATALOGS.en, nested);
  assert.equal(merged.errors.not_found, 'Gone.', 'the app’s own wording');
  assert.equal(merged.errors.username_taken, 'That username is already taken.', 'the suite’s, for what the app doesn’t say');
  assert.equal(merged.oauth.allow, 'Allow');
  assert.deepEqual(merged.count.steps, { one: '{n} step', other: '{n} steps' }, 'plurals stay whole');
  const dotted = mergeCatalogs(SUITE_CATALOGS.en, { 'errors.not_found': 'Gone.' });
  assert.equal(dotted['errors.not_found'], 'Gone.');
  assert.equal(dotted['fields.email'], 'Email', 'a dotted catalog stays dotted');
  assert.deepEqual(unflatten({ a: 'x', 'a.b': 'y', 'c.d': 'z' }), { a: 'x', 'a.b': 'y', c: { d: 'z' } },
    'a key that is both a text and a section stays dotted');
});

test('parity: the suite’s catalogs agree, and what differs is named', () => {
  assert.deepEqual(parity(catalogsOf()), []);
  const problems = parity({
    en: { 'a.b': 'Hello {name}', 'c.d': { one: '{n} step', other: '{n} steps', '=0': 'No steps' }, 'e.f': 'Done' },
    es: { 'a.b': 'Hola', 'c.d': { one: '{n} paso', other: '{n} pasos' }, 'e.f': 'TODO', 'g.h': 'Extra' },
    de: { 'a.b': 'Hallo {name}', 'c.d': { other: '{n} Schritte' }, 'e.f': 'Erledigt' },
  });
  assert.deepEqual(problems, [
    'es: not in English g.h',
    'es: a.b: placeholders none instead of {name}',
    'es: c.d: the exact form =0 is missing',
    'es: e.f: not translated',
    'de: c.d: plural forms one missing',
    'de: c.d: the exact form =0 is missing',
  ]);
});
