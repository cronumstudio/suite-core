/**
 * Just enough of a DOM for the web kit's modules to run under node:test:
 * elements with attributes, children, text and listeners. Setting innerHTML,
 * outerHTML or insertAdjacentHTML throws, so a test fails if anything tries.
 */
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
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new FakeText(node) : node;
      // A node lives in one place: appended elsewhere, it leaves where it was (and clear() can empty).
      child.parentNode?.childNodes.splice(child.parentNode.childNodes.indexOf(child), 1);
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }
  appendChild(node) { this.append(node); return node; }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, event = {}) { for (const fn of this.listeners[type] || []) fn({ type, currentTarget: this, target: this, ...event }); }

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
  };
  globalThis.document = document;
  return document;
}
