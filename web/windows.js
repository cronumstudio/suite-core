/**
 * The windows of Cronum Work's one-document shell (architecture §21.6, Work's r2/ventanas.md §2.3):
 * one to four columns side by side, each with one window or two stacked (four make a 2×2), a
 * module in each. A window is the shell's `<section class="cw-win">` with its head
 * (`.cw-win__head`) and its body; once made it never moves in the document —its module keeps its
 * state, its scroll and its editor, and a frame isn't loaded again—: placing it is only its grid
 * column and row.
 *
 * - Reorder: a window's head picks it up after 6 px. It follows the pointer with a transform set
 *   only inside requestAnimationFrame, from the last move, with no layout read in the loop: the
 *   columns are measured once, when it is picked up, and where it would land is found by those
 *   boxes. As magnets, the window it comes over gives way while it is carried: pushed toward the
 *   place it would take, up to 40 % of the way, as much as it is covered; past 55 % the two trade
 *   places (a column takes another's place, two windows of a 2×2 swap) and the others flow on to
 *   theirs from where they were pushed (FLIP, 420 ms with a slight overshoot, on our own clock so a
 *   long frame doesn't skip part of it). Let go short of that, they go back. Over the top or bottom
 *   part of a column with room it would stack there, shown by a dashed box and done on letting go.
 *   Escape puts everything back.
 * - Resize: the 8 px bars between two columns and between two stacked windows move their shares
 *   (`--cw-col-N` in fr, `--cw-row-N` the top window's share of its column) inside rAF, the windows
 *   they touch paused while it lasts (`onPause(module, true, { resizing: true })`). A double click
 *   shares them out evenly; arrow keys move a focused bar. A column is 320 px at least.
 * - Keyboard: a window's head takes the focus, and Alt with an arrow moves its window to the
 *   next column or the other half of its column.
 * - Maximize: a button at the end of each head (or a double click on it) gives its window the whole
 *   desk, over the others, which fade out; it slides and grows there with the spring of the windows
 *   trading places, in 280 ms (paced), and the same button, now «Restore», takes it back to its place
 *   and size. The layout under it doesn't change, nor is it kept: any change of the windows (one
 *   shown, moved, another focused, a phone's screen) restores it first.
 * - Phones (< 768 px): one window at a time filling the desk, a bar of tabs at the bottom
 *   (`.cw-tabs`, one per module) and a sideways swipe to the module beside it among the mounted
 *   ones, unless it began on something that slides sideways itself (Next's line, the Gantt) or
 *   on something with a sideways gesture of its own that says so with `data-own-swipe` (Tasks'
 *   rows: left deletes, right stars). The desk only pans vertically (kit: windows.css), so the
 *   page never scrolls sideways, and once a finger goes sideways the swipe keeps its moves from
 *   the browser, in any module's list.
 * - A window out of view is `hidden` and `inert` and its module paused (`onPause(module, true,
 *   { hidden: true })`); at most four stay mounted, and beyond that the one used least recently is
 *   given back (`onEvict(module)`: the shell unmounts it and removes its window).
 * - A module the person turns off goes with `drop(module)`: its window and its tab, at once.
 * - The layout is kept on this device, one per screen class (`work.layout`: wide ≥ 1280 px, mid
 *   ≥ 768 px, narrow), because four columns don't fit on a tablet.
 *
 *   const windows = createWindows(desk, { windowOf, onPause, onShow, onEvict, modules, nameOf });
 *   windows.restore({ cols: [{ w: 1, wins: ['notes'] }, { w: 1, wins: ['next'] }] });
 *   windows.columns('2x2');  windows.show('tasks');  windows.destroy();
 *
 * What decides (the layout and its moves, where the pointer is, what is kept, what is evicted) is
 * pure and exported below for the tests; createWindows() only measures, writes and listens.
 */
import { el, clear } from './dom.js';
import { t } from './i18n.js';
import { icon } from './icons.js';

/** Where the layouts are kept, by screen class (Cronum Work's own key: CONVENTIONS §9). */
export const KEY = 'work.layout';

const PICK_PX = 6;          // pixels the pointer moves before a head picks its window up
const MIN_PX = 320;         // a column is never narrower
const MIN_ROW_PX = 160;     // nor a stacked window shorter
const BAR_PX = 8;           // the bars between columns and between stacked windows
const HEAD_BAND = 48;       // the strip at a column's top that always means "this column's place"
const MAX_COLS = 4;
const MAX_STACK = 2;
/** Windows in a layout at most: four columns, or two columns of two. */
export const MAX_WINDOWS = 4;
/** Modules kept mounted at most, shown or not. */
export const MAX_MOUNTED = 4;
const STACK_EDGE = 0.22;    // of a column of one, the top and bottom parts that mean "stack it here"
const FLIP_MS = 180;
const EASE = 'cubic-bezier(.32, .72, 0, 1)';   // the kit's --kit-slide
// While a window is carried, the others make room as a phone's icons do: a little longer, with a
// slight overshoot. (The carried one isn't scaled up: a whole window drawn again at another size
// cost a long frame each time; its shadow lifts it, windows.css.)
const REFLOW_MS = 420;
const MAX_MS = 280;          // maximize and restore: a click's answer, quicker than a carried window's
const FRAME_MS = 1000 / 60;
const MAX_STEP_MS = 25;     // a paced slide moves on by a frame's worth at most, however long the frame
// As magnets, the window a carried one comes over gives way: up to this part of its way while it
// is covered, and the two trade places once it is covered this much (more to trade back at once).
const PUSH = 0.4;
const COMMIT = 0.55;
const COMMIT_BACK = 0.7;
const SPRING = 'cubic-bezier(.4, .05, .2, 1.06)';
const KEY_STEP = 0.05;      // of the two shares a bar divides, per arrow key

// A phone's swipe between modules.
const SWIPE_ARM = 10;       // pixels before it is a swipe or a scroll
const SWIPE_HOLD_MS = 350;  // held still that long first, it is a finger picking a row up (drag.js)
const SWIPE_EDGE = 32;      // the screen's edges are the module's drawer's and the system's (shell.js)
const SWIPE_FLICK = 0.5;    // px/ms: a quick flick is enough, whatever its length
const SWIPE_TAKE = 3;       // pixels, more across than down, before the swipe keeps the finger from the browser
/** What has a sideways gesture of its own (Tasks' rows): a finger that starts there is never the windows' swipe. */
export const OWN_SWIPE = '[data-own-swipe]';

// Inside a head these keep their own job.
const CONTROLS = 'button, a, input, select, textarea, label, [contenteditable=""], [contenteditable="true"]';
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/* ---------------------------------- the model ---------------------------------- */

/** The screen class a layout is kept for: four columns fit on a wide screen, not on a tablet. */
export const screenClass = (width) => (width >= 1280 ? 'wide' : width >= 768 ? 'mid' : 'narrow');

/** How many columns of 320 px, with their bars, fit in `width` (unknown: all of them). */
export function fitColumns(width) {
  if (!Number.isFinite(width) || width <= 0) return MAX_COLS;
  return Math.max(1, Math.min(MAX_COLS, Math.floor((width + BAR_PX) / (MIN_PX + BAR_PX))));
}

/**
 * Whether a touch's move is a phone's swipe between modules, to keep from the browser: once the
 * swipe is one (`armed`), or while the finger, from (`x0`, `y0`), has gone more across than up and
 * down. Read from the touch itself, not from the pointer's move a browser may hand out after it.
 * Up and down stays the module's scroll.
 */
