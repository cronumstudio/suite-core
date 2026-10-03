/**
 * Conformance checks: what every app inherits from the suite, checked against a running copy
 * over plain HTTP. Nothing outside the app is called, so it works the same on a laptop, on a
 * NAS, in a container or against production.
 *
 *   node server/suite/tools/conformance.js http://127.0.0.1:3456
 *   CONFORMANCE_USER=admin CONFORMANCE_PASSWORD=… node server/suite/tools/conformance.js <url>
 *
 * Without credentials the sign-in checks are skipped. With them, the account must sign in with
 * a password and no second step: a throwaway administrator, never a real person's account. The
 * brute-force check fails a made-up username until the brake answers (`--no-brake` skips it);
 * those failures count against the caller's IP for fifteen minutes, well under its limit, and
 * the successful sign-in that follows clears them.
 *
 * From a smoke test, the same checks as data:
 *
 *   import { checkConformance } from '../server/suite/tools/conformance.js';
 *   for (const r of await checkConformance({ baseUrl, username, password })) check(r.name, r.ok, r.detail);
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { flatten } from '../i18n.js';

const MADE_UP_USER = 'conformance-nobody';

/**
 * @param {object} options
 * @param {string} options.baseUrl       where the app answers, e.g. http://127.0.0.1:3456
 * @param {string} [options.username]    an account that signs in with a password, no second step
 * @param {string} [options.password]
 * @param {boolean} [options.brake]      check the brute-force brake (on by default)
 * @param {boolean} [options.mcp]        the app serves /mcp (on by default: all of the suite's do)
 * @returns {Promise<Array<{ name: string, ok: boolean, detail: string, skipped?: boolean }>>}
 */
