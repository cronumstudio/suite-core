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
import { createLive, subscribeAll } from '../live.js';
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

test('a person keeps at most ten channels, and one that stops reading is closed', () => {
  const live = createLive();
  const tabs = Array.from({ length: 11 }, () => tab(7));
  for (const t of tabs) live.subscribe(t.req, t.res, t.user);
  assert.equal(tabs[0].res.ended, true, 'the eleventh closes the oldest');
  assert.ok(tabs.slice(1).every((t) => !t.res.ended), 'the other ten stay');
  const other = tab(8);
  live.subscribe(other.req, other.res, other.user);
  assert.equal(tabs[1].res.ended, false, 'someone else\'s channel counts for them, not for this person');
  // A reader that stopped: writes say "wait" and the backlog grows past 64 kB.
  const stuck = tab(9);
  live.subscribe(stuck.req, stuck.res, stuck.user);
  Object.assign(stuck.res, { write() { return false; }, writableLength: 70 * 1024 });
  live.publish({ data: { x: 1 } });
  assert.equal(stuck.res.ended, true);
  live.close();
});

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

test('dropUser closes a person’s tabs but the kept session’s, telling them first', () => {
  const live = createLive();
  const kept = tab(1);
  const other = tab(1);
  const someoneElse = tab(2);
  live.subscribe(kept.req, kept.res, kept.user, { sessionToken: 'kept' });
  live.subscribe(other.req, other.res, other.user, { sessionToken: 'other' });
  live.subscribe(someoneElse.req, someoneElse.res, someoneElse.user, { sessionToken: 'x' });
  assert.equal(live.dropUser(1, { except: 'kept', last: { event: 'account', data: { user_id: 1 } } }), 1);
  assert.equal(other.res.ended, true);
  assert.deepEqual(eventsOf(other.res).at(-1), { id: null, event: 'account', data: { user_id: 1 } });
  assert.equal(kept.res.ended, false);
  assert.equal(someoneElse.res.ended, false);
  assert.equal(live.dropUser(1), 1, 'without a kept one, all of them');
  assert.equal(kept.res.ended, true);
  assert.equal(live.connected(), 1);
});

test('a channel ends with its session: asked at every heartbeat, and at once by recheck()', async () => {
  const open = new Set(['ada-laptop', 'ada-phone', 'bob']);
  const live = createLive({ heartbeatMs: 20, stillIn: (userId, token) => open.has(token) });
  const laptop = tab(1);
  const phone = tab(1);
  const bob = tab(2);
  const sessionless = tab(1);
  live.subscribe(laptop.req, laptop.res, laptop.user, { sessionToken: 'ada-laptop' });
  live.subscribe(phone.req, phone.res, phone.user, { sessionToken: 'ada-phone' });
  live.subscribe(bob.req, bob.res, bob.user, { sessionToken: 'bob' });
  live.subscribe(sessionless.req, sessionless.res, sessionless.user);

  // Signed out on the laptop: recheck(ada) closes that tab alone, with the account's notice.
  open.delete('ada-laptop');
  assert.equal(live.recheck(1), 1);
  assert.equal(laptop.res.ended, true);
  assert.deepEqual(eventsOf(laptop.res).at(-1), { id: null, event: 'account', data: { user_id: 1 } });
  assert.equal(phone.res.ended, false);
  live.publish({ audience: [1], data: { list_id: 4 } });
  assert.equal(eventsOf(laptop.res).filter((e) => e.event === 'change').length, 0, 'nothing more reaches it');

  // A session that ends without anyone saying so (it expired, a device gone): the heartbeat finds it.
  open.delete('bob');
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  assert.equal(bob.res.ended, true);
  assert.equal(phone.res.ended, false);
  assert.equal(sessionless.res.ended, false, 'a channel opened without a session isn’t asked');
  live.close();
});

test('a channel ends with its session in the one channel for every module too', () => {
  const open = new Set(['kept', 'gone']);
  const stillIn = (userId, token) => open.has(token);
  const notes = createLive({ stillIn });
  const next = createLive({ stillIn });
  const kept = tab(3);
  const gone = tab(3);
  subscribeAll([['notes', notes], ['next', next]], kept.req, kept.res, kept.user, { sessionToken: 'kept' });
  subscribeAll([['notes', notes], ['next', next]], gone.req, gone.res, gone.user, { sessionToken: 'gone' });
  open.delete('gone');
  assert.equal(next.recheck(3), 1);
  assert.equal(gone.res.ended, true, 'one module that finds it gone ends the stream');
  assert.match(gone.res.text, /"module":"next","event":"account","data":\{"user_id":3\}/);
  assert.equal(notes.connected(), 1, 'every module lets go of it');
  assert.equal(kept.res.ended, false);
  notes.close();
  next.close();
});

