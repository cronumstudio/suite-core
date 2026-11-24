/**
 * Settings › Sample data (web/settings.js), without a browser: in the host's group where the host
 * has it, a button that adds the example in the page's language, and once it is there what it is in
 * and a button that takes it away after asking.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

const document = installFakeDom();
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
const { openSettings } = await import('../web/settings.js');

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const HOST = { id: 'work', name: 'Cronum Work', mount: 'tasks', base: '/tasks/', sampleData: true };
const MODULES = [
  { mount: 'tasks', path: '/tasks/', name: 'Tasks', active: true, settings: { sections: [], data: true } },
  { mount: 'notes', path: '/notes/', name: 'Notes', active: true, settings: { sections: [], data: true } },
];

function server(answers, asked) {
  return async (path, { method = 'GET', body } = {}) => {
    asked.push([`${method} ${path}`, body ? JSON.parse(body) : undefined]);
    const answer = answers[`${method} ${path}`];
    const value = typeof answer === 'function' ? answer(body ? JSON.parse(body) : undefined) : answer;
    const status = value === undefined ? 404 : 200;
    return { ok: status < 400, status, headers: { get: () => null }, json: async () => (value === undefined ? { error: 'not_found' } : value) };
  };
}

function open(host, answers, asked = []) {
  globalThis.fetch = server(answers, asked);
  globalThis.window = { location: { origin: 'https://work.example', href: 'https://work.example/tasks/' } };
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });
  const root = document.createElement('div');
  const settings = openSettings({
    app: { id: 'tasks', name: 'Tasks' }, user: { id: 7, username: 'ada', role: 'user' }, root, start: 'sample-data',
    config: { app: { modules: { mcp: true, data: true }, host } },
  });
  return { root, settings, asked };
}

function cleanUp(settings) {
  settings.close();
  globalThis.fetch = realFetch;
  delete globalThis.window;
  delete document.addEventListener;
  delete document.removeEventListener;
  delete document.dispatchEvent;
}

const labels = (root) => root.all().filter((node) => node.className === 'kit-settings__label').map((node) => node.textContent);
const buttonNamed = (root, text) => root.all().find((node) => node.tagName === 'BUTTON' && node.textContent === text);

test('the section is the host’s, after Modules; adding asks in the page’s language, and then it offers to take it away', async () => {
  memory.clear();
  let present = false;
  const { root, settings, asked } = open(HOST, {
    'GET /api/modules': { host: { name: 'Cronum Work' }, modules: MODULES },
    'GET /notes/i18n/en.json': {},
    'GET /api/me/sample-data': () => ({ present, modules: present ? ['tasks', 'notes'] : [], available: ['tasks', 'notes'] }),
    'POST /api/me/sample-data': () => { present = true; return { present: true, modules: ['tasks', 'notes'], failed: [], links: 2 }; },
    'DELETE /api/me/sample-data': () => { present = false; return { present: false, removed: 9, kept: 0, failed: [] }; },
  });
  try {
    await settle();
    const seen = labels(root);
    assert.equal(seen[seen.indexOf(t('kit.modules.title')) + 1], t('kit.sample.title'), 'right after Modules, in the host’s group');
    assert.ok(root.textContent.includes(t('kit.sample.intro', { app: 'Cronum Work' })));
    const add = buttonNamed(root, t('kit.sample.add'));
    assert.ok(add, 'a button to add it');
    add.click();
    await settle();
    assert.deepEqual(asked.find(([what]) => what === 'POST /api/me/sample-data')[1], { locale: 'en' });
    assert.ok(root.textContent.includes(t('kit.sample.present', { modules: 'Tasks and Notes' })), 'what it is in, by the modules’ names');
    assert.ok(!buttonNamed(root, t('kit.sample.add')), 'no second example');
    const take = buttonNamed(root, t('kit.sample.remove'));
    assert.ok(take);
    take.click();
    await settle();
    // It asks first: confirming takes it away.
    const confirm = document.body.all().filter((node) => node.tagName === 'BUTTON' && node.textContent === t('kit.sample.remove')).pop();
    assert.notEqual(confirm, take, 'the dialog’s own button');
    confirm.click();
    await settle();
    assert.ok(asked.some(([what]) => what === 'DELETE /api/me/sample-data'));
    assert.ok(buttonNamed(root, t('kit.sample.add')), 'and it can be added again');
  } finally {
    cleanUp(settings);
  }
});

test('a host without it has no such section', async () => {
  memory.clear();
  const { root, settings } = open({ ...HOST, sampleData: undefined }, {
    'GET /api/modules': { host: { name: 'Cronum Work' }, modules: MODULES },
    'GET /notes/i18n/en.json': {},
  });
  try {
    await settle();
    assert.ok(!labels(root).includes(t('kit.sample.title')));
  } finally {
    cleanUp(settings);
  }
});

test('with several examples, adding asks which one, by the names in the host’s catalog, and says it once there', async () => {
  memory.clear();
  let present = null;
  const words = { 'samples.cafe.title': 'Café Alba', 'samples.cafe.hint': 'A café opening', 'samples.app.title': 'Ritmo', 'samples.app.hint': 'An app shipping' };
  const { root, settings, asked } = open({ ...HOST, sampleData: { examples: ['cafe', 'app'], words: 'samples.' } }, {
    'GET /api/modules': { host: { name: 'Cronum Work' }, modules: MODULES },
    'GET /notes/i18n/en.json': {},
    'GET /i18n/en.json': words,
    'GET /api/me/sample-data': () => ({ present: Boolean(present), example: present, modules: present ? ['tasks', 'notes'] : [], available: ['tasks', 'notes'], examples: ['cafe', 'app'] }),
    'POST /api/me/sample-data': ({ example }) => { present = example; return { present: true, example, modules: ['tasks', 'notes'], failed: [], links: 2 }; },
  });
  try {
    await settle();
    buttonNamed(root, t('kit.sample.add')).click();
    await settle();
    const choices = document.body.all().filter((node) => node.className === 'kit-sample-choice');
    assert.deepEqual(choices.map((node) => node.textContent), ['Café AlbaA café opening', 'RitmoAn app shipping'], 'one button each, named and described');
    assert.ok(!asked.some(([what]) => what === 'POST /api/me/sample-data'), 'nothing added before choosing');
    choices[1].click();
    await settle();
    assert.deepEqual(asked.find(([what]) => what === 'POST /api/me/sample-data')[1], { locale: 'en', example: 'app' });
    assert.ok(root.textContent.includes(t('kit.sample.presentNamed', { example: 'Ritmo', modules: 'Tasks and Notes' })));
  } finally {
    cleanUp(settings);
  }
});
