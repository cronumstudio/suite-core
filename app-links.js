/**
 * Universal links (iPhone) and app links (Android): a link to the app's site, in a mail or a
 * message, opens the app on the phone where it is installed, at that page, instead of the browser.
 * The phone asks the site which app may open which addresses, at two files with no session and no
 * redirect, before it lets the app take any:
 *
 *   /.well-known/apple-app-site-association   (JSON with no extension: the app's ids and paths)
 *   /.well-known/assetlinks.json              (the Android package and its signing certificate)
 *
 * suite.config.js `appLinks` says what the app is and which of its pages a link opens there:
 *
 *   appLinks: {
 *     paths: ['/', '/tasks/*'],                       // the pages (Apple's patterns: * any characters, ? one)
 *     exclude: ['/tasks/print/*'],                     // more that never open the app (the suite's own always: below)
 *     apple: { bundleId: 'com.example.app' },          // the Team ID from APPLE_TEAM_ID (else APNS_TEAM_ID), or teamId here
 *     android: { package: 'com.example.app' },         // the certificate's SHA-256 from ANDROID_CERT_SHA256, or sha256 here
 *   }
 *
 * The Team ID and the SHA-256 of the certificate Google Play signs the app with are the install's,
 * so the environment gives them (comma-separated for several certificates); either missing leaves
 * that phone's file unserved (a 404), said once at the start. Android's paths are the app's own
 * intent filters: its file only says the app is this site's.
 *
 * What never opens the app, whatever `paths` says (`SUITE_EXCLUDED`): the APIs, the sign-in and
 * OAuth, the MCP, the admin panel, the phone's own connect pages, these files, at the root and
 * under a module's path; and any address back from the payment provider (`?billing=done`), which
 * belongs to the browser tab that paid. Apple reads the exclusions first, in order.
 */

/** The suite's addresses that a link never opens in the app: the app on the phone needs them in the browser. */
export const SUITE_EXCLUDED = Object.freeze([
  '/api/*', '/*/api/*',
  '/auth/*', '/*/auth/*',
  '/oauth/*', '/authorize*', '/token*', '/register*',
  '/mcp*', '/*/mcp*',
  '/admin*', '/*/admin*',
  '/devices/*',
  '/.well-known/*',
]);
/** Query items that keep an address in the browser: back from a checkout (billing.js `?billing=done`). */
export const SUITE_EXCLUDED_QUERIES = Object.freeze(['billing']);

export const APPLE_PATH = '/.well-known/apple-app-site-association';
export const ANDROID_PATH = '/.well-known/assetlinks.json';

