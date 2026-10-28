/**
 * What each person uses of the app: how much they keep in each module, how
 * close that is to their plan's caps, their storage and their calls from
 * assistants. /admin › Users shows it in an account's dialog (Usage) and, in
 * the list, how near each account is to its nearest cap; Settings › Plan shows
 * each person their own (GET /api/me/usage).
 *
 * A module says what someone has with `createModule().usage(userId)`:
 *
 *   usage: (userId) => ({
 *     counts: [
 *       { id: 'lists', count: 12, feature: 'lists.max' },   // what the barrier of lists.max counts
 *       { id: 'tasks', count: 340 },
 *       { id: 'files', count: 7 },                          // the files its `storage` measures
 *     ],
 *     active_at: '2026-10-21T18:22:00.000Z',               // the last change of theirs, or null
 *   })
 *
 * For the admin's list of every account, a module may also answer for many at once (peaksOf):
 *
 *   usageAll: (userIds) => Map<userId, what usage(userId) answers>,
 *   storageAll: (userIds) => Map<userId, what storage(userId) answers>,
 *
 * each in a fixed number of queries (GROUP BY the owner, IN (…) by batches of ≤ 500), not one per
 * person. Both are optional: an id left out of the Map is asked one by one, and so is every id
 * when it throws.
 *
 * `id` is one of USAGE_ITEMS, which the admin panel has words for. A count with
 * a `feature` is set against that limit of the module's own plan: it has to be
 * what the module's barrier counts, or the percentage tells the admin something
 * the app doesn't do. A module without `usage` shows only its storage; one whose
 * `usage` fails shows that it couldn't say, and the rest still do.
 *
 * Read-only and on demand: nothing here is kept, except the month of daily
 * counts that entitlements.js keeps for `mcp.calls_per_day`.
 */
import { sendJson, unauthorized, forbidden, notFound, int } from './http.js';

/** What a module may count, as the panels name them (kit.usage.items.<id>). */
export const USAGE_ITEMS = Object.freeze(['lists', 'tasks', 'subtasks', 'notebooks', 'notes', 'projects', 'entries', 'files']);

const MB = 1024 * 1024;

/** How much of a limit a count takes: 0.85 is 85 %; null when there is no limit. */
export function share(count, limit) {
  if (limit == null) return null;
  if (limit <= 0) return count > 0 ? 1 : 0;
  return count / limit;
}

/** A module's answer, kept to what the panel can show: known ids, whole numbers, a date or null. */
function cleanCounts(answer) {
  const counts = [];
  for (const item of Array.isArray(answer?.counts) ? answer.counts : []) {
    if (!USAGE_ITEMS.includes(item?.id)) continue;
    const count = Math.max(0, Math.trunc(Number(item.count) || 0));
    counts.push({ id: item.id, count, feature: typeof item.feature === 'string' ? item.feature : null });
  }
  const at = typeof answer?.active_at === 'string' && !Number.isNaN(Date.parse(answer.active_at)) ? answer.active_at : null;
  return { counts, active_at: at };
}

/** A limit of the module's plan for someone, or null (none, or a feature it doesn't declare). */
function limitOf(entitlements, user, feature) {
  if (!entitlements || !feature) return null;
  try {
    return entitlements.limit(user, feature);
  } catch {
    // A feature the module names but doesn't declare: shown without a percentage rather than not at all.
    return null;
  }
}

/**
 * Someone's usage, from what the modules answered of them: the rows of the account's dialog, the
 * storage, the calls of the day and the cap they are nearest to. One reckoning for one account
 * (usageOf) and for the admin's list (peaksOf), which only differ in how they ask.
 */
