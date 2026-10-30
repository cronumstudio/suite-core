/**
 * Emails to whoever runs the install when the server fails: an exception that
 * stops the process, a rejection nobody awaited, a run of server errors (5xx)
 * and a scheduled job of the suite that threw. Off unless the install sets
 * ALERT_EMAIL and its mail goes through a server (MAIL_PROVIDER=smtp): with
 * the log as the mailer, the log already has every error.
 *
 * At most one email of each kind every 30 minutes, whatever restarts in
 * between: when the last one went is kept in the database (`app_meta`), so a
 * process that crashes and is started again every minute sends one, and the
 * next one says how many were held back. An email goes only once that mark is
 * saved: without it, a restart loop would send one per restart.
 *
 * What a message carries: the app, its version, its address and machine, the
 * kind, the time, and the error's name, message and a trimmed stack, with
 * email addresses, long tokens and the query of any URL taken out. Of a
 * request, only its method, status and route (`GET /api/items/:id`): never its
 * query, body, headers or cookies, nor who made it. In English, like the log
 * it comes from: it is for whoever runs the server, not for the people who
 * use the app, and an error's message and stack have no translation.
 *
 *   const alerts = createAlerts({ to, mailer, database, app, baseUrl, log });
 *   alerts.watch(req, res);                  // each request: its 5xx are counted
 *   alerts.report('rejection', error);       // never rejects, never throws
 *   await alerts.crashed(error);             // before exit(1): waits CRASH_SEND_MS at most
 */
import os from 'node:os';
import { parseAddress } from './mail.js';
import { HttpError } from './http.js';

const MINUTE = 60 * 1000;

/** One email per kind in this time, at most; what happens meanwhile is counted for the next one. */
export const ALERT_EVERY_MS = 30 * MINUTE;
/** Server errors (5xx): this many within this time make an alert. */
export const ERROR_BURST = Object.freeze({ count: 5, withinMs: 5 * MINUTE });
/** How long a process that is stopping waits for its email: under the 5 s it gives itself to close. */
export const CRASH_SEND_MS = 4000;
/** How often what was held back is written down: soon enough, and not once per error in a flood. */
const SAVE_EVERY_MS = 10 * 1000;
/** How much of an error an email shows. */
const MESSAGE_MAX = 500;
const STACK_LINES = 15;
const LINE_MAX = 240;
/** What is read of any one text at all: twice MESSAGE_MAX, so what an email shows was all read. */
const SCRUB_MAX = 1000;
/** Of a path no route names (a page, a file), only its first segments: the rest may be anyone's words. */
const KEPT_SEGMENTS = 2;

/** The kinds of alert: the subject, what happened, and what the ones held back were. */
const KINDS = Object.freeze({
  crash: {
    subject: 'uncaught exception, the process restarts',
    what: () => 'An exception reached the top of the process: it stops with code 1, for Docker (or whatever '
      + 'runs it) to start it again.',
    unit: 'uncaught exceptions',
  },
  rejection: {
    subject: 'unhandled promise rejection',
    what: () => 'A promise was rejected and nothing awaited it: it was logged and the server goes on.',
    unit: 'unhandled rejections',
  },
  errors: {
    subject: 'server errors (5xx)',
    what: ({ count }) => `The server answered ${count} requests with an error (5xx) within `
      + `${ERROR_BURST.withinMs / MINUTE} minutes.`,
    unit: 'server errors (5xx)',
  },
  job: {
    subject: 'a scheduled job failed',
    what: ({ job }) => `The scheduled job "${job || 'unnamed'}" failed: it runs again at its next turn.`,
    unit: 'failed jobs',
  },
  strangers: {
    subject: 'invitations to new addresses reached the limit of the day',
    what: ({ count }) => `Invitations by email to addresses without an account reached ${count} in 24 hours, `
      + 'MAIL_STRANGERS_PER_DAY: until the day turns, the rest wait in the app without an email (stranger-invites.js). '
      + 'If this is ordinary use, raise MAIL_STRANGERS_PER_DAY; if not, someone may be inviting addresses in bulk.',
    unit: 'invitations not emailed',
  },
});
export const ALERT_KINDS = Object.freeze(Object.keys(KINDS));

/**
 * The install's ALERT_EMAIL: `to` when alerts can go out, and a warning when it is set but can't be
 * used. A warning, never an error: like notifications, alerts are an extra, and a typo in them must
 * not keep the app from starting.
 */
