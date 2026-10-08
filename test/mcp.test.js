/**
 * The MCP transport on its own, with a two-tool app around it.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMcpServer, dailyLimitText, MAX_BATCH } from '../mcp.js';

class Unavailable extends Error {}
class NotFound extends Error {}

const USERS = { 'good-token': { id: 1, name: 'ada', plan: 'free' }, 'pro-token': { id: 2, name: 'bob', plan: 'pro' } };
let failures = 0;

async function start(t, overrides = {}) {
  const mcp = createMcpServer({
    serverInfo: { name: 'test', title: 'Test', version: '1.0.0' },
    instructions: 'Use the tools.',
    tools: [
      {
        name: 'greet', title: 'Greet', description: 'Says hello',
        inputSchema: { type: 'object', properties: { who: { type: 'string' } } },
        handler: (principal, args) => ({ content: [{ type: 'text', text: `Hello ${args.who}, from ${principal.name}` }] }),
      },
      {
        name: 'export_all', title: 'Export', description: 'A paid tool', feature: 'export',
        inputSchema: { type: 'object', properties: {} },
        handler: () => ({ content: [{ type: 'text', text: 'exported' }] }),
      },
      {
        name: 'find', title: 'Find', description: 'Fails on purpose',
        inputSchema: { type: 'object', properties: {} },
        handler: () => { throw new NotFound('No list called "shop".'); },
      },
    ],
    prompts: { list: () => [{ name: 'setup', description: 'Set up' }], get: (name) => (name === 'setup' ? { messages: [] } : null) },
    authenticate: async (token) => {
      if (token === 'down') throw new Unavailable('AuthKit does not answer');
      return USERS[token] || null;
    },
    challenge: (hadToken) => `Bearer resource_metadata="https://app.example/.well-known/oauth-protected-resource/mcp"${hadToken ? ', error="invalid_token"' : ''}`,
    oauthOffered: true,
    limiter: {
      checkToken: () => (failures > 3 ? { allowed: false, retryAfter: 60 } : { allowed: true }),
      tokenFailed: () => { failures++; },
      tokenSucceeded: () => { failures = 0; },
    },
    unavailable: (error) => error instanceof Unavailable,
    allows: (principal, tool) => (tool.feature === 'export' && principal.plan !== 'pro'
      ? 'Your plan (Free) does not include exporting.' : true),
    describeError: (error) => (error instanceof NotFound ? error.message : null),
    legacyTools: { saludar: 'greet' },
    legacyParams: { quien: 'who' },
    log: () => {},
    ...overrides,
  });
  const server = http.createServer((req, res) => mcp.handle(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (token, body, headers = {}) => fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
  const rpc = async (token, method, params = {}) => (await call(token, { jsonrpc: '2.0', id: 1, method, params })).json();
  return { mcp, base, call, rpc };
}

test('without a valid token: 401 pointing at OAuth, and the brake counts only bad tokens', async (t) => {
  failures = 0;
  const { call } = await start(t);
  const none = await call(null, { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate'), /resource_metadata=/);
  assert.doesNotMatch(none.headers.get('www-authenticate'), /invalid_token/, 'no token is not a bad token');
  assert.equal(failures, 0);
  const bad = await call('nope', { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.match(bad.headers.get('www-authenticate'), /invalid_token/);
  for (let i = 0; i < 4; i++) await call('nope', { jsonrpc: '2.0', id: 1, method: 'ping' });
  const slowed = await call('nope', { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(slowed.status, 429);
  assert.equal(slowed.headers.get('retry-after'), '60');
  assert.equal((await call('good-token', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200,
    'a good token is never blocked');
  assert.equal(failures, 0, 'and it clears the address');
});

test('a blocked address: no more failures written down, and a request without a token still gets its 401', async (t) => {
  failures = 0;
  const { call } = await start(t);
  for (let i = 0; i < 10; i++) await call('nope', { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(failures, 4, 'once blocked, the bucket stops growing with the attack');
  const none = await call(null, { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(none.status, 401, 'someone else behind that address can still start signing in');
  assert.match(none.headers.get('www-authenticate'), /resource_metadata=/);
  assert.equal((await call('nope', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 429);
  failures = 0;
});

test('a batch carries at most MAX_BATCH messages', async (t) => {
  const { call } = await start(t);
  const ping = (id) => ({ jsonrpc: '2.0', id, method: 'ping' });
  const full = await call('good-token', Array.from({ length: MAX_BATCH }, (_, i) => ping(i)));
  assert.equal(full.status, 200);
  assert.equal((await full.json()).length, MAX_BATCH);
  const over = await call('good-token', Array.from({ length: MAX_BATCH + 1 }, (_, i) => ping(i)));
  assert.equal(over.status, 400);
  assert.equal((await over.json()).error.code, -32600, 'refused whole, before any of it runs');
});

test('when tokens cannot be checked: 503, not a request for permission', async (t) => {
  const { call } = await start(t);
  const res = await call('down', { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '30');
  assert.equal(res.headers.get('www-authenticate'), null);
});

test('initialize, tools and prompts', async (t) => {
  const { call, rpc } = await start(t);
  const init = await call('good-token', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  const body = await init.json();
  assert.equal(body.result.protocolVersion, '2025-03-26');
  assert.equal(body.result.serverInfo.name, 'test');
  assert.equal(body.result.instructions, 'Use the tools.');
  assert.ok(init.headers.get('mcp-session-id'));
  const tools = (await rpc('good-token', 'tools/list')).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['greet', 'export_all', 'find'], 'old names are not announced');
  assert.equal((await rpc('good-token', 'prompts/list')).result.prompts[0].name, 'setup');
  assert.equal((await rpc('good-token', 'prompts/get', { name: 'nope' })).error.code, -32602);
  assert.equal((await rpc('good-token', 'no/such')).error.code, -32601);
});

test('tool calls: arguments, old names, plans and the app’s errors', async (t) => {
  const { rpc } = await start(t);
  const text = (r) => r.result.content[0].text;
  assert.equal(text(await rpc('good-token', 'tools/call', { name: 'greet', arguments: { who: 'you' } })), 'Hello you, from ada');
  assert.equal(text(await rpc('good-token', 'tools/call', { name: 'saludar', arguments: { quien: 'vos' } })),
    'Hello vos, from ada', 'a client with the old schema keeps working');
  const refused = await rpc('good-token', 'tools/call', { name: 'export_all' });
  assert.equal(refused.result.isError, true);
  assert.equal(text(refused), 'Your plan (Free) does not include exporting.');
  assert.equal(text(await rpc('pro-token', 'tools/call', { name: 'export_all' })), 'exported');
  const failed = await rpc('good-token', 'tools/call', { name: 'find' });
  assert.deepEqual([failed.result.isError, text(failed)], [true, 'No list called "shop".']);
  assert.match(text(await rpc('good-token', 'tools/call', { name: 'nope' })), /Unknown tool/);
});

test('the calls of the day: once spent, a sentence instead of the tool, and only tool calls count', async (t) => {
  let left = 2;
  const { rpc } = await start(t, {
    quota: (principal, tool) => {
      assert.equal(principal.name, 'ada');
      assert.ok(tool.name);
      if (left <= 0) return 'Daily limit reached.';
      left -= 1;
      return true;
    },
  });
  const text = (r) => r.result.content[0].text;
  await rpc('good-token', 'tools/list');
  await rpc('good-token', 'ping');
  assert.equal(left, 2, 'listing tools is no call');
  assert.equal(text(await rpc('good-token', 'tools/call', { name: 'greet', arguments: { who: 'a' } })), 'Hello a, from ada');
  assert.equal(text(await rpc('good-token', 'tools/call', { name: 'greet', arguments: { who: 'b' } })), 'Hello b, from ada');
  const spent = await rpc('good-token', 'tools/call', { name: 'greet', arguments: { who: 'c' } });
  assert.deepEqual([spent.result.isError, text(spent)], [true, 'Daily limit reached.']);
  assert.match(text(await rpc('good-token', 'tools/call', { name: 'nope' })), /Unknown tool/, 'an unknown tool spends nothing');

  assert.equal(dailyLimitText({ plan_name: 'Free', limit: 100, more: { id: 'pro', name: 'Pro', limit: 1000 } }, 'Tasks'),
    "Daily limit reached: the Free plan includes 100 calls a day from an assistant to Tasks, and today's are used up. "
    + "They start again at 00:00 UTC. The Pro plan includes 1,000 a day. Tell the person, and don't retry today.");
  assert.match(dailyLimitText({ plan_name: 'Pro', limit: 1000, more: null }, 'Next'), /Pro plan includes 1,000 calls .* 00:00 UTC\. Tell/);
});

test('batches, notifications, SSE answers and the other methods', async (t) => {
  const { base, call } = await start(t);
  const batch = await (await call('good-token', [
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { nonsense: true },
  ])).json();
  assert.equal(batch.length, 2);
  assert.equal(batch[1].error.code, -32600);
  const notification = await call('good-token', { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notification.status, 202);
  const sse = await call('good-token', { jsonrpc: '2.0', id: 9, method: 'ping' }, { Accept: 'text/event-stream' });
  assert.match(sse.headers.get('content-type'), /text\/event-stream/);
  assert.match(await sse.text(), /^event: message\ndata: \{"jsonrpc":"2.0","id":9,"result":\{\}\}/);
  const preflight = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://claude.ai' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://claude.ai');
  const bye = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { Authorization: 'Bearer good-token' } });
  assert.equal(bye.status, 204);
  const put = await fetch(`${base}/mcp`, { method: 'PUT', headers: { Authorization: 'Bearer good-token' } });
  assert.equal(put.status, 405);
  const parse = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer good-token' }, body: '{oops' });
  assert.equal((await parse.json()).error.code, -32700);
});

test('the public description', async (t) => {
  const { mcp } = await start(t);
  const info = mcp.info('https://app.example/');
  assert.equal(info.endpoint, 'https://app.example/mcp');
  assert.match(info.auth, /OAuth 2.1/);
  assert.equal(info.tools.length, 3);
});
