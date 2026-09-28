/**
 * What every screen of the suite needs: notices that come and go, dialogs
 * (the browser's own <dialog>, which traps focus and closes with Escape),
 * and labelled fields.
 */
import { el, $ } from './dom.js';
import { t } from './i18n.js';

/** A notice for a few seconds; errors stay a little longer. */
export function toast(text, { error = false } = {}) {
  let box = $('#kit-toasts');
  if (!box) {
    box = el('div', { id: 'kit-toasts', class: 'kit-toasts', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const note = el('div', { class: `kit-toast${error ? ' kit-toast--error' : ''}`, role: error ? 'alert' : 'status', text });
  box.append(note);
  setTimeout(() => note.remove(), error ? 7000 : 3500);
}

/** A label, the control and, optionally, a hint under it. */
export function field(label, control, hint = null) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return el('div', { class: 'kit-field' },
    el('label', { for: id, text: label }),
    control,
    hint ? el('p', { class: 'kit-hint', text: hint }) : null);
}

/**
 * A dialog with a title, its content and a row of actions. An action's
 * `onClick` may return false to keep the dialog open (a failed save).
 */
export function openDialog({ title, content, actions = [], wide = false }) {
  const dialog = el('dialog', { class: `kit-dialog${wide ? ' kit-dialog--wide' : ''}` });
  const close = () => { dialog.close(); dialog.remove(); };
  const buttons = actions.map((action) => el('button', {
    type: 'button',
    class: `kit-btn${action.primary ? ' kit-btn--primary' : ''}${action.danger ? ' kit-btn--danger' : ''}`,
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
    el('header', { class: 'kit-dialog__header' },
      el('h2', { text: title }),
      el('button', { type: 'button', class: 'kit-icon-btn', 'aria-label': t('admin.close'), text: '×', onClick: close })),
    el('div', { class: 'kit-dialog__body' }, content),
    buttons.length ? el('footer', { class: 'kit-dialog__footer' }, buttons) : null,
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

/** Asks before something that can't be undone. Resolves true or false. */
export function confirmDialog(text, { confirm = t('admin.confirm'), danger = true } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const { dialog } = openDialog({
      title: t('admin.areYouSure'),
      content: el('p', { text }),
      actions: [
        { label: t('admin.cancel'), onClick: () => { answered = true; resolve(false); } },
        { label: confirm, primary: !danger, danger, onClick: () => { answered = true; resolve(true); } },
      ],
    });
    dialog.addEventListener('close', () => { if (!answered) resolve(false); });
  });
}
