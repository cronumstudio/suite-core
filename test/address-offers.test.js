/**
 * Offers by address (sharing.js createAddressOffers, and createSharing's `addressOffers`), on a
 * database in memory: an offer by email waits under its address whether an account has it or not;
 * its owner's list shows it by the address under a negative id; PATCH and DELETE …/-<id> change it
 * and take it back with the account waiting behind it; whoever signs up with the address claims it;
 * it goes when the invitation it brought is answered, and nothing else an account does moves it.
 *
 *   npm test (node --test test/address-offers.test.js for this alone)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { createSharing, createAddressOffers } from '../sharing.js';
import { createShareBrake } from '../share-brake.js';
import { createRouter, HttpError, notFound, forbidden } from '../http.js';

const NOW = '2026-11-20T10:00:00.000Z';

function database() {
  const handle = new DatabaseSync(':memory:');
  handle.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, email TEXT, email_verified_at TEXT);
    CREATE TABLE boards (id INTEGER PRIMARY KEY, owner_id INTEGER, name TEXT, deleted_at TEXT);
    CREATE TABLE board_shares (board_id INTEGER, user_id INTEGER, permission TEXT NOT NULL DEFAULT 'edit',
      accepted INTEGER NOT NULL DEFAULT 0, invited_by INTEGER, created_at TEXT, by_id INTEGER NOT NULL DEFAULT 0,
      UNIQUE (board_id, user_id));
    CREATE TABLE board_address_offers (id INTEGER PRIMARY KEY, board_id INTEGER NOT NULL, email TEXT NOT NULL COLLATE NOCASE,
      permission TEXT NOT NULL, invited_by INTEGER, created_at TEXT NOT NULL DEFAULT 'by-default', UNIQUE (board_id, email));
  `);
  const people = [[1, 'ana', 'Ana', 'ana@example.com', NOW], [2, 'ben', 'Ben', 'ben@example.com', NOW], [3, 'cris', 'Cris', 'cris@example.com', NOW],
    [4, 'dani', 'Dani', 'dani@example.com', null]];
  for (const p of people) handle.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(...p);
  handle.exec("INSERT INTO boards VALUES (10, 1, 'Plans', NULL), (11, 1, 'Old', '2026-01-01'), (20, 2, 'Ben''s', NULL)");
  const statements = [];
  return {
    statements,
    get: (sql, ...params) => { statements.push(sql); return handle.prepare(sql).get(...params); },
    all: (sql, ...params) => { statements.push(sql); return handle.prepare(sql).all(...params); },
    run: (sql, ...params) => { statements.push(sql); return handle.prepare(sql).run(...params); },
  };
}

const offersOf = (db, board = 10) => db.all('SELECT email, permission, invited_by FROM board_address_offers WHERE board_id = ? ORDER BY id', board).map((o) => ({ ...o }));
const sharesOf = (db, board = 10) => db.all('SELECT user_id, permission, accepted, by_id FROM board_shares WHERE board_id = ? ORDER BY user_id', board).map((s) => ({ ...s }));
const codeOf = (fn) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpError) return `${err.status} ${err.code}`;
    throw err;
  }
  return 'ok';
};

/** A module like Notes or Tasks: boards shared by the engine, their offers by email under their address. */
function setup({ kind = {}, brake = createShareBrake(), clock = () => NOW } = {}) {
  const db = database();
  const offers = createAddressOffers({
    db, table: 'board_address_offers', clock,
    kinds: { board: { key: 'board_id', shares: 'board_shares', things: 'boards', where: 't.deleted_at IS NULL' } },
  });
  const events = [];
  const told = [];
  const board = (id) => db.get('SELECT * FROM boards WHERE id = ?', Number(id));
  const sharing = createSharing({
    db, brake, clock,
    notify: { email: (n) => told.push(['email', n.targetId]), stranger: (n) => told.push(['stranger', n.email]) },
    kinds: {
      board: {
        table: 'board_shares', key: 'board_id', byId: 'by_id', addressOffers: offers, path: '/api/boards/:id',
        owner: { join: 'JOIN boards t ON t.id = s.board_id', column: 't.owner_id' },
        own(userId, id) {
          const row = board(id);
          if (!row) throw notFound();
          if (row.owner_id !== userId) throw forbidden();
          return row;
        },
        read(userId, id) {
          const row = board(id);
          if (row.owner_id === userId) return { thing: row, role: 'owner', ownerId: row.owner_id };
          if (!db.get('SELECT 1 AS x FROM board_shares WHERE board_id = ? AND user_id = ? AND accepted = 1', row.id, userId)) throw notFound();
          return { thing: row, role: 'member', ownerId: row.owner_id };
        },
        leaving(userId, id, targetId) {
          const row = board(id);
          if (targetId !== userId && row.owner_id !== userId) throw notFound();
          return { thing: row, ownerId: row.owner_id };
        },
        pending(userId, id) {
          if (!db.get('SELECT 1 AS x FROM board_shares WHERE board_id = ? AND user_id = ? AND accepted = 0', Number(id), userId)) throw notFound('no_pending_invitation');
          return board(id);
        },
        offered: (n) => events.push(['offered', n.targetId, n.permission]),
        changed: (n) => events.push(['changed', n.targetId, n.permission]),
        removing: (n) => events.push(['removing', n.targetId]),
        removed: (n) => events.push(['removed', n.targetId, n.row ? 'row' : null]),
        ...kind,
      },
    },
  });
  /** What happened since the last look: the hooks and the notices. */
  const since = () => [events.splice(0), told.splice(0)];
  return { db, offers, sharing, since };
}

