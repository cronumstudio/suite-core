/**
 * An app's old address with WorkOS (legacy-domains.js): the metadata and the
 * 401 name that address, and a token must be for it. The rest (pages, the
 * connector's tools) runs in a real host in host.test.js.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLegacyDomains, parseLegacyDomains } from '../legacy-domains.js';

const AUTHKIT = 'https://auth.example.test';

test('with WorkOS, an old address describes itself and takes only tokens for it', async (t) => {
  const audiences = [];
  const suite = {
    tokens: { authenticate: () => null },
    oauth: null,
    devices: null,
    limiter: null,
    entitlements: { describe: () => ({ features: {} }) },
    workos: {
      userFromToken: async (token, { audience }) => {
        audiences.push(audience);
        return token === 'for-old' ? { id: 1, username: 'ada' } : null;
      },
      resourceMetadata: (resource, name) => ({ resource, authorization_servers: [AUTHKIT], resource_name: name }),
      authorizationServerMetadata: async () => ({ issuer: AUTHKIT }),
    },
  };
  const tasks = {
    mount: 'tasks',
    config: { app: { id: 'tasks', name: 'Tasks' } },
    parts: {
      version: '1.0.0',
      mcp: {
        instructions: 'Tasks keeps lists.',
        tools: [{ name: 'list_tasks', description: 'Lists', inputSchema: { type: 'object' }, handler: async () => ({ content: [{ type: 'text', text: '[]' }] }) }],
      },
    },
    view: { entitlements: { allows: () => true } },
  };
  const { domains, errors } = parseLegacyDomains('tasks.example.test=tasks', { mounts: ['tasks'], baseUrl: 'https://work.example.test' });
  assert.deepEqual(errors, []);
  const legacy = createLegacyDomains({
    domains, modules: [tasks], suite, uses: () => true, hostName: 'Work', baseUrl: 'https://work.example.test',
    https: true, version: '9.9.9', mcp: true,
  });
  assert.equal(legacy.match({ headers: { host: 'Tasks.Example.Test:443' } }), 'tasks.example.test');
  assert.equal(legacy.match({ headers: { host: 'work.example.test' } }), null);
  // fetch can't set Host: every request here is taken as one to the old address.
  const server = http.createServer((req, res) => {
    legacy.handle(req, res, new URL(req.url, 'http://x'), 'tasks.example.test');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const call = (method, pathname, body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  });

  const metadata = await (await call('GET', '/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(metadata.resource, 'https://tasks.example.test/mcp', 'the old address, not the host’s');
  assert.equal(metadata.resource_name, 'Tasks');
  assert.equal((await call('GET', '/.well-known/oauth-protected-resource')).status, 200);
  assert.equal((await (await call('GET', '/.well-known/oauth-authorization-server')).json()).issuer, AUTHKIT);

  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const refused = await call('POST', '/mcp', rpc, { Authorization: 'Bearer for-another-app' });
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get('www-authenticate'),
    'Bearer resource_metadata="https://tasks.example.test/.well-known/oauth-protected-resource/mcp", error="invalid_token"');
  const listed = await (await call('POST', '/mcp', rpc, { Authorization: 'Bearer for-old' })).json();
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['list_tasks']);
  assert.ok(audiences.every((a) => a === 'https://tasks.example.test/mcp'), 'every token checked for the old address');

  const page = await call('GET', '/lists/2');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), 'https://work.example.test/tasks/lists/2');
});
