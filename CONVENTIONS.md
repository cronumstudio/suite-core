# Conventions of the Cronum Studio suite

The rules every repository of the suite follows: suite-core and the apps (Tasks, Projects, Next,
Focus, Tracker). They are short on purpose. An app's own `CLAUDE.md` may add rules; it may not
relax these. The design they serve is in [docs/architecture.md](docs/architecture.md).

## 1. Language

- **English for everything in a repository**: identifiers, constants, parameters, comments, file
  names, environment variables, API error codes, MCP tool names, parameters and descriptions,
  documentation, commit messages, branch names and tags.
- **No visible text in the code or the HTML.** Everything a person reads comes from the
  translation catalogs through `t('key')` or `data-i18n`; English is the base language, Spanish,
  French and German are translations. A new key goes into every catalog; the tests fail if one is
  missing. Content people write is never translated.
- **Renaming depends on who holds the old name.** What clients hold and nobody can update for
  them (an MCP tool or parameter that an assistant remembers, a `localStorage` key in someone's
  browser) keeps the old name as an alias. What an install holds (an environment variable) does
  not: the old name stops the start and the message names the new one, because an alias would
  keep the install working on the old name forever without anyone noticing.
- Repositories that are still partly in Spanish move to English file by file; new code and new
  documents are English from the start. The maintainer's own tools (task lists, the progress log)
  are outside this rule.

## 2. Code

- **Zero npm dependencies.** `node:sqlite`, `node:http`, `node:crypto` and the other built-ins.
  `"dependencies": {}` stays empty; if something seems to need a library there is almost always a
  simpler way, and if there is not, ask first.
- **No build step.** The browser loads native ES modules as they are; `"type": "module"`
  everywhere.
- **Comments explain why, not what.** When a decision was odd, the reason is written next to it.
- **The DOM is built with `el()`**, through `textContent` and `setAttribute`. HTML is never
  assembled from strings: that is the whole defence against XSS.
- **The interface is the web kit's** ([docs/web-kit.md](docs/web-kit.md)): the frame, sign-in,
  Settings, dialogs, notices, controls, the brand's tokens and fonts. An app draws its own domain
  on it (Notes' editor, Next's graph) and doesn't make its own version of what the kit has.
- **Every write on the server follows four steps:** permission, validation, transaction, event
  (live update and audit).
- **A resource someone may not see answers 404**, not 403; 403 is for a visible resource and an
  action that is not allowed.
- **The API answers codes, not sentences:** `HttpError(400, 'field_too_long', { field, max })`
  becomes `{ "error": "field_too_long", "field": "title", "max": 200 }`. The browser writes the
  sentence from `errors.<code>` and `fields.<field>` in the person's language; a new code needs its
  sentence in every language, and the tests check it by reading the server code.
- **Dates** are stored as ISO 8601 in UTC with `Z`; they are written for people by `Intl`, in their
  language and time zone.
- **CSS uses logical properties** (`margin-inline`, `inset-inline-start`), never `margin-left`.
- File names are `kebab-case.js`. Regular expressions with combining characters write them as
  escapes (`̀-ͯ`): some editing tools turn literal ones into something else.

## 3. Repository

- `.gitattributes` with `* text=auto eol=lf`: the folders are edited from Windows and run by Linux
  containers, and a CRLF in `docker-entrypoint.sh` breaks the start-up.
- **Nothing personal in the repository.** Secrets and domains live in `.env`; the paths, ports and
  details of one installation live in `CLAUDE.local.md`. Both are ignored, with `data/`,
  `data-dev/`, `*.db*`, `node_modules/` and `.claude/settings.local.json`.
- **License:** AGPL-3.0-only, copyright Cronum Studio: the `LICENSE` file with the official text,
  `"license": "AGPL-3.0-only"` in `package.json`, `org.opencontainers.image.licenses` in the
  Dockerfile and a License section in the README.
