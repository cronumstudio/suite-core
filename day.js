/**
 * The host's daily summary (host.js `day`, Cronum Work): in the morning, what someone has for
 * today in every module they use, with everything still open from before; in the evening, what
 * they did. One page of the host's own shows both (`GET /api/day`), and two notices a day lead to
 * it, each at the time the person chose (`prefs.day`). Read-only: each thing opens in its module,
 * which owns it and decides who sees it.
 *
 * Each module says what it has, in its `createModule()`:
 *
 *   day: {
 *     agenda(user, { today, limit }) → [item…] | { items: [item…], overdueTotal }
 *                                          (or a promise of either: the open things of `user` dated
 *                                          on or before `today`, 'YYYY-MM-DD' in their zone, overdue
 *                                          being before it; and what they planned for today without
 *                                          a date, `planned: true` with today's date. Only their
 *                                          own, with the same permissions as the module's pages.
 *                                          `limit` (DAY_MODULE_MAX) is the most the host keeps of
 *                                          each of the two, the overdue and today's: the oldest of
 *                                          the overdue, all of today's up to it, so a module asks
 *                                          for no more than that of each. `overdueTotal`, when it
 *                                          gives fewer overdue things than it has: how many it has
 *                                          (the notice says that number, not the length))
 *     done(user, { day, limit }) → [item…] (what `user` did on `day`, 'YYYY-MM-DD' in their zone;
 *                                          the host keeps the latest `limit`)
 *   }
 *
 * An agenda item is `{ type, id, title, date, where, url, planned? }`; a done one
 * `{ type, id, title, at, where, url, kind }`, `at` an ISO instant and `kind` 'completed' (a task
 * finished), 'logged' (a step logged, in Next) or 'written' (a note created or edited). `type`,
 * `id`, `title`, `where` and `url` say what they say in the calendar (calendar.js). Anything else
 * an item carries (`mine`, a `time` of day) is left out: no page reads it.
 *
 * `limit` came with 0.286.0 (audit of 6/11, sc-feat-14): a module that sees it in its args knows
 * the host also takes `{ items, overdueTotal }`; one before it took only the list (sc-feat-5).
 *
 * Only the modules the person uses are asked, all at once and in their zone. One that fails is
 * left out and named (`failed`), never the whole answer, as in the calendar.
 */
import { badRequest, unauthorized, sendJson, isoDate } from './http.js';
import { inZoneOf, todayFor, zoneOf, dayIn, addDays } from './time.js';
import { readPrefs } from './prefs.js';

/**
 * The most kept of a module for one list: its oldest overdue things, its things for today (all of
 * them, up to this: the overdue never push them out, audit of 6/11, sc-feat-5) and its latest of
 * what was done. Passed to the modules as `limit`.
 */
export const DAY_MODULE_MAX = 200;
/** What a thing done can be. */
export const DONE_KINDS = Object.freeze(['completed', 'logged', 'written']);
/** The two notices, in the order of the day. */
export const DAY_NOTICES = Object.freeze(['morning', 'evening']);
/** Each notice as nothing stored says: on, at its hour of the person's day. */
export const DAY_DEFAULTS = Object.freeze({
  morning: Object.freeze({ on: true, at: '08:00' }),
  evening: Object.freeze({ on: true, at: '19:00' }),
});
/** Which notice each part of the summary goes in: what is open in the morning's, what was done in the evening's. */
export const DAY_PARTS = Object.freeze({ agenda: 'morning', done: 'evening' });
/** A module's mount, as the host names them (host.js): the keys of a notice's `modules`. */
const MOUNT = /^[a-z][a-z0-9-]{1,30}$/;
/** The most modules a notice keeps a choice of. */
const MODULES_MAX = 40;
/** How long after its time a notice is still sent: a server down at eight still says it at nine. */
export const DAY_WINDOW_MINUTES = 180;
/**
 * How long the notices sent are remembered, in days before today in UTC: past any day still being
 * asked about (every zone's today is within a day of UTC's), and a couple more to see what went.
 * Forgotten once a day. It was 60 days, read every minute (audit of 6/11, sc-feat-1).
 */
