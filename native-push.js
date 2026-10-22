/**
 * Native push with no dependencies: notices for the suite's app on a phone,
 * sent straight to Apple (APNs) and Google (FCM HTTP v1), with no push service
 * in between. With `modules.push`, `modules.devices` and `push: { native: true }`
 * in suite.config.js; without the option nothing here runs.
 *
 *   · APNs over HTTP/2 (`node:http2`) with token auth: an ES256 JWT signed with
 *     the team's .p8 key (APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY), made
 *     again every 50 minutes (Apple takes one up to an hour old and refuses
 *     new ones more often than every 20), over one connection per host kept
 *     open: api.push.apple.com, or api.sandbox.push.apple.com for a token of a
 *     development build.
 *   · FCM HTTP v1 with a service account (FCM_SERVICE_ACCOUNT, its JSON): an
 *     RS256 JWT exchanged at Google's OAuth for an access token of an hour,
 *     kept until five minutes before it ends.
 *
 * The phone's app registers its token with its device token (devices.js):
 * one native token per device, in `device_push_tokens`, which goes with the
 * device (revoked, idle, forgotten, its account disabled or deleted). The same
 * send the modules make for Web Push reaches it (push.js): the person's
 * subscriptions and their devices' tokens. A token Apple or Google says is gone
 * is dropped; one refused three times in a row too; a failure that says
 * nothing of the device (the network, a 429, the service down, our own
 * credentials) is only logged. One device's failure never throws.
 *
 * A phone's app may also show some notices itself: the reminders it scheduled
 * as local notifications, which ring with the phone offline. It says which
 * (`PUT /api/devices/reminders`, `device_reminders`), and a send that names
 * its reminder (`deliver(…, { reminder: { id, at } })`) skips the phones that
 * already show it, so none rings twice. Web Push is never skipped.
 */
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { badRequest, readJson, sendJson, str, unauthorized, HttpError } from './http.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export const APNS_PRODUCTION = 'https://api.push.apple.com';
export const APNS_SANDBOX = 'https://api.sandbox.push.apple.com';
export const FCM_SEND = 'https://fcm.googleapis.com/v1/projects';
export const GOOGLE_OAUTH = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** Apple refuses a provider token older than an hour, and one made more often than every 20 minutes. */
const APNS_JWT_MS = 50 * 60 * 1000;
/** An access token is asked for again this long before Google says it ends. */
const OAUTH_MARGIN_MS = 5 * 60 * 1000;
/** As push.js: a service that doesn't answer in this long is treated as down. */
const SEND_TIMEOUT_MS = 10000;
/** Targets sent at once (HTTP/2 multiplexes them on one connection). */
const DELIVER_BATCH = 20;
/** APNs: the whole JSON payload of an alert (4 KB). */
export const APNS_MAX_PAYLOAD = 4096;
/**
 * FCM: 4 KB for a message's notification and data. The JSON we measure also
 * carries the android block, so staying under it leaves room.
 */
export const FCM_MAX_PAYLOAD = 4000;
/** apns-collapse-id: at most 64 bytes. */
const COLLAPSE_MAX = 64;

export const PLATFORMS = ['ios', 'android'];
const ENVIRONMENTS = ['sandbox', 'production'];
/** An APNs device token is 32 bytes in hex today; Apple says it may grow, never past this. */
const APNS_TOKEN = /^[0-9a-fA-F]{64,200}$/;
/** An FCM registration token: a few hundred characters of this alphabet. */
const FCM_TOKEN = /^[A-Za-z0-9_:.-]{20,1000}$/;
const LANG = /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{1,8}){0,3}$/;
const CATEGORY = /^[A-Za-z0-9._-]{1,64}$/;
/** Reminders a device says it shows at once: a week of one person's, never a table filled by a script. */
export const MAX_DEVICE_REMINDERS = 64;
/** A reminder's id: the module's own, as text. */
const REMINDER_ID_MAX = 64;
/** The time the phone scheduled and the one the server sends are the same reminder this close. */
export const REMINDER_SLACK_MS = 60 * 1000;
/** A module as a host mounts it (host.js MOUNT), or an app's id on its own. */
const MODULE = /^[a-z][a-z0-9-]{1,30}$/;
/** An ISO-8601 instant with its date, time and offset: `2026-10-21T08:00:00.000Z`, `…T10:00+02:00`. */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/* --------------------------------- table --------------------------------- */

/**
 * One native token per device (suite migration 24). Every app gets the table,
 * as it gets `device_tokens`, and it stays empty without `push.native`. It
 * hangs on the device: a device the purge forgets takes its token with it, and
 * an account deleted takes its devices.
 */
export function devicePushTokensSchema(d) {
  d.exec(`CREATE TABLE device_push_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   INTEGER NOT NULL UNIQUE REFERENCES device_tokens(id) ON DELETE CASCADE,
    platform    TEXT NOT NULL,
    token       TEXT NOT NULL,
    environment TEXT,
    lang        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_ok_at  TEXT,
    failures    INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX ux_device_push_tokens_token ON device_push_tokens (platform, token)`);
}

