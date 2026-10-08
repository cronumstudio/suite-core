/*
 * The service worker of every app, from Tasks' (sw.js v25). A classic
 * script, because module service workers aren't everywhere yet; an app's
 * /sw.js is a few lines:
 *
 *   importScripts('/suite/sw-core.js');      // or 'suite/sw-core.js', relative to the worker
 *   suiteWorker({
 *     version: 'notes-v1',                       // up when the shell changes: the old cache goes
 *     shell: ['/', '/index.html', '/css/app.css', '/js/main.js', '/js/app-version.js', '/i18n/en.json',
 *             '/manifest.webmanifest', '/icons/favicon.svg?v=1'],
 *     optional: ['/i18n/es.json', '/i18n/fr.json', '/i18n/de.json'],
 *     push: { title: 'Notes', icon: '/icons/icon-192.png?v=1', badge: '/icons/badge-96.png?v=1' },
 *   });
 *
 * What it does, and why:
 * - The shell is installed from the server, not the browser's HTTP cache
 *   (`cache: 'reload'`): otherwise a new version stored the old icons and code.
 * - The kit's own files (/suite/…) join the shell by themselves.
 * - Code, styles, catalogs and the kit: network first with `cache: 'no-cache'`
 *   (a proxy in front turned "network first" into hours of old code), but
 *   not forever: after four seconds with a weak signal the copy is served,
 *   and the network's answer still refreshes it for next time.
 * - Never cached: /api, /mcp, /auth, /oauth, /.well-known, /version, /health.
 *   /version above all: served from a cache, the app would never learn that
 *   there is a new version, which is what it exists for.
 * - Pages: network first, with the cached shell offline.
 * - Other files (icons): the copy at once, refreshed behind the scenes.
 *
 * Every path above is the app's, read from the worker's scope: an app on its
 * own has `/`, and a module of a host (suite-core host.js) has its own path,
 * `/tasks/`, where its /api is /tasks/api. Its cache is named after the scope,
 * and each worker clears only its own old caches: a host's modules share one
 * origin, and one module's update must not empty another's copy. A host's own
 * worker at `/` leaves its modules' paths alone with `skip: ['/tasks/', …]`.
 * On its own, an app sees nothing different: the scope is `/`, the cache keeps
 * its name and the paths are the ones it always had.
 */

var SUITE_KIT_FILES = [
  '/suite/tokens.css', '/suite/kit.css',
  '/suite/fonts/geist-latin.woff2', '/suite/fonts/geist-latin-ext.woff2',
  '/suite/fonts/geist-mono-latin.woff2', '/suite/fonts/space-grotesk-latin.woff2',
  '/suite/theme.js', '/suite/base.js', '/suite/dom.js', '/suite/i18n.js', '/suite/api.js', '/suite/icons.js', '/suite/ui.js',
  '/suite/shell.js', '/suite/update.js', '/suite/live.js', '/suite/local.js', '/suite/outbox.js',
  '/suite/signin.js', '/suite/settings.js', '/suite/markdown.js', '/suite/qr.js', '/suite/drag.js',
];

var SUITE_NEVER = ['/api/', '/mcp', '/auth/', '/oauth/', '/.well-known/'];
var SUITE_EXACT_NEVER = ['/version', '/health'];
var SUITE_WAIT_MS = 4000;

/** The worker's scope as a path: `/` for an app on its own, `/tasks/` for a module of a host. */
function suiteScopeOf(registration) {
  try { return new URL(registration.scope).pathname; } catch (err) { return '/'; }
}
var SUITE_SCOPE = suiteScopeOf(self.registration);

/** A path of the site as the app names it (`/tasks/api/x` → `/api/x`), or null outside the scope. */
function suiteLocal(pathname, scope) {
  if (scope === '/') return pathname;
  if (pathname + '/' === scope) return '/';
  return pathname.indexOf(scope) === 0 ? pathname.slice(scope.length - 1) : null;
}

/** A path of the app (`/suite/kit.css`) at the scope (`/tasks/suite/kit.css`). */
function suiteAt(pathname, scope) {
  return scope === '/' || pathname.indexOf('/') !== 0 || pathname.indexOf('//') === 0 ? pathname : scope + pathname.slice(1);
}

/** The worker's cache: the version on its own, as it always was; with the scope before it in a host. */
function suiteCacheName(version, scope) {
  return scope === '/' ? version : scope + version;
}

/**
 * Whether a cache is this worker's to clear when it takes over: every other
 * one under its scope. Caches of `/` never start with a slash, a module's
 * always do, so a host's worker and its modules' never clear each other's.
 */
function suiteOwnsCache(key, scope) {
  return scope === '/' ? key.indexOf('/') !== 0 : key.indexOf(scope) === 0;
}

/** Whether a path is code that changes with a deploy: network first. */
function suiteIsCode(pathname) {
  return pathname.indexOf('/js/') === 0 || pathname.indexOf('/css/') === 0 || pathname.indexOf('/suite/') === 0
    || pathname.indexOf('/i18n/') === 0 || pathname === '/manifest.webmanifest';
}

/** Whether a request must always reach the server. */
function suiteNeverCached(pathname) {
  return SUITE_EXACT_NEVER.indexOf(pathname) >= 0
    || SUITE_NEVER.some(function (prefix) { return pathname.indexOf(prefix) === 0; });
}