export const DAY_LOG_DAYS = 3;
const TITLE_MAX = 300;
/** A title in a notice: the start of it, enough to know which it is. */
const NOTICE_TITLE_MAX = 80;
/** A notice's time: every five minutes, as the time field steps. */
const STEP = /^(?:[01]\d|2[0-3]):[0-5][05]$/;
/** People whose devices are asked for at once. */
const PEOPLE_AT_ONCE = 200;

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/* ------------------------------ preferences ------------------------------ */

/**
 * Someone's two notices, from what their row holds (`users.prefs`, text or read): each `{ on, at,
 * modules }`, the default for what isn't stored or isn't one. `modules` names only the modules
 * taken out of that notice (`{ notes: false }`): every other one is in it, one that comes later
 * too. Whoever had turned off Projects' morning summary of due dates (`notices.due === false`)
 * starts with this morning one off too: it is the same notice, now for every module, and nothing
 * has to be migrated for it.
 */
export function dayPrefsOf(raw) {
  const prefs = readPrefs(raw);
  const stored = isPlain(prefs.day) ? prefs.day : {};
  const one = (kind, on) => {
    const given = isPlain(stored[kind]) ? stored[kind] : {};
    const out = isPlain(given.modules)
      ? Object.entries(given.modules).filter(([mount, kept]) => MOUNT.test(mount) && kept === false).slice(0, MODULES_MAX)
      : [];
    return {
      on: typeof given.on === 'boolean' ? given.on : on,
      at: typeof given.at === 'string' && STEP.test(given.at) ? given.at : DAY_DEFAULTS[kind].at,
      modules: Object.fromEntries(out),
    };
  };
  return { morning: one('morning', prefs.notices?.due !== false), evening: one('evening', true) };
}

/**
 * The host's own preference, among the modules' (prefs.js): `prefs.day`, saved with the rest at
 * the host's `/api/me` (`PATCH { prefs: { day: { evening: { at: '20:30' } } } }`). What comes is
 * what changes: one notice's switch leaves its time and the other notice as they were, and one
 * module's switch (`{ morning: { modules: { notes: false } } }`, true to bring it back) leaves the
 * other modules as they were. A notice that isn't one, a switch that isn't true or false, a time
 * that isn't HH:MM in steps of five minutes and a module that isn't a mount are refused (400
 * `field_invalid`, field `day`), not taken for the default. Once anything is saved there, the row
 * holds `day` whole, as it read: a morning that started off stays off.
 */
export const DAY_PREFS = Object.freeze({
  defaults: { day: { morning: { ...DAY_DEFAULTS.morning, modules: {} }, evening: { ...DAY_DEFAULTS.evening, modules: {} } } },
  normalize: (raw) => ({ day: dayPrefsOf(raw) }),
  merge: (current, changes) => {
    if (!('day' in changes)) return current;
    const sent = changes.day;
    const invalid = () => badRequest('field_invalid', { field: 'day' });
    if (!isPlain(sent)) throw invalid();
    const day = {
      morning: { ...current.day.morning, modules: { ...current.day.morning.modules } },
      evening: { ...current.day.evening, modules: { ...current.day.evening.modules } },
    };
    for (const [kind, value] of Object.entries(sent)) {
      if (!DAY_NOTICES.includes(kind) || !isPlain(value)) throw invalid();
      if ('on' in value) {
        if (typeof value.on !== 'boolean') throw invalid();
        day[kind].on = value.on;
      }
      if ('at' in value) {
        if (typeof value.at !== 'string' || !STEP.test(value.at)) throw invalid();
        day[kind].at = value.at;
      }
      if ('modules' in value) {
        if (!isPlain(value.modules)) throw invalid();
        for (const [mount, kept] of Object.entries(value.modules)) {
          if (!MOUNT.test(mount) || typeof kept !== 'boolean') throw invalid();
          if (kept) delete day[kind].modules[mount];
          else day[kind].modules[mount] = false;
        }
        if (Object.keys(day[kind].modules).length > MODULES_MAX) throw invalid();
      }
    }
    return { day };
  },
});

/* ------------------------------ the lists ------------------------------ */

