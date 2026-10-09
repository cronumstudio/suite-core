/**
 * What every screen of the suite needs: notices that come and go (with an
 * undo or a retry), banners for a state that lasts, dialogs (the browser's
 * own <dialog>, which traps focus and closes with Escape; a sheet from the
 * bottom on a phone), menus, labelled fields, switches and the signature.
 */
import { el, $ } from './dom.js';
import { t } from './i18n.js';
import { icon, cronumRing } from './icons.js';

/* --------------------------------- notices -------------------------------- */

/**
 * A notice for a few seconds; errors stay longer. `action` adds a button
 * ("Undo", "Retry") that runs and closes it. Returns a function that closes it.
 */
export function toast(text, { error = false, action = null, duration = null } = {}) {
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
  box.append(note);
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
  return node;
}

/**
 * Where a save stands, next to what is saved: 'saving', 'saved', 'offline'
 * (kept on this device, to be sent), 'error' or 'conflict'. Returns the node
 * and a setter.
 */
export function saveState(initial = 'saved') {
  const node = el('span', { class: 'kit-saved', role: 'status', 'aria-live': 'polite' });
  const set = (state) => {
    node.className = `kit-saved${['offline', 'error', 'conflict'].includes(state) ? ` kit-saved--${state === 'conflict' ? 'error' : state}` : ''}`;
    node.replaceChildren(
      state === 'saving' ? el('span', { class: 'kit-spinner', 'aria-hidden': 'true' })
        : icon(state === 'saved' ? 'check' : state === 'offline' ? 'wifi-off' : 'info'),
      el('span', { text: t(`kit.saveState.${state}`) }));
  };
  set(initial);
  return { node, set };
}

/* --------------------------------- fields --------------------------------- */

/** A label, the control and, optionally, a hint under it. */
export function field(label, control, hint = null) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  const hintNode = hint ? el('p', { class: 'kit-hint', id: `${id}-hint`, text: hint }) : null;
  if (hintNode) control.setAttribute('aria-describedby', hintNode.id);
  return el('div', { class: 'kit-field' }, el('label', { for: id, text: label }), control, hintNode);
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

/* --------------------------------- dialogs -------------------------------- */

/**
 * A dialog with a title, its content and a row of actions. An action's
 * `onClick` may return false to keep the dialog open (a failed save). On a
 * phone it rises from the bottom as a sheet (kit.css).
 */
