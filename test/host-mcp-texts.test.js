/**
 * What an assistant reads from a host's one MCP (host.js hostMcp): the modules' answers with
 * their tools named as the host names them, errors as sentences instead of codes, the
 * calendar's limits said, and the instructions that don't fit made visible (audit 2026-11-06,
 * sc-mcp-11, -12 and -17).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostMcp, hostInstructions, MCP_TEXT_MAX } from '../host.js';
import { createMcpServer, argumentProblems } from '../mcp.js';
import { calendarTools } from '../calendar.js';
import { badRequest } from '../http.js';

const text = (value) => ({ content: [{ type: 'text', text: value }] });
const ADA = { id: 1, username: 'ada' };

/** A module as hostMcp sees one: its mount, its name, its tools and what its plans say (yes). */
const moduleOf = (mount, name, tools, more = {}) => ({
  mount, config: { app: { name } },
  parts: { mcp: { instructions: `${name} keeps things.`, tools, ...more } },
  view: { entitlements: { allows: () => true, knows: () => false } },
});

const NEXT = moduleOf('next', 'Next', [
  {
    name: 'set_status', title: 'Set status', description: 'Sets a step’s status.', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: {} },
    handler: () => text('Done. It has no next step: give it one with edit_step.'),
  },
  {
    name: 'edit_step', title: 'Edit a step', description: 'Edits a step.', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: {} },
    handler: () => { throw Object.assign(new Error('which'), { described: true }); },
  },
  {
    name: 'project_history', title: 'History', description: 'Reads a project.', annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {} },
    // The person's own words: a step whose detail says "edit_step".
    handler: () => text('Step: rename edit_step in the docs.'),
  },
  {
    name: 'broken_read', title: 'Broken', description: 'Fails.', annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {} },
    handler: () => { throw badRequest('not_found'); },
  },
], { describeError: (error) => (error.described ? 'Say which step: call project_history first, then edit_step.' : null) });

test('sc-mcp-12: a module’s answers and errors name its tools as the host does; a reading tool’s answer is the person’s, left whole', async () => {
  const host = hostMcp({ modules: [NEXT], hostName: 'Work', hostId: 'work', namesInText: true });
  const server = createMcpServer({
    serverInfo: { name: 'work', title: 'Work', version: '1' }, ...host, authenticate: () => ADA, challenge: () => 'Bearer', log: () => {},
  });
  const said = async (name) => (await server.callTool(ADA, name, {})).content[0].text;
  assert.equal(await said('next_set_status'), 'Done. It has no next step: give it one with next_edit_step.');
  assert.equal(await said('next_edit_step'), 'Say which step: call next_project_history first, then next_edit_step.', 'the module’s error too');
  assert.equal(await said('next_project_history'), 'Step: rename edit_step in the docs.', 'a read gives back the person’s words as they are');

  const plain = hostMcp({ modules: [NEXT], hostName: 'Work', hostId: 'work' });
  const unchanged = await plain.tools.find((tool) => tool.name === 'next_set_status').handler(ADA, {});
  assert.equal(unchanged.content[0].text, 'Done. It has no next step: give it one with edit_step.', 'without namesInText, as the module wrote it');
});

test('sc-mcp-11: what nobody described reads as the suite’s sentence, never a bare code', async () => {
  const host = hostMcp({ modules: [NEXT], hostName: 'Work', hostId: 'work' });
  assert.equal(host.describeError(badRequest('not_found')), 'Not found.');
  assert.equal(host.describeError(badRequest('field_invalid', { field: 'to' })), 'Linked with: not valid.');
  assert.equal(host.describeError(new Error('a bug')), null, 'what isn’t the suite’s goes on to the transport’s plain sentence');
  const server = createMcpServer({
    serverInfo: { name: 'work', title: 'Work', version: '1' }, ...host, authenticate: () => ADA, challenge: () => 'Bearer', log: () => {},
  });
  const answer = await server.callTool(ADA, 'next_broken_read', {});
  assert.deepEqual([answer.isError, answer.content[0].text], [true, 'Not found.']);
});

test('sc-mcp-11: the calendar says its dates and its 366 days instead of field_invalid', async () => {
  const asked = [];
  const [calendar] = calendarTools({ calendar: { range: async (user, span) => { asked.push(span); return { from: span.from, to: span.to, modules: [], items: [] }; } } });
  assert.equal(calendar.inputSchema.properties.from.format, 'date');
  assert.equal(calendar.inputSchema.properties.to.format, 'date');
  assert.deepEqual(argumentProblems(calendar.inputSchema, { from: 'mañana' }), ['"from" must be a real date as YYYY-MM-DD, between 1900 and 2200']);
  const tooLong = await calendar.handler(ADA, { from: '2026-11-01', to: '2028-01-01' });
  assert.equal(tooLong.isError, true);
  assert.match(tooLong.content[0].text, /"to" must be on or after "from" \(2026-11-01\) and at most 366 days from it/);
  const backwards = await calendar.handler(ADA, { from: '2026-11-10', to: '2026-11-01' });
  assert.match(backwards.content[0].text, /on or after "from"/);
  assert.equal(asked.length, 0, 'neither was asked of the modules');
  const week = await calendar.handler(ADA, { from: '2026-11-01' });
  assert.equal(week.isError, undefined);
  assert.deepEqual(asked, [{ from: '2026-11-01', to: '2026-11-07' }]);
  assert.equal((await calendar.handler(ADA, { from: '2026-01-01', to: '2026-12-31' })).isError, undefined, 'a whole year fits');
});

test('sc-mcp-17: a part of the instructions that doesn’t fit is named, not only dropped', () => {
  const long = (mount, name) => moduleOf(mount, name, [{ name: 'do_it', title: 'Do', description: 'Does.', inputSchema: { type: 'object', properties: {} }, handler: () => text('ok') }],
    { brief: `${name}: ${'words '.repeat(120).trim()}.` });
  const modules = [long('tasks', 'Tasks'), long('notes', 'Notes'), long('projects', 'Projects'), long('next', 'Next')];
  const logged = [];
  let left = null;
  const said = hostInstructions({ modules, hostName: 'Work', log: (line) => logged.push(line), onLeftOut: (mounts) => { left = mounts; } });
  assert.ok(said.length <= MCP_TEXT_MAX);
  assert.deepEqual(left, ['projects', 'next'], 'whole parts: Tasks and Notes fit, the other two don’t');
  assert.ok(said.includes('Notes: words') && !said.includes('Projects:'));
  assert.match(logged[0], /left out: .*next/);
  const host = hostMcp({ modules, hostName: 'Work', hostId: 'work' });
  assert.deepEqual(host.instructionsLeftOut(), left, 'what a host warns of at start, and its tests can see');
  const fits = hostMcp({ modules: modules.slice(0, 2), hostName: 'Work', hostId: 'work' });
  assert.deepEqual(fits.instructionsLeftOut(), [], 'nothing when every part fits');
});
