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
 * A host's one worker (host-worker.js) also has `push.icons`, each module's own icon by its path
 * (`{ tasks: '/tasks/icons/icon-192.png' }`): a notice that says which module sent it (`module`,
 * put on by the host) shows that module's icon, and anything else the host's.
 *
 * What it does, and why:
 * - The shell is installed from the server, not the browser's HTTP cache
 *   (`cache: 'reload'`): otherwise a new version stored the old icons and code.
 * - The kit's own files (/suite/…) join the shell by themselves.
 * - Code, styles, catalogs and the kit: network first with `cache: 'no-cache'`
 *   (a proxy in front turned "network first" into hours of old code), but
 *   not forever: after four seconds with a weak signal the copy is served,
 *   and the network's answer still refreshes it for next time.
 * - Never cached: /api, /mcp, /auth, /oauth, /.well-known, /version, /health,
 *   /devices/session and /devices/connect.
 *   /version above all: served from a cache, the app would never learn that
 *   there is a new version, which is what it exists for.
 * - Pages: network first, with the cached shell offline (a host's: the copy
 *   first, below). A page asked for outside a navigation (the browser's checks
 *   before installing) is left to it.
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
 *
 * A host's one worker for everything (host.js `worker`, which writes its /sw.js)
 * passes `modules: ['/tasks/', …]` instead: at `/`, it also serves each module's
 * paths as the module's own worker did (`/tasks/api/…` never cached, `/tasks/js/…`
 * network first, a page of /tasks/ offline is /tasks/index.html), adds the kit at
 * each module's path to its copy, clears the copies of the modules' old workers
 * when it takes over, and a notice tapped opens the module it came from. Its
 * shell is installed file by file: one missing file mustn't leave every module
 * without its copy. And a few at a time (SUITE_AT_ONCE): a new device asked for
 * Work's 200-odd files at once, while its page loaded its modules, and some got a
 * 429 on the way; a module whose code was one of them didn't open.
 *
 * A host's worker also says, with `codeFirst`, that its version is the fingerprint of every
 * file it serves (host-worker.js): then code is the copy first, without asking the network,
 * since a new release of anything is a new worker with a new copy. With `hashes` (`{ path:
 * hash }`), that new copy takes from the old one each file whose hash didn't change, and only
 * the rest travels again. With `sharedKit` (a host and its modules run one suite-core), the
 * kit is kept once, at /suite/, and `/tasks/suite/x` is answered from it: same bytes, one
 * copy instead of one per module.
 *
 * With `codeFirst` a page the copy holds is the copy's too, at once: with a weak signal every
 * start waited four seconds for the network before the page it already had, and after a deploy
 * the network's page came with the copy's code. `serverQueries` (`{ '/': ['modules'] }`) names
 * the addresses where the server answers another page at the same path (host.js
 * `pages[].root.except`): those stay network first. And a host's copy is whole or it isn't
 * installed: a file the network didn't bring (no signal, a 408, a 429, a 5xx) is asked once
 * more, and if it still doesn't come the install fails, so the worker before stays with its
 * copy and the browser tries again at its next check. A file the server hasn't (a 404) is left
 * out, as before, and a page of the shell that a navigation brings fills the hole.
 */

var SUITE_KIT_FILES = [
  '/suite/tokens.css', '/suite/kit.css',
  '/suite/fonts/geist-latin.woff2', '/suite/fonts/geist-latin-ext.woff2',
  '/suite/fonts/geist-mono-latin.woff2', '/suite/fonts/space-grotesk-latin.woff2', '/suite/fonts/inter-latin.woff2',
  '/suite/theme.js', '/suite/base.js', '/suite/dom.js', '/suite/i18n.js', '/suite/api.js', '/suite/icons.js', '/suite/ui.js',
  '/suite/shell.js', '/suite/plan-return.js', '/suite/update.js', '/suite/live.js', '/suite/mount.js', '/suite/local.js', '/suite/outbox.js', '/suite/settings-queue.js',
  '/suite/signin.js', '/suite/signin-form.js', '/suite/settings.js', '/suite/plan.js', '/suite/usage-view.js', '/suite/markdown.js', '/suite/qr.js', '/suite/drag.js', '/suite/swipe.js', '/suite/links.js', '/suite/shared.js', '/suite/people.js', '/suite/share.js', '/suite/ownership.js',
  '/suite/keyboard.js', '/suite/agents.js', '/suite/images.js', '/suite/time-zone.js',
  '/suite/push.js', '/suite/worker.js', '/suite/native.js', '/suite/celebrate.js',
  // The windows of a host with one document (Cronum Work at /w/): without them the app opens blank offline.
  '/suite/windows.css', '/suite/windows.js',
];

