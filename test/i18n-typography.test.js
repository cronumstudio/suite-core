/**
 * Texts written the same way in every module (audit of 6/11, ux-textos-14, -17 and -20): the
 * typography check (tools/i18n.mjs typography) over the kit's own catalogs and an app's, a word of
 * the kit an app says otherwise (kitDuplicates, with `allow`), and the push of something shared,
 * worded once (share-mail.js sharePush).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LANGUAGES, SUITE_CATALOGS, appTexts } from '../i18n.js';
import { appChecks, kitDuplicates, typography } from '../tools/i18n.mjs';
import { SHARE_KINDS, sharePush } from '../share-mail.js';

const SUITE_DIR = new URL('../i18n/', import.meta.url);

/** An app's folder whose public/i18n has, per language, `entries` ({ key: { en, es… } | text }). */
function app(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-typography-'));
  const dir = path.join(root, 'public', 'i18n');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, 'server'));
  for (const lang of LANGUAGES) {
    const catalog = Object.fromEntries(Object.entries(entries).map(([key, value]) =>
      [key, typeof value === 'string' ? value : value[lang]]));
    fs.writeFileSync(path.join(dir, `${lang}.json`), JSON.stringify(catalog));
  }
  return { root, dir };
}

test('the kit\'s own catalogs: the language\'s quotes, ’ and ›, never straight quotes or →', () => {
  assert.deepEqual(typography(fileURLToPath(SUITE_DIR)), []);
});

test('typography: a straight quote, a straight apostrophe and an arrow through menus are told', () => {
  const same = (text) => Object.fromEntries(LANGUAGES.map((lang) => [lang, text]));
  const { root, dir } = app({
    'app.ok': same('«Lista» movida a “Casa”, l’app, Ajustes › Perfil'),
    'app.quote': same('Movida a "Casa"'),
    'app.apostrophe': same('It isn\'t here'),
    'app.arrow': same('Ajustes → Perfil'),
    'app.plural': Object.fromEntries(LANGUAGES.map((lang) => [lang, { one: '"{n}" item', other: '{n} items' }])),
  });
  try {
    const found = typography(dir);
    const keys = new Set(found.map((line) => line.split(' ')[1].replace(/:$/, '')));
    assert.deepEqual([...keys].sort(), ['app.apostrophe', 'app.arrow', 'app.plural', 'app.quote']);
    assert.ok(found.some((line) => line.startsWith('es.json app.quote') && line.includes('«…»')), 'it says the language\'s quote');
    assert.equal(appChecks(root).length, 5, 'not one of the checks unless asked');
    const checks = appChecks(root, { typography: true });
    assert.equal(checks.at(-1).problems.length, found.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('kitDuplicates: an app saying a word of the kit otherwise is told, unless it says why', () => {
  const other = Object.fromEntries(LANGUAGES.map((lang) => [lang, `${SUITE_CATALOGS[lang]['kit.saveState.offline']} (app)`]));
  const { root, dir } = app({ 'kit.saveState.offline': other, 'errors.too_many_files': other });
  try {
    assert.deepEqual(kitDuplicates(dir), [], 'as before, unless asked');
    assert.deepEqual(kitDuplicates(dir, LANGUAGES, { overrides: true }), ['kit.saveState.offline: a word of the kit, said otherwise by the app'],
      'an error of the suite said with the module\'s own detail stays');
    assert.deepEqual(kitDuplicates(dir, LANGUAGES, { overrides: true, allow: [{ key: 'kit.saveState.offline', why: 'test' }] }), []);
    const [check] = appChecks(root, { kitWords: true, kitOverrides: true, kitAllow: ['kit.saveState.offline'] }).slice(-1);
    assert.deepEqual(check.problems, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sharePush: «Shared with you», who shared which thing, in the language of whoever gets it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-share-push-'));
  try {
    const { translator } = appTexts(root);
    for (const kind of SHARE_KINDS) {
      for (const lang of LANGUAGES) {
        const t = translator(lang);
        const { title, body } = sharePush({ t, kind, actor: 'Ana', name: 'Ideas', role: 'Editor' });
        assert.equal(title, SUITE_CATALOGS[lang]['kit.share.push.title']);
        assert.ok(body.includes('Ana') && body.includes('Ideas'), `${kind} ${lang}: ${body}`);
        assert.ok(!/[{}]/.test(body), `${kind} ${lang}: every placeholder filled`);
      }
    }
    const t = translator('es');
    assert.equal(sharePush({ t, kind: 'project', actor: 'Ana', name: 'Web', role: 'Participa' }).body,
      'Ana te ha compartido el proyecto «Web» (Participa). Ábrelo para aceptarlo o rechazarlo.');
    assert.match(sharePush({ t, kind: 'note', actor: 'Ana', name: '  ' }).body, /«Sin título»/);
    assert.throws(() => sharePush({ t, kind: 'board', actor: 'Ana', name: 'x' }), /no kind/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
