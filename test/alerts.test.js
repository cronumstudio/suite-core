/**
 * Emails to whoever runs the install when the server fails (alerts.js): off
 * unless ALERT_EMAIL is set with a mail server, a run of 5xx, one email per
 * kind every 30 minutes across restarts, and nothing of anyone in them; then
 * an app and a host, over real HTTP, with an SMTP server on localhost.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db.js';
import { resolveConfig } from '../config.js';
import { createMailer, mailConfigFromEnv } from '../mail.js';
import { createSuite, createApp } from '../app.js';
import { createHost } from '../host.js';
import { HttpError } from '../http.js';
import {
  createAlerts, alertsFromEnv, describeError, scrub, ALERT_EVERY_MS, ERROR_BURST, ALERT_KINDS,
} from '../alerts.js';

const MINUTE = 60 * 1000;
const PRODUCT = { app: { id: 'demo', name: 'Demo', languages: ['en'] } };
const TO = 'ops@example.com';

/** A mailer that keeps what it is given, as createMailer's does with an SMTP server. */
function fakeMailer() {
  const mailer = {
    provider: 'smtp', sent: [], fail: false, hang: false,
    async send(message) {
      if (mailer.hang) return new Promise(() => {});
      if (mailer.fail) throw new Error('the mail server said no');
      mailer.sent.push(message);
      return { response: 'queued' };
    },
  };
  return mailer;
}

/** A clock the test moves. */
function clock(start = Date.parse('2026-10-22T10:00:00Z')) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

function setup({ mailer = fakeMailer(), database = openDatabase({ path: ':memory:' }), time = clock(), ...options } = {}) {
  const lines = [];
  const alerts = createAlerts({
    to: TO, mailer, database, app: { id: 'demo', name: 'Demo' }, baseUrl: 'https://demo.example',
    log: (line) => lines.push(line), now: time.now, machine: 'box-1', ...options,
  });
  alerts.setVersion('1.2.3');
  return { alerts, mailer, database, time, lines };
}

