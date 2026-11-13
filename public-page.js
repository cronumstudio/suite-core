/**
 * A public page, the same in every module (audit of 6/11: tasks-srv-22, notes-srv-13,
 * next-srv-16): a link the owner of something (a list, a note, a project) turns on, which shows it
 * to whoever opens it, without an account and read only. The four modules had written the same
 * mechanics four times and they had already drifted apart: who was told, what a hand-over did,
 * whether the plan was asked again when the page was served, which name of the owner it showed.
 * Here is that mechanics once; each module says what it publishes and what the page shows of it.
 *
 *   const page = createPublicPage({
 *     db: { get, run }, entitlements, table: 'lists', publicUrl,
 *     find: (token) => get('SELECT * FROM lists WHERE public_token = ? AND deleted_at IS NULL', token),
 *     changed: (list, userId) => publish({ type: 'list', listId: list.id, by: userId }),
 *   });
 *   page.read(userId, list)      → { url, since, embed }   (url null while off; changes nothing)
 *   page.open(userId, list)      → { url, since, embed }   (turns it on, or the same link if on)
 *   page.close(userId, list)     → whether it was on
 *   page.unpublish('id = ?', id) a hand-over: whoever gets it never published it
 *   page.serve(token, { embed }) → { row, owner, name }    (404 public_not_found, 403 embed_not_allowed)
 *   page.routes(api, { path: '/api/lists/:id/public', user: requireUser, own, view })
 *
 * The rules:
 *   · The link is a long random token, the page's only key. Turned off, it stops working at once;
 *     turned on again, it is a new one, so whoever had the old link no longer sees it.
 *   · Turning it on is the plan's `publish` (every plan of Cronum Work has it, Free too), and it is
 *     asked again each time the page is served: a plan without it shows nothing, as if it were off,
 *     until the plan comes back or the owner turns it off.
 *   · An owner whose account is switched off (`disabled_at`: disabled by the admin, or its deletion
 *     asked for) shows nothing either; switched on again, the same link works.
 *   · Embedding it in another site is `embed` (Pro's). The page asks with `?embed=1` whenever it
 *     is in a frame, and the server answers 403 `embed_not_allowed` for an owner without it.
 *   · The page shows the name its owner shows, if they set one: never their username, nor the
 *     start of their email, which an account without a name of its own has as its name (#55).
 *   · Its answers are kept by no browser and no proxy (`Cache-Control: no-store`), so a page turned
 *     off stops showing at once, and no search engine lists them (`X-Robots-Tag: noindex`).
 *   · Something that changes hands loses its page (`unpublish`): the heir never published it, and
 *     their name would be on it.
 *
 * Who may turn it on (the owner alone, in every module) and with which code a teammate is refused
 * stay each module's (`own`): those codes are what its web client already knows.
 */
import { randomBytes } from 'node:crypto';
import { notFound, forbidden, sendJson } from './http.js';

/** What a page's token looks like: anything else is a page nobody has, without asking the database. */
export const PUBLIC_TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

/** 24 random bytes: 32 characters of base64url, not something anyone finds by trying. */
export const newPublicToken = () => randomBytes(24).toString('base64url');

/**
 * The name a public page shows of its owner: the one they set, or none. An account without a name
 * of its own has its username as its name, or the start of its email (accounts.js,
 * workos-accounts.js), which the page would show to anyone with the link. A name written as the
 * username is (`Eva` for `eva` is theirs) still counts as one they chose.
 */
export function publicOwnerName(owner) {
  const name = String(owner?.display_name ?? '').trim();
  const same = (other) => other != null && name === String(other).trim();
  if (!name || same(owner.username) || same(String(owner.email ?? '').split('@')[0])) return null;
  return name;
}

/** Neither a browser nor a proxy keeps a page's answer, and no search engine lists it. */
export function publicHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
}

/**
 * @param {object} options
 * @param {{ get: Function, run: Function }} options.db  the module's database.
 * @param {object} options.entitlements  the suite's (createEntitlements): `can` and `require`.
 * @param {string} options.table  the table of what is published, with `public_token` and `public_since`.
 * @param {Function} options.publicUrl  (token) → the page's address.
 * @param {Function} [options.find]  (token) → the row the page shows, with its owner's id, or null
 *   (one in the trash, say). By default the table's row with that token.
 * @param {Function} [options.ownerOf]  (row) → its owner's id (default `row.owner_id`).
 * @param {Function} [options.changed]  (row, userId) after it is turned on or off: the module tells
 *   the owner's other screens (or whoever it tells).
 */
