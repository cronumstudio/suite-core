/**
 * Picking something up from a list and dropping it on a place: a note on a
 * notebook, a task on another list. The app says what can be picked up, where
 * it can go and what dropping it there does; the kit does the pointer.
 *
 *   makeDraggable(shell.list, {
 *     items: '[data-note]',
 *     label: (row) => row.dataset.title,
 *     check: (row, place) => place.dataset.notebook === row.dataset.notebook
 *       ? { ok: false, text: alreadyThere }                 // the app's words, from its catalog
 *       : { ok: true, text: moveTo(place.dataset.name) },
 *     onDrop: (row, place) => moveNote(row.dataset.note, place.dataset.notebook),
 *   });
 *   navItem(…) with data-drop: a place, anywhere on the page
 *
 * What travels with the pointer says in words what letting go will do, or why
 * it can't be done there: on a sidebar a few pixels separate two notebooks,
 * and reading it is the only way to be sure before letting go.
 *
 * With a mouse it starts when the pointer has really moved; with a finger, after
 * holding it still for a moment, because otherwise every attempt to scroll
 * the list would pick up a row (unless the app gives a grip, `handle`, which
 * only drags). Escape puts it back. Near the top or the bottom of whatever
 * scrolls under the pointer, it scrolls by itself. On a phone the sidebar is a
 * drawer, closed: the frame opens it as soon as something is picked up that can
 * be dropped there (shell.js, on `kit-dragstart`), and closes it when the drag
 * ends. Held over ☰ (`data-drag-spring`) it opens too.
 *
 * It is never the only way: the keyboard and a screen reader can't drag, so
 * whatever can be dropped somewhere can also be moved from a menu.
 */
import { el } from './dom.js';
import { icon } from './icons.js';

const THRESHOLD = 6;      // pixels the mouse moves before it is a drag and not a click
const HOLD_MS = 380;      // how long a finger holds still before it picks up
const SLOP = 10;          // pixels a finger may wander while holding: more is a scroll
const SPRING_MS = 550;    // how long over ☰ before the drawer opens
const SETTLE_MS = 280;    // the drawer's slide (kit.css), and a little more: then look again
const EDGE = 56;          // the strip at each end of a scrolling box that scrolls it
const MAX_SPEED = 14;     // pixels per tick, right at the edge
const TICK_MS = 16;

// Inside a row these keep their own job; the row itself may be a link or a button.
const CONTROLS = 'button, a, input, select, textarea, label, [contenteditable=""], [contenteditable="true"]';

/**
 * How fast a box scrolls with the pointer at `y`: towards the nearer edge,
 * faster the closer, nothing outside the strips. The nearer edge wins, not the
 * top one for being first: in a box shorter than both strips they overlap.
 */
export function edgeSpeed(top, bottom, y, zone = EDGE, max = MAX_SPEED) {
  const fromTop = y - top;
  const fromBottom = bottom - y;
  const nearest = Math.min(fromTop, fromBottom);
  if (nearest >= zone || fromTop < 0 || fromBottom < 0) return 0;
  const force = Math.round(max * (1 - Math.max(0, nearest) / zone)) || 1;
  return fromTop <= fromBottom ? -force : force;
}

/** The nearest box above `node` that scrolls up and down and has somewhere to go. */
function scrollerOf(node) {
  for (let at = node; at && at.nodeType === 1; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if ((overflowY === 'auto' || overflowY === 'scroll') && at.scrollHeight > at.clientHeight) return at;
  }
  return null;
}

