/**
 * A public page's dialog, the same in every module (audit of 6/11: tasks-web-16, notes-web-13):
 * for its owner, turned on, its link to copy or open, the code to put it in a website (Pro's
 * `embed`; on another plan the fold says so) and the way to turn it off; turned off, what it would
 * show and the button to turn it on. The server's side is public-page.js.
 *
 *   import { publicDialog } from '../suite/public-page.js';
 *   publicDialog({
 *     base: `api/lists/${list.id}/public`,   // GET reads it, POST turns it on, DELETE turns it off
 *     name: list.name, url: list.public_url,
 *     words: { what: 'public.what', shows: 'public.shows', hides: 'public.hides', onText: 'public.onText', embedText: 'public.embedText' },
 *     onChange: (url) => { list.public_url = url; },
 *   });
 *
 * Opened, it reads how the page is without changing it (a POST would turn on again a page switched
 * off from another device that this one hadn't heard of yet), and what the owner's plan allows; the
 * fold to embed it shows once that is known. Like sharing, it needs the server: without signal the
 * kit's notice says so. Copying says so once (the kit's copyText), and without a clipboard leaves
 * the text selected.
 *
 * Its words are the kit's (`kit.public.*`); what the page of a list, a note or a project shows and
 * hides is the module's (`words`: key → its catalog key). `shows` and `hides` are said only when
 * the module gives them.
 */
import { el } from './dom.js';
import { t } from './i18n.js';
import { api, errorMessage } from './api.js';
import { icon } from './icons.js';
import { openDialog, confirmDialog, toast, copyText } from './ui.js';

/** How tall the frame `embedCode` gives is, unless the module says otherwise: a list, a note, a project's road. */
export const EMBED_HEIGHT = 640;

/** The iframe that puts a public page in another website: the page's link with `&embed=1`. */
export function embedCode(url, name, { height = EMBED_HEIGHT } = {}) {
  const attr = (text) => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const src = `${url}${String(url).includes('?') ? '&' : '?'}embed=1`;
  return `<iframe src="${attr(src)}" title="${attr(name)}" width="100%" height="${Number(height) || EMBED_HEIGHT}" style="border:0;border-radius:12px" loading="lazy"></iframe>`;
}

/**
 * @param {object} options
 * @param {string} options.name  what is published, as the title and the frame's title say it.
 * @param {string} [options.base]  its route: GET reads, POST turns on, DELETE turns off.
 * @param {string|null} [options.url]  its link as the app has it now (null: off), shown at once.
 * @param {object} [options.words]  key → catalog key, for the module's own sentences.
 * @param {Function} [options.onChange]  (url) after it is turned on or off, or found otherwise
 *   than the app had it: the link, or null.
 * @param {Function} [options.read]  () → { url, embed }, in place of GET `base`.
 * @param {Function} [options.turnOn]  () → { url, embed }, in place of POST `base`.
 * @param {Function} [options.turnOff]  () → anything, in place of DELETE `base`.
 * @param {number} [options.embedHeight]  the frame's height in the code (EMBED_HEIGHT).
 * @param {Element} [options.parent]  where the dialog hangs (openDialog's).
 * @returns {{ dialog: HTMLDialogElement, close: Function }}
 */
export function publicDialog({
  name, base = null, url: initial = null, words = {}, onChange = null,
  read = null, turnOn = null, turnOff = null, embedHeight = EMBED_HEIGHT, parent = null,
}) {
  const say = (key, params) => t(words[key] || `kit.public.${key}`, params);
  const own = (key) => (words[key] ? t(words[key]) : null);
  const ask = {
    read: read || (() => api.get(base)),
    on: turnOn || (() => api.post(base, {})),
    off: turnOff || (() => api.delete(base)),
  };
  let url = initial || null;
  // Whether the owner's plan embeds it (Pro): the server says, with the link; unknown until then.
  let embeds = null;
  let embedOpen = false;
  const body = el('div', { class: 'kit-stack kit-public' });
  const fail = (err) => toast(errorMessage(err), { error: true });
  const changed = (next) => {
    const was = url;
    url = next || null;
    if (url !== was) onChange?.(url);
  };

  const turn = async (on) => {
    try {
      if (on) {
        const answer = await ask.on();
        embeds = Boolean(answer?.embed);
        changed(answer?.url);
      } else {
        // Red: turned on again it is a new link, and the one given out is gone.
        const yes = await confirmDialog(say('offText'), { title: say('offTitle'), confirm: say('turnOff'), danger: true, parent });
        if (!yes) return;
        await ask.off();
        changed(null);
      }
      paint();
    } catch (err) {
      fail(err);
    }
  };

  const copyButton = (text, node, { primary = false } = {}) => el('button', {
    type: 'button', class: `kit-btn${primary ? ' kit-btn--primary' : ''}`,
    onClick: () => copyText(text(), node),
  }, icon('copy'), el('span', { text: t('kit.copy') }));

  function paint() {
    if (!url) {
      const shows = own('shows');
      const hides = own('hides');
      body.replaceChildren(
        el('p', { class: 'kit-hint', text: say('what') }),
        shows || hides ? el('ul', { class: 'kit-public__list' },
          shows ? el('li', { text: shows }) : null,
          hides ? el('li', { text: hides }) : null) : null,
        el('div', { class: 'kit-public__row' },
          el('button', { type: 'button', class: 'kit-btn kit-btn--primary', onClick: () => turn(true) },
            icon('globe'), el('span', { text: say('turnOn') }))));
      return;
    }
    const link = el('input', { class: 'kit-input kit-public__link', type: 'text', readonly: true, value: url, 'aria-label': say('link') });
    link.addEventListener('focus', () => link.select());
    const hides = own('hides');
    body.replaceChildren(
      el('p', { class: 'kit-hint', text: say('onText') }),
      el('div', { class: 'kit-public__row' }, link, copyButton(() => url, link, { primary: true })),
      el('div', { class: 'kit-public__row' },
        el('a', { class: 'kit-btn', href: url, target: '_blank', rel: 'noopener' }, icon('external'), el('span', { text: say('open') })),
        el('button', { type: 'button', class: 'kit-btn kit-btn--danger-quiet', text: say('turnOff'), onClick: () => turn(false) })),
      embedFold(),
      hides ? el('p', { class: 'kit-hint', text: hides }) : null);
  }

  /** The code to embed it, folded: on Pro the code and its copy button, on another plan only that it is Pro's. */
  function embedFold() {
    if (embeds == null) return null;
    const parts = [];
    if (embeds) {
      const code = el('textarea', {
        class: 'kit-input kit-public__code', readonly: true, rows: 4, spellcheck: 'false',
        'aria-label': say('embedCode'), value: embedCode(url, name, { height: embedHeight }),
      });
      code.addEventListener('focus', () => code.select());
      parts.push(
        el('p', { class: 'kit-hint', text: say('embedText') }),
        code,
        el('div', { class: 'kit-public__row' }, copyButton(() => code.value, code)));
    } else {
      parts.push(el('p', { class: 'kit-hint', text: say('embedPro') }));
    }
    const fold = el('details', { class: 'kit-public__embed', open: embedOpen },
      el('summary', {}, icon('code-xml'), el('span', { text: say('embed') })),
      ...parts);
    fold.addEventListener('toggle', () => { embedOpen = fold.open; });
    return fold;
  }

  paint();
  ask.read()
    .then((answer) => {
      embeds = Boolean(answer?.embed);
      changed(answer?.url);
      paint();
    })
    .catch(() => {});
  return openDialog({
    title: say('title', { name }), content: body, parent,
    actions: [{ label: t('kit.close'), primary: true }],
  });
}
