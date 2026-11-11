/**
 * A finger across a row of a list, the same in every module (docs/web-kit.md, «Same in every
 * module», rule 6): to the left the item goes to the trash, with Undo; to the right the module's
 * quick toggle (Tasks: the star, and My Day further; Notes: the pin; Projects: done). What the row
 * shows slides over the colour, the icon and the words of what letting go will do: grey until the
 * finger has gone far enough, then the action's colour, with a little buzz. Let go short of it, or
 * come back, and nothing happens. It was Tasks' own swipe (main.js, 2025), made the kit's.
 *
 *   rowSwipe(row, {
 *     left: [trashAction(() => trash(note))],
 *     right: () => [{ label: pinWords(note), iconName: 'pin', tone: 'accent', run: () => pin(note) }],   // «Fijar» or «Quitar»
 *   });
 *   keepSwipe(row);   // nothing to do on it, and still the finger's: swiping it does nothing
 *
 * - Touch only: a mouse or a trackpad never swipes (the row's «…» or its menu does the same).
 * - It starts anywhere on the row but on what keeps its own finger inside it (`ignore`: fields,
 *   editors, the round check, the buttons and links in it; the row itself may be a button, Notes'),
 *   at the screen's start edge (the drawer's, and going back: shell.js), or on what slides sideways
 *   itself inside it (a row of chips), which keeps scrolling.
 * - 12 px across before it is a swipe; more than 12 px down first, and more down than across, is
 *   the list's scroll. A finger that held still first (drag.js' hold) is picking the row up, and a
 *   drag under way (`data-kit-dragging`) is never a swipe: the drag wins.
 * - A side has one action or two, in the order the finger reaches them: the first at 82 px, the
 *   second at 168; past 230 px the row comes harder, a quarter of the finger's way. With nothing
 *   that way the row doesn't move that way. `left` and `right` are arrays, or functions asked when
 *   the swipe starts, so the words say what the row is now («Fijar» or «Quitar»).
 * - Right to left it is mirrored, as windows.js mirrors its swipe: `right` is towards the line's
 *   end, where a reader of that language reads on.
 * - The row keeps the finger whatever it has: `data-own-swipe` (Cronum Work's windows don't switch
 *   module from it, windows.js) and `touch-action: pan-y` (kit.css), and once it is a swipe the
 *   touch's moves are kept from the browser. Not for what lies in something that scrolls sideways
 *   (Next's line, the Gantt): there `pan-y` would take that scroll away.
 * - Letting go after a swipe is not a click: the row doesn't open.
 * - While a row is swiped `<html>` has `data-kit-swiping` and the document hears `kit-swipestart`
 *   and `kit-swipeend`: `redrawInPlace` (drag.js) waits for the end, as it waits for a drag's, and
 *   so can whatever else would draw the row again under the finger.
 *
 * `content` is what slides: by default the row's one child (Tasks' `.task-inner`), with a
 * background of its own, over the colour drawn in the row; else the row itself (Notes' button),
 * with the colour beside it, in the room it leaves. The colour is drawn the first time the row is
 * swiped, not in every row of every list: on a computer nobody swipes.
 */
import { el } from './dom.js';
import { t } from './i18n.js';
import { icon } from './icons.js';
import { HOLD_MS, SLOP } from './drag.js';

const ARM = 12;              // pixels across before it is a swipe, and down before it is a scroll
const DISTANCES = [82, 168]; // where a side's first action, and its second, are reached
const GIVE_FROM = 230;       // past this the row comes harder…
const GIVE = 0.25;           // …a quarter of the finger's way
const EDGE = 28;             // the screen's start edge is the frame's (shell.js EDGE)
const BACK_MS = 180;         // what slid going back into place
const CLICK_MS = 400;        // the click a release may still make comes within this
const EASE = 'cubic-bezier(.2, .8, .3, 1)';

/** What inside a row keeps its own finger: a swipe never starts there (the row itself may be one). */
export const SWIPE_IGNORE = 'input, textarea, select, label, [contenteditable=""], [contenteditable="true"], .kit-round-check, button, a[href]';

/** The action of `actions` (a side's, nearest first) the finger has reached `distance` px away, or null. */
export function swipeAction(distance, actions = []) {
  let reached = null;
  DISTANCES.forEach((at, i) => { if (distance >= at && actions[i]) reached = actions[i]; });
  return reached;
}

/** Where the row is for a finger `dx` px across: with it up to 230 px, then harder. */
export function swipeStretch(dx) {
  const far = Math.abs(dx);
  return far > GIVE_FROM ? Math.sign(dx) * (GIVE_FROM + (far - GIVE_FROM) * GIVE) : dx;
}

/** To the trash, the same on every row: the kit's «Borrar» in red. `run` deletes it and offers Undo. */
export function trashAction(run, { label = null } = {}) {
  return { label: label || t('kit.delete'), iconName: 'trash', tone: 'danger', run };
}

