/**
 * Links between the modules of a host (host.js, Cronum Work): a step of Next
 * linked with a task of Tasks, a note with a phase of Projects. Inside one app
 * they are internal: one table, the person's own session and permissions, and
 * the module that owns each thing decides about it.
 *
 * Each module says what can be linked of it and how to show it, in its
 * `createModule()`:
 *
 *   cards: {
 *     task: {
 *       read(user, id)        → card | 'gone' | null   (null: it exists, this person can't see it;
 *                                                      user null: the host itself, to keep its title)
 *       search(user, text)    → [card…]                 (what this person may link)
 *       create(user, data)    → id                      (optional: "Add to Tasks…", by the module's rules)
 *       places(user)          → [{ id, name }]          (optional: where create() may put it: lists, notebooks…)
 *       complete(user, id, done)                        (optional: what "done together" does here)
 *       audience(id)          → [userId…]               (optional: who sees it, for live notices)
 *     },
 *   }
 *
 * A card is `{ id, title, state: 'open' | 'done' | 'cancelled', due?, where?, url? }`, its url a
 * path of the module's (`?list=27&task=389`), taken under the module's own path here.
 *
 * A ref names a thing as `module:type:id` (`tasks:task:389`): the module's path, the kind of
 * thing, and the id, never the number people see, which can change.
 *
 * Rules (the proposal of 8 October): the owning module decides; only the card is shown; everyone
 * sees what they could already see, and a link to something they can't open shows as such, with
 * no title. A link shows only while the person uses both modules. "Done together" is per link:
 * completing one side completes the other in the same transaction.
 */
import { HttpError, badRequest, notFound, forbidden, unauthorized, sendJson, readJson } from './http.js';

