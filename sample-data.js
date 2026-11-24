/**
 * Sample data (host.js `sampleData`, Cronum Work): with one button an account gets one coherent
 * example in every module it uses, to try the app or record it without filling anything by hand,
 * and with another it goes. A host may have several examples (`examples`), one story each, and
 * the person chooses one. The example is each module's own; the host asks for it, writes down what
 * was made, links what goes together across modules and, when asked, takes it all away again.
 *
 * Each module says how, in its `createModule()`:
 *
 *   sampleData: {
 *     seed({ user, userId, locale, today, example }) → { items: [{ type, id }], anchors?: { name: { type, id } } }
 *        Makes the module's part of the example `example` (one of the host's `examples`; a module
 *        that doesn't have it throws) for `user`, in `locale` (one of the suite's languages) with its
 *        dates around `today` ('YYYY-MM-DD' in their zone), and says what it made: each thing as
 *        `type` and `id`. Synchronous: it runs in a transaction of its own, and a seed that throws
 *        leaves nothing of it behind. `anchors` name some of its things by their part in the story
 *        (`menu`, `launch`): the host links each anchor with the things of the same name in the
 *        other modules (links.js), so each `type` named there is one of its `cards`.
 *     remove({ user, userId, items }) → { removed: [{ type, id }] }
 *        Takes away all that its seed made (`items`), changed or not, and everything the person put
 *        inside the example's own containers (its lists, notebooks, projects), which go too: the
 *        example is the example's, and Settings say so before. What the person has outside it stays.
 *        Synchronous too, in a transaction of its own.
 *   }
 *
 * What was made is written down here (`host_sample_data`, which example and when;
 * `host_sample_items`, each thing): it is how Settings know there is an example to take away, and
 * how the host gives each module back its own. Seeding again is refused while one is there (409
 * `sample_data_present`), so a double click or a page that seeds on its own never makes two. A
 * module that fails is left out and named (`failed`), never the whole example.
 *
 *   GET    /api/me/sample-data   → { present, example, modules: [mount…], available: [mount…], examples: [id…] }
 *   POST   /api/me/sample-data   { example?, locale? } → 201 { present: true, example, modules, failed, links }
 *   DELETE /api/me/sample-data   → { present: false, removed, failed }
 *
 * From the host's own code (a page that makes an account ready for someone, say): `suite.sampleData
 * .seed(user, { example, locale })`, the same as the POST, and `.remove(user)`, `.status(user)`.
 */
import { badRequest, unauthorized, conflict, sendJson, readJson, isObject } from './http.js';
import { LANGUAGES, negotiate } from './i18n.js';
import { todayFor, inZoneOf } from './time.js';

