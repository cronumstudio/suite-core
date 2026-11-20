/**
 * What the data audit of 6/11 asked of the shared pieces (ownership.js, sharing.js):
 *
 *   · the heir is an account in use before a disabled one (portable-17), and the hand-over is the
 *     same in every module: dated from then, its public page off (handOver; dup-srv-1, ownership-20);
 *   · a deletion's notice goes once a day per sender and person, names what had no name, and two
 *     of them don't replace each other on a device (sc-data-10, sc-data-23);
 *   · the heir sees the addresses its former owner typed masked (Martin, 14/11/2026);
 *   · with `byId`, an offer picked by id and one typed by address are told apart, so neither the
 *     answer nor the owner's list says whose an address is (Martin, 14/11/2026).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createOwnership, pickHeir, createGoneBrake } from '../ownership.js';
import { createSharing, maskAddress, addressFor } from '../sharing.js';
import { createShareBrake } from '../share-brake.js';
import { translator, SUITE_CATALOGS } from '../i18n.js';
import { notFound, forbidden } from '../http.js';

function database(sql) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(sql);
  return {
    raw,
    get: (q, ...p) => raw.prepare(q).get(...p),
    all: (q, ...p) => raw.prepare(q).all(...p),
    run: (q, ...p) => raw.prepare(q).run(...p),
  };
}

const PEOPLE = `
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, email TEXT, prefs TEXT, disabled_at TEXT);
  INSERT INTO users VALUES (1, 'ana', 'Ana', 'ana@example.com', '{"lang":"es"}', NULL),
    (2, 'ben', 'Ben', 'ben@example.com', '{"lang":"en"}', '2026-11-01'),
    (3, 'cris', 'Cris', 'cris@example.com', '{"lang":"en"}', NULL),
    (4, 'dani', 'Dani', 'dani@example.com', '{}', NULL);`;

test('pickHeir: an account in use before a disabled one, which is chosen only when nobody else is left', () => {
  const rows = [
    { userId: 2, permission: 'edit', since: '2026-01-01', disabled: true },
    { userId: 3, permission: 'view', since: '2026-02-01' },
  ];
  assert.deepEqual(pickHeir(rows), { userId: 3, permission: 'view', since: '2026-02-01' });
  assert.equal(pickHeir([rows[0]]).userId, 2, 'the only one left');
  // What a module prefers (Notes' given_by) still wins among those in use, never over them.
  assert.equal(pickHeir(rows, { prefer: 2 }).userId, 3);
});

test('heirOf reads who is disabled from the accounts; handOver passes, dates, unpublishes and lets the module add its part', () => {
  const db = database(`${PEOPLE}
    CREATE TABLE boards (id INTEGER PRIMARY KEY, owner_id INTEGER, name TEXT, deleted_at TEXT,
      owner_since TEXT, public_token TEXT, public_since TEXT, sort_order INTEGER);
    CREATE TABLE board_shares (board_id INTEGER, user_id INTEGER, permission TEXT, accepted INTEGER, created_at TEXT);
    INSERT INTO boards VALUES (10, 1, 'Plans', NULL, NULL, 'tok', '2026-10-01', 0),
      (11, 1, 'Alone', NULL, NULL, NULL, NULL, 1), (12, 1, 'Binned', '2026-11-02', NULL, NULL, NULL, 2);
    INSERT INTO board_shares VALUES (10, 2, 'edit', 1, '2026-01-01'), (10, 3, 'view', 1, '2026-02-01'),
      (10, 4, 'edit', 0, '2025-01-01'), (12, 3, 'edit', 1, '2026-01-01');`);
  const ownership = createOwnership({ db });
  assert.equal(ownership.heirOf([{ userId: 2, permission: 'edit', since: 'a' }, { userId: 3, permission: 'view', since: 'b' }]).userId, 3);
  const steps = [];
  const handed = ownership.handOver(1, {
    table: 'boards', where: 'deleted_at IS NULL', clock: () => '2026-11-17T10:00:00.000Z',
    candidates: (board) => db.all(`SELECT user_id AS userId, permission, created_at AS since FROM board_shares
      WHERE board_id = ? AND accepted = 1`, board.id),
    set: () => ({ sort_order: 99 }),
    moved: (board, heir, at) => {
      db.run('DELETE FROM board_shares WHERE board_id = ? AND user_id = ?', board.id, heir.userId);
      steps.push([board.id, heir.userId, at]);
    },
  });
  // Ben edits but is disabled: Cris, in use, inherits; Dani never accepted. The board alone and the
  // one in the trash stay with Ana.
  assert.deepEqual(handed, [{ id: 10, heirId: 3 }]);
  assert.deepEqual(steps, [[10, 3, '2026-11-17T10:00:00.000Z']]);
  assert.deepEqual({ ...db.get('SELECT owner_id, owner_since, public_token, public_since, sort_order FROM boards WHERE id = 10') },
    { owner_id: 3, owner_since: '2026-11-17T10:00:00.000Z', public_token: null, public_since: null, sort_order: 99 });
  assert.deepEqual(db.all('SELECT id FROM boards WHERE owner_id = 1 ORDER BY id').map((b) => b.id), [11, 12]);
  // A table with no owner_since and its own page columns.
  db.run('ALTER TABLE boards ADD COLUMN shown_at TEXT');
  db.run("UPDATE boards SET owner_id = 1, public_token = 'x', shown_at = 'y' WHERE id = 10");
  db.run("INSERT INTO board_shares VALUES (10, 3, 'edit', 1, '2026-01-01')");
  ownership.handOver(1, {
    table: 'boards', where: 'id = 10', since: null, unpublish: { token: 'public_token', since: 'shown_at' },
    candidates: (board) => db.all('SELECT user_id AS userId, permission, created_at AS since FROM board_shares WHERE board_id = ? AND accepted = 1', board.id),
  });
  assert.deepEqual({ ...db.get('SELECT owner_id, owner_since, public_token, shown_at FROM boards WHERE id = 10') },
    { owner_id: 3, owner_since: '2026-11-17T10:00:00.000Z', public_token: null, shown_at: null });
  assert.throws(() => createOwnership({ db: { get: db.get } }).handOver(1, { table: 'boards', candidates: () => [] }), TypeError);
});

test('tellGone: once a day per sender and person, a name for what had none, and a tag of its own', async () => {
  const db = database(PEOPLE);
  const pushes = [];
  const mails = [];
  let now = Date.parse('2026-11-17T10:00:00Z');
  const ownership = createOwnership({
    db,
    push: { subscriptionsOf: (ids) => ids.map((id) => ({ id })), deliver: async (subs, payload) => { pushes.push([subs[0].id, payload]); } },
    shareMail: { gone: async ({ to, name }) => { mails.push([to.id, name]); return true; } },
    texts: (user) => translator(JSON.parse(user.prefs || '{}').lang || 'en', SUITE_CATALOGS, {}),
    brake: createGoneBrake({ clock: () => now }),
  });
  assert.equal(await ownership.tellGone({ kind: 'note', name: '  ', actorId: 1, audience: [3], id: 7 }), 1);
  assert.match(pushes[0][1].title, /Untitled/);
  assert.equal(pushes[0][1].tag, 'gone-note-7');
  // Deleted and restored, deleted again: the same day, nothing more for Cris; Dani hears of hers.
  assert.equal(await ownership.tellGone({ kind: 'note', name: 'Plans', actorId: 1, audience: [3, 4], id: 7 }), 1);
  assert.deepEqual(mails.map((m) => m[0]), [3, 4]);
  // A day later it may go again; without an id, the kind's tag as before.
  now += 24 * 60 * 60 * 1000;
  await ownership.tellGone({ kind: 'list', name: 'Shop', actorId: 1, audience: [3] });
  assert.equal(pushes.at(-1)[1].tag, 'gone-list');
  assert.equal(mails.length, 3);
});

test('maskAddress and addressFor: whoever typed it sees it whole; anyone else, its first letter and its domain', () => {
  assert.equal(maskAddress('maria@example.com'), 'm•••@example.com');
  assert.equal(maskAddress('x'), 'x•••');
  assert.equal(maskAddress(''), '');
  assert.equal(addressFor(1, 'maria@example.com', 1), 'maria@example.com');
  assert.equal(addressFor(3, 'maria@example.com', 1), 'm•••@example.com');
  assert.equal(addressFor(3, 'maria@example.com', null), 'm•••@example.com', 'whoever typed it went');
});

function offering({ byId }) {
  const db = database(`${PEOPLE}
    CREATE TABLE boards (id INTEGER PRIMARY KEY, owner_id INTEGER, name TEXT);
    CREATE TABLE board_shares (board_id INTEGER, user_id INTEGER, permission TEXT NOT NULL DEFAULT 'edit',
      accepted INTEGER NOT NULL DEFAULT 0, invited_by INTEGER, created_at TEXT, by_id INTEGER NOT NULL DEFAULT 0,
      UNIQUE (board_id, user_id));
    CREATE TABLE board_address_offers (id INTEGER PRIMARY KEY, board_id INTEGER, email TEXT NOT NULL COLLATE NOCASE,
      permission TEXT, UNIQUE (board_id, email));
    INSERT INTO boards VALUES (10, 1, 'Plans'), (20, 3, 'Cris''s');`);
  db.run('UPDATE users SET disabled_at = NULL');
  const told = [];
  // The engine's clock, held still and moved by the test: two answers given a millisecond apart
  // carry the same time, and one dated anew is told from one that kept an older date.
  let now = '2026-11-20T09:00:00.000Z';
  const sharing = createSharing({
    db, brake: createShareBrake(), clock: () => now,
    notify: { email: (n) => told.push(n.targetId) },
    kinds: {
      board: {
        table: 'board_shares', key: 'board_id', byId: byId ? 'by_id' : undefined,
        owner: { join: 'JOIN boards t ON t.id = s.board_id', column: 't.owner_id' },
        addresses: { table: 'board_address_offers', key: 'board_id' },
        own(userId, id) {
          const row = db.get('SELECT * FROM boards WHERE id = ?', Number(id));
          if (!row) throw notFound();
          if (row.owner_id !== userId) throw forbidden();
          return row;
        },
        read: (userId, id) => ({ thing: db.get('SELECT * FROM boards WHERE id = ?', id), role: 'owner', ownerId: 1 }),
        leaving: (userId, id) => ({ thing: db.get('SELECT * FROM boards WHERE id = ?', id), ownerId: 1 }),
        pending: (userId, id) => db.get('SELECT * FROM boards WHERE id = ?', id),
        answer: ({ kind, thing, target, permission, invited }) => {
          if (!target.email) return { share: sharing.sharesOf(kind, thing.id, { owner: true }).find((s) => s.user.id === target.id), invited };
          db.run(`INSERT INTO board_address_offers (board_id, email, permission) VALUES (?, ?, ?)
            ON CONFLICT (board_id, email) DO UPDATE SET permission = excluded.permission`, thing.id, target.email, permission);
          return sharing.emailAnswer(target.email, permission);
        },
        accepted: ({ thing }) => thing,
      },
    },
  });
  // Ana knows Cris: she accepted Cris's board offered to her.
  db.run("INSERT INTO board_shares (board_id, user_id, permission, accepted, by_id) VALUES (20, 1, 'edit', 1, 1)");
  /** What Ana's list of who has Plans shows: the accounts the engine lists, and the addresses the module does. */
  const seen = () => ({
    people: sharing.list('board', 1, 10).shares.map((s) => [s.user.id, s.accepted]),
    addresses: db.all('SELECT email FROM board_address_offers WHERE board_id = 10 ORDER BY email').map((a) => a.email),
  });
  return { db, sharing, seen, told, at: (time) => { now = time; } };
}