export async function checkConformance({ baseUrl, username, password, brake = true, mcp = true, fetch = globalThis.fetch }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const origin = new URL(base).origin;
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail) }); return ok; };
  const skip = (name, detail) => results.push({ name, ok: true, skipped: true, detail });
  const get = (route, headers = {}) => fetch(base + route, { headers, redirect: 'manual' });
  const post = (route, body, headers = {}) => fetch(base + route, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: origin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = async (res) => { try { return JSON.parse(await res.text()); } catch { return undefined; } };
  const isJson = (res) => /^application\/json/.test(res.headers.get('content-type') || '');

  /* ------------------------------ health ------------------------------ */

  const health = await get('/health');
  const healthBody = await json(health);
  check('/health answers ok, with the version', health.status === 200 && healthBody?.ok === true
    && typeof healthBody.version?.app === 'string', `${health.status} ${JSON.stringify(healthBody)}`);
  check('/health is never cached', /no-store/.test(health.headers.get('cache-control') || ''),
    health.headers.get('cache-control'));
  const version = await get('/version');
  const versionBody = await json(version);
  check('/version names the app version and the build', version.status === 200
    && typeof versionBody?.app === 'string' && typeof versionBody?.version === 'string',
  `${version.status} ${JSON.stringify(versionBody)}`);
  const fingerprint = await get('/js/app-version.js');
  check('/js/app-version.js exports the fingerprint the page compares', fingerprint.status === 200
    && /javascript/.test(fingerprint.headers.get('content-type') || '')
    && /export const APP_VERSION = /.test(await fingerprint.text()), fingerprint.status);

  /* --------------------------- security headers ----------------------- */

  const unknownApi = await get('/api/conformance-unknown');
  const unknownFile = await get('/conformance-unknown.txt');
  for (const [label, res] of [['/health', health], ['an unknown /api path', unknownApi], ['an unknown file', unknownFile]]) {
    const csp = res.headers.get('content-security-policy') || '';
    const scripts = (csp.match(/script-src([^;]*)/) || [])[1] ?? (csp.match(/default-src([^;]*)/) || [])[1] ?? '';
    check(`Security headers on ${label}`, /frame-ancestors 'none'/.test(csp)
      && !/'unsafe-inline'|'unsafe-eval'/.test(scripts)
      && res.headers.get('x-content-type-options') === 'nosniff'
      && Boolean(res.headers.get('referrer-policy'))
      && Boolean(res.headers.get('permissions-policy')),
    `CSP "${csp}", nosniff "${res.headers.get('x-content-type-options')}", referrer "${res.headers.get('referrer-policy')}", permissions "${res.headers.get('permissions-policy')}"`);
  }
  if (base.startsWith('https://')) {
    check('HSTS over HTTPS', /max-age=\d{7,}/.test(health.headers.get('strict-transport-security') || ''),
      health.headers.get('strict-transport-security'));
  } else {
    skip('HSTS over HTTPS', 'plain http: nothing to check');
  }

  /* ------------------------- errors and discovery --------------------- */

  const unknownApiBody = await json(unknownApi);
  check('An unknown /api path is a JSON 404 with a code, not a sentence', unknownApi.status === 404 && isJson(unknownApi)
    && /^[a-z][a-z0-9_]*$/.test(unknownApiBody?.error || ''), `${unknownApi.status} ${JSON.stringify(unknownApiBody)}`);
  for (const route of ['/.well-known/openid-configuration', '/.well-known/conformance-unknown', '/oauth/conformance-unknown']) {
    const res = await get(route);
    check(`${route} is a JSON 404, never the app's page`, res.status === 404 && isJson(res),
      `${res.status} ${res.headers.get('content-type')}`);
  }

  /* --------------------------------- MCP ------------------------------ */

  if (mcp) {
    const res = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { Accept: 'application/json, text/event-stream' });
    const challenge = res.headers.get('www-authenticate') || '';
    const body = await json(res);
    check('/mcp without a token is a 401 with a Bearer challenge', res.status === 401 && /^Bearer /.test(challenge)
      && body?.jsonrpc === '2.0' && Boolean(body.error), `${res.status} "${challenge}"`);
    const metadataUrl = (challenge.match(/resource_metadata="([^"]+)"/) || [])[1];
    if (metadataUrl) {
      // The URL comes from BASE_URL, which may name a proxy in front: ask this copy for the same path.
      const meta = await get(new URL(metadataUrl).pathname);
      const metaBody = await json(meta);
      check('The challenge points at protected-resource metadata that answers', meta.status === 200
        && /\/mcp$/.test(metaBody?.resource || '') && Array.isArray(metaBody?.authorization_servers)
        && metaBody.authorization_servers.length > 0, `${meta.status} ${JSON.stringify(metaBody)}`);
    } else {
      skip('The challenge points at protected-resource metadata that answers', 'no OAuth offered: manual tokens only');
    }
  } else {
    skip('/mcp without a token is a 401 with a Bearer challenge', 'the app serves no /mcp');
  }

  /* ------------------------------ translations ------------------------ */

  const authConfigRes = await get('/api/auth/config');
  const authConfig = await json(authConfigRes);
  const languages = authConfig?.app?.languages;
  check('/api/auth/config names the provider and the languages', authConfigRes.status === 200
    && typeof authConfig?.provider === 'string' && Array.isArray(languages) && languages[0] === 'en',
  `${authConfigRes.status} ${JSON.stringify(authConfig?.app)}`);
  const catalogs = {};
  for (const lang of Array.isArray(languages) ? languages : []) {
    const res = await get(`/i18n/${lang}.json`);
    const body = await json(res);
    if (check(`/i18n/${lang}.json is served`, res.status === 200 && body && typeof body === 'object', res.status)) {
      catalogs[lang] = new Set(Object.keys(flatten(body)));
    }
  }
  if (catalogs.en) {
    for (const [lang, keys] of Object.entries(catalogs)) {
      if (lang === 'en') continue;
      const missing = [...catalogs.en].filter((key) => !keys.has(key));
      check(`/i18n/${lang}.json says everything English says`, missing.length === 0,
        missing.length ? `${missing.length} missing: ${missing.slice(0, 10).join(', ')}` : '');
    }
  }
  const noLanguage = await get('/i18n/zz.json');
  check('A language the app does not have is a 404', noLanguage.status === 404, noLanguage.status);

  /* ------------------------------ sign-in ----------------------------- */

  const local = authConfig?.provider === 'local';
  if (!local) {
    skip('Sign-in with a password', `the provider is ${authConfig?.provider}: sign-in happens elsewhere`);
  }
  if (local && brake) {
    let status = 0;
    let body;
    let attempts = 0;
    while (attempts < 25) {
      attempts++;
      const res = await post('/api/auth/login', { username: MADE_UP_USER, password: `wrong-${attempts}` });
      status = res.status;
      body = await json(res);
      if (attempts === 1) check('A wrong password is a 401 bad_credentials', status === 401 && body?.error === 'bad_credentials', `${status} ${JSON.stringify(body)}`);
      if (status !== 401) break;
    }
    check('The brute-force brake answers 429 too_many_attempts', status === 429 && body?.error === 'too_many_attempts'
      && Number(body?.retry_after) > 0, `after ${attempts} attempts: ${status} ${JSON.stringify(body)}`);
  } else if (local) {
    skip('The brute-force brake answers 429 too_many_attempts', 'skipped on request');
  }

  let cookieName = authConfig?.app?.id ? `${authConfig.app.id}_sid` : 'sid';
  if (local && username && password) {
    const anonymous = await json(await get('/api/auth/me'));
    check('Without a session, /api/auth/me says nobody', anonymous && anonymous.user === null, JSON.stringify(anonymous));
    const login = await post('/api/auth/login', { username, password });
    const loginBody = await json(login);
    const setCookie = login.headers.get('set-cookie') || '';
    const pair = setCookie.split(';')[0];
    if (pair.includes('=')) cookieName = pair.slice(0, pair.indexOf('='));
    check('Signing in with the right password opens a session', login.status === 200 && loginBody?.user?.username
      && !loginBody.two_factor_required && pair.includes('='),
    `${login.status} ${JSON.stringify(loginBody?.two_factor_required ? { two_factor_required: true } : loginBody?.error ?? loginBody?.user?.username)}`);
    check('The session cookie is HttpOnly and SameSite', /;\s*HttpOnly/i.test(setCookie) && /;\s*SameSite=(Lax|Strict)/i.test(setCookie),
      setCookie.replace(/=[^;]*/, '=…'));
    if (base.startsWith('https://')) check('The session cookie is Secure over HTTPS', /;\s*Secure/i.test(setCookie), setCookie.replace(/=[^;]*/, '=…'));
    const cookie = { Cookie: pair };
    const me = await json(await get('/api/auth/me', cookie));
    check('With the session, /api/auth/me names the account', me?.user?.username?.toLowerCase() === username.toLowerCase(),
      JSON.stringify(me?.user?.username));
    const foreign = await post('/api/auth/logout', undefined, { ...cookie, Origin: 'https://conformance.invalid' });
    const foreignBody = await json(foreign);
    check('A request with the session from another site is refused (CSRF)', foreign.status === 403
      && foreignBody?.error === 'cross_site_request', `${foreign.status} ${JSON.stringify(foreignBody)}`);
    const logout = await post('/api/auth/logout', undefined, cookie);
    check('Signing out answers ok', logout.status === 200, logout.status);
    const after = await json(await get('/api/auth/me', cookie));
    check('After signing out the old cookie opens nothing', after && after.user === null, JSON.stringify(after));
  } else {
    if (local) skip('Sign-in with a password', 'no credentials given');
    const foreign = await post('/api/auth/logout', undefined, { Cookie: `${cookieName}=conformance`, Origin: 'https://conformance.invalid' });
    const foreignBody = await json(foreign);
    check('A request with a session cookie from another site is refused (CSRF)', foreign.status === 403
      && foreignBody?.error === 'cross_site_request', `${foreign.status} ${JSON.stringify(foreignBody)}`);
  }

  return results;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const baseUrl = args.find((arg) => !arg.startsWith('--'));
  if (!baseUrl) {
    console.error('Usage: node tools/conformance.js <base URL> [--no-brake] [--no-mcp]   (CONFORMANCE_USER, CONFORMANCE_PASSWORD)');
    process.exit(2);
  }
  const results = await checkConformance({
    baseUrl,
    username: process.env.CONFORMANCE_USER,
    password: process.env.CONFORMANCE_PASSWORD,
    brake: !args.includes('--no-brake'),
    mcp: !args.includes('--no-mcp'),
  });
  for (const r of results) {
    const mark = r.skipped ? '-' : r.ok ? '✓' : '✗';
    console.log(`  ${mark} ${r.name}${(!r.ok || r.skipped) && r.detail ? ` → ${r.detail}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
