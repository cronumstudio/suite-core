/**
 * Markdown, read: what Notes stores, shown formatted, and what any app can
 * show of a note. Two steps: `parseMarkdown()` turns the text into a plain
 * tree (no DOM, so it is tested on its own), and `renderMarkdown()` builds the
 * nodes with `el()`, through textContent and setAttribute. HTML written in a
 * note is shown as the text it is, never interpreted: there is no innerHTML
 * anywhere, and that is the whole defence.
 *
 * What it reads, the part of CommonMark and GitHub's tables and task lists
 * that notes use: headings (#), paragraphs, line breaks (two spaces or a
 * backslash at the end), lists (-, *, +, 1. and 1)) nested by indentation,
 * task lists (- [ ] / - [x]), quotes (>), fenced code (``` or ~~~), rules
 * (---), tables, and inline **strong**, *emphasis*, ~~struck~~, `code`,
 * [links](url "title"), <autolinks>, bare https:// addresses and
 * ![images](src), with backslash escapes (\*) and the entities editors write
 * (&lt; &gt; &amp; &quot; &apos; &nbsp; and numeric ones). Two marks beyond
 * CommonMark, as Obsidian, Bear and Typora write them, because Markdown has
 * no other way to say them: ==highlighted== and ++underlined++.
 *
 * Links go only to http, https and mailto, or within the app (a path, a
 * #fragment); anything else (javascript:, data:, vbscript:…) is shown as
 * text. Images load only from the app itself: an image elsewhere becomes a
 * link, so nothing in a note makes the reader's browser call a third party.
 */
import { el } from './dom.js';

/* --------------------------------- urls ---------------------------------- */

const LINK_SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * The address a link may have, or null. Browsers ignore tabs, newlines and
 * control characters inside a scheme ("java\tscript:"), so they go before the
 * scheme is read.
 */
export function safeHref(url) {
  const clean = String(url ?? '').replace(/[\u0000- \u007f]/g, '');
  if (!clean) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(clean);
  if (scheme) return LINK_SCHEMES.has(scheme[1].toLowerCase()) ? clean : null;
  return clean;
}

/** The address an image may load from: only this app (a path with no scheme and no other host). */
export function safeImage(url) {
  const clean = String(url ?? '').replace(/[\u0000- \u007f]/g, '');
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || /^[\\/]{2}/.test(clean) || /^\/\\/.test(clean)) return null;
  return clean;
}

/* -------------------------------- inline --------------------------------- */

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const isSpace = (c) => c === undefined || /\s/.test(c);
const isWord = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** From `[` at `start`: the label, the destination and the title of a link, or null. */
function readLink(text, start) {
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > 0) i = close;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) break;
  }
  if (i >= text.length || text[i + 1] !== '(') return null;
  const label = text.slice(start + 1, i);
  let j = i + 2;
  while (text[j] === ' ') j++;
  let href = '';
  if (text[j] === '<') {
    const close = text.indexOf('>', j);
    if (close < 0) return null;
    href = text.slice(j + 1, close);
    j = close + 1;
  } else {
    let parens = 0;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === '\\' && j + 1 < text.length) { href += text[++j]; continue; }
      if (c === '(') parens++;
      else if (c === ')') { if (parens === 0) break; parens--; } else if (c === ' ') break;
      href += c;
    }
  }
  while (text[j] === ' ') j++;
  let title = null;
  const quote = text[j];
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, j + 1);
    if (close < 0) return null;
    title = text.slice(j + 1, close);
    j = close + 1;
    while (text[j] === ' ') j++;
  }
  if (text[j] !== ')') return null;
  return { label, href, title, end: j + 1 };
}

