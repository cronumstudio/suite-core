/**
 * The admin panel's Usage (web/admin.js › Users) on a fake page: the list says how near each
 * account is to its nearest cap, and an account's dialog what it keeps in each module against its
 * plan, its storage and its calls from assistants, near and at a limit in words too. The server is
 * a stand-in (a host's answers, usage.js); the texts are the core's English catalog. A file of its
 * own: admin.js starts the page as it is imported.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

const document = installFakeDom();
const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const t = (key, vars = {}) => english[key].replace(/\{(\w+)\}/g, (_, name) => vars[name]);

const PRO = { id: 'pro', name: 'Pro' };
const person = (id, username) => ({ id, username, display_name: username, role: 'user', email: null, providers: [], plan: PRO, plan_ends: null, unlimited: false });
const days = Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, used: i === 29 ? 90 : i % 2 }));
const USAGE = {
  user_id: 1,
  modules: [
    { mount: 'tasks', name: 'Tasks', on: true, active_at: '2026-10-21T18:22:00.000Z', failed: false, bytes: 3 * 1024 * 1024,
      counts: [{ id: 'lists', count: 17, feature: 'lists.max', limit: 20, share: 0.85 }, { id: 'tasks', count: 340, feature: null, limit: null, share: null },
        { id: 'files', count: 7, feature: null, limit: null, share: null }] },
    { mount: 'notes', name: 'Notes', on: false, active_at: null, failed: true, counts: [], bytes: 0 },
    { mount: 'next', name: 'Next', on: true, active_at: null, failed: false, counts: [] },
  ],
  storage: { bytes: 3 * 1024 * 1024, files: 7, limit_mb: 50, share: 0.06 },
  mcp: { limit: 90, today: 90, share: 1, days, total: 104 },
  peak: { share: 1, id: 'mcp' },
};

test('Usage: each account’s nearest cap in the list, and in its dialog each module’s counts against the plan, the storage and the month of calls', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  globalThis.window = { location: { hash: '#/users' }, addEventListener: () => {}, matchMedia: () => ({ matches: false }) };
  const server = {
    'GET /api/auth/config': { provider: 'local', app: { name: 'Work', languages: ['en'], modules: {} } },
    'GET /api/auth/me': { user: { username: 'root', display_name: 'Root', role: 'admin' } },
    'GET /api/admin/plans': { defaultPlan: 'free', plans: [{ id: 'free', name: 'Free', features: {} }, { ...PRO, features: {} }], features: {}, several: true },
    'GET /api/admin/users': { users: [person(1, 'ada'), person(2, 'ben')] },
    'GET /api/admin/usage': { peaks: { 1: { share: 0.85, mount: 'tasks', name: 'Tasks', id: 'lists' }, 2: null } },
    'GET /api/admin/users/1/grants': { grants: [] },
    'GET /api/admin/users/1/usage': USAGE,
  };
  globalThis.fetch = async (path, { method = 'GET' } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    const answer = server[`${method} ${path}`];
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, json: async () => answer ?? { error: 'not_found' } };
  };
  await import('../web/admin.js');
  let main = null;
  for (let turn = 0; turn < 50 && !(main = byId('admin-main'))?.find('tr').length; turn++) await settle();
  for (let turn = 0; turn < 10; turn++) await settle();

  assert.equal(main.find('th').at(-1).textContent, t('admin.users.usage'));
  const rows = main.find('tr').slice(1);
  const usageCell = (row) => row.find('td').at(-1);
  assert.match(usageCell(rows[0]).textContent, /^85\s?%/);
  assert.match(usageCell(rows[0]).textContent, new RegExp(t('kit.usage.peakIn', { what: 'Lists', module: 'Tasks' })));
  assert.equal(usageCell(rows[0]).find('span').find((n) => n.getAttribute('role') === 'meter').getAttribute('aria-valuenow'), '85');
  assert.equal(usageCell(rows[1]).textContent, '—', 'no limits, nothing to be near');

  rows[0].dispatch('click');
  for (let turn = 0; turn < 20; turn++) await settle();
  const dialog = document.body.all().find((node) => node.tagName === 'DIALOG' && node.open);
  const fold = dialog.find('details').find((node) => node.find('summary')[0].textContent.startsWith(t('admin.usage.title')));
  assert.ok(fold, 'the account has its Usage');
  const now = fold.find('small').find((n) => (n.getAttribute('class') || '').includes('kit-fold__now'));
  assert.match(now.textContent, new RegExp(`^100\\s?% · ${t('kit.usage.mcp').replace(/[()]/g, '\\$&')}$`), 'the cap they are nearest to');
  assert.match(now.getAttribute('class'), /kit-fold__now--warn/);
  const text = fold.textContent;
  assert.match(text, /Lists17 of 20 · 85\s?%/);
  assert.match(text, new RegExp(t('kit.usage.near')), 'near the limit, in words');
  assert.match(text, /Tasks340/, 'a count without a limit, alone');
  assert.match(text, /Files7/);
  assert.match(text, new RegExp(t('admin.usage.off')), 'a module they turned off says so');
  assert.match(text, new RegExp(t('admin.usage.failed').replace(/[()]/g, '\\$&')));
  assert.match(text, new RegExp(t('admin.usage.nothing')));
  assert.match(text, /3 MB of 50 MB · 6\s?%/);
  assert.match(text, new RegExp(t('kit.usage.reached')), 'today’s calls at the limit, in words');
  assert.match(text, /Last 30 days: 104 calls, 3\.5 a day on average/, 'an account older than the month: its 30 days');
  const bars = fold.find('div').find((n) => n.getAttribute('class') === 'kit-usage__days');
  assert.equal(bars.childNodes.length, 30);
  assert.equal(bars.childNodes.at(-1).childNodes[0].getAttribute('style'), 'block-size: 100%', 'the busiest day reaches the top');
  assert.equal(bars.childNodes[0].getAttribute('class'), 'kit-usage__day kit-usage__day--none', 'a day without calls is a stub');
  assert.match(bars.childNodes.at(-1).getAttribute('data-tip'), /: 90 calls$/, 'pointing at a day says its calls');
  assert.match(bars.childNodes[1].getAttribute('data-tip'), /: 1 call$/);
  assert.equal(bars.childNodes.at(-1).getAttribute('tabindex'), '-1', 'a tap focuses it, the Tab key passes it by');
  dialog.close();

  // Someone with no daily limit: their calls counted all the same, with no bar of a limit.
  server['GET /api/admin/users/2/grants'] = { grants: [] };
  // …and made three days ago: the average is of its three days, and the days before it are empty.
  server['GET /api/admin/users/2/usage'] = { ...USAGE, user_id: 2, mcp: { limit: null, today: 12, share: null, days: days.map((d, i) => (i < 27 ? { ...d, used: 0 } : d)), since: '2026-10-28', total: 91 }, peak: null };
  rows[1].dispatch('click');
  for (let turn = 0; turn < 20; turn++) await settle();
  const ben = document.body.all().find((node) => node.tagName === 'DIALOG' && node.open);
  const benText = ben.find('details').find((node) => node.find('summary')[0].textContent.startsWith(t('admin.usage.title'))).textContent;
  assert.match(benText, new RegExp(`${t('kit.usage.today')}12${t('admin.usage.noDailyLimit')}`));
  assert.match(benText, /Last 3 days: 91 calls, 30\.3 a day on average/);
  const benBars = ben.find('div').find((n) => n.getAttribute('class') === 'kit-usage__days');
  assert.equal(benBars.childNodes.length, 30, 'the chart is still the month, today the last');
  assert.equal(benBars.childNodes.filter((n) => n.getAttribute('class') === 'kit-usage__day kit-usage__day--before').length, 27);
  assert.equal(benBars.childNodes[26].getAttribute('data-tip'), null, 'a day before the account says nothing');
  ben.close();
});

test('calls by the week: the admin sees four weeks from Monday and the average a week, each person this week, the limit while a bigger plan has more', async () => {
  // Uses the English catalog the test above loaded. 30 October 2026 is a Friday: the week began on the 26th.
  const { usageGroups, atLimit, weekDays } = await import('../web/usage-view.js');
  const weekly = (mcp) => ({ ...USAGE, mcp: { period: 'week', limit: 100, today: 90, week: 92, share: 0.92, more: { id: 'pro', name: 'Pro', limit: 2000 }, days, since: null, total: 104, ...mcp } });
  const calls = (node) => node.find('section').at(-1);
  const chart = (node) => calls(node).find('div').find((n) => (n.getAttribute('class') || '').startsWith('kit-usage__days'));
  const kinds = (bars) => bars.childNodes.map((n) => (n.getAttribute('class').match(/--(none|before|ahead)/)?.[1] ?? 'day'));

  assert.deepEqual(weekDays(days, 1).map((d) => [d.day, d.used, d.ahead ?? false]), [['2026-10-26', 1, false], ['2026-10-27', 0, false],
    ['2026-10-28', 1, false], ['2026-10-29', 0, false], ['2026-10-30', 90, false], ['2026-10-31', 0, true], ['2026-11-01', 0, true]]);
  assert.equal(weekDays(days, 4)[0].day, '2026-10-05');

  const admin = calls(usageGroups(weekly(), { admin: true }));
  assert.match(admin.textContent, /^Calls from assistants \(MCP\)This week92 of 100 · 92\s?%/);
  assert.match(admin.textContent, new RegExp(t('kit.usage.renews')));
  assert.match(admin.textContent, /Last 4 weeks: 102 calls, 27 a week on average/, 'the days so far of four weeks, by the week');
  const weeks = chart(usageGroups(weekly(), { admin: true }));
  assert.equal(weeks.getAttribute('class'), 'kit-usage__days kit-usage__days--weeks');
  assert.equal(weeks.childNodes.length, 28, 'four weeks, Monday to Sunday');
  assert.deepEqual(weeks.childNodes.map((n, i) => (n.getAttribute('class').includes('--monday') ? i : null)).filter((i) => i !== null), [7, 14, 21]);
  assert.deepEqual(kinds(weeks).slice(-3), ['day', 'ahead', 'ahead'], 'Saturday and Sunday still to come');
  assert.equal(weeks.childNodes.at(-1).getAttribute('data-tip'), null);
  assert.match(weeks.childNodes[25].getAttribute('data-tip'), /: 90 calls$/);

  // Younger than a week: no average; younger than four weeks: since the account.
  const young = { days: days.map((d, i) => (i < 27 ? { ...d, used: 0 } : d)), since: '2026-10-28', total: 91 };
  assert.match(calls(usageGroups(weekly(young), { admin: true })).textContent, /Last 3 days: 91 calls$/);
  const days11 = { days: days.map((d, i) => (i < 19 ? { ...d, used: 0 } : d)), since: '2026-10-20', total: 95 };
  assert.match(calls(usageGroups(weekly(days11), { admin: true })).textContent, /Last 11 days: 95 calls, 60 a week on average/);
  assert.equal(kinds(chart(usageGroups(weekly(young), { admin: true }))).filter((k) => k === 'before').length, 23);

  // Each person: this week only, no average.
  const own = calls(usageGroups(weekly()));
  assert.match(own.textContent, /^Calls from assistants \(MCP\)This week92 of 100 · 92\s?%Near the limitStarts again on MondayMTWTFSS$/, 'no average, the initials of the days');
  const week = chart(usageGroups(weekly()));
  assert.equal(week.getAttribute('class'), 'kit-usage__days kit-usage__days--week');
  assert.deepEqual(kinds(week), ['day', 'none', 'day', 'none', 'day', 'ahead', 'ahead']);
  assert.deepEqual(kinds(chart(usageGroups(weekly(young)))), ['before', 'before', 'day', 'none', 'day', 'ahead', 'ahead']);
  assert.deepEqual(atLimit(weekly()).map((c) => c.text), ['92 assistant calls this week', '17 lists'], 'the worst first');

  // On the top plan, far from the limit: the calls alone, without a bar that would say how few.
  const top = calls(usageGroups(weekly({ limit: 2000, week: 320, share: 0.16, more: null })));
  assert.equal(top.textContent, `${t('kit.usage.mcp')}${t('kit.usage.thisWeek')}320 callsMTWTFSS`);
  assert.equal(top.find('span').filter((n) => n.getAttribute('role') === 'meter').length, 0);
  assert.match(calls(usageGroups(weekly({ limit: 2000, week: 1600, share: 0.8, more: null }))).textContent, /1,600 of 2,000 · 80\s?%/, 'near it, the limit shows');
  assert.match(calls(usageGroups(weekly({ limit: null, week: 320, share: null, more: null }))).textContent,
    new RegExp(`320 calls${t('kit.usage.noWeeklyLimit')}`));
  assert.match(calls(usageGroups(weekly({ limit: 2000, week: 320, share: 0.16, more: null }), { admin: true })).textContent, /320 of 2,000/, 'the admin always sees it');
});

test('countedDays: the days of the month since the account, or since its first call when that is earlier', async () => {
  const { countedDays } = await import('../web/usage-view.js');
  const month = (used = () => 0) => Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, used: used(i) }));
  assert.equal(countedDays({ days: month() }).length, 30, 'without the day of the account, all of them');
  assert.equal(countedDays({ days: month(), since: '2025-01-09' }).length, 30, 'an account older than the month');
  assert.equal(countedDays({ days: month(), since: '2026-10-28' }).length, 3);
  assert.equal(countedDays({ days: month(), since: '2026-10-30' }).length, 1, 'made today: today');
  assert.equal(countedDays({ days: month(), since: '2026-11-02' }).length, 1, 'a clock behind: today all the same');
  assert.equal(countedDays({ days: month((i) => (i === 19 ? 4 : 0)), since: '2026-10-28' }).length, 11, 'calls before the account (one brought from an app) count from the first');
});
