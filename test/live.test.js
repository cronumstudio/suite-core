/**
 * The live channel (live.js): who gets each notice, the ids, what a tab that
 * comes back gets, and the route createApp serves with `modules.live`.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLive } from '../live.js';
import { createSuite, createApp } from '../app.js';

/** A tab: the request (its headers, and it can close) and what the server wrote to it. */
function tab(userId, headers = {}) {
  const req = Object.assign(new EventEmitter(), { headers });
  const res = {
    text: '', head: null, ended: false,
    writeHead(status, head) { this.status = status; this.head = head; },
    write(chunk) {
      if (this.broken) throw new Error('socket gone');
      this.text += chunk;
    },
    end() { this.ended = true; },
    setTimeout() {},
  };
  return { req, res, user: { id: userId } };
}
/** The events a tab received, in order: { id, event, data }. */
const eventsOf = (res) => res.text.split('\n\n').filter((block) => /^(id|event):/m.test(block)).map((block) => ({
  id: /^id: (.+)$/m.exec(block)?.[1] ?? null,
  event: /^event: (.+)$/m.exec(block)?.[1],
  data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] || 'null'),
}));

test('a tab opens with the stream headers, retry and hello', () => {
  const live = createLive();
  const t = tab(7);
  live.subscribe(t.req, t.res, t.user);
  assert.equal(t.res.status, 200);
  assert.match(t.res.head['Content-Type'], /^text\/event-stream/);
  assert.equal(t.res.head['X-Accel-Buffering'], 'no', 'or the reverse proxy holds everything');
  assert.match(t.res.text, /^retry: 3000\n\n/);
  assert.deepEqual(eventsOf(t.res), [{ id: null, event: 'hello', data: { user_id: 7 } }]);
  assert.equal(live.connected(), 1);
  t.req.emit('close');
  assert.equal(live.connected(), 0);
  assert.equal(t.res.ended, true);
  live.close();
});

test('each notice reaches its audience, with an id', () => {
  const live = createLive();
  const ada = tab(1);
  const bob = tab(2);
  live.subscribe(ada.req, ada.res, ada.user);
  live.subscribe(bob.req, bob.res, bob.user);
  live.publish({ audience: [1], data: { project_id: 4 } });
  live.publish({ audience: new Set([2]), data: { list_id: 9 } });
  live.publish({ data: { all: true } });
  live.publish({ audience: ['1', 2], event: 'moved', data: { n: 1 } });

  const forAda = eventsOf(ada.res).filter((e) => e.event !== 'hello');
  assert.deepEqual(forAda.map((e) => [e.event, e.data]), [['change', { project_id: 4 }], ['change', { all: true }], ['moved', { n: 1 }]]);
  assert.deepEqual(eventsOf(bob.res).filter((e) => e.event !== 'hello').map((e) => e.data), [{ list_id: 9 }, { all: true }, { n: 1 }]);
  const ids = forAda.map((e) => e.id);
  assert.match(ids[0], /^[\w-]+\.1$/);
  assert.equal(ids[1].split('.')[0], ids[0].split('.')[0], 'the same run');
  assert.deepEqual(ids.map((id) => Number(id.split('.')[1])), [1, 3, 4], 'numbered in order, across audiences');
  live.close();
});

test('a tab that comes back gets what it missed, or resync when that is not possible', () => {
  const live = createLive({ remember: 3 });
  const first = tab(1);
  live.subscribe(first.req, first.res, first.user);
  live.publish({ audience: [1], data: { n: 1 } });
  const lastSeen = eventsOf(first.res).at(-1).id;
  first.req.emit('close');

  live.publish({ audience: [1], data: { n: 2 } });
  live.publish({ audience: [2], data: { n: 3 } });   // someone else's
  const back = tab(1, { 'last-event-id': lastSeen });
  live.subscribe(back.req, back.res, back.user);
  assert.deepEqual(eventsOf(back.res).map((e) => [e.event, e.data]), [['change', { n: 2 }], ['hello', { user_id: 1 }]],
    'what was missed first, then hello; never someone else’s');

  // Up to date: nothing to replay and no resync.
  const current = tab(1, { 'last-event-id': eventsOf(back.res)[0].id.replace(/\.\d+$/, '.3') });
  live.subscribe(current.req, current.res, current.user);
  assert.deepEqual(eventsOf(current.res).map((e) => e.event), ['hello']);

  // Too much missed: only the last three are remembered.
  for (let n = 4; n <= 8; n++) live.publish({ audience: [1], data: { n } });
  const late = tab(1, { 'last-event-id': lastSeen });
  live.subscribe(late.req, late.res, late.user);
  assert.deepEqual(eventsOf(late.res).map((e) => e.event), ['resync', 'hello']);

  // Another run of the server, or an id from the future, or nonsense.
  const [boot] = lastSeen.split('.');
  for (const id of ['other.1', `${boot}.99`, `${boot}.x`, 'nonsense']) {
    const t = tab(1, { 'last-event-id': id });
    live.subscribe(t.req, t.res, t.user);
    assert.deepEqual(eventsOf(t.res).map((e) => e.event), ['resync', 'hello'], id);
  }
  assert.notEqual(createLive().publish, live.publish);
  live.close();
});

test('a tab whose socket is gone is dropped; close() ends them all', () => {
  const live = createLive();
  const gone = tab(1);
  const fine = tab(1);
  live.subscribe(gone.req, gone.res, gone.user);
  live.subscribe(fine.req, fine.res, fine.user);
  gone.res.broken = true;
  live.publish({ audience: [1], data: {} });
  assert.equal(live.connected(), 1);
  assert.equal(gone.res.ended, true);
  live.close();
  assert.equal(live.connected(), 0);
  assert.equal(fine.res.ended, true);
});

async function start(t, modules) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-live-'));
  const suite = createSuite({
    config: { app: { id: 'demo', name: 'Demo', languages: ['en'] }, modules, accounts: { minPasswordLength: 8 } },
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', SECURE_COOKIES: 'false', ADMIN_PASSWORD: 'root-password' },
    log: () => {}, exitOnError: false,
  });
  const app = createApp({ suite, handleSignals: false, log: () => {} });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { suite, base: `http://127.0.0.1:${server.address().port}` };
}

test('over HTTP: /api/events with modules.live, for whoever is signed in', async (t) => {
  const { suite, base } = await start(t, { live: true });
  assert.equal((await fetch(`${base}/api/events`)).status, 401, 'nobody signed in, no channel');

  suite.accounts.create({ username: 'ada', password: 'ada-password' });
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ada', password: 'ada-password' }),
  });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('demo_sid=')).split(';')[0];
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const until = async (pattern) => {
    while (!pattern.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  };
  await until(/event: hello/);
  assert.equal(suite.live.connected(), 1);
  suite.live.publish({ audience: [suite.accounts.byUsername('ada').id], data: { project_id: 3 } });
  await until(/event: change/);
  assert.match(text, /id: [\w-]+\.1\nevent: change\ndata: \{"project_id":3\}/);
  controller.abort();
});

test('over HTTP: without modules.live the app keeps /api/events for itself', async (t) => {
  const { base } = await start(t, {});
  assert.equal((await fetch(`${base}/api/events`)).status, 404);
});
