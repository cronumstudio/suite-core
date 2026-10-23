/**
 * Cronum Work's windows (web/windows.js): the layout and its moves as pure functions, then the
 * windows on a desk of fake elements, the pointer and the keys played by hand, frames at once.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, FakeElement, FakeEventTarget } from './fake-dom.js';

const document = installFakeDom();

// What windows.js asks of an element beyond fake-dom's: a style with custom properties, a box,
// pointer capture and Web Animations (recorded).
const animations = [];
Object.defineProperties(FakeElement.prototype, {
  style: {
    configurable: true,
    get() {
      return (this._style ||= Object.defineProperties({}, {
        setProperty: { value(name, value) { this[name] = String(value); } },
        removeProperty: { value(name) { delete this[name]; } },
      }));
    },
    set(value) { this._style = value; },
  },
  getBoundingClientRect: {
    configurable: true,
    value() {
      const { left = 0, top = 0, width = 0, height = 0 } = this.box || {};
      return { left, top, width, height, right: left + width, bottom: top + height };
    },
  },
  setPointerCapture: { configurable: true, value() {} },
  animate: { configurable: true, value(frames, options) { animations.push({ node: this, frames, options }); } },
});

const {
  KEY, screenClass, fitColumns, normalizeLayout, modulesOf, where, applyColumns, fitLayout, narrowLayout,
  moveColumn, swapWindows, placement, slotAt, dropLayout, dropRect, moveByKey, shareAfter, rowShareAt,
  lruTouch, lruEvict, readLayout, writeLayout, createWindows,
} = await import('../web/windows.js');

const L = (...cols) => normalizeLayout({ cols: cols.map((wins) => ({ w: 1, wins: [].concat(wins) })) });

/* ----------------------------------- the model ----------------------------------- */

test('screen classes and how many columns of 320 px fit', () => {
  assert.equal(screenClass(1920), 'wide');
  assert.equal(screenClass(1280), 'wide');
  assert.equal(screenClass(1279), 'mid');
  assert.equal(screenClass(768), 'mid');
  assert.equal(screenClass(767), 'narrow');
  assert.equal(screenClass(320), 'narrow');
  assert.equal(fitColumns(320), 1);
  assert.equal(fitColumns(647), 1);
  assert.equal(fitColumns(648), 2, 'two columns and a bar');
  assert.equal(fitColumns(976), 3);
  assert.equal(fitColumns(1304), 4);
  assert.equal(fitColumns(5000), 4, 'never more than four');
  assert.equal(fitColumns(Infinity), 4, 'unknown: all of them');
  assert.equal(fitColumns(0), 4, 'not laid out yet');
});

test('normalizeLayout: columns of one or two, four windows at most, each module once', () => {
  assert.deepEqual(normalizeLayout({ cols: [{ w: 2, wins: ['notes'] }, { w: 1, wins: ['next', 'tasks'], h: 0.3 }], focus: 'tasks' }),
    { cols: [{ w: 2, wins: ['notes'] }, { w: 1, wins: ['next', 'tasks'], h: 0.3 }], focus: 'tasks' });
  assert.deepEqual(normalizeLayout({ slots: [{ module: 'next', w: 1.5 }, { module: 'notes', w: 0.5 }], focus: 'notes' }),
    { cols: [{ w: 1.5, wins: ['next'] }, { w: 0.5, wins: ['notes'] }], focus: 'notes' }, 'the prototype’s slots');
  assert.deepEqual(normalizeLayout({ cols: [{ wins: [{ module: 'tasks', route: 'list/12' }] }] }),
    { cols: [{ w: 1, wins: ['tasks'] }], focus: 'tasks' }, 'a window with its route (ventanas.md)');
  const many = normalizeLayout({ cols: [
    { wins: ['a', 'a', 'b', 'c'] }, { wins: [] }, { wins: ['d'] }, { wins: ['e'] }, { wins: ['f'] }, { wins: ['g'] },
  ] });
  assert.deepEqual(many.cols.map((c) => c.wins), [['a', 'b'], ['d'], ['e']], 'two a column, four windows in all, empty columns out');
  assert.equal(many.focus, 'a', 'no focus: the first window');
  assert.deepEqual(normalizeLayout({ cols: [{ w: -3, wins: ['a'] }, { w: 'x', wins: ['b', 'c'], h: 7 }] }).cols,
    [{ w: 1, wins: ['a'] }, { w: 1, wins: ['b', 'c'], h: 0.5 }], 'shares that make no sense are even');
  assert.equal(normalizeLayout({ cols: [{ w: 99, wins: ['a', 'b'], h: 0.01 }] }).cols[0].h, 0.1, 'a stacked window keeps a tenth');
  assert.deepEqual(normalizeLayout({ cols: [{ wins: ['a'] }, { wins: ['b'] }], focus: 'z' }, { modules: ['b'] }),
    { cols: [{ w: 1, wins: ['b'] }], focus: 'b' }, 'only what may be shown');
  for (const junk of [null, undefined, 3, 'x', {}, { cols: 'x' }, { cols: [null, 4, { wins: [5, null] }] }]) {
    assert.deepEqual(normalizeLayout(junk), { cols: [], focus: null });
  }
});