var SUITE_NEVER = ['/api/', '/mcp', '/auth/', '/oauth/', '/.well-known/'];
// `/devices/session` spends a one-time code and sets the session cookie (device-pages.js): never a
// copy, nor a page in its place when the network is slow. Nor `/devices/connect`, where the phone's
// sign-in comes back: the home page in its place left the phone waiting.
var SUITE_EXACT_NEVER = ['/version', '/health', '/devices/session', '/devices/connect'];
var SUITE_WAIT_MS = 4000;
/** Where a copy notes the hash of each file it holds (`hashes`): a dotfile, never a path the server has. */
var SUITE_HASHES = '.suite-hashes';
/** How many files a host's worker installs at once: as fast as all at once, measured on Work (3/11). */
var SUITE_AT_ONCE = 12;
/**
 * How long a host's worker waits before asking again for the files the network didn't bring: a
 * signal that comes and goes, or the burst of a page loading its modules meanwhile (the 429s of 3/11).
 */
var SUITE_RETRY_MS = 2000;

/**
 * Whether a file that didn't come is the network's doing, and may come if asked again: no answer,
 * a 408, a 429, the server in trouble. A 404 is a file the server hasn't; asking again won't bring it.
 */
function suiteNetworkFailed(status) {
  return !status || status === 408 || status === 429 || status >= 500;
}

/**
 * `fn` for each of `list`, at most `limit` at a time; done when all are. A failure is its item's
 * alone: the others go on.
 */
function suiteInTurns(list, fn, limit) {
  var next = 0;
  var lane = function () {
    if (next >= list.length) return Promise.resolve();
    var item = list[next++];
    return Promise.resolve().then(function () { return fn(item); }).catch(function () {}).then(lane);
  };
  var lanes = [];
  for (var i = 0; i < Math.min(limit, list.length); i++) lanes.push(lane());
  return Promise.all(lanes);
}

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

