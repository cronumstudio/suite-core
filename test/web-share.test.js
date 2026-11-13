/**
 * The share dialog (web/share.js), without a browser: who has something, inviting by email and
 * by one's people's chips through sharing.js' routes, changing a permission and taking it back;
 * an app's own functions and words in their place; leaving what was shared with one.
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
globalThis.location = { href: 'https://app.example.com/', origin: 'https://app.example.com', pathname: '/', reload: () => {} };
globalThis.window = { location: globalThis.location };

const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });

const { loadLanguage, t } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
const { shareDialog } = await import('../web/share.js');

const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((done) => setTimeout(done, 0)); };
const openDialogs = () => document.body.all().filter((node) => node.tagName === 'DIALOG' && node.open);
const button = (root, text) => root.all().find((node) => node.tagName === 'BUTTON' && node.textContent === text);
const byClass = (root, name) => root.all().filter((node) => (node.getAttribute?.('class') || '').split(/\s+/).includes(name));
const closeAll = () => openDialogs().forEach((d) => d.close());

/** The server as sharing.js' routes answer, recording what the dialog asks. */
function server() {
  const state = {
    role: 'owner',
    owner: { id: 1, name: 'Ana' },
    shares: [{ user: { id: 2, name: 'Ben', email: 'ben@example.com' }, permission: 'edit', accepted: true }],
  };
  const calls = [];
  globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const data = body ? JSON.parse(body) : undefined;
    calls.push([method, path, data]);
    let answer = {};
    if (method === 'GET' && path.endsWith('/sharing/people')) {
      answer = { people: [{ id: 2, name: 'Ben' }, { id: 3, name: 'Cris' }, { id: 4, name: 'Dani' }] };
    } else if (method === 'GET') {
      answer = structuredClone(state);
    } else if (method === 'POST' && data.email) {
      state.shares.push({ user: { id: 9, name: data.email, email: data.email }, permission: data.permission, accepted: false });
      answer = { share: { user: { id: null, name: data.email, email: data.email }, permission: data.permission, accepted: false }, invited: true };
    } else if (method === 'POST') {
      const share = { user: { id: data.user_id, name: data.user_id === 3 ? 'Cris' : 'Dani', email: 'x@example.com' }, permission: data.permission, accepted: false };
      state.shares.push(share);
      answer = { share, invited: true };
    } else if (method === 'PATCH') {
      answer = { ...state.shares[0], permission: data.permission };
    } else if (method === 'DELETE') {
      answer = { ok: true };
    }
    return { ok: true, status: 200, json: async () => answer };
  };
  return { state, calls };
}

