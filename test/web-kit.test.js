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
const { api, setPatience, Offline, SessionExpired, ApiError } = await import('../web/api.js');
const { connectLive } = await import('../web/live.js');
const { watchUpdates, applyUpdate } = await import('../web/update.js');

/* ---------------------------------- api ----------------------------------- */

test('api: without patience it waits; with it a slow read or keyed write is no network, never a keyless write', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  // A server that never answers, unless the request gives up.
  globalThis.fetch = (path, { method, signal } = {}) => new Promise((resolve, reject) => {
    seen.push({ method, path, signal: Boolean(signal) });
    signal?.addEventListener('abort', () => reject(signal.reason));
    if (path.endsWith('/fast')) resolve({ ok: true, json: async () => ({ ok: 1 }) });
  });
  try {
    api.get('/api/slow');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(seen.at(-1).signal, false, 'without setPatience nothing gives up, as before');

    setPatience(20);
    await assert.rejects(api.get('/api/slow'), Offline);
    await assert.rejects(api.write('PATCH', '/api/slow', {}, { key: 'k1' }), Offline);
    assert.deepEqual(await api.get('/api/fast'), { ok: 1 });
    api.post('/api/slow', {});
    api.upload('/api/slow', { type: 'image/png' });
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(seen.slice(-2).map((s) => s.signal), [false, false], 'a write without a key and an upload wait');
  } finally {
    setPatience(null);
    globalThis.fetch = realFetch;
  }
});

test('api: an answer whose body is cut by the wait is no network, not an empty answer', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path, { signal } = {}) => ({
    ok: true,
    json: () => new Promise((resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason))),
  });
  try {
    setPatience(20);
    await assert.rejects(api.get('/api/notes'), Offline);
  } finally {
    setPatience(null);
    globalThis.fetch = realFetch;
  }
});

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

