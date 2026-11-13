/**
 * What a page's start needs of the plan (plan.js), without the rest of it: the way back from the
 * payment provider's checkout (`billingReturn`) and the last day of an offer (`lastDay`, the
 * founder's notice under the header). The kit's frame (shell.js) starts with these, and plan.js,
 * Settings' plan section, comes only with Settings (audit of 6/11, perf-web-4): a module mounted
 * in Cronum Work evaluated it whole for two functions, and in a window never ran the first.
 * plan.js names all of it as before.
 */
import { t, formatDateTime } from './i18n.js';
import { api } from './api.js';
import { toast } from './ui.js';

/** What `billingReturn` tells the page each time it reads the plan again: an open Settings repaints. */
export const PLAN_EVENT = 'kit-plan';

/** After the checkout the provider's webhook may come a moment after the person: asked again meanwhile. */
const RETURN_WAITS = Object.freeze([0, 1500, 3000, 5000, 10000]);

/**
 * Where the browser keeps the plan from before a checkout, to tell when the new one arrives (plan.js
 * remembers it): one key for the whole origin, since in a host the checkout starts in a module's
 * window (`tasks`) and comes back to the host's shell (`work`), which must read it (audit
 * billing-8). An app on its own has its origin to itself. The key named after the page's app, as
 * before, is still read once: a checkout begun before this version.
 */
export const storageKey = () => 'host.billing';
const oldStorageKey = () => `${globalThis.document?.documentElement?.dataset?.app || 'app'}.billing`;
export const mark = (answer) => JSON.stringify([answer?.plan?.id ?? answer?.plan ?? null, answer?.ends ?? null]);

/** The plan kept before a checkout, taken. */
export function recall() {
  try {
    const kept = sessionStorage.getItem(storageKey()) ?? sessionStorage.getItem(oldStorageKey());
    sessionStorage.removeItem(storageKey());
    sessionStorage.removeItem(oldStorageKey());
    return kept;
  } catch { return null; }
}

/**
 * The last day of something that ends at `iso` (the moment it no longer holds, as the server's
 * dates are: FOUNDER_OFFER_UNTIL=2027-02-01 is its first day without), in the server's calendar.
 * With `year: false`, only its day and month.
 */
export const lastDay = (iso, { year = true } = {}) => {
  const at = Date.parse(iso);
  const format = year ? { dateStyle: 'long' } : { day: 'numeric', month: 'long' };
  return Number.isNaN(at) ? '' : formatDateTime(new Date(at - 1).toISOString(), { ...format, timeZone: 'UTC' });
};

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
