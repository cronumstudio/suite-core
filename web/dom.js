/**
 * The DOM, without HTML in strings: every node is made with `el()`, texts go
 * through `textContent` and attributes through `setAttribute`. That is the
 * whole defence against XSS, so nothing here takes markup.
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * An element: `text` is its text, `class` its classes, `on…` its listeners,
 * anything else an attribute (true → present, false/null → absent).
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'value' && 'value' in node) node.value = value;
    else if (key === 'checked' && 'checked' in node) node.checked = Boolean(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  return append(node, ...children);
}

/** Appends children, skipping the gaps: `node.append(null)` would write "null". */
export function append(node, ...children) {
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}
