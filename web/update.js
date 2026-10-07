/**
 * The notice of a new version. An app installed on the home screen has no
 * reload button, so it asks the server now and then whether the code it
 * serves is still the code this tab runs, and says so when it isn't.
 *
 * The version is a fingerprint of the front-end files the server works out
 * (`/version`); the tab's own comes in `/js/app-version.js`, which travels
 * with the code: an old cached copy of the app brings an old copy of that
 * too, so it really tells whether the latest is running.
 *
 * Lessons from Tasks (update-check.js, 1.34.1): the notice is a banner that
 * stays until the person updates or closes it, and comes back on the next
 * check —a toast went by unseen and the app stayed for days on old code
 * talking to a new server—; and updating waits for the new service worker to
 * take control before reloading, or the old one serves the old code again.
 *
 *   const updates = watchUpdates({ onUpdate: () => shell.showBanner('update', {…, action: { onClick: applyUpdate } }) });
 */

import { el } from './dom.js';
import { t } from './i18n.js';

const CHECK_EVERY = 10 * 60 * 1000;
const HANDOVER_MS = 3000;

/**
 * @param {object} options
 * @param {Function} options.onUpdate     (server) → show the notice
 * @param {Function} [options.fetch]      for tests
 * @param {Function} [options.loadLocal]  () → { version } of this tab; default: import('/js/app-version.js')
 * @param {number}   [options.every]
 * @returns {{ check: (opts?) => Promise<boolean|null>, stop: () => void, dismiss: () => void, loaded: () => object }}
 */
export function watchUpdates({
  onUpdate, fetch: get = (...args) => globalThis.fetch(...args), every = CHECK_EVERY,
  loadLocal = async () => {
    const mod = await import('/js/app-version.js');
    return { app: mod.APP_NAME_VERSION, version: mod.APP_VERSION, built: mod.APP_BUILT };
  },
  timers = globalThis, doc = globalThis.document, now = Date.now,
}) {
  let loaded = null;
  // Closed by the person: quiet until the next round of checks, then shown again if still new.
  let quietUntil = 0;

  async function local() {
    if (loaded) return loaded;
    try {
      loaded = await loadLocal();
    } catch {
      // A server older than the generated module: its own version at start-up
      // at least tells successive checks apart.
      try { loaded = await server(); } catch { /* offline: nothing to compare yet */ }
    }
    return loaded;
  }

  async function server() {
    const res = await get('/version', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Asks now. → true when there is a new version, false when this is the
   * latest, null when the server couldn't be asked. `announce` shows the
   * notice even if it was closed (a "Check" button in Settings).
   */
  async function check({ announce = false } = {}) {
    const mine = await local();
    let theirs;
    try { theirs = await server(); } catch { return null; }
    if (!mine?.version) return null;
    const isNew = theirs.version !== mine.version;
    if (isNew && (announce || now() >= quietUntil)) onUpdate?.(theirs, mine);
    return isNew;
  }

  const timer = timers.setInterval(() => { check().catch(() => {}); }, every);
  // Coming back to the app is the natural moment to look.
  const onVisible = () => { if (doc?.visibilityState === 'visible') check().catch(() => {}); };
  doc?.addEventListener?.('visibilitychange', onVisible);
  check().catch(() => {});

  return {
    check,
    loaded: () => loaded,
    dismiss: () => { quietUntil = now() + every; },
    stop: () => {
      timers.clearInterval(timer);
      doc?.removeEventListener?.('visibilitychange', onVisible);
    },
  };
}

let updating = null;

/**
 * Brings the new code in: the new service worker first (waiting for it to
 * take control, three seconds at most), then a reload that skips any cache
 * in between. The caches aren't wiped here: the new worker drops the old
 * ones when it takes over, and wiping them took the page itself away, and
 * with it opening offline until the next version.
 *
 * That takes a few seconds, so the button pressed (the click's
 * `currentTarget`) says at once that it is updating, and pressing again
 * doesn't start it over: a button that didn't change was pressed two or
 * three times more.
 *
 * @param {Event} [event]  the click, to mark its button
 * @returns {Promise<void>} the same one while an update is under way
 */
export function applyUpdate(event) {
  const button = event?.currentTarget;
  if (button?.setAttribute) showBusy(button);
  updating ??= bringNewCode();
  return updating;
}

function showBusy(button) {
  button.setAttribute('aria-busy', 'true');
  button.setAttribute('aria-disabled', 'true');
  button.textContent = '';
  button.append(el('span', { class: 'kit-spinner', 'aria-hidden': 'true' }), t('kit.update.applying'));
}

async function bringNewCode() {
  try {
    const sw = navigator.serviceWorker;
    if (sw) {
      const registrations = await sw.getRegistrations();
      const handover = new Promise((done) => {
        sw.addEventListener('controllerchange', done, { once: true });
        setTimeout(done, HANDOVER_MS);
      });
      await Promise.all(registrations.map((r) => r.update().catch(() => {})));
      if (registrations.some((r) => r.installing || r.waiting)) await handover;
    }
  } catch { /* a plain reload is usually enough */ }
  const url = new URL(window.location.href);
  url.searchParams.set('fresh', String(Date.now()));
  window.location.replace(url.pathname + url.search + url.hash);
}

/** Takes away the `fresh` parameter applyUpdate() left in the address. */
export function tidyAddress() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('fresh')) return;
  url.searchParams.delete('fresh');
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
}
