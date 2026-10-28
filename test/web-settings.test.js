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

test('in a host, Your AI has every module\'s instruction folded under its name with what it says of it, and About a card for each with its version and website', async () => {
  const { openSettings } = await import('../web/settings.js');
  const { t } = await import('../web/i18n.js');
  const { el } = await import('../web/dom.js');
  const realFetch = globalThis.fetch;
  const assigned = [];
  const modules = [
    { mount: 'tasks', path: '/tasks/', name: 'Tasks', icon: '/tasks/icons/favicon.svg', active: true, settings: { sections: [], data: false, ai: true, about: true, standing: 'settings.mcp.standingText' } },
    { mount: 'next', path: '/next/', name: 'Next', icon: '/next/icons/favicon.svg', active: true,
      settings: { sections: [], data: false, ai: false, about: true, standing: 'settings.standing.text', site: 'https://next.example/',
        standingMore: ['settings.standing.prompt', ['ex.a', 'ex.aAsk'], ['ex.b', 'ex.bAsk'], 'no.such.key', 'settings.standing.close'] } },
    { mount: 'notes', path: '/notes/', name: 'Notes', icon: '/notes/icons/favicon.svg', active: true, settings: { sections: [], data: false, ai: false, about: false } },
  ];
  globalThis.fetch = async (path) => {
    const data = path === '/api/modules' ? { host: { name: 'Cronum Work', icon: '/icons/favicon.svg?v=2' }, modules }
      : path === '/next/i18n/en.json' ? {
        'settings.standing.text': '- Log progress in Next.', 'app.tagline': 'Where each project stands',
        'settings.standing.prompt': 'Or launch setup_next.', 'settings.standing.close': 'Close with close_session.',
        'ex.a': 'At work:', 'ex.aAsk': 'log this', 'ex.b': 'At home:', 'ex.bAsk': 'what next?',
      }
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
        standingMore: ['kit.settings.title', 'no.such.key'],
        site: 'https://tasks.example/',
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
    assert.ok(folds.every((node) => node.dataset.fold === 'kit-standing' && !node.hasAttribute('open')), 'one open at a time, none at first');
    assert.equal(folds[0].find('pre')[0].textContent, t('kit.settings.title'));
    assert.equal(folds[1].find('pre')[0].textContent, '- Log progress in Next.', 'another module\'s, from its catalog');
    assert.equal(folds[1].find('img')[0].getAttribute('src'), '/next/icons/favicon.svg');
    // Opening one folds the other (sliding, where there is motion: slidingDetails).
    const tap = (fold) => fold.find('summary')[0].dispatch('click', { preventDefault() {} });
    tap(folds[0]);
    tap(folds[1]);
    assert.deepEqual(folds.map((fold) => fold.open), [false, true]);
    tap(folds[1]);
    assert.equal(folds[1].open, false, 'and its summary folds it again');
    // Under the instruction, what each says of it, from its catalog: paragraphs, and pairs in a row as one list.
    const body = (fold) => fold.all().find((node) => node.className === 'kit-fold__body');
    assert.deepEqual(body(folds[1]).children.slice(2).map((node) => node.tagName), ['P', 'UL', 'P'], 'a key it lacks is left out');
    assert.deepEqual(body(folds[1]).find('li').map((li) => li.textContent), ['At work: log this', 'At home: what next?']);
    assert.equal(body(folds[1]).find('strong')[0].textContent, 'At work:');
    assert.equal(body(folds[0]).children.at(-1).textContent, t('kit.settings.title'), 'this module\'s from its own catalog');
    assert.ok(!body(folds[0]).find('button').some((node) => node.className === 'kit-link'), 'nothing takes the person away from here');

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
    // What it is, on its website, in a tab of its own; Notes has none.
    const links = cards.map((card) => card.find('a')[0]);
    assert.deepEqual(links.map((a) => a?.getAttribute('href')), ['https://tasks.example/', 'https://next.example/', undefined]);
    assert.equal(links[1].getAttribute('target'), '_blank');
    assert.deepEqual(assigned, []);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete document.addEventListener;
    delete document.removeEventListener;
  }
});