export function swipeHolds(touch, { x0, y0, armed = false }) {
  if (armed) return true;
  const dx = touch.clientX - x0;
  const dy = touch.clientY - y0;
  return Math.hypot(dx, dy) >= SWIPE_TAKE && Math.abs(dx) >= Math.abs(dy) * 1.2;
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const colShare = (w) => (Number.isFinite(w) && w > 0 ? clamp(w, 0.05, 20) : 1);
const rowShare = (h) => (Number.isFinite(h) && h > 0 && h < 1 ? clamp(h, 0.1, 0.9) : 0.5);
const round = (n) => Math.round(n * 10000) / 10000;

/**
 * A layout as the windows take it, from whatever was kept or asked: `{ cols: [{ w, wins: [module,
 * module?], h? }], focus }`, with 1–4 columns, two windows a column at most and four in all, each
 * module once; `w` a column's share of the width (fr), `h` the top window's share of a column of
 * two. The prototype's `{ slots: [{ module, w }] }` is read as one window a column, and a window
 * may come as `{ module, route }` (ventanas.md). `modules`, when given, is what may be shown.
 */
export function normalizeLayout(input, { modules } = {}) {
  const seen = new Set();
  const take = (win) => {
    const module = typeof win === 'string' ? win : win?.module;
    if (typeof module !== 'string' || !module || seen.has(module) || seen.size >= MAX_WINDOWS) return null;
    if (modules && !modules.includes(module)) return null;
    seen.add(module);
    return module;
  };
  const raw = Array.isArray(input?.cols) ? input.cols
    : Array.isArray(input?.slots) ? input.slots.map((slot) => ({ w: slot?.w, wins: [slot] })) : [];
  const cols = [];
  for (const col of raw) {
    if (cols.length >= MAX_COLS) break;
    const wins = [];
    for (const win of Array.isArray(col?.wins) ? col.wins : []) {
      if (wins.length >= MAX_STACK) break;
      const module = take(win);
      if (module) wins.push(module);
    }
    if (!wins.length) continue;
    cols.push(wins.length === 2 ? { w: colShare(col.w), wins, h: rowShare(col.h) } : { w: colShare(col.w), wins });
  }
  const all = cols.flatMap((col) => col.wins);
  return { cols, focus: all.includes(input?.focus) ? input.focus : all[0] ?? null };
}

/** The modules of a layout in reading order: each column top to bottom, the columns in order. */
export const modulesOf = (layout) => layout.cols.flatMap((col) => col.wins);

/** Where a module's window is: its column and its row in it, or null. */
export function where(layout, module) {
  for (let col = 0; col < layout.cols.length; col++) {
    const row = layout.cols[col].wins.indexOf(module);
    if (row >= 0) return { col, row };
  }
  return null;
}

const copy = (layout) => ({ cols: layout.cols.map((col) => ({ ...col, wins: [...col.wins] })), focus: layout.focus });

/**
 * The layout for the rail's choice: `n` columns (1–4) or `'2x2'`, with the modules it shows now
 * first and then the others of `modules`. The focused window stays; a 2×2 fills by rows, so two
 * windows side by side stay side by side.
 */
export function applyColumns(n, modules = [], current = null) {
  const grid = n === '2x2';
  const count = grid ? MAX_WINDOWS : clamp(Math.trunc(Number(n)) || 1, 1, MAX_COLS);
  const had = current ? modulesOf(current) : [];
  const order = [...new Set([...had, ...modules])];
  const focus = current?.focus;
  const at = order.indexOf(focus);
  if (at >= count) order.splice(count - 1, 0, ...order.splice(at, 1));
  const picked = order.slice(0, count);
  const cols = grid
    ? [0, 1].map((i) => ({ w: 1, wins: picked.filter((_, j) => j % 2 === i), h: 0.5 }))
    : picked.map((module) => ({ w: 1, wins: [module] }));
  return normalizeLayout({ cols, focus: picked.includes(focus) ? focus : picked[0] });
}

/**
 * A layout in at most `max` columns: the windows of the ones left over stack where there is room,
 * the focused one first, so that it is never the one left out.
 */
export function fitLayout(layout, max) {
  if (layout.cols.length <= max) return layout;
  const next = copy(layout);
  const over = next.cols.splice(max).flatMap((col) => col.wins);
  over.sort((a, b) => (b === layout.focus) - (a === layout.focus));
  for (const module of over) {
    const col = next.cols.findLast((c) => c.wins.length < MAX_STACK);
    if (!col) break;
    col.wins.push(module);
    col.h = 0.5;
  }
  return normalizeLayout(next);
}

/** A phone's layout: the focused window alone. */
export const narrowLayout = (layout) => ({ cols: layout.focus ? [{ w: 1, wins: [layout.focus] }] : [], focus: layout.focus });

/** Column `from` to place `to`, its windows with it; each place keeps its width. */
export function moveColumn(layout, from, to) {
  const next = copy(layout);
  const widths = next.cols.map((col) => col.w);
  next.cols.splice(to, 0, ...next.cols.splice(from, 1));
  next.cols.forEach((col, i) => { col.w = widths[i]; });
  return next;
}

/** Two windows trade places. */
export function swapWindows(layout, a, b) {
  const one = where(layout, a);
  const other = where(layout, b);
  if (!one || !other || a === b) return null;
  const next = copy(layout);
  next.cols[one.col].wins[one.row] = b;
  next.cols[other.col].wins[other.row] = a;
  return next;
}

/** Column `at`'s share of the width set to `w`, the next one's to `rest`. */
export function withShares(layout, at, w, rest) {
  const next = copy(layout);
  next.cols[at].w = round(w);
  if (next.cols[at + 1]) next.cols[at + 1].w = round(rest);
  return next;
}

/** The top window's share of column `at` set to `h`. */
export function withRow(layout, at, h) {
  const next = copy(layout);
  next.cols[at].h = round(rowShare(h));
  return next;
}

/**
 * What the grid is for a layout: its columns' template (each at least 320 px but on a phone, with
 * a bar between two), the shares as CSS variables, each window's column and half, and the bars.
 * Column N sits on grid line 2N−1, the bar after it on 2N.
 */
export function placement(layout, screen = 'wide') {
  const narrow = screen === 'narrow';
  const vars = {};
  const tracks = [];
  const wins = [];
  const bars = [];
  layout.cols.forEach((col, i) => {
    const n = i + 1;
    const column = i * 2 + 1;
    vars[`--cw-col-${n}`] = `${round(col.w)}fr`;
    tracks.push(narrow ? 'minmax(0, 1fr)' : `minmax(${MIN_PX}px, var(--cw-col-${n}))`);
    if (i < layout.cols.length - 1) {
      tracks.push(`${BAR_PX}px`);
      bars.push({ axis: 'col', at: i, column: column + 1 });
    }
    const stacked = col.wins.length === 2;
    if (stacked) {
      vars[`--cw-row-${n}`] = String(round(rowShare(col.h)));
      bars.push({ axis: 'row', at: i, column });
    }
    col.wins.forEach((module, row) => wins.push({
      module, column, stack: stacked ? (row ? 'bottom' : 'top') : null, share: `var(--cw-row-${n})`,
    }));
  });
  return { columns: tracks.join(' ') || 'minmax(0, 1fr)', vars, wins, bars };
}

/**
 * Where the pointer is, by the columns' boxes measured when the window was picked up (`slots`:
 * `[{ left, right, top, bottom }]` a column, in the layout's order): `{ col, zone }`, the zone
 * being the column's place (`head`: its head strip and its middle, so a window carried over
 * another takes its place, as a phone's icons do), the `top` or `bottom` part of a column of one
 * (stacking there), or a `win` of a column of two with its `row`. Between two columns, the nearer.
 */
export function slotAt(slots, layout, x, y, { band = HEAD_BAND, edge = STACK_EDGE } = {}) {
  if (!slots?.length) return null;
  let col = slots.findIndex((s) => x >= s.left && x < s.right);
  if (col < 0) {
    const off = slots.map((s) => Math.min(Math.abs(x - s.left), Math.abs(x - s.right)));
    col = off.indexOf(Math.min(...off));
  }
  const s = slots[col];
  const column = layout.cols[col];
  if (!column || y < s.top + band) return { col, zone: 'head' };
  if (column.wins.length >= MAX_STACK) {
    const split = s.top + (s.bottom - s.top - BAR_PX) * rowShare(column.h) + BAR_PX / 2;
    return { col, zone: 'win', row: y < split ? 0 : 1 };
  }
  const part = (s.bottom - s.top) * edge;
  if (y < s.top + band + part) return { col, zone: 'top' };
  if (y >= s.bottom - part) return { col, zone: 'bottom' };
  return { col, zone: 'head' };
}

/**
 * The layout after letting `module`'s window go over `hit` (slotAt), or null when nothing changes:
 * over a column's head, alone in its column it takes that column's place, and from a column of two
 * it becomes a column of its own beside it (or, with no room for another, swaps with its top
 * window); over half a column of one it stacks there (its own column goes if left empty); over a
 * window of a column of two, they swap.
 */
export function dropLayout(layout, module, hit, { maxCols = MAX_COLS } = {}) {
  const from = where(layout, module);
  const target = layout.cols[hit?.col];
  if (!from || !target) return null;
  if (hit.zone === 'head') {
    if (hit.col === from.col) return null;
    if (layout.cols[from.col].wins.length === 1) return moveColumn(layout, from.col, hit.col);
    if (layout.cols.length >= maxCols) return swapWindows(layout, module, target.wins[0]);
    const next = copy(layout);
    const own = next.cols[from.col];
    own.wins.splice(from.row, 1);
    delete own.h;
    next.cols.splice(hit.col > from.col ? hit.col + 1 : hit.col, 0, { w: 1, wins: [module] });
    return next;
  }
  if (hit.zone === 'win') {
    const other = target.wins[hit.row];
    return other && other !== module ? swapWindows(layout, module, other) : null;
  }
  if (hit.col === from.col || target.wins.length >= MAX_STACK) return null;
  const next = copy(layout);
  const own = next.cols[from.col];
  const dest = next.cols[hit.col];
  own.wins.splice(from.row, 1);
  delete own.h;
  dest.wins.splice(hit.zone === 'top' ? 0 : 1, 0, module);
  dest.h = 0.5;
  if (!own.wins.length) next.cols.splice(from.col, 1);
  return next;
}

/**
 * The box (page coordinates) that shows where `module` would land over `hit`, or null when it
 * would land nowhere new or is already there (a column's place is taken live, not shown).
 */
export function dropRect(slots, layout, module, hit, { maxCols = MAX_COLS, rtl = false } = {}) {
  const from = where(layout, module);
  const s = slots?.[hit?.col];
  const col = layout.cols[hit?.col];
  if (!from || !s || !col) return null;
  const height = s.bottom - s.top;
  const box = (top, h, left = s.left, width = s.right - s.left) => ({ left, top, width, height: h });
  const split = (height - BAR_PX) * rowShare(col.h);
  if (hit.zone === 'head') {
    if (hit.col === from.col || layout.cols[from.col].wins.length === 1) return null;
    if (layout.cols.length < maxCols) {
      // A column of its own: the gap on the far side of the one under the pointer.
      const after = hit.col > from.col;
      const edge = after !== rtl ? s.right + BAR_PX / 2 : s.left - BAR_PX / 2;
      return box(s.top, height, edge - 3, 6);
    }
    return col.wins.length === 2 ? box(s.top, split) : box(s.top, height);
  }
  if (hit.zone === 'win') {
    if (col.wins[hit.row] === module || !col.wins[hit.row]) return null;
    return hit.row === 0 ? box(s.top, split) : box(s.top + split + BAR_PX, height - split - BAR_PX);
  }
  if (hit.col === from.col || col.wins.length >= MAX_STACK) return null;
  const half = (height - BAR_PX) / 2;
  return hit.zone === 'top' ? box(s.top, half) : box(s.top + half + BAR_PX, half);
}

/**
 * Alt and an arrow on a window's head: left and right trade places with the window beside it (at
 * the same height, or the only one there), up and down with the other of its column. Right to
 * left, left and right follow the screen. Null when there is nowhere to go.
 */
export function moveByKey(layout, module, key, { rtl = false } = {}) {
  const from = where(layout, module);
  if (!from) return null;
  const sideways = { ArrowLeft: rtl ? 1 : -1, ArrowRight: rtl ? -1 : 1 }[key];
  if (sideways) {
    const col = layout.cols[from.col + sideways];
    return col ? swapWindows(layout, module, col.wins[Math.min(from.row, col.wins.length - 1)]) : null;
  }
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return null;
  const other = layout.cols[from.col].wins[from.row + (key === 'ArrowUp' ? -1 : 1)];
  return other ? swapWindows(layout, module, other) : null;
}

/**
 * The left column's share after its bar moved `dx` pixels: `a` and `b` are the two columns'
 * widths when it started and `total` their shares together; each keeps 320 px.
 */
export function shareAfter({ a, b, total, dx }) {
  const px = clamp(a + dx, MIN_PX, Math.max(MIN_PX, a + b - MIN_PX));
  return round(Math.min(px, a + b) * (total / (a + b)));
}

/** The top window's share of a column `height` px tall from `top`, its bar at `y`; each keeps 160 px. */
export function rowShareAt({ top, height, y }) {
  const room = height - BAR_PX;
  if (room <= 0) return 0.5;
  const min = Math.min(0.5, MIN_ROW_PX / room);
  return round(clamp((y - top - BAR_PX / 2) / room, min, 1 - min));
}

/** The modules by use, the last used first. */
export const lruTouch = (order, module) => [module, ...order.filter((m) => m !== module)];

/** Which of `order`'s modules to give back so that at most `max` stay, never one of `keep`: the least recently used. */
export function lruEvict(order, keep, max = MAX_MOUNTED) {
  const kept = new Set(keep);
  const out = [];
  let count = order.length;
  for (let i = order.length - 1; i >= 0 && count > max; i--) {
    if (kept.has(order[i])) continue;
    out.push(order[i]);
    count--;
  }
  return out;
}

/** The layout kept for a screen class, or null (none, unreadable, or nothing in it may be shown). */
export function readLayout(storage, screen, { modules } = {}) {
  try {
    const kept = JSON.parse(storage?.getItem(KEY) || '{}')?.[screen];
    const layout = kept ? normalizeLayout(kept, { modules }) : null;
    return layout?.cols.length ? layout : null;
  } catch {
    return null;
  }
}

/** Keeps a screen class's layout, leaving the others' as they were. Only a convenience: it may fail. */
export function writeLayout(storage, screen, layout) {
  try {
    let all = null;
    try { all = JSON.parse(storage?.getItem(KEY) || '{}'); } catch { /* unreadable: written over */ }
    const next = all && typeof all === 'object' && !Array.isArray(all) ? all : {};
    next[screen] = layout;
    storage?.setItem(KEY, JSON.stringify(next));
  } catch { /* private mode, full, or something else's */ }
}

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/* --------------------------------- the windows --------------------------------- */

/**
 * @param {Element} desk  the grid the windows sit in (`.cw-desk`)
 * @param {object} options
 * @param {Function} options.windowOf   (module) → its `.cw-win`, made (and its module mounted) the first time
 * @param {Function} [options.onPause]  (module, paused, { resizing } | { hidden }) a module to pause or resume
 * @param {Function} [options.onShow]   (module) a window that comes into view
 * @param {Function} [options.onGesture] (on, kind) a reorder, resize or swipe starts or ends, for whoever measures
 * @param {Function} [options.onFocus]  (module) the focus went to another window
 * @param {Function} [options.onEvict]  (module) a module to unmount, its window to remove: more than four were mounted
 * @param {string[]|Function} [options.modules] the modules there are, in the rail's order (the phone's tabs)
 * @param {Function} [options.nameOf]   (module) → its name, for the tabs and the heads' labels
 * @param {Function} [options.iconOf]   (module) → its icon's URL, for the tabs
 * @param {Storage} [options.storage]   where the layouts are kept (localStorage)
 */
export function createWindows(desk, {
  windowOf,
  onPause = () => {}, onShow = () => {}, onGesture = () => {}, onFocus = () => {}, onEvict = () => {},
  modules = [], nameOf = (module) => module, iconOf = () => null,
  storage = defaultStorage(), win = globalThis, maxMounted = MAX_MOUNTED,
} = {}) {
  const life = new AbortController();
  const { signal } = life;
  let layout = { cols: [], focus: null };
  let chosen = layout;            // the layout as chosen and kept: what shows is it, or it squeezed into the columns that fit
  let screen = screenClass(win.innerWidth ?? Infinity);
  let room = Infinity;            // the desk's width, measured outside any gesture
  const nodes = new Map();        // module → its window, as windowOf made it
  const shown = new Set();        // the modules whose window shows
  const asleep = new Set();       // hidden, and paused for it
  let recent = [];                // the mounted modules, the last used first
  let gesture = null;             // the reorder, resize or swipe under way: { kind, cancel() }
  let told = null;                // the focus onFocus was last told of
  let resizing = 0;
  const bars = [];
  let tabs = null;
  let tabsKey = '';
  let maxed = null;               // the module whose window has the whole desk
  let fades = 0;                  // maximize()'s view transitions, the last one's number
  desk.setAttribute('data-screen', screen);

  const available = () => (typeof modules === 'function' ? modules() : modules) || [];
  const allowed = () => (available().length ? { modules: [...new Set([...available(), ...nodes.keys()])] } : {});
  const raf = (fn) => (win.requestAnimationFrame ? win.requestAnimationFrame(fn) : (fn(), 0));
  const cancelFrame = (id) => { if (id) win.cancelAnimationFrame?.(id); };
  const motion = () => !win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const rtl = () => win.getComputedStyle?.(desk)?.direction === 'rtl';
  const moduleAt = (target) => {
    const node = target?.closest?.('.cw-win');
    const module = node?.getAttribute('data-win');
    return module && nodes.get(module) === node ? module : null;
  };

  /** The desk's inner width, read when the layout is chosen and never inside a gesture. */
  function measure() {
    const width = desk.clientWidth;
    if (!width) return Infinity;
    const style = win.getComputedStyle?.(desk);
    return width - (parseFloat(style?.paddingLeft) || 0) - (parseFloat(style?.paddingRight) || 0);
  }

  /** A layout as this screen shows it: on a phone the focused window, elsewhere what fits. */
  const arrange = (next) => (screen === 'narrow' ? narrowLayout(next) : fitLayout(next, fitColumns(room)));

  /** A module's window, asked of the shell the first time, then the same one until it is evicted. */
  function nodeOf(module) {
    let node = nodes.get(module);
    if (node) return node;
    node = windowOf(module);
    nodes.set(module, node);
    node.setAttribute('data-win', module);
    node.hidden = true;
    node.inert = true;
    if (node.parentNode !== desk) desk.append(node);
    label(module, node);
    recent = lruTouch(recent, module);
    return node;
  }

  function label(module, node) {
    const head = node.querySelector?.('.cw-win__head');
    if (!head) return;
    if (!head.hasAttribute('tabindex')) head.setAttribute('tabindex', '0');
    head.setAttribute('aria-label', t('kit.windows.window', { name: nameOf(module) }));
    head.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown');
    if (!head.querySelector('.cw-win__max')) head.append(el('button', { type: 'button', class: 'cw-win__max' }));
    paintMax(module, node);
  }

  /** A head's button as its window is: «Maximize», or «Restore» with the window maximized. */
  function paintMax(module, node) {
    const button = node.querySelector?.('.cw-win__max');
    const on = maxed === module;
    node.toggleAttribute('data-max', on);
    if (!button) return;
    const text = t(on ? 'kit.windows.restore' : 'kit.windows.maximize');
    button.setAttribute('aria-label', text);
    button.setAttribute('title', text);
    button.setAttribute('aria-pressed', String(on));
    // Alone on the desk there is nothing to take the room of.
    button.hidden = !on && shown.size < 2;
    clear(button);
    button.append(icon(on ? 'restore' : 'maximize'));
  }

  /** Every window's state as `maxed` says: the others step back and take no pointer or keys. */
  function paintMaxed() {
    desk.toggleAttribute('data-maxed', Boolean(maxed));
    for (const [module, node] of nodes) {
      paintMax(module, node);
      if (shown.has(module)) node.inert = Boolean(maxed) && module !== maxed;
    }
  }

  /**
   * `module`'s window over the whole desk, or (null) the maximized one back to its place. Asked for
   * (`fade`), its box grows or shrinks there while what it showed fades into what it shows, each
   * at its own size and never stretched (a view transition, windows.css). Otherwise, or where the
   * browser has none, it slides and grows there as on a trade of places: the module is paused while
   * it moves, as while a bar resizes it, and drawn at its new size once there.
   */
  function maximize(module, { fade = true } = {}) {
    const next = module && shown.has(module) && screen !== 'narrow' && shown.size > 1 ? module : null;
    if (next === maxed) return;
    gesture?.cancel();
    const moving = next ?? maxed;
    const node = nodes.get(moving);
    if (fade && node && motion() && crossfade(node, next)) return;
    const first = motion() && node ? new Map([[moving, node.getBoundingClientRect()]]) : null;
    maxed = next;
    paintMaxed();
    if (next) focus(next);
    if (!first) return;
    // Going back it is still over the others until it is in its place.
    node.style.zIndex = '6';
    onPause(moving, true, { resizing: true });
    flip(first, { duration: MAX_MS, easing: SPRING, paced: true });
    win.setTimeout?.(() => {
      node.style.zIndex = '';
      onPause(moving, false, { resizing: true });
    }, MAX_MS);
  }

  /**
   * maximize()'s view transition: the browser draws the window as it was and as it will be, and
   * moves its box from one to the other with both pictures in it, unscaled (windows.css
   * `cw-win-max`); the others fade with the rest of the page. False where there are none.
   */
  function crossfade(node, next) {
    const doc = desk.ownerDocument;
    if (typeof doc?.startViewTransition !== 'function') return false;
    const root = doc.documentElement;
    const mine = ++fades;
    for (const other of nodes.values()) other.style.viewTransitionName = '';
    node.style.viewTransitionName = 'cw-win-max';
    root.setAttribute('data-cw-max-fade', '');
    maxed = next;
    let fading;
    try {
      fading = doc.startViewTransition(() => {
        paintMaxed();
        if (next) focus(next);
      });
    } catch {
      node.style.viewTransitionName = '';
      root.removeAttribute('data-cw-max-fade');
      paintMaxed();
      if (next) focus(next);
      return true;
    }
    fading.finished.catch(() => {}).then(() => {
      if (mine !== fades) return;   // a newer one has them
      node.style.viewTransitionName = '';
      root.removeAttribute('data-cw-max-fade');
    });
    return true;
  }

  /** Puts every window where the layout says: grid placement only, nothing moves in the document. */
  function apply({ save = true, keep = layout } = {}) {
    const place = placement(layout, screen);
    desk.style.gridTemplateColumns = place.columns;
    for (const [name, value] of Object.entries(place.vars)) desk.style.setProperty(name, value);
    const now = new Set(place.wins.map((spot) => spot.module));
    for (const module of [...shown]) if (!now.has(module)) hide(module);
    for (const spot of place.wins) {
      const node = nodeOf(spot.module);
      node.style.gridColumn = String(spot.column);
      node.style.gridRow = '1';
      if (spot.stack) {
        node.setAttribute('data-stack', spot.stack);
        node.style.setProperty('--cw-share', spot.share);
      } else {
        node.removeAttribute('data-stack');
        node.style.removeProperty('--cw-share');
      }
      node.setAttribute('data-focus', String(spot.module === layout.focus));
      if (!shown.has(spot.module)) reveal(spot.module, node);
    }
    drawBars(place.bars);
    drawTabs();
    evict();
    // A change of the windows takes the maximized one back to its place first.
    if (maxed && (!now.has(maxed) || screen === 'narrow' || now.size < 2)) maxed = null;
    paintMaxed();
    if (save) {
      chosen = keep;
      writeLayout(storage, screen, keep);
    }
    announce();
  }

  function hide(module) {
    shown.delete(module);
    const node = nodes.get(module);
    if (!node) return;
    node.hidden = true;
    node.inert = true;
    if (!asleep.has(module)) {
      asleep.add(module);
      onPause(module, true, { hidden: true });
    }
  }

  function reveal(module, node) {
    shown.add(module);
    node.hidden = false;
    node.inert = false;
    if (asleep.delete(module)) onPause(module, false, { hidden: true });
    onShow(module);
  }

  /** More than four mounted: the least recently used that doesn't show goes back to the shell. */
  function evict() {
    for (const module of lruEvict(recent.filter((m) => nodes.has(m)), shown, maxMounted)) {
      nodes.delete(module);
      asleep.delete(module);
      recent = recent.filter((m) => m !== module);
      onEvict(module);
    }
  }

  function announce() {
    if (!layout.focus || layout.focus === told) return;
    told = layout.focus;
    onFocus(layout.focus);
  }

  function drawBars(list) {
    while (bars.length < list.length) {
      const bar = el('div', { class: 'cw-bar', role: 'separator', tabindex: '0', 'aria-valuemin': '0', 'aria-valuemax': '100' });
      desk.append(bar);
      bars.push(bar);
    }
    bars.forEach((bar, i) => {
      const spec = list[i];
      bar.hidden = !spec;
      if (!spec) return;
      const col = layout.cols[spec.at];
      const value = spec.axis === 'row' ? rowShare(col.h) : col.w / (col.w + layout.cols[spec.at + 1].w);
      bar.setAttribute('data-axis', spec.axis);
      bar.setAttribute('data-at', String(spec.at));
      bar.setAttribute('aria-orientation', spec.axis === 'col' ? 'vertical' : 'horizontal');
      bar.setAttribute('aria-label', t(spec.axis === 'col' ? 'kit.windows.resizeColumns' : 'kit.windows.resizeRows'));
      bar.setAttribute('aria-valuenow', String(Math.round(value * 100)));
      bar.style.gridColumn = String(spec.column);
      bar.style.gridRow = '1';
      if (spec.axis === 'row') bar.style.setProperty('--cw-share', `var(--cw-row-${spec.at + 1})`);
      else bar.style.removeProperty('--cw-share');
    });
  }

  /** The tabs there are: the modules in the rail's order, then any other with a window. */
  const tabModules = () => [...new Set([...available(), ...nodes.keys(), ...modulesOf(layout)])];

  /** A phone's bar of modules, made the first time the screen is narrow (and hidden by CSS on any other). */
  function drawTabs() {
    if (screen !== 'narrow' && !tabs) return;
    if (!tabs) {
      tabs = el('nav', { class: 'cw-tabs', 'aria-label': t('kit.windows.tabs') });
      desk.append(tabs);
    }
    const list = tabModules();
    if (list.join() !== tabsKey) {
      tabsKey = list.join();
      clear(tabs);
      // Each tab knows its module by `data-tab`: on `data-module` the module's own sheet applied
      // to it as to its window, and it took that window's type and background.
      for (const module of list) {
        const icon = iconOf(module);
        tabs.append(el('button', { type: 'button', class: 'cw-tabs__tab', 'data-tab': module },
          icon ? el('img', { src: icon, alt: '' }) : null, el('span', { text: nameOf(module) })));
      }
    }
    for (const tab of tabs.children) tab.setAttribute('aria-current', String(tab.getAttribute('data-tab') === layout.focus));
  }

  /* ----------------------------------- moving ----------------------------------- */

  /** Each shown window's box, read once: the "first" of a FLIP. */
  function boxes() {
    return new Map([...shown].map((module) => [module, nodes.get(module).getBoundingClientRect()]));
  }

  /** From the boxes they had to where they are: each window slides (and grows) into place. */
  function flip(first, { skip = null, duration = FLIP_MS, easing = EASE, paced = false } = {}) {
    for (const module of shown) {
      if (module === skip) continue;
      const from = first.get(module);
      const node = nodes.get(module);
      if (!from || !node.animate) continue;
      const to = node.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      const sx = to.width ? from.width / to.width : 1;
      const sy = to.height ? from.height / to.height : 1;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
      slide(node, `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, { duration, easing, paced });
    }
  }

  /**
   * A window slides from `from` (a transform off its place) to its place. `paced`: its clock is
   * ours, moved on every frame by the time since the last one but never by more than a frame's
   * worth. Handing a slide to the browser's own clock, the frame that lays the windows out in
   * their new places and draws them again (100–200 ms on a slow machine) ran on the clock, and a
   * good part of the slide was never seen: it looked like a jump.
   */
  function slide(node, from, { duration = REFLOW_MS, easing = SPRING, paced = false } = {}) {
    const frames = [{ transform: from, transformOrigin: '0 0' }, { transform: 'none', transformOrigin: '0 0' }];
    const animation = node.animate?.(frames, { duration, easing, fill: paced ? 'both' : 'none' });
    if (!paced || !animation) return;
    animation.pause();
    animation.currentTime = 0;
    let time = 0;
    let last = null;
    const step = (now) => {
      if (animation.playState === 'idle') return;   // stopped by a newer change (sliding)
      const at = now ?? (last ?? 0) + FRAME_MS;
      time += last == null ? 0 : Math.min(at - last, MAX_STEP_MS);
      last = at;
      if (time >= duration) { animation.cancel(); return; }   // in its place: nothing left to hold
      animation.currentTime = time;
      raf(step);
    };
    raf(step);
  }

  /**
   * Where a window still sliding is seen, off its place (`[x, y]`), its slide stopped there so the
   * next one starts from it; `[0, 0]` for one at rest. Read once per change, never per frame.
   */
  function sliding(node) {
    const running = node?.getAnimations?.() || [];
    if (!running.length) {
      // Pushed aside by a carried window coming over it (an inline translate): it goes on from there.
      const pushed = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(node?.style?.transform || '');
      if (!pushed) return [0, 0];
      node.style.transform = '';
      return [Number(pushed[1]), Number(pushed[2])];
    }
    let offset = [0, 0];
    try {
      const matrix = new DOMMatrixReadOnly(win.getComputedStyle(node).transform);
      offset = [matrix.e, matrix.f];
    } catch { /* no matrix: it starts from its place */ }
    for (const animation of running) animation.cancel();
    return offset;
  }

  /** A new layout, the windows sliding from where they were (outside any gesture's loop); `keep` is what is kept. */
  function relayout(next, keep) {
    if (maxed) maximize(null, { fade: false });
    const first = motion() ? boxes() : null;
    layout = normalizeLayout(next);
    apply({ keep: keep ?? layout });
    if (first) flip(first);
  }

  /** Each column's box, measured once when a window is picked up: the slots it may go to. */
  function measureSlots() {
    return layout.cols.map((col) => {
      const rects = col.wins.map((module) => nodes.get(module).getBoundingClientRect());
      return {
        left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)),
        top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)),
      };
    });
  }

  /**
   * The head of a window picks it up; whatever is a control inside it doesn't. Called by the desk
   * for any `.cw-win__head` (the shell may call it too: a second call for the same press is ignored).
   */
  function grab(ev, node) {
    if (gesture || maxed || screen === 'narrow' || ev.button || ev.isPrimary === false) return;
    if (ev.target?.closest?.(CONTROLS)) return;
    const module = node?.getAttribute?.('data-win');
    if (!module || !shown.has(module) || shown.size < 2) return;
    const head = ev.target?.closest?.('.cw-win__head') || node;
    head.setPointerCapture?.(ev.pointerId);
    const own = new AbortController();
    const on = { signal: own.signal };
    const start = layout;
    const was = chosen;
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    let x = x0;
    let y = y0;
    let picked = false;
    let frame = 0;
    let slots = null;
    let desked = null;
    let home = null;
    let hit = null;
    let ghost = null;
    let animate = true;
    let dir = false;
    // The windows in sight while it lasts: a window moved into a column of another width would
    // otherwise draw itself again to that width in the middle of the gesture (a Gantt, a graph).
    let held = [];

    const pick = () => {
      picked = true;
      held = [...shown];
      for (const m of held) onPause(m, true, { resizing: true });
      // Each window on its own layer while it lasts: the ones pushed aside move every frame.
      for (const m of held) nodes.get(m).style.willChange = 'transform';
      // Measured once: where each column is, which reordering doesn't change (each place keeps its width).
      slots = measureSlots();
      desked = desk.getBoundingClientRect();
      home = placeOf(module);
      animate = motion();
      dir = rtl();
      ghost = el('div', { class: 'cw-drop', 'aria-hidden': 'true', hidden: true });
      desk.append(ghost);
      node.setAttribute('data-carried', '');
      node.style.willChange = 'transform';
      desk.setAttribute('data-reordering', '');
      onGesture(true, 'reorder');
    };

    /** Where a window's place starts in the layout as it is now, by the slots measured: no reading. */
    const placeOf = (m) => {
      const at = where(layout, m);
      const s = slots[at.col];
      const col = layout.cols[at.col];
      const top = col.wins.length < MAX_STACK || at.row === 0
        ? s.top
        : s.top + (s.bottom - s.top - BAR_PX) * rowShare(col.h) + BAR_PX;
      return { left: s.left, top };
    };

    /** A window's place in `lay` as a box, by the slots measured: where it is, and its size. */
    const boxOf = (m, lay = layout) => {
      const at = where(lay, m);
      const s = slots[at.col];
      const col = lay.cols[at.col];
      const full = s.bottom - s.top;
      if (col.wins.length < MAX_STACK) return { left: s.left, top: s.top, width: s.right - s.left, height: full };
      const upper = (full - BAR_PX) * rowShare(col.h);
      return at.row === 0
        ? { left: s.left, top: s.top, width: s.right - s.left, height: upper }
        : { left: s.left, top: s.top + upper + BAR_PX, width: s.right - s.left, height: full - upper - BAR_PX };
    };

    /**
     * The window the carried one is coming over, as magnets: the one it covers the most, among
     * those it could trade places with now (columns of one each, or a window of a column of two),
     * how much of it it covers (0–1), and the layout once they trade.
     */
    const coming = (seen) => {
      const at = where(layout, module);
      let best = null;
      for (const m of shown) {
        if (m === module) continue;
        const other = where(layout, m);
        const col = layout.cols[other.col];
        const b = boxOf(m);
        let next = null;
        if (col.wins.length >= MAX_STACK) {
          // Of a column of two, the one at the pointer's height (it may still be in its own column).
          const upper = boxOf(col.wins[0]);
          const row = y < upper.top + upper.height + BAR_PX / 2 ? 0 : 1;
          if (other.row !== row) continue;
          next = swapWindows(layout, module, m);
        } else if (layout.cols[at.col].wins.length === 1 && other.col !== at.col) {
          next = moveColumn(layout, at.col, other.col);
        }
        if (!next) continue;
        const w = Math.min(seen.left + seen.width, b.left + b.width) - Math.max(seen.left, b.left);
        const h = Math.min(seen.top + seen.height, b.top + b.height) - Math.max(seen.top, b.top);
        // A column of one is the whole height: only how far across it counts.
        const across = w > 0 ? w / b.width : 0;
        const down = h > 0 ? Math.min(1, h / b.height) : 0;
        const covered = col.wins.length >= MAX_STACK ? across * down : across;
        if (covered > (best?.covered ?? 0)) best = { module: m, covered, next };
      }
      return best;
    };

    /** The windows pushed aside, and by how much: each a part of its way to its place in `next`. */
    const pushed = new Set();
    const push = (target) => {
      const moved = new Set();
      if (target && animate) {
        const p = Math.min(1, target.covered / COMMIT);
        const share = PUSH * p * p * (3 - 2 * p);   // eased: it gives way softly, then more
        for (const m of shown) {
          if (m === module) continue;
          const node = nodes.get(m);
          if (node.getAnimations?.().length) continue;   // still sliding from the last change
          const from = boxOf(m);
          const to = boxOf(m, target.next);
          const dx = (to.left - from.left) * share;
          const dy = (to.top - from.top) * share;
          if (!dx && !dy) continue;
          node.style.transform = `translate(${dx}px, ${dy}px)`;
          moved.add(m);
        }
      }
      for (const m of pushed) if (!moved.has(m) && nodes.get(m)) nodes.get(m).style.transform = '';
      pushed.clear();
      for (const m of moved) pushed.add(m);
    };

    /**
     * The layout changes while the window is carried, and the others flow to their new places
     * (FLIP from the places they had, with no reading), as a phone's icons make room.
     */
    const liveTo = (next) => {
      const before = new Map([...shown].map((m) => [m, placeOf(m)]));
      // A window still sliding from the last change goes on from where it is seen, not from its place.
      const drift = new Map([...shown].filter((m) => m !== module).map((m) => [m, sliding(nodes.get(m))]));
      layout = next;
      apply({ save: false });
      if (!animate) return;
      for (const m of shown) {
        if (m === module) continue;
        const was = before.get(m);
        const now = placeOf(m);
        const [ox, oy] = drift.get(m) || [0, 0];
        const dx = was.left - now.left + ox;
        const dy = was.top - now.top + oy;
        if (dx || dy) slide(nodes.get(m), `translate(${dx}px, ${dy}px)`, { paced: true });
      }
    };

    let traded = null;   // the window it last traded places with: trading back asks for more
    const paint = () => {
      frame = 0;
      hit = slotAt(slots, layout, x, y);
      // Over the top or bottom part of a column of one it would stack there: nothing gives way.
      const stacking = hit?.zone === 'top' || hit?.zone === 'bottom';
      const seenAt = (lay) => {
        const own = boxOf(module, lay);
        return { ...own, left: own.left + x - x0 + (home.left - placeOf(module).left), top: own.top + y - y0 + (home.top - placeOf(module).top) };
      };
      let target = stacking ? null : coming(seenAt(layout));
      // The one it just traded places with is behind it: it isn't pushed, it only trades back.
      if (target?.module === traded && target.covered < COMMIT_BACK) target = null;
      // Like magnets: the window it comes over gives way as it covers it, and past half they trade
      // places, the other sliding on from where it was pushed to (FLIP, liveTo).
      if (target && target.covered >= (target.module === traded ? COMMIT_BACK : COMMIT)) {
        traded = target.module;
        liveTo(target.next);
        pushed.clear();
        target = null;
      }
      push(target);
      // Its own place moved under it: the transform takes that back.
      const now = placeOf(module);
      const dx = x - x0 + (home.left - now.left);
      const dy = y - y0 + (home.top - now.top);
      node.style.transform = `translate(${dx}px, ${dy}px)`;
      const box = target ? null : dropRect(slots, layout, module, hit, { maxCols: fitColumns(room), rtl: dir });
      ghost.hidden = !box;
      if (box) {
        ghost.style.transform = `translate(${box.left - desked.left}px, ${box.top - desked.top}px)`;
        ghost.style.width = `${box.width}px`;
        ghost.style.height = `${box.height}px`;
      }
    };

    const move = (e) => {
      x = e.clientX;
      y = e.clientY;
      if (!picked) {
        if (Math.hypot(x - x0, y - y0) < PICK_PX) return;
        pick();
      }
      frame ||= raf(paint);
    };

    const finish = (cancelled) => {
      own.abort();
      // Let go before the last move was painted: where it is let go is where it lands.
      if (frame && picked && !cancelled) {
        cancelFrame(frame);
        paint();
      }
      cancelFrame(frame);
      gesture = null;
      if (!picked) return;
      ghost.remove();
      // Let go over the window it just traded places with (the pointer is still over its old
      // place), what the magnets did stays; over another, it goes there as before.
      const col = layout.cols[hit?.col];
      const under = hit?.zone === 'win' ? col?.wins[hit.row] : hit?.zone === 'head' && col?.wins.length === 1 ? col.wins[0] : null;
      const kept = under && (under === traded || under === module);
      const next = cancelled ? start : (hit && !kept && dropLayout(layout, module, hit, { maxCols: fitColumns(room) })) || layout;
      // Read before anything changes: the carried window where it was let go, the others where they are.
      const first = animate ? boxes() : null;
      node.style.transform = '';
      for (const m of held) if (nodes.get(m)) nodes.get(m).style.willChange = '';
      // Those pushed aside go to their places from where they are seen (in `first`).
      for (const m of pushed) if (nodes.get(m)) nodes.get(m).style.transform = '';
      pushed.clear();
      node.removeAttribute('data-carried');
      desk.removeAttribute('data-reordering');
      layout = normalizeLayout(next);
      apply(cancelled ? { keep: was } : {});
      // It settles into its place the way the others made room for it.
      if (first) flip(first, { duration: REFLOW_MS, easing: SPRING, paced: true });
      // Resumed once they are in their places: each draws itself once, at its new width.
      for (const m of held) if (shown.has(m)) onPause(m, false, { resizing: true });
      onGesture(false, 'reorder');
    };
    const key = (e) => {
      if (e.key !== 'Escape' || !picked) return;
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    };
    head.addEventListener('pointermove', move, on);
    head.addEventListener('pointerup', () => finish(false), on);
    head.addEventListener('pointercancel', () => finish(true), on);
    win.addEventListener?.('keydown', key, { capture: true, signal: own.signal });
    gesture = { kind: 'reorder', cancel: () => finish(true) };
  }

  /* ---------------------------------- resizing ---------------------------------- */

  /**
   * What a bar moves, measured once: `at(offset)` the share for the pointer `offset` px from where
   * it started, `write(share)` its CSS variables, `commit(share)` the layout with it.
   */
  function spanOf(bar) {
    const at = Number(bar.getAttribute('data-at'));
    const col = layout.cols[at];
    if (bar.getAttribute('data-axis') === 'row') {
      if (col?.wins.length !== 2) return null;
      const [top, bottom] = col.wins.map((m) => nodes.get(m).getBoundingClientRect());
      const split = top.bottom + BAR_PX / 2;
      return {
        axis: 'row', modules: col.wins, length: bottom.bottom - top.top - BAR_PX,
        at: (offset) => rowShareAt({ top: top.top, height: bottom.bottom - top.top, y: split + offset }),
        write: (h) => desk.style.setProperty(`--cw-row-${at + 1}`, String(h)),
        commit: (h) => withRow(layout, at, h),
        even: () => withRow(layout, at, 0.5),
      };
    }
    const next = layout.cols[at + 1];
    if (!col || !next) return null;
    const a = nodes.get(col.wins[0]).getBoundingClientRect().width;
    const b = nodes.get(next.wins[0]).getBoundingClientRect().width;
    const total = col.w + next.w;
    const sign = rtl() ? -1 : 1;
    return {
      axis: 'col', modules: [...col.wins, ...next.wins], length: a + b,
      at: (offset) => shareAfter({ a, b, total, dx: offset * sign }),
      write: (w) => {
        desk.style.setProperty(`--cw-col-${at + 1}`, `${w}fr`);
        desk.style.setProperty(`--cw-col-${at + 2}`, `${round(total - w)}fr`);
      },
      commit: (w) => withShares(layout, at, w, total - w),
      even: () => normalizeLayout({ ...layout, cols: layout.cols.map((c) => ({ ...c, w: 1 })) }),
    };
  }

  function resize(ev, bar) {
    if (gesture || ev.button || ev.isPrimary === false) return;
    const span = spanOf(bar);
    if (!span) return;
    ev.preventDefault();
    bar.setPointerCapture?.(ev.pointerId);
    const own = new AbortController();
    const on = { signal: own.signal };
    const from = span.axis === 'col' ? ev.clientX : ev.clientY;
    let pos = from;
    let frame = 0;
    let value = null;
    const was = chosen;
    for (const module of span.modules) onPause(module, true, { resizing: true });
    desk.setAttribute('data-resizing', '');
    onGesture(true, 'resize');
    const paint = () => {
      frame = 0;
      value = span.at(pos - from);
      span.write(value);
    };
    const move = (e) => {
      pos = span.axis === 'col' ? e.clientX : e.clientY;
      frame ||= raf(paint);
    };
    const finish = (cancelled) => {
      own.abort();
      cancelFrame(frame);
      gesture = null;
      desk.removeAttribute('data-resizing');
      if (!cancelled && value != null) layout = span.commit(value);
      apply(cancelled || value == null ? { keep: was } : {});
      for (const module of span.modules) onPause(module, false, { resizing: true });
      onGesture(false, 'resize');
    };
    const key = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    };
    bar.addEventListener('pointermove', move, on);
    bar.addEventListener('pointerup', () => finish(false), on);
    bar.addEventListener('pointercancel', () => finish(false), on);
    win.addEventListener?.('keydown', key, { capture: true, signal: own.signal });
    gesture = { kind: 'resize', cancel: () => finish(true) };
  }

  /** An arrow key on a focused bar: 5 % of what it divides, each side still at its minimum. */
  function nudge(bar, key) {
    const span = spanOf(bar);
    const step = span && ({ col: { ArrowLeft: -1, ArrowRight: 1 }, row: { ArrowUp: -1, ArrowDown: 1 } })[span.axis][key];
    if (!step) return false;
    layout = span.commit(span.at(step * span.length * KEY_STEP));
    apply();
    return true;
  }

  /* ----------------------------------- phones ----------------------------------- */

  /** The mounted module beside the focused one in the tabs' order, `step` away. */
  function beside(step) {
    const list = tabModules().filter((m) => nodes.has(m));
    const i = list.indexOf(layout.focus);
    return i < 0 ? null : list[i + step] ?? null;
  }

  /**
   * Whether `target`, or what holds it in the window `node`, slides sideways itself: a box with
   * more to show across (Next's line, a row of chips) or one that says sideways pans are its own
   * (`touch-action: pan-x`, the whole Gantt). Martin, in Work installed on an iPhone: the line of
   * Next moved and came back instead of showing what came before, and swiping the Gantt took him
   * to another module. A finger there is the box's, wherever it is in it.
   */
  function slidesSideways(target, node) {
    for (let at = target; at && at !== node; at = at.parentElement) {
      const style = win.getComputedStyle?.(at);
      if (/\bpan-x\b/.test(style?.touchAction ?? '')) return true;
      const overflow = style?.overflowX;
      if ((overflow === 'auto' || overflow === 'scroll') && at.scrollWidth > at.clientWidth + 1) return true;
    }
    return false;
  }

  /** A sideways swipe on a phone's window: the module beside it comes in, as its tab would bring it. */
  function swipe(ev) {
    if (gesture || ev.pointerType === 'mouse' || ev.isPrimary === false) return;
    const node = nodes.get(layout.focus);
    const target = ev.target;
    if (!node || !node.contains(target) || target.closest?.(EDITABLE) || target.closest?.('[data-drawer]')) return;
    // Martin, #47: a swipe on a task's row deleted the task and brought the next module in too.
    if (target.closest?.(OWN_SWIPE)) return;
    if (globalThis.document?.documentElement?.hasAttribute('data-kit-dragging')) return;
    if (ev.clientX < SWIPE_EDGE || ev.clientX > (win.innerWidth ?? Infinity) - SWIPE_EDGE) return;
    if (slidesSideways(target, node)) return;
    const own = new AbortController();
    const on = { signal: own.signal };
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    const t0 = ev.timeStamp ?? 0;
    let x = x0;
    let y = y0;
    let at = t0;
    let armed = false;
    let frame = 0;
    let dir = false;
    let ends = { next: null, previous: null };
    const forward = (dx) => (dx < 0) !== dir;   // a finger going left brings the next tab (right to left, the other way)
    const holds = (touch) => swipeHolds(touch, { x0, y0, armed });
    const paint = () => {
      frame = 0;
      const dx = x - x0;
      // With nothing that way the window gives a little, and comes back.
      const free = forward(dx) ? ends.next : ends.previous;
      node.style.transform = `translateX(${free ? dx : dx * 0.3}px)`;
    };
    const move = (e) => {
      if (e.pointerId !== ev.pointerId) return;
      x = e.clientX;
      y = e.clientY;
      at = e.timeStamp ?? at;
      if (!armed) {
        if (Math.hypot(x - x0, y - y0) < SWIPE_ARM) return;
        // Held still first, it is a row being picked up; more up than across, a scroll.
        if (at - t0 > SWIPE_HOLD_MS || Math.abs(x - x0) < Math.abs(y - y0) * 1.2) { end(false); return; }
        armed = true;
        dir = rtl();
        ends = { next: beside(1), previous: beside(-1) };
        node.style.willChange = 'transform';
        desk.setAttribute('data-swiping', '');
        onGesture(true, 'swipe');
      }
      frame ||= raf(paint);
    };
    const end = (commit) => {
      own.abort();
      cancelFrame(frame);
      gesture = null;
      if (!armed) return;
      const dx = x - x0;
      const quick = Math.abs(dx) / Math.max(1, at - t0) > SWIPE_FLICK && Math.abs(dx) > SWIPE_ARM * 3;
      const far = Math.abs(dx) > Math.min(90, (Number.isFinite(room) ? room : 360) * 0.25);
      const next = commit && (far || quick) ? (forward(dx) ? ends.next : ends.previous) : null;
      const from = node.style.transform;
      node.style.transform = '';
      node.style.willChange = '';
      desk.removeAttribute('data-swiping');
      if (next) {
        show(next);
        if (motion()) nodes.get(next)?.animate?.([{ transform: `translateX(${dx < 0 ? 24 : -24}%)`, opacity: 0.4 }, { transform: 'none', opacity: 1 }], { duration: FLIP_MS, easing: EASE });
      } else if (motion() && from) {
        node.animate?.([{ transform: from }, { transform: 'none' }], { duration: FLIP_MS, easing: EASE });
      }
      onGesture(false, 'swipe');
    };
    desk.addEventListener('pointermove', move, on);
    desk.addEventListener('pointerup', (e) => { if (e.pointerId === ev.pointerId) end(true); }, on);
    desk.addEventListener('pointercancel', (e) => { if (e.pointerId === ev.pointerId) end(false); }, on);
    gesture = { kind: 'swipe', cancel: () => end(false), holds };
  }

  /* ---------------------------------- listening ---------------------------------- */

  // A sideways finger in a module's list was the browser's: a scroller lets it pan every way again,
  // whatever the desk's `touch-action` says, and it took the gesture (pointercancel) before the
  // swipe could, so only Tasks, whose lists say `pan-y`, swiped (Martin, #47). The swipe keeps the
  // touch's moves from it instead, as the frame keeps the screen's edges (shell.js); the frame
  // already hears every touchmove that way, so nothing scrolls later than it did.
  desk.addEventListener('touchmove', (ev) => {
    if (gesture?.kind !== 'swipe' || ev.touches?.length !== 1 || !gesture.holds(ev.touches[0])) return;
    if (ev.cancelable !== false) ev.preventDefault();
  }, { passive: false, signal });

  // Whatever is touched or reached with the keyboard inside a window gives it the focus.
  desk.addEventListener('pointerdown', (ev) => {
    const module = moduleAt(ev.target);
    if (module) focus(module);
  }, { capture: true, signal });
  desk.addEventListener('focusin', (ev) => {
    const module = moduleAt(ev.target);
    if (module) focus(module);
  }, { signal });
  desk.addEventListener('pointerdown', (ev) => {
    const bar = ev.target?.closest?.('.cw-bar');
    if (bar && bars.includes(bar)) { resize(ev, bar); return; }
    const head = ev.target?.closest?.('.cw-win__head');
    const module = head && moduleAt(head);
    if (module) { grab(ev, nodes.get(module)); return; }
    if (screen === 'narrow') swipe(ev);
  }, { signal });
  desk.addEventListener('dblclick', (ev) => {
    const bar = ev.target?.closest?.('.cw-bar');
    const span = bar && bars.includes(bar) && !gesture ? spanOf(bar) : null;
    if (span) { relayout(span.even()); return; }
    const head = ev.target?.closest?.('.cw-win__head');
    const module = head && !ev.target.closest(CONTROLS) && moduleAt(head);
    if (module && !gesture) maximize(maxed === module ? null : module);
  }, { signal });
  desk.addEventListener('click', (ev) => {
    const max = ev.target?.closest?.('.cw-win__max');
    const module = max && moduleAt(max);
    if (module) { maximize(maxed === module ? null : module); return; }
    const tab = ev.target?.closest?.('.cw-tabs__tab');
    if (tab && tabs?.contains(tab)) show(tab.getAttribute('data-tab'));
  }, { signal });
  desk.addEventListener('keydown', (ev) => {
    if (gesture || ev.defaultPrevented) return;
    const bar = ev.target?.closest?.('.cw-bar');
    if (bar && bars.includes(bar)) {
      if (nudge(bar, ev.key)) ev.preventDefault();
      return;
    }
    if (!ev.altKey || ev.ctrlKey || ev.metaKey || !String(ev.key).startsWith('Arrow')) return;
    const head = ev.target?.closest?.('.cw-win__head');
    const module = head && moduleAt(head);
    if (!module) return;
    ev.preventDefault();
    if (screen === 'narrow') {
      const step = { ArrowLeft: -1, ArrowRight: 1 }[ev.key] * (rtl() ? -1 : 1);
      const next = step ? beside(step) : null;
      if (next) show(next);
      return;
    }
    const next = moveByKey(layout, module, ev.key, { rtl: rtl() });
    if (next) relayout(next);
  }, { signal });

  /** The window grew or shrank: another screen class has its own layout, and fewer columns may fit. */
  win.addEventListener?.('resize', () => {
    resizing ||= raf(() => {
      resizing = 0;
      const now = screenClass(win.innerWidth ?? Infinity);
      room = measure();
      if (now !== screen) {
        gesture?.cancel();
        screen = now;
        desk.setAttribute('data-screen', now);
        const want = (now === 'narrow' ? null : readLayout(storage, now, allowed())) ?? chosen;
        layout = arrange(want);
        apply({ keep: want });
      } else if (screen !== 'narrow') {
        // Squeezed into fewer columns, it is kept as it was chosen, and comes back when there is room again.
        const next = arrange(chosen);
        if (JSON.stringify(next.cols) !== JSON.stringify(layout.cols)) {
          gesture?.cancel();
          layout = next;
          apply({ save: false });
        }
      }
    });
  }, { signal });

  /* ------------------------------------ what it does ----------------------------------- */

  function set(next) {
    gesture?.cancel();
    room = measure();
    const want = normalizeLayout(next, allowed());
    layout = arrange(want);
    apply({ keep: want });
  }

  /** The layout kept for this screen class, or `fallback` when there is none. */
  function restore(fallback) {
    set(readLayout(storage, screen, allowed()) ?? fallback ?? { cols: [] });
  }

  /** The rail's choice of columns (1–4 or '2x2'), with the modules shown now and then `list`'s. */
  function columns(n, list = available()) {
    gesture?.cancel();
    room = measure();
    const want = applyColumns(n, list, layout);
    relayout(arrange(want), want);
  }

  /**
   * `module`'s window in view and focused: where it is, or in the place of `instead` (by default
   * the focused window). With one column, or on a phone, it is a switch.
   */
  function show(module, { instead } = {}) {
    if (!module) return;
    if (shown.has(module)) { focus(module); return; }
    gesture?.cancel();
    // It comes in under the maximized window: that one goes back to its place for it to be seen.
    if (maxed) maximize(null, { fade: false });
    let next;
    if (screen === 'narrow' || !layout.cols.length) {
      next = { cols: [{ w: 1, wins: [module] }], focus: module };
    } else {
      next = copy(layout);
      const spot = where(next, shown.has(instead) ? instead : next.focus) ?? { col: 0, row: 0 };
      next.cols[spot.col].wins[spot.row] = module;
      next.focus = module;
    }
    recent = lruTouch(recent, module);
    layout = normalizeLayout(next);
    apply();
  }

  /**
   * A module the person no longer uses (turned off in Settings › Modules): its window leaves the
   * layout, as it shows and as it was chosen, and its tab leaves a phone's bar; the shell gets it
   * back (`onEvict`). The windows that stay take its room; with none left, the first of `modules`.
   * Call it once `modules` no longer lists it.
   */
  function drop(module) {
    if (!nodes.has(module) && !where(layout, module) && !where(chosen, module)) return;
    gesture?.cancel();
    if (maxed === module) maxed = null;
    const without = (from) => normalizeLayout({
      cols: from.cols.map((col) => ({ ...col, wins: col.wins.filter((m) => m !== module) })),
      focus: from.focus === module ? null : from.focus,
    });
    let want = without(chosen);
    if (!modulesOf(want).length) {
      const first = available().find((m) => m !== module);
      want = normalizeLayout({ cols: first ? [{ w: 1, wins: [first] }] : [] });
    }
    const had = nodes.has(module);
    nodes.delete(module);
    asleep.delete(module);
    recent = recent.filter((m) => m !== module);
    room = measure();
    layout = arrange(want);
    apply({ keep: want });
    if (had) onEvict(module);
  }

  /** The window that has the keyboard (`ctx.active()`); one that doesn't show is shown. */
  function focus(module) {
    if (!shown.has(module)) { show(module); return; }
    // Another window wanted (a link opened in it): the maximized one goes back to its place.
    if (maxed && module !== maxed) maximize(null, { fade: false });
    recent = lruTouch(recent, module);
    if (layout.focus === module) return;
    layout = { ...layout, focus: module };
    for (const m of shown) nodes.get(m).setAttribute('data-focus', String(m === module));
    drawTabs();
    chosen = where(chosen, module) ? { ...chosen, focus: module } : layout;
    writeLayout(storage, screen, chosen);
    announce();
  }

  /** The labels again, in the language now (the shell calls it when the language changes). */
  function relabel() {
    for (const [module, node] of nodes) label(module, node);
    tabs?.setAttribute('aria-label', t('kit.windows.tabs'));
    tabsKey = '';
    drawTabs();
    drawBars(placement(layout, screen).bars);
  }

  /** Every listener off and what it added to the desk gone; the windows are the shell's. */
  function destroy() {
    gesture?.cancel();
    life.abort();
    cancelFrame(resizing);
    for (const bar of bars) bar.remove();
    bars.length = 0;
    tabs?.remove();
    tabs = null;
    desk.removeAttribute('data-screen');
  }

  return {
    get layout() { return layout; },
    get screen() { return screen; },
    /** The mounted modules, the last used first (the shell's choice of a window to reuse). */
    get recent() { return [...recent]; },
    /** The module whose window has the whole desk, or null. */
    get maximized() { return maxed; },
    set, restore, columns, show, focus, drop, grab, maximize, relabel, destroy,
  };
}
