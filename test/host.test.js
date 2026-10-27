/**
 * Several apps as one (host.js): two test modules (fixtures/host) with the same
 * routes, mounted at their own paths in one host, used over real HTTP; and
 * what a host refuses to run.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHost, joinHost, mountManifest, mountedPath, moduleSettings } from '../host.js';
import { SuiteConfigError } from '../app.js';

const HOST = {
  app: { id: 'work', name: 'Work', color: '#3A4660', icon: '/icons/work.svg', languages: ['en', 'es'] },
  modules: { live: true },
  accounts: { minPasswordLength: 8 },
};

const fixture = (name, query = '') => new URL(`./fixtures/host/${name}/module.js${query}`, import.meta.url);
let fresh = 0;
/** Each host gets its own copy of the test modules: their state is created when they are imported. */
const modules = () => {
  fresh += 1;
  return [
    { mount: 'alpha', entry: fixture('alpha', `?case=${fresh}`) },
    { mount: 'beta', entry: fixture('beta', `?case=${fresh}`) },
  ];
};

async function startHost(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-'));
  const lines = [];
  const host = await createHost({
    config: HOST, modules: modules(), env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1' },
    version: '9.9.9', handleSignals: false, exitOnError: false, log: (line) => lines.push(line), ...options,
  });
  const server = await host.listen();
  t.after(async () => {
    await host.close();
    host.suite.database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, pathname, body, headers = {}) => {
    const res = await fetch(base + pathname, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('work_sid='));
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, headers: res.headers };
  };
  return { host, dir, lines, call };
}

test('a host serves each module at its own path, with one sign-in, one database and one admin panel', async (t) => {
  const { host, dir, lines, call } = await startHost(t);
  const [alpha, beta] = host.modules;
  assert.ok(lines.includes('[work] admin user created: "admin"'), 'one first administrator, the host’s');

  // Where each module is.
  const home = await call('GET', '/');
  assert.equal(home.status, 302, 'without pages of its own, the host opens on its first module');
  assert.equal(home.headers.get('location'), '/alpha/');
  assert.equal((await call('GET', '/alpha?x=1')).headers.get('location'), '/alpha/?x=1', 'a module’s path ends in a slash');
  assert.match((await call('GET', '/alpha/')).data, /<title>Alpha<\/title>/);
  assert.match((await call('GET', '/beta/')).data, /<title>Beta<\/title>/);
  assert.match((await call('GET', '/beta/some/view')).data, /<title>Beta<\/title>/, 'its own paths fall back to its page');
  assert.equal((await call('GET', '/alpha/js/main.js')).data.trim(), "export const where = 'alpha';");
  assert.equal((await call('GET', '/gamma/')).status, 404, 'no module there');
  const security = await call('GET', '/alpha/');
  assert.ok(security.headers.get('content-security-policy'), 'a module’s answers carry the security headers');
  // A module's page names the code it starts with, and what it asks first (page-hints.js).
  assert.match(security.headers.get('link'), /^<\/alpha\/js\/main\.js>; rel=modulepreload, .*<\/alpha\/api\/auth\/config>; rel=preload; as=fetch; crossorigin/);
  assert.equal((await call('GET', '/alpha/index.html')).headers.get('link'), security.headers.get('link'));
  assert.equal((await call('GET', '/beta/')).headers.get('link'), null, 'a page without code names nothing');
  assert.equal((await call('GET', '/alpha/js/main.js')).headers.get('link'), null, 'only the page');
  assert.doesNotMatch(security.headers.get('link'), /auth\/me|\/api\/modules/, 'signed out: no one’s answers');

  // One sign-in for every module: the host's cookie.
  assert.equal((await call('GET', '/alpha/api/items')).status, 401);
  const signedIn = await call('POST', '/alpha/api/auth/login', { username: 'admin', password: 'root-password' });
  assert.equal(signedIn.data.user.username, 'admin');
  assert.equal((await call('GET', '/beta/api/auth/me')).data.user.username, 'admin', 'signed in for beta too');
  assert.match((await call('GET', '/alpha/')).headers.get('link'), /<\/alpha\/api\/auth\/me>; rel=preload; as=fetch; crossorigin/,
    'signed in: who the person is, with the page');
  assert.equal((await call('GET', '/api/auth/me')).data.user.username, 'admin', 'and at the root');
  assert.equal((await call('GET', '/alpha/api/auth/config')).data.app.id, 'alpha', 'each module says who it is');

  // The same routes in two modules, each on its own table.
  assert.equal((await call('POST', '/alpha/api/items', { text: 'Buy bread' })).status, 201);
  assert.deepEqual((await call('GET', '/alpha/api/items')).data, { module: 'alpha', items: ['Buy bread'] });
  assert.deepEqual((await call('GET', '/beta/api/items')).data, { module: 'beta', items: [] });
  assert.equal((await call('GET', '/api/items')).status, 404, 'a module’s routes aren’t the root’s');
  assert.equal((await call('POST', '/beta/api/items', { text: 'x' }, { Origin: 'https://evil.example' })).data.error,
    'cross_site_request', 'a write from another site is refused in a module too');
  const where = (await call('GET', '/alpha/api/where')).data;
  assert.equal(where.baseUrl, 'http://127.0.0.1/alpha', 'links a module writes point into it');
  assert.equal(where.install, 'http://127.0.0.1/alpha');
  assert.deepEqual(where.host, { id: 'work', name: 'Work', mount: 'alpha', base: '/alpha/', push: false, plans: false, billing: false });

  // What each module is, for the host's pages, and which ones this person uses: all until they choose.
  assert.deepEqual((await call('GET', '/api/modules')).data, {
    host: { name: 'Work', icon: '/icons/work.svg' },
    chosen: false,
    look: 'cronum',
    modules: [
      { mount: 'alpha', path: '/alpha/', id: 'alpha', name: 'Alpha', color: '#EF4B2A', icon: '/alpha/icons/alpha.svg?v=1', links: { item: { creates: true } },
        settings: { sections: [{ id: 'items', icon: 'notes', label: 'settings.items.title' }], data: false, ai: false, about: true }, active: true },
      { mount: 'beta', path: '/beta/', id: 'beta', name: 'Beta', color: '#7C3AED', icon: '/beta/icons/favicon.svg', links: { item: { creates: true } },
        settings: { sections: [], data: false, ai: false, about: false }, active: true },
    ],
  });
  assert.deepEqual((await call('GET', '/alpha/api/auth/config')).data.app.host, { id: 'work', name: 'Work', mount: 'alpha', base: '/alpha/', push: false, plans: false, billing: false },
    'a module tells the kit it is in a host');
  assert.equal((await call('GET', '/api/auth/config')).data.app.host, undefined, 'the host itself isn’t a module');
  assert.equal((await call('GET', '/alpha/api/auth/config')).data.app.modules.mcp, true,
    'a module offers the AI connector, the host’s /mcp, though it has none of its own');
  assert.equal((await call('GET', '/api/auth/config')).data.app.modules.mcp, true);
  assert.equal((await call('PUT', '/api/me/modules', { active: [] })).data.error, 'field_required', 'at least one');
  assert.equal((await call('PUT', '/api/me/modules', { active: ['beta', 'gamma'] })).data.field, 'modules', 'only modules there are');
  const chosen = await call('PUT', '/api/me/modules', { active: ['beta'] });
  assert.deepEqual([chosen.data.chosen, ...chosen.data.modules.map((m) => `${m.mount}:${m.active}`)], [true, 'alpha:false', 'beta:true']);
  assert.deepEqual((await call('GET', '/api/modules')).data.modules.map((m) => m.active), [false, true], 'kept');
  assert.equal((await call('GET', '/alpha/')).status, 200, 'a module turned off still opens: its data is there');
  await call('PUT', '/api/me/modules', { active: ['alpha', 'beta'] });

  // The look of every module, one choice for the whole host: the suite's own until they choose.
  assert.equal((await call('PUT', '/api/me/look', { look: 'pink' })).data.field, 'look', 'only the looks there are');
  assert.equal((await call('PUT', '/api/me/look', { look: 'clean' })).data.look, 'clean');
  assert.equal((await call('GET', '/api/modules')).data.look, 'clean', 'kept, for every device');
  assert.equal((await call('PUT', '/api/me/look', { look: 'cronum' })).data.look, 'cronum');
  assert.equal(host.suite.database.get('SELECT COUNT(*) AS n FROM host_looks').n, 1, 'one row a person');

  // Each module's own catalogs, version and kit, at its path.
  const catalog = await call('GET', '/alpha/i18n/en.json');
  assert.equal(catalog.data['alpha.title'], 'Alpha');
  assert.equal(catalog.data.errors?.username_taken ?? catalog.data['errors.username_taken'], 'That username is already taken.');
  assert.equal((await call('GET', '/alpha/i18n/es.json')).status, 200);
  assert.equal((await call('GET', '/beta/i18n/es.json')).status, 404, 'not a language of beta');
  assert.match((await call('GET', '/alpha/js/app-version.js')).data, /APP_NAME_VERSION = '1\.0\.0'/);
  assert.equal((await call('GET', '/beta/version')).data.app, '2.0.0');
  assert.equal((await call('GET', '/version')).data.app, '9.9.9', 'the host’s own at the root');
  assert.equal((await call('GET', '/health')).data.ok, true);
  assert.match((await call('GET', '/alpha/suite/base.js')).data, /export const BASE = baseOf\(import\.meta\.url\)/,
    'the kit at the module’s path: its base is the module’s');
  assert.equal((await call('GET', '/alpha/sw.js')).status, 200, 'the module’s service worker, scoped to its path');

  // Its manifest, at its place; the app's own file stays as it is.
  const manifest = await call('GET', '/alpha/manifest.webmanifest');
  assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/);
  assert.equal(manifest.data.id, '/alpha/');
  assert.equal(manifest.data.start_url, '/alpha/');
  assert.equal(manifest.data.scope, '/alpha/');
  assert.deepEqual(manifest.data.icons.map((i) => i.src), ['/alpha/icons/icon-192.png?v=1', 'icons/icon-512.png']);
  assert.equal(manifest.data.shortcuts[0].url, '/alpha/?new=1');
  const again = await call('GET', '/alpha/manifest.webmanifest', undefined, { 'If-None-Match': manifest.headers.get('etag') });
  assert.equal(again.status, 304);
  const betaManifest = (await call('GET', '/beta/manifest.webmanifest')).data;
  assert.equal(betaManifest.start_url, '/beta/?app');
  assert.equal(betaManifest.scope, '/beta/');
  assert.equal(betaManifest.id, undefined, 'without an id, its identity is its start');
  assert.equal(JSON.parse(fs.readFileSync(new URL('./fixtures/host/alpha/public/manifest.webmanifest', import.meta.url), 'utf8')).start_url, '/');

  // One admin panel, the host's.
  const moved = await call('GET', '/alpha/admin');
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.get('location'), '/admin');
  assert.match((await call('GET', '/admin')).data, /data-app="work"/);
  assert.equal((await call('GET', '/api/admin/users')).data.users.length, 1);

  // One database: the suite's tables once, each module's own, each module's migrations in its scope.
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.db')), ['work.db']);
  const { database } = host.suite;
  assert.deepEqual(database.all('SELECT DISTINCT scope FROM schema_migrations ORDER BY scope').map((r) => r.scope), ['alpha', 'beta', 'host', 'suite']);
  for (const table of ['alpha_items', 'beta_items', 'users', 'sessions']) assert.ok(database.columnsOf(table).length, table);

  // One table of accounts: a new one gets each module's columns and wakes each module's hooks.
  const alphaModule = await import(fixture('alpha', `?case=${fresh}`).href);
  const betaModule = await import(fixture('beta', `?case=${fresh}`).href);
  const created = await call('POST', '/api/admin/users', { username: 'ana', password: 'ana-password', display_name: 'Ana' });
  assert.equal(created.status, 201);
  const ana = database.get('SELECT * FROM users WHERE username = ?', 'ana');
  assert.equal(ana.alpha_badge, 'new', 'the module’s own column');
  assert.ok(alphaModule.events.created.includes(ana.id));
  // An account that changes tells the open tabs of every module; another notice stays in its module.
  const told = [];
  alpha.suite.live.publish = (event) => told.push(['alpha', event.event]);
  beta.suite.live.publish = (event) => told.push(['beta', event.event]);
  host.suite.accounts.changed(ana.id);
  assert.deepEqual(told.sort(), [['alpha', 'account'], ['beta', 'account']]);
  assert.notEqual(alpha.suite.live, beta.suite.live);
  assert.equal((await call('DELETE', `/api/admin/users/${ana.id}`)).status, 200);
  assert.ok(betaModule.events.removed.includes(ana.id));

  // A module's copies count its own migrations, which a host keeps under its id.
  const alphaData = alpha.suite.portabilityFor({ tables: { alpha_items: { refs: { user_id: 'users' } } } });
  assert.equal(alphaData.schemaVersions().app, 1);
  // Copies that carry organizations need the module in the host too: these modules don't use it.
  assert.throws(() => alpha.suite.portabilityFor({ tables: { alpha_items: { refs: { user_id: 'users' } } }, organizations: {} }),
    /organizations needs modules\.organizations/);

  // Each module's plan features; the plans are the install's.
  assert.ok('items.max' in alpha.suite.entitlements.of(null).features);
  assert.ok(!('items.max' in beta.suite.entitlements.of(null).features));

  // Its own folder of files: a module's sweep never sees another's.
  assert.equal(alpha.suite.uploads.dir, path.join(dir, 'uploads', 'alpha'));
  assert.equal(beta.suite.uploads.dir, path.join(dir, 'uploads', 'beta'));
  const old = Date.now() / 1000 - 3 * 24 * 3600;
  for (const [module, names] of [['alpha', ['kept.png', 'loose.png', 'also-kept.png']], ['beta', ['beta.png']]]) {
    fs.mkdirSync(path.join(dir, 'uploads', module, '1'), { recursive: true });
    for (const name of names) {
      const file = path.join(dir, 'uploads', module, '1', name);
      fs.writeFileSync(file, 'x');
      fs.utimesSync(file, old, old);
    }
  }
  assert.equal(alpha.suite.uploads.sweep(['1/kept.png', '1/also-kept.png']), 1);
  assert.ok(fs.existsSync(path.join(dir, 'uploads', 'beta', '1', 'beta.png')), 'beta’s file is not alpha’s orphan');

  // A module's own jobs start with the host and stop with it.
  assert.equal(alphaModule.events.started, 1);
  assert.equal(alphaModule.events.stopped, 0);
});

