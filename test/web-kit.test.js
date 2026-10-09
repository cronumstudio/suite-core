/**
 * The web kit's moving parts, without a browser: the outbox (order,
 * idempotency keys, provisional ids, when it stops), the live channel
 * (grouping, resync, reconnection) and the new-version notice; and the
 * colours of every product, measured.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

installFakeDom();
const { createOutbox, tempId, isTempId } = await import('../web/outbox.js');
const { memoryLocal } = await import('../web/local.js');
const { Offline, SessionExpired, ApiError } = await import('../web/api.js');
const { connectLive } = await import('../web/live.js');
const { watchUpdates, applyUpdate } = await import('../web/update.js');

/* --------------------------------- outbox --------------------------------- */

test('the outbox sends in order, with each change’s id as its key, and swaps provisional ids', async () => {
  const sent = [];
  let next = 40;
  const created = [];
  const outbox = createOutbox({
    local: memoryLocal(), locks: null,
    send: async (op) => {
      sent.push({ method: op.method, path: op.path, body: op.body, key: op.id });
      return op.method === 'POST' && op.path === '/api/notes' ? { id: next++ } : { ok: true };
    },
    onCreated: (info) => created.push([info.tempId, info.id]),
  });
  const draft = tempId();
  assert.ok(isTempId(draft));
  await outbox.add({ method: 'POST', path: '/api/notes', body: { text: 'a', client_ref: draft }, tempId: draft });
  await outbox.add({ method: 'PATCH', path: `/api/notes/${draft}`, body: { text: 'ab' } });
  await outbox.add({ method: 'POST', path: '/api/links', body: { note: draft } });
  assert.equal(await outbox.count(), 3);

  const report = await outbox.flush();
  assert.equal(report.sent, 3);
  assert.equal(report.left, 0);
  assert.deepEqual(sent.map((s) => `${s.method} ${s.path}`), ['POST /api/notes', 'PATCH /api/notes/40', 'POST /api/links']);
  assert.deepEqual(sent[2].body, { note: '40' }, 'the body points at the real id too');
  assert.equal(new Set(sent.map((s) => s.key)).size, 3, 'a key per change');
  assert.deepEqual(created, [[draft, 40]]);
});

test('the outbox waits without a signal, a session or a server, and gives conflicts to the app', async () => {
  const local = memoryLocal();
  let mode = 'offline';
  const conflicts = [];
  const dropped = [];
  const outbox = createOutbox({
    local, locks: null,
    send: async (op) => {
      if (mode === 'offline') throw new Offline();
      if (mode === 'expired') throw new SessionExpired(401, 'unauthorized');
      if (mode === 'down') throw new ApiError(503, 'unavailable');
      if (op.path.endsWith('/1')) throw new ApiError(409, 'note_conflict', { note: { id: 1 } });
      if (op.path.endsWith('/2')) throw new ApiError(404, 'not_found');
      return {};
    },
    onConflict: ({ op, error }) => conflicts.push([op.path, error.code]),
    onDropped: ({ op, error }) => dropped.push([op.path, error.code]),
  });
  await outbox.add({ method: 'PATCH', path: '/api/notes/1', body: {} });
  await outbox.add({ method: 'PATCH', path: '/api/notes/2', body: {} });
  await outbox.add({ method: 'PATCH', path: '/api/notes/3', body: {} });
  const firstKey = (await outbox.pending())[0].id;

  for (mode of ['offline', 'expired', 'down']) {
    const report = await outbox.flush();
    assert.equal(report.sent, 0, mode);
    assert.equal(report.left, 3, `${mode}: everything waits`);
  }
  assert.equal((await outbox.pending())[0].id, firstKey, 'the same change keeps the same key');

  mode = 'up';
  const report = await outbox.flush();
  assert.equal(report.sent, 1);
  assert.deepEqual(conflicts, [['/api/notes/1', 'note_conflict']]);
  assert.deepEqual(dropped, [['/api/notes/2', 'not_found']]);
  assert.equal(report.left, 0);

  // A change that still points at something whose creation never came.
  await outbox.add({ method: 'PATCH', path: '/api/notes/tmp-gone', body: {} });
  await outbox.flush();
  assert.equal(dropped.at(-1)[1], 'lost_creation');
});

test('one flush at a time, and another tab holding the lock leaves this one alone', async () => {
  let calls = 0;
  let release;
  const outbox = createOutbox({
    local: memoryLocal(),
    locks: { request: async (name, options, fn) => fn(null) },
    send: async () => { calls++; return {}; },
  });
  await outbox.add({ method: 'POST', path: '/api/x', body: {} });
  assert.equal(await outbox.flush(), null, 'the lock is somebody else’s');
  assert.equal(calls, 0);

  const slow = createOutbox({
    local: memoryLocal(), locks: null,
    send: () => new Promise((resolve) => { calls++; release = resolve; }),
  });
  await slow.add({ method: 'POST', path: '/api/x', body: {} });
  const first = slow.flush();
  const second = slow.flush();
  await new Promise((r) => setTimeout(r, 0));
  release({});
  assert.equal((await first).sent, 1);
  assert.equal(await second, null);
  assert.equal(calls, 1);
});