/** The closing run of `delim` for an opening at `from`, or -1. */
function findClose(text, from, delim) {
  const char = delim[0];
  for (let j = from; j < text.length; j++) {
    if (text[j] === '\\') { j++; continue; }
    if (text[j] === '`') {
      const close = text.indexOf('`', j + 1);
      if (close > 0) { j = close; continue; }
    }
    if (!text.startsWith(delim, j)) continue;
    // A run of exactly this length: `*` must not close on `**`.
    let end = j;
    while (text[end] === char) end++;
    let begin = j;
    while (begin > from && text[begin - 1] === char) begin--;
    if (end - begin !== delim.length) { j = end - 1; continue; }
    if (isSpace(text[j - 1])) continue;
    // `_` inside a word (snake_case) is a letter, not emphasis; so are `+` and `=` (C++, a==b).
    if (INTRAWORD.has(char) && isWord(text[end])) continue;
    return j;
  }
  return -1;
}

/** Marks that never open or close inside a word. */
const INTRAWORD = new Set(['_', '+', '=']);

/** The marks that come only in pairs, and what each one is. */
const DOUBLE = { '~': 'del', '=': 'mark', '+': 'u' };

/** The entities editors write: the ones HTML needs escaped, the hard space, and any by number. */
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/y;

/** The entity at `at`: its character and length, or null. A number no character has is U+FFFD. */
function readEntity(text, at) {
  ENTITY.lastIndex = at;
  const match = ENTITY.exec(text);
  if (!match) return null;
  const [whole, dec, hex, name] = match;
  if (name) return { char: NAMED_ENTITIES[name], length: whole.length };
  const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
  const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
  return { char: valid ? String.fromCodePoint(code) : '\ufffd', length: whole.length };
}

/** A line's text as it reads: escapes and entities undone (not code spans, which titles rarely have). */
function unescapeText(text) {
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && PUNCTUATION.test(text[i + 1] ?? '')) { out += text[i + 1]; i += 2; continue; }
    const entity = text[i] === '&' ? readEntity(text, i) : null;
    if (entity) { out += entity.char; i += entity.length; continue; }
    out += text[i];
    i++;
  }
  return out;
}

