/**
 * Web Push with no dependencies (from Tasks): notifications that reach a
 * phone or a desktop even with the app closed.
 *
 *   · RFC 8291 — the message encrypted for each device (ECDH + HKDF + AES-128-GCM)
 *   · RFC 8188 — the "aes128gcm" body
 *   · RFC 8292 — the VAPID signature (an ES256 JWT) that says which server sends
 *
 * Node has every cryptographic piece, so nothing is installed.
 *
 * The VAPID keys are the install's: from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
 * when they are set (as Tasks always had them), otherwise generated on the
 * first start and kept in the database (`app_meta`). A device's subscription
 * is tied to the public key: changing it silently kills every subscription.
 *
 * One subscription per device, with its language; the ones a push service
 * says are gone (404, 410), or that fail three times in a row, are dropped.
 * What each notice says, and to whom, is the app's (Tasks batches other
 * people's changes to a shared list); the suite sends it.
 *
 * A device can also belong to the app rather than to a person: a child's
 * tablet paired to a profile with no account (Focus), a kiosk. Those
 * subscriptions live in the app's own table, next to the rest of what it
 * knows of the device; the suite checks one before the app keeps it
 * (checkSubscription) and sends to it (sendToSubscription), with the same
 * keys, encryption and signature as a person's, and says when it is gone.
 */
import crypto from 'node:crypto';
import { ensureColumn } from './migrate.js';
import { badRequest } from './http.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (text) => Buffer.from(String(text), 'base64url');

/** Devices one person may have subscribed: more than anyone uses, few enough that a sweep stays short. */
export const MAX_DEVICES = 10;
/** Push services answer in well under a second; one that doesn't in this long is treated as down. */
const SEND_TIMEOUT_MS = 10000;
/** Subscriptions encrypted and sent at once by deliver(). */
const DELIVER_BATCH = 20;
/** The longest endpoint taken: push services' are a few hundred characters, and /api/push/subscribe always capped it here. */
const MAX_ENDPOINT = 1000;
/**
 * RFC 8030 §5.4: at most 32 characters of the URL-safe base64 alphabet. A push
 * service keeps only the newest undelivered message of a topic, so a launch
 * sent again replaces the one still waiting instead of arriving twice.
 */
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;
/**
 * The longest notice, in bytes of its JSON or text. Push services take a
 * body of 4096 bytes (RFC 8030 §7.2), and ours carries 86 of header (salt,
 * record size, key length, our 65-byte key), the 0x02 that ends the record
 * and 16 of GCM tag: 4096 − 86 − 1 − 16. Past it a push service answers 413,
 * which said nothing of the device but was counted against it.
 */
export const MAX_PAYLOAD = 3993;

/** A topic the app wrote wrong is its mistake, the same for every device: a TypeError, never a device's failure. */
function checkTopic(topic) {
  if (topic != null && !TOPIC.test(String(topic))) {
    throw new TypeError('push topic: 1 to 32 characters of A-Z, a-z, 0-9, - and _ (RFC 8030)');
  }
}

