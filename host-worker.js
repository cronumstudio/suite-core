/**
 * A host's one service worker, at /sw.js with the scope `/` (host.js `worker`).
 *
 * Without it, every module of a host registers its own (/tasks/sw.js, with
 * the scope /tasks/), and an app installed from the host's page has as many
 * copies, updates and push subscriptions as modules: a notice of Tasks reached
 * a phone once for each module's worker, titled with the module's name. With
 * it, the host writes one worker that keeps the host's pages and every
 * module's shell, shows every notice as the host's, and opens the module it
 * came from; the modules' pages retire their own workers and carry their
 * notices over to it (web/worker.js).
 *
 * Nothing is written by hand: each module's shell is read from its own
 * public/sw.js, the file the app uses on its own (`suiteWorker({ shell, … })`,
 * run here with nothing but that function), and the host's from its public
 * folder. The worker's version is the fingerprint of everything the browser
 * loads, the host's, the kit's and every module's, so a new release is a new
 * worker that brings every copy in at once; the same fingerprint is the
 * host's /version and /js/app-version.js, for one notice of a new version for
 * the whole app (web/update.js).
 *
 * An app on its own never comes here: its /sw.js is its own file, as always.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';

/** What the browser loads, for the fingerprint: as app.js counts it for an app. */
const FRONT = /\.(js|css|html|json|webmanifest)$/;
/** What of the host's own folder goes into the worker's copy. */
const KEPT = /\.(js|css|html|json|webmanifest|svg|png|ico|woff2)$/;
/** More files than a public folder of a host has: a folder that big is not one. */
const MOST = 400;

/** The files of a folder, sorted, as paths relative to it with forward slashes. */
function filesOf(dir, test) {
  const found = [];
  const walk = (folder, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MOST) return;
      const relative = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(folder, entry.name), relative);
      else if (test.test(entry.name)) found.push(relative);
    }
  };
  if (dir) walk(dir, '');
  return found;
}

/**
 * The fingerprint of a folder's front-end files, as app.js makes an app's:
 * names, sizes and dates. → { version, built }
 */
export function fingerprint(dir) {
  let newest = 0;
  const parts = [];
  for (const rel of filesOf(dir, FRONT)) {
    try {
      const stat = fs.statSync(path.join(dir, rel));
      parts.push(`${rel}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch { /* a file just moved */ }
  }
  return {
    version: crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12),
    built: newest ? new Date(newest).toISOString() : null,
  };
}

/** One fingerprint of several (`[name, { version, built }]`): the newest date of them. */
export function combine(prints) {
  const version = crypto.createHash('sha1')
    .update(prints.map(([name, print]) => `${name}:${print.version}`).join('|')).digest('hex').slice(0, 12);
  const built = prints.map(([, print]) => print.built).filter(Boolean).sort().pop() || null;
  return { version, built };
}

/** A path of a module's worker (`css/app.css`, `./`, `/js/x.js`) as a path of the site under `base`. */
function atBase(base, url) {
  try {
    const resolved = new URL(String(url), `http://host.invalid${base}`);
    return resolved.pathname.startsWith(base) || `${resolved.pathname}/` === base ? resolved.pathname + resolved.search : null;
  } catch {
    return null;
  }
}

/**
 * What a module's own worker keeps (`shell`, `optional`), read from its
 * public/sw.js and placed under its path. → { shell, optional }; empty
 * without a file or with one that isn't `suiteWorker({ … })`, but its page
 * always: the module opens offline at least.
 */
export function moduleShell(publicDir, mount, { log = () => {} } = {}) {
  const base = `/${mount}/`;
  const found = { shell: [base, `${base}index.html`], optional: [] };
  const file = publicDir ? path.join(publicDir, 'sw.js') : null;
  if (!file || !fs.existsSync(file)) return found;
  let options = null;
  try {
    const sandbox = {
      importScripts: () => {},
      suiteWorker: (given) => { options = given; },
      self: { registration: { scope: `http://host.invalid${base}` } },
    };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file, timeout: 1000 });
  } catch (err) {
    log(`[host] /${mount}/sw.js couldn't be read for the host's worker: ${err.message}`);
    return found;
  }
  const place = (list) => (Array.isArray(list) ? list.map((url) => atBase(base, url)).filter(Boolean) : []);
  return {
    shell: [...new Set([...found.shell, ...place(options?.shell)])],
    optional: [...new Set(place(options?.optional))],
  };
}

/** The host's own pages and files, from its public folder: a folder's index.html is also the folder. */
export function hostShell(publicDir, extra = []) {
  const files = filesOf(publicDir, KEPT).filter((rel) => rel !== 'sw.js');
  const paths = [];
  for (const rel of files) {
    if (rel === 'index.html' || rel.endsWith('/index.html')) paths.push(`/${rel.slice(0, -'index.html'.length)}`);
    paths.push(`/${rel}`);
  }
  return [...new Set([...paths, ...extra])];
}

/** The worker's script: sw-core.js from the host's kit, and what it keeps. */
export function workerScript({ name, options }) {
  return `/* ${name}'s service worker, written by its host (suite-core host.js \`worker\`, host-worker.js):\n`
    + '   the host\'s pages and every module\'s, one copy, one notice of a new version and one\n'
    + '   subscription for notices. A new release is a new version of it. */\n'
    + "importScripts('/suite/sw-core.js');\n\n"
    + `suiteWorker(${JSON.stringify(options, null, 2)});\n`;
}

/**
 * A module's notices as the host's worker needs them: what the server says
 * the notice opens is the module's path (`/?list=4` → `/tasks/?list=4`, or the
 * module's page without one), its tag is the module's (two modules' notices
 * with the same tag would replace each other), and `module` says whose it is.
 * The modules' own workers, where a device still has them, read the same
 * paths as before (sw-core.js: a path under the module's is left as it is).
 */
export function hostedPush(push, mount) {
  const base = `/${mount}/`;
  const sitePath = (url) => typeof url === 'string' && url.startsWith('/') && !url.startsWith('//');
  const mark = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
    const given = payload.url;
    const url = !sitePath(given) ? base
      : given.startsWith(base) || given === `/${mount}` ? given : `/${mount}${given}`;
    return { ...payload, url, tag: `${mount}-${payload.tag ?? 'notice'}`, module: mount };
  };
  const each = (payload) => (typeof payload === 'function' ? (sub) => mark(payload(sub)) : mark(payload));
  return {
    ...push,
    send: (subscription, payload, options) => push.send(subscription, mark(payload), options),
    deliver: (subscriptions, payload, options) => push.deliver(subscriptions, each(payload), options),
  };
}
