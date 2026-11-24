/**
 * An invitation with the plan, at /i/<token> (creator-invitations.js): one short screen. «Hi, María.
 * Your Pro account is ready» («Hi there» on a link that names nobody), the plan it gives (some months,
 * until a day, for good), the invitation's email (fixed: the link proves it is theirs) or a field for
 * theirs when it names none, a password, for a creator their code already written and checked as they
 * change it, the sample data when the install has them, «Enter», the terms, and a small «or with
 * Google» that goes through the identity provider and claims the invitation on the way back.
 *
 * What the server says decides the screen:
 *   - an email with no account: the password, and «Enter» makes the account and signs them in
 *   - an email that has one (here, or a login of another app of the suite): «Enter» signs in with
 *     it, and the invitation is added to that account on the way back
 *   - signed in already: «Activate», on that account; with someone else's account, a word about it
 *     and the way to sign out first
 *   - used, revoked, expired or unknown: a line that says so
 * Back from signing in elsewhere (`?claim=1`, with the code and the sample data chosen) it claims at
 * once and opens the app.
 */
import { $, el, clear } from './dom.js';
import { api, errorMessage, ApiError } from './api.js';
import { t, loadLanguage, pickLanguage, currentLanguage, numberFormat, formatDateTime } from './i18n.js';
import { signature } from './ui.js';

const root = $('#invitation');
const token = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop() || '');
const params = new URLSearchParams(window.location.search);
const base = `/api/creator-invitations/${encodeURIComponent(token)}`;
const state = { config: null, invitation: null };

const money = (cents, currency) => numberFormat({ style: 'currency', currency: currency || 'EUR' }).format((Number(cents) || 0) / 100);
const offerText = (offer) => (offer?.type === 'flat'
  ? t('affiliates.offer.flat', { amount: money(offer.amount, offer.currency) })
  : t('affiliates.offer.percent', { percent: offer?.percent ?? 0 }));
/** A code as Paddle takes it: capitals and digits, nothing else. */
const cleanCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);

