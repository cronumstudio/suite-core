/**
 * Notices to whoever runs the install about how it is going: a new account, a
 * purchase, a renewal, a subscription that ended or was paid back. With
 * `modules.notices`, set in /admin › Notifications, and silent until a
 * destination is given there: an ntfy topic (the ntfy app on a phone, with no
 * account of the install on it) or an email address.
 *
 * Each group of events has its own way: one notice per event, a line in the
 * daily summary, or nothing; the whole of it can be paused. A run of one group
 * (five within ten minutes: a launch, a post that spread) is gathered into one
 * notice once the run is over, so a phone isn't buzzing all afternoon.
 *
 * What a notice says is the admin's own text, a template per group with
 * `{country}`, `{users}`… in it, and parts between brackets that are left out
 * when what they name is unknown: `New account[ from {country}].` reads «New
 * account from Brazil.» or «New account.». Never anybody's email or name: a
 * notice goes through other people's servers (ntfy's, Apple's, Google's, a
 * mailbox), so it says what happened and from where, not who.
 *
 * Where from:
 *   - an account: the country Cloudflare says the request came from, with
 *     TRUST_PROXY=cloudflare and only from Cloudflare's own addresses
 *     (http.js cloudflareCountry: what clientIp believes, and nothing anyone
 *     reaching the server directly could write), read while the account is
 *     made (request-scope.js) and never kept with the account. Without that
 *     proxy no country at all: an address looked up in a table of our own
 *     would be wrong often enough to be no fact. Only accounts people make
 *     themselves: not the admin's, not an import, not the first administrator;
 *   - a payment: the country the payment provider says (`event.country`,
 *     ISO 3166 alpha-2), and its amount (`event.amount` in the currency's
 *     units, `event.currency`), when its adapter gives them. A provider that
 *     doesn't leaves them out: a guess would be worse than nothing.
 *
 * Every event is kept a while (`admin_notice_events`, KEEP_DAYS) with what a
 * notice says of it and nothing else, for the summary.
 *
 *   const notices = createAdminNotices({ database, texts, mailer, sign, appName, baseUrl, countryOf, planName });
 *   accounts.whenCreated(notices.signedUp);
 *   billing.whenApplied(notices.billed);
 *   setInterval(() => notices.tick(), 60_000);   // runtime.js: runs, summaries
 *   registerAdminNoticesApi(api, { notices, audit });
 */
import crypto from 'node:crypto';
import { currentRequest, byTheAdmin } from './request-scope.js';
import { encryptText, decryptText } from './crypto.js';
import { parseAddress } from './mail.js';
import { badRequest, readJson, sendJson, requireAdmin } from './http.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The groups of events, in the order the panel shows them. */
export const NOTICE_GROUPS = Object.freeze(['signup', 'purchase', 'renewal', 'cancel']);
/** What a group does: a notice per event, a line in the daily summary, or nothing. */
export const NOTICE_MODES = Object.freeze(['instant', 'digest', 'off']);
/** Where notices go. */
export const NOTICE_CHANNELS = Object.freeze(['ntfy', 'email']);
/** A run: this many notices of a group within this time, and what comes next waits for one notice. */
export const NOTICE_BURST = Object.freeze({ count: 5, withinMs: 10 * MINUTE });
/** The longest template. */
export const TEMPLATE_MAX = 400;
/** How long an event is kept, for the summary. */
export const KEEP_DAYS = 40;
/** How long a provider is waited for. */
const SEND_TIMEOUT_MS = 10 * 1000;

/** What billing.js answered, as a group: a purchase, a renewal, or an end. */
const OUTCOME_GROUP = Object.freeze({
  granted: 'purchase', changed: 'purchase', extended: 'renewal', refunded: 'cancel', revoked: 'cancel',
});

/** The variables each template may use; the summary's are its own. */
export const NOTICE_VARIABLES = Object.freeze({
  signup: Object.freeze(['country', 'flag', 'users', 'app']),
  purchase: Object.freeze(['plan', 'amount', 'country', 'flag', 'users', 'app']),
  renewal: Object.freeze(['plan', 'amount', 'country', 'flag', 'users', 'app']),
  cancel: Object.freeze(['reason', 'plan', 'country', 'flag', 'users', 'app']),
  digest: Object.freeze(['signups', 'purchases', 'renewals', 'cancels', 'top_country', 'origins', 'users', 'app']),
});
const TEMPLATE_KEYS = Object.freeze([...NOTICE_GROUPS, 'digest']);
/** What each group says to ntfy for its icon (its emoji short codes). */
const TAGS = Object.freeze({
  signup: ['tada'], purchase: ['moneybag'], renewal: ['repeat'], cancel: ['wave'], digest: ['bar_chart'], test: ['white_check_mark'],
});

