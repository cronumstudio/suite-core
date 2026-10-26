/**
 * tools/test-kit.mjs, the pieces every app's tests start servers and talk to them with.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  freePorts, freePort, waitForHealth, startServer, startApp, client, mcp, rpc, liveChannel, liveNotice,
  createHarness, NotStarted, fakeServer, fakeWorkos, fakePaddle, sleep,
} from '../tools/test-kit.mjs';

/** A server script of a few lines: /health, what it was started with, and an exit on request. */
function script(t, body = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-kit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'server.mjs');
  fs.writeFileSync(file, `import http from 'node:http';
import fs from 'node:fs';
${body}
fs.writeFileSync(process.env.DATA_DIR + '/started', 'yes');
http.createServer((req, res) => {
  if (req.url === '/health') return res.end('{"ok":true}');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ env: { BASE_URL: process.env.BASE_URL, SECURE_COOKIES: process.env.SECURE_COOKIES, HOT_RELOAD: process.env.HOT_RELOAD, EXTRA: process.env.EXTRA ?? null, HOME_DIR: process.env.KIT_GONE ?? null } }));
}).listen(Number(process.env.PORT), '127.0.0.1');
`);
  return file;
}

test('freePorts gives n different ports, none of them one fetch() refuses', async () => {
  const ports = await freePorts(4);
  assert.equal(new Set(ports).size, 4);
  for (const port of ports) assert.ok(port > 10080, `${port}`);
  assert.ok(await freePort() > 10080);
});

test('startApp starts a server on its own port and DATA_DIR, and stop() takes the folder it made', async (t) => {
  process.env.KIT_GONE = 'from the parent';
  t.after(() => { delete process.env.KIT_GONE; });
  const app = await startApp(script(t), { prefix: 'kit-own-', env: { EXTRA: 'on top', KIT_GONE: undefined } });
  t.after(app.stop);
  assert.equal(app.down, '', app.log);
  assert.equal(app.base, `http://127.0.0.1:${app.port}`);
  assert.match(path.basename(app.dataDir), /^kit-own-/);
  assert.equal(fs.readFileSync(path.join(app.dataDir, 'started'), 'utf8'), 'yes');
  const { env } = await (await fetch(`${app.base}/env`)).json();
  assert.deepEqual(env, { BASE_URL: app.base, SECURE_COOKIES: 'false', HOT_RELOAD: 'false', EXTRA: 'on top', HOME_DIR: null },
    'an install’s variables, `env` on top, undefined removes one');
  await app.stop();
  assert.equal(app.child.exitCode !== null || app.child.signalCode !== null, true);
  assert.equal(fs.existsSync(app.dataDir), false);
  await app.stop(); // twice is fine
});

test('a DATA_DIR passed in is the caller’s: it stays for the next start', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-theirs-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const first = await startApp(script(t), { dataDir });
  await first.stop();
  assert.ok(fs.existsSync(path.join(dataDir, 'started')));
});

