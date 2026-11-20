/**
 * The kit's one «is there a signal again?» (web/signal.js), which the four modules and Settings'
 * `connection` ask through (audit of 6/11, sc-shell-22): nothing on import, the waits from 3 s
 * doubling up to 30 s, what counts as an answer, and nothing told once it is stopped.
 *
 *   npm test
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const done = [];
const realFetch = globalThis.fetch;
const realTimeout = globalThis.setTimeout;
globalThis.fetch = async (...args) => { done.push('fetch()'); return realFetch(...args); };
globalThis.setTimeout = (...args) => { done.push('setTimeout()'); return realTimeout(...args); };
const { watchSignal, SIGNAL_FIRST_MS, SIGNAL_MAX_MS } = await import('../web/signal.js');
const onImport = [...done];
globalThis.fetch = realFetch;
globalThis.setTimeout = realTimeout;

/** Lets the promises of a question settle. */
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

/** A question the test answers: `answers` in turn, true (an answer) or an error (none). */
function server(answers) {
  const asked = [];
  const ask = async () => {
    asked.push(Date.now());
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { ask, asked };
}

test('importing signal.js asks nothing and schedules nothing', () => {
  assert.deepEqual(onImport, []);
  assert.deepEqual([SIGNAL_FIRST_MS, SIGNAL_MAX_MS], [3000, 30000]);
});

test('lost: asked after 3 s, then twice as long each time up to 30 s, and the first wait again once back', async (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.after(() => mock.timers.reset());
  const gone = new TypeError('Failed to fetch');
  const { ask, asked } = server([gone, gone, gone, gone, gone, gone, true, gone]);
  let backs = 0;
  const watch = watchSignal({ ask, onBack: () => { backs += 1; } });
  watch.lost();
  watch.lost();
  assert.equal(watch.watching, true);
  for (const wait of [3000, 6000, 12000, 24000, 30000, 30000, 30000]) {
    mock.timers.tick(wait - 1);
    await settle();
    const before = asked.length;
    mock.timers.tick(1);
    await settle();
    assert.equal(asked.length, before + 1, `asked again after ${wait} ms`);
  }
  assert.equal(backs, 1, 'told once, when the server answered');
  assert.equal(watch.watching, false, 'nothing more is asked once back');
  watch.lost();
  mock.timers.tick(3000);
  await settle();
  assert.equal(asked.length, 8, 'a new loss starts from the first wait');
});

test('answered: an HTTP error is a server that answers; without it a failed question is no signal', async () => {
  class Offline extends Error {}
  const backs = [];
  const http = watchSignal({ ask: async () => { throw new Error('500'); }, answered: (err) => !(err instanceof Offline), onBack: () => backs.push('http') });
  assert.equal(await http.check(), true);
  const none = watchSignal({ ask: async () => { throw new Offline(); }, answered: (err) => !(err instanceof Offline), onBack: () => backs.push('none') });
  assert.equal(await none.check(), false);
  none.stop();
  assert.deepEqual(backs, ['http']);
});

test('check: one question at a time, and an answer after stop() is told to nobody', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  let answer;
  let asked = 0;
  let backs = 0;
  const watch = watchSignal({ ask: () => { asked += 1; return new Promise((resolve, reject) => { answer = { resolve, reject }; }); }, onBack: () => { backs += 1; } });
  const first = watch.check();
  assert.equal(watch.check(), first, 'the question under way');
  assert.equal(asked, 1);
  watch.stop();
  answer.reject(new TypeError('Failed to fetch'));
  await first;
  await settle();
  mock.timers.tick(60000);
  await settle();
  assert.equal(asked, 1, 'nothing scheduled after stop()');
  const second = watch.check();
  answer.resolve(true);
  assert.equal(await second, true);
  assert.equal(backs, 1);
});

test('active and again: nothing asked off the page, nor again once the caller says it is back', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  let onPage = false;
  let offline = true;
  let asked = 0;
  const watch = watchSignal({ ask: async () => { asked += 1; throw new TypeError('Failed to fetch'); }, active: () => onPage, again: () => offline });
  watch.lost();
  assert.equal(watch.watching, false, 'off the page: nothing scheduled');
  assert.equal(await watch.check(), false);
  assert.equal(asked, 0);
  onPage = true;
  watch.lost();
  mock.timers.tick(3000);
  await settle();
  assert.equal(asked, 1);
  assert.equal(watch.watching, true, 'still offline: asked again later');
  offline = false;
  mock.timers.tick(6000);
  await settle();
  assert.equal(asked, 2);
  assert.equal(watch.watching, false, 'back by the caller: not asked again');
});

test('the default question: the app\'s /version, never a copy, with the patience given', async (t) => {
  const calls = [];
  const realFetchNow = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetchNow; });
  globalThis.fetch = async (url, options) => { calls.push([url, options]); return { ok: true, status: 200 }; };
  assert.equal(await watchSignal({ patienceMs: 8000 }).check(), true);
  assert.equal(await watchSignal({ url: '/version' }).check(), true);
  assert.equal(calls[0][0], '/version', 'at() of the kit: / in these tests');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.ok(calls[0][1].signal instanceof AbortSignal, 'a time limit');
  assert.equal(calls[1][1].signal, undefined, 'none unless asked for');
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await watchSignal().check(), false, 'no answer: no signal');
});

test('Settings\' connection asks through it: no signal noted, /version in 3 s, and back once it answers', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const realFetchNow = globalThis.fetch;
  t.after(() => { mock.timers.reset(); globalThis.fetch = realFetchNow; });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  const asked = [];
  let up = false;
  globalThis.fetch = async (url) => {
    asked.push(url);
    if (!up) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const { connection } = await import('../web/settings-queue.js');
  const told = [];
  connection.on((offline) => told.push(offline));
  connection.noted();
  assert.equal(connection.offline, true);
  mock.timers.tick(2999);
  await settle();
  assert.deepEqual(asked, []);
  mock.timers.tick(1);
  await settle();
  assert.deepEqual(asked, ['/version']);
  up = true;
  mock.timers.tick(6000);
  await settle();
  assert.equal(asked.filter((url) => url === '/version').length, 2);
  assert.equal(connection.offline, false);
  assert.deepEqual(told, [true, false]);
});
