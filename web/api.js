/**
 * The server's API from the browser: JSON both ways, the session cookie, and
 * three kinds of failure kept apart — no network (Offline), no session
 * (SessionExpired, a 401) and anything else (ApiError, with the code and the
 * details the server sent). `errorMessage()` turns any of them into a
 * sentence in the person's language. A write may carry an Idempotency-Key
 * (`api.write`), so sending it twice does it once.
 */
import { t } from './i18n.js';

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

async function request(method, path, body, { file = false, key = null } = {}) {
  let res;
  try {
    res = await fetch(path, {
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
    });
  } catch {
    throw new Offline();
  }
  const data = await res.json().catch(() => null);
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
  delete: (path) => request('DELETE', path),
  /** Sends a File or Blob as the body of a POST. */
  upload: (path, file) => request('POST', path, file, { file: true }),
  /** A write that may be sent again (the outbox): `key` makes the server do it once. */
  write: (method, path, body, { key = null } = {}) => request(method, path, body ?? undefined, { key }),
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