/**
 * Lets the `items` inside `container` be picked up and dropped on the
 * `targets` of the page. The container may redraw its rows at any time: they
 * are found when the pointer goes down.
 *
 * @param {Element} container
 * @param {object} options
 * @param {string} options.items             what can be picked up, inside the container
 * @param {string} [options.handle]          the grip inside an item; without one, the whole item
 * @param {string} [options.skip]            parts of an item that don't pick it up (a grip that reorders)
 * @param {string} [options.targets]         the places, anywhere on the page
 * @param {Function} [options.canDrag]       (item) → false leaves it where it is (a notebook only to read)
 * @param {Function} options.label           (item) → the text that travels with the pointer
 * @param {Function} options.check           (item, place) → { ok, text }: what letting go there does, or
 *                                           why not; null when the place has nothing to do with it
 * @param {Function} options.onDrop          (item, place) → called only when check said ok
 * @returns {{ destroy: Function }}
 */
export function makeDraggable(container, {
  items, handle = null, skip = null, targets = '[data-drop]', canDrag = () => true, label, check, onDrop,
}) {
  let session = null;
  container.classList.add('kit-draggable');

  function onPointerDown(ev) {
    if (session || ev.button || !ev.isPrimary) return;
    const item = ev.target.closest?.(items);
    if (!item || !container.contains(item)) return;
    const grip = handle ? ev.target.closest(handle) : null;
    if (handle && (!grip || !item.contains(grip))) return;
    if (skip && ev.target.closest(skip)) return;
    const control = ev.target.closest(CONTROLS);
    if (control && control !== item && item.contains(control) && !grip) return;
    if (canDrag(item) === false) return;

    const touch = ev.pointerType === 'touch';
    session = {
      item, pointerId: ev.pointerId, x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY,
      touch, holding: touch && !handle, active: false, timer: null, place: null, verdict: null,
      verdicts: new Map(), ghost: null, where: null, spring: null, springTimer: null, scroller: null, scrollTimer: null,
    };
    if (session.holding) session.timer = setTimeout(() => { if (session && !session.active) start(); }, HOLD_MS);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onKey);
    // A finger that has picked something up must not scroll the page under it.
    if (touch) document.addEventListener('touchmove', onTouchMove, { passive: false });
  }

  function onPointerMove(ev) {
    if (!session || ev.pointerId !== session.pointerId) return;
    session.x = ev.clientX;
    session.y = ev.clientY;
    if (!session.active) {
      const moved = Math.hypot(ev.clientX - session.x0, ev.clientY - session.y0);
      // A finger that moves before it has held still is scrolling the list.
      if (session.holding) { if (moved > SLOP) end(); return; }
      if (moved < THRESHOLD) return;
      start();
    }
    ev.preventDefault();
    follow();
  }

  function onTouchMove(ev) { if (session?.active) ev.preventDefault(); }
  function onKey(ev) { if (ev.key === 'Escape' && session?.active) { ev.preventDefault(); end(); } }
  function onContextMenu(ev) { if (session) ev.preventDefault(); }
  // A link or an image in a row would start the browser's own drag of its address.
  function onNativeDrag(ev) { if (ev.target.closest?.(items)) ev.preventDefault(); }

  function start() {
    const s = session;
    s.active = true;
    clearTimeout(s.timer);
    s.where = el('span', { class: 'kit-drag-ghost__where' });
    s.ghost = el('div', { class: 'kit-drag-ghost', 'aria-hidden': 'true' },
      el('strong', { text: label(s.item) || '' }), s.where);
    s.where.hidden = true;
    document.body.append(s.ghost);
    s.item.classList.add('kit-drag-source');
    document.documentElement.setAttribute('data-kit-dragging', '');
    if (s.touch) navigator.vibrate?.(8);
    // Who picked up what, and where it may go: the frame opens its drawer if those places are in it.
    document.dispatchEvent(new CustomEvent('kit-dragstart', { detail: { item: s.item, targets } }));
    follow();
    // The drawer slides in under a finger that may not move again: look once it is there.
    s.settleTimer = setTimeout(() => { if (session === s) follow(); }, SETTLE_MS);
  }

  /** The ghost to the pointer, and what is under it now. */
  function follow() {
    const s = session;
    const { offsetWidth: width, offsetHeight: height } = s.ghost;
    // Above the finger, which would hide it; beside and below the mouse arrow.
    let x = s.touch ? s.x - width / 2 : s.x + 14;
    let y = s.touch ? s.y - height - 28 : s.y + 16;
    x = Math.max(4, Math.min(x, window.innerWidth - width - 4));
    y = Math.max(4, Math.min(y, window.innerHeight - height - 4));
    s.ghost.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    const under = document.elementFromPoint(s.x, s.y);
    springOver(under?.closest?.('[data-drag-spring]') || null);
    aimAt(under?.closest?.(targets) || null);
    scrollNear(under);
  }

  function aimAt(place) {
    const s = session;
    if (place === s.place) return;
    s.place?.removeAttribute('data-drop-state');
    s.place = place;
    let verdict = null;
    if (place) {
      if (!s.verdicts.has(place)) s.verdicts.set(place, check(s.item, place) || null);
      verdict = s.verdicts.get(place);
    }
    s.verdict = verdict;
    s.ghost.classList.toggle('kit-drag-ghost--no', Boolean(verdict && !verdict.ok));
    s.where.hidden = !verdict;
    s.where.replaceChildren(...(verdict ? [icon(verdict.ok ? 'chevron' : 'x'), el('span', { text: verdict.text })] : []));
    if (place && verdict) place.setAttribute('data-drop-state', verdict.ok ? 'ok' : 'no');
  }

  function springOver(spring) {
    const s = session;
    if (spring === s.spring) return;
    clearTimeout(s.springTimer);
    s.spring = spring;
    if (spring) {
      s.springTimer = setTimeout(() => {
        if (session !== s) return;
        spring.dispatchEvent(new CustomEvent('kit-drag-spring', { bubbles: true }));
        // What opened slides in under a finger that may not move again: look once it is there.
        s.springTimer = setTimeout(() => { if (session === s) follow(); }, SETTLE_MS);
      }, SPRING_MS);
    }
  }

  function scrollNear(under) {
    const s = session;
    const box = under ? scrollerOf(under) : null;
    const rect = box?.getBoundingClientRect();
    const speed = box ? edgeSpeed(rect.top, rect.bottom, s.y) : 0;
    s.scroller = speed ? { box, speed } : null;
    if (!s.scroller) { clearInterval(s.scrollTimer); s.scrollTimer = null; return; }
    s.scrollTimer ||= setInterval(() => {
      if (session !== s || !s.scroller) return;
      const before = s.scroller.box.scrollTop;
      s.scroller.box.scrollTop += s.scroller.speed;
      // What is under a pointer that hasn't moved changes as the box runs under it.
      if (s.scroller.box.scrollTop !== before) follow();
    }, TICK_MS);
  }

  function onPointerUp(ev) {
    if (!session || ev.pointerId !== session.pointerId) return;
    const { active, item, place, verdict } = session;
    end();
    if (!active) return;
    // The release would also be a click on the row (opening it) or on the place.
    const swallow = (click) => { click.stopPropagation(); click.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    if (place && verdict?.ok) onDrop(item, place);
  }

  function cancel(ev) { if (session && (!ev?.pointerId || ev.pointerId === session.pointerId)) end(); }

  function end() {
    const s = session;
    if (!s) return;
    session = null;
    clearTimeout(s.timer);
    clearTimeout(s.springTimer);
    clearTimeout(s.settleTimer);
    clearInterval(s.scrollTimer);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('touchmove', onTouchMove, { passive: false });
    if (!s.active) return;
    s.ghost.remove();
    s.item.classList.remove('kit-drag-source');
    s.place?.removeAttribute('data-drop-state');
    document.documentElement.removeAttribute('data-kit-dragging');
    document.dispatchEvent(new CustomEvent('kit-dragend'));
  }

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('contextmenu', onContextMenu);
  container.addEventListener('dragstart', onNativeDrag);
  return {
    destroy() {
      end();
      container.classList.remove('kit-draggable');
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('contextmenu', onContextMenu);
      container.removeEventListener('dragstart', onNativeDrag);
    },
  };
}