test('applyColumns: the rail’s 1–4 and 2×2 keep what shows and the focused window', () => {
  const two = L('notes', 'next');
  assert.deepEqual(applyColumns(3, ['next', 'notes', 'tasks', 'projects'], two).cols.map((c) => c.wins), [['notes'], ['next'], ['tasks']]);
  assert.deepEqual(applyColumns(4, ['tasks'], null).cols.map((c) => c.wins), [['tasks']], 'fewer modules than columns');
  const one = applyColumns(1, [], { ...two, focus: 'next' });
  assert.deepEqual(one, { cols: [{ w: 1, wins: ['next'] }], focus: 'next' }, 'one column: the focused window stays');
  const grid = applyColumns('2x2', ['next', 'notes', 'tasks', 'projects'], two);
  assert.deepEqual(grid.cols.map((c) => c.wins), [['notes', 'tasks'], ['next', 'projects']], 'filled by rows: side by side stays side by side');
  assert.deepEqual(grid.cols.map((c) => c.h), [0.5, 0.5]);
  assert.deepEqual(applyColumns('2x2', ['a', 'b', 'c']).cols.map((c) => c.wins), [['a', 'c'], ['b']]);
  assert.deepEqual(applyColumns(9, ['a', 'b', 'c', 'd', 'e']).cols.length, 4);
  assert.deepEqual(applyColumns(2, ['a', 'b', 'c', 'd'], { ...L('a', 'b', 'c', 'd'), focus: 'd' }).cols.map((c) => c.wins), [['a'], ['d']]);
});

test('fitLayout: the columns that don’t fit stack where there is room; a phone shows the focused window', () => {
  const four = L('a', 'b', 'c', 'd');
  assert.equal(fitLayout(four, 4), four, 'what fits is left alone');
  assert.deepEqual(fitLayout(four, 3).cols.map((c) => c.wins), [['a'], ['b'], ['c', 'd']]);
  assert.deepEqual(fitLayout(four, 2).cols.map((c) => c.wins), [['a', 'd'], ['b', 'c']]);
  const one = fitLayout({ ...four, focus: 'd' }, 1);
  assert.deepEqual(one.cols.map((c) => c.wins), [['a', 'd']]);
  assert.equal(one.focus, 'd');
  assert.deepEqual(narrowLayout({ ...four, focus: 'c' }), { cols: [{ w: 1, wins: ['c'] }], focus: 'c' });
  assert.deepEqual(narrowLayout({ cols: [], focus: null }), { cols: [], focus: null });
});

test('moves: a column to another place keeps each place’s width; two windows swap', () => {
  const layout = normalizeLayout({ cols: [{ w: 2, wins: ['a'] }, { w: 1, wins: ['b', 'c'], h: 0.3 }, { w: 1, wins: ['d'] }] });
  const moved = moveColumn(layout, 0, 2);
  assert.deepEqual(moved.cols, [{ w: 2, wins: ['b', 'c'], h: 0.3 }, { w: 1, wins: ['d'] }, { w: 1, wins: ['a'] }]);
  assert.deepEqual(layout.cols[0].wins, ['a'], 'the layout it came from is untouched');
  assert.deepEqual(swapWindows(layout, 'a', 'c').cols.map((c) => c.wins), [['c'], ['b', 'a'], ['d']]);
  assert.equal(swapWindows(layout, 'a', 'z'), null);
  assert.deepEqual(modulesOf(layout), ['a', 'b', 'c', 'd']);
  assert.deepEqual(where(layout, 'c'), { col: 1, row: 1 });
  assert.equal(where(layout, 'z'), null);
});

test('placement: the grid’s template, its shares, each window’s column and half, and the bars', () => {
  const layout = normalizeLayout({ cols: [{ w: 2, wins: ['a'] }, { w: 1, wins: ['b', 'c'], h: 0.25 }] });
  const place = placement(layout);
  assert.equal(place.columns, 'minmax(320px, var(--cw-col-1)) 8px minmax(320px, var(--cw-col-2))');
  assert.deepEqual(place.vars, { '--cw-col-1': '2fr', '--cw-col-2': '1fr', '--cw-row-2': '0.25' });
  assert.deepEqual(place.wins, [
    { module: 'a', column: 1, stack: null, share: 'var(--cw-row-1)' },
    { module: 'b', column: 3, stack: 'top', share: 'var(--cw-row-2)' },
    { module: 'c', column: 3, stack: 'bottom', share: 'var(--cw-row-2)' },
  ]);
  assert.deepEqual(place.bars, [{ axis: 'col', at: 0, column: 2 }, { axis: 'row', at: 1, column: 3 }]);
  assert.equal(placement(L('a'), 'narrow').columns, 'minmax(0, 1fr)', 'a phone: no minimum');
  assert.equal(placement({ cols: [], focus: null }).columns, 'minmax(0, 1fr)');
});

// Three columns of 400 px from x = 8, with their bars, 800 px tall from y = 50.
const SLOTS = [0, 1, 2].map((i) => ({ left: 8 + i * 408, right: 408 + i * 408, top: 50, bottom: 850 }));

test('slotAt: a column’s head strip, the halves of a column of one, the windows of a column of two', () => {
  const layout = normalizeLayout({ cols: [{ wins: ['a'] }, { wins: ['b', 'c'], h: 0.25 }, { wins: ['d'] }] });
  assert.deepEqual(slotAt(SLOTS, layout, 100, 60), { col: 0, zone: 'head' });
  assert.deepEqual(slotAt(SLOTS, layout, 100, 200), { col: 0, zone: 'top' });
  assert.deepEqual(slotAt(SLOTS, layout, 100, 700), { col: 0, zone: 'bottom' });
  assert.deepEqual(slotAt(SLOTS, layout, 500, 200), { col: 1, zone: 'win', row: 0 }, 'above the split at a quarter');
  assert.deepEqual(slotAt(SLOTS, layout, 500, 300), { col: 1, zone: 'win', row: 1 });
  assert.deepEqual(slotAt(SLOTS, layout, 413, 400).col, 1, 'in a bar: the nearer column');
  assert.deepEqual(slotAt(SLOTS, layout, 411, 400).col, 0);
  assert.deepEqual(slotAt(SLOTS, layout, 5000, 400).col, 2, 'past the last: the last');
  assert.deepEqual(slotAt(SLOTS, layout, -50, 400).col, 0);
  assert.equal(slotAt([], layout, 0, 0), null);
});

