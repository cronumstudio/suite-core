/**
 * Several apps of the suite as one: the host, each app a module at its own path.
 *
 *   // the host's server
 *   const host = await createHost({
 *     config: product,                             // the host's suite.config.js: name, cookie, plans…
 *     modules: [
 *       { mount: 'tasks', entry: new URL('./modules/tasks/server/module.js', import.meta.url) },
 *       { mount: 'notes', entry: new URL('./modules/notes/server/module.js', import.meta.url) },
 *     ],
 *   });
 *   await host.listen();
 *
 *   // an app's server/platform.js: inside a host it joins it, on its own nothing changes
 *   export const suite = joinHost({ config: product, migrations, hooks })
 *     ?? createSuite({ config: product, migrations, hooks });
 *
 *   // an app's server/module.js: what its index.js hands to createApp, for the host to do the same
 *   export function createModule() {
 *     return { publicDir, routes: api, serializeUser, version, portable, start: () => stopTimers };
 *   }
 *
 * One process, one database (DATA_DIR/<host id>.db), one session cookie, one
 * table of accounts, one sign-in and one admin panel, all of them the host's,
 * from its own configuration. Each module keeps what is its own: its tables
 * and migrations (scope: its app id), its routes, its plan features, its live
 * channel, its folder of uploads (DATA_DIR/uploads/<app id>), its texts and
 * what its data is for copies.
 *
 * A module is a whole app at /<mount>/: the host takes the prefix off and
 * hands the request to a createApp() of its own, so the module's API answers
 * at /<mount>/api/…, the web kit at /<mount>/suite/…, its catalogs, its
 * app-version.js, its service worker and its files, exactly as the app does
 * on its own. Two modules can have the same routes and nothing collides. What
 * belongs to the whole app stays at the root: /api/auth and the rest of the
 * suite's routes, /admin, /auth (the identity provider comes back to
 * /auth/callback), the OAuth paths, /health and /version.
 *
 * The app on its own keeps calling createSuite() and createApp() as before:
 * nothing of this runs unless a host is loading it.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createSuite, createApp, SuiteConfigError } from './app.js';
import { resolveConfig } from './config.js';
import { migrate } from './migrate.js';
import { createEntitlements } from './entitlements.js';
import { createLive } from './live.js';
import { createUploads } from './uploads.js';
import { createTexts } from './i18n.js';
import { createPortability } from './portability.js';
import { sendJson, securityHeaders } from './http.js';
import { watchCode } from './watcher.js';

const HOUR = 3600 * 1000;
const MINUTE_BEFORE_SWEEP = 60 * 1000;

/**
 * Where a loading host waits for its module to join. On globalThis, under a
 * registered symbol, so that a module whose server/suite is another copy of
 * suite-core still finds it, and the host can say what is wrong instead of the
 * module quietly opening a database of its own.
 */
const HOST = Symbol.for('suite-core.host');
/** This copy of suite-core: a host and its modules must run one, or an HttpError of one isn't the other's. */
const HERE = import.meta.url;

/** A module's path: lowercase, like an app id. */
const MOUNT = /^[a-z][a-z0-9-]{1,30}$/;
/** First segments that are the host's own at the root, or a client's guess at it: never a module's path. */
const RESERVED = new Set([
  'api', 'suite', 'i18n', 'admin', 'auth', 'oauth', 'mcp', 'mcp-info', 'health', 'version', 'register',
  'authorize', 'token', 'js', 'css', 'icons', 'fonts',
]);
/** Scopes migrations already use: a module's app id can't be one of them. */
const TAKEN_SCOPES = new Set(['app', 'suite']);
/** Suite modules that are one object for the whole host: a module that uses one needs the host to have it. */
const SHARED_MODULES = ['organizations', 'billing', 'push'];

/** Whether a URL is a path of the site (`/icons/a.png`), not a relative one nor another site's. */
const sitePath = (url) => typeof url === 'string' && url.startsWith('/') && !url.startsWith('//');

/** A path of a module's (`/icons/a.png`) at the module's place in the host (`/tasks/icons/a.png`). */
export const mountedPath = (mount, url) => (sitePath(url) ? `/${mount}${url}` : url);

/**
 * A module's web manifest as the host serves it: every path of the site moved
 * under the module's, and the scope and start at the module's place. The app's
 * own file doesn't change: on its own, its identity (`id`, `start_url`,
 * `scope`) is what phones already installed, and must stay as it is.
 */
