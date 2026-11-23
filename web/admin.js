/**
 * The admin panel of every app of the suite, at /admin: accounts, their plans
 * and grants, invitations, the plan catalog, groups, copies of the data and
 * the audit log, drawn on /api/admin/*. The server decides who may do what;
 * this page only shows what it answers, and says what it refuses.
 */
import { $, el, clear, append } from './dom.js';
import { api, errorMessage, SessionExpired } from './api.js';
import { t, loadLanguage, pickLanguage, formatDateTime, formatDate, listFormat, numberFormat } from './i18n.js';
import { toast, field, openDialog, formDialog, confirmDialog, slidingDetails, saveState, QUESTION_WIDTH, revealable, segmented, menu } from './ui.js';
import { icon } from './icons.js';
import { usageGroups, meter, percent, peakWhat, levelOf } from './usage-view.js';
import { dayKey } from './days.js';

const root = $('#admin');
// `usersQuery`: what Accounts was searched for, kept while the list is drawn again (an account saved).
const state = {
  config: null, me: null, catalog: null, organizations: false, invitations: false, data: false, notices: false, affiliates: false,
  affiliateMinimum: null, usersQuery: '',
};

const TABS = [
  ['users', 'admin.tabs.users'],
  ['invitations', 'admin.tabs.invitations'],
  ['plans', 'admin.tabs.plans'],
  ['organizations', 'admin.tabs.organizations'],
  ['data', 'admin.tabs.data'],
  ['notices', 'admin.tabs.notices'],
  ['affiliates', 'admin.tabs.affiliates'],
  ['audit', 'admin.tabs.audit'],
];

/* --------------------------------- helpers --------------------------------- */

const local = () => state.config?.provider === 'local';
const workos = () => state.config?.provider === 'workos';
const planName = (id) => {
  const plan = state.catalog?.plans.find((p) => p.id === id);
  return plan ? t(plan.name) : id;
};
/**
 * A feature in words: the app's text for it (features.<key>) when it has one, else its label.
 * `features` is the catalog it is in: the host's, or a module's (Plans).
 */
const featureLabel = (key, features = state.catalog?.features) => {
  const text = t(`features.${key}`);
  return text === `features.${key}` ? features?.[key]?.label || key : text;
};
const valueText = (key, value, features = state.catalog?.features) => {
  const type = features?.[key]?.type;
  if (type === 'flag') return value ? t('admin.plans.yes') : t('admin.plans.no');
  return value == null ? t('admin.plans.noLimit') : String(value);
};
/** An action of the log in words, or as it is when there are none for it. */
const actionText = (action) => {
  const key = `admin.actions.${String(action).replace(/\./g, '_')}`;
  const text = t(key);
  return text === key ? action : text;
};
/** A payment provider by the name people know it by (a grant's source). */
const providerName = (source) => ({
  stripe: 'Stripe', paddle: 'Paddle',
  'paddle-sandbox': t('admin.users.providerSandbox', { provider: 'Paddle' }), revenuecat: t('admin.users.providerStores'),
}[source] || source);
/**
 * An account's plan and where it comes from: the default plan says so, never passing for one that
 * was given; a gift says until when (or for good) and why; a subscription, where it is paid.
 */
