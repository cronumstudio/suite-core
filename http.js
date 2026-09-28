/**
 * The HTTP layer every app of the suite shares: errors as codes, the router,
 * reading requests, cookies, static files, security headers and the check
 * against cross-site requests.
 *
 * Built on `node:http` alone. Errors carry a code, never a sentence
 * (`field_too_long`, `plan_limit`…): the interface ships in several languages
 * and the browser is the one that says it in each person's, from its catalogs.
 */
import fs from 'node:fs';
import path from 'node:path';

/* --------------------------------- errors --------------------------------- */

/**
 * An error with an HTTP status, turned into `{ error: code, ...extra }` by the
 * app's error handler. `headers` go on the response (Retry-After, Allow…).
 */
export class HttpError extends Error {
  constructor(status, code, extra = {}, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}
export const badRequest = (code = 'bad_request', extra) => new HttpError(400, code, extra);
export const unauthorized = (code = 'unauthorized') => new HttpError(401, code);
export const forbidden = (code = 'forbidden') => new HttpError(403, code);
export const notFound = (code = 'not_found') => new HttpError(404, code);
export const conflict = (code = 'conflict', extra) => new HttpError(409, code, extra);

/* --------------------------------- output --------------------------------- */

export function sendJson(res, status, data, headers = {}) {
  const body = status === 204 ? '' : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(text);
}

/** The response for an error: HttpError as its code; anything else as `internal`. */
export function sendError(res, error) {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.code, ...error.extra }, error.headers);
    return;
  }
  sendJson(res, 500, { error: 'internal' });
}

/* --------------------------------- input ---------------------------------- */

export const MAX_BODY = 1024 * 1024;