test('the offers of a thing: kept, made again, shown whole to whoever typed them and masked to anyone else', () => {
  const db = database();
  const offers = createAddressOffers({ db, table: 'board_address_offers', clock: () => NOW, kinds: { board: { key: 'board_id' } } });
  assert.deepEqual(offers.keep('board', 10, 1, 'maria@example.com', 'view'), { invited: true });
  assert.deepEqual(offers.keep('board', 10, 2, 'MARIA@example.com', 'edit'), { invited: false }, 'the same address, whatever its case');
  assert.deepEqual(offersOf(db), [{ email: 'maria@example.com', permission: 'edit', invited_by: 2 }], 'whoever typed it again made it');
  const id = offers.under('board', 10, 'maria@example.com').id;
  assert.equal(offers.find('board', 10, id).email, 'maria@example.com');
  assert.equal(offers.find('board', 20, id), undefined, 'an offer of another thing is none of this one');
  assert.deepEqual(offers.rows('board', 10, 2), [{ user: { id: -id, name: 'maria@example.com', email: 'maria@example.com' }, permission: 'edit', accepted: false, created_at: NOW }]);
  assert.deepEqual(offers.rows('board', 10, 1)[0].user, { id: -id, name: 'm•••@example.com', email: 'm•••@example.com' });
  offers.setPermission(id, 'view');
  assert.equal(offersOf(db)[0].permission, 'view');
  db.run("UPDATE users SET email = 'maria@example.com' WHERE id = 4");
  offers.dropOf('board', 10, 3);
  assert.equal(offersOf(db).length, 1);
  offers.dropOf('board', 10, 4);
  assert.deepEqual(offersOf(db), []);
  offers.keep('board', 10, 1, 'otra@example.com', 'view');
  offers.withdraw(offers.under('board', 10, 'otra@example.com').id);
  offers.keep('board', 10, 1, 'otra@example.com', 'view');
  offers.drop('board', 10, 'OTRA@example.com');
  offers.drop('board', 10, null);
  assert.deepEqual(offersOf(db), []);
});