const BARE_URL = /^https?:\/\/[^\s<>]*[^\s<>.,:;"')\]!?*_~]/;

/** Inline content as nodes: { type: text | code | em | strong | del | mark | u | link | image | br, … }. */
export function parseInline(text) {
  const out = [];
  let buffer = '';
  const flush = () => {
    if (buffer) out.push({ type: 'text', text: buffer });
    buffer = '';
  };
  for (let i = 0; i < text.length;) {
    const c = text[i];

    if (c === '\\' && text[i + 1] === '\n') { flush(); out.push({ type: 'br' }); i += 2; continue; }
    if (c === '\\' && PUNCTUATION.test(text[i + 1] ?? '')) { buffer += text[i + 1]; i += 2; continue; }

    if (c === '\n') {
      if (/ {2,}$/.test(buffer)) {
        buffer = buffer.replace(/ +$/, '');
        flush();
        out.push({ type: 'br' });
      } else {
        buffer = buffer.replace(/ +$/, '');
        buffer += '\n';
      }
      i++;
      while (text[i] === ' ') i++;
      continue;
    }

    if (c === '`') {
      let run = 0;
      while (text[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      let close = text.indexOf(fence, i + run);
      while (close >= 0 && text[close + run] === '`') close = text.indexOf(fence, close + run + 1);
      if (close < 0) { buffer += fence; i += run; continue; }
      flush();
      let code = text.slice(i + run, close).replace(/\n/g, ' ');
      if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
      out.push({ type: 'code', text: code });
      i = close + run;
      continue;
    }

    if (c === '!' && text[i + 1] === '[') {
      const link = readLink(text, i + 1);
      if (link) {
        flush();
        out.push({ type: 'image', src: link.href, alt: link.label.replace(/[\\*_`~[\]]/g, ''), title: link.title });
        i = link.end;
        continue;
      }
    }

    if (c === '[') {
      const link = readLink(text, i);
      if (link) {
        flush();
        out.push({ type: 'link', href: link.href, title: link.title, children: parseInline(link.label) });
        i = link.end;
        continue;
      }
    }

    if (c === '<') {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(text.slice(i));
      if (auto) {
        flush();
        out.push({ type: 'link', href: auto[1], title: null, children: [{ type: 'text', text: auto[1].replace(/^mailto:/i, '') }] });
        i += auto[0].length;
        continue;
      }
    }

    if ((c === 'h' || c === 'H') && (i === 0 || /[\s(]/.test(text[i - 1]))) {
      const bare = BARE_URL.exec(text.slice(i));
      if (bare) {
        flush();
        out.push({ type: 'link', href: bare[0], title: null, children: [{ type: 'text', text: bare[0] }] });
        i += bare[0].length;
        continue;
      }
    }

    if (c === '*' || c === '_' || c in DOUBLE) {
      let run = 0;
      while (text[i + run] === c) run++;
      const opensWord = !isSpace(text[i + run]) && !(INTRAWORD.has(c) && isWord(text[i - 1]));
      const tries = c in DOUBLE ? (run === 2 ? [2] : []) : run >= 3 ? [2, 1] : [run];
      let matched = false;
      if (opensWord) {
        for (const size of tries) {
          const delim = c.repeat(size);
          const start = i + (run - size);
          const close = findClose(text, start + size + 1, delim);
          if (close > start + size) {
            buffer += c.repeat(run - size);
            flush();
            const type = DOUBLE[c] || (size === 2 ? 'strong' : 'em');
            out.push({ type, children: parseInline(text.slice(start + size, close)) });
            i = close + size;
            matched = true;
            break;
          }
        }
      }
      if (!matched) { buffer += c.repeat(run); i += run; }
      continue;
    }

    if (c === '&') {
      const entity = readEntity(text, i);
      if (entity) { buffer += entity.char; i += entity.length; continue; }
    }

    buffer += c;
    i++;
  }
  flush();
  return out;
}

/* --------------------------------- blocks -------------------------------- */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const TASK = /^\[([ xX])\][ \t]+/;
const blank = (line) => !line || !line.text.trim();

const startsBlock = (text) => FENCE.test(text) || HEADING.test(text) || RULE.test(text) || QUOTE.test(text) || ITEM.test(text);

/** A table row's cells: split on | that aren't escaped or inside code. */
function cells(row) {
  let text = row.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const out = [];
  let cell = '';
  let code = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && text[i + 1] === '|') { cell += '|'; i++; continue; }
    if (c === '`') code = !code;
    if (c === '|' && !code) { out.push(cell.trim()); cell = ''; continue; }
    cell += c;
  }
  out.push(cell.trim());
  return out;
}

/**
 * Block content: lines are { text, n }, n being the line's number in the
 * whole note (task items keep it, so ticking one changes that line).
 */
function parseBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    const { text } = line;

    const fence = FENCE.exec(text);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i].text)) {
        body.push(lines[i].text);
        i++;
      }
      i++;
      out.push({ type: 'code', lang: fence[2] || null, text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(text);
    if (heading) {
      out.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2] || '') });
      i++;
      continue;
    }

    if (RULE.test(text)) { out.push({ type: 'rule' }); i++; continue; }

    if (QUOTE.test(text)) {
      const inner = [];
      while (i < lines.length && !blank(lines[i]) && (QUOTE.test(lines[i].text) || inner.length)) {
        const quoted = QUOTE.exec(lines[i].text);
        // A line without ">" right after a quoted paragraph continues it.
        if (!quoted && startsBlock(lines[i].text)) break;
        inner.push({ text: quoted ? quoted[1] : lines[i].text, n: lines[i].n });
        i++;
      }
      out.push({ type: 'quote', children: parseBlocks(inner) });
      continue;
    }

    const item = ITEM.exec(text);
    if (item) {
      const [list, next] = parseList(lines, i);
      out.push(list);
      i = next;
      continue;
    }

    // A table: a row with pipes, then the row of dashes.
    if (text.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1].text) && lines[i + 1].text.includes('-')) {
      const head = cells(text);
      const align = cells(lines[i + 1].text).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      const rows = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i].text.includes('|')) {
        rows.push(cells(lines[i].text));
        i++;
      }
      out.push({
        type: 'table',
        align: head.map((_, k) => align[k] ?? null),
        head: head.map((c) => parseInline(c)),
        rows: rows.map((row) => head.map((_, k) => parseInline(row[k] ?? ''))),
      });
      continue;
    }

    // A paragraph: until a blank line or something that starts a block.
    const para = [text];
    i++;
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i].text)) {
      para.push(lines[i].text);
      i++;
    }
    out.push({ type: 'paragraph', children: parseInline(para.join('\n').trim()) });
  }
  return out;
}

