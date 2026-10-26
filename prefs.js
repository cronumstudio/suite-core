/**
 * A person's preferences: one JSON object in `users.prefs`, shared by every
 * module of the row.
 *
 * Each app kept its own copy of the same three things — reading the column,
 * putting its keys on top of the row without dropping the others' (in Cronum
 * Work the row is everyone's), and what the browser sees of the account — and
 * the copies had drifted (audit 2026-10-23, A7). Now a module says only what
 * is its own, with `createApp({ prefs })` (or `createModule().prefs` in a
 * host):
 *
 *   prefs: {
 *     defaults: { stepAges: false },          // its keys and their values when nothing is stored
 *     normalize: (raw) => ({ stepAges: raw.stepAges === true }),   // its keys, from what is stored or sent
 *     merge: (current, patch, { user }) => …,  // optional: how a change lands (a half object, a check)
 *     view: (prefs, { user, req }) => …,       // optional: what the browser sees of them
 *     store: (prefs) => …,                     // optional: what of them is written
 *   }
 *
 * The keys every module shares are the suite's: `lang` (the interface's, or
 * 'auto'), `lang_seen` (the language the browser resolved, for what runs
 * without one) and `tz` (the browser's time zone, canonical: time.js). Prefs
 * stay flat, as they always were: no module's keys move anywhere, and nothing
 * stored is migrated.
 */
import { badRequest } from './http.js';
import { knownTimeZone } from './time.js';

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** What `users.prefs` holds (JSON text, or already read) as an object; anything else, `{}`. */
export function readPrefs(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  }
  return isPlain(parsed) ? parsed : {};
}

/** The keys every module shares, from what is stored. */
export function sharedPrefs(raw, languages) {
  const prefs = readPrefs(raw);
  return {
    lang: prefs.lang === 'auto' || languages.includes(prefs.lang) ? prefs.lang : 'auto',
    lang_seen: languages.includes(prefs.lang_seen) ? prefs.lang_seen : null,
    tz: knownTimeZone(prefs.tz),
  };
}

/**
 * A change to the shared keys, refused rather than quietly turned into the
 * default: a language or a zone the server doesn't know is the sender's mistake.
 */
export function checkSharedPrefs(patch, languages) {
  if (patch.lang != null && !['auto', ...languages].includes(patch.lang)) {
    throw badRequest('field_invalid', { field: 'lang', options: ['auto', ...languages] });
  }
  if (patch.lang_seen != null && !languages.includes(patch.lang_seen)) {
    throw badRequest('field_invalid', { field: 'lang_seen', options: languages });
  }
  if (patch.tz != null && !knownTimeZone(patch.tz)) throw badRequest('field_invalid', { field: 'tz' });
}

const sameKind = (value, fallback) => (fallback === null
  ? value === null || ['string', 'number', 'boolean'].includes(typeof value)
  : Array.isArray(fallback) ? Array.isArray(value) : typeof value === typeof fallback && (!isPlain(fallback) || isPlain(value)));

const copy = (value) => (value && typeof value === 'object' ? structuredClone(value) : value);

/** Without a `normalize` of its own: each key of `defaults`, stored if it is of the same kind. */
const fromDefaults = (defaults) => (raw) => Object.fromEntries(Object.entries(defaults)
  .map(([key, fallback]) => [key, key in raw && sameKind(raw[key], fallback) ? copy(raw[key]) : copy(fallback)]));

/**
 * A module's hook (or none) made whole, on the install's languages: what the
 * browser sees (`view`) and the text a change writes (`next`).
 */
export function definePrefs(hook, { languages }) {
  const parts = hook ? (Array.isArray(hook.parts) ? hook.parts : [hook]) : [];
  const own = parts.map((part) => ({
    ...part,
    normalize: part.normalize || fromDefaults(part.defaults || {}),
  }));

  /** What the browser sees: each part's own keys (on its defaults), then the shared ones. */
  function view(user, { req = null } = {}) {
    const raw = readPrefs(user?.prefs);
    const out = {};
    for (const part of own) {
      const prefs = { ...copy(part.defaults || {}), ...part.normalize(raw, { user, req }) };
      Object.assign(out, part.view ? part.view(prefs, { user, req, raw }) : prefs);
    }
    return { ...out, ...sharedPrefs(raw, languages) };
  }

  /**
   * The text `users.prefs` is saved as after `patch`: what the row holds now,
   * each part's own keys on top as its `merge`, `normalize` and `store` leave
   * them, then the shared ones. The keys no part knows (another module's) stay
   * as they are. Refuses a shared key it doesn't know; a part's `merge` may
   * refuse what is its own.
   */
  function next(stored, patch, { user = null, req = null } = {}) {
    const raw = readPrefs(stored);
    const changes = isPlain(patch) ? patch : {};
    checkSharedPrefs(changes, languages);
    const out = { ...raw };
    for (const part of own) {
      const current = part.normalize(raw, { user, req });
      const merged = part.merge ? part.merge(current, changes, { user, req }) : { ...current, ...changes };
      const prefs = part.normalize(readPrefs(merged), { user, req });
      Object.assign(out, part.store ? part.store(prefs) : prefs);
    }
    // A zone is kept as the runtime names it ("europe/madrid" → "Europe/Madrid").
    Object.assign(out, sharedPrefs({ ...sharedPrefs(raw, languages), ...pickShared(changes) }, languages));
    return JSON.stringify(out);
  }

  return { view, next, defaults: Object.assign({}, ...own.map((part) => copy(part.defaults || {}))) };
}

const SHARED = ['lang', 'lang_seen', 'tz'];
const pickShared = (changes) => Object.fromEntries(SHARED.filter((key) => key in changes).map((key) => [key, changes[key]]));

/**
 * The modules of a host as one hook, for its own `/api/me`: each keeps its
 * keys and none drops another's (they are applied one after another on the
 * same row).
 */
export function combinePrefs(hooks) {
  const parts = hooks.filter(Boolean).flatMap((hook) => (Array.isArray(hook.parts) ? hook.parts : [hook]));
  return parts.length ? { parts } : null;
}

/**
 * What the browser sees of an account: the suite's public fields (never the
 * hash; `has_password` always, which Settings reads), how people sign in
 * here (`auth_provider`), the preferences (`prefs`, the module's own and the
 * shared ones) and, with `fields`, what the module adds of its own.
 * → (user, { req }) => object | null
 */
export function userSerializer(suite, { prefs = null, fields = null } = {}) {
  const defined = definePrefs(prefs, { languages: suite.config.app.languages });
  const authProvider = suite.config.install.authProvider;
  return (user, options = {}) => (user ? {
    ...suite.accounts.publicUser(user),
    auth_provider: authProvider,
    ...(fields ? fields(user, options) : {}),
    prefs: defined.view(user, options),
  } : null);
}
