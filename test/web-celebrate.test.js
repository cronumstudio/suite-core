/**
 * The celebration when something is done (web/celebrate.js), without a browser: the choice kept on
 * the device (and Tasks' own, until the person chooses again), the confetti where it is seen, and
 * Settings' switches.
 *
 *   npm test
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

const document = installFakeDom();
const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));

const stored = new Map();
globalThis.localStorage = {
  getItem: (key) => (stored.has(key) ? stored.get(key) : null),
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: (key) => stored.delete(key),
};
let reduce = false;
globalThis.matchMedia = (query) => ({ matches: query.includes('reduce') && reduce });

const { celebratePrefs, setCelebratePref, confetti } = await import('../web/celebrate.js');

beforeEach(() => { stored.clear(); reduce = false; });

test('both on by default; what was chosen in Tasks holds until it is chosen here, and then this one wins', () => {
  assert.deepEqual(celebratePrefs(), { animation: true, sound: true });

  stored.set('tasks.celebrate', JSON.stringify({ sound: false, animation: true }));
  assert.deepEqual(celebratePrefs(), { animation: true, sound: false }, 'Tasks\' choice, not the default');

  setCelebratePref('animation', false);
  assert.deepEqual(JSON.parse(stored.get('suite.celebrate')), { animation: false, sound: false }, 'the whole choice, Tasks\' sound kept');
  stored.set('tasks.celebrate', JSON.stringify({ sound: true, animation: true }));
  assert.deepEqual(celebratePrefs(), { animation: false, sound: false });
});

test('what is stored broken or of another kind is the default', () => {
  stored.set('suite.celebrate', '{not json');
  assert.deepEqual(celebratePrefs(), { animation: true, sound: true });
  stored.set('suite.celebrate', JSON.stringify({ animation: 'no', sound: 0 }));
  assert.deepEqual(celebratePrefs(), { animation: true, sound: true });
});

test('without popovers, the confetti hangs in the dialog the origin is in, else the root given, else the body; and goes', async () => {
  const dialog = document.createElement('dialog');
  dialog.setAttribute('open', '');
  const check = document.createElement('button');
  dialog.append(check);
  document.body.append(dialog);

  const inDialog = confetti(check);
  assert.equal(inDialog.parentNode, dialog, 'over everything, as the dialog is');
  assert.ok(inDialog.children.length >= 12);
  assert.equal(inDialog.getAttribute('aria-hidden'), 'true');
  assert.equal(inDialog.style.pointerEvents, 'none');

  const root = document.createElement('div');
  assert.equal(confetti(check, { root }).parentNode, dialog, 'the dialog wins over the module\'s root');
  assert.equal(confetti({ x: 10, y: 20 }, { root }).parentNode, root);
  assert.equal(confetti(null).parentNode, document.body);

  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.equal(inDialog.parentNode, null, 'it leaves nothing behind');
});

test('where there are popovers, the confetti is in the top layer: over a dialog, and not gone with it', () => {
  const dialog = document.createElement('dialog');
  dialog.setAttribute('open', '');
  const save = document.createElement('button');
  dialog.append(save);
  document.body.append(dialog);
  const root = document.createElement('div');
  const kind = Object.getPrototypeOf(dialog);
  const shown = [];
  kind.showPopover = function showPopover() { shown.push(this); };
  try {
    const layer = confetti(save, { root });
    assert.equal(layer.parentNode, root, 'in the module\'s root, not in the dialog that is closing');
    assert.equal(layer.getAttribute('popover'), 'manual');
    assert.deepEqual(shown, [layer], 'shown on top');
    assert.equal(layer.style.background, 'transparent', 'without the popover\'s look');
  } finally {
    delete kind.showPopover;
  }
});

test('no confetti when it is turned off, or the system asks for less motion', () => {
  setCelebratePref('animation', false);
  assert.equal(confetti(null), null);
  setCelebratePref('animation', true);
  reduce = true;
  assert.equal(confetti(null), null);
});

test('Settings › Language and theme has the two switches, on this device, and a way to try it', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });
  const { loadLanguage } = await import('../web/i18n.js');
  await loadLanguage('en', { remember: false });
  globalThis.fetch = realFetch;
  const { openSettings } = await import('../web/settings.js');
  globalThis.window = { location: { origin: 'https://tasks.example', assign: () => {} } };
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {} });

  stored.set('tasks.celebrate', JSON.stringify({ sound: false, animation: true }));
  const root = document.createElement('div');
  openSettings({
    app: { id: 'tasks', name: 'Tasks', icon: '/icons/favicon.svg' }, user: { username: 'ada', role: 'user' }, root,
    config: { app: { modules: { mcp: false } } }, start: 'appearance',
  });
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));

  const switches = root.querySelectorAll('.kit-switch');
  const named = (label) => switches.find((s) => s.getAttribute('aria-label') === english[label]);
  const animation = named('kit.appearance.celebrate.animation');
  const sound = named('kit.appearance.celebrate.sound');
  assert.ok(animation && sound, 'both switches');
  assert.equal(animation.getAttribute('aria-checked'), 'true');
  assert.equal(sound.getAttribute('aria-checked'), 'false', 'what was chosen in Tasks');

  sound.listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(JSON.parse(stored.get('suite.celebrate')), { animation: true, sound: true });
  assert.ok(root.all().some((node) => node.textContent === english['kit.appearance.celebrate.test']), 'the button to try it');
});