test('a module’s own columns: a role, the first maker kept, the column’s date; the thing’s owner kept with each offer', () => {
  const db = database();
  db.run(`CREATE TABLE place_offers (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, email TEXT NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL, invited_by INTEGER, created_at TEXT NOT NULL DEFAULT 'by-default', UNIQUE (project_id, email))`);
  const roles = createAddressOffers({ db, table: 'place_offers', permission: 'role', retype: false, stamp: false, kinds: { project: { key: 'project_id' } } });
  assert.deepEqual(roles.keep('project', 7, 1, 'pia@example.com', 'viewer'), { invited: true });
  assert.deepEqual(roles.keep('project', 7, 2, 'pia@example.com', 'member'), { invited: false });
  assert.deepEqual({ ...db.get('SELECT role, invited_by, created_at FROM place_offers') }, { role: 'member', invited_by: 1, created_at: 'by-default' },
    'whoever typed it first stays');
  const [offer] = roles.list('project', 7);
  assert.equal(roles.row(offer, 1).permission, 'member');
  assert.equal(roles.row({ ...offer, role: 'viewer' }, 1).permission, 'viewer');
  roles.setPermission(offer.id, 'viewer');
  assert.equal(roles.under('project', 7, 'PIA@example.com').role, 'viewer');
  assert.throws(() => roles.find('list', 7, offer.id), TypeError, 'a kind it doesn’t have');

  // Notes' way: one table for three kinds, each offer with the thing's owner, which follows an heir.
  db.run(`CREATE TABLE note_offers (id INTEGER PRIMARY KEY, notebook_id INTEGER, group_id INTEGER, email TEXT NOT NULL COLLATE NOCASE,
    permission TEXT NOT NULL, owner_id INTEGER NOT NULL, invited_by INTEGER, created_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE notebook_shares (notebook_id INTEGER, user_id INTEGER, permission TEXT, accepted INTEGER, invited_by INTEGER, created_at TEXT)`);
  db.run(`CREATE TABLE group_shares (group_id INTEGER, user_id INTEGER, permission TEXT, accepted INTEGER, invited_by INTEGER, created_at TEXT)`);
  const owned = createAddressOffers({
    db, table: 'note_offers', owner: 'owner_id', clock: () => NOW,
    kinds: { notebook: { key: 'notebook_id', shares: 'notebook_shares' }, group: { key: 'group_id', shares: 'group_shares' } },
  });
  owned.keep('notebook', 10, 1, 'cris@example.com', 'view');
  owned.keep('notebook', 10, 2, 'cris@example.com', 'edit');
  owned.keep('group', 5, 1, 'cris@example.com', 'view');
  assert.deepEqual(db.all('SELECT notebook_id, group_id, permission, owner_id, invited_by, created_at FROM note_offers ORDER BY id').map((o) => ({ ...o })), [
    { notebook_id: 10, group_id: null, permission: 'edit', owner_id: 2, invited_by: 2, created_at: NOW },
    { notebook_id: null, group_id: 5, permission: 'view', owner_id: 1, invited_by: 1, created_at: NOW },
  ], 'typed again by an heir: theirs');
  db.statements.length = 0;
  owned.claim(3);
  assert.equal(db.statements.filter((sql) => /^s*INSERT/.test(sql)).length, 2, 'one look at the table, then each kind');
  assert.deepEqual([db.get('SELECT * FROM notebook_shares'), db.get('SELECT * FROM group_shares')].map((r) => ({ ...r })), [
    { notebook_id: 10, user_id: 3, permission: 'edit', accepted: 0, invited_by: 2, created_at: NOW },
    { group_id: 5, user_id: 3, permission: 'view', accepted: 0, invited_by: 1, created_at: NOW },
  ]);
  db.statements.length = 0;
  owned.claim(2);
  assert.equal(db.statements.length, 2, 'an heir’s own offers wait for nobody: it looks, and that is all');
  assert.throws(() => createAddressOffers({ db, table: 'place_offers', kinds: { project: { key: 'project_id', shares: 'board_shares' } } }), TypeError,
    'a claim must know whose the things are');
});

test('claim: what waits under a confirmed address becomes an invitation, never of one’s own, gone or already had', () => {
  const { db, offers } = setup();
  offers.keep('board', 10, 1, 'cris@example.com', 'view');
  offers.keep('board', 11, 1, 'cris@example.com', 'edit');
  offers.keep('board', 20, 2, 'cris@example.com', 'edit');
  offers.keep('board', 10, 1, 'ana@example.com', 'edit');
  offers.keep('board', 10, 1, 'dani@example.com', 'edit');
  db.run("INSERT INTO board_shares (board_id, user_id, permission, accepted) VALUES (20, 3, 'view', 1)");
  db.statements.length = 0;
  offers.claim(3);
  assert.deepEqual(sharesOf(db, 10), [{ user_id: 3, permission: 'view', accepted: 0, by_id: 0 }]);
  assert.deepEqual({ ...db.get('SELECT invited_by, created_at FROM board_shares WHERE board_id = 10') }, { invited_by: 1, created_at: NOW }, 'who offered it and when');
  assert.deepEqual(sharesOf(db, 11), [], 'in the trash: nothing');
  assert.deepEqual(sharesOf(db, 20), [{ user_id: 3, permission: 'view', accepted: 1, by_id: 0 }], 'what they have stays');
  offers.claim(1);
  assert.deepEqual(sharesOf(db, 10).map((s) => s.user_id), [3], 'never their own');
  offers.claim(4);
  assert.deepEqual(sharesOf(db, 10).map((s) => s.user_id), [3], 'nor to an address not confirmed');
  offers.claim(3);
  assert.equal(sharesOf(db, 10).length, 1, 'claimed twice, once');
  // Nothing waiting: it looks and writes nothing.
  db.statements.length = 0;
  offers.claim(2);
  assert.ok(!db.statements.some((sql) => /INSERT/.test(sql)), db.statements.join('\n'));
  assert.equal(db.statements.length, 2);
});

