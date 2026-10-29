# suite-core architecture

The target design of the platform shared by the Cronum Studio apps, agreed on 2026-09-27.
Modules marked **done** exist today; the rest is the plan, in the order of section 20. When code
and this document disagree, fix one of them in the same change.

## 1. Goals and constraints

- **One platform, many apps.** Tasks, Projects, Next, Focus and Tracker keep their own domain
  (lists, Gantt charts, progress logs, routines, GPS routes) and share everything that is the same
  everywhere: HTTP, accounts, sessions, tokens, OAuth for the MCP, the MCP transport, live updates,
  translations, plans, billing, administration. Show Lab (IDEAA Lab) takes the conventions only.
- **Same image, two ways to run it.** Every app can be downloaded and self-hosted for free
  (AGPL-3.0), and the same image runs as a paid hosted service. The difference is configuration,
  never a fork: local accounts and everything allowed by default; WorkOS accounts and paid plans
  when the environment says so.
- **Zero dependencies, no build.** `node:*` modules on the server, native ES modules in the
  browser, no bundler, no transpiler. `npm install` downloads nothing.
- **Nothing app-specific in here.** suite-core imports nothing from an app. What is the app's own
  (its tables, its texts, its page, its permissions over its records) is handed in when a module
  is created.
- **Adopted module by module.** No big-bang rewrite: every module can be used on its own through
  adapters, and each new one lands first in Next (small, English, well tested), then in Tasks
  (real users and the hosted version), then in the rest.

## 2. Where each piece comes from

Each shared piece takes the best version the apps already had:

| Piece | Taken from | Why that one |
| --- | --- | --- |
| Conventions (English, error codes, aliases, commits, versions) | Next | Already all English, API answers codes, renames recorded |
| HTTP kernel, database, migrations | Focus | Factories with injected dependencies, numbered migrations, strict request parsing |
| Principal and access checks | Focus | One resolver for every credential, one place that decides access |
| Sessions, secrets, brute-force brake | Focus + Tasks | Sliding sessions with rotation; secret generated when missing; brake persisted |
| OAuth for the MCP, WorkOS | Tasks (**done** here) | Proven in production and on the hosted version |
| MCP transport | Tasks / Next | The same code in three apps today |
| Live updates | Tasks + Focus | SSE hub of Tasks with the event ids and replay designed in Focus |
| Translations | Focus + Next | One `t()` for server and browser, CLDR plurals, parity and lint tools |
| Push, uploads | Tasks | Web Push without dependencies (RFC 8291/8292); uploads checked by content |
| Plans | Tasks | `planes.js`: catalog, per-user plan, barriers already placed |
| Web kit | Tasks, Next, Focus | `el()`, API client, theme, service worker, update notice, offline outbox |

## 3. Repository layout

suite-core is a git submodule mounted in each app at `server/suite`. Server modules sit at its
root so apps import them as `./suite/<module>.js`; browser code lives in `web/` and is served by the
app at `/suite/`.

```
suite-core/
  oauth.js              done   OAuth 2.1 authorization server for the MCP endpoint
  workos.js             done   WorkOS AuthKit client (sign-in with PKCE, JWT verification)
  workos-accounts.js    done   /auth routes and how a WorkOS account becomes a user
  oidc.js               done   sign-in with any OpenID Connect provider (Authentik, Keycloak, Google…)
  jwt.js                done   JWTs checked against a provider's published keys (RS256, ES256)
  config.js             done   loads and validates suite.config.js + the environment
  app.js                done   createSuite() wires the modules; createApp() dispatches in the order of §11
  host.js               done   createHost(): several apps as one, each a module at its own path (§21)
  legacy-domains.js     done   the apps' old addresses, answered by a host for a while (§21.2.1)
  watcher.js            done   hot reload by polling, for code mounted over SMB
  http.js               done   router, HttpError, body parsing, security headers, CSRF, static files
  db.js                 done   openDatabase(): WAL, foreign keys, all/get/run/tx, app_meta
  migrate.js            done   numbered migrations with scopes (suite, app, and each module's id in a host)
  crypto.js             done   scrypt, HMAC, random tokens, token hashes, AES-256-GCM
  accounts.js           done   users, identities, passwords, sign-in, the admin's rules; hooks for the app
  account-deletion.js   done   someone deleting their own account: disabled now, gone after its days
  sessions.js           done   browser sessions: sliding, rotated, revocable
  tokens.js             done   API tokens (manual MCP tokens) with scopes and expiry
  revoke.js             done   revokeEverything: a new password or "sign out everywhere" ends every way in
  workos-events.js      done   a reset on AuthKit's own page heard from WorkOS's Events API (every minute) → revokeEverything
  devices.js            done   device tokens: an app on a phone, connected through the system browser with PKCE
  device-pages.js       done   the connect page and sessions of the web from a device's token (devices.connectPage, webSessions)
  principal.js                 one resolver: cookie, bearer token, OAuth, AuthKit JWT (never a device token)
  rate-limit.js         done   brute-force brake persisted in the database
  organizations.js      done   organizations, memberships, roles, invitations, seats, kinds an app manages
  entitlements.js       done   features, plans and grants; can() / limit() / require()
  billing.js            done   payments turned into grants: provider interface, signed webhooks
  stripe.js             done   Stripe as that provider: Checkout, Customer Portal, signed webhooks
  stores.js             done   purchases in the App Store and Google Play: a second billing instance, the store adapter interface
  mcp.js                done   Streamable HTTP transport, tool registry, prompts
  live.js               done   SSE hub with audiences, event ids and replay
  i18n.js               done   catalogs, language negotiation, t() on the server
  push.js               done   Web Push (VAPID, RFC 8291), subscriptions per device and language;
                               sending to an app's own devices, with no user behind them
  native-push.js        done   the same notices to the suite's phone app, straight to APNs (HTTP/2) and FCM v1;
                               reminders the phone shows itself are not pushed to it
  uploads.js            done   file storage checked by content, serving, orphan sweep with brakes; a file from a link;
                               storeChecked: the cap per record and storage.mb before and after the file arrives
  storage.js            done   the storage a plan allows (storage.mb): check(user, adding, { payer }), the apps' 402
  mcp-files.js          done   files an assistant attaches: from a link, or through a one-time upload link
  time.js               done   whose "today": the person's zone (prefs.tz) through a request, else the server's
  prefs.js              done   users.prefs: a module's own keys and the shared ones (lang, lang_seen, tz); the account as the browser sees it
  mcp-kit.js            done   what the tools are written with: text, S, tool({ kind }), describeError, trimRepeats
  resolve.js            done   names as people say them → an item, or the options to ask about (ResolveError)
  sharing.js            done   offering something to someone, accepting, leaving; one's people; the routes
  share-brake.js        done   the brake on invitations: new offers an hour, one notice per pair a day
  dates.js              done   dates as people say them → YYYY-MM-DD, in four languages, never rolled over
  zip.js                done   zip archives with no dependencies: streamed writing, capped reading, ZIP64
  portability.js        done   copies of someone's data and of the whole install, and importing them
  mail.js               done   outgoing mail: SMTP without dependencies, or the log
  account-mail.js       done   confirming emails, new passwords, invitations, open sign-up
  two-factor.js         done   two-step verification: TOTP codes, recovery codes, the challenge
  audit.js              done   who did what and when, never the content
  api.js                done   the common routes: /api/me/*, /api/admin/* and /api/orgs/*
  i18n/                 done   the suite's own texts: en.json, es.json, fr.json, de.json
  idempotency.js        done   a write sent twice with the same Idempotency-Key answers once
  web/                  done   the web kit (§15, docs/web-kit.md), served at /suite/; the admin panel at /admin
  tools/                done   i18n.mjs: catalog parity, keys in use, texts written in the code; data-cli.js: copies from the
                               command line; conformance.js: the platform checks for a running app
  test/                        suite-core's own tests (node:test)
  docs/                        this document and the module guides
```

## 4. How an app uses it

An app is its domain plus two things that describe it to the suite: `server/suite.config.js`
(what the product is: modules, languages, features, plans, products) and its environment (where
and how this install runs: URLs, secrets, providers). Two files of the app wire it (**done**,
v0.11.0; Next is the model):

```js
// server/platform.js — the services, created once, for the rest of the server to import
import product from './suite.config.js';
import { createSuite } from './suite/app.js';
import { MIGRATIONS } from './migrations.js';          // the app's own, numbered
import { textsFor } from './i18n.js';
import { oauthPage } from './oauth-page.js';

export const suite = createSuite({
  config: product, migrations: MIGRATIONS,
  hooks: { texts: textsFor, oauthPage },               // how the OAuth consent screen looks
});

// server/index.js — the server
import { suite } from './platform.js';
import { createApp } from './suite/app.js';
import { api, serializeUser } from './api.js';          // the app's own routes
import { mcp } from './mcp.js';                         // { instructions, tools, prompts… }

createApp({ suite, publicDir, routes: api, mcp, serializeUser, version: APP_VERSION }).listen();
```

`createSuite` opens `DATA_DIR/<app id>.db`, runs the app's migrations and then the suite's, and
creates every service the configuration asks for; the app's modules import them from
`platform.js` (`suite.database`, `suite.accounts`, `suite.entitlements`…). `createApp`
registers the suite's routes before the app's, the MCP endpoint with the app's tools, and serves
the app's static files; it also creates the first administrator, runs the periodic clean-ups,
watches the code with `HOT_RELOAD=true` and shuts down in order. An app can still use a module on
its own, with adapters to its own tables, while it moves over.

The same app can also run as a module of a host, several apps as one (§21): its `platform.js`
then tries `joinHost()` first, and a `server/module.js` hands the host what `index.js` hands
`createApp()`. On its own, nothing of that runs.

## 5. The configuration file

`suite.config.js` sits in the app's `server/` folder (the one installs like the NAS mount live, so no
container has to be recreated for it) and is committed: it is the product definition, the same
for every install. suite-core validates it on start and refuses to start with a message that
says what is wrong — a misspelled feature must never leave a barrier open.

```js
export default {
  app: {
    id: 'tasks',                  // [a-z0-9-]; names the cookie (tasks_sid), the database file and feature keys
    name: 'Tasks',                // shown on the consent screen, in the MCP server info, in mail
    port: 3456,                   // default for PORT (see the port registry in CONVENTIONS.md)
    languages: ['en', 'es'],      // English first: it is the fallback
    color: '#EF4B2A',             // the product's colour: the accent of the OAuth consent screen
    icon: '/icons/favicon.svg',   // the default; a path on the app, with its ?v= if the icons carry one
    mail: {                       // how its emails look (mail-layout.js), all optional:
      icon: '/icons/apple-touch-180.png',  // the default: a PNG on the app (mail clients show no SVG); null for none
      colorOnDark: '#8C9BFF',     // the button and links in dark mode, with ink text (default: color, cream text)
      signature: 'by Cronum Studio',       // after the product's name at the foot
      about: { en: 'What it is, in a line.', es: '…' },  // under an invitation, for whoever doesn't know it
    },
  },

  // Anything not listed keeps its default; a key that is not a module is an error.
  // Live updates, push and uploads join this list when they move into the suite.
  modules: { oauth: true, mcp: true, admin: true, organizations: false, billing: false },

  accounts: {
    signup: 'admin',              // admin: only the admin | invite: by email | open: anyone (SIGNUP overrides)
    minPasswordLength: 10,
  },
  sessions: { idleDays: 30, maxDays: 365 },   // cookieName: '<app id>_sid' unless given
  tokens: { prefix: 'mcp_' },     // how the app's API tokens start
  // Only with modules.devices: an app on a phone (section 7). Both values end up in the installed apps.
  devices: { prefix: 'appdev_', redirectUris: ['com.example.app:/auth'], idleDays: 90 },
  // With it, also (both off by default): the suite's connect page at /devices/connect, and sessions
  // of the web opened from a device's token (POST /api/devices/web-session, GET /devices/session).
  // devices: { …, connectPage: true, webSessions: true },
  // With modules.push and modules.devices (off by default): the same notices to the phone's app
  // through APNs and FCM (section 16), APNS_* and FCM_SERVICE_ACCOUNT in the environment.
  // push: { native: true, apnsTopic: 'com.example.app', androidChannel: 'default' },
  trustProxy: true,               // the default of TRUST_PROXY when an install doesn't set it

  organizations: {                // only with modules.organizations
    roles: ['owner', 'admin', 'member'],   // plus the app's own, e.g. 'driver' in Tracker
    invitationDays: 7,
    // seatRoles: ['driver'],     // some of roles, the ones that take a seat (else every member)
    // Kinds the app manages itself (section 10): the generic /api/orgs routes refuse to create,
    // join, leave or remove members of them; maxPerUser caps them per person; onEmpty: 'delete'
    // (a managed kind's default) deletes a group whose last member goes instead of archiving it.
    // kinds: { family: { managed: true, maxPerUser: 1 } },
    // Which groups and roles a person's copy of the data takes are the data declaration's
    // `organizations.copyKinds` and `copyRoles` (portability.js), some of these.
  },

  // What a plan can switch on, off or cap. Keys are the app's own; across apps they are
  // namespaced by the app id (tasks.attachments). Anything not listed cannot be limited.
  features: {
    'lists.max':   { type: 'limit', default: null },   // null = no cap
    sharing:       { type: 'flag',  default: true },
    attachments:   { type: 'flag',  default: true },
    'storage.mb':  { type: 'limit', default: null },
    mcp:           { type: 'flag',  default: true },
  },

  // The catalog. Without it there is one implicit plan with every default: free and unlimited.
  plans: {
    free: { name: 'plans.free', features: { 'lists.max': 5, attachments: false } },
    pro:  { name: 'plans.pro',  features: {} },
  },
  defaultPlan: 'free',

  // What can be bought, with modules.billing and a BILLING_PROVIDER (section 9).
  products: {
    'pro-monthly':  { plan: 'pro', kind: 'subscription' },
    'pro-lifetime': { plan: 'pro', kind: 'once' },
    // A group's: the quantity bought is its seats, unless `seats: false` (any number of adults).
    'family-yearly': { plan: 'pro', kind: 'subscription', for: 'organization', seats: false },
  },

  // What keeps another product's sales out, all off unless given (section 9, "Another product's sales").
  // `app` is not app.id: one value for every app sold as one subscription (Cronum Work's say 'work').
  // A provider's own settings go here too (providers.js `rules`), unless it keeps them for the app (`catalog`).
  billing: { ignoreUnknownProducts: true, app: 'work', strictPrices: true },
  // billing.forgetOnRemove: true lets an account that goes take its billing links and grants here with it
  // (and a group deleted, its billing links); billing.stopOnOrganizationDeleted: true stops a deleted
  // group's subscriptions renewing at the end of the period paid (section 10).

  // What the app on a phone sells in the App Store and Google Play, with STORE_BILLING (section 9,
  // "Several providers and the stores"). `devices`: the store routes also take the app's device tokens.
  stores: {
    products: { 'pro-monthly': { plan: 'pro', kind: 'subscription', appStore: 'com.example.app.pro.monthly', playStore: 'app_pro:monthly' } },
    devices: true,
  },
};
```

Environment variables configure the install, never the product (`config.js` reads them):
`BASE_URL`, `PORT`, `HOST`, `HOST_PORT`, `DATA_DIR`, `DB_PATH`, `TZ`, `TRUST_PROXY`, `SECURE_COOKIES`,
`SESSION_SECRET`, `ADMIN_USER`, `ADMIN_PASSWORD`, `ADMIN_DISPLAY_NAME`, `ADMIN_EMAIL`, `AUTH_PROVIDER`
(`local` | `workos` | `oidc`), `WORKOS_*`, `OIDC_*`, `MCP_OAUTH`, `CIMD_ALLOW_PRIVATE_HOSTS`, `HOT_RELOAD`,
`BILLING_PROVIDER` (`remote`, `stripe` or one registered from outside) with `BILLING_*`, `STRIPE_*` or its own, `EARLY_ACCESS_UNTIL`,
`FOUNDER_OFFER_UNTIL` and `EARLY_ACCESS_PLAN`,
`STORE_BILLING` (a registered store provider) with its own variables, `MAIL_PROVIDER` (`log` |
`smtp`) with `MAIL_*`, `ALERT_EMAIL`; `VAPID_*`; with `push.native`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`,
`APNS_TOPIC` and `FCM_SERVICE_ACCOUNT`. Three product settings may be overridden
per install: `PLANS` (JSON, same shape as `plans`), `DEFAULT_PLAN` and `SIGNUP`.
An old variable name (`RECARGA_EN_CALIENTE`, `PORT_HOST`, `PUERTO`, `PUBLIC_URL`) stops the start and
names the new one, and `BASE_URL` is required when `NODE_ENV=production`.

## 6. Data model

One SQLite file per app (`DATA_DIR/<app id>.db`), WAL mode, foreign keys on. The suite owns the
tables below; the app owns the rest and references `users(id)` or `organizations(id)`.

Conventions: integer ids; timestamps as ISO 8601 UTC with milliseconds and `Z`
(`strftime('%Y-%m-%dT%H:%M:%fZ','now')`), which sort as text; JSON in `TEXT` columns; secrets only
as hashes. Columns an app adds to a suite table carry the app id as prefix.

```sql
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- session secret, VAPID keys…

CREATE TABLE schema_migrations (
  scope      TEXT NOT NULL,              -- 'suite' | 'app'
  version    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (scope, version)
);

-- A person who can sign in. Profile basics only; what is the app's own lives in its tables.
CREATE TABLE users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  username          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name      TEXT NOT NULL,
  email             TEXT,                -- only ever a verified address
  email_verified_at TEXT,
  password_hash     TEXT,                -- scrypt$N$r$p$salt$hash; NULL when signing in elsewhere
  role              TEXT NOT NULL DEFAULT 'user',       -- instance role: 'admin' | 'user'
  locale            TEXT,                -- NULL: negotiated from the browser
  theme             TEXT NOT NULL DEFAULT 'system',
  prefs             TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  last_login_at     TEXT,
  disabled_at       TEXT
);

-- How someone signs in besides a password: one row per provider account.
CREATE TABLE user_identities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,           -- 'workos' | 'oidc:<issuer>'
  subject       TEXT NOT NULL,           -- the provider's id for that person
  email         TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  UNIQUE (provider, subject)
);

CREATE TABLE sessions (
  token_hash          TEXT PRIMARY KEY,  -- HMAC(token, session secret); the cookie holds the token
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at          TEXT NOT NULL,
  last_used_at        TEXT NOT NULL,
  expires_at          TEXT NOT NULL,     -- sliding: last use + idleDays
  absolute_expires_at TEXT NOT NULL,     -- created + maxDays, never extended
  user_agent          TEXT,
  ip                  TEXT,
  idp_session_id      TEXT               -- the AuthKit / OIDC session, closed on sign-out
);

