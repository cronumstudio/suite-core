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
import { alertsFromEnv } from './alerts.js';
import { vapidKeyErrors } from './push.js';
import { nativePushFromEnv } from './native-push.js';
import { STORE_FIELDS } from './stores.js';
import { billingProviderOf, billingProviders, storeProviderOf, storeProviders } from './providers.js';
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
 * suite.config.js `billing`: what keeps another product's sales out (billing.js), whether an
 * account (or a group) that goes takes its billing links and grants with it (`forgetOnRemove`),
 * and whether a group deleted stops renewing (`stopOnOrganizationDeleted`). A provider may read
 * settings of its own there too (providers.js `rules`, such as Paddle's `paddleProductIds`).
 */
const BILLING_KEYS = new Set([
  'ignoreUnknownProducts', 'app', 'strictPrices', 'forgetOnRemove', 'stopOnOrganizationDeleted',
]);

/** The sides a price may be given for, `{ sandbox: …, production: … }`: a provider's test account and its live one. */
const PRICE_ENVIRONMENTS = Object.freeze(['sandbox', 'production']);

/** "a, b or c", for the names an install may choose from. */
const oneOf = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names.join(''));

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
    // Whether the admin here may set someone's password and take their second step off at the
    // identity provider (WorkOS, workos-security.js): only the install that owns the identities
    // (Cronum Work), since a WorkOS user is the same in every product that signs in with it.
    adminIdentity: ac.adminIdentity ?? false,
    // Only the subscriptions: they stop renewing at the request and end when the account goes, while
    // the person stays at the identity provider (an install that bills alone, with apps that share
    // its logins). Left out, as deleteAtProviders.
    endSubscriptions: ac.endSubscriptions ?? ac.deleteAtProviders ?? false,
  };
  if (!['admin', 'invite', 'open'].includes(accounts.signup)) {
    errors.push(`${env.SIGNUP ? 'SIGNUP' : 'accounts.signup'} "${accounts.signup}": use admin, invite or open`);
  }
  if (!wholeNumber(accounts.minPasswordLength, 6, 128)) errors.push('accounts.minPasswordLength: a whole number from 6 to 128');
  if (!wholeNumber(accounts.deletionDays, 0, 365)) errors.push('accounts.deletionDays: a whole number of days from 0 to 365');
  if (typeof accounts.deleteAtProviders !== 'boolean') errors.push('accounts.deleteAtProviders: true or false');
  if (typeof accounts.adminIdentity !== 'boolean') errors.push('accounts.adminIdentity: true or false');
  if (typeof accounts.endSubscriptions !== 'boolean') errors.push('accounts.endSubscriptions: true or false');
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
  // Emails to whoever runs the install when the server fails (alerts.js): off unless ALERT_EMAIL is
  // set, never ADMIN_EMAIL on its own (an install that moves up would start getting mail it never
  // asked for), and only with a mail server. A mistake is a warning: alerts are an extra.
  const alerts = alertsFromEnv(env, mail);
  if (alerts.warning) warnings.push(alerts.warning);

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
  // them, or with one that can't be used, is off and said once here (the names, never a value). As
  // with VAPID, never an error: a typo in an install's panel must not take the whole app down.
  let nativePush = null;
  if (pushRules.native) {
    nativePush = nativePushFromEnv(env, { topic: pushRules.apnsTopic });
    for (const problem of nativePush.problems.apns) warnings.push(`push.native: notices for iPhones are off: ${problem}`);
    for (const problem of nativePush.problems.fcm) warnings.push(`push.native: notices for Android phones are off: ${problem}`);
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
    else {
      // Only the providers registered (providers.js) can be named: an image without one says so.
      const provider = billingProviderOf(env.BILLING_PROVIDER);
      if (!provider) {
        const ids = billingProviders().map((p) => p.id);
        errors.push(`BILLING_PROVIDER "${env.BILLING_PROVIDER}": ${ids.length ? `use ${oneOf(ids)}` : 'this image has no payment provider'}`);
      } else {
        billing = provider.fromEnv(env, { baseUrl, errors, warnings }) || null;
        if (billing && billing.provider !== provider.id) throw new Error(`billing provider "${provider.id}": fromEnv() names "${billing.provider}"`);
      }
    }
    // Who joined before this date pays the founder's price of the products that have one; with
    // FOUNDER_OFFER_UNTIL, only until that date, and after it the regular price, founders too.
    if (billing && env.EARLY_ACCESS_UNTIL) {
      const until = Date.parse(env.EARLY_ACCESS_UNTIL);
      if (Number.isNaN(until)) errors.push(`EARLY_ACCESS_UNTIL "${env.EARLY_ACCESS_UNTIL}" is not a date (2026-12-01)`);
      else {
        billing.earlyAccessUntil = new Date(until).toISOString();
        if (env.FOUNDER_OFFER_UNTIL) {
          const offerUntil = Date.parse(env.FOUNDER_OFFER_UNTIL);
          if (Number.isNaN(offerUntil)) errors.push(`FOUNDER_OFFER_UNTIL "${env.FOUNDER_OFFER_UNTIL}" is not a date (2027-02-01)`);
          else if (offerUntil <= until) errors.push(`FOUNDER_OFFER_UNTIL (${env.FOUNDER_OFFER_UNTIL}) must come after EARLY_ACCESS_UNTIL (${env.EARLY_ACCESS_UNTIL})`);
          else billing.founderOfferUntil = new Date(offerUntil).toISOString();
        }
      }
    }
  }
  if (env.FOUNDER_OFFER_UNTIL && !billing?.earlyAccessUntil) {
    warnings.push('FOUNDER_OFFER_UNTIL does nothing without BILLING_PROVIDER and EARLY_ACCESS_UNTIL');
  }
  // The plan everyone has while the early access lasts, whatever the default plan is: from
  // EARLY_ACCESS_UNTIL on, the default plan again, and only then is anything sold.
  let earlyAccess = null;
  if (env.EARLY_ACCESS_PLAN) {
    const until = Date.parse(env.EARLY_ACCESS_UNTIL || '');
    if (Number.isNaN(until)) errors.push('EARLY_ACCESS_PLAN needs EARLY_ACCESS_UNTIL, the date the early access ends (2026-12-31)');
    else earlyAccess = { plan: env.EARLY_ACCESS_PLAN, until: new Date(until).toISOString() };
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
    earlyAccess,
    billing,
    // Purchases in the App Store and Google Play (STORE_BILLING), next to the web's.
    stores: storeBilling,
    mail,
    // ALERT_EMAIL, when alerts can go out; null otherwise.
    alerts: { to: alerts.to },
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
 * The install's store purchases (STORE_BILLING): a store provider registered (providers.js), such
 * as `revenuecat`, which reads its own variables.
 */
function storeBillingFromEnv(env, { modules, stores, errors }) {
  if (!env.STORE_BILLING) return null;
  if (!modules.billing) {
    errors.push('STORE_BILLING is set, but this app has modules.billing off');
    return null;
  }
  const provider = storeProviderOf(env.STORE_BILLING);
  if (!provider) {
    const ids = storeProviders().map((p) => p.id);
    errors.push(`STORE_BILLING "${env.STORE_BILLING}": ${ids.length ? `use ${oneOf(ids)}` : 'this image has no store provider'}`);
    return null;
  }
  const install = provider.fromEnv(env, { errors }) || null;
  if (!install) return null;
  if (install.provider !== provider.id) throw new Error(`store provider "${provider.id}": fromEnv() names "${install.provider}"`);
  if (!Object.keys(stores.products).length) {
    errors.push('STORE_BILLING is set, but suite.config.js stores.products sells nothing');
    return null;
  }
  return install;
}

/**
 * suite.config.js `billing`, all off by default (billing.js says why):
 *   { ignoreUnknownProducts: true, app: 'work', strictPrices: true, forgetOnRemove: true,
 *     stopOnOrganizationDeleted: true }
 * plus the settings each registered provider reads itself (providers.js `rules`), such as
 * Paddle's `paddleProductIds`, checked by it whichever provider the install has. `app` and
 * `strictPrices` only do something with a provider that `honors` them: with another, a warning.
 */
function billingRulesFor(given, install, errors, warnings) {
  const providers = billingProviders();
  const rules = { ignoreUnknownProducts: false, app: null, strictPrices: false };
  for (const provider of providers) for (const key of provider.rules?.keys ?? []) rules[key] = null;
  if (given === undefined) return rules;
  if (!isObject(given)) {
    errors.push('billing: an object, such as { ignoreUnknownProducts: true }');
    return rules;
  }
  const known = new Set([...BILLING_KEYS, ...providers.flatMap((provider) => provider.rules?.keys ?? [])]);
  for (const key of Object.keys(given)) {
    if (!known.has(key)) errors.push(`billing.${key} is not a setting (a typo?)`);
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
  for (const provider of providers) {
    if (provider.rules) Object.assign(rules, provider.rules.read(given, install, errors));
  }
  // A setting only another provider applies does nothing here: said, never an error.
  if (install) {
    const honored = new Set(billingProviderOf(install.provider)?.honors ?? []);
    for (const provider of providers) {
      if (provider.id === install.provider) continue;
      const ownOnly = [...(provider.honors ?? []), ...(provider.rules?.keys ?? [])]
        .filter((key) => rules[key] && !honored.has(key))
        .map((key) => `billing.${key}`);
      if (ownOnly.length) {
        warnings.push(`${ownOnly.join(', ')} ${ownOnly.length > 1 ? 'are' : 'is'} ${provider.name || provider.id}'s: with BILLING_PROVIDER=${install.provider} ${ownOnly.length > 1 ? 'they do' : 'it does'} nothing`);
      }
    }
  }
  return rules;
}

/**
 * The products with the prices of this install's provider. A product may give a price per
 * environment, `price: { sandbox: 'pri_…', production: 'pri_…' }`, since a provider's sandbox and
 * live account have their own ids: the one of the provider's environment is kept (the live one
 * when billing is off or the provider has none). A provider that says what its price ids look
 * like (providers.js `priceId`) has them checked here, so a price copied wrong stops the start
 * instead of a checkout.
 */
function productsFor(products, billing, errors) {
  const provider = billing ? billingProviderOf(billing.provider) : null;
  const environment = provider?.environment?.(billing) ?? 'production';
  const priceId = provider?.priceId ?? null;
  const pick = (key, field, value) => {
    if (!isObject(value)) return value;
    for (const name of Object.keys(value)) {
      if (!PRICE_ENVIRONMENTS.includes(name)) errors.push(`products.${key}.${field}: "${name}" is not sandbox or production`);
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
      if (priceId && resolved[field] != null && !priceId.pattern.test(resolved[field])) {
        errors.push(`products.${key}.${field}: "${resolved[field]}" is not ${priceId.name}`);
      }
    }
    // Prices no longer sold that subscriptions still renew on: a list, or one per environment.
    if (spec.oldPrices !== undefined) {
      const old = pick(key, 'oldPrices', spec.oldPrices) ?? [];
      resolved.oldPrices = old;
      if (!Array.isArray(old)) errors.push(`products.${key}.oldPrices: a list of price ids, or one per environment`);
      else if (priceId) {
        for (const price of old) {
          if (!priceId.pattern.test(String(price))) errors.push(`products.${key}.oldPrices: "${price}" is not ${priceId.name}`);
        }
      }
    }
    out[key] = resolved;
  }
  return out;
}
