/**
 * The host's calendar (calendar.js) without a server: what the modules are asked, how their
 * items come out (in order, under each module's path, the ones that can't be shown left out),
 * that one module failing leaves the rest, the spans it takes, and its tool for assistants
 * (host.js hostMcp). Over HTTP, in host.test.js.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalendar, calendarSpan, CALENDAR_MAX_DAYS, CALENDAR_MODULE_MAX } from '../calendar.js';
import { hostMcp } from '../host.js';
import { addDays, todayFor, currentZone } from '../time.js';

const ana = { id: 1, prefs: '{"tz":"Europe/Madrid"}' };
const bob = { id: 2 };

/** A module of the host as calendar.js sees it, its range as given (or none). */
const moduleOf = (mount, name, range, extra = {}) => ({
  mount, config: { app: { name, color: `#${mount.length}${mount.length}0000`, icon: `/icons/${mount}.svg` } },
  parts: { ...(range ? { calendar: { range } } : {}), ...extra },
});

/** Items of a module between two days: the ones whose span overlaps them, as a module answers. */
const within = (items) => (user, { from, to }) => items.filter((item) => (item.end ?? item.start) >= from && item.start <= to);

test('the calendar asks each module someone uses, and shows their items by day, then module, then title', async () => {
  const asked = [];
  const tasks = moduleOf('tasks', 'Tasks', (user, span) => {
    asked.push(['tasks', user.id, span]);
    return within([
      { type: 'task', id: 9, title: 'Call Ana', start: '2026-11-03', end: '2026-11-03', state: 'open', where: 'Inbox', url: '?list=3&task=9', mine: true },
      { type: 'task', id: 4, title: 'Bake bread', start: '2026-11-03', state: 'done', where: 'Home', url: '?list=1&task=4', mine: true },
      { type: 'task', id: 5, title: 'Pay rent', start: '2026-11-01', end: '2026-11-01', state: 'open', where: 'Home', url: '?list=1&task=5' },
    ])(user, span);
  });
  // A module that answers later: a promise of its items.
  const projects = moduleOf('projects', 'Projects', async (user, span) => {
    asked.push(['projects', user.id, span]);
    return within([
      { type: 'phase', id: 'p7', title: 'Design', start: '2026-10-20', end: '2026-11-05', state: 'open', where: 'Website', url: '?project=2&phase=7', mine: false },
      { type: 'milestone', id: 3, title: 'Launch', start: '2026-11-03', end: '2026-11-03', state: 'open', where: 'Website', url: '?project=2', time: '09:30' },
    ])(user, span);
  });
  const notes = moduleOf('notes', 'Notes', () => { throw new Error('not asked: Ana turned it off'); });
  const next = moduleOf('next', 'Next', null, { cards: {} });
  const calendar = createCalendar({ modules: () => [tasks, projects, notes, next], uses: (user, mount) => mount !== 'notes' });

  const answer = await calendar.range(ana, { from: '2026-11-01', to: '2026-11-07' });
  assert.deepEqual(asked, [['tasks', 1, { from: '2026-11-01', to: '2026-11-07' }], ['projects', 1, { from: '2026-11-01', to: '2026-11-07' }]],
    'each module someone uses with a calendar, once, with the span');
  assert.equal(answer.from, '2026-11-01');
  assert.equal(answer.to, '2026-11-07');
  assert.deepEqual(answer.modules, [
    { mount: 'tasks', name: 'Tasks', color: '#550000', icon: '/icons/tasks.svg' },
    { mount: 'projects', name: 'Projects', color: '#880000', icon: '/icons/projects.svg' },
  ], 'the modules asked, in the host\'s order, for the page\'s filter');
  assert.equal(answer.failed, undefined, 'nothing failed, nothing said');
  assert.deepEqual(answer.items.map((item) => `${item.start} ${item.module} ${item.title}`), [
    '2026-10-20 projects Design',   // began before the span: still in it
    '2026-11-01 tasks Pay rent',
    '2026-11-03 tasks Bake bread',
    '2026-11-03 tasks Call Ana',
    '2026-11-03 projects Launch',
  ], 'by first day, then in the modules\' order, then by title');
  assert.deepEqual(answer.items[3], {
    module: 'tasks', type: 'task', id: 9, title: 'Call Ana', start: '2026-11-03', end: '2026-11-03',
    state: 'open', where: 'Inbox', url: '/tasks/?list=3&task=9', mine: true,
  }, 'its url under the module\'s path');
  assert.equal(answer.items[2].end, '2026-11-03', 'one day when the module gives no end');
  assert.equal(answer.items[2].state, 'done');
  assert.equal(answer.items[0].mine, false);
  assert.equal(answer.items[1].mine, undefined, 'mine only when the module says');
  assert.equal(answer.items[4].time, '09:30');
  assert.equal(answer.items[0].id, 'p7', 'an id as the module gives it');
});

