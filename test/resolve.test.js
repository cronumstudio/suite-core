import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ResolveError, resolveErrorText, nameKey, keywords, stopwords, numberRef, byNumber, score, matchByName,
} from '../resolve.js';
import { parseNaturalDate } from '../dates.js';

const items = (...names) => names.map((name, i) => ({ id: i + 1, name }));
const fails = (fn, pattern) => assert.throws(fn, (err) => err instanceof ResolveError && pattern.test(err.message));

test('nameKey folds accents and signs, and keeps every alphabet and emoji', () => {
  assert.equal(nameKey('  Café  Molido! '), 'cafe molido');
  assert.equal(nameKey('Straße'), 'strasse');
  assert.equal(nameKey('Œufs'), 'oeufs');
  assert.equal(nameKey('Магазин'), 'магазин');
  assert.equal(nameKey('買い物'), '買い物');
  assert.equal(nameKey('🎂'), '🎂');
  assert.equal(nameKey(null), '');
});

test('keywords drop filler words in four languages, plus the module\'s own', () => {
  assert.deepEqual(keywords('the online shop'), ['online', 'shop']);
  assert.deepEqual(keywords('la lista de la compra'), ['lista', 'compra']);
  assert.deepEqual(keywords('la lista de la compra', stopwords('lista')), ['compra']);
  assert.deepEqual(keywords('de la'), ['de', 'la'], 'only filler words → all of them');
  assert.deepEqual(keywords('Send to Ana'), ['send', 'to', 'ana'], '"to" is a word that matters');
});

