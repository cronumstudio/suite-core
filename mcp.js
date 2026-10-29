/**
 * The remote MCP server of every app: Streamable HTTP and JSON-RPC 2.0 on one
 * endpoint (`/mcp`), authenticated with a bearer token.
 *
 * Tasks, Projects and Next had the same transport, copied three times; this is
 * it once. The app hands in what is its own: its tools, prompts and
 * instructions, how a token becomes a principal (a manual token, one from the
 * built-in OAuth, one signed by AuthKit), the header of a 401, and how its own
 * errors read for an assistant.
 *
 * A tool is `{ name, title, description, inputSchema, handler(principal, args) }`
 * and may declare the `feature` it needs: with `allows(principal, tool)` the
 * app's plans decide, before the tool runs, and the assistant gets a sentence
 * it can pass on instead of a failure. `quota(principal, tool)` spends one of
 * the person's calls of the day or week the same way, after `allows`.
 *
 * Before a tool runs, its arguments are checked against its `inputSchema`
 * (`argumentProblems`): types, ranges, `enum`, lengths and `format: 'date'`.
 * A call that doesn't fit gets a sentence saying what to correct, and the tool
 * doesn't run. The check reads arguments the way the tools always have (a
 * number in quotes is a number), and lets through properties the schema
 * doesn't name. `required` is left to the tool: some ask for what is missing
 * or do without it (Next's log_progress saves the step without done_title).
 *
 * What each person sees may depend on them (a host, where everyone uses some
 * modules): `visible(principal, tool)` keeps a tool out of their list, and
 * `instructions` may be a function of the principal. Without them every
 * principal gets the same, as always.
 *
 * `tools/list` goes whole into every conversation on most clients, so a tool
 * used now and then may be kept out of it and reached on demand
 * (`onDemand(principal, tool)`, with `door` naming two tools of the server's
 * own): `<door>_more_tools` names them in its description and tells what
 * they do and take, and `<door>_use_tool` runs one. They work as always
 * when called by name. Each is opt-in, and so are `recordChange` (a note of
 * every call that changes something, never its arguments) and
 * `maxResultChars` (a tool's answer cut at a whole line, saying how much was
 * left out).
 *
 * The assistant a call comes from reaches the tools as `principal.via` ("Claude Code",
 * "ChatGPT"…): what its client said of itself when the session began (`clientLabel`), carried
 * in the session's id. A tool may write it next to who did something; without a session the
 * principal has none.
 */
import crypto from 'node:crypto';
import { isoDate, readJson, sendJson, sendText } from './http.js';
import { ResolveError, resolveErrorText } from './resolve.js';

export const PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
/**
 * Messages in one JSON-RPC batch. Clients send one at a time (2025-06-18 dropped
 * batches); without a ceiling, a megabyte of `tools/list` would build hundreds
 * of megabytes of answer and hold the server for everyone.
 */
export const MAX_BATCH = 20;

const rpcResult = (id, value) => ({ jsonrpc: '2.0', id, result: value });
const rpcError = (id, code, message, data) => ({
  jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) },
});
const textResult = (text, isError = false) => ({
  ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }],
});

/**
 * A tool's answer no longer than `max` characters of text: cut at the last
 * whole line that fits, with a line saying how much was left out and how to
 * ask for less. Every page of 500 tasks stays in the conversation, and is
 * paid again on each turn after it.
 */
export function capResult(result, max) {
  if (!max || !Array.isArray(result?.content)) return result;
  let room = max;
  let cut = null;
  const content = result.content.map((part) => {
    if (part?.type !== 'text' || typeof part.text !== 'string') return part;
    if (cut || room <= 0) {
      cut ??= { lines: 0, chars: 0 };
      cut.lines += part.text.split('\n').length;
      cut.chars += part.text.length;
      return null;
    }
    if (part.text.length <= room) {
      room -= part.text.length;
      return part;
    }
    const end = part.text.lastIndexOf('\n', room);
    const kept = end > 0 ? part.text.slice(0, end) : part.text.slice(0, room);
    const rest = part.text.slice(kept.length);
    cut = { lines: rest.split('\n').filter(Boolean).length || 1, chars: rest.length };
    room = 0;
    return { ...part, text: kept };
  }).filter(Boolean);
  if (!cut) return result;
  content.push({
    type: 'text',
    text: `[Cut here: ${cut.lines.toLocaleString('en')} more lines (${cut.chars.toLocaleString('en')} characters) left out to keep the `
      + 'conversation light. Ask for less: a filter, a smaller limit, a date range or one item at a time.]',
  });
  return { ...result, content };
}

