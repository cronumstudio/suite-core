/**
 * A module's sheet scoped to its windows (scope-css.js): what goes inside @scope and what before
 * it, the page's root and body as the window, the url()s at the site's paths, and the real sheets
 * (the kit's here; the modules' too when their checkouts are beside this one, or named in
 * SCOPE_CSS_SHEETS, a list of folders separated by the system's path delimiter).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeCss } from '../scope-css.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCOPE = '@scope ([data-module="notes"], [data-owner="notes"]) {';
const scoped = (css, sheet = '/notes/css/app.css') => scopeCss(css, 'notes', sheet);
/** What a scoped sheet holds inside its @scope block, one line per rule, without the block's own lines. */
const inside = (out) => out.slice(out.indexOf(SCOPE) + SCOPE.length, out.lastIndexOf('}')).trim();
/** What comes before the block. */
const before = (out) => out.slice(0, out.indexOf('@scope (')).trim();

/** The text without its strings and unquoted url()s: what braces and selectors are left to count. */
const bare = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '""')
  .replace(/url\(\s*[^'")\s][^)]*\)/gi, 'url()');

/** Whether every brace closes one opened before it, and all of them close. */
function balanced(css) {
  let depth = 0;
  for (const c of bare(css)) {
    if (c === '{') depth += 1;
    else if (c === '}' && (depth -= 1) < 0) return false;
  }
  return depth === 0;
}

/** The top-level preludes of a sheet: what is outside every block. */
function topPreludes(css) {
  const text = bare(css);
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') {
      if (depth === 0) out.push(text.slice(start, i).trim());
      depth += 1;
    } else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) start = i + 1;
    } else if (text[i] === ';' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return out;
}

/** Every selector in a sheet that still names the page: `:root`, `html` or `body` as a type. */
function pageSelectors(css) {
  const preludes = [...bare(css).matchAll(/([^{};]+)\{/g)].map((m) => m[1].trim()).filter((p) => !p.startsWith('@'));
  return preludes.filter((p) => /:root(?![\w-])/i.test(p) || /(^|[\s,>+~(])(html|body)(?![\w-])/i.test(p));
}

/** The class names a sheet styles. */
const classesOf = (css) => new Set([...bare(css).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));

test('the module’s rules go inside @scope, its variables at the scope’s root', () => {
  const out = scoped(':root { --accent: #f00; }\n:root[data-theme="dark"] { --accent: #0f0; }\n.card { color: var(--accent); }');
  assert.ok(out.startsWith(SCOPE), 'nothing before the block when the sheet has nothing of the page’s');
  assert.deepEqual(inside(out).split('\n'), [
    ':scope { --accent: #f00; }',
    ':scope[data-theme="dark"] { --accent: #0f0; }',
    '.card { color: var(--accent); }',
  ]);
  assert.ok(out.endsWith('}\n'));
  assert.ok(balanced(out));
});

test('html and body are the window only; the page’s root and its body are one element now', () => {
  const lines = inside(scoped([
    'html, body { height: 100%; }',
    'body { margin: 0; }',
    ':root[data-lienzo="recortado"] body { background: var(--surface); }',
    'html > body.dragging::before { content: "}"; }',
    'html body .a { color: red; }',
    'body > :not(.print-note) { display: none; }',
    ':is(html, .x) .b, :not(body) { color: red; }',
    ':root .main, :root > .side { padding: 0; }',
  ].join('\n'))).split('\n');
  assert.deepEqual(lines, [
    ':scope[data-module], :scope[data-module] { height: 100%; }',
    ':scope[data-module] { margin: 0; }',
    ':scope[data-lienzo="recortado"][data-module] { background: var(--surface); }',
    ':scope[data-module].dragging::before { content: "}"; }',
    ':scope[data-module] .a { color: red; }',
    ':scope[data-module] > :not(.print-note) { display: none; }',
    ':is(:scope[data-module], .x) .b, :not(:scope[data-module]) { color: red; }',
    ':scope .main, :scope > .side { padding: 0; }',
  ]);
});

test('a class, an attribute or a value that only says body or html is not the page', () => {
  const css = [
    '.entry__body, .dialog__body > .x, #body, [data-part=body], [title="html body"] { grid-area: body; }',
    '.tbody .html-view { font-family: body, html; }',
    'tbody, bodyish, x-body { color: red; }',
  ].join('\n');
  assert.equal(inside(scoped(css)), css);
});

test('@media, @supports, @container and @layer stay inside, their rules rooted the same way', () => {
  const out = scoped([
    '@media (max-width: 600px) { body { padding: 0 } .a { color: blue } }',
    '@supports (display: grid) { @media print { html, body { height: auto } } }',
    '@container kit-app (min-width: 640px) { :root .main { padding: 0 } }',
    '@layer base { :root { --x: 1 } }',
    '@media print{body>.x{display:none}}',
  ].join('\n'));
  assert.equal(before(out), '');
  assert.equal(inside(out), [
    '@media (max-width: 600px) {', ':scope[data-module] { padding: 0 }', '.a { color: blue }', '}',
    '@supports (display: grid) {', '@media print {', ':scope[data-module], :scope[data-module] { height: auto }', '}', '}',
    '@container kit-app (min-width: 640px) {', ':scope .main { padding: 0 }', '}',
    '@layer base {', ':scope { --x: 1 }', '}',
    '@media print {', ':scope[data-module] > .x {display:none}', '}',
  ].join('\n'));
  assert.ok(balanced(out));
});

test('what only means something for the whole page goes before the block, in the order a sheet needs it', () => {
  const out = scoped([
    '.a { animation: spin 1s; }',
    '@font-face { font-family: X; src: url(../fonts/x.woff2?v=2#iefix) format("woff2"); }',
    '@keyframes spin { from { transform: rotate(0) } to { transform: rotate(1turn) } }',
    '@-webkit-keyframes spin { to { opacity: 0 } }',
    '@property --angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }',
    '@view-transition { navigation: auto; }',
    '@import url("theme.css") screen;',
    '@charset "utf-8";',
    '@media (prefers-reduced-motion: no-preference) { @keyframes fade { to { opacity: 0 } } .b { animation: fade 1s } }',
  ].join('\n'));
  assert.equal(before(out), [
    '@charset "utf-8";',
    '@import url("/notes/css/theme.css?scope=work") screen;',
    '@font-face { font-family: X; src: url(/notes/fonts/x.woff2?v=2#iefix) format("woff2"); }',
    '@keyframes spin { from { transform: rotate(0) } to { transform: rotate(1turn) } }',
    '@-webkit-keyframes spin { to { opacity: 0 } }',
    '@property --angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }',
    '@view-transition { navigation: auto; }',
    '@media (prefers-reduced-motion: no-preference) {\n@keyframes fade { to { opacity: 0 } }\n}',
  ].join('\n'), 'a group keeps its half of each side under its own condition');
  assert.equal(inside(out), '.a { animation: spin 1s; }\n@media (prefers-reduced-motion: no-preference) {\n.b { animation: fade 1s }\n}');
  // An @import of another site's sheet, or of a page's, is left as it is.
  assert.equal(before(scoped('@import "https://example.com/a.css";\n@import "/fonts/b.css?v=1";')),
    '@import "https://example.com/a.css";\n@import "/fonts/b.css?v=1";');
  assert.equal(before(scoped('@import "parts/c.css";', '/notes/css/app.css?v=3')), '@import "/notes/css/parts/c.css?scope=work";');
});

test('url()s are paths of the site: data:, another site’s, the site’s own and #fragments stay as they are', () => {
  const out = inside(scoped([
    '.a { background: url(img/a.png), url( "../icons/b.svg" ), url(\'./c.png?v=1\'); }',
    '.b { background: url(data:image/svg+xml;utf8,<svg>{}</svg>) no-repeat; mask: url(#grad); }',
    '.c { background: url(https://example.com/x.png), url(/abs.png), url(//cdn.example/y.png), url(blob:z); }',
  ].join('\n'), '/notes/css/sub/app.css'));
  assert.equal(out, [
    '.a { background: url(/notes/css/sub/img/a.png), url("/notes/css/icons/b.svg"), url(\'/notes/css/sub/c.png?v=1\'); }',
    '.b { background: url(data:image/svg+xml;utf8,<svg>{}</svg>) no-repeat; mask: url(#grad); }',
    '.c { background: url(https://example.com/x.png), url(/abs.png), url(//cdn.example/y.png), url(blob:z); }',
  ].join('\n'), 'a data: URL’s braces and semicolons are its own');
});

test('the screen’s edges are the window’s: env(safe-area-inset-…) through a variable windows.css sets', () => {
  const out = inside(scoped([
    ':root { --safe-top: env(safe-area-inset-top, 0px); }',
    '.bar { padding: calc(8px + env( safe-area-inset-bottom )) 12px; margin-left: env(safe-area-inset-left, 0); }',
  ].join('\n')));
  assert.equal(out, [
    ':scope { --safe-top: var(--cw-inset-top, env(safe-area-inset-top, 0px)); }',
    '.bar { padding: calc(8px + var(--cw-inset-bottom, env(safe-area-inset-bottom))) 12px; margin-left: var(--cw-inset-left, env(safe-area-inset-left, 0)); }',
  ].join('\n'));
});

test('comments go, strings keep what looks like CSS, nesting is rooted, and a broken sheet still closes', () => {
  const out = scoped([
    '/* :root { --gone: 1 } */ .a { content: "/* not a comment */ { ; }"; }',
    '.n { color: red; &:hover { color: blue; } body & { x: y } }',
    '} .stray { color: red; }',
    '.open { color: red;',
  ].join('\n'));
  assert.ok(balanced(out), out);
  assert.doesNotMatch(out, /--gone/);
  assert.match(out, /\.a \{ content: "\/\* not a comment \*\/ \{ ; \}"; \}/);
  assert.match(out, /\.n \{color: red; &:hover \{ color: blue; \} :scope\[data-module\] & \{ x: y \}\}/);
  assert.match(out, /\.stray \{ color: red; \}/, 'a stray brace is dropped, as the browser drops it');
  assert.match(out, /\.open \{ color: red;\n?\}/, 'a block left open is closed');
  assert.equal(scoped(''), `${SCOPE}\n\n}\n`);
  assert.throws(() => scopeCss('.a{}', 'Not a mount', '/x/a.css'), TypeError);
  assert.throws(() => scopeCss('.a{}', 'a"] , *, [x="', '/x/a.css'), TypeError, 'a mount never writes into the selector');
});

/** The folders whose .css files are real sheets to try: the kit's, and the modules' when they are at hand. */
function realSheets() {
  const folders = [path.join(HERE, '..', 'web')];
  const named = String(process.env.SCOPE_CSS_SHEETS || '').split(path.delimiter).filter(Boolean);
  const beside = ['next', 'notes', 'tasks', 'projects'].map((m) => path.join(HERE, '..', '..', m, 'public', 'css'));
  for (const dir of [...named, ...beside]) if (fs.existsSync(dir)) folders.push(dir);
  return folders.flatMap((dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => path.join(dir, f)));
}

test('real sheets: balanced, nothing of the page left, every class still styled', () => {
  const sheets = realSheets();
  assert.ok(sheets.length >= 3, 'the kit’s sheets at least');
  for (const file of sheets) {
    const css = fs.readFileSync(file, 'utf8');
    const out = scopeCss(css, 'notes', '/notes/css/app.css');
    const name = path.relative(path.join(HERE, '..', '..'), file);
    assert.ok(balanced(css) ? balanced(out) : true, `${name}: balanced braces`);
    assert.ok(balanced(out), `${name}: balanced braces`);
    assert.deepEqual(pageSelectors(inside(out)), [], `${name}: no :root, html or body left inside`);
    const tops = topPreludes(out);
    assert.equal(tops.filter((p) => p.startsWith('@scope (')).length, 1, `${name}: one @scope`);
    for (const top of tops.filter((p) => !p.startsWith('@scope ('))) {
      assert.match(top, /^@(?:-webkit-)?(?:charset|import|namespace|font-face|keyframes|property|counter-style|page|view-transition|media|supports|container|layer)\b/i,
        `${name}: only what is the page’s goes before the block: ${top}`);
    }
    assert.deepEqual([...classesOf(css)].filter((c) => !classesOf(out).has(c)), [], `${name}: every class kept`);
    assert.doesNotMatch(out, /url\(\s*['"]?(?!data:|https?:|\/|#)[a-z.]/i, `${name}: every url() a path of the site`);
  }
});
