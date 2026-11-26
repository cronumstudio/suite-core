/**
 * What Settings › About says of the code and its licence, as each install sets it: where the
 * source code of the version that runs is (the AGPL's section 13 asks a network service to offer
 * it to the people who use it), who changed it, which closed parts the service runs beside it, and
 * the links to whoever runs it: terms, privacy, cookies, legal notice, support. And where the
 * public pages invite people to start their own (`SIGNUP_URL`).
 *
 * Every setting is the install's (environment variables), so a copy that is changed points the
 * notice at its own code and its own pages:
 *   SOURCE_URL       where the source code is; `{ref}` in it becomes SOURCE_REVISION (or
 *                    `v<version>` without one). Empty: the product's repository on GitHub
 *                    (github.com/cronumstudio/<app id>) at that ref, only right for a copy nobody changed
 *   SOURCE_REVISION  the commit or tag the running code was built from (the image sets it)
 *   SOURCE_MODIFIED  who changed the code and when (the licence's section 5(a)), under the copyright
 *   SOURCE_CLOSED    the closed parts the service runs, from a fixed list (CLOSED_PARTS)
 *   TERMS_URL, PRIVACY_URL, COOKIES_URL, LEGAL_URL, SUPPORT_URL   whoever runs it, linked; none when empty
 *   SIGNUP_URL       where a public page's «Start free» and its foot lead: a sign-up that makes
 *                    sense for whoever opens it. Empty: the pages invite nobody anywhere
 *
 *   const about = aboutFromEnv(env, warnings);            // config.js: install.about
 *   aboutAnswer(about, { id: 'work', version: '1.2.0' })  // what /api/auth/config says as `about`
 *
 * A mistake in one of them is said once at the start and the setting is left out: a typo here must
 * not stop the app.
 */

/** Who holds the copyright of the code, and since when: the line About shows over the licence. */
export const COPYRIGHT = { years: '2026', holder: 'Martin Andersen (Cronum Studio)' };

/** The licence's own page, in English, which is the text that counts. */
export const LICENSE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';

/** How the names and logos of the products may be used: linked while the code is the products' own. */
export const TRADEMARKS_URL = 'https://github.com/cronumstudio/.github/blob/main/TRADEMARKS.md';

/** The products' repositories, where the code of a copy nobody changed is. */
const REPOSITORIES = 'https://github.com/cronumstudio/';

/** The closed parts an install may say it runs: About names each in the person's language. */
export const CLOSED_PARTS = ['croc', 'payments'];

/** The legal links, by setting: each one's key in the answer. */
const LINKS = { TERMS_URL: 'terms', PRIVACY_URL: 'privacy', COOKIES_URL: 'cookies', LEGAL_URL: 'legal', SUPPORT_URL: 'support' };

const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const MODIFIED_MAX = 200;

/** An address of the web (http: or https:), or null. */
function webAddress(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The install's settings for About, read and checked: what is wrong is said in `warnings` and left out.
 * → { sourceUrl, revision, modified, closed, links, signupUrl }
 */
export function aboutFromEnv(env = {}, warnings = []) {
  const text = (name) => String(env[name] ?? '').trim();
  const address = (name) => {
    const given = text(name);
    if (!given) return null;
    // `{ref}` stays as it is written: new URL() would encode its braces.
    const url = webAddress(given.replaceAll('{ref}', 'ref')) ? given : null;
    if (!url) warnings.push(`${name} "${given.slice(0, 100)}" is not an http: or https: address: it is left out`);
    return url;
  };

  const revision = text('SOURCE_REVISION') || null;
  if (revision && !REVISION.test(revision)) warnings.push(`SOURCE_REVISION "${revision.slice(0, 100)}" is not a commit or a tag: it is left out`);

  let modified = text('SOURCE_MODIFIED').replace(/\s+/g, ' ') || null;
  if (modified && modified.length > MODIFIED_MAX) {
    warnings.push(`SOURCE_MODIFIED is longer than ${MODIFIED_MAX} characters: it is cut there`);
    modified = modified.slice(0, MODIFIED_MAX);
  }

  const closed = [];
  for (const part of text('SOURCE_CLOSED').toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    if (!CLOSED_PARTS.includes(part)) warnings.push(`SOURCE_CLOSED: "${part.slice(0, 40)}" is not a closed part the suite knows (${CLOSED_PARTS.join(', ')}): it is left out`);
    else if (!closed.includes(part)) closed.push(part);
  }

  const links = {};
  for (const [name, key] of Object.entries(LINKS)) {
    const url = address(name);
    if (url) links[key] = url;
  }

  return {
    sourceUrl: address('SOURCE_URL'),
    revision: revision && REVISION.test(revision) ? revision : null,
    modified,
    closed,
    links,
    signupUrl: address('SIGNUP_URL'),
  };
}

/**
 * What About shows for an install, for the product whose code it runs (`id`, `version`: in a host,
 * the host's, since its commit pins every module's).
 * → { source, revision, modified, closed, links, copyright, license, trademarks, third_party }
 */
export function aboutAnswer(about, { id, version }) {
  const given = about || aboutFromEnv({});
  const ref = given.revision || `v${String(version || '0.0.0')}`;
  const own = !given.sourceUrl;
  const repository = `${REPOSITORIES}${id}`;
  const source = own ? `${repository}/tree/${ref}` : given.sourceUrl.replaceAll('{ref}', ref);
  // The products' names and logos are in a copy whose code is still theirs (their repository).
  const theirs = own || source.startsWith(REPOSITORIES);
  return {
    source,
    revision: given.revision,
    modified: given.modified,
    closed: [...given.closed],
    links: { ...given.links },
    copyright: { ...COPYRIGHT },
    license: LICENSE_URL,
    trademarks: theirs ? TRADEMARKS_URL : null,
    // The notices of the fonts and icons from other projects, in the code itself; a changed copy's
    // are in its own source, linked above.
    third_party: own ? `${repository}/blob/${ref}/THIRD_PARTY_NOTICES.md` : null,
  };
}
