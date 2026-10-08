/**
 * Links between modules, in a page of a host's module (suite-core links.js, architecture §21.3):
 * the "Linked" row of an item's panel, one chip per link in the other module's colour that opens
 * it there, and "+ Link" to add the item to another module or link something that exists there.
 * On its own an app has no links: the row stays hidden and asks nothing.
 *
 *   const linked = linksRow({ ref: `tasks:task:${task.id}`, title: task.title });
 *   panel.append(linked.element);
 *   linked.show(`tasks:task:${other.id}`, other.title);    // the panel shows another item
 *   // the live channel (connectLive with events: ['links']) passes its changes on:
 *   linked.refresh(events);
 *
 * "+ Link" offers every kind of thing another module can create, or only those in `offer`
 * ([{ module, type }]). What the module creates, and where, is that module's to decide.
 */
import { el, clear } from './dom.js';
import { t } from './i18n.js';
import { icon } from './icons.js';
import { BASE } from './base.js';
import { ApiError, SessionExpired, Offline, errorMessage } from './api.js';
import { toast, menu, openDialog, field, switchRow } from './ui.js';

/** The module a page belongs to, from its base (`/tasks/` → tasks), as shell.js reads it; null on its own. */
export const mountOf = (base) => /^\/([a-z][a-z0-9-]{1,30})\/$/.exec(base)?.[1] || null;

