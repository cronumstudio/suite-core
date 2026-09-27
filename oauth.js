/**
 * Built-in OAuth 2.1 authorization server for an app's MCP endpoint.
 *
 * Part of the shared suite code (Next, Tasks, Projects, Focus): it imports
 * nothing from the app. Whatever is the app's own —its database, how a user
 * signs in, what a session is, its texts and its page layout— is handed in by
 * `createOAuthServer`.
 *
 * Without it, connecting Claude or ChatGPT meant creating a token in Settings
 * and pasting it. With it, pasting the MCP URL is enough: the client discovers
 * this server, the user signs in with their usual account, says yes, and
 * that's it. Manual tokens keep working alongside.
 *
 * It is a small and deliberately narrow server, just what Claude and ChatGPT
 * need:
 *
 * · Only the authorization code grant with PKCE S256. No implicit, password or
 *   client_credentials grants.
 * · Clients by CIMD (their client_id is the URL of their metadata document,
 *   which Claude prefers) or by dynamic registration (RFC 7591) as fallback.
 * · Opaque tokens, stored only as a hash and bound to this app's /mcp. Access
 *   tokens last an hour; refresh tokens rotate on every use, and a used one
 *   showing up again revokes the whole grant.
 */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { createTexts } from './i18n.js';

/** Tables the app has to create (they are plain SQLite and idempotent). */
export const OAUTH_SCHEMA = `
-- Clients registered through DCR (RFC 7591). CIMD clients are not stored:
-- their id is a URL and their metadata is read from there.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     TEXT NOT NULL UNIQUE,
  secret_hash   TEXT,                    -- empty: public client (PKCE only)
  name          TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,           -- JSON
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT
);

-- A permission given: this user let this application in. It is what Settings
-- lists, and what gets revoked.
CREATE TABLE IF NOT EXISTS oauth_grants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  client_id     TEXT NOT NULL,
  client_name   TEXT NOT NULL,
  redirect_host TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants(user_id);

-- Access and refresh tokens of each grant, only their hash. A refresh token
-- already exchanged is marked instead of deleted: if it shows up again,
-- someone copied it, and the whole grant is revoked.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id   INTEGER NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,              -- 'access' | 'refresh'
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens(grant_id);
`;

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_DAYS = 60;
const CODE_TTL_MS = 5 * 60 * 1000;

const METADATA_PATH = '/.well-known/oauth-protected-resource';
const AS_METADATA_PATH = '/.well-known/oauth-authorization-server';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const CORS = { 'Access-Control-Allow-Origin': '*' };

/** Fields of an authorization request, whether it comes by GET or POST. */
const REQUEST_FIELDS = [
  'response_type', 'client_id', 'redirect_uri', 'state',
  'code_challenge', 'code_challenge_method', 'scope', 'resource',
];

/* --------------------------------- helpers --------------------------------- */

