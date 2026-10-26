/**
 * What every screen of the suite needs: notices that come and go (with an
 * undo or a retry), banners for a state that lasts, dialogs and form dialogs
 * (the browser's own <dialog>, which traps focus and closes with Escape; a
 * sheet from the bottom on a phone), menus, labelled fields, switches and the signature.
 *
 * In Cronum Work's shell, where every module's kit shares one page, what this
 * copy hangs on the page's body (a notice, a dialog, a menu, a banner) says
 * which module it is from (mount.js markOwned), so that module's sheet,
 * scoped to its windows, reaches it. Anywhere else it is left as it was.
 */
import { el, $, append, clear } from './dom.js';
import { errorMessage } from './api.js';
import { t } from './i18n.js';
import { icon, cronumRing } from './icons.js';
import { markOwned } from './mount.js';

/* --------------------------------- notices -------------------------------- */

/**
 * A notice for a few seconds; errors stay longer. `action` adds a button
 * ("Undo", "Retry") that runs and closes it. Returns a function that closes it.
 */
export function toast(text, { error = false, action = null, duration = null } = {}) {
  // One box for the page, whichever copy of the kit made it: each notice in it is its own module's.
  let box = $('#kit-toasts');
  if (!box) {
    box = el('div', { id: 'kit-toasts', class: 'kit-toasts', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const close = () => note.remove();
  const note = el('div', { class: `kit-toast${error ? ' kit-toast--error' : ''}`, role: error ? 'alert' : 'status' },
    el('span', { text }),
    action ? el('button', {
      type: 'button', class: 'kit-toast__action', text: action.label,
      onClick: () => { close(); action.onClick?.(); },
    }) : null);
  box.append(markOwned(note));
  // An action needs time to be reached; an error, to be read.
  setTimeout(close, duration ?? (action ? 8000 : error ? 7000 : 3500));
  return close;
}

/**
 * A state that lasts, under the header: offline, a new version. `onClose`
 * adds the ×; `action` a button. The page decides where it goes (shell.js
 * keeps them in its banner row).
 */
export function banner({ kind = 'info', iconName = null, text, action = null, onClose = null }) {
  const node = el('div', { class: `kit-banner${kind === 'info' ? '' : ` kit-banner--${kind}`}`, role: kind === 'danger' ? 'alert' : 'status' },
    iconName ? icon(iconName) : null,
    el('span', { text }),
    action ? el('button', {
      type: 'button', class: `kit-btn kit-btn--small${action.primary === false ? '' : ' kit-btn--primary'}`,
      text: action.label, onClick: action.onClick,
    }) : null,
    onClose ? el('button', {
      type: 'button', class: 'kit-icon-btn', 'aria-label': t('kit.close'), onClick: () => { node.remove(); onClose(); },
    }, icon('x')) : null);
  return markOwned(node);
}

/**
 * Where a save stands, next to what is saved: 'saving', 'saved', 'local'
 * (kept on this device, its answer slow to come), 'offline' (kept on this
 * device, to be sent), 'error' or 'conflict'. Returns the node
 * and a setter.
 */
export function saveState(initial = 'saved') {
  const node = el('span', { class: 'kit-saved', role: 'status', 'aria-live': 'polite' });
  const set = (state) => {
    node.className = `kit-saved${['offline', 'error', 'conflict'].includes(state) ? ` kit-saved--${state === 'conflict' ? 'error' : state}` : ''}`;
    node.replaceChildren(
      state === 'saving' ? el('span', { class: 'kit-spinner', 'aria-hidden': 'true' })
        : icon(state === 'saved' ? 'check' : state === 'local' ? 'device' : state === 'offline' ? 'wifi-off' : 'info'),
      el('span', { text: t(`kit.saveState.${state}`) }));
  };
  set(initial);
  return { node, set };
}

/* --------------------------------- fields --------------------------------- */

/** What a <label for> can name; anything else (a palette of buttons, a group) is not a control. */
const LABELABLE = new Set(['BUTTON', 'INPUT', 'METER', 'OUTPUT', 'PROGRESS', 'SELECT', 'TEXTAREA']);

/**
 * A label, the control and, optionally, a hint under it. The label is tied with `for`, never by
 * wrapping the control: wrapping forwards the activation, and a date input then opens its
 * calendar and closes it in the same gesture.
 *
 * The options keep an app's own look: `class` for the wrapper, `hintClass` and `hintTag` for the
 * hint, and `groupLabel: true` writes the label as a <span> when what it names isn't something a
 * <label> can name (a palette of buttons), leaving the control's id alone. Without options, the
 * kit's field as it has always been.
 */
export function field(label, control, hint = null, options = {}) {
  const { class: className = 'kit-field', hintClass = 'kit-hint', hintTag = 'p', groupLabel = false } = options;
  const labelable = !groupLabel || (control?.tagName && LABELABLE.has(control.tagName));
  let id = null;
  if (labelable) {
    id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
    control.id = id;
  }
  const hintNode = hint ? el(hintTag, { class: hintClass, id: id && `${id}-hint`, text: hint }) : null;
  if (hintNode && id) control.setAttribute('aria-describedby', `${id}-hint`);
  const header = labelable ? el('label', { for: id, text: label }) : el('span', { text: label });
  return el('div', { class: className }, header, control, hintNode);
}

/** An on/off switch with its label; `onChange(checked)` may throw to put it back. */
export function switchRow(label, { checked = false, hint = null, onChange = null } = {}) {
  const button = el('button', { type: 'button', class: 'kit-switch', role: 'switch', 'aria-checked': String(Boolean(checked)), 'aria-label': label });
  button.addEventListener('click', async () => {
    const next = button.getAttribute('aria-checked') !== 'true';
    button.setAttribute('aria-checked', String(next));
    try {
      await onChange?.(next);
    } catch {
      button.setAttribute('aria-checked', String(!next));
    }
  });
  return el('div', { class: 'kit-switch-row' },
    el('span', {}, label, hint ? el('small', { text: hint }) : null),
    button);
}

/** One choice among a few, side by side: [{ value, label }]. */
export function segmented(options, value, onChange) {
  const group = el('div', { class: 'kit-segmented', role: 'group' });
  const paint = (current) => {
    for (const button of group.children) button.setAttribute('aria-pressed', String(button.dataset.value === current));
  };
  for (const option of options) {
    group.append(el('button', {
      type: 'button', 'data-value': option.value, text: option.label,
      onClick: () => { paint(option.value); onChange?.(option.value); },
    }));
  }
  paint(value);
  return group;
}

/** A centred message for a place with nothing in it yet, with what to do about it. */
export function blank({ iconName = 'inbox', title, text = null, action = null }) {
  return el('div', { class: 'kit-blank' },
    el('span', { class: 'kit-blank__icon' }, icon(iconName)),
    el('strong', { text: title }),
    text ? el('p', { text }) : null,
    action ? el('button', { type: 'button', class: 'kit-btn kit-btn--primary kit-btn--small', onClick: action.onClick },
      action.iconName ? icon(action.iconName) : null, action.label) : null);
}

/** The initials of a name on a circle: what stands for a person. */
export function avatar(name = '') {
  const initials = String(name).trim().split(/\s+/).slice(0, 2).map((word) => word[0] || '').join('').toUpperCase();
  return el('span', { class: 'kit-avatar', 'aria-hidden': 'true', text: initials || '·' });
}

/** "by Cronum Studio": the brand that signs every app, in English in every language. */
export function signature() {
  return el('a', { class: 'cronum-sig', href: 'https://cronumstudio.com', target: '_blank', rel: 'noopener' },
    el('span', { text: 'by' }),   // i18n-exempt: the signature is the same in every language
    cronumRing(),
    el('strong', { text: 'Cronum Studio' }));   // i18n-exempt: a name
}

/**
 * Copies a text, saying so. Without a clipboard (an address that isn't
 * https), `fallback` —the node that shows it— is left selected for a manual copy.
 */
export async function copyText(text, fallback = null) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('kit.copied'));
  } catch {
    if (fallback) window.getSelection()?.selectAllChildren(fallback);
  }
}

