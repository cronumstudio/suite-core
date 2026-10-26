# The web kit

The interface every app of the suite shares, served by suite-core at `/suite/`: native ES modules,
no build, no dependencies, the same CSP everywhere (`script-src 'self'`). It is the Cronum Studio
brand made into a frame, screens and components, approved on 2026-10-05 (the «Kit web» branch of
«Suite: unificación» in Next). Each app keeps its own domain —Notes' editor, Next's step graph,
Tasks' lists— and takes everything else from here.

## What was decided

| Question | Answer |
| --- | --- |
| Structure | One frame: a **sidebar** with the app's views, what it creates and the person at its foot, in every app (Tasks, Notes, Projects, Next). It folds away on a tablet or a computer for more room. A top bar with tabs for apps with a few views was dropped in v0.41.0, when Next, the only one that used it, moved to the sidebar |
| Sign-in | The **product's colour large**, the form beside it; stacked on a phone; "by Cronum Studio" under it |
| Settings | A **list of sections**; on a phone each section is a screen of its own |
| Dialogs on a phone | A **sheet that rises from the bottom**; centred on a computer |
| Type | **Geist** for the interface, **Space Grotesk** bold for headings, **Geist Mono** for figures, served from `/suite/fonts/` —never from Google— |

And, without a choice: one primary button per screen in the product's colour; greys with a touch
of that hue; **yolk marks "now" and nothing else**; touch targets of 44 px on a phone; stroked
icons with round ends instead of emoji; short notices at the bottom (with *Undo* or *Retry*),
banners under the header for a state that lasts (offline, a new version), and the state of a save
next to what is saved.

## A page

```html
<!DOCTYPE html>
<html lang="en" data-app="notes">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Notes</title>
<link rel="preload" href="/suite/fonts/geist-latin.woff2" as="font" type="font/woff2" crossorigin>
<script src="/suite/theme.js"></script>
<link rel="stylesheet" href="/suite/tokens.css">
<link rel="stylesheet" href="/suite/kit.css">
<link rel="stylesheet" href="/css/app.css">
<script type="module" src="/js/main.js"></script>
</head>
<body></body>
</html>
```

`data-app` picks the product's accent from `tokens.css` (light and dark, measured by the tests). An
app that isn't there sets `--app`, `--app-accent`, `--app-on`, `--app-accent-dark` and
`--app-on-dark` on `<html>` itself. `theme.js` sets `data-theme` before the first paint; the app
saves the person's choice as `<app>.theme` in `localStorage` so the next start gets it right.

