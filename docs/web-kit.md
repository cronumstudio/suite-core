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

## The modules

| File | What it gives |
| --- | --- |
| `tokens.css` | The brand: yolk, ink, cream, the products' colours and accents, the fonts |
| `kit.css` | Every component below, light and dark, logical properties |
| `dom.js` | `el(tag, props, …children)`, `$`, `$$`, `clear`: nodes through `textContent` and `setAttribute`, never HTML in strings |
| `i18n.js` | The same translations for every app: `t(key, vars)` with plurals and numbers written by Intl, `loadLanguage(preference)` (`'auto'` or a language, kept as `<app>.lang`), `savedLanguage`, `changeLanguage`, `translateDom`, and the Intl formats (`dateFormat`, `numberFormat`, `listFormat`, `relativeDay`, `compareText`, `capitalize`, `formatDateTime`) |
| `api.js` | `api.get/post/put/patch/delete/upload`, `api.write(method, path, body, { key })` with an Idempotency-Key; `ApiError`, `SessionExpired`, `Offline`; `errorMessage(err)` in words |
| `icons.js` | `icon(name, { label })`: the suite's icons (`PATHS` lists them); `cronumRing()` |
| `ui.js` | `toast(text, { error, action })`, `banner()`, `saveState()`, `field()`, `switchRow()`, `segmented()`, `blank()`, `avatar()`, `signature()`, `copyText()`, `openDialog()`, `confirmDialog()`, `menu()` |
| `shell.js` | `createShell()`: the frame; `navItem()` (with `data` for its data-* attributes), `navSection()`, `setCurrent()` |
| `signin.js` | `signIn({ app, config })` → the user; `confirmEmailFromLink()`; `signOut({ local })` |
| `settings.js` | `openSettings({ … })`; `subscribePush()`; `deviceName()` |
| `update.js` | `watchUpdates({ onUpdate })`, `applyUpdate()`, `tidyAddress()` |
| `live.js` | `connectLive({ onChange, onResync, onAccount, onState })` |
| `local.js` | `openLocal(appId, stores)`: IndexedDB stores of key → value; `memoryLocal()` |
| `outbox.js` | `createOutbox({ local, … })`: changes made offline, sent once each; `tempId()`, `isTempId()` |
| `markdown.js` | `renderMarkdown(source, { onTaskToggle, resolveImage })`, `parseMarkdown`, `toggleTask`, `titleOf`, `plainText`, `safeHref`, `safeImage` |
| `sw-core.js` | `suiteWorker({ version, shell, optional, push, skip })` for the app's service worker (a classic script), from its scope: `/`, or a module's path in a host |
| `base.js` | `BASE` and `at(path)`: where the app is served from, `/` on its own and `/tasks/` as a module of a host, read from the kit's own address; the kit's requests go through it |
| `qr.js` | `qrSvg(text, { label })` |
| `drag.js` | `makeDraggable(container, { items, check, onDrop, … })`: picking something up from a list and dropping it on a place |

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
edge does nothing instead of its forward. With `panes: 'single'` there is one view in
`shell.list`. The person's button is at the sidebar's foot, with their name (in the drawer on a
phone). It opens Settings
(`onSettings`), where Sign out closes the profile.
Only with `accountItems`, or without `onSettings`, it opens a menu instead: the app's entries,
Settings, Administration (for admins, at `/admin`) and Sign out.
`setLive(state)` paints the dot, `showBanner(id, …)` / `hideBanner(id)` keep one banner per id.

From 640 px the sidebar sits beside the views and can be **folded away**: the button at its head
folds it, the bar comes back with ☰ to unfold it (a swipe from the edge does too) and the `create`
button moves into the bar. The device remembers it per app, under `<app.id>.sidebar`
(`'collapsed'` or `'visible'`). `onFold(folded)` says the views' width changed, for whatever is drawn
to it (a Gantt, a timeline); `shell.folded` says how it is. Something picked up while it is folded
brings it over the views as a drawer, as on a phone. An app that lays out its own columns from
960 px (Tasks, Projects) gives their `[data-folded]` version too; on a phone nothing of this
applies, whatever was chosen on a computer.

### Sign-in and settings

`signIn()` shows the screen and resolves with the user. It handles local accounts with their
second step, a forgotten password, the `?reset=` and `?signup=` links and open sign-up, or a button
to WorkOS or an OpenID Connect provider.

`openSettings()` opens the sections every account has —profile, language and theme, password and
sign-in (two-step verification, sessions), the AI (MCP address, connected apps, tokens),
notifications (`push: true`), plan (`plan: true`), the app's own `sections`, data (when the app
declares it), Administration and About— over the app. The profile is saved with `PATCH /api/me`,
which is the app's route (Next's is the model: `display_name`, `email`, `theme`, `prefs.lang`);
everything else is the suite's. `aiExtra()` and `aboutExtra()` add a block (Next's standing
instruction, an app's tips).

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
registers it at its base (`navigator.serviceWorker.register(at('/sw.js'))`). On its own those are
the same URLs as before; in a host they are the module's, and the worker reads everything else
(the API, the kit, its cache's name) from its scope.

## Texts

Every text a person reads comes from the catalogs: the kit's are `kit.*` in suite-core's
`i18n/<lang>.json`, merged with the app's at `/i18n/<lang>.json`. Every app does it the same way:

- **Catalogs**: `public/i18n/<lang>.json`, flat (dotted keys), in the four languages.
- **Browser**: `t()` and the rest from `/suite/i18n.js`, nothing of its own. Before signing in the
  app loads `savedLanguage()` (what this browser keeps as `<app>.lang`, `'auto'` by default), and
  then the account's choice; Settings calls `loadLanguage` or `changeLanguage` (`app:language`
  tells the app to draw itself again). An app keeps only what is its own domain, like how Next
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