test('by email, with an account and without: the same answer, the offer under its address, the same notices for its owner', () => {
  const { db, sharing, since } = setup();
  const known = sharing.share('board', 1, 10, { email: 'Ben@Example.com', permission: 'view' });
  assert.deepEqual(since(), [[['offered', 2, 'view']], [['email', 2]]]);
  const unknown = sharing.share('board', 1, 10, { email: 'nadie@example.com', permission: 'view' });
  assert.deepEqual(since(), [[['offered', null, 'view']], [['stranger', 'nadie@example.com']]], 'its hook for nobody');
  assert.deepEqual(known, { share: { user: { id: null, name: 'ben@example.com', email: 'ben@example.com' }, permission: 'view', accepted: false, created_at: NOW }, invited: true });
  assert.deepEqual(unknown, { ...known, share: { ...known.share, user: { id: null, name: 'nadie@example.com', email: 'nadie@example.com' } } });
  assert.deepEqual(offersOf(db), [
    { email: 'ben@example.com', permission: 'view', invited_by: 1 },
    { email: 'nadie@example.com', permission: 'view', invited_by: 1 },
  ]);
  assert.deepEqual(sharesOf(db), [{ user_id: 2, permission: 'view', accepted: 0, by_id: 0 }]);

  // Its owner sees both by their address, Ben's account in neither; anyone else, neither.
  const ids = db.all('SELECT id FROM board_address_offers ORDER BY id').map((o) => -o.id);
  assert.deepEqual(sharing.list('board', 1, 10), {
    role: 'owner', owner: { id: 1, name: 'Ana' },
    shares: [
      { user: { id: ids[0], name: 'ben@example.com', email: 'ben@example.com' }, permission: 'view', accepted: false, created_at: NOW },
      { user: { id: ids[1], name: 'nadie@example.com', email: 'nadie@example.com' }, permission: 'view', accepted: false, created_at: NOW },
    ],
  });
  assert.deepEqual(sharing.sharesOf('board', 10, { owner: true }), [], 'without a viewer, the accounts alone, as before');

  // Made again: only what it lets them do changes, nobody is told twice.
  sharing.share('board', 1, 10, { email: 'ben@example.com', permission: 'edit' });
  assert.deepEqual(since(), [[['offered', 2, 'edit']], []]);
  assert.deepEqual([offersOf(db)[0].permission, sharesOf(db)[0].permission], ['edit', 'edit']);

  // Accepted, the account shows by its name; typed again for that member, the address waits as a new one.
  sharing.accept('board', 2, 10);
  assert.deepEqual(offersOf(db).map((o) => o.email), ['nadie@example.com'], 'hers waits no more');
  const again = sharing.share('board', 1, 10, { email: 'ben@example.com', permission: 'view' });
  assert.deepEqual(again, { ...known, share: { ...known.share } });
  assert.deepEqual(since(), [[['offered', null, 'view']], []]);
  assert.deepEqual(sharesOf(db), [{ user_id: 2, permission: 'edit', accepted: 1, by_id: 0 }], 'what he may do stays');
  assert.deepEqual(sharing.list('board', 1, 10).shares.map((s) => [s.user.name, s.accepted]),
    [['Ben', true], ['nadie@example.com', false], ['ben@example.com', false]], 'accepted first, then as they were made');
  assert.equal(sharing.list('board', 2, 10).shares.length, 1, 'a member sees who accepted, never an offer');
});

