/**
 * Sharing something with someone, the same in every module (audit 2026-10-23, A6).
 *
 * Something (a notebook, a list…) is offered to someone, to read or to edit, and
 * reaches them only when they accept it: sharing is offering, not putting
 * something in someone else's sidebar. Only its owner offers, changes and takes
 * back; whoever it was offered to may decline it or, later, leave it. What they
 * accepted stays accepted when only the permission changes.
 *
 * This is Notes' engine (notes/server/store.js, 0.28–0.62), which was already
 * written for any table: each kind of thing names the table of its offers and
 * the column naming the thing, and the rows have `user_id, permission, accepted`
 * (and, where the table has them, `invited_by, created_at`). Nothing about the
 * tables changes: a module keeps the ones it has, with their rows.
 *
 *   const sharing = createSharing({ db: { get, all, run }, kinds: { notebook: { … } }, notify, brake });
 *   sharing.routes(api, { user: requireUser, id: idParam });
 *
 * Who it is offered to (`target`):
 *   · by email, anyone with an account, never oneself. An address answers the
 *     same whether an account has it or not (A3): for one without, nothing is
 *     created and nobody is told;
 *   · by id (`user_id`), only one of the person's people (`peopleOf`): an id of
 *     anyone else answers 404 like an id nobody has, so ids can't be probed;
 *   · by username, only with `byUsername` (an install whose directory is open,
 *     where everyone sees everyone anyway).
 *
 * The brake (share-brake.js, or the module's own with the same two methods):
 * every new offer and every address without an account counts towards a limit
 * per hour (429 share_limit), and each pair of people is told once a day.
 *
 * The notice of a new offer: by push if the person has a device that takes it,
 * else by email (`notify: { push, email }`, each the module's, with its words).
 *
 * Each kind brings its own rules as hooks (who may see it, what changes when it
 * is offered or left, what a route answers), so the routes keep the paths and the
 * answers each module has always had.
 */
import { HttpError, badRequest, notFound, str, oneOf, readJson, sendJson } from './http.js';
import { createShareBrake } from './share-brake.js';

export const PERMISSIONS = ['view', 'edit'];

/**
 * @param {object} options
 * @param {{ get, all, run }} options.db  the module's database helpers (SQL with `?`).
 * @param {object} options.kinds  kind → spec:
 *   table, key            where its offers are kept and the column naming the thing;
 *   owner: { join, column }  how an offer row (`s`) reaches the thing's owner, for peopleOf;
 *   invitedBy, createdAt  those columns' names, or null when the table lacks one
 *                         (defaults 'invited_by', 'created_at'); stamp: false leaves
 *                         created_at to the column's default;
 *   own(userId, id) → thing        the thing, for its owner only (throws 404/403 otherwise);
 *   read(userId, id) → { thing, role, ownerId }   who sees who has it (GET …/shares);
 *   leaving(userId, id, targetId) → { thing, ownerId }   may this person end that one's access;
 *   pending(userId, id) → thing    the thing of an invitation to take up (throws 404);
 *   name(thing)                    what the notice calls it (default thing.name);
 *   offered, changed, removing, removed, accepting   what else happens (live events…);
 *   accepted({ userId, thing, body, ctx }) → answer   what accepting answers;
 *   answer(info) → answer           what an offer answers (default: { share, invited });
 *   invitation: { select, join, where, owner, shape(row) }   its invitations not yet answered;
 *   path, routes: { segment, list, patch }   its routes (see routes()).
 * @param {object|Function} [options.notify]  { push(n), email(n) }, or one function for every notice.
 *   n = { kind, thing, name, actorId, targetId, permission }.
 * @param {object} [options.push]  the suite's push service: who has a device (subscriptionsOf).
 * @param {Function} [options.hasPush]  (userId) → whether a push reaches them; overrides `push`.
 * @param {object} [options.brake]  { offer(actorId), notice(actorId, targetId) }; default createShareBrake().
 * @param {Function} [options.requirePlan]  (userId) → throws when the person's plan doesn't share.
 * @param {boolean} [options.byUsername]  also by `username`, for an open directory.
 * @param {object} [options.codes]  { unknown: 'email_not_found', noTarget: null }: the codes of
 *   a person not found and of an offer that names nobody (null: the email is required).
 * @param {Function} [options.log]
 */