/** The host's API, at its root: links are the host's, not the module's (no at()). */
async function hostCall(fetcher, method, path, body) {
  let res;
  try {
    res = await fetcher(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Offline();
  }
  const data = await res.json().catch(() => null);
  if (res.ok) return data;
  const code = data?.error || 'generic';
  if (res.status === 401) throw new SessionExpired(401, code, data);
  throw new ApiError(res.status, code, data);
}

/** A kind of thing in words ("Task", "Note"); one the kit has no word for, as it is. */
export function kindName(type) {
  const key = `kit.links.kinds.${type}`;
  const name = t(key);
  return name === key ? type : name;
}

const reachable = (card) => card.state !== 'gone' && card.state !== 'hidden';

/** What a chip says: the title and a note after it (its module, its state, or why it can't open). */
export function chipText(card = {}) {
  if (card.state === 'hidden') return { text: t('kit.links.hidden'), note: t('kit.links.noAccess') };
  if (card.state === 'gone') {
    const note = t('kit.links.goneIn', { app: card.app || '' });
    return card.title ? { text: card.title, note } : { text: note, note: null };
  }
  const note = card.state === 'done' ? t('kit.links.done') : card.state === 'cancelled' ? t('kit.links.cancelled') : card.app;
  return { text: card.title || '', note };
}

/**
 * One link as a chip: the other side's card, in its module's colour, opening it there; dashed
 * when it is gone or this person can't open it. `onMenu(button, link)` adds its "…" button.
 */
export function linkChip(link, { onMenu = null } = {}) {
  const card = link.item || {};
  const state = card.state || 'hidden';
  const { text, note } = chipText(card);
  const label = [card.app, card.where, text, note !== card.app ? note : null].filter(Boolean).join(' · ');
  const body = [
    el('span', { class: 'kit-linked__dot', 'aria-hidden': 'true' }),
    el('span', { class: 'kit-linked__title', text }),
    note ? el('span', { class: 'kit-linked__note', text: note }) : null,
    link.together ? el('span', { class: 'kit-linked__together', title: t('kit.links.together') }, icon('refresh')) : null,
  ];
  const open = card.url && reachable(card)
    ? el('a', { class: 'kit-linked__open', href: card.url, title: label, 'aria-label': label }, body)
    : el('span', { class: 'kit-linked__open', title: label }, body);
  return el('span', {
    class: 'kit-linked__chip', 'data-state': state, 'data-link': String(link.id ?? ''),
    style: card.color ? `--module: ${card.color}` : null,
  },
  open,
  onMenu ? el('button', {
    type: 'button', class: 'kit-linked__more', 'aria-haspopup': 'menu', 'aria-label': t('kit.links.options', { title: text }),
    onClick: (ev) => onMenu(ev.currentTarget, link),
  }, icon('more')) : null);
}

/**
 * The "Linked" row of an item: its links, and "+ Link". Hidden on its own, and while the
 * person uses no other module with things to link.
 *
 * @param {object} options
 * @param {string} [options.ref]      the item, as `module:type:id`
 * @param {string} [options.title]    its title, the default for what is created from it
 * @param {Array} [options.offer]     [{ module, type }]: what "Add to…" offers (default: all it can)
 * @param {string} [options.base]     for tests: the page's base
 * @param {Function} [options.fetch]  for tests
 */
export function linksRow({ ref = null, title = '', offer = null, base = BASE, fetch: fetcher = (...args) => globalThis.fetch(...args) } = {}) {
  const mount = mountOf(base);
  const call = (method, path, body) => hostCall(fetcher, method, path, body);
  const chips = el('div', { class: 'kit-linked__chips' });
  const add = el('button', { type: 'button', class: 'kit-btn kit-btn--small kit-btn--quiet kit-linked__add', 'aria-haspopup': 'menu' },
    icon('plus'), t('kit.links.add'));
  const element = el('div', { class: 'kit-linked', role: 'group', 'aria-label': t('kit.links.label'), hidden: true },
    el('span', { class: 'kit-linked__label', text: t('kit.links.label') }), chips, add);

  let current = { ref, title };
  let modules = null;   // the host's, as this person uses them; asked once, and again when they change
  let shown = [];
  let asking = 0;

  /** The kinds of things in the other modules this person uses: [{ module, type, name, creates }]. */
  const kinds = () => (modules || [])
    .filter((m) => m.active && m.mount !== mount)
    .flatMap((m) => Object.entries(m.links || {}).map(([type, kind]) => ({ module: m.mount, type, name: m.name, creates: Boolean(kind.creates) })));
  const offered = () => kinds().filter((k) => k.creates && (!offer || offer.some((o) => o.module === k.module && o.type === k.type)));

  async function loadModules() {
    try {
      modules = (await call('GET', '/api/modules')).modules || [];
    } catch {
      modules ??= [];
    }
  }

  function paint() {
    clear(chips);
    for (const link of shown) chips.append(linkChip(link, { onMenu: chipMenu }));
    element.hidden = false;
  }

  /** Reads the item's links again; an answer for an item no longer shown is dropped. */
  async function load() {
    const ask = ++asking;
    if (!mount || !current.ref) {
      element.hidden = true;
      return;
    }
    if (!modules) await loadModules();
    if (ask !== asking) return;
    if (!kinds().length) {
      element.hidden = true;
      return;
    }
    let data;
    try {
      data = await call('GET', `/api/links?ref=${encodeURIComponent(current.ref)}`);
    } catch (err) {
      // Offline, the row stays as it was; anything else (not there, not theirs), no row.
      if (ask === asking && !(err instanceof Offline)) element.hidden = true;
      return;
    }
    if (ask !== asking) return;
    shown = data?.links || [];
    paint();
  }

  /* ---------------------------------- a link --------------------------------- */

  async function setTogether(link, together) {
    try {
      await call('PATCH', `/api/links/${link.id}`, { together });
    } catch (err) {
      toast(errorMessage(err), { error: true });
      return;
    }
    load();
  }

  async function removeLink(link) {
    try {
      await call('DELETE', `/api/links/${link.id}`);
    } catch (err) {
      toast(errorMessage(err), { error: true });
      return;
    }
    const from = current.ref;
    load();
    toast(t('kit.links.removed'), {
      action: reachable(link.item || {}) ? {
        label: t('kit.links.undo'),
        onClick: async () => {
          try {
            await call('POST', '/api/links', { from, to: link.item.ref, together: link.together });
          } catch (err) {
            toast(errorMessage(err), { error: true });
            return;
          }
          if (current.ref === from) load();
        },
      } : null,
    });
  }

  function chipMenu(anchor, link) {
    const card = link.item || {};
    const items = [];
    if (card.url && reachable(card)) items.push({ label: t('kit.links.openIn', { app: card.app }), iconName: 'external', href: card.url });
    if (reachable(card)) {
      items.push({
        label: link.together ? t('kit.links.togetherOff') : t('kit.links.togetherOn'),
        iconName: 'refresh',
        onClick: () => setTogether(link, !link.together),
      });
    }
    items.push({ label: t('kit.links.remove'), iconName: 'x', danger: true, onClick: () => removeLink(link) });
    menu(anchor, items);
  }

  /* ----------------------------- adding a link ----------------------------- */

  /** "Add to Tasks…": the title (its own by default), where (if that module asks), and "together", on. */
  async function createDialog(kind) {
    const name = el('input', { type: 'text', value: current.title || '', maxlength: '300', autocomplete: 'off' });
    const place = el('select', {});
    const placeField = field(t('kit.links.place'), place);
    placeField.hidden = true;
    let together = true;
    const from = current.ref;
    openDialog({
      title: t('kit.links.addToTitle', { app: kind.name }),
      content: el('div', { class: 'kit-stack' },
        field(t('kit.links.title'), name),
        placeField,
        switchRow(t('kit.links.together'), { checked: true, hint: t('kit.links.togetherHint'), onChange: (on) => { together = on; } })),
      actions: [
        { label: t('kit.cancel') },
        {
          label: t('kit.links.create'),
          primary: true,
          onClick: async () => {
            const data = { title: name.value.trim() || current.title };
            if (!placeField.hidden && place.value) data.place = place.value;
            try {
              await call('POST', '/api/links/new', { from, module: kind.module, type: kind.type, data, together });
            } catch (err) {
              toast(errorMessage(err), { error: true });
              return false;
            }
            toast(t('kit.links.created', { app: kind.name }));
            if (current.ref === from) load();
            return true;
          },
        },
      ],
    });
    name.focus?.();
    // Where it may go, when that module has places (lists, notebooks, projects).
    try {
      const found = await call('GET', `/api/links/search?module=${encodeURIComponent(kind.module)}&type=${encodeURIComponent(kind.type)}&q=`);
      for (const option of found?.places || []) place.append(el('option', { value: option.id, text: option.name }));
      placeField.hidden = !(found?.places || []).length;
    } catch {
      // Without its places, the module puts it where it puts new things.
    }
  }

  /** "Link existing…": search a kind of thing of another module, pick one. */
  function existingDialog() {
    const list = kinds();
    if (!list.length) return;
    let kind = list[0];
    let together = false;
    const select = el('select', {}, list.map((k, i) => el('option', { value: String(i), text: `${k.name} · ${kindName(k.type)}` })));
    const query = el('input', { type: 'search', autocomplete: 'off', placeholder: t('kit.links.searchHint') });
    const results = el('div', { class: 'kit-linked__results', 'aria-live': 'polite' });
    const from = current.ref;
    const { close } = openDialog({
      title: t('kit.links.existingTitle'),
      content: el('div', { class: 'kit-stack' },
        list.length > 1 ? field(t('kit.links.in'), select) : null,
        field(t('kit.links.search'), query),
        results,
        switchRow(t('kit.links.together'), { checked: false, hint: t('kit.links.togetherHint'), onChange: (on) => { together = on; } })),
      actions: [{ label: t('kit.cancel') }],
    });

    const pick = async (card) => {
      try {
        await call('POST', '/api/links', { from, to: card.ref, together });
      } catch (err) {
        toast(errorMessage(err), { error: true });
        return;
      }
      close();
      toast(t('kit.links.linked'));
      if (current.ref === from) load();
    };

    let asked = 0;
    let timer = null;
    const run = async () => {
      const ask = ++asked;
      let found;
      try {
        found = await call('GET', `/api/links/search?module=${encodeURIComponent(kind.module)}&type=${encodeURIComponent(kind.type)}`
          + `&q=${encodeURIComponent(query.value.trim())}`);
      } catch (err) {
        if (ask === asked) clear(results).append(el('p', { class: 'kit-error', text: errorMessage(err) }));
        return;
      }
      if (ask !== asked) return;
      const linked = new Set(shown.map((l) => l.item?.ref));
      const items = (found?.items || []).filter((card) => card.ref !== from);
      clear(results);
      if (!items.length) {
        results.append(el('p', { class: 'kit-hint', text: t('kit.links.none') }));
        return;
      }
      for (const card of items) {
        const already = linked.has(card.ref);
        const done = card.state === 'done' ? t('kit.links.done') : card.state === 'cancelled' ? t('kit.links.cancelled') : null;
        results.append(el('button', {
          type: 'button', class: 'kit-linked__result', 'data-state': card.state, disabled: already,
          style: card.color ? `--module: ${card.color}` : null, onClick: () => pick(card),
        },
        el('span', { class: 'kit-linked__dot', 'aria-hidden': 'true' }),
        el('span', { class: 'kit-linked__title', text: card.title }),
        el('span', { class: 'kit-linked__note', text: already ? t('kit.links.already') : [card.where, done].filter(Boolean).join(' · ') })));
      }
    };
    query.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 250);
    });
    select.addEventListener('change', () => {
      kind = list[Number(select.value)] || list[0];
      run();
    });
    query.focus?.();
    run();
  }

  add.addEventListener('click', async () => {
    await loadModules();
    const choices = offered();
    // Two kinds of one module ("Add to Projects (Task)…"): each says which.
    const twice = (k) => choices.filter((c) => c.module === k.module).length > 1;
    const items = choices.map((k) => ({
      label: t('kit.links.addTo', { app: twice(k) ? `${k.name} (${kindName(k.type)})` : k.name }),
      iconName: 'plus',
      onClick: () => createDialog(k),
    }));
    if (items.length) items.push('separator');
    items.push({ label: t('kit.links.existing'), iconName: 'search', onClick: existingDialog });
    menu(add, items);
  });

  // Someone turned a module on or off (Settings › Modules, shell.js): which links show may change.
  globalThis.document?.addEventListener?.('kit-modules', async () => {
    await loadModules();
    load();
  });

  if (current.ref) load();

  return {
    element,
    /** The panel shows another item. */
    show(nextRef, nextTitle = '') {
      current = { ref: nextRef, title: nextTitle };
      shown = [];
      clear(chips);
      return load();
    },
    /** Its title changed: what "Add to…" proposes. */
    setTitle(nextTitle) { current.title = nextTitle; },
    /** Live changes: reads again when one is about this item's links (all of them, without events). */
    refresh(events = null) {
      if (events && !events.some((e) => e.event === 'links' && (!e.data?.ref || e.data.ref === current.ref))) return null;
      return load();
    },
    get links() { return shown; },
  };
}
