/**
 * An app on the suite: every module wired from its configuration, and the HTTP
 * server that dispatches in the order the apps learned the hard way.
 *
 *   // server/platform.js — the services, once, for the whole app to import
 *   import product from '../suite.config.js';
 *   export const suite = createSuite({ config: product, migrations, hooks });
 *
 *   // server/index.js — the server
 *   createApp({ suite, publicDir, routes, mcp, serializeUser }).listen();
 *
 * `createSuite` reads suite.config.js and the environment, opens the database,
 * runs the app's migrations and then the suite's, and creates sessions,
 * accounts, API tokens, the audit log, the brake, plans, and —when the
 * configuration says so— organizations, billing, WorkOS and the built-in OAuth.
 * A configuration with errors, a misspelled plan catalog or a half-set WorkOS
 * stop the start, saying what is wrong.
 *
 * `createApp` adds the common routes (/api/auth, /api/me, /api/admin,
 * /api/orgs, /api/billing), the MCP endpoint with the app's tools, the app's
 * own routes, its static files, the periodic clean-ups, hot reload and an
 * orderly shutdown.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { resolveConfig } from './config.js';
import { openDatabase } from './db.js';
import { migrate } from './migrate.js';
import { SUITE_MIGRATIONS } from './schema.js';
import { randomToken } from './crypto.js';
import { createSessions, resolveSessionSecret } from './sessions.js';
import { createAccounts } from './accounts.js';
import { createTokens } from './tokens.js';
import { createAudit } from './audit.js';
import { createRateLimiter } from './rate-limit.js';
import { createEntitlements } from './entitlements.js';
import { createOrganizations } from './organizations.js';
import { createBilling, signedProvider, registerBillingApi } from './billing.js';
import { createWorkosClient, WorkosUnavailable } from './workos.js';
import { createWorkosAccounts, workosUsers } from './workos-accounts.js';
import { createOAuthServer } from './oauth.js';
import { createMcpServer } from './mcp.js';
import {
  registerAuthApi, registerProfileApi, registerAdminApi, registerOrganizationsApi,
} from './api.js';
import {
  HttpError, createRouter, sendJson, sendText, serveStatic, securityHeaders, checkOrigin,
} from './http.js';
import { watchCode } from './watcher.js';
import { SUITE_CATALOGS, mergeCatalogs } from './i18n.js';

const HOUR = 3600 * 1000;

/** A configuration that can't run: what createSuite throws when it isn't told to exit. */
export class SuiteConfigError extends Error {
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'SuiteConfigError';
    this.errors = errors;
  }
}

