/**
 * The people one already shares with, as chips (web/people.js), without a browser: picked one
 * or several, cleared, given other people; and every share sent, with one notice of how it went.
 * The texts are the core's English catalog.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom, FakeElement } from './fake-dom.js';

const document = installFakeDom();
FakeElement.prototype.focus = function focus() {};
Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {} });
globalThis.location = { href: 'https://app.example.com/', origin: 'https://app.example.com', reload: () => {} };
globalThis.window = { location: globalThis.location };

const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });

const { loadLanguage, t } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
const { peopleChips, shareWithEach } = await import('../web/people.js');

const PEOPLE = [{ id: 2, name: 'Ana' }, { id: 4, name: 'Ben' }, { id: 7, name: 'Carla' }];
const chipsOf = (node) => node.all().filter((n) => n.tagName === 'BUTTON');
const chipNamed = (node, name) => chipsOf(node).find((n) => n.textContent === name);
const toasts = () => document.body.all().filter((n) => (n.getAttribute('class') || '').includes('kit-toast')).map((n) => n.textContent);

test('a chip for each person, picked and unpicked by tapping, several at once', () => {
  const changes = [];
  const chips = peopleChips(PEOPLE, { onChange: (ids) => changes.push(ids) });
  assert.equal(chips.node.hidden, false);
  assert.match(chips.node.textContent, new RegExp(t('kit.people.label')));
  assert.deepEqual(chipsOf(chips.node).map((n) => n.textContent), ['Ana', 'Ben', 'Carla']);
  assert.ok(chipsOf(chips.node).every((n) => n.getAttribute('aria-pressed') === 'false'));

  chipNamed(chips.node, 'Carla').dispatch('click');
  chipNamed(chips.node, 'Ana').dispatch('click');
  assert.deepEqual(chips.selected(), [2, 7], 'in the order of the chips');
  assert.equal(chipNamed(chips.node, 'Ana').getAttribute('aria-pressed'), 'true');
  chipNamed(chips.node, 'Ana').dispatch('click');
  assert.deepEqual(chips.selected(), [7]);
  assert.deepEqual(changes.at(-1), [7]);

  chips.clear();
  assert.deepEqual(chips.selected(), []);
  assert.ok(chipsOf(chips.node).every((n) => n.getAttribute('aria-pressed') === 'false'));
});

test('some picked from the start, if they are among the people', () => {
  const chips = peopleChips(PEOPLE, { selected: [4, 99] });
  assert.deepEqual(chips.selected(), [4]);
  assert.equal(chipNamed(chips.node, 'Ben').getAttribute('aria-pressed'), 'true');
});

test('nobody to offer: no chips and nothing shown; other people keep what is still there picked', () => {
  assert.equal(peopleChips([]).node.hidden, true);
  assert.equal(peopleChips().node.textContent, '');

  const chips = peopleChips(PEOPLE);
  chipNamed(chips.node, 'Ben').dispatch('click');
  chipNamed(chips.node, 'Carla').dispatch('click');
  chips.set(PEOPLE.filter((p) => p.id !== 7));
  assert.deepEqual(chips.selected(), [4], 'Carla, who has it now, is gone; Ben stays picked');
  assert.equal(chipNamed(chips.node, 'Ben').getAttribute('aria-pressed'), 'true');
  chips.set([]);
  assert.equal(chips.node.hidden, true);
});

test('every share sent one after another, and one notice of how it went', async () => {
  const sent = [];
  let result = await shareWithEach([PEOPLE[0], PEOPLE[1], { email: 'dan@example.com', name: 'dan@example.com' }],
    async (target) => { sent.push(target.id ?? target.email); });
  assert.deepEqual(sent, [2, 4, 'dan@example.com']);
  assert.equal(result.done.length, 3);
  assert.ok(toasts().includes(t('kit.people.sharedMany', { count: 3 })));

  result = await shareWithEach([PEOPLE[2]], async () => {});
  assert.ok(toasts().includes(t('kit.people.sharedOne', { name: 'Carla' })));

  result = await shareWithEach([PEOPLE[0], { email: 'nobody@example.com', name: 'nobody@example.com' }], async (target) => {
    if (target.email) { const err = new Error('Not found'); err.status = 404; throw err; }
  });
  assert.deepEqual(result.done.map((p) => p.id), [2], 'the one that went stays');
  assert.equal(result.failed.length, 1);
  const notice = toasts().at(-1);
  assert.match(notice, new RegExp(t('kit.people.sharedSome', { count: 1 })));
  assert.match(notice, /nobody@example\.com/, 'the refused one by name');

  const before = toasts().length;
  result = await shareWithEach([], async () => {});
  assert.equal(toasts().length, before, 'nothing to share, nothing said');
});
