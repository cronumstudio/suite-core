/**
 * An app's configuration: its product definition (`suite.config.js`, committed,
 * the same for every install) and the install's environment (where and how
 * this copy runs: URLs, secrets, providers).
 *
 * Checked as a whole on start. A misspelled setting must never leave a barrier
 * open or a module half on, so anything unknown or wrong is an error and the
 * app doesn't start; it says what is wrong instead. What only deserves a word
 * (an old variable name, an unknown AUTH_PROVIDER) is a warning.
 *
 *   import product from '../suite.config.js';
 *   const config = resolveConfig(product);          // process.env by default
 *   if (config.errors.length) …                     // createApp() refuses to start
 */
import path from 'node:path';
import { LANGUAGES } from './i18n.js';
import { workosConfigFromEnv } from './workos.js';
import { oidcConfigFromEnv } from './oidc.js';

/** The modules an app can switch on or off, and their defaults. */
export const MODULES = Object.freeze({
  oauth: true,            // the built-in OAuth for the MCP (local accounts)
  mcp: true,              // the /mcp endpoint
  admin: true,            // /api/admin/*
  organizations: false,   // groups with members, roles and a shared plan
  billing: false,         // payments, when an install also sets BILLING_PROVIDER
});

const PRODUCT_KEYS = new Set([
  'app', 'modules', 'accounts', 'sessions', 'organizations', 'tokens', 'rateLimits',
  'features', 'plans', 'defaultPlan', 'products', 'trustProxy',
]);

/** Variables renamed when the code base moved to English: still read, with a warning. */
const OLD_NAMES = Object.freeze({ RECARGA_EN_CALIENTE: 'HOT_RELOAD', PORT_HOST: 'HOST_PORT' });

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const wholeNumber = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

/**
 * @param {object} product   the default export of suite.config.js
 * @param {object} [env]     process.env
 * @returns the configuration, with `errors` and `warnings`
 */