test('dropLayout: a column’s place, stacking into half a column, swapping in a full one', () => {
  const layout = normalizeLayout({ cols: [{ w: 2, wins: ['a'] }, { wins: ['b', 'c'] }, { wins: ['d'] }] });
  assert.deepEqual(dropLayout(layout, 'a', { col: 2, zone: 'head' }).cols.map((c) => c.wins), [['b', 'c'], ['d'], ['a']], 'alone: its column moves');
  assert.equal(dropLayout(layout, 'a', { col: 0, zone: 'head' }), null, 'its own place');
  assert.equal(dropLayout(layout, 'a', { col: 0, zone: 'bottom' }), null, 'its own column');

  const stacked = dropLayout(layout, 'a', { col: 2, zone: 'top' });
  assert.deepEqual(stacked.cols.map((c) => c.wins), [['b', 'c'], ['a', 'd']], 'its column, left empty, goes');
  assert.equal(stacked.cols[1].h, 0.5);
  assert.deepEqual(dropLayout(layout, 'a', { col: 2, zone: 'bottom' }).cols.map((c) => c.wins), [['b', 'c'], ['d', 'a']]);
  assert.equal(dropLayout(layout, 'a', { col: 1, zone: 'top' }), null, 'a full column takes no third');

  assert.deepEqual(dropLayout(layout, 'a', { col: 1, zone: 'win', row: 1 }).cols.map((c) => c.wins), [['c'], ['b', 'a'], ['d']]);
  assert.equal(dropLayout(layout, 'b', { col: 1, zone: 'win', row: 0 }), null, 'over itself');
  assert.deepEqual(dropLayout(layout, 'b', { col: 1, zone: 'win', row: 1 }).cols[1].wins, ['c', 'b'], 'the other half of its column');

  const out = dropLayout(layout, 'c', { col: 2, zone: 'head' });
  assert.deepEqual(out.cols.map((c) => c.wins), [['a'], ['b'], ['d'], ['c']], 'from a stack, a column of its own beyond the one under it');
  assert.equal(out.cols[1].h, undefined, 'the column it left is a column of one');
  assert.deepEqual(dropLayout(layout, 'c', { col: 0, zone: 'head' }).cols.map((c) => c.wins), [['c'], ['a'], ['b'], ['d']]);
  assert.deepEqual(dropLayout(layout, 'c', { col: 2, zone: 'head' }, { maxCols: 3 }).cols.map((c) => c.wins), [['a'], ['b', 'd'], ['c']],
    'no room for another column: it swaps with that column’s top window');
  assert.equal(dropLayout(layout, 'z', { col: 0, zone: 'head' }), null);
  assert.equal(dropLayout(layout, 'a', null), null);
});

test('dropRect: the dashed box where a window would land', () => {
  const layout = normalizeLayout({ cols: [{ wins: ['a'] }, { wins: ['b', 'c'], h: 0.5 }, { wins: ['d'] }] });
  assert.deepEqual(dropRect(SLOTS, layout, 'a', { col: 2, zone: 'top' }), { left: 824, top: 50, width: 400, height: 396 });
  assert.deepEqual(dropRect(SLOTS, layout, 'a', { col: 2, zone: 'bottom' }), { left: 824, top: 454, width: 400, height: 396 });
  assert.deepEqual(dropRect(SLOTS, layout, 'a', { col: 1, zone: 'win', row: 1 }), { left: 416, top: 454, width: 400, height: 396 });
  assert.equal(dropRect(SLOTS, layout, 'a', { col: 2, zone: 'head' }), null, 'a column’s place is taken live');
  assert.equal(dropRect(SLOTS, layout, 'a', { col: 0, zone: 'top' }), null);
  assert.equal(dropRect(SLOTS, layout, 'b', { col: 1, zone: 'win', row: 0 }), null);
  assert.deepEqual(dropRect(SLOTS, layout, 'c', { col: 2, zone: 'head' }), { left: 1225, top: 50, width: 6, height: 800 }, 'a new column after it');
  assert.deepEqual(dropRect(SLOTS, layout, 'c', { col: 2, zone: 'head' }, { rtl: true }).left, 817, 'right to left, after is to its left');
  assert.deepEqual(dropRect(SLOTS, layout, 'c', { col: 0, zone: 'head' }), { left: 1, top: 50, width: 6, height: 800 });
  assert.deepEqual(dropRect(SLOTS, layout, 'c', { col: 2, zone: 'head' }, { maxCols: 3 }), { left: 824, top: 50, width: 400, height: 800 }, 'no room: the window it swaps with');
});

test('moveByKey: Alt and the arrows move the focused window', () => {
  const layout = normalizeLayout({ cols: [{ wins: ['a'] }, { wins: ['b', 'c'] }, { wins: ['d'] }] });
  assert.deepEqual(moveByKey(layout, 'a', 'ArrowRight').cols.map((c) => c.wins), [['b'], ['a', 'c'], ['d']]);
  assert.deepEqual(moveByKey(layout, 'c', 'ArrowRight').cols.map((c) => c.wins), [['a'], ['b', 'd'], ['c']], 'the only one there');
  assert.deepEqual(moveByKey(layout, 'c', 'ArrowLeft').cols.map((c) => c.wins), [['c'], ['b', 'a'], ['d']]);
  assert.deepEqual(moveByKey(layout, 'c', 'ArrowUp').cols[1].wins, ['c', 'b']);
  assert.deepEqual(moveByKey(layout, 'b', 'ArrowDown').cols[1].wins, ['c', 'b']);
  assert.equal(moveByKey(layout, 'b', 'ArrowUp'), null);
  assert.equal(moveByKey(layout, 'a', 'ArrowLeft'), null, 'nowhere to go');
  assert.equal(moveByKey(layout, 'd', 'ArrowRight'), null);
  assert.equal(moveByKey(layout, 'a', 'Enter'), null);
  assert.deepEqual(moveByKey(layout, 'a', 'ArrowLeft', { rtl: true }).cols[1].wins, ['a', 'c'], 'right to left: left is the next column');
});

