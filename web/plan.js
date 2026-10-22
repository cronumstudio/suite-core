/**
 * The plan and its payments in the browser, the same in every app: what Settings' plan section
 * adds when the app sells (`planPayments`, drawn by settings.js), the call to action of a plan's
 * barrier anywhere in an app (`offerPlan`), and the way back from the payment provider's checkout
 * (`billingReturn`). On the suite's routes (billing.js): /api/me/entitlements,
 * /api/billing/products, /api/billing/subscriptions, /api/billing/checkout and
 * /api/billing/portal. Nothing here names a product or an app: what is sold, and its names, come
 * from the server.
 *
 *   openSettings({ …, plan: { billing: true } });                       // prices, Upgrade, Change or cancel
 *   openSettings({ …, plan: { billing: true, hideCheckout: true } });   // a native app's web view
 *   billingReturn({ onPlan: refresh, open: () => openPlan() });         // once, at the start
 *   catch (err) { if (!offerPlan(err, { open: () => openPlan() })) fail(err); }
 *   storePurchase();                                                     // inside the suite's app: its store
 *
 * The browser only names a product: the price, a founder's included, is the server's to choose,
 * and the provider's page charges it. The amounts shown beside each product are the catalog's
 * (`amount`, `founderAmount`), only to read.
 */
import { el, clear } from './dom.js';
import { t, formatDateTime, currentLanguage } from './i18n.js';
import { api, errorMessage } from './api.js';
import { toast, openDialog } from './ui.js';
import { FRAMED } from './base.js';
import { nativePurchase, onNative } from './native.js';

/** What `billingReturn` tells the page each time it reads the plan again: an open Settings repaints. */
export const PLAN_EVENT = 'kit-plan';

/** A subscription that still holds the plan, or will once paid: a second checkout would charge twice. */
const LIVE = new Set(['active', 'trialing', 'past_due']);

/** After the checkout the provider's webhook may come a moment after the person: asked again meanwhile. */
const RETURN_WAITS = Object.freeze([0, 1500, 3000, 5000, 10000]);

/* ------------------------------ what is sold ------------------------------ */

/**
 * A product as people read it: its own name from the server's catalog (a key of the catalogs or
 * the name itself, as plans' names are), or else its plan's; and what kind of payment it is. A
 * subscription's period is read from the suite's product keys (`pro-monthly`, `pro-yearly`).
 */
export function productText(product, plans = []) {
  const planName = plans.find((p) => p.id === product.plan)?.name || product.plan || '';
  const key = String(product.key || '');
  const detail = product.kind === 'once'
    ? (product.days ? t('kit.plan.kind.days', { n: product.days }) : t('kit.plan.kind.once'))
    : /-(?:monthly|month)$/.test(key) ? t('kit.plan.kind.monthly')
      : /-(?:yearly|annual|year)$/.test(key) ? t('kit.plan.kind.yearly')
        : t('kit.plan.kind.subscription');
  return { name: t(product.name || planName), detail };
}

/** Whether a subscription (GET /api/billing/subscriptions) still holds its plan, or will once paid. */
export const isLive = (subscription) => LIVE.has(subscription?.status);

/**
 * What is offered to someone: the products for one person (a group's are bought for the group)
 * whose plan is above theirs, in the catalog's order of plans (least first), or theirs again when
 * it lapses on a date. Nothing to someone without limits, whom no plan limits.
 *
 * `subscriptions` is GET /api/billing/subscriptions' list, and it decides first: nothing is
 * offered while one is live (a one-off pass or a second subscription would charge twice; plans
 * change in the portal), and nothing when it isn't known (left out, or the server didn't answer),
 * since a subscription's plan lapses on a date too, its period's end, and would be offered again.
 */
export function offerFor(answer, products = [], subscriptions = null) {
  if (!answer || answer.unlimited || !Array.isArray(subscriptions) || subscriptions.some(isLive)) return [];
  const order = (answer.plans || []).map((p) => p.id);
  const current = answer.plan?.id ?? null;
  const rank = (id) => order.indexOf(id);
  return products.filter((product) => product.for !== 'organization').filter((product) => {
    if (product.plan === current) return Boolean(answer.ends);
    if (rank(product.plan) < 0 || rank(current) < 0) return true;
    return rank(product.plan) > rank(current);
  });
}

