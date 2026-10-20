/**
 * The addresses the apps had on their own, answered by the host for a while
 * after they move into it (`LEGACY_DOMAINS`, host.js). It is a bridge, meant
 * to be taken down: with the variable empty nothing of this runs.
 *
 *   LEGACY_DOMAINS=tasks.example.com=tasks,notes.example.com=notes
 *
 * On each of those domains, pointed at the host:
 *
 * - `/mcp` is the module's connector as the app had it: its tools with their
 *   own names (no `tasks_` before them), its old names, its instructions and
 *   its prompts, for the person the token is. A connector added to the app
 *   keeps working without touching it. With WorkOS, a token must be for that
 *   address (`https://<domain>/mcp` as its audience), as the app asked.
 * - The OAuth metadata (`/.well-known/oauth-protected-resource[/mcp]` and the
 *   authorization server's) names that address, so a client that connects
 *   again still finds where to sign in.
 *   `LEGACY_MCP=off` takes the connectors down first: `/mcp` answers 404 with
 *   the host's address, and the metadata 404s; the rest stays.
 * - `/sw.js` is a service worker that removes itself and opens the module in
 *   the host: the app installed from the old address stops showing what it
 *   kept and lands in the host.
 * - Everything else goes to the module in the host (302, 307 for a write): the
 *   same path under `/<mount>/`. Temporary on purpose, so nothing is cached
 *   for good while the bridge is up.
 */
import { createMcpServer, dailyLimitText } from './mcp.js';
import { sendJson, securityHeaders } from './http.js';
import { WorkosUnavailable } from './workos.js';

const METADATA_PATH = '/.well-known/oauth-protected-resource';
const AS_METADATA_PATH = '/.well-known/oauth-authorization-server';
const CORS = { 'Access-Control-Allow-Origin': '*' };
/** A host name with at least one dot, lowercase, no port and no scheme. */
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Reads `LEGACY_DOMAINS`: `domain=mount` entries separated by commas (or
 * spaces). Every mount must be a module of the host, and no domain the host's
 * own or given twice. And `LEGACY_MCP` (`on` when empty, or `off`): `off`
 * takes the old connectors down before the rest of the bridge.
 * @returns {{ domains: Map<string, string>, mcp: boolean, errors: string[] }}
 */
export function parseLegacyDomains(value, { mounts, baseUrl, mcp: mcpValue = '' }) {
  const domains = new Map();
  const errors = [];
  const mcp = String(mcpValue || 'on').trim().toLowerCase();
  if (!['on', 'off'].includes(mcp)) errors.push(`LEGACY_MCP "${mcpValue}": use on or off`);
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
  return { domains, mcp: mcp !== 'off', errors };
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
 * @param {object[]} options.modules   the host's joined modules ({ mount, config, parts, view })
 * @param {object} options.suite       the host's suite (tokens, workos, entitlements, limiter, devices)
 * @param {(user, mount) => boolean} options.uses   whether someone uses a module
 * @param {boolean} options.mcp        whether the old connectors are served: the host's MCP on, and LEGACY_MCP not off
 */
export function createLegacyDomains({ domains, modules, suite, uses, hostName, baseUrl, https, version, mcp, log = () => {} }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const scheme = new URL(base).protocol;
  const byMount = new Map(modules.map((m) => [m.mount, m]));
  const originOf = (domain) => `${scheme}//${domain}`;

  /** The calls of the day count with the host's /mcp: one brake for the whole app. */
  const quota = (user) => {
    if (!suite.entitlements.describe().features['mcp.calls_per_day']) return true;
    const day = suite.entitlements.countDaily(user, 'mcp.calls_per_day');
    return day.allowed ? true : dailyLimitText(day, hostName);
  };

  /** As the host's /mcp takes a token, but a WorkOS one must be for this address. */
  const authenticateFor = (resource) => async (token) => {
    if (suite.devices && typeof token === 'string' && token.startsWith(suite.devices.prefix)) return null;
    return suite.tokens.authenticate(token, { scope: 'mcp' })
      || suite.oauth?.userFromAccessToken(token)
      || (suite.workos ? suite.workos.userFromToken(token, { audience: resource }) : null);
  };

  const servers = new Map();
  for (const [domain, mount] of domains) {
    const m = byMount.get(mount);
    const spec = m.parts?.mcp;
    if (!mcp || !spec?.tools?.length) continue;
    const name = m.config.app.name;
    const resource = `${originOf(domain)}/mcp`;
    servers.set(domain, createMcpServer({
      serverInfo: { name: m.config.app.id, title: name, version: m.parts.version || version },
      instructions: spec.instructions || '',
      tools: spec.tools,
      prompts: spec.prompts || null,
      legacyTools: spec.legacyTools || {},
      legacyParams: spec.legacyParams || {},
      describeError: spec.describeError || (() => null),
      allows: (principal, tool) => (uses(principal, mount) ? m.view.entitlements.allows(principal, tool)
        : `${name} is turned off for this person: they can turn it on in ${hostName}, Settings › Modules.`),
      visible: (principal) => !principal || uses(principal, mount),
      quota,
      authenticate: authenticateFor(resource),
      challenge: (hadToken) => (suite.workos
        ? `Bearer resource_metadata="${originOf(domain)}${METADATA_PATH}/mcp"${hadToken ? ', error="invalid_token"' : ''}`
        : `Bearer realm="${m.config.app.id}", error="invalid_token"`),
      oauthOffered: Boolean(suite.workos),
      unavailable: (error) => error instanceof WorkosUnavailable,
      limiter: suite.limiter
        ? { checkToken: suite.limiter.checkToken, tokenFailed: suite.limiter.tokenFailed, tokenSucceeded: suite.limiter.tokenSucceeded }
        : null,
      log,
    }));
  }

  /** The old address a request came to, or null: the Host header, without its port. */
  function match(req) {
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    return domains.has(host) ? host : null;
  }

  async function handle(req, res, url, domain) {
    const mount = domains.get(domain);
    const m = byMount.get(mount);
    const pathname = url.pathname;
    const target = `${base}/${mount}/`;

    if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
      const server = servers.get(domain);
      if (server) return server.handle(req, res, url);
      securityHeaders(res, { https });
      sendJson(res, 404, { error: 'not_found', mcp: `${base}/mcp` });
      return undefined;
    }

    if (pathname === METADATA_PATH || pathname === `${METADATA_PATH}/mcp`) {
      if (!servers.has(domain) || !suite.workos) {
        sendJson(res, 404, { error: 'not_found' });
        return undefined;
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...CORS, 'Access-Control-Allow-Headers': '*', 'Access-Control-Max-Age': '86400' });
        res.end();
        return undefined;
      }
      sendJson(res, 200, suite.workos.resourceMetadata(`${originOf(domain)}/mcp`, m.config.app.name), CORS);
      return undefined;
    }

    if (pathname === AS_METADATA_PATH || pathname.startsWith(`${AS_METADATA_PATH}/`)) {
      if (!servers.has(domain) || !suite.workos) {
        sendJson(res, 404, { error: 'not_found' });
        return undefined;
      }
      try {
        sendJson(res, 200, await suite.workos.authorizationServerMetadata(), CORS);
      } catch (err) {
        log(`[workos] ${err.message}`);
        sendJson(res, 502, { error: 'server_error', error_description: 'AuthKit does not answer' }, CORS);
      }
      return undefined;
    }

    securityHeaders(res, { https });
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
