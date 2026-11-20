/**
 * The sign-in screen of every app: the product's colour large, the form
 * beside it (stacked on a phone), and "by Cronum Studio" under it. Taken from
 * Next's, on the suite's routes:
 *
 * - local accounts: username and password, then the code of an authenticator
 *   app when the account has a second step; a forgotten password (when the
 *   install sends mail), the link's new password (/?reset=…), an invitation's
 *   sign-up (/?signup=…) or open sign-up where the install allows it;
 * - WorkOS or OpenID Connect: the provider's page, at once when there is
 *   nothing to say first (`straightToProvider`), else from a button;
 * - an account its owner asked to delete, signed in to before it goes: the
 *   offer to take it back (`deletion_pending` from the password, or
 *   `/?account_deletion=…` from the provider's page).
 *
 *   const user = await signIn({ app: { name: 'Notes', icon: '/icons/favicon.svg', tagline: tagline } });
 *
 * Resolves with the signed-in user once someone gets through; the screen is
 * removed then.
 *
 * The screen itself is signin-form.js, loaded when it is drawn: a page with a session, every
 * module mounted in Cronum Work, never draws it, and evaluated it whole on every start (audit of
 * 6/11, perf-web-4). What signing out needs, and confirming an email, stay here.
 */
import { t } from './i18n.js';
import { api, errorMessage, Offline, SessionExpired } from './api.js';
import { FRAMED } from './base.js';
import { toast, confirmDialog } from './ui.js';
import { inApp, nativeSignOut } from './native.js';
import { workRegistry } from './mount.js';
import { forgetSettings, queuedSettings } from './settings-queue.js';

const param = (name) => new URLSearchParams(window.location.search).get(name);
function dropParam(name) {
  const url = new URL(window.location.href);
  url.searchParams.delete(name);
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
}

const SIGNED_OUT = 'suite.signedOut';
const STRAIGHT = 'suite.signInStraight';

/**
 * Whether the provider's sign-in can open at once, without this site's card and its button first
 * (Martin, 5/11: a card of the app, then the provider's page of another colour, read as one
 * redirection too many). Not in a frame (the host's split view signs the whole window in), not
 * inside the suite's app (its button hands off to the phone's browser), not just after signing out
 * here (`leave` leaves a mark: whoever left sees the card, not the provider's page), and not twice
 * in a minute in this tab, so a session that never takes (cookies blocked) or Back from the
 * provider's page ends on the card instead of going round in circles. Without sessionStorage
 * (private mode), the card, as before.
 */
