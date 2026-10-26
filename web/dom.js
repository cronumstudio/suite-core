/**
 * The DOM, without HTML in strings: every node is made with `el()` (or `svg()`), texts go
 * through `textContent` and attributes through `setAttribute`. That is the
 * whole defence against XSS, so nothing here takes markup.
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * An element: `text` is its text, `class` its classes, `on…` its listeners,
 * `style` its inline style (a string, or an object whose `--custom` properties go
 * through setProperty), `dataset` its data-* attributes (an object),
 * anything else an attribute (true → present, false/null → absent).
 * Children may come as arguments or in arrays, nested as deep as they like.
 */
export function el(tag, props = {}, ...children) {
  return append(setProps(document.createElement(tag), props), ...children);
}

/** The same as `el()`, for SVG elements (a chart's lines, an icon drawn in place). */
export function svg(tag, props = {}, ...children) {
  return append(setProps(document.createElementNS(SVG_NS, tag), props), ...children);
}

function setProps(node, props) {
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'value' && 'value' in node) node.value = value;
    else if (key === 'checked' && 'checked' in node) node.checked = Boolean(value);
    else if (key === 'style' && typeof value === 'object') applyStyle(node, value);
    else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  return node;
}

/** `node.style[prop] = …` leaves custom properties (--something) as stray keys nobody reads. */
function applyStyle(node, styles) {
  for (const [prop, value] of Object.entries(styles)) {
    if (value == null) continue;
    if (prop.startsWith('--')) node.style.setProperty(prop, value);
    else node.style[prop] = value;
  }
}

/** Appends children, skipping the gaps: `node.append(null)` would write "null". */
export function append(node, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}
