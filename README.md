# suite-core

The platform shared by the self-hosted apps of the Cronum Studio suite (Tasks, Projects, Next,
Focus, Tracker). Each app is independent and can be installed on its own, but they all sign people
in, connect AI clients, translate, sync and charge the same way; that shared part lives here, once.

- **Zero dependencies.** Plain Node 24 (`node:crypto`, `node:dns`, `node:net`) and native ES
  modules, like the apps. No build.
- **No app code.** Nothing here imports from an app. Whatever is the app's own —its database,
  users, sessions, texts, page layout— is passed in when a module is created.
- **Included as a git submodule** in each app, usually at `server/suite/`.

| Document | What it says |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | The target design: modules, configuration file, data model, accounts, organizations, plans, billing, and the order in which it is built |
| [CONVENTIONS.md](CONVENTIONS.md) | The rules every repository of the suite follows: language, code, commits, versions, configuration, ports, tests |
| [docs/web-kit.md](docs/web-kit.md) | The shared interface and how an app uses the web kit |
| [CHANGELOG.md](CHANGELOG.md) | What each version changed |

## Modules

Today's modules are below; the planned ones, and their order, are in the architecture.


| File | What it does |
| --- | --- |
| `oauth.js` | Built-in OAuth 2.1 authorization server for an app's MCP endpoint, so Claude or ChatGPT connect by pasting the URL |
| `oauth-page.js` | Its consent and error screens with the Cronum Studio brand, the same in every app: the yolk behind, a card with the app's icon, name and colour (`app.color`, `app.icon`), and the "by Cronum Studio" signature; light or dark as the app |
| `workos.js` | WorkOS AuthKit client: web sign-in with PKCE, sign-out, and verification of the JWTs AuthKit issues for the MCP |
| `oidc.js` | Sign-in with any OpenID Connect provider (Authentik, Keycloak, Zitadel, Google…): PKCE, state and nonce, the ID token checked, the person linked to their account by a verified email or created, and the provider's sign-out |
| `mail.js` | Outgoing mail: an SMTP client with no dependencies (TLS or STARTTLS, AUTH PLAIN or LOGIN, headers that can't be broken into), or the server's log by default; `verify()` checks the server and the account without sending, and the app does it once at the start |
| `account-mail.js` | What local accounts do by mail: confirming an email, a new password when the old one is forgotten, the admin's invitations and open sign-up — single-use links kept as hashes, a brake per address and per inbox |
| `two-factor.js` | Two-step verification for local accounts: a code from an authenticator app (TOTP, RFC 6238) after the password, or one of ten recovery codes; the secret kept encrypted with a key from the session secret, each code once, a signed five-minute challenge between the steps, and a brake per account. Asked at sign-in, on the OAuth consent screen and with a new password from a link |
| `jwt.js` | JWTs signed by a provider, checked against its published keys (RS256, ES256) with caching, issuer, audience, dates and nonce; shared by WorkOS and OIDC |
| `workos-accounts.js` | Accounts with WorkOS: the `/auth/login` and `/auth/callback` routes, the MCP metadata, and how a WorkOS account becomes a user of the app |
| `i18n.js` | Translations: the suite's own texts (`i18n/<lang>.json`: its screens, and the sentence of every error and field it sends), language negotiation, `t()` with placeholders, plurals and a fallback to English, `mergeCatalogs()` for what the browser gets, and `appTexts(dir)`: an app's translations on the server, the same for every app |
| `tools/web-resolve.mjs` | Lets Node load an app's browser modules in its tests: what they import from `/suite/` is found in `web/` |
| `tools/i18n.mjs` | Catalog checks for the suite and each app, merged: `app [root] [--skip <file>]` (all of them for an app, as its tests run them: flat catalogs, parity, keys in use, texts in the code and on the server), `parity [dir]` (keys, placeholders, plural forms, nothing left undone), `used <dir> <sources…>` (keys the code uses that no catalog has) and `hardcoded [--server] [--skip <file>] <sources…>` (texts for people written in the code instead of the catalogs; on the server, texts in another language) |
| `idempotency.js` | Writes that may arrive twice: the first successful answer to an `Idempotency-Key` is kept a day per account, and the same key again gets it back without the write running again (the web kit's outbox sends them) |
| `crypto.js` | Passwords in the scrypt format every app stores, token hashes, HMAC, constant-time comparison, and AES-256-GCM for what must be read back (a second step's secret) |
| `db.js` | `openDatabase()` / `wrapDatabase()`: WAL, foreign keys, `all/get/run/exec`, nested transactions, `app_meta` |
| `migrate.js` | Numbered migrations per scope (`suite`, `app`), each in its own transaction; refuses gaps and newer databases |
| `http.js` | `HttpError` with codes, router, `readJson`, cookies, static files, security headers, and the check against cross-site requests (`checkOrigin`) |
| `sessions.js` | Browser sessions that live while used (with a maximum), rotated at sign-in, listed and closed per device; the session secret, never an example value |
| `rate-limit.js` | The brute-force brake kept in the database: per account, per address, the second step's codes per account, tokens and client registrations |
| `schema.js` | The suite's own tables as numbered migrations (scope `suite`), which bring an app's older tables to the suite's shape |
| `mcp.js` | The MCP transport (Streamable HTTP, JSON-RPC): the app hands in its tools, prompts and instructions, how a token becomes a principal, and its plan check per tool |
| `push.js` | Web Push with no dependencies (RFC 8291 encryption, RFC 8292 VAPID signature): the install's keys, one subscription per device with its language, endpoints checked before the server visits them, gone ones pruned, and `/api/push/*` with `modules.push` |
| `uploads.js` | Files people attach: the type by the first bytes (images, PDF, never SVG), streamed to `DATA_DIR/uploads` without ever leaving half a file, served with headers that keep them from running on the app's domain, and an orphan sweep that refuses when the database looks wrong |
| `zip.js` | Zip archives with no dependencies (`node:zlib`): written to any stream an entry at a time, ZIP64 past 4 GB or 65,535 entries; read through the central directory with every entry capped at the size it declares and checked against its CRC |
| `portability.js` | Copies of the data: someone's own ("Download my data" / "Import data") and the whole install's for the admin, as a zip anyone can open, imported into another install with new ids, every reference translated, accounts mapped by email, created or left out, shares, numbers, dates and attachments kept, and a copy that isn't trusted |
| `tools/conformance.js` | What every app inherits, checked against a running copy over plain HTTP: security headers, `/health` and `/version`, JSON 404s on discovery paths, the MCP `401` challenge and its metadata, every language saying what English says, sign-in and sign-out, the session cookie, CSRF and the brute-force brake. `node tools/conformance.js <url>` (with `CONFORMANCE_USER`/`CONFORMANCE_PASSWORD` for the sign-in checks), or `checkConformance()` from a smoke test |
| `tools/data-cli.js` | The same copies from the command line (each app's `scripts/data.js`): the whole install out, and in with emails, accounts left out and "replace" given as options |
| `live.js` | Notices for the open tabs over Server-Sent Events (`GET /api/events` with `modules.live`): `publish({ audience, data })` to the people it concerns, heartbeats, and ids so a tab that reconnects gets what it missed, or `resync` |
| `entitlements.js` | Plans and permissions: the features an app can limit, the plan catalog (validated on start), grants per user or organization with source, window and quantity, and `can()` / `limit()` / `require()` |
| `billing.js` | Payments turned into grants, off unless a provider is set: the provider interface (checkout, portal, signed webhook), products tied to plans, subscriptions that hold a plan until the paid period ends, one-off purchases and passes, refunds; each event applied once and in order |
| `stripe.js` | Stripe as billing's provider (`BILLING_PROVIDER=stripe`): hosted Checkout and Customer Portal with plain `fetch`, the `Stripe-Signature` checked, and its subscription, payment and refund events turned into grants — no SDK |
| `paddle.js` | Paddle Billing as billing's provider (`BILLING_PROVIDER=paddle`), a merchant of record: a transaction per checkout, paid on a page with Paddle.js, the customer portal, the `Paddle-Signature` checked, and its subscription, transaction and refund events turned into grants for whoever the WorkOS id says, in every app — no SDK |
| `accounts.js` | The people who can sign in: the `users` table in the suite's shape, creation with the app's own columns, sign-in that refuses disabled accounts and redoes old hashes, rules that hold whoever calls (never without an administrator; disabling or a new password ends sessions), and their identities at other providers (WorkOS, OIDC…) |
| `tokens.js` | API tokens for the MCP and scripts: shown once and kept as hashes, with scopes and optional expiry; takes over the apps' `mcp_tokens` without breaking a connector |
| `organizations.js` | Groups that share data, roles and a plan (a household, a school, a team): memberships, roles in order of power plus the app's own, invitation links, seats from a grant's quantity, and a hand-over when someone's account goes |
| `audit.js` | Who did what, when and from where — never what anybody wrote |
| `config.js` | The app's configuration: `suite.config.js` (the product) and the environment (the install), checked as a whole — anything unknown or wrong stops the start, saying what |
| `app.js` | `createSuite()` wires every module from the configuration (database and migrations, sessions, accounts, tokens, audit, brake, plans, organizations, billing, WorkOS, OAuth); `createApp()` serves the suite's routes, its browser code and admin panel, the MCP endpoint, the app's routes and static files, in the order the apps learned, with clean-ups, hot reload and an orderly shutdown |
| `watcher.js` | Hot reload by polling (`HOT_RELOAD=true`) for code mounted over SMB, the submodule included |
| `api.js` | The common REST routes on the app's router: `/api/auth/*` (sign-in and out, in two steps when the person turned it on, a forgotten password, confirming an email, sign-up), `/api/me/*` (sessions, plan, tokens, connected apps, password, two-step verification), `/api/admin/*` (accounts, plans and grants, organizations, audit) and `/api/orgs/*` (people's own groups) |
| `web/` | The web kit, served at `/suite/` with no build ([docs/web-kit.md](docs/web-kit.md)): the shared interface with the Cronum Studio brand —the app's frame with a sidebar that folds away (`shell.js`), sign-in (`signin.js`), Settings (`settings.js`), dialogs, menus, notices and icons (`ui.js`, `icons.js`), `tokens.css` and `kit.css` with each product's accent and the brand's fonts—; `el()` and DOM helpers that never assemble HTML, `t()` in the browser, `api` with errors in words; the new-version notice (`update.js`), the live channel (`live.js`), offline writes in IndexedDB with idempotency keys (`local.js`, `outbox.js`), Markdown drawn without HTML (`markdown.js`), drag and drop between a list and the sidebar (`drag.js`), the service worker (`sw-core.js`), QR codes (`qr.js`) and `oauth.css` for the OAuth screens |
| `brand.js` | What the suite's own screens share of the Cronum Studio brand: the product's colour as the accent, the text that reads on it, and the "by Cronum Studio" signature |
| `web/admin.html` | The admin panel at `/admin`, in the app's colour and with its icon and the signature, built on the kit and `/api/admin/*`: accounts (role, plan, extras, password, sessions, two-step verification, removal), invitations with their link, what each plan allows, organizations when they are on, and the activity log |

## Using it in an app

### Add it

```bash
git submodule add https://github.com/cronumstudio/suite-core.git server/suite
git -C server/suite checkout v0.1.0
git add .gitmodules server/suite
```

Whoever clones the app needs `git clone --recursive`, or `git submodule update --init` after
cloning. GitHub's *Download ZIP* does not include submodules. In CI, `actions/checkout` needs
`submodules: true`. On a server that deploys with `git pull`, set
`git config submodule.recurse true` once, so pulls update it too.

### Update it

```bash
git -C server/suite fetch --tags
git -C server/suite checkout v0.2.0
git add server/suite
git commit -m "Suite: update suite-core to v0.2.0"
```

Then run the app's own tests.

### Change it

Changes are made here, never inside an app's copy. From an app, `server/suite` is a checkout of
this repository: edit, test (`npm test` here), commit and push from inside it, tag a version,
and then commit the new pointer in the app. Every other app picks the change up with the update
steps above.

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
    handle(user),                       // how the consent screen names them, e.g. "@martin"
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
  stateCookie: 'next_auth',             // holds state and PKCE verifier, Path=/auth
  users: {
    byWorkosId(id), unlinkedByEmail(email), firstUnlinkedAdmin(),   // → user | null
    link(userId, { workosId, email }), setEmail(userId, email),
    usernameTaken(name),                                             // → boolean
    create({ username, displayName, role, email, workosId }),        // → user
  },
  sessions: { open(res, userId, { workosSessionId }) },
});
```

Then, in the app:

- `await accounts.handle(req, res, url)` before other routes: `/auth/login` (`?signup=1` for
  the sign-up screen), `/auth/callback` and the `/.well-known/…` metadata. A failed return goes
  to `/?auth_error=failed` or `/?auth_error=unavailable`.
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
  NULL: they are set once every row exists. Every table needs a NOT NULL reference to `users` or
  to an earlier table.
- Importing gives every row a new id and translates every reference; accounts go where the
  admin says (the one here with the same email, a new one, or none), and an existing one takes
  the copy's preferences but keeps its username, email and role. `prefs` translates the ids the
  app keeps in its preferences. Passwords, second steps, sessions, tokens, OAuth grants and push
  subscriptions never travel.
- A copy is not trusted: only columns this install has, plain values, references inside the
  file, attachments that are images or PDF by their first bytes, one apply per copy
  (`data_imports`), and ceilings by who imports it. Someone's own copy has at most 64 MB of data,
  32 MB per file, 2 million values counted before parsing, 64 kB of preferences, 20,000
  attachments, and no more bytes of them on disk than about twice the upload. It can be opened or
  applied 10 times every 15 minutes (`rateLimits.importTo`). The admin and the command line have
  higher ceilings. `createApp` passes none of them, so these defaults hold. Zips whose entries share
  their bytes are refused.
- `limits` keep what a copy brings within what the app's screens accept. A number is the most
  characters, and longer text is cut there. A pattern is the shape, and a value without it is left
  out (the column's default, or what the profile had). Text without a limit is cut at 100,000
  characters.
- Someone's own copy, its plan and "replace" read only the rows near that account. Their cost
  follows that person's data, not the whole install's.

```bash
node scripts/data.js export copy.zip [--account ana]
node scripts/data.js import copy.zip --email martin=it@example.com --skip tests          # what it would do
node scripts/data.js import copy.zip --email martin=it@example.com --skip tests --apply  # doing it
```

## Tests

```bash
npm test
```

Runs the whole OAuth dance against an in-memory database, with fake users and sessions, and no
app around it.

## License

Copyright (C) 2026 Cronum Studio.

Released under the GNU Affero General Public License, version 3 only (AGPL-3.0-only): see
[LICENSE](LICENSE). You may use, study, change and self-host it freely; if you offer a modified
version to other people over a network, you must make its source code available to them too.

Versions up to v0.2.0 were published under the MIT license.
