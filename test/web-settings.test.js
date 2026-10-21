/**
 * Settings in the browser (web/settings.js), without a browser: Your AI's instructions folded by
 * app and About's cards in a host, and what a plan includes. The texts are the core's English
 * catalog, so a key with no words shows as missing, as it would in an app.
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

test('in a host, Your AI has every module\'s instruction folded under its name, and About a card for each with its version', async () => {
  const { openSettings } = await import('../web/settings.js');
  const { t } = await import('../web/i18n.js');
  const { el } = await import('../web/dom.js');
  const realFetch = globalThis.fetch;
  const assigned = [];
  const modules = [
    { mount: 'tasks', path: '/tasks/', name: 'Tasks', icon: '/tasks/icons/favicon.svg', active: true, settings: { sections: [], data: false, ai: true, about: true, standing: 'settings.mcp.standingText' } },
    { mount: 'next', path: '/next/', name: 'Next', icon: '/next/icons/favicon.svg', active: true, settings: { sections: [], data: false, ai: false, about: true, standing: 'settings.standing.text' } },
    { mount: 'notes', path: '/notes/', name: 'Notes', icon: '/notes/icons/favicon.svg', active: true, settings: { sections: [], data: false, ai: false, about: false } },
  ];
  globalThis.fetch = async (path) => {
    const data = path === '/api/modules' ? { host: { name: 'Cronum Work', icon: '/icons/favicon.svg?v=2' }, modules }
      : path === '/next/i18n/en.json' ? { 'settings.standing.text': '- Log progress in Next.', 'app.tagline': 'Where each project stands' }
        : path === '/notes/i18n/en.json' ? { 'app.tagline': 'Your notes' } : undefined;
    return { ok: data !== undefined, status: data === undefined ? 404 : 200, json: async () => data };
  };
  globalThis.window = { location: { origin: 'https://work.example', assign: (to) => assigned.push(to) } };
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {} });
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  const loaded = { app: '0.5.0', name: 'Cronum Work', version: 'abc', modules: { tasks: { app: '1.80.0' }, next: { app: '0.23.0' }, notes: { app: '0.35.0' } } };
  try {
    const open = (start) => {
      const root = document.createElement('div');
      openSettings({
        app: { id: 'tasks', name: 'Tasks', icon: '/icons/favicon.svg', tagline: 'Your lists' }, user: { username: 'ada', role: 'user' }, root, start,
        config: { app: { modules: { mcp: true }, host: { id: 'work', name: 'Cronum Work', mount: 'tasks', base: '/tasks/', push: false, plans: false } } },
        standing: 'kit.settings.title',   // a key this catalog has, for the test
        aiExtra: () => el('p', { text: 'Examples' }),
        aboutExtra: () => el('p', { text: 'What Tasks is' }),
        updates: { check: async () => false, loaded: () => loaded, latest: () => loaded },
      });
      return root;
    };

    const ai = open('ai');
    await settle();
    const labels = ai.all().filter((node) => node.className === 'kit-settings__label').map((node) => node.textContent);
    assert.ok(!labels.includes(t('kit.settings.moduleAi')), 'with its instruction in Your AI, what it adds there is out of the list');
    const folds = ai.all().filter((node) => node.className === 'kit-fold');
    assert.deepEqual(folds.map((node) => node.find('summary')[0].textContent), ['Tasks', 'Next'], 'one per module with an instruction');
    assert.ok(folds.every((node) => node.getAttribute('name') === 'kit-standing' && !node.hasAttribute('open')), 'one open at a time, none at first');
    assert.equal(folds[0].find('pre')[0].textContent, t('kit.settings.title'));
    assert.equal(folds[1].find('pre')[0].textContent, '- Log progress in Next.', 'another module\'s, from its catalog');
    assert.equal(folds[1].find('img')[0].getAttribute('src'), '/next/icons/favicon.svg');
    // Opening one folds the other, where the browser doesn't do it by `name`.
    folds[0].open = true;
    folds[1].open = true;
    folds[1].dispatch('toggle');
    assert.equal(folds[0].open, false);
    // From its fold, what the module adds to Your AI: drawn here for this one.
    const more = folds[0].find('button').find((node) => node.textContent === t('kit.ai.standingMore', { app: 'Tasks' }));
    for (const fn of more.listeners.click) fn({ currentTarget: more });
    assert.ok(ai.all().find((node) => node.className === 'kit-settings__page').textContent.includes('Examples'));

    const about = open('about');
    await settle();
    const page = about.all().find((node) => node.className === 'kit-settings__page');
    const head = page.all().find((node) => node.className === 'kit-about');
    assert.equal(head.find('img')[0].getAttribute('src'), '/icons/favicon.svg?v=2', 'the host\'s icon, not the module\'s');
    assert.equal(head.find('strong')[0].textContent, 'Cronum Work');
    assert.ok(page.all().some((node) => node.tagName === 'A' && node.getAttribute('href') === 'https://github.com/cronumstudio/work'), 'the host\'s source');
    const cards = page.all().filter((node) => node.className === 'kit-about-card');
    assert.deepEqual(cards.map((card) => card.find('strong')[0].textContent), ['Tasks', 'Next', 'Notes']);
    assert.deepEqual(cards.map((card) => card.find('small')[0].textContent), ['v1.80.0', 'v0.23.0', 'v0.35.0']);
    assert.deepEqual(cards.map((card) => card.find('p')[0]?.textContent), ['Your lists', 'Where each project stands', 'Your notes']);
    // What a module says it is: another's, there; Notes says nothing.
    assert.equal(cards[2].find('button').length, 0);
    const nextMore = cards[1].find('button')[0];
    for (const fn of nextMore.listeners.click) fn({ currentTarget: nextMore });
    assert.deepEqual(assigned, ['/next/?settings=about-extra']);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete document.addEventListener;
    delete document.removeEventListener;
  }
});

test('what a plan includes, as people read it: what is in first, limits with their number or none', async () => {
  const { planBenefits } = await import('../web/settings.js');
  const { t } = await import('../web/i18n.js');
  const free = planBenefits({ 'lists.max': 20, 'storage.mb': 50, assign: false, mcp: true, 'mcp.calls_per_day': 100, unknown: 3 }, { app: 'Work' });
  assert.deepEqual(free, [
    { text: t('kit.plan.benefits.lists', { n: 20 }), included: true },
    { text: t('kit.plan.benefits.storage', { size: '50 MB' }), included: true },
    { text: t('kit.plan.benefits.mcp', { app: 'Work' }), included: true },
    { text: t('kit.plan.benefits.calls', { n: 100 }), included: true },
    { text: t('kit.plan.benefits.assign'), included: false },
  ]);
  const pro = planBenefits({ 'lists.max': null, 'storage.mb': 5120, 'retention.days': null });
  assert.deepEqual(pro.map((l) => l.text), [
    t('kit.plan.benefits.listsUnlimited'), t('kit.plan.benefits.storage', { size: '5 GB' }), t('kit.plan.benefits.retentionUnlimited'),
  ]);
  assert.deepEqual(planBenefits({ mcp: false, 'mcp.calls_per_day': 100 }), [{ text: t('kit.plan.benefits.mcp', { app: '' }), included: false }],
    'no calls without the assistant');
  assert.deepEqual(planBenefits({}), []);
});

