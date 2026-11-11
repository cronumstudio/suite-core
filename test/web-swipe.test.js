/**
 * A finger across a row (web/swipe.js), played by hand over fake elements: how far it goes before
 * it arms each action, one action or two a side, what keeps it from being a swipe (a scroll, a
 * mouse, a drag, a control, the screen's edge), no click after it, the row that only keeps the
 * finger, right to left, and the redraws that wait for it (drag.js redrawInPlace).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom, FakeEventTarget } from './fake-dom.js';

const document = installFakeDom();
const win = Object.assign(new FakeEventTarget(), { innerWidth: 400, innerHeight: 800 });
globalThis.window = win;
// What a row says of itself: its direction, a box that slides sideways.
globalThis.getComputedStyle = (node) => node.computed || {};
// The swipe tells the page with CustomEvents on the document, as drag.js does.
document.dispatchEvent = (event) => {
  document.dispatch(event.type, { detail: event.detail });
  return true;
};
const buzzes = [];
try {
  globalThis.navigator.vibrate = (ms) => buzzes.push(ms);
} catch {
  Object.defineProperty(globalThis, 'navigator', { value: { vibrate: (ms) => buzzes.push(ms) }, configurable: true });
}

const { el } = await import('../web/dom.js');
const { rowSwipe, keepSwipe, trashAction, swipeAction, swipeStretch, SWIPE_IGNORE } = await import('../web/swipe.js');
const { redrawInPlace } = await import('../web/drag.js');

/** An event at `node` heard by it and then by each element above it, as a browser bubbles it. */
function fire(node, type, props = {}) {
  for (let at = node; at; at = at.parentElement) {
    for (const fn of [...(at.listeners[type] || [])]) fn({ type, target: node, currentTarget: at, ...props });
  }
}

/** A finger (or a mouse) down on `target` at (x, y), moved and lifted by hand. */
function finger(target, { x = 200, y = 100, type = 'touch', t0 = 0 } = {}) {
  fire(target, 'pointerdown', { pointerId: 1, pointerType: type, isPrimary: true, clientX: x, clientY: y, timeStamp: t0 });
  let time = t0;
  return {
    to(nx, ny = y, at = (time += 30)) {
      time = at;
      fire(target, 'pointermove', { pointerId: 1, pointerType: type, clientX: nx, clientY: ny, timeStamp: at });
      return this;
    },
    /** Whether the touch's move was kept from the browser. */
    touchmove() {
      let kept = false;
      fire(target, 'touchmove', { cancelable: true, preventDefault: () => { kept = true; } });
      return kept;
    },
    up() { fire(target, 'pointerup', { pointerId: 1, pointerType: type }); },
    cancel() { fire(target, 'pointercancel', { pointerId: 1, pointerType: type }); },
  };
}

/** A task's row: one child that slides (Tasks' `.task-inner`), and what each swipe did. */
function taskRow({ left, right } = {}) {
  const ran = [];
  const star = { label: 'Star', iconName: 'star', tone: 'accent', run: () => ran.push('star') };
  const sun = { label: 'My Day', iconName: 'sun', tone: 'sun', run: () => ran.push('sun') };
  const check = el('button', { class: 'kit-round-check' });
  const title = el('span', { text: 'Milk' });
  const inner = el('div', { class: 'task-inner' }, check, title);
  const row = el('div', { class: 'task-row' }, inner);
  document.body.append(row);
  const swipe = rowSwipe(row, {
    left: left ?? [trashAction(() => ran.push('trash'))],
    right: right ?? (() => [star, sun]),
  });
  return { row, inner, title, check, ran, swipe, star, sun };
}

const bgOf = (row) => row.children.find((node) => node.getAttribute('class') === 'kit-swipe__bg') || null;
const html = document.documentElement;
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