test('a server that exits, or never answers, says why instead of waiting it out', async (t) => {
  const crashing = await startApp(script(t, 'process.exit(3);'));
  t.after(crashing.stop);
  assert.match(crashing.down, /exited \(code 3\) before answering/);

  const quiet = await startServer(script(t, 'await new Promise(() => setTimeout(() => {}, 60000));'));
  t.after(quiet.stop);
  const down = await quiet.ready({ timeoutMs: 400, everyMs: 50 });
  assert.match(down, /no answer from .*\/health within 0\.4 s \(last try: /);

  assert.match(await waitForHealth(`http://127.0.0.1:${await freePort()}`, null, { timeoutMs: 300 }), /within 0\.3 s/);
});

test('client keeps its session cookie, sends and reads JSON, and names a request that hangs', async (t) => {
  const fake = await fakeServer((req, res, { url, body, json }) => {
    if (url.pathname === '/login') {
      res.setHeader('Set-Cookie', ['app_sid=abc; Path=/; HttpOnly', 'other=1; Path=/']);
      return json(200, { got: JSON.parse(body) });
    }
    if (url.pathname === '/hang') return; // never answers
    if (url.pathname === '/text') return res.end('plain');
    return json(201, { cookie: req.headers.cookie ?? null, origin: req.headers.origin ?? null, extra: req.headers['x-extra'] ?? null });
  });
  t.after(fake.close);

  const answers = [];
  const browser = client(fake.url, { cookieName: 'app_sid', headers: { Origin: 'http://here' }, onAnswer: (a) => answers.push(`${a.method} ${a.url} ${a.status}`) });
  assert.equal(browser.base, fake.url);
  const login = await browser('POST', '/login', { user: 'ana' });
  assert.deepEqual(login.data, { got: { user: 'ana' } });
  assert.equal(browser.cookie, 'app_sid=abc', 'only the named cookie');
  const me = await browser('GET', '/me', undefined, { 'X-Extra': 'yes' });
  assert.equal(me.status, 201);
  assert.deepEqual(me.data, { cookie: 'app_sid=abc', origin: 'http://here', extra: 'yes' });
  assert.equal((await browser('GET', '/text')).data, 'plain', 'what isn’t JSON comes as text');
  assert.deepEqual(answers, ['POST /login 200', 'GET /me 201', 'GET /text 200']);

  const every = client(fake.url);
  await every('POST', '/login', {});
  assert.equal(every.cookie, 'app_sid=abc; other=1', 'every cookie when none is named');
  const signedIn = client(fake.url, { cookie: 'app_sid=given' });
  assert.equal((await signedIn('GET', '/me')).data.cookie, 'app_sid=given');

  const impatient = client(fake.url, { timeoutMs: 200 });
  await assert.rejects(impatient('GET', '/hang'), /GET http:\/\/127\.0\.0\.1:\d+\/hang: no answer within 0\.2 s/);
});

test('mcp and rpc speak JSON-RPC with a bearer token', async (t) => {
  const fake = await fakeServer((req, res, { url, body, json }) => {
    if (url.pathname === '/broken/mcp') { res.writeHead(502); return res.end('Bad gateway'); }
    const call = JSON.parse(body);
    if (call.method !== 'tools/call') return json(200, { jsonrpc: '2.0', id: call.id, result: { method: call.method, auth: req.headers.authorization ?? null } });
    if (call.params.name === 'fails') return json(200, { jsonrpc: '2.0', id: call.id, result: { isError: true, content: [{ type: 'text', text: 'No.' }] } });
    return json(200, { jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text: `Hi ${call.params.arguments.name}` }, { type: 'text', text: 'again' }] } });
  });
  t.after(fake.close);
  const ask = mcp(fake.url, 'tok');
  const hi = await ask('hello', { name: 'Ana' });
  assert.equal(hi.isError, false);
  assert.equal(hi.text, 'Hi Ana\nagain');
  assert.equal(hi.status, 200);
  assert.deepEqual(await ask('fails'), { isError: true, text: 'No.', json: { jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'No.' }] } }, status: 200 });
  const listed = await rpc(fake.url, 'tok', 'tools/list');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json, { jsonrpc: '2.0', id: 7, result: { method: 'tools/list', auth: 'Bearer tok' } });
  const broken = await mcp(`${fake.url}/broken`, 'tok')('hello');
  assert.equal(broken.json, null);
  assert.equal(broken.text, 'HTTP 502: Bad gateway', 'what isn’t JSON is said as it came');
  assert.equal((await rpc(fake.url, null, 'ping')).json.result.auth, null, 'no token, no header');
});

