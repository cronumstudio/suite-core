import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  knownTimeZone, SERVER_TIME_ZONE, zoneOf, inZoneOf, currentZone, dayIn, addDays, todayIn, todayFor, daysSince,
} from '../time.js';

test('knownTimeZone canonicalises IANA names and refuses the rest', () => {
  assert.equal(knownTimeZone('Europe/Madrid'), 'Europe/Madrid');
  assert.equal(knownTimeZone('europe/madrid'), 'Europe/Madrid');
  assert.equal(knownTimeZone('Mars/Olympus'), null);
  assert.equal(knownTimeZone(''), null);
  assert.equal(knownTimeZone(42), null);
  assert.equal(knownTimeZone('x'.repeat(65)), null);
});

test('zoneOf reads prefs.tz as text or object, else the server\'s', () => {
  assert.equal(zoneOf({ prefs: '{"tz":"America/New_York"}' }), 'America/New_York');
  assert.equal(zoneOf({ prefs: { tz: 'asia/tokyo' } }), 'Asia/Tokyo');
  assert.equal(zoneOf({ prefs: '{"tz":"nowhere"}' }), SERVER_TIME_ZONE);
  assert.equal(zoneOf({ prefs: 'not json' }), SERVER_TIME_ZONE);
  assert.equal(zoneOf({ prefs: 'null' }), SERVER_TIME_ZONE);
  assert.equal(zoneOf(null), SERVER_TIME_ZONE);
});

test('an instant falls on a different day on each side of the world', () => {
  const instant = '2026-10-23T23:30:00Z';
  assert.equal(dayIn('Europe/Madrid', instant), '2026-10-24');
  assert.equal(dayIn('America/New_York', instant), '2026-10-23');
  assert.equal(dayIn('Pacific/Kiritimati', '2026-10-23T10:00:00Z'), '2026-10-24');
});

test('addDays counts calendar days across a clock change and a year', () => {
  assert.equal(addDays('2026-10-24', 1), '2026-10-25');
  assert.equal(addDays('2026-10-25', 1), '2026-10-26');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
});

test('inZoneOf carries the person\'s zone through awaits; outside it, the server\'s', async () => {
  const ny = { prefs: { tz: 'America/New_York' } };
  assert.equal(currentZone(), SERVER_TIME_ZONE);
  const seen = await inZoneOf(ny, async () => {
    await new Promise((r) => setTimeout(r, 1));
    return [currentZone(), todayFor(), todayFor(null, 1)];
  });
  assert.equal(seen[0], 'America/New_York');
  assert.equal(seen[1], todayIn('America/New_York'));
  assert.equal(seen[2], todayIn('America/New_York', 1));
  assert.equal(todayFor(ny), todayIn('America/New_York'));
  assert.equal(currentZone(), SERVER_TIME_ZONE);
});

test('daysSince counts days on the calendar of the zone', () => {
  const zone = 'UTC';
  assert.equal(daysSince(new Date(), zone), 0);
  assert.equal(daysSince(Date.parse(`${todayIn(zone, -1)}T23:59:00Z`), zone), 1);
  assert.equal(daysSince(Date.parse(`${todayIn(zone, 2)}T00:01:00Z`), zone), -2);
});