function applyTheme() {
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

/** The page's frame: the product's colour with the greeting, the card beside it (stacked on a phone). */
function frame(title, lead, ...children) {
  const app = state.config?.app || {};
  const icon = document.querySelector('link[rel="icon"]')?.getAttribute('href');
  const card = el('div', { class: 'kit-signin__card' }, children.flat().filter(Boolean));
  clear(root).append(el('main', { class: 'kit-signin' },
    el('section', { class: 'kit-signin__hero' },
      icon ? el('img', { src: icon, alt: '', width: 76, height: 76 }) : null,
      el('h1', { text: title || app.name || '' }),
      lead ? el('p', { text: lead }) : null),
    el('div', { class: 'kit-signin__side' },
      el('div', { class: 'kit-signin__body' }, card),
      el('footer', { class: 'kit-signin__sig' }, signature()))));
  return card;
}

/** A line instead of the form, with the way into the app. */
function over(text) {
  const app = state.config?.app || {};
  frame(app.name, null,
    el('p', { text }),
    el('a', { class: 'kit-btn kit-btn--primary kit-btn--block', href: '/', text: t('creatorInvite.open', { app: app.name || '' }) }));
}

const labelled = (label, control, hint = null) => el('div', { class: 'kit-field' },
  el('label', { for: control.id, text: label }), control, hint);

/** The terms' line, with its two links, when the install has them. */
function legalLine(inv) {
  const pick = (value) => (typeof value === 'string' ? value
    : value ? value[currentLanguage()] || value.en || Object.values(value)[0] : null);
  const terms = pick(inv.terms);
  const privacy = pick(inv.privacy);
  if (!terms && !privacy) return null;
  const link = (href, text) => el('a', { class: 'kit-link', href, target: '_blank', rel: 'noopener', text });
  // The sentence is the language's; the two links go where its placeholders were.
  const marks = { terms: '\u0001', privacy: '\u0002' };
  const sentence = terms && privacy ? t('creatorInvite.legal', marks)
    : terms ? t('creatorInvite.legalTerms', marks) : t('creatorInvite.legalPrivacy', marks);
  const parts = sentence.split(/([\u0001\u0002])/).map((part) => (part === '\u0001' ? link(terms, t('creatorInvite.terms'))
    : part === '\u0002' ? link(privacy, t('creatorInvite.privacy')) : part));
  return el('p', { class: 'kit-hint' }, parts);
}

/**
 * The code's field: written already, checked as it changes (its form at once, whether it is free a
 * moment later), and a free one like it offered when it isn't.
 */
function codeField(inv) {
  const input = el('input', {
    id: 'invite-code', class: 'kit-input kit-mono', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
    maxlength: '32', value: cleanCode(params.get('code') || inv.code), 'aria-describedby': 'invite-code-hint',
  });
  const hint = el('p', { class: 'kit-hint', id: 'invite-code-hint', role: 'status' });
  const lead = t('creatorInvite.codeHint', { offer: offerText(inv.offer) });
  let timer = null;
  let asked = 0;
  const say = (text, { error = false, suggestion = null } = {}) => {
    clear(hint).append(el('span', { text }));
    hint.setAttribute('class', error ? 'kit-hint kit-error' : 'kit-hint');
    if (suggestion) {
      hint.append(' ', el('button', {
        type: 'button', class: 'kit-link', text: t('creatorInvite.useCode', { code: suggestion }),
        onClick: () => { input.value = suggestion; check(); input.focus(); },
      }));
    }
  };
  const check = () => {
    clearTimeout(timer);
    const code = cleanCode(input.value);
    if (input.value !== code) input.value = code;
    if (code.length < 3) { say(t('creatorInvite.codeShort'), { error: true }); return; }
    say(lead);
    const mine = ++asked;
    timer = setTimeout(async () => {
      try {
        const answer = await api.get(`${base}/code?code=${encodeURIComponent(code)}`);
        if (mine !== asked) return;
        if (!answer.valid) say(t('creatorInvite.codeShort'), { error: true });
        else if (!answer.available) say(t('creatorInvite.codeTaken', { code }), { error: true, suggestion: answer.suggestion });
        else say(lead);
      } catch {
        // Asked again when they enter: the server checks it then anyway.
      }
    }, 350);
  };
  input.addEventListener('input', check);
  say(lead);
  return { node: labelled(t('creatorInvite.code'), input, hint), input, say, check };
}

/** What was chosen, as the server takes it (a code only for a creator's). */
const choices = (code, sample) => ({
  ...(code ? { code: cleanCode(code.input.value) } : {}), sample_data: Boolean(sample?.checked), locale: currentLanguage(),
});

/** «Hi, María.» for one person's invitation; a link for many greets anyone. */
const hello = (inv) => (inv.name ? t('creatorInvite.hello', { name: inv.name }) : t('creatorInvite.helloAnyone'));

/** The plan it gives: for some months, until a day, or for good. */
const planLine = (inv) => (inv.pro_until ? t('creatorInvite.until', { date: formatDateTime(inv.pro_until, { dateStyle: 'long' }) })
  : inv.pro_months == null ? t('creatorInvite.forever') : t('creatorInvite.months', { n: inv.pro_months }));

/** An answer that is about the code shows under it; anything else, above the button. */
function failed(err, code, error) {
  if (code && err instanceof ApiError && ['affiliate_code_taken', 'discount_code_taken'].includes(err.code)) {
    code.say(errorMessage(err), { error: true, suggestion: err.data?.suggestion || null });
    code.input.focus();
    return;
  }
  error.textContent = errorMessage(err);
  error.hidden = false;
}

/** The app, signed in: or the identity provider's page for the step it still wants. */
const into = (answer) => window.location.replace(answer?.signed_in === false ? '/auth/login?return=%2F' : '/');

/** Where to sign in elsewhere and come back here to claim it: Google, or the provider's page with their email. */
async function signInElsewhere(code, sample, provider = null, email = '') {
  const query = new URLSearchParams();
  if (provider) query.set('provider', provider);
  const chosen = cleanCode(code?.input.value);
  if (chosen) query.set('code', chosen);
  if (sample?.checked) query.set('sample', '1');
  if (email) query.set('email', email);
  const { url } = await api.get(`${base}/sign-in?${query}`);
  window.location.assign(url);
}

/**
 * The form. `typed`: the email they wrote on an invitation that names none, when it turned out to
 * have an account (they sign in with it then).
 */
function form(inv, { message = '', typed = '' } = {}) {
  const error = el('p', { class: 'kit-error', role: 'alert', text: message, hidden: !message });
  const code = inv.creator ? codeField(inv) : null;
  const sample = inv.sample_data && !inv.existing && !typed && !inv.signed_in
    ? el('input', { type: 'checkbox', id: 'invite-sample' }) : null;
  const submit = el('button', { type: 'submit', class: 'kit-btn kit-btn--primary kit-btn--block' });
  // The invitation's email, fixed: the link proves it is theirs. Without one, theirs to write.
  const email = inv.email
    ? el('input', { id: 'invite-email', class: 'kit-input', type: 'email', value: inv.email, readonly: true, autocomplete: 'username' })
    : el('input', {
      id: 'invite-email', class: 'kit-input', type: 'email', value: typed, required: true, autocomplete: 'email',
      spellcheck: 'false', autocapitalize: 'none', maxlength: '254',
    });
  const address = () => inv.email || email.value.trim();
  const google = inv.google && !inv.signed_in ? el('button', {
    type: 'button', class: 'kit-link', text: t('creatorInvite.google'),
    onClick: () => signInElsewhere(code, sample, 'google').catch((err) => failed(err, code, error)),
  }) : null;
  const plan = planLine(inv);
  // Who is signed in in this browser: their email, or their name when the account has none.
  const who = inv.signed_in ? inv.signed_in.email || inv.signed_in.name || '' : '';
  let password = null;
  let intro = null;
  let act;

  if (inv.signed_in && inv.signed_in.same) {
    intro = t('creatorInvite.signedIn', { email: who });
    submit.textContent = t('creatorInvite.activate');
    act = () => api.post(`${base}/claim`, choices(code, sample));
  } else if (inv.signed_in) {
    // Someone else's account in this browser: nothing is given to it unless they say so.
    return frame(hello(inv), t('creatorInvite.ready'),
      el('p', { text: inv.email ? t('creatorInvite.other', { email: inv.email, other: who }) : t('creatorInvite.signedIn', { email: who }) }),
      error,
      el('button', {
        type: 'button', class: 'kit-btn kit-btn--primary kit-btn--block', text: t('creatorInvite.signOut'),
        onClick: async () => {
          try { await api.post('/api/auth/logout', {}); } catch { /* signed out all the same */ }
          window.location.reload();
        },
      }),
      el('button', {
        type: 'button', class: 'kit-link', text: t('creatorInvite.useThis', { other: who }),
        onClick: () => { form({ ...inv, signed_in: { ...inv.signed_in, same: true } }); },
      }));
  } else if (inv.existing || typed || !inv.password) {
    intro = inv.existing || typed ? t('creatorInvite.existing', { email: address() }) : null;
    submit.textContent = t('creatorInvite.enter');
    act = async () => { await signInElsewhere(code, sample, null, inv.email ? '' : address()); return null; };
  } else {
    password = el('input', {
      id: 'invite-password', class: 'kit-input', type: 'password', autocomplete: 'new-password', required: true,
      minlength: String(inv.password_min || 10), spellcheck: 'false', autocapitalize: 'none',
    });
    submit.textContent = t('creatorInvite.enter');
    act = () => api.post(`${base}/accept`, { password: password.value, ...(inv.email ? {} : { email: address() }), ...choices(code, sample) });
  }

  const node = el('form', { class: 'kit-stack', novalidate: true },
    el('p', { class: 'kit-hint', text: plan }),
    intro ? el('p', { text: intro }) : null,
    labelled(t('fields.email'), email),
    password ? labelled(t('creatorInvite.password'), password,
      el('p', { class: 'kit-hint', text: t('creatorInvite.passwordHint', { n: inv.password_min || 10 }) })) : null,
    code?.node,
    sample ? el('label', { class: 'kit-check' }, sample, el('span', { text: t('creatorInvite.sample') })) : null,
    error,
    submit,
    google ? el('div', { class: 'kit-signin__links' }, google) : null,
    legalLine(inv));
  node.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.hidden = true;
    if (!inv.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address())) {
      error.textContent = t('creatorInvite.emailNeeded');
      error.hidden = false;
      email.focus();
      return;
    }
    if (password && password.value.length < (inv.password_min || 10)) {
      error.textContent = t('creatorInvite.passwordHint', { n: inv.password_min || 10 });
      error.hidden = false;
      password.focus();
      return;
    }
    submit.disabled = true;
    try {
      const answer = await act();
      if (answer) into(answer);
    } catch (err) {
      // The email has an account: they sign in with it. One they wrote: said, with that email.
      if (err instanceof ApiError && err.code === 'account_exists') return inv.email ? start() : form(inv, { typed: address() });
      failed(err, code, error);
    } finally {
      submit.disabled = false;
    }
    return undefined;
  });
  frame(hello(inv), t('creatorInvite.ready'), node);
  (inv.email ? password || code?.input : email)?.focus();
  return node;
}

