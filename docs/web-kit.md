# The web kit

The interface every app of the suite shares, served by suite-core at `/suite/`: native ES modules,
no build, no dependencies, the same CSP everywhere (`script-src 'self'`). It is the Cronum Studio
brand made into a frame, screens and components, approved on 2026-10-05 (the «Kit web» branch of
«Suite: unificación» in Next). Each app keeps its own domain —Notes' editor, Next's step graph,
Tasks' lists— and takes everything else from here.

## What was decided

| Question | Answer |
| --- | --- |
| Structure | One frame: a **sidebar** with the app's views and collections, and at its foot what makes a collection and the trash, in every app (Tasks, Notes, Projects, Next); an item is created with the floating button over the list. The person has no button of their own: the app's icon opens Settings (v0.224.0). It folds away on a tablet or a computer for more room. A top bar with tabs for apps with a few views was dropped in v0.41.0, when Next, the only one that used it, moved to the sidebar |
| Sign-in | The **product's colour large**, the form beside it; stacked on a phone; "by Cronum Studio" under it |
| Settings | A **list of sections**; on a phone each section is a screen of its own |
| Dialogs on a phone | A **sheet that rises from the bottom**; centred on a computer |
| Type | **Geist** for the interface, **Space Grotesk** bold for headings, **Geist Mono** for figures, served from `/suite/fonts/` —never from Google— |

And, without a choice: one primary button per screen in the product's colour; greys with a touch
of that hue; **yolk marks "now" and nothing else**; touch targets of 44 px on a phone; stroked
icons with round ends instead of emoji; short notices at the bottom (with *Undo* or *Retry*),
banners under the header for a state that lasts (offline, a new version), and the state of a save
next to what is saved.

## Same in every module

Martin's rules for the sidebar and the heads (v0.247.0), for an item's detail and a row's swipe
(v0.248.0), for the search (v0.249.0), and for deleting and dialogs (v0.245.0, v0.246.0), so that
going from one module to the next in Cronum Work nothing moves:

1. **An item is never created from the sidebar.** A note, a step: the floating + button over the
   list, at every width, a computer's too (`createShell({ create })`). A module with an add bar of
   its own (Tasks, Projects) passes no `create`.
2. **A collection is created from the sidebar's foot**: a + at its start, the trash at its end
   (`createShell({ foot })`).
3. **Groups look and behave the same** (`navGroup()`): the group's name opens its menu, where a new
   collection in it is too; the chevron folds it. A group stays open while the collection open is in
   it. Collections with no group sit loose under their section's label.
4. **A view's head holds only «…»** (`moreButton()`), besides the kit's own ☰, ← and ×: every
   action of the view is in that one menu.