In a host, each person also chooses a look (v0.111.0): the suite's own, or **Clean**
(`<html data-look="clean">`: white and plain greys, hairline borders, soft shadows and Inter, with
the product's accent as the one colour). `kit.css` changes only the kit's variables for it, light
and dark apart, so an app's own variables built on them follow. `applyLook(look)` (`base.js`) paints
it and keeps `host.look` in `localStorage`; `theme.js` reads that before the first paint, and an app
with its own pre-paint script adds the same line.

## The modules

| File | What it gives |
| --- | --- |
| `tokens.css` | The brand: yolk, ink, cream, the products' colours and accents, the fonts |
| `kit.css` | Every component below, light and dark, logical properties |
| `dom.js` | `el(tag, props, …children)`, `$`, `$$`, `clear`: nodes through `textContent` and `setAttribute`, never HTML in strings |
| `i18n.js` | The same translations for every app: `t(key, vars)` with plurals and numbers written by Intl, `loadLanguage(preference)` (`'auto'` or a language, kept as `<app>.lang`; each catalog fetched once per page), `savedLanguage`, `changeLanguage`, `shareLanguage`, `translateDom`, and the Intl formats (`dateFormat`, `numberFormat`, `listFormat`, `relativeDay`, `compareText`, `capitalize`, `formatDateTime`) |
| `api.js` | `api.get/post/put/patch/delete/upload`, `api.write(method, path, body, { key })` with an Idempotency-Key; `ApiError`, `SessionExpired`, `Offline`; `errorMessage(err)` in words |
| `icons.js` | `icon(name, { label })`: the suite's icons (`PATHS` lists them); `cronumRing()` |
| `ui.js` | `toast(text, { error, action })`, `banner()`, `saveState()`, `field()`, `switchRow()`, `segmented()`, `blank()`, `avatar()`, `signature()`, `copyText()`, `openDialog()`, `confirmDialog()`, `menu()` |
| `mount.js` | A module in a window of Cronum Work's one-document shell: `workRegistry()` (the shell's services for the page, or null), `ownerOf()`, `markOwned(node)`, `standaloneCtx()` |
| `shell.js` | `createShell()`: the frame; `navItem()` (with `data` for its data-* attributes), `navSection()`, `setCurrent()` |
| `signin.js` | `signIn({ app, config })` → the user; `confirmEmailFromLink()`; `signOut({ local })`, which also deletes every app's copy on the device (`clearDeviceCopies()`, the `*-local` databases) and has the server forget where this browser's notices come to (`pushEndpoints()`, sent as `push_endpoints` with `POST /api/auth/logout`; the browser's subscription stays); `leave({ answer, local })`, the same way out without the request, which Settings takes once the account is deleted |
| `settings.js` | `openSettings({ … })`; `settingsAsked()`; `subscribePush()`; `deviceName()` |
| `connect.js` | The suite's own page at `/devices/connect` (with `devices.connectPage`, device-pages.js): an account allows a phone, signing in in place first with local accounts; `showConnect()`, `connectRequestOf()`, `cancelAddress()`. Not for an app to import: the suite serves it |
| `shared.js` | `sharedSection({ load, kinds, setPermission, remove, leave, accept, open })`: Settings › Sharing; `sharedPage()`, the same page elsewhere |
| `people.js` | `peopleChips(people, { onChange })`: the people one already shares with, as chips to pick under a share dialog's email; `shareWithEach(targets, shareOne)`: every share, then one notice |
| `shared.js` | `sharedSection({ load, kinds, setPermission, remove, leave, accept, open })`: Settings › Sharing; `sharedPage()`, the same page elsewhere |
| `plan.js` | What Settings' plan section sells (`plan: { billing: true }`); `offerPlan(err, { open })` for a 402 anywhere; `billingReturn({ onPlan, open })` back from the checkout; `isPlanError`, `offerFor`, `isLive`, `productText`, `PLAN_EVENT` |
| `update.js` | `watchUpdates({ onUpdate })`, `applyUpdate()`, `tidyAddress()` |
| `live.js` | `connectLive({ onChange, onResync, onAccount, onState })` |
| `local.js` | `openLocal(appId, stores)`: IndexedDB stores of key → value; `memoryLocal()` |
| `outbox.js` | `createOutbox({ local, … })`: changes made offline, sent once each; `tempId()`, `isTempId()` |
| `markdown.js` | `renderMarkdown(source, { onTaskToggle, resolveImage })`, `parseMarkdown`, `toggleTask`, `titleOf`, `plainText`, `safeHref`, `safeImage` |
| `sw-core.js` | `suiteWorker({ version, shell, optional, push, skip, modules })` for the app's service worker (a classic script), from its scope: `/`, or a module's path in a host; `modules` for a host's one worker |
| `worker.js` | `registerWorker()`: the app's /sw.js, or in a host with one worker (host.js `worker`) the host's, retiring the modules' own and carrying their notices over; `hostWorker()`, `workerRegistration()`, `noticesToRenew()` |
| `base.js` | `BASE` and `at(path)`: where the app is served from, `/` on its own and `/tasks/` as a module of a host, read from the kit's own address; the kit's requests go through it |
| `qr.js` | `qrSvg(text, { label })` |
| `push.js` | `pushSupport()`, `devicePushSubscription(publicKey, { ask })`: notices on a device the app keeps, with no account, posted to the app's own route |
| `drag.js` | `makeDraggable(container, { items, check, onDrop, … })`: picking something up from a list and dropping it on a place; `redrawInPlace(container, draw)`: drawing a list again whole without it moving |
| `keyboard.js` | `fitToKeyboard({ reveal })`: the frame, Settings, dialogs and notices fitted above a phone's keyboard; `focusOnTap(area, { focus, skip })`: a tap that starts typing without the view sliding up |
| `native.js` | The bridge to the suite's app on a phone (v0.106.0): `inApp()`, `nativeInfo()`, `can(capability)`; `setBadge()`, `setReminders()`, `nativePurchase()`, `openExternal()`, `nativeSignOut()`, `haptic()`, `openAppSettings()`, `nativeReady()`, `postNative()`; `onNative(type, handler)`, `lastNative(type)`. Nothing outside the app |

## Starting an app

```js
import { el } from '/suite/dom.js';
import { t, loadLanguage, savedLanguage } from '/suite/i18n.js';
import { api } from '/suite/api.js';
import { createShell, navItem, navSection } from '/suite/shell.js';
import { signIn, signOut, confirmEmailFromLink } from '/suite/signin.js';
import { openSettings } from '/suite/settings.js';
import { connectLive } from '/suite/live.js';
import { watchUpdates, applyUpdate, tidyAddress } from '/suite/update.js';
import { openLocal } from '/suite/local.js';
import { createOutbox } from '/suite/outbox.js';

const config = await api.get('/api/auth/config');
let { user } = await api.get('/api/auth/me');
// The account's choice ('auto' follows the browser); before signing in, the one this browser keeps.
await loadLanguage(user?.prefs?.lang || savedLanguage());
const app = { id: 'notes', name: 'Notes', icon: '/icons/favicon.svg?v=1', tagline: t('app.tagline') };
if (!user) {
  user = await signIn({ app, config });
  if (user.prefs?.lang) await loadLanguage(user.prefs.lang);
}
tidyAddress();
confirmEmailFromLink();

const local = openLocal('notes', ['notes', 'notebooks']);
const shell = createShell({
  panes: 'split', app,
  create: { label: t('notes.new'), onClick: newNote },
  onSettings: () => openSettings({ app, user, config, live, updates, applyUpdate, onUser: (u) => { user = u; shell.setUser(u); },
    onSignOut: () => signOut({ local }), applyTheme, setLanguage, sections: [/* the app's own */] }),
  onSignOut: () => signOut({ local }),
});
shell.setUser(user);
shell.nav.append(navItem({ label: t('notes.all'), iconName: 'notes', current: true }), navSection(t('notes.notebooks')));

const live = connectLive({ onChange: reload, onResync: reloadAll, onAccount: refreshUser, onState: shell.setLive });
const updates = watchUpdates({
  onUpdate: () => shell.showBanner('update', {
    kind: 'accent', iconName: 'refresh', text: t('kit.update.availableNamed', { app: app.name }),
    action: { label: t('kit.update.apply'), onClick: applyUpdate }, onClose: () => updates.dismiss(),
  }),
});
const outbox = createOutbox({ local, onCount: (n) => …, onConflict: keepConflictCopy, onDropped: tell });
```

### The frame

`createShell()` builds the frame into `document.body`: `shell.nav` (the sidebar's content),
`shell.list` and `shell.detail` (a list and what is open from it: side by side from 960 px, two
screens below), `shell.actions` (buttons in the bar), `shell.banners`. The sidebar has the app's
name and icon, the live dot, the `create` button and the person at its foot. On a phone, `showDetail()`
moves to the detail and the bar's back button returns (`onBack`, or `showList()`); the sidebar is a
drawer behind ☰. A swipe from the screen's start edge does what the button there does (opens the
drawer, or goes back from a detail) instead of Safari's back in the history, and one from the end
edge does nothing instead of its forward. Over a page that covers the frame with a way back of its
own (Settings), the start edge goes back there: such a page calls `holdBack(node, back)` (ui.js)
while it is open and lets go with the function it returns. On a phone the drawer follows the finger, out from the
edge and back over it, and opens or closes by how far the finger went. Opened by a finger or the mouse, the drawer takes the
focus itself, with no ring drawn; opened with Enter or Space on ☰ (`openDrawer({ keyboard: true })`),
the focus goes to the current entry. With `panes: 'single'` there is one view in
`shell.list`. The person's button is at the sidebar's foot, with their name (in the drawer on a
phone). It opens Settings
(`onSettings`), where Sign out closes the profile.
Only with `accountItems`, or without `onSettings`, it opens a menu instead: the app's entries,
Settings, Administration (for admins, at `/admin`) and Sign out.
As a module of a host (a page under `/<mount>/`, Cronum Work), the person's button gives way. From
640 px a rail at the sidebar's start has the host's mark (not a link, v0.104.0), the modules the person uses (one too) and
Settings at its foot. On a phone the drawer has no rail: the app's icon and name at its head open a
menu with the other modules and, last, what the person's button opened (Settings). So does a
computer's when the host couldn't be asked (offline), until it answers. The host's last answer is
kept on the device (`host.modules`): the rail is drawn with the frame, and again when the host
answers. From one module to another one page fades into the next (`@view-transition` in kit.css,
200 ms, the rail standing still), in browsers that
have view transitions and not for whoever asks for less motion; the host names each module page's code in its answer (§21.4 of the architecture).
`setLive(state)` paints the dot, `showBanner(id, …)` / `hideBanner(id)` keep one banner per id.

**In a window of Cronum Work's shell** (`createShell({ root, embedded: true })`, the module's
`mount(root, ctx)`), the page and its rail are Work's, shared by every module: the frame draws no
rail, no person's button and no switcher, shows no founder's notice, asks the host nothing
(`refreshModules()` is null), sends no `ready` to the suite's app and adds nothing to the window.
Its sidebar and its fold stay. A touch at the screen's edge is taken only by the window it lands in,
and only for what that window does (its drawer, back from a detail): keeping the edges from Safari
is the shell's. Work opens the module's Settings with `kit:settings` on the window's body (`root`),
with `{ start }` or not. What the kit hangs on the page's body there (notices, dialogs, menus,
banners, Settings and sign-in on the body) carries `data-owner="<module>"` and a copy of `<html>`'s
`data-theme`, `data-look` and `lang` (`markOwned`), so the module's sheet scoped to its windows
reaches it; a theme chosen in Settings goes to the shell (`registry.theme.set`) instead of the
app's `applyTheme`, and a language to `registry.language.set`. Anywhere else nothing changes.

