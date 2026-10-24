/**
 * A module's own stylesheet, scoped to its windows: what lets several modules live in one page
 * (Cronum Work's one-document shell, architecture §21.6) without their classes and their `:root`
 * variables colliding. The host serves it with `scopedSheets` (`/<mount>/css/app.css?scope=work`);
 * the module's own file and the address it always had stay as they are.
 *
 * The sheet is wrapped in `@scope ([data-module="notes"], [data-owner="notes"])`: the module's
 * windows, and what its copy of the kit hangs on the page's body (toasts, dialogs, menus, the drag
 * ghost), which the kit marks as the module's (web/mount.js markOwned). Inside:
 *
 * - `:root` is the scope's root, `:scope`: the module's variables reach its windows and its pieces.
 * - `html` and `body` are its windows only, `:scope[data-module]`: `html, body { height: 100% }`
 *   made a toast's box take the whole page. `html body` and `:root[x] body` are one element now,
 *   and become one (`:scope[x][data-module]`).
 * - `@media`, `@supports`, `@container` and `@layer` stay where they are, their rules rooted the
 *   same way.
 *
 * What only means something for the whole page goes before the block: `@font-face`, `@keyframes`,
 * `@property`, `@import` (itself asked for scoped), `@charset`, `@view-transition`… And every
 * relative `url()` is made a path of the site, the sheet now living in the page: `data:`, another
 * site's, a path of the site and `#fragment` stay as they are.
 *
 * Pure: text in, text out, a broken sheet still giving balanced braces (a block left open is
 * closed, a stray `}` dropped), as the browser would read it.
 */

/** What changes what this returns for the same sheet: part of the host's ETag for it. */
export const SCOPE_FORMAT = 2;

/** At-rules of the whole page: never inside @scope, where they would mean nothing. */
const OUTSIDE = /^@(?:-webkit-|-moz-)?(?:charset|import|namespace|font-face|keyframes|property|counter-style|font-feature-values|font-palette-values|page|view-transition)\b/i;
/** At-rules whose block holds rules: they stay inside, their rules rooted the same way. */
const GROUPS = /^@(?:media|supports|container|layer|scope|starting-style|document|-moz-document)\b/i;
/** Pseudo-classes that take a list of selectors, rooted the same way. */
const SELECTOR_ARGS = /^:(?:is|where|not|has|matches|-webkit-any|-moz-any)\($/i;
/** A module's mount, as host.js checks it. */
const MOUNT = /^[a-z][a-z0-9-]{1,30}$/;

/** The sheet without its comments; a comment inside a string is the string's. */
function withoutComments(css) {
  let out = '';
  let quote = null;
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < css.length) { out += css[i + 1]; i += 1; } else if (c === quote) quote = null;
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
    } else {
      if (c === '"' || c === "'") quote = c;
      out += c;
    }
  }
  return out;
}

/**
 * Where the token starting at `i` ends, when it is one whose braces and semicolons aren't the
 * sheet's: a string, or an unquoted `url(…)` (a data: URL carries `;`). Else `i`.
 */
function skipToken(text, i) {
  const c = text[i];
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < text.length; j += 1) {
      if (text[j] === '\\') j += 1;
      else if (text[j] === c || text[j] === '\n') return j;
    }
    return text.length - 1;
  }
  if (c === '(' && /url$/i.test(text.slice(Math.max(0, i - 3), i))) {
    let j = i + 1;
    while (/\s/.test(text[j] || '')) j += 1;
    if (text[j] === '"' || text[j] === "'") return i;
    const end = text.indexOf(')', j);
    return end < 0 ? text.length - 1 : end;
  }
  return i;
}

/**
 * A block's contents as its parts, in order: `{ prelude, body }` for a rule with a block, and
 * `{ text }` for a statement (`@import …;`, a declaration) or what is left at the end.
 */
function partsOf(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let open = -1;
  for (let i = 0; i < text.length; i += 1) {
    const skipped = skipToken(text, i);
    if (skipped !== i) { i = skipped; continue; }
    const c = text[i];
    if (c === '{') {
      if (depth === 0) open = i;
      depth += 1;
    } else if (c === '}') {
      if (depth === 0) { start = i + 1; continue; }   // a stray brace: the browser drops it
      depth -= 1;
      if (depth === 0) {
        parts.push({ prelude: text.slice(start, open).trim(), body: text.slice(open + 1, i) });
        start = i + 1;
      }
    } else if (c === ';' && depth === 0) {
      const statement = text.slice(start, i + 1).trim();
      if (statement !== ';') parts.push({ text: statement });
      start = i + 1;
    }
  }
  // A block left open at the end is closed, as the browser closes it.
  if (depth > 0) parts.push({ prelude: text.slice(start, open).trim(), body: text.slice(open + 1) });
  else if (text.slice(start).trim()) parts.push({ text: text.slice(start).trim() });
  return parts;
}

