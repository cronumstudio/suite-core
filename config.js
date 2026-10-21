/**
 * An app's configuration: its product definition (`suite.config.js`, committed,
 * the same for every install) and the install's environment (where and how
 * this copy runs: URLs, secrets, providers).
 *
 * Checked as a whole on start. A misspelled setting must never leave a barrier
 * open or a module half on, so anything unknown or wrong is an error and the
 * app doesn't start; it says what is wrong instead. That includes a variable
 * under its old name: read as an alias, it would keep an install working on
 * the old name forever. What only deserves a word (an unknown AUTH_PROVIDER)
 * is a warning.
 *
 *   import product from '../suite.config.js';
 *   const config = resolveConfig(product);          // process.env by default
 *   if (config.errors.length) …                     // createApp() refuses to start
 */
import path from 'node:path';
import { LANGUAGES } from './i18n.js';
import { workosConfigFromEnv } from './workos.js';
import { oidcConfigFromEnv } from './oidc.js';
import { mailConfigFromEnv, mailConfigErrors } from './mail.js';
import { vapidKeyErrors } from './push.js';
import { nativePushFromEnv } from './native-push.js';
import { PADDLE_API } from './paddle.js';
import { REVENUECAT_API, STORE_FIELDS } from './revenuecat.js';
import { productSeatsProblem } from './billing.js';
import { redirectUriProblem } from './devices.js';
import { OAUTH_PREFIXES } from './oauth.js';
import { organizationKinds } from './organizations.js';

/** The modules an app can switch on or off, and their defaults. */
export const MODULES = Object.freeze({
  oauth: true,            // the built-in OAuth for the MCP (local accounts)
  mcp: true,              // the /mcp endpoint
  admin: true,            // /api/admin/*
  organizations: false,   // groups with members, roles and a shared plan
  billing: false,         // payments, when an install also sets BILLING_PROVIDER
  // The live channel at GET /api/events (live.js). Off by default: an app that
  // still serves its own there would lose it silently when it moves up.
  live: false,
  // Web Push (push.js) and its routes at /api/push/*; off by default for the same reason.
  push: false,
  // Files people attach (uploads.js), under DATA_DIR/uploads: the app's routes use suite.uploads.
  uploads: false,
  // Tokens for an app on a phone, connected through the system browser (devices.js), and their routes.
  devices: false,
});

const PRODUCT_KEYS = new Set([
  'app', 'modules', 'accounts', 'sessions', 'organizations', 'tokens', 'rateLimits',
  'features', 'plans', 'defaultPlan', 'products', 'billing', 'trustProxy',
  'devices', 'stores', 'push',
]);

/**
 * suite.config.js `billing`: what keeps another product's sales out (billing.js, paddle.js),
 * whether an account (or a group) that goes takes its billing links and grants with it
 * (`forgetOnRemove`), and whether a group deleted stops renewing (`stopOnOrganizationDeleted`).
 */
const BILLING_KEYS = new Set([
  'ignoreUnknownProducts', 'app', 'strictPrices', 'paddleProductIds', 'forgetOnRemove', 'stopOnOrganizationDeleted',
]);

/** suite.config.js `stores`: what the app on a phone sells in the App Store and Google Play (stores.js). */
const STORE_KEYS = new Set(['products', 'devices']);
/** What a store product may say; anything else is a typo that would sell nothing. */
const STORE_PRODUCT_KEYS = new Set(['plan', 'kind', 'days', 'name', ...Object.keys(STORE_FIELDS)]);

/** suite.config.js `push`: notices beyond Web Push (native-push.js). */
const PUSH_KEYS = new Set(['native', 'apnsTopic', 'androidChannel']);

/** suite.config.js `devices`: how an app on a phone connects (devices.js, device-pages.js). */
const DEVICE_KEYS = new Set(['prefix', 'redirectUris', 'idleDays', 'connectPage', 'webSessions']);

/**
 * Variables renamed when the apps moved to one set of names (CONVENTIONS.md). They are not read:
 * finding one stops the start and names its replacement. HOST_PORT only matters to docker compose,
 * but .env often reaches the app too.
 */
