/**
 * The addresses the apps had on their own, answered by the host for a while
 * after they move into it (`LEGACY_DOMAINS`, host.js). It is a bridge, meant
 * to be taken down: with the variable empty nothing of this runs.
 *
 *   LEGACY_DOMAINS=tasks.example.com=tasks,notes.example.com=notes
 *
 * On each of those domains, pointed at the host:
 *
 * - `/mcp` answers 404 with the host's (`{ error, mcp }`): the apps' own
 *   connectors are gone, and the host's /mcp serves every module. The OAuth
 *   metadata (`/.well-known/oauth-*`) answers 404 too.
 * - `/sw.js` is a service worker that removes itself and opens the module in
 *   the host: the app installed from the old address stops showing what it
 *   kept and lands in the host.
 * - Everything else goes to the module in the host (302, 307 for a write): the
 *   same path under `/<mount>/`. Temporary on purpose, so nothing is cached
 *   for good while the bridge is up.
 */
import { sendJson, securityHeaders } from './http.js';

/** A host name with at least one dot, lowercase, no port and no scheme. */
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Reads `LEGACY_DOMAINS`: `domain=mount` entries separated by commas (or
 * spaces). Every mount must be a module of the host, and no domain the host's
 * own or given twice.
 * @returns {{ domains: Map<string, string>, errors: string[] }}
 */
export function parseLegacyDomains(value, { mounts, baseUrl }) {
  const domains = new Map();
  const errors = [];
  const own = new URL(baseUrl).hostname.toLowerCase();
  const entries = String(value || '').split(/[\s,]+/).filter(Boolean);
  entries.forEach((entry, i) => {
    const [domain, mount, extra] = entry.split('=').map((part) => part.trim().toLowerCase());
    if (extra !== undefined || !domain || !mount) {
      errors.push(`LEGACY_DOMAINS: entry ${i + 1} is not domain=module`);
    } else if (!DOMAIN.test(domain)) {
      errors.push(`LEGACY_DOMAINS: entry ${i + 1} is not a domain name (no scheme, port or path)`);
    } else if (!mounts.includes(mount)) {
      errors.push(`LEGACY_DOMAINS: entry ${i + 1} names "${mount}", which is not a module of this host (${mounts.join(', ')})`);
    } else if (domain === own) {
      errors.push(`LEGACY_DOMAINS: entry ${i + 1} is the host's own address`);
    } else if (domains.has(domain)) {
      errors.push(`LEGACY_DOMAINS: ${domain} is given twice`);
    } else {
      domains.set(domain, mount);
    }
  });
  return { domains, errors };
}

/** The service worker an old address serves: it goes, and its pages open the module in the host. */
const farewellWorker = (target) => `// This app moved to ${target}
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const key of await caches.keys()) await caches.delete(key);
  await self.registration.unregister();
  for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(${JSON.stringify(target)});
})()));
`;

/**
 * @param {object} options
 * @param {Map<string, string>} options.domains   domain → mount, from parseLegacyDomains
 * @param {string} options.baseUrl   the host's address
 * @param {boolean} [options.https]
 */
export function createLegacyDomains({ domains, baseUrl, https }) {
  const base = String(baseUrl).replace(/\/+$/, '');

  /** The old address a request came to, or null: the Host header, without its port. */
  function match(req) {
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    return domains.has(host) ? host : null;
  }

  async function handle(req, res, url, domain) {
    const mount = domains.get(domain);
    const pathname = url.pathname;
    const target = `${base}/${mount}/`;

    securityHeaders(res, { https });
    if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
      sendJson(res, 404, { error: 'not_found', mcp: `${base}/mcp` });
      return undefined;
    }
    if (pathname.startsWith('/.well-known/oauth-')) {
      sendJson(res, 404, { error: 'not_found' });
      return undefined;
    }
    if (pathname === '/sw.js' && ['GET', 'HEAD'].includes(req.method)) {
      const body = farewellWorker(target);
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return undefined;
    }

    const read = ['GET', 'HEAD'].includes(req.method);
    res.writeHead(read ? 302 : 307, { Location: `${base}/${mount}${pathname}${url.search}`, 'Cache-Control': 'no-store' });
    res.end();
    return undefined;
  }

  return { match, handle, domains: [...domains.keys()] };
}
