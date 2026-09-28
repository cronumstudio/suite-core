# Changelog

Versions follow [semantic versioning](https://semver.org/); while in `0.x`, a minor version may
change an interface and a patch never does. Apps pin a version through the submodule pointer.

## 0.14.0 — 2026-09-28

- `mail.js`: outgoing mail. `MAIL_PROVIDER=smtp` sends through an SMTP server with a client of
  its own (no dependencies): implicit TLS or STARTTLS —required unless `MAIL_SECURE=none`—,
  AUTH PLAIN or LOGIN, UTF-8 messages in base64 with an optional HTML part, headers that can't
  be broken into. The default, `log`, writes the message in the server's log.
- `account-mail.js`: a link to confirm an email (48 h), a new password when the old one is
  forgotten (1 h, once; every other session ends; the same answer whether the account exists),
  the admin's invitations (7 days; the link is also returned) and open sign-up. Single-use tokens
  kept as hashes in `account_tokens` (suite migration 11).
- `api.js`: `registerAccountMailApi()` — `POST /api/auth/forgot`, `/api/auth/reset`,
  `/api/auth/verify`, `/api/auth/signup`, `/api/me/email/verify` and `/api/admin/invitations`;
  `/api/auth/config` says who may sign up.
- `config.js`: `accounts.signup` takes `admin`, `invite` or `open`, and `SIGNUP` overrides it per
  install; `MAIL_*` are checked.
- `rate-limit.js`: `allow(kind, req)` and `allowTo(kind, target)`, for mail (10 per address, 3
  per inbox) and sign-ups (5 per address) in the window.
- `app.js`: the first administrator gets `ADMIN_EMAIL`, so a forgotten password can be recovered.
- `i18n/`: the messages, and the errors and fields they bring.

## 0.13.0 — 2026-09-28

- `oidc.js`: sign-in with any OpenID Connect provider (AUTH_PROVIDER=oidc, `OIDC_ISSUER`,
  `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPES`, `OIDC_NAME`): discovery, PKCE, state
  and nonce, the code exchanged with client_secret_basic or _post, the ID token checked, userinfo
  when the token leaves the email out, a return path kept within the app, and the provider's
  sign-out. The identity is `oidc:<issuer host>`, so moving to another provider links people
  again by their email.
- `jwt.js`: JWT checks shared by WorkOS and OIDC — keys from the JWKS kept an hour and refetched
  on an unknown one at most every five minutes, RS256 and ES256 only, issuer, audience, dates,
  nonce. `workos.js` now uses it.
- `accounts.js`: `fromIdentity()` — the account of someone who signed in at a provider: linked,
  linked now by a verified email, the admin email taking over the first administrator, or
  created; `freeUsername()`.
- `oauth.js`: `externalSignIn` — with it, the consent screen offers "Sign in with <provider>"
  and comes back to the same request, instead of asking for a password.
- `api.js`: the auth routes take any identity provider (`idp`); `/api/auth/config` also says its
  name, and signing out returns its sign-out address when it has one.
- `config.js` and `app.js`: AUTH_PROVIDER=oidc, checked like WorkOS; the built-in OAuth stays on
  with it.
- `i18n/`: `oauth.signInWith`.

## 0.12.0 — 2026-09-28

- `i18n/`: the sentence of every error code and the name of every field the suite's modules
  send, in English, Spanish, French and German — written once here instead of in every app.
- `i18n.js`: `mergeCatalogs()`, `unflatten()` and `isNested()`: an app's catalog over the
  suite's, in the app's own shape (nested or dotted).
- `app.js`: `createApp` serves `/i18n/<lang>.json` for the app's languages, merged and with an
  ETag, rebuilt when the app's file changes.
- `tools/i18n.mjs`, from Focus: `parity` (the same keys, placeholders and plural forms in every
  language, nothing left as TODO) and `used` (keys in the code that no catalog defines), on the
  suite's catalogs or an app's merged over them.

## 0.11.0 — 2026-09-28

- `config.js`: `resolveConfig(product, env)` — the product definition (`server/suite.config.js`:
  app, modules, accounts, sessions, organizations, tokens, rate limits, features, plans,
  products, the default of TRUST_PROXY) and the install's environment (BASE_URL, PORT, DATA_DIR,
  secrets, AUTH_PROVIDER and WorkOS, MCP_OAUTH, PLANS, BILLING_PROVIDER, HOT_RELOAD…), checked as a
  whole. Unknown settings, modules or languages, WorkOS half set up and billing without its module
  are errors; old variable names and an unknown AUTH_PROVIDER are warnings.
- `app.js`: `createSuite()` opens the database, runs the app's migrations and the suite's, and
  creates sessions, accounts, API tokens, the audit log, the brake, plans and, as configured,
  organizations, billing, WorkOS and the built-in OAuth (whose look the app hands in); it refuses
  to start on any error, saying what is wrong. It also creates the first administrator
  (`ensureAdmin()`), cleans up (`purge()`) and resolves MCP tokens of every kind.
  `createApp()` serves in the suite's order: security headers, the cross-site check, `/health`,
  `/version`, `/js/app-version.js`, `/mcp` and `/mcp-info`, the suite's routes and then the app's
  (405 with `Allow`), WorkOS and OAuth, a JSON 404 for discovery paths, static files and the SPA
  fallback; with periodic clean-ups, hot reload and an orderly shutdown.
