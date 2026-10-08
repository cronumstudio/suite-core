/**
 * Lets Node load an app's browser modules for its tests: what they import from
 * /suite/ (the web kit, which the server serves from server/suite/web) is found
 * on disk. An app's smoke test imports it (`import './server/suite/tools/web-resolve.mjs'`)
 * and passes it with --import to the processes it starts to run browser code.
 */
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('/suite/')) return next(pathToFileURL(path.join(WEB, specifier.slice('/suite/'.length))).href, context);
    return next(specifier, context);
  },
});