test('its owner sees who has it, invites by email and by chips, changes and takes back, through the routes', async () => {
  const { calls } = server();
  const outcome = shareDialog({ base: '/api/boards/10', name: 'Plans', me: 1, people: '/api/sharing/people' });
  await settle();
  const [dialog] = openDialogs();
  assert.equal(dialog.getAttribute('aria-label'), t('kit.share.title', { name: 'Plans' }));
  assert.match(dialog.textContent, new RegExp(t('kit.share.you', { name: 'Ana' }).replace(/[()]/g, '\\$&')));
  assert.match(dialog.textContent, /ben@example\.com/, 'the email the owner typed');
  const chips = byClass(dialog, 'kit-people__chip').map((n) => n.textContent);
  assert.deepEqual(chips, ['Cris', 'Dani'], 'whoever has it already is no chip');

  const invite = button(dialog, t('kit.share.invite'));
  assert.equal(invite.disabled, true, 'nothing to send yet');
  const email = dialog.all().find((n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'email');
  email.value = 'eve@example.com';
  email.dispatch('input');
  assert.equal(invite.disabled, false);
  byClass(dialog, 'kit-share__invite')[0].dispatch('submit', { preventDefault() {} });
  await settle();
  assert.deepEqual(calls.filter(([m]) => m === 'POST').at(-1), ['POST', '/api/boards/10/shares', { email: 'eve@example.com', permission: 'edit' }]);
  assert.match(dialog.textContent, /eve@example\.com/, 'read again after an offer by email');
  assert.equal(byClass(dialog, 'kit-share__pending').length, 1);
  assert.equal(email.value, '');

  // Two chips at once: one request each, by id.
  byClass(dialog, 'kit-people__chip').forEach((chip) => chip.dispatch('click'));
  byClass(dialog, 'kit-share__invite')[0].dispatch('submit', { preventDefault() {} });
  await settle();
  assert.deepEqual(calls.filter(([m]) => m === 'POST').slice(-2).map(([, , body]) => body.user_id), [3, 4]);
  assert.deepEqual(byClass(dialog, 'kit-people__chip'), [], 'nobody left to add');

  const select = byClass(dialog, 'kit-share__permission')[0];
  select.value = 'view';
  select.dispatch('change');
  await settle();
  assert.deepEqual(calls.find(([m]) => m === 'PATCH'), ['PATCH', '/api/boards/10/shares/2', { permission: 'view' }]);
  const takeBack = dialog.all().find((n) => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === t('kit.share.remove', { name: 'Ben' }));
  takeBack.dispatch('click');
  await settle();
  // Ben had accepted it: asked first, by default.
  const question = openDialogs().at(-1);
  assert.match(question.textContent, new RegExp(t('kit.share.removeAsk', { name: 'Ben' }).replace(/[?]/g, '\\$&')));
  assert.equal(calls.find(([m]) => m === 'DELETE'), undefined, 'nothing taken back before the answer');
  button(question, t('kit.share.takeBack')).dispatch('click', { currentTarget: button(question, t('kit.share.takeBack')) });
  await settle();
  assert.deepEqual(calls.find(([m]) => m === 'DELETE'), ['DELETE', '/api/boards/10/shares/2', undefined]);
  assert.doesNotMatch(dialog.textContent, /ben@example\.com/);
  closeAll();
  assert.equal(await outcome, null);
});

test('an app\'s own functions and words, without an email field: chips only, or a sentence when nobody is left', async () => {
  const seen = [];
  let shares = [];
  const people = [{ id: 5, name: 'Fer' }];
  const options = {
    name: 'Shopping', me: 1, email: false, people, empty: 'Nobody else here yet.',
    words: (key) => (key === 'title' ? 'modals.share.title' : `kit.share.${key}`),
    detail: (share) => `@${share.user.username}`,
    load: async () => ({ role: 'owner', owner: { id: 1, name: 'Ana' }, shares }),
    offer: async (target, permission) => {
      seen.push(['offer', target.id, permission]);
      shares = [{ user: { id: target.id, name: 'Fer', username: 'fer' }, permission, accepted: false }];
      return { share: null, invited: true };
    },
    setPermission: async (share, permission) => { seen.push(['permission', share.user.id, permission]); },
    remove: async (share) => { seen.push(['remove', share.user.id]); shares = []; },
  };
  shareDialog(options);
  await settle();
  const [dialog] = openDialogs();
  assert.equal(dialog.getAttribute('aria-label'), 'modals.share.title', 'the app\'s key (not in the core\'s catalog)');
  assert.equal(dialog.all().some((n) => n.tagName === 'INPUT'), false, 'no email field');
  const form = byClass(dialog, 'kit-share__invite')[0];
  assert.equal(form.hidden, false);
  byClass(dialog, 'kit-people__chip')[0].dispatch('click');
  form.dispatch('submit', { preventDefault() {} });
  await settle();
  assert.deepEqual(seen, [['offer', 5, 'edit']]);
  assert.match(dialog.textContent, /@fer/, 'the app\'s line under a name');
  assert.equal(form.hidden, true, 'nobody left to add: no form');
  assert.match(dialog.textContent, /Nobody else here yet\./);
  closeAll();
});

test('one chip invited is said by the chip\'s name, whatever the answer calls them (audit ui-dialogos-15)', async () => {
  // As Notes' and Next's answered a chip until they showed accounts by name: with the email in its place.
  const options = {
    name: 'Plans', me: 1, email: false, people: [{ id: 3, name: 'Cris' }],
    load: async () => ({ role: 'owner', owner: { id: 1, name: 'Ana' }, shares: [] }),
    offer: async (target, permission) => ({
      share: { user: { id: target.id, name: 'cris.private@example.com', email: 'cris.private@example.com' }, permission, accepted: false },
      invited: true,
    }),
  };
  shareDialog(options);
  await settle();
  const [dialog] = openDialogs();
  byClass(dialog, 'kit-people__chip')[0].dispatch('click');
  byClass(dialog, 'kit-share__invite')[0].dispatch('submit', { preventDefault() {} });
  await settle();
  const note = document.body.all().filter((node) => (node.getAttribute?.('class') || '').split(/\s+/).includes('kit-toast')).at(-1);
  assert.equal(note?.textContent, t('kit.share.invited', { name: 'Cris' }));
  closeAll();
});

test('whoever it was shared with sees who has it and may leave it', async () => {
  const left = [];
  const outcome = shareDialog({
    name: 'Plans', me: 2,
    load: async () => ({ role: 'view', owner: { id: 1, name: 'Ana' }, shares: [{ user: { id: 2, name: 'Ben' }, permission: 'view', accepted: true }] }),
    leave: async () => { left.push(true); },
  });
  await settle();
  const [dialog] = openDialogs();
  assert.equal(dialog.getAttribute('aria-label'), t('kit.share.people'));
  assert.equal(byClass(dialog, 'kit-share__invite').length, 0, 'only its owner invites');
  assert.match(dialog.textContent, new RegExp(t('kit.share.view')));
  button(dialog, t('kit.share.leave')).dispatch('click', { currentTarget: button(dialog, t('kit.share.leave')) });
  await settle();
  const confirm = openDialogs().at(-1);
  button(confirm, t('kit.share.leave')).dispatch('click', { currentTarget: button(confirm, t('kit.share.leave')) });
  await settle();
  assert.deepEqual(left, [true]);
  assert.equal(await outcome, 'left');
});

test('roles of an app\'s own and a manager who doesn\'t own it: a list, rows kept as they are, a question before taking back', async () => {
  const calls = [];
  const outcome = shareDialog({
    name: 'Launch', me: 2, invitePermission: 'member',
    permissions: [
      { value: 'manager', label: 'Manages', offered: false },
      { value: 'member', label: 'Can edit' },
      { value: 'viewer', label: 'Read only' },
    ],
    load: async () => ({
      role: 'manager', manage: true, owner: { id: 1, name: 'Ana' },
      shares: [
        { user: { id: 2, name: 'Ben' }, permission: 'manager', accepted: true },
        { user: { id: 3, name: 'Cris' }, permission: 'manager', accepted: true },
        { user: { id: 4, name: 'Dani' }, permission: 'member', accepted: true },
        { user: { id: -7, name: 'eve@example.com', email: 'eve@example.com' }, permission: 'viewer', accepted: false },
      ],
    }),
    fixed: (share) => share.permission === 'manager',
    confirmRemove: (share) => (share.accepted ? `Take ${share.user.name} out?` : null),
    offer: async (target, permission) => { calls.push(['offer', target.email, permission]); return { share: null, invited: true }; },
    setPermission: async (share, permission) => { calls.push(['set', share.user.id, permission]); },
    remove: async (share) => { calls.push(['remove', share.user.id]); },
    leave: async () => {},
  });
  await settle();
  const [dialog] = openDialogs();
  assert.equal(dialog.getAttribute('aria-label'), t('kit.share.title', { name: 'Launch' }), 'a manager shares as its owner does');
  assert.deepEqual(byClass(dialog, 'kit-share__role').map((n) => n.textContent), ['Manages', 'Manages'],
    'one\'s own row and another manager\'s say what they may do, with nothing to change');
  const takeBacks = () => dialog.all().filter((n) => n.tagName === 'BUTTON' && /^Remove .*access$/.test(n.getAttribute('aria-label') || ''));
  assert.equal(takeBacks().length, 2, 'Dani and the address, not Ben nor Cris');

  const choice = byClass(dialog, 'kit-share__choice')[0];
  assert.ok(choice, 'three roles: a list beside Invite');
  assert.deepEqual(choice.find('option').map((o) => o.textContent), ['Can edit', 'Read only'], 'a role only its owner gives is never offered');
  assert.equal(byClass(dialog, 'kit-segmented').length, 0);
  choice.value = 'viewer';
  choice.dispatch('change');
  const email = dialog.all().find((n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'email');
  email.value = 'fay@example.com';
  email.dispatch('input');
  byClass(dialog, 'kit-share__invite')[0].dispatch('submit', { preventDefault() {} });
  await settle();
  assert.deepEqual(calls.find(([what]) => what === 'offer'), ['offer', 'fay@example.com', 'viewer']);

  // An invitation not answered goes at once; someone in it, after the question.
  const remove = (name) => dialog.all().find((n) => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === t('kit.share.remove', { name }));
  remove('eve@example.com').dispatch('click');
  await settle();
  assert.deepEqual(calls.at(-1), ['remove', -7]);
  remove('Dani').dispatch('click');
  await settle();
  const question = openDialogs().at(-1);
  assert.match(question.textContent, /Take Dani out\?/);
  button(question, t('kit.share.takeBack')).dispatch('click', { currentTarget: button(question, t('kit.share.takeBack')) });
  await settle();
  assert.deepEqual(calls.at(-1), ['remove', 4]);
  assert.ok(button(dialog, t('kit.share.leave')), 'a manager who doesn\'t own it may still leave it');
  closeAll();
  assert.equal(await outcome, null);
});

test('a load that fails says so and opens nothing', async () => {
  const before = openDialogs().length;
  const outcome = await shareDialog({ name: 'X', load: async () => { throw Object.assign(new Error('x'), { code: 'not_found' }); } });
  assert.equal(outcome, null);
  assert.equal(openDialogs().length, before);
});

test('offline, it opens with what the app knows: one line says why, and nothing that changes it is on', async () => {
  const calls = [];
  const was = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true });
  try {
    const outcome = shareDialog({
      name: 'Groceries', me: 1,
      load: async () => ({
        role: 'owner', owner: { id: 1, name: 'Ana' },
        shares: [{ user: { id: 2, name: 'Ben Ros', avatar_color: '#aa3355' }, permission: 'edit', accepted: true }],
      }),
      offer: async () => { calls.push('offer'); return { share: null, invited: true }; },
      setPermission: async () => { calls.push('set'); },
      remove: async () => { calls.push('remove'); },
    });
    await settle();
    const dialog = openDialogs().at(-1);
    const notice = byClass(dialog, 'kit-share__offline')[0];
    assert.ok(notice && !notice.hidden, 'the line that says it needs a connection');
    assert.equal(notice.textContent, t('kit.offline.actions'));
    assert.equal(button(dialog, t('kit.share.invite')).disabled, true, 'Invite is off');
    const takeBack = dialog.all().find((n) => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === t('kit.share.remove', { name: 'Ben Ros' }));
    assert.equal(takeBack.disabled, true, 'and taking it back');
    assert.equal(byClass(dialog, 'kit-share__permission').every((n) => n.disabled), true, 'and changing what one may do');
    // The person's own colour, on their initials.
    const ben = byClass(dialog, 'kit-avatar').find((n) => n.textContent === 'BR');
    assert.equal(ben.style.background, '#aa3355');
    byClass(dialog, 'kit-share__invite')[0].dispatch('submit', { preventDefault() {} });
    await settle();
    assert.deepEqual(calls, [], 'nothing was sent');
    closeAll();
    assert.equal(await outcome, null);
  } finally {
    if (was) Object.defineProperty(globalThis, 'navigator', was);
    else delete globalThis.navigator;
  }
});