const idOf = (raw) => (typeof raw.id === 'number' || (typeof raw.id === 'string' && raw.id) ? raw.id : null);
const urlOf = (m, raw) => (typeof raw.url === 'string' && !raw.url.startsWith('/') ? `/${m.mount}/${raw.url}` : null);
const keyOf = (item) => `${item.module}:${item.type}:${item.id}`;

/** An open thing as the page shows it, from what its module gave; null for one that can't be shown. */
function agendaItemOf(m, raw, today) {
  if (!isPlain(raw)) return null;
  const id = idOf(raw);
  const date = isoDate(raw.date);
  // After today it is no business of today's: the module's mistake, and nothing to show here.
  if (typeof raw.type !== 'string' || !raw.type || id === null || !date || date > today) return null;
  const url = urlOf(m, raw);
  return {
    module: m.mount, type: raw.type, id, title: String(raw.title ?? '').slice(0, TITLE_MAX), date,
    where: String(raw.where ?? '').slice(0, TITLE_MAX),
    ...(url ? { url } : {}), ...(raw.planned === true ? { planned: true } : {}),
  };
}

/**
 * A thing done as the page shows it; null for one that can't be shown. Its instant is not checked
 * against the day: each module reads its own day in the person's zone, from what it stores.
 */
function doneItemOf(m, raw) {
  if (!isPlain(raw)) return null;
  const id = idOf(raw);
  const at = typeof raw.at === 'string' ? Date.parse(raw.at) : NaN;
  if (typeof raw.type !== 'string' || !raw.type || id === null || Number.isNaN(at) || !DONE_KINDS.includes(raw.kind)) return null;
  const url = urlOf(m, raw);
  return {
    module: m.mount, type: raw.type, id, title: String(raw.title ?? '').slice(0, TITLE_MAX),
    at: new Date(at).toISOString(), where: String(raw.where ?? '').slice(0, TITLE_MAX), ...(url ? { url } : {}), kind: raw.kind,
  };
}

/** Oldest first; the module's own order among the same day. */
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
/** Latest first. */
const byLatest = (a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0);
/** A count a module gave: a whole number, not below zero. */
const countOf = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

/**
 * Each thing of a module once, in a list already in its order: the first of it there, so a task
 * both overdue and in My Day is said where it is the furthest behind, a note edited twice at its latest.
 */
