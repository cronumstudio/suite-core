/**
 * Signing in with an OpenID Connect provider: a fake one on localhost (discovery,
 * keys, tokens, userinfo, sign-out) and an app made with createSuite() and
 * createApp(), used over real HTTP.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSuite, createApp } from '../app.js';
import { createOidcClient, OidcUnavailable } from '../oidc.js';

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const stranger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (key, kid) => ({ ...key.export({ format: 'jwk' }), kid, use: 'sig' });

function sign(claims, { alg = 'RS256', kid = alg === 'ES256' ? 'e1' : 'k1', key } = {}) {
  const head = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = Buffer.from(`${head}.${body}`);
  const signature = alg === 'ES256'
    ? crypto.sign('sha256', input, { key: key || ec.privateKey, dsaEncoding: 'ieee-p1363' })
    : crypto.sign('RSA-SHA256', input, key || rsa.privateKey);
  return `${head}.${body}.${signature.toString('base64url')}`;
}

/** The fake provider: what it will say about whoever signs in next, by code. */
async function startProvider(t) {
  const codes = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: P, authorization_endpoint: `${P}/authorize`, token_endpoint: `${P}/token`, jwks_uri: `${P}/jwks`,
        userinfo_endpoint: `${P}/userinfo`, end_session_endpoint: `${P}/logout`,
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk(rsa.publicKey, 'k1'), jwk(ec.publicKey, 'e1')] });
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body);
      const expected = `Basic ${Buffer.from('demo-client:demo-secret').toString('base64')}`;
      const entry = codes.get(form.get('code'));
      const challenge = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
      if (req.headers.authorization !== expected || !entry || entry.challenge !== challenge
        || entry.redirect !== form.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
      codes.delete(form.get('code'));
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: P, aud: 'demo-client', sub: entry.sub, iat: now, exp: now + 300, nonce: entry.nonce,
        ...entry.claims, ...entry.override,
      };
      return json(200, { id_token: sign(claims, entry.signing), access_token: `at_${entry.sub}`, token_type: 'Bearer' });
    }
    if (url.pathname === '/userinfo') {
      const sub = String(req.headers.authorization || '').replace('Bearer at_', '');
      return json(200, { sub, ...(USERINFO[sub] || {}) });
    }
    return json(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const P = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());
  return { P, codes };
}

const USERINFO = { 'u-ivy': { email: 'ivy@example.com', email_verified: true, name: 'Ivy' } };

