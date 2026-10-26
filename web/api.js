/**
 * The server's API from the browser: JSON both ways, the session cookie, and
 * three kinds of failure kept apart — no network (Offline), no session
 * (SessionExpired, a 401) and anything else (ApiError, with the code and the
 * details the server sent). `errorMessage()` turns any of them into a
 * sentence in the person's language. A write may carry an Idempotency-Key
 * (`api.write`), so sending it twice does it once.
 *
 * With a weak signal (a phone between cells, a Wi-Fi with no way out) a
 * request may hang for a minute before the browser gives up, and the screen
 * with it. An app may say how long it waits (`setPatience(ms)`): a read, or a
 * write with a key, that takes longer counts as no network. A write without a
 * key and an upload always wait: giving up on them could make one twice, or
 * cut a file half way. Without `setPatience` nothing gives up, as before.
 *
 * Every call also takes options, for the apps whose client does more than
 * this (all of them optional; without them a call behaves as above):
 *   key          the Idempotency-Key (what `api.write` passes)
 *   patience     this call's wait in ms, whatever its method (0: as long as it takes)
 *   signal       an AbortSignal of the app's: aborted, the call counts as no network
 *   text         answer `{ data, text }`, the body's text with what it was read into
 *                (Next draws a view again only when the text changed)
 *   type         the content type of an upload whose file has none
 *   beforeSend({ method, path, body, headers })  just before it goes: may return
 *                changes to those, or throw (an Offline thrown here goes to onNoSignal)
 *   onAnswer(res, request)  once the answer's status and headers are in, before its
 *                body is read (Tasks' clock and signal; a 401 told to the app)
 *   onNoSignal(request)  instead of throwing Offline: what it returns is the answer
 *                (Tasks' queue answers a change made without signal with it drawn)
 * `api.with(options)` gives the same client with those options on every call.
 */
import { t } from './i18n.js';
import { at } from './base.js';

export class ApiError extends Error {
  constructor(status, code, data = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.data = data || {};
  }
}
export class SessionExpired extends ApiError {}
export class Offline extends Error {}

let patience = null;

/** How long a read or a write with a key waits for its answer, in ms; null, as long as it takes. */
export function setPatience(ms) {
  patience = Number.isFinite(ms) && ms > 0 ? ms : null;
}

const gaveUp = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError';

/**
 * The signal a call gives fetch: its patience and the app's own signal, whichever comes first.
 * `done()` once the answer is read whole, so neither outlives it.
 */
function deadline(ms, outer) {
  if (!ms && !outer) return { signal: undefined, done: () => {} };
  const controller = new AbortController();
  const stop = (why) => {
    if (!controller.signal.aborted) controller.abort(why ?? new DOMException('timeout', 'TimeoutError'));
  };
  const timer = ms ? setTimeout(stop, ms) : null;
  const fromOuter = () => stop(outer.reason);
  if (outer?.aborted) fromOuter();
  else outer?.addEventListener?.('abort', fromOuter, { once: true });
  return {
    signal: controller.signal,
    done: () => { clearTimeout(timer); outer?.removeEventListener?.('abort', fromOuter); },
  };
}

async function request(method, path, body, options = {}) {
  const { file = false, key = null, root = false, text = false, type = null, signal: outer = null,
    beforeSend = null, onAnswer = null, onNoSignal = null } = options;
  // A call's own patience counts for any request; the app's, for a read or a keyed write.
  const ms = options.patience !== undefined ? options.patience
    : patience && !file && (method === 'GET' || key) ? patience : null;
  let req = {
    method,
    path,
    body,
    // A file goes as the raw body, as the suite's uploads expect: no multipart.
    headers: {
      ...(file ? { 'Content-Type': body?.type || type || 'application/octet-stream' }
        : body === undefined ? {} : { 'Content-Type': 'application/json' }),
      // The same key twice gets the first answer back (suite-core idempotency.js).
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
  };
  const noSignal = () => {
    if (onNoSignal) return onNoSignal(req);
    throw new Offline();
  };

  if (beforeSend) {
    try {
      const changed = await beforeSend({ ...req, headers: { ...req.headers } });
      if (changed) req = { ...req, ...changed };
    } catch (err) {
      if (err instanceof Offline) return noSignal();
      throw err;
    }
  }

  const wait = deadline(ms, outer);
  let res;
  try {
    // The app's path at its base: the same on its own, under the module's path in a host (base.js).
    res = await fetch(root ? req.path : at(req.path), {
      method: req.method,
      credentials: 'same-origin',
      headers: req.headers,
      body: file ? req.body : req.body === undefined ? undefined : JSON.stringify(req.body),
      ...(wait.signal ? { signal: wait.signal } : {}),
    });
  } catch {
    wait.done();
    return noSignal();
  }
  if (onAnswer) {
    try { await onAnswer(res, req); } catch (err) { wait.done(); throw err; }
  }
  // The answer's body may be what is slow: cut half way, it is no network too, never an empty answer.
  let cut = false;
  let raw = null;
  let data;
  if (text) {
    raw = await res.text().catch((err) => { cut = gaveUp(err); return ''; });
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  } else {
    data = await res.json().catch((err) => { cut = gaveUp(err); return null; });
  }
  wait.done();
  if (cut) return noSignal();
  if (res.ok) return text ? { data, text: raw } : data;
  const code = data?.error || 'generic';
  if (res.status === 401) throw new SessionExpired(401, code, data);
  throw new ApiError(res.status, code, data);
}

/** The client, with `defaults` under every call's options. */
function client(defaults = {}) {
  const call = (method, path, body, options) => request(method, path, body, { ...defaults, ...options });
  return {
    get: (path, options) => call('GET', path, undefined, options),
    post: (path, body = {}, options) => call('POST', path, body, options),
    put: (path, body = {}, options) => call('PUT', path, body, options),
    patch: (path, body = {}, options) => call('PATCH', path, body, options),
    /** A body only when one is given: most deletes have none. */
    delete: (path, body, options) => call('DELETE', path, body, options),
    /** Sends a File or Blob as the body of a POST. */
    upload: (path, file, options) => call('POST', path, file, { ...options, file: true }),
    /** A write that may be sent again (the outbox): `key` makes the server do it once. */
    write: (method, path, body, options = {}) => call(method, path, body ?? undefined, options),
    /** Any call, with every option: what the shortcuts above are made of. */
    request: (method, path, body, options) => call(method, path, body, options),
    /** The same client with these options on every call (a call's own still win). */
    with: (more) => client({ ...defaults, ...more }),
    /** The same, at the site's root and not the app's base: a host's own routes, from a module's page. */
    root: {
      get: (path) => call('GET', path, undefined, { root: true }),
      post: (path, body = {}) => call('POST', path, body, { root: true }),
      delete: (path) => call('DELETE', path, undefined, { root: true }),
    },
  };
}

export const api = client();

/** What went wrong, as a sentence: errors.<code>, with the field named in the language. */
export function errorMessage(err) {
  if (err instanceof Offline) return t('errors.offline');
  const data = { ...(err?.data || {}) };
  if (data.field) data.field = t(`fields.${data.field}`);
  const code = err?.code || 'generic';
  const sentence = t(`errors.${code}`, data);
  return sentence === `errors.${code}` ? t('errors.generic') : sentence;
}