- **Layout of an app:**

  ```
  server/            index.js, api.js, store.js (the domain rules), mcp-tools.js, resolve.js…
  server/suite/      suite-core, as a git submodule
  public/            index.html, sw.js, manifest.webmanifest, css/, js/, icons/, i18n/
  scripts/           smoke-test.js, dev.js, generate-icons.js, reset-password.js
  docs/              installation, usage, mcp, security, development, deployment guides
  suite.config.js    the product definition (see the architecture)
  CLAUDE.md          notes for AI agents; CLAUDE.local.md for the local ones (not committed)
  ```

## 4. Commits, branches and versions

- **Commit subject**: `Scope: what changes for whoever uses the app`, in English, without
  Conventional Commits prefixes (`Gantt: arrows go around the bars instead of crossing them`). The
  body explains the why in prose. Work done with an AI assistant carries its `Co-Authored-By`
  trailer.
- **Branches**: `main` is always deployable. Work happens on a branch, in a clone or worktree
  outside the folders that production runs from, and reaches `main` by fast-forward or pull
  request. Pushed history is never rewritten.
- **Versions**: semantic versioning, `0.x.y` while an app is being validated. The version lives in
  `package.json` and `server/version.js`, and the git tag `vX.Y.Z` must match both: the tests check
  the first two, the publish workflow the third.
- **Images**: `ghcr.io/cronumstudio/<app>`, for `linux/amd64` and `linux/arm64`, built by CI when
  a version tag is pushed and only if the tests pass.

## 5. Configuration

Environment variables describe one installation; `suite.config.js` describes the product. The
names are the same in every app:

