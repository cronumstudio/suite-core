/**
 * Settings in a host (web/settings.js), without a browser: the list's order (the host's group
 * first, the modules', the account's, About at the foot) and Settings › Modules with what is on
 * the rail and not a module (the calendar, the daily summary, a door) under the modules.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

const document = installFakeDom();
// Settings › Modules marks its rows with classList, which the fake DOM leaves out.
Object.defineProperty(Object.getPrototypeOf(document.createElement('div')), 'classList', {
  configurable: true,
  get() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (...more) => { this.className = [...new Set([...names(), ...more])].join(' '); },
      remove: (...gone) => { this.className = names().filter((n) => !gone.includes(n)).join(' '); },
      contains: (name) => names().includes(name),
      toggle: (name, on = !names().includes(name)) => { if (on) this.classList.add(name); else this.classList.remove(name); return on; },
    };
  },
});
const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => { memory.set(key, String(value)); },
  removeItem: (key) => { memory.delete(key); },
};
const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });
const { loadLanguage, t } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
globalThis.fetch = realFetch;

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const HOST = { id: 'work', name: 'Cronum Work', mount: 'tasks', base: '/tasks/', push: true, plans: true, day: '/today/', calendarFeed: true };
const MODULES = [
  { mount: 'tasks', path: '/tasks/', name: 'Tasks', color: '#1D9E75', active: true, settings: { sections: [], data: true } },
  { mount: 'notes', path: '/notes/', name: 'Notes', color: '#BA7517', active: true, settings: { sections: [], data: true } },
  { mount: 'croc', path: '/croc/', name: 'Croc', active: true, door: true, settings: { sections: [], data: true } },
];
const LINES = { 'home.modules.tasks': 'Lists and My day', 'home.modules.notes': 'Notes in Markdown', 'home.modules.croc': 'One-minute games' };

/** A server that answers `answers['METHOD /path']` (a function of the body, or a value), and notes what it was asked. */
function server(answers, asked = []) {
  return async (path, { method = 'GET', body } = {}) => {
    asked.push([`${method} ${path}`, body ? JSON.parse(body) : undefined]);
    const answer = answers[`${method} ${path}`];
    const value = typeof answer === 'function' ? answer(body ? JSON.parse(body) : undefined) : answer;
    const status = value === undefined ? 404 : value?.status || 200;
    return { ok: status < 400, status, json: async () => (value === undefined ? { error: 'not_found' } : value.body ?? value) };
  };
}

function open(start, answers, asked) {
  globalThis.fetch = server(answers, asked);
  globalThis.window = { location: { origin: 'https://work.example', href: 'https://work.example/tasks/' } };
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });
  const root = document.createElement('div');
  const settings = openSettings({
    app: { id: 'tasks', name: 'Tasks' }, user: { id: 7, username: 'ada', role: 'user' }, root, start,
    config: { app: { modules: { mcp: true, data: true }, host: HOST }, deletion_days: 30 },
    sections: [{ id: 'preferences', label: 'Preferences', hint: 'How Tasks works', render: () => document.createElement('p') }],
  });
  return { root, settings };
}
const { openSettings } = await import('../web/settings.js');

function cleanUp(settings) {
  settings.close();
  globalThis.fetch = realFetch;
  delete globalThis.window;
  delete document.addEventListener;
  delete document.removeEventListener;
  delete document.dispatchEvent;
}

test('in a host the list starts with the host’s group, then each module’s, then the account’s, and About at the foot on its own', async () => {
  memory.clear();
  const answer = { host: { name: 'Cronum Work', hints: 'home.modules.' }, modules: MODULES, calendar_shown: false, day_shown: true };
  const { root, settings } = open('appearance', { 'GET /api/modules': answer, 'GET /notes/i18n/en.json': {} });
  try {
    await settle();
    const list = root.all().find((node) => node.className === 'kit-settings__list') || root;
    const seen = list.all().filter((node) => ['kit-settings__group-name', 'kit-settings__label'].includes(node.className))
      .map((node) => (node.className === 'kit-settings__group-name' ? `# ${node.textContent}` : node.textContent));
    assert.deepEqual(seen, [
      '# Cronum Work', t('kit.modules.title'), t('kit.appearance.title'), t('kit.ai.title'), t('kit.notifications.title'),
      t('kit.day.title'), t('kit.calendarFeed.title'),
      '# Tasks', 'Preferences', t('kit.data.title'),
      `# Notes`,
      `# ${t('kit.settings.groups.account')}`, t('kit.profile.title'), t('kit.security.title'), t('kit.security.sessions'),
      t('kit.plan.title'), t('kit.data.deleteTitle'),
      `# ${t('kit.about.title', { app: 'Cronum Work' })}`,
    ], 'Croc, a door on the rail, has no group; Connections is gone');
  } finally {
    cleanUp(settings);
  }
});

