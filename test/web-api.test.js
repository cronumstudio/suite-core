/**
 * The web kit's HTTP client with the options the modules' own clients needed
 * (web/api.js): a call's patience and signal, the body's text, the hooks
 * before sending, on the answer and without signal, and `api.with`. Without
 * them a call behaves as it always did (web-kit.test.js covers that).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';

installFakeDom();
const { api, setPatience, Offline, SessionExpired, ApiError } = await import('../web/api.js');

/** A fetch that records each call and answers with `answer(path, init)`, or hangs when it gives nothing. */
function fakeFetch(answer) {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = (path, init = {}) => new Promise((resolve, reject) => {
    seen.push({ path, ...init, body: init.body });
    // As a browser does: a signal already aborted fails at once.
    if (init.signal?.aborted) { reject(init.signal.reason); return; }
    init.signal?.addEventListener('abort', () => reject(init.signal.reason));
    const result = answer(path, init);
    if (result instanceof Error) reject(result);
    else if (result) resolve(result);
  });
  return { seen, restore: () => { globalThis.fetch = real; } };
}

const json = (data, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => data,
  text: async () => (data === undefined ? '' : JSON.stringify(data)),
});

test('api: beforeSend may change what goes; an Offline it throws is no signal, without asking the server', async () => {
  const net = fakeFetch(() => json({ ok: true }));
  try {
    await api.post('/api/items', { title: 'a' }, {
      beforeSend: ({ body, headers }) => ({ body: { ...body, client_ref: 'r1' }, headers: { ...headers, 'X-Test': '1' } }),
    });
    assert.equal(net.seen.length, 1);
    assert.deepEqual(JSON.parse(net.seen[0].body), { title: 'a', client_ref: 'r1' });
    assert.equal(net.seen[0].headers['X-Test'], '1');
    assert.equal(net.seen[0].headers['Content-Type'], 'application/json');

    // Known to be without signal: nothing is asked, and onNoSignal answers instead.
    const answer = await api.post('/api/items', { title: 'b' }, {
      beforeSend: () => { throw new Offline(); },
      onNoSignal: (req) => ({ queued: req.body.title }),
    });
    assert.deepEqual(answer, { queued: 'b' });
    assert.equal(net.seen.length, 1, 'the server was not asked');
    await assert.rejects(api.get('/api/items', { beforeSend: () => { throw new Offline(); } }), Offline);
    // Any other error stops the call as it is.
    await assert.rejects(api.get('/api/items', { beforeSend: () => { throw new TypeError('no'); } }), TypeError);
    assert.equal(net.seen.length, 1);
  } finally {
    net.restore();
  }
});

test('api: onNoSignal answers for a request that found no network, timed out or was cut half way', async () => {
  let mode = 'down';
  const net = fakeFetch((path, { signal }) => {
    if (mode === 'down') return new TypeError('Failed to fetch');
    if (mode === 'slow') return null;
    return { ok: true, status: 200, headers: { get: () => null },
      json: () => new Promise((resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason))) };
  });
  const onNoSignal = (req) => ({ provisional: true, path: req.path });
  try {
    assert.deepEqual(await api.patch('/api/tasks/1', { done: true }, { onNoSignal }), { provisional: true, path: '/api/tasks/1' });
    await assert.rejects(api.patch('/api/tasks/1', { done: true }), Offline, 'without it, Offline as always');
    mode = 'slow';
    assert.deepEqual(await api.patch('/api/tasks/2', {}, { patience: 15, onNoSignal }), { provisional: true, path: '/api/tasks/2' });
    mode = 'cut';
    assert.deepEqual(await api.get('/api/tasks/3', { patience: 15, onNoSignal }), { provisional: true, path: '/api/tasks/3' });
    // What onNoSignal throws is what the call throws.
    await assert.rejects(api.get('/api/tasks/3', { patience: 15, onNoSignal: () => { throw new RangeError('full'); } }), RangeError);
  } finally {
    net.restore();
  }
});