/* ---------------------------------- folds --------------------------------- */

/** What is moving now, so a second tap turns it back from where it got to. */
const sliding = new WeakMap();
const SLIDE = { duration: 320, easing: 'cubic-bezier(.4, 0, .2, 1)' };
/** Where the person asks for less motion: no sliding, only a short fade (as Apple's Reduce Motion does). */
const FADE = { duration: 160, easing: 'ease-out' };

/**
 * How a fold moves: 'slide' (its height, its content fading with it), 'fade' where the person asks
 * for less motion, or null where nothing can be animated (a test's page): at once.
 */
const motionFor = (node) => (typeof node.animate !== 'function' ? null
  : globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'fade' : 'slide');

/**
 * Moves `node` from height `from` to `to` out of `full` (what it folds, open), each plus `base`
 * (what stays in sight, a summary), fading `faded` (it, or what is under a summary) with it, then
 * `done()`; one already moving is turned back. With 'fade', only `faded` fades, in or out.
 *
 * Its padding shrinks with it (a fold of its own, no `base`): a height can't go below it, and the
 * fold would stop short and then vanish. Each motion holds its last frame until `done()` has put
 * the fold as it ends, and only then lets go: a frame drawn in between (Safari draws one) would
 * show the fold whole for an instant, a blink.
 */