const firstSentence = (text) => {
  const line = String(text || '').split('\n')[0].trim();
  const end = line.search(/[.!?](\s|$)/);
  return end > 0 ? line.slice(0, end + 1) : line;
};

/* ------------------------- the arguments of a tool ------------------------ */

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const INTEGER_TEXT = /^\s*[-+]?\d+\s*$/;
const KNOWN_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object', 'null']);
const A_TYPE = {
  string: 'a text', integer: 'a whole number', number: 'a number', boolean: 'true or false',
  array: 'a list', object: 'an object', null: 'null',
};

/**
 * Whether a value is of a JSON Schema type, as the tools have always read
 * their arguments: a number in quotes for an integer or a number ("3"),
 * "true"/"false" or 0/1 for a boolean, a number or a boolean for a text
 * (they `String()` them). What none of them can read (an object for a text,
 * 2e8 where the schema says at most 365, a month 13) is what gets refused.
 */
function fitsType(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value);
    case 'integer': return Number.isInteger(value) || (typeof value === 'string' && INTEGER_TEXT.test(value));
    case 'number': return Number.isFinite(value)
      || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));
    case 'boolean': return typeof value === 'boolean' || value === 'true' || value === 'false' || value === 0 || value === 1;
    case 'array': return Array.isArray(value);
    case 'object': return isPlainObject(value);
    case 'null': return value === null;
    default: return true; // a type this check doesn't know: the tool decides, as before
  }
}

const quoted = (path) => `"${path}"`;

/**
 * What is wrong with a value for a schema, as short sentences an assistant
 * can act on («"lag" must be at most 365»). Never the value itself: it can be
 * long, or someone's text. `null` passes where a value is optional (the tools
 * read it as "leave it" or "clear it"), and properties the schema doesn't name
 * are left alone (`additionalProperties` is not enforced: clients send extra
 * ones, and the tools ignore them).
 */