test('update: in a host with one worker, the whole app’s version, and no notice in a frame of the split view', async () => {
  const asked = [];
  const notices = [];
  const server = { app: '0.3.15', name: 'Cronum Work', version: 'bbb' };
  const options = {
    onUpdate: (theirs) => notices.push(theirs.name),
    fetch: async (url) => { asked.push(url); return { ok: true, json: async () => server }; },
    loadLocal: async () => ({ app: '0.3.14', version: 'aaa', name: 'Cronum Work' }),
    timers: fakeTimers(), doc: null, host: async () => ({ worker: '/sw.js' }),
  };
  const page = watchUpdates({ ...options, framed: false });
  assert.equal(await page.check(), true);
  assert.equal(asked.at(-1), '/version', 'the host’s, at the root');
  assert.ok(notices.length >= 1 && notices.every((n) => n === 'Cronum Work'), 'named after the host');
  const frame = watchUpdates({ ...options, framed: true });
  await new Promise((done) => setTimeout(done, 10));
  notices.length = 0;
  assert.equal(await frame.check({ announce: true }), true, 'a frame knows it');
  assert.deepEqual(notices, [], 'but the split view says it, once');
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

/* --------------------------------- dialogs -------------------------------- */

test('a dialog without actions has no footer, and no "null" where it would have been', async () => {
  const { openDialog } = await import('../web/ui.js');
  const { el } = await import('../web/dom.js');
  for (const actions of [undefined, [], null]) {
    let closed = 0;
    const { dialog, close } = openDialog({
      title: 'About', content: el('p', { text: 'Tracker 0.14.1' }), onClose: () => { closed += 1; },
      ...(actions === undefined ? {} : { actions }),
    });
    assert.equal(dialog.open, true);
    assert.equal(dialog.find('footer').length, 0, `actions: ${actions}`);
    assert.equal(dialog.textContent, 'AboutTracker 0.14.1', `actions: ${actions}`);
    close();
    assert.equal(closed, 1);
    assert.ok(!document.body.childNodes.includes(dialog), 'gone once closed');
  }
});

test('a dialog with actions keeps its footer: a button for each, and one that is pressed closes it', async () => {
  const { openDialog } = await import('../web/ui.js');
  const { el } = await import('../web/dom.js');
  const pressed = [];
  const { dialog } = openDialog({
    title: 'Rename', content: el('p', { text: 'A new name' }),
    actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: () => { pressed.push('save'); } }],
  });
  const [footer] = dialog.find('footer');
  const buttons = footer.find('button');
  assert.deepEqual(buttons.map((b) => b.textContent), ['Cancel', 'Save']);
  assert.match(buttons[0].className, /kit-btn--quiet/);
  assert.match(buttons[1].className, /kit-btn--primary/);
  await Promise.all(buttons[1].listeners.click.map((fn) => fn({ currentTarget: buttons[1] })));
  assert.deepEqual(pressed, ['save']);
  assert.equal(dialog.open, false);
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

test('in a host the rail is for where the sidebar stays, the app\'s icon changes module on a phone, and the person\'s button gives way', () => {
  const shell = fs.readFileSync(new URL('../web/shell.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../web/kit.css', import.meta.url), 'utf8');
  const icons = fs.readFileSync(new URL('../web/icons.js', import.meta.url), 'utf8');
  // The switcher: the other modules, then the account's entries (Settings alone, in every app today).
  assert.match(shell, /class: 'kit-side__app', 'aria-haspopup': 'menu'/);
  assert.match(shell, /others\.map\(\(m\) => \(\{ label: m\.name, image: m\.icon, href: m\.path \}\)\),\s*others\.length \? 'separator' : null,\s*\.\.\.accountMenuItems\(\),/);
  // Only where the rail doesn't show (a phone, or no answer from the host yet beside the views),
  // and always in a frame of the host's split view, which has no rail.
  assert.match(shell, /const want = hosted && \(FRAMED \|\| !\(beside\(\) && \(rail \|\| !answered\)\)\);/);
  assert.match(shell, /if \(FRAMED\) \{\s*others = \[\];\s*asModule\(true\);\s*return null;\s*\}/, 'no rail in a frame, nor other modules');
  // The split view's views on the rail, where the host has one, over Settings.
  assert.match(shell, /host\.split \? el\('button', \{\s*type: 'button', class: 'kit-rail__split'/);
  assert.match(shell, /href: n === 1 \? null : `\$\{page\}\?layout=\$\{n\}&from=\$\{encodeURIComponent\(mount\)\}`/);
  assert.match(css, /\.kit-rail__split \+ \.kit-rail__settings \{ margin-top: 0; \}/);
  for (const n of [1, 2, 3, 4]) assert.match(icons, new RegExp(` {2}'layout-${n}': '[^']+',\n`));
  assert.doesNotMatch(shell, /shown\.length < 2/, 'with one module too: the rail has Settings');
  assert.match(shell, /foot\.hidden = on;/, 'the person\'s button gives way in a host');
  assert.match(shell, /if \(direct\) return \[settings\];/, 'the same Settings as the person\'s button opened');
  assert.match(shell, /class: 'kit-rail__settings'/, 'Settings at the rail\'s foot');
  assert.match(icons, /'chevron-down': /);
  assert.match(icons, /\n  camera: '[^']+',\n/, 'the camera and the picture, for attaching (0.63.0)');
  assert.match(icons, /\n  image: '[^']+',\n/);
  // On a phone no rail: the drawer is the module's alone. Shown only from 640 px.
  assert.match(css, /\.kit-rail \{[^}]*display: none;/);
  assert.match(css, /@container kit-app \(min-width: 640px\) \{\s*\.kit-rail \{ display: flex; \}\s*\}/);
  assert.doesNotMatch(css, /\.kit-side\[data-rail\] \{[^}]*width:/, 'the drawer keeps its own width');
});

test('from one module to another: the rail of last time at once, and one page fading into the next', () => {
  const shell = fs.readFileSync(new URL('../web/shell.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../web/kit.css', import.meta.url), 'utf8');
  // The host's last answer, kept and drawn before asking again; only one that has this module.
  assert.match(shell, /const RAIL_KEY = 'host\.modules';/);
  assert.match(shell, /localStorage\.setItem\(RAIL_KEY, JSON\.stringify\(answer\)\)/);
  assert.match(shell, /if \(Array\.isArray\(last\?\.modules\) && last\.modules\.some\(\(m\) => m\?\.mount === mount\)\) paintRail\(last\);\s*refreshModules\(\);/);
  assert.match(shell, /res\.status === 404\) \{[^}]*localStorage\.removeItem\(RAIL_KEY\)/, 'no host there: forgotten');
  // A crossfade between pages of the site, the rail standing still; none for less motion.
  assert.match(css, /@view-transition \{ navigation: auto; \}/);
  assert.match(css, /\.kit-rail \{ view-transition-name: kit-rail; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*@view-transition \{ navigation: none; \}\s*\}/);
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
    assert.match(code, /import \{ at(?:, BASE)?(?:, FRAMED)?(?:, SETTINGS(?:_SHOWN)?_EVENT)? \} from '\.\/base\.js'/, file);
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

test('a host’s one worker serves every module’s paths as the module did, and opens a notice in its module', async () => {
  const keys = ['/tasks/tasks-v31', '/notes/notes-v5', 'work-old', 'work-new'];
  const host = await serviceWorker('https://work.example/', keys);
  host.self.suiteWorker({
    version: 'work-new', modules: ['/tasks/', '/notes/'], shell: ['/', '/tasks/', '/tasks/js/main.js'],
    push: { title: 'Cronum Work', icon: '/icons/icon-192.png', url: '/' },
  });
  // File by file: one missing file must not leave every module without its copy.
  await host.fire('install', {});
  assert.deepEqual(host.installed, [], 'not all at once (addAll)');
  await host.fire('activate', {});
  assert.deepEqual(host.deleted.sort(), ['/notes/notes-v5', '/tasks/tasks-v31', 'work-old'], 'its old copy and the modules’ workers’');
  assert.equal(host.answers('https://work.example/tasks/api/lists'), false, 'a module’s API always reaches the server');
  assert.equal(host.answers('https://work.example/tasks/version'), false);
  assert.equal(host.answers('https://work.example/notes/mcp'), false);
  assert.equal(host.answers('https://work.example/version'), false);
  assert.equal(host.answers('https://work.example/tasks/js/main.js'), true, 'a module’s code: network first');
  assert.equal(host.answers('https://work.example/notes/list/3', 'navigate'), true);
  assert.equal(host.answers('https://work.example/split/', 'navigate'), true);

  // A notice opens its module: already open there, it gets it; elsewhere, the open page goes there.
  const page = (url, frameType = 'top-level') => ({
    url, frameType, got: [], focused: 0, went: null,
    postMessage(m) { this.got.push(m); }, focus() { this.focused += 1; return Promise.resolve(this); },
    navigate(to) { this.went = to; return Promise.resolve(this); },
  });
  const notes = page('https://work.example/notes/');
  const tasks = page('https://work.example/tasks/?list=1');
  host.self.clients.matchAll = async () => [notes, tasks];
  await host.fire('notificationclick', { notification: { close() {}, data: { url: '/tasks/?list=4', module: 'tasks' } } });
  assert.equal(tasks.got[0].type, 'notification');
  assert.equal(tasks.focused, 1);
  assert.equal(notes.got.length, 0, 'never another module’s page');

  host.self.clients.matchAll = async () => [notes];
  await host.fire('notificationclick', { notification: { close() {}, data: { url: '/tasks/?list=4' } } });
  assert.equal(notes.went, '/tasks/?list=4', 'the page open goes to the module');

  const split = page('https://work.example/split/');
  const framed = page('https://work.example/tasks/', 'nested');
  host.self.clients.matchAll = async () => [split, framed];
  await host.fire('notificationclick', { notification: { close() {}, data: { url: '/tasks/?list=5' } } });
  assert.equal(framed.got.length, 1, 'in the split view, the module’s frame gets it');
  assert.equal(split.focused, 1, 'and the view the focus');
  assert.equal(split.went, null);

  host.self.clients.matchAll = async () => [];
  await host.fire('notificationclick', { notification: { close() {}, data: {} } });
  assert.deepEqual(host.opened, ['/'], 'without a page open, a new window');
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

test('Settings offers the AI connector only where there is one; a server that says nothing keeps it', async () => {
  const { openSettings } = await import('../web/settings.js');
  const { t } = await import('../web/i18n.js');
  // Settings listens for Escape on the page; the fake page only needs to take the listener.
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {} });
  try {
    const listed = (config, start = null) => {
      const root = document.createElement('div');
      openSettings({ app: { id: 'demo', name: 'Demo' }, user: { username: 'ada', role: 'user' }, config, root, start });
      const texts = (className) => root.all().filter((node) => node.className === className).map((node) => node.textContent);
      return { labels: texts('kit-settings__label'), groups: texts('kit-settings__group'), page: root.all().find((node) => node.className === 'kit-settings__page') };
    };
    const ai = t('kit.ai.title');
    const off = listed({ provider: 'workos', app: { id: 'demo', modules: { organizations: false, billing: false, data: false, mcp: false } } });
    assert.ok(off.labels.length >= 4, 'the rest is there');
    assert.ok(!off.labels.includes(ai), 'no AI section without an MCP');
    assert.ok(!off.groups.includes(t('kit.settings.groups.connections')), 'nor its heading, with nothing else under it');
    assert.equal(listed({ app: { modules: { mcp: false } } }, 'ai').page.children.length, 0, 'asked for by name, nothing opens');
    assert.ok(listed({ app: { modules: { mcp: true } } }).labels.includes(ai), 'with an MCP, as always');
    assert.ok(listed({ app: { modules: { organizations: false, billing: false, data: false } } }).labels.includes(ai),
      'a server from before the flag keeps it');
    assert.ok(listed({}).labels.includes(ai), 'and so does a config without the app');
  } finally {
    delete document.addEventListener;
    delete document.removeEventListener;
  }
});

/**
 * Settings on a fake page, opened at a section, with the server's answers by
 * method and path. `press(label)` clicks a button and waits for what it does;
 * `done()` gives fetch and the page back.
 */
async function settingsAt(start, config, answers) {
  const { openSettings } = await import('../web/settings.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path, { method = 'GET' } = {}) => {
    const answer = answers[`${method} ${path}`];
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, json: async () => answer ?? { error: 'not_found' } };
  };
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {} });
  const root = document.createElement('div');
  openSettings({ app: { id: 'demo', name: 'Demo' }, user: { username: 'ada', role: 'user' }, config, root, start });
  // What the section asks the server for as it opens.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    root,
    press: async (label) => {
      const target = root.find('button').find((node) => node.textContent === label);
      assert.ok(target, `a button "${label}"`);
      await Promise.all(target.listeners.click.map((fn) => fn({ currentTarget: target })));
    },
    done: () => {
      globalThis.fetch = realFetch;
      delete document.addEventListener;
      delete document.removeEventListener;
    },
  };
}
const shape = (node) => node.childNodes.map((child) => child.tagName || `text "${child.textContent}"`);

test('a copy\'s plan in Your data leaves out the lines that don\'t apply, with no "null" in their place (Tracker\'s review)', async () => {
  const { t } = await import('../web/i18n.js');
  const copy = { created_at: '2026-10-12T09:30:00.000Z', applied_at: null, tables: { notes: 4 } };
  const planOf = async (answer) => {
    const page = await settingsAt('data', { app: { modules: { data: true, mcp: false } } }, { 'POST /api/me/import': answer });
    try {
      page.root.all().find((node) => node.getAttribute('id') === 'kit-data-file').files = [{ name: 'copy.zip', type: 'application/zip' }];
      await page.press(t('kit.data.check'));
      return page.root.all().find((node) => node.className === 'kit-stack');
    } finally { page.done(); }
  };

  // Not brought in yet, into an account with nothing: what it brings, and the buttons.
  const fresh = await planOf({ import_id: 'i1', account: 'ada', copy, replace: {} });
  assert.deepEqual(shape(fresh), ['P', 'DIV']);
  // Into an account with data of its own: the choice of replacing it too.
  const owned = await planOf({ import_id: 'i2', account: 'ada', copy, replace: { notes: 2 } });
  assert.deepEqual(shape(owned), ['P', 'LABEL', 'DIV']);
  // Brought in already: it says so, and Apply is off.
  const applied = await planOf({ import_id: 'i3', account: 'ada', copy: { ...copy, applied_at: '2026-10-12T10:00:00.000Z' }, replace: {} });
  assert.deepEqual(shape(applied), ['P', 'P', 'DIV']);
  assert.equal(applied.find('button').find((node) => node.textContent === t('kit.data.apply')).disabled, true);
  for (const area of [fresh, owned, applied]) assert.doesNotMatch(area.textContent, /null/);
});

test('setting up two-factor without a QR (an address too long for one) shows the key alone, with no "null" in its place', async () => {
  const { t } = await import('../web/i18n.js');
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const issuer = encodeURIComponent('An install with a name long enough that its address will not fit');
  const uri = `otpauth://totp/${issuer}%3Aada?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
  assert.ok(uri.length > 213, 'more than a QR code holds');
  const page = await settingsAt('security', { provider: 'local', two_factor: true, app: { modules: { mcp: false } } }, {
    'GET /api/me/two-factor': { enabled: false }, 'GET /api/me/sessions': [], 'POST /api/me/two-factor/setup': { secret, uri },
  });
  try {
    await page.press(t('kit.twoFactor.setUp'));
    await page.press(t('kit.twoFactor.continue'));
    const body = page.root.all().find((node) => node.className === 'kit-stack');
    assert.deepEqual(shape(body), ['P', 'DIV', 'A', 'DIV', 'DIV'], 'the key, the link, the first code and the buttons');
    assert.equal(body.firstChild.textContent, t('kit.twoFactor.typeKey'));
    assert.doesNotMatch(body.textContent, /null/);
  } finally { page.done(); }
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

/* ------------------------------ the keyboard ------------------------------ */

test('keyboard: what brings it up, when it is up, and what a tap is', async () => {
  const { typesIn, keyboardFit, isTap } = await import('../web/keyboard.js');
  assert.ok(typesIn({ tagName: 'INPUT', type: 'text' }) && typesIn({ tagName: 'INPUT', type: 'search' }) && typesIn({ tagName: 'INPUT' }));
  assert.ok(typesIn({ tagName: 'TEXTAREA' }) && typesIn({ tagName: 'DIV', isContentEditable: true }));
  assert.ok(!typesIn({ tagName: 'INPUT', type: 'checkbox' }) && !typesIn({ tagName: 'BUTTON' }) && !typesIn(null));
  // The iPhone: innerHeight shrinks with the keyboard, so the full height is the root's.
  assert.deepEqual(keyboardFit({ full: 812, height: 476, typing: true }), { top: 0, height: 476 });
  assert.deepEqual(keyboardFit({ full: 812, top: 200.4, height: 476.2, typing: true }), { top: 200, height: 476 }, 'slid up');
  assert.deepEqual(keyboardFit({ full: 812, top: 40, height: 800, typing: true }), { top: 40, height: 800 }, 'only slid: a keyboard too');
  assert.equal(keyboardFit({ full: 812, height: 740, typing: true }), null, 'the browser’s bars, not a keyboard');
  assert.equal(keyboardFit({ full: 812, height: 476, typing: false }), null, 'nothing to type in');
  assert.equal(keyboardFit({ full: 812, top: 100, height: 300, scale: 2, typing: true }), null, 'a pinch-zoom');
  assert.ok(isTap({ x: 10, y: 10, at: 0 }, { x: 16, y: 14, at: 120 }));
  assert.ok(!isTap({ x: 10, y: 10, at: 0 }, { x: 10, y: 30, at: 120 }), 'scrolling');
  assert.ok(!isTap({ x: 10, y: 10, at: 0 }, { x: 10, y: 10, at: 800 }), 'a long press');
  assert.ok(!isTap(null, { x: 0, y: 0, at: 0 }));
});

test('keyboard: the page is fitted while it is up, the field kept in sight, and left alone without it', async () => {
  const { fitToKeyboard } = await import('../web/keyboard.js');
  const props = new Map();
  const root = document.documentElement;
  root.dataset = {};
  root.clientHeight = 812;
  root.style = { setProperty: (name, value) => props.set(name, value), removeProperty: (name) => props.delete(name) };
  const onDocument = {};
  document.addEventListener = (type, fn) => { (onDocument[type] ||= []).push(fn); };
  const onView = {};
  const view = { offsetTop: 0, height: 812, scale: 1, addEventListener: (type, fn) => { (onView[type] ||= []).push(fn); } };
  globalThis.window = { visualViewport: view, innerHeight: 476 };
  globalThis.requestAnimationFrame = () => 0;
  const revealed = [];
  fitToKeyboard({ reveal: (field) => { revealed.push(field.tagName); return true; } });
  const fire = (type) => onView[type].forEach((fn) => fn());
  const state = () => [root.dataset.kitKeyboard ?? '-', props.get('--kit-view-top') ?? '-', props.get('--kit-view-h') ?? '-'].join(' ');

  document.activeElement = { tagName: 'TEXTAREA' };
  fire('resize');
  assert.equal(state(), '- - -', 'typing, no keyboard yet');
  view.height = 600;
  fire('resize');
  assert.equal(state(), 'up 0px 600px');
  view.height = 476;
  fire('resize');
  assert.equal(state(), 'up 0px 476px');
  assert.deepEqual(revealed, ['TEXTAREA', 'TEXTAREA'], 'the field back in sight each time the room shrinks');
  view.offsetTop = 150;
  fire('scroll');
  assert.equal(state(), 'up 150px 476px', 'the view slid up: the frame follows it');
  view.height = 560;
  fire('resize');
  assert.equal(revealed.length, 2, 'more room: nothing to reveal');

  document.activeElement = { tagName: 'BUTTON' };
  onDocument.focusin.forEach((fn) => fn());
  assert.equal(state(), '- - -', 'nothing to type in: the frame as always');
  document.activeElement = { tagName: 'INPUT', type: 'text' };
  onDocument.focusin.forEach((fn) => fn());
  assert.equal(state(), 'up 150px 560px');
  view.offsetTop = 0;
  view.height = 812;
  fire('resize');
  assert.equal(state(), '- - -', 'the keyboard down');

  // Without an app's own reveal, a text box is scrolled into view; called again, nothing is listened to twice.
  const scrolled = [];
  fitToKeyboard();
  assert.equal(onView.resize.length, 1);
  document.activeElement = { tagName: 'INPUT', type: 'search', scrollIntoView: (how) => scrolled.push(how) };
  view.height = 476;
  fire('resize');
  assert.deepEqual(scrolled, [{ block: 'nearest' }]);
  view.height = 812;
  fire('resize');
  delete globalThis.window;
  delete globalThis.requestAnimationFrame;
});

test('keyboard: a tap focuses without the slide; scrolling, a long press, a tap while typing stay the browser’s', async () => {
  const { focusOnTap } = await import('../web/keyboard.js');
  const on = {};
  const focused = [];
  const area = {
    addEventListener: (type, fn) => { on[type] = fn; },
    contains: (node) => node === area,
    focus: (how) => { focused.push(how); document.activeElement = area; },
  };
  const nothing = { closest: () => null };
  const touch = (type, x, y, at, target = nothing) => {
    const point = { clientX: x, clientY: y };
    const ev = { touches: type === 'touchend' ? [] : [point], changedTouches: [point], timeStamp: at, target, prevented: false, preventDefault() { this.prevented = true; } };
    on[type](ev);
    return ev;
  };
  document.activeElement = null;
  focusOnTap(area, { skip: 'a[href]' });
  touch('touchstart', 50, 50, 0);
  assert.ok(touch('touchend', 52, 51, 100).prevented);
  assert.deepEqual(focused, [{ preventScroll: true }]);
  touch('touchstart', 50, 50, 200);
  assert.ok(!touch('touchend', 50, 50, 260).prevented, 'already typing: the browser places the caret');
  document.activeElement = null;
  touch('touchstart', 50, 50, 300);
  assert.ok(!touch('touchend', 50, 90, 360).prevented, 'scrolling');
  touch('touchstart', 50, 50, 400);
  assert.ok(!touch('touchend', 50, 50, 1000).prevented, 'a long press');
  touch('touchstart', 50, 50, 1100);
  assert.ok(!touch('touchend', 50, 50, 1150, { closest: (selector) => (selector === 'a[href]' ? {} : null) }).prevented, 'a link');
  assert.equal(focused.length, 1);

  // An app's own focus gets the point, and may leave the tap to the browser.
  const editor = { addEventListener: (type, fn) => { on[type] = fn; }, contains: () => false };
  const points = [];
  let accept = false;
  focusOnTap(editor, { focus: (point) => { points.push(point); return accept; } });
  touch('touchstart', 30, 40, 0);
  assert.ok(!touch('touchend', 30, 40, 50).prevented, 'declined: the browser’s tap goes on');
  accept = true;
  touch('touchstart', 30, 40, 100);
  assert.ok(touch('touchend', 31, 41, 150).prevented);
  assert.deepEqual(points, [{ x: 30, y: 40 }, { x: 31, y: 41 }]);
});

test('the drawer opened by a finger takes the focus itself, with no ring on the current entry (Notes #41)', () => {
  const shell = fs.readFileSync(new URL('../web/shell.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../web/kit.css', import.meta.url), 'utf8');
  assert.match(shell, /if \(keyboard\) nav\.querySelector\('\[aria-current="page"\], a, button'\)\?\.focus\(\);\s*else nav\.focus\(\{ preventScroll: true \}\);/);
  assert.match(shell, /class: 'kit-side__nav', 'aria-label': app\.name, tabindex: '-1'/, 'the drawer can take the focus');
  assert.match(shell, /byKeys = ev\.key === 'Enter' \|\| ev\.key === ' ';/, 'the keyboard is Enter or Space on ☰, not any click without a pointer');
  assert.match(shell, /if \(showing\('\.kit-bar__menu'\)\) return \(\) => openDrawer\(\);/, 'a swipe from the edge is a finger');
  assert.match(css, /\.kit-nav__item:focus-visible \{ outline-offset: -2px; \}/, 'the ring inside the entry: the list would cut it');
  assert.match(css, /\.kit-side__nav:focus \{ outline: none; \}/);
});

test('a view\'s head: the bar\'s buttons are made for it too, and a pane showing one doesn\'t show the bar', () => {
  const shell = fs.readFileSync(new URL('../web/shell.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../web/kit.css', import.meta.url), 'utf8');
  assert.match(shell, /function viewHead\(\{ pane = 'list', title: text = '', lead = null, actions: own = \[\], below = null \} = \{\}\)/);
  assert.match(shell, /if \(pane === 'detail'\) start = backToggle\(\);/, '← over a detail, ☰ over a list');
  assert.match(shell, /pane === 'list' \? createButton\(\) : null/, 'the button that creates at the end of a list\'s head');
  assert.match(shell, /element, nav, list, detail, actions, banners, head: viewHead,/, 'the shell gives it');
  assert.match(shell, /if \(showing\('\.kit-bar__back'\)\) return/, 'a swipe from the edge finds the button that shows, in the bar or a head');
  assert.match(css, /\.kit-app:not\(\[data-screen="detail"\]\):has\(\.kit-pane--list \.kit-head\) \.kit-bar,\s*\.kit-app\[data-screen="detail"\]:has\(\.kit-pane--detail \.kit-head\) \.kit-bar \{ display: none; \}/);
  assert.match(css, /\.kit-app\[data-panes="split"\] \.kit-head \.kit-bar__back \{ display: none; \}/, 'side by side, nothing goes back');
});

test('the drawer follows the finger on a phone, and opens or closes by how far it went', () => {
  const shell = fs.readFileSync(new URL('../web/shell.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../web/kit.css', import.meta.url), 'utf8');
  assert.match(shell, /const drawer = beside\(\) \? null/, 'beside the views the edge unfolds the sidebar, as before');
  assert.match(shell, /dragDrawer\(swipe\.drawer, dx, swipe\.rtl\);/, 'drawn where the finger is while it moves');
  assert.match(shell, /const commitDistance = \(width\) => Math\.min\(90, width \* 0\.28\);/);
  assert.match(shell, /Math\.abs\(dx\) >= \(cancelled \? CANCEL_COMMIT : commitDistance\(width\)\)/, 'the finger\'s path decides, and less when the system takes the gesture away');
  assert.match(shell, /requestAnimationFrame\(settle\);\s*setTimeout\(settle, 80\);/, 'a page that isn\'t drawing doesn\'t leave the drawer halfway');
  assert.match(css, /\.kit-app\[data-drawer-drag\] \.kit-side, \.kit-app\[data-drawer-drag\] \.kit-scrim \{ transition: none; \}/);
});

/* ------------------------------ the frame's end ------------------------------ */

/**
 * A page for whole frames (shell.js): a fresh document, a phone-wide window without the
 * Navigation API (so the history is assumed to have somewhere to go back to, as in old Safari),
 * and what the frame asks of the browser. The previous globals come back after.
 */
async function framePage() {
  const { FakeElement, FakeEventTarget } = await import('./fake-dom.js');
  const saved = Object.fromEntries(['document', 'window', 'Element', 'getComputedStyle', 'innerWidth', 'innerHeight']
    .map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const page = installFakeDom();
  const win = Object.assign(new FakeEventTarget(), { innerWidth: 390, innerHeight: 800 });
  Object.assign(globalThis, {
    window: win, Element: FakeElement, innerWidth: 390, innerHeight: 800,
    getComputedStyle: () => ({ direction: 'ltr', display: 'inline-grid', overflowY: 'visible' }),
  });
  // menu() measures where it goes; nothing has a size here.
  FakeElement.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
  const restore = () => {
    delete FakeElement.prototype.getBoundingClientRect;
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
  return { page, win, restore };
}

const frameOptions = () => ({
  app: { id: 'notes', name: 'Notes' }, create: { label: 'New', onClick: () => {} },
  onSettings: () => {}, accountItems: [{ label: 'Export', onClick: () => {} }],
});

test('the frame’s destroy() takes away every listener it added, the menu it opened and its DOM; twice is harmless', async () => {
  const { page, win, restore } = await framePage();
  try {
    const { createShell } = await import('../web/shell.js');
    const before = { document: page.listenerCount(), window: win.listenerCount() };
    const shell = createShell(frameOptions());
    assert.ok(page.listenerCount() >= before.document + 7, 'touches, drags and the like, on the document');
    assert.equal(page.body.children.length, 1);

    // The account menu open, as it may be when an app draws its frame again: it lives in the body.
    const account = shell.element.querySelector('.kit-account');
    account.click();
    assert.equal(account.getAttribute('aria-expanded'), 'true');
    assert.equal(page.body.children.length, 2);

    shell.destroy();
    assert.deepEqual({ document: page.listenerCount(), window: win.listenerCount() }, before, 'nothing left listening');
    assert.equal(page.body.children.length, 0, 'the frame and its menu left the page');
    assert.equal(account.getAttribute('aria-expanded'), 'false');
    assert.equal(account.listenerCount(), 0, 'its own nodes hold nothing either');

    shell.destroy();
    // The menu's outside-click listener comes on the next turn, and not for a menu already closed.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual({ document: page.listenerCount(), window: win.listenerCount() }, before);
  } finally {
    restore();
  }
});

test('a frame drawn again passes a tap at the screen’s edge on once, not once per frame ever made', async () => {
  const { page, restore } = await framePage();
  try {
    const { createShell } = await import('../web/shell.js');
    const { el } = await import('../web/dom.js');
    /** A finger down and up within 20 px of the start edge, on a button in the frame's list. */
    const tapAtEdge = (shell) => {
      const button = el('button', { type: 'button' });
      shell.list.append(button);
      let clicks = 0;
      button.addEventListener('click', () => { clicks += 1; });
      page.dispatch('touchstart', { touches: [{ clientX: 5, clientY: 300 }], target: button, preventDefault: () => {} });
      page.dispatch('touchend', { touches: [], target: button });
      return clicks;
    };

    // What happened before destroy(): the old frame, still listening, passed the tap on too.
    const old = createShell(frameOptions());
    old.element.remove();
    const leaked = createShell(frameOptions());
    assert.equal(tapAtEdge(leaked), 2, 'the bug, as it was');
    old.destroy();
    leaked.destroy();

    // Drawn again the way an app does it now: the old one destroyed first.
    let shell = createShell(frameOptions());
    for (let round = 0; round < 3; round += 1) {
      shell.destroy();
      shell = createShell(frameOptions());
    }
    assert.equal(page.body.children.length, 1);
    assert.equal(tapAtEdge(shell), 1);
    shell.destroy();
  } finally {
    restore();
  }
});

test('every listener the frame adds goes with its one signal, or by hand with destroy()', () => {
  const shell = fs.readFileSync(new URL('../web/shell.js', import.meta.url), 'utf8');
  const added = shell.match(/\.addEventListener\(/g).length;
  // Each call ends with its options holding the signal, on its line or at the end of its block…
  const signed = shell.match(/\{ (?:[\w]+: [\w]+, )*signal \}\);/g).length;
  // …but the click swallowed after a drag of the drawer, a line Tasks' smoke test reads as it is.
  assert.match(shell, /document\.addEventListener\('click', swallow, \{ capture: true, once: true \}\);\s*setTimeout\(\(\) => document\.removeEventListener\('click', swallow, \{ capture: true \}\), 400\);/);
  assert.match(shell, /for \(const swallow of swallowing\) document\.removeEventListener\('click', swallow, \{ capture: true \}\);/);
  assert.equal(signed, added - 1);
  assert.match(shell, /const listening = new AbortController\(\);/);
  assert.match(shell, /listening\.abort\(\);/);
});

test('a frame of the host\'s own page is FRAMED; a page on its own, or framed by another site, is not', async () => {
  const { framedIn } = await import('../web/base.js');
  const page = { location: { origin: 'https://work.example' } };
  page.top = page;
  page.self = page;
  assert.equal(framedIn(page), false, 'a page on its own');
  const frame = { location: { origin: 'https://work.example' }, top: page };
  frame.self = frame;
  assert.equal(framedIn(frame), true, 'a frame of the split view');
  const elsewhere = { location: { origin: 'https://work.example' }, top: { get location() { throw new Error('SecurityError'); } } };
  elsewhere.self = elsewhere;
  assert.equal(framedIn(elsewhere), false, 'another site\'s page can\'t be read');
  assert.equal(framedIn(undefined), false, 'no window: Node');
});

test('in a frame, the split view opens the module\'s Settings, and hears when they open and close', () => {
  const read = (file) => fs.readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');
  assert.match(read('base.js'), /export const SETTINGS_EVENT = 'kit:settings';/);
  assert.match(read('base.js'), /export const SETTINGS_SHOWN_EVENT = 'kit:settings-shown';/);
  assert.match(read('shell.js'), /if \(FRAMED && onSettings\) window\.addEventListener\(SETTINGS_EVENT, \(\) => \{ closeDrawer\(\); onSettings\(\); \}, \{ signal \}\);/);
  const settings = read('settings.js');
  assert.match(settings, /if \(!FRAMED\) return;/);
  assert.match(settings, /new window\.parent\.CustomEvent\(SETTINGS_SHOWN_EVENT, \{ detail: \{ open, source: window \} \}\)/);
  assert.match(settings, /shown\(true\);/);
  assert.match(settings, /overlay\.remove\(\);\s*shown\(false\);/);
});

test('in a frame, signing in or out, paying and leaving with the account take the whole window', () => {
  const read = (file) => fs.readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');
  assert.match(read('signin.js'), /href: '\/auth\/login', target: FRAMED \? '_top' : null/);
  assert.match(read('signin.js'), /const page = FRAMED \? window\.top : window;/);
  assert.match(read('settings.js'), /const page = FRAMED \? window\.top : window;/);
  assert.match(read('plan.js'), /\(FRAMED \? globalThis\.top : globalThis\)\.location\.assign\(url\)/);
});

test('signing out clears every app’s copy on this device, without waiting on a tab that holds one', async () => {
  const { clearDeviceCopies } = await import('../web/signin.js');
  const deleted = [];
  const idb = {
    databases: async () => [{ name: 'tasks-local' }, { name: 'next-local' }, { name: 'other-db' }, { name: 'notes-local' }],
    deleteDatabase(name) {
      const req = {};
      deleted.push(name);
      // notes-local is held by a tab that never lets go: its request never ends.
      if (name !== 'notes-local') setTimeout(() => req.onsuccess?.(), 5);
      return req;
    },
  };
  const started = Date.now();
  assert.deepEqual(await clearDeviceCopies({ indexedDB: idb, wait: 60 }), ['tasks-local', 'next-local', 'notes-local']);
  assert.deepEqual(deleted, ['tasks-local', 'next-local', 'notes-local'], 'only the apps’ copies (`<app>-local`)');
  assert.ok(Date.now() - started < 1000, 'a blocked one is not waited for');
  assert.deepEqual(await clearDeviceCopies({ indexedDB: {} }), [], 'a browser that can’t list them: nothing');
  const signin = fs.readFileSync(new URL('../web/signin.js', import.meta.url), 'utf8');
  assert.match(signin, /await local\?\.clearAll\?\.\(\)\.catch\(\(\) => \{\}\);\s*await clearDeviceCopies\(\)\.catch\(\(\) => \{\}\);/);
});