test('byId: typing an address, then picking a known person, shows the same whoever the address belongs to', () => {
  const answers = [];
  for (const address of ['cris@example.com', 'dani@example.com', 'nobody@example.com']) {
    const { sharing, seen, told } = offering({ byId: true });
    sharing.share('board', 1, 10, { email: address });
    const picked = sharing.share('board', 1, 10, { user_id: 3 });
    answers.push({ invited: picked.invited, user: picked.share?.user, seen: seen(), told: told.includes(3) });
  }
  // Cris shows by her name, pending, next to the address typed, and is told: whether the address was hers or not.
  for (const [i, address] of ['cris@example.com', 'dani@example.com', 'nobody@example.com'].entries()) {
    assert.deepEqual(answers[i], {
      invited: true, user: { id: 3, name: 'Cris' }, told: true,
      seen: { people: [[3, false]], addresses: [address] },
    }, address);
  }
  // Without the column, the old way: the address that was hers hid her row (the leak this closes).
  const { sharing, seen } = offering({ byId: false });
  sharing.share('board', 1, 10, { email: 'cris@example.com' });
  assert.equal(sharing.share('board', 1, 10, { user_id: 3 }).invited, false);
  assert.deepEqual(seen().people, []);
});

test('byId: an offer by email to someone who has it already answers and shows as one to a new address', () => {
  const { db, sharing, seen, at } = offering({ byId: true });
  sharing.share('board', 1, 10, { user_id: 3, permission: 'view' });
  sharing.accept('board', 3, 10);
  // An hour later: both answers are dated then, never with the date Cris's own share kept.
  at('2026-11-20T10:00:00.000Z');
  const byEmail = sharing.share('board', 1, 10, { email: 'cris@example.com', permission: 'edit' });
  const stranger = sharing.share('board', 1, 10, { email: 'nobody@example.com', permission: 'edit' });
  const strip = (a) => ({ ...a, share: { ...a.share, user: { ...a.share.user, id: null, name: null, email: null } } });
  assert.deepEqual(strip(byEmail), strip(stranger));
  assert.equal(byEmail.share.accepted, false);
  assert.equal(byEmail.share.created_at, '2026-11-20T10:00:00.000Z');
  // Cris's own share is as it was; her address waits like any other.
  assert.equal(db.get('SELECT permission FROM board_shares WHERE board_id = 10 AND user_id = 3').permission, 'view');
  assert.deepEqual(seen(), { people: [[3, true]], addresses: ['cris@example.com', 'nobody@example.com'] });
});

