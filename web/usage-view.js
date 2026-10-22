/**
 * What someone uses, drawn the same for the admin (/admin › Users › Usage) and for each person
 * (Settings › Plan › Your usage), from a host's usage.js answer: per module its counts against the
 * plan's caps, the storage of all of them and the calls from assistants, with a bar where there is
 * a limit, and near or at it in words too, not only in colour.
 *
 *   usageGroups(usage)                          // each person's own: the modules they use
 *   usageGroups(usage, { admin: true })         // the admin's: every module, off or on, and its last change
 *   atLimit(usage)                              // what is near or at a cap, as "17 lists", for a notice
 *
 * The storage is one bar split by module, as a phone shows its own: each module in the colour of
 * its icon (kit.css, by `data-module`), the room left grey, and a legend with each one's size.
 */
import { el } from './dom.js';
import { t, formatDate, formatDateTime, numberFormat } from './i18n.js';

const MB = 1024 * 1024;
export const percent = (share) => numberFormat({ style: 'percent', maximumFractionDigits: 0 }).format(share);
const whole = (n) => numberFormat({ maximumFractionDigits: 1 }).format(n);

/** Bytes in the unit people read them in: kB under a megabyte, MB under a gigabyte, GB above. */
export function sizeText(bytes) {
  const [unit, size] = bytes >= 1024 * MB ? ['gigabyte', 1024 * MB] : bytes >= MB ? ['megabyte', MB] : ['kilobyte', 1024];
  return numberFormat({ style: 'unit', unit, maximumFractionDigits: 1 }).format(bytes / size);
}

/** Near a cap from 80 %, at it from 100 %: what colours its meter and puts it in words. */
export const levelOf = (share) => (share == null ? null : share >= 1 ? 'reached' : share >= 0.8 ? 'near' : 'ok');

/** How much of a limit is taken, as a bar; past the limit it stays full. */
export function meter(share) {
  const level = levelOf(share);
  const value = Math.round(Math.min(1, share) * 100);
  return el('span', {
    class: `kit-meter${level === 'ok' ? '' : ` kit-meter--${level}`}`,
    role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(value), 'aria-label': percent(share),
  }, el('span', { style: `inline-size: ${value}%` }));
}

/** What a cap is, in words: a module's count, the storage or the calls of the day. */
export function peakWhat(peak) {
  if (peak.id === 'storage') return t('kit.usage.storage');
  if (peak.id === 'mcp') return t('kit.usage.mcp');
  return t('kit.usage.peakIn', { what: t(`kit.usage.items.${peak.id}`), module: peak.name || peak.mount });
}

/** One line: what it is, how much, of how much, and the bar when there is a limit (unless `bar` is false). */
function usageRow(label, value, share = null, note = null, { bar = true } = {}) {
  const level = levelOf(share);
  return el('div', { class: 'kit-usage__row' },
    el('span', { class: 'kit-usage__label', text: label }),
    el('span', { class: 'kit-usage__value', text: share == null ? value : `${value} · ${percent(share)}` }),
    share == null || !bar ? null : meter(share),
    level === 'near' || level === 'reached'
      ? el('small', { class: `kit-badge kit-badge--${level === 'reached' ? 'danger' : 'warn'}`, text: t(`kit.usage.${level}`) }) : null,
    note ? el('small', { class: 'kit-usage__note', text: note }) : null);
}

/** The calls of the last 30 days as bars, today the last; each says its day and count on hover. */
function dayBars(days) {
  const top = Math.max(1, ...days.map((d) => d.used));
  return el('div', { class: 'kit-usage__days', role: 'img', 'aria-label': t('kit.usage.monthChart') },
    days.map((d) => el('span', {
      class: d.used ? null : 'kit-usage__day--none',
      title: t('kit.usage.dayCalls', { date: formatDate(`${d.day}T12:00:00Z`), n: whole(d.used) }),
      style: `block-size: ${d.used ? Math.max(6, Math.round((d.used / top) * 100)) : 4}%`,
    })));
}

/**
 * The storage of every module as one bar, the largest first, and the room left when the plan has
 * a limit; then a legend that names each part with its size, so no part is told by colour alone.
 */
