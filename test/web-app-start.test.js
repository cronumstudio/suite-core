/**
 * How a module's page starts, written once in the kit (web/app-start.js): the theme painted on a
 * module's own page or told to Cronum Work's shell, the system's followed, the notice of a new
 * version, Settings another module asked for, the iPhone's canvas; the language a browser
 * resolved, told to the server (i18n.js reportLanguage); and a banner given as a function
 * (shell.js), which a frame drawn again in a new language shows again. Run with a made-up page.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom, FakeElement, FakeEventTarget } from './fake-dom.js';

const document = installFakeDom();
const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });
const { loadLanguage, t, reportLanguage } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
globalThis.fetch = realFetch;

const {
  THEMES, savedTheme, applyAppTheme, followSystemTheme, watchAppVersion, askedSettings,
  markCroppedCanvas,
} = await import('../web/app-start.js');

const read = (file) => fs.readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');

/** This browser's localStorage, which a private window may refuse (`broken`). */
function fakeStorage() {
  const kept = new Map();
  return {
    kept,
    broken: false,
    getItem(key) { if (this.broken) throw new Error('no storage'); return kept.has(key) ? kept.get(key) : null; },
    setItem(key, value) { if (this.broken) throw new Error('no storage'); kept.set(key, String(value)); },
    removeItem(key) { kept.delete(key); },
  };
}

/** The system's dark mode, as matchMedia gives it: `matches`, and its `change`. */
function fakeScheme(dark = false) {
  const media = Object.assign(new FakeEventTarget(), { matches: dark });
  globalThis.matchMedia = (query) => (query === '(prefers-color-scheme: dark)' ? media : { matches: false, addEventListener() {} });
  return media;
}

const fakeTimers = () => ({ setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {} });
const themeOf = () => document.documentElement.getAttribute('data-theme');

/* --------------------------------- theme ---------------------------------- */

test('on a module’s own page the theme is resolved on <html>, kept for theme.js, and anything else is the system’s', () => {
  globalThis.localStorage = fakeStorage();
  const scheme = fakeScheme(false);
  assert.deepEqual(THEMES, ['light', 'dark', 'system']);
  assert.equal(savedTheme('notes'), 'system', 'nothing kept: the system’s');
  assert.equal(applyAppTheme('notes', 'dark'), 'dark');
  assert.equal(themeOf(), 'dark');
  assert.equal(localStorage.getItem('notes.theme'), 'dark', '<app>.theme, which theme.js reads');
  assert.equal(savedTheme('notes'), 'dark');
  assert.equal(applyAppTheme('notes', 'system'), 'system');
  assert.equal(themeOf(), 'light', 'never "system" on the page: the system’s, resolved');
  scheme.matches = true;
  applyAppTheme('notes', 'system');
  assert.equal(themeOf(), 'dark');
  assert.equal(applyAppTheme('notes', 'purple'), 'system', 'not a theme');
  assert.equal(localStorage.getItem('notes.theme'), 'system');
  assert.equal(localStorage.getItem('tasks.theme'), null, 'each app keeps its own');
  // A private window keeps nothing: the page is painted all the same.
  localStorage.broken = true;
  assert.equal(applyAppTheme('tasks', 'light'), 'light');
  assert.equal(themeOf(), 'light');
  assert.equal(savedTheme('tasks'), 'system');
  delete globalThis.localStorage;
  delete globalThis.matchMedia;
});

test('in a window of Cronum Work the theme is the shell’s: told to it, the page left alone; Notes tells only another one', () => {
  globalThis.localStorage = fakeStorage();
  document.documentElement.setAttribute('data-theme', 'light');
  let current = 'dark';
  const told = [];
  const services = { theme: { current: () => current, set: (theme) => { told.push(theme); current = theme; } } };
  assert.equal(applyAppTheme('tasks', 'dark', { embedded: true, services }), 'dark');
  assert.deepEqual(told, ['dark'], 'told, even the theme it has (Tasks, Projects, Next)');
  assert.equal(themeOf(), 'light', 'the shell paints the page');
  assert.equal(localStorage.kept.size, 0, 'and keeps it');
  applyAppTheme('notes', 'dark', { embedded: true, services, ifOther: true });
  assert.deepEqual(told, ['dark'], 'the one it has: nothing');
  applyAppTheme('notes', 'light', { embedded: true, services, ifOther: true });
  assert.deepEqual(told, ['dark', 'light']);
  // The module's place as it is, with its getters.
  const place = { get embedded() { return true; }, get services() { return services; } };
  applyAppTheme('projects', 'nonsense', place);
  assert.deepEqual(told, ['dark', 'light', 'system']);
  assert.doesNotThrow(() => applyAppTheme('projects', 'dark', { embedded: true, services: null }), 'a shell without the service');
  assert.doesNotThrow(() => applyAppTheme('projects', 'dark', { embedded: true, services: { theme: {} } }));
  assert.equal(themeOf(), 'light');
  delete globalThis.localStorage;
});

