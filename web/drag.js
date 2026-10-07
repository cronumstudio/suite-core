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
 * the list would pick up a row: a grip picks up at once, either the only way
 * (`handle`) or beside the held row (`grip`). Escape puts it back. Near the top
 * or the bottom of whatever scrolls under the pointer, it scrolls by itself. On
 * a phone the sidebar is a drawer, closed: the frame opens it as soon as
 * something is picked up that can be dropped there (shell.js, on
 * `kit-dragstart`), and closes it when the drag ends. When it may also stay in
 * the list (`drawer: 'tabs'`), the frame shows a tab at the edge instead, which
 * opens the drawer when held, and another beside the open drawer closes it.
 * Held over ☰ (`data-drag-spring`) it opens too; a tab, `data-drag-spring="at-once"`, as soon as it is reached.
 *
 * A place may also be split by the height of the pointer, for putting things
 * in order: in front of a row or behind it (`zones: 'between'`), or also
 * inside it (`'around'`, a tree). There, where it would land opens as a dashed
 * gap the size of what is carried, and the rows make room for it; the app
 * says with `check(item, place, { zone })` what each zone would do, as with a
 * whole place. The rows can be at once what is picked up and where it goes.
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
const SETTLE_MS = 320;    // the drawer's slide (--kit-slide-time, kit.css), and a little more: then look again
const EDGE = 56;          // the strip at each end of a scrolling box that scrolls it
const MAX_SPEED = 14;     // pixels per tick, right at the edge
const TICK_MS = 16;
const CLOSE_MS = 260;     // a gap left behind closes (kit.css), and is gone even if no animation ends
const EDGE_SHARE = 0.3;   // of a row that also takes things inside, the top and bottom shares that go around it

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

/**
 * Which part of a place the pointer is on, `rel` being its height there (0 at
 * the top, 1 at the bottom): the whole of it, or in front of it and behind it,
 * or also inside, in the middle.
 */
export function zoneAt(kind, rel) {
  if (kind === 'between') return rel < 0.5 ? 'before' : 'after';
  if (kind === 'around') return rel < EDGE_SHARE ? 'before' : (rel > 1 - EDGE_SHARE ? 'after' : 'inside');
  return 'whole';
}

/** The zones that open a gap: in front of a place, behind it, or after the last one. */
const BETWEEN = new Set(['before', 'after', 'end']);

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
 * @param {string} [options.grip]            with the whole item, a part of it that picks it up at
 *                                           once, a finger too, without holding
 * @param {string} [options.skip]            parts of an item that don't pick it up (a grip that reorders)
 * @param {string|Function} [options.drawer] on a phone, what the closed drawer does when the places
 *                                           are in it: 'open' (the default) or 'tabs', when it may
 *                                           also stay in the list; or (item) → one of them
 * @param {string} [options.targets]         the places, anywhere on the page
 * @param {Function} [options.canDrag]       (item) → false leaves it where it is (a notebook only to read)
 * @param {string|Function} [options.zones] how a place is split: 'whole' (the default), 'between'
 *                                           (before, after) or 'around' (before, inside, after); or
 *                                           (place, item) → one of them, place by place
 * @param {boolean} [options.end]            below the last place, in the container's column, is a
 *                                           place too: the container, with the zone 'end'
 * @param {string} [options.gap]             'full' (the default): the gap is as tall as the item;
 *                                           'thin': a dashed line that moves nothing (rows that
 *                                           must stay level with something beside them)
 * @param {Function} options.label           (item) → the text that travels with the pointer
 * @param {Function} options.check           (item, place, { zone }) → { ok, text, detail, indent }:
 *                                           what letting go there does, or why not, a second line,
 *                                           and the gap's indent in pixels; null when the place has
 *                                           nothing to do with it
 * @param {Function} options.onDrop          (item, place, { zone, x, y, top }) → called only when check
 *                                           said ok; x and y where it was let go, top that of the gap
 *                                           (null without one): where it lands, to keep it in sight
 * @returns {{ destroy: Function }}
 */