/**
 * The reminders a phone's app scheduled as its own local notifications (suite
 * migration 26), as it last said them: a send of the same reminder skips that
 * phone. Each list the device sends replaces the one before. It hangs on the
 * device as its token does, and goes when the device is revoked or signs out,
 * and when the app forgets its token. Never exported: it is the phone's, and
 * the phone says it again.
 */
export function deviceRemindersSchema(d) {
  d.exec(`CREATE TABLE device_reminders (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
    module    TEXT,
    item_id   TEXT NOT NULL,
    at        TEXT NOT NULL
  );
  CREATE INDEX ix_device_reminders_device ON device_reminders (device_id, item_id)`);
}

/* -------------------------------- reminders ------------------------------- */

/** The milliseconds of an ISO-8601 instant, or null: a day that doesn't exist (February 30) is not one. */
export function instantOf(text) {
  if (typeof text !== 'string' || text.length > 40) return null;
  const m = ISO_INSTANT.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute, second = 0] = m.slice(1, 7).map((part) => (part == null ? undefined : Number(part)));
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The reminder a send names (`options.reminder`), as it is compared:
 * { module: text | null, id: text, at: milliseconds }, or null when there is
 * none or it can't be read, and then nothing is skipped (a notice twice is
 * better than none). `id` a text or a number; `at` an ISO-8601 text, a Date or
 * milliseconds.
 */
export function reminderOf(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' ? value.id
    : typeof value.id === 'number' && Number.isFinite(value.id) ? String(value.id) : null;
  if (!id || id.length > REMINDER_ID_MAX) return null;
  const at = value.at instanceof Date ? value.at.getTime()
    : typeof value.at === 'number' ? value.at : instantOf(value.at);
  if (!Number.isFinite(at)) return null;
  const module = typeof value.module === 'string' && value.module ? value.module : null;
  return { module, id, at };
}

/**
 * A device's list as `PUT /api/devices/reminders` takes it: at most
 * MAX_DEVICE_REMINDERS of { module: a module's path or null, id: up to 64
 * characters, at: an ISO-8601 instant }. → [{ module, id, at (ms) }], or a
 * coded 400 naming the field.
 */
