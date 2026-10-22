/**
 * What each person uses of the app, for the admin: how much they keep in each
 * module, how close that is to their plan's caps, their storage and their calls
 * from assistants. /admin › Users shows it in an account's dialog (Usage) and,
 * in the list, how near each account is to its nearest cap.
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

/** What a module may count, as the admin panel names them (admin.usage.items.<id>). */
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
 * Someone's usage across the modules. `modules` are the host's joined ones ({ mount, config,
 * parts, view }), `uses(user, mount)` whether they have it on, `entitlements` the host's own (the
 * one that counts the calls of the day).
 */
export function usageOf(user, { modules, uses = () => true, entitlements = null, log = () => {} }) {
  let bytes = 0;
  let files = 0;
  let storageLimit;
  let measured = false;
  const shown = [];
  for (const m of modules) {
    const app = m.config?.app || {};
    const row = { mount: m.mount, name: app.name || m.mount, on: uses(user, m.mount), counts: [], active_at: null, failed: false };
    if (typeof m.parts?.usage === 'function') {
      try {
        Object.assign(row, cleanCounts(m.parts.usage(user.id)));
      } catch (error) {
        row.failed = true;
        log(`[${app.id || m.mount}] usage of user ${user.id} failed: ${error.message}`);
      }
    }
    for (const item of row.counts) {
      item.limit = limitOf(m.view?.entitlements, user, item.feature);
      item.share = share(item.count, item.limit);
      if (item.id === 'files') files += item.count;
    }
    if (typeof m.parts?.storage === 'function') {
      measured = true;
      try {
        row.bytes = Math.max(0, Number(m.parts.storage(user.id)) || 0);
        bytes += row.bytes;
      } catch (error) {
        row.bytes = null;
        log(`[${app.id || m.mount}] storage of user ${user.id} failed: ${error.message}`);
      }
      // storage.mb is the person's across the modules (host.js): any module that declares it says it.
      if (storageLimit === undefined && m.view?.entitlements?.knows?.('storage.mb')) storageLimit = limitOf(m.view.entitlements, user, 'storage.mb');
    }
    shown.push(row);
  }

  // A host that declares it itself, when no module does.
  if (storageLimit === undefined && entitlements?.knows?.('storage.mb')) storageLimit = limitOf(entitlements, user, 'storage.mb');
  const limitMb = storageLimit ?? null;
  const storage = measured ? { bytes, files, limit_mb: limitMb, share: share(bytes, limitMb == null ? null : limitMb * MB) } : null;

  // The calls of the day count once for the whole app, with the host's plans (app.js mcpQuota).
  let mcp = null;
  if (entitlements?.knows?.('mcp.calls_per_day')) {
    const limit = limitOf(entitlements, user, 'mcp.calls_per_day');
    const days = entitlements.dailyUsage(user.id, 'mcp.calls_per_day');
    const today = days.at(-1)?.used ?? 0;
    // Counted with a limit or without (countDaily): the share only where there is one.
    mcp = { limit, today, share: share(today, limit), days, total: days.reduce((a, d) => a + d.used, 0) };
  }

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
 * The admin's routes: one account's usage, and every account's nearest cap for the list.
 * `usageFor(user)` is usageOf() with the host's modules.
 */
export function registerUsageApi(api, { accounts, usageFor }) {
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
  api.get('/api/admin/usage', (ctx) => {
    requireAdmin(ctx);
    const peaks = {};
    for (const user of accounts.list()) peaks[user.id] = usageFor(user).peak;
    sendJson(ctx.res, 200, { peaks });
  });
}
