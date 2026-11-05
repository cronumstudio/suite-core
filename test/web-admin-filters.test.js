/**
 * Finding one account in the admin panel (web/admin.js) on a fake page: Accounts narrowed as a
 * search is typed, how many devices each has and which, an account's dialog opening its Activity,
 * and Activity filtered by account, by action and by days, the filters in the address and in every
 * page asked for. The server is a stand-in; the texts are the core's English catalog. A file of its
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
const settle = async (turns = 10) => { for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const t = (key, vars = {}) => english[key].replace(/\{(\w+)\}/g, (_, name) => vars[name]);

const person = (id, username, display_name, email) => ({
  id, username, display_name, email, email_verified: true, role: 'user', providers: [], plan: null, plan_ends: null, unlimited: false,
});
const USERS = [
  person(1, 'ada', 'Ada Lovelace', 'ada@example.com'),
  person(2, 'ben', 'Benjamín Pérez', 'ben@example.com'),
  person(3, 'fiverr', 'Fiverr testers', 'dev+fiverrtesters@cronumstudio.com'),
  person(4, 'eve', 'Eve', null),
];
const entry = (id, action, actor, meta = {}) => ({
  id, at: '2026-11-05T09:00:00.000Z', action, actor_user_id: actor, actor_username: USERS.find((u) => u.id === actor)?.username ?? null,
  target_type: null, target_id: null, ip: '203.0.113.7', meta,
});

let loads = 0;
/**
 * The panel opened at `hash`, on a server that answers `answers` (a value, or a function of the
 * query for the log). → { main, asked: the log's queries, go(hash): another address, as a link does }
 */
async function adminAt(hash, answers = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const byId = (id) => root.all().find((node) => node.getAttribute('id') === id) || null;
  document.querySelector = (selector) => (selector === '#admin' ? root : selector.startsWith('#') ? byId(selector.slice(1)) : null);
  document.querySelectorAll = () => [];
  let onHash = null;
  const history = [];
  globalThis.window = {
    location: { hash },
    addEventListener: (type, fn) => { if (type === 'hashchange') onHash = fn; },
    matchMedia: () => ({ matches: false }),
    history: { replaceState: (_, __, url) => { history.push(url); globalThis.window.location.hash = url; } },
  };
  const asked = [];
  const server = {
    'GET /api/auth/config': { provider: 'local', app: { name: 'Work', languages: ['en'], modules: {} } },
    'GET /api/auth/me': { user: { id: 99, username: 'root', display_name: 'Root', role: 'admin' } },
    'GET /api/admin/users': { users: USERS },
    'GET /api/admin/users/1/grants': { grants: [] },
    ...answers,
  };
  globalThis.fetch = async (path, { method = 'GET' } = {}) => {
    if (String(path).startsWith('/i18n/')) return { ok: true, status: 200, json: async () => english };
    let answer = server[`${method} ${path}`];
    if (method === 'GET' && String(path).startsWith('/api/admin/audit?')) {
      const query = new URLSearchParams(String(path).split('?')[1]);
      asked.push(query);
      answer = server.audit?.(query) ?? { entries: [] };
    }
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, json: async () => answer ?? { error: 'not_found' } };
  };
  await import(`../web/admin.js?filters=${++loads}`);
  await settle(30);
  return {
    main: () => byId('admin-main'), asked, history,
    go: async (next) => { globalThis.window.location.hash = next; onHash(); await settle(30); },
  };
}

test('Accounts: narrowed by email, username or name as it is typed, without accents or capitals; kept when drawn again', async () => {
  const page = await adminAt('#/users');
  const main = page.main();
  const search = main.find('input').find((node) => node.getAttribute('type') === 'search');
  assert.equal(search.getAttribute('placeholder'), t('admin.users.searchHint'));
  const rows = () => page.main().find('tbody')[0].find('tr');
  const shown = () => rows().filter((row) => !row.hidden).map((row) => row.find('small')[0].textContent);
  assert.deepEqual(shown(), ['@ada', '@ben', '@fiverr', '@eve'], 'everyone before a search');
  assert.equal(main.find('th').some((th) => th.textContent === t('admin.users.devices')), false, 'no devices where none connect');

  const type = (text) => { search.value = text; search.dispatch('input'); };
  type('FIVERRTESTERS');
  assert.deepEqual(shown(), ['@fiverr'], 'by the email, whatever the capitals');
  type('benjamin');
  assert.deepEqual(shown(), ['@ben'], 'by the name, without its accent');
  type('eve');
  assert.deepEqual(shown(), ['@eve'], 'by the username');
  type('example lovelace');
  assert.deepEqual(shown(), ['@ada'], 'every word, anywhere');
  const none = main.find('p').find((node) => node.className === 'kit-empty');
  assert.equal(none.hidden, true);
  type('nobody');
  assert.deepEqual(shown(), []);
  assert.equal(none.hidden, false);
  assert.equal(none.textContent, t('admin.users.noMatch', { query: 'nobody' }));

  // Drawn again (an account saved, the tab come back to), the search is still there.
  type('fiverr');
  await page.go('#/users');
  assert.equal(page.main().find('input').find((node) => node.getAttribute('type') === 'search').value, 'fiverr');
  assert.deepEqual(shown(), ['@fiverr']);
});

