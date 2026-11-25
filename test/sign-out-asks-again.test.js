/**
 * Signing out with WorkOS: out of the shared login too, and the next sign-in in this browser asks
 * who it is. Before, another tab of Work that lost its session went to AuthKit at once, and AuthKit,
 * still signed in, let in whoever it remembered a second later (production, 24 and 25/11).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSuite, createApp } from '../app.js';
import { createSessions } from '../sessions.js';
import { openDatabase } from '../db.js';
import { SIGNED_OUT_COOKIE, signedOutHere } from '../http.js';

/** WorkOS: a sign-in's code exchanged for its user (with the session's `sid`), and sessions revoked. */
async function fakeWorkos(t) {
  const users = new Map();
  const codes = new Map();
  const revoked = [];
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const answer = (status, body = {}) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/user_management/authenticate' && req.method === 'POST') {
        const id = codes.get(JSON.parse(raw).code);
        if (!id) return answer(400, { error: 'invalid_grant' });
        const token = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sid: `session_${id}`, sub: id })}.x`;
        return answer(200, { user: users.get(id), access_token: token, authentication_method: 'Password' });
      }
      if (req.url === '/user_management/sessions/revoke' && req.method === 'POST') {
        revoked.push(JSON.parse(raw).session_id);
        return answer(200, {});
      }
      const id = decodeURIComponent(req.url.match(/^\/user_management\/users\/([^/?]+)$/)?.[1] || '');
      const user = users.get(id);
      if (!user) return answer(404, { code: 'entity_not_found' });
      if (req.method === 'GET') return answer(200, user);
      if (req.method === 'PUT') return answer(200, user);
      return answer(405);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const add = (id) => users.set(id, { id, object: 'user', email: `${id}@example.com`, email_verified: true, metadata: {} });
  return { url: `http://127.0.0.1:${server.address().port}`, codes, revoked, add };
}

async function serve(t, workos) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-sign-out-'));
  const suite = createSuite({
    config: { app: { id: 'demo', name: 'Demo', port: 3999, languages: ['en'] }, accounts: { minPasswordLength: 8 } },
    env: {
      DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'sk_test',
      WORKOS_CLIENT_ID: 'client', WORKOS_AUTHKIT_DOMAIN: workos.url, WORKOS_API_URL: workos.url,
    },
    log: () => {}, exitOnError: false,
  });
  const app = createApp({ suite, version: '1.0.0', handleSignals: false, log: () => {} });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookiesOf = (res) => res.headers.getSetCookie?.() || [];
  const pick = (res, name) => cookiesOf(res).find((c) => c.startsWith(`${name}=`)) ?? null;

  /** `/auth/login` from a browser with these cookies: where AuthKit is asked, and the flow's cookie. */
  const login = async (cookie = '') => {
    const out = await fetch(`${base}/auth/login`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
    return { target: new URL(out.headers.get('location')), flow: pick(out, 'demo_auth')?.split(';')[0] ?? '' };
  };
  /** A whole sign-in as `workosId` from a browser with `cookie`: the session's cookie and what was set. */
  const signIn = async (workosId, cookie = '') => {
    const { target, flow } = await login(cookie);
    const code = `code-${workosId}-${Math.random()}`;
    workos.codes.set(code, workosId);
    const back = await fetch(`${base}/auth/callback?code=${code}&state=${target.searchParams.get('state')}`,
      { redirect: 'manual', headers: { Cookie: [flow, cookie].filter(Boolean).join('; ') } });
    return { target, session: pick(back, 'demo_sid')?.split(';')[0], set: cookiesOf(back) };
  };
  const logout = async (cookie) => {
    const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: base } });
    return { status: res.status, data: await res.json(), mark: pick(res, SIGNED_OUT_COOKIE) };
  };
  return { suite, base, login, signIn, logout };
}