test('signing out, a session closed from the list, out everywhere and a deleted account end their tabs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-live-'));
  const suite = createSuite({
    config: { app: { id: 'demo', name: 'Demo', languages: ['en'] }, modules: { live: true }, accounts: { minPasswordLength: 8 } },
    env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', SECURE_COOKIES: 'false', ADMIN_PASSWORD: 'root-password' },
    log: () => {}, exitOnError: false,
  });
  t.after(() => { suite.live.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ada = suite.accounts.create({ username: 'ada', password: 'ada-password' });
  const bob = suite.accounts.create({ username: 'bob', password: 'bob-password' });
  const browser = (user) => {
    const sessionToken = suite.sessions.open(user.id);
    const t = tab(user.id);
    suite.live.subscribe(t.req, t.res, t.user, { sessionToken });
    return { ...t, sessionToken };
  };
  const ended = (...tabs) => tabs.map((each) => each.res.ended);

  // Signing out (POST /api/auth/logout closes its session): that browser's tab, no other.
  const laptop = browser(ada);
  const phone = browser(ada);
  const tablet = browser(ada);
  const bobs = browser(bob);
  suite.sessions.close(laptop.sessionToken);
  assert.deepEqual(ended(laptop, phone, tablet, bobs), [true, false, false, false]);
  assert.deepEqual(eventsOf(laptop.res).at(-1), { id: null, event: 'account', data: { user_id: ada.id } });

  // One session closed from the list (DELETE /api/me/sessions/:key).
  const key = suite.sessions.list(ada.id, tablet.sessionToken).find((s) => !s.current).key;
  assert.equal(suite.sessions.revoke(ada.id, key), true);
  assert.deepEqual(ended(phone, tablet), [true, false]);

  // Out everywhere but here (a new password, revoke.js): every other tab of hers.
  const desktop = browser(ada);
  suite.revokeEverything(ada.id, { keep: { sessionToken: tablet.sessionToken }, reason: 'test' });
  assert.deepEqual(ended(tablet, desktop, bobs), [false, true, false]);

  // Her account disabled (asked to be deleted): all of them.
  suite.accounts.update(ada.id, { disabled: true });
  assert.deepEqual(ended(tablet, bobs), [true, false]);

  // An account deleted for good.
  suite.accounts.remove(bob.id);
  assert.equal(bobs.res.ended, true);
  assert.equal(suite.live.connected(), 0);
});

/** What one channel for every module told a tab, in order: { id, module, event, data }. */
const messagesOf = (res) => res.text.split('\n\n').filter((block) => /^data: /m.test(block)).map((block) => ({
  id: /^id: (.+)$/m.exec(block)?.[1] ?? null,
  ...JSON.parse(/^data: (.*)$/m.exec(block)[1]),
}));
const said = (res) => messagesOf(res).map(({ module, event, data }) => [module, event, data]);

test('one channel for every module: each one’s notices for this person, with its module, unnamed', () => {
  const notes = createLive();
  const next = createLive();
  const t = tab(1);
  subscribeAll([['notes', notes], ['next', next]], t.req, t.res, t.user, { sessionToken: 's' });
  assert.equal(t.res.status, 200);
  assert.match(t.res.head['Content-Type'], /^text\/event-stream/);
  assert.equal(t.res.head['X-Accel-Buffering'], 'no');
  assert.match(t.res.text, /^retry: 3000\n\n/);
  assert.deepEqual(said(t.res), [[null, 'hello', { user_id: 1 }]]);
  assert.match(messagesOf(t.res)[0].id, /^notes=[\w-]+\.0,next=[\w-]+\.0$/, 'where it is in each');
  assert.equal(notes.connected(), 1, 'a channel of the person’s in each module');
  assert.equal(next.connected(), 1);

  notes.publish({ audience: [1], data: { note: 5 } });
  notes.publish({ audience: [2], data: { note: 6 } });
  next.publish({ event: 'links', data: { ref: 'next:step:3' } });
  next.publish({ audience: [1], event: 'account', data: { user_id: 1 } });
  assert.deepEqual(said(t.res).slice(1), [
    ['notes', 'change', { note: 5 }], ['next', 'links', { ref: 'next:step:3' }], ['next', 'account', { user_id: 1 }],
  ], 'never someone else’s');
  assert.doesNotMatch(t.res.text, /^event: /m);
  const [, first, , last] = messagesOf(t.res);
  assert.match(first.id, /^notes=[\w-]+\.1,next=[\w-]+\.0$/);
  assert.match(last.id, /^notes=[\w-]+\.1,next=[\w-]+\.2$/, 'someone else’s notice moves nothing');

  t.req.emit('close');
  assert.equal(notes.connected(), 0, 'a closed tab lets go of every module');
  assert.equal(next.connected(), 0);
  assert.equal(t.res.ended, true);
});

