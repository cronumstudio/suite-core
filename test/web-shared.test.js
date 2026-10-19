/**
 * Settings › Sharing in the browser (web/shared.js), without a browser: what the person shares,
 * each person with what they may do, and what is shared with them, invitations first. Every
 * change goes through the app's own function and the page asks again; a refusal is said and the
 * page shows the server's state. The texts are the core's English catalog.
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
const { sharedSection, sharedPage } = await import('../web/shared.js');
const { openSettings } = await import('../web/settings.js');

const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((done) => setTimeout(done, 0)); };
const buttons = (root, text) => root.all().filter((node) => node.tagName === 'BUTTON' && node.textContent === text);
const openDialog = () => document.body.all().find((node) => node.tagName === 'DIALOG' && node.open);

const KINDS = { notebook: { label: 'Notebook', iconName: 'book' }, note: { label: 'Note', iconName: 'notes' } };

function fixture() {
  const state = {
    mine: [{
      kind: 'notebook', id: 3, name: 'Recipes', path: 'Home',
      people: [
        { user: { id: 2, name: 'Ana', email: 'ana@example.com' }, permission: 'edit', accepted: true },
        { user: { id: 4, name: 'Ben', email: 'ben@example.com' }, permission: 'view', accepted: false },
      ],
    }],
    withMe: [
      { kind: 'note', id: 9, name: 'Trip', owner: { id: 5, name: 'Carla' }, permission: 'view', accepted: true },
      { kind: 'notebook', id: 7, name: 'Garden', owner: { id: 5, name: 'Carla' }, permission: 'edit', accepted: false },
    ],
  };
  const calls = [];
  const options = {
    kinds: KINDS,
    load: async () => { calls.push(['load']); return structuredClone(state); },
    setPermission: async (item, person, permission) => { calls.push(['permission', item.id, person.user.id, permission]); },
    remove: async (item, person) => { calls.push(['remove', item.id, person.user.id]); },
    leave: async (item) => { calls.push(['leave', item.kind, item.id]); },
    accept: async (item) => { calls.push(['accept', item.kind, item.id]); },
    open: (item, { close }) => { calls.push(['open', item.kind, item.id, typeof close]); },
  };
  return { state, calls, options };
}

test('the section is the kit’s: id, icon, its label and hint in the language', () => {
  const section = sharedSection(fixture().options);
  assert.equal(section.id, 'shared');
  assert.equal(section.iconName, 'users');
  assert.equal(section.label, t('kit.shared.title'));
  assert.equal(section.hint(), t('kit.shared.hint'));
});

test('what one shares, with each person, and what is shared with one, invitations first', async () => {
  const { options } = fixture();
  const page = sharedPage(options);
  await settle();
  const text = page.textContent;
  assert.match(text, new RegExp(t('kit.shared.mine')));
  assert.match(text, /Recipes/);
  assert.match(text, /Notebook · Home/, 'what kind of thing, and where it is');
  assert.match(text, /Ana/);
  assert.match(text, /ben@example\.com/, 'the email the owner typed');
  assert.equal(page.all().filter((n) => n.textContent === t('kit.shared.pending')).length, 1, 'only Ben has yet to accept');
  const withMe = page.all().filter((n) => n.tagName === 'ARTICLE').slice(1).map((n) => n.textContent);
  assert.match(withMe[0], /Garden/, 'the invitation to answer goes first');
  assert.match(withMe[0], new RegExp(t('kit.shared.canEdit')));
  assert.match(withMe[1], /Trip/);
  assert.match(withMe[1], new RegExp(t('kit.shared.from', { name: 'Carla' })));
  assert.doesNotMatch(text, /undefined|null/);
});

test('each change goes through the app and the page asks again', async () => {
  const { options, calls } = fixture();
  const page = sharedPage(options);
  await settle();
  calls.length = 0;

  // Ana from "edit" to "view": the segmented choice of her row.
  const anaRow = page.all().find((n) => n.getAttribute('class') === 'kit-shared__person' && /Ana/.test(n.textContent));
  buttons(anaRow, t('kit.shared.view'))[0].dispatch('click');
  await settle();
  assert.deepEqual(calls, [['permission', 3, 2, 'view'], ['load']]);

  // Taking it back from Ben asks first.
  calls.length = 0;
  const benRow = page.all().find((n) => n.getAttribute('class') === 'kit-shared__person' && /Ben/.test(n.textContent));
  benRow.all().find((n) => n.getAttribute('aria-label') === t('kit.shared.remove', { name: 'Ben' })).dispatch('click');
  await settle();
  buttons(openDialog(), t('kit.shared.stop'))[0].dispatch('click');
  await settle();
  assert.deepEqual(calls, [['remove', 3, 4], ['load']]);

  calls.length = 0;
  buttons(page, t('kit.shared.accept'))[0].dispatch('click');
  await settle();
  assert.deepEqual(calls, [['accept', 'notebook', 7], ['load']]);

  calls.length = 0;
  buttons(page, t('kit.shared.decline'))[0].dispatch('click');
  await settle();
  assert.deepEqual(calls, [['leave', 'notebook', 7], ['load']], 'declining needs no confirmation');

  // Leaving something accepted asks first; cancelled, nothing happens.
  calls.length = 0;
  buttons(page, t('kit.shared.leave'))[0].dispatch('click');
  await settle();
  buttons(openDialog(), t('kit.cancel'))[0].dispatch('click');
  await settle();
  assert.deepEqual(calls, []);

  buttons(page, 'Trip')[0].dispatch('click');
  assert.deepEqual(calls, [['open', 'note', 9, 'function']], 'a name opens it where the app has a way, with Settings’ close');
});

test('a refusal is said, and the page shows what the server has', async () => {
  const { options, calls } = fixture();
  options.setPermission = async () => { const err = new Error('forbidden'); err.status = 403; err.data = { error: 'owner_only' }; throw err; };
  const page = sharedPage(options);
  await settle();
  calls.length = 0;
  const anaRow = page.all().find((n) => n.getAttribute('class') === 'kit-shared__person' && /Ana/.test(n.textContent));
  buttons(anaRow, t('kit.shared.view'))[0].dispatch('click');
  await settle();
  assert.deepEqual(calls, [['load']], 'asked again after the refusal');
  const again = page.all().find((n) => n.getAttribute('class') === 'kit-shared__person' && /Ana/.test(n.textContent));
  const pressed = again.all().find((n) => n.getAttribute('aria-pressed') === 'true');
  assert.equal(pressed.textContent, t('kit.shared.edit'), 'still "edit", as the server says');
});

test('nothing shared: one quiet message; without `accept` or `open`, no buttons for them', async () => {
  const empty = sharedPage({ kinds: KINDS, load: async () => ({ mine: [], withMe: [] }), setPermission() {}, remove() {}, leave() {} });
  await settle();
  assert.match(empty.textContent, new RegExp(t('kit.shared.none')));

  const { options } = fixture();
  delete options.accept;
  delete options.open;
  const page = sharedPage(options);
  await settle();
  assert.equal(buttons(page, t('kit.shared.accept')).length, 0);
  assert.equal(buttons(page, 'Trip').length, 0, 'the name is only text');
  assert.equal(buttons(page, t('kit.shared.decline')).length, 1, 'declining is still there');
});

test('a load that fails says why and offers to try again', async () => {
  let fail = true;
  const page = sharedPage({
    kinds: KINDS, setPermission() {}, remove() {}, leave() {},
    load: async () => { if (fail) throw new Error('offline'); return { mine: [], withMe: [] }; },
  });
  await settle();
  const retry = buttons(page, t('kit.shared.retry'))[0];
  assert.ok(retry);
  fail = false;
  retry.dispatch('click');
  await settle();
  assert.match(page.textContent, new RegExp(t('kit.shared.none')));
});

test('in Settings it is one more of the app’s sections', async () => {
  const { options } = fixture();
  options.open = (item, { close }) => close();
  const root = document.createElement('div');
  const settings = openSettings({
    app: { id: 'notes', name: 'Notes' }, user: { username: 'ana', role: 'user' }, root, start: 'shared',
    config: { app: { id: 'notes', modules: { mcp: false } } }, sections: [sharedSection(options)],
  });
  await settle();
  assert.match(root.textContent, /Recipes/);
  assert.ok(root.all().some((n) => n.getAttribute('class')?.includes('kit-settings__item') && n.textContent.includes(t('kit.shared.title'))));
  root.all().find((n) => n.tagName === 'BUTTON' && n.textContent === 'Trip').dispatch('click');
  assert.equal(root.all().length, 0, 'opening something closes the Settings it is in, without the app keeping its handle');
  settings.close();
});
