import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  text, S, READS, ADDS, SETS, DESTRUCTIVE, tool, describeErrorWith, trimRepeats, toolsListSize, ResolveError,
} from '../mcp-kit.js';
import { schemaProblems } from '../mcp.js';

test('text, S and the annotations', () => {
  assert.deepEqual(text('hi'), { content: [{ type: 'text', text: 'hi' }] });
  assert.deepEqual(S.string('Title', { maxLength: 5 }), { type: 'string', description: 'Title', maxLength: 5 });
  assert.deepEqual(S.list('Titles', S.string('One')), { type: 'array', description: 'Titles', items: { type: 'string', description: 'One' } });
  assert.equal(READS.readOnlyHint, true);
  assert.equal(SETS.idempotentHint, true);
  assert.equal(ADDS.idempotentHint, false);
  assert.equal(DESTRUCTIVE.destructiveHint, true);
  assert.throws(() => { READS.readOnlyHint = false; }, TypeError);
});

test('tool() builds the schema and the annotations from what makes it differ', () => {
  const handler = () => text('ok');
  const built = tool({
    name: 'add_task', title: 'Add a task', description: 'Adds one.', kind: 'add', feature: 'mcp',
    params: { title: S.string('Title') }, required: ['title'], handler,
  });
  assert.deepEqual(built.inputSchema, {
    type: 'object', properties: { title: { type: 'string', description: 'Title' } }, required: ['title'], additionalProperties: false,
  });
  assert.deepEqual(built.annotations, ADDS);
  assert.equal(built.feature, 'mcp');
  assert.equal(built.handler, handler);
  assert.equal(tool({ name: 'x', kind: 'read' }).inputSchema.required, undefined);
  assert.equal(tool({ name: 'fetch', kind: 'add', openWorld: true }).annotations.openWorldHint, true);
  assert.throws(() => tool({ name: 'x', kind: 'maybe' }), /kind must be one of/);
  assert.deepEqual(schemaProblems([built]), []);
});

test('describeErrorWith: options for a ResolveError, a sentence for an HttpError, null for the rest', () => {
  const describe = describeErrorWith({
    errorSentence: (code, extra) => (code === 'plan_feature' ? `Your plan doesn't include this (${extra.plan}).` : null),
  });
  assert.equal(describe(new ResolveError('Which one?', ['A (#1)', 'B (#2)'])), 'Which one?\nOptions:\n- A (#1)\n- B (#2)');
  class ResolveErrorOfAModule extends Error { constructor(m, o) { super(m); this.options = o; } }
  Object.defineProperty(ResolveErrorOfAModule, 'name', { value: 'ResolveError' });
  assert.equal(describe(new ResolveErrorOfAModule('Old copy', ['X'])), 'Old copy\nOptions:\n- X', 'a module\'s own copy, until it adopts the suite\'s');
  const many = new ResolveError('Many', Array.from({ length: 30 }, (_, i) => `n${i}`));
  assert.equal(describe(many).split('\n').length, 2 + 25, 'at most 25 options');
  const http = Object.assign(new Error('plan_feature'), { status: 402, code: 'plan_feature', extra: { plan: 'Free', feature: 'attach' } });
  assert.equal(describe(http), 'Your plan doesn\'t include this (Free). (feature: attach)');
  assert.equal(describe(Object.assign(new Error('x'), { status: 404, code: 'not_found' })), 'not_found');
  assert.equal(describe(new Error('boom')), null);
  assert.equal(describeErrorWith()(Object.assign(new Error('x'), { status: 400, code: 'title_required' })), 'title_required');
});

test('trimRepeats says a long parameter description in full once, then its first sentence', () => {
  const REF = S.string('The task: its number as the tools show it ("#59" or "59"), or its title. '
    + 'An approximate title works; a bare number is only ever the number, never part of a title.');
  const tools = [
    tool({ name: 'get_task', kind: 'read', params: { task: REF } }),
    tool({ name: 'update_task', kind: 'set', params: { task: REF, title: S.string('Title') }, required: ['task'] }),
    tool({ name: 'add_tasks', kind: 'add', params: { items: S.list('Tasks', { type: 'object', properties: { task: REF } }) } }),
  ];
  const trimmed = trimRepeats(tools);
  assert.equal(trimmed[0].inputSchema.properties.task.description, REF.description);
  assert.equal(trimmed[1].inputSchema.properties.task.description,
    'The task: its number as the tools show it ("#59" or "59"), or its title.');
  assert.equal(trimmed[2].inputSchema.properties.items.items.properties.task.description,
    trimmed[1].inputSchema.properties.task.description, 'inside a list\'s items too');
  assert.deepEqual(Object.keys(trimmed[1].inputSchema.properties), ['task', 'title'], 'the same parameters');
  assert.deepEqual(trimmed[1].inputSchema.required, ['task']);
  assert.equal(trimmed[1].inputSchema.properties.title.description, 'Title', 'short ones stay');
  assert.equal(tools[1].inputSchema.properties.task.description, REF.description, 'the tools themselves are not changed');
  assert.ok(toolsListSize(trimmed) < toolsListSize(tools));
  assert.deepEqual(schemaProblems(trimmed), []);
});

test('trimRepeats leaves a one-sentence description whole', () => {
  const ONE = S.string('A single long sentence that says what the parameter is about without any full stop in the middle of it');
  const trimmed = trimRepeats([tool({ name: 'a', kind: 'read', params: { x: ONE } }), tool({ name: 'b', kind: 'read', params: { x: ONE } })]);
  assert.equal(trimmed[1].inputSchema.properties.x.description, ONE.description);
});