export function makeDraggable(container, {
  items, handle = null, grip: quick = null, skip = null, targets = '[data-drop]', canDrag = () => true,
  zones = 'whole', end: belowLast = false, gap: gapKind = 'full', drawer = 'open', label, check, onDrop,
}) {
  let session = null;
  container.classList.add('kit-draggable');

  function onPointerDown(ev) {
    if (session || ev.button || !ev.isPrimary) return;
    const item = ev.target.closest?.(items);
    if (!item || !container.contains(item)) return;
    const held = handle || quick;
    const found = held ? ev.target.closest(held) : null;
    const grip = found && item.contains(found) ? found : null;
    if (handle && !grip) return;
    if (skip && ev.target.closest(skip)) return;
    const control = ev.target.closest(CONTROLS);
    if (control && control !== item && item.contains(control) && !grip) return;
    if (canDrag(item) === false) return;

    const touch = ev.pointerType === 'touch';
    session = {
      item, pointerId: ev.pointerId, x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY,
      touch, holding: touch && !grip, active: false, timer: null, place: null, zone: null, verdict: null,
      verdicts: new Map(), ghost: null, where: null, detail: null, gap: null, closing: new Set(), height: 0,
      spring: null, springTimer: null, scroller: null, scrollTimer: null,
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
    s.detail = el('span', { class: 'kit-drag-ghost__detail' });
    s.ghost = el('div', { class: 'kit-drag-ghost', 'aria-hidden': 'true' },
      el('strong', { text: label(s.item) || '' }), s.where, s.detail);
    s.where.hidden = true;
    s.detail.hidden = true;
    s.height = s.item.offsetHeight;
    document.body.append(s.ghost);
    s.item.classList.add('kit-drag-source');
    document.documentElement.setAttribute('data-kit-dragging', '');
    if (s.touch) navigator.vibrate?.(8);
    // Who picked up what, and where it may go: the frame opens its drawer if those places are in it.
    const asked = typeof drawer === 'function' ? drawer(s.item) : drawer;
    document.dispatchEvent(new CustomEvent('kit-dragstart', { detail: { item: s.item, targets, drawer: asked } }));
    follow();
    // The drawer slides in under a finger that may not move again: look once it is there.
    s.settleTimer = setTimeout(() => { if (session === s) follow(); }, SETTLE_MS);
  }

  /** The ghost to the pointer, and what is under it now. */
  function follow() {
    const s = session;
    const under = document.elementFromPoint(s.x, s.y);
    springOver(under?.closest?.('[data-drag-spring]') || null);
    aim(under);
    scrollNear(under);
    place();
  }

  /**
   * The card to the pointer, measured once it says what it says now: placed by
   * its size before the words changed, a card that grew stood out of the screen
   * until the next move, and a finger holding still makes none.
   */
  function place() {
    const s = session;
    if (!s) return;
    const { offsetWidth: width, offsetHeight: height } = s.ghost;
    // Above the finger, which would hide it; beside and below the mouse arrow.
    let x = s.touch ? s.x - width / 2 : s.x + 14;
    let y = s.touch ? s.y - height - 28 : s.y + 16;
    x = Math.max(4, Math.min(x, window.innerWidth - width - 4));
    y = Math.max(4, Math.min(y, window.innerHeight - height - 4));
    s.ghost.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  /** The place under the pointer, and which part of it. */
  function aim(under) {
    const s = session;
    const hit = under?.closest?.(targets) || null;
    let place = hit && hit !== s.item && !s.item.contains(hit) ? hit : null;
    // Over the gap opened for it, or over no other place among the rows that made room for it,
    // it still goes there: the rows moved under the pointer to open it, and must not close it.
    if (s.gap?.parentElement && (under?.closest?.('.kit-drop-gap') || (!place && over(s.gap.parentElement)))) return;
    let zone = null;
    if (place) {
      const kind = typeof zones === 'function' ? zones(place, s.item) : zones;
      const { top, bottom } = place.getBoundingClientRect();
      zone = zoneAt(kind, (s.y - top) / ((bottom - top) || 1));
    } else if (belowLast && belowTheLast()) {
      place = container;
      zone = 'end';
    }
    aimAt(place, zone);
  }

  function over(node) {
    const r = node.getBoundingClientRect();
    return session.x >= r.left && session.x <= r.right && session.y >= r.top && session.y <= r.bottom;
  }

  const lastPlace = () => [...container.querySelectorAll(targets)].filter((node) => node !== session.item).pop() || null;

  /** In the container's column, below its last place. */
  function belowTheLast() {
    const s = session;
    const box = container.getBoundingClientRect();
    if (s.x < box.left || s.x > box.right) return false;
    const last = lastPlace();
    return s.y > (last ? last.getBoundingClientRect().bottom : box.top);
  }

  function aimAt(place, zone) {
    const s = session;
    if (place === s.place && zone === s.zone) return;
    s.place?.removeAttribute('data-drop-state');
    s.place = place;
    s.zone = zone;
    let verdict = null;
    if (place) {
      if (!s.verdicts.has(place)) s.verdicts.set(place, new Map());
      const byZone = s.verdicts.get(place);
      if (!byZone.has(zone)) byZone.set(zone, check(s.item, place, { zone }) || null);
      verdict = byZone.get(zone);
    }
    s.verdict = verdict;
    s.ghost.classList.toggle('kit-drag-ghost--no', Boolean(verdict && !verdict.ok));
    s.where.hidden = !verdict;
    s.where.replaceChildren(...(verdict ? [icon(verdict.ok ? 'chevron' : 'x'), el('span', { text: verdict.text })] : []));
    s.detail.hidden = !verdict?.detail;
    s.detail.textContent = verdict?.detail || '';
    // Between two rows the gap says where; a whole place, or inside one, lights up.
    if (place && verdict && !BETWEEN.has(zone)) place.setAttribute('data-drop-state', verdict.ok ? 'ok' : 'no');
    openGap(place, zone, verdict);
  }

  /** Where it would land: a dashed gap the size of what is carried, which the rows make room for. */
  function openGap(place, zone, verdict) {
    const s = session;
    if (!place || !verdict?.ok || !BETWEEN.has(zone)) { closeGap(); return; }
    const last = zone === 'end' ? lastPlace() : null;
    const parent = zone === 'end' ? (last?.parentElement || container) : place.parentElement;
    // Already there (behind one row is in front of the next): it stays open, only its indent may change.
    const there = s.gap?.parentElement && (zone === 'before' ? beside(place, 'previousElementSibling') === s.gap
      : zone === 'after' ? beside(place, 'nextElementSibling') === s.gap
        : (last ? beside(last, 'nextElementSibling') === s.gap : container.lastElementChild === s.gap));
    if (!there) {
      closeGap();
      // A list takes only items: in one the gap is an item too.
      const tag = /^(UL|OL)$/.test(parent.tagName) ? 'li' : 'div';
      s.gap = el(tag, { class: gapKind === 'thin' ? 'kit-drop-gap kit-drop-gap--thin' : 'kit-drop-gap', 'aria-hidden': 'true' });
      if (gapKind !== 'thin') s.gap.style.height = `${s.height}px`;
      // The space the list puts between its rows, which the gap takes back while it opens and closes (kit.css).
      s.gap.style.setProperty('--kit-gap-space', `${parseFloat(getComputedStyle(parent).rowGap) || 0}px`);
      if (zone === 'before') place.before(s.gap);
      else if (zone === 'after') place.after(s.gap);
      else if (last) last.after(s.gap);
      else container.append(s.gap);
    }
    s.gap.style.marginInlineStart = verdict.indent ? `${Math.round(verdict.indent)}px` : '';
  }

  /** The node beside `node` that way, past the gaps still closing. */
  function beside(node, way) {
    let at = node[way];
    while (at?.classList?.contains('kit-drop-gap--closing')) at = at[way];
    return at;
  }

  /**
   * The gap it leaves closes as the new one opens (kit.css), so the rows between
   * slide to their place instead of jumping; while it closes it is no place.
   */
  function closeGap() {
    const s = session;
    const gap = s.gap;
    s.gap = null;
    if (!gap?.parentElement) return;
    gap.classList.add('kit-drop-gap--closing');
    s.closing.add(gap);
    const done = () => { gap.remove(); s.closing.delete(gap); };
    gap.addEventListener('animationend', done, { once: true });
    setTimeout(done, CLOSE_MS);
  }

  function springOver(spring) {
    const s = session;
    if (spring === s.spring) return;
    clearTimeout(s.springTimer);
    s.spring?.removeAttribute('data-spring-armed');
    s.spring = spring;
    if (spring) {
      spring.setAttribute('data-spring-armed', '');
      s.springTimer = setTimeout(() => {
        if (session !== s) return;
        spring.dispatchEvent(new CustomEvent('kit-drag-spring', { bubbles: true }));
        // What opened slides in under a finger that may not move again: look once it is there.
        s.springTimer = setTimeout(() => { if (session === s) follow(); }, SETTLE_MS);
      }, spring.getAttribute('data-drag-spring') === 'at-once' ? 0 : SPRING_MS);
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
    const { active, item, place, zone, verdict, gap } = session;
    // Where it lands, read before the gap goes: the app may keep it there in sight.
    const top = gap?.parentElement ? gap.getBoundingClientRect().top : null;
    end();
    if (!active) return;
    // The release would also be a click on the row (opening it) or on the place.
    const swallow = (click) => { click.stopPropagation(); click.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    if (place && verdict?.ok) onDrop(item, place, { zone, x: ev.clientX, y: ev.clientY, top });
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
    s.spring?.removeAttribute('data-spring-armed');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('touchmove', onTouchMove, { passive: false });
    if (!s.active) return;
    s.ghost.remove();
    s.gap?.remove();
    s.closing.forEach((gap) => gap.remove());
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
