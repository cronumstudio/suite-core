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
const { watchUpdates } = await import('../web/update.js');

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

test('every file the service worker caches for the kit exists', () => {
  const sw = fs.readFileSync(new URL('../web/sw-core.js', import.meta.url), 'utf8');
  const files = [.../SUITE_KIT_FILES = \[([^\]]*)\]/.exec(sw)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(files.length > 15);
  for (const file of files) assert.ok(fs.existsSync(new URL(`../web/${file.replace('/suite/', '')}`, import.meta.url)), file);
});

/* ------------------------------ texts in code ----------------------------- */

test('the kit writes no text for people in its code, and every key it uses exists', async () => {
  const { hardcodedTexts, unknownKeys, catalogsOf } = await import('../tools/i18n.mjs');
  const web = new URL('../web/', import.meta.url);
  assert.deepEqual(hardcodedTexts([fs.realpathSync(web)]), []);
  assert.deepEqual(unknownKeys(catalogsOf().en, [fs.realpathSync(web)]), []);
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