- `watcher.js`: hot reload by polling, walking the whole server folder, the submodule and its
  texts included.
- `api.js`: `registerAuthApi()` — `/api/auth/config`, `login` (with the brake and the audit
  log), `logout` (with AuthKit's sign-out address) and `me`.
- `schema.js`: migration 10 creates the built-in OAuth's tables for apps that didn't have them.
- `billing.js`: an event without a valid end of period names the field `period_end`, in the
  suite's snake_case like every other field.

## 0.10.0 — 2026-09-28

- `billing.js`: payments turned into grants, off unless the app hands in a provider. A provider
  adapter hosts checkout and the portal and reports through a signed webhook; its events arrive
  normalized (subscription, purchase, refund). An active or trialing subscription holds its plan
  until the end of the paid period plus three days of grace and is extended in place on renewal;
  past due changes nothing, so an unpaid renewal lapses on its own; canceled ends it. A change of
  product or seats replaces the grant. One-off purchases grant a plan for good or for some days;
  refunds end them. Each event is applied once and older subscription events are ignored.
  Products are tied to plans and checked on start. `registerBillingApi()` serves
  `/api/billing/products`, `checkout`, `portal`, `subscriptions` and `webhook`; a group pays
  through one of its admins. `signedProvider()` speaks the normalized events signed with a shared
  secret (the scheme Stripe uses): what the tests use and what a central accounts service would
  send. `signPayload()` / `verifySignature()`.
- `schema.js`: migration 9 (`billing_customers`, `billing_subscriptions`, `billing_events`).

## 0.9.0 — 2026-09-28

- `accounts.js`: identities — the accounts people have at WorkOS, an OIDC provider or Google,
  one row per provider and account in `user_identities` instead of a column per provider.
  `byIdentity()`, `linkIdentity()` (a provider's account belongs to one account only),
  `unlinkIdentity()`, `identitiesOf()`, `usedIdentity()`, `unlinkedByEmail()`,
  `firstUnlinkedAdmin()`, `setVerifiedEmail()`, and `create({ identity })` to create and link at
  once. An app table whose `password_hash` is `NOT NULL` (Tasks) gets `!` for accounts without a
  password.
- `workos-accounts.js`: `workosUsers(accounts)`, the users the WorkOS routes need made on the
  suite's accounts and identities; links kept in `users.workos_user_id` by an older version are
  adopted when asked for. An optional `users.signedIn()` notes each web sign-in.
- `tokens.js`: API tokens — the apps' `mcp_tokens` become `api_tokens` with the same rows and
  hashes, so no connector stops working; scopes (`mcp`, `read`, `write`), optional expiry, a cap
  per person, and `authenticate()`, which refuses expired tokens, missing scopes and disabled
  accounts, noting the last use at most once a minute.
- `api.js`: `registerProfileApi()` — `/api/me/sessions`, `/api/me/entitlements`,
  `/api/me/tokens`, `/api/me/apps` and `POST /api/me/password`, answering like Next always did
  and, through `alsoAt`, at the paths an app already had. The admin's user list says which
  providers each account signs in with.
- `schema.js`: migrations 7 (`user_identities`, taking over `users.workos_user_id`) and 8
  (`api_tokens`, taking over `mcp_tokens`).

## 0.8.1 — 2026-09-28

- A disabled account stays out everywhere: `workos-accounts.js` sends it back with
  `auth_error=disabled` and its AuthKit tokens are no one; `oauth.js` access tokens of a disabled
  account open nothing (its grants are kept for when it is enabled again). Sessions already
  ignored it.

## 0.8.0 — 2026-09-28

- `accounts.js`: the people who can sign in. `usersSchema()` creates `users` in the suite's shape
  or completes an app's own (email, verification, locale, theme, prefs, last sign-in, disabled),
  leaving the app's columns alone and turning `datetime('now')` dates into ISO. `createAccounts()`
  creates accounts (with the app's columns through `extraColumns`), updates, disables, sets
  passwords, verifies sign-ins (a disabled account never signs in; an old hash is redone) and
  removes them. It never leaves the install without an administrator; disabling someone or giving
  them a new password ends their other sessions. `whenCreated()` / `whenRemoved()` hook the app
  in, inside the same transaction.
- `organizations.js`: groups that share data, roles and a plan. Memberships with roles in order of
  power (`owner`, `admin`, `member`, and the app's own as members), the last owner kept, invitation
  links kept as hashes (once, before they expire, unless revoked), seats through `seatsOf`, and
  `forgetUser()`, which hands a departing owner's groups to their oldest admin or member, or
  archives them.
- `audit.js`: the audit log — who, what, when, from which address, with small facts and never
  content; listed newest first with paging and filters, purged after a year.
- `api.js`: `registerAdminApi()` (`/api/admin/users`, sessions, plans, grants, organizations,
  audit) and `registerOrganizationsApi()` (`/api/orgs`: create, invite, join, roles, leave), each
  change recorded in the audit log.
- `entitlements.js`: `seatsOf()`, the seats of an organization from its grants' quantity.
- `schema.js`: migrations 4 (`users`), 5 (`organizations`, `memberships`, `invitations`) and 6
  (`audit_log`). Every table is created whether the app uses its module or not.

## 0.7.0 — 2026-09-28

- `entitlements.js`: what each person may do. The app declares the features it can limit (flags
  and limits, with labels and old names); the plan catalog comes from the app or from PLANS and
  is validated on start. Grants give a plan or one feature to a user or an organization, from a
  source (admin, stripe, license, promo, remote), for a window, with a quantity: subscriptions,
  one-off and lifetime purchases, trials, gifts and seats are all grants. The most generous
  source wins; the instance admin is never limited. `can()`, `limit()`, `require()` (402
  `plan_feature` / `plan_limit`), `allows()` for MCP tools, `grant()`, `revoke()`, `setPlan()`,
  and `importUserPlans()` for the per-user plan columns of Tasks.
- `schema.js`: migration 3 creates `entitlement_grants`.

## 0.6.0 — 2026-09-28

- `mcp.js`: the Streamable HTTP / JSON-RPC transport every app shared a copy of — 401 with the
  resource metadata, 503 when tokens can't be checked, the token brake, batches, SSE answers,
  OPTIONS, GET and DELETE. Tools may declare a `feature` and `allows(principal, tool)` decides
  before they run; renamed tools and parameters keep working through `legacyTools` and
  `legacyParams`.
- `http.js`: `readJson()` accepts arrays with `allowArray` (JSON-RPC batches).

## 0.5.0 — 2026-09-28

- `sessions.js`: sessions that live while they are used (`idleDays`) and never longer than
  `maxDays`; signing in closes the browser's previous session; each notes its device and can be
  listed and closed on its own; `closeAllOf()` for password changes; `resolveSessionSecret()`
  takes SESSION_SECRET or generates and keeps one, ignoring example values. Tokens are hashed as
  the apps already did, so nobody is signed out by the move.
- `rate-limit.js`: failures kept in `login_attempts` over 15 minutes, per account, per address,
  for tokens (failures only) and client registrations; buckets stored as keyed hashes.
- `schema.js`: `SUITE_MIGRATIONS`, run after the app's own. Number 1 brings a `sessions` table
  from the apps' older shape (`token`, `workos_sid`, dates by `datetime('now')`) to the suite's.
- `http.js`: `clientIp()` and `proxyHops()` count trusted proxies from the end of
  `X-Forwarded-For` (TRUST_PROXY=true is one; a number, that many).

## 0.4.0 — 2026-09-28

- `crypto.js`: passwords in the scrypt format every app already stores (old hashes verify as
  they are), token hashes, HMAC, constant-time comparison, `needsRehash()`.
- `db.js`: `openDatabase()` with the usual pragmas, or `wrapDatabase()` around an app's own
  `DatabaseSync`; transactions that nest as savepoints and refuse async work; `app_meta`.
- `migrate.js`: numbered migrations per scope (`suite`, `app`), each in its own transaction,
  refusing gaps and databases written by a newer release; adopts Focus's older table.
- `http.js`: `HttpError` with codes and headers, router with 405 and `Allow`, `readJson`
  requiring the JSON content type, cookies, static files that never leave their root or serve
  dotfiles, the security headers, and `checkOrigin()` against cross-site requests that ride on
  the session cookie.

## 0.3.0 — 2026-09-28

- `i18n.js`: the suite's own texts in English, Spanish, French and German (`i18n/`), language
  negotiation and a `t()` with placeholders, plurals and a fallback to English, key by key.
- `oauth.js`: `texts` is optional. Without it the consent and error screens use the suite's texts
  in the user's or the browser's language; `createTexts({ catalogs })` overrides some keys.
- `docs/architecture.md`: the target design of the platform and the order in which it is built.
- `CONVENTIONS.md`: the rules every repository of the suite follows.
- Tests run with `node --test`.

## 0.2.1 — 2026-09-27

- License: AGPL-3.0-only. Versions up to 0.2.0 keep the MIT license they were published with.

## 0.2.0 — 2026-09-27

- `workos.js` and `workos-accounts.js`: accounts with WorkOS AuthKit (sign-up, 2FA, Google,
  single sign-on across apps) and AuthKit as the authorization server for the MCP.

## 0.1.0 — 2026-09-27

- `oauth.js`: built-in OAuth 2.1 authorization server for an app's MCP endpoint (PKCE S256, CIMD
  and dynamic registration, hashed and rotating tokens), so Claude or ChatGPT connect by pasting
  the URL.