export function deviceRemindersOf(items) {
  if (items == null) throw badRequest('field_required', { field: 'items' });
  if (!Array.isArray(items)) throw badRequest('field_invalid', { field: 'items' });
  if (items.length > MAX_DEVICE_REMINDERS) throw badRequest('field_too_long', { field: 'items', max: MAX_DEVICE_REMINDERS });
  return items.map((item, i) => {
    const field = (name) => `items[${i}].${name}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw badRequest('field_invalid', { field: `items[${i}]` });
    const module = item.module ?? null;
    if (module !== null && (typeof module !== 'string' || !MODULE.test(module))) throw badRequest('field_invalid', { field: field('module') });
    const id = str(item.id, { field: field('id'), max: REMINDER_ID_MAX, min: 1 });
    if (item.at == null) throw badRequest('field_required', { field: field('at') });
    const at = instantOf(item.at);
    if (at == null) throw badRequest('field_invalid', { field: field('at') });
    return { module, id, at };
  });
}

/* ------------------------------- credentials ------------------------------ */

/** A PEM written in one line of an .env, with `\n` for its line breaks, as it was in the file. */
const pemOf = (text) => String(text).trim().replace(/\\n/g, '\n');

/**
 * The credentials of an install, from its environment, for `push.native`:
 * → { apns, fcm, missing: { apns: [names], fcm: [names] }, problems: { apns: [text], fcm: [text] } }.
 * A platform with none of its variables, or only some, is off (`missing` names
 * what it lacks); one with a value that can't be used is off too (`problems`
 * names the variable and what is wrong, never its value). Neither stops the
 * start: as with Web Push, notifications are an extra, and a typo in an
 * install's panel must not take the whole app down.
 * @param {object} env
 * @param {object} [options]
 * @param {string|null} [options.topic]  suite.config.js push.apnsTopic: the app's bundle id
 */
export function nativePushFromEnv(env, { topic = null } = {}) {
  const problems = { apns: [], fcm: [] };
  const missing = { apns: [], fcm: [] };
  let apns = null;
  let fcm = null;

  const apnsTopic = env.APNS_TOPIC || topic || null;
  const apnsGiven = { APNS_KEY_ID: env.APNS_KEY_ID, APNS_TEAM_ID: env.APNS_TEAM_ID, APNS_PRIVATE_KEY: env.APNS_PRIVATE_KEY };
  missing.apns = Object.entries(apnsGiven).filter(([, value]) => !value).map(([name]) => name);
  if (!apnsTopic) missing.apns.push('APNS_TOPIC');
  if (!missing.apns.length) {
    if (!/^[A-Z0-9]{10}$/.test(env.APNS_KEY_ID)) problems.apns.push('APNS_KEY_ID is not an APNs key id (10 letters and digits, from the key in Apple Developer)');
    if (!/^[A-Z0-9]{10}$/.test(env.APNS_TEAM_ID)) problems.apns.push('APNS_TEAM_ID is not an Apple team id (10 letters and digits)');
    if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(apnsTopic)) problems.apns.push('APNS_TOPIC (or push.apnsTopic) is not a bundle id, such as com.example.app');
    const pem = pemOf(env.APNS_PRIVATE_KEY);
    try {
      const key = crypto.createPrivateKey(pem);
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('not P-256');
    } catch {
      problems.apns.push('APNS_PRIVATE_KEY is not the .p8 key Apple gives (a P-256 private key in PEM, the .p8 file’s text)');
    }
    if (!problems.apns.length) apns = { keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, privateKey: pem, topic: apnsTopic };
  }

  if (!env.FCM_SERVICE_ACCOUNT) missing.fcm.push('FCM_SERVICE_ACCOUNT');
  else {
    let account = null;
    const raw = String(env.FCM_SERVICE_ACCOUNT).trim();
    // The JSON as Firebase gives it, or the same in base64 for a panel that takes one line only.
    for (const text of [raw, raw.startsWith('{') ? null : Buffer.from(raw, 'base64').toString('utf8')]) {
      if (!text) continue;
      try { account = JSON.parse(text); break; } catch { account = null; }
    }
    const problem = !account || typeof account !== 'object' ? 'is not JSON (the service account key file from Firebase, or it in base64)'
      : !account.project_id || typeof account.project_id !== 'string' ? 'has no project_id'
        : !/^[^\s@]+@[^\s@]+$/.test(String(account.client_email || '')) ? 'has no client_email'
          : !account.private_key ? 'has no private_key' : null;
    if (problem) problems.fcm.push(`FCM_SERVICE_ACCOUNT ${problem}`);
    else {
      try {
        const key = crypto.createPrivateKey(pemOf(account.private_key));
        if (key.asymmetricKeyType !== 'rsa') throw new Error('not RSA');
        fcm = { projectId: account.project_id, clientEmail: account.client_email, privateKey: pemOf(account.private_key) };
      } catch {
        problems.fcm.push('FCM_SERVICE_ACCOUNT: its private_key is not an RSA private key in PEM');
      }
    }
  }
  return { apns, fcm, missing, problems };
}

/* ------------------------------ what is sent ------------------------------ */

/** What a Web Push payload carries that a notice on a phone draws in its own way, or not at all. */
const NOT_DATA = new Set([
  'title', 'body', 'badge', 'category', 'icon', 'image', 'actions', 'vibrate', 'silent', 'requireInteraction',
  'renotify', 'timestamp', 'dir', 'data', 'sound', 'aps',
]);
/** Keys FCM keeps for itself in `data`. */
const FCM_RESERVED = /^(from|notification|message_type|collapse_key)$|^(google|gcm)/i;

/**
 * A notice as the phone shows it, from what a module sends for Web Push
 * (`{ title, body, url, tag, … }`, or a string): its texts, its badge and
 * category when given, and every other plain value (url, module, id, tag,
 * task_id…) as data for the app when it is tapped.
 */
export function noticeOf(payload) {
  let p = payload;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch { p = { body: p }; }
    if (typeof p === 'string') p = { body: p };
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = {};
  const text = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));
  const data = {};
  for (const [key, value] of Object.entries(p)) {
    if (NOT_DATA.has(key) || value == null) continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) data[key] = value;
  }
  return {
    title: text(p.title),
    body: text(p.body),
    badge: Number.isInteger(p.badge) && p.badge >= 0 ? p.badge : null,
    category: typeof p.category === 'string' && CATEGORY.test(p.category) ? p.category : null,
    tag: typeof p.tag === 'string' && p.tag ? p.tag : null,
    module: typeof p.module === 'string' && p.module ? p.module : null,
    data,
  };
}

/** The first `max` bytes of a text in UTF-8, never half a character. */
function cutBytes(text, max) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return text;
  let end = Math.max(0, max);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Shortens a notice's body (then its title) until `build(notice)` is at most
 * `max` bytes of JSON. → the JSON text, or null when even empty texts don't fit.
 */
function fitted(notice, build, max) {
  let current = { ...notice };
  for (let i = 0; i < 6; i++) {
    const json = JSON.stringify(build(current));
    const over = Buffer.byteLength(json) - max;
    if (over <= 0) return json;
    // The ellipsis is 3 bytes, and JSON escapes can make a character count more than once.
    if (current.body) current = { ...current, body: `${cutBytes(current.body, Buffer.byteLength(current.body) - over - 8).trimEnd()}…` };
    else if (current.title) current = { ...current, title: `${cutBytes(current.title, Buffer.byteLength(current.title) - over - 8).trimEnd()}…` };
    else return null;
    if (current.body === '…') current.body = '';
    if (current.title === '…') current.title = '';
  }
  const json = JSON.stringify(build(current));
  return Buffer.byteLength(json) <= max ? json : null;
}

/** What collapses notices into one, from the send's `topic` or the notice's tag. */
const collapseOf = (notice, options) => {
  const id = options.topic ?? notice.tag;
  return id ? cutBytes(String(id), COLLAPSE_MAX) : null;
};

/**
 * The APNs payload of a notice: `aps.alert` with its texts, the default sound,
 * the badge and category when given, `thread-id` (the module, else the tag)
 * to group them, and the data next to `aps`. The same data again under `body`,
 * where expo-notifications reads `content.data`. → JSON text, or null when it
 * can't fit in 4 KB.
 */
export function apnsPayload(notice) {
  const build = (n) => ({
    aps: {
      alert: { title: n.title, body: n.body },
      sound: 'default',
      ...(n.badge != null ? { badge: n.badge } : {}),
      ...(n.category ? { category: n.category } : {}),
      ...(n.module || n.tag ? { 'thread-id': n.module || n.tag } : {}),
    },
    ...n.data,
    body: n.data,
  });
  return fitted(notice, build, APNS_MAX_PAYLOAD);
}

/** The headers of an APNs request for a notice. */
export function apnsHeaders(notice, { topic, ttl = 3600, urgency = 'normal', clock = Date.now, collapse = null } = {}) {
  return {
    'apns-push-type': 'alert',
    'apns-topic': topic,
    // 10 sends at once; 5 lets the phone choose when, for what isn't urgent.
    'apns-priority': urgency === 'low' || urgency === 'very-low' ? '5' : '10',
    'apns-expiration': String(ttl > 0 ? Math.floor(clock() / 1000) + ttl : 0),
    ...(collapse ? { 'apns-collapse-id': collapse } : {}),
  };
}

/**
 * The FCM v1 message of a notice (without its token): `notification` with its
 * texts, `android` with the collapse key, priority, time to live, and the
 * notice's channel, tag and count, and `data` with every value as a string
 * (FCM takes nothing else), plus `body`, the same data as JSON, where
 * expo-notifications reads `content.data`. → the message, or null when it
 * can't fit in 4 KB.
 */
export function fcmMessage(notice, { ttl = 3600, urgency = 'normal', channel = 'default', collapse = null } = {}) {
  const data = {};
  for (const [key, value] of Object.entries(notice.data)) if (!FCM_RESERVED.test(key)) data[key] = String(value);
  if (notice.category) data.category = notice.category;
  const build = (n) => ({
    notification: { title: n.title, body: n.body },
    android: {
      priority: urgency === 'low' || urgency === 'very-low' ? 'NORMAL' : 'HIGH',
      ttl: `${Math.max(0, Math.floor(ttl))}s`,
      ...(collapse ? { collapse_key: collapse } : {}),
      notification: {
        ...(channel ? { channel_id: channel } : {}),
        ...(n.tag ? { tag: n.tag } : {}),
        ...(n.badge != null ? { notification_count: n.badge } : {}),
      },
    },
    data: { ...data, body: JSON.stringify(n.data) },
  });
  const json = fitted(notice, build, FCM_MAX_PAYLOAD);
  return json ? JSON.parse(json) : null;
}

/* ---------------------------------- APNs ---------------------------------- */

/**
 * Sends to Apple. `connect(authority)` opens the HTTP/2 session (http2.connect;
 * a test gives one to a server of its own); one session per host is kept and
 * opened again when Apple closes it.
 * → { send(target, notice, options) → { status, reason }, close() }
 */
export function createApnsSender({
  keyId, teamId, privateKey, topic, connect = (authority) => http2.connect(authority),
  clock = () => Date.now(), log = console.error,
}) {
  const key = crypto.createPrivateKey(privateKey);
  let jwt = null;

  /** The provider token, made again every 50 minutes, or at once after Apple refused it. */
  function providerToken() {
    const now = clock();
    if (jwt && now - jwt.at < APNS_JWT_MS) return jwt.value;
    const signed = `${b64url(JSON.stringify({ alg: 'ES256', kid: keyId }))}.${b64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }))}`;
    const signature = crypto.sign('sha256', Buffer.from(signed), { key, dsaEncoding: 'ieee-p1363' });
    jwt = { value: `${signed}.${b64url(signature)}`, at: now };
    return jwt.value;
  }

  const sessions = new Map();
  const pending = new Map();
  function sessionFor(authority) {
    const open = sessions.get(authority);
    if (open && !open.closed && !open.destroyed) return open;
    const session = connect(authority);
    const forget = () => { if (sessions.get(authority) === session) sessions.delete(authority); };
    session.on('error', (err) => { forget(); log(`[push] APNs connection: ${err?.message || err}`); });
    session.on('goaway', forget);
    session.on('close', forget);
    // Kept open between notices, but never what keeps the process alive.
    session.unref?.();
    sessions.set(authority, session);
    return session;
  }
  const hold = (session, delta) => {
    const n = (pending.get(session) || 0) + delta;
    pending.set(session, n);
    if (n > 0) session.ref?.(); else { pending.delete(session); session.unref?.(); }
  };

  function send(target, notice, options = {}) {
    const body = apnsPayload(notice);
    if (body == null) return Promise.resolve({ status: 413, reason: 'PayloadTooLarge' });
    const authority = target.environment === 'sandbox' ? APNS_SANDBOX : APNS_PRODUCTION;
    return new Promise((resolve) => {
      let done = false;
      let session;
      const finish = (result) => {
        if (done) return;
        done = true;
        if (session) hold(session, -1);
        resolve(result);
      };
      try {
        session = sessionFor(authority);
        hold(session, 1);
        const req = session.request({
          ':method': 'POST',
          ':path': `/3/device/${target.token}`,
          authorization: `bearer ${providerToken()}`,
          'content-type': 'application/json',
          ...apnsHeaders(notice, { topic, ttl: options.ttl ?? 3600, urgency: options.urgency, clock, collapse: collapseOf(notice, options) }),
        });
        let status = 0;
        const chunks = [];
        req.setTimeout(SEND_TIMEOUT_MS, () => {
          req.close(http2.constants.NGHTTP2_CANCEL);
          finish({ status: 0, reason: 'timeout' });
        });
        req.on('response', (headers) => { status = Number(headers[':status']) || 0; });
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          let reason = null;
          try { reason = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').reason ?? null; } catch { reason = null; }
          if (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken') jwt = null;
          finish({ status, reason });
        });
        req.on('error', (err) => finish({ status: 0, reason: err?.message || 'error' }));
        req.on('close', () => finish({ status, reason: status ? null : 'closed' }));
        req.end(body);
      } catch (err) {
        finish({ status: 0, reason: err?.message || 'error' });
      }
    });
  }

  function close() {
    for (const session of sessions.values()) session.close();
    sessions.clear();
  }

  return { send, close, providerToken };
}

/* ---------------------------------- FCM ----------------------------------- */

/** An RS256 JWT for Google's OAuth (RFC 7523): the service account says who it is. */
function serviceAccountAssertion({ clientEmail, privateKey }, now) {
  const iat = Math.floor(now / 1000);
  const signed = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: clientEmail, scope: FCM_SCOPE, aud: GOOGLE_OAUTH, iat, exp: iat + 3600,
  }))}`;
  return `${signed}.${b64url(crypto.sign('sha256', Buffer.from(signed), privateKey))}`;
}

