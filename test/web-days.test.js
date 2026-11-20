/**
 * Days in the browser (web/days.js): the day a moment falls on where the person is, and a day moved
 * by some days, in four zones, at the edges of a month, a year, February and a summer time change.
 * The zone is this process's (TZ), set test by test.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, addDays, daysBetween } from '../web/days.js';
import { addDays as serverAddDays } from '../time.js';

const ZONES = ['Europe/Madrid', 'America/Mexico_City', 'Pacific/Auckland', 'UTC'];
const zoneBefore = process.env.TZ;
after(() => {
  if (zoneBefore === undefined) delete process.env.TZ;
  else process.env.TZ = zoneBefore;
});
const inZone = (zone, fn) => {
  process.env.TZ = zone;
  return fn();
};

test('dayKey: the day a moment falls on here, not its day in UTC', () => {
  // 23:30 UTC on 20 November: already the 21st in Madrid, still the 20th in Mexico City.
  const late = Date.UTC(2026, 10, 20, 23, 30);
  assert.equal(inZone('Europe/Madrid', () => dayKey(late)), '2026-11-21');
  assert.equal(inZone('America/Mexico_City', () => dayKey(late)), '2026-11-20');
  assert.equal(inZone('America/Mexico_City', () => dayKey(Date.UTC(2026, 10, 21, 0, 30))), '2026-11-20', 'its evening');
  inZone('Europe/Madrid', () => {
    assert.equal(dayKey(new Date(late)), '2026-11-21', 'a Date');
    assert.equal(dayKey(new Date(late).toISOString()), '2026-11-21', 'an ISO moment');
  });
});

test('dayKey: the last minute of a month and a year, a leap day, and both nights of a summer time change', () => {
  inZone('Europe/Madrid', () => {
    assert.equal(dayKey(new Date(2026, 0, 31, 23, 59)), '2026-01-31');
    assert.equal(dayKey(new Date(2026, 1, 1, 0, 0)), '2026-02-01');
    assert.equal(dayKey(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
    assert.equal(dayKey(new Date(2027, 0, 1, 0, 0)), '2027-01-01');
    assert.equal(dayKey(new Date(2028, 1, 29, 12, 0)), '2028-02-29');
    // Madrid's clocks go forward at 02:00 on 29 March 2026 and back at 03:00 on 25 October.
    assert.equal(dayKey(Date.UTC(2026, 2, 28, 22, 59)), '2026-03-28', '23:59 of the night before');
    assert.equal(dayKey(Date.UTC(2026, 2, 28, 23, 0)), '2026-03-29', 'its midnight');
    assert.equal(dayKey(Date.UTC(2026, 2, 29, 21, 59)), '2026-03-29', 'its last minute, in summer time');
    assert.equal(dayKey(Date.UTC(2026, 2, 29, 22, 0)), '2026-03-30');
    assert.equal(dayKey(Date.UTC(2026, 9, 24, 21, 59)), '2026-10-24');
    assert.equal(dayKey(Date.UTC(2026, 9, 24, 22, 0)), '2026-10-25', 'midnight, still summer time');
    assert.equal(dayKey(Date.UTC(2026, 9, 25, 22, 59)), '2026-10-25', 'its last minute, in winter time');
    assert.equal(dayKey(Date.UTC(2026, 9, 25, 23, 0)), '2026-10-26');
  });
});

test('addDays: across a month, a year, February and a summer time change, the same in every zone', () => {
  const cases = [
    ['2026-01-31', 1, '2026-02-01'], ['2026-03-01', -1, '2026-02-28'], ['2028-02-28', 1, '2028-02-29'],
    ['2028-02-28', 2, '2028-03-01'], ['2026-12-31', 1, '2027-01-01'], ['2027-01-01', -1, '2026-12-31'],
    ['2026-03-28', 1, '2026-03-29'], ['2026-03-29', 1, '2026-03-30'], ['2026-10-25', 1, '2026-10-26'],
    ['2026-10-26', -1, '2026-10-25'], ['2026-11-20', 0, '2026-11-20'], ['2026-11-20', 7, '2026-11-27'],
    ['2026-11-20', 400, '2027-12-25'], ['2026-11-20', -400, '2025-10-16'],
  ];
  for (const zone of ZONES) {
    inZone(zone, () => {
      for (const [day, n, want] of cases) assert.equal(addDays(day, n), want, `${zone}: ${day} ${n}`);
    });
  }
});

test('daysBetween: whole days, across a month, a year, February and a summer time change, in every zone', () => {
  const cases = [
    ['2026-11-20', '2026-11-20', 0], ['2026-01-31', '2026-02-01', 1], ['2026-02-01', '2026-01-31', -1],
    ['2028-02-28', '2028-03-01', 2], ['2026-12-31', '2027-01-01', 1], ['2026-03-28', '2026-03-30', 2],
    ['2026-10-24', '2026-10-26', 2], ['2025-10-16', '2026-11-20', 400],
  ];
  for (const zone of ZONES) {
    inZone(zone, () => {
      for (const [a, b, want] of cases) assert.equal(daysBetween(a, b), want, `${zone}: ${a} → ${b}`);
    });
  }
  for (let day = '2026-01-01'; day < '2029-01-01'; day = addDays(day, 1)) {
    for (const n of [-366, -1, 0, 1, 31, 366]) assert.equal(daysBetween(day, addDays(day, n)), n, `${day} ${n}`);
  }
});

test('addDays: no day stays none, and every answer is the server’s for the same day (time.js)', () => {
  assert.equal(addDays(null, 3), null);
  assert.equal(addDays('', 3), '');
  assert.equal(addDays(undefined, 3), undefined);
  inZone('America/Mexico_City', () => {
    for (let day = '2026-01-01'; day < '2029-01-01'; day = addDays(day, 1)) {
      for (const n of [-366, -31, -1, 0, 1, 7, 31, 366]) assert.equal(addDays(day, n), serverAddDays(day, n), `${day} ${n}`);
    }
  });
});