/* ---------------------------------- live ---------------------------------- */

class FakeSource {
  static last = null;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    FakeSource.last = this;
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, message = {}) { for (const fn of this.listeners[type] || []) fn(message); }
  close() { this.readyState = 2; this.closed = true; }
}

function fakeTimers() {
  let now = 0;
  let queue = [];
  return {
    setTimeout: (fn, ms) => { const id = Symbol('t'); queue.push({ id, at: now + ms, fn }); return id; },
    clearTimeout: (id) => { queue = queue.filter((t) => t.id !== id); },
    setInterval: () => 0,
    clearInterval: () => {},
    advance(ms) {
      now += ms;
      for (;;) {
        const due = queue.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        queue = queue.filter((t) => t !== due);
        due.fn();
      }
    },
  };
}

test('live: changes grouped, resync after a cut, reconnection with a growing wait', () => {
  const timers = fakeTimers();
  const batches = [];
  const states = [];
  let resyncs = 0;
  let accounts = 0;
  const live = connectLive({
    onChange: (events) => batches.push(events),
    onResync: () => resyncs++,
    onAccount: () => accounts++,
    onState: (s) => states.push(s),
  }, { EventSource: FakeSource, timers, events: ['note'] });

  const first = FakeSource.last;
  first.readyState = 1;
  first.emit('hello');
  assert.equal(live.state, 'open');
  assert.equal(resyncs, 0, 'the first hello is no cut');
  first.emit('change', { data: '{"list_id":1}', lastEventId: 'r.1' });
  first.emit('change', { data: '{"list_id":2}', lastEventId: 'r.2' });
  first.emit('note', { data: '{"id":9}', lastEventId: 'r.3' });
  assert.equal(batches.length, 0);
  timers.advance(300);
  assert.equal(batches.length, 1, 'three events, one reload');
  assert.deepEqual(batches[0].map((e) => [e.event, e.id]), [['change', 'r.1'], ['change', 'r.2'], ['note', 'r.3']]);
  assert.deepEqual(batches[0][0].data, { list_id: 1 });

  first.emit('resync');
  first.emit('account');
  assert.equal(resyncs, 1);
  assert.equal(accounts, 1);

  // EventSource retrying by itself: only the state changes.
  first.readyState = 0;
  first.emit('error');
  assert.equal(live.state, 'connecting');
  first.readyState = 1;
  first.emit('hello');
  assert.equal(resyncs, 2, 'back after a cut: reload what is shown');

  // Closed for good (a 401): opened again after 2 s, then 4 s.
  first.readyState = 2;
  first.emit('error');
  assert.equal(live.state, 'closed');
  timers.advance(1999);
  assert.equal(FakeSource.last, first);
  timers.advance(1);
  const second = FakeSource.last;
  assert.notEqual(second, first);
  second.readyState = 2;
  second.emit('error');
  timers.advance(3999);
  assert.equal(FakeSource.last, second);
  timers.advance(1);
  assert.notEqual(FakeSource.last, second);

  live.stop();
  assert.equal(FakeSource.last.closed, true);
  assert.equal(live.state, 'closed');
  assert.deepEqual(states.slice(0, 2), ['connecting', 'open']);
});

/* --------------------------------- updates -------------------------------- */

test('update: a different fingerprint is announced; closing it keeps it quiet for one round', async () => {
  let serverVersion = 'aaa';
  let clock = 0;
  const notices = [];
  const watcher = watchUpdates({
    onUpdate: (server) => notices.push(server.version),
    fetch: async () => ({ ok: true, json: async () => ({ version: serverVersion }) }),
    loadLocal: async () => ({ version: 'aaa' }),
    timers: fakeTimers(), doc: null, now: () => clock, every: 1000,
  });
  assert.equal(await watcher.check(), false);
  serverVersion = 'bbb';
  assert.equal(await watcher.check(), true);
  assert.deepEqual(notices.slice(-1), ['bbb']);
  watcher.dismiss();
  const count = notices.length;
  await watcher.check();
  assert.equal(notices.length, count, 'closed: not again right away');
  clock += 1000;
  await watcher.check();
  assert.equal(notices.length, count + 1, 'and again on the next round, while it is still new');
  await watcher.check({ announce: true });
  assert.equal(notices.length, count + 2, 'asked by hand, always');

  const offline = watchUpdates({
    onUpdate: () => notices.push('x'),
    fetch: async () => { throw new Error('offline'); },
    loadLocal: async () => ({ version: 'aaa' }),
    timers: fakeTimers(), doc: null,
  });
  assert.equal(await offline.check(), null, 'without a server, nothing is known');
  assert.equal(offline.latest(), null);
});

