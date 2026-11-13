/**
 * The host's daily summary (day.js) without a server: what the modules are asked and how their
 * lists come out, the person's two notices as preferences (prefs.js), what each notice says, and
 * the scheduler that sends them (each at its time, claimed once, nothing when there's nothing to
 * say). Over HTTP, in host.test.js.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDay, createDayNotices, dayNotice, dayPrefsOf, DAY_PREFS, DAY_MODULE_MAX, DAY_LOG_DAYS,
} from '../day.js';
import { HOST_MIGRATIONS } from '../host.js';
import { SUITE_MIGRATIONS } from '../schema.js';
import { migrate } from '../migrate.js';
import { openDatabase } from '../db.js';
import { definePrefs, combinePrefs } from '../prefs.js';
import { createTexts } from '../i18n.js';
import { currentZone, todayFor, addDays } from '../time.js';
import { HttpError } from '../http.js';

const ana = { id: 1, prefs: '{"tz":"Europe/Madrid"}' };

/** A module of the host as day.js sees it, with its day parts as given (or none). */
const moduleOf = (mount, name, day, extra = {}) => ({
  mount, config: { app: { name, color: `#${mount.length}${mount.length}0000`, icon: `/icons/${mount}.svg` } },
  parts: { ...(day ? { day } : {}), ...extra },
});

/* -------------------------------- the lists -------------------------------- */

test('the summary asks each module someone uses, and lists what is overdue, what is for today and what was done', async () => {
  const asked = [];
  const tasks = moduleOf('tasks', 'Tasks', {
    agenda: (user, args) => {
      asked.push(['tasks agenda', user.id, args]);
      return [
        { type: 'task', id: 9, title: 'Call Ana', date: '2026-11-04', where: 'Inbox', url: '?list=3&task=9', mine: true },
        { type: 'task', id: 4, title: 'Pay rent', date: '2026-10-01', where: 'Home', url: '?list=1&task=4', mine: true },
        { type: 'task', id: 5, title: 'Water plants', date: '2026-11-04', where: 'Home', url: '?list=1&task=5', planned: true },
        { type: 'task', id: 6, title: 'Dentist', date: '2026-11-04', where: 'Home', url: '?list=1&task=6', time: '17:00' },
      ];
    },
    done: (user, args) => {
      asked.push(['tasks done', user.id, args]);
      return [
        { type: 'task', id: 2, title: 'Buy bread', at: '2026-11-04T08:00:00.000Z', where: 'Home', url: '?list=1&task=2', kind: 'completed' },
        { type: 'task', id: 3, title: 'Send invoice', at: '2026-11-04T16:30:00Z', where: 'Work', url: '?list=2&task=3', kind: 'completed' },
      ];
    },
  });
  // A module that answers later, with promises, and has nothing done.
  const projects = moduleOf('projects', 'Projects', {
    agenda: async () => [
      { type: 'task', id: 'p7', title: 'Design review', date: '2026-11-02', where: 'Website › Design', url: '?project=2&task=7' },
      { type: 'task', id: 'p8', title: 'Launch call', date: '2026-11-04', where: 'Website', url: '?project=2&task=8', time: '09:30' },
    ],
    done: async () => [],
  });
  // Only what was done: Next's steps.
  const next = moduleOf('next', 'Next', {
    done: () => [{ type: 'step', id: 12, title: 'Login fixed', at: '2026-11-04T11:00:00.000Z', where: 'Work › main', url: '?project=1', kind: 'logged' }],
  });
  const notes = moduleOf('notes', 'Notes', { agenda: () => { throw new Error('not asked: Ana turned it off'); } });
  const calendarOnly = moduleOf('focus', 'Focus', null, { calendar: { range: () => [] } });
  const day = createDay({ modules: () => [tasks, projects, next, notes, calendarOnly], uses: (user, mount) => mount !== 'notes' });

  const answer = await day.summary(ana, { date: '2026-11-04' });
  assert.deepEqual(asked, [['tasks agenda', 1, { today: '2026-11-04', limit: DAY_MODULE_MAX }], ['tasks done', 1, { day: '2026-11-04', limit: DAY_MODULE_MAX }]],
    'each part once, with the day asked and the most the host keeps of each list');
  assert.equal(answer.date, '2026-11-04');
  assert.deepEqual(answer.modules, [
    { mount: 'tasks', name: 'Tasks', color: '#550000', icon: '/icons/tasks.svg' },
    { mount: 'projects', name: 'Projects', color: '#880000', icon: '/icons/projects.svg' },
    { mount: 'next', name: 'Next', color: '#440000', icon: '/icons/next.svg' },
  ], 'the modules with a part of the summary that the person uses, in the host\'s order');
  assert.equal(answer.failed, undefined, 'nothing failed, nothing said');
  assert.deepEqual(answer.overdue.map((item) => `${item.date} ${item.module} ${item.title}`), [
    '2026-10-01 tasks Pay rent',
    '2026-11-02 projects Design review',
  ], 'the oldest first, however old');
  assert.deepEqual(answer.today.map((item) => `${item.module} ${item.title}`), [
    'tasks Call Ana',
    'tasks Water plants',
    'tasks Dentist',
    'projects Launch call',
  ], 'in the modules\' order and each module\'s: no time of day (audit of 6/11, sc-feat-8)');
  assert.deepEqual(answer.today[0], {
    module: 'tasks', type: 'task', id: 9, title: 'Call Ana', date: '2026-11-04', where: 'Inbox', url: '/tasks/?list=3&task=9',
  }, 'its url under the module\'s path; neither `mine` nor `time`, which no page reads');
  assert.equal(answer.today[1].planned, true, 'planned for today without a date');
  assert.equal(answer.overdue_total, 2, 'as many overdue as listed');
  assert.deepEqual(answer.done.map((item) => `${item.at} ${item.module} ${item.kind} ${item.title}`), [
    '2026-11-04T16:30:00.000Z tasks completed Send invoice',
    '2026-11-04T11:00:00.000Z next logged Login fixed',
    '2026-11-04T08:00:00.000Z tasks completed Buy bread',
  ], 'the latest first, each instant written the same way');
  assert.equal(answer.done[1].url, '/next/?project=1');
});

