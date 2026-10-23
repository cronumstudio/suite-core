/**
 * An app's old address (legacy-domains.js) on its own: no connector and no
 * OAuth metadata there, its pages to the module. The rest runs in a real host
 * in host.test.js.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLegacyDomains, parseLegacyDomains } from '../legacy-domains.js';

test('an old address: its /mcp names the host’s, no metadata names it, its pages go to the module', async (t) => {
  const { domains, errors } = parseLegacyDomains('tasks.example.test=tasks', { mounts: ['tasks'], baseUrl: 'https://work.example.test' });
  assert.deepEqual(errors, []);
  const legacy = createLegacyDomains({ domains, baseUrl: 'https://work.example.test/', https: true });
  assert.equal(legacy.match({ headers: { host: 'Tasks.Example.Test:443' } }), 'tasks.example.test');
  assert.equal(legacy.match({ headers: { host: 'work.example.test' } }), null);
  // fetch can't set Host: every request here is taken as one to the old address.
  const server = http.createServer((req, res) => {
    legacy.handle(req, res, new URL(req.url, 'http://x'), 'tasks.example.test');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const ask = (method, pathname) => fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { method, redirect: 'manual' });

  const gone = await ask('POST', '/mcp');
  assert.equal(gone.status, 404);
  assert.deepEqual(await gone.json(), { error: 'not_found', mcp: 'https://work.example.test/mcp' });
  assert.equal((await ask('GET', '/.well-known/oauth-protected-resource/mcp')).status, 404);
  assert.equal((await ask('GET', '/.well-known/oauth-protected-resource')).status, 404);
  assert.equal((await ask('GET', '/.well-known/oauth-authorization-server')).status, 404);
  const page = await ask('GET', '/lists/2');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), 'https://work.example.test/tasks/lists/2');
});