export function mountManifest(manifest, mount) {
  const at = (url) => mountedPath(mount, url);
  const images = (list) => (Array.isArray(list)
    ? list.map((item) => (item && typeof item === 'object' ? { ...item, src: at(item.src) } : item)) : list);
  const out = { ...manifest, start_url: at(manifest.start_url ?? '/'), scope: at(manifest.scope ?? '/') };
  if (manifest.id !== undefined) out.id = at(manifest.id);
  if (manifest.icons !== undefined) out.icons = images(manifest.icons);
  if (manifest.screenshots !== undefined) out.screenshots = images(manifest.screenshots);
  if (Array.isArray(manifest.shortcuts)) {
    out.shortcuts = manifest.shortcuts.map((s) => (s && typeof s === 'object'
      ? { ...s, url: at(s.url), ...(s.icons !== undefined ? { icons: images(s.icons) } : {}) } : s));
  }
  if (manifest.share_target && typeof manifest.share_target === 'object') {
    out.share_target = { ...manifest.share_target, action: at(manifest.share_target.action) };
  }
  return out;
}

/**
 * The suite of an app inside a host that is loading it, or null anywhere else
 * —the app on its own—, where the app goes on with createSuite() as always.
 * Same options as createSuite: the app's suite.config.js, its migrations and
 * its hooks.
 */
export function joinHost(options) {
  const host = globalThis[HOST];
  if (!host?.joining) return null;
  return host.join(options, HERE);
}

/** What is wrong in a list of modules, before anything is opened. */
function moduleListErrors(modules) {
  const errors = [];
  if (!Array.isArray(modules) || !modules.length) return ['modules: a host needs at least one module'];
  const seen = new Set();
  for (const [i, spec] of modules.entries()) {
    const mount = spec?.mount;
    if (!MOUNT.test(String(mount ?? ''))) errors.push(`modules[${i}].mount "${mount}": lowercase letters, digits and -, starting with a letter`);
    else if (RESERVED.has(mount)) errors.push(`modules[${i}].mount "${mount}" is a path of the host's own`);
    else if (seen.has(mount)) errors.push(`modules[${i}].mount "${mount}" is mounted twice`);
    seen.add(mount);
    if (!spec?.entry) errors.push(`modules[${i}].entry: the module's server/module.js is needed`);
  }
  return errors;
}

/**
 * @param {object} options
 * @param {object} options.config       the host's suite.config.js: its app (id, name, colour, icon:
 *   the cookie, the database, the sign-in, the consent screen and /admin are the host's), the
 *   suite's modules for everyone (a module that uses push, billing or organizations needs them on),
 *   accounts, sessions, plans and products
 * @param {Array}  options.modules      [{ mount, entry }]: each module's path and its server/module.js
 * @param {Array}  [options.migrations] the host's own tables, under the scope `app`
 * @param {object} [options.hooks]      as createSuite's; extraColumns joins the modules' own
 * @param {string} [options.publicDir]  the host's own pages at the root; without them, / goes to the first module
 * @param {Function} [options.routes]   (router) => { … }: the host's own routes at /api/
 * @param {string} [options.version]
 * @param {boolean} [options.exitOnError]  print and exit(1) on a configuration error (default),
 *   or throw a SuiteConfigError (tests)
 */
