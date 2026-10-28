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
 * The calls from assistants are counted by the week when the host's plans say so (`mcp.period`):
 * each person sees this week, Monday to Sunday, and the admin the last four, with the average a
 * week; by the day, the last 30 days and the average a day.
 *
 * The storage is one bar split by module, as a phone shows its own: each module in the colour of
 * its icon (kit.css, by `data-part`: `data-module` is a module's window in Work, where its sheet
 * applies), the room left grey, and a legend with each one's size.
 */
import { el } from './dom.js';
import { t, formatDate, formatDateTime, numberFormat, dateFormat } from './i18n.js';

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

/**
 * The days that count of those given: from the one the account was made (`since`), or from the
 * first with calls if that is earlier (an account brought from an app keeps its own), so a
 * younger account isn't averaged over days it didn't exist.
 */
export function countedDays(mcp) {
  const first = mcp.days.findIndex((d) => d.used > 0 || (mcp.since != null && d.day >= mcp.since));
  return mcp.since == null ? mcp.days : mcp.days.slice(first < 0 ? mcp.days.length - 1 : first);
}

/** A UTC day ('2026-03-04') moved by `n` days. */
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * The days of `weeks` whole weeks, Monday to Sunday, this one the last (entitlements.js weekStart):
 * each as `days` has it, which ends today, and those still to come with `ahead`.
 */
export function weekDays(days, weeks) {
  const today = days.at(-1).day;
  const monday = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  const from = addDays(monday, -7 * (weeks - 1));
  const used = new Map(days.map((d) => [d.day, d.used]));
  return Array.from({ length: 7 * weeks }, (_, i) => {
    const day = addDays(from, i);
    return day > today ? { day, used: 0, ahead: true } : { day, used: used.get(day) ?? 0 };
  });
}

/**
 * The calls of each day as bars, today the last or, in weeks, the days still to come after it:
 * those and the days before the account (the first `from`) an empty slot, and in weeks a gap
 * before each Monday. Each day is a column as tall as the chart, so a quiet one is as easy to
 * point at as a busy one, and pointing at it (or tapping it, which focuses it) shows its day and
 * calls above.
 */
function dayBars(days, { from, label, weeks = 0 }) {
  const top = Math.max(1, ...days.map((d) => d.used));
  return el('div', { class: `kit-usage__days${weeks === 1 ? ' kit-usage__days--week' : weeks ? ' kit-usage__days--weeks' : ''}`, role: 'img', 'aria-label': label },
    days.map((d, i) => {
      const monday = weeks > 1 && i > 0 && i % 7 === 0 ? ' kit-usage__day--monday' : '';
      if (i < from || d.ahead) return el('span', { class: `kit-usage__day kit-usage__day--${d.ahead ? 'ahead' : 'before'}${monday}` });
      return el('span', {
        class: `kit-usage__day${d.used ? '' : ' kit-usage__day--none'}${monday}`, tabindex: '-1',
        'data-tip': t('kit.usage.dayCalls', { date: formatDate(`${d.day}T12:00:00Z`), calls: t('kit.usage.calls', { n: d.used }) }),
      }, el('span', { style: `block-size: ${d.used ? Math.max(6, Math.round((d.used / top) * 100)) : 4}%` }));
    }));
}

/** The initials of a week's days under its bars, so the empty ones read as days still to come. */
function weekdays(days) {
  const initial = dateFormat({ weekday: 'narrow', timeZone: 'UTC' });
  return el('div', { class: 'kit-usage__weekdays', 'aria-hidden': 'true' },
    days.map((d) => el('span', { text: initial.format(new Date(`${d.day}T12:00:00Z`)) })));
}

/**
 * The calls by the week. The limit shows to the admin always, and to each person while a bigger
 * plan has more to offer or from 75 % of it: on the top plan a bar almost empty would only say
 * how little they use it. Each person sees this week's days; the admin the last four weeks, with
 * the average a week since the account was made (`countedDays`), once it has a week of them.
 */
function weeklyCalls(mcp, { admin, say }) {
  const shown = mcp.limit != null && (admin || mcp.more != null || mcp.share >= 0.75);
  const row = usageRow(t('kit.usage.thisWeek'),
    shown ? t('kit.usage.ofLimit', { count: whole(mcp.week), limit: whole(mcp.limit) }) : t('kit.usage.calls', { n: mcp.week }),
    shown ? mcp.share : null, mcp.limit == null ? say('noWeeklyLimit') : shown ? t('kit.usage.renews') : null);
  const days = weekDays(mcp.days, admin ? 4 : 1);
  const past = days.filter((d) => !d.ahead);
  const counted = countedDays({ ...mcp, days: past });
  const from = past.length - counted.length;
  if (!admin) return [row, dayBars(days, { from, label: t('kit.usage.weekChart'), weeks: 1 }), weekdays(days)];
  const total = counted.reduce((a, d) => a + d.used, 0);
  const calls = t('kit.usage.calls', { n: total });
  const avg = whole(Math.round((total / counted.length) * 7));
  const note = counted.length < 7 ? t('kit.usage.lastDaysOnly', { n: counted.length, calls })
    : from === 0 ? t('kit.usage.lastWeeks', { n: 4, calls, avg }) : t('kit.usage.lastDaysWeekly', { n: counted.length, calls, avg });
  return [row, el('small', { class: 'kit-usage__note', text: note }), dayBars(days, { from, label: t('kit.usage.weeksChart'), weeks: 4 })];
}

/** The calls by the day: today against the limit, the average a day and the last 30 days. */
function dailyCalls(mcp, { say }) {
  const counted = countedDays(mcp);
  const average = counted.length ? mcp.total / counted.length : 0;
  return [
    usageRow(t('kit.usage.today'), mcp.limit == null ? whole(mcp.today) : t('kit.usage.ofLimit', { count: whole(mcp.today), limit: whole(mcp.limit) }),
      mcp.share, mcp.limit == null ? say('noDailyLimit') : null),
    el('small', { class: 'kit-usage__note', text: t('kit.usage.lastDays', {
      n: counted.length, calls: t('kit.usage.calls', { n: mcp.total }), avg: whole(average),
    }) }),
    dayBars(mcp.days, { from: mcp.days.length - counted.length, label: t('kit.usage.monthChart') }),
  ];
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
        class: 'kit-storage__part', 'data-part': m.mount, title: `${m.name}: ${sizeText(m.bytes)}`,
        style: `flex-basis: ${((m.bytes / whole) * 100).toFixed(2)}%`,
      }))),
    el('ul', { class: 'kit-storage__legend' }, legend.map((p) => el('li', {},
      el('span', { class: 'kit-storage__dot', ...(p.module ? { 'data-part': p.module } : { 'data-free': '' }) }),
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
  if (usage.mcp) {
    add(usage.mcp.share, usage.mcp.period === 'week' ? t('kit.usage.counted.mcpWeek', { n: usage.mcp.week }) : t('kit.usage.counted.mcp', { n: usage.mcp.today }));
  }
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
      ...(mcp.period === 'week' ? weeklyCalls(mcp, { admin, say }) : dailyCalls(mcp, { say }))) : null);
}