test('without a date, the person\'s today in their zone; a date that isn\'t one is a 400 naming it', async () => {
  let seen = null;
  const tasks = moduleOf('tasks', 'Tasks', { agenda: async (user, { today }) => { await null; seen = { today, zone: currentZone() }; return []; } });
  const day = createDay({ modules: () => [tasks] });
  const someone = { id: 3, prefs: { tz: 'Pacific/Kiritimati' } };
  const answer = await day.summary(someone);
  assert.equal(answer.date, todayFor(someone));
  assert.deepEqual(seen, { today: todayFor(someone), zone: 'Pacific/Kiritimati' }, 'asked in their zone, through awaits too');
  for (const date of ['2026-02-30', 'tomorrow', '2026-11-4']) {
    await assert.rejects(day.summary(someone, { date }), (err) => err instanceof HttpError && err.code === 'field_invalid' && err.extra?.field === 'date', date);
  }
  assert.deepEqual(await day.summary(someone, { date: '' }).then((a) => a.date), todayFor(someone), 'an empty date is no date');
});

test('what a module gives that can\'t be shown is left out, each thing once, and its share kept', async () => {
  const agenda = [
    { type: 'task', id: 1, title: 'Fine', date: '2026-11-04', url: '/elsewhere', time: '25:00', mine: 'yes' },
    { type: 'task', id: 2, title: 'x'.repeat(400), date: '2026-11-03', where: 'w'.repeat(400) },
    { type: 'task', id: 3, title: 'Tomorrow', date: '2026-11-05' },
    { type: 'task', id: 4, title: 'Not a day', date: '2026-02-30' },
    { type: 'task', id: 5, title: 'No date' },
    { id: 6, title: 'No type', date: '2026-11-04' },
    { type: 'task', title: 'No id', date: '2026-11-04' },
    // Both overdue and in My Day: once, where it is the furthest behind.
    { type: 'task', id: 7, title: 'Twice', date: '2026-11-04', planned: true },
    { type: 'task', id: 7, title: 'Twice', date: '2026-10-20' },
    null, 'a string',
  ];
  const done = [
    { type: 'note', id: 1, title: 'Edited twice', at: '2026-11-04T09:00:00Z', kind: 'written' },
    { type: 'note', id: 1, title: 'Edited twice', at: '2026-11-04T18:00:00Z', kind: 'written' },
    { type: 'note', id: 2, title: 'No kind', at: '2026-11-04T09:00:00Z' },
    { type: 'note', id: 3, title: 'Odd kind', at: '2026-11-04T09:00:00Z', kind: 'deleted' },
    { type: 'note', id: 4, title: 'No instant', at: 'this morning', kind: 'written' },
  ];
  const day = createDay({ modules: () => [moduleOf('tasks', 'Tasks', { agenda: () => agenda, done: () => done })] });
  const answer = await day.summary(ana, { date: '2026-11-04' });
  assert.deepEqual(answer.overdue.map((item) => item.id), [7, 2]);
  assert.deepEqual(answer.today.map((item) => item.id), [1]);
  assert.deepEqual(answer.today[0], { module: 'tasks', type: 'task', id: 1, title: 'Fine', date: '2026-11-04', where: '' },
    'no url that leaves the module, nor a time or mine');
  assert.equal(answer.overdue[1].title.length, 300, 'a title cut');
  assert.equal(answer.overdue[1].where.length, 300);
  assert.equal(answer.overdue[0].planned, undefined, 'kept where it is overdue');
  assert.deepEqual(answer.done.map((item) => [item.id, item.at]), [[1, '2026-11-04T18:00:00.000Z']], 'a note edited twice, once, at its latest');

  const many = Array.from({ length: DAY_MODULE_MAX + 50 }, (_, i) => ({ type: 'task', id: i, title: `T${i}`, date: addDays('2026-11-04', -i) }));
  const lots = Array.from({ length: DAY_MODULE_MAX + 50 }, (_, i) => ({ type: 'task', id: i, title: `D${i}`, at: new Date(Date.UTC(2026, 10, 4, 0, i)).toISOString(), kind: 'completed' }));
  const busy = createDay({ modules: () => [moduleOf('tasks', 'Tasks', { agenda: () => many, done: () => lots })] });
  const full = await busy.summary(ana, { date: '2026-11-04' });
  assert.equal(full.overdue.length, DAY_MODULE_MAX, 'a module gives 200 overdue at most');
  assert.equal(full.overdue[0].id, DAY_MODULE_MAX + 49, 'its oldest');
  assert.equal(full.overdue_total, DAY_MODULE_MAX + 49, 'and says how many there were');
  assert.deepEqual(full.today.map((item) => item.id), [0], 'today\'s still there');
  assert.equal(full.done.length, DAY_MODULE_MAX);
  assert.equal(full.done[0].id, DAY_MODULE_MAX + 49, 'its latest');
});

