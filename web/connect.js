/**
 * The page where a signed-in account allows a phone: /devices/connect, served by
 * the suite with `devices.connectPage` (device-pages.js), outside any app's
 * frame, in the sign-in's layout and the account's language. Ported from
 * Tracker's own page, which Tracker keeps.
 *
 * The native app opened it in the system browser with a PKCE challenge, a
 * state, its return address and the phone's name and platform; the server
 * already checked them against `devices.redirectUris`, sends any address that
 * is not a request to the bare page and, under a provider's sign-in, brings the
 * request back here after it. With local accounts the page signs in in place
 * (signin.js), second step included.
 *
 * - Allow asks `POST /api/devices/codes` (with the session) for a code and goes
 *   back to the app with it (`redirect_to`: the return address with the code and
 *   the state). The app trades it for its device token; nothing here keeps the
 *   code, and it lasts five minutes, once. The page follows only an answer that
 *   goes back to the request's own address.
 * - Cancel goes back to the app with `error=access_denied` and the state
 *   (OAuth's error answer, RFC 6749), so the app's sign-in closes at once.
 * - The bare page, or a request the core refuses (an address it doesn't know, a
 *   field it doesn't take), says the link can't connect a device, and to start
 *   again from the app.
 * - An account the app keeps out (403 `device_not_allowed`) is told so; a
 *   session that ended meanwhile reloads the page, which signs in again.
 * - "Use another account", beside the account signed in: the browser may still
 *   hold the session of an earlier connect, and the app has no other way to
 *   switch. It ends that session (`POST /api/auth/logout`, never the provider's
 *   logout_url: the page stays here) and opens the same request again with
 *   `prompt=login`, so the sign-in is asked for again: in place with local
 *   accounts, at the provider, which is asked not to reuse its own session.
 *
 * After either button the page says it is going back to the app, with a link
 * that does the same, for a browser that didn't follow by itself.
 */
import { $, el, clear } from './dom.js';
import { t, loadLanguage, pickLanguage } from './i18n.js';
import { api, errorMessage, ApiError, SessionExpired } from './api.js';
import { signIn } from './signin.js';
import { signature } from './ui.js';

export const CONNECT_PATH = '/devices/connect';
/** The shapes the server checks too (device-pages.js). */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[A-Za-z0-9._~-]{1,200}$/;
/** What the core refuses about the request itself: the link is no good, whatever is tried again. */
const BAD_REQUEST = new Set(['redirect_uri_not_allowed', 'field_invalid', 'field_required', 'field_too_long']);

/**
 * The request in the page's address (`location.search`), or null: `{ code_challenge, state,
 * redirect_uri, name, platform }`, as POST /api/devices/codes takes it. Which return addresses
 * are allowed is the server's to say: it serves the page with a query only when it is one of them.
 */
export function connectRequestOf(search) {
  const query = new URLSearchParams(search);
  const one = (name) => (query.getAll(name).length === 1 ? query.get(name) : null);
  const request = {
    code_challenge: one('code_challenge'), state: one('state'), redirect_uri: one('redirect_uri'),
    name: (one('name') || '').trim(), platform: one('platform') || null,
  };
  if (!CHALLENGE.test(request.code_challenge || '') || !STATE.test(request.state || '')
      || !request.redirect_uri || !request.name || request.name.length > 60) return null;
  return request;
}

/** The page again for the same request, signing in anew: where "Use another account" goes. */
export function anotherAccountAddress(request) {
  const query = new URLSearchParams();
  for (const name of ['code_challenge', 'state', 'redirect_uri', 'name', 'platform']) {
    if (request[name] != null) query.set(name, request[name]);
  }
  query.set('prompt', 'login');
  return `${CONNECT_PATH}?${query}`;
}

/** The account as the page names it: the name and the email when there are both. */
export function accountLabel(user) {
  const name = user?.display_name || '';
  const address = user?.email || user?.username || '';
  return name && address && name !== address ? `${name} (${address})` : address || name;
}

/** Where Cancel goes: the app's address with `error=access_denied` and its state. */
export function cancelAddress(request) {
  const query = new URLSearchParams({ error: 'access_denied', state: request.state });
  return `${request.redirect_uri}?${query}`;
}

/** The sign-in's layout: the product's colour and name beside the card, and the signature. */
function layout(app, card) {
  return el('main', { class: 'kit-signin kit-connect' },
    el('section', { class: 'kit-signin__hero' },
      app.icon ? el('img', { src: app.icon, alt: '', width: 76, height: 76 }) : null,
      el('h1', { text: app.name })),
    el('div', { class: 'kit-signin__side' },
      el('div', { class: 'kit-signin__body' }, card),
      el('footer', { class: 'kit-signin__sig' }, signature())));
}

/**
 * Draws the page in `root`: the consent for `request`, or why the link can't connect a device
 * when `request` is null. `user` is the signed-in account; `send` asks for the code and `go`
 * follows an address (both the browser's by default, so tests can stand in). → the screen.
 */
