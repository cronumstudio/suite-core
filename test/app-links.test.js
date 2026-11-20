/**
 * Links to the site that open the app on a phone (app-links.js): suite.config.js `appLinks` with
 * the install's Team ID and signing certificate, and the two files a phone asks for, served by a
 * host whose page is its root as by an app on its own.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../config.js';
import { createHost } from '../host.js';
import { ANDROID_PATH, APPLE_PATH, SUITE_EXCLUDED, appleAssociation, assetLinks, fingerprintOf } from '../app-links.js';

const PRODUCT = { app: { id: 'demo', name: 'Demo' } };
const SHA = '14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5';
const LINKS = {
  paths: ['/', '/tasks/*', '/?open=*'],
  exclude: ['/tasks/print/*'],
  apple: { bundleId: 'com.example.app' },
  android: { package: 'com.example.app' },
};
const resolve = (appLinks, env = {}) => resolveConfig({ ...PRODUCT, appLinks }, { DATA_DIR: os.tmpdir(), ...env });

test('appLinks: the product’s pages and ids, the Team ID and the certificate from the install', () => {
  const config = resolve(LINKS, { APPLE_TEAM_ID: 'ABCDE12345', ANDROID_CERT_SHA256: `${SHA.replace(/:/g, '').toLowerCase()}, ${SHA}` });
  assert.deepEqual(config.errors, []);
  assert.deepEqual(config.warnings.filter((w) => w.startsWith('appLinks')), []);
  assert.deepEqual(config.appLinks, {
    paths: ['/', '/tasks/*', '/?open=*'], exclude: ['/tasks/print/*'],
    apple: { appIds: ['ABCDE12345.com.example.app'] },
    android: { package: 'com.example.app', sha256: [SHA] },
  }, 'either way of writing the fingerprint, as Google writes it, once');

  // APNs' Team ID is the same team's; the install's own wins.
  assert.deepEqual(resolve(LINKS, { APNS_TEAM_ID: 'APNS123456' }).appLinks.apple, { appIds: ['APNS123456.com.example.app'] });
  assert.deepEqual(resolve(LINKS, { APNS_TEAM_ID: 'APNS123456', APPLE_TEAM_ID: 'ABCDE12345' }).appLinks.apple, { appIds: ['ABCDE12345.com.example.app'] });
  // Given in the product, for an app whose ids are no secret of an install's.
  const inProduct = resolve({ ...LINKS, apple: { bundleId: 'com.example.app', teamId: 'TEAMID0001' }, android: { package: 'com.example.app', sha256: [SHA] } });
  assert.deepEqual([inProduct.appLinks.apple, inProduct.appLinks.android.sha256], [{ appIds: ['TEAMID0001.com.example.app'] }, [SHA]]);
  // Without appLinks, nothing.
  assert.equal(resolveConfig(PRODUCT, { DATA_DIR: os.tmpdir() }).appLinks, null);
});

test('appLinks: the install’s values missing or wrong turn that phone’s file off with a word; the product’s stop the start', () => {
  const missing = resolve(LINKS);
  assert.deepEqual(missing.errors, []);
  assert.deepEqual([missing.appLinks.apple, missing.appLinks.android], [null, null]);
  assert.ok(missing.warnings.includes('appLinks: links don’t open the iPhone app, APPLE_TEAM_ID is missing'));
  assert.ok(missing.warnings.includes('appLinks: links don’t open the Android app, ANDROID_CERT_SHA256 is missing'));
  const wrong = resolve(LINKS, { APPLE_TEAM_ID: 'abc', ANDROID_CERT_SHA256: `${SHA},12:34` });
  assert.deepEqual(wrong.errors, []);
  assert.deepEqual([wrong.appLinks.apple, wrong.appLinks.android], [null, null], 'one bad fingerprint turns it off: never a file with half the certificates');
  assert.ok(wrong.warnings.some((w) => /APPLE_TEAM_ID is not a Team ID/.test(w)));
  assert.ok(wrong.warnings.some((w) => /ANDROID_CERT_SHA256 has a value that is not a SHA-256/.test(w)));
  // Only the phone the product names.
  const appleOnly = resolve({ paths: ['/'], apple: { bundleId: 'com.example.app' } }, { APPLE_TEAM_ID: 'ABCDE12345' });
  assert.deepEqual([appleOnly.errors, appleOnly.appLinks.android, appleOnly.warnings.filter((w) => w.startsWith('appLinks'))], [[], null, []]);

  const errorsOf = (appLinks) => resolve(appLinks).errors;
  assert.match(errorsOf('yes')[0], /^appLinks: an object/);
  assert.match(errorsOf({ ...LINKS, path: ['/'] })[0], /appLinks\.path is not a setting/);
  assert.match(errorsOf({ ...LINKS, paths: [] })[0], /appLinks\.paths: the pages/);
  assert.match(errorsOf({ ...LINKS, paths: ['tasks/*'] })[0], /"tasks\/\*" is not a path starting with \//);
  assert.match(errorsOf({ ...LINKS, exclude: '/x' })[0], /appLinks\.exclude: a list/);
  assert.match(errorsOf({ paths: ['/'] })[0], /apple, android or both/);
  assert.match(errorsOf({ ...LINKS, apple: { bundle: 'com.example.app' } }).join('\n'), /appLinks\.apple\.bundle is not a setting/);
  assert.match(errorsOf({ ...LINKS, apple: { bundleId: 'app' } })[0], /appLinks\.apple\.bundleId/);
  assert.match(errorsOf({ ...LINKS, apple: { bundleId: 'com.example.app', teamId: 'x' } })[0], /appLinks\.apple\.teamId/);
  assert.match(errorsOf({ ...LINKS, android: { package: '1.app' } })[0], /appLinks\.android\.package/);
  assert.match(errorsOf({ ...LINKS, android: { package: 'com.example.app', sha256: ['AB'] } })[0], /appLinks\.android\.sha256/);
  assert.equal(fingerprintOf('nope'), null);
});

test('Apple’s file: the suite’s addresses and the checkout’s way back first, never opened in the app, then the pages', () => {
  const links = resolve(LINKS, { APPLE_TEAM_ID: 'ABCDE12345', ANDROID_CERT_SHA256: SHA }).appLinks;
  const file = appleAssociation(links);
  const [details] = file.applinks.details;
  assert.deepEqual(details.appIDs, ['ABCDE12345.com.example.app']);
  const excluded = details.components.filter((c) => c.exclude).map((c) => c['/']);
  for (const pattern of ['/api/*', '/*/api/*', '/auth/*', '/*/auth/*', '/oauth/*', '/authorize*', '/token*', '/mcp*', '/admin*', '/devices/*', '/.well-known/*', '/tasks/print/*']) {
    assert.ok(excluded.includes(pattern), pattern);
  }
  assert.deepEqual(details.components.find((c) => c['?']), { '/': '*', '?': { billing: '?*' }, exclude: true });
  const first = details.components.findIndex((c) => !c.exclude);
  assert.ok(details.components.slice(first).every((c) => !c.exclude), 'every exclusion before the first page: Apple takes the first that matches');
  assert.deepEqual(details.components.slice(first), [{ '/': '/' }, { '/': '/tasks/*' }, { '/': '/?open=*' }]);
  assert.equal(SUITE_EXCLUDED.length, new Set(SUITE_EXCLUDED).size);

  assert.deepEqual(assetLinks(links), [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: 'com.example.app', sha256_cert_fingerprints: [SHA] },
  }]);
});

/** A host whose page is its root (Cronum Work's shell), with `appLinks` as given. */
async function startHost(t, appLinks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-links-'));
  const page = path.join(dir, 'page');
  fs.mkdirSync(page);
  fs.writeFileSync(path.join(page, 'index.html'), '<!DOCTYPE html><title>Desk</title>');
  const fixture = (name) => new URL(`./fixtures/host/${name}/module.js?links=${Math.random()}`, import.meta.url);
  const host = await createHost({
    config: { app: { id: 'work', name: 'Work', languages: ['en', 'es'] }, ...(appLinks ? { appLinks } : {}) },
    modules: [{ mount: 'alpha', entry: fixture('alpha') }, { mount: 'beta', entry: fixture('beta') }],
    pages: [{ at: '/w/', dir: page, root: true }],
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1' },
    version: '9.9.9', handleSignals: false, exitOnError: false, log: () => {},
  });
  const server = await host.listen();
  t.after(async () => {
    await host.close();
    host.suite.database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return (pathname, method = 'GET') => fetch(base + pathname, { method, redirect: 'manual' });
}

test('a host whose page is the root serves both files at once: JSON, with no session, no redirect, kept an hour', async (t) => {
  const get = await startHost(t, { ...LINKS, apple: { ...LINKS.apple, teamId: 'ABCDE12345' }, android: { ...LINKS.android, sha256: [SHA] } });
  for (const [pathname, check] of [
    [APPLE_PATH, (body) => assert.deepEqual(body.applinks.details[0].appIDs, ['ABCDE12345.com.example.app'])],
    [ANDROID_PATH, (body) => assert.equal(body[0].target.sha256_cert_fingerprints[0], SHA)],
  ]) {
    const res = await get(pathname);
    assert.equal(res.status, 200, pathname);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
    assert.equal(res.headers.get('location'), null);
    assert.equal(res.headers.get('set-cookie'), null, 'no session asked for or made');
    check(await res.json());
    const head = await get(pathname, 'HEAD');
    assert.deepEqual([head.status, await head.text()], [200, '']);
    assert.equal((await get(pathname, 'POST')).status, 404);
  }
  // The root page still answers `/`, and the rest of /.well-known/ is as before.
  assert.match(await (await get('/')).text(), /<title>Desk<\/title>/);
  assert.deepEqual(await (await get('/.well-known/apple-app-site-association.json')).json(), { error: 'not_found' });
  assert.equal((await get('/alpha/.well-known/assetlinks.json')).status, 404, 'a module’s path is not the site’s');
});

test('without appLinks, or without the install’s values, the files are the plain 404 of /.well-known/', async (t) => {
  for (const appLinks of [null, LINKS]) {
    const get = await startHost(t, appLinks);
    for (const pathname of [APPLE_PATH, ANDROID_PATH]) {
      const res = await get(pathname);
      assert.deepEqual([res.status, await res.json()], [404, { error: 'not_found' }], `${pathname} ${appLinks ? 'without the values' : 'without appLinks'}`);
    }
  }
});
