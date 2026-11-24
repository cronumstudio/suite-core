/**
 * Sample data (sample-data.js) without a server: what each module is asked, what is written down,
 * what goes when it is taken away and what stays, and the links between the modules' anchors.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.js';
import { createLinks, linksSchema } from '../links.js';
import { createSampleData, sampleDataSchema } from '../sample-data.js';
import { HttpError } from '../http.js';
import { todayFor, currentZone } from '../time.js';

const ana = { id: 1, prefs: JSON.stringify({ lang: 'es', tz: 'Pacific/Kiritimati' }) };
const bob = { id: 2, prefs: '{}' };

/**
 * A host with three modules: alpha and beta make an example (two things each, the second one the
 * anchor `shared`), gamma has none. `options.broken`: a module whose seed throws after writing.
 */
function setup(t, { broken = null, uses = () => true } = {}) {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  database.run('INSERT INTO users (id) VALUES (1), (2)');
  linksSchema(database);
  sampleDataSchema(database);
  const asked = [];
  const moduleOf = (mount, { sample = true } = {}) => {
    const table = `${mount}_items`;
    database.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT)`);
    const card = (row) => ({ id: row.id, title: row.text, state: 'open' });
    const parts = {
      cards: {
        item: {
          read: (user, id) => {
            const row = database.get(`SELECT * FROM ${table} WHERE id = ?`, Number(id));
            if (!row) return 'gone';
            return user && row.user_id !== user.id ? null : card(row);
          },
          search: () => [],
        },
      },
    };
    if (sample) {
      parts.sampleData = {
        seed: ({ user, userId, locale, today }) => {
          asked.push({ mount, userId, locale, today, zone: currentZone(), same: user.id === userId });
          const texts = [`${mount} ${locale}`, `${mount} shared`];
          const ids = texts.map((text) => database.run(`INSERT INTO ${table} (user_id, text) VALUES (?, ?)`, userId, text).lastInsertRowid);
          if (broken === mount) throw new Error('the oven is cold');
          return {
            items: ids.map((id, i) => ({ type: 'item', id, stamp: texts[i] })),
            anchors: { shared: { type: 'item', id: ids[1] }, 'Not one': { type: 'item', id: ids[0] } },
          };
        },
        // What is still as made goes; what was changed stays.
        remove: ({ userId, items }) => {
          asked.push({ mount, removing: items.map((item) => item.id) });
          const removed = [];
          for (const item of items) {
            const row = database.get(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`, Number(item.id), userId);
            if (row && row.text === item.stamp) {
              database.run(`DELETE FROM ${table} WHERE id = ?`, row.id);
              removed.push({ type: item.type, id: item.id });
            }
          }
          return { removed };
        },
      };
    }
    return { mount, config: { app: { name: mount } }, parts };
  };
  const mods = [moduleOf('alpha'), moduleOf('beta'), moduleOf('gamma', { sample: false })];
  const lines = [];
  const links = createLinks({ database, modules: () => mods, uses });
  const samples = createSampleData({ database, modules: () => mods, uses, links, log: (line) => lines.push(line) });
  return { database, samples, asked, lines };
}

const items = (database, mount) => database.all(`SELECT text FROM ${mount}_items ORDER BY id`).map((row) => row.text);

test('the example comes from every module that has one, in the person’s language and their today', (t) => {
  const { database, samples, asked } = setup(t);
  assert.deepEqual(samples.status(ana), { present: false, modules: [], available: ['alpha', 'beta'] });
  const answer = samples.seed(ana);
  assert.deepEqual(answer, { present: true, modules: ['alpha', 'beta'], failed: [], links: 1 });
  assert.deepEqual(asked.map(({ mount, locale, today, zone, same }) => ({ mount, locale, today, zone, same })), [
    { mount: 'alpha', locale: 'es', today: todayFor(ana), zone: 'Pacific/Kiritimati', same: true },
    { mount: 'beta', locale: 'es', today: todayFor(ana), zone: 'Pacific/Kiritimati', same: true },
  ], 'each module once, with the language they chose and the day where they are');
  assert.deepEqual(items(database, 'alpha'), ['alpha es', 'alpha shared']);
  assert.deepEqual(samples.status(ana), { present: true, modules: ['alpha', 'beta'], available: ['alpha', 'beta'] });
  // The two anchors of the same name are linked; one whose name isn't one is left out.
  const link = database.get('SELECT * FROM host_links');
  assert.deepEqual([link.a_module, link.b_module, link.created_by], ['alpha', 'beta', 1]);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM host_links').n, 1);
  assert.deepEqual(samples.status(bob).present, false, 'another account has none');
});

