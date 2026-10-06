/**
 * Drag and drop without a browser: the pointer is played by hand over a page
 * of fake elements with boxes, and what is under it is found by those boxes.
 *
 *   npm test
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
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
  get style() { return (this._style ||= {}); },
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
const { makeDraggable, edgeSpeed } = await import('../web/drag.js');

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
    mock.timers.tick(300);
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
    mock.timers.tick(300);
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
