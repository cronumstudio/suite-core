/**
 * The affiliate's panel, at /afiliados (affiliates.js): the person's own codes —their referral code,
 * and any creator's campaign the admin made for them— each with its link to copy, what the buyer
 * gets, the accounts it brought, its sales pending and confirmed, and what it earned: months of the
 * plan for a referral, money, payouts and what is still owed for a creator, who also says here how
 * they want to be paid. Then the program's rules and the press kit.
 *
 * Only on the web: the suite's app on a phone never links here (Settings, native.js), as the
 * stores' rules keep rewards and prices out of an app (Apple's 3.1). The server decides what
 * there is; this page shows what it answers.
 */
import { $, el, clear, append } from './dom.js';
import { api, errorMessage, SessionExpired, ApiError } from './api.js';
import { t, loadLanguage, pickLanguage, formatDate, numberFormat } from './i18n.js';
import { toast, field, copyText } from './ui.js';
import { icon } from './icons.js';

const root = $('#affiliates');
const state = { config: null, me: null };

const money = (cents, currency) => numberFormat({ style: 'currency', currency: currency || 'EUR' }).format((Number(cents) || 0) / 100);
const offerText = (offer) => (offer?.type === 'flat'
  ? t('affiliates.offer.flat', { amount: money(offer.amount, offer.currency) })
  : t('affiliates.offer.percent', { percent: offer?.percent ?? 0 }));
/** The products a code covers, in words: the monthly and the yearly, or the yearly alone. */
const productsText = (products) => (products.length === 1 && /yearly/.test(products[0]) ? t('affiliates.products.yearly')
  : t('affiliates.products.all'));

