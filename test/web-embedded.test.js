/**
 * The web kit in a window of Cronum Work's one-document shell (mount.js): the frame drawn without
 * Work's rail, the person or the host's notices, and taken down whole; what the kit hangs on the
 * page's body marked as its module's; the theme and the language chosen in a module's Settings
 * going to the shell. Each module loads the kit from its own address, so here a copy is loaded as
 * Notes' (`https://work.test/notes/suite/…`, read from web/ by a loader hook), with /notes/ as its
 * base, as on Work's page. Without the shell's registry everything is as it always was.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { installFakeDom, FakeElement, FakeEventTarget } from './fake-dom.js';

const SITE = 'https://work.test/';
const WEB = new URL('../web/', import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(SITE)) return { url: specifier, shortCircuit: true };
    if (context.parentURL?.startsWith(SITE)) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith(SITE)) return next(url, context);
    const file = new URL(url).pathname.replace(/^\/[a-z-]+\/suite\//, '');
    return { format: 'module', source: fs.readFileSync(new URL(file, WEB), 'utf8'), shortCircuit: true };
  },
});

/* ---------------------------------- page ---------------------------------- */

const page = installFakeDom();
const win = Object.assign(new FakeEventTarget(), { innerWidth: 390, innerHeight: 800, location: { href: `${SITE}w/`, origin: SITE.slice(0, -1) } });
win.top = win;
win.self = win;
const storage = new Map();
Object.assign(globalThis, {
  window: win, Element: FakeElement, innerWidth: 390, innerHeight: 800,
  getComputedStyle: () => ({ direction: 'ltr', display: 'inline-grid', overflowY: 'visible' }),
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
});
FakeElement.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
page.documentElement.setAttribute('data-theme', 'dark');
page.documentElement.setAttribute('lang', 'es');

// What the page asks the server for: nothing at all from a frame in Work's shell.
const asked = [];
const answers = {};
globalThis.fetch = async (path, { method = 'GET' } = {}) => {
  asked.push(`${method} ${path}`);
  const answer = answers[`${method} ${path}`];
  return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, json: async () => answer ?? {} };
};

const REGISTRY = Symbol.for('cronum.work');
/** Work's shell on the page, with its theme and language, for the length of `run`. */
async function inWork(run, { lang = 'en' } = {}) {
  const told = { theme: [], language: [] };
  let current = lang;
  page[REGISTRY] = {
    open: async () => true,
    theme: { current: () => 'system', set: (theme) => told.theme.push(theme) },
    language: { current: () => current, set: (next) => { told.language.push(next); current = next; } },
  };
  try {
    return await run(told);
  } finally {
    delete page[REGISTRY];
  }
}

const notes = (file) => import(`${SITE}notes/suite/${file}`);
const options = (more = {}) => ({
  app: { id: 'notes', name: 'Notes' }, create: { label: 'New', onClick: () => {} },
  onSettings: () => {}, accountItems: [{ label: 'Export', onClick: () => {} }], ...more,
});
const counts = (...targets) => targets.map((target) => target.listenerCount());

/* ---------------------------------- frame --------------------------------- */

test('a module\'s frame in Work\'s shell: its sidebar and fold, no rail, no person, no switcher, and nothing asked of the host', async () => {
  const { createShell } = await notes('shell.js');
  const { BASE } = await notes('base.js');
  assert.equal(BASE, '/notes/', 'a copy of the kit as Notes loads it in Work');
  const root = page.createElement('div');
  page.body.append(root);
  storage.set('host.modules', JSON.stringify({ modules: [{ mount: 'notes', path: '/notes/', name: 'Notes', active: true }] }));
  asked.length = 0;
  const before = counts(page, win);

  const shell = createShell({ ...options(), root, embedded: true });
  const frame = shell.element;
  assert.equal(frame.parentNode, root, 'in the window, not on the body');
  assert.ok(frame.hasAttribute('data-module'), 'laid out as a host\'s module');
  assert.ok(frame.querySelector('.kit-side__fold'), 'its sidebar folds as ever');
  assert.ok(frame.querySelector('.kit-side__nav'));
  for (const piece of ['.kit-rail', '.kit-account', '.kit-side__foot', '.kit-side__app']) {
    assert.equal(frame.querySelector(piece), null, `${piece}: Work's shell has it, once`);
  }
  assert.equal(await shell.refreshModules(), null);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(asked, [], 'neither the modules nor the plan: the shell asks');
  assert.equal(win.listenerCount(), before[1], 'nothing on the window: resizes, looks and Settings are the shell\'s');
  assert.equal(shell.banners.children.length, 0, 'no founder\'s notice in a window');
  shell.destroy();
  assert.deepEqual(counts(page, win), before);
  assert.equal(root.children.length, 0);
  storage.clear();
});

