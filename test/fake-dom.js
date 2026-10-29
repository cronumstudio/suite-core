/**
 * Just enough of a DOM for the web kit's modules to run under node:test:
 * elements with attributes, children, text and listeners. Setting innerHTML,
 * outerHTML or insertAdjacentHTML throws, so a test fails if anything tries.
 */
/**
 * Listeners as a browser keeps them: `once` goes after its first call, and a `signal` that aborts
 * takes the listener away (the web kit's frame leaves the page that way, shell.js destroy()).
 * `listeners[type]` stays a plain array of functions, as the tests have always read it.
 */
function addListener(target, type, fn, options) {
  const { once = false, signal = null } = typeof options === 'object' && options ? options : {};
  if (signal?.aborted) return;
  const list = (target.listeners[type] ||= []);
  if (list.includes(fn)) return;
  const call = once ? Object.assign(function (...args) { removeListener(target, type, call); return fn.apply(this, args); }, { original: fn }) : fn;
  list.push(call);
  signal?.addEventListener('abort', () => removeListener(target, type, call), { once: true });
}
function removeListener(target, type, fn) {
  const list = target.listeners[type];
  if (!list) return;
  const at = list.findIndex((f) => f === fn || f.original === fn);
  if (at >= 0) list.splice(at, 1);
}
const listenerCount = (target) => Object.values(target.listeners).reduce((sum, list) => sum + list.length, 0);

/**
 * A simple selector: a tag, `.class`, `[attr]`, `[attr="value"]` and `:not(…)` of one, joined, and
 * lists of them with commas. Anything else throws, so a test never passes on a selector misread.
 */
function matches(node, selector) {
  return selector.split(',').some((part) => {
    const simple = part.trim();
    const pieces = simple.match(/:not\([^)]+\)|\[[^\]]+\]|\.[\w-]+|^[\w-]+/g) || [];
    if (pieces.join('') !== simple) throw new Error(`fake-dom doesn't know the selector ${simple}`);
    return pieces.every((piece) => {
      if (piece.startsWith(':not(')) return !matches(node, piece.slice(5, -1));
      const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(piece);
      if (attr) return node.hasAttribute(attr[1]) && (attr[2] === undefined || node.getAttribute(attr[1]) === attr[2]);
      if (piece.startsWith('.')) return (node.getAttribute('class') || '').split(/\s+/).includes(piece.slice(1));
      return node.tagName === piece.toUpperCase();
    });
  });
}

/** Something with listeners and nothing else: a window, for a test that counts what is left on it. */
export class FakeEventTarget {
  constructor() { this.listeners = {}; }
  addEventListener(type, fn, options) { addListener(this, type, fn, options); }
  removeEventListener(type, fn) { removeListener(this, type, fn); }
  listenerCount() { return listenerCount(this); }
  dispatch(type, event = {}) { for (const fn of [...(this.listeners[type] || [])]) fn({ type, currentTarget: this, target: this, ...event }); }
}

class FakeText {
  constructor(text) { this.nodeType = 3; this.data = String(text); }
  get textContent() { return this.data; }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
}

export class FakeElement {
  constructor(tag, ns = null) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.namespaceURI = ns;
    this.attributes = new Map();
    this.childNodes = [];
    this.listeners = {};
    if (this.tagName === 'INPUT' || this.tagName === 'SELECT' || this.tagName === 'TEXTAREA') {
      this.value = '';
      this.checked = false;
    }
    if (this.tagName === 'DIALOG') this.open = false;
  }

  showModal() { this.open = true; }
  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatch('close');
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) {
    for (const node of nodes) {
      // As a browser does: what isn't a node is written as text, null as "null".
      const child = node?.nodeType ? node : new FakeText(node);
      // A node lives in one place: appended elsewhere, it leaves where it was (and clear() can empty).
      child.parentNode?.childNodes.splice(child.parentNode.childNodes.indexOf(child), 1);
      child.parentNode = this;
      if (child.nodeType === 1) child.parentElement = this;
      this.childNodes.push(child);
    }
  }
  prepend(...nodes) {
    const before = this.childNodes.length;
    this.append(...nodes);
    this.childNodes.unshift(...this.childNodes.splice(before));
  }
  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.childNodes.indexOf(this);
    parent.append(node);
    parent.childNodes.splice(index, 0, parent.childNodes.pop());
    this.remove();
  }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
    this.parentElement = null;
  }
  addEventListener(type, fn, options) { addListener(this, type, fn, options); }
  removeEventListener(type, fn) { removeListener(this, type, fn); }
  /** How many listeners it has, of every type. */
  listenerCount() { return listenerCount(this); }
  focus() {}
  click() { this.dispatch('click'); }
  dispatch(type, event = {}) { for (const fn of [...(this.listeners[type] || [])]) fn({ type, currentTarget: this, target: this, ...event }); }

  toggleAttribute(name, force) {
    const on = force === undefined ? !this.hasAttribute(name) : Boolean(force);
    if (on) this.setAttribute(name, '');
    else this.removeAttribute(name);
    return on;
  }
  /** data-* attributes, by their camelCase names. */
  get dataset() {
    const attr = (key) => `data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    return new Proxy({}, {
      get: (_, key) => this.getAttribute(attr(key)) ?? undefined,
      set: (_, key, value) => { this.setAttribute(attr(key), value); return true; },
    });
  }
  // A test may put its own in their place (a style that records setProperty).
  set dataset(value) { Object.defineProperty(this, 'dataset', { value, writable: true, configurable: true }); }
  get style() { return (this._style ||= {}); }
  set style(value) { this._style = value; }
  contains(node) {
    for (let at = node; at; at = at.parentNode) if (at === this) return true;
    return false;
  }
  closest(selector) {
    for (let at = this; at?.nodeType === 1; at = at.parentNode) if (matches(at, selector)) return at;
    return null;
  }
  querySelectorAll(selector) { return this.all().filter((node) => matches(node, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(''); }
  set textContent(text) {
    this.childNodes = [];
    this.append(String(text));
  }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }

  set innerHTML(_) { throw new Error('innerHTML used'); }
  set outerHTML(_) { throw new Error('outerHTML used'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML used'); }

  /** Every element below, depth first. */
  all() {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
  find(tag) { return this.all().filter((node) => node.tagName === tag.toUpperCase()); }
}

export function installFakeDom() {
  const document = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (ns, tag) => new FakeElement(tag, ns),
    createTextNode: (text) => new FakeText(text),
    body: new FakeElement('body'),
    documentElement: new FakeElement('html'),
    querySelector: () => null,
    // The document listens as an element does: the kit's frame puts its touches and drags there.
    listeners: {},
    addEventListener(type, fn, options) { addListener(this, type, fn, options); },
    removeEventListener(type, fn) { removeListener(this, type, fn); },
    listenerCount() { return listenerCount(this); },
    dispatch(type, event = {}) { for (const fn of [...(this.listeners[type] || [])]) fn({ type, currentTarget: this, target: this, ...event }); },
  };
  globalThis.document = document;
  return document;
}
