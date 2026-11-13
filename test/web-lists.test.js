/**
 * What a list looks like the same in every module (web/ui.js, web/kit.css, web-kit.md rules
 * 10-12): the empty and loading place, the add bar, the notices over it, the row open in the
 * detail and the detail as a column of its own; and the ink on a list's colour.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom, FakeElement } from './fake-dom.js';

const document = installFakeDom();
// The page's bars and notices are the body's.
document.querySelectorAll = (selector) => document.body.querySelectorAll(selector);
globalThis.window = { innerWidth: 1280, innerHeight: 800 };
FakeElement.prototype.getBoundingClientRect = function rect() {
  return this._rect || { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
};

const { blank, addBar, inkOn, INK, toast } = await import('../web/ui.js');
const kit = fs.readFileSync(new URL('../web/kit.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const shell = fs.readFileSync(new URL('../web/shell.js', import.meta.url), 'utf8');

const classOf = (node) => node.getAttribute('class') || '';
const tagsOf = (node) => node.children.map((child) => child.tagName.toLowerCase());

test('blank: as before without the new options, a heading of its own alone in a view', () => {
  const plain = blank({ iconName: 'notes', title: 'Nada', text: 'Aún' });
  assert.equal(classOf(plain), 'kit-blank');
  assert.deepEqual(tagsOf(plain), ['span', 'strong', 'p']);
  const page = blank({ title: 'Nada', page: true, action: { label: 'Volver', href: '#/' }, note: 'Ojo' });
  assert.equal(classOf(page), 'kit-blank kit-blank--page');
  assert.deepEqual(tagsOf(page), ['span', 'h2', 'a', 'p']);
  assert.equal(page.children[2].getAttribute('href'), '#/');
  assert.match(classOf(page.children[3]), /kit-blank__note/);
  // A sentence alone, and the emoji a person chose in the box.
  const sentence = blank({ glyph: '🛒', text: 'Lista vacía.' });
  assert.deepEqual(tagsOf(sentence), ['span', 'p']);
  assert.equal(sentence.children[0].children[0].textContent, '🛒');
});

test('blank: loading is the spinner and «Cargando…», said to a screen reader', () => {
  const loading = blank({ loading: true, page: true });
  assert.match(classOf(loading), /kit-blank--loading/);
  assert.equal(loading.getAttribute('role'), 'status');
  assert.match(classOf(loading.children[0].children[0]), /kit-spinner/);
  assert.equal(loading.children[1].tagName.toLowerCase(), 'h2');
  assert.ok(loading.children[1].textContent);
});

test('one size of title for a list\'s empty place and a view\'s', () => {
  assert.match(kit, /\.kit-blank strong, \.kit-blank h2 \{[^}]*font-size: var\(--look-headline, 15px\)/);
  assert.doesNotMatch(kit, /\.kit-blank h2 \{[^}]*title3/);
});

test('addBar: a +, the field, the module\'s tools and «Añadir»; onAdd gets what was typed', () => {
  const tool = document.createElement('button');
  const added = [];
  const bar = addBar({ placeholder: 'Añadir una tarea', tools: [tool], onAdd: (text) => added.push(text), className: 'add-task', id: 'f', input: { id: 'i', maxlength: '500' } });
  assert.equal(classOf(bar), 'kit-add-bar add-task');
  assert.equal(bar.getAttribute('id'), 'f');
  const [plus, input, middle, add] = bar.children;
  assert.match(classOf(plus), /kit-add-bar__plus/);
  assert.equal(input.getAttribute('id'), 'i');
  assert.equal(input.getAttribute('placeholder'), 'Añadir una tarea');
  assert.equal(middle, tool);
  assert.equal(add.getAttribute('type'), 'submit');
  input.value = '  pan  ';
  for (const fn of bar.listeners.submit) fn({ preventDefault() {} });
  input.value = '   ';
  for (const fn of bar.listeners.submit) fn({ preventDefault() {} });
  assert.deepEqual(added, ['pan']);
  assert.match(kit, /\.kit-add-bar \{[^}]*border-radius: var\(--kit-radius\);[^}]*box-shadow: var\(--kit-shadow\);/);
});

test('a notice rises over an add bar under it, and not over one hidden or beside it', () => {
  // A style that keeps its custom properties, as a browser's.
  Object.defineProperty(FakeElement.prototype, 'style', {
    configurable: true,
    get() {
      const props = (this._props ||= {});
      return (this._style ||= { props, setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; } });
    },
  });
  const bar = addBar({ placeholder: 'x' });
  document.body.append(bar);
  const floor = () => [...document.querySelectorAll('.kit-toasts')].at(-1).style.props['--kit-toast-floor'];
  bar._rect = { top: 720, bottom: 776, left: 276, right: 1004, width: 728, height: 56 };
  toast('Hecho');
  assert.equal(floor(), `${800 - 720 + 8}px`);
  // Beside the notices (the left of the screen): where they always were.
  bar._rect = { top: 720, bottom: 776, left: 0, right: 300, width: 300, height: 56 };
  toast('Hecho');
  assert.equal(floor(), undefined);
  // Hidden: no box.
  bar._rect = null;
  toast('Hecho');
  assert.equal(floor(), undefined);
  assert.match(kit, /\.kit-toasts \{[^}]*bottom: max\(calc\(16px \+ var\(--kit-safe-bottom\)\), var\(--kit-toast-floor, 0px\)\)/);
  assert.match(kit, /:root\[data-kit-keyboard\] \.kit-toasts \{[^}]*max\(16px, var\(--kit-toast-floor, 0px\)\)/);
  bar.remove();
});

test('the open row and the detail as a column are the kit\'s', () => {
  assert.match(kit, /\.kit-row\[aria-current="true"\] \{ background: var\(--kit-accent-soft\); \}/);
  assert.match(kit, /\.kit-app\[data-detail="column"\]\[data-layout="side"\]\[data-panes="split"\]\[data-detail-open\] \.kit-shell \{\s*grid-template-columns: var\(--kit-side-width, 260px\) minmax\(0, 1fr\) minmax\(340px, 400px\);/);
  assert.match(kit, /\.kit-app\[data-detail="column"\]:not\(\[data-detail-open\]\) \.kit-pane--detail \{ display: none; \}/);
  assert.match(kit, /\[data-detail="column"\]\[data-folded\][^{]*\[data-detail-open\] \.kit-shell \{\s*grid-template-columns: minmax\(0, 1fr\) minmax\(340px, 400px\);/);
  assert.match(shell, /detailMode === 'column' \? \{ 'data-detail': 'column' \}/);
  assert.match(shell, /setDetailOpen: \(open\) => element\.toggleAttribute\('data-detail-open', Boolean\(open\)\)/);
});

test('inkOn: white where it reads 4.5:1, the dark ink where white doesn\'t', () => {
  for (const dark of ['#2564cf', '#7b61c9', '#c2407c', '#1b6b6b', '#107c41', '#16130e']) assert.equal(inkOn(dark), '#fff', dark);
  for (const light of ['#3aab5c', '#0f8bb2', '#8a9a1f', '#d9622b', '#ffd23f', '#fff']) assert.equal(inkOn(light), INK, light);
  assert.equal(inkOn(null), '#fff');
  assert.equal(inkOn('rebeccapurple'), '#fff');
});
