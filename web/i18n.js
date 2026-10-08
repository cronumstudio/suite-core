/**
 * Translations in the browser, the same for every app: the catalog the server
 * hands out at /i18n/<lang>.json (the suite's texts with the app's over them),
 * `t()` with {placeholders} and plural forms, the language a person chose, what
 * the HTML marks for translation, and dates, numbers and lists written by Intl in
 * the language. An app imports all of it from here (`/suite/i18n.js`) and keeps
 * only what is its own domain, such as how its dates are grouped.
 *
 * Keys are dotted ("settings.language.title"), in a flat catalog or a nested one
 * alike. A value is a text with {placeholders} ("{n} tasks") or an object with
 * the plural forms ({ "one": "…", "other": "…" }, plus exact ones like "=0"),
 * picked with `vars.n` and Intl.PluralRules. A key missing in a language falls
 * back to English; a key missing everywhere shows itself, so it is noticed.
 *
 * The choice ('auto' or a language) is kept in this browser as `<app>.lang`, the
 * app being `<html data-app>`, so the sign-in screen speaks it before anyone has
 * signed in.
 */
import { at } from './base.js';

/** The languages of the suite. English first: it is the fallback. */
export const LANGUAGES = ['en', 'es', 'fr', 'de'];

let language = 'en';
let dictionary = {};
let english = {};

/** Dotted keys ("errors.not_found") in a flat catalog or a nested one alike. */
const lookup = (dict, key) => dict[key] ?? key.split('.').reduce((node, part) => node?.[part], dict);

async function fetchCatalog(lang) {
  const res = await fetch(at(`/i18n/${lang}.json`), { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`i18n ${lang}: ${res.status}`);
  return res.json();
}

/** Where this browser keeps the choice: `<app>.lang`. */
const storageKey = () => `${globalThis.document?.documentElement?.dataset?.app || 'app'}.lang`;

/**
 * The first of the preferences the app speaks: the person's choice, then the
 * browser's languages, then English.
 */
export function pickLanguage(preferences, supported = LANGUAGES) {
  for (const preference of [preferences].flat(2)) {
    const code = String(preference || '').slice(0, 2).toLowerCase();
    if (supported.includes(code)) return code;
  }
  return supported.includes('en') ? 'en' : supported[0];
}

/** The language to use for a preference: the chosen one, or the first one of the browser we have. */
export function resolveLanguage(preference = 'auto') {
  if (LANGUAGES.includes(preference)) return preference;
  const browser = globalThis.navigator;
  return pickLanguage(browser?.languages?.length ? browser.languages : [browser?.language || 'en']);
}

/** The preference saved in this browser ('auto' when there is none). */
export function savedLanguage() {
  try { return localStorage.getItem(storageKey()) || 'auto'; } catch { return 'auto'; }
}

/**
 * Loads a language and applies it to the page: `preference` is a language or
 * 'auto' (the browser's), and is remembered as it is ('auto' stays 'auto')
 * unless `remember` is false. Without a network the catalogs come from the
 * service worker's cache; if even that fails the keys show themselves rather
 * than stopping the app. → the language in use.
 */
export async function loadLanguage(preference = 'auto', { remember = true } = {}) {
  const lang = resolveLanguage(preference);
  // English once, and again only while it could not be had.
  if (!Object.keys(english).length) english = await fetchCatalog('en').catch(() => ({}));
  dictionary = lang === 'en' ? english : await fetchCatalog(lang).catch(() => english);
  language = lang;
  forget();
  if (globalThis.document?.documentElement) document.documentElement.lang = lang;
  if (remember) {
    try { localStorage.setItem(storageKey(), preference); } catch { /* private mode */ }
  }
  if (globalThis.document?.querySelectorAll) translateDom(document);
  return lang;
}

/**
 * A language chosen in Settings: loads it and tells the app (`app:language`
 * on window, with { lang }), which draws itself again. Saving the choice in
 * the account is the caller's job.
 */
export async function changeLanguage(preference = 'auto') {
  const lang = await loadLanguage(preference);
  globalThis.dispatchEvent?.(new CustomEvent('app:language', { detail: { lang } }));
  return lang;
}

export const currentLanguage = () => language;

/** The text of a key, with its placeholders filled (numbers written by Intl); plurals picked with `n`. */
export function t(key, vars = {}) {
  let value = lookup(dictionary, key) ?? lookup(english, key);
  if (value == null) return key;
  if (typeof value === 'object') {
    // An exact form ("=0": "none left") before the language's plural rules.
    const n = Number(vars.n ?? 0);
    value = value[`=${n}`] ?? value[pluralRules().select(n)] ?? value.other ?? '';
  }
  return String(value).replace(/\{(\w+)\}/g, (match, name) => {
    if (!(name in vars)) return match;
    return typeof vars[name] === 'number' ? numberFormat().format(vars[name]) : String(vars[name]);
  });
}

/**
 * Translates what the HTML marks with data-i18n (the text) and data-i18n-attr
 * ("aria-label:key;title:key" for attributes) under `root`.
 */
export function translateDom(root) {
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of node.dataset.i18nAttr.split(';')) {
      const [attribute, key] = pair.split(':');
      if (attribute?.trim() && key?.trim()) node.setAttribute(attribute.trim(), t(key.trim()));
    }
  }
}

