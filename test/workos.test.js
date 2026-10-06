/**
 * The WorkOS modules on their own: a fake AuthKit on localhost, an in-memory
 * list of users and a minimal HTTP server around workos-accounts.js. Apps test
 * their own integration on top of this.
 *
 *   npm test
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { createWorkosClient, workosConfigFromEnv, WorkosUnavailable } from '../workos.js';
import { createWorkosAccounts, connectionsSchema, connectionConsentsSchema, workosConnections } from '../workos-accounts.js';
import { openDatabase } from '../db.js';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` → ${detail}` : ''}`); }
}

/* ------------------------------ fake AuthKit ------------------------------ */

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (data, { kid = 'k1', key = privateKey, alg = 'RS256' } = {}) => {
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64(data);
  const sig = alg === 'none' ? '' : crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
};

const ACCOUNTS = {
  user_ada: { id: 'user_ada', email: 'Ada@Example.com', email_verified: true, first_name: 'Ada' },
  user_bob: { id: 'user_bob', email: 'bob@example.com', email_verified: true, first_name: 'Bob' },
  user_eve: { id: 'user_eve', email: 'ada@example.com', email_verified: false, first_name: 'Eve' },
};
const codes = new Map();
let jwksHits = 0;
// Bob's authorizations, as WorkOS lists them: Claude, one client, for this app and two others;
// ChatGPT for another; Cursor and Zed without a resource, only Cursor used here. WorkOS withdraws
// a client from every app at once.
const CLAUDE = { id: 'conn_claude', client_id: 'client_claude', name: 'Claude' };
const AUTHORIZED = () => [
  { id: 'aca_claude_here', oauth_resource: `${base}/mcp/`, application: CLAUDE },
  { id: 'aca_claude_next', oauth_resource: 'https://next.example/mcp', application: CLAUDE },
  { id: 'aca_claude_notes', oauth_resource: 'https://notes.example/mcp', application: CLAUDE },
  { id: 'aca_gpt', oauth_resource: 'https://other.example/mcp', application: { id: 'conn_gpt', client_id: 'client_gpt', name: 'ChatGPT' } },
  { id: 'aca_cursor', oauth_resource: null, application: { id: 'conn_cursor', client_id: 'client_cursor', name: 'Cursor' } },
  { id: 'aca_zed', oauth_resource: null, application: { id: 'conn_zed', client_id: 'client_zed', name: 'Zed' } },
];
const withdrawn = [];

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  let body = '';
  for await (const chunk of req) body += chunk;
  if (url.pathname === '/oauth2/jwks') { jwksHits++; return json(200, { keys: [jwk] }); }
  if (url.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: AUTHKIT });
  if (url.pathname === '/user_management/authenticate') {
    const b = JSON.parse(body || '{}');
    const c = codes.get(b.code);
    const challenge = crypto.createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
    if (b.client_secret !== 'sk_test' || !c || c.challenge !== challenge) return json(400, { error: 'invalid_grant' });
    codes.delete(b.code);
    return json(200, { user: ACCOUNTS[c.id], access_token: sign({ sid: `sess_${c.id}`, sub: c.id }) });
  }
  const apps = url.pathname.match(/^\/user_management\/users\/([\w-]+)\/authorized_applications(?:\/([\w-]+))?$/);
  if (apps) {
    if (req.headers.authorization !== 'Bearer sk_test') return json(401, {});
    if (req.method === 'DELETE') { withdrawn.push([apps[1], apps[2]]); res.writeHead(204); return res.end(); }
    const data = apps[1] === 'user_bob' ? AUTHORIZED().filter((a) => !withdrawn.some(([, id]) => id === a.application.id)) : [];
    // Two pages, to see they are all read.
    return json(200, url.searchParams.get('after') ? { data: data.slice(2), list_metadata: {} }
      : { data: data.slice(0, 2), list_metadata: { after: data.length > 2 ? 'next' : null } });
  }
  const u = url.pathname.match(/^\/user_management\/users\/([\w-]+)$/);
  // An id WorkOS can't answer about right now.
  if (u?.[1] === 'user_busy') return json(429, {});
  if (u) return ACCOUNTS[u[1]] ? json(200, ACCOUNTS[u[1]]) : json(404, {});
  return json(404, {});
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const AUTHKIT = `http://127.0.0.1:${fake.address().port}`;

/* -------------------------------- fake app -------------------------------- */