/** The host's table of links (host.js HOST_MIGRATIONS): each pair once, in a fixed order. */
export function linksSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS host_links (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    a_module   TEXT NOT NULL,
    a_type     TEXT NOT NULL,
    a_id       TEXT NOT NULL,
    b_module   TEXT NOT NULL,
    b_type     TEXT NOT NULL,
    b_id       TEXT NOT NULL,
    together   INTEGER NOT NULL DEFAULT 0,
    a_title    TEXT,
    b_title    TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    UNIQUE (a_module, a_type, a_id, b_module, b_type, b_id)
  );
  CREATE INDEX IF NOT EXISTS ix_host_links_a ON host_links (a_module, a_type, a_id);
  CREATE INDEX IF NOT EXISTS ix_host_links_b ON host_links (b_module, b_type, b_id)`);
}

const REF = /^([a-z][a-z0-9-]{1,30}):([a-z][a-z0-9_]{0,30}):([A-Za-z0-9_-]{1,64})$/;
const TITLE_MAX = 300;

/** `tasks:task:389` → { module, type, id }, or null. */
export function parseRef(ref) {
  const m = REF.exec(String(ref ?? ''));
  return m ? { module: m[1], type: m[2], id: m[3] } : null;
}
export const formatRef = ({ module, type, id }) => `${module}:${type}:${id}`;
const sameRef = (a, b) => a.module === b.module && a.type === b.type && String(a.id) === String(b.id);
/** The two sides of a link, always in the same order: one row for a pair, whichever way it was made. */
const ordered = (x, y) => (formatRef(x) < formatRef(y) ? [x, y] : [y, x]);

/**
 * @param {object} options
 * @param {object} options.database
 * @param {() => Array} options.modules        the host's mounted modules ({ mount, config, parts })
 * @param {(user, mount) => boolean} options.uses   whether someone uses a module
 * @param {(mount, userIds, data) => void} [options.notify]   a live notice in a module, for some people
 */
export function createLinks({ database, modules, uses = () => true, notify = () => {}, clock = () => Date.now() }) {
  const moduleOf = (mount) => modules().find((m) => m.mount === mount) || null;
  const providerOf = (ref) => moduleOf(ref.module)?.parts?.cards?.[ref.type] || null;
  const now = () => new Date(clock()).toISOString();

  /** The ref of a request, checked: a module of the host and a kind of thing it shows. */
  function refOf(value, field = 'ref') {
    const ref = typeof value === 'string' ? parseRef(value) : value && parseRef(formatRef(value));
    if (!ref || !providerOf(ref)) throw badRequest('field_invalid', { field });
    return ref;
  }

  /** What one module's thing looks like to someone: its card, gone, or hidden from them. */
  function cardOf(user, ref) {
    const m = moduleOf(ref.module);
    const provider = providerOf(ref);
    const base = { ref: formatRef(ref), module: ref.module, type: ref.type, app: m?.config.app.name, color: m?.config.app.color };
    if (!provider || !m) return { ...base, state: 'hidden' };
    let found;
    try { found = provider.read(user, ref.id); } catch { found = null; }
    if (found === 'gone') return { ...base, state: 'gone' };
    if (!found) return { ...base, state: 'hidden' };
    const title = String(found.title ?? '').slice(0, TITLE_MAX);
    const url = typeof found.url === 'string' && !found.url.startsWith('/') ? `/${m.mount}/${found.url}` : null;
    return {
      ...base, title, state: ['done', 'cancelled'].includes(found.state) ? found.state : 'open',
      ...(found.due ? { due: String(found.due) } : {}), ...(found.where ? { where: String(found.where).slice(0, TITLE_MAX) } : {}),
      ...(url ? { url } : {}),
    };
  }

  /** Someone can open it here: they use its module and its owner shows them its card. */
  const visible = (user, ref) => uses(user, ref.module) && !['hidden', 'gone'].includes(cardOf(user, ref).state);

  const rowsOf = (ref) => database.all(
    `SELECT * FROM host_links WHERE (a_module = ? AND a_type = ? AND a_id = ?) OR (b_module = ? AND b_type = ? AND b_id = ?)
     ORDER BY id`, ref.module, ref.type, String(ref.id), ref.module, ref.type, String(ref.id));
  const sidesOf = (row) => [
    { module: row.a_module, type: row.a_type, id: row.a_id, title: row.a_title, column: 'a_title' },
    { module: row.b_module, type: row.b_type, id: row.b_id, title: row.b_title, column: 'b_title' },
  ];
  /** The side of a link that isn't `ref`. */
  const otherSide = (row, ref) => {
    const [a, b] = sidesOf(row);
    return sameRef(a, ref) ? b : a;
  };

  /** A link as someone sees it from one of its sides. */
  function present(user, row, from) {
    const side = otherSide(row, from);
    const card = cardOf(user, side);
    // Gone: its last title only to who linked it, who could see it then; nobody else learns it from here.
    if (card.state === 'gone' && side.title && row.created_by === user.id) card.title = side.title;
    if (card.state === 'hidden') delete card.title;
    return { id: row.id, together: Boolean(row.together), item: card };
  }

  /** The links of something this person can see, to the modules they use. */
  function of(user, value) {
    const ref = refOf(value);
    if (!visible(user, ref)) throw notFound();
    return rowsOf(ref).filter((row) => uses(user, otherSide(row, ref).module)).map((row) => present(user, row, ref));
  }

  /** Remembers the titles of a link's sides, for when one is gone. */
  function remember(row) {
    for (const side of sidesOf(row)) {
      const provider = providerOf(side);
      let found = null;
      try { found = provider?.read(null, side.id, { system: true }); } catch { found = null; }
      if (found && found !== 'gone' && found.title) {
        database.run(`UPDATE host_links SET ${side.column} = ? WHERE id = ?`, String(found.title).slice(0, TITLE_MAX), row.id);
      }
    }
  }

  /** Who should hear that a link, or what it points at, changed: in each side's module, who sees that side. */
  function announce(row) {
    for (const side of sidesOf(row)) {
      const provider = providerOf(side);
      let audience = [];
      try { audience = provider?.audience?.(side.id) || []; } catch { audience = []; }
      if (row.created_by) audience = [...new Set([...audience, row.created_by])];
      if (audience.length) notify(side.module, audience, { ref: formatRef(side), link: row.id });
    }
  }

  /** Links two things someone can see; each pair once. */
  function link(user, fromValue, toValue, { together = false } = {}) {
    const from = refOf(fromValue, 'from');
    const to = refOf(toValue, 'to');
    if (sameRef(from, to)) throw badRequest('field_invalid', { field: 'to' });
    if (!visible(user, from)) throw notFound();
    if (!visible(user, to)) throw notFound();
    const [a, b] = ordered(from, to);
    const existing = database.get(`SELECT * FROM host_links WHERE a_module = ? AND a_type = ? AND a_id = ?
      AND b_module = ? AND b_type = ? AND b_id = ?`, a.module, a.type, String(a.id), b.module, b.type, String(b.id));
    if (existing) return present(user, existing, from);
    const { lastInsertRowid } = database.run(`INSERT INTO host_links
      (a_module, a_type, a_id, b_module, b_type, b_id, together, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.module, a.type, String(a.id), b.module, b.type, String(b.id), together ? 1 : 0, user.id, now());
    const row = database.get('SELECT * FROM host_links WHERE id = ?', lastInsertRowid);
    remember(row);
    announce(row);
    return present(user, database.get('SELECT * FROM host_links WHERE id = ?', row.id), from);
  }

  /**
   * "Add to Tasks…": the other module creates the thing, by its own rules (permissions, plans,
   * numbers), and it is linked, in one transaction: if either fails, neither happened.
   */
  function create(user, fromValue, { module, type, data = {}, together = false } = {}) {
    const from = refOf(fromValue, 'from');
    const target = refOf({ module, type, id: 'new' }, 'module');
    const provider = providerOf(target);
    if (typeof provider.create !== 'function') throw badRequest('field_invalid', { field: 'type' });
    if (!uses(user, target.module)) throw forbidden('module_off');
    if (!visible(user, from)) throw notFound();
    const source = cardOf(user, from);
    return database.tx(() => {
      const id = provider.create(user, { ...data, title: data.title ?? source.title, from: source });
      if (id == null) throw new HttpError(500, 'internal');
      return link(user, from, { module: target.module, type: target.type, id: String(id) }, { together });
    });
  }

  function own(user, id) {
    const row = database.get('SELECT * FROM host_links WHERE id = ?', Number(id));
    if (!row) throw notFound();
    const [a, b] = sidesOf(row);
    // Someone who can see either side may unlink or change it; the rest don't know it is there.
    if (!(uses(user, a.module) && visible(user, a)) && !(uses(user, b.module) && visible(user, b))) throw notFound();
    return row;
  }

  function update(user, id, { together }) {
    const row = own(user, id);
    database.run('UPDATE host_links SET together = ? WHERE id = ?', together ? 1 : 0, row.id);
    announce(row);
    return database.get('SELECT * FROM host_links WHERE id = ?', row.id);
  }

  function remove(user, id) {
    const row = own(user, id);
    database.run('DELETE FROM host_links WHERE id = ?', row.id);
    announce(row);
  }

  /** What someone may link in a module: its search, and where it may create something. */
  function search(user, module, type, text) {
    const ref = refOf({ module, type, id: 'x' }, 'module');
    if (!uses(user, ref.module)) return { items: [], places: [] };
    const provider = providerOf(ref);
    const items = (provider.search?.(user, String(text || '').slice(0, 200)) || []).slice(0, 30)
      .map((card) => cardOf(user, { ...ref, id: String(card.id) }))
      .filter((card) => card.state !== 'hidden' && card.state !== 'gone');
    const places = (provider.places?.(user) || []).slice(0, 200).map((p) => ({ id: String(p.id), name: String(p.name) }));
    return { items, places, creates: typeof provider.create === 'function' };
  }

  /* -------------------------- what the modules call -------------------------- */

  const propagating = new Set();

  /**
   * A module's thing changed (`changed`), or was done or reopened (`done`): the links show it
   * live, and the other side of each link with "done together" follows, in the same transaction.
   * A module calls these from where it changes the thing, inside its own transaction.
   */
  function changed(value) {
    const ref = parseRef(typeof value === 'string' ? value : formatRef(value));
    if (!ref) return;
    for (const row of rowsOf(ref)) {
      remember(row);
      announce(row);
    }
  }

  function done(value, isDone, { user = null } = {}) {
    const ref = parseRef(typeof value === 'string' ? value : formatRef(value));
    if (!ref) return;
    const key = formatRef(ref);
    if (propagating.has(key)) return;
    propagating.add(key);
    try {
      database.tx(() => {
        for (const row of rowsOf(ref)) {
          const other = otherSide(row, ref);
          if (row.together) {
            const provider = providerOf(other);
            if (!propagating.has(formatRef(other))) provider?.complete?.(user, other.id, Boolean(isDone));
          }
          announce(row);
        }
      });
    } finally {
      propagating.delete(key);
    }
  }

  return { of, link, create, update, remove, search, changed, done, cardOf, parseRef, formatRef };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The host's routes for links, at its root: the modules' pages ask them there. */
