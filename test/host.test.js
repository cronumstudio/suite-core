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
import os from 'node:os';
import path from 'node:path';
import { createHost, joinHost, mountManifest, mountedPath } from '../host.js';
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

  // One sign-in for every module: the host's cookie.
  assert.equal((await call('GET', '/alpha/api/items')).status, 401);
  const signedIn = await call('POST', '/alpha/api/auth/login', { username: 'admin', password: 'root-password' });
  assert.equal(signedIn.data.user.username, 'admin');
  assert.equal((await call('GET', '/beta/api/auth/me')).data.user.username, 'admin', 'signed in for beta too');
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
  assert.deepEqual(where.host, { id: 'work', name: 'Work', mount: 'alpha', base: '/alpha/' });

  // What each module is, for the host's pages.
  assert.deepEqual((await call('GET', '/api/modules')).data.modules, [
    { mount: 'alpha', path: '/alpha/', id: 'alpha', name: 'Alpha', color: '#EF4B2A', icon: '/alpha/icons/alpha.svg?v=1' },
    { mount: 'beta', path: '/beta/', id: 'beta', name: 'Beta', color: '#7C3AED', icon: '/beta/icons/favicon.svg' },
  ]);

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
  assert.deepEqual(database.all('SELECT DISTINCT scope FROM schema_migrations ORDER BY scope').map((r) => r.scope), ['alpha', 'beta', 'suite']);
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

test('a host with pages of its own serves them at the root, and its own routes', async (t) => {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-host-public-'));
  t.after(() => fs.rmSync(publicDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!DOCTYPE html><title>Which one?</title>');
  const { call } = await startHost(t, { publicDir, routes: (api) => api.get('/api/hello', (ctx) => ctx.res.end('hi')) });
  assert.match((await call('GET', '/')).data, /Which one\?/);
  assert.equal((await call('GET', '/api/hello')).data, 'hi');
  assert.equal((await call('GET', '/api/modules')).data.modules.length, 2);
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
