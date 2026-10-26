/**
 * The host's calendar (host.js `calendar`, Cronum Work): what has a date in
 * each module, by day, on one page of the host's own. Read-only: each thing
 * opens in its module, which owns it and decides who sees it.
 *
 * Each module says what it has with a date, in its `createModule()`:
 *
 *   calendar: {
 *     range(user, { from, to }) → [item…]   (or a promise of them: what `user` sees with a date in
 *                                            [from, to], both 'YYYY-MM-DD' and included; an item is
 *                                            there when its span [start, end] overlaps them. The same
 *                                            permissions as the module's own pages; [] for nothing)
 *   }
 *
 * An item is `{ type, id, title, start, end, state: 'open' | 'done', where, url, mine?, time? }`:
 * `type` the module's own kind of thing (`task`, `phase`, `daily`), `id` the row's, `start` and
 * `end` its first and last day (the same for one day), `where` what is shown under the title (a
 * list, a project › phase, a notebook), `url` a path of the module's (`?list=3&task=9`) taken under
 * the module's own path here, as the links' cards (links.js), `mine` whether it is the person's
 * (assigned to them), `time` 'HH:MM' when it has a real time of day.
 *
 * Only the modules the person uses are asked, all at once. One that fails is left out and named
 * (`failed`), never the whole answer: the rest of the calendar still shows.
 */
import { badRequest, unauthorized, sendJson, isoDate } from './http.js';
import { addDays, inZoneOf, todayFor } from './time.js';

/** The longest span asked at once, in days with both ends: a whole year, a leap one too. */
export const CALENDAR_MAX_DAYS = 366;
/** The most items a module gives for one span: its earliest, so a busy module can't drown the rest. */
export const CALENDAR_MODULE_MAX = 2000;
const TITLE_MAX = 300;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Calendar days from one date to another (both YYYY-MM-DD): at noon UTC, no daylight-saving hour moves one. */
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);

/**
 * A span asked of the calendar, checked: `{ from, to }` as dates, `to` not before `from` and the
 * two at most CALENDAR_MAX_DAYS days apart, both included. Else a 400 naming the field.
 */
export function calendarSpan(from, to) {
  const start = isoDate(from);
  if (!start) throw badRequest('field_invalid', { field: 'from' });
  const end = isoDate(to);
  if (!end || end < start || daysBetween(start, end) + 1 > CALENDAR_MAX_DAYS) throw badRequest('field_invalid', { field: 'to' });
  return { from: start, to: end };
}

/** Earliest first, the longest of those first: what a module keeps under its cap, and its order. */
const byDays = (a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? 1 : a.end > b.end ? -1 : 0);

/**
 * @param {object} options
 * @param {() => Array} options.modules        the host's mounted modules ({ mount, config, parts }), in order
 * @param {(user, mount) => boolean} [options.uses]   whether someone uses a module
 * @param {(m) => string} [options.icon]       a module's icon as the host's pages show it
 */
export function createCalendar({ modules, uses = () => true, icon = (m) => m.config.app.icon, log = () => {} }) {
  /** The modules with a calendar that someone uses, in the host's order. */
  const sourcesOf = (user) => modules().filter((m) => typeof m.parts?.calendar?.range === 'function' && uses(user, m.mount));

  /** An item as the calendar shows it, from what its module gave; null for one that can't be shown. */
  function itemOf(m, raw, { from, to }) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'number' || (typeof raw.id === 'string' && raw.id) ? raw.id : null;
    const start = isoDate(raw.start);
    // One day when it gives no end; an end before its start is a mistake, not a span.
    const end = raw.end == null ? start : isoDate(raw.end);
    if (typeof raw.type !== 'string' || !raw.type || id === null || !start || !end || end < start) return null;
    // Outside the span asked: the module's mistake, and nothing to show here.
    if (end < from || start > to) return null;
    const url = typeof raw.url === 'string' && !raw.url.startsWith('/') ? `/${m.mount}/${raw.url}` : null;
    return {
      module: m.mount, type: raw.type, id, title: String(raw.title ?? '').slice(0, TITLE_MAX), start, end,
      state: raw.state === 'done' ? 'done' : 'open', where: String(raw.where ?? '').slice(0, TITLE_MAX),
      ...(url ? { url } : {}), ...(typeof raw.mine === 'boolean' ? { mine: raw.mine } : {}),
      ...(typeof raw.time === 'string' && TIME.test(raw.time) ? { time: raw.time } : {}),
    };
  }

  /**
   * What someone has with a date from `from` to `to`, in every module they use that has a
   * calendar (`only` may leave some out): each module asked at once, in the person's zone.
   * → { from, to, modules: [{ mount, name, color, icon }], items, failed? }, the items by their
   * first day, then in the modules' order, then by title.
   */
  async function range(user, { from, to } = {}, { only = () => true } = {}) {
    const span = calendarSpan(from, to);
    const sources = sourcesOf(user).filter(only);
    const answers = await Promise.all(sources.map(async (m) => {
      try {
        const given = await inZoneOf(user, () => m.parts.calendar.range(user, { ...span }));
        if (!Array.isArray(given)) throw new Error('its range gave no list');
        return given.map((raw) => itemOf(m, raw, span)).filter(Boolean).sort(byDays).slice(0, CALENDAR_MODULE_MAX);
      } catch (error) {
        // One module that fails leaves its days empty, not everyone's calendar.
        log(`[calendar] ${m.mount}: ${error?.message || error}`);
        return null;
      }
    }));
    const order = new Map(sources.map((m, i) => [m.mount, i]));
    const items = answers.flatMap((given) => given || []).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)
      || order.get(a.module) - order.get(b.module)
      || a.title.localeCompare(b.title)
      || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    const failed = sources.filter((m, i) => answers[i] === null).map((m) => m.mount);
    return {
      ...span,
      modules: sources.map((m) => ({ mount: m.mount, name: m.config.app.name, color: m.config.app.color, icon: icon(m) })),
      items,
      ...(failed.length ? { failed } : {}),
    };
  }

  return { range };
}

