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
import { EventEmitter } from 'node:events';
import { installFakeDom } from './fake-dom.js';

installFakeDom();
const { createOutbox, tempId, isTempId } = await import('../web/outbox.js');
const { memoryLocal } = await import('../web/local.js');
const { api, setPatience, Offline, SessionExpired, ApiError } = await import('../web/api.js');
const { connectLive } = await import('../web/live.js');
const { createLive } = await import('../live.js');
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

/** A memoryLocal() that counts what is read from it: records whose value came back, and calls. */
function countedLocal() {
  const local = memoryLocal();
  const seen = { calls: 0, read: 0 };
  const counted = { seen };
  for (const [name, fn] of Object.entries(local)) {
    counted[name] = async (...args) => {
      seen.calls += 1;
      if (name === 'rewrite') {
        const change = args[1];
        args[1] = (value, key) => { seen.read += 1; return change(value, key); };
      }
      const out = await fn(...args);
      if (name === 'entries') seen.read += out.length;
      if ((name === 'first' || name === 'get') && out !== undefined) seen.read += 1;
      return out;
    };
  }
  return counted;
}

test('the outbox reads no queued change to add or count one, and each once to send them (it read the whole queue each time)', async () => {
  const local = countedLocal();
  const counts = [];
  let id = 100;
  const outbox = createOutbox({ local, locks: null, onCount: (n) => counts.push(n) });
  const N = 200;
  let current = '1';
  for (let i = 0; i < N; i++) {
    if (i % 4 === 0) {
      current = tempId();
      await outbox.add({ method: 'POST', path: '/api/notes', body: { text: 'x'.repeat(500) }, tempId: current });
    } else {
      await outbox.add({ method: 'PATCH', path: `/api/notes/${current}`, body: { text: 'y'.repeat(500), note: current } });
    }
  }
  assert.equal(local.seen.read, 0, 'adding 200 read none of them (it read 20,100 before)');
  assert.deepEqual(counts.slice(0, 3), [1, 2, 3]);
  assert.equal(counts.at(-1), N);

  const sends = [];
  const before = local.seen.read;
  const sender = createOutbox({ local, locks: null, send: async (op) => { sends.push(op); return op.method === 'POST' ? { id: id++ } : {}; } });
  const report = await sender.flush();
  assert.deepEqual([report.sent, report.dropped.length, report.left], [N, 0, 0]);
  assert.ok(sends.every((op) => !isTempId(op.path.split('/').pop()) && !isTempId(op.body?.note)), 'every provisional id swapped');
  assert.deepEqual(sends.map((op) => op.method).slice(0, 5), ['POST', 'PATCH', 'PATCH', 'PATCH', 'POST'], 'in order');
  // One record per change sent, plus one pass over what is left after each of the 50 creations.
  const read = local.seen.read - before;
  assert.ok(read <= N + 50 * N / 2 + 50, `${read} records read to send ${N} (it read 25,150 before)`);
});

test('memoryLocal: count, first and rewrite, as openLocal’s', async () => {
  const local = memoryLocal();
  assert.equal(await local.count('outbox'), 0);
  assert.equal(await local.first('outbox'), undefined);
  await local.put('outbox', 'b', { n: 2 });
  await local.put('outbox', 'a', { n: 1 });
  await local.put('outbox', 'c', { n: 3 });
  assert.equal(await local.count('outbox'), 3);
  assert.deepEqual(await local.first('outbox'), ['a', { n: 1 }], 'by key, not by when it was put');
  const visited = [];
  const changed = await local.rewrite('outbox', (value, key) => { visited.push(key); return value.n % 2 ? { n: value.n * 10 } : undefined; });
  assert.equal(changed, 2);
  assert.deepEqual(visited, ['a', 'b', 'c']);
  assert.deepEqual(await local.entries('outbox'), [['a', { n: 10 }], ['b', { n: 2 }], ['c', { n: 30 }]]);
});