test('to the right, its first action at 82 px and its second at 168, a buzz as each is reached; let go, it runs', async () => {
  const { row, inner, ran, swipe } = taskRow();
  assert.ok(row.hasAttribute('data-own-swipe'), 'the row keeps the finger: Work\'s windows don\'t switch module from it');
  assert.match(row.getAttribute('class'), /\btask-row kit-swipe\b/, 'its own classes kept');
  assert.equal(bgOf(row), null, 'no colour drawn until it is swiped');
  buzzes.length = 0;

  const f = finger(inner);
  f.to(208);
  assert.ok(!html.hasAttribute('data-kit-swiping'), '8 px is nobody\'s yet');
  assert.equal(inner.style.transform, undefined);
  f.to(260);
  const bg = bgOf(row);
  assert.ok(bg, 'past 12 px it is a swipe, and the colour is made');
  assert.equal(row.children[0], bg, 'beneath what slides');
  assert.equal(bg.getAttribute('aria-hidden'), 'true');
  assert.ok(html.hasAttribute('data-kit-swiping'));
  assert.ok(row.hasAttribute('data-swiping'));
  assert.equal(row.getAttribute('data-swipe'), 'under', 'its one child slides, over the colour');
  assert.match(inner.getAttribute('class'), /\bkit-swipe__content\b/);
  assert.equal(inner.style.transform, 'translateX(60px)');
  assert.equal(inner.style.transition, 'none', 'with the finger, not behind it');
  assert.equal(bg.getAttribute('data-side'), 'right');
  assert.equal(bg.getAttribute('data-tone'), null, 'grey until reached');
  assert.equal(bg.textContent, 'Star', 'the first thing it will do, faint');
  assert.equal(bg.querySelector('.kit-swipe__action').hasAttribute('data-armed'), false);

  f.to(290);
  assert.equal(bg.getAttribute('data-tone'), 'accent', 'at 82 px the star');
  assert.ok(bg.querySelector('.kit-swipe__action').hasAttribute('data-armed'));
  assert.equal(bg.querySelector('.kit-swipe__icon').children.length, 1, 'its icon');
  f.to(380);
  assert.equal(bg.getAttribute('data-tone'), 'sun', 'at 168 px My Day');
  assert.equal(bg.textContent, 'My Day');
  f.to(300);
  assert.equal(bg.textContent, 'Star', 'back short of it, the first again');
  assert.deepEqual(buzzes, [8, 8, 8], 'a buzz each time what letting go does changes');
  f.to(260);
  assert.equal(bg.getAttribute('data-tone'), null, 'and nothing short of 82 px');
  assert.equal(buzzes.length, 3, 'no buzz for nothing');
  f.to(300);
  f.up();
  assert.deepEqual(ran, ['star']);
  assert.ok(!html.hasAttribute('data-kit-swiping'));
  assert.ok(!row.hasAttribute('data-swiping'));
  assert.equal(inner.style.transform, '', 'back into place');
  assert.match(inner.style.transition, /^transform 180ms/);
  assert.ok(row.hasAttribute('data-swipe-settling'), 'the colour stays under it on its way back');
  await settle();
  assert.ok(!row.hasAttribute('data-swipe-settling'));
  assert.equal(inner.style.transition, '');

  // Let go short of the first, nothing.
  finger(inner).to(240).to(270).up();
  assert.deepEqual(ran, ['star']);
  // And to the left, the trash at 82 px, in red.
  const g = finger(inner).to(150).to(110);
  assert.equal(bg.getAttribute('data-side'), 'left');
  assert.equal(bg.getAttribute('data-tone'), 'danger');
  assert.equal(bg.textContent, 'kit.delete', 'the kit\'s «Borrar»');
  assert.equal(inner.style.transform, 'translateX(-90px)');
  g.up();
  assert.deepEqual(ran, ['star', 'trash']);
  swipe.destroy();
  row.remove();
});

test('one action a side arms at the first distance; the row comes harder past 230 px; nothing that way, it stays', () => {
  assert.equal(swipeAction(81, ['a', 'b']), null);
  assert.equal(swipeAction(82, ['a', 'b']), 'a');
  assert.equal(swipeAction(168, ['a', 'b']), 'b');
  assert.equal(swipeAction(400, ['a']), 'a', 'one action: reached at the first distance, and kept further');
  assert.equal(swipeAction(400, []), null);
  assert.equal(swipeStretch(200), 200);
  assert.equal(swipeStretch(330), 255, 'a quarter of the finger\'s way past 230');
  assert.equal(swipeStretch(-330), -255);

  const pin = { label: 'Pin', iconName: 'pin', tone: 'accent', run: () => {} };
  const { row, inner, ran } = taskRow({ left: [], right: [{ ...pin, run: () => ran.push('pin') }] });
  const f = finger(inner).to(260).to(400);
  const bg = bgOf(row);
  assert.equal(bg.textContent, 'Pin', 'the one action, far as it goes');
  assert.equal(bg.getAttribute('data-tone'), 'accent');
  f.to(530);
  assert.equal(inner.style.transform, 'translateX(255px)', 'harder past 230 px');
  f.to(100);
  assert.equal(inner.style.transform, 'translateX(0px)', 'nothing to the left: it doesn\'t go that way');
  f.to(300).up();
  assert.deepEqual(ran, ['pin']);

  // Starting to the left, with nothing there: not a swipe at all.
  html.removeAttribute('data-kit-swiping');
  finger(inner).to(150).to(60).up();
  assert.ok(!row.hasAttribute('data-swiping'));
  assert.deepEqual(ran, ['pin']);
  row.remove();
});

