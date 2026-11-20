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
  parseMarkdown, parseInline, renderMarkdown, titleOf, plainText, safeHref, safeImage,
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

test('drawn with el(): the tree as elements, tasks as read-only boxes', () => {
  const node = renderMarkdown('# Title\n\n- [ ] call **Ana**\n- plain');
  assert.equal(node.className, 'kit-md');
  assert.equal(node.find('h1')[0].textContent, 'Title');
  const box = node.find('input')[0];
  assert.equal(box.getAttribute('type'), 'checkbox');
  assert.ok(box.hasAttribute('disabled'));
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
  // Only the app's own files: no other address of it is asked for by a picture (sc-ui-11).
  for (const own of ['/api/files/12', '/notes/api/note-files/12', 'api/note-files/12?download=1', 'api/public/aB3_x-9/files/4']) {
    assert.equal(safeImage(own), own, own);
  }
  for (const other of ['/api/admin/export', '/api/admin/export?files/1', '/auth/logout', '/icons/favicon.svg', '/\\evil/files/1']) {
    assert.equal(safeImage(other), null, other);
  }
  const exported = renderMarkdown('![x](/api/admin/export)');
  assert.equal(exported.find('img').length, 0, 'never a request the reader didn’t make');
  assert.equal(exported.find('a')[0].getAttribute('href'), '/api/admin/export', 'a link they may follow, or not');
});

test('titles and plain text for lists and previews', () => {
  assert.equal(titleOf('\n\n## Meeting with Ruiz ##\nbody'), 'Meeting with Ruiz');
  assert.equal(titleOf('Plain first line'), 'Plain first line');
  assert.equal(plainText('# Title\n\nSome **bold** and [a link](https://x.example).\n\n- one\n- two'),
    'Title Some bold and a link. one two');
  // What an editor such as Tiptap writes: escapes, and entities for HTML and empty lines.
  assert.equal(titleOf('\\~12 tortitas \\*sin\\* az\\_car\n\nbody'), '~12 tortitas *sin* az_car');
  assert.equal(titleOf('&nbsp;\n\n# A &lt;b&gt; &amp; co\\#'), 'A <b> & co#');
  assert.equal(plainText('Uses &lt;b&gt;bold&lt;/b&gt; &amp; `&lt;kept&gt;`\n\n&nbsp;\n\nend'),
    'Uses <b>bold</b> & &lt;kept&gt; end');
});

test('entities: the named ones editors write and any by number', () => {
  const text = (source) => parseInline(source).map((n) => n.text).join('');
  assert.equal(text('a&nbsp;b'), 'a\u00a0b');
  assert.equal(text('&quot;&apos;&#169;&#x1F600;'), '"\'\u00a9\u{1f600}');
  assert.equal(text('&#0; &#xD800; &#1114112;'), '\ufffd \ufffd \ufffd');
  assert.equal(text('&copy; &amp &AMP; \\&amp;'), '&copy; &amp &AMP; &amp;');
  assert.deepEqual(parseInline('`&lt;`'), [{ type: 'code', text: '&lt;' }]);
  // Decoded, an entity is text: it never becomes a mark or a tag.
  assert.deepEqual(parseInline('&#42;not em&#42;'), [{ type: 'text', text: '*not em*' }]);
  const md = renderMarkdown('&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(md.find('img').length, 0);
  assert.equal(md.textContent, '<img src=x onerror=alert(1)>');
});

test('nothing in the kit writes HTML from strings', () => {
  for (const file of fs.readdirSync(new URL('../web/', import.meta.url)).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\(/, file);
  }
});

test('a note made to hang the page reads in linear time: marks left open, quotes and links inside each other (sc-ui-10)', { timeout: 60000 }, () => {
  // A note holds up to 200,000 characters (Notes' BODY_MAX). Before, '*a ' 20,000 times took seconds,
  // and a quote or a link nested 5,000 deep ran out of stack.
  const timed = (name, source, check = () => {}) => {
    const began = performance.now();
    const doc = parseMarkdown(source);
    renderMarkdown(doc);
    plainText(source);
    const took = performance.now() - began;
    assert.ok(took < 8000, `${name}: ${Math.round(took)} ms`);
    check(doc);
  };
  for (const unit of ['*a ', '_a ', '**a ', '***a ', '~~a ', '==a ', '++a ']) {
    timed(JSON.stringify(unit), unit.repeat(Math.floor(200000 / unit.length)), (doc) => {
      assert.ok(doc.children[0].children.every((n) => n.type === 'text'), 'all of it text: no mark closes');
    });
  }
  timed('[ left open', '['.repeat(200000));
  timed('[a]( left open', '[a]('.repeat(50000));
  timed('![a]( left open', '![a]('.repeat(40000));
  timed('*a _ … _ a*', `${'*a _'.repeat(25000)}b${'_ a*'.repeat(25000)}`);
  timed('> 10,000 times', `${'>'.repeat(10000)} x`, (doc) => {
    let depth = 0;
    for (let node = doc.children[0]; node?.type === 'quote'; node = node.children[0]) depth++;
    assert.equal(depth, 32, 'quotes up to 32 deep; under them, the rest as text');
  });
  timed('> > 10,000 times', `${'> '.repeat(10000)}x`);
  timed('- 10,000 times', `${'- '.repeat(10000)}x`);
  timed('5,000 links inside each other', `${'['.repeat(5000)}a${'](u)'.repeat(5000)}`, (doc) => {
    let depth = 0;
    for (let node = doc.children[0].children[0]; node?.type === 'link'; node = node.children[0]) depth++;
    assert.equal(depth, 32, 'links up to 32 deep; inside them, the rest as text');
  });
});

test('what notes really nest still reads as before', () => {
  const quotes = parseMarkdown('> one\n> > two\n> > > three');
  assert.equal(quotes.children[0].children[1].children[1].type, 'quote');
  const list = parseMarkdown('- a\n  - b\n    - c');
  assert.equal(list.children[0].items[0].children[1].items[0].children[1].type, 'list');
  assert.deepEqual(types(parseInline('[**a [b](c) d**](e) *x* [left [open](f)')), ['link', 'text', 'em', 'text', 'link']);
  assert.deepEqual(types(parseInline('a *b* c *d')), ['text', 'em', 'text']);
  assert.equal(parseInline('a *b* c *d').at(-1).text, ' c *d');
  assert.deepEqual(types(parseInline('*a* *b* **c** *d*')), ['em', 'text', 'em', 'text', 'strong', 'text', 'em']);
});
