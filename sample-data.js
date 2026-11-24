/**
 * Sample data (host.js `sampleData`, Cronum Work): with one button an account gets one coherent
 * example in every module it uses, to try the app or record it without filling anything by hand,
 * and with another it goes. The example is each module's own; the host asks for it, writes down
 * what was made, links what goes together across modules and, when asked, takes it away again.
 *
 * Each module says how, in its `createModule()`:
 *
 *   sampleData: {
 *     seed({ user, userId, locale, today }) → { items: [{ type, id, stamp }], anchors?: { name: { type, id } } }
 *        Makes the module's part of the example for `user`, in `locale` (one of the suite's
 *        languages) with its dates around `today` ('YYYY-MM-DD' in their zone), and says what it
 *        made: each thing as `type` and `id`, and its `stamp`, a short text of the module's that
 *        changes when the person changes what they wrote in it (a title, a text). Synchronous: it
 *        runs in a transaction of its own, and a seed that throws leaves nothing of it behind.
 *        `anchors` name some of its things by their part in the story (`menu`, `opening`): the
 *        host links each anchor with the things of the same name in the other modules (links.js),
 *        so each `type` named there is one of its `cards`.
 *     remove({ user, userId, items }) → { removed: [{ type, id }] }
 *        Takes away what its seed made, as `items` (the seed's own, with their stamps): only what
 *        is still as it was made. What the person changed stays, and so does a thing that holds
 *        something of theirs (a list with a task they added, a notebook with their note), so
 *        nothing they wrote goes. Synchronous too, in a transaction of its own. What it kept is
 *        theirs from then on: the host forgets all of it either way.
 *   }
 *
 * What was made is written down here (`host_sample_items`): it is how Settings knows there is an
 * example to take away, and how the host gives each module back its own. Seeding twice is refused
 * while one is there (409 `sample_data_present`), so a double click or a page that seeds on its own
 * never makes two. A module that fails is left out and named (`failed`), never the whole example.
 *
 *   GET    /api/me/sample-data   → { present, modules: [mount…], available: [mount…] }
 *   POST   /api/me/sample-data   { locale? } → 201 { present: true, modules, failed, links }
 *   DELETE /api/me/sample-data   → { present: false, removed, kept, failed }
 *
 * From the host's own code (a page that makes an account ready for someone, say): `suite.sampleData
 * .seed(user, { locale })`, the same as the POST, and `.remove(user)`, `.status(user)`.
 */
import { badRequest, unauthorized, conflict, sendJson, readJson, isObject } from './http.js';
import { LANGUAGES, negotiate } from './i18n.js';
import { todayFor, inZoneOf } from './time.js';