/** `text` cut at its own `separator`s: never one inside (), [] or a string. */
function splitTop(text, separator) {
  const pieces = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const skipped = skipToken(text, i);
    if (skipped !== i) { i = skipped; continue; }
    const c = text[i];
    if (c === '(' || c === '[') depth += 1;
    else if ((c === ')' || c === ']') && depth > 0) depth -= 1;
    else if (depth === 0 && separator.test(c)) {
      pieces.push(text.slice(start, i));
      start = i + 1;
    }
  }
  pieces.push(text.slice(start));
  return pieces;
}

/** A complex selector as its compounds and the combinators between them: `[compound, ' > ', compound…]`. */
function compoundsOf(selector) {
  const text = selector.trim();
  const out = [''];
  let depth = 0;
  let between = null;
  const close = () => {
    if (between === null) return;
    out.push(between.trim() ? ` ${between.trim()} ` : ' ', '');
    between = null;
  };
  for (let i = 0; i < text.length; i += 1) {
    const skipped = skipToken(text, i);
    if (skipped !== i) {
      close();
      out[out.length - 1] += text.slice(i, skipped + 1);
      i = skipped;
      continue;
    }
    const c = text[i];
    if (depth === 0 && /[\s>+~]/.test(c)) { between = (between ?? '') + c; continue; }
    close();
    if (c === '(' || c === '[') depth += 1;
    else if ((c === ')' || c === ']') && depth > 0) depth -= 1;
    out[out.length - 1] += c;
  }
  return out;
}

const TYPE = /^(html|body)(?![\w-])/i;
const ROOT = /:root(?![\w-])/gi;

