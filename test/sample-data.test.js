/**
 * Sample data (sample-data.js) without a server: what each module is asked, what is written down,
 * the examples to choose from, what goes when it is taken away, and the links between the modules'
 * anchors.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.js';
import { createLinks, linksSchema } from '../links.js';
import { createSampleData, sampleDataSchema, sampleDataOption } from '../sample-data.js';
import { HttpError } from '../http.js';
import { todayFor, currentZone } from '../time.js';

const ana = { id: 1, prefs: JSON.stringify({ lang: 'es', tz: 'Pacific/Kiritimati' }) };
const bob = { id: 2, prefs: '{}' };

/**
 * A host with three modules: alpha and beta make an example (two things each, the second one the
 * anchor `shared`; `extra`, a third thing that stands for what the person put inside the example),
 * gamma has none. `options.broken`: a module whose seed throws after writing.
 */
function setup(t, { broken = null, uses = () => true, examples = ['cafe', 'app'] } = {}) {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  database.run('INSERT INTO users (id) VALUES (1), (2)');
  linksSchema(database);
  sampleDataSchema(database);
  const asked = [];
  const moduleOf = (mount, { sample = true } = {}) => {
    const table = `${mount}_items`;
    database.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT, inside INTEGER)`);
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
        seed: ({ user, userId, locale, today, example }) => {
          asked.push({ mount, userId, locale, today, example, zone: currentZone(), same: user.id === userId });
          const texts = [`${mount} ${example} ${locale}`, `${mount} shared`];
          const ids = texts.map((text) => database.run(`INSERT INTO ${table} (user_id, text, inside) VALUES (?, ?, 1)`, userId, text).lastInsertRowid);
          if (broken === mount) throw new Error('the oven is cold');
          return {
            items: ids.map((id) => ({ type: 'item', id })),
            anchors: { shared: { type: 'item', id: ids[1] }, 'Not one': { type: 'item', id: ids[0] } },
          };
        },
        // All it made goes, and whatever was put inside it (`inside`), changed or not.
        remove: ({ userId, items }) => {
          asked.push({ mount, removing: items.map((item) => item.id) });
          for (const item of items) database.run(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`, Number(item.id), userId);
          database.run(`DELETE FROM ${table} WHERE inside = 1 AND user_id = ?`, userId);
          return { removed: items };
        },
      };
    }
    return { mount, config: { app: { name: mount } }, parts };
  };
  const mods = [moduleOf('alpha'), moduleOf('beta'), moduleOf('gamma', { sample: false })];
  const lines = [];
  const links = createLinks({ database, modules: () => mods, uses });
  const samples = createSampleData({ database, modules: () => mods, uses, links, examples, log: (line) => lines.push(line) });
  return { database, samples, asked, lines, links };
}

const items = (database, mount) => database.all(`SELECT text FROM ${mount}_items ORDER BY id`).map((row) => row.text);

test('the example comes from every module that has one, in the person’s language and their today', (t) => {
  const { database, samples, asked } = setup(t);
  assert.deepEqual(samples.status(ana), { present: false, example: null, modules: [], available: ['alpha', 'beta'], examples: ['cafe', 'app'] });
  const answer = samples.seed(ana);
  assert.deepEqual(answer, { present: true, example: 'cafe', modules: ['alpha', 'beta'], failed: [], links: 1 });
  assert.deepEqual(asked.map(({ mount, locale, today, example, zone, same }) => ({ mount, locale, today, example, zone, same })), [
    { mount: 'alpha', locale: 'es', today: todayFor(ana), example: 'cafe', zone: 'Pacific/Kiritimati', same: true },
    { mount: 'beta', locale: 'es', today: todayFor(ana), example: 'cafe', zone: 'Pacific/Kiritimati', same: true },
  ], 'each module once, with the first example, the language they chose and the day where they are');
  assert.deepEqual(items(database, 'alpha'), ['alpha cafe es', 'alpha shared']);
  assert.deepEqual(samples.status(ana), { present: true, example: 'cafe', modules: ['alpha', 'beta'], available: ['alpha', 'beta'], examples: ['cafe', 'app'] });
  // The two anchors of the same name are linked; one whose name isn't one is left out.
  const link = database.get('SELECT * FROM host_links');
  assert.deepEqual([link.a_module, link.b_module, link.created_by], ['alpha', 'beta', 1]);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM host_links').n, 1);
  assert.deepEqual(samples.status(bob).present, false, 'another account has none');
});

