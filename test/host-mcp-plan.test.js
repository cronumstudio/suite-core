/**
 * A host's own MCP tools (the links, the calendar) and its modules' prompts go by the plan and by
 * the modules someone uses when they are called by their name too, not only in tools/list
 * (host.js hostMcp, mcp.js callTool; audit of 6/11, sc-mcp-14). Over HTTP, in host.test.js.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostMcp } from '../host.js';
import { createCalendar } from '../calendar.js';
import { createMcpServer } from '../mcp.js';

const ana = { id: 1, plan: 'free' };   // Free: Notes's tools are not in her plan
const bob = { id: 2, plan: 'pro' };
const cal = { id: 3, plan: 'pro' };    // uses Tasks alone

const cards = { item: { read: () => null, search: () => [] } };
/** A module as hostMcp sees it. `gated`: it declares the `mcp` feature, which Free leaves out. */
const moduleOf = (mount, name, { gated = false, range = null } = {}) => ({
  mount,
  config: { app: { name } },
  view: {
    entitlements: {
      knows: (feature) => gated && feature === 'mcp',
      allows: (user) => (!gated || user.plan === 'pro' ? true : `The Free plan does not include using ${name} from an assistant.`),
    },
  },
  parts: {
    cards,
    ...(range ? { calendar: { range } } : {}),
    mcp: {
      tools: [{
        name: 'list_items', title: 'List items', description: 'Lists the items.',
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: { type: 'object', properties: {} }, handler: () => ({ content: [{ type: 'text', text: '[]' }] }),
      }],
      prompts: {
        list: () => [{ name: 'tidy', description: `Tidy ${name}.` }],
        get: (promptName) => (promptName === 'tidy' ? { messages: [{ role: 'user', content: { type: 'text', text: 'Tidy.' } }] } : null),
      },
    },
  },
});

function server() {
  const linked = [];
  const item = { module: 'notes', type: 'item', id: '5', title: 'Plan', state: 'open', where: 'Ideas', name: 'Notes' };
  const links = {
    of: () => [],
    link: (user, from, to) => { linked.push([user.id, from, to]); return { id: 9, item, together: false }; },
    create: () => assert.fail('nothing is created here'),
  };
  const modules = [
    moduleOf('tasks', 'Tasks'),
    moduleOf('projects', 'Projects'),
    moduleOf('notes', 'Notes', { gated: true, range: () => [{ type: 'item', id: 5, title: 'Plan', start: '2026-11-03', where: 'Ideas' }] }),
  ];
  const uses = (user, mount) => user.id !== cal.id || mount === 'tasks';
  const host = hostMcp({
    modules, uses, hostName: 'Work', hostId: 'work', links, byPlan: true,
    calendar: createCalendar({ modules: () => modules, uses }),
  });
  const mcp = createMcpServer({
    serverInfo: { name: 'work', title: 'Work', version: '1.0.0' }, tools: host.tools, prompts: host.prompts,
    allows: host.allows, visible: host.visible, authenticate: () => null, challenge: () => 'Bearer', log: () => {},
  });
  return { host, mcp, linked };
}
const said = (result) => result.content.map((part) => part.text).join('\n');
const names = (list) => list.map((tool) => tool.name);

test('the links and the calendar, called by their name, answer as tools/list shows them', async () => {
  const { mcp, linked } = server();
  const nothing = { module: 'tasks', type: 'item', id: '1' };

  // Tasks alone: nothing to link, and no module of hers gives its dates.
  assert.deepEqual(names(mcp.listTools(cal)), ['tasks_list_items']);
  const links = await mcp.callTool(cal, 'work_linked_items', { item: nothing });
  assert.equal(links.isError, true);
  assert.equal(said(links), 'Linking needs two modules with things to link that this person uses and their plan lets an assistant use.'
    + ' They can turn modules on in Work, Settings › Modules, or change plan in Settings › Plan.');
  const days = await mcp.callTool(cal, 'work_calendar', { from: '2026-11-01', to: '2026-11-07' });
  assert.equal(days.isError, true);
  assert.match(said(days), /^The calendar needs a module with dates that this person uses and their plan lets an assistant read\./);

  // Free: Notes is the only module with dates, and her plan leaves it out.
  assert.ok(!names(mcp.listTools(ana)).includes('work_calendar'));
  assert.match(said(await mcp.callTool(ana, 'work_calendar', { from: '2026-11-01', to: '2026-11-07' })), /^The calendar needs/);
  // Pro: the same calls go.
  assert.match(said(await mcp.callTool(bob, 'work_calendar', { from: '2026-11-01', to: '2026-11-07' })), /"Plan"/);
  assert.equal(said(await mcp.callTool(bob, 'work_linked_items', { item: nothing })), 'Nothing is linked with it.');
  assert.deepEqual(linked, []);
});

test('a link never reaches into a module whose tools the plan leaves out', async () => {
  const { mcp, linked } = server();
  const from = { module: 'tasks', type: 'item', id: '1' };
  const to = { module: 'notes', type: 'item', id: '5' };
  // Free: Tasks and Projects link, so the tools are hers; Notes is not.
  assert.ok(names(mcp.listTools(ana)).includes('work_link_item'));
  const refused = await mcp.callTool(ana, 'work_link_item', { from, to });
  assert.equal(refused.isError, true);
  assert.equal(said(refused), 'Notes: The Free plan does not include using Notes from an assistant. They can change plan in Work, Settings › Plan.');
  assert.equal((await mcp.callTool(ana, 'work_linked_items', { item: to })).isError, true, 'nor reads what is linked with it');
  assert.equal((await mcp.callTool(ana, 'work_link_item', { from: to, to: from })).isError, true, 'from it either');
  assert.deepEqual(linked, []);
  assert.match(said(await mcp.callTool(bob, 'work_link_item', { from, to })), /^Linked: /);
  assert.deepEqual(linked, [[bob.id, 'tasks:item:1', 'notes:item:5']]);
  // Why some are missing, always: the plan's own tool.
  assert.match(said(await mcp.callTool(ana, 'work_plan_info', {})), /^Notes: The Free plan/);
});

test('a module\'s prompts only for whoever has its tools', () => {
  const { host } = server();
  assert.deepEqual(host.prompts.list(ana).map((p) => p.name), ['tasks_tidy', 'projects_tidy']);
  assert.equal(host.prompts.get('notes_tidy', {}, ana), null);
  assert.deepEqual(host.prompts.list(bob).map((p) => p.name), ['tasks_tidy', 'projects_tidy', 'notes_tidy']);
  assert.ok(host.prompts.get('notes_tidy', {}, bob));
  assert.deepEqual(host.prompts.list(cal).map((p) => p.name), ['tasks_tidy'], 'and uses');
});