test('a bar’s shares: each column keeps 320 px, each stacked window 160', () => {
  assert.equal(shareAfter({ a: 500, b: 500, total: 2, dx: 100 }), 1.2);
  assert.equal(shareAfter({ a: 500, b: 500, total: 2, dx: -400 }), 0.64, 'the left one at its minimum');
  assert.equal(shareAfter({ a: 500, b: 500, total: 2, dx: 400 }), 1.36, 'the right one at its minimum');
  assert.equal(rowShareAt({ top: 0, height: 808, y: 404 }), 0.5);
  assert.equal(rowShareAt({ top: 0, height: 808, y: 4 }), 0.2, 'the top window at its minimum');
  assert.equal(rowShareAt({ top: 0, height: 808, y: 900 }), 0.8);
  assert.equal(rowShareAt({ top: 0, height: 200, y: 10 }), 0.5, 'too short for two: halves');
});

test('LRU: the last used first; beyond four, the least recently used that doesn’t show goes', () => {
  let order = [];
  for (const m of ['a', 'b', 'c', 'd', 'e']) order = lruTouch(order, m);
  assert.deepEqual(order, ['e', 'd', 'c', 'b', 'a']);
  order = lruTouch(order, 'a');
  assert.deepEqual(order, ['a', 'e', 'd', 'c', 'b']);
  assert.deepEqual(lruEvict(order, ['a'], 4), ['b']);
  assert.deepEqual(lruEvict(order, new Set(['b', 'c']), 3), ['d', 'e'], 'never one that shows');
  assert.deepEqual(lruEvict(order, [], 5), []);
  assert.deepEqual(lruEvict(['a', 'b'], ['a', 'b'], 1), [], 'all showing: none');
});

test('kept by screen class, read back whatever shape it has, never failing', () => {
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
  assert.equal(readLayout(storage, 'wide'), null);
  writeLayout(storage, 'wide', L('a', 'b'));
  writeLayout(storage, 'mid', L('c'));
  assert.deepEqual(JSON.parse(data.get(KEY)).wide.cols.length, 2, 'one key, a layout per class');
  assert.deepEqual(readLayout(storage, 'wide'), L('a', 'b'));
  assert.deepEqual(readLayout(storage, 'mid'), L('c'));
  assert.deepEqual(readLayout(storage, 'wide', { modules: ['b'] }), L('b'), 'a module no longer there is left out');
  assert.equal(readLayout(storage, 'wide', { modules: ['z'] }), null, 'nothing left: none');
  data.set(KEY, JSON.stringify({ wide: { slots: [{ module: 'next', w: 1 }], focus: 'next' } }));
  assert.deepEqual(readLayout(storage, 'wide'), L('next'), 'the prototype’s');
  data.set(KEY, '{not json');
  assert.equal(readLayout(storage, 'wide'), null);
  writeLayout(storage, 'wide', L('a'));
  assert.deepEqual(readLayout(storage, 'wide'), L('a'), 'what was unreadable is written over');
  data.set(KEY, '[1]');
  writeLayout(storage, 'mid', L('b'));
  assert.deepEqual(readLayout(storage, 'mid'), L('b'));
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  assert.equal(readLayout(broken, 'wide'), null);
  assert.doesNotThrow(() => writeLayout(broken, 'wide', L('a')));
  assert.equal(readLayout(null, 'wide'), null);
  assert.doesNotThrow(() => writeLayout(null, 'wide', L('a')));
});

/* ---------------------------------- the windows ---------------------------------- */

class FakeWindow extends FakeEventTarget {
  constructor(width = 1400) {
    super();
    this.innerWidth = width;
    this.dir = 'ltr';
  }
  requestAnimationFrame(fn) { fn(); return 0; }
  cancelAnimationFrame() {}
  getComputedStyle() { return { direction: this.dir, paddingLeft: '8px', paddingRight: '8px' }; }
  matchMedia() { return { matches: false }; }
}