test('Settings › Modules: the modules in order with their lines, and under them the rail’s buttons, the door among them and out of the order', async () => {
  memory.clear();
  const asked = [];
  let modules = MODULES.map((m) => ({ ...m }));
  const answer = () => ({ host: { name: 'Cronum Work', hints: 'home.modules.' }, modules, calendar_shown: false, day_shown: true });
  const { root, settings } = open('modules', {
    'GET /api/modules': answer,
    'GET /i18n/en.json': LINES,
    'GET /notes/i18n/en.json': {},
    'PUT /api/me/modules': ({ active }) => {
      modules = modules.map((m) => ({ ...m, active: active.includes(m.mount) }));
      return answer();
    },
    'PUT /api/me/day': () => answer(),
  }, asked);
  try {
    await settle();
    const page = root.all().find((node) => node.className === 'kit-settings__page');
    const rows = page.all().filter((node) => (node.className || '').split(' ').includes('kit-switch-row'));
    const named = (row) => row.all().find((node) => node.className === 'kit-switch-row__text');
    const grips = page.all().filter((node) => node.className === 'kit-module-grip');
    assert.equal(grips.length, 2, 'only the modules have a grip: Croc has no place in the order');
    const sortable = rows.filter((row) => row.dataset.mount);
    assert.deepEqual(sortable.map((row) => row.dataset.mount), ['tasks', 'notes']);
    assert.deepEqual(sortable.map((row) => named(row).find('small')[0].textContent), ['Lists and My day', 'Notes in Markdown'], 'each module’s line, from the host’s catalog');

    // The rail's buttons, in their block: the calendar, the daily summary, Croc.
    const bar = page.all().find((node) => node.tagName === 'SECTION' && node.textContent.includes(t('kit.modules.barTitle')));
    assert.ok(bar && !bar.hidden, 'the block is there');
    const buttons = bar.all().filter((node) => (node.className || '').split(' ').includes('kit-switch-row'));
    const label = (row) => named(row).textContent.replace(named(row).find('small')[0]?.textContent || '', '');
    assert.deepEqual(buttons.map(label), [t('kit.calendar.title'), t('kit.day.show'), 'Croc']);
    assert.deepEqual(buttons.map((row) => named(row).find('small')[0].textContent), [t('kit.calendar.showHint'), t('kit.day.showHint'), 'One-minute games']);
    const state = (row) => row.all().find((node) => node.className === 'kit-switch').getAttribute('aria-checked');
    assert.deepEqual(buttons.map(state), ['false', 'true', 'true']);

    // Installing: the modules on their own, never Croc.
    const installs = page.all().filter((node) => node.tagName === 'A').map((node) => node.getAttribute('href'));
    assert.ok(installs.includes('/tasks/') && installs.includes('/notes/'));
    assert.ok(!installs.includes('/croc/'), 'a door is not installed alone');

    // Both modules off with Croc on: the second stays on, saying why.
    const switchOf = (mount) => page.all().find((node) => node.className === 'kit-switch' && node.dataset.mount === mount);
    switchOf('tasks').click();
    await settle();
    assert.deepEqual(asked.filter(([what]) => what === 'PUT /api/me/modules').map(([, body]) => body), [{ active: ['notes', 'croc'] }]);
    const notes = root.all().find((node) => node.className === 'kit-switch' && node.dataset.mount === 'notes');
    notes.click();
    await settle();
    assert.equal(notes.getAttribute('aria-checked'), 'true', 'the switch goes back');
    assert.ok(document.body.all().some((node) => /kit-toast--error/.test(node.className || '') && node.textContent.includes(t('kit.modules.last'))));
    assert.equal(asked.filter(([what]) => what === 'PUT /api/me/modules').length, 1, 'nothing more sent');

    // My day hidden: its own preference, at the host's root.
    const day = root.all().filter((node) => (node.className || '').split(' ').includes('kit-switch-row')).find((row) => named(row).textContent.startsWith(t('kit.day.show')));
    day.all().find((node) => node.className === 'kit-switch').click();
    await settle();
    assert.deepEqual(asked.filter(([what]) => what === 'PUT /api/me/day').map(([, body]) => body), [{ shown: false }]);
  } finally {
    cleanUp(settings);
  }
});
