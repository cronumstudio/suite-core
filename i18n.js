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
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Dotted keys as a nested catalog. A key that would be both a text and a section stays dotted. */
export function unflatten(flat) {
  const out = {};
  for (const [key, value] of Object.entries(flat || {})) {
    const parts = key.split('.');
    let node = out;
    let clash = false;
    for (const part of parts.slice(0, -1)) {
      if (node[part] === undefined) node[part] = {};
      else if (typeof node[part] !== 'object' || isPlural(node[part])) { clash = true; break; }
      node = node[part];
    }
    if (clash || (node[parts.at(-1)] && typeof node[parts.at(-1)] === 'object' && !isPlural(node[parts.at(-1)]))) out[key] = value;
    else node[parts.at(-1)] = value;
  }
  return out;
}

/** Whether a catalog is written nested ({ "errors": { … } }) rather than with dotted keys. */
export const isNested = (catalog) => Object.values(catalog || {})
  .some((value) => value && typeof value === 'object' && !isPlural(value));

/**
 * The catalog a browser gets: the suite's texts with the app's over them, in
 * the app's own shape (nested or dotted), so its t() finds both the same way.
 */
export function mergeCatalogs(suite, app) {
  const merged = { ...flatten(suite), ...flatten(app) };
  return app && isNested(app) ? unflatten(merged) : merged;
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
 * An app's translations on the server, the same for every app: its catalogs in
 * `dir` (`<lang>.json`, the very files the browser gets, merged over the
 * suite's), the language of each person, and t(). What the server writes for
 * people (push notices, the first lists of an account, the OAuth consent
 * screen, the sentence an assistant reads for an error) comes from here, so
 * every text has a single place. An app's server/i18n.js is
 * `export const { … } = appTexts(new URL('../public/i18n/', import.meta.url))`.
 *
 * The catalogs are read again when a file changes (public/ may be edited live),
 * at the cost of a stat per call, and each translator is built once per
 * language and handed out again while its files are unchanged: callers can tell
 * whether anything changed by comparing identities (`fromCatalog`).
 *
 * The language used when nothing says which one a person reads (no choice, no
 * browser header as with MCP clients and scripts, no account locale) is English,
 * unless the installation says otherwise with DEFAULT_LANGUAGE (en, es, fr or de).
 */
export function appTexts(dir, { defaultLanguage = process.env.DEFAULT_LANGUAGE, languages = LANGUAGES } = {}) {
  const folder = dir instanceof URL ? fileURLToPath(dir) : String(dir);
  const configured = String(defaultLanguage || '').trim().slice(0, 2).toLowerCase();
  const DEFAULT_LANGUAGE = languages.includes(configured) ? configured : 'en';
  const order = [DEFAULT_LANGUAGE, ...languages.filter((lang) => lang !== DEFAULT_LANGUAGE)];

  /** The first supported language among the preferences, in order; the installation's default if none. */
  const negotiateLanguage = (preferences) => negotiate(preferences, order);

  // Whether a file exists is tracked apart from its mtime: images built to be reproducible stamp
  // every file with the epoch (mtime 0), and those are catalogs too.
  const files = new Map();
  const NO_CATALOG = Object.freeze({});
  const catalog = (lang) => {
    const file = path.join(folder, `${lang}.json`);
    let exists = false;
    let mtime = 0;
    try { mtime = statSync(file).mtimeMs; exists = true; } catch { /* no file */ }
    const hit = files.get(lang);
    if (hit && hit.exists === exists && hit.mtime === mtime) return hit.dict;
    let dict = NO_CATALOG;
    if (exists) {
      try { dict = flatten(JSON.parse(readFileSync(file, 'utf8'))); } catch { /* keep it empty */ }
    }
    files.set(lang, { exists, mtime, dict });
    return dict;
  };

  const translators = new Map();
  /** t(key, vars) for a language: the app's texts first, then the suite's, English key by key after them. */
  function translatorFor(lang) {
    const language = languages.includes(lang) ? lang : 'en';
    const en = catalog('en');
    const dict = language === 'en' ? en : catalog(language);
    const hit = translators.get(language);
    if (hit && hit.en === en && hit.dict === dict) return hit.t;
    const t = translator(language, SUITE_CATALOGS, language === 'en' ? { en } : { en, [language]: dict });
    translators.set(language, { en, dict, t });
    return t;
  }

  const derived = new Map();
  /**
   * Anything computed from the catalogs of a language, kept until a catalog file
   * changes: `compute(t)` runs again only when the translator is a new one. It
   * must not be something callers mutate (they copy it on the way out).
   */
  function fromCatalog(name, lang, compute) {
    const language = languages.includes(lang) ? lang : 'en';
    const t = translatorFor(language);
    const key = `${name}:${language}`;
    const hit = derived.get(key);
    if (hit && hit.t === t) return hit.value;
    const value = compute(t);
    derived.set(key, { t, value });
    return value;
  }

  const prefsOf = (user) => {
    if (!user) return {};
    try {
      return typeof user.prefs === 'string' ? JSON.parse(user.prefs || '{}') : (user.prefs || {});
    } catch {
      return {};
    }
  };
  const locale = (user) => String(user?.locale ?? '').replace('_', '-');

  /** The language a person chose in their settings ('auto' or none → null). */
  const savedLanguage = (user) => (languages.includes(prefsOf(user).lang) ? prefsOf(user).lang : null);

  /**
   * The last language their browser resolved (the web app reports it when it
   * differs as prefs.lang_seen): for where no browser takes part. Never
   * overrides a saved choice.
   */
  const seenLanguage = (user) => (languages.includes(prefsOf(user).lang_seen) ? prefsOf(user).lang_seen : null);

  /**
   * The language of a person outside of a browser request (MCP, notices): their
   * choice, the last one their browser used, the locale their account was
   * created with, else the installation's default.
   */
  const userLanguage = (user) => negotiateLanguage([savedLanguage(user), seenLanguage(user), locale(user)]);

  /** The language for a request: their choice, the browser's, what we know of them, the default. */
  const languageFor = (req, user = null) => negotiateLanguage([
    savedLanguage(user), req?.headers?.['accept-language'], seenLanguage(user), locale(user),
  ]);

  /** Both at once: what the suite's screens (the OAuth consent) ask for. */
  const textsFor = (req, user = null) => {
    const lang = languageFor(req, user);
    return { lang, t: translatorFor(lang) };
  };

  /**
   * An error as a sentence in a language: `errors.<code>` with the details the
   * server sent (`field` named in the language, `max`, …), for what cannot leave
   * the wording to the browser, like what an assistant reads. → null when no
   * sentence is known for the code.
   */
  function errorSentence(code, extra = {}, lang = 'en') {
    const t = translatorFor(lang);
    const sentence = t(`errors.${code}`, { ...extra, ...(extra.field ? { field: t(`fields.${extra.field}`) } : {}) });
    return sentence === `errors.${code}` ? null : sentence;
  }

  return {
    LANGUAGES: languages, DEFAULT_LANGUAGE, negotiateLanguage, translator: translatorFor, fromCatalog,
    savedLanguage, seenLanguage, userLanguage, languageFor, textsFor, errorSentence,
  };
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
