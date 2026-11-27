/**
 * The install's terms and privacy policy in the browser (the server's terms.js):
 *
 * - `termsBox(links)`: the box «I accept the terms and the privacy policy», a real checkbox with
 *   its label, each page a link of its own that opens apart. The kit's sign-in puts it where it
 *   makes an account (signin-form.js), and the button beside it waits for it.
 * - The page of the terms (`/auth/terms`, served by the suite in the sign-in's layout): for an
 *   account that came in without that box (the provider's own «Sign up», a phone, an assistant
 *   first). The box, «Continue», and a way to sign out; nothing else of the app opens until it is
 *   ticked (the server answers 403 `terms_required` meanwhile, and api.js comes here). Once
 *   accepted, back to where it was going (`?return=`).
 *
 * The links and their version are the install's (`/api/auth/config`'s `terms`): with neither page
 * linked, none of this is drawn.
 */
import { $, el, clear } from './dom.js';
import { t, loadLanguage, pickLanguage } from './i18n.js';
import { api, errorMessage, SessionExpired } from './api.js';
import { signOutHere } from './signin.js';
import { signature } from './ui.js';

export const TERMS_PATH = '/auth/terms';

/**
 * The sentence of the box, its links in it: «I accept the [terms] and the [privacy policy]», or
 * the one page the install links. → its pieces, texts and links, or null with no page.
 */
export function termsSentence(links) {
  const terms = links?.terms || null;
  const privacy = links?.privacy || null;
  if (!terms && !privacy) return null;
  const marks = { terms: '\u0001', privacy: '\u0002' };
  const sentence = terms && privacy ? t('kit.terms.accept', marks)
    : terms ? t('kit.terms.acceptTerms', marks) : t('kit.terms.acceptPrivacy', marks);
  // Each page opens apart: whoever reads it comes back to the form as they left it.
  const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener', class: 'kit-terms__link', text });
  return sentence.split(/([\u0001\u0002])/).filter((part) => part !== '')
    .map((part) => (part === '\u0001' ? link(terms, t('kit.terms.terms'))
      : part === '\u0002' ? link(privacy, t('kit.terms.privacy')) : part));
}

/**
 * The box itself: `{ node, input }`, the input a checkbox named `terms` with the value 1 (a form
 * posted with it ticked says `terms=1`), its label beside it. `onChange(ticked)` hears each change.
 * → null when the install links no page.
 */
export function termsBox(links, { id = 'kit-terms-accept', onChange = null } = {}) {
  const sentence = termsSentence(links);
  if (!sentence) return null;
  const input = el('input', { type: 'checkbox', id, name: 'terms', value: '1', class: 'kit-terms__input' });
  if (onChange) input.addEventListener('change', () => onChange(input.checked));
  const node = el('div', { class: 'kit-check kit-terms' }, input, el('label', { for: id, class: 'kit-terms__label' }, sentence));
  return { node, input };
}

/** Where the page goes once they are accepted: `?return=`, a path of this site that isn't this page; else `/`. */
export function backOf(search = '') {
  const back = new URLSearchParams(search).get('return') || '/';
  const local = /^\/(?!\/)[^\\\s]*$/.test(back) ? back : '/';
  return local === TERMS_PATH || local.startsWith(`${TERMS_PATH}?`) || local.startsWith(`${TERMS_PATH}/`) ? '/' : local;
}

/** The sign-in's layout: the product's colour and name beside the card, and the signature. */
function layout(app, card) {
  return el('main', { class: 'kit-signin kit-terms-page' },
    el('section', { class: 'kit-signin__hero' },
      app.icon ? el('img', { src: app.icon, alt: '', width: 76, height: 76 }) : null,
      el('h1', { text: app.name })),
    el('div', { class: 'kit-signin__side' },
      el('div', { class: 'kit-signin__body' }, card),
      el('footer', { class: 'kit-signin__sig' }, signature())));
}

/**
 * Draws the page in `root`: what to accept (`answer`, GET /api/auth/terms), the box, «Continue»
 * and «Sign out». `accept` records it, `go` follows an address and `signOut` leaves (the browser's
 * by default, so tests can stand in). → the screen.
 */
export function showTerms({
  app, answer, root = document.body, back = '/',
  accept = () => api.post('/api/auth/terms', { accept: true }),
  go = (href) => window.location.replace(href),
  signOut = () => signOutHere({}),
}) {
  const card = el('div', { class: 'kit-signin__card' });
  const screen = layout(app, card);
  root.append(screen);

  const error = el('p', { class: 'kit-error', role: 'alert', hidden: true });
  const proceed = el('button', {
    type: 'submit', class: 'kit-btn kit-btn--primary kit-btn--block', 'data-action': 'continue', disabled: true,
    text: t('kit.terms.continue'),
  });
  const box = termsBox(answer, { onChange: (ticked) => { proceed.disabled = !ticked; } });
  const leave = el('button', {
    type: 'button', class: 'kit-link', 'data-action': 'sign-out', text: t('kit.account.signOut'),
    onClick: async () => {
      leave.disabled = true;
      try { if ((await signOut()) === false) leave.disabled = false; } catch { leave.disabled = false; }
    },
  });
  const form = el('form', { class: 'kit-stack', novalidate: true }, box?.node, error, proceed);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!box?.input.checked) return;
    proceed.disabled = true;
    error.hidden = true;
    try {
      await accept();
      go(back);
    } catch (err) {
      // The session ended meanwhile: the sign-in again, which comes back here if it must.
      if (err instanceof SessionExpired) { go('/'); return; }
      error.textContent = errorMessage(err);
      error.hidden = false;
      proceed.disabled = !box.input.checked;
    }
  });
  clear(card).append(
    el('h2', { text: t('kit.terms.title') }),
    el('p', { text: t('kit.terms.lead', { app: app.name }) }),
    form,
    el('div', { class: 'kit-signin__links' }, leave));
  box?.input.focus();
  return screen;
}

/** The page: who is there, in their language, and what to accept; with nothing to accept, on at once. */
async function start(root) {
  const back = backOf(window.location.search);
  let config;
  let answer;
  try {
    config = await api.get('/api/auth/config');
    answer = await api.get('/api/auth/terms');
  } catch (err) {
    // Nobody signed in: the sign-in, which sends a new account back here.
    if (err instanceof SessionExpired) { window.location.replace('/'); return; }
    // Without the server there are no texts either.
    root.append(el('p', { class: 'kit-main', text: 'The server does not answer. Try again in a moment.' })); // i18n-exempt
    return;
  }
  if (!answer.required) { window.location.replace(back); return; }
  const user = answer.user || {};
  let prefs = {};
  try { prefs = typeof user.prefs === 'string' ? JSON.parse(user.prefs) : (user.prefs || {}); } catch { /* none */ }
  await loadLanguage(pickLanguage([user.locale, prefs.lang, navigator.languages || [], navigator.language], config.app?.languages || ['en']),
    { remember: false }).catch(() => {});
  if (user.theme === 'dark' || user.theme === 'light') document.documentElement.setAttribute('data-theme', user.theme);
  // The product's icon, as the server wrote it into the page.
  const app = { name: config.app?.name || '', icon: document.querySelector('link[rel="icon"]')?.getAttribute('href') || null };
  document.title = `${t('kit.terms.title')} · ${app.name}`;
  showTerms({ app, answer, root, back });
}

// Imported by the sign-in or a test, there is no page to start.
const mount = globalThis.document ? $('#terms') : null;
if (mount) start(mount);
