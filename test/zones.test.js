/**
 * Whose today it is (time.js), as the suite runs an app's code: each MCP tool in the time zone of
 * the person it acts for, on its own (createApp) and in a host (hostMcp), and the app's own routes
 * too when it asks (`zonedRoutes`); the suite's routes, a module that doesn't ask and the host's
 * own tools stay in the server's zone, as they always were. Over real HTTP.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSuite, createApp } from '../app.js';
import { createHost } from '../host.js';
import { sendJson } from '../http.js';
import { answeredOnce } from '../idempotency.js';
import { currentZone, SERVER_TIME_ZONE } from '../time.js';

/** A zone far from the server's: whatever the machine's, their days differ. */
const FAR = SERVER_TIME_ZONE === 'Pacific/Kiritimati' ? 'Pacific/Pago_Pago' : 'Pacific/Kiritimati';
const PASSWORD = 'root-password';

/** Calls over HTTP with the session cookie it was given, and the MCP with a token of the admin's. */
function client(base, cookieName) {
  let cookie = '';
  let token = null;
  let id = 0;
  const call = async (method, pathname, body, headers = {}) => {
    const res = await fetch(base + pathname, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith(`${cookieName}=`));
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data };
  };
  /** Signs the admin in, with their zone set far away, and makes the assistant's token. */
  const signIn = async (database) => {
    database.run("UPDATE users SET prefs = ? WHERE username = 'admin'", JSON.stringify({ tz: FAR }));
    assert.equal((await call('POST', '/api/auth/login', { username: 'admin', password: PASSWORD })).status, 200);
    token = (await call('POST', '/api/me/tokens', { name: 'Claude' })).data.token;
  };
  /** A tool's text, called by an assistant. */
  const tool = async (name, args = {}) => {
    id += 1;
    const res = await call('POST', '/mcp', { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
      { Authorization: `Bearer ${token}` });
    return res.data.result.content[0].text;
  };
  return { call, signIn, tool, signOut: () => { cookie = ''; } };
}

test('a host: each module’s tools in the person’s zone, its routes too when it asks, and its own tools as before', async (t) => {
  assert.notEqual(FAR, SERVER_TIME_ZONE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-zones-'));
  const n = Date.now();
  const host = await createHost({
    config: { app: { id: 'work', name: 'Work', languages: ['en'] }, accounts: { minPasswordLength: 8 } },
    modules: [
      { mount: 'one', entry: new URL(`./fixtures/host/clock/module.js?id=one&zoned&n=${n}`, import.meta.url) },
      { mount: 'two', entry: new URL(`./fixtures/host/clock/module.js?id=two&n=${n}`, import.meta.url) },
    ],
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: PASSWORD, BASE_URL: 'http://127.0.0.1' },
    handleSignals: false, exitOnError: false, log: () => {},
  });
  const server = await host.listen();
  t.after(async () => {
    await host.close();
    host.suite.database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { call, signIn, tool, signOut } = client(`http://127.0.0.1:${server.address().port}`, 'work_sid');
  await signIn(host.suite.database);

  assert.equal(await tool('one_zone'), FAR, 'a module’s tool reads today where the person is, through awaits too');
  assert.equal(await tool('two_zone'), FAR, 'every module’s, whether its routes ask or not');
  assert.equal((await call('GET', '/one/api/zone')).data.zone, FAR, 'the routes of a module that asks (zonedRoutes)');
  assert.equal((await call('GET', '/two/api/zone')).data.zone, SERVER_TIME_ZONE, 'one that doesn’t answers as it always did');
  // The host's own tools read the day their own way: the links' read each module's card as the
  // host's routes do, in the server's zone.
  const linked = await tool('work_link_item', { from: { module: 'one', type: 'clock', id: '1' }, to: { module: 'two', type: 'clock', id: '1' } });
  assert.match(linked, new RegExp(`^Linked: .*${SERVER_TIME_ZONE.replace('/', '\\/')}`), linked);
  assert.doesNotMatch(linked, new RegExp(FAR.replace('/', '\\/')));
  signOut();
  assert.equal((await call('GET', '/one/api/zone')).data.zone, SERVER_TIME_ZONE, 'nobody signed in: nobody’s zone, the server’s');
});

test('an app on its own: its tools in the person’s zone; its routes too with zonedRoutes, and what a route says of itself stays', async (t) => {
  let posted = 0;
  const start = async ({ zonedRoutes }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-zones-'));
    const suite = createSuite({
      config: { app: { id: 'demo', name: 'Demo', languages: ['en'] }, accounts: { minPasswordLength: 8 } },
      env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: PASSWORD, BASE_URL: 'http://127.0.0.1' }, log: () => {}, exitOnError: false,
    });
    const app = createApp({
      suite, version: '1.0.0', handleSignals: false, log: () => {}, zonedRoutes,
      routes: (api) => {
        api.get('/api/zone', (ctx) => sendJson(ctx.res, 200, { zone: currentZone() }));
        // Its answer is a secret shown once: never kept for an Idempotency-Key, so the same key runs it again.
        api.post('/api/secret', answeredOnce((ctx) => { posted += 1; sendJson(ctx.res, 200, { n: posted, zone: currentZone() }); }));
      },
      mcp: {
        instructions: 'Demo says where it is.',
        tools: [{
          name: 'zone', title: 'Which zone', description: 'The time zone the tool runs in.', inputSchema: { type: 'object', properties: {} },
          handler: async () => { await null; return { content: [{ type: 'text', text: currentZone() }] }; },
        }],
      },
    });
    const server = await app.listen();
    t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const given = client(`http://127.0.0.1:${server.address().port}`, 'demo_sid');
    await given.signIn(suite.database);
    return given;
  };

  const zoned = await start({ zonedRoutes: true });
  assert.equal(await zoned.tool('zone'), FAR, 'its tool in the zone of the person it acts for');
  assert.equal((await zoned.call('GET', '/api/zone')).data.zone, FAR, 'its routes in the zone of whoever asks');
  const key = { 'Idempotency-Key': 'zone-key-0001' };
  const first = await zoned.call('POST', '/api/secret', {}, key);
  const again = await zoned.call('POST', '/api/secret', {}, key);
  assert.deepEqual([first.data, again.data], [{ n: 1, zone: FAR }, { n: 2, zone: FAR }], 'answeredOnce kept: run again, never replayed');

  const plain = await start({ zonedRoutes: false });
  assert.equal(await plain.tool('zone'), FAR, 'its tools whether its routes ask or not');
  assert.equal((await plain.call('GET', '/api/zone')).data.zone, SERVER_TIME_ZONE, 'without zonedRoutes, the server’s zone, as before');
});
