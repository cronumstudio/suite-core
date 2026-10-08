/**
 * Catalog checks, for the suite's own texts and for each app's (taken from
 * Focus's tools/i18n.mjs):
 *
 *   node server/suite/tools/i18n.mjs app [root] [--skip <file>]…  all of the below for an app, as its tests run them
 *   node server/suite/tools/i18n.mjs parity [dir]            every language says the same things
 *   node server/suite/tools/i18n.mjs used <dir> <src>…       every key the code uses exists
 *   node server/suite/tools/i18n.mjs hardcoded <src>…        no text for people written in the code
 *   node server/suite/tools/i18n.mjs hardcoded --server [--skip <file>]… <src>…
 *                                                            no text in another language on the server
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
import { LANGUAGES, SUITE_CATALOGS, flatten, isNested } from '../i18n.js';

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

/**
 * Source files (.js, .mjs, .html) under the given folders, leaving out tests,
 * the suite, others' code (vendor) and the files `skip` names (by name or by the
 * end of their path).
 */
function sources(dirs, skip = []) {
  const files = [];
  const skipped = (file) => skip.some((entry) => {
    const end = entry.replace(/\\/g, '/');
    const full = file.replace(/\\/g, '/');
    return full === end || full.endsWith(`/${end}`);
  });
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'test', 'suite', 'i18n', 'vendor'].includes(entry.name)) walk(full);
      } else if (/\.(?:m?js|html)$/.test(entry.name)) files.push(full);
    }
  };
  for (const dir of dirs) {
    if (statSync(dir).isDirectory()) walk(dir);
    else files.push(dir);
  }
  return files.filter((file) => !skipped(file));
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

