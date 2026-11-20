/**
 * Where a module is (web/mount.js createPlace): the page's address on its own page, its window's
 * route in Cronum Work's one-document shell, told to and by the shell through the ctx its mount()
 * is given; the mount's signal; and what each module reads of the shell where they read it
 * differently (`active`). A page and a shell made of plain objects, no browser.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlace } from '../web/mount.js';

/** A page of its own: its address, its history and its listeners, as createPlace reaches them. */
function fakePage({ pathname = '/', search = '', hash = '' } = {}) {
  const page = {
    replaced: [],
    reloads: 0,
    listeners: [],
    location: {
      pathname, search, hash,
      get href() { return `https://app.example${this.pathname}${this.search}${this.hash}`; },
      reload: () => { page.reloads += 1; },
      replace: (to) => { page.replacedBy = to; },
    },
    history: { replaceState: (state, title, url) => page.replaced.push([state, url]) },
    addEventListener(type, fn, { signal } = {}) {
      if (signal?.aborted) return;
      const entry = { type, fn };
      page.listeners.push(entry);
      signal?.addEventListener('abort', () => page.listeners.splice(page.listeners.indexOf(entry), 1), { once: true });
    },
    /** The browser's `hashchange`, once the hash moved. */
    moveHash(next) {
      page.location.hash = next;
      for (const { type, fn } of [...page.listeners]) if (type === 'hashchange') fn({ type });
    },
  };
  globalThis.window = page;
  globalThis.document = { body: { name: 'body' } };
  return page;
}

/** The window's ctx, as Work's shell gives it (shell/work.js contextOf): what the module told it, kept. */
function fakeCtx(route = '') {
  const shell = new AbortController();
  const ctx = {
    now: route,
    calls: [],
    told: [],
    focused: true,
    late: false,
    titled: 0,
    signal: shell.signal,
    shell,
    services: { theme: { current: () => 'dark' } },
    route: () => ctx.now,
    navigate: (...args) => {
      ctx.calls.push(args);
      ctx.now = args[0];
    },
    onRoute: (fn, options) => ctx.told.push({ fn, options }),
    active: () => ctx.focused,
    retitle: () => { ctx.titled += 1; },
    lateCode: () => ctx.late,
  };
  return ctx;
}

test('on its own page a module routed by its address reads it after its base, writes it only to tidy it, and watches nothing', () => {
  const page = fakePage({ pathname: '/tasks/list/3', search: '?task=389', hash: '#x' });
  const here = createPlace({ base: '/tasks/' });
  const { place } = here;
  assert.equal(place.mounted, false);
  here.placeIn(document.body, null);
  assert.equal(place.embedded, false);
  assert.equal(place.root, document.body);
  assert.equal(place.mounted, true);
  assert.equal(place.active, true, 'the keyboard is always its own');
  assert.equal(place.services, null);
  assert.equal(place.lateCode(), false, 'no shell to ask');
  assert.equal(here.route(), 'list/3?task=389#x');

  // The view is the app's state there: a step moves nothing; a replace keeps the path and takes the
  // route's query, as history.replaceState with that route would.
  here.navigate('?list=1');
  assert.deepEqual(page.replaced, []);
  assert.equal(page.location.hash, '#x');
  here.navigate('?app', { replace: true });
  assert.deepEqual(page.replaced, [[null, 'https://app.example/tasks/list/3?app']]);
  here.onRoute(() => assert.fail('nothing moves the route under it'));
  assert.equal(page.listeners.length, 0);
  assert.doesNotThrow(() => place.retitle());
  assert.equal('reload' in place, false, 'only where asked for');
});

test('on its own page a module routed by its hash moves the page\'s hash, as the browser\'s history does', () => {
  const page = fakePage({ search: '?settings=line', hash: '#/p/12' });
  const here = createPlace({ hash: true });
  here.placeIn(document.body, null);
  assert.equal(here.route(), '#/p/12', 'the hash alone, not the query before it');

  const heard = [];
  const watching = new AbortController();
  here.onRoute((route) => heard.push(route), { signal: watching.signal });
  here.navigate('#/overview');
  assert.equal(page.location.hash, '#/overview');
  page.moveHash('#/p/3');
  assert.deepEqual(heard, ['#/p/3'], 'told the route, as the page has it');
  // Said again without a step back to it: no `hashchange`.
  here.navigate('#/p/3/b/2', { replace: true });
  assert.deepEqual(page.replaced, [[null, '#/p/3/b/2']]);
  watching.abort();
  assert.equal(page.listeners.length, 0, 'the listener goes with its signal');
});