test('a new permission by the offer’s row: counted, the account behind it takes it, its row answered', () => {
  const brake = createShareBrake({ offersPerHour: 4 });
  const { db, sharing, since } = setup({ brake });
  sharing.share('board', 1, 10, { email: 'ben@example.com' });
  sharing.share('board', 1, 10, { email: 'nadie@example.com' });
  since();
  const [bens, nobodys] = db.all('SELECT id FROM board_address_offers ORDER BY id').map((o) => o.id);
  assert.deepEqual(sharing.setPermission('board', 1, 10, -bens, 'view'),
    { user: { id: -bens, name: 'ben@example.com', email: 'ben@example.com' }, permission: 'view', accepted: false, created_at: NOW });
  assert.deepEqual(since(), [[['changed', 2, 'view']], []]);
  assert.deepEqual(sharesOf(db), [{ user_id: 2, permission: 'view', accepted: 0, by_id: 0 }]);
  assert.equal(sharing.setPermission('board', 1, 10, -nobodys, undefined).permission, 'edit', 'without one, edit');
  assert.deepEqual(since(), [[['changed', null, 'edit']], []]);
  assert.equal(codeOf(() => sharing.setPermission('board', 1, 10, -nobodys, 'admin')), '400 field_invalid');
  assert.equal(codeOf(() => sharing.setPermission('board', 1, 10, -999, 'view')), '404 not_found');
  assert.equal(codeOf(() => sharing.setPermission('board', 2, 10, -bens, 'view')), '403 forbidden');
  assert.equal(codeOf(() => sharing.setPermission('board', 1, 10, 2, 'edit')), '404 not_found', 'by the account’s id it isn’t there');
  assert.equal(codeOf(() => sharing.setPermission('board', 1, 10, -bens, 'edit')), '429 share_limit', 'each change counts as an offer');
});

test('taking back by the offer’s row: with the account behind it as any share, without it the same hooks for nobody', () => {
  const { db, sharing, since } = setup();
  sharing.share('board', 1, 10, { email: 'ben@example.com' });
  sharing.share('board', 1, 10, { email: 'nadie@example.com' });
  since();
  const [bens, nobodys] = db.all('SELECT id FROM board_address_offers ORDER BY id').map((o) => o.id);
  assert.equal(codeOf(() => sharing.remove('board', 2, 10, -bens)), '404 not_found', 'only its owner');
  assert.equal(codeOf(() => sharing.remove('board', 1, 10, 2)), '404 not_found', 'by the account’s id it isn’t there');
  sharing.remove('board', 1, 10, -bens);
  assert.deepEqual(since(), [[['removing', 2], ['removed', 2, 'row']], []]);
  sharing.remove('board', 1, 10, -nobodys);
  assert.deepEqual(since(), [[['removing', null], ['removed', null, null]], []]);
  assert.deepEqual([offersOf(db), sharesOf(db)], [[], []]);
  assert.equal(codeOf(() => sharing.remove('board', 1, 10, -bens)), '404 not_found', 'taken back already');
  const lenient = setup({ kind: { strictRemove: false } });
  lenient.sharing.remove('board', 1, 10, -1);
  assert.deepEqual(lenient.since(), [[], []], 'done, and nobody told');
});

