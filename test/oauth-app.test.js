/**
 * The built-in OAuth for the MCP in an app made with createSuite() and createApp(), over real
 * HTTP: the whole dance a client like Claude does, with the app's sessions, accounts, texts and
 * switches. test/oauth.test.js holds the server on its own; this is what every app's smoke test
 * used to go through again (Tasks' section 16, Next's 11: audit tests-3), proved here once. An
 * app keeps only its own wiring: its colour, its texts, its tools and its Settings.
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
import { appTexts } from '../i18n.js';
import { freePort } from '../tools/test-kit.mjs';

const PRODUCT = { app: { id: 'demo', name: 'Demo', languages: ['en', 'es'] } };
const ADMIN = { username: 'ada', password: 'ada-password-1' };
const RETURN = 'https://claude.ai/api/mcp/auth_callback';

/** One tool that says whose token called it. */
const WHOAMI = {
  instructions: 'Says who you are.',
  tools: [{
    name: 'whoami', title: 'Who am I', description: 'Says who you are',
    inputSchema: { type: 'object', properties: {} },
    handler: (user) => ({ content: [{ type: 'text', text: `@${user.username}` }] }),
  }],
};

/** An app of the suite on a port of its own, BASE_URL at that port. `texts` dresses its screens. */
async function demoApp(t, { env = {}, texts = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-oauth-app-'));
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(path.join(publicDir, 'i18n'), { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!DOCTYPE html><title>Demo</title>');
  // The app's own sentence on the consent screen, over the suite's (as Tasks' and Next's say
  // what the assistant will do with the lists, the projects).
  fs.writeFileSync(path.join(publicDir, 'i18n', 'en.json'), JSON.stringify({ oauth: { wants: '{client} wants to use your notes.' } }));
  fs.writeFileSync(path.join(publicDir, 'i18n', 'es.json'), JSON.stringify({ oauth: { wants: '{client} quiere usar tus notas.' } }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const quiet = () => {};
  const suite = createSuite({
    config: PRODUCT,
    hooks: texts ? { texts: texts(path.join(publicDir, 'i18n')) } : {},
    env: {
      DATA_DIR: dir, PORT: String(port), BASE_URL: base, SECURE_COOKIES: 'false',
      ADMIN_USER: ADMIN.username, ADMIN_PASSWORD: ADMIN.password, ...env,
    },
    log: quiet, exitOnError: false,
  });
  const app = createApp({ suite, publicDir, version: '1.0.0', handleSignals: false, log: quiet, mcp: WHOAMI });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(server.address().port, port);
  return { base, suite };
}

/* -------------------------------- helpers --------------------------------- */

const form = (data) => new URLSearchParams(Object.entries(data).filter(([, v]) => v != null)).toString();

/** What a client like Claude does, against one app. */
function claude(base) {
  const postForm = (route, data, headers = {}) => fetch(`${base}${route}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: form(data),
  });
  const register = (body) => fetch(`${base}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  /** A fresh authorization request: its PKCE verifier and its fields. */
  const request = (clientId, extra = {}) => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return {
      verifier,
      params: {
        response_type: 'code', client_id: clientId, redirect_uri: RETURN, state: 'xyz',
        code_challenge: challenge, code_challenge_method: 'S256', resource: `${base}/mcp`, ...extra,
      },
    };
  };
  const screen = async (params, headers = {}) => {
    const res = await fetch(`${base}/oauth/authorize?${form(params)}`, { redirect: 'manual', headers });
    return { status: res.status, headers: res.headers, html: await res.text() };
  };
  /** Signing in on the consent screen and saying yes: → { res, code, cookie }. */
  const allow = async (params) => {
    const res = await postForm('/oauth/authorize', { ...params, ...ADMIN, decision: 'allow' });
    const location = res.headers.get('location');
    const code = location ? new URL(location).searchParams.get('code') : null;
    const cookie = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('demo_sid='))?.split(';')[0] || null;
    return { res, code, cookie };
  };
  const exchange = (code, { params, verifier }, headers = {}, extra = {}) => postForm('/oauth/token', {
    grant_type: 'authorization_code', code, redirect_uri: params.redirect_uri, client_id: params.client_id,
    code_verifier: verifier, ...extra,
  }, headers);
  const refresh = (refreshToken, clientId) => postForm('/oauth/token',
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  /** The MCP with a token: → { status, text }. */
  const mcp = async (token) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* not JSON */ }
    return { status: res.status, text: json?.result?.content?.[0]?.text ?? raw, headers: res.headers };
  };
  return { postForm, register, request, screen, allow, exchange, refresh, mcp };
}

/** A public client registered as Claude registers one. */
async function publicClient(c) {
  const res = await c.register({
    client_name: 'Claude', redirect_uris: [RETURN], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
  });
  return { status: res.status, client: await res.json() };
}

/* --------------------------------- tests ---------------------------------- */

test('registration: a public client, a confidential one with its secret, and never a javascript: return address', async (t) => {
  const { base } = await demoApp(t);
  const c = claude(base);

  const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none', 'client_secret_post', 'client_secret_basic']);

  const { status, client } = await publicClient(c);
  assert.equal(status, 201);
  assert.match(client.client_id, /^oc_/);
  assert.equal(client.client_secret, undefined, 'a public client has no secret');
  for (const address of ['javascript:alert(1)', 'data:text/html,hi', 'http://example.com/cb']) {
    const refused = await c.register({ redirect_uris: [address], token_endpoint_auth_method: 'none' });
    assert.equal(refused.status, 400, address);
    assert.equal((await refused.json()).error, 'invalid_redirect_uri', address);
  }

  const confidential = await (await c.register({
    client_name: 'Server', redirect_uris: [RETURN], token_endpoint_auth_method: 'client_secret_post',
  })).json();
  assert.match(confidential.client_secret, /^ocs_/, 'a confidential client gets its secret, once');
  const asked = c.request(confidential.client_id);
  const { code } = await c.allow(asked.params);
  assert.ok(code);
  const noSecret = await c.exchange(code, asked);
  assert.equal(noSecret.status, 401);
  assert.equal((await noSecret.json()).error, 'invalid_client');
  const wrongSecret = await c.exchange(code, asked, {}, { client_secret: 'ocs_wrong' });
  assert.equal(wrongSecret.status, 401, 'nor with another secret');
  const basic = Buffer.from(`${confidential.client_id}:${confidential.client_secret}`).toString('base64');
  const withSecret = await c.exchange(code, { ...asked, params: { ...asked.params, client_id: undefined } },
    { Authorization: `Basic ${basic}` });
  assert.equal(withSecret.status, 200, 'with it, over Basic: tokens');
  assert.equal((await c.mcp((await withSecret.json()).access_token)).text, '@ada');
});

test('the consent screen: who asks and where it goes back, that the name is unverified, the app’s texts in the right language, framed by nobody', async (t) => {
  // The app's catalogs (appTexts), with Spanish as the installation's default (DEFAULT_LANGUAGE).
  const { base } = await demoApp(t, { texts: (dir) => appTexts(dir, { defaultLanguage: 'es' }).textsFor });
  const c = claude(base);
  const { client } = await publicClient(c);
  const { params } = c.request(client.client_id);

  const english = await c.screen(params, { 'Accept-Language': 'en-US,en;q=0.9' });
  assert.equal(english.status, 200);
  assert.match(english.html, /<html lang="en"/);
  assert.match(english.html, /Connect to Demo/);
  assert.match(english.html, /<strong>Claude<\/strong> wants to use your notes\./, 'who asks, in the app’s own sentence');
  assert.match(english.html, /go back to <strong>claude\.ai<\/strong>/, 'and where it goes back to');
  assert.match(english.html, /That name was given by the application itself/, 'a registered name is not verified');
  assert.match(english.html, /name="password"/, 'not signed in: the username and the password');
  const csp = english.headers.get('content-security-policy') || '';
  assert.match(csp, /form-action 'self' https:\/\/claude\.ai(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/, 'it cannot be framed');
  // With no-referrer the browser sent Origin: null on "Allow", taken for another site (Tasks, 29/09).
  assert.match(english.html, /<meta name="referrer" content="same-origin">/);
  assert.doesNotMatch(english.html, /no-referrer/);

  const spanish = await c.screen(params, { 'Accept-Language': 'es-ES,es;q=0.9' });
  assert.match(spanish.html, /<html lang="es"/);
  assert.match(spanish.html, /Conectar con Demo/);
  assert.match(spanish.html, /<strong>Claude<\/strong> quiere usar tus notas\./, 'the browser’s language, with the app’s sentence');
  const unknown = await c.screen(params, { 'Accept-Language': 'pt-BR' });
  assert.match(unknown.html, /<html lang="es"/, 'a language it doesn’t have: the installation’s default');
  assert.match(unknown.html, /quiere usar tus notas/);

  const foreign = await c.screen({ ...params, redirect_uri: 'https://bad.example/cb' }, { 'Accept-Language': 'en' });
  assert.equal(foreign.status, 400, 'an unregistered return address stays on screen');
  assert.equal(foreign.headers.get('location'), null);
  assert.match(foreign.html, /The return address is not registered for this application\./);
  assert.doesNotMatch(foreign.html, /bad\.example/);
});

test('allowing: the browser session opens on the way; one code, one exchange, and a second takes back what the first gave', async (t) => {
  const { base } = await demoApp(t);
  const c = claude(base);
  const { client } = await publicClient(c);

  const noToken = await c.mcp(null);
  assert.equal(noToken.status, 401);
  assert.equal(noToken.headers.get('www-authenticate'), `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);

  const first = c.request(client.client_id);
  const { res, code, cookie } = await c.allow(first.params);
  const back = new URL(res.headers.get('location'));
  assert.equal(res.status, 302);
  assert.equal(back.origin + back.pathname, RETURN);
  assert.equal(back.searchParams.get('state'), 'xyz');
  assert.equal(back.searchParams.get('iss'), base, 'who issues it (RFC 9207)');
  assert.ok(cookie, 'the app’s own session cookie');
  const me = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).json();
  assert.equal(me.user.username, 'ada', 'and it is a session of the app');

  const tokens = await (await c.exchange(code, first, {}, { resource: `${base}/mcp` })).json();
  assert.match(tokens.access_token, /^mcpat_/);
  assert.match(tokens.refresh_token, /^mcprt_/);
  assert.equal(tokens.expires_in, 3600, 'an access token lasts an hour');
  assert.deepEqual(await c.mcp(tokens.access_token).then(({ status, text }) => ({ status, text })), { status: 200, text: '@ada' });

  const again = await c.exchange(code, first);
  assert.equal(again.status, 400, 'the same code twice gets nothing');
  assert.equal((await again.json()).error, 'invalid_grant');
  assert.equal((await c.mcp(tokens.access_token)).status, 401, 'and what came out of it the first time is gone');

  // Refreshing: a new pair; the old access token stops; a refresh token used again takes the grant down.
  const second = c.request(client.client_id);
  const pair = await (await c.exchange((await c.allow(second.params)).code, second)).json();
  const renewed = await (await c.refresh(pair.refresh_token, client.client_id)).json();
  assert.notEqual(renewed.refresh_token, pair.refresh_token);
  assert.equal((await c.mcp(pair.access_token)).status, 401);
  assert.equal((await c.mcp(renewed.access_token)).status, 200, 'the new one works');
  const reused = await c.refresh(pair.refresh_token, client.client_id);
  assert.equal(reused.status, 400);
  assert.equal((await reused.json()).error, 'invalid_grant');
  assert.equal((await c.mcp(renewed.access_token)).status, 401, 'the whole grant went with it');
});

test('signed in: just the permission, only from the screen that asked (CSRF), even when the browser sends Origin: null', async (t) => {
  const { base } = await demoApp(t);
  const c = claude(base);
  const { client } = await publicClient(c);
  const { cookie } = await c.allow(c.request(client.client_id).params);

  const asked = c.request(client.client_id);
  const withSession = await c.screen(asked.params, { Cookie: cookie });
  assert.doesNotMatch(withSession.html, /name="password"/, 'no password again');
  assert.match(withSession.html, /Signed in as <strong>@ada<\/strong>/);
  const csrf = /name="csrf" value="([^"]+)"/.exec(withSession.html)?.[1];
  assert.ok(csrf);

  const sameSite = { Cookie: cookie, Origin: base };
  const noCsrf = await c.postForm('/oauth/authorize', { ...asked.params, decision: 'allow' }, sameSite);
  assert.equal(noCsrf.status, 400, 'without the screen’s CSRF nothing is granted');
  assert.equal(noCsrf.headers.get('location'), null);
  assert.match(await noCsrf.text(), /The request has expired/);
  const otherCsrf = await c.postForm('/oauth/authorize', { ...c.request(client.client_id).params, decision: 'allow', csrf }, sameSite);
  assert.equal(otherCsrf.status, 400, 'nor with the CSRF of another request');
  const withCsrf = await c.postForm('/oauth/authorize', { ...asked.params, decision: 'allow', csrf }, sameSite);
  assert.equal(withCsrf.status, 302);
  const code = new URL(withCsrf.headers.get('location')).searchParams.get('code');
  assert.equal((await c.mcp((await (await c.exchange(code, asked)).json()).access_token)).text, '@ada');

  // Origin: null from its own screen: the browser's Sec-Fetch-Site says it is ours (0.24.1).
  const nullOrigin = (site) => c.postForm('/oauth/authorize', { ...asked.params, decision: 'cancel' },
    { Cookie: cookie, Origin: 'null', 'Sec-Fetch-Site': site });
  const ours = await nullOrigin('same-origin');
  assert.equal(ours.status, 302, 'the answer arrives');
  assert.equal(new URL(ours.headers.get('location')).searchParams.get('error'), 'access_denied');
  assert.equal((await nullOrigin('cross-site')).status, 403, 'from another site it does not');
});

test('CIMD: a client known by its document, the loopback port not counting; impostors and private addresses refused, never fetched', async (t) => {
  // A client metadata document served on this machine, like the one claude.ai publishes.
  let fetched = 0;
  const cards = http.createServer((req, res) => {
    fetched++;
    const card = served[req.url];
    res.writeHead(card ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(card || {}));
  });
  await new Promise((resolve) => cards.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => cards.close(resolve)));
  const CARDS = `http://127.0.0.1:${cards.address().port}`;
  const served = {
    '/claude.json': {
      client_id: `${CARDS}/claude.json`, client_name: 'Claude Code',
      redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'], token_endpoint_auth_method: 'none',
    },
    '/impostor.json': { client_id: 'https://claude.ai/oauth/other', client_name: 'Claude', redirect_uris: ['https://bad.example/cb'] },
  };

  // Documents on local hosts are read only when the install says so (tests).
  const { base } = await demoApp(t, { env: { CIMD_ALLOW_PRIVATE_HOSTS: 'true' } });
  const c = claude(base);
  const cimd = c.request(`${CARDS}/claude.json`, { redirect_uri: 'http://localhost:51234/callback' });
  const screen = await c.screen(cimd.params);
  assert.equal(screen.status, 200, screen.html.slice(0, 300));
  assert.match(screen.html, /<strong>Claude Code<\/strong> \(127\.0\.0\.1\)/, 'its name, with the host it comes from');
  assert.doesNotMatch(screen.html, /given by the application itself/, 'a name from its own address is not flagged');
  assert.match(screen.html, /a program on this same computer/, 'on loopback any port, with a warning');
  const { code } = await c.allow(cimd.params);
  const tokens = await (await c.exchange(code, cimd)).json();
  assert.equal((await c.mcp(tokens.access_token)).text, '@ada', 'its code redeemed with no registration');
  const impostor = await c.screen(c.request(`${CARDS}/impostor.json`).params);
  assert.equal(impostor.status, 400);
  assert.match(impostor.html, /The application’s details don’t match its identifier\./);

  // As installs run: no peeking into the local network on behalf of a made-up client_id.
  const strict = claude((await demoApp(t)).base);
  const before = fetched;
  const port = cards.address().port;
  for (const [clientId, says] of [
    [`https://localhost:${port}/claude.json`, /The application’s details are not at a public address\./],
    [`https://127.0.0.1:${port}/claude.json`, /The application’s details can’t be at an IP address\./],
    [`${CARDS}/claude.json`, /This application is not registered here\./],
  ]) {
    const refused = await strict.screen(strict.request(clientId).params);
    assert.equal(refused.status, 400, clientId);
    assert.match(refused.html, says, clientId);
  }
  assert.equal(fetched, before, 'none of the three is ever requested');
});

test('MCP_OAUTH=off: no metadata, no OAuth in the 401 and no OAuth routes', async (t) => {
  const { base, suite } = await demoApp(t, { env: { MCP_OAUTH: 'off' } });
  assert.equal(suite.oauth.enabled, false);
  for (const pathname of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server']) {
    assert.equal((await fetch(`${base}${pathname}`)).status, 404, pathname);
  }
  assert.equal((await claude(base).register({ redirect_uris: [RETURN] })).status, 404, 'nobody registers');
  const challenge = (await claude(base).mcp(null)).headers.get('www-authenticate') || '';
  assert.match(challenge, /^Bearer /);
  assert.doesNotMatch(challenge, /resource_metadata/, 'nor is OAuth offered in the 401');
});