test('leftovers: an empty mcp_tokens next to api_tokens goes; one with rows, or alone, stays (portable-18)', async () => {
  const { dropLeftovers } = await import('../host.js');
  const { openDatabase } = await import('../db.js');
  const make = (sql) => { const d = openDatabase({ path: ':memory:' }); d.exec(sql); return d; };
  const empty = make('CREATE TABLE api_tokens (id INTEGER PRIMARY KEY); CREATE TABLE mcp_tokens (id INTEGER PRIMARY KEY);');
  dropLeftovers(empty);
  assert.equal(empty.columnsOf('mcp_tokens').length, 0);
  const full = make('CREATE TABLE api_tokens (id INTEGER PRIMARY KEY); CREATE TABLE mcp_tokens (id INTEGER PRIMARY KEY); INSERT INTO mcp_tokens VALUES (1);');
  dropLeftovers(full);
  assert.ok(full.columnsOf('mcp_tokens').length);
  const alone = make('CREATE TABLE mcp_tokens (id INTEGER PRIMARY KEY);');
  dropLeftovers(alone);
  assert.ok(alone.columnsOf('mcp_tokens').length);
});

test('an account that goes takes what was kept of its AI clients; a disconnected one stays refused (portable-20)', async () => {
  const { workosConnections } = await import('../workos-accounts.js');
  const { connectionsSchema, connectionConsentsSchema } = await import('../workos-accounts.js');
  const { openDatabase } = await import('../db.js');
  const d = openDatabase({ path: ':memory:' });
  connectionsSchema(d);
  connectionConsentsSchema(d);
  const connections = workosConnections(d, { clock: () => Date.parse('2026-11-17T10:00:00Z') });
  connections.used('user_1', 'claude', 'sid-a');
  connections.used('user_1', 'chatgpt', 'sid-b');
  connections.revoke('user_1', 'chatgpt');
  connections.used('user_2', 'claude', 'sid-c');
  connections.forget('user_1');
  assert.deepEqual(d.all('SELECT subject, client_id, last_used_at, sid, revoked_at IS NOT NULL AS revoked FROM idp_connections ORDER BY subject, client_id')
    .map((r) => ({ ...r })), [
    { subject: 'user_1', client_id: 'chatgpt', last_used_at: null, sid: null, revoked: 1 },
    { subject: 'user_2', client_id: 'claude', last_used_at: '2026-11-17T10:00:00.000Z', sid: 'sid-c', revoked: 0 },
  ]);
  assert.equal(connections.refuses('user_1', 'chatgpt', { iat: Date.parse('2026-11-17T09:00:00Z') / 1000 }), true);
});

test('byId: picked by id after an address was typed, the offer is dated anew', () => {
  const { db, sharing } = offering({ byId: true });
  db.run("INSERT INTO board_shares (board_id, user_id, permission, accepted, by_id, created_at) VALUES (10, 3, 'edit', 0, 0, '2026-01-01T00:00:00.000Z')");
  db.run("INSERT INTO board_address_offers (board_id, email) VALUES (10, 'cris@example.com')");
  sharing.share('board', 1, 10, { user_id: 3 });
  const row = db.get('SELECT by_id, created_at FROM board_shares WHERE board_id = 10 AND user_id = 3');
  assert.equal(row.by_id, 1);
  assert.notEqual(row.created_at, '2026-01-01T00:00:00.000Z');
});
