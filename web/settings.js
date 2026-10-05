/**
 * Settings, the same in every app: a list of sections —on a phone, each one
 * a screen of its own— with what every account has (profile, language and
 * theme, password and sign-in, the AI, notifications, plan, data, about) and
 * the app's own sections among them. Taken from Next's, on the suite's
 * routes: /api/me/*, /api/auth/*, /api/push/*.
 *
 *   openSettings({
 *     app: { id: 'notes', name: 'Notes', icon: '/icons/favicon.svg', tagline: tagline },
 *     user, config,                       // /api/auth/me's user, /api/auth/config
 *     live, updates,                      // from connectLive() and watchUpdates(), for About
 *     sections: [{ id: 'notes', label: sectionLabel, hint: …, iconName: 'notes', render: () => node }],
 *     onUser: (user) => { state.user = user; },   // the account changed here
 *     onSignOut: () => signOut({ local }),
 *     applyTheme,                         // (theme) → paint it now
 *     setLanguage,                        // async (lang) → load the catalog and repaint the app
 *   });
 *
 * The profile is saved with PATCH /api/me (the app's: what it keeps of a
 * person, its preferences, is its own), with display_name, email, theme and
 * prefs.lang, as Next does.
 */
import { el, clear } from './dom.js';
import { t, formatDateTime, currentLanguage } from './i18n.js';
import { api, errorMessage } from './api.js';
import { icon } from './icons.js';
import { toast, field, segmented, switchRow, confirmDialog, signature, copyText } from './ui.js';