/** The host's table of what each example made (host.js HOST_MIGRATIONS). */
export function sampleDataSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS host_sample_items (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module    TEXT NOT NULL,
    type      TEXT NOT NULL,
    item_id   TEXT NOT NULL,
    stamp     TEXT,
    seeded_at TEXT NOT NULL,
    PRIMARY KEY (user_id, module, type, item_id)
  )`);
}

/** The links the host made between the modules' things are its own entries: module `''`, type `link`. */
const LINKS = '';
const TYPE = /^[a-z][a-z0-9_]{0,30}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ANCHOR = /^[a-z][a-z0-9-]{0,40}$/;
const STAMP_MAX = 200;

/**
 * @param {object} options
 * @param {object} options.database
 * @param {() => Array} options.modules        the host's mounted modules ({ mount, config, parts })
 * @param {(user, mount) => boolean} [options.uses]   whether someone uses a module
 * @param {object} [options.links]             the host's links (links.js), to link the anchors
 * @param {string[]} [options.languages]       the languages an example may be in
 * @param {(line) => void} [options.log]
 */
export function createSampleData({
  database, modules, uses = () => true, links = null, languages = LANGUAGES, log = console.error, clock = () => Date.now(),
}) {
  const now = () => new Date(clock()).toISOString();
  /** The modules that have an example to give, in the host's order. */
  const providers = () => modules().filter((m) => typeof m.parts?.sampleData?.seed === 'function'
    && typeof m.parts.sampleData.remove === 'function');
  const recorded = (user) => database.all(
    'SELECT module, type, item_id, stamp FROM host_sample_items WHERE user_id = ? ORDER BY rowid', user.id,
  );

  /** Whether someone has an example, in which modules, and which modules could give one. */
  function status(user) {
    const rows = recorded(user);
    const there = [...new Set(rows.map((r) => r.module).filter((mount) => mount !== LINKS))];
    return {
      present: rows.length > 0,
      modules: there,
      available: providers().filter((m) => uses(user, m.mount)).map((m) => m.mount),
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
      items.push({ type, id, stamp: item.stamp == null ? null : String(item.stamp).slice(0, STAMP_MAX) });
    }
    const anchors = [];
    for (const [name, ref] of Object.entries(isObject(answer.anchors) ? answer.anchors : {})) {
      if (!ANCHOR.test(name) || !TYPE.test(String(ref?.type ?? '')) || !ID.test(String(ref?.id ?? ''))) continue;
      anchors.push({ name, module: m.mount, type: String(ref.type), id: String(ref.id) });
    }
    return { items, anchors };
  }

  /**
   * Fills someone's account with the example, in every module they use that has one. Refused while
   * one is there. → { present, modules, failed, links }
   */
  function seed(user, { locale = null, browser = null } = {}) {
    if (!user?.id) throw unauthorized();
    if (database.get('SELECT 1 AS x FROM host_sample_items WHERE user_id = ? LIMIT 1', user.id)) {
      throw conflict('sample_data_present');
    }
    const lang = localeOf(user, locale, browser);
    const today = todayFor(user);
    const seeded = [];
    const failed = [];
    const anchors = [];
    const at = now();
    for (const m of providers()) {
      if (!uses(user, m.mount)) continue;
      try {
        // In the person's zone, as the module's own routes run: its "today" is theirs.
        const made = inZoneOf(user, () => database.tx(() => {
          const answer = m.parts.sampleData.seed({ user, userId: user.id, locale: lang, today });
          if (answer && typeof answer.then === 'function') throw new TypeError('its seed must be synchronous');
          const checked = madeBy(m, answer);
          for (const item of checked.items) {
            database.run(`INSERT OR IGNORE INTO host_sample_items (user_id, module, type, item_id, stamp, seeded_at)
              VALUES (?, ?, ?, ?, ?, ?)`, user.id, m.mount, item.type, item.id, item.stamp, at);
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
    const linked = linkAnchors(user, anchors, at);
    return { present: seeded.length > 0, modules: seeded, failed, links: linked };
  }

  /** Each anchor with the ones of the same name in the other modules: each pair once. */
  function linkAnchors(user, anchors, at) {
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
            database.run(`INSERT OR IGNORE INTO host_sample_items (user_id, module, type, item_id, stamp, seeded_at)
              VALUES (?, ?, 'link', ?, ?, ?)`, user.id, LINKS, String(link.id), `${a.module}:${a.type}:${a.id} ${b.module}:${b.type}:${b.id}`, at);
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
   * Takes someone's example away: each module removes what it made and is still as it was, and
   * keeps the rest, which is theirs from then on. The host's links between the modules go with a
   * side that went. → { present, removed, kept, failed }
   */
  function remove(user) {
    if (!user?.id) throw unauthorized();
    const rows = recorded(user);
    const byModule = new Map();
    for (const row of rows) {
      if (!byModule.has(row.module)) byModule.set(row.module, []);
      byModule.get(row.module).push({ type: row.type, id: row.item_id, stamp: row.stamp });
    }
    const mounted = new Map(providers().map((m) => [m.mount, m]));
    const gone = new Set();
    const failed = [];
    let removed = 0;
    let kept = 0;
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
        const asked = new Set(items.map((item) => `${item.type}:${item.id}`));
        const went = new Set(list.map((item) => `${item?.type}:${item?.id}`).filter((key) => asked.has(key)));
        for (const key of went) gone.add(`${mount}:${key}`);
        removed += went.size;
        kept += items.length - went.size;
      } catch (err) {
        failed.push(mount);
        log(`[sample-data] ${mount} remove: ${err?.message || err}`);
      }
    }
    // The links it made: one whose side went goes too; between two things kept, it stays theirs.
    for (const link of byModule.get(LINKS) || []) {
      const sides = String(link.stamp || '').split(' ');
      const sideGone = sides.some((side) => gone.has(side));
      const moduleLeft = sides.some((side) => failed.includes(side.split(':')[0]));
      if (moduleLeft) continue;
      if (sideGone) database.run('DELETE FROM host_links WHERE id = ?', Number(link.id));
      database.run('DELETE FROM host_sample_items WHERE user_id = ? AND module = ? AND type = ? AND item_id = ?',
        user.id, LINKS, 'link', link.id);
    }
    return { present: Boolean(database.get('SELECT 1 AS x FROM host_sample_items WHERE user_id = ? LIMIT 1', user.id)), removed, kept, failed };
  }

  return { status, seed, remove, localeOf };
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
    const answer = sampleData.seed(ctx.user, { locale: body.locale || null, browser: ctx.req.headers['accept-language'] || null });
    sendJson(ctx.res, 201, answer);
  });
  api.delete('/api/me/sample-data', (ctx) => {
    if (!ctx.user) throw unauthorized();
    sendJson(ctx.res, 200, sampleData.remove(ctx.user));
  });
}
