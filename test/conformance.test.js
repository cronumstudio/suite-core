import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createSuite, createApp } from '../app.js';
import { checkConformance } from '../tools/conformance.js';

const PRODUCT = { app: { id: 'demo', name: 'Demo', port: 3999, languages: ['en', 'es'] } };

const HELLO = {
  instructions: 'Says hello.',
  tools: [{
    name: 'hello', title: 'Hello', description: 'Says hello',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ content: [{ type: 'text', text: 'Hello.' }] }),
  }],
};

async function demoApp(t, catalogs, { modules = undefined, mcp = HELLO } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-conformance-'));
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(path.join(publicDir, 'i18n'), { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!DOCTYPE html><title>Demo</title>');
  for (const [lang, catalog] of Object.entries(catalogs)) {
    fs.writeFileSync(path.join(publicDir, 'i18n', `${lang}.json`), JSON.stringify(catalog));
  }
  const quiet = () => {};
  const suite = createSuite({
    config: modules ? { ...PRODUCT, modules } : PRODUCT,
    env: { DATA_DIR: dir, PORT: '0', ADMIN_USER: 'checker', ADMIN_PASSWORD: 'checker-password', BASE_URL: 'http://127.0.0.1' },
    log: quiet, exitOnError: false,
  });
  const app = createApp({ suite, publicDir, version: '1.0.0', handleSignals: false, log: quiet, mcp });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

const failures = (results) => results.filter((r) => !r.ok).map((r) => `${r.name} → ${r.detail}`);

test('an app made of the suite passes every conformance check', async (t) => {
  const baseUrl = await demoApp(t, { en: { hello: { title: 'Hello' } }, es: { hello: { title: 'Hola' } } });
  const results = await checkConformance({ baseUrl, username: 'checker', password: 'checker-password' });
  assert.deepEqual(failures(results), []);
  const names = results.filter((r) => !r.skipped).map((r) => r.name);
  for (const expected of [
    '/health answers ok, with the version',
    'Security headers on an unknown /api path',
    '/mcp without a token is a 401 with a Bearer challenge',
    'The challenge points at protected-resource metadata that answers',
    '/i18n/es.json says everything English says',
    'Only the merged catalogs are served under /i18n/',
    'The brute-force brake answers 429 too_many_attempts',
    'Signing in with the right password opens a session',
    'A request with the session from another site is refused (CSRF)',
    'After signing out the old cookie opens nothing',
  ]) assert.ok(names.includes(expected), `ran: ${expected}`);

  // The brake's failures were a made-up user's: the real account still signs in, every time.
  const again = await checkConformance({ baseUrl, username: 'checker', password: 'checker-password', brake: false });
  assert.deepEqual(failures(again), []);
});

test('without credentials the sign-in checks are skipped, the rest still run', async (t) => {
  const baseUrl = await demoApp(t, { en: { hello: { title: 'Hello' } }, es: { hello: { title: 'Hola' } } });
  const results = await checkConformance({ baseUrl, brake: false });
  assert.deepEqual(failures(results), []);
  assert.ok(results.some((r) => r.skipped && r.name === 'Sign-in with a password'));
  assert.ok(results.some((r) => !r.skipped && r.name === 'A request with a session cookie from another site is refused (CSRF)'));
});

test('an app with its MCP off: no /mcp and no OAuth metadata for AI clients, checked when asked', async (t) => {
  const catalogs = { en: { hello: { title: 'Hello' } }, es: { hello: { title: 'Hola' } } };
  const baseUrl = await demoApp(t, catalogs, { modules: { mcp: false, oauth: false }, mcp: HELLO });
  const results = await checkConformance({ baseUrl, brake: false, mcp: false });
  assert.deepEqual(failures(results), []);
  const ran = results.filter((r) => !r.skipped).map((r) => r.name);
  assert.ok(ran.includes('Without an MCP, /mcp is a JSON 404 with no challenge'));
  assert.ok(ran.includes('Without an MCP, no OAuth metadata for AI clients: a JSON 404 with no challenge'));
  assert.ok(results.some((r) => r.skipped && r.name === '/mcp without a token is a 401 with a Bearer challenge'));

  // The built-in OAuth for local accounts is a switch of its own: left on, its metadata is named.
  const withOAuth = await demoApp(t, catalogs, { modules: { mcp: false }, mcp: HELLO });
  assert.deepEqual(failures(await checkConformance({ baseUrl: withOAuth, brake: false, mcp: false })), [
    'Without an MCP, no OAuth metadata for AI clients: a JSON 404 with no challenge → '
      + '/.well-known/oauth-protected-resource 200, /.well-known/oauth-protected-resource/mcp 200, /.well-known/oauth-authorization-server 200',
  ]);
  // And an app with its MCP on, checked as if it had none, is told so.
  const on = await demoApp(t, catalogs);
  const named = failures(await checkConformance({ baseUrl: on, brake: false, mcp: false })).map((line) => line.split(' → ')[0]);
  assert.deepEqual(named, ['Without an MCP, /mcp is a JSON 404 with no challenge',
    'Without an MCP, no OAuth metadata for AI clients: a JSON 404 with no challenge']);
});

test('a missing translation is named', async (t) => {
  const baseUrl = await demoApp(t, { en: { hello: { title: 'Hello', body: 'Hi there' } }, es: { hello: { title: 'Hola' } } });
  const results = await checkConformance({ baseUrl, brake: false });
  assert.deepEqual(failures(results), ['/i18n/es.json says everything English says → 1 missing: hello.body']);
});

test('a server that is not made of the suite fails, and says where', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'text/html' });
    res.end(req.url === '/health' ? 'ok' : '<!DOCTYPE html><p>Not here</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const results = await checkConformance({ baseUrl: `http://127.0.0.1:${server.address().port}`, brake: false });
  const failed = failures(results).map((line) => line.split(' → ')[0]);
  for (const expected of [
    '/health answers ok, with the version',
    'Security headers on /health',
    '/.well-known/openid-configuration is a JSON 404, never the app\'s page',
    '/mcp without a token is a 401 with a Bearer challenge',
    '/api/auth/config names the provider and the languages',
    'A request with a session cookie from another site is refused (CSRF)',
  ]) assert.ok(failed.includes(expected), `fails: ${expected}`);
});

test('a catalog served by name on a case-insensitive disk is named', async (t) => {
  // What an app that let /i18n/ fall through to its static files answers on Windows.
  const server = http.createServer((req, res) => {
    const lang = /^\/i18n\/(\w+)\.json$/i.exec(req.url)?.[1].toLowerCase();
    if (req.url === '/api/auth/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ provider: 'local', app: { languages: ['en'] } }));
    } else if (lang === 'en') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"hello":"Hello"}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const results = await checkConformance({ baseUrl: `http://127.0.0.1:${server.address().port}`, brake: false });
  const catalogs = results.find((r) => r.name === 'Only the merged catalogs are served under /i18n/');
  assert.equal(catalogs.ok, false);
  assert.equal(catalogs.detail, '/i18n/EN.json 200, /I18N/en.json 200');
  assert.ok(results.find((r) => r.name === 'A language the app does not have is a 404').ok);
});
