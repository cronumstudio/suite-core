/**
 * Drag and drop without a browser: the pointer is played by hand over a page
 * of fake elements with boxes, and what is under it is found by those boxes.
 *
 *   npm test
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installFakeDom, FakeElement } from './fake-dom.js';

/* ------------------------------ a page to drag on ------------------------------ */

const document = installFakeDom();

// What drag.js asks of an element beyond fake-dom's: parents, selectors, classes, boxes, events.
function matches(node, selector) {
  return selector.split(',').some((part) => {
    const simple = part.trim();
    const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(simple);
    if (attr) return node.hasAttribute(attr[1]) && (attr[2] === undefined || node.getAttribute(attr[1]) === attr[2]);
    if (simple.startsWith('.')) return node.className.split(/\s+/).includes(simple.slice(1));
    return node.tagName === simple.toUpperCase();
  });
}
Object.defineProperties(FakeElement.prototype, Object.getOwnPropertyDescriptors({
  closest(selector) {
    for (let at = this; at && at.nodeType === 1; at = at.parentElement) if (matches(at, selector)) return at;
    return null;
  },
  contains(node) {
    for (let at = node; at; at = at.parentElement) if (at === this) return true;
    return false;
  },
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (name) => { if (!list().includes(name)) this.className = [...list(), name].join(' '); },
      remove: (name) => { this.className = list().filter((n) => n !== name).join(' '); },
      toggle: (name, on) => (on ? this.classList.add(name) : this.classList.remove(name)),
      contains: (name) => list().includes(name),
    };
  },
  get style() { return (this._style ||= { setProperty(name, value) { this[name] = value; } }); },
  get offsetWidth() { return 120; },
  get offsetHeight() { return 40; },
  getBoundingClientRect() { return this.box || { top: 0, bottom: 0, left: 0, right: 0 }; },
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); },
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); },
  dispatchEvent(event) {
    for (let at = this; at; at = at.parentElement) {
      // A real CustomEvent's target can't be set: the listener gets a copy with it.
      for (const fn of at.listeners[event.type] || []) fn({ ...event, type: event.type, target: this, currentTarget: at });
      if (!event.bubbles) break;
    }
    return true;
  },
}));
const append = FakeElement.prototype.append;
FakeElement.prototype.append = function (...nodes) {
  append.apply(this, nodes);
  for (const node of nodes) if (node && typeof node === 'object') node.parentElement = this;
};
FakeElement.prototype.remove = function () {
  if (!this.parentElement) return;
  this.parentElement.childNodes = this.parentElement.childNodes.filter((node) => node !== this);
  this.parentElement = null;
};
// Putting a node beside another, as the gap between two rows is put.
function insertAt(parent, node, index) {
  node.remove?.();
  parent.childNodes.splice(index, 0, node);
  node.parentElement = parent;
}
FakeElement.prototype.before = function (node) {
  insertAt(this.parentElement, node, this.parentElement.childNodes.indexOf(this));
};
FakeElement.prototype.after = function (node) {
  node.remove?.();
  insertAt(this.parentElement, node, this.parentElement.childNodes.indexOf(this) + 1);
};
const siblings = (node) => node.parentElement?.childNodes.filter((n) => n.nodeType === 1) || [];
Object.defineProperties(FakeElement.prototype, {
  previousElementSibling: { get() { const all = siblings(this); return all[all.indexOf(this) - 1] || null; } },
  nextElementSibling: { get() { const all = siblings(this); return all[all.indexOf(this) + 1] || null; } },
  lastElementChild: { get() { return this.children.at(-1) || null; } },
});
FakeElement.prototype.querySelectorAll = function (selector) {
  return this.all().filter((node) => matches(node, selector));
};

