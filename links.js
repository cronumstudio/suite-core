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
 *       read(user, id, opts?) → card | 'gone' | null   (null: it exists, this person can't see it;
 *                                                      user null + { system: true }: the host itself,
 *                                                      to keep its title)
 *       readMany(user, ids, opts?) → Map<id, card | 'gone' | null>
 *                                                     (optional: read() of many at once, the same
 *                                                      answer for each id, keyed by the ids as given,
 *                                                      strings. In a fixed number of queries, IN (…)
 *                                                      by batches of ≤ 500, not one per id. An id left
 *                                                      out of the Map, or every id if it throws, is
 *                                                      asked of read() instead)
 *       search(user, text)    → [card…]                 (what this person may link, each card as
 *                                                      read() shows it to them: shown as it comes.
 *                                                      A LIKE on what was typed escapes it: likeOf)
 *       create(user, data)    → id                      (optional: "Add to Tasks…", by the module's rules)
 *       places(user)          → [{ id, name }]          (optional: where create() may put it: lists, notebooks…)
 *       complete(user, id, done)                        (optional: what "done together" does here)
 *       editable(user, id)    → boolean                 (optional: whether this person may change it, not
 *                                                      only see it: edit its list, project, notebook.
 *                                                      Without it, seeing it is enough, as before)
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
 *
 * A link is written on both its sides: whoever only sees one of them didn't put it there and can't
 * change it (audit of 6/11, sc-feat-2: someone with a list shared to view removed its owner's links,
 * turned «done together» on so that a tick of the owner's completed a project task they can't even
 * open, and hung chips of their own on the owner's tasks). Linking, and «done together», need to be
 * able to change both sides; adding something new from a side, that side; unlinking, to have made
 * the link or to be able to change one of its sides.
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
/**
 * What someone typed, for `LIKE ? ESCAPE '\'`: inside it, anywhere, `%`, `_` and `\` as
 * themselves. (Tasks', Projects' and Next's cards.js had it three times: audit of 6/11, sc-feat-14.)
 */
export const likeOf = (text) => `%${String(text ?? '').replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
const sameRef = (a, b) => a.module === b.module && a.type === b.type && String(a.id) === String(b.id);
/** The two sides of a link, always in the same order: one row for a pair, whichever way it was made. */
const ordered = (x, y) => (formatRef(x) < formatRef(y) ? [x, y] : [y, x]);

/**
 * @param {object} options
 * @param {object} options.database
 * @param {() => Array} options.modules        the host's mounted modules ({ mount, config, parts })
 * @param {(user, mount) => boolean} options.uses   whether someone uses a module
 * @param {(mount, userIds, data) => void} [options.notify]   a live notice in a module, for some people
 * @param {(id) => object} [options.userOf]   an account's row: with it, a side's title is kept as
 *   whoever made the link sees it (remember); without it, as the host reads it
 */
export function createLinks({
  database, modules, uses = () => true, notify = () => {}, clock = () => Date.now(), userOf = null,
}) {
  const moduleOf = (mount) => modules().find((m) => m.mount === mount) || null;
  const providerOf = (ref) => moduleOf(ref.module)?.parts?.cards?.[ref.type] || null;
  const now = () => new Date(clock()).toISOString();

  /** The ref of a request, checked: a module of the host and a kind of thing it shows. */
  function refOf(value, field = 'ref') {
    const ref = typeof value === 'string' ? parseRef(value) : value && parseRef(formatRef(value));
    if (!ref || !providerOf(ref)) throw badRequest('field_invalid', { field });
    return ref;
  }

  /**
   * What the owners answer of some things, in the order asked: a card, 'gone' or null (what
   * `read` says), or undefined for a thing no module here shows. One `readMany` for each kind of
   * thing whose module has it, and `read` for the ids it leaves out and for the other kinds.
   */
  function readAll(user, refs, opts) {
    const answers = new Array(refs.length).fill(undefined);
    const kinds = new Map();
    refs.forEach((ref, i) => {
      const provider = moduleOf(ref.module) ? providerOf(ref) : null;
      if (!provider) return;
      const key = `${ref.module}:${ref.type}`;
      if (!kinds.has(key)) kinds.set(key, { provider, at: new Map() });
      const { at } = kinds.get(key);
      const id = String(ref.id);
      if (!at.has(id)) at.set(id, []);
      at.get(id).push(i);
    });
    // read() as it was always asked: (user, id) for a person, (null, id, { system: true }) for the host.
    const args = (ids) => (opts === undefined ? [user, ids] : [user, ids, opts]);
    for (const { provider, at } of kinds.values()) {
      let many = null;
      if (typeof provider.readMany === 'function') {
        try {
          const answer = provider.readMany(...args([...at.keys()]));
          many = answer instanceof Map ? answer : null;
        } catch { many = null; }
      }
      for (const [id, places] of at) {
        let found;
        if (many?.has(id)) found = many.get(id);
        else {
          try { found = provider.read(...args(id)); } catch { found = null; }
        }
        for (const i of places) answers[i] = found ?? null;
      }
    }
    return answers;
  }

  /** A card as the links show it, from what its owner answered (read, readMany or search). */
  function shape(ref, found) {
    const m = moduleOf(ref.module);
    const base = { ref: formatRef(ref), module: ref.module, type: ref.type, app: m?.config.app.name, color: m?.config.app.color };
    if (found === undefined || !m) return { ...base, state: 'hidden' };
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

  /** What some modules' things look like to someone, in the order asked: each card, gone, or hidden from them. */
  const cardsOf = (user, refs) => readAll(user, refs).map((found, i) => shape(refs[i], found));

  /** What one module's thing looks like to someone: its card, gone, or hidden from them. */
  const cardOf = (user, ref) => cardsOf(user, [ref])[0];

  /** Whether someone uses a module, asked once per module in one request (the host reads it from the database). */
  const usesOnce = (user) => {
    const known = new Map();
    return (mount) => {
      if (!known.has(mount)) known.set(mount, uses(user, mount));
      return known.get(mount);
    };
  };

  /** Someone can open it here: they use its module and its owner shows them its card. */
  const visible = (user, ref, using = (mount) => uses(user, mount)) => using(ref.module)
    && !['hidden', 'gone'].includes(cardOf(user, ref).state);

  /**
   * Someone may change it, not only see it: its module's `editable`, asked only of something they
   * can see. A module without it, as before: seeing it is enough. Its trouble is a no.
   */
  const editable = (user, ref, using) => visible(user, ref, using) && mayChange(user, ref);
  /** The module's word alone, for something already known to be visible: no card read again. */
  const mayChange = (user, ref) => {
    const provider = providerOf(ref);
    if (typeof provider?.editable !== 'function') return true;
    try { return Boolean(provider.editable(user, ref.id)); } catch { return false; }
  };
  /** Whether someone may unlink, or change, a link they can see: they made it, or may change one of its sides. */
  const changes = (user, row, using) => row.created_by === user.id || sidesOf(row).some((side) => editable(user, side, using));

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

  /** A link as someone sees it from one of its sides (`card`: the other side's, when it was read already). */
  function present(user, row, from, card = cardOf(user, otherSide(row, from)), canChange = changes(user, row)) {
    const side = otherSide(row, from);
    // Gone: its last title only to who linked it, who could see it then; nobody else learns it from here.
    if (card.state === 'gone' && side.title && row.created_by === user.id) card.title = side.title;
    if (card.state === 'hidden') delete card.title;
    // Whether this person may unlink it or change «together» (the page shows those only then).
    return { id: row.id, together: Boolean(row.together), item: card, can_change: canChange };
  }

  /** The links of something this person can see, to the modules they use. */
  function of(user, value) {
    const ref = refOf(value);
    const using = usesOnce(user);
    if (!visible(user, ref, using)) throw notFound();
    const rows = rowsOf(ref).filter((row) => using(otherSide(row, ref).module));
    // Every other side at once: a readMany for each kind of thing, not a read for each link.
    const cards = cardsOf(user, rows.map((row) => otherSide(row, ref)));
    // Who may change each link, from what is read already: this side is visible, the other's card is here.
    const here = mayChange(user, ref);
    return rows.map((row, i) => {
      const other = otherSide(row, ref);
      const canChange = row.created_by === user.id || here
        || (!['hidden', 'gone'].includes(cards[i].state) && mayChange(user, other));
      return present(user, row, ref, cards[i], canChange);
    });
  }

  /** Whether someone may link something to this, or add something new from it: they can change it. */
  function canLink(user, value) {
    const ref = refOf(value);
    return editable(user, ref, usesOnce(user));
  }

  /** What the host itself reads of some sides (no person: their titles, whether they are gone), in order. */
  const systemRead = (sides) => readAll(null, sides, { system: true });

  /**
   * Remembers the titles of some links' sides, for when one is gone: every side read at once, and
   * a title written only where it changed. Only its maker is shown that title (present), so with
   * `userOf` it is read as they see it: a side they no longer see keeps the last title they saw,
   * and a rename after it never reaches them once it is deleted (audit of 6/11, sc-feat-16). A
   * link whose maker's account went keeps none to show.
   */
  function remember(rows) {
    const sides = rows.flatMap((row) => sidesOf(row).map((side) => ({ ...side, row: row.id, maker: row.created_by })));
    let found;
    if (userOf) {
      found = new Array(sides.length).fill(null);
      const byMaker = new Map();
      sides.forEach((side, i) => {
        if (side.maker == null) return;
        if (!byMaker.has(side.maker)) byMaker.set(side.maker, []);
        byMaker.get(side.maker).push(i);
      });
      for (const [maker, places] of byMaker) {
        let user = null;
        try { user = userOf(maker); } catch { user = null; }
        if (!user) continue;
        const read = readAll(user, places.map((i) => sides[i]));
        places.forEach((i, n) => { found[i] = read[n]; });
      }
    } else found = systemRead(sides);
    sides.forEach((side, i) => {
      const card = found[i];
      if (!card || card === 'gone' || !card.title) return;
      const title = String(card.title).slice(0, TITLE_MAX);
      if (side.title !== title) database.run(`UPDATE host_links SET ${side.column} = ? WHERE id = ?`, title, side.row);
    });
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

  /**
   * Links two things someone can see; each pair once. → `{ link, existed }`: `existed` when the
   * pair was linked already, and `link` is that one, as it was (audit of 6/11, sc-feat-11).
   */
  function connect(user, fromValue, toValue, { together = false } = {}) {
    const from = refOf(fromValue, 'from');
    const to = refOf(toValue, 'to');
    if (sameRef(from, to)) throw badRequest('field_invalid', { field: 'to' });
    if (!visible(user, from)) throw notFound();
    if (!visible(user, to)) throw notFound();
    // Written on both: only by whoever may change both (sc-feat-2).
    if (!editable(user, from) || !editable(user, to)) throw forbidden('forbidden');
    const [a, b] = ordered(from, to);
    const existing = database.get(`SELECT * FROM host_links WHERE a_module = ? AND a_type = ? AND a_id = ?
      AND b_module = ? AND b_type = ? AND b_id = ?`, a.module, a.type, String(a.id), b.module, b.type, String(b.id));
    if (existing) return { link: present(user, existing, from), existed: true };
    const { lastInsertRowid } = database.run(`INSERT INTO host_links
      (a_module, a_type, a_id, b_module, b_type, b_id, together, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.module, a.type, String(a.id), b.module, b.type, String(b.id), together ? 1 : 0, user.id, now());
    const row = database.get('SELECT * FROM host_links WHERE id = ?', lastInsertRowid);
    remember([row]);
    announce(row);
    return { link: present(user, database.get('SELECT * FROM host_links WHERE id = ?', row.id), from), existed: false };
  }

  /** Links two things someone can see; each pair once: the link, new or the one there was. */
  const link = (user, fromValue, toValue, options) => connect(user, fromValue, toValue, options).link;

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
    if (!editable(user, from)) throw forbidden('forbidden');
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
    const using = usesOnce(user);
    // Someone who can see either side may unlink or change it; the rest don't know it is there.
    if (!visible(user, a, using) && !visible(user, b, using)) throw notFound();
    return row;
  }

  function update(user, id, { together }) {
    const row = own(user, id);
    // «Done together» completes the other side with the rights of whoever ticks this one: only by
    // whoever may change both.
    const using = usesOnce(user);
    if (!sidesOf(row).every((side) => editable(user, side, using))) throw forbidden('forbidden');
    database.run('UPDATE host_links SET together = ? WHERE id = ?', together ? 1 : 0, row.id);
    announce(row);
    return database.get('SELECT * FROM host_links WHERE id = ?', row.id);
  }

  function remove(user, id) {
    const row = own(user, id);
    if (!changes(user, row, usesOnce(user))) throw forbidden('forbidden');
    database.run('DELETE FROM host_links WHERE id = ?', row.id);
    announce(row);
  }

  /**
   * What someone may link in a module: its search, and where it may create something. Only "Add
   * to…" shows those, and they cost the module a query or two for each list or notebook: asked at
   * every key of "Link existing…" they were never shown, so that one says `places: false` and gets
   * `places: []` (audit of 6/11, sc-feat-15).
   */
  function search(user, module, type, text, { places: withPlaces = true } = {}) {
    const ref = refOf({ module, type, id: 'x' }, 'module');
    if (!uses(user, ref.module)) return { items: [], places: [] };
    const provider = providerOf(ref);
    // The owner's search chose what this person may link, each card as read() shows it to them:
    // shown as it comes, none read again.
    const items = (provider.search?.(user, String(text || '').slice(0, 200)) || []).slice(0, 30)
      .filter((card) => card && typeof card === 'object' && card.id != null && String(card.id) !== '')
      .map((card) => shape({ ...ref, id: String(card.id) }, card));
    const places = withPlaces
      ? (provider.places?.(user) || []).slice(0, 200).map((p) => ({ id: String(p.id), name: String(p.name) }))
      : [];
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
    const rows = rowsOf(ref);
    if (!rows.length) return;
    remember(rows);
    for (const row of rows) announce(row);
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
          if (row.together && !propagating.has(formatRef(other)) && (!user || uses(user, other.module))) {
            const provider = providerOf(other);
            // A side this person can't complete (not theirs to change, deleted) stays as it was, in
            // a savepoint of its own: what they completed still is, and nothing is left half-done.
            try {
              database.tx(() => provider?.complete?.(user, other.id, Boolean(isDone)));
            } catch { /* left as it was */ }
          }
          announce(row);
        }
      });
    } finally {
      propagating.delete(key);
    }
  }

  /**
   * Forgets what is gone. A side whose thing no longer exists keeps no title, and a link whose two
   * sides are gone goes. The host calls it once someone's data is erased (`{ module }`: that
   * module's sides) or an account is deleted (every side): what was erased leaves nothing behind
   * here. Until then a deleted thing's last title still shows to whoever linked it.
   * → { forgotten, removed }
   */
  function prune({ module = null } = {}) {
    let forgotten = 0;
    let removed = 0;
    const rows = module
      ? database.all('SELECT * FROM host_links WHERE a_module = ? OR b_module = ?', module, module)
      : database.all('SELECT * FROM host_links');
    // Every side at once, a readMany for each kind of thing whose module has it. A module no
    // longer mounted answers nothing: not gone, it may come back.
    const found = systemRead(rows.flatMap((row) => sidesOf(row)));
    database.tx(() => {
      rows.forEach((row, r) => {
        const sides = sidesOf(row);
        const which = [found[2 * r] === 'gone', found[2 * r + 1] === 'gone'];
        if (which[0] && which[1]) {
          database.run('DELETE FROM host_links WHERE id = ?', row.id);
          removed += 1;
          return;
        }
        sides.forEach((side, i) => {
          if (!which[i] || side.title == null || (module && side.module !== module)) return;
          database.run(`UPDATE host_links SET ${side.column} = NULL WHERE id = ?`, row.id);
          forgotten += 1;
        });
      });
    });
    return { forgotten, removed };
  }

  return { of, canLink, link, connect, create, update, remove, search, changed, done, prune };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The host's routes for links, at its root: the modules' pages ask them there. */
export function registerLinksApi(api, { links }) {
  const who = (ctx) => {
    if (!ctx.user) throw unauthorized();
    return ctx.user;
  };
  api.get('/api/links', (ctx) => {
    const user = who(ctx);
    const ref = ctx.query.get('ref');
    // `can_link`: whether this person may link from it (or add something new); the page offers it only then.
    sendJson(ctx.res, 200, { links: links.of(user, ref), can_link: links.canLink(user, ref) });
  });
  // `places=0`: without where "Add to…" may put it (search's `places`), for a search that never shows them.
  api.get('/api/links/search', (ctx) => sendJson(ctx.res, 200,
    links.search(who(ctx), ctx.query.get('module'), ctx.query.get('type'), ctx.query.get('q'),
      { places: ctx.query.get('places') !== '0' })));
  // 201 and the new link; a pair linked already, 200 with that link and `existed: true`.
  api.post('/api/links', async (ctx) => {
    const body = await readJson(ctx.req);
    const { link, existed } = links.connect(who(ctx), body.from, body.to, { together: body.together === true });
    sendJson(ctx.res, existed ? 200 : 201, existed ? { link, existed: true } : { link });
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
      // It may create the thing in another module: a write, and each call adds a link.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