test('one channel for every module coming back: what it missed in each, or resync for that one', () => {
  const notes = createLive();
  const next = createLive({ remember: 2 });
  const first = tab(1);
  subscribeAll([['notes', notes], ['next', next]], first.req, first.res, first.user);
  notes.publish({ audience: [1], data: { n: 1 } });
  const seen = messagesOf(first.res).at(-1).id;
  first.req.emit('close');

  notes.publish({ audience: [1], data: { n: 2 } });
  for (let n = 1; n <= 3; n += 1) next.publish({ audience: [1], data: { n } });
  const back = tab(1, { 'last-event-id': seen });
  subscribeAll([['notes', notes], ['next', next]], back.req, back.res, back.user);
  assert.deepEqual(said(back.res), [['notes', 'change', { n: 2 }], ['next', 'resync', {}], [null, 'hello', { user_id: 1 }]],
    'notes still remembers; next forgot too much');
  assert.match(messagesOf(back.res).at(-1).id, /^notes=[\w-]+\.2,next=[\w-]+\.3$/);

  // A module it had no place in (one added since), and nonsense.
  const added = tab(1, { 'last-event-id': seen.split(',')[0] });
  subscribeAll([['notes', notes], ['next', next]], added.req, added.res, added.user);
  assert.deepEqual(said(added.res).map(([module, event]) => [module, event]), [['notes', 'change'], ['next', 'resync'], [null, 'hello']]);
  const nonsense = tab(1, { 'last-event-id': 'garbage' });
  subscribeAll([['notes', notes], ['next', next]], nonsense.req, nonsense.res, nonsense.user);
  assert.deepEqual(said(nonsense.res).map(([module, event]) => [module, event]), [['notes', 'resync'], ['next', 'resync'], [null, 'hello']]);
  notes.close();
  next.close();
});

test('one channel for every module ends with any of them: revoked, closed, or not reading', () => {
  const notes = createLive();
  const next = createLive();
  const channels = [['notes', notes], ['next', next]];
  const kept = tab(1);
  const other = tab(1);
  subscribeAll(channels, kept.req, kept.res, kept.user, { sessionToken: 'kept' });
  subscribeAll(channels, other.req, other.res, other.user, { sessionToken: 'other' });
  assert.equal(notes.dropUser(1, { except: 'kept', last: { event: 'account', data: { user_id: 1 } } }), 1);
  assert.deepEqual(said(other.res).at(-1), ['notes', 'account', { user_id: 1 }], 'its last word, said');
  assert.equal(other.res.ended, true);
  assert.equal(next.connected(), 1, 'the other modules let go of it too');
  assert.equal(kept.res.ended, false, 'the session kept keeps its channel');

  // A reader that stopped reading: everything goes.
  Object.assign(kept.res, { write() { return false; }, writableLength: 70 * 1024 });
  next.publish({ audience: [1], data: {} });
  assert.equal(kept.res.ended, true);
  assert.equal(notes.connected() + next.connected(), 0);

  // A module closing (the host shutting down) ends it.
  const last = tab(2);
  subscribeAll(channels, last.req, last.res, last.user);
  next.close();
  assert.equal(last.res.ended, true);
  assert.equal(notes.connected(), 0);

  // A relay is one of the person's channels: eleven, and the oldest goes.
  const tabs = Array.from({ length: 10 }, () => tab(3));
  for (const each of tabs) notes.subscribe(each.req, each.res, each.user);
  const all = tab(3);
  subscribeAll([['notes', notes]], all.req, all.res, all.user);
  assert.equal(tabs[0].res.ended, true);
  assert.equal(all.res.ended, false);
  notes.close();
  assert.equal(all.res.ended, true);
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

test('over HTTP: an account that changes tells its own tabs (event: account), and only when it changes', async (t) => {
  const { suite, base } = await start(t, { live: true });
  const ada = suite.accounts.create({ username: 'ada', password: 'ada-password' });
  const bob = suite.accounts.create({ username: 'bob', password: 'bob-password' });
  const heard = [];
  suite.accounts.whenChanged((id) => heard.push(id));

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ada', password: 'ada-password' }),
  });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('demo_sid=')).split(';')[0];
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal });
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

  suite.accounts.update(bob.id, { displayName: 'Robert' });      // someone else's
  suite.accounts.update(ada.id, { displayName: 'ada' });         // nothing really changes
  suite.accounts.update(ada.id, { email: 'ada@example.com' });
  await until(/event: account/);
  assert.match(text, new RegExp(`event: account\ndata: \{"user_id":${ada.id}\}`));
  assert.deepEqual(heard, [bob.id, ada.id], 'an update that changes nothing says nothing');

  // A new password and the second step say so too. The password is set from this tab, whose
  // session stays: the others' channels close (revoke.js), this one keeps hearing.
  const sessionToken = decodeURIComponent(cookie.slice('demo_sid='.length));
  suite.accounts.setPassword(ada.id, 'a-brand-new-one', { exceptToken: sessionToken });
  const { secret } = suite.twoFactor.begin(ada);
  assert.deepEqual(heard, [bob.id, ada.id, ada.id], 'starting the setup changes nothing yet');
  const { totp, base32Decode } = await import('../two-factor.js');
  suite.twoFactor.enable(ada.id, totp(base32Decode(secret), Math.floor(Date.now() / 30000)));
  suite.twoFactor.disable(ada.id);
  assert.deepEqual(heard, [bob.id, ada.id, ada.id, ada.id, ada.id]);
  await until(/(event: account[\s\S]*){4}/);
  assert.equal((text.match(/event: account/g) || []).length, 4, 'every one reaches the tab, none of Bob’s');
  controller.abort();
});