test('the outbox still works on a store without count, first and rewrite (an app’s own)', async () => {
  const full = memoryLocal();
  const plain = { get: full.get, put: full.put, delete: full.delete, entries: full.entries, clear: full.clear };
  let id = 7;
  const draft = tempId();
  const sent = [];
  const outbox = createOutbox({ local: plain, locks: null, send: async (op) => { sent.push(op.path); return op.method === 'POST' ? { id: id++ } : {}; } });
  await outbox.add({ method: 'POST', path: '/api/notes', body: {}, tempId: draft });
  await outbox.add({ method: 'PATCH', path: `/api/notes/${draft}`, body: {} });
  assert.equal(await outbox.count(), 2);
  const report = await outbox.flush();
  assert.deepEqual([report.sent, report.left, sent], [2, 0, ['/api/notes', '/api/notes/7']]);
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

/**
 * A browser's EventSource on the server's real channel (live.js createLive): what the server
 * writes is parsed and handed to the listeners. `cut()` + `resume()`: EventSource coming back by
 * itself, with Last-Event-ID; `fail()`: closed for good, so the page opens a new one.
 */
function bridgedSource(channel, userId) {
  return class BridgedSource {
    static last = null;
    constructor(url) {
      Object.assign(this, { url, listeners: {}, lastEventId: '', readyState: 0 });
      BridgedSource.last = this;
      queueMicrotask(() => this.connect({}));
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, message = {}) { for (const fn of this.listeners[type] || []) fn(message); }
    close() { this.readyState = 2; this.req?.emit('close'); }
    connect(headers) {
      if (this.readyState === 2) return;
      this.req = Object.assign(new EventEmitter(), { headers, url: this.url });
      let buffer = '';
      const res = {
        writeHead() {}, setTimeout() {}, end() {},
        write: (chunk) => {
          buffer += chunk;
          for (let i; (i = buffer.indexOf('\n\n')) >= 0;) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (data === undefined) continue;
            const id = /^id: (.*)$/m.exec(block)?.[1];
            if (id !== undefined) this.lastEventId = id;
            this.emit(/^event: (.*)$/m.exec(block)?.[1] || 'message', { data, lastEventId: this.lastEventId });
          }
          return true;
        },
      };
      this.readyState = 1;
      channel.subscribe(this.req, res, { id: userId });
    }
    cut() { this.req.emit('close'); this.readyState = 0; this.emit('error'); }
    resume() { this.connect(this.lastEventId ? { 'last-event-id': this.lastEventId } : {}); }
    fail() { this.req.emit('close'); this.readyState = 2; this.emit('error'); }
  };
}

test('live: back within what the server remembers, the page gets what it missed and reloads nothing (it reloaded everything each time)', async () => {
  const channel = createLive({ remember: 256 });
  const Source = bridgedSource(channel, 1);
  const timers = fakeTimers();
  const seen = { reloads: 0, notices: [] };
  const live = connectLive({
    onResync: () => { seen.reloads += 1; },
    onChange: (events) => seen.notices.push(events.map((e) => e.data.n)),
  }, { url: '/api/events', EventSource: Source, timers });
  const settle = async () => { await new Promise((r) => setTimeout(r, 0)); timers.advance(300); };
  await settle();
  assert.equal(live.state, 'open');

  channel.publish({ audience: [1], data: { n: 0 } });
  await settle();
  // The network goes; three notices while away; EventSource comes back by itself.
  Source.last.cut();
  for (let n = 1; n <= 3; n++) channel.publish({ audience: [1], data: { n } });
  Source.last.resume();
  await settle();
  assert.deepEqual([seen.reloads, seen.notices], [0, [[0], [1, 2, 3]]], 'what was missed, once, and no reload');

  // A cut with nothing missed: nothing at all.
  Source.last.cut();
  Source.last.resume();
  await settle();
  assert.equal(seen.reloads, 0);

  // Closed for good (a 401): the new channel says in its address where it was.
  const closed = Source.last;
  closed.fail();
  channel.publish({ audience: [1], data: { n: 4 } });
  timers.advance(2000);
  await settle();
  assert.notEqual(Source.last, closed);
  assert.match(Source.last.url, /^\/api\/events\?last=[\w-]+\.\d+$/);
  assert.deepEqual([seen.reloads, seen.notices.at(-1)], [0, [4]]);

  // Too much missed: the server says resync, and the page reloads once (it was twice: resync, then hello).
  Source.last.cut();
  for (let n = 0; n < 300; n++) channel.publish({ audience: [1], data: { n } });
  Source.last.resume();
  await settle();
  assert.equal(seen.reloads, 1);

  // Opened again by hand (Retry, signing in again): from scratch, everything reloaded.
  live.reconnect();
  await settle();
  assert.equal(Source.last.url, '/api/events');
  assert.equal(seen.reloads, 2);
  live.stop();
  channel.close();
});

test('live: a hello after a cut without `replayed` (a server that does not replay), or for someone else, reloads', () => {
  const timers = fakeTimers();
  let resyncs = 0;
  const live = connectLive({ onResync: () => resyncs++ }, { EventSource: FakeSource, timers });
  const source = FakeSource.last;
  source.emit('hello', { data: '{"user_id":1}' });
  source.emit('hello', { data: '{"user_id":1}' });
  assert.equal(resyncs, 1, 'an older server: as before');
  source.emit('hello', { data: '{"user_id":1,"replayed":true}' });
  assert.equal(resyncs, 1);
  source.emit('hello', { data: '{"user_id":2,"replayed":true}' });
  assert.equal(resyncs, 2, 'someone else signed in meanwhile');
  live.stop();
});

/** The shell's channel for every module (`workRegistry().live`), as a test sees it: who subscribed, and stopped. */
function fakeShellLive() {
  const subscriptions = [];
  return {
    subscriptions,
    subscribe(module, handlers, options) {
      const subscription = { module, handlers, options, stopped: false, stop() { this.stopped = true; } };
      subscriptions.push(subscription);
      return subscription;
    },
  };
}

test('live: in the shell’s page a module’s channel is the shell’s, with the same object back', () => {
  const REGISTRY = Symbol.for('cronum.work');
  const shared = fakeShellLive();
  globalThis.document[REGISTRY] = { live: shared };
  try {
    const before = FakeSource.last;
    const states = [];
    const changes = [];
    let resyncs = 0;
    let accounts = 0;
    const live = connectLive({
      onChange: (events) => changes.push(events), onResync: () => resyncs++, onAccount: () => accounts++, onState: (s) => states.push(s),
    }, { EventSource: FakeSource, owner: 'notes', events: ['note'] });
    assert.equal(FakeSource.last, before, 'no channel of its own');
    const [first] = shared.subscriptions;
    assert.equal(first.module, 'notes', 'the module this copy of the kit belongs to');
    assert.deepEqual(first.options, { events: ['note'] });
    assert.equal(live.state, 'closed');

    first.handlers.onState('open');
    first.handlers.onState('open');
    assert.equal(live.state, 'open');
    assert.deepEqual(states, ['open'], 'a state said once');
    first.handlers.onChange([{ event: 'change', id: 'r.1', data: { note: 5 } }]);
    first.handlers.onResync();
    first.handlers.onAccount();
    assert.deepEqual(changes, [[{ event: 'change', id: 'r.1', data: { note: 5 } }]]);
    assert.equal(resyncs, 1);
    assert.equal(accounts, 1);

    live.reconnect();
    assert.equal(first.stopped, true, 'again: the old subscription let go');
    const second = shared.subscriptions[1];
    assert.equal(second.module, 'notes');

    live.stop();
    assert.equal(second.stopped, true);
    assert.equal(live.state, 'closed');
    assert.deepEqual(states, ['open', 'closed']);
    second.handlers.onChange([{ event: 'change' }]);
    second.handlers.onResync();
    assert.equal(changes.length, 1, 'nothing reaches a module once it stopped');
    assert.equal(resyncs, 1);

    // Its own address asked for, or a kit that is no module's (the host's own pages): its own channel.
    connectLive({}, { EventSource: FakeSource, owner: 'notes', url: '/notes/api/other-events' }).stop();
    assert.notEqual(FakeSource.last, before);
    const afterOwn = FakeSource.last;
    connectLive({}, { EventSource: FakeSource }).stop();
    assert.notEqual(FakeSource.last, afterOwn, 'at the root (ownerOf() is null), its own as always');
    assert.equal(shared.subscriptions.length, 2);
  } finally {
    delete globalThis.document[REGISTRY];
  }
  // Outside the shell's page, the module's own channel, as always.
  const before = FakeSource.last;
  connectLive({}, { EventSource: FakeSource, owner: 'notes' }).stop();
  assert.notEqual(FakeSource.last, before);
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

test('update: a frame of the split view never asks /version by itself, nor on coming back', async () => {
  const asked = [];
  let listened = 0;
  const timers = { ...fakeTimers(), setInterval: () => { throw new Error('no timer in a frame'); } };
  const frame = watchUpdates({
    fetch: async (url) => { asked.push(url); return { ok: true, json: async () => ({ version: 'b' }) }; },
    loadLocal: async () => ({ version: 'a' }),
    timers, doc: { addEventListener: () => { listened += 1; } }, host: async () => ({ worker: '/sw.js' }), framed: true,
  });
  await new Promise((done) => setTimeout(done, 10));
  assert.deepEqual(asked, [], 'the view asks, once for every frame');
  assert.equal(listened, 0);
  assert.equal(frame.loaded().version, 'a', 'its own version is read, for About');
  assert.equal(await frame.check({ announce: true }), true, 'About’s Check still asks');
  assert.deepEqual(asked, ['/version']);
  frame.stop();
});

test('base: the host’s modules are asked once per page, again when fresh, and again after a failure', async () => {
  const { hostModules } = await import('../web/base.js');
  let calls = 0;
  let fail = true;
  const fetch = async () => {
    calls += 1;
    if (fail) throw new Error('offline');
    return { ok: true, status: 200, json: async () => ({ modules: [{ mount: 'a' }] }) };
  };
  await assert.rejects(hostModules({ fetch, fresh: true }));
  fail = false;
  const one = await hostModules({ fetch });
  const two = await hostModules({ fetch });
  assert.equal(one, two);
  assert.equal(calls, 2, 'after the failure, asked again; then the same answer');
  assert.deepEqual(one, { status: 200, answer: { modules: [{ mount: 'a' }] } });
  await hostModules({ fetch, fresh: true });
  assert.equal(calls, 3);
  const missing = await hostModules({ fetch: async () => ({ ok: false, status: 404 }), fresh: true });
  assert.deepEqual(missing, { status: 404, answer: null });
});

test('links: in a frame, a chip of another module opens in the section that shows it (kit:open)', async () => {
  const { openBeside } = await import('../web/links.js');
  const { OPEN_EVENT } = await import('../web/base.js');
  const heard = [];
  const parent = {
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    dispatchEvent(ev) { heard.push(ev); if (ev.detail.mount === 'notes') ev.detail.handled = true; },
  };
  const win = { location: { href: 'https://work.example/tasks/list/1', pathname: '/tasks/list/1', origin: 'https://work.example' }, parent };
  const press = (href, extra = {}) => {
    const ev = { button: 0, currentTarget: { getAttribute: () => href }, prevented: false, ...extra };
    ev.preventDefault = () => { ev.prevented = true; };
    openBeside(ev, { framed: true, win });
    return ev;
  };
  assert.equal(press('/notes/#note=4').prevented, true, 'the view has Notes: it opens there');
  assert.equal(heard[0].type, OPEN_EVENT);
  assert.deepEqual({ ...heard[0].detail, source: null }, { url: '/notes/#note=4', mount: 'notes', source: null, handled: true });
  assert.equal(heard[0].detail.source, win);
  assert.equal(press('/projects/p/2').prevented, false, 'no section for it: the frame goes there, as before');
  heard.length = 0;
  assert.equal(press('/tasks/list/3').prevented, false, 'its own module: a link as any');
  assert.equal(press('/notes/#note=4', { metaKey: true }).prevented, false, 'a key held: the browser’s');
  assert.deepEqual(heard, []);
  const page = { button: 0, currentTarget: { getAttribute: () => '/notes/' }, preventDefault() { throw new Error('not in a page'); } };
  openBeside(page, { framed: false, win });
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
  assert.equal(products.length, 6, 'Tasks, Projects, Next, Focus, Notes and Tracker');
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
  assert.match(shell, /others\.map\(\(m\) => \(\{ label: m\.name, image: m\.icon, href: m\.path \}\)\),[^]*?others\.length \|\| calendarPath \? 'separator' : null,\s*\.\.\.accountMenuItems\(\),/);
  // Only where the rail doesn't show (a phone, or no answer from the host yet beside the views),
  // and always in a frame of the host's split view, which has no rail.
  // Never in a window of Work's shell, where the modules and Settings are the shell's.
  assert.match(shell, /const want = hosted && !embedded && \(FRAMED \|\| !\(beside\(\) && \(rail \|\| !answered\)\)\);/);
  assert.match(shell, /if \(FRAMED\) \{\s*others = \[\];\s*calendarPath = null;\s*asModule\(true\);\s*return null;\s*\}/, 'no rail in a frame, nor other modules or the calendar');
  // The split view's views on the rail, where the host has one, over Settings.
  assert.match(shell, /host\.split \? el\('button', \{\s*type: 'button', class: 'kit-rail__split'/);
  assert.match(shell, /href: n === 1 \? null : `\$\{page\}\?layout=\$\{n\}&from=\$\{encodeURIComponent\(mount\)\}`/);
  assert.match(css, /\.kit-rail__split \+ \.kit-rail__settings \{ margin-top: 0; \}/);
  for (const n of [1, 2, 3, 4]) assert.match(icons, new RegExp(` {2}'layout-${n}': '[^']+',\n`));
  // The calendar, where the host has one: a link to its page, just over the split view.
  assert.match(shell, /host\.calendar \? el\('a', \{\s*class: 'kit-rail__calendar', href: host\.calendar, title: t\('kit\.calendar\.title'\)/);
  assert.ok(shell.indexOf("class: 'kit-rail__calendar'") < shell.indexOf("class: 'kit-rail__split'"), 'over the split view');
  assert.match(css, /\.kit-rail__calendar \+ :is\(\.kit-rail__split, \.kit-rail__settings\) \{ margin-top: 0; \}/);
  assert.match(icons, /\n {2}calendar: '[^']+',\n/);
  // Settings › Modules turns its button on and off, where the host has one.
  const settings = fs.readFileSync(new URL('../web/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /calendarSwitch\.hidden = typeof answer\.calendar_shown !== 'boolean';/);
  assert.match(settings, /fetch\('\/api\/me\/calendar', \{/, 'at the host\'s root, not the module\'s path');
  // On a phone, where the rail doesn't show, the switcher's menu has it.
  assert.match(shell, /calendarPath = host\.calendar \|\| null;/);
  assert.match(shell, /calendarPath \? \{ label: t\('kit\.calendar\.title'\), iconName: 'calendar', href: calendarPath \} : null,/);
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
  assert.match(shell, /if \(Array\.isArray\(last\?\.modules\) && last\.modules\.some\(\(m\) => m\?\.mount === mount\)\) paintRail\(last\);\s*refreshModules\(\{ fresh: false \}\);/);
  assert.match(shell, /status === 404\) \{[^}]*localStorage\.removeItem\(RAIL_KEY\)/, 'no host there: forgotten');
  // Back to the page the rail asks again, but not in a frame of the split view: the view has the rail.
  assert.match(shell, /if \(!FRAMED\) document\.addEventListener\('visibilitychange'/);
  // A crossfade between pages of the site, the rail standing still; none for less motion.
  assert.match(css, /@view-transition \{ navigation: auto; \}/);
  assert.match(css, /\.kit-rail \{ view-transition-name: kit-rail; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*@view-transition \{ navigation: none; \}\s*\}/);
});

test('in the installed app, going to another module takes its place in the history, and the edge is wider', () => {
  const shell = fs.readFileSync(new URL('../web/shell.js', import.meta.url), 'utf8');
  // The system's Back (an edge swipe on an iPhone) must not lead to the module used before.
  assert.match(shell, /const installed = \(\) => navigator\.standalone === true\s*\|\| Boolean\(globalThis\.matchMedia\?\.\('\(display-mode: standalone\)'\)\?\.matches\);/);
  assert.match(shell, /modulePaths = new Set\(modules\.map\(\(m\) => new URL\(m\.path, window\.location\.href\)\.pathname\)\);/);
  assert.match(shell, /if \(!link \|\| link\.target === '_blank' \|\| !installed\(\)\) return;/, 'a browser keeps its history');
  assert.match(shell, /ev\.preventDefault\(\);\s*window\.location\.replace\(to\.href\);\s*\}, \{ capture: true, signal \}\);/);
  assert.match(shell, /if \(FRAMED \|\| ev\.defaultPrevented \|\| ev\.button !== 0 \|\| ev\.metaKey/, 'a new tab or window as ever');
  // A swipe that opens the drawer is taken a little further from the edge than the system's strip.
  assert.match(shell, /const EDGE = 28;/);
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

test('the service worker caches every kit file a cached one imports, or offline it would not load', () => {
  const sw = fs.readFileSync(new URL('../web/sw-core.js', import.meta.url), 'utf8');
  const files = new Set([.../SUITE_KIT_FILES = \[([^\]]*)\]/.exec(sw)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    const code = fs.readFileSync(new URL(`../web/${file.replace('/suite/', '')}`, import.meta.url), 'utf8');
    for (const [, name] of code.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'\.\/([\w.-]+\.js)'/gm)) {
      assert.ok(files.has(`/suite/${name}`), `${file} imports ./${name}, which the worker doesn't keep`);
    }
  }
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
    assert.match(code, /import \{ at(?:, BASE)?(?:, FRAMED)?(?:, SETTINGS(?:_SHOWN)?_EVENT)?(?:, SETTINGS_GOTO_EVENT)?(?:, DRAWER_EVENT)?(?:, LOOKS)?(?:, applyLook)?(?:, LOOK_KEY)?(?:, hostModules)? \} from '\.\/base\.js'/, file);
    // Only the host's own routes are asked at the root: which modules someone uses and in what order, their look and their calendar's button.
    assert.doesNotMatch(code, /fetch\(['`]\/(?!api\/(?:me\/)?modules(?:\/order)?['`]|api\/me\/look['`]|api\/me\/calendar['`])|import\(['`]\/|get\(['`]\/version/, file);
  }
});

test('a host’s look: applyLook paints Clean on <html> and keeps it for theme.js, the suite’s own needs nothing', async () => {
  const { applyLook, LOOK_KEY } = await import('../web/base.js');
  const attrs = new Map();
  const doc = { documentElement: { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) } };
  const kept = new Map();
  const before = globalThis.localStorage;
  globalThis.localStorage = { setItem: (k, v) => kept.set(k, v), removeItem: (k) => kept.delete(k), getItem: (k) => kept.get(k) ?? null };
  try {
    applyLook('clean', doc);
    assert.equal(attrs.get('data-look'), 'clean');
    assert.equal(kept.get(LOOK_KEY), 'clean');
    applyLook('cronum', doc);
    assert.equal(attrs.has('data-look'), false);
    assert.equal(kept.has(LOOK_KEY), false);
    applyLook('pink', doc);
    assert.equal(attrs.has('data-look'), false, 'a look it doesn’t know is the suite’s own');
  } finally {
    globalThis.localStorage = before;
  }
  // Before the first paint, the look of last time; and the Clean look's tokens, light and dark apart.
  const theme = fs.readFileSync(new URL('../web/theme.js', import.meta.url), 'utf8');
  assert.match(theme, /localStorage\.getItem\('host\.look'\) === 'clean'/);
  const css = fs.readFileSync(new URL('../web/kit.css', import.meta.url), 'utf8');
  assert.match(css, /:root\[data-look="clean"\]:not\(\[data-theme="dark"\]\) \{/);
  assert.match(css, /:root\[data-look="clean"\]\[data-theme="dark"\] \{/);
  const tokens = fs.readFileSync(new URL('../web/tokens.css', import.meta.url), 'utf8');
  for (const face of ['inter-latin.woff2', 'inter-latin-ext.woff2']) {
    assert.match(tokens, new RegExp(`url\\(fonts/${face.replace('.', '\\.')}\\)`));
    assert.ok(fs.existsSync(new URL(`../web/fonts/${face}`, import.meta.url)), face);
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

/**
 * sw-core.js in a sandbox with caches that keep what is put in them, and a server whose files
 * (`server`, `{ path: text }`) can change between two releases. → { worker(), fetched, store }
 */
async function deployedWorkers(scope, server) {
  const vm = await import('node:vm');
  const store = new Map();   // cache name → Map(path → response)
  const fetched = [];
  // As the Cache API matches by default: the query counts.
  const pathOf = (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, scope);
    return url.pathname + url.search;
  };
  class Response {
    constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.ok = this.status < 400; this.url = ''; this.headers = init.headers || {}; }
    clone() { const copy = new Response(this.body, this); copy.url = this.url; return copy; }
    async json() { return JSON.parse(this.body); }
    static error() { return { error: true }; }
  }
  const context = vm.createContext({
    URL, Promise, setTimeout, clearTimeout, Response,
    Request: class { constructor(url, init) { this.url = url; this.init = init; } },
    fetch: async (input) => {
      const pathname = pathOf(input);
      fetched.push(pathname);
      if (!(pathname in server)) return new Response('', { status: 404 });
      const response = new Response(server[pathname]);
      response.url = new URL(pathname, scope).href;
      return response;
    },
  });
  context.caches = {
    keys: async () => [...store.keys()],
    delete: async (name) => store.delete(name),
    open: async (name) => {
      if (!store.has(name)) store.set(name, new Map());
      const files = store.get(name);
      const cache = {
        match: async (input) => files.get(pathOf(input))?.clone(),
        put: async (input, response) => { files.set(pathOf(input), response.clone()); },
        add: async (input) => {
          const response = await context.fetch(input);
          if (!response.ok) throw new Error('missing');
          files.set(pathOf(input), response);
        },
        addAll: async (inputs) => { for (const input of inputs) await cache.add(input); },
      };
      return cache;
    },
    match: async (input) => {
      for (const files of store.values()) { const hit = files.get(pathOf(input)); if (hit) return hit.clone(); }
      return undefined;
    },
  };
  /** A release of the worker: sw-core.js run afresh with these options, installed and active. */
  const worker = async (options) => {
    const listeners = {};
    context.self = {
      registration: { scope },
      location: { origin: new URL(scope).origin },
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve(), matchAll: async () => [] },
    };
    vm.runInContext(fs.readFileSync(new URL('../web/sw-core.js', import.meta.url), 'utf8'), context);
    context.self.suiteWorker(options);
    for (const type of ['install', 'activate']) {
      let waited = null;
      listeners[type]({ waitUntil: (p) => { waited = p; } });
      await waited;
    }
    /** What a page gets for a GET of `url`: the worker's answer, or null when it leaves it to the browser. */
    const get = async (url, mode = 'cors') => {
      let answer = null;
      listeners.fetch({ request: { method: 'GET', url, mode }, respondWith: (p) => { answer = p; }, waitUntil: () => {} });
      return answer;
    };
    return { get };
  };
  return { worker, fetched, store };
}

test('a host’s worker serves code from its copy, keeps the kit once, and a release brings only what changed', async () => {
  const server = {
    '/': 'home', '/js/home.js': 'home v1', '/tasks/': 'tasks page', '/tasks/js/main.js': 'tasks v1',
    '/notes/': 'notes page', '/notes/js/main.js': 'notes v1',
  };
  for (const file of ['/suite/kit.css', '/suite/base.js', '/suite/dom.js']) server[file] = `${file} v1`;
  const { worker, fetched, store } = await deployedWorkers('https://work.example/', server);
  const release = (version, hashes) => worker({
    version, modules: ['/tasks/', '/notes/'], codeFirst: true, sharedKit: true, hashes,
    shell: ['/', '/js/home.js', '/tasks/', '/tasks/js/main.js', '/notes/', '/notes/js/main.js'],
  });
  const first = {
    '/js/home.js': 'h1', '/tasks/js/main.js': 't1', '/notes/js/main.js': 'n1',
    '/suite/kit.css': 'k1', '/suite/base.js': 'b1', '/suite/dom.js': 'd1',
  };
  const one = await release('work-a', first);
  assert.ok(fetched.includes('/suite/kit.css'));
  assert.equal(fetched.filter((p) => /^\/(tasks|notes)\/suite\//.test(p)).length, 0, 'the kit once, at /suite/');

  // Code: the copy, without a word to the server; a module's kit from the one copy, at the path it asked.
  fetched.length = 0;
  assert.equal((await one.get('https://work.example/tasks/js/main.js')).body, 'tasks v1');
  const base = await one.get('https://work.example/notes/suite/base.js');
  assert.equal(base.body, '/suite/base.js v1');
  assert.equal(base.url, '', 'a response of its own: the page reads it at /notes/suite/, so its base stays /notes/');
  assert.deepEqual(fetched, [], 'nothing asked of the network');
  assert.equal(await one.get('https://work.example/tasks/api/lists'), null, 'data still always reaches the server');

  // A module's kit sheet scoped to its windows (Work's shell, host.js scopedSheets): its own answer,
  // never the one copy, which every module's page goes on getting as it was.
  server['/notes/suite/kit.css?scope=work'] = 'kit scoped to notes';
  fetched.length = 0;
  assert.equal((await one.get('https://work.example/notes/suite/kit.css?scope=work')).body, 'kit scoped to notes');
  assert.deepEqual(fetched, ['/notes/suite/kit.css?scope=work']);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await one.get('https://work.example/notes/suite/kit.css')).body, '/suite/kit.css v1', 'the one copy stays the kit’s');
  assert.equal((await one.get('https://work.example/notes/suite/kit.css?scope=work')).body, 'kit scoped to notes', 'and the scoped one is kept apart');
  assert.deepEqual(fetched, ['/notes/suite/kit.css?scope=work']);

  // A release that only changes the kit: a new worker, which brings that file and takes the rest from the old copy.
  server['/suite/kit.css'] = '/suite/kit.css v2';
  fetched.length = 0;
  const two = await release('work-b', { ...first, '/suite/kit.css': 'k2' });
  assert.deepEqual(fetched.filter((p) => first[p]), ['/suite/kit.css'], 'of what has a hash, only the file that changed travels');
  assert.deepEqual([...store.keys()], ['work-b'], 'the old copy goes once the new one has what it needs');
  fetched.length = 0;
  assert.equal((await two.get('https://work.example/tasks/suite/kit.css')).body, '/suite/kit.css v2', 'the new kit, in every module');
  assert.equal((await two.get('https://work.example/notes/js/main.js')).body, 'notes v1');
  assert.deepEqual(fetched, []);

  // A file the copy lacks: from the network once, and kept.
  server['/tasks/js/late.js'] = 'late';
  assert.equal((await two.get('https://work.example/tasks/js/late.js')).body, 'late');
  await new Promise((resolve) => setTimeout(resolve, 0));
  fetched.length = 0;
  assert.equal((await two.get('https://work.example/tasks/js/late.js')).body, 'late');
  assert.deepEqual(fetched, []);
});

test('an app on its own keeps code network first', async () => {
  const server = { '/': 'page', '/js/main.js': 'v1' };
  const { worker, fetched } = await deployedWorkers('https://tasks.example/', server);
  const alone = await worker({ version: 'tasks-v1', shell: ['/', '/js/main.js'], kit: false });
  server['/js/main.js'] = 'v2';
  fetched.length = 0;
  assert.equal((await alone.get('https://tasks.example/js/main.js')).body, 'v2');
  assert.deepEqual(fetched, ['/js/main.js']);
});

test('a page asked for outside a navigation is the browser’s, so a failed fetch is not the worker’s error', async () => {
  const server = { '/': 'home', '/js/home.js': 'v1', '/tasks/': 'tasks page' };
  const { worker, fetched } = await deployedWorkers('https://work.example/', server);
  const one = await worker({ version: 'work-a', modules: ['/tasks/'], codeFirst: true, shell: ['/', '/js/home.js', '/tasks/'], kit: false });
  // Chrome checks the page before installing the app: Work's split view, `|` and all.
  fetched.length = 0;
  for (const page of ['https://work.example/?w=tasks:%3Flist%3D38|notes:&f=notes', 'https://work.example/w/', 'https://work.example/tasks/list/12', 'https://work.example/index.html']) {
    assert.equal(await one.get(page), null, page);
  }
  assert.deepEqual(fetched, [], 'nothing asked by the worker');
  // A navigation is still the worker's: network first, the copy offline.
  assert.equal((await one.get('https://work.example/', 'navigate')).body, 'home');
  // And a file without a copy still is: an icon, the code.
  assert.equal((await one.get('https://work.example/js/home.js')).body, 'v1');
  assert.notEqual(await one.get('https://work.example/icons/a.png'), null);
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
  // Your AI, opened, names the address to connect to.
  globalThis.window = { location: { origin: 'https://demo.example' } };
  try {
    const listed = (config, start = null) => {
      const root = document.createElement('div');
      openSettings({ app: { id: 'demo', name: 'Demo' }, user: { username: 'ada', role: 'user' }, config, root, start });
      const texts = (className) => root.all().filter((node) => node.className === className).map((node) => node.textContent);
      return { labels: texts('kit-settings__label'), groups: texts('kit-settings__group'), page: root.all().find((node) => node.className === 'kit-settings__page') };
    };
    const ai = t('kit.ai.title');
    const connections = t('kit.settings.groups.connections');
    const off = listed({ provider: 'workos', app: { id: 'demo', modules: { organizations: false, billing: false, data: false, mcp: false } } });
    assert.ok(off.labels.length + off.groups.length >= 4, 'the rest is there');
    assert.ok(!off.labels.includes(ai), 'no AI section without an MCP');
    assert.ok(off.groups.includes(connections), 'Connections stays, for where one is signed in');
    assert.equal(listed({ app: { modules: { mcp: false } } }, 'sessions').page.children.length, 1);
    assert.equal(listed({ app: { modules: { mcp: false } } }, 'ai').page.children.length, 0, 'asked for by name, nothing opens');
    assert.ok(listed({ app: { modules: { mcp: true } } }).groups.includes(connections), 'with an MCP, as always');
    assert.equal(listed({ app: { modules: { mcp: true } } }, 'ai').page.children.length, 1);
    assert.ok(listed({ app: { modules: { organizations: false, billing: false, data: false } } }).groups.includes(connections),
      'a server from before the flag keeps it');
    assert.ok(listed({}).groups.includes(connections), 'and so does a config without the app');
  } finally {
    delete globalThis.window;
    delete document.addEventListener;
    delete document.removeEventListener;
  }
});

test('in a host, Settings are one for the whole app: the account\'s, a group for each module in use, the host\'s last', async () => {
  const { openSettings } = await import('../web/settings.js');
  const { t } = await import('../web/i18n.js');
  const { el } = await import('../web/dom.js');
  const realFetch = globalThis.fetch;
  const asked = [];
  const assigned = [];
  const modules = [
    { mount: 'tasks', path: '/tasks/', name: 'Tasks', active: true, settings: { sections: [{ id: 'preferences', label: 'settings.prefs.title' }], data: true, ai: true, about: true } },
    { mount: 'notes', path: '/notes/', name: 'Notes', active: true, settings: { sections: [{ id: 'templates', icon: 'copy', label: 'templates.title', hint: 'templates.short' }, { id: 'gone', label: 'no.such.key' }], data: true, ai: true, about: false } },
    { mount: 'next', path: '/next/', name: 'Next', active: false, settings: { sections: [{ id: 'line', label: 'settings.line.title' }], data: true, ai: false, about: false } },
  ];
  globalThis.fetch = async (path) => {
    asked.push(path);
    const data = path === '/api/modules' ? { modules }
      : path === '/notes/i18n/en.json' ? { 'templates.title': 'Templates', 'templates.short': 'Your own' } : undefined;
    return { ok: data !== undefined, status: data === undefined ? 404 : 200, json: async () => data };
  };
  globalThis.window = { location: { assign: (to) => assigned.push(to) } };
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {} });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const root = document.createElement('div');
    openSettings({
      app: { id: 'tasks', name: 'Tasks' }, user: { username: 'ada', role: 'admin' }, root,
      config: {
        deletion_days: 30,
        app: { modules: { data: true, mcp: true }, host: { id: 'work', name: 'Cronum Work', mount: 'tasks', base: '/tasks/', push: true, plans: true } },
      },
      sections: [{ id: 'preferences', label: 'Preferences', render: () => [] }],
      aiExtra: () => el('p', { text: 'Paste this' }),
      aboutExtra: () => el('p', { text: 'What Tasks is' }),
    });
    for (let i = 0; i < 4; i++) await settle();
    const texts = (className) => root.all().filter((node) => node.className === className).map((node) => node.textContent);
    const groups = texts('kit-settings__group');
    const labels = texts('kit-settings__label');
    assert.deepEqual(groups, [
      t('kit.settings.groups.account'), t('kit.settings.groups.connections'),
      'Tasks', 'Notes', 'Cronum Work',
    ], 'the account\'s, each module in use in the host\'s order, the host\'s last; Next is off');
    // Password and sign-in is the account's, after the profile; where one is signed in, the last of Connections.
    assert.equal(labels[labels.indexOf(t('kit.profile.title')) + 1], t('kit.security.title'));
    assert.equal(labels[labels.indexOf(t('kit.notifications.title')) + 1], t('kit.security.sessions'));
    // Notices and the plan are the host's to say, the same in every module, whatever this one passed;
    // the plan is the account's.
    assert.ok(labels.includes(t('kit.notifications.title')));
    assert.equal(labels[labels.indexOf(t('kit.appearance.title')) + 1], t('kit.plan.title'));
    // This module's own, drawn here: its sections, its data and what it adds to Your AI (it has no
    // instruction for Your AI to show); what it is goes in About's card.
    assert.deepEqual(labels.slice(labels.indexOf('Preferences'), labels.indexOf('Preferences') + 3),
      ['Preferences', t('kit.data.title'), t('kit.settings.moduleAi')]);
    assert.equal(labels.at(labels.indexOf('Preferences') + 3), 'Templates');
    // Another's, named from its own catalog; one its catalog doesn't name is left out.
    assert.deepEqual(labels.slice(labels.indexOf('Templates'), labels.indexOf('Templates') + 3),
      ['Templates', t('kit.data.title'), t('kit.settings.moduleAi')]);
    assert.ok(!labels.includes('no.such.key'));
    assert.ok(asked.includes('/notes/i18n/en.json'));
    assert.ok(!asked.some((path) => path.startsWith('/next/')), 'a module not in use isn\'t asked');
    // Deleting the whole account is the account's, after the plan; the host's last: administration and about it.
    assert.equal(labels[labels.indexOf(t('kit.plan.title')) + 1], t('kit.data.deleteTitle'));
    assert.deepEqual(labels.slice(-2), [t('kit.admin.title'), t('kit.about.title', { app: 'Cronum Work' })]);
    // Choosing another module's section goes there, with Settings open on it.
    const templates = root.all().find((node) => node.className === 'kit-settings__item' && node.textContent.includes('Templates'));
    for (const fn of templates.listeners.click) fn({ currentTarget: templates });
    assert.deepEqual(assigned, ['/notes/?settings=templates']);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete document.addEventListener;
    delete document.removeEventListener;
  }
});

test('the list folds by group: one open at a time, the section\'s own when it opens; a group of one is its way in', async () => {
  const { openSettings } = await import('../web/settings.js');
  const { t } = await import('../web/i18n.js');
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {} });
  try {
    const root = document.createElement('div');
    const settings = openSettings({
      app: { id: 'demo', name: 'Demo' }, user: { username: 'ada', role: 'user' }, root,
      config: { app: { modules: { mcp: false, data: true } } },
      sections: [{ id: 'mine', label: 'Mine', render: () => [] }],
    });
    const headings = () => root.all().filter((node) => node.className === 'kit-settings__group');
    const heading = (name) => headings().find((node) => node.textContent === name);
    const folder = (name) => root.all().find((node) => node.className === 'kit-settings__folder' && node.getAttribute('aria-label') === name);
    const press = (node) => { for (const fn of node.listeners.click) fn({ currentTarget: node }); };
    const account = t('kit.settings.groups.account');
    // On a phone (no width here) nothing is open at first: only the headings.
    assert.ok(headings().every((node) => node.getAttribute('aria-expanded') !== 'true'));
    assert.ok(folder(account).hasAttribute('hidden'));
    press(heading(account));
    assert.equal(heading(account).getAttribute('aria-expanded'), 'true');
    assert.ok(!folder(account).hasAttribute('hidden'));
    // Another one open folds the first.
    press(heading('Demo'));
    assert.equal(heading('Demo').getAttribute('aria-expanded'), 'true');
    assert.equal(heading(account).getAttribute('aria-expanded'), 'false');
    assert.ok(folder(account).hasAttribute('hidden'));
    // Pressed again, it folds: none open.
    press(heading('Demo'));
    assert.ok(headings().every((node) => node.getAttribute('aria-expanded') !== 'true'));
    // A section opened by name unfolds its group.
    settings.show('appearance');
    assert.equal(heading(account).getAttribute('aria-expanded'), 'true');
    // Connections with no AI connector and no notices has one section, where one is signed in: its
    // heading opens it, with no fold.
    const connections = heading(t('kit.settings.groups.connections'));
    assert.equal(connections.getAttribute('aria-expanded'), null);
    press(connections);
    assert.equal(root.all().find((node) => node.className === 'kit-settings__page').textContent.startsWith(t('kit.security.sessions')), true);
    assert.equal(heading(t('kit.settings.groups.connections')).getAttribute('aria-current'), 'page');
  } finally {
    delete document.addEventListener;
    delete document.removeEventListener;
  }
});

test('the section another module sent the person to is read off the address, and taken off it', async () => {
  const { settingsAsked } = await import('../web/settings.js');
  const replaced = [];
  const page = (href) => ({ location: { href }, history: { state: null, replaceState: (_s, _t, to) => replaced.push(to) } });
  assert.equal(settingsAsked(page('https://work.example/notes/?settings=templates#/all')), 'templates');
  assert.deepEqual(replaced, ['/notes/#/all'], 'going back or reloading doesn\'t open Settings again');
  assert.equal(settingsAsked(page('https://work.example/notes/?a=1&settings=data')), 'data');
  assert.equal(replaced.at(-1), '/notes/?a=1');
  assert.equal(settingsAsked(page('https://work.example/notes/')), null, 'nothing asked');
  assert.equal(settingsAsked(page('https://work.example/notes/?settings=%3Cscript%3E')), null, 'not a section\'s id');
  assert.equal(settingsAsked(undefined), null, 'no window: Node');
});

test('the rail\'s top is the host\'s mark, not a way out to the page that chooses the modules', () => {
  const shell = fs.readFileSync(new URL('../web/shell.js', import.meta.url), 'utf8');
  assert.match(shell, /el\('span', \{ class: 'kit-rail__home', role: 'img', 'aria-label': host\.name \|\| t\('kit\.modules\.rail'\) \}/);
  assert.doesNotMatch(shell, /href: '\/\?modules'/);
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

test('with WorkOS and Google, Password and sign-in says plainly there is no password here, and where it is', async () => {
  const { t } = await import('../web/i18n.js');
  const page = await settingsAt('security', { provider: 'workos', app: { modules: { mcp: false } } }, {
    'GET /api/me/sign-in': { method: 'google', password: false, two_factor: { available: false } },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = page.root.all().find((node) => node.className === 'kit-settings__page').textContent;
    assert.ok(text.includes(t('kit.security.elsewhere.title', { provider: 'Google' })));
    assert.ok(text.includes(t('kit.security.elsewhere.body', { provider: 'Google' })));
    const link = page.root.find('a').find((node) => node.textContent === t('kit.security.elsewhere.open', { provider: 'Google' }));
    assert.equal(link.getAttribute('href'), 'https://myaccount.google.com/security');
    assert.ok(!page.root.find('input').length, 'no password to type, nor a second step to set up');
  } finally { page.done(); }
});

test('with WorkOS and a password: changing it, and a second step with no recovery codes', async () => {
  const { t } = await import('../web/i18n.js');
  const secret = 'JBSWY3DPEHPK3PXP';
  const asked = [];
  const answers = {
    'GET /api/me/sign-in': { method: 'password', password: true, two_factor: { available: true, enabled: false } },
    'POST /api/me/sign-in/password': { ok: true },
    'POST /api/me/sign-in/two-factor/setup': { secret, uri: `otpauth://totp/Demo%3Aada?secret=${secret}&issuer=Demo` },
    'POST /api/me/sign-in/two-factor/enable': { enabled: true },
  };
  const page = await settingsAt('security', { provider: 'workos', app: { modules: { mcp: false } } }, new Proxy(answers, {
    get: (target, key) => { asked.push(key); return target[key]; },
  }));
  try {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    await page.press(t('kit.security.changePassword'));
    assert.ok(asked.includes('POST /api/me/sign-in/password'));
    assert.ok(!asked.includes('POST /api/me/password'), 'not the local accounts\' route');
    assert.ok(page.root.all().some((node) => node.className === 'kit-badge' && node.textContent === t('kit.twoFactor.statusOff')));
    await page.press(t('kit.twoFactor.setUp'));
    await page.press(t('kit.twoFactor.continue'));
    const text = () => page.root.all().find((node) => node.className === 'kit-settings__page').textContent;
    assert.ok(text().includes(t('kit.twoFactor.noCodesHint', { app: 'Demo' })), 'said before it is on: no recovery codes');
    answers['GET /api/me/sign-in'] = { method: 'password', password: true, two_factor: { available: true, enabled: true } };
    await page.press(t('kit.twoFactor.turnOn'));
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(text().includes(t('kit.twoFactor.onNoCodes', { app: 'Demo' })));
    // Said in so many words, not left to the Turn off button.
    const badge = () => page.root.all().find((node) => String(node.className).startsWith('kit-badge'));
    assert.equal(badge().textContent, t('kit.twoFactor.statusOn'));
    assert.equal(badge().className, 'kit-badge kit-badge--on');
    assert.ok(!page.root.find('button').some((node) => node.textContent === t('kit.twoFactor.newCodes')), 'no recovery codes to renew');
    assert.ok(!page.root.find('ul').some((node) => node.className === 'kit-codes'));
  } finally { page.done(); }
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

test('links: linking, unlinking and creating linked, at the host’s root, as the server reads them', async () => {
  const { linkItems, unlink, createLinked } = await import('../web/links.js');
  const sent = [];
  let answer = { status: 201, body: { link: { id: 9, together: true } } };
  const fetch = async (path, init) => {
    sent.push({ path, method: init.method, credentials: init.credentials, type: init.headers['Content-Type'], body: init.body && JSON.parse(init.body) });
    return { ok: answer.status < 300, status: answer.status, json: async () => answer.body };
  };
  assert.deepEqual(await linkItems('notes:note:6', 'next:step:12', { together: true, fetch }), { link: { id: 9, together: true } });
  assert.deepEqual(await createLinked('next:step:12', { module: 'notes', type: 'note', data: { title: 'Ship it' }, fetch }),
    { link: { id: 9, together: true } });
  answer = { status: 200, body: { ok: true } };
  assert.deepEqual(await unlink(9, { fetch }), { ok: true });
  assert.deepEqual(sent, [
    { path: '/api/links', method: 'POST', credentials: 'same-origin', type: 'application/json', body: { from: 'notes:note:6', to: 'next:step:12', together: true } },
    { path: '/api/links/new', method: 'POST', credentials: 'same-origin', type: 'application/json',
      body: { from: 'next:step:12', module: 'notes', type: 'note', data: { title: 'Ship it' }, together: false } },
    { path: '/api/links/9', method: 'DELETE', credentials: 'same-origin', type: undefined, body: undefined },
  ]);
  // The host's errors as the kit's: signed out, refused, no network.
  answer = { status: 401, body: { error: 'unauthorized' } };
  await assert.rejects(linkItems('a:b:1', 'c:d:2', { fetch }), SessionExpired);
  answer = { status: 404, body: { error: 'not_found' } };
  await assert.rejects(unlink(3, { fetch }), (err) => err instanceof ApiError && err.status === 404 && err.code === 'not_found');
  await assert.rejects(createLinked('a:b:1', { module: 'c', type: 'd', fetch: async () => { throw new TypeError('down'); } }), Offline);
});

test('links: in Work’s shell a chip opens in a window of its module, and the page stays; anywhere else as before', async () => {
  const { linkChip, linksRow, openInWork } = await import('../web/links.js');
  const WORK = Symbol.for('cronum.work');
  const chip = () => linkChip({ id: 4, item: { url: '/notes/#/n/55', state: 'open', title: 'Ideas', app: 'Notes' } }, { base: '/tasks/' })
    .find('a')[0];
  const press = (anchor, extra = {}) => {
    const pressed = { prevented: false };
    anchor.dispatch('click', { button: 0, preventDefault: () => { pressed.prevented = true; }, ...extra });
    return pressed;
  };
  assert.equal(press(chip()).prevented, false, 'no shell: a link, as today');

  const opened = [];
  document[WORK] = { open: async (url, options) => { opened.push([url, options]); return true; } };
  try {
    assert.equal(press(chip()).prevented, true);
    assert.deepEqual(opened, [['/notes/#/n/55', { from: 'tasks' }]], 'the shell opens it, from the chip’s module');
    assert.equal(press(chip(), { ctrlKey: true }).prevented, false, 'a key held: the browser’s');
    assert.equal(press(chip(), { button: 1 }).prevented, false);
    assert.equal(opened.length, 1);
    // A gone item has no link to press.
    assert.equal(linkChip({ id: 5, item: { url: '/notes/#/n/9', state: 'gone', title: 'Old' } }).find('a').length, 0);
    // The chips of an item's row come from the row's module.
    const fetch = async (path) => ({ ok: true, status: 200, json: async () => (path === '/api/modules'
      ? { modules: [{ mount: 'beta', name: 'Beta', active: true, links: { item: { creates: true } } }] }
      : { links: [{ id: 4, item: { ref: 'beta:item:3', state: 'open', title: 'Review', app: 'Beta', url: '/beta/?item=3' } }] }) });
    const row = linksRow({ base: '/alpha/', fetch });
    await row.show('alpha:item:1');
    assert.equal(press(row.element.find('a')[0]).prevented, true);
    assert.deepEqual(opened.at(-1), ['/beta/?item=3', { from: 'alpha' }]);
    row.destroy();
  } finally {
    delete document[WORK];
  }

  // A link the shell can't open goes where it points, as a link would.
  const went = [];
  const win = { location: { assign: (url) => went.push(url) } };
  const ev = { button: 0, currentTarget: { getAttribute: () => '/projects/p/2' }, preventDefault() { this.prevented = true; } };
  assert.equal(openInWork(ev, { from: 'tasks', registry: { open: async () => false }, win }), true);
  assert.equal(ev.prevented, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(went, ['/projects/p/2']);
  assert.equal(openInWork({ ...ev, prevented: false }, { registry: null, win }), false, 'no shell: not taken');
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
  assert.match(shell, /if \(showing\('\.kit-bar__menu'\)(?: \|\| \(embedded && asDrawer\(\)\))?\) return \(\) => openDrawer\(\);/, 'a swipe from the edge is a finger');
  assert.match(css, /\.kit-nav__item:focus-visible \{ outline-offset: -2px; \}/, 'the ring inside the entry: the list would cut it');
  assert.match(css, /\.kit-side__nav:focus \{ outline: none; \}/);
  assert.match(css, /\.kit-settings__page:focus \{ outline: none; \}/, 'a section of Settings takes the focus without a ring around the page');
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
  assert.match(shell, /const drawer = beside\(\) \|\| held \? null/, 'beside the views the edge unfolds the sidebar, as before');
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

test('a swipe from the start edge over Settings follows the finger and goes back as its ←: from a section to the list, then out (Cronum core nº 12)', async () => {
  const { page, restore } = await framePage();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  try {
    const { createShell } = await import('../web/shell.js');
    const { openSettings } = await import('../web/settings.js');
    const shell = createShell(frameOptions());
    let closed = 0;
    const settings = openSettings({
      app: { id: 'notes', name: 'Notes' }, user: { username: 'ada', role: 'user' },
      config: { app: { modules: { mcp: false } } }, onClose: () => { closed += 1; },
    });
    const overlay = page.body.all().find((node) => node.className === 'kit-settings-page');
    const grid = overlay.all().find((node) => node.className === 'kit-settings');
    const under = overlay.all().find((node) => node.className === 'kit-settings__list');
    const section = overlay.all().find((node) => node.className === 'kit-settings__page');
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
    /** A finger from `from`, `by` px to the end in steps `ms` apart; `lift: false` keeps it down. */
    const swipe = async (target, { from = 5, by = 150, ms = 16, lift = true } = {}) => {
      let prevented = 0;
      const preventDefault = () => { prevented += 1; };
      let time = 1000;
      page.dispatch('touchstart', { touches: [{ clientX: from, clientY: 300 }], target, preventDefault });
      for (let x = 10; x <= by; x += 10) {
        time += ms;
        page.dispatch('touchmove', { touches: [{ clientX: from + x, clientY: 301 }], target, preventDefault, timeStamp: time });
      }
      if (lift) page.dispatch('touchend', { touches: [], target });
      return prevented;
    };
    const opened = () => shell.element.hasAttribute('data-drawer');

    settings.show('profile');
    assert.ok(grid.hasAttribute('data-open'), 'a section open, on a phone its own screen');
    assert.ok(await swipe(under, { lift: false }) >= 1, 'taken from Safari');
    assert.match(section.style.transform, /translateX\(150px\)/, 'the section where the finger is');
    assert.ok(grid.hasAttribute('data-swipe'), 'with the list beneath it');
    assert.ok(grid.hasAttribute('data-open'), 'not gone back yet');
    page.dispatch('touchend', { touches: [], target: under });
    await settle();
    assert.ok(!grid.hasAttribute('data-open'), 'back to the list');
    assert.ok(!grid.hasAttribute('data-swipe'));
    assert.equal(section.style.transform, '', 'nothing left drawn by hand');
    assert.ok(overlay.parentNode, 'Settings still open');
    assert.equal(opened(), false, 'the drawer under it stays closed');

    // A little, slowly: it comes back.
    settings.show('profile');
    await swipe(under, { by: 40, ms: 200 });
    await settle();
    assert.ok(grid.hasAttribute('data-open'), 'not far nor fast enough: the section stays');
    // The same little, fast: a flick goes.
    await swipe(under, { by: 40, ms: 8 });
    await settle();
    assert.ok(!grid.hasAttribute('data-open'), 'a flick goes back');

    await swipe(under, { from: 200 });
    await settle();
    assert.ok(overlay.parentNode, 'away from the edge, nothing');
    await swipe(under, { lift: false });
    assert.match(overlay.style.transform, /translateX\(150px\)/, 'from the list, Settings themselves slide away');
    page.dispatch('touchend', { touches: [], target: under });
    await settle();
    assert.equal(overlay.parentNode, null, 'out of Settings');
    assert.equal(closed, 1);

    // Closed, it holds the edge no more.
    const row = shell.list.appendChild(page.createElement('div'));
    await swipe(row);
    await settle();
    assert.equal(closed, 1);
    shell.destroy();
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
});

test('going back from a phone’s detail, the detail follows the finger over its list', async () => {
  const { page, restore } = await framePage();
  const realStyle = globalThis.getComputedStyle;
  try {
    const { createShell } = await import('../web/shell.js');
    const shell = createShell(frameOptions());
    shell.detail.append(shell.head({ pane: 'detail', title: 'Task' }).element);
    const inside = shell.detail.appendChild(page.createElement('p'));
    shell.showDetail();
    // On a phone the list is hidden behind the detail (kit.css).
    globalThis.getComputedStyle = (node) => ({ ...realStyle(node), display: node === shell.list ? 'none' : 'block' });
    page.dispatch('touchstart', { touches: [{ clientX: 5, clientY: 300 }], target: inside, preventDefault: () => {} });
    for (let x = 10; x <= 150; x += 10) page.dispatch('touchmove', { touches: [{ clientX: 5 + x, clientY: 300 }], target: inside, preventDefault: () => {}, timeStamp: 1000 + x });
    assert.ok(shell.element.hasAttribute('data-back-swipe'), 'the list drawn beneath');
    assert.match(shell.detail.style.transform, /translateX\(150px\)/);
    assert.equal(shell.screen, 'detail');
    page.dispatch('touchend', { touches: [], target: inside });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(shell.screen, 'list');
    assert.ok(!shell.element.hasAttribute('data-back-swipe'));
    assert.equal(shell.detail.style.transform, '');
    shell.destroy();
  } finally {
    globalThis.getComputedStyle = realStyle;
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
  // The view may name the section: one of this module's, chosen in Settings in another frame.
  assert.match(read('shell.js'), /if \(FRAMED && onSettings\) \{\s*window\.addEventListener\(SETTINGS_EVENT, \(ev\) => \{\s*closeDrawer\(\);\s*const start = ev\?\.detail\?\.start;\s*if \(typeof start === 'string' && start\) onSettings\(start\);\s*else onSettings\(\);\s*\}, \{ signal \}\);/);
  assert.match(read('base.js'), /export const SETTINGS_GOTO_EVENT = 'kit:settings-goto';/);
  const settings = read('settings.js');
  assert.match(settings, /if \(!FRAMED\) return;/);
  assert.match(settings, /new window\.parent\.CustomEvent\(SETTINGS_SHOWN_EVENT, \{ detail: \{ open, source: window \} \}\)/);
  assert.match(settings, /shown\(true\);/);
  assert.match(settings, /overlay\.remove\(\);\s*shown\(false\);/);
});

test('in Work\'s shell, Settings cover the whole page and another module\'s section opens in its window', () => {
  const settings = fs.readFileSync(new URL('../web/settings.js', import.meta.url), 'utf8');
  // Whatever root the module gave (Projects and Next give their window, which `contain`s what it holds).
  assert.match(settings, /const place = workRegistry\(\) \? document\.body : root;\s*place\.append\(place === document\.body \? markOwned\(overlay\) : overlay\);/);
  // The shell hears it on this window (work.js), and the page stays; with nobody to hear it, the address.
  assert.match(settings, /if \(workRegistry\(\)\) \{\s*const detail = \{ mount: m\.mount, start: id, source: window, handled: false \};\s*close\(\);\s*window\.dispatchEvent\(new CustomEvent\(SETTINGS_GOTO_EVENT, \{ detail \}\)\);\s*if \(detail\.handled\) return;\s*\}\s*window\.location\.assign\(address\);/);
});

test('in a frame, signing in or out, paying and leaving with the account take the whole window', () => {
  const read = (file) => fs.readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');
  assert.match(read('signin.js'), /href: login\(\), target: FRAMED \? '_top' : null/);
  // And back to the whole window's page, not the frame's: a module installed on its own stays in its app.
  assert.match(read('signin.js'), /\(FRAMED \? window\.top : window\)\.location; here = page\.pathname \+ page\.search;/);
  assert.match(read('signin.js'), /return=\$\{encodeURIComponent\(here\)\}/);
  assert.match(read('signin.js'), /const page = FRAMED \? window\.top : window;/);
  // Leaving with the account goes the way signing out does (signin.js leave()).
  assert.match(read('settings.js'), /await leave\(\{ answer: done \}\);/);
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

test('the module’s search is the sidebar’s first line: each change said, Escape empties it, Enter closes the drawer', async () => {
  const { restore } = await framePage();
  try {
    const { createShell } = await import('../web/shell.js');
    const said = [];
    const submitted = [];
    const shell = createShell({ ...frameOptions(), search: { label: 'Search notes', onInput: (text) => said.push(text), onSubmit: (text) => submitted.push(text) } });
    const side = shell.element.querySelector('.kit-side');
    assert.equal(side.querySelector('.kit-side__search').querySelector('.kit-side__search-input'), shell.search, 'in the sidebar, as `shell.search`');
    assert.equal(shell.search.getAttribute('aria-label'), 'Search notes');
    shell.search.value = 'plan';
    shell.search.dispatch('input');
    shell.openDrawer();
    shell.search.dispatch('keydown', { key: 'Enter', preventDefault: () => {} });
    assert.deepEqual(submitted, ['plan']);
    assert.equal(shell.element.hasAttribute('data-drawer'), false, 'the results are behind the drawer');
    shell.search.dispatch('keydown', { key: 'Escape', stopPropagation: () => {} });
    assert.equal(shell.search.value, '');
    assert.deepEqual(said, ['plan', '']);
    assert.equal(createShell(frameOptions()).search, null, 'none without one');
    shell.destroy();
  } finally {
    restore();
  }
});

test('in Work’s shell the button that folds shares the search’s line; on its own the app keeps its head', async () => {
  const { restore } = await framePage();
  try {
    const { createShell } = await import('../web/shell.js');
    const search = { label: 'Search notes', onInput: () => {} };
    const inWork = createShell({ ...frameOptions(), search, embedded: true });
    const top = inWork.element.querySelector('.kit-side__top');
    assert.ok(top, 'one line for both');
    assert.deepEqual([...top.children].map((node) => node.getAttribute('class')), ['kit-side__search', 'kit-icon-btn kit-side__fold'], 'the search, then the button');
    assert.equal(inWork.element.querySelector('.kit-side__head'), null, 'no line of its own');
    inWork.destroy();
    const noSearch = createShell({ ...frameOptions(), embedded: true });
    assert.equal(noSearch.element.querySelector('.kit-side__fold').parentNode.getAttribute('class'), 'kit-side__head', 'without a search, its line as before');
    noSearch.destroy();
    const alone = createShell({ ...frameOptions(), search });
    assert.equal(alone.element.querySelector('.kit-side__top'), null);
    assert.equal(alone.element.querySelector('.kit-side__fold').parentNode.getAttribute('class'), 'kit-side__head', 'beside the app’s name');
    alone.destroy();
  } finally {
    restore();
  }
});

test('on a phone the floating button creates, and the sidebar’s own only beside the views', () => {
  const css = fs.readFileSync(new URL('../web/kit.css', import.meta.url), 'utf8');
  assert.match(css, /\.kit-app:has\(\.kit-fab\) \.kit-side__create \{ display: none; \}/);
  assert.match(css, /@container kit-app \(min-width: 640px\) \{[^}]*\}[\s\S]*?\.kit-app:has\(\.kit-fab\) \.kit-side__create \{ display: block; \}/);
});

test('a group of the sidebar folds under its heading: closed until opened, remembered, open with the entry in sight', async () => {
  const { navFold } = await import('../web/shell.js');
  const before = globalThis.localStorage;
  const kept = new Map();
  globalThis.localStorage = { setItem: (k, v) => kept.set(k, v), getItem: (k) => kept.get(k) ?? null };
  try {
    const group = navFold({ label: 'Tags', key: 'demo.tags', children: [document.createElement('button')] });
    const [heading, body] = group.children;
    assert.equal(heading.getAttribute('aria-expanded'), 'false');
    assert.ok(body.hasAttribute('hidden'), 'closed at first');
    let stopped = false;
    for (const fn of heading.listeners.click) fn({ stopPropagation: () => { stopped = true; } });
    assert.equal(heading.getAttribute('aria-expanded'), 'true');
    assert.ok(!body.hasAttribute('hidden'));
    assert.ok(stopped, 'the drawer stays open');
    assert.equal(kept.get('demo.tags'), 'open');
    assert.ok(!navFold({ label: 'Tags', key: 'demo.tags' }).children[1].hasAttribute('hidden'), 'as it was left');
    kept.set('demo.tags', 'folded');
    assert.ok(!navFold({ label: 'Tags', key: 'demo.tags', keep: true }).children[1].hasAttribute('hidden'), 'the entry open stays in sight');
  } finally {
    globalThis.localStorage = before;
  }
});
