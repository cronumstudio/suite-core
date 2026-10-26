/**
 * What an MCP server may keep out of tools/list and still reach (mcp.js `onDemand` and the
 * door), the note of each change, the cap on an answer and the hint for a name that isn't a
 * tool: in-process, through `listTools` and `callTool`.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpServer, capResult } from '../mcp.js';
import { createHost, prefixNames } from '../host.js';

const text = (value) => ({ content: [{ type: 'text', text: value }] });
const ADA = { id: 1, name: 'ada', plan: 'free' };

function server(options = {}) {
  const calls = [];
  const changes = [];
  const mcp = createMcpServer({
    serverInfo: { name: 'test', title: 'Test', version: '1.0.0' },
    tools: [
      {
        name: 'list_items', title: 'List items', description: 'Lists the items. Newest first.',
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } },
        handler: (p, args) => { calls.push(['list_items', args]); return text('a\nb\nc'); },
      },
      {
        name: 'add_subtask', title: 'Add a subtask', description: 'Adds a subtask to a task. Only one level.',
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        inputSchema: { type: 'object', properties: { task: { type: 'string' }, title: { type: 'string', maxLength: 10 } }, required: ['task', 'title'], additionalProperties: false },
        handler: (p, args) => { calls.push(['add_subtask', args]); return text(`Added "${args.title}".`); },
      },
      {
        name: 'share_list', title: 'Share a list', description: 'Shares a list with someone.', feature: 'sharing',
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        inputSchema: { type: 'object', properties: { list: { type: 'string' } } },
        handler: () => text('Shared.'),
      },
      {
        name: 'other_list_items', title: 'List other items', description: 'Lists the other items.',
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: {} },
        handler: () => ({ isError: true, content: [{ type: 'text', text: 'Nothing here.' }] }),
      },
    ],
    authenticate: () => ADA,
    challenge: () => 'Bearer',
    allows: (principal, tool) => (tool.feature === 'sharing' && principal.plan !== 'pro' ? 'The Free plan does not include sharing.' : true),
    recordChange: (principal, tool) => changes.push(`${principal.name}:${tool.name}`),
    log: () => {},
    ...options,
  });
  return { mcp, calls, changes };
}
const names = (list) => list.map((tool) => tool.name);
const said = (result) => result.content.map((part) => part.text).join('\n');

test('without onDemand every tool is listed, as before, and there is no door', async () => {
  const { mcp } = server();
  assert.deepEqual(names(mcp.listTools(ADA)), ['list_items', 'add_subtask', 'share_list', 'other_list_items']);
  assert.match(said(await mcp.callTool(ADA, 'work_more_tools', {})), /^Unknown tool: work_more_tools\.$/);
  // A door named without onDemand opens nothing either.
  assert.equal(names(server({ door: 'work' }).mcp.listTools(ADA)).length, 4);
});

test('tools kept on demand: out of the list, named by the door, read and run through it, and still callable by name', async () => {
  const kept = new Set(['add_subtask', 'share_list']);
  const { mcp, calls, changes } = server({ onDemand: (principal, tool) => kept.has(tool.name), door: 'work' });
  const list = mcp.listTools(ADA);
  assert.deepEqual(names(list), ['list_items', 'other_list_items', 'work_more_tools', 'work_use_tool']);
  const more = list.find((t) => t.name === 'work_more_tools');
  assert.match(more.description, /: add_subtask, share_list\. When the user asks/, 'the door names what is behind it');
  assert.deepEqual(more.annotations, { title: 'More tools', readOnlyHint: true, openWorldHint: false });
  assert.equal(list.find((t) => t.name === 'work_use_tool').annotations.destructiveHint, true, 'a client may ask first');

  // A line each, then what one named does and takes.
  const lines = said(await mcp.callTool(ADA, 'work_more_tools', {}));
  assert.match(lines, /^add_subtask \(task, title\): Adds a subtask to a task\.$/m);
  assert.match(lines, /^share_list \(list\?\): Shares a list with someone\.$/m);
  const detail = said(await mcp.callTool(ADA, 'work_more_tools', { names: ['add_subtask', 'nope'] }));
  assert.match(detail, /^add_subtask — Add a subtask\. Changes things\.\nAdds a subtask to a task\. Only one level\.\nArguments \(JSON Schema\): \{"type":"object"/);
  assert.doesNotMatch(detail, /additionalProperties/);
  assert.match(detail, /nope: no such tool\./);

  // Run through the door: the tool's own checks, plans and note of the change.
  assert.equal(said(await mcp.callTool(ADA, 'work_use_tool', { name: 'add_subtask', arguments: { task: 'Shop', title: 'Milk' } })), 'Added "Milk".');
  assert.equal(said(await mcp.callTool(ADA, 'work_use_tool', { name: 'add_subtask', arguments: '{"task":"Shop","title":"Eggs"}' })), 'Added "Eggs".',
    'arguments sent as JSON text');
  assert.match(said(await mcp.callTool(ADA, 'work_use_tool', { name: 'add_subtask', arguments: { task: 'Shop', title: 'Far too long' } })),
    /^Invalid arguments for add_subtask: "title" must be at most 10 characters long/);
  assert.equal(said(await mcp.callTool(ADA, 'work_use_tool', { name: 'share_list', arguments: {} })), 'The Free plan does not include sharing.');
  assert.match(said(await mcp.callTool(ADA, 'work_use_tool', { name: 'work_use_tool', arguments: {} })), /Give the name of a tool work_more_tools lists/);
  assert.match(said(await mcp.callTool(ADA, 'work_use_tool', { name: 'add_subtask', arguments: [1] })), /"arguments" must be an object/);
  // By its name, as a client that remembers it would.
  assert.equal(said(await mcp.callTool(ADA, 'add_subtask', { task: 'Shop', title: 'Bread' })), 'Added "Bread".');
  assert.deepEqual(calls.map(([name, args]) => `${name}:${args.title}`), ['add_subtask:Milk', 'add_subtask:Eggs', 'add_subtask:Bread']);
  assert.deepEqual(changes, ['ada:add_subtask', 'ada:add_subtask', 'ada:add_subtask'], 'each change once, as the tool behind the door');

  // Someone who has them all listed gets no door.
  const all = server({ onDemand: () => false, door: 'work' }).mcp;
  assert.deepEqual(names(all.listTools(ADA)), ['list_items', 'add_subtask', 'share_list', 'other_list_items']);
  assert.equal(said(await all.callTool(ADA, 'work_more_tools', {})), 'Every tool is already in your list.');
});

test('a note of each call that changed something: not of reads, refusals or errors', async () => {
  const { mcp, changes } = server();
  await mcp.callTool(ADA, 'list_items', {});
  await mcp.callTool(ADA, 'other_list_items', {});
  await mcp.callTool(ADA, 'share_list', {});
  await mcp.callTool(ADA, 'add_subtask', { task: 'x', title: 'Far too long' });
  assert.deepEqual(changes, []);
  await mcp.callTool(ADA, 'add_subtask', { task: 'x', title: 'Ok' });
  assert.deepEqual(changes, ['ada:add_subtask']);
  // A note that can't be written never undoes what the tool did.
  const broken = server({ recordChange: () => { throw new Error('disk full'); } }).mcp;
  assert.equal(said(await broken.callTool(ADA, 'add_subtask', { task: 'x', title: 'Ok' })), 'Added "Ok".');
});

test('a name that is no tool: the tools whose name ends in it', async () => {
  const { mcp } = server();
  assert.equal(said(await mcp.callTool(ADA, 'items')), 'Unknown tool: items. Did you mean list_items or other_list_items?');
  assert.equal(said(await mcp.callTool(ADA, 'nothing_like')), 'Unknown tool: nothing_like.');
  const hidden = server({ visible: (p, tool) => tool.name !== 'other_list_items' }).mcp;
  assert.equal(said(await hidden.callTool(ADA, 'items')), 'Unknown tool: items. Did you mean list_items?', 'only what they can see');
});

test('an answer longer than maxResultChars is cut at a whole line, saying how much was left', async () => {
  const long = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
  const cut = capResult(text(long), 40);
  assert.equal(cut.content[0].text, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');
  assert.match(cut.content[1].text, /^\[Cut here: 95 more lines \(\d+ characters\) left out/);
  assert.equal(capResult(text('short'), 40).content.length, 1, 'a short one is left as it is');
  const parts = { content: [{ type: 'text', text: 'x'.repeat(30) }, { type: 'text', text: 'y\nz' }] };
  assert.deepEqual(capResult(parts, 30).content.map((p) => p.text.slice(0, 12)), ['x'.repeat(12), '[Cut here: 2'], 'a part with no room left goes whole');
  assert.deepEqual(capResult(parts, 31).content.map((p) => p.text.slice(0, 12)), ['x'.repeat(12), 'y', '[Cut here: 1']);
  const { mcp } = server({ maxResultChars: 3 });
  assert.deepEqual((await mcp.callTool(ADA, 'list_items', {})).content.map((p) => p.text.slice(0, 9)), ['a\nb', '[Cut here']);
});

test('prefixNames: a module\'s own tool names, whole, with its prefix; one-word names and prefixed ones left alone', () => {
  const say = prefixNames(['list_items', 'add_item', 'summary'], 'gamma');
  assert.equal(say('Use list_items, or add_item (then list_items).'), 'Use gamma_list_items, or gamma_add_item (then gamma_list_items).');
  assert.equal(say('gamma_list_items and other_add_item stay; add_items and summary too.'), 'gamma_list_items and other_add_item stay; add_items and summary too.');
  assert.equal(say(undefined), undefined);
});

/* ------------------------------- in a host -------------------------------- */

