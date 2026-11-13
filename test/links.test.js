/**
 * Links (links.js) without a server: what the owners are asked, how often, and that the cards come
 * out the same whether a module reads them one by one (`read`) or many at once (`readMany`).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.js';
import { createLinks, linksSchema, parseRef, likeOf } from '../links.js';

const ana = { id: 1 };
const bob = { id: 2 };

/**
 * A host with two modules (alpha and beta), each with items as cards, every query counted and
 * every call to their cards. `many`: how beta's readMany answers (false: it has none).
 */
function setup(t, { many = 'all', alphaMany = false } = {}) {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  database.run('INSERT INTO users (id) VALUES (1), (2)');
  linksSchema(database);
  for (const table of ['alpha_items', 'beta_items']) {
    database.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT, done INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0)`);
  }
  const counts = { queries: 0, read: {}, readMany: {}, uses: 0 };
  const counted = (fn) => (...args) => {
    counts.queries += 1;
    return fn(...args);
  };
  const db = { ...database, all: counted(database.all), get: counted(database.get), run: counted(database.run) };

  const cardsOf = (mount, { readMany }) => {
    const table = `${mount}_items`;
    const card = (row) => ({ id: row.id, title: row.text, state: row.done ? 'done' : 'open', where: 'Items', url: `?item=${row.id}` });
    const answer = (user, row) => {
      if (!row || row.deleted) return 'gone';
      if (user && row.user_id !== user.id) return null;
      return card(row);
    };
    const item = {
      read(user, id, opts) {
        counts.read[mount] = (counts.read[mount] || 0) + 1;
        if (user === null) assert.deepEqual(opts, { system: true }, 'the host itself says so');
        return answer(user, db.get(`SELECT * FROM ${table} WHERE id = ?`, Number(id)));
      },
      search: (user, text) => db.all(`SELECT * FROM ${table} WHERE user_id = ? AND deleted = 0 AND text LIKE ? ORDER BY id LIMIT 40`, user.id, `%${text}%`).map(card),
      create: (user, data) => db.run(`INSERT INTO ${table} (user_id, text) VALUES (?, ?)`, user.id, String(data.title)).lastInsertRowid,
      places: () => [{ id: 'inbox', name: 'Inbox' }],
      audience: () => [],
    };
    if (readMany) {
      item.readMany = (user, ids, opts) => {
        counts.readMany[mount] = (counts.readMany[mount] || 0) + 1;
        if (user === null) assert.deepEqual(opts, { system: true });
        assert.ok(ids.every((id) => typeof id === 'string'), 'ids as strings');
        if (readMany === 'throws') throw new Error('broken');
        if (readMany === 'object') return {};
        const rows = new Map(db.all(`SELECT * FROM ${table} WHERE id IN (${ids.map(() => '?').join(', ')})`, ...ids.map(Number))
          .map((row) => [String(row.id), row]));
        const found = new Map(ids.map((id) => [id, answer(user, rows.get(id))]));
        // Some it doesn't say: the host asks read() for those.
        if (readMany === 'some') for (const id of ids.filter((_, i) => i % 3 === 0)) found.delete(id);
        return found;
      };
    }
    return { item };
  };
  const modules = [
    { mount: 'alpha', config: { app: { name: 'Alpha', color: '#EF4B2A' } }, parts: { cards: cardsOf('alpha', { readMany: alphaMany }) } },
    { mount: 'beta', config: { app: { name: 'Beta', color: '#7C3AED' } }, parts: { cards: cardsOf('beta', { readMany: many }) } },
  ];
  // As the host's: whether someone uses a module costs it queries (host_modules, host_looks).
  const uses = () => {
    counts.uses += 1;
    counts.queries += 2;
    return true;
  };
  const links = createLinks({ database: db, modules: () => modules, uses, clock: () => Date.parse('2026-10-25T10:00:00Z') });
  const reset = () => Object.assign(counts, { queries: 0, read: {}, readMany: {}, uses: 0 });
  return { database, links, counts, reset, modules };
}

/** Fifty beta items linked with ana's alpha item 1: two of them gone, three of bob's (hidden from her). */
function fifty({ database, links }) {
  database.run("INSERT INTO alpha_items (id, user_id, text) VALUES (1, 1, 'Plan')");
  for (let i = 1; i <= 50; i += 1) database.run('INSERT INTO beta_items (id, user_id, text, done) VALUES (?, 1, ?, ?)', i, `Task ${i}`, i % 4 === 0 ? 1 : 0);
  for (let i = 1; i <= 50; i += 1) links.link(ana, 'alpha:item:1', `beta:item:${i}`);
  database.run('UPDATE beta_items SET deleted = 1 WHERE id IN (7, 8)');
  database.run('UPDATE beta_items SET user_id = 2 WHERE id IN (10, 11, 12)');
}

test('the links of something read the other sides at once: one readMany, the same cards as read() one by one', (t) => {
  const batched = setup(t);
  const single = setup(t, { many: false });
  fifty(batched);
  fifty(single);
  batched.reset();
  single.reset();

  const seen = batched.links.of(ana, 'alpha:item:1');
  assert.deepEqual(seen, single.links.of(ana, 'alpha:item:1'), 'the same answer either way');
  assert.equal(seen.length, 50);
  assert.deepEqual(seen.find((l) => l.item.ref === 'beta:item:4').item, {
    ref: 'beta:item:4', module: 'beta', type: 'item', app: 'Beta', color: '#7C3AED', title: 'Task 4', state: 'done', where: 'Items', url: '/beta/?item=4',
  });
  assert.equal(seen.find((l) => l.item.ref === 'beta:item:7').item.state, 'gone');
  assert.equal(seen.find((l) => l.item.ref === 'beta:item:7').item.title, 'Task 7', 'gone: its last title to who linked it');
  assert.equal(seen.find((l) => l.item.ref === 'beta:item:10').item.state, 'hidden');
  assert.equal('title' in seen.find((l) => l.item.ref === 'beta:item:10').item, false);

  assert.deepEqual(batched.counts.readMany, { beta: 1 }, 'beta asked once');
  assert.deepEqual(batched.counts.read, { alpha: 1 }, 'only the side it is asked from, to check she sees it');
  assert.deepEqual(single.counts.read, { alpha: 1, beta: 50 }, 'without readMany, read() for each');
  assert.equal(batched.counts.uses, 2, 'whether she uses each module, asked once per module');
  assert.ok(batched.counts.queries <= 7, `a list of 50 links in a few queries (${batched.counts.queries})`);
  assert.ok(single.counts.queries >= 50, 'and one per link without it');
});

test('readMany may leave ids out, fail or answer something else: those are read one by one', (t) => {
  const reference = setup(t, { many: false });
  fifty(reference);
  const expected = reference.links.of(ana, 'alpha:item:1');
  for (const many of ['some', 'throws', 'object']) {
    const host = setup(t, { many });
    fifty(host);
    host.reset();
    assert.deepEqual(host.links.of(ana, 'alpha:item:1'), expected, `${many}: the same cards`);
    assert.equal(host.counts.readMany.beta, 1, many);
    // 'some' leaves out every third id: 17 of the 50.
    assert.equal(host.counts.read.beta, many === 'some' ? 17 : 50, many);
  }
});

test('a search shows the cards the owner found as they come: none read again, the same shape as a link’s', (t) => {
  const { database, links, counts, reset } = setup(t);
  for (let i = 1; i <= 35; i += 1) database.run('INSERT INTO beta_items (id, user_id, text) VALUES (?, 1, ?)', i, `Review ${i}`);
  database.run("INSERT INTO beta_items (id, user_id, text) VALUES (99, 2, 'Review of bob')");
  reset();
  const found = links.search(ana, 'beta', 'item', 'Review');
  assert.equal(found.items.length, 30, 'at most 30');
  assert.deepEqual(counts.read, {});
  assert.deepEqual(counts.readMany, {});
  assert.ok(counts.queries <= 3, `a search of 30 cards in a few queries (${counts.queries})`);
  assert.equal(found.creates, true);
  // What a link to it would show.
  database.run("INSERT INTO alpha_items (id, user_id, text) VALUES (1, 1, 'Plan')");
  for (const item of found.items.slice(0, 3)) links.link(ana, 'alpha:item:1', item.ref);
  const shown = new Map(links.of(ana, 'alpha:item:1').map((l) => [l.item.ref, l.item]));
  for (const item of found.items.slice(0, 3)) assert.deepEqual(item, shown.get(item.ref), parseRef(item.ref).id);
  assert.ok(!found.items.some((item) => item.ref === 'beta:item:99'), 'only what the owner’s search gives her');
});

test('the host’s own reads (titles, what is gone) go through readMany too, and a title is written only when it changed', (t) => {
  const { database, links, counts, reset } = setup(t);
  fifty({ database, links });
  const titles = () => database.all("SELECT b_title FROM host_links WHERE a_id = '1' ORDER BY id").map((r) => r.b_title);
  assert.equal(titles()[0], 'Task 1', 'kept when linked');

  // Something changed: every link of it, its sides read at once.
  database.run("UPDATE alpha_items SET text = 'Plan B' WHERE id = 1");
  reset();
  links.changed('alpha:item:1');
  assert.deepEqual(counts.readMany, { beta: 1 });
  assert.deepEqual(counts.read, { alpha: 1 }, 'the side that changed, once for all its links');
  assert.equal(database.get("SELECT COUNT(*) AS n FROM host_links WHERE a_title = 'Plan B'").n, 50);
  const writes = { changed: 0 };
  const before = database.get('SELECT total_changes() AS n').n;
  reset();
  links.changed('alpha:item:1');
  writes.changed = database.get('SELECT total_changes() AS n').n - before;
  assert.equal(writes.changed, 0, 'nothing changed: nothing written');
  assert.ok(counts.queries <= 3, `its links, one read of each side, no writes (${counts.queries})`);

  // Erased: the gone sides forget their titles; a link with both gone goes.
  database.run('DELETE FROM beta_items WHERE id IN (1, 2)');
  reset();
  // 7 and 8 were in the trash already (gone): theirs go too.
  assert.deepEqual(links.prune({ module: 'beta' }), { forgotten: 4, removed: 0 });
  assert.deepEqual(counts.readMany, { beta: 1 });
  assert.deepEqual(counts.read, { alpha: 1 }, 'alpha has no readMany: its one item, read once');
  assert.deepEqual(titles().slice(0, 3), [null, null, 'Task 3']);
  database.run('DELETE FROM alpha_items WHERE id = 1');
  assert.deepEqual(links.prune(), { forgotten: 46, removed: 4 }, 'the four whose both sides went (1, 2, 7, 8); alpha’s title from the rest');
});

test('a module no longer mounted is not gone, and a link whose module left shows hidden', (t) => {
  const { database, links } = setup(t, { alphaMany: 'all' });
  database.run("INSERT INTO alpha_items (id, user_id, text) VALUES (1, 1, 'Plan')");
  database.run("INSERT INTO beta_items (id, user_id, text) VALUES (1, 1, 'Task')");
  links.link(ana, 'alpha:item:1', 'beta:item:1');
  database.run("UPDATE host_links SET b_module = 'gamma'");
  assert.deepEqual(links.prune(), { forgotten: 0, removed: 0 });
  const [only] = links.of(ana, 'alpha:item:1');
  assert.deepEqual(only.item, { ref: 'gamma:item:1', module: 'gamma', type: 'item', app: undefined, color: undefined, state: 'hidden' }, 'a module the host doesn’t have: hidden');
  assert.throws(() => links.of(bob, 'alpha:item:1'), { code: 'not_found' }, 'not his');
});

test('whoever only sees something can’t change its links: link, unlink, «together» or add from it (audit of 6/11, sc-feat-2)', (t) => {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  database.run('INSERT INTO users (id) VALUES (1), (2)');
  linksSchema(database);
  // Ana's items; Bob sees those with viewer = 2 and changes none of hers.
  const items = new Map();
  const put = (mount, id, owner, viewer = null) => items.set(`${mount}:${id}`, { id, owner, viewer, title: `${mount} ${id}`, done: false });
  const cards = (mount) => ({
    item: {
      read(user, id) {
        const row = items.get(`${mount}:${id}`);
        if (!row) return 'gone';
        if (user && row.owner !== user.id && row.viewer !== user.id) return null;
        return { id: row.id, title: row.title, state: row.done ? 'done' : 'open' };
      },
      editable: (user, id) => items.get(`${mount}:${id}`)?.owner === user.id,
      create: (user, data) => { const id = 100 + items.size; put(mount, id, user.id); return id; },
      complete: (user, id, done) => { items.get(`${mount}:${id}`).done = done; },
      search: () => [],
    },
  });
  const modules = [
    { mount: 'alpha', config: { app: { name: 'Alpha' } }, parts: { cards: cards('alpha') } },
    { mount: 'beta', config: { app: { name: 'Beta' } }, parts: { cards: cards('beta') } },
  ];
  const links = createLinks({ database, modules: () => modules });
  put('alpha', 1, 1, 2);   // Ana's task, in a list shared with Bob to view
  put('beta', 1, 1);       // Ana's project task, which Bob can't open
  put('beta', 2, 2);       // Bob's own
  const anas = links.link(ana, 'alpha:item:1', 'beta:item:1');

  // Bob sees the link, can't change it, and is told so for the page.
  const seen = links.of(bob, 'alpha:item:1');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].can_change, false);
  assert.equal(links.canLink(bob, 'alpha:item:1'), false);
  assert.throws(() => links.remove(bob, anas.id), { status: 403 });
  assert.throws(() => links.update(bob, anas.id, { together: true }), { status: 403 });
  assert.throws(() => links.link(bob, 'beta:item:2', 'alpha:item:1'), { status: 403 }, 'no chips of his on her task, either way round');
  assert.throws(() => links.create(bob, 'alpha:item:1', { module: 'beta', type: 'item', data: { title: 'x' } }), { status: 403 });
  assert.equal(links.of(ana, 'alpha:item:1').length, 1, 'her link is still there');

  // Ana changes hers; a link Bob made himself he may unlink.
  assert.equal(links.of(ana, 'alpha:item:1')[0].can_change, true);
  assert.equal(links.canLink(ana, 'alpha:item:1'), true);
  links.update(ana, anas.id, { together: true });
  put('alpha', 3, 2);
  const bobs = links.link(bob, 'alpha:item:3', 'beta:item:2');
  items.get('alpha:3').owner = 1;   // given to Ana since: Bob still made the link
  items.get('alpha:3').viewer = 2;
  assert.equal(links.of(bob, 'alpha:item:3')[0].can_change, true);
  links.remove(bob, bobs.id);
  assert.equal(links.of(ana, 'alpha:item:3').length, 0);

  // A module without editable(): seeing is enough, as before.
  delete modules[0].parts.cards.item.editable;
  delete modules[1].parts.cards.item.editable;
  assert.equal(links.canLink(bob, 'alpha:item:1'), true);
});

test('linking a pair linked already says so, and hands that link (audit of 6/11, sc-feat-11)', (t) => {
  const { database, links } = setup(t);
  database.run("INSERT INTO alpha_items (id, user_id, text) VALUES (1, 1, 'Plan')");
  database.run("INSERT INTO beta_items (id, user_id, text) VALUES (1, 1, 'Task')");
  const made = links.connect(ana, 'alpha:item:1', 'beta:item:1');
  assert.equal(made.existed, false);
  const again = links.connect(ana, 'beta:item:1', 'alpha:item:1', { together: true });
  assert.equal(again.existed, true, 'whichever way');
  assert.equal(again.link.id, made.link.id);
  assert.equal(again.link.together, false, 'as it was');
  assert.equal(links.link(ana, 'alpha:item:1', 'beta:item:1').id, made.link.id, 'link() still gives the link alone');
});

test('a search may leave out where to create: "Link existing…" never shows them (audit of 6/11, sc-feat-15)', (t) => {
  const { database, links, modules } = setup(t);
  database.run("INSERT INTO beta_items (id, user_id, text) VALUES (1, 1, 'Review')");
  let asked = 0;
  const places = modules[1].parts.cards.item.places;
  modules[1].parts.cards.item.places = (user) => { asked += 1; return places(user); };
  for (const text of ['R', 'Re', 'Rev']) assert.deepEqual(links.search(ana, 'beta', 'item', text, { places: false }).places, []);
  assert.equal(asked, 0, 'not at every key');
  assert.deepEqual(links.search(ana, 'beta', 'item', '').places, [{ id: 'inbox', name: 'Inbox' }], 'by default, as before');
  assert.equal(asked, 1);
});

test('likeOf: what was typed, found anywhere, its % _ and \\ as themselves', (t) => {
  assert.equal(likeOf('50%_off\\'), '%50\\%\\_off\\\\%');
  assert.equal(likeOf(null), '%%');
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  database.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('a 50% cut'), ('a 500 cut'), ('snake_case'), ('snakeXcase'), ('back\\slash')");
  const found = (text) => database.all("SELECT x FROM t WHERE x LIKE ? ESCAPE '\\' ORDER BY x", likeOf(text)).map((r) => r.x);
  assert.deepEqual(found('50%'), ['a 50% cut']);
  assert.deepEqual(found('e_c'), ['snake_case']);
  assert.deepEqual(found('k\\s'), ['back\\slash']);
});

test('a title is kept as whoever made the link sees it: a rename they can no longer see never reaches them (audit of 6/11, sc-feat-16)', (t) => {
  const { database, links: _ignored, modules } = setup(t);
  const users = new Map([[1, ana], [2, bob]]);
  const links = createLinks({ database, modules: () => modules, userOf: (id) => users.get(Number(id)) || null });
  database.run("INSERT INTO alpha_items (id, user_id, text) VALUES (1, 1, 'Plan')");
  database.run("INSERT INTO beta_items (id, user_id, text) VALUES (1, 1, 'Shared task')");
  links.link(ana, 'alpha:item:1', 'beta:item:1');
  const title = () => database.get('SELECT b_title FROM host_links').b_title;
  database.run("UPDATE beta_items SET text = 'Renamed' WHERE id = 1");
  links.changed('beta:item:1');
  assert.equal(title(), 'Renamed', 'while she sees it, it follows');
  // Not hers any more, then renamed and deleted.
  database.run("UPDATE beta_items SET user_id = 2, text = 'Secret plan' WHERE id = 1");
  links.changed('beta:item:1');
  assert.equal(title(), 'Renamed', 'what she last saw');
  database.run('UPDATE beta_items SET deleted = 1 WHERE id = 1');
  assert.equal(links.of(ana, 'alpha:item:1')[0].item.title, 'Renamed', 'gone: the title she knew, not the one after');
  // Its maker's account gone: nothing kept for anyone.
  database.run("INSERT INTO beta_items (id, user_id, text) VALUES (2, 1, 'Orphan')");
  links.link(ana, 'alpha:item:1', 'beta:item:2');
  users.delete(1);
  database.run("UPDATE beta_items SET text = 'Orphan renamed' WHERE id = 2");
  links.changed('beta:item:2');
  assert.equal(database.get("SELECT b_title FROM host_links WHERE b_id = '2'").b_title, 'Orphan');
});
