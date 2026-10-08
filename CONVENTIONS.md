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
(`HOT_RELOAD`) and `PUBLIC_URL` (`BASE_URL`) stop the start with a message that names the new one.
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
  random port and a real server; the suite's conformance checks; translation parity, keys in use
  and texts written in the code (`tools/i18n.mjs hardcoded public`, and
  `hardcoded --server server` for anything in another language on the server; a line that must
  keep one says `i18n-exempt` and why); the version check. New behaviour comes with its check; a step that adds none has not been understood.
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
