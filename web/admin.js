/**
 * The admin panel of every app of the suite, at /admin: accounts, their plans
 * and grants, invitations, the plan catalog, groups, copies of the data and
 * the audit log, drawn on /api/admin/*. The server decides who may do what;
 * this page only shows what it answers, and says what it refuses.
 */
import { $, el, clear } from './dom.js';
import { api, errorMessage, SessionExpired } from './api.js';
import { t, loadLanguage, pickLanguage, formatDateTime, formatDate } from './i18n.js';
import { toast, field, openDialog, confirmDialog } from './ui.js';

const root = $('#admin');
const state = { config: null, me: null, catalog: null, organizations: false, invitations: false, data: false };

const TABS = [
  ['users', 'admin.tabs.users'],
  ['invitations', 'admin.tabs.invitations'],
  ['plans', 'admin.tabs.plans'],
  ['organizations', 'admin.tabs.organizations'],
  ['data', 'admin.tabs.data'],
  ['audit', 'admin.tabs.audit'],
];

/* --------------------------------- helpers --------------------------------- */

const local = () => state.config?.provider === 'local';
const planName = (id) => {
  const plan = state.catalog?.plans.find((p) => p.id === id);
  return plan ? t(plan.name) : id;
};
/** A feature in words: the app's text for it (features.<key>) when it has one, else its label. */
const featureLabel = (key) => {
  const text = t(`features.${key}`);
  return text === `features.${key}` ? state.catalog?.features[key]?.label || key : text;
};
const valueText = (key, value) => {
  const type = state.catalog?.features[key]?.type;
  if (type === 'flag') return value ? t('admin.plans.yes') : t('admin.plans.no');
  return value == null ? t('admin.plans.noLimit') : String(value);
};
/** An action of the log in words, or as it is when there are none for it. */
const actionText = (action) => {
  const key = `admin.actions.${String(action).replace(/\./g, '_')}`;
  const text = t(key);
  return text === key ? action : text;
};
/** A date input's day as the end of that day, in ISO. */
const endOfDay = (day) => (day ? new Date(`${day}T23:59:59`).toISOString() : null);

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
  await loadLanguage(pickLanguage([me?.locale, prefs.lang, navigator.languages || [], navigator.language], languages), { remember: false })
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
    && (id !== 'organizations' || state.organizations) && (id !== 'plans' || state.catalog) && (id !== 'data' || state.data));
}

const VIEWS = {
  users: renderUsers, invitations: renderInvitations, plans: renderPlans, organizations: renderOrganizations,
  data: renderData, audit: renderAudit,
};