const LETTERS = /\p{L}{2,}/u;
/** Letters English doesn't use: a text with one is in another language (Latin-1 and Œ œ Ÿ, ¿ ¡). */
const FOREIGN = /[À-ÖØ-öø-ÿŒœŸ¡¿]/;
/** A capital, a word and more words: a sentence, whatever is done with it. */
const SENTENCE = /^\p{Lu}[\p{Ll}'’]+(?:\s+[\p{L}'’,.!?:()-]+)+/u;
/** …unless it is for the developer: an error's message or the console. */
const FOR_DEVELOPERS = /(?:Error|console\.\w+)\(\s*$/;
/** A query: code, even when it matches words in other languages. */
const SQL = /^(?:SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|PRAGMA)\s/;
/**
 * The code just before a literal people read: text:, title:, placeholder:, label:, alt:, aria-label
 * values (also behind a `?`, `:`, `||`, `??` or `&&`), textContent, title… assignments,
 * setAttribute('title' | 'aria-label'…), toast(), confirmDialog(), alert(), confirm() and prompt().
 */
const READ_IN = /(?:\b(?:text|title|placeholder|label|alt|textContent|innerText|ariaLabel)\s*[:=](?!=)\s*(?:[^,;{}()]*?(?:\?\?|\|\||&&|\?|:)\s*)?|['"]aria-(?:label|description)['"]\s*:\s*(?:[^,;{}()]*?(?:\?\?|\|\||&&|\?|:)\s*)?|setAttribute\(\s*['"](?:title|aria-label|aria-description|placeholder|alt)['"]\s*,\s*|\b(?:toast|confirmDialog|alert|confirm|prompt)\(\s*)$/;
const HTML_ATTRIBUTES = ['title', 'aria-label', 'aria-description', 'placeholder', 'alt', 'label'];
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/**
 * Splits JavaScript into its literals and the rest (from Tasks' smoke test). Comments and regular
 * expressions are blanked; the text of strings and templates is masked unless it looks like a word or
 * a key, so the code before a literal can be matched on `masked` without a string's content fooling
 * it. `literals` holds each one's static text, with `${}` where an expression was, and where it starts.
 * `masked` keeps every character's place, line breaks included.
 */
export function scanLiterals(src) {
  const literals = [];
  const out = [];
  let i = 0;
  let lastSignificant = '';
  const push = (s) => out.push(s);
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const regexAllowedAfter = (prev) => prev === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev)
    || /\b(?:return|typeof|case|in|of|delete|void|throw|new|else|do)$/.test(prev);

  function readString(quote) {
    const start = i;
    i++;
    let text = '';
    while (i < src.length && src[i] !== quote && src[i] !== '\n') {
      if (src[i] === '\\') { text += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
      text += src[i++];
    }
    i++;
    literals.push({ start, text, kind: 'string' });
    push(quote + (/^[\w-]+$/.test(text) ? text : blank(text).replace(/ /g, 'x')) + quote);
    lastSignificant = quote;
  }

  function readTemplate() {
    const start = i;
    i++;
    let text = '';
    push('`');
    let maskedRun = '';
    const flush = () => { push(maskedRun); maskedRun = ''; };
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { text += src[i] + (src[i + 1] ?? ''); maskedRun += src[i + 1] === '\n' ? ' \n' : '  '; i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') {
        flush();
        push('${');
        i += 2;
        let depth = 1;
        // The expression is code: scanned like the rest, until its closing brace.
        while (i < src.length) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}' && --depth === 0) { i++; break; }
          if (src[i] === '{' || src[i] === '}') { push(src[i]); i++; continue; }
          scanOne();
        }
        push('}');
        text += '${}';
        continue;
      }
      text += src[i];
      maskedRun += src[i] === '\n' ? '\n' : 'x';
      i++;
    }
    flush();
    i++;
    push('`');
    literals.push({ start, text, kind: 'template' });
    lastSignificant = '`';
  }

  // One token of code.
  function scanOne() {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      push(blank(src.slice(i, stop)));
      i = stop;
      return;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      push(blank(src.slice(i, stop)));
      i = stop;
      return;
    }
    if (c === '\'' || c === '"') { readString(c); return; }
    if (c === '`') { readTemplate(); return; }
    if (c === '/' && regexAllowedAfter(lastSignificant)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      j++;
      while (/[a-z]/.test(src[j] || '')) j++;
      push(`/${'r'.repeat(Math.max(0, j - i - 2))}/`);
      i = j;
      lastSignificant = '/';
      return;
    }
    push(c);
    if (!/\s/.test(c)) lastSignificant = (lastSignificant + c).slice(-12);
    i++;
  }

  while (i < src.length) scanOne();
  return { masked: out.join(''), literals };
}

/** The line each offset of `text` is on, quickly, for files with thousands of literals. */
function lineFinder(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle; else high = middle - 1;
    }
    return low + 1;
  };
}

/** A literal's text as people would read it: escapes decoded, `${}` and line breaks as spaces. */
const readable = (text) => text
  .replace(/\\u\{([\da-f]+)\}|\\u([\da-f]{4})|\\x([\da-f]{2})/gi, (_, a, b, c) => String.fromCodePoint(parseInt(a ?? b ?? c, 16)))
  .replace(/\\[nrtvbf]/g, ' ').replace(/\\(.)/g, '$1')
  .replace(/\$\{\}/g, ' ').replace(/\s+/g, ' ').trim();

const short = (text) => (text.length > 60 ? `${text.slice(0, 57)}…` : text);

/**
 * Texts for people written in the code instead of the catalogs → ["file:line: text"].
 *
 * In the browser's .js: a text in another language anywhere, and any text given as an element's
 * text, title, label, placeholder or alt, set with setAttribute, or shown with toast() or
 * confirmDialog(), also as either side of a condition; and a sentence wherever it is, unless it is an
 * error's message or goes to the console. Comments and regular expressions are left out.
 * In .html: the text between tags (outside script, style, code and pre, and inside no element with
 * data-i18n) and the title, aria-label, placeholder, alt and label attributes not covered by
 * data-i18n-attr.
 *
 * With `server`, only texts in another language than English count: the server answers codes and
 * writes what people read from the catalogs (notices, mail), and the English it has is for the
 * developer and for the assistant (MCP). Another language is told by the letters English doesn't
 * use, so "Nueva tarea" slips through; an error's message, the console and SQL don't count.
 * `skip` leaves out files that are data, such as seeds in every language.
 *
 * Everywhere, a line with `i18n-exempt` is skipped (say why on it), and so are keys, paths, URLs,
 * acronyms and the names in BRAND_WORDS and `allow`.
 */