test('update: the server\'s version number is kept for About', async () => {
  let server = { app: '1.2.3', version: 'aaa' };
  const watcher = watchUpdates({
    fetch: async () => ({ ok: true, json: async () => server }),
    loadLocal: async () => ({ app: '1.2.3', version: 'aaa' }),
    timers: fakeTimers(), doc: null,
  });
  await watcher.check();
  assert.equal(watcher.latest().app, '1.2.3');
  server = { app: '1.3.0', version: 'bbb' };
  assert.equal(await watcher.check(), true);
  assert.equal(watcher.latest().app, '1.3.0');
});

test('update: the button says at once that it is updating, and pressing again starts nothing new', async () => {
  const replaced = [];
  let asked = 0;
  globalThis.window = { location: { href: 'https://tasks.example/lists/3', replace: (to) => replaced.push(to) } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    serviceWorker: { getRegistrations: async () => { asked += 1; return []; }, addEventListener() {} },
  } });
  const { el } = await import('../web/dom.js');
  const button = el('button', { class: 'kit-btn', text: 'Update' });
  const first = applyUpdate({ currentTarget: button });
  assert.equal(button.getAttribute('aria-busy'), 'true', 'busy before anything is awaited');
  assert.equal(button.find('span')[0]?.className, 'kit-spinner');
  assert.notEqual(button.textContent, 'Update');
  const second = applyUpdate({ currentTarget: button });
  assert.equal(second, first, 'the same update, not a second one');
  await first;
  assert.equal(asked, 1);
  assert.equal(replaced.length, 1);
  assert.match(replaced[0], /^\/lists\/3\?fresh=\d+$/);
  delete globalThis.window;
});

/* --------------------------------- colours -------------------------------- */

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

test('every product’s accent reads: 4.5:1 with its text, light and dark', () => {
  const css = fs.readFileSync(new URL('../web/tokens.css', import.meta.url), 'utf8');
  const products = [...css.matchAll(/:root\[data-app="(\w+)"\]\s*\{([^}]*)\}/g)];
  assert.equal(products.length, 7, 'Tasks, Projects, Next, Focus, Notes, Tracker and Talk');
  for (const [, id, body] of products) {
    const token = (name) => new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(body)?.[1];
    assert.equal(token('app').toLowerCase(), new RegExp(`--cr-product-${id}:\\s*(#[0-9A-Fa-f]{6})`).exec(css)[1].toLowerCase(), `${id}: the icon's colour`);
    assert.ok(contrast(token('app-accent'), token('app-on')) >= 4.5, `${id} light: ${contrast(token('app-accent'), token('app-on')).toFixed(2)}`);
    assert.ok(contrast(token('app-accent-dark'), token('app-on-dark')) >= 4.5, `${id} dark: ${contrast(token('app-accent-dark'), token('app-on-dark')).toFixed(2)}`);
    // The accent is also the colour of links and of what is selected, on the page's ground.
    assert.ok(contrast(token('app-accent'), '#FAF8F4') >= 4.5, `${id}: a link on the light ground`);
    assert.ok(contrast(token('app-accent-dark'), '#15130F') >= 4.5, `${id}: a link on the dark ground`);
  }
});

test('the yolk is "now" only: as text it is the deep one, never the flat on white', () => {
  const css = fs.readFileSync(new URL('../web/kit.css', import.meta.url), 'utf8');
  assert.ok(contrast('#9A6500', '#FFFFFF') >= 4.5);
  assert.doesNotMatch(css, /color:\s*var\(--cr-yolk-(?:500|600)\)/, 'flat yolk as text does not read on light');
});

test('one frame: the person\'s button only at the sidebar\'s foot, and no top bar with tabs', () => {
  const shell = fs.readFileSync(new URL('../web/shell.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../web/kit.css', import.meta.url), 'utf8');
  assert.equal((shell.match(/class: 'kit-account'/g) || []).length, 2, 'one button, a direct one or a menu');
  assert.match(shell, /el\('div', \{ class: 'kit-side__foot' \}, account\)/, 'at the sidebar\'s foot, in the drawer on a phone');
  assert.doesNotMatch(shell, /layout === 'top'|kit-bottom|kit-bar__tab/, 'the top layout was Next\'s, and Next has a sidebar now');
  assert.doesNotMatch(css, /data-layout="top"|\.kit-bottom|\.kit-bar__tab|\.kit-bar__brand/);
});