/** A list from line `start`: its items, each with its own blocks. → [list, next line]. */
function parseList(lines, start) {
  const first = ITEM.exec(lines[start].text);
  const ordered = /\d/.test(first[2]);
  const bullet = first[2].slice(-1);
  const list = { type: 'list', ordered, start: ordered ? Number.parseInt(first[2], 10) : null, items: [] };
  let i = start;
  while (i < lines.length) {
    const match = ITEM.exec(lines[i].text);
    if (!match || /\d/.test(match[2]) !== ordered || match[2].slice(-1) !== bullet) break;
    // Where the item's text starts: what follows, indented that far, belongs to it.
    const indent = match[1].length + match[2].length + 1;
    const content = [{ text: match[3] ?? '', n: lines[i].n }];
    const n = lines[i].n;
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (blank(line)) {
        // A blank line, then something indented: still this item.
        const after = lines[i + 1];
        if (after && !blank(after) && /^\s*/.exec(after.text)[0].length >= Math.min(indent, 2)) {
          content.push({ text: '', n: line.n });
          i++;
          continue;
        }
        break;
      }
      const lead = /^\s*/.exec(line.text)[0].length;
      if (lead >= Math.min(indent, 2) && lead > 0) {
        content.push({ text: line.text.slice(Math.min(lead, indent)), n: line.n });
        i++;
        continue;
      }
      // A plain line right after the item's text continues its paragraph.
      if (!startsBlock(line.text) && content.length === 1) {
        content.push({ text: line.text, n: line.n });
        i++;
        continue;
      }
      break;
    }
    const task = TASK.exec(content[0].text);
    if (task) content[0] = { text: content[0].text.slice(task[0].length), n: content[0].n };
    list.items.push({ task: task ? task[1] !== ' ' : null, line: n, children: parseBlocks(content) });
    // A blank line between items ends nothing; another kind of block does.
    while (i < lines.length && blank(lines[i]) && lines[i + 1] && ITEM.test(lines[i + 1].text)) i++;
  }
  return [list, i];
}

/** The note as a tree of blocks. */
export function parseMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
    .map((text, n) => ({ text, n }));
  return { type: 'document', children: parseBlocks(lines) };
}

/* ------------------------------- the source ------------------------------ */

/** Ticks or unticks the task on line `n` of the source; the rest stays as it was. */
export function toggleTask(source, n, done) {
  const lines = String(source).split('\n');
  const line = lines[n];
  if (line === undefined) return source;
  lines[n] = line.replace(/^(\s*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[[ xX]\]/, `$1[${done ? 'x' : ' '}]`);
  return lines.join('\n');
}

/**
 * A note's title: its first line with words, without the marks of a heading,
 * and with its escapes and entities undone (an editor writes "\~12", and
 * "&nbsp;" for a line it leaves empty).
 */
export function titleOf(source) {
  const line = String(source ?? '').split('\n').find((l) => unescapeText(l).trim()) || '';
  return unescapeText(line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '')).trim();
}

/** The words of a note without its marks: for previews and snippets. */
export function plainText(source) {
  const words = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.type === 'text' || node.type === 'code') words.push(node.text);
      else if (node.type === 'image') words.push(node.alt);
      else if (node.type === 'br') words.push(' ');
      if (node.children) walk(node.children);
      if (node.items) node.items.forEach((item) => walk(item.children));
      if (node.head) { node.head.forEach(walk); node.rows.forEach((row) => row.forEach(walk)); }
      if (['paragraph', 'heading', 'code', 'list', 'quote', 'table'].includes(node.type)) words.push(' ');
    }
  };
  walk(parseMarkdown(source).children);
  return words.join('').replace(/\s+/g, ' ').trim();
}