/** Whether a path is a page (`/`, `/w/`, `/tasks/list/12`, `/index.html`), not a file of one. */
function suiteIsPage(pathname) {
  var last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return last.indexOf('.') < 0 || /\.html$/.test(last);
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

/**
 * A page from the network, unless the server is in trouble (a deploy's 502, Cloudflare's 52x): then
 * the copy, when there is one. An installed app has no reload button for an error page.
 */
function suitePageOrCopy(network, fallback) {
  return network.then(function (response) {
    if (!response || response.status < 500) return response;
    return fallback().then(function (copy) { return copy || response; });
  });
}

/**
 * The page in the copy that a module's own path is (`/tasks/list/12` → `/tasks/index.html`), as
 * the server answers one without an extension (app.js), or null.
 */
function suiteModulePage(pathname, module) {
  if (!module || pathname === module || pathname.indexOf(module) !== 0) return null;
  return pathname.slice(pathname.lastIndexOf('/') + 1).indexOf('.') < 0 ? module + 'index.html' : null;
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
  // A host's worker: the modules' paths it serves too, each read as the module reads its own.
  var modules = scope === '/' && Array.isArray(options.modules) ? options.modules : [];
  var moduleOf = function (pathname) {
    for (var i = 0; i < modules.length; i++) {
      if (pathname.indexOf(modules[i]) === 0 || pathname + '/' === modules[i]) return modules[i];
    }
    return null;
  };
  // A host's pages that hold every module (Cronum Work's shell, host.js `pages[].root`): a notice
  // opens there, never in a module's page on its own.
  var holds = modules.length && Array.isArray(options.holds) ? options.holds : [];
  // Code from the copy first: only where the version is the fingerprint of everything (a host's).
  var codeFirst = options.codeFirst === true;
  // The query names that make the server answer a page of the copy with another page at the same
  // path (`{ '/': ['modules'] }`: `/?modules` is the home that chooses modules, `/` Work's shell).
  var serverQueries = options.serverQueries && typeof options.serverQueries === 'object' ? options.serverQueries : {};
  var askedOfServer = function (url) {
    var names = Object.prototype.hasOwnProperty.call(serverQueries, url.pathname) ? serverQueries[url.pathname] : null;
    return Array.isArray(names) && names.some(function (name) { return url.searchParams.has(name); });
  };
  // The pages of the shell, by path: one the copy lacks is kept when a navigation brings it.
  var shellPages = function () {
    return shell.filter(function (url) { return typeof url === 'string' && url.indexOf('?') < 0 && suiteIsPage(url); });
  };
  var hashes = options.hashes && typeof options.hashes === 'object' ? options.hashes : null;
  var sharedKit = options.sharedKit === true && modules.length > 0;
  if (!sharedKit) {
    modules.forEach(function (base) {
      shell = shell.concat(options.kit === false ? [] : SUITE_KIT_FILES.map(function (file) { return suiteAt(file, base); }));
    });
  }
  // What a module's page asks at its own path (`/tasks/suite/kit.css`), as the one copy keeps it (`/suite/kit.css`).
  var kitKey = function (local, base) {
    return sharedKit && base !== scope && local.indexOf('/suite/') === 0 ? suiteAt(local, scope) : null;
  };
  // The caches this worker clears when it takes over: its old copies, and the modules' own workers'.
  var replaced = function (key) {
    return key !== version && (suiteOwnsCache(key, scope) || moduleOf(key.split('/').slice(0, 2).join('/') + '/') !== null);
  };

  var store = function (request, response, key) {
    if (!response || !response.ok) return response;
    var copy = response.clone();
    caches.open(version).then(function (cache) { cache.put(key || request, copy); });
    return response;
  };

  /**
   * The newest old copy of this worker's that noted its hashes, with them: `{ cache, hashes }`,
   * or null. Its files whose hash is still the same are the new copy's without travelling.
   */
  var previous = function () {
    if (!hashes) return Promise.resolve(null);
    return caches.keys().then(function (keys) {
      var old = keys.filter(function (key) { return replaced(key) && suiteOwnsCache(key, scope); }).reverse();
      var next = function (i) {
        if (i >= old.length) return null;
        return caches.open(old[i]).then(function (cache) {
          return cache.match(suiteAt('/' + SUITE_HASHES, scope)).then(function (found) {
            return found ? found.json().then(function (noted) { return { cache: cache, hashes: noted || {} }; }) : next(i + 1);
          });
        }).catch(function () { return next(i + 1); });
      };
      return next(0);
    }).catch(function () { return null; });
  };

  /**
   * A file of the shell into the new copy: from the old one when its hash didn't change, else from
   * the server. → 'kept'; 'left' when the server has no such file (a 404) or there is no room for
   * it, as it always was; 'lost' when the network didn't bring it (suiteNetworkFailed).
   */
  var bring = function (cache, old, url) {
    // No room is the device's, not the network's: that file is left out, as before, rather than a
    // full phone that never installs a release again.
    var keep = function (key, response) {
      return cache.put(key, response).then(function () { return 'kept'; }, function () { return 'left'; });
    };
    var load = function () {
      var request = new Request(url, { cache: 'reload' });
      return fetch(request).then(function (response) {
        if (response && response.ok) return keep(request, response);
        return suiteNetworkFailed(response && response.status) ? 'lost' : 'left';
      }, function () { return 'lost'; });
    };
    var same = old && hashes && hashes[url] && old.hashes[url] === hashes[url];
    if (!same) return load();
    return old.cache.match(url).then(function (found) { return found ? keep(url, found) : load(); });
  };

  /**
   * A host's shell into its copy, file by file and a few at a time; what the network didn't bring
   * is asked once more, a moment later. Rejects with `suiteShort` when something still didn't
   * come: the install fails then. → the files left out (a 404), when it doesn't.
   */
  var bringAll = function (cache, old) {
    var left = [];
    var lost = [];
    var take = function (url) {
      return bring(cache, old, url).then(null, function () { return 'left'; }).then(function (verdict) {
        if (verdict === 'lost') lost.push(url);
        else if (verdict === 'left') left.push(url);
      });
    };
    return suiteInTurns(shell, take, SUITE_AT_ONCE)
      .then(function () {
        if (!lost.length) return undefined;
        var again = lost;
        lost = [];
        return new Promise(function (resolve) { setTimeout(resolve, SUITE_RETRY_MS); })
          .then(function () { return suiteInTurns(again, take, SUITE_AT_ONCE); });
      })
      .then(function () {
        if (!lost.length) return left;
        var short = new Error('shell cut short: ' + lost.join(' '));
        short.suiteShort = true;
        throw short;
      });
  };

  self.addEventListener('install', function (event) {
    event.waitUntil(caches.open(version)
      .then(function (cache) {
        var load = function (url) { return new Request(url, { cache: 'reload' }); };
        // A host's: file by file, a missing one is left out rather than every module's copy, and a
        // few at a time, so the page loading its modules meanwhile isn't refused on the way.
        var first = modules.length
          ? previous().then(function (old) { return bringAll(cache, old); }).then(function (left) {
            // What this copy holds, for the next one; written last, and only once the copy is whole,
            // so a copy cut short notes nothing and a file left out isn't taken for one it holds.
            if (!hashes) return undefined;
            var held = {};
            Object.keys(hashes).forEach(function (url) { if (left.indexOf(url) < 0) held[url] = hashes[url]; });
            return cache.put(suiteAt('/' + SUITE_HASHES, scope), new Response(JSON.stringify(held), {
              headers: { 'Content-Type': 'application/json' },
            }));
          })
          : cache.addAll(shell.map(load));
        return first
          .then(function () {
            // Nice to have offline, never a reason for the install to fail.
            var add = function (url) { return cache.add(new Request(url, { cache: 'reload' })).catch(function () {}); };
            return modules.length ? suiteInTurns(optional, add, SUITE_AT_ONCE) : Promise.all(optional.map(add));
          });
      })
      .then(function () { return self.skipWaiting(); })
      .catch(function (err) {
        // A host's copy the network left short: the install fails, so the worker before stays,
        // with the whole copy it has, and the browser tries this one again at its next check (a
        // navigation, the update notice's button). Taking over anyway erased the offline start
        // until the next release. Anything else, as it always was.
        if (err && err.suiteShort) throw err;
        return self.skipWaiting();
      }));
  });

  self.addEventListener('activate', function (event) {
    event.waitUntil(caches.keys()
      .then(function (keys) {
        // A host's worker also clears the copies of the modules' own workers, which it replaces.
        return Promise.all(keys.filter(replaced).map(function (key) { return caches.delete(key); }));
      })
      .then(function () { return self.clients.claim(); }));
  });

  self.addEventListener('fetch', function (event) {
    var request = event.request;
    if (request.method !== 'GET') return;
    var url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    // In a host's worker, a module's path is read as the module reads it: its own base.
    var base = moduleOf(url.pathname) || scope;
    var local = suiteLocal(url.pathname, base);
    // Outside the scope, a path a host's module has, or one that must reach the server: left alone.
    if (local === null || skipped(url.pathname) || suiteNeverCached(local)) return;

    if (request.mode === 'navigate') {
      var fromCopy = function () {
        // The page at its own path first, as the copy kept it: a host whose start is a page of its
        // own (Cronum Work's shell at /, host.js `pages[].root`) keeps that one at /, and its
        // /index.html is the home that chooses modules, which offline opened instead of the shell.
        var own = url.pathname.slice(-1) === '/' ? caches.match(url.pathname) : Promise.resolve(null);
        // A page of a folder of its own (the host's /split/) has its index.html there.
        var page = url.pathname.slice(-1) === '/' && url.pathname !== base ? url.pathname + 'index.html' : null;
        return own
          .then(function (found) { return found || (page ? caches.match(page) : null); })
          .then(function (found) { return found || caches.match(suiteAt('/index.html', base)); })
          .then(function (found) { return found || caches.match(base); });
      };
      if (codeFirst && !askedOfServer(url)) {
        // The copy is this release's, its pages too: a page it holds opens from it at once, with
        // the code it came with. Network first, a weak signal kept every start blank for four
        // seconds before this same page, and after a deploy gave the new page with the old code.
        // Whatever is read from the address (`?w=`, `?open=`, `?auth_error=`) is the page's own
        // code's; what the server reads first never gets here (/auth/, /devices/session…).
        // A module's own path (`/tasks/list/12`) is that module's page: from the copy too, not
        // after the four seconds of a weak signal.
        var modulePage = suiteModulePage(url.pathname, moduleOf(url.pathname));
        event.respondWith(caches.open(version)
          .then(function (cache) {
            return cache.match(url.pathname).then(function (kept) { return kept || (modulePage ? cache.match(modulePage) : null); });
          })
          .then(function (kept) {
            if (kept) return suiteKeptPage(kept);
            // A page the copy lacks: the network's, and kept if it is one of the shell's, so a file
            // an install had to leave out doesn't leave the app without it offline until the next.
            var network = fetch(request).then(function (response) {
              return shellPages().indexOf(url.pathname) >= 0 ? store(request, response, url.pathname) : response;
            });
            return suiteNetworkFirst(suitePageOrCopy(network, fromCopy), fromCopy, wait);
          }));
        return;
      }
      event.respondWith(suiteNetworkFirst(suitePageOrCopy(fetch(request), fromCopy), fromCopy, wait));
      return;
    }

    // A page asked for by something other than a navigation (the browser checking it before
    // installing the app, a prefetch) is the browser's to fetch, as without a worker. Taken for
    // a file, a fetch that failed with no copy came back as an error, and Chrome said Work's
    // split view had no manifest when installing it from there.
    if (suiteIsPage(local)) return;

    if (suiteIsCode(local) && codeFirst) {
      // The copy is this release's: whatever changes comes with a new worker, never asked here.
      // A module's kit sheet scoped to its windows (`/notes/suite/kit.css?scope=work`, host.js
      // scopedSheets) is that module's own answer, never the one copy at /suite/.
      var key = /[?&]scope=/.test(url.search) ? null : kitKey(local, base);
      event.respondWith(caches.open(version)
        .then(function (cache) { return cache.match(key || request); })
        .then(function (cached) {
          // A copy kept from another address (a module's page asked for the kit the copy lacked, and
          // its answer, with its address, went to /suite/) is the host's page's too: at the path asked.
          if (cached) return key || suiteKeptElsewhere(cached, url) ? suiteAsAsked(cached) : cached;
          return fetch(request, { cache: 'no-cache' }).then(function (response) {
            // Kept at /suite/ without the module's address, so the host's pages read it there.
            if (!key) return store(request, response);
            if (response && response.ok) store(request, suiteAsAsked(response.clone()), key);
            return response;
          });
        }));
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
    // In a host, the icon of the module that sent it.
    var own = push.icons && typeof data.module === 'string' && Object.prototype.hasOwnProperty.call(push.icons, data.module)
      ? push.icons[data.module] : null;
    event.waitUntil(self.registration.showNotification(data.title || push.title, {
      body: data.body || '',
      icon: own || push.icon,
      // Android uses only the alpha channel: the bare glyph.
      badge: push.badge,
      tag: data.tag || push.title,
      renotify: true,
      data: data,
    }));
  });

  // The browser (or its push service) renewed the subscription: the server is told the new one,
  // or the notices stopped with nobody knowing (audit of 6/11, pwa-3). The session's cookie goes
  // with it; without one the server refuses and the next start of a page renews it.
  self.addEventListener('pushsubscriptionchange', function (event) {
    var old = event.oldSubscription;
    var made = event.newSubscription
      ? Promise.resolve(event.newSubscription)
      : old && old.options ? self.registration.pushManager.subscribe(old.options) : Promise.resolve(null);
    event.waitUntil(made.then(function (subscription) {
      if (!subscription) return null;
      var json = subscription.toJSON();
      return fetch(suiteAt('/api/push/subscribe', scope), {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, label: String(self.navigator && self.navigator.userAgent || '').slice(0, 120) }),
      });
    }).catch(function () {}));
  });

  self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    var data = event.notification.data || {};
    // A path the server wrote is the app's: in a host it goes under the module's.
    var given = data.url && data.url.indexOf('/') === 0 && data.url.indexOf('//') !== 0 ? data.url : null;
    var target = given ? (suiteLocal(given, scope) === null ? suiteAt(given, scope) : given) : (push.url || suiteAt('/?app', scope));
    if (modules.length) {
      event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(function (clients) { return suiteOpenModule(clients, target, data, moduleOf, holds); }));
      return;
    }
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