/** One compound (`html[data-theme="dark"]`, `body.x::before`) at the scope's root. */
function rootCompound(compound) {
  let out = '';
  // Inside :is(), :not()… the same rules, for each selector of their list.
  for (let i = 0; i < compound.length; i += 1) {
    const skipped = skipToken(compound, i);
    if (skipped !== i) { out += compound.slice(i, skipped + 1); i = skipped; continue; }
    out += compound[i];
    const pseudo = /:[\w-]+\($/.exec(out)?.[0];
    if (!pseudo || !SELECTOR_ARGS.test(pseudo)) continue;
    let depth = 1;
    let j = i + 1;
    for (; j < compound.length && depth; j += 1) {
      const end = skipToken(compound, j);
      if (end !== j) { j = end; continue; }
      if (compound[j] === '(') depth += 1;
      else if (compound[j] === ')') depth -= 1;
    }
    const inner = compound.slice(i + 1, depth ? j : j - 1);
    out += `${rootSelectors(inner)}${depth ? '' : ')'}`;
    i = j - 1;
  }
  const type = TYPE.exec(out);
  if (type) out = `:scope[data-module]${out.slice(type[0].length)}`;
  return out.replace(ROOT, ':scope');
}

/** Whether a compound is the page's root: `:root…` or `html…`, whatever else it says of it. */
const isPageRoot = (compound) => /^html(?![\w-])/i.test(compound) || /^[^\s(]*:root(?![\w-])/i.test(compound);

/** One complex selector, rooted: `:root[x] body .a` → `:scope[x][data-module] .a`. */
function rootSelector(selector) {
  const parts = compoundsOf(selector);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    const [part, combinator, next] = [parts[i], parts[i + 1], parts[i + 2]];
    if (isPageRoot(part) && (combinator === ' ' || combinator === ' > ') && /^body(?![\w-])/i.test(next ?? '')) {
      // The page's root and its body are one element now: the window.
      const rooted = rootCompound(part);
      out.push(`${rooted}${rooted.includes('[data-module]') ? '' : '[data-module]'}${rootCompound(next.slice(4))}`);
      if (parts[i + 3] !== undefined) out.push(parts[i + 3]);
      i += 2;
      continue;
    }
    out.push(part && rootCompound(part));
    if (combinator !== undefined) out.push(combinator);
  }
  return out.join('').trim();
}

/** A list of selectors (a rule's prelude), each rooted. */
function rootSelectors(list) {
  return splitTop(list, /,/).map((selector) => rootSelector(selector)).join(', ');
}

/** A relative url() of the sheet as a path of the site; anything else as it is. */
function siteUrl(href, sheetPath) {
  const value = href.trim();
  if (!value || value.startsWith('/') || value.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  try {
    const url = new URL(value, `http://host.invalid${sheetPath}`);
    return url.pathname + url.search + url.hash;
  } catch {
    return value;
  }
}

/** Every url() of `text` absolute against the sheet. */
const absolute = (text, sheetPath) => text.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi,
  (whole, quote, href) => `url(${quote}${siteUrl(href, sheetPath)}${quote})`);

/**
 * An @import of the sheet at its path: one of the module's own sheets asked for scoped too, else
 * its rules would be the page's. Another site's, or one of the page's, as it is.
 */
function importOf(statement, sheetPath) {
  const own = `/${sheetPath.split('/')[1]}/`;
  return statement.replace(/^(@import\s+)(?:url\(\s*)?(['"]?)([^'")\s]+)\2(\s*\))?/i, (whole, at, quote, href, close) => {
    const url = siteUrl(href, sheetPath);
    if (!url.startsWith(own) || !/\.css(?:$|\?)/i.test(url)) return whole;
    const scoped = `${url}${url.includes('?') ? '&' : '?'}scope=work`;
    return close ? `${at}url(${quote}${scoped}${quote})` : `${at}${quote || '"'}${scoped}${quote || '"'}`;
  });
}

/**
 * The parts of a block, split into what goes inside @scope and what goes before it. A group
 * (`@media`) keeps both halves under its own prelude.
 */
function place(text, sheetPath, { nested = false } = {}) {
  const inside = [];
  const outside = [];
  for (const part of partsOf(text)) {
    if ('text' in part) {
      if (nested) inside.push(absolute(part.text, sheetPath));
      else if (OUTSIDE.test(part.text)) outside.push(/^@import/i.test(part.text) ? importOf(part.text, sheetPath) : absolute(part.text, sheetPath));
      else inside.push(absolute(part.text, sheetPath));
      continue;
    }
    const { prelude, body } = part;
    if (!nested && OUTSIDE.test(prelude)) {
      outside.push(`${prelude} {${absolute(body, sheetPath)}}`);
    } else if (GROUPS.test(prelude)) {
      const held = place(body, sheetPath, { nested });
      if (held.outside.length) outside.push(`${prelude} {\n${held.outside.join('\n')}\n}`);
      if (held.inside.length || !held.outside.length) inside.push(`${prelude} {\n${held.inside.join('\n')}\n}`);
    } else if (prelude.startsWith('@')) {
      // Another at-rule with a block (`@font-feature-values`'s own, an unknown one): as it is.
      inside.push(`${prelude} {${absolute(body, sheetPath)}}`);
    } else {
      // A style rule: its own declarations, and the rules nested in it rooted the same way.
      const rooted = rootSelectors(prelude);
      const nests = partsOf(body).some((inner) => 'prelude' in inner);
      const content = nests ? place(body, sheetPath, { nested: true }).inside.join(' ') : absolute(body, sheetPath);
      inside.push(`${rooted} {${content}}`);
    }
  }
  return { inside, outside };
}

/** `@charset` first, then `@import` and `@namespace`, as a sheet must have them; then the rest. */
const RANK = (rule) => (/^@charset/i.test(rule) ? 0 : /^@(?:import|namespace)/i.test(rule) ? 1 : 2);

/**
 * @param {string} css        the module's sheet as it is
 * @param {string} module     its mount (`notes`)
 * @param {string} sheetPath  the sheet's path in the site (`/notes/css/app.css`), for its url()s
 * @returns {string} the sheet scoped to the module's windows and pieces
 */
export function scopeCss(css, module, sheetPath) {
  if (!MOUNT.test(String(module))) throw new TypeError(`scopeCss: "${module}" is not a module's mount`);
  const { inside, outside } = place(withoutComments(String(css ?? '')), String(sheetPath || `/${module}/`));
  const before = outside.map((rule, i) => [RANK(rule), i, rule]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , rule]) => rule);
  const scope = `[data-module="${module}"], [data-owner="${module}"]`;
  return `${before.length ? `${before.join('\n')}\n` : ''}@scope (${scope}) {\n${insets(inside.join('\n'))}\n}\n`;
}

/**
 * The screen's edges (`env(safe-area-inset-top)`, the iPhone's notch and home bar) as the window
 * says them: `var(--cw-inset-top, env(…))`. A window in Work's shell is never at the screen's top
 * or bottom (the shell's bar and tabs are, and keep their room), so windows.css says 0 there; what
 * a module hangs on the page's body keeps the screen's own.
 */
function insets(css) {
  return css.replace(/env\(\s*safe-area-inset-(top|bottom|left|right)\s*(,[^()]*)?\)/g,
    (_, side, fallback = '') => `var(--cw-inset-${side}, env(safe-area-inset-${side}${fallback}))`);
}