const randomValue = (prefix) => `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('base64url');
const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const parseUrl = (text) => { try { return new URL(text); } catch { return null; } };
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/**
 * A problem a person has to read (on the consent or error screen). It carries
 * a code, not a sentence: the app's texts say it in each person's language,
 * under `oauth.error.<code>`.
 */
export class OAuthScreenError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readForm(req) {
  const raw = await readBody(req);
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) {
    try {
      return new Map(Object.entries(JSON.parse(raw || '{}')).map(([k, v]) => [k, String(v)]));
    } catch { return new Map(); }
  }
  return new Map(new URLSearchParams(raw));
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/** Errors for machines follow RFC 6749: fixed English descriptions are fine. */
function oauthError(res, status, error, description, extra = {}) {
  sendJson(res, status, { error, ...(description ? { error_description: description } : {}) },
    { ...CORS, ...extra });
}

/* ------------------------------ redirect URIs ------------------------------ */

/**
 * An acceptable redirect URI when registering: https; http only towards the
 * same machine (RFC 8252); or a native app's own scheme. Never javascript:,
 * data: or the like.
 */
function acceptableRedirect(text) {
  const u = parseUrl(text);
  if (!u || u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol)
    && !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ftp:', 'ws:', 'wss:']
      .includes(u.protocol);
}

/**
 * Whether `requested` is one of the registered ones. Exact, except for
 * loopback ones, where the port doesn't count: a desktop app opens a free one
 * each time (RFC 8252 §7.3). Claude Code declares http://localhost/callback
 * and uses whichever port it gets.
 */
function registeredRedirect(registered, requested) {
  if (registered.includes(requested)) return true;
  const r = parseUrl(requested);
  if (!r || r.protocol !== 'http:' || !LOOPBACK.has(r.hostname)) return false;
  return registered.some((one) => {
    const u = parseUrl(one);
    return u && u.protocol === 'http:' && u.hostname === r.hostname
      && u.pathname === r.pathname && u.search === r.search;
  });
}

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return privateIp(x.slice(7));
  return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
}

/* --------------------------------- server ---------------------------------- */

/**
 * @param {object} options
 * @param {string} options.baseUrl    public URL of the app (the issuer); /mcp is the resource
 * @param {string} options.appName    shown to the user and in the metadata
 * @param {boolean} [options.enabled]
 * @param {boolean} [options.allowPrivateCimd]  tests only: read CIMD documents from local hosts
 * @param {{all, get, run}} options.db
 * @param {object} options.users
 *   login(username, password) → user | null; fromRequest(req) → user | null;
 *   byId(id) → user | null; handle(user) → how the consent screen names them
 * @param {object} options.sessions
 *   open(res, userId) opens a browser session; tokenFrom(req) → session token | null;
 *   sign(value) → a keyed signature (for the consent CSRF)
 * @param {object} options.limits
 *   checkLogin(req, name), loginFailed(req, name), loginSucceeded(req, name),
 *   allowRegistration(req) → {allowed, retryAfter?}
 * @param {(req, user) => {lang: string, t: Function}} [options.texts]
 *   the screens' texts; by default the suite's own (i18n/), in the user's or
 *   the browser's language. `createTexts({ catalogs })` overrides some keys.
 * @param {({lang, title, body}) => string} options.page  full HTML around a body
 */
export function createOAuthServer({
  baseUrl, appName, enabled = true, allowPrivateCimd = false,
  db, users, sessions, limits, texts = createTexts(), page, log = console.log,
}) {
  const BASE_URL = String(baseUrl).replace(/\/$/, '');
  const ISSUER = BASE_URL;
  const RESOURCE = `${BASE_URL}/mcp`;

  /** Authorization codes in flight, by hash. They last minutes: memory is plenty. */
  const codes = new Map();

  /* ----------------------------- clients -------------------------------- */

  const isCimdClient = (clientId) => /^https:\/\//.test(clientId)
    || (allowPrivateCimd && /^http:\/\//.test(clientId));

  /** CIMD documents already read: an hour, and at most a couple hundred. */
  const documents = new Map();
  const DOCUMENT_TTL_MS = 3600 * 1000;
  const MAX_DOCUMENT_BYTES = 64 * 1024;

  /**
   * A CIMD client's metadata, read from its URL. Only trusted if the document
   * itself claims to be that client_id: that is what ties the name shown to
   * the domain it comes from. Not fetched from private addresses, or this
   * server could be used to peek into the home network on behalf of whoever
   * made up a client_id.
   */
  async function cimdDocument(clientId) {
    const cached = documents.get(clientId);
    if (cached && Date.now() - cached.at < DOCUMENT_TTL_MS) return cached.client;

    const u = parseUrl(clientId);
    if (!u || u.hash || u.username || u.password || u.pathname === '/') {
      throw new OAuthScreenError('client_document_url');
    }
    if (!allowPrivateCimd) {
      if (u.protocol !== 'https:') throw new OAuthScreenError('client_document_https');
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(host)) throw new OAuthScreenError('client_document_ip');
      const addresses = await dns.lookup(host, { all: true }).catch(() => []);
      if (!addresses.length || addresses.some((a) => privateIp(a.address))) {
        throw new OAuthScreenError('client_document_private');
      }
    }

    let res;
    try {
      res = await fetch(clientId, {
        redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new OAuthScreenError('client_document_unreachable');
    }
    if (!res.ok) throw new OAuthScreenError('client_document_unreachable');
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_DOCUMENT_BYTES) throw new OAuthScreenError('client_document_invalid');
      chunks.push(chunk);
    }
    let doc;
    try { doc = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
      throw new OAuthScreenError('client_document_invalid');
    }

    if (doc?.client_id !== clientId) throw new OAuthScreenError('client_document_mismatch');
    if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length
      || !doc.redirect_uris.every((r) => typeof r === 'string' && acceptableRedirect(r))) {
      throw new OAuthScreenError('client_document_invalid');
    }
    if (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== 'none') {
      throw new OAuthScreenError('client_document_invalid');
    }
    const client = {
      client_id: clientId,
      name: String(doc.client_name || u.hostname).slice(0, 100),
      redirect_uris: doc.redirect_uris,
      public: true,
      verified: true,            // the name comes from the client_id's domain
    };
    if (documents.size > 200) documents.delete(documents.keys().next().value);
    documents.set(clientId, { client, at: Date.now() });
    return client;
  }

  /** The client by its id, from CIMD or from registration. Throws if unknown. */
  async function findClient(clientId) {
    if (!clientId) throw new OAuthScreenError('client_missing');
    if (isCimdClient(clientId)) return cimdDocument(clientId);
    const row = db.get('SELECT * FROM oauth_clients WHERE client_id = ?', clientId);
    if (!row) throw new OAuthScreenError('client_unknown');
    return {
      client_id: row.client_id,
      name: row.name,
      redirect_uris: JSON.parse(row.redirect_uris),
      public: !row.secret_hash,
      secret_hash: row.secret_hash,
      verified: false,           // the name was chosen by whoever registered
    };
  }

  /* ----------------------------- metadata ------------------------------- */

  const serverMetadata = () => ({
    issuer: ISSUER,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    registration_endpoint: `${BASE_URL}/oauth/register`,
    revocation_endpoint: `${BASE_URL}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  });

  /* --------------------------- registration ----------------------------- */

  async function register(req, res) {
    const allowed = limits.allowRegistration(req);
    if (!allowed.allowed) {
      oauthError(res, 429, 'temporarily_unavailable', 'Too many registrations from this address',
        { 'Retry-After': String(allowed.retryAfter) });
      return;
    }
    let data;
    try { data = JSON.parse((await readBody(req)) || '{}'); } catch { data = null; }
    if (!data || typeof data !== 'object') {
      oauthError(res, 400, 'invalid_client_metadata', 'The body must be JSON');
      return;
    }
    const redirects = data.redirect_uris;
    if (!Array.isArray(redirects) || !redirects.length || redirects.length > 10
      || !redirects.every((r) => typeof r === 'string' && r.length <= 500 && acceptableRedirect(r))) {
      oauthError(res, 400, 'invalid_redirect_uri',
        'redirect_uris must be https, loopback or native app URIs');
      return;
    }
    const method = data.token_endpoint_auth_method || 'client_secret_basic';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
      oauthError(res, 400, 'invalid_client_metadata', `token_endpoint_auth_method "${method}" is not supported`);
      return;
    }
    const grantTypes = data.grant_types || ['authorization_code'];
    if (!Array.isArray(grantTypes)
      || !grantTypes.every((g) => ['authorization_code', 'refresh_token'].includes(g))) {
      oauthError(res, 400, 'invalid_client_metadata', 'Only authorization_code and refresh_token');
      return;
    }
    const responseTypes = data.response_types || ['code'];
    if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== 'code')) {
      oauthError(res, 400, 'invalid_client_metadata', 'Only response_type "code"');
      return;
    }

    const clientId = randomValue('oc_');
    const secret = method === 'none' ? null : randomValue('ocs_');
    const name = String(data.client_name || '').trim().slice(0, 100) || 'Unnamed application';
    db.run(
      'INSERT INTO oauth_clients (client_id, secret_hash, name, redirect_uris) VALUES (?, ?, ?, ?)',
      clientId, secret ? hash(secret) : null, name, JSON.stringify(redirects),
    );
    sendJson(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name,
      redirect_uris: redirects,
      grant_types: grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: method,
    }, CORS);
  }

  /* --------------------------- authorization ---------------------------- */

  /**
   * Checks client and redirect URI. Until they match, an error must NOT be
   * sent back to the client: the URI could be an attacker's. It is shown on
   * screen and that's it.
   */
  async function checkClient(p) {
    let client;
    try { client = await findClient(p.get('client_id')); } catch (err) {
      if (err instanceof OAuthScreenError) return { failure: err.code };
      throw err;
    }
    const redirect = p.get('redirect_uri')
      || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
    if (!redirect || !registeredRedirect(client.redirect_uris, redirect)) {
      return { failure: 'redirect_not_registered' };
    }
    return { client, redirect };
  }

  /** What, with a trusted redirect URI, is answered there as an OAuth error. */
  function checkRequest(p) {
    if (p.get('response_type') !== 'code') return ['unsupported_response_type', 'Only response_type=code'];
    if (!p.get('code_challenge') || p.get('code_challenge_method') !== 'S256') {
      return ['invalid_request', 'PKCE with code_challenge_method=S256 is required'];
    }
    if (!/^[\w-]{43,128}$/.test(p.get('code_challenge'))) return ['invalid_request', 'Invalid code_challenge'];
    const resource = p.get('resource');
    if (resource && resource.replace(/\/$/, '') !== RESOURCE) {
      return ['invalid_target', `The resource must be ${RESOURCE}`];
    }
    return null;
  }

  function redirectBack(res, redirect, params) {
    const target = new URL(redirect);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') target.searchParams.set(k, v);
    target.searchParams.set('iss', ISSUER);
    res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  /** The consent CSRF: ties the session to this very request. */
  const csrfFor = (req, p) => sessions.sign(['client_id', 'redirect_uri', 'code_challenge']
    .reduce((acc, k) => `${acc}|${p.get(k) ?? ''}`, sessions.tokenFrom(req) || ''));

  /**
   * The consent screen's CSP. `form-action` has to allow the redirect URI: the
   * browser applies it to the redirect that follows the form submission too,
   * and without it "Allow" would never arrive.
   */
  function screenCsp(redirect) {
    const u = parseUrl(redirect);
    const target = !u ? '' : (u.protocol === 'http:' || u.protocol === 'https:') ? u.origin : u.protocol;
    return [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self'",
      `form-action 'self' ${target}`.trim(), "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'",
    ].join('; ');
  }

  /**
   * A translated sentence as HTML: the text is escaped, and the values are
   * inserted already escaped and, where it helps, in bold.
   */
  const htmlText = (t, key, vars = {}) => {
    const marks = {};
    const placeholders = Object.fromEntries(Object.keys(vars).map((k, i) => {
      marks[`\u0000${i}\u0000`] = vars[k];
      return [k, `\u0000${i}\u0000`];
    }));
    let out = escapeHtml(t(key, { app: appName, ...placeholders }));
    for (const [mark, value] of Object.entries(marks)) out = out.split(escapeHtml(mark)).join(value);
    return out;
  };
  const strong = (text) => `<strong>${escapeHtml(text)}</strong>`;

  function screen(res, status, { lang, title, body, redirect = null }) {
    res.setHeader('Content-Security-Policy', screenCsp(redirect));
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page({ lang, title, body }));
  }

  function errorScreen(req, res, code) {
    const { lang, t } = texts(req, users.fromRequest(req));
    screen(res, 400, {
      lang,
      title: t('oauth.cannotConnect'),
      body: `<h1>${htmlText(t, 'oauth.cannotConnect')}</h1>
<p class="oauth__text">${htmlText(t, `oauth.error.${code}`)}</p>
<p class="oauth__text">${htmlText(t, 'oauth.goBack')}</p>`,
    });
  }

  function consentScreen(req, res, p, { client, redirect }, { user = null, error = null } = {}) {
    const { lang, t } = texts(req, user);
    const target = parseUrl(redirect);
    const loopback = target && target.protocol === 'http:' && LOOPBACK.has(target.hostname);
    const redirectHost = target ? (target.host || target.protocol) : redirect;
    const origin = client.verified ? parseUrl(client.client_id)?.hostname : null;
    const hidden = REQUEST_FIELDS
      .map((k) => (p.get(k) != null ? `<input type="hidden" name="${k}" value="${escapeHtml(p.get(k))}">` : ''))
      .join('\n');
    const who = origin ? `${strong(client.name)} (${escapeHtml(origin)})` : strong(client.name);

    screen(res, 200, {
      lang,
      title: t('oauth.connectTitle', { app: appName }),
      redirect,
      body: `<h1>${htmlText(t, 'oauth.connectTitle')}</h1>
<p class="oauth__text">${htmlText(t, 'oauth.wants', { client: who })}</p>
${client.verified ? '' : `<p class="oauth__text oauth__note">${htmlText(t, 'oauth.unverified')}</p>`}
<p class="oauth__text">${htmlText(t, 'oauth.returnTo', { host: strong(redirectHost) })}</p>
${loopback ? `<p class="oauth__warning">${htmlText(t, 'oauth.loopback')}</p>` : ''}
${error ? `<p class="oauth__error" role="alert">${htmlText(t, `oauth.${error}`)}</p>` : ''}
<form class="oauth__form" method="post" action="/oauth/authorize">
${hidden}
${user
    ? `<input type="hidden" name="csrf" value="${escapeHtml(csrfFor(req, p))}">
<p class="oauth__text">${htmlText(t, 'oauth.signedInAs', { user: strong(users.handle(user)) })}</p>`
    : `<label class="field"><span>${htmlText(t, 'oauth.username')}</span>
<input name="username" autocomplete="username" required autocapitalize="none" spellcheck="false"></label>
<label class="field"><span>${htmlText(t, 'oauth.password')}</span>
<input name="password" type="password" autocomplete="current-password" required></label>`}
<div class="oauth__actions">
<button class="btn btn--primary" type="submit" name="decision" value="allow">${htmlText(t, user ? 'oauth.allow' : 'oauth.signInAndAllow')}</button>
<button class="btn" type="submit" name="decision" value="cancel" formnovalidate>${htmlText(t, 'oauth.cancel')}</button>
</div>
</form>`,
    });
  }

  async function authorize(req, res, url) {
    const p = req.method === 'POST' ? await readForm(req) : url.searchParams;
    const checked = await checkClient(p);
    if (checked.failure) {
      errorScreen(req, res, checked.failure);
      return;
    }
    const { client, redirect } = checked;
    const bad = checkRequest(p);
    if (bad) {
      redirectBack(res, redirect, { error: bad[0], error_description: bad[1], state: p.get('state') });
      return;
    }

    let user = users.fromRequest(req);
    if (req.method === 'GET') {
      consentScreen(req, res, p, checked, { user });
      return;
    }

    if (p.get('decision') !== 'allow') {
      redirectBack(res, redirect, {
        error: 'access_denied', error_description: 'The user did not give permission', state: p.get('state'),
      });
      return;
    }

    if (user) {
      // With the session open the password isn't asked again, but the form has
      // to come from the screen that was shown, not from another page.
      const csrf = p.get('csrf') || '';
      const expected = csrfFor(req, p);
      if (csrf.length !== expected.length
        || !crypto.timingSafeEqual(Buffer.from(csrf), Buffer.from(expected))) {
        errorScreen(req, res, 'request_expired');
        return;
      }
    } else {
      const name = p.get('username') || '';
      if (!limits.checkLogin(req, name).allowed) {
        consentScreen(req, res, p, checked, { error: 'tooManyAttempts' });
        return;
      }
      user = users.login(name, p.get('password') || '');
      if (!user) {
        limits.loginFailed(req, name);
        consentScreen(req, res, p, checked, { error: 'badCredentials' });
        return;
      }
      limits.loginSucceeded(req, name);
      // The browser session is opened on the way, as when signing in to the app.
      sessions.open(res, user.id);
    }

    if (!client.verified) {
      db.run("UPDATE oauth_clients SET last_used_at = datetime('now') WHERE client_id = ?", client.client_id);
    }
    const code = randomValue('');
    codes.set(hash(code), {
      userId: user.id,
      clientId: client.client_id,
      name: client.name,
      redirect,
      explicitRedirect: !!p.get('redirect_uri'),
      challenge: p.get('code_challenge'),
      scope: p.get('scope') || '',
      expires: Date.now() + CODE_TTL_MS,
      grantId: null,
    });
    log(`[oauth] user #${user.id} gives permission to "${client.name}"`);
    redirectBack(res, redirect, { code, state: p.get('state') });
  }

  /* ------------------------------ tokens -------------------------------- */

  /** Who is calling the token endpoint. Returns the client_id or null. */
  async function authenticateClient(req, p) {
    let clientId = p.get('client_id');
    let secret = p.get('client_secret');
    const basic = String(req.headers.authorization || '').match(/^basic\s+(.+)$/i);
    if (basic) {
      const [id, key] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      clientId = decodeURIComponent(id || '');
      secret = decodeURIComponent(key || '');
    }
    let client;
    try { client = await findClient(clientId); } catch { return null; }
    if (client.public) return client.client_id;
    if (!secret || hash(secret) !== client.secret_hash) return null;
    return client.client_id;
  }

  function issue(grantId, scope) {
    const access = randomValue('mcpat_');
    const refresh = randomValue('mcprt_');
    db.run('INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES (?, ?, ?, ?)',
      hash(access), grantId, 'access', sqlTime(Date.now() + ACCESS_TTL_S * 1000));
    db.run('INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES (?, ?, ?, ?)',
      hash(refresh), grantId, 'refresh', sqlTime(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000));
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      ...(scope ? { scope } : {}),
    };
  }

  // Tokens go first on purpose: the app's database may not enforce foreign keys.
  const revokeGrant = (grantId) => {
    db.run('DELETE FROM oauth_tokens WHERE grant_id = ?', grantId);
    db.run('DELETE FROM oauth_grants WHERE id = ?', grantId);
  };

  async function token(req, res) {
    const p = await readForm(req);
    const resource = p.get('resource');
    if (resource && resource.replace(/\/$/, '') !== RESOURCE) {
      oauthError(res, 400, 'invalid_target', `The resource must be ${RESOURCE}`);
      return;
    }
    const clientId = await authenticateClient(req, p);
    if (!clientId) {
      oauthError(res, 401, 'invalid_client', 'Unknown client or wrong credentials');
      return;
    }

    if (p.get('grant_type') === 'authorization_code') {
      const key = hash(p.get('code') || '');
      const pending = codes.get(key);
      if (!pending || pending.expires < Date.now() || pending.clientId !== clientId) {
        oauthError(res, 400, 'invalid_grant', 'Invalid or expired code');
        return;
      }
      if (pending.grantId) {
        // A code exchanged twice: someone else has it. Everything that came
        // out of it goes (OAuth 2.1, §4.1.3).
        revokeGrant(pending.grantId);
        codes.delete(key);
        oauthError(res, 400, 'invalid_grant', 'That code was already used');
        return;
      }
      const redirect = p.get('redirect_uri');
      if ((pending.explicitRedirect || redirect) && redirect !== pending.redirect) {
        oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match the authorization');
        return;
      }
      const verifier = p.get('code_verifier') || '';
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      if (!/^[\w.~-]{43,128}$/.test(verifier) || challenge !== pending.challenge) {
        oauthError(res, 400, 'invalid_grant', 'code_verifier does not match the code_challenge');
        return;
      }
      const target = parseUrl(pending.redirect);
      const { lastInsertRowid } = db.run(
        'INSERT INTO oauth_grants (user_id, client_id, client_name, redirect_host) VALUES (?, ?, ?, ?)',
        pending.userId, clientId, pending.name, target?.host || target?.protocol || null,
      );
      pending.grantId = Number(lastInsertRowid);
      sendJson(res, 200, issue(pending.grantId, pending.scope), CORS);
      return;
    }

    if (p.get('grant_type') === 'refresh_token') {
      const row = db.get(
        `SELECT t.*, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
         WHERE t.token_hash = ? AND t.kind = 'refresh'`,
        hash(p.get('refresh_token') || ''),
      );
      if (!row || row.client_id !== clientId || row.expires_at <= sqlTime(Date.now())) {
        oauthError(res, 400, 'invalid_grant', 'Invalid or expired refresh token');
        return;
      }
      if (row.used_at) {
        // A refresh token already exchanged shows up again: it was copied.
        revokeGrant(row.grant_id);
        log(`[oauth] refresh token reused: grant ${row.grant_id} revoked`);
        oauthError(res, 400, 'invalid_grant', 'Refresh token already used');
        return;
      }
      db.run("UPDATE oauth_tokens SET used_at = datetime('now') WHERE token_hash = ?", row.token_hash);
      // The previous access token stops working: with the new pair it is not needed.
      db.run("DELETE FROM oauth_tokens WHERE grant_id = ? AND kind = 'access'", row.grant_id);
      sendJson(res, 200, issue(row.grant_id, p.get('scope') || ''), CORS);
      return;
    }

    oauthError(res, 400, 'unsupported_grant_type', 'Only authorization_code and refresh_token');
  }

  /** RFC 7009: revoking a token revokes the whole grant. Always answers 200. */
  async function revoke(req, res) {
    const p = await readForm(req);
    const row = db.get('SELECT grant_id FROM oauth_tokens WHERE token_hash = ?', hash(p.get('token') || ''));
    if (row) revokeGrant(row.grant_id);
    res.writeHead(200, { ...CORS, 'Cache-Control': 'no-store' });
    res.end();
  }

  /* ------------------------------- routes ------------------------------- */

  /** Handles the OAuth routes. Returns false if they aren't its own or it is off. */
  async function handle(req, res, url) {
    if (!enabled) return false;
    const path = url.pathname;
    const ours = path.startsWith('/oauth/')
      || path === METADATA_PATH || path.startsWith(`${METADATA_PATH}/`)
      || path === AS_METADATA_PATH || path.startsWith(`${AS_METADATA_PATH}/`);
    if (!ours) return false;

    if (req.method === 'OPTIONS' && path !== '/oauth/authorize') {
      res.writeHead(204, {
        ...CORS,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return true;
    }

    if (path === METADATA_PATH || path === `${METADATA_PATH}/mcp`) {
      sendJson(res, 200, {
        resource: RESOURCE,
        authorization_servers: [ISSUER],
        bearer_methods_supported: ['header'],
        resource_name: appName,
      }, CORS);
      return true;
    }
    if (path === AS_METADATA_PATH || path.startsWith(`${AS_METADATA_PATH}/`)) {
      sendJson(res, 200, serverMetadata(), CORS);
      return true;
    }
    try {
      if (path === '/oauth/register' && req.method === 'POST') { await register(req, res); return true; }
      if (path === '/oauth/authorize' && (req.method === 'GET' || req.method === 'POST')) {
        await authorize(req, res, url);
        return true;
      }
      if (path === '/oauth/token' && req.method === 'POST') { await token(req, res); return true; }
      if (path === '/oauth/revoke' && req.method === 'POST') { await revoke(req, res); return true; }
    } catch (err) {
      if (err?.message === 'body_too_large') {
        oauthError(res, 413, 'invalid_request', 'Body too large');
        return true;
      }
      throw err;
    }

    oauthError(res, 404, 'not_found', 'Unknown OAuth path');
    return true;
  }

  /* -------------------------------- use --------------------------------- */

  /** The user of an access token issued here, or null. */
  function userFromAccessToken(tokenValue) {
    if (!enabled || !String(tokenValue || '').startsWith('mcpat_')) return null;
    const row = db.get(
      `SELECT g.id AS grant_id, g.user_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
       WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > datetime('now')`,
      hash(tokenValue),
    );
    if (!row) return null;
    const user = users.byId(row.user_id);
    // An account the admin disabled keeps its grants, unused, until it comes back.
    if (!user || user.disabled_at) return null;
    db.run("UPDATE oauth_grants SET last_used_at = datetime('now') WHERE id = ?", row.grant_id);
    return user;
  }

  /** The MCP's 401 header: where the metadata is, so the client opens the sign-in window. */
  const challenge = (hadToken) =>
    `Bearer resource_metadata="${BASE_URL}${METADATA_PATH}/mcp"${hadToken ? ', error="invalid_token"' : ''}`;

  /** The applications a user has given permission to, for Settings. */
  const grantsOf = (userId) => db.all(
    `SELECT id, client_name, client_id, redirect_host, created_at, last_used_at
     FROM oauth_grants WHERE user_id = ? ORDER BY COALESCE(last_used_at, created_at) DESC`,
    userId,
  ).map((g) => ({ ...g, client_id: isCimdClient(g.client_id) ? g.client_id : undefined }));

  function revokeGrantOf(grantId, userId) {
    const row = db.get('SELECT id FROM oauth_grants WHERE id = ? AND user_id = ?', grantId, userId);
    if (!row) return false;
    revokeGrant(row.id);
    return true;
  }

  /** Everything of a user, when their account is deleted. */
  function forgetUser(userId) {
    for (const g of db.all('SELECT id FROM oauth_grants WHERE user_id = ?', userId)) revokeGrant(g.id);
  }

  /**
   * Periodic cleanup: expired tokens, grants with no live token left,
   * forgotten codes and registered clients never used —Claude registers one
   * on every new connection and most of them stay there—.
   */
  function purge() {
    db.run("DELETE FROM oauth_tokens WHERE expires_at <= datetime('now')");
    db.run(`DELETE FROM oauth_grants WHERE created_at < datetime('now', '-1 day')
            AND id NOT IN (SELECT grant_id FROM oauth_tokens)`);
    db.run(`DELETE FROM oauth_clients WHERE created_at < datetime('now', '-7 days')
            AND (last_used_at IS NULL OR last_used_at < datetime('now', '-60 days'))
            AND client_id NOT IN (SELECT client_id FROM oauth_grants)`);
    const now = Date.now();
    for (const [key, c] of codes) if (c.expires < now) codes.delete(key);
  }

  return {
    enabled, resource: RESOURCE,
    handle, userFromAccessToken, challenge, grantsOf, revokeGrant: revokeGrantOf, forgetUser, purge,
  };
}