test('liveChannel and liveNotice read the notices that come after the greeting', async (t) => {
  const open = new Set();
  const fake = await fakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: hello\ndata: {}\n\n');
    open.add(res);
    res.on('close', () => open.delete(res));
  });
  t.after(async () => { for (const res of open) res.end(); await fake.close(); });
  const send = (frame) => { for (const res of open) res.write(frame); };

  const channel = await liveChannel(fake.url, 'app_sid=1');
  const mark = channel.mark();
  send('event: change\ndata: {"kind":"other"}\n\n');
  send('event: change\ndata: {"kind":"list","id":4}\n\n');
  assert.deepEqual(await channel.after(mark, (n) => n.kind === 'list'), { kind: 'list', id: 4 });
  assert.equal(await channel.after(channel.mark(), () => true, 150), null);
  channel.close();

  const frame = await liveNotice(`${fake.url}/api/events`, 'app_sid=1', /"id":9/, async () => {
    await sleep(20);
    send('event: change\ndata: {"id":9}\n\n');
  });
  assert.equal(frame, 'event: change\ndata: {"id":9}');
});

test('the harness collects the report, says each ✗ as it happens and repeats the failures last', async () => {
  let said = '';
  const out = new Writable({ write(chunk, _encoding, done) { said += chunk; done(); } });
  const h = createHarness({ live: true, out });
  h.section('1. One');
  assert.equal(h.check('fine', true), true);
  assert.equal(h.check('broken', false, 'why'), false);
  assert.throws(() => h.started('Its own server starts', 'it exited', 'the log'), NotStarted);
  h.fail(new NotStarted('ignored: its check already failed'));
  h.fail(new Error('boom', { cause: new Error('underneath') }));
  assert.equal(h.passed, 1);
  assert.equal(h.failed, 3);
  assert.match(said, /^1\. One\n  ✗ broken → why\n  ✗ Its own server starts → it exited\nthe log\n\n✗ Unexpected error: Error: boom/);
  assert.doesNotMatch(said, /✓/, 'only failures are said as they happen');

  const report = h.report({ log: 'server said this' });
  assert.match(report, /^\n1\. One\n  ✓ fine\n  ✗ broken → why/);
  assert.match(report, /cause: underneath/);
  assert.match(report, /--- server log ---\nserver said this/);
  assert.match(report, /Failed:\n✗ broken → why\n✗ Its own server starts → it exited/);
  assert.match(report, /\n1 passed, 3 failed\n$/);
  assert.throws(() => h.assertPassed(), (err) => err instanceof assert.AssertionError && /✗ broken → why/.test(err.message));

  const quiet = createHarness({ live: false, out });
  const before = said;
  quiet.check('nothing said', false);
  assert.equal(said, before);
  const clean = createHarness({ live: false });
  clean.check('fine', true);
  clean.assertPassed();
  assert.doesNotMatch(clean.report({ log: 'not shown when all pass' }), /server log/);
});

