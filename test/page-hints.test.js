/**
 * What a module's page asks for as it starts (page-hints.js): its code read
 * from its files, and the Link header the host sends with the page.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { moduleGraph, languageOf, createPageHints } from '../page-hints.js';

function app(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-hints-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const PAGE = `<!DOCTYPE html><html><head>
  <script src="js/theme.js"></script>
  <link rel="stylesheet" href="css/app.css">
</head><body><script type="module" src="js/main.js"></script></body></html>`;

test('the graph: every file the page’s static imports reach, the kit’s too, once each', (t) => {
  const dir = app(t, {
    'index.html': PAGE,
    'js/main.js': [
      "import { a } from './a.js';",
      "import {\n  b,\n  c as d,\n} from \"./b.js\";",
      "import '../suite/shell.js';",
      "export * from './c.js';",
      "export { e } from './a.js';",
      "const later = () => import('./lazy.js');",
      "import x from 'https://cdn.example/x.js';",
      "import y from 'bare-name';",
      "import gone from './missing.js';",
    ].join('\n'),
    'js/a.js': "import { b } from './b.js'; export const a = 1;",
    'js/b.js': 'export const b = 2;',
    'js/c.js': "export * from '/js/b.js';",
    'js/lazy.js': 'export const lazy = 1;',
  });
  const graph = moduleGraph(dir);
  assert.deepEqual(graph.slice(0, 5), ['/js/main.js', '/js/a.js', '/js/b.js', '/suite/shell.js', '/js/c.js'],
    'a classic script, a lazy import, a URL, a bare name and a missing file aren’t in it');
  assert.ok(graph.includes('/suite/dom.js') && graph.slice(5).every((p) => p.startsWith('/suite/')),
    'the kit’s files are read in suite-core, with what they import');
  assert.equal(new Set(graph).size, graph.length, 'once each');
  assert.deepEqual(moduleGraph(path.join(dir, 'nowhere')), [], 'without a page, nothing');
});

test('languageOf: the browser’s first language the module speaks', () => {
  assert.equal(languageOf('es-ES,es;q=0.9,en;q=0.8', ['en', 'es']), 'es');
  assert.equal(languageOf('pt-BR, de;q=0.5', ['en', 'de']), 'de');
  assert.equal(languageOf('pt-BR', ['en', 'es']), null);
  assert.equal(languageOf(undefined, ['en']), null);
});

test('the Link header: the code, the tab’s version, the catalogs, the install’s settings and the modules', (t) => {
  const dir = app(t, {
    'index.html': PAGE,
    'js/main.js': "import '../suite/i18n.js'; import '../suite/update.js'; import '../suite/shell.js'; import './a.js';",
    'js/a.js': 'export const a = 1;',
  });
  const hintsFor = createPageHints();
  const req = { headers: { 'accept-language': 'es-ES,es;q=0.9' } };
  const links = hintsFor({ mount: 'tasks', publicDir: dir, languages: ['en', 'es'] }, req).split(', ');
  assert.deepEqual(links, [
    '</tasks/js/main.js>; rel=modulepreload',
    '</tasks/suite/i18n.js>; rel=modulepreload',
    '</tasks/suite/update.js>; rel=modulepreload',
    '</tasks/suite/shell.js>; rel=modulepreload',
    '</tasks/js/a.js>; rel=modulepreload',
    ...links.slice(5, -6),
    '</tasks/js/app-version.js>; rel=modulepreload',
    '</tasks/i18n/en.json>; rel=preload; as=fetch; crossorigin',
    '</tasks/i18n/es.json>; rel=preload; as=fetch; crossorigin',
    '</tasks/api/auth/config>; rel=preload; as=fetch; crossorigin',
    '</tasks/api/auth/me>; rel=preload; as=fetch; crossorigin',
    '</api/modules>; rel=preload; as=fetch; crossorigin',
  ]);
  assert.ok(links.slice(5, -6).every((l) => /^<\/tasks\/suite\/[\w-]+\.js>; rel=modulepreload$/.test(l)), 'then what the kit’s files import');

  // What the module says it asks first, in place of the suite's /api/auth/me; only its own paths.
  const declared = hintsFor({ mount: 'tasks', publicDir: dir, preload: ['/api/me', '/api/bootstrap', '//evil.example/x', 'api/x', 7] }, req);
  assert.match(declared, /<\/tasks\/api\/me>; rel=preload; as=fetch; crossorigin, <\/tasks\/api\/bootstrap>; rel=preload; as=fetch; crossorigin, <\/api\/modules>/);
  assert.doesNotMatch(declared, /auth\/me|evil|tasks\/api\/x|7/);

  const english = hintsFor({ mount: 'tasks', publicDir: dir, languages: ['en', 'es'] }, { headers: { 'accept-language': 'en-GB' } });
  assert.doesNotMatch(english, /es\.json/, 'English only once');
  assert.doesNotMatch(hintsFor({ mount: 'tasks', publicDir: dir, languages: ['en'] }, req), /es\.json/, 'not a language of the module');

  // A file that changes is read again: a new import is in the next page's hints.
  fs.writeFileSync(path.join(dir, 'js/a.js'), "import './b.js'; export const a = 1;");
  fs.writeFileSync(path.join(dir, 'js/b.js'), 'export const b = 2;');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'js/a.js'), later, later);
  assert.match(hintsFor({ mount: 'tasks', publicDir: dir, languages: ['en'] }, req), /<\/tasks\/js\/b\.js>; rel=modulepreload/);

  assert.equal(hintsFor({ mount: 'x', publicDir: null }, req), null, 'a module without pages');
  assert.equal(hintsFor({ mount: 'y', publicDir: app(t, { 'index.html': '<title>No code</title>' }) }, req), null, 'a page without code');
});
