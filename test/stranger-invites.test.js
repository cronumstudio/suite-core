/**
 * Invitations by email to an address without an account (stranger-invites.js, share-mail.js
 * `stranger`, sharing.js `notify.stranger`), on a database in memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { wrapDatabase } from '../db.js';
import { createStrangerInvites, strangerInvitesSchema, registerUnsubscribeApi, STRANGER_LIMITS } from '../stranger-invites.js';
import { createShareMail } from '../share-mail.js';
import { mailBrand } from '../mail-layout.js';
import { buildMessage, mailConfigFromEnv, mailConfigErrors } from '../mail.js';
import { createTexts } from '../i18n.js';
import { createRouter } from '../http.js';
import { createSharing } from '../sharing.js';

const BASE = 'https://work.example.com';
const brand = mailBrand({ name: 'Cronum Work', color: '#2438B8', mail: { about: { en: 'Projects, alone or as a team.', es: 'Proyectos, solo o en equipo.' } } }, BASE);
const confirmed = (id, lang = 'es') => ({
  id, username: `u${id}`, display_name: `Person ${id}`, email: `p${id}@example.com`, email_verified_at: '2026-10-01T00:00:00.000Z',
  prefs: JSON.stringify({ lang }),
});

function setup({ limits, enabled = true, now = Date.parse('2026-10-30T10:00:00.000Z') } = {}) {
  const database = wrapDatabase(new DatabaseSync(':memory:'));
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, email TEXT, email_verified_at TEXT, prefs TEXT)');
  for (const id of [1, 2, 3, 4, 5]) database.run('INSERT INTO users (id, username) VALUES (?, ?)', id, `u${id}`);
  strangerInvitesSchema(database);
  const clock = { now };
  const alerts = [];
  const strangers = createStrangerInvites({
    database, baseUrl: `${BASE}/`, enabled, limits, clock: () => clock.now, onInstallLimit: (n) => alerts.push(n),
  });
  return { database, strangers, clock, alerts };
}

test('once per address and person, within the limits of a person, an address and the install', () => {
  const { strangers, clock, alerts } = setup({ limits: { perInviterDay: 2, perAddressMonth: 2, perDay: 4 } });
  const ana = confirmed(1);
  const ben = confirmed(2);
  assert.equal(STRANGER_LIMITS.perInviterDay, 10);
  assert.equal(strangers.check('New@Example.com', ana), null);
  strangers.record('New@Example.com', ana.id, 'list');
  assert.equal(strangers.check('new@example.com', ana), 'already_sent', 'never twice from the same person, in any case');
  assert.equal(strangers.check('new@example.com', ben), null, 'someone else may');
  strangers.record('other@example.com', ana.id, 'list');
  assert.equal(strangers.check('third@example.com', ana), 'inviter_limit');
  strangers.record('new@example.com', ben.id, 'plan');
  assert.equal(strangers.check('new@example.com', confirmed(3)), 'address_limit');
  strangers.record('x@example.com', 3, 'note');
  assert.equal(strangers.check('y@example.com', confirmed(4)), 'install_limit');
  assert.deepEqual(alerts, [4], 'the install\'s limit tells whoever runs it');
  clock.now += 25 * 60 * 60 * 1000;
  assert.equal(strangers.check('third@example.com', ana), null, 'a day later, the day\'s limits start again');
  assert.equal(strangers.check('new@example.com', confirmed(5)), 'address_limit', 'but an address\'s month goes on');
});

test('only from a confirmed email, and only where an account can be made', () => {
  const { strangers } = setup();
  assert.equal(strangers.check('a@example.com', { ...confirmed(1), email_verified_at: null }), 'inviter_unconfirmed');
  assert.equal(strangers.check('a@example.com', { ...confirmed(1), email: null }), 'inviter_unconfirmed');
  assert.equal(setup({ enabled: false }).strangers.check('a@example.com', confirmed(1)), 'no_signup');
});

test('the link to stop them: by a token, never the address; for good, whoever invites', () => {
  const { strangers } = setup();
  const { token, url } = strangers.record('quiet@example.com', 1, 'list');
  assert.equal(url, `${BASE}/api/mail/unsubscribe?t=${token}`);
  assert.doesNotMatch(url, /quiet/);
  assert.equal(strangers.suppress('not-a-token'), null);
  assert.equal(strangers.suppress(token), 'quiet@example.com');
  assert.equal(strangers.check('Quiet@example.com', confirmed(2)), 'unsubscribed');
});

test('the email to a stranger: the inviter\'s language, a button to sign up, a link and headers to stop them', async () => {
  const { strangers } = setup();
  const sent = [];
  const logged = [];
  const mailer = { send: async (m) => { sent.push(m); } };
  const send = createShareMail({
    mailer, texts: createTexts(), brand, baseUrl: `${BASE}/tasks`, strangers,
    signupUrl: `${BASE}/auth/login?signup=1&return=%2Ftasks%2F`, log: (line) => logged.push(line),
    module: { name: 'Tasks', color: '#EF4B2A', icon: `${BASE}/tasks/icons/apple-touch-180.png` },
  });
  const lucia = { ...confirmed(1, 'es'), display_name: 'Lucía García' };
  assert.equal(await send.stranger({ email: 'ana@ejemplo.com', inviter: lucia, kind: 'list', name: 'Lanzamiento web', icon: '🚀' }), true);
  const [mail] = sent;
  assert.equal(mail.to, 'ana@ejemplo.com');
  assert.equal(mail.subject, 'Lucía García te ha invitado a la lista «Lanzamiento web»');
  assert.match(mail.unsubscribe, /^https:\/\/work\.example\.com\/mail\/unsubscribe\?t=/);
  assert.match(mail.text, /Aún no tienes cuenta en Cronum Work\. Créala con esta misma dirección, ana@ejemplo\.com/);
  assert.match(mail.text, /Crear cuenta y aceptar: https:\/\/work\.example\.com\/auth\/login\?signup=1&return=%2Ftasks%2F/);
  assert.match(mail.text, /Si no quieres recibir más invitaciones de Cronum Work, puedes bloquearlas: https:\/\/work\.example\.com\/mail\/unsubscribe/);
  assert.match(mail.html, /<a class="link" href="https:\/\/work\.example\.com\/mail\/unsubscribe\?t=[^"]+"[^>]*>puedes bloquearlas<\/a>\./);
  assert.match(mail.html, /Proyectos, solo o en equipo\./);
  assert.equal(await send.stranger({ email: 'ana@ejemplo.com', inviter: lucia, kind: 'plan', name: 'Otra' }), false, 'never twice');
  assert.equal(sent.length, 1);
  assert.deepEqual(logged, [], 'what is never sent twice isn\'t news');

  const nowhere = createShareMail({ mailer, texts: createTexts(), brand, baseUrl: BASE, strangers, signupUrl: null });
  assert.equal(await nowhere.stranger({ email: 'b@example.com', inviter: lucia, kind: 'list', name: 'X' }), false, 'nowhere to sign up: nothing');

  const failing = createShareMail({
    mailer: { send: async () => { throw new Error('refused'); } }, texts: createTexts(), brand, baseUrl: BASE, strangers,
    signupUrl: `${BASE}/`, log: (line) => logged.push(line),
  });
  assert.equal(await failing.stranger({ email: 'c@example.com', inviter: lucia, kind: 'note', name: 'X' }), false);
  assert.equal(logged.length, 1);
  assert.doesNotMatch(logged[0], /c@example\.com/, 'never the address of someone without an account in the log');
});

test('the message carries the one-click unsubscribe headers, and only for an http(s) address', () => {
  const message = buildMessage({ from: 'a@example.com', to: 'b@example.com', subject: 'Hi', text: 'Plain', unsubscribe: `${BASE}/api/mail/unsubscribe?t=abc` });
  assert.match(message, /\r\nList-Unsubscribe: <https:\/\/work\.example\.com\/mail\/unsubscribe\?t=abc>\r\n/);
  assert.match(message, /\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n/);
  assert.doesNotMatch(buildMessage({ from: 'a@example.com', to: 'b@example.com', subject: 'Hi', text: 'Plain' }), /List-Unsubscribe/);
  assert.throws(() => buildMessage({ from: 'a@example.com', to: 'b@example.com', subject: 'Hi', text: 'P', unsubscribe: 'mailto:x@example.com' }));
  assert.equal(mailConfigFromEnv({}).strangersPerDay, 100);
  assert.equal(mailConfigFromEnv({ MAIL_STRANGERS_PER_DAY: '2500' }).strangersPerDay, 2500);
  assert.deepEqual(mailConfigErrors(mailConfigFromEnv({ MAIL_STRANGERS_PER_DAY: 'lots' })).length, 1);
});

test('the page to stop them: GET asks, POST does it, in the language of whoever opens it', async () => {
  const { strangers } = setup();
  const router = createRouter();
  registerUnsubscribeApi(router, { strangers, texts: createTexts(), brand });
  const { token } = strangers.record('quiet@example.com', 1, 'list');
  const call = async (method, query) => {
    const found = router.match(method, '/api/mail/unsubscribe');
    let status = null;
    let body = '';
    const res = { writeHead: (s) => { status = s; }, end: (b) => { body = b ?? ''; } };
    const req = { method, headers: { 'accept-language': 'es-ES,es;q=0.9' } };
    await found.handler({ req, res, params: found.params, query: new URLSearchParams(query) });
    return { status, body };
  };
  const asked = await call('GET', `t=${token}`);
  assert.equal(asked.status, 200);
  assert.match(asked.body, /¿Bloquear las invitaciones\?/);
  assert.match(asked.body, /<form method="post" action="https:\/\/work\.example\.com\/mail\/unsubscribe\?t=/);
  assert.equal(strangers.check('quiet@example.com', confirmed(2)), null, 'opening the link changes nothing');
  const done = await call('POST', `t=${token}`);
  assert.equal(done.status, 200);
  assert.match(done.body, /Hecho, invitaciones bloqueadas/);
  assert.equal(strangers.check('quiet@example.com', confirmed(2)), 'unsubscribed');
  assert.equal((await call('GET', 't=nope')).status, 404);
});

test('sharing tells an address without an account through notify.stranger, and answers the same', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, email TEXT);
    CREATE TABLE boards (id INTEGER PRIMARY KEY, owner_id INTEGER, name TEXT);
    CREATE TABLE board_shares (board_id INTEGER, user_id INTEGER, permission TEXT NOT NULL DEFAULT 'edit',
      accepted INTEGER NOT NULL DEFAULT 0, invited_by INTEGER, created_at TEXT, UNIQUE (board_id, user_id));`);
  database.exec("INSERT INTO users VALUES (1, 'ana', 'Ana', 'ana@example.com'), (2, 'ben', 'Ben', 'ben@example.com'); INSERT INTO boards VALUES (10, 1, 'Plans')");
  const db = {
    get: (sql, ...p) => database.prepare(sql).get(...p),
    all: (sql, ...p) => database.prepare(sql).all(...p),
    run: (sql, ...p) => database.prepare(sql).run(...p),
  };
  const told = [];
  const sharing = createSharing({
    db,
    notify: { email: (n) => told.push(['email', n.targetId]), stranger: (n) => told.push(['stranger', n.email, n.name, n.actorId, n.permission]) },
    kinds: { board: { table: 'board_shares', key: 'board_id', own: (userId, id) => db.get('SELECT * FROM boards WHERE id = ? AND owner_id = ?', Number(id), userId) } },
  });
  const known = sharing.share('board', 1, 10, { email: 'ben@example.com' });
  const unknown = sharing.share('board', 1, 10, { email: 'New@Example.com', permission: 'view' });
  assert.deepEqual(told, [['email', 2], ['stranger', 'new@example.com', 'Plans', 1, 'view']]);
  assert.deepEqual(Object.keys(known).sort(), Object.keys(unknown).sort());
});