test('one module that fails is left out and named, and the others still answer', async () => {
  const lines = [];
  const tasks = moduleOf('tasks', 'Tasks', { agenda: () => [{ type: 'task', id: 1, title: 'Still here', date: '2026-11-04' }] });
  const projects = moduleOf('projects', 'Projects', { agenda: () => { throw new Error('the schedule broke'); }, done: () => [] });
  const notes = moduleOf('notes', 'Notes', { done: async () => { throw new Error('the database is busy'); } });
  const next = moduleOf('next', 'Next', { done: () => ({ not: 'a list' }) });
  const day = createDay({ modules: () => [tasks, projects, notes, next], log: (line) => lines.push(line) });
  const answer = await day.summary(ana, { date: '2026-11-04' });
  assert.deepEqual(answer.today.map((item) => item.title), ['Still here']);
  assert.deepEqual(answer.failed, ['projects', 'notes', 'next'], 'in the host\'s order');
  assert.equal(answer.modules.length, 4, 'still listed');
  assert.deepEqual(lines, [
    '[day] projects agenda: the schedule broke',
    '[day] notes done: the database is busy',
    '[day] next done: its done gave no list',
  ]);
});

/* ------------------------------ preferences ------------------------------ */

test('the two notices as preferences: on at 08:00 and 19:00, the morning off for whoever had turned off Projects\' summary', () => {
  const prefs = definePrefs(combinePrefs([DAY_PREFS]), { languages: ['en', 'es'] });
  const defaults = { morning: { on: true, at: '08:00', modules: {} }, evening: { on: true, at: '19:00', modules: {} } };
  assert.deepEqual(prefs.view({ prefs: '{}' }).day, defaults);
  assert.deepEqual(prefs.defaults.day, defaults);
  assert.deepEqual(dayPrefsOf('{"notices":{"due":false,"assigned":true}}'),
    { morning: { on: false, at: '08:00', modules: {} }, evening: { on: true, at: '19:00', modules: {} } }, 'notices.due === false: the morning starts off');
  assert.deepEqual(dayPrefsOf('{"notices":{"due":true}}').morning.on, true);
  assert.deepEqual(dayPrefsOf({ notices: { due: false }, day: { morning: { on: true } } }).morning.on, true, 'what they chose since wins');
  assert.deepEqual(dayPrefsOf({ day: { morning: { at: '07:03' }, evening: 'x' } }), defaults, 'what isn\'t one is the default');
  assert.deepEqual(dayPrefsOf('not json'), defaults);
});