/* -------------------------- dates, numbers, lists -------------------------- */

// Built on first use for the language in use, and dropped when it changes: a list asks for
// one per row on every render, and constructing them is the expensive part.
const formats = new Map();
let plurals = null;
let relative = null;
let collator = null;

function forget() {
  formats.clear();
  plurals = null;
  relative = null;
  collator = null;
}

const cached = (kind, options, make) => {
  const key = `${kind}|${JSON.stringify(options ?? {})}`;
  if (!formats.has(key)) formats.set(key, make());
  return formats.get(key);
};

const pluralRules = () => (plurals ??= new Intl.PluralRules(language));

/** An Intl.DateTimeFormat for the language in use, built once per set of options. */
export const dateFormat = (options) => cached('date', options, () => new Intl.DateTimeFormat(language, options));

/** An Intl.NumberFormat for the language in use, built once per set of options. */
export const numberFormat = (options) => cached('number', options, () => new Intl.NumberFormat(language, options));

/** An Intl.ListFormat for the language in use ("3 tasks, 2 files" / "3 tasks and 2 files"). */
export const listFormat = (options) => cached('list', options, () => new Intl.ListFormat(language, options));

/** The first letter in capitals, in the language in use ("hoy" → "Hoy"). */
export const capitalize = (text) => (text ? text.charAt(0).toLocaleUpperCase(language) + text.slice(1) : text);

/**
 * "today", "tomorrow", "yesterday" for -1, 0 and 1 days away, written by Intl
 * (null for any other distance: those are dates or weekdays).
 */
export function relativeDay(days) {
  if (days < -1 || days > 1) return null;
  relative ??= new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  return relative.format(days, 'day');
}

/** Sorting by the language in use: "Ñ" and accents fall where its readers expect them. */
export const compareText = (a, b) => {
  collator ??= new Intl.Collator(language, { sensitivity: 'base' });
  return collator.compare(String(a), String(b));
};

/** A date and time, the way the language writes them; an empty string for none. */
export function formatDateTime(iso, options = { dateStyle: 'medium', timeStyle: 'short' }) {
  const date = instant(iso);
  return date ? dateFormat(options).format(date) : '';
}

/**
 * A moment from the server as a Date, or null. Some tables keep SQLite's own
 * format ("2026-10-04 12:38:27", UTC, the OAuth grants): Safari reads that as
 * an invalid date and Chrome as local time, so it is made ISO first.
 */
export function instant(value) {
  if (!value) return null;
  const text = String(value);
  const date = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d(\.\d+)?)?$/.test(text) ? `${text.replace(' ', 'T')}Z` : text);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const formatDate = (iso) => formatDateTime(iso, { dateStyle: 'medium' });