/* ----------------------- Settings: the plan's payments ---------------------- */

const section = (...children) => el('section', { class: 'kit-settings__block' }, ...children);
const hint = (text) => el('p', { class: 'kit-hint', text });
const button = (text, onClick, kind = '') => el('button', {
  type: 'button', class: `kit-btn kit-btn--small${kind ? ` kit-btn--${kind}` : ''}`, text, onClick,
});

/** Where the browser keeps the plan from before a checkout, to tell when the new one arrives. */
const storageKey = () => `${globalThis.document?.documentElement?.dataset?.app || 'app'}.billing`;
const mark = (answer) => JSON.stringify([answer?.plan?.id ?? answer?.plan ?? null, answer?.ends ?? null]);

function remember(answer) {
  try { sessionStorage.setItem(storageKey(), mark(answer)); } catch { /* private mode: no thanks for the new plan */ }
}

function recall() {
  try {
    const kept = sessionStorage.getItem(storageKey());
    sessionStorage.removeItem(storageKey());
    return kept;
  } catch { return null; }
}

/** Only to the provider's page: an address that isn't http(s) is not followed. */
function follow(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('not a page');
  // From a frame of the host's split view the whole window goes: a payment page isn't framed.
  (FRAMED ? globalThis.top : globalThis).location.assign(url);
}

/** A subscription's period from the suite's product keys (`pro-monthly`, `pro-yearly`), or null. */
export function periodOf(product) {
  if (product?.kind !== 'subscription') return null;
  const key = String(product.key || '');
  return /-(?:monthly|month)$/.test(key) ? 'monthly' : /-(?:yearly|annual|year)$/.test(key) ? 'yearly' : null;
}

/** An amount as people read it in their language: "3,90 €", and "35 €" without cents when it has none. */
export function moneyText(amount, currency) {
  if (typeof amount !== 'number' || !currency) return '';
  const whole = Number.isInteger(amount);
  try {
    return new Intl.NumberFormat(currentLanguage(), {
      style: 'currency', currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2,
    }).format(amount);
  } catch { return ''; }
}

/**
 * The last day of something that ends at `iso` (the moment it no longer holds, as the server's
 * dates are: FOUNDER_OFFER_UNTIL=2027-02-01 is its first day without), in the server's calendar.
 */
export const lastDay = (iso) => {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? '' : formatDateTime(new Date(at - 1).toISOString(), { dateStyle: 'long', timeZone: 'UTC' });
};

const longDate = (iso) => formatDateTime(iso, { dateStyle: 'long' });

/**
 * What the plan card says under the plan's name, from GET /api/billing/overview: when a live
 * subscription renews or ends (and through which store), until when a gift lasts, the group that
 * covers it, or the early access that includes it; and the extras given on top, each with its end.
 * → { lines: [text], extras: [text] }; nothing for a plan that is simply the default one.
 */
export function planStatus(answer, overview, { products = null, benefit = () => '' } = {}) {
  const lines = [];
  const extras = [];
  const sources = Array.isArray(overview?.sources) ? overview.sources : [];
  const current = answer?.plan?.id ?? null;
  const paid = sources.filter((s) => (s.kind === 'web' || s.kind === 'store') && LIVE.has(s.status) && !s.organization_id);
  // The one that holds the plan shown, or else the one paid (a payment that failed may have let it lapse).
  for (const s of [paid.find((one) => one.plan === current) || paid[0]].filter(Boolean)) {
    if (s.status !== 'active') lines.push(t(`kit.plan.status.${s.status}`));
    if (s.period_end) {
      lines.push(t(s.ending === true ? 'kit.plan.endsOn' : s.ending === false ? 'kit.plan.renewsOn' : 'kit.plan.periodEnd',
        { date: longDate(s.period_end) }));
    }
    if (s.kind === 'store' && s.store) lines.push(t(`kit.plan.via.${s.store}`));
  }
  if (!lines.length) {
    const gift = sources.find((s) => s.kind === 'admin' && s.plan === current);
    const group = sources.find((s) => s.kind === 'organization' && s.plan === current);
    if (gift) lines.push(gift.ends ? t('kit.plan.given', { date: longDate(gift.ends) }) : t('kit.plan.givenForGood'));
    else if (group) lines.push(t('kit.plan.coveredBy', { group: group.name }));
    else if (products && products.on_sale === false && products.opens_at && !answer?.ends) {
      lines.push(t('kit.plan.earlyAccess', { date: lastDay(products.opens_at) }));
    }
  }
  for (const s of sources.filter((one) => one.kind === 'extra')) {
    const what = benefit(s.feature, s.value);
    if (what) extras.push(s.ends ? t('kit.plan.extraUntil', { what, date: longDate(s.ends) }) : what);
  }
  return { lines, extras };
}

