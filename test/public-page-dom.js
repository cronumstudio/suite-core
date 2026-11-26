/**
 * A module's public page (its shared.html and js/shared-page.js) run under node:test, in the fake
 * DOM with what the page reads of a browser: its address, whether it is framed, its server as the
 * test answers it, and what it drew, written out as text. There is no catalog: every text shows
 * its key, so what a test pins is which words each part says.
 *
 *   import { installPublicPage, drawn } from '../server/suite/test/public-page-dom.js';
 *   const page = installPublicPage();
 *   const shown = await page.open(new URL('../public/js/shared-page.js', import.meta.url), {
 *     answer: { status: 200, body: { list: … } },   // or 'offline', or { status: 200, text: 'not json' }
 *     embed: true,                                   // `&embed=1` in the address
 *     framed: true,                                  // in another page's frame, whatever the address says
 *     signup: null,                                  // the install's SIGNUP_URL (by default, the hosted service's)
 *   });
 *   shown.html     // '<header class="sp-bar">…</header>…' (the page's children)
 *   shown.title    // the tab's title
 *
 * The install's /api/auth/config is answered here, not by the test's `answer` and not in `asked`:
 * its `signup_url` is `signup`, by default the hosted service's (CRONUM_WORK), so the bar and the
 * foot invite as they do there; `signup: null` opens the page of an install that invites nobody.
 *
 * Each open() runs the page's script afresh at a new address (`?open=N`), on a new page: what the
 * script drew last time is gone. A module whose page draws more than the fake DOM knows (Next's
 * lines) can still write out its own DOM's nodes with drawn().
 */
import { installFakeDom, FakeElement } from './fake-dom.js';
import { CRONUM_WORK } from '../web/public-frame.js';
// The pages import the kit from ../suite/, as the server serves it: found on disk here.
import '../tools/web-resolve.mjs';

/** `style` as a page sets it: plain properties, and custom ones through setProperty. */
class FakeStyle {
  constructor() { Object.defineProperty(this, 'custom', { value: new Map() }); }
  setProperty(name, value) { this.custom.set(name, String(value)); }
  getPropertyValue(name) { return this.custom.get(name) ?? ''; }
  removeProperty(name) { this.custom.delete(name); }
}

/** What fake-dom.js leaves out and a public page uses: classList, after(), firstElementChild, `^=`. */
function teach() {
  const proto = FakeElement.prototype;
  if (proto.after) return;
  Object.defineProperty(proto, 'classList', {
    configurable: true,
    get() {
      const node = this;
      const list = () => (node.getAttribute('class') || '').split(/\s+/).filter(Boolean);
      return {
        contains: (name) => list().includes(name),
        add: (...names) => node.setAttribute('class', [...new Set([...list(), ...names])].join(' ')),
        remove: (...names) => node.setAttribute('class', list().filter((n) => !names.includes(n)).join(' ')),
      };
    },
  });
  Object.defineProperty(proto, 'style', {
    configurable: true,
    get() { return (this._style ||= new FakeStyle()); },
    set(value) { this._style = value; },
  });
  Object.defineProperty(proto, 'firstElementChild', { configurable: true, get() { return this.children[0] || null; } });
  // A link's target and rel set as properties are its attributes, as in a browser.
  for (const name of ['target', 'rel']) {
    Object.defineProperty(proto, name, {
      configurable: true,
      get() { return this.getAttribute(name) ?? ''; },
      set(value) { this.setAttribute(name, value); },
    });
  }
  proto.after = function after(...nodes) {
    const parent = this.parentNode;
    const at = parent.childNodes.indexOf(this) + 1;
    const before = parent.childNodes.length;
    parent.append(...nodes);
    parent.childNodes.splice(at, 0, ...parent.childNodes.splice(before));
  };
  // `a[href^="api/public/"]`: the one kind of selector a page asks that fake-dom.js doesn't know.
  const all = proto.querySelectorAll;
  proto.querySelectorAll = function querySelectorAll(selector) {
    const starts = /^([\w-]*)\[([\w-]+)\^="([^"]*)"\]$/.exec(selector);
    if (!starts) return all.call(this, selector);
    const [, tag, name, value] = starts;
    return this.all().filter((node) => (!tag || node.tagName === tag.toUpperCase()) && (node.getAttribute(name) ?? '').startsWith(value));
  };
}

/* --------------------------------- written -------------------------------- */

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An element's attributes as [name, value], from fake-dom.js's Map or a DOM's list of them. */
const attributesOf = (node) => (node.attributes instanceof Map
  ? [...node.attributes]
  : [...(node.attributes || [])].map((a) => [a.name, a.value]));