test('OIDC: sign-in, accounts linked by verified email, tokens checked, sign-out', async (t) => {
  const { P, codes } = await startProvider(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-oidc-'));
  const suite = createSuite({
    config: { app: { id: 'demo', name: 'Demo', languages: ['en', 'es'] } },
    env: {
      DATA_DIR: dir, PORT: '0', BASE_URL: 'http://127.0.0.1', AUTH_PROVIDER: 'oidc', ADMIN_EMAIL: 'ada@example.com',
      OIDC_ISSUER: `${P}/`, OIDC_CLIENT_ID: 'demo-client', OIDC_CLIENT_SECRET: 'demo-secret', OIDC_NAME: 'Authentik',
    },
    log: () => {}, exitOnError: false,
  });
  const app = createApp({ suite, handleSignals: false, log: () => {} });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const signIn = async (claims, { returnTo = null, override = {}, signing = {}, state = null } = {}) => {
    const out = await fetch(`${base}/auth/login${returnTo ? `?return=${encodeURIComponent(returnTo)}` : ''}`, { redirect: 'manual' });
    const target = new URL(out.headers.get('location'));
    const cookie = out.headers.get('set-cookie').split(';')[0];
    const code = `c-${crypto.randomUUID()}`;
    codes.set(code, {
      sub: claims.sub, claims, override, signing, nonce: target.searchParams.get('nonce'),
      challenge: target.searchParams.get('code_challenge'), redirect: target.searchParams.get('redirect_uri'),
    });
    const back = await fetch(`${base}/auth/callback?code=${code}&state=${state ?? target.searchParams.get('state')}`,
      { redirect: 'manual', headers: { Cookie: cookie } });
    const session = (back.headers.getSetCookie?.() || []).find((c) => c.startsWith('demo_sid='))?.split(';')[0] || null;
    return { out, target, cookie, back, location: back.headers.get('location'), session };
  };
  const api = async (method, pathname, session, body) => {
    const res = await fetch(base + pathname, {
      method, headers: { ...(session ? { Cookie: session } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  assert.deepEqual((await api('GET', '/api/auth/config')).data, {
    provider: 'oidc', name: 'Authentik', signup: null, mail: false, password_min: null, two_factor: false,
    app: { id: 'demo', name: 'Demo', languages: ['en', 'es'], modules: { organizations: false, billing: false } },
  });
  assert.equal((await api('POST', '/api/auth/login', null, { username: 'x', password: 'y' })).data.error, 'password_login_disabled');

  // Going to the provider: PKCE, a state and a nonce.
  const ada = await signIn({ sub: 'u-ada', email: 'Ada@Example.com', email_verified: true, name: 'Ada Lovelace', preferred_username: 'ada' });
  assert.equal(ada.target.origin + ada.target.pathname, `${P}/authorize`);
  assert.equal(ada.target.searchParams.get('client_id'), 'demo-client');
  assert.equal(ada.target.searchParams.get('redirect_uri'), `http://127.0.0.1/auth/callback`);
  assert.equal(ada.target.searchParams.get('scope'), 'openid email profile');
  assert.equal(ada.target.searchParams.get('code_challenge_method'), 'S256');
  assert.match(ada.out.headers.get('set-cookie'), /HttpOnly/);
  assert.match(ada.out.headers.get('set-cookie'), /Path=\/auth/);

  // Back: an account, administrator because of ADMIN_EMAIL, and a session.
  assert.equal(ada.location, '/');
  const me = (await api('GET', '/api/auth/me', ada.session)).data.user;
  assert.equal(me.username, 'ada');
  assert.equal(me.display_name, 'Ada Lovelace');
  assert.equal(me.role, 'admin');
  assert.equal(me.email, 'ada@example.com');
  const again = await signIn({ sub: 'u-ada', email: 'ada@example.com', email_verified: true });
  assert.equal((await api('GET', '/api/auth/me', again.session)).data.user.id, me.id, 'the same account every time');

  // Someone the admin had created before: linked by their verified email.
  const bob = suite.accounts.create({ username: 'bob', email: 'bob@example.com' });
  const bobIn = await signIn({ sub: 'u-bob', email: 'bob@example.com', email_verified: true, name: 'Bob' });
  assert.equal((await api('GET', '/api/auth/me', bobIn.session)).data.user.id, bob.id);
  assert.deepEqual(suite.accounts.identitiesOf(bob.id).map((i) => i.provider), [`oidc:${new URL(P).host}`]);

  // An unverified email takes nobody's account.
  const eve = await signIn({ sub: 'u-eve', email: 'bob@example.com', email_verified: false, preferred_username: 'eve' });
  const eveUser = (await api('GET', '/api/auth/me', eve.session)).data.user;
  assert.notEqual(eveUser.id, bob.id);
  assert.equal(eveUser.email, null);
  assert.equal(eveUser.username, 'eve');

  // ES256 tokens too; and an email only the userinfo endpoint gives.
  const dan = await signIn({ sub: 'u-dan', email: 'dan@example.com', email_verified: true }, { signing: { alg: 'ES256' } });
  assert.equal((await api('GET', '/api/auth/me', dan.session)).data.user.email, 'dan@example.com');
  const ivy = await signIn({ sub: 'u-ivy' });
  assert.equal((await api('GET', '/api/auth/me', ivy.session)).data.user.email, 'ivy@example.com');

  // Whatever doesn't add up, nobody gets in.
  for (const [what, options] of Object.entries({
    'another nonce': { override: { nonce: 'replayed' } },
    'another audience': { override: { aud: 'another-client' } },
    'another issuer': { override: { iss: 'https://evil.example' } },
    expired: { override: { exp: Math.floor(Date.now() / 1000) - 600 } },
    'a key it doesn’t publish': { signing: { key: stranger.privateKey } },
    'a state from elsewhere': { state: 'made-up' },
  })) {
    const attempt = await signIn({ sub: 'u-mal', email: 'mal@example.com', email_verified: true }, options);
    assert.equal(attempt.location, '/?auth_error=failed', what);
    assert.equal(attempt.session, null, what);
  }
  assert.equal(suite.accounts.byIdentity(`oidc:${new URL(P).host}`, 'u-mal'), null);

  // A disabled account stays out.
  suite.accounts.update(bob.id, { disabled: true });
  assert.equal((await signIn({ sub: 'u-bob', email: 'bob@example.com', email_verified: true })).location, '/?auth_error=disabled');
  suite.accounts.update(bob.id, { disabled: false });

  // Back where it started, but only within this app.
  assert.equal((await signIn({ sub: 'u-ada' }, { returnTo: '/oauth/authorize?x=1' })).location, '/oauth/authorize?x=1');
  assert.equal((await signIn({ sub: 'u-ada' }, { returnTo: 'https://evil.example/' })).location, '/');
  assert.equal((await signIn({ sub: 'u-ada' }, { returnTo: '//evil.example/' })).location, '/');

  // Signing out also closes the provider's session.
  const out = await api('POST', '/api/auth/logout', again.session);
  const logout = new URL(out.data.logout_url);
  assert.equal(logout.origin + logout.pathname, `${P}/logout`);
  assert.equal(logout.searchParams.get('client_id'), 'demo-client');
  assert.equal(logout.searchParams.get('post_logout_redirect_uri'), 'http://127.0.0.1/');

  // The built-in OAuth for the MCP: whoever isn't signed in is sent to the provider.
  const client = await (await fetch(`${base}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Client', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none' }),
  })).json();
  const query = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client.example/callback', state: 's1',
    code_challenge: crypto.createHash('sha256').update('v'.repeat(43)).digest('base64url'), code_challenge_method: 'S256',
    resource: 'http://127.0.0.1/mcp',
  });
  const consent = await (await fetch(`${base}/oauth/authorize?${query}`)).text();
  assert.match(consent, /Sign in with Authentik/);
  assert.match(consent, /href="\/auth\/login\?return=%2Foauth%2Fauthorize%3F/);
  assert.doesNotMatch(consent, /name="password"/, 'no password of its own');
  const signedIn = await (await fetch(`${base}/oauth/authorize?${query}`, { headers: { Cookie: ada.session } })).text();
  assert.match(signedIn, /@ada/, 'with a session, just the permission');
});

test('OIDC: a provider that doesn’t answer, and a configuration that is missing', async () => {
  const client = createOidcClient({ issuer: 'http://127.0.0.1:9', clientId: 'x' });
  await assert.rejects(client.authorizationUrl({ redirectUri: 'x', state: 's', challenge: 'c', nonce: 'n' }),
    (err) => err instanceof OidcUnavailable);
  assert.deepEqual(createOidcClient({ issuer: '', clientId: '' }).missingConfig(), ['OIDC_ISSUER', 'OIDC_CLIENT_ID']);
});
