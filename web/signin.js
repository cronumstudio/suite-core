/**
 * The sign-in screen of every app: the product's colour large, the form
 * beside it (stacked on a phone), and "by Cronum Studio" under it. Taken from
 * Next's, on the suite's routes:
 *
 * - local accounts: username and password, then the code of an authenticator
 *   app when the account has a second step; a forgotten password (when the
 *   install sends mail), the link's new password (/?reset=…), an invitation's
 *   sign-up (/?signup=…) or open sign-up where the install allows it;
 * - WorkOS or OpenID Connect: the provider's page, from a button.
 *
 *   const user = await signIn({ app: { name: 'Notes', icon: '/icons/favicon.svg', tagline: tagline } });
 *
 * Resolves with the signed-in user once someone gets through; the screen is
 * removed then.
 */
import { el, clear } from './dom.js';
import { t } from './i18n.js';
import { api, errorMessage } from './api.js';
import { at } from './base.js';
import { signature, toast } from './ui.js';

const param = (name) => new URLSearchParams(window.location.search).get(name);
function dropParam(name) {
  const url = new URL(window.location.href);
  url.searchParams.delete(name);
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
}

/** A failed return from the provider (`?auth_error=…`), read once and taken away. */
function providerError() {
  const reason = param('auth_error');
  if (!reason) return '';
  dropParam('auth_error');
  return t(reason === 'unavailable' ? 'kit.signin.unavailable' : reason === 'disabled' ? 'kit.signin.disabled' : 'kit.signin.failed');
}

const input = (props) => el('input', { class: 'kit-input', spellcheck: 'false', autocapitalize: 'none', ...props });
const labelled = (label, control) => el('div', { class: 'kit-field' }, el('label', { for: control.id, text: label }), control);
const errorLine = () => el('p', { class: 'kit-error', role: 'alert', hidden: true });
const showError = (node, text) => { node.textContent = text; node.hidden = !text; };

/**
 * @param {object} options
 * @param {object} options.app        { name, icon, tagline }
 * @param {object} [options.config]   /api/auth/config, when the page already has it
 * @param {Node}   [options.root]
 * @returns {Promise<object>} the user
 */