test('signing out with WorkOS ends the AuthKit session from here and leaves the browser a mark; the next sign-in asks again', async (t) => {
  const workos = await fakeWorkos(t);
  workos.add('user_ana');
  workos.add('user_bea');
  const { signIn, logout, login } = await serve(t, workos);

  // Nobody left yet: AuthKit may reuse its session, as before.
  const first = await signIn('user_ana');
  assert.equal(first.target.searchParams.has('max_age'), false);
  assert.ok(first.session, 'signed in');
  assert.equal(first.set.some((c) => c.startsWith(`${SIGNED_OUT_COOKIE}=`)), false, 'no mark to take away');

  const out = await logout(first.session);
  assert.equal(out.status, 200);
  assert.deepEqual(out.data, { ok: true }, 'no provider page to go to: the server ended it');
  assert.ok(out.mark, 'the mark of a sign-out');
  assert.match(out.mark, new RegExp(`^${SIGNED_OUT_COOKIE}=1;`));
  assert.match(out.mark, /Max-Age=2592000/);
  assert.match(out.mark, /Path=\//);
  assert.doesNotMatch(out.mark, /HttpOnly/, 'the pages read it (signin.js straightToProvider)');
  for (let i = 0; i < 50 && !workos.revoked.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(workos.revoked, ['session_user_ana'], 'out of the shared login, at WorkOS');

  // Another tab, or this one, signing in: AuthKit asks who it is (max_age=0), whoever it remembers.
  const mark = `${SIGNED_OUT_COOKIE}=1`;
  assert.equal((await login(mark)).target.searchParams.get('max_age'), '0');
  // Signed in again: the mark goes, and the sign-in after reuses AuthKit's session as before.
  const again = await signIn('user_bea', mark);
  assert.equal(again.target.searchParams.get('max_age'), '0');
  assert.ok(again.session);
  const cleared = again.set.find((c) => c.startsWith(`${SIGNED_OUT_COOKIE}=`));
  assert.ok(cleared, 'the mark taken away');
  assert.match(cleared, /Max-Age=0/);

  // A sign-out without a session (already gone) leaves no mark and revokes nothing.
  const none = await logout('demo_sid=nobody');
  assert.equal(none.status, 200);
  assert.equal(none.mark, null);
  assert.deepEqual(workos.revoked, ['session_user_ana']);
});

test('sessions: the mark is set on demand and goes when this browser signs in again, only when it has one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-sign-out-sessions-'));
  const database = openDatabase({ path: path.join(dir, 'app.db') });
  database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, disabled_at TEXT);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER, created_at TEXT, last_used_at TEXT,
      expires_at TEXT, absolute_expires_at TEXT, user_agent TEXT, ip TEXT, idp_session_id TEXT);
    INSERT INTO users (id, username) VALUES (1, 'ana');`);
  try {
    const sessions = createSessions({ database, secret: 'x'.repeat(32), cookieName: 'demo_sid', secureCookies: true });
    const response = () => {
      const headers = {};
      return { headers, getHeader: (n) => headers[n], setHeader: (n, v) => { headers[n] = v; } };
    };
    const setCookies = (res) => [res.headers['Set-Cookie']].flat().filter(Boolean);

    const out = response();
    sessions.markSignedOut(out);
    assert.deepEqual(setCookies(out), [`${SIGNED_OUT_COOKIE}=1; Max-Age=2592000; Path=/; SameSite=Lax; Secure`]);

    const marked = { headers: { cookie: `${SIGNED_OUT_COOKIE}=1; other=2` } };
    assert.equal(signedOutHere(marked), true);
    assert.equal(signedOutHere({ headers: { cookie: 'other=2' } }), false);
    const back = response();
    sessions.open(1, { req: marked, res: back });
    assert.equal(setCookies(back).length, 2, 'the session and the mark taken away');
    assert.equal(setCookies(back)[1], `${SIGNED_OUT_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; Secure`);

    const plain = response();
    sessions.open(1, { req: { headers: {} }, res: plain });
    assert.equal(setCookies(plain).length, 1, 'only the session');
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
