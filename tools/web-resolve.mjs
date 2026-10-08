/**
 * Lets Node load an app's browser modules for its tests: what they import from
 * the web kit, which the server serves at <base>suite/ from server/suite/web, is
 * found on disk. Either as `/suite/x.js`, or relative to the app's pages
 * (`../suite/x.js` from public/js/), as an app that also runs as a module of a
 * host writes it: public/suite/ never exists, the kit is what is meant. An app's
 * smoke test imports it (`import './server/suite/tools/web-resolve.mjs'`) and
 * passes it with --import to the processes it starts to run browser code.
 */
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
/** The kit as a page of an app reaches it, relative to its base. */
const KIT_IN_PAGES = /\/public\/suite\/(.+)$/;

const inKit = (file) => pathToFileURL(path.join(WEB, file)).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('/suite/')) return next(inKit(specifier.slice('/suite/'.length)), context);
    if (/^\.\.?\//.test(specifier) && context.parentURL?.startsWith('file:')) {
      const kit = KIT_IN_PAGES.exec(new URL(specifier, context.parentURL).pathname);
      if (kit) return next(inKit(decodeURIComponent(kit[1])), context);
    }
    return next(specifier, context);
  },
});