test('api: onAnswer sees the status and headers before the body, and a 401 is still SessionExpired', async () => {
  const order = [];
  const net = fakeFetch((path) => ({
    ok: !path.endsWith('/gone'),
    status: path.endsWith('/gone') ? 401 : 200,
    headers: { get: (name) => (name === 'date' ? 'Sun, 25 Oct 2026 10:00:00 GMT' : null) },
    json: async () => { order.push('body'); return path.endsWith('/gone') ? { error: 'unauthorized' } : { ok: 1 }; },
  }));
  try {
    const seen = [];
    const onAnswer = (res, req) => { order.push('answer'); seen.push([res.status, res.headers.get('date'), req.method, req.path]); };
    assert.deepEqual(await api.get('/api/me', { onAnswer }), { ok: 1 });
    assert.deepEqual(order, ['answer', 'body']);
    await assert.rejects(api.get('/api/gone', { onAnswer }), (err) => err instanceof SessionExpired && err.code === 'unauthorized');
    assert.deepEqual(seen, [
      [200, 'Sun, 25 Oct 2026 10:00:00 GMT', 'GET', '/api/me'],
      [401, 'Sun, 25 Oct 2026 10:00:00 GMT', 'GET', '/api/gone'],
    ]);
  } finally {
    net.restore();
  }
});

test('api: { text: true } answers the data with the text it came as', async () => {
  const net = fakeFetch((path) => {
    if (path.endsWith('/empty')) return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
    if (path.endsWith('/bad')) return { ok: false, status: 400, headers: { get: () => null }, text: async () => '{"error":"field_invalid","field":"name"}' };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"projects":[1,2]}' };
  });
  try {
    assert.deepEqual(await api.get('/api/projects', { text: true }), { data: { projects: [1, 2] }, text: '{"projects":[1,2]}' });
    assert.deepEqual(await api.get('/api/empty', { text: true }), { data: null, text: '' });
    await assert.rejects(api.get('/api/bad', { text: true }),
      (err) => err instanceof ApiError && err.code === 'field_invalid' && err.data.field === 'name');
  } finally {
    net.restore();
  }
});

test('api: a call\'s own patience and signal; 0 waits whatever the app\'s patience', async () => {
  const net = fakeFetch(() => null);
  try {
    // A keyless write gives up only when its call says so.
    await assert.rejects(api.post('/api/lists', {}, { patience: 15 }), Offline);
    setPatience(15);
    const waiting = api.get('/api/slow', { patience: 0 });
    let settled = false;
    waiting.catch(() => {}).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(settled, false, 'patience 0 waits');
    assert.equal(net.seen.at(-1).signal, undefined, 'no signal at all');
    setPatience(null);

    // The app's own signal: aborted, the call is no network.
    const controller = new AbortController();
    const call = api.patch('/api/tasks/1', {}, { signal: controller.signal });
    controller.abort(new DOMException('timeout', 'TimeoutError'));
    await assert.rejects(call, Offline);
    // One already aborted doesn't even wait.
    await assert.rejects(api.get('/api/x', { signal: AbortSignal.abort() }), Offline);
  } finally {
    setPatience(null);
    net.restore();
  }
});

test('api: write carries the key; upload takes a type for a file without one', async () => {
  const net = fakeFetch(() => json({ ok: true }));
  try {
    await api.write('POST', '/api/projects/1/entries', { done: 'x' }, { key: 'abc12345' });
    assert.equal(net.seen[0].headers['Idempotency-Key'], 'abc12345');
    await api.upload('/api/me/import', { type: '' }, { type: 'application/zip' });
    assert.equal(net.seen[1].headers['Content-Type'], 'application/zip');
    await api.upload('/api/files', { type: 'image/png' }, { type: 'application/zip' });
    assert.equal(net.seen[2].headers['Content-Type'], 'image/png', 'the file\'s own type wins');
    await api.upload('/api/files', { type: '' });
    assert.equal(net.seen[3].headers['Content-Type'], 'application/octet-stream', 'as before');
  } finally {
    net.restore();
  }
});

test('api.with: the same client with options on every call, a call\'s own winning', async () => {
  const net = fakeFetch(() => json({ ok: true }, { headers: { date: 'D' } }));
  try {
    const dates = [];
    const app = api.with({ onAnswer: (res) => dates.push(res.headers.get('date')), patience: 0 });
    await app.get('/api/a');
    await app.post('/api/b', { x: 1 });
    await app.delete('/api/c');
    await app.write('PATCH', '/api/d', { y: 2 }, { key: 'k2345678' });
    await app.upload('/api/e', { type: 'image/png' });
    assert.deepEqual(dates, ['D', 'D', 'D', 'D', 'D']);
    assert.deepEqual(net.seen.map((s) => s.method), ['GET', 'POST', 'DELETE', 'PATCH', 'POST']);
    const quiet = app.with({ onAnswer: null });
    await quiet.get('/api/f');
    await app.get('/api/g', { onAnswer: () => dates.push('own') });
    assert.deepEqual(dates.slice(5), ['own']);
  } finally {
    net.restore();
  }
});
