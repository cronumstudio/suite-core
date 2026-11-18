/**
 * The request a piece of code runs for, without handing it down: what a hook
 * that only gets an account (accounts.whenCreated) needs to know of where it
 * came from —its path, a header the proxy in front sets— and nothing more.
 * Every request the suite's server answers runs inside one (runtime.js
 * serverFor); a script, a migration or a job at the start runs in none.
 *
 *   inRequest(req, () => handle(req, res));
 *   currentRequest();   // → { req, path } or null
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage();

/**
 * Runs `fn` as the work of `req`. The path is read now, before any router
 * rewrites `req.url` (a host strips its modules' prefixes).
 */
export function inRequest(req, fn) {
  return scope.run({ req, path: String(req?.url || '').split('?')[0] }, fn);
}

/** The request this code runs for, or null outside one. */
export function currentRequest() {
  return scope.getStore() ?? null;
}
