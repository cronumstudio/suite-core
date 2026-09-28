/**
 * Translations in the browser: the catalog the server hands out at
 * /i18n/<lang>.json (the suite's texts with the app's over them), `t()` with
 * {placeholders} and plural forms, and dates written by Intl in the language.
 * A key missing in a language falls back to English; a key missing everywhere
 * shows itself, so it is noticed.
 */
let language = 'en';
let dictionary = {};
let english = {};

/** Dotted keys ("errors.not_found") in a flat catalog or a nested one alike. */
const lookup = (dict, key) => dict[key] ?? key.split('.').reduce((node, part) => node?.[part], dict);

async function fetchCatalog(lang) {
  const res = await fetch(`/i18n/${lang}.json`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`i18n ${lang}: ${res.status}`);
  return res.json();
}

/**
 * The first of the preferences the app speaks: the person's choice, then the
 * browser's languages, then English.
 */
export function pickLanguage(preferences, supported) {
  for (const preference of preferences.flat()) {
    const code = String(preference || '').slice(0, 2).toLowerCase();
    if (supported.includes(code)) return code;
  }
  return supported.includes('en') ? 'en' : supported[0];
}

export async function loadLanguage(lang) {
  english = await fetchCatalog('en');
  dictionary = lang === 'en' ? english : await fetchCatalog(lang).catch(() => english);
  language = lang;
  document.documentElement.lang = lang;
  return lang;
}

export const currentLanguage = () => language;

/** The text of a key, with its placeholders filled; plurals picked with `n`. */
export function t(key, vars = {}) {
  let value = lookup(dictionary, key) ?? lookup(english, key);
  if (value == null) return key;
  if (typeof value === 'object') {
    const n = Number(vars.n ?? 0);
    value = value[`=${n}`] ?? value[new Intl.PluralRules(language).select(n)] ?? value.other ?? '';
  }
  return String(value).replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

/** A date and time, the way the language writes them; an empty string for none. */
export function formatDateTime(iso, options = { dateStyle: 'medium', timeStyle: 'short' }) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(language, options).format(date);
}

export const formatDate = (iso) => formatDateTime(iso, { dateStyle: 'medium' });
