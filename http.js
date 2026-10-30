/**
 * The HTTP layer every app of the suite shares: errors as codes, the router,
 * reading requests, cookies, static files, security headers and the check
 * against cross-site requests.
 *
 * Built on `node:http` alone. Errors carry a code, never a sentence
 * (`field_too_long`, `plan_limit`…): the interface ships in several languages
 * and the browser is the one that says it in each person's, from its catalogs.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
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

/**
 * An answer to a path that ends in /mcp or /sse (the MCP, its OAuth metadata, a module's old one,
 * the old SSE transport): Avast's Web Shield, with its MCP detection, rewrites one that has a
 * Content-Length into one that says "chunked" and isn't, and every MCP client on that computer
 * fails ("Invalid character in chunk size"), the suite's own tests too. Without the length Node
 * sends it chunked, which Avast lets through.
 */
const toMcp = (res) => /\/(mcp|sse)\/?$/i.test(String(res.req?.url ?? '').split('?')[0]);

export function sendJson(res, status, data, headers = {}) {
  const body = status === 204 ? '' : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(toMcp(res) ? {} : { 'Content-Length': Buffer.byteLength(body) }),
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
 * (the NAS or VPS reverse proxy), a number says how many; empty or false, none.
 * `cloudflare` is Cloudflare in front of one reverse proxy: the client is the
 * address Cloudflare puts in CF-Connecting-IP (see clientIp()).
 */
export function proxyHops(value) {
  if (value === true) return 1;
  if (value == null || value === false) return 0;
  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === 'cloudflare') return 1;
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * The client's address. `X-Forwarded-For` is only believed as far as the
 * trusted proxies go: each one appends the address it saw, so the real client
 * is the entry that many places from the end. The first entry is whatever the
 * client chose to send — believing it would let anyone pick their address and
 * walk around the brute-force brake.
 *
 * Behind Cloudflare, a reverse proxy such as Traefik drops the X-Forwarded-For
 * it doesn't trust and writes Cloudflare's own address there, so every client
 * would share a handful of addresses. With TRUST_PROXY=cloudflare the address
 * is CF-Connecting-IP, which Cloudflare always sets — but only when the hop
 * that brought it is one of Cloudflare's own: an origin can usually be reached
 * directly too, and there anyone could write that header.
 */
export function clientIp(req, { trustProxy = process.env.TRUST_PROXY } = {}) {
  // Without a request (a script run by whoever runs the install) there is no address.
  if (!req) return '';
  const hops = proxyHops(trustProxy);
  let address = req.socket?.remoteAddress || '';
  if (hops) {
    const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (chain.length) address = chain[Math.max(0, chain.length - hops)];
  }
  if (String(trustProxy ?? '').trim().toLowerCase() === 'cloudflare') {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (net.isIP(cf) && fromCloudflare(address)) return cf;
  }
  return address;
}

/**
 * Cloudflare's published ranges (https://www.cloudflare.com/ips/, which has not
 * changed in years). Should one be added, requests from it count as from the
 * edge address, as with TRUST_PROXY=true: less precise, never spoofable.
 */
const CLOUDFLARE = new net.BlockList();
for (const cidr of [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
]) {
  const [network, bits] = cidr.split('/');
  CLOUDFLARE.addSubnet(network, Number(bits), network.includes(':') ? 'ipv6' : 'ipv4');
}
function fromCloudflare(address) {
  const ip = String(address).replace(/^::ffff:/i, '');
  const family = net.isIP(ip);
  return family ? CLOUDFLARE.check(ip, family === 6 ? 'ipv6' : 'ipv4') : false;
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
        // The pattern too: what an alert names a request by, never its values (alerts.js).
        return { handler: route.handler, params, pattern: `/${route.segments.join('/')}` };
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

const hashes = new Map();

/**
 * What a file holds, as a hash (sha1, hex), read again only when its path, size or date
 * change. Its date alone said nothing: an image built from a fresh checkout dates every file
 * at the build, so each deploy looked like new code in every module of a host, and every file
 * travelled again instead of a 304. `stat` saves a second look when the caller has it.
 */
export function contentHash(file, stat = fs.statSync(file)) {
  const known = hashes.get(file);
  if (known && known.size === stat.size && known.mtime === stat.mtimeMs) return known.hash;
  const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  hashes.set(file, { size: stat.size, mtime: stat.mtimeMs, hash });
  return hash;
}

/**
 * The file `urlPath` names in `root`, as serveStatic would serve it: `{ file, stat }`, or null
 * when there is none. Never outside `root`, and never a dotfile.
 */
export function staticFile(root, urlPath) {
  let relative;
  try { relative = decodeURIComponent(String(urlPath).split('?')[0]); } catch { return null; }
  if (relative.endsWith('/')) relative += 'index.html';
  if (relative.includes('\0') || relative.split(/[\\/]/).some((part) => part.startsWith('.') && part !== '')) {
    return null;
  }
  const base = path.resolve(root);
  const file = path.resolve(base, `.${path.posix.normalize(`/${relative}`)}`);
  if (file !== base && !file.startsWith(base + path.sep)) return null;
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? { file, stat } : null;
  } catch {
    return null;
  }
}

/**
 * Serves `urlPath` from `root`. Returns false when there is no such file (the
 * caller decides: SPA fallback or 404). Never leaves `root`, and never serves
 * dotfiles.
 */
export function serveStatic(root, urlPath, res) {
  const found = staticFile(root, urlPath);
  if (!found) return false;
  const { file, stat } = found;
  const ext = path.extname(file).toLowerCase();
  // From what it holds: the same file in a new build is still a 304.
  let etag;
  try {
    etag = `W/"${stat.size}-${contentHash(file, stat).slice(0, 16)}"`;
  } catch {
    return false;   // gone between the look and the read
  }
  const cacheControl = REVALIDATE.has(ext) ? 'no-cache' : 'public, max-age=86400';
  if (res.req?.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
    res.end();
    return true;
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // The app's page at /mcp, for an app whose MCP has no tools: Avast's rewrite (sendJson).
    ...(toMcp(res) ? {} : { 'Content-Length': stat.size }),
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
 *   A host's module with a split view (host.js `split`) may be framed by its
 *   own site only: securityHeaders' `frames: 'self'`. A page that does nothing
 *   but show, without a session (a project's public page), may be framed by any
 *   site: `frames: 'any'`, the app's `embeds`.
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
 *
 * `frames: 'self'` lets pages of the same site frame this one (a host's split
 * view), and `frames: 'any'` pages of any site (a page made to be embedded,
 * which X-Frame-Options can't say, so it goes without); by default no page may,
 * of any site.
 */
export function securityHeaders(res, { https = false, csp = DEFAULT_CSP, frames = 'none' } = {}) {
  const ancestors = { self: "frame-ancestors 'self'", any: 'frame-ancestors *' }[frames];
  res.setHeader('Content-Security-Policy', ancestors ? csp.replace("frame-ancestors 'none'", ancestors) : csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (frames === 'any') res.removeHeader('X-Frame-Options');
  else res.setHeader('X-Frame-Options', frames === 'self' ? 'SAMEORIGIN' : 'DENY');
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
 *
 * `Origin: null` with `Sec-Fetch-Site: same-origin` is this server's own page:
 * under `Referrer-Policy: no-referrer` the browser sends `null` even on a form
 * posted to its own server (the Fetch spec does so for every non-CORS write),
 * and that was the OAuth consent screen — "Allow" answered cross_site_request
 * to anyone already signed in. No page can forge Sec-Fetch-Site; a sandboxed
 * frame or a data: URL elsewhere sends `null` with cross-site, and stays out.
 */
export function checkOrigin(req, { baseUrl = '', cookieName }) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  if (cookieName && !(cookieName in parseCookies(req))) return;
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  if (origin === 'null' && site === 'same-origin') return;
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* "null" or garbage: not this server */ }
    let own = null;
    try { own = baseUrl ? new URL(baseUrl).host : null; } catch { /* no base URL */ }
    if (host && (host === req.headers.host || host === own)) return;
    throw new HttpError(403, 'cross_site_request');
  }
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

/**
 * A calendar date as `YYYY-MM-DD` that exists and falls in a sensible range:
 * the same text back, or null. `2026-13-01`, `2026-02-31` and the year 2206
 * are not dates a task or a plan can carry, and code that turns them into a
 * `Date` (to add days, to draw a timeline) throws or freezes on them. One
 * check for every module's REST and MCP (`dateOrNull`, `parseDate`…), and for
 * the MCP's `format: 'date'` (mcp.js).
 */
export function isoDate(value, { minYear = 1900, maxYear = 2200 } = {}) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [y, m, d] = match.slice(1).map(Number);
  if (y < minYear || y > maxYear) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return match[0];
}