const OLD_NAMES = Object.freeze({
  RECARGA_EN_CALIENTE: 'HOT_RELOAD', PORT_HOST: 'HOST_PORT', PUERTO: 'HOST_PORT', PUBLIC_URL: 'BASE_URL',
});

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
    // The product's colour and icon: the accent and the picture of the OAuth consent screen.
    color: a.color ?? null,
    icon: a.icon ?? '/icons/favicon.svg',
  };
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(app.id)) errors.push('app.id: lowercase letters, digits and -, starting with a letter');
  if (!app.name.trim()) errors.push('app.name is needed');
  if (!wholeNumber(app.port, 1, 65535)) errors.push('app.port must be a port number');
  const unknownLanguages = app.languages.filter((l) => !LANGUAGES.includes(l));
  if (unknownLanguages.length) errors.push(`app.languages: ${unknownLanguages.join(', ')} not among ${LANGUAGES.join(', ')}`);
  if (app.languages[0] !== 'en') errors.push('app.languages: English goes first, it is the fallback');
  if (app.color !== null && !/^#[0-9a-fA-F]{6}$/.test(String(app.color))) errors.push('app.color: a colour as #RRGGBB, e.g. #3A4660');
  // The consent screen's CSP only loads images from the app itself.
  if (!/^\/(?!\/)[^\s"'<>\\]*$/.test(String(app.icon))) errors.push('app.icon: a path on the app itself, starting with /');

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
    // Who may create an account: only the admin, whoever the admin invites by
    // email, or anyone. An install may say otherwise with SIGNUP.
    signup: env.SIGNUP || ac.signup || 'admin',
    minPasswordLength: ac.minPasswordLength ?? 10,
    roles: Array.isArray(ac.roles) ? [...ac.roles] : ['admin', 'user'],
    // Someone deleting their own account: how long it waits, disabled, before it goes for good.
    deletionDays: ac.deletionDays ?? 30,
    // When it goes, whether the person also goes at the identity provider (WorkOS) and their
    // subscriptions end: only where this install is all the person has there (Cronum Work), never
    // where other apps sign in with the same provider's accounts or share a subscription.
    deleteAtProviders: ac.deleteAtProviders ?? false,
  };
  if (!['admin', 'invite', 'open'].includes(accounts.signup)) {
    errors.push(`${env.SIGNUP ? 'SIGNUP' : 'accounts.signup'} "${accounts.signup}": use admin, invite or open`);
  }
  if (!wholeNumber(accounts.minPasswordLength, 6, 128)) errors.push('accounts.minPasswordLength: a whole number from 6 to 128');
  if (!wholeNumber(accounts.deletionDays, 0, 365)) errors.push('accounts.deletionDays: a whole number of days from 0 to 365');
  if (typeof accounts.deleteAtProviders !== 'boolean') errors.push('accounts.deleteAtProviders: true or false');
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
    // The roles that take a seat a subscription pays for (Tracker's drivers); null, every member.
    seatRoles: Array.isArray(og.seatRoles) ? [...og.seatRoles] : (og.seatRoles ?? null),
    // The kinds the app manages, caps per person, or deletes when empty (organizations.js); none, as before.
    kinds: {},
  };
  // A misspelt key would go unseen and change who pays: with `seatRole`, every member would take a seat.
  for (const key of Object.keys(og)) {
    if (!Object.hasOwn(organizations, key)) errors.push(`organizations.${key} is not a setting (roles, invitationDays, seatRoles, kinds)`);
  }
  const kinds = organizationKinds(og.kinds);
  organizations.kinds = kinds.kinds;
  errors.push(...kinds.errors);
  if (!['owner', 'admin', 'member'].every((r) => organizations.roles.includes(r))) {
    errors.push('organizations.roles must include owner, admin and member (and may add the app\'s own)');
  }
  if (organizations.seatRoles !== null && !(Array.isArray(organizations.seatRoles) && organizations.seatRoles.length
    && organizations.seatRoles.every((r) => organizations.roles.includes(r)))) {
    errors.push("organizations.seatRoles: some of organizations.roles, such as ['driver'], or left out for every member");
  }

  const tk = isObject(p.tokens) ? p.tokens : {};
  const tokens = { prefix: tk.prefix ?? 'mcp_' };
  if (!/^[a-z]{2,10}_$/.test(tokens.prefix)) errors.push('tokens.prefix: a few lowercase letters and _ ("mcp_")');

  // Device tokens: their own prefix, so no other kind of token is ever taken for one, and the
  // addresses the system browser may hand a code back to. Both become part of the installed apps:
  // with the module on they must be given, never guessed.
  const dv = isObject(p.devices) ? p.devices : {};
  if (p.devices !== undefined && !isObject(p.devices)) errors.push("devices: an object, such as { prefix: 'appdev_', redirectUris: ['com.example.app:/auth'] }");
  for (const key of Object.keys(dv)) {
    if (!DEVICE_KEYS.has(key)) errors.push(`devices.${key} is not a setting (a typo?)`);
  }
  const devices = {
    prefix: dv.prefix ?? null,
    redirectUris: Array.isArray(dv.redirectUris) ? [...new Set(dv.redirectUris)] : [],
    idleDays: dv.idleDays ?? 90,
  };
  if (devices.prefix !== null && !/^[a-z]{2,10}_$/.test(String(devices.prefix))) {
    errors.push('devices.prefix: a few lowercase letters and _ ("appdev_")');
  } else if (devices.prefix !== null) {
    // Either one starting the other is a clash: the MCP refuses whatever starts with devices.prefix.
    const clashes = (other) => String(other).startsWith(devices.prefix) || devices.prefix.startsWith(String(other));
    const oauthTaken = Object.values(OAUTH_PREFIXES).find(clashes);
    if (clashes(tokens.prefix)) {
      errors.push(`devices.prefix must differ from tokens.prefix ("${tokens.prefix}"): a device token is not an API token`);
    } else if (oauthTaken) {
      errors.push(`devices.prefix can't be "${devices.prefix}": the built-in OAuth's values start with "${oauthTaken}", and the MCP would refuse them`);
    }
  }
  if (dv.redirectUris !== undefined && !Array.isArray(dv.redirectUris)) errors.push("devices.redirectUris: a list, such as ['com.example.app:/auth']");
  for (const uri of devices.redirectUris) {
    const problem = redirectUriProblem(uri);
    if (problem) errors.push(`devices.redirectUris: "${String(uri).slice(0, 80)}" is not valid: ${problem}`);
  }
  if (!wholeNumber(devices.idleDays, 1, 3650)) errors.push('devices.idleDays: a whole number of days from 1 to 3650');
  // The suite's own pages for a phone (device-pages.js): the connect page at /devices/connect, and
  // sessions of the web from a device's token. Off unless the app says, and then said in the
  // configuration: an app that leaves them out keeps the shape it always had.
  for (const key of ['connectPage', 'webSessions']) {
    if (dv[key] === undefined) continue;
    if (typeof dv[key] !== 'boolean') errors.push(`devices.${key} must be true or false`);
    else if (dv[key] && !modules.devices) errors.push(`devices.${key} needs modules.devices: the device tokens it works with`);
    else devices[key] = dv[key];
  }
  if (modules.devices && devices.prefix === null) errors.push('modules.devices needs devices.prefix: how the app’s device tokens start ("appdev_")');
  if (modules.devices && !devices.redirectUris.length) {
    errors.push('modules.devices needs devices.redirectUris: where the system browser hands the code back to the app (com.example.app:/auth)');
  }

  // Native push (native-push.js): the suite's app on a phone gets the same notices through APNs and
  // FCM, straight to Apple and Google. Off unless the app says; it needs the device tokens it hangs on.
  const pu = isObject(p.push) ? p.push : {};
  if (p.push !== undefined && !isObject(p.push)) errors.push("push: an object, such as { native: true, apnsTopic: 'com.example.app' }");
  for (const key of Object.keys(pu)) {
    if (!PUSH_KEYS.has(key)) errors.push(`push.${key} is not a setting (a typo?)`);
  }
  const pushRules = { native: false, apnsTopic: pu.apnsTopic ?? null, androidChannel: pu.androidChannel ?? 'default' };
  if (pu.native !== undefined) {
    if (typeof pu.native !== 'boolean') errors.push('push.native must be true or false');
    else if (pu.native && !modules.push) errors.push('push.native needs modules.push: native notices are the same sends as Web Push');
    else if (pu.native && !modules.devices) errors.push('push.native needs modules.devices: a phone registers its token with its device token');
    else pushRules.native = pu.native;
  }
  if (pushRules.apnsTopic !== null && !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(String(pushRules.apnsTopic))) {
    errors.push('push.apnsTopic: the app’s bundle id, such as com.example.app');
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(String(pushRules.androidChannel))) {
    errors.push('push.androidChannel: the id of the Android notification channel the app creates, such as default');
  }

  const rl = isObject(p.rateLimits) ? p.rateLimits : {};
  const rateLimits = { account: 10, ip: 60, token: 30, registration: 30, mail: 10, mailTo: 3, signup: 5, code: 5, importTo: 10, devices: 30, ...rl };
  for (const [key, value] of Object.entries(rateLimits)) {
    if (!['account', 'ip', 'token', 'registration', 'mail', 'mailTo', 'signup', 'code', 'importTo', 'devices'].includes(key)) errors.push(`rateLimits.${key} is not a limit`);
    else if (!wholeNumber(value, 1, 100000)) errors.push(`rateLimits.${key} must be a whole number`);
  }

  /* ------------------------------- install ------------------------------ */

  for (const [old, current] of Object.entries(OLD_NAMES)) {
    if (env[old] !== undefined && env[old] !== '') errors.push(`${old} is no longer read: rename it to ${current}`);
  }
  const port = env.PORT ? Number(env.PORT) : app.port;
  if (!wholeNumber(port, 0, 65535)) errors.push(`PORT "${env.PORT}" is not a port number`);
  // In production the address decides Secure cookies, the OAuth issuer and the links in emails:
  // a localhost guess there would half-work instead of failing.
  if (!env.BASE_URL && env.NODE_ENV === 'production') {
    errors.push('BASE_URL is required in production: the public address, e.g. https://app.example.com');
  }
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
    // Without an audience any token of the AuthKit environment opens this app's MCP, also one
    // a person gave to another app of the suite. A warning and not an error: an install that
    // starts requiring it must first have its Resource Indicator set in WorkOS.
    if (modules.mcp && !env.WORKOS_MCP_AUDIENCE) {
      warnings.push(`WORKOS_MCP_AUDIENCE is not set: MCP tokens issued for another app of the same WorkOS environment are accepted here. Set it to ${String(env.BASE_URL || 'BASE_URL').replace(/\/+$/, '')}/mcp, with that resource in WorkOS`);
    }
  }
  const oidc = oidcConfigFromEnv({ ...env, AUTH_PROVIDER: authProvider });
  if (authProvider === 'oidc') {
    const missing = ['OIDC_ISSUER', 'OIDC_CLIENT_ID'].filter((name) => !env[name]);
    if (missing.length) errors.push(`AUTH_PROVIDER=oidc, but these are missing: ${missing.join(', ')}`);
    else if (!/^https?:\/\/[^/\s]+/.test(oidc.issuer)) errors.push(`OIDC_ISSUER "${env.OIDC_ISSUER}" is not an http(s) address`);
  }

  const mail = mailConfigFromEnv(env);
  errors.push(...mailConfigErrors(mail));

  // Web Push: the install's VAPID keys, both or neither (without them the app
  // generates a pair on its first start and keeps it in the database).
  const push = {
    publicKey: env.VAPID_PUBLIC_KEY || null,
    privateKey: env.VAPID_PRIVATE_KEY || null,
    // Who push services write to if something goes wrong: an email, or the app's address.
    subject: env.VAPID_SUBJECT
      || (env.ADMIN_EMAIL ? `mailto:${env.ADMIN_EMAIL}` : baseUrl.startsWith('https://') ? baseUrl : 'mailto:admin@localhost'),
  };
  // A mistake here doesn't stop the app (notifications are an extra): it is
  // said, and the install's own keys, generated and kept, are used instead.
  const vapidProblem = Boolean(push.publicKey) !== Boolean(push.privateKey)
    ? 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY go together: set both or neither'
    : push.publicKey ? vapidKeyErrors(push) : null;
  if (vapidProblem) {
    warnings.push(`${vapidProblem}. Notifications use keys generated for this install instead.`);
    push.publicKey = null;
    push.privateKey = null;
  }
  if (!/^(mailto:|https:)/.test(push.subject)) warnings.push('VAPID_SUBJECT should be a mailto: or https: address');
  // Native push: Apple's and Google's credentials, only read with push.native. A platform without
  // them is off and said once here (the names, never a value); one that can't be used stops the start.
  let nativePush = null;
  if (pushRules.native) {
    nativePush = nativePushFromEnv(env, { topic: pushRules.apnsTopic });
    errors.push(...nativePush.errors);
    if (nativePush.missing.apns.length) warnings.push(`push.native: notices for iPhones are off, these are missing: ${nativePush.missing.apns.join(', ')}`);
    if (nativePush.missing.fcm.length) warnings.push(`push.native: notices for Android phones are off, this is missing: ${nativePush.missing.fcm.join(', ')}`);
    nativePush = { apns: nativePush.apns, fcm: nativePush.fcm };
  }
  if (accounts.signup !== 'admin' && mail.provider === 'log') {
    warnings.push(`Sign-up is "${accounts.signup}" but MAIL_PROVIDER is log: confirmation and invitation links only reach the server's log`);
  }

  let billing = null;
  if (env.BILLING_PROVIDER) {
    if (!modules.billing) errors.push('BILLING_PROVIDER is set, but this app has modules.billing off');
    else if (env.BILLING_PROVIDER === 'remote') {
      if (!env.BILLING_SECRET || env.BILLING_SECRET.length < 16) errors.push('BILLING_PROVIDER=remote needs BILLING_SECRET (16 characters or more)');
      else billing = { provider: 'remote', secret: env.BILLING_SECRET, url: String(env.BILLING_URL || '').replace(/\/+$/, '') };
    } else if (env.BILLING_PROVIDER === 'stripe') {
      const missing = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'].filter((name) => !env[name]);
      if (missing.length) errors.push(`BILLING_PROVIDER=stripe needs ${missing.join(' and ')}`);
      else if (!/^(sk|rk)_(test|live)_\S+$/.test(env.STRIPE_SECRET_KEY)) errors.push('STRIPE_SECRET_KEY must be a Stripe secret key (sk_test_…, sk_live_…) or a restricted one (rk_…)');
      else if (!/^whsec_\S+$/.test(env.STRIPE_WEBHOOK_SECRET)) errors.push('STRIPE_WEBHOOK_SECRET must be the webhook endpoint\'s signing secret (whsec_…)');
      else {
        billing = {
          provider: 'stripe', secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET,
          apiBase: String(env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, ''),
        };
        if (env.STRIPE_SECRET_KEY.includes('_live_') && !baseUrl.startsWith('https://')) {
          warnings.push('STRIPE_SECRET_KEY is a live key but BASE_URL is not https: Stripe will not reach the webhook');
        }
      }
    } else if (env.BILLING_PROVIDER === 'paddle') {
      const environment = env.PADDLE_ENV || 'production';
      const missing = ['PADDLE_API_KEY', 'PADDLE_WEBHOOK_SECRET'].filter((name) => !env[name]);
      if (missing.length) errors.push(`BILLING_PROVIDER=paddle needs ${missing.join(' and ')}`);
      else if (!PADDLE_API[environment]) errors.push(`PADDLE_ENV "${env.PADDLE_ENV}": use sandbox or production`);
      else if (!/^pdl_(sdbx|live)_apikey_\S+$/.test(env.PADDLE_API_KEY)) errors.push('PADDLE_API_KEY must be a Paddle API key (pdl_sdbx_apikey_…, pdl_live_apikey_…)');
      // A sandbox key against the live API (or the other way round) only fails at the first checkout.
      else if ((environment === 'sandbox') !== env.PADDLE_API_KEY.startsWith('pdl_sdbx_')) {
        errors.push(`PADDLE_API_KEY is a ${env.PADDLE_API_KEY.startsWith('pdl_sdbx_') ? 'sandbox' : 'live'} key but PADDLE_ENV is ${environment}`);
      } else if (!/^pdl_ntfset_\S+$/.test(env.PADDLE_WEBHOOK_SECRET)) errors.push('PADDLE_WEBHOOK_SECRET must be the secret of the app\'s notification destination (pdl_ntfset_…)');
      else if (env.PADDLE_CHECKOUT_URL && !/^https:\/\/[^/\s]+\/\S*$/.test(env.PADDLE_CHECKOUT_URL)
        && !(environment === 'sandbox' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\S*$/.test(env.PADDLE_CHECKOUT_URL))) {
        errors.push(`PADDLE_CHECKOUT_URL "${env.PADDLE_CHECKOUT_URL}" must be an https address (the page with Paddle.js)`);
      } else {
        billing = {
          provider: 'paddle', apiKey: env.PADDLE_API_KEY, webhookSecret: env.PADDLE_WEBHOOK_SECRET, environment,
          apiBase: String(env.PADDLE_API_BASE || PADDLE_API[environment]).replace(/\/+$/, ''),
          checkoutUrl: env.PADDLE_CHECKOUT_URL || '',
        };
      }
    } else errors.push(`BILLING_PROVIDER "${env.BILLING_PROVIDER}": use stripe, paddle or remote`);
    // Who joined before this date pays the founder's price of the products that have one.
    if (billing && env.EARLY_ACCESS_UNTIL) {
      const until = Date.parse(env.EARLY_ACCESS_UNTIL);
      if (Number.isNaN(until)) errors.push(`EARLY_ACCESS_UNTIL "${env.EARLY_ACCESS_UNTIL}" is not a date (2026-12-01)`);
      else billing.earlyAccessUntil = new Date(until).toISOString();
    }
  }
  const products = productsFor(isObject(p.products) ? p.products : {}, billing, errors);
  const billingRules = billingRulesFor(p.billing, billing, errors, warnings);
  const stores = storesFor(p.stores, products, modules, errors);
  const storeBilling = storeBillingFromEnv(env, { modules, stores, errors });

  const install = {
    baseUrl,
    https: baseUrl.startsWith('https://'),
    port,
    host: env.HOST || '0.0.0.0',
    dataDir,
    dbPath: env.DB_PATH || path.join(dataDir, `${app.id}.db`),
    // Empty, as compose passes an unset variable, counts as absent: the product's default applies.
    trustProxy: env.TRUST_PROXY || (p.trustProxy === undefined ? 'false' : String(p.trustProxy)),
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
    // Purchases in the App Store and Google Play (STORE_BILLING), next to the web's.
    stores: storeBilling,
    mail,
    push,
    // With push.native: { apns, fcm }, each null when its credentials aren't set.
    ...(nativePush ? { nativePush } : {}),
    hotReload: env.HOT_RELOAD === 'true',
  };

  return {
    app, modules, accounts, sessions, organizations, tokens, devices, rateLimits,
    push: pushRules,
    features: isObject(p.features) ? p.features : {},
    plans: isObject(p.plans) ? p.plans : null,
    defaultPlan: p.defaultPlan ?? null,
    products,
    billing: billingRules,
    stores,
    install, errors, warnings,
  };
}

