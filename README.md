# suite-core

suite-core is the platform Cronum Work is built on: a Node.js library, with no dependencies and no
build step, for everything an app of the suite does the same way. It signs people in (local
accounts with optional two-step verification, WorkOS AuthKit or any OpenID Connect provider), lets
AI assistants such as Claude or ChatGPT connect over the MCP with its own OAuth 2.1 server, keeps
sessions, API tokens and device tokens, translates every screen into five languages (English,
Spanish, French, German and Italian), sends live updates, Web Push and native push, stores
uploads, copies data out and back in, handles plans, billing, organizations and sharing, and serves
an admin panel and a web kit for the interface. An app hands in what is its own (its tables, texts,
pages and permissions); suite-core imports nothing from an app.

- **Zero dependencies.** Plain Node 24 (`node:sqlite`, `node:crypto`, `node:http`…) and native ES
  modules, like the apps. No build.
- **No app code.** Nothing here imports from an app. Whatever is the app's own —its database,
  users, sessions, texts, page layout— is passed in when a module is created.
- **Included as a git submodule** in each app, usually at `server/suite/`.

## How it relates to Cronum Work

[Cronum Work](https://github.com/cronumstudio/work) is the app built on suite-core: Tasks,
Projects, Next and Notes as modules of one app, with one database, one sign-in, one admin panel and
one MCP connector, mounted by suite-core's host (`createHost()`). Work and each of the four
modules include suite-core as a git submodule at `server/suite/`, pinned to a version.

## Who should use it

- **To run Cronum Work on your own server, start from the
  [work repository](https://github.com/cronumstudio/work)**, not from here: Cronum Work is what is
  self-hosted, and it brings suite-core with it.
- **Use suite-core directly if you are building on it**: changing Cronum Work or one of its
  modules, or writing an app or a module of your own on the same platform.

## Status

suite-core is at version 0.x (the version is in `package.json`, and [CHANGELOG.md](CHANGELOG.md)
says what each one changed). While it is 0.x, a minor version may change an interface and a patch
never does. Apps pin an exact version through the submodule pointer, so nothing changes under them
until they move it.

## Documents

| Document | What it says |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | The design: modules, configuration file, data model, accounts, organizations, plans, billing, the host, and the order in which it was built |
| [CONVENTIONS.md](CONVENTIONS.md) | The rules every repository of the suite follows: language, code, commits, versions, configuration, ports, tests, modules |
| [docs/web-kit.md](docs/web-kit.md) | The shared interface and how an app uses the web kit |
| [CHANGELOG.md](CHANGELOG.md) | What each version changed |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | The fonts and icons included here, and their licences |

## Development

You need Node.js 24 or later and git. There is nothing to install: suite-core has no
dependencies (and so no lockfile; `npm ci` has nothing to do), and SQLite comes with Node.

```bash
git clone https://github.com/cronumstudio/suite-core.git
cd suite-core
npm test                              # every test, with Node's own runner
node --test test/oauth.test.js        # one area
```

suite-core is a library: there is no server or compose file to start here. To see a change in a
running app, clone Cronum Work or a module with its submodules (`git clone --recurse-submodules
https://github.com/cronumstudio/work.git`), start it as its README says, and work in its
`server/suite/`, which is a checkout of this repository (see [Change it](#change-it) below).

### Configuration that matters for development

suite-core reads its configuration through the app (`config.js`): `suite.config.js` describes the
product (its id, name, colour, modules and plans; [docs/architecture.md](docs/architecture.md) §5)
and environment variables describe one install. Both are checked as a whole when the app starts:
a wrong value stops the start, saying what, and what only deserves a word is a warning in the log.
The variables are the same in every app and are listed in [CONVENTIONS.md](CONVENTIONS.md) §5;
for development these are the ones that matter:

| Variable | For development |
| --- | --- |
| `BASE_URL` | The address you open, such as `http://localhost:3463`; over plain HTTP the cookies are not Secure |
| `DATA_DIR` | Where the database and uploads go; the apps' `npm run dev` uses `data-dev/`, never the `data/` a container uses |
| `AUTH_PROVIDER` | `local` (the default): accounts with passwords here. `workos` and `oidc` need their own variables |
| `ADMIN_USER`, `ADMIN_PASSWORD` | The first administrator; without a password one is generated and printed once in the log |
| `MAIL_PROVIDER` | `log` (the default) writes every email to the server's log instead of sending it |
| `BILLING_PROVIDER` | Empty (the default): no payments |
| `HOT_RELOAD` | `true` restarts the server when `server/` changes |

`tools/conformance.js` checks a running app over HTTP; it takes `CONFORMANCE_USER` and
`CONFORMANCE_PASSWORD` for its sign-in checks.

## Modules

Each file at the repository's root is one module, next to the tools in `tools/` and the web kit in
`web/`; how they fit together is in the [architecture](docs/architecture.md).

| File | What it does |
| --- | --- |
| `oauth.js` | Built-in OAuth 2.1 authorization server for an app's MCP endpoint, so Claude or ChatGPT connect by pasting the URL |
| `oauth-page.js` | Its consent and error screens with the Cronum Studio brand, the same in every app: the yolk behind, a card with the app's icon, name and colour (`app.color`, `app.icon`), and the "by Cronum Studio" signature; light or dark as the app |
| `workos.js` | WorkOS AuthKit client: web sign-in with PKCE, sign-out, and verification of the JWTs AuthKit issues for the MCP |
| `oidc.js` | Sign-in with any OpenID Connect provider (Authentik, Keycloak, Zitadel, Google…): PKCE, state and nonce, the ID token checked, the person linked to their account by a verified email or created, and the provider's sign-out |
| `mail.js` | Outgoing mail: an SMTP client with no dependencies (TLS or STARTTLS, AUTH PLAIN or LOGIN, headers that can't be broken into), or the server's log by default; `verify()` checks the server and the account without sending, and the app does it once at the start |
| `alerts.js` | Emails to whoever runs the install when the server fails (`ALERT_EMAIL`, with `MAIL_PROVIDER=smtp`; off otherwise): an uncaught exception before the process stops (waiting 4 s at most), an unhandled rejection, 5 or more 5xx within 5 minutes, a scheduled job of the suite that threw; one per kind every 30 minutes at most, kept in `app_meta` across restarts, the next saying how many were held back; the app, version, address, kind, time and the error with a trimmed stack, and of a request only its method and route pattern, with emails, tokens and the queries of URLs taken out |
| `mail-layout.js` | The suite's emails as HTML, one layout for all of them in the product's clothes (`app.mail`: icon, colours, signature, what it is): tables and inline styles for Gmail, Outlook and Apple Mail, a phone's width and dark mode, a button drawn in VML for Outlook, every text escaped, and the plain-text part that says the same |
| `stranger-invites.js` | Invitations emailed to an address without an account: only where one can be made, from a confirmed email and to a bare address, once per address and person, 10 a day per person, 3 a month per address, `MAIL_STRANGERS_PER_DAY` (100) for the install with an alert when reached; blocked for good from the email's link (`/api/mail/unsubscribe`, a token, one-click headers) |
| `share-mail.js` | The email that tells someone a thing was offered to them (a list, a notebook, a group, a note, a place in a project), the same for every module: in their language, the module over the heading and in a card, a button to answer it; `suite.shareMail(…)`, signed by the host in a host |
| `admin-notices.js` | With `modules.notices`, notices to whoever runs the install of new accounts, purchases, renewals and ends, set in /admin › Notifications: an ntfy topic or an email address, at once, in a daily summary or not at all per group, a template per group in the admin's words with parts left out when unknown, a run of five within ten minutes gathered into one, a pause and a test. Never who: the country of an account only from Cloudflare's own addresses (`TRUST_PROXY=cloudflare`), of a payment only what its provider gives |
| `request-scope.js` | The request a piece of code runs for (`AsyncLocalStorage`), for a hook that only gets an account: every request the suite's server answers runs inside one |
| `account-mail.js` | What local accounts do by mail: confirming an email, a new password when the old one is forgotten, the admin's invitations and open sign-up — single-use links kept as hashes, a brake per address and per inbox |
| `two-factor.js` | Two-step verification for local accounts: a code from an authenticator app (TOTP, RFC 6238) after the password, or one of ten recovery codes; the secret kept encrypted with a key from the session secret, each code once, a signed five-minute challenge between the steps, and a brake per account. Asked at sign-in, on the OAuth consent screen and with a new password from a link |
| `jwt.js` | JWTs signed by a provider, checked against its published keys (RS256, ES256) with caching, issuer, audience, dates and nonce; shared by WorkOS and OIDC |
| `workos-accounts.js` | Accounts with WorkOS: the `/auth/login` and `/auth/callback` routes, the MCP metadata, and how a WorkOS account becomes a user of the app |
| `workos-security.js` | With WorkOS, the password and two-step verification from Settings: what each person is offered by how they sign in (none with Google or Apple), a new password checked against the current one, an authenticator app given to WorkOS once its first code is right, and the admin's way to take it off |
| `i18n.js` | Translations: the suite's own texts (`i18n/<lang>.json`: its screens, and the sentence of every error and field it sends), language negotiation, `t()` with placeholders, plurals and a fallback to English, `mergeCatalogs()` for what the browser gets, and `appTexts(dir)`: an app's translations on the server, the same for every app |
| `tools/web-resolve.mjs` | Lets Node load an app's browser modules in its tests: what they import from `/suite/` is found in `web/` |
| `tools/i18n.mjs` | Catalog checks for the suite and each app, merged: `app [root] [--skip <file>]` (all of them for an app, as its tests run them: flat catalogs, parity, keys in use, texts in the code and on the server), `parity [dir]` (keys, placeholders, plural forms, nothing left undone), `used <dir> <sources…>` (keys the code uses that no catalog has) and `hardcoded [--server] [--skip <file>] <sources…>` (texts for people written in the code instead of the catalogs; on the server, texts in another language) |
| `idempotency.js` | Writes that may arrive twice: the first successful answer to an `Idempotency-Key` is kept a day per account, and the same key again gets it back without the write running again (the web kit's outbox sends them); never an answer that carries a secret (`answeredOnce`: a new token, a two-step secret, recovery codes, an invitation's link), which runs again |
| `crypto.js` | Passwords in the scrypt format every app stores, token hashes, HMAC, constant-time comparison, and AES-256-GCM for what must be read back (a second step's secret) |
| `db.js` | `openDatabase()` / `wrapDatabase()`: WAL, foreign keys, `all/get/run/exec` (statements kept prepared), nested transactions, `app_meta`, `optimize()` |
| `migrate.js` | Numbered migrations per scope (`suite`, `app`), each in its own transaction; refuses gaps and newer databases |
| `http.js` | `HttpError` with codes, router, `readJson`, cookies, static files, security headers, and the check against cross-site requests (`checkOrigin`) |
| `sessions.js` | Browser sessions that live while used (with a maximum), rotated at sign-in, listed and closed per device; the session secret, never an example value |
| `rate-limit.js` | The brute-force brake kept in the database: per account, per address, the second step's codes per account, tokens, client registrations and failed device codes |
| `schema.js` | The suite's own tables as numbered migrations (scope `suite`), which bring an app's older tables to the suite's shape |
| `mcp.js` | The MCP transport (Streamable HTTP, JSON-RPC): the app hands in its tools, prompts and instructions, how a token becomes a principal, and its plan check per tool |
| `push.js` | Web Push with no dependencies (RFC 8291 encryption, RFC 8292 VAPID signature): the install's keys, one subscription per device with its language, endpoints checked before the server visits them, gone ones pruned, and `/api/push/*` with `modules.push`; for a device the app keeps itself, with no account behind it (a paired tablet), `checkSubscription()` before the app stores the browser's subscription and `sendToSubscription()` to send to it, with the same keys and checks |
| `native-push.js` | Native push with no dependencies, with `push.native`: the phone's app registers its APNs or FCM token with its device token (`/api/devices/push`, one per device, gone with it), and the same sends as Web Push reach it, straight to Apple over HTTP/2 (ES256 provider token from the .p8 key) and to FCM HTTP v1 (service account, OAuth token cached); gone tokens dropped, three refusals dropped, payloads shortened to 4 KB |
| `uploads.js` | Files people attach: the type by the first bytes (images, PDF, never SVG), streamed to `DATA_DIR/uploads` without ever leaving half a file, served with headers that keep them from running on the app's domain, and an orphan sweep that refuses when the database looks wrong; `fromUrl()` downloads one from a link as the same kind of stream, never from an address inside a network |
| `mcp-files.js` | Files an assistant attaches through the MCP: `receiveFile()`, the whole of an app's tool for a file (a link the server downloads, or a one-time upload link for an assistant that can run curl), `suite.uploadLinks` and their route `POST /api/mcp-uploads/:token` |
| `zip.js` | Zip archives with no dependencies (`node:zlib`): written to any stream an entry at a time, ZIP64 past 4 GB or 65,535 entries; read through the central directory with every entry capped at the size it declares and checked against its CRC |
| `portability.js` | Copies of the data: someone's own ("Download my data" / "Import data") and the whole install's for the admin, as a zip anyone can open, imported into another install with new ids, every reference translated, accounts mapped by email, created or left out, shares, numbers, dates and attachments kept, and a copy that isn't trusted; with `organizations`, a group's tables in the copy of every member and every group, role, waiting invitation, plan and payment in the install's; `omit` for columns that never travel |
| `tools/conformance.js` | What every app inherits, checked against a running copy over plain HTTP: security headers, `/health` and `/version`, JSON 404s on discovery paths, the MCP `401` challenge and its metadata (with `--no-mcp`, that there are none), every language saying what English says, sign-in and sign-out, the session cookie, CSRF and the brute-force brake. `node tools/conformance.js <url>` (with `CONFORMANCE_USER`/`CONFORMANCE_PASSWORD` for the sign-in checks), or `checkConformance()` from a smoke test |
| `tools/data-cli.js` | The same copies from the command line (each app's `scripts/data.js`): the whole install out, and in with emails, accounts left out and "replace" given as options |
| `live.js` | Notices for the open tabs over Server-Sent Events (`GET /api/events` with `modules.live`): `publish({ audience, data })` to the people it concerns, heartbeats, and ids so a tab that reconnects gets what it missed, or `resync` |
| `entitlements.js` | Plans and permissions: the features an app can limit, the plan catalog (validated on start), grants per user or organization with source, window and quantity, `can()` / `limit()` / `require()`, `cutoff()` for what a plan keeps some days and `countDaily()` for daily limits; `ofOrganization()` and `cutoffOrganization()`, a group's own plan for what acts for it with nobody behind (a child's device, a family's sweep) |
| `plans.js` | The plan catalogs of the hosted products, once for every app: an install names one with `PLANS=<catalog>` (`PLANS=cronum-work` for Cronum Work), and the features every app names the same (`COMMON_FEATURES`) |
| `providers.js` | The payment providers an install can name (`BILLING_PROVIDER`, `STORE_BILLING`), known only by what is registered: each reads its own variables and settings, says its price ids and creates its adapter; this copy registers Stripe and `remote` (the hosted service's own providers are registered from outside the repository), each may keep an app's price ids itself (`catalog`), and one from outside the repository registers itself before the app starts (`node --import`) |
| `billing.js` | Payments turned into grants, off unless a provider is set: the provider interface (checkout, portal, signed webhook), products tied to plans (a group's with seats, or `seats: false` for a family's plan with no cap on its members), subscriptions that hold a plan until the paid period ends, one-off purchases and passes, refunds; each event applied once and in order; another product's events kept out when the app says (`billing` in suite.config.js); with the stores, a second instance on the same tables, `GET /api/billing/overview` over both, both handed to the account deletion, and `billing.forgetOnRemove`; a group's subscriptions stopped at the end of the period paid, once each, when it is deleted or every member asks to delete their account (`billing.stopOnOrganizationDeleted`), or when the app asks (`stopOrganization`, `keepOrganization`), and never a cancellation the payer made themselves renewed again |
| `stripe.js` | Stripe as billing's provider (`BILLING_PROVIDER=stripe`): hosted Checkout and Customer Portal with plain `fetch`, the `Stripe-Signature` checked, its subscription, payment and refund events turned into grants, and a subscription stopped at the period's end or now — no SDK |
| `affiliates.js` | Referrals and creators (`affiliates` in suite.config.js, off until `enabled`): a code per account made when first asked for, creators' campaigns made in /admin › Affiliates, each a discount at the provider when its adapter can make one; who brought whom (the `cw_ref` cookie of `/r/<CODE>` or `?codigo=`, or the payment's discount), a commission on a buyer's first real payment, confirmed after `confirmDays` and reversed by a refund before; a referral's month given as a chained grant or the next renewal put off; payouts noted by the admin, a CSV; the person's panel at `/afiliados` |
| `stores.js` | Purchases in the App Store and Google Play (`STORE_BILLING`), next to the web's: the store adapter interface, an opaque id per account to buy with (`GET /api/billing/stores/customer`, never the WorkOS id), what the app may sell them, or why nothing (`GET /api/billing/stores/offer`), the store's webhook as a trigger to read the customer again, `POST /api/billing/stores/sync` after a purchase, and what moved away or was refunded taken back |
| `accounts.js` | The people who can sign in: the `users` table in the suite's shape, creation with the app's own columns, sign-in that refuses disabled accounts and redoes old hashes, rules that hold whoever calls (never without an administrator; disabling or a new password ends sessions), and their identities at other providers (WorkOS, OIDC…) |
| `tokens.js` | API tokens for the MCP and scripts: shown once and kept as hashes, with scopes and optional expiry; takes over the apps' `mcp_tokens` without breaking a connector |
| `devices.js` | Device tokens, with `modules.devices`: an app on a phone connected through the system browser with PKCE (a code of five minutes for the signed-in person, sent back to an address in `devices.redirectUris`, exchanged with its verifier), a token with its own prefix kept as a hash, revoked from Settings, by the device or by the admin's sign-out everywhere, ended after `devices.idleDays` unused; no route of the suite takes one (except, with `stores.devices`, the store routes and the overview, and the device's own routes: signing out, its web session, its push token and `POST /api/devices/actions`, where a notification's buttons act through the app's or a module's `deviceActions` without opening the app), and the app accepts it where it chooses (`authenticate(req)`) |
| `organizations.js` | Groups that share data, roles and a plan (a household, a school, a team): memberships, roles in order of power plus the app's own, invitation links, seats from a grant's quantity (none when the product says `seats: false`), taken by every member or only by the roles the app names (`seatRoles`), a hand-over when someone's account goes, or (`handOver`) when someone leaves one group by an import that replaces what they have, both with one heir rule (`heirOf`), kinds an app manages itself (`organizations.kinds`: the generic routes refuse them, a cap per person, deleted rather than archived when the last member goes, the app's hooks inside the transaction) and the clean-up of used and expired invitations |
| `app-links.js` | Links to the site that open the app on a phone (`appLinks`): `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`, with the install's `APPLE_TEAM_ID` and `ANDROID_CERT_SHA256`; the APIs, sign-in, OAuth, MCP, admin, the phone's connect pages and a checkout's way back never open it |
| `audit.js` | Who did what, when and from where — never what anybody wrote |
| `config.js` | The app's configuration: `suite.config.js` (the product) and the environment (the install), checked as a whole — anything unknown or wrong stops the start, saying what |
| `legacy-domains.js` | The apps' old addresses, answered by a host for a while after they move in (`LEGACY_DOMAINS`): a service worker that removes itself, their pages sent to the module, and `/mcp` pointing at the host's |
| `host.js` | `createHost()`: several apps as one, each a module at its own path (`/tasks/`, `/notes/`…) with one database, one session, one sign-in and one admin panel; `joinHost()` lets an app's `platform.js` join a host that is loading it, and on its own changes nothing |
| `app.js` | `createSuite()` wires every module from the configuration (database and migrations, sessions, accounts, tokens, audit, brake, plans, organizations, billing, WorkOS, OAuth); `createApp()` serves the suite's routes, its browser code and admin panel, the MCP endpoint, the app's routes and static files, in the order the apps learned, with clean-ups, hot reload and an orderly shutdown |
| `watcher.js` | Hot reload by polling (`HOT_RELOAD=true`) for code mounted over SMB, the submodule included |
| `api.js` | The common REST routes on the app's router: `/api/auth/*` (sign-in and out, in two steps when the person turned it on, a forgotten password, confirming an email, sign-up), `/api/me/*` (sessions, plan, tokens, connected apps, password, two-step verification), `/api/admin/*` (accounts, plans and grants, organizations, audit) and `/api/orgs/*` (people's own groups) |
| `revoke.js` | Everything that lets someone in, ended at once —browser sessions, API tokens, assistants' grants and phones—: what a new password, a password reset and the admin's "sign out everywhere" all call, so none of them closes only a part |
| `workos-events.js` | With WorkOS, a password reset on AuthKit's own page, heard from WorkOS's Events API every minute (`password_reset.succeeded`): everything that let that account in here is ended (`revoke.js`) |
| `account-deletion.js` | Deleting one's own account (the GDPR's right to erasure): disabled at once —sessions, devices, tokens and connected assistants stop— and kept `accounts.deletionDays` (30) days, in which signing in again offers it back; then it goes, at the providers first where the install says so, and every app hands over what others share with the person |
| `prefs.js` | A person's preferences: one JSON object in `users.prefs`, shared by every module of the row; each module declares only its own keys (`createApp({ prefs })`, or `createModule().prefs` in a host) |
| `time.js` | Whose "today" it is: the zone of whoever asks (`prefs.tz`, the zone their browser reported), for every request and MCP tool (`inZoneOf`, `todayFor`); what runs on its own uses the server's `TZ` |
| `dates.js` | Dates as people say them to an assistant ("tomorrow", "next friday", "24.12.", "in 2 months") turned into `YYYY-MM-DD`, in English, Spanish, French and German at once; a day that doesn't exist is an error the assistant reads, never rolled into the next month |
| `resolve.js` | Loose name resolution for every module's MCP tools: "the shopping" becomes the list it means, and with more than one reasonable candidate a `ResolveError` with the options, so the assistant asks |
| `mcp-kit.js` | What every module's MCP tools are written with: the `text` result, the `S` schema helpers, the `READS`, `ADDS`, `SETS` and `DESTRUCTIVE` annotations, `describeErrorWith()`, and the measures that keep `tools/list` small (`trimRepeats`, `toolsListSize`) |
| `sharing.js` | Sharing something with someone, the same in every module: offered to read or to edit, and theirs only once they accept; only its owner offers, changes and takes it back, and whoever it was offered to may decline it or later leave it |
| `share-brake.js` | The brake on invitations for `sharing.js`: how many offers one person may make in an hour (then 429 `share_limit`), and one notice per sender and recipient a day, however often an offer is made again |
| `ownership.js` | Whose something is, the same in every module: what only its owner may do with it (delete it, purge it, move it into something of one's own) answers 403 `not_yours` to whoever else edits it, who gets a copy when they move it away |
| `public-page.js` | A read-only public link that the owner of something (a list, a note, a project) turns on, the same in every module: the mechanics once, each module saying what it publishes and what the page shows (`web/public-page.js`, `web/public-page.css`) |
| `storage.js` | The storage a plan allows (`storage.mb`), checked the same way in every app: past it, 402 `plan_limit` with what the plan allows and what is used; who pays for a file is the app's rule (`payer`) |
| `usage.js` | What each person uses: how much they keep in each module, how close that is to their plan's caps, their storage and their assistants' calls; in /admin › Users and in Settings › Plan (`GET /api/me/usage`) |
| `links.js` | Links between the modules of a host (a step of Next linked with a task of Tasks, a note with a phase of Projects): each module says what can be linked of it and how it shows; with the host's MCP tools `<host>_linked_items` and `<host>_link_item` |
| `calendar.js` | The host's calendar: what has a date in each module, by day, on one page of the host's own, read-only (each thing opens in its module); with the host's MCP tool `<host>_calendar` |
| `calendar-feed.js` | The host's calendar as a subscription link of each person's own (`/api/calendar/feed/<token>.ics`, iCalendar, RFC 5545) for Google Calendar, Outlook or Apple Calendar; made again, the old address stops answering |
| `day.js` | The host's daily summary: in the morning what someone has for today in every module they use, in the evening what they did (`GET /api/day`), and two notices a day at the times they choose |
| `host-worker.js` | A host's one service worker, at `/sw.js` with the scope `/`: it keeps the host's pages and every module's shell, shows every notice as the host's and opens the module it came from |
| `scope-css.js` | A module's stylesheet scoped to its windows (`@scope`), so several modules live in one page (the host's one-document shell) without their classes and variables colliding |
| `page-hints.js` | What a module's page asks for as soon as it starts, named in the page's own answer (a `Link` header), so the browser asks for all of it at once |
| `runtime.js` | What an app on its own (`createApp()`) and a host (`createHost()`) run the same way: the HTTP server around their handler, the jobs every install has, the process signals |
| `device-pages.js` | The suite's pages for an app on a phone (`devices.js`), each behind an option of `devices` that is off by default: `/devices/connect`, where a signed-in account allows a phone and the app gets its code |
| `tools/test-kit.mjs` | What every app's tests start a server and talk to it with: a harness, `startApp()` on a temporary database and free ports, HTTP, MCP and live-channel clients with a deadline per request, and fakes of the WorkOS and Paddle APIs |
| `web/` | The web kit, served at `/suite/` with no build ([docs/web-kit.md](docs/web-kit.md)): the shared interface with the Cronum Studio brand —the app's frame with a sidebar that folds away (`shell.js`), sign-in (`signin.js`), Settings (`settings.js`) with the plan and its payments (`plan.js`), dialogs, menus, notices and icons (`ui.js`, `icons.js`), `tokens.css` and `kit.css` with each product's accent and the brand's fonts—; `el()` and DOM helpers that never assemble HTML, `t()` in the browser, `api` with errors in words; the new-version notice (`update.js`), the live channel (`live.js`), offline writes in IndexedDB with idempotency keys (`local.js`, `outbox.js`), Markdown drawn without HTML (`markdown.js`), drag and drop between a list and the sidebar (`drag.js`), a finger across a row of a list (`swipe.js`), the celebration when something is done (`celebrate.js`), Settings › Sharing, all one shares and all shared with one (`shared.js`), the people one already shares with as chips in a share dialog (`people.js`), the service worker (`sw-core.js`), a device's push subscription for an app's own route when there is no account (`push.js`), QR codes (`qr.js`) and `oauth.css` for the OAuth screens |
| `brand.js` | What the suite's own screens share of the Cronum Studio brand: the product's colour as the accent, the text that reads on it, and the "by Cronum Studio" signature |
| `web/admin.html` | The admin panel at `/admin`, in the app's colour and with its icon and the signature, built on the kit and `/api/admin/*`: accounts (role, plan, extras, password, sessions, two-step verification, removal), invitations with their link, what each plan allows, organizations when they are on, and the activity log |

## Using it in an app

### Add it

```bash
git submodule add https://github.com/cronumstudio/suite-core.git server/suite
git -C server/suite checkout vX.Y.Z      # a version from CHANGELOG.md
git add .gitmodules server/suite
```

Whoever clones the app needs `git clone --recursive`, or `git submodule update --init` after
cloning. GitHub's *Download ZIP* does not include submodules. In CI, `actions/checkout` needs
`submodules: true`. On a server that deploys with `git pull`, set
`git config submodule.recurse true` once, so pulls update it too.

### Update it

```bash
git -C server/suite fetch --tags
git -C server/suite checkout vX.Y.Z
git add server/suite
git commit -m "Suite: update suite-core to vX.Y.Z"
```

Read the CHANGELOG from the version the app had: every suite migration since then runs on the
app's database at its next start, and there is no way back. Then run the app's own tests.

### Change it

Changes are made here, never inside an app's copy. From an app, `server/suite` is a checkout of
this repository: make a branch, edit, test (`npm test` here), and open a pull request here; once
it is merged and tagged, commit the new pointer in the app. Every other app picks the change up
with the update steps above.

## `oauth.js`

```js
import { OAUTH_SCHEMA, createOAuthServer } from './suite/oauth.js';

db.exec(OAUTH_SCHEMA);  // three tables, idempotent

export const oauth = createOAuthServer({
  baseUrl: process.env.BASE_URL,        // public URL: the issuer; BASE_URL/mcp is the resource
  appName: 'Next',
  enabled: process.env.MCP_OAUTH !== 'off',
  db: { all, get, run },                // run() returns { changes, lastInsertRowid }
  users: {
    login(username, password),          // → user | null
    fromRequest(req),                   // user of the browser session, or null
    byId(id),                           // → user | null
    handle(user),                       // how the consent screen names them, e.g. "@ana"
  },
  sessions: {
    open(res, userId),                  // opens a browser session (sets the cookie)
    tokenFrom(req),                     // the session token of the request, or null
    sign(value),                        // keyed signature, for the consent CSRF
  },
  limits: {
    checkLogin(req, name), loginFailed(req, name), loginSucceeded(req, name),
    allowRegistration(req),             // → { allowed, retryAfter? } for dynamic registration
  },
  texts: (req, user) => ({ lang, t }),  // optional: the suite's own texts by default (below)
  page: ({ lang, title, body, theme }) => html,   // brandedPage(config.app) from oauth-page.js
  secondStep: {                         // optional: a code after the password (two-factor.js)
    required(user),                     // → whether this person turned it on
    challengeFor(userId),               // → a signed challenge for the screen that asks for the code
    userOf(challenge),                  // → who passed the password, or null
    pass(req, userId, code),            // throws an HttpError: code_invalid, too_many_attempts
  },
});
```

`createSuite()` passes `secondStep` itself with local accounts: whoever turned two-step
verification on is asked for the code after the password, and gets the browser session and the
permission only with it.

Then, in the app:

- `await oauth.handle(req, res, url)` in the HTTP server, before anything else that could answer
  `/oauth/…` or `/.well-known/…`. It returns `false` for paths that aren't its own.
- On the MCP endpoint: `oauth.userFromAccessToken(token)` for the user of a token, and a `401`
  with `WWW-Authenticate: oauth.challenge(hadToken)` when there is none.
- In the app's settings: `oauth.grantsOf(userId)` and `oauth.revokeGrant(grantId, userId)`.
- `oauth.forgetUser(userId)` when an account is deleted, and `oauth.purge()` every hour.

The consent and error screens bring their own texts, in every language of the suite (`i18n/`),
and speak the user's language (their choice, else the browser's, else English). An app that wants
its own words passes `texts`; to change only some keys — usually `oauth.wants`, which says what
the assistant will be able to do — it builds them with `createTexts` from `i18n.js`:

```js
import { createTexts } from './suite/i18n.js';

texts: createTexts({ catalogs: {
  en: { 'oauth.wants': '{client} wants to use your lists: see them, add and change tasks.' },
  es: { 'oauth.wants': '{client} quiere usar tus listas: verlas, añadir y cambiar tareas.' },
} }),
```

The keys are `oauth.connectTitle`, `wants`, `unverified`, `returnTo`, `loopback`, `signedInAs`,
`username`, `password`, `allow`, `signInAndAllow`, `cancel`, `cannotConnect`, `goBack`,
`badCredentials`, `tooManyAttempts`, the second step's `code`, `codeHint`, `verifyAndAllow`,
`badCode` and `signInAgain`, and `oauth.error.<code>` for every code of `OAuthScreenError`. Their markup
uses the classes `oauth__text`, `oauth__note`, `oauth__warning`, `oauth__error`,
`oauth__form`, `oauth__actions`, `field`, `btn` and `btn--primary`.

`createSuite()` dresses the screens with `oauth-page.js`: the Cronum Studio yolk behind (a glow
over ink in the dark theme), a card with the app's icon (`app.icon`, `/icons/favicon.svg` by
default), its name and its colour on the main button (`app.color`), and the "by Cronum Studio"
signature under it. The page follows the person's theme: their own choice when they are signed in,
else the one the app saved in the browser (`<app id>.theme` in `localStorage`), else the
system's. Its styles are `web/oauth.css` and nothing comes from elsewhere. An app that wants its
own page still passes `hooks.oauthPage`.

What it implements and why is explained at the top of `oauth.js`.

## `workos.js` and `workos-accounts.js`

For a hosted service, people sign up and sign in on WorkOS AuthKit (sign-up, 2FA, Google,
recovery) and AuthKit is also the authorization server for the MCP. The app keeps its session
cookie and a `users` row per person, with the WorkOS id next to it.

```js
import { createWorkosClient, workosConfigFromEnv, WorkosUnavailable } from './suite/workos.js';
import { createWorkosAccounts } from './suite/workos-accounts.js';

const config = workosConfigFromEnv();   // AUTH_PROVIDER, WORKOS_API_KEY, WORKOS_CLIENT_ID,
                                        // WORKOS_AUTHKIT_DOMAIN, WORKOS_MCP_AUDIENCE, WORKOS_API_URL
const workos = createWorkosClient(config);
if (config.enabled && workos.missingConfig().length) process.exit(1);   // say which ones

const accounts = createWorkosAccounts({
  baseUrl: process.env.BASE_URL,
  appName: 'Next',
  workos,
  adminEmail: process.env.ADMIN_EMAIL,  // this verified email administers
  secureCookies: true,
  stateCookie: 'next_auth',             // state and PKCE verifier, Path=/auth, 30 min: next_auth_<state> per sign-in
  users: {
    byWorkosId(id), unlinkedByEmail(email), firstUnlinkedAdmin(),   // → user | null
    link(userId, { workosId, email }), setEmail(userId, email),
    usernameTaken(name),                                             // → boolean
    create({ username, displayName, role, email, workosId }),        // → user
  },
  sessions: { open(res, userId, { workosSessionId }) },
  mcp: true,                            // false: an app without an MCP serves no /.well-known/…
});
```

Then, in the app:

- `await accounts.handle(req, res, url)` before other routes: `/auth/login` (`?signup=1` for
  the sign-up screen), `/auth/callback` and, unless `mcp: false`, the `/.well-known/…` metadata.
  A failed return goes to `/?auth_error=failed` or `/?auth_error=unavailable`.
- On the MCP endpoint: `await accounts.userFromToken(token)` and `accounts.challenge(hadToken)`
  for the `401`. `WorkosUnavailable` means the token couldn't be checked: answer `503`, not `401`.
- On sign-out, keep the AuthKit session id stored with the app's session and send the browser to
  `accounts.signOutUrl(id)`.
- Close password sign-in and password changes while `config.enabled`.

Account policy: an existing user is linked only through a **verified** email; `adminEmail`
takes over the first admin not yet linked; anyone else gets a new account, also when their first
contact is connecting an AI client. The users table needs a unique index on the WorkOS id.

## `portability.js`: copies of the data

An app says what its data is, and `createApp({ …, portable })` gives people Settings → "Download
my data" / "Import data" (`/api/me/export`, `/api/me/import`), the admin a copy of the whole
install and its import (`/admin` → Data, `/api/admin/export`, `/api/admin/import`), and the app
a command line with `tools/data-cli.js`.

```js
export const DATA = {
  tables: {                                   // in the order their rows are created
    list_groups: { refs: { user_id: 'users' } },
    lists: { refs: { owner_id: 'users', group_id: 'list_groups' },
             limits: { name: 80, color: /^#[0-9a-f]{6}$/i } },   // what the app's screens accept
    tasks: { refs: { list_id: 'lists', parent_id: 'tasks', created_by: 'users' } },
    task_files: { refs: { task_id: 'tasks', user_id: 'users' },
                  file: { path: 'path', folder: 'user_id', feature: 'attachments' } },
  },
  users: { columns: ['avatar_color'], limits: { avatar_color: /^#[0-9a-f]{6}$/i },
           prefs: (prefs, { ids, current }) => ({ … }) },
  check({ user, counts, replaced }) { … },   // the plan's limits, for someone's own import
};
```

- A row belongs to someone's copy when every NOT NULL reference points at something in it; an
  optional one pointing outside is emptied. So a person's copy takes their lists with everything
  in them and leaves what is shared with other people, counted in the manifest (`left_out`).
- References to a later table or the same one (a tree, Next's branches and entries) must allow
  NULL: they are set once every row exists. Every table needs a NOT NULL reference to `users`, to
  `organizations` or to an earlier table.
- Importing gives every row a new id and translates every reference; accounts go where the
  admin says (the one here with the same email, a new one, or none), and an existing one takes
  the copy's preferences but keeps its username, email and role. `prefs` translates the ids the
  app keeps in its preferences. `clean(values, { mode, organizations })` may change a row as it
  comes in. Passwords, second steps, sessions, tokens, OAuth grants and push subscriptions never
  travel.
- A copy is not trusted: only columns this install has, plain values, references inside the
  file, attachments that are images or PDF by their first bytes, one apply per copy
  (`data_imports`), and ceilings by who imports it. Someone's own copy has at most 64 MB of data,
  32 MB per file, 2 million values counted before parsing, 64 kB of preferences, 20,000
  attachments, 100 organizations, and no more bytes of them on disk than about twice the upload.
  It can be opened or applied 10 times every 15 minutes (`rateLimits.importTo`). The admin and the
  command line have higher ceilings. `createApp` passes none of them, so these defaults hold. Zips
  whose entries share their bytes are refused.
- `limits` keep what a copy brings within what the app's screens accept. A number is the most
  characters, and longer text is cut there. A pattern is the shape, and a value without it is left
  out (the column's default, or what the profile had). Text without a limit is cut at 100,000
  characters.
- Someone's own copy, its plan and "replace" read only the rows near that account. Their cost
  follows that person's data, not the whole install's.
- **`omit`**: columns that never reach any copy (a device's key hash, its push subscription). An
  import writes the column's default or NULL; `omit: { token_hash: (row) => … }` gives a plain value
  or a function of the row instead, its references already translated. `null` there, or a function
  that answers `undefined` or `null`, means the column's own default, never a NULL written over it.
  A copy that brings an omitted column anyway has it dropped. The start refuses an omitted column
  that is NOT NULL without a default of either kind, a reference, a file's or the key.

**A group's data** (with `modules.organizations`, v0.84.0): a table that points at `organizations`
belongs to a group, and so does every table that chains to it. The shape of an app for families:

```js
export const DATA = {
  tables: {
    family_groups: { refs: { organization_id: 'organizations' }, onePerOrganization: true,
                     // the anchor the app keeps, never a reference a copy decides by
                     omit: { owner_user_id: (row) => oldestOwner(row.organization_id) } },
    family_people: { refs: { family_id: 'family_groups', user_id: 'users' } },
    family_devices: { refs: { family_id: 'family_groups', person_id: 'family_people' },
                      omit: { token_hash: (row) => unusableHash(), push_endpoint: null, push_p256dh: null, push_auth: null } },
  },
  organizations: {
    copyKinds: ['family'],      // whose rows someone's copy takes (left out: every kind)
    copyRoles: null,            // which members' copies carry the group (left out: every member)
    mapOntoOwn: ['family'],     // someone's import goes into the family they own or administer here
  },
};
// "Replace" taking them out of a family others share: told once, by createSuite's onMemberRemoved
// (reason 'handed_over'), as every member who goes.
```

- **Someone's copy** takes each group they are in (of `copyKinds`, where their role is one of
  `copyRoles`, which must be roles of the install; archived ones too, marked so). These are the
  declaration's names, apart from suite.config.js's `organizations.kinds` (each kind's rules) and
  `organizations.roles`; a kind is written by one rule, `KIND_NAME` in organizations.js. It takes
  its name, kind, settings and branding, their own membership (never the others') and every row of
  the group. A row with a NOT NULL reference to another member is left out, counted in `left_out`;
  an optional one is emptied, as before. It brings no plan or invitation, and never says which install it is.
- **The whole install's copy** takes every group, archived ones too, every membership, the
  invitations still waiting (by their hash, so the links people hold still open the group), the
  groups' grants and who pays for them (`subject_type: 'organization'` in `suite/grants.json` and
  `suite/billing.json`), so a renewal finds the family under its new id. Its manifest says which
  install it is (`source.install`, a random id kept in `app_meta`) and which export run
  (`source.export`): one id per run, which a host's other modules exported with it share
  (`prepareExport({ run })`, the admin export's `?run=`, the command line's `--run`).
- **Importing someone's copy**: each group goes into the oldest one of the same kind they own or
  administer here when `mapOntoOwn` names the kind (never an archived one), else into a new one
  with them as its owner, made quietly (no app welcome, no trial), with a slug made from its name
  and today's date: nothing the file says finds or names a group here. `clean`'s and `check`'s
  `organizations` is `{ created, mapped }`, the ids here of the groups made and of those found.
- **A group's one row** (`onePerOrganization: true`, for a table whose NOT NULL reference to
  organizations is UNIQUE, as the example's `family_groups.organization_id` is): when the group a row
  goes into has its row already, the copy's isn't written again; it is that row, what points at it
  comes into it, and the result counts it under `merged`. Without it, someone's copy put into their
  own family could only be refused by the UNIQUE.
- **Importing a whole install**: every group comes back as it was, with its slug, dates, roles (one
  this install doesn't have becomes `member`), its invitations, plans and payments, all under its id
  here: a renewal that names the old id finds the group by its customer. **An install comes here by
  one export run.** Each group the import makes is recorded with where it came from (that install's
  id, its id there, and the run). The other modules' copies of the same run —a host moving one
  module at a time— find those groups by that record alone and bring only their own rows: the
  members, invitations, plans and payments came with the first copy, and so did the accounts'.
  What a later copy of the run is the first to bring (an account the first left out, and a group
  only it had) comes whole, with its plans, payers and memberships.
  A copy of another run of an install already brought here (a trial move, then the real one) is
  refused before anything is written, 409 `import_install_again`, in the plan and on apply: a later
  copy merged into what an earlier one made would bring back who left, plans revoked since, and an
  end a file says. Moving again is moving into a fresh install (or bringing people's own copies).
  The run is checked again inside the import's transaction, so two imports racing (two modules,
  the command line) can't both come in. A whole install's copy with groups that doesn't say which
  install it is from is refused, 400 `import_install_unnamed`.
  A slug, a kind and a date like a group's here find nothing. A group whose every member is left
  out goes with them; one left without an owner gets its heir (`organizations.heirOf`) as owner.
- **Kinds** are written by one rule (`KIND_NAME`): `organizations.create` (and `POST /api/orgs`)
  refuses another with 400 `field_invalid` (`field: 'kind'`), and a copy's kind written otherwise
  (a group made before the rule) comes in as none: never made into another kind ("Family" isn't
  `family`), never a reason to refuse the copy.
- **"Replace"** and **erasing one's data** empty what is the person's alone: their rows and those
  of groups nobody else is in, archived ones too (the organization and its plan stay). A group
  others share is never emptied: erasing leaves it whole, and "replace" hands it over (the core's
  `organizations.handOver`, in one transaction: the heir when they were its last owner, the app told
  once by `whenMemberRemoved` with reason `handed_over`, and their membership goes), as account
  deletion does. A membership a copy brings meets the install's `maxPerUser`: past it, 409
  `organization_limit`, and nothing of the copy comes in. Someone's own "replace" does that only with the groups they
  were shown: the plan names them (`hand_over`), Settings shows them and asks again with them, and
  `POST /api/me/import/:id` with `replace: true` takes their ids back (`hand_over: [ids]`). When the
  groups they share are no longer those —someone joined one, or the others left one, which would
  then be emptied— it answers 409 `import_hand_over` with the groups as they are now
  (`organizations: [{ id, name }]`), and nothing changes. The administrator's plan says, for each
  account here, which groups "replace" would take it out of (`targets[].hand_over`), and the admin
  panel names them under the choice and in its confirmation.
- With neither `organizations` nor a table that points at them, nothing of organizations travels
  and a copy that has them is refused (`unknown_table`), as a core before 0.84.0 does.

```bash
node scripts/data.js export copy.zip [--account ana]
node scripts/data.js import copy.zip --email ana=ana@example.com --skip tests          # what it would do
node scripts/data.js import copy.zip --email ana=ana@example.com --skip tests --apply  # doing it
```

## Tests

```bash
npm test
```

Runs every file in `test/` with Node's own test runner (`node --test`): over a thousand tests,
with nothing to install and nothing outside the machine. Each area works on an in-memory or
temporary database with fake users, sessions and outside services, and the areas that need one
start a real server on a free port. No app is needed around it. Every app runs the same checks of
its own through `tools/test-kit.mjs`, `tools/conformance.js` and `tools/i18n.mjs`.

## Contributing, security and the CLA

- **Contributing**: see the organization's
  [CONTRIBUTING.md](https://github.com/cronumstudio/.github/blob/main/CONTRIBUTING.md) and the
  rules in [CONVENTIONS.md](CONVENTIONS.md). A change comes with its tests, and `npm test` passes.
- **Contributor License Agreement**: a pull request is merged once its authors have signed the
  [CLA](https://github.com/cronumstudio/.github/blob/main/CLA.md); the CLA check on the pull
  request says how, with a comment.
- **Security**: please report a vulnerability privately, as
  [SECURITY.md](https://github.com/cronumstudio/.github/blob/main/SECURITY.md) explains, and never
  in a public issue.

## License

Licensed under the GNU Affero General Public License v3.0 only (see [LICENSE](LICENSE)).
Copyright (C) 2026 Cronum Studio.
The Cronum names and logos are not covered by this licence; see
https://github.com/cronumstudio/.github/blob/main/TRADEMARKS.md

The fonts and icons included from other projects keep their own licences: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Versions up to v0.2.0 were published under the MIT License.