function problemsOf(schema, value, path, out) {
  if (!isPlainObject(schema) || value === undefined || value === null || out.length >= 5) return out;
  const branches = schema.anyOf || schema.oneOf;
  if (Array.isArray(branches) && branches.length
    && !branches.some((branch) => problemsOf(branch, value, path, []).length === 0)) {
    out.push(`${quoted(path)} doesn't have any of the accepted forms`);
    return out;
  }
  const types = [].concat(schema.type ?? []);
  if (types.length && !types.some((type) => fitsType(type, value))) {
    // A single item where a list goes: the tools that take lists take one item too.
    if (types.includes('array') && isPlainObject(schema.items) && problemsOf(schema, [value], path, []).length === 0) return out;
    const known = types.filter((type) => KNOWN_TYPES.has(type)).map((type) => A_TYPE[type]);
    out.push(`${quoted(path)} must be ${known.join(' or ')}`);
    return out;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    out.push(`${quoted(path)} must be one of: ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`);
    return out;
  }
  const numeric = types.some((type) => type === 'integer' || type === 'number') && typeof value !== 'boolean'
    ? Number(value) : null;
  if (numeric !== null && Number.isFinite(numeric)) {
    const { minimum: min, maximum: max, exclusiveMinimum: above, exclusiveMaximum: below } = schema;
    const low = typeof min === 'number' && numeric < min;
    const high = typeof max === 'number' && numeric > max;
    if ((low || high) && typeof min === 'number' && typeof max === 'number') out.push(`${quoted(path)} must be between ${min} and ${max}`);
    else if (low) out.push(`${quoted(path)} must be at least ${min}`);
    else if (high) out.push(`${quoted(path)} must be at most ${max}`);
    else if (typeof above === 'number' && numeric <= above) out.push(`${quoted(path)} must be more than ${above}`);
    else if (typeof below === 'number' && numeric >= below) out.push(`${quoted(path)} must be less than ${below}`);
  }
  if (typeof value === 'string') {
    const length = () => [...value].length;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength && length() > schema.maxLength) {
      out.push(`${quoted(path)} must be at most ${schema.maxLength} characters long`);
    } else if (typeof schema.minLength === 'number' && length() < schema.minLength) {
      out.push(`${quoted(path)} must be at least ${schema.minLength} characters long`);
    }
    if (typeof schema.pattern === 'string' && !safePattern(schema.pattern)?.test(value)) {
      out.push(`${quoted(path)} doesn't have the expected form`);
    }
  }
  // A date is a text: a number where a date goes isn't one.
  if (schema.format === 'date' && (!types.length || types.includes('string')) && !isoDate(value)) {
    out.push(`${quoted(path)} must be a real date as YYYY-MM-DD, between 1900 and 2200`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) out.push(`${quoted(path)} can have at most ${schema.maxItems} items`);
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) out.push(`${quoted(path)} must have at least ${schema.minItems} items`);
    if (isPlainObject(schema.items)) value.forEach((item, i) => problemsOf(schema.items, item, `${path}[${i}]`, out));
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [name, sub] of Object.entries(properties)) {
      if (Object.hasOwn(value, name)) problemsOf(sub, value[name], path ? `${path}.${name}` : name, out);
    }
  }
  return out.slice(0, 5);
}

const patterns = new Map();
function safePattern(source) {
  if (!patterns.has(source)) {
    let compiled = null;
    try { compiled = new RegExp(source, 'u'); } catch { /* a pattern that doesn't compile checks nothing */ }
    patterns.set(source, compiled);
  }
  return patterns.get(source) || { test: () => true };
}

/**
 * The arguments of a call against the tool's `inputSchema`: the sentences of
 * what is wrong (at most five), or an empty list. Types, `enum`,
 * `minimum`/`maximum` (and the exclusive ones), `minLength`/`maxLength`,
 * `minItems`/`maxItems`, `pattern`, `anyOf`/`oneOf`, `format: 'date'`
 * (isoDate), nested `properties` and `items`.
 */
export function argumentProblems(schema, args) {
  if (!isPlainObject(schema)) return [];
  if (!isPlainObject(args)) return ['the arguments must be an object'];
  return problemsOf(schema.type === undefined ? { ...schema, type: 'object' } : schema, args, '', []);
}

/**
 * What is wrong with the schemas a set of tools declares, for an app's tests:
 * a type this check doesn't know, a `required` that names no property, bounds
 * that aren't numbers or are crossed, an empty `enum`, a pattern that doesn't
 * compile. Each one is a limit the tool believes it has and doesn't.
 */
export function schemaProblems(tools) {
  const out = [];
  const visit = (schema, where) => {
    if (!isPlainObject(schema)) return;
    for (const type of [].concat(schema.type ?? [])) if (!KNOWN_TYPES.has(type)) out.push(`${where}: unknown type ${JSON.stringify(type)}`);
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (key in schema && typeof schema[key] !== 'number') out.push(`${where}: ${key} is not a number`);
    }
    if (schema.minimum > schema.maximum) out.push(`${where}: minimum is above maximum`);
    if ('enum' in schema && !(Array.isArray(schema.enum) && schema.enum.length)) out.push(`${where}: enum is not a list of values`);
    if (typeof schema.pattern === 'string') { try { new RegExp(schema.pattern, 'u'); } catch { out.push(`${where}: pattern doesn't compile`); } }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (!(name in properties)) out.push(`${where}: required "${name}" is not a property`);
    }
    for (const [name, sub] of Object.entries(properties)) visit(sub, `${where}.${name}`);
    if (isPlainObject(schema.items)) visit(schema.items, `${where}[]`);
    for (const branch of [...(schema.anyOf || []), ...(schema.oneOf || [])]) visit(branch, where);
  };
  for (const tool of tools) {
    if (!isPlainObject(tool.inputSchema) || tool.inputSchema.type !== 'object') out.push(`${tool.name}: inputSchema is not an object schema`);
    else visit(tool.inputSchema, tool.name);
  }
  return out;
}