const HOST = { app: { id: 'work', name: 'Work', color: '#3A4660', languages: ['en'] }, modules: { live: true }, accounts: { minPasswordLength: 8 } };
let fresh = 0;
const fixture = (name) => ({ mount: name, entry: new URL(`./fixtures/host/${name}/module.js?ondemand=${(fresh += 1)}`, import.meta.url) });

async function host(t, mcpOptions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-ondemand-'));
  const started = await createHost({
    config: HOST, modules: [fixture('alpha'), fixture('gamma')], mcpOptions,
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1', PLANS: JSON.stringify({ free: { name: 'Free', mcp: false }, pro: { name: 'Pro' } }) },
    version: '9.9.9', handleSignals: false, exitOnError: false, log: () => {},
  });
  t.after(async () => {
    await started.close();
    started.suite.database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { suite } = started;
  const person = (username, plan = null) => {
    const user = suite.accounts.create({ username, password: `${username}-password` }, { quiet: true });
    const id = user?.id ?? suite.accounts.byUsername(username).id;
    if (plan) suite.entitlements.grant({ subjectId: id, plan });
    return () => suite.accounts.byId(id);
  };
  return { started, suite, mcp: started.root.mcp, person };
}

test('a host without mcpOptions lists every tool of every module, whatever the plan, as before', async (t) => {
  const { mcp, person } = await host(t, null);
  const ana = person('ana');
  assert.deepEqual(names(mcp.listTools(ana())), ['alpha_list_items', 'alpha_add_item', 'gamma_list_items', 'gamma_add_item']);
  assert.match(mcp.listTools(ana()).find((tl) => tl.name === 'gamma_add_item').description, /^Adds an item\. To see them, list_items;/, 'its texts as the module wrote them');
});

test('a host with mcpOptions: the plan decides the list, some tools on demand, names with their prefix, each change noted', async (t) => {
  const { suite, mcp, person } = await host(t, { byPlan: true, onDemand: { alpha: ['add_item', 'no_such_tool'] }, namesInText: true, recordChanges: true, maxResultChars: 130 });
  const ana = person('ana');            // Free: Gamma's tools are not in her plan
  const bob = person('bob', 'pro');

  // Free: Gamma leaves the list, and says why and where to change it; alpha_add_item is behind the door.
  assert.deepEqual(names(mcp.listTools(ana())), ['alpha_list_items', 'work_plan_info', 'work_more_tools', 'work_use_tool']);
  const why = 'The Free plan does not include using Gamma from an assistant. They can change plan in Work, Settings › Plan.';
  assert.equal(said(await mcp.callTool(ana(), 'gamma_list_items', {})), why);
  assert.equal(said(await mcp.callTool(ana(), 'work_plan_info', {})), `Gamma: ${why}`);

  // Pro: every module, and no word of plans.
  const listed = mcp.listTools(bob());
  assert.deepEqual(names(listed), ['alpha_list_items', 'gamma_list_items', 'gamma_add_item', 'work_more_tools', 'work_use_tool']);
  const add = listed.find((tl) => tl.name === 'gamma_add_item');
  assert.equal(add.description, 'Adds an item. To see them, gamma_list_items; for several, call gamma_add_item again. A summary_items is no tool.');
  assert.equal(add.inputSchema.properties.text.description, 'What it says, as gamma_list_items shows it');
  assert.match(listed.find((tl) => tl.name === 'work_more_tools').description, /: alpha_add_item\. When/);

  // Through the door, with a note in the audit log: the tool and its module, never the text.
  assert.equal(said(await mcp.callTool(bob(), 'work_use_tool', { name: 'alpha_add_item', arguments: { text: 'Private words' } })), 'Added.');
  await mcp.callTool(bob(), 'gamma_add_item', { text: 'More words' });
  await mcp.callTool(bob(), 'alpha_list_items', {});
  const notes = suite.database.all("SELECT actor_user_id, meta FROM audit_log WHERE action = 'mcp.tool' ORDER BY id");
  assert.deepEqual(notes.map((n) => JSON.parse(n.meta)), [{ tool: 'alpha_add_item', module: 'alpha' }, { tool: 'gamma_add_item', module: 'gamma' }]);
  assert.ok(notes.every((n) => n.actor_user_id === bob().id));
  assert.ok(!notes.some((n) => n.meta.includes('words')));

  // A long answer is cut.
  for (let i = 0; i < 9; i += 1) await mcp.callTool(bob(), 'alpha_add_item', { text: `Item number ${i}` });
  const long = await mcp.callTool(bob(), 'alpha_list_items', {});
  assert.match(long.content.at(-1).text, /^\[Cut here: /);

  // Someone who wants them all listed (Settings › Your AI) gets no door.
  suite.database.run("INSERT INTO host_ai_tools (user_id, all_tools, chosen_at) VALUES (?, 1, '2026-10-26')", bob().id);
  await new Promise((resolve) => { setTimeout(resolve, 1100); });   // what someone may use is asked again after a second
  assert.deepEqual(names(mcp.listTools(bob())), ['alpha_list_items', 'alpha_add_item', 'gamma_list_items', 'gamma_add_item']);
});

test('the host\'s instructions say why a module has no tools, in its place', async (t) => {
  const { started, person } = await host(t, { byPlan: true });
  const ana = person('ana');
  const bob = person('bob', 'pro');
  const instructions = (who) => started.root.mcp.instructionsFor(who);
  assert.match(instructions(ana()), /Gamma: The Free plan does not include using Gamma from an assistant\. They can change plan in Work, Settings › Plan\./);
  assert.doesNotMatch(instructions(ana()), /gamma_add_item adds/);
  assert.match(instructions(bob()), /Gamma: gamma_add_item adds an item\./);
});


test('Settings › Your AI: GET /api/modules says how the tools come, PUT /api/me/ai-tools changes it for every assistant', async (t) => {
  const { started, mcp } = await host(t, { onDemand: { alpha: ['add_item'] } });
  const server = await started.listen();
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
  assert.equal((await call('PUT', '/api/me/ai-tools', { ai_tools: 'all' })).status, 401);
  await call('POST', '/api/auth/login', { username: 'admin', password: 'root-password' });
  assert.equal((await call('GET', '/api/modules')).data.ai_tools, 'door', 'on demand until they choose');
  assert.equal((await call('PUT', '/api/me/ai-tools', { ai_tools: 'everything' })).status, 400);
  assert.deepEqual((await call('PUT', '/api/me/ai-tools', { ai_tools: 'all' })).data, { ai_tools: 'all' });
  assert.equal((await call('GET', '/api/modules')).data.ai_tools, 'all');
  const admin = started.suite.accounts.byUsername('admin');
  assert.ok(mcp.listTools(admin).some((tl) => tl.name === 'alpha_add_item'));
});

test('without onDemand, Settings has nothing to say of the tools and the route isn\'t there', async (t) => {
  const { started } = await host(t, { byPlan: true });
  const server = await started.listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'root-password' }) });
  const cookie = (login.headers.getSetCookie?.() || []).find((c) => c.startsWith('work_sid=')).split(';')[0];
  const modules = await (await fetch(`${base}/api/modules`, { headers: { Cookie: cookie } })).json();
  assert.equal('ai_tools' in modules, false);
  const put = await fetch(`${base}/api/me/ai-tools`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{"ai_tools":"all"}' });
  assert.equal(put.status, 404);
});
