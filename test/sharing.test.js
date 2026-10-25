/**
 * Sharing (sharing.js) and its brake (share-brake.js), on a database in memory:
 * offers by email, id and username, the same answer for an address with an
 * account and one without, the brake on offers and on notices, push or email,
 * accepting, leaving, one's people, what waits, and the routes.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { createSharing } from '../sharing.js';
import { createShareBrake, OFFERS_PER_HOUR } from '../share-brake.js';
import { createRouter, HttpError, notFound, forbidden } from '../http.js';

function setup({ brake = createShareBrake(), notify, hasPush, byUsername = false, codes } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, display_name TEXT, email TEXT);
    CREATE TABLE boards (id INTEGER PRIMARY KEY, owner_id INTEGER, name TEXT);
    CREATE TABLE board_shares (board_id INTEGER, user_id INTEGER, permission TEXT NOT NULL DEFAULT 'edit',
      accepted INTEGER NOT NULL DEFAULT 0, invited_by INTEGER, created_at TEXT, UNIQUE (board_id, user_id));
    -- Like Tasks' list_shares: no invited_by, created_at by the column's default.
    CREATE TABLE lists (id INTEGER PRIMARY KEY, owner_id INTEGER, name TEXT);
    CREATE TABLE list_shares (id INTEGER PRIMARY KEY, list_id INTEGER, user_id INTEGER, permission TEXT NOT NULL DEFAULT 'edit',
      accepted INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (list_id, user_id));
  `);
  const people = [[1, 'ana', 'Ana', 'ana@example.com'], [2, 'ben', 'Ben', 'ben@example.com'], [3, 'cris', 'Cris', 'cris@example.com'], [4, 'dani', 'Dani', null]];
  for (const p of people) database.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(...p);
  database.prepare("INSERT INTO boards VALUES (10, 1, 'Plans'), (11, 1, 'Ideas'), (20, 2, 'Ben''s')").run();
  database.prepare("INSERT INTO lists VALUES (30, 1, 'Shopping')").run();
  const db = {
    get: (sql, ...params) => database.prepare(sql).get(...params),
    all: (sql, ...params) => database.prepare(sql).all(...params),
    run: (sql, ...params) => database.prepare(sql).run(...params),
  };
  const events = [];
  const ownBoard = (table) => (userId, id) => {
    const row = db.get(`SELECT * FROM ${table} WHERE id = ?`, Number(id));
    if (!row) throw notFound();
    if (row.owner_id !== userId) throw forbidden('owner_only');
    return row;
  };
  const kind = (table, sharesTable, key, extra = {}) => ({
    table: sharesTable, key,
    owner: { join: `JOIN ${table} t ON t.id = s.${key}`, column: 't.owner_id' },
    own: ownBoard(table),
    read(userId, id) {
      const thing = db.get(`SELECT * FROM ${table} WHERE id = ?`, Number(id));
      if (!thing) throw notFound();
      if (thing.owner_id === userId) return { thing, role: 'owner', ownerId: thing.owner_id };
      const share = db.get(`SELECT * FROM ${sharesTable} WHERE ${key} = ? AND user_id = ? AND accepted = 1`, thing.id, userId);
      if (!share) throw notFound();
      return { thing, role: share.permission, ownerId: thing.owner_id };
    },
    leaving(userId, id, targetId) {
      const thing = db.get(`SELECT * FROM ${table} WHERE id = ?`, Number(id));
      if (!thing) throw notFound();
      if (targetId !== userId && thing.owner_id !== userId) throw notFound();
      return { thing, ownerId: thing.owner_id };
    },
    pending(userId, id) {
      const thing = db.get(`SELECT * FROM ${table} WHERE id = ?`, Number(id));
      if (!thing) throw notFound('no_pending_invitation');
      return thing;
    },
    offered: (info) => events.push(['offered', info.targetId, info.permission, info.invited]),
    removed: (info) => events.push(['removed', info.targetId]),
    ...extra,
  });
  const notices = [];
  const sharing = createSharing({
    db, brake, byUsername, codes, hasPush,
    clock: () => '2026-10-25T10:00:00.000Z',
    notify: notify ?? {
      push: (n) => notices.push(['push', n.kind, n.name, n.actorId, n.targetId, n.permission]),
      email: (n) => notices.push(['email', n.kind, n.name, n.actorId, n.targetId, n.permission]),
    },
    kinds: {
      board: kind('boards', 'board_shares', 'board_id', {
        path: '/api/boards/:id',
        invitation: {
          select: 'b.id, b.name', join: 'JOIN boards b ON b.id = s.board_id', owner: 'b.owner_id',
          shape: (row) => ({ board: { id: row.id, name: row.name } }),
        },
      }),
      list: kind('lists', 'list_shares', 'list_id', {
        offering: (userId, thing) => { if (thing.name === 'Inbox') throw new HttpError(400, 'inbox_not_shared'); },
        invitedBy: null, stamp: false, strictRemove: false,
        path: '/api/lists/:id', routes: { segment: 'share', list: false, patch: false },
        answer: ({ target, thing }) => (target.email ? { invited: true } : { id: thing.id, shared: true }),
      }),
    },
  });
  return { database, db, sharing, notices, events };
}

const codeOf = (fn) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpError) return `${err.status} ${err.code}`;
    throw err;
  }
  return 'ok';
};

test('an offer by email: waiting, told once, the same answer as an address without an account', () => {
  const { db, sharing, notices, events } = setup();
  const known = sharing.share('board', 1, 10, { email: 'Ben@Example.com', permission: 'view' });
  assert.deepEqual(known, {
    share: { user: { id: null, name: 'ben@example.com', email: 'ben@example.com' }, permission: 'view', accepted: false, created_at: '2026-10-25T10:00:00.000Z' },
    invited: true,
  });
  const unknown = sharing.share('board', 1, 10, { email: 'nobody@example.com', permission: 'view' });
  assert.deepEqual(unknown, { ...known, share: { ...known.share, user: { id: null, name: 'nobody@example.com', email: 'nobody@example.com' } } });
  const row = db.get('SELECT * FROM board_shares WHERE board_id = 10 AND user_id = 2');
  assert.equal(row.accepted, 0);
  assert.equal(row.invited_by, 1);
  assert.equal(row.permission, 'view');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM board_shares').n, 1, 'nothing for the address without an account');
  assert.deepEqual(notices, [['email', 'board', 'Plans', 1, 2, 'view']]);
  assert.deepEqual(events, [['offered', 2, 'view', true]]);

  const again = sharing.share('board', 1, 10, { email: 'ben@example.com', permission: 'edit' });
  assert.equal(again.invited, false, 'offered again: not new');
  assert.equal(notices.length, 1, 'nobody is told again');
  assert.equal(db.get('SELECT permission FROM board_shares WHERE user_id = 2').permission, 'edit');

  assert.equal(codeOf(() => sharing.share('board', 1, 10, { email: 'ana@example.com' })), '400 share_with_self');
  assert.equal(codeOf(() => sharing.share('board', 2, 10, { email: 'cris@example.com' })), '403 owner_only');
  assert.equal(codeOf(() => sharing.share('board', 1, 10, { email: 'cris@example.com', permission: 'owner' })), '400 field_invalid');
  assert.equal(codeOf(() => sharing.share('board', 1, 10, {})), '400 field_required');
});

test('what they accepted stays accepted when only the permission changes', () => {
  const { db, sharing } = setup();
  sharing.share('board', 1, 10, { email: 'ben@example.com' });
  sharing.accept('board', 2, 10);
  sharing.share('board', 1, 10, { email: 'ben@example.com', permission: 'view' });
  const row = db.get('SELECT * FROM board_shares WHERE user_id = 2');
  assert.equal(row.accepted, 1);
  assert.equal(row.permission, 'view');
  const answer = sharing.share('board', 1, 10, { email: 'ben@example.com', permission: 'edit' });
  assert.equal(answer.share.accepted, true);
  assert.equal(answer.invited, false);
});

test('by id only one of one\'s people, answering as an id nobody has; by username only with the directory open', () => {
  const { sharing } = setup();
  assert.equal(codeOf(() => sharing.share('board', 1, 10, { user_id: 3 })), '404 email_not_found');
  assert.equal(codeOf(() => sharing.share('board', 1, 10, { user_id: 999 })), '404 email_not_found');
  sharing.share('board', 1, 10, { email: 'cris@example.com' });
  const byId = sharing.share('board', 1, 11, { user_id: 3, permission: 'view' });
  assert.equal(byId.invited, true);
  assert.deepEqual(byId.share.user, { id: 3, name: 'cris@example.com', email: 'cris@example.com' }, 'still pending: the address it went to');
  assert.equal(codeOf(() => sharing.share('board', 1, 10, { username: 'ben' })), '400 field_required', 'no username here');

  const open = setup({ byUsername: true, codes: { unknown: 'user_not_found' } }).sharing;
  assert.equal(open.share('board', 1, 10, { username: 'ben' }).invited, true);
  assert.equal(codeOf(() => open.share('board', 1, 10, { username: 'nobody' })), '404 user_not_found');
  assert.equal(codeOf(() => open.share('board', 1, 10, { username: 'ana' })), '400 share_with_self');
  assert.equal(codeOf(() => open.share('board', 1, 10, { user_id: 3 })), '404 user_not_found', 'an id is still only one of one\'s people');

  const closed = setup({ codes: { noTarget: 'share_email_required' } }).sharing;
  assert.equal(codeOf(() => closed.share('board', 1, 10, { username: 'ben' })), '400 share_email_required');
});

test('the brake: new offers and unknown addresses count, then 429; one notice per pair a day', () => {
  let now = 0;
  const brake = createShareBrake({ clock: () => now, offersPerHour: 3 });
  const { db, sharing, notices } = setup({ brake });
  sharing.share('board', 1, 10, { email: 'ben@example.com' });
  sharing.share('board', 1, 10, { email: 'ben@example.com', permission: 'view' });
  sharing.share('board', 1, 10, { email: 'nobody@example.com' });
  sharing.share('board', 1, 11, { email: 'cris@example.com' });
  assert.equal(codeOf(() => sharing.share('board', 1, 11, { email: 'other@example.com' })), '429 share_limit');
  assert.equal(codeOf(() => sharing.share('board', 1, 11, { user_id: 2 })), '429 share_limit', 'a new offer to a known person too');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM board_shares WHERE board_id = 11').n, 1, 'a refused offer creates nothing');
  assert.equal(sharing.share('board', 1, 10, { email: 'ben@example.com', permission: 'edit' }).invited, false, 'a change of permission is not held back');
  now += 61 * 60 * 1000;
  // Taken back and offered again: a new offer, but the pair was told within the day.
  sharing.remove('board', 1, 10, 2);
  assert.equal(sharing.share('board', 1, 10, { email: 'ben@example.com' }).invited, true);
  assert.deepEqual(notices.map((n) => n[4]), [2, 3]);
  now += 24 * 60 * 60 * 1000;
  sharing.remove('board', 1, 10, 2);
  sharing.share('board', 1, 10, { email: 'ben@example.com' });
  assert.deepEqual(notices.map((n) => n[4]), [2, 3, 2], 'a day later, once more');

  let at = 0;
  const own = createShareBrake({ clock: () => at });
  for (let i = 0; i < OFFERS_PER_HOUR; i++) assert.equal(own.offer(7).allowed, true);
  const refused = own.offer(7);
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfter > 0 && refused.retryAfter <= 3600);
  assert.equal(own.offer(8).allowed, true, 'others are not held back');
  at += 60 * 60 * 1000;
  assert.equal(own.offer(7).allowed, true);
  assert.equal(own.notice(1, 2), true);
  assert.equal(own.notice(1, 2), false);
  assert.equal(own.notice(2, 1), true, 'either way round');
});

test('the notice goes by push to whoever has a device that takes it, else by email', () => {
  const { sharing, notices } = setup({ hasPush: (userId) => userId === 3 });
  sharing.share('board', 1, 10, { email: 'ben@example.com' });
  sharing.share('board', 1, 10, { email: 'cris@example.com', permission: 'view' });
  assert.deepEqual(notices.map((n) => n[0] + n[4]), ['email2', 'push3']);

  const fromPush = setup({ hasPush: undefined });
  const pushService = { subscriptionsOf: (ids) => (ids[0] === 2 ? [{ endpoint: 'x' }] : []) };
  const told = [];
  const s = createSharing({
    db: fromPush.db, push: pushService, kinds: { board: { table: 'board_shares', key: 'board_id', own: (u, id) => ({ id, name: 'X' }) } },
    notify: { push: (n) => told.push(`push${n.targetId}`), email: (n) => told.push(`email${n.targetId}`) },
  });
  s.share('board', 1, 10, { email: 'ben@example.com' });
  s.share('board', 1, 10, { email: 'cris@example.com' });
  assert.deepEqual(told, ['push2', 'email3']);

  const failing = setup({ notify: async () => { throw new Error('down'); } });
  assert.equal(failing.sharing.share('board', 1, 10, { email: 'ben@example.com' }).invited, true, 'a notice that fails fails nothing else');
});

test('accepting is only one\'s own; leaving and taking back', () => {
  const { db, sharing, events } = setup();
  sharing.share('board', 1, 10, { email: 'ben@example.com' });
  assert.equal(codeOf(() => sharing.accept('board', 3, 10)), '404 no_pending_invitation');
  assert.deepEqual({ ...sharing.accept('board', 2, 10) }, { id: 10, owner_id: 1, name: 'Plans' });
  assert.equal(codeOf(() => sharing.accept('board', 2, 10)), '404 no_pending_invitation', 'once');
  assert.equal(codeOf(() => sharing.remove('board', 3, 10, 2)), '404 not_found', 'nobody else takes it away');
  assert.equal(codeOf(() => sharing.remove('board', 1, 10, 3)), '404 not_found', 'a share that isn\'t there');
  sharing.remove('board', 2, 10, 2);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM board_shares').n, 0);
  assert.deepEqual(events.at(-1), ['removed', 2]);

  // A kind with strictRemove: false answers as if it went.
  sharing.remove('list', 1, 30, 3);
  assert.deepEqual(events.at(-1), ['removed', 3]);
});

test('a kind without invited_by and with created_at by default; its own answers', () => {
  const { db, sharing } = setup();
  assert.deepEqual(sharing.share('list', 1, 30, { email: 'ben@example.com' }), { invited: true });
  assert.deepEqual(sharing.share('list', 1, 30, { email: 'nobody@example.com' }), { invited: true });
  const row = db.get('SELECT * FROM list_shares WHERE user_id = 2');
  assert.equal(row.accepted, 0, 'born waiting, though the column says 1');
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'the column\'s own date');
  assert.deepEqual(sharing.share('list', 1, 30, { user_id: 2, permission: 'view' }), { id: 30, shared: true });
  db.run("UPDATE lists SET name = 'Inbox' WHERE id = 30");
  assert.equal(codeOf(() => sharing.share('list', 1, 30, { email: 'nobody@example.com' })), '400 inbox_not_shared', 'before anyone is looked for');
});

test('who has it, and one\'s people of every kind', () => {
  const { sharing } = setup();
  sharing.share('board', 1, 10, { email: 'ben@example.com' });
  sharing.share('list', 1, 30, { email: 'cris@example.com' });
  sharing.accept('board', 2, 10);
  sharing.share('board', 1, 10, { email: 'cris@example.com', permission: 'view' });
  const owner = sharing.list('board', 1, 10);
  assert.equal(owner.role, 'owner');
  assert.deepEqual(owner.owner, { id: 1, name: 'Ana' });
  assert.deepEqual(owner.shares.map((s) => [s.user.name, s.user.email, s.accepted]), [['Ben', 'ben@example.com', true], ['cris@example.com', 'cris@example.com', false]]);
  const guest = sharing.list('board', 2, 10);
  assert.deepEqual(guest.shares.map((s) => s.user), [{ id: 2, name: 'Ben' }], 'no emails, nothing unanswered');
  assert.deepEqual(sharing.peopleOf(1), [{ id: 2, name: 'Ben', email: 'ben@example.com' }, { id: 3, name: 'Cris', email: 'cris@example.com' }]);
  assert.deepEqual(sharing.peopleOf(2), [{ id: 1, name: 'Ana' }]);
  assert.deepEqual(sharing.peopleOf(4), []);
  assert.deepEqual(sharing.setPermission('board', 1, 10, 2, 'view').permission, 'view');
  assert.equal(codeOf(() => sharing.setPermission('board', 1, 10, 4, 'view')), '404 not_found');
});

test('what waits for someone, newest first, of the kinds that say how', () => {
  const { db, sharing } = setup();
  sharing.share('board', 1, 10, { email: 'cris@example.com' });
  sharing.share('board', 2, 20, { email: 'cris@example.com', permission: 'view' });
  db.run("UPDATE board_shares SET created_at = '2026-10-26T00:00:00.000Z' WHERE board_id = 20");
  assert.deepEqual(sharing.pending(3), [
    { kind: 'board', board: { id: 20, name: 'Ben\'s' }, owner: { id: 2, name: 'Ben' }, permission: 'view', created_at: '2026-10-26T00:00:00.000Z' },
    { kind: 'board', board: { id: 10, name: 'Plans' }, owner: { id: 1, name: 'Ana' }, permission: 'edit', created_at: '2026-10-25T10:00:00.000Z' },
  ]);
});

/** A request through the routes as the app's server would make it. */
async function call(router, method, url, { user, body } = {}) {
  const found = router.match(method, url);
  if (!found?.handler) return { status: 404 };
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.headers = raw ? { 'content-type': 'application/json' } : {};
  let status = 0;
  let text = '';
  const res = { writeHead: (s) => { status = s; }, end: (b) => { text = b; } };
  try {
    await found.handler({ req, res, params: found.params, user });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { status: err.status, data: { error: err.code } };
  }
  return { status, data: text ? JSON.parse(text) : null };
}

