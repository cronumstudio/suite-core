/**
 * Settings › About's notice of the code (web/settings.js licenceBlock), without a browser: the
 * copyright, who changed it, the licence and its link, the warranty, the closed parts and the
 * links to whoever runs the install, all as /api/auth/config's `about` says them; and the source
 * of the exact version that runs. The texts are the core's English catalog.
 *
 *   node --test test/web-settings-licence.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';
import { aboutAnswer, aboutFromEnv, COPYRIGHT, LICENSE_URL, TRADEMARKS_URL } from '../about.js';

const document = installFakeDom();
const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });
const { loadLanguage, t } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
globalThis.fetch = realFetch;
const { openSettings, sourceText } = await import('../web/settings.js');

const HOST = { id: 'work', name: 'Cronum Work', mount: 'tasks', base: '/tasks/', push: false, plans: false };
// A commit's full hash, made up and plainly so.
const SHA = 'c0ffee'.repeat(7).slice(0, 40);

/** About opened in a module of a host, with this `about` and maybe inside the phone's app: its licence block. */
async function licenceIn({ about, native = null }) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path) => {
    const data = path === '/api/modules' ? { host: { name: 'Cronum Work', icon: '/icons/favicon.svg' }, modules: [] } : undefined;
    return { ok: data !== undefined, status: data === undefined ? 404 : 200, json: async () => data };
  };
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = { location: { origin: 'https://work.example', assign: () => {} }, ...(native && { CronumNative: { v: 1, capabilities: [], ...native } }) };
  const loaded = { app: '0.75.0', name: 'Cronum Work', version: 'abc' };
  try {
    const root = document.createElement('div');
    openSettings({
      app: { id: 'tasks', name: 'Tasks', icon: '/icons/favicon.svg' }, user: { username: 'ada', role: 'user' }, root, start: 'about',
      config: { app: { modules: {}, host: HOST }, ...(about ? { about } : {}) },
      updates: { check: async () => false, loaded: () => loaded, latest: () => loaded }, applyUpdate: () => {},
    });
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    const blocks = root.all().filter((node) => node.className === 'kit-settings__block');
    const block = blocks.find((node) => node.find('h3')[0]?.textContent === t('kit.about.licenseTitle'));
    const source = root.all().find((node) => node.className === 'kit-fact__source');
    return {
      block,
      texts: block.find('p').map((p) => p.textContent),
      links: block.find('a').map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target')]),
      source: [source.textContent, source.getAttribute('href')],
    };
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete document.addEventListener;
    delete document.removeEventListener;
  }
}

test('the hosted service: the exact commit, the copyright, the licence, its closed parts and every legal link', async () => {
  const about = aboutAnswer(aboutFromEnv({
    SOURCE_REVISION: SHA, SOURCE_CLOSED: 'croc,payments',
    TERMS_URL: 'https://example.com/terms/', PRIVACY_URL: 'https://example.com/privacy/', COOKIES_URL: 'https://example.com/cookies/',
    LEGAL_URL: 'https://example.com/legal/', SUPPORT_URL: 'https://example.com/support/',
  }), { id: 'work', version: '0.75.0' });
  const shown = await licenceIn({ about });
  assert.deepEqual(shown.source, [`github.com/cronumstudio/work/tree/${SHA.slice(0, 12)}`, `https://github.com/cronumstudio/work/tree/${SHA}`],
    'the exact commit, its hash short where it is written');
  assert.deepEqual(shown.texts, [
    `© 2026 ${COPYRIGHT.holder}`,
    t('kit.about.license', { app: 'Cronum Work' }),
    t('kit.about.licenseRead'),
    t('kit.about.warranty'),
    t('kit.about.closed', { parts: 'the Croc game and the integration with the payment providers' }),
  ]);
  assert.deepEqual(shown.links, [
    [t('kit.about.licenseRead'), LICENSE_URL, '_blank'],
    [t('kit.about.thirdParty'), `https://github.com/cronumstudio/work/blob/${SHA}/THIRD_PARTY_NOTICES.md`, '_blank'],
    [t('kit.about.trademarks'), TRADEMARKS_URL, '_blank'],
    [t('kit.about.terms'), 'https://example.com/terms/', '_blank'],
    [t('kit.about.privacy'), 'https://example.com/privacy/', '_blank'],
    [t('kit.about.cookies'), 'https://example.com/cookies/', '_blank'],
    [t('kit.about.legalNotice'), 'https://example.com/legal/', '_blank'],
    [t('kit.about.support'), 'https://example.com/support/', '_blank'],
  ]);
});

test('a changed copy: its own source, who changed it, no closed part and no link it didn’t set; inside the phone’s app, that app is named', async () => {
  const about = aboutAnswer(aboutFromEnv({
    SOURCE_URL: 'https://git.example.org/acme/work/src/commit/{ref}', SOURCE_REVISION: 'v2.0.0', SOURCE_MODIFIED: 'Acme Ltd, March 2027',
  }), { id: 'work', version: '0.75.0' });
  const shown = await licenceIn({ about });
  assert.deepEqual(shown.source, ['git.example.org/acme/work/src/commit/v2.0.0', 'https://git.example.org/acme/work/src/commit/v2.0.0']);
  assert.deepEqual(shown.texts.slice(0, 2), [`© 2026 ${COPYRIGHT.holder}`, t('kit.about.modifiedBy', { who: 'Acme Ltd, March 2027' })]);
  assert.ok(!shown.texts.some((text) => text.startsWith('This service also uses')), 'no closed part said');
  assert.deepEqual(shown.links.map(([, href]) => href), [LICENSE_URL], 'only the licence');

  const inApp = await licenceIn({ about, native: { platform: 'android', version: '0.5.12' } });
  assert.equal(inApp.texts.at(-1), t('kit.about.closed', { parts: 'this app for Android' }));
});

test('a server from before the notice: About still says the licence, and the source is the product’s repository', async () => {
  const shown = await licenceIn({ about: null });
  assert.deepEqual(shown.source, ['github.com/cronumstudio/work', 'https://github.com/cronumstudio/work']);
  assert.deepEqual(shown.texts, [t('kit.about.license', { app: 'Cronum Work' }), t('kit.about.licenseRead'), t('kit.about.warranty')]);
  assert.deepEqual(shown.links, [[t('kit.about.licenseRead'), LICENSE_URL, '_blank']]);
});

test('sourceText: no scheme, a full hash cut to 12, anything else as it is', () => {
  assert.equal(sourceText(`https://github.com/cronumstudio/work/tree/${SHA}`), `github.com/cronumstudio/work/tree/${SHA.slice(0, 12)}`);
  assert.equal(sourceText('https://github.com/cronumstudio/work/tree/v1.2.3'), 'github.com/cronumstudio/work/tree/v1.2.3');
  assert.equal(sourceText('http://example.org/code'), 'example.org/code');
});