export function createPublicPage({ db, entitlements, table, publicUrl, find = null, ownerOf = (row) => row.owner_id, changed = () => {} }) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(String(table ?? ''))) throw new Error('createPublicPage: table must be a table name');
  const userById = (id) => (id == null ? null : db.get('SELECT * FROM users WHERE id = ?', id));
  const rowById = (id) => db.get(`SELECT public_token, public_since FROM ${table} WHERE id = ?`, id);
  const answer = (user, { public_token: token, public_since: since }) => ({
    url: token ? publicUrl(token) : null,
    since: token ? since ?? null : null,
    embed: Boolean(user) && entitlements.can(user, 'embed'),
  });

  const page = {
    /** How it is, for its owner, changing nothing: a dialog opened on a page switched off elsewhere doesn't turn it on again. */
    read(userId, row) {
      return answer(userById(userId), rowById(row.id) ?? row);
    },

    /** Turns it on, for its owner whose plan has `publish`; on already, the same link. */
    open(userId, row) {
      const user = userById(userId);
      entitlements.require(user, 'publish');
      const now = rowById(row.id) ?? row;
      if (!now.public_token) {
        db.run(`UPDATE ${table} SET public_token = ?, public_since = ? WHERE id = ?`, newPublicToken(), new Date().toISOString(), row.id);
        changed(row, userId);
      }
      return answer(user, rowById(row.id));
    },

    /** Turns it off: the link stops working at once. → whether it was on. */
    close(userId, row) {
      const now = rowById(row.id) ?? row;
      if (!now.public_token) return false;
      db.run(`UPDATE ${table} SET public_token = NULL, public_since = NULL WHERE id = ?`, row.id);
      changed(row, userId);
      return true;
    },

    /**
     * Turns off the pages of the rows `where` names, without telling anyone: for something that
     * changes hands (an account's hand-over, a notebook given away), inside the module's own change.
     */
    unpublish(where, ...params) {
      return db.run(`UPDATE ${table} SET public_token = NULL, public_since = NULL WHERE ${where}`, ...params);
    },

    /**
     * The row whose token this is and its owner, while the page shows it: found (`find`), its owner
     * there, not switched off and with `publish`; else 404 public_not_found, as for a token nobody
     * has. `embed`: asked from inside another site's frame, which only an owner with `embed` gets.
     * → { row, owner, name } (`name`: the one the page shows, or null).
     */
    serve(token, { embed = false } = {}) {
      if (!PUBLIC_TOKEN.test(String(token ?? ''))) throw notFound('public_not_found');
      const row = find ? find(token) : db.get(`SELECT * FROM ${table} WHERE public_token = ?`, token);
      const owner = row ? userById(ownerOf(row)) : null;
      if (!row || !owner || owner.disabled_at || !entitlements.can(owner, 'publish')) throw notFound('public_not_found');
      if (embed && !entitlements.can(owner, 'embed')) throw forbidden('embed_not_allowed');
      return { row, owner, name: publicOwnerName(owner) };
    },

    /**
     * Its routes: `GET|POST|DELETE <path>` for its owner, and `GET /api/public/:token[?embed=1]`
     * for anyone, without a session (the token is the key).
     *
     *   user(ctx)              → the signed-in person (the module's requireUser)
     *   own(userId, id, what)  → the row, if they may turn its page on or off; else what the module
     *                            throws (`what`: 'read', 'open' or 'close')
     *   view(served, ctx)      → what the page shows (`served` is serve()'s answer)
     *   id(ctx)                → the row's id in the path (default `Number(ctx.params.id)`)
     */
    routes(api, { path, user, own, view, id = (ctx) => Number(ctx.params.id) }) {
      api.get(path, async (ctx) => {
        const me = user(ctx);
        sendJson(ctx.res, 200, page.read(me.id, own(me.id, id(ctx), 'read')));
      });
      api.post(path, async (ctx) => {
        const me = user(ctx);
        sendJson(ctx.res, 200, page.open(me.id, own(me.id, id(ctx), 'open')));
      });
      api.delete(path, async (ctx) => {
        const me = user(ctx);
        page.close(me.id, own(me.id, id(ctx), 'close'));
        sendJson(ctx.res, 200, { ok: true });
      });
      // Before anything else: a refusal (404, 403) is kept by nobody either.
      api.get('/api/public/:token', async (ctx) => {
        publicHeaders(ctx.res);
        sendJson(ctx.res, 200, view(page.serve(ctx.params.token, { embed: ctx.query.get('embed') === '1' }), ctx));
      });
    },
  };
  return page;
}