/**
 * suite.config.js `stores`, what the app on a phone sells (stores.js, revenuecat.js):
 *   { products: { 'pro-monthly': { plan: 'pro', kind: 'subscription',
 *       appStore: 'com.example.app.pro.monthly', playStore: 'app_pro:monthly' } },
 *     devices: true }
 * Each product is a plan of the catalog, as a web product is (checked when STORE_BILLING is on), and
 * names its id in each store (Google's as `subscription:base-plan`); a store id belongs to one
 * product, and a key is not also a web product's. People buy for themselves: no `for`.
 * `devices`: the store routes and the overview also take this app's device tokens (modules.devices),
 * since only the app on the phone buys in a store.
 */
function storesFor(given, webProducts, modules, errors) {
  const stores = { products: {}, devices: false };
  if (given === undefined) return stores;
  if (!isObject(given)) {
    errors.push("stores: an object, such as { products: { 'pro-monthly': { plan: 'pro', kind: 'subscription', appStore: 'com.example.app.pro.monthly' } } }");
    return stores;
  }
  for (const key of Object.keys(given)) {
    if (!STORE_KEYS.has(key)) errors.push(`stores.${key} is not a setting (a typo?)`);
  }
  if (given.devices !== undefined) {
    if (typeof given.devices !== 'boolean') errors.push('stores.devices must be true or false');
    else if (given.devices && !modules.devices) errors.push('stores.devices needs modules.devices: the device tokens it takes');
    else stores.devices = given.devices;
  }
  if (given.products !== undefined && !isObject(given.products)) {
    errors.push("stores.products: an object, such as { 'pro-monthly': { plan: 'pro', kind: 'subscription', appStore: '…' } }");
    return stores;
  }
  const owner = {};
  for (const [key, spec] of Object.entries(given.products || {})) {
    if (!isObject(spec)) { errors.push(`stores.products.${key}: an object, such as { plan: 'pro', kind: 'subscription', appStore: '…' }`); continue; }
    for (const field of Object.keys(spec)) {
      if (field === 'for') errors.push(`stores.products.${key}.for: people buy in the stores for themselves; a group buys on the web`);
      else if (!STORE_PRODUCT_KEYS.has(field)) errors.push(`stores.products.${key}.${field} is not a setting (${[...STORE_PRODUCT_KEYS].join(', ')})`);
    }
    if (Object.hasOwn(webProducts, key)) errors.push(`stores.products.${key}: a web product has that key too; give the store's its own`);
    if (!Object.keys(STORE_FIELDS).some((field) => spec[field] != null)) {
      errors.push(`stores.products.${key}: its id in a store is needed (${Object.keys(STORE_FIELDS).join(' or ')})`);
    }
    if (spec.appStore != null && !/^[A-Za-z0-9._]{1,100}$/.test(String(spec.appStore))) {
      errors.push(`stores.products.${key}.appStore: "${String(spec.appStore).slice(0, 100)}" is not an App Store product id (letters, digits, . and _)`);
    }
    if (spec.playStore != null && !/^[a-z0-9][a-z0-9._]{0,99}(:[a-z0-9][a-z0-9-]{0,62})?$/.test(String(spec.playStore))) {
      errors.push(`stores.products.${key}.playStore: "${String(spec.playStore).slice(0, 100)}" is not a Google Play product id (subscription:base-plan, lowercase)`);
    }
    for (const [field, store] of Object.entries(STORE_FIELDS)) {
      if (spec[field] == null) continue;
      const id = `${store}:${spec[field]}`;
      if (owner[id]) errors.push(`stores.products.${key}.${field}: "${spec[field]}" is already stores.products.${owner[id]}'s`);
      else owner[id] = key;
    }
  }
  stores.products = { ...(given.products || {}) };
  return stores;
}