test('a change to one notice leaves the rest as it was, and what isn\'t one is refused', () => {
  const prefs = definePrefs(combinePrefs([{ defaults: { notices: { due: true } } }, DAY_PREFS]), { languages: ['en', 'es'] });
  const stored = JSON.stringify({ notices: { due: false }, theirs: 7, lang: 'es' });
  const once = JSON.parse(prefs.next(stored, { day: { evening: { at: '20:30' } } }));
  assert.deepEqual(once.day, { morning: { on: false, at: '08:00', modules: {} }, evening: { on: true, at: '20:30', modules: {} } });
  assert.equal(once.theirs, 7, 'another module\'s key stays');
  assert.deepEqual(once.notices, { due: false });
  const twice = JSON.parse(prefs.next(JSON.stringify(once), { day: { morning: { on: true } } }));
  assert.deepEqual(twice.day, { morning: { on: true, at: '08:00', modules: {} }, evening: { on: true, at: '20:30', modules: {} } });
  assert.deepEqual(JSON.parse(prefs.next(JSON.stringify(twice), { lang: 'en' })).day, twice.day, 'a change of something else keeps them');
  for (const day of [{ noon: { on: true } }, { morning: { on: 'yes' } }, { evening: { at: '20:31' } }, { evening: { at: '24:00' } }, { evening: 'off' }, 'off', null]) {
    assert.throws(() => prefs.next(stored, { day }), (err) => err instanceof HttpError && err.code === 'field_invalid' && err.extra?.field === 'day', JSON.stringify(day));
  }
});

test('a notice can leave modules out: each one\'s switch alone, true bringing it back', () => {
  const prefs = definePrefs(combinePrefs([DAY_PREFS]), { languages: ['en', 'es'] });
  const off = JSON.parse(prefs.next('{}', { day: { morning: { modules: { notes: false, next: false } } } }));
  assert.deepEqual(off.day.morning, { on: true, at: '08:00', modules: { notes: false, next: false } });
  assert.deepEqual(off.day.evening.modules, {}, 'the other notice keeps every module');
  const back = JSON.parse(prefs.next(JSON.stringify(off), { day: { morning: { modules: { next: true } } } }));
  assert.deepEqual(back.day.morning.modules, { notes: false }, 'only that one comes back');
  assert.deepEqual(dayPrefsOf({ day: { evening: { modules: { tasks: true, Bad: false, notes: false, x: 'no' } } } }).evening.modules,
    { notes: false }, 'what is kept is only who is left out, and only mounts');
  for (const day of [{ morning: { modules: ['notes'] } }, { morning: { modules: { notes: 'off' } } }, { morning: { modules: { 'Not a mount': false } } }]) {
    assert.throws(() => prefs.next('{}', { day }), (err) => err instanceof HttpError && err.code === 'field_invalid' && err.extra?.field === 'day', JSON.stringify(day));
  }
});

test('a module left out of a notice is left out of its part of the page too, and only of that part', async () => {
  const asked = [];
  const tasks = moduleOf('tasks', 'Tasks', {
    agenda: () => { asked.push('tasks agenda'); return [{ type: 'task', id: 1, title: 'Pay rent', date: '2026-11-04', url: '?task=1' }]; },
    done: () => { asked.push('tasks done'); return [{ type: 'task', id: 2, title: 'Buy bread', at: '2026-11-04T08:00:00Z', url: '?task=2', kind: 'completed' }]; },
  });
  const notes = moduleOf('notes', 'Notes', {
    done: () => { asked.push('notes done'); return [{ type: 'note', id: 3, title: 'Minutes', at: '2026-11-04T09:00:00Z', url: '#/n/3', kind: 'written' }]; },
  });
  const day = createDay({ modules: () => [tasks, notes] });
  const user = { id: 1, prefs: JSON.stringify({ tz: 'Europe/Madrid', day: { morning: { modules: { tasks: false } }, evening: { modules: { notes: false } } } }) };
  const answer = await day.summary(user, { date: '2026-11-04' });
  assert.deepEqual(asked, ['tasks done'], 'Tasks only for the evening, Notes for neither');
  assert.deepEqual(answer.today, [], 'Tasks out of the morning');
  assert.deepEqual(answer.done.map((item) => item.title), ['Buy bread'], 'Notes out of the evening, Tasks still in it');
  assert.deepEqual(answer.modules.map((m) => m.mount), ['tasks', 'notes'], 'the page still knows both, to draw them');
});

