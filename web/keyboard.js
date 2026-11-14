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
 *
 * `watchKeyboard()`: when a keyboard does make the page shorter (an app's web
 * view), what is fixed to its foot sits on the keyboard; Work's phone tabs
 * step aside for it (windows.js).
 */

/** Less than this is the browser's own bars coming and going, not a keyboard. */
const KEYBOARD_MIN = 120;
/** How long a page still short, with nothing typed in, waits for its room before it isn't a keyboard. */
const LEAVE_MS = 1000;
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

/**
 * Whether the keyboard has made the page itself shorter: `height` now, against the `tallest` the
 * page has been at this width. An app's web view that stops above the keyboard (Work's iPhone
 * app) and a browser that resizes the page for it do: what is fixed to the page's foot stays in
 * sight, on the keyboard. Safari and Chrome only cover the page (keyboardFit), and what is at its
 * foot is under the keyboard already. Once `up`, it stays up until the page has its room back: the
 * focus leaves as the keyboard starts going down, while the page is still short.
 */
export function keyboardShortens({ tallest, height, typing, up = false }) {
  return (Boolean(typing) || up) && tallest - height > KEYBOARD_MIN;
}

/**
 * Tells `onChange(true)` when the keyboard makes the page shorter (keyboardShortens) and
 * `onChange(false)` when it gives the room back. Not when the focus leaves: that comes first, and
 * what came back then sat a moment over the keyboard going down (Martin's iPhone, 0.226.0). A page
 * still short a second after the focus left, with nothing typed in, isn't a keyboard's.
 * The page's height is its root's (in Safari `innerHeight` shrinks with a keyboard that only
 * covers it), and its tallest is kept for each width, so turning the phone isn't a keyboard. A
 * frame with the focus counts as typing: what has it inside can't be seen from here.
 *
 * @param {(up: boolean) => void} onChange
 * @param {object} [options]
 * @param {Window} [options.win]
 * @param {AbortSignal} [options.signal] stops listening
 * @param {number} [options.leave] how long a page still short waits once nothing is typed in (ms)
 */