/**
 * The install's store purchases (STORE_BILLING): today `revenuecat`, with REVENUECAT_WEBHOOK_AUTH
 * (the Authorization header value set in the webhook), REVENUECAT_API_KEY (a secret key of the
 * project, sk_…), optionally REVENUECAT_WEBHOOK_SECRET (the webhook's signing secret: then its
 * signature is required too) and REVENUECAT_SANDBOX (`on` by default: test purchases count, marked
 * as such, as App Review buys in the sandbox; `off` makes them another product's).
 */
function storeBillingFromEnv(env, { modules, stores, errors }) {
  if (!env.STORE_BILLING) return null;
  if (!modules.billing) {
    errors.push('STORE_BILLING is set, but this app has modules.billing off');
    return null;
  }
  if (env.STORE_BILLING !== 'revenuecat') {
    errors.push(`STORE_BILLING "${env.STORE_BILLING}": use revenuecat`);
    return null;
  }
  const missing = ['REVENUECAT_WEBHOOK_AUTH', 'REVENUECAT_API_KEY'].filter((name) => !env[name]);
  const sandbox = env.REVENUECAT_SANDBOX || 'on';
  const apiBase = String(env.REVENUECAT_API_BASE || REVENUECAT_API).replace(/\/+$/, '');
  // The values themselves are never repeated: they are secrets.
  if (missing.length) errors.push(`STORE_BILLING=revenuecat needs ${missing.join(' and ')}`);
  else if (env.REVENUECAT_WEBHOOK_AUTH.length < 16) {
    errors.push('REVENUECAT_WEBHOOK_AUTH: the Authorization header value set in RevenueCat\'s webhook, 16 characters or more');
  } else if (!/^sk_\S{8,}$/.test(env.REVENUECAT_API_KEY)) {
    errors.push('REVENUECAT_API_KEY must be a secret API key of the RevenueCat project (sk_…), never an app\'s public key');
  } else if (env.REVENUECAT_WEBHOOK_SECRET && env.REVENUECAT_WEBHOOK_SECRET.length < 16) {
    errors.push('REVENUECAT_WEBHOOK_SECRET: the webhook\'s signing secret, 16 characters or more, or left empty');
  } else if (!['on', 'off'].includes(sandbox)) {
    errors.push(`REVENUECAT_SANDBOX "${sandbox}": use on or off`);
  } else if (!/^https?:\/\/[^/\s]+(\/\S*)?$/.test(apiBase)) {
    errors.push(`REVENUECAT_API_BASE "${env.REVENUECAT_API_BASE}" is not an http(s) address`);
  } else if (!Object.keys(stores.products).length) {
    errors.push('STORE_BILLING is set, but suite.config.js stores.products sells nothing');
  } else {
    return {
      provider: 'revenuecat', webhookAuth: env.REVENUECAT_WEBHOOK_AUTH, webhookSecret: env.REVENUECAT_WEBHOOK_SECRET || null,
      apiKey: env.REVENUECAT_API_KEY, apiBase, sandbox: sandbox === 'on',
    };
  }
  return null;
}