function reckon(user, { modules, on, answerOf, bytesOf, limitIn, entitlements, mcpOf, log }) {
  let bytes = 0;
  let files = 0;
  let storageLimit;
  let measured = false;
  const shown = [];
  for (const m of modules) {
    const app = m.config?.app || {};
    const row = { mount: m.mount, name: app.name || m.mount, on: on(m.mount), counts: [], active_at: null, failed: false };
    if (typeof m.parts?.usage === 'function') {
      try {
        Object.assign(row, cleanCounts(answerOf(m)));
      } catch (error) {
        row.failed = true;
        log(`[${app.id || m.mount}] usage of user ${user.id} failed: ${error.message}`);
      }
    }
    for (const item of row.counts) {
      item.limit = limitIn(m.view?.entitlements, item.feature);
      item.share = share(item.count, item.limit);
      if (item.id === 'files') files += item.count;
    }
    if (typeof m.parts?.storage === 'function') {
      measured = true;
      try {
        row.bytes = Math.max(0, Number(bytesOf(m)) || 0);
        bytes += row.bytes;
      } catch (error) {
        row.bytes = null;
        log(`[${app.id || m.mount}] storage of user ${user.id} failed: ${error.message}`);
      }
      // storage.mb is the person's across the modules (host.js): any module that declares it says it.
      if (storageLimit === undefined && m.view?.entitlements?.knows?.('storage.mb')) storageLimit = limitIn(m.view.entitlements, 'storage.mb');
    }
    shown.push(row);
  }

  // A host that declares it itself, when no module does.
  if (storageLimit === undefined && entitlements?.knows?.('storage.mb')) storageLimit = limitIn(entitlements, 'storage.mb');
  const limitMb = storageLimit ?? null;
  const storage = measured ? { bytes, files, limit_mb: limitMb, share: share(bytes, limitMb == null ? null : limitMb * MB) } : null;

  // The calls of the day count once for the whole app, with the host's plans (app.js mcpQuota).
  const mcp = entitlements?.knows?.('mcp.calls_per_day') ? mcpOf(limitIn(entitlements, 'mcp.calls_per_day')) : null;

  // The cap they are nearest to, for the list: the module's count, the storage or today's calls.
  let peak = null;
  const consider = (value, what) => {
    if (value != null && (!peak || value > peak.share)) peak = { share: value, ...what };
  };
  for (const row of shown) for (const item of row.counts) consider(item.share, { mount: row.mount, name: row.name, id: item.id });
  consider(storage?.share ?? null, { id: 'storage' });
  consider(mcp?.share ?? null, { id: 'mcp' });

  return { user_id: user.id, modules: shown, storage, mcp, peak };
}

/**
 * Someone's usage across the modules. `modules` are the host's joined ones ({ mount, config,
 * parts, view }), `uses(user, mount)` whether they have it on, `entitlements` the host's own (the
 * one that counts the calls of the day).
 */
export function usageOf(user, { modules, uses = () => true, entitlements = null, log = () => {} }) {
  return reckon(user, {
    modules, entitlements, log,
    on: (mount) => uses(user, mount),
    answerOf: (m) => m.parts.usage(user.id),
    bytesOf: (m) => m.parts.storage(user.id),
    limitIn: (plans, feature) => limitOf(plans, user, feature),
    mcpOf: (limit) => {
      const days = entitlements.dailyUsage(user.id, 'mcp.calls_per_day');
      const today = days.at(-1)?.used ?? 0;
      // Counted with a limit or without (countDaily): the share only where there is one. `since`,
      // the day the account was made, so an account younger than the month averages its own days.
      const since = /^\d{4}-\d{2}-\d{2}/.test(user.created_at ?? '') ? user.created_at.slice(0, 10) : null;
      return { limit, today, share: share(today, limit), days, since, total: days.reduce((a, d) => a + d.used, 0) };
    },
  });
}

/** A module's answer for many at once (`usageAll`, `storageAll`): its Map, or null when it has none or it fails. */
function askAll(m, hook, ids, log) {
  const all = m.parts?.[hook];
  if (typeof all !== 'function') return null;
  try {
    const answer = all(ids);
    return answer instanceof Map ? answer : null;
  } catch (error) {
    log(`[${m.config?.app?.id || m.mount}] ${hook} failed: ${error.message}`);
    return null;
  }
}

/**
 * Each account's nearest cap, for the admin's list: Map userId → usageOf(user).peak, the same
 * answer, asked in batches. A module with `usageAll` / `storageAll` answers all of them at once
 * (an id it leaves out, or every id if it fails, is asked one by one); each plan in a fixed number
 * of queries (entitlements `ofMany`); today's calls in one, without the month the dialog shows.
 */
