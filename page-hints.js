/**
 * What a module's page will ask for as soon as it starts, said with the page
 * itself (a `Link` header), so the browser asks for all of it at once.
 *
 * A module's page is a few lines of HTML whose code comes in modules: main.js
 * imports a dozen files, which import others, and those others; then the
 * catalog in English, the person's language, the install's settings. Each step
 * waited for the one before, one trip to the server each: going from one
 * module to another in a host (Cronum Work) showed an empty screen for over
 * half a second on a computer and a second on a phone, then the frame. With
 * every file of the code and those first answers named in the page's answer,
 * they come together, in about one trip.
 *
 * Read from the module's files: the `<script type="module">` of its
 * index.html and every static import from there (`import … from './x.js'`,
 * the kit's `../suite/…` too), checked again whenever one of them changes.
 * Nothing in a module says what to name, and nothing changes for an app on
 * its own: only the host sends these.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');

/** `import … from '…'`, `import '…'` and `export … from '…'`, at the start of a statement. */
const SPECIFIER = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w*{}\s,$]*?\sfrom\s*)?['"]([^'"\n]+)['"]/g;
/** The scripts a page starts with. */
const ENTRY = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/gi;

/** A path of the app (`/js/main.js`, `/suite/shell.js`) as a file on disk. */
function fileOf(publicDir, urlPath) {
  return urlPath.startsWith('/suite/') ? path.join(WEB_DIR, urlPath.slice('/suite/'.length)) : path.join(publicDir, urlPath);
}

const mtimeOf = (file) => {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
};

/**
 * Every module script a page's static imports reach, as paths of the app
 * (`/js/main.js`). Imports by URL, by a bare name or computed aren't followed.
 */
export function moduleGraph(publicDir) {
  let html;
  try { html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'); } catch { return []; }
  const queue = [...html.matchAll(ENTRY)]
    .map((m) => m[1])
    .filter((src) => !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src))
    .map((src) => new URL(src, 'http://x/').pathname);
  const seen = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    let code;
    try { code = fs.readFileSync(fileOf(publicDir, file), 'utf8'); } catch { continue; }
    seen.add(file);
    for (const [, spec] of code.matchAll(SPECIFIER)) {
      if (!spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('/')) continue;
      queue.push(new URL(spec, `http://x${file}`).pathname);
    }
  }
  return [...seen];
}

/** The first of the browser's languages (`Accept-Language`, in its order) the module speaks. */
export function languageOf(header, languages) {
  for (const part of String(header || '').split(',')) {
    const code = part.trim().slice(0, 2).toLowerCase();
    if (languages.includes(code)) return code;
  }
  return null;
}

/**
 * The hints of each module's page, kept while none of its files changes.
 * → hintsFor({ mount, publicDir, languages }, req) → the `Link` header's value, or null.
 */
export function createPageHints() {
  const kept = new Map();

  function graphOf(mount, publicDir) {
    const was = kept.get(mount);
    if (was && was.files.every((f) => mtimeOf(f.path) === f.mtime)) return was.graph;
    const graph = moduleGraph(publicDir);
    const files = [path.join(publicDir, 'index.html'), ...graph.map((p) => fileOf(publicDir, p))]
      .map((p) => ({ path: p, mtime: mtimeOf(p) }));
    kept.set(mount, { graph, files });
    return graph;
  }

  return function hintsFor({ mount, publicDir, languages = ['en'] }, req) {
    if (!publicDir) return null;
    const graph = graphOf(mount, publicDir);
    if (!graph.length) return null;
    const at = (p) => `/${mount}${p}`;
    const links = graph.map((p) => `<${at(p)}>; rel=modulepreload`);
    // The tab's own version, which the kit's update.js imports when it starts (app.js serves it).
    if (graph.includes('/suite/update.js')) links.push(`<${at('/js/app-version.js')}>; rel=modulepreload`);
    // The kit reads them with fetch(): `crossorigin` is what makes a preload match it.
    const fetched = (p) => `<${p}>; rel=preload; as=fetch; crossorigin`;
    if (graph.includes('/suite/i18n.js')) {
      links.push(fetched(at('/i18n/en.json')));
      const lang = languageOf(req.headers['accept-language'], languages);
      if (lang && lang !== 'en') links.push(fetched(at(`/i18n/${lang}.json`)));
    }
    // What every module asks before it draws, and the host's list of modules for the rail.
    links.push(fetched(at('/api/auth/config')));
    if (graph.includes('/suite/shell.js')) links.push(fetched('/api/modules'));
    return links.join(', ');
  };
}