class Target {
  constructor() { this.listeners = {}; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatchEvent(event) { for (const fn of [...(this.listeners[event.type] || [])]) fn(event); return true; }
}
const win = new Target();
Object.assign(win, { innerWidth: 1000, innerHeight: 800 });
globalThis.window = win;
globalThis.getComputedStyle = (node) => ({ overflowY: node.scrollable ? 'auto' : 'visible' });
const docEvents = new Target();
document.addEventListener = docEvents.addEventListener.bind(docEvents);
document.removeEventListener = docEvents.removeEventListener.bind(docEvents);
document.dispatchEvent = docEvents.dispatchEvent.bind(docEvents);

const { el } = await import('../web/dom.js');
const { makeDraggable, edgeSpeed, zoneAt, redrawInPlace } = await import('../web/drag.js');

/** A list of two notes and a sidebar of three notebooks, each with its box on the screen. */
function page() {
  document.body.childNodes = [];
  document.documentElement.attributes.clear();
  const at = (node, top) => { node.box = { top, bottom: top + 40, left: 300, right: 700 }; return node; };
  const notes = el('div', {});
  notes.box = { top: 0, bottom: 800, left: 300, right: 700 };
  notes.scrollable = true;
  notes.scrollTop = 0;
  notes.scrollHeight = 2000;
  notes.clientHeight = 800;
  const first = at(el('button', { 'data-note': '1', 'data-notebook': 'inbox' }, el('span', { text: 'Shopping' })), 100);
  const second = at(el('div', { 'data-note': '2', 'data-notebook': 'inbox' }, el('a', { href: '#x', text: 'link' })), 200);
  notes.append(first, second);
  const side = el('nav', {});
  const place = (id, top, role = 'edit') => {
    const node = el('button', { 'data-drop': '', 'data-notebook': id, 'data-role': role, text: id });
    node.box = { top, bottom: top + 36, left: 0, right: 260 };
    return node;
  };
  const inbox = place('inbox', 100);
  const work = place('work', 140);
  const shared = place('shared', 180, 'view');
  const menuButton = el('button', { 'data-drag-spring': '' });
  menuButton.box = { top: 0, bottom: 40, left: 0, right: 40 };
  side.append(inbox, work, shared, menuButton);
  document.body.append(notes, side);
  const all = [first, second, inbox, work, shared, menuButton];
  document.elementFromPoint = (x, y) => {
    const hit = all.find((node) => node.parentElement && y >= node.box.top && y < node.box.bottom && x >= node.box.left && x < node.box.right);
    return hit?.firstChild?.nodeType === 1 ? hit.firstChild : hit || null;
  };
  const dropped = [];
  const drag = makeDraggable(notes, {
    items: '[data-note]',
    label: (row) => `note ${row.getAttribute('data-note')}`,
    check: (row, target) => {
      if (target.getAttribute('data-role') === 'view') return { ok: false, text: 'only to read' };
      if (target.getAttribute('data-notebook') === row.getAttribute('data-notebook')) return { ok: false, text: 'already there' };
      return { ok: true, text: `to ${target.getAttribute('data-notebook')}` };
    },
    onDrop: (row, target) => dropped.push([row.getAttribute('data-note'), target.getAttribute('data-notebook')]),
  });
  return { notes, first, second, inbox, work, shared, menuButton, dropped, drag };
}

const pointer = (node, type, x, y, extra = {}) => {
  const event = { type, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, pointerType: 'mouse', preventDefault() { this.prevented = true; }, ...extra };
  if (type === 'pointerdown') node.dispatchEvent({ ...event, bubbles: true });
  else win.dispatchEvent(event);
  return event;
};
const ghost = () => document.body.children.find((node) => node.className.includes('kit-drag-ghost'));

/* --------------------------------- the tests --------------------------------- */

test('the scrolling strip: towards the nearer edge, faster closer, nothing in the middle', () => {
  assert.equal(edgeSpeed(0, 800, 400), 0);
  assert.ok(edgeSpeed(0, 800, 5) < edgeSpeed(0, 800, 40) && edgeSpeed(0, 800, 40) < 0);
  assert.ok(edgeSpeed(0, 800, 795) > edgeSpeed(0, 800, 760) && edgeSpeed(0, 800, 760) > 0);
  assert.equal(edgeSpeed(0, 800, -10), 0, 'outside the box');
  // A box shorter than both strips: below its middle it goes down, not up for being first.
  assert.ok(edgeSpeed(0, 80, 60) > 0);
});

test('a mouse picks up after a few pixels, says where it falls, and drops only where it may', () => {
  const p = page();
  pointer(p.first.firstChild, 'pointerdown', 400, 110);
  pointer(p.first, 'pointermove', 402, 111);
  assert.equal(ghost(), undefined, 'a wobble is still a click');
  const move = pointer(p.first, 'pointermove', 380, 130);
  assert.ok(move.prevented);
  assert.ok(ghost(), 'the card follows the pointer');
  assert.match(ghost().textContent, /note 1/);
  assert.ok(p.first.className.includes('kit-drag-source'));
  assert.ok(document.documentElement.hasAttribute('data-kit-dragging'));

  pointer(p.first, 'pointermove', 100, 190);
  assert.equal(p.shared.getAttribute('data-drop-state'), 'no');
  assert.match(ghost().textContent, /only to read/);
  assert.ok(ghost().className.includes('kit-drag-ghost--no'));
  pointer(p.first, 'pointermove', 100, 110);
  assert.equal(p.shared.getAttribute('data-drop-state'), null, 'the place it left is lit no more');
  assert.match(ghost().textContent, /already there/);
  pointer(p.first, 'pointermove', 100, 150);
  assert.equal(p.work.getAttribute('data-drop-state'), 'ok');
  assert.match(ghost().textContent, /to work/);

  pointer(p.first, 'pointerup', 100, 150);
  assert.deepEqual(p.dropped, [['1', 'work']]);
  assert.equal(ghost(), undefined);
  assert.equal(p.work.getAttribute('data-drop-state'), null);
  assert.ok(!p.first.className.includes('kit-drag-source'));
  assert.ok(!document.documentElement.hasAttribute('data-kit-dragging'));
  // The release must not also open the note.
  const click = { type: 'click', stopPropagation() { this.stopped = true; }, preventDefault() {} };
  win.dispatchEvent(click);
  assert.ok(click.stopped);
  p.drag.destroy();
});

test('let go over nothing, on a refusal or with Escape, and nothing moves', () => {
  const p = page();
  pointer(p.first, 'pointerdown', 400, 110);
  pointer(p.first, 'pointermove', 100, 190);
  pointer(p.first, 'pointerup', 100, 190);
  pointer(p.first, 'pointerdown', 400, 110);
  pointer(p.first, 'pointermove', 100, 500);
  pointer(p.first, 'pointerup', 100, 500);
  pointer(p.first, 'pointerdown', 400, 110);
  pointer(p.first, 'pointermove', 100, 150);
  win.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  assert.equal(ghost(), undefined, 'Escape puts it back at once');
  pointer(p.first, 'pointerup', 100, 150);
  assert.deepEqual(p.dropped, []);
  p.drag.destroy();
});

test('a control inside a row keeps its job; the row itself, a button, still picks up', () => {
  const p = page();
  pointer(p.second.firstChild, 'pointerdown', 400, 210);
  pointer(p.second, 'pointermove', 100, 150);
  assert.equal(ghost(), undefined, 'the link in the row');
  pointer(p.second, 'pointerup', 100, 150);
  pointer(p.first, 'pointerdown', 400, 110);
  pointer(p.first, 'pointermove', 100, 150);
  assert.ok(ghost(), 'the row that is a button');
  pointer(p.first, 'pointerup', 100, 150);
  p.drag.destroy();
});

test('a finger picks up only after holding still; moving first is scrolling', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const p = page();
    const touch = { pointerType: 'touch' };
    pointer(p.first, 'pointerdown', 400, 110, touch);
    pointer(p.first, 'pointermove', 400, 140, touch);
    mock.timers.tick(500);
    assert.equal(ghost(), undefined, 'a scroll of the list');

    pointer(p.first, 'pointerdown', 400, 110, touch);
    pointer(p.first, 'pointermove', 403, 112, touch);
    mock.timers.tick(400);
    assert.ok(ghost(), 'held: picked up');
    // A finger that has picked something up doesn't scroll the page.
    const touchmove = { type: 'touchmove', preventDefault() { this.prevented = true; } };
    docEvents.dispatchEvent(touchmove);
    assert.ok(touchmove.prevented);
    pointer(p.first, 'pointermove', 100, 150, touch);
    pointer(p.first, 'pointerup', 100, 150, touch);
    assert.deepEqual(p.dropped, [['1', 'work']]);
    p.drag.destroy();
  } finally {
    mock.timers.reset();
  }
});