function move(node, { from, to, full, base = 0, faded = [node], how, done }) {
  if (from === to) {
    done();
    return Promise.resolve();
  }
  const share = (height) => (full > 0 ? Math.min(1, Math.max(0, height / full)) : 1);
  const timing = { ...(how === 'fade' ? FADE : SLIDE), fill: 'forwards' };
  const style = base ? null : getComputedStyle(node);
  const [top, bottom] = style ? [parseFloat(style.paddingTop) || 0, parseFloat(style.paddingBottom) || 0] : [0, 0];
  const frame = (height) => ({
    height: `${height + base}px`,
    ...(top || bottom ? { paddingTop: `${top * share(height)}px`, paddingBottom: `${bottom * share(height)}px` } : {}),
  });
  const fades = faded.map((part) => part.animate([{ opacity: share(from) }, { opacity: share(to) }], timing));
  const motions = how === 'fade' ? fades : [node.animate([frame(from), frame(to)], timing), ...fades];
  if (how !== 'fade') node.style.overflow = 'hidden';
  const letGo = () => motions.forEach((m) => m.cancel());
  const together = { cancel: letGo };
  sliding.set(node, together);
  return Promise.all(motions.map((m) => m.finished)).then(() => {
    if (sliding.get(node) !== together) return;
    sliding.delete(node);
    done();
    node.style.overflow = '';
    letGo();
  }, () => { /* turned back: the next move took over */ });
}

/**
 * Shows or hides `node` (its `hidden`) with its height sliding and its content fading, so a fold of
 * a list opens and closes in a short movement instead of at once; a short fade where the person
 * asks for less motion. A tap in the middle turns it back from where it got to. → a promise,
 * settled when it ends.
 */
export function slideHidden(node, hide) {
  const how = motionFor(node);
  if (!how) {
    node.toggleAttribute('hidden', hide);
    return Promise.resolve();
  }
  const from = node.hasAttribute('hidden') ? 0 : node.getBoundingClientRect().height;
  sliding.get(node)?.cancel();
  node.removeAttribute('hidden');
  const full = node.getBoundingClientRect().height;
  return move(node, { from, to: hide ? 0 : full, full, how, done: () => node.toggleAttribute('hidden', hide) });
}

const summaryOf = (details) => [...details.children].find((node) => node.tagName === 'SUMMARY');

/** Opens or closes a <details> sliding, its summary always in sight; `data-closing` while it closes. */
function slideDetails(details, open) {
  const how = motionFor(details);
  if (!how) {
    details.open = open;
    return Promise.resolve();
  }
  const summary = summaryOf(details);
  const from = details.getBoundingClientRect().height;
  sliding.get(details)?.cancel();
  details.open = true;
  const full = details.getBoundingClientRect().height;
  const shut = (summary?.getBoundingClientRect().height || 0) + details.offsetHeight - details.clientHeight;
  details.toggleAttribute('data-closing', !open);
  // What fades is what the summary folds; the heights count from the summary alone.
  return move(details, {
    from: from - shut, to: open ? full - shut : 0, full: full - shut, base: shut, how,
    faded: [...details.children].filter((node) => node !== summary),
    done: () => {
      details.open = open;
      details.removeAttribute('data-closing');
    },
  });
}

