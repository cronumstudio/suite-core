# Changelog

Versions follow [semantic versioning](https://semver.org/); while in `0.x`, a minor version may
change an interface and a patch never does. Apps pin a version through the submodule pointer.

## 0.117.0 — 2026-10-22

- **Your usage in Settings › Plan** (`usage.js`, `host.js`, `web/usage-view.js`,
  `web/settings.js`, `web/admin.js`, `web/kit.css`, `web/sw-core.js`). In a host, everyone sees
  under their plan what the admin's Usage shows of them: what they keep in each module they use,
  against the plan's caps with a bar and its percentage, their storage across the modules and
  their calls from assistants today and over 30 days. Near a cap (80 %) or at it, a notice says
  which first, with "See plans" when there is a way to more here (the plans on offer below, or the
  app's store). Without limits, the numbers alone. A standalone app, or a host that doesn't answer,
  shows no block.
  - `GET /api/me/usage`: the person's own `usageOf()`, registered by the host whether or not it has
    the admin panel. 401 without a web session; an assistant's token isn't one.
  - `web/usage-view.js` draws it for both: `usageGroups(usage, { admin })`, with `meter`,
    `levelOf`, `peakWhat`, `percent` and `sizeText`. The kit caches it.
  - Texts: what both say moves from `admin.usage.*` to `kit.usage.*` (`items.*`, `near`, `reached`,
    `peakIn`, `ofLimit`, `storage`, `inAll`, `filesCount`, `used`, `mcp`, `today`, `month`,
    `monthChart`, `dayCalls`); new for Settings: `kit.usage.title`, `lead`, `loading`, `failed`,
    `nothing`, `noDailyLimit`, `nearNotice`, `reachedNotice`. An app that overrode one of the moved
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
  `devices: { connectPage: true }` gets `/devices/connect` from the suite, ported from Tracker's
  own page (which Tracker keeps): the native app opens it in the system browser with
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
- Without the new options nothing changes: an app with `modules.devices` (Tracker) serves neither
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
  0.29.1 did both by hand in its sidebar and Tasks kept the scroll by hand (#72 there); now every
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
  without reloading the page (Focus after a new language or a refresh, Tracker closing its frame).
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
  copy carries. Focus keeps everything per family and has rules of its own: one family per account,
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
  (none has organizations on but Focus's rebuild).
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
  (`portability.js`, for Focus' families and Tracker's fleets). Until now a copy followed accounts
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
    member, since a member reads what the group shares; Tracker can name `['owner', 'admin']`;
    checked against the install's `organizations.roles`, so a misspelt role stops the start instead
    of carrying the group in nobody's copy), `mapOntoOwn` (kinds, or `true`: someone's import goes
    into the oldest group of that kind they own or administer here) and `leave(userId,
    organizationId)` (the app's part when "replace" takes someone out of a group others share). It
    needs `modules.organizations`, said with the declaration's other mistakes at the start; the
    suite's own `organizations`, `memberships` and `invitations` can't be declared as the app's
    tables, nor named in `was`.
  - **A group's one row** (`onePerOrganization: true` on a table whose NOT NULL reference to
    organizations is UNIQUE, as Focus' family row): when the group a row goes into has its row
    already, the copy's is that row and isn't written again; what points at it comes into it, and
    the result counts it under `merged`. Someone's copy put into their own family, Focus' usual
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
  Focus' `owner_user_id` (the family's oldest owner), can be left undeclared as a reference and
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
  the oldest member, those whose seat a role change would move last (`seatRoles`: Tracker's
  drivers). forgetUser, the new `handOver` and an import's group without owners all use it.
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
  nothing of its own to replace (found by Tracker's data-portability review; every app with
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
  nobody behind it (a child's paired device in Focus, a family's hourly sweep). The same shape as
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
  trial of Pro read "Pro until" the trial's end in Settings, and Focus's last-days notice would have
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
  app (Focus' child's tablet, paired to a profile with no account; a kiosk) had no way in: every
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

- **Cronum Tracker's catalog** (`plans.js`, `PLANS=cronum-tracker`): a product of its own, whose
  installs name this catalog, so none of its plans gives anything in Cronum Work and no Cronum
  Work plan gives anything in Tracker (an app that declares a key the named catalog lacks doesn't
  start). Three plans, from the least to the most a person gets: `free` (Free), `org` (Fleet) and
  `pro` (Pro), with the keys `mcp` (off in all three), `capture.native` (Free and Fleet `false`,
  Pro `true`), `links.max` (0, 0, 1), `track.days` (1, 1, 30) and `viewers.max` (0, 0, 30). An
  organization's plan reaches every member, its admins and viewers too, so Fleet carries Free's
  values and sits before Pro: someone with both is shown Pro. What a fleet pays for, per driver,
  sits on what the organization owns, and the app checks it against the organization's grant and
  its seats. The prices stay with the provider and the stores (Pro 3.99 EUR a month or 34.99 a
  year; Fleet 3.90 EUR per driver a month or 39 a year, at launch). `cronum-work` is unchanged.
- **Seats by role** (`organizations.seatRoles` in `suite.config.js`, `createOrganizations({
  seatRoles })`): the roles that take a seat a subscription pays for, some of
  `organizations.roles` (Tracker's drivers, while its admins and viewers are free). Then only
  members in those roles count against a grant's `quantity`: joining in one of them, by an
  invitation or `addMember()`, and a role change into one (`setRole()`) need a free seat, or
  402 `seats_full`; joining in another role never does. Fewer seats bought takes nobody's away.
  `seatsTaken(id)` and `takesSeat(role)` say how many are used and which roles count. Left out,
  every member takes a seat, as before, and a role change takes none. A `seatRoles` that is empty
  or names a role the group doesn't have stops the start. When the last owner's account goes, the
  group passes to someone outside those roles first (its oldest admin, then its oldest member): a
  membership has one role, so a driver inherits it, and stops taking a seat, only when nobody else
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

- **Cronum Focus's catalog** (`plans.js`, `PLANS=cronum-focus`): a product of its own, whose
  installs name this catalog, so none of its plans gives anything in Cronum Work and no Cronum
  Work plan gives anything in Focus (an app that declares a key the named catalog lacks doesn't
  start). Two plans, `free` (Free) and `pro` (Pro), and both are a family's: a family is an
  organization (kind `family`), its plan is granted to it and reaches its adults, who are its
  members, and the 14-day trial a new family starts with is that grant with an end. The keys,
  Free's value first: `routines.max` (5, no limit; saved routines, not what History holds),
  `history.days` (7, no limit; an unsaved routine leaves History after those days unused),
  `devices.per_child` (1, no limit), `live` (`false`, `true`: the live view, an adult's control
  and remote launch), `summary.days` (0, 14; 0 is the last run of each routine), `runner.views`
  (`false`, `true`), `mcp` (on in both) and `mcp.calls_per_day` (100, 1000, as in Cronum Work).
  `history.days` is a Notes key too, with another meaning (a note's earlier versions): an install
  reads only the catalog it names, so the two never meet. The prices stay with the provider (Pro
  2.99 EUR a month or 24 a year per family). `cronum-work` is unchanged, and the error for a
  catalog that doesn't exist names `cronum-focus` among the others.

## 0.75.0 — 2026-10-12

- **A dialog without actions has no "null" at its foot.** `openDialog()` put its parts in with the
  browser's own `dialog.append`, which writes a missing footer as the text "null": a dialog opened
  without `actions` (or with an empty list) showed "null" under its content (found by Tracker's
  browser check of its About dialog). Now it uses the kit's `append()` (dom.js), which skips the
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
- `createApp({ devices: { canConnect(user) } })`: whom the app lets connect a phone (Tracker's
  allowlist), asked when the code is issued, when it is exchanged and on every use. It must answer
  at once; a promise is refused.
- suite.config.js `devices: { prefix, redirectUris, idleDays }`. With the module on, `prefix` and at
  least one return address are required: both end up in the installed apps. The prefix can't be
  `tokens.prefix` nor one of the built-in OAuth's (`mcpat_`, `mcprt_`, `oc_`, `ocs_`, now
  `OAUTH_PREFIXES` in `oauth.js`), or the MCP would refuse those tokens. An address is a
  reverse-domain private-use scheme (`com.example.app:/auth`, RFC 8252), https, or http on
  loopback, without a fragment.
- **Migration 22** (`device-tokens`): the tables `device_tokens` and `device_codes`, created in every
  app and empty while the module is off. Not `devices`, which Focus already has.
- The admin's activity log names the new entries in its four languages: `device.create`,
  `device.revoke` and `device.token_failed`.
- The brake: `checkFailures(kind, req)` and `noteFailure(kind, req)`, for what anyone can try without
  credentials where only failures count.
- An answer that carries a secret shown once (a device code, a device token) is never kept to replay an
  `Idempotency-Key`: the database keeps hashes only. A route says so with `handler.answeredOnce`; every
  other route is replayed as before.
- **For phones; Focus keeps its own pairing.** Focus pairs its kiosks and future screens the other
  way round (a code shown on the signed-in screen, typed or scanned on the device, bound to one
  profile with runner-only scopes, sent in its `X-Focus-Device` header), which needs its households,
  profiles and scopes; that stays in Focus. A module of a host can't turn `modules.devices` on.
- Nothing changes for an app that doesn't turn the module on, apart from the two empty tables.

## 0.66.0 — 2026-10-10

- **Another product's sales are kept out**, for a Paddle account that sells more than Cronum Work
  (Tracker on its own) and sends every event to every app's webhook. Four guards in
  `suite.config.js` `billing`, all off, so nothing changes for an app that says nothing:
  - `ignoreUnknownProducts` (`createBilling({ ignoreUnknownProducts })`): an event that is not a
    refund, for a product not in `products`, has the new outcome `'foreign'`. It is decided before
    anything about who pays: no customer is linked (before, `applyTo` linked it and then ignored
    the product), nothing waits in `billing_pending` (before, 400 days with the person's WorkOS
    id), and only the event's id, type and outcome are kept; the log names the event only, the
    audit nothing. What waited from before is foreign when its person arrives (`claim`).
  - `app` (`createBilling({ app })`): the checkout writes `custom_data.app` (Paddle), and an event
    that names another app is foreign. It is not `app.id`: one value for every install that sells
    a subscription together (`work` in Tasks, Next and Work; `tracker` in Tracker). An event
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
  top cut under the create button by the list's scroll (Notes #41). Now a finger or the mouse
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
  (its nº60) and Notes' (0.8.1), for every app. Nothing changes for an app that doesn't call it:
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