test('what a module gives that can\'t be shown is left out, and the rest kept as the calendar shows it', async () => {
  const items = [
    { type: 'task', id: 1, title: 'Fine', start: '2026-11-02', state: 'weird', url: '/elsewhere', time: '25:00' },
    { type: 'task', id: 2, title: 'x'.repeat(400), start: '2026-11-02', where: 'w'.repeat(400) },
    { type: 'task', id: 3, title: 'No start' },
    { type: 'task', id: 4, title: 'Not a day', start: '2026-02-30' },
    { type: 'task', id: 5, title: 'Ends before it starts', start: '2026-11-04', end: '2026-11-02' },
    { type: 'task', id: 6, title: 'Outside the span', start: '2026-12-24' },
    { id: 7, title: 'No type', start: '2026-11-02' },
    { type: 'task', title: 'No id', start: '2026-11-02' },
    { type: 'task', id: '', title: 'An empty id', start: '2026-11-02' },
    null, 'a string',
  ];
  const calendar = createCalendar({ modules: () => [moduleOf('tasks', 'Tasks', () => items)] });
  const answer = await calendar.range(ana, { from: '2026-11-01', to: '2026-11-07' });
  assert.deepEqual(answer.items.map((item) => item.id), [1, 2]);
  assert.deepEqual(answer.items[0], {
    module: 'tasks', type: 'task', id: 1, title: 'Fine', start: '2026-11-02', end: '2026-11-02', state: 'open', where: '',
  }, 'open unless done; no url that leaves the module, no time that isn\'t one');
  assert.equal(answer.items[1].title.length, 300, 'a title cut');
  assert.equal(answer.items[1].where.length, 300);
});