/** The host's route for its calendar page, at its root: `GET /api/calendar?from=&to=`. */
export function registerCalendarApi(api, { calendar }) {
  api.get('/api/calendar', async (ctx) => {
    if (!ctx.user) throw unauthorized();
    sendJson(ctx.res, 200, await calendar.range(ctx.user, { from: ctx.query.get('from'), to: ctx.query.get('to') }));
  });
}

const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' });
/** "2026-11-03, Tuesday". */
const dayLine = (day) => `${day}, ${weekday.format(new Date(`${day}T12:00:00Z`))}`;

/** An item as one line for an assistant, with its ref (`tasks:task:9`) for the modules' tools and the links'. */
const itemLine = (item, names, from) => {
  const span = item.end === item.start ? ''
    : item.start < from ? `, since ${item.start} until ${item.end}` : `, until ${item.end}`;
  return `• ${names.get(item.module) || item.module} ${item.type} ${item.module}:${item.type}:${item.id}: "${item.title}"`
    + ` (${item.state}${item.time ? `, at ${item.time}` : ''}${span})${item.where ? ` in ${item.where}` : ''}`;
};

/**
 * The host's own MCP tool for its calendar, beside the links' (host.js hostMcp): what has a date
 * in the modules someone uses, as text by day. An item that lasts several days is said once, on
 * its first day in the span. `allowed(user, m)`: whether an assistant may read that module for
 * them (their plan).
 */
export function calendarTools({ calendar, allowed = () => true }) {
  const text = (value) => ({ content: [{ type: 'text', text: value }] });
  return [{
    name: 'calendar',
    title: 'What has a date, day by day',
    description: 'What has a date in the user\'s modules, day by day: tasks that are due, projects, phases and milestones,'
      + ' daily notes. `from` and `to` as YYYY-MM-DD, both included, at most 366 days; without `to`, a week from `from`;'
      + ' without `from`, from today. Each thing comes with its module, type and id, for that module\'s tools.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First day, YYYY-MM-DD (today if left out).' },
        to: { type: 'string', description: 'Last day, YYYY-MM-DD (six days after `from` if left out).' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (user, args = {}) => {
      const from = args.from ?? todayFor(user);
      const start = isoDate(from);
      const answer = await calendar.range(user, { from, to: args.to ?? (start ? addDays(start, 6) : null) },
        { only: (m) => allowed(user, m) });
      const names = new Map(answer.modules.map((m) => [m.mount, m.name]));
      const days = new Map();
      for (const item of answer.items) {
        const day = item.start < answer.from ? answer.from : item.start;
        if (!days.has(day)) days.set(day, []);
        days.get(day).push(item);
      }
      const parts = [...days].sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([day, items]) => [dayLine(day), ...items.map((item) => itemLine(item, names, answer.from))].join('\n'));
      if (!parts.length) parts.push(`Nothing has a date from ${answer.from} to ${answer.to}.`);
      if (answer.failed) {
        parts.push(`Not read just now, so missing here: ${answer.failed.map((mount) => names.get(mount) || mount).join(', ')}.`);
      }
      return text(parts.join('\n\n'));
    },
  }];
}
