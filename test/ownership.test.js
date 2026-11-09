/**
 * Whose something is (ownership.js, web/ownership.js): the 403 not_yours with the owner's name,
 * the author who may delete what they made, "It will be Ana's", the notice of something shared
 * that its owner deleted (push and email, never to the owner), who inherits, the sentence an
 * assistant reads with how to ask for a copy, and the page's offer of one.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createOwnership, notYours, mayDelete, pickHeir, NOT_YOURS } from '../ownership.js';
import { createShareMail } from '../share-mail.js';
import { mailBrand } from '../mail-layout.js';
import { createTexts, SUITE_CATALOGS, translator } from '../i18n.js';
import { describeErrorWith } from '../mcp-kit.js';
import { installFakeDom, FakeElement } from './fake-dom.js';

function setup() {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, email TEXT, prefs TEXT)');
  for (const p of [[1, 'ana', 'Ana', 'ana@example.com', '{"lang":"es"}'], [2, 'ben', 'Ben', 'ben@example.com', '{"lang":"en"}'], [3, 'cris', null, 'cris@example.com', '{}']]) {
    database.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(...p);
  }
  return { get: (sql, ...params) => database.prepare(sql).get(...params) };
}

test('requireOwner: the owner passes; anyone else gets 403 not_yours with the owner\'s name', () => {
  const ownership = createOwnership({ db: setup() });
  assert.doesNotThrow(() => ownership.requireOwner(1, 1));
  assert.throws(() => ownership.requireOwner(2, 1), (err) => {
    assert.equal(err.status, 403);
    assert.equal(err.code, NOT_YOURS);
    assert.deepEqual(err.extra, { owner: 'Ana', owner_id: 1 });
    return true;
  });
  // Moving it out: a copy may be asked for instead.
  assert.throws(() => ownership.requireOwner(2, 1, { copy: true }), (err) => err.extra.copy === true && err.extra.hint === 'copy');
  // A name the account never gave itself: its username.
  assert.throws(() => ownership.requireOwner(1, 3), (err) => err.extra.owner === 'cris');
  assert.throws(() => ownership.requireOwner(null, 1), (err) => err.code === NOT_YOURS);
});

test('requireOwnerOrAuthor and mayDelete: whoever made it may delete it too, where that is kept', () => {
  const ownership = createOwnership({ db: setup() });
  assert.doesNotThrow(() => ownership.requireOwnerOrAuthor(2, { ownerId: 1, authorId: 2 }));
  assert.doesNotThrow(() => ownership.requireOwnerOrAuthor(1, { ownerId: 1, authorId: 2 }));
  assert.throws(() => ownership.requireOwnerOrAuthor(3, { ownerId: 1, authorId: 2 }), (err) => err.code === NOT_YOURS && err.extra.owner === 'Ana');
  assert.throws(() => ownership.requireOwnerOrAuthor(2, { ownerId: 1, authorId: null }), (err) => err.code === NOT_YOURS);
  assert.equal(mayDelete(2, { ownerId: '1', authorId: '2' }), true, 'ids as text are the same ids');
  assert.equal(mayDelete(undefined, { ownerId: 1 }), false);
  assert.equal(notYours(null).extra.owner, null);
});

test('givesTo: into someone else\'s container it will be theirs; into one\'s own, nothing changes', () => {
  const ownership = createOwnership({ db: setup() });
  assert.deepEqual(ownership.givesTo(2, 1), { id: 1, name: 'Ana' });
  assert.equal(ownership.givesTo(1, 1), null);
  assert.equal(ownership.givesTo(1, null), null);
});

test('pickHeir: whoever it was given by first, else an editor before a viewer, the longest in it', () => {
  const rows = [
    { userId: 5, permission: 'view', since: '2026-01-01' },
    { userId: 6, permission: 'edit', since: '2026-03-01' },
    { userId: 7, permission: 'edit', since: '2026-02-01' },
  ];
  assert.equal(pickHeir(rows).userId, 7);
  assert.equal(pickHeir(rows, { prefer: 5 }).userId, 5);
  assert.equal(pickHeir(rows, { prefer: 9 }).userId, 7, 'the giver no longer in it: the usual order');
  // The same person twice (directly and through a group): their highest permission, their earliest date.
  const twice = pickHeir([...rows, { userId: 5, permission: 'edit', since: '2026-01-01' }]);
  assert.deepEqual(twice, { userId: 5, permission: 'edit', since: '2026-01-01' });
  assert.equal(pickHeir([]), null);
  assert.equal(pickHeir(null), null);
});

test('tellGone: push and email to whoever used it, in their language, never to the owner', async () => {
  const db = setup();
  const delivered = [];
  const push = {
    subscriptionsOf: (ids) => (ids[0] === 2 ? [{ user_id: 2, endpoint: 'https://push.example/b' }] : []),
    deliver: async (subs, payload) => { delivered.push({ subs, payload }); return { sent: 1 }; },
  };
  const sent = [];
  const texts = createTexts();
  const brand = mailBrand({ name: 'Cronum Work', color: '#2438B8', mail: { icon: null } }, 'https://work.example.com/');
  const shareMail = createShareMail({
    mailer: { send: async (m) => { sent.push(m); } }, texts, brand,
    module: { name: 'Tasks', color: '#EF4B2A', icon: null }, baseUrl: 'https://work.example.com/tasks/',
  });
  const ownership = createOwnership({
    db, push, shareMail, texts: (user) => translator(JSON.parse(user.prefs || '{}').lang || 'en', SUITE_CATALOGS),
  });
  const told = await ownership.tellGone({ kind: 'list', name: 'Compra', icon: '🛒', actorId: 1, audience: [1, 2, 3, 3, 99] });
  assert.equal(told, 2, 'Ben and Cris; the owner and nobody are not told');
  assert.equal(delivered.length, 1, 'a push only where a device takes it');
  assert.equal(delivered[0].payload.title, '“🛒 Compra” is gone');
  assert.equal(delivered[0].payload.body, 'Ana deleted what they shared with you.');
  assert.deepEqual(sent.map((m) => m.to).sort(), ['ben@example.com', 'cris@example.com']);
  const ben = sent.find((m) => m.to === 'ben@example.com');
  assert.equal(ben.subject, 'Ana deleted the list “Compra”');
  assert.match(ben.text, /no longer there for anyone/);
  assert.match(ben.html, /href="https:\/\/work\.example\.com\/tasks\/"/);
  assert.doesNotMatch(ben.text, /accept|copy/i, 'nothing to answer, no copy');

  // A Spanish reader gets it in Spanish.
  const ana = shareMail.gone.compose({ to: { email: 'ana@example.com', prefs: '{"lang":"es"}' }, actor: 'Ben', kind: 'notebook', name: 'Ideas' });
  assert.equal(ana.subject, 'Ben ha borrado la libreta «Ideas»');
});

test('a word about something of one’s own: the module’s words, the suite’s clothes, a button to where it is', async () => {
  const sent = [];
  const logged = [];
  const mailer = { send: async (m) => { if (m.to === 'off@example.com') throw new Error('smtp'); sent.push(m); } };
  const shareMail = createShareMail({
    mailer, texts: () => ({ lang: 'es', t: (key) => key }), log: (line) => logged.push(line),
    brand: { name: 'Cronum Work', color: '#123456' }, module: { name: 'Projects', color: '#654321' }, baseUrl: 'https://work.example.com/projects',
  });
  const word = {
    subject: 'Se borrará Boda', eyebrow: 'Tu proyecto', heading: 'Se borrará el 3 de abril', lead: 'Gratis guarda esos proyectos 90 días.',
    name: 'Boda', icon: '💍', label: 'Proyecto', button: 'Abrir el proyecto', path: '?project=7', footer: 'Es sobre tu proyecto.',
  };
  assert.equal(await shareMail.notice({ ...word, to: { email: 'ana@example.com' } }), true);
  assert.equal(sent[0].subject, 'Se borrará Boda');
  assert.match(sent[0].text, /Gratis guarda esos proyectos 90 días/);
  assert.match(sent[0].html, /href="https:\/\/work\.example\.com\/projects\/\?project=7"/);
  assert.equal(await shareMail.notice({ ...word, to: {} }), false, 'nobody to send it to');
  assert.equal(await shareMail.notice({ ...word, to: { email: 'off@example.com' } }), false);
  assert.match(logged.join(), /not sent \(a notice\): smtp/);
});

test('tellGone never throws: a push or an email that fails is logged, the rest still goes', async () => {
  const logged = [];
  const ownership = createOwnership({
    db: setup(),
    push: { subscriptionsOf: () => { throw new Error('no db'); }, deliver: async () => {} },
    texts: () => (key) => key,
    shareMail: Object.assign(() => {}, { gone: async ({ to }) => { if (to.id === 2) throw new Error('smtp'); return true; } }),
    log: (line) => logged.push(line),
  });
  assert.equal(await ownership.tellGone({ kind: 'group', name: 'G', actorId: 1, audience: [2, 3] }), 1);
  assert.equal(logged.length, 3);
});

test('every language has the words of not_yours, the copy, the gift and the notice', () => {
  const keys = Object.keys(SUITE_CATALOGS.en).filter((k) => /^(errors\.not_yours|kit\.ownership\.|ownership\.|mail\.gone\.)/.test(k));
  assert.ok(keys.length >= 20);
  for (const lang of ['es', 'fr', 'de', 'it']) {
    for (const key of keys) assert.ok(SUITE_CATALOGS[lang][key], `${lang}: ${key}`);
  }
  const t = translator('es', SUITE_CATALOGS);
  assert.equal(t('errors.not_yours', { owner: 'Ana' }), 'Esto no es tuyo: pide a Ana que lo quite o lo borre.');
});

test('an assistant reads the refusal with the owner, and how to take a copy when it is a move', () => {
  const sentences = { not_yours: 'This isn’t yours: ask {owner} to remove it or delete it.', not_yours_copy: 'Call again with copy: true.' };
  const describe = describeErrorWith({
    errorSentence: (code, extra) => (sentences[code] ? sentences[code].replace('{owner}', extra.owner) : null),
  });
  assert.equal(describe(notYours({ id: 1, name: 'Ana' })), 'This isn’t yours: ask Ana to remove it or delete it.');
  assert.equal(describe(notYours({ id: 1, name: 'Ana' }, { copy: true })), 'This isn’t yours: ask Ana to remove it or delete it. Call again with copy: true.');
});

test('the page: a move refused offers a copy, and asks again with copy: true only on yes', async () => {
  const document = installFakeDom();
  globalThis.window = { innerWidth: 390, innerHeight: 800 };
  const { showModal, close } = FakeElement.prototype;
  FakeElement.prototype.showModal = function showOpen() { showModal.call(this); this.setAttribute('open', ''); };
  FakeElement.prototype.close = function closeOpen() { this.removeAttribute('open'); close.call(this); };
  const { moving, confirmGive, isNotYours, offersCopy } = await import('../web/ownership.js');
  const { ApiError } = await import('../web/api.js');
  const refusal = new ApiError(403, 'not_yours', { owner: 'Ana', copy: true });
  assert.equal(isNotYours(refusal), true);
  assert.equal(offersCopy(new ApiError(403, 'not_yours', { owner: 'Ana' })), false);

  const openDialog = () => document.body.all().filter((n) => n.tagName === 'DIALOG' && n.open).at(-1);
  const buttons = (node) => node.find('button').filter((b) => (b.getAttribute('class') || '').includes('kit-btn'));
  const press = (button) => Promise.all((button.listeners.click || []).map((fn) => fn({ currentTarget: button, target: button })));

  const calls = [];
  const send = async (extra) => { calls.push(extra); if (!extra.copy) throw refusal; return { copied: true }; };
  const yes = moving(send);
  await new Promise((r) => setTimeout(r, 0));
  await press(buttons(openDialog()).at(-1));
  assert.deepEqual(await yes, { copied: true });
  assert.deepEqual(calls, [{}, { copy: true }]);

  calls.length = 0;
  const no = moving(send);
  await new Promise((r) => setTimeout(r, 0));
  await press(buttons(openDialog())[0]);
  assert.equal(await no, null);
  assert.deepEqual(calls, [{}], 'no copy asked for');

  // Any other error is the caller's, as it was.
  await assert.rejects(moving(async () => { throw new ApiError(500, 'boom'); }), (err) => err.code === 'boom');

  const give = confirmGive({ owner: 'Ana', thing: 'Pan' });
  await press(buttons(openDialog()).at(-1));
  assert.equal(await give, true);
});