/**
 * What an assistant reads when the calls of the day are used up
 * (entitlements.js countDaily): a sentence to pass on, with when they come
 * back and which plan has more, and the hint not to keep trying.
 */
export function dailyLimitText({ plan_name: planName, limit, more }, appName) {
  const better = !more ? ''
    : ` The ${more.name} plan includes ${more.limit === null ? 'unlimited calls' : `${more.limit.toLocaleString('en')} a day`}.`;
  return `Daily limit reached: the ${planName} plan includes ${limit.toLocaleString('en')} calls a day from an assistant `
    + `to ${appName}, and today's are used up. They start again at 00:00 UTC.${better} Tell the person, and don't retry today.`;
}

/**
 * What an assistant reads when the calls of the week are used up
 * (entitlements.js countWeekly): the same as dailyLimitText, for a week that
 * starts again on Monday.
 */
export function weeklyLimitText({ plan_name: planName, limit, more }, appName) {
  const better = !more ? ''
    : ` The ${more.name} plan includes ${more.limit === null ? 'unlimited calls' : `${more.limit.toLocaleString('en')} a week`}.`;
  return `Weekly limit reached: the ${planName} plan includes ${limit.toLocaleString('en')} calls a week from an assistant `
    + `to ${appName}, and this week's are used up. They start again on Monday at 00:00 UTC.${better} Tell the person, and don't retry this week.`;
}

/**
 * The assistants people know, by the name their client gives itself when it connects
 * (`clientInfo.name` of `initialize`): Claude's apps say `claude-ai` or `Anthropic/ClaudeAI`,
 * ChatGPT `openai-mcp`. Compared without case, spaces or signs.
 */
const CLIENT_NAMES = new Map([
  ['claudeai', 'Claude'], ['anthropicclaudeai', 'Claude'], ['anthropicclaude', 'Claude'], ['claude', 'Claude'],
  ['claudecode', 'Claude Code'], ['openaimcp', 'ChatGPT'], ['chatgpt', 'ChatGPT'],
  ['codexmcpclient', 'Codex'], ['codex', 'Codex'], ['cursorvscode', 'Cursor'], ['cursor', 'Cursor'],
  ['geminiclimcpclient', 'Gemini CLI'], ['visualstudiocode', 'VS Code'],
]);
const CLIENT_MAX = 24;
const LABEL_MAX = 64;
const CLIENT_SIGNS = /[^\p{L}\p{N} .()+_-]/gu;
const clientKey = (value) => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const clientText = (value, max = CLIENT_MAX) => String(value ?? '').replace(CLIENT_SIGNS, '').replace(/\s+/g, ' ').trim().slice(0, max).trim();

/**
 * The assistant a client is, as people call it, in a few letters: one of the known ones, else
 * its title or the last part of its name ("Acme/Agent" is "Agent"), cleaned to a short line. It
 * is what the client says of itself, so it names the assistant for whoever reads a log; it
 * proves nothing. null for a client that says nothing.
 */
export function clientLabel(info) {
  const raw = String(info?.name ?? '');
  const name = clientText(raw.slice(raw.lastIndexOf('/') + 1));
  return CLIENT_NAMES.get(clientKey(raw)) || CLIENT_NAMES.get(clientKey(name))
    || clientText(info?.title) || name || clientText(raw) || null;
}

/**
 * A session's id carries its client (`<uuid>.<label in base64url>`): the server keeps no
 * sessions, and a deployment would forget a map of them while the client goes on sending the
 * same id. The client of a session, or null for an id that carries none or isn't one of ours.
 * A label written by an earlier version is named again as this one would ("AnthropicClaudeAI"
 * is "Claude"), so a session open across a deployment changes names with it.
 */