export function watchKeyboard(onChange, { win = globalThis, signal, leave = LEAVE_MS } = {}) {
  const doc = win.document ?? globalThis.document;
  const root = doc?.documentElement;
  if (!win.addEventListener || !root || typeof root.clientHeight !== 'number') return;
  const tallest = new Map();
  let up = false;
  let waiting = 0;
  const typing = () => typesIn(doc.activeElement) || doc.activeElement?.tagName === 'IFRAME';
  const tell = (now) => {
    clearTimeout(waiting);
    waiting = 0;
    if (now === up) return;
    up = now;
    onChange(now);
  };
  const check = () => {
    const width = win.innerWidth;
    const height = root.clientHeight;
    const most = Math.max(tallest.get(width) ?? 0, height);
    tallest.set(width, most);
    const now = keyboardShortens({ tallest: most, height, typing: typing(), up });
    if (now && up && !typing()) {
      // Up with nothing typed in: the keyboard going down, its room on its way; if it doesn't come, it wasn't one.
      waiting ||= setTimeout(() => { waiting = 0; if (!typing()) tell(false); }, leave);
      return;
    }
    tell(now);
  };
  signal?.addEventListener?.('abort', () => clearTimeout(waiting));
  check();
  win.addEventListener('resize', check, { signal });
  doc.addEventListener('focusin', check, { signal });
  doc.addEventListener('focusout', () => setTimeout(check, 0), { signal });
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

/* ------------------------------ a sheet on the keyboard ----------------------------- */

/** How a sheet goes up and down with the keyboard: about its time and its curve. */
const RIDE = 'translate .28s cubic-bezier(.38, .7, .125, 1)';
/**
 * Where the last climb a sheet made on this screen is kept (the keyboard's height, less the home
 * bar's): by the page's width and its height with the keyboard down, which stay as they are.
 */
const riseKey = (full) => `cw-keyboard-rise:${window.innerWidth}x${full}`;

/**
 * A sheet that goes up and down with the keyboard in Work's iPhone app, top and bottom together
 * (ui.js formDialog `typing`; Work's shell had it for its Feedback alone, audit of 6/11, sc-shell-19).
 * There the web view ends where the keyboard starts, and the page takes about a second to be laid
 * out at its new size while the keyboard comes up in a quarter of one: a sheet left to the layout
 * climbed in jumps, or stayed behind the keyboard, and grew taller (Martin's iPhone, 0.73.0–0.74.2).
 *
 * So while the keyboard moves, the sheet is held out of the layout's way (`data-riding`) and slides
 * on its own, in the keyboard's time, by the climb it made the last time on this screen (a guess
 * from the screen's height the first time); once the page has its size, the layout takes it back
 * from where it is seen, and the climb it made is kept.
 */
export function rideKeyboard(dialog, field) {
  let rest = 0;        // its top with the keyboard down, as laid out
  let tall = 0;        // its height then
  let pad = 0;         // the home bar's room under it then, which the keyboard takes
  let full = 0;        // the page's height then
  let rise = 0;
  let waiting = 0;
  const box = () => dialog.getBoundingClientRect();
  const free = () => {
    dialog.removeAttribute('data-riding');
    dialog.style.removeProperty('transition');
    dialog.style.removeProperty('translate');
  };
  const glide = (from, to, how) => {
    dialog.style.transition = 'none';
    dialog.style.translate = `0 ${from - to}px`;
    dialog.getBoundingClientRect();
    dialog.style.transition = how;
    dialog.style.translate = '0 0';
  };
  /** Held where it is seen, at `top` and `height` from now on, with `bottom` under its foot. */
  const hold = (top, height, bottom) => {
    const seen = box().top;
    dialog.style.setProperty('--ride-top', `${top}px`);
    dialog.style.setProperty('--ride-height', `${height}px`);
    dialog.style.setProperty('--ride-pad', `${bottom}px`);
    dialog.setAttribute('data-riding', '');
    glide(seen, top, RIDE);
  };
  function go(up) {
    if (!dialog.open) return;
    if (!dialog.hasAttribute('data-riding') && window.innerHeight >= full - KEYBOARD_MIN) {
      // Down and laid out: where it rests, and what the climb will be.
      const now = box();
      rest = now.top;
      tall = now.height;
      pad = Number.parseFloat(getComputedStyle(dialog).paddingBottom) || 0;
      full = window.innerHeight;
      if (!rise) {
        try { rise = Number(localStorage.getItem(riseKey(full))) || 0; } catch { rise = 0; }
      }
      // An iPhone's keyboard with its suggestions is about 39 % of the screen's height.
      if (!rise) rise = Math.round(screen.height * 0.394) - pad;
    }
    if (up) hold(rest - rise, tall - pad, 0);
    else hold(rest, tall, pad);
    settle();
  }
  /** Once the page has kept its size a moment, the layout takes it back from where it is seen. */
  function settle() {
    cancelAnimationFrame(waiting);
    const start = performance.now();
    let height = window.innerHeight;
    let still = 0;
    const frame = () => {
      if (!dialog.open) return;
      if (window.innerHeight !== height) {
        height = window.innerHeight;
        still = 0;
      } else still += 1;
      const waited = performance.now() - start;
      if ((waited > 320 && still >= 10) || waited > 2500) land();
      else waiting = requestAnimationFrame(frame);
    };
    waiting = requestAnimationFrame(frame);
  }
  function land() {
    const seen = box().top;
    free();
    const top = box().top;
    if (full - window.innerHeight > KEYBOARD_MIN) {
      rise = rest - top;
      try { localStorage.setItem(riseKey(full), String(Math.round(rise))); } catch { /* this time only */ }
    }
    if (Math.abs(seen - top) < 1) return;
    glide(seen, top, 'translate .15s ease-out');
    dialog.addEventListener('transitionend', () => {
      if (!dialog.hasAttribute('data-riding')) free();
    }, { once: true });
  }
  field.addEventListener('focus', () => go(true));
  field.addEventListener('blur', () => go(false));
  dialog.addEventListener('close', () => cancelAnimationFrame(waiting));
}