test('in a host the app\'s icon changes module, the rail is for where the sidebar stays, and the person\'s button gives way', () => {
  const shell = fs.readFileSync(new URL('../web/shell.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../web/kit.css', import.meta.url), 'utf8');
  const icons = fs.readFileSync(new URL('../web/icons.js', import.meta.url), 'utf8');
  // The switcher: the other modules, then the account's entries (Settings alone, in every app today).
  assert.match(shell, /class: 'kit-side__app', 'aria-haspopup': 'menu'/);
  assert.match(shell, /others\.map\(\(m\) => \(\{ label: m\.name, image: m\.icon, href: m\.path \}\)\),\s*others\.length \? 'separator' : null,\s*\.\.\.accountMenuItems\(\),/);
  assert.match(shell, /others = shown\.filter\(\(m\) => m\.mount !== mount\);\s*asModule\(true\);/, 'with one module too: Settings is still under the icon');
  assert.match(shell, /foot\.hidden = on;/, 'the person\'s button gives way in a host');
  assert.match(shell, /if \(direct\) return \[settings\];/, 'the same Settings as the person\'s button opened');
  assert.match(shell, /class: 'kit-rail__settings'/, 'Settings at the rail\'s foot');
  assert.match(icons, /'chevron-down': /);
  // On a phone no rail: the drawer is the module's alone. Shown only from 640 px.
  assert.match(css, /\.kit-rail \{[^}]*display: none;/);
  assert.match(css, /@container kit-app \(min-width: 640px\) \{\s*\.kit-rail \{ display: flex; \}\s*\}/);
  assert.doesNotMatch(css, /\.kit-side\[data-rail\] \{[^}]*width:/, 'the drawer keeps its own width');
});