/* ------------------------------- the texts ------------------------------- */

const texts = createTexts();
const say = (lang) => {
  const { t } = texts({ headers: { 'accept-language': lang } }, null);
  return { t, lang, names: new Map([['tasks', 'Tasks'], ['next', 'Next'], ['notes', 'Notes']]) };
};
const items = (n, prefix, extra = {}) => Array.from({ length: n }, (_, i) => ({ module: 'tasks', title: `${prefix}${i + 1}`, ...extra }));

test('the morning notice: how many are overdue and for today, and today\'s first titles', () => {
  const morning = dayNotice('morning', { overdue: items(3, 'Old '), today: items(5, 'New ') }, say('es'));
  assert.deepEqual(morning, {
    title: '☀️ Mira lo que tienes para hacer hoy',
    body: '3 vencidas · 5 para hoy: «New 1», «New 2» y 3 más',
    tag: 'day-morning',
    url: '/today/',
  });
  assert.equal(dayNotice('morning', { overdue: items(3, 'Old '), today: items(5, 'New ') }, say('en')).body,
    '3 overdue · 5 for today: “New 1”, “New 2”, and 3 more');
  assert.equal(dayNotice('morning', { overdue: items(1, 'Old ') }, say('es')).body, '1 vencida: «Old 1»', 'only overdue: its titles');
  assert.equal(dayNotice('morning', { today: items(2, 'New ') }, say('es')).body, '2 para hoy: «New 1» y «New 2»');
  assert.equal(dayNotice('morning', { today: [{ title: 'x'.repeat(200) }] }, say('en')).body.length < 100, true, 'a long title cut');
  assert.equal(dayNotice('morning', { overdue: [], today: [], done: items(2, 'D') }, say('es')), null, 'nothing for today: no notice');
  for (const lang of ['fr', 'de', 'it']) {
    const text = dayNotice('morning', { overdue: items(2, 'Old '), today: items(1, 'New ') }, say(lang));
    assert.doesNotMatch(`${text.title} ${text.body}`, /kit\.day/, `${lang}: every text there`);
  }
});

test('the evening notice: how many tasks, steps of each module and notes, and it opens on what was done', () => {
  const done = [
    ...items(7, 'T', { kind: 'completed' }),
    { module: 'next', title: 'S1', kind: 'logged' }, { module: 'next', title: 'S2', kind: 'logged' },
    { module: 'notes', title: 'N1', kind: 'written' },
  ];
  assert.deepEqual(dayNotice('evening', { done }, say('es')), {
    title: '🌙 Lo que has hecho hoy',
    body: '7 tareas, 2 pasos en Next y 1 nota',
    tag: 'day-evening',
    url: '/today/?v=done',
  });
  assert.equal(dayNotice('evening', { done }, say('en')).body, '7 tasks, 2 steps in Next, and 1 note');
  assert.equal(dayNotice('evening', { done: done.slice(0, 1) }, say('es')).body, '1 tarea');
  assert.equal(dayNotice('evening', { done: done.slice(7, 8) }, { ...say('es'), page: '/hoy/' }).url, '/hoy/?v=done', 'at the host\'s page');
  assert.equal(dayNotice('evening', { done: [], today: items(3, 'X') }, say('es')), null, 'nothing done: no notice');
});

/* ------------------------------ the scheduler ------------------------------ */

/** A host's database with its people, and a push that keeps what it is asked to send. */
function setUp(people) {
  const database = openDatabase({ path: ':memory:' });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  migrate(database, HOST_MIGRATIONS, { scope: 'host', log: () => {} });
  const devices = [];
  for (const [i, person] of people.entries()) {
    const id = database.run('INSERT INTO users (username, display_name, prefs, locale, disabled_at) VALUES (?, ?, ?, ?, ?)',
      `user${i}`, `User ${i}`, JSON.stringify(person.prefs || {}), person.locale ?? null, person.disabled ? '2026-01-01T00:00:00Z' : null).lastInsertRowid;
    for (const lang of person.devices || []) devices.push({ id: devices.length + 1, user_id: id, lang });
  }
  const sent = [];
  const push = {
    subscriptionsOf: (ids) => devices.filter((d) => ids.map(Number).includes(d.user_id)),
    deliver: async (subs, payload, options) => {
      for (const sub of subs) sent.push({ user: sub.user_id, lang: sub.lang, ...(typeof payload === 'function' ? payload(sub) : payload), options });
      return { sent: subs.length, gone: 0, failed: 0 };
    },
  };
  return { database, push, sent };
}