export function peaksOf(users, { modules, entitlements = null, log = () => {} }) {
  const ids = users.map((user) => user.id);
  const answers = new Map(modules.map((m) => [m, typeof m.parts?.usage === 'function' ? askAll(m, 'usageAll', ids, log) : null]));
  const weights = new Map(modules.map((m) => [m, typeof m.parts?.storage === 'function' ? askAll(m, 'storageAll', ids, log) : null]));
  // Each module's plans (and the host's) for all of them, asked once, when first needed.
  const plans = new Map();
  const plansIn = (source) => {
    if (!plans.has(source)) {
      let found = null;
      try { found = typeof source.ofMany === 'function' ? source.ofMany(users) : null; } catch { found = null; }
      plans.set(source, found);
    }
    return plans.get(source);
  };
  const calls = entitlements?.knows?.('mcp.calls_per_day') && typeof entitlements.usedToday === 'function'
    ? entitlements.usedToday(ids, 'mcp.calls_per_day') : null;
  const fromAll = (all, id, one) => (all?.has(id) ? all.get(id) : one());
  const peaks = new Map();
  for (const user of users) {
    const { peak } = reckon(user, {
      modules, entitlements, log,
      on: () => null,   // not part of the peak
      answerOf: (m) => fromAll(answers.get(m), user.id, () => m.parts.usage(user.id)),
      bytesOf: (m) => fromAll(weights.get(m), user.id, () => m.parts.storage(user.id)),
      limitIn: (source, feature) => {
        if (!source || !feature) return null;
        const entitled = plansIn(source)?.get(user.id);
        if (!entitled) return limitOf(source, user, feature);
        // What limit() answers: a feature it doesn't declare (an alias, another module's) is no limit here.
        return Object.hasOwn(entitled.features, feature) ? entitled.features[feature] : null;
      },
      mcpOf: (limit) => {
        const today = calls ? calls.get(user.id) ?? 0
          : entitlements.dailyUsage(user.id, 'mcp.calls_per_day', { days: 1 }).at(-1)?.used ?? 0;
        return { limit, today, share: share(today, limit) };
      },
    });
    peaks.set(user.id, peak);
  }
  return peaks;
}

/** Accounts counted at once for the admin's list: between batches, the process answers everyone else. */
const PEAK_BATCH = 100;

/**
 * The admin's routes: one account's usage, and every account's nearest cap for the list.
 * `usageFor(user)` is usageOf() with the host's modules, `peaksFor(users)` peaksOf() with them.
 */
export function registerUsageApi(api, { accounts, usageFor, peaksFor = null }) {
  const requireAdmin = (ctx) => {
    if (!ctx.user) throw unauthorized();
    if (ctx.user.role !== 'admin') throw forbidden('admin_only');
  };
  api.get('/api/admin/users/:id/usage', (ctx) => {
    requireAdmin(ctx);
    const user = accounts.byId(int(ctx.params.id, { field: 'id', min: 1 }));
    if (!user) throw notFound('user_not_found');
    sendJson(ctx.res, 200, usageFor(user));
  });
  api.get('/api/admin/usage', async (ctx) => {
    requireAdmin(ctx);
    const users = accounts.list();
    const peaks = {};
    for (let i = 0; i < users.length; i += PEAK_BATCH) {
      if (i) await new Promise((resolve) => setImmediate(resolve));
      const batch = users.slice(i, i + PEAK_BATCH);
      if (peaksFor) for (const [id, peak] of peaksFor(batch)) peaks[id] = peak;
      else for (const user of batch) peaks[user.id] = usageFor(user).peak;
    }
    sendJson(ctx.res, 200, { peaks });
  });
}

/**
 * Each person's own usage, for Settings › Plan: what the admin sees of them, and nothing of anyone
 * else. Signed in on the web only: /api routes know no token from an assistant (app.js).
 */
export function registerOwnUsageApi(api, { usageFor }) {
  api.get('/api/me/usage', (ctx) => {
    if (!ctx.user) throw unauthorized();
    sendJson(ctx.res, 200, usageFor(ctx.user));
  });
}