test('in Work’s shell a module passes no watcher: About shows the whole app’s version and checks and updates with the shell’s', async () => {
  const { openSettings } = await import('../web/settings.js');
  const { t } = await import('../web/i18n.js');
  const REGISTRY = Symbol.for('cronum.work');
  const realFetch = globalThis.fetch;
  const modules = [
    { mount: 'tasks', path: '/tasks/', name: 'Tasks', icon: '/tasks/icons/favicon.svg', active: true, settings: { sections: [], data: false, ai: false, about: true } },
    { mount: 'notes', path: '/notes/', name: 'Notes', icon: '/notes/icons/favicon.svg', active: true, settings: { sections: [], data: false, ai: false, about: true } },
  ];
  globalThis.fetch = async (path) => {
    const data = path === '/api/modules' ? { host: { name: 'Cronum Work', icon: '/icons/favicon.svg' }, modules }
      : path === '/notes/i18n/en.json' ? { 'app.tagline': 'Your notes' } : undefined;
    return { ok: data !== undefined, status: data === undefined ? 404 : 200, json: async () => data };
  };
  globalThis.window = { location: { origin: 'https://work.example', assign: () => {} } };
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {} });
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  const loaded = { app: '0.34.4', name: 'Cronum Work', version: 'abc', modules: { tasks: { app: '1.121.0' }, notes: { app: '0.71.0' } } };
  const latest = { app: '0.34.5', name: 'Cronum Work', version: 'def' };
  const asked = [];
  const applied = [];
  document[REGISTRY] = {
    updates: { check: async (opts) => { asked.push(opts); return true; }, loaded: () => loaded, latest: () => latest },
    applyUpdate: (event) => applied.push(['shell', event]),
  };
  try {
    const root = document.createElement('div');
    // As Tasks does when mounted in a window of the shell: `updates` is null, its own applyUpdate.
    openSettings({
      app: { id: 'tasks', name: 'Tasks', icon: '/icons/favicon.svg', tagline: 'Your lists' }, user: { username: 'ada', role: 'user' }, root, start: 'about',
      config: { app: { modules: {}, host: { id: 'work', name: 'Cronum Work', mount: 'tasks', base: '/tasks/', push: false, plans: false } } },
      updates: null, applyUpdate: (event) => applied.push(['module', event]),
    });
    await settle();
    const page = document.body.all().find((node) => node.className === 'kit-settings__page');
    const facts = page.all().filter((node) => node.className === 'kit-fact');
    assert.equal(facts[0].find('strong')[0].textContent, 'Cronum Work v0.34.4', 'the whole app’s version, not «—»');
    assert.deepEqual(asked, [{ announce: true }], 'opening it asks the shell’s watcher');
    assert.ok(!page.all().some((node) => node.textContent === t('kit.about.unknown')), 'the server was asked');
    assert.ok(page.all().some((node) => node.tagName === 'STRONG' && node.textContent === 'v0.34.5'), 'the new version named');
    const cards = page.all().filter((node) => node.className === 'kit-about-card');
    assert.deepEqual(cards.map((card) => card.find('small')[0]?.textContent), ['v1.121.0', 'v0.71.0'], 'each module’s version');
    const update = page.all().find((node) => node.tagName === 'BUTTON' && node.textContent === t('kit.about.update'));
    update.dispatch('click', {});
    assert.equal(applied.length, 1);
    assert.equal(applied[0][0], 'shell', 'the shell’s update, which waits for the whole app’s worker');
    // «Check» asks again.
    page.all().find((node) => node.tagName === 'BUTTON' && node.textContent === t('kit.about.check')).dispatch('click', {});
    await settle();
    assert.equal(asked.length, 2);
  } finally {
    delete document[REGISTRY];
    document.body.all().filter((node) => node.className === 'kit-settings-page').forEach((node) => node.remove());
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete document.addEventListener;
    delete document.removeEventListener;
  }
});