/** What each person has: by user id, their open things today and what they did. */
function moduleWith(lists, asked = []) {
  return moduleOf('tasks', 'Tasks', {
    agenda: (user, { today }) => { asked.push(['agenda', user.id, today]); return lists[user.id]?.agenda || []; },
    done: (user, { day }) => { asked.push(['done', user.id, day]); return lists[user.id]?.done || []; },
  });
}
const task = (id, date, title = `Task ${id}`) => ({ type: 'task', id, title, date });
const finished = (id) => ({ type: 'task', id, title: `Done ${id}`, at: '2026-11-04T10:00:00Z', kind: 'completed' });

function notices({ database, push }, module, extra = {}) {
  const day = createDay({ modules: () => [module], ...(extra.log ? { log: extra.log } : {}) });
  return createDayNotices({
    database, push, day, texts, languages: ['en', 'es', 'fr', 'de', 'it'],
    userById: (id) => database.get('SELECT * FROM users WHERE id = ?', id), ...extra,
  });
}
const madrid = { tz: 'Europe/Madrid' };

test('each notice goes once a day, from its time until three hours after it, on the person\'s day', async () => {
  const setup = setUp([
    { prefs: madrid, devices: ['es'] },
    { prefs: { tz: 'America/New_York', day: { morning: { at: '07:30' } } }, devices: ['en'] },
  ]);
  const asked = [];
  const lists = { 1: { agenda: [task(1, '2026-11-04')] }, 2: { agenda: [task(2, '2026-11-03')] } };
  const { check } = notices(setup, moduleWith(lists, asked));
  // 07:59 in Madrid: not yet.
  assert.deepEqual(await check({ now: new Date('2026-11-04T06:59:00Z') }), { sent: 0, empty: 0 });
  assert.equal(setup.sent.length, 0);
  // 08:00 in Madrid.
  assert.deepEqual(await check({ now: new Date('2026-11-04T07:00:00Z') }), { sent: 1, empty: 0 });
  assert.deepEqual(setup.sent.map(({ user, title, url, tag }) => ({ user, title, url, tag })),
    [{ user: 1, title: '☀️ Mira lo que tienes para hacer hoy', url: '/today/', tag: 'day-morning' }]);
  assert.deepEqual(setup.sent[0].options, { topic: 'day-morning', ttl: 10800 }, 'a newer one replaces one still waiting for the device');
  assert.deepEqual(asked, [['agenda', 1, '2026-11-04']], 'only what that notice speaks of');
  // The next minutes: done for the day.
  await check({ now: new Date('2026-11-04T07:01:00Z') });
  await check({ now: new Date('2026-11-04T09:30:00Z') });
  assert.equal(setup.sent.length, 1, 'once a day');
  // 07:30 in New York is 12:30 in UTC; 10:30 there (15:30 UTC) is past its three hours.
  assert.equal((await check({ now: new Date('2026-11-04T15:30:00Z') })).sent, 0, 'past its three hours: not that day');
  assert.equal(setup.database.get('SELECT COUNT(*) AS n FROM host_day_notices WHERE user_id = 2').n, 0, 'and nothing claimed');
  assert.equal((await check({ now: new Date('2026-11-05T15:29:00Z') })).sent, 1, 'the next day, at 10:29 there, still in time');
  assert.deepEqual(asked.at(-1), ['agenda', 2, '2026-11-05'], 'their day, not the server\'s');
  // The next day in Madrid, a new one.
  await check({ now: new Date('2026-11-05T07:05:00Z') });
  assert.equal(setup.sent.filter((s) => s.user === 1).length, 2);
});