/** A desk, a shell that makes each module's window when asked, and what the windows told it. */
function setup({ width = 1400, modules = ['next', 'notes', 'tasks', 'projects', 'work'], ...options } = {}) {
  const desk = document.createElement('main');
  desk.className = 'cw-desk';
  desk.clientWidth = width;
  const win = new FakeWindow(width);
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
  const told = [];
  const made = new Map();
  const windowOf = (module) => {
    if (made.has(module)) return made.get(module);
    const head = document.createElement('header');
    head.className = 'cw-win__head';
    const body = document.createElement('div');
    body.className = 'cw-win__body';
    const node = document.createElement('section');
    node.className = 'cw-win';
    node.append(head, body);
    made.set(module, node);
    told.push(['made', module]);
    return node;
  };
  const windows = createWindows(desk, {
    windowOf, storage, win, modules,
    nameOf: (m) => m.toUpperCase(),
    onPause: (m, paused, why) => told.push([paused ? 'pause' : 'resume', m, Object.keys(why)[0]]),
    onShow: (m) => told.push(['show', m]),
    onFocus: (m) => told.push(['focus', m]),
    onEvict: (m) => { made.get(m).remove(); made.delete(m); told.push(['evict', m]); },
    onGesture: (on, kind) => told.push([on ? 'start' : 'end', kind]),
    ...options,
  });
  /** Gives each shown window the box its place in the layout would have: 8 px gaps, 800 px tall. */
  const lay = () => {
    const cols = windows.layout.cols;
    const w = (width - 16 - (cols.length - 1) * 8) / cols.length;
    cols.forEach((col, i) => col.wins.forEach((m, row) => {
      const half = col.wins.length === 2;
      made.get(m).box = { left: 8 + i * (w + 8), width: w, top: half && row ? 462 : 50, height: half ? 396 : 800 };
    }));
  };
  const head = (m) => made.get(m).children[0];
  const press = (target, x, y, more = {}) => desk.dispatch('pointerdown', {
    target, clientX: x, clientY: y, button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse', timeStamp: 0, preventDefault() {}, ...more,
  });
  return { desk, win, data, told, made, windows, lay, head, press };
}

test('windows: placed by grid column only, the others hidden, inert and paused, the layout kept', () => {
  const { desk, told, made, windows, data } = setup();
  windows.restore({ cols: [{ w: 1, wins: ['notes'] }, { w: 1, wins: ['next'] }] });
  assert.deepEqual(told, [['made', 'notes'], ['show', 'notes'], ['made', 'next'], ['show', 'next'], ['focus', 'notes']]);
  assert.equal(desk.style.gridTemplateColumns, 'minmax(320px, var(--cw-col-1)) 8px minmax(320px, var(--cw-col-2))');
  assert.equal(desk.style['--cw-col-1'], '1fr');
  assert.equal(made.get('notes').style.gridColumn, '1');
  assert.equal(made.get('next').style.gridColumn, '3');
  assert.equal(made.get('notes').getAttribute('data-focus'), 'true');
  assert.equal(made.get('notes').getAttribute('data-win'), 'notes');
  assert.equal(made.get('notes').parentNode, desk, 'in the desk, once');
  const head = made.get('notes').children[0];
  assert.equal(head.getAttribute('tabindex'), '0', 'its head takes the focus');
  assert.equal(head.getAttribute('aria-label'), 'kit.windows.window');
  assert.equal(desk.querySelectorAll('.cw-bar').length, 1);
  assert.equal(desk.querySelector('.cw-bar').getAttribute('data-axis'), 'col');
  assert.ok(JSON.parse(data.get(KEY)).wide, 'kept for a wide screen');

  told.length = 0;
  const notes = made.get('notes');
  const children = desk.children.length;
  windows.show('tasks');
  assert.deepEqual(windows.layout.cols.map((c) => c.wins), [['tasks'], ['next']], 'in the focused window’s place');
  assert.equal(notes.hidden, true);
  assert.equal(notes.inert, true);
  assert.equal(made.get('notes'), notes, 'still mounted, still the same node');
  assert.deepEqual(told, [['pause', 'notes', 'hidden'], ['made', 'tasks'], ['show', 'tasks'], ['focus', 'tasks']]);
  assert.equal(desk.children.length, children + 1, 'only the new window was added');

  told.length = 0;
  windows.show('notes', { instead: 'next' });
  assert.deepEqual(windows.layout.cols.map((c) => c.wins), [['tasks'], ['notes']]);
  assert.deepEqual(told, [['pause', 'next', 'hidden'], ['resume', 'notes', 'hidden'], ['show', 'notes'], ['focus', 'notes']]);
  assert.equal(notes.hidden, false);
  assert.equal(notes.inert, false);
  assert.equal(notes.style.gridColumn, '3', 'moved by its grid column');
  windows.destroy();
});

test('windows: stacked in a column, by halves of its cell, with a bar between', () => {
  const { desk, made, windows } = setup();
  windows.set({ cols: [{ w: 1, wins: ['notes', 'next'], h: 0.4 }, { w: 1, wins: ['tasks'] }] });
  assert.equal(made.get('notes').getAttribute('data-stack'), 'top');
  assert.equal(made.get('next').getAttribute('data-stack'), 'bottom');
  assert.equal(made.get('next').style['--cw-share'], 'var(--cw-row-1)');
  assert.equal(made.get('notes').style.gridColumn, made.get('next').style.gridColumn);
  assert.equal(desk.style['--cw-row-1'], '0.4');
  assert.deepEqual(desk.querySelectorAll('.cw-bar').map((b) => b.getAttribute('data-axis')), ['col', 'row']);
  windows.set({ cols: [{ wins: ['notes'] }, { wins: ['next'] }] });
  assert.equal(made.get('notes').getAttribute('data-stack'), null, 'alone again');
  assert.equal(made.get('notes').style['--cw-share'], undefined);
  windows.destroy();
});

test('windows: four mounted at most, the least recently used given back', () => {
  const { told, made, windows } = setup();
  windows.set({ cols: [{ wins: ['next'] }] });
  for (const m of ['notes', 'tasks', 'projects']) windows.show(m);
  assert.equal(made.size, 4);
  windows.focus('projects');
  told.length = 0;
  windows.show('work');
  assert.deepEqual(told.filter(([what]) => what === 'evict'), [['evict', 'next']], 'the least recently used');
  assert.equal(made.has('next'), false);
  assert.deepEqual(windows.recent, ['work', 'projects', 'tasks', 'notes']);
  told.length = 0;
  windows.show('next');
  assert.deepEqual(told.slice(0, 3), [['pause', 'work', 'hidden'], ['made', 'next'], ['show', 'next']], 'made again');
  assert.deepEqual(told.filter(([what]) => what === 'evict'), [['evict', 'notes']]);
  windows.destroy();
});