/**
 * The network, but not forever: after `wait` the copy is served when there is
 * one; without a copy the network is waited for. A network that fails
 * outright gets the copy at once.
 */
function suiteNetworkFirst(network, fallback, wait) {
  return new Promise(function (resolve) {
    var done = false;
    var finish = function (response) { if (!done) { done = true; resolve(response); } };
    var timer = setTimeout(function () {
      fallback().then(function (copy) { if (copy) finish(copy); });
    }, wait);
    network.then(
      function (response) { clearTimeout(timer); finish(response); },
      function () {
        clearTimeout(timer);
        fallback().then(function (copy) { finish(copy || Response.error()); });
      });
  });
}

function suiteWorker(options) {
  var scope = options.scope || SUITE_SCOPE;
  var version = suiteCacheName(options.version, scope);
  var kitFiles = SUITE_KIT_FILES.map(function (file) { return suiteAt(file, scope); });
  var shell = (options.shell || []).concat(options.kit === false ? [] : kitFiles);
  var optional = options.optional || [];
  var push = options.push || null;
  var wait = options.wait || SUITE_WAIT_MS;
  var skip = options.skip || [];
  var skipped = function (pathname) {
    return skip.some(function (prefix) { return pathname.indexOf(prefix) === 0 || pathname + '/' === prefix; });
  };

  var store = function (request, response) {
    if (!response || !response.ok) return response;
    var copy = response.clone();
    caches.open(version).then(function (cache) { cache.put(request, copy); });
    return response;
  };

  self.addEventListener('install', function (event) {
    event.waitUntil(caches.open(version)
      .then(function (cache) {
        return cache.addAll(shell.map(function (url) { return new Request(url, { cache: 'reload' }); }))
          .then(function () {
            // Nice to have offline, never a reason for the install to fail.
            return Promise.all(optional.map(function (url) {
              return cache.add(new Request(url, { cache: 'reload' })).catch(function () {});
            }));
          });
      })
      .then(function () { return self.skipWaiting(); })
      .catch(function () { return self.skipWaiting(); }));
  });

  self.addEventListener('activate', function (event) {
    event.waitUntil(caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (key) { return key !== version && suiteOwnsCache(key, scope); })
          .map(function (key) { return caches.delete(key); }));
      })
      .then(function () { return self.clients.claim(); }));
  });

  self.addEventListener('fetch', function (event) {
    var request = event.request;
    if (request.method !== 'GET') return;
    var url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    var local = suiteLocal(url.pathname, scope);
    // Outside the scope, a path a host's module has, or one that must reach the server: left alone.
    if (local === null || skipped(url.pathname) || suiteNeverCached(local)) return;

    if (request.mode === 'navigate') {
      event.respondWith(suiteNetworkFirst(fetch(request), function () {
        return caches.match(suiteAt('/index.html', scope)).then(function (page) { return page || caches.match(scope); });
      }, wait));
      return;
    }

    if (suiteIsCode(local)) {
      var network = fetch(request, { cache: 'no-cache' }).then(function (response) { return store(request, response); });
      // The copy may be served first: the network's answer still refreshes it.
      event.waitUntil(network.catch(function () {}));
      event.respondWith(suiteNetworkFirst(network, function () { return caches.match(request); }, wait));
      return;
    }

    event.respondWith(caches.match(request).then(function (cached) {
      var fresh = fetch(request).then(function (response) { return store(request, response); });
      if (!cached) return fresh;
      event.waitUntil(fresh.catch(function () {}));
      return cached;
    }));
  });

  if (!push) return;

  // The server writes the title and text in the language of whoever receives
  // them; the app's name is only the fallback.
  self.addEventListener('push', function (event) {
    var data = {};
    try { data = event.data ? event.data.json() : {}; } catch (err) { data = { body: event.data && event.data.text() }; }
    event.waitUntil(self.registration.showNotification(data.title || push.title, {
      body: data.body || '',
      icon: push.icon,
      // Android uses only the alpha channel: the bare glyph.
      badge: push.badge,
      tag: data.tag || push.title,
      renotify: true,
      data: data,
    }));
  });

  self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    var data = event.notification.data || {};
    // A path the server wrote is the app's: in a host it goes under the module's.
    var given = data.url && data.url.indexOf('/') === 0 && data.url.indexOf('//') !== 0 ? data.url : null;
    var target = given ? (suiteLocal(given, scope) === null ? suiteAt(given, scope) : given) : (push.url || suiteAt('/?app', scope));
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      // The app already open gets the focus and the notice, instead of a second window.
      for (var i = 0; i < clients.length; i++) {
        var open = new URL(clients[i].url);
        if (open.origin === self.location.origin && suiteLocal(open.pathname, scope) !== null && !skipped(open.pathname)) {
          clients[i].postMessage({ type: 'notification', data: data });
          return clients[i].focus();
        }
      }
      return self.clients.openWindow(target);
    }));
  });
}

self.suiteWorker = suiteWorker;
self.suiteScopeOf = suiteScopeOf;
self.suiteLocal = suiteLocal;
self.suiteAt = suiteAt;
self.suiteCacheName = suiteCacheName;
self.suiteOwnsCache = suiteOwnsCache;
