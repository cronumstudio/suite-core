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
| Conventions (English, error codes, aliases, commits, versions) | Next | Already all English, API answers codes, old names kept as aliases |
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
  watcher.js            done   hot reload by polling, for code mounted over SMB
  http.js               done   router, HttpError, body parsing, security headers, CSRF, static files
  db.js                 done   openDatabase(): WAL, foreign keys, all/get/run/tx, app_meta
  migrate.js            done   numbered migrations with scopes (suite, app)
  crypto.js             done   scrypt, HMAC, random tokens, token hashes
  accounts.js           done   users, identities, passwords, sign-in, the admin's rules; hooks for the app
  sessions.js           done   browser sessions: sliding, rotated, revocable
  tokens.js             done   API tokens (manual MCP tokens) with scopes and expiry
  principal.js                 one resolver: cookie, bearer token, OAuth, AuthKit JWT, device
  rate-limit.js         done   brute-force brake persisted in the database
  organizations.js      done   organizations, memberships, roles, invitations, seats
  entitlements.js       done   features, plans and grants; can() / limit() / require()
  billing.js            done   payments turned into grants: provider interface, signed webhooks; Stripe later
  mcp.js                done   Streamable HTTP transport, tool registry, prompts, legacy aliases
  live.js                      SSE hub with audiences, event ids and replay
  i18n.js               done   catalogs, language negotiation, t() on the server
  push.js                      Web Push (VAPID, RFC 8291), subscriptions per device and language
  uploads.js                   file storage checked by content, trash and orphan sweep
  mail.js               done   outgoing mail: SMTP without dependencies, or the log
  account-mail.js       done   confirming emails, new passwords, invitations, open sign-up
  audit.js              done   who did what and when, never the content
  api.js                done   the common routes: /api/me/*, /api/admin/* and /api/orgs/*
  i18n/                 done   the suite's own texts: en.json, es.json, fr.json, de.json
  web/                  begun  browser kit (§15), served at /suite/; the admin panel at /admin
  tools/                done   i18n.mjs: catalog parity and keys in use; conformance tests for apps later
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
  trustProxy: true,               // the default of TRUST_PROXY when an install doesn't set it

  organizations: {                // only with modules.organizations
    roles: ['owner', 'admin', 'member'],   // plus the app's own, e.g. 'monitor' in Tracker
    invitationDays: 7,
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
  },
};
```

Environment variables configure the install, never the product (`config.js` reads them):
`BASE_URL`, `PORT`, `HOST`, `HOST_PORT`, `DATA_DIR`, `DB_PATH`, `TZ`, `TRUST_PROXY`, `SECURE_COOKIES`,
`SESSION_SECRET`, `ADMIN_USER`, `ADMIN_PASSWORD`, `ADMIN_DISPLAY_NAME`, `ADMIN_EMAIL`, `AUTH_PROVIDER`
(`local` | `workos` | `oidc`), `WORKOS_*`, `OIDC_*`, `MCP_OAUTH`, `CIMD_ALLOW_PRIVATE_HOSTS`, `HOT_RELOAD`,
`BILLING_PROVIDER` (`remote` so far) with `BILLING_SECRET` and `BILLING_URL`, `MAIL_PROVIDER` (`log` |
`smtp`) with `MAIL_*`; later `VAPID_*` and `STRIPE_*`. Three product settings may be overridden
per install: `PLANS` (JSON, same shape as `plans`), `DEFAULT_PLAN` and `SIGNUP`.
Old variable names keep working as aliases, with a warning (`RECARGA_EN_CALIENTE`, `PORT_HOST`…).

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
  PRIMARY KEY (provider, ref)
);
CREATE TABLE billing_events (            -- each webhook event applied once
  provider    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  type        TEXT NOT NULL,
  outcome     TEXT NOT NULL,             -- granted | extended | changed | revoked | kept | stale…
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
{ user, kind: 'session' | 'token' | 'oauth' | 'idp' | 'device', scopes, credentialId }
```

It looks, in order, at the session cookie, then `Authorization: Bearer` (a manual API token, then
a built-in OAuth access token, then an AuthKit JWT), then a device token (Focus kiosks and ESP32,
Tracker's native emitter). There is no second path for any client.

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
it). `X-Forwarded-For` is trusted only with `TRUST_PROXY=true`. For tokens only failures count, so
a valid client is never locked out by a neighbour.

**Sign-in providers.** `local` (default): usernames and passwords, accounts created by the admin,
by invitation or by open sign-up as `accounts.signup` says. `workos`: AuthKit handles sign-up, 2FA,
Google and recovery, and is the authorization server for the MCP; an existing user is linked only
through a verified email, and `ADMIN_EMAIL` takes over the first admin. `oidc` (**done**, v0.13.0):
any OpenID Connect provider (Authentik, Keycloak, Zitadel, Google, Entra), so a self-hoster gets
single sign-on across the apps — which replaces the identity bridge once planned between Projects
and Tasks. `oidc.js` signs in with PKCE, a state and a nonce, checks the ID token against the
provider's keys (`jwt.js`, shared with WorkOS: RS256 or ES256, issuer, audience, dates, nonce), and
turns the person into an account with `accounts.fromIdentity()`: linked by a verified email, the
admin email taking over the first administrator, or created. AI clients keep the app's own OAuth,
whose consent screen sends whoever isn't signed in to the provider and back. The variables are
`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (empty for a public client), `OIDC_SCOPES`
and `OIDC_NAME` (the button: "Sign in with Authentik").

## 8. Entitlements: plans and permissions

The app never asks whether someone pays. It asks what they may do, and the answer comes from one
place:

```js
entitlements.can(user, 'attachments', { organization })        // → boolean
entitlements.limit(user, 'lists.max', { organization })        // → number | null (no cap)
entitlements.require(user, 'lists.max', { current: 4 })        // throws 402 plan_limit
entitlements.of(user, { organization })                        // → { plan, features, ends }
```

**Resolution.** Start from the default plan's values. Add every active grant of the user and of
the organization in context (`starts_at <= now < ends_at`, not revoked): a plan grant brings its
plan's values, a feature grant its single value. When sources disagree, the most generous wins:
`true` beats `false` for flags, and for limits `null` (no cap) beats any number and a larger number
beats a smaller one. The instance admin gets every feature. A plan that disappears from the catalog
counts as the default plan: nobody is left with nothing, and nothing is ever deleted when someone
drops to a smaller plan — they just cannot add more.

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
  checkoutUrl({ subject, customer, product, price, email, returnUrl }),  // hosted checkout page
  portalUrl({ customer, returnUrl }),                                    // manage or cancel
  parseWebhook({ headers, body }),       // verify the signature → normalized events
}
```

Whatever the provider calls them, events arrive normalized as
`{ id, type: 'subscription' | 'purchase' | 'refund', occurredAt, subject?, customer?, ref, product?,
status?, periodEnd?, quantity? }` and become grants with `source` = the provider and
`external_ref` = the subscription or order:

- A subscription that is `active` or `trialing` holds its plan until the end of the paid period
  plus `graceDays` (3), so a failed renewal lapses on its own; a renewal moves that end on the same
  grant. `past_due` changes nothing; `canceled` or `ended` ends it now. A change of product or of
  seats (`quantity`) replaces the grant.
- A one-off purchase grants its plan for good, or for the product's `days` (a pass); a refund
  ends it.
- Each event is applied once (`billing_events`), and a subscription event older than the state
  already known (`billing_subscriptions`) is ignored: providers retry and reorder.

Products live in the app's configuration, each tied to a plan of the catalog and checked on start:
`{ 'pro-monthly': { plan: 'pro', kind: 'subscription', price: 'price_…' }, 'pro-lifetime':
{ plan: 'pro', kind: 'once' }, 'family-yearly': { plan: 'family', kind: 'subscription', for:
'organization' } }`. `billing_customers` keeps each user's or organization's customer at the
provider. The routes are `GET /api/billing/products`, `POST /api/billing/checkout` and
`/api/billing/portal` (for a person, or for a group by one of its admins),
`GET /api/billing/subscriptions` and `POST /api/billing/webhook`.

`signedProvider()` speaks these normalized events directly, signed with a shared secret
(`t=…,v1=…`, HMAC-SHA256, the scheme Stripe uses, five minutes of tolerance). It is what the tests
use and what a private service of the hosted suite (working name *Cronum Accounts*) would send: that
service would hold products, customers and subscriptions for every app, with WorkOS and the real
payment provider, and push each app its grants; the apps would not change. The Stripe adapter (or a
merchant of record such as Paddle, which also settles EU VAT) comes when a price is decided.

## 10. Organizations

An organization answers "whose is this and who pays": a group of people who share data, roles and
a subscription. The module is off by default. With `mode: 'optional'` people use the app on their
own and may create or join groups (a family in Tasks, a team in Projects); with `mode: 'required'`
every user belongs to one (the schools of Tracker). The suite provides the tables, the roles,
invitations by link or email, an organization switcher in the web kit and organization-level
grants: a plan bought for a household covers its members, and a grant's `quantity` caps the number
of members (seats). Which records belong to an organization instead of a person is the app's
decision, made in its own tables.

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
5. The suite's API: `/api/auth/*`, `/api/me/*`, `/api/admin/*`, `/api/orgs/*`, `/api/events`,
   `/api/push/*`, `/api/billing/*`.
6. The app's API routes.
7. `/suite/*` (the web kit), `/admin` (the admin panel, when `modules.admin` is on) and
   `/i18n/<lang>.json` (suite and app catalogs merged).
8. The app's static files, then the SPA fallback for paths without an extension.

The common API is the same in every app: sign-in (`POST /api/auth/login`, `POST /api/auth/logout`,
`GET /api/auth/config`), the profile (`GET/PATCH /api/me`, `POST /api/me/password`, sessions,
tokens, connected apps, entitlements), administration (users, plans and grants, organizations,
audit) and the live channel. Errors are codes, never sentences (see CONVENTIONS.md).

## 12. Live updates

`live.js` keeps one SSE channel per browser tab (`GET /api/events`): `retry:`, a heartbeat every
25 s, `X-Accel-Buffering: no`, exempt from the request timeout. The app publishes
`live.publish({ type, audience, data })`, where `audience` is a list of user ids or an organization.
Every event carries an `id:`; a short ring buffer lets a client that reconnects with `Last-Event-ID`
receive what it missed, and a gap larger than the buffer (or a restart) sends `event: resync`, after
which the client reloads what it shows. Events may carry the new state (Focus's run contract) or
just say what changed (Tasks' lists): the app chooses.

## 13. MCP

`mcp.js` is the Streamable HTTP transport the three apps already share: JSON-RPC 2.0 on `/mcp`,
protocol versions 2025-06-18, 2025-03-26 and 2024-11-05, SSE answers when the client only accepts
them, a `401` with `WWW-Authenticate` pointing at the resource metadata, `503` when AuthKit cannot
be reached, and the token brake. The app hands in its tools, prompts and instructions:

```js
{ name, title, description, inputSchema, feature?, legacyNames?, handler(principal, args) }
```

`feature` makes the transport check the plan before calling the tool. `legacyNames` and legacy
parameter names keep clients with a cached schema working after a rename (as Next did when it moved
to English). Tool descriptions and results are in English; the instructions ask the assistant to
answer in the user's language.

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
  from server errors, `Idempotency-Key` on writes.
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
  catalogs, never caching `/api`, `/mcp`, `/auth`, `/oauth`, `/version`.

**Today (v0.15.0).** `dom.js` (`el`, `$`, `$$`, `clear`), `i18n.js` (`t()` with placeholders and
plural forms, exact ones such as `=0` included; flat or nested catalogs; `pickLanguage()`, dates),
`api.js` (`ApiError`, `SessionExpired`, `Offline`, `errorMessage()`), `ui.js` (toasts, fields,
dialogs on the native `<dialog>`, confirmations), `theme.js` and `kit.css` (light and dark). On
them, the admin panel: `/admin` serves `web/admin.html`, which has no inline script or text. It
asks `/api/auth/config` which app this is, its languages and the modules it has on, shows itself
in the person's language with the app's name, and only to an administrator: accounts (create,
role, plan, extras granted per feature with an end date, a new password, signing out everywhere,
disabling, removal), invitations with the link to pass on, what each plan allows, organizations
when that module is on, and the activity log, filtered and paged. A feature is named by the app's
`features.<key>` text when it has one, else by its label in the configuration.
Still to come: `live.js`, `update.js`, `outbox.js`, the sign-in and settings screens (each app
keeps its own for now), `tokens.css` from the Cronum style guide and `sw-core.js`.

## 16. Push, uploads, mail and audit

- **Push** (from Tasks): VAPID keys generated on the first start and kept in `app_meta` unless
  `VAPID_*` are set; one subscription per device with its language; failed endpoints pruned; the
  app composes the messages (Tasks batches other people's changes, Projects sends a daily summary).
- **Uploads** (from Tasks): the file travels as the raw request body; the type is decided by its
  first bytes (images and PDF; never SVG); files live under `DATA_DIR/uploads` and are never served
  as static files; soft delete with a trash, purge after N days, and an orphan sweep that refuses to
  run when the database looks restored without its files. The app keeps its own table linking files
  to its records and decides who may see them. Storage per user or organization can be a plan limit.
- **Mail** (**done**, v0.14.0): `mail.js` sends through SMTP (`MAIL_PROVIDER=smtp`, `MAIL_HOST`,
  `MAIL_PORT`, `MAIL_SECURE` tls | starttls | none, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM`) with a
  client of its own —no dependencies, STARTTLS required unless told otherwise, AUTH PLAIN or LOGIN,
  headers that can't be broken into— or, by default, writes the message in the server's log, so an
  install without a mail server can still pass a link on. `account-mail.js` carries what local
  accounts need: a link to confirm an email (48 h), a new password when the old one is forgotten
  (1 h, once, every other session closed; the answer is the same whether the account exists), the
  admin's invitations (7 days; the link is also returned, to pass on by hand) and open sign-up.
  Every link is a single-use token kept as a hash; the brake limits requests per address and links
  per inbox. The texts are the suite's, in each person's language. With WorkOS or OIDC the provider
  sends its own. Without a mail server nothing pretends otherwise (v0.16.0): `/api/auth/config`
  says `mail: false`, so screens don't promise a link that won't arrive; an invitation comes back
  `sent: false` with its link; and the admin can confirm an email by hand (`email_verified` on
  `PATCH /api/admin/users/:id`), which is the only way to confirm one there. With a mail server
  (v0.17.0), the app checks it once at the start —it answers, encrypts, takes the account— and
  says so in the log (`[mail] SMTP ready` or why not); a message that fails later is logged with
  its reason and answered `mail_failed` (502), except a forgotten password, whose answer never
  changes.
- **Audit**: sign-ins and failures, sessions and tokens created or revoked, admin actions, plan
  changes, billing events. Who, when, what and from where; never titles, notes or passwords.

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
- `tools/conformance.js` runs against a running app and checks the platform behaviour it inherits:
  headers, `/health` and `/version`, sign-in and sign-out, the brute-force brake, CSRF, the MCP
  `401` challenge, JSON 404 on discovery paths, translations complete. Each app's smoke test calls
  it, then tests its own domain.

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
| `i18n.js` + `tools/i18n.mjs` | done (v0.12.0: the suite's errors and fields once, merged catalogs, parity; v0.15.0: `t()` in the browser) | the lint of strings written in the code |
| `accounts.js`, `organizations.js`, `audit.js`, `api.js` | done (v0.8.0) | adopted by Next (organizations off) |
| Identities, `tokens.js`, profile routes | done (v0.9.0) | adopted by Next |
| `oidc.js`, `jwt.js` | done (v0.13.0) | available to every app with AUTH_PROVIDER=oidc |
| `mail.js`, `account-mail.js` | done (v0.14.0) | adopted by Next, with its screens (sign-up by invitation or open, confirmation, new passwords); an SMTP server per install |
| `entitlements.js` | done (v0.7.0) | adopted by Next (no limits by default); Tasks with `importUserPlans()` |
| `app.js`, `config.js`, `watcher.js` | done (v0.11.0) | Next boots on them; Tasks next, after its PR #2 |
| `live.js`, `push.js`, `uploads.js` | planned | from Tasks |
| Web kit and admin panel | begun (v0.15.0: the kit's base and the admin panel at `/admin`) | used by Next; the sign-in and settings screens, `live.js` and the outbox; the Cronum style guide's tokens |
| `billing.js` | done (v0.10.0: interface, signed provider, grants) | a real adapter (Stripe or a merchant of record) when a price is decided; Next keeps it off |