/** A request as the server sees it, answered with `status`. */
function answer(alerts, { method = 'GET', url = '/api/items/7', status = 500, pattern = '/api/items/:id', error = null } = {}) {
  const req = { method, url };
  const res = Object.assign(new EventEmitter(), { statusCode: status });
  alerts.watch(req, res);
  if (pattern) alerts.noteRoute(req, pattern);
  if (error) alerts.noteError(req, error);
  res.emit('finish');
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------ off by default ----------------------------- */

test('alerts are off by default: without ALERT_EMAIL, with the log as the mailer, or with something that is not an address', async () => {
  const smtp = { MAIL_PROVIDER: 'smtp', MAIL_HOST: 'mail.example', MAIL_FROM: 'Demo <demo@example.com>' };
  const quiet = resolveConfig(PRODUCT, { ...smtp, ADMIN_EMAIL: 'admin@example.com' });
  assert.deepEqual(quiet.install.alerts, { to: null }, 'never ADMIN_EMAIL on its own: an install that moves up gets no mail it never asked for');
  assert.deepEqual(quiet.warnings, []);
  assert.deepEqual(resolveConfig(PRODUCT, {}).install.alerts, { to: null });

  const on = resolveConfig(PRODUCT, { ...smtp, ALERT_EMAIL: ' ops@example.com ' });
  assert.deepEqual(on.install.alerts, { to: TO });
  assert.deepEqual([...on.errors, ...on.warnings], []);

  // A mistake is a warning, never a reason not to start: alerts are an extra.
  const logged = resolveConfig(PRODUCT, { ALERT_EMAIL: TO });
  assert.deepEqual(logged.install.alerts, { to: null }, 'with the log as the mailer, the log already has the errors');
  assert.deepEqual(logged.errors, []);
  assert.deepEqual(logged.warnings, ['ALERT_EMAIL is set but MAIL_PROVIDER is log: no alerts are sent, the server’s log has the errors']);
  const typo = resolveConfig(PRODUCT, { ...smtp, ALERT_EMAIL: 'ops at example' });
  assert.deepEqual(typo.install.alerts, { to: null });
  assert.deepEqual(typo.errors, []);
  assert.deepEqual(typo.warnings, ['ALERT_EMAIL is not an email address: no alerts are sent']);
  assert.deepEqual(alertsFromEnv({}), { to: null, warning: null });

  // Off, every call does nothing and says nothing.
  const lines = [];
  const database = openDatabase({ path: ':memory:' });
  const logMailer = createMailer(mailConfigFromEnv({}), { log: (line) => lines.push(line) });
  for (const off of [
    createAlerts(),
    createAlerts({ to: null, mailer: fakeMailer(), database }),
    createAlerts({ to: TO, mailer: logMailer, database, log: (line) => lines.push(line) }),
  ]) {
    assert.equal(off.enabled, false);
    for (let i = 0; i < ERROR_BURST.count * 2; i++) answer(off);
    assert.equal(await off.report('rejection', new Error('x')), false);
    assert.equal(await off.crashed(new Error('x')), false);
    off.jobFailed('clean-up', new Error('x'));
    off.flush();
  }
  await settle();
  assert.deepEqual(lines, [], 'not even the log mailer’s line');
  assert.equal(database.getMeta('suite.alerts.rejection'), null, 'nothing written');
  database.close();
});

/* ------------------------------- server errors ----------------------------- */

test('server errors: five within five minutes make one email; fewer, spread out, or 4xx, none', async () => {
  const { alerts, mailer, time } = setup();
  for (let i = 0; i < 20; i++) answer(alerts, { status: 404 });
  for (let i = 0; i < ERROR_BURST.count - 1; i++) {
    answer(alerts);
    time.advance(1000);
  }
  await settle();
  assert.equal(mailer.sent.length, 0, 'four are not a run');

  // Five minutes later the first four no longer count.
  time.advance(ERROR_BURST.withinMs);
  answer(alerts);
  await settle();
  assert.equal(mailer.sent.length, 0);
  for (let i = 0; i < ERROR_BURST.count - 1; i++) answer(alerts, { status: 503, error: new HttpError(503, 'provider_unavailable') });
  await settle();
  assert.equal(mailer.sent.length, 1, 'the fifth within five minutes');
  const [mail] = mailer.sent;
  assert.equal(mail.to, TO);
  assert.equal(mail.subject, '[Demo] Alert: server errors (5xx)');
  assert.match(mail.text, /^The server answered 5 requests with an error \(5xx\) within 5 minutes\./);
  assert.match(mail.text, /^Kind: {5}errors$/m);
  assert.match(mail.text, / 503 {2}GET \/api\/items\/:id {2}HttpError 503: provider_unavailable$/m);
  assert.match(mail.text, / 500 {2}GET \/api\/items\/:id$/m, 'a 5xx with no error behind it is listed too');

  // The run starts again: five more, within the half hour, are held back and counted.
  for (let i = 0; i < ERROR_BURST.count * 2; i++) answer(alerts);
  await settle();
  assert.equal(mailer.sent.length, 1);
  time.advance(ALERT_EVERY_MS);
  for (let i = 0; i < ERROR_BURST.count; i++) answer(alerts, { error: new TypeError('boom') });
  await settle();
  assert.equal(mailer.sent.length, 2);
  assert.match(mailer.sent[1].text, /Since the last email of this kind, 10 more server errors \(5xx\) were not emailed/);
  assert.match(mailer.sent[1].text, /^Error: {4}TypeError: boom$/m);
  assert.match(mailer.sent[1].text, /^Stack \(trimmed\):\n {2}at /m);
});

/* --------------------------- once per kind, kept --------------------------- */

test('one email per kind every 30 minutes, across restarts, with what was held back in the next', async () => {
  const database = openDatabase({ path: ':memory:' });
  const time = clock();
  const first = setup({ database, time });
  assert.equal(await first.alerts.report('crash', new Error('one')), true);
  assert.equal(await first.alerts.report('crash', new Error('two')), false);
  assert.equal(await first.alerts.report('rejection', new Error('another kind')), true, 'each kind on its own');
  assert.equal(first.mailer.sent.length, 2);
  assert.deepEqual(JSON.parse(database.getMeta('suite.alerts.crash')), { last_at: '2026-10-22T10:00:00.000Z', held: 0 },
    'the time of the email is saved before it goes');
  first.alerts.flush();
  assert.equal(JSON.parse(database.getMeta('suite.alerts.crash')).held, 1, 'and what was held back, on close');

  // A restart: a new process, the same database.
  time.advance(MINUTE);
  const second = setup({ database, time });
  assert.equal(await second.alerts.report('crash', new Error('three')), false, 'a restart loop sends one');
  time.advance(ALERT_EVERY_MS - MINUTE - 1);
  assert.equal(await second.alerts.report('crash', new Error('four')), false);
  time.advance(1);
  assert.equal(await second.alerts.report('crash', new Error('five')), true, 'thirty minutes after the last one');
  assert.match(second.mailer.sent[0].text, /Since the last email of this kind, 3 more uncaught exceptions were not emailed \(one email per kind every 30 minutes at most\)/);
  assert.equal(JSON.parse(database.getMeta('suite.alerts.crash')).held, 0);

  // A clock set back doesn't hold alerts back until it catches up.
  time.advance(-24 * 60 * MINUTE);
  assert.equal(await second.alerts.report('crash', new Error('six')), true);

  // A kind that isn't one is said in the log, never thrown.
  assert.equal(await second.alerts.report('toString', new Error('x')), false);
  assert.match(second.lines.at(-1), /"toString" is not a kind of alert \(crash, rejection, errors, job\)/);
  assert.deepEqual(ALERT_KINDS, ['crash', 'rejection', 'errors', 'job']);
  database.close();
});

test('an email goes only once its mark is saved, and one that could not be sent is counted in the next', async () => {
  const database = openDatabase({ path: ':memory:' });
  const broken = { ...database, setMeta: () => { throw new Error('disk full'); } };
  const unsaved = setup({ database: broken });
  assert.equal(await unsaved.alerts.report('crash', new Error('x')), false);
  assert.equal(unsaved.mailer.sent.length, 0, 'without its mark, a restart loop would send one per restart');
  assert.match(unsaved.lines[0], /no "crash" alert: its time could not be saved/);
  const unread = setup({ database: { ...database, getMeta: () => { throw new Error('locked'); } } });
  assert.equal(await unread.alerts.report('crash', new Error('x')), false);
  assert.equal(unread.mailer.sent.length, 0);

  const { alerts, mailer, time, lines } = setup({ database });
  mailer.fail = true;
  assert.equal(await alerts.report('job', new Error('sweep'), { job: 'clean-up' }), false);
  assert.match(lines.at(-1), /the "job" alert could not be sent: the mail server said no/);
  mailer.fail = false;
  assert.equal(await alerts.report('job', new Error('sweep')), false, 'one try per half hour, even a failed one');
  time.advance(ALERT_EVERY_MS);
  alerts.jobFailed('clean-up', new Error('sweep again'));
  await settle();
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].subject, '[Demo] Alert: a scheduled job failed');
  assert.match(mailer.sent[0].text, /^The scheduled job "clean-up" failed: it runs again at its next turn\./);
  assert.match(mailer.sent[0].text, /2 more failed jobs were not emailed/, 'the one not delivered and the one held back');
  database.close();
});