export function hardcodedTexts(dirs, { allow = [], skip = [], server = false } = {}) {
  const allowed = new Set([...BRAND_WORDS, ...allow].map((w) => w.toLowerCase()));
  const isText = (clean) => {
    if (!LETTERS.test(clean)) return false;
    if (allowed.has(clean.toLowerCase())) return false;
    // An acronym or a format (PDF, CSV, UTC): the same in every language.
    if (/^[A-Z0-9]{2,6}$/.test(clean)) return false;
    // A key, an id, a class, a path or a URL: not words for people.
    if (/^[\w.:/#?&=%@~+-]+$/.test(clean) && /[._/:#-]|^[a-z]+[A-Z]/.test(clean)) return false;
    return true;
  };
  const found = [];
  for (const file of sources(dirs, skip)) {
    const source = readFileSync(file, 'utf8');
    const name = path.basename(file);
    const lineAt = lineFinder(source);
    const exempt = new Set(source.split('\n').flatMap((line, i) => (line.includes('i18n-exempt') ? [i + 1] : [])));
    const report = (offset, text) => {
      const line = lineAt(offset);
      if (!exempt.has(line)) found.push(`${name}:${line}: ${short(text)}`);
    };

    if (file.endsWith('.html')) {
      const blank = (part) => part.replace(/[^\n]/g, ' ');
      const html = source
        // What the server fills in ({{app.name}}) is not written here.
        .replace(/\{\{[^}]*\}\}/g, blank)
        .replace(/<!--[\s\S]*?-->/g, blank)
        .replace(/<![^>]*>/g, blank)
        .replace(/<(script|style|code|pre)\b[\s\S]*?<\/\1\s*>/gi, blank);
      const stack = [];
      const token = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?)*)\s*(\/?)>|([^<]+)/g;
      for (const match of html.matchAll(token)) {
        const [, closing, tag, rawAttributes = '', selfClosing, between] = match;
        if (between !== undefined) {
          const words = between.replace(/&[#\w]+;/g, ' ').replace(/\s+/g, ' ').trim();
          if (isText(words) && !stack.some((open) => open.translated)) report(match.index + between.search(/\S/), words);
          continue;
        }
        const lower = tag.toLowerCase();
        if (closing) {
          const at = stack.map((open) => open.tag).lastIndexOf(lower);
          if (at !== -1) stack.length = at;
          continue;
        }
        const attributes = Object.fromEntries([...rawAttributes.matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?/g)]
          .map(([, key, a, b, c]) => [key.toLowerCase(), a ?? b ?? c ?? '']));
        const translatedAttributes = (attributes['data-i18n-attr'] || '').split(';').map((pair) => pair.split(':')[0].trim());
        for (const attribute of HTML_ATTRIBUTES) {
          const value = (attributes[attribute] || '').trim();
          if (isText(value) && !translatedAttributes.includes(attribute)) report(match.index, value);
        }
        if (!selfClosing && !VOID.has(lower)) stack.push({ tag: lower, translated: 'data-i18n' in attributes });
      }
      continue;
    }

    const { masked, literals } = scanLiterals(source);
    for (const literal of literals) {
      const text = readable(literal.text);
      if (!isText(text)) continue;
      const before = masked.slice(Math.max(0, literal.start - 90), literal.start);
      const forDevelopers = FOR_DEVELOPERS.test(before) || SQL.test(text);
      const counts = server
        ? FOREIGN.test(text) && !forDevelopers
        : FOREIGN.test(text) || READ_IN.test(before) || (SENTENCE.test(text) && !forDevelopers);
      if (counts) report(literal.start, text);
    }
  }
  return found;
}