/**
 * A <details> that opens and closes sliding. Those of one `name` side by side stay one open at a
 * time, the one that was open closing as this one opens: the browser's own `name` would shut it at
 * once, so it moves to `data-fold`. → the details.
 */
export function slidingDetails(details) {
  const name = details.getAttribute('name');
  if (name) {
    details.removeAttribute('name');
    details.dataset.fold = name;
  }
  summaryOf(details)?.addEventListener('click', (event) => {
    event.preventDefault();
    const open = !details.open || details.hasAttribute('data-closing');
    if (open && name) {
      for (const other of details.parentNode?.children || []) {
        if (other !== details && other.dataset?.fold === name && other.open && !other.hasAttribute('data-closing')) slideDetails(other, false);
      }
    }
    slideDetails(details, open);
  });
  return details;
}

/* ------------------------------- edge back -------------------------------- */

/** What covers the frame with a way back of its own, the last one on top. This copy's only. */
const backs = [];

/**
 * A page over the frame with a way back of its own (Settings: from a section to its list, then
 * out) takes the swipe from the screen's start edge while it is open, as the frame's back button
 * does under it (shell.js). Each module's copy of the kit keeps its own, so in Work's shell only
 * the window that opened it goes back. → a function that lets it go.
 *
 * `slide()`, asked when the finger starts to go, says what follows it: `{ moving, under, show }`,
 * the screen that slides away, the one it uncovers (optional) and `show(on)`, which draws that
 * one beneath while the finger leads. Without it, the page goes back at once.
 */
export function holdBack(node, back, slide = null) {
  const held = { node, back, slide };
  backs.push(held);
  return () => {
    const at = backs.indexOf(held);
    if (at >= 0) backs.splice(at, 1);
  };
}

/** The page on top, `{ back, slide }`, when `target` is on it; else null. */
export function heldBack(target) {
  const top = backs.at(-1);
  return top && top.node.contains(target) ? top : null;
}

/* --------------------------------- dialogs -------------------------------- */

/** The kit's dialogs open now, the last one on top: Escape is the top one's alone. */
const openDialogs = [];

/** An action's button: primary, danger or quiet. */
function actionButton(action, onClick) {
  return el('button', {
    type: action.submit ? 'submit' : 'button',
    class: `kit-btn${action.primary ? ' kit-btn--primary' : ''}${action.danger ? ' kit-btn--danger' : ''}${!action.primary && !action.danger ? ' kit-btn--quiet' : ''}`,
    onClick,
  }, action.iconName ? icon(action.iconName) : null, action.label);
}

/** Adds classes to a node a module built itself (a body, a foot), keeping its own. */
function addClass(node, name) {
  const current = node.getAttribute('class') || '';
  if (!current.split(/\s+/).includes(name)) node.setAttribute('class', `${current} ${name}`.trim());
  return node;
}

/**
 * The frame every kit dialog shares: the native <dialog> (focus trapped, the rest of the page
 * inert), a header with the title (or `header`, a node of its own), `tools` before the ×, `bar`
 * under the header and out of the scroll; the caller adds the rest and `show()`s it. On a phone it rises
 * from the bottom as a sheet (kit.css). A tap on the backdrop closes it; Escape closes only the
 * top one, and only once a menu open inside it is closed. `busy()` runs one action at a time:
 * while it waits every button in the footer is disabled, so a double click can't do it twice.
 */
