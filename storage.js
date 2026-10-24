/**
 * The storage a plan allows (`storage.mb`), checked the same way in every app.
 *
 * Tasks, Projects and Notes each had the same fifteen lines: read the limit,
 * count what is kept, and past it answer 402 `plan_limit` with what the plan
 * allows and what is used. They are here once, with the one thing that is not
 * the same in each kept out as an argument: whose plan pays for a file. Today
 * it is each app's own rule (Notes: the notebook's owner, whoever sent it;
 * Tasks and Projects: whoever uploads it), passed as `payer`.
 *
 * What is counted depends on where the app runs. On its own, its own files:
 * what its `createModule().storage(userId)` says it keeps (createApp wires it).
 * As a module of a host, the person's across every module: the host adds them
 * up (host.js `storageUsed`), as the limit is the person's, not the module's.
 */
import { HttpError } from './http.js';

const MB = 1024 * 1024;

/**
 * @param {object} options
 * @param {object} options.entitlements  the app's (or the module's) createEntitlements()
 * @param {Function} options.used        (userId) → bytes kept against storage.mb
 */
export function createStorage({ entitlements, used }) {
  // An app that doesn't declare storage.mb (a host's own modules may not) has no limit to check.
  const declared = entitlements.knows ? entitlements.knows('storage.mb') : true;
  const limitOf = (payer) => (payer && declared ? entitlements.limit(payer, 'storage.mb') : null);

  /** What someone keeps and what their plan allows: `{ used, limit }`, limit in MB, null without one. */
  const of = (payer) => ({ used: used(payer.id), limit: limitOf(payer) });

  /**
   * Whether `adding` bytes more fit in the plan of whoever pays for them —
   * `payer`, by default the `user` who adds them —: nothing when they do, or
   * when there is no limit (no PLANS, or the admin); 402 `plan_limit` when they
   * don't, with the limit, what is used, and the plan, as the apps answered it.
   */
  function check(user, adding = 0, { payer = user } = {}) {
    const limit = limitOf(payer);
    if (limit == null) return;
    const current = used(payer.id);
    if (current + adding <= limit * MB) return;
    const { plan } = entitlements.of(payer);
    throw new HttpError(402, 'plan_limit', {
      feature: 'storage.mb', limit: `${limit} MB`, current: `${Math.ceil(current / MB)} MB`, plan: plan.id, plan_name: plan.name,
    });
  }

  return { used, of, check };
}