test('in a window of Cronum Work the route is the window\'s, told and taken through the shell, and the page\'s address is left alone', () => {
  const page = fakePage({ hash: '#/somebody-else' });
  for (const hash of [false, true]) {
    const ctx = fakeCtx('?settings=templates#/notebook/3');
    const here = createPlace({ hash });
    const { place } = here;
    const root = { name: 'window' };
    here.placeIn(root, ctx);
    assert.equal(place.embedded, true);
    assert.equal(place.root, root);
    assert.equal(place.services, ctx.services);
    assert.equal(here.route(), '?settings=templates#/notebook/3', 'the window\'s whole route');

    // A step as the shell has always been told one, and a replace with its option.
    here.navigate('#/notebook/3/n/55');
    here.navigate('#/notebook/3/n/56', { replace: true });
    assert.deepEqual(ctx.calls, [['#/notebook/3/n/55'], ['#/notebook/3/n/56', { replace: true }]]);
    const fn = () => {};
    const routing = new AbortController();
    here.onRoute(fn, { signal: routing.signal });
    assert.equal(ctx.told.length, 1);
    assert.equal(ctx.told[0].fn, fn, 'the shell calls the module\'s own function');
    assert.equal(ctx.told[0].options.signal, routing.signal);

    assert.equal(place.active, true);
    ctx.focused = false;
    assert.equal(place.active, false, 'the keyboard is its only while its window has the focus');
    place.retitle();
    assert.equal(ctx.titled, 1);
    assert.equal(place.lateCode(), false);
    ctx.late = true;
    assert.equal(place.lateCode(), true, 'asked each time');
    ctx.now = null;
    assert.equal(here.route(), '', 'a window with no route yet');
    here.placeOut();
  }
  assert.equal(page.location.hash, '#/somebody-else', 'the page\'s own hash, never the window\'s');
  assert.deepEqual(page.replaced, []);
  assert.equal(page.listeners.length, 0, 'nothing listens on the page\'s window');
});

test('what the shell says of the focus is read as each module reads it, and a shell from before a question breaks nothing', () => {
  fakePage();
  const said = (value, options) => {
    const ctx = fakeCtx();
    ctx.active = () => value;
    const here = createPlace(options);
    here.placeIn({}, ctx);
    return here.place.active;
  };
  // By default what it says: nothing said is no focus (Notes, Next).
  assert.deepEqual([true, false, undefined, null].map((v) => said(v)), [true, false, false, false]);
  // Anything but a no keeps it (Tasks); only a yes or a no counts (Projects).
  assert.deepEqual([true, false, undefined, null].map((v) => said(v, { active: (s) => s !== false })), [true, false, true, true]);
  assert.deepEqual([true, false, undefined, null].map((v) => said(v, { active: (s) => s ?? true })), [true, false, true, true]);

  const old = { route: () => '#/', navigate() {} };
  const here = createPlace({ active: (s) => s ?? true });
  here.placeIn({}, old);
  assert.equal(here.place.active, true, 'a shell that can\'t say leaves the keyboard where the module chose');
  assert.doesNotThrow(() => here.place.retitle());
  assert.equal(here.place.lateCode(), false);
  assert.doesNotThrow(() => here.onRoute(() => {}));
  assert.equal(here.place.services, null);
});

test('the mount\'s signal: its own, aborted on leaving, on mounting again and by the shell; or the one the module gives', () => {
  fakePage();
  const here = createPlace();
  const first = here.placeIn({}, fakeCtx());
  assert.equal(here.place.signal, first);
  assert.equal(first.aborted, false);
  here.placeOut();
  assert.equal(first.aborted, true, 'leaving aborts what the mount listened to');
  assert.equal(here.place.signal, undefined);
  assert.equal(here.place.embedded, false);
  assert.equal(here.place.mounted, false);
  assert.equal(here.place.root, document.body, 'nowhere: the page\'s, as on its own');

  const ctx = fakeCtx();
  const second = here.placeIn({}, ctx);
  const third = here.placeIn({}, ctx);
  assert.equal(second.aborted, true, 'mounted again: the one before goes');
  ctx.shell.abort();
  assert.equal(third.aborted, true, 'the shell aborting its own aborts the mount\'s');

  const given = new AbortController();
  assert.equal(here.placeIn({}, fakeCtx(), { signal: given.signal }), given.signal);
  assert.equal(here.place.signal, given.signal);
  here.placeIn({}, fakeCtx(), { signal: null });
  assert.equal(here.place.signal, null, 'a module may give none');
  here.placeOut();
  assert.equal(given.signal.aborted, false, 'one the module gave is the module\'s to abort');
});

test('reload, where asked for: the page again; fresh on its own page skips what the browser kept, in Work the shell\'s page loads again', () => {
  const page = fakePage({ pathname: '/projects/', search: '?project=3' });
  const here = createPlace({ reload: true });
  here.placeIn(document.body, null);
  here.place.reload();
  assert.equal(page.reloads, 1);
  here.place.reload({ fresh: true });
  assert.match(page.replacedBy, /^\/projects\/\?fresh=\d+$/);
  here.placeIn({}, fakeCtx());
  here.place.reload({ fresh: true });
  assert.equal(page.reloads, 2);
});

test('a module\'s own members join the kit\'s: getters, setters and methods, one standing for the kit\'s', () => {
  const page = fakePage({ hash: '#/a' });
  let late = 0;
  const here = createPlace({
    hash: true,
    own: {
      get hash() { return here.route(); },
      set hash(next) { here.navigate(next); },
      part(name) { return `${here.place.root.name}:${name}`; },
      get lateCode() {
        late += 1;
        return here.lateCode();
      },
    },
  });
  const { place } = here;
  here.placeIn(document.body, null);
  assert.equal(place.hash, '#/a');
  place.hash = '#/b';
  assert.equal(page.location.hash, '#/b');
  assert.equal(place.part('main'), 'body:main');
  assert.equal(place.lateCode, false, 'a getter where the module reads one');
  assert.equal(late, 1);
  assert.equal(place.embedded, false, 'the kit\'s stay');
});
