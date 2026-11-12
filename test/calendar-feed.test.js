/**
 * The host's calendar as a subscription link (calendar-feed.js): the iCalendar file it writes
 * (RFC 5545: lines, escapes, all-day and timed events, stable UIDs), each person's secret link
 * (made, made again, turned off, unreadable with another secret), and over HTTP in a host: who
 * may make one, the plan that gives it, what the link answers and when it stops.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { calendarIcs, instantIn, createCalendarFeeds, calendarFeedsSchema, FEED_PAST_DAYS } from '../calendar-feed.js';
import { createHost } from '../host.js';
import { SuiteConfigError } from '../app.js';
import { openDatabase } from '../db.js';
import { addDays, todayIn, SERVER_TIME_ZONE } from '../time.js';

/**
 * What a calendar app checks of a file before it reads it, as a parser would: CRLF lines of at
 * most 75 octets, unfolded into properties; one VCALENDAR with VERSION and PRODID; each VEVENT
 * with UID, DTSTAMP, DTSTART, its end after its start; components that close. → the events, as
 * { NAME: value } with the parameters kept in the name (`DTSTART;VALUE=DATE`).
 */
function parseIcs(body) {
  assert.ok(body.endsWith('\r\n'), 'the last line ends too');
  const raw = body.slice(0, -2).split('\r\n');
  for (const line of raw) {
    assert.ok(Buffer.byteLength(line) <= 75, `at most 75 octets: ${line}`);
    assert.ok(!/[\r\n]/.test(line), 'no bare line break');
  }
  const lines = [];
  for (const line of raw) {
    if (line.startsWith(' ')) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  const stack = [];
  const events = [];
  let calendar = null;
  for (const line of lines) {
    const colon = line.indexOf(':');
    assert.ok(colon > 0, `a property: ${line}`);
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (name === 'BEGIN') {
      stack.push(value);
      if (value === 'VCALENDAR') calendar = {};
      if (value === 'VEVENT') events.push({});
      continue;
    }
    if (name === 'END') {
      assert.equal(stack.pop(), value, `${value} closes what opened`);
      continue;
    }
    const target = stack.at(-1) === 'VEVENT' ? events.at(-1) : calendar;
    assert.ok(target, `inside a component: ${line}`);
    assert.equal(target[name], undefined, `${name} once`);
    target[name] = value;
  }
  assert.deepEqual(stack, [], 'every component closed');
  assert.equal(calendar.VERSION, '2.0');
  assert.ok(calendar.PRODID);
  for (const event of events) {
    for (const required of ['UID', 'DTSTAMP']) assert.ok(event[required], `${required} in every event`);
    assert.match(event.DTSTAMP, /^\d{8}T\d{6}Z$/);
    const start = event['DTSTART;VALUE=DATE'] ?? event.DTSTART;
    const end = event['DTEND;VALUE=DATE'] ?? event.DTEND;
    assert.ok(start && end, 'a start and an end');
    assert.ok(end > start, 'its end after its start');
  }
  return { calendar, events };
}

/** TEXT read back as a client does. */
const unescape = (value) => value.replace(/\\n/gi, '\n').replace(/\\([\\;,])/g, '$1');

const answer = {
  modules: [{ mount: 'tasks', name: 'Tasks' }, { mount: 'projects', name: 'Projects' }],
  items: [
    { module: 'tasks', type: 'task', id: 9, title: 'Call Ana, then Bob; \\ done', start: '2026-11-03', end: '2026-11-03', state: 'open', where: 'Inbox', url: '/tasks/?list=3&task=9' },
    { module: 'tasks', type: 'task', id: 4, title: 'Bake bread', start: '2026-11-03', end: '2026-11-03', state: 'done', where: '', url: '/tasks/?list=1&task=4', time: '09:30' },
    { module: 'projects', type: 'phase', id: 'p7', title: 'Design\nand build', start: '2026-10-20', end: '2026-11-05', state: 'open', where: 'Website', url: '/projects/?project=2&phase=7' },
    { module: 'projects', type: 'milestone', id: 3, title: `Launch ${'— with a very long title in it '.repeat(4)}✓`, start: '2026-03-29', end: '2026-03-29', state: 'open', where: 'Website', time: '02:30' },
  ],
};
const options = { name: 'Cronum Work', id: 'work', baseUrl: 'https://work.example.com', zone: 'Europe/Madrid', now: new Date('2026-11-12T10:00:00.000Z') };

test('the calendar as an iCalendar file: one event per item, all day or at its time, each linking back', () => {
  const body = calendarIcs(answer, options);
  const { calendar, events } = parseIcs(body);
  assert.equal(calendar['X-WR-CALNAME'], 'Cronum Work');
  assert.equal(calendar['X-WR-TIMEZONE'], 'Europe/Madrid');
  assert.equal(calendar.METHOD, 'PUBLISH');
  assert.equal(calendar['REFRESH-INTERVAL;VALUE=DURATION'], 'PT1H');
  assert.equal(events.length, 4);
  const [call, bread, design, launch] = events;

  assert.equal(call.UID, 'tasks-task-9@work.example.com', 'stable: its module, type and id');
  assert.equal(call.DTSTAMP, '20261112T100000Z');
  assert.equal(call['DTSTART;VALUE=DATE'], '20261103');
  assert.equal(call['DTEND;VALUE=DATE'], '20261104', 'all day: the day after, which isn’t included');
  assert.equal(call.SUMMARY, 'Call Ana\\, then Bob\\; \\\\ done', 'commas, semicolons and backslashes escaped');
  assert.equal(unescape(call.SUMMARY), 'Call Ana, then Bob; \\ done');
  assert.equal(call['URL;VALUE=URI'], 'https://work.example.com/tasks/?list=3&task=9');
  assert.equal(unescape(call.DESCRIPTION), 'Tasks · Inbox\nhttps://work.example.com/tasks/?list=3&task=9');
  assert.equal(call.CATEGORIES, 'Tasks');
  assert.equal(call.TRANSP, 'TRANSPARENT', 'something to do doesn’t make anyone busy');

  assert.equal(bread.SUMMARY, '✓ Bake bread', 'done, it says so');
  assert.equal(bread.DTSTART, '20261103T083000Z', '09:30 in Madrid, in UTC (winter: +1)');
  assert.equal(bread.DTEND, '20261103T090000Z', 'half an hour');
  assert.equal(unescape(bread.DESCRIPTION), 'Tasks\nhttps://work.example.com/tasks/?list=1&task=4', 'no place: the module');

  assert.equal(design.UID, 'projects-phase-p7@work.example.com');
  assert.equal(design['DTSTART;VALUE=DATE'], '20261020');
  assert.equal(design['DTEND;VALUE=DATE'], '20261106', 'a span: through its last day');
  assert.equal(unescape(design.SUMMARY), 'Design\nand build', 'a line break, escaped');

  assert.ok(launch.SUMMARY.endsWith('✓') && body.includes('\r\n '), 'a long line folded, never inside a character');
  assert.equal(launch.DTSTART, '20260329T013000Z', 'a time the clocks skip in Madrid: an hour later, as the clocks moved');
  assert.equal(launch['URL;VALUE=URI'], undefined, 'no link without a url');
  assert.equal(unescape(launch.DESCRIPTION), 'Projects · Website');
});

test('nothing with a date is still a calendar, and an address without a host names the UIDs by the app', () => {
  const { calendar, events } = parseIcs(calendarIcs({ modules: [], items: [] }, { ...options, baseUrl: 'not a url' }));
  assert.equal(events.length, 0);
  assert.equal(calendar.VERSION, '2.0');
  const [only] = parseIcs(calendarIcs({ modules: [], items: [answer.items[0]] }, { ...options, baseUrl: 'not a url' })).events;
  assert.equal(only.UID, 'tasks-task-9@work');
});

test('a wall time in a zone, as an instant, across daylight saving', () => {
  assert.equal(instantIn('2026-07-01', '09:30', 'Europe/Madrid').toISOString(), '2026-07-01T07:30:00.000Z', 'summer: +2');
  assert.equal(instantIn('2026-01-15', '23:45', 'America/New_York').toISOString(), '2026-01-16T04:45:00.000Z');
  assert.ok(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z'].includes(instantIn('2026-10-25', '02:30', 'Europe/Madrid').toISOString()),
    'the hour that happens twice: one of them');
  assert.equal(instantIn('2026-11-03', '00:00', 'UTC').toISOString(), '2026-11-03T00:00:00.000Z');
});

test('each person’s link: made, made again (the old one stops), turned off; unreadable with another secret', () => {
  const database = openDatabase({ path: ':memory:' });
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  database.exec('INSERT INTO users (id) VALUES (1), (2)');
  calendarFeedsSchema(database);
  let now = new Date('2026-11-12T10:00:00.000Z');
  const feeds = createCalendarFeeds({ database, sign: (purpose) => `secret:${purpose}`, clock: () => now });
  assert.equal(feeds.of(1), null);
  const first = feeds.renew(1);
  assert.match(first.token, /^[A-Za-z0-9_-]{32}$/, '192 random bits');
  assert.deepEqual([first.created_at, first.used_at], ['2026-11-12T10:00:00.000Z', null]);
  const stored = database.get('SELECT token, token_hash FROM host_calendar_feeds WHERE user_id = 1');
  assert.ok(!stored.token.includes(first.token) && !stored.token_hash.includes(first.token), 'neither the hash nor the copy is the token');
  assert.equal(feeds.of(1).token, first.token, 'shown again');

  assert.equal(feeds.userOf(first.token), 1);
  assert.equal(feeds.of(1).used_at, '2026-11-12T10:00:00.000Z', 'read: noted');
  now = new Date('2026-11-12T10:05:00.000Z');
  feeds.userOf(first.token);
  assert.equal(feeds.of(1).used_at, '2026-11-12T10:00:00.000Z', 'not written on every read');
  now = new Date('2026-11-12T10:20:00.000Z');
  feeds.userOf(first.token);
  assert.equal(feeds.of(1).used_at, '2026-11-12T10:20:00.000Z');
  for (const wrong of ['', 'short', `${first.token}x`.slice(1), null, 42, `${first.token}/../x`]) assert.equal(feeds.userOf(wrong), null, String(wrong));

  const second = feeds.renew(1);
  assert.notEqual(second.token, first.token);
  assert.equal(feeds.userOf(first.token), null, 'the old link stops at once');
  assert.equal(feeds.userOf(second.token), 1);
  assert.equal(feeds.of(1).used_at, '2026-11-12T10:20:00.000Z');
  assert.equal(feeds.renew(2).token === second.token, false);

  const otherSecret = createCalendarFeeds({ database, sign: (purpose) => `another:${purpose}` });
  assert.equal(otherSecret.of(1).token, null, 'another session secret: the link can’t be shown');
  assert.equal(otherSecret.userOf(second.token), 1, 'but it still answers');

  assert.equal(feeds.remove(1), true);
  assert.equal(feeds.remove(1), false);
  assert.equal(feeds.userOf(second.token), null, 'turned off');
  assert.equal(feeds.of(1), null);
  database.exec('DELETE FROM users WHERE id = 2');
  assert.equal(database.get('SELECT COUNT(*) AS n FROM host_calendar_feeds').n, 0, 'an account’s goes with it');
  database.close();
});

/* ------------------------------ in a host ------------------------------ */

const fixture = (name, query = '') => new URL(`./fixtures/host/${name}/module.js${query}`, import.meta.url);
let fresh = 0;
const modules = () => {
  fresh += 1;
  return [{ mount: 'alpha', entry: fixture('alpha', `?feed=${fresh}`) }, { mount: 'beta', entry: fixture('beta', `?feed=${fresh}`) }];
};
const HOST = {
  app: { id: 'work', name: 'Work', color: '#3A4660', icon: '/icons/work.svg', languages: ['en', 'es'] },
  modules: { live: true },
  accounts: { minPasswordLength: 8 },
  features: { 'calendar.feed': { type: 'flag', default: true, label: 'the calendar in other calendar apps' } },
};
const PLANS = { free: { name: 'Free', 'calendar.feed': false }, pro: { name: 'Pro', 'calendar.feed': true } };

async function startHost(t, { config = HOST, plans = PLANS, ...rest } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-feed-'));
  const host = await createHost({
    config, modules: modules(), calendar: '/calendar/', calendarFeed: true,
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1', ...(plans ? { PLANS: JSON.stringify(plans) } : {}) },
    version: '9.9.9', handleSignals: false, exitOnError: false, log: () => {}, ...rest,
  });
  const server = await host.listen();
  t.after(async () => {
    await host.close();
    host.suite.database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, pathname, body, headers = {}) => {
    const res = await fetch(base + pathname, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('work_sid='));
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, headers: res.headers };
  };
  /** The link as a calendar app reads it: no cookie, the URL Settings gave, on this server. */
  const read = async (url, headers = {}, options = {}) => {
    const res = await fetch(url.replace('http://127.0.0.1', base), { headers, ...options });
    return { status: res.status, body: await res.text(), headers: res.headers };
  };
  return { host, call, read };
}

test('a host’s calendar link: Pro’s, made in Settings, read by a calendar app signed out, made again and turned off', async (t) => {
  const { host, call, read } = await startHost(t);
  assert.equal((await call('GET', '/api/me/calendar-feed')).status, 401, 'signed out: nothing');
  assert.equal((await call('POST', '/api/me/calendar-feed')).status, 401);
  // Someone with a plan: the admin has every feature.
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  const ana = (await call('POST', '/api/admin/users', { username: 'ana', password: 'ana-password', display_name: 'Ana' })).data;
  await call('POST', '/api/auth/logout');
  await call('POST', '/alpha/api/auth/login', { username: 'ana', password: 'ana-password' });

  // Settings' section, in every module's page config.
  assert.equal((await call('GET', '/alpha/api/where')).data.host.calendarFeed, true, 'the module’s Settings show the section');

  // Free: the plan's, said, and nothing made.
  assert.deepEqual((await call('GET', '/api/me/calendar-feed')).data, { included: false, feed: null });
  const refused = await call('POST', '/api/me/calendar-feed');
  assert.deepEqual([refused.status, refused.data.error, refused.data.feature], [402, 'plan_feature', 'calendar.feed']);
  assert.equal(host.suite.database.get('SELECT COUNT(*) AS n FROM host_calendar_feeds').n, 0);

  // Pro: made.
  const proGrant = host.suite.entitlements.grant({ subjectId: ana.id, plan: 'pro' });
  const today = todayIn(SERVER_TIME_ZONE);
  for (const text of [`${today} Dentist, at noon`, 'No date', `${addDays(today, -FEED_PAST_DAYS - 1)} Too long ago`, `${addDays(today, 200)} Later`]) {
    await call('POST', '/alpha/api/items', { text });
  }
  const made = await call('POST', '/api/me/calendar-feed');
  assert.equal(made.status, 200);
  assert.equal(made.data.included, true);
  const { url, webcal, subscribe, created_at: createdAt, used_at: usedAt } = made.data.feed;
  assert.match(url, /^http:\/\/127\.0\.0\.1\/api\/calendar\/feed\/[A-Za-z0-9_-]{32}\.ics$/, 'the token is all there is in it');
  assert.equal(webcal, url.replace('http:', 'webcal:'));
  // The phone app's builds that open only https: an address that sends to the webcal: one.
  assert.equal(subscribe, url.replace('/api/calendar/feed/', '/api/calendar/subscribe/'));
  const sent = await read(subscribe, {}, { redirect: 'manual' });
  assert.deepEqual([sent.status, sent.headers.get('location'), sent.headers.get('cache-control'), sent.headers.get('x-robots-tag')],
    [302, webcal, 'no-store', 'noindex, nofollow']);
  const unknown = subscribe.replace(/[A-Za-z0-9_-]{32}\.ics$/, `${'B'.repeat(32)}.ics`);
  assert.equal((await read(unknown, {}, { redirect: 'manual' })).status, 404, 'an unknown one: nothing');
  assert.ok(createdAt);
  assert.equal(usedAt, null);
  assert.deepEqual((await call('GET', '/api/me/calendar-feed')).data.feed.url, url, 'shown again');

  // Read as a calendar app does, with no session.
  const feed = await read(url);
  assert.equal(feed.status, 200);
  assert.equal(feed.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.match(feed.headers.get('cache-control'), /^private, max-age=\d+$/);
  assert.equal(feed.headers.get('x-robots-tag'), 'noindex, nofollow');
  const { calendar, events } = parseIcs(feed.body);
  assert.equal(calendar['X-WR-CALNAME'], 'Work');
  assert.deepEqual(events.map((e) => unescape(e.SUMMARY)), ['Dentist, at noon', 'Later'], 'what has a date, from two months ago up to a year');
  assert.equal(events[0]['DTSTART;VALUE=DATE'], today.replaceAll('-', ''));
  assert.equal(events[0]['URL;VALUE=URI'], 'http://127.0.0.1/alpha/?item=1');
  assert.equal(events[0].UID, 'alpha-item-1@127.0.0.1');
  assert.ok((await call('GET', '/api/me/calendar-feed')).data.feed.used_at, 'Settings say it was read');
  // The same again: 304 for whoever kept it.
  const kept = await read(url, { 'If-None-Match': feed.headers.get('etag') });
  assert.equal(kept.status, 304);
  await call('POST', '/alpha/api/items', { text: `${addDays(today, 1)} Something new` });
  assert.equal((await read(url, { 'If-None-Match': feed.headers.get('etag') })).status, 200, 'changed: the whole file');
  // A module turned off leaves the link too, as it leaves the calendar.
  await call('PUT', '/api/me/modules', { active: ['beta'] });
  assert.equal(parseIcs((await read(url)).body).events.length, 0);
  await call('PUT', '/api/me/modules', { active: ['alpha', 'beta'] });

  // Addresses that aren't a link: 404, the same as one turned off.
  for (const wrong of [url.replace(/\.ics$/, ''), url.replace(/[A-Za-z0-9_-]{32}\.ics$/, `${'A'.repeat(32)}.ics`), `${url}x`]) {
    assert.equal((await read(wrong)).status, 404, wrong);
  }

  // Made again: the old one stops at once.
  const again = (await call('POST', '/api/me/calendar-feed')).data.feed;
  assert.notEqual(again.url, url);
  assert.equal((await read(url)).status, 404);
  assert.equal((await read(again.url)).status, 200);

  // The plan over: the link is kept, and answers 402 until it comes back.
  host.suite.entitlements.revoke({ id: proGrant });
  const paused = (await call('GET', '/api/me/calendar-feed')).data;
  assert.deepEqual([paused.included, paused.feed.url], [false, again.url]);
  const lapsed = await read(again.url);
  assert.equal(lapsed.status, 402);
  host.suite.entitlements.grant({ subjectId: ana.id, plan: 'pro' });
  assert.equal((await read(again.url)).status, 200, 'the same link again');

  // Turned off.
  const off = await call('DELETE', '/api/me/calendar-feed');
  assert.deepEqual(off.data, { included: true, feed: null });
  assert.equal((await read(again.url)).status, 404);
  assert.deepEqual(host.suite.database.all("SELECT action FROM audit_log WHERE action LIKE 'calendar_feed.%' ORDER BY id").map((r) => r.action),
    ['calendar_feed.created', 'calendar_feed.renewed', 'calendar_feed.removed'], 'each change in the audit log');
});

test('a host that doesn’t declare calendar.feed offers the link to everyone, and one without a calendar can’t have it', async (t) => {
  const { call } = await startHost(t, { config: { ...HOST, features: {} }, plans: null });
  await call('POST', '/alpha/api/auth/login', { username: 'admin', password: 'root-password' });
  assert.equal((await call('GET', '/api/me/calendar-feed')).data.included, true);
  assert.equal((await call('POST', '/api/me/calendar-feed')).status, 200);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-feed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [options, message] of [[{ calendarFeed: true }, /calendarFeed: the host has no calendar/], [{ calendar: '/calendar/', calendarFeed: 'yes' }, /calendarFeed: true or false/]]) {
    await assert.rejects(createHost({
      config: HOST, modules: modules(), env: { DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1' },
      handleSignals: false, exitOnError: false, log: () => {}, ...options,
    }), (err) => err instanceof SuiteConfigError && message.test(err.errors.join('\n')));
  }
});

test('without the option, nothing of it: no route, no section', async (t) => {
  const { call } = await startHost(t, { calendarFeed: false });
  await call('POST', '/alpha/api/auth/login', { username: 'admin', password: 'root-password' });
  assert.equal((await call('GET', '/api/me/calendar-feed')).status, 404);
  assert.equal((await call('GET', `/api/calendar/feed/${'A'.repeat(32)}.ics`)).status, 404);
  assert.equal((await call('GET', '/alpha/api/where')).data.host.calendarFeed, undefined);
});