/** The raw body, refusing more than `limit` bytes with 413 `body_too_large`. */
export function readBody(req, { limit = MAX_BODY } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        if (!tooLarge) {
          tooLarge = true;
          chunks.length = 0;
          reject(new HttpError(413, 'body_too_large'));
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

/**
 * A JSON object from the body; an empty body is `{}`. With `requireType`
 * (the default) the request must say `Content-Type: application/json`: a
 * cross-site form can't, which is one more wall against CSRF. Arrays are
 * refused unless `allowArray` (JSON-RPC batches).
 */
export async function readJson(req, { limit = MAX_BODY, requireType = true, allowArray = false } = {}) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const raw = await readBody(req, { limit });
  if (!raw.length) return {};
  if (requireType && type !== 'application/json') throw new HttpError(415, 'unsupported_media_type');
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw badRequest('invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || (Array.isArray(parsed) && !allowArray)) throw badRequest('invalid_json');
  return parsed;
}

/**
 * How many proxies in front of the app are trusted: TRUST_PROXY=true is one
 * (the NAS or VPS reverse proxy), a number says how many (Cloudflare in front
 * of it makes two); empty or false, none.
 */
export function proxyHops(value) {
  if (value === true) return 1;
  if (value == null || value === false) return 0;
  const text = String(value).trim().toLowerCase();
  if (text === 'true') return 1;
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * The client's address. `X-Forwarded-For` is only believed as far as the
 * trusted proxies go: each one appends the address it saw, so the real client
 * is the entry that many places from the end. The first entry is whatever the
 * client chose to send — believing it would let anyone pick their address and
 * walk around the brute-force brake.
 */
export function clientIp(req, { trustProxy = process.env.TRUST_PROXY } = {}) {
  // Without a request (a script run by whoever runs the install) there is no address.
  if (!req) return '';
  const hops = proxyHops(trustProxy);
  if (hops) {
    const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (chain.length) return chain[Math.max(0, chain.length - hops)];
  }
  return req.socket?.remoteAddress || '';
}

/* -------------------------------- cookies --------------------------------- */

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch { /* a malformed one is skipped */ }
  }
  return out;
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  parts.push(`Path=${options.path || '/'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Adds a header value without replacing the ones already set (several Set-Cookie). */
export function appendHeader(res, name, value) {
  const previous = res.getHeader(name);
  if (previous == null) res.setHeader(name, value);
  else res.setHeader(name, Array.isArray(previous) ? [...previous, value] : [previous, value]);
}

/* --------------------------------- router --------------------------------- */

/**
 * Routes by method and path pattern (`/api/lists/:id`). `match` answers the
 * handler and its params, `{ methodMismatch, allow }` when the path exists
 * with other methods (405 with `Allow`), or null.
 */
export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    routes.push({ method: method.toUpperCase(), segments: pattern.split('/').filter(Boolean), handler });
  };
  return {
    add,
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    put: (pattern, handler) => add('PUT', pattern, handler),
    patch: (pattern, handler) => add('PATCH', pattern, handler),
    delete: (pattern, handler) => add('DELETE', pattern, handler),
    match(method, pathname) {
      const parts = pathname.split('/').filter(Boolean);
      const wanted = method === 'HEAD' ? 'GET' : method;
      const allow = new Set();
      for (const route of routes) {
        if (route.segments.length !== parts.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < parts.length && ok; i++) {
          const segment = route.segments[i];
          if (segment.startsWith(':')) {
            try { params[segment.slice(1)] = decodeURIComponent(parts[i]); } catch { ok = false; }
          } else if (segment !== parts[i]) ok = false;
        }
        if (!ok) continue;
        if (route.method !== wanted) { allow.add(route.method); continue; }
        return { handler: route.handler, params };
      }
      return allow.size ? { methodMismatch: true, allow: [...allow].join(', ') } : null;
    },
  };
}

/* ------------------------------ static files ------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Code, styles and catalogs are revalidated on every load (cheap 304s); the rest is cached a day. */
const REVALIDATE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest']);

/**
 * Serves `urlPath` from `root`. Returns false when there is no such file (the
 * caller decides: SPA fallback or 404). Never leaves `root`, and never serves
 * dotfiles.
 */
export function serveStatic(root, urlPath, res) {
  let relative;
  try { relative = decodeURIComponent(String(urlPath).split('?')[0]); } catch { return false; }
  if (relative.endsWith('/')) relative += 'index.html';
  if (relative.includes('\0') || relative.split(/[\\/]/).some((part) => part.startsWith('.') && part !== '')) {
    return false;
  }
  const base = path.resolve(root);
  const file = path.resolve(base, `.${path.posix.normalize(`/${relative}`)}`);
  if (file !== base && !file.startsWith(base + path.sep)) return false;

  let stat;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }
  const ext = path.extname(file).toLowerCase();
  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  const cacheControl = REVALIDATE.has(ext) ? 'no-cache' : 'public, max-age=86400';
  if (res.req?.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
    res.end();
    return true;
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': cacheControl,
  });
  if (res.req?.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
  return true;
}

/* ---------------------------- security headers ---------------------------- */

/**
 * The content policy of every app. Everything they load is their own and
 * same-origin —no CDN, no external fonts, no analytics— which allows a very
 * tight policy:
 *
 * · No inline scripts and no eval: that is what really stops an XSS (the
 *   theme script lives in its own file for this reason).
 * · Inline styles are allowed: the interfaces place cards, bars and bubbles
 *   with values computed on the fly. An injected style is far less dangerous
 *   than a script.
 * · Nobody may frame the app inside another site and trick whoever clicks.
 */
export const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Sets the security headers on a response. Called at the start of every
 * request: `writeHead` keeps what `setHeader` set, so they reach every
 * response without each place that answers remembering them.
 */
export function securityHeaders(res, { https = false, csp = DEFAULT_CSP } = {}) {
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy',
    'geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()');
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/**
 * Refuses a cross-site request that rides on the session cookie.
 *
 * Only unsafe methods that carry `cookieName` are checked: a bearer token, an
 * OAuth call or any request without the cookie cannot be forged by another
 * site. For the rest, the browser's `Origin` must be this server (the host the
 * request came to, or `baseUrl`), or `Sec-Fetch-Site` must say same-origin.
 * Browsers always send one of them on these requests; when neither is there
 * the client is not a browser, and a CSRF needs one.
 */
export function checkOrigin(req, { baseUrl = '', cookieName }) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  if (cookieName && !(cookieName in parseCookies(req))) return;
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* "null" or garbage: not this server */ }
    let own = null;
    try { own = baseUrl ? new URL(baseUrl).host : null; } catch { /* no base URL */ }
    if (host && (host === req.headers.host || host === own)) return;
    throw new HttpError(403, 'cross_site_request');
  }
  const site = req.headers['sec-fetch-site'];
  if (!site || site === 'same-origin' || site === 'none') return;
  throw new HttpError(403, 'cross_site_request');
}

/* ------------------------------- validation ------------------------------- */

/**
 * A text field. Errors say which field and what is wrong, as codes the
 * interface turns into a sentence in each person's language.
 */
export function str(value, { field, max = 500, min = 0, trim = true, allowNull = false } = {}) {
  if (value == null) {
    if (allowNull) return null;
    throw badRequest('field_required', { field });
  }
  if (typeof value !== 'string') throw badRequest('field_invalid', { field });
  const out = trim ? value.trim() : value;
  if (out.length < min) throw badRequest(min <= 1 ? 'field_required' : 'field_too_short', { field, min });
  if (out.length > max) throw badRequest('field_too_long', { field, max });
  return out;
}

/** One of a fixed set of values; `fallback` when absent. */
export function oneOf(value, options, field, fallback) {
  if (value == null) return fallback;
  if (!options.includes(value)) throw badRequest('field_invalid', { field, options });
  return value;
}

/** A positive integer id, or null when absent. */
export function idOrNull(value, field) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('field_invalid', { field });
  return n;
}

/** An integer within bounds. */
export function int(value, { field, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest('field_invalid', { field, min, max });
  return n;
}
