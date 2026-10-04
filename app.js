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
import { fileURLToPath } from 'node:url';
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
import { stripeProvider } from './stripe.js';
import { createWorkosClient, WorkosUnavailable } from './workos.js';
import { createWorkosAccounts, workosUsers } from './workos-accounts.js';
import { createOidcClient, createOidcAccounts } from './oidc.js';
import { createMailer } from './mail.js';
import { createAccountMail } from './account-mail.js';
import { createTexts } from './i18n.js';
import { createOAuthServer } from './oauth.js';
import { brandedPage } from './oauth-page.js';
import { brandedAdmin } from './brand.js';
import { createTwoFactor } from './two-factor.js';
import { createLive } from './live.js';
import { createPush, vapidKeys } from './push.js';
import { createUploads } from './uploads.js';
import { createPortability, registerPortabilityApi } from './portability.js';
import { createMcpServer } from './mcp.js';
import {
  registerAuthApi, registerAccountMailApi, registerProfileApi, registerAdminApi, registerOrganizationsApi, registerPushApi,
} from './api.js';
import {
  HttpError, createRouter, sendJson, sendText, serveStatic, securityHeaders, checkOrigin, unauthorized,
} from './http.js';
import { watchCode } from './watcher.js';
import { SUITE_CATALOGS, mergeCatalogs } from './i18n.js';

const HOUR = 3600 * 1000;
/** The suite's browser code, served at /suite/. */
const WEB_DIR = fileURLToPath(new URL('./web/', import.meta.url));

/** A configuration that can't run: what createSuite throws when it isn't told to exit. */
export class SuiteConfigError extends Error {
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'SuiteConfigError';
    this.errors = errors;
  }
}

/** Passwords from examples and old defaults: known to anyone, so never used. */
const EXAMPLE_PASSWORDS = new Set([
  'change-this-password', 'changeme', 'change-me',
  // The ones the apps' own .env.example files carried before the suite.
  'cambia-esta-clave', 'cambia-esto',
]);

