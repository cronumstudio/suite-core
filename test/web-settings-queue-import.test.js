/**
 * settings-queue.js does nothing on import (Cronum Work's rule: a module acts at its mount, never
 * when it is imported): no listener, timer or fetch until `connection` is first used, and then
 * the browser's `online`/`offline`, once, starting from what `navigator.onLine` says by then.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const added = [];
const done = [];
globalThis.addEventListener = (type) => { added.push(type); };
const realFetch = globalThis.fetch;
const realTimeout = globalThis.setTimeout;
const realInterval = globalThis.setInterval;
globalThis.fetch = async (...args) => { done.push('fetch()'); return realFetch(...args); };
globalThis.setTimeout = (...args) => { done.push('setTimeout()'); return realTimeout(...args); };
globalThis.setInterval = (...args) => { done.push('setInterval()'); return realInterval(...args); };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });

const { connection } = await import('../web/settings-queue.js');
const onImport = [...added, ...done];
globalThis.fetch = realFetch;
globalThis.setTimeout = realTimeout;
globalThis.setInterval = realInterval;

test('importing settings-queue.js adds no listener, timer or fetch', () => {
  assert.deepEqual(onImport, []);
});

test('connection.on() starts listening, once, from what the browser says then', () => {
  globalThis.navigator.onLine = false;
  const stop = connection.on(() => {});
  assert.deepEqual(added, ['online', 'offline']);
  assert.equal(connection.offline, true, 'navigator.onLine read again on first use');
  connection.on(() => {})();
  stop();
  assert.deepEqual(added, ['online', 'offline'], 'not twice');
});
