/**
 * The request a piece of code runs for, without handing it down: what a hook
 * that only gets an account (accounts.whenCreated) needs to know of where it
 * came from —its path, a header the proxy in front sets— and nothing more.
 * Every request the suite's server answers runs inside one (runtime.js
 * serverFor); a script, a migration or a job at the start runs in none.
 *
 *   inRequest(req, () => handle(req, res), res);
 *   currentRequest();   // → { req, res, path } or null
 *
 * `res` is for a hook that adds to the request's answer: a cookie it clears (affiliates.js, the
 * code's cookie once the account it brought is made). Null when the caller gave none.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage();

/**
 * Runs `fn` as the work of `req`. The path is read now, before any router
 * rewrites `req.url` (a host strips its modules' prefixes).
 */
export function inRequest(req, fn, res = null) {
  return scope.run({ req, res, path: String(req?.url || '').split('?')[0] }, fn);
}

/** The request this code runs for, or null outside one. */
export function currentRequest() {
  return scope.getStore() ?? null;
}

/**
 * Whether the request is the administrator's, making accounts for others: /api/admin/… and the
 * administrator's connector (admin-mcp.js). What a hook does for someone who signs up (a notice, a
 * code's cookie) is not for those.
 */
export const byTheAdmin = (current) => Boolean(current)
  && (current.path.startsWith('/api/admin/') || current.path === '/admin/mcp');