function frame({
  title = '', subtitle = '', header = null, tools = null, bar = null, wide = false, width = null,
  className = '', parent = null, onClose = null,
}) {
  // A menu left open would sit beside the dialog: a dialog comes from a choice, so the menu is done.
  closeMenu();
  const dialog = el('dialog', {
    class: `kit-dialog${wide ? ' kit-dialog--wide' : ''}${className ? ` ${className}` : ''}`,
    'aria-label': title || null,
    // A width of its own (`420px`): a variable, so a phone's sheet still takes the whole width.
    style: width ? `--kit-dialog-width: ${width}` : null,
  });
  const close = () => { if (dialog.open) dialog.close(); };
  const heading = header || (subtitle
    ? el('div', { class: 'kit-dialog__titles' }, el('h2', { text: title }), el('p', { class: 'kit-dialog__subtitle', text: subtitle }))
    : el('h2', { text: title }));
  append(dialog,
    el('div', { class: 'kit-dialog__grab', 'aria-hidden': 'true' }),
    el('header', { class: 'kit-dialog__header' },
      heading,
      tools ? el('div', { class: 'kit-dialog__tools' }, tools) : null,
      el('button', { type: 'button', class: 'kit-icon-btn', 'aria-label': t('kit.close'), onClick: close }, icon('x'))),
    bar);

  let footer = null;
  let running = null;
  /** Runs `job` unless another is running; while it waits the footer's buttons are disabled. */
  const busy = async (job) => {
    if (running) return undefined;
    const buttons = footer ? [...footer.querySelectorAll('button')] : [];
    const before = buttons.map((b) => b.disabled);
    for (const b of buttons) b.disabled = true;
    running = (async () => job())();
    try {
      return await running;
    } finally {
      running = null;
      buttons.forEach((b, i) => { b.disabled = before[i]; });
    }
  };

  // A tap on the backdrop closes it, as on a phone's sheet; not a press that began inside and was
  // let go outside (selecting a field's text), which the browser also calls a click on the dialog.
  let pressedInside = false;
  dialog.addEventListener('pointerdown', (ev) => { pressedInside = ev.target !== dialog; });
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog && !pressedInside) close();
    pressedInside = false;
  });
  // Escape: the browser asks the top modal dialog; a menu open in it goes first, and a dialog
  // that isn't the kit's top one (a key that reached it anyway) stays.
  dialog.addEventListener('cancel', (ev) => {
    if (openMenuNode && dialog.contains(openMenuNode)) {
      ev.preventDefault();
      closeMenu();
    } else if (openDialogs.at(-1) !== dialog) {
      ev.preventDefault();
    }
  });
  dialog.addEventListener('close', () => {
    const at = openDialogs.indexOf(dialog);
    if (at >= 0) openDialogs.splice(at, 1);
    dialog.remove();
    onClose?.();
  });
  const show = () => {
    // In `parent` when the module keeps its dialogs in its own place (its window in Cronum Work);
    // shown modal it still goes over everything.
    (parent || document.body).append(markOwned(dialog));
    openDialogs.push(dialog);
    dialog.showModal();
  };
  return { dialog, close, busy, show, setFooter: (node) => { footer = node; } };
}

/**
 * A dialog with a title, its content and a row of actions. An action's
 * `onClick` may return false to keep the dialog open (a failed save); while it
 * waits, every action is disabled. Without actions there is no footer: the ×
 * in the header closes it. On a phone it rises from the bottom as a sheet
 * (kit.css).
 *
 * Optional: `width` ('420px', within the screen), `className`, `parent` (where
 * it hangs; the page's body by default), and for a screen that draws its own
 * parts, `body` and `footer` (nodes used as they are, with the kit's classes
 * added) in place of `content` and `actions`.
 */
export function openDialog({
  title, content = null, actions = [], wide = false, width = null, className = '', parent = null,
  body = null, footer = null, onClose = null,
}) {
  const parts = frame({ title, wide, width, className, parent, onClose });
  const { dialog, close, busy } = parts;
  const buttons = (actions || []).map((action) => actionButton(action, () => busy(async () => {
    if ((await action.onClick?.()) !== false) close();
  })));
  const foot = footer ? addClass(footer, 'kit-dialog__footer')
    : buttons.length ? el('footer', { class: 'kit-dialog__footer' }, buttons) : null;
  parts.setFooter(foot);
  // The kit's append and not the dialog's own: that one writes a missing footer as the text "null".
  append(dialog, body ? addClass(body, 'kit-dialog__body') : el('div', { class: 'kit-dialog__body' }, content), foot);
  parts.show();
  return { dialog, close };
}

/**
 * A dialog that is a form: what Next's dialogs were, for every module.
 *
 * `onSubmit(form)` runs for a `submit: true` action, Enter in a field or
 * Ctrl/Cmd+Enter (inside a long text, where Enter is a new line); what it throws
 * is shown inside the dialog (`errorText(err)`, the kit's errorMessage by
 * default), which stays open to be corrected, and returning false keeps it open
 * too. One send at a time: while it waits every button of the footer is
 * disabled. An action with `onClick` runs the same way; one with neither just
 * closes (Cancel).
 *
 * `header` replaces the title and `subtitle`; `tools` go before the ×; `bar`
 * sits under the header and out of the scroll (tabs); `extra` between the body
 * and the footer. The footer can change while it is open (`setActions`); with no
 * actions it isn't shown. Returns { dialog, form, close, setActions, showError }.
 */
