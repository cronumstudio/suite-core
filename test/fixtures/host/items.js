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

/** What can be linked of a test module's items (suite-core links.js): read, search, create, complete. */
export function itemCards({ suite, table }) {
  const card = (row) => ({ id: row.id, title: row.text, state: row.done ? 'done' : 'open', where: 'Items', url: `?item=${row.id}` });
  return {
    item: {
      read: (user, id) => {
        const row = suite.database.get(`SELECT * FROM ${table} WHERE id = ?`, Number(id));
        if (!row) return 'gone';
        if (user && row.user_id !== user.id) return null;
        return card(row);
      },
      search: (user, text) => suite.database.all(`SELECT * FROM ${table} WHERE user_id = ? AND text LIKE ? ORDER BY id`, user.id, `%${text}%`).map(card),
      create: (user, data) => suite.database.run(`INSERT INTO ${table} (user_id, text) VALUES (?, ?)`, user.id, String(data.title)).lastInsertRowid,
      places: () => [{ id: 'inbox', name: 'Inbox' }],
      complete: (user, id, done) => {
        suite.database.run(`UPDATE ${table} SET done = ? WHERE id = ?`, done ? 1 : 0, Number(id));
        suite.links?.done('item', id, done, { user });
      },
      audience: (id) => [suite.database.get(`SELECT user_id FROM ${table} WHERE id = ?`, Number(id))?.user_id].filter(Boolean),
    },
  };
}

/** Marks an item done, as a module would, telling its links. */
export function doneRoute(api, { suite, table }) {
  api.post('/api/items/:id/done', (ctx) => {
    if (!ctx.user) throw unauthorized();
    suite.database.tx(() => {
      suite.database.run(`UPDATE ${table} SET done = 1 WHERE id = ? AND user_id = ?`, Number(ctx.params.id), ctx.user.id);
      suite.links?.done('item', ctx.params.id, true, { user: ctx.user });
    });
    sendJson(ctx.res, 200, { ok: true });
  });
  api.delete('/api/items/:id', (ctx) => {
    if (!ctx.user) throw unauthorized();
    suite.database.run(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`, Number(ctx.params.id), ctx.user.id);
    suite.links?.changed('item', ctx.params.id);
    sendJson(ctx.res, 200, { ok: true });
  });
}