function show() {
  const wanted = (window.location.hash.match(/^#\/(\w+)/) || [])[1];
  const tab = visibleTabs().some(([id]) => id === wanted) ? wanted : 'users';
  for (const link of document.querySelectorAll('.kit-tab')) {
    if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const main = clear($('#admin-main'));
  VIEWS[tab](main).catch(fail);
}

/* ---------------------------------- users ---------------------------------- */

async function renderUsers(main) {
  const { users } = await api.get('/api/admin/users');
  main.append(
    el('h2', { text: t('admin.users.title') }),
    el('p', { class: 'kit-lead', text: local() ? t('admin.users.leadLocal') : t('admin.users.leadIdp', { provider: state.config.name }) }),
    el('div', { class: 'kit-toolbar' },
      el('button', { type: 'button', class: 'kit-btn kit-btn--primary', text: t('admin.users.new'), onClick: newUserDialog })),
    table([t('admin.users.name'), t('admin.users.email'), t('admin.users.role'), t('admin.users.plan'), t('admin.users.lastSignIn')],
      users.map((user) => el('tr', { 'data-open': true, tabindex: '0', onClick: () => userDialog(user), onKeydown: (ev) => { if (ev.key === 'Enter') userDialog(user); } },
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
        el('td', {},
          user.unlimited ? el('span', { text: t('admin.users.unlimited') }) : el('span', { text: user.plan ? t(user.plan.name || user.plan.id) : '' }),
          user.plan_ends && !user.unlimited ? el('small', { text: t('admin.users.until', { date: formatDate(user.plan_ends) }) }) : null),
        el('td', { text: user.last_login_at ? formatDateTime(user.last_login_at) : t('admin.users.never') }))),
    ),
  );
}

function newUserDialog() {
  const username = el('input', { autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '32' });
  const name = el('input', { maxlength: '80' });
  const email = el('input', { type: 'email', autocomplete: 'off' });
  const role = el('select', {}, ['user', 'admin'].map((r) => el('option', { value: r, text: t(`admin.roles.${r}`) })));
  const password = el('input', { type: 'password', autocomplete: 'new-password' });
  openDialog({
    title: t('admin.users.new'),
    content: el('div', { class: 'kit-grid' },
      field(t('fields.username'), username),
      field(t('fields.display_name'), name),
      field(t('fields.email'), email, local() ? null : t('admin.users.idpEmailHint', { provider: state.config.name })),
      field(t('fields.role'), role),
      local() ? field(t('fields.password'), password, t('admin.users.passwordHint')) : null),
    actions: [
      { label: t('admin.cancel') },
      {
        label: t('admin.users.create'), primary: true,
        onClick: async () => {
          try {
            await api.post('/api/admin/users', {
              username: username.value.trim(), display_name: name.value.trim() || undefined,
              email: email.value.trim() || null, role: role.value, password: password.value || null,
            });
            toast(t('admin.users.created'));
            show();
            return true;
          } catch (err) {
            fail(err);
            return false;
          }
        },
      },
    ],
  });
  username.focus();
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
  const profile = el('div', { class: 'kit-section' },
    el('h3', { text: t('admin.users.profile') }),
    el('div', { class: 'kit-grid' },
      field(t('fields.display_name'), name),
      field(t('fields.email'), email, user.email && !user.email_verified ? t('admin.users.unconfirmed') : null),
      field(t('fields.role'), role)),
    local() ? el('label', { class: 'kit-check' }, verified, el('span', { text: t('admin.users.emailVerified') })) : null,
    local() && state.config.mail === false ? el('p', { class: 'kit-hint', text: t('admin.users.confirmByHand') }) : null,
    el('label', { class: 'kit-check' }, disabled, el('span', { text: t('admin.users.disabled') })),
    self ? el('p', { class: 'kit-hint', text: t('admin.users.notOnYourself') }) : null,
    el('div', { class: 'kit-row' },
      el('button', {
        type: 'button', class: 'kit-btn kit-btn--primary kit-btn--small', text: t('admin.save'),
        onClick: async () => {
          try {
            await api.patch(`/api/admin/users/${user.id}`, {
              display_name: name.value.trim(), email: email.value.trim() || null,
              ...(local() ? { email_verified: verified.checked && Boolean(email.value.trim()) } : {}),
              ...(self ? {} : { role: role.value, disabled: disabled.checked }),
            });
            toast(t('admin.saved'));
            refresh();
          } catch (err) { fail(err); }
        },
      })));

  // A new password (local accounts): their other sessions end.
  const password = el('input', { type: 'password', autocomplete: 'new-password' });
  const passwordSection = local() ? el('div', { class: 'kit-section' },
    el('h3', { text: t('admin.users.password') }),
    el('p', { class: 'kit-hint', text: t('admin.users.passwordLead') }),
    el('div', { class: 'kit-row' },
      field(t('fields.password'), password),
      el('button', {
        type: 'button', class: 'kit-btn kit-btn--small', text: t('admin.users.setPassword'),
        onClick: async () => {
          try {
            await api.patch(`/api/admin/users/${user.id}`, { password: password.value });
            password.value = '';
            toast(t('admin.users.passwordSet'));
          } catch (err) { fail(err); }
        },
      }))) : null;

  // The plan: the admin's, over whatever else they have.
  let planSection = null;
  if (state.catalog) {
    const plan = el('select', {}, state.catalog.plans.map((p) => el('option', { value: p.id, text: t(p.name) })));
    plan.value = user.plan?.id || state.catalog.defaultPlan;
    const until = el('input', { type: 'date' });
    if (user.plan_ends) until.value = user.plan_ends.slice(0, 10);
    planSection = el('div', { class: 'kit-section' },
      el('h3', { text: t('admin.users.plan') }),
      el('p', { class: 'kit-hint', text: user.unlimited ? t('admin.users.adminsUnlimited') : t('admin.users.planLead') }),
      el('div', { class: 'kit-grid' }, field(t('admin.users.planName'), plan), field(t('admin.users.planUntil'), until, t('admin.users.planUntilHint'))),
      el('div', { class: 'kit-row' },
        el('button', {
          type: 'button', class: 'kit-btn kit-btn--small kit-btn--primary', text: t('admin.users.setPlan'),
          onClick: async () => {
            try {
              await api.put(`/api/admin/users/${user.id}/plan`, { plan: plan.value, ends_at: endOfDay(until.value) });
              toast(t('admin.saved'));
              refresh();
            } catch (err) { fail(err); }
          },
        }),
        el('button', {
          type: 'button', class: 'kit-link', text: t('admin.users.defaultPlan'),
          onClick: async () => {
            try {
              await api.put(`/api/admin/users/${user.id}/plan`, { plan: null });
              toast(t('admin.saved'));
              refresh();
            } catch (err) { fail(err); }
          },
        })));
  }

  const grants = state.catalog ? el('div', { class: 'kit-section' }) : null;

  // Everywhere they are signed in, their second step, and the account itself.
  const endSection = el('div', { class: 'kit-section' },
    el('h3', { text: t('admin.users.access') }),
    local() && user.two_factor ? el('p', { class: 'kit-hint', text: `${t('admin.users.twoFactor')} ${t('admin.users.twoFactorLead')}` }) : null,
    el('div', { class: 'kit-row' },
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
          try {
            const { closed } = await api.delete(`/api/admin/users/${user.id}/sessions`);
            toast(t('admin.users.signedOut', { n: closed }));
          } catch (err) { fail(err); }
        },
      }),
      self ? null : el('button', {
        type: 'button', class: 'kit-btn kit-btn--small kit-btn--danger', text: t('admin.users.delete'),
        onClick: async () => {
          if (!(await confirmDialog(t('admin.users.deleteConfirm', { name: user.display_name })))) return;
          try {
            await api.delete(`/api/admin/users/${user.id}`);
            toast(t('admin.users.deleted'));
            dialog.close();
            refresh();
          } catch (err) { fail(err); }
        },
      })));

  const { close: closeDialog, dialog: node } = openDialog({
    title: `${user.display_name} (@${user.username})`,
    wide: true,
    content: [profile, passwordSection, planSection, grants, endSection],
    actions: [{ label: t('admin.close') }],
  });
  const dialog = { close: closeDialog, node };
  if (grants) paintGrants(grants, user).catch(fail);
}

