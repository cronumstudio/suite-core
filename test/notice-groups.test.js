/**
 * Notices grouped by key for a few seconds (notice-groups.js): one notice for what piled up once
 * the key has been quiet for the delay, sent at once by a flush, and a failed one reported without
 * an unhandled rejection. The clock is node:test's, so nothing here waits for real.
 *
 *   npm test (node --test test/notice-groups.test.js for this alone)
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createNoticeGroups, NOTICE_DELAY_MS } from '../notice-groups.js';

/** A change counted into what piled up under its key. */
const count = (title) => (value = { n: 0, titles: [] }) => ({ n: value.n + 1, titles: [...value.titles, title] });

/** What a send started by a timer did: its promise settles in the next turns. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

function groups(options = {}) {
  const sent = [];
  const notices = createNoticeGroups({ send: (value, key) => { sent.push({ key, ...value }); }, ...options });
  return { notices, sent };
}

test('a key\'s notice goes once nothing new came for the delay, with everything of the meantime', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { notices, sent } = groups({ delayMs: 1000 });
  notices.add('list-1', count('Bread'));
  t.mock.timers.tick(600);
  notices.add('list-1', count('Milk'));
  t.mock.timers.tick(999);
  await settled();
  assert.deepEqual(sent, [], 'each change starts the wait again');
  assert.equal(notices.size, 1);
  t.mock.timers.tick(1);
  await settled();
  assert.deepEqual(sent, [{ key: 'list-1', n: 2, titles: ['Bread', 'Milk'] }]);
  assert.equal(notices.size, 0);
  t.mock.timers.tick(5000);
  await settled();
  assert.equal(sent.length, 1, 'once');
});

test('each key is a notice of its own, and a change after one went starts a new one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { notices, sent } = groups({ delayMs: 1000 });
  notices.add('a', count('one'));
  notices.add('b', count('two'));
  notices.add('a', count('three'));
  t.mock.timers.tick(1000);
  await settled();
  const byKey = (a, b) => a.key.localeCompare(b.key);
  assert.deepEqual(sent.sort(byKey), [{ key: 'a', n: 2, titles: ['one', 'three'] }, { key: 'b', n: 1, titles: ['two'] }]);
  notices.add('a', count('four'));
  t.mock.timers.tick(1000);
  await settled();
  assert.deepEqual(sent.at(-1), { key: 'a', n: 1, titles: ['four'] });
});

test('the delay is 25 seconds unless the module says', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(NOTICE_DELAY_MS, 25_000);
  const { notices, sent } = groups();
  notices.add('k', count('x'));
  t.mock.timers.tick(24_999);
  await settled();
  assert.equal(sent.length, 0);
  t.mock.timers.tick(1);
  await settled();
  assert.equal(sent.length, 1);
});

test('merge gets what piled up and its answer is what is kept; one that throws leaves the group as it was', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { notices, sent } = groups({ delayMs: 1000 });
  const seen = [];
  assert.deepEqual(notices.add('k', (value) => { seen.push(value); return { n: 1 }; }), { n: 1 });
  notices.add('k', (value) => { seen.push(value); return { n: value.n + 1 }; });
  assert.deepEqual(seen, [undefined, { n: 1 }]);
  t.mock.timers.tick(600);
  assert.throws(() => notices.add('k', () => { throw new Error('no'); }), /no/);
  t.mock.timers.tick(400);
  await settled();
  assert.deepEqual(sent, [{ key: 'k', n: 2 }], 'still on its first wait, with what it had');
});

test('flush sends a key now and flushAll every key, each once, and their waits are over', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { notices, sent } = groups({ delayMs: 1000 });
  notices.add('a', count('one'));
  notices.add('b', count('two'));
  notices.add('c', count('three'));
  await notices.flush('a');
  assert.deepEqual(sent.map((s) => s.key), ['a']);
  await notices.flush('a');
  await notices.flush('nothing');
  assert.equal(sent.length, 1, 'nothing left under it');
  await notices.flushAll();
  assert.deepEqual(sent.map((s) => s.key), ['a', 'b', 'c']);
  assert.equal(notices.size, 0);
  t.mock.timers.tick(5000);
  await settled();
  assert.equal(sent.length, 3, 'a flushed group does not go again when its wait would have ended');
  await notices.flushAll();
  assert.equal(sent.length, 3, 'with nothing waiting, nothing');
});

test('flushAll waits for every send, and its promise is the one that fails', async () => {
  const done = [];
  const notices = createNoticeGroups({
    delayMs: 1000,
    send: async (value, key) => {
      await settled();
      if (key === 'bad') throw new Error('down');
      done.push(key);
    },
  });
  notices.add('a', count('one'));
  notices.add('b', count('two'));
  await notices.flushAll();
  assert.deepEqual(done.sort(), ['a', 'b']);
  notices.add('bad', count('three'));
  await assert.rejects(notices.flushAll(), /down/);
});

test('a change while its group is being sent starts the next group', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const sent = [];
  const notices = createNoticeGroups({
    delayMs: 1000,
    send: async (value) => { sent.push(value.titles); await new Promise((resolve) => { release = resolve; }); },
  });
  notices.add('k', count('one'));
  const going = notices.flush('k');
  notices.add('k', count('two'));
  assert.equal(notices.size, 1);
  release();
  await going;
  t.mock.timers.tick(1000);
  await settled();
  assert.deepEqual(sent, [['one'], ['two']]);
});

test('a send the wait started that fails goes to failed, with its key, and to the log when the module says nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const reported = [];
  const told = createNoticeGroups({ delayMs: 10, send: () => Promise.reject(new Error('push down')), failed: (err, key) => reported.push([err.message, key]) });
  told.add('k', count('x'));
  t.mock.timers.tick(10);
  await settled();
  assert.deepEqual(reported, [['push down', 'k']]);

  const logged = mock.method(console, 'error', () => {});
  t.after(() => logged.mock.restore());
  const quiet = createNoticeGroups({ delayMs: 10, send: () => { throw new Error('no database'); } });
  quiet.add('k', count('x'));
  t.mock.timers.tick(10);
  await settled();
  assert.deepEqual(logged.mock.calls.map((c) => c.arguments), [['[notices] no database']]);

  const careless = createNoticeGroups({ delayMs: 10, send: () => Promise.reject(new Error('x')), failed: () => { throw new Error('y'); } });
  careless.add('k', count('x'));
  t.mock.timers.tick(10);
  await settled();
  await settled();
  assert.deepEqual(unhandled, [], 'no failure becomes an unhandled rejection');
});

test('without send it says so at once', () => {
  assert.throws(() => createNoticeGroups({}), /send is required/);
  assert.throws(() => createNoticeGroups(), /send is required/);
});
