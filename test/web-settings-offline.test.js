/**
 * Settings without a signal (web/settings.js, web/settings-queue.js): the host's list from the
 * config of last time, a notice where only the server can answer, what needs it turned off, and
 * the preferences kept on this device and sent, in order, once the server answers. And the
 * service worker's page at its base offline (web/sw-core.js): the one the server answers there.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
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
const noSignal = async () => { throw new TypeError('Failed to fetch'); };
const QUEUE = 'suite.settings.queue';

/** A server that answers `answers['METHOD /path']` (a function of the body, or a value), and notes what it was asked. */
function server(answers, asked = []) {
  return async (path, { method = 'GET', body } = {}) => {
    asked.push(`${method} ${path}`);
    const answer = answers[`${method} ${path}`];
    const value = typeof answer === 'function' ? answer(body ? JSON.parse(body) : undefined) : answer;
    const status = value === undefined ? 404 : value?.status || 200;
    return { ok: status < 400, status, json: async () => (value === undefined ? { error: 'not_found' } : value.body ?? value) };
  };
}

const HOST = { id: 'work', name: 'Cronum Work', mount: 'tasks', base: '/tasks/', push: true, plans: false };
const MODULES = [
  { mount: 'tasks', path: '/tasks/', name: 'Tasks', active: true },
  { mount: 'notes', path: '/notes/', name: 'Notes', active: true },
];

test('the install’s config is kept for this app’s path, and without one the one of last time comes back', async () => {
  memory.clear();
  const { settingsConfig } = await import('../web/settings.js');
  const config = { provider: 'workos', app: { modules: { mcp: true }, host: HOST } };
  assert.equal(settingsConfig(config, '/tasks/'), config, 'one given is the one used');
  assert.deepEqual(settingsConfig({}, '/tasks/'), config, 'offline, last time\'s');
  assert.deepEqual(settingsConfig(null, '/tasks/'), config);
  assert.deepEqual(settingsConfig({}, '/notes/'), {}, 'another app’s path keeps its own');
});

test('offline in a host: the host’s list still, a notice where only the server answers, and what needs it turned off', async () => {
  memory.clear();
  const { openSettings, settingsConfig } = await import('../web/settings.js');
  settingsConfig({ app: { modules: { mcp: true, data: true }, host: HOST }, deletion_days: 30 });
  memory.set('host.modules', JSON.stringify({ host: { name: 'Cronum Work' }, modules: MODULES, calendar_shown: false }));
  globalThis.fetch = noSignal;
  globalThis.window = { location: { origin: 'https://work.example', href: 'https://work.example/tasks/' } };
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {} });
  const root = document.createElement('div');
  const settings = openSettings({ app: { id: 'tasks', name: 'Tasks' }, user: { id: 7, username: 'ada', role: 'user' }, config: {}, root, start: 'ai' });
  try {
    await settle();
    const labels = root.all().filter((node) => node.className === 'kit-settings__label').map((node) => node.textContent);
    assert.ok(labels.includes(t('kit.modules.title')), 'Modules: the host’s, from the config of last time');
    assert.ok(labels.includes(t('kit.data.deleteTitle')), 'and deleting the account');
    const page = () => root.all().find((node) => node.className === 'kit-settings__page');
    // Your AI asked the server and found no signal: a notice in its place, no error.
    assert.ok(page().textContent.includes(t('kit.offline.title')));
    assert.ok(page().textContent.includes(t('kit.offline.server')));
    assert.ok(!root.all().some((node) => node.className === 'kit-copy'), 'nothing of the section under the notice');
    assert.ok(!document.body.all().some((node) => /kit-toast--error/.test(node.className || '')), 'no error said');

    // Deleting the account: there, but off, saying why.
    settings.show('account');
    const set = page().all().find((node) => node.tagName === 'FIELDSET');
    assert.equal(set.disabled, true);
    const why = set.all().find((node) => node.className === 'kit-hint kit-settings__offline-hint');
    assert.equal(why.hidden, false);
    assert.equal(why.textContent, t('kit.offline.actions'));
  } finally {
    settings.close();
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete document.addEventListener;
    delete document.removeEventListener;
  }
});

test('offline, a preference is applied here and kept: the theme and the modules in use', async () => {
  memory.clear();
  const { openSettings } = await import('../web/settings.js');
  const { queuedSettings } = await import('../web/settings-queue.js');
  memory.set('host.modules', JSON.stringify({ host: { name: 'Cronum Work' }, modules: MODULES, calendar_shown: false }));
  globalThis.fetch = noSignal;
  globalThis.window = { location: { origin: 'https://work.example', href: 'https://work.example/tasks/' } };
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });
  const applied = [];
  const root = document.createElement('div');
  const users = [];
  const settings = openSettings({
    app: { id: 'tasks', name: 'Tasks' }, user: { id: 7, username: 'ada', role: 'user', theme: 'light' }, root, start: 'appearance',
    config: { app: { modules: { mcp: false }, host: HOST } },
    applyTheme: (value) => applied.push(value), onUser: (user) => users.push(user),
  });
  try {
    const dark = root.all().find((node) => node.tagName === 'BUTTON' && node.dataset.value === 'dark');
    dark.click();
    await settle();
    assert.deepEqual(applied, ['dark'], 'painted at once');
    assert.equal(users.at(-1).theme, 'dark', 'and this device’s account has it');
    const queue = queuedSettings();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].method, 'PATCH');
    assert.match(queue[0].path, /\/api\/me$/);
    assert.deepEqual(queue[0].body, { theme: 'dark' });
    assert.ok(document.body.all().some((node) => node.textContent === t('kit.offline.queued')), 'it says it waits');

    // Modules: drawn from last time, and one turned off.
    settings.show('modules');
    await settle();
    const notes = root.all().find((node) => node.className === 'kit-switch' && node.dataset.mount === 'notes');
    assert.equal(notes.getAttribute('aria-checked'), 'true');
    notes.click();
    await settle();
    assert.equal(notes.getAttribute('aria-checked'), 'false', 'the switch stays where it was put');
    const kept = JSON.parse(memory.get('host.modules'));
    assert.deepEqual(kept.modules.map((m) => [m.mount, m.active]), [['tasks', true], ['notes', false]], 'the rail of the next page has it');
    assert.deepEqual(queuedSettings().at(-1), { method: 'PUT', path: '/api/me/modules', body: { active: ['tasks'] } });
  } finally {
    settings.close();
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete document.addEventListener;
    delete document.removeEventListener;
    delete document.dispatchEvent;
  }
});

