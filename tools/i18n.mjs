/**
 * Catalog checks, for the suite's own texts and for each app's (taken from
 * Focus's tools/i18n.mjs):
 *
 *   node server/suite/tools/i18n.mjs parity [dir]            every language says the same things
 *   node server/suite/tools/i18n.mjs used <dir> <src>…       every key the code uses exists
 *   node server/suite/tools/i18n.mjs hardcoded <src>…        no text for people written in the code
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

/* ------------------------------ hardcoded texts ----------------------------- */

/**
 * Names that are the same in every language: the brand that signs every app,
 * the products and the protocols. An app adds its own with `allow`.
 */
export const BRAND_WORDS = [
  'by', 'Cronum', 'Cronum Studio', 'Cronum Work', 'Tasks', 'Projects', 'Next', 'Focus', 'Notes', 'Tracker', 'Talk',
  'MCP', 'OAuth', 'WorkOS', 'Claude', 'ChatGPT', 'English', 'Español', 'Français', 'Deutsch',
];

/** What a tag becomes while the text between tags is read. */
const MARK = '\u0000';
const LETTERS = /\p{L}{2,}/u;
/** Properties that put a text in front of people: el('…', { text: '…' }), node.title = '…'. */
const JS_TEXT = /(?:\b(?:text|textContent|innerText|placeholder|title|label|alt)\s*[:=]\s*|['"]aria-label['"]\s*:\s*|\b(?:toast|alert|confirm|prompt)\(\s*)(['"`])((?:\.|(?!\1).)*)\1/g;
const HTML_ATTRIBUTES = /\s(?:title|placeholder|alt|aria-label)="([^"]*)"/g;

/**
 * Texts for people written in the code instead of the catalogs: in .js,
 * strings given as text, titles, labels and notices; in .html, the text
 * between tags (outside script, style and code) and the attributes people
 * read. A line with `i18n-exempt` is skipped, and so is an element with
 * data-i18n (its text is filled from the catalog). → ["file:line: text"].
 */
export function hardcodedTexts(dirs, { allow = [] } = {}) {
  const allowed = new Set([...BRAND_WORDS, ...allow].map((w) => w.toLowerCase()));
  const isText = (value) => {
    const clean = value.replace(/\$\{[^}]*\}/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ').trim();
    if (!LETTERS.test(clean)) return false;
    if (allowed.has(clean.toLowerCase())) return false;
    // A key, an id, a class or a path: not words for people.
    if (/^[\w.:/#?&=-]+$/.test(clean) && !/\s/.test(clean) && /[._/:#-]|^[a-z]+[A-Z]/.test(clean)) return false;
    return true;
  };
  const found = [];
  for (const file of sources(dirs)) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const name = path.basename(file);
    if (file.endsWith('.html')) {
      // Whole-file passes that keep the line breaks, so a finding still says its line.
      const blank = (part) => part.replace(/[^\n]/g, ' ');
      let html = lines.map((line) => (line.includes('i18n-exempt') ? blank(line) : line)).join('\n')
        .replace(/<!--[\s\S]*?-->/g, blank)
        .replace(/<(script|style|code|pre)\b[\s\S]*?<\/\1>/gi, blank)
        // An element whose text comes from the catalog.
        .replace(/<([a-z][\w-]*)\b[^>]*\bdata-i18n="[^"]*"[^>]*>[^<]*<\/\1>/gi, blank);
      const lineAt = (index) => html.slice(0, index).split('\n').length;
      for (const tag of html.matchAll(/<[a-z][^>]*>/gi)) {
        if (/data-i18n-attr=/.test(tag[0])) continue;
        for (const match of tag[0].matchAll(HTML_ATTRIBUTES)) {
          if (isText(match[1])) found.push(`${name}:${lineAt(tag.index)}: ${match[1]}`);
        }
      }
      // Tags become a mark (keeping their line breaks); what is between them is text.
      html = html.replace(/<[^>]*>/g, (tag) => MARK + tag.replace(/[^\n]/g, ''));
      let offset = 0;
      for (const piece of html.split(MARK)) {
        if (isText(piece)) found.push(`${name}:${lineAt(offset + piece.search(/\S/))}: ${piece.trim().replace(/\s+/g, ' ')}`);
        offset += piece.length + 1;
      }
      continue;
    }
    lines.forEach((line, i) => {
      if (line.includes('i18n-exempt') || /^\s*(?:\*|\/\/|\/\*)/.test(line)) return;
      for (const match of line.matchAll(JS_TEXT)) if (isText(match[2])) found.push(`${name}:${i + 1}: ${match[2]}`);
    });
  }
  return found;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [command = 'parity', dir, ...rest] = process.argv.slice(2);
  try {
    const catalogs = catalogsOf(dir ? path.resolve(dir) : null);
    const problems = command === 'parity' ? parity(catalogs)
      : command === 'used' ? unknownKeys(catalogs.en, rest.length ? rest : [process.cwd()]).map((k) => `not in any catalog: ${k}`)
        : command === 'hardcoded' ? hardcodedTexts([dir, ...rest].filter(Boolean).map((d) => path.resolve(d))).map((f) => `written in the code: ${f}`)
          : [`Use: parity [dir] | used <dir> <source folders…> | hardcoded <source folders…>`];
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(command === 'parity'
        ? `Catalog parity: ${Object.keys(catalogs).length} languages, ${Object.keys(catalogs.en).length} keys`
        : command === 'used' ? 'Every key in use is in the catalogs' : 'No text written in the code');
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

export const SUITE_I18N_DIR = fileURLToPath(new URL('../i18n/', import.meta.url));