export function showConnect({
  app, user, request, root = document.body,
  send = (body) => api.post('/api/devices/codes', body), go = (href) => window.location.assign(href),
  reload = () => window.location.reload(), signOut = () => api.post('/api/auth/logout'),
}) {
  const card = el('div', { class: 'kit-signin__card' });
  const screen = layout(app, card);
  root.append(screen);

  function invalid() {
    clear(card).append(
      el('h2', { text: t('kit.connect.invalid.title') }),
      el('p', { text: t('kit.connect.invalid.text', { app: app.name }) }));
  }

  /** After a button: going back to the app, with a link to it should the browser not follow. */
  function leaving(text, href) {
    clear(card).append(
      el('h2', { text: t('kit.connect.title', { app: app.name }) }),
      el('p', { role: 'status', text }),
      el('a', { class: 'kit-btn kit-btn--primary kit-btn--block', href, text: t('kit.connect.open', { app: app.name }) }));
    go(href);
  }

  /**
   * The consent's sentence, with the device's name in an element of its own: the name is
   * whatever the app sent, so it reads as the device's name, never as part of the page's words.
   */
  function lead() {
    const mark = '\u0000';
    const parts = t('kit.connect.lead', { device: mark, app: app.name }).split(mark);
    const name = () => el('strong', { class: 'kit-connect__device', text: request.name });
    return el('p', {}, ...parts.flatMap((part, i) => (i ? [name(), part] : [part])).filter((piece) => piece !== ''));
  }

  function consent() {
    const who = accountLabel(user);
    const status = el('p', { class: 'kit-hint', role: 'status', 'aria-live': 'polite' });
    const allow = el('button', {
      type: 'button', class: 'kit-btn kit-btn--primary kit-btn--block', 'data-action': 'allow',
      text: t('oauth.allow'), onClick: () => allowed(),
    });
    const cancel = el('button', {
      type: 'button', class: 'kit-btn kit-btn--quiet kit-btn--block', 'data-action': 'cancel',
      text: t('kit.cancel'), onClick: () => leaving(t('kit.connect.cancelled', { app: app.name }), cancelAddress(request)),
    });
    const other = el('button', {
      type: 'button', class: 'kit-link', 'data-action': 'other-account',
      text: t('kit.connect.otherAccount'), onClick: () => switchAccount(),
    });
    const buttons = [allow, cancel, other];
    const enable = (on) => { for (const button of buttons) button.disabled = !on; };
    clear(card).append(
      el('h2', { text: t('kit.connect.title', { app: app.name }) }),
      lead(),
      user ? el('p', { class: 'kit-hint kit-connect__account' },
        who ? `${t('oauth.signedInAs', { user: who })} ` : null, other) : null,
      el('div', { class: 'kit-stack' }, allow, cancel),
      status);

    /** Out of this browser's session, and the same request again, signing in anew. */
    async function switchAccount() {
      enable(false);
      status.textContent = t('kit.connect.signingOut');
      try {
        // Its logout_url is left aside: the page must come back here, not to the provider's.
        await signOut();
      } catch (err) {
        // Already out (the session ended meanwhile) is as good as signed out.
        if (!(err instanceof SessionExpired)) {
          status.textContent = errorMessage(err);
          enable(true);
          return;
        }
      }
      go(anotherAccountAddress(request));
    }

    async function allowed() {
      enable(false);
      status.textContent = t('kit.connect.asking');
      try {
        const { redirect_to: back } = await send({
          code_challenge: request.code_challenge, code_challenge_method: 'S256', redirect_uri: request.redirect_uri,
          state: request.state, name: request.name, ...(request.platform ? { platform: request.platform } : {}),
        });
        if (typeof back !== 'string' || !back.startsWith(`${request.redirect_uri}?`)) return invalid();
        leaving(t('kit.connect.returning', { app: app.name }), back);
      } catch (err) {
        if (err instanceof SessionExpired) return reload();
        if (err instanceof ApiError && BAD_REQUEST.has(err.code)) return invalid();
        // A 403 (device_not_allowed) says itself, as any other refusal does; only a refusal that
        // may pass on a second try (the network, too many at once) leaves the buttons on.
        status.textContent = errorMessage(err);
        if (!(err instanceof ApiError && err.status === 403)) enable(true);
        // Kept out as this account, another may still be let in.
        else other.disabled = false;
      }
      return undefined;
    }
  }

  if (request) consent(); else invalid();
  return screen;
}

/** The page: who is there (signing in first if nobody is), in their language, and the consent. */
async function start(root) {
  let config;
  let user;
  try {
    config = await api.get('/api/auth/config');
    user = (await api.get('/api/auth/me')).user;
  } catch {
    // Without the server there are no texts either.
    root.append(el('p', { class: 'kit-main', text: 'The server does not answer. Try again in a moment.' })); // i18n-exempt
    return;
  }
  const languages = config.app?.languages || ['en'];
  const language = (who) => {
    let prefs = {};
    try { prefs = typeof who?.prefs === 'string' ? JSON.parse(who.prefs) : (who?.prefs || {}); } catch { /* none */ }
    return loadLanguage(pickLanguage([who?.locale, prefs.lang, navigator.languages || [], navigator.language], languages),
      { remember: false, all: true }).catch(() => {});
  };
  await language(user);
  // The product's icon, as the server wrote it into the page.
  const app = { name: config.app?.name || '', icon: document.querySelector('link[rel="icon"]')?.getAttribute('href') || null };
  document.title = `${t('kit.connect.title', { app: app.name })} · ${app.name}`;
  if (!user) {
    user = await signIn({ app, config, root });
    await language(user);
  }
  if (user?.theme === 'dark' || user?.theme === 'light') document.documentElement.setAttribute('data-theme', user.theme);
  showConnect({ app, user, request: connectRequestOf(window.location.search), root });
}

// Imported by a test, there is no page to start.
const mount = globalThis.document ? $('#connect') : null;
if (mount) start(mount);