test('a language asked for wins, then the one chosen, then the browser’s, then English', (t) => {
  const { samples } = setup(t);
  assert.equal(samples.localeOf(ana, 'fr-FR'), 'fr');
  assert.equal(samples.localeOf(ana, null, 'de'), 'es');
  assert.equal(samples.localeOf(bob, null, 'de-DE,de;q=0.9'), 'de');
  assert.equal(samples.localeOf({ id: 2, locale: 'it_IT' }, null, 'de'), 'it');
  assert.equal(samples.localeOf(bob, 'xx', 'yy'), 'en');
  const { samples: again, asked } = setup(t);
  again.seed(bob, { locale: 'fr' });
  assert.deepEqual(asked.map((a) => a.locale), ['fr', 'fr']);
});

test('one example at a time: seeding again while it is there is a 409, and nothing is made twice', (t) => {
  const { database, samples } = setup(t);
  samples.seed(ana);
  assert.throws(() => samples.seed(ana), (err) => err instanceof HttpError && err.status === 409 && err.code === 'sample_data_present');
  assert.deepEqual(items(database, 'alpha'), ['alpha es', 'alpha shared']);
  assert.throws(() => samples.seed(null), (err) => err.status === 401);
});

test('taking it away removes what is still as made, keeps what was changed or made by the person, and forgets it all', (t) => {
  const { database, samples } = setup(t);
  samples.seed(ana);
  // The person changed one thing of the example and added one of their own.
  database.run("UPDATE beta_items SET text = 'beta, mine now' WHERE text = 'beta es'");
  database.run("INSERT INTO alpha_items (user_id, text) VALUES (1, 'my own')");
  const answer = samples.remove(ana);
  assert.deepEqual(answer, { present: false, removed: 3, kept: 1, failed: [] });
  assert.deepEqual(items(database, 'alpha'), ['my own']);
  assert.deepEqual(items(database, 'beta'), ['beta, mine now']);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM host_links').n, 0, 'a link whose side went goes too');
  assert.deepEqual(samples.status(ana), { present: false, modules: [], available: ['alpha', 'beta'] });
  // And it can be added again.
  assert.equal(samples.seed(ana).present, true);
});

test('a link between two things the person kept stays theirs', (t) => {
  const { database, samples } = setup(t);
  samples.seed(ana);
  database.run("UPDATE alpha_items SET text = 'alpha, kept' WHERE text = 'alpha shared'");
  database.run("UPDATE beta_items SET text = 'beta, kept' WHERE text = 'beta shared'");
  samples.remove(ana);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM host_links').n, 1);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM host_sample_items').n, 0);
});

test('a module whose seed fails leaves nothing of it behind and is named; the others go on', (t) => {
  const { database, samples, lines } = setup(t, { broken: 'alpha' });
  const answer = samples.seed(ana);
  assert.deepEqual(answer, { present: true, modules: ['beta'], failed: ['alpha'], links: 0 });
  assert.deepEqual(items(database, 'alpha'), [], 'its transaction rolled back');
  assert.deepEqual(lines, ['[sample-data] alpha seed: the oven is cold']);
});

test('only the modules the person uses are asked', (t) => {
  const { samples, asked } = setup(t, { uses: (user, mount) => mount !== 'alpha' });
  assert.deepEqual(samples.status(ana).available, ['beta']);
  assert.deepEqual(samples.seed(ana).modules, ['beta']);
  assert.deepEqual(asked.map((a) => a.mount), ['beta']);
});

test('what a seed says it made is checked, and an asynchronous seed is refused', (t) => {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  database.run('INSERT INTO users (id) VALUES (1)');
  sampleDataSchema(database);
  const lines = [];
  const remove = () => ({ removed: [] });
  const mods = [
    { mount: 'late', parts: { sampleData: { seed: async () => ({ items: [] }), remove } } },
    { mount: 'odd', parts: { sampleData: { seed: () => ({ items: [{ type: 'Bad Type', id: 1 }] }), remove } } },
    { mount: 'none', parts: { sampleData: { seed: () => null, remove } } },
    { mount: 'empty', parts: { sampleData: { seed: () => ({ items: [] }), remove } } },
  ];
  const samples = createSampleData({ database, modules: () => mods, log: (line) => lines.push(line) });
  assert.deepEqual(samples.seed(ana), { present: false, modules: [], failed: ['late', 'odd', 'none'], links: 0 });
  assert.equal(lines.length, 3);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM host_sample_items').n, 0);
});