test('Work asks a window for its module\'s Settings on the window\'s body, naming the section or not', async () => {
  const { createShell } = await notes('shell.js');
  const root = page.createElement('div');
  const opened = [];
  const shell = createShell({ ...options({ onSettings: (start) => opened.push(start ?? null) }), root, embedded: true });
  root.dispatch('kit:settings', { detail: { start: 'plan' } });
  root.dispatch('kit:settings', { detail: {} });
  win.dispatch('kit:settings', { detail: { start: 'ai' } });
  assert.deepEqual(opened, ['plan', null], 'the page\'s window is every module\'s: not there');
  shell.destroy();
  root.dispatch('kit:settings', {});
  assert.equal(opened.length, 2, 'taken down with the frame');
  assert.equal(root.listenerCount(), 0);
});

test('a module mounted and unmounted fifty times leaves nothing listening and nothing on the page', async () => {
  const { createShell } = await notes('shell.js');
  const root = page.createElement('div');
  page.body.append(root);
  const before = counts(page, win, root);
  const bodyBefore = page.body.children.length;
  for (let round = 0; round < 50; round += 1) {
    const shell = createShell({ ...options(), root, embedded: true });
    // A menu open as the window goes, as the module's own ⋯ may leave it.
    const { menu } = await notes('ui.js');
    menu(shell.element.querySelector('.kit-side__fold'), [{ label: 'One', onClick: () => {} }]);
    shell.destroy();
    (await notes('ui.js')).closeMenu();
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(counts(page, win, root), before);
  assert.equal(page.body.children.length, bodyBefore);
  assert.equal(root.children.length, 0);
  root.remove();
});

test('two windows pass a tap at the screen\'s edge on once; a frame on its own page still keeps the edge from Safari', async () => {
  const { createShell } = await notes('shell.js');
  const { el } = await notes('dom.js');
  const windows = [page.createElement('div'), page.createElement('div')];
  for (const root of windows) page.body.append(root);
  const touch = (target) => {
    let prevented = 0;
    page.dispatch('touchstart', { touches: [{ clientX: 5, clientY: 300 }], target, preventDefault: () => { prevented += 1; } });
    page.dispatch('touchend', { touches: [], target });
    return prevented;
  };
  const [left, right] = windows.map((root) => createShell({ ...options(), root, embedded: true }));
  const button = el('button', { type: 'button' });
  left.list.append(button);
  let clicks = 0;
  button.addEventListener('click', () => { clicks += 1; });
  assert.equal(touch(button), 1, 'taken once, by the window it is in');
  assert.equal(clicks, 1);
  const outside = el('div');
  page.body.append(outside);
  assert.equal(touch(outside), 0, 'the page\'s edge is the shell\'s to keep');
  left.destroy();
  right.destroy();

  // An app on its own page, as ever: an edge with history behind it is kept from the browser.
  const alone = createShell(options());
  assert.equal(touch(outside), 1);
  alone.destroy();
  outside.remove();
  for (const root of windows) root.remove();
});

/* ------------------------------ kit on the body ----------------------------- */

test('what the kit hangs on the body says whose it is, with the page\'s theme and language, only in Work\'s shell', async () => {
  const ui = await notes('ui.js');
  const { el } = await notes('dom.js');
  const pieces = () => {
    ui.toast('Saved');
    const toast = page.body.all().filter((node) => node.className.split(' ').includes('kit-toast')).at(-1);
    const { dialog, close } = ui.openDialog({ title: 'About', content: el('p', { text: 'Notes' }) });
    const anchor = el('button', { type: 'button' });
    page.body.append(anchor);
    const menu = ui.menu(anchor, [{ label: 'One', onClick: () => {} }]);
    const banner = ui.banner({ text: 'Offline' });
    const found = { toast, dialog, menu, banner };
    ui.closeMenu();
    close();
    anchor.remove();
    return found;
  };

  for (const [name, node] of Object.entries(pieces())) {
    assert.equal(node.getAttribute('data-owner'), null, `${name}: nothing changes outside Work's shell`);
    assert.equal(node.getAttribute('data-theme'), null, name);
  }
  await inWork(async () => {
    for (const [name, node] of Object.entries(pieces())) {
      assert.equal(node.getAttribute('data-owner'), 'notes', name);
      assert.equal(node.getAttribute('data-theme'), 'dark', `${name}: its sheet reads the page's theme on it`);
      assert.equal(node.getAttribute('lang'), 'es', name);
    }
    const box = page.body.all().find((node) => node.getAttribute('id') === 'kit-toasts');
    assert.equal(box.getAttribute('data-owner'), null, 'the box of notices is the page\'s, each notice its module\'s');

    // The kit of an app at the root (Work's own, or an app on its own) owns nothing.
    const own = await import('../web/ui.js');
    const { dialog, close } = own.openDialog({ title: 'About', content: el('p', { text: 'Work' }) });
    assert.equal(dialog.getAttribute('data-owner'), null);
    close();
  });
  for (const node of page.body.all().filter((n) => n.getAttribute('id') === 'kit-toasts')) node.remove();
});

/* -------------------------- Settings, theme, language ------------------------- */

/** A module's Settings on the page's body, at Appearance; `pick(value)` presses a theme. */
async function appearance({ applyTheme, setLanguage = null }) {
  const { openSettings } = await notes('settings.js');
  answers['PATCH /notes/api/me'] = { user: { username: 'ada', theme: 'dark', prefs: { lang: 'es' } } };
  const settings = openSettings({
    app: { id: 'notes', name: 'Notes' }, user: { username: 'ada', role: 'user', theme: 'dark' },
    config: { app: { languages: ['en', 'es'] } }, start: 'appearance', applyTheme, setLanguage,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const overlay = page.body.children.find((node) => node.className === 'kit-settings-page');
  return {
    overlay,
    pick: async (value) => {
      const button = overlay.all().find((node) => node.getAttribute('data-value') === value);
      assert.ok(button, `the theme ${value}`);
      await Promise.all(button.listeners.click.map((fn) => fn({ currentTarget: button })));
    },
    choose: async (lang) => {
      const select = overlay.all().find((node) => node.getAttribute('id') === 'kit-language');
      select.value = lang;
      await Promise.all(select.listeners.change.map((fn) => fn({ currentTarget: select })));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    close: () => {
      settings.close();
      for (const node of page.body.children.filter((n) => n.className === 'kit-settings-page')) node.remove();
    },
  };
}

test('a theme chosen in a module\'s Settings is the shell\'s to paint in Work, the module\'s on its own', async () => {
  const painted = [];
  const alone = await appearance({ applyTheme: (theme) => painted.push(theme) });
  assert.equal(alone.overlay.getAttribute('data-owner'), null);
  await alone.pick('light');
  assert.deepEqual(painted, ['light'], 'on its own, as ever');
  alone.close();

  await inWork(async (told) => {
    const settings = await appearance({ applyTheme: (theme) => painted.push(theme) });
    assert.equal(settings.overlay.getAttribute('data-owner'), 'notes', 'Settings on the body are the module\'s');
    const pressed = settings.overlay.all().find((node) => node.getAttribute('aria-pressed') === 'true');
    assert.equal(pressed?.getAttribute('data-value'), 'system', 'the page\'s theme shown, not the account\'s (dark)');
    await settings.pick('dark');
    assert.deepEqual(told.theme, ['dark'], 'one theme for every module, painted by the shell');
    assert.deepEqual(painted, ['light'], 'not written on <html> with the module\'s own key');
    settings.close();
  });
});

test('a language chosen in a module goes to the shell once; one the shell gives goes nowhere; on its own, nowhere', async () => {
  const i18n = await notes('i18n.js');
  for (const lang of ['en', 'es', 'fr']) answers[`GET /notes/i18n/${lang}.json`] = { 'x.hi': lang };
  const events = [];
  globalThis.dispatchEvent = (event) => { events.push(event.detail.lang); return true; };
  try {
    assert.equal(await i18n.changeLanguage('es'), 'es');
    assert.equal(i18n.shareLanguage('es'), false, 'no shell, nothing to tell');

    await inWork(async (told) => {
      // Chosen in this module: the shell hears it, and tells every module, this one too.
      await i18n.changeLanguage('fr');
      assert.deepEqual(told.language, ['fr']);
      await i18n.changeLanguage('fr');
      assert.deepEqual(told.language, ['fr'], 'the shell\'s news back here goes no further');
      assert.deepEqual(events, ['es', 'fr', 'fr'], 'the app draws itself again each time, as ever');
    }, { lang: 'en' });

    // The apps' Settings load the language themselves (loadLanguage): the kit's Settings tell the shell.
    await inWork(async (told) => {
      const settings = await appearance({ applyTheme: () => {}, setLanguage: (lang) => i18n.loadLanguage(lang) });
      await settings.choose('es');
      assert.deepEqual(told.language, ['es']);
      for (const node of page.body.children.filter((n) => n.className === 'kit-settings-page')) node.remove();
      // The language a module starts in is the shell's to give: loading one tells nobody.
      await i18n.loadLanguage('en');
      assert.deepEqual(told.language, ['es']);
      // Settings of an app that loads no language there (no setLanguage) push none of their own (en) on the shell.
      const quiet = await appearance({ applyTheme: () => {} });
      await quiet.choose('fr');
      assert.deepEqual(told.language, ['es']);
      quiet.close();
    }, { lang: 'fr' });
  } finally {
    delete globalThis.dispatchEvent;
  }
});

/* ---------------------------------- source --------------------------------- */

test('every file the kit\'s own files import is in the service worker\'s copy: offline, one missing stops the app', () => {
  const sw = fs.readFileSync(new URL('sw-core.js', WEB), 'utf8');
  const cached = new Set([.../SUITE_KIT_FILES = \[([^\]]*)\]/.exec(sw)[1].matchAll(/'\/suite\/([^']+)'/g)].map((m) => m[1]));
  assert.ok(cached.has('mount.js'));
  for (const file of [...cached].filter((name) => name.endsWith('.js'))) {
    const source = fs.readFileSync(new URL(file, WEB), 'utf8');
    for (const [, imported] of source.matchAll(/(?:from|import\()\s*'\.\/([\w-]+\.js)'/g)) {
      assert.ok(cached.has(imported), `${file} imports ${imported}`);
    }
  }
});