test('a scroll, a mouse, the start edge, a control inside it and a row of chips are not a swipe; the row may be a button', () => {
  const { row, inner, title, check, ran } = taskRow();
  const none = () => assert.equal(inner.style.transform ?? '', '', 'it didn\'t move');
  // More down than across first: the list's scroll.
  finger(title).to(205, 120).to(320, 125).up();
  none();
  // A mouse or a trackpad never swipes.
  finger(title, { type: 'mouse' }).to(320).up();
  none();
  // The screen's start edge is the drawer's and going back (shell.js).
  finger(title, { x: 10 }).to(130).up();
  none();
  // The round check and the buttons inside keep their own finger.
  finger(check).to(320).up();
  none();
  // A row of chips that slides sideways keeps scrolling.
  const chips = el('span', { class: 'chips' }, el('span', { text: '#home' }));
  chips.computed = { overflowX: 'auto' };
  chips.scrollWidth = 500;
  chips.clientWidth = 200;
  inner.append(chips);
  finger(chips.children[0]).to(320).up();
  none();
  chips.scrollWidth = 200;
  finger(chips.children[0]).to(320).up();
  assert.deepEqual(ran, ['star'], 'chips that fit are the row\'s');
  assert.ok(SWIPE_IGNORE.includes('.kit-round-check') && SWIPE_IGNORE.includes('[contenteditable="true"]'));
  row.remove();

  // Notes' row is itself a button, with no one child to slide: the row slides, its colour beside it.
  const done = [];
  const note = el('button', { type: 'button', class: 'note-row' }, el('span', { text: 'Plan' }), el('span', { text: 'More' }));
  document.body.append(note);
  rowSwipe(note, { right: () => [{ label: 'Pin', iconName: 'pin', run: () => done.push('pin') }] });
  const f = finger(note.children[1]).to(250).to(300);
  const bg = bgOf(note);
  assert.equal(note.getAttribute('data-swipe'), 'beside');
  assert.equal(note.style.transform, 'translateX(100px)');
  assert.equal(bg.style.left, '-100px', 'in the room it leaves');
  assert.equal(bg.style.width, '100px');
  assert.equal(bg.getAttribute('data-tone'), 'accent', 'the default tone');
  f.to(150);
  assert.equal(note.style.transform, 'translateX(0px)', 'no left action: it stays');
  f.to(300).up();
  assert.deepEqual(done, ['pin']);
  note.remove();
});

test('a drag wins: a finger held still first, or a drag under way, is never a swipe', () => {
  const { row, inner, ran } = taskRow();
  // Held still 400 ms (drag.js picks up at 380), then across: picking it up, not a swipe.
  finger(inner, { t0: 0 }).to(205, 100, 300).to(320, 100, 420).up();
  assert.ok(!row.hasAttribute('data-swiping'));
  // A drag under way.
  html.setAttribute('data-kit-dragging', '');
  finger(inner).to(320).up();
  assert.ok(!row.hasAttribute('data-swiping'));
  html.removeAttribute('data-kit-dragging');
  // One that begins while the finger is still deciding.
  const f = finger(inner).to(208);
  html.setAttribute('data-kit-dragging', '');
  f.to(320).up();
  html.removeAttribute('data-kit-dragging');
  assert.deepEqual(ran, []);
  // Moved at once, it swipes.
  finger(inner, { t0: 0 }).to(260, 100, 60).to(300, 100, 90).up();
  assert.deepEqual(ran, ['star']);
  row.remove();
});

test('letting go after a swipe is not a click, and the browser doesn\'t take its moves; taken away, it does nothing', async () => {
  const { row, inner, title, ran } = taskRow();
  const click = (target) => {
    let stopped = false;
    win.dispatch('click', { target, stopPropagation: () => { stopped = true; }, preventDefault: () => {} });
    return stopped;
  };
  const f = finger(title);
  assert.equal(f.touchmove(), false, 'before it is a swipe the list may scroll');
  f.to(260);
  assert.equal(f.touchmove(), true, 'once it is one, every move is the swipe\'s');
  f.to(300).up();
  assert.equal(click(title), true, 'the release doesn\'t open the row');
  assert.equal(click(title), false, 'and the next tap does');
  // A tap is a click.
  finger(title).up();
  assert.equal(click(title), false);
  // The system takes the touch away midway: back into place, nothing done.
  const g = finger(title).to(260).to(390);
  g.cancel();
  assert.deepEqual(ran, ['star']);
  assert.equal(inner.style.transform, '');
  assert.ok(!html.hasAttribute('data-kit-swiping'));
  await settle();
  row.remove();
});

