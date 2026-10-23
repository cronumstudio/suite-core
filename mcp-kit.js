/**
 * What every module's MCP tools are written with.
 *
 * mcp.js is the transport; the tools themselves are each module's. Their
 * skeleton was copied four times (audit 2026-10-23, mcp-cross-3): the `text`
 * result, the `S` schema helpers, the READS/ADDS/SETS/DESTRUCTIVE annotations
 * and a describeError with the same "Options:" block, and the copies had
 * started to drift (no DESTRUCTIVE in Next, three wordings of one error). They
 * live here once; each module's mcp-tools.js keeps only what is its own.
 *
 * And what every conversation pays for: `tools/list` goes whole into the
 * assistant's context on most clients, ≈17 500 tokens for Cronum Work's tools,
 * a fifth of them parameter descriptions repeated word for word in several
 * tools. `trimRepeats` keeps the first in full and the first sentence after.
 */
import { ResolveError, resolveErrorText } from './resolve.js';

export { ResolveError, resolveErrorText };

/** A tool's answer: one text. */
export const text = (s) => ({ content: [{ type: 'text', text: s }] });

/** Parameter schemas: `S.string('The title', { maxLength: 200 })`. */
export const S = Object.freeze({
  string: (description, extra = {}) => ({ type: 'string', description, ...extra }),
  bool: (description, extra = {}) => ({ type: 'boolean', description, ...extra }),
  int: (description, extra = {}) => ({ type: 'integer', description, ...extra }),
  number: (description, extra = {}) => ({ type: 'number', description, ...extra }),
  list: (description, items, extra = {}) => ({ type: 'array', description, items, ...extra }),
});

/*
 * What each tool does to the person's data, as MCP annotations (mcp.js
 * announces them with the tool's title): clients use them to decide what runs
 * without asking. Reading only; adding something new each call; setting a
 * state or a field, which a second call leaves as it was; and destructive,
 * which clients ask about first: deleting, overwriting for good, moving many
 * things at once, giving someone else access. None reaches outside Cronum
 * Work; a tool that does (fetching a file from a link) spreads one of these
 * with `openWorldHint: true`.
 */
export const READS = Object.freeze({ readOnlyHint: true, openWorldHint: false });
export const ADDS = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
export const SETS = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
export const DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });

const KINDS = { read: READS, add: ADDS, set: SETS, destroy: DESTRUCTIVE };

/**
 * A tool from what makes it differ: `kind` ('read', 'add', 'set', 'destroy')
 * gives its annotations, `params` and `required` its inputSchema, closed to
 * other properties. Anything else (feature, legacyNames…) passes through.
 */
export function tool({ kind, params = {}, required = [], openWorld = false, ...rest }) {
  if (!KINDS[kind]) throw new Error(`tool ${rest.name}: kind must be one of ${Object.keys(KINDS).join(', ')}`);
  return {
    ...rest,
    annotations: { ...KINDS[kind], ...(openWorld && { openWorldHint: true }) },
    inputSchema: {
      type: 'object', properties: params, ...(required.length && { required }), additionalProperties: false,
    },
  };
}

/**
 * The usual describeError for createMcpServer: a ResolveError (any module's:
 * a message and `options`) as its message and options, and an HttpError
 * (`status` and `code`) as the sentence of `errors.<code>` in English, from
 * the app's i18n. A module that needs more wraps it, and returns null for the
 * rest so the transport says "Internal error".
 * @param {{errorSentence?: (code, extra, lang) => string|null}} [i18n]
 */
export function describeErrorWith({ errorSentence = () => null } = {}) {
  return (error) => {
    if (error instanceof ResolveError || (error?.constructor?.name === 'ResolveError' && typeof error.message === 'string')) {
      return resolveErrorText(error);
    }
    if (error?.status) {
      const code = error.code ?? error.message;
      const sentence = errorSentence(code, error.extra ?? {}, 'en') ?? String(code);
      // Which feature a plan leaves out, so that "doesn't include this" says what.
      const feature = /^plan_/.test(String(code)) && error.extra?.feature ? ` (feature: ${error.extra.feature})` : '';
      return `${sentence}${feature}`;
    }
    return null;
  };
}

const firstSentence = (description) => {
  const match = /^.+?[.!?](?=\s|$)/s.exec(description);
  return match ? match[0] : description;
};

/**
 * The tools with each long parameter description said in full once: where the
 * same words come again in a later tool (a task reference in eleven tools, the
 * three parts of Next's step in three), they become their first sentence.
 * Names, parameters, types and limits stay as they are (CONVENTIONS §9); only
 * the words the assistant has already read get shorter. Top-level parameters
 * and those of a list's items; the tools are not changed, copies come back.
 * @param {object[]} tools   in the order tools/list gives them
 * @param {{minLength?: number}} [options]   shorter descriptions are left alone
 */
export function trimRepeats(tools, { minLength = 80 } = {}) {
  const seen = new Set();
  const trim = (properties) => {
    if (!properties || typeof properties !== 'object') return properties;
    return Object.fromEntries(Object.entries(properties).map(([name, schema]) => {
      let out = schema;
      const description = schema?.description;
      if (typeof description === 'string' && description.length >= minLength) {
        if (seen.has(description)) {
          const short = firstSentence(description);
          if (short.length < description.length) out = { ...schema, description: short };
        } else {
          seen.add(description);
        }
      }
      if (out?.items?.properties) out = { ...out, items: { ...out.items, properties: trim(out.items.properties) } };
      return [name, out];
    }));
  };
  return tools.map((t) => (t.inputSchema?.properties
    ? { ...t, inputSchema: { ...t.inputSchema, properties: trim(t.inputSchema.properties) } }
    : t));
}

/** The characters `tools/list` spends on these tools, as mcp.js announces them: for a budget test. */
export const toolsListSize = (tools) => JSON.stringify(tools.map((t) => ({
  name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
  ...(t.annotations && { annotations: { title: t.title, ...t.annotations } }),
}))).length;
