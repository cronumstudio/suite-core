# Changelog

Versions follow [semantic versioning](https://semver.org/); while in `0.x`, a minor version may
change an interface and a patch never does. Apps pin a version through the submodule pointer.

## 0.53.0 — 2026-10-08

- **Several apps as one: `createHost()`** (`host.js`, architecture §21). One process, one database,
  one session cookie, one sign-in, one table of accounts and one admin panel, the host's; each app
  a module at its own path (`/tasks/`, `/notes/`…), with its own tables and migrations (scope: its
  app id), routes, plan features, live channel, folder of uploads (`DATA_DIR/uploads/<app id>`, so
  one module's sweep never sees another's files), texts and data for copies. A module is a whole
  `createApp()` at `/<mount>/`: the host takes the prefix off, so two modules with the same routes
  don't collide. Its manifest is served rewritten for its place; the app's file doesn't change.
  `GET /api/modules` lists them for the host's pages; `/<mount>/admin` goes to `/admin`.
- **`joinHost()`**: an app's `platform.js` tries it before `createSuite()` and gets the host's
  suite with what is its own in place; anywhere else it is null and nothing changes. A host and its
  modules run one copy of suite-core; a module that runs another, never joins, reuses an id or a
  scope, or uses push, billing or organizations with the host's off stops the start, saying so;
  so do two modules whose data (`portable`) lives in a table of the same name, which in one
  database would write in each other's rows.
- **The web kit finds its base** (`web/base.js`): `/` on its own, the module's path in a host,
  read from the kit's own address. `api.js`, the catalogs, the live channel, the new-version check
  and the kit's links and icons go through `at()`; on its own every path is the one it was. The
  host's own pages (`/admin`, `/auth/…`, `/mcp`) stay at the root.
- **The service worker works from its scope** (`sw-core.js`): an app on its own is unchanged (scope
  `/`, its cache keeps its name, it clears its old caches as before, and now caches `base.js` with
  the rest of the kit). A module's worker at `/tasks/` treats `/tasks/api/` as the API, names its
  cache after its path and clears only its own, so modules sharing one origin don't empty each
  other's copies; the paths a notice opens go under the module's. A host's worker at `/` leaves its
  modules' paths alone with `skip`.
- **Copies across a module's move** (`portability.js`): a table renamed since copies were made
  says the names it had (`tables: { next_projects: { was: ['projects'], … } }`), and a copy with
  it under one of them comes in under the new one; a mistake there stops the start. A copy says
  how many of the app's own migrations it had from `migrationScope` (`app` on its own, the
  module's id in a host, which passes it), so a module's copies and imports compare like an app's.
- **`tools/web-resolve.mjs`** also finds the kit when an app's pages import it relative to their
  base (`../suite/x.js` from `public/js/`), as an app that runs as a module writes it.
- **Each person chooses their modules** (`host_modules`, the host's first migration): every one
  until they choose; `GET /api/modules` says which are on, `PUT /api/me/modules` sets them, and
  Settings › Modules has a switch per module. In a host, the shell draws a rail with the modules
  someone uses (a drawer on phones) and remembers on the device the one used last. A module turned
  off keeps its data and still opens at its path.
- **One MCP for every module** at the host's `/mcp`: each module's tools under its name
  (`tasks_add_task`), only those of the modules someone uses, and its old names still answered
  (not announced). The instructions are made per person from each module's `mcp.brief`, whole
  parts only, under 2048 characters. `/<mount>/mcp` answers 404 with where the MCP is. The calls of
  the day from assistants (`mcp.calls_per_day`, in the host's plans) count once for the whole app.

## 0.52.0 — 2026-10-08

- **The suite's plans, written once.** `plans.js` holds the catalog of the hosted suite,
  `cronum-work` (Free, Pro and Team, as the note «Beneficios de cada plan» decides them), and an
  install names it with `PLANS=cronum-work` instead of copying a JSON into each app. An app reads
  only the features it declares; one it declares that the catalog doesn't set stops the start, as
  it would be left unlimited. `COMMON_FEATURES` and `pick()` give the features every app names the
  same: `retention.days`, `storage.mb`, `assign`, `publish`, `templates`, `mcp` and
  `mcp.calls_per_day`. A PLANS JSON keeps working as before.
- **What Free keeps for some days counts them from when Pro ended.** `entitlements.cutoff(user,
  feature)` says before when something done or deleted goes: null while the days since the end of
  the last grant that kept things longer have not passed (or with no limit), `now − days` after
  that. Dropping to a smaller plan no longer means nothing is ever deleted: it means nothing is
  deleted at once. Each app sweeps its own data with it.
- **Calls from assistants per day.** With `mcp.calls_per_day` declared, the MCP transport spends one
  of the person's calls of the day (UTC) on each tool call (`entitlements.countDaily()`, migration 20
  `entitlement_usage`); listing tools and prompts doesn't count, nor does what is refused. Once
  they are used up the assistant reads a sentence it can pass on, with when they come back and which
  plan has more (`dailyLimitText()`). `createMcpServer({ quota })` takes the check.
- **The apps' sweeps on the suite's timers.** `createApp({ sweep })` runs the app's function for
  what a plan keeps only a while a minute after the start and then every six hours with the
  clean-ups, logging what it removed and surviving a failure, instead of each app keeping its own
  timers.

## 0.51.0 — 2026-10-08

- **One way to translate, the same in every app.** Each app kept its own copies: Tasks and
  Projects a full translator for the server and one for the browser, Next and Notes simpler ones,
  with nested catalogs in two of them and different checks in each. Now:
  - `appTexts(dir)` (`i18n.js`): an app's translations on the server, taken from Tasks and
    Projects: its catalogs over the suite's, read again when a file changes, `DEFAULT_LANGUAGE`,
    whose language wins (`languageFor`, `userLanguage`), `errorSentence` and `fromCatalog`. An
    app's `server/i18n.js` is one call.
  - `web/i18n.js` does what every app did again: `loadLanguage('auto' | lang)` keeps the choice as
    `<app>.lang` (`{ remember: false }` for the admin panel, which follows the account),
    `savedLanguage`, `resolveLanguage`, `changeLanguage` (`app:language`), `translateDom`, numbers
    in texts written by Intl, and cached `dateFormat`, `numberFormat`, `listFormat`,
    `relativeDay`, `compareText` and `capitalize`. The English catalog is fetched once.
  - `appChecks(root, { skip })` and `i18n.mjs app`: every check of an app's texts at once (flat
    catalogs in every language, parity, keys in use by the browser and the server, texts in the
    code, another language on the server); `vendor/` folders are others' code and never read.
  - `tools/web-resolve.mjs`: lets Node load an app's browser modules in its tests.

## 0.50.0 — 2026-10-08

- **Plan ids in English: `gratis` is `free`.** Tasks' free plan was the only one with a Spanish
  id. An install whose `PLANS` still has a plan `gratis`, or whose `DEFAULT_PLAN` is `gratis`, no
  longer starts: the message names `free`, as a renamed variable does (`OLD_PLAN_IDS` in
  `entitlements.js`). It is not read as an alias because the app renames its stored grants to
  `free` in the same release, and an install left on `gratis` would quietly stop matching them.

## 0.49.0 — 2026-10-08

- **One check of texts written in the code, for the whole suite and its servers.** `tools/i18n.mjs
  hardcoded` takes Tasks' stricter lint, which Tasks ran apart: it reads the code instead of its
  lines (`scanLiterals()`), so comments and regular expressions no longer count and a text over
  several lines or behind a condition (`open ? 'Close' : 'Open'`) does. Besides texts given as
  text, titles, labels and notices, it catches `setAttribute('aria-label', …)`, `confirmDialog()`,
  a word in another language anywhere and a sentence that is not an error's message. In the HTML,
  an element inside one with `data-i18n` is the catalog's, and each read attribute needs its own
  key in `data-i18n-attr`. `--server` (`{ server: true }`) checks a server, where only another
  language counts (its English is for the developer and the assistant), with `--skip` for data
  such as seeds; errors, the console and SQL never count. Keys, paths, URLs, acronyms and what the
  server fills in (`{{app.name}}`) pass. Projects, Next and Notes pass it as they are.

## 0.48.0 — 2026-10-08

- **Paddle's sandbox and live account apart.** Billing writes the provider's id on customers,
  subscriptions, events and grants, and both environments wrote `paddle`: an install moved from the
  sandbox to the live account (`PADDLE_ENV`) found a sandbox customer, which the live API doesn't
  know, and the checkout failed; a sandbox subscription still active would have answered
  "already subscribed". Now the sandbox is `paddle-sandbox` and the live account `paddle`
  (`providerId()`), and migration 19 marks what was written before as the sandbox's: the live
  account sold nothing before this version.

## 0.47.0 — 2026-10-08

- **Undo and redo.** `undo-2` and `redo-2`, from [Lucide](https://lucide.dev) 1.53.0 (ISC), one
  path each, for an editor's bar.

## 0.46.0 — 2026-10-08

- **The rest of an editor's bar, all from Lucide.** `bold`, `italic`, `strikethrough`, `heading`
  and `heading-1` to `heading-3`, `code-xml`, `list-indent-increase` and `list-indent-decrease`,
  from [Lucide](https://lucide.dev) 1.53.0 (ISC), one path each. `link` is now Lucide's too, so a
  bar made of these icons is of one family; it changes little in the apps that already use it.

## 0.45.0 — 2026-10-08

- **Icons for a text editor's bar.** `list` (lines with a dot in front), `list-ordered` (with
  numbers), `list-todo` (with a box and a tick) and `table` (a table with its header row), from
  [Lucide](https://lucide.dev) 1.53.0 (ISC), drawn as one path on the kit's grid.

## 0.44.0 — 2026-10-07

- **Markdown as editors write it.** `parseInline()` decodes the entities an editor such as Tiptap
  writes: `&lt;` `&gt;` `&amp;` `&quot;` `&apos;` `&nbsp;` and numeric ones (one no character has is
  U+FFFD), never inside code; a decoded entity is text and never a mark or a tag. So the reading
  view, `plainText()` and what the apps show of a note read `&lt;b&gt;` as `<b>`, and `&nbsp;` (a
  line left empty) as a space. `titleOf()` undoes escapes and entities too (`\~12 tortitas` →
  `~12 tortitas`) and skips a first line that is only `&nbsp;`.

## 0.43.0 — 2026-10-07

- **Highlighted and underlined text in Markdown.** `renderMarkdown()` reads `==highlighted==` as
  `<mark>` and `++underlined++` as `<u>`, the marks Obsidian, Bear and Typora use, since Markdown
  has no other way to say them. Like `_`, neither opens or closes inside a word, so `C++` and
  `a==b` stay text. The highlight is a highlighter's yellow in every app (`--kit-md-mark`).

## 0.42.0 — 2026-10-07

- **A long press and a drag on the same row.** `onHold(item)`: a finger that held a row and let
  go without moving it pressed long, it didn't move anything, and the app does what a long press
  does there (a list's menu). A finger that went somewhere carried it, as before. So a row can be
  picked up by holding it anywhere, without a grip to find.

## 0.41.0 — 2026-10-07

- **One frame for every app, and its sidebar folds away.** Next, the only app with a top bar and
  tabs, moves to the sidebar like the rest, so the top layout goes: `layout`, `tabs`, `selectTab`,
  the bottom bar on a phone, the bar's brand and account button, and their CSS. `data-layout="side"`
  stays on the frame for the apps' own CSS. From 640 px the sidebar can be folded away with the
  button at its head, as only Projects could: the bar comes back with ☰ to unfold it and the
  `create` button, and the device remembers it per app (`<app.id>.sidebar`, Projects' own key and
  values, so its choice carries over). `onFold(folded)` tells the app its views' width changed.

## 0.40.5 — 2026-10-07

- **No hop at the end of the gap's slide.** A list with space between its rows (flex or grid
  `gap`) puts that space beside the gap at once, so the rows slid and then hopped by it as a gap
  closed (and as one opened). The gap now takes it back with a negative margin while it is shut
  (`--kit-gap-space`, read from the list).

## 0.40.4 — 2026-10-07

- **The rows slide while something is dragged.** The gap where it would land appeared and
  vanished at once, and the rows jumped by a whole row each time it moved. Now it grows where it is
  going while the one it leaves shrinks, so the rows between slide to their place; one closing is
  no place to drop on, and the same slot (behind one row, in front of the next) keeps its gap.

## 0.40.3 — 2026-10-07

- **About says which version is the latest.** The row is "Latest version" and says "You are up to
  date" in green, or the number the server has (`v1.47.0`) beside the Update button, where it only
  said there was a new one. The same number as the one running is a new build of it, and shows its
  date. `watchUpdates()` keeps what the server answered: `latest()` → `{ app, version, built }`.
- **The source link keeps the app's colour.** An app's own `a { color: inherit }` (Next) turned it
  into plain text; the kit now colours the links in About itself.

## 0.40.2 — 2026-10-07

- **The drag's card stays inside the screen with a long title.** Its one column grew with the
  text, so the ellipsis never came and "After …" ran past the card's edge; and the card was placed
  by its size before its words changed, so one that grew stood out of the screen until the next
  move, which a finger holding still never makes. Now the column is the card's width, where it
  falls goes down to a second line before it is cut (the second line, too), and the card is placed
  once it says what it says.

## 0.40.1 — 2026-10-07

- **The drag's tabs answer at once and are easier to reach.** Reaching one opens or closes the
  drawer without waiting (`data-drag-spring="at-once"`), and each takes 60 × 180 px, more than its
  drawn pill, so the finger needn't go right to the edge.
- **Smoother.** The tabs slide in from their edge and out again instead of appearing and vanishing,
  and the drawer slides out when it closes too, where it used to vanish at once (its visibility
  waits for the slide); opening and closing share one curve, quick to start and soft to land
  (`--kit-slide-time`, `--kit-slide`). With reduced motion, none of it moves.

## 0.40.0 — 2026-10-07

- **One drag for everything, and tabs to reach the drawer.** On a phone the drawer opened as soon
  as something was picked up, which hid the list where it could also go in order or into another
  category, so an app needed two drags. With `drawer: 'tabs'` the list stays: a tab at the start
  edge opens the drawer when held, and one at the end edge, beside the open drawer, closes it, all
  without letting go (`createShell({ dragTabs })` chooses their icons). `grip` picks up at once by a
  part of the row while the rest still needs holding. Without `drawer`, nothing changes.
- **Where it landed.** `onDrop` gets `x`, `y` and `top`, the gap's, so the app can keep the moved
  row in sight after the list is drawn again.
- What opens something when held (☰, the tabs) is marked `data-spring-armed` while it waits.

## 0.39.1 — 2026-10-07

- **Updating says so at once.** Bringing in the new version takes a few seconds (the new service
  worker installs and takes control before the reload), and the button didn't change meanwhile,
  so it was pressed two or three times more. `applyUpdate(event)` now turns the button pressed
  into "Updating…" with a spinner (`aria-busy`) before anything is awaited, and pressing again
  returns the update under way instead of starting another. The banner's button passes the click
  as it is; Settings → About passes it too. New text: `kit.update.applying`.

## 0.39.0 — 2026-10-07

- **Dragging in order: before, inside or after a row.** `makeDraggable()` dropped only on a whole
  place; now `zones` splits each place by the height of the pointer —`'between'` (before, after)
  or `'around'` (before, inside, after), chosen place by place if need be— and `check` and `onDrop`
  get `{ zone }`. The rows of a list can be at once what is picked up and where it goes, for
  reordering it or a tree; `end` makes the space below the last row the end of the list.
- **A gap where it would land.** Before or after a row, a dashed gap as tall as the row carried
  opens and the rows below make room for it; inside a row, it lights up as a whole place does.
  `gap: 'thin'` draws a line that moves nothing, for rows level with a chart. `check` may add a
  second line to the card (`detail`) and indent the gap (`indent`), for the level of a tree.

## 0.38.0 — 2026-10-07

- **Paddle as the billing provider** (`paddle.js`, `BILLING_PROVIDER=paddle`), the merchant of
  record that sells Cronum Work: `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET` (the app's own
  notification destination), `PADDLE_ENV` (`sandbox` | `production`, matching the key) and
  `PADDLE_CHECKOUT_URL` (the page with Paddle.js), checked on start. The checkout is a transaction
  made through the API, with the person's customer (found or made by their verified email) and
  `custom_data: { workos_user_id, email, product }`; its payment link opens that page with
  `return` and `_ptxn`. The portal is a customer portal session. Subscription, transaction and
  adjustment notifications become the suite's events; the `Paddle-Signature` is checked with five
  minutes of tolerance. No SDK, plain `fetch`.
- **One subscription for every app.** An event may say who pays by their `identity` (their WorkOS
  id), the same in every app, and billing finds the account by it, never by the app's own id,
  which differs from app to app. Someone who hasn't opened an app yet gets what they paid for at
  their first sign-in there: the event waits in `billing_pending` (migration 18) until the identity
  is linked to an account (`accounts.whenLinked`, new) and `billing.claim()` applies it in order.
  An identity outranks an older link of the customer to someone else. `createBilling` takes
  `identities` and `isFounder`; `createSuite` gives them from the accounts and WorkOS.
- **The founder's price, chosen on the server.** A product may have a `founderPrice`; whoever
  joined before `EARLY_ACCESS_UNTIL` (their WorkOS account's date, or the account's here) pays it,
  never because the browser asks. Without that date nobody does. `GET /api/billing/products` says
  `founder` for the person asking and `founder_price` per product.
- **A refunded period doesn't give the plan back.** A full refund or chargeback of a subscription
  ends its grant, and a later event for the same period (Paddle doesn't cancel on a refund) leaves
  it ended (`refunded_until`); the next period paid for gives it again. `paused` ends it too.
- **Prices per environment.** A product's `price` (and `founderPrice`) may be
  `{ sandbox: 'pri_…', production: 'pri_…' }`; the one of `PADDLE_ENV` is used, and Paddle's ids are
  checked on start.
- **Moving an install keeps who pays** (audit sc-data-48). The copy of a whole install carries the
  customers, the subscriptions and every grant, the paid ones too (`suite/billing.json`,
  `suite/grants.json` with `source` and `external_ref`), under the new ids; and an event that names
  an account by its old id goes to whoever the customer is linked to here. Before, the paid plan
  was lost in the move and a renewal could give it, and the portal with the payer's invoices and
  card, to whoever had their old id.
- Checkout hands the provider the person's email only when it is verified.
- **Products without a provider don't stop the start.** An app may declare what it sells
  (`modules.billing` and `products`) and an install without `BILLING_PROVIDER`, or whose plans
  have no "pro", still starts: billing is off there and sells nothing. With a provider, a product
  whose plan isn't in the catalog stops the start as before.

## 0.37.3 — 2026-10-07

- **No account button in the bar of the side layout, at any width.** 0.37.2 hid it only where
  the sidebar stays beside the page; on a phone the avatar was still in the bar's corner, and only
  disappeared under the open drawer, which has the person's button at its foot already. The frame
  no longer makes it: in the side layout the person is at the sidebar's foot (in the drawer on a
  phone), and only the top layout, which has no sidebar, has it in the bar.

## 0.37.2 — 2026-10-07

- **One account button with the sidebar beside the page.** From 640 to 959 px (a tablet, a narrow
  window) the sidebar stays beside the page with the person's button at its foot, and the bar above
  the page showed their avatar too: the same button twice. The bar's one is hidden wherever the
  sidebar shows; on a phone, where the sidebar is a drawer, the bar keeps it.

## 0.37.1 — 2026-10-06

- **Sign out closes the profile** in Settings, under the name, the address and the username, where
  most apps have it, instead of at the foot of the list of sections, which keeps only sections.

## 0.37.0 — 2026-10-06

- **The person's button opens Settings.** It opened a menu whose entries were Settings,
  Administration and Sign out, and Settings already has the other two: now it goes straight there.
  A menu is still opened when the app gives `accountItems` or has no `onSettings`.
- **Sign out at the foot of Settings' list**, seen from the first screen on a phone and always on a
  computer, instead of at the bottom of *Password and sign-in*.

## 0.36.2 — 2026-10-06

- **A swipe from the edge stays in the app.** Safari took a swipe from the left edge as back in the
  history, which left the app for the page before, and one from the right as forward. Now the start
  edge does what the bar's button beside it does —opens the drawer, or goes back from a detail to
  its list— and the end edge does nothing; an open drawer closes with a swipe the other way. Safari
  is only stopped by cancelling the touch as it begins, so a touch that starts within 20 px of an
  edge does the tap and the vertical scroll by hand, and an edge is only taken when there is
  something to do or a page to leave (`navigation.canGoBack`/`canGoForward` where they exist).
  While something is being dragged (`drag.js`) the edges stand aside.
- **Settings: the list and the open section scroll on their own.** Side by side, from 720 px, they
  scrolled together and a long section carried the list away. Each column has its own scroll now;
  on a phone, where they are two screens, the page scrolls as before.
- **The account menu doesn't repeat who you are.** Opened from the sidebar, whose button already
  shows the name and address, it no longer has them on top; from the bar's avatar, which is only
  the initials, it still does.

## 0.36.1 — 2026-10-06

- **On a phone the drawer opens as soon as something is picked up.** The sidebar is a closed
  drawer there, and opening it meant holding the dragged note or task over ☰, which nothing told:
  on an iPhone there was nowhere to drop it. Now the frame opens the drawer when a drag starts whose
  places are in it (`kit-dragstart` carries `detail.item` and `detail.targets`) and closes it when
  the drag ends; the drag looks again under a still finger once the drawer has slid in. Where the
  sidebar stays, nothing changes.

## 0.36.0 — 2026-10-06

- **Drag and drop in the web kit** (`drag.js`). `makeDraggable(container, { items, check, onDrop })`
  lets an app pick up rows of a list and drop them on places anywhere on the page (`data-drop`): a
  note on another notebook, a task on another list. A card follows the pointer saying in words what
  letting go will do, or why it can't be done there; the place under it lights up. A mouse starts
  after a few pixels, a finger after holding still; Escape puts it back; it scrolls near the edges;
  the release doesn't also open the row. On a phone, holding it over ☰ opens the drawer, which
  closes again when the drag ends. `kit-dragstart`/`kit-dragend` and `<html data-kit-dragging>` let
  the app's own gestures wait. The service worker caches it with the rest of the kit.
- `navItem()` takes `data`, its entry's data-* attributes (`{ drop: '', notebook: 7 }`), so a sidebar
  entry can be a place to drop on and say which one it is.

## 0.35.1 — 2026-10-06

- **Each app sees only its own connections.** Claude is one client for every app, with an
  authorization per app, and 0.35.0 also listed any authorization of a client that had come to
  the app: every app showed Claude's connections to all of them. Now an app lists the
  authorizations that name its `/mcp`; one without a resource only if its client has come there.
- **Disconnecting in one app leaves the others connected.** WorkOS withdraws a client from every
  app at once, so while Claude is still authorized for another app the authorization isn't
  withdrawn there: the app refuses the consent that was disconnected (the tokens' `sid`, the same
  when Claude refreshes its token and new when it connects again). Migration 17: `sid` and
  `revoked_sid` in `idp_connections`. A client authorized only for this app is withdrawn at WorkOS
  as before. The connections store's `lastUsed()`/`revokedAt()` become `of()`/`refuses()`.

## 0.35.0 — 2026-10-05

- **The AI clients connected through WorkOS, in the app.** With WorkOS, Claude or ChatGPT are
  authorized by AuthKit, not by the built-in OAuth, so Settings → Your AI listed none and
  disconnecting one meant going to WorkOS. Now `/api/me/apps` lists them too —those whose
  authorization names this app's `/mcp` and those whose tokens have come here—, with their last use
  here, and *Disconnect* withdraws the authorization at WorkOS
  (`/user_management/users/:id/authorized_applications`) and refuses from then on the access
  tokens it had already issued, which would otherwise work until they expire. Their ids are
  `workos:…`; the audit log notes `oauth.connection.revoke`. Migration 16 (`idp_connections`):
  per person and client, last use and when it was disconnected. `workosUsers()` gains
  `workosIdOf()`, `createWorkosAccounts()` takes `connections` (`workosConnections(database)`),
  and the WorkOS client `authorizedApplications()` and `revokeApplication()`.
- **Where you are signed in, with its browser.** A sign-in through WorkOS, OIDC or the OAuth consent
  screen opened its session without the request, so Settings showed a dash with nothing else: now
  the browser and address are noted as with a password. Sessions opened before say *Unidentified
  browser* and when they began. `deviceName()` takes the text for an unknown one.

## 0.34.0 — 2026-10-05

The web kit, whole: the interface every app shares, approved on 5 October, and what Notes needs to
be built on it alone. How an app uses it: [docs/web-kit.md](docs/web-kit.md).

- **The shared interface.** A frame with a sidebar (Tasks, Notes, Projects) or a top bar with tabs
  (Next, Focus, Tracker, Talk) and the same pieces in both; on a phone a drawer, two screens for a
  list and its detail and the tabs at the bottom (`shell.js`). Sign-in with the product's colour
  large beside the form (`signin.js`), Settings as a list of sections with About in every app
  (`settings.js`), dialogs that rise from the bottom on a phone, menus, notices with *Undo* or
  *Retry*, banners, switches and the like (`ui.js`), stroked icons (`icons.js`).
- **The brand.** `tokens.css`: yolk, ink, cream, every product's colour and its accent by
  `<html data-app>`, light and dark, each pair measured at 4.5:1 by the tests; Geist, Space Grotesk
  and Geist Mono served from `/suite/fonts/` (SIL OFL), never from Google. Tasks' light accent goes
  to `#CC3718` and its dark one to `#F0694B` with ink, Next's light one to `#0A789E`: the ones
  before didn't read as a link on the page's ground. The admin panel takes all of it, and its
  title is the app's name until it writes its own.
- **Offline writes sent once.** `idempotency.js`: every app's API keeps a day the first successful
  answer to an `Idempotency-Key` (per account, tied to its method and path) and answers a repeat
  with it, without running the write again; migration 15. In the browser, `local.js` keeps an
  app's stores in IndexedDB and `outbox.js` the changes made offline, each with its key and
  provisional ids that become the real ones; it waits without a signal, a session or a server,
  hands conflicts (409) to the app and sends from one tab at a time.
- **What the apps already did, once.** `update.js` (the new-version notice, from Tasks, kept until
  acted on), `live.js` (the live channel, from Next and Tasks), `sw-core.js` (the service worker,
  from Tasks).
- **Markdown** (`markdown.js`): notes drawn with `el()`, HTML never interpreted, links only to
  http, https, mailto or the app, images only from the app; tests with the usual XSS payloads.
- **Texts written in the code** (`tools/i18n.mjs hardcoded`), and the kit's texts in the four
  languages (`kit.*`), most of them from Next's.
- **Dates in SQLite's format** ("2026-10-04 12:38:27", the OAuth grants) read as UTC in every browser
  (`instant()` in `i18n.js`): Safari took them for invalid dates and Chrome for local time.
- Interface: `api.write(method, path, body, { key })`; `toast()` takes `action`; `openDialog()`
  takes `onClose`; `confirmDialog()` takes `title`. `kit.css` no longer brings the tokens: a
  page links `tokens.css` before it.

## 0.33.0 — 2026-10-05

Copies of data, from the audit's medium findings.

- **One person's copy reads that person's rows, not the whole install** (x-stability-1,
  sc-data-14, sc-web-37). "Download my data", the plan of "Import data" and "replace" now ask
  SQLite only for the rows that point at that account, or at rows of theirs already kept. Before,
  they loaded every table whole and filtered it in memory, with the server stopped meanwhile. With
  500,000 tasks of 2,000 people:
  - a copy of an empty account went from 1,298 ms to 34 ms;
  - its plan went from 665 ms to 37 ms.

  The whole install's copy still reads everything, which it needs.
- **What a copy brings stays within what the app's screens accept** (sc-data-7). A declaration may
  give `limits` per table, and `users.limits` for the app's own profile columns:
  - a number is the most characters, and longer text is cut there (never through an emoji);
  - a pattern is the shape, and a value without it is left out: the column's default, or what the
    profile already had.

  Text without a limit is cut at 100,000 characters. A copy is a file anyone can write: before, a
  list name of megabytes reached everyone it was shared with.
- Interface: `selectRows()` calls `rowsOf(name, ids)`, with the ids kept so far per table. A
  `rowsOf` that takes only the name works as before.

## 0.32.0 — 2026-10-05

- **Someone WorkOS knows by a new id keeps their account** (sc-auth-46). Every WorkOS environment
  has its own user ids, and an account deleted and made again there gets a new one. Before, after
  moving an install to another environment:
  - everyone got a new, empty account;
  - the admin email took the account of another administrator: their data, and their email
    overwritten;
  - that administrator then got a new account, as a plain user.

  Now an account with that verified email, linked to an id WorkOS answers 404 for, is moved to the
  new id. While the old id still exists it is someone else, and the newcomer gets an account of
  their own. If WorkOS gives no clear answer, the sign-in fails as unavailable and nothing changes.
- **The admin email takes over another administrator only while the install moves to the
  provider**, or one with no email (`firstUnlinkedAdmin`, WorkOS and OIDC). An administrator with
  an email, made once people sign in there, is that person's.
- Interface: `localUser()` of `createWorkosAccounts` is async. `users` may give
  `linkedByEmail(email)` and `relink(userId, { from, workosId, email })` (`workosUsers()` does);
  without them nothing is moved. New: `accounts.linkedByEmail()`, `accounts.relinkIdentity()` and
  the WorkOS client's `knows(id)`.

## 0.31.1 — 2026-10-05

More of the audit's medium findings.

- **Push only to the browsers' push services** (sc-oauth-12). A subscription's endpoint must be
  under Google's, Mozilla's, Apple's or Windows' push service domains. A public-looking name can
  point anywhere through DNS, and the server would send to it.
- **The live channel has bounds** (sc-platform-17). A person keeps at most 10 channels; an 11th
  closes their oldest. A channel that stops reading is closed once 64 kB wait unsent; its browser
  reconnects and resyncs. Before, both grew without end in memory.
- **An install imported from the panel makes no admin by itself** (sc-web-1). A copy's accounts
  are created as plain users unless the decision says `create: { role }`. The file could carry
  any role, and with WorkOS whoever signed in with that email became an admin. The command line
  keeps the copy's roles.

## 0.31.0 — 2026-10-05

More fixes from the audit of 2026-10-04.

- **Signing someone out from the admin panel is everywhere** (sc-web-3, sc-auth-48). "Sign out
  everywhere" (`DELETE /api/admin/users/:id/sessions`) and a password the admin sets for someone
  else used to close only the sessions here. Now they also:
  - revoke the API tokens and the assistants' OAuth grants;
  - drop the devices that get notices;
  - end the identity provider's sessions behind them.

  The answer now says `{ closed, tokens }`. Signing one device out from the profile ends its
  provider session too. With WorkOS this is `revokeSession` (`POST
  /user_management/sessions/revoke`), sent in the background, with failures logged. With OIDC
  nothing changes, because there is no server-side way to end that session.
  `registerAdminApi` takes `tokens`, `oauth`, `push` and `idp`, and `registerProfileApi` takes
  `idp`. `sessions.idpSessionsOf()` is new.
- **A disabled account gets no notices** (sc-platform-18): disabling it deletes its push
  subscriptions. Apps pick whom to notify from that table without looking at `disabled_at`.
- **Push: an outage no longer drops devices** (sc-platform-14). A failed fetch, a 408 or 429, and
  any 5xx used to count towards the three failures that delete a subscription: a push service
  down for minutes, or an outbound network blip, dropped every device of everyone. Only the other
  4xx (a refusal about the subscription itself) count now; 404 and 410 still delete at once.
- **The MCP token brake counts per address and token** (sc-oauth-1). Counted per address alone,
  one misbehaving connector behind claude.ai's or ChatGPT's few shared addresses locked every
  other user there out of signing in. Tokens are 192 random bits, so nobody guesses one: what
  the brake stops is a client repeating the same bad token. Past 1,000 failures from an address
  nothing more is written down. `checkToken`, `tokenFailed` and `tokenSucceeded` take the token.

## 0.30.2 — 2026-10-05

- **An import can't multiply one attachment on disk** (audit, sc-data-13). Rows that share a file
  in a copy each get a file of their own when it is applied, but 0.30.0 counted only the distinct
  files against its ceilings: forty rows over one photo that inflates to 1 MB wrote 40 MB from an
  upload of a few kB, and it scaled to terabytes. Now every row that brings a file counts, in
  bytes against twice the upload plus 16 MB and in number against `limits.files`.

## 0.30.1 — 2026-10-05

- **"WorkOS does not answer" says why.** When a request to WorkOS or an OIDC provider fails before
  any answer, the log now carries the reason from `fetch`'s cause (`fetch failed: ECONNREFUSED`,
  `ECONNRESET`, `UND_ERR_SOCKET`…) instead of `fetch failed` alone, which couldn't tell a
  provider that is down from a connection cut halfway.

## 0.30.0 — 2026-10-05

More fixes from the audit: importing one's own data (`POST /api/me/import`, open to every account)
could stop the server or fill its disk.

- **Ceilings by who imports a copy.** Someone's own copy has at most 64 MB of data, 32 MB per file
  and 20,000 attachments. Before, it had the whole install's 512 and 256 MB, and no attachment
  count. The administrator's routes and the command line keep the higher ceilings
  (`planFile`/`applyFile` take `by`). `createPortability({ limits })` sets `data`, `entry`,
  `values` and `files` per `account`/`install`, and `portabilityFor` now passes `limits` through.
- **Values are counted before parsing.** A 250 kB zip holding 250 MB of `[{},{},…]` took the
  process out of memory: `JSON.parse` builds everything before a row is checked. Commas, braces
  and brackets are now counted on the bytes, at most 2 million for an account, and above that the
  copy is refused with `413 zip_too_large` without parsing.
- **Attachments take no more disk than about twice the upload.** Thousands of rows can point at
  "photos" that inflate from a few kB to 15 MB each. Now the files staged for one import add up to
  at most twice the zip plus 16 MB. Exports store files as they are, so a real copy is never near
  that.
- **Entries that share their bytes are refused** (`zip_invalid`, `overlap`). This is the
  overlapping zip bomb, where many names point over one deflated block. Also refused: a header
  that isn't the entry's own (`entry`), a stored entry whose sizes differ, and a deflated entry far
  bigger than its data (`size`). Before, those were read into memory whole.
- **The account's row stays small**: a copy's `prefs` is at most 64 kB and each of the app's own
  `users` columns at most 1 kB, or `import_invalid_data`. Before, 150 MB of preferences came in and
  were read on every request that account made.
- **Opening or applying one's own copy is braked**: 10 times every 15 minutes per account
  (`rateLimits.importTo`), then `429 too_many_attempts`.

## 0.29.2 — 2026-10-05

Fixes from the audit of 2026-10-04: nothing a single request or one account can do should stop the
server for everyone.

- **A request no URL can be made of is a `400`**, not a crash: `GET //` or a `Host` such as
  `a:99999` made `new URL()` throw outside the handler's `try`, and the rejection nobody awaited
  ended the process. Whatever escapes `handle()` is now caught and answered `500`.
- **The process has a safety net**: an unhandled rejection is logged and the server goes on; an
  uncaught exception is logged and the server closes in order (exit 1, for Docker to restart it).
  The periodic clean-ups log a failure and try again next time. `SIGTERM` now also closes the live
  channels, which kept the shutdown waiting for its 5-second timeout whenever a tab was open.
- **MCP**: a JSON-RPC batch carries at most `MAX_BATCH` (20) messages; a bigger one is refused
  whole (`-32600`) before any of it runs. A request without a token always gets its `401` (behind
  an address shared with someone trying bad tokens it used to get `429`, and couldn't start signing
  in), and once an address is blocked its failed tokens are no longer written down.
- **`TRUST_PROXY=cloudflare`**: the client address is `CF-Connecting-IP`, believed only when the hop
  that brought it is one of Cloudflare's published ranges (reached directly, the origin would take
  whatever a client wrote). Behind Cloudflare and Traefik every client used to share Cloudflare's
  addresses in the brakes, the audit log and the sessions. An empty `TRUST_PROXY`, as compose passes
  an unset one, now leaves the product's default.
- **WorkOS**: `/.well-known/oauth-authorization-server` answered `502` from its second request on
  (an undefined constant). A missing `WORKOS_MCP_AUDIENCE` is now a start-up warning: without it,
  an MCP token AuthKit issued for another app of the same environment is accepted.
- **Issuer keys (WorkOS, OIDC)**: when the JWKS can't be fetched, the keys in hand keep serving for
  up to a day and the issuer is asked again every five minutes (each request used to wait for it,
  and every token got `503`); with no key in hand, again after ten seconds. A set with no usable key
  counts as an outage (`createKeySet({ unavailable })` says with which error).
- **Web Push**: a key that is no point of P-256 is refused on subscribing, and one stored before is
  dropped instead of failing the whole send (in Tasks it stopped the reminder sweep for everyone).
  A send never follows a redirect (an endpoint chosen by a user could point inside the network) and
  gives up after 10 s. A person keeps at most `MAX_DEVICES` (10) devices: the ones longest unused go
  (subscribing again counts as use). `deliver()` encrypts 20 at a time and never rejects; a payload
  that can't be written fails that send without dropping any device.

## 0.29.1 — 2026-10-04

- Nothing under `/i18n/` reaches the app's static files any more: a catalog is served merged,
  under its exact name (`/i18n/<lang>.json` for a language of `app.languages`), and anything else
  there is a `404`. On a case-insensitive disk (Windows, macOS) `/i18n/EN.json`, `/I18N/en.json`,
  `/i18n/en.json::$DATA` or `/i18n%5Cen.json` used to answer `200` with the app's raw `en.json`,
  without the suite's texts.
- `tools/conformance.js`: a new check, "Only the merged catalogs are served under /i18n/"
  (`xx.json`, `EN.json`, `/I18N/en.json` answer `404`).

## 0.29.0 — 2026-10-03

- `tools/conformance.js`: the platform checks every app inherits, against a running copy over plain
  HTTP (nothing outside the app is called): security headers, `/health`, `/version` and the
  fingerprint, JSON 404s on discovery paths, the MCP `401` with its Bearer challenge and the
  metadata it points at, every language saying what English says, sign-in, the session cookie,
  `/api/auth/me`, CSRF, sign-out and the brute-force brake (with a made-up username, so the real
  account still signs in). `checkConformance()` returns the results for an app's smoke test;
  `node tools/conformance.js <url>` prints them, with `CONFORMANCE_USER`/`CONFORMANCE_PASSWORD`
  for the sign-in checks and `--no-brake` for a copy people use.

## 0.28.0 — 2026-10-03

- **Breaking for installs:** old variable names are no longer read. `RECARGA_EN_CALIENTE`,
  `PORT_HOST`, `PUERTO` or `PUBLIC_URL` in the environment stop the start with a message that
  names the new one (`HOT_RELOAD`, `HOST_PORT`, `BASE_URL`): an alias would keep an install on the
  old name forever. An empty one, as compose passes an unset variable, counts as absent.
- `BASE_URL` is required when `NODE_ENV=production` (the images set it): a localhost guess would
  half-work there (no Secure cookies, a wrong OAuth issuer) instead of failing.
- `CONVENTIONS.md`: renames keep an alias only for what clients hold (MCP tools, `localStorage`
  keys); environment variables don't.

## 0.27.1 — 2026-10-02

- `config.js` reads every old name that `CONVENTIONS.md` lists, with its warning: `PUBLIC_URL`
  now sets `BASE_URL` when that one is unset (Tracker's name for it), and `PUERTO` warns like
  `PORT_HOST` does. When both names are set, the current one wins and nothing is said.

## 0.27.0 — 2026-10-01

- The admin panel (`/admin`) wears the Cronum Studio brand: `web/kit.css` has warm neutrals from
  cream and ink instead of the neutral tokens, the product's colour (`app.color`) is the accent
  (lightened with cream in the dark theme, where a dark colour would vanish; ink, or yolk in the
  dark, without one), the app's icon (`app.icon`) is the favicon and sits in the header, and
  "by Cronum Studio" closes the page. The server fills `web/admin.html` with the app's id, colour
  and icon, so the theme the app saved in the browser (`<app>.theme`) applies before the first
  paint.
- `brand.js`: what the suite's screens share — `textOn()`, the colour as a style attribute, the
  signature — used by the OAuth screens and the panel. `oauth-page.js` still exports `textOn`.

## 0.26.0 — 2026-09-30

- `oauth-page.js`: the OAuth consent and error screens are the same in every app, with the
  Cronum Studio brand: the yolk gradient behind (a yolk glow over ink in the dark theme), a card
  with the app's icon, name and colour on its main button, and the "by Cronum Studio" signature
  under it (monochrome ink on yolk: never eggplant on yellow; the version for dark backgrounds in
  the dark theme). It replaces the plain page and the page each app dressed itself, which an app
  can still pass (`hooks.oauthPage`); the texts hook (`hooks.texts`, `createTexts`) is as it was.
  Everything is the app's own: styles in `web/oauth.css` (at `/suite/oauth.css`), the theme with
  `/suite/theme.js`, the icon from the app; no fonts or anything else from elsewhere, as the
  screen's CSP wants.
- `suite.config.js`: `app.color` (`#RRGGBB`, the product's colour; ink when absent) and
  `app.icon` (a path on the app, `/icons/favicon.svg` by default, with its `?v=` when the icons
  carry one), checked on start. The text on the button is white unless the colour is too light
  for it (`textOn()`).
- `oauth.js`: `page({ lang, title, body, theme })`: the person's own theme (`users.theme`,
  `light` or `dark`) when the screen knows who they are, so it follows the app from the first
  paint.
- `web/theme.js`: keeps a `data-theme` the server already wrote, and reads the app's own saved
  choice (`<app>.theme` in `localStorage`, when the page names the app with `data-app`) before
  `suite.theme`.

## 0.25.0 — 2026-09-29

- `portability.js`: copies of the data, for every app that says what its data is
  (`createApp({ …, portable })`): someone's own copy ("Download my data", `GET /api/me/export`) and
  the whole install's for the admin (`GET /api/admin/export`), as a zip with `manifest.json`,
  `data/<table>.json`, `suite/grants.json` (the plans the admin gave) and `files/<path>` (the
  attachments byte for byte). Importing uploads the copy (`POST /api/me/import`,
  `/api/admin/import`), answers what it would do, and applies it (`POST …/import/:id`) in one
  transaction: new ids, every reference translated (also those to a later table or the same one,
  set at the end), shares, the numbers people see, dates, the trash and attachments kept. A
  person's copy goes into the account that imports it and leaves out what is shared with other
  people, counted; a whole install's goes, account by account, into the account here with the same
  email, a new one (linked by WorkOS or OIDC when that person signs in with that email) or
  nowhere, and "replace" empties an account first. Passwords, second steps, sessions, tokens,
  OAuth grants and push subscriptions never travel. The file is untrusted input: unknown tables or
  columns, values that aren't plain, duplicate ids, a newer schema or another app's copy are
  refused; references outside the file go nowhere; attachments must be images or PDF by their
  first bytes; a copy is applied once (`data_imports`). The plan's limits hold on someone's own
  import (`check`, and attachments left out when the plan has none).
- `zip.js`: zip archives with no dependencies (`node:zlib`): written to any stream an entry at a
  time with its back-pressure, ZIP64 past 4 GB or 65,535 entries; read through the central
  directory, each entry inflated no further than it declares and checked against its CRC; refuses
  encryption, split archives and unknown methods. Opened by Windows, macOS, `unzip` and Python.
- `tools/data-cli.js`: the same from the command line, for each app's `scripts/data.js`:
  `export <file> [--account <user>]`, `import <file>` (what it would do) with `--email`, `--to`,
  `--new`, `--username`, `--skip`, `--replace` and `--as`, and `--apply`.
- `web/admin.js`: a "Data" tab (with `modules.data` in `/api/auth/config`): download the copy of
  the whole install, upload one, choose where each of its accounts goes, and import it.
  `web/api.js`: `api.upload(path, file)`.
- `accounts.js`: `create(fields, { quiet: true })` makes an account without the app's welcome
  content (an imported account arrives with its own); `USERNAME` exported.
- `uploads.js`: `storedName({ folder, name, ext })`, the name every stored file gets.
- Suite migration 14 (`data-imports`). `i18n/`: the errors (`zip_*`, `import_*`, `data_busy`), the
  fields and the admin panel's "Data" tab, in English, Spanish, French and German.

## 0.24.1 — 2026-09-29

- `checkOrigin`: `Origin: null` with `Sec-Fetch-Site: same-origin` is the app's own page. Under
  `Referrer-Policy: no-referrer` browsers send `null` even on a form posted to their own server,
  and the OAuth consent screen had that policy: pressing "Allow" answered `cross_site_request` to
  anyone already signed in to the app, so connecting Claude failed. Still refused: `null` that is
  cross-site, same-site or says nothing.
- The plain OAuth screens (when the app doesn't dress them) use `Referrer-Policy: same-origin`:
  the same privacy towards other sites, and the browser keeps the `Origin` on its own forms.

## 0.24.0 — 2026-09-29

- `uploads.js`: the attachments of Tasks, for every app (`suite.uploads` with `modules.uploads`).
  `store(req, { folder, name })` streams the raw request body to
  `DATA_DIR/uploads/<folder>/<random>-<name>`, deciding the type by the first bytes (JPG, PNG, GIF,
  WebP, PDF; never SVG) before anything touches the disk, written as `.partial` until complete;
  `serve()` sends a file once the app checked who may see it (`nosniff`, `private, no-cache`,
  ETag, the name in UTF-8, a read error cuts the download instead of the process); `remove()`,
  `resolve()` (never outside the folder) and `sweep(livePaths)`, which refuses when the database
  knows no file or more than half the folder would go. Names are the same on every server.
- `i18n/`: `file_type`, `file_too_large`, `file_empty`, `upload_cut`, `file_missing`.

## 0.23.0 — 2026-09-29

- `push.js`: Web Push from Tasks, with no dependencies: the message encrypted for each device
  (RFC 8291, aes128gcm) and signed with VAPID (RFC 8292). The install's keys come from
  `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` or are generated on the first start and kept in the
  database; a wrong or half pair is warned about and the install's own are used. One subscription
  per device with its language, in Tasks' own table (its subscriptions survive), endpoints checked
  before the server visits them, gone ones and ones failing three times pruned.
  `sendTo(userIds, payload)` takes a payload or a function of each device (its language).
- `config.js`: `modules.push` (off by default) and `VAPID_SUBJECT` (else `mailto:ADMIN_EMAIL`, or
  the app's https address).
- `api.js`: `/api/push/config`, `/api/push/subscribe` (POST, DELETE), `/api/push/devices` and
  `/api/push/test` (a test notice to every device of the person, in their language).
- Suite migration 13 (`push-subscriptions`). `i18n/`: `push.test` and the names of the fields.

## 0.22.0 — 2026-09-29

- `app.js`: an account that changes tells the person's open tabs, with `event: account` on the
  live channel: an email confirmed from its link (which usually opens in another tab or on the
  phone, so the tab with Settings open kept saying "not confirmed" until reloaded), a new
  password, the second step turned on or off or its codes renewed, what the admin changed, and
  the admin signing them out everywhere.
- `accounts.js`: `whenChanged(hook)` and `changed(id)`. `update()` writes, and says, only what
  really changes: the same name or language is no longer a change.
- `two-factor.js`: `onChange(userId)` when it is turned on or off, or the codes renewed.

## 0.21.0 — 2026-09-29

- `live.js`: the live channel Next, Tasks and Projects each had, once. One SSE stream per tab
  (`retry`, a heartbeat every 25 s, `X-Accel-Buffering: no`, `hello` on opening);
  `suite.live.publish({ audience, data, event })` sends a notice to the user ids in `audience`
  (everyone connected without one). New: every event has an id (`<run>.<n>`) and the last 256 are
  remembered, so a tab that reconnects with `Last-Event-ID` gets what it missed; when that is not
  possible (too much missed, another run of the server) it gets `event: resync`.
- `config.js`: `modules.live`, off by default. With it on, `createApp()` serves
  `GET /api/events` for whoever is signed in and closes the open tabs on shutdown; off, the app
  keeps that path for itself, so an app with its own channel doesn't lose it on moving up.

## 0.20.1 — 2026-09-29

- `i18n/`: `errors.billing_provider_error` and `errors.billing_provider_unavailable`, which
  `stripe.js` sends since 0.18.0 without a sentence (people read "Something went wrong").
- `test/i18n.test.js`: every error code the modules throw has its sentence and every field they
  name has its name, read from the code, so the next one is caught here and not in an app.

## 0.20.0 — 2026-09-29

- `web/qr.js`: QR codes with no library, for what an app shows to be scanned (the second step's
  `otpauth://` address). Byte mode (UTF-8), error correction level M, versions 1 to 10 (up to 213
  bytes), the mask with the lowest penalty. `qrMatrix(text)` runs in Node too; `qrSvg(text, {
  label })` builds an `<svg>` node by node, black on white whatever the theme, with the quiet
  zone. Tested against the standard's published values, each version's codeword count and a
  decoder in the tests, and read back by a reference reader (ZXing).
- `web/kit.css`: `.kit-qr`.

## 0.19.0 — 2026-09-29

- `two-factor.js`: two-step verification for local accounts. A code from an authenticator app
  (TOTP, RFC 6238) after the password, or one of ten recovery codes (kept as hashes, each once).
  The secret is kept encrypted with a key derived from the session secret; each code works once;
  a signed challenge of five minutes goes between the steps, and five wrong codes per account stop
  it for the window. Suite migration 12 (`two-factor`): `user_two_factor`, `user_recovery_codes`
  and `users.two_factor_at`.
- `api.js`: `POST /api/auth/login` answers `{ two_factor_required, challenge }` for whoever has it
  on, and `POST /api/auth/login/code` opens the session with the code (saying how many recovery
  codes are left when one is used); a new password from a link needs the code too
  (`two_factor_required`, then `code` with the rest), and nothing changes without it.
  `/api/me/two-factor` (status), `…/setup` (the password), `…/enable` (a first code), `…/disable`
  and `…/recovery-codes` (the password and a code); `DELETE /api/admin/users/:id/two-factor`. `/api/auth/config` says `two_factor`. Asking for the
  current password again (a new password, the second step's settings) now has the brake of
  sign-in.
- `oauth.js`: `secondStep`: the consent screen asks for the code after the password before giving
  permission; `createSuite()` wires it with local accounts.
- `accounts.js`: `publicUser()` says `two_factor`; `verify(…, { signIn: false })` checks a password
  without noting a sign-in (a second step may come), and `checkPassword()` is exported.
- `account-mail.js`: `resetPassword(…, { before })` lets a check refuse it once the link and the
  password have passed, outside the transaction so what it counts stays counted.
- `rate-limit.js` and `config.js`: `rateLimits.code` (5), with `checkCode`, `codeFailed`,
  `codeSucceeded`.
- `crypto.js`: `encryptText()` / `decryptText()` (AES-256-GCM, `v1:iv:tag:data`).
- `web/admin.js`: "Turn off two-step verification" in an account that has it.
- `i18n/`: the second step's errors, fields, consent screen texts, admin texts and audit actions.

## 0.18.0 — 2026-09-29

- `stripe.js`: Stripe as billing's provider (`BILLING_PROVIDER=stripe`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`). Hosted Checkout —a subscription or a one-off payment, for a person or
  a group— and the Customer Portal, with plain `fetch` and no SDK; the `Stripe-Signature`
  header checked (several v1 while a secret rolls, five minutes of tolerance); subscription,
  paid one-off payment and full refund events turned into the suite's, with who pays and what
  carried in the metadata and a portal change recognised by its price. What Stripe refuses goes to
  the log and the request gets `billing_provider_error`.
- `billing.js`: the adapter is told the product's kind; a provider that sells prices
  (`needsPrice`) refuses a product without its `price`.
- `config.js`: `BILLING_PROVIDER` takes `stripe` or `remote`; the Stripe keys are checked on start,
  and a live key without an https BASE_URL is warned about.

## 0.17.1 — 2026-09-29

- `app.js`: the first administrator never gets a password from an example: the values the apps'
  own `.env.example` files carried before the suite (`cambia-esta-clave`, `cambia-esto`) count as
  not set too, and a random one is printed instead.

## 0.17.0 — 2026-09-28

- `mail.js`: `checkSmtp()` and `mailer.verify()` check an SMTP server without sending anything:
  it answers, encrypts as told and takes the account; a MailError says what failed.
- `app.js`: with `MAIL_PROVIDER=smtp`, the app checks the mail server once it listens and logs
  `[mail] SMTP ready: host:port (security)` or why nothing will be sent.
- `account-mail.js`: a message the server can't send is logged with its reason and the request
  gets `mail_failed` (502) instead of an internal error. Asking for a new password still answers
  the same, whatever happens, so it can't tell who has an account; an invitation comes back
  `sent: false`.
- `http.js`: `clientIp()` without a request (a script run on the server) is an empty address
  instead of an error, so account-mail can be used from scripts.
- `i18n/`: `errors.mail_failed`.

## 0.16.0 — 2026-09-28

- `api.js`: `/api/auth/config` also says whether mail leaves the server (`mail`: false with
  `MAIL_PROVIDER=log`) and the shortest password accepted (`password_min`, null with an identity
  provider), so screens stop promising links that won't arrive and forms check the same length
  as the server.
- `account-mail.js`: an invitation made without a mail server comes back `sent: false`; its link
  is returned as before, to pass on by hand.
- `accounts.js` and `PATCH /api/admin/users/:id`: `email_verified` lets an administrator confirm
  an email by hand, or take that back; changing the address and confirming it can go together.
- `web/admin.js`: "Email confirmed" in each account, a notice in Invitations when the install
  sends no mail, and the invitation's text says so instead of "sent".
- `api.js`: signing up, and a new password from a link, count as signing in: the admin panel no
  longer shows "Never" for someone who came in that way.
- `i18n/`: `fields.email_verified`, `admin.users.emailVerified`, `admin.users.confirmByHand`,
  `admin.mail.off`, `admin.invitations.noMail`; an invitation's date reads "Created" (it may not
  have been sent), and "admin" sign-up reads "only people you add or invite get in".

## 0.15.0 — 2026-09-28

- `web/`: the web kit, served by `createApp` at `/suite/` with no build. `dom.js` (`el()`, `$`,
  `$$`, `append`, `clear`: nodes made with `textContent` and attributes, never HTML strings),
  `i18n.js` (`t()` in the browser with placeholders and plural forms, exact ones like `=0`
  included; flat or nested catalogs; `pickLanguage()`, dates in the person's language), `api.js`
  (JSON requests; `ApiError`, `SessionExpired` and `Offline`; `errorMessage()` turns a code into
  its sentence), `ui.js` (toasts, fields, dialogs on the native `<dialog>`, confirmations),
  `theme.js` (the saved or the system theme, before the first paint) and `kit.css` (light and
  dark).
- `web/admin.html`, `web/admin.js`: the admin panel at `/admin`, when `modules.admin` is on.
  Accounts (create; name, email, role, plan; extras granted per feature, with an end date and a
  note; a new password; signing out everywhere; disabling; removal), invitations with the link to
  pass on, what each plan allows, organizations when that module is on, and the activity log with
  filters and paging. In the person's language and with the app's name, only for an
  administrator, and with no inline script, so the CSP stays `script-src 'self'`. A feature is
  named by the app's `features.<key>` text when there is one.
- `api.js`: `/api/auth/config` also says which app this is (`app`: id, name, languages, and the
  modules that are on).
- `accounts.js`: an account says whether its email is confirmed (`email_verified`).
- `i18n/`: the admin panel's texts, `errors.generic` and `errors.offline`.

## 0.14.1 — 2026-09-28

- `accounts.js`: saving the same email again (in other capitals or with spaces) keeps it
  confirmed; only another address has to be confirmed again.

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