test('a notice with nothing to say isn\'t sent, and the day counts as done for it', async () => {
  const setup = setUp([{ prefs: madrid, devices: ['es'] }]);
  const lists = { 1: { agenda: [] } };
  const { check } = notices(setup, moduleWith(lists));
  assert.deepEqual(await check({ now: new Date('2026-11-04T07:00:00Z') }), { sent: 0, empty: 1 });
  assert.deepEqual({ ...setup.database.get('SELECT kind, day, outcome FROM host_day_notices') }, { kind: 'morning', day: '2026-11-04', outcome: 'empty' });
  // Something due later that morning waits for tomorrow's.
  lists[1].agenda.push(task(1, '2026-11-04'));
  assert.deepEqual(await check({ now: new Date('2026-11-04T07:30:00Z') }), { sent: 0, empty: 0 });
  assert.equal(setup.sent.length, 0);
  // The evening: what was done, at 19:00.
  lists[1].done = [finished(1), finished(2)];
  assert.deepEqual(await check({ now: new Date('2026-11-04T18:00:00Z') }), { sent: 1, empty: 0 });
  assert.deepEqual(setup.sent.map(({ title, body, url }) => ({ title, body, url })),
    [{ title: '🌙 Lo que has hecho hoy', body: '2 tareas', url: '/today/?v=done' }]);
  assert.equal(setup.database.get("SELECT outcome FROM host_day_notices WHERE kind = 'evening'").outcome, 'sent');
});

test('only to people with a device, who want it, with their account on, and in their language', async () => {
  const setup = setUp([
    { prefs: madrid, devices: [] },                                        // no device
    { prefs: { ...madrid, notices: { due: false } }, devices: ['es'] },    // had Projects' summary off
    { prefs: { ...madrid, day: { evening: { on: false } } }, devices: ['es'] },
    { prefs: madrid, devices: ['es'], disabled: true },
    { prefs: { ...madrid, lang: 'en' }, devices: ['es'] },                 // their choice over the device's
    { prefs: madrid, devices: ['fr', 'de'] },                              // each device in its own
    { prefs: { ...madrid, lang_seen: 'it' }, devices: [null] },            // the browser's last one
  ]);
  const everything = { agenda: [task(1, '2026-11-04')], done: [finished(1)] };
  const lists = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((id) => [id, everything]));
  const { check } = notices(setup, moduleWith(lists));
  await check({ now: new Date('2026-11-04T07:00:00Z') });
  assert.deepEqual(setup.sent.map(({ user, lang, title }) => [user, lang, title]), [
    [3, 'es', '☀️ Mira lo que tienes para hacer hoy'],
    [5, 'es', '☀️ Here’s what you have to do today'],
    [6, 'fr', '☀️ Voici ce que vous avez à faire aujourd’hui'],
    [6, 'de', '☀️ Das steht heute für dich an'],
    [7, null, '☀️ Ecco cosa hai da fare oggi'],
  ]);
  assert.deepEqual(setup.database.all('SELECT user_id FROM host_day_notices ORDER BY user_id').map((r) => r.user_id), [3, 5, 6, 7],
    'nothing claimed for whoever has no device');
  setup.sent.length = 0;
  await check({ now: new Date('2026-11-04T18:00:00Z') });
  assert.deepEqual([...new Set(setup.sent.map((s) => s.user))], [2, 5, 6, 7], 'the evening: on for whoever had the summary of due dates off');
});

test('claimed before sending: two checks at once send it once, and a failure loses only that one', async () => {
  const setup = setUp([{ prefs: madrid, devices: ['es'] }, { prefs: madrid, devices: ['es'] }]);
  const slow = moduleOf('tasks', 'Tasks', {
    agenda: async (user) => {
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      if (user.id === 1) throw new Error('not now');
      return [task(1, '2026-11-04')];
    },
  });
  const lines = [];
  // Two of them, as two processes on one database would be.
  const a = notices(setup, slow, { log: (line) => lines.push(line) });
  const b = notices(setup, slow, { log: (line) => lines.push(line) });
  const now = new Date('2026-11-04T07:00:00Z');
  const [one, two, again] = await Promise.all([a.check({ now }), b.check({ now }), a.check({ now })]);
  assert.equal(one, again, 'the same check, while it runs');
  assert.equal(one.sent + two.sent, 1, 'once');
  assert.equal(one.empty + two.empty, 1, 'a module that failed leaves nothing to say for that one');
  assert.deepEqual(setup.sent.map((s) => s.user), [2]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[day\] tasks agenda: not now$/);
});

test('the notices sent are forgotten after DAY_LOG_DAYS days', async () => {
  const setup = setUp([{ prefs: madrid, devices: ['es'] }]);
  const old = addDays('2026-11-04', -DAY_LOG_DAYS - 1);
  setup.database.run("INSERT INTO host_day_notices (user_id, kind, day, claimed_at) VALUES (1, 'morning', ?, '2026-01-01T00:00:00Z')", old);
  setup.database.run("INSERT INTO host_day_notices (user_id, kind, day, claimed_at) VALUES (1, 'morning', ?, '2026-01-01T00:00:00Z')", addDays('2026-11-04', -DAY_LOG_DAYS));
  const { check } = notices(setup, moduleWith({}));
  await check({ now: new Date('2026-11-04T03:00:00Z') });
  assert.deepEqual(setup.database.all('SELECT day FROM host_day_notices').map((r) => r.day), [addDays('2026-11-04', -DAY_LOG_DAYS)]);
});