test('fakeWorkos: the code exchange checks PKCE and the client, and signIn does the round trip', async (t) => {
  const workos = await fakeWorkos({ accounts: { user_ana: { id: 'user_ana', email: 'ana@example.com', email_verified: true } } });
  t.after(workos.close);
  // A stand-in for an app's /auth/login and /auth/callback, as suite-core's are.
  const verifiers = new Map();
  const app = await fakeServer(async (req, res, { url }) => {
    if (url.pathname === '/auth/login') {
      const state = crypto.randomUUID();
      const verifier = crypto.randomBytes(32).toString('base64url');
      verifiers.set(state, verifier);
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      res.writeHead(302, { Location: `${workos.url}/user_management/authorize?state=${state}&code_challenge=${challenge}`, 'Set-Cookie': `demo_auth=${state}; Path=/` });
      return res.end();
    }
    if (url.pathname === '/auth/callback') {
      const state = url.searchParams.get('state');
      const verifier = req.headers.cookie === `demo_auth=${state}` ? verifiers.get(state) : 'wrong';
      const exchange = await fetch(`${workos.url}/user_management/authenticate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: 'client_test', client_secret: 'sk_test', code: url.searchParams.get('code'), code_verifier: verifier }),
      });
      if (!exchange.ok) { res.writeHead(400); return res.end(); }
      const { user } = await exchange.json();
      res.writeHead(302, { Location: '/', 'Set-Cookie': `demo_sid=${user.id}; Path=/` });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cookie: req.headers.cookie }));
  });
  t.after(app.close);

  const ana = await workos.signIn(app.url, 'user_ana', { app: 'demo' });
  assert.equal(ana.back.status, 302);
  assert.equal(ana.cookie, 'demo_sid=user_ana');
  assert.deepEqual((await ana.client('GET', '/api/me')).data, { cookie: 'demo_sid=user_ana' });

  const authorize = `${workos.url}/user_management/authorize?code_challenge=${crypto.createHash('sha256').update('v').digest('base64url')}`;
  const exchange = (body) => fetch(`${workos.url}/user_management/authenticate`, { method: 'POST', body: JSON.stringify(body) });
  const code = workos.grant('user_ana', authorize);
  assert.equal((await exchange({ client_id: 'client_test', client_secret: 'sk_test', code, code_verifier: 'not v' })).status, 400, 'PKCE');
  assert.equal((await exchange({ client_id: 'other', client_secret: 'sk_test', code, code_verifier: 'v' })).status, 400, 'the client');
  const good = await exchange({ client_id: 'client_test', client_secret: 'sk_test', code, code_verifier: 'v' });
  assert.equal(good.status, 200);
  const { access_token: token } = await good.json();
  const [head, payload] = token.split('.').slice(0, 2).map((p) => JSON.parse(Buffer.from(p, 'base64url')));
  assert.deepEqual(head, { alg: 'RS256', kid: 'k1', typ: 'JWT' });
  assert.equal(payload.sub, 'user_ana');
  assert.equal((await exchange({ client_id: 'client_test', client_secret: 'sk_test', code, code_verifier: 'v' })).status, 400, 'a code serves once');

  const jwks = await (await fetch(`${workos.url}/oauth2/jwks`)).json();
  const key = crypto.createPublicKey({ key: jwks.keys[0], format: 'jwk' });
  const [h, p, s] = token.split('.');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url')), 'signed with the JWKS key');
  assert.equal((await fetch(`${workos.url}/user_management/users/user_ana`)).status, 401);
  assert.equal((await fetch(`${workos.url}/user_management/users/user_ana`, { headers: { Authorization: 'Bearer sk_test' } })).status, 200);
  assert.equal((await fetch(`${workos.url}/user_management/users/nobody`, { headers: { Authorization: 'Bearer sk_test' } })).status, 404);
  assert.equal((await (await fetch(`${workos.url}/.well-known/oauth-authorization-server`)).json()).issuer, workos.url);
});

test('fakePaddle keeps what it is asked and answers with a checkout link', async (t) => {
  const paddle = await fakePaddle({ answer: (call) => (call === 'GET /prices' ? { status: 503, body: { error: 'down' } } : null) });
  t.after(paddle.close);
  const post = (route, body) => fetch(paddle.url + route, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
  const sale = await post('/transactions', { items: [{ price_id: 'pri_1', quantity: 1 }] });
  assert.equal(sale.data.id, 'txn_test_1');
  assert.equal(sale.data.checkout.url, `${paddle.url}/pay?_ptxn=txn_test_1`);
  assert.deepEqual(await post('/subscriptions/sub_9/cancel', { effective_from: 'next_billing_period' }), { data: { id: 'sub_9' } });
  assert.equal((await fetch(`${paddle.url}/prices`)).status, 503);
  assert.deepEqual(paddle.asked, [
    { call: 'POST /transactions', body: { items: [{ price_id: 'pri_1', quantity: 1 }] } },
    { call: 'POST /subscriptions/sub_9/cancel', body: { effective_from: 'next_billing_period' } },
    { call: 'GET /prices', body: null },
  ]);
});
