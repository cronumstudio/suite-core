/**
 * The routes both test modules have, each on a table of its own: the same
 * paths in two modules of one host, and nothing collides.
 */
import { readBody, sendJson, unauthorized, badRequest } from '../../../http.js';

export function itemRoutes(api, { suite, table, mount, name }) {
  api.get('/api/items', (ctx) => {
    if (!ctx.user) throw unauthorized();
    const rows = suite.database.all(`SELECT text FROM ${table} WHERE user_id = ? ORDER BY id`, ctx.user.id);
    sendJson(ctx.res, 200, { module: name, items: rows.map((row) => row.text) });
  });
  api.post('/api/items', async (ctx) => {
    if (!ctx.user) throw unauthorized();
    let body;
    try { body = JSON.parse(String(await readBody(ctx.req))); } catch { throw badRequest(); }
    suite.database.run(`INSERT INTO ${table} (user_id, text) VALUES (?, ?)`, ctx.user.id, String(body.text));
    sendJson(ctx.res, 201, { ok: true });
  });
  api.get('/api/where', (ctx) => sendJson(ctx.res, 200, {
    module: name, mount, baseUrl: ctx.baseUrl, install: suite.config.install.baseUrl, host: suite.config.host,
  }));
}

/** The MCP tools both test modules have: `list_items` in both, `add_item` in alpha only. */
export function itemTools({ suite, table, name, add = false }) {
  const text = (value) => ({ content: [{ type: 'text', text: value }] });
  const tools = [{
    name: 'list_items', title: 'List items', description: `Lists the person's ${name} items.`,
    inputSchema: { type: 'object', properties: {} },
    handler: (user) => text(JSON.stringify(suite.database.all(`SELECT text FROM ${table} WHERE user_id = ? ORDER BY id`, user.id).map((r) => r.text))),
  }];
  if (add) {
    tools.push({
      name: 'add_item', title: 'Add an item', description: `Adds an item to ${name}.`,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      handler: (user, args) => {
        if (args.text === 'boom') throw Object.assign(new Error('boom'), { code: 'item_exploded' });
        suite.database.run(`INSERT INTO ${table} (user_id, text) VALUES (?, ?)`, user.id, String(args.text));
        return text('Added.');
      },
    });
  }
  return tools;
}