/**
 * A copy kept under another path (the kit's one copy at /suite/) as the answer to what the page
 * asked (/tasks/suite/base.js): a response of its own, without the copy's address, so the page
 * reads it at the path it asked. A module's script found at /suite/ would read its base there
 * (base.js, from import.meta.url) and ask /api instead of /tasks/api.
 */
function suiteAsAsked(cached) {
  return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers: cached.headers });
}

/**
 * Whether a copy carries an address other than the one asked (`url`, a URL): kept from
 * /projects/suite/i18n.js at /suite/i18n.js by a worker before 0.267.1, which the next copies take
 * as it is while the file doesn't change. Served as it is, the host's page read Projects' base and
 * catalog, and Work's calendar showed its keys.
 */
function suiteKeptElsewhere(cached, url) {
  if (!cached.url) return false;
  try { return new URL(cached.url).pathname !== url.pathname; } catch (err) { return false; }
}

/**
 * A page of a host's copy as the answer to a navigation: a response of its own, so nothing it came
 * by (a redirect) makes the browser refuse it, and without its `Link` hints (page-hints.js). Those
 * were said to the install, for whoever was signed in then: to a tab with no session now they
 * would preload someone's answers as 401s, which a page that signs in without reloading would
 * read instead of asking again.
 */
function suiteKeptPage(kept) {
  var headers = new Headers(kept.headers);
  headers.delete('Link');
  return new Response(kept.body, { status: kept.status, statusText: kept.statusText, headers: headers });
}