export function straightToProvider({ storage = null, now = Date.now(), framed = FRAMED, app = inApp() } = {}) {
  if (framed || app) return false;
  try {
    // Read here and not as the default: with the site's data blocked, merely naming sessionStorage
    // throws (SecurityError), and the card must stay as before rather than signIn() failing (audit sc-auth-5).
    const box = storage ?? globalThis.sessionStorage;
    if (box.getItem(SIGNED_OUT)) {
      box.removeItem(SIGNED_OUT);
      return false;
    }
    if (now - (Number(box.getItem(STRAIGHT)) || 0) < 60_000) return false;
    box.setItem(STRAIGHT, String(now));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} options
 * @param {object} options.app        { name, icon, tagline }
 * @param {object} [options.config]   /api/auth/config, when the page already has it
 * @param {Node}   [options.root]
 * @returns {Promise<object>} the user
 */
export async function signIn(options) {
  const form = await import('./signin-form.js');
  return form.signIn(options);
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

/**
 * What every app of the site keeps on this device (local.js names each `<app>-local`), gone. In a
 * host the modules share one origin and one session: each one draws itself from its copy before the
 * server answers, so signing out in one of them, or on the host's home, must not leave another
 * module's copy for whoever signs in next. Never waits more than `wait` ms: a tab holding a
 * database lets go of it (local.js closes on `versionchange`), and one that doesn't is not waited for.
 */
export async function clearDeviceCopies({ indexedDB: idb = globalThis.indexedDB, wait = 1500 } = {}) {
  if (!idb?.databases) return [];
  let names = [];
  try { names = (await idb.databases()).map((d) => d.name).filter((n) => typeof n === 'string' && n.endsWith('-local')); } catch { return []; }
  const gone = (name) => new Promise((resolve) => {
    const req = idb.deleteDatabase(name);
    req.onsuccess = req.onerror = () => resolve(name);
  });
  await Promise.race([Promise.all(names.map(gone)), new Promise((r) => setTimeout(r, wait))]);
  return names;
}

/**
 * How many changes made here wait to be sent: every app's queue on this device (the `outbox` of each
 * `<app>-local`, outbox.js), the modules not open too, and the preferences kept (settings-queue.js).
 * Signing out deletes all of it (`leave`), so it is asked first. Only counted: a database is opened
 * as it is (no version, so nothing is created or upgraded) and closed at once. Never waits more than
 * `wait` ms for one.
 */
export async function pendingChanges({ indexedDB: idb = globalThis.indexedDB, wait = 1500 } = {}) {
  const settings = queuedSettings().length;
  if (!idb?.databases) return settings;
  let names = [];
  try { names = (await idb.databases()).map((d) => d.name).filter((n) => typeof n === 'string' && n.endsWith('-local')); } catch { return settings; }
  const counted = (name) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(0), wait);
    const done = (n) => { clearTimeout(timer); resolve(Number(n) || 0); };
    let req;
    try { req = idb.open(name); } catch { done(0); return; }
    req.onerror = req.onblocked = () => done(0);
    req.onsuccess = () => {
      const db = req.result;
      const close = (n) => { try { db.close(); } catch { /* gone already */ } done(n); };
      try {
        if (!db.objectStoreNames.contains('outbox')) { close(0); return; }
        const count = db.transaction('outbox', 'readonly').objectStore('outbox').count();
        count.onsuccess = () => close(count.result);
        count.onerror = () => close(0);
      } catch { close(0); }
    };
  });
  const counts = await Promise.all(names.map(counted));
  return counts.reduce((sum, n) => sum + n, settings);
}

/**
 * Where this browser's notices come to: the subscription of each of the site's workers (the host's,
 * and a module's not yet retired, worker.js), for the server to forget with the session. The
 * subscription itself stays: a device's own notices may share it (push.js). Inside the suite's app
 * there is no Web Push. Never waits more than `wait` ms.
 */
export async function pushEndpoints({ serviceWorker = globalThis.navigator?.serviceWorker, wait = 1500 } = {}) {
  if (!serviceWorker?.getRegistrations || inApp()) return [];
  const read = async () => {
    const registrations = await serviceWorker.getRegistrations();
    const subscriptions = await Promise.all(registrations.map((r) => r.pushManager?.getSubscription().catch(() => null)));
    return [...new Set(subscriptions.map((s) => s?.endpoint).filter((e) => typeof e === 'string' && e))];
  };
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve([]), wait); });
  try { return await Promise.race([read(), late]); } catch { return []; } finally { clearTimeout(timer); }
}

/**
 * Leaving this device, signed out or with the account deleted (Settings): what every app of the site
 * keeps here gone (`local`, the module's, and every `<app>-local`), the suite's app told, then the
 * provider's sign-out (`answer.logout_url`) or this site's sign-in again. Inside the suite's app on a
 * phone, never the provider's page: it is another site, which the app would open in the phone's
 * browser or race with its own sign-in.
 */
