/**
 * Translations: negotiation, fallback, plurals, the app's overrides, and that
 * every language of the suite has every key with the same placeholders.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  LANGUAGES, SUITE_CATALOGS, flatten, unflatten, mergeCatalogs, negotiate, translator, createTexts, appTexts,
} from '../i18n.js';
import { parity, catalogsOf, appChecks } from '../tools/i18n.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A folder of its own with `files` ({ 'public/i18n/en.json': … }); removed by the caller. */
function folder(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-i18n-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

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

test('every error the suite can send has its sentence, and every field it names has its name', () => {
  // What the modules throw, read from their code: a new code without a sentence
  // would reach people as "Something went wrong" (the apps' tests catch it late).
  const root = new URL('../', import.meta.url);
  const code = fs.readdirSync(root).filter((file) => file.endsWith('.js'))
    .map((file) => fs.readFileSync(new URL(file, root), 'utf8')).join('\n');
  const english = JSON.parse(fs.readFileSync(new URL('i18n/en.json', root), 'utf8'));
  const codes = new Set([
    ...[...code.matchAll(/(?:badRequest|conflict|notFound|forbidden|unauthorized)\(\s*'([a-z_]+)'/g)].map((m) => m[1]),
    ...[...code.matchAll(/new HttpError\(\d+,\s*'([a-z_]+)'/g)].map((m) => m[1]),
  ]);
  assert.ok(codes.size > 40, 'the codes are found');
  assert.deepEqual([...codes].filter((c) => !english[`errors.${c}`]), [], 'errors without a sentence');
  const fields = new Set([...code.matchAll(/field: '([a-z_]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...fields].filter((f) => !english[`fields.${f}`]), [], 'fields without a name');
});

/* ------------------------- an app's texts on the server ------------------------ */

test('appTexts: the app’s catalogs over the suite’s, English key by key, read again when a file changes', () => {
  const dir = folder({
    'en.json': { 'notices.due': '{title} is due', 'errors.bad_credentials': 'Not you?', 'x.count': { one: '{n} task', other: '{n} tasks' } },
    'es.json': { 'notices.due': '{title} vence', 'x.count': { one: '{n} tarea', other: '{n} tareas' } },
  });
  try {
    const texts = appTexts(dir, { defaultLanguage: '' });
    const es = texts.translator('es');
    assert.equal(es('notices.due', { title: 'Pan' }), 'Pan vence');
    assert.equal(es('x.count', { n: 12000 }), `${new Intl.NumberFormat('es').format(12000)} tareas`);
    assert.equal(es('errors.not_found'), SUITE_CATALOGS.es['errors.not_found'], 'the suite’s texts come with it');
    assert.equal(texts.translator('en')('errors.bad_credentials'), 'Not you?', 'the app’s text wins');
    assert.equal(texts.translator('fr')('notices.due', { title: 'Pain' }), 'Pain is due', 'French has none: English');
    assert.equal(texts.translator('xx'), texts.translator('en'), 'an unknown language is English');
    assert.equal(texts.translator('es'), es, 'the same translator while nothing changes');
    const seen = texts.fromCatalog('names', 'es', (t) => ({ due: t('notices.due', { title: '' }) }));
    assert.equal(texts.fromCatalog('names', 'es', () => assert.fail('computed again')), seen);

    const later = new Date(Date.now() + 5000);
    fs.writeFileSync(path.join(dir, 'es.json'), JSON.stringify({ 'notices.due': '{title}: hoy' }));
    fs.utimesSync(path.join(dir, 'es.json'), later, later);
    assert.notEqual(texts.translator('es'), es, 'a changed file is read again');
    assert.equal(texts.translator('es')('notices.due', { title: 'Pan' }), 'Pan: hoy');
    const field = Object.keys(SUITE_CATALOGS.es).find((key) => key.startsWith('fields.'));
    assert.equal(texts.errorSentence('field_too_long', { field: field.slice('fields.'.length), max: 200 }, 'es'),
      SUITE_CATALOGS.es['errors.field_too_long'].replace('{field}', SUITE_CATALOGS.es[field]).replace('{max}', '200'));
    assert.equal(texts.errorSentence('no_such_code'), null);
    assert.equal(appTexts(pathToFileURL(`${dir}/`)).translator('es')('notices.due', { title: 'Pan' }), 'Pan: hoy', 'a URL is a folder too');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appTexts: whose language wins, with the installation’s default as the last resort (from Tasks’ tests)', () => {
  const D = 'D';
  const CASES = [
    // [user, Accept-Language, languageFor, userLanguage]
    [{ prefs: { lang: 'fr' } }, 'de', 'fr', 'fr'],
    [{ prefs: { lang: 'auto', lang_seen: 'de' }, locale: 'es' }, 'en-GB,en;q=0.9', 'en', 'de'],
    [{ prefs: { lang_seen: 'de' }, locale: 'fr' }, null, 'de', 'de'],
    [{ prefs: '{"lang_seen":"fr"}', locale: 'es' }, null, 'fr', 'fr'],
    [{ locale: 'fr_CA' }, null, 'fr', 'fr'],
    [{}, null, D, D],
    [null, 'de-AT,de;q=0.9', 'de', D],
    [{ prefs: { lang: 'xx' } }, 'fr', 'fr', D],
    [{}, 'pt-BR,pt;q=0.9,es;q=0.8', 'es', D],
    [{}, 'en;q=0,fr;q=0.5', 'fr', D],
    [{ prefs: { lang_seen: 'de' } }, 'xx, yy', 'de', 'de'],
    [{}, '*', D, D],
    [{ prefs: '{oops', locale: 'de' }, null, 'de', 'de'],
    [{ prefs: { lang: 'es', lang_seen: 'de' }, locale: 'fr' }, 'en', 'es', 'es'],
  ];
  for (const [setting, expected] of [[undefined, 'en'], ['es', 'es'], ['de-AT', 'de'], ['xx', 'en'], ['FR', 'fr']]) {
    const texts = appTexts(os.tmpdir(), { defaultLanguage: setting ?? '' });
    assert.equal(texts.DEFAULT_LANGUAGE, expected, `DEFAULT_LANGUAGE=${setting}`);
    assert.equal(texts.negotiateLanguage(['xx']), expected);
    for (const [user, header, byRequest, byUser] of CASES) {
      const req = { headers: header ? { 'accept-language': header } : {} };
      assert.equal(texts.languageFor(req, user), byRequest === D ? expected : byRequest, JSON.stringify([setting, user, header]));
      assert.equal(texts.userLanguage(user), byUser === D ? expected : byUser, JSON.stringify([setting, user]));
    }
    assert.equal(texts.textsFor({ headers: { 'accept-language': 'de' } }).lang, 'de');
  }
  assert.equal(appTexts(os.tmpdir()).savedLanguage({ prefs: { lang: 'auto' } }), null);
});

/* --------------------------- an app's checks, at once -------------------------- */

test('appChecks: an app passes when its catalogs are flat and agree, its keys exist and nothing is written in its code', () => {
  const good = folder({
    'public/i18n/en.json': { 'app.hello': 'Hello', 'app.count': { one: '{n} note', other: '{n} notes' } },
    'public/i18n/es.json': { 'app.hello': 'Hola', 'app.count': { one: '{n} nota', other: '{n} notas' } },
    'public/i18n/fr.json': { 'app.hello': 'Bonjour', 'app.count': { one: '{n} note', other: '{n} notes' } },
    'public/i18n/de.json': { 'app.hello': 'Hallo', 'app.count': { one: '{n} Notiz', other: '{n} Notizen' } },
    'public/js/main.js': "el('p', { text: t('app.hello') });",
    'public/vendor/editor.js': "throw 'Something others wrote';",
    'server/notices.js': "send({ title: t('app.hello') });",
    'server/seeds.js': "export const SEEDS = ['Plátanos'];",
  });
  const bad = folder({
    'public/i18n/en.json': { app: { hello: 'Hello', bye: 'Bye' } },
    'public/i18n/es.json': { app: { hello: 'Hola' } },
    'public/js/main.js': "el('p', { text: t('app.nowhere') }); toast('Guardado');",
    'server/notices.js': "send({ title: 'Tarea añadida' });",
  });
  try {
    const passing = appChecks(good, { skip: ['seeds.js'] });
    assert.equal(passing.length, 5);
    assert.deepEqual(passing.filter((c) => c.problems.length), []);
    assert.ok(appChecks(good)[4].problems.some((p) => p.includes('Plátanos')), 'without skip, the seeds count');

    const failing = appChecks(bad).map((c) => c.problems.join(' | '));
    assert.match(failing[0], /en\.json \| es\.json \| fr\.json: missing/, 'nested, and a language missing');
    assert.match(failing[1], /es: missing app\.bye/);
    assert.match(failing[2], /app\.nowhere/);
    assert.match(failing[3], /Guardado/);
    assert.match(failing[4], /Tarea añadida/);

    const tool = fileURLToPath(new URL('../tools/i18n.mjs', import.meta.url));
    const run = (root, ...more) => spawnSync(process.execPath, [tool, 'app', root, ...more], { encoding: 'utf8' });
    const ok = run(good, '--skip', 'seeds.js');
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal((ok.stdout.match(/✓/g) || []).length, 5);
    const ko = run(bad);
    assert.equal(ko.status, 1);
    assert.match(ko.stdout, /✗ No text for people[\s\S]*Guardado/);
  } finally {
    fs.rmSync(good, { recursive: true, force: true });
    fs.rmSync(bad, { recursive: true, force: true });
  }
});