test('held over ☰ it asks for the drawer, and the end of the drag is announced', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const p = page();
    const springs = [];
    p.menuButton.addEventListener('kit-drag-spring', () => springs.push('open'));
    const ends = [];
    const onEnd = () => ends.push('end');
    document.addEventListener('kit-dragend', onEnd);
    pointer(p.first, 'pointerdown', 400, 110);
    pointer(p.first, 'pointermove', 20, 20);
    mock.timers.tick(300);
    pointer(p.first, 'pointermove', 22, 21);
    mock.timers.tick(300);
    assert.deepEqual(springs, ['open']);
    // The drawer slides in under a finger that stays still: once it is there, its notebook counts.
    p.work.box = { top: 0, bottom: 40, left: 0, right: 260 };
    mock.timers.tick(350);
    assert.equal(p.work.getAttribute('data-drop-state'), 'ok');
    pointer(p.first, 'pointerup', 22, 21);
    assert.deepEqual(p.dropped, [['1', 'work']]);
    assert.deepEqual(ends, ['end']);
    document.removeEventListener('kit-dragend', onEnd);
    p.drag.destroy();
  } finally {
    mock.timers.reset();
  }
});

test('the start says what was picked up and where it may go, and looks again once a drawer is in', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const p = page();
    const starts = [];
    const onStart = (ev) => starts.push(ev.detail);
    document.addEventListener('kit-dragstart', onStart);
    p.work.box = { top: -100, bottom: -60, left: 0, right: 260 };   // in a closed drawer, off the screen
    pointer(p.first, 'pointerdown', 400, 110);
    pointer(p.first, 'pointermove', 100, 160);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].item, p.first);
    assert.equal(starts[0].targets, '[data-drop]');
    // The frame opens its drawer: Work slides in under the pointer, which doesn't move.
    assert.equal(p.work.getAttribute('data-drop-state'), null);
    p.work.box = { top: 150, bottom: 170, left: 0, right: 260 };
    mock.timers.tick(350);
    assert.equal(p.work.getAttribute('data-drop-state'), 'ok');
    pointer(p.first, 'pointerup', 100, 160);
    assert.deepEqual(p.dropped, [['1', 'work']]);
    document.removeEventListener('kit-dragstart', onStart);
    p.drag.destroy();
  } finally {
    mock.timers.reset();
  }
});

test('near the bottom of the list it scrolls by itself', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const p = page();
    pointer(p.first, 'pointerdown', 400, 110);
    pointer(p.first, 'pointermove', 400, 120);
    p.first.box = { top: 760, bottom: 800, left: 300, right: 700 };   // a row under the pointer down there
    pointer(p.first, 'pointermove', 400, 790);
    mock.timers.tick(160);
    assert.ok(p.notes.scrollTop > 0);
    pointer(p.first, 'pointerup', 400, 790);
    const stopped = p.notes.scrollTop;
    mock.timers.tick(160);
    assert.equal(p.notes.scrollTop, stopped, 'and stops when the drag does');
    p.drag.destroy();
  } finally {
    mock.timers.reset();
  }
});

test('canDrag leaves a row where it is, and destroy lets go of the list', () => {
  const p = page();
  p.drag.destroy();
  pointer(p.first, 'pointerdown', 400, 110);
  pointer(p.first, 'pointermove', 100, 150);
  assert.equal(ghost(), undefined);
  assert.ok(!p.notes.className.includes('kit-draggable'));

  const onlyTwo = makeDraggable(p.notes, {
    items: '[data-note]', canDrag: (row) => row.getAttribute('data-note') === '2',
    label: () => 'x', check: () => ({ ok: true, text: 'y' }), onDrop: () => {},
  });
  pointer(p.first, 'pointerdown', 400, 110);
  pointer(p.first, 'pointermove', 100, 150);
  assert.equal(ghost(), undefined, 'a note only to read stays');
  pointer(p.first, 'pointerup', 100, 150);
  onlyTwo.destroy();
});

/* ------------------------------ in order, by zones ------------------------------ */

test('the zones of a place by the height of the pointer', () => {
  assert.equal(zoneAt('whole', 0.1), 'whole');
  assert.equal(zoneAt(undefined, 0.9), 'whole');
  assert.equal(zoneAt('between', 0.49), 'before');
  assert.equal(zoneAt('between', 0.5), 'after');
  assert.equal(zoneAt('around', 0.2), 'before');
  assert.equal(zoneAt('around', 0.5), 'inside');
  assert.equal(zoneAt('around', 0.8), 'after');
});

