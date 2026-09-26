/**
 * The WorkOS modules on their own: a fake AuthKit on localhost, an in-memory
 * list of users and a minimal HTTP server around workos-accounts.js. Apps test
 * their own integration on top of this.
 *
 *   npm test
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { createWorkosClient, workosConfigFromEnv } from '../workos.js';
import { createWorkosAccounts } from '../workos-accounts.js';

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
  const u = url.pathname.match(/^\/user_management\/users\/([\w-]+)$/);
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
  link: (id, { workosId, email }) => Object.assign(USERS.find((u) => u.id === id), { workos_user_id: workosId, email }),
  setEmail: (id, email) => { USERS.find((u) => u.id === id).email = email; },
  usernameTaken: (name) => USERS.some((u) => u.username === name),
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
accounts = createWorkosAccounts({
  baseUrl: base, appName: 'Test app', workos, adminEmail: 'ada@example.com', users,
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
  const strict = createWorkosClient({ apiUrl: AUTHKIT, apiKey: 'sk_test', clientId: 'c', authkitDomain: AUTHKIT, mcpAudience: `${base}/mcp` });
  check('With an audience set, a token for another app is refused',
    (await strict.verifyToken(tokenOf('user_bob', { aud: 'https://other/mcp' }))) === null
    && (await strict.verifyToken(tokenOf('user_bob', { aud: `${base}/mcp` })))?.sub === 'user_bob');

  console.log('\nMetadata and sign-out');
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  check('The resource points at AuthKit', prm.resource === `${base}/mcp` && prm.authorization_servers[0] === AUTHKIT);
  check('AuthKit’s own metadata is relayed', (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()).issuer === AUTHKIT);
  check('The 401 challenge points at the metadata', accounts.challenge(false).includes(`${base}/.well-known/oauth-protected-resource/mcp`));
  check('Signing out also closes AuthKit’s session',
    accounts.signOutUrl('sess_1') === `${AUTHKIT}/user_management/sessions/logout?session_id=sess_1`);
} catch (err) {
  failed++;
  console.log(`\n✗ Unexpected error: ${err.stack}`);
} finally {
  server.close();
  fake.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