/** The grants of an account: what the admin gave on top of its plan, and adding one. */
async function paintGrants(box, user) {
  const { grants } = await api.get(`/api/admin/users/${user.id}/grants`);
  const now = new Date().toISOString();
  const stateOf = (g) => (g.revoked_at ? 'revoked' : g.ends_at && g.ends_at <= now ? 'ended' : 'active');
  const features = Object.entries(state.catalog.features || {});

  const feature = el('select', {}, features.map(([key]) => el('option', { value: key, text: featureLabel(key) })));
  const flag = el('input', { type: 'checkbox', checked: true });
  const amount = el('input', { type: 'number', min: '0', step: '1', placeholder: t('admin.plans.noLimit') });
  const until = el('input', { type: 'date' });
  const note = el('input', { maxlength: '200' });
  const valueField = el('div', {});
  const paintValue = () => {
    const type = state.catalog.features[feature.value]?.type;
    clear(valueField).append(type === 'flag'
      ? el('label', { class: 'kit-check' }, flag, el('span', { text: t('admin.grants.on') }))
      : field(t('admin.grants.limit'), amount, t('admin.grants.limitHint')));
  };
  feature.addEventListener('change', paintValue);
  paintValue();

  clear(box).append(
    el('h3', { text: t('admin.grants.title') }),
    el('p', { class: 'kit-hint', text: t('admin.grants.lead') }),
    grants.length ? table([t('admin.grants.what'), t('admin.grants.source'), t('admin.grants.until'), ''],
      grants.map((g) => el('tr', {},
        el('td', {}, el('span', { text: g.plan ? t('admin.grants.planGrant', { plan: planName(g.plan) }) : `${featureLabel(g.feature)}: ${valueText(g.feature, JSON.parse(g.value ?? 'null'))}` }),
          g.note ? el('small', { text: g.note }) : null),
        el('td', { text: g.source }),
        el('td', {}, el('span', { text: g.ends_at ? formatDate(g.ends_at) : t('admin.grants.forever') }),
          el('small', { class: `kit-badge kit-badge--${stateOf(g) === 'active' ? 'ok' : 'warn'}`, text: t(`admin.grants.${stateOf(g)}`) })),
        el('td', {}, stateOf(g) === 'active' ? el('button', {
          type: 'button', class: 'kit-link kit-link--danger', text: t('admin.grants.revoke'),
          onClick: async () => {
            if (!(await confirmDialog(t('admin.grants.revokeConfirm')))) return;
            try {
              await api.delete(`/api/admin/grants/${g.id}`);
              paintGrants(box, user).catch(fail);
            } catch (err) { fail(err); }
          },
        }) : null)))) : el('p', { class: 'kit-empty', text: t('admin.grants.none') }),
    features.length ? el('div', { class: 'kit-grid' },
      field(t('admin.grants.feature'), feature), valueField,
      field(t('admin.grants.untilField'), until, t('admin.users.planUntilHint')), field(t('admin.grants.note'), note)) : null,
    features.length ? el('div', { class: 'kit-row' }, el('button', {
      type: 'button', class: 'kit-btn kit-btn--small', text: t('admin.grants.add'),
      onClick: async () => {
        const type = state.catalog.features[feature.value]?.type;
        try {
          await api.post('/api/admin/grants', {
            subject_id: user.id, feature: feature.value,
            value: type === 'flag' ? flag.checked : amount.value === '' ? null : Number(amount.value),
            ends_at: endOfDay(until.value), note: note.value.trim() || null,
          });
          toast(t('admin.saved'));
          paintGrants(box, user).catch(fail);
        } catch (err) { fail(err); }
      },
    })) : null,
  );
}