const USERS = [{ id: 1, username: 'admin', role: 'admin', email: null, workos_user_id: null }];
const opened = [];
const users = {
  byWorkosId: (id) => USERS.find((u) => u.workos_user_id === id) || null,
  unlinkedByEmail: (email) => USERS.find((u) => u.email === email && !u.workos_user_id) || null,
  firstUnlinkedAdmin: () => USERS.find((u) => u.role === 'admin' && !u.workos_user_id) || null,
  linkedByEmail: (email) => {
    const user = USERS.find((u) => u.email === email && u.workos_user_id);
    return user ? { user, subject: user.workos_user_id } : null;
  },
  link: (id, { workosId, email }) => Object.assign(USERS.find((u) => u.id === id), { workos_user_id: workosId, email }),
  relink: (id, { from, workosId, email }) => Object.assign(USERS.find((u) => u.id === id && u.workos_user_id === from),
    { workos_user_id: workosId, email }),
  setEmail: (id, email) => { USERS.find((u) => u.id === id).email = email; },
  usernameTaken: (name) => USERS.some((u) => u.username === name),
  workosIdOf: (id) => USERS.find((u) => u.id === id)?.workos_user_id ?? null,
  create: ({ username, displayName, role, email, workosId }) => {
    if (USERS.some((u) => u.workos_user_id === workosId)) throw new Error('duplicate');
    const user = { id: USERS.length + 1, username, display_name: displayName, role, email, workos_user_id: workosId };
    USERS.push(user);
    return user;
  },
};