const LANGUAGE_NAMES = { en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch' };

const block = (title, ...children) => el('section', { class: 'kit-settings__block' },
  title ? el('h3', { text: title }) : null, ...children);
const hint = (text) => el('p', { class: 'kit-hint', text });
const row = (...children) => el('div', { class: 'kit-row' }, ...children);
const button = (text, onClick, kind = '') => el('button', {
  type: 'button', class: `kit-btn kit-btn--small${kind ? ` kit-btn--${kind}` : ''}`, text, onClick,
});
const fail = (err) => toast(errorMessage(err), { error: true });
const input = (props) => el('input', { class: 'kit-input', ...props });

/**
 * Opens Settings over the app. Returns { close, show(sectionId) }.
 */
export function openSettings(options) {
  const {
    app, config = {}, sections = [], onSignOut = null, root = document.body, start = null,
  } = options;
  const state = { user: options.user };
  const setUser = (user) => {
    state.user = user;
    options.onUser?.(user);
  };
  const local = (state.user?.auth_provider || config.provider || 'local') === 'local';
  const modules = config.app?.modules || {};

  /* -------------------------------- sections -------------------------------- */

  const all = [
    { group: t('kit.settings.groups.account'), id: 'profile', iconName: 'user', label: t('kit.profile.title'),
      hint: () => [state.user?.display_name, state.user?.email].filter(Boolean).join(' · '), render: () => profile() },
    { group: t('kit.settings.groups.account'), id: 'appearance', iconName: 'globe', label: t('kit.appearance.title'),
      hint: () => `${LANGUAGE_NAMES[currentLanguage()] || currentLanguage()} · ${t(`kit.appearance.theme.${state.user?.theme || 'system'}`)}`,
      render: () => appearance() },
    { group: t('kit.settings.groups.security'), id: 'security', iconName: 'shield', label: t('kit.security.title'),
      hint: () => t(local ? 'kit.security.hint' : 'kit.security.hintProvider'), render: () => security() },
    { group: t('kit.settings.groups.connections'), id: 'ai', iconName: 'spark', label: t('kit.ai.title'),
      hint: () => t('kit.ai.hint'), render: () => ai() },
    options.push ? { group: t('kit.settings.groups.connections'), id: 'notifications', iconName: 'bell', label: t('kit.notifications.title'),
      hint: () => t('kit.notifications.hint'), render: () => notifications() } : null,
    options.plan ? { group: t('kit.settings.groups.plan'), id: 'plan', iconName: 'card', label: t('kit.plan.title'),
      hint: () => t('kit.plan.hint'), render: () => plan() } : null,
    ...sections.map((section) => ({ group: app.name, ...section, hint: typeof section.hint === 'function' ? section.hint : () => section.hint || '' })),
    modules.data ? { group: app.name, id: 'data', iconName: 'box', label: t('kit.data.title'), hint: () => t('kit.data.hint'), render: () => data() } : null,
    state.user?.role === 'admin' ? { group: app.name, id: 'admin', iconName: 'shield', label: t('kit.admin.title'), hint: () => t('kit.admin.hint'), href: '/admin' } : null,
    { group: app.name, id: 'about', iconName: 'info', label: t('kit.about.title', { app: app.name }), hint: () => t('kit.about.hint', { app: app.name }), render: () => about() },
  ].filter(Boolean);

  /* ---------------------------------- frame --------------------------------- */

  const list = el('nav', { class: 'kit-settings__list', 'aria-label': t('kit.settings.title') });
  const page = el('div', { class: 'kit-settings__page', tabindex: '-1' });
  const frame = el('div', { class: 'kit-settings' }, el('div', { class: 'kit-settings__grid' }, list, page));
  const title = el('h1', { class: 'kit-settings-page__title', text: t('kit.settings.title') });
  const backButton = el('button', { type: 'button', class: 'kit-icon-btn', 'aria-label': t('kit.back'), onClick: () => back() }, icon('back'));
  const overlay = el('div', { class: 'kit-settings-page', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('kit.settings.title') },
    el('header', { class: 'kit-settings-page__bar' }, backButton, title),
    el('div', { class: 'kit-settings-page__body' }, frame));
  root.append(overlay);

  const items = new Map();
  const built = new Map();
  let current = null;
  const wide = () => frame.clientWidth >= 720;

  function paintList() {
    clear(list);
    let group = null;
    for (const section of all) {
      if (section.group !== group) {
        group = section.group;
        list.append(el('div', { class: 'kit-settings__group', text: group }));
      }
      const props = { class: 'kit-settings__item', 'aria-current': section.id === current ? 'page' : null };
      const content = [
        el('span', { class: 'kit-settings__icon' }, icon(section.iconName || 'sliders')),
        el('span', { class: 'kit-settings__text' }, el('span', { class: 'kit-settings__label', text: section.label }), el('small', { text: section.hint() })),
        icon(section.href ? 'external' : 'chevron', { className: 'kit-settings__chevron' }),
      ];
      const item = section.href
        ? el('a', { ...props, href: section.href, target: '_blank', rel: 'noopener' }, content)
        : el('button', { ...props, type: 'button', onClick: () => show(section.id) }, content);
      items.set(section.id, item);
      list.append(item);
    }
  }

  /** Opens a section: built the first time and kept, so what was typed survives a visit to another. */
  function show(id) {
    const section = all.find((s) => s.id === id && !s.href);
    if (!section) return;
    current = id;
    if (!built.has(id)) built.set(id, el('div', {}, el('h2', { text: section.label }), section.render()));
    clear(page).append(built.get(id));
    frame.setAttribute('data-open', '');
    for (const [key, item] of items) {
      if (key === id) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    title.textContent = wide() ? t('kit.settings.title') : section.label;
    page.scrollTop = 0;
    page.focus({ preventScroll: true });
  }

  /** Back: from a section to the list on a phone; out of Settings otherwise. */
  function back() {
    if (!wide() && frame.hasAttribute('data-open')) {
      frame.removeAttribute('data-open');
      title.textContent = t('kit.settings.title');
      paintList();
      return;
    }
    close();
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    options.onClose?.();
  }
  const onKey = (ev) => { if (ev.key === 'Escape') back(); };
  document.addEventListener('keydown', onKey);

  paintList();
  // On a computer a section is always open beside the list.
  if (start || wide()) show(start || 'profile');

  /* --------------------------------- profile -------------------------------- */

  function profile() {
    const name = input({ id: 'kit-profile-name', autocomplete: 'name', maxlength: '60', value: state.user?.display_name || '' });
    const saveName = button(t('kit.save'), async () => {
      try {
        const { user } = await api.patch('/api/me', { display_name: name.value.trim() });
        setUser(user);
        toast(t('kit.saved'));
      } catch (err) { fail(err); }
    });
    const parts = [block(null, field(t('kit.profile.name'), name, t('kit.profile.nameHint')), row(saveName))];
    if (local) parts.push(emailBlock());
    else parts.push(block(t('kit.profile.email.title'), el('p', { text: state.user?.email || '—' }), hint(t('kit.profile.email.provider'))));
    parts.push(block(null, row(el('span', { class: 'kit-hint', text: t('kit.profile.username', { username: state.user?.username || '' }) }))));
    return parts;
  }

  /** The email: what a forgotten password is recovered with. A new one gets a link to confirm it. */
  function emailBlock() {
    const mail = config.mail !== false;
    const email = input({ id: 'kit-profile-email', type: 'email', autocomplete: 'email', maxlength: '254', value: state.user?.email || '' });
    const status = hint('');
    const resend = el('button', {
      type: 'button', class: 'kit-link', text: t('kit.profile.email.resend'),
      onClick: async () => {
        try {
          await api.post('/api/me/email/verify');
          toast(t('kit.profile.email.sent', { email: state.user.email }));
        } catch (err) { fail(err); }
      },
    });
    const paint = () => {
      const u = state.user || {};
      // Without a mail server no link arrives: say so, and who can confirm it instead.
      status.textContent = !u.email ? t('kit.profile.email.help')
        : u.email_verified ? t('kit.profile.email.confirmed')
          : !mail ? t(u.role === 'admin' ? 'kit.profile.email.noMailAdmin' : 'kit.profile.email.noMail')
            : t('kit.profile.email.unconfirmed');
      resend.hidden = !mail || !u.email || Boolean(u.email_verified);
    };
    paint();
    const save = button(t('kit.save'), async () => {
      try {
        const { user, verification } = await api.patch('/api/me', { email: email.value.trim() || null });
        setUser(user);
        paint();
        // Saved either way; the link went out, or why not.
        if (verification && verification !== 'sent') {
          const reason = t(`errors.${verification}`);
          toast(`${t('kit.saved')} ${reason.startsWith('errors.') ? t('errors.generic') : reason}`, { error: true });
        } else {
          toast(mail && verification === 'sent' ? t('kit.profile.email.sent', { email: user.email }) : t('kit.saved'));
        }
      } catch (err) { fail(err); }
    });
    // Confirmed from the mail's link, often in another tab: the account changes there and this repaints.
    options.watchUser?.((user) => {
      state.user = user;
      if (document.activeElement !== email) email.value = user?.email || '';
      paint();
    });
    return block(t('kit.profile.email.title'), field(t('kit.profile.email.title'), email), status, row(save, resend));
  }

  /* ------------------------------- appearance ------------------------------- */

  function appearance() {
    const languages = config.app?.languages || ['en'];
    const choice = state.user?.prefs?.lang || 'auto';
    const select = el('select', { class: 'kit-input', id: 'kit-language' },
      el('option', { value: 'auto', text: t('kit.appearance.languageAuto') }),
      languages.map((code) => el('option', { value: code, text: LANGUAGE_NAMES[code] || code })));
    select.value = choice;
    select.addEventListener('change', async () => {
      try {
        const { user } = await api.patch('/api/me', { prefs: { lang: select.value } });
        setUser(user);
        await options.setLanguage?.(select.value);
        // Everything here is written again in the new language.
        close();
        openSettings({ ...options, user, start: 'appearance' });
      } catch (err) { fail(err); }
    });
    const theme = segmented(['system', 'light', 'dark'].map((value) => ({ value, label: t(`kit.appearance.theme.${value}`) })),
      state.user?.theme || 'system', async (value) => {
        options.applyTheme?.(value);
        try {
          const { user } = await api.patch('/api/me', { theme: value });
          setUser(user);
        } catch (err) { fail(err); }
      });
    return [
      block(null, field(t('kit.appearance.language'), select)),
      block(t('kit.appearance.themeTitle'), theme, hint(t('kit.appearance.themeHint'))),
    ];
  }

  /* -------------------------------- security -------------------------------- */

  function security() {
    const parts = [];
    if (local) {
      const current = input({ id: 'kit-password-current', type: 'password', autocomplete: 'current-password' });
      const next = input({ id: 'kit-password-new', type: 'password', autocomplete: 'new-password', minlength: String(config.password_min || 10) });
      parts.push(block(t('kit.security.password'),
        state.user?.has_password === false ? null : field(t('kit.security.currentPassword'), current),
        field(t('kit.security.newPassword'), next, t('kit.security.newPasswordHint', { n: config.password_min || 10 })),
        row(button(t('kit.security.changePassword'), async () => {
          try {
            await api.post('/api/me/password', { current_password: current.value, password: next.value });
            current.value = '';
            next.value = '';
            toast(t('kit.security.passwordChanged'));
          } catch (err) { fail(err); }
        }))));
      if (config.two_factor) parts.push(twoFactor());
    } else {
      parts.push(block(null, hint(t('kit.security.provider'))));
    }
    parts.push(sessionsBlock());
    if (onSignOut) parts.push(block(null, row(button(t('kit.account.signOut'), onSignOut))));
    return parts;
  }

  /** Where the person is signed in, each one closable. */
  function sessionsBlock() {
    const box = el('div', { class: 'kit-list' });
    const paint = async () => {
      let sessions = [];
      try { sessions = await api.get('/api/me/sessions'); } catch (err) { fail(err); return; }
      clear(box).append(...sessions.map((s) => el('div', { class: 'kit-list__row' },
        icon(/mobile|android|iphone/i.test(s.user_agent || '') ? 'phone' : 'device'),
        el('span', { class: 'kit-list__text' },
          el('strong', { text: deviceName(s.user_agent) }),
          el('small', { text: [s.ip, t('kit.security.lastUsed', { when: formatDateTime(s.last_used_at) })].filter(Boolean).join(' · ') })),
        s.current ? el('span', { class: 'kit-badge kit-badge--accent', text: t('kit.security.thisDevice') })
          : button(t('kit.security.signOutDevice'), async () => {
            try {
              await api.delete(`/api/me/sessions/${encodeURIComponent(s.key)}`);
              paint();
            } catch (err) { fail(err); }
          }, 'quiet'))));
    };
    paint();
    return block(t('kit.security.sessions'), hint(t('kit.security.sessionsHint')), box);
  }

  /**
   * A code from an app on the phone after the password. Setting it up: the
   * password again, the QR code (or the key typed by hand), a first code, and
   * ten recovery codes shown only then. Turning it off, or new recovery
   * codes, asks for the password and a code.
   */
  function twoFactor() {
    const body = el('div', { class: 'kit-stack' });
    const cancel = () => el('button', { type: 'button', class: 'kit-link', text: t('kit.cancel'), onClick: paint });
    const code = (id) => input({ id, autocomplete: 'one-time-code', autocapitalize: 'none', spellcheck: 'false', maxlength: '12' });
    const password = (id) => input({ id, type: 'password', autocomplete: 'current-password' });
    const setOn = (on) => setUser({ ...state.user, two_factor: on });

    async function paint() {
      let status;
      try { status = await api.get('/api/me/two-factor'); } catch (err) { fail(err); return; }
      if (!status.enabled) {
        clear(body).append(hint(t('kit.twoFactor.off')), row(button(t('kit.twoFactor.setUp'), askPassword, 'primary')));
        return;
      }
      clear(body).append(
        hint(t('kit.twoFactor.on', { n: status.recovery_codes_left })),
        row(button(t('kit.twoFactor.newCodes'), () => confirmWith('codes')), button(t('kit.twoFactor.turnOff'), () => confirmWith('off'), 'danger-quiet')));
    }

    function askPassword() {
      const pass = password('kit-2fa-password');
      clear(body).append(hint(t('kit.twoFactor.passwordFirst')), field(t('kit.security.currentPassword'), pass),
        row(button(t('kit.twoFactor.continue'), async () => {
          try { await showSecret(await api.post('/api/me/two-factor/setup', { password: pass.value })); } catch (err) { fail(err); }
        }, 'primary'), cancel()));
      pass.focus();
    }

    async function showSecret({ secret, uri }) {
      let qr = null;
      try {
        const { qrSvg } = await import('./qr.js');
        qr = el('div', {}, qrSvg(uri, { label: t('kit.twoFactor.qrLabel', { app: app.name }) }));
      } catch { /* the key typed by hand does the same */ }
      const first = code('kit-2fa-first');
      const key = el('code', { class: 'kit-mono', text: secret.match(/.{1,4}/g).join(' ') });
      clear(body).append(
        hint(t(qr ? 'kit.twoFactor.scan' : 'kit.twoFactor.typeKey')), qr,
        qr ? hint(t('kit.twoFactor.orKey')) : null,
        el('div', { class: 'kit-copy' }, key, el('button', { type: 'button', class: 'kit-link', text: t('kit.copy'), onClick: () => copyText(secret, key) })),
        // On the phone itself, the app opens with everything filled in.
        el('a', { class: 'kit-link', href: uri, text: t('kit.twoFactor.openApp') }),
        field(t('kit.twoFactor.firstCode'), first),
        row(button(t('kit.twoFactor.turnOn'), async () => {
          try {
            const done = await api.post('/api/me/two-factor/enable', { code: first.value.trim() });
            setOn(true);
            showRecovery(done.recovery_codes, t('kit.twoFactor.onNow'));
          } catch (err) { fail(err); }
        }, 'primary'), cancel()));
      first.focus();
    }

    function showRecovery(codes, lead) {
      const listNode = el('ul', { class: 'kit-codes' }, codes.map((c) => el('li', {}, el('code', { text: c }))));
      const who = state.user ? `${state.user.display_name} (${state.user.username})` : '';
      const file = `${t('kit.twoFactor.fileTitle', { app: app.name, user: who, host: window.location.host })}\n\n${codes.join('\n')}\n`;
      clear(body).append(hint(lead), hint(t('kit.twoFactor.recoveryHint')), listNode,
        row(el('button', { type: 'button', class: 'kit-link', text: t('kit.copy'), onClick: () => copyText(codes.join('\n'), listNode) }),
          el('button', { type: 'button', class: 'kit-link', text: t('kit.twoFactor.download'), onClick: () => download(`${app.id || 'app'}-recovery-codes.txt`, file) })),
        row(button(t('kit.twoFactor.saved'), paint, 'primary')));
    }

    function confirmWith(what) {
      const off = what === 'off';
      const pass = password('kit-2fa-confirm-password');
      const second = code('kit-2fa-confirm-code');
      clear(body).append(hint(t(off ? 'kit.twoFactor.offAsk' : 'kit.twoFactor.newCodesAsk')),
        field(t('kit.security.currentPassword'), pass), field(t('kit.twoFactor.codeOrRecovery'), second),
        row(button(t(off ? 'kit.twoFactor.turnOff' : 'kit.twoFactor.newCodes'), async () => {
          try {
            if (off) {
              await api.post('/api/me/two-factor/disable', { password: pass.value, code: second.value.trim() });
              setOn(false);
              toast(t('kit.twoFactor.offNow'));
              paint();
            } else {
              const done = await api.post('/api/me/two-factor/recovery-codes', { password: pass.value, code: second.value.trim() });
              showRecovery(done.recovery_codes, t('kit.twoFactor.newCodesDone'));
            }
          } catch (err) { fail(err); }
        }, off ? 'danger' : 'primary'), cancel()));
      pass.focus();
    }

    paint();
    return block(t('kit.twoFactor.title'), body);
  }

  /* ----------------------------------- AI ----------------------------------- */

  /**
   * Connecting an assistant: the MCP address; with the built-in OAuth pasting
   * it is enough and the apps connected that way are listed; manual tokens for
   * clients that can't sign in.
   */
  function ai() {
    const endpoint = el('code', { text: `${window.location.origin}/mcp` });
    const intro = hint(t('kit.ai.intro', { app: app.name }));
    const apps = el('div', { class: 'kit-list' });
    const appsBlock = block(t('kit.ai.apps'), apps);
    appsBlock.hidden = true;
    const tokens = el('div', { class: 'kit-list' });
    const created = el('div', { hidden: true });

    const paintApps = async () => {
      let answer = { enabled: false, grants: [] };
      try { answer = await api.get('/api/me/apps'); } catch { /* without the built-in OAuth: tokens only */ }
      intro.textContent = t(answer.enabled ? 'kit.ai.introOAuth' : 'kit.ai.intro', { app: app.name });
      appsBlock.hidden = !answer.enabled;
      clear(apps).append(...(answer.grants.length ? answer.grants.map((g) => el('div', { class: 'kit-list__row' },
        icon('spark'),
        el('span', { class: 'kit-list__text' }, el('strong', { text: g.client_name }),
          el('small', { text: [g.redirect_host, used(g.last_used_at)].filter(Boolean).join(' · ') })),
        button(t('kit.ai.disconnect'), async () => {
          if (!(await confirmDialog(t('kit.ai.confirmDisconnect', { name: g.client_name }), { confirm: t('kit.ai.disconnect') }))) return;
          try { await api.delete(`/api/me/apps/${g.id}`); paintApps(); } catch (err) { fail(err); }
        }, 'danger-quiet'))) : [el('div', { class: 'kit-list__row' }, hint(t('kit.ai.noApps')))]));
    };

    const paintTokens = async () => {
      let rows = [];
      try { rows = await api.get('/api/me/tokens'); } catch (err) { fail(err); }
      clear(tokens).append(...(rows.length ? rows.map((tk) => el('div', { class: 'kit-list__row' },
        icon('key'),
        el('span', { class: 'kit-list__text' }, el('strong', { text: tk.name }), el('small', { text: `${tk.prefix || ''}… · ${used(tk.last_used_at)}` })),
        button(t('kit.ai.revoke'), async () => {
          if (!(await confirmDialog(t('kit.ai.confirmRevoke', { name: tk.name }), { confirm: t('kit.ai.revoke') }))) return;
          try { await api.delete(`/api/me/tokens/${tk.id}`); paintTokens(); } catch (err) { fail(err); }
        }, 'danger-quiet'))) : [el('div', { class: 'kit-list__row' }, hint(t('kit.ai.noTokens')))]));
    };

    const name = input({ id: 'kit-token-name', maxlength: '60', placeholder: 'Claude' });   // i18n-exempt: a product name, as an example
    const create = button(t('kit.ai.createToken'), async () => {
      try {
        const tk = await api.post('/api/me/tokens', { name: name.value.trim() || 'Claude' });   // i18n-exempt: a product name
        name.value = '';
        const value = el('code', { text: tk.token });
        // The value is only seen now: afterwards only its fingerprint remains.
        clear(created).append(hint(t('kit.ai.tokenCreated')),
          el('div', { class: 'kit-copy' }, value, el('button', { type: 'button', class: 'kit-link', text: t('kit.copy'), onClick: () => copyText(tk.token, value) })));
        created.hidden = false;
        paintTokens();
      } catch (err) { fail(err); }
    });

    paintApps();
    paintTokens();
    return [
      block(null, intro, el('div', { class: 'kit-copy' }, endpoint, el('button', {
        type: 'button', class: 'kit-link', text: t('kit.copy'), onClick: () => copyText(endpoint.textContent, endpoint),
      }))),
      appsBlock,
      block(t('kit.ai.tokens'), hint(t('kit.ai.tokensHint')), tokens, field(t('kit.ai.tokenName'), name), row(create), created),
      ...(options.aiExtra ? [options.aiExtra()] : []),
    ];
  }

  const used = (when) => (when ? t('kit.ai.lastUsed', { when: formatDateTime(when) }) : t('kit.ai.neverUsed'));

  /* ------------------------------ notifications ----------------------------- */

  function notifications() {
    const box = el('div', { class: 'kit-list' });
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const status = hint('');
    const paint = async () => {
      let devices = [];
      try { devices = await api.get('/api/push/devices'); } catch (err) { fail(err); }
      clear(box).append(...(devices.length ? devices.map((d) => el('div', { class: 'kit-list__row' },
        icon(/mobile|android|iphone/i.test(d.label || '') ? 'phone' : 'device'),
        el('span', { class: 'kit-list__text' }, el('strong', { text: deviceName(d.label) }),
          el('small', { text: t('kit.notifications.since', { when: formatDateTime(d.created_at) }) }))))
        : [el('div', { class: 'kit-list__row' }, hint(t('kit.notifications.none')))]));
      status.textContent = !supported ? t('kit.notifications.unsupported')
        : Notification.permission === 'denied' ? t('kit.notifications.denied') : '';
    };
    const enable = button(t('kit.notifications.enable'), async () => {
      try {
        await subscribePush();
        toast(t('kit.notifications.enabled'));
        paint();
      } catch (err) {
        if (err?.code) fail(err);
        else toast(t('kit.notifications.notAllowed'), { error: true });
      }
    }, 'primary');
    enable.disabled = !supported;
    const test = button(t('kit.notifications.test'), async () => {
      try {
        const result = await api.post('/api/push/test');
        toast(t(result.no_devices ? 'kit.notifications.none' : 'kit.notifications.testSent'));
      } catch (err) { fail(err); }
    });
    paint();
    return [block(null, hint(t('kit.notifications.intro', { app: app.name })), status, row(enable, test)),
      block(t('kit.notifications.devices'), box)];
  }

  /* ---------------------------------- plan ---------------------------------- */

  function plan() {
    const box = el('div', { class: 'kit-stack' });
    (async () => {
      try {
        const answer = await api.get('/api/me/entitlements');
        const name = answer.plan?.name ? t(answer.plan.name) : '—';
        clear(box).append(el('div', { class: 'kit-facts' },
          fact(t('kit.plan.current'), answer.unlimited ? t('kit.plan.unlimited') : name),
          answer.ends ? fact(t('kit.plan.until'), formatDateTime(answer.ends, { dateStyle: 'long' })) : null));
        if (options.plan?.render) box.append(options.plan.render(answer));
      } catch (err) { fail(err); }
    })();
    return [block(null, box)];
  }

  /* ---------------------------------- data ---------------------------------- */

  /**
   * Your data: everything of yours in a zip, and a copy made that way brought
   * in, here or in another install (suite-core portability.js). What a copy
   * brings, and what "replace" would delete, is said before anything changes.
   */
  function data() {
    const describe = options.describeData || ((tables = {}) => t('kit.data.rows', { n: Object.values(tables).reduce((a, b) => a + b, 0) }));
    const area = el('div', { class: 'kit-stack' });
    const file = el('input', { type: 'file', accept: '.zip,application/zip', id: 'kit-data-file' });
    const check = button(t('kit.data.check'), async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      check.disabled = true;
      try {
        showPlan(await api.upload('/api/me/import', chosen));
      } catch (err) { fail(err); } finally { check.disabled = !file.files?.length; }
    });
    check.disabled = true;
    file.addEventListener('change', () => { check.disabled = !file.files?.length; clear(area); });

    function showPlan(answer) {
      const copy = answer.copy;
      const has = answer.replace || {};
      const owned = Object.values(has).reduce((a, b) => a + b, 0);
      const replace = el('input', { type: 'checkbox', id: 'kit-data-replace' });
      const apply = button(t('kit.data.apply'), async () => {
        if (replace.checked && !(await confirmDialog(t('kit.data.replaceText', { what: describe(has) }), {
          title: t('kit.data.replaceTitle'), confirm: t('kit.data.replaceButton'),
        }))) return;
        apply.disabled = true;
        try {
          const result = await api.post(`/api/me/import/${encodeURIComponent(answer.import_id)}`, { replace: replace.checked });
          toast(t('kit.data.done', { what: describe(result.imported.tables) }));
          // Everything shown comes back with what arrived.
          setTimeout(() => window.location.reload(), 1200);
        } catch (err) { fail(err); apply.disabled = false; }
      }, 'primary');
      apply.disabled = Boolean(copy.applied_at);
      const discard = button(t('kit.data.discard'), async () => {
        // If it doesn't reach the server, it expires by itself in a day.
        await api.delete(`/api/me/import/${encodeURIComponent(answer.import_id)}`).catch(() => {});
        clear(area);
        file.value = '';
        check.disabled = true;
      }, 'quiet');
      clear(area).append(
        el('p', { text: t('kit.data.plan', { account: answer.account || '', date: formatDateTime(copy.created_at, { dateStyle: 'medium' }), what: describe(copy.tables) }) }),
        copy.applied_at ? hint(t('kit.data.applied')) : null,
        owned ? el('label', { class: 'kit-check' }, replace, el('span', { text: t('kit.data.replace', { what: describe(has) }) })) : null,
        row(discard, apply));
    }

    return [
      // A link, not a fetch: the browser saves the zip as it arrives, whatever its size.
      block(t('kit.data.exportTitle'), hint(t('kit.data.exportHint', { app: app.name })),
        row(el('a', { class: 'kit-btn kit-btn--small', href: '/api/me/export', download: '' }, icon('download'), t('kit.data.export')))),
      block(t('kit.data.importTitle'), hint(t('kit.data.importHint')), field(t('kit.data.file'), file), row(check), area),
    ];
  }

  /* ---------------------------------- about --------------------------------- */

  /**
   * What is running and whether it is the latest, the live channel, what the
   * app is and "by Cronum Studio". An installed app has no reload button, so
   * the new version can be checked by hand here.
   */
  function about() {
    const loaded = options.updates?.loaded?.() || null;
    const serverLine = el('div');
    const check = async () => {
      clear(serverLine).append(hint(t('kit.about.checking')));
      const isNew = options.updates ? await options.updates.check({ announce: true }) : null;
      clear(serverLine).append(isNew === null ? hint(t('kit.about.unknown'))
        : isNew ? row(el('span', { text: t('kit.about.newVersion') }), button(t('kit.about.update'), () => options.applyUpdate?.(), 'primary'))
          : hint(t('kit.about.upToDate')));
    };
    const liveState = options.live?.state || 'closed';
    const source = app.source || `https://github.com/cronumstudio/${app.id}`;
    const facts = el('div', { class: 'kit-facts' },
      fact(t('kit.about.version'), loaded?.app ? `v${loaded.app}` : '—', [loaded?.built ? formatDateTime(loaded.built) : null, loaded?.version].filter(Boolean).join(' · ')),
      fact(t('kit.about.live'), t(`kit.live.${liveState}`)),
      el('div', { class: 'kit-fact' }, el('span', { text: t('kit.about.latest') }), serverLine, button(t('kit.about.check'), check)),
      // The AGPL asks modified versions to offer their source.
      el('div', { class: 'kit-fact' }, el('span', { text: t('kit.about.source') }), el('a', { href: source, target: '_blank', rel: 'noopener', text: source.replace(/^https?:\/\//, '') })));
    check();
    return [
      block(null, el('div', { class: 'kit-about' },
        el('img', { src: app.icon || '/icons/favicon.svg', alt: '', width: 54, height: 54 }),
        el('div', {}, el('strong', { text: app.name }), app.tagline ? el('p', { text: app.tagline }) : null))),
      block(null, facts),
      ...(options.aboutExtra ? [options.aboutExtra()] : []),
      block(null, el('div', { class: 'kit-signature' }, signature())),
    ];
  }

  return { close, show };
}

/* --------------------------------- helpers --------------------------------- */

function fact(label, value, detail = '') {
  return el('div', { class: 'kit-fact' }, el('span', { text: label }), el('strong', { text: value }), detail ? el('small', { text: detail }) : null);
}

/** A browser and system from a user agent, short: "Chrome · Windows". */
export function deviceName(agent = '') {
  const text = String(agent || '');
  const browser = /Edg\//.test(text) ? 'Edge' : /OPR\//.test(text) ? 'Opera' : /Firefox\//.test(text) ? 'Firefox'
    : /Chrome\//.test(text) ? 'Chrome' : /Safari\//.test(text) ? 'Safari' : null;
  const system = /iPhone|iPad/.test(text) ? 'iOS' : /Android/.test(text) ? 'Android' : /Windows/.test(text) ? 'Windows'
    : /Mac OS X/.test(text) ? 'macOS' : /Linux/.test(text) ? 'Linux' : null;
  return [browser, system].filter(Boolean).join(' · ') || text.slice(0, 40) || '—';
}

/** A text file saved on the device, made here: nothing goes to the server. */
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = el('a', { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Notices on this device: permission, the browser's subscription with the
 * install's key, and the server told, with the device's language.
 */
export async function subscribePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('not_allowed');
  const { public_key: key } = await api.get('/api/push/config');
  const registration = await navigator.serviceWorker.ready;
  const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (key.length % 4)) % 4));
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)),
  });
  const json = subscription.toJSON();
  await api.post('/api/push/subscribe', {
    endpoint: json.endpoint, keys: json.keys, label: navigator.userAgent.slice(0, 120), lang: currentLanguage(),
  });
  return subscription;
}