function storageBreakdown(usage) {
  const { storage } = usage;
  const limit = storage.limit_mb == null ? null : storage.limit_mb * MB;
  const whole = Math.max(limit ?? 0, storage.bytes);
  const parts = usage.modules.filter((m) => m.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  if (!whole || !parts.length) return null;
  const free = limit == null ? 0 : Math.max(0, limit - storage.bytes);
  const legend = [...parts.map((m) => ({ module: m.mount, name: m.name, size: sizeText(m.bytes) })),
    ...(limit == null ? [] : [{ module: null, name: t('kit.usage.free'), size: sizeText(free) }])];
  return [
    el('div', { class: 'kit-storage', role: 'img', 'aria-label': `${t('kit.usage.storageChart')}: ${legend.map((p) => `${p.name} ${p.size}`).join(', ')}` },
      parts.map((m) => el('span', {
        class: 'kit-storage__part', 'data-module': m.mount, title: `${m.name}: ${sizeText(m.bytes)}`,
        style: `flex-basis: ${((m.bytes / whole) * 100).toFixed(2)}%`,
      }))),
    el('ul', { class: 'kit-storage__legend' }, legend.map((p) => el('li', {},
      el('span', { class: 'kit-storage__dot', ...(p.module ? { 'data-module': p.module } : { 'data-free': '' }) }),
      el('span', { text: p.name }), el('span', { class: 'kit-storage__size', text: p.size })))),
  ];
}

/**
 * What is near a cap or at it, the worst first, each as people count it ("17 lists", "45 assistant
 * calls today"): the name of the thing says which module it is. Only the modules in use.
 */
export function atLimit(usage) {
  const found = [];
  const add = (share, text) => {
    const level = levelOf(share);
    if (level === 'near' || level === 'reached') found.push({ level, share, text });
  };
  for (const m of usage.modules) {
    if (!m.on) continue;
    for (const c of m.counts) add(c.share, t(`kit.usage.counted.${c.id}`, { n: c.count }));
  }
  if (usage.storage) add(usage.storage.share, t('kit.usage.counted.storage', { size: sizeText(usage.storage.bytes) }));
  if (usage.mcp) add(usage.mcp.share, t('kit.usage.counted.mcp', { n: usage.mcp.today }));
  return found.sort((a, b) => b.share - a.share);
}

/**
 * The usage as one block (.kit-usage): a group for each module, then the storage and the calls
 * from assistants. The admin's names every module, with whether it is off and when it last
 * changed, and speaks of them; each person's own, only the modules they use, and speaks to them.
 */
export function usageGroups(usage, { admin = false } = {}) {
  const say = (key, vars) => t(`${admin ? 'admin' : 'kit'}.usage.${key}`, vars);
  const groups = usage.modules.filter((m) => admin || m.on).map((m) => el('section', { class: 'kit-usage__group' },
    el('h4', { class: 'kit-usage__title' },
      el('span', { text: m.name }),
      m.on ? null : el('small', { class: 'kit-badge', text: t('admin.usage.off') })),
    admin && m.active_at ? el('small', { class: 'kit-usage__note', text: t('admin.usage.lastChange', { date: formatDateTime(m.active_at) }) }) : null,
    m.counts.map((c) => usageRow(t(`kit.usage.items.${c.id}`),
      c.limit == null ? whole(c.count) : t('kit.usage.ofLimit', { count: whole(c.count), limit: whole(c.limit) }), c.share,
      c.id === 'files' && m.bytes ? t('kit.usage.used', { size: sizeText(m.bytes) }) : null)),
    m.failed ? el('p', { class: 'kit-hint', text: say('failed') })
      : m.counts.length ? null : el('p', { class: 'kit-hint', text: m.bytes ? t('kit.usage.used', { size: sizeText(m.bytes) }) : say('nothing') })));

  const { storage, mcp } = usage;
  const average = mcp?.days.length ? mcp.total / mcp.days.length : 0;
  return el('div', { class: 'kit-usage' },
    groups,
    storage ? el('section', { class: 'kit-usage__group' },
      el('h4', { class: 'kit-usage__title', text: t('kit.usage.storage') }),
      usageRow(t('kit.usage.inAll'),
        storage.limit_mb == null ? t('kit.usage.used', { size: sizeText(storage.bytes) })
          : t('kit.usage.ofLimit', { count: sizeText(storage.bytes), limit: sizeText(storage.limit_mb * MB) }),
        storage.share, null, { bar: false }),
      // Without a part to show (nothing kept yet), the bar of the limit alone.
      storageBreakdown(usage) ?? (storage.share == null ? null : meter(storage.share)),
      el('small', { class: 'kit-usage__note', text: t('kit.usage.filesCount', { n: storage.files }) })) : null,
    mcp ? el('section', { class: 'kit-usage__group' },
      el('h4', { class: 'kit-usage__title', text: t('kit.usage.mcp') }),
      usageRow(t('kit.usage.today'), mcp.limit == null ? whole(mcp.today) : t('kit.usage.ofLimit', { count: whole(mcp.today), limit: whole(mcp.limit) }),
        mcp.share, mcp.limit == null ? say('noDailyLimit') : null),
      el('small', { class: 'kit-usage__note', text: t('kit.usage.month', { n: whole(mcp.total), avg: whole(average) }) }),
      dayBars(mcp.days)) : null);
}