test('windows: the rail’s columns, and what doesn’t fit the desk stacks', () => {
  const { windows } = setup({ width: 1000 });
  windows.set({ cols: [{ wins: ['notes'] }] });
  windows.columns(3);
  assert.deepEqual(windows.layout.cols.map((c) => c.wins), [['notes'], ['next'], ['tasks']]);
  windows.columns(4);
  assert.deepEqual(windows.layout.cols.map((c) => c.wins), [['notes'], ['next'], ['tasks', 'projects']], '984 px hold three columns');
  windows.columns('2x2');
  assert.deepEqual(windows.layout.cols.map((c) => c.wins), [['notes', 'tasks'], ['next', 'projects']]);
  windows.columns(1);
  assert.deepEqual(windows.layout.cols.map((c) => c.wins), [['notes']]);
  windows.destroy();
});

test('reorder: the head picks its window up after 6 px, its column takes another’s place, Escape puts it back', () => {
  const { desk, win, told, made, windows, lay, head, press } = setup();
  windows.set({ cols: [{ w: 2, wins: ['notes'] }, { w: 1, wins: ['next'] }, { w: 1, wins: ['tasks'] }] });
  lay();
  told.length = 0;
  animations.length = 0;
  press(head('notes'), 100, 60);
  head('notes').dispatch('pointermove', { clientX: 103, clientY: 61 });
  assert.equal(made.get('notes').getAttribute('data-carried'), null, 'not yet: 6 px');
  head('notes').dispatch('pointermove', { clientX: 600, clientY: 62 });
  assert.equal(made.get('notes').getAttribute('data-carried'), '');
  assert.equal(desk.getAttribute('data-reordering'), '');
  assert.deepEqual(windows.layout.cols.map((c) => c.wins), [['next'], ['notes'], ['tasks']], 'live, by the slots measured');
  assert.deepEqual(windows.layout.cols.map((c) => c.w), [2, 1, 1], 'each place keeps its width');
  assert.equal(made.get('notes').style.gridColumn, '3');
  assert.match(made.get('notes').style.transform, /^translate\(/);
  assert.ok(animations.some((a) => a.node === made.get('next')), 'the other makes room (FLIP)');
  win.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(windows.layout.cols.map((c) => c.wins), [['notes'], ['next'], ['tasks']], 'put back');
  assert.equal(made.get('notes').style.transform, '');
  assert.equal(made.get('notes').getAttribute('data-carried'), null);
  assert.equal(desk.getAttribute('data-reordering'), null);
  assert.equal(desk.querySelector('.cw-drop'), null, 'its dashed box gone');
  assert.deepEqual(told.filter(([w]) => w === 'start' || w === 'end'), [['start', 'reorder'], ['end', 'reorder']]);
  assert.equal(head('notes').listenerCount(), 0, 'the gesture’s listeners gone');
  assert.equal(win.listenerCount(), 1, 'only the resize listener stays');

  press(head('notes'), 100, 60);
  head('notes').dispatch('pointermove', { clientX: 1100, clientY: 62 });
  head('notes').dispatch('pointerup', {});
  assert.deepEqual(windows.layout.cols.map((c) => c.wins), [['next'], ['tasks'], ['notes']], 'let go: it stays');
  assert.equal(head('notes').listenerCount(), 0);
  windows.destroy();
});

test('reorder: let go over half a column, it stacks there; over a window of a full one, they swap', () => {
  const { desk, made, windows, lay, head, press } = setup();
  windows.set({ cols: [{ wins: ['notes'] }, { wins: ['next'] }, { wins: ['tasks'] }] });
  lay();
  press(head('notes'), 100, 60);
  head('notes').dispatch('pointermove', { clientX: 1100, clientY: 700 });
  const ghost = desk.querySelector('.cw-drop');
  assert.ok(ghost, 'a dashed box where it would land');
  assert.equal(ghost.style.height, '396px');
  head('notes').dispatch('pointerup', {});
  assert.deepEqual(windows.layout.cols.map((c) => c.wins), [['next'], ['tasks', 'notes']]);
  assert.equal(made.get('notes').getAttribute('data-stack'), 'bottom');
  assert.equal(desk.querySelector('.cw-drop'), null);

  lay();
  press(head('next'), 100, 60);
  head('next').dispatch('pointermove', { clientX: 1000, clientY: 200 });
  head('next').dispatch('pointerup', {});
  assert.deepEqual(windows.layout.cols.map((c) => c.wins), [['tasks'], ['next', 'notes']], 'swapped with the top one');
  windows.destroy();
});

test('reorder: a control in the head, a second button, one window or a phone pick nothing up', () => {
  const { made, windows, head, press, lay } = setup();
  windows.set({ cols: [{ wins: ['notes'] }, { wins: ['next'] }] });
  lay();
  const button = document.createElement('button');
  head('notes').append(button);
  press(button, 100, 60);
  assert.equal(head('notes').listenerCount(), 0);
  press(head('notes'), 100, 60, { button: 2 });
  assert.equal(head('notes').listenerCount(), 0);
  windows.set({ cols: [{ wins: ['notes'] }] });
  press(head('notes'), 100, 60);
  assert.equal(head('notes').listenerCount(), 0, 'alone, nowhere to go');
  assert.equal(made.get('notes').getAttribute('data-carried'), null);
  windows.destroy();
});

test('resize: the bar moves two columns’ shares in rAF, pausing them; a double click evens', () => {
  const { desk, told, windows, lay, press } = setup();
  windows.set({ cols: [{ wins: ['notes'] }, { wins: ['next'] }, { wins: ['tasks'] }] });
  lay();
  told.length = 0;
  const bar = desk.querySelectorAll('.cw-bar')[0];
  press(bar, 466, 400);
  assert.deepEqual(told.slice(0, 3), [['pause', 'notes', 'resizing'], ['pause', 'next', 'resizing'], ['start', 'resize']], 'only the two it touches');
  bar.dispatch('pointermove', { clientX: 566, clientY: 400 });
  assert.equal(desk.getAttribute('data-resizing'), '');
  const [a, b] = [Number.parseFloat(desk.style['--cw-col-1']), Number.parseFloat(desk.style['--cw-col-2'])];
  assert.ok(a > 1 && Math.abs(a + b - 2) < 0.001, `${a} + ${b}`);
  assert.equal(windows.layout.cols[0].w, 1, 'the layout changes when it is let go');
  bar.dispatch('pointerup', {});
  assert.ok(windows.layout.cols[0].w > 1);
  assert.deepEqual(told.slice(-3), [['resume', 'notes', 'resizing'], ['resume', 'next', 'resizing'], ['end', 'resize']]);
  assert.equal(desk.getAttribute('data-resizing'), null);
  assert.equal(bar.listenerCount(), 0);
  desk.dispatch('dblclick', { target: bar });
  assert.deepEqual(windows.layout.cols.map((c) => c.w), [1, 1, 1]);

  lay();
  press(bar, 466, 400);
  bar.dispatch('pointermove', { clientX: 50, clientY: 400 });
  bar.dispatch('pointerup', {});
  const narrowest = windows.layout.cols[0].w / (windows.layout.cols[0].w + windows.layout.cols[1].w);
  assert.ok(Math.abs(narrowest * (456 * 2) - 320) < 1, `never under 320 px: ${narrowest * 912}`);

  desk.dispatch('keydown', { target: bar, key: 'ArrowRight', preventDefault() {} });
  assert.ok(windows.layout.cols[0].w > windows.layout.cols[1].w * 0.5, 'arrow keys move a focused bar');
  windows.destroy();
});

test('resize: the bar between two stacked windows moves their row share; Escape cancels', () => {
  const { desk, win, windows, lay, press } = setup();
  windows.set({ cols: [{ wins: ['notes', 'next'] }, { wins: ['tasks'] }] });
  lay();
  const bar = desk.querySelectorAll('.cw-bar').find((b) => b.getAttribute('data-axis') === 'row');
  press(bar, 300, 450);
  bar.dispatch('pointermove', { clientX: 300, clientY: 250 });
  assert.ok(Number(desk.style['--cw-row-1']) < 0.5);
  win.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(windows.layout.cols[0].h, 0.5);
  assert.equal(desk.style['--cw-row-1'], '0.5', 'written back');
  press(bar, 300, 450);
  bar.dispatch('pointermove', { clientX: 300, clientY: 250 });
  bar.dispatch('pointerup', {});
  assert.ok(windows.layout.cols[0].h < 0.5);
  desk.dispatch('dblclick', { target: bar });
  assert.equal(windows.layout.cols[0].h, 0.5);
  windows.destroy();
});

test('keyboard: Alt and an arrow on a head move its window; focusing inside a window focuses it', () => {
  const { desk, told, windows, head } = setup();
  windows.set({ cols: [{ wins: ['notes'] }, { wins: ['next'] }] });
  told.length = 0;
  desk.dispatch('focusin', { target: head('next') });
  assert.equal(windows.layout.focus, 'next');
  assert.deepEqual(told, [['focus', 'next']]);
  let prevented = false;
  desk.dispatch('keydown', { target: head('next'), key: 'ArrowLeft', altKey: true, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.deepEqual(windows.layout.cols.map((c) => c.wins), [['next'], ['notes']]);
  desk.dispatch('keydown', { target: head('next'), key: 'ArrowLeft', altKey: false, preventDefault() {} });
  assert.deepEqual(windows.layout.cols.map((c) => c.wins), [['next'], ['notes']], 'without Alt, the module’s');
  windows.destroy();
});

test('phones: one window, a tab per module, switching by tab or by swipe, the edges left alone', () => {
  const { desk, made, windows, told, press } = setup({ width: 390 });
  windows.restore({ cols: [{ wins: ['notes'] }, { wins: ['next'] }] });
  assert.equal(desk.getAttribute('data-screen'), 'narrow');
  assert.deepEqual(windows.layout.cols.map((c) => c.wins), [['notes']], 'one window at a time');
  assert.equal(desk.style.gridTemplateColumns, 'minmax(0, 1fr)');
  const tabs = desk.querySelector('.cw-tabs');
  assert.ok(tabs);
  assert.equal(tabs.getAttribute('aria-label'), 'kit.windows.tabs');
  assert.deepEqual(tabs.children.map((b) => b.getAttribute('data-module')), ['next', 'notes', 'tasks', 'projects', 'work']);
  assert.deepEqual(tabs.children.map((b) => b.textContent), ['NEXT', 'NOTES', 'TASKS', 'PROJECTS', 'WORK']);
  assert.equal(tabs.children[1].getAttribute('aria-current'), 'true');

  desk.dispatch('click', { target: tabs.children[0] });
  assert.equal(windows.layout.focus, 'next');
  assert.equal(made.get('notes').hidden, true);
  assert.equal(tabs.children[0].getAttribute('aria-current'), 'true');

  // A swipe to the left brings the next mounted module (notes, after next in the tabs).
  const body = made.get('next').children[1];
  told.length = 0;
  press(body, 300, 400, { pointerType: 'touch', timeStamp: 0 });
  desk.dispatch('pointermove', { pointerId: 1, clientX: 280, clientY: 402, timeStamp: 20 });
  desk.dispatch('pointermove', { pointerId: 1, clientX: 150, clientY: 405, timeStamp: 120 });
  assert.equal(made.get('next').style.transform, 'translateX(-150px)');
  desk.dispatch('pointerup', { pointerId: 1 });
  assert.equal(windows.layout.focus, 'notes');
  assert.equal(made.get('next').style.transform, '');
  assert.deepEqual(told.filter(([w]) => w === 'start' || w === 'end'), [['start', 'swipe'], ['end', 'swipe']]);

  // Nothing further that way: it gives a little and comes back.
  press(made.get('notes').children[1], 300, 400, { pointerType: 'touch', timeStamp: 0 });
  desk.dispatch('pointermove', { pointerId: 1, clientX: 200, clientY: 400, timeStamp: 50 });
  assert.equal(made.get('notes').style.transform, 'translateX(-30px)');
  desk.dispatch('pointerup', { pointerId: 1 });
  assert.equal(windows.layout.focus, 'notes');

  // Up and down is the module's scroll; a held finger is a row picked up; the edges are the drawer's.
  for (const [start, moves] of [
    [{ x: 300, y: 400 }, [{ clientX: 302, clientY: 300, timeStamp: 50 }, { clientX: 400, clientY: 280, timeStamp: 80 }]],
    [{ x: 200, y: 400 }, [{ clientX: 330, clientY: 400, timeStamp: 600 }]],
    [{ x: 10, y: 400 }, [{ clientX: 300, clientY: 400, timeStamp: 50 }]],
  ]) {
    press(made.get('notes').children[1], start.x, start.y, { pointerType: 'touch', timeStamp: 0 });
    for (const move of moves) desk.dispatch('pointermove', { pointerId: 1, ...move });
    desk.dispatch('pointerup', { pointerId: 1 });
    assert.equal(windows.layout.focus, 'notes');
  }
  assert.equal(desk.listeners.pointermove?.length ?? 0, 0, 'no swipe left listening');

  // A mouse doesn't swipe; a head isn't picked up on a phone.
  press(made.get('notes').children[1], 300, 400);
  desk.dispatch('pointermove', { pointerId: 1, clientX: 100, clientY: 400, timeStamp: 50 });
  desk.dispatch('pointerup', { pointerId: 1 });
  assert.equal(windows.layout.focus, 'notes');
  windows.destroy();
});

test('screen class: wider, the wide layout kept comes back; narrower, the focused window alone', () => {
  const { desk, win, windows } = setup();
  windows.set({ cols: [{ wins: ['notes'] }, { wins: ['next'] }] });
  windows.focus('next');
  win.innerWidth = 400;
  desk.clientWidth = 400;
  win.dispatch('resize');
  assert.equal(windows.screen, 'narrow');
  assert.deepEqual(windows.layout, { cols: [{ w: 1, wins: ['next'] }], focus: 'next' });
  win.innerWidth = 1400;
  desk.clientWidth = 1400;
  win.dispatch('resize');
  assert.equal(windows.screen, 'wide');
  assert.deepEqual(windows.layout.cols.map((c) => c.wins), [['notes'], ['next']]);
  windows.destroy();
});

test('screen class: a narrower window squeezes the columns, and the layout as chosen comes back when it widens', () => {
  const { desk, win, data, windows } = setup();
  windows.set({ cols: [{ wins: ['notes'] }, { wins: ['next'] }, { wins: ['tasks'] }, { wins: ['projects'] }] });
  win.innerWidth = 1300;
  desk.clientWidth = 1300;
  win.dispatch('resize');
  assert.equal(windows.screen, 'wide');
  assert.deepEqual(windows.layout.cols.map((c) => c.wins), [['notes'], ['next'], ['tasks', 'projects']], 'three columns fit');
  windows.focus('next');
  assert.equal(JSON.parse(data.get(KEY)).wide.cols.length, 4, 'a click keeps the focus, not the squeezed layout');
  win.innerWidth = 1400;
  desk.clientWidth = 1400;
  win.dispatch('resize');
  assert.deepEqual(windows.layout.cols.map((c) => c.wins), [['notes'], ['next'], ['tasks'], ['projects']], 'four again');
  assert.equal(windows.layout.focus, 'next');
  windows.destroy();
});

test('destroy: every listener off, the bars and tabs gone, the windows left to the shell', () => {
  const { desk, win, made, windows, head, press, lay } = setup({ width: 500 });
  windows.set({ cols: [{ wins: ['notes'] }] });
  win.innerWidth = 1400;
  desk.clientWidth = 1400;
  win.dispatch('resize');
  windows.set({ cols: [{ wins: ['notes'] }, { wins: ['next', 'tasks'] }] });
  lay();
  press(head('notes'), 100, 60);
  head('notes').dispatch('pointermove', { clientX: 900, clientY: 60 });
  windows.destroy();
  assert.equal(desk.listenerCount(), 0);
  assert.equal(win.listenerCount(), 0);
  assert.equal(head('notes').listenerCount(), 0, 'a gesture under way is put back');
  assert.equal(desk.querySelectorAll('.cw-bar').length, 0);
  assert.equal(desk.querySelector('.cw-tabs'), null);
  assert.equal(desk.querySelector('.cw-drop'), null);
  assert.equal(desk.getAttribute('data-screen'), null);
  assert.equal(made.get('notes').parentNode, desk, 'the windows are the shell’s');
  assert.equal(made.get('notes').style.transform, '');
});