/** Tasks' table, which is the suite's shape: its subscriptions survive the move. */
export function pushSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    label       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_ok_at  TEXT,
    failures    INTEGER NOT NULL DEFAULT 0
  )`);
  // The device's language, for the app to write each notice in it.
  ensureColumn(d, 'push_subscriptions', 'lang', 'lang TEXT');
  d.exec('CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id)');
}

/* ------------------------------ keys and points ------------------------------ */

/** A VAPID key pair (P-256) in the format browsers take (applicationServerKey). */
export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  return {
    // The uncompressed point: 0x04 || X || Y.
    publicKey: b64url(Buffer.concat([Buffer.from([4]), fromB64url(pub.x), fromB64url(pub.y)])),
    privateKey: priv.d,
  };
}

const publicKeyFromPoint = (point) => crypto.createPublicKey({
  key: { kty: 'EC', crv: 'P-256', x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33, 65)) },
  format: 'jwk',
});
const privateKeyFromD = (d, point) => crypto.createPrivateKey({
  key: { kty: 'EC', crv: 'P-256', d, x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33, 65)) },
  format: 'jwk',
});

/** What is wrong with a pair of VAPID keys, or null. */
export function vapidKeyErrors({ publicKey, privateKey }) {
  const point = fromB64url(publicKey || '');
  if (point.length !== 65 || point[0] !== 4) return 'VAPID_PUBLIC_KEY is not a P-256 public key (65 bytes, base64url)';
  const scalar = fromB64url(privateKey || '');
  if (scalar.length !== 32) return 'VAPID_PRIVATE_KEY is not a P-256 private key (32 bytes, base64url)';
  // The public point the private key makes must be the one given (Node doesn't check it).
  try {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(scalar);
    if (!ecdh.getPublicKey().equals(point)) return 'VAPID_PRIVATE_KEY does not go with VAPID_PUBLIC_KEY';
  } catch {
    return 'VAPID_PRIVATE_KEY is not a P-256 private key (32 bytes, base64url)';
  }
  return null;
}

/**
 * The install's keys: from the environment when set, else the database's,
 * generated on the first start.
 */
export function vapidKeys(database, { publicKey = null, privateKey = null, subject } = {}, { log = console.log } = {}) {
  if (publicKey && privateKey) return { publicKey, privateKey, subject, source: 'environment' };
  let stored = null;
  try { stored = JSON.parse(database.getMeta('vapid_keys') || 'null'); } catch { stored = null; }
  if (!stored?.publicKey || !stored?.privateKey || vapidKeyErrors(stored)) {
    stored = generateVapidKeys();
    database.setMeta('vapid_keys', JSON.stringify(stored));
    log('[push] VAPID keys were not set: generated them and stored them in the database.');
  }
  return { ...stored, subject, source: 'database' };
}

/* ------------------------------ encryption (RFC 8291) ------------------------------ */

/**
 * The message encrypted for one subscription: the body to send with
 * `Content-Encoding: aes128gcm`.
 * @param {string} p256dh  the browser's public key (base64url)
 * @param {string} auth    the subscription's authentication secret (base64url)
 */
export function encryptPayload(p256dh, auth, payload) {
  const uaPublic = fromB64url(p256dh);          // 65 bytes
  const authSecret = fromB64url(auth);          // 16 bytes
  if (uaPublic.length !== 65) throw new Error('the subscription’s p256dh key is not valid');

  // An ephemeral pair of our own, new for every message.
  const ephemeral = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ephemeralJwk = ephemeral.publicKey.export({ format: 'jwk' });
  const asPublic = Buffer.concat([Buffer.from([4]), fromB64url(ephemeralJwk.x), fromB64url(ephemeralJwk.y)]);

  const ecdhSecret = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKeyFromPoint(uaPublic) });
  const salt = crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  // One record: its padding ends with 0x02 ("last record").
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  // The aes128gcm header: salt | record size | key length and key.
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, encrypted]);
}

/** Reads an aes128gcm body with the device's keys: for tests, to check what is sent can be read. */
export function decryptPayload(body, subscriberPrivateD, subscriberPublicPoint, authSecretB64) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const encrypted = body.subarray(21 + idlen);
  const uaPublic = fromB64url(subscriberPublicPoint);
  const ecdhSecret = crypto.diffieHellman({
    privateKey: privateKeyFromD(subscriberPrivateD, uaPublic), publicKey: publicKeyFromPoint(asPublic),
  });
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, fromB64url(authSecretB64), keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
  const plain = Buffer.concat([decipher.update(encrypted.subarray(0, encrypted.length - 16)), decipher.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  return plain.subarray(0, end);            // without the 0x02
}

/* ------------------------------ where it may go ------------------------------ */

/** Names that only exist inside a network. */
const HOME_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home|home\.arpa)$/i;

/**
 * The browsers' push services: Chrome, Edge's Chromium, Opera, Brave and
 * Samsung go through Google; Firefox through Mozilla; Safari through Apple;
 * the old Edge through Windows. Anything else is no push service, and a name
 * that only looks public can point inside the network (DNS can say anything).
 */
const PUSH_SERVICES = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/i;

/**
 * A push endpoint is a URL the SERVER visits, and whoever subscribes chooses
 * it. Checking only that it starts with https:// let anyone with an account
 * point it at the router, an internal panel or a service that only answers
 * from inside, and use this server as the messenger to reach it.
 *
 * What the URL itself says is checked, without resolving names: real push
 * services —Google, Mozilla, Apple, Microsoft— are ordinary domain names on
 * port 443. No IP literals, no odd ports, no names of a home network.
 * Throws `field_invalid` (field endpoint) with the reason.
 */
export function checkEndpoint(endpoint) {
  const refuse = (reason) => badRequest('field_invalid', { field: 'endpoint', reason });
  let url;
  try { url = new URL(endpoint); } catch { throw refuse('not_a_url'); }
  if (url.protocol !== 'https:') throw refuse('not_https');
  if (url.port && url.port !== '443') throw refuse('port');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // An IP literal is never a push service, and it is the direct way to aim inside the network.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) throw refuse('ip_address');
  if (HOME_NAMES.test(host)) throw refuse('local_name');
  if (!PUSH_SERVICES.test(host)) throw refuse('push_service');
}

/**
 * The browser's keys in the shape RFC 8291 gives them (cheap: nothing is
 * computed): an uncompressed P-256 point (0x04 and 65 bytes; its first byte
 * goes into the key derivation, so another one makes every message unreadable)
 * and a 16-byte secret. → both written again in base64url: the decoder skips
 * what isn't base64, and a stray character or padding must not reach a table.
 * Only what subscribes or is sent through sendToSubscription() is checked so:
 * rows already stored are sent as they are.
 */
function keysOf(p256dh, auth) {
  const point = typeof p256dh === 'string' ? fromB64url(p256dh) : null;
  if (!point || point.length !== 65 || point[0] !== 4) throw badRequest('field_invalid', { field: 'p256dh' });
  const secret = typeof auth === 'string' ? fromB64url(auth) : null;
  if (!secret || secret.length !== 16) throw badRequest('field_invalid', { field: 'auth' });
  return { p256dh: b64url(point), auth: b64url(secret) };
}

/**
 * Keys something can be encrypted for. 65 bytes is not yet a key: a point off
 * the curve would make every message to it fail. A browser's key always works,
 * so trying once settles it. → the keys as keysOf() writes them.
 */
function checkKeys(p256dh, auth) {
  const keys = keysOf(p256dh, auth);
  try { encryptPayload(keys.p256dh, keys.auth, Buffer.alloc(0)); } catch { throw badRequest('field_invalid', { field: 'p256dh' }); }
  return keys;
}

/**
 * A subscription as an app has it, in either shape: the browser's
 * `subscription.toJSON()` (`{ endpoint, keys: { p256dh, auth } }`) or the flat
 * `{ endpoint, p256dh, auth }` of a stored row. Its endpoint is checked as a
 * person's is (checkEndpoint), because whoever holds the device chose it and
 * the server is about to visit it. → `{ endpoint, p256dh, auth }`.
 */
function subscriptionOf(subscription) {
  // Missing is `field_required`, as str() says it (http.js); present but wrong, `field_invalid`.
  if (subscription == null) throw badRequest('field_required', { field: 'subscription' });
  if (typeof subscription !== 'object' || Array.isArray(subscription)) throw badRequest('field_invalid', { field: 'subscription' });
  const { endpoint } = subscription;
  if (endpoint == null || endpoint === '') throw badRequest('field_required', { field: 'endpoint' });
  if (typeof endpoint !== 'string') throw badRequest('field_invalid', { field: 'endpoint', reason: 'not_a_url' });
  if (endpoint.length > MAX_ENDPOINT) throw badRequest('field_too_long', { field: 'endpoint', max: MAX_ENDPOINT });
  checkEndpoint(endpoint);
  const keys = subscription.keys && typeof subscription.keys === 'object' ? subscription.keys : subscription;
  return { endpoint, ...keysOf(keys.p256dh, keys.auth) };
}

/**
 * A browser's push subscription for a device the app keeps itself (one with
 * no account behind it), checked before the app stores it: an endpoint of a
 * real push service, an uncompressed point on the curve and a 16-byte secret.
 * The app's route calls it with what the device posted; what it throws is a
 * coded 400 (`field_invalid` with `field` subscription, endpoint —and its
 * `reason`—, p256dh or auth; `field_too_long` for an endpoint over 1000
 * characters).
 * → `{ endpoint, keys: { p256dh, auth } }`: what to keep, in the browser's own
 * shape, the keys in plain base64url (anything else it sent, such as
 * `expirationTime`, is left out).
 */
export function checkSubscription(subscription) {
  const { endpoint, p256dh, auth } = subscriptionOf(subscription);
  return { endpoint, keys: checkKeys(p256dh, auth) };
}

/* ------------------------------ the service ------------------------------ */

/**
 * @param {object} options
 * @param {object} options.database
 * @param {{publicKey, privateKey, subject}} options.vapid   from vapidKeys()
 * @param {Function} [options.fetch]
 * @param {Function} [options.log]
 * @param {object} [options.native]  native-push.js, with `push.native`: the same sends also reach
 *   the person's phones through APNs and FCM. Without it everything here is Web Push only.
 *
 * `send`, `deliver` and `sendTo` take `reminder: { id, at, module? }` among
 * their options, for a reminder's notice: with `push.native`, a phone whose app
 * said it shows that reminder itself (`PUT /api/devices/reminders`) is skipped,
 * and `deliver` adds how many to its answer (`skipped`). Web Push never is.
 */
export function createPush({
  database, vapid, fetch = globalThis.fetch, log = console.error, clock = () => Date.now(), native = null,
}) {
  const publicPoint = fromB64url(vapid.publicKey);
  const signingKey = privateKeyFromD(vapid.privateKey, publicPoint);

  /** The Authorization header for a device's push service. */
  function vapidHeader(endpoint) {
    const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64url(JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(clock() / 1000) + 12 * 3600,
      sub: vapid.subject,
    }));
    const signed = `${header}.${claims}`;
    // JOSE wants r||s, not DER.
    const signature = crypto.sign('sha256', Buffer.from(signed), { key: signingKey, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${signed}.${b64url(signature)}, k=${vapid.publicKey}`;
  }

  /**
   * Sends one notice to one subscription. → { ok, status, gone }: `gone`
   * means the browser no longer has it, and it should be dropped.
   * `topic` (optional, RFC 8030): a newer notice of the same topic replaces
   * one the push service still holds for a device that is offline. A notice
   * over MAX_PAYLOAD bytes is refused with a TypeError before anything is sent.
   */
  async function send(subscription, payload, { ttl = 3600, urgency = 'normal', topic = null, reminder = null } = {}) {
    // A phone's native token (push.native), among what subscriptionsOf() gave: APNs or FCM.
    if (native && subscription?.native) {
      checkTopic(topic);
      return native.send(subscription, payload, { ttl, urgency, topic, ...(reminder != null ? { reminder } : {}) });
    }
    // Outside the try: a payload or a topic that can't be written is the app's mistake, not the device's.
    checkTopic(topic);
    const plain = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
    if (plain.length > MAX_PAYLOAD) {
      throw new TypeError(`push payload: ${plain.length} bytes, more than the ${MAX_PAYLOAD} a push service takes`);
    }
    let body;
    try {
      body = encryptPayload(subscription.p256dh, subscription.auth, plain);
    } catch (err) {
      // Keys nothing can be encrypted for (stored before subscribe() checked them):
      // no message will ever reach that device, so it goes like a gone one.
      return { ok: false, status: 0, gone: true, reason: err.message };
    }
    let res;
    try {
      res = await fetch(subscription.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapidHeader(subscription.endpoint),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(ttl),
          Urgency: urgency,
          ...(topic != null ? { Topic: String(topic) } : {}),
        },
        body,
        // No push service redirects: following one would let an endpoint chosen by
        // a user send our requests to an address inside the network.
        redirect: 'error',
        // One that accepts the connection and never answers would hold a sweep for minutes.
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, status: 0, gone: false, reason: err.message };
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
  }

  /** A refusal about the subscription itself (bad request, keys, size): three in a row and it goes. */
  const rejected = (status) => status >= 400 && status < 500 && status !== 408 && status !== 429;

  async function deliverOne(sub, payload, options) {
    const res = await send(sub, typeof payload === 'function' ? payload(sub) : payload, options);
    if (res.gone) {
      database.run('DELETE FROM push_subscriptions WHERE id = ?', sub.id);
    } else if (res.ok) {
      database.run("UPDATE push_subscriptions SET last_ok_at = datetime('now'), failures = 0 WHERE id = ?", sub.id);
    } else if (rejected(res.status)) {
      database.run('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?', sub.id);
      database.run('DELETE FROM push_subscriptions WHERE id = ? AND failures >= 3', sub.id);
      log(`[push] a notice was refused (${res.status})`);
    } else {
      // The network, a 429 or the push service down: nothing about this device.
      // Counted, an outage of a few minutes dropped every device of everyone.
      log(`[push] a notice could not be sent for now (${res.status || res.reason})`);
    }
    return res;
  }

  /**
   * Sends to several subscriptions and keeps the table clean: a gone one is
   * dropped, a good one noted, and one that fails three times in a row is
   * dropped too. `payload` may be a function of the subscription (its
   * language). A few at a time: each one's encryption is synchronous work, and
   * thousands in one go would hold the server for everyone. Never rejects for
   * a device: one device's problem is not the others' (a notice that can't be
   * written counts as failed, and nobody loses a device for it). A `topic`
   * written wrong is the same mistake for every device, so it rejects with a
   * TypeError before anything is sent. → { sent, gone, failed }
   */
  async function deliverWeb(subscriptions, payload, options = {}) {
    checkTopic(options.topic);
    const results = [];
    for (let i = 0; i < subscriptions.length; i += DELIVER_BATCH) {
      const batch = subscriptions.slice(i, i + DELIVER_BATCH);
      results.push(...await Promise.all(batch.map((sub) => deliverOne(sub, payload, options).catch((err) => {
        log(`[push] a notice failed: ${err?.message || err}`);
        return { ok: false, status: 0, gone: false, reason: err?.message };
      }))));
    }
    return {
      sent: results.filter((r) => r.ok).length,
      gone: results.filter((r) => r.gone).length,
      failed: results.filter((r) => !r.ok && !r.gone).length,
    };
  }

  /**
   * With `push.native`, the same delivery reaches phones: the native targets
   * in the list (subscriptionsOf() gives them, `native: true`) and those of
   * every person whose Web Push subscriptions are in it, for an app that reads
   * `push_subscriptions` itself. Each target once per delivery.
   */
  async function deliver(subscriptions, payload, options = {}) {
    if (!native) return deliverWeb(subscriptions, payload, options);
    checkTopic(options.topic);
    const web = subscriptions.filter((sub) => !sub?.native);
    const phones = subscriptions.filter((sub) => sub?.native);
    const listed = new Set(phones.map((target) => target.id));
    const people = web.map((sub) => sub?.user_id).filter((id) => id != null);
    for (const target of people.length ? native.targetsOf(people) : []) {
      if (!listed.has(target.id)) {
        listed.add(target.id);
        phones.push(target);
      }
    }
    const [a, b] = await Promise.all([
      deliverWeb(web, payload, options),
      native.deliver(phones, payload, options).catch((err) => {
        log(`[push] native notices failed: ${err?.message || err}`);
        return { sent: 0, gone: 0, failed: phones.length };
      }),
    ]);
    return {
      sent: a.sent + b.sent, gone: a.gone + b.gone, failed: a.failed + b.failed,
      // Phones that show this reminder themselves, when the send named one (`options.reminder`).
      ...(b.skipped != null ? { skipped: b.skipped } : {}),
    };
  }

  /**
   * The subscriptions of some people (every device of each). With
   * `push.native`, their phones' native tokens too, marked `native: true`.
   */
  function subscriptionsOf(userIds) {
    const ids = [...new Set([...userIds].map(Number))];
    if (!ids.length) return [];
    const rows = database.all(`SELECT * FROM push_subscriptions WHERE user_id IN (${ids.map(() => '?').join(', ')})`, ...ids);
    return native ? [...rows, ...native.targetsOf(ids)] : rows;
  }

  /**
   * Registers (or updates) the device that just gave permission.
   * → how many devices the person has now.
   */
  function subscribe(userId, { endpoint, p256dh, auth, label = null, lang = null }) {
    checkEndpoint(endpoint);
    const keys = checkKeys(p256dh, auth);
    database.tx(() => {
      database.run(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, label, lang)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
          auth = excluded.auth, label = excluded.label, lang = excluded.lang, failures = 0,
          created_at = datetime('now')`,
      userId, endpoint, keys.p256dh, keys.auth, label ? String(label).slice(0, 80) : null, lang ? String(lang).slice(0, 12) : null);
      // A person has a few devices, not thousands: past the ceiling the ones that have gone
      // longest without being used go (subscribing again counts as use), never the one that just said yes.
      database.run(`DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (
          SELECT id FROM push_subscriptions WHERE user_id = ?
          ORDER BY endpoint = ? DESC, max(coalesce(last_ok_at, created_at), created_at) DESC, id DESC LIMIT ?)`,
      userId, userId, endpoint, MAX_DEVICES);
    });
    return Number(database.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', userId).n);
  }

  /** Forgets a device of a person, or all of them without `endpoint`. */
  function unsubscribe(userId, endpoint = null) {
    return endpoint
      ? database.run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', userId, endpoint).changes
      : database.run('DELETE FROM push_subscriptions WHERE user_id = ?', userId).changes;
  }

  /** A person's devices, for Settings: never the keys. */
  const devices = (userId) => database.all(`SELECT id, label, lang, created_at, last_ok_at, failures,
      substr(endpoint, 1, 40) AS endpoint_hint
    FROM push_subscriptions WHERE user_id = ? ORDER BY created_at`, userId);

  /**
   * Sends one notice to a subscription the app keeps itself, for a device
   * with no account behind it (Focus' paired tablets): the browser's
   * `subscription.toJSON()` as checkSubscription() returned it (the flat
   * `{ endpoint, p256dh, auth }` of a row is taken too). The same encryption,
   * VAPID signature, time limit and options as a person's (`ttl` in seconds,
   * 3600; `urgency`, 'normal'; `topic`), and nothing is written here: the
   * table is the app's.
   * → `{ ok, status, gone, reason? }`. Only `gone` (the push service answered
   * 404 or 410, or its keys can't be encrypted for) says the browser no longer
   * has it: the app drops it. Any other failure keeps it, with its `status` for
   * the log: the network, a 429 or the service down say nothing of the device,
   * and a 4xx can be ours rather than the device's (a 403 when the install's
   * VAPID keys aren't the ones it subscribed with). A notice over MAX_PAYLOAD
   * bytes or a topic written wrong rejects with a TypeError, and what isn't a
   * subscription with the coded 400 of checkSubscription(), before anything is
   * sent: the endpoint is checked again here, so a row kept without checking
   * never makes the server visit an address inside the network.
   */
  async function sendToSubscription(subscription, payload, options = {}) {
    return send(subscriptionOf(subscription), payload, options);
  }

  return {
    publicKey: vapid.publicKey,
    send, deliver, subscriptionsOf, subscribe, unsubscribe, devices,
    /** Sends to every device of some people. */
    sendTo: (userIds, payload, options) => deliver(subscriptionsOf(userIds), payload, options),
    checkSubscription, sendToSubscription,
  };
}