test('one MCP for every module: its tools with the module’s name, its plans, and only the modules someone uses', async (t) => {
  const { call } = await startHost(t);
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  const token = (await call('POST', '/api/me/tokens', { name: 'Claude' })).data.token;
  assert.equal((await call('GET', '/mcp-info')).data.endpoint, 'http://127.0.0.1/mcp', 'one endpoint, the host’s');
  let id = 0;
  const mcp = async (method, params = {}) => {
    id += 1;
    const res = await call('POST', '/mcp', { jsonrpc: '2.0', id, method, params }, { Authorization: `Bearer ${token}` });
    return res.data;
  };
  const init = (await mcp('initialize', { protocolVersion: '2025-06-18' })).result;
  assert.equal(init.serverInfo.name, 'work');
  assert.match(init.instructions, /^Work holds the user's Alpha and Beta in one place/);
  assert.match(init.instructions, /Alpha keeps items: alpha_add_item adds one, alpha_list_items lists them\./, 'a module’s brief, with the host’s names');
  assert.match(init.instructions, /Beta keeps other items\./);
  assert.doesNotMatch(init.instructions, /paragraph/, 'without a brief, the first paragraph only');
  assert.ok(init.instructions.length <= 2048);
  assert.match(init.instructions, /or with work_ for the ones that link things between modules/, 'the link tools’ prefix');

  const announced = (await mcp('tools/list')).result.tools;
  const listed = announced.map((tool) => tool.name);
  assert.deepEqual(listed, ['alpha_list_items', 'alpha_add_item', 'beta_list_items', 'work_linked_items', 'work_link_item']);
  const hints = Object.fromEntries(announced.map((tool) => [tool.name, tool.annotations]));
  assert.deepEqual(hints.alpha_list_items, { title: 'List items', readOnlyHint: true, openWorldHint: false },
    'a module’s tool keeps its hints under the host’s name');
  assert.equal(hints.alpha_add_item, undefined, 'and one without them announces none');
  assert.deepEqual(hints.work_linked_items, { title: 'What is linked with something', readOnlyHint: true, openWorldHint: false });
  assert.deepEqual(hints.work_link_item, {
    title: 'Link, or add to another module and link', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
  });
  const text = async (name, args = {}) => (await mcp('tools/call', { name, arguments: args })).result.content[0].text;
  assert.equal(await text('alpha_add_item', { text: 'From the AI' }), 'Added.');
  assert.equal(await text('alpha_list_items'), '["From the AI"]');
  assert.equal(await text('beta_list_items'), '[]', 'the same tool in another module, on its own table');
  assert.match(await text('add_item', { text: 'Bare name' }), /Unknown tool/, 'only the names tools/list announces, with the module’s');
  assert.match(await text('list_items'), /Unknown tool/);
  assert.equal(await text('alpha_add_item', { text: 'boom' }), 'That item cannot be added.', 'errors read as the module says');
  assert.deepEqual((await mcp('prompts/list')).result.prompts.map((p) => p.name), ['beta_setup']);
  assert.ok((await mcp('prompts/get', { name: 'beta_setup' })).result.messages.length);

  // Beta only: alpha leaves the list and the instructions, and its tools say how to bring it back.
  await call('PUT', '/api/me/modules', { active: ['beta'] });
  assert.deepEqual((await mcp('tools/list')).result.tools.map((tool) => tool.name), ['beta_list_items']);
  assert.match(await text('alpha_list_items'), /Alpha is turned off for this person: they can turn it on in Work, Settings › Modules\./);
  const only = (await mcp('initialize', { protocolVersion: '2025-06-18' })).result.instructions;
  assert.match(only, /^Work holds the user's Beta in one place/);
  assert.doesNotMatch(only, /Alpha keeps/);
  await call('PUT', '/api/me/modules', { active: ['alpha', 'beta'] });
  assert.equal((await call('GET', '/alpha/mcp')).status, 404, 'no MCP of its own inside a host: one for all, at the root');
});

/** A request as if it came to another address of the host (its Host header). */
function asDomain(server, domain, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: pathname,
      headers: { Host: domain, ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = text;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, data: parsed, text });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('the apps’ old addresses, for a while: their pages to the module, their connectors point at the host’s', async (t) => {
  const { host, call, lines } = await startHost(t, {
    env: {
      DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-')), PORT: '0', ADMIN_PASSWORD: 'root-password',
      BASE_URL: 'http://127.0.0.1', LEGACY_DOMAINS: 'alpha.example.test=alpha, Beta-Old.example.test=beta',
      // Gone (0.148.0): a host still given it starts as before.
      LEGACY_MCP: 'on',
    },
  });
  assert.ok(lines.some((line) => line.includes("also answering the apps' old addresses: alpha.example.test → /alpha/, beta-old.example.test → /beta/")));
  const old = (...args) => asDomain(host.server, ...args);

  // Pages go to the module, with their path and query; a write keeps its method.
  let res = await old('alpha.example.test', 'GET', '/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'http://127.0.0.1/alpha/');
  assert.equal(res.headers['cache-control'], 'no-store', 'temporary: nothing cached for good');
  assert.equal((await old('alpha.example.test:443', 'GET', '/lists/3?x=1')).headers.location, 'http://127.0.0.1/alpha/lists/3?x=1');
  assert.equal((await old('beta-old.example.test', 'GET', '/manifest.webmanifest')).headers.location, 'http://127.0.0.1/beta/manifest.webmanifest');
  res = await old('alpha.example.test', 'POST', '/api/items', { text: 'x' });
  assert.equal(res.status, 307);
  assert.equal(res.headers.location, 'http://127.0.0.1/alpha/api/items');

  // The installed app's service worker removes itself and opens the module here.
  res = await old('alpha.example.test', 'GET', '/sw.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.ok(res.text.includes('registration.unregister()'));
  assert.ok(res.text.includes('client.navigate("http://127.0.0.1/alpha/")'));

  // No connector of its own: /mcp names the host's, and no OAuth metadata names the old address.
  for (const pathname of ['/mcp', '/mcp/sse']) {
    res = await old('alpha.example.test', 'POST', pathname, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(res.status, 404, pathname);
    assert.deepEqual(res.data, { error: 'not_found', mcp: 'http://127.0.0.1/mcp' }, 'it names the host’s connector');
    assert.equal(res.headers['www-authenticate'], undefined, 'with no challenge');
  }
  for (const pathname of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server']) {
    assert.equal((await old('alpha.example.test', 'GET', pathname)).status, 404, pathname);
  }

  // The host's own address is as before.
  assert.equal((await call('GET', '/alpha/mcp')).status, 404);
  assert.equal((await call('GET', '/health')).status, 200);
});

test('LEGACY_DOMAINS that can’t be right stop the start, and say why', async () => {
  const reasons = async (value, more = {}) => {
    try {
      await createHost({
        config: HOST, modules: modules(), handleSignals: false, exitOnError: false, log: () => {},
        env: {
          DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-')), PORT: '0', ADMIN_PASSWORD: 'root-password',
          BASE_URL: 'https://work.example.test', LEGACY_DOMAINS: value, ...more,
        },
      });
    } catch (error) {
      assert.ok(error instanceof SuiteConfigError, String(error));
      return error.errors.join(' | ');
    }
    return assert.fail(`${value} started`);
  };
  assert.match(await reasons('gamma.example.test=gamma'), /names "gamma", which is not a module of this host \(alpha, beta\)/);
  assert.match(await reasons('alpha.example.test'), /entry 1 is not domain=module/);
  assert.match(await reasons('alpha.example.test:8080=alpha'), /entry 1 is not a domain name/);
  assert.match(await reasons('work.example.test=alpha'), /the host's own address/);
  assert.match(await reasons('a.example.test=alpha,A.example.test=beta'), /a\.example\.test is given twice/);
});

test('a host with its MCP off: neither it nor its modules offer an AI connector', async (t) => {
  const { call } = await startHost(t, { config: { ...HOST, modules: { ...HOST.modules, mcp: false } } });
  assert.equal((await call('GET', '/api/auth/config')).data.app.modules.mcp, false);
  for (const mount of ['alpha', 'beta']) {
    assert.equal((await call('GET', `/${mount}/api/auth/config`)).data.app.modules.mcp, false, mount);
  }
  assert.equal((await call('GET', '/mcp-info')).status, 404, 'no MCP at the root');
  const endpoint = await call('POST', '/mcp', {});
  assert.equal(endpoint.status, 404, 'its address answers a JSON 404');
  assert.deepEqual(endpoint.data, { error: 'not_found' });
  assert.equal(endpoint.headers.get('www-authenticate'), null, 'with no challenge');
});

test('a host whose modules bring no tools: its MCP on, but no /mcp, so none of them offers a connector', async (t) => {
  fresh += 1;
  const { call } = await startHost(t, {
    modules: [{ mount: 'one', entry: fixture('plain', `?id=one&n=${fresh}`) }, { mount: 'two', entry: fixture('plain', `?id=two&n=${fresh}`) }],
  });
  assert.equal((await call('GET', '/api/auth/config')).data.app.modules.mcp, false, 'the root has no /mcp to offer');
  for (const mount of ['one', 'two']) {
    assert.equal((await call('GET', `/${mount}/api/auth/config`)).data.app.modules.mcp, false,
      `${mount}: the host's /mcp isn't there, so its Settings has no AI section`);
  }
  assert.equal((await call('GET', '/mcp-info')).status, 404, 'indeed no MCP at the root');
});

test('links between modules: each sees what they could see, created where it lives, done together, live', async (t) => {
  const { host, call } = await startHost(t);
  const [alpha, beta] = host.modules;
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  await call('POST', '/alpha/api/items', { text: 'Write the proposal' });
  await call('POST', '/beta/api/items', { text: 'Review it' });
  await call('POST', '/beta/api/items', { text: 'Unrelated' });

  // Linking what exists, once per pair, whichever way it is made.
  const made = await call('POST', '/api/links', { from: 'alpha:item:1', to: 'beta:item:1' });
  assert.equal(made.status, 201);
  assert.deepEqual(made.data.link.item, {
    ref: 'beta:item:1', module: 'beta', type: 'item', app: 'Beta', color: '#7C3AED',
    title: 'Review it', state: 'open', where: 'Items', url: '/beta/?item=1',
  });
  assert.equal((await call('POST', '/api/links', { from: 'beta:item:1', to: 'alpha:item:1' })).data.link.id, made.data.link.id, 'the same pair, once');
  assert.equal((await call('GET', '/api/links?ref=beta:item:1')).data.links[0].item.title, 'Write the proposal', 'seen from both sides');
  assert.equal((await call('POST', '/api/links', { from: 'alpha:item:1', to: 'gamma:item:1' })).data.error, 'field_invalid');

  // Creating it in the other module, by that module, and linked with "done together".
  const added = await call('POST', '/api/links/new', { from: 'alpha:item:1', module: 'beta', type: 'item', together: true });
  assert.equal(added.status, 201);
  assert.equal(added.data.link.item.title, 'Write the proposal', 'by default, the title it comes from');
  assert.equal(added.data.link.together, true);
  const found = await call('GET', '/api/links/search?module=beta&type=item&q=Rev');
  assert.deepEqual(found.data.items.map((i) => i.title), ['Review it']);
  assert.deepEqual(found.data.places, [{ id: 'inbox', name: 'Inbox' }]);

  // Done together: completing one side completes the other in the same transaction; a plain link only shows it.
  const told = [];
  const publish = beta.suite.live.publish;
  beta.suite.live.publish = (event) => { told.push(event); return publish(event); };
  await call('POST', '/alpha/api/items/1/done');
  const betaRows = host.suite.database.all('SELECT id, text, done FROM beta_items ORDER BY id');
  assert.deepEqual(betaRows.map((r) => [r.text, r.done]), [['Review it', 0], ['Unrelated', 0], ['Write the proposal', 1]]);
  assert.ok(told.some((e) => e.event === 'links' && e.data.ref === 'beta:item:1'), 'beta’s open tabs repaint the link');
  assert.equal((await call('GET', '/api/links?ref=beta:item:3')).data.links[0].item.state, 'done');

  // Someone else sees only what they could already see.
  await call('POST', '/api/admin/users', { username: 'ana', password: 'ana-password', display_name: 'Ana' });
  let anaCookie = '';
  const asAna = async (method, pathname, body) => {
    const res = await fetch(`http://127.0.0.1:${host.server.address().port}${pathname}`, {
      method, headers: { 'Content-Type': 'application/json', ...(anaCookie ? { Cookie: anaCookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('work_sid='));
    if (set) anaCookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  await asAna('POST', '/api/auth/login', { username: 'ana', password: 'ana-password' });
  assert.equal((await asAna('GET', '/api/links?ref=alpha:item:1')).status, 404, 'not hers: not even that it is there');
  await asAna('POST', '/beta/api/items', { text: 'Ana’s' });
  assert.equal((await asAna('POST', '/api/links', { from: 'beta:item:4', to: 'alpha:item:1' })).status, 404, 'nor link to it');
  assert.deepEqual((await asAna('GET', '/api/links/search?module=alpha&type=item&q=')).data.items, []);

  // Deleted: shown as such, with its last title to whoever linked it.
  await call('DELETE', '/beta/api/items/1');
  const gone = (await call('GET', '/api/links?ref=alpha:item:1')).data.links.find((l) => l.item.ref === 'beta:item:1');
  assert.deepEqual([gone.item.state, gone.item.title], ['gone', 'Review it']);
  assert.equal((await call('DELETE', `/api/links/${gone.id}`)).status, 200);
  assert.equal((await call('GET', '/api/links?ref=alpha:item:1')).data.links.length, 1);

  // A module turned off: its links hide, and nothing is created there.
  await call('PUT', '/api/me/modules', { active: ['alpha'] });
  assert.deepEqual((await call('GET', '/api/links?ref=alpha:item:1')).data.links, []);
  assert.equal((await call('POST', '/api/links/new', { from: 'alpha:item:1', module: 'beta', type: 'item' })).data.error, 'module_off');
  await call('PUT', '/api/me/modules', { active: ['alpha', 'beta'] });
  assert.equal((await call('GET', '/api/links?ref=alpha:item:1')).data.links.length, 1, 'and they come back');

  // The same from an assistant, through the host's own tools.
  const token = (await call('POST', '/api/me/tokens', { name: 'Claude' })).data.token;
  let id = 0;
  const tool = async (name, args) => (await call('POST', '/mcp', { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } },
    { Authorization: `Bearer ${token}` })).data.result.content[0].text;
  assert.match(await tool('work_linked_items', { item: { module: 'alpha', type: 'item', id: '1' } }), /Beta item beta:item:3: "Write the proposal" \(done\) in Items \[done together\]/);
  assert.match(await tool('work_link_item', { from: { module: 'alpha', type: 'item', id: '1' }, create: { module: 'beta', type: 'item', title: 'From Claude' } }),
    /^Linked: Beta item beta:item:5: "From Claude" \(open\)/);
  const listed = (await call('POST', '/mcp', { jsonrpc: '2.0', id: ++id, method: 'tools/list' }, { Authorization: `Bearer ${token}` })).data.result.tools;
  assert.ok(listed.some((x) => x.name === 'work_link_item' && /Kinds: alpha: item; beta: item/.test(x.description)));

  // A side its module won't complete stays as it was, all of it; the one completed here still is.
  await call('POST', '/alpha/api/items', { text: 'Second' });
  await call('POST', '/beta/api/items', { text: 'Locked' });
  assert.equal((await call('POST', '/api/links', { from: 'alpha:item:2', to: 'beta:item:6', together: true })).status, 201);
  assert.equal((await call('POST', '/alpha/api/items/2/done')).status, 200);
  assert.deepEqual([host.suite.database.get('SELECT done FROM alpha_items WHERE id = 2').done,
    host.suite.database.get('SELECT done FROM beta_items WHERE id = 6').done], [1, 0]);
});

test('links forget what was erased: a module\'s data, an account', async (t) => {
  const { host, call } = await startHost(t);
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  await call('POST', '/alpha/api/items', { text: 'Plan' });
  await call('POST', '/beta/api/items', { text: 'Private review' });
  await call('POST', '/beta/api/items', { text: 'Other' });
  await call('POST', '/api/links', { from: 'alpha:item:1', to: 'beta:item:1' });
  await call('POST', '/api/links', { from: 'alpha:item:1', to: 'beta:item:2' });
  const titles = () => host.suite.database.all('SELECT a_title, b_title FROM host_links ORDER BY id').map((r) => [r.a_title, r.b_title]);
  assert.deepEqual(titles(), [['Plan', 'Private review'], ['Plan', 'Other']]);

  // Deleted, as anything is: its last title stays, to whoever linked it.
  await call('DELETE', '/beta/api/items/1');
  assert.deepEqual(titles()[0], ['Plan', 'Private review']);
  // Someone's data erased in beta: beta's gone sides forget their titles; what exists keeps its own.
  assert.deepEqual(host.links.prune({ module: 'beta' }), { forgotten: 1, removed: 0 });
  assert.deepEqual(titles(), [['Plan', null], ['Plan', 'Other']]);
  const gone = (await call('GET', '/api/links?ref=alpha:item:1')).data.links.find((l) => l.item.ref === 'beta:item:1');
  assert.deepEqual([gone.item.state, gone.item.title], ['gone', undefined], 'gone, with nothing of what it was');
  // Erasing someone's data in a module (Settings › Your data) does it by itself, through the module's portability.
  await call('DELETE', '/beta/api/items/2');
  const admin = host.suite.database.get("SELECT * FROM users WHERE username = 'admin'");
  host.modules[1].suite.portabilityFor({ tables: {} }).erase(admin);
  assert.deepEqual(titles(), [['Plan', null], ['Plan', null]]);

  // An account deleted: what went with it leaves no link behind (both sides gone: the link goes).
  await call('POST', '/api/admin/users', { username: 'ana', password: 'ana-password', display_name: 'Ana' });
  const ana = host.suite.database.get("SELECT id FROM users WHERE username = 'ana'").id;
  host.suite.database.run("INSERT INTO alpha_items (user_id, text) VALUES (?, 'Ana plan')", ana);
  host.suite.database.run("INSERT INTO beta_items (user_id, text) VALUES (?, 'Ana review')", ana);
  const [a, b] = [host.suite.database.get("SELECT id FROM alpha_items WHERE text = 'Ana plan'").id,
    host.suite.database.get("SELECT id FROM beta_items WHERE text = 'Ana review'").id];
  host.suite.database.run(`INSERT INTO host_links (a_module, a_type, a_id, b_module, b_type, b_id, a_title, b_title, created_by, created_at)
    VALUES ('alpha', 'item', ?, 'beta', 'item', ?, 'Ana plan', 'Ana review', ?, ?)`, String(a), String(b), ana, new Date().toISOString());
  host.suite.accounts.remove(ana);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.suite.database.get("SELECT COUNT(*) AS n FROM host_links WHERE a_title = 'Ana plan' OR b_title = 'Ana review'").n, 0);
  assert.deepEqual(titles(), [['Plan', null], ['Plan', null]], 'the others’ links as they were');
});

test('the calls of the day from assistants count once for the whole app, whichever module they go to', async (t) => {
  const config = { ...HOST, features: { 'mcp.calls_per_day': { type: 'limit', default: 2, label: 'calls a day' } } };
  const { call } = await startHost(t, { config });
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  // Someone with a plan: the instance's administrator is never limited.
  await call('POST', '/api/admin/users', { username: 'ana', password: 'ana-password', display_name: 'Ana' });
  await call('POST', '/api/auth/logout');
  await call('POST', '/api/auth/login', { username: 'ana', password: 'ana-password' });
  const token = (await call('POST', '/api/me/tokens', { name: 'Claude' })).data.token;
  let id = 0;
  const text = async (name, args = {}) => (await call('POST', '/mcp', { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } },
    { Authorization: `Bearer ${token}` })).data.result.content[0].text;
  assert.equal(await text('alpha_add_item', { text: 'One' }), 'Added.');
  assert.equal(await text('beta_list_items'), '[]');
  assert.match(await text('alpha_list_items'), /^Daily limit reached: .* 2 calls a day from an assistant to Work/);
});

test('the storage a plan allows is the person’s, added up across the modules', async (t) => {
  const { host, call, lines } = await startHost(t);
  const [alpha, beta] = host.modules;
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  const admin = host.suite.database.get("SELECT id FROM users WHERE username = 'admin'").id;
  await call('POST', '/alpha/api/items', { text: 'One' });
  await call('POST', '/alpha/api/items', { text: 'Two' });
  await call('POST', '/beta/api/items', { text: 'Three' });
  assert.equal(alpha.suite.storage.used(admin), 2500, 'what alpha keeps and what beta keeps');
  assert.equal(beta.suite.storage.used(admin), 2500, 'the same from either module');
  const adminUser = host.suite.accounts.byId(admin);
  assert.deepEqual(alpha.suite.storage.of(adminUser), { used: 2500, limit: null }, 'its check reads that whole (storage.js)');
  assert.equal(alpha.suite.storage.check(adminUser, 10 * 1024 * 1024 * 1024), undefined, 'and the admin has no limit');
  assert.equal(alpha.suite.countStorage(() => 0), alpha.suite.storage, 'a module’s own count changes nothing in a host');
  await call('POST', '/beta/api/items', { text: 'Unreadable' });
  assert.equal(alpha.suite.storage.used(admin), 2000, 'a module that fails counts nothing, the rest still do');
  assert.ok(lines.some((line) => /\[beta\] storage of user \d+ failed: unreadable/.test(line)));
});

test('the admin sees what each person uses: every module’s counts against its caps, the storage and the calls of the month', async (t) => {
  const config = { ...HOST, features: {
    'mcp.calls_per_day': { type: 'limit', default: null, label: 'calls a day' },
    'storage.mb': { type: 'limit', default: null, label: 'storage (MB)' },
  } };
  const plans = { free: { name: 'Free', 'items.max': 4, 'mcp.calls_per_day': 10, 'storage.mb': 1 }, pro: { name: 'Pro', 'items.max': null, 'mcp.calls_per_day': null, 'storage.mb': null } };
  const { host, call, lines } = await startHost(t, { config, env: { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-')), PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1', PLANS: JSON.stringify(plans) } });
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  const ana = (await call('POST', '/api/admin/users', { username: 'ana', password: 'ana-password', display_name: 'Ana' })).data.id;
  await call('POST', '/api/auth/logout');
  await call('POST', '/api/auth/login', { username: 'ana', password: 'ana-password' });
  assert.equal((await call('GET', `/api/admin/users/${ana}/usage`)).status, 403, 'the admin’s only');
  await call('POST', '/alpha/api/items', { text: 'One' });
  await call('POST', '/alpha/api/items', { text: 'Two' });
  await call('POST', '/alpha/api/items', { text: 'Three' });
  await call('POST', '/beta/api/items', { text: 'Four' });
  // Two calls from an assistant, as /mcp spends them (the test above goes through /mcp itself).
  const user = host.suite.accounts.byId(ana);
  host.suite.entitlements.countDaily(user, 'mcp.calls_per_day');
  host.suite.entitlements.countDaily(user, 'mcp.calls_per_day');
  await call('POST', '/api/auth/logout');
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });

  const { status, data } = await call('GET', `/api/admin/users/${ana}/usage`);
  assert.equal(status, 200);
  const [alpha, beta] = data.modules;
  assert.deepEqual(alpha, {
    mount: 'alpha', name: 'Alpha', on: true, active_at: '2026-10-21T18:22:00.000Z', failed: false, bytes: 3000,
    counts: [{ id: 'tasks', count: 3, feature: 'items.max', limit: 4, share: 0.75 }, { id: 'files', count: 3, feature: null, limit: null, share: null }],
  }, 'its counts with their caps, without what the admin has no words for');
  assert.deepEqual(beta, { mount: 'beta', name: 'Beta', on: true, counts: [], active_at: null, failed: false, bytes: 500 }, 'a module with no usage shows its storage');
  assert.deepEqual(data.storage, { bytes: 3500, files: 3, limit_mb: 1, share: 3500 / (1024 * 1024) });
  assert.equal(data.mcp.limit, 10);
  assert.equal(data.mcp.today, 2);
  assert.equal(data.mcp.total, 2);
  assert.equal(data.mcp.days.length, 30);
  assert.deepEqual(data.peak, { share: 0.75, mount: 'alpha', name: 'Alpha', id: 'tasks' }, 'the cap they are nearest to');

  // The list: each account's nearest cap. The admin has no limits, so none.
  const peaks = (await call('GET', '/api/admin/usage')).data.peaks;
  assert.deepEqual(peaks[ana], data.peak);
  const admin = host.suite.database.get("SELECT id FROM users WHERE username = 'admin'").id;
  assert.equal(peaks[admin], null);
  host.suite.entitlements.countDaily(host.suite.accounts.byId(admin), 'mcp.calls_per_day');
  const unlimited = (await call('GET', `/api/admin/users/${admin}/usage`)).data;
  assert.deepEqual([unlimited.mcp.limit, unlimited.mcp.today, unlimited.mcp.share, unlimited.mcp.total], [null, 1, null, 1],
    'without a limit, counted all the same, with no share');
  assert.equal(unlimited.storage.limit_mb, null);

  // A module whose usage fails says so; the rest still answer.
  await call('POST', '/alpha/api/items', { text: 'Locked' });
  const failing = (await call('GET', `/api/admin/users/${admin}/usage`)).data;
  assert.equal(failing.modules[0].failed, true);
  assert.deepEqual(failing.modules[0].counts, []);
  assert.equal(failing.modules[0].bytes, 1000, 'its storage still counts');
  assert.ok(lines.some((line) => /\[alpha\] usage of user \d+ failed: locked/.test(line)));
  assert.equal((await call('GET', '/api/admin/users/9999/usage')).status, 404);
});

test('each person sees their own usage, signed in on the web: nobody else’s, and not with an assistant’s token', async (t) => {
  const config = { ...HOST, features: { 'mcp.calls_per_day': { type: 'limit', default: null, label: 'calls a day' } } };
  const plans = { free: { name: 'Free', 'items.max': 4, 'mcp.calls_per_day': 10 } };
  const { call } = await startHost(t, { config, env: { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-')), PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1', PLANS: JSON.stringify(plans) } });
  assert.equal((await call('GET', '/api/me/usage')).status, 401, 'nobody signed in');
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  await call('POST', '/alpha/api/items', { text: 'The admin’s' });
  await call('POST', '/api/admin/users', { username: 'ana', password: 'ana-password', display_name: 'Ana' });
  await call('POST', '/api/auth/logout');
  await call('POST', '/api/auth/login', { username: 'ana', password: 'ana-password' });
  await call('POST', '/alpha/api/items', { text: 'One' });
  await call('POST', '/alpha/api/items', { text: 'Two' });

  const { status, data } = await call('GET', '/api/me/usage');
  assert.equal(status, 200);
  assert.deepEqual(data.modules[0].counts[0], { id: 'tasks', count: 2, feature: 'items.max', limit: 4, share: 0.5 }, 'hers, not the admin’s');
  assert.equal(data.mcp.limit, 10);
  assert.deepEqual(data.peak, { share: 0.5, mount: 'alpha', name: 'Alpha', id: 'tasks' });

  const token = (await call('POST', '/api/me/tokens', { name: 'Claude' })).data.token;
  await call('POST', '/api/auth/logout');
  assert.equal((await call('GET', '/api/me/usage', undefined, { Authorization: `Bearer ${token}` })).status, 401, 'an assistant’s token reads no usage');
});

test('the host’s instructions keep under what assistants read, whole parts only', async () => {
  const { hostInstructions } = await import('../host.js');
  const modules = ['one', 'two', 'three'].map((mount) => ({
    mount, config: { app: { name: mount.toUpperCase() } }, parts: { mcp: { brief: `${mount} `.repeat(300).trim() } },
  }));
  const lines = [];
  const text = hostInstructions({ modules, hostName: 'Host', log: (line) => lines.push(line) });
  assert.ok(text.length <= 2048, String(text.length));
  assert.match(text, /^Host holds the user's ONE, TWO and THREE/);
  assert.ok(text.includes('one one') && !text.includes('three three'), 'the parts that fit, whole');
  assert.match(lines.join(), /don't fit in 2048 characters/);
});

test('a host with an icon but no page of its own still opens on its first module', async (t) => {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-public-'));
  t.after(() => fs.rmSync(publicDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(publicDir, 'icons'));
  fs.writeFileSync(path.join(publicDir, 'icons', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const { call } = await startHost(t, { publicDir });
  assert.equal((await call('GET', '/')).headers.get('location'), '/alpha/');
  assert.equal((await call('GET', '/icons/favicon.svg')).status, 200);
});

test('a host with pages of its own serves them at the root, and its own routes', async (t) => {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-public-'));
  t.after(() => fs.rmSync(publicDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!DOCTYPE html><title>Which one?</title>');
  const { call } = await startHost(t, { publicDir, routes: (api) => api.get('/api/hello', (ctx) => ctx.res.end('hi')) });
  assert.match((await call('GET', '/')).data, /Which one\?/);
  assert.equal((await call('GET', '/api/hello')).data, 'hi');
  assert.equal((await call('GET', '/api/modules')).data.modules.length, 2);
});

test('a host with one worker: /sw.js for every module, one version for the whole app, notices at the module’s path', async (t) => {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-public-'));
  t.after(() => fs.rmSync(publicDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!DOCTYPE html><title>Which one?</title>');
  fs.mkdirSync(path.join(publicDir, 'split'));
  fs.writeFileSync(path.join(publicDir, 'split', 'index.html'), '<!DOCTYPE html><title>Split</title>');
  const { host, call } = await startHost(t, { publicDir, worker: { icon: '/icons/icon-192.png' } });

  const sw = await call('GET', '/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
  const options = (() => {
    let given = null;
    // The worker as a browser runs it: sw-core's suiteWorker, here only what it is given.
    new Function('importScripts', 'suiteWorker', sw.data)(() => {}, (o) => { given = o; });
    return given;
  })();
  assert.deepEqual(options.modules, ['/alpha/', '/beta/']);
  for (const kept of ['/', '/index.html', '/split/', '/split/index.html', '/alpha/', '/alpha/index.html', '/alpha/js/main.js', '/beta/']) {
    assert.ok(options.shell.includes(kept), `${kept} in its copy`);
  }
  assert.deepEqual(options.push, { title: 'Work', icon: '/icons/icon-192.png', url: '/' });
  // Its version is the fingerprint of everything: code from the copy first, the kit once, and each
  // file's hash for the next release to take what didn't change.
  assert.equal(options.codeFirst, true);
  assert.equal(options.sharedKit, true);
  assert.match(options.hashes['/alpha/js/main.js'], /^[0-9a-f]{16}$/);
  assert.match(options.hashes['/suite/kit.css'], /^[0-9a-f]{16}$/);
  assert.match(options.hashes['/alpha/i18n/en.json'] ?? options.hashes['/beta/i18n/en.json'] ?? 'none', /^[0-9a-f]{16}$|^none$/);
  assert.equal(options.hashes['/alpha/'], undefined, 'pages always travel again');
  assert.equal(options.hashes['/alpha/index.html'], undefined);

  const version = (await call('GET', '/version')).data;
  assert.equal(version.app, '9.9.9');
  assert.equal(version.name, 'Work');
  assert.match(version.version, /^[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(version.modules), ['alpha', 'beta']);
  assert.equal(options.version, `work-${version.version}`, 'a new release is a new worker');
  const own = await call('GET', '/js/app-version.js');
  assert.match(own.data, new RegExp(`APP_VERSION = '${version.version}'`));
  assert.match(own.data, /APP_NAME = "Work"/);
  // Each module's version in this code, for About's cards.
  const modulesLine = /APP_MODULES = (\{.*\});/.exec(own.data);
  assert.deepEqual(JSON.parse(modulesLine[1]), Object.fromEntries(Object.entries(version.modules).map(([mount, m]) => [mount, { app: m.app }])));
  assert.equal((await call('GET', '/alpha/version')).data.version === version.version, false, 'a module keeps its own');

  // Each module's page learns of the worker, and retires its own (web/worker.js).
  assert.equal((await call('GET', '/alpha/api/auth/config')).data.app.host.worker, '/sw.js');
  assert.equal(host.modules.length, 2);
});

test('without one worker, each module keeps its own, and the host’s /version is its own files’', async (t) => {
  const { call } = await startHost(t);
  assert.equal((await call('GET', '/alpha/api/auth/config')).data.app.host.worker, undefined);
  assert.equal((await call('GET', '/alpha/sw.js')).status, 200, 'the module’s worker, as before');
  assert.equal((await call('GET', '/version')).data.modules, undefined);
});

test('a module’s notices with the host’s one worker open at its path (host-worker.js)', async () => {
  const { hostedPush } = await import('../host-worker.js');
  const sent = [];
  const push = { publicKey: 'k', deliver: async (subs, payload) => { sent.push(typeof payload === 'function' ? payload({ lang: 'es' }) : payload); }, send: async (sub, payload) => { sent.push(payload); } };
  const tasks = hostedPush(push, 'tasks');
  assert.equal(tasks.publicKey, 'k');
  await tasks.deliver([], { title: 'List', url: '/?list=4', tag: 'lista-4', list_id: 4 });
  await tasks.deliver([], (sub) => ({ title: sub.lang }));
  await tasks.send({}, { title: 'x', url: '/tasks/?list=5' });
  await tasks.send({}, 'plain text');
  assert.deepEqual(sent, [
    { title: 'List', url: '/tasks/?list=4', tag: 'tasks-lista-4', list_id: 4, module: 'tasks' },
    { title: 'es', url: '/tasks/', tag: 'tasks-notice', module: 'tasks' },
    { title: 'x', url: '/tasks/?list=5', tag: 'tasks-notice', module: 'tasks' },
    'plain text',
  ]);
});

test('a module’s shell, read from its own worker, at its path (host-worker.js)', async () => {
  const { moduleShell } = await import('../host-worker.js');
  const dir = new URL('./fixtures/host/alpha/public', import.meta.url);
  assert.deepEqual(moduleShell(fs.realpathSync(dir), 'alpha'), { shell: ['/alpha/', '/alpha/index.html', '/alpha/js/main.js'], optional: [], icon: null });
  assert.deepEqual(moduleShell(null, 'beta'), { shell: ['/beta/', '/beta/index.html'], optional: [] }, 'without a worker, its page');
});

test('a module’s notices show its own icon in the host’s worker: its push.icon, else its icon of 192 px', (t) => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-icon-'));
  t.after(() => fs.rmSync(own, { recursive: true, force: true }));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(own, rel)), { recursive: true });
    fs.writeFileSync(path.join(own, rel), text);
  };
  return import('../host-worker.js').then(({ moduleShell }) => {
    write('sw.js', "importScripts('suite/sw-core.js'); suiteWorker({ version: 'g-v1', shell: ['./'], push: { title: 'G', icon: 'icons/bell.png?v=2' } });");
    assert.equal(moduleShell(own, 'gamma').icon, '/gamma/icons/bell.png?v=2', 'its notices\' own, at its path');
    write('sw.js', "importScripts('suite/sw-core.js'); suiteWorker({ version: 'g-v1', shell: ['./'] });");
    assert.equal(moduleShell(own, 'gamma').icon, null, 'no notices and no icon: the host\'s');
    write('icons/icon-192.png', 'png');
    assert.equal(moduleShell(own, 'gamma').icon, '/gamma/icons/icon-192.png', 'no notices of its own: its app icon');
  });
});

test('a module’s jobs stop when the host closes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-'));
  const list = modules();
  const host = await createHost({
    config: HOST, modules: list, env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password' },
    handleSignals: false, exitOnError: false, log: () => {},
  });
  await host.listen();
  await host.close();
  host.suite.database.close();
  fs.rmSync(dir, { recursive: true, force: true });
  const alpha = await import(list[0].entry.href);
  assert.equal(alpha.events.stopped, 1);
});

test('what a host can’t run stops it, and says why', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-'));
  const env = { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password' };
  const refused = async (list, pattern, config = HOST) => {
    fresh += 1;
    await assert.rejects(
      createHost({ config, modules: list, env, handleSignals: false, exitOnError: false, log: () => {} }),
      (err) => {
        assert.ok(err instanceof SuiteConfigError, err.stack);
        assert.match(err.errors.join('\n'), pattern);
        return true;
      },
    );
    assert.equal(globalThis[Symbol.for('suite-core.host')], undefined, 'nothing left waiting for a module');
  };
  try {
    await refused([], /at least one module/);
    await refused([{ mount: 'api', entry: fixture('plain') }], /"api" is a path of the host's own/);
    await refused([{ mount: 'Tasks', entry: fixture('plain') }], /lowercase letters/);
    await refused([{ mount: 'one', entry: fixture('plain', '?id=one') }, { mount: 'one', entry: fixture('plain', '?id=two') }], /mounted twice/);
    await refused([{ mount: 'lonely', entry: fixture('loner') }], /didn't join the host; its server\/platform\.js must try joinHost\(\)/);
    await refused([{ mount: 'odd', entry: fixture('stranger') }], /runs suite-core from file:\/\/\/elsewhere/);
    await refused([{ mount: 'one', entry: fixture('plain', `?id=same&n=${fresh}a`) }, { mount: 'two', entry: fixture('plain', `?id=same&n=${fresh}b`) }],
      /app\.id "same" is the module at \/one\/ already/);
    await refused([{ mount: 'odd', entry: fixture('plain', `?id=suite&n=${fresh}`) }], /a scope of migrations/);
    await refused([{ mount: 'odd', entry: fixture('plain', `?id=work&n=${fresh}`) }], /is the host's/);
    await refused([{ mount: 'pushy', entry: fixture('plain', `?id=pushy&uses=push&n=${fresh}`) }], /uses modules\.push, which the host has off/);
    await refused([{ mount: 'typo', entry: fixture('plain', `?id=typo&uses=pigeons&n=${fresh}`) }], /typo: modules\.pigeons is not a module of the suite/);
    await refused([{ mount: 'phone', entry: fixture('plain', `?id=phone&uses=devices&n=${fresh}`) }],
      /phone: modules\.devices is for an app on its own, not a module of a host/);
    // Fresh folder: the table of the case before must not be there.
    fs.rmSync(path.join(dir, 'work.db'), { force: true });
    await refused([
      { mount: 'one', entry: fixture('plain', `?id=uno&table=things&n=${fresh}`) },
      { mount: 'two', entry: fixture('plain', `?id=dos&table=things&n=${fresh}`) },
    ], /two: its table things is \/one\/'s too; one of them must rename it/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a module that manages a kind of group: the host declares it the same way, and the module hears its groups', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-'));
  let host = null;
  t.after(() => { host?.suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const env = { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1' };
  const hostWith = (kinds) => ({ ...HOST, modules: { ...HOST.modules, organizations: true }, organizations: { kinds } });
  const entry = (n) => ({ mount: 'focus', entry: fixture('plain', `?id=focus&uses=organizations&kinds=family&n=${n}`) });
  for (const [kinds, why] of [[{}, 'not declared'], [{ family: { managed: true } }, 'declared otherwise']]) {
    fresh += 1;
    await assert.rejects(
      createHost({ config: hostWith(kinds), modules: [entry(`${fresh}x`)], env, handleSignals: false, exitOnError: false, log: () => {} }),
      (err) => err instanceof SuiteConfigError
        && err.errors.includes("focus: organizations.kinds.family must be declared the same way in the host's suite.config.js"),
      why,
    );
  }

  fresh += 1;
  const module = entry(`${fresh}y`);
  host = await createHost({
    config: hostWith({ family: { managed: true, maxPerUser: 1 } }), modules: [module], env, handleSignals: false, exitOnError: false, log: () => {},
  });
  const { heard } = await import(module.entry);
  const { organizations, accounts } = host.suite;
  assert.equal(organizations.isManaged('family'), true);
  const ada = accounts.create({ username: 'ada' });
  const bob = accounts.create({ username: 'bob' });
  const home = organizations.create({ name: 'Home', kind: 'family', ownerId: ada.id });
  organizations.addMember(home.id, bob.id, 'admin');
  organizations.removeMember(home.id, bob.id, { by: bob.id });
  // Someone asking to delete their account and taking it back: the module hears it from the host's one deletion.
  await host.suite.deletion.request(accounts.byId(ada.id));
  await host.suite.deletion.restore(host.suite.deletion.ticketFor(ada.id));
  accounts.remove(ada.id);
  assert.deepEqual(heard, [
    ['member', 'family', bob.id, 'left'], ['deletion requested', ada.id], ['deletion cancelled', ada.id],
    ['member', 'family', ada.id, 'account_deleted'], ['deleted', 'family', 'empty'],
  ], 'before, a module’s deletion hooks were dropped in a host');
  assert.equal(organizations.exists(home.id), false);
});

test('a PLANS JSON names the features of any module; one that none declares stops the start', async (t) => {
  const dirs = [];
  let host = null;
  // The host closes its database before its folder goes (Windows keeps an open file's folder).
  t.after(async () => {
    if (host) {
      await host.close();
      host.suite.database.close();
    }
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });
  const env = (plans) => {
    dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-')));
    return { DATA_DIR: dirs.at(-1), PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1', PLANS: JSON.stringify(plans) };
  };
  await assert.rejects(
    createHost({ config: HOST, modules: modules(), env: env({ free: { name: 'Free', 'itemz.max': 2 } }), handleSignals: false, exitOnError: false, log: () => {} }),
    (err) => err instanceof SuiteConfigError && /PLANS: plan "free": "itemz\.max" is nothing Work or its modules can limit/.test(err.errors.join('\n')),
  );
  // alpha's feature, which neither the host nor beta declares: each reads what is its own.
  host = await createHost({
    config: HOST, modules: modules(), env: env({ free: { name: 'Free', 'items.max': 2 } }), handleSignals: false, exitOnError: false, log: () => {},
  });
  const someone = { id: 999, role: 'user' };
  assert.equal(host.modules[0].suite.entitlements.limit(someone, 'items.max'), 2);
  assert.deepEqual(host.modules[1].suite.entitlements.describe().features, {});
});

test('a module’s ofOrganization reads the group’s own plan, and an archived group has the default one', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-'));
  fresh += 1;
  const host = await createHost({
    config: { ...HOST, modules: { live: true, organizations: true } },
    modules: [{ mount: 'family', entry: fixture('plain', `?id=family&uses=organizations&n=${fresh}`) }],
    env: {
      DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1',
      PLANS: JSON.stringify({ free: { name: 'Free' }, pro: { name: 'Pro' } }),
    },
    handleSignals: false, exitOnError: false, log: () => {},
  });
  t.after(async () => {
    await host.close();
    host.suite.database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { suite } = host.modules[0];
  const owner = host.suite.accounts.create({ username: 'ada' });
  const home = suite.organizations.create({ name: 'Andersen', kind: 'family', ownerId: owner.id });
  suite.entitlements.grant({ subjectType: 'organization', subjectId: home.id, plan: 'pro', source: 'paddle', externalRef: 'sub_1' });
  assert.equal(suite.entitlements.ofOrganization(home.id).plan.id, 'pro');
  suite.organizations.archive(home.id);
  assert.equal(suite.entitlements.ofOrganization(home.id).plan.id, 'free', 'the host tells the module’s entitlements it is archived');
});

test('outside a host an app goes on as always', () => {
  assert.equal(joinHost({ config: { app: { id: 'alone', name: 'Alone' } } }), null);
});

test('a module’s manifest and paths, at its place in the host', () => {
  assert.equal(mountedPath('tasks', '/icons/a.png?v=2'), '/tasks/icons/a.png?v=2');
  assert.equal(mountedPath('tasks', 'icons/a.png'), 'icons/a.png', 'relative: already the module’s');
  assert.equal(mountedPath('tasks', '//cdn.example/a.png'), '//cdn.example/a.png');
  assert.equal(mountedPath('tasks', 'https://cdn.example/a.png'), 'https://cdn.example/a.png');
  assert.deepEqual(mountManifest({ name: 'Tasks', id: '/', start_url: '/', icons: [{ src: '/icons/i.png' }] }, 'tasks'),
    { name: 'Tasks', id: '/tasks/', start_url: '/tasks/', scope: '/tasks/', icons: [{ src: '/tasks/icons/i.png' }] });
  assert.deepEqual(mountManifest({ start_url: './?app', scope: '.' }, 'notes'), { start_url: './?app', scope: '.' });
  assert.deepEqual(mountManifest({ share_target: { action: '/share', method: 'POST' } }, 'notes').share_target,
    { action: '/notes/share', method: 'POST' });
  assert.deepEqual(mountManifest({}, 'next'), { start_url: '/next/', scope: '/next/' });
});

test('a host with a split view: the rail offers it, and only its own pages may frame the modules', async (t) => {
  const { call } = await startHost(t, { split: '/split/' });
  assert.equal((await call('GET', '/api/modules')).data.host.split, '/split/');
  const module = await call('GET', '/alpha/api/auth/config');
  assert.match(module.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal(module.headers.get('x-frame-options'), 'SAMEORIGIN');
  // The host's own pages are framed by nobody.
  const root = await call('GET', '/api/modules');
  assert.match(root.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(root.headers.get('x-frame-options'), 'DENY');
});

test('a host without a split view: nobody may frame its modules, and the rail offers none', async (t) => {
  const { call } = await startHost(t);
  assert.equal((await call('GET', '/api/modules')).data.host.split, undefined);
  assert.equal((await call('GET', '/api/modules')).data.host.aiInstruction, undefined, 'nor a prompt of the host’s');
  assert.equal((await call('GET', '/api/modules')).data.host.calendar, undefined, 'nor a calendar');
  assert.equal('calendar_shown' in (await call('GET', '/api/modules')).data, false, 'nor its switch');
  assert.equal((await call('GET', '/api/calendar?from=2026-11-01&to=2026-11-07')).status, 404, 'nor its route');
  const module = await call('GET', '/alpha/api/auth/config');
  assert.match(module.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(module.headers.get('x-frame-options'), 'DENY');
});

test('a host with a calendar: the rail offers it to whoever turns it on, and the root answers what has a date in the modules each person uses', async (t) => {
  const { call } = await startHost(t, { calendar: '/calendar/' });
  assert.equal((await call('GET', '/api/calendar?from=2026-11-01&to=2026-11-07')).status, 401, 'signed out: nothing');
  assert.equal((await call('PUT', '/api/me/calendar', { shown: true })).status, 401);
  await call('POST', '/alpha/api/auth/login', { username: 'admin', password: 'root-password' });
  // Off until the person turns it on (Settings › Modules): the rail stays as simple as it was.
  const before = (await call('GET', '/api/modules')).data;
  assert.equal(before.host.calendar, undefined);
  assert.equal(before.calendar_shown, false, 'the switch, off');
  assert.equal((await call('PUT', '/api/me/calendar', { shown: 'yes' })).data.field, 'shown');
  const on = await call('PUT', '/api/me/calendar', { shown: true });
  assert.deepEqual([on.status, on.data.host.calendar, on.data.calendar_shown], [200, '/calendar/', true]);
  assert.equal((await call('GET', '/api/modules')).data.host.calendar, '/calendar/', 'kept');
  assert.equal((await call('PUT', '/api/me/calendar', { shown: false })).data.host.calendar, undefined, 'and off again');
  for (const text of ['2026-11-03 Dentist', 'No date', '2026-12-24 Later']) await call('POST', '/alpha/api/items', { text });
  await call('POST', '/beta/api/items', { text: '2026-11-03 Beta gives no dates' });
  const november = await call('GET', '/api/calendar?from=2026-11-01&to=2026-11-30');
  assert.equal(november.status, 200);
  assert.deepEqual(november.data, {
    from: '2026-11-01', to: '2026-11-30',
    modules: [{ mount: 'alpha', name: 'Alpha', color: '#EF4B2A', icon: '/alpha/icons/alpha.svg?v=1' }],
    items: [{ module: 'alpha', type: 'item', id: 1, title: 'Dentist', start: '2026-11-03', end: '2026-11-03', state: 'open', where: 'Items', url: '/alpha/?item=1' }],
  }, 'alpha’s, under its path; beta gives none');
  const field = async (query) => (await call('GET', `/api/calendar?${query}`)).data;
  assert.deepEqual(await field('to=2026-11-07'), { error: 'field_invalid', field: 'from' });
  assert.equal((await field('from=2026-11-31&to=2026-12-07')).field, 'from', 'a day that doesn’t exist');
  assert.equal((await field('from=2026-11-07&to=2026-11-01')).field, 'to', 'to before from');
  assert.equal((await field('from=2026-01-01&to=2027-01-02')).field, 'to', 'more than a year');
  assert.equal((await field('from=2026-01-01&to=2027-01-01')).items.length, 2, 'a year');
  // A module turned off leaves the calendar too.
  await call('PUT', '/api/me/modules', { active: ['beta'] });
  assert.deepEqual((await call('GET', '/api/calendar?from=2026-11-01&to=2026-11-30')).data, { from: '2026-11-01', to: '2026-11-30', modules: [], items: [] });
});

test('a calendar that isn’t a page of the host stops the start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-'));
  try {
    for (const calendar of ['https://elsewhere.example/calendar/', '/calendar', '//evil/', 42]) {
      await assert.rejects(
        createHost({ config: HOST, modules: modules(), calendar, env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password' }, handleSignals: false, exitOnError: false, log: () => {} }),
        (err) => err instanceof SuiteConfigError && /calendar: .* is not a page of the host/.test(err.errors.join('\n')),
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a host with one prompt for an assistant names its route for Settings, and only a route of its own', async (t) => {
  const { call } = await startHost(t, { aiInstruction: '/api/ai-instruction' });
  assert.equal((await call('GET', '/api/modules')).data.host.aiInstruction, '/api/ai-instruction');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-'));
  try {
    for (const aiInstruction of ['https://elsewhere.example/api/x', '/ai-instruction', '/api/../x', 42]) {
      await assert.rejects(
        createHost({ config: HOST, modules: modules(), aiInstruction, env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password' }, handleSignals: false, exitOnError: false, log: () => {} }),
        (err) => err instanceof SuiteConfigError && /aiInstruction: .* is not a route of the host/.test(err.errors.join('\n')),
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a split view that isn’t a page of the host stops the start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-'));
  try {
    for (const split of ['https://elsewhere.example/split/', '/split', '//evil/', 42]) {
      await assert.rejects(
        createHost({ config: HOST, modules: modules(), split, env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password' }, handleSignals: false, exitOnError: false, log: () => {} }),
        (err) => err instanceof SuiteConfigError && /split: .* is not a page of the host/.test(err.errors.join('\n')),
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a module\'s sections of Settings, as the host lists them for the others: what is well formed', () => {
  assert.deepEqual(moduleSettings(undefined), { sections: [], data: false, ai: false, about: false }, 'a module that declares none');
  const listed = moduleSettings({
    sections: [
      { id: 'templates', icon: 'copy', label: 'templates.title', hint: 'templates.short' },
      { id: 'line', label: 'settings.line.title', icon: '<b>', hint: 'has spaces in it' },
      { id: 'Bad Id', label: 'x.y' },
      { id: 'nolabel' },
      null,
    ],
    ai: true, about: 'yes',
  }, { data: true });
  assert.deepEqual(listed, {
    sections: [
      { id: 'templates', label: 'templates.title', icon: 'copy', hint: 'templates.short' },
      { id: 'line', label: 'settings.line.title' },
    ],
    data: true, ai: true, about: false,
  });
  // Its instruction for an assistant, a key of its catalog, for Your AI to show; anything else, none.
  assert.equal(moduleSettings({ standing: 'settings.standing.text' }).standing, 'settings.standing.text');
  assert.ok(!('standing' in moduleSettings({ standing: 'not a key!' })));
  assert.ok(!('standing' in moduleSettings({ standing: true })));
  // Where its catalog keeps its line, for About's card.
  assert.equal(moduleSettings({ tagline: 'about.tagline' }).tagline, 'about.tagline');
  assert.ok(!('tagline' in moduleSettings({ tagline: '<b>' })));
  // What it says under its instruction: keys and pairs of keys; anything else is left out.
  assert.deepEqual(moduleSettings({ standingMore: ['a.b', ['c.d', 'c.dAsk'], ['only.one'], 7, 'not a key!'] }).standingMore, ['a.b', ['c.d', 'c.dAsk']]);
  assert.ok(!('standingMore' in moduleSettings({ standingMore: 'a.b' })));
  // Its website, https only.
  assert.equal(moduleSettings({ site: 'https://tasks.cronumstudio.com/' }).site, 'https://tasks.cronumstudio.com/');
  for (const site of ['http://x.example/', 'javascript:alert(1)', 'https://x.example/"><b>']) assert.ok(!('site' in moduleSettings({ site })), site);
});

test('notices are the host\'s: a module that sends none answers them at its own path, as the root does', async (t) => {
  const { call } = await startHost(t, { config: { ...HOST, modules: { ...HOST.modules, push: true } } });
  assert.equal((await call('GET', '/alpha/api/push/config')).status, 401, 'behind a session, as at the root');
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  const root = await call('GET', '/api/push/config');
  assert.equal(root.status, 200);
  // Settings are one for the whole host: Settings › Notices in a module that sends none asks at its path.
  assert.deepEqual((await call('GET', '/alpha/api/push/config')).data, root.data);
  assert.deepEqual((await call('GET', '/beta/api/push/devices')).data, []);
  assert.equal((await call('GET', '/alpha/api/pushy')).status, 404, 'only the notices\' routes');
});

test('a host without notices doesn\'t answer them at a module\'s path either', async (t) => {
  const { call } = await startHost(t);
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  assert.equal((await call('GET', '/alpha/api/push/config')).status, 404);
});

test('payments are the host\'s in every module: its routes at a module that sells nothing itself, and a founder\'s notice', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-billing-'));
  const host = await createHost({
    config: {
      ...HOST, modules: { live: true, billing: true },
      plans: { free: { name: 'Free', features: {} }, pro: { name: 'Pro', features: {} } }, defaultPlan: 'free',
      products: { 'pro-yearly': { plan: 'pro', kind: 'subscription', amount: 35, founderAmount: 19, founderPrice: 'founder', currency: 'EUR' } },
    },
    modules: modules(),
    env: {
      DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1',
      BILLING_PROVIDER: 'remote', BILLING_SECRET: 'a-shared-secret-of-the-accounts-service',
      EARLY_ACCESS_UNTIL: '2026-02-01', FOUNDER_OFFER_UNTIL: '2099-01-01',
    },
    version: '9.9.9', handleSignals: false, exitOnError: false, log: () => {},
  });
  const server = await host.listen();
  t.after(async () => { await host.close(); host.suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, pathname, body) => {
    const res = await fetch(base + pathname, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('work_sid='));
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  // Joined during the early access.
  host.suite.database.run("UPDATE users SET created_at = '2026-01-10T10:00:00.000Z' WHERE username = 'admin'");

  assert.equal((await call('GET', '/alpha/api/auth/config')).data.app.host.billing, true, 'the host sells: Settings › Plan says so in every module');
  const products = await call('GET', '/alpha/api/billing/products');
  assert.equal(products.status, 200, 'at a module that sells nothing on its own');
  assert.deepEqual(products.data.products.map((p) => [p.key, p.amount, p.founder_amount]), [['pro-yearly', 35, 19]]);
  assert.equal(products.data.founder, true);
  assert.equal(products.data.founder_until, '2099-01-01T00:00:00.000Z');
  assert.equal(products.data.on_sale, true);
  assert.equal((await call('GET', '/alpha/api/billing/overview')).status, 200);
  assert.deepEqual((await call('GET', '/api/modules')).data.founder_offer, { until: '2099-01-01T00:00:00.000Z' }, 'the notice every frame shows');
});

/* ------------------- a page that shows several modules ------------------- */

/** A folder with the files of a page of the host's own (`pages`). */
function pageFolder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-page-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'js'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!DOCTYPE html><title>Desk</title>');
  fs.writeFileSync(path.join(dir, 'start.html'), '<!DOCTYPE html><title>Start</title>');
  fs.writeFileSync(path.join(dir, 'js', 'desk.js'), 'export const desk = 1;\n');
  fs.writeFileSync(path.join(dir, '.secret'), 'no');
  return dir;
}

test('a page of the host’s own (pages): its files under its path, before anything else, and a 404 for what it hasn’t', async (t) => {
  const dir = pageFolder(t);
  const { call } = await startHost(t, { pages: [{ at: '/w/', dir }] });
  const page = await call('GET', '/w/?w=alpha:list/1');
  assert.equal(page.status, 200);
  assert.match(page.data, /<title>Desk<\/title>/);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.ok(page.headers.get('content-security-policy'), 'with the host’s security headers');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('cache-control'), 'no-cache', 'revalidated, as the host’s own files');
  assert.equal((await call('GET', '/w/', undefined, { 'If-None-Match': page.headers.get('etag') })).status, 304);
  assert.equal((await call('GET', '/w/index.html')).data, page.data);
  assert.equal((await call('GET', '/w/js/desk.js')).data, 'export const desk = 1;\n');
  const head = await call('HEAD', '/w/js/desk.js');
  assert.equal(head.status, 200);
  assert.equal(head.data, '');
  for (const missing of ['/w/nothing.js', '/w/list/1', '/w/.secret', '/w/%2e%2e/%2e%2e/package.json']) {
    assert.equal((await call('GET', missing)).status, 404, `${missing}: never a module’s page nor the host’s`);
  }
  const bare = await call('GET', '/w?x=1');
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.get('location'), '/w/?x=1');
  assert.notEqual((await call('POST', '/w/', {})).status, 200, 'only GET and HEAD are the page’s');
  // Everything else as before.
  assert.match((await call('GET', '/alpha/')).data, /<title>Alpha<\/title>/);
  assert.equal((await call('GET', '/')).headers.get('location'), '/alpha/');

  // Another index.
  const { call: other } = await startHost(t, { pages: [{ at: '/desk/', dir, index: 'start.html' }] });
  assert.match((await other('GET', '/desk/')).data, /<title>Start<\/title>/);
});

test('a page of the host’s own can be its root: / opens it, but for the home asked by name', async (t) => {
  const dir = pageFolder(t);
  const { call } = await startHost(t, { pages: [{ at: '/w/', dir, root: { except: ['modules'] } }] });
  const start = await call('GET', '/');
  assert.equal(start.status, 200, 'the app opens on the page, not on its first module');
  assert.match(start.data, /<title>Desk<\/title>/);
  assert.ok(start.headers.get('content-security-policy'));
  assert.match((await call('GET', '/?w=alpha:list/1')).data, /<title>Desk<\/title>/, 'with the windows in its address');
  assert.equal((await call('GET', '/?modules')).headers.get('location'), '/alpha/?modules', 'the home asked by name answers as before');
  assert.match((await call('GET', '/w/')).data, /<title>Desk<\/title>/, 'and the page is still at its own path');
  assert.match((await call('GET', '/alpha/')).data, /<title>Alpha<\/title>/);

  const { call: plain } = await startHost(t, { pages: [{ at: '/w/', dir, root: true }] });
  assert.match((await plain('GET', '/?modules')).data, /<title>Desk<\/title>/, 'root: true takes every /');
});

test('a page of the host’s own is in the one worker’s copy and in /version: changing only it is a new release', async (t) => {
  const dir = pageFolder(t);
  const { call } = await startHost(t, { pages: [{ at: '/w/', dir }], worker: true });
  const optionsOf = (body) => {
    let given = null;
    new Function('importScripts', 'suiteWorker', body)(() => {}, (o) => { given = o; });
    return given;
  };
  const options = optionsOf((await call('GET', '/sw.js')).data);
  for (const kept of ['/w/', '/w/index.html', '/w/js/desk.js']) assert.ok(options.shell.includes(kept), `${kept} in its copy`);
  assert.match(options.hashes['/w/js/desk.js'], /^[0-9a-f]{16}$/, 'kept from one copy to the next while it doesn’t change');
  assert.equal(options.hashes['/w/'], undefined, 'its page always travels again');
  const before = (await call('GET', '/version')).data.version;
  fs.writeFileSync(path.join(dir, 'js', 'desk.js'), 'export const desk = 2;\n');
  await new Promise((resolve) => setTimeout(resolve, 5100));   // the fingerprint is kept for 5 s
  const after = (await call('GET', '/version')).data.version;
  assert.notEqual(after, before, 'a change in the page alone is a new version, and a new worker');
  assert.equal(optionsOf((await call('GET', '/sw.js')).data).version.endsWith(after), true);
});

test('without pages, a host answers their paths as before', async (t) => {
  pageFolder(t);
  const { call } = await startHost(t);
  assert.equal((await call('GET', '/w/')).status, 404);
  assert.equal((await call('GET', '/w/js/desk.js')).status, 404);
});

test('pages that can’t be the host’s stop the start, and say why', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-'));
  const start = (pages) => createHost({
    config: HOST, modules: modules(), pages, env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password' },
    handleSignals: false, exitOnError: false, log: () => {},
  });
  try {
    const cases = [
      [[{ at: 'w', dir }], /pages\[0\]\.at: "w" is not a path of the host/],
      [[{ at: '/w', dir }], /pages\[0\]\.at: "\/w" is not a path of the host/],
      [[{ at: '/alpha/', dir }], /pages\[0\]\.at: \/alpha\/ is the host's already, or a module's/],
      [[{ at: '/api/', dir }], /pages\[0\]\.at: \/api\/ is the host's already/],
      [[{ at: '/w/' }], /pages\[0\]\.dir: the folder of its files is needed/],
      [[{ at: '/w/', dir, index: '../x.html' }], /pages\[0\]\.index: "\.\.\/x\.html" is not a file of its folder/],
      [[{ at: '/w/', dir }, { at: '/w/', dir }], /pages\[1\]\.at: \/w\/ twice/],
      [{ at: '/w/', dir }, /pages: a list/],
      [[{ at: '/w/', dir, root: 'yes' }], /pages\[0\]\.root: true, or \{ except/],
      [[{ at: '/w/', dir, root: true }, { at: '/v/', dir, root: true }], /pages: only one can be the root/],
    ];
    for (const [pages, message] of cases) {
      await assert.rejects(start(pages), (err) => err instanceof SuiteConfigError && message.test(err.errors.join('\n')), String(message));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a module’s sheet scoped to its windows (scopedSheets): its own file in @scope, revalidated by the app’s fingerprint', async (t) => {
  const own = fs.readFileSync(new URL('./fixtures/host/alpha/public/css/app.css', import.meta.url), 'utf8');
  const { call } = await startHost(t, { scopedSheets: true });
  const sheet = await call('GET', '/alpha/css/app.css?scope=work');
  assert.equal(sheet.status, 200);
  assert.equal(sheet.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(sheet.headers.get('cache-control'), 'no-cache');
  assert.ok(sheet.headers.get('content-security-policy'));
  assert.match(sheet.headers.get('etag'), /^W\/"[0-9a-f]{12}-[0-9a-f]{12}"$/);
  assert.equal(sheet.data, [
    '@font-face { font-family: Alpha; src: url(/alpha/fonts/alpha.woff2); }',
    '@scope ([data-module="alpha"], [data-owner="alpha"]) {',
    ':scope { --alpha: #EF4B2A; }',
    ':scope[data-module], :scope[data-module] { margin: 0; }',
    '.card { background: url(/alpha/icons/card.svg); }',
    '}',
    '',
  ].join('\n'));
  assert.equal((await call('GET', '/alpha/css/app.css?scope=work', undefined, { 'If-None-Match': sheet.headers.get('etag') })).status, 304);
  const head = await call('HEAD', '/alpha/css/app.css?scope=work');
  assert.equal(head.data, '');
  assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(sheet.data));
  assert.equal((await call('GET', '/beta/css/app.css?scope=work')).status, 404, 'beta has no such sheet: as before');

  // The kit's sheets at the module's path, the same way; the file itself, as always.
  const kit = await call('GET', '/alpha/suite/kit.css?scope=work');
  assert.equal(kit.status, 200);
  assert.match(kit.data, /@scope \(\[data-module="alpha"\], \[data-owner="alpha"\]\) \{/);
  assert.notEqual(kit.headers.get('etag'), sheet.headers.get('etag'), 'one ETag for each sheet');
  assert.equal((await call('GET', '/alpha/css/app.css')).data, own);
  assert.equal((await call('GET', '/alpha/css/app.css?scope=other')).data, own);
  assert.equal((await call('GET', '/alpha/css/nothing.css?scope=work')).status, 404);
});

test('without scopedSheets, ?scope=work is a query like any other', async (t) => {
  const own = fs.readFileSync(new URL('./fixtures/host/alpha/public/css/app.css', import.meta.url), 'utf8');
  const { call } = await startHost(t);
  const sheet = await call('GET', '/alpha/css/app.css?scope=work');
  assert.equal(sheet.status, 200);
  assert.equal(sheet.data, own);
});

/** The host's session cookie for its first administrator. */
async function adminCookie(base) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'root-password' }),
  });
  return res.headers.getSetCookie().find((c) => c.startsWith('work_sid=')).split(';')[0];
}

/** A stream of the host's, read as it comes: `until(pattern)` waits for it (no pattern: its end), `messages()` parses it. */
async function stream(base, pathname, headers = {}) {
  const controller = new AbortController();
  const res = await fetch(base + pathname, { headers, signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let ended = false;
  const until = async (pattern = null) => {
    while (!(pattern && pattern.test(text)) && !ended) {
      const { value, done } = await reader.read();
      if (done) ended = true;
      else text += decoder.decode(value);
    }
  };
  const messages = () => text.split('\n\n').filter((block) => /^data: /m.test(block)).map((block) => ({
    id: /^id: (.+)$/m.exec(block)?.[1] ?? null,
    ...JSON.parse(/^data: (.*)$/m.exec(block)[1]),
  }));
  return { res, until, messages, text: () => text, ended: () => ended, stop: () => controller.abort() };
}

test('one live channel for every module (liveAll): each module’s notices for this person, as { module, event, data }', async (t) => {
  const { host, call } = await startHost(t, { liveAll: true });
  const base = `http://127.0.0.1:${host.server.address().port}`;
  const [alpha, beta] = host.modules;
  const refused = await call('GET', '/api/events?all');
  assert.equal(refused.status, 401, 'with the host’s session only');
  assert.deepEqual(refused.data, { error: 'unauthorized' });
  const cookie = await adminCookie(base);
  const me = host.suite.accounts.byUsername('admin');

  const all = await stream(base, '/api/events?all', { Cookie: cookie });
  t.after(() => all.stop());
  assert.equal(all.res.status, 200);
  assert.match(all.res.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(all.res.headers.get('x-accel-buffering'), 'no');
  await all.until(/"event":"hello"/);
  assert.match(all.text(), /^retry: 3000\n\n/);
  const [hello] = all.messages();
  assert.deepEqual({ module: hello.module, event: hello.event, data: hello.data }, { module: null, event: 'hello', data: { user_id: me.id } });
  assert.match(hello.id, /^alpha=[\w-]+\.\d+,beta=[\w-]+\.\d+$/, 'where it is in every module');
  assert.equal(alpha.suite.live.connected(), 1);
  assert.equal(beta.suite.live.connected(), 1);

  alpha.suite.live.publish({ audience: [me.id + 1], data: { item: 'someone else’s' } });
  alpha.suite.live.publish({ audience: [me.id], data: { item: 1 } });
  beta.suite.live.publish({ event: 'links', data: { ref: 'beta:item:2' } });
  await all.until(/"module":"beta"/);
  const told = all.messages().slice(1);
  assert.deepEqual(told.map(({ module, event, data }) => ({ module, event, data })), [
    { module: 'alpha', event: 'change', data: { item: 1 } },
    { module: 'beta', event: 'links', data: { ref: 'beta:item:2' } },
  ], 'only what reaches this person, each with its module');
  assert.doesNotMatch(all.text(), /^event: /m, 'unnamed messages: the page reads them all with onmessage');
  assert.match(told[1].id, /^alpha=[\w-]+\.2,beta=[\w-]+\.1$/);

  // Coming back with its id: what it missed, module by module.
  all.stop();
  beta.suite.live.publish({ audience: [me.id], data: { missed: true } });
  const back = await stream(base, '/api/events?all', { Cookie: cookie, 'Last-Event-ID': told[1].id });
  t.after(() => back.stop());
  await back.until(/"event":"hello"/);
  assert.deepEqual(back.messages().map(({ module, event, data }) => ({ module, event, data })), [
    { module: 'beta', event: 'change', data: { missed: true } },
    { module: null, event: 'hello', data: { user_id: me.id, replayed: true } },
  ], 'and hello says so: the page needn’t reload everything');
  // An id of another run: everything reloaded, module by module.
  const lost = await stream(base, '/api/events?all', { Cookie: cookie, 'Last-Event-ID': 'alpha=old.1' });
  t.after(() => lost.stop());
  await lost.until(/"event":"hello"/);
  assert.deepEqual(lost.messages().map(({ module, event }) => [module, event]), [['alpha', 'resync'], ['beta', 'resync'], [null, 'hello']]);

  // Signed out everywhere: a module's last word, and the stream ends, in every module.
  alpha.suite.live.dropUser(me.id, { last: { event: 'account', data: { user_id: me.id } } });
  await back.until(/"event":"account"/);
  await back.until();
  assert.equal(back.ended(), true, 'the stream ends with its channels');
  assert.equal(alpha.suite.live.connected(), 0);
  assert.equal(beta.suite.live.connected(), 0, 'every module lets go of it');
});

test('one live channel for every module ends when its session does: signing out closes it', async (t) => {
  const { host } = await startHost(t, { liveAll: true });
  const base = `http://127.0.0.1:${host.server.address().port}`;
  const [alpha, beta] = host.modules;
  const cookie = await adminCookie(base);
  const other = await adminCookie(base);
  const all = await stream(base, '/api/events?all', { Cookie: cookie });
  const stays = await stream(base, '/api/events?all', { Cookie: other });
  t.after(() => { all.stop(); stays.stop(); });
  await all.until(/"event":"hello"/);
  await stays.until(/"event":"hello"/);
  assert.equal(alpha.suite.live.connected(), 2);

  const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: base } });
  assert.equal(logout.status, 200);
  await all.until(/"event":"account"/);
  await all.until();
  assert.equal(all.ended(), true, 'the signed-out browser’s stream ends');
  assert.equal(alpha.suite.live.connected(), 1);
  assert.equal(beta.suite.live.connected(), 1, 'the other browser’s stays, in every module');
  assert.equal(stays.ended(), false);
});

test('without liveAll, /api/events?all is the host’s own channel, as before', async (t) => {
  const { host, call } = await startHost(t);
  const base = `http://127.0.0.1:${host.server.address().port}`;
  assert.equal((await call('GET', '/api/events?all')).status, 401);
  const own = await stream(base, '/api/events?all', { Cookie: await adminCookie(base) });
  t.after(() => own.stop());
  await own.until(/event: hello/);
  assert.match(own.text(), /event: hello\ndata: \{"user_id":\d+\}/, 'a named hello, the root’s');
  assert.equal(host.modules[0].suite.live.connected(), 0, 'no module’s');
});

test('a host with first questions asks them once, keeps the answers and shows them to the admin', async (t) => {
  const { call } = await startHost(t, { firstQuestions: true });
  assert.equal((await call('PUT', '/api/me/first-answers', { heard_from: 'reddit' })).status, 401, 'signed in only');
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  assert.equal((await call('GET', '/api/modules')).data.first_questions, true, 'not asked yet');

  assert.equal((await call('PUT', '/api/me/first-answers', { heard_from: 'tv' })).data.field, 'heard_from', 'only the options there are');
  assert.equal((await call('PUT', '/api/me/first-answers', { has_channel: 'yes' })).data.field, 'has_channel');
  assert.equal((await call('PUT', '/api/me/first-answers', { has_channel: true, channel: 'x'.repeat(301) })).data.error, 'field_too_long');
  assert.equal((await call('GET', '/api/modules')).data.first_questions, true, 'nothing kept from a refused answer');

  const answered = await call('PUT', '/api/me/first-answers', { heard_from: 'reddit', has_channel: true, channel: '  https://youtube.com/@me ' });
  assert.deepEqual(answered.data, { first_questions: false });
  assert.equal((await call('GET', '/api/modules')).data.first_questions, false, 'asked once');
  const seen = (await call('GET', '/api/admin/users/1/first-answers')).data.answers;
  assert.deepEqual({ ...seen, answered_at: typeof seen.answered_at },
    { heard_from: 'reddit', has_channel: true, channel: 'https://youtube.com/@me', answered_at: 'string' });

  // Skipped: a row with nothing in it, and no channel's address without a channel.
  await call('PUT', '/api/me/first-answers', {});
  assert.deepEqual({ ...(await call('GET', '/api/admin/users/1/first-answers')).data.answers, answered_at: null },
    { heard_from: null, has_channel: null, channel: null, answered_at: null });
  await call('PUT', '/api/me/first-answers', { has_channel: false, channel: 'https://ignored.example' });
  assert.equal((await call('GET', '/api/admin/users/1/first-answers')).data.answers.channel, null);
  assert.equal((await call('GET', '/api/admin/users/99/first-answers')).status, 404);
});

test('a host without first questions neither asks nor answers them', async (t) => {
  const { call } = await startHost(t);
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  assert.equal('first_questions' in (await call('GET', '/api/modules')).data, false);
  assert.equal((await call('PUT', '/api/me/first-answers', {})).status, 404);
  assert.equal((await call('GET', '/api/admin/users/1/first-answers')).status, 404);
});