/* -------------------------------- an app's -------------------------------- */

/**
 * Every check of an app's texts, the same for every app: its catalogs
 * (`<root>/public/i18n`, flat, every language saying what English says), the
 * keys its browser and server use, and no text written in its browser's code
 * or HTML, nor in another language on its server. `skip` leaves out data files
 * (seeds in every language); others' code under a `vendor` folder is never read.
 * → [{ name, problems }], for the app's tests to turn into checks.
 */
export function appChecks(root, { skip = [], allow = [] } = {}) {
  const dir = path.join(root, 'public', 'i18n');
  const publicDir = path.join(root, 'public');
  const serverDir = path.join(root, 'server');
  const catalogs = catalogsOf(dir);
  const nested = LANGUAGES.flatMap((lang) => {
    try {
      return isNested(JSON.parse(readFileSync(path.join(dir, `${lang}.json`), 'utf8'))) ? [`${lang}.json`] : [];
    } catch (err) {
      return [`${lang}.json: ${err.code === 'ENOENT' ? 'missing' : err.message}`];
    }
  });
  return [
    { name: 'The catalogs in public/i18n are there for every language, and flat: dotted keys, a text or plural forms each', problems: nested },
    { name: 'Every language says what English says: the same keys, placeholders and plural forms, nothing left undone', problems: parity(catalogs) },
    { name: 'Every key the browser and the server use (t(), data-i18n, data-i18n-attr) is in the catalogs', problems: unknownKeys(catalogs.en, [publicDir, serverDir]) },
    { name: 'No text for people is written in the browser’s code or in the HTML', problems: hardcodedTexts([publicDir], { allow, skip }) },
    { name: 'Nothing on the server is written in another language: what people read comes from the catalogs', problems: hardcodedTexts([serverDir], { server: true, allow, skip }) },
  ];
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [command = 'parity', ...args] = process.argv.slice(2);
  const [dir, ...rest] = args;
  try {
    let problems;
    if (command === 'app') {
      const skip = [];
      let root = '.';
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--skip') skip.push(args[++i]);
        else root = args[i];
      }
      const checks = appChecks(path.resolve(root), { skip });
      for (const { name, problems: found } of checks) {
        console.log(`${found.length ? '✗' : '✓'} ${name}`);
        for (const problem of found.slice(0, 20)) console.log(`    ${problem}`);
      }
      problems = checks.flatMap((check) => check.problems);
      if (problems.length) process.exitCode = 1;
      problems = [];
    } else if (command === 'hardcoded') {
      const options = { server: false, skip: [] };
      const folders = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--server') options.server = true;
        else if (args[i] === '--skip') options.skip.push(args[++i]);
        else folders.push(path.resolve(args[i]));
      }
      problems = hardcodedTexts(folders, options).map((f) => `written in the code: ${f}`);
    } else {
      const catalogs = catalogsOf(dir ? path.resolve(dir) : null);
      problems = command === 'parity' ? parity(catalogs)
        : command === 'used' ? unknownKeys(catalogs.en, rest.length ? rest : [process.cwd()]).map((k) => `not in any catalog: ${k}`)
          : [`Use: app [root] [--skip <file>]… | parity [dir] | used <dir> <source folders…> | hardcoded [--server] [--skip <file>]… <source folders…>`];
      if (!problems.length) {
        console.log(command === 'parity'
          ? `Catalog parity: ${Object.keys(catalogs).length} languages, ${Object.keys(catalogs.en).length} keys`
          : 'Every key in use is in the catalogs');
      }
    }
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exitCode = 1;
    } else if (command === 'hardcoded') {
      console.log('No text written in the code');
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

export const SUITE_I18N_DIR = fileURLToPath(new URL('../i18n/', import.meta.url));
