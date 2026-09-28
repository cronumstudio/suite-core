/**
 * Catalog checks, for the suite's own texts and for each app's (taken from
 * Focus's tools/i18n.mjs):
 *
 *   node server/suite/tools/i18n.mjs parity [dir]            every language says the same things
 *   node server/suite/tools/i18n.mjs used <dir> <src>…       every key the code uses exists
 *
 * An app's catalogs (`<dir>/<lang>.json`, nested or dotted) are checked merged
 * over the suite's, which is what its browser gets from /i18n/<lang>.json.
 * Without a directory, the suite's own catalogs are checked.
 *
 * Parity: the same keys as English in every language, the same {placeholders},
 * the plural forms each language uses (from Intl.PluralRules; "many", which
 * only big round numbers take, may be left to "other"), exact forms like "=0"
 * wherever English has them, and nothing left as "TODO".
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LANGUAGES, SUITE_CATALOGS, flatten } from '../i18n.js';

const isPlural = (value) => value && typeof value === 'object';
const markers = (value) => [...new Set(String(value).match(/\{\w+\}/g) ?? [])].sort().join(',');

/** The catalogs of `dir`, each merged over the suite's; the suite's own without `dir`. */
export function catalogsOf(dir = null, languages = LANGUAGES) {
  const out = {};
  for (const lang of languages) {
    let own = {};
    if (dir) {
      try {
        own = flatten(JSON.parse(readFileSync(path.join(dir, `${lang}.json`), 'utf8')));
      } catch (err) {
        if (err.code !== 'ENOENT') throw new Error(`${lang}.json: ${err.message}`);
      }
    }
    out[lang] = { ...(SUITE_CATALOGS[lang] || {}), ...own };
  }
  return out;
}

/** Everything that differs between the languages and English, as sentences. */
export function parity(catalogs) {
  const errors = [];
  const english = catalogs.en || {};
  for (const [lang, catalog] of Object.entries(catalogs)) {
    if (lang === 'en') continue;
    const missing = Object.keys(english).filter((key) => !(key in catalog));
    const extra = Object.keys(catalog).filter((key) => !(key in english));
    if (missing.length) errors.push(`${lang}: missing ${missing.join(', ')}`);
    if (extra.length) errors.push(`${lang}: not in English ${extra.join(', ')}`);
    const categories = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
    for (const [key, value] of Object.entries(catalog)) {
      const source = english[key];
      if (source === undefined) continue;
      if (isPlural(value) !== isPlural(source)) {
        errors.push(`${lang}: ${key}: ${isPlural(source) ? 'plural forms' : 'a text'} expected`);
        continue;
      }
      if (!isPlural(value)) {
        if (value === 'TODO' || !String(value).trim()) errors.push(`${lang}: ${key}: not translated`);
        else if (markers(value) !== markers(source)) errors.push(`${lang}: ${key}: placeholders ${markers(value) || 'none'} instead of ${markers(source) || 'none'}`);
        continue;
      }
      const forms = Object.keys(value).filter((form) => !form.startsWith('='));
      const lacking = categories.filter((form) => form !== 'many' && !forms.includes(form));
      const unknown = forms.filter((form) => !categories.includes(form));
      if (lacking.length) errors.push(`${lang}: ${key}: plural forms ${lacking.join(', ')} missing`);
      if (unknown.length) errors.push(`${lang}: ${key}: ${unknown.join(', ')} is not a plural form of ${lang}`);
      for (const exact of Object.keys(source).filter((form) => form.startsWith('='))) {
        if (!(exact in value)) errors.push(`${lang}: ${key}: the exact form ${exact} is missing`);
      }
      for (const [form, text] of Object.entries(value)) {
        const reference = source[form] ?? source.other;
        if (reference !== undefined && markers(text) !== markers(reference)) {
          errors.push(`${lang}: ${key}.${form}: placeholders ${markers(text) || 'none'} instead of ${markers(reference) || 'none'}`);
        }
      }
    }
  }
  return errors;
}

/** Source files (.js, .mjs, .html) under the given folders, leaving out tests and the suite. */
function sources(dirs) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'test', 'suite', 'i18n'].includes(entry.name)) walk(full);
      } else if (/\.(?:m?js|html)$/.test(entry.name)) files.push(full);
    }
  };
  for (const dir of dirs) {
    if (statSync(dir).isDirectory()) walk(dir);
    else files.push(dir);
  }
  return files;
}

/**
 * The keys the code uses —t('key'), data-i18n="key", data-i18n-attr="attr:key"—
 * that no catalog defines, in English.
 */
export function unknownKeys(english, dirs) {
  const unknown = new Map();
  for (const file of sources(dirs)) {
    const text = readFileSync(file, 'utf8');
    const keys = [
      ...[...text.matchAll(/\bt\(\s*['"]([\w.-]+)['"]/g)].map((m) => m[1]),
      ...[...text.matchAll(/data-i18n="([\w.-]+)"/g)].map((m) => m[1]),
      ...[...text.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap((m) => m[1].split(';').map((pair) => pair.split(':')[1]?.trim()).filter(Boolean)),
    ];
    for (const key of keys) {
      if (!(key in english) && !Object.keys(english).some((k) => k.startsWith(`${key}.`))) {
        unknown.set(key, [...(unknown.get(key) || []), path.basename(file)]);
      }
    }
  }
  return [...unknown].map(([key, files]) => `${key} (${[...new Set(files)].join(', ')})`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [command = 'parity', dir, ...rest] = process.argv.slice(2);
  try {
    const catalogs = catalogsOf(dir ? path.resolve(dir) : null);
    const problems = command === 'parity' ? parity(catalogs)
      : command === 'used' ? unknownKeys(catalogs.en, rest.length ? rest : [process.cwd()]).map((k) => `not in any catalog: ${k}`)
        : [`Use: parity [dir] | used <dir> <source folders…>`];
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(command === 'parity'
        ? `Catalog parity: ${Object.keys(catalogs).length} languages, ${Object.keys(catalogs.en).length} keys`
        : 'Every key in use is in the catalogs');
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

export const SUITE_I18N_DIR = fileURLToPath(new URL('../i18n/', import.meta.url));