const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/** The OAuth consent and error screens when the app doesn't dress them itself. */
const plainPage = (appName) => ({ lang, title, body }) => `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} · ${escapeHtml(appName)}</title>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;

/** Passwords from examples and old defaults: known to anyone, so never used. */
const EXAMPLE_PASSWORDS = new Set(['change-this-password', 'changeme', 'change-me']);

/**
 * @param {object} options
 * @param {object} options.config       suite.config.js (resolved here) or a resolveConfig() result
 * @param {Array}  [options.migrations] the app's own, numbered; they run before the suite's
 * @param {object} [options.hooks]
 *   extraColumns(user) → the app's own columns for a new account;
 *   onUserCreated(user), onUserRemoved(userId);
 *   oauthPage({ lang, title, body }) → HTML of the consent screen, dressed like the app;
 *   texts(req, user) → { lang, t } for that screen
 * @param {boolean} [options.exitOnError]  print and exit(1) on a configuration error (default),
 *   or throw a SuiteConfigError (tests)
 */
export function createSuite({
  config: given, migrations = [], hooks = {}, env = process.env, log = console.log, exitOnError = true,
}) {
  const config = given?.install ? given : resolveConfig(given, env);
  const tag = `[${config.app.id || 'app'}]`;
  const stop = (errors) => {
    if (!exitOnError) throw new SuiteConfigError(errors);
    for (const error of errors) console.error(`${tag} ${error}`);
    process.exit(1);
  };
  for (const warning of config.warnings) log(`${tag} ${warning}`);
  if (config.errors.length) stop(config.errors);

  const { install } = config;
  const database = openDatabase({ path: install.dbPath });
  migrate(database, migrations, { scope: 'app', log });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log });

  const sessions = createSessions({
    database,
    secret: resolveSessionSecret(database, { value: install.sessionSecret ?? '', tag, log }),
    cookieName: config.sessions.cookieName,
    secureCookies: install.secureCookies,
    idleDays: config.sessions.idleDays,
    maxDays: config.sessions.maxDays,
    trustProxy: install.trustProxy,
  });
  const accounts = createAccounts({
    database, sessions, minPasswordLength: config.accounts.minPasswordLength, roles: config.accounts.roles,
    extraColumns: hooks.extraColumns, onCreate: hooks.onUserCreated, onRemove: hooks.onUserRemoved,
  });
  const tokens = createTokens({ database, prefix: config.tokens.prefix });
  const audit = createAudit({ database, trustProxy: install.trustProxy });
  const limiter = createRateLimiter({
    database,
    // A key derived from the session secret: the buckets say nothing without it.
    secret: sessions.sign('rate-limit-buckets'),
    limits: config.rateLimits,
    trustProxy: install.trustProxy,
  });

  let organizations = null;
  const entitlements = createEntitlements({
    database, appId: config.app.id, features: config.features, plans: config.plans,
    defaultPlan: config.defaultPlan, plansJson: install.plansJson ?? null, defaultPlanOverride: install.defaultPlan ?? null,
    organizationsOf: (user) => (organizations ? organizations.organizationsOf(user) : []),
  });
  if (config.modules.organizations) {
    organizations = createOrganizations({
      database, roles: config.organizations.roles, seatsOf: entitlements.seatsOf,
      invitationDays: config.organizations.invitationDays,
    });
    accounts.whenRemoved((userId) => organizations.forgetUser(userId));
  }

  const billing = config.modules.billing ? createBilling({
    database, entitlements, products: config.products, audit, log,
    provider: install.billing ? signedProvider({ id: 'remote', secret: install.billing.secret, baseUrl: install.billing.url }) : null,
  }) : null;

  // A misspelled catalog could leave a barrier open, or charge for nothing.
  const late = [
    ...entitlements.errors.map((e) => `The plan catalog (PLANS) has errors: ${e}`),
    ...(billing?.errors || []).map((e) => `The products (billing) have errors: ${e}`),
  ];
  if (late.length) {
    if (!exitOnError) database.close();
    stop(late);
  }

  const workos = install.authProvider === 'workos' ? createWorkosAccounts({
    baseUrl: install.baseUrl,
    appName: config.app.name,
    workos: createWorkosClient(install.workos),
    adminEmail: install.admin.email,
    secureCookies: install.secureCookies,
    stateCookie: `${config.app.id.replace(/-/g, '_')}_auth`,
    users: workosUsers(accounts, { database }),
    sessions: {
      open: (res, userId, { workosSessionId }) => {
        sessions.open(userId, { res, idpSessionId: workosSessionId });
        audit.record({ action: 'auth.login', actor: userId, meta: { provider: 'workos' } });
      },
    },
    log,
  }) : null;

  const oauth = config.modules.oauth ? createOAuthServer({
    baseUrl: install.baseUrl,
    appName: config.app.name,
    // With WorkOS, AuthKit is the authorization server instead.
    enabled: install.mcpOAuth,
    allowPrivateCimd: install.cimdAllowPrivateHosts,
    db: { all: database.all, get: database.get, run: database.run },
    users: {
      login: (username, password) => accounts.verify(username, password),
      fromRequest: (req) => sessions.userFrom(req),
      byId: (id) => accounts.byId(id),
      handle: (user) => `@${user.username}`,
    },
    sessions: {
      open: (res, userId) => sessions.open(userId, { res }),
      tokenFrom: (req) => sessions.tokenFrom(req),
      sign: sessions.sign,
    },
    limits: {
      checkLogin: limiter.checkLogin, loginFailed: limiter.loginFailed,
      loginSucceeded: limiter.loginSucceeded, allowRegistration: limiter.allowRegistration,
    },
    ...(hooks.texts ? { texts: hooks.texts } : {}),
    page: hooks.oauthPage || plainPage(config.app.name),
    log,
  }) : null;
  if (oauth) accounts.whenRemoved((userId) => oauth.forgetUser(userId));

  /**
   * The first administrator of an install with local accounts, if there is
   * nobody yet. Without ADMIN_PASSWORD (or with an example one, or one too
   * short to be accepted) a random password is printed once: a fixed fallback
   * left every install that forgot the variable open with a password found in
   * every manual.
   */
  function ensureAdmin() {
    if (install.authProvider !== 'local') return null;
    if (database.get('SELECT COUNT(*) AS n FROM users').n > 0) return null;
    let username = install.admin.username;
    if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username)) {
      log(`${tag} ADMIN_USER "${username}" is not a valid username (letters, digits, . _ -): "admin" is used instead.`);
      username = 'admin';
    }
    let given = install.admin.password;
    if (given && EXAMPLE_PASSWORDS.has(given)) {
      log(`${tag} ADMIN_PASSWORD holds an example value: a random one is used instead.`);
      given = null;
    } else if (given && given.length < config.accounts.minPasswordLength) {
      log(`${tag} ADMIN_PASSWORD is shorter than ${config.accounts.minPasswordLength} characters: a random one is used instead.`);
      given = null;
    }
    const generated = given ? null : randomToken(12);
    const user = accounts.create({
      username, password: given || generated, displayName: install.admin.displayName || username, role: 'admin',
    });
    log(`${tag} admin user created: "${username}"`);
    if (generated) {
      log('');
      log('  ┌──────────────────────────────────────────────────────────┐');
      log('  │  ADMIN_PASSWORD was not set, so a random password was    │');
      log('  │  created for the first sign-in:                          │');
      log('  │                                                          │');
      log(`  │      ${generated.padEnd(52)}│`);
      log('  │                                                          │');
      log('  │  Copy it now: it is not shown again. Change it after     │');
      log('  │  signing in, in Settings.                                │');
      log('  └──────────────────────────────────────────────────────────┘');
      log('');
    }
    return user;
  }

  /** Ended sessions, old sign-in failures, audit entries over a year, long-expired tokens. */
  function purge() {
    sessions.purge();
    limiter.purge();
    audit.purge(365);
    tokens.purge();
  }

  /**
   * The account of an MCP token: an API token from Settings, which always
   * works; then one from the built-in OAuth or, with WorkOS, one signed by
   * AuthKit (which may throw WorkosUnavailable).
   */
  const authenticateToken = async (token) => tokens.authenticate(token, { scope: 'mcp' })
    || oauth?.userFromAccessToken(token) || (workos ? workos.userFromToken(token) : null);

  return {
    config, database, sessions, accounts, tokens, audit, limiter, entitlements, organizations, billing,
    workos, oauth, ensureAdmin, purge, authenticateToken,
  };
}

/** Paths clients use to negotiate authentication, not part of the web app. */
const DISCOVERY_PATHS = ['/.well-known', '/register', '/authorize', '/token', '/oauth'];

/**
 * @param {object} options
 * @param {object} options.suite          from createSuite()
 * @param {string} [options.publicDir]    the app's static files (index.html, js/, i18n/…)
 * @param {object|Function} [options.routes]  the app's router, or (router) => { … } to fill one
 * @param {object} [options.mcp]          { instructions, tools, prompts, legacyTools, legacyParams, describeError }
 * @param {Function} [options.serializeUser]  the account as the browser sees it (never its hash)
 * @param {object} [options.profile]      { alsoAt: { tokens, apps } }: older paths the app keeps
 * @param {string} [options.version]      the app's version, for /health and the MCP
 * @param {string} [options.watchRoot]    the folder hot reload watches (the server's, by default)
 * @param {string} [options.i18nDir]      the app's catalogs (<lang>.json), by default publicDir/i18n
 */
export function createApp({
  suite, publicDir = null, routes = null, mcp = null, serializeUser = null, profile = {},
  version = '0.0.0', watchRoot = null, i18nDir = null, handleSignals = true, log = console.log,
}) {
  const {
    config, sessions, accounts, tokens, audit, limiter, entitlements, organizations, billing, workos, oauth,
  } = suite;
  const { install } = config;
  const tag = `[${config.app.id}]`;
  const serialize = serializeUser || ((user) => (user ? accounts.publicUser(user) : null));

  /* --------------------------- the suite's routes --------------------------- */

  const api = createRouter();
  registerAuthApi(api, { accounts, sessions, limiter, audit, workos, serializeUser: serialize });
  registerProfileApi(api, {
    accounts, sessions, tokens, entitlements, oauth, audit,
    localPasswords: install.authProvider === 'local', alsoAt: profile.alsoAt || {},
  });
  if (config.modules.admin) registerAdminApi(api, { accounts, entitlements, organizations, sessions, audit });
  if (organizations) registerOrganizationsApi(api, { organizations, audit, baseUrl: install.baseUrl });
  if (billing?.enabled) registerBillingApi(api, { billing, organizations, baseUrl: install.baseUrl });

  let appApi = routes;
  if (typeof routes === 'function') {
    appApi = createRouter();
    routes(appApi);
  }

  /* --------------------------------- MCP ---------------------------------- */

  const mcpServer = mcp && config.modules.mcp ? createMcpServer({
    serverInfo: { name: config.app.id, title: config.app.name, version, ...(mcp.serverInfo || {}) },
    instructions: mcp.instructions,
    tools: mcp.tools,
    prompts: mcp.prompts,
    legacyTools: mcp.legacyTools,
    legacyParams: mcp.legacyParams,
    describeError: mcp.describeError,
    allows: entitlements.allows,
    authenticate: (token) => suite.authenticateToken(token),
    // With OAuth, the 401 says where the metadata is: that is what makes Claude
    // open the sign-in window instead of giving up.
    challenge: (hadToken) => (workos ? workos.challenge(hadToken)
      : oauth?.enabled ? oauth.challenge(hadToken) : `Bearer realm="${config.app.id}", error="invalid_token"`),
    oauthOffered: Boolean(workos) || Boolean(oauth?.enabled),
    unavailable: (error) => error instanceof WorkosUnavailable,
    limiter: { checkToken: limiter.checkToken, tokenFailed: limiter.tokenFailed, tokenSucceeded: limiter.tokenSucceeded },
  }) : null;

  /* ---------------------------- frontend version --------------------------- */

  /**
   * Fingerprint of the frontend: dates and sizes of the files the browser
   * loads. With the code mounted from the project folder, editing it is enough
   * to change it, without restarting anything. Cached for a few seconds.
   */
  let versionCache = { value: null, at: 0 };
  function frontVersion() {
    if (versionCache.value && Date.now() - versionCache.at < 5000) return versionCache.value;
    let newest = 0;
    const parts = [];
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|css|html|json|webmanifest)$/.test(entry.name)) {
          try {
            const stat = fs.statSync(full);
            parts.push(`${entry.name}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
            if (stat.mtimeMs > newest) newest = stat.mtimeMs;
          } catch { /* file just moved */ }
        }
      }
    };
    if (publicDir) walk(publicDir);
    const value = {
      app: version,
      version: crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12),
      built: newest ? new Date(newest).toISOString() : null,
    };
    versionCache = { value, at: Date.now() };
    return value;
  }

  /* ------------------------------ translations ----------------------------- */

  /**
   * The catalog the browser loads for a language: the suite's texts (errors,
   * fields, its screens) with the app's over them, in the app's own shape.
   * Rebuilt when the app's file changes: the public folder is edited live.
   */
  const catalogDir = i18nDir || (publicDir ? path.join(publicDir, 'i18n') : null);
  const catalogs = new Map();
  function catalogFor(lang) {
    const file = catalogDir ? path.join(catalogDir, `${lang}.json`) : null;
    let mtime = -1;
    try { if (file) mtime = fs.statSync(file).mtimeMs; } catch { /* the app has none for it */ }
    const cached = catalogs.get(lang);
    if (cached && cached.mtime === mtime) return cached;
    let own = {};
    if (mtime >= 0) {
      try {
        own = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        console.error(`${tag} ${file} is not valid JSON: ${err.message}`);
      }
    }
    const body = JSON.stringify(mergeCatalogs(SUITE_CATALOGS[lang] || {}, own));
    const entry = { mtime, body, etag: `W/"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"` };
    catalogs.set(lang, entry);
    return entry;
  }

  /* -------------------------------- dispatch ------------------------------- */

  /** The route of a request among the suite's and the app's, or what to answer. */
  function route(method, pathname) {
    const found = [api, appApi].map((router) => router?.match(method, pathname)).filter(Boolean);
    const exact = found.find((m) => m.handler);
    if (exact) return exact;
    if (!found.length) return null;
    return { methodMismatch: true, allow: [...new Set(found.flatMap((m) => m.allow.split(', ')))].join(', ') };
  }

  async function handle(req, res) {
    const start = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Before anything else, so they reach every response.
    securityHeaders(res, { https: install.https });

    try {
      // A write that rides on the session cookie must come from the app's own
      // pages: another site can make a browser send the cookie, not the Origin.
      checkOrigin(req, { baseUrl: install.baseUrl, cookieName: sessions.cookieName });

      if (pathname === '/health') {
        sendJson(res, 200, { ok: true, uptime: process.uptime(), version: frontVersion() });
        return;
      }
      // So the installed app knows there is something new and can offer to reload.
      if (pathname === '/version') {
        sendJson(res, 200, frontVersion());
        return;
      }
      // Generated with the code version and cached like the rest of the
      // JavaScript: an old cached copy of the app brings an old copy of this too.
      if (pathname === '/js/app-version.js') {
        const { app, version: fingerprint, built } = frontVersion();
        const body = `export const APP_NAME_VERSION = '${app}';\n`
          + `export const APP_VERSION = '${fingerprint}';\n`
          + `export const APP_BUILT = ${built ? `'${built}'` : 'null'};\n`;
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-cache',
          ETag: `W/"${fingerprint}"`,
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      if (mcpServer && (pathname === '/mcp' || pathname.startsWith('/mcp/'))) {
        await mcpServer.handle(req, res, url);
        return;
      }
      // How to set up the connector, to check it from the browser. It says
      // nothing that whoever holds a token doesn't already know.
      if (mcpServer && pathname === '/mcp-info') {
        sendJson(res, 200, mcpServer.info(install.baseUrl));
        return;
      }

      if (pathname.startsWith('/api/')) {
        const match = route(req.method, pathname);
        if (!match) {
          sendJson(res, 404, { error: 'not_found' });
          return;
        }
        if (match.methodMismatch) {
          sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: match.allow });
          return;
        }
        await match.handler({
          req, res, url,
          params: match.params,
          query: url.searchParams,
          user: sessions.userFrom(req),
          sessionToken: sessions.tokenFrom(req),
          baseUrl: install.baseUrl,
        });
        return;
      }

      if (workos && await workos.handle(req, res, url)) return;
      if (oauth && await oauth.handle(req, res, url)) return;

      // Discovery paths this install doesn't serve answer a clean JSON 404,
      // never the app: a client looking for OAuth metadata chokes on HTML.
      if (DISCOVERY_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
        sendJson(res, 404, { error: 'No OAuth here: use a Bearer token' });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method Not Allowed');
        return;
      }
      const wanted = /^\/i18n\/([a-z]{2})\.json$/.exec(pathname)?.[1];
      if (wanted && config.app.languages.includes(wanted)) {
        const { body, etag } = catalogFor(wanted);
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-cache',
          ETag: etag,
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      if (publicDir) {
        if (serveStatic(publicDir, pathname === '/' ? '/index.html' : pathname, res)) return;
        // The SPA's own paths.
        if (!path.extname(pathname) && serveStatic(publicDir, '/index.html', res)) return;
      }
      sendText(res, 404, 'Not found');
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, ...err.extra }, err.headers);
        return;
      }
      console.error(`[error] ${req.method} ${pathname} (${Date.now() - start}ms)`, err);
      sendJson(res, 500, { error: 'internal' });
    }
  }

  const server = http.createServer(handle);
  server.headersTimeout = 65000;
  server.requestTimeout = 0;   // live channels stay open

  const timers = [];

  /** Creates the first administrator if needed, starts the clean-ups and listens. */
  function listen() {
    suite.ensureAdmin();
    suite.purge();
    timers.push(setInterval(() => suite.purge(), 6 * HOUR).unref());
    if (oauth) {
      oauth.purge();
      timers.push(setInterval(() => oauth.purge(), HOUR).unref());
    }
    if (handleSignals) {
      const shutdown = (signal) => {
        log(`${tag} ${signal} received, closing…`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 5000).unref();
      };
      process.once('SIGTERM', () => shutdown('SIGTERM'));
      process.once('SIGINT', () => shutdown('SIGINT'));
    }
    return new Promise((resolve) => {
      server.listen(install.port, install.host, () => {
        log(`${tag} listening on http://${install.host}:${server.address().port}`);
        log(`${tag} public URL: ${install.baseUrl}`);
        if (install.hotReload) {
          timers.push(watchCode({ root: watchRoot || path.dirname(path.resolve(process.argv[1] || '.')), log }));
        }
        resolve(server);
      });
    });
  }

  function close() {
    for (const timer of timers) clearInterval(timer);
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, api, mcp: mcpServer, handle, listen, close };
}