export function resolveConfig(product, env = process.env, { cwd = process.cwd() } = {}) {
  const errors = [];
  const warnings = [];
  const p = isObject(product) ? product : {};
  if (!isObject(product)) errors.push('suite.config.js must export an object');
  for (const key of Object.keys(p)) {
    if (!PRODUCT_KEYS.has(key)) errors.push(`suite.config.js: "${key}" is not a setting (a typo?)`);
  }

  /* --------------------------------- app -------------------------------- */

  const a = isObject(p.app) ? p.app : {};
  const app = {
    id: String(a.id ?? ''),
    name: String(a.name ?? a.id ?? ''),
    port: a.port ?? 3000,
    languages: Array.isArray(a.languages) && a.languages.length ? [...a.languages] : ['en'],
  };
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(app.id)) errors.push('app.id: lowercase letters, digits and -, starting with a letter');
  if (!app.name.trim()) errors.push('app.name is needed');
  if (!wholeNumber(app.port, 1, 65535)) errors.push('app.port must be a port number');
  const unknownLanguages = app.languages.filter((l) => !LANGUAGES.includes(l));
  if (unknownLanguages.length) errors.push(`app.languages: ${unknownLanguages.join(', ')} not among ${LANGUAGES.join(', ')}`);
  if (app.languages[0] !== 'en') errors.push('app.languages: English goes first, it is the fallback');

  /* ------------------------------- modules ------------------------------ */

  const modules = { ...MODULES };
  for (const [key, value] of Object.entries(isObject(p.modules) ? p.modules : {})) {
    if (!(key in MODULES)) { errors.push(`modules.${key} is not a module of the suite`); continue; }
    if (typeof value !== 'boolean') { errors.push(`modules.${key} must be true or false`); continue; }
    modules[key] = value;
  }

  /* ------------------------ accounts and sessions ----------------------- */

  const ac = isObject(p.accounts) ? p.accounts : {};
  const accounts = {
    signup: ac.signup ?? 'admin',
    minPasswordLength: ac.minPasswordLength ?? 10,
    roles: Array.isArray(ac.roles) ? [...ac.roles] : ['admin', 'user'],
  };
  // Invitations and open sign-up come with the mail module (email verification).
  if (accounts.signup !== 'admin') errors.push(`accounts.signup: only "admin" is available so far, not "${accounts.signup}"`);
  if (!wholeNumber(accounts.minPasswordLength, 6, 128)) errors.push('accounts.minPasswordLength: a whole number from 6 to 128');
  if (!accounts.roles.includes('admin')) errors.push('accounts.roles must include "admin"');

  const se = isObject(p.sessions) ? p.sessions : {};
  const sessions = {
    cookieName: se.cookieName ?? `${app.id}_sid`,
    idleDays: se.idleDays ?? 30,
    maxDays: se.maxDays ?? 365,
  };
  if (!/^[a-z0-9_]{2,40}$/.test(sessions.cookieName)) errors.push('sessions.cookieName: lowercase letters, digits and _');
  if (!wholeNumber(sessions.idleDays, 1, 3650)) errors.push('sessions.idleDays: a whole number of days');
  if (!wholeNumber(sessions.maxDays, sessions.idleDays, 3650)) errors.push('sessions.maxDays: a whole number of days, at least idleDays');

  const og = isObject(p.organizations) ? p.organizations : {};
  const organizations = {
    roles: Array.isArray(og.roles) ? [...og.roles] : ['owner', 'admin', 'member'],
    invitationDays: og.invitationDays ?? 7,
  };
  if (!['owner', 'admin', 'member'].every((r) => organizations.roles.includes(r))) {
    errors.push('organizations.roles must include owner, admin and member (and may add the app\'s own)');
  }

  const tk = isObject(p.tokens) ? p.tokens : {};
  const tokens = { prefix: tk.prefix ?? 'mcp_' };
  if (!/^[a-z]{2,10}_$/.test(tokens.prefix)) errors.push('tokens.prefix: a few lowercase letters and _ ("mcp_")');

  const rl = isObject(p.rateLimits) ? p.rateLimits : {};
  const rateLimits = { account: 10, ip: 60, token: 30, registration: 30, ...rl };
  for (const [key, value] of Object.entries(rateLimits)) {
    if (!['account', 'ip', 'token', 'registration'].includes(key)) errors.push(`rateLimits.${key} is not a limit`);
    else if (!wholeNumber(value, 1, 100000)) errors.push(`rateLimits.${key} must be a whole number`);
  }

  /* ------------------------------- install ------------------------------ */

  for (const [old, current] of Object.entries(OLD_NAMES)) {
    if (env[old] !== undefined && env[current] === undefined) warnings.push(`${old} is the old name of ${current}: rename it`);
  }
  const port = env.PORT ? Number(env.PORT) : app.port;
  if (!wholeNumber(port, 0, 65535)) errors.push(`PORT "${env.PORT}" is not a port number`);
  const baseUrl = String(env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+(\/\S*)?$/.test(baseUrl)) errors.push(`BASE_URL "${env.BASE_URL}" is not an http(s) address`);
  const dataDir = env.DATA_DIR || path.join(cwd, 'data');

  let authProvider = env.AUTH_PROVIDER || 'local';
  if (!['local', 'workos', 'oidc'].includes(authProvider)) {
    warnings.push(`AUTH_PROVIDER="${authProvider}" is not known: local accounts are used`);
    authProvider = 'local';
  }
  const workos = workosConfigFromEnv({ ...env, AUTH_PROVIDER: authProvider });
  if (authProvider === 'workos') {
    const missing = ['WORKOS_API_KEY', 'WORKOS_CLIENT_ID', 'WORKOS_AUTHKIT_DOMAIN'].filter((name) => !env[name]);
    // With WorkOS half set up nobody could sign in, not even the administrator.
    if (missing.length) errors.push(`AUTH_PROVIDER=workos, but these are missing: ${missing.join(', ')}`);
  }
  const oidc = oidcConfigFromEnv({ ...env, AUTH_PROVIDER: authProvider });
  if (authProvider === 'oidc') {
    const missing = ['OIDC_ISSUER', 'OIDC_CLIENT_ID'].filter((name) => !env[name]);
    if (missing.length) errors.push(`AUTH_PROVIDER=oidc, but these are missing: ${missing.join(', ')}`);
    else if (!/^https?:\/\/[^/\s]+/.test(oidc.issuer)) errors.push(`OIDC_ISSUER "${env.OIDC_ISSUER}" is not an http(s) address`);
  }

  let billing = null;
  if (env.BILLING_PROVIDER) {
    if (!modules.billing) errors.push('BILLING_PROVIDER is set, but this app has modules.billing off');
    else if (env.BILLING_PROVIDER !== 'remote') errors.push(`BILLING_PROVIDER "${env.BILLING_PROVIDER}": only "remote" is available so far`);
    else if (!env.BILLING_SECRET || env.BILLING_SECRET.length < 16) errors.push('BILLING_PROVIDER=remote needs BILLING_SECRET (16 characters or more)');
    else billing = { provider: 'remote', secret: env.BILLING_SECRET, url: String(env.BILLING_URL || '').replace(/\/+$/, '') };
  }

  const install = {
    baseUrl,
    https: baseUrl.startsWith('https://'),
    port,
    host: env.HOST || '0.0.0.0',
    dataDir,
    dbPath: env.DB_PATH || path.join(dataDir, `${app.id}.db`),
    trustProxy: env.TRUST_PROXY ?? (p.trustProxy === undefined ? 'false' : String(p.trustProxy)),
    secureCookies: env.SECURE_COOKIES === 'true' || (env.SECURE_COOKIES !== 'false' && baseUrl.startsWith('https://')),
    sessionSecret: env.SESSION_SECRET,
    admin: {
      username: env.ADMIN_USER || 'admin',
      password: env.ADMIN_PASSWORD || null,
      displayName: env.ADMIN_DISPLAY_NAME || null,
      email: env.ADMIN_EMAIL || '',
    },
    authProvider,
    workos,
    oidc,
    // With WorkOS, AuthKit is the authorization server for the MCP; with local
    // accounts or OIDC, the app's own is, and OIDC signs people in on its screen.
    mcpOAuth: modules.oauth && authProvider !== 'workos' && env.MCP_OAUTH !== 'off',
    cimdAllowPrivateHosts: env.CIMD_ALLOW_PRIVATE_HOSTS === 'true',
    plansJson: env.PLANS,
    defaultPlan: env.DEFAULT_PLAN,
    billing,
    hotReload: (env.HOT_RELOAD ?? env.RECARGA_EN_CALIENTE) === 'true',
  };

  return {
    app, modules, accounts, sessions, organizations, tokens, rateLimits,
    features: isObject(p.features) ? p.features : {},
    plans: isObject(p.plans) ? p.plans : null,
    defaultPlan: p.defaultPlan ?? null,
    products: isObject(p.products) ? p.products : {},
    install, errors, warnings,
  };
}