test('the sidebar folds only where it sits beside the views, and the device remembers it per app', () => {
  const shell = fs.readFileSync(new URL('../web/shell.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../web/kit.css', import.meta.url), 'utf8');
  assert.match(shell, /const foldKey = `\$\{app\.id \|\| app\.name\.toLowerCase\(\)\}\.sidebar`/, 'Projects\' key from before');
  assert.match(shell, /localStorage\.setItem\(foldKey, value \? 'collapsed' : 'visible'\)/);
  // Every rule for the folded frame is inside a container query from 640 px: on a phone the
  // sidebar is a drawer whatever was chosen on a computer.
  const outside = css.replace(/@container kit-app \(min-width: (?:640|960)px\) \{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  assert.doesNotMatch(outside, /\[data-folded\]/);
  assert.match(css, /\[data-folded\] \.kit-bar__menu \{ display: inline-grid; \}/, '☰ brings it back');
  assert.match(css, /\[data-folded\] \.kit-bar__create \{ display: inline-flex; \}/, 'what creates goes to the bar');
});

test('every file the service worker caches for the kit exists', () => {
  const sw = fs.readFileSync(new URL('../web/sw-core.js', import.meta.url), 'utf8');
  const files = [.../SUITE_KIT_FILES = \[([^\]]*)\]/.exec(sw)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(files.length > 15);
  for (const file of files) assert.ok(fs.existsSync(new URL(`../web/${file.replace('/suite/', '')}`, import.meta.url)), file);
});

/* ------------------------------ the app's base ----------------------------- */

test('the kit finds its base by itself: / on its own, the module’s path in a host', async () => {
  const { baseOf, pathAt, at, BASE } = await import('../web/base.js');
  assert.equal(baseOf('https://tasks.example/suite/base.js'), '/');
  assert.equal(baseOf('https://work.example/tasks/suite/base.js'), '/tasks/');
  assert.equal(baseOf('file:///C:/code/suite-core/web/base.js'), '/', 'not a web page: as on its own');
  assert.equal(baseOf('not a url'), '/');
  assert.equal(BASE, '/');
  assert.equal(at('/api/me'), '/api/me', 'on its own, every path as it always was');
  assert.equal(pathAt('/tasks/', '/api/me'), '/tasks/api/me');
  assert.equal(pathAt('/tasks/', '/i18n/es.json'), '/tasks/i18n/es.json');
  assert.equal(pathAt('/tasks/', 'icons/a.svg'), 'icons/a.svg', 'relative: already the module’s');
  assert.equal(pathAt('/tasks/', '//cdn.example/x'), '//cdn.example/x');
  assert.equal(pathAt('/tasks/', 'https://x.example/y'), 'https://x.example/y');
  // What the kit asks the server goes through it; nothing fetches a path of the site directly.
  for (const file of ['api.js', 'i18n.js', 'live.js', 'update.js', 'settings.js', 'shell.js', 'signin.js']) {
    const code = fs.readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');
    assert.match(code, /import \{ at(?:, BASE)? \} from '\.\/base\.js'/, file);
    // Only the host's own routes are asked at the root: which modules someone uses.
    assert.doesNotMatch(code, /fetch\(['`]\/(?!api\/(?:me\/)?modules['`])|import\(['`]\/|get\(['`]\/version/, file);
  }
});

test('an app’s pages reach the kit relative to their base, in Node too (tools/web-resolve.mjs)', async () => {
  await import('../tools/web-resolve.mjs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-pages-'));
  try {
    fs.mkdirSync(path.join(dir, 'public', 'js'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'public', 'js', 'page.js'),
      ["export { at } from '../suite/base.js';", "export { el } from '/suite/dom.js';", ''].join('\n'));
    const page = await import(pathToFileURL(path.join(dir, 'public', 'js', 'page.js')).href);
    assert.equal(page.at('/api/x'), '/api/x');
    assert.equal(typeof page.el, 'function');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** sw-core.js in a sandbox, as a worker registered at `scope` with these caches already there. */
async function serviceWorker(scope, cacheKeys = []) {
  const vm = await import('node:vm');
  const listeners = {};
  const deleted = [];
  const installed = [];
  const opened = [];
  const self = {
    registration: { scope },
    location: { origin: new URL(scope).origin },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: async () => [], openWindow: async (url) => { opened.push(url); } },
  };
  const caches = {
    keys: async () => cacheKeys,
    delete: async (key) => { deleted.push(key); return true; },
    open: async () => ({ addAll: async (requests) => { installed.push(...requests.map((r) => r.url)); }, add: async () => {}, put: async () => {} }),
    match: async () => undefined,
  };
  const context = vm.createContext({
    self, caches, URL, Promise, setTimeout, clearTimeout,
    Request: class { constructor(url, init) { this.url = url; this.init = init; } },
    Response: { error: () => ({ error: true }) },
    fetch: async () => ({ ok: true, clone() { return this; } }),
  });
  vm.runInContext(fs.readFileSync(new URL('../web/sw-core.js', import.meta.url), 'utf8'), context);
  const fire = async (type, event) => {
    let waited = null;
    listeners[type]({ waitUntil: (p) => { waited = p; }, ...event });
    await waited;
  };
  /** Whether the worker answers a GET itself (cache or network first), or leaves it to the browser. */
  const answers = (url, mode = 'cors') => {
    let answered = false;
    listeners.fetch({ request: { method: 'GET', url, mode }, respondWith: () => { answered = true; }, waitUntil: () => {} });
    return answered;
  };
  return { self, fire, answers, deleted, installed, opened };
}

test('the service worker of an app on its own works as it always did', async () => {
  const alone = await serviceWorker('https://tasks.example/', ['tasks-v24', 'tasks-v25']);
  alone.self.suiteWorker({ version: 'tasks-v25', shell: ['/', '/js/main.js'] });
  await alone.fire('install', {});
  assert.ok(alone.installed.includes('/suite/kit.css') && alone.installed.includes('/suite/base.js'));
  assert.ok(alone.installed.includes('/js/main.js'));
  await alone.fire('activate', {});
  assert.deepEqual(alone.deleted, ['tasks-v24'], 'the cache keeps its name; the old one goes');
  assert.equal(alone.answers('https://tasks.example/api/lists'), false);
  assert.equal(alone.answers('https://tasks.example/version'), false);
  assert.equal(alone.answers('https://tasks.example/js/main.js'), true);
});

test('a module’s service worker keeps to its path: its API, its caches, its notices', async () => {
  const keys = ['/tasks/tasks-v1', '/tasks/tasks-v2', '/notes/notes-v1', 'work-v1'];
  const tasks = await serviceWorker('https://work.example/tasks/', keys);
  tasks.self.suiteWorker({ version: 'tasks-v2', shell: ['./', 'js/main.js'], push: { title: 'Tasks' } });
  await tasks.fire('install', {});
  assert.ok(tasks.installed.includes('/tasks/suite/kit.css'), 'the kit at the module’s path');
  assert.ok(tasks.installed.includes('./'), 'the app’s own shell, relative to the worker');
  await tasks.fire('activate', {});
  assert.deepEqual(tasks.deleted, ['/tasks/tasks-v1'], 'another module’s cache, and the host’s, stay');
  assert.equal(tasks.answers('https://work.example/tasks/api/lists'), false, 'its API always reaches the server');
  assert.equal(tasks.answers('https://work.example/tasks/version'), false);
  assert.equal(tasks.answers('https://work.example/api/me'), false, 'outside its scope: not its business');
  assert.equal(tasks.answers('https://work.example/notes/js/main.js'), false);
  assert.equal(tasks.answers('https://work.example/tasks/js/main.js'), true);
  assert.equal(tasks.answers('https://work.example/tasks/list/3', 'navigate'), true);
  // A path the server wrote for a notice is the app's: it opens inside the module.
  await tasks.fire('notificationclick', { notification: { close() {}, data: { url: '/?list=3' } } });
  await tasks.fire('notificationclick', { notification: { close() {}, data: { url: '/tasks/?list=4' } } });
  await tasks.fire('notificationclick', { notification: { close() {}, data: {} } });
  assert.deepEqual(tasks.opened, ['/tasks/?list=3', '/tasks/?list=4', '/tasks/?app']);

  const host = await serviceWorker('https://work.example/', keys);
  host.self.suiteWorker({ version: 'work-v2', shell: ['/'], skip: ['/tasks/', '/notes/'] });
  await host.fire('activate', {});
  assert.deepEqual(host.deleted, ['work-v1'], 'the host’s worker clears only its own');
  assert.equal(host.answers('https://work.example/tasks/js/main.js'), false, 'its modules’ paths are theirs');
  assert.equal(host.answers('https://work.example/tasks'), false);
  assert.equal(host.answers('https://work.example/js/shell.js'), true);
});

/* ------------------------------ texts in code ----------------------------- */

test('the kit writes no text for people in its code, and every key it uses exists', async () => {
  const { hardcodedTexts, unknownKeys, catalogsOf } = await import('../tools/i18n.mjs');
  const web = new URL('../web/', import.meta.url);
  assert.deepEqual(hardcodedTexts([fs.realpathSync(web)]), []);
  assert.deepEqual(unknownKeys(catalogsOf().en, [fs.realpathSync(web)]), []);
  assert.deepEqual(hardcodedTexts([fs.realpathSync(new URL('../', import.meta.url))], { server: true }), [], 'nor its server, in another language');
});

/** Writes `files` ({ name: text }) to a folder of their own and lints it. */
async function lint(files, options) {
  const { hardcodedTexts } = await import('../tools/i18n.mjs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-lint-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  try {
    return hardcodedTexts([dir], options);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the lint catches texts in any language wherever people read them, and sentences anywhere', async () => {
  // From Tasks' own lint, which this one replaces: each line on its own, and what it must find.
  const planted = [
    ["el('button', { text: 'Guardar', title: t('common.close') });", 'Guardar'],
    ["toast('Tarea añadida', { error: false });", 'Tarea añadida'],
    ["const note = 'canción';", 'canción'],
    ["el('div', { title: open ? 'Cerrar' : 'Abrir' });", 'Abrir'],
    ["await confirmDialog('¿Borrar la lista?', { danger: true });", '¿Borrar la lista?'],
    ["button.setAttribute('aria-label', 'Cerrar ventana');", 'Cerrar ventana'],
    ["el('input', { placeholder: `Añadir a ${list.name}` });", 'Añadir a'],
    ["el('span', { 'aria-label': 'Close' });", 'Close'],
    ["const message = 'Something went wrong';", 'Something went wrong'],
    ["const label = 'Gemüse';", 'Gemüse'],
    ["node.textContent = 'Saved';", 'Saved'],
  ];
  const files = Object.fromEntries(planted.map(([line], i) => [`planted-${i}.js`, line]));
  const found = await lint(files);
  for (const [line, text] of planted) assert.ok(found.some((f) => f.includes(text)), line);
});

test('…and leaves alone comments, regular expressions, icons, names, keys, placeholders, comparisons and t()', async () => {
  const innocent = [
    '// Guardar la tarea: ¿por qué? Un comentario en español no cuenta',
    "/* title: 'Hola', toast('Adiós') */ const spanishWords = /mañana|demain|morgen/i; const half = total / 2;",
    "el('button', { class: 'icon-btn primary', type: 'button', text: '✕', 'aria-label': t('common.close') });",
    'el(\'span\', { text: `${icon} ${name} (${count})`, title: `${file.name} · ${size}` });',
    'el(\'span\', { text: `@${user.username}`, title: `#${task.number}` });',
    "el('option', { value: 'es', text: 'Español' }); el('option', { value: 'en', text: 'English' }); el('option', { value: 'fr', text: 'Français' });",
    'const key = `grupo:${group.id}`; const folded = `seccion:${list.id}:${category.id}`;',
    "if (text === 'Hola' || title !== 'Bye') { units = text === 'modals.units.factory' ? 'pc,g,kg' : text; }",
    "toast(t('app.task.moved', { list: 'Home' })); throw new Error('Something went wrong'); console.warn('Could not reach it');",
    'const row = `${items.map((item) => `${item.name}`).join(\', \')} ${cond ? `${a}` : \'\'}`; const quote = "it\'s";',
    "const url = 'https://example.com/a'; const hello = isOk ? 'ok' : 'fail'; el('p', { text: t('views.empty.generic') });",
    "el('span', { text: 'PDF' }); el('a', { title: `${a}\\n${b}` }); const stamp = `${day}Z`; const base = 'https://';",
    "el('p', { text: 'Bonjour' }); // i18n-exempt: the sample of a greeting",
  ];
  assert.deepEqual(await lint(Object.fromEntries(innocent.map((line, i) => [`innocent-${i}.js`, line]))), []);
});

test('in the HTML, the text inside an element from the catalog is the catalog’s, and each attribute needs its own key', async () => {
  const page = [
    '<!DOCTYPE html>', '<html lang="en" data-app="{{app.id}}">', '<head><title>{{app.name}}</title></head>', '<body>',
    '<button class="x">Save</button>',
    '<span data-i18n="common.cancel"><b>Cancel</b></span>',
    '<input placeholder="Search" data-i18n-attr="aria-label:common.search">',
    '<img alt="" src="x"><a title="Close" data-i18n-attr="title:common.close"></a>',
    '<p>Tasks</p><h1>&times;</h1>',
    '<p>',
    '  Two lines',
    '  of text</p>',
    '</body>',
  ].join('\n');
  assert.deepEqual(await lint({ 'page.html': page }), ['page.html:5: Save', 'page.html:7: Search', 'page.html:11: Two lines of text']);
});

test('on the server only another language counts, never for the developer, and data files can be skipped', async () => {
  const server = [
    "const tool = { title: 'Add a task', description: 'Adds a task to a list. Approximate names are fine.' };",
    "sendPush(user, { title: 'Tarea añadida', body: t('notices.task', { title }) });",
    "throw new Error('Algo falló');",
    "console.log('[db] migración hecha');",
    'const rows = db.all(`SELECT * FROM item WHERE title GLOB \'[ñ]*\'`);',
    "const ME = new Set(['me', 'yo', 'mí']); // i18n-exempt: words the server reads, in every language",
  ].join('\n');
  const files = { 'server.js': server, 'seeds.js': "export const SEEDS = { es: ['Plátanos'], fr: ['Pastèque'] };" };
  assert.deepEqual(await lint(files, { server: true, skip: ['seeds.js'] }), ['server.js:2: Tarea añadida']);
  assert.deepEqual((await lint(files, { server: true })).filter((f) => f.startsWith('seeds.js')).length, 2, 'without skip, the seeds count');
  assert.ok((await lint({ 'server.js': server })).some((f) => f.includes('Adds a task')), 'in the browser, an English sentence counts too');
});

test('the lint keeps every character in its place, so a finding says its line, and says it from the command line', async () => {
  const { scanLiterals } = await import('../tools/i18n.mjs');
  const source = "const a = /[`'\"]/g; // it's\nconst b = `one ${f({ x: 'y' })}\n${`nested`} two`;\n/* c */ const d = 'e\\'f';\n";
  assert.equal(scanLiterals(source).masked.length, source.length);
  assert.deepEqual(await lint({ 'multi.js': "\n\nel('p', {\n  text:\n    `Several\n    lines`,\n});\n" }), ['multi.js:5: Several lines']);

  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-lint-'));
  fs.writeFileSync(path.join(dir, 'seeds.js'), "export const SEEDS = ['Plátanos'];");
  const tool = fileURLToPath(new URL('../tools/i18n.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [tool, 'hardcoded', ...args], { encoding: 'utf8' });
  const caught = run('--server', dir);
  const skipped = run('--server', '--skip', 'seeds.js', dir);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(caught.status, 1);
  assert.match(caught.stderr, /seeds\.js:1: Plátanos/);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(skipped.stdout, /No text written in the code/);
});

test('the lint finds texts written in the code, and leaves keys, names and exemptions alone', async () => {
  const { hardcodedTexts } = await import('../tools/i18n.mjs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-lint-'));
  fs.writeFileSync(path.join(dir, 'page.html'), [
    '<!DOCTYPE html>', '<title>Notes</title>', '<!-- A comment says', 'what it likes. -->',
    '<h1 data-i18n="app.title"></h1>', '<p>Welcome back</p>', '<button title="Close the panel">×</button>',
    '<input data-i18n-attr="placeholder:x.y" placeholder="ignored">', '<span>by</span> <strong>Cronum Studio</strong>',
    '<script>const a = "<p>Not text</p>";</script>', '<p>Ok exempted</p> <!-- i18n-exempt -->',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'app.js'), [
    "el('p', { text: t('notes.empty') });", "el('p', { text: 'Nothing here yet' });", "toast('Saved!');",
    "el('div', { class: 'kit-row', title: 'notes.title' });", "el('a', { 'aria-label': 'Open the menu' });",
    "el('span', { text: 'Claude' });", "el('p', { text: 'Offline' }); // i18n-exempt: before the catalogs",
    '// text: "a comment"',
  ].join('\n'));
  const found = hardcodedTexts([dir]);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(found.sort(), [
    'app.js:2: Nothing here yet', 'app.js:3: Saved!', 'app.js:5: Open the menu',
    'page.html:6: Welcome back', 'page.html:7: Close the panel',
  ].sort());
});

test('dates from the server read the same in ISO and in SQLite’s format, and a bad one is none', async () => {
  const { instant, formatDateTime } = await import('../web/i18n.js');
  assert.equal(instant('2026-10-04 12:38:27').toISOString(), '2026-10-04T12:38:27.000Z', 'SQLite’s format is UTC');
  assert.equal(instant('2026-10-04T12:38:27.055Z').toISOString(), '2026-10-04T12:38:27.055Z');
  assert.equal(instant('not a date'), null);
  assert.equal(formatDateTime('not a date'), '');
  assert.notEqual(formatDateTime('2026-10-04 12:38:27'), '');
});

test('a session or a device without a browser to name says so, not a dash', async () => {
  const { deviceName } = await import('../web/settings.js');
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
  assert.equal(deviceName(chrome, 'Unidentified browser'), 'Chrome · Windows');
  assert.equal(deviceName(null, 'Unidentified browser'), 'Unidentified browser');
  assert.equal(deviceName(''), '—', 'without a text of its own, as before');
});

test('every file of the web kit parses: one that does not stops the whole app before it draws', async () => {
  // Most of the kit is only run by these tests in part, through a fake DOM; a name declared twice
  // in shell.js once left every app on a blank page with nothing here noticing.
  const { spawnSync } = await import('node:child_process');
  const dir = new URL('../web/', import.meta.url);
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.js'));
  assert.ok(files.includes('shell.js') && files.includes('drag.js'));
  for (const name of files) {
    const run = spawnSync(process.execPath, ['--check', new URL(name, dir).pathname.replace(/^\/([A-Za-z]:)/, '$1')], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${name}: ${run.stderr}`);
  }
});

/* ---------------------------------- links ---------------------------------- */

test('links: the row of a host module’s item, its chips in each state, hidden on its own', async () => {
  const { mountOf, chipText, linkChip, linksRow } = await import('../web/links.js');
  assert.equal(mountOf('/tasks/'), 'tasks');
  assert.equal(mountOf('/'), null);
  assert.deepEqual(chipText({ state: 'open', title: 'Review', app: 'Beta' }), { text: 'Review', note: 'Beta' });
  assert.deepEqual(chipText({ state: 'gone', app: 'Beta' }), { text: 'kit.links.goneIn', note: null }, 'gone, its title unknown');
  assert.equal(chipText({ state: 'gone', title: 'Old', app: 'Beta' }).text, 'Old', 'gone, to whoever linked it');
  assert.deepEqual(chipText({ state: 'hidden', app: 'Beta' }), { text: 'kit.links.hidden', note: 'kit.links.noAccess' });

  const done = linkChip({ id: 4, together: true, item: { ref: 'beta:item:3', state: 'done', title: 'Review', app: 'Beta', color: '#7C3AED', url: '/beta/?item=3' } },
    { onMenu: () => {} });
  assert.equal(done.getAttribute('data-state'), 'done');
  assert.equal(done.getAttribute('style'), '--module: #7C3AED');
  assert.equal(done.find('a')[0].getAttribute('href'), '/beta/?item=3', 'opens it in its module');
  assert.equal(done.find('button').length, 1, 'its "…"');
  const hidden = linkChip({ id: 5, item: { ref: 'beta:item:9', state: 'hidden', app: 'Beta', url: '/beta/?item=9' } });
  assert.equal(hidden.find('a').length, 0, 'what someone can’t open is no link');
  assert.match(hidden.textContent, /kit\.links\.hidden/);

  const asked = [];
  let modules = [
    { mount: 'alpha', name: 'Alpha', active: true, links: { item: { creates: true } } },
    { mount: 'beta', name: 'Beta', active: true, links: { item: { creates: true } } },
  ];
  const fetch = async (path) => {
    asked.push(path);
    const data = path === '/api/modules' ? { modules }
      : { links: [{ id: 4, together: true, item: { ref: 'beta:item:3', state: 'open', title: 'Review', app: 'Beta', url: '/beta/?item=3' } }] };
    return { ok: true, status: 200, json: async () => data };
  };

  const alone = linksRow({ ref: 'alpha:item:1', base: '/', fetch });
  await alone.show('alpha:item:1');
  assert.equal(alone.element.hidden, true);
  assert.deepEqual(asked, [], 'on its own it asks nothing');

  const loaded = [];
  const row = linksRow({ base: '/alpha/', fetch, onLoad: (links) => loaded.push(links.length) });
  await row.show('alpha:item:1', 'Write');
  assert.equal(row.element.hidden, false);
  assert.deepEqual(asked, ['/api/modules', '/api/links?ref=alpha%3Aitem%3A1'], 'at the host’s root, not the module’s');
  assert.equal(row.element.find('a')[0].getAttribute('href'), '/beta/?item=3');
  assert.deepEqual(loaded, [1], 'the page hears what it read');
  assert.equal(row.refresh([{ event: 'links', data: { ref: 'alpha:item:2' } }]), null, 'another item’s links: nothing to read');
  await row.refresh([{ event: 'links', data: { ref: 'alpha:item:1' } }]);
  assert.equal(asked.length, 3);
  row.destroy();
  await row.refresh();
  assert.deepEqual(loaded, [1, 1], 'a row let go reads no more');

  // Nobody to link with (only this module on): no row.
  modules = [modules[0], { ...modules[1], active: false }];
  const solo = linksRow({ base: '/alpha/', fetch });
  await solo.show('alpha:item:1');
  assert.equal(solo.element.hidden, true);
});
