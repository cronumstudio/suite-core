/**
 * A module's public page (its shared.html: a list, a note, a project, for anyone with its link),
 * started the same way in every module: what it asks the server, what it says when the page isn't
 * there, can't be shown in a frame or couldn't load, the bar over it and the foot under it with
 * Cronum's brand, and whether it is in another site's frame. The module draws only what its page
 * shows. The frame's sheet is public-page.css; the dialog its owner turns it on with,
 * public-page.js.
 *
 *   import { startPublicPage } from '../suite/public-frame.js';
 *   startPublicPage({
 *     key: 'list',                       // what the server's answer has when the page is there
 *     icon: 'icons/favicon.svg?v=2',     // the module's mark: in the bar, the foot and the card
 *     words: { brand: 'shared.bar.brand', pitch: 'shared.bar.pitch', made: 'shared.made', makeYours: 'shared.makeYours' },
 *     draw: (data, { page }) => [hero(data), toDo(data)],
 *   });
 *
 * It reads `api/public/<token>` (the address's `p`) without cookies or a cache, with `?embed=1` when
 * embedded, which the server answers only for an owner whose plan embeds (Pro's `embed`): anyone
 * else's is a 403 `embed_not_allowed`. Then it shows, in `#page`:
 * - the page: the bar, what `draw` gives, the foot; embedded, only what `draw` gives;
 * - gone (a 404, another 403, an answer without `key`): «Nothing to see here», with the bar and the
 *   foot unless embedded, and the tab says so too;
 * - refused (`embed_not_allowed`): what says it can't be shown here, the way to the page itself (its
 *   address without `embed`), and the foot under it;
 * - anything else (no network, a 5xx, a 429, an answer that isn't JSON) reads as gone, unless the
 *   module gives `failed`: then it says the page couldn't load, with a button that tries again.
 * Embedded is `embed=1` in the address or a frame without it, so the plain link of a page whose
 * owner's plan doesn't embed shows nothing of it in another site. `<html>` takes `sp-embedded`, and
 * a `<base target="_blank">` opens its links outside the frame.
 *
 * With `reread` (ms), it reads the page again that often while it is in sight, and at once when it
 * comes back into sight, never while hidden: an answer that says the same draws nothing, a reading
 * that fails leaves what is shown, and the page stays where its reader had it.
 *
 * The bar's «Start free» and the foot's way to make one's own lead where the install invites people
 * to sign up (`SIGNUP_URL`, /api/auth/config's `signup_url`, asked as the page starts): an install
 * that names none (one that isn't open to anyone, or someone's own) shows neither, and nothing on
 * its pages sends people to sign up somewhere else. The bar's name, what the page is made with,
 * stays.
 *
 * Its words are the kit's (`kit.public.*`, `errors.public_not_found`, `kit.retry`) and the
 * module's (`words`, `failed`: catalog keys).
 */
import { el } from './dom.js';
import { loadLanguage, t } from './i18n.js';

/** What every module is part of: Cronum Work, which the bar's name leads to. */
export const CRONUM_WORK = 'https://cronumstudio.com/work';

/**
 * Where the install invites whoever opens one of its pages to start their own (`signup_url` in
 * /api/auth/config, the install's SIGNUP_URL): an http(s) address, or null for none.
 */