-- Manual tokens for MCP clients that cannot do OAuth, and for scripts.
CREATE TABLE api_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,     -- sha256; the value is shown once
  prefix       TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT '["mcp"]',
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT
);

-- oauth_clients, oauth_grants, oauth_tokens: see OAUTH_SCHEMA in oauth.js (done).

-- An app on a phone, with modules.devices (devices.js, migration 22). Not `devices`: Focus has
-- a table of its own by that name.
CREATE TABLE device_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,            -- what the person called it when connecting it
  platform     TEXT,                     -- 'ios', 'android'
  app_version  TEXT,
  token_hash   TEXT NOT NULL UNIQUE,     -- sha256; the value is shown once, to the app
  prefix       TEXT NOT NULL,            -- devices.prefix when it was made
  created_at   TEXT NOT NULL,
  last_used_at TEXT,                     -- at most once a minute; idleDays after it, it ends
  revoked_at   TEXT
);
CREATE TABLE device_codes (              -- what the browser hands back to the app: five minutes, once
  code_hash      TEXT PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_challenge TEXT NOT NULL,          -- PKCE S256
  redirect_uri   TEXT NOT NULL,          -- one of devices.redirectUris, exactly
  name           TEXT NOT NULL,
  platform       TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  used_at        TEXT,                   -- spent by its first exchange, right or wrong
  device_id      INTEGER REFERENCES device_tokens(id) ON DELETE SET NULL   -- revoked if the code comes back
);
-- Sessions of the web from a device's token (devices.webSessions, migration 23): what the WebView
-- opens at /devices/session, one minute, once; and sessions.device_id (nullable, ON DELETE
-- CASCADE), the device a session came from, which it lives and ends with.
CREATE TABLE device_web_codes (
  code_hash  TEXT PRIMARY KEY,           -- sha256; the value goes once, to the device
  device_id  INTEGER NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT                        -- spent by its first use, right or wrong
);
-- A phone's native push token (push.native, migration 24): one per device, gone with it.
CREATE TABLE device_push_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   INTEGER NOT NULL UNIQUE REFERENCES device_tokens(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL,             -- ios | android
  token       TEXT NOT NULL,             -- APNs device token (hex) or FCM registration token
  environment TEXT,                      -- APNs: sandbox | production
  lang        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_ok_at  TEXT,
  failures    INTEGER NOT NULL DEFAULT 0  -- refusals in a row; three and it goes
);
CREATE UNIQUE INDEX ux_device_push_tokens_token ON device_push_tokens (platform, token);
-- The reminders a phone's app shows itself as local notifications (push.native, migration 26), as
-- it last said them: a native send of the same reminder skips that phone. Gone with the device.
CREATE TABLE device_reminders (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
  module    TEXT,                        -- the module's path in a host; NULL for an app on its own
  item_id   TEXT NOT NULL,               -- the module's id of the item (a task's), as text
  at        TEXT NOT NULL                -- the instant it rings, ISO-8601 in UTC
);
CREATE INDEX ix_device_reminders_device ON device_reminders (device_id, item_id);

CREATE TABLE login_attempts (bucket TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX ix_login_attempts ON login_attempts (bucket, at);

-- Groups that share data, roles and a subscription: a household, a school, a team.
CREATE TABLE organizations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  kind        TEXT,                      -- free text for the app: 'household', 'school'…
  settings    TEXT NOT NULL DEFAULT '{}',
  branding    TEXT NOT NULL DEFAULT '{}',  -- logo, colors: Tracker's schools
  created_at  TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE memberships (
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,         -- owner | admin | member | the app's own roles
  invited_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  joined_at       TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE invitations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           TEXT,
  role            TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  invited_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  accepted_at     TEXT,
  revoked_at      TEXT
);
-- The clean-up deletes those accepted or withdrawn, and those expired over 14 days ago: they hold
-- the email they were sent to, and none can let anyone in any more.

-- What someone is entitled to. One row per plan or single feature granted to a user or an
-- organization, from a source, for a window. Subscriptions, one-off and lifetime purchases,
-- trials, gifts and seats are all rows here.
CREATE TABLE entitlement_grants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL,            -- 'user' | 'organization'
  subject_id   INTEGER NOT NULL,
  plan         TEXT,                     -- a plan id…
  feature      TEXT,                     -- …or one feature
  value        TEXT,                     -- JSON value for that feature
  quantity     INTEGER,                  -- seats, credits
  source       TEXT NOT NULL,            -- 'admin' | 'stripe' | 'license' | 'promo' | 'remote'
  external_ref TEXT,                     -- subscription or order id at the provider
  starts_at    TEXT NOT NULL,
  ends_at      TEXT,                     -- NULL: no end (lifetime, or until revoked)
  revoked_at   TEXT,
  created_at   TEXT NOT NULL,
  note         TEXT,
  CHECK ((plan IS NULL) <> (feature IS NULL))
);
CREATE INDEX ix_grants_subject ON entitlement_grants (subject_type, subject_id);

CREATE TABLE billing_customers (
  subject_type TEXT NOT NULL,
  subject_id   INTEGER NOT NULL,
  provider     TEXT NOT NULL,            -- 'stripe'
  customer_id  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (subject_type, subject_id, provider)
);
CREATE TABLE billing_subscriptions (     -- the latest known state of each subscription
  provider     TEXT NOT NULL,
  ref          TEXT NOT NULL,            -- the subscription at the provider
  subject_type TEXT NOT NULL,
  subject_id   INTEGER NOT NULL,
  product      TEXT NOT NULL,
  status       TEXT NOT NULL,            -- active | trialing | past_due | canceled…
  quantity     INTEGER,
  period_end   TEXT,
  occurred_at  TEXT NOT NULL,            -- of the event it came from: older ones are ignored
  updated_at   TEXT NOT NULL,
  refunded_until TEXT,                   -- a refunded period, which doesn't give the plan back
  PRIMARY KEY (provider, ref)
);
CREATE TABLE billing_pending (           -- paid for by an identity with no account here yet
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  provider          TEXT NOT NULL,
  identity_provider TEXT NOT NULL,       -- 'workos'
  identity_subject  TEXT NOT NULL,       -- 'user_01…'
  ref               TEXT NOT NULL,
  event             TEXT NOT NULL,       -- the normalized event, applied at the first sign-in
  occurred_at       TEXT NOT NULL,
  received_at       TEXT NOT NULL
);
CREATE TABLE billing_events (            -- each webhook event applied once; a store's notes (note:…)
  provider    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  type        TEXT NOT NULL,
  outcome     TEXT NOT NULL,             -- granted | extended | changed | revoked | kept | stale… | note
  received_at TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE push_subscriptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  locale       TEXT,                     -- the notification is written in the device's language
  user_agent   TEXT,
  created_at   TEXT NOT NULL,
  last_ok_at   TEXT,
  failures     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  at              TEXT NOT NULL,
  actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,         -- 'auth.login', 'admin.user.create', 'billing.grant'…
  target_type     TEXT,
  target_id       TEXT,
  ip              TEXT,
  meta            TEXT NOT NULL DEFAULT '{}'   -- never content: no titles, notes or passwords
);

-- Copies imported here (portability.js): the same one is never applied twice.
CREATE TABLE data_imports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  export_id   TEXT NOT NULL,             -- the copy's id, from its manifest
  scope       TEXT NOT NULL,             -- 'account' | 'install': what the copy holds
  target      TEXT NOT NULL,             -- 'install', or 'user:<id>' for someone's own import
  imported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  app_version TEXT,
  counts      TEXT NOT NULL DEFAULT '{}',
  imported_at TEXT NOT NULL,
  UNIQUE (export_id, target)
);
```

**Migrations.** `migrate(db, list, { scope })` applies numbered, immutable migrations in one
transaction each and records them in `schema_migrations`; the suite's run under scope `suite`, the
app's under `app`. A migration that is wrong is fixed by a new one. Tests run every migration twice
on the same database: the second run must change nothing.

**Adopting an existing database.** Tasks, Projects and Next grew their schema with
`CREATE TABLE IF NOT EXISTS` and `ensureColumn`. Their first app migration is a *baseline*: the
current schema, idempotent, so an existing database passes through it untouched and a new one is
created whole. The suite's first migrations then adapt what already exists to the tables above:
`mcp_tokens` becomes `api_tokens`; `users.workos_user_id` becomes a `user_identities` row;
`sessions.token` / `workos_sid` become `token_hash` / `idp_session_id`; `users.plan` and
`plan_expires_at` become an `entitlement_grants` row with source `admin`; timestamps written by
`datetime('now')` are rewritten as ISO 8601 with `Z`. Password hashes need nothing: every app
already stores `scrypt$N$r$p$salt$hash`. Focus's `accounts` + `persons` map to `users` + its own
`persons` table, which keeps the profiles that have no account (children).

## 7. Identity and access

**Principal.** One resolver turns whatever credential a request carries into the same shape, and
everything else consumes that shape:

```js
{ user, kind: 'session' | 'token' | 'oauth' | 'idp', scopes, credentialId }
```

It looks, in order, at the session cookie, then `Authorization: Bearer` (a manual API token, then
a built-in OAuth access token, then an AuthKit JWT). There is no second path for any of these
clients. A device token is not one of them: no route of the suite takes it, the MCP included
(except, with `stores.devices`, the store routes and `/api/billing/overview`, section 9), and an
app checks it itself on the routes it opens to devices (`suite.devices.authenticate(req)`, below),
so Tracker's native app reaches only what Tracker chose. Focus keeps its own pairing for
its kiosks and ESP32 screens, with its `X-Focus-Device` header.

**Device tokens** (**done**, v0.67.0, `devices.js`, with `modules.devices`): what an app on a phone
holds instead of a session (Tracker's native app). The app opens the system browser on its own
connect page with a PKCE challenge (S256) and the address to come back to, a private-use scheme of
its own (RFC 8252); the person signs in there as on the web and says yes; the page asks
`POST /api/devices/codes` (session only, the address one of `devices.redirectUris`, exactly) for a
code of five minutes and sends the browser back with it (`redirect_to`, with the `state`); the app
exchanges the code, its verifier and the address at `POST /api/devices/token` for a token that
starts with `devices.prefix` (never `tokens.prefix` nor the built-in OAuth's `mcpat_`, `mcprt_`,
`oc_`, `ocs_`), shown once and kept as a hash. A code is spent by its first exchange, right or
wrong. One that comes back after that with its verifier and its address means the verifier got out
too (or the app retries an answer it lost), and the device it gave is revoked (OAuth 2.1 §4.1.3);
without them it is only refused, so whoever saw the code in a history or a log can't disconnect the
phone. Only failed exchanges count against an address (`rateLimits.devices`, 30), so a fleet of
phones connected from one office is never stopped. A token ends when it is revoked (Settings,
`DELETE /api/me/devices/:id`; the app signing out, `DELETE /api/devices/current` with the token; or
the admin signing the person out everywhere or setting their password, `devices.revokeAllOf(id)`),
after `devices.idleDays` (90) without use, and with the account; a disabled account's are refused,
as its API tokens are. No route of the suite takes one, the MCP included (except, with
`stores.devices`, the store routes and `/api/billing/overview`; with `devices.webSessions`,
`/api/devices/web-session`; and `/api/devices/actions`, below): `ctx.user` only ever comes from
the session cookie. The app accepts a device on the routes it chooses with
`suite.devices.authenticate(req)` (the account with its `device_id`, or null) and checks an open
connection with `isActive(id)`. Not for a module of a host: a
host turns it on in its own suite.config.js, and its phone connects to the whole app. Focus
pairs its kiosks the other way round (a code shown on the signed-in screen and typed or scanned on
the device, bound to a profile with runner-only scopes, in its `X-Focus-Device` header) and keeps
its own pairing; the tables are named so that both live in its database.

**The connect page** (**done**, v0.105.0, `device-pages.js` and `web/connect.js`, with
`devices.connectPage`): the suite serves `/devices/connect` itself, ported from Tracker's (which
Tracker keeps), for any app or host with `modules.devices`. The app opens it with
`?code_challenge&state&redirect_uri&name&platform`; a query that is not a request the core takes
(the address exactly one of `devices.redirectUris`) goes to the bare page, which says the link
can't connect a device. Signed out with local accounts, the page signs in in place (second step
included); under a provider's sign-in the request waits in a signed cookie (`<app id>_connect`, ten
minutes, HttpOnly, SameSite=Lax) while the browser goes to `/auth/login`, and `/` brings it back
once the provider's callback lands there with a session (in a host, before `/` goes to the first
module). Allow asks `POST /api/devices/codes` and goes back to the app with the code; Cancel goes
back with `error=access_denied`. In the product's name and colours, in the person's language.
Signed in, the page names the account (its name and email) with **Use another account** (v0.126.0):
the browser may still hold the session of an earlier connect, and an app that signed out had no
other way to switch. It ends that session (`POST /api/auth/logout`, its `logout_url` left aside so
the browser stays on the page) and opens the same request with `&prompt=login`: with local accounts
the page signs in in place; under a provider's sign-in the server sends the browser to
`/auth/login?prompt=login` (its cookie carrying the request as before), which asks the provider to
sign in again instead of reusing its own session (OIDC `prompt=login`; AuthKit `max_age=0`), and
`/` brings it back to the request without the prompt. `/auth/login` without `prompt=login` is as it
was; nothing but the connect page asks for it.

**Sessions of the web from a device** (**done**, v0.105.0, with `devices.webSessions`): an app
whose screens are its web pages in a WebView (Cronum Work) turns its token into the web's own
session. `POST /api/devices/web-session` with `Authorization: Bearer <device token>` (the token
only) answers `{ url: '/devices/session?code=…', expires_at }`: a code of one minute, once, kept
as a hash and bound to the device. `GET /devices/session?code=…&next=<path>` opens an ordinary
session (the same cookie as a sign-in, with its `sessions.idleDays` and `maxDays`), noted as a
sign-in, and goes to `next` when it is a path of this site, else to `/`. A code that is unknown,
spent, expired, or whose device no longer works (revoked, idle, a disabled account) opens nothing and goes to `/`; these failures count against the address in the token's
bucket (`rateLimits.devices`). So that nobody can sign someone else into their own account, three
requests are refused without spending the code or counting against the address, and go to
`/?device_session=refused`, which tells the app to clear its WebView's cookies and try once more:
one that is not the app's own load (`Sec-Fetch-Site` other than `none`: another site, or a link
or an image in a note of this one; nothing of this site links to the route); one that is not a
top-level load of the page (`Sec-Fetch-Dest` other than `document` or `Sec-Fetch-Mode` other than
`navigate`: an image in a shared note, `![](/devices/session?code=…)`, a frame, a fetch; a WebView
too old to send them sends none of the three, and is let through; Android's WebView and WKWebView
send `none`, `navigate` and `document`); and one from a browser where another person has a live
session (`signed_in`). Only a session that a device opened before (`sessions.device_id` set: a
WebView that kept the cookie of the account it had) is replaced, and only by a load that says
`Sec-Fetch-Site: none`; an ordinary session of the web never is, and a load with no Fetch Metadata
(WKWebView before iOS 16.4, any `http://` address, where an image sends none either) replaces no
one's session: the app clears the cookies and its second load, with none, opens. One of the same
person is replaced as before. `device.web_session` and `device.web_session_failed` are in the audit
log, the latter with its reason: `unknown`, `reused`, `expired` or `device`, and `signed_in` at
most ten times per address in the window (a good code is not spent by it, so it could be loaded
over and over); a refusal decided by the headers alone writes nothing, since it reads no code and
anyone could send it. The session keeps its
device (`sessions.device_id`): revoking the device by its owner, by itself or by the admin closes
it at once, and every use asks the device first (`sessionAlive`), so it also ends when the device
stops working any other way, or the module is switched off; using it is using the device, which
then never goes idle while its WebView is in use. No second step is asked: the token was given
to a session that had already passed it, and the session it opens dies with it.

**Actions from a notification** (**done**, v0.108.0, with `modules.devices`): a phone acts on a
notification's buttons (Complete, Snooze on a task's reminder) without opening the app.
`POST /api/devices/actions` with `Authorization: Bearer <device token>` (the token only: a session
cookie alone is a 401, and with both the token decides) and the body `{ module, action, id,
...params }`, e.g. `{ module: 'tasks', action: 'complete', id: '123' }` or `{ module: 'tasks',
action: 'snooze', id: '123', minutes: 60 }`. `module` is the module's path in a host (an app on its
own takes none, or its own app id), `action` a name of lowercase letters, digits, `_`, `.` or `-`,
`id` a text or a number (handed over as text, or null), and every other key of the body is a
param. It answers 200 `{ ok: true, ... }` with what the handler answered (a plain object) beside
`ok`; 404 `action_not_found` for a module or an action nobody declared (a module that declares
none, `constructor` and the like included); 400 `field_required`/`field_invalid` for a body
without `action` or with an `id` or `module` of the wrong kind; and the handler's own `HttpError`s
as they are (a 404 for an item that isn't the person's, a 400 for a param). A device token that is
missing, unknown, revoked, idle or of a disabled account is a 401, and
counts against the address in the devices' bucket (`rateLimits.devices`), as the other device
routes do; a refusal of the module's counts nothing. With an `Idempotency-Key` a retried action
runs once: the route keys it itself, by the device's account, once it knows it (`keyedByRoute` in
idempotency.js; `ctx.user` only ever comes from a session). Each action done is in the audit log,
`device.action` with `{ module, action, id }` and the device as its target, never the params
(they may be someone's words). Without `modules.devices` the route doesn't exist and nothing of it
runs.

What answers is declared next to the routes: a host's module in `createModule().deviceActions`, an
app on its own in `createApp({ deviceActions })` (so an app that spreads its module's parts into
`createApp()` gets the same actions on its own, and ignores them without `modules.devices`). An
object of handlers, or a function `(action) => handler | null` for a module that builds them
itself; what is declared wrong (not a function, a name of the wrong shape) stops the start, saying
which:

```js
// a module's server/module.js (Tasks, for its reminders)
export function createModule() {
  return {
    routes: api,
    deviceActions: {
      // The same code as PATCH /api/tasks/:id: its permission check, its transaction, its live notice.
      complete: async ({ user, id }) => ({ task: completeTask(user, Number(id)) }),
      snooze: async ({ user, id, params }) => ({ remind_at: snoozeReminder(user, Number(id), params.minutes) }),
    },
  };
}
```

A handler gets `{ user, id, params, suite, action }`: `user` is the device's account (with its
`device_id`), as `suite.devices.authenticate()` gives it; `suite` is the module's own (in a host,
its view: its live channel, its plans, its links). It acts as that person, with that person's
permissions only: it must check the item is theirs or shared with them as its own API does, and
answer 404 for one they can't see. It goes through the same code its web route uses, so the change
is announced on the module's live channel (open tabs repaint), tells its links and keeps its plan
limits as any change from the web does: the suite adds nothing of that itself. A module the person
turned off in Settings › Modules still acts, as its pages still open at its path.

