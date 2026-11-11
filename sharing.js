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
 *   · by email, a bare address (`field_invalid` otherwise), anyone with an account,
 *     never oneself. An address answers the same whether an account has it or not
 *     (A3): for one without, the engine makes no share, the module keeps the offer
 *     under the address, and `notify.stranger` may tell it;
 *   · by id (`user_id`), only one of the person's people (`peopleOf`: whoever
 *     accepted something of theirs, offered them something or has what they
 *     accepted), or someone this thing was already offered to by id: an id of
 *     anyone else answers 404 like an id nobody has, so ids can't be probed. Not
 *     whoever they only offered something to by email, or naming them by id would
 *     tell the address has an account (audit sc-data-1);
 *   · by username, only with `byUsername` (an install whose directory is open,
 *     where everyone sees everyone anyway).
 *
 * A kind that keeps its offers by email under their address (the module's
 * `*_address_offers`) says where (`addresses`). Then its owner sees an address
 * only while an offer waits under it, as the module lists it, and every account by
 * the name it gave itself, never its email: picking someone's chip told the owner
 * their email (audit next-1). An account still waiting behind one of those offers
 * is named by the offer, never by its id, here too.
 *
 * The brake (share-brake.js, or the module's own with the same two methods):
 * every new offer and every address without an account counts towards a limit
 * per hour (429 share_limit), and each pair of people is told once a day.
 *
 * The notice of a new offer: an email always, and a push too if the person has a
 * device that takes it (`notify: { push, email }`, each the module's, with its
 * words; 0.212.0: the push no longer stands in for the email). To an address
 * without an account, `notify.stranger` (0.214.0), whose email decides itself
 * whether it may go (stranger-invites.js); the answer is the same either way.
 *
 * Each kind brings its own rules as hooks (who may see it, what changes when it
 * is offered or left, what a route answers), so the routes keep the paths and the
 * answers each module has always had.
 */
import { HttpError, badRequest, notFound, str, oneOf, readJson, sendJson } from './http.js';
import { createShareBrake } from './share-brake.js';
import { bareAddress } from './mail.js';

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
 *   offering(userId, thing)        throws when this thing can't be offered at all;
 *   read(userId, id) → { thing, role, ownerId }   who sees who has it (GET …/shares);
 *   leaving(userId, id, targetId) → { thing, ownerId }   may this person end that one's access;
 *   pending(userId, id) → thing    the thing of an invitation to take up (throws 404);
 *   name(thing)                    what the notice calls it (default thing.name);
 *   offered, changed, removing, removed, accepting   what else happens (live events…);
 *   accepted({ userId, thing, body, ctx }) → answer   what accepting answers;
 *   answer(info) → answer           what an offer answers (default: { share, invited });
 *   invitation: { select, join, where, owner, shape(row) }   its invitations not yet answered;
 *   addresses: { table, key }   where its offers by email wait under their address (a table with
 *                         an `email` column, `key` naming the thing), when the module keeps
 *                         them and lists them to the owner itself (see the top of the file);
 *   strictRemove: false   taking back a share that isn't there answers done, not 404;
 *   path, routes: { segment, list, patch }   its routes (see routes()).
 * @param {object|Function} [options.notify]  { push(n), email(n), stranger?(n) }, or one function for every
 *   notice to an account. `stranger` gets { kind, thing, name, actorId, email, permission }.
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

  /** The addresses a thing's offers by email wait under (its kind's `addresses`), in lower case; null without. */
  function addressesOf(spec, id) {
    if (!spec.addresses) return null;
    const { table, key } = spec.addresses;
    return new Set(all(`SELECT email FROM ${table} WHERE ${key} = ?`, id).map((row) => String(row.email).toLowerCase()));
  }

  /**
   * Whether someone's share of a thing waits behind an offer by address: not accepted, and their
   * account's email is an address one of its offers waits under. Its owner sees that offer in its
   * place, and names it by the offer, never by this id: by the id, they would learn that the
   * address they typed has an account, and which (audit sc-data-1).
   */
  function behindAddress(spec, id, targetId) {
    if (!spec.addresses) return false;
    const { table, key } = spec.addresses;
    return Boolean(get(`SELECT 1 AS x FROM ${spec.table} s JOIN users u ON u.id = s.user_id
      JOIN ${table} a ON a.${key} = s.${spec.key} AND a.email = u.email COLLATE NOCASE
      WHERE s.${spec.key} = ? AND s.user_id = ? AND s.accepted = 0`, id, targetId));
  }

  /**
   * Whoever something was offered to; only its owner (`owner`) sees the
   * invitations not yet answered. Of a kind with `addresses`, the owner sees each
   * account by its name, and none waiting behind an offer by address (the module
   * lists the offer); of any other, the emails too, and the address an invitation
   * went to in place of the name. → [{ user, permission, accepted, created_at }].
   */
  function sharesOf(kind, id, { owner = false } = {}) {
    const spec = specOf(kind);
    const { table, key, createdAt } = spec;
    const created = createdAt ? createdAt : 'NULL';
    const typed = owner ? addressesOf(spec, id) : null;
    return all(`SELECT user_id, permission, accepted, ${created} AS created_at FROM ${table}
      WHERE ${key} = ? ${owner ? '' : 'AND accepted = 1'} ORDER BY accepted DESC, ${createdAt ? `${createdAt}, ` : ''}user_id`, id)
      .flatMap((s) => {
        const share = { permission: s.permission, accepted: Boolean(s.accepted), created_at: s.created_at };
        if (!typed) return [{ user: pendingMask(personOf(s.user_id, { email: owner }), s.accepted), ...share }];
        const person = personOf(s.user_id, { email: true });
        // Waiting behind an offer by address: the module lists that offer in its place.
        if (!s.accepted && person?.email && typed.has(person.email.toLowerCase())) return [];
        // Picked by id, or accepted: by the name the owner already knew, or they showed by
        // accepting. Their email stays theirs.
        return [{ user: person && { id: person.id, name: person.name }, ...share }];
      });
  }

  /**
   * Who the person may name by id (`user_id`): whoever accepted something of
   * theirs, whoever offered them something (its invitation shows them by name),
   * and whoever else has what they accepted, of every kind; never themselves. Not
   * whoever they only offered something to: an offer by email makes a share for an
   * account and none for an address without one, so naming that account by its id
   * told which addresses have one (audit sc-data-1). → a Set of ids.
   */
  function knownTo(userId) {
    const parts = [];
    const params = [];
    for (const { table, key, owner } of Object.values(KINDS)) {
      if (!owner) continue;
      parts.push(
        // Whoever accepted something of theirs.
        `SELECT s.user_id AS id FROM ${table} s ${owner.join} WHERE ${owner.column} = ? AND s.accepted = 1`,
        // Whoever offered them something.
        `SELECT ${owner.column} FROM ${table} s ${owner.join} WHERE s.user_id = ?`,
        // Whoever else has what they accepted (as the dialog shows them).
        `SELECT o.user_id FROM ${table} s JOIN ${table} o ON o.${key} = s.${key} WHERE s.user_id = ? AND s.accepted = 1 AND o.accepted = 1`,
      );
      params.push(userId, userId, userId);
    }
    if (!parts.length) return new Set();
    return new Set(all(`SELECT DISTINCT id FROM (${parts.join(' UNION ALL ')}) WHERE id <> ?`, ...params, userId).map((row) => row.id));
  }

  /**
   * The person's people, for the share dialog's chips: those they may name by id
   * (knownTo), each once, by name, never by email. Whoever they only offered
   * something to is none of them, as in Projects: the name an account gave itself
   * is for it to show by accepting (#693). → [{ id, name }].
   */
  function peopleOf(userId) {
    return [...knownTo(userId)].map((id) => personOf(id)).filter(Boolean)
      .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' }) || a.id - b.id);
  }

  /**
   * Whether a thing waits for someone by an offer made by picking them (by id): a share not
   * accepted that no offer by address hides. Only a kind with `addresses` can tell: without them,
   * an offer by email to an account leaves the very same share.
   */
  function offeredById(kind, id, targetId) {
    const spec = specOf(kind);
    if (!spec.addresses) return false;
    const row = shareRow(kind, id, targetId);
    return Boolean(row) && !row.accepted && !behindAddress(spec, id, targetId);
  }

  /* ------------------------------- target ------------------------------- */

  const count = (userId) => {
    const allowed = brake.offer(userId);
    if (!allowed.allowed) throw new HttpError(429, 'share_limit', { retry_after: allowed.retryAfter });
  };

  /**
   * Whoever the owner offers something to (see the top of the file); `kind` and
   * `thing`, when given, let an id it was already offered to by id be named again.
   * → { id, email? } for someone with an account, `{ ghost: true, email }` for
   * an address without one (already counted by the brake).
   */
  function target(userId, { email, user_id: targetId, username } = {}, { kind = null, thing = null } = {}) {
    requirePlan?.(userId);
    const hasEmail = email != null && email !== '';
    if (!hasEmail && targetId != null) {
      const id = Number(targetId);
      const named = Number.isInteger(id) && (knownTo(userId).has(id) || Boolean(kind && thing && offeredById(kind, thing.id, id)));
      if (!named) throw notFound(UNKNOWN);
      return { id };
    }
    if (!hasEmail && byUsername) {
      const row = get('SELECT id FROM users WHERE username = ?', str(username, { field: 'username', max: 200 }));
      if (!row) throw notFound(UNKNOWN);
      if (row.id === userId) throw badRequest('share_with_self');
      return { id: row.id };
    }
    if (!hasEmail && NO_TARGET) throw badRequest(NO_TARGET);
    // Only a bare address: `"x" <someone@…>` is nobody's, and went on to that address as one
    // without an account, under a name of the sender's choosing (mail.js bareAddress).
    const address = bareAddress(str(email, { field: 'email', min: 3, max: 200 }));
    if (!address) throw badRequest('field_invalid', { field: 'email' });
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
   * brake): by email, and by push as well if a device of theirs takes it. A
   * notice that fails is logged; the other still goes, and the invitation is in
   * the app all the same.
   */
  function tell(kind, thing, actorId, targetId, permission) {
    if (!notify || !brake.notice(actorId, targetId)) return;
    const spec = specOf(kind);
    const notice = { kind, thing, name: spec.name ? spec.name(thing) : thing?.name, actorId, targetId, permission };
    const sends = typeof notify === 'function' ? [notify]
      : [notify.email, notify.push && pushable(targetId) ? notify.push : null].filter(Boolean);
    for (const send of sends) {
      try {
        Promise.resolve(send(notice)).catch((err) => log(`[sharing] the notice of a ${kind} offered was not sent: ${err?.message}`));
      } catch (err) {
        log(`[sharing] the notice of a ${kind} offered was not sent: ${err?.message}`);
      }
    }
  }

  /** Tells an address without an account (`notify.stranger`): its email keeps its own limits. */
  function tellStranger(kind, thing, actorId, email, permission) {
    const send = notify && typeof notify === 'object' ? notify.stranger : null;
    if (!send) return;
    const spec = specOf(kind);
    const notice = { kind, thing, name: spec.name ? spec.name(thing) : thing?.name, actorId, email, permission };
    try {
      Promise.resolve(send(notice)).catch((err) => log(`[sharing] the email of a ${kind} offered to a new address was not sent: ${err?.message}`));
    } catch (err) {
      log(`[sharing] the email of a ${kind} offered to a new address was not sent: ${err?.message}`);
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
      const accepted = Boolean(row?.accepted);
      // Until it is accepted, offered again it is `invited` again and dated now, as an address
      // without an account always is (Martin, #693: the second offer to an account said false and
      // the first offer's date, to anyone else true and the time of asking).
      return emailAnswer(target.email, permission, accepted
        ? { invited, accepted, createdAt: row.created_at }
        : { invited: true, accepted });
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
    // What can't be offered at all (Notes' Inbox) says so before anyone is looked for or counted.
    spec.offering?.(userId, thing);
    const who = target(userId, body, { kind, thing });
    const permission = permissionOf(body.permission);
    const answer = spec.answer || defaultAnswer;
    if (who.ghost) {
      const answered = answer({ kind, userId, thing, target: who, permission, invited: true, ctx });
      tellStranger(kind, thing, userId, who.email, permission);
      return answered;
    }
    const row = shareRow(kind, thing.id, who.id);
    const invited = !row;
    // By email an offer not yet accepted counts every time, as an address without an account does:
    // otherwise offering it again and again would find the limit only for addresses nobody has.
    if (invited || (who.email && !row.accepted)) count(userId);
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

  /**
   * Changes what someone it was offered to may do. Only its owner. → their share.
   * Someone waiting behind an offer by address answers as a share that isn't there
   * (behindAddress), unless the module changes that offer (`byAddress`).
   */
  function setPermission(kind, userId, id, targetId, permission, { byAddress = false } = {}) {
    const spec = specOf(kind);
    const thing = spec.own(userId, id);
    const perm = permissionOf(permission);
    const { table, key } = spec;
    if (!byAddress && behindAddress(spec, thing.id, targetId)) throw notFound();
    if (!run(`UPDATE ${table} SET permission = ? WHERE ${key} = ? AND user_id = ?`, perm, thing.id, targetId).changes) throw notFound();
    spec.changed?.({ userId, thing, targetId, permission: perm });
    return sharesOf(kind, thing.id, { owner: true }).find((s) => s.user.id === targetId);
  }

  /**
   * Ends someone's access: its owner takes it back from anyone; anyone else,
   * only from themselves (declining an invitation, or leaving what they had
   * accepted). With `strictRemove: false` a share that isn't there is not a 404.
   * A share that isn't there runs no hook either: nothing changed, so nobody is
   * told. It used to tell whoever the id named, and Tasks' tabs reload on that,
   * so anyone could make anyone's reload, as often as they liked (audit
   * sc-data-6); now every notice a removal sends is for a share an offer made,
   * and offers are what the brake counts.
   */
  function remove(kind, userId, id, targetId) {
    const spec = specOf(kind);
    const { thing, ownerId } = spec.leaving(userId, id, targetId);
    let row = shareRow(kind, thing.id, targetId);
    // Its owner takes back someone waiting behind an offer by address by that offer, which the
    // module drops before it comes here: by the id it is a share that isn't there (behindAddress).
    if (row && Number(targetId) !== Number(userId) && behindAddress(spec, thing.id, targetId)) row = null;
    if (!row) {
      if (spec.strictRemove !== false) throw notFound();
      return;
    }
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
    personOf, sharesOf, peopleOf, knownTo, target, shareRow, emailAnswer,
    share, list, setPermission, remove, accept, pending, routes,
  };
}