/** An element's inline style as one attribute: its plain properties and its custom ones, sorted. */
function styleOf(node) {
  const style = node._style ?? node.style;
  if (!style || typeof style !== 'object') return [];
  const custom = style.custom ?? (style.props ? new Map(Object.entries(style.props)) : new Map());
  const plain = Object.entries(style).filter(([key, value]) => key !== 'props' && typeof value !== 'function');
  const all = [...plain, ...custom].map(([key, value]) => `${key}: ${value}`).sort();
  return all.length ? [['style', all.join('; ')]] : [];
}

/**
 * A node written out: elements as tags with their attributes sorted (an inline style as one), the
 * events they listen to as `on="click"`, and their children; text as it reads.
 */
export function drawn(node) {
  if (node == null) return '';
  if (node.nodeType !== 1) return escape(node.textContent ?? node.data ?? '');
  const tag = node.tagName.toLowerCase();
  const listens = Object.entries(node.listeners || {}).filter(([, fns]) => fns.length).map(([type]) => type).sort();
  const attrs = [...attributesOf(node), ...styleOf(node), ...(listens.length ? [['on', listens.join(' ')]] : [])]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => ` ${name}="${escape(value).replace(/"/g, '&quot;')}"`).join('');
  return `<${tag}${attrs}>${node.childNodes.map(drawn).join('')}</${tag}>`;
}

/** Each child of a node written out, one string each. */
export const drawnParts = (node) => node.children.map(drawn);

/* ---------------------------------- page ---------------------------------- */

const settle = async () => { for (let i = 0; i < 40; i += 1) await new Promise((done) => setImmediate(done)); };

/**
 * The fake DOM as a public page's: `<html>`, its `<head>`, and `<main id="page">` as shared.html has
 * it. → { open(script, { answer, embed, framed, token }) → what it drew, document }.
 */
export function installPublicPage({ origin = 'https://work.example', path = '/tasks/shared.html', title = 'Page' } = {}) {
  teach();
  const document = installFakeDom();
  let page = null;
  let opened = 0;
  document.getElementById = (id) => (id === 'page' ? page : null);
  document.visibilityState = 'visible';

  /** The server: catalogs it hasn't (every text shows its key), the page's route as the test answers it. */
  const serve = (answer, asked, signup) => async (url, options = {}) => {
    const address = String(url);
    if (/\/i18n\//.test(address)) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    if (/\/api\/auth\/config$/.test(address)) {
      const config = JSON.stringify({ provider: 'local', signup_url: signup });
      return { ok: true, status: 200, json: async () => JSON.parse(config), text: async () => config };
    }
    asked.push({ url: address, options });
    const value = typeof answer === 'function' ? answer(address, options) : answer;
    if (value === 'offline') throw new TypeError('Failed to fetch');
    const status = value?.status ?? 200;
    const text = value?.text ?? JSON.stringify(value?.body ?? {});
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
  };

  async function open(script, {
    answer = { status: 404, body: { error: 'public_not_found' } }, embed = false, framed = false, token = 'a-page-link', signup = CRONUM_WORK,
  } = {}) {
    opened += 1;
    const search = `?p=${encodeURIComponent(token)}${embed ? '&embed=1' : ''}`;
    const href = `${origin}${path}${search}`;
    globalThis.location = { href, origin, pathname: path, search, hash: '' };
    const win = { location: globalThis.location, scrollY: 0, scrollTo() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
    win.self = win;
    win.top = framed ? { location: { origin: 'https://another.example' } } : win;
    globalThis.window = win;
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'en', languages: ['en'] }, configurable: true, writable: true });
    const asked = [];
    globalThis.fetch = serve(answer, asked, signup);
    document.documentElement = new FakeElement('html');
    document.head = new FakeElement('head');
    document.body = new FakeElement('body');
    document.documentElement.append(document.head, document.body);
    document.title = title;
    page = new FakeElement('main');
    page.setAttribute('class', 'sp');
    page.setAttribute('id', 'page');
    page.setAttribute('aria-busy', 'true');
    page.append(new FakeElement('p'));
    document.body.append(page);
    const url = new URL(script);
    url.searchParams.set('open', String(opened));
    await import(url.href);
    await settle();
    return {
      page,
      html: page.childNodes.map(drawn).join(''),
      parts: drawnParts(page),
      title: document.title,
      htmlClass: document.documentElement.getAttribute('class') || '',
      head: drawn(document.head),
      busy: page.hasAttribute('aria-busy'),
      asked,
      lang: document.documentElement.lang,
    };
  }

  return { open, document, settle };
}
