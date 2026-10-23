/**
 * Dates as people say them to an AI: "tomorrow", "next friday", "24.12.",
 * "in 2 months". Tasks and Projects each had a parser (audit 2026-10-23, A4);
 * this is the union of both, in Spanish, English, French and German at once,
 * and it never rolls a day that doesn't exist (31/02, 2026-13-01) into the
 * next month: that is an error the AI reads and corrects.
 *
 * All the arithmetic is on calendar days in UTC, from `today` as the person's
 * zone sees it (time.js): no daylight-saving hour moves a date.
 */
import { isoDate } from './http.js';
import { ResolveError, nameKey } from './resolve.js';

// As nameKey() writes them (lowercase, no accents, punctuation turned into
// spaces: "aujourd'hui" → "aujourd hui").
const TODAY = new Set(['hoy', 'today', 'aujourd hui', 'aujourdhui', 'heute']);
const TOMORROW = new Set(['manana', 'tomorrow', 'demain', 'morgen']);
const DAY_AFTER_TOMORROW = new Set([
  'pasado manana', 'day after tomorrow', 'the day after tomorrow', 'apres demain', 'ubermorgen', 'uebermorgen',
]);
const YESTERDAY = new Set(['ayer', 'yesterday', 'hier', 'gestern']);

/** Weekday names and their usual short forms → day of the week (0 = Sunday). */
const WEEKDAYS = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
  dom: 0, lun: 1, mar: 2, mie: 3, jue: 4, vie: 5, sab: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
  dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6,
  dim: 0, mer: 3, jeu: 4, ven: 5, sam: 6,
  sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonnabend: 6,
};
/**
 * Words that may come around a weekday without changing it: "el próximo
 * viernes", "next friday", "on monday", "vendredi prochain", "am nächsten
 * Freitag". A weekday is always the next one to come (a week from now if today
 * is that day), so "this" and "next" mean the same.
 */
const WEEKDAY_FILLER = new Set([
  'el', 'este', 'proximo', 'next', 'this', 'on', 'the', 'coming', 'ce', 'le', 'prochain',
  'am', 'diesen', 'nachsten', 'naechsten', 'kommenden',
]);

/** "a"/"an"/"one"/"un"/"une"/"ein"… as the number 1 in "in a week". */
const ONE = new Set(['a', 'an', 'one', 'un', 'una', 'une', 'ein', 'eine', 'einem', 'einer']);
const AMOUNT = '(\\d+|a|an|one|un|una|une|ein|eine|einem|einer)';
const IN = `^(?:en|in|dans) ${AMOUNT} `;
const IN_DAYS = new RegExp(`${IN}(?:dias?|days?|jours?|tag|tage|tagen)$`);
const IN_WEEKS = new RegExp(`${IN}(?:semanas?|weeks?|semaines?|woche|wochen)$`);
const IN_MONTHS = new RegExp(`${IN}(?:mes|meses|months?|mois|monat|monate|monaten)$`);
const amountOf = (word) => (ONE.has(word) ? 1 : Number(word));

// Day first, as in Spain, France and Germany: 24/12, 24/12/2026, 24-12-26 ("/" and "-" may be mixed).
const SLASH_DATE = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/;
// German: 24.12, 24.12., 24.12.26, 24.12.2026 and 24.12.2026. (the last dot is optional).
const DOT_DATE = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?\.?$/;
// YYYY-MM-DD alone, or at the start of a timestamp ("2026-10-23T09:00:00Z").
const ISO_START = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/;