**Roles** live at two levels: the instance (`users.role`: `admin` runs the install and is never
limited by plans) and each organization (`owner`, `admin`, `member` and the app's own roles).
Permissions over the app's records (shared lists, project members, guardianships, assigned routes)
stay in the app and are decided from the principal. A resource someone may not see answers 404, not
403; 403 is for a resource they see but an action they may not take.

**Sessions** are sliding (`idleDays` since last use) with an absolute end (`maxDays`), rotated on
sign-in and on any change of privilege. Changing one's password closes every other session.
`SESSION_SECRET` comes from the environment; without it — or with a value from an example — one is
generated on the first start and kept in `app_meta`.

**CSRF.** An unsafe request (not GET, HEAD or OPTIONS) that carries the session cookie must come
from the app's own origin (`Origin`, else `Sec-Fetch-Site: same-origin`). Requests without the
cookie — bearer tokens, the OAuth endpoints — are not subject to it. `readJson` requires
`Content-Type: application/json`.

**Brute-force brake.** Fixed 15-minute windows, persisted in `login_attempts`: 10 failures per
account (the real protection) and 60 per IP (high on purpose: a household behind one proxy shares
it); 5 wrong codes of the second step per account, since whoever gets there knows the password. `X-Forwarded-For` is trusted only with `TRUST_PROXY=true` (or a number of proxies); behind Cloudflare and a reverse proxy, `TRUST_PROXY=cloudflare` takes the client from `CF-Connecting-IP`, for an origin that answers nothing but Cloudflare. For tokens only failures count, so
a valid client is never locked out by a neighbour, and a request without a token always gets its 401: that is how signing in starts. Once an address is blocked its failures are no longer written down.

**Sign-in providers.** `local` (default): usernames and passwords, accounts created by the admin,
by invitation or by open sign-up as `accounts.signup` says, and two-step verification for whoever
turns it on (**done**, v0.19.0; see below). `workos`: AuthKit handles sign-up, 2FA,
Google and recovery, and is the authorization server for the MCP; an existing user is linked only
through a verified email, and `ADMIN_EMAIL` takes over the first admin while the install moves to
WorkOS (afterwards, only one with no email). Someone WorkOS knows by a new id (another environment,
or their account made again there) keeps their account, linked by its verified email once WorkOS
says the old id is gone (v0.32.0). The AI clients AuthKit authorized for the app are listed in
Settings beside the built-in OAuth's, with their last use here, and disconnected from there: the
authorization is withdrawn at WorkOS and the access tokens it had issued are refused here until
they expire (`idp_connections`, v0.35.0). Each app lists only the authorizations for its own `/mcp`, and disconnecting one leaves the client connected to the other apps: WorkOS withdraws a client from all of them at once, so the app refuses that consent itself (v0.35.1). `oidc` (**done**, v0.13.0):
any OpenID Connect provider (Authentik, Keycloak, Zitadel, Google, Entra), so a self-hoster gets
single sign-on across the apps — which replaces the identity bridge once planned between Projects
and Tasks. `oidc.js` signs in with PKCE, a state and a nonce, checks the ID token against the
provider's keys (`jwt.js`, shared with WorkOS: RS256 or ES256, issuer, audience, dates, nonce), and
turns the person into an account with `accounts.fromIdentity()`: linked by a verified email, the
admin email taking over the first administrator, or created. AI clients keep the app's own OAuth,
whose consent screen sends whoever isn't signed in to the provider and back. The variables are
`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (empty for a public client), `OIDC_SCOPES`
and `OIDC_NAME` (the button: "Sign in with Authentik").

**Two-step verification** (**done**, v0.19.0, `two-factor.js`). With local accounts anyone can
add a code from an authenticator app to their password (TOTP, RFC 6238: SHA-1, 30 seconds, six
digits, a step of drift either side). Setting it up asks for the password again, gives the secret
and its `otpauth://` address (the QR code), and turns it on only once a first code proves the app
has it; ten recovery codes, shown then and kept as hashes, each work once. The secret is kept
encrypted (AES-256-GCM) with a key derived from the session secret, so a copy of the database alone
doesn't give it; a new SESSION_SECRET makes it unreadable, the recovery codes still work, and an
administrator can turn the second step off. Each code works once (the step it belongs to is kept).
Between the password and the code there is no session, only a challenge signed with the session
secret that lasts five minutes. It is asked at every door a password opens: `/api/auth/login`
answers `two_factor_required` with the challenge and `/api/auth/login/code` opens the session; the
OAuth consent screen asks for the code before giving permission; and a new password from a link
changes nothing without the code, since reading someone's mail is not enough. With WorkOS or OIDC
the second step is the provider's. Routes: `GET /api/me/two-factor`, `POST …/setup` (password),
`…/enable` (code → recovery codes), `…/disable` and `…/recovery-codes` (the password and a code:
a session and a password are not enough to undo it), and `DELETE /api/admin/users/:id/two-factor`.

## 8. Entitlements: plans and permissions

The app never asks whether someone pays. It asks what they may do, and the answer comes from one
place:

```js
entitlements.can(user, 'attachments', { organization })        // → boolean
entitlements.limit(user, 'lists.max', { organization })        // → number | null (no cap)
entitlements.require(user, 'lists.max', { current: 4 })        // throws 402 plan_limit
entitlements.of(user, { organization })                        // → { plan, features, ends }
entitlements.ofOrganization(organizationId)                    // → the same, the group's own plan
```

**Resolution.** Start from the default plan's values. Add every active grant of the user and of
the organization in context (`starts_at <= now < ends_at`, not revoked): a plan grant brings its
plan's values, a feature grant its single value. When sources disagree, the most generous wins:
`true` beats `false` for flags, and for limits `null` (no cap) beats any number and a larger number
beats a smaller one. The plan shown is the highest one granted, and `ends` is when it lapses: never
while one of its grants has no end, else the latest end among them (a person with Pro for good who
joins a family on a trial is not "Pro until" the trial's end). The instance admin gets every
feature. A plan that disappears from the catalog counts as the default plan: nobody is left with
nothing. Dropping to a smaller plan takes nothing away at once: past a cap they just cannot add
more, and what a plan keeps for a number of days counts those days from when the more generous
plan ended, not from when each thing was done:

```js
entitlements.cutoff(owner, 'retention.days')        // → ISO date (older goes) | null (nothing goes)
entitlements.cutoffOrganization(id, 'history.days') // → the same, by the group's own plan
entitlements.countDaily(user, 'mcp.calls_per_day')  // → { allowed, used, limit, plan, more }
entitlements.countWeekly(user, 'mcp.calls_per_week') // → the same, from Monday, and resets
```

**A group's own plan.** Some things act for a group with no person behind them: a child's paired
device in Focus, the hourly sweep of a family's History. `ofOrganization(id)` answers what `of()`
answers, from the organization's active grants alone: never a member's own grants nor the instance
admin's "no limits", which belong to a person, and never `of(null)`'s declared defaults (no limit at
all, where nobody asks). With no grant it is the default plan, and so is a group that isn't there or
is archived (createSuite tells it by `organizationExists`, from organizations.js), whatever grants it
kept: never more than a family of its own would have, and never an error, so a sweep over every
family goes on past one that went. `cutoffOrganization(id, key)` counts the days from the end of
the group's last grant that kept things longer (its trial, its subscription). `of(person, {
organizationId })` is unchanged.

`cutoff()` is null while the days since the end of the last grant that kept things longer have not
passed, and `now − days` after that. Each app sweeps its own data with it, by the plan of whoever
owns the list, project or notebook, in the function it hands to `createApp({ sweep })`: run a
minute after the start and then every six hours, with the clean-ups. `countDaily()` spends one use of the day (UTC) and counts
nothing it refuses; the transport uses it for `mcp.calls_per_day`, a limit that answers a sentence
the assistant can pass on (`dailyLimitText()`), never a switch. `countWeekly()` does the same for a
week from Monday 00:00 UTC (`weekStart()`), adding up the days: an app that declares
`mcp.calls_per_week` is counted by the week instead (`weeklyLimitText()`), and since its uses are
kept by the day under `mcp.calls_per_day`'s key, moving from one to the other keeps what was
already counted. `better(user, feature)` is the next plan with more of a limit, or null (0.203.0).

**The suite's catalog.** The hosted suite's plans are written once, in `plans.js`, and an install
names them: `PLANS=cronum-work`. Each app reads only the features it declares, and a feature it
declares that the catalog doesn't set stops the start, so a new barrier always comes with its
value. The features every app names the same are there too (`COMMON_FEATURES`: `retention.days`,
`storage.mb`, `assign`, `publish`, `templates`, `mcp`, `mcp.calls_per_day`, `mcp.calls_per_week`), for an app's
`features` to take from. Plan ids are English: `free`, `pro`, `team`. Without PLANS, one plan with
every default: a self-hosted copy has everything.

A product sold on its own has a catalog of its own, which its installs name, so none of its plans
gives anything in another product, nor the other way round (a key the named catalog lacks stops the
start, as above).

`PLANS=cronum-focus` is Cronum Focus's. Its plans, `free` and `pro`, are a family's: a family is an
organization (kind `family`), Pro is granted to it —bought by its owner or an admin, or the 14-day
trial a new family starts with, a grant with an end— and reaches its adults, who are its members.
Its keys are Focus's own, `routines.max` (5, no limit), `history.days` (7, no limit),
`devices.per_child` (1, no limit), `live`, `summary.days` (0, 14) and `runner.views`, and the common
`mcp` (on in both) and `mcp.calls_per_day` (100, 1000). In `cronum-work`, `history.days` is how long
a note keeps its earlier versions: a key means what the catalog an install names says, and an
install names one.

`PLANS=cronum-tracker` is Cronum Tracker's, with `free`, `org` (named Fleet) and `pro`, and the keys
`mcp` (off in all three), `capture.native`, `links.max`, `track.days` and `viewers.max`. An
organization's plan reaches every member, its admins and viewers too, so Fleet gives each person
what Free gives and sits before Pro: what a fleet pays for, per driver, sits on what the
organization owns, and the app checks it against the organization's grant and its seats.

**Barriers.** REST handlers call `require()`. MCP tools declare the feature they need and the
transport checks it, so the assistant reads a sentence it can pass on instead of a failure. The
browser reads `GET /api/me/entitlements` to hide or lock what is not included. The error is
`402 { error: 'plan_limit', feature, limit, plan }`.

**One subscription or several — without deciding now.** Inside an app, feature keys are short
(`attachments`). Across apps they are namespaced by the app id (`tasks.attachments`,
`next.projects.max`). A paid *product* is only a list of grants, possibly across apps, so "Tasks
Pro" and "the whole suite" are two products on the same mechanism, and either can come first. Each
app only reads the grants for its own features.

**Where grants come from.** From the admin panel (`source: 'admin'`) today; from a billing webhook
tomorrow (`stripe`); from a license key for self-hosters who pay for support (`license`); from a
central service for the hosted suite (`remote`). Enforcement always reads the local table, so an app
never depends on another service being up to answer `can()`.

## 9. Billing (skeleton, off by default)

`billing.js` (**done**, v0.10.0) turns payments into grants, and nothing runs until the app hands
in a provider (`BILLING_PROVIDER`). The suite never takes money itself: the provider hosts checkout
and the customer portal and reports through a signed webhook. A provider adapter is:

```js
{
  id: 'stripe',
  checkoutUrl({ subject, identity, customer, product, price, email, returnUrl }),  // hosted checkout page
  portalUrl({ customer, returnUrl }),                                    // manage or cancel
  parseWebhook({ headers, body }),       // verify the signature → normalized events
}
```

Whatever the provider calls them, events arrive normalized as
`{ id, type: 'subscription' | 'purchase' | 'refund', occurredAt, identity?, subject?, customer?, ref,
product?, status?, periodEnd?, quantity? }` and become grants with `source` = the provider and
`external_ref` = the subscription or order.

**Who pays**, best first: `identity` (`{ provider: 'workos', subject: 'user_01…' }`), who the person
is where they sign in, the same in every app; then the customer already linked here; last `subject`
("user:12"), the app's own id, which only means something in the install that made the checkout.
A group's purchase (its `subject` names an organization, or its product is `for: 'organization'`)
is the group's: the group its subscription is already known for here, while that group is (a
renewal; a copy of the install carries the subscriptions with the groups' new ids, where the id the
checkout named may be another group's); else the group it names (one no longer here takes it as
`'gone'`); else, when it names none, the group the customer is linked to while that group is here.
No identity is looked up for it, and a person's purchase never goes to a customer linked to a group
either. One provider
customer often pays a person's plan and their family's, or one family after another (Paddle finds
it by email), and is linked here to one of them only: before 0.85.0, whichever was linked first
took the others' purchases. A link to a group deleted here goes with it, and is taken by whoever
the customer pays for next.
One subscription is for the whole suite (Cronum Work) and every app has its own database and its
own webhook: each finds the person by their identity. Someone who hasn't opened that app yet has
no account there, so the event waits in `billing_pending` and is applied, in order, when that
identity is first linked to an account (`accounts.whenLinked` → `billing.claim`), that is, at their
first sign-in; a refund of what is waiting waits with it, and what nobody claims goes after 400
days. An identity outranks an older link of the customer to someone else. The copy of a whole
install carries customers, subscriptions and paid grants with the new ids (portability.js), so a
renewal that still says an old id can't reach whoever has it after the move (audit sc-data-48).

**The founder's price.** A product may have a `founderPrice` besides its `price`; the server
chooses it for whoever `isFounder` says —in `createSuite`, whoever joined before
`EARLY_ACCESS_UNTIL`: their WorkOS account's date, the same for every app, or else the account's
here—, never because the browser asks. Without that date nobody pays it, and with
`FOUNDER_OFFER_UNTIL` nobody does from that date on (`founderPriceOpen`, `joinedEarly`). `GET
/api/billing/products` says `founder: true|false` for the person asking, `founder_price` per
product, `founder_until` (the founder's price's last moment, once the early access is over, for a
founder who doesn't pay yet) and `on_sale`/`opens_at`, never the price ids. A product may also say
`amount`, `founderAmount` and `currency`, only for Settings to show them.

**The early access.** With `EARLY_ACCESS_PLAN` everyone without a grant has that plan until
`EARLY_ACCESS_UNTIL` (entitlements.js `earlyAccess`), and the install's default plan from then on,
with nothing to change by hand; meanwhile nothing is sold (the checkout answers 409 `not_on_sale`).
Between `EARLY_ACCESS_UNTIL` and `FOUNDER_OFFER_UNTIL` a host's `GET /api/modules` carries
`founder_offer: { until }` for a founder who doesn't pay yet, and every module's frame shows a
notice they can close (web/shell.js).

- A subscription that is `active` or `trialing` holds its plan until the end of the paid period
  plus `graceDays` (3), so a failed renewal lapses on its own; a renewal moves that end on the same
  grant. `past_due` changes nothing; `canceled` or `ended` ends it now. A change of product or of
  seats (`quantity`) replaces the grant.
- A group's purchase sells seats: the quantity the provider reports goes on the grant and caps its
  members. A product with `seats: false` (only `for: 'organization'`) sells the plan with no cap: a
  family buys one Pro however many adults it has. The quantity every event reports (Paddle's and
  Stripe's checkouts buy one of the price) is dropped for it, from whichever provider, on every event
  of the subscription and on a one-off purchase, so neither the subscription's row nor the grant has
  one. A group's subscription bought before the option has its grant replaced by one without a
  quantity at its next event; a one-off purchase made before it keeps its quantity, since no event
  follows it. A grant without a quantity sets no seats, like an admin's gift of the plan: a group
  that also holds one with a quantity (seats bought with another product) is still capped by it.
  Checked on start, with or without a provider (`productSeatsProblem()`): `seats` on a person's
  product (a misspelt `for`), a value that isn't a boolean, or a key like `seat`, stops it.
- A one-off purchase grants its plan for good, or for the product's `days` (a pass); a refund
  ends it. A subscription's refund ends its grant too, and the period it paid back doesn't bring
  it back (`refunded_until`); the next period paid for does. `paused` is not paid for either.
- Each event is applied once (`billing_events`), and a subscription event older than the state
  already known (`billing_subscriptions`) is ignored: providers retry and reorder.

Products live in the app's configuration, each tied to a plan of the catalog and checked on start:
`{ 'pro-monthly': { plan: 'pro', kind: 'subscription', price: 'price_…' }, 'pro-lifetime':
{ plan: 'pro', kind: 'once' }, 'family-yearly': { plan: 'family', kind: 'subscription', for:
'organization', seats: false } }`. `billing_customers` keeps each user's or organization's
customer at the provider. The routes are `GET /api/billing/products`, `POST /api/billing/checkout` and
`/api/billing/portal` (for a person, or for a group by one of its admins),
`GET /api/billing/subscriptions` and `POST /api/billing/webhook`. In the browser, Settings' plan
section sells them (`plan: { billing: true }`, `web/plan.js`, v0.77.0): Upgrade, Manage
subscription, a 402's call to action and the return from the checkout ([web-kit.md](web-kit.md)).

`signedProvider()` speaks these normalized events directly, signed with a shared secret
(`t=…,v1=…`, HMAC-SHA256, the scheme Stripe uses, five minutes of tolerance). It is what the tests
use and what a private service of the hosted suite (working name *Cronum Accounts*) would send: that
service would hold products, customers and subscriptions for every app, with WorkOS and the real
payment provider, and push each app its grants; the apps would not change.

**Stripe** (`stripe.js`, **done**, v0.18.0; the provider chosen on 2026-09-28, with Stripe Tax for
EU VAT). `BILLING_PROVIDER=stripe`, `STRIPE_SECRET_KEY` (sk_… or a restricted rk_…) and
`STRIPE_WEBHOOK_SECRET` (whsec_…, the endpoint's signing secret), checked on start; every product
needs its `price` (price_…). No SDK: Checkout Sessions and Customer Portal sessions are two
form-encoded calls. What goes to Stripe says who pays and for what —`metadata.subject`
("user:12", "organization:3") and `metadata.product` on the session, the subscription and the
payment—, so the webhooks say it back without the app keeping any state; a subscription changed
in the portal is recognised by its price. `customer.subscription.created/updated/deleted` become
subscription events (the period end read from the subscription or, in newer API versions, from its
item), `checkout.session.completed` and `.async_payment_succeeded` of a paid one-off payment
become purchases, and a full `charge.refunded` a refund; everything else is acknowledged and
ignored. The webhook to set in Stripe's dashboard is `BASE_URL/api/billing/webhook`.

> `paddle.js` is since 0.209.0 outside this repository: the hosted suite registers it (providers.js), with the price and product ids of the apps it sells (`catalog`).
> What follows is its design, kept here because billing.js's options were made with it.

**Paddle** (`paddle.js`, **done**, v0.38.0; the merchant of record chosen on 2026-10-02: it charges
each country's VAT, invoices and refunds). `BILLING_PROVIDER=paddle`, `PADDLE_API_KEY`
(pdl_sdbx_apikey_… or pdl_live_apikey_…), `PADDLE_WEBHOOK_SECRET` (pdl_ntfset_…, the secret of
the app's own notification destination), `PADDLE_ENV` (`sandbox` | `production`, matching the
key) and, optionally, `PADDLE_CHECKOUT_URL`, the page with Paddle.js that pays a transaction
(without it, the account's default payment link); all checked on start. A product's prices may be
given per environment, `price: { sandbox: 'pri_…', production: 'pri_…' }`, since each has its
own ids; the one of `PADDLE_ENV` is used. The checkout is a transaction made through the API, with
`custom_data: { workos_user_id, email, product, sig }` (`subject` instead without WorkOS) and the
person's customer, found or made by their verified email. `sig` (v0.128.0) is an HMAC of who pays,
the product, the price, the app and that customer, keyed by `PADDLE_CHECKOUT_SECRET` or, without
it, by a key derived from `PADDLE_WEBHOOK_SECRET`: Paddle.js opens a checkout for any price with any
custom_data from the browser, so an event whose `sig` is missing or doesn't match its price is
`unsigned`, and a subscription or purchase never heard of on one grants nothing (`'unsigned'`,
`billing.unsigned` in the audit); a known one keeps going (bought before, or its plan changed in the
portal), and a customer linked to another account moves only on a signature for that very customer
(else `billing.customer_conflict`); Paddle answers its payment link,
`PADDLE_CHECKOUT_URL?return=…&_ptxn=txn_…` (`&env=sandbox` in the sandbox). The portal is a
customer portal session. Paddle copies the transaction's `custom_data` to the subscription, so
`subscription.created/updated/canceled/paused/resumed/activated` say who; a
`transaction.completed` without a subscription is a purchase; an approved full refund or chargeback
(`adjustment.created/updated`) is a refund, of the subscription or of the transaction. The
signature is `Paddle-Signature: ts=…;h1=…`, HMAC-SHA256 of `ts:body`, five minutes of tolerance and
any h1 while a secret rotates. Each app has its own notification destination at
`BASE_URL/api/billing/webhook`, with the subscription, transaction and adjustment events.

**Another product's sales** (v0.66.0). One Paddle account may sell more than one product (Cronum
Work, and Tracker on its own), and every destination of the account gets every event, often for
people this app knows by the same WorkOS id. Before this version such an event linked the person's
customer here, waited 400 days in `billing_pending` for someone who never opens the app, and was
granted when a product of the other one had a key of this catalog's name (`custom_data.product`
was read for a price this install doesn't know). Four guards, set in `suite.config.js` and all off
by default:

```js
billing: {
  ignoreUnknownProducts: true,  // an event (not a refund) for a product not in `products` is 'foreign'
  app: 'work',                  // custom_data.app on the checkout; an event that names another app is foreign
  strictPrices: true,           // Paddle: the product only from the products' prices, never custom_data.product
  paddleProductIds: { sandbox: ['pro_…'], production: ['pro_…'] },   // Paddle: whose product each event is
},
```

A foreign event is decided before anything about who pays, so no customer is linked, nothing
waits and nothing is granted; only its id, type and outcome are kept in `billing_events`, and the
log names the event only. What waited from before the guard was on is foreign when its person
arrives (`claim`). Refunds are not checked: a refund names no product, and one of another
product's sale finds nothing here to take back. `app` is one value for every install that sells a
subscription together (Tasks, Next and Work all say `work`; Tracker says `tracker`), or each
would find the others' sales foreign; an event without one, sold before checkouts said it, is
judged by its product alone. So `app` alone never keeps out the renewals of what was sold before
it: it goes with `ignoreUnknownProducts` and `paddleProductIds`. Only Paddle's checkout writes it
(Paddle copies a transaction's `custom_data` to the subscription it makes), so with another
provider `app`, `strictPrices` and `paddleProductIds` are a warning on start.

`paddleProductIds` says whose product each event is. An event whose items are all of other Paddle
products is foreign, with nothing of who paid. One of this install's own products whose price no
product lists (with `strictPrices`) is a price missing from the config, never another product's
sale: its outcome is `'ignored'`, nothing is granted, and the log names the price to add. So,
before `strictPrices` goes on, every price that subscriptions still renew on goes in `price`,
`founderPrice` or `oldPrices` (a list, or one per environment). Without `paddleProductIds`, nothing
tells the two apart, and `strictPrices` with `ignoreUnknownProducts` calls such a renewal foreign:
an install sets the three together. Paddle's product ids differ between the sandbox and the live
account, so `paddleProductIds` is one list per environment; with Paddle on, a single list, or none
for `PADDLE_ENV`, stops the start.

> `revenuecat.js` is since 0.209.0 outside this repository: the hosted suite registers it (providers.js); `stores.js` and its interface stay.

**Several providers and the stores** (v0.78.0; Tracker's P6 and P7, RevenueCat chosen to start easy
and free, with a move to Apple's and Google's own APIs kept open). People buy for
themselves inside the app on a phone, in the App Store and Google Play, and groups buy on the web.
An install sets `STORE_BILLING=revenuecat` next to (or without) `BILLING_PROVIDER`, with
`modules.billing` on: `stores.js` makes a second instance of billing on the same tables, under its
own provider id (`revenuecat`), so each event is applied once and in order, `ignoreUnknownProducts`
applies, and the account's plan is every grant of both (`/api/me/entitlements`). Nothing changes
for an install without it: no new route, no new field, no migration.

```js
stores: {
  products: {                       // plans of the catalog, as the web's; keys of their own
    'pro-monthly': { plan: 'pro', kind: 'subscription', appStore: 'com.example.app.pro.monthly', playStore: 'app_pro:monthly' },
    'pro-yearly':  { plan: 'pro', kind: 'subscription', appStore: 'com.example.app.pro.yearly',  playStore: 'app_pro:yearly' },
  },
  devices: true,                    // the store routes also take the app's device tokens (modules.devices)
},
```

- **Who buys** is an opaque id the install gives each account, a random UUID kept in
  `billing_customers` (`GET /api/billing/stores/customer` → `{ provider, customer }`): the app hands
  it to the store's SDK as RevenueCat's App User ID. Never the WorkOS id, an email or the account's
  number, and another in every install. A UUID is also what StoreKit takes as `appAccountToken` and
  Google Play as `obfuscatedAccountId`, so a later adapter can keep the same buyers. RevenueCat's
  restore behaviour is set to "Keep with original App User ID": a purchase stays with the account
  that made it, and a restore under another account is refused.
- **The adapter** (`revenuecat.js`; the interface in `stores.js`): `parseWebhook()` checks the
  webhook and says whom to look at again, `customerEvents(customer)` reads what the customer has
  now and gives billing's events, and `manage(ref)` says which store holds it and where people
  manage it. The webhook (`POST /api/billing/revenuecat/webhook`) is checked by the Authorization
  header set in RevenueCat's dashboard (`REVENUECAT_WEBHOOK_AUTH`) and, with
  `REVENUECAT_WEBHOOK_SECRET`, by `X-RevenueCat-Webhook-Signature` (`t=…,v1=…`, HMAC-SHA256 of
  `t.body`, five minutes). It is only a trigger: the customer is read again with
  `GET /v1/subscribers/{id}` and the project's secret key (`REVENUECAT_API_KEY`, sk_…), so a late,
  repeated or forged delivery can only make the app look at what RevenueCat really holds. Only this
  install's customers are looked up, since that call creates a customer for an id RevenueCat doesn't
  know. The app calls `POST /api/billing/stores/sync` after a purchase or a restore, which reads its
  customer the same way (one at a time, at most every three seconds), so nothing waits for the webhook.
  Each reading is applied as one (billing.js's `apply(event, { reading: true })`): what it says that
  is already here is `'unchanged'` and leaves no row and no audit (only the time the state was last
  known moves on), so syncing again and again grows no table.
- **Replacing the adapter**: what an install holds is keyed by the adapter's id (`billing_customers`,
  `billing_subscriptions`, the grants' `source`) and by its refs. Apple's and Google's own server APIs
  can take RevenueCat's place behind the same interface only by keeping the id `revenuecat` and its
  refs, or with a migration of those three tables: under another id everyone would get a new
  customer, which no longer matches the `appAccountToken` of what they bought.
- **What a subscription becomes**: paid until a later date, or within the store's grace period after
  a failed charge, active (trialing in a free trial); past it, paused (Google Play), past_due while
  the store still retries a failed charge (nothing changes, the grant lapses on its own), or ended
  (after EXPIRATION, or not renewed). Refunded after its last purchase, or a CANCELLATION by customer
  support of that same transaction, is a refund: the period paid back gives nothing again, unless a
  REFUND_REVERSED says the store took the refund back. A CANCELLATION by customer support of another
  transaction (an older renewal) leaves the period paid now. A one-off purchase is RevenueCat's
  non-subscription: refunded when it leaves the list, or when customer support refunds its
  transaction while it is still listed. What the install holds that the customer no longer has (a
  TRANSFER to another App User ID, a refunded one-off) is taken back. The ref is the store,
  `-sandbox` for a test purchase, the store's product id and a digest of the customer: RevenueCat's
  v1 API names no original transaction, and the ref must be the same from the webhook and from the
  sync.
- **Notes**: what a later reading can't see at the store again is noted, as rows of `billing_events`
  of their own (`note:…`, refs and times only; a webhook's id takes only letters, digits, `-`, `_`
  and `.`, so no delivery writes one): a `refunded_at` the store took back or that was an
  older renewal's no longer takes the period back, and a one-off refunded while still listed stays
  refunded until a REFUND_REVERSED of its transaction. Unverified until the stores' sandbox tests
  (Tracker's A12), and handled either way: whether RevenueCat clears `refunded_at` when a refund is
  reversed, whether it removes a refunded one-off from `non_subscriptions`, and that `refunded_at`
  and `store_transaction_id` are the latest purchase's.
- **Another product's sales**: a webhook for another store (the web through Stripe or Paddle,
  promotional grants), for a product `stores.products` doesn't name, or from the sandbox with
  `REVENUECAT_SANDBOX=off` is foreign, and nobody is looked up for it; one for a customer this
  install never gave out is `ignored`. Test purchases (TestFlight, App Review, Google's testers)
  count by default, since App Review buys in the sandbox, and are marked as such in the ref and in
  the overview.
- **`GET /api/billing/overview`** (with the stores on): the person's plan and every source of it
  and how to manage each, never a ref, a customer or a price id: the web's subscriptions (the
  portal, for the person or a group they administer), the stores' (only in the store: no server can
  cancel an App Store subscription), a group's plan that covers them ("Covered by <group>") and the
  admin's gifts. What the app shows before an account is deleted, and what it reads before it sells
  in the store: no server can refuse a store's sale, so a person who already pays on the web is
  told there. The other way round, the web's checkout answers 409 `already_subscribed` to a person
  with a live store subscription (`createBilling({ otherProviders })`, set by `createSuite` with the
  stores on).
- **Deleting an account**: `createAccountDeletion` gets both instances (`combinedBilling()`), each
  asked even if the other fails; a store stops nothing, the person cancels there. With
  `billing.forgetOnRemove`, an account that goes takes with it, in each instance, its customer link,
  its subscriptions, its grants (revoked) and what waited under its identity. A renewal that still
  comes is then nobody's account here: one that names only the old customer (a store's) is
  ignored; one that names the person's identity (Paddle's, by the WorkOS id) waits in
  `billing_pending`, as for anyone without an account here, and goes to an account opened again
  with that login, who still pays for it. The identity provider, whose login other apps share, is
  never asked, and a group's subscription stays with the group. `/api/billing/webhook` is unchanged.
- **A group that goes** (section 10): with `billing.stopOnOrganizationDeleted`, its live
  subscriptions (`active`, `trialing`, `past_due`) stop renewing at the end of the period paid,
  asked of the provider once each (Paddle's cancel at `next_billing_period`, Stripe's
  `cancel_at_period_end`); an app can ask the same for a group that stays
  (`billing.stopOrganization(id, { by })`, its "delete the family" with a grace) and take it back
  (`billing.keepOrganization(id, { by })`). Each stop is a row of `billing_events` of its own
  (`stop:organization:<id>:<ref>`, type `stop`):

  | State | What it means |
  | --- | --- |
  | `pending` | to ask; marked inside the deletion's transaction, so a deletion undone leaves none |
  | `sending` | taken by a sweep that is asking now, so two sweeps never ask twice; one whose sweep never said how it went (the process ended) is taken again after 15 minutes |
  | `requested` | the provider took it |
  | `already` | the provider had it already (the payer cancelled in the portal): taking it back is theirs, never this install's |
  | `ended` | the subscription ended before it was asked |
  | `keeping` | being taken back |
  | `restop` | wanted stopped again while being taken back (the group deleted, here or in another process): asked again only once that taking back has landed, or after 15 minutes if its process ended |
  | `rekeep` | taken back, and the provider refused: the sweep asks again |
  | `keep` | taken back while another process was asking it: taken back once it lands, or dropped if it failed |

  One group's stops and their taking back go to the provider one at a time in this process, in the
  order they came: a keep waits for a stop on its way, and a stop for a keep; a keep that waited
  asks again in its turn whether anyone wants the group stopped, and does nothing if so. The hourly
  `sendStops()` (createApp and the host) asks again what failed. Who wants each group
  stopped is a row too (`stop-by:<who>:organization:<id>`, type `stop-by`: `app` by default,
  `members` for the deletion requests below): taking it back renews it only when nobody else still
  wants it stopped (`stopOriginsOf(id)`). A subscription heard of only after its group was deleted
  here (its first webhook came late) is stopped by the sweep too, for this catalog's product and an
  id this install gave out only (`createBilling({ organizationWasDeleted })`). On every deletion the
  group's customer link goes, and with `billing.forgetOnRemove` its subscription rows too. An event
  for a group no longer here is `'gone'`: nothing is linked, granted or kept beyond its id (before,
  it failed at the audit's reference to the group, a 500 the provider retried), and a subscription
  row still kept follows its status.
  With the same option, a group whose members are all waiting to be deleted (`organizations.leaving
  (id)`, of a kind deleted when empty) stops renewing as soon as that is so (`members`), not when
  the last account goes 30 days later, so no renewal falls in the wait; it is checked again on
  each request and taking back (account-deletion.js `whenRequested` / `whenCancelled`) and when
  someone joins or leaves (`whenMemberAdded` / `whenMemberRemoved`), renews again as soon as it
  no longer goes, and the final deletion finds the stop already asked and asks none more.

## 10. Organizations

An organization answers "whose is this and who pays": a group of people who share data, roles and
a subscription. The module is off by default. With `mode: 'optional'` people use the app on their
own and may create or join groups (a family in Tasks, a team in Projects); with `mode: 'required'`
every user belongs to one (the schools of Tracker). The suite provides the tables, the roles,
invitations by link or email, an organization switcher in the web kit and organization-level
grants: a plan bought for a household covers its members, and a grant's `quantity` caps the number
of members (seats). An app that charges for some of its members only names the roles that take a
seat (`organizations.seatRoles`: Tracker's drivers, while its admins and viewers are free): then
only those count, joining in one of them or being moved into one needs a free seat, and
`seatsTaken(id)` says how many are used. Fewer seats bought takes nobody's away; past them, no one
more joins in a seat. A membership has one role, so when the last owner's account goes, the group
passes to someone outside those roles first: a driver inherits it, and stops driving, only when
nobody else is left. A product with `seats: false` grants no quantity, so there are no seats to
take: a family's members have no cap, whatever their role (section 9), and `seatRoles` only says
which roles take a seat when there are seats. What acts for the group with nobody behind it reads
the group's own plan, `entitlements.ofOrganization(id)` (section 8). Which records belong to an
organization instead of a person is the app's decision, made in its own tables.

**Kinds an app manages** (`organizations.kinds`, each `{ managed, maxPerUser, onEmpty }`). A group's
`kind` is the app's free text; naming one in the configuration (up to 40 lowercase letters, digits,
`-` and `_`, starting with a letter: `KIND_NAME`, the rule a data copy's kinds follow too) gives it
rules, checked on start like the rest (an unknown key or a wrong value stops it). Not to be
confused with a data copy's `copyKinds` (portability.js, once K4 lands), which lists the kinds of
group a copy carries:

- `managed: true` (Focus's `family`): the generic routes refuse to create one (`POST /api/orgs` with
  that kind), to join one by an invitation (`POST /api/orgs/join`, before the invitation is spent)
  and to leave or remove its members (`DELETE /api/orgs/:id/members/:user`), answering 403
  `organization_managed` with the `kind`. The app does those through its own routes and its own
  rules, calling the same functions (`organizations.create`, `accept`, `addMember`, `removeMember`,
  `remove`), with its own permission checks and audit entries (`org.create`, `org.join`,
  `org.leave`, `org.member.remove`, as the generic routes write them). Reading, renaming, inviting
  and changing a role keep the generic routes and the suite's rules.
- `maxPerUser: n`: a person is in at most n non-archived groups of the kind; `create`, `addMember`
  and `accept` refuse one more with 409 `organization_limit` (`{ kind, max }`), whoever calls.
- `onEmpty: 'delete'` (the default of a managed kind; `'archive'` otherwise, as before): when the
  last member goes —they leave or are removed (`removeMember`; the last member, even an owner, can
  then leave), or their account is deleted (`forgetUser`)— the group is deleted instead of
  archived: `organizations.remove(id)` with the reason `empty`.
- `organizations.remove(id, { reason, by })` deletes a group whatever it holds: its plan grants
  (which name it by id), invitations, memberships and the row, in one transaction, with an
  `org.delete` audit entry (its other entries keep their target, without the reference).

The app hears, inside the change's transaction, of each member who goes
(`whenMemberRemoved({ organization, userId, role, reason, by })`, reason `left`, `removed`,
`account_deleted` or `handed_over`, `MEMBER_REASONS`; told before the membership's row goes, so it
can still read it), of each member who joins (`whenMemberAdded`) and of each group deleted
(`whenDeleted({ organization, reason, by })`, before its rows go), and deletes its own rows there; a
hook that throws undoes the whole change. Each membership that goes is told exactly once: by
`whenMemberRemoved`, except those a group still has when it is deleted whole (`remove`), which
`whenDeleted` tells. `createSuite({ hooks: { onMemberRemoved, onOrganizationDeleted } })` registers
them, and so does a module of a host; in a host the kinds are the host's, and a module that
declares one the host doesn't declare the same way stops the start. Billing's own deletion hook
runs after every app's, a host's modules' included, whenever they joined (`whenDeleted(hook,
{ last: true })`; section 9, "A group that goes"). Without kinds, every group behaves as before.

## 11. HTTP layer and dispatch order

`http.js` provides the router (`:params`, 405 with `Allow`), `HttpError(status, code, extra)`,
`readJson` (size limit, content type), `sendJson`, static files with ETag and revalidation, the
security headers and the CSRF check. `createApp` dispatches every request in this order, which the
apps learned the hard way:

1. Security headers on every response.
2. `/health`, `/version`, `/js/app-version.js` (the fingerprint the PWA compares to offer a reload).
3. Sign-in and discovery: `/auth/*`, `/.well-known/*`, `/oauth/*`. Discovery paths that the install
   does not serve answer a JSON 404, never the app's HTML, or MCP clients choke on it.
4. `/mcp`.
5. The suite's API: `/api/auth/*`, `/api/me/*` (with `/api/me/export` and `/api/me/import`),
   `/api/admin/*` (with `/api/admin/export` and `/api/admin/import`), `/api/orgs/*`, `/api/events`,
   `/api/push/*`, `/api/billing/*`, and with `modules.devices` `/api/devices/*` and `/api/me/devices`.
   Then, after the identity provider's and OAuth's own paths and for a GET only, the suite's pages
   for a phone when the app turned them on (device-pages.js): `/devices/connect`, `/devices/session`,
   and `/` back from the provider's sign-in to the connect page.
6. The app's API routes.
7. `/suite/*` (the web kit), `/admin` (the admin panel, when `modules.admin` is on) and
   `/i18n/<lang>.json` (suite and app catalogs merged).
8. The app's static files, then the SPA fallback for paths without an extension.

The common API is the same in every app: sign-in (`POST /api/auth/login`, its second step
`POST /api/auth/login/code`, `POST /api/auth/logout`, `GET /api/auth/config`), the profile
(`GET/PATCH /api/me`, `POST /api/me/password`, two-step verification, sessions, tokens, connected
apps, entitlements), administration (users, plans and grants, organizations,
audit) and the live channel. Errors are codes, never sentences (see CONVENTIONS.md).

## 12. Live updates

`live.js` (**done**, v0.21.0) keeps one SSE channel per browser tab (`GET /api/events`, served by
`createApp` when the app turns on `modules.live`; off by default, so an app that still serves its
own route there doesn't lose it on moving up): `retry:`, a heartbeat every 25 s,
`X-Accel-Buffering: no`, exempt from the socket timeout, and `hello` on opening. The app publishes
`suite.live.publish({ audience, data, event })`: `audience` is a list of user ids (null: everyone
connected; the app works out who can see what changed, as Tasks does with a list's shares),
`event` is `change` unless it says otherwise. Every event carries an id, `<run>.<n>`; the last 256
are remembered, so a tab that reconnects with `Last-Event-ID` (EventSource sends it by itself)
gets what it missed, and one that missed more, or comes from another run of the server, gets
`event: resync` and reloads what it shows. `hello` carries an id too, so a tab that saw no notice
still comes back with one, and a page opening a new channel after closing one sends it as
`?last=` (EventSource can't send the header then); when either came, `hello` says
`replayed: true` and the page reloads nothing more (v0.165.0: before, it reloaded everything on
every `hello` after a cut, on top of the replay). The suite publishes one event of its own (v0.22.0):
`account`, to the person's tabs when their account changes —an email confirmed from the mail,
often opened in another tab or on the phone, a new password, the second step turned on or off,
what the admin changed or signing them out everywhere— so the page reloads what it shows of the
account (`/api/auth/me`). `accounts.whenChanged(hook)` hears those changes, and a module that
changes an account says so with `accounts.changed(id)`. A channel lasts while the session it was
opened with does (v0.162.0): signing out, a session closed from the list, out everywhere, the
account disabled or deleted close it at once (`sessions.whenClosed` → `live.recheck`), with
`account` as its last word, and every heartbeat asks again (`sessions.stillOpen`, which doesn't
slide the session). Events may carry the new state (Focus's run contract) or
just say what changed (Tasks' lists): the app chooses.

## 13. MCP

`mcp.js` is the Streamable HTTP transport the three apps already share: JSON-RPC 2.0 on `/mcp`,
protocol versions 2025-06-18, 2025-03-26 and 2024-11-05, SSE answers when the client only accepts
them, a `401` with `WWW-Authenticate` pointing at the resource metadata, `503` when AuthKit cannot
be reached, and the token brake. The app hands in its tools, prompts and instructions:

```js
{ name, title, description, inputSchema, annotations?, feature?, handler(principal, args) }
```

`annotations` are the MCP hints, announced in `tools/list` with the tool's title
(`{ title, ...annotations }`); a tool without them is announced as before. The Claude connectors
directory and the ChatGPT App Directory require them, and clients use them to decide when to ask
the person first. Every app writes them the same way:

| The tool | `annotations` |
| --- | --- |
| Reads | `{ readOnlyHint: true, openWorldHint: false }` |
| Adds something | `{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }` |
| Sets a state or a field | the same, with `idempotentHint: true` |
| Deletes, overwrites for good, moves in bulk or gives other people access | `destructiveHint: true` |

`openWorldHint` is `true` only for a tool that reaches outside the app (fetching from the
internet, another service).

`mcp-kit.js` (v0.152.0) has them as `READS`, `ADDS`, `SETS` and `DESTRUCTIVE`, and
`tool({ name, title, description, kind, params, required, handler, … })` writes a tool from what
makes it differ: `kind` (`read`, `add`, `set`, `destroy`) gives the annotations, `params` and
`required` a closed `inputSchema`. With it come `text(s)`, the `S` schema helpers and
`describeErrorWith(i18n)`, the usual `describeError`: a `ResolveError` as its message and options,
an `HttpError` as `errors.<code>` in English. `tools/list` is paid for in every conversation, so
`trimRepeats(tools)` says each long parameter description in full in the first tool that has it
and as its first sentence after (names, parameters and limits unchanged), and `toolsListSize(tools)`
measures what a module's tools cost, for a budget test.

`feature` makes the transport check the plan before calling the tool. Only the names `tools/list`
announces answer: there are no aliases for old tool or parameter names (gone in 0.148.0), so a tool
is never renamed (CONVENTIONS §9). Tool descriptions and results are in English; the instructions ask the assistant to
answer in the user's language.

An app with `modules.mcp: false` (v0.65.0) answers `/mcp` and `/mcp/*` with a JSON 404 and no
`WWW-Authenticate`, never its page; with WorkOS it serves no metadata at `/.well-known/oauth-*`
(the discovery paths' JSON 404 answers); `/api/auth/config` says `app.modules.mcp: false`, and
Settings has no AI section. Two things are not covered by that switch:

- The built-in OAuth for local accounts is `modules.oauth`, apart: an app without an MCP sets it
  to `false` as well, or that OAuth still serves its metadata at `/.well-known/oauth-*` and its
  `/oauth/*` endpoints.
- The switch turns the MCP off, not leaving out the tools: with `modules.mcp` on and no tools,
  there is no `/mcp` and `app.modules.mcp` is `false`, but the WorkOS metadata is still served
  and `/mcp` falls back to the page, as before v0.65.0.

A host's modules offer the host's `/mcp` whenever it exists (some module brings tools, or two
bring things to link), and none of them does when it doesn't.

A tool that attaches a file takes it by link or hands back a one-time upload link
(`mcp-files.js`, v0.89.0; see §16, Files from an assistant): an MCP call carries no file.

**Names and dates as people say them** (v0.150.0). People tell an assistant "the shop" and "next
friday", not `#7` and `2026-10-30`. `resolve.js` turns a name into an item with one scoring for
every module: `matchByName(items, ref, { label, getName, strict, create, stopwords })`. A bare
number (`#12`, `12`, `id 12`) is an id and never part of a name; a name scores exact → same words
→ prefix → contains → word overlap, folded the same way in every alphabet (`nameKey`: "Café" is
"cafe", "Straße" is "strasse", "Магазин" and "🎂" stay). When it can't tell, it throws a
`ResolveError` with the options, and `mcp.js` tells the assistant the message and the options
(unless the app's `describeError` says it first) so it asks the person. The tools that write pass
`strict: true`: only a clear match counts and any tie is asked about, because writing on the wrong
item changes something nobody touched. `create` (Next's `log_progress`) answers `null` for a name
like nothing there, a new item. Each module adds its own nouns to the filler words with
`stopwords('list', 'lista', …)`.

`dates.js`'s `parseNaturalDate(value, { today, field })` understands YYYY-MM-DD (a real day,
1900–2200), today/tomorrow/yesterday, "in 3 days/2 weeks/1 month", weekdays long or short with or
without "next", and day-first dates (24/12, 24.12., 24-12-2026), in Spanish, English, French and
German at once. A day that doesn't exist (31/02, 2026-13-01) is a `ResolveError`, never the next
month. `today` is the person's day (YYYY-MM-DD); without it, the server's.

## 14. Translations

One implementation for server and browser (`t()` from Focus): flat dotted keys that describe place
and role (`settings.password.change`), CLDR plurals (`{ one, other }`), `{placeholders}` formatted
with `Intl`, a fallback to English key by key, and a pseudo-locale for testing layouts. The suite
ships its own catalogs (`i18n/<lang>.json`): the consent screen (**done** in v0.3.0) and, since
v0.12.0, the sentence of every error code and the name of every field its modules send
(`errors.username_taken`, `fields.email`), once for every app. Keys are prefixed by what uses
them (`oauth.allow`). The app keeps its own texts in `public/i18n/<lang>.json`, nested or dotted,
and may override any suite key; `createApp` serves both merged at `/i18n/<lang>.json`, in the
app's own shape (**done**, v0.12.0), and the service worker fetches them network-first. The
language is negotiated in the same order everywhere: the user's choice, then `Accept-Language` /
`navigator.languages`, then English. `tools/i18n.mjs` (**done**, from Focus) checks the merged
catalogs: the same keys in every language, the same placeholders, each language's plural forms,
nothing left as `TODO`, and no key used in the code that no catalog defines; the check of visible
strings written in the code comes with the web kit. Content people write is never translated.

## 15. Web kit

Browser modules served at `/suite/`, no build, the same CSP everywhere (`script-src 'self'`):

- `el(tag, props, children)`: every node through `textContent` and `setAttribute`; HTML is never
  assembled from strings. That is the whole XSS defence.
- `api.js`: fetch with JSON, error codes turned into sentences by `t()`, offline detected apart
  from server errors, `Idempotency-Key` on the writes that may be sent again. `setPatience(ms)`
  (v0.90.0, opt-in): a read or a keyed write slower than that counts as offline.
- `theme.js` (classic script, applied before the first paint), `i18n.js`, `live.js` (the SSE client
  with reconnection), `update.js` (the new-version notice), `outbox.js` (writes queued offline,
  replayed with their idempotency keys), toasts and dialogs.
- Screens: sign-in; settings (profile, language, theme, password, sessions, MCP tokens, connected
  apps, plan, notifications); the admin panel, drawn from the app's configuration (users, roles,
  organizations, plans and grants, audit); a source-code link, which the AGPL asks modified
  versions to offer.
- `tokens.css` with the design tokens of the Cronum style guide, so every app shares one look and
  each one keeps its accent.
- `sw-core.js`, imported by each app's service worker: shell caching, network-first for code and
  catalogs, never caching `/api`, `/mcp`, `/auth`, `/oauth`, `/version`. Its paths are read from
  the worker's scope, so the same file serves a module of a host at `/tasks/` (§21).
- `base.js` (v0.53.0): where the app is served from, read from the kit's own address: `/` on its
  own, `/tasks/` as a module of a host. The kit's requests go through its `at()`, and an app's
  own code can use it too: on its own every path stays what it was.

**Since v0.34.0 the kit is whole**, with the shared interface approved on 2026-10-05; how an app
uses it is in [web-kit.md](web-kit.md). The frame (`shell.js`) has a sidebar, which folds away on
a computer, and a drawer and two screens on a phone; sign-in (`signin.js`) puts the
product's colour large beside the form; Settings (`settings.js`) is a list of sections, one screen
each on a phone, with the app's own among them and About in every app; dialogs are sheets from the
bottom on a phone. `tokens.css` brings the brand and each product's accent by `<html data-app>`,
measured for contrast by the tests, and the fonts (Geist, Space Grotesk, Geist Mono) from
`/suite/fonts/`. `update.js` keeps the new-version notice until it is acted on and waits for the
new service worker; `live.js` groups changes, resyncs after a cut and reopens with a growing wait;
`outbox.js` keeps offline writes in IndexedDB (`local.js`) with their idempotency keys and
provisional ids, which the server honours for every app (`idempotency.js`); `markdown.js` draws
notes with `el()`; `sw-core.js` is the service worker; `icons.js` the icons; and
`tools/i18n.mjs hardcoded` finds texts written in the code.

**Before (v0.15.0).** `dom.js` (`el`, `$`, `$$`, `clear`), `i18n.js` (`t()` with placeholders and
plural forms, exact ones such as `=0` included; flat or nested catalogs; `pickLanguage()`, dates),
`api.js` (`ApiError`, `SessionExpired`, `Offline`, `errorMessage()`), `ui.js` (toasts, fields,
dialogs on the native `<dialog>`, confirmations), `theme.js` and `kit.css` (light and dark), and
`qr.js` (v0.20.0: QR codes with no library, byte mode and level M up to version 10, drawn as an
`<svg>` black on white; checked against the standard's values and a reference reader). On
them, the admin panel: `/admin` serves `web/admin.html`, which has no inline script or text. It
asks `/api/auth/config` which app this is, its languages and the modules it has on, shows itself
in the person's language with the app's name, and only to an administrator: accounts (create,
role, plan, extras granted per feature with an end date, a new password, signing out everywhere,
disabling, removal), invitations with the link to pass on, what each plan allows, organizations
when that module is on, and the activity log, filtered and paged. A feature is named by the app's
`features.<key>` text when it has one, else by its label in the configuration.
Next adopts the rest first (its own sign-in, settings, notice and service worker give way to the
kit's), then Notes is built on it whole, then the others as they move to English.

## 16. Push, uploads, mail and audit

- **Push** (**done**, v0.23.0, from Tasks, with `modules.push`): VAPID keys generated on the first
  start and kept in `app_meta` unless `VAPID_*` are set (a wrong or half pair is warned about and the
  install's own keys are used: notifications never stop an app); one subscription per device with
  its language, in Tasks' own `push_subscriptions` table so its subscriptions survive the move;
  endpoints checked before the server ever visits them (https, port 443, no IP literals, no names
  of a home network); gone ones (404, 410) and ones that fail three times pruned. The routes are
  `/api/push/config`, `/api/push/subscribe` (POST, DELETE), `/api/push/devices` and
  `/api/push/test`; the app composes the real messages and chooses who gets them
  (`suite.push.sendTo(userIds, payload | (subscription) => payload)`), as Tasks batches other
  people's changes to a shared list.
- **Push to an app's own devices** (v0.81.0, for Focus' paired tablets): a device that belongs to
  the app and has no account behind it (a child's profile, a kiosk) keeps its subscription in the
  app's own table, with the rest the app knows of it, never in `push_subscriptions`, whose rows are
  people's. The browser subscribes with the kit's `push.js` (`devicePushSubscription(publicKey)`,
  which asks nothing of the server: the app gives the device `suite.push.publicKey` its own way)
  and posts the JSON to the app's route; the route checks it with
  `suite.push.checkSubscription(json)` (the endpoint as a person's, the keys as a browser makes them;
  a coded 400 otherwise) and stores what it returns. The server sends with
  `suite.push.sendToSubscription(subscription, payload, { ttl, urgency, topic })`: the same keys,
  encryption, signature and time limit as a person's, the endpoint checked again, and
  `{ ok, status, gone }` back; on `gone`, and only then, the app drops it. No table and no migration: the
  subscription is a column of the app's device. Needs `modules.push`.
- **Native push** (v0.107.0, `native-push.js`, for Cronum Work's app on iPhone and Android): with
  `modules.push`, `modules.devices` and `push: { native: true, apnsTopic: '<bundle id>' }` in
  suite.config.js (off by default; with it off nothing here runs and nothing is read), the same
  sends the modules make for Web Push also reach the person's phones, straight to Apple and Google,
  with no push service in between and no dependency:
  - **Registration**, with the device's token (`Authorization: Bearer <devices.prefix>…`), never a
    session: `POST /api/devices/push` `{ platform: 'ios' | 'android', token, environment?:
    'sandbox' | 'production' (APNs only, `production` by default), lang? }` keeps one token per
    device (`device_push_tokens`, **suite migration 24**, hanging on `device_tokens` with
    `ON DELETE CASCADE`; the same token on another device moves here); `DELETE /api/devices/push`
    forgets it; `POST /api/devices/push/test` sends this device a test notice. A device revoked
    (by its owner, by itself, by the admin) loses its token at once; one gone idle or of a
    disabled account gets nothing, and its row goes with the device. Bad device
    tokens count in the devices' bucket. `GET /api/me/devices` adds `notifications: true | false`.
  - **Reminders the phone shows itself** (v0.125.0): the app schedules a person's coming reminders
    as local notifications (they ring offline, and the app closed), so the server must not push the
    same ones too. `PUT /api/devices/reminders` with the device's token (the same auth and bucket as
    the routes above) and `{ items: [{ module: '<module path>' | null, id: '<item id>', at:
    '<ISO-8601 instant>' }] }`, at most 64 (`module` like a host's mount, `id` 1 to 64 characters,
    `at` a real instant with its offset, such as `2026-10-23T09:00:00.000Z`), answers
    `{ ok: true, count }` (the same item twice counts once); each list replaces the device's
    previous one, and `{ items: [] }` clears it. 400 `field_required` / `field_invalid` /
    `field_too_long` name the field (`items`, `items[3].at`). Kept in `device_reminders` (**suite
    migration 26**, hanging on `device_tokens` with `ON DELETE CASCADE`), never exported; it goes
    when the device is revoked (by its owner, by itself signing out, by the admin) and on
    `DELETE /api/devices/push`. A send names its reminder in its options:
    `deliver(subs, payload, { reminder: { id, at } })` (and `send`, `sendTo`), `id` a text or a
    number, `at` an ISO-8601 text, a Date or milliseconds; in a host, `hostedPush` (and a host
    without the one worker too) sets `reminder.module` to the module's path, and an app on its own
    may give `module` itself (else null). A native target whose device reported the same `module`
    and `id` at the same instant (give or take 60 s) is skipped, and `deliver` answers
    `{ sent, gone, failed, skipped }`; `send` to that one device answers `{ ok: false, skipped:
    true, outcome: 'scheduled' }`. Web Push is never skipped. Without the option, or with one that
    can't be read, everything is sent as before and the answer has no `skipped`.
  - **Sending**: `subscriptionsOf(userIds)` also gives the people's phones (rows with
    `native: true`, `platform`, `lang`, `user_id`), and `deliver()` sends each where it goes; given
    Web Push rows only (an app that reads `push_subscriptions` itself, as Tasks does), it also sends
    to those people's phones. Each phone once per delivery. `sendTo`, `send` and the host's
    `hostedPush` (the module's path in `url`, its `module` and tag) go the same way, and
    `/api/push/test` reaches the phones too. What a Web Push payload becomes: `title` and `body`
    the alert's texts (the body, then the title, shortened to fit 4 KB, never refused); `badge`
    when it is a whole number (on the web it is an image, and ignored); `category` (the actions the
    app defines, such as `task-reminder`); every other plain value (`url`, `module`, `id`, `tag`,
    `task_id`…) as data, and the same data as JSON under `body`, where expo-notifications reads
    `content.data`. The send's `topic`, else the payload's `tag`, collapses notices
    (`apns-collapse-id`, FCM `collapse_key`); `ttl` and `urgency` map to `apns-expiration`,
    `apns-priority` (10, or 5 for `low`) and FCM's `ttl` and priority (`HIGH`, or `NORMAL`).
  - **APNs** over one HTTP/2 connection per host, kept (api.push.apple.com, or
    api.sandbox.push.apple.com for a development build's token), token auth: an ES256 JWT of
    `APNS_KEY_ID` and `APNS_TEAM_ID` signed with `APNS_PRIVATE_KEY` (the .p8 text; `
` for line
    breaks in one line of .env), made again every 50 minutes; topic `APNS_TOPIC` or
    `push.apnsTopic`. Payload `aps: { alert: { title, body }, sound: 'default', badge?, category?,
    thread-id }` (the module, else the tag) plus the data; headers `apns-push-type: alert`,
    `apns-topic`, `apns-priority`, `apns-expiration`, `apns-collapse-id`.
  - **FCM HTTP v1** with `FCM_SERVICE_ACCOUNT` (the service account's JSON, or it in base64): an
    RS256 JWT exchanged at oauth2.googleapis.com for an access token, kept until five minutes before
    it ends; `notification: { title, body }`, `android: { priority, ttl, collapse_key,
    notification: { channel_id (push.androidChannel, 'default'), tag, notification_count } }`,
    `data` (strings only).
  - **Answers**: APNs 410, `BadDeviceToken`, `Unregistered` and FCM `UNREGISTERED`, 404, or
    `INVALID_ARGUMENT` on the token drop it; another refusal of the device (`DeviceTokenNotForTopic`,
    `SENDER_ID_MISMATCH`…) three times in a row too; our credentials or our message (403
    provider token, `INVALID_ARGUMENT` elsewhere, 401) and outages (429, 5xx, the network) count
    against nobody and are logged; a refused provider token or access token is made again. No
    send ever throws for a device.
  - **Credentials**: never stop the start, as with VAPID (a typo in an install's panel must not
    take the whole app down). A platform with none, or only some, of its variables, or with a value
    that can't be used (not a P-256 .p8, a key id or team id that isn't 10 letters and digits, a
    bundle id that isn't one, a service account that isn't JSON or has no project_id, client_email
    or RSA private_key), is off: a warning at the start names the variable and what is wrong, never
    its value, and its phones' tokens are kept for when it works. Only suite.config.js's own
    `push.native`, `push.apnsTopic` and `push.androidChannel` written wrong stop the start.
- **Uploads** (**done**, v0.24.0, from Tasks, `suite.uploads` with `modules.uploads`): the file
  travels as the raw request body and is streamed to `DATA_DIR/uploads/<folder>/<random>-<name>`
  (written as `.partial` and renamed at the end); the type is decided by its first bytes (images
  and PDF; never SVG) before anything touches the disk; files are never served as static files:
  `serve()` answers after the app checked who may see it, with the type we say, `nosniff`,
  `private, no-cache` and a read error that cuts the download instead of the process. The orphan
  sweep takes loose files over a day old and refuses when the database knows none or more than half
  the folder would go. The app keeps its own table linking files to its records, its limits and its
  trash (Tasks' `task_files`). Storage per user or organization can be a plan limit.
  - **The storage a plan allows** (v0.179.0, `storage.js`, `suite.storage`): `check(user, adding,
    { payer })` answers 402 `plan_limit` with `{ feature: 'storage.mb', limit: '<n> MB', current:
    '<n> MB', plan, plan_name }` when `adding` bytes more would take the payer past `storage.mb`, and
    nothing within it or without a limit; `of(user)` → `{ used, limit }`. What is counted: on its
    own, the app's files, as the app says where it counts them, at import
    (`suite.countStorage(storageOf)` → `suite.storage`, so its scripts and command line, which run
    without createApp, have it too; createApp's `storage`, the same `createModule().storage`, says it
    otherwise); as a module of a host, the person's across every module (below), and
    `countStorage` changes nothing there. Until an app says it, there is no `suite.storage`.
  - **Who pays for a file** is, for now, each app's rule as it was, passed as `payer`: in Notes the
    notebook's owner, whoever sent it (a file in someone's notebook takes their room); in Tasks and
    Projects whoever uploads it (`payer` left out: the user). Unifying on "the owner of what holds
    it" waits until production says who would go over their limit with it.
  - **`uploads.storeChecked(req, { folder, name, user, payer, count, max })`** is `store()` with
    those limits around it, as the three apps did by hand: `count()` against `max`
    (`too_many_files`, 400, with `max`) and the payer's storage with one byte, before a byte is read
    (the body swallowed so the answer can be sent); then both again with the file on disk and its
    real size, because uploads sent together all passed the first count; a refusal then takes the
    file off the disk. The app records what it returns.
  - The most a file may weigh (`maxBytes`, 15 MB by default) is told to the page in
    `/api/auth/config` as `app.uploads.max_bytes`, for the kit's `web/images.js` to warn before
    spending data.
- **Files from an assistant** (v0.89.0, `mcp-files.js`): an MCP tool carries JSON, not files, so a
  file reaches the app's own save function (with its checks, unchanged) as a stream, one of two
  ways. With a link, `suite.uploads.fromUrl(url)` downloads it → `{ stream, name }`: http or https
  only, never from an address inside a network (every address of the name and of each of at most 3
  redirects checked with `isPublicAddress`, and the connection made to the address checked, so a
  second lookup can't send it elsewhere), a Content-Length over the limit refused before reading,
  10 s to answer and 60 s in all; codes `file_url`, `file_url_private`, `file_url_unreachable`,
  `file_url_status` (with `status`) and `file_too_large`, and `store` decides by the first bytes as
  for any upload. Without a link, `suite.uploadLinks.offer({ userId, name, accept })` →
  `{ url, expires_at }`, a one-time address for an assistant that can run a command (Claude Code:
  `curl -X POST --data-binary @file "<url>?name=…"`): `POST /api/mcp-uploads/:token` hands the body
  to `accept(stream, { name, user })` and answers 201 with what it returns. The token is the only
  credential (kept as a hash, good once, for 15 minutes, for an account still active; no session
  cookie opens or replaces it); a missing, expired or used one is 404 `upload_link_not_found`. In
  memory, at most 100 open per app, with `modules.uploads` and `modules.mcp` on; a module of a host
  has its own, at `/<mount>/api/mcp-uploads/…`. `receiveFile({ suite, userId, url, name, accept })`
  is the whole of a tool: `{ saved }` with a link, `{ link, instructions }` without one,
  `instructions` being the sentence for the assistant (`uploadLinkText`); `FILE_PARAMS` are its
  parameters, `file_url` and `file_name`, the same in every app.
- **Mail** (**done**, v0.14.0): `mail.js` sends through SMTP (`MAIL_PROVIDER=smtp`, `MAIL_HOST`,
  `MAIL_PORT`, `MAIL_SECURE` tls | starttls | none, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM`) with a
  client of its own —no dependencies, STARTTLS required unless told otherwise, AUTH PLAIN or LOGIN,
  headers that can't be broken into— or, by default, writes the message in the server's log, so an
  install without a mail server can still pass a link on. `account-mail.js` carries what local
  accounts need: a link to confirm an email (48 h), a new password when the old one is forgotten
  (1 h, once, every other session closed; the answer is the same whether the account exists), the
  admin's invitations (7 days; the link is also returned, to pass on by hand) and open sign-up.
  Every link is a single-use token kept as a hash; the brake limits requests per address and links
  per inbox. The texts are the suite's, in each person's language. Since v0.212.0 each one also goes
  as HTML in the product's clothes (`mail-layout.js`, `app.mail`), its link as a button, and the
  modules tell someone something was offered to them with one email for all (`share-mail.js`,
  `suite.shareMail`), signed by the host in a host. With WorkOS or OIDC the provider
  sends its own. Without a mail server nothing pretends otherwise (v0.16.0): `/api/auth/config`
  says `mail: false`, so screens don't promise a link that won't arrive; an invitation comes back
  `sent: false` with its link; and the admin can confirm an email by hand (`email_verified` on
  `PATCH /api/admin/users/:id`), which is the only way to confirm one there. With a mail server
  (v0.17.0), the app checks it once at the start —it answers, encrypts, takes the account— and
  says so in the log (`[mail] SMTP ready` or why not); a message that fails later is logged with
  its reason and answered `mail_failed` (502), except a forgotten password, whose answer never
  changes.
- **Alerts** (**done**, v0.123.0, `alerts.js`): with `ALERT_EMAIL` and a mail server, whoever
  runs the install hears of the server failing instead of finding it in the log: an uncaught
  exception (the process waits 4 s at most for the email, then exits with 1 as before), an
  unhandled rejection, 5 or more 5xx within 5 minutes (counted by the server that listens, an app's
  or a host's, each request named by its method and its route's pattern, `/tasks/api/lists/:id`),
  and a scheduled job of the suite that threw. One email per kind every 30 minutes at most: the
  time of the last is kept in `app_meta` before it goes, so a restart loop sends one, and the next
  says how many were held back. It carries the app, its version, address, machine, kind, time and
  the error with a trimmed stack, without emails, long tokens or the queries of URLs; never a
  request's query, body, headers or cookies. In English, like the log: it is for whoever runs the
  server. Not `ADMIN_EMAIL` on its own, so an install that moves up gets no mail it never asked
  for; with `MAIL_PROVIDER=log`, or an address that isn't one, a warning and nothing else.
- **Audit**: sign-ins and failures, sessions and tokens created or revoked, admin actions, plan
  changes, billing events, copies exported and imported. Who, when, what and from where; never
  titles, notes or passwords.
- **Copies of the data** (**done**, v0.25.0, `portability.js` on `zip.js`, when the app hands
  `createApp` its `portable` declaration): someone's own copy (`GET /api/me/export`, the GDPR's
  portability) and the whole install's for the admin (`GET /api/admin/export`), as a zip anyone can
  open —`manifest.json` (format, id, app, version, the schema's migration numbers, scope, date,
  counts, what was left out), `data/<table>.json` with the rows as they are, `suite/grants.json`
  with the plans the admin gave, `files/<path>` with the attachments byte for byte—. The app
  declares its tables in creation order, which column points at which table or at `users`, and
  which column is a file; the suite does the rest. A row belongs to a copy when every NOT NULL
  reference points at something in it; optional ones pointing outside are emptied, so a person's
  copy takes their lists with everything in them and leaves what they share with other people,
  counted. Importing is two steps: the upload (`POST /api/me/import`, `/api/admin/import`) waits a
  day in `DATA_DIR/imports` for its owner and answers what it would do; applying it (`POST
  …/import/:id`) reads and checks the attachments into a staging folder, then one transaction
  creates the accounts (without the app's welcome content), empties the accounts to "replace",
  writes every row with a new id and every reference translated —references to a later table or
  the same one are set at the end, so they must allow NULL—, the profiles and the record in
  `data_imports`; only after the commit are the files moved into place. A person's copy goes into
  the account that imports it; a whole install's goes account by account where the admin says:
  the account here with the same email by default, a new one (which WorkOS or OIDC link on that
  person's first sign-in by that email), or none. An existing account takes the copy's
  preferences and keeps who it is (username, email, role). Never travel: passwords, second steps,
  sessions, API tokens, OAuth grants, push subscriptions, the audit log, identities at providers.
  The file is untrusted input: columns this install doesn't have, values that aren't plain, a
  duplicate id, an unknown table, a newer schema or another app's copy are refused; references
  outside the file go nowhere; attachments must be images or PDF by their first bytes; sizes have
  ceilings (entries inflated no further than they declare); in someone's own import no other
  account or role is touched and the plan's limits hold. `tools/data-cli.js` does the same from
  the command line, which is how a whole install moves without a browser or a proxy's upload limit.
  Someone can also **erase their own data** and keep the account (`POST /api/me/erase`, v0.61.0):
  first the app hands over what others share with them (the declaration's `handOver(userId)`: a
  shared list passes to one of the people it is shared with), then goes, in one transaction,
  exactly what their own copy would take and "replace" empties, and its files once committed.
- **Organizations in the copies** (**done**, v0.84.0, for Focus' families and Tracker's fleets; on
  only when the declaration says `organizations` or a table points at `organizations`, which needs
  `modules.organizations`). A table can belong to a group: a NOT NULL reference to `organizations`
  decides it as one to `users` does, and the tables that chain to it are the group's too. Someone's
  copy takes the groups they are in (the declaration's `copyKinds`, archived ones too; every member by
  default, since a member reads what the group shares, or the `copyRoles` the app names, checked
  against the install's roles). These are the declaration's own names, apart from suite.config.js's
  `organizations.kinds` (each kind's rules) and `organizations.roles` (the install's roles): the
  copy* ones say only what a person's copy takes, and a kind is written by one rule, `KIND_NAME` in
  organizations.js. It goes as `data/organizations.json` and their own row of
  `data/memberships.json`, with every row of the group; it brings no plan and doesn't say which
  install it is. The whole
  install's takes every group, membership, waiting invitation (`suite/invitations.json`, by hash:
  the links people were sent keep working), and the groups' grants and payments, typed
  `organization` in `suite/grants.json` and `suite/billing.json`, and says which install it is
  (`source.install`, a random id in `app_meta`) and which export run (`source.export`, shared by a
  host's modules exported together). Importing someone's copy puts each group into the
  oldest of that kind they own or administer (`mapOntoOwn`) or a new one they own, made quietly
  with a slug from its name and today's date; a table with `onePerOrganization` (Focus' family row,
  UNIQUE per group) then finds the group's row instead of writing a second one. A whole install's
  restores each group as it was, under its id here (a renewal naming the old id finds the group by
  its customer), and records where it came from (the source install, its id there and the run, in
  `app_meta`). An install comes in by one export run: its other modules' copies of that run find
  the groups by that record alone and bring only their own rows; a copy of another run is refused
  before anything is written (409 `import_install_again`, checked again inside the import's
  transaction), since merging a later copy into what an earlier one made would bring back who left
  and plans revoked since; what a copy of the run is the first to bring comes whole. Moving again is moving into a
  fresh install. Nothing a file says by itself (a slug, a date, a name) finds a group here: a
  person's copy names no install, and what a copy can't name, it can't join. A kind is written by
  one rule (`KIND_NAME`): `organizations.create` refuses another, and a copy's other kind comes in
  as none. What is someone's alone —what "replace" and erasing
  empty— is their rows and those of groups nobody else is in; a group they share is never emptied:
  "replace" hands it over (`organizations.handOver()`, in one transaction: the heir
  `organizations.heirOf()` names, the one rule of account deletion too, becomes owner when they were
  its last, and the app hears it once, as any member who goes, through `whenMemberRemoved` with reason
  `handed_over`; 0.84.0's declaration `leave` is gone, and a declaration that still says it stops
  the start naming the hook), and someone's own "replace" goes only with the ids of the groups Settings
  showed (`hand_over: [ids]`; 409 `import_hand_over` when they aren't those any more), the
  administrator's plan and panel naming them too (`targets[].hand_over`); erasing leaves it whole
  with them in it. Nothing of a copy deletes a group: one someone owns alone keeps its organization
  and plan when its rows are emptied, and a group that has to go goes through
  `organizations.remove()`, which tells the app and billing. A membership a copy brings meets the
  install's cap per person (`organizations.kinds` `maxPerUser`): past it, the import is refused with
  409 `organization_limit`, and nothing of it comes in. A
  table's `omit` lists columns that never travel (a device's key hash, its push subscription): left
  out of every copy, the column's default (or the app's) on import. A whole install's copy also
  keeps `delete_after`, so an account waiting to be deleted still goes on that day after the move
  (only a disabled one: a date alone never sends an active account to the sweep).
- **Deleting one's own account** (**done**, v0.61.0, `account-deletion.js`; the GDPR's right to
  erasure). `POST /api/me/deletion` (`confirm: true`, and with a password here the password and
  the second step's code, as erasing one's data asks) disables the account at once —sessions and
  devices end, and tokens and connected assistants are refused, as for any disabled account— and
  keeps it `accounts.deletionDays` (30) with `users.delete_after` (migration 21). Signing in to it
  before then, with the password (`/api/auth/login` answers `deletion_pending` with a ticket
  signed with the session secret, 15 minutes, after the code when it has a second step) or at the
  provider (`/?account_deletion=<ticket>&until=<date>`), offers it back: `POST /api/auth/restore`
  enables it as it was and signs in. An account the admin disabled is never offered back, and the
  admin enabling one that waits takes the deletion back. The clean-ups (hourly, once for a host)
  delete the accounts whose days are over with `accounts.remove()`, so every hook runs (each app
  hands over what others share and deletes its files), and the audit keeps only `account.delete`
  of account #n. Where this install is all a person has at the providers
  (`accounts.deleteAtProviders`: Cronum Work), the subscriptions they pay for stop renewing when
  they ask (Paddle: cancelled at the period's end), renew again if they come back, and end when the
  account goes, and the WorkOS user is deleted first (an account whose identity can't be deleted
  waits for the next sweep); never where other apps share those accounts or that subscription.
  `accounts.endSubscriptions` (v0.128.0) does the subscriptions' part alone, the WorkOS user kept:
  an install that bills alone while other apps sign in with the same users; left out, as
  `deleteAtProviders`.
  `accounts.sharedIdentity` (v0.211.0) is for WorkOS users shared by several apps, each of which
  notes itself on them (`app_<id>`: its name, in the user's metadata) when someone signs in, and
  once at start for whoever came before. Deleting one's account asks whether the login goes too
  only of someone another app has noted (`GET /api/me/deletion` names those apps; the request's
  `identity`, true or false, is kept as `users.delete_identity`, all or none); nobody else is
  asked (`auto`), and their login goes with the account unless, by then, another app has noted
  them. The admin's deletion keeps the login unless asked (`?identity=1`; `GET
  /api/admin/users/:id/other-apps` says who else they use). A login that stays no longer names
  this app. One or the other with `deleteAtProviders`, which always deletes it.
  `deletion.whenRequested(hook)` and `whenCancelled(hook)` (createSuite's `onDeletionRequested`,
  `onDeletionCancelled`) tell others of the request and of its taking back, awaited after it; a
  hook that fails is logged; a host's modules get them too. With `billing.stopOnOrganizationDeleted`,
  a group whose members are all waiting to be deleted stops renewing there (section 9, "A group
  that goes"). The person's own subscriptions stopped at the request (`accounts.deleteAtProviders`)
  are noted one by one, so taking the account back renews only what this install stopped, never a
  cancellation they had made themselves. A
  message says until when, when mail leaves the server. The last administrator can't ask.

## 17. Security baseline

Every app gets these from the suite and the conformance tests check them:

- CSP without inline scripts or `eval`, `frame-ancestors 'none'`, `nosniff`, a strict referrer
  policy, a permissions policy that switches off what is not used, HSTS over HTTPS.
- Passwords with scrypt in a self-describing format; session tokens stored as HMAC, API and OAuth
  tokens as hashes; nothing secret in URLs except where a client cannot send headers.
- No secret or password known in advance: generated when missing, example values ignored.
- CSRF by origin; brute-force brake persisted; `TRUST_PROXY` explicit.
- The container starts as root only to fix `/data`, then drops privileges; the code mounted
  read-only in development setups.
- Logs record who changed what, never what they wrote.

## 18. Testing

- suite-core tests itself with `node:test` (built in): every module against an in-memory database,
  with fake adapters where it talks to an app.
- `tools/conformance.js` (**done**, v0.29.0) runs against a running app and checks the platform
  behaviour it inherits: headers, `/health` and `/version`, sign-in and sign-out, the brute-force
  brake, CSRF, the MCP `401` challenge (for an app without an MCP, `--no-mcp`: `/mcp` and the
  OAuth metadata a JSON 404 with no challenge, v0.65.0), JSON 404 on discovery paths, translations
  complete. Only HTTP to the app itself, so it runs the same on a laptop, a NAS, in a container or
  against production (read-only there: no credentials, `--no-brake`). Each app's smoke test calls
  it, then tests its own domain, and the shared container checks run it against every image built.

## 19. Versions and adoption

suite-core follows semantic versioning with git tags (`v0.x.y` while the API settles; a minor
version may break, a patch never does) and a `CHANGELOG.md`. Apps pin a tag through the submodule
pointer; updating is `git -C server/suite checkout vX.Y.Z`, committing the pointer and running the
app's tests. A change is always made in suite-core (from any app's `server/suite`, which is a
checkout of it), tested, tagged, and then picked up by each app. Every new module lands in Next
first, then Tasks, then the rest.

## 20. Module status and order

| Module | Status | Next step |
| --- | --- | --- |
| `oauth.js` | done (v0.1.0) | used by Next; Tasks next |
| `workos.js`, `workos-accounts.js` | done (v0.2.0) | used by Next; Tasks next |
| Architecture and conventions | done (this document) | keep it in step with the code |
| `http.js`, `db.js`, `migrate.js`, `crypto.js` | done (v0.4.0) | adopted by Next; Tasks and the rest next |
| `sessions.js`, `rate-limit.js` | done (v0.5.0) | adopted by Next; `principal.js` comes with the MCP transport |
| `mcp.js` | done (v0.6.0) | adopted by Next; plan checks wired to entitlements when they exist |
| `i18n.js` + `tools/i18n.mjs` | done (v0.12.0: the suite's errors and fields once, merged catalogs, parity; v0.15.0: `t()` in the browser; v0.34.0: texts written in the code; v0.49.0: Tasks' stricter scan for everyone, and the server; v0.51.0: one translator for every app, `appTexts` on the server and the kit's in the browser, and `appChecks`) | adopted by Tasks, Projects, Next and Notes; each app's tests run `appChecks` |
| `accounts.js`, `organizations.js`, `audit.js`, `api.js` | done (v0.8.0) | adopted by Next (organizations off) |
| Identities, `tokens.js`, profile routes | done (v0.9.0) | adopted by Next |
| `devices.js` | done (v0.67.0: phones through the system browser, with PKCE; v0.105.0: the connect page and sessions of the web, `device-pages.js`; v0.108.0: actions from a notification, `deviceActions`) | Tracker's native app (its steps A2 and A3); Cronum Work's app (its steps S1 and S2); Focus keeps its own pairing |
| `oidc.js`, `jwt.js` | done (v0.13.0) | available to every app with AUTH_PROVIDER=oidc |
| `mail.js`, `account-mail.js` | done (v0.14.0) | adopted by Next, with its screens (sign-up by invitation or open, confirmation, new passwords); an SMTP server per install |
| `two-factor.js` | done (v0.19.0) | Next's screens (the code at sign-in, Settings); Tasks and Projects when they take the suite's routes |
| `entitlements.js` | done (v0.7.0) | adopted by Next (no limits by default); Tasks with `importUserPlans()` |
| `app.js`, `config.js`, `watcher.js` | done (v0.11.0) | Next boots on them; Tasks next, after its PR #2 |
| `live.js` | done (v0.21.0) | Next on it; Tasks and Projects when their PRs on createApp are in (their events.js are the same) |
| `push.js` | done (v0.23.0) | Tasks moves onto it (its subscriptions and keys stay); Projects and Next when they have something to notify |
| `uploads.js` | done (v0.24.0) | Tasks moves onto it (its files stay where they are) |
| `storage.js`, `uploads.storeChecked`, `web/images.js` | done (v0.179.0: storage.mb checked once, with the payer explicit; a photo made ready in the kit) | Tasks, Projects and Notes drop their copies |
| `mcp-files.js`, `uploads.fromUrl` | done (v0.89.0: files from an assistant, by link or one-time upload link) | Notes and Tasks attach through their MCP tools |
| `zip.js`, `portability.js`, `tools/data-cli.js` | done (v0.25.0; v0.84.0: organizations and `omit`) | Tasks declares its data; Projects and Next next. It is how the apps move from the NAS to the cloud. Focus and Tracker carry their families and fleets |
| Web kit and admin panel | done (v0.15.0: the base and `/admin`; v0.34.0: the shared interface, sign-in, settings, frame, live, outbox, updates, Markdown, service worker, brand tokens and fonts) | Next adopts it first; Notes is built on it; the rest as they move to English |
| `idempotency.js` | done (v0.34.0) | used by every app through `createApp`; the kit's outbox sends the keys |
| `host.js`, `web/base.js` | done (v0.53.0: several apps as one, each a module at its own path; the kit and its service worker at a module's base) | Next first as a module, then Notes, Projects and Tasks; one `/mcp` for all next |
| `billing.js`, `stripe.js`, `providers.js` | done (v0.10.0: interface, signed provider, grants; v0.18.0: Stripe; v0.38.0: Paddle, by WorkOS id across apps; v0.66.0: another product's sales kept out, behind `billing` options; v0.208.0: providers by registration; v0.209.0: Paddle outside the repository) | Tasks and Next sell Cronum Work Pro through Paddle; Team in a second phase |
| `stores.js` | done (v0.78.0: the stores next to the web, RevenueCat as the adapter, the overview, `forgetOnRemove`; v0.209.0: RevenueCat outside the repository) | Tracker sells Pro in the App Store and Google Play (its step A12) |

## 21. Several apps as one: the host

**Done in v0.53.0** (`host.js`), for Cronum Work: Tasks, Projects, Next and Notes as modules of one
app, each at its own path, which each person turns on as they like, while each app still runs on
its own exactly as before.

```js
const host = await createHost({
  config: product,                                   // the host's own suite.config.js
  modules: [
    { mount: 'tasks', entry: new URL('./modules/tasks/server/module.js', import.meta.url) },
    { mount: 'projects', entry: new URL('./modules/projects/server/module.js', import.meta.url) },
  ],
  publicDir,                                         // the host's own pages at /, if any
});
await host.listen();
```

- **What is the host's, once for all**: the process, the database (`DATA_DIR/<host id>.db`), the
  session cookie and the sign-in, the table of accounts and their hooks, API tokens, OAuth and the
  identity provider (`/auth/*`, `/.well-known/*`, the consent screen, with the host's name and
  colour), mail, the brake, the audit log, `/admin`, `/health` and `/version`. The suite's modules
  that are one object for everyone (push, billing, organizations) are switched on in the host's
  configuration; a module that uses one the host has off doesn't start.
- **What each module keeps**: its tables and its migrations, run after the suite's in a scope named
  after its app id; its routes; its plan features (the plans themselves are the install's, so a
  grant of a plan counts in every module and one of `<app id>.<feature>` only in its own); its live
  channel (an account that changes is announced in all of them); its folder of uploads,
  `DATA_DIR/uploads/<app id>`, so that a module's sweep never takes another's files for orphans;
  its texts and what its data is for copies. What a plan allows of storage (`storage.mb`) is the
  person's, though: each module says what it keeps for someone (`createModule().storage(userId)`,
  in bytes) and `suite.storage.used(userId)` adds them up, for a module to check the whole. A
  PLANS JSON may name the features of any module: each part reads its own keys, and the host stops
  for a key that no part declares.
- **What someone uses**, for the admin and for each person (`usage.js`): each module may say what a person has in it
  (`createModule().usage(userId)` → `{ counts: [{ id, count, feature? }], active_at }`, `id` one of
  `USAGE_ITEMS`). A count with a `feature` is set against that limit of the module's plan, so it
  must be what the module's barrier counts. The host adds the storage and the calls from
  assistants of the last 30 days (`entitlements.dailyUsage()`, with `since`, the day the account
  was made, so a younger one is averaged over its own days: `countedDays()`). Counted by the week
  (`mcp.period: 'week'`), it also says this week's (`week`) and `more`, the plan with more of them:
  each person sees this week's days, and the limit only while a bigger plan has more or from 75 %
  of it; the admin, the last four weeks from Monday with the average a week. It answers
  `GET /api/admin/users/:id/usage` and, for the list, `GET /api/admin/usage` (each account's
  nearest cap). The list counts every account in batches of 100, letting the process answer
  others in between: each plan in a fixed number of queries (`entitlements.ofMany()`), the calls
  of the day or the week in one (`usedToday()`, `usedThisWeek()`), and a module that has `usageAll(userIds)` / `storageAll(userIds)`
  (a Map by user, `GROUP BY` the owner) answers a whole batch at once; without them, or for an id
  they leave out, it is asked one by one (v0.166.0). `/admin › Users` shows both. `GET /api/me/usage` answers the same of the person
  signed in, and only of them (Settings › Plan › Your usage); like every `/api` route it knows the
  web's session only, never an assistant's token.
- **What each module's plans allow** (`GET /api/admin/plans/modules`, the admin's only): the
  host's `/api/admin/plans` is its own catalog (its one MCP's calls); this one says, per module
  with a feature of its own, its declared features and each plan's values for them. A feature the
  host declares is the host's row, not again a module's. `/admin › Plans` draws the host's table
  and one per module under it; an app on its own has no such route, and shows its catalog alone
  (v0.210.0).
- **How a module is reached**: everything under `/<mount>/` goes to a `createApp()` of the
  module's own with the prefix taken off, so its API answers at `/<mount>/api/…`, the kit at
  `/<mount>/suite/…`, and its catalogs, `app-version.js`, service worker and files at their usual
  paths under the module's. Two modules with the same routes don't collide. `/<mount>/admin` goes
  to the host's `/admin`. A module's `install.baseUrl` ends in its path, so the links it writes
  point into it, and `config.host` says where it is. `GET /api/modules` lists the modules for the
  host's own pages; without pages, `/` opens the first module.
- **Its manifest** is served rewritten for its place (`id`, `start_url`, `scope`, icons and
  shortcuts under `/<mount>/`); the app's file doesn't change, because on its own those values are
  the identity of the copies already installed on people's phones.
- **In the browser**, the kit finds its base by itself (`web/base.js`) and `sw-core.js` works from
  the worker's scope: a module's cache is named after its path, and each worker clears only its own
  old caches, since the modules share one origin. A host's own worker at `/` leaves its modules'
  paths alone with `skip`. An app's own code becomes a module by taking its paths relative to its
  base (no `/js/…`, `/api/…` or `/sw.js` written as they are).

An app becomes a module in three small moves, none of which changes it on its own:

```js
// server/platform.js
export const suite = joinHost({ config: product, migrations: MIGRATIONS, hooks })
  ?? createSuite({ config: product, migrations: MIGRATIONS, hooks });

// server/module.js: what index.js gave createApp, plus the app's own jobs
export function createModule() {
  return { publicDir, routes: api, serializeUser, version: APP_VERSION, portable, sweep, start: startJobs };
}
// …and, for a phone's notification buttons, `deviceActions` (section 7, "Actions from a notification")

// server/index.js
const parts = createModule();
const app = createApp({ suite, ...parts, mcp });
const stop = parts.start?.();
await app.listen();
```

A host and its modules run **one copy of suite-core**: an `HttpError` thrown by a module must be
the one the host's `createApp()` knows. A module whose `server/suite` is another copy, or that
never calls `joinHost()`, stops the host's start, saying so. Not yet in the host: push notices
kept to the module that sent them, and coming back to the module after signing in with a provider.

### 21.1 Each person's modules

The host's own tables have their own scope, `host`, and an app on its own never gets them. The
first, `host_modules`, keeps which modules each person turned on: no row, they haven't chosen and
use every one; a module added to the host after they chose comes on for them. `GET /api/modules`
answers `{ host, chosen, look, modules: [{ mount, path, name, color, icon, links, settings, active }] }` for the host's
pages and the kit's shell, which draws a rail with the active ones and Settings where the sidebar
stays (from 640 px) and, on a phone, turns the app's icon at the drawer's head into a menu of the
other active ones and Settings, when the page is a module's; `PUT /api/me/modules { active: [mount…] }` sets them, at least one, from
Settings › Modules. Turning a module off keeps its data and leaves it reachable at its path: it
only leaves that person's menus, MCP and links.

The third, `host_looks`, keeps the look each person chose for every module (v0.111.0): `look` in
`GET /api/modules` is `cronum` (the suite's own, no row) or `clean`, and `PUT /api/me/look { look }`
sets it from Settings › Language and theme. The kit paints it as `<html data-look="clean">`
(web-kit.md).

Settings are one for the whole host (web-kit.md, v0.104.0): every module lists the account's
sections, then a group for each module in use, then the host's. A module names its sections for
the others in `createModule().settings`: `{ sections: [{ id, icon, label, hint }], ai, about }`,
with `label` and `hint` keys of its catalog; the host lists them in `/api/modules` (`settings`,
with `data` when the module declares its data) and drops what isn't well formed.

### 21.2 One MCP

The host's `/mcp` is the only one (`/<mount>/mcp` answers 404 with its address). Each module's
`createModule().mcp` brings its tools, prompts and errors, and the host announces them under the
module's name (`tasks_add_task`, `notes_search_notes`), each with the module's plan rules, only to
whoever uses that module; a tool of a module someone turned off answers how to turn it back on.
Only those names answer: neither a module's own bare names nor old ones (0.148.0). The instructions are written per person from each used module's `mcp.brief` (or its
instructions' first paragraph), whole parts only, under 2048 characters (`MCP_TEXT_MAX`, the
longest an assistant reads); tool descriptions keep under the same limit. The calls from
assistants are the host's plan feature (`mcp.calls_per_week` or `mcp.calls_per_day` in its
configuration or `PLANS`): one count per person for the whole app, whichever module a call goes to.

What a host may add to its MCP, each off without `createHost({ mcpOptions })` (0.190.0):

- **`byPlan`**: what someone's plan leaves out leaves their `tools/list`, not only their calls
  (before, an account without `mcp` was listed every tool and refused each call). A module's tool
  that names no `feature` needs the module's `mcp` when the module declares it. They keep a way to
  learn why: that module's part of the instructions says it and where to change plan, and
  `<host>_plan_info` (listed only to them) tells the assistant what to pass on.
- **`onDemand`** (`{ mount: [tool names] }`): tools used now and then kept out of the list, which goes
  whole into every conversation on most clients. `<host>_more_tools` names them in its description
  (so the assistant knows they exist and reaches for one when asked) and says what each does and
  takes; `<host>_use_tool` runs one, through the same plans, argument checks and calls of the day.
  They still answer by their own names. Each person may have them all listed instead (Settings ›
  Your AI, `PUT /api/me/ai-tools` with `all` or `door`, table `host_ai_tools`; no row: on demand).
- **`namesInText`**: a module's tool names in its descriptions, parameter descriptions and prompts
  get its prefix (`list_projects` → `next_list_projects`): whole words with an underscore only.
- **`recordChanges`**: an `mcp.tool` line in the audit log for each call that changed something
  (not `readOnlyHint`, no error): who, the tool and its module, and the assistant (`via`), never
  the arguments. The admin's Activity shows the assistant with whoever acted («@ana · via Claude
  Code»).
- **`maxResultChars`**: an answer cut at a whole line past that many characters, saying how much
  was left out and how to ask for less (`capResult`).

Every MCP server (mcp.js) hands its tools the assistant a call comes from as `principal.via`
(«Claude Code», «ChatGPT», «Codex»…): what its client said of itself in `initialize`
(`clientInfo`, `clientLabel`), a known assistant by its short name (`Anthropic/ClaudeAI` is
«Claude») and any other in 24 letters at most, carried in the session's id (`<uuid>.<label in
base64url>`) so a deployment doesn't forget it while the client goes on with the same session; a
label of an earlier version is named again as this one would. It names the
assistant for whoever reads it and proves nothing; without a session there is none. A module may
write it next to who did something (Tasks: created and changed by).

A name that is no tool answers the tools whose name ends in it («Did you mean
projects_list_projects or next_list_projects?»).

### 21.2.1 The apps' old addresses, for a while

While people move from the apps on their own to the host, the host can answer the addresses the
apps had (`legacy-domains.js`), with the domains pointed at it:

```sh
LEGACY_DOMAINS=tasks.example.com=tasks,notes.example.com=notes
```

- **`/mcp` points at the host's**: `/mcp` and `/mcp/*` answer 404 with
  `{ "error": "not_found", "mcp": "<BASE_URL>/mcp" }`, and `/.well-known/oauth-*` a 404: the apps'
  own connectors are gone (0.148.0; before, they served each module's tools there until
  `LEGACY_MCP=off`, which is no longer read).
- **`/sw.js` removes itself**: it empties its caches, unregisters and opens the module in the
  host, so the app installed from the old address stops showing what it kept.
- **Everything else goes to the module** (302 for a read, 307 for a write: temporary, nothing
  cached for good), the same path under `/<mount>/`.

A bridge meant to come down: emptying the variable and restarting turns it off; then the domains
can keep a plain redirect or go. Each entry must name a module, never the host's own address or
the same domain twice, or the start stops and says why.

### 21.3 Links between modules

`links.js`, with the host's second migration (`host_links`). A step of Next linked with a task of
Tasks, a note with a phase of Projects: one table, the person's own session and permissions, and
the module that owns each thing decides about it. A module says what can be linked of it:

```js
// server/module.js
cards: {
  task: {
    read: (user, id, opts?) => card | 'gone' | null,  // null: it exists and this person can't see it;
                                                    // (null, id, { system: true }): the host itself
    readMany: (user, ids, opts?) => Map<id, card | 'gone' | null>,
                                                    // optional: read() of many at once, in a fixed
                                                    // number of queries (IN (…) by batches of ≤ 500)
    search: (user, text) => [card…],                // what this person may link, as read() shows it
    create: (user, { title, place }) => id,         // optional: "Add to Tasks", by the module's rules
    places: (user) => [{ id, name }],               // optional: where create() may put it
    complete: (user, id, done) => {},               // optional: what "done together" does here
    audience: (id) => [userId…],                    // optional: who sees it, for live notices
  },
},
```

A card is `{ id, title, state: 'open' | 'done' | 'cancelled', due?, where?, url? }`, its url
relative to the module (`?list=27&task=389`). A thing is named by a ref, `module:type:id`
(`tasks:task:389`): the module's path, its kind, and its id, never the number people see.

The links of something, `changed()` and `prune()` read the other sides together: one `readMany`
for each kind of thing whose module has it (the same answer as `read` for each id, keyed by the
ids as strings), `read` for any id it leaves out, for every id when it throws, and for modules
without it. A search's cards are shown as the module's `search` gives them, none read again
(v0.166.0).

- **Each pair once**, in a fixed order, whichever way it was linked. `GET /api/links?ref=` lists
  the links of something with the other side's card, as its module draws it and only to whoever
  could already see it: something they can't open is `hidden`, with no title; something deleted is
  `gone`, with its last title only to whoever linked it. A link shows while the person uses both
  modules, and nothing of a module they turned off can be linked or created (403 `module_off`).
  Erased data leaves nothing here: after someone's data is erased in a module, and once an
  account's removal is done, `links.prune()` drops the title of each side that is gone and removes
  a link whose two sides are (v0.64.0).
- **Created where it lives**: `POST /api/links/new { from, module, type, data, together }` asks the
  other module to create it, by its own rules, and links it in the same transaction ("Send to
  Tasks"); `GET /api/links/search?module&type&q` lists what may be linked and the places to create
  in. `POST /api/links { from, to, together }` links what exists; `PATCH /api/links/:id
  { together }` and `DELETE /api/links/:id` change or remove a link, never the things.
- **Done together** is per link. The module calls, where it completes something,
  `suite.links?.done('task', id, true, { user })` inside its own transaction, and the other side's
  `complete()` runs in it; a chain of such links completes once each. `suite.links?.changed(type,
  id)` repaints the links of something that changed or was deleted: both modules' live channels
  get a `links` event `{ ref, link }` for whoever sees it. On its own an app has no `suite.links`.
- **For assistants**, the host's MCP adds `<host id>_linked_items` and `<host id>_link_item` (`work_` in Cronum Work) (link, or create in another
  module and link) for whoever uses two modules with things to link.
- **In the page**, the kit's `web/links.js`: `linksRow({ ref, title })` is the "Linked" row of an
  item's panel, one chip per link in the other module's colour that opens it there (crossed out when
  done, dashed when gone or out of reach), each with its menu (open, complete together, remove, with
  undo), and "+ Link": "Add to Tasks…" for each kind another module can create (`offer` keeps it to
  some), and "Link existing…" to search one. It asks the host's root, `GET /api/modules` saying what
  each module can link (`links: { task: { creates } }`); `row.show(ref, title)` when the panel shows
  another item and `row.refresh(events)` from the live channel (`events: ['links']`). On its own an
  app gets a hidden row, and nothing is asked.

### 21.3.1 The calendar

`calendar.js`, with `createHost({ calendar: '/calendar/' })`: a page of the host's own (in its
`publicDir`, as the split view) that shows, by day, what has a date in each module. Read-only:
each thing opens in its module. Without the option nothing of it is there. A module says what it
has with a date, next to its `cards`:

```js
// server/module.js
calendar: {
  // What `user` sees with a date in [from, to] (both 'YYYY-MM-DD', included): an item is there
  // when its span overlaps them. The same permissions as the module's own pages; [] for nothing.
  range: (user, { from, to }) => [item…],          // or a promise of them
},
```

An item is `{ type, id, title, start, end, state: 'open' | 'done', where, url, mine?, time? }`: the
module's own kind of thing (`task`, `phase`, `milestone`, `daily`), the row's id, its first and
last day (the same for one day; without `end`, one day), what shows under the title (a list, a
project › phase, a notebook), its url relative to the module as a card's (`?list=3&task=9`),
whether it is the person's, and `HH:MM` when it has a real time of day.

- **`GET /api/calendar?from=&to=`** at the root (401 signed out; 400 `field_invalid` naming `from`
  or `to` for a date that isn't one, `to` before `from`, or more than 366 days with both ends)
  asks every module the person uses that has a calendar, all at once and in their zone (time.js),
  and answers `{ from, to, modules: [{ mount, name, color, icon }], items, failed? }`: each item
  with its `module` and its url under the module's path (`/tasks/?list=3&task=9`), sorted by first
  day, then in the modules' order, then by title. What can't be shown is left out (no type or id,
  a day that isn't one, an end before its start, outside the span), and each module gives its
  2000 earliest at most. A module whose `range` throws, or gives no list, is logged and named in
  `failed`, never a 500: the rest of the calendar still shows.
- **On the rail** (`shell.js`), `GET /api/modules` says `host.calendar`, and every module's rail
  has a Calendar button (`kit.calendar.title`) just over the split view's, a link to that page.
  Only for whoever turned it on (0.195.0): Settings › Modules has the switch (`calendar_shown` in
  the same answer, `PUT /api/me/calendar { shown }`, table `host_calendar`); no row, no button,
  so the rail stays as simple as it was. The page and the assistants' tool are there either way.
- **For assistants**, the host's MCP adds `<host id>_calendar` (`work_calendar`) for whoever uses
  a module that gives its dates (and, with `byPlan`, whose plan lets an assistant read it):
  `{ from, to }`, `to` a week from `from` without it and `from` today in their zone without it,
  answered as text by day, each thing with its `module:type:id` for the modules' tools and the
  links'. A thing that lasts several days is said once, on its first day in the span.


### 21.4 From one module to another

Going from one module to another (the rail, or the menu at the drawer's head on a phone) opens
another page of the same site, and each module's page draws itself from its code: a few lines of
HTML, then main.js and what it imports, in four or five steps, then the catalogs, the install's
settings and the person, one after another. On a computer that was over half a second of an empty
screen, on a phone a second, and the rail came last, pushing the sidebar aside. Since 0.92.0:

- **The host names what a module's page will ask for** with the page itself (`page-hints.js`, a
  `Link` header on `/<mount>/` and `/<mount>/index.html`): every module script its static imports
  reach (read from its files and the kit's, again whenever one of them changes), `app-version.js`,
  the English catalog and the browser's language among the module's, `/<mount>/api/auth/config`,
  who the person is (`/<mount>/api/auth/me`, or the module's own GET paths it asks first, as
  `createModule().preload: ['/api/me', '/api/bootstrap']`) and the host's `/api/modules`. The
  browser asks for all of it at once. A module needs nothing for this, and an app on its own sends
  none of it.
- **The kit asks for each catalog once per page** (`i18n.js`): an app loads the language of last
  time before it knows who it is and the person's own once it does, most often the same one.
- **The rail of last time is drawn with the frame** (`shell.js`, the host's last answer kept as
  `host.modules`), and again when the host answers.
- **One page fades into the next** (`@view-transition` in kit.css, 200 ms), the rail standing
  still, where the browser has view transitions (Chrome and Edge, Safari 18.2 on), never for whoever
  asks for less motion.

Measured in a headless Edge over HTTP/2 with 45 ms to the server (90 ms and a four times slower
processor for a phone): the new frame came 0.37–0.54 s after the click instead of 0.81–0.87 s
(0.65–0.90 s instead of 1.37–1.44 s), and the empty screen between the two pages went from 0.6 s to
0–0.1 s (from 1 s to 0.1–0.25 s). What is left is the module's own first answers (the person, its
data), which drawing from what the device keeps would take away, module by module.

### 21.5 One service worker

`createHost({ worker })` (0.103.0, `host-worker.js`). Without it every module registers its own
worker at its own path, and an app installed from the host's page (its manifest's scope is `/`)
had four copies, four updates and four push subscriptions: a module's notice reached the device
once for each worker, titled with that module's name. With it:

- **`/sw.js` at `/` is the host's**, written from the files: the host's public folder, each
  module's `shell` and `optional` read from its own public/sw.js (the file it uses on its own,
  run with only `suiteWorker()`), the kit at every path. sw-core's `modules` option serves each
  module's paths as its own worker did (its /api, /version and the rest never cached, its code
  network first, a page of it offline is its index.html), installs file by file, clears the old
  workers' copies, and a notice tapped opens its module (`suiteOpenModule`).
- **Code from the copy first** (0.140.0). The worker's version is the fingerprint of everything the
  browser loads (below), so the host passes `codeFirst`: code, styles and catalogs are answered
  from the copy without asking the network, and what changes comes with the next worker. With
  `sharedKit` the kit is kept once, at /suite/, and `/<mount>/suite/x` is answered from it as a
  response of its own (`suiteAsAsked`), so a module's script still reads its base at its path.
  `hashes` (`shellHashes`) gives each file's hash: a new worker takes from the old copy every
  file whose hash didn't change and fetches only the rest. Pages, manifests and
  `js/app-version.js` always travel again.
- **One version for the whole app**: `/version` and `/js/app-version.js` at the root are the
  host's version (`app`), its name and one fingerprint of the host's, the kit's and every module's
  files, the suite's texts and any module catalogs outside its public folder (each module's beside it, in `modules`). The worker's version is the same fingerprint, so a
  release is a new worker. Each module keeps its own `/<mount>/version`.
- **The modules' pages** learn of it from `/api/auth/config` (`app.host.worker`) and, with the kit's
  `registerWorker()`, register the host's and retire theirs (a narrower scope would go on serving
  their pages), carrying the push subscription over where the browser allows it; the update notice
  is the host's, once, and none in a frame of the split view.
- **A module's notice** opens at its path: `url` under `/<mount>/`, its `tag` prefixed with the
  mount and `module` added (`hostedPush`). A module's own worker, where a device still has one,
  reads the same paths.

The app on its own never sees any of it: its /sw.js, scope and manifest stay as they are (§9).

### 21.6 Windows in one page

Cronum Work's one-document shell (behind `WORK_SHELL`, Work's r2/ventanas.md) mounts each module
in a window of one page instead of a page or a frame each. The kit's `web/windows.js` and
`windows.css` place those windows; the shell makes them (`windowOf(module)` → a `.cw-win` with its
`.cw-win__head` and `.cw-win__body`) and mounts, pauses and unmounts the modules it is told to.

- **The layout** is `{ cols: [{ w, wins: [module, module?], h? }], focus }`: one to four columns,
  one window a column or two stacked (four windows at most, so four make a 2×2), `w` a column's
  share in fr and `h` the top window's share of a column of two. `normalizeLayout()` reads any
  kept shape, the prototype's `{ slots }` included. A window never moves in the document: it is
  placed by its grid column (`--cw-col-N` in the desk's template, 320 px at least, an 8 px bar
  between two), and a stacked one takes its half of the cell (`--cw-row-N`).
- **Moving them.** A head picks its window up after 6 px (its shadow lifts it). As magnets, the
  window it comes over gives way while it is carried: pushed toward the place it would take, up to
  40 % of the way, as much as it is covered; past 55 % the two trade places and the others flow on
  from where they were pushed (FLIP, 420 ms with a slight overshoot, paced by the shell's own clock
  so a long frame never skips part of a slide). Let go short of that, they go back. Over the top or
  bottom part of a column of one it would stack there (a dashed box shows where, and it is done on
  letting go). Every window in sight is paused, and on a layer of its own, while it lasts. The columns are measured once, when it is picked up, and the
  loop only writes a transform inside requestAnimationFrame. The bars resize in rAF too, pausing the windows
  they touch (`onPause(module, true, { resizing: true })`); a double click evens them, arrow keys
  move a focused bar, and Alt with an arrow on a focused head moves its window. Escape cancels.
- **Phones** (< 768 px): one window at a time, a bar of tabs at the bottom, and a sideways swipe
  to the mounted module beside it; the desk only pans up and down, so nothing scrolls sideways.
  A swipe that begins on what slides sideways itself (a box with more to show across, or with
  `touch-action: pan-x`) is that box's, and so is one that begins inside `[data-own-swipe]`: a
  module marks so what has a sideways gesture of its own (Tasks' rows). Elsewhere, once the finger
  goes more across than down, the swipe keeps its touchmoves from the browser, which would take
  them in any scroller whatever the desk's `touch-action` says.
- **Out of view and evicted.** A window out of view is `hidden`, `inert` and paused
  (`onPause(module, true, { hidden: true })`, and `false` with `onShow` when it comes back). At
  most four modules stay mounted: beyond that `onEvict(module)` names the least recently used one
  that doesn't show, for the shell to unmount.
- **Kept** in this browser as `work.layout`, one layout per screen class (`wide` ≥ 1280 px, `mid`
  ≥ 768 px, `narrow`): crossing from one to another brings back that class's layout, and the
  columns that don't fit a narrower desk stack where there is room, the layout kept as chosen
  until it fits again.

The model and its moves are pure functions exported with it (`applyColumns`, `slotAt`,
`dropLayout`, `moveByKey`, `lruEvict`, `placement`…) and tested without a browser
(`test/windows.test.js`). Nothing of it is loaded outside Work's shell.

### 21.7 One page for several modules: what the host serves

Cronum Work's one-document shell opens every module in a window of one page (`mount(root, ctx)`,
web/mount.js) instead of a page or a frame each. Three options of `createHost` serve what that page
needs; all are off by default, and a host that doesn't ask for them answers exactly as before
(§9). Work turns them on with its `WORK_SHELL` flag only.

```js
const host = await createHost({
  config: product, modules,
  pages: [{ at: '/w/', dir: SHELL_DIR }],   // index: 'index.html' by default
  scopedSheets: true,
  liveAll: true,
});
```

- **`pages`**: a page of the host's own, from a folder of its own, answered before anything else of
  the host's: GET and HEAD under `at` are files of `dir` (`at` itself is its `index`; `/w` goes to
  `/w/`), with the security headers and caching of the host's other files (`serveStatic`: ETag from
  what the file holds, code revalidated). A file the folder doesn't have is a 404, never a module's
  page nor the host's. `at` is one path segment that is no module's, the split view's, the calendar's or the host's
  own (`RESERVED`); the start stops otherwise. One page may be the app's start (`root: true`): `/`
  answers its index too, but for an address with a query name it lists (`root: { except: ['modules'] }`,
  Work's `/?modules`), which opens the host's own home as before. A page's files count in the
  whole app's fingerprint (`/version`) and, with the one worker, are kept in its copy at their
  paths with their hashes: a release that changes only a page is a new worker and a notice.
- **`scopedSheets`**: `GET /<mount>/<path>.css?scope=work` answers the file the module would serve
  there (its public folder, or the kit's at `/<mount>/suite/…`) through `scopeCss()` (scope-css.js):
  the sheet inside `@scope ([data-module="<mount>"], [data-owner="<mount>"])`, `:root` as `:scope`,
  `html` and `body` as `:scope[data-module]` (the window only: `html, body { height: 100% }` made a
  toast's box the whole page), `:root[x] body` as one element, `@media`/`@supports`/`@container`/
  `@layer` kept inside with their rules rooted the same way, and `@font-face`, `@keyframes`,
  `@property`, `@import` (asked for scoped too), `@charset`, `@view-transition` and the like before
  the block, where they mean anything. Relative `url()`s become paths of the site. The result is
  kept in memory while the whole app's fingerprint (§21.5) is the same, its ETag that fingerprint
  and the sheet's path (`SCOPE_FORMAT` in it, raised when the output changes), `Cache-Control:
  no-cache`, 304 when it matches. A file the module hasn't, as before; without the option,
  `?scope=work` is a query like any other.
- **`liveAll`**: `GET /api/events?all`, with the host's session (a 401 without one, as each module's
  channel), streams what every module with `modules.live` would tell that person on its own
  `/<mount>/api/events`, in one connection: each notice an unnamed message whose data is
  `{ module, event, data }`. It opens with each module's missed notices or its `resync`, then
  `{ module: null, event: 'hello', data: { user_id } }` (with `replayed: true` when it came back
  with an id, by the header or `&last=`); its id says where it is in every module
  (`notes=<boot>.<n>,next=<boot>.<n>`), so a browser coming back gets what it missed module by
  module (live.js `subscribeAll()`, over each channel's `relay()`). It counts as one of the person's
  channels in each module, and ends with any of them: revoked sessions (`account` said first),
  the host closing, a reader that stopped reading. The modules' own channels stay as they are.
  In the browser, `connectLive()` of a module in the shell's page goes through the shell's
  registry (`workRegistry().live.subscribe(module, handlers)`) and gives back the same object.
