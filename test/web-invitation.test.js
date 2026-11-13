/**
 * An invitation's card (web/invitation.js) and the kit's avatar, without a browser: who offers
 * what, what accepting it gives, the two answers and their buttons off while one is on its way.
 * The texts are the core's English catalog.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

installFakeDom();
globalThis.location = { href: 'https://app.example.com/', origin: 'https://app.example.com', pathname: '/', reload: () => {} };

const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });

const { loadLanguage, t } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
const { invitationCard, invitationCards } = await import('../web/invitation.js');
const { avatar } = await import('../web/ui.js');

const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((done) => setTimeout(done, 0)); };
const byClass = (root, name) => root.all().filter((node) => (node.getAttribute?.('class') || '').split(/\s+/).includes(name));
const button = (root, text) => root.all().find((node) => node.tagName === 'BUTTON' && node.textContent === text);

test('the card says who offers what and what accepting it gives, in the kit’s words', () => {
  const card = invitationCard({
    from: { name: 'Carla Gil', avatar_color: '#336699' }, name: 'Groceries', icon: '🛒', permission: 'view',
    onAccept() {}, onDecline() {},
  });
  assert.equal(card.getAttribute('class'), 'kit-invite');
  assert.equal(card.getAttribute('aria-label'), t('kit.invite.label', { name: 'Groceries' }));
  assert.ok(card.textContent.includes(t('kit.invite.from', { name: 'Carla Gil' })));
  assert.match(card.textContent, /🛒/);
  assert.match(card.textContent, /Groceries/);
  assert.equal(byClass(card, 'kit-invite__about')[0].textContent, t('kit.invite.readOnly'));
  assert.equal(byClass(card, 'kit-avatar')[0].style.background, '#336699', 'their own colour');
  assert.ok(button(card, t('kit.invite.decline')) && button(card, t('kit.invite.accept')));

  const edit = invitationCard({ name: 'Plans', color: '#118844', what: 'Notebook', permission: 'edit', onAccept() {}, onDecline() {} });
  assert.ok(edit.textContent.includes(t('kit.invite.fromSomeone')));
  assert.equal(byClass(edit, 'kit-invite__about')[0].textContent, `Notebook · ${t('kit.invite.canEdit')}`);
  assert.equal(byClass(edit, 'kit-invite__swatch').length, 1, 'no emoji: its colour');

  const role = invitationCard({ from: 'Ana', name: 'Launch', detail: 'Role: Can edit', permission: 'edit', onAccept() {}, onDecline() {} });
  assert.equal(byClass(role, 'kit-invite__about')[0].textContent, 'Role: Can edit', 'the app’s own line wins');
});

test('each answer is the module’s, with both buttons off while it is on its way; a refusal leaves them on again', async () => {
  const calls = [];
  let release;
  const card = invitationCard({
    from: 'Ana', name: 'Groceries',
    onAccept: (ev) => { calls.push(['accept', Boolean(ev)]); return new Promise((done) => { release = done; }); },
    onDecline: async () => { calls.push(['decline']); throw Object.assign(new Error('gone'), { code: 'no_pending_invitation' }); },
  });
  const accept = button(card, t('kit.invite.accept'));
  const decline = button(card, t('kit.invite.decline'));
  accept.dispatch('click', { stopPropagation() {} });
  await settle();
  assert.equal(accept.disabled, true);
  assert.equal(decline.disabled, true);
  release();
  await settle();
  assert.equal(accept.disabled, false);
  decline.dispatch('click', { stopPropagation() {} });
  await settle();
  assert.deepEqual(calls, [['accept', true], ['decline']]);
  assert.equal(decline.disabled, false, 'it can be answered again');
});

test('several go in one section; none, nothing', () => {
  assert.equal(invitationCards([]), null);
  const block = invitationCards([{ name: 'A', onAccept() {}, onDecline() {} }, { name: 'B', onAccept() {}, onDecline() {} }]);
  assert.equal(block.getAttribute('aria-label'), t('kit.invite.title'));
  assert.equal(byClass(block, 'kit-invite').length, 2);
});

test('the avatar takes a person or a name, their colour and a size', () => {
  assert.equal(avatar('Ana López').textContent, 'AL');
  assert.equal(avatar({ display_name: 'Ben Ros', avatar_color: '#123456' }).style.background, '#123456');
  assert.equal(avatar({ name: 'Ben' }, { color: 'red' }).style.background || '', '', 'only a #rrggbb colour');
  assert.equal(avatar({ name: 'Cris' }, { size: 'tiny' }).getAttribute('class'), 'kit-avatar kit-avatar--tiny');
  assert.equal(avatar('').textContent, '·');
});