export async function signIn({ app, config = null, root = document.body }) {
  let settings = config;
  if (!settings) {
    // Without network the usual is assumed: at least the form can be typed in.
    try { settings = await api.get('/api/auth/config'); } catch { settings = { provider: 'local', signup: 'admin', mail: false }; }
  }
  const local = (settings.provider || 'local') === 'local';
  const minimum = String(settings.password_min || 10);

  return new Promise((resolve) => {
    const card = el('div', { class: 'kit-signin__card' });
    const screen = el('main', { class: 'kit-signin' },
      el('section', { class: 'kit-signin__hero' },
        el('img', { src: at(app.icon || '/icons/favicon.svg'), alt: '', width: 76, height: 76 }),
        el('h1', { text: app.name }),
        app.tagline ? el('p', { text: app.tagline }) : null),
      el('div', { class: 'kit-signin__side' },
        el('div', { class: 'kit-signin__body' }, card),
        el('footer', { class: 'kit-signin__sig' }, signature())));
    root.append(screen);

    const done = (user) => {
      screen.remove();
      resolve(user);
    };
    const show = (...children) => {
      clear(card).append(...children.flat().filter(Boolean));
      card.querySelector('input:not([type="hidden"])')?.focus();
    };
    const back = () => el('button', {
      type: 'button', class: 'kit-link', text: t('kit.signin.back'),
      onClick: () => { dropParam('reset'); dropParam('signup'); main(); },
    });
    const form = (onSubmit, ...children) => {
      const node = el('form', { class: 'kit-stack', novalidate: false }, children);
      node.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const button = node.querySelector('button[type="submit"]');
        button.disabled = true;
        try { await onSubmit(); } finally { button.disabled = false; }
      });
      return node;
    };
    const submit = (text) => el('button', { type: 'submit', class: 'kit-btn kit-btn--primary kit-btn--block', text });

    /* ------------------------------- the usual -------------------------------- */

    function main(message = '') {
      if (!local) {
        const name = settings.name || '';
        show(
          el('h2', { text: t('kit.signin.title') }),
          message ? el('p', { class: 'kit-error', role: 'alert', text: message }) : null,
          el('a', { class: 'kit-btn kit-btn--primary kit-btn--block', href: '/auth/login', text: name ? t('kit.signin.with', { provider: name }) : t('kit.signin.submit') }),
          // Signing up is AuthKit's; an OIDC provider has its own, if it allows it.
          settings.provider === 'workos' ? el('a', { class: 'kit-btn kit-btn--block', href: '/auth/login?signup=1', text: t('kit.signin.signupLink') }) : null);
        return;
      }
      const username = input({ id: 'kit-signin-username', name: 'username', autocomplete: 'username', required: true });
      const password = input({ id: 'kit-signin-password', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
      const error = errorLine();
      showError(error, message);
      show(
        el('h2', { text: t('kit.signin.title') }),
        form(async () => {
          try {
            const answer = await api.post('/api/auth/login', { username: username.value.trim(), password: password.value });
            password.value = '';
            if (answer?.two_factor_required) code(answer.challenge);
            else done(answer.user);
          } catch (err) {
            showError(error, errorMessage(err));
            password.select();
          }
        },
        labelled(t('kit.signin.username'), username),
        labelled(t('kit.signin.password'), password),
        error,
        submit(t('kit.signin.submit'))),
        el('div', { class: 'kit-signin__links' },
          // A forgotten password comes back by mail: without mail the link would never arrive.
          settings.mail ? el('button', { type: 'button', class: 'kit-link', text: t('kit.signin.forgotLink'), onClick: () => forgot(username.value) }) : null,
          settings.signup === 'open' ? el('button', { type: 'button', class: 'kit-link', text: t('kit.signin.signupLink'), onClick: () => signup() }) : null));
    }

    /* ------------------------------ second step ------------------------------- */

    function code(challenge) {
      const field = input({ id: 'kit-signin-code', autocomplete: 'one-time-code', inputmode: 'text', maxlength: '12', required: true });
      const error = errorLine();
      show(
        el('h2', { text: t('kit.signin.code.title') }),
        el('p', { text: t('kit.signin.code.intro', { app: app.name }) }),
        form(async () => {
          try {
            const answer = await api.post('/api/auth/login/code', { challenge, code: field.value.trim() });
            const left = answer?.recovery_codes_left;
            done(answer.user);
            // A recovery code: how many are left, before they run out.
            if (left != null) toast(t('kit.signin.code.recoveryLeft', { n: left }), { error: left <= 2, duration: 8000 });
          } catch (err) {
            // Too long on this card: the password again.
            if (err.code === 'challenge_expired' || err.code === 'challenge_invalid') main(errorMessage(err));
            else { showError(error, errorMessage(err)); field.select(); }
          }
        },
        labelled(t('kit.signin.code.label'), field),
        el('p', { class: 'kit-hint', text: t('kit.signin.code.hint') }),
        error,
        submit(t('kit.signin.code.submit'))),
        back());
    }

    /* --------------------------- forgotten password --------------------------- */

    function forgot(typed = '') {
      const login = input({ id: 'kit-signin-forgot', autocomplete: 'username', required: true, value: typed });
      const error = errorLine();
      const sent = el('p', { class: 'kit-signin__notice', role: 'status', text: t('kit.signin.forgot.sent'), hidden: true });
      show(
        el('h2', { text: t('kit.signin.forgot.title') }),
        el('p', { text: t('kit.signin.forgot.intro') }),
        // The same answer whether the account exists or not: it can't be used to find out.
        form(async () => {
          try {
            await api.post('/api/auth/forgot', { login: login.value.trim() });
            showError(error, '');
            sent.hidden = false;
          } catch (err) { showError(error, errorMessage(err)); }
        },
        labelled(t('kit.signin.forgot.login'), login),
        error, sent,
        submit(t('kit.signin.forgot.submit'))),
        back());
    }

    /** The mail's link: a new password, and the code too when the account has a second step. */
    function reset(token) {
      const password = input({ id: 'kit-signin-new', type: 'password', autocomplete: 'new-password', minlength: minimum, required: true });
      const codeField = input({ id: 'kit-signin-reset-code', autocomplete: 'one-time-code', maxlength: '12' });
      const codeRow = labelled(t('kit.signin.code.label'), codeField);
      codeRow.hidden = true;
      const error = errorLine();
      show(
        el('h2', { text: t('kit.signin.reset.title') }),
        form(async () => {
          try {
            const answer = await api.post('/api/auth/reset', {
              token, password: password.value, ...(codeRow.hidden ? {} : { code: codeField.value.trim() }),
            });
            dropParam('reset');
            done(answer?.user ?? (await api.get('/api/auth/me')).user);
          } catch (err) {
            if (err.code === 'two_factor_required') {
              // Whoever reads the mail isn't enough: the code of the app too.
              codeRow.hidden = false;
              codeField.required = true;
              codeField.focus();
            }
            showError(error, errorMessage(err));
          }
        },
        labelled(t('kit.signin.reset.password'), password),
        codeRow, error,
        submit(t('kit.signin.reset.submit'))),
        back());
    }

    /** An account of one's own: with an invitation the email is already known. */
    function signup(token = null) {
      const username = input({ id: 'kit-signup-username', autocomplete: 'username', required: true });
      const name = input({ id: 'kit-signup-name', autocomplete: 'name', autocapitalize: 'words', spellcheck: 'true' });
      const email = input({ id: 'kit-signup-email', type: 'email', autocomplete: 'email', required: !token });
      const password = input({ id: 'kit-signup-password', type: 'password', autocomplete: 'new-password', minlength: minimum, required: true });
      const error = errorLine();
      show(
        el('h2', { text: t('kit.signin.signup.title') }),
        el('p', { text: t(token ? 'kit.signin.signup.invited' : settings.mail ? 'kit.signin.signup.open' : 'kit.signin.signup.openNoMail') }),
        form(async () => {
          try {
            const answer = await api.post('/api/auth/signup', {
              token: token || undefined, username: username.value.trim(), display_name: name.value.trim() || undefined,
              email: token ? undefined : email.value.trim(), password: password.value,
            });
            dropParam('signup');
            done(answer?.user ?? (await api.get('/api/auth/me')).user);
          } catch (err) { showError(error, errorMessage(err)); }
        },
        labelled(t('kit.signin.username'), username),
        labelled(t('kit.signin.signup.name'), name),
        token ? null : labelled(t('kit.signin.signup.email'), email),
        labelled(t('kit.signin.password'), password),
        error,
        submit(t('kit.signin.signup.submit'))),
        back());
    }

    if (local && param('reset')) reset(param('reset'));
    else if (local && param('signup')) signup(param('signup'));
    else main(providerError());
  });
}

/** The link of a confirmation mail (/?verify=…): the email is confirmed on opening the app. */
export async function confirmEmailFromLink() {
  const token = param('verify');
  if (!token) return false;
  dropParam('verify');
  try {
    await api.post('/api/auth/verify', { token });
    toast(t('kit.profile.email.verified'));
    return true;
  } catch (err) {
    toast(errorMessage(err), { error: true });
    return false;
  }
}

/** Signs out here (and at the provider, which then comes back to the app). */
export async function signOut({ local = null } = {}) {
  const answer = await api.post('/api/auth/logout').catch(() => null);
  await local?.clearAll?.().catch(() => {});
  if (answer?.logout_url) window.location.href = answer.logout_url;
  else window.location.reload();
}