**Drawing the frame again.** The frame listens on the document (touches at the screen's edges,
drags) and, in a host, on the window. An app that builds a new frame without reloading the page (a
new language, a refresh, closing one view for another) calls `shell.destroy()` on the old one first:
every listener it added goes (they share one `AbortController`; the click swallowed just after a
drag of the drawer is removed by hand), an account or modules menu it opened
closes, and its element leaves the page, so the old frame can be collected. Calling it again does
nothing. Without it, each old frame kept its listeners: a tap within 20 px of the start edge was passed
on once per frame ever made (the drawer opened and closed at once), and none of them was freed.

From 640 px the sidebar sits beside the views and can be **folded away**: the button at its head
folds it, the bar comes back with ☰ to unfold it (a swipe from the edge does too) and the `create`
button moves into the bar. The device remembers it per app, under `<app.id>.sidebar`
(`'collapsed'` or `'visible'`). `onFold(folded)` says the views' width changed, for whatever is drawn
to it (a Gantt, a timeline); `shell.folded` says how it is. Something picked up while it is folded
brings it over the views as a drawer, as on a phone. An app that lays out its own columns from
960 px (Tasks, Projects) gives their `[data-folded]` version too; on a phone nothing of this
applies, whatever was chosen on a computer.

**A view's head** (`shell.head({ pane, title, lead, actions, below })`) is the same in every
app: the view's title and the app's own actions, and, wherever the sidebar isn't beside the views
(a phone, or folded away), ☰ at its start and the button that creates at its end; over a phone's
detail (`pane: 'detail'`), ← instead. It returns `{ element, setTitle }`; the app puts `element`
at the top of its view (it sticks there while the view scrolls) and makes a new one when it draws
the view again. A pane showing a head takes the bar's place: one line less, and the same layout in
every app and on any screen. `lead` goes before the title (a list's icon, a note's notebook),
`below` under its line, inside the head (a search, chips, a toolbar). In a narrow head (a list
beside its detail) the create button keeps its + and loses its words. An app that shows no head
in a pane keeps the bar there, as before.

### The phone's keyboard