const KEYS = new Set(['paths', 'exclude', 'apple', 'android']);
const APPLE_KEYS = new Set(['bundleId', 'teamId']);
const ANDROID_KEYS = new Set(['package', 'sha256']);
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;
/** A path pattern: from `/`, no spaces, quotes, angle brackets or backslashes. */
const PATTERN = /^\/[^\s"'<>\\]*$/;

/** A certificate's SHA-256 as Google writes it (`AB:CD:…`, 32 bytes), from either form; null when it is none. */
export function fingerprintOf(value) {
  const hex = String(value ?? '').trim().replace(/:/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return hex.match(/../g).join(':');
}

/** A comma-separated list from the environment, trimmed, empty ones dropped. */
const listOf = (value) => String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);

/**
 * suite.config.js `appLinks` with the install's environment: `{ paths, exclude, apple, android }`,
 * `apple` `{ appIds }` and `android` `{ package, sha256 }` each null when that phone's file is off;
 * null without `appLinks`. A mistake in the product's setting is an error; one in the environment,
 * a warning that leaves that phone's file off (a typo in an install's panel must not stop the app).
 */
export function appLinksFrom(given, env, errors, warnings) {
  if (given === undefined || given === null) return null;
  if (!isObject(given)) {
    errors.push("appLinks: an object, such as { paths: ['/'], apple: { bundleId: 'com.example.app' }, android: { package: 'com.example.app' } }");
    return null;
  }
  for (const key of Object.keys(given)) {
    if (!KEYS.has(key)) errors.push(`appLinks.${key} is not a setting (a typo?)`);
  }
  const patterns = (name) => {
    const list = given[name] ?? [];
    if (!Array.isArray(list)) {
      errors.push(`appLinks.${name}: a list of paths, such as ['/', '/tasks/*']`);
      return [];
    }
    for (const item of list) {
      if (typeof item !== 'string' || !PATTERN.test(item)) errors.push(`appLinks.${name}: "${String(item).slice(0, 80)}" is not a path starting with /`);
    }
    return [...new Set(list.filter((item) => typeof item === 'string' && PATTERN.test(item)))];
  };
  const paths = patterns('paths');
  const exclude = patterns('exclude');
  if (!paths.length) errors.push("appLinks.paths: the pages a link opens in the app, such as ['/', '/tasks/*']");

  let apple = null;
  if (given.apple !== undefined) {
    const a = isObject(given.apple) ? given.apple : {};
    if (!isObject(given.apple)) errors.push("appLinks.apple: an object, such as { bundleId: 'com.example.app' }");
    for (const key of Object.keys(a)) {
      if (!APPLE_KEYS.has(key)) errors.push(`appLinks.apple.${key} is not a setting (a typo?)`);
    }
    if (!BUNDLE_ID.test(String(a.bundleId ?? ''))) errors.push('appLinks.apple.bundleId: the app’s bundle id, such as com.example.app');
    if (a.teamId !== undefined && !TEAM_ID.test(String(a.teamId))) errors.push('appLinks.apple.teamId: the Apple Team ID, ten capital letters and digits');
    // The install's Team ID first; APNS_TEAM_ID is the same team's when the app's notices go through APNs.
    const named = env.APPLE_TEAM_ID ? 'APPLE_TEAM_ID' : env.APNS_TEAM_ID ? 'APNS_TEAM_ID' : null;
    const teamId = String(named ? env[named] : (a.teamId ?? '')).trim();
    if (!teamId) warnings.push('appLinks: links don’t open the iPhone app, APPLE_TEAM_ID is missing');
    else if (!TEAM_ID.test(teamId)) warnings.push(`appLinks: links don’t open the iPhone app, ${named ?? 'appLinks.apple.teamId'} is not a Team ID (ten capital letters and digits)`);
    else if (BUNDLE_ID.test(String(a.bundleId ?? ''))) apple = { appIds: [`${teamId}.${a.bundleId}`] };
  }

  let android = null;
  if (given.android !== undefined) {
    const d = isObject(given.android) ? given.android : {};
    if (!isObject(given.android)) errors.push("appLinks.android: an object, such as { package: 'com.example.app' }");
    for (const key of Object.keys(d)) {
      if (!ANDROID_KEYS.has(key)) errors.push(`appLinks.android.${key} is not a setting (a typo?)`);
    }
    if (!PACKAGE.test(String(d.package ?? ''))) errors.push('appLinks.android.package: the app’s package name, such as com.example.app');
    if (d.sha256 !== undefined && (!Array.isArray(d.sha256) || d.sha256.some((item) => !fingerprintOf(item)))) {
      errors.push('appLinks.android.sha256: a list of SHA-256 fingerprints of the signing certificates (AB:CD:…, 32 bytes)');
    }
    const fromEnv = listOf(env.ANDROID_CERT_SHA256);
    const given256 = fromEnv.length ? fromEnv : (Array.isArray(d.sha256) ? d.sha256 : []);
    const valid = given256.map(fingerprintOf).filter(Boolean);
    const sha256 = [...new Set(valid)];
    if (!given256.length) warnings.push('appLinks: links don’t open the Android app, ANDROID_CERT_SHA256 is missing');
    else if (valid.length !== given256.length) warnings.push('appLinks: links don’t open the Android app, ANDROID_CERT_SHA256 has a value that is not a SHA-256 fingerprint (AB:CD:…, 32 bytes)');
    else if (PACKAGE.test(String(d.package ?? ''))) android = { package: d.package, sha256 };
  }
  if (given.apple === undefined && given.android === undefined) errors.push('appLinks: apple, android or both, the apps a link opens');
  return { paths, exclude, apple, android };
}

/** Apple's file (iOS 13 and later: `components`), the exclusions first, as Apple reads them in order. */
export function appleAssociation(links) {
  const components = [
    ...[...SUITE_EXCLUDED, ...links.exclude].map((pattern) => ({ '/': pattern, exclude: true })),
    ...SUITE_EXCLUDED_QUERIES.map((name) => ({ '/': '*', '?': { [name]: '?*' }, exclude: true })),
    ...links.paths.map((pattern) => ({ '/': pattern })),
  ];
  return { applinks: { details: [{ appIDs: links.apple.appIds, components }] } };
}

/** Android's Digital Asset Links: this site's links may be handled by the app signed with these certificates. */
export function assetLinks(links) {
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: links.android.package, sha256_cert_fingerprints: links.android.sha256 },
  }];
}

/** How long a phone (and Apple's CDN in front of it) may keep either file: an hour, so a change reaches them soon. */
const MAX_AGE = 3600;

/**
 * The two files for createApp's dispatch, from the resolved `appLinks` (null: none). → a function
 * `(req, res, pathname)` that answers either one, GET or HEAD, and says whether it did; a file that
 * is off is left to the `/.well-known/*` 404.
 */
export function createAppLinks(links) {
  const files = new Map();
  if (links?.apple) files.set(APPLE_PATH, JSON.stringify(appleAssociation(links)));
  if (links?.android) files.set(ANDROID_PATH, JSON.stringify(assetLinks(links)));
  return function answer(req, res, pathname) {
    const body = files.get(pathname);
    if (body === undefined || !['GET', 'HEAD'].includes(req.method)) return false;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': `public, max-age=${MAX_AGE}`,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