const sessionIdFor = (client) => (client
  ? `${crypto.randomUUID()}.${Buffer.from(client).toString('base64url')}` : crypto.randomUUID());
export function clientOfSession(id) {
  const value = String(id || '');
  const dot = value.lastIndexOf('.');
  if (dot < 0 || value.length > 200) return null;
  const label = Buffer.from(value.slice(dot + 1), 'base64url').toString('utf8');
  return label && clientText(label, LABEL_MAX) === label ? clientLabel({ name: label }) : null;
}

/**
 * The token of a request: the Authorization header, or the X-MCP-Token header.
 * Never the address (?token=): an address ends up in logs and histories.
 */
export function bearerToken(req, url = null) {
  const header = req.headers.authorization;
  if (header && /^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, '').trim();
  // For clients that can't set custom headers. It ends up in logs: use it knowingly.
  if (req.headers['x-mcp-token']) return String(req.headers['x-mcp-token']).trim();
  return null;
}

/**
 * @param {object} options
 * @param {{name, title, version}} options.serverInfo
 * @param {string|((principal) => string)} [options.instructions]
 * @param {object[]} options.tools
 * @param {{list(): object[], get(name, args): object|null}} [options.prompts]
 * @param {(token, req) => Promise<object|null>|object|null} options.authenticate
 * @param {(hadToken: boolean) => string} options.challenge   the WWW-Authenticate header of a 401
 * @param {boolean} [options.oauthOffered]   whether connecting with OAuth is possible
 * @param {{checkToken, tokenFailed, tokenSucceeded}} [options.limiter]
 * @param {(error) => boolean} [options.unavailable]   errors meaning "can't check the token now" → 503
 * @param {(principal, tool) => true|string} [options.allows]   plans: true, or the sentence why not
 * @param {(principal, tool) => true|string} [options.quota]    a call of the day spent: true, or the sentence why not
 * @param {(principal, tool) => boolean} [options.visible]   whether tools/list shows it to them
 * @param {(error) => string|null} [options.describeError]   the app's errors as text for the assistant
 * @param {boolean} [options.checkArgs]    check each call's arguments against the tool's inputSchema (on by default)
 * @param {(principal, tool) => boolean} [options.onDemand]   kept out of their list, reached through the door
 * @param {string} [options.door]   the start of the door's two names (`work` → work_more_tools, work_use_tool)
 * @param {(principal, tool) => void} [options.recordChange]   after a call that went well of a tool that changes things
 * @param {number} [options.maxResultChars]   the most text a tool's answer carries (capResult)
 */