export function registerLinksApi(api, { links }) {
  const who = (ctx) => {
    if (!ctx.user) throw unauthorized();
    return ctx.user;
  };
  api.get('/api/links', (ctx) => sendJson(ctx.res, 200, { links: links.of(who(ctx), ctx.query.get('ref')) }));
  api.get('/api/links/search', (ctx) => sendJson(ctx.res, 200,
    links.search(who(ctx), ctx.query.get('module'), ctx.query.get('type'), ctx.query.get('q'))));
  api.post('/api/links', async (ctx) => {
    const body = await readJson(ctx.req);
    sendJson(ctx.res, 201, { link: links.link(who(ctx), body.from, body.to, { together: body.together === true }) });
  });
  api.post('/api/links/new', async (ctx) => {
    const body = await readJson(ctx.req);
    sendJson(ctx.res, 201, {
      link: links.create(who(ctx), body.from, {
        module: body.module, type: body.type, data: isObject(body.data) ? body.data : {}, together: body.together === true,
      }),
    });
  });
  api.patch('/api/links/:id', async (ctx) => {
    const body = await readJson(ctx.req);
    links.update(who(ctx), ctx.params.id, { together: body.together === true });
    sendJson(ctx.res, 200, { ok: true });
  });
  api.delete('/api/links/:id', (ctx) => {
    links.remove(who(ctx), ctx.params.id);
    sendJson(ctx.res, 200, { ok: true });
  });
}

