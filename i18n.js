/**
 * Translations: the suite's own texts, the language of each request, and t().
 *
 * The suite ships the texts of the screens it draws itself (for now, the OAuth
 * consent and error screens) in `i18n/<lang>.json`, in every language of the
 * suite. An app can use them as they are, or pass its own catalogs to override
 * any key — the consent screen says what the assistant may do, and only the
 * app knows that.
 *
 * Catalogs may be flat ({ "oauth.allow": "Allow" }) or nested
 * ({ "oauth": { "allow": "Allow" } }); they are flattened when read, so a key
 * is always one dotted string that can be searched for. A value is a text with
 * {placeholders} or an object of CLDR plural forms ({ "one": …, "other": … },
 * plus exact ones like "=0"), picked with the `n` variable. A key missing in a
 * language falls back to English, key by key.
 */
import { readFileSync } from 'node:fs';

/** The languages of the suite. English first: it is the fallback. */
export const LANGUAGES = ['en', 'es', 'fr', 'de'];

const isPlural = (value) => value && typeof value === 'object'
  && Object.keys(value).some((k) => k === 'other' || k === 'one' || k.startsWith('='));

/** A nested catalog as dotted keys; a flat one comes out as it went in. */
export function flatten(catalog, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(catalog || {})) {
    if (key.startsWith('$meta')) continue;
    if (value && typeof value === 'object' && !isPlural(value)) flatten(value, `${prefix}${key}.`, out);
    else out[`${prefix}${key}`] = value;
  }
  return out;
}

/** `<dir>/<lang>.json` for every language, flattened; a missing file is an empty catalog. */
export function loadCatalogs(dir, languages = LANGUAGES) {
  const catalogs = {};
  for (const lang of languages) {
    try {
      catalogs[lang] = flatten(JSON.parse(readFileSync(new URL(`${lang}.json`, dir), 'utf8')));
    } catch {
      catalogs[lang] = {};
    }
  }
  return catalogs;
}

/** The suite's own texts. */
export const SUITE_CATALOGS = loadCatalogs(new URL('./i18n/', import.meta.url));

/**
 * The first supported language among the preferences, in order. Each one may be
 * a language code ("es", "es-ES") or a whole Accept-Language header, whose
 * entries are tried by their q value. Nothing supported → the first language.
 */
export function negotiate(preferences, supported = LANGUAGES) {
  for (const preference of [preferences].flat()) {
    if (!preference) continue;
    const tags = String(preference).split(',').map((entry) => {
      const [tag, ...params] = entry.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q.slice(2)) : 1 };
    }).filter((item) => item.tag && item.q > 0).sort((a, b) => b.q - a.q);
    for (const { tag } of tags) {
      const base = tag.split('-')[0];
      if (supported.includes(base)) return base;
    }
  }
  return supported[0];
}

/**
 * t(key, vars) for one language over several catalog sets, the later ones
 * overriding the earlier: `translator('es', SUITE_CATALOGS, appCatalogs)`.
 */
export function translator(lang, ...sets) {
  const chain = lang === 'en' ? ['en'] : [lang, 'en'];
  const plural = new Intl.PluralRules(lang);
  const number = new Intl.NumberFormat(lang);
  const look = (key) => {
    for (const language of chain) {
      for (let i = sets.length - 1; i >= 0; i--) {
        const dict = sets[i]?.[language];
        if (dict && Object.hasOwn(dict, key)) return dict[key];
      }
    }
    return undefined;
  };
  return function t(key, vars = {}) {
    let value = look(key);
    if (value === undefined) return key;
    if (isPlural(value)) {
      const n = Number(vars.n ?? 0);
      value = value[`=${n}`] ?? value[plural.select(n)] ?? value.other ?? '';
    }
    return String(value).replace(/\{(\w+)\}/g, (match, name) => {
      if (!Object.hasOwn(vars, name)) return match;
      return typeof vars[name] === 'number' ? number.format(vars[name]) : String(vars[name]);
    });
  };
}

/** The language a user chose, wherever the app keeps it. */
function chosenLanguage(user) {
  if (!user) return null;
  if (user.locale) return user.locale;
  try {
    const prefs = typeof user.prefs === 'string' ? JSON.parse(user.prefs || '{}') : (user.prefs || {});
    return prefs.lang || prefs.language || null;
  } catch {
    return null;
  }
}

/**
 * The `texts(req, user)` the suite's screens ask for: the user's language if
 * they chose one, else the browser's, else English; and its t() over the
 * suite's catalogs plus the app's (`catalogs`, same shape, flat or nested).
 */
export function createTexts({ catalogs = {}, languages = LANGUAGES } = {}) {
  const own = Object.fromEntries(Object.entries(catalogs).map(([lang, dict]) => [lang, flatten(dict)]));
  const cache = new Map();
  return (req, user = null) => {
    const lang = negotiate([chosenLanguage(user), req?.headers?.['accept-language']], languages);
    if (!cache.has(lang)) cache.set(lang, translator(lang, SUITE_CATALOGS, own));
    return { lang, t: cache.get(lang) };
  };
}