export async function signupUrl(base = globalThis.location?.href) {
  try {
    const res = await fetch(new URL('api/auth/config', base), { credentials: 'omit' });
    const config = res.ok ? await res.json() : null;
    const url = config?.signup_url;
    return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Whether the page is in another site's frame: asked so (`embed=1`), or framed without saying it.
 * Comparing a frame's window with the top one never throws, even when the top is another site's:
 * only reading what is in it would.
 */
export function embeddedPage(win = globalThis.window, search = globalThis.location?.search ?? '') {
  return new URLSearchParams(search).get('embed') === '1' || win.self !== win.top;
}

/** The tab's title for what is shown: its emoji and its name, or its name alone. */
const titleOf = (thing) => (thing.icon ? `${thing.icon} ${thing.name}` : thing.name);

/**
 * @param {object} options
 * @param {string} options.key  the field of the server's answer the page is there with (`list`, `note`).
 * @param {Function} options.draw  (data, { page, embedded }) → the nodes of what the page shows, in
 *   order (nulls left out). It may set the page's own properties on `page` (its colour).
 * @param {string} options.icon  the module's mark (`icons/favicon.svg?v=2`).
 * @param {{ brand: string, pitch: string, made: string, makeYours: string }} options.words  catalog
 *   keys: the bar's name and what the module does, and the foot's two.
 * @param {Function} [options.title]  data → the tab's title (by default the emoji and the name of `data[key]`).
 * @param {{ title: string, text: string }} [options.failed]  catalog keys: a page that couldn't load
 *   says so, with a retry; without them it reads as gone.
 * @param {'card'|'gone'} [options.refusedAs]  how refused looks: the kit's card with the module's
 *   mark, or the gone page's dot with the words and the way to the page under it.
 * @param {string} [options.openClass]  the class of the link to the page itself, when refused.
 * @param {number} [options.reread]  ms between readings while in sight; none by default.
 * @returns {Promise<void>} once the first reading is drawn.
 */
export function startPublicPage({
  key, draw, icon, words, title = (data) => titleOf(data[key]), failed = null,
  refusedAs = 'card', openClass = 'sp-foot__link', reread = 0,
}) {
  const page = document.getElementById('page');
  const token = new URLSearchParams(location.search).get('p') || '';
  const embedded = embeddedPage();
  // Asked at once, beside the language: embedded, a page refused there still has the foot under it.
  const signupAsked = signupUrl(location.href);
  let signup = null;
  const mark = (size) => el('img', { src: icon, alt: '', width: size, height: size });
  const dot = () => el('span', { class: 'sp-hero__dot', 'aria-hidden': 'true' });

  /** The bar over the page: what it is made with, and where the install invites, the way to start one's own, easy to find. */
  const bar = () => el('header', { class: 'sp-bar' },
    // Named by its label too: on a phone its name is hidden and only the icon shows (public-page.css).
    el('a', { class: 'sp-bar__brand', href: CRONUM_WORK, rel: 'noopener', 'aria-label': t(words.brand) },
      mark(22), el('span', { class: 'sp-bar__name', text: t(words.brand) })),
    el('span', { class: 'sp-bar__pitch', text: t(words.pitch) }),
    signup ? el('a', { class: 'sp-bar__cta', href: signup, rel: 'noopener', text: t('kit.public.startFree') }) : null);

  const foot = () => el('footer', { class: 'sp-foot' },
    el('span', { class: 'sp-foot__made' }, mark(18), t(words.made)),
    signup ? el('a', { class: 'sp-foot__link', href: signup, rel: 'noopener', text: t(words.makeYours) }) : null);

  /** What the page shows, framed by the bar and the foot unless it is in another site's. */
  const show = (...parts) => page.replaceChildren(...(embedded ? parts : [bar(), ...parts, foot()]));

  /** A page with nothing of what it would show: its dot, a title and a sentence, and maybe a button. */
  const instead = (heading, text, ...more) => el('div', { class: 'sp-gone' },
    dot(), el('h1', { text: t(heading) }), el('p', { text: t(text) }), ...more);

  const states = {
    gone() {
      document.title = t('kit.public.goneTitle');
      show(instead('kit.public.goneTitle', 'errors.public_not_found'));
    },
    // Embedded where its owner's plan doesn't embed: the way to the page itself, the same address
    // without `embed`, in a tab of its own; under it, the foot with Cronum's brand.
    refused() {
      const own = new URL(location.href);
      own.searchParams.delete('embed');
      const says = el('p', { text: t('kit.public.cantEmbed') });
      const open = el('a', { class: openClass, href: own.href, target: '_blank', rel: 'noopener', text: t('kit.public.openPage') });
      page.replaceChildren(refusedAs === 'gone'
        ? el('div', { class: 'sp-gone sp-not-here' }, dot(), says, open)
        : el('div', { class: 'sp-refused' }, mark(28), says, open), foot());
    },
    // The server didn't answer as it should: not that the page is gone, which only a 404 says.
    failed() {
      show(instead(failed.title, failed.text,
        el('button', { type: 'button', class: 'kit-btn kit-btn--primary', text: t('kit.retry'), onClick: () => refresh() })));
    },
  };

  /** The page's data now: `{ data, text }`, or what kept it from coming: `gone`, `refused` or `failed`. */
  async function read() {
    let res;
    try {
      res = await fetch(new URL(`api/public/${encodeURIComponent(token)}${embedded ? '?embed=1' : ''}`, location.href), { credentials: 'omit', cache: 'no-store' });
    } catch {
      return { failed: true };
    }
    if (res.status === 404) return { gone: true };
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      if (res.status === 403 && body?.error === 'embed_not_allowed') return { refused: true };
      return res.status === 403 ? { gone: true } : { failed: true };
    }
    const text = await res.text().catch(() => null);
    try {
      const data = JSON.parse(text);
      return data?.[key] ? { data, text } : { gone: true };
    } catch {
      return { failed: true };
    }
  }

  /** What is on screen: the text it was drawn from, or the state it says instead. */
  let shown = null;
  const showsPage = () => shown != null && !(shown in states);

  /** Reads the page and draws what changed. */
  async function refresh() {
    const answer = await read();
    page.removeAttribute('aria-busy');
    if (answer.data) {
      if (shown === answer.text) return;
      shown = answer.text;
      document.title = title(answer.data);
      const parts = [draw(answer.data, { page, embedded })].flat().filter(Boolean);
      // Drawn again from a new reading, the page stays where its reader had it.
      const scrolled = window.scrollY || 0;
      show(...parts);
      if (scrolled) window.scrollTo?.(0, scrolled);
      return;
    }
    if (answer.failed && showsPage()) return;
    const now = answer.refused ? 'refused' : answer.failed && failed ? 'failed' : 'gone';
    if (shown === now) return;
    shown = now;
    states[now]();
  }

  async function start() {
    if (embedded) {
      document.documentElement.classList.add('sp-embedded');
      // Its links leave the frame: whoever follows one goes on in a page of its own.
      document.head.append(el('base', { target: '_blank' }));
    }
    await loadLanguage('auto', { remember: false }).catch(() => {});
    signup = await signupAsked;
    await refresh();
    if (!reread) return;
    setInterval(() => { if (document.visibilityState !== 'hidden') refresh(); }, reread);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  }

  return start();
}