test('the routes keep each kind\'s paths and answers', async () => {
  const { sharing } = setup();
  const router = createRouter();
  const user = (ctx) => {
    if (!ctx.user) throw new HttpError(401, 'unauthorized');
    return ctx.user;
  };
  const id = (ctx, name) => Number(ctx.params[name]);
  sharing.routes(router, { user, id, people: '/api/sharing/people' });
  const ana = { id: 1 };
  const ben = { id: 2 };
  const offered = await call(router, 'POST', '/api/boards/10/shares', { user: ana, body: { email: 'ben@example.com', permission: 'view' } });
  assert.equal(offered.status, 200);
  assert.equal(offered.data.invited, true);
  assert.equal((await call(router, 'GET', '/api/boards/10/shares', { user: ana })).data.shares[0].user.email, 'ben@example.com');
  assert.equal((await call(router, 'PATCH', '/api/boards/10/shares/2', { user: ana, body: { permission: 'edit' } })).data.permission, 'edit');
  assert.equal((await call(router, 'POST', '/api/boards/10/accept', { user: ben })).data.id, 10);
  assert.deepEqual((await call(router, 'GET', '/api/sharing/people', { user: ben })).data, { people: [{ id: 1, name: 'Ana' }] });
  assert.equal((await call(router, 'GET', '/api/sharing/people')).status, 401);
  assert.deepEqual((await call(router, 'DELETE', '/api/boards/10/shares/2', { user: ben })).data, { ok: true });

  // Tasks' shape: POST and DELETE under /share, no GET of who has it, no PATCH.
  assert.deepEqual((await call(router, 'POST', '/api/lists/30/share', { user: ana, body: { email: 'cris@example.com' } })).data, { invited: true });
  assert.equal(router.match('GET', '/api/lists/30/share')?.handler, undefined);
  assert.equal(router.match('PATCH', '/api/lists/30/share/3')?.handler, undefined);
  assert.equal((await call(router, 'POST', '/api/lists/30/accept', { user: { id: 3 } })).data.id, 30);
  assert.deepEqual((await call(router, 'DELETE', '/api/lists/30/share/3', { user: { id: 3 } })).data, { ok: true });
});