/** A list of three rows that are at once what is picked up and where it goes. */
function rows(options = {}) {
  document.body.childNodes = [];
  document.documentElement.attributes.clear();
  const list = el('ul', {});
  list.box = { top: 100, bottom: 220, left: 0, right: 400 };
  const row = (id, top) => {
    const node = el('li', { 'data-id': id, text: `task ${id}` });
    node.box = { top, bottom: top + 40, left: 0, right: 400 };
    return node;
  };
  const [a, b, c] = [row('a', 100), row('b', 140), row('c', 180)];
  list.append(a, b, c);
  document.body.append(list);
  const p = { list, a, b, c, dropped: [], asked: [], under: null };
  // The boxes don't move when the gap opens; `p.under` plays what the pointer finds instead.
  document.elementFromPoint = (x, y) => p.under
    || [a, b, c].find((node) => node.parentElement && y >= node.box.top && y < node.box.bottom && x >= 0 && x < 400)
    || null;
  p.drag = makeDraggable(list, {
    items: '[data-id]',
    targets: '[data-id]',
    zones: 'between',
    label: (node) => node.getAttribute('data-id'),
    check: (node, place, { zone }) => {
      p.asked.push([place === list ? 'list' : place.getAttribute('data-id'), zone]);
      if (place.getAttribute?.('data-id') === 'c' && zone === 'after' && options.lastIsShut) return { ok: false, text: 'not there' };
      return { ok: true, text: `${zone} ${place === list ? 'all' : place.getAttribute('data-id')}`, detail: options.detail, indent: options.indent };
    },
    onDrop: (node, place, { zone }) => p.dropped.push([node.getAttribute('data-id'), place === list ? 'list' : place.getAttribute('data-id'), zone]),
    ...options.drag,
  });
  return p;
}
// The open gap; one closing is on its way out (kit.css animates it) and counts for nothing.
const closing = (node) => node.className.includes('kit-drop-gap--closing');
const gapIn = (list) => list.children.find((node) => node.className.includes('kit-drop-gap') && !closing(node));
const order = (list) => list.children.filter((node) => !closing(node)).map((node) => node.getAttribute('data-id') || 'gap');

test('between two rows a gap the size of the row opens where it would land', () => {
  const p = rows({ detail: 'at the top level' });
  pointer(p.a, 'pointerdown', 200, 110);
  pointer(p.a, 'pointermove', 200, 185);
  assert.deepEqual(order(p.list), ['a', 'b', 'gap', 'c'], 'in front of c');
  const gap = gapIn(p.list);
  assert.equal(gap.tagName, 'LI', 'a list takes only items');
  assert.equal(gap.style.height, '40px');
  assert.equal(gap.getAttribute('aria-hidden'), 'true');
  assert.equal(p.c.getAttribute('data-drop-state'), null, 'the gap says where, the row does not light up');
  assert.match(ghost().textContent, /before c/);
  assert.match(ghost().textContent, /at the top level/, 'the second line');

  pointer(p.a, 'pointermove', 200, 205);
  assert.deepEqual(order(p.list), ['a', 'b', 'c', 'gap'], 'behind c');
  // The rows made room: over the gap, or over nothing between them, it still goes there.
  p.under = gap;
  pointer(p.a, 'pointermove', 200, 215);
  p.under = null;
  pointer(p.a, 'pointermove', 200, 110);
  assert.deepEqual(order(p.list), ['a', 'b', 'c', 'gap'], 'over its own row, among the rest: it stays');
  assert.deepEqual(p.asked, [['c', 'before'], ['c', 'after']], 'each zone asked once, never its own row');

  pointer(p.a, 'pointerup', 200, 110);
  assert.deepEqual(p.dropped, [['a', 'c', 'after']]);
  assert.equal(gapIn(p.list), undefined, 'the gap goes with the drag');
  p.drag.destroy();
});

test('where it may not land no gap opens, and leaving the list closes it', () => {
  const p = rows({ lastIsShut: true });
  pointer(p.a, 'pointerdown', 200, 110);
  pointer(p.a, 'pointermove', 200, 205);
  assert.equal(gapIn(p.list), undefined);
  assert.ok(ghost().className.includes('kit-drag-ghost--no'));
  assert.match(ghost().textContent, /not there/);
  pointer(p.a, 'pointermove', 200, 150);
  assert.deepEqual(order(p.list), ['a', 'gap', 'b', 'c']);
  pointer(p.a, 'pointermove', 600, 500);
  assert.equal(gapIn(p.list), undefined, 'out of the list');
  pointer(p.a, 'pointerup', 600, 500);
  assert.deepEqual(p.dropped, []);
  p.drag.destroy();
});

test('around: inside a row lights it up, its edges open the gap with the indent asked for', () => {
  const p = rows({ indent: 14.4, drag: { zones: (place) => (place.getAttribute('data-id') === 'c' ? 'between' : 'around') } });
  pointer(p.c, 'pointerdown', 200, 190);
  pointer(p.c, 'pointermove', 200, 120);
  assert.equal(p.a.getAttribute('data-drop-state'), 'ok');
  assert.equal(gapIn(p.list), undefined);
  pointer(p.c, 'pointermove', 200, 136);
  assert.equal(p.a.getAttribute('data-drop-state'), null);
  assert.deepEqual(order(p.list), ['a', 'gap', 'b', 'c']);
  assert.equal(gapIn(p.list).style.marginInlineStart, '14px');
  pointer(p.c, 'pointermove', 200, 120);
  pointer(p.c, 'pointerup', 200, 120);
  assert.deepEqual(p.dropped, [['c', 'a', 'inside']]);
  p.drag.destroy();
});

test('with end, below the last row is the end of the list', () => {
  const p = rows({ drag: { end: true } });
  pointer(p.b, 'pointerdown', 200, 150);
  pointer(p.b, 'pointermove', 200, 400);
  assert.deepEqual(order(p.list), ['a', 'b', 'c', 'gap']);
  assert.match(ghost().textContent, /end all/);
  pointer(p.b, 'pointerup', 200, 400);
  assert.deepEqual(p.dropped, [['b', 'list', 'end']]);
  // To the side, it is not the end of this list.
  pointer(p.b, 'pointerdown', 200, 150);
  pointer(p.b, 'pointermove', 600, 400);
  assert.equal(gapIn(p.list), undefined);
  pointer(p.b, 'pointerup', 600, 400);
  assert.equal(p.dropped.length, 1);
  p.drag.destroy();
});

