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

async function request(method, path, body, { file = false, key = null, root = false } = {}) {
  const patient = patience && !file && (method === 'GET' || key) && typeof AbortSignal?.timeout === 'function';
  const signal = patient ? AbortSignal.timeout(patience) : undefined;
  let res;
  try {
    // The app's path at its base: the same on its own, under the module's path in a host (base.js).
    res = await fetch(root ? path : at(path), {
      method,
      credentials: 'same-origin',
      // A file goes as the raw body, as the suite's uploads expect: no multipart.
      headers: {
        ...(file ? { 'Content-Type': body.type || 'application/octet-stream' }
          : body === undefined ? {} : { 'Content-Type': 'application/json' }),
        // The same key twice gets the first answer back (suite-core idempotency.js).
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: file ? body : body === undefined ? undefined : JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new Offline();
  }
  // The answer's body may be what is slow: cut half way, it is no network too, never an empty answer.
  let cut = false;
  const data = await res.json().catch((err) => { cut = gaveUp(err); return null; });
  if (cut) throw new Offline();
  if (res.ok) return data;
  const code = data?.error || 'generic';
  if (res.status === 401) throw new SessionExpired(401, code, data);
  throw new ApiError(res.status, code, data);
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  put: (path, body = {}) => request('PUT', path, body),
  patch: (path, body = {}) => request('PATCH', path, body),
  /** A body only when one is given: most deletes have none. */
  delete: (path, body) => request('DELETE', path, body),
  /** Sends a File or Blob as the body of a POST. */
  upload: (path, file) => request('POST', path, file, { file: true }),
  /** A write that may be sent again (the outbox): `key` makes the server do it once. */
  write: (method, path, body, { key = null } = {}) => request(method, path, body ?? undefined, { key }),
  /** The same, at the site's root and not the app's base: a host's own routes, from a module's page. */
  root: {
    get: (path) => request('GET', path, undefined, { root: true }),
    post: (path, body = {}) => request('POST', path, body, { root: true }),
    delete: (path) => request('DELETE', path, undefined, { root: true }),
  },
};

/** What went wrong, as a sentence: errors.<code>, with the field named in the language. */
export function errorMessage(err) {
  if (err instanceof Offline) return t('errors.offline');
  const data = { ...(err?.data || {}) };
  if (data.field) data.field = t(`fields.${data.field}`);
  const code = err?.code || 'generic';
  const sentence = t(`errors.${code}`, data);
  return sentence === `errors.${code}` ? t('errors.generic') : sentence;
}
