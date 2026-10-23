/**
 * Everything that lets someone in, ended at once (revoke.js): every path that
 * sets a password or signs someone out everywhere leaves the same thing behind.
 * One table of routes, one set of expectations, so that none of them goes back
 * to closing only a part (sc-auth-1, sc-devices-1, sc-oauth-mcp-2).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createSuite, createApp } from '../app.js';
import { createRouter } from '../http.js';
import { createRevoker } from '../revoke.js';
import { OAUTH_PREFIXES } from '../oauth.js';
import { randomToken, sha256 } from '../crypto.js';
import { workosUsers, workosConnections } from '../workos-accounts.js';
import { registerWorkosSecurityApi } from '../workos-security.js';

const BACK = 'com.example.demo:/auth';
const CLIENT = 'client_claude';

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-revoke-'));
  const lines = [];
  const suite = createSuite({
    config: {
      app: { id: 'demo', name: 'Demo', languages: ['en'] }, accounts: { minPasswordLength: 8 },
      modules: { devices: true, push: true, live: true },
      devices: { prefix: 'demodev_', redirectUris: [BACK], webSessions: true },
    },
    env: {
      DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', SECURE_COOKIES: 'false',
      ADMIN_PASSWORD: 'root-password', ADMIN_EMAIL: 'root@example.com',
    },
    log: (line) => lines.push(line), exitOnError: false,
  });
  const app = createApp({ suite, handleSignals: false, log: (line) => lines.push(line), mcp: { instructions: 'Demo.', tools: [] } });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** A browser with a session cookie, given or set by the answers. */
  const browser = (token = null) => {
    const jar = { cookie: token ? `demo_sid=${token}` : '' };
    const call = async (method, pathname, body, headers = {}) => {
      const res = await fetch(base + pathname, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(jar.cookie ? { Cookie: jar.cookie } : {}), Origin: base, ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('demo_sid='));
      if (set) jar.cookie = set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    call.token = () => decodeURIComponent(jar.cookie.slice('demo_sid='.length));
    return call;
  };
  const resetTokenAfter = (mark) => lines.slice(mark).map((l) => /\?reset=([\w-]+)/.exec(l)?.[1]).find(Boolean);
  return { suite, base, browser, lines, resetTokenAfter };
}

/** WorkOS as the password routes and revoke.js see it. */
function fakeWorkos() {
  const people = new Map();
  return {
    people,
    add: (id, { email, password }) => people.set(id, { email, password }),
    account: async (id) => (people.get(id) ? { id, email: people.get(id).email } : null),
    checkPassword: async ({ email, password }) => [...people.values()].some((p) => p.email === email && p.password === password),
    setPassword: async (id, password) => { people.get(id).password = password; return { ok: true }; },
    identities: async () => [],
    factors: async () => [],
  };
}

/**
 * Ada with everything that lets someone in: two browser sessions (A, B, with a
 * session at the provider behind them), an API token, a grant of the suite's
 * OAuth server, a phone with its native push token, a browser that gets
 * notices and an AI client of AuthKit.
 */
function arm(suite, workosId) {
  const ada = suite.accounts.create({ username: 'ada', password: 'ada-password', email: 'ada@example.com' });
  if (workosId) suite.accounts.linkIdentity(ada.id, 'workos', workosId);
  const db = suite.database;
  const a = suite.sessions.open(ada.id, { idpSessionId: 'session_a' });
  const b = suite.sessions.open(ada.id, { idpSessionId: 'session_b' });
  const apiToken = suite.tokens.create(ada.id, { name: 'Script' }).token;
  const grant = db.run("INSERT INTO oauth_grants (user_id, client_id, client_name) VALUES (?, 'c1', 'Intruder')", ada.id).lastInsertRowid;
  const access = `${OAUTH_PREFIXES.access}${randomToken(24)}`;
  db.run("INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES (?, ?, 'access', datetime('now', '+1 hour'))",
    crypto.createHash('sha256').update(access).digest('base64url'), grant);
  const verifier = randomToken(32);
  const issued = suite.devices.issueCode(ada, { codeChallenge: sha256(verifier), redirectUri: BACK, name: 'Intruder’s phone' });
  const phone = suite.devices.exchange({ code: issued.code, verifier, redirectUri: BACK });
  const nativePush = db.columnsOf('device_push_tokens').length > 0;
  if (nativePush) {
    db.run("INSERT INTO device_push_tokens (device_id, platform, token) VALUES (?, 'ios', 'apns-token')", phone.device.id);
  }
  db.run("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, 'https://push.example/x', 'k', 'a')", ada.id);
  if (workosId) {
    db.run("INSERT INTO idp_connections (provider, subject, client_id, last_used_at) VALUES ('workos', ?, ?, ?)",
      workosId, CLIENT, new Date().toISOString());
  }
  // Everything works before.
  assert.ok(suite.sessions.alive(b));
  assert.ok(suite.tokens.authenticate(apiToken, { scope: 'mcp' }));
  assert.ok(suite.oauth.userFromAccessToken(access));
  assert.ok(suite.devices.authenticate(phone.token));
  return { ada, a, b, apiToken, access, phone: phone.token, nativePush };
}

