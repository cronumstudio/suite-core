/**
 * The plan and its payments in the browser, the same in every app: what Settings' plan section
 * adds when the app sells (`planPayments`, drawn by settings.js), the call to action of a plan's
 * barrier anywhere in an app (`offerPlan`), and the way back from the payment provider's checkout
 * (`billingReturn`). On the suite's routes (billing.js): /api/me/entitlements,
 * /api/billing/products, /api/billing/subscriptions, /api/billing/checkout and
 * /api/billing/portal. Nothing here names a product or an app: what is sold, and its names, come
 * from the server.
 *
 *   openSettings({ …, plan: { billing: true } });                       // products, Upgrade, Manage
 *   openSettings({ …, plan: { billing: true, hideCheckout: true } });   // a native app's web view
 *   billingReturn({ onPlan: refresh, open: () => openPlan() });         // once, at the start
 *   catch (err) { if (!offerPlan(err, { open: () => openPlan() })) fail(err); }
 *   storePurchase();                                                     // inside the suite's app: its store
 *
 * The browser only names a product: the price, a founder's included, is the server's to choose,
 * and the provider's page shows it.
 */
import { el, clear } from './dom.js';
import { t, formatDateTime } from './i18n.js';
import { api, errorMessage } from './api.js';
import { toast } from './ui.js';
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
const fact = (label, value, detail = '') => el('div', { class: 'kit-fact' },
  el('span', { text: label }), el('strong', { text: value }), detail ? el('small', { text: detail }) : null);

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

/**
 * The blocks Settings' plan section adds when the app sells (`plan.billing`), under the plan and
 * until when: the subscriptions that hold a plan with "Manage subscription" (the provider's
 * portal), what can be bought with "Upgrade" (its checkout), and last, quietly, the way to past
 * payments and invoices for whoever has no subscription now. With `hideCheckout` (a native app's
 * web view, where the stores' rules keep a web payment's links out) only what is paid for shows:
 * no products, no Upgrade, no way to the provider.
 *
 * `paint(answer)` draws them for /api/me/entitlements' answer; `blocks` go in the section. It
 * resolves to `{ holds }`, whether a live subscription holds the plan shown (its "Until" is then
 * the period's end and a few days of grace, which the subscription says better), or to nothing
 * when a later paint took its place.
 */
export function planPayments({ hideCheckout = false, fail = (err) => toast(errorMessage(err), { error: true }), refresh = () => {} } = {}) {
  const facts = el('div', { class: 'kit-facts' });
  const pastDue = hint(t('kit.plan.pastDue'));
  const manageArea = el('div', { class: 'kit-stack' }, hint(t('kit.plan.manageHint')),
    el('div', { class: 'kit-row' }, button(t('kit.plan.manage'), (event) => manage(event.currentTarget), 'primary')));
  const subscriptionBlock = section(el('h3', { text: t('kit.plan.subscriptionTitle') }), facts, pastDue, manageArea);
  const offerList = el('div', { class: 'kit-list kit-plan__offer' });
  const offerBlock = section(el('h3', { text: t('kit.plan.upgradeTitle') }), hint(t('kit.plan.upgradeHint')), offerList);
  const paymentsBlock = section(hint(t('kit.plan.paymentsHint')),
    el('div', { class: 'kit-row' }, button(t('kit.plan.payments'), (event) => manage(event.currentTarget))));
  const blocks = [subscriptionBlock, offerBlock, paymentsBlock];
  for (const node of blocks) node.hidden = true;
  let painting = 0;
  // The server said there is no customer yet: no way to the portal while the section is open.
  let nobodyPaid = false;

  async function manage(target) {
    if (target) target.disabled = true;
    try {
      const { url } = await api.post('/api/billing/portal');
      follow(url);
      // Back from the provider's page through the browser's history, the button works again.
      setTimeout(() => { if (target) target.disabled = false; }, 8000);
    } catch (err) {
      if (target) target.disabled = false;
      if (err?.code === 'no_customer') {
        // Nobody has paid yet: there is nothing to manage, so the button goes.
        toast(errorMessage(err));
        nobodyPaid = true;
        manageArea.hidden = true;
        paymentsBlock.hidden = true;
      } else fail(err);
    }
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
        toast(errorMessage(err), { error: true, action: { label: t('kit.plan.manage'), onClick: () => manage(null) } });
        refresh();
      } else fail(err);
    }
  }

  async function paint(answer) {
    const turn = ++painting;
    const [offer, owned] = await Promise.all([
      api.get('/api/billing/products').catch(() => null),
      api.get('/api/billing/subscriptions').catch(() => null),
    ]);
    if (turn !== painting) return undefined;
    // A server without payments (or out of reach): the plan alone, as without the option.
    if (!offer) {
      for (const node of blocks) node.hidden = true;
      return { holds: false };
    }
    const products = Array.isArray(offer.products) ? offer.products : [];
    const plans = answer?.plans || [];
    const productOf = (key) => products.find((p) => p.key === key) || null;
    const nameOf = (key) => {
      const product = productOf(key);
      return product ? productText(product, plans).name : key;
    };
    // Unknown when the server didn't answer: then nothing is offered (offerFor), rather than twice.
    const known = Array.isArray(owned?.subscriptions) ? owned.subscriptions : null;
    const subscriptions = known || [];
    const live = subscriptions.filter(isLive);
    // A subscription now means there is a customer, whatever an earlier answer said.
    if (live.length) nobodyPaid = false;

    clear(facts).append(...live.map((s) => fact(nameOf(s.product), t(`kit.plan.status.${s.status}`),
      s.period_end ? t('kit.plan.periodEnd', { date: formatDateTime(s.period_end, { dateStyle: 'long' }) }) : '')));
    subscriptionBlock.hidden = !live.length;
    pastDue.hidden = hideCheckout || !live.some((s) => s.status === 'past_due');
    manageArea.hidden = hideCheckout || nobodyPaid;
    // Without one now: past payments and invoices, for a subscription before or a one-off payment.
    paymentsBlock.hidden = hideCheckout || nobodyPaid || Boolean(live.length)
      || !(subscriptions.length || products.some((p) => p.kind === 'once'));

    // Someone who pays already changes the plan in the portal: a second checkout would charge twice.
    const offered = hideCheckout ? [] : offerFor(answer, products, known);
    clear(offerList).append(...offered.map((product, i) => {
      const text = productText(product, plans);
      const go = button(t('kit.plan.upgrade'), (event) => upgrade(product, answer, event.currentTarget), i === 0 ? 'primary' : '');
      // Every row's button says "Upgrade": its name for a screen reader says to what, starting the same.
      go.setAttribute('aria-label', t('kit.plan.upgradeTo', { product: text.name, detail: text.detail }));
      // The founder's price beside the name, so the button keeps its place at the row's end.
      return el('div', { class: 'kit-list__row' },
        el('span', { class: 'kit-list__text' }, el('strong', { text: text.name }),
          offer.founder && product.founder_price ? el('span', { class: 'kit-badge kit-badge--accent', text: t('kit.plan.founder') }) : null,
          el('small', { text: text.detail })),
        go);
    }));
    offerBlock.hidden = !offered.length;
    return { holds: live.some((s) => productOf(s.product)?.plan === (answer?.plan?.id ?? null)) };
  }

  return { blocks, paint };
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