export async function createHost({
  config: product, modules = [], migrations = [], hooks = {}, publicDir = null, routes = null,
  version = '0.0.0', env = process.env, log = console.log, exitOnError = true, handleSignals = true, watchRoot = null,
}) {
  /** The modules that joined, in order: their hooks count from then on. */
  const joined = [];
  let suite = null;
  const stop = (errors) => {
    if (!exitOnError) {
      suite?.database.close();
      throw new SuiteConfigError(errors);
    }
    for (const error of errors) console.error(`[host] ${error}`);
    process.exit(1);
  };

  const listErrors = moduleListErrors(modules);
  if (listErrors.length) stop(listErrors);

  suite = createSuite({
    config: product, migrations, env, log, exitOnError,
    hooks: {
      ...hooks,
      // One table of accounts: a new one gets each module's columns as well as the host's.
      extraColumns: (user) => Object.assign({}, hooks.extraColumns?.(user),
        ...joined.map((m) => m.hooks.extraColumns?.(user) || {})),
    },
  });
  const { config } = suite;
  const { install } = config;
  const tag = `[${config.app.id}]`;

  /**
   * The suite a module gets: the host's, with what is the module's own in place
   * of it. Its migrations run here, after the suite's: its first one finds the
   * suite's tables (users with the suite's columns) already there. The host's
   * consent screen and mail are the host's: a module's oauthPage hook is not used.
   */
  function join(entry, options, from) {
    if (from !== HERE) {
      throw new SuiteConfigError([`${entry.mount}: it runs suite-core from ${from}, the host from ${HERE}; a host and `
        + 'its modules run one copy (the module\'s server/suite must be the host\'s)']);
    }
    if (entry.view) throw new SuiteConfigError([`${entry.mount}: it joined the host twice`]);
    const { config: own, migrations: ownMigrations = [], hooks: ownHooks = {} } = options || {};
    // The product only: where and how the module runs is the host's install.
    const resolved = resolveConfig(own, {});
    const errors = resolved.errors.map((e) => `${entry.mount}: ${e}`);
    const { app } = resolved;
    if (TAKEN_SCOPES.has(app.id)) errors.push(`${entry.mount}: app.id "${app.id}" is a scope of migrations; a module needs another id`);
    if (app.id === config.app.id) errors.push(`${entry.mount}: app.id "${app.id}" is the host's`);
    const twin = joined.find((m) => m.config.app.id === app.id);
    if (twin) errors.push(`${entry.mount}: app.id "${app.id}" is the module at /${twin.mount}/ already`);
    for (const name of SHARED_MODULES) {
      if (resolved.modules[name] && !config.modules[name]) errors.push(`${entry.mount}: it uses modules.${name}, which the host has off`);
    }
    if (errors.length) throw new SuiteConfigError(errors);

    const moduleInstall = { ...install, baseUrl: `${install.baseUrl}/${entry.mount}` };
    const moduleConfig = {
      ...config,
      app,
      // Its own channel and uploads; the host's MCP (one for all) and admin panel.
      modules: { ...resolved.modules, oauth: config.modules.oauth, admin: config.modules.admin, mcp: false },
      features: resolved.features,
      plans: resolved.plans,
      defaultPlan: resolved.defaultPlan,
      install: moduleInstall,
      // Where it is: for what an app does differently inside a host, if anything.
      host: { id: config.app.id, name: config.app.name, mount: entry.mount, base: `/${entry.mount}/` },
      errors: [],
      warnings: [],
    };
    // The plans are the install's (PLANS); the features, the module's. A grant
    // of a plan counts in every module, one of `<app id>.<feature>` only in its own.
    const entitlements = createEntitlements({
      database: suite.database, appId: app.id, features: resolved.features, plans: resolved.plans,
      defaultPlan: resolved.defaultPlan, plansJson: install.plansJson ?? null, defaultPlanOverride: install.defaultPlan ?? null,
      organizationsOf: (user) => (suite.organizations ? suite.organizations.organizationsOf(user) : []),
    });
    if (entitlements.errors.length) {
      throw new SuiteConfigError(entitlements.errors.map((e) => `${entry.mount}: the plan catalog (PLANS) has errors: ${e}`));
    }
    // Only once nothing stands in the way: a migration applied has no way back.
    migrate(suite.database, ownMigrations, { scope: app.id, log });
    // Its own notices: another module's open tabs don't reload for them. An
    // account that changed is everyone's.
    const live = createLive();
    suite.accounts.whenChanged((id) => live.publish({ audience: [id], event: 'account', data: { user_id: id } }));
    if (ownHooks.onUserCreated) suite.accounts.whenCreated(ownHooks.onUserCreated);
    if (ownHooks.onUserRemoved) suite.accounts.whenRemoved(ownHooks.onUserRemoved);
    // A folder of its own: each module sweeps the files its table doesn't know,
    // and in a folder shared with another it would take the other's for orphans.
    const uploads = resolved.modules.uploads
      ? createUploads({ dir: path.join(install.dataDir, 'uploads', app.id), log: (line) => log(line) })
      : null;
    const portabilityFor = (declaration, { version: v = null, limits = {} } = {}) => createPortability({
      database: suite.database, accounts: suite.accounts, uploads, entitlements, live, audit: suite.audit,
      app: { id: app.id, name: app.name, version: v }, roles: config.accounts.roles,
      baseUrl: moduleInstall.baseUrl, authProvider: install.authProvider, dataDir: install.dataDir, declaration, log, limits,
    });

    entry.config = moduleConfig;
    entry.hooks = ownHooks;
    entry.view = {
      ...suite,
      config: moduleConfig,
      entitlements,
      live,
      uploads,
      texts: ownHooks.texts || createTexts(),
      portabilityFor,
      push: resolved.modules.push ? suite.push : null,
      organizations: resolved.modules.organizations ? suite.organizations : null,
      billing: resolved.modules.billing ? suite.billing : null,
      // The host's to do, once for everyone.
      ensureAdmin: () => null,
      purge: () => {},
    };
    joined.push(entry);
    return entry.view;
  }

  /* ----------------------------- the modules ----------------------------- */

  for (const spec of modules) {
    // A file URL or a specifier, as import() takes it; an absolute path of this disk becomes one.
    const target = !(spec.entry instanceof URL) && path.isAbsolute(String(spec.entry))
      ? pathToFileURL(String(spec.entry)).href : String(spec.entry);
    const entry = { mount: spec.mount, entry: target, view: null };
    globalThis[HOST] = { joining: entry, join: (options, from) => join(entry, options, from) };
    let imported;
    try {
      imported = await import(entry.entry);
    } catch (err) {
      if (err instanceof SuiteConfigError) stop(err.errors);
      suite.database.close();
      throw err;
    } finally {
      delete globalThis[HOST];
    }
    if (!entry.view) {
      stop([`${entry.mount}: ${entry.entry} didn't join the host; its server/platform.js must try joinHost() before createSuite()`]);
    }
    if (typeof imported.createModule !== 'function') stop([`${entry.mount}: ${entry.entry} exports no createModule()`]);
    const parts = (await imported.createModule({ mount: entry.mount, base: `/${entry.mount}/` })) || {};
    entry.parts = parts;
    entry.app = createApp({
      suite: entry.view, publicDir: parts.publicDir ?? null, routes: parts.routes ?? null,
      serializeUser: parts.serializeUser ?? null, profile: parts.profile ?? {}, version: parts.version ?? '0.0.0',
      i18nDir: parts.i18nDir ?? null, portable: parts.portable ?? null, handleSignals: false, log,
    });
  }
  const byMount = new Map(joined.map((m) => [m.mount, m]));

  /* ------------------------------ the root ------------------------------- */

  /** What the host's pages show of each module: where it is and what it looks like. */
  const listed = joined.map((m) => ({
    mount: m.mount, path: `/${m.mount}/`, id: m.config.app.id, name: m.config.app.name,
    color: m.config.app.color, icon: mountedPath(m.mount, m.config.app.icon),
  }));
  const root = createApp({
    suite, publicDir, version, handleSignals: false, log,
    routes: (api) => {
      api.get('/api/modules', (ctx) => sendJson(ctx.res, 200, { modules: listed }));
      if (typeof routes === 'function') routes(api);
    },
  });

  /* ------------------------------- dispatch ------------------------------ */

  /** A module's manifest, rewritten for its place, kept until the file changes. */
  function manifestOf(m) {
    const dir = m.parts.publicDir;
    if (!dir) return null;
    const file = path.join(dir, 'manifest.webmanifest');
    let mtime;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
    if (m.manifest?.mtime === mtime) return m.manifest;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`${tag} ${file} is not valid JSON: ${err.message}`);
      return null;
    }
    const body = JSON.stringify(mountManifest(data, m.mount));
    m.manifest = { mtime, body, etag: `W/"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"` };
    return m.manifest;
  }

  const redirect = (res, status, location) => {
    securityHeaders(res, { https: install.https });
    res.writeHead(status, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
  };

  /** The module a request is for, with the prefix taken off; anything else is the root's. */
  async function handle(req, res) {
    let url;
    try {
      url = new URL(String(req.url || ''), 'http://host.invalid');
    } catch {
      return root.handle(req, res);   // a target no URL can be made of: the root answers 400
    }
    const mount = url.pathname.split('/')[1];
    const m = byMount.get(mount);
    if (!m) {
      // Without pages of its own, the host opens on its first module.
      if (!publicDir && url.pathname === '/' && ['GET', 'HEAD'].includes(req.method)) {
        redirect(res, 302, `/${joined[0].mount}/${url.search}`);
        return undefined;
      }
      return root.handle(req, res);
    }
    // Two slashes would read as a host name inside the module: one is enough.
    const rest = url.pathname.slice(mount.length + 1).replace(/^\/{2,}/, '/');
    if (!rest) {
      redirect(res, 308, `/${mount}/${url.search}`);
      return undefined;
    }
    // One admin panel for the whole host, at the root.
    if (rest === '/admin' || rest === '/admin/') {
      redirect(res, 302, '/admin');
      return undefined;
    }
    if (rest === '/manifest.webmanifest' && ['GET', 'HEAD'].includes(req.method)) {
      const manifest = manifestOf(m);
      if (manifest) {
        securityHeaders(res, { https: install.https });
        if (req.headers['if-none-match'] === manifest.etag) {
          res.writeHead(304, { ETag: manifest.etag, 'Cache-Control': 'no-cache' });
          res.end();
          return undefined;
        }
        res.writeHead(200, {
          'Content-Type': 'application/manifest+json; charset=utf-8',
          'Content-Length': Buffer.byteLength(manifest.body),
          'Cache-Control': 'no-cache',
          ETag: manifest.etag,
        });
        res.end(req.method === 'HEAD' ? undefined : manifest.body);
        return undefined;
      }
    }
    req.url = rest + url.search;
    return m.app.handle(req, res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`[error] ${req.method} ${req.url}`, err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      else res.end();
    });
  });
  server.headersTimeout = 65000;
  server.requestTimeout = 0;   // live channels stay open

  /* ------------------------------ running -------------------------------- */

  const timers = [];
  const stops = [];
  /** A clean-up that fails is logged and tried again next time: it must not take the host down. */
  const safely = (name, fn) => () => {
    try { fn(); } catch (err) { log(`${tag} ${name} failed: ${err?.stack || err}`); }
  };

  /** Creates the first administrator, starts the clean-ups and each module's own jobs, and listens. */
  function listen() {
    suite.ensureAdmin();
    const cleanUp = safely('clean-up', () => {
      suite.purge();
      root.portability?.purge();
      for (const m of joined) m.app.portability?.purge();
    });
    cleanUp();
    timers.push(setInterval(cleanUp, 6 * HOUR).unref());
    if (suite.oauth) {
      const purgeOAuth = safely('OAuth clean-up', () => suite.oauth.purge());
      purgeOAuth();
      timers.push(setInterval(purgeOAuth, HOUR).unref());
    }
    for (const m of joined) {
      // What a plan keeps for a while only: the module's sweep, as createApp runs it for the app alone.
      if (typeof m.parts.sweep === 'function') {
        const sweep = safely(`${m.mount} sweep`, () => {
          const removed = m.parts.sweep();
          if (removed && Object.values(removed).some(Boolean)) log(`[${m.config.app.id}] swept ${JSON.stringify(removed)}`);
        });
        timers.push(setTimeout(sweep, MINUTE_BEFORE_SWEEP).unref());
        timers.push(setInterval(sweep, 6 * HOUR).unref());
      }
      // Its own timers (reminders, clean-ups): what the app's index.js starts on its own.
      if (typeof m.parts.start === 'function') {
        const stopIt = m.parts.start();
        if (typeof stopIt === 'function') stops.push(stopIt);
      }
    }
    if (handleSignals) {
      const shutdown = (reason, code = 0) => {
        log(`${tag} ${reason}, closing…`);
        close().then(() => process.exit(code), () => process.exit(code));
        setTimeout(() => process.exit(code), 5000).unref();
      };
      process.once('SIGTERM', () => shutdown('SIGTERM received'));
      process.once('SIGINT', () => shutdown('SIGINT received'));
      process.on('unhandledRejection', (err) => log(`${tag} unhandled rejection: ${err?.stack || err}`));
      process.once('uncaughtException', (err) => {
        log(`${tag} uncaught exception: ${err?.stack || err}`);
        shutdown('uncaught exception', 1);
      });
    }
    return new Promise((resolve) => {
      server.listen(install.port, install.host, () => {
        log(`${tag} listening on http://${install.host}:${server.address().port}`);
        log(`${tag} public URL: ${install.baseUrl}, with ${joined.map((m) => `/${m.mount}/`).join(', ')}`);
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
    for (const stopIt of stops) safely('stop', stopIt)();
    // Open tabs would keep the server from closing.
    suite.live.close();
    for (const m of joined) m.view.live.close();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return {
    server, handle, listen, close, suite, root,
    modules: joined.map((m) => ({ mount: m.mount, id: m.config.app.id, suite: m.view, app: m.app })),
  };
}