/* -------------------------------- rendering ------------------------------ */

function inlineNodes(nodes, options) {
  return nodes.map((node) => {
    switch (node.type) {
      case 'text': return node.text;
      case 'br': return el('br');
      case 'code': return el('code', { text: node.text });
      case 'em': return el('em', {}, inlineNodes(node.children, options));
      case 'strong': return el('strong', {}, inlineNodes(node.children, options));
      case 'del': return el('del', {}, inlineNodes(node.children, options));
      case 'mark': return el('mark', {}, inlineNodes(node.children, options));
      case 'u': return el('u', {}, inlineNodes(node.children, options));
      case 'link': {
        const href = safeHref(node.href);
        const children = inlineNodes(node.children, options);
        if (!href) return el('span', {}, children);
        const outside = /^(?:https?:|mailto:|\/\/)/i.test(href);
        return el('a', {
          href, title: node.title,
          ...(outside ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {}),
        }, children);
      }
      case 'image': {
        const src = safeImage(options.resolveImage ? options.resolveImage(node.src) : node.src);
        if (src) return el('img', { src, alt: node.alt, title: node.title, loading: 'lazy', decoding: 'async' });
        // Not from here: a link the reader may follow, never a request made for them.
        const href = safeHref(node.src);
        const label = node.alt || node.src;
        return href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow', text: label }) : label;
      }
      default: return null;
    }
  });
}

function blockNodes(nodes, options) {
  return nodes.map((node) => {
    switch (node.type) {
      case 'heading': return el(`h${node.level}`, {}, inlineNodes(node.children, options));
      case 'paragraph': return el('p', {}, inlineNodes(node.children, options));
      case 'rule': return el('hr');
      case 'quote': return el('blockquote', {}, blockNodes(node.children, options));
      case 'code': return el('pre', {}, el('code', {
        text: node.text,
        'data-lang': node.lang && /^[\w+#.-]{1,30}$/.test(node.lang) ? node.lang : null,
      }));
      case 'list': return el(node.ordered ? 'ol' : 'ul', { start: node.ordered && node.start !== 1 ? node.start : null },
        node.items.map((item) => listItem(item, options)));
      case 'table': return el('table', {},
        el('thead', {}, el('tr', {}, node.head.map((cell, k) => el('th', { style: alignStyle(node.align[k]) }, inlineNodes(cell, options))))),
        el('tbody', {}, node.rows.map((row) => el('tr', {}, row.map((cell, k) => el('td', { style: alignStyle(node.align[k]) }, inlineNodes(cell, options)))))));
      default: return null;
    }
  });
}

const alignStyle = (align) => (align ? `text-align:${align}` : null);

function listItem(item, options) {
  // A tight item's paragraph is just its text.
  const children = item.children.length && item.children[0].type === 'paragraph'
    ? [el('span', {}, inlineNodes(item.children[0].children, options)), ...blockNodes(item.children.slice(1), options)]
    : blockNodes(item.children, options);
  if (item.task === null) return el('li', {}, children);
  const box = el('input', {
    type: 'checkbox', checked: item.task, 'data-line': String(item.line),
    disabled: !options.onTaskToggle,
  });
  if (options.onTaskToggle) box.addEventListener('change', () => options.onTaskToggle(item.line, box.checked));
  return el('li', { class: `kit-md__task${item.task ? ' kit-md__task--done' : ''}` }, box, children);
}

/**
 * The note as nodes, in a `.kit-md` box.
 * @param {string} source
 * @param {object} [options]
 * @param {Function} [options.onTaskToggle]  (line, done) → a task was ticked; without it, boxes are read-only
 * @param {Function} [options.resolveImage]  (src) → where an image really is (an attachment's address)
 */
export function renderMarkdown(source, options = {}) {
  const tree = typeof source === 'string' ? parseMarkdown(source) : source;
  return el('div', { class: 'kit-md' }, blockNodes(tree.children, options));
}
