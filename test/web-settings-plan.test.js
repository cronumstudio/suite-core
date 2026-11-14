/**
 * Settings › Plan in a host (web/settings.js), without a browser: a new plan arriving while it is
 * open (`kit-plan`, back from the checkout or a store) asks again what the other modules include
 * and what is used, so the list never mixes the new plan with the old (sc-ui-9).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

const document = installFakeDom();
const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });
const { loadLanguage, t } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
globalThis.fetch = realFetch;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a new plan with Settings open: the other modules\' features and the usage are asked again under it', { timeout: 20000 }, async () => {
  const { openSettings } = await import('../web/settings.js');
  const { PLAN_EVENT } = await import('../web/plan.js');
  const listeners = new Map();
  Object.assign(document, {
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) || []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn)),
  });
  globalThis.window = { location: { origin: 'https://work.example', assign: () => {} } };
  const modules = [
    { mount: 'tasks', path: '/tasks/', name: 'Tasks', active: true, settings: { sections: [] } },
    { mount: 'notes', path: '/notes/', name: 'Notes', active: true, settings: { sections: [] } },
  ];
  let pro = false;
  const asked = [];
  globalThis.fetch = async (path) => {
    asked.push(String(path).split('?')[0]);
    const data = {
      '/api/modules': { host: { name: 'Cronum Work' }, modules },
      // This module's own and the host's, at the same path here (the kit's BASE is the root in a test).
      '/api/me/entitlements': { plan: { id: pro ? 'pro' : 'free', name: pro ? 'Pro' : 'Free' }, features: { 'lists.max': pro ? null : 20 } },
      '/notes/api/me/entitlements': { features: { 'storage.mb': pro ? 5120 : 50 } },
      '/api/me/usage': { modules: [] },
    }[String(path).split('?')[0]];
    return { ok: data !== undefined, status: data ? 200 : 404, headers: { get: () => null }, json: async () => data ?? { error: 'not_found' } };
  };
  try {
    const root = document.createElement('div');
    const settings = openSettings({
      app: { id: 'tasks', name: 'Tasks', icon: '/icons/favicon.svg' }, user: { id: 1, username: 'ada', role: 'user' }, root, start: 'plan',
      config: { app: { modules: { billing: true }, host: { id: 'work', name: 'Cronum Work', mount: 'tasks', base: '/tasks/', billing: true, plans: true } } },
    });
    for (let i = 0; i < 10; i++) await wait(5);
    const lines = () => root.all().filter((node) => node.className === 'kit-benefits').flatMap((ul) => ul.find('span').map((s) => s.textContent));
    assert.deepEqual(lines(), [t('kit.plan.benefits.lists', { n: 20 }), t('kit.plan.benefits.storage', { size: '50 MB' })]);
    const usageAsked = asked.filter((p) => p === '/api/me/usage').length;

    // Paid elsewhere: the plan read again comes with the event.
    pro = true;
    const detail = { plan: { id: 'pro', name: 'Pro' }, features: { 'lists.max': null } };
    for (const fn of listeners.get(PLAN_EVENT) || []) fn({ type: PLAN_EVENT, detail });
    for (let i = 0; i < 10; i++) await wait(5);
    assert.deepEqual(lines(), [t('kit.plan.benefits.listsUnlimited'), t('kit.plan.benefits.storage', { size: '5 GB' })], 'Notes\' under Pro too');
    assert.equal(asked.filter((p) => p === '/notes/api/me/entitlements').length, 2);
    assert.equal(asked.filter((p) => p === '/api/me/usage').length, usageAsked + 1, 'what is used, read again');
    settings.close();
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete document.addEventListener;
    delete document.removeEventListener;
  }
});
