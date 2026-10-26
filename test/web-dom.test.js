/**
 * The kit's DOM helpers as the modules call them (dom.js and ui.js field): an inline style given
 * as an object, data-* as an object, SVG elements, children in arrays nested inside arrays, and a
 * field that keeps an app's own classes. Without the new options, everything as before.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';

installFakeDom();
const { el, svg, append, clear, $, $$ } = await import('../web/dom.js');
const { field } = await import('../web/ui.js');

/** A style that records what was set, custom properties apart (as a browser's CSSStyleDeclaration). */
function recordingStyle(node) {
  const style = { custom: {}, setProperty(name, value) { this.custom[name] = value; } };
  node.style = style;
  return style;
}

test('el: style as an object sets properties, --custom ones through setProperty; a string is still an attribute', () => {
  const realCreate = document.createElement;
  let style;
  document.createElement = (tag) => { const node = realCreate(tag); style = recordingStyle(node); return node; };
  try {
    const node = el('span', { style: { color: 'red', '--accent': '#f00', width: null } });
    assert.equal(style.color, 'red');
    assert.deepEqual(style.custom, { '--accent': '#f00' });
    assert.equal('width' in style, false, 'a null property is skipped');
    assert.equal(node.hasAttribute('style'), false, 'no "[object Object]" attribute');
  } finally {
    document.createElement = realCreate;
  }
  assert.equal(el('span', { style: 'color: red' }).getAttribute('style'), 'color: red');
});

test('el: dataset as an object writes data-* attributes', () => {
  const node = el('li', { dataset: { id: '7', listId: '3' } });
  assert.equal(node.getAttribute('data-id'), '7');
  assert.equal(node.getAttribute('data-list-id'), '3');
  assert.equal(node.hasAttribute('dataset'), false);
});

test('el: children as arguments or in arrays nested any depth, gaps skipped, numbers as text', () => {
  const a = el('b'); const b = el('i'); const c = el('u');
  const node = el('p', {}, [a, [b, null, [c, false]], 3]);
  assert.deepEqual(node.childNodes.slice(0, 3), [a, b, c]);
  assert.equal(node.textContent, '3');
  assert.equal(el('p', {}, 'x', null, 'y').textContent, 'xy');
  assert.equal(append(el('p'), [[['deep']]]).textContent, 'deep');
});

test('el: listeners by lowercase or camelCase name, value and checked as properties, the rest attributes', () => {
  let clicks = 0;
  const button = el('button', { onClick: () => { clicks += 1; }, class: 'a b', disabled: true, hidden: false, title: null });
  button.click();
  assert.equal(clicks, 1);
  assert.equal(button.getAttribute('class'), 'a b');
  assert.equal(button.getAttribute('disabled'), '');
  assert.equal(button.hasAttribute('hidden'), false);
  assert.equal(button.hasAttribute('title'), false);
  const box = el('input', { type: 'checkbox', checked: true, value: 'on' });
  assert.equal(box.checked, true);
  assert.equal(box.value, 'on');
});

test('svg: an element in the SVG namespace, with the same props and children as el', () => {
  const line = svg('line', { x1: 0, y1: 0, x2: 10, y2: 10, class: 'edge' });
  const group = svg('g', { 'aria-hidden': true }, [line, null]);
  assert.equal(group.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(line.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(line.getAttribute('x2'), '10');
  assert.equal(line.getAttribute('class'), 'edge');
  assert.equal(group.getAttribute('aria-hidden'), '');
  assert.deepEqual(group.children, [line]);
});

test('$, $$ and clear: from a given root; clear returns the emptied node', () => {
  const root = el('div', {}, el('p', { class: 'x' }), el('p', { class: 'x' }));
  assert.equal($('.x', root), root.children[0]);
  assert.equal($$('.x', root).length, 2);
  assert.equal(clear(root), root);
  assert.equal(root.childNodes.length, 0);
});

test('field without options: the kit field as always (kit-field, <label for>, <p class="kit-hint">)', () => {
  const input = el('input');
  const node = field('Name', input, 'A hint');
  assert.equal(node.getAttribute('class'), 'kit-field');
  const [label, control, hint] = node.children;
  assert.equal(label.tagName, 'LABEL');
  assert.equal(label.getAttribute('for'), input.id);
  assert.equal(control, input);
  assert.equal(hint.tagName, 'P');
  assert.equal(hint.getAttribute('class'), 'kit-hint');
  assert.equal(input.getAttribute('aria-describedby'), hint.getAttribute('id'));
  assert.equal(hint.getAttribute('id'), `${input.id}-hint`);
  // Even what a label can't name gets a <label> and an id, as before.
  const group = el('div');
  assert.equal(field('Colour', group).children[0].tagName, 'LABEL');
  assert.ok(group.id);
});

test('field with an app’s options: its classes and hint tag, a <span> over a group, ids left alone there', () => {
  const look = { class: 'field', hintClass: 'field__note', hintTag: 'small', groupLabel: true };
  const select = el('select');
  select.id = 'role';
  const node = field('Role', select, 'Who can edit', look);
  assert.equal(node.getAttribute('class'), 'field');
  const [label, , hint] = node.children;
  assert.equal(label.tagName, 'LABEL');
  assert.equal(label.getAttribute('for'), 'role', 'an id already there is kept');
  assert.equal(hint.tagName, 'SMALL');
  assert.equal(hint.getAttribute('class'), 'field__note');

  const palette = el('div', { class: 'palette' });
  const grouped = field('Colour', palette, null, look);
  assert.equal(grouped.children[0].tagName, 'SPAN');
  assert.equal(grouped.children[0].textContent, 'Colour');
  assert.equal(palette.hasAttribute('id'), false);
  assert.equal(grouped.children.length, 2, 'no hint without one');

  const withHint = field('Colour', el('div'), 'Pick one', look);
  assert.equal(withHint.children[2].hasAttribute('id'), false, 'a hint over a group has no id to point at');
});