test('it goes only when the invitation it brought is answered: nothing else an account does moves it', () => {
  const { db, sharing } = setup();
  // Ana knows Ben: she accepted his board.
  db.run("INSERT INTO board_shares (board_id, user_id, permission, accepted) VALUES (20, 1, 'edit', 1)");
  const typed = () => offersOf(db).map((o) => [o.email, o.permission]);

  // Typed, then picked by id: two offers. Answering the one by name leaves the address's as it was.
  sharing.share('board', 1, 10, { email: 'ben@example.com', permission: 'edit' });
  sharing.share('board', 1, 10, { user_id: 2, permission: 'view' });
  sharing.accept('board', 2, 10);
  assert.deepEqual(typed(), [['ben@example.com', 'edit']], 'accepted by name');
  sharing.remove('board', 2, 10, 2);
  assert.deepEqual(typed(), [['ben@example.com', 'edit']], 'left');
  sharing.share('board', 1, 10, { user_id: 2, permission: 'view' });
  sharing.remove('board', 2, 10, 2);
  assert.deepEqual(typed(), [['ben@example.com', 'edit']], 'declined by name');

  // An address typed for a member: their new permission by name leaves it as it was; so does leaving.
  sharing.claimAddressOffers(2);
  sharing.accept('board', 2, 10);
  assert.deepEqual(typed(), [], 'accepted what the address brought: it shows by name from now on');
  sharing.share('board', 1, 10, { email: 'ben@example.com', permission: 'view' });
  sharing.setPermission('board', 1, 10, 2, 'view');
  sharing.setPermission('board', 1, 10, 2, 'edit');
  sharing.share('board', 1, 10, { user_id: 2, permission: 'view' });
  assert.deepEqual(typed(), [['ben@example.com', 'view']], 'a permission given by name');
  sharing.remove('board', 2, 10, 2);
  assert.deepEqual(typed(), [['ben@example.com', 'view']], 'left');

  // Taken back by name, an offer typed and picked leaves the address's as it was.
  sharing.share('board', 1, 11, { email: 'ben@example.com' });
  sharing.share('board', 1, 11, { user_id: 2 });
  sharing.remove('board', 1, 11, 2);
  assert.deepEqual(offersOf(db, 11).map((o) => o.email), ['ben@example.com']);

  // Typed only, and declined: it goes; the address of another thing waits on.
  sharing.share('board', 1, 10, { email: 'cris@example.com' });
  sharing.share('board', 1, 11, { email: 'cris@example.com' });
  sharing.remove('board', 3, 10, 3);
  assert.ok(!offersOf(db).some((o) => o.email === 'cris@example.com'), 'declined');
  assert.deepEqual(offersOf(db, 11).map((o) => o.email), ['ben@example.com', 'cris@example.com']);
});

test('accepting claims first; claimAddressOffers claims every kind’s', () => {
  const { db, sharing, offers } = setup();
  offers.keep('board', 10, 1, 'cris@example.com', 'view');
  assert.equal(sharing.accept('board', 3, 10).id, 10);
  assert.deepEqual(sharesOf(db), [{ user_id: 3, permission: 'view', accepted: 1, by_id: 0 }]);
  assert.deepEqual(offersOf(db), []);
  offers.keep('board', 20, 2, 'cris@example.com', 'edit');
  sharing.claimAddressOffers(3);
  assert.deepEqual(sharesOf(db, 20), [{ user_id: 3, permission: 'edit', accepted: 0, by_id: 0 }]);
  assert.equal(codeOf(() => sharing.accept('board', 4, 10)), '404 no_pending_invitation');
});

/** A request through the routes as the app's server would make it. */
async function call(router, method, url, { user, body } = {}) {
  const found = router.match(method, url);
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

test('the routes take the offer’s row by its negative id', async () => {
  const { db, sharing } = setup();
  const router = createRouter();
  const id = (ctx, name) => {
    const n = Number(ctx.params[name]);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'field_invalid');
    return n;
  };
  sharing.routes(router, { user: (ctx) => ctx.user, id });
  const ana = { id: 1 };
  await call(router, 'POST', '/api/boards/10/shares', { user: ana, body: { email: 'nadie@example.com', permission: 'view' } });
  const offer = db.get('SELECT id FROM board_address_offers').id;
  const listed = await call(router, 'GET', '/api/boards/10/shares', { user: ana });
  assert.deepEqual(listed.data.shares.map((s) => s.user.id), [-offer]);
  assert.equal((await call(router, 'PATCH', `/api/boards/10/shares/-${offer}`, { user: ana, body: { permission: 'edit' } })).data.permission, 'edit');
  assert.deepEqual(await call(router, 'DELETE', `/api/boards/10/shares/-${offer}`, { user: ana }), { status: 200, data: { ok: true } });
  assert.deepEqual(offersOf(db), []);
  assert.deepEqual(await call(router, 'DELETE', '/api/boards/10/shares/x', { user: ana }), { status: 400, data: { error: 'field_invalid' } }, 'anything else, the module’s id');
});

test('a kind without addressOffers is as it was: negative ids are the module’s', () => {
  const { sharing } = setup({ kind: { addressOffers: undefined, addresses: { table: 'board_address_offers', key: 'board_id' } } });
  assert.equal(codeOf(() => sharing.remove('board', 1, 10, -1)), '404 not_found');
  const offered = sharing.share('board', 1, 10, { email: 'nadie@example.com' });
  assert.equal(offered.invited, true);
  assert.deepEqual(sharing.list('board', 1, 10).shares, [], 'the module keeps and lists its offers itself');
});
