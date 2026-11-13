/**
 * One palette and one set of icons for a list, a notebook, a project (web/palette.js), and the
 * pickers that offer them (web/pickers.js), without a browser: the colours measured light and
 * dark, the kit's tokens the same as the list, the free colour proposed, and what a collection has
 * now kept when the palette no longer offers it (audit of 6/11, ui-dialogos-9).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom, FakeElement } from './fake-dom.js';

installFakeDom();
// A style that keeps what setProperty sets, as a browser's does (--kit-swatch).
Object.defineProperty(FakeElement.prototype, 'style', {
  get() { return (this._style ||= { setProperty(name, value) { this[name] = value; } }); },
  set(value) { this._style = value; },
  configurable: true,
});
const { KIT_COLORS, KIT_COLOR_NAMES, kitColor, suggestedColor, KIT_ICONS, KIT_MORE_ICONS } = await import('../web/palette.js');
const { colorPicker, iconPicker } = await import('../web/pickers.js');
const { loadLanguage } = await import('../web/i18n.js');
const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });
await loadLanguage('en', { remember: false });

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
const press = (button) => (button.listeners.click || []).forEach((fn) => fn({ currentTarget: button, target: button }));
const pressed = (node) => node.find('button').filter((b) => b.getAttribute('aria-pressed') === 'true');

test('twelve colours with a name each, white reading on them and each showing on the dark page', () => {
  assert.equal(KIT_COLORS.length, 12);
  assert.equal(new Set(KIT_COLOR_NAMES).size, 12);
  assert.equal(new Set(KIT_COLORS.map((c) => c.hex)).size, 12);
  for (const { name, hex, dark } of KIT_COLORS) {
    assert.match(hex, /^#[0-9a-f]{6}$/, `${name}: lower case, as Tasks stores it`);
    assert.ok(contrast(hex, '#FFFFFF') >= 4.5, `${name}: white on it, ${contrast(hex, '#FFFFFF').toFixed(2)}`);
    assert.ok(contrast(hex, '#1C1914') >= 3, `${name}: on the dark panel, ${contrast(hex, '#1C1914').toFixed(2)}`);
    // Its dark step is text in the dark (Next's lines and names), on the panel and on the page.
    assert.ok(contrast(dark, '#1C1914') >= 4.5, `${name} dark: ${contrast(dark, '#1C1914').toFixed(2)}`);
    assert.ok(contrast(dark, '#14120E') >= 4.5, `${name} dark on the page`);
  }
});

test('kit.css paints each name with the palette\'s values, a step lighter in the dark', () => {
  const css = fs.readFileSync(new URL('../web/kit.css', import.meta.url), 'utf8');
  const root = /^:root \{([\s\S]*?)\n\}/m.exec(css)[1];
  const dark = /^:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/m.exec(css)[1];
  for (const { name, hex, dark: step } of KIT_COLORS) {
    assert.match(root, new RegExp(`--kit-color-${name}: ${hex};`), `${name} light`);
    assert.match(dark, new RegExp(`--kit-color-${name}: ${step};`), `${name} dark`);
  }
});

test('a colour by name or by hex, in any case; anything else is none of them', () => {
  assert.equal(kitColor('Blue').hex, '#2564cf');
  assert.equal(kitColor('#2564CF').name, 'blue');
  assert.equal(kitColor('magenta'), null, 'Next\'s magenta is not offered any more: kept where it is');
  assert.equal(kitColor('#DC2626'), null);
  assert.equal(kitColor(null), null);
});

test('the colour proposed is the first free one, five apart around the wheel', () => {
  assert.equal(suggestedColor([]), '#2564cf');
  assert.equal(suggestedColor(['#2564CF']), KIT_COLORS[5].hex, 'not its neighbour: brown after blue');
  assert.equal(suggestedColor(['blue', null], { as: 'name' }), 'brown', 'by name, for Next');
  // A gap left by one deleted is used again, and colours from outside the palette don't count.
  assert.equal(suggestedColor(['#8a6a45', '#DC2626']), '#2564cf');
  const all = KIT_COLORS.map((c) => c.hex);
  assert.equal(suggestedColor(all), KIT_COLORS[0].hex, 'all in use: by count');
});

test('twenty icons in view, the rest behind «Más…», none twice', () => {
  assert.equal(KIT_ICONS.length, 20);
  const every = [...KIT_ICONS, ...KIT_MORE_ICONS];
  assert.equal(new Set(every).size, every.length);
  assert.ok(every.length >= 164, 'Tasks\' 164 emojis are all still there');
});

test('colorPicker: the palette by name, the one it has pressed, a choice heard', () => {
  const heard = [];
  const picker = colorPicker({ value: '#4F5BD5', label: 'Colour', onPick: (c) => heard.push(c) });
  const buttons = picker.node.find('button');
  assert.equal(buttons.length, 12);
  assert.equal(picker.node.getAttribute('role'), 'group');
  assert.equal(buttons[0].getAttribute('aria-label'), 'Blue', 'named, not read as a hex');
  assert.deepEqual(pressed(picker.node).map((b) => b.dataset.color), ['#4f5bd5'], 'in its case or not');
  assert.equal(picker.value(), '#4f5bd5');
  press(buttons[2]);
  assert.deepEqual(heard, ['#0e7c86']);
  assert.deepEqual(pressed(picker.node).map((b) => b.dataset.color), ['#0e7c86']);
});

test('colorPicker: a colour from before is kept, first and pressed, and can be chosen again', () => {
  const picker = colorPicker({ value: '#DC2626' });
  const buttons = picker.node.find('button');
  assert.equal(buttons.length, 13);
  assert.match(buttons[0].getAttribute('class'), /kit-swatch--kept/);
  assert.equal(buttons[0].style['--kit-swatch'], '#DC2626', 'painted as it is');
  assert.equal(buttons[1].style['--kit-swatch'], '#2564cf', 'a hex as it is stored');
  assert.equal(picker.value(), '#DC2626', 'not changed by opening the dialog');
  press(buttons[1]);
  assert.equal(picker.value(), '#2564cf');
  press(buttons[0]);
  assert.equal(picker.value(), '#DC2626');
});

test('colorPicker by name (Next): tokens to paint, its own legacy name kept, and no colour', () => {
  const picker = colorPicker({
    value: 'magenta', as: 'name', paint: (c) => `var(--hue-${c})`, nameOf: (c) => `«${c}»`,
    none: { label: 'Automatic', swatch: 'var(--hue-cyan)' },
  });
  const buttons = picker.node.find('button');
  assert.equal(buttons.length, 14, 'kept, the twelve, automatic');
  assert.equal(buttons[0].dataset.color, 'magenta');
  assert.match(buttons[0].getAttribute('aria-label'), /«magenta»/);
  assert.equal(buttons[0].style['--kit-swatch'], 'var(--hue-magenta)');
  assert.equal(buttons[1].dataset.color, 'blue');
  assert.equal(buttons[1].style['--kit-swatch'], 'var(--kit-color-blue)', 'a name with its token, lighter in the dark');
  assert.equal(picker.value(), 'magenta');
  press(buttons.at(-1));
  assert.equal(picker.value(), null, 'automatic: no colour of its own');
  assert.deepEqual(pressed(picker.node).map((b) => b.dataset.color), ['']);
  press(buttons[2]);
  assert.equal(picker.value(), 'cyan');
  assert.equal(colorPicker({ value: null, as: 'name', none: { label: 'Auto' } }).value(), null);
});

test('iconPicker: twenty in view and «Más…»; one from before kept first; the rest unfolds', () => {
  const heard = [];
  const picker = iconPicker({ value: '🧪', label: 'Icon', onPick: (i) => heard.push(i) });
  const [shown, all] = picker.node.children;
  const inView = shown.find('button').filter((b) => b.dataset.icon);
  assert.equal(inView.length, 21, 'the twenty and the one it has');
  assert.equal(inView[0].dataset.icon, '🧪');
  assert.equal(inView[0].getAttribute('aria-pressed'), 'true');
  assert.ok(all.hasAttribute('hidden'), 'the rest wait');
  const more = shown.find('button').find((b) => b.getAttribute('class') === 'kit-icons__more');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  press(more);
  assert.equal(all.hasAttribute('hidden'), false);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.equal(all.find('button').length, KIT_MORE_ICONS.length);
  press(all.find('button')[0]);
  assert.equal(picker.value(), KIT_MORE_ICONS[0]);
  assert.deepEqual(heard, [KIT_MORE_ICONS[0]]);
  assert.equal(pressed(picker.node).length, 1, 'one pressed, wherever it is');
});

test('iconPicker: a field to type any other, and a way to leave it without one', () => {
  const picker = iconPicker({ value: '📁', typed: true, none: { label: 'No icon' } });
  const input = picker.node.find('input')[0];
  assert.equal(picker.node.labelTarget, input, 'a field\'s label names the input');
  assert.equal(input.value, '📁');
  input.value = ' 🦊 ';
  (input.listeners.input || []).forEach((fn) => fn({ target: input }));
  assert.equal(picker.value(), '🦊');
  assert.equal(pressed(picker.node).length, 0);
  const none = picker.node.find('button').find((b) => /kit-icons__none/.test(b.getAttribute('class')));
  assert.equal(none.textContent, 'No icon');
  press(none);
  assert.equal(picker.value(), '');
  assert.equal(input.value, '');
  press(picker.node.find('button').find((b) => b.dataset.icon === '🚀'));
  assert.equal(input.value, '🚀');
});