/** The WorkOS routes on their own router, with revoke.js as createApp gives it but WorkOS's parts faked. */
function workosRoutes(suite) {
  const workos = fakeWorkos();
  const provider = { revokedSessions: [], revokedClientsOf: [] };
  const users = workosUsers(suite.accounts, { database: suite.database });
  const connections = workosConnections(suite.database);
  const revoker = createRevoker({
    database: suite.database, sessions: suite.sessions, tokens: suite.tokens, oauth: suite.oauth,
    devices: suite.devices, push: suite.push, connections, workosPeople: users, audit: suite.audit,
    idp: {
      name: 'WorkOS',
      revokeSession: async (sid) => { provider.revokedSessions.push(sid); },
      revokeAllConnections: async (userId) => { provider.revokedClientsOf.push(userId); return 1; },
    },
    log: () => {},
  });
  const router = createRouter();
  registerWorkosSecurityApi(router, {
    workos, users, accounts: suite.accounts, sessions: suite.sessions, appName: 'Demo', revokeEverything: revoker.revokeEverything,
  });
  async function call(method, pathname, { as, token, body }) {
    const found = router.match(method, pathname);
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' },
    });
    const answer = { status: 0 };
    const res = { writeHead: (status) => { answer.status = status; }, end: () => {} };
    try {
      await found.handler({ req, res, params: found.params, user: suite.accounts.byId(as), sessionToken: token });
    } catch (err) {
      return { status: err.status || 500, error: err.code || err.message };
    }
    return answer;
  }
  return { workos, provider, connections, call };
}

/**
 * Each path, what it does, and which of Ada's sessions it keeps (a token, or a
 * browser whose cookie it ends with). `workos`: the route is WorkOS's.
 */
const PATHS = [
  {
    name: 'a new password from Settings (POST /api/me/password)',
    run: async ({ browser, armed }) => {
      const tab = browser(armed.a);
      const out = await tab('POST', '/api/me/password', { current_password: 'ada-password', password: 'a-brand-new-one' });
      assert.equal(out.status, 200);
      return { kept: tab.token() };
    },
  },
  {
    name: 'a reset by mail (POST /api/auth/reset)',
    run: async ({ browser, lines, resetTokenAfter }) => {
      const anyone = browser();
      const mark = lines.length;
      assert.equal((await anyone('POST', '/api/auth/forgot', { login: 'ada' })).status, 200);
      const token = resetTokenAfter(mark);
      assert.ok(token, 'the link reached the log');
      assert.equal((await anyone('POST', '/api/auth/reset', { token, password: 'a-brand-new-one' })).status, 200);
      return { kept: anyone.token() };
    },
  },
  {
    name: 'the admin setting the password (PATCH /api/admin/users/:id)',
    run: async ({ admin, armed }) => {
      assert.equal((await admin('PATCH', `/api/admin/users/${armed.ada.id}`, { password: 'a-brand-new-one' })).status, 200);
      return { kept: null };
    },
  },
  {
    name: 'the admin signing out everywhere (DELETE /api/admin/users/:id/sessions)',
    run: async ({ admin, armed, suite }) => {
      const out = await admin('DELETE', `/api/admin/users/${armed.ada.id}/sessions`);
      assert.equal(out.status, 200);
      assert.deepEqual(out.data, { ok: true, closed: 2, tokens: 1, devices: 1 }, 'the answer says what it always said');
      assert.equal(suite.audit.list({ action: 'admin.user.signout' }).length, 1);
      return { kept: null };
    },
  },
  {
    name: 'a new password at WorkOS from Settings (POST /api/me/sign-in/password)',
    workos: true,
    run: async ({ routes, armed }) => {
      const out = await routes.call('POST', '/api/me/sign-in/password', {
        as: armed.ada.id, token: armed.a, body: { current_password: 'ada-password', password: 'a-brand-new-one' },
      });
      assert.equal(out.status, 200);
      return { kept: armed.a };
    },
  },
  {
    name: 'the admin setting the password at WorkOS (PUT /api/admin/users/:id/sign-in/password)',
    workos: true,
    run: async ({ routes, armed, suite }) => {
      const root = suite.accounts.byUsername('admin');
      const out = await routes.call('PUT', `/api/admin/users/${armed.ada.id}/sign-in/password`, {
        as: root.id, token: 'the-admins-own', body: { password: 'a-brand-new-one' },
      });
      assert.equal(out.status, 200);
      return { kept: null };
    },
  },
];

