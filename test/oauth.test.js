/**
 * The built-in OAuth server on its own: an in-memory database, fake users and
 * sessions, a two-line "MCP" and the whole dance a client like Claude does.
 * Apps test their own integration on top of this.
 *
 *   npm test
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { OAUTH_SCHEMA, createOAuthServer } from '../oauth.js';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` → ${detail}` : ''}`); }
}

/* ------------------------------ a fake app -------------------------------- */

const db = new DatabaseSync(':memory:');
db.exec(OAUTH_SCHEMA);
const adapter = {
  all: (sql, ...p) => db.prepare(sql).all(...p),
  get: (sql, ...p) => db.prepare(sql).get(...p),
  run: (sql, ...p) => {
    const r = db.prepare(sql).run(...p);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  },
};

const USERS = [{ id: 1, username: 'ada', password: 'secret123' }];
const sessions = new Map();           // token → userId
const cookieOf = (req) => /sid=([^;]+)/.exec(req.headers.cookie || '')?.[1] || null;
const counters = new Map();

const texts = () => ({
  lang: 'en',
  t: (key, vars = {}) => `[${key}]${Object.values(vars).join(' ')}`,
});

let base = '';
let oauth;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (await oauth.handle(req, res, url)) return;
  if (url.pathname === '/mcp') {
    const token = String(req.headers.authorization || '').replace(/^bearer\s+/i, '');
    const user = oauth.userFromAccessToken(token);
    if (!user) {
      res.writeHead(401, { 'WWW-Authenticate': oauth.challenge(Boolean(token)) });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ user: user.username }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${server.address().port}`;

oauth = createOAuthServer({
  baseUrl: base,
  appName: 'Test app',
  db: adapter,
  users: {
    login: (name, password) => USERS.find((u) => u.username === name && u.password === password) || null,
    fromRequest: (req) => USERS.find((u) => u.id === sessions.get(cookieOf(req))) || null,
    byId: (id) => USERS.find((u) => u.id === id) || null,
    handle: (u) => `@${u.username}`,
  },
  sessions: {
    open: (res, userId) => {
      const token = crypto.randomBytes(16).toString('hex');
      sessions.set(token, userId);
      res.setHeader('Set-Cookie', `sid=${token}; Path=/`);
    },
    tokenFrom: cookieOf,
    sign: (value) => crypto.createHmac('sha256', 'test').update(value).digest('base64url'),
  },
  limits: {
    checkLogin: (req, name) => ({ allowed: (counters.get(name) || 0) < 5 }),
    loginFailed: (req, name) => counters.set(name, (counters.get(name) || 0) + 1),
    loginSucceeded: (req, name) => counters.delete(name),
    allowRegistration: () => ({ allowed: true }),
  },
  texts,
  page: ({ lang, title, body }) => `<!doctype html><html lang="${lang}"><title>${title}</title>${body}</html>`,
  log: () => {},
});

/* -------------------------------- helpers --------------------------------- */

const form = (data) => new URLSearchParams(Object.entries(data).filter(([, v]) => v != null)).toString();
const post = (route, data, headers = {}) => fetch(`${base}${route}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: form(data),
});
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};
const mcp = (token) => fetch(`${base}/mcp`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const REDIRECT = 'https://client.example/callback';

/* --------------------------------- tests ---------------------------------- */

try {
  console.log('\nDiscovery');
  const noToken = await mcp(null);
  check('A request without a token gets a 401 pointing at the metadata', noToken.status === 401
    && (noToken.headers.get('www-authenticate') || '').includes(`${base}/.well-known/oauth-protected-resource/mcp`));
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  check('The resource is BASE_URL/mcp and names the app',
    prm.resource === `${base}/mcp` && prm.authorization_servers[0] === base && prm.resource_name === 'Test app');
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  check('The server metadata offers PKCE S256, CIMD and registration',
    as.issuer === base && as.code_challenge_methods_supported.includes('S256')
    && as.client_id_metadata_document_supported === true && as.registration_endpoint === `${base}/oauth/register`);

  console.log('\nRegistration');
  const client = await (await fetch(`${base}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  })).json();
  check('A public client registers', /^oc_/.test(client.client_id) && !client.client_secret, JSON.stringify(client));
  const bad = await fetch(`${base}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://example.com/cb'] }),
  });
  check('An http redirect outside loopback is refused', bad.status === 400);

  console.log('\nAuthorization');
  const { verifier, challenge } = pkce();
  const params = {
    response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, state: 's1',
    code_challenge: challenge, code_challenge_method: 'S256', resource: `${base}/mcp`,
  };
  const screen = await fetch(`${base}/oauth/authorize?${form(params)}`);
  const html = await screen.text();
  check('The consent screen uses the app’s page and texts',
    screen.status === 200 && html.includes('[oauth.connectTitle]') && html.includes('name="password"'));
  check('Values in texts are escaped and put in bold', html.includes('<strong>Client</strong>'));
  check('Its CSP allows going back to the client only',
    /form-action 'self' https:\/\/client\.example/.test(screen.headers.get('content-security-policy') || ''));
  const wrong = await post('/oauth/authorize', { ...params, username: 'ada', password: 'nope', decision: 'allow' });
  check('A wrong password stays on screen', wrong.status === 200 && (await wrong.text()).includes('[oauth.badCredentials]'));
  const ok = await post('/oauth/authorize', { ...params, username: 'ada', password: 'secret123', decision: 'allow' });
  const back = new URL(ok.headers.get('location'));
  check('The right one goes back with a code, the state and the issuer',
    ok.status === 302 && back.searchParams.get('code') && back.searchParams.get('state') === 's1'
    && back.searchParams.get('iss') === base);
  check('And opens a browser session through the app', /sid=/.test(ok.headers.get('set-cookie') || ''));

  console.log('\nTokens');
  const exchange = (extra = {}) => post('/oauth/token', {
    grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: REDIRECT,
    client_id: client.client_id, code_verifier: verifier, ...extra,
  });
  check('A wrong verifier gets nothing', (await exchange({ code_verifier: pkce().verifier })).status === 400);
  const tokens = await (await exchange()).json();
  check('The right one gets access and refresh tokens',
    /^mcpat_/.test(tokens.access_token) && /^mcprt_/.test(tokens.refresh_token));
  const asUser = await mcp(tokens.access_token);
  check('The access token opens the resource as that user',
    asUser.status === 200 && (await asUser.json()).user === 'ada');
  check('Tokens are stored only as hashes', !adapter.get(
    'SELECT 1 FROM oauth_tokens WHERE token_hash = ?', tokens.access_token));

  const refreshed = await (await post('/oauth/token', {
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id,
  })).json();
  check('Refreshing rotates the pair', /^mcpat_/.test(refreshed.access_token)
    && refreshed.refresh_token !== tokens.refresh_token);
  check('The old access token stops working', (await mcp(tokens.access_token)).status === 401);
  await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
  check('Reusing a refresh token revokes the whole grant', (await mcp(refreshed.access_token)).status === 401);

  console.log('\nGrants');
  const again = pkce();
  const ok2 = await post('/oauth/authorize', {
    ...params, code_challenge: again.challenge, username: 'ada', password: 'secret123', decision: 'allow',
  });
  const t2 = await (await post('/oauth/token', {
    grant_type: 'authorization_code', code: new URL(ok2.headers.get('location')).searchParams.get('code'),
    redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: again.verifier,
  })).json();
  const grants = oauth.grantsOf(1);
  check('The app can list a user’s grants', grants.length === 1 && grants[0].redirect_host === 'client.example',
    JSON.stringify(grants));
  check('Revoking one takes its access away', oauth.revokeGrant(grants[0].id, 1)
    && (await mcp(t2.access_token)).status === 401);
  check('Another user can’t revoke it', oauth.revokeGrant(grants[0].id, 2) === false);

  console.log('\nCIMD');
  const byIp = await fetch(`${base}/oauth/authorize?${form({ ...params, client_id: 'https://127.0.0.1:1/client.json' })}`);
  check('A client document at an IP address is never fetched',
    byIp.status === 400 && (await byIp.text()).includes('[oauth.error.client_document_ip]'));
  const byHttp = await fetch(`${base}/oauth/authorize?${form({ ...params, client_id: 'http://127.0.0.1:1/client.json' })}`);
  check('An http client_id is not a document: it is an unknown client',
    byHttp.status === 400 && (await byHttp.text()).includes('[oauth.error.client_unknown]'));

  console.log('\nThe suite’s own texts');
  const plain = createOAuthServer({
    baseUrl: base, appName: 'Test app', db: adapter,
    users: { fromRequest: () => null, handle: (u) => `@${u.username}` },
    sessions: { tokenFrom: () => null, sign: (v) => v },
    limits: {},
    page: ({ lang, title, body }) => `<!doctype html><html lang="${lang}"><title>${title}</title>${body}</html>`,
    log: () => {},
  });
  const screenIn = async (acceptLanguage, clientId = client.client_id) => {
    let status = 0;
    let body = '';
    const res = {
      setHeader() {},
      writeHead(code) { status = code; },
      end(text) { body = String(text || ''); },
    };
    const url = new URL(`${base}/oauth/authorize?${form({ ...params, client_id: clientId })}`);
    await plain.handle({ method: 'GET', headers: { 'accept-language': acceptLanguage }, url: url.pathname + url.search },
      res, url);
    return { status, body };
  };
  const inSpanish = await screenIn('es-ES,es;q=0.9,en;q=0.5');
  check('Without texts of its own, the consent screen speaks the browser’s language',
    inSpanish.status === 200 && inSpanish.body.includes('lang="es"')
    && inSpanish.body.includes('Conectar con Test app') && inSpanish.body.includes('Entrar y permitir'));
  const inFrench = await screenIn('fr-CH');
  check('…in any language of the suite', inFrench.body.includes('Se connecter à Test app'));
  const unknownLanguage = await screenIn('pt-BR');
  check('…and in English when it has none of them', unknownLanguage.body.includes('Connect to Test app'));
  const errorInGerman = await screenIn('de', 'oc_nobody');
  check('The error screen too', errorInGerman.status === 400
    && errorInGerman.body.includes('Diese Anwendung ist hier nicht registriert.'));

  console.log('\nSwitched off');
  const off = createOAuthServer({ ...{ baseUrl: base, appName: 'x', db: adapter }, enabled: false,
    users: {}, sessions: {}, limits: {}, texts, page: () => '' });
  check('Disabled, it handles nothing and knows no tokens',
    (await off.handle({ method: 'GET' }, null, new URL(`${base}/oauth/token`))) === false
    && off.userFromAccessToken(refreshed.access_token) === null);
} catch (err) {
  failed++;
  console.log(`\n✗ Unexpected error: ${err.stack}`);
} finally {
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
