/**
 * The MCP transport on its own, with a two-tool app around it.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMcpServer, dailyLimitText, MAX_BATCH, argumentProblems, schemaProblems } from '../mcp.js';

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
        annotations: { readOnlyHint: true, openWorldHint: false },
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
  assert.deepEqual(tools[0].annotations, { title: 'Greet', readOnlyHint: true, openWorldHint: false },
    'the hints are announced, with the title');
  assert.equal(tools[1].annotations, undefined, 'a tool without hints announces none');
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

test('a token in the address is not read: it would end up in logs', async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/mcp?token=good-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 401);
  const header = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'good-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(header.status, 200, 'the header still works');
});

/* ------------------------- the arguments of a tool ------------------------ */

function schemaServer({ checkArgs, onQuota = () => true } = {}) {
  const calls = [];
  const logged = [];
  const mcp = createMcpServer({
    serverInfo: { name: 'test', title: 'Test', version: '1.0.0' },
    tools: [{
      name: 'add_dependency', title: 'Link', description: 'Links two tasks',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          lag: { type: 'integer', minimum: -365, maximum: 365 },
          type: { type: 'string', enum: ['FS', 'SS', 'FF', 'SF'] },
          start: { type: 'string', format: 'date' },
          done: { type: 'boolean' },
          quantity: { type: 'number' },
          title: { type: 'string', maxLength: 5 },
          titles: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { title: { type: 'string' }, quantity: { type: 'number', minimum: 0 } },
              required: ['title'],
              additionalProperties: false,
            },
          },
        },
        required: ['from'],
        additionalProperties: false,
      },
      handler: (principal, args) => { calls.push(args); return { content: [{ type: 'text', text: 'linked' }] }; },
    }],
    authenticate: async () => null,
    challenge: () => 'Bearer',
    quota: onQuota,
    legacyParams: { retraso: 'lag' },
    log: (line) => logged.push(line),
    ...(checkArgs === undefined ? {} : { checkArgs }),
  });
  return { mcp, calls, logged };
}

test('arguments out of the schema: an error to correct, and the tool never runs', async () => {
  let spent = 0;
  const { mcp, calls, logged } = schemaServer({ onQuota: () => { spent++; return true; } });
  const refused = async (args, pattern) => {
    const result = await mcp.callTool({ id: 1 }, 'add_dependency', args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content[0].text, pattern);
  };
  await refused({ from: 'a', lag: 2e8 }, /^Invalid arguments for add_dependency: "lag" must be between -365 and 365/);
  await refused({ from: 'a', retraso: 2e8 }, /"lag" must be between/); // an old parameter name is checked as the new one
  await refused({ from: 'a', lag: 2.5 }, /"lag" must be a whole number/);
  await refused({ from: 'a', lag: 'soon' }, /"lag" must be a whole number/);
  await refused({ from: 'a', start: '2026-13-01' }, /"start" must be a real date/);
  await refused({ from: 'a', start: '2026-02-31' }, /"start" must be a real date/);
  await refused({ from: 'a', start: '2206-10-01' }, /"start" must be a real date/);
  await refused({ from: 'a', type: 'XX' }, /"type" must be one of: "FS", "SS", "FF", "SF"/);
  await refused({ lag: 1 }, /"from" is required/);
  await refused({ from: { evil: true } }, /"from" must be a text/);
  await refused({ from: 'a', done: 'maybe' }, /"done" must be true or false/);
  await refused({ from: 'a', title: 'too long' }, /"title" must be at most 5 characters/);
  await refused({ from: 'a', titles: ['1', '2', '3', '4'] }, /"titles" can have at most 3 items/);
  await refused({ from: 'a', items: [{ title: 'x' }, { quantity: -1 }] },
    /"items\[1\]\.title" is required; "items\[1\]\.quantity" must be at least 0/);
  assert.equal(calls.length, 0, 'the handler was never called');
  assert.equal(spent, 0, 'refused calls spend no call of the day');
  assert.ok(logged.length > 0 && logged.every((line) => /^\[mcp\] add_dependency: arguments refused/.test(line)));
  assert.ok(!logged.some((line) => line.includes('evil')), 'the values are not logged');
});

test('arguments that fit, and the forms the tools have always read, reach the tool unchanged', async () => {
  const { mcp, calls } = schemaServer();
  const ok = async (args) => {
    const result = await mcp.callTool({ id: 1 }, 'add_dependency', args);
    assert.equal(result.isError, undefined, `${JSON.stringify(args)}: ${result.content[0].text}`);
  };
  await ok({ from: 'a', lag: -365, type: 'SS', start: '2024-02-29', done: true, quantity: 0.5, title: 'short' });
  await ok({ from: 12, lag: '3', done: 'false', quantity: '2.5' }); // a number for a text, numbers and booleans in quotes
  await ok({ from: 'a', lag: null, type: null, start: null }); // null: leave it, or clear it
  await ok({ from: 'a', titles: 'one', extra: 'ignored' }); // one item for a list; an unknown property passes
  await ok({ from: 'a', items: [{ title: 'ham', quantity: 200, unit: 'g' }] });
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[1], { from: 12, lag: '3', done: 'false', quantity: '2.5' }, 'nothing is converted on the way');
});

test('with checkArgs off, the tool gets whatever was sent, as before', async () => {
  const { mcp, calls } = schemaServer({ checkArgs: false });
  const result = await mcp.callTool({ id: 1 }, 'add_dependency', { lag: 2e8 });
  assert.equal(result.content[0].text, 'linked');
  assert.deepEqual(calls, [{ lag: 2e8 }]);
});

test('argumentProblems and schemaProblems on their own', () => {
  assert.deepEqual(argumentProblems(undefined, { anything: 1 }), [], 'a tool without a schema is not checked');
  assert.deepEqual(argumentProblems({ type: 'object' }, 'text'), ['the arguments must be an object']);
  const either = { type: 'object', properties: { when: { anyOf: [{ type: 'string', format: 'date' }, { type: 'integer', minimum: 0 }] } } };
  assert.deepEqual(argumentProblems(either, { when: '2026-10-23' }), []);
  assert.deepEqual(argumentProblems(either, { when: 4 }), []);
  assert.deepEqual(argumentProblems(either, { when: -4 }), ['"when" doesn\'t have any of the accepted forms']);
  assert.deepEqual(argumentProblems({ type: 'object', properties: { code: { type: 'string', pattern: '^#[0-9a-f]{6}$' } } }, { code: 'red' }),
    ['"code" doesn\'t have the expected form']);
  assert.deepEqual(argumentProblems({ type: 'object', properties: { n: { type: 'integer', maximum: 1 } } }, { m: 5, o: 'x' }), [],
    'properties the schema does not name are not checked');

  assert.deepEqual(schemaProblems([
    { name: 'good', inputSchema: { type: 'object', properties: { lag: { type: 'integer', minimum: -365, maximum: 365 } }, required: ['lag'] } },
    { name: 'bad', inputSchema: { type: 'object', properties: { n: { type: 'int', minimum: 5, maximum: 1 }, p: { type: 'string', enum: [], pattern: '(' } }, required: ['m'] } },
    { name: 'none' },
  ]), [
    'bad: required "m" is not a property', 'bad.n: unknown type "int"', 'bad.n: minimum is above maximum',
    'bad.p: enum is not a list of values', 'bad.p: pattern doesn\'t compile', 'none: inputSchema is not an object schema',
  ]);
});