| Variable | What it does |
| --- | --- |
| `BASE_URL` | Public URL, exactly as the browser uses it; decides Secure cookies and the OAuth issuer. Required in production (`NODE_ENV=production`, as the images set it) |
| `PORT` / `HOST_PORT` | Port inside the container / published on the host |
| `DATA_DIR` | Where the database and uploads live (`/data` in the container) |
| `DATA_PATH`, `PROJECT_PATH` | Absolute host paths for the compose files (Synology needs them) |
| `TZ` | Time zone for "today", due dates and the like |
| `TRUST_PROXY` | `true` only behind a reverse proxy that sets `X-Forwarded-For` |
| `SECURE_COOKIES` | Force or disable Secure cookies; empty = from `BASE_URL` |
| `SESSION_SECRET` | Optional: generated and kept in the database when empty |
| `ADMIN_USER`, `ADMIN_PASSWORD` | First administrator; without a password one is generated and printed once |
| `ADMIN_EMAIL` | With WorkOS: the verified address that administers |
| `AUTH_PROVIDER` | `local` (default), `workos`, `oidc` |
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_AUTHKIT_DOMAIN`, `WORKOS_MCP_AUDIENCE` | WorkOS AuthKit |
| `MCP_OAUTH` | `off` leaves only manual MCP tokens |
| `HOT_RELOAD` | Restart when `server/` changes (development and the NAS setup) |
| `PUID`, `PGID` | Owner of the data folder when the container cannot write to it |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push; generated when empty |
| `PLANS`, `DEFAULT_PLAN` | Override the plan catalog of `suite.config.js` for one install: a JSON, or the suite's catalog by name (`cronum-work`, suite-core `plans.js`) |
| `BILLING_PROVIDER`, `STRIPE_*`, `PADDLE_*`, `EARLY_ACCESS_UNTIL` | Billing (`stripe`, `paddle`, `remote`); off when empty. Until that date, the founder's price |
| `MAIL_PROVIDER`, `MAIL_*` | Outgoing mail; `log` in development |

Old names are not read: `PORT_HOST` and `PUERTO` (now `HOST_PORT`), `RECARGA_EN_CALIENTE`
(`HOT_RELOAD`) and `PUBLIC_URL` (`BASE_URL`) stop the start with a message that names the new one. Plan ids
are English in every app (`free`, `pro`): the old `gratis`, as a key of `PLANS` or in `DEFAULT_PLAN`,
stops the start the same way.
Compose files use only the current names.

**Port registry** (default `PORT`, also the host port unless an install says otherwise):

| App | Port | Today |
| --- | --- | --- |
| Tasks | 3456 | 3456 |
| Projects | 3457 | 3457 |
| Next | 3458 | 3458 in the container, 3459 on the NAS |
| Focus | 3460 | 3457 in the code, 3458 on the NAS: to move |
| Tracker | 3461 | 3000 in the container, 3080 on the NAS: to move |
| Notes | 3462 | 3462 |
| Show Lab | 8780 | nginx, 8780 on the NAS |

## 6. Deployment and development

- Production runs a published image with a fixed version. While an app is still deployed from its
  working folder on the NAS (code mounted, hot reload), that folder is only updated with a
  fast-forward `git pull`: never edit, check out or experiment there, because every saved file is
  live at once.
- Never start a development server against the `data/` folder the container uses: two processes on
  one SQLite file, one of them over SMB, corrupt it. `npm run dev` writes to `data-dev/`.
- A change to `.env` needs the container recreated (`docker compose up -d`), not restarted.
- When a file is added to `public/js/` or `public/i18n/`, it goes into the service worker's shell
  list too, or it will not work offline.

## 7. Tests

- `npm test` runs everything with nothing to install: a smoke test with a temporary database, a
  random port and a real server; the suite's conformance checks; the suite's checks of the app's
  texts (`tools/i18n.mjs app .`, also `npm run i18n`: flat catalogs that agree, keys in use, texts
  written in the code, anything in another language on the server; a line that must keep one says
  `i18n-exempt` and why); the version check. New behaviour comes with its check; a step that adds none has not been understood.
- Before a change to anything a phone shows (audio, wake lock, safe areas, installation), it is
  tried on a real device: emulators lie about those.

## 8. Notes for AI agents

- Every repository has a `CLAUDE.md` in English that says what the app is, its model, its rules,
  where things are, how it is deployed and tested, and how suite-core is used — and nothing about
  a particular machine, which goes in `CLAUDE.local.md`.
- Before planning a change, read the app's to-do list (its list in the Tasks app, named in
  `CLAUDE.local.md`), take it into account and mark what gets solved. Refer to a task by the number
  the app shows (`nº 12`), not by its internal id.
- Log the progress in Next at every milestone: what was done and the next step.

## 9. While the apps become modules of one app

Tasks, Projects, Next and Notes are becoming modules of one app: one process, one database, one
session, each module at its own path (`/tasks/`, `/notes/`…), mounted by suite-core's host. Until
the move is done, the four apps keep running on their own, people use them every day, and every
release of them must keep working as it does. These rules hold until then, on top of the rest.

**What an app that is live never changes**

- **`app.id`** (`tasks`, `proyectos`, `next`, `notes`). It names the database file, the session
  cookie and the browser's storage keys, and importing a copy checks it: a new id starts on an
  empty database and signs everyone out. A module's path in the host (`/projects/`) is the host's
  choice, not a new id.
- **Addresses registered somewhere else**: `/auth/callback` (the identity provider); `/mcp`,
  `/.well-known/*` and `/oauth/*` (people's AI connectors); `/api/billing/webhook` (the payment
  provider).
- **The service worker and the manifest**: the URL and scope of `/sw.js`, and the manifest's
  `id`, `start_url` and `scope`. A phone takes an app with new ones for a different app, and its
  push subscriptions are lost.
- **Its API routes**: new ones go next to the old ones, always under `/api/`, and the old ones keep
  answering. The kit's offline queue (`outbox.js`) drops a saved change whose route answers 404,
  and a tab with the old code in its cache keeps calling the old routes. Outside `/api/`, `/mcp`,
  `/auth/`, `/oauth/` and `/.well-known/`, the service worker answers a GET from its cache.
- **The MCP tools it announces**: `tools/list` keeps today's names and parameters. Aliases
  (`legacyTools`) answer but are not announced, so a renamed tool disappears for whoever
  reconnects, and with it people's connectors and their standing instructions. The prefix a
  module's tools carry in the host's single `/mcp` is put on by the host when it mounts the
  module; the app on its own doesn't change.
- **The plan features it declares**: with the suite's catalog (`PLANS=cronum-work`, `plans.js`),
  an app that declares a key the catalog doesn't have doesn't start, and aliases don't count there.

**New work in an app**

1. **Tables carry the module's name**: `notes_versions`, `next_branches`, never a generic name
   (`tasks`, `projects`, `files`, `items`, `settings`), which collides in the one database. The
   tables that collide today (`tasks` and `task_files` in Tasks and Projects, `projects` in
   Projects and Next) are renamed by the move itself, one app at a time, **in every app that
   has them**: a module's first migration creates its tables under their old names and its last
   renames them, so one app keeping a generic name would take it from another set up after it.
2. **API routes and MCP tools with names of their own**: a route under the app's own nouns
   (`/api/notebooks/:id/share`, not `/api/share`), a tool named after what it acts on
   (`share_notebook`, not `share`), so the module's tools still read well next to the others'.
3. **Every new table goes into `portable.js`**: the app's declaration of its data copies an
   account and the whole install, and it is how the data moves into the one database. A table
   left out is lost in the move.
4. **Plan features**: a new key goes first into the catalog (`plans.js`): suite-core is released
   with it, and only then the app that declares it. The keys every app shares (`retention.days`,
   `storage.mb`, `assign`, `mcp`, `mcp.calls_per_day`…) carry no prefix, and an app's own key is
   named after its things (`lists.max`, `notebooks.max`); in the host, the module's prefix is the
   host's business (`entitlements.js` reads `<app>.<key>` in grants). A key an app already
   declares is never renamed.
5. **The browser builds no absolute path of its own** (`/js/…`, `/api/…`, `/icons/…`): a module
   lives at `/<path>/` in the host, and the paths of today become relative app by app.
6. **What the browser keeps** (`localStorage` keys, IndexedDB and cache names) starts with the
   app's id: in the host every module shares one origin.
7. **Files go through `suite.uploads`**, never a path built by hand under `DATA_DIR`: in the host
   each module has its own folder, and a module's sweep must not see another's files.

**suite-core while this lasts**

- **Only changes that add**: `createHost()` next to `createApp()`, which stays as it is; what is
  new for modules sits behind options that didn't exist, so with today's options everything
  behaves as before. Every change is a new version with its tag.
- **An app's `server/suite` points at a tagged commit of suite-core's `main`**, never at a branch's:
  the deployment clones it when it builds. While an app waits on a branch's commit, that suite-core
  pull request is merged with a merge commit, not squashed, so the commit stays in `main`.
- **Moving an app's submodule up** brings every change and every suite migration since the version
  it had, written by other sessions, and they will run on that app's production database: read the
  CHANGELOG from that version on before doing it.
- **A new suite migration takes the next number on `main` when it is merged**, not when the branch
  started: two branches with the same number and different names leave an app that can't start.
- **A change reaches production as soon as any session moves an app's submodule up.** Before
  merging one, run `npm test` in all four apps with `server/suite` at that commit.
- **A version number is never one an open pull request already uses**: go above it.

**Releasing an app while this lasts**

- Small changes that keep working with what was there before, with their tests, and a pull request
  with the CI green.
- Before merging, bring the latest `main` into the branch with a merge (§4: pushed history is never
  rewritten, so no rebase and no `push --force` on a pushed branch), with a version nobody uses.
- With migrations, try the release first on a recent copy of the production database.
- **A migration in production has no way back**: once a release applies one (the app's or
  suite-core's), the release before no longer starts, because `migrate.js` refuses a database with
  migrations it doesn't know. If something goes wrong after deploying, a release without
  migrations is reverted with a pull request; one with migrations is fixed forward.
- Merging deploys. After it, check `/health`, `/version`, the new behaviour, the MCP and that
  people's data is still there.
