/**
 * The phone's keyboard.
 *
 * On a phone the keyboard does not make the page shorter: it covers its lower
 * part, and the browser slides the whole view up so that what is being typed
 * in stays in sight. The kit's frame (`.kit-app`), Settings and the sheets
 * are fixed to the full screen, so what slides out is their top (the bar, a
 * note's head with its tools, a sheet's title) and what stays under the
 * keyboard is their foot (a sheet's buttons, a notice's Undo). Tasks (its
 * nº60) and Notes (0.8.1) learnt it on the iPhone; this is their fix, for
 * every app.
 *
 * `fitToKeyboard()`: while the keyboard is up, `<html data-kit-keyboard>` with
 * `--kit-view-top` and `--kit-view-h`, the part of the screen left in view
 * (`visualViewport`), which kit.css gives the frame, Settings, the dialogs
 * and the notices. Without a keyboard nothing is touched.
 *
 * `focusOnTap()`: the tap that starts typing in a field focuses it without the
 * browser's slide, so the frame only has to shrink, smoothly.
 */

/** Less than this is the browser's own bars coming and going, not a keyboard. */
const KEYBOARD_MIN = 120;
/** Frames without a change before it stops following the keyboard. */
const SETTLE_FRAMES = 30;
/** How far a finger may move, and for how long it may press, and still be a tap. */
const TAP_SLOP = 10;
const TAP_MS = 500;

/** Inputs that bring up no keyboard. */
const NOT_TYPED = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image', 'hidden']);

/** A field the keyboard comes up for: a text box, a text area or something editable. */
export function typesIn(node) {
  if (!node) return false;
  if (node.isContentEditable || node.tagName === 'TEXTAREA') return true;
  return node.tagName === 'INPUT' && !NOT_TYPED.has(String(node.type || 'text').toLowerCase());
}

/**
 * What to fit to, from what the browser says: `{ top, height }` with the
 * keyboard up, null without. `full` is the frame's height without a keyboard:
 * not `innerHeight` alone, which on the iPhone shrinks with the keyboard too,
 * so the difference came out as nothing. Either sign gives the keyboard away:
 * what is visible is much shorter than the frame, or the browser has slid the
 * view up. A pinch-zoom shrinks the view too and is not a keyboard.
 */
export function keyboardFit({ full, top = 0, height, scale = 1, typing }) {
  if (!typing || scale >= 1.01) return null;
  const fit = { top: Math.round(top), height: Math.round(height) };
  return full - fit.height > KEYBOARD_MIN || fit.top > 0 ? fit : null;
}

/** Whether a finger that went down at `start` and lifted at `end` ({ x, y, at }) tapped. */
export function isTap(start, end) {
  if (!start || !end) return false;
  return Math.hypot(end.x - start.x, end.y - start.y) <= TAP_SLOP && end.at - start.at <= TAP_MS;
}

let started = false;
let revealer = null;
let fitted = '';          // what it is fitted to now ('' = not fitted)
let fittedHeight = 0;
let followFrames = 0;     // frames left to keep following the keyboard