test('a thin gap moves nothing: no height of its own', () => {
  const p = rows({ drag: { gap: 'thin' } });
  pointer(p.a, 'pointerdown', 200, 110);
  pointer(p.a, 'pointermove', 200, 150);
  const gap = gapIn(p.list);
  assert.ok(gap.className.includes('kit-drop-gap--thin'));
  assert.equal(gap.style.height, undefined);
  win.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  assert.equal(gapIn(p.list), undefined, 'Escape closes it');
  pointer(p.a, 'pointerup', 200, 150);
  p.drag.destroy();
});

/* ------------------------------ one drag for all ------------------------------ */

test('with a grip beside the held row, a finger picks up at once there and after holding elsewhere', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const p = rows({ drag: { grip: '[data-grip]' } });
    const grip = el('span', { 'data-grip': '' });
    p.a.append(grip);
    const touch = { pointerType: 'touch' };
    pointer(grip, 'pointerdown', 380, 110, touch);
    pointer(p.a, 'pointermove', 380, 150, touch);
    assert.ok(ghost(), 'the grip: at once');
    pointer(p.a, 'pointerup', 380, 150, touch);
    pointer(p.a, 'pointerdown', 200, 110, touch);
    pointer(p.a, 'pointermove', 200, 150, touch);
    assert.equal(ghost(), undefined, 'the rest of the row, moved at once: a scroll');
    pointer(p.a, 'pointerdown', 200, 110, touch);
    mock.timers.tick(400);
    assert.ok(ghost(), 'held: picked up');
    pointer(p.a, 'pointerup', 200, 110, touch);
    p.drag.destroy();
  } finally {
    mock.timers.reset();
  }
});

test('the start says what the drawer should do, and the drop where it landed', () => {
  const p = rows({ drag: { drawer: (node) => (node.getAttribute('data-id') === 'a' ? 'tabs' : 'open') } });
  const starts = [];
  const onStart = (ev) => starts.push(ev.detail.drawer);
  document.addEventListener('kit-dragstart', onStart);
  const dropped = [];
  p.drag.destroy();
  const drag = makeDraggable(p.list, {
    items: '[data-id]', targets: '[data-id]', zones: 'between',
    drawer: (node) => (node.getAttribute('data-id') === 'a' ? 'tabs' : 'open'),
    label: () => 'x', check: () => ({ ok: true, text: 'y' }),
    onDrop: (node, place, where) => dropped.push(where),
  });
  pointer(p.a, 'pointerdown', 200, 110);
  pointer(p.a, 'pointermove', 200, 185);
  const gap = gapIn(p.list);
  gap.box = { top: 180, bottom: 220, left: 0, right: 400 };
  pointer(p.a, 'pointerup', 200, 186);
  assert.deepEqual(dropped, [{ zone: 'before', x: 200, y: 186, top: 180 }]);
  pointer(p.b, 'pointerdown', 200, 150);
  pointer(p.b, 'pointermove', 200, 200);
  pointer(p.b, 'pointerup', 200, 200);
  assert.deepEqual(starts, ['tabs', 'open']);
  document.removeEventListener('kit-dragstart', onStart);
  drag.destroy();
});

test('held over a place that opens something, it is marked armed until the pointer leaves', () => {
  const p = page();
  pointer(p.first, 'pointerdown', 400, 110);
  pointer(p.first, 'pointermove', 20, 20);
  assert.ok(p.menuButton.hasAttribute('data-spring-armed'));
  pointer(p.first, 'pointermove', 100, 150);
  assert.ok(!p.menuButton.hasAttribute('data-spring-armed'));
  pointer(p.first, 'pointermove', 20, 20);
  pointer(p.first, 'pointerup', 20, 20);
  assert.ok(!p.menuButton.hasAttribute('data-spring-armed'), 'nor after the drag');
  p.drag.destroy();
});

test('a place marked at-once opens what is behind it as soon as it is reached', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const p = page();
    p.menuButton.setAttribute('data-drag-spring', 'at-once');
    const springs = [];
    p.menuButton.addEventListener('kit-drag-spring', () => springs.push('open'));
    pointer(p.first, 'pointerdown', 400, 110);
    pointer(p.first, 'pointermove', 20, 20);
    mock.timers.tick(1);
    assert.deepEqual(springs, ['open'], 'no waiting');
    pointer(p.first, 'pointerup', 20, 20);
    p.drag.destroy();
  } finally {
    mock.timers.reset();
  }
});

test('the card is placed by its size once it says where it falls, so a longer text never stands out of the screen', () => {
  const width = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'offsetWidth');
  // A card as wide as what it says, up to 300.
  Object.defineProperty(FakeElement.prototype, 'offsetWidth', {
    configurable: true,
    get() { return this.className.includes('kit-drag-ghost') ? Math.min(300, 20 + 6 * this.textContent.length) : 120; },
  });
  try {
    const p = rows();
    p.drag.destroy();
    const drag = makeDraggable(p.list, {
      items: '[data-id]', targets: '[data-id]', zones: 'between', label: () => 'x',
      check: (node, place) => ({ ok: true, text: place.getAttribute('data-id') === 'c' ? 'after a task whose title goes on and on and on and on and on' : 'after b' }),
      onDrop: () => {},
    });
    win.innerWidth = 375;
    pointer(p.a, 'pointerdown', 360, 110, { pointerType: 'mouse' });
    pointer(p.a, 'pointermove', 360, 150);   // over b: a short text
    pointer(p.a, 'pointermove', 360, 185);   // over c, in one move: a long one
    const [x] = /translate\((-?\d+)px/.exec(ghost().style.transform).slice(1).map(Number);
    assert.equal(x, 375 - 300 - 4, 'against the right edge, by the width it has with its words');
    pointer(p.a, 'pointerup', 360, 185);
    drag.destroy();
  } finally {
    win.innerWidth = 1000;
    Object.defineProperty(FakeElement.prototype, 'offsetWidth', width);
  }
});

