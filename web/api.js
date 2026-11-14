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
 *
 * A plan's barrier (a 402) met by any call is kept for a moment by its sentence: the notice that
 * then says it (ui.js `toast`, whichever module shows it) carries «Ver planes», which opens what
 * `setPlanOpener` was given (createShell: Settings › Plan). Without an opener, the words alone.
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
  // A 413 without the server's code is what stands before it (Cloudflare cuts a request over
  // 100 MB with a page of its own): too big, said as such rather than as a failure (audit prod-14).
  const code = data?.error || (res.status === 413 ? 'upload_too_large' : 'generic');
  if (res.status === 401) throw new SessionExpired(401, code, data);
  const error = new ApiError(res.status, code, data);
  // How long the server (or whatever stands before it) asks to wait, when it says (a 429, a 503).
  const after = retryAfterMs(res.headers?.get?.('Retry-After'));
  if (after != null) error.retryAfter = after;
  if (res.status === 402) barrier = { text: errorMessage(error), at: Date.now() };
  throw error;
}

/**
 * A Retry-After header in ms: seconds, or an HTTP date (RFC 9110 §10.2.3). null when there is none
 * or it says nothing usable.
 */
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/* ------------------- a plan's barrier, and the way to the plans ------------------- */

/** How long a barrier met waits for the notice that says it. */
const BARRIER_MS = 10000;
let barrier = null;
let planOpener = null;

/**
 * What opens the plans from a notice of a barrier (createShell: Settings › Plan); null takes it
 * away, only if it is still `replacing` when that is given (a shell let go after another came).
 */
export function setPlanOpener(open, { replacing } = {}) {
  if (replacing !== undefined && planOpener !== replacing) return;
  planOpener = typeof open === 'function' ? open : null;
}

/**
 * The button for a notice that says the barrier just met, once: `{ label, onClick }`, or null for
 * any other words, a barrier said already or long ago, and without an opener.
 */
export function planAction(text) {
  if (!planOpener || !barrier || barrier.text !== text || Date.now() - barrier.at > BARRIER_MS) return null;
  barrier = null;
  const open = planOpener;
  return {
    label: t('kit.plan.see'),
    onClick: () => {
      // The form that met the barrier is modal: Settings would open behind it, out of sight. It
      // closes first; what it held couldn't be saved anyway.
      for (const dialog of globalThis.document?.querySelectorAll?.('dialog') || []) if (dialog.open) dialog.close();
      open();
    },
  };
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
      put: (path, body = {}) => call('PUT', path, body, { root: true }),
      patch: (path, body = {}) => call('PATCH', path, body, { root: true }),
      delete: (path) => call('DELETE', path, undefined, { root: true }),
    },
  };
}

export const api = client();

/** What a plan's limit counts, by its feature: as Settings › Usage names it (`kit.usage.counted.*`). */
const COUNTED = Object.freeze({ 'lists.max': 'lists', 'projects.max': 'projects', 'notebooks.max': 'notebooks' });

/** What went wrong, as a sentence: errors.<code>, with the field named in the language. */
export function errorMessage(err) {
  if (err instanceof Offline) return t('errors.offline');
  const data = { ...(err?.data || {}) };
  if (data.field) data.field = t(`fields.${data.field}`);
  // A plan's limit says what it limits: «permite 20 listas», «50 MB de espacio», not a bare number.
  if (err?.code === 'plan_limit' && data.limit != null) {
    const counted = COUNTED[data.feature];
    if (counted && Number.isFinite(Number(data.limit))) data.limit = t(`kit.usage.counted.${counted}`, { n: Number(data.limit) });
    else if (data.feature === 'storage.mb') data.limit = t('kit.usage.counted.storage', { size: data.limit });
  }
  const code = err?.code || 'generic';
  const sentence = t(`errors.${code}`, data);
  return sentence === `errors.${code}` ? t('errors.generic') : sentence;
}