const planParts = (user) => {
  if (user.unlimited) return [el('span', { text: t('admin.users.unlimited') })];
  const name = user.plan ? t(user.plan.name || user.plan.id) : '';
  const source = user.plan_source;
  if (source?.kind === 'default') return [el('span', { text: t('admin.users.byDefault', { plan: name }) })];
  const until = user.plan_ends ? t('admin.users.until', { date: formatDate(user.plan_ends) }) : null;
  if (!source) return [el('span', { text: name }), until ? el('small', { text: until }) : null];
  const from = [
    source.kind === 'subscription' ? t('admin.users.viaProvider', { provider: providerName(source.provider) }) : null,
    source.organization_id ? t('admin.users.viaGroup') : null,
    until || t('admin.users.forever'),
  ].filter(Boolean).join(' · ');
  return [el('span', { text: name }), el('small', { text: from }),
    source.kind === 'admin' && source.note ? el('small', { text: source.note }) : null];
};
/** A date input's day as the end of that day, in ISO. */
const endOfDay = (day) => (day ? new Date(`${day}T23:59:59`).toISOString() : null);
/** Text as a search compares it: no capitals, no accents ("José" is found as "jose"). */
const folded = (text) => String(text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** What a search finds an account by: its email, its username and its name. */
const accountText = (user) => folded([user.email, user.username, user.display_name].join(' '));
/** Whether every word of a search is in a text that `folded` made. */
const hasWords = (text, query) => folded(query).split(/\s+/).filter(Boolean).every((word) => text.includes(word));
/** The filters a tab's address carries after its name (`#/audit?actor=12`): what a link opens it with. */
const hashQuery = () => new URLSearchParams(window.location.hash.split('?')[1] || '');

function fail(err) {
  if (err instanceof SessionExpired) {
    notice(t('admin.signInFirst'));
    return;
  }
  toast(errorMessage(err), { error: true });
}

/** A whole-page message instead of the panel (not signed in, not an admin). */
function notice(text) {
  clear(root);
  const name = state.config?.app?.name || '';
  root.append(el('main', { class: 'kit-main' },
    el('div', { class: 'kit-notice' },
      el('p', { text }),
      el('a', { class: 'kit-btn kit-btn--primary', href: '/', text: t('admin.backTo', { app: name }) }))));
}

function table(headers, rows) {
  return el('div', { class: 'kit-table-wrap' },
    el('table', { class: 'kit-table' },
      el('thead', {}, el('tr', {}, headers.map((h) => el('th', { text: h })))),
      el('tbody', {}, rows)));
}

function applyTheme(theme) {
  const dark = theme === 'dark' || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

/* ---------------------------------- shell ---------------------------------- */

async function start() {
  try {
    state.config = await api.get('/api/auth/config');
    state.me = (await api.get('/api/auth/me')).user;
  } catch {
    // Without the server there are no texts either.
    root.append(el('p', { class: 'kit-main', text: 'The server does not answer. Try again in a moment.' })); // i18n-exempt
    return;
  }
  const me = state.me;
  let prefs = {};
  try { prefs = typeof me?.prefs === 'string' ? JSON.parse(me.prefs) : (me?.prefs || {}); } catch { /* none */ }
  const languages = state.config.app?.languages || ['en'];
  // The admin panel follows the account; the choice the app keeps in this browser is the app's to make.
  await loadLanguage(pickLanguage([me?.locale, prefs.lang, navigator.languages || [], navigator.language], languages), { remember: false, all: true })
    .catch(() => {});
  applyTheme(me?.theme);
  document.title = `${t('admin.title')} · ${state.config.app?.name || ''}`;
  if (!me) return notice(t('admin.signInFirst'));
  if (me.role !== 'admin') return notice(t('admin.onlyAdmins'));

  // What this install has: plans always; groups when their module is on;
  // invitations when passwords are the app's own.
  state.catalog = await api.get('/api/admin/plans').catch(() => null);
  state.organizations = Boolean(state.config.app?.modules?.organizations);
  state.invitations = local();
  // Copies of the data, when the app says what its data is.
  state.data = Boolean(state.config.app?.modules?.data);
  // Notices of new accounts and payments, with modules.notices.
  state.notices = Boolean(state.config.app?.modules?.notices);
  // Referrals and creators' campaigns, with payments (affiliates.js): whether the program is on or not.
  state.affiliates = Boolean(state.config.app?.modules?.affiliates);

  const app = state.config.app || {};
  // The app's icon, as the server wrote it into the page (app.icon).
  const icon = document.querySelector('link[rel="icon"]')?.getAttribute('href');
  clear(root).append(
    el('header', { class: 'kit-header' },
      icon ? el('img', { class: 'kit-header__icon', src: icon, alt: '', width: 40, height: 40 }) : null,
      el('div', {},
        el('div', { class: 'kit-header__app', text: app.name }),
        el('h1', { text: t('admin.title') })),
      el('span', { class: 'kit-header__spacer' }),
      el('span', { class: 'kit-header__user kit-hide-narrow', text: t('admin.signedInAs', { name: me.display_name || me.username }) }),
      el('a', { class: 'kit-btn kit-btn--small', href: '/', text: t('admin.backTo', { app: app.name }) })),
    el('nav', { class: 'kit-tabs', 'aria-label': t('admin.title') },
      visibleTabs().map(([id, key]) => el('a', { class: 'kit-tab', href: `#/${id}`, 'data-tab': id, text: t(key) }))),
    el('main', { class: 'kit-main', id: 'admin-main' }),
  );
  window.addEventListener('hashchange', show);
  show();
  return undefined;
}

function visibleTabs() {
  return TABS.filter(([id]) => (id !== 'invitations' || state.invitations)
    && (id !== 'organizations' || state.organizations) && (id !== 'plans' || state.catalog) && (id !== 'data' || state.data)
    && (id !== 'notices' || state.notices) && (id !== 'affiliates' || state.affiliates));
}

const VIEWS = {
  users: renderUsers, invitations: renderInvitations, plans: renderPlans, organizations: renderOrganizations,
  data: renderData, notices: renderNotices, affiliates: renderAffiliates, audit: renderAudit,
};

let showing = 0;
function show() {
  const wanted = (window.location.hash.match(/^#\/(\w+)/) || [])[1];
  const tab = visibleTabs().some(([id]) => id === wanted) ? wanted : 'users';
  for (const link of document.querySelectorAll('.kit-tab')) {
    if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const main = clear($('#admin-main'));
  // Drawn apart, once the server has answered, and put in only while it is still the last one
  // asked for: another tab, or two saves of an account one after the other, draw one view. One that
  // failed half way shows what it drew, with the error.
  const turn = ++showing;
  const view = el('div', {});
  VIEWS[tab](view).catch((err) => { if (turn === showing) fail(err); }).then(() => {
    if (turn === showing) clear(main).append(...view.childNodes);
  });
}

/* ---------------------------------- users ---------------------------------- */

async function renderUsers(main) {
  const { users } = await api.get('/api/admin/users');
  // Narrowed as it is typed, by email, username or name; Enter opens the one account left.
  const search = el('input', {
    type: 'search', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false',
    placeholder: t('admin.users.searchHint'), value: state.usersQuery,
  });
  const noMatch = el('p', { class: 'kit-empty', hidden: true });
  const rows = users.map((user) => ({ user, text: accountText(user), row: userRow(user) }));
  const narrow = () => {
    state.usersQuery = search.value;
    const shown = rows.filter(({ text, row }) => {
      row.hidden = !hasWords(text, search.value);
      return !row.hidden;
    });
    noMatch.hidden = shown.length > 0;
    noMatch.textContent = shown.length ? '' : t('admin.users.noMatch', { query: search.value.trim() });
    return shown;
  };
  search.addEventListener('input', narrow);
  search.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    // Kept, or the same Enter presses the dialog's first button (its ×) once it has the focus.
    ev.preventDefault();
    const shown = narrow();
    if (shown.length === 1) userDialog(shown[0].user);
  });
  const grid = table([t('admin.users.name'), t('admin.users.email'), t('admin.users.role'), t('admin.users.plan'), t('admin.users.lastSignIn'),
    hasDevices(users) ? t('admin.users.devices') : null, t('admin.users.usage')].filter(Boolean),
  rows.map(({ row }) => row));
  main.append(
    el('h2', { text: t('admin.users.title') }),
    el('p', { class: 'kit-lead', text: local() ? t('admin.users.leadLocal') : t('admin.users.leadIdp', { provider: state.config.name }) }),
    el('div', { class: 'kit-toolbar' },
      field(t('admin.users.search'), search),
      el('button', { type: 'button', class: 'kit-btn kit-btn--primary', text: t('admin.users.new'), onClick: () => newUserDialog().catch(fail) })),
    grid,
    noMatch,
  );
  if (search.value) narrow();
  // On the table, which goes into the page as it is (show() moves the view's nodes).
  paintPeaks(grid).catch(() => {
    // An app on its own has no Usage (a host's, usage.js): the column goes.
    for (const cell of [...[...grid.querySelectorAll('th')].slice(-1), ...grid.querySelectorAll('[data-usage]')]) cell.remove();
  });
}

/** An account's line in Accounts; it opens the account, with Enter too (kept, like the search's). */
function userRow(user) {
  const open = (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    userDialog(user);
  };
  return el('tr', { 'data-open': true, tabindex: '0', onClick: () => userDialog(user), onKeydown: open },
    el('td', {},
      el('strong', { text: user.display_name }),
      el('small', { text: `@${user.username}` }),
      // Its owner asked to delete it: the day it goes. Enabling it takes the deletion back.
      user.delete_after
        ? el('span', { class: 'kit-badge kit-badge--danger', text: t('admin.users.deletingBadge', { date: formatDate(user.delete_after) }) })
        : user.disabled ? el('span', { class: 'kit-badge kit-badge--danger', text: t('admin.users.disabledBadge') }) : null),
    el('td', {},
      user.email ? el('span', { text: user.email }) : el('span', { class: 'kit-hint', text: '—' }),
      user.email && !user.email_verified ? el('small', { text: t('admin.users.unconfirmed') }) : null),
    el('td', {}, el('span', { class: `kit-badge${user.role === 'admin' ? ' kit-badge--accent' : ''}`, text: t(`admin.roles.${user.role}`) })),
    el('td', {}, ...planParts(user)),
    el('td', { text: user.last_login_at ? formatDateTime(user.last_login_at) : t('admin.users.never') }),
    // How many it has connected that still work, never a device's number: the log's `device 14` is its id among all.
    'devices' in user ? el('td', { 'data-devices': user.id, text: String(user.devices) }) : null,
    el('td', { class: 'kit-usage-cell', 'data-usage': user.id }, el('span', { class: 'kit-hint', text: '…' })));
}

/** Whether the install connects phones (modules.devices): its accounts then say how many they have. */
const hasDevices = (users) => users.some((user) => 'devices' in user);

/** Each account's nearest cap, in the list's last column, once they are counted. */
async function paintPeaks(main) {
  const { peaks } = await api.get('/api/admin/usage');
  for (const cell of main.querySelectorAll('[data-usage]')) {
    const peak = peaks[cell.dataset.usage] ?? null;
    clear(cell).append(...(peak
      ? [el('span', { text: percent(peak.share) }), meter(peak.share), el('small', { text: peakWhat(peak) })]
      : [el('span', { class: 'kit-hint', text: '—' })]));
  }
}

/**
 * A new account (a store's reviewer, a tester): its email first, a name, a role, a password and the
 * plan it has from the start, all made at once (POST /api/admin/users).
 * · Passwords here: the username too (left empty, the server takes it from the email), and the
 *   email taken as confirmed, with no message to confirm it.
 * · WorkOS where this install owns the logins (the sign-in answer's `manage`): with a password the
 *   login is made there, its email confirmed; without, as with any other provider, the account
 *   waits for its person to sign in with that email. The admin's own password isn't in the form:
 *   when the server wants it (`admin_confirm_required`, at most every 10 minutes) a dialog of its own
 *   asks for it over this one, and the account is sent again (confirmYourself). An admin with no
 *   password to give (`reauth: 'session'`: Google, Apple, a company's sign-in) is confirmed before
 *   the form shows instead (POST /api/admin/confirm): what confirms them is a sign-in made after the
 *   server asked, which leaves this page, and what they had typed would be lost on the way. Asked,
 *   they go to sign in again (reauthFailed); confirmed, the form's accounts go in for 10 minutes.
 * What the server refuses (an email that already has an account here or a login at WorkOS) is said
 * inside the dialog, which stays open to be corrected.
 */
async function newUserDialog() {
  // Whether this install makes WorkOS logins (workos-security.js).
  const signIn = workos() ? await api.get(`/api/admin/users/${state.me.id}/sign-in`).catch(() => null) : null;
  const atProvider = signIn?.manage === true;
  if (atProvider && signIn.reauth === 'session') {
    try {
      await api.post('/api/admin/confirm');
    } catch (err) {
      reauthFailed(err);
      return;
    }
  }
  const provider = state.config.name;
  const email = el('input', { type: 'email', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '254' });
  const username = local() ? el('input', { autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '32' }) : null;
  const name = el('input', { maxlength: '80', autocomplete: 'off' });
  const role = el('select', {}, ['user', 'admin'].map((r) => el('option', { value: r, text: t(`admin.roles.${r}`) })));
  const password = local() || atProvider ? el('input', { type: 'password', autocomplete: 'new-password', maxlength: '1024' }) : null;

  // The plan from the start, where there is more than one: its end and its reason only with one of its own.
  const several = (state.catalog?.plans.length ?? 0) > 1;
  const plan = several ? el('select', {},
    el('option', { value: '', text: t('admin.users.newPlanDefault', { plan: planName(state.catalog.defaultPlan) }) }),
    state.catalog.plans.map((p) => el('option', { value: p.id, text: t(p.name) }))) : null;
  const until = el('input', { type: 'date' });
  const note = el('input', { maxlength: '200', placeholder: t('admin.users.optional') });
  const planMore = el('div', { class: 'kit-grid', hidden: true },
    field(t('admin.users.planUntil'), until), field(t('admin.users.planNote'), note));
  plan?.addEventListener('change', () => { planMore.hidden = !plan.value; });

  const lead = local() ? t('admin.users.newLeadLocal') : atProvider ? t('admin.users.newLeadWorkos', { provider }) : null;
  formDialog({
    title: t('admin.users.new'),
    content: [
      lead ? el('p', { class: 'kit-hint', text: lead }) : null,
      el('div', { class: 'kit-grid' },
        field(t('fields.email'), email, local() || atProvider ? null : t('admin.users.idpEmailHint', { provider })),
        username ? field(t('fields.username'), username, t('admin.users.usernameHint')) : null,
        field(t('fields.display_name'), name),
        field(t('fields.role'), role),
        password ? field(t('fields.password'), revealable(password),
          local() ? t('admin.users.passwordHint') : t('admin.users.passwordHintWorkos', { provider })) : null),
      plan ? el('div', { class: 'kit-grid' }, field(t('admin.users.planName'), plan)) : null,
      plan ? planMore : null,
    ],
    actions: [
      { label: t('admin.cancel') },
      { label: t('admin.users.create'), primary: true, submit: true },
    ],
    onSubmit: async () => {
      const typed = password?.value || '';
      const body = {
        email: email.value.trim() || null, display_name: name.value.trim() || undefined, role: role.value,
        ...(username?.value.trim() ? { username: username.value.trim() } : {}),
        ...(typed ? { password: typed } : {}),
        ...(local() ? { email_verified: Boolean(email.value.trim()) } : {}),
        ...(plan?.value ? { plan: plan.value, ends_at: endOfDay(until.value), note: note.value.trim() || null } : {}),
      };
      const send = async () => {
        try {
          return await api.post('/api/admin/users', body);
        } catch (err) {
          // The admin's own password, asked apart (at most every 10 minutes); confirmed, the same again.
          if (err?.code !== 'admin_confirm_required') throw err;
          if (!(await confirmYourself(err.data?.reauth))) return null;
          return api.post('/api/admin/users', body);
        }
      };
      try {
        const user = await send();
        if (!user) return false;
        toast(local() ? t('admin.users.createdAs', { username: user.username }) : t('admin.users.created'));
        show();
        return true;
      } catch (err) {
        // A fresh sign-in is what the server wants (an admin who signs in with Google, whose 10
        // minutes passed with the form open): to it, and back.
        if (err?.code === 'reauth_required') { reauthFailed(err); return false; }
        if (err instanceof SessionExpired) { fail(err); return true; }
        throw err;
      }
    },
  });
  email.focus();
}

/**
 * The admin's own password (and code) in a dialog of its own, over whatever asked for it
 * (`reauth`: password or password_code, as the server said): POST /api/admin/confirm, which stands
 * 10 minutes in this session. A wrong one is said inside it, which stays open. → true once
 * confirmed, false if the admin gave up.
 */
function confirmYourself(reauth) {
  return new Promise((resolve) => {
    let confirmed = false;
    const again = reauthFields(reauth === 'password_code' ? 'password_code' : 'password');
    const { dialog } = formDialog({
      title: t('admin.confirm.title'),
      width: QUESTION_WIDTH,
      keepTyped: false,
      content: [el('p', { class: 'kit-hint', text: t('admin.confirm.lead') }), ...again.nodes],
      actions: [
        { label: t('admin.cancel') },
        { label: t('admin.confirm.action'), primary: true, submit: true },
      ],
      onSubmit: async () => {
        await api.post('/api/admin/confirm', again.body());
        confirmed = true;
        return true;
      },
      onClose: () => resolve(confirmed),
    });
    dialog.querySelector('input')?.focus();
  });
}

function userDialog(user) {
  const self = user.id === state.me.id;
  const refresh = () => show();

  // Who they are.
  const name = el('input', { value: user.display_name, maxlength: '80' });
  const email = el('input', { type: 'email', value: user.email || '' });
  const role = el('select', { disabled: self }, ['user', 'admin'].map((r) => el('option', { value: r, text: t(`admin.roles.${r}`) })));
  role.value = user.role;
  const disabled = el('input', { type: 'checkbox', checked: user.disabled, disabled: self });
  // The admin may vouch for an address: without a mail server there is no other way.
  const verified = el('input', { type: 'checkbox', checked: Boolean(user.email_verified) });
  email.addEventListener('input', () => {
    verified.checked = email.value.trim().toLowerCase() === (user.email || '') && Boolean(user.email_verified);
  });
  const profile = fold({ title: t('admin.users.profile'), now: [user.email, t(`admin.roles.${user.role}`)].filter(Boolean).join(' · ') },
    el('div', { class: 'kit-grid' },
      field(t('fields.display_name'), name),
      field(t('fields.email'), email, user.email && !user.email_verified ? t('admin.users.unconfirmed') : null),
      field(t('fields.role'), role)),
    local() ? el('label', { class: 'kit-check' }, verified, el('span', { text: t('admin.users.emailVerified') })) : null,
    local() && state.config.mail === false ? el('p', { class: 'kit-hint', text: t('admin.users.confirmByHand') }) : null,
    el('label', { class: 'kit-check' }, disabled, el('span', { text: t('admin.users.disabled') })),
    self ? el('p', { class: 'kit-hint', text: t('admin.users.notOnYourself') }) : null,
    el('div', { class: 'kit-row' },
      ...saveButton({
        label: t('admin.save'),
        controls: [name, email, role, verified, disabled],
        read: () => ({ name: name.value.trim(), email: email.value.trim(), verified: verified.checked, role: role.value, disabled: disabled.checked }),
        save: async () => {
          // Making someone an admin or not, or turning their account off, is asked about first.
          const app = state.config.app?.name || '';
          const asks = self ? [] : [
            role.value !== user.role ? t(role.value === 'admin' ? 'admin.users.roleAdminConfirm' : 'admin.users.roleUserConfirm', { name: user.display_name, app }) : null,
            disabled.checked && !user.disabled ? t('admin.users.disableConfirm', { name: user.display_name }) : null,
          ].filter(Boolean);
          if (asks.length && !(await confirmDialog(asks.join(' '), { confirm: t('admin.save'), danger: disabled.checked && !user.disabled }))) return false;
          Object.assign(user, await api.patch(`/api/admin/users/${user.id}`, {
            display_name: name.value.trim(), email: email.value.trim() || null,
            ...(local() ? { email_verified: verified.checked && Boolean(email.value.trim()) } : {}),
            ...(self ? {} : { role: role.value, disabled: disabled.checked }),
          }));
          nowOf(profile, [user.email, t(`admin.roles.${user.role}`)].filter(Boolean).join(' · '));
          refresh();
        },
      })));

  // A new password (local accounts): their other sessions end.
  const password = el('input', { type: 'password', autocomplete: 'new-password' });
  const passwordSection = local() ? fold({ title: t('admin.users.password') },
    el('p', { class: 'kit-hint', text: t('admin.users.passwordLead') }),
    el('div', { class: 'kit-row kit-row--end' },
      field(t('fields.password'), revealable(password)),
      el('button', {
        type: 'button', class: 'kit-btn kit-btn--small', text: t('admin.users.setPassword'),
        onClick: async () => {
          if (!(await confirmDialog(t('admin.users.passwordConfirm', { name: user.display_name }), { confirm: t('admin.users.setPassword') }))) return;
          try {
            await api.patch(`/api/admin/users/${user.id}`, { password: password.value });
            password.value = '';
            toast(t('admin.users.passwordSet'));
          } catch (err) { fail(err); }
        },
      }))) : null;

  // With WorkOS the same, at WorkOS, once it is known how they sign in (workos-security.js):
  // a password for whoever signs in with one, and their second step off for whoever lost the phone.
  const signInBox = workos() ? el('div', { class: 'kit-contents' }) : null;
  const twoFactorBox = workos() ? el('div', { class: 'kit-contents' }) : null;
  async function paintSignIn() {
    const answer = await api.get(`/api/admin/users/${user.id}/sign-in`);
    // An install that doesn't own the identities (accounts.adminIdentity) only shows them.
    const manage = answer.manage !== false;
    if (answer.password && manage) {
      const next = el('input', { type: 'password', autocomplete: 'new-password' });
      const again = reauthFields(answer.reauth);
      clear(signInBox).append(fold({ title: t('admin.users.password') },
        el('p', { class: 'kit-hint', text: t('admin.users.passwordLeadWorkos') }),
        el('div', { class: 'kit-row kit-row--end' },
          field(t('fields.password'), revealable(next)),
          ...again.nodes,
          el('button', {
            type: 'button', class: 'kit-btn kit-btn--small', text: t('admin.users.setPassword'),
            onClick: async () => {
              if (!(await confirmDialog(t('admin.users.passwordConfirm', { name: user.display_name }), { confirm: t('admin.users.setPassword') }))) return;
              try {
                await api.put(`/api/admin/users/${user.id}/sign-in/password`, { password: next.value, ...again.body() });
                next.value = '';
                again.reset();
                toast(t('admin.users.passwordSet'));
              } catch (err) { reauthFailed(err); }
            },
          }))));
    } else if (answer.method) {
      clear(signInBox).append(el('p', { class: 'kit-hint', text: t('admin.users.signsInWith', { method: methodName(answer.method) }) }));
    }
    if (!answer.two_factor?.enabled || !manage) return;
    const again = reauthFields(answer.reauth);
    append(clear(twoFactorBox),
      el('p', { class: 'kit-hint', text: `${t('admin.users.twoFactor')} ${t('admin.users.twoFactorLeadWorkos')}` }),
      again.nodes.some(Boolean) ? el('div', { class: 'kit-row kit-row--end' }, ...again.nodes) : null,
      el('button', {
        type: 'button', class: 'kit-btn kit-btn--small', text: t('admin.users.twoFactorOff'),
        onClick: async () => {
          if (!(await confirmDialog(t('admin.users.twoFactorOffConfirm', { name: user.display_name })))) return;
          try {
            await api.delete(`/api/admin/users/${user.id}/sign-in/two-factor`, again.body());
            toast(t('admin.users.twoFactorOffDone'));
            clear(twoFactorBox);
          } catch (err) { reauthFailed(err); }
        },
      }));
  }

  // The plan: the admin's, over whatever else they have.
  let planSection = null;
  if (state.catalog) {
    const plan = el('select', {}, state.catalog.plans.map((p) => el('option', { value: p.id, text: t(p.name) })));
    plan.value = user.plan?.id || state.catalog.defaultPlan;
    const until = el('input', { type: 'date' });
    if (user.plan_ends) until.value = user.plan_ends.slice(0, 10);
    // The reason the admin gave stays when only the end changes.
    const note = el('input', { maxlength: '200', placeholder: t('admin.users.optional'), value: user.plan_source?.kind === 'admin' ? user.plan_source.note || '' : '' });
    const byDefault = user.plan_source?.kind === 'default';
    // Nothing keeps it: it follows the install's default plan, and goes when that changes.
    const followsDefault = byDefault ? el('p', { class: 'kit-warning', text: t('admin.users.planIsDefault', { plan: user.plan ? t(user.plan.name || user.plan.id) : '' }) }) : null;
    planSection = fold({ title: t('admin.users.plan'), now: planSummary(user), open: true },
      followsDefault,
      user.unlimited ? el('p', { class: 'kit-hint', text: t('admin.users.adminsUnlimited') }) : null,
      el('div', { class: 'kit-grid kit-grid--3' }, field(t('admin.users.planName'), plan), field(t('admin.users.planUntil'), until),
        field(t('admin.users.planNote'), note)),
      el('p', { class: 'kit-hint', text: t('admin.users.planHint') }),
      el('div', { class: 'kit-row' },
        ...saveButton({
          label: t('admin.users.setPlan'),
          controls: [plan, until, note],
          read: () => ({ plan: plan.value, until: until.value, note: note.value.trim() }),
          // The default plan the account follows is saved as its own when pressed, as it always was.
          dirty: byDefault,
          save: async () => {
            Object.assign(user, await api.put(`/api/admin/users/${user.id}/plan`, { plan: plan.value, ends_at: endOfDay(until.value), note: note.value.trim() || null }));
            nowOf(planSection, planSummary(user));
            if (user.plan_source?.kind !== 'default') followsDefault?.remove();
            refresh();
          },
        }),
        // Only what the admin gave can be taken back here; a subscription is the person's.
        user.plan_source?.kind === 'admin' ? el('button', {
          type: 'button', class: 'kit-link', text: t('admin.users.defaultPlan'),
          onClick: async () => {
            try {
              await api.put(`/api/admin/users/${user.id}/plan`, { plan: null, note: note.value.trim() || null });
              toast(t('admin.saved'));
              refresh();
            } catch (err) { fail(err); }
          },
        }) : null));
  }

  // What they pay, where payments are on: each subscription, and the provider's page to refund or cancel it.
  const paymentsNow = el('small', { class: 'kit-fold__now', text: t('admin.usage.loading') });
  const paymentsBox = el('div', { class: 'kit-contents' });
  const payments = fold({ title: t('admin.payments.title'), now: paymentsNow }, paymentsBox);

  // The phones and computers connected, where the install connects them (modules.devices): how many, and each.
  const devicesNow = el('small', { class: 'kit-fold__now', text: t('admin.users.devicesCount', { n: user.devices ?? 0 }) });
  const devicesBox = el('div', { class: 'kit-contents' });
  const devicesFold = 'devices' in user ? fold({ title: t('admin.users.devices'), now: devicesNow }, devicesBox) : null;

  // What they use, counted when the dialog opens: a host's only (usage.js).
  const usageNow = el('small', { class: 'kit-fold__now', text: t('admin.usage.loading') });
  const usageBox = el('div', { class: 'kit-contents' });
  const usage = fold({ title: t('admin.usage.title'), now: usageNow }, usageBox);

  // What they answered the first time: a host's that asks only (host.js firstQuestions).
  const firstNow = el('small', { class: 'kit-fold__now', text: t('admin.usage.loading') });
  const firstBox = el('div', { class: 'kit-contents' });
  const first = fold({ title: t('admin.firstAnswers.title'), now: firstNow }, firstBox);

  const grantsNow = el('small', { class: 'kit-fold__now' });
  // Drawn when they arrive, inside the fold's body as if they were its own.
  const grantsBox = el('div', { class: 'kit-contents' });
  const grants = state.catalog ? fold({ title: t('admin.grants.title'), now: grantsNow }, grantsBox) : null;

  // Everywhere they are signed in, their second step, and the account itself: at the end, apart.
  const endSection = el('div', { class: 'kit-dialog__end' },
    twoFactorBox,
    local() && user.two_factor ? el('p', { class: 'kit-hint', text: `${t('admin.users.twoFactor')} ${t('admin.users.twoFactorLead')}` }) : null,
    el('div', { class: 'kit-row' },
      // What they did, in Activity: the address opens it with them chosen.
      el('a', {
        class: 'kit-btn kit-btn--small', href: `#/audit?actor=${user.id}`, text: t('admin.users.activity'),
        onClick: () => dialog.close(),
      }),
      local() && user.two_factor ? el('button', {
        type: 'button', class: 'kit-btn kit-btn--small', text: t('admin.users.twoFactorOff'),
        onClick: async () => {
          if (!(await confirmDialog(t('admin.users.twoFactorOffConfirm', { name: user.display_name })))) return;
          try {
            await api.delete(`/api/admin/users/${user.id}/two-factor`);
            toast(t('admin.users.twoFactorOffDone'));
            dialog.close();
            refresh();
          } catch (err) { fail(err); }
        },
      }) : null,
      el('button', {
        type: 'button', class: 'kit-btn kit-btn--small', text: t('admin.users.signOut'),
        onClick: async () => {
          // It ends more than the sessions (revoke.js): it says so before and after.
          if (!(await confirmDialog(t('admin.users.signOutConfirm', { name: user.display_name }), { confirm: t('admin.users.signOut') }))) return;
          try {
            const { closed } = await api.delete(`/api/admin/users/${user.id}/sessions`);
            // Two sentences, so both with their full stop (rule 25): the first is a notice of its own elsewhere.
            toast(`${t('admin.users.signedOut', { n: closed })}. ${t('admin.users.signedOutMore')}`);
            // Their phones went with the sessions.
            if (devicesFold) paintDevices(devicesBox, user, devicesNow).catch(fail);
          } catch (err) { fail(err); }
        },
      }),
      self ? null : el('button', {
        type: 'button', class: 'kit-btn kit-btn--small kit-btn--danger kit-row__last', text: t('admin.users.delete'),
        onClick: async () => {
          const sells = state.config?.app?.modules;
          const paying = sells?.billing || sells?.stores ? await paymentsOf(user) : [];
          if (paying === undefined) return;
          const identity = state.config?.deletion_identity ? await identityChoice(user) : null;
          if (!(await confirmDialog(t('admin.users.deleteConfirm', { name: user.display_name }), { more: [paying, identity?.node] }))) return;
          try {
            if (identity?.box.checked) await api.delete(`/api/admin/users/${user.id}?identity=1`, identity.body());
            else await api.delete(`/api/admin/users/${user.id}`);
            toast(t('admin.users.deleted'));
            dialog.close();
            refresh();
          } catch (err) { reauthFailed(err); }
        },
      })));

  const { close: closeDialog, dialog: node } = openDialog({
    title: `${user.display_name} (@${user.username})`,
    wide: true,
    content: [el('div', { class: 'kit-folds' }, profile, planSection, payments, devicesFold, usage, first, grants, passwordSection, signInBox), endSection],
    actions: [{ label: t('admin.close') }],
  });
  const dialog = { close: closeDialog, node };
  // No payments in this install (404), or none to say: the fold goes.
  paintPayments(paymentsBox, user, paymentsNow).catch(() => payments.remove());
  if (devicesFold) paintDevices(devicesBox, user, devicesNow).catch(fail);
  if (grants) paintGrants(grantsBox, user, grantsNow).catch(fail);
  paintUsage(usageBox, user, usageNow).catch(() => usage.remove());
  paintFirstAnswers(firstBox, user, firstNow).catch(() => first.remove());
  if (signInBox) paintSignIn().catch(fail);
}

/**
 * The admin's own password (and code) again, as the server asks (`reauth`): the fields, and
 * what they add to the request. With `session` there is nothing to type: a fresh sign-in.
 */
function reauthFields(reauth) {
  const own = reauth === 'password' || reauth === 'password_code'
    ? el('input', { type: 'password', autocomplete: 'current-password' }) : null;
  const code = reauth === 'password_code'
    ? el('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' }) : null;
  return {
    nodes: [own ? field(t('admin.users.yourPassword'), revealable(own)) : null, code ? field(t('admin.users.yourCode'), code) : null],
    body: () => ({ ...(own ? { admin_password: own.value } : {}), ...(code ? { admin_code: code.value } : {}) }),
    reset: () => { if (own) own.value = ''; if (code) code.value = ''; },
  };
}

/**
 * A fresh sign-in is what the server wants: to the sign-in, where the provider asks again instead of
 * taking the session it still holds (`prompt=login`), and back here. Without it AuthKit signed the
 * browser in again without a word, and that proved nothing (workos-security.js confirmAdmin).
 */
function reauthFailed(err) {
  if (err?.code === 'reauth_required') {
    toast(t('errors.reauth_required'), { error: true });
    window.location.href = `/auth/login?prompt=login&return=${encodeURIComponent('/admin')}`;
    return;
  }
  fail(err);
}

/**
 * What someone pays for themselves, in the question before their account is deleted, as Settings
 * says it before one's own (`GET /api/admin/users/:id/subscriptions`): a web subscription the
 * deletion cancels at once (or doesn't, where the install keeps them), and a store's, which goes
 * on: only they can cancel it, in the store, so the admin tells them before. One they cancelled
 * already, here or in the store, renews no more: it says so, without the warning. Only where the
 * install sells. → the lines (none when they pay nothing), or undefined when it couldn't be known:
 * the error is said, and nothing is asked or deleted.
 */
async function paymentsOf(user) {
  let subscriptions;
  try {
    ({ subscriptions } = await api.get(`/api/admin/users/${user.id}/subscriptions`));
  } catch (err) {
    fail(err);
    return undefined;
  }
  return subscriptions.map((s) => {
    const vars = { plan: t(s.plan_name || s.plan || s.product || ''), provider: providerName(s.provider) };
    // Cancelled already, on the web or in the store: it renews no more, whatever the deletion does.
    if (s.ending === true) return el('p', { text: t('admin.users.deleteEnding', vars) });
    if (s.kind !== 'store') return el('p', { text: t(s.ends ? 'admin.users.deleteCancels' : 'admin.users.deleteKeeps', vars) });
    const store = ['app_store', 'play_store'].includes(s.store) ? s.store : 'other';
    return el('p', { class: 'kit-warning', text: t(`admin.users.deleteStore.${store}`, vars) });
  });
}

/**
 * Whether deleting someone takes their login too, where it is shared with other apps: unticked,
 * only the account here goes. Says which other apps they use with it, when the provider can tell.
 * Only an install that owns the identities offers it, and ticked it asks for the admin's own
 * password again. → { node, box, body } or null
 */
async function identityChoice(user) {
  const signIn = await api.get(`/api/admin/users/${user.id}/sign-in`).catch(() => null);
  if (signIn?.manage !== true) return null;
  let others = null;
  try {
    others = (await api.get(`/api/admin/users/${user.id}/other-apps`)).other_apps;
  } catch { /* said as not known */ }
  const again = reauthFields(signIn.reauth);
  const box = el('input', { type: 'checkbox', id: 'admin-delete-identity' });
  const asked = el('div', { class: 'kit-row kit-row--end', hidden: true }, ...again.nodes);
  box.addEventListener('change', () => { asked.hidden = !box.checked; });
  const said = others == null ? t('admin.users.identityUnknown')
    : others.length ? t('admin.users.identityUsed', { apps: listFormat({ type: 'conjunction' }).format(others) })
      : t('admin.users.identityAlone');
  const node = el('div', { class: 'kit-stack' },
    el('label', { class: 'kit-check' }, box, el('span', { text: t('admin.users.identityGoes', { provider: state.config?.name || '' }) })),
    el('p', { class: 'kit-hint', text: said }),
    asked);
  return { node, box, body: again.body };
}

/** How someone signs in, as people say it: "Google", "a password"… */
function methodName(method) {
  const names = { google: 'Google', apple: 'Apple', microsoft: 'Microsoft', github: 'GitHub' };
  return names[method] || t(`admin.users.method.${method}`);
}

/**
 * A part of the account's dialog that folds: its title, what it holds now (so the closed dialog
 * reads as a summary), and what changes it. One open at a time, like Settings' folds.
 */
function fold({ title, now = null, open = false }, ...body) {
  return slidingDetails(el('details', { class: 'kit-fold', name: 'kit-admin-user', open },
    el('summary', {}, el('span', { text: title }),
      typeof now === 'string' ? el('small', { class: 'kit-fold__now', text: now }) : now,
      icon('chevron-down', { className: 'kit-fold__chevron' })),
    el('div', { class: 'kit-fold__body' }, ...body)));
}

/** A fold's summary anew, once what it sums up was saved: a text, or the node planSummary gives. */
function nowOf(details, now) {
  const old = details.querySelector('summary')?.querySelector('.kit-fold__now');
  const next = typeof now === 'string' ? el('small', { class: 'kit-fold__now', text: now }) : now;
  if (old) old.replaceWith(next);
}

/**
 * A Save that can be pressed only with something to save: grey until one of `controls` holds other
 * than what was saved (`read()`, compared as it was), then, once saved, grey again with "Saved"
 * beside it. The account's dialog covers the page, so its own place says so, not only a notice.
 * `dirty`: pressable from the start (the default plan, which Save makes the account's own). `save`
 * answering false saved nothing (a question answered no).
 * → [the button, its state], for a row.
 */
function saveButton({ label, controls, read, save, dirty = false }) {
  const status = saveState('saved');
  status.node.hidden = true;
  let saved = dirty ? null : JSON.stringify(read());
  const button = el('button', { type: 'button', class: 'kit-btn kit-btn--primary kit-btn--small', text: label });
  const check = () => {
    const changed = JSON.stringify(read()) !== saved;
    button.disabled = !changed;
    if (changed) status.node.hidden = true;
  };
  for (const control of controls) {
    control.addEventListener('input', check);
    control.addEventListener('change', check);
  }
  button.addEventListener('click', async () => {
    const now = JSON.stringify(read());
    button.disabled = true;
    status.set('saving');
    status.node.hidden = false;
    try {
      // false: not saved after all (a question answered no), and it can be pressed again.
      if (await save() === false) {
        status.node.hidden = true;
        check();
        return;
      }
      saved = now;
      status.set('saved');
      check();
    } catch (err) {
      status.node.hidden = true;
      button.disabled = false;
      fail(err);
    }
  });
  check();
  return [button, status.node];
}

/** The plan in a few words, for its fold's title: the default one marked as such. */
function planSummary(user) {
  if (user.unlimited) return t('admin.users.unlimited');
  const name = user.plan ? t(user.plan.name || user.plan.id) : '';
  if (user.plan_source?.kind === 'default') return el('small', { class: 'kit-fold__now kit-fold__now--warn', text: t('admin.users.byDefault', { plan: name }) });
  const ends = user.plan_ends ? t('admin.users.until', { date: formatDate(user.plan_ends) }) : user.plan_source ? t('admin.users.forever') : null;
  return [name, ends].filter(Boolean).join(' · ');
}

/**
 * The grants of an account: what is given now beyond the plan, with a way to take each back; the
 * rest (ended, taken back, the plans the admin set) under History; and adding one, folded away.
 * `now` is the fold's summary: how many are given.
 */
async function paintGrants(box, user, now) {
  const { grants } = await api.get(`/api/admin/users/${user.id}/grants`);
  const at = new Date().toISOString();
  const stateOf = (g) => (g.revoked_at ? 'revoked' : g.ends_at && g.ends_at <= at ? 'ended' : 'active');
  const features = Object.entries(state.catalog.features || {});
  // The extras in force; the plans are the Plan fold's, and what is over is history.
  const extras = grants.filter((g) => g.feature && stateOf(g) === 'active');
  const history = grants.filter((g) => !extras.includes(g));
  now.textContent = extras.length ? t('admin.grants.activeCount', { n: extras.length }) : t('admin.grants.noneShort');

  const what = (g) => el('td', {},
    el('span', { text: g.plan ? t('admin.grants.planGrant', { plan: planName(g.plan) }) : `${featureLabel(g.feature)}: ${valueText(g.feature, JSON.parse(g.value ?? 'null'))}` }),
    g.note ? el('small', { text: g.note }) : null);
  const ends = (g) => (g.ends_at ? formatDate(g.ends_at) : t('admin.grants.forever'));
  const revoke = (g) => el('button', {
    type: 'button', class: 'kit-link kit-link--danger', text: t('admin.grants.revoke'),
    onClick: async () => {
      if (!(await confirmDialog(t('admin.grants.revokeConfirm')))) return;
      try {
        await api.delete(`/api/admin/grants/${g.id}`);
        paintGrants(box, user, now).catch(fail);
      } catch (err) { fail(err); }
    },
  });

  const feature = el('select', {}, features.map(([key]) => el('option', { value: key, text: featureLabel(key) })));
  const flag = el('input', { type: 'checkbox', checked: true });
  const amount = el('input', { type: 'number', min: '0', step: '1', placeholder: t('admin.plans.noLimit') });
  const until = el('input', { type: 'date' });
  const note = el('input', { maxlength: '200', placeholder: t('admin.users.optional') });
  const valueField = el('div', {});
  const paintValue = () => {
    const type = state.catalog.features[feature.value]?.type;
    clear(valueField).append(type === 'flag'
      ? field(t('admin.grants.value'), el('label', { class: 'kit-check' }, flag, el('span', { text: t('admin.grants.on') })))
      : field(t('admin.grants.limit'), amount));
  };
  feature.addEventListener('change', paintValue);
  paintValue();

  // The kit's append: the page's own wrote the parts left out (no history, nothing to add) as the text "null".
  append(clear(box),
    el('p', { class: 'kit-hint', text: t('admin.grants.lead') }),
    extras.length ? table([t('admin.grants.what'), t('admin.grants.until'), ''],
      extras.map((g) => el('tr', {}, what(g), el('td', { text: ends(g) }), el('td', {}, revoke(g)))))
      : el('p', { class: 'kit-empty', text: t('admin.grants.none') }),
    features.length ? el('details', { class: 'kit-subfold' },
      el('summary', { text: t('admin.grants.addOne') }),
      el('div', { class: 'kit-grid kit-grid--4' },
        field(t('admin.grants.feature'), feature), valueField,
        field(t('admin.grants.untilField'), until), field(t('admin.grants.note'), note)),
      el('p', { class: 'kit-hint', text: t('admin.grants.addHint') }),
      el('div', { class: 'kit-row' }, el('button', {
        type: 'button', class: 'kit-btn kit-btn--small kit-btn--primary', text: t('admin.grants.add'),
        onClick: async () => {
          const type = state.catalog.features[feature.value]?.type;
          try {
            await api.post('/api/admin/grants', {
              subject_id: user.id, feature: feature.value,
              value: type === 'flag' ? flag.checked : amount.value === '' ? null : Number(amount.value),
              ends_at: endOfDay(until.value), note: note.value.trim() || null,
            });
            toast(t('admin.saved'));
            paintGrants(box, user, now).catch(fail);
          } catch (err) { fail(err); }
        },
      }))) : null,
    history.length ? el('details', { class: 'kit-subfold' },
      el('summary', { text: t('admin.grants.history', { n: history.length }) }),
      table([t('admin.grants.what'), t('admin.grants.source'), t('admin.grants.until'), ''],
        history.map((g) => el('tr', {}, what(g), el('td', { text: g.source }),
          el('td', {}, el('span', { text: ends(g) }),
            el('small', { class: `kit-badge kit-badge--${stateOf(g) === 'active' ? 'ok' : 'warn'}`, text: t(`admin.grants.${stateOf(g)}`) })),
          el('td', {}, stateOf(g) === 'active' ? revoke(g) : null))))) : null,
  );
}

/* ---------------------------------- usage ---------------------------------- */

/** A platform as people write it: "Android", "iOS"; any other as the app named it. */
const platformName = (platform) => ({ android: 'Android', ios: 'iOS', ipados: 'iPadOS', macos: 'macOS', windows: 'Windows', linux: 'Linux' }[
  String(platform || '').toLowerCase()] || platform || '—');

/* -------------------------------- payments -------------------------------- */

/** Where a payment was made, by the names people know: the store bought in (its name, a text), else the provider. */
const STORES = ['app_store', 'play_store'];
const PAYMENT_PROVIDERS = { stripe: 'Stripe', paddle: 'Paddle', 'paddle-sandbox': 'Paddle', revenuecat: 'RevenueCat' };
const STATUSES = ['active', 'trialing', 'past_due', 'paused', 'canceled', 'ended'];

/**
 * What an account pays or paid (`/api/admin/users/:id/payments`, billing.js billingForAdmin): each
 * subscription of theirs and of the groups they administer, with «Manage charges», the provider's
 * own page for it, where a refund or a cancellation is made. A row each, the button at its end, so
 * a phone shows it without scrolling sideways. With no payments in this install the request fails
 * and the fold goes; with none for this account, it says so. `now`: how many are live.
 */
async function paintPayments(box, user, now) {
  const { payments } = await api.get(`/api/admin/users/${user.id}/payments`);
  const live = payments.filter((p) => p.live).length;
  now.textContent = payments.length ? t('admin.payments.liveCount', { n: live }) : t('admin.payments.noneShort');
  const provider = (p) => PAYMENT_PROVIDERS[p.provider] || p.provider;
  const where = (p) => (STORES.includes(p.store) ? t(`admin.payments.store.${p.store}`) : provider(p));
  const status = (p) => (STATUSES.includes(p.status) ? t(`admin.payments.status.${p.status}`) : p.status);
  const when = (p) => {
    if (!p.period_end) return null;
    const date = formatDate(p.period_end);
    if (!p.live) return t('admin.payments.endedOn', { date });
    return p.ending === true ? t('admin.payments.endsOn', { date }) : t('admin.payments.renewsOn', { date });
  };
  const sandbox = (p) => p.sandbox === true || p.provider === 'paddle-sandbox';
  const row = (p) => el('div', { class: 'kit-list__row' },
    el('div', { class: 'kit-list__text' },
      el('strong', { text: `${p.plan_name ? t(p.plan_name) : p.product} · ${where(p)}` }),
      sandbox(p) ? el('span', { class: 'kit-badge kit-badge--warn', text: t('admin.payments.sandbox') }) : null,
      // Whose and which: the group it pays for, the product, and the store's provider.
      el('small', { text: [p.organization_name ? t('admin.payments.group', { name: p.organization_name }) : null, p.product, p.store ? provider(p) : null]
        .filter(Boolean).join(' · ') }),
      el('small', { text: [status(p), when(p)].filter(Boolean).join(' · ') }),
      p.dashboard_url ? null : el('small', { class: 'kit-mono', text: t('admin.payments.noLink', { provider: provider(p), ref: p.ref }) })),
    p.dashboard_url ? el('a', {
      class: 'kit-btn kit-btn--small', href: p.dashboard_url, target: '_blank', rel: 'noopener noreferrer',
      text: t('admin.payments.manage'), title: t('admin.payments.manageHint', { provider: provider(p) }),
    }) : null);
  append(clear(box),
    el('p', { class: 'kit-hint', text: t('admin.payments.lead') }),
    payments.length ? el('div', { class: 'kit-list' }, payments.map(row)) : el('p', { class: 'kit-empty', text: t('admin.payments.none') }));
}

/** An account's devices that still work, last used first: what each is, its app, when it connected and was last used. */
async function paintDevices(box, user, now) {
  const { devices } = await api.get(`/api/admin/users/${user.id}/devices`);
  now.textContent = t('admin.users.devicesCount', { n: devices.length });
  append(clear(box),
    el('p', { class: 'kit-hint', text: t('admin.users.devicesLead') }),
    devices.length ? table([t('admin.users.device'), t('admin.users.deviceApp'), t('admin.users.deviceConnected'), t('admin.users.deviceUsed')],
      devices.map((d) => el('tr', {},
        el('td', {}, el('strong', { text: d.name || platformName(d.platform) }), d.name ? el('small', { text: platformName(d.platform) }) : null),
        el('td', { class: 'kit-mono', text: d.app_version || '—' }),
        el('td', { text: formatDateTime(d.created_at) }),
        el('td', { text: d.last_used_at ? formatDateTime(d.last_used_at) : t('admin.users.never') })))) : null);
}

/**
 * What an account uses (usage-view.js): per module its counts against the plan's caps, then the
 * storage of all of them and the calls from assistants. `now` is the fold's summary: the cap they
 * are nearest to.
 */
async function paintUsage(box, user, now) {
  const usage = await api.get(`/api/admin/users/${user.id}/usage`);
  now.textContent = usage.peak ? t('admin.usage.peak', { percent: percent(usage.peak.share), what: peakWhat(usage.peak) }) : t('admin.usage.noLimits');
  if (['near', 'reached'].includes(levelOf(usage.peak?.share ?? null))) now.setAttribute('class', 'kit-fold__now kit-fold__now--warn');
  clear(box).append(el('p', { class: 'kit-hint', text: t('admin.usage.lead') }), usageGroups(usage, { admin: true }));
}

/* ------------------------------ first answers ------------------------------ */

/**
 * What they answered the first time (a host's with `firstQuestions`): how they heard of the app and
 * their channel, blog or newsletter. `now` is the fold's summary: where they came from.
 */
async function paintFirstAnswers(box, user, now) {
  const { answers, code = null } = await api.get(`/api/admin/users/${user.id}/first-answers`);
  // Whose code brought them (affiliates.js): by its link, written at the questions or used to pay.
  const brought = code ? t(`admin.firstAnswers.code.${code.source}`, { code: code.code }) : null;
  const heard = answers?.heard_from ? t(`kit.firstQuestions.heard.${answers.heard_from}`) : null;
  const channel = answers?.has_channel === true ? answers.channel || t('admin.firstAnswers.channelNoLink')
    : answers?.has_channel === false ? t('admin.firstAnswers.noChannel') : null;
  const fact = (label, value) => el('div', { class: 'kit-fact' }, el('span', { text: label }), el('strong', { text: value ?? '—' }));
  now.textContent = [
    !answers ? t('admin.firstAnswers.notAsked')
      : heard || channel ? [heard, answers.has_channel ? channel : null].filter(Boolean).join(' · ') : t('admin.firstAnswers.skipped'),
    code?.code,
  ].filter(Boolean).join(' · ');
  if (!answers) {
    clear(box).append(el('p', { class: 'kit-hint', text: t('admin.firstAnswers.notAskedLead') }),
      brought ? el('div', { class: 'kit-facts' }, fact(t('admin.firstAnswers.code'), brought)) : null);
    return;
  }
  const link = answers.has_channel && /^https?:\/\//i.test(answers.channel || '') ? answers.channel : null;
  clear(box).append(el('div', { class: 'kit-facts' },
    fact(t('kit.firstQuestions.heard', { app: state.config.app?.name || '' }), heard),
    link ? el('div', { class: 'kit-fact' }, el('span', { text: t('kit.firstQuestions.channel') }),
      el('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: link })) : fact(t('kit.firstQuestions.channel'), channel),
    brought ? fact(t('admin.firstAnswers.code'), brought) : null,
    fact(t('admin.firstAnswers.when'), new Date(answers.answered_at).toLocaleDateString())));
}

/* ------------------------------- invitations ------------------------------- */

async function renderInvitations(main) {
  const email = el('input', { type: 'email', autocomplete: 'off' });
  const role = el('select', {}, ['user', 'admin'].map((r) => el('option', { value: r, text: t(`admin.roles.${r}`) })));
  const result = el('div', {});
  const now = new Date().toISOString();
  const stateOf = (i) => (i.used_at ? 'used' : i.revoked_at ? 'revoked' : i.expires_at <= now ? 'expired' : 'open');

  // The kit's append: the page's own writes the notice left out, with mail on, as the text "null".
  append(main,
    el('h2', { text: t('admin.invitations.title') }),
    el('p', { class: 'kit-lead', text: t('admin.invitations.lead', { signup: t(`admin.signup.${state.config.signup || 'admin'}`) }) }),
    state.config.mail === false ? el('p', { class: 'kit-notice', text: t('admin.mail.off') }) : null,
    el('div', { class: 'kit-toolbar' },
      field(t('fields.email'), email), field(t('fields.role'), role),
      el('button', {
        type: 'button', class: 'kit-btn kit-btn--primary', text: t('admin.invitations.send'),
        onClick: async () => {
          try {
            const invitation = await api.post('/api/admin/invitations', { email: email.value.trim(), role: role.value });
            email.value = '';
            const copy = el('button', {
              type: 'button', class: 'kit-btn kit-btn--small', text: t('admin.invitations.copy'),
              onClick: async () => {
                try { await navigator.clipboard.writeText(invitation.url); toast(t('admin.invitations.copied')); } catch { /* no clipboard */ }
              },
            });
            clear(result).append(el('div', { class: 'kit-notice' },
              el('p', {
                text: invitation.sent ? t('admin.invitations.sent', { email: invitation.email })
                  : state.config.mail === false ? t('admin.invitations.noMail', { email: invitation.email })
                    : t('admin.invitations.notSent', { email: invitation.email }),
              }),
              el('div', { class: 'kit-copy' }, el('code', { class: 'kit-mono', text: invitation.url }), copy)));
            paintList().catch(fail);
          } catch (err) { fail(err); }
        },
      })),
    result,
  );
  const list = el('div', {});
  main.append(list);
  const paintList = async () => {
    const fresh = (await api.get('/api/admin/invitations')).invitations;
    clear(list).append(fresh.length ? table([t('fields.email'), t('fields.role'), t('admin.invitations.sentOn'), t('admin.invitations.state'), ''],
      fresh.map((i) => el('tr', {},
        el('td', { text: i.email }),
        el('td', { text: t(`admin.roles.${i.role}`) }),
        el('td', {}, el('span', { text: formatDateTime(i.created_at) }), el('small', { text: t('admin.invitations.expires', { date: formatDate(i.expires_at) }) })),
        el('td', {}, el('span', { class: `kit-badge kit-badge--${stateOf(i) === 'open' ? 'accent' : stateOf(i) === 'used' ? 'ok' : 'warn'}`, text: t(`admin.invitations.${stateOf(i)}`) })),
        el('td', {}, stateOf(i) === 'open' ? el('button', {
          type: 'button', class: 'kit-link kit-link--danger', text: t('admin.invitations.revoke'),
          onClick: async () => {
            try { await api.delete(`/api/admin/invitations/${i.id}`); paintList().catch(fail); } catch (err) { fail(err); }
          },
        }) : null)))) : el('p', { class: 'kit-empty', text: t('admin.invitations.none') }));
  };
  await paintList();
}

/* ---------------------------------- plans ---------------------------------- */

/**
 * The early access's plan kept past its end for the accounts made during it (entitlements.js
 * keepEarlyAccess): how many have it, and the button for the rest. Nothing in an install without one.
 */
async function earlyAccessBox() {
  const state = await api.get('/api/admin/early-access').catch(() => null);
  if (!state) return null;
  const box = el('section', { class: 'kit-stack' });
  const planOf = () => planName(state.plan);
  const until = el('input', { type: 'date' });
  const count = el('p', { class: 'kit-hint' });
  const give = el('button', {
    type: 'button', class: 'kit-btn kit-btn--small kit-btn--primary',
    onClick: async () => {
      const ends = endOfDay(until.value);
      if (!ends) { toast(t('admin.early.pickDate'), { error: true }); return; }
      if (!(await confirmDialog(t('admin.early.confirm', { n: state.left, plan: planOf(), date: formatDate(ends) })))) return;
      give.disabled = true;
      try {
        const done = await api.post('/api/admin/early-access/keep', { ends_at: ends });
        Object.assign(state, done);
        toast(t('admin.early.done', { n: done.added }));
        paint();
      } catch (err) { fail(err); paint(); }
    },
  });
  function paint() {
    count.textContent = t('admin.early.count', { n: state.accounts, kept: state.kept, date: formatDate(state.until) });
    give.textContent = t('admin.early.give', { n: state.left });
    // With none left it still moves the date of them all.
    give.disabled = state.accounts === 0;
  }
  paint();
  return append(box,
    el('h3', { text: t('admin.early.title') }),
    el('p', { class: 'kit-hint', text: t('admin.early.lead', { plan: planOf() }) }),
    count,
    el('div', { class: 'kit-grid kit-grid--3' }, field(t('admin.early.until'), until)),
    el('div', { class: 'kit-row' }, give));
}

async function renderPlans(main) {
  const catalog = state.catalog;
  // A host's modules limit what is theirs (lists, notebooks, storage…) with the same plans; an app
  // on its own has no such route, and its catalog is all there is.
  const modules = (await api.get('/api/admin/plans/modules').catch(() => null))?.modules || [];
  /** One catalog as a table: a row per feature, a column per plan, the default one marked. */
  const plansTable = ({ plans, features }) => table(
    [t('admin.plans.feature'), ...plans.map((p) => `${t(p.name)}${p.id === catalog.defaultPlan ? ` · ${t('admin.plans.default')}` : ''}`)],
    Object.keys(features).map((key) => el('tr', {},
      el('td', { text: featureLabel(key, features) }),
      plans.map((p) => el('td', { text: valueText(key, p.features[key], features) })))));
  const own = Object.keys(catalog.features || {}).length;
  append(main,
    el('h2', { text: t('admin.plans.title') }),
    el('p', { class: 'kit-lead', text: t('admin.plans.lead') }),
    await earlyAccessBox(),
    // The host's own (its one MCP) under its name when modules follow; alone, as it always was.
    own && modules.length ? el('h3', { text: state.config.app?.name || '' }) : null,
    own ? plansTable(catalog) : null,
    ...modules.flatMap((m) => [el('h3', { text: m.name }), plansTable(m)]),
    !own && !modules.length ? el('p', { class: 'kit-empty', text: t('admin.plans.nothingToLimit') }) : null,
  );
}

/* ------------------------------ organizations ------------------------------ */

async function renderOrganizations(main) {
  const { organizations } = await api.get('/api/admin/organizations');
  main.append(
    el('h2', { text: t('admin.organizations.title') }),
    el('p', { class: 'kit-lead', text: t('admin.organizations.lead') }),
    organizations.length ? table([t('admin.organizations.name'), t('admin.organizations.members'), t('admin.organizations.created')],
      organizations.map((o) => el('tr', {},
        el('td', {}, el('strong', { text: o.name }), el('small', { text: o.slug })),
        el('td', { text: String(o.members) }),
        el('td', { text: formatDate(o.created_at) }))))
      : el('p', { class: 'kit-empty', text: t('admin.organizations.none') }),
  );
}

/* ----------------------------------- data ---------------------------------- */

const sum = (counts, skip = []) => Object.entries(counts || {}).filter(([k]) => !skip.includes(k)).reduce((a, [, b]) => a + b, 0);

/**
 * Rows in words: the app's own for its tables when it has them
 * (`data.tables.lists`: "{n} lists"), and plain records for the rest.
 * The attachments' tables are left to the count of files (`skip`).
 */
function rowsText(counts = {}, skip = []) {
  const parts = [];
  let other = 0;
  for (const [table, n] of Object.entries(counts)) {
    if (skip.includes(table)) continue;
    const key = `data.tables.${table}`;
    const text = t(key, { n });
    if (text === key) other += n;
    else parts.push(text);
  }
  if (other || !parts.length) parts.push(t('admin.data.rowsCount', { n: other }));
  return parts.join(', ');
}

async function renderData(main) {
  const app = state.config.app || {};
  const file = el('input', { type: 'file', accept: '.zip,application/zip' });
  const upload = el('button', { type: 'button', class: 'kit-btn kit-btn--primary', text: t('admin.data.upload'), disabled: true });
  const result = el('div', {});
  const reset = () => { file.value = ''; upload.disabled = true; };
  file.addEventListener('change', () => { upload.disabled = !file.files?.length; });
  upload.addEventListener('click', async () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    upload.disabled = true;
    upload.textContent = t('admin.data.uploading');
    try {
      paintPlan(result, await api.upload('/api/admin/import', chosen), reset);
    } catch (err) {
      fail(err);
    } finally {
      upload.textContent = t('admin.data.upload');
      upload.disabled = !file.files?.length;
    }
  });

  main.append(
    el('h2', { text: t('admin.data.exportTitle') }),
    el('p', { class: 'kit-lead', text: t('admin.data.exportLead') }),
    el('div', { class: 'kit-toolbar' },
      // A plain link: the browser streams the zip to disk, however big it is.
      el('a', { class: 'kit-btn kit-btn--primary', href: '/api/admin/export', download: '', text: t('admin.data.exportButton') })),
    el('p', { class: 'kit-hint', text: t('admin.data.exportWarning') }),
    el('h2', { text: t('admin.data.importTitle'), style: 'margin-top: 28px' }),
    el('p', { class: 'kit-lead', text: t('admin.data.importLead', { app: app.name || '' }) }),
    el('div', { class: 'kit-toolbar' }, field(t('admin.data.file'), file), upload),
    result,
  );
}

/** The groups others share that "replace" takes an account here out of, in a line; '' when none. */
const handOverText = (target) => (target?.hand_over?.length
  ? t('admin.data.handOver', { names: listFormat({ type: 'conjunction' }).format(target.hand_over.map((o) => o.name)) }) : '');

/** What importing the copy would do: where each of its accounts goes, and doing it. */
function paintPlan(box, plan, reset) {
  const copy = plan.copy;
  const date = formatDateTime(copy.created_at);
  const version = copy.app?.version || '';
  const appName = copy.app?.name || state.config.app?.name || '';
  const decisions = [];
  const idp = state.config.provider !== 'local';

  const rows = plan.accounts.map((account) => {
    const { source, choice } = account;
    const target = el('select', { 'aria-label': t('admin.data.goesTo') },
      el('option', { value: 'create', text: t('admin.data.newAccount') }),
      el('option', { value: 'skip', text: t('admin.data.skip') }),
      plan.targets.map((u) => el('option', { value: String(u.id), text: `${u.display_name} (@${u.username})` })));
    target.value = choice.action === 'map' ? String(choice.user_id) : choice.action;
    const username = el('input', {
      value: choice.username || source.username, maxlength: '32', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false',
    });
    const email = el('input', { type: 'email', value: choice.email ?? '', autocomplete: 'off' });
    const replace = el('input', { type: 'checkbox', checked: Boolean(choice.replace) });
    // Aligned at the top: a hint under one field mustn't stretch the one beside it.
    const options = el('div', { class: 'kit-grid', style: 'align-items: start; margin-top: 8px' });
    const paint = () => {
      clear(options);
      if (target.value === 'create') {
        options.append(
          field(t('fields.username'), username),
          field(t('fields.email'), email, idp ? t('admin.data.linkHint', { provider: state.config.name }) : t('admin.data.newLocalHint')));
      } else if (target.value !== 'skip') {
        const here = plan.targets.find((u) => String(u.id) === target.value);
        const leaves = handOverText(here);
        // The kit's append: the element's own would write the hint left out as the text "null".
        append(options, sum(here?.owns) || leaves
          ? el('label', { class: 'kit-check' }, replace, el('span', { text: t('admin.data.replace', { rows: rowsText(here.owns) }) }))
          : el('p', { class: 'kit-hint', text: t('admin.data.nothingOwned') }),
        leaves ? el('p', { class: 'kit-hint', text: leaves }) : null);
      }
    };
    target.addEventListener('change', () => { replace.checked = false; paint(); });
    paint();
    decisions.push(() => {
      if (target.value === 'skip') return { source: source.id, skip: true };
      if (target.value === 'create') {
        return { source: source.id, create: { username: username.value.trim() || null, email: email.value.trim() || null } };
      }
      return { source: source.id, user_id: Number(target.value), replace: replace.checked };
    });
    return el('tr', {},
      el('td', {},
        el('strong', { text: source.display_name }),
        el('small', { text: `@${source.username} · ${source.email || t('admin.data.noEmail')}` }),
        source.role === 'admin' ? el('span', { class: 'kit-badge kit-badge--accent', text: t('admin.roles.admin') }) : null,
        source.disabled ? el('span', { class: 'kit-badge kit-badge--danger', text: t('admin.users.disabledBadge') }) : null,
        el('small', { text: rowsText(account.rows) })),
      el('td', {}, el('div', { class: 'kit-field' }, target), options));
  });

  const apply = el('button', {
    type: 'button', class: 'kit-btn kit-btn--primary', text: t('admin.data.apply'), disabled: Boolean(copy.applied_at),
    onClick: async () => {
      const accounts = decisions.map((decide) => decide());
      // Who leaves which groups others share, said again with the rest (the groups' names, as people wrote them).
      const leaving = accounts.filter((a) => a.replace).map((a) => plan.targets.find((u) => u.id === a.user_id))
        .filter((u) => u?.hand_over?.length)
        .map((u) => t('admin.data.confirmHandOver', { account: `@${u.username}`, names: listFormat({ type: 'conjunction' }).format(u.hand_over.map((o) => o.name)) }));
      if (accounts.some((a) => a.replace) && !(await confirmDialog([t('admin.data.confirmReplace'), ...leaving].join(' ')))) return;
      apply.disabled = true;
      apply.textContent = t('admin.data.applying');
      try {
        paintDone(box, await api.post(`/api/admin/import/${plan.import_id}`, { accounts }));
        reset();
      } catch (err) {
        fail(err);
        apply.disabled = false;
        apply.textContent = t('admin.data.apply');
      }
    },
  });
  const discard = el('button', {
    type: 'button', class: 'kit-btn', text: t('admin.data.discard'),
    onClick: async () => {
      try { await api.delete(`/api/admin/import/${plan.import_id}`); } catch { /* it expires by itself */ }
      clear(box);
      reset();
      toast(t('admin.data.discarded'));
    },
  });

  clear(box).append(
    el('div', { class: 'kit-notice' },
      el('p', {
        text: copy.scope === 'install'
          ? t('admin.data.copyInstall', { app: appName, version, date })
          : t('admin.data.copyAccount', { name: plan.accounts[0]?.source.display_name || '', app: appName, version, date }),
      }),
      copy.source?.base_url ? el('p', { class: 'kit-hint', text: t('admin.data.from', { url: copy.source.base_url }) }) : null,
      el('p', { text: `${t('admin.data.accountsCount', { n: plan.accounts.length })} · ${rowsText(copy.tables, copy.file_tables)} · ${t('admin.data.filesCount', { n: copy.files?.count ?? 0 })}` }),
      copy.applied_at ? el('p', { class: 'kit-badge kit-badge--warn', text: t('admin.data.alreadyApplied', { date: formatDateTime(copy.applied_at) }) }) : null),
    el('h3', { text: t('admin.data.accounts') }),
    table([t('admin.data.inCopy'), t('admin.data.goesTo')], rows),
    el('div', { class: 'kit-row' }, apply, discard),
  );
}

/** What the import did, and what it left out. */
function paintDone(box, done) {
  const files = done.left_out?.files || {};
  const created = done.accounts.filter((a) => a.created);
  const leftOut = done.left_out?.tables || {};
  clear(box).append(el('div', { class: 'kit-notice' },
    el('p', {
      text: t('admin.data.done', {
        accounts: t('admin.data.accountsCount', { n: done.accounts.length }),
        rows: rowsText(done.imported.tables, done.file_tables), files: t('admin.data.filesCount', { n: done.imported.files }),
      }),
    }),
    created.length ? el('p', { class: 'kit-hint', text: t('admin.data.created', { names: created.map((a) => `@${a.username}`).join(', ') }) }) : null,
    sum(leftOut, done.file_tables) ? el('p', { class: 'kit-hint', text: t('admin.data.leftOutRows', { rows: rowsText(leftOut, done.file_tables) }) }) : null,
    files.missing || files.refused || files.too_large ? el('p', {
      class: 'kit-hint',
      text: t('admin.data.leftOutFiles', { missing: files.missing || 0, refused: files.refused || 0, large: files.too_large || 0 }),
    }) : null));
  toast(t('admin.saved'));
}

/* -------------------------------- notices --------------------------------- */

/** The language the panel is drawn in: what notices are written in when their texts are the default. */
const panelLanguage = () => (document.documentElement.lang || 'en').slice(0, 2).toLowerCase();
/** This browser's time zone: the daily summary's hour is read in it. */
const browserZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};

/**
 * Administration › Notifications (admin-notices.js), in three cards: where notices go (folded once
 * it's set: an ntfy topic, an email address), what each group of events does (at once, in the
 * daily summary, nothing) with how it will read, and the daily summary. Test and pause sit in the
 * head beside how things stand. The server checks it all; this page sends it as a whole.
 */
async function renderNotices(main) {
  const view = await api.get('/api/admin/notices');
  const groups = view.groups_order;
  const keys = [...groups, 'digest'];
  const paused = view.paused_until && Date.parse(view.paused_until) > Date.now();
  const hasNtfy = Boolean(view.ntfy.url && view.ntfy.topic);
  const hasDestination = hasNtfy || Boolean(view.email);

  /* where they go */
  const url = el('input', { type: 'url', value: view.ntfy.url, placeholder: 'https://ntfy.sh/', autocomplete: 'off', spellcheck: 'false' });
  const topic = el('input', { type: 'text', value: view.ntfy.topic, autocomplete: 'off', spellcheck: 'false', maxlength: 64 });
  const token = el('input', {
    type: 'password', value: '', autocomplete: 'new-password',
    placeholder: view.ntfy.has_token ? t('admin.notices.tokenKept') : '',
  });
  const forgetToken = el('input', { type: 'checkbox' });
  const email = el('input', { type: 'email', value: view.email, autocomplete: 'off', disabled: !view.mail_available });
  const via = Object.fromEntries(['instant', 'digest'].map((when) => [when, Object.fromEntries(view.channels.map((c) => [c,
    el('input', { type: 'checkbox', checked: view.via[when].includes(c), disabled: c === 'email' && !view.mail_available })]))]));
  // Each way of sending, and the channels it goes by: one line, «At once ☑ ntfy ☐ Email · Summary …».
  const viaLine = el('div', { class: 'kit-notices__via', role: 'group', 'aria-label': t('admin.notices.sendBy') },
    el('span', { class: 'kit-hint', text: t('admin.notices.sendBy') },),
    ['instant', 'digest'].map((when) => el('span', { class: 'kit-row' },
      el('span', { text: t(`admin.notices.viaShort.${when}`) }),
      view.channels.map((c) => el('label', { class: 'kit-check' }, via[when][c], el('span', { text: t(`admin.notices.channel.${c}`) }))))));
  const whereNow = hasNtfy
    ? `${view.ntfy.url.replace(/^https:\/\//, '').replace(/\/$/, '')} / ${view.ntfy.topic}${view.ntfy.has_token ? ` · ${t('admin.notices.tokenSaved')}` : ''}`
    : view.email || el('small', { class: 'kit-fold__now kit-fold__now--warn', text: t('admin.notices.nowhere') });
  const where = slidingDetails(el('details', { class: 'kit-fold', open: !hasDestination },
    el('summary', {}, icon('phone'), el('span', { text: t('admin.notices.where') }),
      typeof whereNow === 'string' ? el('small', { class: 'kit-fold__now', text: whereNow }) : whereNow,
      icon('chevron-down', { className: 'kit-fold__chevron' })),
    el('div', { class: 'kit-fold__body' },
      el('p', { class: 'kit-hint', text: t('admin.notices.ntfyHow') }),
      el('div', { class: 'kit-grid kit-grid--3' },
        field(t('admin.notices.ntfyUrl'), url),
        field(t('admin.notices.ntfyTopic'), topic),
        field(t('admin.notices.ntfyToken'), token, t('admin.notices.ntfyTokenHint'))),
      view.ntfy.has_token ? el('label', { class: 'kit-check' }, forgetToken, el('span', { text: t('admin.notices.forgetToken') })) : null,
      field(t('admin.notices.email'), email, view.mail_available ? null : t('admin.notices.noMail')),
      viaLine)));

  /* what each group does, and its words */
  const modes = {};
  const modeBoxes = {};
  const templates = {};
  const previews = {};
  const defaultsOf = (k) => t(`notices.template.${k}`);
  // Each template's last preview asked for: an answer that comes after a newer one was asked is dropped.
  const turns = {};
  const paintPreview = async (k) => {
    turns[k] = (turns[k] || 0) + 1;
    const mine = turns[k];
    let text;
    try {
      ({ text } = await api.post('/api/admin/notices/preview', { key: k, template: templates[k].value || null, lang: panelLanguage() }));
    } catch {
      text = t('admin.notices.previewBad');
    }
    if (mine === turns[k]) previews[k].textContent = text;
  };
  const timers = {};
  /** The words of a group, folded under its row until its pencil opens them: the text, its variables, the default. */
  const editorOf = (k) => {
    templates[k] = el('textarea', {
      rows: k === 'digest' ? 5 : 2, maxlength: view.template_max, spellcheck: 'true',
      placeholder: defaultsOf(k), 'aria-label': t('admin.notices.wordsOf', { group: t(`admin.notices.group.${k}`) }),
    });
    templates[k].value = view.templates[k] || '';
    templates[k].addEventListener('input', () => {
      clearTimeout(timers[k]);
      timers[k] = setTimeout(() => paintPreview(k), 300);
    });
    // A variable pressed goes where the cursor is, as if typed.
    const insert = (name) => {
      const box = templates[k];
      const text = `{${name}}`;
      const from = box.selectionStart ?? box.value.length;
      const to = box.selectionEnd ?? from;
      box.setRangeText(text, from, to, 'end');
      box.focus();
      box.dispatchEvent(new Event('input'));
    };
    const reset = el('button', {
      type: 'button', class: 'kit-btn kit-btn--quiet kit-btn--small', text: t('admin.notices.useDefault'),
      onClick: () => {
        templates[k].value = defaultsOf(k);
        templates[k].dispatchEvent(new Event('input'));
      },
    });
    const editor = el('div', { class: 'kit-notices__editor', hidden: true },
      el('p', { class: 'kit-hint', text: t(`admin.notices.about.${k}`) }),
      templates[k],
      el('div', { class: 'kit-notices__vars', role: 'group', 'aria-label': t('admin.notices.insert') },
        view.variables[k].map((v) => el('button', { type: 'button', text: `{${v}}`, onClick: () => insert(v) })),
        reset));
    return editor;
  };
  /** The pencil that opens a group's words, and closes them. */
  const pencil = (k, editor) => {
    const button = el('button', {
      type: 'button', class: 'kit-icon-btn kit-icon-btn--small', 'aria-expanded': 'false',
      'aria-label': t('admin.notices.editWords', { group: t(`admin.notices.group.${k}`) }),
      title: t('admin.notices.editWords', { group: t(`admin.notices.group.${k}`) }),
    }, icon('edit'));
    button.addEventListener('click', () => {
      const open = editor.hidden;
      editor.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      clear(button).append(icon(open ? 'x' : 'edit'));
      // The default words to start from, not an empty box: the same words are saved as the default.
      if (open && !templates[k].value.trim()) templates[k].value = defaultsOf(k);
      if (open) templates[k].focus();
    });
    return button;
  };
  const groupRow = (k) => {
    const editor = editorOf(k);
    previews[k] = el('p', { class: 'kit-notices__preview', 'aria-live': 'polite' });
    const row = el('div', { class: 'kit-notices__row', 'data-mode': view.groups[k] });
    modes[k] = view.groups[k];
    modeBoxes[k] = segmented(view.modes.map((m) => ({ value: m, label: t(`admin.notices.modeShort.${m}`) })), modes[k], (m) => {
      modes[k] = m;
      row.dataset.mode = m;
      // The Save watches for change, as it does on the inputs.
      modeBoxes[k].dispatchEvent(new Event('change'));
    });
    modeBoxes[k].setAttribute('aria-label', t('admin.notices.whenOf', { group: t(`admin.notices.group.${k}`) }));
    paintPreview(k);
    append(row,
      el('span', { class: 'kit-notices__name', text: t(`admin.notices.group.${k}`) }),
      modeBoxes[k],
      pencil(k, editor),
      previews[k],
      editor);
    return row;
  };

  const hour = el('select', { 'aria-label': t('admin.notices.hour') }, Array.from({ length: 24 }, (_, h) => el('option', {
    value: String(h), text: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, h)),
  })));
  hour.value = String(view.digest.hour);
  const country = el('input', { type: 'checkbox', checked: view.country, disabled: !view.country_available });
  const totals = el('input', { type: 'checkbox', checked: view.totals });

  const ownWords = (k) => {
    const words = templates[k].value.trim();
    return words && words !== defaultsOf(k).trim() ? words : null;
  };
  const read = () => ({
    groups: Object.fromEntries(groups.map((g) => [g, modes[g]])),
    // The default's own words are no words of the admin's: kept as the default, in every language.
    templates: Object.fromEntries(keys.map((k) => [k, ownWords(k)])),
    country: country.checked,
    totals: totals.checked,
    via: Object.fromEntries(['instant', 'digest'].map((when) => [when, view.channels.filter((c) => via[when][c].checked)])),
    digest: { hour: Number(hour.value), zone: browserZone() },
    ntfy: { url: url.value.trim(), topic: topic.value.trim(), token: forgetToken.checked ? '' : (token.value.trim() || null) },
    email: email.value.trim(),
    lang: panelLanguage(),
  });
  // The rows exist before the button that watches them.
  const rows = groups.map(groupRow);
  const digestEditor = editorOf('digest');
  previews.digest = el('p', { class: 'kit-notices__preview', 'aria-live': 'polite' });
  paintPreview('digest');
  const controls = [url, topic, token, forgetToken, email, hour, country, totals,
    ...Object.values(via).flatMap((row) => Object.values(row)), ...Object.values(templates), ...Object.values(modeBoxes)];
  const [save, saved] = saveButton({
    label: t('admin.notices.save'),
    controls,
    read,
    save: async () => {
      const sent = read();
      await api.put('/api/admin/notices', sent);
      // A new destination is drawn anew: its fold sums it up, and a token given is kept and never
      // shown again (the field empties and says so). The rest stays as it is, with "Saved".
      if (token.value || forgetToken.checked || sent.ntfy.url !== view.ntfy.url || sent.ntfy.topic !== view.ntfy.topic
        || sent.email !== view.email) show();
    },
  });

  const test = el('button', {
    type: 'button', class: 'kit-btn kit-btn--small', text: t('admin.notices.test'),
    onClick: async () => {
      test.disabled = true;
      try {
        const { results } = await api.post('/api/admin/notices/test', {});
        const bad = results.filter((r) => !r.ok);
        if (bad.length) toast(t('admin.notices.testFailed', { list: bad.map((r) => `${t(`admin.notices.channel.${r.channel}`)}: ${r.error}`).join(' · ') }), { error: true });
        else toast(t('admin.notices.testSent', { list: listFormat({ type: 'conjunction' }).format(results.map((r) => t(`admin.notices.channel.${r.channel}`))) }));
      } catch (err) { fail(err); }
      test.disabled = false;
    },
  });

  /* the pause: a menu of how long, in the head; paused, a notice that says until when */
  const pauseUntil = (choice) => {
    if (choice === 'hour') return new Date(Date.now() + 3600 * 1000).toISOString();
    if (choice === 'tomorrow') {
      const at = new Date();
      at.setDate(at.getDate() + 1);
      at.setHours(view.digest.hour, 0, 0, 0);
      return at.toISOString();
    }
    return '9999-12-31T00:00:00.000Z';
  };
  const setPause = async (until) => {
    try {
      await api.put('/api/admin/notices', { paused_until: until });
      show();
    } catch (err) { fail(err); }
  };
  const forever = paused && Date.parse(view.paused_until) > Date.parse('9000-01-01');
  const pauseButton = el('button', { type: 'button', class: 'kit-btn kit-btn--small', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
    el('span', { text: t('admin.notices.pauseNow') }), icon('chevron-down'));
  pauseButton.addEventListener('click', () => menu(pauseButton, ['hour', 'tomorrow', 'forever'].map((p) => ({
    label: t(`admin.notices.pause.${p}`), onClick: () => setPause(pauseUntil(p)),
  }))));
  const pauseBox = paused
    ? el('div', { class: 'kit-notice' },
      el('p', { text: forever ? t('admin.notices.pausedForever') : t('admin.notices.pausedUntil', { date: formatDateTime(view.paused_until) }) }),
      el('button', { type: 'button', class: 'kit-btn kit-btn--small kit-btn--primary', text: t('admin.notices.resume'), onClick: () => setPause(null) }))
    : null;

  // How things stand, in a word and the last delivery.
  const standing = paused ? el('span', { class: 'kit-badge kit-badge--warn', text: t('admin.notices.state.paused') })
    : hasDestination ? el('span', { class: 'kit-badge kit-badge--ok', text: t('admin.notices.state.on') })
      : el('span', { class: 'kit-badge', text: t('admin.notices.state.nowhere') });
  const last = view.last
    ? el('span', { class: 'kit-hint', text: t('admin.notices.last', {
      date: formatDateTime(view.last.at),
      list: view.last.results.map((r) => `${t(`admin.notices.channel.${r.channel}`)} ${r.ok ? '✓' : `✗ ${r.error}`}`).join(' · '),
    }) })
    : null;

  const card = (iconName, title, extra, ...body) => el('section', { class: 'kit-notices__card' },
    el('div', { class: 'kit-notices__card-head' }, icon(iconName), el('h3', { text: title }), extra),
    ...body);

  append(main,
    el('div', { class: 'kit-notices__head' },
      el('div', { class: 'kit-row' }, el('h2', { text: t('admin.notices.title') }), standing, last),
      el('div', { class: 'kit-row' }, test, paused ? null : pauseButton)),
    el('p', { class: 'kit-hint', text: t('admin.notices.lead') }),
    pauseBox,
    el('div', { class: 'kit-notices' },
      where,
      card('bell', t('admin.notices.what'),
        el('div', { class: 'kit-notices__extras' },
          el('label', { class: 'kit-check' }, country, el('span', { text: t('admin.notices.countryShort') })),
          el('label', { class: 'kit-check' }, totals, el('span', { text: t('admin.notices.totalsShort') }))),
        view.country_available ? null : el('p', { class: 'kit-hint', text: t('admin.notices.noCountry') }),
        el('div', { class: 'kit-notices__rows' }, rows),
        el('p', { class: 'kit-hint kit-notices__rules', text: t('admin.notices.rules', { n: view.burst.count, minutes: view.burst.minutes }) })),
      card('calendar', t('admin.notices.group.digest'),
        el('div', { class: 'kit-notices__hour' },
          el('span', { class: 'kit-hint', text: t('admin.notices.everyDayAt') }), hour,
          el('span', { class: 'kit-hint', text: browserZone() }),
          pencil('digest', digestEditor)),
        previews.digest,
        digestEditor),
      el('div', { class: 'kit-row kit-notices__save' }, saved, save)),
  );
}

/* ---------------------------------- audit ---------------------------------- */

/** A family of actions in words (`device`: "Devices"), or its name when there are none for it. */
const kindText = (kind) => {
  const key = `admin.audit.kinds.${kind}`;
  const text = t(key);
  return text === key ? kind : text;
};
/** An account as Activity's search names it: by its email, or by @username without one. */
const accountName = (user) => user.email || `@${user.username}`;

/**
 * The log, newest first, 50 at a time: of one account (its email or username typed, or its name
 * in a row pressed), of a family of actions or one of them, and between two days. The address
 * keeps the filters (`#/audit?actor=12&action=device.create&since=2026-11-01`): an account's
 * dialog opens Activity that way, and a reload leaves them as they were.
 */
async function renderAudit(main) {
  const asked = hashQuery();
  // What there is to show: each family of the actions the log holds, and each action in it.
  const actions = (await api.get('/api/admin/audit/actions').catch(() => null))?.actions || [];
  const families = new Map();
  for (const action of actions) {
    const family = action.split('.')[0];
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(action);
  }
  const kind = el('select', {},
    el('option', { value: '', text: t('admin.audit.all') }),
    [...families].map(([family, names]) => el('optgroup', { label: kindText(family) },
      el('option', { value: `${family}.`, text: t('admin.audit.allOf', { kind: kindText(family) }) }),
      names.map((name) => el('option', { value: name, text: actionText(name) })))));
  kind.value = asked.get('action') || '';
  const who = el('input', {
    type: 'search', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false',
    list: 'admin-audit-accounts', placeholder: t('admin.audit.accountHint'),
  });
  const suggestions = el('datalist', { id: 'admin-audit-accounts' });
  const whoSaid = el('p', { class: 'kit-hint', 'aria-live': 'polite', hidden: true });
  const since = el('input', { type: 'date', value: asked.get('since') });
  const until = el('input', { type: 'date', value: asked.get('until') });
  const reset = el('button', { type: 'button', class: 'kit-btn kit-btn--small', text: t('admin.audit.clear') });
  const body = el('tbody', {});
  const more = el('button', { type: 'button', class: 'kit-btn kit-btn--small', text: t('admin.audit.more') });
  const askedActor = Number(asked.get('actor'));
  let actor = Number.isInteger(askedActor) && askedActor > 0 ? askedActor : null;
  let accounts = [];
  let before = null;
  let asking = 0;

  /** The filters as the address writes them. */
  const filters = () => {
    const query = new URLSearchParams();
    if (actor) query.set('actor', String(actor));
    if (kind.value) query.set('action', kind.value);
    if (since.value) query.set('since', since.value);
    if (until.value) query.set('until', until.value);
    return query;
  };

  const load = async (fresh) => {
    const ask = ++asking;
    const query = new URLSearchParams({ limit: '50' });
    if (actor) query.set('actor', String(actor));
    // A family ends in a dot (`device.`); anything else is that action alone.
    if (kind.value) query.set('action', kind.value);
    if (kind.value && !kind.value.endsWith('.')) query.set('exact', '1');
    // The days as this browser lives them: from the first moment of one to the last of the other.
    if (since.value) query.set('since', new Date(`${since.value}T00:00:00`).toISOString());
    if (until.value) query.set('until', new Date(`${until.value}T23:59:59.999`).toISOString());
    if (!fresh && before) query.set('before', String(before));
    const { entries } = await api.get(`/api/admin/audit?${query}`);
    // Another filter was chosen meanwhile: its answer is the one to draw.
    if (ask !== asking) return;
    if (fresh) { clear(body); before = null; }
    for (const e of entries) {
      // The assistant someone acted through goes with them, not among the details.
      const { via, ...rest } = e.meta || {};
      const meta = Object.entries(rest).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
      const name = e.actor_username ? `@${e.actor_username}` : '—';
      const whoText = via ? t('admin.audit.via', { who: name, via }) : name;
      // Their name shows only what they did.
      const byThem = e.actor_user_id && e.actor_user_id !== actor ? el('button', {
        type: 'button', class: 'kit-link', title: t('admin.audit.onlyThem'), text: whoText,
        onClick: () => {
          const account = accounts.find((u) => u.id === e.actor_user_id);
          who.value = account ? accountName(account) : name;
          choose(e.actor_user_id);
        },
      }) : null;
      body.append(el('tr', {},
        el('td', { text: formatDateTime(e.at, { dateStyle: 'short', timeStyle: 'medium' }) }),
        byThem ? el('td', {}, byThem) : el('td', { text: whoText }),
        el('td', {}, el('span', { text: actionText(e.action) }), el('small', { class: 'kit-mono', text: e.action })),
        el('td', { text: e.target_type ? `${e.target_type} ${e.target_id ?? ''}`.trim() : '' }),
        el('td', { class: 'kit-mono', text: e.ip || '' }),
        el('td', { class: 'kit-mono', text: meta })));
    }
    if (entries.length) before = entries.at(-1).id;
    more.hidden = entries.length < 50;
    if (!body.childElementCount) {
      body.append(el('tr', {}, el('td', { colspan: '6', class: 'kit-empty', text: t(filters().toString() ? 'admin.audit.noneFiltered' : 'admin.audit.none') })));
    }
  };

  /** The address with the filters, the list again from the newest, and a way to take them off. */
  const changed = () => {
    const query = filters().toString();
    window.history?.replaceState(null, '', `#/audit${query ? `?${query}` : ''}`);
    reset.hidden = !query;
    load(true).catch(fail);
  };
  /** Whose activity it is, and what the typed text found when it wasn't one account. */
  const paintWho = (found = null) => {
    const account = actor ? accounts.find((u) => u.id === actor) : null;
    const typed = who.value.trim();
    const text = [
      found === 0 ? t('admin.audit.noAccount', { query: typed }) : found > 1 ? t('admin.audit.manyAccounts', { n: found }) : '',
      actor ? t('admin.audit.onlyOf', { name: account ? `${account.display_name} (@${account.username})` : `#${actor}` }) : '',
    ].filter(Boolean).join(' ');
    whoSaid.textContent = text;
    whoSaid.hidden = !text;
  };
  const choose = (id) => {
    if (id === actor) return paintWho();
    actor = id;
    paintWho();
    return changed();
  };
  /** The account a text names: the one whose email or username it is, else the only one it is part of. */
  const chooseFrom = (text) => {
    const query = folded(text.trim().replace(/^@/, ''));
    if (!query) return choose(null);
    const exact = accounts.filter((u) => folded(u.email) === query || folded(u.username) === query);
    const found = exact.length ? exact : accounts.filter((u) => hasWords(accountText(u), query));
    return found.length === 1 ? choose(found[0].id) : paintWho(found.length);
  };
  let typing = null;
  who.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => chooseFrom(who.value), 300);
  });
  who.addEventListener('change', () => {
    clearTimeout(typing);
    chooseFrom(who.value);
  });
  for (const control of [kind, since, until]) control.addEventListener('change', changed);
  reset.addEventListener('click', () => {
    actor = null;
    for (const control of [who, kind, since, until]) control.value = '';
    paintWho();
    changed();
  });
  reset.hidden = !filters().toString();
  more.addEventListener('click', () => load(false).catch(fail));
  // The accounts to type, when they come; the list doesn't wait for them.
  api.get('/api/admin/users').then(({ users }) => {
    accounts = users;
    append(clear(suggestions), users.map((u) => el('option', { value: accountName(u), label: `${u.display_name} (@${u.username})` })));
    const chosen = accounts.find((u) => u.id === actor);
    if (chosen && !who.value) who.value = accountName(chosen);
    paintWho();
  }).catch(() => paintWho()); // typed, nobody is found; a name in a row still shows their activity

  main.append(
    el('h2', { text: t('admin.audit.title') }),
    el('p', { class: 'kit-lead', text: t('admin.audit.lead') }),
    el('div', { class: 'kit-toolbar' },
      field(t('admin.audit.account'), who), suggestions,
      field(t('admin.audit.show'), kind),
      field(t('admin.audit.since'), since),
      field(t('admin.audit.until'), until),
      reset),
    whoSaid,
    el('div', { class: 'kit-table-wrap' }, el('table', { class: 'kit-table' },
      el('thead', {}, el('tr', {}, [t('admin.audit.when'), t('admin.audit.who'), t('admin.audit.what'), t('admin.audit.on'), t('admin.audit.from'), t('admin.audit.details')]
        .map((h) => el('th', { text: h })))),
      body)),
    el('div', { class: 'kit-row', style: null }, more),
  );
  await load(true);
}