/**
 * Sends to Google. → { send(target, notice, options) → { status, code, token }, close() }:
 * `code` is FCM's (UNREGISTERED, INVALID_ARGUMENT…), `token` whether what it
 * refused was the registration token.
 */
export function createFcmSender({
  projectId, clientEmail, privateKey, channel = 'default', fetch = globalThis.fetch,
  clock = () => Date.now(), log = console.error,
}) {
  const key = crypto.createPrivateKey(privateKey);
  let access = null;
  let asking = null;

  /** An access token, kept until five minutes before it ends; one request at a time asks for it. */
  async function accessToken() {
    if (access && clock() < access.until - OAUTH_MARGIN_MS) return access.token;
    asking ??= (async () => {
      const res = await fetch(GOOGLE_OAUTH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: serviceAccountAssertion({ clientEmail, privateKey: key }, clock()),
        }).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || typeof json.access_token !== 'string') {
        throw new Error(`Google OAuth answered ${res.status}${json.error ? ` (${json.error})` : ''}`);
      }
      access = { token: json.access_token, until: clock() + (Number(json.expires_in) || 3600) * 1000 };
      return access.token;
    })().finally(() => { asking = null; });
    return asking;
  }

  async function send(target, notice, options = {}) {
    const message = fcmMessage(notice, {
      ttl: options.ttl ?? 3600, urgency: options.urgency, channel, collapse: collapseOf(notice, options),
    });
    if (!message) return { status: 413, code: 'PAYLOAD_TOO_LARGE', token: false };
    let bearer;
    try {
      bearer = await accessToken();
    } catch (err) {
      log(`[push] FCM: no access token: ${err?.message || err}`);
      return { status: 0, code: 'OAUTH', token: false, ours: true };
    }
    let res;
    try {
      res = await fetch(`${FCM_SEND}/${encodeURIComponent(projectId)}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { ...message, token: target.token } }),
        redirect: 'error',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      return { status: 0, code: err?.message || 'network', token: false };
    }
    if (res.ok) return { status: res.status, code: null, token: false };
    const json = await res.json().catch(() => ({}));
    const error = json?.error || {};
    const details = Array.isArray(error.details) ? error.details : [];
    const code = details.find((d) => d?.errorCode)?.errorCode || error.status || null;
    const token = details.some((d) => (d?.fieldViolations || []).some((v) => v?.field === 'message.token'))
      || /registration token/i.test(String(error.message || ''));
    // Our access token no longer works: the next send asks for another.
    if (res.status === 401) access = null;
    return { status: res.status, code, token };
  }

  return { send, close() {}, accessToken };
}

/* --------------------------------- outcomes -------------------------------- */

/** APNs reasons that are about our request or our credentials, the same for every device. */
const APNS_OURS = new Set([
  'BadCollapseId', 'BadExpirationDate', 'BadMessageId', 'BadPriority', 'BadTopic', 'BadPushType', 'PayloadEmpty',
  'PayloadTooLarge', 'MissingTopic', 'TopicDisallowed', 'BadCertificate', 'BadCertificateEnvironment',
  'ExpiredProviderToken', 'InvalidProviderToken', 'MissingProviderToken', 'BadPath', 'MethodNotAllowed',
  'TooManyProviderTokenUpdates', 'Forbidden',
]);

/**
 * What a sender's answer says of the device: `gone` (drop it), `ok`,
 * `rejected` (a refusal about it: three in a row and it goes), or nothing of it.
 */
export function apnsOutcome({ status, reason }) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'ExpiredToken') return 'gone';
  if (status === 403 || status === 408 || status === 413 || status === 429 || APNS_OURS.has(reason)) return 'ours';
  if (status >= 400 && status < 500) return 'rejected';
  return 'later';
}

export function fcmOutcome({ status, code, token, ours = false }) {
  if (status >= 200 && status < 300) return 'ok';
  if (ours) return 'ours';
  if (status === 404 || code === 'UNREGISTERED') return 'gone';
  if (code === 'INVALID_ARGUMENT' || status === 400) return token ? 'gone' : 'ours';
  if (code === 'SENDER_ID_MISMATCH') return 'rejected';
  if (status === 401 || status === 403 || status === 413 || code === 'THIRD_PARTY_AUTH_ERROR') return 'ours';
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return 'rejected';
  return 'later';
}

/* -------------------------------- the service ------------------------------ */

/**
 * @param {object} options
 * @param {object} options.database
 * @param {object} options.devices       devices.js: only a device that still works gets notices
 * @param {object|null} options.apns     nativePushFromEnv().apns, or null: iPhones get nothing
 * @param {object|null} options.fcm      nativePushFromEnv().fcm, or null: Android phones get nothing
 * @param {string} [options.channel]     the Android notification channel the app created
 * @param {object} [options.senders]     { apns, fcm } made elsewhere (tests)
 */
export function createNativePush({
  database, devices, apns = null, fcm = null, channel = 'default', senders = {},
  connect, fetch = globalThis.fetch, clock = () => Date.now(), log = console.error,
}) {
  const apnsSender = senders.apns ?? (apns ? createApnsSender({ ...apns, connect, clock, log }) : null);
  const fcmSender = senders.fcm ?? (fcm ? createFcmSender({ ...fcm, channel, fetch, clock, log }) : null);
  // What phones show themselves (migration 26): a database without the table has nothing to skip.
  const remindersLinked = database.columnsOf('device_reminders').length > 0;

  /** The working devices' tokens of some people, as rows push.js can tell from a subscription. */
  function targetsOf(userIds) {
    const ids = [...new Set([...userIds].map(Number))].filter(Number.isInteger);
    if (!ids.length) return [];
    return database.all(`SELECT p.id, p.device_id, p.platform, p.token, p.environment, p.lang, p.failures,
        p.last_ok_at, d.user_id
      FROM device_push_tokens p JOIN device_tokens d ON d.id = p.device_id JOIN users u ON u.id = d.user_id
      WHERE d.user_id IN (${ids.map(() => '?').join(', ')}) AND d.revoked_at IS NULL AND u.disabled_at IS NULL
      ORDER BY p.id`, ...ids)
      .filter((row) => devices.isActive(row.device_id))
      .map((row) => ({ ...row, native: true }));
  }

  /** The target of one device, when it has a token and still works. */
  function targetOfDevice(deviceId) {
    const row = database.get(`SELECT p.id, p.device_id, p.platform, p.token, p.environment, p.lang, p.failures,
        p.last_ok_at, d.user_id
      FROM device_push_tokens p JOIN device_tokens d ON d.id = p.device_id WHERE p.device_id = ?`, deviceId);
    return row && devices.isActive(deviceId) ? { ...row, native: true } : null;
  }

  /**
   * Keeps (or replaces) a device's token. The same token on another device of
   * the table (the app reinstalled, connected again) moves here: a phone gets
   * each notice once.
   */
  function register(deviceId, { platform, token, environment = null, lang = null }) {
    database.tx(() => {
      database.run('DELETE FROM device_push_tokens WHERE platform = ? AND token = ? AND device_id <> ?', platform, token, deviceId);
      database.run(`INSERT INTO device_push_tokens (device_id, platform, token, environment, lang)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (device_id) DO UPDATE SET platform = excluded.platform, token = excluded.token,
          environment = excluded.environment, lang = excluded.lang, failures = 0, updated_at = datetime('now')`,
      deviceId, platform, token, environment, lang);
    });
  }

  /** Forgets a device's token, and the reminders it said it shows: without notices, it shows none. */
  const unregister = (deviceId) => database.tx(() => {
    clearReminders(deviceId);
    return database.run('DELETE FROM device_push_tokens WHERE device_id = ?', deviceId).changes > 0;
  });

  /**
   * Replaces the reminders a device says it shows itself with `items`, as
   * deviceRemindersOf() gave them (the same one twice is kept once). → how many
   */
  function setReminders(deviceId, items) {
    const rows = new Map();
    for (const item of items) {
      const row = [item.module ?? null, String(item.id), new Date(item.at).toISOString()];
      rows.set(JSON.stringify(row), row);
    }
    database.tx(() => {
      database.run('DELETE FROM device_reminders WHERE device_id = ?', deviceId);
      for (const [module, id, at] of rows.values()) {
        database.run('INSERT INTO device_reminders (device_id, module, item_id, at) VALUES (?, ?, ?, ?)', deviceId, module, id, at);
      }
    });
    return rows.size;
  }

  function clearReminders(deviceId) {
    return remindersLinked ? database.run('DELETE FROM device_reminders WHERE device_id = ?', deviceId).changes : 0;
  }

  /**
   * Which of these devices said they show this reminder (reminderOf()) themselves:
   * the same module and id, at the same instant give or take REMINDER_SLACK_MS.
   */
  function scheduledOn(deviceIds, reminder) {
    const ids = [...new Set([...deviceIds].map(Number))].filter(Number.isInteger);
    if (!remindersLinked || !reminder || !ids.length) return new Set();
    return new Set(database.all(`SELECT device_id, at FROM device_reminders
      WHERE item_id = ? AND module IS ? AND device_id IN (${ids.map(() => '?').join(', ')})`, reminder.id, reminder.module, ...ids)
      .filter((row) => Math.abs(Date.parse(row.at) - reminder.at) <= REMINDER_SLACK_MS)
      .map((row) => row.device_id));
  }

  /** Which of these devices have a token: for the list in Settings. */
  function withTokens(deviceIds) {
    const ids = [...deviceIds].map(Number).filter(Number.isInteger);
    if (!ids.length) return new Set();
    return new Set(database.all(`SELECT device_id FROM device_push_tokens WHERE device_id IN (${ids.map(() => '?').join(', ')})`, ...ids)
      .map((row) => row.device_id));
  }

  const said = new Set();
  /** A platform without credentials is said once, not once per notice. */
  const once = (key, line) => { if (!said.has(key)) { said.add(key); log(line); } };

  /**
   * Sends one notice to one target, writing nothing. → { ok, status, gone, outcome, reason? }
   * With `options.reminder`, a device that shows that reminder itself gets
   * nothing: → { ok: false, skipped: true, outcome: 'scheduled' }.
   */
  async function send(target, payload, options = {}) {
    const reminder = reminderOf(options.reminder);
    if (reminder && scheduledOn([target.device_id], reminder).size) {
      return { ok: false, status: 0, gone: false, outcome: 'scheduled', reason: 'scheduled_on_device', skipped: true };
    }
    const notice = noticeOf(payload);
    if (target.platform === 'ios') {
      if (!apnsSender) {
        once('apns', '[push] a notice for an iPhone was not sent: APNs has no credentials (APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY, APNS_TOPIC)');
        return { ok: false, status: 0, gone: false, outcome: 'off', reason: 'apns_off' };
      }
      const res = await apnsSender.send(target, notice, options);
      const outcome = apnsOutcome(res);
      return { ok: outcome === 'ok', status: res.status, gone: outcome === 'gone', outcome, reason: res.reason ?? null };
    }
    if (target.platform === 'android') {
      if (!fcmSender) {
        once('fcm', '[push] a notice for an Android phone was not sent: FCM has no credentials (FCM_SERVICE_ACCOUNT)');
        return { ok: false, status: 0, gone: false, outcome: 'off', reason: 'fcm_off' };
      }
      const res = await fcmSender.send(target, notice, options);
      const outcome = fcmOutcome(res);
      return { ok: outcome === 'ok', status: res.status, gone: outcome === 'gone', outcome, reason: res.code ?? null };
    }
    return { ok: false, status: 0, gone: false, outcome: 'off', reason: 'platform' };
  }

  async function deliverOne(target, payload, options) {
    const res = await send(target, typeof payload === 'function' ? payload(target) : payload, options);
    if (res.gone) {
      database.run('DELETE FROM device_push_tokens WHERE id = ?', target.id);
    } else if (res.ok) {
      database.run("UPDATE device_push_tokens SET last_ok_at = datetime('now'), failures = 0 WHERE id = ?", target.id);
    } else if (res.outcome === 'rejected') {
      database.run('UPDATE device_push_tokens SET failures = failures + 1 WHERE id = ?', target.id);
      database.run('DELETE FROM device_push_tokens WHERE id = ? AND failures >= 3', target.id);
      log(`[push] a native notice was refused (${res.status} ${res.reason || ''})`.trim());
    } else if (res.outcome === 'ours') {
      log(`[push] a native notice was refused for a reason of ours, not the device's (${res.status} ${res.reason || ''})`.trim());
    } else if (res.outcome === 'later') {
      log(`[push] a native notice could not be sent for now (${res.status || res.reason})`);
    }
    return res;
  }

  /**
   * Sends to several targets and keeps the table clean; never rejects for a
   * device. → { sent, gone, failed }. With `options.reminder` ({ module, id,
   * at }: reminderOf()), the devices that show it themselves are left out and
   * counted apart: → { sent, gone, failed, skipped }.
   */
  async function deliver(targets, payload, options = {}) {
    const { reminder: named, ...rest } = options;
    const reminder = reminderOf(named);
    const skip = reminder ? scheduledOn(targets.map((target) => target.device_id), reminder) : new Set();
    const sending = skip.size ? targets.filter((target) => !skip.has(target.device_id)) : targets;
    const results = [];
    for (let i = 0; i < sending.length; i += DELIVER_BATCH) {
      const batch = sending.slice(i, i + DELIVER_BATCH);
      results.push(...await Promise.all(batch.map((target) => deliverOne(target, payload, rest).catch((err) => {
        log(`[push] a native notice failed: ${err?.message || err}`);
        return { ok: false, gone: false };
      }))));
    }
    return {
      sent: results.filter((r) => r.ok).length,
      gone: results.filter((r) => r.gone).length,
      failed: results.filter((r) => !r.ok && !r.gone).length,
      ...(reminder ? { skipped: targets.length - sending.length } : {}),
    };
  }

  function close() {
    apnsSender?.close();
    fcmSender?.close();
  }

  return {
    platforms: { ios: Boolean(apnsSender), android: Boolean(fcmSender) },
    targetsOf, targetOfDevice, register, unregister, withTokens, send, deliver, close,
    setReminders, clearReminders, scheduledOn,
  };
}

