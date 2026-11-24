/**
 * A host's sample data (host.js `sampleData`, sample-data.js) over real HTTP: Settings' routes at
 * the root, `suite.sampleData` for the host's own code, and nothing of it without the option.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './remote-provider.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHost } from '../host.js';
import { todayFor } from '../time.js';

const HOST = {
  app: { id: 'work', name: 'Work', color: '#3A4660', icon: '/icons/work.svg', languages: ['en', 'es', 'fr'] },
  modules: { live: true },
  accounts: { minPasswordLength: 8 },
};

const fixture = (name, query) => new URL(`./fixtures/host/${name}/module.js${query}`, import.meta.url);
let fresh = 0;

async function startHost(t, options = {}) {
  fresh += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-sample-'));
  const host = await createHost({
    config: HOST,
    modules: [
      { mount: 'alpha', entry: fixture('alpha', `?sample=${fresh}`) },
      { mount: 'beta', entry: fixture('beta', `?sample=${fresh}`) },
    ],
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1' },
    version: '9.9.9', handleSignals: false, exitOnError: false, log: () => {}, ...options,
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
    return { status: res.status, data };
  };
  return { host, call };
}

test('Settings add the example in every module, say where it is, refuse a second one and take it away', async (t) => {
  const { host, call } = await startHost(t, { sampleData: { examples: ['cafe', 'app'], words: 'samples.' } });
  assert.equal((await call('GET', '/api/me/sample-data')).status, 401, 'only for someone signed in');
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  assert.deepEqual((await call('GET', '/api/me/sample-data')).data, { present: false, example: null, modules: [], available: ['alpha', 'beta'], examples: ['cafe', 'app'] });
  // The example chosen and the language asked for (Settings send the page's), else the browser's.
  assert.equal((await call('POST', '/api/me/sample-data', { example: 'castle' })).status, 400);
  const added = await call('POST', '/api/me/sample-data', { locale: 'fr', example: 'app' });
  assert.equal(added.status, 201);
  assert.deepEqual(added.data, { present: true, example: 'app', modules: ['alpha', 'beta'], failed: [], links: 1 });
  const admin = host.suite.accounts.byUsername?.('admin') || host.suite.database.get("SELECT * FROM users WHERE username = 'admin'");
  const today = todayFor(admin);
  assert.deepEqual((await call('GET', '/alpha/api/items')).data.items, [`alpha_items app fr ${today}`, 'alpha_items shared']);
  // The two anchors are linked, as the module's own links show them.
  const alphaShared = host.suite.database.get("SELECT id FROM alpha_items WHERE text = 'alpha_items shared'").id;
  const linked = await call('GET', `/api/links?ref=alpha:item:${alphaShared}`);
  assert.equal(linked.status, 200);
  assert.equal(linked.data.links?.length, 1);
  assert.equal(linked.data.links[0].item.title, 'beta_items shared');

  const again = await call('POST', '/api/me/sample-data', {});
  assert.equal(again.status, 409);
  assert.equal(again.data.error, 'sample_data_present');
  assert.equal((await call('POST', '/api/me/sample-data', { locale: 7 })).status, 400);

  // The person changes one thing of the example: all of it goes all the same.
  host.suite.database.run("UPDATE beta_items SET text = 'changed' WHERE text = 'beta_items shared'");
  const removed = await call('DELETE', '/api/me/sample-data');
  assert.deepEqual(removed.data, { present: false, removed: 4, failed: [] });
  assert.deepEqual((await call('GET', '/alpha/api/items')).data.items, []);
  assert.deepEqual((await call('GET', '/beta/api/items')).data.items, []);
  assert.deepEqual((await call('GET', '/api/me/sample-data')).data.present, false);

  // Without a language, the browser's.
  const browser = await call('POST', '/api/me/sample-data', {}, { 'Accept-Language': 'es-ES,es;q=0.9' });
  assert.equal(browser.status, 201);
  assert.ok((await call('GET', '/alpha/api/items')).data.items.includes(`alpha_items cafe es ${today}`), 'the first example by default');
});

test('the host’s own code seeds the same way, and each module’s Settings know the host has it', async (t) => {
  const { host, call } = await startHost(t, { sampleData: true });
  const user = host.suite.accounts.create({ username: 'eva', password: 'eva-password', email: 'eva@example.com' });
  const answer = await host.suite.sampleData?.seed(user, { locale: 'es' });
  assert.deepEqual(answer.modules, ['alpha', 'beta']);
  assert.equal(answer.example, 'default', 'one example with `true`');
  assert.equal(host.suite.sampleData.status(user).present, true);
  assert.equal(host.suite.sampleData.remove(user).present, false);
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  const where = await call('GET', '/alpha/api/where');
  assert.deepEqual(where.data.host.sampleData, { examples: ['default'], words: null });
});

test('without the option there is none of it', async (t) => {
  const { host, call } = await startHost(t);
  assert.equal(host.suite.sampleData, undefined);
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  assert.equal((await call('GET', '/api/me/sample-data')).status, 404);
  assert.equal((await call('POST', '/api/me/sample-data', {})).status, 404);
  assert.equal((await call('GET', '/alpha/api/where')).data.host.sampleData, undefined);
});
