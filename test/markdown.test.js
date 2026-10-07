/**
 * The web kit's Markdown (web/markdown.js): what it reads, what it draws, and
 * the usual XSS payloads drawn as harmless text or links.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

installFakeDom();
const {
  parseMarkdown, parseInline, renderMarkdown, toggleTask, titleOf, plainText, safeHref, safeImage,
} = await import('../web/markdown.js');

const types = (nodes) => nodes.map((n) => n.type);

test('blocks: headings, paragraphs, rules, quotes, code, tables', () => {
  const doc = parseMarkdown([
    '# Meeting with Ruiz', '', 'Five of us.', 'Same paragraph.', '', '---', '> quoted', '> still', '',
    '```js', 'const a = "<b>";', '```', '', '| Who | Cost |', '|:--|--:|', '| Ana | 2 \\| 3 |',
  ].join('\n'));
  assert.deepEqual(types(doc.children), ['heading', 'paragraph', 'rule', 'quote', 'code', 'table']);
  assert.equal(doc.children[0].level, 1);
  assert.deepEqual(doc.children[1].children, [{ type: 'text', text: 'Five of us.\nSame paragraph.' }]);
  assert.equal(doc.children[4].text, 'const a = "<b>";');
  assert.equal(doc.children[4].lang, 'js');
  const table = doc.children[5];
  assert.deepEqual(table.align, ['left', 'right']);
  assert.deepEqual(table.rows[0][1], [{ type: 'text', text: '2 | 3' }]);
});

test('lists: nested, ordered, tasks with their line in the source', () => {
  const source = ['- one', '  - inner', '- [ ] to do', '- [x] done', '', '3. third', '4. fourth'].join('\n');
  const doc = parseMarkdown(source);
  assert.deepEqual(types(doc.children), ['list', 'list']);
  const [bullets, numbers] = doc.children;
  assert.equal(bullets.items.length, 3);
  assert.equal(bullets.items[0].children[1].type, 'list', 'the indented item is a list inside the first');
  assert.deepEqual(bullets.items.map((i) => i.task), [null, false, true]);
  assert.deepEqual(bullets.items.map((i) => i.line), [0, 2, 3]);
  assert.equal(numbers.ordered, true);
  assert.equal(numbers.start, 3);
  assert.equal(toggleTask(source, 2, true).split('\n')[2], '- [x] to do');
  assert.equal(toggleTask(source, 3, false).split('\n')[3], '- [ ] done');
  assert.equal(toggleTask(source, 0, true), source, 'a line that is no task stays as it was');
});

test('inline: strong, emphasis, struck, code, links, breaks; snake_case stays', () => {
  assert.deepEqual(types(parseInline('**bold** and *it* and ~~gone~~ and `x*y`')),
    ['strong', 'text', 'em', 'text', 'del', 'text', 'code']);
  const nested = parseInline('**bold *both* bold**');
  assert.equal(nested[0].type, 'strong');
  assert.deepEqual(types(nested[0].children), ['text', 'em', 'text']);
  assert.deepEqual(parseInline('snake_case_name and 2 * 3 * 4'), [{ type: 'text', text: 'snake_case_name and 2 * 3 * 4' }]);
  assert.deepEqual(parseInline('a \\*literal\\*'), [{ type: 'text', text: 'a *literal*' }]);
  assert.deepEqual(types(parseInline('==seen== and ++under++ and ==**both**==')),
    ['mark', 'text', 'u', 'text', 'mark']);
  assert.equal(parseInline('==**both**==')[0].children[0].type, 'strong');
  // Inside a word, in code-like text, or with a space after, they are only characters.
  for (const plain of ['C++ and C++', 'if a==b or b==c', 'x ++ y ++ z', '= = and ===long===', 'a \\==b==']) {
    assert.ok(parseInline(plain).every((n) => n.type === 'text'), plain);
  }
  const link = parseInline('see [the brief](https://example.com/a_(b) "Brief") now')[1];
  assert.equal(link.href, 'https://example.com/a_(b)');
  assert.equal(link.title, 'Brief');
  assert.deepEqual(types(parseInline('line  \nnext')), ['text', 'br', 'text']);
  assert.deepEqual(types(parseInline('go to https://cronumstudio.com.')), ['text', 'link', 'text']);
  assert.equal(parseInline('go to https://cronumstudio.com.')[1].href, 'https://cronumstudio.com');
});

test('drawn with el(): the tree as elements, tasks tickable only when asked', () => {
  const ticks = [];
  const node = renderMarkdown('# Title\n\n- [ ] call **Ana**\n- plain', { onTaskToggle: (line, done) => ticks.push([line, done]) });
  assert.equal(node.className, 'kit-md');
  assert.equal(node.find('h1')[0].textContent, 'Title');
  const box = node.find('input')[0];
  assert.equal(box.getAttribute('type'), 'checkbox');
  assert.equal(box.getAttribute('data-line'), '2');
  box.checked = true;
  box.dispatch('change');
  assert.deepEqual(ticks, [[2, true]]);
  assert.equal(node.find('strong')[0].textContent, 'Ana');
  const marks = renderMarkdown('==seen== and ++under++');
  assert.equal(marks.find('mark')[0].textContent, 'seen');
  assert.equal(marks.find('u')[0].textContent, 'under');
  const readOnly = renderMarkdown('- [x] done');
  assert.ok(readOnly.find('input')[0].hasAttribute('disabled'));
});

test('XSS payloads stay text, and links and images only go where they may', () => {
  const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)> <a href="javascript:alert(1)">x</a>');
  assert.equal(html.find('script').length, 0);
  assert.equal(html.find('img').length, 0);
  assert.equal(html.find('a').length, 0);
  assert.match(html.textContent, /<script>alert\(1\)<\/script>/, 'shown as the text it is');

  for (const evil of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', ' javascript:alert(1)',
    'vbscript:msgbox(1)', 'data:text/html,<script>alert(1)</script>', 'java&#x09;script:alert(1)'.replace('&#x09;', '\u0009')]) {
    const node = renderMarkdown(`[click](${evil.replace(/ /g, '%20')})`);
    for (const a of node.find('a')) assert.doesNotMatch(a.getAttribute('href'), /^(?:javascript|vbscript|data):/i, evil);
  }
  assert.equal(renderMarkdown('[click](javascript:alert(1))').find('a').length, 0);
  assert.equal(renderMarkdown('<javascript:alert(1)>').find('a').length, 0);

  const quoted = renderMarkdown('[x](https://a.example/" onmouseover="alert(1))').find('a')[0];
  assert.equal(quoted?.getAttribute('onmouseover') ?? null, null, 'an attribute is a value, never more markup');

  const outside = renderMarkdown('![chart](https://tracker.example/pixel.png)');
  assert.equal(outside.find('img').length, 0, 'no request to a third party');
  assert.equal(outside.find('a')[0].getAttribute('href'), 'https://tracker.example/pixel.png');
  assert.equal(renderMarkdown('![x](//tracker.example/p.png)').find('img').length, 0);
  assert.equal(renderMarkdown('![x](data:image/png;base64,AAAA)').find('img').length, 0);
  const own = renderMarkdown('![plan](/api/files/12)').find('img')[0];
  assert.equal(own.getAttribute('src'), '/api/files/12');
  assert.equal(renderMarkdown('![p](att:3)', { resolveImage: (src) => src.replace('att:', '/api/files/') }).find('img')[0].getAttribute('src'), '/api/files/3');

  const external = renderMarkdown('[site](https://cronumstudio.com)').find('a')[0];
  assert.equal(external.getAttribute('rel'), 'noopener noreferrer nofollow');
  assert.equal(renderMarkdown('```<b onclick=x>\nx\n```').find('code')[0].getAttribute('data-lang'), null);

  assert.equal(safeHref('mailto:ana@example.com'), 'mailto:ana@example.com');
  assert.equal(safeHref('/?app&note=12'), '/?app&note=12');
  assert.equal(safeImage('/\\evil.example/x.png'), null);
});

test('titles and plain text for lists and previews', () => {
  assert.equal(titleOf('\n\n## Meeting with Ruiz ##\nbody'), 'Meeting with Ruiz');
  assert.equal(titleOf('Plain first line'), 'Plain first line');
  assert.equal(plainText('# Title\n\nSome **bold** and [a link](https://x.example).\n\n- one\n- two'),
    'Title Some bold and a link. one two');
});

test('nothing in the kit writes HTML from strings', () => {
  for (const file of fs.readdirSync(new URL('../web/', import.meta.url)).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\(/, file);
  }
});