export const NOTICE_DEFAULTS = Object.freeze({
  groups: Object.freeze({ signup: 'instant', purchase: 'instant', renewal: 'digest', cancel: 'instant' }),
  templates: Object.freeze({}),
  country: true,
  totals: true,
  via: Object.freeze({ instant: Object.freeze(['ntfy']), digest: Object.freeze(['ntfy']) }),
  digest: Object.freeze({ hour: 9, zone: 'UTC' }),
  ntfy: Object.freeze({ url: '', topic: '' }),
  email: '',
  pausedUntil: null,
  lang: 'en',
});

/* -------------------------------- the data -------------------------------- */

export function adminNoticesSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS admin_notice_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL,
    grp        TEXT NOT NULL,
    kind       TEXT NOT NULL,
    country    TEXT,
    plan       TEXT,
    amount     REAL,
    currency   TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_admin_notice_events_at ON admin_notice_events (at)`);
}

/* ------------------------------ plain pieces ------------------------------ */

/** Codes that name no country: unknown (Cloudflare's XX, the ISO's ZZ), Tor (T1), and the like. */
const NO_COUNTRY = new Set(['XX', 'ZZ', 'T1', 'A1', 'A2', 'O1', 'EU', 'AP']);

/** A country code as ISO 3166 alpha-2, or null when it is anything else. */
export function countryCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && !NO_COUNTRY.has(code) ? code : null;
}

/** A country's flag: its two regional indicator symbols. */
export function flagOf(code) {
  const c = countryCode(code);
  return c ? String.fromCodePoint(...[...c].map((ch) => 0x1F1E6 + ch.charCodeAt(0) - 65)) : '';
}

/** A country's name in a language («Brasil»), or its code where the runtime has no name for it. */
export function countryName(code, lang = 'en') {
  const c = countryCode(code);
  if (!c) return '';
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(c) || c;
  } catch {
    return c;
  }
}

const VARIABLE = /\{(\w+)\}/g;
const known = (vars, name) => vars[name] != null && vars[name] !== '';

/**
 * A template with its variables: `{name}` by its value; a part between brackets
 * kept without them when every variable in it is known, left out when one isn't.
 * Spaces the parts left are tidied; lines are kept.
 */
export function renderTemplate(template, vars = {}) {
  const parts = String(template ?? '').replace(/\[([^[\]]*)\]/g, (match, inner) => {
    const names = [...inner.matchAll(VARIABLE)].map(([, name]) => name);
    return names.every((name) => known(vars, name)) ? inner : '';
  });
  return parts.replace(VARIABLE, (match, name) => (known(vars, name) ? String(vars[name]) : ''))
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:!?)])/g, '$1').trim())
    .filter((line, i, lines) => line || (i > 0 && lines[i - 1]))
    .join('\n')
    .trim();
}

/** The variables a template names that its group doesn't have, or [] (what a save refuses). */
export function unknownVariables(template, key) {
  const allowed = new Set(NOTICE_VARIABLES[key] || []);
  return [...new Set([...String(template).matchAll(VARIABLE)].map(([, name]) => name))].filter((name) => !allowed.has(name));
}

/** Whether brackets open and close in pairs, one level deep. */
function bracketsBalanced(template) {
  let open = false;
  for (const ch of String(template)) {
    if (ch === '[') { if (open) return false; open = true; }
    if (ch === ']') { if (!open) return false; open = false; }
  }
  return !open;
}

/** The day ('YYYY-MM-DD') and hour (0–23) of a moment in a time zone. */
export function localClock(ms, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

/** Whether a name is a time zone the runtime knows. */
export function validZone(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** An ntfy server's address as the panel takes it: https, no user, query or fragment. → its string, or null. */
export function ntfyUrl(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 300) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  return url.href;
}

/** A topic as ntfy takes it. */
export const NTFY_TOPIC = /^[A-Za-z0-9_-]{1,64}$/;

/* --------------------------------- notices -------------------------------- */

/**
 * @param {object} options
 * @param {object} options.database
 * @param {Function} options.texts       createTexts(): (req, user) → { lang, t }
 * @param {object} [options.mailer]      mail.js; with its log, email notices are off
 * @param {Function} options.sign        sessions.sign: the key the ntfy token is kept with
 * @param {string} options.appName
 * @param {string} [options.baseUrl]     what a notice opens: /admin
 * @param {Function} [options.countryOf]  req → the country it came from as a trusted proxy says it
 *   (http.js cloudflareCountry), or null; none: no country for accounts
 * @param {Function} [options.planName]  a plan's id → its name
 * @param {Function} [options.fetch]
 */
export function createAdminNotices({
  database, texts, mailer = null, sign, appName, baseUrl = '', countryOf = null,
  planName = (id) => id, originsSince = null, fetch = globalThis.fetch, clock = () => Date.now(), log = console.log,
}) {
  const key = crypto.createHash('sha256').update(sign('admin-notices')).digest();
  const iso = (ms) => new Date(ms).toISOString();
  const home = String(baseUrl || '').replace(/\/+$/, '');
  const mailOn = Boolean(mailer) && mailer.provider !== 'log';

  /* ------------------------------ settings ------------------------------ */

  /** The settings as kept, over the defaults: whatever is missing or malformed in the row is the default's. */
  function settings() {
    let kept = {};
    try { kept = JSON.parse(database.getMeta('admin_notices') || '{}') || {}; } catch { kept = {}; }
    const groups = { ...NOTICE_DEFAULTS.groups };
    for (const group of NOTICE_GROUPS) if (NOTICE_MODES.includes(kept.groups?.[group])) groups[group] = kept.groups[group];
    const templates = {};
    for (const k of TEMPLATE_KEYS) if (typeof kept.templates?.[k] === 'string' && kept.templates[k]) templates[k] = kept.templates[k];
    const channels = (list) => (Array.isArray(list) ? NOTICE_CHANNELS.filter((c) => list.includes(c)) : null);
    return {
      groups,
      templates,
      country: kept.country !== false,
      totals: kept.totals !== false,
      via: {
        instant: channels(kept.via?.instant) ?? [...NOTICE_DEFAULTS.via.instant],
        digest: channels(kept.via?.digest) ?? [...NOTICE_DEFAULTS.via.digest],
      },
      digest: {
        hour: Number.isInteger(kept.digest?.hour) && kept.digest.hour >= 0 && kept.digest.hour <= 23 ? kept.digest.hour : NOTICE_DEFAULTS.digest.hour,
        zone: validZone(kept.digest?.zone) ? kept.digest.zone : NOTICE_DEFAULTS.digest.zone,
      },
      ntfy: {
        url: ntfyUrl(kept.ntfy?.url) || '',
        topic: NTFY_TOPIC.test(kept.ntfy?.topic || '') ? kept.ntfy.topic : '',
        token: typeof kept.ntfy?.token === 'string' ? kept.ntfy.token : null,
      },
      email: parseAddress(kept.email || '') ? kept.email : '',
      pausedUntil: typeof kept.pausedUntil === 'string' && !Number.isNaN(Date.parse(kept.pausedUntil)) ? kept.pausedUntil : null,
      lang: typeof kept.lang === 'string' && /^[a-z]{2}$/.test(kept.lang) ? kept.lang : NOTICE_DEFAULTS.lang,
    };
  }

  const ntfyReady = (s) => Boolean(s.ntfy.url && s.ntfy.topic);
  const emailReady = (s) => mailOn && Boolean(s.email);
  const ready = (s, channel) => (channel === 'ntfy' ? ntfyReady(s) : emailReady(s));
  const paused = (s, now = clock()) => Boolean(s.pausedUntil) && Date.parse(s.pausedUntil) > now;

  /** The settings for the panel: the token never leaves, only whether there is one. */
  function view() {
    const s = settings();
    let last = null;
    try { last = JSON.parse(database.getMeta('admin_notices.last') || 'null'); } catch { last = null; }
    return {
      groups: s.groups,
      templates: s.templates,
      country: s.country,
      totals: s.totals,
      via: s.via,
      digest: s.digest,
      ntfy: { url: s.ntfy.url, topic: s.ntfy.topic, has_token: Boolean(s.ntfy.token) },
      email: s.email,
      paused_until: s.pausedUntil,
      lang: s.lang,
      // What the install can do: the country of accounts only behind a proxy that says it, email
      // only with a mail server.
      country_available: Boolean(countryOf),
      mail_available: mailOn,
      variables: NOTICE_VARIABLES,
      groups_order: NOTICE_GROUPS,
      modes: NOTICE_MODES,
      channels: NOTICE_CHANNELS,
      burst: { count: NOTICE_BURST.count, minutes: NOTICE_BURST.withinMs / MINUTE },
      template_max: TEMPLATE_MAX,
      last,
    };
  }

  /**
   * The settings the panel sends, checked as a whole: the first field that is wrong is refused with
   * its name, and nothing is kept. A field left out stays as it was; the token, given empty, goes.
   */
  function save(body = {}) {
    const s = settings();
    const fail = (field) => { throw badRequest('field_invalid', { field }); };
    const next = { ...s, groups: { ...s.groups }, templates: { ...s.templates }, via: { ...s.via }, digest: { ...s.digest }, ntfy: { ...s.ntfy } };
    if (body.groups !== undefined) {
      if (!body.groups || typeof body.groups !== 'object') fail('groups');
      for (const [group, mode] of Object.entries(body.groups)) {
        if (!NOTICE_GROUPS.includes(group) || !NOTICE_MODES.includes(mode)) fail('groups');
        next.groups[group] = mode;
      }
    }
    if (body.templates !== undefined) {
      if (!body.templates || typeof body.templates !== 'object') fail('template');
      for (const [k, value] of Object.entries(body.templates)) {
        if (!TEMPLATE_KEYS.includes(k)) fail('template');
        if (value == null || value === '') { delete next.templates[k]; continue; }
        if (typeof value !== 'string' || value.length > TEMPLATE_MAX || !bracketsBalanced(value) || unknownVariables(value, k).length) fail('template');
        next.templates[k] = value.replace(/\r\n?/g, '\n');
      }
    }
    for (const flag of ['country', 'totals']) {
      if (body[flag] !== undefined) {
        if (typeof body[flag] !== 'boolean') fail(flag);
        next[flag] = body[flag];
      }
    }
    if (body.via !== undefined) {
      for (const when of ['instant', 'digest']) {
        const list = body.via?.[when];
        if (list === undefined) continue;
        if (!Array.isArray(list) || list.some((c) => !NOTICE_CHANNELS.includes(c))) fail('via');
        next.via[when] = NOTICE_CHANNELS.filter((c) => list.includes(c));
      }
    }
    if (body.digest !== undefined) {
      const hour = body.digest?.hour;
      if (hour !== undefined) {
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) fail('digest_hour');
        next.digest.hour = hour;
      }
      if (body.digest?.zone !== undefined) {
        if (!validZone(body.digest.zone)) fail('zone');
        next.digest.zone = body.digest.zone;
      }
    }
    if (body.ntfy !== undefined) {
      const { url, topic, token } = body.ntfy || {};
      if (url !== undefined) {
        if (url === '' || url == null) next.ntfy.url = '';
        else next.ntfy.url = ntfyUrl(url) || fail('ntfy_url');
      }
      if (topic !== undefined) {
        if (topic === '' || topic == null) next.ntfy.topic = '';
        else if (!NTFY_TOPIC.test(String(topic))) fail('ntfy_topic');
        else next.ntfy.topic = String(topic);
      }
      if (token !== undefined && token !== null) {
        if (typeof token !== 'string' || token.length > 200 || /[\s]/.test(token)) fail('ntfy_token');
        next.ntfy.token = token ? encryptText(key, token) : null;
      }
    }
    if (body.email !== undefined) {
      if (body.email === '' || body.email == null) next.email = '';
      else if (typeof body.email !== 'string' || body.email.length > 254 || !parseAddress(body.email)) fail('email');
      else next.email = body.email.trim();
    }
    if (body.paused_until !== undefined) {
      if (body.paused_until === null) next.pausedUntil = null;
      else if (typeof body.paused_until !== 'string' || Number.isNaN(Date.parse(body.paused_until))) fail('paused_until');
      else next.pausedUntil = iso(Date.parse(body.paused_until));
    }
    if (body.lang !== undefined) {
      if (typeof body.lang !== 'string' || !/^[a-z]{2}$/.test(body.lang)) fail('lang');
      next.lang = body.lang;
    }
    database.setMeta('admin_notices', JSON.stringify(next));
    return view();
  }

  /* ------------------------------ the words ----------------------------- */

  const wordsOf = (s) => texts(null, { locale: s.lang });
  const templateOf = (s, k) => s.templates[k] || wordsOf(s).t(`notices.template.${k}`);
  const usersNow = () => database.get('SELECT COUNT(*) AS n FROM users WHERE disabled_at IS NULL')?.n ?? 0;

  function amountText(amount, currency, lang) {
    if (!Number.isFinite(amount) || !/^[A-Z]{3}$/.test(currency || '')) return null;
    try {
      return new Intl.NumberFormat(lang, { style: 'currency', currency }).format(amount);
    } catch {
      return null;
    }
  }

  /** What an event's notice says, in the settings' language. */
  function textOf(s, row) {
    const { t } = wordsOf(s);
    const number = new Intl.NumberFormat(s.lang);
    const vars = {
      app: appName,
      users: s.totals ? number.format(usersNow()) : null,
      country: s.country ? countryName(row.country, s.lang) : null,
      flag: s.country ? flagOf(row.country) : null,
      plan: row.plan ? planName(row.plan) : null,
      amount: amountText(row.amount, row.currency, s.lang),
      reason: row.grp === 'cancel' ? t(`notices.reason.${row.kind === 'refunded' ? 'refunded' : 'ended'}`) : null,
    };
    return renderTemplate(templateOf(s, row.grp), vars);
  }

  /* ------------------------------ sending ------------------------------- */

  async function sendNtfy(s, { title, text, tags }) {
    const token = s.ntfy.token ? decryptText(key, s.ntfy.token) : null;
    if (s.ntfy.token && token == null) throw new Error('the ntfy token can no longer be read (the session secret changed): give it again');
    const res = await fetch(s.ntfy.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        topic: s.ntfy.topic, title, message: text, tags,
        ...(home ? { click: `${home}/admin` } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
    await res.body?.cancel?.();
  }

  async function sendEmail(s, { title, text }) {
    await mailer.send({ to: s.email, subject: `${appName} · ${title}`, text });
  }

  /**
   * One notice to the channels given that are ready. Never throws: what failed is logged and kept
   * for the panel (`admin_notices.last`). → [{ channel, ok, error? }]
   */
  async function deliver(s, channels, notice) {
    const results = [];
    for (const channel of channels.filter((c) => ready(s, c))) {
      try {
        await (channel === 'ntfy' ? sendNtfy(s, notice) : sendEmail(s, notice));
        results.push({ channel, ok: true });
      } catch (err) {
        const error = String(err?.message || err).slice(0, 200);
        log(`[notices] ${channel}: ${error}`);
        results.push({ channel, ok: false, error });
      }
    }
    if (results.length) database.setMeta('admin_notices.last', JSON.stringify({ at: iso(clock()), results }));
    return results;
  }

  const titleOf = (s, k) => wordsOf(s).t(`notices.title.${k}`);

  /* ------------------------------- runs --------------------------------- */

  // Per group: when its last notices went, and what waits for the run to end. In memory: after a
  // restart a run starts anew, and what was held is in the summary's counts anyway.
  const recent = new Map();
  const held = new Map();

  async function instant(id) {
    const s = settings();
    const row = database.get('SELECT * FROM admin_notice_events WHERE id = ?', id);
    // Undone with the transaction it was noted in (an account that failed half way): nothing to say.
    if (!row || s.groups[row.grp] !== 'instant' || paused(s)) return;
    const channels = s.via.instant.filter((c) => ready(s, c));
    if (!channels.length) return;
    const now = clock();
    const times = (recent.get(row.grp) || []).filter((at) => now - at < NOTICE_BURST.withinMs);
    if (times.length >= NOTICE_BURST.count) {
      const waiting = held.get(row.grp) || { n: 0, since: now };
      waiting.n += 1;
      held.set(row.grp, waiting);
      recent.set(row.grp, times);
      return;
    }
    times.push(now);
    recent.set(row.grp, times);
    await deliver(s, channels, { title: titleOf(s, row.grp), text: textOf(s, row), tags: TAGS[row.grp] });
  }

  /** What waited for its run to end, as one notice once the run is over. */
  async function flushRuns(s, now) {
    for (const [group, waiting] of [...held]) {
      const last = Math.max(...(recent.get(group) || [0]));
      if (now - last < NOTICE_BURST.withinMs && now - waiting.since < NOTICE_BURST.withinMs) continue;
      held.delete(group);
      recent.set(group, [now]);
      if (s.groups[group] !== 'instant' || paused(s, now)) continue;
      const minutes = Math.max(1, Math.round((now - waiting.since) / MINUTE));
      const text = wordsOf(s).t(`notices.burst.${group}`, { n: waiting.n, minutes });
      await deliver(s, s.via.instant, { title: titleOf(s, group), text, tags: TAGS[group] });
    }
  }

  /* ------------------------------ the events ---------------------------- */

  /** An event kept and, for a group that says so, its notice once the change it is part of is in. */
  function note(grp, kind, { country = null, plan = null, amount = null, currency = null } = {}) {
    const { lastInsertRowid } = database.run(`INSERT INTO admin_notice_events (at, grp, kind, country, plan, amount, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, iso(clock()), grp, kind, countryCode(country), plan,
    Number.isFinite(amount) ? amount : null, /^[A-Z]{3}$/.test(currency || '') ? currency : null);
    // After the transaction the event may be part of: an account made inside one only counts once it is.
    setImmediate(() => instant(Number(lastInsertRowid)).catch((err) => log(`[notices] ${err?.stack || err}`)));
  }

  /**
   * accounts.whenCreated: an account someone made for themselves, in a request. Not one the
   * admin makes or imports (/api/admin/…, the admin's connector), nor an administrator's, nor one a script or the start
   * made (no request).
   */
  function signedUp(user) {
    const scope = currentRequest();
    if (!scope || user?.role === 'admin' || byTheAdmin(scope)) return;
    // Inside the account's transaction: a notice must never be why an account isn't made.
    try {
      note('signup', 'signup', { country: countryOf ? countryOf(scope.req) : null });
    } catch (err) {
      log(`[notices] a new account could not be noted: ${err?.stack || err}`);
    }
  }

  /** billing.whenApplied: a payment's outcome, as its group. */
  function billed({ outcome, event = {}, product = null }) {
    const grp = OUTCOME_GROUP[outcome];
    if (!grp) return;
    note(grp, outcome, {
      country: event.country ?? null,
      plan: product?.plan ?? null,
      amount: grp === 'cancel' ? null : (typeof event.amount === 'number' ? event.amount : null),
      currency: typeof event.currency === 'string' ? event.currency.toUpperCase() : null,
    });
  }

  /* ------------------------------ the summary --------------------------- */

  /**
   * The daily summary, at its hour in its zone, once a day: what the groups that go to it had since
   * the last one. Claimed before it is sent (`admin_notices.digest`), so a restart never sends two;
   * a day with nothing sends none.
   */
  const originsOf = (from, to) => {
    if (!originsSince) return null;
    try { return originsSince(from, to) || null; } catch (err) { log(`the summary's origins could not be read: ${err?.message || err}`); return null; }
  };

  async function digest(s, now) {
    const digestGroups = NOTICE_GROUPS.filter((g) => s.groups[g] === 'digest');
    const { day, hour } = localClock(now, s.digest.zone);
    let mark = null;
    try { mark = JSON.parse(database.getMeta('admin_notices.digest') || 'null'); } catch { mark = null; }
    if (!mark?.from) {
      // The first time: from now on, never a summary of what came before.
      database.setMeta('admin_notices.digest', JSON.stringify({ day, from: iso(now) }));
      return null;
    }
    if (mark.day === day || hour < s.digest.hour) return null;
    database.setMeta('admin_notices.digest', JSON.stringify({ day, from: iso(now) }));
    if (!digestGroups.length || paused(s, now)) return null;
    const channels = s.via.digest.filter((c) => ready(s, c));
    if (!channels.length) return null;
    const counts = Object.fromEntries(database.all(`SELECT grp, COUNT(*) AS n FROM admin_notice_events
      WHERE at >= ? AND at < ? GROUP BY grp`, mark.from, iso(now)).map((r) => [r.grp, r.n]));
    if (!digestGroups.some((g) => counts[g])) return null;
    const number = new Intl.NumberFormat(s.lang);
    const top = s.country ? database.get(`SELECT country, COUNT(*) AS n FROM admin_notice_events
      WHERE at >= ? AND at < ? AND country IS NOT NULL AND grp IN (${digestGroups.map(() => '?').join(', ')})
      GROUP BY country ORDER BY n DESC, country LIMIT 1`, mark.from, iso(now), ...digestGroups) : null;
    const count = (g) => (digestGroups.includes(g) ? number.format(counts[g] || 0) : null);
    const vars = {
      app: appName,
      signups: count('signup'), purchases: count('purchase'), renewals: count('renewal'), cancels: count('cancel'),
      top_country: top ? `${countryName(top.country, s.lang)} ${flagOf(top.country)}` : null,
      // Where the new accounts came from, where the app keeps origins (origins.js topSince): the three with most.
      origins: digestGroups.includes('signup') ? originsOf(mark.from, iso(now)) : null,
      users: s.totals ? number.format(usersNow()) : null,
    };
    const text = renderTemplate(templateOf(s, 'digest'), vars);
    return deliver(s, channels, { title: titleOf(s, 'digest'), text, tags: TAGS.digest });
  }

  let pruned = 0;
  /** Every minute (runtime.js): runs that ended, the summary when it is time, and old events once an hour. */
  async function tick() {
    const now = clock();
    const s = settings();
    await flushRuns(s, now);
    await digest(s, now);
    if (now - pruned >= HOUR) {
      pruned = now;
      database.run('DELETE FROM admin_notice_events WHERE at < ?', iso(now - KEEP_DAYS * DAY));
    }
  }

  /** A notice to every destination given, whatever the groups say: what the panel's Test sends. */
  function test() {
    const s = settings();
    const channels = NOTICE_CHANNELS.filter((c) => ready(s, c));
    if (!channels.length) throw badRequest('notices_no_destination');
    return deliver(s, channels, { title: titleOf(s, 'test'), text: wordsOf(s).t('notices.test', { app: appName }), tags: TAGS.test });
  }

  /**
   * What a template would say now, with an example where an event would put its facts; in `lang`
   * (the panel's) when given, since its default texts are that language's once it saves.
   */
  function preview(k, template, lang = null) {
    const kept = settings();
    const s = typeof lang === 'string' && /^[a-z]{2}$/.test(lang) ? { ...kept, lang } : kept;
    if (!TEMPLATE_KEYS.includes(k)) throw badRequest('field_invalid', { field: 'template' });
    const text = template ?? templateOf(s, k);
    if (typeof text !== 'string' || text.length > TEMPLATE_MAX || !bracketsBalanced(text) || unknownVariables(text, k).length) {
      throw badRequest('field_invalid', { field: 'template' });
    }
    const { t } = wordsOf(s);
    const number = new Intl.NumberFormat(s.lang);
    const sample = 'BR';
    return renderTemplate(text, {
      app: appName,
      users: s.totals ? number.format(usersNow()) : null,
      country: s.country ? countryName(sample, s.lang) : null,
      flag: s.country ? flagOf(sample) : null,
      plan: planName('pro'),
      amount: k === 'cancel' ? null : amountText(35, 'EUR', s.lang),
      reason: t('notices.reason.ended'),
      signups: number.format(12), purchases: number.format(3), renewals: number.format(2), cancels: number.format(1),
      top_country: s.country ? `${countryName(sample, s.lang)} ${flagOf(sample)}` : null,
      origins: originsSince ? 'producthunt 5, reddit.com 4, google.com 2' : null,
    });
  }

  return { settings, view, save, signedUp, billed, tick, test, preview, note };
}