/**
 * The blocks Settings' plan section adds when the app sells (`plan.billing`, or in a host the
 * host's payments), under the plan's card: a word when a payment failed, what can be bought with
 * "Upgrade" (its price, and a founder's struck through beside the regular one), "Change or cancel
 * plan" for whoever pays now, and last, quietly, the way to past payments and invoices for whoever
 * has no subscription now. "Change or cancel plan" opens its own dialog: the provider's portal
 * and what can be done there for a subscription of the web; for one of a store, how to cancel it
 * there, since Apple and Google let no one else. With `hideCheckout` (a native app's web view,
 * where the stores' rules keep a web payment's links out) nothing is sold and the web's portal is
 * named, not linked. Nothing is sold while the server says it isn't on sale (`on_sale: false`,
 * the early access).
 *
 * `paint(answer)` draws them for /api/me/entitlements' answer, and fills `status` (a node for the
 * card: when the plan renews or ends, a gift's end, the extras). It resolves to `{ holds, noted }`
 * —whether a live subscription holds the plan shown, and whether `status` says until when, so the
 * card's own "Until" goes— or to nothing when a later paint took its place.
 */
export function planPayments({
  hideCheckout = false, fail = (err) => toast(errorMessage(err), { error: true }), refresh = () => {},
  appName = '', benefit = () => '',
} = {}) {
  const status = el('div', { class: 'kit-plan-card__status' });
  const pastDueBlock = section(el('p', { class: 'kit-notice', role: 'status', text: t('kit.plan.pastDue') }));
  const offerList = el('div', { class: 'kit-list kit-plan__offer' });
  const offerBlock = section(el('h3', { text: t('kit.plan.upgradeTitle') }), hint(t('kit.plan.upgradeHint')), offerList);
  const changeButton = button(t('kit.plan.change'), () => openChange());
  const changeBlock = section(hint(t('kit.plan.changeHint')), el('div', { class: 'kit-row' }, changeButton));
  const paymentsBlock = section(hint(t('kit.plan.paymentsHint')),
    el('div', { class: 'kit-row' }, button(t('kit.plan.payments'), (event) => manage(event.currentTarget))));
  const blocks = [pastDueBlock, offerBlock, changeBlock, paymentsBlock];
  for (const node of blocks) node.hidden = true;
  let painting = 0;
  // The server said there is no customer yet: no way to the portal while the section is open.
  let nobodyPaid = false;
  // What "Change or cancel plan" speaks of, from the last paint.
  let last = { answer: null, paid: [], plans: [], productOf: () => null };

  async function manage(target) {
    if (target) target.disabled = true;
    try {
      const { url } = await api.post('/api/billing/portal');
      follow(url);
      // Back from the provider's page through the browser's history, the button works again.
      setTimeout(() => { if (target) target.disabled = false; }, 8000);
      return true;
    } catch (err) {
      if (target) target.disabled = false;
      if (err?.code === 'no_customer') {
        // Nobody has paid yet: there is nothing to manage, so the way goes.
        toast(errorMessage(err));
        nobodyPaid = true;
        paymentsBlock.hidden = true;
      } else fail(err);
      return false;
    }
  }

  /** The dialog of "Change or cancel plan": for each subscription that is paid now, what to do. */
  function openChange() {
    const { answer, paid, plans, productOf } = last;
    const planName = answer?.plan?.name ? t(answer.plan.name) : '';
    const free = plans[0]?.name ? t(plans[0].name) : '';
    const parts = [];
    const actions = [];
    for (const s of paid) {
      const product = productOf(s.product);
      const text = product ? productText(product, plans) : { name: s.plan_name ? t(s.plan_name) : s.product, detail: '' };
      const date = s.period_end ? longDate(s.period_end) : '';
      parts.push(el('p', { text: t('kit.plan.yourSubscription', { product: text.name, detail: text.detail || t('kit.plan.kind.subscription') }) }));
      if (s.kind === 'store') {
        parts.push(el('p', { text: t(`kit.plan.store.${s.store}`, { app: appName }) }));
        if (date) parts.push(hint(t(s.ending ? 'kit.plan.alreadyEnding' : 'kit.plan.storeKeeps', { plan: planName, date })));
        if (s.manage?.url) {
          actions.push({ label: t(`kit.plan.openStore.${s.store}`), primary: true, onClick: () => { openOutside(s.manage.url); } });
        }
      } else if (hideCheckout) {
        parts.push(el('p', { text: t('kit.plan.changeInBrowser', { app: appName }) }));
      } else if (s.ending && date) {
        parts.push(el('p', { text: t('kit.plan.alreadyEnding', { plan: planName, date }) }));
        actions.push({ label: t('kit.plan.openPortal'), primary: true, onClick: () => manage(null) });
      } else {
        parts.push(el('p', { text: t('kit.plan.canTitle') }), el('ul', { class: 'kit-plan__can' },
          el('li', { text: t('kit.plan.can.switch') }),
          date ? el('li', { text: t('kit.plan.can.cancel', { plan: planName, date, free }) }) : null,
          el('li', { text: t('kit.plan.can.method') }),
          el('li', { text: t('kit.plan.can.invoices') })));
        actions.push({ label: t('kit.plan.openPortal'), primary: true, onClick: () => manage(null) });
      }
    }
    openDialog({ title: t('kit.plan.changeTitle'), content: el('div', { class: 'kit-stack' }, ...parts), actions: actions.slice(0, 1) });
  }

  async function upgrade(product, answer, target) {
    target.disabled = true;
    remember(answer);
    try {
      const { url } = await api.post('/api/billing/checkout', { product: product.key });
      follow(url);
      setTimeout(() => { target.disabled = false; }, 8000);
    } catch (err) {
      recall();
      target.disabled = false;
      if (err?.code === 'already_subscribed') {
        // Paid already (in another tab, or the webhook came first): plans change in the portal.
        toast(errorMessage(err), { error: true, action: { label: t('kit.plan.change'), onClick: () => openChange() } });
        refresh();
      } else fail(err);
    }
  }

  /** A product's row: its name, what kind of payment, its price (a founder's beside the regular one struck through). */
  function offerRow(product, offer, answer, plans, primary) {
    const text = productText(product, plans);
    const founder = Boolean(offer.founder && product.founder_price);
    const per = periodOf(product);
    const regular = moneyText(product.amount, product.currency);
    const special = founder ? moneyText(product.founder_amount, product.currency) : '';
    const go = button(t('kit.plan.upgrade'), (event) => upgrade(product, answer, event.currentTarget), primary ? 'primary' : '');
    // Every row's button says "Upgrade": its name for a screen reader says to what, starting the same.
    go.setAttribute('aria-label', t('kit.plan.upgradeTo', { product: text.name, detail: text.detail }));
    const price = regular || special ? el('span', { class: 'kit-plan__price' },
      special && regular ? el('s', { text: regular, 'aria-label': t('kit.plan.regularPrice', { price: regular }) }) : null,
      el('strong', { text: special || regular }),
      per ? el('small', { text: t(`kit.plan.per.${per}`) }) : null) : null;
    const note = founder
      ? [t('kit.plan.founderNote'), offer.founder_until ? t('kit.plan.founderUntil', { date: lastDay(offer.founder_until) }) : ''].filter(Boolean).join(' ')
      : '';
    return el('div', { class: 'kit-list__row' },
      el('span', { class: 'kit-list__text' }, el('strong', { text: text.name }),
        founder ? el('span', { class: 'kit-badge kit-badge--accent', text: t('kit.plan.founder') }) : null,
        el('small', { text: text.detail }),
        note ? el('small', { class: 'kit-plan__note', text: note }) : null),
      price, go);
  }

  async function paint(answer) {
    const turn = ++painting;
    const [offer, owned, overview] = await Promise.all([
      api.get('/api/billing/products').catch(() => null),
      api.get('/api/billing/subscriptions').catch(() => null),
      api.get('/api/billing/overview').catch(() => null),
    ]);
    if (turn !== painting) return undefined;
    // A server without payments (or out of reach): the plan alone, as without the option.
    if (!offer) {
      for (const node of blocks) node.hidden = true;
      clear(status);
      return { holds: false, noted: false };
    }
    const products = Array.isArray(offer.products) ? offer.products : [];
    const plans = answer?.plans || [];
    const productOf = (key) => products.find((p) => p.key === key) || null;
    // Unknown when the server didn't answer: then nothing is offered (offerFor), rather than twice.
    const known = Array.isArray(owned?.subscriptions) ? owned.subscriptions : null;
    const subscriptions = known || [];
    const live = subscriptions.filter(isLive);
    // A subscription now means there is a customer, whatever an earlier answer said.
    if (live.length) nobodyPaid = false;
    // What is paid now for the person, here or in a store: from the overview, or else the web's own.
    const paid = Array.isArray(overview?.sources)
      ? overview.sources.filter((s) => (s.kind === 'web' || s.kind === 'store') && LIVE.has(s.status) && !s.organization_id)
      : live.map((s) => ({ kind: 'web', product: s.product, plan: productOf(s.product)?.plan ?? null, status: s.status, period_end: s.period_end, ending: s.ending ?? null }));
    last = { answer, paid, plans, productOf };

    const said = planStatus(answer, overview || { sources: paid }, { products: offer, benefit });
    clear(status).append(
      ...said.lines.map((line) => el('p', { class: 'kit-plan-card__until', text: line })),
      ...(said.extras.length ? [el('div', { class: 'kit-plan-card__extras' },
        el('span', { class: 'kit-plan-card__label', text: t('kit.plan.extrasTitle') }),
        el('ul', {}, said.extras.map((line) => el('li', { text: line }))))] : []));

    pastDueBlock.hidden = !paid.some((s) => s.status === 'past_due' && s.kind === 'web') || hideCheckout;
    changeBlock.hidden = !paid.length;
    // Without one now: past payments and invoices, for a subscription before or a one-off payment.
    paymentsBlock.hidden = hideCheckout || nobodyPaid || Boolean(paid.length)
      || !(subscriptions.length || products.some((p) => p.kind === 'once'));

    // Someone who pays already, here or in a store, changes the plan there: a second checkout would charge twice.
    const offered = hideCheckout || offer.on_sale === false || paid.length ? [] : offerFor(answer, products, known);
    // A founder's price first: it is the one that won't come back.
    const ordered = offer.founder ? [...offered.filter((p) => p.founder_price), ...offered.filter((p) => !p.founder_price)] : offered;
    clear(offerList).append(...ordered.map((product, i) => offerRow(product, offer, answer, plans, i === 0)));
    offerBlock.hidden = !ordered.length;
    return {
      holds: live.some((s) => productOf(s.product)?.plan === (answer?.plan?.id ?? null)),
      noted: said.lines.length > 0,
    };
  }

  return { blocks, paint, status };
}