/**
 * @param {object} options
 * @param {object} options.config       suite.config.js (resolved here) or a resolveConfig() result
 * @param {Array}  [options.migrations] the app's own, numbered; they run before the suite's
 * @param {object} [options.hooks]
 *   extraColumns(user) → the app's own columns for a new account;
 *   onUserCreated(user), onUserRemoved(userId);
 *   oauthPage({ lang, title, body, theme }) → HTML of the consent screen, when the app dresses it
 *     itself instead of the suite's (oauth-page.js, with app.color and app.icon);
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
  // Notices for the open tabs (GET /api/events, with modules.live): the app publishes what changed.
  const live = createLive();
  // A code from an app after the password; with a provider, the second step is the provider's.
  const twoFactor = install.authProvider === 'local'
    ? createTwoFactor({
      database, sign: sessions.sign, issuer: config.app.name, limiter, onChange: (id) => accounts.changed(id),
    })
    : null;
  // An account that changed —its email confirmed from the mail, a new password, the second
  // step, what the admin changed— tells the person's open tabs, which reload what they show.
  accounts.whenChanged((id) => live.publish({ audience: [id], event: 'account', data: { user_id: id } }));

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

  const billingProvider = !install.billing ? null
    : install.billing.provider === 'stripe' ? stripeProvider({
      secretKey: install.billing.secretKey, webhookSecret: install.billing.webhookSecret,
      apiBase: install.billing.apiBase, products: config.products, log,
    })
      : signedProvider({ id: 'remote', secret: install.billing.secret, baseUrl: install.billing.url });
  const billing = config.modules.billing ? createBilling({
    database, entitlements, products: config.products, audit, log, provider: billingProvider,
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

  const oidc = install.authProvider === 'oidc' ? createOidcAccounts({
    baseUrl: install.baseUrl,
    oidc: createOidcClient(install.oidc),
    accounts,
    adminEmail: install.admin.email,
    secureCookies: install.secureCookies,
    stateCookie: `${config.app.id.replace(/-/g, '_')}_oidc`,
    sessions: {
      open: (res, userId, { idpSessionId }) => {
        sessions.open(userId, { res, idpSessionId });
        audit.record({ action: 'auth.login', actor: userId, meta: { provider: 'oidc' } });
      },
    },
    log,
  }) : null;
  /** Where people sign in when it isn't here with a password. */
  const idp = workos || oidc;

  const oauth = config.modules.oauth ? createOAuthServer({
    baseUrl: install.baseUrl,
    appName: config.app.name,
    // With WorkOS, AuthKit is the authorization server instead.
    enabled: install.mcpOAuth,
    allowPrivateCimd: install.cimdAllowPrivateHosts,
    db: { all: database.all, get: database.get, run: database.run },
    users: {
      // Noted as a sign-in when the session opens: a second step may come first.
      login: (username, password) => accounts.verify(username, password, { signIn: false }),
      fromRequest: (req) => sessions.userFrom(req),
      byId: (id) => accounts.byId(id),
      handle: (user) => `@${user.username}`,
    },
    sessions: {
      open: (res, userId) => {
        sessions.open(userId, { res });
        accounts.signedIn(userId);
      },
      tokenFrom: (req) => sessions.tokenFrom(req),
      sign: sessions.sign,
    },
    secondStep: twoFactor && {
      required: (user) => twoFactor.isEnabled(user.id),
      challengeFor: twoFactor.challengeFor,
      userOf: (challenge) => {
        const user = accounts.byId(twoFactor.readChallenge(challenge));
        return user && !user.disabled_at ? user : null;
      },
      pass: twoFactor.pass,
    },
    limits: {
      checkLogin: limiter.checkLogin, loginFailed: limiter.loginFailed,
      loginSucceeded: limiter.loginSucceeded, allowRegistration: limiter.allowRegistration,
    },
    ...(hooks.texts ? { texts: hooks.texts } : {}),
    page: hooks.oauthPage || brandedPage(config.app),
    // With OIDC, whoever isn't signed in goes to the provider and comes back.
    externalSignIn: oidc ? { name: oidc.name, url: oidc.signInUrl } : null,
    log,
  }) : null;
  if (oauth) accounts.whenRemoved((userId) => oauth.forgetUser(userId));

  // Web Push, with modules.push: the install's VAPID keys (the environment's, or the database's).
  const push = config.modules.push ? createPush({
    database, vapid: vapidKeys(database, install.push, { log: (line) => log(`${tag} ${line}`) }), log,
  }) : null;
  // Files people attach, with modules.uploads: stored, served and swept here; the app keeps its table.
  const uploads = config.modules.uploads
    ? createUploads({ dir: path.join(install.dataDir, 'uploads'), log: (line) => log(line) })
    : null;
  // The screens' texts (the OAuth consent, mail, a test notice): the app's hook, or the suite's.
  const texts = hooks.texts || createTexts();

  // Mail: an SMTP server, or the server's log until one is set.
  const mailer = createMailer(install.mail, { log });
  const accountMail = createAccountMail({
    database, accounts, mailer, texts, baseUrl: install.baseUrl,
    appName: config.app.name, limiter, audit, signup: config.accounts.signup,
    localPasswords: install.authProvider === 'local', roles: config.accounts.roles, log,
  });

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
      // With it, a forgotten password can be recovered by mail.
      email: install.admin.email || null,
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
    accountMail.purge();
  }

  /**
   * The account of an MCP token: an API token from Settings, which always
   * works; then one from the built-in OAuth or, with WorkOS, one signed by
   * AuthKit (which may throw WorkosUnavailable).
   */
  const authenticateToken = async (token) => tokens.authenticate(token, { scope: 'mcp' })
    || oauth?.userFromAccessToken(token) || (workos ? workos.userFromToken(token) : null);

  /**
   * Copies of an account or of the install (portability.js), from what the
   * app says its data is. createApp makes it when it is given `portable`; a
   * script of the app (its command line) makes it the same way.
   */
  const portabilityFor = (declaration, { version = null } = {}) => createPortability({
    database, accounts, uploads, entitlements, live, audit,
    app: { id: config.app.id, name: config.app.name, version }, roles: config.accounts.roles,
    baseUrl: install.baseUrl, authProvider: install.authProvider, dataDir: install.dataDir, declaration, log,
  });

  return {
    config, database, sessions, accounts, tokens, audit, limiter, twoFactor, live, push, uploads, texts, entitlements,
    organizations, billing, workos, oidc, idp, oauth, mailer, accountMail, ensureAdmin, purge, authenticateToken,
    portabilityFor,
  };
}

/** Paths clients use to negotiate authentication, not part of the web app. */
const DISCOVERY_PATHS = ['/.well-known', '/register', '/authorize', '/token', '/oauth'];

/**
 * Whether serveStatic would look for `pathname` in the catalogs' folder (public/i18n) on any
 * disk: decoded and normalized as it does, with Windows' own leniency (any case, a backslash,
 * trailing dots or spaces, an NTFS stream after a colon) in the folder's name.
 */
function inCatalogDir(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }   // serveStatic refuses it too
  const first = path.posix.normalize(`/${decoded.replace(/\\/g, '/')}`).split('/')[1];
  return first.toLowerCase().split(':')[0].replace(/[. ]+$/, '') === 'i18n';
}

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
 * @param {object} [options.portable]     what the app's data is (portability.js): with it, people
 *   download and import their data, and the admin the whole install
 */