test('the gap it leaves closes as the new one opens, and is gone soon after; the same slot keeps its gap', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const p = rows();
    pointer(p.a, 'pointerdown', 200, 110);
    pointer(p.a, 'pointermove', 200, 150);           // in front of b
    const first = gapIn(p.list);
    pointer(p.a, 'pointermove', 200, 130);           // behind a, its own row: nothing, it stays
    assert.equal(gapIn(p.list), first);
    pointer(p.a, 'pointermove', 200, 175);           // behind b
    assert.notEqual(gapIn(p.list), first, 'a new gap where it goes');
    assert.ok(first.className.includes('kit-drop-gap--closing') && first.parentElement, 'the old one closing, still there');
    mock.timers.tick(300);
    assert.equal(first.parentElement, null, 'and gone');
    const second = gapIn(p.list);
    pointer(p.a, 'pointermove', 200, 185);           // in front of c: the same slot as behind b
    assert.equal(gapIn(p.list), second, 'the same gap, not one closing and another opening');
    pointer(p.a, 'pointerup', 200, 185);
    assert.equal(p.list.children.filter((n) => n.className.includes('kit-drop-gap')).length, 0, 'none left after the drop');
    p.drag.destroy();
  } finally {
    mock.timers.reset();
  }
});

test('a gap takes back the space its list puts between rows, so the rows do not hop as it opens and closes', () => {
  const computed = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (node) => ({ ...computed(node), rowGap: node.tagName === 'UL' ? '6px' : 'normal' });
  try {
    const p = rows();
    pointer(p.a, 'pointerdown', 200, 110);
    pointer(p.a, 'pointermove', 200, 150);
    assert.equal(gapIn(p.list).style['--kit-gap-space'], '6px');
    pointer(p.a, 'pointerup', 200, 150);
    p.drag.destroy();
  } finally {
    globalThis.getComputedStyle = computed;
  }
});

test('held with a finger and let go where it was is a long press, not a move', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const p = page();
    p.drag.destroy();
    const held = [];
    const dropped = [];
    const drag = makeDraggable(p.notes, {
      items: '[data-note]', label: () => 'x', check: () => ({ ok: true, text: 'y' }),
      onDrop: (row, place) => dropped.push(place.getAttribute('data-notebook')),
      onHold: (row) => held.push(row.getAttribute('data-note')),
    });
    const touch = { pointerType: 'touch' };
    pointer(p.first, 'pointerdown', 400, 110, touch);
    mock.timers.tick(400);
    assert.ok(ghost(), 'picked up');
    pointer(p.first, 'pointermove', 403, 112, touch);       // a finger never stays quite still
    pointer(p.first, 'pointerup', 403, 112, touch);
    assert.deepEqual(held, ['1'], 'let go there: its menu');
    // Held, then carried somewhere: a move, as before.
    pointer(p.first, 'pointerdown', 400, 110, touch);
    mock.timers.tick(400);
    pointer(p.first, 'pointermove', 100, 150, touch);
    pointer(p.first, 'pointerup', 100, 150, touch);
    assert.deepEqual(dropped, ['work']);
    assert.deepEqual(held, ['1']);
    // Carried away and brought back is still a move that went nowhere, not a long press.
    pointer(p.first, 'pointerdown', 400, 110, touch);
    mock.timers.tick(400);
    pointer(p.first, 'pointermove', 400, 200, touch);
    pointer(p.first, 'pointermove', 400, 110, touch);
    pointer(p.first, 'pointerup', 400, 110, touch);
    assert.deepEqual(held, ['1']);
    drag.destroy();
  } finally {
    mock.timers.reset();
  }
});

/* ------------------------------ drawing again in place ------------------------------ */

/** A box emptied goes back to the top, as a browser's does; filled again, it stays there. */
function emptyAndFill(box, rows) {
  box.childNodes = [];
  box.scrollTop = 0;
  for (let i = 0; i < rows; i++) box.append(el('div', { 'data-row': String(i) }));
}

test('drawn again whole, a box keeps how far it was scrolled', () => {
  const p = page();
  p.notes.scrollTop = 640;
  const drawn = redrawInPlace(p.notes, () => emptyAndFill(p.notes, 30));
  assert.equal(drawn, true);
  assert.equal(p.notes.children.length, 30);
  assert.equal(p.notes.scrollTop, 640);
  p.drag.destroy();
});

test('a part that does not scroll keeps the scroll of the box above it', () => {
  const p = page();
  const part = el('ul', {});
  p.notes.append(part);
  p.notes.scrollTop = 300;
  redrawInPlace(part, () => { emptyAndFill(part, 5); p.notes.scrollTop = 0; });
  assert.equal(p.notes.scrollTop, 300);
  // Nothing scrolls: it is only drawn.
  const loose = el('div', {});
  let times = 0;
  assert.equal(redrawInPlace(loose, () => { times += 1; }), true);
  assert.equal(times, 1);
  p.drag.destroy();
});