export function createSharing({
  db, kinds, notify = null, push = null, hasPush = null, brake = createShareBrake(), requirePlan = null,
  byUsername = false, codes = {}, clock = () => new Date().toISOString(), log = console.error,
}) {
  const { get, all, run } = db;
  const UNKNOWN = codes.unknown || 'email_not_found';
  const NO_TARGET = codes.noTarget || null;

  const KINDS = Object.fromEntries(Object.entries(kinds).map(([kind, spec]) => [kind, {
    invitedBy: 'invited_by', createdAt: 'created_at', stamp: true, ...spec,
  }]));
  const specOf = (kind) => {
    const spec = KINDS[kind];
    if (!spec) throw new TypeError(`sharing: no kind "${kind}"`);
    return spec;
  };
  const permissionOf = (value) => oneOf(value, PERMISSIONS, 'permission', 'edit');

  /* ------------------------------- people ------------------------------- */

  /** Someone as the sharing screens show them: the owner also sees the emails they typed. */
  function personOf(userId, { email = false } = {}) {
    const user = get('SELECT id, display_name, username, email FROM users WHERE id = ?', userId);
    if (!user) return null;
    return { id: user.id, name: user.display_name || user.username, ...(email ? { email: user.email ?? null } : {}) };
  }

  /** Until they accept, the owner sees the address the offer went to, not the name the account gave itself. */
  const pendingMask = (person, accepted) => (person && !accepted && person.email ? { ...person, name: person.email } : person);

  /**
   * Whoever something was offered to; only its owner (`owner`) sees the
   * invitations not yet answered and the emails. → [{ user, permission, accepted, created_at }].
   */
  function sharesOf(kind, id, { owner = false } = {}) {
    const { table, key, createdAt } = specOf(kind);
    const created = createdAt ? createdAt : 'NULL';
    return all(`SELECT user_id, permission, accepted, ${created} AS created_at FROM ${table}
      WHERE ${key} = ? ${owner ? '' : 'AND accepted = 1'} ORDER BY accepted DESC, ${createdAt ? `${createdAt}, ` : ''}user_id`, id)
      .map((s) => ({
        user: pendingMask(personOf(s.user_id, { email: owner }), s.accepted),
        permission: s.permission,
        accepted: Boolean(s.accepted),
        created_at: s.created_at,
      }));
  }

  /**
   * The person's people: everyone they share anything with or who shares
   * anything with them, of every kind, accepted or not, and whoever else has
   * something they accepted. Never themselves, each once, by name; the email
   * only of those they offered something to (they typed it). → [{ id, name, email? }].
   */
  function peopleOf(userId) {
    const parts = [];
    const params = [];
    for (const { table, key, owner } of Object.values(KINDS)) {
      if (!owner) continue;
      parts.push(
        // Whoever they offered something of theirs to.
        `SELECT s.user_id AS id, 1 AS offered FROM ${table} s ${owner.join} WHERE ${owner.column} = ?`,
        // Whoever offered them something.
        `SELECT ${owner.column}, 0 FROM ${table} s ${owner.join} WHERE s.user_id = ?`,
        // Whoever else has what they accepted (as the dialog shows them).
        `SELECT o.user_id, 0 FROM ${table} s JOIN ${table} o ON o.${key} = s.${key} WHERE s.user_id = ? AND s.accepted = 1 AND o.accepted = 1`,
      );
      params.push(userId, userId, userId);
    }
    if (!parts.length) return [];
    return all(`SELECT id, MAX(offered) AS offered FROM (${parts.join(' UNION ALL ')}) WHERE id <> ? GROUP BY id`, ...params, userId)
      .map((row) => personOf(row.id, { email: Boolean(row.offered) }))
      .filter(Boolean)
      .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' }) || a.id - b.id);
  }

  /* ------------------------------- target ------------------------------- */

  const count = (userId) => {
    const allowed = brake.offer(userId);
    if (!allowed.allowed) throw new HttpError(429, 'share_limit', { retry_after: allowed.retryAfter });
  };

  /**
   * Whoever the owner offers something to (see the top of the file).
   * → { id, email? } for someone with an account, `{ ghost: true, email }` for
   * an address without one (already counted by the brake).
   */
  function target(userId, { email, user_id: targetId, username } = {}) {
    requirePlan?.(userId);
    const hasEmail = email != null && email !== '';
    if (!hasEmail && targetId != null) {
      const id = Number(targetId);
      if (!Number.isInteger(id) || !peopleOf(userId).some((p) => p.id === id)) throw notFound(UNKNOWN);
      return { id };
    }
    if (!hasEmail && byUsername) {
      const row = get('SELECT id FROM users WHERE username = ?', str(username, { field: 'username', max: 200 }));
      if (!row) throw notFound(UNKNOWN);
      if (row.id === userId) throw badRequest('share_with_self');
      return { id: row.id };
    }
    if (!hasEmail && NO_TARGET) throw badRequest(NO_TARGET);
    const address = str(email, { field: 'email', min: 3, max: 200 }).toLowerCase();
    const row = get('SELECT id FROM users WHERE email = ? COLLATE NOCASE', address);
    if (row?.id === userId) throw badRequest('share_with_self');
    if (!row) {
      count(userId);
      return { ghost: true, email: address };
    }
    return { id: row.id, email: address };
  }

  /* ------------------------------- the rows ------------------------------ */

  const shareRow = (kind, id, targetId) => {
    const { table, key } = specOf(kind);
    return get(`SELECT * FROM ${table} WHERE ${key} = ? AND user_id = ?`, id, targetId);
  };

  /** An offer, or a new permission for someone it was already offered to: what they accepted stays accepted. */
  function offerRow(kind, id, userId, targetId, permission) {
    const { table, key, invitedBy, createdAt, stamp } = specOf(kind);
    const columns = [key, 'user_id', 'permission', 'accepted'];
    const values = [id, targetId, permission, 0];
    if (invitedBy) { columns.push(invitedBy); values.push(userId); }
    if (createdAt && stamp) { columns.push(createdAt); values.push(clock()); }
    run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
      ON CONFLICT (${key}, user_id) DO UPDATE SET permission = excluded.permission`, ...values);
  }

  const dropShare = (kind, id, targetId) => {
    const { table, key } = specOf(kind);
    run(`DELETE FROM ${table} WHERE ${key} = ? AND user_id = ?`, id, targetId);
  };

  /** Takes up an invitation; 404 no_pending_invitation when there is none to take. */
  function acceptOffer(kind, id, userId) {
    const { table, key } = specOf(kind);
    if (!run(`UPDATE ${table} SET accepted = 1 WHERE ${key} = ? AND user_id = ? AND accepted = 0`, id, userId).changes) {
      throw notFound('no_pending_invitation');
    }
  }

  /* ------------------------------- notices ------------------------------- */

  const pushable = (userId) => {
    try {
      if (hasPush) return Boolean(hasPush(userId));
      return (push?.subscriptionsOf?.([userId]) || []).length > 0;
    } catch {
      return false;
    }
  };

  /**
   * Tells someone something was offered to them, once a day per pair (the
   * brake): by push if a device of theirs takes it, else by email. A notice
   * that fails is logged; the invitation is in the app all the same.
   */
  function tell(kind, thing, actorId, targetId, permission) {
    if (!notify || !brake.notice(actorId, targetId)) return;
    const spec = specOf(kind);
    const notice = { kind, thing, name: spec.name ? spec.name(thing) : thing?.name, actorId, targetId, permission };
    const send = typeof notify === 'function' ? notify
      : notify.push && pushable(targetId) ? notify.push : notify.email;
    if (!send) return;
    try {
      Promise.resolve(send(notice)).catch((err) => log(`[sharing] the notice of a ${kind} offered was not sent: ${err?.message}`));
    } catch (err) {
      log(`[sharing] the notice of a ${kind} offered was not sent: ${err?.message}`);
    }
  }

  /* -------------------------------- flows -------------------------------- */

  /**
   * What an offer by email answers: the same shape whoever the address belongs
   * to, with no id and the address in place of a name (the name of an account is
   * for whoever it accepts to show).
   */
  function emailAnswer(address, permission, { invited = true, accepted = false, createdAt = clock() } = {}) {
    return {
      share: { user: { id: null, name: address, email: address }, permission, accepted, created_at: createdAt },
      invited,
    };
  }

  function defaultAnswer({ kind, thing, target, permission, invited }) {
    if (target.ghost) return emailAnswer(target.email, permission);
    if (target.email) {
      const row = shareRow(kind, thing.id, target.id);
      return emailAnswer(target.email, permission, { invited, accepted: Boolean(row?.accepted), createdAt: row?.created_at });
    }
    return { share: sharesOf(kind, thing.id, { owner: true }).find((s) => s.user.id === target.id), invited };
  }

  /**
   * Offers something to someone (`{ email | user_id | username, permission }`),
   * or changes the permission of someone it was already offered to. `invited`
   * when the offer is new: the one time they are told.
   */
  function share(kind, userId, id, body = {}, ctx = null) {
    const spec = specOf(kind);
    const thing = spec.own(userId, id);
    const who = target(userId, body);
    const permission = permissionOf(body.permission);
    const answer = spec.answer || defaultAnswer;
    if (who.ghost) return answer({ kind, userId, thing, target: who, permission, invited: true, ctx });
    const invited = !shareRow(kind, thing.id, who.id);
    if (invited) count(userId);
    offerRow(kind, thing.id, userId, who.id, permission);
    spec.offered?.({ userId, thing, targetId: who.id, permission, invited, ctx });
    if (invited) tell(kind, thing, userId, who.id, permission);
    return answer({ kind, userId, thing, target: who, permission, invited, ctx });
  }

  /** Who has something: its owner and whoever it was offered to. → { role, owner, shares }. */
  function list(kind, userId, id) {
    const { thing, role, ownerId } = specOf(kind).read(userId, id);
    return { role, owner: personOf(ownerId), shares: sharesOf(kind, thing.id, { owner: role === 'owner' }) };
  }

  /** Changes what someone it was offered to may do. Only its owner. → their share. */
  function setPermission(kind, userId, id, targetId, permission) {
    const spec = specOf(kind);
    const thing = spec.own(userId, id);
    const perm = permissionOf(permission);
    const { table, key } = spec;
    if (!run(`UPDATE ${table} SET permission = ? WHERE ${key} = ? AND user_id = ?`, perm, thing.id, targetId).changes) throw notFound();
    spec.changed?.({ userId, thing, targetId, permission: perm });
    return sharesOf(kind, thing.id, { owner: true }).find((s) => s.user.id === targetId);
  }

  /**
   * Ends someone's access: its owner takes it back from anyone; anyone else,
   * only from themselves (declining an invitation, or leaving what they had
   * accepted). With `strictRemove: false` a share that isn't there is not a 404.
   */
  function remove(kind, userId, id, targetId) {
    const spec = specOf(kind);
    const { thing, ownerId } = spec.leaving(userId, id, targetId);
    const row = shareRow(kind, thing.id, targetId);
    if (!row && spec.strictRemove !== false) throw notFound();
    const info = { userId, thing, ownerId, targetId, row };
    // Told while they still have it: afterwards their tabs would not hear of it.
    spec.removing?.(info);
    dropShare(kind, thing.id, targetId);
    spec.removed?.(info);
  }

  /** Takes up an invitation. → what the kind answers (`accepted`), else the thing. */
  function accept(kind, userId, id, body = {}, ctx = null) {
    const spec = specOf(kind);
    const thing = spec.pending(userId, id);
    spec.accepting?.({ userId, thing, body, ctx });
    acceptOffer(kind, thing.id, userId);
    return spec.accepted ? spec.accepted({ userId, thing, body, ctx }) : thing;
  }

  /**
   * What was offered to the person that they have not answered yet, newest
   * first, of every kind with `invitation`: { kind, …shape(row), owner,
   * permission, created_at }.
   */
  function pending(userId) {
    const out = [];
    for (const [kind, spec] of Object.entries(KINDS)) {
      const inv = spec.invitation;
      if (!inv) continue;
      const created = spec.createdAt ? `s.${spec.createdAt}` : 'NULL';
      const rows = all(`SELECT ${inv.select}, ${inv.owner} AS owner_id, s.permission, ${created} AS created_at
        FROM ${spec.table} s ${inv.join} WHERE s.user_id = ? AND s.accepted = 0${inv.where ? ` AND ${inv.where}` : ''}`, userId);
      for (const row of rows) {
        out.push({ kind, ...inv.shape(row), owner: personOf(row.owner_id), permission: row.permission, created_at: row.created_at, _id: row.id });
      }
    }
    return out
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || a._id - b._id)
      .map(({ _id, ...invitation }) => invitation);
  }

  /* -------------------------------- routes ------------------------------- */

  /**
   * The routes of every kind with a `path` (`/api/notebooks/:id`), with the
   * paths and answers modules have always had. `routes.segment` names the
   * offers ('shares', Notes; 'share', Tasks), `routes.list` and `routes.patch`
   * say whether there is a GET of who has it and a PATCH of a permission:
   *
   *   GET    <path>/<segment>              who has it          → { role, owner, shares }
   *   POST   <path>/<segment>              offer, or change    → answer
   *   PATCH  <path>/<segment>/:userId      what they may do    → their share
   *   DELETE <path>/<segment>/:userId      take back, leave    → { ok: true }
   *   POST   <path>/accept                 take it up          → accepted
   *
   * and, with `people`, GET <people> → { people: peopleOf(me) }, for the
   * dialog's chips. `user(ctx)` is the module's signed-in person (401 without),
   * `id(ctx, name)` its reading of an id in the path.
   */
  function routes(router, { user, id, people = null }) {
    for (const [kind, spec] of Object.entries(KINDS)) {
      if (!spec.path) continue;
      const { segment = 'shares', list: withList = true, patch: withPatch = true } = spec.routes || {};
      const at = `${spec.path}/${segment}`;
      if (withList) {
        router.get(at, async (ctx) => {
          const me = user(ctx);
          sendJson(ctx.res, 200, list(kind, me.id, id(ctx, 'id')));
        });
      }
      router.post(at, async (ctx) => {
        const me = user(ctx);
        const thingId = id(ctx, 'id');
        const body = await readJson(ctx.req);
        sendJson(ctx.res, 200, share(kind, me.id, thingId, {
          email: body.email, user_id: body.user_id, username: body.username, permission: body.permission,
        }, ctx));
      });
      if (withPatch) {
        router.patch(`${at}/:userId`, async (ctx) => {
          const me = user(ctx);
          const body = await readJson(ctx.req);
          sendJson(ctx.res, 200, setPermission(kind, me.id, id(ctx, 'id'), id(ctx, 'userId'), body.permission));
        });
      }
      router.delete(`${at}/:userId`, async (ctx) => {
        const me = user(ctx);
        remove(kind, me.id, id(ctx, 'id'), id(ctx, 'userId'));
        sendJson(ctx.res, 200, { ok: true });
      });
      router.post(`${spec.path}/accept`, async (ctx) => {
        const me = user(ctx);
        const thingId = id(ctx, 'id');
        const body = await readJson(ctx.req).catch(() => ({}));
        sendJson(ctx.res, 200, accept(kind, me.id, thingId, body || {}, ctx));
      });
    }
    if (people) {
      router.get(people, async (ctx) => {
        const me = user(ctx);
        sendJson(ctx.res, 200, { people: peopleOf(me.id) });
      });
    }
  }

  return {
    kinds: Object.keys(KINDS),
    personOf, sharesOf, peopleOf, target, shareRow, emailAnswer,
    share, list, setPermission, remove, accept, pending, routes,
  };
}