/** Adds a class to a node the module made, keeping its own. */
function addClass(node, name) {
  const current = node.getAttribute('class') || '';
  if (!current.split(/\s+/).includes(name)) node.setAttribute('class', `${current} ${name}`.trim());
}
function removeClass(node, name) {
  const kept = (node.getAttribute('class') || '').split(/\s+/).filter((c) => c && c !== name).join(' ');
  if (kept) node.setAttribute('class', kept);
  else node.removeAttribute('class');
}

const buzz = () => { try { globalThis.navigator?.vibrate?.(8); } catch { /* not on this phone */ } };

/**
 * Lets a finger swipe `row` across. → { destroy }: its listeners, its colour and its marks go.
 *
 * @param {Element} row
 * @param {object} [options]
 * @param {Element} [options.content]       what slides (by default the row's one child, else the row)
 * @param {Array|Function} [options.left]   [{ label, iconName, tone, run }], nearest first, or () → them:
 *                                          what a swipe to the left does (the trash: trashAction)
 * @param {Array|Function} [options.right]  the same to the right (the module's quick toggle)
 * @param {string} [options.ignore]         what inside the row keeps its own finger (SWIPE_IGNORE)
 *
 * A tone is the colour an action is drawn in once reached: 'danger', 'accent' (the default), 'sun'
 * (yolk: My Day, "now") or 'done'.
 */
