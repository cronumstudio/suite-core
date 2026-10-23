/**
 * Whose "today" it is.
 *
 * My Day, what is overdue, "in 3 days" and "logged yesterday" all hang on the
 * date of today, and today depends on where the person is: at six in the
 * evening in New York it is already tomorrow in Madrid, where the server
 * lives. Read in the server's zone, lists emptied in the middle of someone's
 * afternoon and due dates turned over hours early or late. Tasks had this
 * right; Projects, Next and Notes each read today their own way (audit
 * 2026-10-23, A5).
 *
 * So today is the zone of whoever is asking: `prefs.tz`, the zone their
 * browser reported (a key every module shares in the same `users` row).
 * A module runs each request and each MCP tool inside `inZoneOf(user, …)`, and
 * `todayFor()` reads it from there, through awaits too. What runs on its own
 * (a timer's clean-up) has nobody's zone and uses the server's: `TZ`, as
 * CONVENTIONS §5 says, which in production is Europe/Madrid.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A time zone as the IANA names it ("Europe/Madrid"), canonical
 * ("europe/madrid" → "Europe/Madrid"), or null for what isn't one.
 */
export function knownTimeZone(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The server's own zone: the container's TZ, or what Node resolves. */
export const SERVER_TIME_ZONE = knownTimeZone(process.env.TZ)
  || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const prefsOf = (user) => {
  try {
    return typeof user?.prefs === 'string' ? JSON.parse(user.prefs || '{}') ?? {} : (user?.prefs ?? {});
  } catch {
    return {};
  }
};

/** The zone a person's days are read in: theirs (`prefs.tz`, as text or already read), or the server's. */
export const zoneOf = (user) => knownTimeZone(prefsOf(user).tz) || SERVER_TIME_ZONE;

const context = new AsyncLocalStorage();

/** Runs `fn` with `user`'s zone as the one today is read in (a request, a tool call). */
export const inZoneOf = (user, fn) => context.run({ zone: zoneOf(user) }, fn);

/** The zone of whoever the current request is for, or the server's. */
export const currentZone = () => context.getStore()?.zone ?? SERVER_TIME_ZONE;

const formats = new Map();
const dayFormat = (zone) => {
  if (!formats.has(zone)) {
    // en-CA writes YYYY-MM-DD.
    formats.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  }
  return formats.get(zone);
};

/** The calendar day (YYYY-MM-DD) an instant falls on in `zone`. */
export const dayIn = (zone, instant = new Date()) => dayFormat(knownTimeZone(zone) || SERVER_TIME_ZONE)
  .format(instant instanceof Date ? instant : new Date(instant));

/** Whole calendar days from `day` (YYYY-MM-DD), not 24-hour steps: noon UTC never crosses a date line. */
export function addDays(day, days) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + days, 12)).toISOString().slice(0, 10);
}

/** Today in `zone` (YYYY-MM-DD), `offsetDays` from it. */
export const todayIn = (zone, offsetDays = 0) => addDays(dayIn(zone), offsetDays);

/**
 * Today for a person: `user`'s zone when given, else the zone of the current
 * request (inZoneOf), else the server's. `offsetDays` from it.
 */
export const todayFor = (user = null, offsetDays = 0) =>
  todayIn(user ? zoneOf(user) : currentZone(), offsetDays);

/** Calendar days from the day `instant` fell on to today, both in `zone` (0 today, 1 yesterday; negative ahead). */
export function daysSince(instant, zone = currentZone()) {
  const from = Date.parse(`${dayIn(zone, instant)}T12:00:00Z`);
  const to = Date.parse(`${dayIn(zone)}T12:00:00Z`);
  return Math.round((to - from) / 86400000);
}
