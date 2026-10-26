/**
 * An app's keys that repeat a word of the kit (tools/i18n.mjs kitDuplicates):
 * what it counts, what it leaves alone, and that appChecks only adds it when
 * asked.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LANGUAGES, SUITE_CATALOGS } from '../i18n.js';
import { appChecks, kitDuplicates } from '../tools/i18n.mjs';

const LANGS = LANGUAGES;
/** The suite's text for `key` in every language, as an app would copy it. */
const kit = (key) => Object.fromEntries(LANGS.map((lang) => [lang, SUITE_CATALOGS[lang][key]]));

/** An app's folder whose public/i18n has, per language, `entries` ({ key: { en, es… } | text }). */
function app(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-kit-words-'));
  const dir = path.join(root, 'public', 'i18n');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, 'server'));
  for (const lang of LANGS) {
    const catalog = Object.fromEntries(Object.entries(entries).map(([key, value]) =>
      [key, typeof value === 'string' ? value : value[lang]]));
    fs.writeFileSync(path.join(dir, `${lang}.json`), JSON.stringify(catalog));
  }
  return { root, dir };
}

test('kitDuplicates: a copy of a word of the kit, and a suite key repeated as it is', () => {
  const { root, dir } = app({
    'app.hello': 'Hello',
    'common.cancel': kit('kit.cancel'),
    'dialog.name': kit('fields.name'),
    'fields.lang': kit('fields.lang'),
  });
  try {
    const found = kitDuplicates(dir);
    assert.deepEqual(found.map((line) => line.split(':')[0]), ['common.cancel', 'dialog.name', 'fields.lang']);
    assert.match(found[0], /say kit\.cancel/);
    assert.match(found[1], /say fields\.name\b/, 'the shortest of the fields that say it');
    assert.match(found[2], /nothing to override/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('kitDuplicates: overrides, deeper kit groups, other wording and the suite\'s groups are left alone', () => {
  const differs = { ...kit('kit.cancel'), es: 'Anular' };
  const { root, dir } = app({
    'common.undo': kit('kit.links.undo'),
    'common.cancel': differs,
    'kit.cancel': differs,
    'fields.start_date': kit('fields.starts_at'),
  });
  try {
    assert.deepEqual(kitDuplicates(dir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('appChecks adds the check only with kitWords, and the command line runs it', () => {
  const { root, dir } = app({ 'app.hello': 'Hello', 'actions.save': kit('kit.save') });
  try {
    assert.equal(appChecks(root).length, 5, 'without the option, the checks are those of before');
    const checks = appChecks(root, { kitWords: true });
    assert.equal(checks.length, 6);
    assert.deepEqual(checks[5].problems, ['actions.save: say kit.save, the same in every language']);

    const tool = fileURLToPath(new URL('../tools/i18n.mjs', import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
    const ko = run('kit-words', dir);
    assert.equal(ko.status, 1);
    assert.match(ko.stderr, /actions\.save: say kit\.save/);
    fs.writeFileSync(path.join(dir, 'en.json'), JSON.stringify({ 'app.hello': 'Hello' }));
    for (const lang of LANGS.filter((l) => l !== 'en')) fs.writeFileSync(path.join(dir, `${lang}.json`), JSON.stringify({ 'app.hello': 'Hello' }));
    const ok = run('kit-words', dir);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /No key repeats a word of the kit/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