export async function leave({ answer = null, local = null } = {}) {
  await local?.clearAll?.().catch(() => {});
  await clearDeviceCopies().catch(() => {});
  // Preferences changed without a signal and not sent yet are this account's, not the next person's.
  forgetSettings();
  // Inside the suite's app on a phone, the app lets go of its device too (native.js); nothing elsewhere.
  // Sent before the page goes anywhere, so the app hears it from this page.
  nativeSignOut();
  // Back on this site, the card and not the provider's page at once (straightToProvider).
  try { sessionStorage.setItem(SIGNED_OUT, '1'); } catch { /* private mode */ }
  // From a frame of the host's split view the whole window signs out, not the frame alone.
  const page = FRAMED ? window.top : window;
  if (answer?.logout_url && !inApp()) page.location.href = answer.logout_url;
  else page.location.reload();
}

/**
 * Signing out, from wherever it is asked. Cronum Work's one-document shell has one way out for all
 * its modules (the registry's `signOut`): each window saves first, every module's queue is counted,
 * and what the shell keeps goes with the rest. A module's Settings used to sign out on its own and
 * delete the others' queues without a word (audit of 6/11, work-web-1). `local` and `before` are
 * the module's, and `before` still runs only once the server has heard. A module in a frame of the
 * shell goes the same way; on any other page, `signOutHere`.
 */
export function signOut(options = {}) {
  const leaveShell = shellRegistry()?.signOut;
  return leaveShell ? leaveShell(options) : signOutHere(options);
}

function shellRegistry() {
  try {
    return workRegistry() || (FRAMED ? workRegistry(window.top.document) : null);
  } catch {
    return null;
  }
}

/**
 * Signs out here (and at the provider, which then comes back to the app), with this browser's
 * notices: the server forgets where they come to, so whoever uses it next doesn't get them.
 *
 * `ask`: true (or `(n) → Promise<boolean>`) asks first when changes wait to be sent anywhere on this
 * device (`pendingChanges`), since leaving deletes them; no keeps everything as it is. Without a
 * signal, or with the server in trouble, the session still counts there: nothing here is deleted
 * and the page stays, with a word why (it used to delete it all and stay signed in at the server).
 * A session that had already ended lets go of the device as always. `before`: what the app does
 * once the server has heard, before the device lets go (its own copies, its live channel).
 * `forgetPush`: the browser's push subscription goes too (a host's, where nobody shares it).
 * → true when it left, false when it stayed.
 */
export async function signOutHere({ local = null, ask = false, before = null, forgetPush = false } = {}) {
  if (ask) {
    const waiting = await pendingChanges().catch(() => 0);
    const confirm = typeof ask === 'function' ? ask : (n) => confirmDialog(t('kit.account.unsent', { n }), {
      danger: true, confirm: t('kit.account.signOutAnyway'), detail: t('kit.account.unsentDetail'),
    });
    if (waiting && !await confirm(waiting)) return false;
  }
  const endpoints = await pushEndpoints();
  let answer = null;
  try {
    answer = await api.post('/api/auth/logout', endpoints.length ? { push_endpoints: endpoints } : {});
  } catch (err) {
    if (!(err instanceof SessionExpired)) {
      toast(err instanceof Offline ? t('kit.account.signOutOffline') : errorMessage(err), { error: true });
      return false;
    }
  }
  await before?.();
  // In a host nobody else shares the browser's subscription: let go, so nothing here says this
  // device still gets notices the server no longer sends (pwa-3). The same person signing in again
  // gets them back without a tap (settings.js renewNotices).
  if (forgetPush) await letGoOfPush().catch(() => {});
  await leave({ answer, local });
  return true;
}

/** Every one of the site's workers lets go of its push subscription; never more than `wait` ms. */
async function letGoOfPush({ serviceWorker = globalThis.navigator?.serviceWorker, wait = 1500 } = {}) {
  if (!serviceWorker?.getRegistrations || inApp()) return;
  const all = async () => {
    for (const registration of await serviceWorker.getRegistrations()) {
      await (await registration.pushManager?.getSubscription().catch(() => null))?.unsubscribe().catch(() => {});
    }
  };
  let timer;
  await Promise.race([all(), new Promise((resolve) => { timer = setTimeout(resolve, wait); })]).finally(() => clearTimeout(timer));
}