On a phone the keyboard doesn't make the page shorter: it covers its lower part, and the browser
slides the whole view up to keep what is typed in in sight. The frame, Settings and the sheets are
fixed to the full screen, so their top (the bar, an editor's tools, a sheet's title) slides out
of reach and their foot (a sheet's buttons) stays under the keyboard.

```js
import { fitToKeyboard, focusOnTap } from '../suite/keyboard.js';

fitToKeyboard();                                   // once, at the start
focusOnTap(document.querySelector('#add-input'));  // optional, for a field at the screen's foot
```

With `fitToKeyboard()`, while the keyboard is up for a text field, `<html>` has
`data-kit-keyboard` and `--kit-view-top` / `--kit-view-h`, the part of the screen left in view
(`visualViewport`, followed frame by frame while the keyboard moves). kit.css fits `.kit-app` and
Settings to it, puts a modal dialog (the kit's or an app's own `<dialog>`) in its middle (on a
phone, the sheet on the keyboard), the notices
just above the keyboard, and `--kit-safe-bottom` to 0. An app's own rules for what sits at the
foot of its views can read the same attribute. Without a keyboard nothing is touched.

When the keyboard takes room, the focused text box or text area is scrolled back into view. An
editor of the app's own (contenteditable) passes `reveal(field)`, which puts its caret in sight
(clear of what covers it, as a sticky toolbar) and returns true; Notes' gives Tiptap's.

`focusOnTap(area)` focuses `area` on the tap that starts typing with `preventScroll`, so the
browser doesn't slide the view and the frame only shrinks. Only where the caret's place doesn't
matter (an empty field to add to) or the app puts it at the finger: `focus(point)` does it and
returns false to leave the tap to the browser (Notes: `posAtCoords`). A tap while already typing,
a finger that moves, a long press and what `skip` matches (a checkbox, a link) are the browser's.

### Sign-in and settings

`signIn()` shows the screen and resolves with the user. It handles local accounts with their
second step, a forgotten password, the `?reset=` and `?signup=` links and open sign-up, or a button
to WorkOS or an OpenID Connect provider.

`openSettings()` opens the sections every account has —profile, language and theme, password and
sign-in (two-step verification, sessions), the AI (MCP address, connected apps, tokens; only when
`/api/auth/config` doesn't say `app.modules.mcp: false`, v0.65.0),
notifications (`push: true`), plan (`plan: true`; with `{ billing: true }` it also sells, below), the app's own `sections`, data (when the app
declares it), Administration and About— over the app. The profile is saved with `PATCH /api/me`,
which is the app's route (Next's is the model: `display_name`, `email`, `theme`, `prefs.lang`);
everything else is the suite's. `aiExtra()` and `aboutExtra()` add a block (Next's standing
instruction, an app's tips). Your data ends with what goes for good: erasing what one has in the
app (with `data`) and deleting the account (when the install offers it, `deletion_days`), each
confirmed by typing a word and, with a password here, the password and the code; `shareNote` says
there what the app does with what the person shares ("your shared lists pass to…"). The sign-in
screen offers back an account waiting to be deleted.

**In a host** (Cronum Work, v0.104.0) Settings are one for the whole app, the same list in every
module: the account's sections (with notices and the plan when the host says so,
`app.host.push` and `app.host.plans` in `/api/auth/config`, whatever the module passes); then a
group for each module the person uses, in the host's order, with its own sections, its data
(export, import, erase), what it adds to Your AI (`aiExtra`, its own section) and what it is
(`aboutExtra`, its own section); last the host's: deleting the account, Administration and About.
The module open draws its own sections; another's are named from the host's `/api/modules`
(`createModule().settings`, host.js `moduleSettings`) in the person's language, from that module's
catalog, and choosing one goes there with `?settings=<id>`. A module opens its Settings on that
section once it has started: `const asked = settingsAsked(); if (asked) settings(asked);`. In a
frame of the split view, the view opens it in the frame that shows that module
(`kit:settings-goto`, `SETTINGS_GOTO_EVENT`), or the window goes there. An app on its own sees no
change.

**Settings › Sharing** (`shared.js`, v0.94.0) is a section an app adds to `sections`: everything
the person shares, each with who has it, whether they accepted and what they may do (view or
edit, changed there; taken back there), and everything shared with them (accept, decline or
leave). The app gives `load()` → `{ mine, withMe }` and how each change is made; the kit draws
it and asks `load()` again after every change. Tasks shows its lists there; Notes its groups,
notebooks and notes.

**Sharing with people one knows** (`people.js`, v0.96.0): a share dialog puts `peopleChips(people)`
under its email field, with the people the app says the person already shares with (each app's
own rule, in either direction, never the person nor those who already have the thing). One or
several are picked; `shareWithEach()` sends one share each (by id; the email typed, if any, too)
and says once how it went, naming who was refused. The server shares by id only with someone the
person already knows, and answers an id it doesn't know as it would an unknown email.

**Settings › Sharing** (`shared.js`, v0.94.0) is a section an app adds to `sections`: everything
the person shares, each with who has it, whether they accepted and what they may do (view or
edit, changed there; taken back there), and everything shared with them (accept, decline or
leave). The app gives `load()` → `{ mine, withMe }` and how each change is made; the kit draws
it and asks `load()` again after every change. Tasks shows its lists there; Notes its groups,
notebooks and notes.

### Plans and payments