test('"the system’s" is followed while the page is open, only while it is the choice, and stops with the mount’s signal', () => {
  globalThis.localStorage = fakeStorage();
  const scheme = fakeScheme(false);
  const listening = new AbortController();
  localStorage.setItem('tasks.theme', 'system');
  followSystemTheme('tasks', { signal: listening.signal });
  scheme.matches = true;
  scheme.dispatch('change');
  assert.equal(themeOf(), 'dark', 'nightfall');
  localStorage.setItem('tasks.theme', 'light');
  applyAppTheme('tasks', 'light');
  scheme.matches = false;
  scheme.dispatch('change');
  scheme.matches = true;
  scheme.dispatch('change');
  assert.equal(themeOf(), 'light', 'a theme of its own stays');
  // The choice in force may be the account's (Notes, Next).
  const user = { theme: 'system' };
  followSystemTheme('notes', { theme: () => user.theme || 'system', signal: listening.signal });
  scheme.matches = false;
  scheme.dispatch('change');
  assert.equal(themeOf(), 'light');
  assert.equal(localStorage.getItem('notes.theme'), 'system');
  listening.abort();
  assert.equal(scheme.listenerCount(), 0, 'nothing left listening once unmounted');
  delete globalThis.localStorage;
  delete globalThis.matchMedia;
});

/* ----------------------------- a new version ------------------------------ */

test('the notice of a new version is the kit’s: written in the language of the moment, named after the app or the whole host, closed for a round', async () => {
  let server = { version: 'b' };
  const shown = [];
  let clock = 0;
  const updates = watchAppVersion({
    app: { id: 'tasks', name: 'Tasks' },
    show: (id, write) => shown.push([id, write]),
    fetch: async () => ({ ok: true, json: async () => server }),
    loadLocal: async () => ({ version: 'a' }),
    timers: fakeTimers(), doc: null, host: async () => null, now: () => clock, every: 1000,
  });
  assert.equal(await updates.check(), true);
  const [id, write] = shown.at(-1);
  assert.equal(id, 'update');
  assert.equal(typeof write, 'function', 'a function: a frame drawn again in another language writes it anew');
  const options = write();
  assert.equal(options.kind, 'accent');
  assert.equal(options.iconName, 'refresh');
  assert.equal(options.text, 'There is a new version of Tasks.');
  assert.equal(options.action.label, t('kit.update.apply'));
  assert.equal(typeof options.action.onClick, 'function');
  // Closed: quiet until the next round, as watchUpdates keeps it.
  const before = shown.length;
  options.onClose();
  await updates.check();
  assert.equal(shown.length, before, 'closed: not again right away');
  clock += 1000;
  // The host's whole app has a name of its own (Cronum Work): the notice says it.
  server = { version: 'c', name: 'Cronum Work' };
  await updates.check();
  assert.equal(shown.at(-1)[1]().text, 'There is a new version of Cronum Work.');
  updates.stop();
});

/* ---------------------------- Settings asked for --------------------------- */