test('every: what was done counts the modules taken out of the evening notice too', async () => {
  const item = { type: 'task', id: 1, title: 'Invoice', at: '2026-11-04T10:00:00.000Z', where: 'Work', url: '?task=1', kind: 'completed' };
  const day = createDay({ modules: () => [moduleOf('tasks', 'Tasks', { done: () => [item] })] });
  const ana = { id: 1, prefs: JSON.stringify({ day: { evening: { modules: { tasks: false } } } }) };
  assert.deepEqual((await day.done(ana, { day: '2026-11-04' })).done, [], 'as the notice says');
  assert.equal((await day.done(ana, { day: '2026-11-04', every: true })).done.length, 1, 'and for whoever asks for all of it');
});

test('with 200 overdue or more, today\'s things stay, and the notice counts every overdue one (audit of 6/11, sc-feat-5)', async () => {
  const late = Array.from({ length: 230 }, (_, i) => ({ type: 'task', id: i + 1, title: `Late ${i + 1}`, date: addDays('2026-11-04', -1 - i) }));
  const today = [1, 2, 3].map((n) => ({ type: 'task', id: 1000 + n, title: `Today ${n}`, date: '2026-11-04' }));
  // As Tasks gives it: the oldest first, a list.
  const listed = createDay({ modules: () => [moduleOf('tasks', 'Tasks', { agenda: () => [...late].reverse().concat(today) })] });
  const answer = await listed.summary(ana, { date: '2026-11-04' });
  assert.equal(answer.overdue.length, DAY_MODULE_MAX, 'the oldest 200 overdue');
  assert.equal(answer.overdue[0].id, 230);
  assert.deepEqual(answer.today.map((item) => item.title), ['Today 1', 'Today 2', 'Today 3'], 'and every one of today\'s');
  assert.equal(answer.overdue_total, 230, 'how many there were');
  // A module that gives fewer than it has says how many: `{ items, overdueTotal }`.
  const counted = createDay({
    modules: () => [moduleOf('tasks', 'Tasks', { agenda: (user, { limit }) => ({ items: [...late.slice(-limit)].reverse().concat(today), overdueTotal: 512 }) })],
  });
  const agenda = await counted.agenda(ana, { today: '2026-11-04' });
  assert.equal(agenda.overdue.length, DAY_MODULE_MAX);
  assert.equal(agenda.today.length, 3);
  assert.equal(agenda.overdueTotal, 512);
  assert.equal(dayNotice('morning', agenda, say('en')).body, '512 overdue · 3 for today: “Today 1”, “Today 2”, and 1 more',
    'the real count, and today\'s titles');
  assert.equal(dayNotice('morning', { overdue: items(2, 'Old '), overdueTotal: 9 }, say('en')).body, '9 overdue: “Old 1”, “Old 2”, and 7 more');
  // Whatever else a module says there is no count.
  for (const overdueTotal of [-1, 1.5, '700', null]) {
    const odd = createDay({ modules: () => [moduleOf('tasks', 'Tasks', { agenda: () => ({ items: today, overdueTotal }) })] });
    assert.equal((await odd.agenda(ana, { today: '2026-11-04' })).overdueTotal, 0, String(overdueTotal));
  }
  const broken = createDay({ modules: () => [moduleOf('tasks', 'Tasks', { agenda: () => ({ overdueTotal: 3 }) })] });
  assert.deepEqual((await broken.agenda(ana, { today: '2026-11-04' })).failed, ['tasks'], 'no list: that module failed');
});

test('whether someone uses each module is asked once a module for the whole summary (audit of 6/11, sc-host-11)', async () => {
  const asked = [];
  const part = { agenda: () => [], done: () => [] };
  const day = createDay({
    modules: () => [moduleOf('tasks', 'Tasks', part), moduleOf('projects', 'Projects', part), moduleOf('next', 'Next', { done: () => [] })],
    uses: (user, mount) => { asked.push(mount); return true; },
  });
  await day.summary(ana, { date: '2026-11-04' });
  assert.deepEqual(asked.sort(), ['next', 'projects', 'tasks'], 'it was 2 + 3 + 3');
});