test('the queue: one change per address, a PATCH’s fields merged, and sent in order to the same person only', async () => {
  memory.clear();
  const { queueSetting, queuedSettings, flushSettings, forgetSettings } = await import('../web/settings-queue.js');
  queueSetting('PATCH', '/tasks/api/me', { theme: 'dark', prefs: { lang: 'es' } }, 7);
  queueSetting('PUT', '/api/me/look', { look: 'clean' }, 7);
  queueSetting('PATCH', '/tasks/api/me', { display_name: 'Ada', prefs: { week: 1 } }, 7);
  queueSetting('PUT', '/api/me/look', { look: 'cronum' }, 7);
  assert.deepEqual(queuedSettings(), [
    { method: 'PATCH', path: '/tasks/api/me', body: { theme: 'dark', prefs: { lang: 'es', week: 1 }, display_name: 'Ada' } },
    { method: 'PUT', path: '/api/me/look', body: { look: 'cronum' } },
  ]);

  // Still no signal: nothing goes, nothing is lost.
  globalThis.fetch = noSignal;
  try {
    assert.equal(await flushSettings(), 0);
    assert.equal(queuedSettings().length, 2);

    // Back, someone else signed in: theirs is not this, and it goes.
    const asked = [];
    globalThis.fetch = server({ 'GET /api/auth/me': { user: { id: 8 } } }, asked);
    assert.equal(await flushSettings(), 0);
    assert.deepEqual(asked, ['GET /api/auth/me']);
    assert.equal(memory.has(QUEUE), false);

    // The same person: in order, at the paths kept; one the server refuses goes too.
    queueSetting('PATCH', '/tasks/api/me', { theme: 'dark' }, 7);
    queueSetting('PUT', '/api/me/modules', { active: ['tasks'] }, 7);
    queueSetting('PUT', '/api/me/look', { look: 'clean' }, 7);
    const sent = [];
    const changed = [];
    Object.assign(document, { dispatchEvent: (event) => { changed.push(event.type); return true; } });
    globalThis.fetch = server({
      'GET /api/auth/me': { user: { id: 7 } },
      'PATCH /tasks/api/me': (body) => { sent.push(['me', body]); return { user: { id: 7, theme: body.theme } }; },
      'PUT /api/me/modules': (body) => { sent.push(['modules', body]); return { modules: [] }; },
      'PUT /api/me/look': () => ({ status: 400, body: { error: 'field_invalid' } }),
    });
    assert.equal(await flushSettings(), 2);
    assert.deepEqual(sent, [['me', { theme: 'dark' }], ['modules', { active: ['tasks'] }]]);
    assert.deepEqual(queuedSettings(), [], 'the refused one goes: the server has the last word');
    assert.deepEqual(changed, ['kit-modules'], 'the rails ask again');

    // Signing out forgets what waits.
    queueSetting('PUT', '/api/me/look', { look: 'clean' }, 7);
    forgetSettings();
    assert.deepEqual(queuedSettings(), []);
  } finally {
    globalThis.fetch = realFetch;
    delete document.dispatchEvent;
  }
});

test('offline, a page at the worker’s base is the one kept there: Cronum Work’s shell at /, not its home', async () => {
  const code = fs.readFileSync(new URL('../web/sw-core.js', import.meta.url), 'utf8');
  const kept = new Map([
    ['/', 'shell'], ['/index.html', 'home'], ['/split/index.html', 'split'],
    ['/tasks/', 'tasks'], ['/tasks/index.html', 'tasks page'],
  ]);
  const handlers = {};
  const sandbox = {
    self: { registration: { scope: 'https://work.example/' }, location: { origin: 'https://work.example' }, addEventListener: (type, fn) => { handlers[type] = fn; } },
    caches: { match: async (key) => kept.get(key), open: async () => ({ match: async () => undefined, put: async () => {} }), keys: async () => [] },
    fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    Response: { error: () => 'error' },
    URL, setTimeout, clearTimeout,
  };
  vm.runInNewContext(`${code}\nsuiteWorker({ version: 'work-1', shell: [], modules: ['/tasks/'] });`, sandbox);
  const open = (url) => {
    let answer = null;
    handlers.fetch({ request: { method: 'GET', url, mode: 'navigate' }, respondWith: (p) => { answer = p; }, waitUntil: () => {} });
    return answer;
  };
  assert.equal(await open('https://work.example/?w=tasks:list/12'), 'shell', 'the installed app opens on its shell');
  assert.equal(await open('https://work.example/'), 'shell');
  assert.equal(await open('https://work.example/split/'), 'split', 'a folder of its own, its index.html');
  assert.equal(await open('https://work.example/tasks/'), 'tasks', 'a module at its base, as kept');
  assert.equal(await open('https://work.example/tasks/list/12'), 'tasks page', 'a module’s page, its index.html');
});