test('Settings another module asked for open once, when the module is ready, and from the address with their code only then', async () => {
  const opened = [];
  let ready = false;
  const asked = askedSettings({ ready: () => ready, open: (start) => opened.push(start) });
  assert.equal(asked.open(), false, 'nothing asked');
  asked.ask('notices');
  assert.equal(asked.open(), false, 'not ready yet');
  assert.deepEqual(opened, []);
  ready = true;
  assert.equal(asked.open(), true);
  assert.deepEqual(opened, ['notices']);
  assert.equal(asked.open(), false, 'once');
  asked.ask('plan');
  asked.ask(null);
  assert.equal(asked.open(), false, 'asked for none: the one before is forgotten');
  // The page's address names it (`?settings=`): taken off it, then open() as above.
  const replaced = [];
  globalThis.window = { location: { href: 'https://work.example/tasks/?settings=data' }, history: { state: null, replaceState: (_s, _t, to) => replaced.push(to) } };
  try {
    await asked.fromAddress();
    assert.deepEqual(opened, ['notices', 'data']);
    assert.deepEqual(replaced, ['/tasks/'], 'going back or reloading doesn’t open them again');
    ready = false;
    window.location.href = 'https://work.example/tasks/?settings=templates';
    await asked.fromAddress();
    assert.deepEqual(opened, ['notices', 'data'], 'not ready: it waits for open()');
    ready = true;
    assert.equal(asked.open(), true);
    assert.deepEqual(opened, ['notices', 'data', 'templates']);
  } finally {
    delete globalThis.window;
  }
  assert.doesNotMatch(read('app-start.js'), /^import[^;]*'\.\/settings\.js'/m, 'Settings’ code isn’t loaded with the start');
});

/* ---------------------------- the iPhone canvas ---------------------------- */

test('an iPhone’s Home Screen app drawn short of the screen is marked on <html>, checked rather than assumed', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const html = document.documentElement;
  let inset = 62;
  FakeElement.prototype.getBoundingClientRect = function box() { return { height: this.style.cssText?.includes('safe-area-inset-top') ? inset : 0 }; };
  /** A phone: its browser, whether the app is on its Home Screen, and its measures. */
  const phone = ({ agent = IPHONE, platform = 'iPhone', touch = 5, standalone = true, width = 402, height = 812, screen = 874 } = {}) => {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: agent, platform, maxTouchPoints: touch, standalone }, configurable: true, writable: true });
    globalThis.window = { innerWidth: width, innerHeight: height, screen: { height: screen } };
    html.dataset = {};
  };
  try {
    phone();
    markCroppedCanvas();
    assert.equal(html.dataset.canvas, 'cropped', '812 drawn of 874: exactly the clock’s gap left over');
    assert.equal(document.body.children.length, 0, 'the probe went');
    inset = 0;
    html.dataset.canvas = 'cropped';
    globalThis.window = { innerWidth: 402, innerHeight: 874, screen: { height: 874 } };
    markCroppedCanvas();
    assert.equal(html.dataset.canvas, undefined, 'drawn to the edge: no mark');
    inset = 62;
    phone({ width: 874, height: 402 });
    html.dataset.canvas = 'kept';
    markCroppedCanvas();
    assert.equal(html.dataset.canvas, 'kept', 'in landscape it can’t be compared: left as it was');
    phone({ standalone: false });
    markCroppedCanvas();
    assert.equal(html.dataset.canvas, undefined, 'in Safari’s tab: never');
    phone({ agent: ANDROID, platform: 'Linux armv8l' });
    markCroppedCanvas();
    assert.equal(html.dataset.canvas, undefined, 'Android draws to the edge');
    phone({ agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', touch: 5 });
    markCroppedCanvas();
    assert.equal(html.dataset.canvas, 'cropped', 'an iPad says it is a Mac, with fingers');
  } finally {
    delete FakeElement.prototype.getBoundingClientRect;
    delete globalThis.window;
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    else delete globalThis.navigator;
    html.dataset = {};
  }
});

/* ------------------------------ the language ------------------------------- */