test('a process that is stopping waits for its email, and never longer than it said', async () => {
  const { alerts, mailer } = setup();
  assert.equal(await alerts.crashed(new Error('the end')), true);
  assert.equal(mailer.sent[0].subject, '[Demo] Alert: uncaught exception, the process restarts');
  assert.match(mailer.sent[0].text, /^An exception reached the top of the process: it stops with code 1/);

  const hung = setup({ crashSendMs: 50 });
  hung.mailer.hang = true;
  const started = Date.now();
  assert.equal(await hung.alerts.crashed(new Error('the end')), false);
  assert.ok(Date.now() - started < 2000, 'a mail server that doesn’t answer doesn’t keep the process from exiting');
  assert.match(hung.lines.at(-1), /the "crash" alert did not go out within 50 ms/);
});

/* -------------------------------- what is said ------------------------------ */

test('what an email says: the app, its version, the kind, the time and the error, never anyone’s data', async () => {
  assert.equal(scrub('ana@example.com failed at https://api.example/v1/x?key=abc#frag and token Ab3dEf6hIj9kLm2nOp5qRs8t'),
    '<email> failed at https://api.example/v1/x?… and token <token>');
  assert.equal(scrub('C:\\app\\server\\store.js and file:///app/node_modules/x/index.js:12:5'),
    'C:\\app\\server\\store.js and file:///app/node_modules/x/index.js:12:5', 'paths stay');
  // A huge message is cut before it is read, and the word the cut falls in goes: half an email is still one.
  assert.equal(scrub(`${'word '.repeat(199)}ana@example.com and more`), `${'word '.repeat(199)}…`);
  assert.equal(scrub('a'.repeat(1e6)), '…');
  assert.deepEqual(describeError(new HttpError(503, 'workos_unavailable')), { name: 'HttpError 503', message: 'workos_unavailable', stack: null });
  assert.deepEqual(describeError('just a string'), { name: 'string', message: 'just a string', stack: null });
  assert.equal(describeError(null), null);
  const odd = { get message() { throw new Error('no'); } };
  assert.deepEqual(describeError(odd), { name: 'unknown', message: 'it could not be read', stack: null });
  const deep = new Error('deep');
  deep.stack = `Error: deep\n${Array.from({ length: 40 }, (_, i) => `    at frame${i} (/app/x.js:${i}:1)`).join('\n')}`;
  assert.deepEqual(describeError(deep).stack.slice(-2), ['at frame14 (/app/x.js:14:1)', '… 25 more']);

  // A path no route took: its first words only.
  const { alerts, mailer } = setup();
  answer(alerts, { url: '/lists/groceries/items?x=1', pattern: null });
  answer(alerts, { url: '/u/ana@example.com/x', pattern: null });
  answer(alerts, { url: '/tasks/api/items/77?token=secret', pattern: '/api/items/:id' });
  answer(alerts, { url: '/sw.js', pattern: null });
  answer(alerts, { method: 'POST', url: 'http://evil.example/api/items/7?q=1', pattern: '/api/items/:id' });
  await settle();
  const { text } = mailer.sent[0];
  assert.match(text, / GET \/lists\/groceries\/…$/m);
  assert.match(text, / GET \/u\/:param\/…$/m);
  assert.match(text, / GET \/tasks\/api\/items\/:id$/m, 'a host’s module, then the route');
  assert.match(text, / GET \/sw\.js$/m);
  assert.match(text, / POST \/api\/items\/:id$/m);
  assert.doesNotMatch(text, /ana@|secret|token=|77|\?x=|evil/);
  assert.match(text, /^App: {6}Demo v1\.2\.3$/m);
  assert.match(text, /^Address: {2}https:\/\/demo\.example$/m);
  assert.match(text, /^Machine: {2}box-1$/m);
  assert.match(text, /^Time: {5}2026-10-22T10:00:00\.000Z$/m);
});