/** A card as one line for an assistant. */
const cardLine = (card) => {
  if (card.state === 'hidden') return `${card.app} ${card.type}: no access`;
  if (card.state === 'gone') return `${card.app} ${card.type}: deleted${card.title ? ` (was "${card.title}")` : ''}`;
  return `${card.app} ${card.type} ${card.ref}: "${card.title}" (${card.state}${card.due ? `, due ${card.due}` : ''})${card.where ? ` in ${card.where}` : ''}`;
};

/**
 * The host's own MCP tools for links, beside the modules' (host.js hostMcp): what is linked with
 * something, and linking or creating-and-linking, by `module`, `type` and `id`.
 */
export function linkTools({ links, modules }) {
  const kinds = () => modules().filter((m) => m.parts?.cards)
    .map((m) => `${m.mount}: ${Object.keys(m.parts.cards).join(', ')}`).join('; ');
  const ref = { type: 'object', properties: { module: { type: 'string' }, type: { type: 'string' }, id: { type: 'string' } }, required: ['module', 'type', 'id'] };
  const text = (value) => ({ content: [{ type: 'text', text: value }] });
  return [
    {
      name: 'linked_items',
      title: 'What is linked with something',
      get description() {
        return 'What is linked with something in another module: each link with its title, state and where it lives.'
          + ` Give the thing as module, type and id (from that module's tools). Kinds: ${kinds()}.`;
      },
      inputSchema: { type: 'object', properties: { item: ref }, required: ['item'] },
      handler: (user, args) => {
        const found = links.of(user, formatRef(args.item || {}));
        return text(found.length
          ? found.map((l) => `• ${cardLine(l.item)}${l.together ? ' [done together]' : ''} (link ${l.id})`).join('\n')
          : 'Nothing is linked with it.');
      },
    },
    {
      name: 'link_item',
      title: 'Link, or add to another module and link',
      get description() {
        return 'Links something with something in another module, or creates it there and links it ("add this step'
          + ' to Tasks"). `from`: module, type and id. Then `to` (something that exists) or `create` (module, type,'
          + ' title, and place: a list, notebook or project id, if that module needs one). `together`: completing'
          + ` one completes the other. Kinds: ${kinds()}.`;
      },
      inputSchema: {
        type: 'object',
        properties: {
          from: ref,
          to: ref,
          create: { type: 'object', properties: { module: { type: 'string' }, type: { type: 'string' }, title: { type: 'string' }, place: { type: 'string' } }, required: ['module', 'type'] },
          together: { type: 'boolean' },
        },
        required: ['from'],
      },
      handler: (user, args) => {
        const from = formatRef(args.from || {});
        const made = args.create
          ? links.create(user, from, {
            module: args.create.module, type: args.create.type, together: args.together === true,
            data: { ...(args.create.title ? { title: String(args.create.title) } : {}), ...(args.create.place ? { place: String(args.create.place) } : {}) },
          })
          : args.to ? links.link(user, from, formatRef(args.to), { together: args.together === true }) : null;
        if (!made) throw badRequest('field_required', { field: 'to' });
        return text(`Linked: ${cardLine(made.item)}${made.together ? ' [done together]' : ''} (link ${made.id}).`);
      },
    },
  ];
}