/**
 * suite.config.js `billing`, all off by default (billing.js and paddle.js say why):
 *   { ignoreUnknownProducts: true, app: 'work', strictPrices: true,
 *     paddleProductIds: { sandbox: ['pro_…'], production: ['pro_…'] }, forgetOnRemove: true,
 *     stopOnOrganizationDeleted: true }
 * The Paddle products are given per environment: a sandbox product's id is never the live one's,
 * so one list for both would be right in one of them and, in the other, make every sale of this
 * install foreign without a word. With Paddle on, the ones of PADDLE_ENV are used and must be
 * there: a guard asked for and left without them would let every other product's sale in.
 * `app`, `strictPrices` and `paddleProductIds` are Paddle's: with another provider, a warning.
 */
function billingRulesFor(given, install, errors, warnings) {
  const rules = { ignoreUnknownProducts: false, app: null, strictPrices: false, paddleProductIds: null };
  if (given === undefined) return rules;
  if (!isObject(given)) {
    errors.push('billing: an object, such as { ignoreUnknownProducts: true }');
    return rules;
  }
  for (const key of Object.keys(given)) {
    if (!BILLING_KEYS.has(key)) errors.push(`billing.${key} is not a setting (a typo?)`);
  }
  for (const key of ['ignoreUnknownProducts', 'strictPrices']) {
    if (given[key] === undefined) continue;
    if (typeof given[key] !== 'boolean') errors.push(`billing.${key} must be true or false`);
    else rules[key] = given[key];
  }
  // Only when given: the rules of an app that says nothing stay as they were.
  for (const key of ['forgetOnRemove', 'stopOnOrganizationDeleted']) {
    if (given[key] === undefined) continue;
    if (typeof given[key] !== 'boolean') errors.push(`billing.${key} must be true or false`);
    else if (given[key]) rules[key] = true;
  }
  if (given.app != null) {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(String(given.app))) errors.push('billing.app: lowercase letters, digits and -, starting with a letter');
    else rules.app = String(given.app);
  }
  const paddle = install?.provider === 'paddle';
  if (given.paddleProductIds != null) {
    const environment = paddle ? install.environment : 'production';
    let ids = given.paddleProductIds;
    if (isObject(ids)) {
      for (const name of Object.keys(ids)) {
        if (!PADDLE_API[name]) errors.push(`billing.paddleProductIds: "${name}" is not sandbox or production`);
      }
      ids = ids[environment] ?? null;
    }
    if (paddle && Array.isArray(given.paddleProductIds)) {
      errors.push("billing.paddleProductIds: one list per environment, { sandbox: ['pro_…'], production: ['pro_…'] }, as Paddle's product ids differ between them");
    } else if (ids != null && !(Array.isArray(ids) && ids.every((id) => typeof id === 'string' && /^pro_[a-z0-9]{26}$/.test(id)))) {
      errors.push('billing.paddleProductIds: a list of Paddle product ids (pro_…) for each environment');
    } else if (paddle && !ids?.length) {
      errors.push(`billing.paddleProductIds: none for PADDLE_ENV ${environment}`);
    } else rules.paddleProductIds = ids?.length ? [...ids] : null;
  }
  // Only Paddle's checkout writes the app, and only Paddle's events carry it with a price and a product id.
  const paddleOnly = ['app', 'strictPrices', 'paddleProductIds'].filter((key) => rules[key]).map((key) => `billing.${key}`);
  if (install && !paddle && paddleOnly.length) {
    warnings.push(`${paddleOnly.join(', ')} ${paddleOnly.length > 1 ? 'are' : 'is'} Paddle's: with BILLING_PROVIDER=${install.provider} ${paddleOnly.length > 1 ? 'they do' : 'it does'} nothing`);
  }
  return rules;
}