export function formDialog({
  title = '', subtitle = '', header = null, tools = null, bar = null, extra = null,
  content = null, actions = [], onSubmit = null, errorText = errorMessage,
  wide = false, width = null, className = '', parent = null, onClose = null,
}) {
  const parts = frame({ title, subtitle, header, tools, bar, wide, width, className: `kit-dialog--form${className ? ` ${className}` : ''}`, parent, onClose });
  const { dialog, close, busy } = parts;
  const error = el('p', { class: 'kit-dialog__error', role: 'alert', hidden: true });
  const footer = el('footer', { class: 'kit-dialog__footer' });
  const form = el('form', { class: 'kit-dialog__form', method: 'dialog', novalidate: true },
    el('div', { class: 'kit-dialog__body' }, content, error),
    extra ? el('div', { class: 'kit-dialog__extra' }, extra) : null,
    footer);
  parts.setFooter(footer);

  const showError = (err) => {
    const text = err == null ? '' : typeof err === 'string' ? err : errorText(err);
    error.textContent = text;
    error.toggleAttribute('hidden', !text);
  };
  /** Runs `job`; what it throws is shown, and anything but false closes the dialog. */
  const run = (job) => busy(async () => {
    showError(null);
    try {
      if ((await job()) !== false) close();
    } catch (err) {
      showError(err);
    }
  });
  const submit = () => (onSubmit ? run(() => onSubmit(form)) : undefined);

  const setActions = (list = []) => {
    showError(null);
    clear(footer);
    append(footer, (list || []).map((action) => actionButton(action, action.submit ? null
      : () => (action.onClick ? run(action.onClick) : close()))));
    footer.toggleAttribute('hidden', !footer.children.length);
  };
  setActions(actions);
  form.addEventListener('submit', (ev) => { ev.preventDefault(); submit(); });
  form.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submit(); }
  });
  append(dialog, form);
  parts.show();
  return { dialog, form, close, setActions, showError, submit };
}

/**
 * Asks before something that can't be undone. Resolves true or false.
 * `detail` is a second, quieter line; `width` and `parent` as openDialog's.
 */
export function confirmDialog(text, {
  title = t('kit.areYouSure'), confirm = t('kit.confirm'), cancel = t('kit.cancel'), danger = true,
  detail = null, width = null, parent = null,
} = {}) {
  return new Promise((resolve) => {
    let answer = false;
    openDialog({
      title,
      width,
      parent,
      content: [el('p', { text }), detail ? el('p', { class: 'kit-hint', text: detail }) : null],
      actions: [
        { label: cancel },
        { label: confirm, primary: !danger, danger, onClick: () => { answer = true; } },
      ],
      onClose: () => resolve(answer),
    });
  });
}

/* ---------------------------------- menus --------------------------------- */

let openMenuNode = null;

/**
 * A menu under (or above) `anchor`: items are { label, iconName, image, glyph,
 * onClick, href, external, danger, current }, or 'separator' (`image`, a
 * picture's address in place of an icon: a module's own; `glyph`, a character
 * in its place, an emoji; `current`, the one in use now, with a tick); `header`
 * is a node on top (what the menu is about). `at` ({ x, y }, a pointer's place)
 * puts it there instead of under the anchor; `parent` is where it hangs (the
 * page's body by default; inside a modal dialog, always that dialog). Arrows
 * move, Escape and a click outside close it.
 */