/** A store's page, outside the app and this page: a new tab, or the system's browser in the suite's app. */
function openOutside(url) {
  if (!/^https:\/\//i.test(String(url || ''))) return;
  globalThis.open?.(url, '_blank', 'noopener');
}

/* ----------------------- inside the suite's app: its store ---------------------- */

/** The purchase sent to the app and not answered yet: a second one takes its place. */
let pendingPurchase = null;

/**
 * Buying inside the suite's app on a phone (native.js, with its 'purchase'): the app's store sells,
 * never the web's checkout. Sends `purchase` with `product` (a product key, or null for the app's
 * own choice) and waits for the app's `purchase-result`: bought, the plan is read again and goes
 * to `kit-plan` (PLAN_EVENT), which an open Settings repaints with; each outcome is said in a
 * notice. → a promise of the app's answer (`{ product, status }`), or null when nothing was sent
 * (outside the app, or an app that doesn't sell) or another purchase took its place.
 */
export function storePurchase(product = null) {
  pendingPurchase?.(null);
  return new Promise((resolve) => {
    let stop = () => {};
    const finish = (answer) => {
      stop();
      if (pendingPurchase === finish) pendingPurchase = null;
      resolve(answer);
    };
    stop = onNative('purchase-result', async (detail) => {
      finish(detail);
      if (detail.status === 'purchased') {
        toast(t('kit.plan.returned'));
        try {
          const answer = await api.get('/api/me/entitlements');
          const CustomEventOf = globalThis.CustomEvent;
          if (CustomEventOf) globalThis.document?.dispatchEvent?.(new CustomEventOf(PLAN_EVENT, { detail: answer }));
        } catch { /* Settings reads it again when it opens */ }
      } else if (detail.status === 'pending') toast(t('kit.plan.storePending'));
      else if (detail.status === 'canceled') toast(t('kit.plan.canceled'));
      else if (detail.status === 'failed') toast(t('kit.plan.storeFailed'), { error: true });
      // Another status, from a later app: nothing said.
    });
    pendingPurchase = finish;
    if (!nativePurchase(product)) finish(null);
  });
}

/* --------------------------- anywhere in an app --------------------------- */

/** A plan's barrier: 402 (`plan_feature`, `plan_limit`, a group's `seats_full`, an app's own). */
export const isPlanError = (err) => err?.status === 402;

/**
 * A 402 met anywhere in an app: a notice that says why, in the person's language, with a button
 * that opens the plan (`open`: Settings at its plan section, or a native app's own way to buy).
 * → true when it was one, so the app's own handling stays for everything else.
 */
export function offerPlan(err, { open = null } = {}) {
  if (!isPlanError(err)) return false;
  toast(errorMessage(err), { error: true, action: open ? { label: t('kit.plan.see'), onClick: open } : null });
  return true;
}

/**
 * Back from the provider's checkout: billing.js sends the person to `/?billing=done`. Called once
 * at the start, it takes the mark out of the address, thanks them (with a button to the plan when
 * there is `open`) and asks for the plan again until it changes, because the provider's webhook
 * may arrive after them. Each answer read goes to `onPlan` and to `kit-plan` on the document,
 * which an open Settings repaints with. Whoever leaves the checkout unpaid, sent back to
 * `/?billing=canceled` by a provider that has a cancel address, gets the same tidy address and a
 * plain word that nothing was charged, and the plan isn't read again. → false when this was no such return;
 * otherwise a promise of the plan that arrived (null when it hadn't changed by the last look, and
 * after a canceled checkout).
 */
export function billingReturn({ onPlan = null, open = null, waits = RETURN_WAITS, wait = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  let url;
  try { url = new URL(globalThis.location.href); } catch { return false; }
  const outcome = url.searchParams.get('billing');
  if (outcome !== 'done' && outcome !== 'canceled') return false;
  url.searchParams.delete('billing');
  // Not again on a reload or a shared link.
  globalThis.history?.replaceState?.(globalThis.history.state, '', url.pathname + url.search + url.hash);
  const before = recall();
  const seePlans = open ? { action: { label: t('kit.plan.see'), onClick: open } } : {};
  if (outcome === 'canceled') {
    toast(t('kit.plan.canceled'), seePlans);
    return Promise.resolve(null);
  }
  toast(t('kit.plan.returned'), seePlans);

  const tell = (answer) => {
    onPlan?.(answer);
    const CustomEventOf = globalThis.CustomEvent;
    if (CustomEventOf) globalThis.document?.dispatchEvent?.(new CustomEventOf(PLAN_EVENT, { detail: answer }));
  };

  return (async () => {
    let last = before;
    let told = false;
    for (const ms of waits) {
      await wait(ms);
      let answer;
      try { answer = await api.get('/api/me/entitlements'); } catch { continue; }
      const now = mark(answer);
      const changed = last !== null && now !== last;
      if (!told || changed) tell(answer);
      told = true;
      if (changed) {
        const name = answer.plan?.name ? t(answer.plan.name) : '';
        let was = null;
        try { [was] = JSON.parse(last); } catch { /* kept by another version of the page: only "updated" */ }
        toast(name && answer.plan?.id !== was ? t('kit.plan.nowOn', { plan: name }) : t('kit.plan.updated'));
        return answer;
      }
      if (last === null) last = now;
    }
    // Said only when the plan from before is known: otherwise it may have come before the first look.
    if (before !== null) toast(t('kit.plan.notYet'));
    return null;
  })();
}
