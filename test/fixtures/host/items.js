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