/* ---------------------------------- the API ---------------------------------- */

/**
 * /api/admin/notices: the settings (GET, PUT), a preview of a template (POST …/preview) and a
 * test notice (POST …/test). Administrators only.
 */
export function registerAdminNoticesApi(router, { notices, audit = null }) {
  router.get('/api/admin/notices', (ctx) => {
    requireAdmin(ctx);
    sendJson(ctx.res, 200, notices.view());
  });
  router.put('/api/admin/notices', async (ctx) => {
    const admin = requireAdmin(ctx);
    const body = await readJson(ctx.req);
    const saved = notices.save(body);
    // Which parts changed, never what they say: a template is the admin's words, a token a secret.
    audit?.record({ action: 'admin.notices.update', actor: admin, req: ctx.req, meta: { fields: Object.keys(body || {}).slice(0, 12) } });
    sendJson(ctx.res, 200, saved);
  });
  router.post('/api/admin/notices/preview', async (ctx) => {
    requireAdmin(ctx);
    const body = await readJson(ctx.req);
    sendJson(ctx.res, 200, { text: notices.preview(body.key, body.template ?? undefined, body.lang ?? null) });
  });
  router.post('/api/admin/notices/test', async (ctx) => {
    requireAdmin(ctx);
    sendJson(ctx.res, 200, { results: await notices.test() });
  });
}