/* ------------------------------- invitations ------------------------------- */

async function renderInvitations(main) {
  const email = el('input', { type: 'email', autocomplete: 'off' });
  const role = el('select', {}, ['user', 'admin'].map((r) => el('option', { value: r, text: t(`admin.roles.${r}`) })));
  const result = el('div', {});
  const now = new Date().toISOString();
  const stateOf = (i) => (i.used_at ? 'used' : i.revoked_at ? 'revoked' : i.expires_at <= now ? 'expired' : 'open');

  main.append(
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

async function renderPlans(main) {
  const catalog = state.catalog;
  const features = Object.entries(catalog.features || {});
  main.append(
    el('h2', { text: t('admin.plans.title') }),
    el('p', { class: 'kit-lead', text: t('admin.plans.lead') }),
    features.length ? table([t('admin.plans.feature'), ...catalog.plans.map((p) => `${t(p.name)}${p.id === catalog.defaultPlan ? ` · ${t('admin.plans.default')}` : ''}`)],
      features.map(([key]) => el('tr', {},
        el('td', { text: featureLabel(key) }),
        catalog.plans.map((p) => el('td', { text: valueText(key, p.features[key]) })))))
      : el('p', { class: 'kit-empty', text: t('admin.plans.nothingToLimit') }),
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
        options.append(sum(here?.owns)
          ? el('label', { class: 'kit-check' }, replace, el('span', { text: t('admin.data.replace', { rows: rowsText(here.owns) }) }))
          : el('p', { class: 'kit-hint', text: t('admin.data.nothingOwned') }));
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
      if (accounts.some((a) => a.replace) && !(await confirmDialog(t('admin.data.confirmReplace')))) return;
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

/* ---------------------------------- audit ---------------------------------- */

async function renderAudit(main) {
  const prefixes = ['', 'auth.', 'account.', 'admin.', 'token.', 'oauth.', 'org.', 'billing.', 'data.'];
  const filter = el('select', {}, prefixes.map((p) => el('option', { value: p, text: p ? t(`admin.audit.kinds.${p.slice(0, -1)}`) : t('admin.audit.all') })));
  const body = el('tbody', {});
  const more = el('button', { type: 'button', class: 'kit-btn kit-btn--small', text: t('admin.audit.more') });
  let before = null;

  const load = async (reset) => {
    if (reset) { clear(body); before = null; }
    const query = new URLSearchParams({ limit: '50' });
    if (filter.value) query.set('action', filter.value);
    if (before) query.set('before', String(before));
    const { entries } = await api.get(`/api/admin/audit?${query}`);
    for (const e of entries) {
      const meta = Object.entries(e.meta || {}).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
      body.append(el('tr', {},
        el('td', { text: formatDateTime(e.at, { dateStyle: 'short', timeStyle: 'medium' }) }),
        el('td', { text: e.actor_username ? `@${e.actor_username}` : '—' }),
        el('td', {}, el('span', { text: actionText(e.action) }), el('small', { class: 'kit-mono', text: e.action })),
        el('td', { text: e.target_type ? `${e.target_type} ${e.target_id ?? ''}`.trim() : '' }),
        el('td', { class: 'kit-mono', text: e.ip || '' }),
        el('td', { class: 'kit-mono', text: meta })));
    }
    if (entries.length) before = entries.at(-1).id;
    more.hidden = entries.length < 50;
    if (!body.childElementCount) body.append(el('tr', {}, el('td', { colspan: '6', class: 'kit-empty', text: t('admin.audit.none') })));
  };
  filter.addEventListener('change', () => load(true).catch(fail));
  more.addEventListener('click', () => load(false).catch(fail));

  main.append(
    el('h2', { text: t('admin.audit.title') }),
    el('p', { class: 'kit-lead', text: t('admin.audit.lead') }),
    el('div', { class: 'kit-toolbar' }, field(t('admin.audit.show'), filter)),
    el('div', { class: 'kit-table-wrap' }, el('table', { class: 'kit-table' },
      el('thead', {}, el('tr', {}, [t('admin.audit.when'), t('admin.audit.who'), t('admin.audit.what'), t('admin.audit.on'), t('admin.audit.from'), t('admin.audit.details')]
        .map((h) => el('th', { text: h })))),
      body)),
    el('div', { class: 'kit-row', style: null }, more),
  );
  await load(true);
}

start().catch(fail);