test('Accounts: how many devices each account has connected, and in its dialog which, with their app and dates', async () => {
  const page = await adminAt('#/users', {
    'GET /api/admin/users': { users: USERS.map((u) => ({ ...u, devices: u.id === 3 ? 2 : 0 })) },
    'GET /api/admin/users/3/devices': {
      devices: [
        { id: 14, name: 'Pixel 8', platform: 'android', app_version: '0.5.3', created_at: '2026-11-04T10:00:00.000Z', last_used_at: '2026-11-05T09:00:00.000Z' },
        { id: 4, name: null, platform: 'ios', app_version: null, created_at: '2026-11-01T10:00:00.000Z', last_used_at: null },
      ],
    },
  });
  const main = page.main();
  const heads = main.find('th').map((th) => th.textContent);
  assert.equal(heads[heads.indexOf(t('admin.users.lastSignIn')) + 1], t('admin.users.devices'), 'after the last sign-in');
  assert.deepEqual(main.find('td').filter((td) => td.getAttribute('data-devices')).map((td) => td.textContent), ['0', '0', '2', '0']);

  main.find('tbody')[0].find('tr')[2].click();
  await settle();
  const dialog = document.body.find('dialog').find((d) => d.open);
  const devices = dialog.find('details').find((d) => d.find('summary')[0].textContent.startsWith(t('admin.users.devices')));
  assert.match(devices.find('summary')[0].textContent, new RegExp(english['admin.users.devicesCount'].other.replace('{n}', 2)));
  assert.ok(devices.find('p').some((p) => p.textContent === t('admin.users.devicesLead')), 'what a number in Activity is, and isn’t');
  const rows = devices.find('tbody')[0].find('tr').map((row) => row.find('td').map((td) => td.textContent));
  assert.equal(rows[0][0], 'Pixel 8Android', 'its name, and its platform as people write it');
  assert.equal(rows[0][1], '0.5.3');
  assert.equal(rows[1][0], 'iOS', 'without a name, its platform');
  assert.equal(rows[1][1], '—');
  assert.equal(rows[1][3], t('admin.users.never'), 'not used since it connected');
  dialog.close();
});

test('Accounts: Enter opens the one account left, and its dialog opens its activity', async () => {
  const page = await adminAt('#/users', { audit: () => ({ entries: [entry(9, 'device.create', 3, { platform: 'android' })] }) });
  const search = page.main().find('input').find((node) => node.getAttribute('type') === 'search');
  search.value = 'e';
  search.dispatch('keydown', { key: 'Enter', preventDefault: () => {} });
  assert.equal(document.body.find('dialog').filter((d) => d.open).length, 0, 'several accounts: nothing opens');

  // The Enter goes no further: in a browser it would press the × of the dialog it just opened.
  let kept = 0;
  const enter = { key: 'Enter', preventDefault: () => { kept += 1; } };
  search.value = 'fiverr';
  search.dispatch('keydown', enter);
  const dialog = document.body.find('dialog').find((d) => d.open);
  assert.ok(dialog, 'the one account opens');
  assert.equal(kept, 1);
  assert.match(dialog.textContent, /Fiverr testers \(@fiverr\)/);
  const link = dialog.find('a').find((node) => node.textContent === t('admin.users.activity'));
  assert.equal(link.getAttribute('href'), '#/audit?actor=3');
  link.click();
  assert.equal(dialog.open, false, 'the dialog goes, the address takes Activity');

  // The same on a row with the focus.
  page.main().find('tbody')[0].find('tr').find((row) => !row.hidden).dispatch('keydown', enter);
  assert.equal(kept, 2);
  const again = document.body.find('dialog').find((d) => d.open);
  assert.match(again.textContent, /Fiverr testers \(@fiverr\)/);
  again.close();

  await page.go(link.getAttribute('href'));
  assert.equal(page.asked.at(-1).get('actor'), '3');
  const main = page.main();
  assert.equal(main.find('input').find((node) => node.getAttribute('list')).value, 'dev+fiverrtesters@cronumstudio.com');
  assert.ok(main.find('p').some((node) => node.textContent === t('admin.audit.onlyOf', { name: 'Fiverr testers (@fiverr)' })));
  assert.match(main.find('tbody')[0].textContent, /platform: android/);
});

