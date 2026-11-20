/**
 * The notices of an offer as every module sends them (share-mail.js shareNotices): the email to an
 * account, the email to an address without one, and the push in the kit's words with the thing's
 * tag, each reading the suite's services when it goes.
 *
 *   npm test (node --test test/share-notices.test.js for this alone)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareNotices } from '../share-mail.js';

const people = {
  1: { id: 1, username: 'ana', display_name: 'Ana', email: 'ana@example.com' },
  2: { id: 2, username: 'ben', display_name: '', email: 'ben@example.com' },
  3: { id: 3, username: 'cris', display_name: 'Cris', email: null },
};
const get = (sql, id) => {
  assert.equal(sql, 'SELECT * FROM users WHERE id = ?');
  return people[id];
};
const t = (key, vars = {}) => `${key}${vars.name ? ` ${vars.name}` : ''}${vars.thing ? ` ${vars.thing}` : ''}`;

function fakeSuite() {
  const sent = [];
  const suite = {
    shareMail: Object.assign((n) => { sent.push(['email', n.to.id, n.actor, n.kind, n.name, n.icon, n.permission]); return Promise.resolve(true); }, {
      stranger: (n) => { sent.push(['stranger', n.email, n.inviter?.id, n.kind, n.name, 'icon' in n ? n.icon : 'none', n.permission]); return Promise.resolve(true); },
    }),
    push: {
      subscriptionsOf: (ids) => ids.map((id) => ({ user_id: id })),
      deliver: async (devices, payload) => { sent.push(['push', devices.map((d) => d.user_id), payload]); },
    },
  };
  return { suite, sent };
}

const board = { id: 7, name: 'Plans', icon: '🧭' };

test('the email to an account and to an address without one, as the suite words them', async () => {
  const { suite, sent } = fakeSuite();
  const notices = shareNotices({ suite, get });
  assert.deepEqual(Object.keys(notices), ['email', 'stranger'], 'without texts, no push: the module sends its own');
  notices.email({ kind: 'list', thing: board, name: 'Plans', actorId: 1, targetId: 2, permission: 'view' });
  notices.email({ kind: 'list', thing: board, name: 'Plans', actorId: 2, targetId: 1, permission: 'edit' });
  notices.email({ kind: 'list', thing: board, name: 'Plans', actorId: 1, targetId: 3, permission: 'edit' });
  notices.stranger({ kind: 'list', thing: { id: 8, name: 'Sin icono' }, name: 'Sin icono', actorId: 1, email: 'nadie@example.com', permission: 'edit' });
  assert.deepEqual(sent, [
    ['email', 2, 'Ana', 'list', 'Plans', '🧭', 'view'],
    ['email', 1, 'ben', 'list', 'Plans', '🧭', 'edit'],
    ['stranger', 'nadie@example.com', 1, 'list', 'Sin icono', null, 'edit'],
  ], 'whoever has no email gets none; whoever has no name, by their username');
  // The suite's services are read when a notice goes: none, nothing sent and nothing thrown.
  const bare = shareNotices({ suite: {}, get });
  assert.equal(bare.email({ kind: 'list', thing: board, name: 'Plans', actorId: 1, targetId: 2 }), undefined);
  assert.equal(bare.stranger({ kind: 'list', thing: board, name: 'Plans', actorId: 1, email: 'x@example.com' }), undefined);
});

test('a module’s own: the kind share-mail knows it by, the push’s tag and address, no emoji for a stranger', async () => {
  const { suite, sent } = fakeSuite();
  const notices = shareNotices({
    suite, get, texts: () => t, url: () => 'https://work.example.com/next/',
    kinds: { project: { mail: 'plan', tag: (project) => `share-next-${project.id}` }, note: { strangerIcon: false } },
  });
  notices.email({ kind: 'project', thing: board, name: 'Plans', actorId: 1, targetId: 2, permission: 'view' });
  await notices.push({ kind: 'project', thing: board, name: 'Plans', actorId: 1, targetId: 2 });
  await notices.push({ kind: 'note', thing: { id: 9, title: '' }, name: '', actorId: 2, targetId: 1 });
  notices.stranger({ kind: 'note', thing: { id: 9, icon: '📝' }, name: null, actorId: 1, email: 'nadie@example.com', permission: 'view' });
  assert.deepEqual(sent, [
    ['email', 2, 'Ana', 'plan', 'Plans', '🧭', 'view'],
    ['push', [2], { title: 'kit.share.push.title', body: 'kit.share.push.plan Ana Plans', tag: 'share-next-7', url: 'https://work.example.com/next/' }],
    ['push', [1], { title: 'kit.share.push.title', body: 'kit.share.push.note ben mail.share.untitled', url: 'https://work.example.com/next/' }],
    ['stranger', 'nadie@example.com', 1, 'note', '', 'none', 'view'],
  ]);
  // Without the engine's name for it, the thing's own.
  sent.length = 0;
  await notices.push({ kind: 'project', thing: board, actorId: 1, targetId: 2 });
  assert.equal(sent[0][2].body, 'kit.share.push.plan Ana Plans');
  assert.equal(await shareNotices({ suite: {}, get, texts: () => t }).push({ kind: 'note', thing: board, actorId: 1, targetId: 2 }), undefined);
});
