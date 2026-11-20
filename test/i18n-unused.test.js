/**
 * The keys of a catalog that no code reads (tools/i18n.mjs unusedKeys and its
 * `unused` command): what counts as reading one, what keeps the keys a code
 * builds, and what is left out.
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
import { unusedKeys } from '../tools/i18n.mjs';

const TOOL = fileURLToPath(new URL('../tools/i18n.mjs', import.meta.url));

/** A module's folder: its catalog, and code that reads some of it in each way there is. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-unused-'));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write('public/i18n/en.json', JSON.stringify({
    '$meta.locale': 'en',
    'app.title': 'Title', 'app.listed': 'Listed', 'app.template': 'In a template', 'app.html': 'Heading', 'app.attr': 'Tip',
    'app.comment': 'Only in a comment', 'app.pattern': 'Only in a regular expression', 'app.tested': 'Only in a test',
    'app.smoke': 'Only in a smoke test', 'app.gone': 'Nowhere',
    'kind.one': 'One', 'kind.two': 'Two', 'kind.three': 'Three',
    'parts.a': 'A', 'parts.b': 'B', 'mode.list.title': 'List', 'errors.mine': 'Said by the kit',
  }));
  write('public/js/main.js', [
    "// app.comment is named here, in a comment only",
    "const WORDS = { title: 'app.listed' };",
    "t('app.title');",
    "t(`kind.${kind}`);",
    "t('parts.' + part);",
    "const hints = 'mode.list.';",
    "const looks = /app\\.pattern/;",
    "const template = `app.template`;",
  ].join('\n'));
  write('public/index.html', '<h1 data-i18n="app.html"></h1><button data-i18n-attr="title:app.attr"></button>');
  write('public/test/main.test.js', "t('app.tested');");
  write('scripts/smoke-test.js', "t('app.smoke');");
  // The module's copy of the kit, which says the server's error codes with the module's words too.
  write('server/suite/web/api.js', 'const sentence = t(`errors.${code}`);');
  return root;
}

test('unusedKeys: a key is read where a literal names it in full, in the code or the HTML', () => {
  const root = fixture();
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'public/i18n/en.json'), 'utf8'));
    const keys = Object.keys(catalog).filter((key) => !key.startsWith('$meta'));
    const own = [path.join(root, 'public'), path.join(root, 'scripts'), path.join(root, 'server')];
    const { unused, prefixes } = unusedKeys(keys, own);
    assert.deepEqual(unused, ['app.comment', 'app.pattern', 'app.tested', 'app.gone', 'errors.mine'],
      'named only in a comment, a regular expression or a test, or nowhere: the kit in server/suite is not read unasked');
    assert.deepEqual(prefixes.map(({ prefix, keys: kept }) => [prefix, kept]), [['kind.', 3], ['mode.list.', 1], ['parts.', 2]],
      'a template, a string joined with +, a dotted string ending in a dot: each keeps the keys under it');
    assert.match(prefixes[0].files[0], /main\.js$/, 'and says where it is built');
    const withKit = unusedKeys(keys, [...own, path.join(root, 'server', 'suite')]);
    assert.equal(withKit.unused.includes('errors.mine'), false, 'named, the kit is read: it builds errors.…');
    assert.deepEqual(withKit.prefixes.find(({ prefix }) => prefix === 'errors.')?.keys, 1);
    const skipped = unusedKeys(keys, own, { skip: ['smoke-test.js'] });
    assert.ok(skipped.unused.includes('app.smoke'), 'a file left out reads nothing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the unused command lists the keys nothing reads, says what kept the built ones, and fails while there are some', () => {
  const root = fixture();
  try {
    const run = (...args) => spawnSync(process.execPath, [TOOL, 'unused', ...args], { cwd: root, encoding: 'utf8' });
    const found = run('public/i18n', 'public', 'scripts', '--skip', 'smoke-test.js');
    assert.equal(found.status, 1);
    assert.match(found.stdout, /Kept because the code builds keys under them/);
    assert.match(found.stdout, /^ {2}kind\.… {2}3 keys nothing names in full; built in public\/js\/main\.js$/m);
    assert.match(found.stdout, /^6 of the 17 keys of public\/i18n that nothing reads:$/m);
    for (const key of ['app.comment', 'app.pattern', 'app.tested', 'app.smoke', 'app.gone', 'errors.mine']) {
      assert.match(found.stdout, new RegExp(`^ {2}${key.replace('.', '\\.')}$`, 'm'), key);
    }
    assert.doesNotMatch(found.stdout, /\$meta/, 'what describes the file is no text');

    // Every key read: nothing to say but that.
    fs.writeFileSync(path.join(root, 'public/i18n/en.json'), JSON.stringify({ 'app.title': 'Title', 'kind.one': 'One' }));
    const clean = run('public/i18n', 'public');
    assert.equal(clean.status, 0);
    assert.match(clean.stdout, /^Every key of public\/i18n is read \(2\)$/m);
    assert.equal(run().status, 1, 'without a catalog, how to use it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