test('the person chooses the example; one the host doesn’t have is a 400 naming them', (t) => {
  const { database, samples, asked } = setup(t);
  assert.equal(samples.seed(bob, { example: 'app' }).example, 'app');
  assert.deepEqual(asked.map((a) => a.example), ['app', 'app']);
  assert.equal(samples.status(bob).example, 'app');
  assert.deepEqual(items(database, 'beta'), ['beta app en', 'beta shared']);
  assert.throws(() => samples.seed(ana, { example: 'castle' }),
    (err) => err instanceof HttpError && err.status === 400 && err.extra?.field === 'example' && err.extra.options.join() === 'cafe,app');
});

test('the host’s option: true is one example, a list several, with the prefix of their names', () => {
  assert.equal(sampleDataOption(false), null);
  assert.deepEqual(sampleDataOption(true), { examples: ['default'], words: null });
  assert.deepEqual(sampleDataOption({ examples: ['cafe', 'app', 'cafe', 'Not One'], words: 'samples.' }), { examples: ['cafe', 'app'], words: 'samples.' });
  assert.deepEqual(sampleDataOption({ examples: [] }), { examples: ['default'], words: null });
  assert.deepEqual(sampleDataOption({ examples: ['cafe'], words: '<b>' }), { examples: ['cafe'], words: null });
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
  assert.throws(() => samples.seed(ana, { example: 'app' }), (err) => err instanceof HttpError && err.status === 409 && err.code === 'sample_data_present');
  assert.deepEqual(items(database, 'alpha'), ['alpha cafe es', 'alpha shared']);
  assert.throws(() => samples.seed(null), (err) => err.status === 401);
});

test('taking it away removes all of it, also what was changed or put inside it, and forgets it', (t) => {
  const { database, samples, asked } = setup(t);
  samples.seed(ana);
  // The person changed a thing of the example, put one of their own inside it, and has one outside it.
  database.run("UPDATE beta_items SET text = 'beta, changed' WHERE text = 'beta cafe es'");
  database.run("INSERT INTO alpha_items (user_id, text, inside) VALUES (1, 'mine, inside', 1)");
  database.run("INSERT INTO alpha_items (user_id, text, inside) VALUES (1, 'mine, outside', 0)");
  const answer = samples.remove(ana);
  assert.deepEqual(answer, { present: false, removed: 4, failed: [] });
  assert.deepEqual(asked.filter((a) => a.removing).map((a) => [a.mount, a.removing.length]), [['alpha', 2], ['beta', 2]]);
  assert.deepEqual(items(database, 'alpha'), ['mine, outside']);
  assert.deepEqual(items(database, 'beta'), []);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM host_links').n, 0, 'the links it made go');
  assert.deepEqual(samples.status(ana), { present: false, example: null, modules: [], available: ['alpha', 'beta'], examples: ['cafe', 'app'] });
  // And another one can be added.
  assert.equal(samples.seed(ana, { example: 'app' }).example, 'app');
});

test('a link of the person’s own to a thing of the example goes with it; one between their own things stays', (t) => {
  const { database, samples, links } = setup(t);
  samples.seed(ana);
  const mine = database.run("INSERT INTO alpha_items (user_id, text, inside) VALUES (1, 'mine', 0)").lastInsertRowid;
  const other = database.run("INSERT INTO beta_items (user_id, text, inside) VALUES (1, 'mine too', 0)").lastInsertRowid;
  const sample = database.get("SELECT id FROM beta_items WHERE text = 'beta cafe es'").id;
  links.connect(ana, { module: 'alpha', type: 'item', id: String(mine) }, { module: 'beta', type: 'item', id: String(sample) });
  links.connect(ana, { module: 'alpha', type: 'item', id: String(mine) }, { module: 'beta', type: 'item', id: String(other) });
  assert.equal(database.get('SELECT COUNT(*) AS n FROM host_links').n, 3);
  samples.remove(ana);
  const left = database.all('SELECT a_id, b_id FROM host_links');
  assert.deepEqual(left.map((l) => [l.a_id, l.b_id]), [[String(mine), String(other)]]);
});

test('a module whose seed fails leaves nothing of it behind and is named; the others go on', (t) => {
  const { database, samples, lines } = setup(t, { broken: 'alpha' });
  const answer = samples.seed(ana);
  assert.deepEqual(answer, { present: true, example: 'cafe', modules: ['beta'], failed: ['alpha'], links: 0 });
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
  assert.deepEqual(samples.seed(ana), { present: false, example: 'default', modules: [], failed: ['late', 'odd', 'none'], links: 0 });
  assert.equal(lines.length, 3);
  assert.equal(database.get('SELECT COUNT(*) AS n FROM host_sample_items').n, 0);
  assert.equal(samples.status(ana).present, false, 'nothing made: no example to take away');
});
