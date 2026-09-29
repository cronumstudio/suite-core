/**
 * An app on the suite: the configuration checked as a whole, and a small app
 * made with createSuite() and createApp(), used over real HTTP.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../config.js';
import { createSuite, createApp, SuiteConfigError } from '../app.js';

const PRODUCT = {
  app: { id: 'demo', name: 'Demo', port: 3999, languages: ['en', 'es'] },
  accounts: { minPasswordLength: 8 },
  features: { 'notes.max': { type: 'limit', default: null, label: 'more notes' } },
};

test('the configuration: defaults, the environment, and every mistake named', () => {
  const plain = resolveConfig(PRODUCT, { DATA_DIR: '/data' });
  assert.deepEqual(plain.errors, []);
  assert.equal(plain.install.baseUrl, 'http://localhost:3999');
  assert.equal(plain.install.dbPath, path.join('/data', 'demo.db'));
  assert.equal(plain.sessions.cookieName, 'demo_sid');
  assert.equal(plain.tokens.prefix, 'mcp_');
  assert.equal(plain.install.trustProxy, 'false', 'no proxy is trusted unless someone says so');
  assert.equal(plain.install.secureCookies, false);
  assert.equal(plain.install.mcpOAuth, true);
  assert.deepEqual(plain.modules, { oauth: true, mcp: true, admin: true, organizations: false, billing: false, live: false, push: false, uploads: false });

  const hosted = resolveConfig({ ...PRODUCT, trustProxy: true }, {
    BASE_URL: 'https://demo.example/', PORT: '8080', AUTH_PROVIDER: 'workos',
    WORKOS_API_KEY: 'sk', WORKOS_CLIENT_ID: 'client', WORKOS_AUTHKIT_DOMAIN: 'auth.example', RECARGA_EN_CALIENTE: 'true',
  });
  assert.deepEqual(hosted.errors, []);
  assert.equal(hosted.install.baseUrl, 'https://demo.example');
  assert.equal(hosted.install.port, 8080);
  assert.equal(hosted.install.secureCookies, true, 'HTTPS means secure cookies');
  assert.equal(hosted.install.trustProxy, 'true', 'the product’s default when TRUST_PROXY is unset');
  assert.equal(hosted.install.mcpOAuth, false, 'with WorkOS, AuthKit is the authorization server');
  assert.equal(hosted.install.hotReload, true);
  assert.deepEqual(hosted.warnings, ['RECARGA_EN_CALIENTE is the old name of HOT_RELOAD: rename it']);

  const wrong = resolveConfig({
    app: { id: 'Demo App', languages: ['es', 'xx'] }, modules: { organisations: true, mcp: 'yes' },
    accounts: { signup: 'public', minPasswordLength: 4 }, sessions: { cookieName: 'Demo SID' }, plan: {},
  }, { AUTH_PROVIDER: 'workos', BILLING_PROVIDER: 'stripe', PORT: 'eighty' });
  const said = wrong.errors.join('\n');
  for (const piece of ['"plan" is not a setting', 'app.id', 'xx not among', 'English goes first',
    'modules.organisations is not a module', 'modules.mcp must be true or false', 'accounts.signup "public": use admin, invite or open',
    'minPasswordLength', 'sessions.cookieName', 'PORT "eighty"', 'these are missing: WORKOS_API_KEY',
    'BILLING_PROVIDER is set, but this app has modules.billing off']) {
    assert.ok(said.includes(piece), `names: ${piece}\n${said}`);
  }
  const unknownProvider = resolveConfig(PRODUCT, { AUTH_PROVIDER: 'ldap' });
  assert.equal(unknownProvider.install.authProvider, 'local');
  assert.match(unknownProvider.warnings[0], /AUTH_PROVIDER="ldap" is not known/);
  const billing = resolveConfig({ ...PRODUCT, modules: { billing: true } }, { BILLING_PROVIDER: 'remote', BILLING_SECRET: 'short' });
  assert.match(billing.errors.join(), /BILLING_SECRET/);
});

test('the first administrator never gets a password from an example', (t) => {
  for (const example of ['change-this-password', 'cambia-esta-clave']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-admin-'));
    const lines = [];
    const suite = createSuite({
      config: PRODUCT, env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: example, BASE_URL: 'http://127.0.0.1' },
      log: (line) => lines.push(line), exitOnError: false,
    });
    t.after(() => { suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    suite.ensureAdmin();
    assert.ok(lines.some((l) => l.includes('ADMIN_PASSWORD holds an example value')), example);
    assert.equal(suite.accounts.verify('admin', example), null, `${example} does not open the account`);
    assert.ok(lines.some((l) => l.includes('a random password was')), 'a random one is printed instead');
  }
});

test('a configuration that can’t run doesn’t start, and says why', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-app-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const quiet = { log: () => {}, exitOnError: false };
  assert.throws(() => createSuite({ config: { app: { id: 'x' } }, env: { DATA_DIR: dir }, ...quiet }),
    (err) => err instanceof SuiteConfigError && err.errors.some((e) => e.includes('app.id')));
  assert.throws(() => createSuite({
    config: PRODUCT, env: { DATA_DIR: dir, PLANS: '{"free": {"name": "Free", "note.max": 1}}' }, ...quiet,
  }), (err) => err instanceof SuiteConfigError && /PLANS/.test(err.message) && /note\.max/.test(err.message));
});

test('an app made of the suite: sign-in, profile, admin, its own routes, MCP, static files', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-app-'));
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!DOCTYPE html><title>Demo</title>');
  fs.mkdirSync(path.join(publicDir, 'i18n'));
  fs.writeFileSync(path.join(publicDir, 'i18n', 'en.json'), JSON.stringify({ errors: { not_found: 'Gone.' }, notes: { title: 'Notes' } }));
  const lines = [];
  const suite = createSuite({
    config: PRODUCT,
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1' },
    migrations: [{ version: 1, name: 'notes', up: (d) => d.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT)') }],
    log: (line) => lines.push(line), exitOnError: false,
  });
  const app = createApp({
    suite, publicDir, version: '1.2.3', handleSignals: false, log: (line) => lines.push(line),
    routes: (api) => {
      api.get('/api/notes', (ctx) => {
        if (!ctx.user) throw Object.assign(new Error('no'), { status: 401 });
        ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
        ctx.res.end(JSON.stringify(suite.database.all('SELECT text FROM notes WHERE user_id = ?', ctx.user.id)));
      });
      api.post('/api/me/password', () => {});   // the suite's answers first: this never runs
    },
    mcp: {
      instructions: 'Keep notes.',
      tools: [{
        name: 'add_note', title: 'Add a note', description: 'Adds a note',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        handler: (user, args) => {
          suite.database.run('INSERT INTO notes (user_id, text) VALUES (?, ?)', user.id, args.text);
          return { content: [{ type: 'text', text: 'Saved.' }] };
        },
      }],
    },
  });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.ok(lines.includes('[demo] admin user created: "admin"'));

  let cookie = '';
  const call = async (method, pathname, body, headers = {}) => {
    const res = await fetch(base + pathname, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('demo_sid='));
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, headers: res.headers };
  };

  // Health, version, security headers.
  const health = await call('GET', '/health');
  assert.equal(health.data.ok, true);
  assert.equal(health.data.version.app, '1.2.3');
  assert.ok(health.headers.get('content-security-policy'));
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.match((await call('GET', '/js/app-version.js')).data, /export const APP_NAME_VERSION = '1\.2\.3'/);

  // Signing in, with the brake and the log.
  assert.equal((await call('POST', '/api/auth/login', { username: 'admin', password: 'wrong' })).data.error, 'bad_credentials');
  const signedIn = await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  assert.equal(signedIn.data.user.username, 'admin');
  assert.equal(signedIn.data.user.password_hash, undefined);
  assert.equal((await call('GET', '/api/auth/me')).data.user.role, 'admin');
  assert.equal((await call('GET', '/api/auth/config')).data.provider, 'local');
  assert.equal((await call('POST', '/api/me/password', { current_password: 'nope', password: 'a-new-password' })).data.error,
    'wrong_password', 'the suite’s route answers, not the app’s one on the same path');

  // A write with the cookie from another site is refused.
  assert.equal((await call('POST', '/api/me/tokens', { name: 'x' }, { Origin: 'https://evil.example' })).data.error, 'cross_site_request');

  // The suite's routes, then the app's.
  const token = await call('POST', '/api/me/tokens', { name: 'Claude' });
  assert.equal(token.status, 201);
  assert.equal((await call('GET', '/api/me/entitlements')).data.unlimited, true);
  assert.equal((await call('GET', '/api/admin/users')).data.users.length, 1);
  assert.equal((await call('GET', '/api/orgs')).status, 404, 'organizations are off');
  assert.equal((await call('GET', '/api/notes')).status, 200);
  const wrongMethod = await call('PUT', '/api/me/tokens');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET, POST');
  assert.equal((await call('GET', '/api/nothing-here')).data.error, 'not_found');

  // The MCP endpoint, with an API token.
  const rpc = async (method, params) => (await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.data.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })).json();
  assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'demo');
  assert.equal((await rpc('tools/call', { name: 'add_note', arguments: { text: 'Buy bread' } })).result.content[0].text, 'Saved.');
  assert.deepEqual((await call('GET', '/api/notes')).data, [{ text: 'Buy bread' }]);
  const unauthenticated = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get('www-authenticate'), /resource_metadata=/, 'the built-in OAuth is offered');
  assert.equal((await call('GET', '/.well-known/oauth-authorization-server')).status, 200);

  // The catalogs: the suite's texts with the app's over them, in the app's shape.
  const catalog = await call('GET', '/i18n/en.json');
  assert.equal(catalog.data.errors.not_found, 'Gone.');
  assert.equal(catalog.data.errors.username_taken, 'That username is already taken.');
  assert.equal(catalog.data.notes.title, 'Notes');
  const again = await fetch(`${base}/i18n/en.json`, { headers: { 'If-None-Match': catalog.headers.get('etag') } });
  assert.equal(again.status, 304);
  assert.equal((await call('GET', '/i18n/es.json')).data['errors.not_found'], 'No encontrado.', 'no file of its own: the suite’s');
  assert.equal((await call('GET', '/i18n/fr.json')).status, 404, 'not a language of this app');

  // The suite's pages: the admin panel and the web kit it is made of.
  const panel = await call('GET', '/admin');
  assert.equal(panel.status, 200);
  assert.match(panel.headers.get('content-type'), /text\/html/);
  assert.match(panel.data, /<script type="module" src="\/suite\/admin\.js"><\/script>/);
  assert.doesNotMatch(panel.data.replace(/<script[^>]*src="[^"]+"[^>]*><\/script>/g, ''), /<script/,
    'no inline script: the CSP allows none');
  const kit = await fetch(`${base}/suite/admin.js`);
  assert.equal(kit.status, 200);
  assert.match(kit.headers.get('content-type'), /text\/javascript/);
  // fetch() would tidy "../" away before sending: a raw request keeps it.
  const escape = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/suite/..%2Fpackage.json' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(escape, 404, 'never outside the kit');
  assert.deepEqual((await call('GET', '/api/auth/config')).data.app,
    { id: 'demo', name: 'Demo', languages: ['en', 'es'], modules: { organizations: false, billing: false } });

  // Static files, the SPA's paths, and discovery paths that are not served.
  assert.match((await call('GET', '/')).data, /<title>Demo<\/title>/);
  assert.match((await call('GET', '/projects/12')).data, /<title>Demo<\/title>/);
  assert.equal((await call('GET', '/missing.png')).status, 404);
  assert.equal((await call('GET', '/.well-known/openid-configuration')).data.error, 'No OAuth here: use a Bearer token');

  // Signing out.
  assert.equal((await call('POST', '/api/auth/logout')).data.ok, true);
  assert.equal((await call('GET', '/api/auth/me')).data.user, null);
});
