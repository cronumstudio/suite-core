/**
 * Choosing a collection's colour and its icon, the same in every module (audit of 6/11,
 * ui-dialogos-9): the kit's twelve colours by name, and twenty icons in view with «Más…» for the
 * rest (palette.js). What it has now and the palette no longer offers is kept, shown first.
 */
import { el } from './dom.js';
import { t } from './i18n.js';
import { KIT_COLORS, kitColor, KIT_ICONS, KIT_MORE_ICONS } from './palette.js';

const press = (node, on) => node.setAttribute('aria-pressed', String(Boolean(on)));

/**
 * The palette as swatches. `value` is the colour it has now: a #rrggbb (`as: 'hex'`, what Tasks,
 * Notes and Projects store) or a name (`as: 'name'`, Next's). One the palette doesn't have (from
 * before, or set through an assistant) is offered first, marked, painted with `paint(value)`
 * (by default the value itself, a hex) and named with `nameOf(value)` if given.
 * `none: { label, swatch }` adds a choice for no colour (Next's «Automático», a group's «Sin
 * color»), a pill with a dot of `swatch` and the label; chosen, the value is null.
 * `label` names the group for a screen reader; `onPick(value)` hears each choice.
 * → { node, value() }.
 */
export function colorPicker({ value = null, as = 'hex', label = null, none = null, paint = null, nameOf = null, onPick = null } = {}) {
  const valueOf = (c) => (as === 'name' ? c.name : c.hex);
  const known = kitColor(value);
  let chosen = known ? valueOf(known) : (value || null);
  const node = el('div', { class: 'kit-swatches', role: 'group', 'aria-label': label });
  const choose = (next) => {
    chosen = next;
    for (const button of node.children) press(button, (button.dataset.color || null) === chosen);
    onPick?.(chosen);
  };
  if (chosen && !known) {
    const old = chosen;
    const kept = t('kit.colors.kept');
    const said = nameOf?.(chosen);
    node.append(el('button', {
      type: 'button', class: 'kit-swatch kit-swatch--kept', 'data-color': chosen,
      style: { '--kit-swatch': paint ? paint(chosen) : chosen },
      'aria-label': said ? `${kept}: ${said}` : kept, title: said || kept,
      onClick: () => choose(old),
    }));
  }
  for (const c of KIT_COLORS) {
    const name = t(`kit.colors.${c.name}`);
    node.append(el('button', {
      type: 'button', class: 'kit-swatch', 'data-color': valueOf(c),
      // A hex is painted as it is stored; a name with its token, a step lighter in the dark.
      style: { '--kit-swatch': as === 'name' ? `var(--kit-color-${c.name})` : c.hex },
      'aria-label': name, title: name,
      onClick: () => choose(valueOf(c)),
    }));
  }
  if (none) {
    node.append(el('button', {
      type: 'button', class: 'kit-swatch-none', 'data-color': '',
      style: none.swatch ? { '--kit-swatch': none.swatch } : null,
      onClick: () => choose(null),
    }, el('span', { class: 'kit-swatch-none__dot' }), none.label));
  }
  for (const button of node.children) press(button, (button.dataset.color || null) === chosen);
  return { node, value: () => chosen };
}

/**
 * The icons: `frequent` in view (the kit's twenty), «Más…» unfolding `more` (the rest of the
 * kit's), each an emoji to press. `value` is the one it has now; one that is not in view is shown
 * first, chosen, so a list keeps an icon no longer offered. `typed: true` adds a short field to type
 * or paste any other (Projects, Next), `none: { label }` a link to leave it without one (Next).
 * `label` names the icons for a screen reader; `onPick(value)` hears each choice.
 * → { node, value() }, the value trimmed, '' for none.
 */
export function iconPicker({
  value = '', label = null, typed = false, maxLength = 16, none = null, frequent = KIT_ICONS, more = KIT_MORE_ICONS, onPick = null,
} = {}) {
  let chosen = String(value || '').trim();
  const inView = new Set(frequent);
  const buttons = [];
  const paint = () => { for (const button of buttons) press(button, button.dataset.icon === chosen); };
  const choose = (icon, { fromField = false } = {}) => {
    chosen = icon;
    if (input && !fromField) input.value = icon;
    paint();
    onPick?.(chosen);
  };
  const pick = (icon, extra = '') => {
    const button = el('button', {
      type: 'button', class: `kit-icon-pick${extra}`, 'data-icon': icon, text: icon, 'aria-label': icon, title: icon,
      onClick: () => choose(icon),
    });
    buttons.push(button);
    return button;
  };

  const input = typed ? el('input', {
    type: 'text', class: 'kit-input kit-icons__typed', maxlength: String(maxLength), autocomplete: 'off',
    'aria-label': t('kit.icons.typed'), placeholder: '🙂', value: chosen,
  }) : null;
  input?.addEventListener('input', () => choose(input.value.trim(), { fromField: true }));

  const kept = chosen && !inView.has(chosen) ? pick(chosen, ' kit-icon-pick--kept') : null;
  if (kept) kept.setAttribute('aria-label', `${t('kit.icons.kept')}: ${chosen}`);
  const rest = more.filter((icon) => !inView.has(icon));
  const all = el('div', { class: 'kit-icons__grid kit-icons__all', hidden: true }, rest.map((icon) => pick(icon)));
  const toggle = rest.length ? el('button', {
    type: 'button', class: 'kit-icons__more', 'aria-expanded': 'false', text: t('kit.icons.more'),
    onClick: () => {
      const open = all.hasAttribute('hidden');
      if (open) all.removeAttribute('hidden');
      else all.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = t(open ? 'kit.icons.less' : 'kit.icons.more');
    },
  }) : null;
  const shown = el('div', { class: 'kit-icons__grid', role: 'group', 'aria-label': label },
    kept, frequent.map((icon) => pick(icon)), toggle);
  const clearIt = none ? el('button', {
    type: 'button', class: 'kit-link kit-icons__none', text: none.label || t('kit.icons.none'),
    onClick: () => choose(''),
  }) : null;
  paint();
  const node = el('div', { class: 'kit-icons' }, input, shown, rest.length ? all : null, clearIt);
  if (input) node.labelTarget = input;
  return { node, value: () => chosen };
}