export function openDialog({ title, content, actions = [], wide = false, onClose = null }) {
  // A menu left open would sit beside the dialog: a dialog comes from a choice, so the menu is done.
  closeMenu();
  const dialog = el('dialog', { class: `kit-dialog${wide ? ' kit-dialog--wide' : ''}`, 'aria-label': title });
  const close = () => { if (dialog.open) dialog.close(); };
  const buttons = actions.map((action) => el('button', {
    type: 'button',
    class: `kit-btn${action.primary ? ' kit-btn--primary' : ''}${action.danger ? ' kit-btn--danger' : ''}${!action.primary && !action.danger ? ' kit-btn--quiet' : ''}`,
    text: action.label,
    onClick: async (ev) => {
      const button = ev.currentTarget;
      button.disabled = true;
      try {
        if ((await action.onClick?.()) !== false) close();
      } finally {
        button.disabled = false;
      }
    },
  }));
  dialog.append(
    el('div', { class: 'kit-dialog__grab', 'aria-hidden': 'true' }),
    el('header', { class: 'kit-dialog__header' },
      el('h2', { text: title }),
      el('button', { type: 'button', class: 'kit-icon-btn', 'aria-label': t('kit.close'), onClick: close }, icon('x'))),
    el('div', { class: 'kit-dialog__body' }, content),
    buttons.length ? el('footer', { class: 'kit-dialog__footer' }, buttons) : null,
  );
  // A tap on the backdrop closes it, as on a phone's sheet.
  dialog.addEventListener('click', (ev) => { if (ev.target === dialog) close(); });
  dialog.addEventListener('close', () => { dialog.remove(); onClose?.(); });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

/** Asks before something that can't be undone. Resolves true or false. */
export function confirmDialog(text, { title = t('kit.areYouSure'), confirm = t('kit.confirm'), danger = true } = {}) {
  return new Promise((resolve) => {
    let answer = false;
    openDialog({
      title,
      content: el('p', { text }),
      actions: [
        { label: t('kit.cancel') },
        { label: confirm, primary: !danger, danger, onClick: () => { answer = true; } },
      ],
      onClose: () => resolve(answer),
    });
  });
}

/* ---------------------------------- menus --------------------------------- */

let openMenuNode = null;

/**
 * A menu under (or above) `anchor`: items are { label, iconName, image,
 * onClick, href, external, danger }, or 'separator' (`image`, a picture's
 * address in place of an icon: a module's own); `header` is a node on top
 * (what the menu is about). Arrows move, Escape and a click outside close it.
 */
export function menu(anchor, items, { header = null } = {}) {
  closeMenu();
  const entries = items.map((item) => {
    if (item === 'separator') return el('div', { class: 'kit-menu__sep', role: 'separator' });
    const props = {
      class: `kit-menu__item${item.danger ? ' kit-menu__item--danger' : ''}`, role: 'menuitem', tabindex: '-1',
    };
    const picture = item.image ? el('img', { class: 'kit-menu__image', src: item.image, alt: '', width: 20, height: 20 })
      : item.iconName ? icon(item.iconName) : null;
    const children = [picture, el('span', { text: item.label }),
      item.external ? el('span', { class: 'kit-menu__end' }, icon('external')) : null];
    const node = item.href
      ? el('a', { ...props, href: item.href, ...(item.external ? { target: '_blank', rel: 'noopener' } : {}) }, children)
      : el('button', { ...props, type: 'button' }, children);
    node.addEventListener('click', () => { closeMenu(); item.onClick?.(); });
    return node;
  });
  const node = el('div', { class: 'kit-menu', role: 'menu' }, header ? el('div', { class: 'kit-menu__who' }, header) : null, entries);
  // Under a modal dialog the rest of the page is inert: a menu opened from one goes inside it.
  (anchor.closest?.('dialog[open]') || document.body).append(node);
  openMenuNode = node;

  // Below the anchor when it fits, else above; never off the screen. Measured from where (0, 0)
  // lands, as a dialog that moves (a sheet rising) is the menu's frame and not the window.
  node.style.left = '0px';
  node.style.top = '0px';
  const origin = node.getBoundingClientRect();
  const box = anchor.getBoundingClientRect();
  const width = Math.min(Math.max(node.offsetWidth, 220), window.innerWidth - 16);
  node.style.width = `${width}px`;
  node.style.left = `${Math.min(Math.max(8, box.left), window.innerWidth - width - 8) - origin.left}px`;
  if (box.bottom + node.offsetHeight + 8 > window.innerHeight && box.top > node.offsetHeight + 8) {
    node.style.top = `${box.top - node.offsetHeight - 6 - origin.top}px`;
  } else {
    node.style.top = `${Math.min(box.bottom + 6, window.innerHeight - node.offsetHeight - 8) - origin.top}px`;
  }
  anchor.setAttribute('aria-expanded', 'true');

  const focusable = () => [...node.querySelectorAll('[role="menuitem"]')];
  focusable()[0]?.focus();
  const onKey = (ev) => {
    const list = focusable();
    const at = list.indexOf(document.activeElement);
    if (ev.key === 'Escape') { closeMenu(); anchor.focus(); } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      list[(at + 1) % list.length]?.focus();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      list[(at - 1 + list.length) % list.length]?.focus();
    }
  };
  const onOutside = (ev) => { if (!node.contains(ev.target) && !anchor.contains(ev.target)) closeMenu(); };
  document.addEventListener('keydown', onKey);
  // On the next turn: the click that opened it must not close it.
  setTimeout(() => document.addEventListener('pointerdown', onOutside), 0);
  node.cleanUp = () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onOutside);
    anchor.setAttribute('aria-expanded', 'false');
  };
  return node;
}

export function closeMenu() {
  if (!openMenuNode) return;
  openMenuNode.cleanUp?.();
  openMenuNode.remove();
  openMenuNode = null;
}