test('while something is carried it waits, and draws once when it is let go', () => {
  const p = page();
  p.notes.scrollTop = 500;
  const draws = [];
  pointer(p.first, 'pointerdown', 400, 110);
  pointer(p.first, 'pointermove', 400, 150);
  assert.ok(document.documentElement.hasAttribute('data-kit-dragging'));
  // A live notice and another: the rows under the pointer stay.
  assert.equal(redrawInPlace(p.notes, () => draws.push('first')), false);
  assert.equal(redrawInPlace(p.notes, () => { draws.push('second'); emptyAndFill(p.notes, 2); }), false);
  assert.deepEqual(draws, []);
  assert.ok(p.notes.children.includes(p.first));
  pointer(p.first, 'pointermove', 100, 150);
  pointer(p.first, 'pointerup', 100, 150);
  assert.deepEqual(draws, ['second'], 'once, with the last it was asked');
  assert.equal(p.notes.scrollTop, 500);
  assert.deepEqual(p.dropped, [['1', 'work']]);
  // The next drag starts with nothing waiting.
  pointer(p.second, 'pointerdown', 400, 210);
  pointer(p.second, 'pointermove', 400, 250);
  pointer(p.second, 'pointerup', 400, 250);
  assert.deepEqual(draws, ['second']);
  // Once the drag is over it draws at once again.
  assert.equal(redrawInPlace(p.notes, () => draws.push('after')), true);
  assert.deepEqual(draws, ['second', 'after']);
  p.drag.destroy();
});

test('boxes waiting for the same drag each draw once', () => {
  const p = page();
  const side = document.body.children[1];
  const draws = [];
  pointer(p.first, 'pointerdown', 400, 110);
  pointer(p.first, 'pointermove', 400, 150);
  redrawInPlace(p.notes, () => draws.push('list'));
  redrawInPlace(side, () => draws.push('sidebar'));
  redrawInPlace(side, () => draws.push('sidebar again'));
  pointer(p.first, 'pointerup', 400, 150);
  assert.deepEqual(draws.sort(), ['list', 'sidebar again']);
  p.drag.destroy();
});

/* ------------------------ places shared by the whole page ------------------------ */

// In Cronum Work's shell each module loads the kit from its own address, so the page has a copy
// of drag.js per module. Here two, as the shell's page has them: at /notes/suite/ and
// /next/suite/ of a made-up site, read from web/, each with its own dom.js, mount.js and BASE.
const SITE = 'https://work.test/';
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(SITE)) return { url: specifier, shortCircuit: true };
    if (context.parentURL?.startsWith(SITE)) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith(SITE)) return next(url, context);
    const file = new URL(url).pathname.replace(/^\/[a-z-]+\/suite\//, '');
    return { format: 'module', source: fs.readFileSync(path.join(WEB, file), 'utf8'), shortCircuit: true };
  },
});
const notesKit = await import(`${SITE}notes/suite/drag.js`);
const nextKit = await import(`${SITE}next/suite/drag.js`);
const WORK = Symbol.for('cronum.work');

/** Two windows: Notes' list (its own drag, with a notebook of its own) and Next's steps. */
function twoWindows() {
  document.body.childNodes = [];
  document.documentElement.attributes.clear();
  delete document[WORK];
  const box = (node, top, left) => { node.box = { top, bottom: top + 40, left, right: left + 300 }; return node; };
  const list = el('div', {});
  list.box = { top: 0, bottom: 800, left: 0, right: 300 };
  const note = box(el('div', { 'data-ref': 'notes:note:6', 'data-title': 'Shopping' }, el('span', { text: 'Shopping' })), 100, 0);
  const sibling = box(el('div', { 'data-ref': 'notes:note:7', 'data-title': 'Ideas' }), 200, 0);
  const notebook = box(el('div', { 'data-drop': '', 'data-ref': 'notes:notebook:2' }), 300, 0);
  list.append(note, sibling, notebook);
  const steps = el('div', {});
  const step = box(el('div', { 'data-ref': 'next:step:12', 'data-title': 'Ship it' }, el('span', { text: 'Ship it' })), 100, 500);
  const other = box(el('div', { 'data-ref': 'next:step:13', 'data-title': 'Test it' }), 200, 500);
  steps.append(step, other);
  document.body.append(list, steps);
  const all = [note, sibling, notebook, step, other];
  document.elementFromPoint = (x, y) => {
    const hit = all.find((node) => node.parentElement && y >= node.box.top && y < node.box.bottom && x >= node.box.left && x < node.box.right);
    return hit?.firstChild?.nodeType === 1 ? hit.firstChild : hit || null;
  };
  const own = [];
  const drag = notesKit.makeDraggable(list, {
    items: '[data-ref]',
    label: (row) => row.getAttribute('data-title'),
    check: () => ({ ok: true, text: 'into the notebook' }),
    onDrop: (row, place) => own.push([row.getAttribute('data-ref'), place.getAttribute('data-ref')]),
  });
  return { list, note, sibling, notebook, step, other, own, drag };
}

/** What Work's shell registers: another module's row links, its own module's has nothing to say. */
function linkDrop(asked, linked) {
  const moduleOf = (node) => node.getAttribute('data-ref').split(':')[0];
  return {
    selector: '[data-ref]',
    accepts(item, place) {
      asked.push(place.getAttribute('data-ref'));
      if (moduleOf(item) === moduleOf(place)) return null;
      if (place.getAttribute('data-ref') === 'next:step:13') return { ok: false, text: 'already linked' };
      return { ok: true, text: `link with ${place.getAttribute('data-title')}` };
    },
    onDrop: (item, place, info) => linked.push([item.getAttribute('data-ref'), place.getAttribute('data-ref'), info.zone]),
  };
}