/** Back from signing in elsewhere: the invitation claimed for that account at once, then the app. */
async function claimNow(inv) {
  frame(hello(inv), t('creatorInvite.ready'), el('p', { role: 'status', text: t('creatorInvite.claiming') }));
  try {
    into(await api.post(`${base}/claim`, {
      ...(inv.creator ? { code: cleanCode(params.get('code') || inv.code) } : {}), sample_data: params.get('sample') === '1', locale: currentLanguage(),
    }));
  } catch (err) {
    // A code taken meanwhile, or another problem: the form, signed in, to try again.
    window.history.replaceState(null, '', window.location.pathname);
    form({ ...inv, signed_in: { ...(inv.signed_in || {}), same: true } }, { message: errorMessage(err) });
  }
}

async function start() {
  try {
    state.config = await api.get('/api/auth/config');
  } catch {
    root.append(el('p', { class: 'kit-main', text: 'The server does not answer. Try again in a moment.' })); // i18n-exempt
    return;
  }
  const languages = state.config.app?.languages || ['en'];
  await loadLanguage(pickLanguage([navigator.languages || [], navigator.language], languages), { remember: false }).catch(() => {});
  document.documentElement.lang = currentLanguage();
  applyTheme();
  document.title = `${t('creatorInvite.title')} · ${state.config.app?.name || ''}`;
  let inv;
  try {
    inv = await api.get(base);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'invitation_expired') return over(t('creatorInvite.expired'));
    if (err instanceof ApiError && err.status === 404) return over(t('creatorInvite.invalid'));
    return over(errorMessage(err));
  }
  state.invitation = inv;
  if (inv.status === 'claimed') return over(t('creatorInvite.claimed'));
  if (inv.status === 'expired') return over(t('creatorInvite.expired'));
  if (inv.status !== 'pending') return over(t('creatorInvite.invalid'));
  if (params.get('claim') === '1' && inv.signed_in) return claimNow(inv);
  form(inv);
  return undefined;
}

start().catch((err) => over(errorMessage(err)));