/* -------------------------------- affiliates ------------------------------- */

/** Cents as money, in the panel's language. */
const money = (cents, currency) => numberFormat({ style: 'currency', currency: currency || 'EUR' }).format((Number(cents) || 0) / 100);
/** What a code takes off: `3,90 € off the first payment`, `20 % off the first year`. */
const offerText = (offer) => (offer?.type === 'flat'
  ? t('affiliates.offer.flat', { amount: money(offer.amount, offer.currency) })
  : t('affiliates.offer.percent', { percent: offer?.percent ?? 0 }));
/** Euros as typed (`6`, `6,50`, `6.50`) in cents, or null. */
const centsOf = (text) => {
  const value = Number(String(text || '').trim().replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
};

/**
 * Administration › Affiliates (affiliates.js): every code, a referral's or a creator's, with its
 * owner, the accounts it brought, its sales by state, what it earned, what was paid and what is
 * owed; filtered by kind. A row opens its commissions; a creator's campaign is made here, and the
 * payouts made to them noted.
 */
async function renderAffiliates(main) {
  const kind = hashQuery().get('kind') || '';
  const view = await api.get(`/api/admin/affiliates${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`);
  const filter = segmented([
    { value: '', label: t('admin.affiliates.all') },
    { value: 'referral', label: t('affiliates.kind.referral') },
    { value: 'creator', label: t('affiliates.kind.creator') },
  ], kind, (value) => { window.location.hash = value ? `#/affiliates?kind=${value}` : '#/affiliates'; });
  filter.setAttribute('aria-label', t('admin.affiliates.filter'));
  // What a payout is noted against: the program's least, said in its dialog.
  state.affiliateMinimum = view.rules.creator.payout_minimum ?? null;
  const earnedOf = (code) => (code.cash ? money(code.figures.earned, code.currency) : t('affiliates.months', { n: code.figures.months }));
  const rows = view.codes.map((code) => el('tr', {},
    el('td', {}, el('strong', { text: code.owner?.display_name || t('admin.affiliates.gone') }), el('small', { text: code.owner?.email || '' })),
    el('td', { text: t(`affiliates.kind.${code.kind}`) }),
    el('td', { text: code.campaign || '' }),
    el('td', {}, el('code', { class: 'kit-mono', text: code.code }),
      code.active ? null : el('span', { class: 'kit-badge kit-badge--warn', text: t('admin.affiliates.off') })),
    el('td', { text: String(code.figures.accounts) }),
    el('td', { text: `${code.figures.pending} / ${code.figures.confirmed} / ${code.figures.reversed}` }),
    el('td', { text: earnedOf(code) }),
    el('td', { text: code.cash ? money(code.figures.paid, code.currency) : '' }),
    el('td', { text: code.cash ? money(code.figures.balance, code.currency) : '' }),
    el('td', {}, el('button', {
      type: 'button', class: 'kit-link', text: t('admin.affiliates.open'),
      onClick: () => affiliateDialog(code.id).catch(fail),
    }))));
  append(main,
    el('h2', { text: t('admin.affiliates.title') }),
    el('p', { class: 'kit-lead', text: t(view.enabled ? 'admin.affiliates.leadOn' : 'admin.affiliates.leadOff') }),
    view.discounts ? null : el('p', { class: 'kit-notice', text: t('admin.affiliates.noDiscounts') }),
    el('div', { class: 'kit-toolbar' },
      filter,
      el('button', {
        type: 'button', class: 'kit-btn kit-btn--primary', text: t('admin.affiliates.new'),
        onClick: () => campaignDialog(view),
      }),
      el('a', {
        class: 'kit-btn', href: `/api/admin/affiliates/export${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`, download: '',
        text: t('admin.affiliates.export'),
      })),
    view.codes.length ? table([
      t('admin.affiliates.owner'), t('fields.kind'), t('fields.campaign'), t('fields.code'), t('admin.affiliates.accounts'),
      t('admin.affiliates.sales'), t('admin.affiliates.earned'), t('admin.affiliates.paid'), t('admin.affiliates.balance'), '',
    ], rows) : el('p', { class: 'kit-empty', text: t('admin.affiliates.none') }),
  );
}

/** A creator's campaign: whose (by email), its code and name, what the buyer gets and what it earns. */
function campaignDialog(view) {
  const defaults = view.rules.creator;
  const email = el('input', { type: 'email', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '254' });
  const code = el('input', { autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '32', placeholder: 'MARIA20' }); // i18n-exempt: a code, the same in every language
  code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  const campaign = el('input', { maxlength: '80', autocomplete: 'off' });
  const offerType = el('select', {},
    el('option', { value: 'percent', text: t('admin.affiliates.offerPercent') }),
    el('option', { value: 'flat', text: t('admin.affiliates.offerFlat') }));
  offerType.value = defaults.offer.type;
  const offerValue = el('input', {
    inputmode: 'decimal', autocomplete: 'off',
    value: defaults.offer.type === 'flat' ? String(defaults.offer.amount / 100) : String(defaults.offer.percent),
  });
  const products = (view.products.length ? view.products : defaults.products).map((key) => {
    const box = el('input', { type: 'checkbox', value: key });
    box.checked = defaults.products.includes(key);
    return box;
  });
  const reward = el('input', { inputmode: 'decimal', autocomplete: 'off', value: String(defaults.reward.cash / 100) });
  const note = el('input', { maxlength: '500', autocomplete: 'off', placeholder: t('admin.users.optional') });
  formDialog({
    title: t('admin.affiliates.new'),
    content: [
      el('p', { class: 'kit-hint', text: t('admin.affiliates.newLead') }),
      el('div', { class: 'kit-grid' },
        field(t('fields.email'), email, t('admin.affiliates.emailHint')),
        field(t('fields.code'), code, t('admin.affiliates.codeHint')),
        field(t('fields.campaign'), campaign)),
      el('div', { class: 'kit-grid' },
        field(t('fields.offer'), offerType),
        field(t('admin.affiliates.offerValue'), offerValue),
        field(t('fields.reward'), reward, t('admin.affiliates.rewardHint', { currency: defaults.reward.currency }))),
      el('div', { class: 'kit-field', role: 'group', 'aria-label': t('fields.products') },
        el('span', { text: t('fields.products') }),
        products.map((box) => el('label', { class: 'kit-check' }, box, el('span', { text: box.value })))),
      field(t('fields.note'), note),
    ],
    actions: [
      { label: t('admin.cancel') },
      { label: t('admin.affiliates.create'), primary: true, submit: true },
    ],
    onSubmit: async () => {
      const flat = offerType.value === 'flat';
      const body = {
        email: email.value.trim(), code: code.value.trim(), campaign: campaign.value.trim() || null, note: note.value.trim() || null,
        offer: flat ? { type: 'flat', amount: centsOf(offerValue.value), currency: defaults.reward.currency }
          : { type: 'percent', percent: Math.round(Number(offerValue.value.replace(',', '.'))) },
        products: products.filter((box) => box.checked).map((box) => box.value),
        reward: { cash: centsOf(reward.value), currency: defaults.reward.currency },
      };
      const { code: made } = await api.post('/api/admin/affiliates', body);
      toast(t(made.discount || !view.discounts ? 'admin.affiliates.created' : 'admin.affiliates.createdNoDiscount', { code: made.code }));
      show();
      return true;
    },
  });
  email.focus();
}

/** A code's commissions and payouts, switched on or off, and a payout noted for a creator's. */
async function affiliateDialog(id) {
  const { code, commissions, payouts } = await api.get(`/api/admin/affiliates/${id}/commissions`);
  const currency = code.currency;
  const statusBadge = (row) => el('span', {
    class: `kit-badge kit-badge--${{ pending: 'accent', confirmed: 'ok', paid: 'ok', reversed: 'warn' }[row.status] || 'accent'}`,
    text: t(`affiliates.status.${row.status}`),
  });
  const what = (row) => (row.entry === 'adjustment' ? t('admin.affiliates.adjustment')
    : row.reason === 'yearly_cap' ? t('admin.affiliates.capped') : row.refunded_at ? t('admin.affiliates.refundedLate') : '');
  const facts = el('div', { class: 'kit-facts' },
    el('div', { class: 'kit-fact' }, el('span', { text: t('admin.affiliates.owner') }),
      el('strong', { text: [code.owner?.display_name, code.owner?.email].filter(Boolean).join(' · ') || t('admin.affiliates.gone') })),
    el('div', { class: 'kit-fact' }, el('span', { text: t('fields.offer') }), el('strong', { text: offerText(code.offer) })),
    el('div', { class: 'kit-fact' }, el('span', { text: t('fields.products') }), el('strong', { text: code.products.join(', ') })),
    el('div', { class: 'kit-fact' }, el('span', { text: t('fields.reward') }),
      el('strong', { text: code.cash ? money(code.cash, currency) : t('affiliates.reward.month') })),
    code.cash ? el('div', { class: 'kit-fact' }, el('span', { text: t('admin.affiliates.balance') }), el('strong', { text: money(code.figures.balance, currency) })) : null,
    code.payout_note ? el('div', { class: 'kit-fact' }, el('span', { text: t('fields.payout_note') }), el('strong', { text: code.payout_note })) : null,
    code.note ? el('div', { class: 'kit-fact' }, el('span', { text: t('fields.note') }), el('strong', { text: code.note })) : null);
  const list = commissions.length ? table([
    t('admin.affiliates.paidOn'), t('admin.affiliates.buyer'), t('admin.affiliates.product'), t('admin.affiliates.state'), t('fields.amount'), '',
  ], commissions.map((row) => el('tr', {},
    el('td', {}, el('span', { text: formatDate(row.paid_at) }),
      row.status === 'pending' ? el('small', { text: t('admin.affiliates.confirmsOn', { date: formatDate(row.confirm_after) }) }) : null),
    el('td', { text: row.buyer.email || row.buyer.display_name || `#${row.buyer.id}` }),
    el('td', { text: row.product || '' }),
    el('td', {}, statusBadge(row)),
    el('td', { text: row.reward === 'pro_month' ? t('affiliates.reward.month') : money(row.amount, row.currency) }),
    el('td', { text: what(row) }))))
    : el('p', { class: 'kit-empty', text: t('admin.affiliates.noSales') });
  const paidList = payouts.length ? table([t('admin.affiliates.paidOn'), t('fields.amount'), t('fields.method'), t('fields.reference')],
    payouts.map((p) => el('tr', {}, el('td', { text: formatDate(p.paid_at) }), el('td', { text: money(p.amount, p.currency) }),
      el('td', { text: p.method || '' }), el('td', { text: p.reference || '' })))) : null;
  const dialog = openDialog({
    title: code.campaign ? `${code.code} · ${code.campaign}` : code.code,
    wide: true,
    content: [
      facts,
      el('h3', { text: t('admin.affiliates.commissions') }), list,
      code.cash ? el('h3', { text: t('admin.affiliates.payouts') }) : null,
      code.cash ? paidList || el('p', { class: 'kit-empty', text: t('admin.affiliates.noPayouts') }) : null,
    ],
    actions: [
      {
        label: t(code.active ? 'admin.affiliates.turnOff' : 'admin.affiliates.turnOn'), danger: code.active,
        onClick: async () => {
          try {
            await api.put(`/api/admin/affiliates/${code.id}`, { active: !code.active });
            show();
            return true;
          } catch (err) { fail(err); return false; }
        },
      },
      code.cash ? {
        label: t('admin.affiliates.recordPayout'), primary: true,
        onClick: () => { payoutDialog(code); return true; },
      } : null,
    ].filter(Boolean),
  });
  return dialog;
}

/** A payout made to a creator, noted: how much (what is owed, by default), how and its reference. */
function payoutDialog(code) {
  const minimum = state.affiliateMinimum;
  const amount = el('input', { inputmode: 'decimal', autocomplete: 'off', value: String(Math.max(0, code.figures.balance) / 100) });
  const method = el('input', { maxlength: '80', autocomplete: 'off', placeholder: t('admin.affiliates.methodHint') });
  const reference = el('input', { maxlength: '120', autocomplete: 'off' });
  // Today where the person noting it is: UTC's day is still yesterday in Madrid after midnight.
  const day = el('input', { type: 'date', value: dayKey(new Date()) });
  const note = el('input', { maxlength: '500', autocomplete: 'off', placeholder: t('admin.users.optional') });
  formDialog({
    title: t('admin.affiliates.recordPayout'),
    content: [
      el('p', { class: 'kit-hint', text: t('admin.affiliates.payoutLead', { balance: money(code.figures.balance, code.currency) }) }),
      code.payout_note ? el('p', { class: 'kit-notice', text: code.payout_note }) : null,
      minimum && code.figures.balance < minimum
        ? el('p', { class: 'kit-warning', text: t('admin.affiliates.belowMinimum', { minimum: money(minimum, code.currency) }) }) : null,
      el('div', { class: 'kit-grid' },
        field(t('fields.amount'), amount),
        field(t('fields.paid_at'), day),
        field(t('fields.method'), method),
        field(t('fields.reference'), reference)),
      field(t('fields.note'), note),
    ],
    actions: [
      { label: t('admin.cancel') },
      { label: t('admin.affiliates.savePayout'), primary: true, submit: true },
    ],
    onSubmit: async () => {
      await api.post(`/api/admin/affiliates/${code.id}/payouts`, {
        amount: centsOf(amount.value), method: method.value.trim() || null, reference: reference.value.trim() || null,
        note: note.value.trim() || null, paid_at: day.value ? new Date(`${day.value}T12:00:00`).toISOString() : null,
      });
      toast(t('admin.affiliates.payoutSaved'));
      show();
      return true;
    },
  });
  amount.focus();
}

start().catch(fail);