5. **An item's detail is the same in every module.** Its head (`shell.head({ pane: 'detail' })`)
   has the way to close it: ← at its start where the list is a screen of its own (a phone), × last
   where the list and the detail sit side by side (a computer). Then the place the item lives in
   (its list, notebook or project, as a chip: `lead`), the item's quick toggles if the module has
   them in its head (Notes' pin), and one «…» with the item's actions in this order: the module's
   own, share, public page, a separator, and «Borrar» or «Mover a la papelera» last, in red, which
   goes to the trash at once and leaves an Undo (`undoToast`). Escape closes the detail too. Next's
   step and branch cards stay dialogs, as a card fits its board: they keep their ×, Escape and the
   backdrop, and get a «…» in their header (`tools: moreButton(items)`).
6. **A sideways swipe on a row acts on that row**, and never switches module (`rowSwipe()`): to
   the left, the item to the trash, with Undo; to the right, the module's quick toggle (Tasks: the
   star, and My Day further; Notes: pin or unpin; Projects: done or not done, not for phases). A
   row with nothing to do (Next's rows, a row only to read) still keeps the finger (`keepSwipe()`):
   swiping it does nothing. Only a finger swipes, never a mouse or a trackpad, and what scrolls
   sideways (Next's line, the Gantt, chips) keeps scrolling.
7. **Deleting asks only for what can't come back.** What goes to a trash goes at once and leaves
   an Undo (`undoToast()`): a task, a note, a notebook, a list or a group of lists, a project's task
   or phase, a file. A subtask (Tasks) and a dependency (Projects) don't ask either: their Undo makes
   them again. What can't come back asks «¿Borrar «X»?» with a red Borrar (`deleteDialog()`):
   deleting from a trash for good, emptying it, a category, a template, a Notes group, a Next
   project or step. Taking something shared back from someone asks only if they had accepted it
   (the share dialog's default); withdrawing an invitation never asks.
8. **A dialog is 560 px wide on a computer, a question 420** (`QUESTION_WIDTH`, the kit's
   `confirmDialog()` and `deleteDialog()`): a module sets no width of its own for a form or a
   question (a photo viewer may take the room it needs). Sharing is the kit's dialog in every
   module (`shareDialog()`), an app's own roles included.
9. **The search is the same in every module** (`createShell({ search })`): the sidebar's first
   line, as tall in each, reading «Buscar» in the kit's faint colour; the module's own words
   («Buscar tareas») name it for a screen reader. «/» goes to it from a keyboard in every module,
   on any device; its key shows at the field's end only on a big screen with a mouse or a trackpad,
   never in its words (they wouldn't fit), and goes while the field has the focus or text.

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

**The status bar in the page's ground** (v0.214.0): an app installed on an iPhone's Home Screen
takes `<meta name="apple-mobile-web-app-status-bar-style" content="default">`, an opaque bar; the
see-through `black-translucent` with `viewport-fit=cover` makes iOS 26 show the app shorter than the
screen by the status bar (WebKit 301108), a blank band at its foot. That bar has the colour of
`theme-color`: mark the page's `theme-color` metas `data-kit-ground`, before `theme.js`, and it
paints them in the page's ground (the body's background, as `rgb()`) once the page is there and
whenever `data-theme`, `data-look` or `data-app` change. Their own `content` is what shows meanwhile.

## The modules

| File | What it gives |
| --- | --- |
| `tokens.css` | The brand: yolk, ink, cream, the products' colours and accents, the fonts |
| `kit.css` | Every component below, light and dark, logical properties |
| `dom.js` | `el(tag, props, …children)`, `svg(tag, props, …children)`, `$`, `$$`, `append`, `clear`: nodes through `textContent` and `setAttribute`, never HTML in strings; `style` and `dataset` may be objects, children may come in nested arrays |
| `i18n.js` | The same translations for every app: `t(key, vars)` with plurals and numbers written by Intl, `loadLanguage(preference)` (`'auto'` or a language, kept as `<app>.lang`; each catalog fetched once per page), `savedLanguage`, `changeLanguage`, `shareLanguage`, `translateDom`, and the Intl formats (`dateFormat`, `numberFormat`, `listFormat`, `relativeDay`, `compareText`, `capitalize`, `formatDateTime`) |
| `api.js` | `api.get/post/put/patch/delete/upload`, `api.write(method, path, body, { key })` with an Idempotency-Key, `api.request` with every option, `api.with(options)`; `setPatience(ms)`; per call `patience`, `signal`, `text` (the body's text too), `type` (an upload's), and the hooks `beforeSend`, `onAnswer` (status and headers, before the body) and `onNoSignal` (an answer instead of `Offline`: Tasks' queue); `ApiError`, `SessionExpired`, `Offline`; `errorMessage(err)` in words (a plan's limit names what it counts: «20 listas»); `setPlanOpener(open)` and `planAction(text)`, the way to the plans from a 402's notice |
| `icons.js` | `icon(name, { label })`: the suite's icons (`PATHS` lists them); `cronumRing()` |
| `ui.js` | `toast(text, { error, action })`, `banner()`, `saveState()`, `field(label, control, hint, { class, hintClass, hintTag, groupLabel })`, `switchRow()`, `segmented()`, `blank()`, `avatar()`, `signature()`, `copyText()`, `slideHidden(node, hide)` (a fold that slides open and shut), `slidingDetails(details)` (a `<details>` that does, one of a `name` open at a time), `openDialog()` (`width`, `parent`, `body`/`footer` of a module's own; one action at a time), `formDialog()` (a form: `onSubmit` with its error inside, one send at a time, Ctrl/Cmd+Enter, `header`/`tools`/`bar`/`extra`, `setActions`), `confirmDialog(text, { title, confirm, cancel, danger, detail })` (420 px, `QUESTION_WIDTH`), `deleteDialog(name, { text, detail })` («¿Borrar «X»?», a red Borrar: for what can't come back) and `undoToast(text, onUndo)` (for what goes to a trash, deleted without asking), `menu(anchor, items, { header, at, parent, body })` (items with `glyph`; `body`, a node of the caller's after the items, its `role="menuitem"` buttons moved through with the arrows; a falsy one is left out, and so is a separator with nothing to separate), `moreButton(items, { label })` («…»: a view's head's one button, its items asked for as it opens) |
| `mount.js` | A module in a window of Cronum Work's one-document shell: `workRegistry()` (the shell's services for the page, or null), `ownerOf()`, `markOwned(node)`, `standaloneCtx()` |
| `shell.js` | `createShell()`: the frame, with `create` (the floating button), `foot` (the sidebar's foot) and `search` (its first line, «Buscar», and «/» to it), and `head()` for each view (a detail's with ← or ×, which Escape does too: `onBack`, `active`); `navItem()` (with `data` for its data-* attributes), `navSection()`, `navFold({ label, key, open, keep, children })` (a heading that folds its group, sliding, remembered on the device), `navGroup({ name, color, … })` (a group of collections, the same in every module), `setCurrent()` (an entry, or the foot's trash) |
| `signin.js` | `signIn({ app, config })` → the user; `confirmEmailFromLink()`; `signOut({ local, ask, before })` → true when it left, which also deletes every app's copy on the device (`clearDeviceCopies()`, the `*-local` databases) and has the server forget where this browser's notices come to (`pushEndpoints()`, sent as `push_endpoints` with `POST /api/auth/logout`; the browser's subscription stays); with `ask` it first asks when changes wait on the device (`pendingChanges()`, every `*-local` queue and the preferences kept), and without an answer from the server (no signal, a 5xx) it deletes nothing and stays; `leave({ answer, local })`, the same way out without the request, which Settings takes once the account is deleted |
| `settings.js` | `openSettings({ … })`; `settingsAsked()`; `settingsConfig()`; `subscribePush()`; `deviceName()` |
| `signal.js` | `watchSignal({ ask, answered, onBack, active, again, firstMs, maxMs, url, patienceMs })`: the one question «is there a signal again?» every module asks while it has none (`/version`, from 3 s up to 30 s apart): `lost()`, `check()` → whether the server answered, `found()`, `stop()` |
| `settings-queue.js` | Settings without a signal: `connection` (whether the server answers), `save()` (a preference sent, or kept for later), `flushSettings()` (what was kept, sent once the server answers: the kit's frame calls it when it starts), `forgetSettings()` |
| `connect.js` | The suite's own page at `/devices/connect` (with `devices.connectPage`, device-pages.js): an account allows a phone, signing in in place first with local accounts; `showConnect()`, `connectRequestOf()`, `cancelAddress()`. Not for an app to import: the suite serves it |
| `shared.js` | `sharedSection({ load, kinds, setPermission, remove, leave, accept, open })`: Settings › Sharing; `sharedPage()`, the same page elsewhere. An app with roles of its own passes `permissions`, as to the share dialog (or a function of the item, when they differ from one to another) |
| `share.js` | `shareDialog({ base, name, me, people, words })`: who has something, inviting by email and by one's people, changing and taking back, leaving; through sharing.js' routes or the app's own functions. An app with roles of its own passes `permissions` (and `fixed`, `confirmRemove`); whoever `load` answers `manage: true` for shares as its owner does |
| `public-page.js` | `publicDialog({ base, name, url, words, onChange, read, turnOn, turnOff, embedHeight, parent })`: a public page's dialog for its owner (reads it without turning it on; its link, the code to embed it on Pro, turning it off), in the kit's words (`kit.public.*`) and the module's for what it shows (`words`); `embedCode(url, name, { height })`. `public-page.css` is the page's own frame (shared.html): its ground and column, the bar with the way to start one's own (on a phone, the icon and a button that may shrink: nothing past the screen), the footer, `.sp-embedded`, `.sp-refused`, `.sp-gone`; the module's sheet after it draws the rest |
| `people.js` | `peopleChips(people, { onChange })`: the people one already shares with, as chips to pick under a share dialog's email; `shareWithEach(targets, shareOne)`: every share, then one notice |
| `shared.js` | `sharedSection({ load, kinds, setPermission, remove, leave, accept, open })`: Settings › Sharing; `sharedPage()`, the same page elsewhere. An app with roles of its own passes `permissions`, as to the share dialog (or a function of the item, when they differ from one to another) |
| `plan.js` | What Settings' plan section sells (`plan: { billing: true }`); `offerPlan(err, { open })` for a 402 anywhere; `billingReturn({ onPlan, open })` back from the checkout; `offerFounder({ user, busy })` for a host's shell, as it starts; `isPlanError`, `offerFor`, `isLive`, `productText`, `PLAN_EVENT` |
| `update.js` | `watchUpdates({ onUpdate })`, `applyUpdate()`, `tidyAddress()` |
| `live.js` | `connectLive({ onChange, onResync, onAccount, onState })` |
| `time-zone.js` | `reportTimeZone(user, { send })`: the browser's zone into `prefs.tz`, once per change; `browserTimeZone()` |
| `local.js` | `openLocal(appId, stores)`: IndexedDB stores of key → value; `memoryLocal()` |
| `outbox.js` | `createOutbox({ local, owner, … })`: changes made offline, sent once each and only with their owner's session; a busy server (429, 408, 425) keeps them and is tried again after its `Retry-After` (v0.250.0); `keepOnly(id)`; `sendWhileAway({ local, owner, send, onCreated, skip })`, what an app left queued sent while it isn't on the page, only what goes cleanly (v0.250.0); `tempId()`, `isTempId()` |
| `markdown.js` | `renderMarkdown(source, { onTaskToggle, resolveImage })`, `parseMarkdown`, `toggleTask`, `titleOf`, `plainText`, `safeHref`, `safeImage` |
| `sw-core.js` | `suiteWorker({ version, shell, optional, push, skip, modules })` for the app's service worker (a classic script), from its scope: `/`, or a module's path in a host; `modules` for a host's one worker |
| `worker.js` | `registerWorker()`: the app's /sw.js, or in a host with one worker (host.js `worker`) the host's, retiring the modules' own and carrying their notices over; `hostWorker()`, `workerRegistration()`, `noticesToRenew()` |
| `base.js` | `BASE` and `at(path)`: where the app is served from, `/` on its own and `/tasks/` as a module of a host, read from the kit's own address; the kit's requests go through it |
| `qr.js` | `qrSvg(text, { label })` |
| `push.js` | `pushSupport()`, `devicePushSubscription(publicKey, { ask })`: notices on a device the app keeps, with no account, posted to the app's own route |
| `drag.js` | `makeDraggable(container, { items, check, onDrop, … })`: picking something up from a list and dropping it on a place; `redrawInPlace(container, draw)`: drawing a list again whole without it moving |
| `swipe.js` | `rowSwipe(row, { content, left, right, ignore })`: a finger across a row, to the trash to the left and the module's quick toggle to the right (v0.248.0); `keepSwipe(row)`, a row with nothing to do that keeps the finger; `trashAction(run)`; `swipeAction`, `swipeStretch`, `SWIPE_IGNORE` |
| `celebrate.js` | `celebrate(origin, { root })` when something is done: confetti from an element or a `{ x, y }` (in the open dialog it is in, else `root`, else the body) and a "ding"; `playStep()`, the soft note of a part done; `celebratePrefs()`, `setCelebratePref(key, on)`: `animation` and `sound`, on this device (`suite.celebrate`, else Tasks' `tasks.celebrate`), chosen in Settings › Language and theme |
| `keyboard.js` | `fitToKeyboard({ reveal })`: the frame, Settings, dialogs and notices fitted above a phone's keyboard; `focusOnTap(area, { focus, skip })`: a tap that starts typing without the view sliding up; `watchKeyboard(onChange)`: told when a keyboard makes the page itself shorter |
| `native.js` | The bridge to the suite's app on a phone (v0.106.0): `inApp()`, `nativeInfo()`, `can(capability)`; `setBadge()`, `setReminders()`, `nativePurchase()`, `openExternal()`, `nativeSignOut()`, `haptic()`, `openAppSettings()`, `nativeReady()`, `postNative()`; `onNative(type, handler)`, `lastNative(type)`; `hostShellAddress(host)` (v0.230.0). Nothing outside the app |

### Components in the sheet alone

Some of the kit's components are CSS with no script: an app writes the classes on its own markup.

| Class | What it is |
| --- | --- |
| `kit-btn` (`--primary`, `--quiet`, `--danger`, `--danger-quiet`, `--small`, `--block`), `kit-icon-btn` (`--small`, 34 px in a row), `kit-link` | Buttons |
| `kit-field` (`> label`, or `> .kit-field__label` for a group), `kit-input`, `kit-hint`, `kit-error`, `kit-check` | Fields, as `field()` makes them |
| `kit-chip` (`--tint` with `--kit-chip`, `--large`; a `button` with `aria-pressed`) | Something said of an item, or a filter to press |
| `kit-swatches` > `kit-swatch` (`--kit-swatch`; `aria-pressed`, `aria-checked` or `--on`) | A colour to choose |
| `kit-round-check` (`--done` or `aria-pressed`; `--kit-tick-lift` for another size) | A task's round check |
| `kit-group-title` | The heading of a group in a list |
| `kit-avatar` (`--tiny` 20, `--small` 26, `--large` 34 px) | A person, as `avatar()` makes it |
| `kit-segmented` | One choice among a few, as `segmented()` makes it |
| `kit-blank` (`--page`), `kit-empty` | Nothing here yet, as `blank()` makes it; a view's whole page |

Their colours are the kit's variables, and an app names no other in its own sheet for what the kit
has: `--kit-accent`, `--kit-on-accent`, `--kit-accent-soft`, `--kit-bg`, `--kit-side`,
`--kit-panel`, `--kit-hover`, `--kit-text`, `--kit-muted`, `--kit-faint`, `--kit-border`,
`--kit-border-strong`, `--kit-danger`, `--kit-warn`, `--kit-ok`, `--kit-shadow`,
`--kit-radius` (10 px), `--kit-radius-small` (8 px), `--kit-radius-large`. An app keeps names of
its own only for its domain (a list's colour, a project's state). Layouts change at the brand's
widths, `--cr-bp-phone` (640 px) and `--cr-bp-tablet` (860 px): `@media` and `@container` read no
variable, so a rule writes the number.

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
  foot: { create: { items: () => [newNotebookItem, newGroupItem] }, trash: { href: '#/trash' } },
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
name and icon, the live dot, the module's search, its entries and, with `foot`, a foot that makes
collections and has the trash; `create` is the floating button over the list. On a phone, `showDetail()`
moves to the detail and the bar's back button returns (`onBack`, or `showList()`); the sidebar is a
drawer behind ☰. A swipe from the screen's start edge does what the button there does (opens the
drawer, or goes back from a detail) instead of Safari's back in the history, and one from the end
edge does nothing instead of its forward. Over a page that covers the frame with a way back of its
own (Settings), the start edge goes back there: such a page calls `holdBack(node, back, slide)`
(ui.js) while it is open and lets go with the function it returns. Going back follows the finger:
the screen on top slides away over the one it goes back to and, on lifting, goes or returns by how
far or how fast the finger went. A phone's detail slides over its list; a held page says what moves
and what it uncovers with `slide()` → `{ moving, under, show(on) }`. On a phone the drawer follows the finger, out from the
edge and back over it, and opens or closes by how far the finger went. Opened by a finger or the mouse, the drawer takes the
focus itself, with no ring drawn; opened with Enter or Space on ☰ (`openDrawer({ keyboard: true })`),
the focus goes to the current entry. With `panes: 'single'` there is one view in
`shell.list`. There is no button for the person at the sidebar's foot (v0.224.0): on its own, the
app's icon and name at the sidebar's head are a button, with Settings' icon in place of an arrow,
that opens Settings (`onSettings`), where the account is and Sign out closes the profile.
Only with `accountItems`, or without `onSettings`, it opens a menu instead: the app's entries,
Settings, Administration (for admins, at `/admin`) and Sign out. `setUser()` keeps who is signed
in for that menu.
As a module of a host (a page under `/<mount>/`, Cronum Work), from
640 px a rail at the sidebar's start has the host's mark (not a link, v0.104.0), the modules the person uses (one too) and
Settings at its foot, and the app's icon is only its mark. On a phone the drawer has no rail: the
app's icon and name open a menu with the other modules and, last, Settings; with no other module
(installed on its own) they open Settings, as in an app on its own. So does a
computer's when the host couldn't be asked (offline), until it answers. The host's last answer is
kept on the device (`host.modules`): the rail is drawn with the frame, and again when the host
answers. From one module to another one page fades into the next (`@view-transition` in kit.css,
200 ms, the rail standing still), in browsers that
have view transitions and not for whoever asks for less motion; the host names each module page's code in its answer (§21.4 of the architecture).
`setLive(state)` paints the dot, `showBanner(id, …)` / `hideBanner(id)` keep one banner per id.

**The module's search** (`search: { label, onInput(text), onSubmit?(text) }`) is the sidebar's
first line, the same in every module (rule 9, v0.249.0). Its field reads the kit's «Buscar»
(`kit.side.search`) in `--kit-faint`, in either theme and look, and `label`, the module's own words,
is its `aria-label`: as the words in it they were cut short. `placeholder` would replace the word;
no module of the suite gives one. Its line height is its own (1.45), so the page's doesn't make it
taller in one module than in another. Escape empties it; Enter in a phone's drawer closes the
drawer, so the results show. «/» goes to it, and its key (`kbd.kit-side__search-key`, hidden from a
screen reader) says so at the field's end only where a keyboard is likely: a pointer that hovers and
is fine, and the sidebar beside the views; never while the field has the focus or text. On the
document, without Ctrl, ⌘
or Alt, not while composing nor once something answered it (`preventDefault`), not from a field or
an editor, and not with a dialog, a menu, Settings or a drag over the frame; only in the frame that
has the keyboard, as Escape (the focus on no element and `active`, or the focus inside it). Over a
phone's detail the list comes back first, and a closed drawer or a sidebar folded away opens.
`shell.search` is the field.

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
app's `applyTheme`, and a language to `registry.language.set`. On a phone a sideways swipe in the
window brings the module beside it (windows.js), but never from a row: `rowSwipe()` and
`keepSwipe()` mark it `data-own-swipe` (anything else with a sideways gesture of its own may say
so too, Notes' drawing sheet), so a finger that starts there is the row's alone. Escape with the
focus on no element closes the detail of the window that has the keyboard, and «/» goes to its
search: the module passes `createShell({ active: ctx.active })`. Told nothing, the frame has the
keyboard while windows.js marks its window the one in front (`data-focus="true"` on the window
that holds `root`, v0.249.0), so Next's, which passes none, has it too; `active` given wins.
Anywhere else nothing changes.

**Drawing the frame again.** The frame listens on the document (touches at the screen's edges,
drags) and, in a host, on the window. An app that builds a new frame without reloading the page (a
new language, a refresh, closing one view for another) calls `shell.destroy()` on the old one first:
every listener it added goes (they share one `AbortController`; the click swallowed just after a
drag of the drawer is removed by hand), an account or modules menu it opened
closes, and its element leaves the page, so the old frame can be collected. Calling it again does
nothing. Without it, each old frame kept its listeners: a tap within 20 px of the start edge was passed
on once per frame ever made (the drawer opened and closed at once), and none of them was freed.

From 640 px the sidebar sits beside the views and can be **folded away**: the button at its head
folds it, the bar comes back with ☰ to unfold it (a swipe from the edge does too), and the floating
button stays where it was. The device remembers it per app, under `<app.id>.sidebar`
(`'collapsed'` or `'visible'`). `onFold(folded)` says the views' width changed, for whatever is drawn
to it (a Gantt, a timeline); `shell.folded` says how it is. Something picked up while it is folded
brings it over the views as a drawer, as on a phone. An app that lays out its own columns from
960 px (Tasks, Projects) gives their `[data-folded]` version too; on a phone nothing of this
applies, whatever was chosen on a computer.

**A view's head** (`shell.head({ pane, title, lead, actions, below })`) is the same in every
app: the view's title and, at its end, the view's «…» (`actions: moreButton(items)`), and,
wherever the sidebar isn't beside the views (a phone, or folded away), ☰ at its start; over a
phone's detail (`pane: 'detail'`), ← instead. Nothing in it creates (v0.247.0): that is the
floating button. It returns `{ element, setTitle }`; the app puts `element`
at the top of its view (it sticks there while the view scrolls) and makes a new one when it draws
the view again. A pane showing a head takes the bar's place: one line less, and the same layout in
every app and on any screen. `lead` goes before the title (a list's icon, a note's notebook),
`below` under its line, inside the head (a search, chips, a toolbar). An app that shows no head
in a pane keeps the bar there, as before.

**A detail's head** (`pane: 'detail'`, rule 5) closes it the same way at every width: ← at its
start where the list is a screen of its own, and where the list sits beside it (`panes: 'split'`
from 960 px, folded or not), where ← doesn't show, the kit's × last on the line (`kit-head__close`,
«Cerrar», `kit.close`). Both call `createShell({ onBack })` (by default `showList()`), so a
module's own × goes. `close: false` leaves the × out, for a detail that must not close beside its
list. `actions` holds the item's toggles (Notes' pin) and its «…», `lead` the place it lives in.

```js
const head = shell.head({
  pane: 'detail', title: null,
  lead: notebookChip(note),                          // where it lives
  actions: [pinButton(note), moreButton(() => [      // its toggles, then «…»
    ...ownItems(note), shareItem(note), publicPageItem(note), 'separator',
    { label: t('notes.toTrash'), iconName: 'trash', danger: true, onClick: () => trash(note) },  // Undo
  ])],
});
```

**Escape** closes the detail too, as ← or × would: whichever shows, so a detail with no × beside
its list stays. It is left alone while something over the detail had the key as it was pressed (a
dialog, a menu, Settings, the drawer, a drag), each of which closes itself with it; once something
on its way answered it (`preventDefault`: a module's own layer does, on itself or capturing on the
document); and from a field or an editor (`input`, `textarea`, `select`, `contenteditable`), where
Escape keeps its own job and nothing typed is lost. With the focus on no element, only the frame
that has the keyboard closes its detail (`createShell({ active })`: in Work's shell `ctx.active`;
on a page of its own, always); with the focus somewhere, the frame it is in. A module drops its
own Escape for the detail.

**«…»** (`moreButton(items, { label })`, ui.js) is a `kit-icon-btn` with the kit's «…» icon, named
«Más opciones» (`kit.more`) unless `label` says otherwise, `aria-haspopup="menu"`. A press opens
`menu()` under it with `items`, or with what `items()` returns then, so the menu says what is
possible at that moment; a second press closes it, and the press goes no further (a row doesn't
open, the drawer doesn't close). `menu()` leaves out a falsy item and a separator with nothing to
separate (first, last or after another), so a module writes `canShare ? shareItem : null`.

**What creates an item** (`create: { label, onClick }`) is the floating + at every width: on a
phone over the list, as before, and hidden on the detail that covers it; beside the views at the
bottom end corner of the pane that holds the list (`panes: 'split'`: the list's, never over the
detail beside it; `panes: 'single'`: the view's), folded or not. It is placed in the frame's grid,
not on the screen, so in Cronum Work it stays inside the module's window. Its `label` is its
accessible name and the words a pointer resting on it shows. What it covers at the end of a list is
the module's to leave room for (a bottom padding of about 88 px in the list).

**The sidebar's foot** (`foot: { create, trash }`, each optional) makes collections (a list, a
notebook, a group of them) and keeps the trash: a + at its start (`kit-side__add`, «Crear»,
`kit.side.create`, unless `create.label`) and the trash at its end (`kit-side__trash`, «Papelera»,
`kit.side.trash`). `create` is `{ onClick }`, or `{ items }` (an array, or a function that returns
one) for a menu that opens over the drawer; each choice, and the trash, closes the drawer as an
entry does. `trash` is `{ onClick }` (a dialog: Tasks, Projects) or `{ href, current }` (a view of
its own: Notes' `#/trash`). The foot never scrolls away: the nav scrolls above it, on a phone and
beside the views, and the room over the phone's bottom edge (`--kit-safe-bottom`) is under the
foot; in a window of Work there is none. It goes with the sidebar when that is folded.
`shell.foot` is `{ element, create, trash }` (null without a foot), and `setCurrent(shell.nav,
shell.foot.trash)` marks the trash as the place open, as it marks an entry.

**A group of collections** (`navGroup()`) is the same in every module: a head in the group's
colour (a 3 px border at its start, a tint behind, its name halfway between that colour and the
text's; plain rows in the Clean look) and its collections a step in under it.

```js
nav.append(navGroup({
  name: group.name, color: group.color, icon: group.icon,     // an emoji or a node; iconName: the kit's
  count: notesIn(group), open: !folded.has(group.id), keep: openIsIn(group),
  onToggle: (open) => remember(group.id, open),                // folding is the module's to keep
  onName: (event, name) => menu(name, groupItems(group)),      // its menu: rename, new notebook here…
  extra: group.shared ? sharedBadge() : null,                  // after the name
  empty: t('groups.empty'), children: notebooks.map(notebookItem),
  data: { group: group.id }, headData: { groupDrop: group.id }, bodyData: { notebooksOf: group.id },
}));
```

The chevron (`kit-nav-group__toggle`, «Plegar X» / «Desplegar X») folds it, sliding as `navFold`
does, and tells `onToggle(open)`; folded, the head shows `count`. The name (`kit-nav-group__name`)
opens the group's menu through `onName(event, name)`, anchored on it; without `onName` it folds the
group too. It is a `span` with `role="button"`, pressed with Enter or Space, so the group can still
be picked up by its head (drag.js starts on no `<button>`). Neither closes the drawer. `keep` opens
it whatever `open` says: the collection open is in it. `data`, `headData` and `bodyData` become
data-* attributes of the group, its head and its body, for the module's own drags.

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

An app's web view can stop above the keyboard instead (Work's iPhone app): then the page itself is
shorter and what is fixed to its foot sits on the keyboard. `watchKeyboard(onChange, { signal })`
tells `onChange(true)` while that is so and a field (or a frame) has the focus, measured on the
root against its tallest height at that width, and `onChange(false)` when the room comes back
(not when the focus leaves, which comes first, while the page is still short; a page still short a
second after it, with nothing typed in, wasn't a keyboard's). Work's windows (windows.js) give the desk `data-keyboard` with it, and a phone's
tabs step aside.

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
change. A host with a daily summary and push (`app.host.day`, v0.231.0, architecture §21.3.2) has
its section in the host's group, «Daily summary» (`id: 'day'`): the morning's and the evening's
notice, each a switch, a time in steps of five minutes and a link to its page (in Work's shell, a
window of its own through the shell's `open`; from a module's page, `/?open=…`), saved as
`prefs.day` with `PATCH /api/me` at the host's root.

**Settings › Sharing** (`shared.js`, v0.94.0) is a section an app adds to `sections`: everything
the person shares, each with who has it, whether they accepted and what they may do (view or
edit, changed there; taken back there), and everything shared with them (accept, decline or
leave). The app gives `load()` → `{ mine, withMe }` and how each change is made; the kit draws
it and asks `load()` again after every change. Tasks shows its lists there; Notes its groups,
notebooks and notes. An app whose people have roles of its own passes `permissions`, the share
dialog's `[{ value, label, offered }]` (Projects: manages, can edit, read only), or a function of
the item when they differ (only a project's owner names a manager): two are buttons with their
names, more a list, and a role not offered is said on whoever has it, their row left as it is.

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
notebooks and notes. An app whose people have roles of its own passes `permissions`, the share
dialog's `[{ value, label, offered }]` (Projects: manages, can edit, read only), or a function of
the item when they differ (only a project's owner names a manager): two are buttons with their
names, more a list, and a role not offered is said on whoever has it, their row left as it is.

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
  whatever the module passes: always `hideCheckout`; where the app sells (`can('purchase')`), the
  install does too (`modules.stores` or the host's `app.host.stores`, with STORE_BILLING) and the
  section is there (`plan`, or the host's `app.host.plans`), `plan.open` is the app's store
  (`storePurchase()`: the `purchase` message) and the section adds "See plans" to it, for whoever
  has a plan above theirs or theirs ending on a date, and pays for nothing yet; where it doesn't,
  a 402 says only why.
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
- Anywhere else in a host's module made with `createShell({ onSettings })` it comes on its own (0.254.0):
  a 402 met by any call of the kit's `api` is kept for ten seconds by its sentence, and the first
  error notice that says it (`toast(errorMessage(err), { error: true })`, as every module says its
  errors) gets "See plans", which closes a dialog still open (the form that met it, 0.256.1) and opens
  Settings at Plan. Once, and only for those words: any other
  notice is left as it is. `setPlanOpener(open)` is what the shell gives (`null` when it goes); a
  page without a shell can give its own. `plan_limit` says what it limits, as Usage counts it:
  «Tu plan (Free) permite 20 listas y ya tienes 20.», «… 50 MB de espacio …».
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
| `panel` | `{ open }`, true or false | Cronum Work's shell, with `postNative`: one of its panels over the desk (the day's summary, the calendar) opened, or the last one closed; told when it changes, and a page that loads has none. While one is open, going back never leaves it: the app (0.5.11) turns iOS's swipe from the edge off, and sends Android's back to the page as `back` |

`postNative(type, payload)` sends any message, for one the kit has no helper for yet; the payload
never changes `v` or `type`.

**The app to the web**: a `cronum-native` CustomEvent on the window (`NATIVE_EVENT`), its `detail`
`{ v: 1, type, ... }` (an object, or the same as JSON). `onNative(type, handler)` hears one type and
returns the function that stops it; `lastNative(type)` is the last one of that type since the page
loaded.

| `type` | Detail | What the kit does |
| --- | --- | --- |
| `purchase-result` | `{ product, status }`: `purchased`, `pending`, `canceled`, `failed` or `closed` (the app's own screen left, nothing tried: nothing is said) | `storePurchase()` says it in a notice; bought, it reads the plan again and sends it as `kit-plan` (`PLAN_EVENT`), which an open Settings repaints with |
| `push-state` | `{ state }`: `granted`, `denied` or `undetermined` | Settings › Notifications says when the phone has them off |
| `back` | — | Android's back while a `panel` is open, in place of going back: Cronum Work's shell closes the panel |

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

A host's module page loaded on its own in the app, neither a frame nor a window of the host's
one-document page, goes there with itself in a window (v0.230.0): `createShell()` replaces it with
`/?open=<its path>` (`hostShellAddress(host)`), once the host's answer of last time or of now says
it has that page (`/api/modules`' `host.shell`). A notice tapped on the phone opens its module's
address (`/projects/?project=5`), which the app's web view loaded as the module alone, with its
switcher and without Work's tabs. Outside the app, in a browser or a module installed alone, it
stays where it is.

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
With `owner: () => id` (whoever the server said is signed in, null while it isn't known) each change
keeps whose it is: nothing goes while the owner isn't known, and one of another account (a session
that ended, then someone else on the same browser) leaves the queue unsent (`report.others`);
`keepOnly(id)` lets go of them at once. A change kept before it had an owner goes as before.
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
  a row's swipe (`rowSwipe()`, below) doesn't start, and a refresh that redraws the list waits.
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
- While something is carried (`data-kit-dragging`) or a row is swiped (`data-kit-swiping`) it
  doesn't draw: it waits for `kit-dragend` or `kit-swipeend` and draws once, with the last `draw`
  it was given, however many times it was asked meanwhile. It answers `true` when it drew, `false`
  when it waits.

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

### Swiping a row

A finger across a row of a list acts on that row, the same in every module (rule 6, v0.248.0):
what the row shows slides over the colour, the icon and the words of what letting go will do,
faint and grey until the finger has gone far enough, then in the action's colour with a little
buzz. It was Tasks' own swipe, made the kit's (`swipe.js`):

```js
import { rowSwipe, keepSwipe, trashAction } from '/suite/swipe.js';

rowSwipe(row, {
  left: mayTrash(task) ? [trashAction(() => trash(task))] : [],     // «Borrar» in red; trash() offers Undo
  right: () => [                                                     // asked as the swipe starts
    { label: starWords(task), iconName: 'star', tone: 'accent', run: () => toggleStar(task) },
    { label: myDayWords(task), iconName: 'sun', tone: 'sun', run: () => toggleMyDay(task) },
  ],
});
keepSwipe(stepRow);                                                  // nothing to do: swiping does nothing
```

- `left` and `right` are each one action or two, in the order the finger reaches them: the first
  at 82 px, the second at 168 (with one, it is reached at 82 and stays further). Past 230 px the
  row comes harder, a quarter of the finger's way. Each is `{ label, iconName, tone, run }`, or a
  function that returns them, asked when the swipe starts, so the words say what the row is now
  («Fijar» or «Quitar»). `tone` is the colour once reached: `danger`, `accent` (the default), `sun`
  (yolk, "now": My Day) or `done`. `trashAction(run, { label })` is the trash's, the kit's «Borrar»
  (`kit.delete`). With nothing that way, the row doesn't move that way. Letting go short of an
  action, or after coming back, does nothing; letting go past it runs it, and the row slides back.
- **Touch only.** A mouse or a trackpad never swipes: the row's menu does the same.
- **Where it starts.** Anywhere on the row but on what keeps its own finger inside it (`ignore`,
  `SWIPE_IGNORE` by default: fields, editors, labels, the round check, the buttons and links in it;
  the row itself may be a button or a link, as Notes' is), within 28 px of the screen's start edge
  (the drawer's, and going back), or on something inside it that slides sideways (a row of chips
  wider than its box, or with `touch-action: pan-x`), which keeps scrolling.
- **What it isn't.** 12 px across before it is a swipe; more than 12 px down first, and more down
  than across, is the list's scroll. A finger that held still before it moved (drag.js' hold,
  380 ms) is picking the row up, and a drag under way (`data-kit-dragging`) is never a swipe: the
  drag wins. If the system takes the touch away midway (`pointercancel`), the row slides back and
  nothing is done.
- **The finger is the row's.** The row has `data-own-swipe` (Cronum Work's windows don't switch
  module from it, windows.js) and `kit-swipe` with `touch-action: pan-y` (kit.css), and once it is a
  swipe the touch's moves are kept from the browser, so the list doesn't scroll under it. A row with
  nothing to do gets the same with `keepSwipe(row)` (or `rowSwipe(row)`), without a listener: a
  sideways finger on it does nothing at all. Not for rows that lie in something that scrolls sideways
  (Next's line, the Gantt): `pan-y` there would take that scroll away.
- **Not a click.** Letting go after a swipe doesn't open the row.
- **Right to left** it is mirrored: `right` is towards the line's end, a swipe to the left there,
  and the start edge is the right one.
- **What slides** (`content`) is the row's one child when it has one (Tasks' `.task-inner`, which
  then has `kit-swipe__content` and a background of its own), the colour under it, inside the row,
  whose edges cut it (`data-swipe="under"`); else the row itself (Notes' button), the colour beside
  it in the room it leaves (`data-swipe="beside"`). The colour (`kit-swipe__bg`, with
  `kit-swipe__action`, `kit-swipe__icon`, `kit-swipe__label`; `data-side`, `data-tone` and
  `data-armed` while swiped) is made the first time the row is swiped, not in every row of every
  list, and is hidden from screen readers: the same actions are in the row's menu.
- **While a row is swiped** it has `data-swiping` (then `data-swipe-settling` while it slides back),
  `<html>` has `data-kit-swiping`, and the document hears `kit-swipestart` and `kit-swipeend`
  (`detail.row`): `redrawInPlace()` waits for the end, as for a drag's, and so can anything else that
  would draw the row again under the finger. The action runs after `kit-swipeend`.
- `rowSwipe()` returns `{ destroy }`: its listeners, its colour and its marks go. A row drawn again
  is a new row, swiped anew.

### Photos before they travel

`prepareUpload(file, { keepGif, asIs, maxBytes })` (`web/images.js`) → `{ blob, name }` ready to
send as an upload's body. A PDF goes as it is; so does a GIF (it may move; `keepGif: false` makes
it a JPEG like the rest) and a picture the page made itself (`asIs: true`: a drawing's PNG, whose
strokes a JPEG would blur). A picture under 500 kB and 2000 px that the server takes (JPEG, PNG,
WebP) goes as it is; anything bigger, or of a kind the server refuses (an iPhone's HEIC), is
decoded with its orientation applied, drawn on white and made a JPEG of 2000 px at most on its long
side, named `.jpg`. What weighs more than `maxBytes` is refused before spending data, with the
sentence to show (`kit.images.*`): `uploadLimit(config)` reads the server's limit from
`/api/auth/config` (`app.uploads.max_bytes`), `MAX_BYTES` (15 MB) where it says none.
`fileSize(bytes)` writes what a file weighs in the person's language, the unit too (French "Mo").

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