export function menu(anchor, items, { header = null, at = null, parent = null } = {}) {
  closeMenu();
  const entries = items.map((item) => {
    if (item === 'separator') return el('div', { class: 'kit-menu__sep', role: 'separator' });
    const props = {
      class: `kit-menu__item${item.danger ? ' kit-menu__item--danger' : ''}`, role: 'menuitem', tabindex: '-1',
      ...(item.current ? { 'aria-current': 'true' } : {}),
    };
    const picture = item.image ? el('img', { class: 'kit-menu__image', src: item.image, alt: '', width: 20, height: 20 })
      : item.iconName ? icon(item.iconName)
        : item.glyph ? el('span', { class: 'kit-menu__glyph', 'aria-hidden': 'true', text: item.glyph }) : null;
    const children = [picture, el('span', { text: item.label }),
      item.external ? el('span', { class: 'kit-menu__end' }, icon('external'))
        : item.current ? el('span', { class: 'kit-menu__end' }, icon('check')) : null];
    const node = item.href
      ? el('a', { ...props, href: item.href, ...(item.external ? { target: '_blank', rel: 'noopener' } : {}) }, children)
      : el('button', { ...props, type: 'button' }, children);
    node.addEventListener('click', () => { closeMenu(); item.onClick?.(); });
    return node;
  });
  const node = el('div', { class: 'kit-menu', role: 'menu' }, header ? el('div', { class: 'kit-menu__who' }, header) : null, entries);
  // Under a modal dialog the rest of the page is inert: a menu opened from one goes inside it.
  (anchor?.closest?.('dialog[open]') || parent || document.body).append(markOwned(node));
  openMenuNode = node;

  // Below the anchor when it fits, else above; never off the screen. Measured from where (0, 0)
  // lands, as a dialog that moves (a sheet rising) is the menu's frame and not the window.
  node.style.left = '0px';
  node.style.top = '0px';
  const origin = node.getBoundingClientRect();
  // Its room: the screen, or in Cronum Work the module's window, which cuts off whatever leaves it
  // (windows.css). A modal dialog is drawn above everything, so a menu in one has the screen.
  const clip = node.parentElement.closest('dialog[open], .cw-win__body');
  const frame = clip && clip.tagName !== 'DIALOG' ? clip.getBoundingClientRect()
    : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  // A pointer's place is a box of no size; a keyboard's click (at 0, 0) goes by the anchor.
  const point = at && (at.x || at.y) ? at : null;
  const box = point ? { left: point.x, top: point.y, bottom: point.y }
    : anchor?.getBoundingClientRect?.() || { left: frame.left + 8, top: frame.top + 8, bottom: frame.top + 8 };
  const width = Math.min(Math.max(node.offsetWidth, 220), frame.right - frame.left - 16);
  node.style.width = `${width}px`;
  node.style.left = `${Math.min(Math.max(frame.left + 8, box.left), frame.right - width - 8) - origin.left}px`;
  // Longer than its room (a short window), it scrolls.
  if (node.offsetHeight > frame.bottom - frame.top - 16) {
    node.style.maxHeight = `${frame.bottom - frame.top - 16}px`;
    node.style.overflowY = 'auto';
  }
  const height = node.offsetHeight;
  const gap = point ? 0 : 6;
  if (box.bottom + height + 8 > frame.bottom && box.top - frame.top > height + 8) {
    node.style.top = `${box.top - height - gap - origin.top}px`;
  } else {
    node.style.top = `${Math.max(frame.top + 8, Math.min(box.bottom + gap, frame.bottom - height - 8)) - origin.top}px`;
  }
  anchor?.setAttribute?.('aria-expanded', 'true');

  const focusable = () => [...node.querySelectorAll('[role="menuitem"]')];
  focusable()[0]?.focus();
  const onKey = (ev) => {
    const list = focusable();
    const index = list.indexOf(document.activeElement);
    if (ev.key === 'Escape') {
      // The menu's Escape, not the dialog's under it too.
      ev.preventDefault?.();
      closeMenu();
      anchor?.focus?.();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      list[(index + 1) % list.length]?.focus();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      list[(index - 1 + list.length) % list.length]?.focus();
    }
  };
  const onOutside = (ev) => { if (!node.contains(ev.target) && !anchor?.contains?.(ev.target)) closeMenu(); };
  document.addEventListener('keydown', onKey);
  // On the next turn: the click that opened it must not close it. Not if it was closed by then
  // (a frame destroyed at once): cleanUp has already run, and the listener would stay forever.
  setTimeout(() => { if (openMenuNode === node) document.addEventListener('pointerdown', onOutside); }, 0);
  node.cleanUp = () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onOutside);
    anchor?.setAttribute?.('aria-expanded', 'false');
  };
  return node;
}

export function closeMenu() {
  if (!openMenuNode) return;
  openMenuNode.cleanUp?.();
  openMenuNode.remove();
  openMenuNode = null;
}
