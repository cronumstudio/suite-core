/**
 * Settings › «Recommend» (web/settings.js): a link to the affiliate's panel (/afiliados) where the
 * program is on, for an app on its own and in every module of a host; never inside the suite's app
 * on a phone, where the stores' rules keep rewards and prices out (Apple's 3.1).
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
const { loadLanguage } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
globalThis.fetch = realFetch;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function linksOf(config, { userAgent = 'Mozilla/5.0' } = {}) {
  const { openSettings } = await import('../web/settings.js');
  globalThis.window = { location: { origin: 'https://work.example', href: 'https://work.example/', assign: () => {} }, navigator: { userAgent } };
  globalThis.fetch = async (path) => {
    const data = String(path).startsWith('/api/modules') ? { host: { name: 'Cronum Work' }, modules: [] } : undefined;
    return { ok: data !== undefined, status: data ? 200 : 404, headers: { get: () => null }, json: async () => data ?? { error: 'not_found' } };
  };
  try {
    const root = document.createElement('div');
    const settings = openSettings({ app: { id: 'tasks', name: 'Tasks', icon: '/icons/favicon.svg' }, user: { id: 1, username: 'ada', role: 'user' }, root, config });
    for (let i = 0; i < 5; i++) await wait(5);
    const hrefs = root.find('a').map((a) => a.getAttribute('href'));
    settings.close();
    return hrefs;
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.window;
  }
}

test('Recommend: where the program is on, on the web; never in the app on a phone; never with it off', async () => {
  assert.ok((await linksOf({ app: { modules: { recommend: true } } })).includes('/afiliados'), 'an app on its own');
  assert.ok(!(await linksOf({ app: { modules: {} } })).includes('/afiliados'), 'the program off');
  const host = { app: { modules: {}, host: { id: 'work', name: 'Cronum Work', mount: 'tasks', base: '/tasks/', recommend: true } } };
  assert.ok((await linksOf(host)).includes('/afiliados'), 'a module of a host whose program is on');
  assert.ok(!(await linksOf(host, { userAgent: 'Mozilla/5.0 CronumWorkApp/1.4.0' })).includes('/afiliados'), 'inside the app on a phone');
});