The plan section shows the person's plan and until when (`GET /api/me/entitlements`), and
`plan.render(answer)` adds the app's own block. In a host, under the plan, **Your usage**
(v0.117.0): what they keep in each module they use against the plan's caps, their storage and
their calls from assistants, with a bar where there is a limit (`GET /api/me/usage` at the host's
root, drawn by `web/usage-view.js`, the same as /admin's Usage), the storage as one bar split by
module in each one's colour with a legend of sizes. Near a cap (80 %) or at it, a notice comes
first with what is there as people count it ("2 projects", red at the cap, amber near it), and
"See plans" when there is a way to more here: the plans on offer below, or the app's store. Without limits, the numbers alone; an app on its own, or a host that
doesn't answer, no block. That is all it does with `plan: true`, and with
`plan: { billing: true }` on a server whose `/api/auth/config` doesn't say `modules.billing: false`
it also sells, from the suite's routes (`billing.js`), with nothing of one app or provider in it
(`web/plan.js`, v0.77.0):

- **What can be bought**: `GET /api/billing/products`, the products for one person whose plan is
  above theirs in the catalog's order, or theirs again when it lapses on a date; nothing to an
  admin, whom no plan limits. Each one by its `name` from the server's catalog (a key of the
  catalogs or the name itself, as plans' names are) or else its plan's, with what kind of payment
  it is ("Monthly subscription", read from the suite's product keys `…-monthly` and `…-yearly`;
  "One payment, for 30 days"), and "Founder's price" where the server says the person gets it.
  The price itself is the server's to choose and the provider's page shows it: the browser only
  names the product. Each "Upgrade" button carries its product in its accessible name ("Upgrade:
  Pro (Monthly subscription)").
- **Upgrade**: `POST /api/billing/checkout` with the product, and the browser follows the `url` it
  answers (only an http or https one). A 409 `already_subscribed` says so with "Manage
  subscription" at hand, and the section is read again.
- **The subscription**: `GET /api/billing/subscriptions`, those that hold a plan (active, trial,
  payment pending) with the end of their period. They decide what is offered: nothing while one is
  live (plans change in the portal, and a one-off pass would charge twice, since the server's 409
  guards subscriptions only), and nothing when the list doesn't come, because a subscription's
  plan lapses on a date too. Beside a live subscription that holds the plan shown, the plan's
  "Until" (its period's end and the grace after it) is left to the subscription's own date. A
  pending payment says what to do about it.
- **Manage subscription**: `POST /api/billing/portal`, followed the same way, the primary button
  under a subscription. Without one now, the same portal is "Payments and invoices", last and
  quiet, when there was a subscription before or the catalog sells one-off payments. A 404
  `no_customer` says there is nothing to manage yet, and the button goes until a subscription
  shows up.
- **`hideCheckout: true`**, for a native app's web view, where the stores' rules keep a web
  payment's links out of the app: the subscriptions still show, and no products, Upgrade, way to
  the portal or founder's price.
- **A 402 met in Settings** offers a way to buy: `plan.open()` when the app gives one (a native
  app's store), or else the plan section; under `hideCheckout` without `open`, only the reason.
- **Inside the suite's app on a phone** (`native.js`, v0.106.0) Settings do this by themselves,
  whatever the module passes: always `hideCheckout`; where the app sells (`can('purchase')`) and
  the section is there (`plan`, or the host's `app.host.plans`), `plan.open` is the app's store
  (`storePurchase()`: the `purchase` message) and the section adds "See plans" to it, for whoever
  has a plan above theirs; where it doesn't, a 402 says only why.
- **A group's products** (`for: 'organization'`) are not offered: buying for a group needs its
  seats in the checkout and the group's subscriptions, which the routes don't give the browser yet
  (`GET /api/billing/subscriptions` lists the person's). An app that sells to groups keeps its own
  page for that until the kit does it.

```js
import { openSettings } from '/suite/settings.js';
import { billingReturn, offerPlan } from '/suite/plan.js';

const openPlan = () => openSettings({ ...settingsOptions, plan: { billing: true }, start: 'plan' });

// Once, at the start: back from the checkout at /?billing=done (or /?billing=canceled).
billingReturn({ onPlan: (answer) => refreshLimits(answer), open: openPlan });

// Wherever the app meets a plan's barrier (402 plan_feature, plan_limit, seats_full…).
try { await api.post('/api/lists', body); } catch (err) { if (!offerPlan(err, { open: openPlan })) fail(err); }

// A native app's web view: its own store instead of the web's checkout.
openSettings({ ...settingsOptions, plan: { billing: true, hideCheckout: true, open: openStore } });
```

- `offerPlan(err, { open })` → true for a 402: a notice says why in the person's language, with
  "See plans" running `open` (Settings at its plan section, or a native app's own way to buy);
  false for anything else, which stays the app's. Inside a Settings that sells, every section
  does this by itself.
- `billingReturn({ onPlan, open })` → false unless the address has `?billing=done` or
  `?billing=canceled`. Then it takes the mark out of the address (not again on a reload). Back from
  paying, it thanks the person (with "See plans" when there is `open`) and reads the plan again a
  few times over about 20 seconds, because the provider's webhook may arrive after them: each
  answer goes to `onPlan` and to `kit-plan` (`PLAN_EVENT`) on the document, which an open Settings
  repaints with (an older answer that comes late never paints over it), and the notice says the
  new plan once it is there. When the plan from before the checkout is known (kept for the tab as
  `<app>.billing` in `sessionStorage`) and nothing changed by the last look, it says the payment
  isn't confirmed yet. It returns a promise of the plan that arrived, or null. Back from a
  checkout left unpaid (`canceled`, where the provider has a cancel address), it forgets the kept
  plan, says nothing was charged and reads nothing: a promise of null.
- `offerFor(answer, products, subscriptions)` and `productText(product, plans)`, for an app's own
  page of prices, choose and name what Settings offers; `offerFor` offers nothing without the
  subscriptions' list. `isLive(subscription)` says whether one holds its plan.

### Inside the app on a phone

Cronum Work's app for iPhone and Android is a web view of the web with the native pieces the web
can't have. `native.js` (v0.106.0) is the bridge between them; outside the app every one of its
functions does nothing (false, null), and every page behaves as it always did.

**Knowing it.** In the app when the user agent carries `CronumWorkApp/<version>` (the app appends
it) or the app injected, before the page loaded,
`window.CronumNative = { v: 1, platform: 'ios' | 'android', version, capabilities: [...] }`.
`inApp()`, `nativeInfo()` (`{ v, platform, version, capabilities }`, frozen, or null) and
`can(capability)` say so; the capabilities are `push`, `reminders`, `badge`, `purchase`,
`biometrics` and `share`. Known from the user agent alone, the app can do nothing. In a frame of
a host's split view the bridge is the top window's.

```js
import { can, setBadge, setReminders, onNative } from '../suite/native.js';

if (can('badge')) setBadge(openTasks);
if (can('reminders')) setReminders(nextWeek.map((task) => ({ id: task.id, module: 'tasks', title: task.title, at: task.remind_at, url: `?task=${task.id}` })));
const stop = onNative('push-state', ({ state }) => paint(state));
```

**The web to the app**: `window.ReactNativeWebView.postMessage(JSON.stringify({ v: 1, type, ...payload }))`.

| `type` | Payload | Sent by |
| --- | --- | --- |
| `ready` | — | `nativeReady()`: the page is drawn and listening; `createShell()` sends it, once a page, never from a frame |
| `badge` | `{ count }`, an integer from 0 | `setBadge(n)`, with `badge` |
| `reminders` | `{ items: [{ id, module, title, at, url }] }` | `setReminders(items)`, with `reminders`: every reminder of the next days, **the full set, which replaces the one before** (an empty list clears them). `at` ISO 8601 in UTC, `url` a path of this site (one elsewhere is left out), the soonest 64 (iOS keeps no more) |
| `purchase` | `{ product }` | `nativePurchase(product)`, with `purchase`: a product key (`stores.products`), or null for the app's own choice. `storePurchase()` in plan.js sends it and waits for its answer |
| `open-external` | `{ url }` | `openExternal(url)`: http, https, mailto, tel or sms, opened outside the app |
| `sign-out` | — | `nativeSignOut()`: the person signed out here (`signOut()` sends it, and Settings once the account is deleted, before the page goes anywhere); the app lets go of its device |
| `haptic` | `{ style }` | `haptic(style)`: `light`, `medium`, `heavy`, `selection`, `success`, `warning`, `error` |
| `open-app-settings` | — | `openAppSettings()`: Settings › Notifications in the app |

`postNative(type, payload)` sends any message, for one the kit has no helper for yet; the payload
never changes `v` or `type`.

**The app to the web**: a `cronum-native` CustomEvent on the window (`NATIVE_EVENT`), its `detail`
`{ v: 1, type, ... }` (an object, or the same as JSON). `onNative(type, handler)` hears one type and
returns the function that stops it; `lastNative(type)` is the last one of that type since the page
loaded.

| `type` | Detail | What the kit does |
| --- | --- | --- |
| `purchase-result` | `{ product, status }`: `purchased`, `pending`, `canceled` or `failed` | `storePurchase()` says it in a notice; bought, it reads the plan again and sends it as `kit-plan` (`PLAN_EVENT`), which an open Settings repaints with |
| `push-state` | `{ state }`: `granted`, `denied` or `undetermined` | Settings › Notifications says when the phone has them off |

**The messages are only ever added.** Never renamed, never given another meaning, never a payload
field taken away or changed: a build of the app lives for months on people's phones next to a web
that changes every day. Either side may meet a message it doesn't know and ignores it, and
neither side waits on an answer to go on. Every message carries `v: 1`; one with another `v` is
ignored. A new message, or a new optional field, goes into native.js's header, these tables and the
CHANGELOG.

**What the kit does by itself in the app.** Settings' plan never shows the web's checkout, and
sells through the app's store where it can (above, Plans and payments). Settings › Notifications
offers no Web Push: with `push` it says the app sends them, whether the phone has them off, and
opens the app's settings (`open-app-settings`); without it, that they come with an update of the
app. `subscribePush()` refuses (`Error('in_app')`) before asking anything, `pushSupport()` says
`'unsupported'`, and the host's one worker carries no subscription over: the app's own
registration is the phone's one channel, so a notice never comes twice. Leaving never goes to the
provider's page (`logout_url`, WorkOS or OpenID Connect), v0.126.1: another site, which the app
would open in the phone's browser or race with its own sign-in. `signOut()` ends the session at the
server and clears the device's copies as anywhere, sends `sign-out`, then reloads to the site's own
sign-in, as it does without a provider. Deleting one's account in Settings does the same once the
server has taken it: `sign-out` first, then the site's own page; the app's own sign-in takes the
place of the web's farewell notice (until when the account can be taken back), which a browser
still shows. The provider's own session is left to the app.

### Offline

`openLocal()` keeps what the app has shown and the outbox in IndexedDB (`<app>-local`). A change
goes through the outbox when it must not be lost:

```js
const ref = tempId();                                       // tmp-…: the note until the server names it
await outbox.add({ method: 'POST', path: '/api/notes', body: { text, client_ref: ref }, tempId: ref });
await outbox.add({ method: 'PATCH', path: `/api/notes/${ref}`, body: { text: more, version } });
outbox.flush();                                             // and by itself on `online`
```

Each change carries its id as `Idempotency-Key`: the server answers a repeat with the first answer
(suite-core `idempotency.js`, for every app's API, a day). When the creation goes through, later
changes are pointed at the real id (`idOf(answer)`, by default `answer.id`). It stops without a
signal, with the session ended or the server failing, and waits; a 409 goes to `onConflict` (Notes
saves a conflict copy), anything else that can't be fixed by retrying to `onDropped`. One tab sends
at a time (a Web Lock). `signOut({ local })` wipes it all: one person's notes don't stay for the next.
Nothing reads the whole queue to count it or to take the next change (`local.count`, `local.first`;
a provisional id is swapped with `local.rewrite`, one pass in one transaction): hundreds of changes
queued offline cost no read to add and one record each to send.

### Drag and drop

A note onto another notebook, a task onto another list: `makeDraggable()` picks up rows of a list
and drops them on places anywhere on the page —anything with `data-drop`, such as a sidebar entry
made with `navItem({ …, data: { drop: '', notebook: id } })`—. The app says what letting go there
would do; the kit does the pointer:

```js
import { makeDraggable } from '/suite/drag.js';

makeDraggable(list, {
  items: '[data-note]',                                    // what picks up; the list may redraw them
  canDrag: (row) => writable(row),                         // false: it stays (a notebook only to read)
  label: (row) => titleOf(row),                            // the card that follows the pointer
  check: (row, place) => same(row, place)                  // in words, before letting go
    ? { ok: false, text: t('notes.drag.alreadyThere') }
    : { ok: true, text: t('notes.drag.moveTo', { name: nameOf(place) }) },
  onDrop: (row, place) => move(row, place),                // only when check said ok
});
```

- **With a mouse** it starts once the pointer has moved a few pixels, so a click is still a click;
  **with a finger**, after holding still for a moment (and a little buzz on Android), because
  otherwise every scroll of the list would pick up a row. `handle` gives a grip that drags at once;
  `skip` names parts of a row that don't pick it up (a grip that reorders). Controls inside a row
  keep their job.
- **Words, not just a highlight.** The card says what letting go will do or why it can't
  (`{ ok: false, text }`): a few pixels separate two notebooks on a sidebar. The place under the
  pointer gets `data-drop-state="ok"` or `"no"`; `null` from `check` means the place has nothing to do
  with it.
- **Escape** puts it back; letting go anywhere else does nothing; the click the release would make
  doesn't open the row. Near the top or bottom of whatever scrolls under the pointer, it scrolls.
- **On a phone** the sidebar is a closed drawer: the frame opens it as soon as something is picked
  up whose places are in it, and closes it when the drag ends, dropped or not. Held over ☰
  (`data-drag-spring`) it opens too.
- `document` hears `kit-dragstart` (with `detail.item` and `detail.targets`) and `kit-dragend`, and `<html>` has `data-kit-dragging` meanwhile:
  an app's own gestures (a swipe on the row, a refresh that redraws the list) wait.
- It is never the only way: a keyboard or a screen reader can't drag, so what can be dropped
  somewhere can also be moved from a menu. After a move, a notice with *Undo*.

**In order: before, inside, after.** To reorder a list or a tree, the rows are at once what is
picked up and where it goes, and `zones` splits each place by the height of the pointer:

```js
makeDraggable(list, {
  items: '[data-id]',
  targets: '[data-id]',                                    // its own row is never a place
  zones: (row, item) => (canNest(row) ? 'around' : 'between'),   // or one for all
  end: true,                                               // below the last row: (list, { zone: 'end' })
  label: (row) => titleOf(row),
  check: (row, place, { zone }) => ({                      // asked once per place and zone
    ok: true,
    text: t('app.drag.after', { title: titleOf(place) }),
    detail: t('app.drag.topLevel'),                        // a second, quieter line
    indent: 14,                                            // the gap's indent, in pixels
  }),
  onDrop: (row, place, { zone }) => move(row, place, zone),
});
```

- `zones`: `'whole'` (the default, as above), `'between'` (the top half is `before`, the bottom
  half `after`) or `'around'` (`before` in the top 30 %, `inside` in the middle, `after` in the
  bottom 30 %); a function chooses place by place, so a row that can't take anything inside offers
  only its edges.
- **The gap.** Before or after a row, where it would land opens as a dashed gap as tall as the
  row carried (`.kit-drop-gap`, an `li` in a list), and the rows below make room for it. Over the
  gap, or over nothing among those rows, it still goes there, so the rows moving under the pointer
  don't close it. Where `check` says no, no gap opens and the card says why. `inside` and `whole`
  light up the place, as before. Rows that must stay level with something beside them, as the names
  beside a chart's bars, take `gap: 'thin'`: a dashed line that moves nothing.
- The gap is a node among the rows while it is open: striping with `:nth-child(even of [data-id])`
  rather than `:nth-child(even)` keeps the colours still.
- **Where it landed.** `onDrop` also gets `x` and `y`, where it was let go, and `top`, that of the
  gap (null without one): the list is drawn again after a move, and keeping the moved row at `top`
  keeps it under the finger instead of somewhere the eye has to look for.

**Drawing again without moving.** A sidebar or a list drawn again whole on every change jumps:
emptied, its box goes back to the top (a long sidebar did on every drop, and again with the live
notice that follows it), and a live notice during a drag takes away the rows and the gap under
the pointer. `redrawInPlace(container, draw)` does both things the kit's way:

```js
import { redrawInPlace } from '/suite/drag.js';

export function renderNav() {
  redrawInPlace(shell.nav, () => {
    clear(shell.nav);
    // … the rows
  });
}
```

- The box that scrolls the container (itself, or the nearest one above it that scrolls) keeps how
  far it was scrolled.
- While something is carried (`data-kit-dragging`) it doesn't draw: it waits for `kit-dragend` and
  draws once, with the last `draw` it was given, however many times it was asked meanwhile. It
  answers `true` when it drew, `false` when it waits.

**One drag for everything.** A task may go in order, into another category and onto a list of the
sidebar in the same drag: its places are all of them, and `check` says which is which.

- `grip` names a part of the row that picks it up at once, a finger too; the rest of the row still
  needs holding (`handle` is the same, but the only way to pick it up).
- `onHold(item)`: a finger that held a row and let go without moving it didn't drag it, it pressed
  long, and `onHold` does what a long press does there (its menu). So the whole row can be what
  picks up, with no grip to look for, and the long press keeps its job.
- `drawer: 'tabs'` (or `(item) → 'tabs' | 'open'`): on a phone the drawer doesn't open as it is
  picked up, because there is somewhere to put it in the list. A tab shows at the start edge; held
  there, the drawer opens. With the drawer open, a tab at the end edge, beside it, closes it again,
  without letting go. `createShell({ dragTabs: { open: 'menu', back: 'back' } })` chooses their icons.
- Whatever opens something when held (☰, the tabs: `data-drag-spring`) has `data-spring-armed`
  while the pointer waits over it.

### Markdown

`renderMarkdown(text, { onTaskToggle })` draws a note with `el()` —headings, lists, task lists,
quotes, code, tables, links and images— and never interprets HTML. Links go to http, https, mailto
or within the app; images load only from the app (`resolveImage` maps an attachment), so nothing
in a note makes the reader's browser call a third party. `toggleTask(text, line, done)` ticks the
box in the source.

### The service worker

```js
// public/sw.js
importScripts('/suite/sw-core.js');
suiteWorker({
  version: 'notes-v1',
  shell: ['/', '/index.html', '/css/app.css', '/js/main.js', '/js/app-version.js', '/i18n/en.json',
    '/manifest.webmanifest', '/icons/favicon.svg?v=1'],
  optional: ['/i18n/es.json', '/i18n/fr.json', '/i18n/de.json'],
  push: { title: 'Notes', icon: '/icons/icon-192.png?v=1', badge: '/icons/badge-96.png?v=1' },
});
```

The kit's own files join the shell by themselves. Every file the app adds to `public/js/` goes in
`shell`.

To run also as a module of a host (architecture §21), the app writes its paths relative to the
worker (`importScripts('suite/sw-core.js')`, `shell: ['./', 'index.html', 'css/app.css', …]`) and
registers it with `registerWorker()` (`worker.js`), which registers `at('/sw.js')`. On its own
those are the same URLs as before; in a host they are the module's, and the worker reads everything
else (the API, the kit, its cache's name) from its scope.

A host with one worker for everything (`createHost({ worker })`, architecture §21.5) writes its
own /sw.js at `/` from the modules' files: each module's `shell` read from its public/sw.js, the
host's pages and the kit at every path. There `registerWorker()` registers the host's and retires
every module's worker the device still has, carrying their push subscriptions over to it (the
server told: the new address kept, the old ones forgotten). Where the browser won't subscribe
without a tap, `noticesToRenew()` is true and Settings › Notifications asks to turn them on again.
`watchUpdates()` then compares the host's /version with the host's /js/app-version.js: one notice
for the whole app, named after the host (`theirs.name`), and none in a frame of the split view,
whose page shows it once.

### Notices on a device with no account

Settings' `subscribePush()` is for a signed-in person: it reads `/api/push/config` and posts to
`/api/push/subscribe`, both behind a session. A device that belongs to the app instead (Focus'
child's tablet, paired to a profile; a kiosk) uses `push.js` (v0.81.0), which asks nothing of the
server and hands the subscription to the app:

```js
// public/js/device.js
import { pushSupport, devicePushSubscription } from '../suite/push.js';

// 'granted' | 'prompt' | 'denied' | 'install' (an iPhone or iPad tab) | 'unsupported'
if (pushSupport() === 'install') showHomeScreenHint();
startButton.addEventListener('click', async () => {
  // publicKey: suite.push.publicKey, given to the device by the app (its pairing answer, say)
  const subscription = await devicePushSubscription(publicKey);
  await api.post('/api/<the app’s route>', { subscription });   // { endpoint, expirationTime, keys }
});
```

- **Ask from a tap, with the key at hand.** Safari asks for permission only from a tap, and a
  request awaited before asking can use the tap up; `devicePushSubscription()` asks before it
  awaits anything. `{ ask: false }` never asks and only goes on where permission was already
  given: an app refreshing the subscription when it starts.
- **iPhone and iPad** give Web Push only to the app added to the home screen and opened from
  there, from iOS 16.4: in a Safari tab `pushSupport()` says `'install'`, and the app explains it
  before offering the button. Before 16.4 it says `'unsupported'`: installing wouldn't help.
- The browser's subscription is reused while it is for this key, and replaced when it was made with
  another (the install's keys changed). It throws `Error('unsupported')` (also when no service
  worker is ready within `wait`, 10 s), `Error('install')`, `Error('not_allowed')` or
  `Error('subscribe_failed')` (the browser or its push service refused, offline say; the browser's
  error is its `cause`), and a `TypeError` for a key that isn't one.
- A browser has **one subscription per service worker**: a person who also turns notices on in
  Settings on the same device gets the same endpoint, so neither side unsubscribes the browser to
  forget the other; each drops its own row.
- The app's route checks what arrives with `suite.push.checkSubscription()` (a coded 400 for a
  device that sent something else) and keeps what it returns with the device; the server sends
  with `suite.push.sendToSubscription()` and drops the row when it answers `gone`. A notice is at
  most `MAX_PAYLOAD` bytes (3993). What arrives is shown by the service worker above, with `push`
  in `suiteWorker()`: `title`, `body`, `tag` and `url` (the page a tap opens; an open tab gets
  `{ type: 'notification', data }` instead).

## Texts

Every text a person reads comes from the catalogs: the kit's are `kit.*` in suite-core's
`i18n/<lang>.json`, merged with the app's at `/i18n/<lang>.json`. Every app does it the same way:

- **Catalogs**: `public/i18n/<lang>.json`, flat (dotted keys), in the app's languages (`app.languages`).
- **Browser**: `t()` and the rest from `/suite/i18n.js`, nothing of its own. Before signing in the
  app loads `savedLanguage()` (what this browser keeps as `<app>.lang`, `'auto'` by default), and
  then the account's choice; Settings calls `loadLanguage` or `changeLanguage` (`app:language`
  tells the app to draw itself again). In Cronum Work's shell the language chosen goes to the shell
  too (`shareLanguage`, once: the shell's news back to a module already in it goes no further). An app keeps only what is its own domain, like how Next
  groups its dates (`dates.js`), built on `dateFormat` and the others.
- **Server**: `server/i18n.js` is `appTexts(new URL('../public/i18n/', import.meta.url))` from
  `i18n.js`: `translator(lang)`, `languageFor(req, user)`, `userLanguage(user)`, `textsFor`,
  `errorSentence`, `fromCatalog`, with `DEFAULT_LANGUAGE` as the last resort.
- **Tests**: `appChecks(root, { skip })` from `tools/i18n.mjs` (`npm run i18n`: `node
  server/suite/tools/i18n.mjs app .`), and `tools/web-resolve.mjs` to load browser modules in Node.

The checks are flat catalogs that agree (keys, placeholders, plural forms), the keys the browser and
the server use, and texts written in the code:

```
node server/suite/tools/i18n.mjs app . --skip catalog.js
```

In the browser's `.js` it reads the code, not its lines: comments and regular expressions are left
out, and a literal counts when it is in another language (letters English doesn't use), when people
read it (an element's text, title, label, placeholder or alt, `setAttribute`, `toast()`,
`confirmDialog()`, either side of a condition) or when it is a sentence that isn't an error's
message or for the console. In `.html` it reads the text between tags, unless an element around it
has `data-i18n`, and every read attribute not covered by `data-i18n-attr`. On the server
(`--server`) only another language counts, since its English is for the developer and the assistant
(MCP), and `--skip` leaves out data such as seeds in every language. Brand and product names, keys,
paths, URLs and acronyms pass; a line with `i18n-exempt` (and why) is skipped.