/**
 * The products with the prices of this install's provider. A product may give
 * a price per Paddle environment, `price: { sandbox: 'pri_…', production: 'pri_…' }`,
 * since the sandbox and the live account have their own ids: the one of
 * PADDLE_ENV is kept (the live one when billing is off). Paddle's ids are
 * checked here, so a price copied wrong stops the start instead of a checkout.
 */
function productsFor(products, billing, errors) {
  const environment = billing?.provider === 'paddle' ? billing.environment : 'production';
  const pick = (key, field, value) => {
    if (!isObject(value)) return value;
    for (const name of Object.keys(value)) {
      if (!PADDLE_API[name]) errors.push(`products.${key}.${field}: "${name}" is not sandbox or production`);
    }
    return value[environment] ?? null;
  };
  const out = {};
  for (const [key, spec] of Object.entries(products)) {
    if (!isObject(spec)) { out[key] = spec; continue; }
    // Whether a group's purchase caps its members is the product's, the same in every install: a
    // mistake stops the start even without a provider, so development and CI see it before a
    // family that paid finds it can't add anyone.
    const seats = productSeatsProblem(spec);
    if (seats) errors.push(`products.${key}.${seats}`);
    const resolved = { ...spec };
    for (const field of ['price', 'founderPrice']) {
      if (spec[field] === undefined) continue;
      resolved[field] = pick(key, field, spec[field]);
      if (billing?.provider === 'paddle' && resolved[field] != null && !/^pri_[a-z0-9]{26}$/.test(resolved[field])) {
        errors.push(`products.${key}.${field}: "${resolved[field]}" is not a Paddle price id (pri_…)`);
      }
    }
    // Prices no longer sold that subscriptions still renew on: a list, or one per environment.
    if (spec.oldPrices !== undefined) {
      const old = pick(key, 'oldPrices', spec.oldPrices) ?? [];
      resolved.oldPrices = old;
      if (!Array.isArray(old)) errors.push(`products.${key}.oldPrices: a list of price ids, or one per environment`);
      else if (billing?.provider === 'paddle') {
        for (const price of old) {
          if (!/^pri_[a-z0-9]{26}$/.test(String(price))) errors.push(`products.${key}.oldPrices: "${price}" is not a Paddle price id (pri_…)`);
        }
      }
    }
    out[key] = resolved;
  }
  return out;
}