test('in a host with one prompt, Your AI has a chip for each agent with its steps, the prompt for the modules ticked and what each module adds', async () => {
  const { openSettings } = await import('../web/settings.js');
  const { t } = await import('../web/i18n.js');
  const { AGENTS } = await import('../web/agents.js');
  const realFetch = globalThis.fetch;
  const asked = [];
  const modules = [
    { mount: 'tasks', path: '/tasks/', name: 'Tasks', icon: '/tasks/icons/favicon.svg', active: true, settings: { sections: [], data: false, ai: true, about: true, standing: 'settings.mcp.standingText' } },
    { mount: 'next', path: '/next/', name: 'Next', icon: '/next/icons/favicon.svg', active: true,
      settings: { sections: [], data: false, ai: false, about: true, standing: 'settings.standing.text', standingMore: ['settings.standing.close'] } },
    { mount: 'notes', path: '/notes/', name: 'Notes', icon: '/notes/icons/favicon.svg', active: false, settings: { sections: [], data: false, ai: false, about: false } },
  ];
  globalThis.fetch = async (path) => {
    asked.push(path);
    const prompt = path.startsWith('/api/ai-instruction?') ? { text: `PROMPT ${new URL(path, 'https://work.example').searchParams.get('modules')}` } : undefined;
    const data = prompt || (path === '/api/modules' ? { host: { name: 'Cronum Work', icon: '/icons/favicon.svg', aiInstruction: '/api/ai-instruction' }, modules }
      : path === '/next/i18n/en.json' ? { 'settings.standing.text': '- Log progress in Next.', 'settings.standing.close': 'Close with close_session.' } : undefined);
    return { ok: data !== undefined, status: data === undefined ? 404 : 200, json: async () => data };
  };
  globalThis.window = { location: { origin: 'https://work.example' } };
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {} });
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  try {
    const root = document.createElement('div');
    openSettings({
      app: { id: 'tasks', name: 'Tasks', icon: '/icons/favicon.svg' }, user: { username: 'ada', role: 'user' }, root, start: 'ai',
      config: { app: { modules: { mcp: true }, host: { id: 'work', name: 'Cronum Work', mount: 'tasks', base: '/tasks/', push: false, plans: false } } },
      standing: 'kit.settings.title', standingMore: ['kit.settings.title'],
    });
    await settle();
    const page = root.all().find((node) => node.className === 'kit-settings__page');
    const titles = page.all().filter((node) => node.tagName === 'H3' && !node.closest?.('[hidden]')).map((node) => node.textContent);
    assert.ok(titles.includes(t('kit.ai.agentsTitle')) && titles.includes(t('kit.ai.promptTitle')));
    const standing = page.all().find((node) => node.tagName === 'H3' && node.textContent === t('kit.ai.standingTitle'));
    assert.equal(standing.parentNode.hidden, true, 'each module\'s own instruction gives way to the one prompt');

    // A chip for each agent, with its mark; one opens its steps, the connector's address among them.
    const chips = page.all().filter((node) => node.className === 'kit-agent');
    assert.deepEqual(chips.map((chip) => chip.find('span')[0].textContent), AGENTS.map((a) => a.name));
    assert.ok(chips.every((chip) => chip.find('svg').length === 1));
    chips.find((chip) => chip.getAttribute('data-agent') === 'claude-code').click();
    const dialog = document.body.all().filter((node) => node.tagName === 'DIALOG').at(-1);
    assert.equal(dialog.getAttribute('aria-label'), t('kit.ai.agentTitle', { agent: 'Claude Code' }));
    const codes = dialog.find('code').map((node) => node.textContent);
    assert.deepEqual(codes, ['claude mcp add --transport http cronum-work https://work.example/mcp']);
    assert.equal(dialog.find('li').at(-1).textContent, t('kit.agents.lastSection', { agent: 'Claude Code', app: 'Cronum Work' }), 'the last step sends to the prompt');
    dialog.close();

    // The prompt: the host's, for the modules in use, ticked; another tick asks for it again.
    assert.ok(asked.some((path) => path === '/api/ai-instruction?lang=en&modules=tasks,next'), asked.join(' '));
    const pre = page.all().find((node) => node.tagName === 'PRE' && node.textContent.startsWith('PROMPT'));
    assert.equal(pre.textContent, 'PROMPT tasks,next');
    const boxes = page.all().filter((node) => node.tagName === 'INPUT' && node.getAttribute('type') === 'checkbox');
    assert.deepEqual(boxes.map((box) => box.checked), [true, true, false]);
    boxes[2].checked = true;
    boxes[2].dispatch('change');
    await settle();
    assert.equal(pre.textContent, 'PROMPT tasks,next,notes');
    for (const box of boxes) {
      box.checked = false;
      box.dispatch('change');
    }
    await settle();
    assert.ok(page.all().some((node) => node.className === 'kit-hint' && node.textContent === t('kit.ai.promptNone') && !node.hidden), 'none ticked, none to copy');

    // Under it, what each module in use says of it, folded under its name, without its own instruction.
    const folds = page.all().filter((node) => node.className === 'kit-fold');
    assert.deepEqual(folds.map((node) => node.find('summary')[0].textContent), ['Tasks', 'Next']);
    assert.deepEqual(folds.map((node) => node.find('pre').length), [0, 0]);
    assert.equal(folds[1].find('p').at(-1).textContent, 'Close with close_session.');
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
  assert.deepEqual(planBenefits({ mcp: true, 'mcp.calls_per_week': 2000 }).map((l) => l.text).at(-1), t('kit.plan.benefits.callsWeek', { n: 2000 }));
  assert.equal(t('kit.plan.benefits.callsWeek', { n: 2000 }), '2,000 calls a week from your AI');
  assert.deepEqual(planBenefits({ mcp: true, 'mcp.calls_per_week': null }).map((l) => l.text).at(-1), t('kit.plan.benefits.callsWeekUnlimited'));
  assert.deepEqual(planBenefits({ mcp: false, 'mcp.calls_per_week': 100 }).length, 1, 'nor by the week');
  assert.deepEqual(planBenefits({ mcp: true, 'mcp.calls_per_day': 100, 'mcp.calls_per_week': 100 }).map((l) => l.text).slice(1),
    [t('kit.plan.benefits.callsWeek', { n: 100 })], 'by the week, the daily ones a module still declares are left out');
  assert.deepEqual(planBenefits({}), []);
});