export function rowSwipe(row, { content = null, left = [], right = [], ignore = SWIPE_IGNORE } = {}) {
  row.setAttribute('data-own-swipe', '');
  addClass(row, 'kit-swipe');
  const listening = new AbortController();
  let session = null;
  let settling = 0;
  let slid = null;
  let bg = null;
  let slot = null;
  let picture = null;
  let words = null;
  // Nothing either way, now or ever: the row only keeps the finger.
  const idle = Array.isArray(left) && !left.length && Array.isArray(right) && !right.length;
  if (!idle) row.addEventListener('pointerdown', down, { signal: listening.signal });

  const read = (side) => (typeof side === 'function' ? side() : side) || [];
  const html = () => document.documentElement;

  /** Whether `target`, or what holds it inside the row, slides sideways itself (chips): its finger. */
  function slidesSideways(target) {
    for (let at = target; at && at !== row; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (/\bpan-x\b/.test(style?.touchAction ?? '')) return true;
      const overflow = style?.overflowX;
      if ((overflow === 'auto' || overflow === 'scroll') && at.scrollWidth > at.clientWidth + 1) return true;
    }
    return false;
  }

  function down(ev) {
    if (session || ev.pointerType !== 'touch' || ev.isPrimary === false) return;
    if (html().hasAttribute('data-kit-dragging')) return;
    const target = ev.target;
    const control = target?.closest?.(ignore);
    if (control && control !== row && row.contains(control)) return;
    const rtl = getComputedStyle(row)?.direction === 'rtl';
    const width = window.innerWidth || 0;
    if (rtl ? width && ev.clientX > width - EDGE : ev.clientX < EDGE) return;
    if (slidesSideways(target)) return;
    const own = new AbortController();
    const on = { signal: own.signal };
    session = {
      id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, t0: ev.timeStamp ?? 0, rtl, own,
      armed: false, wandered: false, sides: null, side: null, dx: 0, action: null, moving: null, shown: null,
    };
    // A touch's pointer is captured by what it went down on: its moves come here, through the row.
    row.addEventListener('pointermove', move, on);
    row.addEventListener('pointerup', (e) => { if (e.pointerId === session?.id) end(true); }, on);
    row.addEventListener('pointercancel', (e) => { if (e.pointerId === session?.id) end(false); }, on);
    // Once it is a swipe the finger is its own: the list doesn't scroll under it.
    row.addEventListener('touchmove', (e) => { if (session?.armed && e.cancelable !== false) e.preventDefault(); }, { passive: false, signal: own.signal });
  }

  function move(ev) {
    const s = session;
    if (!s || ev.pointerId !== s.id) return;
    const dx = ev.clientX - s.x0;
    const dy = ev.clientY - s.y0;
    if (!s.armed) {
      // Something picked up meanwhile, by this finger or another way: the drag's.
      if (html().hasAttribute('data-kit-dragging')) { end(false); return; }
      if (!s.wandered && Math.hypot(dx, dy) > SLOP) {
        // Held still that long first, it was a finger picking the row up (drag.js), not a swipe.
        if ((ev.timeStamp ?? 0) - s.t0 >= HOLD_MS) { end(false); return; }
        s.wandered = true;
      }
      if (Math.abs(dy) > ARM && Math.abs(dy) > Math.abs(dx)) { end(false); return; }
      if (Math.abs(dx) < ARM) return;
      const sides = { left: read(left), right: read(right) };
      const side = (s.rtl ? -dx : dx) > 0 ? 'right' : 'left';
      // Nothing to do that way: the row doesn't even move.
      if (!sides[side].length) { end(false); return; }
      arm(s, sides, side);
    }
    // Towards the line's end is `right` (mirrored right to left), and a side with nothing stays.
    let towards = s.rtl ? -dx : dx;
    if (!s.sides.right.length) towards = Math.min(towards, 0);
    if (!s.sides.left.length) towards = Math.max(towards, 0);
    if (towards) s.side = towards > 0 ? 'right' : 'left';
    s.dx = swipeStretch(s.rtl ? -towards : towards);
    s.moving.style.transform = `translateX(${s.dx}px)`;
    const action = swipeAction(Math.abs(s.dx), s.sides[s.side]);
    const changed = action !== s.action;
    s.action = action;
    paint(s);
    if (changed && action) buzz();
  }

  /** It is a swipe: the colour beneath (made now, the first time), and the page told. */
  function arm(s, sides, side) {
    s.armed = true;
    s.sides = sides;
    s.side = side;
    const own = [...row.children].filter((node) => node !== bg);
    s.moving = content || (own.length === 1 ? own[0] : row);
    slid = s.moving;
    if (!bg) {
      picture = el('span', { class: 'kit-swipe__icon' });
      words = el('span', { class: 'kit-swipe__label' });
      slot = el('span', { class: 'kit-swipe__action' }, picture, words);
      bg = el('span', { class: 'kit-swipe__bg', 'aria-hidden': 'true' }, slot);
      row.prepend(bg);
    }
    // What slides goes over the colour, inside the row; the row itself has it beside it (kit.css).
    if (s.moving !== row) addClass(s.moving, 'kit-swipe__content');
    row.setAttribute('data-swipe', s.moving === row ? 'beside' : 'under');
    clearTimeout(settling);
    row.removeAttribute('data-swipe-settling');
    row.setAttribute('data-swiping', '');
    html().setAttribute('data-kit-swiping', '');
    s.moving.style.transition = 'none';
    document.dispatchEvent(new CustomEvent('kit-swipestart', { detail: { row } }));
  }

  /** The colour, icon and words of what letting go does now (or the side's first, faint). */
  function paint(s) {
    const shown = s.action || s.sides[s.side][0];
    bg.setAttribute('data-side', s.side);
    if (s.action) bg.setAttribute('data-tone', s.action.tone || 'accent');
    else bg.removeAttribute('data-tone');
    slot.toggleAttribute('data-armed', Boolean(s.action));
    if (shown !== s.shown) {
      s.shown = shown;
      picture.replaceChildren(...(shown.iconName ? [icon(shown.iconName)] : []));
      words.textContent = shown.label || '';
    }
    // The row slides itself: its colour fills the room it leaves, on that side.
    if (s.moving === row) {
      bg.style.left = s.dx > 0 ? `${-s.dx}px` : '100%';
      bg.style.width = `${Math.abs(s.dx)}px`;
    }
  }

  /** The finger lifted (`commit`) or was taken away: back into place, and the action reached, if any. */
  function end(commit) {
    const s = session;
    if (!s) return;
    session = null;
    s.own.abort();
    if (!s.armed) return;
    const { moving } = s;
    const action = commit ? s.action : null;
    row.removeAttribute('data-swiping');
    html().removeAttribute('data-kit-swiping');
    moving.style.transition = `transform ${BACK_MS}ms ${EASE}`;
    moving.style.transform = '';
    // Under what slides back the colour stays until it has; beside the row it goes at once.
    if (moving !== row) row.setAttribute('data-swipe-settling', '');
    clearTimeout(settling);
    settling = setTimeout(() => {
      row.removeAttribute('data-swipe-settling');
      moving.style.transition = '';
    }, BACK_MS + 20);
    if (commit) swallowClick();
    document.dispatchEvent(new CustomEvent('kit-swipeend', { detail: { row } }));
    action?.run?.();
  }

  /** The release would also be a click on the row (opening it): the next one inside it goes nowhere. */
  function swallowClick() {
    const swallow = (click) => {
      if (!row.contains(click.target)) return;
      click.stopPropagation();
      click.preventDefault();
      window.removeEventListener('click', swallow, { capture: true });
    };
    window.addEventListener('click', swallow, { capture: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), CLICK_MS);
  }

  function destroy() {
    end(false);
    clearTimeout(settling);
    listening.abort();
    bg?.remove();
    bg = null;
    if (slid && slid !== row) removeClass(slid, 'kit-swipe__content');
    row.removeAttribute('data-own-swipe');
    row.removeAttribute('data-swipe');
    row.removeAttribute('data-swipe-settling');
    removeClass(row, 'kit-swipe');
  }

  return { destroy };
}

/** A row with nothing to do on it (Next's, one only to read) that still keeps the finger: swiping it does nothing. */
export const keepSwipe = (row) => rowSwipe(row);