test('the language a browser resolved is told to the server once per change, and only while the person follows the browser’s', async () => {
  const sent = [];
  const send = async (body) => { sent.push(body); };
  const ana = { prefs: { lang: 'auto', tz: 'Europe/Madrid' } };
  assert.equal(reportLanguage(ana, 'es', { send }), 'es');
  assert.deepEqual(ana.prefs, { lang: 'auto', tz: 'Europe/Madrid', lang_seen: 'es' }, 'kept on the person: the next start says nothing');
  assert.equal(reportLanguage(ana, 'es', { send }), null, 'the same again: nothing');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent, [{ prefs: { lang_seen: 'es' } }]);
  assert.equal(reportLanguage({ prefs: {} }, 'fr', { send }), 'fr', 'no choice is the browser’s');
  assert.equal(reportLanguage({}, 'de', { send }), 'de');
  const chose = { prefs: { lang: 'fr', lang_seen: 'de' } };
  assert.equal(reportLanguage(chose, 'es', { send }), null, 'a language chosen: never');
  assert.deepEqual(chose.prefs, { lang: 'fr', lang_seen: 'de' });
  assert.equal(reportLanguage(null, 'es', { send }), null);
  assert.equal(reportLanguage({ prefs: { lang: 'auto' } }, null, { send }), null, 'no language loaded');
  // A hint only: a failure, even a throw, is nobody's error.
  assert.equal(reportLanguage({ prefs: {} }, 'it', { send: () => { throw new Error('offline'); } }), 'it');
  assert.equal(reportLanguage({ prefs: {} }, 'it', { send: async () => { throw new Error('offline'); } }), 'it');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.length, 3);
});

/* ------------------------- a banner as a function -------------------------- */

/** A page for whole frames: a phone-wide window, and what the frame asks of the browser. */
async function framePage() {
  const saved = Object.fromEntries(['window', 'Element', 'getComputedStyle', 'innerWidth', 'innerHeight']
    .map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const win = Object.assign(new FakeEventTarget(), { innerWidth: 390, innerHeight: 800 });
  Object.assign(globalThis, {
    window: win, Element: FakeElement, innerWidth: 390, innerHeight: 800,
    getComputedStyle: () => ({ direction: 'ltr', display: 'inline-grid', overflowY: 'visible' }),
  });
  FakeElement.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
  document.body.replaceChildren();
  return () => {
    delete FakeElement.prototype.getBoundingClientRect;
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

test('a banner given as a function: the same words stay on screen, new ones draw it anew, and the frame keeps it until closed or hidden', async () => {
  const restore = await framePage();
  try {
    const { createShell } = await import('../web/shell.js');
    const options = () => ({ app: { id: 'notes', name: 'Notes' }, onSettings: () => {} });
    const shell = createShell(options());
    let text = 'Offline';
    let closed = 0;
    const write = () => ({ kind: 'warn', text, action: { label: 'Retry', onClick: () => {} }, onClose: () => { closed += 1; } });
    const first = shell.showBanner('offline', write);
    assert.equal(shell.banners.children.length, 1);
    assert.equal(shell.showBanner('offline', write), first, 'the same words: the one on screen, its focus and its announcement too');
    text = 'Sending 2';
    const second = shell.showBanner('offline', write);
    assert.notEqual(second, first);
    assert.deepEqual(shell.banners.children, [second], 'in its place');
    assert.equal(shell.keptBanners().get('offline'), write, 'kept, for a frame drawn anew');
    // Closed by the person: gone, the module told, and not kept.
    second.querySelector('.kit-icon-btn').click();
    assert.equal(closed, 1);
    assert.equal(shell.banners.children.length, 0);
    assert.equal(shell.keptBanners().size, 0);
    // Hidden by the module: not kept either.
    shell.showBanner('update', write);
    shell.hideBanner('update');
    assert.equal(shell.keptBanners().size, 0);
    assert.equal(shell.banners.children.length, 0);
    // Options as before: drawn anew each time, never kept; and one shown so after a function is no function's.
    const plain = shell.showBanner('note', { text: 'Hi' });
    assert.notEqual(shell.showBanner('note', { text: 'Hi' }), plain);
    shell.showBanner('push', write);
    shell.showBanner('push', { text: 'Plain' });
    assert.equal(shell.keptBanners().has('push'), false);
    // A banner without onClose has no ×, as before.
    const fixed = shell.showBanner('fixed', () => ({ text: 'Fixed' }));
    assert.equal(fixed.querySelector('.kit-icon-btn'), null);
    // A frame drawn again in another language shows what the old one kept, in the new words.
    text = 'Sin conexión';
    shell.showBanner('offline', write);
    const kept = shell.keptBanners();
    assert.deepEqual([...kept.keys()], ['fixed', 'offline'], 'in the order they came');
    shell.destroy();
    const again = createShell(options());
    for (const [id, written] of kept) again.showBanner(id, written);
    assert.deepEqual(again.banners.children.map((node) => node.textContent), ['Fixed', 'Sin conexiónRetry']);
    again.destroy();
  } finally {
    restore();
  }
});