const pad = (n, width = 2) => String(n).padStart(width, '0');
const ymd = (date) => `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

/** The day, or null when it doesn't exist (31 Feb, month 13…): nothing rolls over. */
function calendarDay(year, month, day) {
  const date = new Date(Date.UTC(2000, 0, 1));
  date.setUTCFullYear(year, month - 1, day);   // unlike Date.UTC(year, …), a year below 100 stays as written
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

/** The server's own calendar day, for when nobody says whose today it is. */
function localToday() {
  const now = new Date();
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Turns a date as people say it into YYYY-MM-DD:
 * - YYYY-MM-DD (or a timestamp that starts with one), a real day within 1900–2200 (isoDate);
 * - today / tomorrow / the day after tomorrow / yesterday;
 * - "in 3 days", "in a week", "in 2 months" (the 31st becomes the month's last day);
 * - a weekday, long or short, with or without "next" ("friday", "el próximo vie"):
 *   always the next one to come, a week from now if today is that day;
 * - day first: 24/12, 24/12/2026, 24-12-26, 24.12., 24.12.2026. Without a
 *   year, the next time that day comes round (today counts).
 *
 * @param {*} value   empty → null
 * @param {object} [options]
 * @param {string} [options.today]   YYYY-MM-DD in the person's zone (time.js's todayFor); the server's day by default
 * @param {string} [options.field]   what the date is, for the error ("the due date")
 * @returns {string|null}
 * @throws {ResolveError} when it isn't understood or the day doesn't exist
 */
export function parseNaturalDate(value, { today = localToday(), field = 'the date' } = {}) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const notReal = () => new ResolveError(`"${raw}" is not a real date (${field}; years 1900-2200). `
    + 'Use YYYY-MM-DD or a day-first date (24/12/2026).');

  const iso = raw.match(ISO_START);
  if (iso) {
    if (isoDate(iso[1])) return iso[1];
    throw notReal();
  }

  const base = new Date(`${isoDate(today) ?? localToday()}T00:00:00Z`);
  const shift = (days) => { const x = new Date(base); x.setUTCDate(x.getUTCDate() + days); return ymd(x); };
  const checked = (text) => { if (isoDate(text)) return text; throw notReal(); };
  const text = nameKey(raw);

  if (TODAY.has(text)) return ymd(base);
  if (TOMORROW.has(text)) return shift(1);
  if (DAY_AFTER_TOMORROW.has(text)) return shift(2);
  if (YESTERDAY.has(text)) return shift(-1);

  const inDays = text.match(IN_DAYS);
  if (inDays) return checked(shift(amountOf(inDays[1])));
  const inWeeks = text.match(IN_WEEKS);
  if (inWeeks) return checked(shift(amountOf(inWeeks[1]) * 7));
  const inMonths = text.match(IN_MONTHS);
  if (inMonths) {
    const months = base.getUTCMonth() + amountOf(inMonths[1]);
    const year = base.getUTCFullYear() + Math.floor(months / 12);
    const month = months % 12;
    const last = new Date(Date.UTC(2000, 0, 1));
    last.setUTCFullYear(year, month + 1, 0);
    const day = Math.min(base.getUTCDate(), last.getUTCDate());
    return checked(`${pad(year, 4)}-${pad(month + 1)}-${pad(day)}`);
  }

  const rest = text.split(' ').filter((word) => !WEEKDAY_FILLER.has(word));
  if (rest.length === 1 && Object.hasOwn(WEEKDAYS, rest[0])) {
    return shift((WEEKDAYS[rest[0]] - base.getUTCDay() + 7) % 7 || 7);
  }

  const dm = raw.match(SLASH_DATE) || raw.match(DOT_DATE);
  if (dm) {
    const day = Number(dm[1]);
    const month = Number(dm[2]);
    let date = null;
    if (dm[3]) {
      date = calendarDay(dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3]), month, day);
    } else {
      // A few years ahead are tried for 29 Feb.
      for (let year = base.getUTCFullYear(); year <= base.getUTCFullYear() + 8 && !date; year++) {
        const candidate = calendarDay(year, month, day);
        if (candidate && candidate >= base) date = candidate;
      }
    }
    if (date) return checked(ymd(date));
    throw notReal();
  }

  throw new ResolveError(`Can't understand ${field} "${raw}". Use YYYY-MM-DD, a day-first date `
    + '(24/12, 24.12.2026), "today", "tomorrow", "in 3 days", "in 2 weeks", "in 1 month" '
    + 'or a weekday ("friday", "next friday").');
}