/** The host's tables of what each example made (host.js HOST_MIGRATIONS). */
export function sampleDataSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS host_sample_data (
    user_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    example   TEXT NOT NULL,
    locale    TEXT NOT NULL,
    seeded_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS host_sample_items (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module    TEXT NOT NULL,
    type      TEXT NOT NULL,
    item_id   TEXT NOT NULL,
    PRIMARY KEY (user_id, module, type, item_id)
  )`);
}

/** The links the host made between the modules' things are its own entries: module `''`, type `link`. */
const LINKS = '';
const TYPE = /^[a-z][a-z0-9_]{0,30}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ANCHOR = /^[a-z][a-z0-9-]{0,40}$/;
/** An example's id, as the host names them (`cafe`, `app`). */
export const EXAMPLE = /^[a-z][a-z0-9-]{0,30}$/;

/**
 * The host's option, read: `true` is one example (`default`); `{ examples: ['cafe', 'app'], words }`
 * several, in the order Settings offer them, `words` the prefix of their names in the host's
 * catalog (`samples.` → `samples.cafe.title`, `samples.cafe.hint`). → { examples, words } or null.
 */
export function sampleDataOption(option) {
  if (!option) return null;
  if (option === true) return { examples: ['default'], words: null };
  const examples = Array.isArray(option.examples) ? [...new Set(option.examples.map(String))].filter((id) => EXAMPLE.test(id)) : [];
  if (!examples.length) return { examples: ['default'], words: null };
  const words = typeof option.words === 'string' && /^[A-Za-z][\w.-]*$/.test(option.words) ? option.words : null;
  return { examples, words };
}

/**
 * @param {object} options
 * @param {object} options.database
 * @param {() => Array} options.modules        the host's mounted modules ({ mount, config, parts })
 * @param {(user, mount) => boolean} [options.uses]   whether someone uses a module
 * @param {object} [options.links]             the host's links (links.js), to link the anchors
 * @param {string[]} [options.examples]        the examples there are, the first one by default
 * @param {string[]} [options.languages]       the languages an example may be in
 * @param {(line) => void} [options.log]
 */
export function createSampleData({
  database, modules, uses = () => true, links = null, examples = ['default'], languages = LANGUAGES, log = console.error,
  clock = () => Date.now(),
}) {
  const now = () => new Date(clock()).toISOString();
  /** The modules that have an example to give, in the host's order. */
  const providers = () => modules().filter((m) => typeof m.parts?.sampleData?.seed === 'function'
    && typeof m.parts.sampleData.remove === 'function');
  const recorded = (user) => database.all(
    'SELECT module, type, item_id FROM host_sample_items WHERE user_id = ? ORDER BY rowid', user.id,
  );
  const seededOf = (user) => database.get('SELECT example, locale, seeded_at FROM host_sample_data WHERE user_id = ?', user.id);

  /** Whether someone has an example, which one, in which modules, and what could be given. */
  function status(user) {
    const seeded = seededOf(user);
    const there = [...new Set(recorded(user).map((r) => r.module).filter((mount) => mount !== LINKS))];
    return {
      present: Boolean(seeded),
      example: seeded?.example ?? null,
      modules: there,
      available: providers().filter((m) => uses(user, m.mount)).map((m) => m.mount),
      examples: [...examples],
    };
  }

  /**
   * The language an example is in: the one asked for, else the one the person chose, else their
   * browser's (`browser`, an Accept-Language), else the first of the host's.
   */
  function localeOf(user, locale = null, browser = null) {
    let chosen = user?.locale || null;
    if (!chosen) {
      try {
        const prefs = typeof user?.prefs === 'string' ? JSON.parse(user.prefs || '{}') : (user?.prefs || {});
        chosen = prefs?.lang || null;
      } catch { chosen = null; }
    }
    // A locale written `it_IT` is `it-IT` to the browser's rules.
    return negotiate([locale, chosen, browser].map((value) => (value ? String(value).replace(/_/g, '-') : value)), languages);
  }

  /** What a module's seed says it made, checked: only what can be written down and given back. */
  function madeBy(m, answer) {
    if (!isObject(answer) || !Array.isArray(answer.items)) throw new Error('its seed gave no { items }');
    const items = [];
    for (const item of answer.items) {
      const type = String(item?.type ?? '');
      const id = String(item?.id ?? '');
      if (!TYPE.test(type) || !ID.test(id)) throw new Error(`its seed gave a thing that isn't one (${type}:${id})`);
      items.push({ type, id });
    }
    const anchors = [];
    for (const [name, ref] of Object.entries(isObject(answer.anchors) ? answer.anchors : {})) {
      if (!ANCHOR.test(name) || !TYPE.test(String(ref?.type ?? '')) || !ID.test(String(ref?.id ?? ''))) continue;
      anchors.push({ name, module: m.mount, type: String(ref.type), id: String(ref.id) });
    }
    return { items, anchors };
  }

  /**
   * Fills someone's account with an example (`example`, the first of the host's by default), in
   * every module they use that has one. Refused while one is there. → { present, example, modules, failed, links }
   */
  function seed(user, { example = null, locale = null, browser = null } = {}) {
    if (!user?.id) throw unauthorized();
    const chosen = example == null || example === '' ? examples[0] : String(example);
    if (!examples.includes(chosen)) throw badRequest('field_invalid', { field: 'example', options: [...examples] });
    if (seededOf(user)) throw conflict('sample_data_present');
    const lang = localeOf(user, locale, browser);
    const today = todayFor(user);
    const seeded = [];
    const failed = [];
    const anchors = [];
    for (const m of providers()) {
      if (!uses(user, m.mount)) continue;
      try {
        // In the person's zone, as the module's own routes run: its "today" is theirs.
        const made = inZoneOf(user, () => database.tx(() => {
          const answer = m.parts.sampleData.seed({ user, userId: user.id, locale: lang, today, example: chosen });
          if (answer && typeof answer.then === 'function') throw new TypeError('its seed must be synchronous');
          const checked = madeBy(m, answer);
          for (const item of checked.items) {
            database.run('INSERT OR IGNORE INTO host_sample_items (user_id, module, type, item_id) VALUES (?, ?, ?, ?)',
              user.id, m.mount, item.type, item.id);
          }
          return checked;
        }));
        if (made.items.length) seeded.push(m.mount);
        anchors.push(...made.anchors);
      } catch (err) {
        failed.push(m.mount);
        log(`[sample-data] ${m.mount} seed: ${err?.message || err}`);
      }
    }
    if (seeded.length) {
      database.run('INSERT INTO host_sample_data (user_id, example, locale, seeded_at) VALUES (?, ?, ?, ?)', user.id, chosen, lang, now());
    }
    const linked = linkAnchors(user, anchors);
    return { present: seeded.length > 0, example: chosen, modules: seeded, failed, links: linked };
  }

  /** Each anchor with the ones of the same name in the other modules: each pair once. */
  function linkAnchors(user, anchors) {
    if (!links || anchors.length < 2) return 0;
    let made = 0;
    const byName = new Map();
    for (const anchor of anchors) {
      if (!byName.has(anchor.name)) byName.set(anchor.name, []);
      byName.get(anchor.name).push(anchor);
    }
    for (const [name, group] of byName) {
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const [a, b] = [group[i], group[j]];
          if (a.module === b.module) continue;
          try {
            const { link, existed } = links.connect(user, a, b);
            if (existed || !link?.id) continue;
            database.run("INSERT OR IGNORE INTO host_sample_items (user_id, module, type, item_id) VALUES (?, ?, 'link', ?)",
              user.id, LINKS, String(link.id));
            made += 1;
          } catch (err) {
            log(`[sample-data] link ${name}: ${err?.message || err}`);
          }
        }
      }
    }
    return made;
  }

  /**
   * Takes someone's example away: each module removes all it made and all the person put inside
   * it. The host's links between the modules go with it, and so does any link of the person's to a
   * thing that went. → { present, removed, failed }
   */
  function remove(user) {
    if (!user?.id) throw unauthorized();
    const byModule = new Map();
    for (const row of recorded(user)) {
      if (!byModule.has(row.module)) byModule.set(row.module, []);
      byModule.get(row.module).push({ type: row.type, id: row.item_id });
    }
    const mounted = new Map(providers().map((m) => [m.mount, m]));
    const gone = [];
    const failed = [];
    let removed = 0;
    for (const [mount, items] of byModule) {
      if (mount === LINKS) continue;
      const m = mounted.get(mount);
      // A module no longer mounted keeps its part: it may come back, and its things are still there.
      if (!m) { failed.push(mount); continue; }
      try {
        const answer = inZoneOf(user, () => database.tx(() => {
          const out = m.parts.sampleData.remove({ user, userId: user.id, items });
          if (out && typeof out.then === 'function') throw new TypeError('its remove must be synchronous');
          database.run('DELETE FROM host_sample_items WHERE user_id = ? AND module = ?', user.id, mount);
          return out;
        }));
        const list = Array.isArray(answer) ? answer : Array.isArray(answer?.removed) ? answer.removed : [];
        for (const item of list) {
          if (TYPE.test(String(item?.type ?? '')) && ID.test(String(item?.id ?? ''))) gone.push({ module: mount, type: String(item.type), id: String(item.id) });
        }
        removed += items.length;
      } catch (err) {
        failed.push(mount);
        log(`[sample-data] ${mount} remove: ${err?.message || err}`);
      }
    }
    database.tx(() => {
      // The links it made, and any other to a thing that went: a side that is no more.
      for (const link of byModule.get(LINKS) || []) {
        database.run('DELETE FROM host_links WHERE id = ?', Number(link.id));
      }
      database.run('DELETE FROM host_sample_items WHERE user_id = ? AND module = ?', user.id, LINKS);
      for (const side of gone) {
        database.run(`DELETE FROM host_links WHERE (a_module = ? AND a_type = ? AND a_id = ?)
          OR (b_module = ? AND b_type = ? AND b_id = ?)`, side.module, side.type, side.id, side.module, side.type, side.id);
      }
      if (!database.get('SELECT 1 AS x FROM host_sample_items WHERE user_id = ? LIMIT 1', user.id)) {
        database.run('DELETE FROM host_sample_data WHERE user_id = ?', user.id);
      }
    });
    return { present: Boolean(seededOf(user)), removed, failed };
  }

  return { status, seed, remove, localeOf, examples: [...examples] };
}

/** The routes of Settings › Sample data, at the host's root. */
export function registerSampleDataApi(api, { sampleData }) {
  api.get('/api/me/sample-data', (ctx) => {
    if (!ctx.user) throw unauthorized();
    sendJson(ctx.res, 200, sampleData.status(ctx.user));
  });
  api.post('/api/me/sample-data', async (ctx) => {
    if (!ctx.user) throw unauthorized();
    const body = await readJson(ctx.req);
    if (body.locale != null && typeof body.locale !== 'string') throw badRequest('field_invalid', { field: 'locale' });
    if (body.example != null && typeof body.example !== 'string') throw badRequest('field_invalid', { field: 'example' });
    const answer = sampleData.seed(ctx.user, {
      example: body.example || null, locale: body.locale || null, browser: ctx.req.headers['accept-language'] || null,
    });
    sendJson(ctx.res, 201, answer);
  });
  api.delete('/api/me/sample-data', (ctx) => {
    if (!ctx.user) throw unauthorized();
    sendJson(ctx.res, 200, sampleData.remove(ctx.user));
  });
}