export function alertsFromEnv(env = process.env, mail = { provider: 'log' }) {
  const given = String(env.ALERT_EMAIL ?? '').trim();
  if (!given) return { to: null, warning: null };
  if (!parseAddress(given)) return { to: null, warning: 'ALERT_EMAIL is not an email address: no alerts are sent' };
  if (mail.provider === 'log') {
    return { to: null, warning: 'ALERT_EMAIL is set but MAIL_PROVIDER is log: no alerts are sent, the server’s log has the errors' };
  }
  return { to: given, warning: null };
}

/* ------------------------------ what is said ------------------------------ */

// Bounded as addresses are (a scheme of a few letters, 64 before the @), so that no text keeps them
// trying for long: they run inside the handling of errors.
const URL_QUERY = /(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi;
const EMAILS = /[^\s@<>()"',;:/\\]{1,64}@[^\s@<>()"',;:/\\]{1,255}\.[a-z]{2,24}/gi;
// Letters and digits together, 24 or more: a token, a key or a hash, never a word of an error.
const TOKENS = /(?<![\w-])(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{24,}(?![\w-])/g;

/**
 * An error's text without what may be someone's: the query of a URL, an email, a token. Cut first,
 * and without the word the cut falls in (half an email is still someone's): a message of a megabyte
 * would keep these expressions busy, and an email shows far less.
 */
export function scrub(text) {
  let value = String(text ?? '');
  if (value.length > SCRUB_MAX) {
    let end = SCRUB_MAX;
    if (/\S/.test(value[end])) while (end > 0 && /\S/.test(value[end - 1])) end -= 1;
    value = `${value.slice(0, end)}…`;
  }
  return value
    .replace(URL_QUERY, '$1?…')
    .replace(EMAILS, '<email>')
    .replace(TOKENS, '<token>');
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();

/** Name, message and the stack's frames of whatever was thrown or rejected; null for nothing. */
export function describeError(error) {
  if (error === undefined || error === null) return null;
  try {
    if (error instanceof HttpError) {
      return { name: `HttpError ${error.status}`, message: clip(oneLine(scrub(error.code)), MESSAGE_MAX), stack: null };
    }
    const isError = error instanceof Error || (typeof error === 'object' && typeof error.message === 'string');
    const name = isError ? String(error.name || error.constructor?.name || 'Error') : typeof error;
    const message = isError ? error.message : String(error);
    const frames = isError && typeof error.stack === 'string'
      ? error.stack.split('\n').filter((line) => /^\s+at\s/.test(line)) : [];
    return {
      name: clip(oneLine(scrub(name)), 80),
      message: clip(oneLine(scrub(message)), MESSAGE_MAX),
      stack: frames.length
        ? [...frames.slice(0, STACK_LINES).map((line) => clip(scrub(line.trim()), LINE_MAX)),
          ...(frames.length > STACK_LINES ? [`… ${frames.length - STACK_LINES} more`] : [])]
        : null,
    };
  } catch {
    // Something whose name or message can't even be read (a getter that throws).
    return { name: 'unknown', message: 'it could not be read', stack: null };
  }
}

/** A segment that is a word of a route (`api`, `items`, `sw.js`); anything else may be someone's. */
const WORD = /^\.?[a-z][a-z_-]{0,39}(\.[a-z]{1,12})?$/;
const segmentOf = (segment) => (WORD.test(segment) ? segment : ':param');

/** The path of a request target, without its query; '/' when it can't be read. */
function pathOf(target) {
  try {
    return new URL(String(target || '/'), 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

/**
 * The route of a request as an email shows it: the router's pattern when a route took it, after
 * whatever came before it (a host's module, `/tasks`); otherwise its first segments, and those only
 * when they are words.
 */
function routeShown(path, pattern) {
  const parts = path.split('/').filter(Boolean);
  if (pattern) {
    const tail = pattern.split('/').filter(Boolean);
    const before = parts.slice(0, Math.max(0, parts.length - tail.length)).map(segmentOf);
    return `/${[...before, ...tail].join('/')}`;
  }
  const kept = parts.slice(0, KEPT_SEGMENTS).map(segmentOf);
  return `/${kept.join('/')}${parts.length > KEPT_SEGMENTS ? '/…' : ''}`;
}

/* --------------------------------- alerts --------------------------------- */

/** What an install without ALERT_EMAIL gets: the same calls, and nothing done. */
const OFF = Object.freeze({
  enabled: false,
  setVersion() {},
  watch() {},
  noteRoute() {},
  noteError() {},
  report: async () => false,
  crashed: async () => false,
  jobFailed() {},
  flush() {},
});

/**
 * @param {object} options
 * @param {string|null} options.to     ALERT_EMAIL, from alertsFromEnv(); null: alerts are off
 * @param {object} options.mailer      createMailer(): with the log as the provider, alerts are off
 * @param {object} options.database    openDatabase(): where the time of the last email of each kind is kept
 * @param {object} [options.app]       { id, name } of the app (or the host)
 * @param {string} [options.baseUrl]   the install's address
 */
export function createAlerts({
  to = null, mailer = null, database = null, app = {}, baseUrl = '', log = console.log,
  now = Date.now, machine = os.hostname(), crashSendMs = CRASH_SEND_MS,
} = {}) {
  if (!to || !mailer || mailer.provider === 'log' || !database) return OFF;
  const appName = String(app.name || app.id || 'app');
  let version = null;

  /* ---------------------- once per kind, across restarts ---------------------- */

  const keyOf = (kind) => `suite.alerts.${kind}`;
  /** kind → { lastAt, held, dirty }: when the last email went, and what happened since without one. */
  const states = new Map();

  function stateOf(kind) {
    let state = states.get(kind);
    if (state) return state;
    // A database that can't be read throws here: the caller sends nothing.
    const raw = database.getMeta(keyOf(kind));
    let saved = null;
    try { saved = JSON.parse(raw || 'null'); } catch { saved = null; }
    state = {
      lastAt: Date.parse(saved?.last_at) || 0,
      held: Number.isInteger(saved?.held) && saved.held > 0 ? saved.held : 0,
      dirty: false,
    };
    states.set(kind, state);
    return state;
  }

  function save(kind, state) {
    database.setMeta(keyOf(kind), JSON.stringify({
      last_at: state.lastAt ? new Date(state.lastAt).toISOString() : null, held: state.held,
    }));
    state.dirty = false;
  }

  let saveTimer = null;
  /** What was held back, written down: on a timer, on close, and before a crash's email. */
  function flush() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    for (const [kind, state] of states) {
      if (!state.dirty) continue;
      try {
        save(kind, state);
      } catch (err) {
        log(`[alerts] what was held back of "${kind}" could not be saved: ${err?.message || err}`);
      }
    }
  }
  function saveLater() {
    if (saveTimer) return;
    saveTimer = setTimeout(flush, SAVE_EVERY_MS);
    saveTimer.unref?.();
  }

  /**
   * Whether an email of this kind goes now: { held, at } when it does, after the mark is saved;
   * null when one went less than ALERT_EVERY_MS ago (this one is counted for the next), or when the
   * mark can't be saved.
   */
  function claim(kind, count) {
    let state;
    try {
      state = stateOf(kind);
    } catch (err) {
      log(`[alerts] no "${kind}" alert: the database can't say when the last one went (${err?.message || err})`);
      return null;
    }
    const at = now();
    const since = at - state.lastAt;
    // A clock set back (since < 0) doesn't hold alerts back until it catches up.
    if (state.lastAt && since >= 0 && since < ALERT_EVERY_MS) {
      state.held += count;
      state.dirty = true;
      saveLater();
      return null;
    }
    const { held, lastAt } = state;
    state.lastAt = at;
    state.held = 0;
    try {
      save(kind, state);
    } catch (err) {
      state.lastAt = lastAt;
      state.held = held + count;
      state.dirty = true;
      log(`[alerts] no "${kind}" alert: its time could not be saved, and a restart would send it again (${err?.message || err})`);
      return null;
    }
    return { held, at };
  }

  /* -------------------------------- the email -------------------------------- */

  function compose(kind, error, { at, held, count, job, recent }) {
    const spec = KINDS[kind];
    const err = describeError(error);
    const lines = [
      spec.what({ count, job }),
      '',
      `App:      ${appName} ${version ? `v${version}` : '(version unknown)'}`,
      `Address:  ${baseUrl || '(no BASE_URL)'}`,
      `Machine:  ${machine}`,
      `Kind:     ${kind}`,
      `Time:     ${new Date(at).toISOString()}`,
    ];
    if (err) lines.push(`Error:    ${err.name}: ${err.message}`);
    if (held) {
      lines.push('', `Since the last email of this kind, ${held} more ${spec.unit} were not emailed `
        + `(one email per kind every ${ALERT_EVERY_MS / MINUTE} minutes at most).`);
    }
    if (recent?.length) {
      lines.push('', 'The requests that failed (method, route, never their query or contents):');
      for (const entry of recent) {
        const what = describeError(entry.error);
        lines.push(`  ${new Date(entry.at).toISOString()}  ${entry.status}  ${entry.method} ${entry.route}`
          + `${what ? `  ${what.name}: ${what.message}` : ''}`);
      }
    }
    if (err?.stack) lines.push('', 'Stack (trimmed):', ...err.stack.map((line) => `  ${line}`));
    lines.push('', '--', 'Sent because ALERT_EMAIL is set on this install. The server’s log has the rest.');
    return { subject: `[${appName}] Alert: ${spec.subject}`, text: lines.join('\n') };
  }

  /**
   * Emails an alert of `kind` unless one went less than ALERT_EVERY_MS ago. Resolves to whether it
   * went; never rejects and never throws, so it is safe in any handler of errors.
   * @param {object} [details]  count (what this alert stands for), job (its name), recent (requests)
   */
  async function report(kind, error, { count = 1, job = null, recent = null } = {}) {
    let claimed = null;
    try {
      if (!Object.hasOwn(KINDS, kind)) throw new TypeError(`"${kind}" is not a kind of alert (${ALERT_KINDS.join(', ')})`);
      claimed = claim(kind, count);
      if (!claimed) return false;
      const { subject, text } = compose(kind, error, { ...claimed, count, job, recent });
      await mailer.send({ to, subject, text });
      log(`[alerts] "${kind}" alert sent`);
      return true;
    } catch (err) {
      // Not delivered: the next email counts it, with what it carried.
      if (claimed) {
        const state = states.get(kind);
        state.held += claimed.held + count;
        state.dirty = true;
        saveLater();
      }
      log(`[alerts] the "${kind}" alert could not be sent: ${err?.message || err}`);
      return false;
    }
  }

  /** The process is about to stop: what was held back is saved, and its email waits crashSendMs at most. */
  async function crashed(error) {
    flush();
    let timer = null;
    // Not unref'd: the process stays up until the email goes or the time is over.
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve('late'), crashSendMs); });
    const result = await Promise.race([report('crash', error), late]);
    clearTimeout(timer);
    if (result === 'late') log(`[alerts] the "crash" alert did not go out within ${crashSendMs} ms`);
    return result === true;
  }

  /* ------------------------------ server errors ------------------------------ */

  // What a request's handling noted: the route that took it, and the error behind a 5xx.
  const routes = new WeakMap();
  const errors = new WeakMap();
  /** The 5xx answered within ERROR_BURST.withinMs, oldest first. */
  let recent = [];

  function serverError(entry) {
    recent = recent.filter((e) => entry.at - e.at < ERROR_BURST.withinMs);
    recent.push(entry);
    if (recent.length < ERROR_BURST.count) return;
    const burst = recent;
    recent = [];
    // The stack worth showing is the latest real error's; a 503 an HttpError answered has none.
    const latest = [...burst].reverse().find((e) => e.error && !(e.error instanceof HttpError))?.error
      ?? burst.at(-1).error ?? null;
    report('errors', latest, { count: burst.length, recent: burst });
  }

  /** Counts the request's answer when it is a 5xx. Called first, before anything rewrites req.url. */
  function watch(req, res) {
    const { method } = req;
    const path = pathOf(req.url);
    res.once('finish', () => {
      if (res.statusCode < 500) return;
      // An exception here would be an uncaught one: the counting of errors must never be the next.
      try {
        serverError({
          at: now(), status: res.statusCode, method, route: routeShown(path, routes.get(req)), error: errors.get(req) ?? null,
        });
      } catch (err) {
        log(`[alerts] a server error could not be counted: ${err?.message || err}`);
      }
    });
  }

  return {
    enabled: true,
    /** The app's version, for the emails: the one that listens says it. */
    setVersion(value) { version = value ? String(value) : null; },
    watch,
    /** The router's pattern of the route that took a request (`/api/items/:id`). */
    noteRoute(req, pattern) { if (req && pattern) routes.set(req, String(pattern)); },
    /** What a request's 5xx came from. */
    noteError(req, error) { if (req && error != null) errors.set(req, error); },
    report,
    crashed,
    /** A scheduled job that threw: its alert, without waiting for it. */
    jobFailed(job, error) { report('job', error, { job: String(job) }); },
    flush,
  };
}