test('a module with more than its share keeps its earliest items', async () => {
  const many = Array.from({ length: CALENDAR_MODULE_MAX + 50 }, (_, i) => ({
    type: 'task', id: i, title: `Task ${i}`, start: addDays('2026-01-01', (CALENDAR_MODULE_MAX + 50 - i) % 300), state: 'open',
  }));
  const calendar = createCalendar({ modules: () => [moduleOf('tasks', 'Tasks', () => many)] });
  const { items } = await calendar.range(ana, { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(items.length, CALENDAR_MODULE_MAX);
  const latest = items.at(-1).start;
  assert.ok(many.filter((item) => item.start < latest).every((item) => items.some((kept) => kept.id === item.id)),
    'every item before the last day kept is there');
});

test('one module that fails is left out and named, and the others still answer', async () => {
  const lines = [];
  const tasks = moduleOf('tasks', 'Tasks', () => [{ type: 'task', id: 1, title: 'Still here', start: '2026-11-02' }]);
  const projects = moduleOf('projects', 'Projects', () => { throw new Error('the schedule broke'); });
  const notes = moduleOf('notes', 'Notes', async () => { throw new Error('the database is busy'); });
  const next = moduleOf('next', 'Next', () => ({ not: 'a list' }));
  const calendar = createCalendar({ modules: () => [tasks, projects, notes, next], log: (line) => lines.push(line) });
  const answer = await calendar.range(ana, { from: '2026-11-01', to: '2026-11-07' });
  assert.deepEqual(answer.items.map((item) => item.title), ['Still here']);
  assert.deepEqual(answer.failed, ['projects', 'notes', 'next'], 'in the host\'s order');
  assert.equal(answer.modules.length, 4, 'still on the page\'s filter');
  assert.deepEqual(lines, [
    '[calendar] projects: the schedule broke',
    '[calendar] notes: the database is busy',
    '[calendar] next: its range gave no list',
  ]);
});

test('a module is asked in the person\'s zone: its today is theirs', async () => {
  let seen = null;
  const calendar = createCalendar({ modules: () => [moduleOf('tasks', 'Tasks', async () => {
    await null;
    seen = currentZone();
    return [];
  })] });
  await calendar.range({ id: 3, prefs: { tz: 'Pacific/Kiritimati' } }, { from: '2026-11-01', to: '2026-11-07' });
  assert.equal(seen, 'Pacific/Kiritimati', 'through awaits too');
});

test('the span asked: two dates, the second not before the first, a year at most', async () => {
  assert.deepEqual(calendarSpan('2026-11-01', '2026-11-01'), { from: '2026-11-01', to: '2026-11-01' }, 'one day');
  assert.deepEqual(calendarSpan(' 2026-01-01 ', '2026-12-31'), { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(CALENDAR_MAX_DAYS, 366);
  assert.deepEqual(calendarSpan('2028-01-01', '2028-12-31'), { from: '2028-01-01', to: '2028-12-31' }, 'a leap year, 366 days');
  const field = (from, to) => {
    try {
      calendarSpan(from, to);
      return null;
    } catch (error) {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'field_invalid');
      return error.extra.field;
    }
  };
  assert.equal(field(null, '2026-11-01'), 'from');
  assert.equal(field('2026-11-31', '2026-12-01'), 'from', 'a day that doesn\'t exist');
  assert.equal(field('01/11/2026', '2026-12-01'), 'from');
  assert.equal(field('2026-11-01', undefined), 'to');
  assert.equal(field('2026-11-02', '2026-11-01'), 'to', 'before from');
  assert.equal(field('2026-01-01', '2027-01-01'), null, '366 days');
  assert.equal(field('2026-01-01', '2027-01-02'), 'to', '367 days');
  const calendar = createCalendar({ modules: () => [moduleOf('tasks', 'Tasks', () => assert.fail('not asked'))] });
  await assert.rejects(calendar.range(ana, { from: '2026-11-07', to: '2026-11-01' }), (error) => error.extra?.field === 'to');
});

/* -------------------------------- assistants -------------------------------- */

/** The host's MCP with some modules, none with tools of its own: only the host's. */
function mcpOf({ modules, uses = () => true, calendar = true }) {
  return hostMcp({
    modules, uses, hostName: 'Work', hostId: 'work',
    calendar: calendar ? createCalendar({ modules: () => modules, uses }) : null,
  });
}

const call = async (mcp, user, args) => (await mcp.tools.find((tool) => tool.name === 'work_calendar').handler(user, args)).content[0].text;

test('assistants get work_calendar: what has a date, said by day, for whoever uses a module that gives its dates', async () => {
  const tasks = moduleOf('tasks', 'Tasks', within([
    { type: 'task', id: 9, title: 'Call Ana', start: '2026-11-03', state: 'open', where: 'Inbox', url: '?list=3&task=9' },
    { type: 'task', id: 4, title: 'Bake bread', start: '2026-11-05', state: 'done', where: 'Home' },
  ]));
  const projects = moduleOf('projects', 'Projects', within([
    { type: 'phase', id: 7, title: 'Design', start: '2026-10-20', end: '2026-11-05', state: 'open', where: 'Website' },
    { type: 'phase', id: 8, title: 'Build', start: '2026-11-03', end: '2026-11-20', state: 'open', where: 'Website' },
    { type: 'milestone', id: 3, title: 'Launch', start: '2026-11-03', state: 'open', where: 'Website', time: '09:30' },
  ]), { mcp: { brief: 'Projects keeps projects.' } });
  const mcp = mcpOf({ modules: [tasks, projects], uses: (user) => user.id === 1 });
  const tool = mcp.tools.find((t) => t.name === 'work_calendar');
  assert.ok(tool, 'named with the host\'s id');
  assert.deepEqual(tool.annotations, { readOnlyHint: true, openWorldHint: false });
  assert.ok(tool.description.length <= 2048);
  assert.equal(mcp.visible(ana, tool), true, 'for whoever uses a module with dates');
  assert.equal(mcp.visible(bob, tool), false, 'not for whoever uses none');
  assert.match(mcp.instructions(ana), /or with work_ for the ones that show what has a date in them\./);
  assert.doesNotMatch(mcp.instructions(bob) || '', /work_/);

  assert.equal(await call(mcp, ana, { from: '2026-11-01', to: '2026-11-07' }), [
    '2026-11-01, Sunday',
    '• Projects phase projects:phase:7: "Design" (open, since 2026-10-20 until 2026-11-05) in Website',
    '',
    '2026-11-03, Tuesday',
    '• Tasks task tasks:task:9: "Call Ana" (open) in Inbox',
    '• Projects phase projects:phase:8: "Build" (open, until 2026-11-20) in Website',
    '• Projects milestone projects:milestone:3: "Launch" (open, at 09:30) in Website',
    '',
    '2026-11-05, Thursday',
    '• Tasks task tasks:task:4: "Bake bread" (done) in Home',
  ].join('\n'));
  assert.equal(await call(mcp, ana, { from: '2026-12-01' }), 'Nothing has a date from 2026-12-01 to 2026-12-07.', 'a week without to');
  const today = todayFor(ana);
  const empty = mcpOf({ modules: [moduleOf('tasks', 'Tasks', () => [])] });
  assert.equal(await call(empty, ana, {}), `Nothing has a date from ${today} to ${addDays(today, 6)}.`, 'from today, in their zone, without from');
  await assert.rejects(call(mcp, ana, { from: 'tomorrow' }), (error) => error.extra?.field === 'from');
  await assert.rejects(call(mcp, ana, { from: '2026-11-01', to: '2028-01-01' }), (error) => error.extra?.field === 'to');
});

test('work_calendar says which modules it couldn\'t read, and a host with links names both in its instructions', async () => {
  const cards = { item: { read: () => null, search: () => [] } };
  const tasks = moduleOf('tasks', 'Tasks', () => [{ type: 'task', id: 1, title: 'Here', start: '2026-11-02', where: 'Inbox' }],
    { cards, mcp: { brief: 'Tasks keeps tasks.' } });
  const notes = moduleOf('notes', 'Notes', () => { throw new Error('busy'); }, { cards });
  const mcp = hostMcp({
    modules: [tasks, notes], hostName: 'Work', hostId: 'work', links: { of: () => [] },
    calendar: createCalendar({ modules: () => [tasks, notes] }),
  });
  assert.deepEqual(mcp.tools.map((tool) => tool.name), ['work_linked_items', 'work_link_item', 'work_calendar']);
  assert.match(mcp.instructions(ana), /or with work_ for the ones that link things between modules or show what has a date in them\./);
  assert.equal(await call(mcp, ana, { from: '2026-11-01', to: '2026-11-02' }), [
    '2026-11-02, Monday',
    '• Tasks task tasks:task:1: "Here" (open) in Inbox',
    '',
    'Not read just now, so missing here: Notes.',
  ].join('\n'));
});

test('without the calendar, or without a module that gives its dates, no work_calendar', () => {
  const tasks = moduleOf('tasks', 'Tasks', () => []);
  assert.equal(mcpOf({ modules: [tasks], calendar: false }), null, 'a host without it, as before');
  assert.equal(mcpOf({ modules: [moduleOf('next', 'Next', null)] }), null, 'nothing to show');
});