test('in a host, «every tool from the start» is kept at the host\'s own route, at the site\'s root', async () => {
  const { openSettings } = await import('../web/settings.js');
  const { t } = await import('../web/i18n.js');
  const realFetch = globalThis.fetch;
  const modules = [{ mount: 'tasks', path: '/tasks/', name: 'Tasks', icon: '/tasks/icons/favicon.svg', active: true, settings: { sections: [], data: false, ai: false, about: false } }];
  const sent = [];
  let kept = 'door';
  globalThis.fetch = async (path, { method = 'GET', body } = {}) => {
    sent.push({ method, path, body: body ? JSON.parse(body) : undefined });
    const data = path === '/api/modules' ? { host: { name: 'Cronum Work' }, modules, ai_tools: kept }
      : method === 'PUT' && path === '/api/me/ai-tools' ? { ai_tools: (kept = JSON.parse(body).ai_tools) }
        : path === '/api/me/apps' ? { enabled: false, grants: [] } : path === '/api/me/tokens' ? [] : undefined;
    return { ok: data !== undefined, status: data === undefined ? 404 : 200, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
  };
  globalThis.window = { location: { origin: 'https://work.example', assign: () => {} } };
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {} });
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  try {
    const root = document.createElement('div');
    openSettings({
      app: { id: 'tasks', name: 'Tasks', icon: '/icons/favicon.svg' }, user: { username: 'ada', role: 'user' }, root, start: 'ai',
      config: { app: { modules: { mcp: true }, host: { id: 'work', name: 'Cronum Work', mount: 'tasks', base: '/tasks/', push: false, plans: false } } },
    });
    await settle();
    const toggle = root.all().find((node) => node.getAttribute('aria-label') === t('kit.ai.toolsAll'));
    assert.ok(toggle, 'the host says some tools are on demand: the switch shows');
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    toggle.dispatch('click', {});
    await settle();
    assert.deepEqual(sent.filter((r) => r.method === 'PUT'), [{ method: 'PUT', path: '/api/me/ai-tools', body: { ai_tools: 'all' } }]);
    assert.equal(toggle.getAttribute('aria-checked'), 'true', 'the host kept it: the switch stays on');
    // In a module's page the kit's paths are the module's (/tasks/api/…); this one is the host's.
    const source = fs.readFileSync(new URL('../web/settings.js', import.meta.url), 'utf8');
    assert.match(source, /api\.root\.put\('\/api\/me\/ai-tools'/);
    assert.doesNotMatch(source, /[^.]api\.put\('\/api\/me\/ai-tools'/);
  } finally {
    document.body.all().filter((node) => node.className === 'kit-settings-page').forEach((node) => node.remove());
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete document.addEventListener;
    delete document.removeEventListener;
  }
});

test('Escape over Settings is the top dialog\'s alone: with one open over them, Settings stay', async () => {
  const { openSettings } = await import('../web/settings.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) });
  globalThis.window = { location: { origin: 'https://work.example', assign: () => {} }, matchMedia: () => ({ matches: true }) };
  const keys = [];
  const realQuery = document.querySelector;
  let dialogOpen = false;
  Object.assign(document, {
    addEventListener: (type, fn) => { if (type === 'keydown') keys.push(fn); },
    removeEventListener: (type, fn) => { if (keys.includes(fn)) keys.splice(keys.indexOf(fn), 1); },
    querySelector: (selector) => (selector === 'dialog[open]' && dialogOpen ? {} : null),
  });
  let closed = 0;
  try {
    const root = document.createElement('div');
    openSettings({
      app: { id: 'notes', name: 'Notes', icon: '/icons/favicon.svg' }, user: { username: 'ada', role: 'user' }, root,
      config: { app: { modules: {} } }, onClose: () => { closed += 1; },
    });
    const press = (event = {}) => { for (const fn of [...keys]) fn({ key: 'Escape', defaultPrevented: false, ...event }); };
    dialogOpen = true;
    press();
    assert.equal(closed, 0, 'a dialog over Settings: it closes, Settings stay');
    dialogOpen = false;
    press({ defaultPrevented: true });
    assert.equal(closed, 0, 'a menu that took the key: Settings stay');
    press();
    assert.equal(closed, 1, 'with nothing over them, Escape closes Settings');
  } finally {
    document.body.all().filter((node) => node.className === 'kit-settings-page').forEach((node) => node.remove());
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete document.addEventListener;
    delete document.removeEventListener;
    document.querySelector = realQuery;
  }
});
