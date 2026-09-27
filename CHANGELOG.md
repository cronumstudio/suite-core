# Changelog

Versions follow [semantic versioning](https://semver.org/); while in `0.x`, a minor version may
change an interface and a patch never does. Apps pin a version through the submodule pointer.

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