/** The field back in sight when the keyboard takes room: in its own scroller, inside the fitted frame. */
function reveal(field) {
  if (!field || revealer?.(field)) return;
  if (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') field.scrollIntoView({ block: 'nearest' });
}

/** Fits to what is in view, if a keyboard is up. Says whether anything changed. */
function fit() {
  const view = window.visualViewport;
  const root = document.documentElement;
  const field = document.activeElement;
  const now = view && keyboardFit({
    full: Math.max(root.clientHeight, window.innerHeight),
    top: view.offsetTop, height: view.height, scale: view.scale, typing: typesIn(field),
  });
  const state = now ? `${now.top}/${now.height}` : '';
  if (state === fitted) return false;
  // Less room than a moment ago (the keyboard coming up): the field may be under it.
  const shrank = Boolean(now) && (!fitted || now.height < fittedHeight);
  fitted = state;
  fittedHeight = now ? now.height : 0;
  if (now) {
    root.style.setProperty('--kit-view-top', `${now.top}px`);
    root.style.setProperty('--kit-view-h', `${now.height}px`);
    root.dataset.kitKeyboard = 'up';
  } else {
    delete root.dataset.kitKeyboard;
    root.style.removeProperty('--kit-view-top');
    root.style.removeProperty('--kit-view-h');
  }
  if (shrank) reveal(field);
  return true;
}

/**
 * Follows the keyboard frame by frame while it moves: the browser's own events
 * arrive only now and then while it slides in, and fitting on each of them
 * alone moved the frame in jumps. Each event is applied at once too, in case
 * no frame is being drawn.
 */
function follow() {
  if (!followFrames) requestAnimationFrame(step);
  followFrames = SETTLE_FRAMES;
  fit();
}

function step() {
  if (fit()) followFrames = SETTLE_FRAMES;
  followFrames -= 1;
  if (followFrames > 0) requestAnimationFrame(step);
  else followFrames = 0;
}

/**
 * Starts fitting the kit's frame, Settings, dialogs and notices to the part of
 * the screen the keyboard leaves. Once per page; called again, it only takes
 * the new `reveal`.
 *
 * @param {object} [options]
 * @param {(field: Element) => boolean} [options.reveal] puts the caret back in sight when the
 *   keyboard takes room, and says whether it did; without it (or when it says no), a text box
 *   or a text area is scrolled into view. An editor of the app's own (contenteditable) gives
 *   its own, which knows where its caret is and what covers it.
 */
export function fitToKeyboard({ reveal: own = null } = {}) {
  revealer = own;
  if (started || typeof window === 'undefined' || !window.visualViewport) return;
  started = true;
  window.visualViewport.addEventListener('resize', follow);
  window.visualViewport.addEventListener('scroll', follow);
  // The focus can change without the keyboard moving: from one field to another, to a dialog's.
  document.addEventListener('focusin', follow);
  document.addEventListener('focusout', () => setTimeout(follow, 0));
}

/**
 * The tap that starts typing in `area` focuses it with `preventScroll`, asking
 * the phone not to slide the view: then the frame fitted above the keyboard
 * only has to shrink. Left to the browser: a tap while `area` already has the
 * focus (it places the caret), a finger that moves (scrolling), a long press
 * (selecting, pasting), a second finger, and whatever `skip` matches.
 *
 * Only where the caret's place doesn't matter (an empty field to add to) or
 * the app can put it where the finger was (an editor): a text box can't be
 * told where its caret goes.
 *
 * @param {Element} area
 * @param {object} [options]
 * @param {(point: { x: number, y: number }) => boolean} [options.focus] focuses (with the caret
 *   at the point, if it can) and says whether it did; when it says no, the browser's tap goes on.
 *   By default, `area.focus({ preventScroll: true })`.
 * @param {string} [options.skip] a selector of what is the browser's to tap (a checkbox, a link)
 */
export function focusOnTap(area, { focus = null, skip = null } = {}) {
  const focused = () => area.contains(document.activeElement);
  const take = focus || (() => { area.focus({ preventScroll: true }); return true; });
  let start = null;
  area.addEventListener('touchstart', (ev) => {
    const point = ev.touches[0];
    start = ev.touches.length === 1 && !focused() ? { x: point.clientX, y: point.clientY, at: ev.timeStamp } : null;
  }, { passive: true });
  area.addEventListener('touchcancel', () => { start = null; });
  area.addEventListener('touchend', (ev) => {
    const from = start;
    const point = ev.changedTouches[0];
    start = null;
    if (!point || !isTap(from, { x: point.clientX, y: point.clientY, at: ev.timeStamp }) || focused()) return;
    if (skip && ev.target.closest?.(skip)) return;
    if (take({ x: point.clientX, y: point.clientY }) === false) return;
    ev.preventDefault();
  }, { passive: false });
}