test('Activity: by account, by family or one action, and by days, in the address and in every page asked for', async () => {
  const page = await adminAt('#/audit?actor=3&action=device.create&since=2026-11-01', {
    'GET /api/admin/audit/actions': { actions: ['auth.login', 'auth.login_failed', 'device.create', 'device.revoke', 'device.web_session'] },
    // A full page for the newest, then the last ones.
    audit: (query) => ({
      entries: query.get('before') ? [entry(1, 'auth.login', 2)]
        : Array.from({ length: 50 }, (_, i) => entry(100 - i, 'device.create', i % 2 ? 2 : 3)),
    }),
  });
  const main = page.main();
  const [select] = main.find('select');
  const who = main.find('input').find((node) => node.getAttribute('list') === 'admin-audit-accounts');
  const [since, until] = main.find('input').filter((node) => node.getAttribute('type') === 'date');
  const said = () => main.find('p').find((node) => node.getAttribute('aria-live')).textContent;
  const last = () => Object.fromEntries(page.asked.at(-1));

  // As the address asked: one account, that action alone, from the first moment of that day here.
  assert.deepEqual(last(), { limit: '50', actor: '3', action: 'device.create', exact: '1', since: new Date('2026-11-01T00:00:00').toISOString() });
  assert.equal(select.value, 'device.create');
  assert.equal(since.value, '2026-11-01');
  assert.equal(who.value, 'dev+fiverrtesters@cronumstudio.com');
  assert.equal(said(), t('admin.audit.onlyOf', { name: 'Fiverr testers (@fiverr)' }));

  // Each family of what the log holds, then each of its actions.
  const groups = select.find('optgroup');
  assert.deepEqual(groups.map((g) => g.getAttribute('label')), [t('admin.audit.kinds.auth'), t('admin.audit.kinds.device')]);
  assert.deepEqual(groups[1].find('option').map((o) => [o.getAttribute('value'), o.textContent]), [
    ['device.', t('admin.audit.allOf', { kind: t('admin.audit.kinds.device') })],
    ['device.create', t('admin.actions.device_create')], ['device.revoke', t('admin.actions.device_revoke')],
    ['device.web_session', t('admin.actions.device_web_session')]]);

  // More of the same: the next page keeps every filter.
  const more = main.find('button').find((node) => node.textContent === t('admin.audit.more'));
  assert.notEqual(more.hidden, true);
  more.click();
  await settle();
  assert.deepEqual(last(), { ...Object.fromEntries(page.asked.at(-2)), before: '51' });
  assert.equal(main.find('tbody')[0].find('tr').length, 51);

  // A whole family, and a last day, to its last moment.
  select.value = 'device.';
  select.dispatch('change');
  until.value = '2026-11-05';
  until.dispatch('change');
  await settle();
  assert.deepEqual(last(), {
    limit: '50', actor: '3', action: 'device.', since: new Date('2026-11-01T00:00:00').toISOString(),
    until: new Date('2026-11-05T23:59:59.999').toISOString(),
  });
  assert.equal(page.history.at(-1), '#/audit?actor=3&action=device.&since=2026-11-01&until=2026-11-05', 'the address keeps them');
  assert.equal(main.find('tbody')[0].find('tr').length, 50, 'drawn again from the newest');

  // Another account by its name in a row.
  const asked = page.asked.length;
  const ben = main.find('tbody')[0].find('button').find((node) => node.textContent === '@ben');
  assert.equal(ben.getAttribute('title'), t('admin.audit.onlyThem'));
  assert.equal(main.find('tbody')[0].find('button').some((node) => node.textContent === '@fiverr'), false, 'the account shown is no link');
  ben.click();
  await settle();
  assert.equal(page.asked.length, asked + 1);
  assert.equal(last().actor, '2');
  assert.equal(who.value, 'ben@example.com');

  // Typed: several found, or none, ask nothing; one does, by username too.
  const type = async (text) => { who.value = text; who.dispatch('change'); await settle(); };
  await type('example');
  assert.equal(page.asked.length, asked + 1);
  assert.equal(said(), `${english['admin.audit.manyAccounts'].other.replace('{n}', 2)} ${t('admin.audit.onlyOf', { name: 'Benjamín Pérez (@ben)' })}`);
  await type('zzz');
  assert.match(said(), new RegExp(`^${t('admin.audit.noAccount', { query: 'zzz' })}`.replace(/[.()]/g, '\\$&')));
  await type('@eve');
  assert.equal(last().actor, '4', 'an account without an email, by its username');
  // The datalist offers each account by its email, or its username without one.
  assert.deepEqual(main.find('datalist')[0].find('option').map((o) => o.getAttribute('value')),
    ['ada@example.com', 'ben@example.com', 'dev+fiverrtesters@cronumstudio.com', '@eve']);

  // Taken off at once.
  const clearButton = main.find('button').find((node) => node.textContent === t('admin.audit.clear'));
  assert.notEqual(clearButton.hidden, true);
  clearButton.click();
  await settle();
  assert.deepEqual(last(), { limit: '50' });
  assert.equal(who.value, '');
  assert.equal(select.value, '');
  assert.equal(clearButton.hidden, true);
  assert.equal(page.history.at(-1), '#/audit');
});

test('Activity: nothing found with filters says so, apart from a log with nothing yet', async () => {
  const page = await adminAt('#/audit?action=auth.', { 'GET /api/admin/audit/actions': { actions: ['auth.login'] } });
  const empty = () => page.main().find('td').find((node) => node.className === 'kit-empty').textContent;
  assert.equal(page.asked.at(-1).get('exact'), null, 'a family is what begins so');
  assert.equal(empty(), t('admin.audit.noneFiltered'));
  await page.go('#/audit');
  assert.equal(empty(), t('admin.audit.none'));
});