let base = '';
let accounts;
const server = http.createServer(async (req, res) => {
  if (await accounts.handle(req, res, new URL(req.url, 'http://x'))) return;
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${server.address().port}`;

const workos = createWorkosClient({
  apiUrl: AUTHKIT, apiKey: 'sk_test', clientId: 'client_test', authkitDomain: AUTHKIT,
});
const database = openDatabase({ path: ':memory:' });
connectionsSchema(database);
connectionConsentsSchema(database);
const connections = workosConnections(database);
accounts = createWorkosAccounts({
  baseUrl: base, appName: 'Test app', workos, adminEmail: 'ada@example.com', users, connections,
  sessions: { open: (res, userId, extra) => opened.push({ userId, ...extra }) },
  stateCookie: 'test_auth', log: () => {},
});

const signIn = async (id) => {
  const out = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  const target = new URL(out.headers.get('location'));
  const cookie = out.headers.get('set-cookie').split(';')[0];
  const code = `c-${id}-${Math.random()}`;
  codes.set(code, { id, challenge: target.searchParams.get('code_challenge') });
  const back = await fetch(`${base}/auth/callback?code=${code}&state=${target.searchParams.get('state')}`,
    { redirect: 'manual', headers: { Cookie: cookie } });
  return { out, target, cookie, back };
};

/* --------------------------------- tests ---------------------------------- */

try {
  console.log('\nConfiguration');
  const cfg = workosConfigFromEnv({ AUTH_PROVIDER: 'workos', WORKOS_API_KEY: 'k' });
  check('It reads the usual variables', cfg.enabled && cfg.apiKey === 'k');
  check('And says what is missing', createWorkosClient(cfg).missingConfig().join() === 'WORKOS_CLIENT_ID,WORKOS_AUTHKIT_DOMAIN');

  console.log('\nWeb sign-in');
  const ada = await signIn('user_ada');
  check('/auth/login goes to AuthKit with PKCE S256',
    ada.target.pathname === '/user_management/authorize' && ada.target.searchParams.get('code_challenge_method') === 'S256'
    && ada.target.searchParams.get('redirect_uri') === `${base}/auth/callback`);
  check('The state cookie is HttpOnly and limited to /auth',
    /HttpOnly/.test(ada.out.headers.get('set-cookie')) && /Path=\/auth/.test(ada.out.headers.get('set-cookie')));
  check('The return opens a session through the app, with AuthKit’s session id',
    ada.back.headers.get('location') === '/' && opened.at(-1)?.workosSessionId === 'sess_user_ada');
  check('And with the request, so the session knows its browser', typeof opened.at(-1)?.req?.headers === 'object');
  check('The admin email takes over the existing admin', USERS[0].workos_user_id === 'user_ada'
    && USERS[0].email === 'ada@example.com' && USERS.length === 1);
  const eve = await signIn('user_eve');
  const eveUser = USERS.find((u) => u.workos_user_id === 'user_eve');
  check('An unverified email gets a new account, without that email',
    eve.back.headers.get('location') === '/' && eveUser?.id !== 1 && eveUser?.email === null);
  const bob = await signIn('user_bob');
  check('Others get a username from their email', USERS.find((u) => u.workos_user_id === 'user_bob')?.username === 'bob'
    && bob.back.status === 302);
  const wrongState = await fetch(`${base}/auth/callback?code=x&state=nope`, { redirect: 'manual', headers: { Cookie: ada.cookie } });
  check('A state that doesn’t match opens nothing', /auth_error=failed/.test(wrongState.headers.get('location')));

  console.log('\nMCP tokens');
  const now = Math.floor(Date.now() / 1000);
  const tokenOf = (sub, extra = {}) => sign({ iss: AUTHKIT, sub, exp: now + 300, ...extra });
  check('A valid AuthKit token is its user', (await accounts.userFromToken(tokenOf('user_bob')))?.username === 'bob');
  const bad = {
    expired: tokenOf('user_bob', { exp: now - 600 }),
    'from another issuer': tokenOf('user_bob', { iss: 'https://other.authkit.app' }),
    'signed with another key': sign({ iss: AUTHKIT, sub: 'user_bob', exp: now + 300 }, { key: otherKey }),
    'alg none': sign({ iss: AUTHKIT, sub: 'user_bob', exp: now + 300 }, { alg: 'none' }),
    'of an unknown account': tokenOf('user_ghost'),
  };
  for (const [name, token] of Object.entries(bad)) {
    check(`A token ${name} is no one`, (await accounts.userFromToken(token)) === null);
  }
  check('Keys are cached, not fetched on every request', jwksHits <= 2, `${jwksHits}`);
  const bobUser = USERS.find((u) => u.workos_user_id === 'user_bob');
  bobUser.disabled_at = '2026-05-01T10:00:00.000Z';
  check('A disabled account’s token is no one', (await accounts.userFromToken(tokenOf('user_bob'))) === null);
  const openedBefore = opened.length;
  const disabledSignIn = await signIn('user_bob');
  check('A disabled account doesn’t sign in on the web', /auth_error=disabled/.test(disabledSignIn.back.headers.get('location'))
    && opened.length === openedBefore);
  bobUser.disabled_at = null;
  check('Enabled again, it is someone again', (await accounts.userFromToken(tokenOf('user_bob')))?.username === 'bob');
  const strict = createWorkosClient({ apiUrl: AUTHKIT, apiKey: 'sk_test', clientId: 'c', authkitDomain: AUTHKIT, mcpAudience: `${base}/mcp` });
  check('With an audience set, a token for another app is refused',
    (await strict.verifyToken(tokenOf('user_bob', { aud: 'https://other/mcp' }))) === null
    && (await strict.verifyToken(tokenOf('user_bob', { aud: `${base}/mcp` })))?.sub === 'user_bob');

  console.log('\nConnected AI clients');
  const bobId = bobUser.id;
  check('A token from a client is noted as its use',
    (await accounts.userFromToken(tokenOf('user_bob', { client_id: 'client_cursor', iat: now - 10 })))?.id === bobId
    && Boolean(connections.of('user_bob').client_cursor?.last_used_at));
  const listed = await accounts.connectionsOf(bobId);
  check('Listed: only this app’s authorization of Claude, not the other apps’, and Cursor, used here without a resource',
    listed.map((c) => c.id).join() === 'aca_claude_here,aca_cursor', listed.map((c) => c.id).join());
  check('With when they were last used here', Boolean(listed.find((c) => c.client_id === 'client_cursor')?.last_used_at)
    && listed.find((c) => c.client_id === 'client_claude')?.last_used_at === null);
  check('An account without WorkOS has none', (await accounts.connectionsOf(9999)).length === 0);
  const claudeBefore = tokenOf('user_bob', { client_id: 'client_claude', sid: 'consent_1', iat: now - 5 });
  check('Before disconnecting, Claude’s token works', (await accounts.userFromToken(claudeBefore))?.id === bobId);
  check('Another app’s connection can’t be disconnected from here',
    (await accounts.revokeConnection(bobId, 'aca_gpt')) === false
    && (await accounts.revokeConnection(bobId, 'aca_claude_next')) === false && withdrawn.length === 0);
  const done = await accounts.revokeConnection(bobId, 'aca_claude_here');
  check('Disconnecting Claude here leaves it authorized at WorkOS for the other apps',
    done?.client_name === 'Claude' && done.everywhere === false && withdrawn.length === 0, JSON.stringify({ done, withdrawn }));
  check('And it is no longer listed here', !(await accounts.connectionsOf(bobId)).some((c) => c.client_id === 'client_claude'));
  check('A token Claude already had is refused, though it hasn’t expired', (await accounts.userFromToken(claudeBefore)) === null);
  check('So is a refreshed one, of the same consent',
    (await accounts.userFromToken(tokenOf('user_bob', { client_id: 'client_claude', sid: 'consent_1', iat: now + 5 }))) === null);
  check('One of a new consent (connected again) works, and is listed again',
    (await accounts.userFromToken(tokenOf('user_bob', { client_id: 'client_claude', sid: 'consent_2', iat: now + 5 })))?.id === bobId
    && (await accounts.connectionsOf(bobId)).some((c) => c.id === 'aca_claude_here'));
  const cursor = await accounts.revokeConnection(bobId, 'aca_cursor');
  check('A client authorized only here is withdrawn at WorkOS too',
    cursor?.everywhere === true && withdrawn.at(-1)?.join() === 'user_bob,conn_cursor', JSON.stringify(withdrawn));
  check('Other clients are untouched',
    (await accounts.userFromToken(tokenOf('user_bob', { client_id: 'client_claude', sid: 'consent_2', iat: now + 5 })))?.id === bobId);

  console.log('\nMetadata and sign-out');
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  check('The resource points at AuthKit', prm.resource === `${base}/mcp` && prm.authorization_servers[0] === AUTHKIT);
  check('AuthKit’s own metadata is relayed', (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()).issuer === AUTHKIT);
  const again = await fetch(`${base}/.well-known/oauth-authorization-server`);
  check('And again, from the copy kept (not only the first time after starting)',
    again.status === 200 && (await again.json()).issuer === AUTHKIT, `status ${again.status}`);
  check('The 401 challenge points at the metadata', accounts.challenge(false).includes(`${base}/.well-known/oauth-protected-resource/mcp`));
  check('Signing out also closes AuthKit’s session',
    accounts.signOutUrl('sess_1') === `${AUTHKIT}/user_management/sessions/logout?session_id=sess_1`);

  console.log('\nWhen WorkOS knows someone by a new id');
  // The install moves to another WorkOS environment: Ada's old id is gone there.
  delete ACCOUNTS.user_ada;
  ACCOUNTS.user_ada_prod = { id: 'user_ada_prod', email: 'ada@example.com', email_verified: true, first_name: 'Ada' };
  const usersBefore = USERS.length;
  const moved = await signIn('user_ada_prod');
  check('Her account follows her to the new id', USERS[0].workos_user_id === 'user_ada_prod'
    && USERS.length === usersBefore && opened.at(-1)?.userId === 1, moved.back.headers.get('location'));
  ACCOUNTS.user_bob_new = { id: 'user_bob_new', email: 'bob@example.com', email_verified: true, first_name: 'Robert' };
  await signIn('user_bob_new');
  check('While the old id still exists, it is someone else: a new account',
    USERS.find((u) => u.username === 'bob')?.workos_user_id === 'user_bob'
    && USERS.find((u) => u.workos_user_id === 'user_bob_new')?.id > usersBefore);
  USERS.push({ id: USERS.length + 1, username: 'carl', role: 'user', email: 'carl@example.com', workos_user_id: 'user_carl_old' });
  ACCOUNTS.user_carl = { id: 'user_carl', email: 'carl@example.com', email_verified: true, first_name: 'Carl' };
  check('Through the MCP too', (await accounts.userFromToken(tokenOf('user_carl')))?.username === 'carl');
  USERS.push({ id: USERS.length + 1, username: 'dan', role: 'user', email: 'dan@example.com', workos_user_id: 'user_busy' });
  ACCOUNTS.user_dan = { id: 'user_dan', email: 'dan@example.com', email_verified: true, first_name: 'Dan' };
  const countBefore = USERS.length;
  const busy = await signIn('user_dan');
  check('If WorkOS can’t say whether the old id exists, nothing moves and nothing is made',
    /auth_error=unavailable/.test(busy.back.headers.get('location'))
    && USERS.find((u) => u.username === 'dan').workos_user_id === 'user_busy' && USERS.length === countBefore);

  console.log('\nWhen WorkOS doesn’t answer');
  // A port that was just free: nothing listens there any more.
  const gone = http.createServer();
  await new Promise((r) => gone.listen(0, '127.0.0.1', r));
  const GONE = `http://127.0.0.1:${gone.address().port}`;
  await new Promise((r) => gone.close(r));
  const away = createWorkosClient({ apiUrl: GONE, apiKey: 'sk_test', clientId: 'c', authkitDomain: GONE });
  const outage = await away.exchangeCode({ code: 'x', verifier: 'v' }).then(() => null, (err) => err);
  check('It is an outage, not a bad code', outage instanceof WorkosUnavailable, String(outage));
  check('And the log says why, not just "fetch failed"', /ECONNREFUSED/.test(outage?.message), outage?.message);
} catch (err) {
  failed++;
  console.log(`\n✗ Unexpected error: ${err.stack}`);
} finally {
  server.close();
  fake.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
