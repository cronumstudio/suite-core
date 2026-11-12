/**
 * The host's calendar as a subscription link (host.js `calendarFeed`, Cronum Work): what has a
 * date in each module (calendar.js), as an iCalendar file (RFC 5545) that Google Calendar,
 * Outlook or Apple Calendar read every few hours at a secret address of the person's own.
 *
 * · One link a person, made when they ask for it (Settings), at
 *   `/api/calendar/feed/<token>.ics`: the token is the only thing in it, 192 random bits. The
 *   table keeps its hash, to find it, and the token encrypted with a key derived from the session
 *   secret, for Settings to show it again: the database file alone gives no one's calendar.
 * · Made again, the old address stops answering at once; turned off, the row goes.
 * · Read-only, and what the calendar page shows: the modules the person uses, with the same
 *   permissions, from FEED_PAST_DAYS ago up to a year (CALENDAR_MAX_DAYS) in all.
 * · Where the host's plans name `calendar.feed` (FEED_FEATURE), only for a plan with it: without
 *   it, Settings offers the plan, making a link answers 402 and the link answers 402 too, kept for
 *   when the plan comes back. A host that doesn't declare it offers it to everyone.
 * · Each item is an event of its own with a stable UID (module, type, id), marked free time
 *   (TRANSP), all day or, with a time of its own on one day, half an hour at that time, written in
 *   UTC from the person's zone. Done ones say so with a ✓ before the title. Each links back to
 *   its module (URL, and the DESCRIPTION for the clients that show no URL).
 *
 * A task that repeats comes as the module's calendar gives it (its next date, as the calendar page
 * shows it). Once a module's items carry their rule, it can go out as RRULE here.
 */
import crypto from 'node:crypto';
import { sha256, randomToken, encryptText, decryptText } from './crypto.js';
import { HttpError, notFound, unauthorized, sendJson } from './http.js';
import { addDays, todayFor, zoneOf } from './time.js';
import { CALENDAR_MAX_DAYS } from './calendar.js';

/** The plan feature that gives the link, where a host's plans name it (plans.js). */
export const FEED_FEATURE = 'calendar.feed';
/** Days before today the link still shows: what was done lately, and what is late. */
export const FEED_PAST_DAYS = 60;
/** How long a timed item lasts in a calendar, in minutes: the modules give a time, not an end. */
export const FEED_EVENT_MINUTES = 30;
/** How often the person's calendar may come back, as the clients that read it are told; and what a proxy may keep. */
const REFRESH = 'PT1H';
const MAX_AGE_SECONDS = 900;
/** used_at is written at most this often: a calendar asks every few minutes or hours, and each read needn't write. */
const USED_EVERY_MS = 10 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;