function once(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * @param {object} options
 * @param {() => Array} options.modules        the host's mounted modules ({ mount, config, parts }), in order
 * @param {(user, mount) => boolean} [options.uses]   whether someone uses a module
 * @param {(m) => string} [options.icon]       a module's icon as the host's pages show it
 */
export function createDay({ modules, uses = () => true, icon = (m) => m.config.app.icon, log = () => {} }) {
  const has = (m, part) => typeof m.parts?.day?.[part] === 'function';
  /** Whether someone keeps a module in the notice of a part (Settings › Daily summary): yes unless they took it out. */
  const kept = (user, part, m) => dayPrefsOf(user?.prefs)[DAY_PARTS[part]].modules[m.mount] !== false;
  /**
   * Whether someone uses each module, asked once a module for one summary or notice: GET /api/day
   * asked it of every module three times over (audit of 6/11, sc-host-11).
   */
  const usingOf = (user) => {
    const known = new Map();
    return (mount) => {
      if (!known.has(mount)) known.set(mount, uses(user, mount));
      return known.get(mount);
    };
  };
  /**
   * The modules with a part of the summary that someone uses, in the host's order; for one part,
   * only those they keep in its notice, which is what its page shows too.
   */
  const sourcesOf = (user, part = null, every = false, using = usingOf(user)) => modules()
    .filter((m) => (part ? has(m, part) && (every || kept(user, part, m)) : has(m, 'agenda') || has(m, 'done')) && using(m.mount));

  /**
   * What each module gives for one part, in the person's zone: what `keep` makes of its answer, or
   * null where it failed.
   */
  async function ask(user, part, args, keep, { every = false, using } = {}) {
    const sources = sourcesOf(user, part, every, using);
    const answers = await Promise.all(sources.map(async (m) => {
      try {
        const given = await inZoneOf(user, () => m.parts.day[part](user, { ...args, limit: DAY_MODULE_MAX }));
        return keep(m, given);
      } catch (error) {
        // One module that fails leaves its part empty, not everyone's summary.
        log(`[day] ${m.mount} ${part}: ${error?.message || error}`);
        return null;
      }
    }));
    const rank = new Map(sources.map((m, i) => [m.mount, i]));
    return {
      answers: answers.filter(Boolean),
      rank: (item) => rank.get(item.module),
      failed: sources.filter((m, i) => answers[i] === null).map((m) => m.mount),
    };
  }

  /**
   * What someone has open on or before `today`: `{ overdue, today, overdueTotal, failed }`, overdue
   * the oldest first, each day's then in the modules' order and each module's own order.
   * `overdueTotal` is how many are overdue, past what the modules gave (their `overdueTotal`).
   */
  async function agenda(user, { today }, { using } = {}) {
    const asked = await ask(user, 'agenda', { today }, (m, given) => {
      const list = Array.isArray(given) ? given : isPlain(given) && Array.isArray(given.items) ? given.items : null;
      if (!list) throw new Error('its agenda gave no list');
      const items = once(list.map((raw) => agendaItemOf(m, raw, today)).filter(Boolean).sort(byDate));
      // Its oldest overdue and all of today's, each up to the cap: the overdue never push today's out.
      const overdue = items.filter((item) => item.date < today);
      return {
        overdue: overdue.slice(0, DAY_MODULE_MAX),
        today: items.filter((item) => item.date === today).slice(0, DAY_MODULE_MAX),
        total: Math.max(overdue.length, countOf(Array.isArray(given) ? 0 : given.overdueTotal)),
      };
    }, { using });
    const inOrder = (a, b) => byDate(a, b) || asked.rank(a) - asked.rank(b);
    return {
      overdue: asked.answers.flatMap((one) => one.overdue).sort(inOrder),
      today: asked.answers.flatMap((one) => one.today).sort(inOrder),
      overdueTotal: asked.answers.reduce((sum, one) => sum + one.total, 0),
      failed: asked.failed,
    };
  }

  /**
   * What someone did on `day`: `{ done, failed }`, the latest first, then in the modules' order.
   * `every` counts the modules they took out of the evening's notice too: for a module that asks
   * what was done, for its own ends, and not to write that notice.
   */
  async function done(user, { day, every = false }, { using } = {}) {
    const asked = await ask(user, 'done', { day }, (m, given) => {
      if (!Array.isArray(given)) throw new Error('its done gave no list');
      return once(given.map((raw) => doneItemOf(m, raw)).filter(Boolean).sort(byLatest)).slice(0, DAY_MODULE_MAX);
    }, { every, using });
    return { done: asked.answers.flat().sort((a, b) => byLatest(a, b) || asked.rank(a) - asked.rank(b)), failed: asked.failed };
  }

  /**
   * The page's answer for `date` (the person's today without it): `{ date, modules, overdue,
   * overdue_total, today, done, failed? }`, `modules` those asked, for the page to draw each one's
   * things with its name, colour and icon; `overdue_total` how many are overdue, which may be more
   * than the overdue listed. A date that isn't one is a 400 naming `date`.
   */
  async function summary(user, { date = null } = {}) {
    const day = date == null || date === '' ? todayFor(user) : isoDate(date);
    if (!day) throw badRequest('field_invalid', { field: 'date' });
    const using = usingOf(user);
    const [open, finished] = await Promise.all([agenda(user, { today: day }, { using }), done(user, { day }, { using })]);
    const sources = sourcesOf(user, null, false, using);
    const failed = sources.map((m) => m.mount).filter((mount) => open.failed.includes(mount) || finished.failed.includes(mount));
    return {
      date: day,
      modules: sources.map((m) => ({ mount: m.mount, name: m.config.app.name, color: m.config.app.color, icon: icon(m) })),
      overdue: open.overdue,
      overdue_total: open.overdueTotal,
      today: open.today,
      done: finished.done,
      ...(failed.length ? { failed } : {}),
    };
  }

  return { agenda, done, summary, names: () => new Map(modules().map((m) => [m.mount, m.config.app.name])) };
}

/** The host's route for its page, at its root: `GET /api/day?date=`. */
export function registerDayApi(api, { day }) {
  api.get('/api/day', async (ctx) => {
    if (!ctx.user) throw unauthorized();
    sendJson(ctx.res, 200, await day.summary(ctx.user, { date: ctx.query.get('date') }));
  });
}

/* ------------------------------ the notices ------------------------------ */

const lists = new Map();
const listOf = (lang) => {
  if (!lists.has(lang)) lists.set(lang, new Intl.ListFormat(lang, { type: 'conjunction' }));
  return lists.get(lang);
};
const cut = (text) => (text.length > NOTICE_TITLE_MAX ? `${text.slice(0, NOTICE_TITLE_MAX - 1).trimEnd()}…` : text);

/**
 * What a notice says, in the language of `t` (`lang` for its lists), from the lists of the
 * summary; null when there is nothing to say, and nothing is sent.
 *
 * - morning: «☀️ Mira lo que tienes para hacer hoy», «3 vencidas · 5 para hoy: «A», «B» y 3 más»,
 *   the titles named being today's, or the overdue ones when nothing is for today;
 * - evening: «🌙 Lo que has hecho hoy», «7 tareas, 2 pasos en Next y 1 nota», the steps by module.
 *
 * The overdue are counted as `overdueTotal` says when it is more than those listed (a module
 * that gave its oldest only: audit of 6/11, sc-feat-5).
 *
 * `page` is the host's page of the summary (`/today/`): the evening opens it on what was done.
 */
export function dayNotice(kind, {
  overdue = [], today = [], done = [], overdueTotal = 0,
} = {}, { t, lang = 'en', page = '/today/', names = new Map() } = {}) {
  const join = (parts) => listOf(lang).format(parts);
  if (kind === 'morning') {
    const late = Math.max(overdue.length, countOf(overdueTotal));
    if (!late && !today.length) return null;
    const counts = [
      late ? t('kit.day.notice.overdue', { n: late }) : null,
      today.length ? t('kit.day.notice.today', { n: today.length }) : null,
    ].filter(Boolean).join(' · ');
    const named = today.length ? today : overdue;
    const shown = named.slice(0, 2).map((item) => t('kit.day.notice.quoted', { title: cut(item.title || '…') }));
    const more = shown.length ? (today.length ? today.length : late) - shown.length : 0;
    return {
      title: t('kit.day.notice.morningTitle'),
      body: t('kit.day.notice.morningBody', { counts, titles: join(more > 0 ? [...shown, t('kit.day.notice.more', { n: more })] : shown) }),
      tag: 'day-morning',
      url: page,
    };
  }
  if (kind === 'evening') {
    if (!done.length) return null;
    const count = (which) => done.filter((item) => item.kind === which).length;
    // The steps by module ("2 steps in Next"): the only kind whose words name where.
    const logged = new Map();
    for (const item of done.filter((one) => one.kind === 'logged')) logged.set(item.module, (logged.get(item.module) || 0) + 1);
    const parts = [
      count('completed') ? t('kit.day.notice.completed', { n: count('completed') }) : null,
      ...[...logged].map(([mount, n]) => t('kit.day.notice.logged', { n, module: names.get(mount) || mount })),
      count('written') ? t('kit.day.notice.written', { n: count('written') }) : null,
    ].filter(Boolean);
    return {
      title: t('kit.day.notice.eveningTitle'),
      body: join(parts),
      tag: 'day-evening',
      url: `${page}?v=done`,
    };
  }
  return null;
}

const clocks = new Map();
/** The minute of the day (0–1439) an instant falls on in `zone`. */
function minuteIn(zone, instant) {
  if (!clocks.has(zone)) {
    clocks.set(zone, new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  }
  const parts = Object.fromEntries(clocks.get(zone).formatToParts(instant).map((p) => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}
const minutesOf = (at) => Number(at.slice(0, 2)) * 60 + Number(at.slice(3, 5));

/**
 * The two notices of the summary, for everyone with a device (a browser subscribed or a phone
 * with the app: push.subscriptionsOf). `check({ now })` runs every minute (host.js): a notice is
 * due from its time (`prefs.day`) until three hours after it, on the person's day in their zone
 * (`prefs.tz`, else the server's), and never past midnight, which is the next day's. Each one is
 * claimed in `host_day_notices` (one row a person, notice and day) before anything is built or
 * sent, so two checks at once, or the next one while this one still sends, can't both send it;
 * then its lists are asked of the modules, and with nothing to say nothing is sent (the day counts
 * as done all the same). It goes through the host's own push, not a module's: it opens the host's
 * page. → `{ sent, empty }`.
 *
 * @param {object} options
 * @param {object} options.database
 * @param {object} options.push            the host's (push.js): subscriptionsOf, deliver, and
 *   peopleWithDevices when it has it (only those accounts are read)
 * @param {object} options.day             createDay()
 * @param {Function} options.texts         (req, user) → { lang, t }: the host's texts (i18n.js createTexts)
 * @param {(id) => object} options.userById  the whole row of an account, as the modules get it
 * @param {string} [options.page]          the host's page of the summary (`/today/`)
 * @param {Array} [options.languages]      the host's
 * @param {number} [options.everyMinutes]  look only at the checks of a UTC minute of this step (5:
 *   the step of a notice's time), or one that comes a step after the last that looked. 1, every one
 */
export function createDayNotices({
  database, push, day, texts, userById, page = '/today/', languages = ['en'], log = () => {}, everyMinutes = 1,
}) {
  /** The language someone reads a notice in: their choice, the device's, the one their browser last used, their account's. */
  const languageOf = (user, device) => {
    const prefs = readPrefs(user?.prefs);
    const known = (lang) => (typeof lang === 'string' && languages.includes(lang.slice(0, 2).toLowerCase()) ? lang.slice(0, 2).toLowerCase() : null);
    return known(prefs.lang) || known(device?.lang) || known(prefs.lang_seen) || known(user?.locale) || null;
  };

  /** The people among `ids` with a device to tell. */
  function withDevices(ids) {
    const found = new Set();
    for (let i = 0; i < ids.length; i += PEOPLE_AT_ONCE) {
      for (const device of push.subscriptionsOf(ids.slice(i, i + PEOPLE_AT_ONCE))) found.add(Number(device.user_id));
    }
    return found;
  }

  /** The lists a notice speaks of, for someone on their day. */
  async function listsFor(user, kind, onDay) {
    if (kind === 'morning') return day.agenda(user, { today: onDay });
    return day.done(user, { day: onDay });
  }

  /**
   * The accounts a notice could reach: with push.peopleWithDevices(), only those with a device
   * (a person without one was read, and asked for devices, every minute of both their windows:
   * audit of 6/11, sc-feat-1); without it, every account on, as before. Their rows, by id.
   */
  function candidates() {
    if (typeof push.peopleWithDevices !== 'function') {
      return database.all('SELECT id, prefs FROM users WHERE disabled_at IS NULL ORDER BY id');
    }
    const ids = [...new Set(push.peopleWithDevices().map(Number))].filter(Number.isSafeInteger).sort((a, b) => a - b);
    const rows = [];
    for (let i = 0; i < ids.length; i += PEOPLE_AT_ONCE) {
      const batch = ids.slice(i, i + PEOPLE_AT_ONCE);
      rows.push(...database.all(`SELECT id, prefs FROM users WHERE disabled_at IS NULL AND id IN (${batch.map(() => '?').join(', ')})
        ORDER BY id`, ...batch));
    }
    return rows;
  }

  /** The UTC day the notices sent were last forgotten on: once a day, not every minute. */
  let forgotten = null;

  async function run(now) {
    // Whose notice is due now, each on their own day and at their own time.
    const due = [];
    // The minute and the day of `now` in each zone, read once a zone rather than once a person:
    // with every account in one stretch each minute, that was most of it (audit of 6/11, perf-srv-1).
    const clockOf = new Map();
    const inZone = (zone) => {
      if (!clockOf.has(zone)) clockOf.set(zone, { minute: minuteIn(zone, now), day: dayIn(zone, now) });
      return clockOf.get(zone);
    };
    for (const row of candidates()) {
      // Their preferences read once, for the zone and for the notices.
      const stored = readPrefs(row.prefs);
      const { minute, day: today } = inZone(zoneOf({ prefs: stored }));
      const prefs = dayPrefsOf(stored);
      for (const kind of DAY_NOTICES) {
        const { on, at } = prefs[kind];
        const from = minutesOf(at);
        if (on && minute >= from && minute < from + DAY_WINDOW_MINUTES) due.push({ userId: row.id, kind, day: today });
      }
    }
    const result = { sent: 0, empty: 0 };
    if (due.length) {
      const days = [...new Set(due.map((d) => d.day))];
      const told = new Set(database.all(`SELECT user_id, kind, day FROM host_day_notices WHERE day IN (${days.map(() => '?').join(', ')})`, ...days)
        .map((r) => `${r.user_id}:${r.kind}:${r.day}`));
      const waiting = due.filter((d) => !told.has(`${d.userId}:${d.kind}:${d.day}`));
      const people = waiting.length ? withDevices([...new Set(waiting.map((d) => d.userId))]) : new Set();
      for (const notice of waiting.filter((d) => people.has(d.userId))) {
        // Claimed before anything is asked or sent: whoever claims it is the only one to send it.
        const claimed = database.run(`INSERT OR IGNORE INTO host_day_notices (user_id, kind, day, claimed_at)
          VALUES (?, ?, ?, ?)`, notice.userId, notice.kind, notice.day, now.toISOString());
        if (claimed.changes !== 1) continue;
        const outcome = (value) => database.run('UPDATE host_day_notices SET outcome = ? WHERE user_id = ? AND kind = ? AND day = ?',
          value, notice.userId, notice.kind, notice.day);
        try {
          const user = userById(notice.userId);
          if (!user) continue;
          const found = await listsFor(user, notice.kind, notice.day);
          const names = day.names();
          const say = (device) => {
            const lang = languageOf(user, device);
            const { lang: spoken, t } = texts(lang ? { headers: { 'accept-language': lang } } : null, null);
            return dayNotice(notice.kind, found, { t, lang: spoken, page, names });
          };
          if (!say(null)) {
            result.empty += 1;
            outcome('empty');
            continue;
          }
          await push.deliver(push.subscriptionsOf([notice.userId]), say,
            { topic: `day-${notice.kind}`, ttl: DAY_WINDOW_MINUTES * 60 });
          result.sent += 1;
          outcome('sent');
        } catch (error) {
          // This one is lost for the day (it was claimed); the others still go.
          log(`[day] the ${notice.kind} notice of user ${notice.userId} failed: ${error?.message || error}`);
          outcome('failed');
        }
      }
    }
    const utcDay = dayIn('UTC', now);
    if (forgotten !== utcDay) {
      database.run('DELETE FROM host_day_notices WHERE day < ?', addDays(utcDay, -DAY_LOG_DAYS));
      forgotten = utcDay;
    }
    return result;
  }

  // One check at a time: a slow one (many people at eight, a slow module) isn't joined by the next minute's.
  let running = null;
  /** When the last check that looked ran (ms), for `everyMinutes`. */
  let looked = null;
  function check({ now = new Date() } = {}) {
    if (running) return running;
    // Every notice's time is on a five-minute step (STEP), and every zone today is a whole number
    // of quarter hours from UTC, so a notice can only come due at a UTC minute of that step: the
    // checks between look at nothing. One that comes later than a step since the last one looked
    // (a busy minute, a slow check) looks all the same.
    const at = now.getTime();
    if (everyMinutes > 1 && looked !== null && Math.floor(at / 60000) % everyMinutes !== 0
      && at - looked < everyMinutes * 60000) return Promise.resolve({ sent: 0, empty: 0 });
    looked = at;
    running = run(now).finally(() => { running = null; });
    return running;
  }

  return { check };
}

/** The host's table of notices sent (host.js HOST_MIGRATIONS): one row a person, notice and day. */
export function dayNoticesSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS host_day_notices (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    day        TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    outcome    TEXT,
    PRIMARY KEY (user_id, kind, day)
  )`);
}