/**
 * A host's notice tapped: the module it came from. Its page already open gets
 * the notice and the focus (in a frame of the split view, the view gets the
 * focus); otherwise a page of the app open goes there, and without one a new
 * window opens it.
 *
 * With `holds`, the host's pages that hold every module (Work's shell at `/` and `/w/`): one of
 * them open gets the address to open (`notification-open`, a type of its own: a module mounted
 * in it listens for `notification`) and the focus, and without one a new window opens the first
 * with `?open=`. Navigating it to the module would take every window away with it.
 */
function suiteOpenModule(clients, target, data, moduleOf, holds) {
  var origin = self.location.origin;
  var mine = clients.filter(function (c) { return new URL(c.url).origin === origin; });
  var top = function (c) { return c.frameType !== 'nested'; };
  if (holds && holds.length) {
    var shell = mine.filter(function (c) { return top(c) && holds.indexOf(new URL(c.url).pathname) >= 0; })[0];
    if (shell) {
      shell.postMessage({ type: 'notification-open', url: target, data: data });
      return shell.focus();
    }
    if (!mine.some(top)) return self.clients.openWindow(holds[0] + '?open=' + encodeURIComponent(target));
  }
  var wanted = moduleOf(new URL(target, origin).pathname);
  var same = wanted ? mine.filter(function (c) { return moduleOf(new URL(c.url).pathname) === wanted; }) : [];
  var page = same.filter(top)[0];
  if (page) {
    page.postMessage({ type: 'notification', data: data });
    return page.focus();
  }
  var frame = same[0];
  var other = mine.filter(top)[0];
  if (frame) {
    frame.postMessage({ type: 'notification', data: data });
    return other ? other.focus() : undefined;
  }
  if (other && typeof other.navigate === 'function') {
    return other.focus()
      .then(function (focused) { return (focused || other).navigate(target); })
      .catch(function () { return self.clients.openWindow(target); });
  }
  return self.clients.openWindow(target);
}

self.suiteWorker = suiteWorker;
self.suiteOpenModule = suiteOpenModule;
self.suiteAsAsked = suiteAsAsked;
self.suiteKeptPage = suiteKeptPage;
self.suiteScopeOf = suiteScopeOf;
self.suiteLocal = suiteLocal;
self.suiteAt = suiteAt;
self.suiteCacheName = suiteCacheName;
self.suiteOwnsCache = suiteOwnsCache;