/** The table: one link a person, its token's hash to find it and the token encrypted to show it again. */
export function calendarFeedsSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS host_calendar_feeds (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    token      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used_at    TEXT
  )`);
}

/**
 * @param {object} options
 * @param {object} options.database
 * @param {(purpose: string) => string} options.sign   the session secret's signature (sessions.sign): the key's source
 * @param {() => Date} [options.clock]
 */
export function createCalendarFeeds({ database, sign, clock = () => new Date() }) {
  const key = crypto.createHash('sha256').update(sign('calendar-feed-tokens')).digest();
  const now = () => clock().toISOString();

  /** Someone's link: `{ token, created_at, used_at }` (token null when the session secret changed), or null. */
  function of(userId) {
    const row = database.get('SELECT token, created_at, used_at FROM host_calendar_feeds WHERE user_id = ?', userId);
    if (!row) return null;
    return { token: decryptText(key, row.token), created_at: row.created_at, used_at: row.used_at ?? null };
  }

  /** A new link for someone, the old one gone with it: its token, once more as of() gives it. */
  function renew(userId) {
    const token = randomToken(24);
    database.run(`INSERT INTO host_calendar_feeds (user_id, token_hash, token, created_at, used_at) VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash, token = excluded.token,
        created_at = excluded.created_at, used_at = NULL`, userId, sha256(token), encryptText(key, token), now());
    return of(userId);
  }

  /** Someone's link turned off: whether there was one. */
  function remove(userId) {
    return database.run('DELETE FROM host_calendar_feeds WHERE user_id = ?', userId).changes > 0;
  }

  /** Whose link a token is (their id), noting when it was read; null for a token nobody has. */
  function userOf(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    const row = database.get('SELECT user_id, used_at FROM host_calendar_feeds WHERE token_hash = ?', sha256(token));
    if (!row) return null;
    const at = clock();
    if (!row.used_at || at.getTime() - Date.parse(row.used_at) >= USED_EVERY_MS) {
      database.run('UPDATE host_calendar_feeds SET used_at = ? WHERE user_id = ?', at.toISOString(), row.user_id);
    }
    return row.user_id;
  }

  return { of, renew, remove, userOf };
}

/* ------------------------------ the file ------------------------------ */

/** TEXT as RFC 5545 writes it (§3.3.11): backslash, semicolon, comma and line breaks escaped; other controls out. */
const text = (value) => String(value ?? '')
  .replace(/\r\n|\r|\n/g, '\n')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ')
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

/** A content line folded at 75 octets (§3.1), never inside a character: each next part starts with a space. */
function fold(line) {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts = [];
  let part = '';
  let size = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > 75) {
      parts.push(part);
      part = ' ';
      size = 1;
    }
    part += char;
    size += bytes;
  }
  parts.push(part);
  return parts.join('\r\n');
}

const compact = (day) => day.replaceAll('-', '');
/** An instant as a UTC DATE-TIME: 20261103T083000Z. */
const utc = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** The instant a wall time is in a zone ('2026-11-03', '09:30', 'Europe/Madrid'), across daylight saving. */
export function instantIn(day, time, zone) {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const offset = (instant) => {
    const p = Object.fromEntries(format.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - instant;
  };
  // Twice: the offset at the guess may be the other side of a change.
  const first = wall - offset(wall);
  return new Date(wall - offset(first));
}

/** What the UID's right side is: the host's address without its port, else the app's id. */
const domainOf = (baseUrl, fallback) => {
  try { return new URL(baseUrl).hostname || fallback; } catch { return fallback; }
};

/**
 * The calendar's answer (calendar.js range()) as an iCalendar file, lines ending in CRLF.
 *
 * @param {object} answer       { modules: [{ mount, name }], items }
 * @param {object} options
 * @param {string} options.name     the calendar's name in the person's calendar app (the host's)
 * @param {string} options.id       the host's id (PRODID, UIDs without an address)
 * @param {string} options.baseUrl  the host's address: each item's link
 * @param {string} options.zone     the person's zone, for the items with a time
 * @param {Date}   [options.now]    DTSTAMP
 */
export function calendarIcs(answer, { name, id, baseUrl, zone, now = new Date() }) {
  const domain = domainOf(baseUrl, id);
  const names = new Map((answer.modules || []).map((m) => [m.mount, m.name]));
  const stamp = utc(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//Cronum Studio//${text(name)}//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${text(name)}`,
    `X-WR-TIMEZONE:${zone}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${REFRESH}`,
    `X-PUBLISHED-TTL:${REFRESH}`,
  ];
  for (const item of answer.items || []) {
    const link = item.url ? `${baseUrl}${item.url}` : null;
    const module = names.get(item.module) || item.module;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${[item.module, item.type, item.id].map((part) => encodeURIComponent(String(part))).join('-')}@${domain}`,
      `DTSTAMP:${stamp}`,
    );
    if (item.time && item.start === item.end) {
      const start = instantIn(item.start, item.time, zone);
      lines.push(`DTSTART:${utc(start)}`, `DTEND:${utc(new Date(start.getTime() + FEED_EVENT_MINUTES * 60000))}`);
    } else {
      // All day: its last day included, so DTEND the day after (§3.6.1).
      lines.push(`DTSTART;VALUE=DATE:${compact(item.start)}`, `DTEND;VALUE=DATE:${compact(addDays(item.end, 1))}`);
    }
    lines.push(
      `SUMMARY:${text(`${item.state === 'done' ? '✓ ' : ''}${item.title}`)}`,
      `DESCRIPTION:${text([item.where ? `${module} · ${item.where}` : module, link].filter(Boolean).join('\n'))}`,
      `CATEGORIES:${text(module)}`,
      ...(link ? [`URL;VALUE=URI:${link}`] : []),
      // Something to do, not a meeting: it doesn't make the person look busy.
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/* ------------------------------ the routes ------------------------------ */

/**
 * The person's link, in Settings: GET, POST (made, or made again) and DELETE /api/me/calendar-feed
 * → `{ included, feed: { url, webcal, created_at, used_at } | null }`; and the link itself,
 * signed out, GET /api/calendar/feed/<token>.ics.
 *
 * @param {object} api
 * @param {object} deps   { feeds, calendar, accounts, entitlements?, limiter?, audit?, baseUrl, name, id, clock? }
 */
export function registerCalendarFeedApi(api, { feeds, calendar, accounts, entitlements = null, limiter = null, audit = null, baseUrl, name, id, clock = () => new Date() }) {
  const gated = Boolean(entitlements?.knows?.(FEED_FEATURE));
  const included = (user) => !gated || entitlements.can(user, FEED_FEATURE);
  const urlOf = (token) => `${baseUrl}/api/calendar/feed/${token}.ics`;
  const answerFor = (user) => {
    const feed = feeds.of(user.id);
    const url = feed?.token ? urlOf(feed.token) : null;
    return {
      included: included(user),
      feed: feed ? {
        url, webcal: url ? url.replace(/^https?:/, 'webcal:') : null, created_at: feed.created_at, used_at: feed.used_at,
      } : null,
    };
  };

  api.get('/api/me/calendar-feed', (ctx) => {
    if (!ctx.user) throw unauthorized();
    sendJson(ctx.res, 200, answerFor(ctx.user));
  });
  api.post('/api/me/calendar-feed', async (ctx) => {
    if (!ctx.user) throw unauthorized();
    if (gated) entitlements.require(ctx.user, FEED_FEATURE);
    const again = Boolean(feeds.of(ctx.user.id));
    feeds.renew(ctx.user.id);
    audit?.record({ action: again ? 'calendar_feed.renewed' : 'calendar_feed.created', actor: ctx.user, req: ctx.req });
    sendJson(ctx.res, 200, answerFor(ctx.user));
  });
  api.delete('/api/me/calendar-feed', (ctx) => {
    if (!ctx.user) throw unauthorized();
    if (feeds.remove(ctx.user.id)) audit?.record({ action: 'calendar_feed.removed', actor: ctx.user, req: ctx.req });
    sendJson(ctx.res, 200, answerFor(ctx.user));
  });

  api.get('/api/calendar/feed/:file', async (ctx) => {
    const token = /^(.+)\.ics$/.exec(ctx.params.file)?.[1] ?? '';
    // A client repeating a bad address is braked, as a bad token is (rate-limit.js).
    const allowed = limiter ? limiter.checkToken(ctx.req, token) : { allowed: true };
    if (!allowed.allowed) throw new HttpError(429, 'too_many_attempts', { retry_after: allowed.retryAfter });
    const userId = feeds.userOf(token);
    const user = userId == null ? null : accounts.byId(userId);
    if (!user || user.disabled_at) {
      limiter?.tokenFailed(ctx.req, token);
      throw notFound();
    }
    if (!included(user)) {
      const entitled = entitlements.of(user);
      throw new HttpError(402, 'plan_feature', { feature: FEED_FEATURE, plan: entitled.plan.id, plan_name: entitled.plan.name });
    }
    const zone = zoneOf(user);
    const today = todayFor(user);
    const from = addDays(today, -FEED_PAST_DAYS);
    const answer = await calendar.range(user, { from, to: addDays(from, CALENDAR_MAX_DAYS - 1) });
    // The same items, the same file but for its DTSTAMP: a client that kept it hears 304.
    const tag = `"${sha256(JSON.stringify([answer.items, answer.modules.map((m) => m.name), zone, name]))}"`;
    const headers = {
      'Cache-Control': `private, max-age=${MAX_AGE_SECONDS}`,
      ETag: tag,
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
    };
    if (ctx.req.headers['if-none-match'] === tag) {
      ctx.res.writeHead(304, headers);
      ctx.res.end();
      return;
    }
    const body = calendarIcs(answer, { name, id, baseUrl, zone, now: clock() });
    ctx.res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Content-Disposition': `inline; filename="${id}.ics"`,
      ...headers,
    });
    ctx.res.end(body);
  });
}