export function createApp({
  suite, publicDir = null, routes = null, mcp = null, serializeUser = null, profile = {},
  version = '0.0.0', watchRoot = null, i18nDir = null, handleSignals = true, log = console.log, portable = null,
}) {
  const {
    config, sessions, accounts, tokens, audit, limiter, twoFactor, live, push, texts, entitlements, organizations,
    billing, workos, idp, oauth, mailer, accountMail,
  } = suite;
  const { install } = config;
  const tag = `[${config.app.id}]`;
  const serialize = serializeUser || ((user) => (user ? accounts.publicUser(user) : null));

  /* --------------------------- the suite's routes --------------------------- */

  // Copies of accounts and of the install, when the app says what its data is.
  const portability = portable ? suite.portabilityFor(portable, { version }) : null;

  const api = createRouter();
  registerAuthApi(api, {
    accounts, sessions, limiter, audit, idp, serializeUser: serialize, signup: config.accounts.signup,
    mail: mailer.provider !== 'log', passwordMin: config.accounts.minPasswordLength, twoFactor,
    app: {
      id: config.app.id, name: config.app.name, languages: config.app.languages,
      modules: { organizations: Boolean(organizations), billing: Boolean(billing?.enabled), data: Boolean(portability) },
    },
  });
  if (install.authProvider === 'local') {
    registerAccountMailApi(api, {
      accountMail, sessions, accounts, serializeUser: serialize, admin: config.modules.admin, twoFactor,
    });
  }
  registerProfileApi(api, {
    accounts, sessions, tokens, entitlements, oauth, audit, limiter, twoFactor,
    localPasswords: install.authProvider === 'local', alsoAt: profile.alsoAt || {},
  });
  if (config.modules.admin) registerAdminApi(api, { accounts, entitlements, organizations, sessions, audit, twoFactor });
  if (organizations) registerOrganizationsApi(api, { organizations, audit, baseUrl: install.baseUrl });
  if (push) registerPushApi(api, { push, texts, appName: config.app.name });
  if (config.modules.live) {
    /** The live channel of this tab: notices of what changed for this person (live.js). */
    api.get('/api/events', (ctx) => {
      if (!ctx.user) throw unauthorized();
      live.subscribe(ctx.req, ctx.res, ctx.user);
    });
  }
  if (billing?.enabled) registerBillingApi(api, { billing, organizations, baseUrl: install.baseUrl });
  if (portability) registerPortabilityApi(api, { portability, audit, log });

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

      if (idp && await idp.handle(req, res, url)) return;
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
      // The suite's browser code (the web kit) and its admin panel.
      if (pathname.startsWith('/suite/') && serveStatic(WEB_DIR, pathname.slice('/suite'.length), res)) return;
      if (config.modules.admin && (pathname === '/admin' || pathname === '/admin/')) {
        // Read on every request: it is small, and a new suite-core is served without a restart.
        const page = brandedAdmin(fs.readFileSync(path.join(WEB_DIR, 'admin.html'), 'utf8'), config.app);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : page);
        return;
      }
      // /i18n/ is the suite's: a catalog is only ever served merged, and anything else there is a
      // 404 that never reaches the static files, where a case-insensitive disk would answer
      // EN.json or en.json::$DATA with the app's raw en.json.
      if (inCatalogDir(pathname)) {
        const wanted = /^\/i18n\/([a-z]{2})\.json$/.exec(pathname)?.[1];
        if (!wanted || !config.app.languages.includes(wanted)) {
          sendText(res, 404, 'Not found');
          return;
        }
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
    portability?.purge();
    timers.push(setInterval(() => { suite.purge(); portability?.purge(); }, 6 * HOUR).unref());
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
        // Whether mail can go out, said once at the start: a wrong MAIL_* shows
        // up here instead of in the first message that never arrives.
        if (suite.mailer?.provider === 'smtp') {
          suite.mailer.verify().then(
            () => log(`[mail] SMTP ready: ${install.mail.host}:${install.mail.port} (${install.mail.secure})`),
            (err) => log(`[mail] SMTP check failed, nothing will be sent until MAIL_* are fixed: ${err.message}`),
          );
        }
        if (install.hotReload) {
          timers.push(watchCode({ root: watchRoot || path.dirname(path.resolve(process.argv[1] || '.')), log }));
        }
        resolve(server);
      });
    });
  }

  function close() {
    for (const timer of timers) clearInterval(timer);
    // Open tabs would keep the server from closing.
    live.close();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, api, mcp: mcpServer, portability, handle, listen, close };
}