test('a bare number is an id, never part of a name', () => {
  assert.equal(numberRef('#12'), '12');
  assert.equal(numberRef(' 12 '), '12');
  assert.equal(numberRef('id 12'), '12');
  assert.equal(numberRef('id12'), '12');
  assert.equal(numberRef('12 monkeys'), null);
  const list = [{ id: 1, name: 'Phase 12' }, { id: 7, name: '2026' }];
  assert.equal(byNumber(list, '12'), null);
  assert.equal(byNumber(list, '2026').id, 7, 'a whole name that is the number');
  assert.equal(byNumber(list, '7').id, 7);
  fails(() => matchByName(list, '#12', { label: 'the phase' }), /Nothing is #12 \(the phase\)/);
});

test('an empty name or reference matches nothing', () => {
  assert.deepEqual(score(items('Магазин', '🎂', '!!!'), 'shop'), []);
  assert.deepEqual(score(items('Shop'), '   '), []);
  fails(() => matchByName(items('Shop'), '  '), /Missing item/);
  assert.equal(matchByName(items('Магазин', '🎂'), '🎂').id, 2);
});

test('scoring: exact → same words → prefix → contains → overlap', () => {
  const list = items('Online shop', 'Shop', 'The shop', 'Shopping list', 'Old workshop', 'Shop online now');
  const points = Object.fromEntries(score(list, 'shop').map((s) => [s.item.name, s.points]));
  assert.equal(points.Shop, 100);
  assert.equal(points['The shop'], 95);
  assert.equal(points['Shopping list'], 80);
  assert.equal(points['Old workshop'], 70);
  assert.equal(score(items('Web shop redesign'), 'redesign web').at(0).points > 30, true);
});

test('reading takes the best; writing (strict) asks unless it is clear', () => {
  const list = items('Cafe', 'Café', 'Garden');
  assert.equal(matchByName(list, 'garden').id, 3);
  assert.equal(matchByName(list, 'cafe').id, 1, 'reading: a tie at 100 is taken');
  fails(() => matchByName(list, 'cafe', { strict: true }), /ambiguous/);
  const go = items('Go');
  assert.equal(matchByName(go, 'Google Ads campaign').id, 1, 'reading takes a name inside the reference');
  fails(() => matchByName(go, 'Google Ads campaign', { strict: true }), /Nothing is clearly/);
  const err = (() => { try { matchByName(list, 'cafe', { strict: true }); } catch (e) { return e; } })();
  assert.deepEqual(err.options, ['Cafe (#1)', 'Café (#2)']);
  assert.match(resolveErrorText(err), /\nOptions:\n- Cafe \(#1\)\n- Café \(#2\)$/);
});

test('create: a new name is null, a half-match is asked with the hint', () => {
  const list = items('Online shop', 'Garden');
  assert.equal(matchByName(list, 'Kitchen', { create: true }), null);
  assert.equal(matchByName(list, 'the online shop', { create: true }).id, 1);
  fails(() => matchByName(list, 'shop redesign', { create: 'Call again with new=true.' }), /clearly.*new=true/);
  fails(() => matchByName(list, 'Kitchen'), /Can't find item "Kitchen"/);
});

test('parseNaturalDate: ISO, strict and in range', () => {
  const today = '2026-10-23';   // a Friday
  assert.equal(parseNaturalDate('2026-12-24', { today }), '2026-12-24');
  assert.equal(parseNaturalDate('2026-12-24T10:00:00Z', { today }), '2026-12-24');
  assert.equal(parseNaturalDate('', { today }), null);
  assert.equal(parseNaturalDate(null, { today }), null);
  fails(() => parseNaturalDate('2026-02-31', { today }), /Can.t understand the date "[^"]*": that day doesn.t exist/);
  fails(() => parseNaturalDate('2026-13-01', { today }), /Can.t understand the date "[^"]*": that day doesn.t exist/);
  fails(() => parseNaturalDate('2206-01-01', { today }), /Can.t understand the date "[^"]*": that day doesn.t exist/);
  fails(() => parseNaturalDate('2026-01-011', { today }), /Can't understand/);
});

test('parseNaturalDate: words in four languages, from the person\'s today', () => {
  const today = '2026-10-23';   // a Friday
  const at = (v) => parseNaturalDate(v, { today });
  assert.equal(at('hoy'), today);
  assert.equal(at('Tomorrow'), '2026-10-24');
  assert.equal(at('pasado mañana'), '2026-10-25');
  assert.equal(at("aujourd'hui"), today);
  assert.equal(at('übermorgen'), '2026-10-25');
  assert.equal(at('gestern'), '2026-10-22');
  assert.equal(at('in 3 days'), '2026-10-26');
  assert.equal(at('en una semana'), '2026-10-30');
  assert.equal(at('dans 2 semaines'), '2026-11-06');
  assert.equal(at('en 2 meses'), '2026-12-23');
  assert.equal(parseNaturalDate('in 1 month', { today: '2026-01-31' }), '2026-02-28', 'the month\'s last day');
  assert.equal(parseNaturalDate('in 1 month', { today: '2028-01-31' }), '2028-02-29');
  assert.equal(at('in 3 months'), '2027-01-23');
  assert.equal(at('friday'), '2026-10-30', 'today is Friday: a week from now');
  assert.equal(at('el próximo lunes'), '2026-10-26');
  assert.equal(at('vie'), '2026-10-30');
  assert.equal(at('mar'), '2026-10-27');
  assert.equal(at('vendredi prochain'), '2026-10-30');
  assert.equal(at('am nächsten Mittwoch'), '2026-10-28');
});

test('parseNaturalDate: day-first numbers, never rolled over', () => {
  const today = '2026-10-23';
  const at = (v) => parseNaturalDate(v, { today });
  assert.equal(at('24/12'), '2026-12-24');
  assert.equal(at('24.12.'), '2026-12-24');
  assert.equal(at('24.12.2027'), '2027-12-24');
  assert.equal(at('24-12-27'), '2027-12-24');
  assert.equal(at('23/10'), today, 'today counts');
  assert.equal(at('22/10'), '2027-10-22', 'gone this year → next year');
  assert.equal(at('29/02'), '2028-02-29');
  fails(() => at('31/02/2027'), /Can.t understand the date "[^"]*": that day doesn.t exist/);
  fails(() => at('13.45'), /Can.t understand the date "[^"]*": that day doesn.t exist/);
  fails(() => at('soon'), /Can't understand the date "soon"/);
  fails(() => parseNaturalDate('soon', { today, field: 'the due date' }), /the due date "soon"/);
});
