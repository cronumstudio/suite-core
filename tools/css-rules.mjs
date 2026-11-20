/**
 * The kit's rules for a style sheet (docs/web-kit.md, «Same in every module», rule 24), read off
 * its text: the kit's own sheets are checked by its tests, and a module's by its own, with these
 * same functions. Plain Node, nothing to install.
 *
 *   import { lookFallbacks, physicalSides, layoutWidths } from '../server/suite/tools/css-rules.mjs';
 *
 * Each answers a list of { line, text } (the 1-based line in the sheet, and what was found), empty
 * when the sheet keeps the rule. Comments are left out, their lines kept so a line is the right one.
 */

/** The sheet without its comments, every line where it was. */
export function code(css) {
  return String(css).replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Every look variable read with a number beside it (`var(--look-body, 14px)`): the look's scale
 * has a value for each in every look (kit.css :root and Clean's), so the number is a second size
 * that only hides which one is meant.
 */
export function lookFallbacks(css) {
  const text = code(css);
  return [...text.matchAll(/var\(\s*--look-[\w-]+\s*,[^)]*\)/g)].map((m) => ({ line: lineAt(text, m.index), text: m[0] }));
}

/** The rules of a sheet, at any depth (an @media's too): { selector, body, start }. */
function rules(text) {
  const out = [];
  const stack = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') { stack.push({ selector: text.slice(from, i).trim(), start: i + 1 }); from = i + 1; }
    else if (ch === '}') {
      const rule = stack.pop();
      if (rule && !rule.selector.startsWith('@')) out.push({ ...rule, body: text.slice(rule.start, i) });
      from = i + 1;
    } else if (ch === ';' && !stack.length) from = i + 1;
  }
  return out;
}

const PHYSICAL = [
  /(^|[;{\s])((?:margin|padding|border)-(?:left|right)(?:-[a-z]+)?|left|right)\s*:/g,
  /(^|[;{\s])((?:text-align|float)\s*:\s*(?:left|right))\b/g,
];

/**
 * Every side said physically (`left`, `margin-right`, `border-left`, `text-align: left`…) where a
 * logical one says the same in either direction (`inset-inline-start`, `margin-inline-end`…).
 * `allow`: the selectors where physical is meant, a drawing that runs left to right whatever the
 * language (a Gantt, a line of steps), as a regular expression tried on each rule's selector.
 */
export function physicalSides(css, { allow = null } = {}) {
  const text = code(css);
  const found = [];
  for (const rule of rules(text)) {
    if (allow?.test(rule.selector)) continue;
    for (const re of PHYSICAL) {
      for (const m of rule.body.matchAll(re)) {
        const at = rule.start + m.index + m[1].length;
        found.push({ line: lineAt(text, at), text: `${rule.selector.replace(/\s+/g, ' ')} { ${m[2].replace(/\s+/g, ' ')} }` });
      }
    }
  }
  return found;
}

/** The widths where a layout changes for the whole screen or a module's frame: the brand's two. */
export const LAYOUT_WIDTHS = Object.freeze([640, 960]);

/**
 * Every `@media` width that isn't one of the brand's (640, 960, or the pixel under one: 639,
 * 959), nor a phone's own narrower step (under 640, where a long word or a bar is fitted).
 * A component's `@container` (a board, a line) changes where its content needs, and isn't counted;
 * `containers`: the names of containers that are a module's frame (its `.kit-app`), whose widths
 * are the screen's and are counted.
 */
export function layoutWidths(css, { containers = [] } = {}) {
  const text = code(css);
  const found = [];
  for (const m of text.matchAll(/@(media|container)\s*([\w-]*)[^{]*\{/g)) {
    if (m[1] === 'container' && !containers.includes(m[2])) continue;
    for (const w of m[0].matchAll(/(min|max)-width\s*:\s*([\d.]+)px/g)) {
      const px = Number(w[2]);
      if (px < 640 || LAYOUT_WIDTHS.includes(px) || LAYOUT_WIDTHS.includes(px + 1)) continue;
      found.push({ line: lineAt(text, m.index), text: `${m[0].replace(/\s+/g, ' ').replace(/\s*\{$/, '')}` });
    }
  }
  return found;
}