function applyTheme(theme) {
  const dark = theme === 'dark' || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

/** A whole-page message instead of the panel, with a way on. */
function notice(text, link = null) {
  const name = state.config?.app?.name || '';
  clear(root).append(el('main', { class: 'kit-main' },
    el('div', { class: 'kit-notice' },
      el('p', { text }),
      el('a', { class: 'kit-btn kit-btn--primary', href: link?.href || '/', text: link?.text || t('affiliates.backTo', { app: name }) }))));
}

const fact = (label, value) => el('div', { class: 'kit-fact' }, el('span', { text: label }), el('strong', { text: value }));
const copyRow = (label, value) => {
  const shown = el('code', { class: 'kit-mono', text: value });
  return field(label, el('div', { class: 'kit-copy' }, shown, el('button', {
    type: 'button', class: 'kit-btn kit-btn--small', 'aria-label': t('affiliates.copyWhat', { what: label }),
    onClick: () => copyText(value, shown),
  }, icon('copy'), t('affiliates.copy'))), null, { groupLabel: true });
};

/** One code: its link, what the buyer gets, and what it brought. */
function codeCard(code, rules) {
  const f = code.figures;
  const creator = code.kind === 'creator';
  const title = creator ? (code.campaign ? t('affiliates.creator.titleOf', { campaign: code.campaign }) : t('affiliates.creator.title'))
    : t('affiliates.referral.title');
  const earned = creator
    ? [fact(t('affiliates.figures.earned'), money(f.earned, code.reward.currency)),
      fact(t('affiliates.figures.paid'), money(f.paid, code.reward.currency)),
      fact(t('affiliates.figures.balance'), money(f.balance, code.reward.currency))]
    : [fact(t('affiliates.figures.months'), t('affiliates.months', { n: f.months })),
      fact(t('affiliates.figures.thisYear'), t('affiliates.ofCap', { n: f.months_this_year, cap: rules.referral.yearly_cap }))];
  const card = el('section', { class: 'kit-stack' },
    el('h2', { text: title }),
    code.active ? null : el('p', { class: 'kit-notice', text: t('affiliates.inactive') }),
    el('p', { class: 'kit-lead', text: creator
      ? t('affiliates.creator.lead', { offer: offerText(code.offer), products: productsText(code.products), reward: money(code.reward.cash, code.reward.currency) })
      : t('affiliates.referral.lead', { offer: offerText(code.offer), products: productsText(code.products) }) }),
    el('div', { class: 'kit-grid' }, copyRow(t('affiliates.code'), code.code), copyRow(t('affiliates.link'), code.link)),
    code.discount ? null : el('p', { class: 'kit-hint', text: t('affiliates.linkOnly') }),
    creator ? el('p', { class: 'kit-hint', text: t('affiliates.creator.tip', { code: code.code }) }) : null,
    el('div', { class: 'kit-facts' },
      fact(t('affiliates.figures.accounts'), String(f.accounts)),
      fact(t('affiliates.figures.pending'), String(f.pending)),
      fact(t('affiliates.figures.confirmed'), String(f.confirmed)),
      f.reversed ? fact(t('affiliates.figures.reversed'), String(f.reversed)) : null,
      ...earned));
  if (creator) {
    if (code.payouts?.length) {
      append(card, el('h3', { text: t('affiliates.payouts') }), el('div', { class: 'kit-facts' },
        code.payouts.map((p) => fact(formatDate(p.paid_at), [money(p.amount, p.currency), p.method].filter(Boolean).join(' · ')))));
    }
    append(card, el('p', { class: 'kit-hint', text: t('affiliates.creator.minimum', { minimum: money(rules.creator.payout_minimum, code.reward.currency) }) }));
  }
  return card;
}

/** How a creator wants to be paid: their own words, for the admin who pays them. */
function payoutNote(note) {
  const text = el('textarea', { class: 'kit-input', rows: '3', maxlength: '500' });
  text.value = note || '';
  const save = el('button', {
    type: 'button', class: 'kit-btn kit-btn--primary kit-btn--small', text: t('affiliates.payoutNote.save'),
    onClick: async () => {
      save.disabled = true;
      try {
        await api.put('/api/affiliates/me', { payout_note: text.value.trim() || null });
        toast(t('affiliates.payoutNote.saved'));
      } catch (err) {
        toast(errorMessage(err), { error: true });
      } finally {
        save.disabled = false;
      }
    },
  });
  return el('section', { class: 'kit-stack' },
    el('h2', { text: t('affiliates.payoutNote.title') }),
    field(t('fields.payout_note'), text, t('affiliates.payoutNote.hint')),
    el('div', { class: 'kit-row' }, save));
}

/** The program's rules, in short. */
function rulesBlock(rules, kinds) {
  const lines = [
    t('affiliates.rules.firstPayment'),
    t('affiliates.rules.confirm', { days: rules.confirm_days }),
    t('affiliates.rules.self'),
    kinds.has('referral') ? t('affiliates.rules.referral', { days: rules.referral.reward_days, cap: rules.referral.yearly_cap }) : null,
    kinds.has('creator') ? t('affiliates.rules.creator') : null,
    t('affiliates.rules.web'),
  ].filter(Boolean);
  return el('section', { class: 'kit-stack' },
    el('h2', { text: t('affiliates.rules.title') }),
    el('ul', {}, lines.map((line) => el('li', { text: line }))),
    rules.press_kit_url ? el('p', {}, el('a', {
      class: 'kit-link', href: rules.press_kit_url, target: '_blank', rel: 'noopener', text: t('affiliates.pressKit'),
    })) : null);
}

async function start() {
  try {
    state.config = await api.get('/api/auth/config');
    state.me = (await api.get('/api/auth/me')).user;
  } catch {
    root.append(el('p', { class: 'kit-main', text: 'The server does not answer. Try again in a moment.' })); // i18n-exempt
    return;
  }
  const me = state.me;
  let prefs = {};
  try { prefs = typeof me?.prefs === 'string' ? JSON.parse(me.prefs) : (me?.prefs || {}); } catch { /* none */ }
  const languages = state.config.app?.languages || ['en'];
  await loadLanguage(pickLanguage([me?.locale, prefs.lang, navigator.languages || [], navigator.language], languages), { remember: false })
    .catch(() => {});
  applyTheme(me?.theme);
  const app = state.config.app || {};
  document.title = `${t('affiliates.title', { app: app.name || '' })} · ${app.name || ''}`;
  // Signed out: to the sign-in, and back here.
  if (!me) {
    const href = state.config.provider === 'local' ? '/' : `/auth/login?return=${encodeURIComponent('/afiliados')}`;
    return notice(t('affiliates.signInFirst'), { href, text: t('affiliates.signIn') });
  }
  let mine;
  try {
    mine = await api.get('/api/affiliates/me');
  } catch (err) {
    if (err instanceof SessionExpired) return notice(t('affiliates.signInFirst'));
    if (err instanceof ApiError && ['affiliates_off', 'not_found'].includes(err.code)) return notice(t('affiliates.closed'));
    return notice(errorMessage(err));
  }
  const pageIcon = document.querySelector('link[rel="icon"]')?.getAttribute('href');
  const kinds = new Set(mine.codes.map((code) => code.kind));
  const creatorCode = mine.codes.find((code) => code.kind === 'creator');
  clear(root).append(
    el('header', { class: 'kit-header' },
      pageIcon ? el('img', { class: 'kit-header__icon', src: pageIcon, alt: '', width: 40, height: 40 }) : null,
      el('div', {},
        el('div', { class: 'kit-header__app', text: app.name }),
        el('h1', { text: t('affiliates.title', { app: app.name || '' }) })),
      el('span', { class: 'kit-header__spacer' }),
      el('a', { class: 'kit-btn kit-btn--small', href: '/', text: t('affiliates.backTo', { app: app.name }) })),
    el('main', { class: 'kit-main kit-stack' },
      el('p', { class: 'kit-lead', text: t('affiliates.lead', { app: app.name || '' }) }),
      mine.codes.map((code) => codeCard(code, mine.rules)),
      creatorCode ? payoutNote(creatorCode.payout_note) : null,
      rulesBlock(mine.rules, kinds)),
  );
  return undefined;
}

start().catch((err) => notice(errorMessage(err)));