test('a row with nothing to do keeps the finger; destroy() takes away all it added', () => {
  const quiet = el('div', { class: 'step-row' }, el('span', { text: 'Step' }));
  document.body.append(quiet);
  const kept = keepSwipe(quiet);
  assert.ok(quiet.hasAttribute('data-own-swipe'), 'Work\'s windows leave it alone');
  assert.equal(quiet.getAttribute('class'), 'step-row kit-swipe', 'and pan-y keeps the browser\'s sideways pan off it (kit.css)');
  assert.equal(quiet.listenerCount(), 0, 'nothing to listen for');
  finger(quiet.children[0]).to(320).up();
  assert.equal(bgOf(quiet), null);
  kept.destroy();
  assert.ok(!quiet.hasAttribute('data-own-swipe'));
  assert.equal(quiet.getAttribute('class'), 'step-row');

  const { row, inner, swipe } = taskRow();
  finger(inner).to(300).up();
  assert.ok(bgOf(row));
  swipe.destroy();
  assert.equal(row.listenerCount(), 0);
  assert.equal(bgOf(row), null);
  assert.ok(!row.hasAttribute('data-own-swipe'));
  assert.equal(row.getAttribute('class'), 'task-row');
  assert.equal(inner.getAttribute('class'), 'task-inner');
  finger(inner).to(300).up();
  assert.equal(bgOf(row), null, 'gone for good');
  row.remove();
});

test('right to left it is mirrored: `right` is towards the line\'s end, and the start edge is on the right', () => {
  const { row, inner, ran } = taskRow();
  row.computed = { direction: 'rtl' };
  const f = finger(inner, { x: 300 }).to(240).to(200);
  const bg = bgOf(row);
  assert.equal(bg.getAttribute('data-side'), 'right', 'to the left, towards the end of a right-to-left line');
  assert.equal(bg.getAttribute('data-tone'), 'accent');
  assert.equal(inner.style.transform, 'translateX(-100px)');
  f.up();
  assert.deepEqual(ran, ['star']);
  finger(inner, { x: 380 }).to(300).to(250).up();
  assert.deepEqual(ran, ['star'], 'the start edge is the drawer\'s');
  finger(inner, { x: 100 }).to(160).to(200).up();
  assert.deepEqual(ran, ['star', 'trash'], 'to the right, the trash');
  row.remove();
});

test('while a row is swiped the page says so, and a redraw waits for its end', () => {
  const { row, inner } = taskRow();
  const list = el('div', {}, row);
  document.body.append(list);
  const heard = [];
  const on = (ev) => heard.push([ev.type, ev.detail?.row === row]);
  document.addEventListener('kit-swipestart', on);
  document.addEventListener('kit-swipeend', on);
  const draws = [];
  const f = finger(inner).to(260);
  assert.deepEqual(heard, [['kit-swipestart', true]]);
  assert.equal(redrawInPlace(list, () => draws.push('live')), false, 'not under the finger');
  assert.equal(redrawInPlace(list, () => draws.push('live again')), false);
  f.to(300).up();
  assert.deepEqual(heard, [['kit-swipestart', true], ['kit-swipeend', true]]);
  assert.deepEqual(draws, ['live again'], 'once it is let go, with the last');
  assert.equal(redrawInPlace(list, () => draws.push('after')), true);
  document.removeEventListener('kit-swipestart', on);
  document.removeEventListener('kit-swipeend', on);
  list.remove();
});

test('the kit draws the swipe: the row\'s pans, the colour beneath or beside, and each tone in both themes', () => {
  const css = fs.readFileSync(new URL('../web/kit.css', import.meta.url), 'utf8');
  assert.match(css, /\.kit-swipe \{ position: relative; touch-action: pan-y; \}/);
  assert.match(css, /\.kit-swipe\[data-swiping\] > \.kit-swipe__bg, \.kit-swipe\[data-swipe-settling\] > \.kit-swipe__bg \{ display: flex; \}/);
  assert.match(css, /\.kit-swipe__content \{ position: relative; z-index: 1; \}/);
  assert.match(css, /\.kit-swipe\[data-swipe="beside"\]\[data-swiping\] \{ overflow: visible; \}/);
  assert.match(css, /\.kit-swipe__action \{[^}]*opacity: \.35;/);
  assert.match(css, /\.kit-swipe__action\[data-armed\] \{ opacity: 1; transform: scale\(1\.06\); \}/);
  for (const [tone, colour] of [['danger', 'kit-danger'], ['accent', 'kit-accent'], ['sun', 'kit-now'], ['done', 'kit-ok']]) {
    assert.match(css, new RegExp(`\\.kit-swipe__bg\\[data-tone="${tone}"\\] \\{ background: var\\(--${colour}\\);`), tone);
  }
  assert.match(css, /:root\[data-theme="dark"\] \.kit-swipe__bg:is\(\[data-tone="danger"\], \[data-tone="done"\]\) \{ color: var\(--cr-ink\); \}/);
  const sw = fs.readFileSync(new URL('../web/sw-core.js', import.meta.url), 'utf8');
  assert.match(sw, /'\/suite\/swipe\.js'/, 'kept for offline with the rest of the kit');
});