test('a place shared by one copy of the kit takes what another copy carries, and says so on the way', () => {
  assert.notEqual(notesKit.makeDraggable, nextKit.makeDraggable, 'two copies, as in the shell');
  const p = twoWindows();
  const asked = [];
  const linked = [];
  const off = nextKit.registerDrop(linkDrop(asked, linked));
  pointer(p.note.firstChild, 'pointerdown', 100, 110);
  pointer(p.note, 'pointermove', 600, 120);
  assert.match(ghost().textContent, /link with Ship it/, 'the ghost says what letting go does');
  assert.equal(p.step.getAttribute('data-drop-state'), 'ok');
  pointer(p.note, 'pointermove', 600, 210);
  assert.equal(p.step.getAttribute('data-drop-state'), null);
  assert.equal(p.other.getAttribute('data-drop-state'), 'no');
  assert.match(ghost().textContent, /already linked/);
  assert.ok(ghost().className.includes('kit-drag-ghost--no'));
  // A row of its own module: the shared place has nothing to say, and it is no place.
  pointer(p.note, 'pointermove', 100, 210);
  assert.equal(p.sibling.getAttribute('data-drop-state'), null);
  assert.doesNotMatch(ghost().textContent, /link with|already/);
  pointer(p.note, 'pointermove', 600, 120);
  pointer(p.note, 'pointermove', 600, 125);
  assert.deepEqual(asked, ['next:step:12', 'next:step:13', 'notes:note:7'], 'each place asked once per drag');
  pointer(p.note, 'pointerup', 600, 125);
  assert.deepEqual(linked, [['notes:note:6', 'next:step:12', null]], 'what letting go does is the shared place’s');
  assert.deepEqual(p.own, [], 'not the list’s');
  assert.equal(ghost(), undefined);
  assert.equal(p.step.getAttribute('data-drop-state'), null);

  // Taken away, the place is nothing again.
  off();
  pointer(p.note, 'pointerdown', 100, 110);
  pointer(p.note, 'pointermove', 600, 120);
  assert.equal(p.step.getAttribute('data-drop-state'), null);
  pointer(p.note, 'pointerup', 600, 120);
  assert.equal(linked.length, 1);
  assert.equal(document[Symbol.for('cronum.drops')].size, 0);
  p.drag.destroy();
});

test('a place of its own wins over a shared one, and a shared drop that fails is no place', () => {
  const p = twoWindows();
  const asked = [];
  const linked = [];
  const offs = [
    nextKit.registerDrop({ selector: '[data-ref]', accepts() { throw new Error('broken'); }, onDrop: () => linked.push('broken') }),
    notesKit.registerDrop(linkDrop(asked, linked)),
  ];
  pointer(p.note, 'pointerdown', 100, 110);
  pointer(p.note, 'pointermove', 100, 310);
  assert.match(ghost().textContent, /into the notebook/, 'its own notebook: its own check');
  pointer(p.note, 'pointerup', 100, 310);
  assert.deepEqual(p.own, [['notes:note:6', 'notes:notebook:2']]);
  assert.deepEqual(asked, [], 'the shared places were not asked');
  // Over Next's step: the broken drop is passed over, the next one says what it does.
  pointer(p.note, 'pointerdown', 100, 110);
  pointer(p.note, 'pointermove', 600, 120);
  pointer(p.note, 'pointerup', 600, 120);
  assert.deepEqual(linked, [['notes:note:6', 'next:step:12', null]]);
  offs.forEach((off) => off());
  // A drop whose selector can't be read is no place either, and the drag goes on.
  const offBad = nextKit.registerDrop({ get selector() { throw new SyntaxError('bad selector'); }, accepts: () => ({ ok: true, text: 'x' }), onDrop: () => linked.push('bad') });
  pointer(p.note, 'pointerdown', 100, 110);
  pointer(p.note, 'pointermove', 600, 120);
  assert.equal(p.step.getAttribute('data-drop-state'), null);
  pointer(p.note, 'pointermove', 100, 310);
  assert.match(ghost().textContent, /into the notebook/);
  pointer(p.note, 'pointerup', 100, 310);
  assert.equal(linked.length, 1);
  offBad();
  p.drag.destroy();
});

test('a drag on a page where nothing is shared leaves the document as it was', () => {
  const DROPS = Symbol.for('cronum.drops');
  const saved = document[DROPS];
  delete document[DROPS];
  try {
    const q = page();
    pointer(q.first, 'pointerdown', 400, 110);
    pointer(q.first, 'pointermove', 380, 130);
    pointer(q.first, 'pointerup', 380, 130);
    q.drag.destroy();
    assert.equal(Object.getOwnPropertySymbols(document).includes(DROPS), false);
  } finally {
    if (saved) document[DROPS] = saved;
  }
});

test('in Work’s shell the ghost carries its module’s name and the page’s theme; anywhere else, nothing', () => {
  const p = twoWindows();
  pointer(p.note, 'pointerdown', 100, 110);
  pointer(p.note, 'pointermove', 100, 160);
  assert.equal(ghost().getAttribute('data-owner'), null, 'no shell: as it always was');
  pointer(p.note, 'pointerup', 100, 160);

  document[WORK] = { open: async () => true };
  document.documentElement.setAttribute('data-theme', 'dark');
  document.documentElement.setAttribute('lang', 'es');
  pointer(p.note, 'pointerdown', 100, 110);
  pointer(p.note, 'pointermove', 100, 160);
  assert.equal(ghost().getAttribute('data-owner'), 'notes');
  assert.equal(ghost().getAttribute('data-theme'), 'dark');
  assert.equal(ghost().getAttribute('lang'), 'es');
  pointer(p.note, 'pointerup', 100, 160);
  p.drag.destroy();

  // The kit of an app on its own (at the root) has no module to name, in the shell's page too.
  const q = page();
  document[WORK] = { open: async () => true };
  pointer(q.first, 'pointerdown', 400, 110);
  pointer(q.first, 'pointermove', 380, 130);
  assert.equal(ghost().getAttribute('data-owner'), null);
  pointer(q.first, 'pointerup', 380, 130);
  q.drag.destroy();
  delete document[WORK];
});