/* ------------------------------- over real HTTP ----------------------------- */

/** An SMTP server on localhost that takes every message, as the install's mail server would. */
async function fakeSmtp(t) {
  const messages = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const say = (line) => socket.write(`${line}\r\n`);
    let buffer = '';
    let data = null;
    say('220 fake.example ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (data !== null) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          data = null;
          say('250 queued');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') say('250 fake.example');
        else if (verb === 'DATA') { data = ''; say('354 go on'); }
        else if (verb === 'QUIT') { say('221 bye'); socket.end(); return; }
        else say('250 ok');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  }));
  const env = {
    MAIL_PROVIDER: 'smtp', MAIL_HOST: '127.0.0.1', MAIL_PORT: String(server.address().port), MAIL_SECURE: 'none',
    MAIL_FROM: 'Demo <demo@example.com>',
  };
  /** Each message as { to, subject, text }. */
  const read = () => messages.map((raw) => {
    const [head, body] = raw.split('\r\n\r\n');
    const header = (name) => new RegExp(`^${name}: (.*)$`, 'm').exec(head)?.[1];
    return { to: header('To'), subject: header('Subject'), text: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') };
  });
  return { env, read };
}

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** An app with a route that has a bug, over HTTP. */
async function startApp(t, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-alerts-'));
  const lines = [];
  const suite = createSuite({
    config: PRODUCT, env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1', ...env },
    log: (line) => lines.push(line), exitOnError: false,
  });
  const app = createApp({
    suite, version: '1.2.3', handleSignals: false, log: (line) => lines.push(line),
    routes: (api) => {
      api.post('/api/notes/:id', () => {
        throw new Error('note failed for ana@example.com at https://api.example/v1?key=not-a-real-query-value');
      });
    },
  });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const fail = async () => {
    const res = await fetch(`${base}/api/notes/42?token=s3cr3t-in-the-query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'demo_sid=cookie-value-xyz', Authorization: 'Bearer mcp_bearer-abc' },
      body: JSON.stringify({ text: 'private words of a note' }),
    });
    assert.equal(res.status, 500);
    await res.text();
  };
  return { suite, lines, fail };
}

test('an app: its 5xx over HTTP make an email to ALERT_EMAIL, with the route and nothing of the request', async (t) => {
  const smtp = await fakeSmtp(t);
  const { suite, fail, lines } = await startApp(t, { ...smtp.env, ALERT_EMAIL: TO });
  assert.equal(suite.alerts.enabled, true);
  for (let i = 0; i < ERROR_BURST.count; i++) await fail();
  const [mail] = await until(() => (smtp.read().length ? smtp.read() : null));
  assert.equal(mail.to, TO);
  assert.equal(mail.subject, '[Demo] Alert: server errors (5xx)');
  assert.match(mail.text, /^App: {6}Demo v1\.2\.3$/m);
  assert.match(mail.text, /^Address: {2}http:\/\/127\.0\.0\.1$/m);
  assert.match(mail.text, /^Error: {4}Error: note failed for <email> at https:\/\/api\.example\/v1\?…$/m);
  assert.match(mail.text, / 500 {2}POST \/api\/notes\/:id {2}Error: note failed/);
  for (const secret of ['s3cr3t', 'token=', '/notes/42', 'private words', 'cookie-value', 'mcp_bearer', 'ana@example.com', 'not-a-real-query-value']) {
    assert.ok(!mail.text.includes(secret), `the email doesn’t carry "${secret}"`);
  }
  assert.ok(lines.includes('[alerts] "errors" alert sent'));

  // Half an hour later at the earliest: more errors are held back.
  for (let i = 0; i < ERROR_BURST.count; i++) await fail();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(smtp.read().length, 1);
});

test('an app without ALERT_EMAIL, or with the log as the mailer, sends nothing, whatever fails', async (t) => {
  const smtp = await fakeSmtp(t);
  const quiet = await startApp(t, smtp.env);
  const logged = await startApp(t, { ALERT_EMAIL: TO });
  assert.equal(quiet.suite.alerts.enabled, false);
  assert.equal(logged.suite.alerts.enabled, false);
  for (let i = 0; i < ERROR_BURST.count * 2; i++) {
    await quiet.fail();
    await logged.fail();
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(smtp.read(), []);
  assert.ok(!logged.lines.some((line) => line.startsWith('[mail]') || line.startsWith('[alerts]')), 'not even to the log');
  assert.ok(logged.lines.includes('[demo] ALERT_EMAIL is set but MAIL_PROVIDER is log: no alerts are sent, the server’s log has the errors'));
});

test('a host: a module’s 5xx are named by its path and its route, and the email is the host’s', async (t) => {
  const smtp = await fakeSmtp(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-alerts-host-'));
  const entry = (name) => new URL(`./fixtures/host/${name}/module.js?case=alerts`, import.meta.url);
  const host = await createHost({
    config: { app: { id: 'work', name: 'Work', languages: ['en', 'es'] }, modules: { live: true } },
    modules: [{ mount: 'alpha', entry: entry('alpha') }, { mount: 'beta', entry: entry('beta') }],
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1', ...smtp.env, ALERT_EMAIL: TO },
    version: '9.9.9', handleSignals: false, exitOnError: false, log: () => {},
  });
  const server = await host.listen();
  t.after(async () => { await host.close(); host.suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (let i = 0; i < ERROR_BURST.count; i++) {
    const res = await fetch(`${base}/beta/api/items/${100 + i}/broken?who=ana@example.com`);
    assert.equal(res.status, 500);
    await res.text();
  }
  const [mail] = await until(() => (smtp.read().length ? smtp.read() : null));
  assert.equal(mail.subject, '[Work] Alert: server errors (5xx)');
  assert.match(mail.text, /^App: {6}Work v9\.9\.9$/m, 'the host’s name and version, not a module’s');
  assert.match(mail.text, / 500 {2}GET \/beta\/api\/items\/:id\/broken {2}TypeError: beta broke$/m);
  assert.doesNotMatch(mail.text, /ana@|who=|\/10[0-4]\//);
});
