/**
 * Settings (web/settings.js) open without agents.js and usage-view.js, which only Your AI's agents
 * and prompt and Settings › Plan's usage draw: each is asked for when its section is (audit of 6/11,
 * sc-ui-11), and both stay in the worker's kit for without a signal (sw-core.js). A file of its
 * own: it watches which of the kit's files this process loads.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { installFakeDom } from './fake-dom.js';

// Which of the two the process has loaded, as it resolves them.
const loaded = new Set();
// While true, agents.js can't be had (offline, missing from the worker's copy).
let agentsGone = false;
registerHooks({
  resolve(specifier, context, next) {
    if (agentsGone && /agents\.js$/.test(specifier)) throw new Error('no signal');
    const answer = next(specifier, context);
    const name = /\/web\/(agents|usage-view)\.js$/.exec(new URL(answer.url).pathname)?.[1];
    if (name) loaded.add(name);
    return answer;
  },
});

const document = installFakeDom();
const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });
const { loadLanguage } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
globalThis.fetch = realFetch;
const { openSettings } = await import('../web/settings.js');
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

test('neither is imported by settings.js as it loads, and both are in the worker\'s kit', () => {
  const code = fs.readFileSync(new URL('../web/settings.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /^import [^;]+from '\.\/(agents|usage-view)\.js';/m);
  const kit = fs.readFileSync(new URL('../web/sw-core.js', import.meta.url), 'utf8');
  for (const file of ['agents', 'usage-view']) assert.ok(kit.includes(`'/suite/${file}.js'`), file);
});

test('Settings open on another section load neither; Your AI with the host\'s prompt, agents.js; Plan, usage-view.js', async () => {
  const modules = [{ mount: 'tasks', path: '/tasks/', name: 'Tasks', active: true, settings: { sections: [] } }];
  globalThis.fetch = async (path) => {
    const data = String(path).startsWith('/api/ai-instruction') ? { text: 'PROMPT' }
      : path === '/api/modules' ? { host: { name: 'Cronum Work', aiInstruction: '/api/ai-instruction' }, modules }
        : path === '/api/me/usage' ? { modules: [] }
          : path === '/api/me/entitlements' ? { plan: { id: 'free', name: 'Free' }, features: {} } : undefined;
    return { ok: data !== undefined, status: data ? 200 : 404, headers: { get: () => null }, json: async () => data ?? { error: 'not_found' } };
  };
  globalThis.window = { location: { origin: 'https://work.example' } };
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {} });
  const open = (start) => {
    const root = document.createElement('div');
    const settings = openSettings({
      app: { id: 'tasks', name: 'Tasks', icon: '/icons/favicon.svg' }, user: { id: 1, username: 'ada', role: 'user' }, root, start,
      config: { app: { modules: { mcp: true }, host: { id: 'work', name: 'Cronum Work', mount: 'tasks', base: '/tasks/', push: false, plans: true } } },
    });
    return { root, settings };
  };
  try {
    const first = open('appearance');
    await settle();
    first.settings.close();
    assert.deepEqual([...loaded], [], 'nothing of either for Appearance');

    // Without agents.js: no chips nor prompt, asked once while open, and the rest of Your AI is there.
    agentsGone = true;
    const offline = open('ai');
    await settle();
    const blocks = offline.root.all().filter((node) => node.tagName === 'SECTION');
    assert.ok(blocks.some((node) => node.textContent.includes(english['kit.ai.tokens'])), 'Your AI drawn');
    assert.ok(blocks.filter((node) => node.textContent.includes(english['kit.ai.agentsTitle']) || node.textContent.includes(english['kit.ai.promptTitle'])).every((node) => node.hidden));
    assert.deepEqual([...loaded], []);
    offline.settings.close();
    agentsGone = false;

    const ai = open('ai');
    await settle();
    assert.deepEqual([...loaded], ['agents']);
    assert.ok(ai.root.all().some((node) => node.className === 'kit-agents'), 'the agents\' chips, once it came');
    ai.settings.close();

    const plan = open('plan');
    await settle();
    assert.deepEqual([...loaded].sort(), ['agents', 'usage-view']);
    assert.ok(plan.root.all().some((node) => node.tagName === 'SECTION' && node.textContent.includes(english['kit.usage.lead'])), 'what is used, drawn');
    plan.settings.close();
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete document.addEventListener;
    delete document.removeEventListener;
  }
});