/* ---------------------------------- routes --------------------------------- */

/**
 * The phone's app registers its token with its device token
 * (`Authorization: Bearer <devices.prefix>…`), never a session:
 *   POST   /api/devices/push       { platform, token, environment?, lang? }
 *   DELETE /api/devices/push
 *   POST   /api/devices/push/test  a test notice to this device
 *   PUT    /api/devices/reminders  { items: [{ module, id, at }] }: the reminders it shows itself
 * A bad device token counts against the address in the devices' bucket, as the
 * other device routes do.
 */
export function registerNativePushApi(router, { devices, nativePush, limiter, texts, appName }) {
  const deviceOf = (ctx) => {
    const brake = limiter.checkFailures('devices', ctx.req);
    if (!brake.allowed) throw new HttpError(429, 'too_many_attempts', { retry_after: brake.retryAfter });
    const device = devices.authenticate(ctx.req);
    if (!device) {
      limiter.noteFailure('devices', ctx.req);
      throw unauthorized();
    }
    return device;
  };

  router.post('/api/devices/push', async (ctx) => {
    const device = deviceOf(ctx);
    const body = await readJson(ctx.req);
    const platform = body.platform;
    if (platform == null) throw badRequest('field_required', { field: 'platform' });
    if (!PLATFORMS.includes(platform)) throw badRequest('field_invalid', { field: 'platform', options: PLATFORMS });
    const token = str(body.token, { field: 'token', max: 1000, min: 1 });
    if (!(platform === 'ios' ? APNS_TOKEN : FCM_TOKEN).test(token)) throw badRequest('field_invalid', { field: 'token' });
    let environment = null;
    if (platform === 'ios') {
      environment = body.environment ?? 'production';
      if (!ENVIRONMENTS.includes(environment)) throw badRequest('field_invalid', { field: 'environment', options: ENVIRONMENTS });
    } else if (body.environment != null && !ENVIRONMENTS.includes(body.environment)) {
      throw badRequest('field_invalid', { field: 'environment', options: ENVIRONMENTS });
    }
    const lang = str(body.lang, { field: 'lang', max: 12, allowNull: true }) || null;
    if (lang && !LANG.test(lang)) throw badRequest('field_invalid', { field: 'lang' });
    nativePush.register(device.device_id, {
      platform, token: platform === 'ios' ? token.toLowerCase() : token, environment, lang,
    });
    sendJson(ctx.res, 200, { ok: true, platform, environment, sending: nativePush.platforms[platform] });
  });

  router.delete('/api/devices/push', (ctx) => {
    const device = deviceOf(ctx);
    nativePush.unregister(device.device_id);
    sendJson(ctx.res, 200, { ok: true });
  });

  /**
   * The reminders this device scheduled as its own notifications, all of them
   * (the next week's, at most MAX_DEVICE_REMINDERS): they replace what it said
   * before, and an empty list clears it. → { ok: true, count }
   */
  router.put('/api/devices/reminders', async (ctx) => {
    const device = deviceOf(ctx);
    const body = await readJson(ctx.req);
    const items = deviceRemindersOf(body?.items);
    sendJson(ctx.res, 200, { ok: true, count: nativePush.setReminders(device.device_id, items) });
  });

  /** A test notice to this device, in the person's language (else the device's). → { sent, gone, failed } */
  router.post('/api/devices/push/test', async (ctx) => {
    const device = deviceOf(ctx);
    const target = nativePush.targetOfDevice(device.device_id);
    if (!target) {
      sendJson(ctx.res, 200, { sent: 0, gone: 0, failed: 0, no_token: true });
      return;
    }
    const result = await nativePush.deliver([target], (t) => {
      const { t: tr } = texts({ headers: { 'accept-language': t.lang || '' } }, device);
      return { title: `✅ ${appName}`, body: tr('push.test'), tag: 'test' };
    });
    sendJson(ctx.res, 200, result);
  });
}