export function createMcpServer({
  serverInfo, instructions = '', tools = [], prompts = null,
  authenticate, challenge, oauthOffered = false, limiter = null,
  unavailable = () => false, allows = () => true, quota = () => true, describeError = () => null,
  log = console.error, visible = () => true, checkArgs = true,
  onDemand = null, door = null, recordChange = null, maxResultChars = null,
}) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const doors = onDemand && door ? { more: `${door}_more_tools`, use: `${door}_use_tool` } : null;
  /** Open sessions (id → { created }). Informational only: the protocol is stateless here. */
  const sessions = new Map();

  // The hints (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) tell the client
  // which tools only read and which change or delete: the directories of Claude and ChatGPT
  // ask for them, and clients use them to decide when to ask the person first.
  const descriptor = (tool) => ({
    name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
    ...(tool.annotations && { annotations: { title: tool.title, ...tool.annotations } }),
  });

  /** What someone has in their list, and what they reach through the door. */
  function listOf(principal) {
    const shown = [];
    const kept = [];
    for (const tool of tools) {
      if (!visible(principal, tool)) continue;
      (doors && onDemand(principal, tool) ? kept : shown).push(tool);
    }
    return { shown, kept };
  }

  // The door: its description names every tool behind it, so the assistant knows they are there
  // and reaches for them on its own when the person asks for one.
  const doorTools = (kept) => [{
    name: doors.more,
    title: 'More tools',
    description: `Tools kept out of your list to keep it short; they work like any other: ${kept.map((t) => t.name).join(', ')}. `
      + `When the user asks for something one of them does, call this with its name to read what it does and takes, then run it with ${doors.use}.`,
    inputSchema: {
      type: 'object',
      properties: { names: { type: 'array', items: { type: 'string' }, maxItems: 30, description: 'Names from the list above; none for a short line on each' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, {
    name: doors.use,
    title: 'Use a tool from More tools',
    description: `Runs one of the tools ${doors.more} names, with its arguments, as if it were called directly.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The tool\'s name' },
        arguments: { type: 'object', description: 'Its arguments, as its parameters say' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }];

  /** What the tools behind the door do: a line each, or what each one named does and takes. */
  function moreTools(principal, names) {
    const { kept } = listOf(principal);
    if (!kept.length) return textResult('Every tool is already in your list.');
    const wanted = Array.isArray(names) ? names.map(String).filter(Boolean) : [];
    if (!wanted.length) {
      return textResult(kept.map((t) => {
        const params = Object.keys(t.inputSchema?.properties || {})
          .map((p) => ((t.inputSchema.required || []).includes(p) ? p : `${p}?`));
        return `${t.name} (${params.join(', ')}): ${firstSentence(t.description)}`;
      }).join('\n') + `\n\nCall ${doors.more} again with the names you need for what they take.`);
    }
    const byKept = new Map(kept.map((t) => [t.name, t]));
    return textResult(wanted.map((name) => {
      const tool = byKept.get(name) || byName.get(name);
      if (!tool || !visible(principal, tool)) return `${name}: no such tool. ${unknownHint(principal, name)}`.trim();
      const { additionalProperties, ...schema } = tool.inputSchema || {};
      const kind = tool.annotations?.readOnlyHint ? 'Only reads.' : tool.annotations?.destructiveHint ? 'Changes or deletes things.' : 'Changes things.';
      return `${tool.name} — ${tool.title}. ${kind}\n${tool.description}\nArguments (JSON Schema): ${JSON.stringify(schema)}`;
    }).join('\n\n'));
  }

  /** The tools someone could have meant by a name that isn't one: those ending in it (`list_projects`). */
  function unknownHint(principal, name) {
    const like = tools.filter((t) => visible(principal, t) && t.name.endsWith(`_${name}`)).map((t) => t.name).slice(0, 5);
    return like.length ? `Did you mean ${like.length > 1 ? `${like.slice(0, -1).join(', ')} or ${like.at(-1)}` : like[0]}?` : '';
  }

  /** What initialize says to someone. */
  const instructionsFor = (principal) => (typeof instructions === 'function' ? instructions(principal) : instructions);

  /** What tools/list answers someone: their list, and the door when some are kept behind it. */
  function listTools(principal) {
    const { shown, kept } = listOf(principal);
    return [...shown, ...(kept.length ? doorTools(kept) : [])].map(descriptor);
  }

  /** Runs a tool for a principal and returns its result in MCP form. */
  async function callTool(principal, name, args = {}) {
    if (doors && name === doors.more) return moreTools(principal, args?.names);
    if (doors && name === doors.use) {
      const inner = String(args?.name ?? '');
      if (!inner || inner === doors.more || inner === doors.use) return textResult(`Give the name of a tool ${doors.more} lists.`, true);
      let innerArgs = args?.arguments ?? {};
      // Some assistants send an object's JSON as a text.
      if (typeof innerArgs === 'string') { try { innerArgs = JSON.parse(innerArgs || '{}'); } catch { /* refused below */ } }
      if (innerArgs === null || typeof innerArgs !== 'object' || Array.isArray(innerArgs)) {
        return textResult(`"arguments" must be an object with ${inner}'s arguments.`, true);
      }
      return callTool(principal, inner, innerArgs);
    }
    const tool = byName.get(name);
    if (!tool) return textResult(`Unknown tool: ${name}. ${unknownHint(principal, name)}`.trim(), true);
    const allowed = allows(principal, tool);
    if (allowed !== true) return textResult(String(allowed || 'Your plan does not include this.'), true);
    const current = { ...args };
    // Before the tool and before a call of the day is spent: a value out of
    // its range (a lag of 2e8 days, a 13th month) never reaches the store.
    const problems = checkArgs ? argumentProblems(tool.inputSchema, current) : [];
    if (problems.length) {
      log(`[mcp] ${tool.name}: arguments refused (${problems.join('; ')})`);
      return textResult(`Invalid arguments for ${tool.name}: ${problems.join('; ')}. Correct them and call it again.`, true);
    }
    const spent = quota(principal, tool);
    if (spent !== true) return textResult(String(spent || 'The calls of today are used up.'), true);
    try {
      const result = await tool.handler(principal, current);
      // Who changed what from an assistant: the tool's name only, never its arguments (titles, notes).
      if (recordChange && tool.annotations?.readOnlyHint !== true && !result?.isError) {
        try { recordChange(principal, tool); } catch (error) { log(`[mcp] the change of ${tool.name} wasn't noted: ${error.message}`); }
      }
      return maxResultChars ? capResult(result, maxResultChars) : result;
    } catch (error) {
      const text = describeError(error);
      if (text) return textResult(text, true);
      // The suite's own (resolve.js, dates.js): the message and its options, for the AI to ask.
      if (error instanceof ResolveError) return textResult(resolveErrorText(error), true);
      if (error?.code && error?.status) return textResult(String(error.code), true);
      log(`[mcp] error in ${tool.name}`, error);
      return textResult(`Internal error running ${tool.name}: ${error.message}`, true);
    }
  }

  async function answer(message, principal, context) {
    const { id, method, params = {} } = message;
    const isNotification = id === undefined || id === null;
    switch (method) {
      case 'initialize': {
        const protocolVersion = PROTOCOL_VERSIONS.includes(params.protocolVersion)
          ? params.protocolVersion : PROTOCOL_VERSIONS[0];
        const sessionId = sessionIdFor(clientLabel(params.clientInfo));
        sessions.set(sessionId, { created: Date.now() });
        if (sessions.size > 5000) sessions.delete(sessions.keys().next().value);
        context.sessionId = sessionId;
        const text = instructionsFor(principal);
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false }, ...(prompts ? { prompts: { listChanged: false } } : {}) },
          serverInfo,
          ...(text ? { instructions: text } : {}),
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: listTools(principal) });
      case 'tools/call':
        if (!params.name) return rpcError(id, -32602, 'Missing tool name');
        return rpcResult(id, await callTool(principal, params.name, params.arguments || {}));
      case 'resources/list':
        return rpcResult(id, { resources: [] });
      case 'prompts/list':
        return rpcResult(id, { prompts: prompts ? prompts.list(principal) : [] });
      case 'prompts/get': {
        const prompt = prompts?.get(params.name, params.arguments, principal);
        return prompt ? rpcResult(id, prompt) : rpcError(id, -32602, `Unknown prompt: ${params.name}`);
      }
      default:
        return isNotification ? null : rpcError(id, -32601, `Method not supported: ${method}`);
    }
  }

  /**
   * POST   /mcp → JSON-RPC messages; answers JSON (or SSE when the client only accepts that).
   * GET    /mcp → the server→client SSE channel, kept open with comments.
   * DELETE /mcp → closes the session.
   */
  async function handle(req, res, url) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': req.headers.origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    const token = bearerToken(req, url);
    let principal;
    try {
      principal = token ? await authenticate(token, req) : null;
    } catch (error) {
      if (!unavailable(error)) throw error;
      // The signatures can't be checked right now: the token isn't bad, and
      // the client must not be led to ask for permission again.
      log(`[mcp] ${error.message}`);
      sendJson(res, 503, rpcError(null, -32003, 'Access cannot be checked right now. Try again in a while.'),
        { 'Retry-After': '30' });
      return;
    }

    if (!principal) {
      // The brake only counts failures: a good token is never blocked, even
      // behind an address shared with someone trying blindly. With OAuth the
      // first request comes without a token on purpose: that is no failure, and
      // it always gets its 401, which is what starts the sign-in (behind a
      // shared address, a 429 there would keep everyone else from connecting).
      if (token && limiter) {
        // Once the address is blocked its failures are no longer written down:
        // the bucket stays at its limit instead of growing with the attack.
        const before = limiter.checkToken(req, token);
        if (before.allowed) limiter.tokenFailed(req, token);
        const allowed = before.allowed ? limiter.checkToken(req, token) : before;
        if (!allowed.allowed) {
          sendJson(res, 429, rpcError(null, -32002, 'Too many attempts with an invalid token. Wait a while.'),
            { 'Retry-After': String(allowed.retryAfter) });
          return;
        }
      }
      sendJson(res, 401, rpcError(null, -32001, oauthOffered
        ? 'Authorization required: connect with OAuth, or use a manual token from the app’s settings.'
        : 'Invalid or missing token. Create one in the app’s settings.'),
      { 'WWW-Authenticate': challenge(Boolean(token)) });
      return;
    }
    limiter?.tokenSucceeded(req, token);

    if (req.method === 'DELETE') {
      const sid = req.headers['mcp-session-id'];
      if (sid) sessions.delete(String(sid));
      res.writeHead(204).end();
      return;
    }

    if (req.method === 'GET') {
      // Nothing is sent from here on our own, but some clients expect to be
      // able to open the channel. It is kept alive with comments.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => clearInterval(heartbeat));
      return;
    }

    if (req.method !== 'POST') {
      sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, POST, DELETE, OPTIONS' });
      return;
    }

    let body;
    try {
      body = await readJson(req, { requireType: false, allowArray: true });
    } catch {
      sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
      return;
    }
    const context = { sessionId: req.headers['mcp-session-id'] ? String(req.headers['mcp-session-id']) : null };
    // Which assistant acts for them (`principal.via`), for what the tools write down: a copy,
    // since an account may be cached and shared by other requests.
    const via = clientOfSession(context.sessionId);
    if (via) principal = { ...principal, via };
    const batch = Array.isArray(body) ? body : [body];
    if (batch.length > MAX_BATCH) {
      sendJson(res, 400, rpcError(null, -32600, `A batch may carry at most ${MAX_BATCH} messages.`));
      return;
    }
    const responses = [];
    for (const message of batch) {
      if (!message || message.jsonrpc !== '2.0') {
        responses.push(rpcError(message?.id ?? null, -32600, 'Invalid JSON-RPC request'));
        continue;
      }
      const out = await answer(message, principal, context);
      if (out) responses.push(out);
    }

    const headers = {};
    if (context.sessionId) headers['Mcp-Session-Id'] = context.sessionId;
    if (req.headers.origin) headers['Access-Control-Allow-Origin'] = req.headers.origin;
    if (!responses.length) {
      res.writeHead(202, headers).end();
      return;
    }
    const out = Array.isArray(body) ? responses : responses[0];
    const accept = String(req.headers.accept || '');
    if (accept.includes('text/event-stream') && !accept.includes('application/json')) {
      res.writeHead(200, {
        ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      res.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
      res.end();
      return;
    }
    sendJson(res, 200, out, headers);
  }

  /** A public description, handy to check the setup from a browser. */
  const info = (baseUrl) => ({
    transport: 'streamable-http',
    endpoint: `${String(baseUrl).replace(/\/$/, '')}/mcp`,
    auth: oauthOffered
      ? 'OAuth 2.1 (metadata at /.well-known/oauth-protected-resource) or Authorization: Bearer <token>'
      : 'Authorization: Bearer <token>',
    protocol_versions: PROTOCOL_VERSIONS,
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
    ...(prompts ? { prompts: prompts.list().map((p) => ({ name: p.name, description: p.description })) } : {}),
  });

  return { handle, callTool, listTools, instructionsFor, info, tools };
}
