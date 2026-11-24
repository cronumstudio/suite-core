# Changelog

Versions follow [semantic versioning](https://semver.org/); while in `0.x`, a minor version may
change an interface and a patch never does. Apps pin a version through the submodule pointer.

## 0.331.0 — 2026-11-25

- **Where each account came from** (`origins.js`, with `modules.origins`; new suite migration 38,
  `account_origins` and `origin_payments`): kept when the account is made and never written over,
  the tag of the link it followed (`?src=reddit-mcp`; `?utm_source=` or `?ref=`, which some sites
  add to the links they list, when there is no `src`), the domain of the site before, never its
  page, and how the account was made: on the web, from the phone app's connect page, or by an
  assistant's token. A tag is text from outside: 1 to 40 of a-z, 0-9, `.`, `_` and `-`, in lower
  case, or it is none; a site is a domain of 80 characters at most, and never this install's own
  nor its sign-in provider's.
- **Nothing is kept on anyone's device for it.** The tag and the site travel in the address
  (`/auth/login?src=…&via=…`; the kit's sign-in adds them from the page's own address and
  `document.referrer`, `web/signin.js` `arrivalQuery`) and to the provider and back as one more
  part of the state the sign-in already keeps for itself (`workos-accounts.js`, `oidc.js`: its
  30-minute cookie at /auth, gone on return). The provider is told nothing of them, and what comes
  back is checked again before it is written. An app without `modules.origins` signs in exactly as
  before.
- **Every payment is noted with its account's origin as it was then**, since `billing.js` keeps
  what someone has now and not what they paid: the web provider's `payment` events with what was
  charged (`billing.whenPaid`), and the stores' purchases and renewals, one per paid period
  (`stores.whenApplied`). A store's purchase arrives without an amount, so a store product may now
  say `amount` and `currency` (`stores.products.<key>`, both or neither, never charged from
  here): its payments are noted with that, marked as an estimate. A refund marks its payment. An
  account that goes takes its origin and its payments' rows with it. An account the admin makes, in
  /admin or through the administrator's connector, has no origin.
- **The admin sees an account's origin** in its dialog, in a fold of its own: the link's tag, the
  site, how the account was made and what it has paid (`GET /api/admin/users/:id/origin`). In a
  host it is the root's, as the affiliates are.

## 0.330.0 — 2026-11-25

- **A host's first questions are gone** (`host.js`): the first start no longer asks how someone
  heard of the app nor whether they have a channel, blog or newsletter. Asking in the middle of a
  first start is in the way, and where an account came from can be known without it (0.331.0).
  The option `firstQuestions` does nothing if a host still passes it; GET /api/modules no longer
  says `first_questions`; `PUT /api/me/first-answers` and
  `GET /api/admin/users/:id/first-answers` are not there (404); the admin's «First time» fold,
  the export `HEARD_FROM` and the kit's texts (`kit.firstQuestions.*`, `admin.firstAnswers.*`)
  are removed. A host's page that asked stops calling them.
- **Host migration 14** drops `host_first_answers`: what was answered goes with the questions. A
  host that wants those answers copies the table out before it updates.

## 0.328.0 — 2026-11-25

- **Invitations with the plan, before anyone has an account** (`creator-invitations.js`, with the
  affiliates and `affiliates.invitations`; new suite migration 37, `creator_invitations` and
  `creator_invitation_uses`). The admin says only what they know: a name and an email, or neither;
  the plan for some months, until a day, or for good; a creator, with their creator's code (one
  from the name when none is given: `MARIA20`, or theirs to write on the page) and the campaign's
  terms, the creators' own by default, or the plan alone (`creator: false`); and, for a link that
  names nobody and gives the plan alone, how many accounts it makes (`uses`, up to 1000: one link
  for the people of a forum). The answer is a link, `<baseUrl>/i/<token>`, to send in person: no
  email goes from here.
- **Nothing is made until someone enters**: no account, no code, no discount at the provider. Then,
  at once and in one transaction: the account (its email taken as confirmed only when the invitation
  named it, since the link reached that inbox; one they wrote, the identity provider confirms as any),
  the plan as a grant of the admin's with its end or none, for a creator their code
  (`affiliates.campaignFor`) with its discount at the provider made just before (switched off again if
  the rest fails), and the sample data if they asked and the install has them
  (`suite.sampleData.seed(user, { locale })`). With a password where the install may make one: its
  own passwords, or WorkOS where it owns the logins (`accounts.adminIdentity`), signed in with the
  password grant (`workos.authenticateWithPassword`, `signInWithPassword`); a step WorkOS still wants
  (a second factor, an email to confirm) leaves the account and the invitation made, and AuthKit's
  page for the rest. An email that has an account (here, or a login of another app of the suite)
  signs in with it, and the invitation is claimed on the way back; so does whoever goes by Google
  (`affiliates.invitations.google`; `/auth/login` takes `provider=google` and `hint=<email>`). Each
  account takes a link once.
- **Its page** (`web/creator-invitation.js`), one short screen in the app's colours: «Hi, María. Your
  Pro account is ready» («Hi there» on a link for anyone), the plan it gives, the email fixed or a
  field for theirs, a password, a creator's code written already and checked as they type (capitals
  and digits, no hyphens, unique; a free one offered when it is taken), the sample data's box, the
  terms' line (`affiliates.invitations.terms` and `privacy`) and «or sign in with Google». Someone
  else's account signed in in that browser is told and offered to sign out first. An account made
  there has `creator` (or `invitation`) as its origin's tag where the install keeps origins.
- **Its days** (`affiliates.invitations.days`, 30): an invitation past them loses the name, email,
  link and terms it held; a keyed hash of its email stays, so a second invitation to the same address
  is 409 `already_invited` (or `force`), as is one to an account that is a creator's already. One for
  one person forgets the name and the email as soon as it is used: the account has them.
- **/admin › Affiliates › Invitations with Pro**: «New invitation», a row per invitation with whom
  it is for, its plan, its code or «Pro only», its state and uses, the link to copy while pending and
  «Revoke». For other callers: `suite.creatorInvitations` `create`, `list`, `get` (with the accounts it
  went to), `revoke`, and `/api/admin/creator-invitations` (GET, POST, GET and DELETE `/:id`).
  /api/auth/config says `modules.creator_invitations`.
- The hint of a campaign's code in /admin no longer says it takes hyphens: the provider takes none.

## 0.322.0 — 2026-11-24

- **Sample data** (`sample-data.js`, `createHost({ sampleData })`): one example in every module
  someone uses, to try the app or record it without typing anything in. `true` is one example;
  `{ examples: ['cafe', 'app'], words: 'samples.' }` several to choose from, named in the host's
  catalog. Each module gives its part in `createModule().sampleData` (`seed` and `remove`, both
  synchronous); the host asks the modules the person uses for the example they chose, each in a
  transaction of its own and in their zone, in the language they asked for, chose or browse in,
  writes down which example and what was made (`host_sample_data`, `host_sample_items`, host
  migration 13) and links the things that play the same part in the story across modules
  (`anchors`). Taking it away gives each module back what it made: all of the example goes, also
  what the person added or changed inside it, with the links to it; what they have outside it
  stays. `GET`, `POST` and `DELETE /api/me/sample-data` at the host's root, `suite.sampleData` for
  the host's own code, and Settings › Sample data in the host's group of every module (its config
  says `host.sampleData`), with a dialog to choose where there are several and a question before
  taking it away. One example at a time: a second is 409 `sample_data_present`. A module whose seed
  fails is named in `failed`, never the whole answer. Without the option, nothing of it is there.
## 0.321.0 — 2026-11-24

- **The administrator's connector** (`admin-mcp.js`, `modules.adminMcp`, off by default): an MCP
  endpoint of its own at `/admin/mcp`, so an assistant can do what /admin does when the
  administrator asks it to. It isn't the app's /mcp, whose `tools/list` doesn't change, and no
  token of one opens the other.
  - **Its own authorization server**: oauth.js at `/oauth/admin/…`, issuer `<BASE_URL>/oauth/admin`,
    metadata at `/.well-known/oauth-protected-resource/admin/mcp` and
    `/.well-known/oauth-authorization-server/oauth/admin`, its own tables, refresh tokens of 30 days.
    It runs with any sign-in: with WorkOS, AuthKit stays the /mcp's and this one is the app's.
  - **Only an administrator may give it permission**, and only after confirming who they are
    again: with WorkOS their password (and code) there, or a sign-in again for whoever signs in with
    Google & co., as `confirmAdmin` asks before changing someone's identity; with passwords here,
    theirs (and their code). An open session alone gets no code. Someone signed in who isn't one
    sees why, with no button to press. A token opens nothing once its account is no administrator
    or is disabled; /admin › Connector lists what is connected and takes it back.
  - **Its tools**: `find_accounts`, `get_account` (who, when, plan and grants, what it pays for,
    usage counts: never content), `list_plans`, `set_account_plan` and `clear_account_plan` (with
    its end), `disable_account` and `enable_account` (never an administrator's, nor one its owner
    asked to delete), `list_affiliates`, `get_affiliate`, `record_affiliate_payout` (a note of a
    payout made elsewhere), `create_test_account`, `delete_test_account` and `read_activity`.
    `readOnlyHint` on the reads, `destructiveHint` on every change.
  - **Rules the server keeps**: a test account's email must fit a pattern of
    `ADMIN_MCP_TEST_EMAILS` (`someone+*@example.com`; one that would allow every address is left
    out, and said at the start); only the accounts it made, noted in `admin_mcp_test_accounts` with
    the email they were made with, are deleted, and not one that pays for something. Never roles,
    passwords, second steps, the modules' content or payments.
  - **Every call is in the audit log**: `admin.mcp.read` for the reads, the changes under their
    usual actions, `admin.mcp.refused` for what was refused, each with `via: "admin MCP · <client>"`,
    and `admin.mcp.connect` and `admin.mcp.disconnect`. What people wrote (their names, a creator's
    note) comes as `{ "untrusted_text": "…" }`, which the server's instructions say never to follow.
- **Migration 36 (`admin-mcp`)**: the connector's tables. Created whether it is on or not.
- **oauth.js serves a second endpoint too** (`resourcePath`, `routes`, `issuerPath`, `tables`,
  `refreshDays`, `adminsOnly`, `whenGranted`; `allGrants()` and `revokeAnyGrant()`): with its
  defaults it is the app's /mcp's as before, every path and table the same.
- **Accounts made by the connector are the administrator's** (`request-scope.js` `byTheAdmin`): no
  new-account notice (admin-notices.js) and no code's cookie (affiliates.js), as with /api/admin/….
- `registerWorkosSecurityApi` also returns `reauthKind(admin)`: what `confirmAdmin` will ask. A
  host hands each account's usage to its root app (`createApp({ adminUsage })`).
- **An MCP client's answers go chunked wherever it asks** (`http.js`): a request with
  `MCP-Protocol-Version`, which clients also send while they find the authorization server, gets
  its answer without a `Content-Length`, as a path ending in /mcp already did. Avast's Web Shield
  breaks those answers otherwise, and the official MCP SDK couldn't read the metadata through it.


## 0.317.0 — 2026-11-20

- **Breaking for installs: the two catalogs besides `cronum-work` are named by how their plans are
  held** (`plans.js`). `cronum-per-group`: Free and Pro, which belong to a group: granted to an
  organization (bought by its owner or an admin, or a trial, a grant with an end) and reaching
  every member. `cronum-per-seat`: Free, Pro for one person, and `org`, an organization's plan
  whose quantity is its seats (`organizations.seatRoles`), now shown as Team, which the suite's
  catalogs translate. Their plan ids, keys and values don't change, so the grants already kept
  match as before. An install whose `PLANS` gives a catalog by an earlier name doesn't start until
  it gives the new one: there is no alias, as with the variables renamed in 0.28.0. An app that
  names one of them changes `PLANS` in the same deployment that moves its submodule up.
  `PLANS=cronum-work` and its installs are as they were.
- **A `PLANS` that names no catalog says that alone** (`entitlements.js`): `PLANS "…" is no catalog
  of the suite (cronum-work, cronum-per-group, cronum-per-seat) and no JSON`, without the second
  message about the plans' shape it brought when the app had no plans of its own. The start stops
  as before, in an app and in a host.
- **`app.accent`** (`config.js`, `brand.js`, `oauth-page.js`): the accent's measured steps for the
  pages the suite draws itself, `{ light, on, dark, onDark }`, each `#RRGGBB`. Next to `app.color`
  they are written on the page's `<html>` as `--app-accent`, `--app-on`, `--app-accent-dark` and
  `--app-on-dark`, so an app that tokens.css doesn't list wears the same accent on the admin panel,
  affiliates, the connect page and the not-found page as on its own pages. Left out, those pages
  are exactly as before; a misspelt key, a colour that isn't `#RRGGBB` or an accent without
  `app.color` stops the start.
- **tokens.css lists the suite's own apps** (Tasks, Projects, Next, Notes and Cronum Work, inside
  Work's windows too): the `--cr-product-*` colours and the `:root[data-app]` accents are theirs
  only. Any other app sets the five `--app*` variables under `:root[data-app="<its id>"]` in its
  own sheet and gives `app.accent` for the suite's pages; one that read an accent or a
  `--cr-product-*` colour this file no longer has moves it into its own sheet.
- **`tools/i18n.mjs`**: `BRAND_WORDS` holds the brand, the suite's own apps and the protocols. An
  app passes its own name in `allow`, which `app` now takes as `--allow <word>` (once per word), or
  marks the line that writes it `i18n-exempt`; otherwise a name the list doesn't have is flagged
  where the app's pages write it.
- **Comments and tests say what each mechanism does**: a group's own plan, seats by role, a device
  that belongs to the app, the phone's connect page, one row per group. The tests' apps are `demo`,
  `acme` and `fam`, and the seat role in the examples is `agent`, also in the start message of
  `organizations.seatRoles`. New tests: the catalogs' and their plans' names are fixed, since
  installs and grants hold them; an app or a host whose `PLANS` names no catalog stops with that
  one message; `app.accent` on each page the suite draws; `--allow`.

## 0.316.0 — 2026-11-20

Offers by email kept by the sharing engine for every module, with one rule that never tells the owner whose an
address is; grouped notices written once; and a module's public page started by the kit.

### Sharing
- **`createAddressOffers({ db, table, kinds, … })`** writes a module's offers by email once: kept under the address
  whether an account has it or not, listed to the owner by the address (whole to whoever typed it, masked to anyone
  else) under the offer's negative id, changed and taken back by that row with the account waiting behind it, and
  claimed by whoever signs up with the address once it is confirmed (a read first, a write only when something
  waits).
- **A kind with `addressOffers`** lets the engine do this itself: the same notices for the owner either way, the
  offers in `list()` and `sharesOf(…, { viewer })`, `PATCH`/`DELETE …/-<id>` (and `setPermission`/`remove` with a
  negative id), `accept()` claiming first, and `claimAddressOffers(userId)`.
- **One rule for every kind**: an offer under an address goes only when the invitation it brought is accepted or
  declined, or its owner takes it back. Nothing else the account does moves it (answering an offer made by name,
  leaving, a permission given by name), so the owner's list never tells whose an address is. Kinds without
  `addressOffers`, and every earlier signature, are unchanged.
- **`share-mail.js shareNotices({ suite, get, texts, url, kinds })`**: createSharing's `notify` as every module wrote
  it: the email, the email to an address without an account, and the push in the kit's words, tagged by the thing.
  Each module's own parts are options (mail kind, tag, address, no emoji for strangers).

### Grouped notices
- **`notice-groups.js createNoticeGroups({ send, delayMs, failed })`**: notices grouped by key for a few seconds (25 s
  by default, `NOTICE_DELAY_MS`) and sent as one once the key goes quiet; each change restarts the wait, `flush(key)`
  sends one now and `flushAll()` sends what waits when a module stops. A send the timer started that fails goes to
  `failed` (by default the log) instead of becoming an unhandled rejection.

### The public page
- **`startPublicPage({ key, draw, icon, words, title, failed, refusedAs, openClass, reread })`** (`web/public-frame.js`,
  new): a module's public page started by the kit. It reads the page by its token and draws the bar, the foot with
  Cronum's brand, «Nothing to see here», a frame the owner's plan doesn't allow, and the embedded page; the module's
  `draw(data, { page, embedded })` gives only its content. Options cover where modules differ (a page that couldn't
  load with its retry, the refused look, rereading while in sight). It is a file of its own, not in the worker's copy,
  so a tab whose old worker still has the old `public-page.js` gets it from the network.
- **One rule for "embedded"**: `embed=1` in the address, or framed (`embeddedPage`).
- `public-page.css`: the brand under a refused frame is one rule for both looks, and the refused look "as the gone
  page says it" is the kit's. `test/public-page-dom.js` runs a module's public page in the fake DOM.

## 0.315.0 — 2026-11-20

- **A module turned on or off without a signal leaves or joins the rail at once** (`web/settings.js`,
  `web/shell.js`): Settings › Modules kept the change for later and said so, but the rail kept the
  module until the signal came back, while the theme was painted at once. `modulesChanged(answer)`
  sends the modules as they are now in the `kit-modules` event (`detail.answer`, the shape of GET
  `/api/modules`: the server's, or this device's own while the change waits), for the switches, the
  order and the rail's buttons alike, and a module's rail draws from it before it asks the host.
  Cronum Work's shell reads the same answer.
- **Settings › Notifications lists the phones with the app** (`push.js`, `native-push.js`, `api.js`,
  `sessions.js`, `web/settings.js`): with `push.native` the test notice reached a phone while the
  list said no device had notices on. `GET /api/push/devices` now gives the browsers and then each
  working phone with a token (`phone: true`, its device's `id`, the `name` the app gave it, its
  `platform`, when the token came; the phone this request comes from, inside the app, `current`).
  Each phone has «Remove» (`DELETE /api/push/phones/:id`, a person's own only): its token and the
  reminders it said it shows go, nothing more reaches it, and it stays signed in; the app asks for
  notices again when it is opened there with them allowed, as a browser turned on again does. Inside
  the app its own phone says «This device» and has no «Remove»: there the phone's settings decide.
  `createPush` adds `phones()` and `removePhone()`, `createNativePush` `phonesOf()` and
  `forgetPhone()`, `createSessions` `deviceOf(token)`, `registerPushApi` takes `deviceOf`; new
  catalog key `kit.notifications.phoneApp`.
- **Closing a phone app's session signs the phone out** (`api.js`, `sessions.js`, `app.js`): in Settings
  › Where you're signed in, «Sign out» on the session a phone's app opened (devices.webSessions) only
  closed that session; the app opened another at once with its device token, and the phone went on
  getting notices. `DELETE /api/me/sessions/:key` now revokes the device behind such a session
  (`devices.revoke`: its other sessions, its notices' token and the reminders it shows go, and the app
  asks to sign in again), noted in the audit as `device.revoke`. A browser's session closes as before.
  `registerProfileApi` takes `devices`; `createSessions` adds `deviceOfKey(userId, key)`.
- **In a host, Settings › Notifications names the whole app** (`web/settings.js`): «Tasks can notify
  you on this device» became «Cronum Work can…», as every notice comes from the host's one worker.
- **«Replace» and «Erase my data» wait for the password too** (`web/settings.js`): the red button lit
  up once the word was typed, with the password still empty; the server refused it
  (`wrong_password`) and nothing went, but the button said otherwise. Where the person signs in with
  a password (`has_password` here, `method: "password"` at WorkOS) it waits for one.
- **Back to a view, each window in its place** (`web/windows.js`): from «one big and two stacked» to
  2×2 and back, the two stacked windows traded places, because the windows shown were read column by
  column while a shape is filled row by row. `applyColumns()` reads them by rows, and takes
  `places`, each shape's windows the last time it showed, which `writeLayout()` keeps beside its
  bars' shares and `readPlaces(storage, shape)` reads: each module still offered goes back to its
  place, the focused window stays (in a place nobody has back, else the last one), and the rest fill
  as before. `createWindows().columns()` passes them.

## 0.314.0 — 2026-11-20

What every module wrote again, written once in the kit; what the kit still carried and nobody used; and
a payout's date on the person's own day.

### Pieces the modules share now
- **`createPlace({ hash, active, reload, own, base })`** (`web/mount.js`): a module's place in Cronum Work's
  window or on its own page, the contract each `place.js` wrote by hand. Where modules read the shell
  differently, an option (`active`, an opt-in `reload`); what is only the module's goes in `own`.
- **`web/app-start.js`**: what a module's page does as it starts: `applyAppTheme` (with `ifOther`) and
  `followSystemTheme`, `savedTheme`, `watchAppVersion`, `askedSettings`, `markCroppedCanvas` (as it was), and
  for Cronum Work's shell `rgbOf` and `PAINT_ATTRIBUTES`. In the worker's copy of the kit.
- **`web/days.js`**: `dayKey(date)`, the day a moment falls on on this device's clock (`YYYY-MM-DD`; today is
  `dayKey(new Date())`, not UTC's day), and `addDays(day, n)` and `daysBetween(a, b)`, counted in UTC as the
  server does. No DOM and no imports, so an offline model can use it. The kit's stamps and usage view count
  their days with it.
- **`i18n.js reportLanguage(user, lang, { send })`**: the browser's language into `prefs.lang_seen`, once per
  change. **`live.js paintLive`**, **`native.js openAddress(url, { hash })`** (the one builder of `/?open=`
  but the worker's), and **`links.js mountOf`** reads a base with `mount.js ownerOf`, as the shell now does.
- **The frame's `showBanner`** also takes a function; the same words leave a banner as it is, and
  `keptBanners()` lets a frame drawn again in another language show it again. Options as an object work as
  before.
- **Settings**: `aboutExtra` takes `{ text, tips }`, catalog keys the kit draws as every module drew them (a
  function still works), and **`summaryOf(parts)`** joins what a copy holds by Intl's list of units ("2
  projects and 8 tasks"), leaving out the empty ones.

### One's people wait for an answer, in every module
`createSharing`'s `peopleOf` counts whoever offered the person something only once the person accepted it:
an offer not answered makes nobody known to anybody. The `inviters` option goes (a module that still passes
it changes nothing); `knownTo` is as it was.

### What nobody used goes
- **createShell has no account menu**: the app's icon and the rail's Settings open Settings, as they did in
  every app. `accountItems` is ignored; `onSignOut` and `shell.setUser()` are still accepted and do nothing;
  `kit.account.menu` and `kit.account.admin` go.
- **The split view's last pieces**: createHost's `split` option (ignored if given), the rail's split button
  (`SPLIT_LAYOUTS`, `.kit-rail__split`), the icons `layout-2`…`layout-4` and `kit.split.*`. `layout-1` and
  `framedModules` stay; the comments and docs say "a frame of a host's page" where they said the split view.
- **Six texts nothing read**: `admin.actions.mcp_token_create`, `admin.actions.mcp_token_revoke`,
  `kit.update.available`, `kit.plan.until`, `errors.device_not_allowed`, `$meta.locale`.
- `web/oauth.css` drops `--yolk-600`, `--cream` and `--ink`.
- A notice that names no address opens the app at its path, not at `?app`, which means nothing any more.

### Fixes
- **Admin › Affiliates**: a payout's date starts on the person's day, not UTC's (from midnight to one or two in
  the morning in Madrid it said the day before).

### Tools and tests
- **`tools/i18n.mjs unused`** lists a catalog's keys that no code reads, naming each prefix the code builds keys
  from (`unusedKeys()` is exported). A module's keys are read by its own code and by the kit: pass both.
- **`tools/dup-check.mjs`**: the code two modules or more both wrote. Every run of 8 significant lines
  (comments, blank lines, imports and lone brackets left out, spaces collapsed) that two modules have counts once,
  and the runs are joined into blocks. `duplicates(roots)` is for a host's test to keep that count from growing;
  the command takes `name=folder` pairs and `--max`, and fails over it.
- Two tests that failed now and then give the same answer every run: the offers compared in inherit-and-offers
  keep a clock of their own, and the 413 test no longer races the server's close with bytes still unread.
- `docs/web-kit.md` says what `local.js` gives a module that draws from its copy (`deviceLocal`, the patience,
  `inTime`, `createDeviceCopy`, `drawableFor`), and lists `days.js` and `app-start.js`.

## 0.312.0 — 2026-11-20

- **The look's sizes, one scale said by name** (the first of two steps: the kit and the four
  modules; Work's own sheets come second). `kit.css` `:root` gives every `--look-*`
  its Cronum value, a short scale: type 21 / 24 / 22 / 19 / 15 / 15 / 14 / 14 / 13 / 12 / 11 px
  (`large-title` to `caption2`, `base` 15), corners `--look-r-xs` 4, `-sm` 8, `-md` 10, `-lg` 12,
  `-xl` 16, room `--look-gutter` 16, `-row-y` 11, `-row-gap` 10, `-head-y` 10, `-item-y` 9,
  `-bar-y` 10, `-section` 20. The kit's 199 `var(--look-x, n)` lose their number: a size within a
  pixel of the scale takes it (12.5 px footnotes are 13, 13.5 px subheads 14…), one that must not go
  under its own is `max(16px, var(--look-body))` (a field a phone would zoom into, an emoji, the
  note's 26 px title), and the few off the scale are written as they are with a Clean rule for the
  look's (`.kit-md h2`/`h3`, the phone's sheet corners, `.kit-main > h2`, `.kit-avatar--tiny`).
  The Clean look's values are not touched, and what it shows is the same.
- **One family of corners**: `--kit-radius`, `--kit-radius-small` and `--kit-radius-large` are now
  `--look-r-md`, `-sm` and `-xl` (the same 10/8/16 px in Cronum, 12/10/18 in Clean); the kit's rules
  say `--look-r-*`, the old names stay for sheets that still use them.
- **`tools/css-rules.mjs`** (new): `lookFallbacks(css)`, `physicalSides(css, { allow })` and
  `layoutWidths(css, { containers })`, the kit's rules for a sheet, for a module's tests to read its
  own with. `web-kit-css.test.js` fails on a look variable with a number beside it, on a physical
  side in the kit's sheets that doesn't say why (the drag's ghost, the round check's tick, a
  window's drop place), and on a layout width other than 640 and 960 but the sign-in's 760.
- **Breakpoints, as the kit does them**: `--cr-bp-tablet` is 960 px (it said 860, and
  the list and its detail have always gone side by side from 960); tokens.css no longer says a
  script reads them; web-kit.md names the two widths and when a component's `@container` may differ.
- **A module's page stays put under its frame, said once**: `html` and `body` are fixed
  to the screen, without overscroll and with `touch-action: manipulation`, when a `.kit-app` is the
  body's (a module on its own page); Tasks, Projects and Next drop their copies. A public page and
  Cronum Work's page are left as they were.
- **The public page's hero, numbers and sections**: `public-page.css` draws the hero
  (mark, name, who shares it, badge), the stats and the sections' titles, over `--sp-color` (the
  list's or the project's colour); Tasks, Projects and Next keep only what is theirs. One measure:
  24 px under the hero (Tasks 24, Projects 8, Next 28), 32 between sections (30 or 34), 22 above
  the stats (22 or 26).
- `web/icons.js` `stroke-eraser`: Notes' eraser that takes whole strokes, drawn in Notes until now.
- **docs/web-kit.md**: rules 14 and 16 (both about `blank()`) are one, rule 14; 17–24 are 16–23. A
  new rule 24: a sheet says the kit's measures by name (the look's scale, `--look-r-*`, logical
  sides, 640 and 960). The kit's comments that named a rule by an old number name the new one.

## 0.311.0 — 2026-11-20

- **Texts say the same thing the same way in every module**. Only additions in the code: what was
  exported behaves as before. Rule 25 in docs/web-kit.md.
  - Catalogs, in the five languages: one word for notifications (`kit.notifications.offTitle`,
    `.turnOn`); one phrase for where one signs in; one word each for a step noted and a step done
    (`kit.day.eveningHint`, `kit.plan.benefits.retention*`, `kit.links.done`); one word for the
    address and another for the message (`kit.share.email`, `kit.profile.email.provider`,
    `errors.email_not_found`); the language's own quotes, ’ for an apostrophe and › on a way
    through menus; American English (color, canceled, recognize); `mail.deletion.body` "Hello
    {name},"; `kit.notifications.renew` no longer says "service worker"; `kit.retry` "Try again",
    as the kit's sentences say it.
  - A notice has no full stop when it is one sentence and has them when it is two: the kit's own
    toasts (`kit.share.left`, `kit.plan.*`, `kit.links.*`, `admin.*`…). Errors keep theirs.
  - `kit.public.action`, `kit.public.on`, and the shared page's `kit.public.goneTitle`,
    `.cantEmbed`, `.openPage`, `.startFree`, which the four modules wrote each.
  - The words of a group and of a drop in the sidebar, which Tasks, Notes, Projects and Next wrote
    each: `kit.group.new`, `.edit`, `.delete`, `.none`, `kit.moveUp`, `kit.moveDown`, `kit.dropBefore`,
    `kit.dropAfter`.
  - `share-mail.js` `sharePush({ t, kind, actor, name, role })` → `{ title, body }`: the push of
    something shared, worded once (`kit.share.push.title`, `kit.share.push.<kind>`), for the
    modules' own deliveries, which keep their tag and where a tap goes.
  - `web/public-page.js`: "Close" (`kit.close`) is plain; turning the page on (`kit.public.turnOn`)
    is the dialog's one primary button.
  - `web/ui.js`: a dialog opened from a menu's entry gives the focus back to the menu's button
    once it closes, where the browser left it on the body (the entry went with the menu).
  - `tools/i18n.mjs` `typography(dir)` (straight quotes and apostrophes, → on a way through menus;
    `typography [dir]` on the command line, `--typography` with `app`), `kitDuplicates(dir, langs,
    { allow, overrides })` (with `overrides`, an app's `kit.*` key saying it otherwise), and
    `appChecks(root, { kitOverrides, kitAllow, typography })` to ask for them (`typography: { allow }`
    leaves out keys that must read as another place has them, such as an assistant's instructions).

## 0.310.0 — 2026-11-20

What the modules each wrote on their own, written once here, and two fixes that came with it: an
import no longer overwrites another module's preferences, and no page waits for ever on a hung
IndexedDB.

### The person's time zone
- **A tool runs in the time zone of the person it acts for**, as each module did on its own:
  createApp runs each of the app's MCP tools inside `inZoneOf`, and a host does the same for each
  module's (`hostMcp`). The host's own tools read the day as before: hostMcp says `zoned: true`.
- **`zonedRoutes: true`** (a createApp option, and `createModule().zonedRoutes`, which the host passes
  on): the app's own routes run in the zone of whoever asks. The suite's routes, and modules that
  don't ask, answer as before. A handler's `answeredOnce`/`keyedByRoute` stays.

### Ownership
- **`suite.ownership` is the one every module uses**: `createOwnership({ suite: () => suite })` reads
  the suite's `push`, `shareMail` and `goneBrake` each time a notice goes, so a module's suite in a
  host, or a test's stand-ins, are what it uses. Its words are the app's `hooks.texts`. Its failures
  are logged with the suite's log.

### Sharing
- **`directoryClosed(suite)`**: whether an install's people are strangers to one another (in a host,
  with an identity provider, or with sign-up open to others). One rule for every module.
- **`createSharing({ inviters: 'accepted' })`**: whoever offered someone something joins their people
  (the share dialog's chips) once they accept it. The default is `'offered'`, as before. Naming them
  by id is unchanged.

### Copies
- **`users.prefs` may be the app's preferences**, as createApp takes them: a copy then changes only
  the app's own keys of the one `users.prefs` row (`users.remap` translates their ids). An existing
  account keeps every other key (another module's, the host's) and its language and zone; an
  account the import makes starts from the copy's row. A function there works as before.
- **`planLimit: { feature, count }`** makes someone's own import past the plan answer 402
  `plan_limit`. Any app with a table of files also gets its plan's storage (`storage.mb`) checked,
  first, then the app's `check`.
- **`public_token` and `public_since` never travel**; copies made before still come in, with the page
  off. `importedPrefs()` exposes what an import writes in the preferences, for apps' tests.

### The device's copy (web kit)
- **A patience for IndexedDB** (`web/local.js`): `openLocal(app, stores, { patience })`. Past it,
  what waits for a database that hasn't opened gives up (`local_store_slow`) and isn't done; until
  that open answers, whatever comes next gives up at once; once it opens, all as before.
  `LOCAL_PATIENCE_MS` (1500), `deviceLocal(app, stores)` and `inTime(promise, ms)`. Without
  `patience`, nothing changes.
- **`update(reads, decide)`** on both stores: records read and the stores changed in one transaction,
  done once the database opens even when its caller stopped waiting, before anything asked after it.
- **Whose the copy is**: `createDeviceCopy({ local, stores, account, owner, outbox })` (also
  `store.deviceCopy()`), with `kept`, `account`, `outboxOwner`, `read`, `claim` and `forget`: the
  rules Notes, Next and Projects each wrote their own way. `drawableFor(id, host)`: the copy only for
  whoever Cronum Work's shell says is signed in; also `sameAccount(a, b)`.

### Small helpers written once
- `db.js`: `inBatches(ids, query, { unique })` asks many ids 500 to a statement, and `personId(id)`
  binds what is no id as 0.
- `http.js`: `idParam(ctx, name)`, the id a route names; the field checks `color`, `dateOnly` (on
  `isoDate`) and `intInRange`, each answering the codes its caller gives; `isObject`, instead of
  seven copies. `isoDate` reads a year under 100 as that year when `minYear` allows it; with its
  default years nothing changes.
- `public-page.js`: `publicPageUrl(baseUrl, token)`, a public page's address.

## 0.309.0 — 2026-11-20

What nothing calls any more goes, and a few helpers are written once. Nothing a person, a page or
an AI client sees changes.

- **The MCP**: `userFromToken` and `verifyToken` take no `audience` of another address, and the
  accounts' `resourceMetadata` and `authorizationServerMetadata` go: they were for the apps' old
  connectors (gone in 0.148.0). What `/mcp` and `/.well-known/oauth-*` answer is the same.
- **Out everywhere** (the admin's "sign out everywhere", a new password, a reset) always goes through
  `revokeEverything` (revoke.js): the second, partial way of `registerAdminApi` and
  `registerWorkosSecurityApi` for a caller without it goes, with `registerAdminApi`'s `tokens`,
  `oauth`, `push` and `idp` and `registerWorkosSecurityApi`'s `revokeAtProvider`. createApp always
  passed it.
- **Gone, nothing called them**: `POST /api/devices/push/test` (the phone's test notice is Web Push's
  `POST /api/push/test`, which reaches the phones too) and `nativePush.targetOfDevice`;
  `registerProfileApi`'s `alsoAt`, createApp's `profile` and the host's `parts.profile` (a module
  that still passes `profile` is not refused: it is ignored); uploads.js `isImage`.
- **Options no product passes**: createSuite's `oauthPage` hook (the consent screen is always the
  suite's page); createEntitlements' `isUnlimited`; the `organizationId` option of `cutoff`,
  `better`, `countDaily`, `countWeekly` and `require` (`of()` keeps it); `setPlan`'s `source`;
  `accounts.deleteAtProviders` (an install that still passes it is not refused: the key is ignored,
  and `endSubscriptions` no longer falls back on it).
- **Billing**: the built-in `remote` provider goes, with `BILLING_SECRET` and `BILLING_URL`: no
  install named it. `signedProvider` stays; the tests register the same signed provider themselves
  (`test/remote-provider.js`).
- **Written once**: `requireUser` and `requireAdmin` (http.js), and `iso` (time.js), which every
  file that needed them had its own copy of.

## 0.308.0 — 2026-11-20

- **The pieces every module drew its own way, in the kit**. Only additions: what was exported
  behaves as before.
  - `web/ui.js` `placeFixed(node, anchor, { at, gap, margin, width, minWidth, above, center })` and
    `fixedRoom(node)`: what `menu()` did to stay inside a window of Cronum Work (whose
    `contain: layout paint` makes `position: fixed` start at the window's corner and cuts off what
    leaves it), for any box that floats: Tasks' quantity editor, Projects' drag label, Next's bubble.
    `menu()` uses it, unchanged.
  - `web/ui.js` `highlight(text, query)` (`<mark class="kit-mark">`, accents and case aside),
    `searchTitle()` ("Results"), `searchSection(title, rows, { list })` (a heading with how many)
    and `searchResults({ query, sections, hint })`, with the kit's blank and the search's icon when
    nothing is found: one results screen, each module drawing its own rows. `kit.search.*`.
  - `web/files.js` (new, in the service worker's kit copy): `attachments({ files, editable, mayRemove,
    fileUrl, upload, onUploaded, remove, restore, max, maxBytes, dropTarget, accept })`, an item's
    "Files": photos as thumbnails, a PDF as a row with its name and size, added with the button,
    by dropping a file on the detail or pasting one, one notice for several, the room left said
    first, and taking one away to the trash with Undo. `notYours(file)` keeps the ✕ on someone
    else's file and says whom to ask; `maxBytes` may be a function, asked when the files go up (a
    plan's limit read late). `photoViewer({ photos, start, fileUrl, parent })`, a
    kit dialog with Tasks' zoom (`makeZoomable`), so in Cronum Work it covers the screen.
    `kit.files.*`, `kit.photo.*`; `.kit-files*`, `.kit-file*`, `.kit-viewer*` in kit.css.
  - `web/i18n.js` `shortDate(value)` ("Mar 14", with the year when not this one; a YYYY-MM-DD is the
    local day it names), `timeText(value)` (Intl's short time: one way per language),
    `shortStamp(value, { time })` (the time today, the date before) and `timeAgo(value, { short })`.
  - `docs/web-kit.md`: rule 9 adds the results screen; new rules 22 (files), 23 (what floats) and
    24 (dates).

## 0.307.0 — 2026-11-20

- **One trash vocabulary for every module** (`i18n`, `web/ui.js`, `docs/web-kit.md` rule 21). Tasks,
  Notes and Projects each said their trash their own way: two words for restoring and two for
  deleting for good in Spanish, "permanently" and "for good" in English, four ways of saying it
  can't be undone, two Englishes for how long it keeps things, and an emoji in some titles. The kit
  now has the words, in the five languages: `kit.restore`, `kit.deleteForever` ("Delete for good"),
  `kit.cantUndo` ("This can't be undone."), and `kit.trash.*`: `title` (no emoji), `empty`,
  `keepDays`, `keepForever`, `emptyAction`, `emptyAsk`, `emptyConfirm`, and the notices `moved`
  ("“X” moved to the trash"), `restored` ("“X” is back"), `deleted` ("“X” deleted for good") and
  `emptied` ("N items deleted for good"). New `trashKeeps(days)` says how long a trash keeps
  what is in it, from the plan's days its server sends, or until it is emptied (`null`). Additive: the
  modules move to them and delete their own copies.
- **Erasing a module's data says it can't be undone in the same words** (`kit.data.eraseText`):
  "Everything you have in {app} will be deleted now. This can't be undone.", in place of an older
  phrase, in the five languages.

## 0.306.0 — 2026-11-20

- **One palette and one set of icons for every module** (`web/palette.js`, `web/pickers.js`,
  `kit.css`, `i18n`, `docs/web-kit.md` rule 20). Tasks offered 13
  colours, Notes 12, Projects 10 and Next 8 by name, in other orders and other blues; Tasks showed
  164 emojis at once, Projects 20, Next 16. Now `KIT_COLORS`: twelve colours by name (blue, cyan,
  teal, green, olive, brown, pink, plum, violet, indigo, steel, slate), each with the hex a module
  stores (white reads on it, 4.5:1; it shows on the dark page, 3:1) and a lighter step for the dark,
  the `--kit-color-<name>` tokens of a module that keeps names (Next). `suggestedColor(used, { as, except })`
  proposes the first free one, five apart around the wheel. `KIT_ICONS` are twenty in view and
  `KIT_MORE_ICONS` the rest of Tasks' 164 (none lost). `colorPicker()` and `iconPicker()` offer them,
  each colour named in words for a screen reader (`kit.colors.*`), "More…" unfolding the icons
  (`kit.icons.*`), with what a collection has from before kept, offered first and chosen; options for
  a field to type any emoji (`typed`), for no colour or no icon (`none`), for colours a module leaves
  out (`except`: Projects', too close to its accent and its states) and for names instead of
  hexes (`as: 'name'`). New keys in the five languages; nothing that exists changes.
- **The kit's states read as text** (`kit.css`, `test/web-kit.test.js`):
  `--kit-ok`, `--kit-warn` and `--kit-danger` in light are a step deeper (`#167548`, `#9A5A00`,
  `#BA3429`, from `#1F8A57`, `#A86200`, `#C8372D`), so that each reads 4.5:1 on the page, a panel
  and its soft tint (the badges'); before, «ok» gave 4.10:1 on the page and «warn» 4.26:1 on its
  tint. The palette's violet (`--kit-color-violet`, Projects' «blocked» in words) is the same: a
  step deeper than Projects' bars (`#6e55c2`), it reads 4.5:1 there too. The test now measures
  those pairs in light and dark. Modules write their states in words with these tokens, keeping
  their own vivid colours for bars and borders.

## 0.305.0 — 2026-11-20

- **One banner without a signal, the same in every module** (`web/ui.js` `offlineBanner`,
  `docs/web-kit.md` rule 19). It listens to the
  browser's `offline` and `online` itself, so the banner shows the moment the signal goes, changes
  waiting or not (Notes showed none without them, Tasks only once its probe failed). Offline it
  says what is shown is the last thing loaded and how many changes wait, with a discreet
  "Try again" (`kit.retry`, never primary) when the module passes `retry`; back online, while they
  go, how many are being sent (`kit.offline.pending`); `sent(n)` says they arrived
  (`kit.offline.sent`), or, with `announce`, the piece says it itself once none waits (`announce`
  as a function: and they can go, so none waiting before then isn't taken for sent), less those
  the module says were refused (`dropped()`). It paints in the shell's banner row, or through the module's own
  `show`/`hide`, and again in a new language. New texts in the five languages: `kit.retry`,
  `kit.offline.pending`, `kit.offline.sent` and `kit.offline.droppedWhat` (the dropped change named,
  as Next says it). Nothing changes for a module that doesn't use it.
- **"Needs a connection" as a piece** (`web/ui.js` `offlineNotice`): what only the
  server can show says so in its place, as Settings already did (it uses the piece now); Tasks' and
  Projects' trash use it without a signal.

## 0.304.0 — 2026-11-20

- **One empty and one loading state in every module** (`web/ui.js`, `web/kit.css`, `i18n`,
  `docs/web-kit.md` rule 16). `blank()` takes
  `glyph` (a text in the icon's box: a Tasks list's emoji), `page` (alone in a view, its title an h2),
  `loading` (the kit's spinner and "Loading…", new key `kit.loading`), `note`, an `action` with
  `href` or `primary: false`, and no `title` for a sentence alone. `.kit-blank strong` and
  `.kit-blank h2` are one size now (`--look-headline`): a page's empty view was 19 px, a list's 15.
  Without the new options `blank()` draws what it drew.
- **The add bar is the kit's** (`addBar()`, `.kit-add-bar`, new key `kit.add`; rule 17): Tasks'
  card (a +, the field without a frame, "Add", the module's own tools between
  them), for Tasks and Projects.
- **Notices rise above the add bar** (`toast()`, `.kit-toasts`): each time one shows,
  the kit measures the bars in sight under the notices' place and sets `--kit-toast-floor`, also with
  the keyboard up. With no bar they sit where they always did.
- **The row open in the detail** (`.kit-list-row[aria-current="true"]`, rule 18):
  a soft background in the accent, as Notes' had, for Tasks, Notes and Projects.
- **The detail as a column of its own** (`createShell({ detail: 'column' })`, `shell.setDetailOpen()`,
  `data-detail-open`): from 960 px the list takes the whole width while nothing is open and
  the item opens as a 340–400 px column on its right, folded or not. Tasks and Projects each had a copy
  of these rules; the default (`'beside'`) is the frame as before.
- **`inkOn(color)`**: white where it reads 4.5:1 on a colour, otherwise the dark ink
  (`INK`), for a button in a list's own colour.

## 0.303.0 — 2026-11-20

- **Dialogs look the same in every module** (`web/kit.css`, `docs/web-kit.md` rule 13): the kit's
  header, body and footer, with no line under the title nor over the buttons, are the only ones; the
  modules drop their repaints. The two title rules (`__header h2`, `__titles h2`) are one. Rule 10
  also says how a collection's settings read ("Edit X", Name first) and that deleting it is in its
  "…" menu, never in the form.
- **The small capitals over a group, one measure** (`.kit-eyebrow`, `--kit-eyebrow-size`, `-weight`,
  `-spacing`): the sidebar's sections, Settings' groups and Share's headings take them, the
  same as before in both looks (Clean's spacing is its variable now, not three rules); the modules' own
  labels use them.
- **Kit rules that lived in one module**: no tap flash on a phone and no selection by a long
  press on the frame's controls (Tasks' alone until now), a field's text at 16 px on a touch screen so the
  iPhone doesn't zoom (Notes' alone), and an icon button that is on (`aria-pressed`) in the accent's soft
  colour (Next's alone).
- **`.kit-label`**: a field's label (13/500) where there is no `field()` around it, a block of an item's
  detail over several controls.
- **Who made an item and who changed it, in shared words** (`stamps()`, `stampTime()` in `web/ui.js`,
  `kit.stamps.*` in the five languages, `.kit-stamps`): "Created by Ana · today at 15:52", "Modified
  by Luis · …", as Tasks said it, now for Tasks and Projects. Rules 11 (an empty place
  has the button that does the first thing) and 12 (an item's detail: the kit's labels, `saveState()`,
  its stamps) in `docs/web-kit.md`.
- **A field's label over a group** (`field(…, { groupLabel: true })`, a palette of colours or icons): its
  span takes `.kit-field__label`, the 13/500 of every field's label, as Projects and Next added by hand.

## 0.302.0 — 2026-11-20

- **The sidebar's entries are the kit's in every module** (`web/shell.js`, `web/drag.js`,
  `web/kit.css`, `docs/web-kit.md` rule 11). `navItem()` takes `emoji` (a
  collection's own, in a box as wide as a view's icon, so every label starts in line), `shared`
  (the kit's one mark, `sharedMark({ owner })`, "Shared · by {name}" in words), `marks`, `title`,
  `style`, `className`, `under` (a node under the name, in its column: a project's progress),
  `countTitle`, and `menu` or `onMenu`: a right-click or a long press opens the same menu as
  the entry's «…» (`menuOnPress(node, open)` in drag.js, which a drag that holds the entry answers
  with a `kit:hold` event when it has no `onHold`). A group's head opens its menu with a right-click
  or a long press too (`menuOnPress(head, open, { held: group })`: a group is picked up whole by its
  head). `orderAfterDrop()` is the kit's (drag.js), as three modules had it. Entries and group heads
  have their own line height (1.45): 36 px in every module, 36.5 in Notes before. A colour is as
  wide as a view's icon (17 px with its margins), so every label starts in line, and the mark after
  a group's name is the same one.
- **"n" makes a new item in every module** (`createShell({ onNew })`, rule 12): under
  the same conditions as «/». Settings › About lists the keys (`kit.about.keys`), and `modKey()`
  (keyboard.js) gives ⌘ or Ctrl for words that tell a shortcut.
- **The search runs the same way everywhere** (`search: { onSearch, wait, min }`): 220 ms
  after the last key, from the first letter, at once with Enter, Escape or when emptied;
  `shell.clearSearch()` empties it. A field the module wrote itself away from the results (Notes,
  Next) searches the same words again once typed. `onInput` and `onSubmit` are unchanged.
- **The open collection's emoji in the head** (`head({ icon })`, `.kit-head__icon`): loose before
  the title, at its size, with no box; `setIcon()`.
  `.kit-icon-btn[aria-pressed="true"]` is the kit's (Notes and Next had it each).
- **In Work's shell, its ☰ folds the sidebar where the sidebar sits beside the views**:
  from 640 to 768 px Work shows its ☰, and as a drawer there it did nothing.
- **Icons** (`web/icons.js`): `chevron-up`, `eraser`, `flag`, `fork`,
  `highlighter`, `history`, `marker`, `pen`, `print`, `zoom-in`, `zoom-out`; web-kit.md has a table
  of which icon for what.

## 0.301.0 — 2026-11-20

Sharing: what sharing looks like and says, the same in every module.

- **An invitation is the kit's card, first in the sidebar, and ☰ says one waits** (`web/invitation.js`,
  `web/shell.js`, `web/kit.css`).
  `invitationCard({ from, name, icon, color, what, permission, detail, onAccept, onDecline, offline })`
  and `invitationCards(list, { offline })`: who offers what, what accepting gives ("Read only",
  "You'll be able to edit it", or the app's own line), "Decline" and "Accept" as wide as each other, both off
  while an answer is on its way. Without a signal both stay off, with `kit.offline.actions` above the
  cards, as the modules' own cards have done since 0.296. `.kit-invite` in kit.css; texts
  `kit.invite.*`. `shell.setMark(n)` puts a dot on every ☰ of the frame while `n` invitations wait, and
  says so to a screen reader. The four modules drop their own cards.
- **The share dialog without a network** (`web/share.js`): it opens with what `load`
  knows (Tasks has it on the device), one line says it needs a connection (`kit.offline.actions`), and
  Invite, the permissions and taking back are off until the network is back (they turn on by themselves).
- **A person's colour** (`web/ui.js`, `sharing.js`):
  `avatar(person | name, { color, size, title })` takes a person and paints the colour they chose
  (`avatar_color`, `#rrggbb` only); `avatar(name)` is as before. The engine's `personOf` (and so the
  share dialog's rows, Settings › Sharing and the invitations) carries `avatar_color` where the users
  table has the column. The share dialog's default avatar and Settings › Sharing use it.
- **Settings › Sharing in the dialog's order** (`web/shared.js`): "Can edit" before
  "Read only"; `kit.shared.canView` says "Read only", as the invitations do.
- **One set of words for sharing** (`i18n`): `kit.share.left` ("You left “X”") says it after
  leaving; `kit.share.action` "Share" for the "…" menu; taking back is "Remove X's access"
  ("Remove X's access?"), without the thing's grammatical gender, in the dialog and in Settings;
  `errors.owner_only` "Only the owner can do that.";
  `kit.data.shareNote` with `{ things }` says what happens to what one shares when one's data goes, by
  the rule `pickHeir` keeps (whoever can edit first, then whoever has had it longest).
- **Rule 10 of «Same in every module»** (`docs/web-kit.md`): sharing reads the same in every module.

## 0.300.0 — 2026-11-19

- **Settings › Sharing without a signal** (`web/shared.js`, after the stale-invitations fix of Next
  0.96, Tasks 1.168, Notes 0.111 and Projects 0.125): what changes something —accept, decline,
  leave, what each person may do, taking it back— is off while there is no signal, with the line
  `kit.offline.actions` above, as the modules' invitation cards have it; on again when it comes
  back, and the page asks `load()` again then, so an invitation that went meanwhile goes from it
  too. Settings hands its sections `watchOffline` beside `close` (`section.render({ close,
  watchOffline })`); `sharedPage()` takes it, and drawn alone, without it, is always on as before.

## 0.299.0 — 2026-11-19

Affiliates: referral codes and creators' campaigns in one system.
Off until the app says `affiliates.enabled`.

### Affiliates (`affiliates.js`, suite migration 35)
- **Codes**: each account's referral code, made the first time its panel asks (`WORK7KQ2`: the
  app's prefix, `affiliates.referral.prefix`, and four letters nobody misreads), and creators'
  campaigns the admin makes for an account by its email (`MARIA20`), each with its offer, products
  and reward (the program's by default). Each is a discount at the provider when its adapter has
  `createDiscount` (kept per provider and environment, `affiliate_discounts`); without it a code works
  by its link alone.
- **Who brought whom** (`affiliate_attributions`, one per buyer): `GET /r/<CODE>` and any page opened
  with `?codigo=<CODE>` leave the `cw_ref` cookie (for the visit, on `affiliates.cookieDomain`; also from `/auth/login?codigo=`); an account
  made with it is the code's (`link`) and the cookie goes, never for the owner nor an account the
  admin makes. A payment's own discount takes the buyer (`checkout`): the paid one wins.
- **Commissions** (`affiliate_commissions`): on the buyer's first payment that charged something (the
  monthly's free first month waits for its second), one per buyer ever, never for one who paid here
  before, only for the code's products (a creator's: the yearly); never the owner's own (the same
  account, the same customer at the provider, the same email, `+tags` left out: audited as
  `affiliates.self_referral`). Pending for `confirmDays` (30), then confirmed by the hourly sweep. A
  refund before reverses it; after, a creator's earns a negative entry (`adjustment`), a referral's
  month stays and the refund is noted (`refunded_at`).
- **A referral's month** (`affiliate_rewards`, queued as billing's stops are, retried hourly, failed
  after 48 refusals): a grant of 30 days of the plan (`source: 'referral'`) chained after the last, or,
  for someone with a live web subscription that renews, its next charge 30 days later
  (`postponeRenewal`). Up to `yearlyCap` (12) a calendar year; past it the sale is confirmed with
  `reason: 'yearly_cap'`.
- **Payouts** (`affiliate_payouts`): noted by the admin for a creator's code, never more than the
  confirmed balance; one that covers it all marks the sales `paid`.
- **Off** (the default): no referral codes, links, discounts at a checkout or panel; the admin still
  makes campaigns, and a creator's code typed at the provider's checkout still earns. Payments are
  noted either way, so turning it on knows who already paid.
- An account that goes: who brought it and its first payment are forgotten; its codes stop (at the
  provider too) and stay, with their sales and payouts, for the books.

### Billing (`billing.js`)
- **The `payment` event**: money that came in (`ref` the transaction, `subscription`, `first`, `discount`,
  `amount`, `currency`), kept once (outcome `paid`, no audit entry), who paid worked out as for any event
  (a payment of a subscription is whoever's the subscription is), nothing granted. Waits for its
  person like the rest. Unsigned, it counts only for a subscription known here.
- **`whenPaid(hook)`, `whenRefunded(hook)`**: `hook({ user, organization, event })` once the event's
  transaction is in (a refund with whom it is known for here); one that throws is logged.
- **`discountWith(fn)`**: the discount a checkout gets, passed to the adapter's `checkoutUrl` as
  `discount`, only on a product's regular price (never a founder's).
- The adapter's new optional members, documented at the top of billing.js: `createDiscount`,
  `setDiscountActive`, `postponeRenewal`.

### HTTP and pages
- `GET/PUT /api/affiliates/me` (the person's codes, links, figures, rules; a creator's payout note) and
  `/api/admin/affiliates` (list with totals and `?kind=`, `POST` a campaign, `PUT /:id` on or off,
  `GET /:id/commissions`, `POST /:id/payouts`, `GET /export` as CSV), administrators only, guarded as
  the rest of /api/admin. A host serves them at its root only.
- **/admin › Affiliates**: a row per code (owner, kind, campaign, code, accounts, pending / confirmed /
  reversed sales, earned, paid, balance), filtered by kind; a code's sales and payouts; «New
  campaign»; «Record payout»; the CSV.
- **/afiliados** (`web/affiliates.html`): the person's codes with their link to copy, their figures,
  a creator's payouts and payout note, the rules and the press kit (`affiliates.pressKitUrl`).
- **Settings › Recommend**: a link to it where the program is on (`modules.recommend`, or a host's
  `host.recommend`), never inside the suite's app on a phone (Apple's 3.1).
- `/api/auth/config` says `modules.affiliates` (the admin's tab) and `modules.recommend`.
- `serializeCookie` takes a `domain`; `request-scope.js` keeps the request's answer too
  (`currentRequest().res`), for a hook that clears a cookie. A host reserves the mount `afiliados`.
- **i18n**: `affiliates.*`, `admin.affiliates.*`, `kit.recommend.*`, their fields, errors and log actions.

## 0.298.0 — 2026-11-19

- **On a phone, a sideways swipe no longer changes module** (`windows.js`: in most views a sideways
  finger already does something of its own, a row to the trash or its toggle, Next's line, the
  Gantt, so a swipe between modules served almost
  nowhere and came in by mistake). The tabs at the bottom are the one way to another module; a
  sideways finger in a window is the module's, and nothing keeps its touchmoves from the browser
  any more. Gone with it: the exports `OWN_SWIPE` and `swipeHolds()` (Work's shell and the modules
  import neither), the desk's `data-swiping` and `onGesture`'s `'swipe'`. A row still says
  `data-own-swipe` (`rowSwipe()`, `keepSwipe()`), now read by nothing of the kit's.

## 0.297.0 — 2026-11-18

/admin › Notifications, compact: one screen where it was three.

### Admin
- **Notifications in cards**: a head with how things stand (on, paused, no destination), the last
  delivery, «Send a test» and a «Pause» menu. Where they go is a fold, closed once it is set, that
  sums it up in a line (`server / topic · token saved`); the channels of each way of sending on one
  line. One row per group with a segmented choice (at once · summary · no) and how it will read;
  its pencil opens the words, which start from the default text, with the variables as buttons
  that insert at the cursor. The default's own words are saved as the default. The daily summary's
  hour beside its title. The rules of brackets and bursts in one line.
- **i18n**: `admin.notices.*` gains `state.*`, `modeShort.*`, `viaShort.*`, `rules` and the
  labels of the new controls; the ones the old panel alone used are gone.

## 0.296.0 — 2026-11-18

Notices to whoever runs the install of new accounts and payments, set in /admin › Notifications.

### Notifications (`modules.notices`, off by default)
- **`admin-notices.js`**: a notice to an ntfy topic (the ntfy app on a phone, with no account of the
  install on it) or to an email address when someone makes an account, buys, renews, or a
  subscription ends or is refunded. Per group (`signup`, `purchase`, `renewal`, `cancel`): at once,
  in the daily summary, or nothing. The summary goes once a day at its hour in the admin's time zone,
  claimed before it is sent, and not at all on a day with nothing. Five of one group within ten
  minutes and the rest wait for one notice («3 more new accounts…»). A pause: an hour, until
  tomorrow's summary, or until resumed. A test to every destination; the last delivery's result
  in the panel.
- **The admin's own words**: a template per group, `{country}`, `{flag}`, `{users}`, `{plan}`,
  `{amount}`, `{reason}` (the summary's `{signups}`, `{purchases}`, `{renewals}`, `{cancels}`,
  `{top_country}`), parts between brackets left out when what they name is unknown; a preview as it
  is typed. The defaults are in every language (`notices.*`), the panel's when it saves.
- **Never who**: no email, no name. The country of an account only behind Cloudflare
  (`TRUST_PROXY=cloudflare`), from CF-IPCountry and only from Cloudflare's own addresses
  (`http.js` `cloudflareCountry`, as `clientIp` believes CF-Connecting-IP); without it, none. Of a
  payment, the country and amount its provider's adapter gives (`event.country`, `event.amount`,
  `event.currency`), or none. Only accounts people make themselves: not the admin's, not one made or
  imported from `/api/admin/…`, not one a script or the start made.
- The ntfy token is kept encrypted with a key from the session secret and never sent back.
- `/api/admin/notices` (GET, PUT), `…/preview` and `…/test`, admins only; `admin.notices.update` in
  the log, with which fields changed and never what they say. The tab is shown with
  `app.modules.notices` in `/api/auth/config`. A host's modules have none of their own.
- `billing.whenApplied(hook)` and the stores' (`{ outcome, event, subject, product, provider }`, after
  each payment applied, a store's reading that changed something too); `request-scope.js`
  (`inRequest`, `currentRequest`): every request the suite's server answers runs inside one.
- Suite migration 34, `admin_notice_events` (what a notice says of each event, kept 40 days).

## 0.295.0 — 2026-11-17

Data: what happens to an account's things when it goes, copies, and what is shared.

### Whose it is, and who inherits
- **One hand-over for every module** (`ownership.js` `handOver`, `heirOf`): what someone leaving
  shared passes to its heir the same way everywhere: its owner is
  the heir, `owner_since` is now (what the module's sweeps count from), its public page goes off, and
  the module adds its part through `set` and `moved`. Needs `db.all` and `db.run`.
- `pickHeir` puts an account nobody can use (disabled, or waiting to be deleted) last; `heirOf` reads
  it from `users`.
- **Deletion notices braked** (`tellGone`): once a day per sender and person,
  whatever was deleted (deleting and restoring again is one notice); a nameless thing is "Untitled" in
  the push too; `id` gives each thing's push its own tag. `createGoneBrake`, option `brake`.
- `suite.ownership` (in the host, one per module in its words), `suite.shareBrake` (one brake on offers
  for the whole install, 40 an hour: `SUITE_OFFERS_PER_HOUR`) and `suite.goneBrake`.
- `requireOwner(…, { action: 'close' })` → `not_yours` with `action`, which the kit says "ask Ana to
  close it" (`errors.not_yours_close`).
- Kit: `tellNotYours(owner)` for a button pressed by someone who may not;
  `askCopy`/`moving(…, { files: false })` say the copy goes without its files
  (`kit.ownership.copyTextNoFiles`).

### Sharing
- **Inherited invitations by address are masked** (`sharing.js` `maskAddress`, `addressFor`): an
  heir sees `m•••@domain.com` for the addresses its former owner typed; the offer stays.
- **Picked by id, or typed** (kind option `byId`): with a module's `by_id` column, a
  share waits behind an offer by address only while nobody picked the person by id, and an offer by
  email to someone who has it already waits under the address like one to an address without an
  account. Two leaks close: picking a known person after typing an address no longer tells whether
  the address is theirs, and an email to an accepted member no longer answers "accepted" nor changes
  their permission. A share picked after a typed address is dated anew.

### Copies
- **One pending import per person and mode**, the account imports' folder capped (`limits.pending`,
  2 GB), bytes no row names refused (`limits.unreferenced`, 4 MB), the busy slot taken once the upload
  is on disk.
- The install's copy carries `mail_suppressions` (`suite/mail-suppressions.json`).
- An account already here keeps its language, time zone, theme and locale whichever module's copy
  comes in (`ACCOUNT_PREFS`).
- A whole install's copy names its install and run with or without organizations: the modules of one
  run put each account where the first one did and give no plan twice.
- A table's `dropped: [...]` columns are read past in old copies.
- Settings › Your data says what a copy left out because it is shared (`kit.data.leftOut`) and, in the
  plan, what "replace" passes on.

### Invitations to addresses without an account, and the database
- **Migration 32** `stranger-invites-keep`: `mail_stranger_invites.inviter_id` is `ON DELETE SET NULL`;
  an email already sent keeps its link to stop them when its sender's account goes.
- A send that fails takes its row back (`strangers.forget`); rows go after a year
  (`STRANGER_KEEP_DAYS`, `strangers.purge`, in the suite's purge).
- **Migration 33** `users-email-index`: `users(email COLLATE NOCASE)`.
- `PRAGMA synchronous = NORMAL` with WAL.
- An account that goes takes what `idp_connections` kept of its AI clients; a disconnected one stays
  refused. In a host, the modules' empty `mcp_tokens` goes (`dropLeftovers`).
- docs/architecture.md: who deletes what they made in each module, the hand-over, the brakes.

## 0.294.0 — 2026-11-15

Cronum Work's shell, the browser kit, the installed app (PWA) and the phone app.

### Work's shell and the kit's frame
- **Work's shell, its modules in their colours** (`web/tokens.css`, `web/kit.css`): tokens.css
  gives Cronum Work (`data-app="work"`) its ultramarine, and inside Work each module's windows and the
  pieces it hangs on the page (`data-module`, `data-owner`) keep the module's accent; kit.css works the
  kit's accent out again there, light, dark and Clean.
- **A module's page opens the host's shell from anywhere** (`web/native.js`, `web/shell.js`):
  `hostShellAddress` now also sends a module's page to `/?open=…` in a browser's tab and in
  the host's own installed app (`markShellWindow()`), never a page asked alone (`?alone`, kept for the
  tab: `aloneAddress()`) or a module installed on its own; `?billing=` comes with the shell's address.
  The rail's mark links the shell where there is one, and Settings › Modules installs each module alone.
- **Back closes layers** (`web/ui.js`, `web/settings.js`): `backLayer(onBack)` gives a layer
  an entry in the history while it is open, so the system's Back closes it and the page under it hears
  nothing; `close()` takes the entry back and `afterBackLayers(fn)` waits for it. Settings use it in
  Work's shell, from a section to the list on a phone, then out.
- Settings › Modules and About say «modules», and how Work's shell moves between them, in the five
  languages.
- `web/live.js` `liveSource()`: the channel's machine (EventSource, last id, waits, hello), shared by the
  kit's own channel and Work's one channel.
- `web/keyboard.js` `rideKeyboard()` and formDialog `typing`: a sheet's field in the iPhone app is
  focused without the slide and the sheet rides on the keyboard; it was Work's Feedback's alone.
- `web/signal.js`: one «is there a signal again?» for the whole kit. `watchSignal({ ask, answered,
  onBack, active, again, firstMs, maxMs, url, patienceMs })` asks /version after 3 s, then twice as long
  up to 30 s, at once on `check()`, and tells nobody after `stop()`; nothing on import. Tasks, Projects,
  Notes and Next ask through it, each with its own waits, client and what counts as an answer, and so
  does Settings' `connection` (settings-queue.js), as before. In the worker's kit files.
- **The drawer closes on Back**, and in Work's shell when its window goes out of view
  (`web/shell.js`). A button chip takes a finger's tap 37 px tall (`web/kit.css`).
- Gone: mount.js `standaloneCtx`, windows.js's `{ slots }` layouts, `restore()` and `recent`.

### The service worker and notices
- **In a host's copy every file it installed is code** served from the copy, Work's `/w/` files
  included, and the network only fills its holes, never replacing what it holds (`web/sw-core.js`).
  What is only nice to have offline comes from the old copy while its hash is the same.
- A notice of a module installed as an app of its own opens in that app when no window is open
  (`web/worker.js` `markInstalledAlone`, cache `/.suite-alone`).
- The host's worker keeps the root `/js/app-version.js` and not the modules' own (`host.js`).
- `web/push.js` `ensureSubscription()`: the one way to turn notices on for a person; Settings'
  `subscribePush()` uses it, and so does Tasks.

### Settings, the admin panel, Markdown and sharing
- **Settings no longer freeze when other modules' catalogs fail** (`web/settings.js`): another
  module's catalog is asked for once while Settings are open, failing or not, and the catalogs that
  arrive in the same moment trigger one repaint between them. One that failed is asked again the next
  time Settings open. Two failing catalogs used to repaint tens of thousands of times and hold the tab
  for seconds.
- **About's cards get their line**: `moduleCard` called `paintCards`, out of its scope.
- **Signed out, the queue of preferences stays** (`web/settings-queue.js`): `/api/auth/me`
  answers `{ user: null }`, not 401, and `sendKept()` took that for someone else.
- **Settings › Plan after a new plan**: what the other modules include and what is used are
  asked again with it; an older answer never paints over a newer one (`yourUsage().read()`).
- **Settings start lighter**: `agents.js` and `usage-view.js` are imported when they are
  drawn, once per page; without a signal they come from the worker's kit as before.
- **Installing from Work installed**: inside Work's own window (`installed()`) Settings ›
  Modules talks as in the suite's app: no button for Work, and the module opens in the browser
  (`kit.modules.installPickInstalled` for a click).
- **Admin: one view at a time** (`web/admin.js`): a view is drawn apart and put in only while
  it is still the last one asked for.
- **Admin: words for every audit action**, and a test that checks every action the server
  records.
- **Admin asks first**: making someone an admin or not, turning an account off, setting a
  password, and «Close their sessions», which ends their tokens, assistants and phones too and now says
  so before and after. `saveButton`'s `save` may answer false.
- **Markdown in linear time** (`web/markdown.js`): a mark with no close is looked for once,
  brackets are paired in one pass, a link's destination reads at most a few times the text, and quotes,
  lists, marks and links past 32 levels are text. 200,000 characters of `*a ` take ~0.1 s (60,000 took
  15 s); `>` 10,000 times or 5,000 nested links no longer throw.
- **Pictures only from the app's own files**: `safeImage` takes a path ending in
  `files/<id>`; `![](/api/admin/export)` is a link, never a request.
- **Sharing speaks one way** (`web/share.js`, `web/shared.js`): the dialog asks before taking
  it back from someone who accepted it in Settings › Sharing's words, and Settings › Sharing takes back
  an unanswered invitation at once, as the dialog does. The same words in both, in every language.
- Gone, unused: `aiExtra` and a module's `settings.ai` (`moduleSettings` no longer answers
  `ai`), `toggleTask` and `renderMarkdown`'s `onTaskToggle`, and the keys `kit.settings.moduleAi*`,
  `admin.confirm`, `admin.areYouSure`. `sharedPage` stays exported (Projects' tests draw it alone).

### The phone app
- **Links to the site open the app** (`app-links.js`): suite.config.js
  `appLinks: { paths, exclude?, apple: { bundleId, teamId? }, android: { package, sha256? } }`, with the
  install's `APPLE_TEAM_ID` (else `APNS_TEAM_ID`) and `ANDROID_CERT_SHA256` (Play's app-signing
  certificate, comma-separated for several). `/.well-known/apple-app-site-association` and
  `/.well-known/assetlinks.json` are served as `application/json`, with no session, no redirect and
  `Cache-Control: public, max-age=3600`, at a host's root only. A file whose values are missing stays the
  404, and the start warns. The APIs, `/auth/*`, OAuth's endpoints, `/mcp*`, `/admin*`, `/devices/*`,
  `/.well-known/*` and any `?billing=` address never open the app.
- **The device token names its account** (`devices.js`):
  `POST /api/devices/token` also answers `user_id`, so the app can tell the same account signing in again
  from another one and keep its unsent changes.

## 0.293.0 — 2026-11-15

The host's runtime, mail, push, the configuration and what was left of billing.

- **A group left with nobody stops renewing** (`organizations.js`, `billing.js`, `app.js`). When an
  account's deletion leaves a group of a kind kept when empty
  (`onEmpty: 'archive'`) with nobody in it, the group was archived and its own subscription went on
  renewing, with nobody to cancel it. Now its live subscriptions stop at the end of the period they
  paid for, asked of the provider once the deletion's transaction is over and by the hourly sweep if
  that fails, the same way a group's stop always goes (`billing.organizationArchived`, who wants it:
  `empty`; each stop asked is `billing.organization.stop` in the log). The archive itself is in the
  log too (`org.archive`, `reason: 'empty'`). `organizations.whenArchived(hook)` is new. Only with
  `modules.organizations`, and a provider that can stop one.
- **A relinked login keeps its renewals** (`billing.js`). Someone whose WorkOS id changed
  (WorkOS forgot it, and the same verified email signed in again) had their subscription's renewals
  waiting forever for the old id, and lost Pro after the grace days while still paying. An event
  whose identity nobody has here now goes, before waiting, to the person its subscription (or
  purchase) is known for here, else to the person its customer is linked to. Someone who hasn't
  opened this app yet still waits, as before.
- **Back from a checkout in Work's shell** (`billing.js`, `app.js`, `host.js`, `web/plan-return.js`).
  Buying from a module's window sent the browser back to `/<module>/?billing=done`, the
  module's page on its own, outside the shell. In a host with a page at its root (Cronum Work's
  shell), a module's checkout now comes back to `/?open=/<module>/&billing=done` and its portal to
  `/?open=/<module>/`: the shell opens that module's window and thanks (its `billingReturn()` at the
  start, as it already does for its own Settings). Without such a page, as before. createApp's new
  `billingReturn: { checkout, portal }` and registerBillingApi's `returnUrls` say it. The kit keeps
  the plan from before a checkout under one key for the origin (`host.billing`; `<app>.billing`,
  the key before, is still read once), so the shell knows it after a module's window began it.
- **Plan names in every language** (`i18n/*.json`, `web/api.js`): `Free` and `Team` are keys of
  the five catalogs (translated as the website says them), and the errors
  `plan_feature` and `plan_limit` say the plan by that name. `errors.already_subscribed` names the
  button Settings has now, «Change or cancel plan» (`kit.plan.change`), not «Manage subscription».
- **/health reads the database file** (`app.js`). `SELECT 1` read nothing: with the file
  broken or unreadable underneath, /health still said 200. It now reads a page of the schema, and
  once more through a read-only connection of its own, since the server's connection keeps its
  pages in memory: a broken file is a 503. `/version` keeps the modules' versions (deployments are
  checked with it).
- **STARTTLS has a deadline, and nothing in clear rides past it** (`mail.js`). A server
  that went quiet during the TLS handshake kept the send (and its socket) waiting forever; now the
  handshake has the same deadline as every reply. A reply sent in the clear behind "220 go ahead"
  stops the conversation (`MailError`) instead of answering the first encrypted command.
- **A silent APNs connection is replaced** (`native-push.js`). A request that timed out
  left its HTTP/2 session in use, and every next notice to an iPhone timed out on it, 10 s each,
  until the system dropped the TCP. The session is now destroyed at the timeout, and the next send
  connects again. `createApnsSender({ timeoutMs })`, 10 s by default.
- **A module's start can't stop the host, and its jobs reach the alerts** (`host.js`). A `start()`
  that throws is logged and emailed (`<mount> start`) and the other modules
  are served. `start()` gets `failed(name)` (for a promise's catch) and `safely(name, fn)` (for a
  timer) besides `day` and `uses`: what a module's own job throws is logged and emailed as the
  host's jobs are, as `<mount> <name>` (docs/architecture.md, section 21).
- **The phone's connect page under Work's shell** (`host.js`): back from a provider's
  sign-in at `/` with the request's cookie, the browser goes to the connect page again; a host
  whose own page is its root answered `/` with that page first, and the request was lost.
- **One runtime for an app and a host** (`runtime.js`, `app.js`, `host.js`). The server
  around the handler, the install's jobs (clean-ups, OAuth, account deletion, WorkOS, the groups'
  stops), the process signals and the lines said on listening were written twice and had started
  to differ; both use the same ones now. A module's `createApp()` in a host no longer makes an
  `http.Server` it never listens on (`app.server` makes it when first asked for).
- **`rateLimits` takes every limit the limiter has** (`config.js`): the defaults and the
  names come from `rate-limit.js`'s `DEFAULT_LIMITS`; `rateLimits: { billing: 20 }` stopped the
  start ("not a limit").
- **ADMIN_EMAIL with WorkOS** (`config.js`): a warning at the start when it is empty,
  since nobody who signs in becomes an administrator. The text for `EARLY_ACCESS_UNTIL` says what
  the code does: the first day after the early access (2027-01-01 keeps 31 December in it), as
  Work's `.env.example` says; it said "the date the early access ends".
- **Removed, nobody called them**: `push.sendTo` and the module wrappers'
  `send` and `sendTo` (`host-worker.js`; a module's push has `deliver` only, and no unmarked `send`
  spread from the host's); `reload` and `replayed` in the small body that replays an answer too big
  to keep (`idempotency.js`: `{ id }`, or `{}`; the `Idempotent-Replayed` header says it is a
  replay). `http.js sendError` stays, used now by createApp's own error answer.

## 0.292.0 — 2026-11-15

- **The MCP layer** (`mcp.js`, `host.js`, `calendar.js`, `links.js`, `mcp-files.js`, `oauth.js`,
  `mcp-kit.js`, `web/agents.js`).
  - **Arguments reach a tool as its schema says them** (`coerceArguments`): the check
    let `"false"`, `"true"`, `0`/`1` through for a boolean and `"30"` for a number, and the tools
    read `args.apply === true` and `Number.isInteger(args.days)`: `projects_reschedule
    { apply: "false" }` moved the dates and `tasks_get_agenda { days: "30" }` was a week. Now they
    become `false` and `30`, in nested objects and lists too. A number where a text goes stays as it
    came (some tools tell an id from a title by its type), and so does what the schema doesn't name
    or names with `anyOf`. With `checkArgs: false`, nothing changes.
  - **`GET /mcp` answers 405**, after the token as before (a client without one still
    gets the 401 that starts the sign-in): it held an SSE channel and a 25 s timer open for good per
    request, with nothing ever sent on it. Streamable HTTP lets a server say it has no such channel.
    The `sessions` map, written and never read, and `bearerToken`'s unused `url` are gone;
    `Access-Control-Allow-Methods` and `Allow` say `POST, DELETE, OPTIONS`.
  - **An unexpected error says nothing of itself**: the assistant read the internal
    message (SQLite's, with tables and columns); now «Something went wrong running X; it was noted.
    Tell the user, and don't retry it as it is.», the error in the log. `params: null` is no params
    (it gave an HTTP 500), params that aren't an object are `-32602`, and a method that throws is
    that message's `-32603`, not a 500 for the whole batch.
  - **The host's own tools answer in sentences**: `hostMcp` gives a `describeError` over
    the suite's catalog (`errors.<code>` in English), for what neither a module nor the host
    described; `work_calendar` had `field_invalid` for a span of over 366 days or a date that isn't
    one. Its `from` and `to` carry `format: 'date'`, and it says what it takes («"to" must be on or
    after "from" and at most 366 days from it»).
  - **A module's answers name its tools with the host's prefix** (with `namesInText`):
    «give it one with edit_step» is `next_edit_step`, in what a tool answers and in its errors, as
    in its description already. Not in what a tool that only reads answers: that carries the
    person's own words (a note's body, a step's detail), which may go back whole in an edit.
  - **The instructions that don't fit are named**: `hostInstructions` takes
    `onLeftOut(mounts)`, `hostMcp` gives `instructionsLeftOut(principal?)`, and a host says at start
    which modules' part it leaves out (`[mcp] warning: the instructions leave out …`). Cronum Work's
    are 2 038 of 2 048 characters today, every module in.
  - **Upload links have a ceiling per account** (`MAX_UPLOAD_LINKS_PER_USER`, 10): one
    account asking a hundred times made everyone else's pending links go; now it only pushes out its
    own. The module's ceiling (100) stays.
  - **Limits in the host's schemas**: `work_link_item`'s `create.title` (500) and
    `create.place` (200); the door's `names` takes as many as there are behind it (it said 30 with 31
    there), and its two tools' own arguments go through the check as any tool's.
  - **Built-in OAuth** (`AUTH_PROVIDER=local` only):
    the sign-in posted to `/oauth/authorize` without a session is taken only from this site's pages
    (`Sec-Fetch-Site`, else `Origin`: login CSRF); a Basic header that doesn't decode is
    `invalid_client`, not a 500 and an alert; a grant's `last_used_at` is written once a minute at
    most; a refresh token once used is kept a week, not its 60 days; a client document (CIMD) that
    has to be fetched counts against the address as a registration does, and one that couldn't be
    read isn't fetched again for a minute.
  - **`mcp-kit.js` without what nobody used**: `tool()` and `S.number` are gone (no module and no
    app called them), and its header no longer counts tokens.
  - **Your AI offers the website's agents** (`web/agents.js`): Grok and Perplexity, with the
    steps cronumstudio.com/work/ gives; Gemini is gone (custom connectors only for adults
    with a personal account in the US). Claude's and ChatGPT's steps are the website's of 11 November
    (Customize › Connectors; Plugins › Add custom MCP server), ChatGPT's last one too.
    `kit.agents.grok.*`, `kit.agents.perplexity.open` and `kit.agents.addSignIn` in five languages;
    `kit.agents.gemini.*` and `kit.agents.paste` gone.
  - **Settings › Your AI's switch says what the door does without counting** (`kit.ai.toolsHint`):
    "about a quarter less" was a third, and the list in brackets had drifted (sharing
    is not behind it since 0.243.0).

## 0.291.0 — 2026-11-15

Daily summary, calendar and links. Additive for every module: what a
module gives today keeps working as it does.

- **The daily notices read only who has a device** (`day.js`, `push.js`, `host.js`). Every minute
  the scheduler read every account, its preferences and zone, and asked
  for the devices of everyone in a window, phone or not. Now `push.peopleWithDevices()` (one query:
  browsers subscribed, phones with a token on a device not revoked) says whose rows to read; each
  zone's minute and day are read once; the host looks every five minutes (`createDayNotices({
  everyMinutes: 5 })`: every notice's time is on a five-minute step and every zone is whole
  quarter hours from UTC; a check that comes a step after the last one that looked looks anyway).
  `host_day_notices` is read by its day through an index (host migration 12) and forgotten once a
  day, after `DAY_LOG_DAYS` = 3 days (it was 60, every minute). Without `peopleWithDevices` (a
  push of another shape) the scheduler reads every account, as before. One check, 5 % of accounts
  with a device, on this PC: 1 000 accounts 135 → 5 ms, 10 000 accounts 1 170 → 39 ms.
- **Whether someone uses a module is one row** (`host.js`, `day.js`). `uses()` read
  all of `/api/modules` (five queries, a JSON parse and a sort) for each module asked; it reads its
  row of `host_modules` now, with the same answer. The summary and each notice ask it once a module
  (GET /api/day asked it of every module three times over).
- **Today's things no longer vanish behind 200 overdue ones** (`day.js`). The host
  kept a module's 200 oldest of everything, so with 200 overdue nothing of today was left and the
  notice counted 200. It keeps the 200 oldest overdue and today's (up to 200) apart, and a module
  may answer `{ items, overdueTotal }`: `overdueTotal`, how many it has overdue past its own cap,
  goes into `GET /api/day`'s new `overdue_total` and the morning notice's count. A list, as
  before, still works.
- **The caps go to the modules** (`day.js`, `calendar.js`): `agenda` and `done` get
  `limit` (DAY_MODULE_MAX) in their args, the calendar's `range` its `limit`
  (CALENDAR_MODULE_MAX), so they need not repeat them. `time.js` `isoInstant(stamp)` (Tasks' and
  Projects' `isoOf`) and `links.js` `likeOf(text)` (the LIKE escaping in three cards.js), for the
  modules to adopt. (`dayStart`/`daySpan` came with 0.277.0.)
- **No more time of day** (`day.js`, `calendar.js`). No module gives one: `time` is no
  longer kept from an agenda or calendar item, the summary no longer sorts by it, and
  `work_calendar` no longer says "at HH:MM". The summary's items also leave out `mine`, which no
  page reads; the calendar keeps it.
- **Linking a pair linked already says so** (`links.js`, `web/links.js`). `POST
  /api/links` answers 200 `{ link, existed: true }` for it (201 `{ link }` for a new one, as
  before), and `linkItems()` gives `{ link, existed }`; `links.connect()` on the server.
- **Places only for "Add to…"** (`links.js`, `web/links.js`). `GET
  /api/links/search?places=0` leaves out the places to create in (`places: []`), and the kit's
  "Link existing…" sends it: it asked them at every key and never showed them. Without it, as
  before.
- **Titles of deleted things** (`links.js`, `host.js`). `links.prune()` runs a minute
  after the host starts and every six hours, not only when an account goes; and a side's title is
  kept as whoever linked it sees it (`createLinks({ userOf })`): a rename after they lost sight of
  it never reaches them when it is deleted.
- **Unused options out** (`day.js`, `links.js`): `day.any()`, `ask()`'s `max`, and
  `cardOf`, `cardsOf`, `parseRef`, `formatRef` on what `createLinks()` returns (`parseRef` and
  `formatRef` stay exported from `links.js`). `?date=` stays: Work's tests read another day.

## 0.290.0 — 2026-11-14

- **An address nobody has is a 404 page, not the app's page drawing nothing** (`app.js`, `host.js`,
  `brand.js`, `web/not-found.html`). `/nope`, `/tasks/nope/deep` or `/.git/config`
  answered 200 with the app's page; a deep one asked for its files under the wrong path and stayed
  blank, and `/api` and `/tasks/api` were HTML where a client expects JSON.
  - `createApp({ clientRoutes })`: the paths its page answers that are no file. Any other path
    without an extension is the kit's 404 page, in the browser's language (`kit.notFound.*`), with
    a link to `/`; a folder with its own index.html asked for without its slash (`/calendar`) is a
    308 to it. A host gives `['/']` to its root and to each module (`createModule().clientRoutes`
    for one that needs more): no module has a route in its path (Tasks and Projects read the
    query, Notes and Next the hash). Without the option, as before.
  - For every app: `/api` itself is the JSON `not_found`, and a path with a part that starts with
    a dot (`/.env`) is a plain 404, never the page.
- **`/.well-known/`: only OAuth's say "No OAuth here", and security.txt** (`app.js`, `config.js`).
  `/.well-known/openid-configuration`, `security.txt` and the rest answered the
  OAuth sentence; now `{ "error": "not_found" }`, but for `oauth-protected-resource` and
  `oauth-authorization-server` (and `/register`, `/authorize`, `/token`, `/oauth`), as before.
  `/.well-known/security.txt` (RFC 9116): `Contact` from `SECURITY_CONTACT`
  (Cronum Studio's contact address when empty), `Expires` a little under a year ahead, worked out
  on each request, `Preferred-Languages: en, es` and `Canonical`.
- **The host's /sw.js answers 304** (`host.js`): `ETag: W/"<fingerprint>-<hash>"`,
  as `/js/app-version.js` has its own; every check took the whole script again.
- **An import says how big it may be, before and when it is too big** (`config.js`,
  `portability.js`, `app.js`, `host.js`, `web/settings.js`, `web/api.js`).
  Settings said nothing useful for a copy over 100 MB: Cloudflare cuts it with a page of its own
  before the server sees it, while the import took up to 512 MB.
  - `IMPORT_MAX_MB`: the most an import takes over HTTP, someone's own and the admin's; when empty,
    95 behind Cloudflare (`trustProxy: 'cloudflare'`, as Cronum Work's config has it), the suite's
    own ceilings otherwise. `withImportCeiling(limits, mb)` (portability.js): the lower wins.
  - Too big at the server is `413 file_too_large { max_mb }`, the sentence files already had,
    where it was `body_too_large` ("Too much text"). `GET /api/auth/config` says
    `app.imports.max_bytes`, and Settings says it before sending the file.
  - The kit's client (`web/api.js`): a 413 without the server's code is `upload_too_large`.
- **Sharing and public pages in the audit log** (`sharing.js`, `public-page.js`).
  Only what an assistant did reached /admin › Activity (`mcp.tool`); from the web, sharing
  something or making it public left nothing.
  - `createSharing({ audit, module })`: `share.offer` (a new offer, or one made again while
    unanswered; an address without an account as `stranger`), `share.permission`,
    `share.withdraw` (its owner took it back) and `share.leave` (declined or left), with the kind
    and its id, who it was for (`meta.user`) and the request's address when a route made it;
    never a name, a title or an email. `auditShare(audit, …)` writes the same line for a module
    that shares without the engine (Projects' team).
  - `createPublicPage({ audit, kind, module })`: `public.open` and `public.close`, never the token;
    `open` and `close` take `{ req }`, as its routes pass it. `auditPublic(audit, …)` for a module
    whose page doesn't go through it yet.
  - The modules pass `audit: suite.audit` (and their name) to have them: without it, as before.
  - Their names in Activity, in the five languages (`admin.actions.share_*`, `public_*`).
- **CONVENTIONS §4: a version tag publishes no image**: Cronum Work is built by its
  deployment from its repository; the modules' ghcr images were private and nothing pulled them.
  §5 names `SECURITY_CONTACT` and `IMPORT_MAX_MB`.

## 0.289.0 — 2026-11-14

Sign-in and account security.

- **Straight to the provider, two cases fixed** (`web/signin.js`, `web/signin-form.js`).
  «No, let it go» on the card of an account waiting to be deleted shows the usual card instead of
  going straight back to AuthKit, which still had a session and brought them to the same card; and
  with the site's data blocked, merely naming `sessionStorage` threw before the `try`, so `signIn()`
  failed instead of drawing the card: it is read inside it now.
- **One state cookie per sign-in, for 30 minutes** (`http.js` `signInFlowCookies`,
  `workos-accounts.js`, `oidc.js`). Every page without a session starts a sign-in by
  itself since straightToProvider, and the one `<app>_auth` cookie (10 minutes) let a second tab
  take the first one's place, and an AuthKit page left open over 10 minutes come back to «could
  not be completed». Each sign-in has `<app>_auth_<first 8 characters of its state>` (Path=/auth,
  Max-Age 1800, as a phone's connect page waits, `CONNECT_MS`), and the callback reads the one its
  `state` names. `<app>_auth` is still written with the newest one and read when a flow's own is
  missing: a sign-in started before this version comes back, and an app's tests that read
  `<app>_auth=` keep working. `tools/test-kit.mjs` `fakeWorkos().signIn` sends both, as a browser.
- **A malformed state cookie is a failed sign-in, not a 500** (`workos-accounts.js`, `oidc.js`).
  Their own copies of `cookieValue`, `addCookie` and `safeEqual` are gone for the
  suite's `parseCookies`, `appendHeader` and `crypto.js` `safeEqual`; `localPath` lives in `http.js`
  for both. `Cookie: work_auth=%E0%A4%A` threw before the callback's `try`, answered 500 to anyone
  and counted towards the error-burst alert: now `/?auth_error=failed`.
- **The shortest password with WorkOS is the app's** (`workos-security.js`, `app.js`, `api.js`,
  `web/settings.js`, `web/api.js`, i18n). `registerWorkosSecurityApi` takes
  `minPasswordLength` (createApp passes `config.accounts.minPasswordLength`; 8 when nobody says, as
  before) for Settings' new password and the admin's: Settings said «at least 8» where Work and
  WorkOS's policy ask for 10. `password_rejected` carries `n`, its sentence says it (`{n}` in
  `errors.password_rejected` and `kit.security.workosPasswordHint`, five languages; 8 for a server
  from before), and when WorkOS refused it, WorkOS's reason after it (`kit.security.providerSays`).
  `/api/auth/config` gives `password_min` with WorkOS too (still null with OIDC), and a login the
  admin makes for a new account takes the same shortest (`logins.minPasswordLength`).
- **Every action of the log is a sentence in Activity** (i18n):
  `auth.revoke_everything`, `oauth.connection.revoke`, `billing.customer_unvouched`,
  `billing.customer_conflict`, and the others nobody had written (`admin.early_access.keep`,
  `calendar_feed.*`, `billing.refunded`, `.unchanged`, `.unsigned`), plus `org.archive` for the
  pull request that records it. `test/audit-actions.test.js` reads every action the server code
  records and checks each has its sentence in every language.
- **The log by action has an index** (`audit.js`, `schema.js`, suite migration 31
  `audit-action-index`): `ix_audit_action ON audit_log (action, id)`, which Activity's
  list of actions and one action's newest entries read instead of the whole table.
- **WorkOS: the second step's codes braked, password checks with their address** (`workos-security.js`).
  `confirmCode` (turning the second step off, the admin's own code) has the limiter's
  `checkCode`/`codeFailed`/`codeSucceeded`, as a local code has: 429 `too_many_attempts` after five
  wrong ones. `checkPassword` is told `clientIp(req)` (`trustProxy` from createApp), which went to
  WorkOS as null. `crypto.js` `decryptText` takes only a whole 16-byte tag (`authTagLength`).
- **Before what can't be undone, the WorkOS password too; a replacing import asks as erasing does**
  (`api.js` `identityCheck`, `workos-security.js` `confirmIdentity`, `portability.js`, `app.js`,
  `web/settings.js`). With WorkOS an open session alone erased everything, the bin
  included: erasing one's data and deleting one's account now ask for the password the person has
  at WorkOS (not of whoever signs in with Google & co., as before), with the brake of sign-in.
  `POST /api/me/import/:id` with `replace: true` asks for `confirm: true` and the password, as
  `/api/me/erase` does, and Settings asks for it with the same dialog (the word typed, the password).
  `identityCheck` is async now; its callers await it.
- **A shared login with the MCP doesn't start without `WORKOS_MCP_AUDIENCE`** (`config.js`).
  With `accounts.sharedIdentity` and `modules.mcp`, a missing (or blank)
  `WORKOS_MCP_AUDIENCE` is a configuration error instead of a warning: a token someone gave a client
  for another product of the same WorkOS environment opened this MCP. Without sharedIdentity, the
  warning as before. The variable is the one `workos.js` reads and production sets.
- **Test data and ignored files**: `test/web-admin-filters.test.js` (and
  `web-admin-new-account.test.js`) use example data (`tester@example.com`) instead of a real
  alias; `.gitignore` adds `.claude/`, the local notes for AI agents, `.cloudflare/`, `.dev.vars*`, `*.log`,
  `*.stackdump`, `tmp/` and `data/`.

## 0.285.0 — 2026-11-14

- **One catalog per language, with English under it** (`web/i18n.js`, `app.js`, `i18n.js`,
  `page-hints.js`, `host-worker.js`, `host.js`). Every copy of the kit
  asked for English and then the person's language, one after the other, though English only
  stood in for a key the language lacked: in Cronum Work, two catalogs per module, most of their
  bytes the kit's texts twice.
  - `GET /i18n/<lang>.json?en` (also with `?all`): the language with English under it, every key
    it lacks English's, and `$meta.fallback: "en"` saying so (`CATALOG_FALLBACK`). Each key reads as
    before, English's where the language has none; `/i18n/<lang>.json` is the language alone, as it
    was (the conformance check reads what it lacks), and English is still `/i18n/en.json`.
  - The kit asks for that one alone (`catalogPath(lang)`): English only for English. A catalog
    that comes without the mark (an older server, a copy kept before) has English asked for too,
    as before; none at all (no signal and no copy), English stands in, as it did.
  - A module page's `Link` names that one catalog (`es.json?en`, or `en.json`), and a host's worker
    keeps every other language's as the kit asks for it (`catalogsOverEnglish`), its hash with the
    app's English file in it too (`shellHashes`): a weak signal waits for no catalog.
  - Measured on a local Work in Spanish (every key of every module's catalog, and the shell's, in
    every language, reads the same both ways): a module's catalogs are 1 request where they were 2,
    and Tasks' 108 KB where they were 212 (Notes 83/162, Projects 88/172, Next 81/159, the shell 68/133);
    with the four modules and the shell, 5 catalogs and 428 KB where there were 10 and 838 KB.
- **A module's start no longer evaluates the sign-in screen, Settings' plan and the worker**
  (`web/signin.js`, `web/signin-form.js`, `web/plan.js`, `web/plan-return.js`, `web/shell.js`,
  `web/update.js`, `web/sw-core.js`). Each module mounted in Cronum Work
  loads the kit from its own address and evaluated its own copy whole, with code that inside Work
  never runs or runs only on a tap.
  - The sign-in screen is `signin-form.js`, which `signIn()` loads when it draws it: a page with a
    session never evaluates it. `signin.js` keeps every export (signing out, `pendingChanges`,
    `confirmEmailFromLink`, `straightToProvider`…); `signIn()` resolves as before, the screen a
    moment later than before (its file, from the worker's copy).
  - `billingReturn`, `lastDay` and `PLAN_EVENT` live in `plan-return.js`, which the frame (shell.js)
    takes them from; `plan.js`, Settings' plan section, comes only with Settings, and still names
    all three.
  - `update.js` asks for worker.js (and with it push.js) only when a check needs the host's worker:
    a module in a window of Work, which never watches for updates itself, doesn't evaluate them.
  - The worker's copy keeps the two new files.
  - Measured from the static imports of each module's main.js (what Work mounts): the kit a module
    evaluates goes from 402 to 337 KB in Tasks, 388 to 314 in Projects, 405 to 331 in Notes and 382
    to 308 in Next, 1 577 to 1 289 KB with the four; the shell's own copy from 299 to 288 KB. In the
    test Chrome, with no worker, cold: Tasks' window 27 kit files and 372 KB where it was 28 and 422
    (the four, 108 files and 1 674 KB → 101 and 1 446 KB; parsed, 1 595 → 1 372 KB).
- **Docs: live notices while a module is put away** (`docs/architecture.md` §21.6): the mount
  contract says what the shell does with a hidden module's notices since Work
  0.109.0 (held, then one `onResync()` after `resume()`), and that a paused module doesn't reload on
  `visibilitychange`.

## 0.284.0 — 2026-11-14

Server performance. Same answers, same routes; measured on a database of 301 accounts, ~37 000
tasks and 14 000 notes.

- **Time zones read once** (`time.js`, `day.js`): `knownTimeZone()` built a formatter
  to check a zone each time it was asked, ~100–250 µs, and every `dayIn()`, `daysSince()` and
  request asks: it keeps what each name resolves to (500 names at most, the oldest going first;
  `prefs.tz` is the client's). `dayIn()` 102 → 1.6 µs. The check of the daily notices every minute
  reads each person's preferences once and the minute and day once a zone, not once a person:
  1 000 accounts 103 → 2 ms, 10 000 1.5 s → 17 ms, during which nobody else was answered.
- **Statements kept prepared, and statistics for the planner** (`db.js`):
  `all/get/run` prepared their SQL every time, up to half of a route's CPU. Each handle keeps the
  last 500 texts of reads and writes (never a PRAGMA nor DDL) prepared; a call binds every
  parameter anew, SQLite prepares one again when the schema changes, and `close()` lets them go.
  A connection whose `prepare` was replaced on it (the modules' tests that count statements)
  prepares each one, as before.
  New `optimize({ first })`: `PRAGMA optimize` (0x10002 the first time: whole tables that have no
  statistics yet), run with the clean-ups, at the start and every 6 hours (`host.js`, `app.js`).
  Never sampled (`analysis_limit`): sampled statistics made My Day's queries ten times slower.
  `synchronous` is as it was.
- **Usage without the dates nobody sees** (`usage.js`, `host.js`): `active_at` is
  shown only in the admin's dialog of one account (`GET /api/admin/users/:id/usage`, which asks
  with `{ activity: true }`). Settings › Plan (`/api/me/usage`) and the admin's list
  (`/api/admin/usage`) ask the modules' `usage(id, { activity: false })` and
  `usageAll(ids, { activity: false })`, and answer `active_at: null`: a module may skip the MAX of
  dates over whole tables that was ~90 % of both routes. The modules don't read the option yet;
  until they do, they still compute it.
- **The admin's list of accounts in a few queries** (`api.js`, `entitlements.js`, `accounts.js`):
  `GET /api/admin/users` asked four or more queries an account (905 for 301), now 6
  for all of them, with the same answer: `entitlements.plansOfMany(users)` (of() and sourceOf()
  of each, from ofMany()'s queries) and `accounts.providersOfMany(ids)`.
- **One session check a heartbeat for each stream of every module** (`live.js`, `host.js`): the
  host's `GET /api/events?all` was asked about by every module's heartbeat, the
  same session four times. `createLiveAll({ stillIn })` opens them (`subscribe()`) and asks each
  once a heartbeat itself, and at once when that person's sessions close (`recheck(userId)`); the
  modules' relays are opened with `checked: false`, so their heartbeats leave them out (`dropUser`
  still keeps the session kept). `subscribeAll()` takes `stillIn` and `onEnd` and returns
  `{ userId, recheck }`; without `stillIn` it is as it was. 9 tabs, 55 s: 72 → 18 checks.
- **Erasing one's data or importing with "replace" reloads only who it concerns**
  (`portability.js`): the `resync` went to every connected tab. Now to the person,
  everyone their rows share something with (whom their lists are shared with, who shared one with
  them, the other members of their groups: `peopleNear()`, read before anything is handed over),
  and with groups that changed, their members. A whole install's import still tells everyone.
- **Exporting lets everyone else in** (`portability.js`): a copy was read whole in
  one synchronous transaction, and its tables turned into JSON in one go. `prepareExportAsync()`
  (what `/api/me/export` and `/api/admin/export` use) reads on a second, read-only connection, in
  its own read transaction (one moment of the data, whatever is written meanwhile), pausing between
  tables and every 2 000 rows (`selectingRows()`, the steps of `selectRows()`); each table's JSON is
  written 2 000 rows at a time (`jsonOfRows()`, byte for byte what `JSON.stringify` wrote).
  `prepareExport()` stays as it was, for the command line and the tests; without a file to open a
  second connection on (`:memory:`), the routes use it.

## 0.283.0 — 2026-11-14

- **Settings › Sharing takes an app's own roles, as its share dialog does** (`web/shared.js`,
  `docs/web-kit.md`). `sharedSection` (and `sharedPage`) take an
  optional `permissions`: the same `[{ value, label, offered? }]` list `shareDialog` takes, broadest
  first, or a function of the item when the roles differ from one item to another. With two roles
  they are buttons, with more a list to pick from; a role with `offered: false` is shown in words, never
  given, changed or taken back there (a project's manager, to whoever isn't its owner). Without the
  option nothing changes: can view, can edit. Projects uses it for its three roles.
- **Projects' limit in Settings › Plan is of open projects** (`i18n`). `features.projects.max` said
  "Active projects", and the limit counts active and paused ones: "Open projects" now, in the five
  languages.

## 0.279.0 — 2026-11-14

- **Turning notices on works again on databases from before 0.255.0** (`schema.js`, suite migration 30):
  0.255.0 added `push_subscriptions.session_key` inside suite migration 13, which every existing
  database had already applied, so there the column never came. `POST /api/push/subscribe` failed with
  `no such column: session_key`, and so did the suite's clean-up (`push.purgeSessions()`). Migration 30
  runs `pushSchema` again, which only adds what a table lacks; new databases are unchanged.

## 0.277.1 — 2026-11-14

- **Tools that only read say every hint** (`READS` in `mcp-kit.js`, and the read tools of `host.js`,
  `links.js`, `calendar.js` and `mcp.js`): `destructiveHint: false` and `idempotentHint: true` besides
  `readOnlyHint: true` and `openWorldHint: false`. OpenAI's plugin portal flags a tool whose
  `readOnlyHint`, `destructiveHint` and `openWorldHint` are not all explicit booleans; in Cronum Work,
  the 28 that read.

## 0.277.0 — 2026-11-13

- **One public page for every module** (`public-page.js`, `web/public-page.js`, `web/public-page.css`).
  Tasks, Notes, Next and Projects each had their own copy of the read-only link, and they had
  drifted apart.
  `createPublicPage({ db, entitlements, table, publicUrl, find, ownerOf, changed })` now keeps it in
  one place: the token, on and off, a read that never turns it on, the plan's `publish` checked again
  when the page is served, an owner whose account is disabled (`disabled_at`) answering 404,
  `embed` only with the plan's `embed` (403 `embed_not_allowed`), the owner's own display name
  only (`publicOwnerName`: never the username nor the start of the email), `unpublish()` for
  hand-overs, no-store and noindex headers (`publicHeaders`) and `routes()`.
  - `web/public-page.js`: `publicDialog()` and `embedCode()`: the dialog reads the page with a GET,
    shows «Embed» once the plan is known, and copying says so once. `web/public-page.css`: the
    page's frame (bar, footer, embedded, refused, gone), whose bar stays inside a 320–430 px phone in
    every language. `kit.public.*`, `errors.public_not_found` and `errors.embed_not_allowed` in
    five languages; `.kit-public*` in kit.css; both files in the service worker's kit copy.
  - `time.js`: `dayStart(zone, day)` and `daySpan(zone, day)`, which Next and Notes had word for word.
  - Only additions: nothing that was exported changes.

## 0.274.0 — 2026-11-12

- **The admin's deletion ends what the person pays, as their own does** (`api.js`,
  `account-deletion.js`, `billing.js`, `web/admin.js`).
  `DELETE /api/admin/users/:id` took the account at once and left their subscription renewing at
  the provider: the next renewal charged someone with no account here, and nowhere to cancel it.
  Where the install ends subscriptions with the account (`accounts.endSubscriptions`, Cronum Work),
  the ones the person pays for themselves on the web are cancelled now, at the provider, before
  anything goes (`deletion.endSubscriptionsOf`, what the sweep does); if the provider can't end one
  that still renews, nothing is deleted: 503 `subscription_not_ended`, which the panel says, to try
  again. A group's subscription stays with the group. The log's `admin.user.remove` notes
  `subscriptions_ended`, `subscriptions_lapsing` and `store_subscriptions`.
  - One the person cancelled already, in the portal or by asking to go, no longer keeps the account:
    Paddle takes no other change on a subscription whose cancellation is scheduled
    (`subscription_locked_pending_changes`), so the deletion would have failed until its period
    ended, up to a year. It renews no more and lapses then (`subscriptions_lapsing`).
    `billing.endSubscriptions` asks every live one even when another fails, and throws only for one
    that still renews; `billing.stillRenews` counts one cancelled for its period's end (`ending`) as
    not renewing, for the sweep too.
  - With the login too (`?identity=1`), a provider of logins that then fails keeps the account, but
    what ended can't be taken back: the log keeps `admin.user.subscriptions_end` with
    `subscriptions_ended`, and the answer is 503 `subscription_ended_account_kept`, which says so.
  - `GET /api/admin/users/:id/subscriptions`, with billing or the stores on: each live subscription
    the person pays for themselves, the web's and the stores', as the overview has them, with `ends`,
    whether deleting the account cancels it. Never a ref: the staff's `/payments` (0.259.0), which
    the account's Payments fold shows with refs and their groups' too, stays as it was.
  - The panel's question says it first: the web's is cancelled now (`admin.users.deleteCancels`, or
    `deleteKeeps` where the install keeps them), and a store's goes on, since Apple and Google let
    no server cancel one: only the person can, in the store (`admin.users.deleteStore.*`, as a
    warning). What they pay unknown, nothing is asked. One cancelled already, on the web or in a
    store, says it won't renew (`admin.users.deleteEnding`), without the warning, and isn't counted
    in `store_subscriptions`.
  - `billing.cancels` (and `combinedBilling()`'s): whether the provider can stop a subscription from
    here, which the remote one can't; `deletion.endsSubscriptions`: whether deleting an account
    cancels the web's.
  - The person's own deletion, the other way an account goes: with the stores on, Settings' question
    says first that a subscription bought in the App Store or Google Play doesn't stop with the
    account, and where to cancel it (`kit.data.deleteStore`, then `kit.plan.store.*`, as Settings ›
    Plan says it); it said only "If you have a subscription, it stops renewing". One cancelled in
    the store already renews no more and isn't said. What they pay unknown, nothing is asked. The
    sweep's `account.delete` notes `subscriptions_ended` too.
- **An admin's sign-in again is a fresh one** (`workos-security.js`, `workos.js`,
  `workos-accounts.js`, `web/admin.js`). An admin with no password to give
  (Google, Apple, a company's sign-in) was confirmed by any session opened in the last 10 minutes,
  and the panel sent them to `/auth/login`, where AuthKit signs the browser in again without a word
  while its own session lasts: the question answered itself. Admins who sign in with a password
  give it again, as before.
  - The panel sends them to `/auth/login?prompt=login&return=/admin`: AuthKit asks again
    (`max_age=0`), and the browser comes back to the panel.
  - Their session counts only when they actively signed in after the server last asked them, in the
    10 minutes since: AuthKit's access token says when (`auth_time`, "a Unix timestamp, in seconds,
    of the user's most recent active authentication", which a session it reuses doesn't move;
    WorkOS, AuthKit › Re-authentication). `exchangeCode()` gives it as `authTime`, the callback hands
    it to `sessions.open`, and `createFreshSignIns()` keeps it per session for those minutes, with
    when each admin was asked, in memory: a restart asks again. `registerWorkosSecurityApi()` takes
    it as `freshSignIns` (createApp gives it): without it such an admin is never confirmed, where a
    recent session was enough.
  - It holds for 0.266.0's confirmation too, which stands 10 minutes in a session for a new
    account's login (`confirmAdmin(…, { recent })`, `POST /api/admin/confirm`): such an admin is
    confirmed only by a fresh sign-in.
  - Users › New account asks such an admin for it before its form shows, also for an account
    without a password: the sign-in leaves the page, and what they had typed in the form was lost
    on the way. Its 10 minutes run from that sign-in.
  - «Turn off two-step verification», in an account's dialog with WorkOS, sends them to it too, and
    shows its other errors (a wrong password or code, WorkOS down) to every admin: its `failed()`
    didn't exist, so since 0.146.0 the button did nothing when it went wrong.
  - `errors.reauth_required` no longer says a recent sign-in is enough: «Sign in again to confirm
    it’s you.», in the five catalogs.
  - The test kit's fake WorkOS gives `auth_time` as AuthKit does, and `signIn(…, { fresh: true })`
    signs in by `prompt=login`; it also finds a user by email and makes one, as Users › New account
    asks.
  - Tests: a new account's request, refused, is the question that the sign-in after it answers
    (`workos-security.test.js`, and `admin-create-account.test.js` over HTTP with the kit's fake
    WorkOS); they fail if it isn't noted.

## 0.273.0 — 2026-11-12

- **The eye in Settings' password fields too** (`web/settings.js`): as in the admin panel since
  0.269.0, every password Settings asks for has the kit's eye inside it (`revealable()`) to see
  what was typed before sending it: the current and the new one when changing it (here or at
  WorkOS), the one asked before turning two-step verification on or off, and the one asked before
  erasing one's data or deleting the account. The sign-in page's are as they
  were.

## 0.272.0 — 2026-11-12

- **Any shape of windows from the rail, each with its bars as they were left** (`web/windows.js`;
  docs/architecture.md §21.6): one window beside two stacked could be reached by dragging, but not
  chosen nor got back. `columns(n)` takes, besides 1–4 and '2x2',
  a shape: the windows each column stacks, `[1, 2]` (one window, two stacked beside it), `[2]` (one
  above the other) and so on, up to four columns and four windows. It fills by rows, as 2×2 did, so
  windows side by side stay so. A shape comes back with the shares its bars had the last time it
  showed: `work.layout` keeps them for every shape (`shares`) beside the layout.
  - New exports `asShape(n)`, `shapeOf(layout)` and `readShares(storage, n)`; `applyColumns()`
    takes `{ shares }`. What `work.layout` kept before reads as it did.
  - `createWindows({ onLayout })`: called with the layout in sight each time the windows are placed
    again (a shape chosen, a window carried or shown, a bar moved, a narrower or wider desk), so the
    shell's picture of it never stays behind.
- **A menu can hold a node of its own** (`web/ui.js` `menu(…, { body })`; docs/web-kit.md): after
  the items, a grid of choices, say; its buttons with `role="menuitem"` move with the arrows.

## 0.271.1 — 2026-11-12

- **Settings › Modules › On the bar: the daily summary's switch says «Daily summary»** (`web/settings.js`,
  `i18n/*.json`), the name of the page it shows or hides, which holds the evening's summary too.
  `kit.day.show` goes; the switch says `kit.day.title`.

## 0.271.0 — 2026-11-12

- **«Open in Apple Calendar» in the phone app** (`calendar-feed.js`, `web/settings.js`, `web/native.js`;
  docs/architecture.md §21.3.1): on an iPhone, in the app, the button did nothing. It is a
  `webcal:` link, and the app opens only http, https, mailto, tel and sms outside. Now
  `openExternal` takes `webcal:` too, for the app's builds that say they open it (capability
  `webcal`, Cronum Work's app 0.6.5); for older ones the button goes to the link's new `subscribe`
  address, `GET /api/calendar/subscribe/<token>.ics`, which sends to its `webcal:` one (302,
  `no-store`, `noindex`), so the browser the app opens hands it to Calendar. Outside the app,
  `webcal:` as before. The token's checks are the link's (404, braked when repeated).

## 0.270.0 — 2026-11-12

- **Settings in a host: the host's group in a new order** (`web/settings.js`; docs/architecture.md
  §21.1): Language and theme, Modules, Daily summary, Calendar, Notifications, Your
  AI, and Administration last. Nothing else moves; the sections keep their ids.

## 0.269.0 — 2026-11-12

- **An eye in the admin panel's password fields** (`web/ui.js`, `web/icons.js`, `web/kit.css`,
  `web/admin.js`, `i18n/*.json`), to see what was typed before sending it. Every
  password of the admin panel —a new account's, the one set for someone (here or at WorkOS), and the
  admin's own when it is asked again (the "Confirm it's you" dialog, deleting a login)— has a
  button inside it, at its end, that shows the text and hides it again (`aria-pressed`, "Show
  password" / "Hide password"), and puts the cursor back in the field.
  - The kit's `revealable(input)` wraps any password input with it, to hand to `field()` in the
    input's place; `field()` labels what a wrapper names in `labelTarget`, so its label and hint
    still point at the input. New icons `eye` and `eye-off`, texts `kit.password.show` and
    `kit.password.hide`. Settings' own password fields are as they were.

## 0.268.0 — 2026-11-12

- **Settings in a host, in a new order** (`web/settings.js`; docs/architecture.md §21.1): first
  the host's group (Modules, Language and theme, Your AI, Notifications, Daily summary,
  Calendar, Administration), then each module's, then Account (Profile, Password and
  access, where you're signed in, Plan, Delete my account), and About the whole app on its own at
  the foot. Connections is gone from a host. The sections keep their ids, so `?settings=` links
  still open them. An app on its own keeps its list as it was.
- **Settings › Modules: each module with its line, and the rail's buttons apart**
  (`web/settings.js`, `web/kit.css`, `host.js`, `i18n/*.json`): each module has its line under
  its name, from the host's catalog with `createHost({ moduleHints })` (`host.hints` in
  `GET /api/modules`), else its line in About. Under the modules, a block «On the bar» with what
  is a button on the rail and not a module, each a switch, in no order: the calendar (as before,
  now named Calendar with a short line), My day (the daily summary's button, new) and each door.
  - `createHost({ doors: ['croc'] })`: those modules are marked `door: true` in `/api/modules`,
    are turned on and off as before (`PUT /api/me/modules`), but leave the modules' order, have
    no group in Settings and no way to be installed alone, and are never the one module left on
    (`400 field_required`). A mount the host lacks is left out.
  - The daily summary's button is each person's to hide: `day_shown` in `GET /api/modules` (no
    choice yet: shown, as before), `PUT /api/me/day { shown }`. Migration 11 of the host,
    `host_day`. The summary itself, its notices and Settings › Daily summary don't change.
  - `kit.calendar.show` is gone (the switch says `kit.calendar.title`); new `kit.modules.barTitle`,
    `kit.modules.barHint`, `kit.day.show`, `kit.day.showHint`.

## 0.267.1 — 2026-11-12

- **A host's pages at `/` read the kit at its own address again** (`web/sw-core.js`): Cronum
  Work's calendar and daily summary showed their keys (`calendar.today`, `today.view.plan`) from
  their second load on. With the one copy of the kit (`sharedKit`), a module's page that asked for
  a kit file the copy lacked (`/projects/suite/i18n.js`, after the caches were cleared under a
  running worker) had the network's answer kept at `/suite/i18n.js` with its address. Served to a
  page at `/`, a module script reads its base from the address it answers with, so the kit there
  took Projects' base (`/projects/`) and asked for Projects' catalog, which has none of the host's
  texts. Now that answer is kept without its address, and a copy kept with another address (one an
  older worker kept, which the next releases carry while the file doesn't change) is served at the
  path asked (`suiteKeptElsewhere`).

## 0.267.0 — 2026-11-12

- **Settings › Calendar: what shows on it** (`calendar.js`, `host.js`, `web/settings.js`, `i18n/*.json`;
  docs/architecture.md §21.3.1): the section «Calendar subscription» is now «Calendar» and starts with a switch
  for each module with dates that the person uses (Tasks, Projects, Notes in Cronum Work), for every plan. One
  turned off leaves the calendar page and its filters, the link for calendar apps and the assistants' tool:
  it isn't asked. `GET` and `PUT /api/me/calendar/modules[/:mount] { shown }`, host migration 10
  (`host_calendar_modules`, a row for each module chosen; none, it shows), `host.calendarModules` in every
  module's config. The link (Pro's) follows under them, titled "Calendar subscription".

## 0.266.0 — 2026-11-12

- **New accounts in a row ask for the admin's password once** (`workos-security.js`, `api.js`,
  `web/admin.js`, `i18n/*.json`; docs/architecture.md §15): an admin makes several reviewers'
  accounts at a time. Users › New account no longer has the admin's own password in the form.
  When the server wants it, a dialog of its own asks for it over the form (and the code, with a
  second step), says a wrong one inside it, and sends the account again; given up, the form stays
  as it was. Once given, it stands **10 minutes in that session**, so the next accounts go
  straight in. An admin who signs in with Google goes to sign in again, as before.
  - `confirmAdmin(ctx, body, { recent: true })`: within 10 minutes of the last confirmation in that
    session, nothing to give; outside them, with nothing given, `403 admin_confirm_required` with
    `reauth` (`password` or `password_code`). New route `POST /api/admin/confirm`
    (`admin_password`, `admin_code` → `{ ok, until }`), only where the install owns the logins.
    Kept in memory by a hash of the session token: a restart asks once more.
  - Only a new account's login asks that little: setting someone's password, taking their second
    step off and deleting their login still ask every time, as before.
  - The inline hint `admin.users.reauthCreate` goes; `admin.confirm.*` and
    `errors.admin_confirm_required` come. No migration.

## 0.263.1 — 2026-11-12

- **The calendar link on Android** (`web/settings.js`, `i18n/*.json`): Settings › «Calendar subscription»
  › How to add it says, right after Google Calendar's steps, that Android's Google Calendar app can't
  subscribe to a link: it is added on a computer and shows on the phone, and if it doesn't, the
  calendar's Sync switch in the app turns it on (`kit.calendarFeed.howAndroid`, five languages).
- `calendar-feed.js`: its head says how a task that repeats comes now (each day ahead an item of its
  own from Tasks 1.153.0, an event with its own UID), not the RRULE it used to expect.

## 0.263.0 — 2026-11-12

- **The admin makes accounts that sign in at once** (`api.js`, `accounts.js`, `workos.js`,
  `workos-security.js`, `app.js`, `web/admin.js`, `i18n/*.json`; docs/architecture.md §15): test
  accounts for the App Store's and Google Play's reviews, testers, directories. Users › New
  account asks for the email first, a name, a role, a password and the plan from the start (its
  end and reason once one of its own is chosen), in a form dialog that says inside it what the
  server refuses. `POST /api/admin/users` checks everything before making anything; the plan goes
  in the account's own transaction (`accounts.create(fields, { also })`, `setPlan` as Users ›
  Plan does), recorded as `admin.plan.set` next to `admin.user.create`.
  - With local passwords: `email_verified: true` takes the email as confirmed
    (`accounts.create({ emailVerified })`), and without a username one comes from the email.
  - With WorkOS where the install owns the logins (`accounts.adminIdentity`, Cronum Work): a
    password makes the login at WorkOS with `email_verified: true` and the app's mark
    (`createUser`, `userByEmail` in workos.js; `logins` from `registerWorkosSecurityApi`), and the
    account here is linked to it. The admin's own password (and code) is asked again first, as for
    setting someone's password there; WorkOS's shortest password (8) applies. A login made for an
    account that then can't be made is deleted. Without a password, as before: the account waits
    for its person to sign in with that email.
  - New answers: `409 email_taken` (an account here has the email, whatever its case),
    `409 email_taken_provider` with `provider` (WorkOS has a login with it, perhaps another app's:
    never made again) and `400 password_not_here` (a password where logins are a provider's this
    install doesn't own, or OIDC's). `registerAdminApi` takes `localPasswords` (default true, as
    before) and `logins`; `accounts` exports `checkEmail`, `checkName`, `checkRole` and `byEmail`,
    and `checkPassword(password, min)` takes another shortest length.
  - The password reaches no answer, log entry or server line. No migration.

## 0.262.1 — 2026-11-12

- **The test kit's requests survive a connection the server closes under them**
  (`tools/test-kit.mjs`, `test/test-kit.test.js`; nothing changes for the apps themselves): Node's
  server closes a connection idle for 5 s, and fetch can reuse one at that very moment when a
  test's next request comes about 5 s later on a busy machine. The request never reaches the app,
  and fetch fails with a bare "fetch failed" (`other side closed`). Tasks' smoke test failed this
  way on `main` four times on 11/11, always in the first request after the sections that call no
  server (17i, «Units» or «Default list and language»), and passed on the same code in its pull
  requests. `client()`, `rpc()` and `mcp()` now send such a request once more on a new connection,
  as a browser does; a second failure, or any other network failure, is an error that names the
  request and why (`POST …/api/auth/login: fetch failed (UND_ERR_SOCKET other side closed)`),
  instead of "fetch failed" alone. A timeout and the caller's own abort are as before.

## 0.262.0 — 2026-11-12

- **The host's calendar in Google Calendar, Outlook or Apple Calendar** (`calendar-feed.js`, new;
  `host.js`, `plans.js`, `web/settings.js`, `i18n/*.json`; docs/architecture.md §21.3.1):
  `createHost({ calendar, calendarFeed: true })` gives each person a secret subscription link,
  `GET /api/calendar/feed/<token>.ics`, an iCalendar file (RFC 5545) of what the calendar page
  shows, from 60 days ago up to a year: all-day events, or half an hour at an item's time,
  with stable UIDs and a link back to each thing. Settings has a section of the host's to make
  it, copy it, add it to Google Calendar or Apple Calendar in one tap, make it again (the old one
  stops at once) or turn it off, with a line on how to subscribe in Google, Outlook and Apple.
  - Host migration 9, `calendar-feeds`: table `host_calendar_feeds`, one row a person (its
    token's hash, and the token encrypted with a key from the session secret, to show it again).
  - New plan feature `calendar.feed` (a flag, `COMMON_FEATURES`): false in `cronum-work`'s Free,
    true in Pro and Team. Only a host that declares it gates the link; without the option nothing
    of it is there, and nothing changes for an app on its own or a module.

## 0.260.0 — 2026-11-11

- **Invitations tell nobody's email, nor who has an account** (`sharing.js`, `stranger-invites.js`,
  `mail.js`, `web/share.js`):
  - By id (`user_id`) one names only one's people: whoever accepted something of theirs, offered them
    something, or has what they accepted (`knownTo(userId)`, a Set, now exported), or someone this
    thing was already offered to by id. An account only offered something by email is no longer one
    of them: after an offer by email, trying ids told whether the address had an account, and its id.
    `peopleOf` is those people, by name and without emails, as the modules' chips were.
  - A kind that keeps its offers by email under their address says where: `addresses: { table, key }`
    (a table with an `email` column). Then `sharesOf` for its owner shows every account by its name,
    never its email, and leaves out an account still waiting behind one of those offers, which the
    module lists; picking someone's chip told the owner their email, also once they accepted. By
    its id, such an account is a share that isn't there: `setPermission`
    answers 404, and so does `remove`, or done with `strictRemove: false`, changing nothing; unless
    the module changes its offer (`setPermission(…, { byAddress: true })`; `remove` after the module
    dropped the offer). Its own decline and leave are as before. Without `addresses`, nothing changes.
  - The brake counts every offer to someone who hasn't accepted it, by id as by email: a new one, one
    made again and, in `setPermission`, a change of what they may do. Each of those tells them (the
    kind's `offered` or `changed`), and one counted offer by id, made again and again, made their tabs
    reload without limit. What a member accepted changes as freely as before.
    `countOffer(userId)`, new, counts one for a module that changes an offer by address itself: it
    counts it before it changes anything, whether an account waits behind the offer or none, and
    `setPermission(…, { byAddress: true })` doesn't count it again.
  - `remove()` of a share that isn't there runs no hook: with `strictRemove: false` it still answers
    done, and nobody is told. Its `removed` told whoever the id named, and Tasks' tabs reload on that,
    so anyone could make anyone's reload without limit; every notice a removal
    sends now needs a share, and every share an offer the brake counted.
  - An offer by email takes a bare address only (`mail.js` `bareAddress()`): anything else is 400
    `field_invalid` (`email`), before anything is looked for or counted. `"x" <someone@…>` matched no
    account, went on as an address without one, and was delivered to someone@… under that name, past
    their blocking invitations and the limits per address. Nor the same address
    spelt another way a mail server delivers all the same: a dot at the end of the domain or an empty
    label in it, an invisible character (`\p{Cf}`, default ignorables), a letter NFKC changes.
    `check()` of stranger-invites.js answers `nobody` to anything but a bare address. Rows written
    before that say the address another way (a name around it, a dot at its end) are read as the
    address they reached: when `createStrangerInvites()` starts, a block is added for that address and
    a sent invitation is written as it, so an old «stop» still stops it and old sends still count.
  - The share dialog says one person invited by the name it showed (the chip's, or the address
    typed), never by another the answer brings.

## 0.259.0 — 2026-11-11

- **Admin › Users › an account › Payments, with «Manage charges»** (`billing.js`, `stores.js`,
  `stripe.js`, `app.js`, `web/admin.js`, `i18n/*.json`): what the account pays or paid, and the
  provider's own page to refund or cancel it, without knowing where it was bought.
  - A provider adapter, web or store, may give `dashboardUrl({ ref, customer })`: its dashboard for a
    subscription, for the install's staff. No call is made, and an answer that isn't https is none.
    Stripe's gives the subscription's page (a one-off's payment, else the customer's), in test mode
    with a test key. The Paddle and RevenueCat adapters of the hosted service's closed parts give theirs.
  - `billing.dashboardUrl(subject, ref)` and the stores' alike; `billingForAdmin(user, { instances })`
    and `GET /api/admin/users/:id/payments` (instance admin only, registered whenever the web's or the
    stores' payments are on): every subscription of the account's and of the groups it owns or
    administers, in both instances, live or over, newest first, with `ref`, `store`, `sandbox`,
    `live` and `dashboard_url`. Unlike `/api/billing/overview`, which the payer reads, it names the ref.
  - The account's dialog has a fold "Payments" right after its plan: how many are live;
    a row each (the kit's list, so on a phone its button stays in sight down to 320 px) with its plan
    and where (the store bought in, or the provider; «test» for a sandbox), its group, product, state
    and date, and "Manage charges" at its end, which opens the provider's page
    apart. One without a link says where to look and its ref. An install without payments has no
    such fold.

## 0.256.1 — 2026-11-11

- **"See plans" from a form, and only where there is a plan** (`web/api.js`, `web/shell.js`; checked in
  a local Cronum Work after 0.254.0). The form that met the plan's limit ("New notebook", "New list")
  is modal, so Settings opened behind it, out of sight, until it was closed: "See plans"
  (`kit.plan.see`) now closes it first (what it held couldn't be saved anyway) and Settings › Plan is in front. And
  the button is offered only in a host's module (`createShell` with a `mount`), where Settings has the
  plan: an app on its own under `/` opened Settings at Profile.

## 0.256.0 — 2026-11-11

- **Whoever only sees something can't change its links** (`links.js`, `web/links.js`):
  a link is written on both its sides, but its permissions asked only to see one. With a list shared to view,
  someone removed its owner's links, turned «done together» on so that the owner's tick completed a project
  task they can't open, and hung chips of their own on the owner's tasks. A module's `cards` may say
  `editable(user, id)` (they may change it, not only see it): linking and «done together» need it on both
  sides, adding something new from a side that side, unlinking to have made the link or to change one of its
  sides; otherwise 403 `forbidden`. `GET /api/links` says `can_link` and each link's `can_change`, worked out
  from what is read already, and the row offers "+ Link", "Complete together" and "Remove link" only then. A module
  without `editable` keeps seeing as enough. `links.canLink(user, ref)`.

## 0.255.0 — 2026-11-11

- **A device's notices go with the session they were turned on in** (`push.js`, `sessions.js`, `api.js`,
  `app.js`, `web/settings.js`): closing a session from Settings › Where you're signed in
  left that browser getting task titles and list names on its locked screen, and so did a session that ended
  on its own. `push_subscriptions` keeps the session it was turned on in (`session_key`, the public key of
  sessions.js, new column; null for rows from before or made with a device token) and loses the row when that
  session is revoked (`DELETE /api/me/sessions/:key`), signed out of (also without `push_endpoints`) or ended
  (the suite's clean-up, `push.purgeSessions()` after `sessions.purge()`). `POST /api/push/subscribe` says
  `user_id`. Settings › Notifications removes any one device (`DELETE /api/push/devices/:id`, a person's own
  only, "Remove" on each row, `kit.notifications.remove`), this browser's marked "This device" and letting go
  of its subscription too. `createPush` adds `removeDevice`, `forgetSession` and `purgeSessions`;
  `registerPushApi` takes `sessionKeyOf`; `registerProfileApi` takes `push`; `sessions.keyFor(token)`.
- **Signing out and in again keeps the notices true** (`web/signin.js`, `web/push.js`, `web/settings.js`,
  `web/worker.js`, `web/sw-core.js`): the server forgot the device and the browser kept its
  subscription, so Tasks said «This device receives notifications» and nothing came. `signOutHere({ forgetPush:
  true })` lets go of the browser's subscriptions once the server has heard (a host's, where nobody shares
  them; Cronum Work's shell passes it). Who turned notices on in this browser is kept per person
  (`markNoticesOn(userId)`, `markNoticesOff`, `noticesOnHere`; `kit.push.on` in localStorage), set by the kit's
  `subscribePush` and the worker's carry; `renewNotices({ userId })` turns them on again at the start of a
  session, without a question while the permission stands, only for that person. The worker tells the server a
  subscription the browser renewed (`pushsubscriptionchange`).

## 0.254.0 — 2026-11-11

- **A refund ends the subscription too** (`billing.js`). A full refund or a
  chargeback took the plan back at once, but the subscription went on renewing at the provider: the
  person was charged again the next period, and meanwhile the web's checkout said
  `already_subscribed` and Settings showed "Renews on…" (`kit.plan.renewsOn`). Now a refund that says `subscription`
  (Paddle's adjustments) also asks the provider to end it now (`cancelSubscription(ref, { now: true })`).
  Asked once: a row `stop:refund:<ref>` of `billing_events`, `pending` in the refund's transaction,
  asked right after it and, if the provider fails, again by the hourly `sendStops()`
  (`requested`, `already`, or `ended` when it had ended before it was asked). Only a subscription
  this install has and that still renews, or one waiting for its person: every destination hears
  every refund of the account, another product's too. Audited as `billing.refund.stop`
  (`admin.actions.billing_refund_stop` in the five catalogs). `sendRefundStops()` is new.
- **The host's own MCP tools go by the plan when called by their name** (`host.js`).
  `<host>_linked_items`, `<host>_link_item` and `<host>_calendar`
  were left out of someone's list when they couldn't use them, but a client that remembered a name
  still ran them. `allows` now answers them as `visible` does, with a sentence of why and where to
  change it; the links never reach into a module whose tools the plan leaves out (`item`, `from`,
  `to`, `create`), and that module's prompts are left out too. Today every plan of Cronum Work has
  `mcp`, so nothing changes there.
- **A plan's limit met in a module shows the way to Pro** (`web/api.js`, `web/ui.js`, `web/shell.js`;
  the notice with "See plans"). `offerPlan` was only used by
  Settings: a Free account that made its 21st list, uploaded a photo without room or saved a
  template read "Your plan (Free) allows 20, and you already have 20.", without saying of what nor where to
  go. Now a 402 met by any call of the kit's `api` is kept for ten seconds by its sentence, and the
  error notice that says it gets "See plans" (`kit.plan.see`), which opens Settings › Plan (`createShell` gives
  `onSettings('plan')` through the new `setPlanOpener`). Once, and only for those words, in all four
  modules without a change of theirs: each says its errors with the kit's `errorMessage` and `toast`.
  `errorMessage` names what `plan_limit` limits, as Settings › Usage counts it ("20 lists", "20
  notebooks", "10 projects", "50 MB of storage").
- **An account that goes takes its usage with it** (`entitlements.js` `forgetUsage`, `app.js`).
  Its rows of `entitlement_usage` (the calls of an assistant counted for a
  week's limit) name it by id alone and stayed for good: they go in the removal's transaction now,
  whatever `billing.forgetOnRemove` says.

## 0.250.0 — 2026-11-11

- **Nothing made without a signal is lost to a busy server** (`web/outbox.js`, `web/api.js`): a 429
  (and a 408 or 425) dropped the change it answered as a refusal, and the next one
  got the same and went too; with the signal back the page, the new worker and the queue start at once,
  and something before the server answers such a burst with 429. Now it waits like a 5xx, and a queue
  that listens tries again once, after the server's `Retry-After` (read into the error as
  `retryAfter`, in ms; `retryAfterMs(value)` reads seconds or a date) or half a minute, never more
  than five; a 503 only when it says when. A queue an app stopped to send itself (Tasks) gets no timer of its own. `waits(error)` is
  the outbox's own test, exported.
- **The first change kept asks for the storage to be kept** (`web/outbox.js`): the browser may
  clear a site's data when the disk fills up, and Safari after a week unused in a tab, and a queued
  change is the only copy of itself. `navigator.storage.persist()` once per page, unless already kept.
- **`sendWhileAway({ local, owner, send, idOf, onCreated, skip, lockName })`** (`web/outbox.js`):
  what an app left in its queue, sent while the app isn't on the page, for Cronum Work's
  modules not on screen (each one's `fresh.js`): ticks made on a phone in Tasks and then left for
  Notes waited until Tasks was opened again on that phone. Only what goes through cleanly, oldest
  first; a creation swaps its provisional id in the stored queue and `onCreated` hears it. The first
  change that isn't a plain yes stops it and stays, with the rest, for the app's own queue to settle
  with the person in front: no signal, a busy or failing server, a conflict, a refusal, another
  account's change, a provisional id with no creation, or one `skip(op)` keeps for the app. Under the
  outbox's lock. → `{ sent, left, stopped }`.
- **What is written in a form isn't thrown away by a tap outside or Escape** (`web/ui.js`): a tap
  above a phone's sheet is how one puts the keyboard away, and it closed Next's
  sheet with its three fields. Once a field of a `formDialog` (or an `openDialog` with
  `keepTyped: true`) holds something other than what it had when it first took the focus, a tap on the
  backdrop only takes the focus off it and Escape asks "Discard what you wrote?" (`kit.dialog.*`). The
  ×, Cancel and the app's own close are a choice and close at once. `keepTyped: false` for a form
  whose fields save themselves; `openDialog` keeps its old way unless asked. A read-only or disabled field
  never counts. `onDiscard` is told when the person says yes to throwing it away (a draft the
  module keeps goes too).

## 0.249.0 — 2026-11-11

- **The sidebar's search, the same in every module** (`web/shell.js`, `web/kit.css`, `i18n/*.json`;
  rule 9 of docs/web-kit.md's "Same in every module"):
  - Its field reads the kit's "Search" (`kit.side.search`, in each language)
    in every module. The module's own words (`search.label`)
    stay its `aria-label`; as the words in it, two of them were cut short. `search.placeholder` still
    replaces the word, and no module of the suite gives one.
  - Those words are in the kit's faint colour (`--kit-faint`, at full opacity), light and dark and in
    both looks: only Tasks had them so, by a rule of its own; the other modules showed the browser's
    grey.
  - The field has its own line height, 1.45, after `font: inherit`: Notes' page (1.5) made its box
    44 px tall against 43.2 in the others, and its magnifier sat lower.
  - «/» goes to it from a keyboard, in every module and on any device. Its key («/», a `kbd` hidden
    from a screen reader) shows at the field's end, never in its words, and only on a big screen with
    a mouse or a trackpad (a hovering fine pointer, the sidebar beside the views); it goes while the
    field has the focus or text. On the document,
    without Ctrl, ⌘ or Alt, not while composing nor once answered (`preventDefault`), not from a field
    or an editor, and not with a dialog, a menu, Settings or a drag over the frame (the frame's own
    drawer is no layer: the search is in it); only in the frame that has the keyboard, as Escape. Over
    a phone's detail the list comes back, a closed drawer or a sidebar folded away opens, and the
    field takes the focus. Tasks' and Notes' own «/» can go.
  - In a window of Cronum Work's shell, a frame told no `active` has the keyboard while windows.js
    marks its window the one in front (`data-focus="true"` on the window that holds `root`): Escape
    and «/» work in Next's windows too. `active` given still wins.

## 0.248.0 — 2026-11-11

- **An item's detail and a row's swipe, the same in every module** (`web/shell.js`, `web/swipe.js`,
  `web/drag.js`, `web/kit.css`; rules 5 and 6 of docs/web-kit.md's "Same in every module"):
  - `shell.head({ pane: 'detail' })` ends with the kit's × (`.kit-head__close`, `kit.close`) where the
    list and the detail sit side by side (`panes: 'split'` from 960 px, folded or not), where ← doesn't
    show; both call `onBack` (by default `showList()`). `close: false` leaves it out, for a detail that
    must not close. The modules' own × (`.detail-close`, `.detail__close`) can go.
  - Escape closes the detail open, as its ← or × would, whichever shows. Not while a dialog, a menu,
    Settings, the drawer or a drag had the key as it was pressed, not once something answered it
    (`preventDefault`), and not from a field or an editor. With the focus on no element, only the frame
    that has the keyboard: `createShell({ active })`, `ctx.active` in Work's shell, always on a page of
    its own. The modules' own Escape for the detail can go.
  - `rowSwipe(row, { content, left, right, ignore })` → `{ destroy }`: Tasks' swipe made the kit's. To
    the left the item to the trash (`trashAction(run)`, "Delete" in red), to the right the module's
    quick toggle; one action or two a side (`{ label, iconName, tone, run }`, or a function asked as the
    swipe starts), reached at 82 and 168 px, harder past 230; tones `danger`, `accent`, `sun`, `done`, in
    both themes. Touch only, not from the start edge, a control inside the row (`SWIPE_IGNORE`) or chips
    that scroll sideways; a vertical move first is the list's, and a drag (held still, or under way)
    wins. No click after it; mirrored right to left. What slides is the row's one child over the colour,
    or the row itself with the colour beside it, drawn the first time it is swiped (`.kit-swipe`,
    `.kit-swipe__bg`, `__content`, `__action`, `__icon`, `__label`).
  - `keepSwipe(row)`: a row with nothing to do keeps the finger, and swiping it does nothing. Both mark
    the row `data-own-swipe`, so Cronum Work's windows never switch module from it, and give it
    `touch-action: pan-y`.
  - While a row is swiped `<html>` has `data-kit-swiping` and the document hears `kit-swipestart` and
    `kit-swipeend`: `redrawInPlace()` waits for its end as for a drag's. drag.js exports `HOLD_MS` and
    `SLOP`, which the swipe reads; the service worker keeps `swipe.js`.

## 0.247.1 — 2026-11-10

- **Pro for good reads for good in Settings › Plan** (`planStatus` in `web/plan.js`).
  With two gifts of the plan shown, the card took the newest: the early access's Pro until 31/12,
  given after a Pro for good, made it read "Given to you until December 31, 2026". It takes the one
  that lasts longest now, no end before any date, as `entitlements.js` shows the plan.

## 0.247.0 — 2026-11-10

- **The sidebar and the heads, the same in every module** (`web/shell.js`, `web/ui.js`, `web/kit.css`;
  the first four rules of docs/web-kit.md's "Same in every module"):
  - `createShell({ create })` is the floating + at every width: beside the views it sits at the bottom
    end corner of the list's pane (never over the detail beside it; the view's with `panes: 'single'`),
    inside the frame, so in Cronum Work inside the module's window. The sidebar's button that created
    (`.kit-side__create`) and the one that came to the bar and to a list's head while folded
    (`.kit-bar__create`, `.kit-bar__create-label`) are gone. Its label is its title too.
  - `createShell({ foot: { create, trash } })`: the sidebar's foot, pinned under the nav that scrolls,
    with the room over a phone's bottom edge under it. A + that makes a collection at its start
    (`{ onClick }`, or `{ items }` for a menu over the drawer), the trash at its end (`{ onClick }`, or
    `{ href, current }` for a view of its own); each closes the drawer as an entry does. Their words are
    `kit.side.create` ("Create") and `kit.side.trash` ("Trash") unless given. `shell.foot` is
    `{ element, create, trash }`, and `setCurrent()` marks the trash too.
  - `navGroup({ name, color, icon, iconName, count, open, keep, onToggle, onName, empty, extra, data,
    headData, bodyData, children })`: a group of collections with one look (`.kit-nav-group`: its
    colour's border, tint and text, plain in the Clean look). The chevron folds it (`kit.side.groupFold`,
    `kit.side.groupUnfold`); the name opens its menu (`onName`, `kit.side.groupOptions`). It replaces
    Tasks' `.list-group-*` and Notes' `.nav-group__*`, whose own + goes into the group's menu.
  - `moreButton(items, { label })`: "…", `kit.more` ("More options"), the one button of a view's head.
    `shell.head()` no longer ends a list's head with anything that creates.
  - `menu()` leaves out falsy items and separators with nothing to separate, so a module writes
    `cond ? item : null`.

## 0.246.0 — 2026-11-10

- **Deleting and asking, the same in every module** (`web/ui.js`). What goes to a trash is deleted at
  once and leaves an Undo; what can't come back asks first, "Delete “X”?" in red:
  - `deleteDialog(name, { text, detail, title, confirm, parent })`: that question, with `kit.deleteAsk`
    and `kit.delete` (a red "Delete").
  - `undoToast(text, onUndo)`: the notice with `kit.undo` ("Undo"), 8 s, as `toast`'s action.
  - `confirmDialog` is 420 px wide on a computer (`QUESTION_WIDTH`) unless given a `width`: a question
    is narrower than a form (560 px). Without `text` the title alone asks.
- **Taking something back from someone in the share dialog asks first** when they had accepted it
  (`kit.share.removeAsk`, "Remove X's access?"); an invitation not answered yet still goes at once. An
  app's `confirmRemove` replaces it (Projects). Leaving it asks with the question as the title
  (`kit.share.leaveAsk`, "Leave “X”?"), as every question does now.

## 0.245.0 — 2026-11-10

- **The share dialog for an app with roles of its own** (`web/share.js`):
  Projects shares with it instead of a dialog of its own. New options, all optional, so every app that
  shares today stays as it is:
  - `permissions`: `[{ value, label, offered? }]` instead of can edit and read only; with more than two,
    the invitation chooses from a list, which fits a phone beside Invite. `offered: false` is said on
    the rows that have it and never given (a role only the owner gives).
  - `invitePermission`: what an invitation gives unless changed.
  - `load` answering `manage: true`: whoever manages without owning it (a project's manager) invites,
    changes and takes back as its owner does, and may still leave it.
  - `fixed(share)`: rows whoever manages keeps as they are, with what they may do instead of the list.
    One's own row always is.
  - `confirmRemove(share)`: the question asked before taking it back, with `kit.share.takeBack` as its
    button (Projects: their tasks are left without whoever does them).
  - `parent`: where the dialog and its questions hang, as `openDialog`'s (Projects keeps its dialogs
    in its window in Cronum Work).

## 0.244.0 — 2026-11-10

For selling Cronum Work Pro in the App Store and Google Play. Nothing changes without `STORE_BILLING`.

- **`GET /api/billing/stores/offer`**: what the app on a phone may sell an account now, asked before
  it opens its store: `{ blocked, customer, products }`. Whoever pays already, on the web or in a
  store, is `already_subscribed`, since neither store can be told to refuse a second subscription.
  Takes the phone's device token with `stores.devices`.
- **`stores.products.<key>.founderOf`**: a founder's product of its own in the stores, sold in place
  of the one it names to whoever the web gives the founder's price to.
- **Settings › Plan in the app**: "See plans" needs the install to sell in the stores
  (`modules.stores`, `app.host.stores`), shows too for a plan that ends on a date (the early
  access's gift, which paying carries on), and goes for whoever pays already or before sales open.
- A store's "Open the App Store" button goes through the bridge's `open-external` in the app.

## 0.243.2 — 2026-11-10

- **Settings › Plan says how much a year saves.** A yearly product's row has a badge with how much
  less it costs than twelve months of the same plan's monthly product, rounded down ("N% off"), more
  with a founder's price. `yearlySaving()` in `web/plan.js`. Only where the web sells, so
  never in the app on a phone.

## 0.243.1 — 2026-11-09

- **The same words and the same margin in every module**. Settings › Usage names notebooks in
  Spanish with the word the rest of the suite uses, and steps in every language for what Next
  counts, where it said entries. The two texts of the kit that still used another Spanish verb for
  deleting now use the kit's. `--look-gutter` is 16 px in the Cronum look, as a token:
  each module fell back on its own number (26, 24, 16 or 14).

## 0.243.0 — 2026-11-09

Other fixes:

- **A window out of view takes its dialogs with it** (`windows.js`): a modal dialog stays modal
  when its window is hidden, and the page behind it inert. A notice tapped or Back with Tasks' Configure list
  open left all of Work on screen and answering nothing.
- **The worker gives the copy instead of the server's error page** (`sw-core.js`): a navigation
  answered with a 5xx (a deploy's 502, Cloudflare's 52x) gets the copy when there is one.
- **A module's own path opens from the copy at once** (`sw-core.js`, `codeFirst`): `/tasks/list/12` is what
  the server answers for any path without an extension, the module's page, so it no longer waits up to 4 s
  for the network on a weak signal.
- **A reset at WorkOS leaves what was opened after it** (`workos-events.js`, `revokeEverything({ before })`):
  heard up to a minute later, it closed the session the person had just opened with the new
  password. Sessions, API tokens, phones and AI clients are ended as of the event's time.
- **Deleting someone's login with the account asks for the admin again** (`DELETE /api/admin/users/:id?identity=1`):
  the admin's password (and code), or a recent sign-in, as for changing a password or taking off the
  second step, and only where the install owns the identities (`accounts.adminIdentity`; elsewhere 403
  `identity_not_here`, and the panel doesn't offer it). `registerWorkosSecurityApi` answers `{ confirmAdmin }`.
- **The MCP door opens only for what it lists** (`mcp.js`): it ran any tool, so a tool the client had
  blocked could be run through it. A tool with `destructiveHint` is never kept behind it, and it no longer calls
  itself destructive.

## 0.242.0 — 2026-11-09

- **The founder's offer comes up on starting a host's shell**. `offerFounder({ user, busy })`
  (web/plan.js): a dialog with the price, the regular one and
  the last day, all from the server, with Buy, the same checkout as Settings' Upgrade, and Not now.
  At most once a week for the account: `founder_notice_at` in `users.prefs` (billing.js
  `FOUNDER_NOTICE_PREFS`, a part of a host's preferences when it has payments), stamped by the server
  when the browser says `founder_notice_seen`. Only to someone `founder_until` is said to, and who
  could buy: not to whoever has the plan for good or from a group, and never inside the suite's app.
- `lastDay(iso, { year: false })`: only the day and the month.

## 0.241.1 — 2026-11-09

- **Settings › Daily summary: each notice's time is an hour and its minutes, every five**. The time
  field took any minute on an iPhone (its wheel has no steps), and the server keeps
  only steps of five: 16:37 was kept as 16:35 with nothing said. Now there are two lists side by
  side, the hours as the language writes them (`08`, `08 AM`) and the minutes `00`, `05` … `55`.
  Either one changed saves the time they make together; refused, both go back. New texts
  `kit.day.hour` and `kit.day.minute`, in the five languages.

## 0.241.0 — 2026-11-09

- **A module's `start()` is told the host's day and who uses what** (`start({ day, uses })`, for
  Cronum Work's Croc, whose keys come from what was done today). `day.done(user, { day, every: true })`
  also counts the modules someone took out of the evening's notice. A module that takes no argument
  is as before.

## 0.240.0 — 2026-11-09

- **About says the version of the app on the phone** (on iPhone and Android it only
  named Cronum Work's, which is the page the app shows). Inside the app, a line «iOS app» or
  «Android app» under the version in use, with the number the app tells the page
  (`nativeInfo().version`). Nothing new in the bridge, so the builds already on people's phones
  show it too.

## 0.239.0 — 2026-11-09

- **The early access's plan, kept past its end for whoever was in it**. The plan of an early access
  is the default one, with no grant
  behind it, so when its date passed what Free doesn't keep went in the next sweep: `cutoff()` had
  no end to count from. `entitlements.keepEarlyAccess(users, { endsAt })`, and Admin › Plans with
  `GET /api/admin/early-access` and `POST /api/admin/early-access/keep`, give each account made
  before the early access ends one grant of its plan until that date, marked `external_ref:
  'early-access'`. Pressed again it gives nobody a second one, nor one to an account the admin took
  it off, and never one to an account made after the early access; a different date moves the end
  of those still standing. To be done before `EARLY_ACCESS_UNTIL` passes.
- **`FOUNDER_JOIN_UNTIL`: more time to join at a founder's price**.
  Accounts made before it, past the end of the early access, are founders too; nothing else moves.
  It can't come before `EARLY_ACCESS_UNTIL` nor after `FOUNDER_OFFER_UNTIL`.
- **Deleting the account in a host offers every module's copy**: the
  dialog offered only the module Settings was opened from, and whoever pressed it in Tasks believed
  they had everything. Now a link for each module, those turned off too.
- **`shareMail.notice`: a word by email about something of the person's own**, in the module's
  words and the suite's clothes, for what a push alone doesn't reach (Projects' warning before a
  finished project goes).

## 0.238.0 — 2026-11-09

- **In Cronum Work there is one way out**. A module's
  Settings › Sign out called the kit's `signOut` on its own: no question, and every module's queue
  on the device gone without a word (the shell's `leave()`, which asks and saves first, ran only
  from the account's Settings with no module in the window). Now `signOut()` is the shell's when
  there is one (the registry's `signOut`; also from a frame of the shell), and `signOutHere()` the
  kit's own; the module's `local` and `before` go along, and `before` still runs only once the
  server has heard. New in the registry: `signOut`.
- **"Replace" no longer takes away what someone shares**. Importing
  one's own copy with "Replace" emptied the account, and with it what other people were using,
  without a word. Now it hands it over first (`declaration.handOver`, as erasing does): the people
  using it keep it with what they wrote since, and the person gets their copy, theirs alone. Only
  for someone's own copy: a whole install's brings the shares back with both ends. A declaration's
  `shared(userId)` names what will pass on; the plan says it (`shared`) and the question before
  replacing too (`kit.data.sharedPassesOn`, five languages). A replace now tells `onErased` too, so
  a host's links forget what went.
- **`after`, a new hook of the declaration**: with every row in and
  inside the transaction, `after({ ids, rows, mode, user })` lets the app rewrite what no reference
  can say, a text that names another row's id. Its failure undoes the import.
  `portabilityFor` takes `onErased`.

## 0.237.2 — 2026-11-08

- **A host's worker opens the pages it holds from its copy, at once** (Work stayed blank on a phone
  with weak coverage). Since `codeFirst` the copy is the
  release, its pages too, yet a navigation still went to the network first and only fell back to
  the copy after four seconds: with a weak signal, four blank seconds on every start of Work and of
  every module installed on its own, and after a deploy the new page with the copy's old code. Now
  a page the copy holds at that path (`/`, `/w/`, `/tasks/`, with any query: `?w=`, `?open=`,
  `?auth_error=` are read by the page's code) is the copy's, without the `Link` hints the install
  was given, which named someone's answers for whoever was signed in then. The host's worker says
  where the server answers another page at the same path, `serverQueries: { '/': ['modules'] }`
  from the root page's `root.except`: `/?modules` stays network first. `/auth/`, `/devices/session`
  and `/devices/connect` never reach the worker, as before. A page the copy lacks comes from the
  network as before, and one of the shell's is kept. New releases come as before, with a new worker.
- **A host's release that loses the signal half way isn't installed**. The
  install swallowed each file that failed, noted `.suite-hashes` anyway and took over, and its
  activation erased the whole copy before it: the pages that always travel (`/`, `/w/`, each
  module's, the manifests, the scoped sheets, `js/app-version.js`) failed together and Work no
  longer opened offline until the next release, with nothing saying so. Now a file the network
  didn't bring (a failed fetch, a 408, a 429, a 5xx) is asked once more two seconds later; if it
  still doesn't come the install fails, so the worker before stays with its whole copy and the
  browser tries again at its next check. A 404, or no room on the device, still leaves that file
  out, and `.suite-hashes` is written only for a whole copy, without what it left out. The update
  notice's button no longer waits the whole handover (20 s in a host) for a worker that turned
  redundant: the page reloads on the one it has, and the notice comes back at its next check. An
  app on its own installs as it always did.

## 0.237.1 — 2026-11-08

**The app's bridge has two new messages, for Cronum Work's panels** (in the iPhone
app a swipe to the right in the daily summary went to Notes, or to whatever module was open
before it). `panel { open }`, from the web: one of the host's panels over the desk (the day's
summary, the calendar) opened, or the last one closed. While one is open the app (0.5.11) keeps
going back from leaving it: iOS's swipe from the edge is off, and Android's back comes to the page
as `back {}`, which closes the panel. Cronum Work's shell sends `panel` with `postNative` and hears
`back` with `onNative`; nothing in the kit changes, only native.js's header and docs/web-kit.md
name them. An older app ignores `panel`, and a web that never sends it leaves going back as it was.

## 0.237.0 — 2026-11-05

**Signing in with WorkOS or OpenID Connect goes straight to the provider's page** (the app's
card with one button, then the provider's page of another colour, read
as one redirection too many). With nothing to say first, `signIn()` sends the page to
`/auth/login` (with `return=` as the button did) in place of the card, so Back from the provider's
page doesn't land on it. The card still comes up after a failed return (`auth_error`), with the
notice of an account just deleted, back from signing out here (`leave()` marks the tab with
`suite.signedOut`), in a frame, inside the suite's app (its button hands off to the phone's
browser) and a second time within a minute in the same tab, so a session that never takes or Back
from the provider ends on the card instead of going round in circles (`straightToProvider()`).
Without sessionStorage, the card as before. And the card's button says «Sign in» with WorkOS, not
«Sign in with WorkOS», a name people don't know; an OpenID Connect provider keeps its name.

## 0.236.0 — 2026-11-05

**In the suite's app, Settings › Notifications says when notifications are turned off**. Off on
the phone, a notice says so and leads to the phone's settings: "Notifications are
turned off", "Turn them on in the <app> app's notification settings", and the button "Go to
settings". Never asked yet, the button is "Turn on notifications" and the app shows the system's
prompt. On, it stays "Open the app's settings". The state is the app's `push-state`, as before,
and the line "are turned off in the phone's settings" (`kit.notifications.appDenied`) is gone.

## 0.235.0 — 2026-11-05

**Admin › Accounts says how many devices each account has connected, and its dialog which**
(in Activity, "device 4" to "device 14" for an account shared by several testers read as 14
phones, while that number is the connection's id among every account's). With `modules.devices`,
Accounts has a Devices column, after the last sign-in: the ones that still work, not revoked nor
unused for longer than `idleDays` (`devices.activeCounts()`, one query for every account, and
`devices` on each account of `GET /api/admin/users`). An account's dialog has a Devices fold: each
one's name and platform, its app's version, when it connected and when it was last used, last used
first (`GET /api/admin/users/:id/devices`, `devices.list()`), with a line that says the number in
Activity names a connection and doesn't count them. It is drawn again after «Sign out
everywhere», which takes the phones too. Without the module there is no column, no fold and no route.
In the five languages.

## 0.233.1 — 2026-11-05

**A sign-in through WorkOS or OIDC is in the log with the address it came from**.
`auth.login` was recorded without the request when the provider brought someone back
(`sessions.open` in createSuite), so Activity showed nothing under From for every sign-in in an
install with WorkOS, while a password's sign-in, a failed one and a phone's connection had theirs.
Now it goes with the request, its address read as every other entry's is (`TRUST_PROXY`).

## 0.233.0 — 2026-11-05

**The admin panel finds one account: a search in Accounts, and Activity by account, by action and
by days** (to check, for one, that the testers who share one account signed in from
Android). Accounts has a search that narrows the list as it is typed, by email, username or name,
every word anywhere, without capitals or accents ("zoe" finds Zoë); Enter opens the one
account left, and the search stays when the list is drawn again (an account saved). An account's
dialog has «See their activity», which opens Activity at `#/audit?actor=<id>`. Activity has an
account (typed by email or username, offered in a datalist, or its name pressed in a row: the
email or username that is exactly one account's, else the only account the text is part of; with
several or none it says so and asks nothing), what to show (each family of the actions the log
holds, then each of its actions; Devices among them, which the list lacked), and two days, from
the first moment of one to the last of the other in the browser's zone. The filters live in the
address (`#/audit?actor=3&action=device.create&since=2026-11-01&until=2026-11-05`), «Older» pages
with all of them on, an answer to a filter changed since is dropped, and «Clear filters» takes them
off. `GET /api/admin/audit` takes `exact=1` (that action alone; without it `action` is still what
actions begin with, now with `_` and `%` as themselves) and `since` and `until` (ISO times, both
included; 400 `field_invalid` for what isn't one); `GET /api/admin/audit/actions` → `{ actions }`,
the names the log holds (`audit.actions()`). No migration: the filters read the columns and
indexes the log already has. And Enter on an account's row with the focus opens it again: it
opened the dialog and, its default kept, the same key pressed the dialog's ×, which had the focus.

## 0.232.1 — 2026-11-05

**The share dialog says an address with no account is invited too**. Since 0.215.0
an email with no account gets an invitation to create one, with the offer waiting under the address
(`stranger-invites.js`), but `kit.share.emailHint` still said "If that email has an account, they'll
get the invitation". Now, in the five languages: "If they don't have an account yet, they'll get an
email to create one, and the invitation will be waiting." It still says nothing about whether this
address has one.

## 0.232.0 — 2026-11-05

**Settings › Daily summary: choose the modules of each notice, and a section that sits right on a
phone**. Each notice has a switch for every module in use that gives it something
(«Includes»: Tasks and Projects in the morning; Tasks, Projects, Next and Notes in the evening),
when there are two or more: `prefs.day.<notice>.modules` keeps the ones taken out (`{ notes: false
}`), so a module that comes later is in, and one taken out is left out of that notice and of its
part of the page (`agenda` or `done`, `DAY_PARTS`). `PATCH /api/me` changes one module at a time
(400 `field_invalid` naming `day` for one that isn't a mount or a switch that isn't true or false).
`/api/modules` says what each module gives the summary (`day`). The section was drawn with the
kit's field, as wide as its box, and a plain link beside it: on an iPhone the time field ran under
«See today's», which read as text. Now each notice is a block of its own: its switch, the time in a
row of its own as wide as a time, the modules, and a button with a sun or a moon to its page.

## 0.231.0 — 2026-11-04

**A host's daily summary: what everyone has for today, and what they did, in every module, with a
notice in the morning and one in the evening**. `createHost({ day: '/today/' })`
(day.js, architecture §21.3.2): each module says what it has with `createModule().day`, `agenda(user,
{ today })` (open things dated on or before today, overdue being before it, and what was planned
for today without a date) and `done(user, { day })` (completed, logged or written that day), and the
host's page asks `GET /api/day?date=` at the root → `{ date, modules, overdue, today, done, failed? }`,
each module asked at once in the person's zone, 200 of each at most, a module that fails named and
left out. Every person has two notices, `prefs.day = { morning: { on, at }, evening: { on, at } }`,
on at 08:00 and 19:00 (the morning off for whoever had turned off Projects' summary of due dates,
`prefs.notices.due === false`), saved with `PATCH /api/me` at the host's root and shown in Settings
› Daily summary, in the host's group (switch, time every five minutes, a link to the page). With
push, the host checks them every minute: from its time until three hours after it, on the person's
day, claimed in the new `host_day_notices` (host migration 8) before anything is built or sent, and
not sent when there is nothing to say: "☀️ Here's what you have to do today", "3 overdue · 5 for
today: “A”, “B” and 3 more" at `/today/`; "🌙 What you did today", "7 tasks, 2 steps in Next and 1 note"
at `/today/?v=done`, in the person's language (`kit.day.*`, every catalog). A module's suite says
`daySummary: true` (and `config.host.day` the page, in the browser too), for Projects to leave out
its own 08:00 summary inside Work; `/api/modules` says `host.day`. The page may be framed by the
host's own pages, as the calendar's. Without the option nothing changes, and an app on its own has
none of it.

## 0.230.0 — 2026-11-04

**In the app, a module's page on its own opens in Work's shell instead.** A notice tapped on the
phone opens its module's address (`/projects/?project=5`, `/tasks/`: host-worker.js `hostedPush`),
and the app's web view loaded it as a page of its own: the module alone, its switcher under the
logo and none of Work's tabs at the foot (Projects' daily summary, for one). Now
`createShell()` replaces such a page with `/?open=<its path>`, which the shell opens in its window
as it does for a notice tapped on the web: from the host's answer of last time at once (before the
rail is drawn), else from the one that comes. `hostShellAddress(host)` in native.js says where, or
null to stay: outside the app, in a frame, as a window of the shell, in a host without a
one-document page (`/api/modules`' `host.shell`) and anywhere but under a module's path. A browser,
and a module installed alone, are as before. Nothing changes in the app, and no new build is needed.

## 0.229.0 — 2026-11-04

**Whose it is, the same in every module**. What
someone shares stays theirs: whoever edits it can't destroy it or take it away. `ownership.js`:
`requireOwner` / `requireOwnerOrAuthor` / `mayDelete` answer 403 `not_yours` with the owner's
name ("This isn't yours: ask Ana to remove it or delete it", in the five languages), with
`copy: true` on a move so a copy may be asked for instead; `givesTo` says whose something becomes
when it goes into someone else's container ("It will be Ana's"); `tellGone` tells whoever used a
shared container its owner deleted, by push and by email (`shareMail.gone`, new); `pickHeir`
chooses who inherits what a leaving owner shared. In the page, `web/ownership.js`: `moving(send)`
offers the copy and `confirmGive` asks before giving (in the worker's copy of the kit).
mcp-kit's `describeErrorWith` adds the sentence of `<code>_<hint>` when an error carries a `hint`.
Additive: nothing changes for a module that doesn't use them.

## 0.226.3 — 2026-11-04

- **Work's phone tabs come back where they belong when the keyboard goes down.** The field loses
  the focus as the keyboard starts going down, while the app's web view is still short, and the
  tabs came back then: for a moment over where the keyboard had been, then at the foot (on an
  iPhone, 0.226.0). `watchKeyboard()` now tells the keyboard down only once the page has its room
  back. A page still short a second after the focus left, with nothing typed in, isn't a
  keyboard's, and the tabs come back then. `keyboardShortens()` takes `up`.

## 0.226.2 — 2026-11-03

**A host's worker installs its copy 12 files at a time, not all at once.** The first time
someone signed in to Work on a device, its worker asked for Work's 200-odd files at the same time
as the page loaded its modules, and some of them came back 429: a module whose code was one of them
didn't open ("Importing a module script failed"), and only closing the app brought it. Measured on
Work, 12 at a time installs as fast as all at once, or faster. A file that fails
is still left out, and the rest still come. An app on its own installs as before.

## 0.226.0 — 2026-11-03

**Work's tabs on a phone step aside while typing, when the keyboard makes the page shorter.** In
Work's iPhone app the web view stops above the keyboard, so the bar of modules sat on it, taking
room and of no use while typing. keyboard.js has `watchKeyboard(onChange)` and
`keyboardShortens()`: up while a field or a frame has the focus and the root is more than 120 px
shorter than its tallest at that width (in Safari `innerHeight` shrinks with a keyboard that only
covers the page, the root doesn't). windows.js gives the desk `data-keyboard` with it and
windows.css hides `.cw-tabs` on a narrow desk; they come back when the keyboard goes or the focus
leaves. In Safari and Chrome the keyboard only covers the page, the tabs already under it, and
nothing changes.

## 0.225.0 — 2026-11-02

- **A write whose answer is too big to keep replays a small JSON body**. Over 256 KB the key was
  kept with an empty body: the same key
  answered 200 with nothing in it, so a creation sent again never learnt its id (the outbox kept the
  provisional one, and what came after it was dropped as `lost_creation`) and the client read
  `null`. Now it replays `{ id, replayed: true, reload: true }` (`id` when the answer named one at
  its top), and the route still runs once. Smaller answers replay whole, as before.

## 0.224.0 — 2026-11-02

**No button for the person at the sidebar's foot: the app's icon opens Settings.** In an app on
its own (Tasks, Projects, Next, Notes or any other app at its site's root, or installed from Work on their
own) the person's button at the sidebar's foot is gone, and with it `.kit-side__foot` and
`.kit-account`. The app's icon and name at the sidebar's head are a button from the start, with
Settings' icon in place of the arrow, that opens Settings; with `accountItems` (or without
`onSettings`) it opens the account's menu instead. In a host nothing changes: the rail has Settings
where the sidebar stays, and on a phone the same button's menu has the other modules and Settings.
`setUser()` stays (the menu's Administration still asks who it is) and draws nothing. The
sidebar's list keeps clear of the phone's bottom edge in every frame now, not only in a host's.

## 0.222.0 — 2026-11-02

Changes made without a signal, on leaving and on another account signing in.

- **Signing out without a signal deletes nothing.** `signOut()` ignored a logout that didn't reach
  the server: it deleted every `*-local` copy, with the changes waiting in it, and reloaded, while the
  session went on at the server. Now, without a signal or with the server in trouble (5xx), it says
  so (`kit.account.signOutOffline`) and everything stays; a session that had already ended (401)
  lets go of the device as before. It answers `true` when it left, `false` when it stayed.
- **`signOut({ ask })`** asks first, with the count, when changes wait anywhere on the device
  (`kit.account.unsent`, «Sign out anyway»): new `pendingChanges()` counts every `*-local`
  `outbox` (the modules not open too, without opening anything else) and the preferences kept.
  `ask` can be a function `(n) → Promise<boolean>`. **`before`**: what the app does once the server
  has heard, before the device lets go. Without the options, as before (except the offline case).
- **Whose each queued change is**: `createOutbox({ owner: () => id })` keeps the id with each change (or `add({ owner })`, for one made before the server has said who is signed in),
  sends nothing while it isn't known (null), and never sends another account's: a session that
  ended with changes waiting, then someone else signing in on the same browser, sent them with the
  newcomer's cookie. They leave the queue unsent (`report.others`, not `onDropped`), and
  `outbox.keepOnly(id)` lets go of them at once. A change kept before it had an owner goes as before.
- **A preference that reaches the server takes the older one out of the queue** (`save()`): sent
  later, the queued one undid it (Notes turned off again, the old theme). A PUT's address goes
  whole; a PATCH of the person (`…/api/me`, any module's path: one row in a host) only the fields
  it said, `prefs` key by key.
- **`flushSettings()`**: one copy of the kit at a time (a Web Lock, `suite.settings.queue`: every
  module carries its own copy in Cronum Work), each change read from the queue as it goes; the
  server in trouble (5xx, 429) keeps the change, only a refusal (4xx) drops it; a change kept more
  than a day doesn't go; an ended session keeps the queue (it is kept with whose it is) instead of
  forgetting it; and without `localStorage` the queue is kept on the page instead of nowhere.
## 0.221.0 — 2026-10-31

Payments, `/health` and the CLA check.

- **A customer the checkout didn't name is never linked, not even one nobody here has**.
  The fix of 0.128.0 kept another account's customer from going to whoever paid a
  checkout made without one (`customerUnsigned`), but a customer linked to nobody here was linked
  all the same: the same Paddle account sells other apps, so someone paying with another app's buyer's
  email could end up with their customer, and open their portal (invoices, address, the card's
  last digits). Now that link isn't made either, and the audit says so
  (`billing.customer_unvouched`); the plan is still theirs, since they paid. New
  `errors.email_unverified`, for a provider that refuses a checkout without a verified email
  (the Paddle adapter of the hosted service's closed parts, so its checkouts always name the customer).
- **Tests of what guards the payments**: the `unsigned` and `customerUnsigned`
  branches were only tested in the hosted service's closed parts, pinned to an older suite-core. Now billing.test.js
  covers them, so a change here that breaks them fails here.
- **Checkout and portal braked per account**: 10 in 15 minutes, `429
  too_many_requests` past that. Each asks the payment provider, whose API quota other apps of the
  same account share. New `limiter.allowFor(kind, userId)` and `limits.billing`;
  `registerBillingApi` takes `limiter`.
- **An account whose subscription never stopped renewing waits up to a week**: when
  the provider failed both when the person asked to go and on the day the account goes, it went
  and the subscription went on charging. Now the account waits for the next sweep while
  `billing.stillRenews(userId)` (new; also in `combinedBilling`) says so, a week at most past its
  day; then it goes all the same, logged loud.
- **`/health` without `uptime`, and only up when the database answers**:
  `{ ok: true, version: { app, version, built } }`, or `503 { ok: false }`. In a host it is the
  host's own, with the fingerprint `/version` gives (it gave the root app's, which never matched).
  New `healthOf(database, versionOf)` in app.js.
- **CLA check pinned by commit**: the shared workflow at a commit of cronumstudio/.github
  instead of `@main`, with the write permissions on its job alone; it now runs on GitHub's machines
  and pins its action by commit.

## 0.220.0 — 2026-10-31

The service worker, the host and Work's shell:

- **A scoped sheet is kept once per file**. The host kept each module's sheet with
  `@scope` (`scopedSheets`) under the address as asked, so `/tasks/css//styles.css?scope=work`,
  `/tasks/c%73s/…` and any other spelling of the same file each kept a copy (some 43 KB) for good,
  without a session: anyone could fill Work's memory. Now the key is the file's own address, which
  also gives every spelling the same ETag and the same url()s; and at most 200 are kept.
- **A newer worker taking a page over is said to the page**. New `watchNewCode()` in
  `web/update.js`: `stale()` once a worker other than the page's first took it over without
  `applyUpdate()` here (another window reloaded, a notice came). What such a page loads late comes
  from the new copy, and joined to the old code it already runs it may not load at all (Settings
  importing a name the old `base.js` doesn't export). A page that lives for days asks before
  loading code late and brings the new version instead.
- **A notice tapped with Work's shell open opens there**. The host's worker gets
  `holds` (`['/', '/w/']` with a root page, `pages[].root`): one of those pages open gets
  `{ type: 'notification-open', url }` and the focus, instead of being navigated to the module on
  its own with every window in it; with none open, a new window opens `/?open=<the module's
  address>`. Without a root page, as before.
- **`framedModules`**, a host option: the modules' pages may be framed by the host's own pages
  without a split view (Work's shell opens a module it can't mount in a frame). `split` still
  implies it.
- **`@keyframes` carry the module's name** in a scoped sheet: `fade-in` in Tasks and
  in Next were one name in the shell's one document, the last sheet loaded winning. A module's
  own `@keyframes` become `<mount>--<name>`, with its `animation`s; the kit's sheets and the
  kit's names (`kit-…`) stay. `SCOPE_FORMAT` 3.
- **How the server rewrites the sheets is part of the version**: a release that only
  changes `scope-css.js` is a new worker, so installed copies don't keep the old sheets.
- **A module's stop is waited for** when the host closes, three seconds at most: a
  module's `start()` may return a stop that returns a promise (the notices it groups, sent now).
- **Two modules' tables are compared before the second's migrations run**: its
  migrations are tried first on an empty database, and a table a module joined before declares
  (`portable.tables`) stops the start without touching the real one. The check once every module is
  in stays for the rest.
- **A body over the limit closes the connection**: after the 413 the server no longer
  reads the rest for ever. `requestTimeout` is ten minutes instead of none (receiving a request, not
  answering it: live channels stay open).
- **A static file gone halfway cuts its response** instead of an uncaught error that stopped the
  process (`pipeline`).

## 0.219.0 — 2026-10-30

- **Public pages free, embedding them Pro's** (Projects, Notes and Tasks get a public page
  of their own, like Next's; its link for everyone, putting it in another website for Pro, and
  then without the Cronum Work mark). `publish` goes on in Free in the cronum-work catalog. New
  common feature `embed` (off in Free, on in Pro; without `PLANS`, allowed), named in the plan's
  benefits. **Interface:** `embed.unbranded` (0.218.0) is gone: an app that declares it moves
  to `embed`.

## 0.218.0 — 2026-10-30

- **Pages any site may embed** (a Next project's public page, in an `<iframe>` on someone's
  own website). Every page answered `frame-ancestors 'none'` and `X-Frame-Options: DENY`, so the
  browser showed nothing. New `embeds` option of `createApp`, a list of paths: those pages go
  with `frame-ancestors *` and without `X-Frame-Options` (which can't say "any site"); the rest of
  the policy stays. A host passes its module's `embeds` at the module's own paths, split view or
  not. For pages that only show, without a session: nothing on them acts on anyone's behalf. New
  `frames: 'any'` in `securityHeaders`.
- **`embed.unbranded`**, a common feature: an embedded page without the Cronum Work mark under it.
  Off in Free, on in Pro (cronum-work catalog); without `PLANS`, allowed.

## 0.217.0 — 2026-10-30

- **One layout of Cronum Work's windows for every width** (the installed app on a computer:
  making the window narrower, Next alone became Tasks and Notes side by side, and a phone's single
  window below that). `windows.js` kept a layout per screen class (`wide` ≥ 1280 px, `mid`
  ≥ 768 px, `narrow`) and crossing from one to another brought back that class's, so the modules
  in sight changed with the width. Now there is one, `work.layout` = `{ all }`: a narrower desk
  squeezes it into the columns that fit, as it already did within a class, and a phone shows its
  focused window. On a phone a tab (or a swipe) moves the focus within the layout, or brings the
  module into the focused window's place, instead of making a one-window layout of its own: what
  was beside it is there again when the window widens. Interface: `writeLayout(storage, layout)`
  loses its `screen`; `readLayout(storage, screen, …)` keeps it only to read a layout kept per
  class before (that screen's, else a wider one's), until the next change writes over it.

## 0.216.0 — 2026-10-30

- **A phone's first sign-in goes back to the app** (Cronum Work's app on Android: signing in
  for the first time, the Custom Tab stayed on Work's home page; the second time, already signed
  in, Allow went back to the app). The provider's callback (WorkOS and OIDC) always went to `/`,
  where `devicePages.back()` found the connect cookie and sent the browser back to
  `/devices/connect`; but `/` is the app's, and Work's service worker, which Chrome shares with the
  Custom Tab, answered it from its copy when the server took longer than four seconds. Now the
  callback, once the session is open, goes straight to the connect page with the cookie's request
  and clears it: new `connectAfterSignIn({ config, sessions })` in `device-pages.js`, passed by
  `createSuite` as the new `afterSignIn` option of `createWorkosAccounts` and `createOidcAccounts`
  (`(req, res) => path | null`, asked only when the sign-in would land on `/`: one that began
  elsewhere, with `return`, still goes there). `back()` on `/` stays for a callback that came there
  all the same. The service worker leaves `/devices/connect` to the network (`SUITE_EXACT_NEVER`),
  as it does `/devices/session`. The cookie now waits 30 minutes instead of 10 (`CONNECT_MS`): a
  first sign-in may be a sign-up with an emailed code and a second step; it holds nothing secret,
  and the page still asks for Allow.

## 0.215.0 — 2026-10-30

- **An address without an account gets the invitation by email too**. Something offered by email
  already waited under the address for whoever signs up with it; now that address is told, once. New
  `stranger-invites.js` keeps it from looking like spam: only where an account can be made (WorkOS,
  or sign-up open) and only from someone whose email is confirmed; once per address and person,
  never sent again; at most 10 a day from one person, 3 in 30 days to one address and 100 a day
  from the whole install (`MAIL_STRANGERS_PER_DAY`; reaching it sends the `strangers` alert to
  `ALERT_EMAIL`, to raise it); never to an address that blocked them. `suite.shareMail.stranger({
  email, inviter, kind, name, … })` writes it in the inviter's language: the same message, a line
  saying to make an account with that same address, the button "Create account and accept" to
  sign up and come back to the module, and a link to block invitations, with the one-click
  `List-Unsubscribe` headers (RFC 8058; `mailer.send({ unsubscribe })`). `GET /api/mail/unsubscribe?t=…`
  asks and a POST blocks them: by a random token, never the address in the link; the address
  is never in the log either. `sharing.js` calls `notify.stranger` for an address without an
  account, after answering the same as for one with it. Migration 29: `mail_stranger_invites`,
  `mail_suppressions`. `renderMail` takes `unsubscribe: { text, label, href }` and a button that
  posts (`button.post`, for pages).

## 0.214.0 — 2026-10-30

- **The status bar in the page's ground** (Notes installed on an iPhone: a blank band at
  the foot of the screen, which moved when dragged beside the open drawer). With the see-through
  status bar (`black-translucent`) and `viewport-fit=cover`, iOS 26 shows an installed app shorter
  than the screen by the status bar (WebKit 301108); an app takes the opaque one (`default`), as
  Cronum Work's shell did in its 0.29.5, and that bar has the colour of `theme-color`. A page whose
  `theme-color` metas say `data-kit-ground` gets them painted by `theme.js` in its ground (the
  body's background, as `rgb()`), and again whenever its theme, look or app change. Opt-in: a page
  without it keeps its `theme-color` as it was.

## 0.213.0 — 2026-10-30

- **The invitation email knows a project of Next**. `suite.shareMail` takes a new kind, `plan`: a
  Next project offered to follow, to
  read (every step taken and the next one) or to log its steps too, with `mail.share.plan.*` in
  the five languages. Its name is `plan` because `project` is already a place in a team of
  Projects, given with a role.

## 0.212.0 — 2026-10-29

- **Emails in the product's clothes, and one invitation email for every module** (the
  email of a list shared with you said only that, in plain text, with no Cronum Work, no logo and
  nothing about what it is; Projects sent none). New `mail-layout.js`: one HTML layout for every
  message the suite sends —the product's icon and name over a cream sheet, a big heading ending in
  the yolk dot, a clear button, small print, a line on what the product is—, made of tables and
  inline styles so Gmail, Outlook (its button in VML) and Apple Mail read it alike, narrower on a
  phone and dark in dark mode; every text escaped, only http(s) links and images, no hidden text,
  and the plain-text part saying the same. New `share-mail.js`, `suite.shareMail({ to, actor, kind,
  name, icon?, permission?, role?, url? })`: a list, a notebook, a group of notebooks, a note or a
  place in a project offered to someone, in their language (texts `mail.share.*` in the five), with
  the module over the heading in its colour and in a card with its icon, and the button "View and
  accept" to the module. In a host it is signed by the host (Cronum Work) and goes to the module's
  address. The account's own messages (confirming an email, a new password, the admin's
  invitation, a deletion) go in the same layout, their link as the button (`mail.*.button`).
  New in suite.config.js: `app.mail` — `icon` (a PNG on the app; `/icons/apple-touch-180.png` by
  default), `colorOnDark`, `signature` and `about` by language — checked on start.
- **An invitation always comes by email, and by push too** (whoever is invited in any
  module should get the email besides the notice). `sharing.js` sent the push alone to whoever had
  a device that takes it, and the email only to whoever had none; now the email goes to everyone
  and the push as well where it reaches, still once a day per pair. One that fails leaves the other.

## 0.211.0 — 2026-10-29

- **A login shared with other apps goes with the account only when nobody needs it elsewhere**
  (deleting a test account in Work kept its WorkOS user, so signing up again asked for no
  code; and someone leaving Work for good should be able to leave everything). With
  `accounts.sharedIdentity`, each app that signs in with the same WorkOS users notes itself on
  the person's user (`app_<id>` in its metadata, with the app's name): when they sign in, and
  once, a minute after starting, for whoever came before. Deleting one's account then:
  - asks nothing of someone no other app has noted, and their WorkOS user goes with the account
    when their days are over, unless another app has noted them by then;
  - shows someone who uses another app which ones, with a box, unticked, to delete their access
    there too, and what that means (what they have there stays: delete it or cancel a
    subscription there first). Unticked, only this app's account goes and they still sign in to
    the others.
  - In /admin, deleting someone says which other apps they use and keeps their login unless the
    box is ticked (`DELETE /api/admin/users/:id?identity=1`; WorkOS not answering deletes
    nothing).
  A login that stays no longer names this app. New: `GET /api/me/deletion`, `GET
  /api/admin/users/:id/other-apps`, `/api/auth/config`'s `deletion_identity`, the request's
  `identity` (true or false), migration 28 (`users.delete_identity`, `user_identities.marked_at`),
  `createWorkosAccounts`' `mark` and `confirmDialog`'s `more`. It can't go with
  `deleteAtProviders`, which always deletes the login.
- **"Erase my data" says the account stays, and where deleting it is**. Its confirmation
  adds that only the data goes and the account stays active, and, to delete the account too, to
  go to Settings › Delete my account (in a host) or to use it further down (an app on its own).

## 0.210.2 — 2026-10-29

- **An assistant is named in a few letters: "via Claude", not "via AnthropicClaudeAI"**. Claude's
  web and desktop apps call themselves `Anthropic/ClaudeAI`, which the
  list of known assistants didn't have, so their label was the name cleaned of its signs. The
  known names are compared now without case, spaces or signs (`Anthropic/ClaudeAI`, `claude-ai`
  and `Claude AI` are «Claude»; `claude-code` and `Claude Code` «Claude Code»…); an unknown one is
  its title or the last part of its name, in 24 letters at most (it was 40). A session opened
  before this version keeps its id and is named again from it, so the next call is already
  «Claude»; what was written before keeps the name it got.

## 0.210.1 — 2026-10-29

- **On a phone, a task's row keeps its swipe and every module swipes to the next** (swiping a task
  deleted it and brought the next module in too; from Projects,
  Next or Notes the swipe did nothing). The swipe of Cronum Work's windows (`windows.js`) now gives
  way to whatever has a sideways gesture of its own and says so with `data-own-swipe` (Tasks marks
  its rows from 1.124.1). And once a finger goes more across than down it keeps the touch's moves
  from the browser: in a module's list (a scroller) the browser took the sideways pan for itself
  whatever the desk's `touch-action` said, and cancelled the swipe; only Tasks, whose lists say
  `pan-y`, swiped. Up and down still scrolls, and what slides sideways itself still does.
- **Inviting an email answers the same whether it has an account or not, also the second time**.
  Offered again before it was accepted, an address with an account answered `invited:
  false` and one without `true`, and only the second kind ever ran into the hourly limit. Now an
  offer by email not yet accepted is `invited` and counted each time, as an address without an
  account is; and one's people (`peopleOf`, the share dialog's chips) name someone known only
  by offers not yet accepted by the address it went to, not by the account's name. Tasks' list
  shows its pending shares the same way from 1.124.1.
- **«Every tool from the start» stays on** (Settings › Your AI in a host). The switch sent its
  `PUT` to the module's base (`/tasks/api/me/ai-tools`), which answered 404, and went back; it
  goes to the host's own route at the site's root now. The kit's client has `api.root.put` and
  `api.root.patch` beside `get`, `post` and `delete`.
- **Escape closes only the dialog over Settings**, not Settings with it: the key reached Settings
  before the browser closed the dialog. Settings close with Escape only when nothing is over them.
- **An account's Extras in /admin no longer show "null"** where there was no history (or nothing
  to add): those parts are left out, as the rest of the page does.

## 0.210.0 — 2026-10-29

- **A Save in an account's dialog in /admin says it saved** (the changes were kept, but
  the window did nothing). Its notice was there, under the dialog: a modal dialog is drawn over the
  whole page. The kit's notices (`toast`) go to the browser's top layer while a dialog is open, over
  it, in every app. And the dialog's Save of the profile and of the plan is grey until something
  differs from what was saved, says "Saving…" and then "Saved" beside it, and is grey again until
  the next change; the fold's summary says what was saved. The plan of an account that follows the
  default plan can still be saved as its own from the start, as before.
- **/admin › Plans shows every module's limits in a host** (in Cronum Work only the calls
  from assistants a week showed). Those were the host's catalog; each module's (own lists, sharing,
  photos and files, storage, notebooks, active projects…) were in force but not shown. The host
  answers `GET /api/admin/plans/modules`, and the page draws a table per module under the host's,
  with the same plans. The suite's common features have their words in every language
  (`features.<key>`), over the English label a module gives them.

## 0.209.0 — 2026-10-29

- **Paddle and RevenueCat leave the open repository**. `paddle.js` and `revenuecat.js`, with their
  tests, are now in the hosted service's closed parts, registered from outside before
  the app starts (`providers.js`, 0.208.0); this copy registers Stripe and `remote`, and no store
  provider. An install that names `BILLING_PROVIDER=paddle` or `STORE_BILLING=revenuecat` without
  them registered doesn't start, and is told which providers the image has. Migration 19 and the
  `paddle-sandbox`/`revenuecat` ids in the data stay as they are.
- **A provider may keep an app's ids itself** (`catalog`): the price ids of each product
  (`price`, `founderPrice`, `oldPrices`) and its own `billing` settings, for the app whose
  `app.id` it is given, counted as if the app's suite.config.js had them. So a hosted provider's
  ids stay out of an app's open config. Given both there and by the provider, or for a product
  the app doesn't have, is an error.
- The tests of organizations' subscriptions and of the stores run on stand-in providers instead of
  Paddle and RevenueCat (`test/fake-provider.js`, `test/fake-store.js`). `tools/test-kit.mjs` no
  longer exports `fakeRevenueCat`, `revenueCatWebhook` or `revenueCatSubscription`: no app used them.

## 0.208.0 — 2026-10-29

- **Payment providers by registration, never by name** (what only the hosted
  service uses leaves the open repositories). `BILLING_PROVIDER` and `STORE_BILLING` name what
  `providers.js` has registered (`registerBillingProvider`, `registerStoreProvider`): each
  provider reads its own variables (`fromEnv`), its own settings of suite.config.js `billing`
  (`rules`, such as Paddle's `paddleProductIds`), the side of a price given per environment
  (`environment`) and what its price ids look like (`priceId`), and creates its adapter
  (`create`). Stripe, Paddle, `remote` and RevenueCat register themselves there, so nothing
  changes for an install: the same variables, the same errors and warnings. A provider from
  outside this repository registers the same way before the app starts (`node --import`), and
  an unknown name lists the ones the image has. Migration 19's body moved to `schema.js`, and
  `STORE_FIELDS` to `stores.js` (`revenuecat.js` still exports it).

## 0.207.1 — 2026-10-29

- **Settings without a signal listen only once used, never on import** (Projects' mount rule
  failed with suite-core 0.205.0: importing its `main.js` added two listeners). `settings-queue.js`
  added the browser's `online`/`offline` listeners at the top of the module, so a module of
  Cronum Work did something just by being imported. Now `connection` starts listening on first
  use (`offline`, `on`, `check`, `noted`), once, and reads `navigator.onLine` again then.

## 0.207.0 — 2026-10-29

- **What an assistant does says which assistant it was** (the activity log said the person did
  everything, when an agent did most of it through the MCP). Each MCP server hands its
  tools `principal.via`: the assistant the call comes from («Claude Code», «ChatGPT», «Codex»…),
  as its client named itself when the session began (`clientInfo`, `clientLabel()`). It travels
  in the session's id, so a deployment doesn't lose it; a call without a session has none. A host's
  `recordChanges` writes it in each `mcp.tool` line (`meta.via`), and the admin's Activity shows
  it with the person: "@ana · via Claude Code" (`admin.audit.via`). Nothing changes for an app that doesn't read it.

## 0.206.2 — 2026-10-28

- **A module installed on its own has Settings of its own too** (with Notes installed on
  its own: its switcher no longer offered the other modules, but Settings still listed their
  sections). Settings ask the same as the switcher (`installedAlone`, now in `base.js` for both):
  in a module's page installed as an app of its own, never a window of Work's shell nor a frame
  of the split view, Settings show the account's sections, the module's group and the host's
  (administration, About), without the choice of modules nor another module's group; Your AI's
  prompt and About's cards name only that module.

## 0.206.1 — 2026-10-28

- **A phone's swipe between modules leaves alone what slides sideways itself** (in Work
  installed on an iPhone: Next's line moved and came back instead of showing what came before,
  and swiping the Gantt went to another module). The swipe of Cronum Work's windows
  (`windows.js`) took any sideways finger in the window, and moved the window with it while the
  line or the chart tried to scroll. Now a swipe that begins on a box with more to show across
  (Next's line, a row of chips) or on one that takes sideways pans as its own (`touch-action:
  pan-x`, the whole Gantt) is that box's; elsewhere in the window it still brings the module
  beside.

## 0.206.0 — 2026-10-28

- **A module installed on its own shows only itself** (someone who wants one module shouldn't see
  the others): its switcher offered the other
  modules, so closing the app on one of them opened it there the next time. In an app window
  (`display-mode: standalone`, or an iPhone's home screen) a module's page whose host opens its
  app on a page of its own (`pages[].root`, Work's one-document shell, now `host.shell` in
  `GET /api/modules`) is that module installed on its own: no rail, no other modules or calendar
  in the switcher, which keeps Settings and the account, and it isn't kept as the host's module
  used last. In a browser tab, inside Work's shell or in a host without such a page, all is as
  before.

## 0.205.1 — 2026-10-28

- **The confetti is seen over a dialog, and stays when it closes** (trying it in Next and
  Projects: the confetti should come as Done or Save is pressed, not once saving is over): the burst
  goes in the browser's top layer (a manual popover) in the module's root, so a dialog's Save can
  celebrate as it is pressed, and the dialog closing doesn't take the confetti with it. Without
  popovers it hangs in the open dialog, as before.

## 0.205.0 — 2026-10-28

- **Settings without a signal** (some parts of Settings wouldn't open offline in Cronum
  Work, they gave an error). Settings are drawn from the install's config of last time, kept on
  this device for each app's path (`settingsConfig()`): offline each module got no
  `/api/auth/config` and drew itself as an app on its own, without Modules, deleting the account,
  the other modules' groups or About of the whole app. Then, for each kind:
  - **What only the server knows** (Password and sign-in, Your AI, Notifications, Plan, where the
    session is open) says «Needs a connection» in its place instead of a toast and an empty
    section, and is drawn again, fresh, once the server answers.
  - **Preferences go in a queue** (the theme, the language, the look, the name, the modules in use
    and their order, the calendar's button): applied here at once, kept on this device
    (`settings-queue.js`, one change per address, the last choice wins) and sent in order when the
    server answers again, by Settings or by the next page that starts the kit (`flushSettings()`
    in `createShell`), only while the same person is signed in. Signing out forgets them.
    Settings › Modules draws the modules of last time and keeps a change for the rail of the next
    page too: `hostModules()` now keeps the host's answer (`host.modules`, `HOST_MODULES_KEY`)
    whoever asked, Cronum Work's shell included, which kept it under its own key only.
  - **What can't wait** (the email, exporting, importing, erasing, deleting the account) stays
    there but turned off, saying it needs a connection, and comes back on with it. Administration
    says so instead of opening a page the browser can't load.

## 0.204.2 — 2026-10-28

- **The plan's list in a host says the host's calls by the week** (in 0.203.0 Pro showed 1,000
  calls a day): Settings › Plan opened from a module listed its own features
  and those of the other modules in use, never the host's, so Cronum Work's 2,000 calls a week
  didn't show and Next's own daily 1,000 did. The list now asks the host's root too, and by the
  week the daily line is left out (0.203.0).

## 0.204.1 — 2026-10-28

- **A module installed on its own stays in its app after signing in** (on an iPhone, Notes
  installed from Settings opened Cronum Work whole, with Tasks failing to open, where it should have
  shown Notes alone): WorkOS's `/auth/callback` always went to `/`,
  which in Cronum Work is its one-document shell, outside an installed module's scope, so iOS
  showed it in a sheet over the module. The sign-in screen's buttons now say where they were
  (`/auth/login?return=/notes/`, the whole window's page when framed), WorkOS keeps it in its state
  cookie as OpenID Connect already did, and the return lands there. Only a path of the app:
  `//other.site`, `https://…` or a backslash go to `/` as before.

## 0.204.0 — 2026-10-28

- **The celebration when something is done is the suite's** (Tasks' option made
  a general one, for every module and Cronum Work's calendar): `web/celebrate.js`, taken from Tasks, with
  `celebrate(origin, { root })` —confetti from what was ticked and the "ding"— and `playStep()`
  for a part done. Its confetti is animated with the
  Web Animations API, so it needs no stylesheet, and hangs in the open dialog the origin is in (a
  dialog is drawn over everything else). One choice, in Settings › Language and theme › «When
  something is done»: animation and sound, with a button to try it, kept on the device
  (`suite.celebrate`); until the person chooses there, what they chose in Tasks
  (`tasks.celebrate`) holds, so nobody's setting flips. The worker keeps `celebrate.js` with the
  kit.

## 0.203.1 — 2026-10-28

- **Cronum Work opens on its shell offline, not on the home** (the phone app in
  airplane mode): offline, a navigation that the network didn't answer
  got `/index.html` from the copy before the page kept at its own path. In a host whose start is a
  page of its own (Work's shell at `/`, `pages[].root`), `/index.html` is the home that chooses
  modules, so the installed app and the phone app, which open `/`, got the home, which needs the
  server, and showed "Something went wrong" (`errors.generic`). The page kept at the path asked for comes first now; an app
  on its own keeps the same page at both, and a module's route without a page of its own still
  gets its module's index.

## 0.203.0 — 2026-10-28

- **Calls from assistants by the week** (as AI plans count them: 100 calls a day was so many that
  nobody would reach it and move to Pro): a new common feature, `mcp.calls_per_week`, counted from
  Monday 00:00 UTC. An app that declares it is counted by the week instead of by the day
  (`countWeekly()`, and `weeklyLimitText()` for the assistant when they are used up). Its uses are
  kept by the day under `mcp.calls_per_day`'s key, so a host that moves to it keeps the days it
  already counted. In `cronum-work`, Free has 100 a week and Pro and Team 2,000; `mcp.calls_per_day`
  stays as it was (100, 1,000) for whoever still declares it, and the other catalogs are untouched.
  New: `entitlements.countWeekly()`, `better()`, `usedThisWeek()` and `weekStart()`.
- **The usage panel by the week**: with the calls counted by the week, `GET /api/me/usage` and the
  admin's add `period: 'week'`, `week` (this week's) and `more` (the next plan with more, or null).
  Settings › Plan › Your usage shows this week only: "This week", "Starts again on Monday" and a bar
  for each day, Monday to Sunday, with their initials and the days still to come empty, without an
  average. The limit shows while a bigger plan has more to offer, or from 75 % of it: on the top
  plan a bar almost empty would only say how little it is used, so it says the calls alone. The
  admin sees the limit always and the last four weeks from Monday, a gap before each, with the
  average a week since the account was made. A plan's list says "100 calls a week from your AI",
  and leaves out the daily calls a module of the host still declares. By the day everything
  is as it was.

## 0.202.3 — 2026-10-28

- **Cronum Work installed opens without a signal**: its one-document shell loads the kit's
  `windows.js` and `windows.css`, which no module's page loads, and the service worker didn't keep
  them (`SUITE_KIT_FILES` in `sw-core.js`): offline the page stayed blank before any module could
  open on what it had kept. Both are in the copy now, and a test checks that every script and
  sheet of the kit is, but the pages of their own (admin, connecting a device) and the worker.
- **…and its modules aren't unstyled offline**: each module's sheets scoped to its windows
  (`/next/css/styles.css?scope=work`, `scopedSheets`) were only kept once a page with the worker
  in control asked for them, so a new copy (a new release, a first install) opened without a
  signal showed the modules without their styles. With `scopedSheets` the host's one worker keeps
  them from the start, with no hash of their own: the kit writes them too, so they always travel
  again.
- **Installing says every module works offline**: Settings › Modules' "Install on your device"
  said only Tasks and Notes went on offline; Projects and Next do too now (Projects 0.82.0, Next
  0.59.0), so its third step says the work goes on without a connection, whichever module it is.

## 0.202.2 — 2026-10-28

- **The MCP works on a computer with Avast** (the suite's tests failed on such a computer):
  Avast's Web Shield, with its MCP detection,
  rewrites any answer to a path ending in `/mcp` (or a GET ending in `/sse`) that has a
  `Content-Length` into one that says `transfer-encoding: chunked` and isn't, so the client fails
  with «Invalid character in chunk size». It happened to every MCP client on such a computer,
  against production too (`https://work.cronumstudio.com/mcp`), not only to the tests. A chunked
  answer it lets through, so `sendJson()` and `serveStatic()` leave the length out for those paths
  and Node sends them chunked; the OAuth modules (`oauth.js`, `workos-accounts.js`) use `http.js`'s
  `sendJson()` instead of a copy of their own. Everything else keeps its length. On that PC
  `npm test` now passes whole (951), where 25 tests failed.

## 0.202.1 — 2026-10-28

- **A third step for installing**: Settings › Modules' "Install on your device" ends with what
  installing gives: it opens like any other
  app and keeps what was already seen on the device, to look at without a connection; in Tasks and
  Notes the work goes on offline too, sent when the connection is back (Next and Projects show
  what they last had, but don't change offline).
## 0.202.0 — 2026-10-28

- **The calls from assistants averaged over the days the account has** (for an account only a few
  days old, the number shown said nothing): in /admin › Users › Usage and in Settings › Plan › Your usage,
  an account younger than a month says "Last 3 days: 91 calls, 30.3 a day on average" (and
  "First day: …" on the day it is made); from its 30th day, the last 30 as before. The usage's
  `mcp` carries `since`, the day of `users.created_at`, and `countedDays(mcp)` (usage-view.js)
  counts from it, or from the first call if that is earlier (an account brought from an app).
  The chart is still the month, today the last, the days before the account an empty slot.
- **Each bar of the month says its day and calls** (pointing at a bar should say that day's
  calls): every day is now a column as tall as the chart, so a quiet day
  is as easy to point at as a busy one, and pointing at it, or tapping it on a phone, shows
  "Oct 29, 2026: 5 calls" (`kit.usage.dayCalls`) above the chart, kept inside it at both ends. It replaces the
  browser's `title`, which only showed on the bar itself and never on a phone.
- Texts: `kit.usage.month` is now `kit.usage.lastDays` (`{n}` the days, `{calls}`, `{avg}`; a
  plural), with `kit.usage.calls`; `kit.usage.dayCalls` takes `{calls}` instead of `{n}`. An app
  that overrode them has to rename them.

## 0.200.0 — 2026-10-28

- **Each person puts the modules in their own order**, and the bar shows their icons in that
  order: in Settings › Modules each row has a grip, dragged up or down, or pressed for "Move
  up" and "Move down" (the keyboard and a screen reader too). `PUT /api/me/modules/order` keeps
  it (`host_module_order`, migration 7 of the host), and `GET /api/modules` lists the modules in
  that order, so the rail, a phone's tabs, Settings and the host's home all follow; one the host
  adds later comes last. The order isn't which they use: a module turned off keeps its place.
- **Installing on this device, step by step** (the old title could be read as Work's own home
  screen): Settings › Modules' section of icons on the home screen is now "Install on your
  device". On the web: install the host or each module on its
  own, 1) click or tap the one you want (its button, now just its name), 2) this device's way
  (\`installKind\`: an iPhone or iPad, Android, Safari on a Mac, Chrome or Edge, or that Firefox
  installs nothing on a computer). In the suite's app, which is the host installed already, only
  the modules, each opened in the browser (\`open-external\`), with the phone's own steps.

## 0.199.0 — 2026-10-28

- **A module turned off leaves Cronum Work's windows at once** (a module unticked kept its icon in
  the side or bottom bar): windows.js `drop(module)` takes
  its window out of the layout, as it shows and as it is kept on the device, and its tab out of a
  phone's bar; the windows that stay take its room (with none left, the first module shows), and
  the shell gets it back through `onEvict` to unmount it.
- **Settings › Modules in a frame tells the page around it too**: a module shown in a frame (Work's
  shell in a browser without `@scope`, the split view) said `kit-modules` only to itself, so the
  page framing it never knew a module was turned on or off; now it says it on its parent's
  document as well.

## 0.198.0 — 2026-10-28

- **Maximize and restore without a stretched window** (in a smaller window the content looked
  distorted; the box's transition was right, the content's was not): the window's box still grows
  or shrinks to its place, and in it what it
  shows now comes in over what it showed, each drawn at its own size from the top corner, never
  scaled (a view transition: windows.js `crossfade`, windows.css `cw-win-max`). The other windows
  fade with the page. Browsers without view transitions, and a restore that is part of another
  change (a window shown, a link to another window, a new layout), keep the slide; with less
  motion asked for, none.

## 0.197.1 — 2026-10-27

- **One Spanish word for "Off"** under Settings › Modules' "Show the calendar", the one the rest of
  the suite uses. And suite-core's own tests now check that no Spanish text uses the other: until now only Tasks'
  smoke test did, so a word written here failed later, in the app that bumped the submodule.

## 0.197.0 — 2026-10-27

- **The calendar, framed by the host's own pages** (so the calendar can be a window like the
  modules'): a host with a calendar and `pages` of its own lets those
  pages frame the calendar's page (`frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`), so
  Cronum Work's shell can open it in a window. Every other page of the root is still framed by
  nobody, and a host without `pages` keeps its calendar unframed. `createApp({ frames })` takes a
  function of the path as well as `'none'` or `'self'`.

## 0.196.0 — 2026-10-27

- **Two questions the first time** (for the beta, when Work is opened for the first time): with
  `createHost({ firstQuestions: true })` the host's first
  start may ask, once and skippable, how someone heard of the app (`HEARD_FROM`: reddit, social,
  friend, search, other) and whether they have a channel, blog or newsletter, with its address.
  `GET /api/modules` says `first_questions: true` until they answer or skip
  (`PUT /api/me/first-answers { heard_from, has_channel, channel }`, all optional; new host
  migration 6, `host_first_answers`). The admin sees them in the account's dialog, in a fold of
  their own (`GET /api/admin/users/:id/first-answers`). The texts are the kit's
  (`kit.firstQuestions.*`). Off unless the host passes it: nothing changes for an app on its own.

## 0.195.0 — 2026-10-26

- **The calendar's button, for whoever wants it** (so the view stays simple for whoever wants a
  plain interface): Settings › Modules has a switch, "Show the calendar", off to begin with.
  On, the rail has the Calendar button (on a phone, the modules' menu); off, the rail is as it was.
  `GET /api/modules` says `host.calendar` only to whoever has it on, and `calendar_shown` to
  everyone where the host has a calendar; `PUT /api/me/calendar { shown }` changes it (new host
  migration 5, `host_calendar`). The page and `<host>_calendar` stay for everyone.

## 0.194.0 — 2026-10-26

- **A calendar for the host** (`calendar.js`, `createHost({ calendar: '/calendar/' })`, Cronum
  Work): what has a date in every module the person uses, by day, on a page of the host's own.
  A module gives it with `createModule().calendar.range(user, { from, to })` (architecture
  §21.3.1); the host asks them all at once in the person's zone at `GET /api/calendar`, and one
  that fails is left out and named (`failed`), never the whole answer. The rail has a Calendar
  button over the split view, and on a phone the modules' menu has it. Assistants get
  `<host>_calendar`, the same days as text. Off unless the host passes `calendar`: nothing
  changes for an app on its own.

## 0.193.4 — 2026-10-26

- **Rows don't light up as a fold moves under a still pointer** (as if the panel were selected for
  an instant): switching groups in Settings slid the list under the mouse, and each
  row passing beneath it took the hover colour for an instant, then the one left under it lit up
  at the end. While a fold moves, and until the pointer moves again, the root says so
  (`data-kit-folding`) and Settings' rows, the sidebar's entries and its fold headings keep their
  colour.

## 0.193.3 — 2026-10-26

- **No blink or jump when one fold closes as another opens** (in Settings): each motion
  holds its last frame until the fold is put as it ends, so no frame shows the closing one whole
  for an instant (Safari drew one between the end and the hiding); and a fold's padding shrinks
  with it, so the one closing goes all the way to nothing instead of stopping at 6 px and
  vanishing, and the one opening starts from nothing.

## 0.193.2 — 2026-10-26

- **Folds move so it shows** (they didn't seem to open smoothly): the slide lasts
  320 ms on an even curve (it used to cover two thirds of the way in the first 45 ms, which read
  as instant), and what a fold holds fades in and out with it. Where the person asks for less
  motion a fold no longer jumps: what it holds fades in or out in 160 ms, without sliding. The
  chevrons turn in the same time.

## 0.193.1 — 2026-10-26

- **Two-step verification says whether it is on** (`web/settings.js`, `web/kit.css`,
  `i18n/*.json`). Its block in Settings › Password and sign-in now opens with a badge, **On** (green,
  with a tick) or **Off**, instead of leaving it to the first word of the text and the Turn off
  button. The texts under it lose that first word (`kit.twoFactor.off`, `.on`, `.onNoCodes`); new
  `kit.twoFactor.statusOn` and `kit.twoFactor.statusOff`, and `.kit-badge--on`.

## 0.193.0 — 2026-10-26

- **With WorkOS, two-step verification is offered to everyone** (`workos.js`,
  `workos-security.js`, `CONVENTIONS.md`). Since 0.127.0 only administrators were offered it
  while it was tried with AuthKit. Tried: with the environment's Multi-Factor Auth set to
  **Optional** in WorkOS's dashboard, AuthKit asks whoever turned it on for the code at every
  sign-in, and nobody else; with it **Off**, the factor is kept and never asked for. So
  `WORKOS_TWO_FACTOR` is now `on` when unset; `admins` and `off` still hold it back. Whoever
  signs in with Google, Apple, Microsoft or GitHub is still not offered it.

## 0.192.2 — 2026-10-26

- **About shows Cronum Work's version again, from every module**: a module mounted in a
  window of Work's shell starts no update watcher of its own (the shell's is the whole app's), so
  its Settings › About had none: «—» for the version, no module's version on its card, and «Check
  for updates» answered that the server couldn't be asked, though the shell's notice of a new
  version came. With no `updates` of its own, About now uses the page registry's
  (`workRegistry().updates`, and its `applyUpdate`, which waits for the whole app's worker).
## 0.192.1 — 2026-10-26

- **Cronum Work installs from its split view too**: installing it from an address like
  `/?w=tasks:…|notes:&f=notes`, Chrome said the page had no manifest, though it has one. Chrome
  asked for the page outside a navigation (in its console, the FetchEvent of that address), and the
  worker took it for a file: its fetch failed with no copy to give, and the error was the answer. A
  page asked for outside a navigation is now the browser's to fetch, as without a worker;
  navigations are still network first with the copy offline, and files are as they were.

## 0.192.0 — 2026-10-26

- **One test kit for every app** (`tools/test-kit.mjs`): the helpers each
  module's smoke test and Work's tests had their own copy of, drifting apart, are the suite's:
  `createHarness()` (`check`, `section`, `started`, `fail`, the report written in one go with the
  failures repeated last, `assertPassed()` under `node --test`), `client()` (its session cookie,
  JSON, and a 15 s deadline per request that names the request that hung), `mcp()`/`rpc()`,
  `freePorts()`/`freePort()`, `waitForHealth()`, `startServer()`/`startApp()` (a temporary
  DATA_DIR, a port of its own, the log, `stop()` that waits for the process to go), `liveChannel()`/
  `liveNotice()`, and the fakes: `fakeServer()`, `fakeWorkos()` (AuthKit with PKCE and a whole
  sign-in round trip), `fakePaddle()`, and the RevenueCat and DOM fakes of the suite's own tests.
  A section's title and each ✗ go to stderr as they happen, so a run that hangs says where.
- **Without `i18nDir`** (`createApp`, and a module's parts in the host): no app or module kept its
  catalogs outside `public/i18n`, so the option and its fingerprint in the host are gone.

## 0.191.3 — 2026-10-26

- **Menus stay inside their window in Cronum Work**: with the windows side by side, a menu
  opened near a window's end (the category to pin in Tasks' bar, a list's ⋯) went past it and was
  cut off, as a window keeps what it holds inside it, though it had room on the screen. `menu()`
  now fits in the window it hangs in (`.cw-win__body`), as it fits in the screen elsewhere, and
  scrolls when the window is shorter than it. A menu in a dialog still has the whole screen.

## 0.191.2 — 2026-10-26

- **Settings cover the whole of Cronum Work in its shell**: with the windows side by side,
  Settings opened from Projects or Next stayed inside that module's window, since those modules
  hand `openSettings` their window as `root` and a window keeps what it holds inside it; from Tasks
  and Notes they covered the page. In Work's shell they now hang on the page's body whatever `root`
  says, over every window, as the whole app's.
- **Another module's section, in its window**: choosing one in Settings in Work's shell went to
  that module's own page (`/projects/?settings=…`), out of the shell. It now says
  `kit:settings-goto` on the window, as a frame of the split view does, and the shell opens that
  module's window with its Settings on the section; with no shell to hear it, the address as before.

## 0.191.1 — 2026-10-26

- **Spanish says "On" and "Off"** under Your AI's switch for all the tools with the words the rest
  of the suite uses for a switch
  (Tasks' smoke test checks its catalog for it).

## 0.191.0 — 2026-10-26

- **Folds slide open and shut**: the groups of Settings' list, the instructions in Your AI
  and the account's folds in /admin open and close in a short movement instead of at once; a tap in
  the middle turns them back from where they got to, and where the person asks for less motion
  they stay instant. `ui.js` exports what does it: `slideHidden(node, hide)` for a fold of a list,
  `slidingDetails(details)` for a `<details>` (those of one `name` stay one open at a time, now in
  `data-fold`, since the browser's own would shut the other at once).
- **`navFold({ label, key, open, keep, children })`** (`shell.js`): a heading of the sidebar that
  folds its group, sliding, with a chevron; the choice is kept on the device under `key`, `open` is
  how it starts until then and `keep` unfolds it for the entry open in it. Folding leaves the drawer open.

## 0.190.1 — 2026-10-26

- **No black line around a section of Settings**: a section takes the
  focus when it opens, and the kit's focus ring drew a 2 px line in the accent colour (near black
  in the clean look) under the section and, in a swipe back, along its edge. The page keeps the
  focus, for the keyboard and a reader, without a ring, as the drawer does.

## 0.190.0 — 2026-10-26

- **A host's MCP costs less of every conversation, and follows the plan** (`createHost({ mcpOptions })`,
  architecture §21.2; each part off without it, so every host and app behaves as before):
  `byPlan` keeps out of someone's `tools/list` what their plan leaves out (with `<host>_plan_info`
  and a line in the instructions saying why and where to change it); `onDemand` keeps the tools
  used now and then behind two of the host's own, `<host>_more_tools` (names them, says what they
  take) and `<host>_use_tool` (runs one), unless the person wants them all (Settings › Your AI,
  `PUT /api/me/ai-tools`, host migration 4 `host_ai_tools`); `namesInText` gives a module's tool
  names in its texts the module's prefix; `recordChanges` writes `mcp.tool` to the audit log for
  each call that changed something (never its arguments); `maxResultChars` cuts a long answer at a
  whole line and says so.
- **`createMcpServer`** takes `onDemand`/`door`, `recordChange` and `maxResultChars`, and returns
  `listTools(principal)` and `instructionsFor(principal)` (what `tools/list` and `initialize`
  answer). `capResult` is exported; `host.js` exports `prefixNames`.
- **"Unknown tool"** names the tools whose name ends in the one asked for.
- **/admin › Activity** shows those lines as «Changed something from an assistant», with a filter «From an assistant».

## 0.189.0 — 2026-10-26

- **Going back with a finger slides the screen away, instead of the one before just appearing**.
  From the screen's start edge, the screen on top
  follows the finger with a shadow, over the one it goes back to, which comes in a little behind.
  On lifting the finger it goes all the way, or comes back to its place, by how far the finger went
  (the drawer's measure) or how fast at the end (a flick). A phone's detail slides over its list;
  a section of Settings over Settings' list, where the page had scrolled to; Settings' list, or
  Settings beside a section, over the app. `holdBack(node, back, slide)` (ui.js): `slide()` says
  what moves and what it uncovers; without it a page goes back at once, as in 0.180.0.

## 0.188.0 — 2026-10-26

- **Sharing, the same in every module** (`sharing.js`). `createSharing({ db, kinds,
  notify, brake })` is Notes' engine, which was already written for any table: each kind names the
  table of its offers and the column naming the thing, and brings its own rules as hooks (who may
  see it, what else happens when it is offered or left, what a route answers). It offers by email,
  by `user_id` (only one of the person's people, `peopleOf`; anyone else's id answers 404 as an id
  nobody has) or, with `byUsername`, by username (an install whose directory is open); changes a
  permission without asking again; accepts, declines and leaves; lists who has something, one's
  people and what waits. `routes(router, { user, id, people })` makes each kind's routes with the
  paths and answers the module already has (`/api/notebooks/:id/shares`, `/api/lists/:id/share`…).
  No table changes: a module keeps its own, with its rows (`invitedBy`, `createdAt`, `stamp` for
  tables that lack a column).
- **The notice of a new offer goes by push when the person has a device that takes it, else by
  email** (`notify: { push, email }`, each the module's, with its words), always behind the brake.
- **The brake on invitations in the suite** (`share-brake.js`): `createShareBrake()` counts new
  offers and addresses without an account per hour (429 `share_limit`) and lets one notice per pair
  of people through a day, however often the offer is taken back and made again. An address
  answers the same whether an account has it or not, and nothing is created for one without. A
  module may pass its own brake with the same two methods (Tasks keeps a table).
- **The share dialog in the kit** (`web/share.js`, `shareDialog()`): Notes' dialog, with the kit's
  words (`kit.share.*`, in the five languages) or the app's (`words`), through sharing.js' routes or
  the app's own functions (`load`, `offer`, `setPermission`, `remove`, `leave`); `email: false`,
  `empty`, `avatar` and `detail` for an app whose people are the whole household. Its styles are in
  kit.css (`.kit-share*`), and the worker keeps the file.
- Nothing changes for an app that doesn't call them.
- **`time-zone.js` is in the kit's offline copy** (`SUITE_KIT_FILES`), as every kit file a module's
  page imports: 0.186.0 added it without the line.

## 0.187.0 — 2026-10-26

- **The storage a plan allows is checked in one place** (`storage.js`, `suite.storage.check(user,
  adding, { payer })`). Tasks, Projects and Notes each had the same check and the same 402
  `plan_limit`; now it is the suite's, with the same answer. Whose plan pays for a file stays each
  app's rule, passed as `payer` (Notes: the notebook's owner; Tasks and Projects: who uploads), and
  is written in docs/architecture.md. On its own an app's `suite.storage` counts what the app says
  it keeps, where it counts it (`suite.countStorage(storageOf)`, at import, so its scripts and
  command line have it too; or createApp's new `storage`); as a module of a host, the person's
  across every module, as `used()` already did. Until an app says it, nothing changes.
- **`uploads.storeChecked()`**: an upload with the cap per record and the storage checked before a
  byte is read and again once the file is on disk, refused files taken off it, as the apps did by
  hand. Its `too_many_files` has a sentence of the suite's, which an app's own catalog overrides.
- **A photo made ready to upload, in the kit** (`web/images.js`): `prepareUpload(file, { keepGif,
  asIs, maxBytes })` and `fileSize(bytes)`, from the three copies in the apps. A GIF goes as it is
  (it may move), a small picture the server wouldn't take is made a JPEG all the same, and the
  units are translated (French "Mo"). `/api/auth/config` tells the page the most a file may weigh
  (`app.uploads.max_bytes`), with uploads on. The kit's worker keeps the new file.

## 0.186.0 — 2026-10-26

- **`PATCH /api/me` and the account as the browser sees it, once for every module** (`createApp({ prefs })`,
  prefs.js, api.js `registerMeApi`). Tasks, Projects, Next and Notes each had
  their own copy of the profile route, of reading `users.prefs` and of what the browser sees of an
  account, and they had drifted (Next and Notes never sent `has_password`, which Settings reads;
  Projects let a session set a password on an identity provider's account). A module now says only
  what its preferences are, `prefs: { defaults, normalize, merge, view, store }`, and the suite
  serves `GET` and `PATCH /api/me`: `display_name`, `email` (with its link), `theme`,
  `avatar_color` (where the table has one) and `prefs`, all checked before anything is written and
  written once through `accounts.update`, so the person's other tabs hear of it. A password sent
  there is refused with `use_me_password` (it has its own route). Prefs stay flat as they were:
  each module keeps its keys of the one row and never drops another's, and the shared ones
  (`lang`, `lang_seen`, `tz`, the zone canonical by time.js) are the suite's. `userSerializer(suite,
  { prefs, fields })` is the account a module shows: `publicUser` (`has_password` always),
  `auth_provider`, its own fields and `prefs`. In a host each module's `/<mount>/api/me` keeps its
  own, and the host's `/api/me` has them all (`combinePrefs`). `accounts.update` takes `theme`,
  `prefs` and `avatarColor` too. An app without `prefs` keeps its own routes, as before.
- **The browser's time zone, told once** (`web/time-zone.js` `reportTimeZone(user, { send })`): what
  Tasks and Notes each did on their own, for every module, so the day an assistant reads is the
  person's in all of them.

## 0.185.0 — 2026-10-26

- **A check for an app's texts that the kit already says** (`tools/i18n.mjs`, `kitDuplicates`): an
  app's key whose texts, in every language, are those of a word of the kit (`kit.cancel`,
  `kit.save`, `fields.name`…) is named with the key to use instead, and so is a key that repeats a
  suite key with the suite's own texts, which overrides nothing. Keys of deeper kit groups
  (`kit.links.undo`) don't count, since the same word there belongs to another feature, nor do an
  app's overrides or its own keys in `errors.*`/`fields.*`. An app's tests opt in with
  `appChecks(root, { kitWords: true })`; on the command line, `app --kit-words` or `kit-words <dir>`.
  Without the option `appChecks` returns the same five checks as before.

## 0.184.0 — 2026-10-26

- **One HTTP client for every module** (`web/api.js`, additive). Each call now takes options for
  what Tasks', Projects' and Next's own clients did on their own: its own `patience` (any method;
  `0` waits) and an app's `signal`, both counting as no network when they stop it; `text: true`,
  which answers `{ data, text }` (Next draws a view again only when the text changed); `type` for
  an upload whose file has none; and three hooks: `beforeSend` (change what goes, or throw
  `Offline` to not ask at all), `onAnswer(res, request)` once the status and headers are in
  (Tasks' clock and signal, a 401 told to the app) and `onNoSignal(request)`, whose answer
  replaces the `Offline` (Tasks' queue draws a change made without signal as done). `api.request`
  takes every option and `api.with(options)` gives the same client with them on every call.
  Without options every call behaves as before.

## 0.183.0 — 2026-10-26

- **The components each module drew for itself are the kit's** (`kit.css`): `kit-chip` (a quiet
  pill; `--tint` coloured by `--kit-chip`, `--large` and `aria-pressed` for a filter),
  `kit-swatch` and `kit-swatches` (a colour to choose, ringed while `aria-pressed`, `aria-checked`
  or `--on`), `kit-round-check` (a task's circle, filled and ticked with `--done` or
  `aria-pressed`, with a hit area wider than its drawing), `kit-group-title` (a group's heading in
  a list), `kit-icon-btn--small` (34 px, for a row of items), `kit-avatar--small`, `--tiny` and
  `--large`, `kit-blank--page` (an empty view, with an `h2` of its own) and `kit-field__label` (a field whose label names a group). Nothing that was
  there changes; Tasks, Projects, Next and Notes move to these in their own releases, and look the
  same as one another beside each other in Cronum Work.
- **Selected text in the accent** everywhere (`::selection`, stronger in the dark), and the caret
  of a field in the accent: what Tasks, Projects and Next each set.
- **The Clean look's quiet sidebar is the kit's**: entries of 40 px with the callout size, the open
  one not bold, as the four modules each wrote it (it was 44 px in the kit, which every module
  overrode).
- **One set of names for the variables**: `--kit-faint`, `--kit-border-strong` and
  `--kit-radius-small` (8 px; 10 in Clean), the names Tasks had for them as the kit's. The radius
  stays `--kit-radius`, 10 px.
- **Where layouts change**, as brand tokens: `--cr-bp-phone` (640 px) and `--cr-bp-tablet` (860 px)
  in `tokens.css`, for modules side by side to change at the same widths.

## 0.182.0 — 2026-10-26

- **A form dialog for every module** (`ui.js` `formDialog`), from Next's: `onSubmit(form)` runs for
  a submit action, Enter in a field or Ctrl/Cmd+Enter in a long text; what it throws shows inside
  the dialog, which stays open to be corrected; `header`, `subtitle`, `tools`, `bar`, `extra` and
  `setActions` for a footer that changes. Returns `{ dialog, form, close, setActions, showError }`.
- **One action at a time in every kit dialog**: while an action (or a send) waits, every button of
  the footer is disabled, not only the one pressed: a double click no longer creates two things,
  and Save and Delete side by side can't both run.
- **Escape is the top dialog's alone, and a menu's before its dialog's**: the menu keeps its
  Escape from the dialog under it, and a cancel that reaches a dialog that isn't the kit's top one
  (or one with a menu open) doesn't close it. A press that begins inside a dialog and ends on the
  backdrop (selecting a field's text) no longer closes it; a tap on the backdrop still does.
- **What the modules need to drop their own dialogs and menus**, all optional: `openDialog`
  takes `width` (a variable, so a phone's sheet keeps the whole width), `className`, `parent` (the
  module's own place, its window in Cronum Work) and `body`/`footer` nodes of the module's own;
  `confirmDialog` takes `detail`, `cancel`, `width` and `parent`; `menu` takes `at` (a pointer's
  place), `parent`, a null anchor with `at`, and items with a `glyph` (an emoji) in place of an
  icon. With today's options every dialog and menu behaves as before.

## 0.181.0 — 2026-10-26

- **The kit's `el()` takes what the apps' own copies took** (`dom.js`), so Tasks, Projects and Next
  can drop theirs: `style` as an object (custom `--properties` through `setProperty`), `dataset` as
  an object, and children in arrays nested at any depth (Tasks passes them in one array, sometimes
  with arrays inside). New `svg()` makes SVG elements with the same props and children. A string
  `style` is still an attribute, and every call that worked before builds the same node.
- **`field()` can keep an app's own look** (`ui.js`): a fourth argument
  `{ class, hintClass, hintTag, groupLabel }` names the wrapper's class and the hint's class and tag,
  and `groupLabel: true` writes the label as a `<span>` when what it names is not something a
  `<label>` can name (a palette of buttons), leaving its id alone. Without it, the field as before.

## 0.180.0 — 2026-10-26

- **A swipe from the screen's start edge goes back in Settings, as its ← does**: from a section to
  the list on a phone, then out of Settings. Before, the frame kept that
  edge from Safari and did nothing with it while Settings covered it. A page over the frame with a
  way back of its own says so with `holdBack(node, back)` (ui.js), and the frame's edge swipe
  (shell.js) goes back there first; each module's copy of the kit keeps its own, so in Work's shell
  only the window that opened it goes back. A task, a note or another detail already went back
  from the same edge on a phone.

## 0.170.1 — 2026-10-26

- **Maximize and restore take 280 ms** (`windows.js` `MAX_MS`): they took
  the 420 ms of windows trading places while one is carried, which for a click felt slow. Same
  spring and pacing; the other windows fade in 0.25 s (was 0.3 s). Reordering is unchanged.

## 0.170.0 — 2026-10-25

- **A window maximizes over the whole desk, and comes back to its place** (`windows.js`):
  a button at the end of each head, or a double click on the head, gives its window the desk over
  the others, which fade out; it slides and grows there as windows do when they trade places
  (420 ms, paced on our own clock), and the same button, now "Restore", takes it back to its place
  and size. The layout under it isn't changed or kept; showing another window, moving, focusing
  another or a phone's screen restores it first. `windows.maximize(module | null)` and
  `windows.maximized`; new icons `maximize` and `restore`.

## 0.169.1 — 2026-10-25

- **In Work's shell the button that folds the sidebar shares the search's line** (on a computer
  it took a line of its own): with `createShell({ embedded: true, search })` the sidebar starts with one
  line (`.kit-side__top`), the search and then the button. Without a search, or an app on its own, the
  head is as before; in a phone's drawer the button is hidden as ever and the search takes the line.

## 0.169.0 — 2026-10-25

- **A module's search at the top of its sidebar, the same in every module** (`createShell({ search })`;
  Tasks had its own there, with narrow, uneven margins; Notes its own above the notes; Projects
  and Next none). `search: { label, placeholder?, onInput(text), onSubmit?(text) }` draws it as the
  sidebar's first line (`.kit-side__search`), 12px from its top and its sides; Escape empties it,
  Enter closes the phone's drawer so the results show; `shell.search` is the field. Its box alone
  shows the focus.
- **On a phone the floating button alone creates**: the sidebar's own button (`create`, "New note")
  is shown only where the sidebar sits beside the views, where the floating one is gone.
- **A phone's tab in use is marked** (`windows.css`: pressing one, nothing showed which): its
  icon sits on a pill and its name in the text's colour; the others' icons and names step back.

## 0.168.0 — 2026-10-25

- **A phone's tabs have room above their icons** (`windows.css`, on the iPhone): 12px between
  the bar's top line and the icons (it was about 6), 2px under the names before the home bar's half.

## 0.167.0 — 2026-10-25

- **A phone's tabs sit lower in their bar** (`windows.css`; on the iPhone the icons looked
  off centre, high in the bar). The bar kept all the home bar's room under them; it keeps half now.

## 0.166.0 — 2026-10-25

- **The links of something are read together, not one by one** (`links.js`). A module's cards may
  have `readMany(user, ids, opts?)` → `Map<id, card | 'gone' | null>`, the same answer as `read`
  for each id, in a fixed number of queries. The links of something, `changed()` (the titles kept)
  and `prune()` ask it once for each kind of thing; an id it leaves out, every id when it throws,
  and modules without it are read one by one, as before. Whether someone uses a module is asked
  once per module in a request, not once per link. A search shows the cards the module's `search`
  found as they come, without reading each again, and a kept title is written only when it changed.
  The cards shown are the same.
- **Admin › Users counts every account's usage in batches** (`usage.js`). `/api/admin/usage`
  answered after computing every account at once, in one turn of the process, with each plan
  asked again for each count. Now it counts 100 accounts at a time and lets the process answer
  others in between; each plan for a whole batch in a fixed number of queries
  (`entitlements.ofMany()`, with `organizations.organizationsOfMany()`), and today's calls in one
  (`entitlements.usedToday()`), without the month the dialog shows. A module may also answer a
  whole batch with `usageAll(userIds)` and `storageAll(userIds)` (a Map by user); without them it
  is asked one by one. The answer is the same.
## 0.165.0 — 2026-10-25

- **Changes waiting without a signal are no longer read all over again for each one**
  (`outbox.js`, `local.js`). To count what waited and to take the next change to send, the outbox
  read the whole queue with its bodies (whole notes, in Notes): queueing n changes and sending them
  when the signal came back were each quadratic, and an afternoon offline locked the page just as
  the network returned. Counting now reads keys only, the next change is one record, and a
  provisional id is swapped in one pass in one transaction. 200 changes queued: 20,100 records read
  to add them, now none; 20,100 to send them, now 200. `openLocal()` and `memoryLocal()` gain
  `count`, `first` and `rewrite`; the outbox still works on a store without them.
- **Back from a cut, a page gets what it missed instead of reloading everything** (`live.js`,
  `web/live.js`). The server already replayed what a tab missed (`Last-Event-ID`), but the page
  reloaded everything it showed on every `hello` after a cut anyway, and did both. Now `hello` says
  `replayed: true` when the tab came back with an id (what was missed came before it, or `resync`),
  and the page then reloads nothing more; `hello` carries an id itself, so a tab that saw no notice
  comes back with one too, and a channel the page opens again after closing one sends it as
  `?last=`. Without `replayed` (a server before this one), for someone else, too much missed, or
  `reconnect()`, everything is reloaded as before. Cronum Work's one channel for every module
  (`/api/events?all`) says `replayed` and takes `&last=` the same way.
## 0.164.0 — 2026-10-25

- **A phone's tabs in Work's shell keep their own look** (`windows.js`; on the iPhone a tab
  pressed stayed marked, in the window's type, and Notes' kept a grey ground). Each tab carried
  `data-module`, which is what a module's scoped sheet takes as its window (`@scope
  ([data-module="notes"])`), so the sheet's page rules (`html, body`) styled the tab once the
  module had opened. The tabs now say their module with `data-tab`, and the storage bar of
  Settings › Usage its parts with `data-part` (`usage-view.js`, `kit.css`), for the same reason.

## 0.163.0 — 2026-10-25

- **A copy's values must be of their column's type** (`portability`). Until now `{"$blob": …}`
  came in as a blob into any column, and anything that wasn't text skipped the column's limit, its
  pattern and the 100,000 characters: someone's own copy could bring a list's name or a note of
  megabytes, or a number where the app reads a colour or a date, and share it. Now an import is
  refused (`import_invalid_data`) when a value doesn't fit its column: text in TEXT, a number in
  INTEGER and REAL, a blob only in BLOB (none of the apps has one; a blob column's copy still comes
  back byte for byte). A pattern takes text only, so a number without the shape is left out like
  any other value without it. Copies the apps made come in as before.

## 0.162.0 — 2026-10-25

- **A tab's live channel ends with the session it was opened with** (`live.js` `stillIn`,
  `recheck`; `sessions.stillOpen`, `sessions.whenClosed`). Until now `/api/events` (and the host's
  `/api/events?all`) checked the session only when it opened and then stayed open for good: after
  signing out, a session closed from the list, the account disabled or deleted, a tab opened with
  that cookie (a stolen one, say) kept hearing the account's activity. Now a session closed here
  closes its channels at once, with the `account` notice first, as "out everywhere" already did;
  signing out closes only that browser's. Every heartbeat asks again for each channel, which also
  ends the ones whose session expired or whose device went; asking doesn't use the session, so an
  open tab doesn't keep it alive. A deleted account's channels close as it goes.

## 0.161.0 — 2026-10-25

- **Deleting one's account leaves nothing of it on the device** (`settings.js`, `signin.js`
  `leave()`). Settings' «Delete account» signed the browser out and went to the sign-in, but every
  module's copy (`<app>-local`) stayed: offline, Notes drew the deleted account's notes for
  whoever opened it next. It now leaves the way signing out does, through one routine: the copies
  cleared, the suite's app told, the whole window to the provider's page or this site's sign-in.
- **Signing out takes this browser's notices along** (`POST /api/auth/logout`, `push_endpoints`).
  The browser's Web Push subscription stayed tied to the account that signed out: on a shared
  computer, whoever used it next kept getting that person's notices. `signOut()` now sends where
  this browser's notices come to (every worker of the site), and the server forgets those rows of
  that person, also in a module that sends none (the table is the install's). The browser's
  subscription itself stays (a device's own notices may share it); the person's other devices keep
  theirs. A request without the field signs out as before. Deleting the account already dropped
  every browser's rows at once.

## 0.160.0 — 2026-10-25

- **A module in a window of Work's shell fits the iPhone** (Work installed on it):
  a window is never at the screen's top or bottom, but each module kept the room of the notch and
  of the home bar too, so a band was left above and below. Inside a window the kit's
  `--kit-safe-top`/`--kit-safe-bottom` are 0 (`windows.css`), and a module's own
  `env(safe-area-inset-…)` reaches it as `var(--cw-inset-…, env(…))`, 0 there too (`scope-css.js`,
  `SCOPE_FORMAT` 2). What a module hangs on the page's body keeps the screen's own.
- **The sidebar of a module in a window doesn't name it again** (`createShell({ embedded })`): no
  icon, name or live dot at its head (the window's head or the phone's tab names the module, and
  the shell has the one live dot); the button that folds it stays where it sits beside the views.
- **On a phone Work's shell has the module's ☰**: `kit:drawer` (`DRAWER_EVENT`, base.js) on the
  window's body opens or closes that module's drawer, and the swipe from the edge still opens it
  when the module's own ☰ is hidden.

## 0.159.0 — 2026-10-24

- **A release that changes only a page of the host's own is a new version** (`pages`). Until now
  a page's files (Cronum Work's shell at `/w/`) counted neither in `/version` nor in the one
  worker's copy: a release that changed only them showed no notice of a new version, and the
  worker served the old copy on the first load. Now each page's files count in the fingerprint and
  the worker keeps them at their paths, with their hashes, so the next copy takes what didn't change.

## 0.158.0 — 2026-10-24

- **A page of the host's own can be the app's start** (`createHost` `pages[].root`). With
  `root: true`, `/` answers that page's index (one page at most); with
  `root: { except: ['modules'] }`, an address with one of those query names (`/?modules`) still
  opens the host's own home. Cronum Work opens its one-document shell at `/` this way, so the
  installed app starts on its windows. Without the option, `/` answers as before.

## 0.157.0 — 2026-10-24

- **Windows give way as magnets** (`windows.js`). Until now the window a carried one came over
  sat still until the pointer crossed into it, then crossed the whole screen at once, mostly under
  the carried one: no slide could be seen. Now it gives way as it is covered: pushed toward the place
  it would take, up to 40 % of the way, back again if the carried one backs off; past 55 % the two
  trade places and it slides on to its new place from where it was pushed (a window that just
  traded places isn't pushed back, it only trades back past 70 %). Let go short of that, they go
  back. Stacking keeps the top and bottom parts of a column.
- **No slide skips its start any more.** Starting a slide made the browser draw the windows again,
  a frame of 100–200 ms on a slow machine, and the slide's clock ran through it: a good part was
  never seen. Slides while a window is carried and when it is let go now run on the shell's own
  clock, which moves on by one frame's worth at most per frame.
- While a window is carried, every window in sight is on a layer of its own (`will-change`), so
  pushing them costs no drawing.

## 0.156.0 — 2026-10-24

- **Windows make room more slowly, and without a jump at the start** (`windows.js`). The slide of
  the others while a window is carried, and of the carried one settling when let go, lasts 420 ms
  instead of 260, on an even curve (it starts and ends softly, a little overshoot) instead of one
  that did most of the way at once: about a phone's pace when its icons move. Each slide is held
  at its start through the frame that lays the windows out in their new places, which can be long
  (a module's list at a new width), and let go in the next: started at once, a good part of it went
  by unseen and it looked like a jump. A window still sliding when the next change comes goes on
  from where it is seen.
- **A field's text stays in sight while a window is moved or resized** (`windows.css`): the desk
  stops text selection meanwhile (`-webkit-user-select: none`), and under it Safari drew fields
  blank, such as the list's name at the top of Tasks. Fields keep their own selection now.

## 0.155.0 — 2026-10-24

- **Windows make room while one is carried, as a phone's icons do** (`windows.js`). Until now
  another window only moved aside live when the pointer crossed the 48 px strip of its head; over
  its body nothing happened until letting go, and two windows of a 2×2 swapped only then. Now the
  middle of a column is its place too, a window of a full column trades places with the carried
  one at once, and the others flow to their new places with a slightly longer, springier slide
  (260 ms, a little overshoot), the carried one settling the same way when let go. Stacking keeps
  the top and bottom parts of a column (a dashed box, done on letting go). Still computed from the
  places measured at pick-up, with no layout read in the loop.

## 0.154.0 — 2026-10-23

- **Cronum Work in one page: what the kit and the host give its one-document shell** (Work's
  `WORK_SHELL`). Every module opens in a window of one page with
  `mount(root, ctx)` instead of a page or a frame each. Everything here is new and off by default:
  an app on its own, a host without the new options and today's module pages behave as before.
  - `web/mount.js`: the shell's page registry (`workRegistry()`), the module a copy of the kit
    belongs to (`ownerOf()`), `markOwned(node)` and `standaloneCtx()` for an app on its own page.
  - `web/windows.js` + `windows.css`: the window manager. 1–4 columns with up to two windows each
    (2×2), reordered by dragging a head (transform in rAF, FLIP, Escape cancels) and resized with
    bars; under 768 px one window at a time with tabs and swipe; at most four mounted; the layout
    kept per screen class.
  - `drag.js` `registerDrop()`: drop places shared by every copy of the kit in the page, asked
    when a drag finds none of its own. `links.js`: `linkItems`, `unlink`, `createLinked`, and
    chips that open in the shell's window (`registry.open`) instead of navigating.
  - `createShell({ embedded })`: no Work rail, account or host notices inside a window. The kit's
    toasts, dialogs, menus, banners and drag ghost say whose module they are (`data-owner`) in the
    shell only. A module's Settings share their language and theme with the shell; a language
    loaded by one module translates only its own windows.
  - `connectLive()` goes through the shell's one channel when there is one.
  - `createHost`: `pages` (static pages such as `/w/`), `scopedSheets` (`?scope=work`: a module's
    sheet wrapped in `@scope`, `scope-css.js`) and `liveAll` (`/api/events?all`, every module's
    live events in one stream). Architecture §21.6–21.7.

## 0.153.0 — 2026-10-23

- **"Today" is the person's, in every module that adopts it** (`time.js`). Tasks reads today in
  the zone the person's browser reported (`prefs.tz`); Projects, Next and Notes each read it their
  own way, mostly in the server's zone, so at six in the evening in New York "tomorrow" was already
  the day after. `time.js` is Tasks' `today.js` for everyone:
  - `knownTimeZone(zone)`: the canonical IANA name ("europe/madrid" → "Europe/Madrid"), or null.
  - `zoneOf(user)`: their `prefs.tz` (text or object), else `SERVER_TIME_ZONE` (`TZ`, as today).
  - `inZoneOf(user, fn)`: runs a request or a tool call in their zone, through awaits;
    `currentZone()` reads it.
  - `todayFor(user?, offsetDays)`, `todayIn(zone, offsetDays)`, `dayIn(zone, instant)`,
    `addDays(day, n)` (calendar days, no clock change moves them) and `daysSince(instant, zone)`.
  Nothing changes for an app until it adopts it; createApp and the host don't wrap requests yet
  (that waits for the app/host lane), so a module wraps its own handlers, as Tasks does.

## 0.152.0 — 2026-10-23

- **What the MCP tools are written with, once for every module, and a shorter `tools/list`**
  (`mcp-kit.js`). Each module carried the same skeleton (`text`, `S`, the four annotation sets, a
  describeError with the same "Options:" block) and the copies had drifted. And `tools/list`,
  ≈17 500 tokens for Cronum Work in every conversation, repeats long parameter descriptions word
  for word across tools.
  - `text(s)`; `S.string/bool/int/number/list`; `READS`, `ADDS`, `SETS`, `DESTRUCTIVE`.
  - `tool({ kind: 'read'|'add'|'set'|'destroy', params, required, openWorld, ...rest })`: the
    annotations from `kind`, a closed `inputSchema` from `params` and `required`.
  - `describeErrorWith({ errorSentence })`: a `ResolveError` (the suite's, or a module's own copy
    until it adopts the suite's) as its message and up to 25 options; an `HttpError` as
    `errors.<code>` in English, with the plan's feature when a plan leaves it out; null otherwise.
  - `trimRepeats(tools, { minLength: 80 })`: a long parameter description repeated in a later tool
    becomes its first sentence there. Tool names, parameters, types and limits don't change (§9).
  - `toolsListSize(tools)`: the characters `tools/list` spends on them, for a budget test.
  Nothing changes for an app until it adopts it.

## 0.150.0 — 2026-10-23

- **One way to turn names and dates as people say them into items, for every module's MCP**
  (`resolve.js`, `dates.js`, `mcp.js`). Tasks, Projects and Next each had a copy of the same
  scoring, drifted apart: only Next asked before writing on an unclear match, only Tasks folded
  "Straße" and "Œufs", and Projects rolled "31/02" into March.
  Nothing changes for an app until it adopts them.
  - `resolve.js`: `matchByName(items, ref, { label, getName, strict, create, stopwords })`,
    `score`, `nameKey` (accents and signs folded, every alphabet and emoji kept), `keywords`,
    `stopwords(...moduleWords)`, `numberRef` / `byNumber` (a bare number is an id, never part of a
    name), `isClear`, `optionOf`, `ResolveError` and `resolveErrorText`. `strict` (the tools that
    write) asks about any tie and any match that isn't clear; `create` answers `null` for a name
    like nothing there (a new item), with a hint on how to create one anyway.
  - `dates.js`: `parseNaturalDate(value, { today, field })`, the union of Tasks' and Projects'
    parsers in Spanish, English, French and German: ISO (a real day within 1900–2200), today and
    its neighbours, "in N days/weeks/months" (the 31st becomes the month's last day), weekdays long
    or short ("vie", "next friday") and day-first dates (24/12, 24.12., 24-12-2026). A day that
    doesn't exist is a `ResolveError`, never the next month. `today` is the person's day.
  - `mcp.js`: a suite `ResolveError` that the app's `describeError` leaves alone reaches the
    assistant as its message and up to 25 options, one per line, so the modules can drop that branch.

## 0.149.0 — 2026-10-23

- **An assistant's call no longer fails only because it leaves out what the tool calls required**
  (`mcp.js` `argumentProblems`). Since 0.143.0 a missing `required` argument stopped the call
  before the tool ran, but some tools do without it on purpose: Next's `log_progress` saves the
  step without `done_title` and asks for it next time, and its smoke test (and assistants already
  using it) were refused. What `required` names is the tool's to ask for again, as before 0.143.0;
  types, ranges, `enum`, lengths and dates are still checked. `schemaProblems` still says when a
  `required` names no property.

## 0.148.0 — 2026-10-23

Dead code out. Nothing a person sees changes, except an
assistant that still calls a tool by a name `tools/list` no longer announces.

- **No more MCP aliases** (`mcp.js`, `host.js`, `app.js`). `createMcpServer` no longer takes
  `legacyTools` or `legacyParams`, and the host's `/mcp` no longer answers a module's tools by their
  bare names (`add_task` for `tasks_add_task`) nor by the old names a module listed: only the names
  `tools/list` announces (`<mount>_<tool>`, `<hostId>_<tool>`) answer, with the parameters it
  announces. Those names and parameters are unchanged. An app that still passes the options is not
  refused: they are ignored. Every client connected to the host has reconnected since the move.
- **The apps' old addresses have no connectors** (`legacy-domains.js`, `host.js`). Their `/mcp`
  answers 404 with the host's (`{ error: 'not_found', mcp }`) and `/.well-known/oauth-*` a 404, as
  they did with `LEGACY_MCP=off`, which production had set; the variable is no longer read. The
  redirects and the service worker that removes itself stay.
- **`createApp({ devices: { canConnect } })` is gone** (`devices.js`, `app.js`), with
  `devices.setCanConnect`: no app passed it, so everyone could connect a phone, as now. The
  `403 device_not_allowed` it answered is no longer sent.
- **One fingerprint of the front end** (`app.js`, `host-worker.js`): an app's `/js/app-version.js`
  and `/version` use host-worker.js `fingerprint`, as the host does; `frontFingerprint` is gone.
  Its pattern took any name ending in `js`, `css`… (`notesjs`); now only real extensions count.
- **Smaller pieces**: `outcomeOf` in billing.js (never called); oauth.js's own `escapeHtml` (it
  imports brand.js's); `textOn` no longer re-exported by oauth-page.js (brand.js has it);
  `createApp` takes `suite.alerts` and the WorkOS clients as they are, without the defences for
  suites older than they; `.kit-display`, `.kit-num`, `.kit-footer` and `.kit-section` out of
  kit.css (`.kit-visually-hidden` stays); `kit.offline.pending`, `kit.settings.groups.plan`,
  `kit.plan.subscriptionTitle`, `kit.plan.manage`, `kit.plan.manageHint` and `kit.modules.home`
  out of the five catalogs.

## 0.147.0 — 2026-10-23

- **A password reset on AuthKit's own page signs the person out of everything here too**
  (`workos-events.js`, `workos.js`, `app.js`, `host.js`). With WorkOS, "Forgot your password?" on
  AuthKit's page is how people get back into an account they think someone else got into, and it
  happens at WorkOS: the app was never told, so every session, API token, phone and AI client here
  outlived the reset. Now whoever
  owns the accounts (createApp's `listen()` for an app on its own, the host's once for all its
  modules) asks WorkOS's Events API every minute for `password_reset.succeeded` and, for each one
  about an account here, calls `revokeEverything(userId, { keep: null, reason: 'workos_password_reset' })`.
  No webhook, so there is no new address to register in WorkOS's dashboard. Where it got to (the
  last event's id) is kept in `app_meta` (`suite.workos_password_resets`); the first time it starts
  from now and acts on nothing older. A WorkOS that fails or refuses is logged once and asked again
  the next minute; a place WorkOS no longer takes (events are kept 90 days) starts again from now.
  - `workos.listEvents({ events, after, rangeStart, order, limit })` → `{ data, after }`;
    `suite.workosResets.poll()`, null without WorkOS or its API key.
  - A password changed from AuthKit's account page has no event of its own in WorkOS's catalog, so
    it is not heard; the app's own routes (`/api/me/sign-in/password`) already revoke.
## 0.146.0 — 2026-10-23

- **Only the install that owns the identities changes them, and only with the admin's password
  again** (`workos-security.js`, `config.js`, `app.js`, `web/admin.js`, `web/api.js`, `i18n/*.json`).
  A WorkOS user is the same in every product that signs in with it, yet any install's admin cookie
  could take someone's second step off (`DELETE /api/admin/users/:id/sign-in/two-factor`) or give
  them a password (`PUT /api/admin/users/:id/sign-in/password`), even someone who signs in with
  Google: a stolen admin session anywhere was everyone's account everywhere.
  - **`accounts.adminIdentity`** (suite.config.js, default `false`): those two routes exist only
    where it is `true` (Cronum Work sets it). Elsewhere they answer 404, and
    `GET /api/admin/users/:id/sign-in` says `manage: false`, so the panel only shows how they sign in.
  - **The admin again**: `admin_password` (their WorkOS password, with the sign-in brake) and, when
    they have a second step, `admin_code`. An admin who signs in with Google or a company's sign-in
    has no password to give: a session opened in the last 10 minutes, else 401 `reauth_required`
    (the panel sends them to sign in again). The GET says which (`reauth`: `password`,
    `password_code`, `session`) and the panel asks for those fields.
  - **No password for whoever signs in elsewhere**: 400 `password_elsewhere`.
  - After either change, the person is revoked everywhere (`revokeEverything`, 0.129.0).
  - `api.delete(path, body)` sends a body when given one.
## 0.144.0 — 2026-10-23

- **A link to `/oauth/authorize` no longer sends anyone to another site without a click of theirs**
  (`oauth.js`, `i18n/*.json`). Anyone can register a client (`POST /oauth/register`, or a CIMD
  document on their own domain) with their own redirect URI, and then hand out
  `https://<app>/oauth/authorize?client_id=<theirs>&redirect_uri=<theirs>&response_type=x`: the
  client and the redirect matched, the request didn't, and the error went back to that address
  with an immediate 302 — a link on Cronum's domain that lands on a phishing page (RFC 9700
  §4.11.2). A wrong `response_type`, a missing or malformed PKCE
  challenge, or another `resource` now show the "can't connect" page here, with the reason
  (`oauth.error.request_invalid`), as an unknown client or an unregistered redirect already did.
  Claude and ChatGPT always send these right, so nothing changes for them. "Cancel" still goes
  back to the client with `access_denied`: that one is the person's own click. The redirect URI
  still has to match a registered one exactly (only the port may change on loopback, RFC 8252).
## 0.143.0 — 2026-10-23

- **An assistant's call is checked against the tool's own schema before it runs** (`mcp.js`,
  `http.js`, `app.js`, `legacy-domains.js`). `callTool` passed the arguments to the tool as they
  came, so the `enum`, `required`, `minimum`/`maximum` every tool already declares were only
  advice: a `lag` of 2e8 days or a start on `2026-13-01` reached Projects' store and left the
  project, and the project list of everyone in it, answering 500. Now
  `argumentProblems(inputSchema, args)` runs after the plan check and before a
  call of the day is spent: types, `enum`, `required`, `minimum`/`maximum` and the exclusive ones,
  `minLength`/`maxLength`, `minItems`/`maxItems`, `pattern`, `anyOf`/`oneOf`, nested `properties`
  and `items`, and `format: 'date'`. A call that doesn't fit gets `isError` and a sentence of what
  to correct («"lag" must be between -365 and 365»), never the value; the tool doesn't run, and the
  log notes the tool and the sentence. Old parameter names (`legacyParams`) are checked as the new.
  - **What it lets through, on purpose**, because the tools have always read it and an assistant
    sends it: a number in quotes for an integer or a number (`"3"`), `"true"`/`"false"` or 0/1 for
    a boolean, a number or a boolean for a text, one item where a list goes, `null` for an
    optional value (the tools read it as "leave it" or "clear it"), and properties the schema
    doesn't name (`additionalProperties: false` is not enforced: clients send extra ones and the
    tools ignore them). Nothing is converted: the tool gets the arguments as sent.
  - **What changes for an assistant**: a value past a declared bound is an error to correct, not
    taken in silence (Next clamped `hours` above 72 to 72; Notes passed a `limit` of 500, or -1,
    to SQL as sent), and an `enum` is exact (Tasks stored any `priority`).
  - **The way back**: an app's `mcp.checkArgs: false` (or `createMcpServer({ checkArgs: false })`)
    passes the arguments unchecked, as before.
  - `schemaProblems(tools)`, for an app's tests: a type the check doesn't know, a `required` that
    names no property, crossed or non-numeric bounds, an empty `enum`, a pattern that doesn't
    compile — a limit the tool believes it has and doesn't.
- **`isoDate(value, { minYear = 1900, maxYear = 2200 })`** (`http.js`): a `YYYY-MM-DD` that
  exists (round trip through `Date.UTC`) and falls in the range, the same text back, or null.
  `2026-13-01`, `2026-02-31` and the year 2206 are not dates. One check for every module's
  `dateOrNull`/`parseDate` and the MCP's `format: 'date'`.
  The modules' schemas (`S.int`, `S.string` in each `mcp-tools.js`) can now declare `minimum`,
  `maximum` and `format: 'date'` and have them hold.
## 0.142.0 — 2026-10-23

- **The catalog a page loads leaves out what no page of the app shows** (`app.js`, `web/i18n.js`,
  `web/admin.js`, `web/connect.js`). `/i18n/<lang>.json` carried all of the suite's texts: the
  admin panel's (`admin.*`, 261 in English), the e-mails' (`mail.*`) and the connect page's
  (`oauth.*`), about 17 KB of every catalog, in every module and every frame of the split view.
  They are out now (`clientTexts`), but the two of usage that Settings shows too
  (`admin.usage.*`). The admin panel and the connect page ask for the whole catalog,
  `/i18n/<lang>.json?all` (`loadLanguage(…, { all: true })`). The server's own texts (e-mails,
  pages it writes) never came from it and are as before.

## 0.141.0 — 2026-10-23

- **The split view's frames ask less, and a link opens beside** (`web/update.js`, `web/shell.js`,
  `web/base.js`, `web/links.js`). With four modules side by side, coming back to the tab asked
  /version five times and /api/modules four, besides what each module reloads.
  - `watchUpdates()` in a frame (`framed`) starts no timer and no check on coming back: the view
    asks, once for every frame. It reads its own version for About, whose Check still asks.
  - `hostModules()` (base.js): GET /api/modules once per page, shared by the rail and the Linked
    row (`{ status, answer }`, `fresh` to ask again). The rail asks again on coming back, except
    in a frame, and when a module is turned on or off (`kit-modules`).
  - `OPEN_EVENT` (`kit:open`): a Linked chip pressed in a frame (`openBeside`) tells the view
    `{ url, mount, source, handled }`; the view opens it in the section that already shows that
    module (Cronum Work's split.js). With none, or a key held, the link is a link as before.

## 0.140.0 — 2026-10-23

- **A host's worker serves code from its copy first, keeps the kit once, and a release brings only
  what changed** (`web/sw-core.js`, `host-worker.js`, `host.js`). Every page of Cronum Work and
  every change of module asked the network for each of its ~40 code files before drawing (up to 4 s
  each with a weak signal), and each release of any module downloaded the whole app again,
  the kit five times (once per module's path): 3–5 MB per device. The host's worker version is
  already the fingerprint of everything the browser loads, so the host now passes:
  - `codeFirst`: code, styles and catalogs come from the copy, never asked; what changes comes
    with the next worker, which the update notice already waits for (`web/update.js`).
  - `sharedKit`: the kit is kept once, at /suite/; `/tasks/suite/x` is answered from it as a
    response of its own (`suiteAsAsked`), so the module's code still reads its base at /tasks/.
  - `hashes` (`shellHashes`): the hash of each file it keeps; a new worker copies from the old
    copy every file whose hash is the same and fetches only the rest. Pages, manifests and
    `js/app-version.js` always travel again.
  - The fingerprint (`/version`) now counts the suite's texts (`i18n/`, in every catalog the
    browser loads) and a module's catalogs outside its public folder: code served from the copy
    must change version whenever any of it changes. It changes once with this release.
  An app on its own, and a module's own worker, keep code network first, as before.

## 0.129.0 — 2026-10-23

- **A new password ends everything else that lets someone in** (`revoke.js`, `accounts.js`, `api.js`,
  `workos-security.js`, `workos-accounts.js`, `live.js`, `app.js`, `host.js`). Changing the password
  from Settings, resetting it by mail, or the admin setting it, used to close the browsers' sessions
  and little else: an API token, an assistant's OAuth grant, a connected phone (which opens a new web
  session whenever it wants) or an AI client authorized in AuthKit, left by whoever had the account
  for a while, kept working after the owner changed the password. Now every path calls one
  `revokeEverything(userId, { keep, provider, reason })` (`suite.revokeEverything`): the sessions here
  (all but the one where it was done) and their sessions at the identity provider, the API tokens,
  the suite's OAuth grants, the device tokens with their web sessions and native push tokens, the
  browsers' push subscriptions, the AI clients of AuthKit (refused here for every token issued until
  now, and withdrawn at WorkOS in the background: `idp.revokeAllConnections`), the person's open tabs
  (`live.dropUser`, told first with an `account` notice) and an `auth.revoke_everything` line in the
  audit log. Disabling an account still doesn't: it can come back with what it had.
  - `accounts.whenPasswordSet((id, { exceptToken }) => …)`: who hears a password set, inside its
    transaction; createSuite hooks revokeEverything there, so `POST /api/me/password`,
    `POST /api/auth/reset` and the admin's `PATCH /api/admin/users/:id` all go through it.
  - With WorkOS, `POST /api/me/sign-in/password` (keeps the current session) and
    `PUT /api/admin/users/:id/sign-in/password` (keeps none, unless it is the admin's own).
  - The admin's "sign out everywhere" (`DELETE /api/admin/users/:id/sessions`) is the same function,
    so it now also disconnects the AI clients of AuthKit; its answer is unchanged.
  - `live.subscribe(req, res, user, { sessionToken })` and `live.dropUser(userId, { except, last })`;
    `suite.whenRevoked(hook)`, which a host's modules use for their own channels.
  - Not yet: a reset on AuthKit's own page ("Forgot your password?") is not heard by the app, so it
    still revokes nothing here.
## 0.128.0 — 2026-10-23

- **Paddle: what a checkout says is signed by the server** (`paddle.js`, `billing.js`, `config.js`,
  `app.js`). Paddle.js opens a checkout for any price with any `customData` from the browser, so
  anyone could buy Pro yearly at the founder's price by naming it in the console, and the webhook
  gave the plan to whoever `custom_data` named. The checkout now writes `custom_data.sig`, an HMAC
  of who pays (`workos_user_id` or `subject`), the product, the price, the app and the customer the
  server put on the transaction. An event whose `sig` is missing or doesn't match its own price is
  `unsigned`, and a subscription or purchase never heard of here on one grants and links nothing:
  `'unsigned'`, logged and in the audit (`billing.unsigned`). One already known keeps going without
  it: those bought before this version have no `sig`, and a plan changed in the portal keeps the
  first checkout's `custom_data` on another price. The key is `PADDLE_CHECKOUT_SECRET` (optional,
  32 characters or more) or, without it, one derived from `PADDLE_WEBHOOK_SECRET`; installs that
  grant one subscription together, each with its own notification destination, share
  `PADDLE_CHECKOUT_SECRET`.
- **A customer linked to another account stays theirs** (`billing.js`). An event that named someone
  by their identity took the provider's customer from whoever had it, and Paddle's checkout may
  match a customer by the email typed in it: a checkout opened by hand with another person's email
  could take their portal (invoices, payment method, subscriptions). The link moves now only on a
  signature for that very customer; otherwise it stays, the buyer still gets what they paid for,
  and the audit says `billing.customer_conflict`. An event of another provider (`unsigned` and
  `customerUnsigned` unset) is as before.
- **`accounts.endSubscriptions`** (`config.js`, `account-deletion.js`, `app.js`): someone deleting
  their account can have their subscriptions stop renewing at the request and end when the account
  goes without going at the identity provider too, for an install that bills alone while other
  apps sign in with the same users (Cronum Work). Left out, it follows `deleteAtProviders`, as
  before.

## 0.127.0 — 2026-10-23

- **Password and sign-in is the account's; where one is signed in is a connection**
  (`web/settings.js`, `i18n/*.json`). Settings had a Security group with one section that held the
  password, two-step verification and the open sessions. The group is gone: **Password and sign-in**
  (`security`, the same id, so `?settings=security` still opens it) is now in Account, after the
  profile; **Where you are signed in** is a section of its own (`sessions`) at the end of
  Connections, next to Your AI and Notifications, with the same list and the same sign-out per
  device. Connections is always there now, even with no AI connector and no notices.
  `kit.settings.groups.security` is gone; the hints say what each section holds
  (`kit.security.hint`, `kit.security.hintProvider`, the new `kit.sessions.hint`).
- **With WorkOS, the password and two-step verification from Settings** (`workos-security.js`,
  `workos.js`, `workos-accounts.js`, `accounts.js`, `schema.js`, `app.js`, `web/settings.js`,
  `web/admin.js`, `i18n/*.json`). Before, Settings only said they were managed where one signs in.
  - **How someone signs in decides what they see.** The callback notes WorkOS's
    `authentication_method` on the identity (migration 27, `user_identities.method`:
    `password`, `google`, `apple`, `microsoft`, `github`, `sso`, `email_code`; `signInMethod()`).
    For someone who hasn't signed in since, the accounts WorkOS links to them say it
    (`GET /user_management/users/:id/identities`). With Google, Apple, Microsoft or GitHub the
    section says plainly that there is no password here, that both are changed at that account,
    and links to its security page; with a company's sign-in (SSO) or a code by email, a line that
    says so. No second step is offered to them.
  - **A new password** (`POST /api/me/sign-in/password`), given the current one: it is checked
    with WorkOS's password grant, with the sign-in brake, and the session that check opens is
    closed at once; an answer that only wants a second step counts as right. WorkOS sets it
    (`PUT /user_management/users/:id`) and says when it is too weak (`password_rejected`). The other
    sessions end, here and at WorkOS.
  - **Two-step verification, optional** (`/api/me/sign-in/two-factor/setup|enable|disable`): the
    password, a QR code, a first code. The secret is made and that code checked here, and only then
    is it given to WorkOS as a TOTP factor (`totp_secret`), so no factor is ever left there half
    set up for AuthKit to ask for. AuthKit then asks for the code after the password, on the web and
    when an AI client is connected. Off with the password and a code. WorkOS has no recovery codes:
    the texts say so, and that whoever loses the phone writes to support.
  - **The admin** (`GET /api/admin/users/:id/sign-in`, `DELETE …/sign-in/two-factor`,
    `PUT …/sign-in/password`): an account's page says how they sign in, sets a password for whoever
    signs in with one (they are signed out everywhere) and takes the second step off for whoever
    lost the phone.
  - **`WORKOS_TWO_FACTOR`**: who is offered the second step, `admins` by default while it is
    tried out with AuthKit, then `on`; `off` offers it to no one. Changing the password is for
    everyone. WorkOS not answering is a 503 `provider_unavailable`.

## 0.126.1 — 2026-10-22

- **Signing out and deleting one's account inside the app on a phone stay in the app**
  (`web/signin.js`, `web/settings.js`). With WorkOS or OpenID Connect, both went to the provider's
  page (`logout_url`), another site: Cronum Work's app opened it in the phone's browser or raced it
  with its own sign-in. In the app (`inApp()`) neither goes there any more. `signOut()` ends the
  session at the server and clears the device's copies as before, sends the bridge's `sign-out`
  first (as since 0.106.0), and reloads to the site's own sign-in, as it does without a provider.
  Deleting one's account in Settings, once the server has taken it, now sends `sign-out` too (it
  sent nothing before) and reloads the site's own page; the app's own sign-in takes the place of
  the web's farewell notice. In a browser nothing changes, for either. The service worker serves
  pages network first and never caches `/api`, so the reload asks the server and shows the
  sign-in, not a signed-in copy.

## 0.126.0 — 2026-10-22

- **Another account from the connect page** (`web/connect.js`, `device-pages.js`, `oidc.js`,
  `workos.js`, `workos-accounts.js`, `i18n/*.json`). The phone app signs in through the system
  browser on `/devices/connect`; a browser that still held the web session of an earlier connect
  went straight to Allow for that account, so after signing out in the app there was no way to
  switch without clearing the browser. Signed in, the page now names the account (its name and
  email, `accountLabel`) and offers **Use another account**: it ends the browser's session
  (`POST /api/auth/logout`, the provider's `logout_url` left aside) and opens the same request
  again with `prompt=login` (`anotherAccountAddress`). With local accounts the page signs in in
  place; under WorkOS or OIDC the server sends the browser to `/auth/login?prompt=login`
  (`FRESH_LOGIN_PATH`), which asks the provider to sign in again instead of reusing its session:
  OIDC `prompt=login`, AuthKit `max_age=0`. Only the connect page asks for it: `/auth/login`
  without the parameter, and every other sign-in, is as before. Texts in en, es, fr, de and it
  (`kit.connect.otherAccount`, `kit.connect.signingOut`).

## 0.125.0 — 2026-10-22

- **Reminders the phone schedules are not pushed to it** (`native-push.js`, `push.js`,
  `host-worker.js`, `host.js`, `devices.js`, `schema.js`). Cronum Work's app schedules a person's
  coming reminders as local notifications, and the reminders sweep also pushed each one natively:
  with the app closed the phone rang twice. Now the device says what it scheduled and native
  delivery skips it. With `push.native` only; an app or a module that names no reminder sends
  exactly as before.
  - `PUT /api/devices/reminders` with `Authorization: Bearer <device token>` (failures in the
    `devices` bucket, as the other device routes) and `{ items: [{ module: string | null, id:
    string, at: ISO-8601 }] }`, at most 64: `module` like a host's mount, `id` up to 64
    characters, `at` a real instant. It replaces the device's previous list (empty clears it) and
    answers `{ ok: true, count }`.
  - Kept in `device_reminders` (**suite migration 26**), hanging on `device_tokens` with
    `ON DELETE CASCADE`; cleared when the device is revoked (Settings, the app signing out with
    `DELETE /api/devices/current`, the admin) and on `DELETE /api/devices/push`. Not exported.
  - `push.deliver(subs, payload, { reminder: { id, at } })`, and the same option on `send` and
    `sendTo`: a native target whose device reported that `(module, id, at)` (the instants within
    60 s) is skipped, and `deliver` adds `skipped` to its answer. In a host the module is filled in
    from the module's path (`hostedPush`, and new `moduleReminderPush` for a host without the one
    worker). Web Push is never skipped.

## 0.124.0 — 2026-10-22

- **Your AI, with one prompt for a host's modules** (`web/agents.js`, `web/settings.js`, `host.js`,
  `web/kit.css`). `createHost({ aiInstruction: '/api/ai-instruction' })` names the host's route that
  builds the prompt for an assistant (`?lang=xx&modules=a,b` → `{ text }`), and `/api/modules` says it
  in `host.aiInstruction`. Settings › Your AI then has, instead of each module's instruction folded,
  "Integrate your AI agent": a chip with its mark for Claude, ChatGPT, Gemini, Claude Code, Codex,
  Gemini CLI, Cursor and VS Code, each opening its steps to add the connector, the last one sending to
  the prompt; the prompt for the modules ticked (the ones in use at first) with Copy; and under it
  what each module in use adds (`standingMore`), folded under its name. A host without the option,
  and an app on its own, read as before.
- **`web/agents.js`**, for a host's own pages too (Work's first start): `AGENTS`, `agentMark`,
  `agentGuide`, `agentSteps`, `agentChips` and `aiPrompt`, with their words in every language
  (`kit.agents.*`, `kit.ai.agents*`, `kit.ai.prompt*`, `kit.ai.moreTitle`). The marks are each maker's
  own in one colour (@lobehub/icons-static-svg, MIT; @vscode/codicons, CC BY 4.0).

## 0.123.0 — 2026-10-22

- **Emails to whoever runs the install when the server fails** (`alerts.js`, `app.js`, `host.js`,
  `config.js`, `http.js`). With `ALERT_EMAIL` set and `MAIL_PROVIDER=smtp`, an app or a host
  emails that address when an exception reaches the top (before the process exits with 1 as
  before, waiting 4 s at most for the email), when a rejection nobody awaited is logged, when the
  server answers 5 or more 5xx within 5 minutes, and when a scheduled job of the suite throws (the
  clean-ups, the account deletion, the groups' renewals, a module's sweep). Off unless set: an
  install without `ALERT_EMAIL` behaves exactly as before, and `ADMIN_EMAIL` is never used on its
  own (an install that moves up would start getting mail it never asked for). With
  `MAIL_PROVIDER=log`, or an `ALERT_EMAIL` that isn't an address, a warning at the start and no
  alerts: never a reason not to start.
  - **One email per kind every 30 minutes at most**, across restarts: the time of the last one is
    saved in `app_meta` (`suite.alerts.<kind>`) before it goes, and none goes when it can't be
    saved, so a crash loop sends one. What happened meanwhile is counted, and the next email says
    how many were held back; one the mail server refused is counted too.
  - **What it says**: the app's name and version, `BASE_URL`, the machine, the kind, the time and
    the error's name, message and first 15 frames, without emails, long tokens or the queries of
    URLs. Of a request only its method, status and route pattern (`POST /tasks/api/lists/:id`; a
    path no route took, its first two words): never its query, body, headers, cookies or who made
    it. Plain text in English, like the log it comes from.
  - `createSuite()` returns `alerts` (and a module of a host gets the host's): an app's own timers
    can call `suite.alerts.jobFailed(name, error)`, which never throws and does nothing with alerts
    off; `createApp()` and `createHost()` wire the rest. The router's `match()` also returns the
    route's `pattern`.
- **`.env` files are never committed** (`.gitignore`): `.env` and `.env.*` are ignored, except
  `.env.example`, before suite-core is published.

## 0.121.0 — 2026-10-22

- **The front end's version from what its files hold, not their dates** (`app.js`, `host-worker.js`,
  `http.js`). Every deploy builds from a fresh checkout, so every file got a new date and every
  deploy of a host was "a new version" in every module and on every device, with the host's one
  worker downloading the whole app again, changed or not. Now an app's `/version` and
  `/js/app-version.js` (new `frontFingerprint(dir)`), a host's whole-app fingerprint and its
  worker's version (`fingerprint`) are made of each file's path and content hash: two deploys
  with the same front end are the same version. `built` is still the newest date, for About;
  nothing compares it.
- **ETags from content** (`http.js` `serveStatic`, new `contentHash(file, stat?)`). A file is
  `W/"<size>-<hash>"`, so the same file in a new build is still a 304 instead of travelling again.
  The hash is read once per file and read again only when its size or date change.

## 0.120.0 — 2026-10-22

- **Italian** (`i18n/it.json`, `i18n.js`, `web/i18n.js`, `web/settings.js`). The suite speaks `it`:
  every text of its own screens (account, settings, plan, admin, OAuth, devices) in Italian, with the
  informal "tu", and Settings › Language names it "Italiano". An app speaks it by adding
  `public/i18n/it.json` and `'it'` to `app.languages`.
- **A language an app may not speak yet** (`OPTIONAL_LANGUAGES`, today `['it']`, in `i18n.js` and
  `web/i18n.js`). An app without its catalog reads exactly as before: on the server `appTexts`
  passes it over when negotiating (`languageFor`, `userLanguage`), in the browser a 404 for its
  catalog makes `loadLanguage` pick what it would have picked without it, and `tools/i18n.mjs app`
  (`appChecks`) checks it only once the app has its catalog. The four first languages are still
  required of every app.

## 0.119.0 — 2026-10-22

- **Settings › Plan, one for a whole host** (`host.js`, `web/settings.js`). In a host every module
  gets the host's payments (`billing`, `stores`), whether the app sells on its own or not, and
  `/api/auth/config`'s `app.host.billing` says the host sells: the plan section then offers what
  the host sells in every module, whatever the module passed to `openSettings` (Tasks' `plan:
  true`, nothing at all in Notes or Projects). A checkout comes back to the module it left, and
  every module's frame now thanks the person and reads the plan again (`web/shell.js`
  `billingReturn`). An app on its own is as before.
- **The plan section, ordered** (`web/plan.js`, `web/settings.js`, `web/kit.css`). Under the plan's
  name, when it renews or ends ("Renews on", "Ends on", from the new `ending`), through which store,
  until when a gift lasts, the group that covers it, or "Included in the early access, until";
  and the extras given on top, each with its end. Then what it includes and the usage, as before;
  what can be bought, each with its price (`amount`, the founder's beside the regular one struck
  through, with "Billed yearly. Your price stays as long as you stay subscribed." and until when);
  and for whoever pays now, "Change or cancel plan": a dialog with what can be done at the
  provider's page (switch period, cancel and until when the plan stays, payment method, invoices)
  and the way there, or for a store's subscription how to cancel it in the App Store or Google Play,
  with its page. A store's subscription is no longer offered a second one on the web. `planPayments`
  takes `appName` and `benefit` and returns `status` (the card's lines); new `planStatus`,
  `periodOf`, `moneyText`, `lastDay`. "Manage subscription" and its block are gone.
- **Whether a subscription renews** (`billing.js`, `paddle.js`, `stripe.js`, `revenuecat.js`, suite
  migration 25 `billing-ending`): an event's `ending` (Paddle's `scheduled_change.action =
  'cancel'`, Stripe's `cancel_at_period_end`, the store's `unsubscribe_detected_at`) is kept in
  `billing_subscriptions.ending` and answered by `/api/billing/subscriptions` and the overview
  (true, false, or null when the provider didn't say). Not carried in copies: the next event says it.
- **`GET /api/billing/overview` with the web's alone** (`app.js`): registered with billing on, not
  only with `STORE_BILLING`; it also lists `kind: 'extra'`, the features given one at a time.
- **The early access and its end** (`config.js`, `entitlements.js`, `billing.js`, `app.js`,
  `host.js`). `FOUNDER_OFFER_UNTIL` (after `EARLY_ACCESS_UNTIL`): from that date nobody gets the
  founder's price; `/api/billing/products` says `founder_until` for a founder who doesn't pay yet
  once the early access is over, and a host's `GET /api/modules` `founder_offer: { until }`, which
  every module's frame shows as a notice that thanks them and says until when, with a way to the
  plan, closed on the device for that date. `EARLY_ACCESS_PLAN`: everyone without a grant has that
  plan until `EARLY_ACCESS_UNTIL` and the default plan after, with nothing to change by hand; and
  nothing is sold until then (`on_sale: false`, `opens_at`; the checkout answers 409
  `not_on_sale`). Products may say `amount`, `founderAmount` and `currency`, only shown. When
  someone joined WorkOS is asked once per process.
- Texts: `errors.not_on_sale`, `kit.plan.renewsOn`, `endsOn`, `via.*`, `given`, `givenForGood`,
  `coveredBy`, `earlyAccess`, `extrasTitle`, `extraUntil`, `change`, `changeHint`, `changeTitle`,
  `yourSubscription`, `canTitle`, `can.*`, `alreadyEnding`, `openPortal`, `changeInBrowser`,
  `store.*`, `storeKeeps`, `openStore.*`, `per.*`, `regularPrice`, `founderNote`, `founderUntil`,
  `kit.founder.notice`, `kit.founder.see`.

## 0.118.0 — 2026-10-22

- **An app leaves the suite's tokens** (`web/tokens.css`, `tools/i18n.mjs`): its `--cr-product-*`
  colour and its `:root[data-app]` accent are gone, and its name is no longer one of
  `BRAND_WORDS`. An app that used them sets `--app` itself.

## 0.117.0 — 2026-10-22

- **Your usage in Settings › Plan** (`usage.js`, `host.js`, `web/usage-view.js`,
  `web/settings.js`, `web/admin.js`, `web/kit.css`, `web/sw-core.js`). In a host, everyone sees
  under their plan what the admin's Usage shows of them: what they keep in each module they use,
  against the plan's caps with a bar and its percentage, their storage across the modules and
  their calls from assistants today and over 30 days. Near a cap (80 %) or at it, a notice comes
  first with what is there as people count it ("2 projects" in red at the cap, "17 lists" in amber
  near it; the thing named says which module), and "See plans" when there is a way to more here
  (the plans on offer below, or the app's store). Without limits, the numbers alone. A standalone
  app, or a host that doesn't answer, shows no block.
  - **The storage by module**, here and in /admin: one bar split as a phone shows its own, each
    module in its icon's hue (a step of it that tells the four apart with any colour vision, light
    and dark checked), the room left grey, and a legend with each one's size.
  - `GET /api/me/usage`: the person's own `usageOf()`, registered by the host whether or not it has
    the admin panel. 401 without a web session; an assistant's token isn't one.
  - `web/usage-view.js` draws it for both: `usageGroups(usage, { admin })` and `atLimit(usage)`,
    with `meter`, `levelOf`, `peakWhat`, `percent` and `sizeText`. The kit caches it.
  - Texts: what both say moves from `admin.usage.*` to `kit.usage.*` (`items.*`, `near`, `reached`,
    `peakIn`, `ofLimit`, `storage`, `inAll`, `filesCount`, `used`, `mcp`, `today`, `month`,
    `monthChart`, `dayCalls`); new: `kit.usage.title`, `lead`, `loading`, `failed`, `nothing`,
    `noDailyLimit`, `nearNotice`, `reachedNotice`, `counted.*`, `free`, `storageChart`. An app that overrode one of the moved
    keys has to rename it.

## 0.116.0 — 2026-10-22

- **Calls from assistants are counted for everyone, with a limit or without**
  (`entitlements.js`, `usage.js`, `web/admin.js`). `countDaily()` counted only where the plan had a
  daily limit, so the admin's Usage had nothing for an account without one (the instance admin,
  a plan with no cap). Now every call is counted and still allowed when there is no limit:
  `countDaily()` answers `used` as a number in every case (it was `null` without a limit). The
  Usage fold shows those calls too, today's and the month's, without a bar of a limit ("Their plan
  has no daily limit"), so the average of everyone can say whether the limits fit. The text
  `admin.usage.notCounted` is gone; `admin.usage.noDailyLimit` is new.

## 0.115.0 — 2026-10-22

- **Usage in /admin: what each person uses, and how close they are to their plan's caps**
  (`usage.js`, `host.js`, `web/admin.js`, `web/kit.css`, `entitlements.js`). In a host, an
  account's dialog has a Usage fold: per module what they keep (lists, tasks, subtasks, notebooks,
  notes, projects, entries, files), each count with a cap shown against it with a bar and its
  percentage, and "Near the limit" from 80 % or "At the limit" in words; the last change in each
  module, and whether they turned it off; their storage across the modules against `storage.mb`;
  and their calls from assistants today against `mcp.calls_per_day`, with the last 30 days as bars.
  The Users list has a Usage column: each account's nearest cap. A standalone app has none of it
  (the column and the fold go when the routes answer 404).
  - A module says what someone has with `createModule().usage(userId)`:
    `{ counts: [{ id, count, feature? }], active_at }`. `id` is one of `USAGE_ITEMS`; ids it doesn't
    know are left out. A count with a `feature` is set against that limit of the module's own plan.
    A module without `usage` shows only its storage; one whose `usage` throws is marked `failed`
    and logged, and the rest still answer.
  - `GET /api/admin/users/:id/usage` and `GET /api/admin/usage` (`{ peaks: { <id>: { share, id,
    mount?, name? } | null } }`), the instance admin's only. Read-only and on demand.
  - **`entitlement_usage` keeps 30 days** (`USAGE_DAYS`) instead of today's alone, and
    `entitlements.dailyUsage(userId, feature, { days })` reads them, a day without uses at 0. The
    barrier still reads today's count only.

## 0.114.1 — 2026-10-21

- **Security fix: a code for `/devices/session` can no longer sign a reader into someone else's
  account** (`device-pages.js`, `devices.js`). An image in a shared note
  (`![](/devices/session?code=<a fresh code>&next=/notes/)`) loaded the address from this same
  site, spent the code, closed the reader's session and opened one in the account of whoever made
  the code. Now:
  - **Only the app's own top-level load of the page opens a session**: `Sec-Fetch-Site` absent or
    `none`, `Sec-Fetch-Dest` absent or `document`, and `Sec-Fetch-Mode` absent or `navigate`
    (Android's WebView and WKWebView send `none`, `navigate` and `document`; an old WebView that
    sends none of them still works). Images, frames and fetches are refused, and so is a link
    followed from a page of this site (`same-origin`: a link in a shared note) as well as from
    another site. Nothing of this site links to the route.
  - **A live session of another person is replaced only when a device opened it, and only by a
    load that says `Sec-Fetch-Site: none`** (`signed_in` otherwise). That is the app's WebView,
    which kept the cookie of the account it had after a sign-out that didn't reach the server. An
    ordinary session of the web never is, and a load with no Fetch Metadata (WKWebView before
    iOS 16.4, any `http://` address) replaces no one's session: the app clears its cookies and
    its second load opens. A session of the same person is replaced as before.
  - **A refusal spends nothing and doesn't count against the address**: the code stays good for
    its minute, and a page that loads the address many times can't lock the reader's phone out
    of `rateLimits.devices`. It goes to `/?device_session=refused` (`REFUSED_PATH`), so the app can
    clear its WebView's cookies and try once more; a request from another site now goes there too
    instead of `/`. A code that is unknown, spent or expired still goes to `/` and counts.
  - **The audit log can't be flooded by refusals**: one decided by the headers alone writes
    nothing (it reads no code, and anyone can send it; `cross_site` is no longer written), and
    `signed_in` is written at most ten times per address in the window (a new, internal
    `devicesRefused` bucket of the limiter, apart from the token's).
  - `devices.takeWebCode(code, { refuse })`: `refuse(userId)` is asked last, for a code that would
    open a session; a reason leaves the code unspent and answers `{ refused, userId }`. The audit
    reason `signed_in` is new.

## 0.114.0 — 2026-10-21

- **Settings, a second pass** (`web/settings.js`, `web/kit.css`, `host.js`, `host-worker.js`,
  `web/sw-core.js`, catalogs). Additive.
  - **The plan is a card**: its name large, until when under it (`kit.plan.untilDate`), more room
    around it and below what it includes.
  - **What an app says of its instruction is in its fold**: `openSettings({ standingMore })` and
    `createModule().settings.standingMore`, keys of its catalog (paragraphs) and pairs of keys
    (lines of a list, a label in bold), drawn under Copy. Nothing in a fold takes the person
    elsewhere any more ("More about…" and `kit.ai.standingMore` go).
  - **In a host, deleting the account is under Account** (after Plan), not in the host's group. Its text says what will happen if the person deletes it (`kit.data.deleteHint`), and in a host what happens to what they share, for every module (`kit.data.deleteShared`), with no second title.
  - **"What it is" is the app's website**: `site` (an https address) in both, linked from its
    card in About, in a tab of its own; without one, no link.
  - **A host's notices show the icon of the module that sent them**: the host's worker gets
    `push.icons` (`{ [mount]: icon }`, each module's `push.icon` from its sw.js, else its
    `icons/icon-192.png`) and keeps those icons; sw-core uses the notice's `module` (put on by
    `hostedPush`). Notices without one, and hosts without icons, as before.

## 0.113.0 — 2026-10-21

- **Clean gets an iPhone's type, corners and room** (`web/kit.css`). Additive: the Cronum look
  computes exactly what it did, value for value.
  - **`--look-*` variables**, set only under `<html data-look="clean">`: Apple's text styles
    (`--look-large-title` 34px, `--look-title1`…`--look-title3`, `--look-headline` and
    `--look-body` 17px, `--look-callout`, `--look-subhead`, `--look-footnote` 13px,
    `--look-caption`, `--look-caption2`, and `--look-base` for the page's own text), radii
    (`--look-r-xs`…`--look-r-xl`, 6–18px) and room (`--look-gutter` 20px, `--look-row-y`,
    `--look-row-gap`, `--look-head-y`, `--look-item-y`, `--look-bar-y`, `--look-section`).
  - **Every size in the kit uses one, with today's value as its fallback**
    (`font-size: var(--look-subhead, 14px)`): 78 font sizes, 49 radii and the main rows, heads
    and items. An app's stylesheet does the same for its own; with no Clean look, the fallback is
    what applies. App icons, pills, circles and the sign-in hero keep their sizes.
  - In Clean, a view's head (`.kit-head`) has a 34px title and no line under it, sidebar entries
    are 44px tall, and section labels are spaced like an iPhone's.

## 0.112.1 — 2026-10-21

- **Opening the drawer from the edge no longer switches module** (`web/shell.js`). In the installed
  app on an iPhone, a swipe from the screen's edge that began just past the kit's 20 px went to the
  system, which took it as Back: the page before was the module used last, so Projects turned into
  Tasks. Now, in the installed app (`display-mode: standalone`), going to another of the host's
  modules (the rail, the switcher's menu, any link to one) replaces this page in the history
  instead of stacking on it, as a phone app's tabs do; a browser keeps its history as it was. The
  strip at the edge that opens the drawer is 28 px.

## 0.112.0 — 2026-10-21

- **The admin's account dialog, compact** (`web/admin.js`, `web/kit.css`, catalogs). Only the page changes; the API
  is the same.
  - **Folds that say what they hold**: Account (email and role), Plan (the plan and until when, or
    «(by default)» in the warning colour), Extras (how many are in force) and, with local accounts,
    Password. One open at a time; Plan opens first. Signing out everywhere, the second step and
    deleting the account sit apart at the end, the deletion on its own on the right.
  - **Plan**: plan, end and reason in one row with one line of help; the reason the admin gave is
    in the form, so changing only the end keeps it. «Back to the default plan» only shows when the
    plan is the admin's: a subscription is not taken back here.
  - **Extras**: only those in force, each with Take back; adding one and the history (ended, taken
    back, the plans set) fold away.
  - Catalog keys: new `admin.users.optional`, `admin.users.planHint`, `admin.grants.noneShort`,
    `activeCount`, `history`, `value`, `addOne`, `addHint`; gone `admin.users.planLead`,
    `planUntilHint`, `planNoteHint`, `access` and `admin.grants.limitHint`.

## 0.111.0 — 2026-10-21

- **A second look for a host: Clean** (`host.js`, `web/kit.css`, `web/tokens.css`, `web/theme.js`,
  `web/base.js`, `web/shell.js`, `web/settings.js`, `web/sw-core.js`, `web/fonts/`, catalogs).
  Additive: an app on its own, and a host's page whose person chose nothing, look as before.
  - **Clean** (`<html data-look="clean">`): white and greys with no hue in them, a white rail, hairline borders,
    soft shadows, larger radii and **Inter** for text and headings; the product's accent stays the
    one colour and yolk still marks "now". Light and dark each have their tokens; the modules'
    own variables follow the kit's, so they need nothing.
  - **Inter** is the suite's own file, like Geist (`web/fonts/inter-latin*.woff2`, OFL): a browser
    only fetches it on a page that uses it. `--cr-font-clean` names it. The host's worker keeps
    the Latin file offline.
  - **One choice for the whole host, on every device**: host migration 3 (`host_looks`, scope
    `host`; no row is the suite's own look). `GET /api/modules` says `look` (`cronum` or `clean`),
    and `PUT /api/me/look { look }` saves it (`field_invalid` for any other; the person's tabs hear
    their account changed). `LOOKS` is exported by `host.js` and `web/base.js`.
  - **Painted before anything shows**: `applyLook(look)` (`web/base.js`) sets or takes away
    `data-look` and keeps `host.look` in the browser; `web/theme.js` reads it before the first
    paint (a module with its own `theme.js` adds the same line). The frame applies the host's
    answer each time it asks for the modules, and follows a change made in another tab or frame of
    the split view at once.
  - **Settings › Language and theme**, in a host only: **Look**, Cronum or Clean, saved at once and
    undone on the page if the server refuses it.

## 0.110.0 — 2026-10-21

- **The admin sees where each plan comes from** (`entitlements.js`, `api.js`, `web/admin.js`,
  `web/kit.css`, catalogs). Additive: `of()` keeps its shape and nothing else changes for an app.
  - `entitlements.sourceOf(user)`: `{ kind: 'default' }` when no grant gives the plan shown —it is
    the install's default (`DEFAULT_PLAN` or the catalog's first), and goes when that changes, even
    when a grant would give the same plan—, `{ kind: 'unlimited' }` for the instance admin, else the
    grant that gives it: `kind` `admin` or `subscription` (`provider`), `ends`, `note` and
    `organization_id` when it is a group's. Of two grants of the plan shown, the one that keeps it longest.
  - `GET /api/admin/users` and the other answers about an account carry it as `plan_source`.
  - **Users**: the default plan reads «Pro (by default)», never as a gift; a gift says until when or
    «for good», and its reason; a subscription where it is paid, and whether it is a group's. The
    account's dialog says the same at the top of Plan and, on the default plan, that nothing keeps it.
  - **A reason for a plan**: the plan form has an optional Reason, sent as `note`. `PUT
    /api/admin/users/:id/plan` trims it, keeps 200 characters, and records it in the log's
    `admin.plan.set` too (only when there is one).

## 0.109.0 — 2026-10-21

- **Settings, shorter and in one piece** (`web/settings.js`, `web/kit.css`, `host.js`,
  `web/update.js`, catalogs). Additive: an app or module that passes nothing new behaves as before,
  but its list folds.
  - **The list folds by group**, one open at a time: a heading unfolds its group and folds the one
    that was open; opening a section unfolds its own. On a phone nothing is unfolded at first. A
    group with one section is a heading that opens it.
  - **The plan is the account's**: Plan moves from its own group into Account, and says **what it
    includes**, a line per feature it can name (`planBenefits(features, { app })`, exported), what
    is in first and what isn't marked as such. In a host, every module in use answers for its own
    features (`<module>/api/me/entitlements`), joined.
  - **Instructions for your AI, in Your AI**: `openSettings({ standing: '<catalog key>' })` names the
    app's instruction to paste into an assistant's own instructions; Your AI explains once what to
    do and why, with one fold per app holding its text and Copy (one open at a time, `<details
    name>` and a fallback). A host module declares the same key in `createModule().settings.standing`
    (`moduleSettings()` passes it on when it is a catalog key), and its fold is drawn from its
    catalog in every other module. With it, the module's `aiExtra` section leaves the list and is
    opened from its fold. Your AI names the host, not the module, as what the assistant connects to.
  - **About, the whole app's in a host**: the host's icon, name and source (`https://github.com/cronumstudio/<host id>`)
    —before, the module open's—, its version and update check as before, and a card for each
    module in use with its icon, line and version, and a way to what it says it is (`aboutExtra`,
    no longer in the module's group). The line is the module's `app.tagline`, or the key it names
    in `createModule().settings.tagline`. The host's `/js/app-version.js` exports `APP_MODULES`
    (`{ [mount]: { app } }`), which `watchUpdates().loaded()` passes on as `modules`.

## 0.108.0 — 2026-10-21

- **Actions from a phone's notification, without opening the app** (`devices.js`, `app.js`,
  `host.js`, `idempotency.js`). For Cronum Work's app: the Complete and Snooze buttons on a task's
  reminder act on the server with the device's token. Only with `modules.devices`; without it no
  route is added and nothing runs.
  - `POST /api/devices/actions` with `Authorization: Bearer <devices.prefix>…` (a session cookie
    alone is a 401) and `{ module, action, id, ...params }`, e.g. `{ module: 'tasks', action:
    'complete', id: '123' }` or `{ module: 'tasks', action: 'snooze', id: '123', minutes: 60 }`.
    → 200 `{ ok: true, ... }` with what the handler answered (a plain object); 404
    `action_not_found` for a module or action nobody declared; the handler's own `HttpError`s as
    they are; 400 `field_required`/`field_invalid` for a body without `action` or with an `id`
    (text or number) or `module` (text) of another kind. A bad token is a 401 that counts against
    the address in the devices' bucket, as the other device routes; a module's refusal counts
    nothing. An `Idempotency-Key` runs a retried action once, keyed by the device's account.
    Audit: `device.action` with `{ module, action, id }` (never the params), the device as target.
  - A host's module declares them in `createModule().deviceActions`, reached by its path as
    `module`; an app on its own in `createApp({ deviceActions })` (`module` absent or its own app
    id), which an app that spreads its module's parts into `createApp()` gets for free. An object
    `{ [action]: async ({ user, id, params, suite, action }) => result }` or a function `(action) =>
    handler | null`; a name of lowercase letters, digits, `_ . -`; declared wrong, the start stops
    saying which. The handler acts as `user` (the device's account, with `device_id`) with that
    person's permissions only, through the same code as its web route, so its live channel, links
    and plan limits work as for any change from the web; `suite` is the module's own.
  - `keyedByRoute(handler)` (idempotency.js): a route that runs `idempotency.run()` itself, for an
    account it finds on its own; app.js leaves it alone, as it does `answeredOnce`.
- New texts in the catalogs (en, es, fr, de): `errors.action_not_found`, `fields.action`,
  `admin.actions.device_action`.

## 0.107.0 — 2026-10-21

- **Native push, straight to Apple and Google** (new `native-push.js`; `push.js`, `config.js`,
  `app.js`, `devices.js`, `accounts.js`, `host-worker.js`, `host.js`; **suite migration 24**,
  `device-push-tokens`). For Cronum Work's app on iPhone and Android, with no push service in
  between and no dependency. Behind a new setting, off by default: `push: { native: true,
  apnsTopic: '<bundle id>', androidChannel?: 'default' }` in suite.config.js, which needs
  `modules.push` and `modules.devices`. With it off nothing runs, no variable is read, no route is
  added and every send is Web Push only, as before.
  - The phone's app registers its token with its device token (`Authorization: Bearer
    <devices.prefix>…`): `POST /api/devices/push` `{ platform: 'ios' | 'android', token,
    environment?: 'sandbox' | 'production' (APNs only; production by default), lang? }`,
    `DELETE /api/devices/push`, and `POST /api/devices/push/test` for a test notice to that device.
    One token per device in `device_push_tokens` (`ON DELETE CASCADE` on `device_tokens`; the same
    token registered by another device moves there). A device revoked loses its token at once; one
    idle, refused by `canConnect` or of a disabled account gets nothing. `GET /api/me/devices` adds
    `notifications: true | false` to each device.
  - The same sends reach the phones: `subscriptionsOf()` also returns the people's phones (rows
    with `native: true`), `deliver()` sends each where it goes and, given Web Push rows only (Tasks
    reads `push_subscriptions` itself), adds those people's phones; `sendTo`, `send`,
    `/api/push/test` and the host's `hostedPush` too, each phone once per delivery. The payload the
    modules already send maps to APNs (`aps.alert` title and body, sound, `badge` when a whole
    number, `category`, `thread-id` from the module or tag, `apns-collapse-id` from the topic or
    tag) and to FCM v1 (`notification`, `android.collapse_key`, `channel_id`, `tag`, `data` as
    strings); every other plain value (`url`, `module`, `id`, `task_id`…) travels as data, also as
    JSON under `body` for expo-notifications. A body too long for 4 KB is shortened, never refused.
  - APNs over HTTP/2 (`node:http2`), one connection per host kept, token auth with an ES256 JWT
    from the .p8 key (`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`, topic `APNS_TOPIC` or
    `push.apnsTopic`), made again every 50 minutes; the sandbox host for a development build's
    token. FCM HTTP v1 with `FCM_SERVICE_ACCOUNT` (the JSON, or it in base64): an RS256 JWT for an
    OAuth access token, cached until five minutes before it ends.
  - Gone tokens (APNs 410, `BadDeviceToken`; FCM `UNREGISTERED`, 404, `INVALID_ARGUMENT` on the
    token) are dropped, three refusals in a row too; our own credentials or message and outages
    count against no device. Credentials never stop the start, as with VAPID: a platform with
    variables missing, or with a value that can't be used, is off, said once at the start by the
    variable's name and what is wrong (never its value), and its tokens are kept. Only
    suite.config.js's `push.*` written wrong stops the start.
- **`hostedPush().sendTo`** goes through the marked delivery too: it was spread from the suite's
  push and sent a module's notices without its path and tag. No module used it.
- New field names in the catalogs (en, es, fr, de): `fields.token`, `fields.environment`,
  `fields.lang`.
- A module that picks the people to notify from `push_subscriptions` itself reaches a person's
  phone only when that person also has a Web Push subscription; through
  `suite.push.subscriptionsOf([userId])` it reaches someone with the phone alone (a one-line change
  in Tasks' `notify.js` and Projects' daily summary, for a release of theirs).

## 0.106.0 — 2026-10-21

- **The kit's bridge to the suite's app on a phone** (new `web/native.js`; `settings.js`,
  `plan.js`, `shell.js`, `signin.js`, `push.js`, `worker.js`, `sw-core.js`). Cronum Work's app for
  iPhone and Android is a web view of the web; a page now knows it runs there, from the user
  agent (`CronumWorkApp/<version>`) or `window.CronumNative` (`{ v, platform, version,
  capabilities }`): `inApp()`, `nativeInfo()`, `can(capability)`. It sends the app `{ v: 1, type,
  ...payload }` through `window.ReactNativeWebView.postMessage`: `ready` (the frame drawn,
  `createShell()`), `badge` `{ count }`, `reminders` `{ items: [{ id, module, title, at, url }] }`
  (the full set of the next days, replacing the one before), `purchase` `{ product }`,
  `open-external` `{ url }`, `sign-out` (`signOut()`), `haptic` `{ style }` and
  `open-app-settings`; and hears the app's on a `cronum-native` event (`onNative()`,
  `lastNative()`): `purchase-result` `{ product, status }` and `push-state` `{ state }`. The
  messages are only ever added, never renamed or changed in meaning, and an unknown one is
  ignored on both sides (docs/web-kit.md, Inside the app on a phone).
- **Settings inside the app** do it by themselves, whatever the module passes. The plan section
  never shows the web's checkout (`hideCheckout`); where the app sells (`purchase`), a plan's
  barrier offers its store (`storePurchase()` in plan.js: the `purchase` message, then the plan
  read again and `kit-plan` when bought, each outcome said in a notice), and the section has
  "See plans" for whoever has a plan above theirs; where it doesn't, only the reason. In a host
  this comes with the host's plan (`app.host.plans`). Notifications offer no Web Push there: the
  app sends them (with `push`: whether the phone has them off, and the app's own settings), or
  they come with an update of the app. `subscribePush()` refuses inside the app, `pushSupport()`
  says `'unsupported'`, and the host's one worker carries no subscription over: the app's own
  registration is the phone's one channel.
- Outside the app nothing changes: every function of `native.js` does nothing there, and every
  page and Settings behave and ask the server exactly as before.

## 0.105.0 — 2026-10-20

- **The connect page as a suite piece** (new `device-pages.js` and `web/connect.js`, `config.js`,
  `app.js`, `host.js`; `devices.connectPage`). An app or a host with `modules.devices` that sets
  `devices: { connectPage: true }` gets `/devices/connect` from the suite, a page an app had of its
  own (and keeps): the native app opens it in the system browser with
  `?code_challenge&state&redirect_uri&name&platform`, the person signs in and allows the device,
  and the page asks `POST /api/devices/codes` and goes back to the app with the code (Cancel goes
  back with `error=access_denied`). A query that is not a request the core takes goes to the bare
  page. With local accounts the page signs in in place; under a provider's sign-in the request
  waits in a signed cookie (`<app id>_connect`, ten minutes) and `/` brings the browser back to it
  after the provider's callback, at a host's root too, before `/` goes to the first module. In the
  product's name and colours and the person's language (`kit.connect.*` in en/es/fr/de).
- **Sessions of the web from a device** (`devices.js`, `sessions.js`, `device-pages.js`;
  `devices.webSessions`; **suite migration 23**, `device-web-sessions`). For an app whose screens
  are its web pages in a WebView (Cronum Work): `POST /api/devices/web-session` with the device's
  token answers `{ url: '/devices/session?code=…', expires_at }`, a code of one minute, once, kept
  as a hash and bound to the device; `GET /devices/session?code=…&next=<path>` opens an ordinary
  session for the device's account (the same cookie as a sign-in), linked to the device, and goes
  to `next` when it is a path of the site, else to `/`. A bad, spent or expired code, a device
  that no longer works, or a link of another site (`Sec-Fetch-Site`) opens nothing and goes to `/`.
  Failures count against the address in the token's bucket (`rateLimits.devices`); the audit log
  names `device.web_session` and `device.web_session_failed`. The session ends with its device:
  revoked by its owner, by itself or by the admin, gone idle, its account disabled or deleted, or
  refused by `canConnect`; using it counts as using the device. No second step is asked: the token
  was given to a session that had passed it. The migration adds the table `device_web_codes` and a
  nullable `sessions.device_id`: every app gets them, and they stay empty without the option.
- **The service worker never answers `/devices/session`** (`web/sw-core.js`): a one-time code is
  never served from a copy, nor a page put in its place when the network is slow.
- Without the new options nothing changes: an app with `modules.devices` serves neither
  page nor `/api/devices/web-session`, and its configuration's `devices` keeps its shape. A host
  with either option refuses a module mounted at `/devices/`.

## 0.104.0 — 2026-10-20

- **One Settings for a whole host** (`settings.js`, `host.js`, `base.js`, `shell.js`). In a host
  (Cronum Work) each module opened Settings of its own: its own sections only, its own data and
  about, and notices or the plan only where that module asked for them. Now the list is the same
  in every module: the account's sections (profile, modules, language and theme, password and
  sign-in, your AI, notices and plan, the last two when the host says so: `app.host.push` and
  `app.host.plans` in `/api/auth/config`); then a group for each module the person uses, in the
  host's order, with its own sections, its data (export, import, erase), what it adds to Your AI
  and what it is; and last the host's: deleting the account, administration and About. A module
  not in use shows nothing. The module open draws its own sections; another's are named from the
  host's `/api/modules` (`settings`, from `createModule().settings`, host.js `moduleSettings()`) in
  the person's language, read from that module's catalog, and choosing one goes there with
  `?settings=<id>`: the module opens its Settings on it once it has started (`settingsAsked()`).
  In a frame of the split view the view opens it in the frame that shows that module
  (`kit:settings-goto`, `SETTINGS_GOTO_EVENT`; `kit:settings` may now name the section), or the
  window goes there. An app on its own sees no change.
- **Notices answer at every module's path in a host** (`host.js`). With one Settings, Settings ›
  Notices shows in every module, and a module that sends no notices (Next, Notes) had no
  `/<module>/api/push/*` to ask: the host's root answers them there, as it does at `/api/push/*`.
  A host without notices answers them nowhere, as before.
- **The rail's top is the host's mark** (`shell.js`, kit.css). It was a link to the host's page that
  chooses the modules, which only took people out of what they were doing; the modules are chosen
  in Settings › Modules.

## 0.103.0 — 2026-10-20

- **One service worker for a host and its modules** (`createHost({ worker })`, new
  `host-worker.js`; `web/sw-core.js` `modules`; new `web/worker.js`; `web/update.js`). A host with
  `worker` writes its own /sw.js at `/` from the files: its pages, every module's shell (read from
  the module's own public/sw.js) and the kit at every path, and shows every notice as the host's.
  Its /version and /js/app-version.js become the whole app's: the host's version and name with one
  fingerprint of the host's, the kit's and every module's files. A module's page told so by
  /api/auth/config (`app.host.worker`) registers it with the kit's `registerWorker()`, retires
  every module's worker the device still has, and carries their push subscriptions over (the old
  addresses forgotten on the server); where the browser won't subscribe on its own,
  Settings › Notifications asks to turn them on again (`kit.notifications.renew`). `watchUpdates()`
  then asks the host's /version, names the host in the notice (`theirs.name`) and says nothing in
  a frame of the split view; `applyUpdate()` from a frame reloads the view, and waits up to 20 s
  (not 3) for the host's worker, which keeps the whole app, to take over before reloading. A module's notices open
  at its path (`url` under `/<mount>/`, `tag` with the mount, `module`). Settings' About names
  what runs (`Cronum Work v0.3.19`), and `subscribePush()` subscribes with the host's worker; in
  such a host Settings' notifications and the carry-over use the host's /api/push/… at the root
  (`api.root`), which a module without notices of its own (Next, Notes) doesn't have under its path. An app
  on its own, and a host without `worker`, change nothing: `registerWorker()` registers
  `at('/sw.js')` as before.
## 0.102.0 — 2026-10-20

- **Tools announce their hints** (`mcp.js`). A tool may carry `annotations` (`readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`), and `tools/list` announces them with the
  tool's title: `{ title, ...annotations }`. The Claude connectors directory and the ChatGPT App
  Directory require them, and clients use them to decide when to ask the person first. A tool
  without them is announced as before. A host keeps them under its names (`tasks_list_tasks`), and
  an old address under the module's own. Every app writes them the same way (architecture §13):
  reads `{ readOnlyHint: true, openWorldHint: false }`; additive writes `{ readOnlyHint: false,
  destructiveHint: false, idempotentHint: false, openWorldHint: false }`; setting a state or a field
  the same with `idempotentHint: true`; deleting, overwriting for good, moving in bulk or giving
  other people access, `destructiveHint: true`. `openWorldHint` is `true` only for a tool that
  reaches outside the app.
- The host's link tools have theirs (`links.js`): `linked_items` reads, `link_item` adds (it may
  create the thing in another module).
- **The link tools start with the host's id**, as a module's tools start with its own:
  `work_linked_items` and `work_link_item` in Cronum Work (`hostMcp({ hostId })`, the host's
  `app.id`). The bare names are gone, with no hidden alias: a client with the old schema lists the
  tools again. The host's instructions say so ("or with work_ for the ones that link things").
- **No token in the address** (`mcp.js`, `bearerToken`). `/mcp?token=…` is no longer read: an
  address ends up in logs and browser histories. A manual token still goes in `Authorization:
  Bearer` or `X-MCP-Token`; OAuth is untouched.
- **The old addresses' connectors can go before the rest of the bridge** (`LEGACY_MCP`, host.js,
  legacy-domains.js). With `LEGACY_MCP=off` (`on` when empty; anything else stops the start) the
  domains of `LEGACY_DOMAINS` keep their redirects and the service worker that removes itself, and
  `/mcp` there answers 404 with the host's (`{ "error": "not_found", "mcp": "<BASE_URL>/mcp" }`),
  as does their OAuth metadata. `parseLegacyDomains()` reads it (`{ mcp }` in, `mcp` out).

## 0.101.0 — 2026-10-20

- **Signing out clears every app's copy on this device** (`signin.js`, `clearDeviceCopies()`).
  In a host the modules share one origin, and each one now draws itself from what the device
  keeps before the server answers. Signing out in one module, or on the host's home, left the
  others' copies (`<app>-local` in IndexedDB) for whoever signed in next, who would have seen them
  for a moment. `signOut()` now deletes every `*-local` database of the site, without waiting more
  than 1.5 s on a tab that holds one. On its own an app has only its own copy, which it already
  cleared.
- **A module page names the person's answers only to someone signed in** (`page-hints.js`).
  Without a session `/api/auth/me`, a module's `preload` and `/api/modules` were preloaded as 401s,
  and a page that signs in without reloading (local accounts) read those instead of asking again.
  Signed out, the page names only its code, catalogs and `/api/auth/config`.

## 0.98.0 — 2026-10-20

- **Settings at hand in the host's split view** (`base.js`, `shell.js`, `settings.js`). In a frame
  of the split view a module has no rail, and its Settings were only behind its name in the
  sidebar, which a narrow section folds behind ☰. Now the view can open them itself: it asks with
  `kit:settings` (`SETTINGS_EVENT`) on the frame's window, and the module opens its Settings. A
  module's Settings in a frame also say on the view's window when they open and close
  (`kit:settings-shown`, `SETTINGS_SHOWN_EVENT`, `{ open, source }`), so the view can give that
  section the whole space meanwhile. Cronum Work 0.3.14 puts the button at its rail's foot.
  Nothing changes outside a frame.

## 0.97.0 — 2026-10-20

- **Drawing a list again without it moving** (`web/drag.js`, `redrawInPlace(container, draw)`).
  A sidebar or a list drawn again whole keeps how far its box was scrolled (the container, or the
  nearest box above it that scrolls), and while something is carried (`data-kit-dragging`) it
  isn't drawn: it waits for `kit-dragend` and draws once, with the last `draw` asked for. Notes
  0.29.1 did both by hand in its sidebar and Tasks kept the scroll by hand; now every
  app does it with one call, in its sidebar and in its lists. Nothing changes for an app that
  doesn't use it.

## 0.96.1 — 2026-10-20

- **The fade between modules is no longer held** (`shell.js`, kit.css; 0.92.1 undone). Holding
  it until the new module had its frame looked worse with real data: the frame came in with a
  jump, and the data with another. The fade starts again at the new page's first paint, as in
  0.92.0, until each module draws at once from what the device keeps. Nothing changes for an app
  on its own.

## 0.96.0 — 2026-10-20

- **The people one already shares with, as chips in a share dialog** (`web/people.js`; kit.css).
  `peopleChips(people, { onChange })` draws a chip for each person the app says one already shares
  with, under the dialog's email field, so nobody's email has to be remembered: one or several are
  picked (`selected()`, `clear()`, `set()` after a share; `selected: [ids]` picks some from the start; `label` changes what is said above them, `''` leaves it out). `shareWithEach(targets, shareOne)`
  sends one share for each, one after another, and says once how it went: "Shared with 3 people.",
  and "Not shared with …: why" for each one refused, keeping the ones that went. Who those people are is each app's rule;
  an app shares by id only with someone the person already knows. Texts `kit.people.*` in four
  languages; the service worker keeps it. Nothing changes for an app that doesn't use it. Tasks
  1.70.0 and Notes 0.29.0 are the first; Projects and Next can follow with the same two calls.

## 0.95.0 — 2026-10-20

- **A host's split view** (`createHost({ split: '/split/' })`, Cronum Work 0.3.8). A host can
  have a page of its own that shows several modules at once, each in a frame. With it:
  - the rail has a button over Settings whose menu has the views: this module alone (now), two or
    three side by side, or four in a grid (`/split/?layout=2&from=<mount>`); `/api/modules` says
    where the page is (`host.split`);
  - the modules' pages may be framed by the host's own pages (`frame-ancestors 'self'`,
    `X-Frame-Options: SAMEORIGIN`; `createApp({ frames: 'self' })`, `securityHeaders({ frames })`).
    Another site still can't frame them, and the host's own pages are framed by nobody;
  - a module in a frame (`base.js` `FRAMED`) has no rail and doesn't become the module used last;
    its name keeps Settings at hand. Signing in with the provider, signing out, paying and deleting
    one's account take the whole window, not the frame.
  A `split` that isn't a path of the host (`/split/`) stops the start. Without it nothing changes,
  nor for an app on its own.
- **A menu's entry in use** (`ui.js` `menu`, `current: true`): a tick at its end.
- **Icons `layout-1` to `layout-4`**: one module, two or three side by side, four in a grid.
## 0.94.0 — 2026-10-19

- **Settings › Sharing** (`web/shared.js`, `sharedSection()`; kit.css). An app adds one more
  section to Settings and it shows, in one place, everything the person shares —each thing with
  who has it, whether they accepted yet and what they may do— and everything shared with them,
  invitations to answer first. Permissions are changed there (view or edit), sharing is taken back
  from one person there, and what is shared with one is accepted, declined or left there. The app
  says what it shares (`kinds`: Tasks its lists; Notes its groups, notebooks and notes), gives
  `load()` → `{ mine, withMe }` and a function for each change; after every change the page asks
  `load()` again, so it always shows the server's state, also after a refusal. `open(item, { close })`
  gets the close of the Settings it is in (an app's section's `render` now gets `{ close }`), so an
  app needn't keep the handle, which a change of language would replace. On a narrow phone
  each person's choice goes under their name, never off the screen. Its texts are the kit's
  (`kit.shared.*`, four languages); the service worker keeps it (`sw-core.js`). Nothing changes
  for an app that doesn't add it.

## 0.93.0 — 2026-10-19

- **Settings › Modules opens the host too** (Cronum Work). "Home screen icons" offered a button
  for each module, but none for the host, whose page went straight on to a module: on an iPhone
  there was nowhere to add Cronum Work itself from. Its first button is now "Open Cronum Work",
  to the host's page at `/?modules`, which stays put and carries the host's web manifest (Work
  0.3.2); the hint says what each icon opens and how to add one on an iPhone. Nothing changes
  for an app on its own.
- **A banner over a view's head keeps clear of the clock** (kit.css). Where the bar gives way to
  a head (a phone), a banner is the first thing on the screen, but the gap for the status bar
  stayed in the head: in an iPhone's installed app the banner went under the clock and an empty
  gap sat between it and the head. Now the first banner keeps that gap, in its own colour, and
  the head under it doesn't. Without a banner, nothing changes.

## 0.92.1 — 2026-10-19

- **The fade between modules waits for the new one to be drawn** (`shell.js`, `holdPageFade`;
  kit.css). The browser started the 0.92.0 fade at the new page's first paint, when the module
  had drawn little: it faded into a half-empty frame and the rest came in after it, with a jump.
  Now the old page stays still and whole while the new one draws itself, and the fade starts
  once its frame is there and quiet for 60 ms (or 100 ms after the frame came, while the module
  fills it in, and never later than 900 ms from its start). kit.css gives the fade a 400 ms pause
  that the frame ends early, so a page without the kit's frame still fades after it. Measured
  with frame-by-frame comparisons, the switch now goes one way only, from the old page to the
  finished new one, about 0.1 s later than before. Nothing changes for an app on its own.

## 0.92.0 — 2026-10-19

- **From one module to another without an empty screen** (Cronum Work; architecture §21.4). Each
  module's page drew itself one request after another: its code in four or five steps, then the
  catalogs, the settings and the person. Over half a second of empty screen on a computer, a second
  on a phone, and the rail last.
  - **The host names what a module's page will ask for** (`page-hints.js`): a `Link` header with
    the page, every module script its imports reach, `app-version.js`, its catalogs, its
    `/api/auth/config`, who the person is (`/api/auth/me`, or what the module asks first, a new
    optional `createModule().preload` of its own GET paths) and the host's `/api/modules`, so the
    browser asks for them at once. Only the host sends it; nothing changes for an app on its own,
    nor for a module.
  - **Each catalog once per page** (`i18n.js`): the language of last time and the person's, most
    often the same, were two requests. One that failed is asked for again.
  - **The rail of last time with the frame** (`shell.js`, `host.modules` on the device), drawn
    again when the host answers.
  - **A 200 ms crossfade between pages of the site** (`@view-transition` in kit.css), the rail
    standing still; browsers without view transitions keep the cut, and so does whoever asks for
    less motion.

## 0.91.0 — 2026-10-18

- **A host answers the apps' old addresses, for a while** (`legacy-domains.js`, `LEGACY_DOMAINS`):
  when the apps move into one host, their own domains can point at it and keep working. Each
  domain's `/mcp` is the module's connector as the app had it (its tools without the module's
  prefix, its old names, instructions and prompts, its plan rules and the person's modules; the
  calls of the day count with the host's), so a connector added to the app needs nothing. With
  WorkOS, a token there must be for that address (`https://<domain>/mcp`), and its OAuth metadata
  and 401 name it. `/sw.js` there removes itself and opens the module in the host; everything else
  goes to the same path under `/<mount>/` (302, 307 for a write). Empty, nothing of it runs; an
  entry that can't be right stops the start and says why. Architecture §21.2.1.
- **WorkOS: a token can be checked for another audience** (`verifyToken(token, { audience })`,
  `userFromToken(token, { audience })`), and the accounts give the metadata for another address
  (`resourceMetadata(resource, name)`, `authorizationServerMetadata()`). Nothing changes for an app.

## 0.90.1 — 2026-10-18

- **Tests: the stores' customer test no longer fails by chance.** It looked for `ada` anywhere in
  the answer, whose random id is hex and holds "ada" in about one run of 150; it now checks the
  answer's two fields and that neither the email nor the name is in it. Nothing changes for an app.

## 0.90.0 — 2026-10-18

- **A request may give up** (`api.js`, `setPatience(ms)`): with a weak signal (a phone between
  cells, a Wi-Fi with no way out) a request hung for up to a minute before the browser failed it,
  and the screen waited with it. An app that calls `setPatience(ms)` gets `Offline` when a read
  (GET), or a write with an `Idempotency-Key` (the outbox's), takes longer than that, also when the
  answer's body is what is slow. A write without a key and an upload always wait: giving up could
  make something twice or cut a file. Without the call nothing changes.
- **`saveState` has a `local` state** (`ui.js`): kept on this device, its answer slow to come
  (`kit.saveState.local`, in the four languages), for an app that doesn't want to say "Saving…"
  while the network takes its time.

## 0.89.0 — 2026-10-17

- **An assistant can attach a file** (`mcp-files.js`): an MCP tool carries JSON, not files, and an
  assistant writing a photo out as base64 spends its answer on it. A file now reaches the app's own
  save function (Notes' `saveFile`, Tasks' `saveAttachment`, with their checks unchanged) as a
  stream, the same as a request, one of two ways. Nothing changes for an app that doesn't use it.
  - **From a link**: `suite.uploads.fromUrl(url)` → `{ stream, name }` (uploads.js, also `openUrl`).
    Only http and https without a user or password (`file_url`); never from an address inside a
    network (`file_url_private`): every address the name has, and those of each of at most 3
    redirects, checked with the new `isPublicAddress(ip)` (private, loopback, link-local, CGNAT,
    multicast, documentation, unspecified, ULA, and IPv6 forms that carry an IPv4 one judged by it),
    and the connection made to the address checked, so a second lookup (DNS rebinding) can't send it
    elsewhere. 10 s to answer and 60 s in all (`file_url_unreachable`, also for a name that doesn't
    resolve or too many redirects), an answer that isn't 2xx is `file_url_status` with its `status`,
    a Content-Length over the limit is 413 `file_too_large` before reading. What is kept is still
    `store`'s decision, by the first bytes: a page is not a photo. The name is the site's
    (Content-Disposition), else the last part of the path, else `file`.
  - **A one-time upload link**, for an assistant that can run a command (Claude Code):
    `suite.uploadLinks.offer({ userId, name, accept })` → `{ url, expires_at }`, and
    `POST /api/mcp-uploads/:token` (the raw body, the name in `?name=`) hands the request to
    `accept(stream, { name, user })` and answers 201 with what it returns. The token is the only
    credential: kept as a SHA-256, good once, for 15 minutes, for an account that must still be
    there and active when the file arrives, and no session cookie opens or replaces it (the route
    never reads the session, nor the idempotency keys). A missing, expired or used link is 404
    `upload_link_not_found`; a repeated bad one meets the token brake. In memory, at most 100 open
    per app (the oldest go first); a restart forgets them. There with `modules.uploads` and
    `modules.mcp` on; `suite.uploadLinks` is null otherwise. A module of a host has its own, at its
    own address (`<BASE_URL>/<mount>/api/mcp-uploads/…`), as its folder of files is its own.
  - `receiveFile({ suite, userId, url, name, accept })` is the whole of a tool: with `url`, the file
    downloaded and saved → `{ saved }` (what `accept` returned); without it, a link offered →
    `{ link: { url, expires_at }, instructions }`, `instructions` being the sentence for the
    assistant (`uploadLinkText(link)`: the curl command, and asking the person for a public link where
    there is no shell). `FILE_PARAMS` holds the tool's parameters, `file_url` and `file_name`, to
    keep them the same in every app.
  - New error codes, with their sentences in every language: `file_url`, `file_url_private`,
    `file_url_unreachable`, `file_url_status`, `upload_link_not_found`.
- **`store` no longer waits forever for a stream that died before it was read** (a download refused
  while the app still checked permissions): it answers its error, or `upload_cut`. And a file cut
  for being too big leaves no `.partial` behind on Windows, which can't delete a file still open: it
  goes once its stream has closed.
## 0.88.0 — 2026-10-16

- **`shell.destroy()`**: the frame `createShell()` made, taken down for an app that draws it again
  without reloading the page (after a new language or a refresh, or closing its frame).
  Every listener the frame adds, on the document, the window and its own nodes, now shares one
  `AbortController`, and `destroy()` aborts it; the click swallowed for 400 ms after a drag of the
  drawer keeps its line as it was (Tasks' smoke test reads it) and `destroy()` removes it by hand; a
  menu the frame opened closes, and its element leaves the page. A second call does nothing. Until now an old frame kept listening: after one
  rebuild a tap within 20 px of the start edge clicked twice (the drawer opened and closed), it got
  worse with each rebuild, and no old frame was ever freed. Additive: an app that never rebuilds its
  frame changes nothing.
- `menu()` (ui.js): a menu closed in the same turn it opened no longer leaves its outside-click
  listener on the document for good.
- Tests: the fake DOM (`test/fake-dom.js`) keeps listeners as a browser does (`once`, `signal`,
  `removeEventListener`, `listenerCount()`), the document listens too, and elements have enough of
  the DOM (`closest`, `contains`, simple selectors, `dataset`, `toggleAttribute`, `click`…) to build
  a whole frame. `FakeEventTarget` stands for a window.

## 0.86.0 — 2026-10-14

- **Files per note** in the `cronum-work` catalog (`files.per_note`, Notes): 10 in Free, no limit in
  Pro and Team. An app that declares it reads it; the others ignore it.

## 0.85.0 — 2026-10-13

- **A kind of group the app manages itself** (`organizations.kinds` in `suite.config.js`, or
  `createOrganizations({ kinds })`): `{ family: { managed: true, maxPerUser: 1 } }`, each kind with
  `managed`, `maxPerUser` and `onEmpty`, checked on start (an unknown key, a kind's name that isn't
  up to 40 lowercase letters, digits, - and _ starting with a letter (`KIND_NAME`), or a wrong value
  stops it, saying which). Not a data copy's `copyKinds` (portability.js), which lists the kinds a
  copy carries. An app may keep everything per family and have rules of its own: one family per account,
  a profile for each adult. The suite's generic routes knew nothing of them.
  - `managed: true`: `POST /api/orgs` with that kind, `POST /api/orgs/join` with an invitation to
    one (before the invitation is spent) and `DELETE /api/orgs/:id/members/:user` on one answer 403
    `organization_managed` with the `kind` (an outsider still gets 404). The app does them through
    its own routes, with the same functions (`create`, `accept`, `addMember`, `removeMember`,
    `remove`), its own permission checks and the same audit actions. Reading, renaming, inviting and
    changing a role keep the generic routes.
  - `maxPerUser: n`: `create`, `addMember` and `accept` refuse a person one more non-archived group
    of the kind with 409 `organization_limit` (`{ kind, max }`), whoever calls.
  - `onEmpty: 'delete'` (a managed kind's default; `'archive'` for any other, as before): when the
    last member goes, by leaving or being removed (`removeMember`, where the last member may now
    leave even as its owner) or with their account (`forgetUser`), the group is deleted instead of
    archived.
  - `organizations.remove(id, { reason, by })`: a group deleted whole, in one transaction: the app's
    hooks, then its plan grants (which name it by id, with nothing to cascade by), invitations,
    memberships and the row, with an `org.delete` audit entry. `exists(id)`, `wasDeleted(id)`,
    `isManaged(kind)`, `rulesFor(kind)`, `invitationKind(token)`, `deletableOf(userId)` and
    `leaving(id)` are new too.
  - The app's hooks, inside the change's transaction (one that throws undoes it all):
    `whenMemberRemoved({ organization, userId, role, reason, by })`, before a membership goes
    (reason `left`, `removed`, `account_deleted`, or `handed_over` for portability.js's hand-over:
    `MEMBER_REASONS`), `whenMemberAdded({ organization, userId, role, invitedBy })`, and
    `whenDeleted({ organization, reason, by })`, before a group's rows go. Each membership that
    goes is told once: by `whenMemberRemoved`, except those a group still has when it is deleted
    whole, which `whenDeleted` tells. `createSuite({ hooks: { onMemberRemoved,
    onOrganizationDeleted } })` registers them, and so does a module of a host. In a host the kinds
    are the host's: a module that declares one the host doesn't declare the same way stops the
    start.
  - `removeMember(id, userId, { by })` now returns `{ organizationDeleted }`, and it and
    `addMember` run in their own transaction; the generic leave route passes `by` and answers
    `organization_deleted: true` when the group went (its `org.leave` entry then points at no group).
- **Invitations are purged** (`organizations.purge()`, in `suite.purge()` for every app with
  organizations on): those accepted or withdrawn at the next clean-up, and those expired more than
  14 days after they expired. They hold the email they were sent to. The 14 days keep the right
  answer for someone who opens a link late (410 `invitation_expired`, "ask for a new one"), not 404
  "used or withdrawn"; a used or withdrawn one answers 404 either way. No app reads old invitations
  (only an app sold on its own has organizations on).
- **A group's subscriptions stop renewing when it goes.** `billing.stopOnOrganizationDeleted: true`:
  a group deleted (above, or by the app) has its live subscriptions (`active`, `trialing`,
  `past_due`) at the provider cancelled at the end of the period paid. `billing.stopOrganization(id,
  { by })` does the same for a group that stays (an app's "delete the family" with a grace),
  `billing.keepOrganization(id, { by })` takes it back. Off by default: today's installs ask their
  provider nothing new.
  - Each stop is asked once: a row of `billing_events` of its own (`stop:organization:<id>:<ref>`,
    type `stop`): `pending` (marked inside the deletion's transaction, so a deletion undone leaves
    none), `sending` (taken by a sweep asking now, so two sweeps never ask twice; one whose sweep
    never said how it went is taken again after 15 minutes), `requested` (the provider took it),
    `already` (the provider had it already: the payer's own cancellation), `ended` (the
    subscription ended first), `keeping` (being taken back), `restop` (wanted stopped again while
    being taken back, here or in another process: asked again only once that taking back has
    landed, or after 15 minutes if its process ended), `rekeep` (taken back and refused: asked
    again) and `keep` (taken back while another process was asking it). An hourly `billing.sendStops()` (createApp and the host)
    asks again what failed. One group's stops and their taking back go to the provider one at a
    time in this process, in the order they came: a keep waits for a stop on its way, and a stop
    for a keep.
  - Who wants each group stopped is kept (`stop-by:<who>:organization:<id>`, type `stop-by`: `app`
    by default, `members` for createSuite's below). Taking it back renews it only when nobody else
    still wants it stopped, so a member taking their account back never renews a family the app
    stopped. `billing.stopOriginsOf(id)` says who.
  - Taking a stop back never renews a cancellation the payer made themselves (`already`); a stop
    on its way is taken back once it lands, never lost under the sweep; and a stop that comes
    while a keep is on its way is asked once the keep lands, never dropped by it.
  - A subscription heard of only after its group was deleted here (its first webhook came late) is
    stopped by the sweep too (`createBilling({ organizationWasDeleted })`): only for this catalog's
    product and an id this install gave out, never another product's sale.
  - On every deletion, the group's customer link goes, whatever `billing.forgetOnRemove` says: it
    names nobody now, and the customer is whoever's it pays for next. With `forgetOnRemove`, its
    subscription rows go too, as a person's do. Each is audited (`billing.organization.stop`,
    `billing.organization.keep`).
- **A family whose every adult asks to delete their account stops renewing then**, not 30 days later
  when the last account goes (with `billing.stopOnOrganizationDeleted`): a group of a kind deleted
  when empty whose members are all waiting to be deleted (`organizations.leaving(id)`) stops as
  `members`, so no renewal falls in the wait. It is checked again whenever that may change (a
  request or its taking back, someone joining or leaving): it renews again as soon as one of them
  takes their account back or someone who stays joins, and a member who leaves only those waiting
  behind stops it then. The final deletion finds the stop already asked and asks none more. Through new hooks of the account deletion: `deletion.whenRequested(hook)` and
  `whenCancelled(hook)` (createSuite's `onDeletionRequested(user)` and `onDeletionCancelled(user)`
  for an app, and a host's modules'), awaited after the request or its taking back; one that fails
  is logged and never undoes it.
- **A group's purchase goes to the group, and a person's to the person, whatever customer pays.**
  One provider customer often pays a person's own plan and their family's, and a family after
  another (Paddle finds the customer by email), and it is linked here to one of them only: before,
  whichever was linked first took the others' purchases too (the family's plan granted to the
  adult, the adult's to the family, or a new family's to the one before). Now an event whose
  `subject` names an organization, or whose product is `for: 'organization'`, is the group's: the
  group its subscription is already known for here, while that group is (what a copy of the install
  carries with the groups' new ids, where the id the checkout named may be another group's); else
  the group it names; else, when it names none, the group the customer is linked to while that
  group is here. No identity is looked up for it, and a customer linked to a group never takes a
  person's purchase. A link to a group deleted here is taken by whoever the customer pays for next. A
  group's product that names no group and whose customer is a person's is ignored, never the
  person's. Everything else is found as before.
- **An event for a group no longer here is `'gone'`** (`createBilling({ organizationGone })`, set by
  createSuite with organizations on): nothing is linked, granted or kept beyond its id, and a
  subscription row still kept follows its status (a product with `seats: false` keeps no
  quantity). Before, such an event failed at the audit's reference to the group: the webhook
  answered 500 and the provider retried it until it gave up. Only events naming a group that
  doesn't exist here change.
- **Taking an account back no longer renews a cancellation the person made themselves.** With
  `accounts.deleteAtProviders`, asking to delete an account stops the person's own subscriptions and
  taking it back renewed every live one, a cancellation they had scheduled in the portal included:
  charged again against their own word. Each stop is now noted (`stop:user:<id>:<ref>`:
  `requested`, `already` or `failed`), and `keepRenewals` renews only what this install stopped. A
  request made before 0.85.0 noted nothing, and is taken back as then.
- **Paddle's and Stripe's `cancelSubscription` answer `{ already }`.** Paddle refuses a second
  cancellation while one is scheduled (`subscription_locked_pending_changes`) and any change to one
  already canceled; the subscription is then read, and one canceled (or, at the period's end,
  scheduled to cancel) counts as `already`. Before, `stopRenewals` failed for someone who had
  cancelled in the portal.
- **Stripe can stop a subscription** (`cancelSubscription(ref, { now })`: read first, then
  `cancel_at_period_end`, or deleted now; `keepSubscription(ref)`), as Paddle could. This also
  reaches the account deletion with `accounts.deleteAtProviders` on Stripe, which skipped Stripe
  until now; no install runs Stripe.
- `errors.organization_managed`, `errors.organization_limit` and the activity log's
  `org.delete`, `billing.organization.stop` and `billing.organization.keep`, in the four languages.
- **With organization copies (0.84.0):**
  - `organizations.handOver()` (an import that replaces what someone has) runs in one
    transaction and tells the app once, as any member who goes: `whenMemberRemoved` with reason
    `handed_over`, before the membership goes; a hook that throws undoes the hand-over.
  - **The declaration's `organizations.leave` is gone**: it told the app a second time of the same
    hand-over. A declaration that still says it stops the start, naming the hook that replaces it.
    No app declares it (it was 0.84.0's alone).
  - `forgetUser` and an imported group whose owners were left out name their heir by the one rule,
    `heirOf()`. One `KIND_NAME`, for the configuration's kinds, `create()` and the copies.
  - A membership a copy brings meets `maxPerUser` (`organizations.checkLimit()`, new): past it, the
    import is refused with 409 `organization_limit`, and nothing of it comes in. An archived group
    counts for nobody. Nothing of a copy deletes a group; one that has to go goes through
    `organizations.remove()`.
- No migration and no table. `organizations.<key> is not a setting` now lists `kinds`.

## 0.84.0 — 2026-10-13

- **An organization and its data travel with its members and with the install**
  (`portability.js`, for an app's families or teams). Until now a copy followed accounts
  only: every declared table had to chain to `users`, nothing could point at `organizations`, and
  no copy carried a group, its members, its invitations, its plans or who pays for it. So another
  adult's "Download my data" left the family out, and a whole install's move lost the family's
  name, its second owners, the invitations waiting, its trial or Pro and its Paddle customer and
  subscription, whose renewals then found nobody. Now, behind options that didn't exist:
  - **A group's tables**: a reference to `organizations` (`refs: { organization_id:
    'organizations' }`) decides whose a row is as one to `users` does, and the tables that chain to
    it are the group's too. A table needs a NOT NULL reference to users, to organizations or to an
    earlier table.
  - **`organizations` in the declaration** (each key may be left out; `{}` alone carries the groups
    in the install's copy of an app without tables of its own for them): `copyKinds` (whose groups
    someone's copy takes; every kind; a kind written as organizations.js writes them, `KIND_NAME`),
    `copyRoles` (which members' copies carry the group; every
    member, since a member reads what the group shares; an app can name `['owner', 'admin']`;
    checked against the install's `organizations.roles`, so a misspelt role stops the start instead
    of carrying the group in nobody's copy), `mapOntoOwn` (kinds, or `true`: someone's import goes
    into the oldest group of that kind they own or administer here) and `leave(userId,
    organizationId)` (the app's part when "replace" takes someone out of a group others share). It
    needs `modules.organizations`, said with the declaration's other mistakes at the start; the
    suite's own `organizations`, `memberships` and `invitations` can't be declared as the app's
    tables, nor named in `was`.
  - **A group's one row** (`onePerOrganization: true` on a table whose NOT NULL reference to
    organizations is UNIQUE, such as a family's row): when the group a row goes into has its row
    already, the copy's is that row and isn't written again; what points at it comes into it, and
    the result counts it under `merged`. Someone's copy put into their own family, the usual
    case, no longer meets the UNIQUE.
  - **Someone's copy** takes each of their groups, archived ones too, marked so:
    `data/organizations.json` (name, kind, slug, settings, branding, dates), their own row of
    `data/memberships.json` (never the others') and every row of the group, other members' optional
    references emptied and rows that need another member left out and counted in `left_out`. No
    plan, invitation or payment, and nothing that says which install it is.
  - **The whole install's copy** takes every group (archived too), every membership, the
    invitations still waiting (`suite/invitations.json`, by their hash: the links people hold still
    open the group after the move; used, revoked and expired ones stay), the groups' grants in
    `suite/grants.json` and their customers and subscriptions in `suite/billing.json`, each row
    with `subject_type: 'organization'` (a row without it is an account's, as every copy before).
    Its manifest says which install it is (`source.install`, a random id kept in `app_meta` as
    `suite.install_id`, made the first time) and which export run (`source.export`, one random id
    per run; a host's other modules exported in the same run share it: `prepareExport({ run })`,
    whose job says its `run`, the admin export's `?run=`, the command line's `--run`).
  - **Importing someone's copy**: each group goes into the oldest one of its kind they own or
    administer here when `mapOntoOwn` says so (one group of the copy each, never an archived one),
    else into a new one, with them as its owner, made quietly as imported accounts are (no app
    welcome, no trial), with a slug made from its name and today's date: neither the copy's slug
    nor its date, which anyone can write. Ids are new; a group's id in the file never reaches one
    here. `clean(values, { mode, organizations })` and `check({ user, counts, replaced,
    organizations })` get the same `{ created, mapped }`: Sets of the ids here of the groups made
    and of those found. At most 100 groups in one person's copy (`limits.organizations`).
  - **Importing a whole install** restores each group as it was —slug when free, kind, settings,
    branding, dates, archived—, its memberships and roles (one this install lacks becomes
    `member`), its invitations, grants and payments under its new id: a renewal that names the old
    id finds the family by its customer. Each group it makes is recorded with where it came from
    (`app_meta`: `suite.organization_origin:<install>:<id there>`, with the run), and which run of
    that install came (`suite.install_import:<install>`). **An install comes here by one export
    run**: the other modules' copies of that run (a host moving one module at a time) find its
    groups by that record alone and bring only their own rows, never members, invitations, plans
    or payments, which came with the first copy, nor the accounts' plans and payments; what such a
    copy is the first to bring (an account the first left out, a group only it had) comes whole,
    with its plans, payers and memberships. The run is checked again inside the import's
    transaction, where the run it records is written, so of two imports racing (two modules, the
    command line) the second follows or is refused. A whole install's copy with groups that doesn't
    name its install is refused, 400 `import_install_unnamed`. A copy of
    another run of an install already brought here is refused before anything is written, 409
    `import_install_again` (in the four languages; the command line says what to do), in the plan
    and on apply: a later copy merged into what an earlier one made would bring back a member
    taken out since, a plan revoked since, and take a file's word for a plan's end. Moving again
    (a trial move, then the real one) is moving into a fresh install. A slug, kind and date like a
    group's here find nothing, so neither someone's own copy imported earlier nor a look-alike copy
    can set up or reach a group a move goes into; only a whole install's copy, the
    administrator's, names its install. A group whose every member is left out goes with them; one
    whose owners are left out gets its heir as owner, by `organizations.heirOf`.
  - **"Replace" and erasing one's data** empty what is the person's alone: their rows and those of
    groups nobody else is in, archived too, whose organization and plan stay. A group they share is
    never emptied: "replace" hands it over first (the app's `leave`, then the new
    `organizations.handOver(organizationId, userId)`: the heir becomes owner when they were the
    last, and their membership goes), and erasing leaves it whole with them in it. The plan names
    those groups (`hand_over`) and the result says what happened (`handed_over`).
  - **Someone's own "replace" goes only with the groups it showed**: `POST /api/me/import/:id`
    with `replace: true` takes back the ids of the plan's `hand_over` (`hand_over: [ids]`); while
    the groups the person shares aren't those —one shared since, or one the others left, which
    would be emptied instead— it answers 409 `import_hand_over` with them as they are now
    (`organizations: [{ id, name }]`), checked again inside the import's transaction; the upload
    waits, to be applied once confirmed. Settings › Your data names the groups under the choice,
    again in the confirmation (`kit.data.handOver`, in the four languages), offers "replace" to
    someone who has only shared groups, and sends their ids once the person confirms (an app whose
    copies carry no groups sends what it always did). The command line and `applyFile()` go on as
    told.
  - **The administrator's "replace" says which groups it hands over**: the install plan's
    `targets[].hand_over`, named by the admin panel under the choice and in its confirmation
    (`admin.data.handOver`, `admin.data.confirmHandOver`).
  - The plan and the result list each group and where it goes (`organizations`), and the command
    line (`tools/data-cli.js`) shows them.
- **Columns that never travel** (`omit` on a declared table): `omit: ['token_hash', 'push_endpoint']`
  leaves them out of every copy, and an import writes the column's default or NULL; `omit: {
  token_hash: (row) => … }` gives a plain value or a function of the row (its references already
  translated) instead. `null` there, and a function that answers `undefined` or `null`, mean the
  column's own default, so an app's slip isn't taken for a fault in the copy. One a copy brings
  anyway is dropped. The start refuses an omitted column that is NOT NULL without a default of
  either kind, a reference, a file's column or the key. A column the app keeps itself, such as
  an app's `owner_user_id` (the family's oldest owner), can be left undeclared as a reference and
  filled by such a function.
- **An account waiting to be deleted goes on waiting after a whole install's move**: the copy
  carries `delete_after`, and an account it creates takes it back with `disabled_at`, so the sweep
  takes it on the same day with its data. Only a disabled one: a date alone, in a file anyone could
  write, never sends an active account to the sweep. Before, it arrived disabled for good, with
  everything it had.
- **A kind is written by one rule** (`KIND_NAME`): `organizations.create`, and so `POST /api/orgs`,
  refuses another with 400 `field_invalid` (`field: 'kind'`, `fields.kind` in the four languages);
  a copy's group with a kind written otherwise (made before the rule) comes in with none, never
  made into another valid kind ("Family" isn't `family`) and never refusing the whole copy.
- **One heir rule** (`organizations.heirOf(organizationId, exceptUserId)`): the oldest admin, else
  the oldest member, those whose seat a role change would move last (`seatRoles`). forgetUser, the
  new `handOver` and an import's group without owners all use it.
- `organizations.roles` (every role, the app's own included), `slugOf` and `KIND_NAME` (how a kind is written, the one rule for every kind's name) from `organizations.js`;
  `describeData(database, declaration, { organizationRoles })` checks `copyRoles` and the module.
- `errors.import_hand_over`, `errors.import_install_again`, `errors.import_install_unnamed`, `kit.data.handOver`, `admin.data.handOver`, `admin.data.confirmHandOver` and `fields.kind` in the four languages.
- Apart from `delete_after`, nothing changes with today's declarations: no organization travels,
  no install id is made, and a copy that has organizations is refused as `unknown_table`, as an
  older core refuses it. No migration: the install's id and where each imported group came from
  are kept in `app_meta`.

## 0.83.0 — 2026-10-13

- **No more "null" under a copy's plan in Settings → Your data.** Checking a copy drew its plan
  with the browser's own `append`, which writes a line left out as the text "null": a copy not
  brought in yet (the usual case) showed "null" under what it brings, twice when the account had
  nothing of its own to replace (every app with
  `modules.data`). It now uses the kit's `append()` (dom.js), as `openDialog()` does since 0.75.0:
  only the lines that apply, nothing in place of the others.
- The same cause, fixed in two more places: setting up two-step sign-in without a QR code (an
  address too long for one) showed "nullnull" above the key, and the admin panel's Invitations
  tab showed "null" under its lead on every install with mail on.
- Tests: Settings opened at Your data and at two-step sign-in on the fake DOM, and the admin
  panel's first test (`test/web-admin.test.js`, a file of its own: admin.js starts the page as it
  is imported). Fake elements take `focus()`.

## 0.82.0 — 2026-10-13

- **A family's plan has no seats** (`products.<key>.seats: false`, only for a product
  `for: 'organization'`). Before, a group's purchase always sold seats: Paddle's and Stripe's
  checkouts buy one of the price (`quantity: 1`), every subscription event says it again, billing
  wrote it on the organization's grant, and organizations.js reads a grant's quantity as seats. A
  family that bought Pro was full at once: the next adult was refused with `402 seats_full`, by
  `addMember()` and by an invitation. With `seats: false`, billing.js drops the quantity a provider
  reports for that product, from any provider (Paddle, Stripe, the signed one) and on every event:
  bought, renewed, changed, cancelled at the period's end, and a one-off purchase. Neither the
  subscription's row nor the grant has a quantity, so `seatsOf()` says no cap. The checkout is the
  same (Paddle and Stripe still sell one of the price). A group's subscription bought before the
  option has its grant replaced by one without a quantity at its next event (`'changed'`); a
  one-off purchase made before it keeps its quantity, since nothing comes after it (no install
  sells a group's product yet).
- `seats` is checked on start by config.js, with or without a provider, and by `createBilling()`
  (`productSeatsProblem()`, exported): on a person's product (most likely a misspelt `for`, which
  would sell the family's plan to one person), a value that is not `true` or `false`, or a key like
  it (`seat`), stops the start, naming the product. Left out, a group's product sells seats as
  before, and nothing changes for any product today.
- **An organization's own plan**: `entitlements.ofOrganization(id)`, for what acts for a group with
  nobody behind it (a device paired to the group, a family's hourly sweep). The same shape as
  `of()` (`{ plan: { id, name }, ends, features, unlimited: false }`), from the organization's active
  grants only: never a member's own grants nor the instance admin's "no limits", and never
  `of(null)`'s declared defaults, which are no limit at all. An expiring grant (the trial) counts
  until its end, which `ends` says. With no grant, the default plan; so is an id that is no
  organization, or one that is gone or archived, whatever grants it kept: never an error, so a sweep
  over every family goes on past one that went, and never more than a family of its own would have.
  `entitlements.cutoffOrganization(id, key)` is `cutoff()` by that plan: the days count from the end
  of the group's last grant that kept things longer. Both are on `suite.entitlements`, and on each
  module's in a host. `createEntitlements({ organizationExists })` (new) says which groups are there;
  createSuite and createHost give it from organizations.js; left out, every id's grants count.
  `of(person, { organizationId })` is unchanged.
- **`ends` is when the shown plan lapses, not when its last grant does.** `of()` took `ends` from the
  last grant (by id) of the plan it shows: a person with Pro for good who then joined a family on a
  trial of Pro read "Pro until" the trial's end in Settings, and an app's last-days notice would have
  shown although Pro never lapses for them. Now, among the active grants of the shown plan, one
  without an end wins, else the latest end. `ofOrganization()` follows the same rule.
- **Next to `organizations.seatRoles`** (0.79.0): `seatRoles` says which roles take a seat, and a
  purchase with `seats: false` leaves no seats to take, so members join in any role, a seat role
  included, by `addMember()`, an invitation or `setRole()`. A product with seats still caps only
  the members in those roles. A grant without a quantity sets no seats, like an admin's gift of the
  plan: a group that also holds a grant with a quantity (seats bought with another product) is
  capped by it, as before.
- Nothing else changes: no migration, no route, and `organizations.js` is untouched (it reads seats
  from `seatsOf()` as before).

## 0.81.0 — 2026-10-13

- **An app can push to its own devices, with no user behind them.** A device that belongs to the
  app (a tablet paired to a profile with no account; a kiosk) had no way in: every
  row of `push_subscriptions` is a person's, and `/api/push/*` needs a session. Now the app keeps
  the browser's subscription in its own table, next to the rest it knows of the device, and the
  suite does the rest with the same keys, encryption and VAPID signature as a person's:
  - `suite.push.checkSubscription(json)` (also `checkSubscription` from `push.js`): what the
    device posted, as `subscription.toJSON()` gives it (`{ endpoint, keys: { p256dh, auth } }`; the
    flat `{ endpoint, p256dh, auth }` of a row is taken too), checked as `subscribe()` checks a
    person's: an endpoint of a real push service (on 443, no IP literal nor home-network name),
    an uncompressed point on the curve (0x04 and 65 bytes) and a 16-byte secret. → `{ endpoint,
    keys: { p256dh, auth } }`, what to keep, the keys written again in plain base64url. Otherwise
    a coded 400: `field_required` for a missing subscription or endpoint, `field_invalid` with
    `field` `subscription`, `endpoint` (with its `reason`), `p256dh` or `auth` for one that is
    there but wrong, `field_too_long` for an endpoint over 1000 characters.
  - `suite.push.sendToSubscription(subscription, payload, { ttl, urgency, topic })` → `{ ok,
    status, gone, reason? }`. Only `gone` (the push service answered 404 or 410, or the keys can't
    be encrypted for) says the browser no longer has it: the app drops it. Any other failure keeps
    it, with its `status` for the log; a 4xx can be ours rather than the device's (a 403 when the
    install's VAPID keys aren't the ones it subscribed with). The endpoint is checked again before
    sending, so a row kept without checking never makes the server visit an address inside the
    network; what isn't a subscription is refused with the same coded 400 and nothing is sent.
    Nothing is written in the suite's tables.
  - `suite.push.publicKey`, as before: the key the device subscribes with, which the app hands it
    its own way (its pairing answer, say).
  - `topic` (new for `send()`, `deliver()` and `sendTo()` too, off unless given): the `Topic`
    header of RFC 8030, 1 to 32 characters of the URL-safe base64 alphabet; a push service keeps
    only the newest undelivered notice of a topic, so a launch sent again replaces the one still
    waiting. One written wrong is the app's mistake: a `TypeError`, from `deliver()` and `sendTo()`
    once, before anything is sent.
- **A notice longer than a push service takes is refused before it is sent** (`MAX_PAYLOAD`, 3993
  bytes of JSON or text: the 4096-byte body of RFC 8030 less our header, the record's end and the
  GCM tag): `send()` and `sendToSubscription()` reject with a `TypeError`, and `deliver()` counts it
  as failed. Before, it went out, came back 413 and was counted against the device, which a
  person lost after three; now nobody loses a device for it.
- **`subscribe()` checks a browser's keys as a browser makes them**: a p256dh that doesn't start
  with 0x04 and a secret that isn't 16 bytes (8 or more was enough) are refused with the same
  `field_invalid`, and both are stored in plain base64url (the decoder skipped stray characters
  and kept them). Every browser sends exactly these, and rows stored before are sent as they were.
- **The kit's `push.js`** (new, in the service worker's kit files):
  `devicePushSubscription(publicKey, { ask, wait })` asks for permission first —before anything
  is awaited, so the tap still counts for Safari—, waits for the page's service worker (10 s),
  subscribes with the install's key (reusing the browser's subscription while it is for that key,
  replacing one made with another) and returns the JSON for the app to post to its own route; it
  asks nothing of the server. It throws `Error('unsupported')` (also with no service worker),
  `'install'`, `'not_allowed'` or `'subscribe_failed'` (with the browser's error as `cause`), and a
  `TypeError` for a key that isn't one. `pushSupport()` says `'granted'`, `'prompt'`, `'denied'`,
  `'install'` (an iPhone or iPad tab from iOS 16.4: Web Push only reaches the app on the home
  screen) or `'unsupported'` (iOS before 16.4 too) before anything is asked. Settings'
  `subscribePush()` is unchanged.
- `fields.subscription` in the four languages, for the new refusals.
- No migration and no table. Needs `modules.push`, as the rest of push.

## 0.79.0 — 2026-10-13

- **A catalog for an app whose organization pays per seat** (`plans.js`; named `cronum-per-seat`
  since 0.317.0): a product of its own, whose installs name this catalog, so none of its plans
  gives anything in Cronum Work and no Cronum Work plan gives anything in that app (an app that
  declares a key the named catalog lacks doesn't start). Three plans, from the least to the most a
  person gets: `free` (Free), `org` (an organization's, shown as Team since 0.317.0) and `pro`
  (Pro), with the keys `mcp` (off in all three), `capture.native` (Free and `org` `false`, Pro
  `true`), `links.max` (0, 0, 1), `track.days` (1, 1, 30) and `viewers.max` (0, 0, 30). An
  organization's plan reaches every member, its admins and viewers too, so `org` carries Free's
  values and sits before Pro: someone with both is shown Pro. What an organization pays for, per
  seat, sits on what it owns, and the app checks it against the organization's grant and its
  seats. The prices stay with the provider and the stores. `cronum-work` is unchanged.
- **Seats by role** (`organizations.seatRoles` in `suite.config.js`, `createOrganizations({
  seatRoles })`): the roles that take a seat a subscription pays for, some of
  `organizations.roles` (say, `agent`, while admins and viewers are free). Then only
  members in those roles count against a grant's `quantity`: joining in one of them, by an
  invitation or `addMember()`, and a role change into one (`setRole()`) need a free seat, or
  402 `seats_full`; joining in another role never does. Fewer seats bought takes nobody's away.
  `seatsTaken(id)` and `takesSeat(role)` say how many are used and which roles count. Left out,
  every member takes a seat, as before, and a role change takes none. A `seatRoles` that is empty
  or names a role the group doesn't have stops the start. When the last owner's account goes, the
  group passes to someone outside those roles first (its oldest admin, then its oldest member): a
  membership has one role, so an agent inherits it, and stops taking a seat, only when nobody else
  is left. Without `seatRoles` the order is the same as before.
- **`organizations` in `suite.config.js` takes only `roles`, `invitationDays` and `seatRoles`.**
  Any other key stops the start, saying which, so a misspelt `seatRole` can't quietly put every
  member in a seat.

## 0.78.0 — 2026-10-13

- **Purchases in the App Store and Google Play, next to the web's** (`stores.js`, `revenuecat.js`;
  `STORE_BILLING=revenuecat`, with `modules.billing` on, off by default). A second instance of
  billing on the same tables, under its own provider id (`revenuecat`): each event applied once and
  in order, `billing.ignoreUnknownProducts` applying, and the account's plan the grants of both
  (`/api/me/entitlements`). It runs with or without `BILLING_PROVIDER`.
  - suite.config.js `stores: { products, devices }`: each product a plan of the catalog with its
    store ids, `{ plan: 'pro', kind: 'subscription', appStore: 'com.example.app.pro.monthly',
    playStore: 'app_pro:monthly' }` (Google's as `subscription:base-plan`); keys of their own, not
    the web's; no `for` (people buy for themselves; groups buy on the web). `devices: true`
    (needs `modules.devices`): the store routes and the overview also take the app's device token,
    the only core routes that do. Every mistake stops the start: an unknown key or field, a store
    id given twice or malformed.
  - Who buys: `GET /api/billing/stores/customer` → `{ provider, customer }`, an opaque random UUID
    per account and install, kept in `billing_customers`, for the app to hand to RevenueCat as its
    App User ID. Never the WorkOS id, an email or the account's number. Also what StoreKit takes as
    `appAccountToken` and Google Play as `obfuscatedAccountId`. Set RevenueCat's restore behaviour
    to "Keep with original App User ID".
  - `POST /api/billing/revenuecat/webhook` (an address registered in RevenueCat's dashboard, kept
    once live, CONVENTIONS §9): checked by the Authorization header value set in RevenueCat
    (`REVENUECAT_WEBHOOK_AUTH`, 16 characters or more) and, with `REVENUECAT_WEBHOOK_SECRET`, by
    `X-RevenueCat-Webhook-Signature` too. Only a trigger: each of this install's customers it names
    (the buyer, its aliases, both sides of a TRANSFER) is read again with `GET /v1/subscribers/{id}`
    and the project's secret key (`REVENUECAT_API_KEY`, sk_…), and what RevenueCat holds is
    applied. Nobody else is looked up (that call makes a customer of any id). RevenueCat down or
    refusing answers 502, so it sends the webhook again; the log names the status and code, never
    the customer. `REVENUECAT_API_BASE` only points tests at a stand-in.
  - `POST /api/billing/stores/sync`: the same reading after a purchase or a restore, for the
    account that asks (one at a time, at most every three seconds, else 429 `too_many_attempts`);
    nothing is asked for an account that never had a customer.
  - A reading is applied as one (billing.js `apply(event, { reading: true })`): what it says that
    is already here is `'unchanged'` and leaves no `billing_events` row and no audit (only the
    subscription's last-known time moves on), and a stale one leaves none either, so syncing or
    hearing the webhook again and again grows no table.
  - What a subscription becomes: active (trialing in a trial) until its paid date or the end of
    the store's grace period after a failed charge; past it, paused (Google Play), past_due while
    the store retries (nothing changes; the grant lapses on its own) or ended (EXPIRATION, or not
    renewed). Refunded after its last purchase, or cancelled by customer support for that same
    transaction: a refund, whose period gives nothing again unless REFUND_REVERSED (events gain
    `refundReversed`, which billing.js honours); cancelled by customer support for another
    transaction (an older renewal): the period paid now stays. One-off purchases are RevenueCat's
    non-subscriptions for products of kind `once`, refunded when they leave the list or when
    customer support refunds their transaction. What the install holds that the customer no longer
    has (moved by a TRANSFER, a refunded one-off) is taken back.
  - Notes, for what a later reading can't see at the store again: a `refunded_at` the store took
    back or that was an older renewal's no longer takes the period back, and a one-off refunded
    while still listed stays refunded until a REFUND_REVERSED of its transaction. Kept as rows of
    `billing_events` of their own (`note:…`, type and outcome `note`; refs and times only), so no
    migration; no delivery can write one, since a webhook's id takes only letters, digits, `-`, `_`
    and `.` (any other is replaced by its digest). Unverified until the stores' sandbox tests, and
    handled either way: whether RevenueCat clears `refunded_at` on a reversal, whether it removes a
    refunded one-off, and that `refunded_at` and `store_transaction_id` are the latest purchase's.
  - Another product's sales: a webhook for another store (Stripe, Paddle, promotional), for a
    product `stores.products` doesn't name, or from the sandbox with `REVENUECAT_SANDBOX=off`, is
    foreign, and nobody is looked up; one for a customer this install never gave out is
    `ignored`. Test purchases count by default (App Review buys in the sandbox), marked in the ref
    (`app_store-sandbox:…`) and in the overview. A subscription to this app's store product on a
    base plan no product lists is said in the log and grants nothing.
  - Refs: the store, the store's product id and a digest of the customer
    (`app_store:com.example.app.pro.monthly:3f…`), the same from the webhook and from the sync:
    RevenueCat's v1 API names no original transaction. Kept once live, with the provider id: an
    adapter that replaces RevenueCat's (Apple's or Google's own server APIs) keeps the id
    `revenuecat` and these refs, or comes with a migration of `billing_customers`,
    `billing_subscriptions` and the grants, or everyone gets a new customer that no longer matches
    the `appAccountToken` of what they bought.
- **Several providers in one install.** `GET /api/billing/overview` (with the stores on): the
  person's plan and every source of it, and how to manage each — the web's subscriptions (the
  portal, theirs or a group's they administer), the stores' (only in the store), a group's plan
  that covers them and the admin's gifts; never a ref, a customer or a price id. What the app reads
  before it sells in the store, since no server can refuse a store's sale. The other way round,
  `createBilling({ otherProviders })` (set by `createSuite` with the stores on): the web's checkout
  answers 409 `already_subscribed` to a person with a live store subscription; a group's checkout
  is unaffected. `combinedBilling([billing, stores])` hands both to the account deletion: each
  asked even if the other fails, and a store stops nothing (the person cancels there).
  `/api/billing/webhook` is unchanged. `/api/auth/config` says `app.modules.stores: true` only
  with the stores on.
- **`billing.forgetOnRemove`** (suite.config.js, off by default): an account that goes takes with
  it, in each billing instance, its customer link, its subscriptions, its grants (revoked) and what
  waited under its identity in `billing_pending`; `forget(userId)` on each instance does it and
  says how many of each. A renewal that still comes is then nobody's account here: one that names
  only the old customer (a store's) is ignored; one that names the person's identity (Paddle's, by
  the WorkOS id) waits, as for anyone without an account here, and goes to an account opened again
  with that login, who still pays for it. Nothing is asked of the providers or of the identity
  provider, whose login other apps share, and a group's subscription stays.
- Nothing changes for an app that sets neither `STORE_BILLING` nor `billing.forgetOnRemove`: no
  route, no field, no migration (`config.billing` keeps its shape; `config.stores` and
  `install.stores` are new, empty and null; `apply()` without `reading` and the checkout without
  `otherProviders` are as before).

## 0.77.0 — 2026-10-13

- **Settings' plan section sells, where the app asks** (`web/plan.js`, served at `/suite/plan.js`
  and cached by `sw-core.js`). With `openSettings({ plan: { billing: true } })`, on a server whose
  `/api/auth/config` doesn't say `modules.billing: false`, the section adds to the plan and until
  when, from the suite's billing routes and with nothing of one app or provider in it:
  - **what can be bought** (`GET /api/billing/products`): the products for one person whose plan
    is above theirs in the catalog's order, or theirs again when it lapses on a date, and nothing
    to an admin. Each by its `name` (a catalog key or the name itself) or its plan's, with its
    kind of payment ("Monthly subscription", "Yearly subscription", from the `…-monthly` and
    `…-yearly` keys; "One payment, for 30 days"; "One payment, for good") and "Founder's price"
    where the server says the person gets it. The browser names the product only: the price stays
    the server's choice. Each "Upgrade" button is named for a screen reader by its product and
    kind ("Upgrade: Pro (Monthly subscription)");
  - **Upgrade**: `POST /api/billing/checkout`, then the browser follows the `url` (http or https
    only). A 409 `already_subscribed` says so with "Manage subscription" in the notice, and the
    section is read again;
  - **the subscriptions that hold a plan** (`GET /api/billing/subscriptions`: active, trial,
    payment pending) with the end of their period, and what to do about a pending payment. They
    decide first: while one is live nothing is offered, not even a one-off pass for the same plan
    (the server's 409 guards subscriptions only), and nothing is offered either when the list
    doesn't come, since a subscription's plan lapses on a date too, its period's end. Beside a
    live subscription that holds the plan shown, the plan's "Until" (the period's end and the
    grace after it) gives way to the subscription's own "Current period until";
  - **Manage subscription**: `POST /api/billing/portal`, followed the same way, the primary button
    under a subscription; without one now, "Payments and invoices" (the same portal), last and
    quiet, when there was a subscription before or the catalog sells one-off payments. A 404
    `no_customer` says there is nothing to manage yet and takes the button away, until a
    subscription shows up while the section is open;
  - **`hideCheckout: true`** for a native app's web view (the stores' rules keep a web payment's
    links out of an app): the subscriptions still show, without products, Upgrade, the portal or
    the founder's price.
  Inside a Settings that sells, a 402 met in any section offers a way to buy: `plan.open` when the
  app gives one (a native app's store), or else the plan section, but never under `hideCheckout`,
  where that section sells nothing; there the notice only says why. A plan read late never paints
  over a newer one.
- **A group's products are not offered here yet** (`for: 'organization'`): buying for a group
  needs its seats in the checkout and the group's subscriptions, which the routes don't give the
  browser today (`GET /api/billing/subscriptions` lists a person's). An app that sells to groups
  keeps its own page for now.
- **A plan's barrier anywhere in an app**: `offerPlan(err, { open })` → true for a 402
  (`plan_feature`, `plan_limit`, `seats_full`, an app's own), with a notice that says why and
  "See plans" running `open` (Settings at its plan section, or a native app's own way to buy);
  false for anything else, which stays the app's. `isPlanError(err)`.
- **Back from the checkout**: `billingReturn({ onPlan, open })`, called once at the start, takes
  `?billing=done` (billing.js's return address) out of the address, thanks the person and reads the
  plan again over about 20 seconds, since the provider's webhook may come after them. Each answer
  goes to `onPlan` and to `kit-plan` (`PLAN_EVENT`) on the document, which an open Settings
  repaints with; the notice says the new plan when it arrives, or that the payment isn't confirmed
  yet when the plan from before is known (kept for the tab as `<app>.billing` in
  `sessionStorage`) and nothing changed. `?billing=canceled`, where a provider sends whoever left
  its checkout unpaid (stripe.js's cancel address), is taken out the same way, with that kept plan,
  and the notice says nothing was charged; the plan isn't read again.
- Their texts in the four languages (`kit.plan.*`). `offerFor(answer, products, subscriptions)`,
  `isLive()` and `productText()` are exported for an app's own page of prices; `offerFor` offers
  nothing without the subscriptions.
- **Nothing changes for an app that doesn't pass the option.** `plan: true` and `plan: { render }`
  show the plan and until when, as before, and ask nothing of billing; no route, migration or
  setting changes. The service worker caches one more file of the kit.

## 0.76.0 — 2026-10-13

- **A catalog for an app sold on its own, whose plans belong to a group** (`plans.js`; named
  `cronum-per-group` since 0.317.0): a product of its own, whose installs name this catalog, so
  none of its plans gives anything in Cronum Work and no Cronum Work plan gives anything in that
  app (an app that declares a key the named catalog lacks doesn't start). Two plans, `free` (Free)
  and `pro` (Pro), and both are a group's: the group is an organization, its plan is granted to it
  and reaches its members, and a trial a new group starts with is that grant with an end. The
  keys, Free's value first: `routines.max` (5, no limit), `history.days` (7, no limit),
  `devices.per_child` (1, no limit), `live` (`false`, `true`), `summary.days` (0, 14),
  `runner.views` (`false`, `true`), `mcp` (on in both) and `mcp.calls_per_day` (100, 1000, as in
  Cronum Work). `history.days` is a Notes key too, with another meaning (a note's earlier
  versions): an install reads only the catalog it names, so the two never meet. The prices stay
  with the provider. `cronum-work` is unchanged, and the error for a catalog that doesn't exist
  names this one among the others.

## 0.75.0 — 2026-10-12

- **A dialog without actions has no "null" at its foot.** `openDialog()` put its parts in with the
  browser's own `dialog.append`, which writes a missing footer as the text "null": a dialog opened
  without `actions` (or with an empty list) showed "null" under its content. Now it uses the kit's
  `append()` (dom.js), which skips the
  gaps: no actions, no footer, and the × in the header closes it. `actions: null` is taken as none.
  A dialog with actions is the same as before.
- Tests: the fake DOM writes what isn't a node as text, `null` as "null", as a browser does (it
  used to throw), and a `<dialog>` has `open`, `showModal()` and `close()`.

## 0.70.0 — 2026-10-12

- **Security: an answer that carries a secret is never kept for an `Idempotency-Key`.** Since
  0.34.0 the first successful answer to a write with a key was kept a day in `idempotency_keys`,
  in clear, to answer the same key again. For the routes below that answer is a secret shown
  once, which the rest of the database keeps only as a hash or encrypted: whoever read the
  database, or a copy of it, within that day had it. Now those routes are never run through
  `idempotency.js`: nothing of their answer is written, and the same key again runs the route
  again, which gives a fresh answer or the route's own refusal, never the first one replayed:
  - `POST /api/me/tokens` (and its older path, `profile.alsoAt.tokens`): a new API token. The
    same key makes another one; the first, whose value never arrived, stays in the list to revoke.
  - `POST /api/me/two-factor/setup`: a new two-step secret, which replaces the one before.
  - `POST /api/me/two-factor/enable`: the ten recovery codes. Again, `409 two_factor_enabled`.
  - `POST /api/me/two-factor/recovery-codes`: ten new ones; the ones before stop working.
  - `POST /api/auth/login` and `POST /api/auth/login/code`: a two-step `challenge` or a deletion
    `ticket` (15 minutes), either one a way into the account.
  - `POST /api/admin/invitations` and `POST /api/orgs/:id/invitations`: an invitation's `url` and
    `token`, which sign up or join whoever opens them. The same key makes another invitation (and
    sends another email); both work until they expire or are revoked.
  - `POST /api/billing/portal`: the provider's portal opens signed in from its link.
- `answeredOnce(handler)` (`idempotency.js`): the mark, moved out of `devices.js`, whose two routes
  had it since 0.67.0. An app marks with it its own routes whose answer is a secret.
- Nothing to clean up: only a session's writes go through `idempotency.js`, and the web kit sends
  these calls without a key, so no app of the suite has kept one of these answers. One kept by any
  other client is no longer replayed, and the clean-up deletes it a day after it was kept. No
  migration.

## 0.67.0 — 2026-10-11

- **Device tokens** (`devices.js`, `modules.devices`, off by default): an app on a phone signs in
  without a password or a session of its own. It opens the system browser on the app's connect page
  with a PKCE challenge (S256) and its return address; the person signs in there and says yes; the
  page asks `POST /api/devices/codes` (session only; the address must be one of
  `devices.redirectUris`, exactly) for a five-minute code and its `redirect_to`; the app exchanges
  the code, its verifier and the address at `POST /api/devices/token` (rate-limited per address,
  failures only, `rateLimits.devices` 30; audited) for a token that starts with `devices.prefix`,
  shown once and kept as a hash. A code is spent by its first exchange, right or wrong. One that
  comes back after that with its verifier and its address revokes the device it gave (OAuth 2.1
  §4.1.3: the verifier got out too, or the app retries an answer it lost); without them it is only
  refused and audited, so whoever saw the code can't disconnect the phone. `GET /api/me/devices`
  and `DELETE /api/me/devices/:id` (session only) list and revoke them; `DELETE /api/devices/current`
  (the device's own bearer) signs a device out. A token ends after `devices.idleDays` (90) without
  use and with the account (`ON DELETE CASCADE`); a disabled account's are refused.
- **The admin's "sign out everywhere" takes the phones too.** `DELETE /api/admin/users/:id/sessions`
  and a password the admin sets for someone else also revoke that person's device tokens
  (`suite.devices.revokeAllOf(userId)`). With the module on, the answer and the
  `admin.user.signout` entry say how many (`{ closed, tokens, devices }`); without it they stay
  `{ closed, tokens }`. `registerAdminApi` takes `devices`.
- `suite.devices`: `issueCode()`, `exchange()`, `authenticate(req)` (the account with its
  `device_id`, or null; last use noted at most once a minute), `isActive(id)`, `list(userId)`,
  `revoke(userId, id)`, `revokeAllOf(userId)`. No route of the suite takes a device token, the MCP
  included: an app accepts one only on the routes it chooses, with `authenticate(req)`.
- `createApp({ devices: { canConnect(user) } })`: whom the app lets connect a phone (an app's own
  allowlist), asked when the code is issued, when it is exchanged and on every use. It must answer
  at once; a promise is refused.
- suite.config.js `devices: { prefix, redirectUris, idleDays }`. With the module on, `prefix` and at
  least one return address are required: both end up in the installed apps. The prefix can't be
  `tokens.prefix` nor one of the built-in OAuth's (`mcpat_`, `mcprt_`, `oc_`, `ocs_`, now
  `OAUTH_PREFIXES` in `oauth.js`), or the MCP would refuse those tokens. An address is a
  reverse-domain private-use scheme (`com.example.app:/auth`, RFC 8252), https, or http on
  loopback, without a fragment.
- **Migration 22** (`device-tokens`): the tables `device_tokens` and `device_codes`, created in every
  app and empty while the module is off. Not `devices`, which an app may already have.
- The admin's activity log names the new entries in its four languages: `device.create`,
  `device.revoke` and `device.token_failed`.
- The brake: `checkFailures(kind, req)` and `noteFailure(kind, req)`, for what anyone can try without
  credentials where only failures count.
- An answer that carries a secret shown once (a device code, a device token) is never kept to replay an
  `Idempotency-Key`: the database keeps hashes only. A route says so with `handler.answeredOnce`; every
  other route is replayed as before.
- **For phones; an app may keep its own pairing.** One that pairs its kiosks and screens the other
  way round (a code shown on the signed-in screen, typed or scanned on the device, bound to one
  profile with scopes of its own, sent in a header of its own) keeps it, since it needs its own
  groups, profiles and scopes. A module of a host can't turn `modules.devices` on.
- Nothing changes for an app that doesn't turn the module on, apart from the two empty tables.

## 0.66.0 — 2026-10-10

- **Another product's sales are kept out**, for a Paddle account that sells more than Cronum Work
  (another app on its own) and sends every event to every app's webhook. Four guards in
  `suite.config.js` `billing`, all off, so nothing changes for an app that says nothing:
  - `ignoreUnknownProducts` (`createBilling({ ignoreUnknownProducts })`): an event that is not a
    refund, for a product not in `products`, has the new outcome `'foreign'`. It is decided before
    anything about who pays: no customer is linked (before, `applyTo` linked it and then ignored
    the product), nothing waits in `billing_pending` (before, 400 days with the person's WorkOS
    id), and only the event's id, type and outcome are kept; the log names the event only, the
    audit nothing. What waited from before is foreign when its person arrives (`claim`).
  - `app` (`createBilling({ app })`): the checkout writes `custom_data.app` (Paddle), and an event
    that names another app is foreign. It is not `app.id`: one value for every install that sells
    a subscription together (`work` in Tasks, Next and Work; another app's own value elsewhere). An event
    without one, sold before checkouts said it, is judged by its product, so `app` goes with the
    other guards.
  - `strictPrices` (`paddleProvider({ strictPrices })`): the product comes only from this install's
    prices, never from `custom_data.product`, which another product may name the same
    (`pro-monthly`). Products take `oldPrices`, a list or one per environment, for prices no longer
    sold that subscriptions still renew on.
  - `paddleProductIds` (`paddleProvider({ paddleProductIds })`, one list of `pro_…` per
    environment): a subscription or one-off purchase whose items are all of other Paddle products
    is foreign, with nothing of who paid. One of this install's own products on a price that no
    product lists is not: its outcome is `'ignored'`, nothing is granted, and the log names the
    price to add to `price`, `founderPrice` or `oldPrices` (events gain `own` and `unknownPrice`).
- Refunds are unchanged: a refund of another product's sale finds nothing here to take back.
- Every setting is checked on start: a misspelled key, a non-boolean, an `app` that isn't an id, a
  product id that isn't Paddle's, a single `paddleProductIds` list with Paddle on (sandbox and live
  ids always differ), or none for `PADDLE_ENV` stops it; `app`, `strictPrices` or
  `paddleProductIds` with another provider is a warning. Events gain `app` (when the checkout
  wrote one) and `foreign` (from the provider). No migration.

## 0.65.0 — 2026-10-10

- **An app with `modules.mcp: false` sends AI clients nowhere.** Its `/mcp` and `/mcp/*` answer a
  JSON 404 without `WWW-Authenticate`, never the app's page (before, an app with `publicDir`
  served its `index.html` there). With WorkOS it no longer serves
  `/.well-known/oauth-protected-resource[/mcp]` nor `/.well-known/oauth-authorization-server*`
  (`createWorkosAccounts({ mcp })`, new, true by default; `createSuite()` passes
  `modules.mcp`): those paths get the JSON 404 of the discovery paths an install doesn't serve,
  and nobody is sent to AuthKit for a connector that isn't there. Signing in on the web is the
  same.
- The built-in OAuth for local accounts is `modules.oauth`, not touched: an app without an MCP
  sets `modules.oauth: false` as well, or that OAuth's metadata and `/oauth/*` stay.
- `/api/auth/config` says `app.modules.mcp`: whether the app's `/mcp` answers (`modules.mcp` on
  and the app's tools given to `createApp`). Settings leaves out its AI section when it is
  `false`; a server from before this version sends nothing and keeps the section. A host's
  module says whether the host's `/mcp` answers (`createApp({ offersMcp })`, new, a boolean or a
  function read on each request): false in a host where no module brings tools and fewer than
  two bring things to link.
- The switch is what turns an MCP off, not leaving out the tools: with `modules.mcp` on and no
  tools there is no `/mcp` and `app.modules.mcp` is `false`, but the WorkOS metadata is still
  served and `/mcp` is the page, as before.
- `checkConformance({ mcp: false })` (`--no-mcp`) now checks that `/mcp` and the OAuth metadata
  for AI clients answer a JSON 404 with no challenge, where it skipped the MCP before. An app that
  calls it so gets these checks when it moves up to this version; the four apps call it with the
  MCP on.
- Nothing changes for an app with its MCP on, as every app has it today.

## 0.64.0 — 2026-10-09

- **A host's links forget what was erased.** `links.prune({ module })` drops the title a link keeps
  of a side that is gone and removes a link whose two sides are gone. The host runs it after
  someone's data is erased in a module (`createPortability({ onErased })`, new, called once the
  erase is done; that module's sides) and once an account's removal is done (every side), so
  neither leaves anything of what went in `host_links`. A plain deletion still shows its last
  title to whoever linked it. `createHost()` returns `links`.

## 0.63.0 — 2026-10-09

- **Icons for pictures**: `image` and `camera` (Lucide's, in one path like the rest), for an editor
  that inserts a picture from the camera roll, the camera or a file (Notes' attachments). The
  paperclip was already `clip`. Nothing changes for an app that doesn't use them.

## 0.62.0 — 2026-10-09

- **Someone can delete their own account** (`account-deletion.js`, the GDPR's right to erasure).
  Settings → Your data → Delete my account asks for a typed word and, with a password here, the
  password and the second step's code (`POST /api/me/deletion`). The account is disabled at once
  (sessions and devices out; tokens and assistants refused) and goes after
  `accounts.deletionDays` (30, `users.delete_after`, migration 21), when the hourly clean-up runs
  `accounts.remove()` with every hook. Signing in before then offers it back
  (`deletion_pending` with a ticket from the password, `/?account_deletion=…&until=…` from WorkOS
  or OIDC; `POST /api/auth/restore`). The admin panel says the day it goes, and enabling the
  account takes the deletion back. A message says until when, if mail leaves the server. The last
  administrator can't ask.
- With `accounts.deleteAtProviders: true` (only where the install is all a person has at the
  providers: Cronum Work) the person's own subscriptions stop renewing when they ask, renew again if
  they come back and end when the account goes (`billing.stopRenewals`, `keepRenewals`,
  `endSubscriptions`; Paddle's `cancelSubscription`, `keepSubscription`), and the WorkOS user is
  deleted first (`workos.deleteUser`, `idp.deleteIdentity`). Off by default: the apps on their own
  share WorkOS users and a subscription.
- **Someone can erase their data and keep the account** (Your data → Erase my data,
  `POST /api/me/erase`, `portability.erase()`): the declaration's new `handOver(userId)` passes on
  what others share first, then goes what the person's own copy would take, files included.
  `openSettings({ shareNote })` tells them what the app does with what they share.
- `identityCheck()` (api.js): the confirmation both ask for, for other routes like them.
- `/api/auth/config` says `deletion_days`; `publicUser()` carries `delete_after` while an account
  waits.

## 0.61.0 — 2026-10-09

- **The drawer follows the finger on a phone.** From the start edge it comes out as far as the
  finger goes, over the open drawer it goes back the same way, and on lifting the finger it opens
  or closes by how far the finger went (the finger's path, so closing costs the same as opening; a
  little less when the system takes the gesture away). It was Tasks' own gesture (its
  edge-swipe.js); in the other apps the drawer came out all at once past 40 px. The click that may
  follow the finger is swallowed, and the CSS takes over from where the finger left the drawer.
  Beside the views (a tablet, folded) the edge still unfolds the sidebar, as before.

## 0.60.0 — 2026-10-09

- **A view's head, the same in every app** (`shell.head({ pane, title, lead, actions, below })`):
  the view's title and the app's actions, and, wherever the sidebar isn't beside the views, ☰ at
  its start and the button that creates at its end (← over a phone's detail). A pane showing one
  takes the bar's place, so the bar no longer holds a line for one button, and each view is laid
  out alike in every app and on any screen. An app that shows no head keeps the bar as before.
- The bar's ☰, ← and create are made by the same functions for the bar and every head; a swipe
  from the edge does what the one showing does, wherever it is. The create button's words are in
  `.kit-bar__create-label`, so a narrow head can show its + alone.

## 0.59.0 — 2026-10-09

- **The drawer opened by a finger shows no ring.** Opening the drawer with ☰ or a swipe from the
  edge put the focus on the current entry, and on a phone that drew the focus ring around it, its
  top cut under the create button by the list's scroll. Now a finger or the mouse
  gives the focus to the drawer itself (`tabindex="-1"`, nothing drawn); Enter or Space on ☰ still
  goes to the current entry. `openDrawer({ keyboard })` and `toggleDrawer({ keyboard })` take it;
  called without it, as apps do, it is a finger's. An entry's ring is drawn inside it, so the list
  never cuts it.

## 0.58.0 — 2026-10-09

- **In a host, Settings moves to the rail, and on a phone the app's icon changes module.** From
  640 px the rail has Settings at its foot (or the account's menu, for an app with entries of its
  own), and shows with one module too. On a phone the drawer no longer carries the rail and keeps
  its own width: the app's icon and name at its head open a menu with the other modules the person
  uses and, last, Settings. The person's button at the sidebar's foot gives way in a host. An app
  on its own is drawn as before.
- `menu()` items take an `image` (a picture's address) in place of an icon; the kit has a
  `chevron-down` icon.

## 0.57.0 — 2026-10-09

- **The phone's keyboard** (`web/keyboard.js`): `fitToKeyboard({ reveal })` fits the frame, Settings,
  the modal dialogs (the kit's and an app's own `<dialog>`) and the notices to the part of the screen the keyboard leaves (`<html
  data-kit-keyboard>`, `--kit-view-top`, `--kit-view-h`), so the browser sliding the view up no
  longer takes the bar, an editor's tools or a sheet's buttons out of reach; the focused field is
  kept in sight. `focusOnTap(area, { focus, skip })` starts typing without that slide. Tasks' fix
  and Notes' (0.8.1), for every app. Nothing changes for an app that doesn't call it:
  the rules in kit.css only apply with the attribute. The service worker keeps `keyboard.js` with
  the rest of the kit.

## 0.55.0 — 2026-10-08

- **Storage is the person's across a host's modules.** A module says how many bytes it keeps for
  someone (`createModule().storage(userId)`), and its view's `storage.used(userId)` adds up every
  module's, so the `storage.mb` of a plan is checked against the whole and not module by module.
  A module that fails to say counts nothing and is logged. On its own an app has no `storage` and
  counts its own files, as always.
- **A PLANS JSON in a host names the features of any of its modules.** Each part (the host and
  every module) reads the keys it declares and leaves out the others' (`createEntitlements({
  othersDeclare })`, `createSuite({ othersDeclare })`), and once every module is in, the host stops
  the start for a key that none declares, as an app on its own does for one it doesn't. Until now
  a JSON with one module's limits stopped the host. A catalog by name (`PLANS=cronum-work`) was
  already read this way.

## 0.54.0 — 2026-10-08

- **Links between modules** (`links.js`, the host's second migration, `host_links`): a module says
  what can be linked of it in `createModule().cards` (read, search, and optionally create, places,
  complete, audience); the host keeps each pair once, shows each side's card as its module draws
  it, and only to whoever could already see it. `GET /api/links?ref=`, `GET /api/links/search`,
  `POST /api/links`, `POST /api/links/new` (created by the other module, by its rules, and linked
  in one transaction), `PATCH`/`DELETE /api/links/:id`. "Done together" is per link: a module
  calls `suite.links.done(type, id, done, { user })` where it completes something, and the other
  side completes in the same transaction. `suite.links.changed(type, id)` repaints the links of
  something that changed (a `links` event in the module's live channel). Two MCP tools,
  `linked_items` and `link_item`, for whoever uses two modules with things to link. On its own an
  app has no `suite.links`.
- **The kit's links row** (`web/links.js`, `linksRow()`): the "Linked" row of an item, its chips in
  the other module's colour, "+ Link" with "Add to…" and "Link existing…", in the four languages.
  `GET /api/modules` says what each module can link. The service worker keeps `links.js` with the
  rest of the kit. On its own an app's row stays hidden and asks nothing.

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
  `cronum-work` (Free, Pro and Team), and an
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
- **Moving an install keeps who pays**. The copy of a whole install carries the
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
  (Next and other apps) and the same pieces in both; on a phone a drawer, two screens for a
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

Copies of data.

- **One person's copy reads that person's rows, not the whole install**. "Download my data", the
  plan of "Import data" and "replace" now ask
  SQLite only for the rows that point at that account, or at rows of theirs already kept. Before,
  they loaded every table whole and filtered it in memory, with the server stopped meanwhile. With
  500,000 tasks of 2,000 people:
  - a copy of an empty account went from 1,298 ms to 34 ms;
  - its plan went from 665 ms to 37 ms.

  The whole install's copy still reads everything, which it needs.
- **What a copy brings stays within what the app's screens accept**. A declaration may
  give `limits` per table, and `users.limits` for the app's own profile columns:
  - a number is the most characters, and longer text is cut there (never through an emoji);
  - a pattern is the shape, and a value without it is left out: the column's default, or what the
    profile already had.

  Text without a limit is cut at 100,000 characters. A copy is a file anyone can write: before, a
  list name of megabytes reached everyone it was shared with.
- Interface: `selectRows()` calls `rowsOf(name, ids)`, with the ids kept so far per table. A
  `rowsOf` that takes only the name works as before.

## 0.32.0 — 2026-10-05

- **Someone WorkOS knows by a new id keeps their account**. Every WorkOS environment
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

More fixes.

- **Push only to the browsers' push services**. A subscription's endpoint must be
  under Google's, Mozilla's, Apple's or Windows' push service domains. A public-looking name can
  point anywhere through DNS, and the server would send to it.
- **The live channel has bounds**. A person keeps at most 10 channels; an 11th
  closes their oldest. A channel that stops reading is closed once 64 kB wait unsent; its browser
  reconnects and resyncs. Before, both grew without end in memory.
- **An install imported from the panel makes no admin by itself**. A copy's accounts
  are created as plain users unless the decision says `create: { role }`. The file could carry
  any role, and with WorkOS whoever signed in with that email became an admin. The command line
  keeps the copy's roles.

## 0.31.0 — 2026-10-05

More fixes.

- **Signing someone out from the admin panel is everywhere**. "Sign out
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
- **A disabled account gets no notices**: disabling it deletes its push
  subscriptions. Apps pick whom to notify from that table without looking at `disabled_at`.
- **Push: an outage no longer drops devices**. A failed fetch, a 408 or 429, and
  any 5xx used to count towards the three failures that delete a subscription: a push service
  down for minutes, or an outbound network blip, dropped every device of everyone. Only the other
  4xx (a refusal about the subscription itself) count now; 404 and 410 still delete at once.
- **The MCP token brake counts per address and token**. Counted per address alone,
  one misbehaving connector behind claude.ai's or ChatGPT's few shared addresses locked every
  other user there out of signing in. Tokens are 192 random bits, so nobody guesses one: what
  the brake stops is a client repeating the same bad token. Past 1,000 failures from an address
  nothing more is written down. `checkToken`, `tokenFailed` and `tokenSucceeded` take the token.

## 0.30.2 — 2026-10-05

- **An import can't multiply one attachment on disk**. Rows that share a file
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

More fixes: importing one's own data (`POST /api/me/import`, open to every account)
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

Fixes: nothing a single request or one account can do should stop the
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
  now sets `BASE_URL` when that one is unset (an older app's name for it), and `PUERTO` warns like
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
  own `.env.example` files carried before the suite (two placeholders, as `app.js` lists them) count as
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
- `tools/i18n.mjs`: `parity` (the same keys, placeholders and plural forms in every
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
  refusing gaps and databases written by a newer release; adopts an app's older table.
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