for (const pathCase of PATHS) {
  test(`revoked everything: ${pathCase.name}`, async (t) => {
    const env = await start(t);
    const { suite, browser } = env;
    const workosId = pathCase.workos ? 'user_ada' : null;
    const armed = arm(suite, workosId);
    const routes = pathCase.workos ? workosRoutes(suite) : null;
    routes?.workos.add('user_ada', { email: 'ada@example.com', password: 'ada-password' });
    const admin = browser();
    assert.equal((await admin('POST', '/api/auth/login', { username: 'admin', password: 'root-password' })).status, 200);
    const issuedBefore = Math.floor(Date.now() / 1000) - 1;

    const { kept } = await pathCase.run({ ...env, armed, admin, routes });

    // The browsers' sessions: the other one is out, the kept one (if any) still works.
    assert.equal((await browser(armed.b)('GET', '/api/me/sessions')).status, 401, 'session B is out');
    if (kept) {
      assert.ok(suite.sessions.alive(kept), 'the session where it was done stays');
    } else {
      assert.equal(suite.sessions.alive(armed.a), null, 'session A is out too');
    }
    // API tokens, the suite's OAuth, the phone (which can't open a web session any more), notices.
    assert.equal(suite.tokens.authenticate(armed.apiToken, { scope: 'mcp' }), null, 'the API token is dead');
    assert.equal(suite.oauth.userFromAccessToken(armed.access), null, 'the OAuth token is dead');
    assert.equal(suite.devices.authenticate(armed.phone), null, 'the phone is out');
    const webSession = await browser()('POST', '/api/devices/web-session', undefined, { Authorization: `Bearer ${armed.phone}` });
    assert.equal(webSession.status, 401, 'and it opens no new web session');
    assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', armed.ada.id).n, 0);
    if (armed.nativePush) assert.equal(suite.database.get('SELECT COUNT(*) AS n FROM device_push_tokens').n, 0);
    // With WorkOS: AuthKit's AI clients refused for what was issued before, withdrawn at WorkOS, and
    // the provider's sessions closed but the kept one's.
    if (routes) {
      assert.equal(routes.connections.refuses('user_ada', CLIENT, { iat: issuedBefore }), true, 'the AI client’s tokens are refused');
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(routes.provider.revokedClientsOf, [armed.ada.id]);
      assert.deepEqual(routes.provider.revokedSessions.sort(), kept ? ['session_b'] : ['session_a', 'session_b']);
    }
    // Said once in the log, with what was ended.
    const logged = suite.audit.list({ action: 'auth.revoke_everything' });
    assert.equal(logged.length, 1);
    assert.equal(logged[0].target_id, String(armed.ada.id));
    assert.equal(logged[0].meta.tokens, 1);
    assert.equal(logged[0].meta.devices, 1);
    if (routes) assert.equal(logged[0].meta.ai_clients, 1);
  });
}

test('revokeEverything keeps the session given, and its tab; the rest of the tabs are told and closed', async (t) => {
  const { suite } = await start(t);
  const { ada, a, b } = arm(suite, null);
  const dropped = [];
  suite.whenRevoked((id, { keep }) => dropped.push([id, keep?.sessionToken ?? null]));
  const counts = suite.revokeEverything(ada.id, { keep: { sessionToken: a }, reason: 'test' });
  assert.deepEqual(counts, { closed: 1, tokens: 1, grants: 1, devices: 1, push: 1, ai_clients: 0 });
  assert.ok(suite.sessions.alive(a));
  assert.equal(suite.sessions.alive(b), null);
  assert.deepEqual(dropped, [[ada.id, a]]);
  // Again: nothing left, nothing breaks.
  assert.deepEqual(suite.revokeEverything(ada.id, { reason: 'test' }),
    { closed: 1, tokens: 0, grants: 0, devices: 0, push: 0, ai_clients: 0 });
});
