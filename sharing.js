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
 *     where everyone sees everyone anyway: `!directoryClosed(suite)`).
 *
 * A kind that keeps its offers by email under their address (the module's
 * `*_address_offers`) says where (`addresses`). Then its owner sees an address
 * only while an offer waits under it, as the module lists it, and every account by
 * the name it gave itself, never its email: picking someone's chip told the owner
 * their email (audit next-1). An account still waiting behind one of those offers
 * is named by the offer, never by its id, here too.
 *
 * With `addressOffers` (createAddressOffers below) the engine keeps those offers
 * itself, the same way in every module: an offer by email waits under its address
 * whether an account has it or not, and its owner's tabs get the same notices for
 * an address without an account as for one with (the live channel numbers every
 * notice); its owner's list shows each by its address under the offer's id made
 * negative, and PATCH and DELETE …/<segment>/-<id> change it or take it back, with
 * the account waiting behind it; whoever signs up with the address, once it is
 * confirmed, finds the invitation; it goes when they answer it (`offerGoes`).
 *
 * The brake (share-brake.js, or the module's own with the same two methods):
 * every address without an account, and every offer to someone who hasn't
 * accepted it —a new one, one made again, a change of what they may do— counts
 * towards a limit per hour (429 share_limit), and each pair of people is told
 * once a day. Each of those tells someone who never accepted anything of the
 * person's, so none goes past the limit (audit sc-data-6); what a member
 * accepted changes freely.
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
 * Whether the install's directory is closed, the same rule in every module: whoever has an account
 * is a stranger to most of the rest, so each person sees only themselves and the people they share
 * something with, and someone new is offered things by their exact email. So it is in a host
 * (Cronum Work), with an identity provider (WorkOS, OIDC: whoever has an account there may sign in)
 * and with sign-up open to others (`invite`, `open`). With local accounts the administrator makes,
 * the install is one household or team: everybody knows each other, the full list of people is
 * what makes choosing whom to share with easy, and an offer may name someone by username
 * (createSharing's `byUsername`).
 */
export function directoryClosed(suite) {
  const config = suite?.config ?? {};
  return Boolean(config.host || suite?.idp || (config.accounts?.signup ?? 'admin') !== 'admin');
}

/**
 * An address as whoever didn't type it sees it: its first letter, then dots, then its domain
 * (`m•••@example.com`). Someone who inherits something shared sees so the addresses its former
 * owner offered it to, while those offers wait (Martin, 14/11/2026): the offer stays, the address
 * stays the typist's. Not an address: as it came, cut to a letter.
 */
export function maskAddress(email) {
  const text = String(email ?? '');
  const at = text.lastIndexOf('@');
  if (at < 1) return text ? `${text[0]}•••` : '';
  return `${text[0]}•••${text.slice(at)}`;
}

/**
 * The address of an offer waiting under it, as `viewerId` is shown it: whole to whoever made the
 * offer (`invitedBy`), masked to anyone else, such as whoever inherited the thing (maskAddress).
 * An offer whose maker is unknown (no column, or their account went) shows masked.
 */
export function addressFor(viewerId, email, invitedBy) {
  return invitedBy != null && Number(invitedBy) === Number(viewerId) ? email : maskAddress(email);
}

/**
 * A module's offers by address (its `*_address_offers`), written once for every module: an offer
 * by email waits under its address until it is answered or taken back, whether an account has that
 * address or not, so nothing a person is shown or told depends on whether it has one. The rows
 * have `id`, a column naming the thing (one per kind), `email` (COLLATE NOCASE), what the offer lets
 * them do, `invited_by` (who typed it: whole to them, masked to anyone else, addressFor) and
 * `created_at`. createSharing's kinds use it (`addressOffers`); a module that shares without the
 * engine (Projects' team) uses its parts itself.
 *
 *   const offers = createAddressOffers({ db, table: 'tasks_address_offers',
 *     kinds: { list: { key: 'list_id', shares: 'list_shares', things: 'lists', where: 't.deleted_at IS NULL', copy: [] } } });
 *
 * @param {object} options
 * @param {{ get, all, run }} options.db  the module's database helpers (SQL with `?`).
 * @param {string} options.table  the module's *_address_offers.
 * @param {object} options.kinds  kind → { key, shares?, things?, where?, copy? }:
 *   key       the column naming the thing;
 *   shares    where a claimed offer becomes an invitation not accepted yet (the kind's shares table,
 *             the same column naming the thing, `user_id`, its permission column and `accepted`);
 *             without it, claim() leaves the kind alone;
 *   things    the things' table, by `id` (alias `t`), when the offers don't keep their owner
 *             (`owner`): a claim never brings someone what is their own;
 *   where     more of what a claimed thing must be, on `t` (Tasks: 't.deleted_at IS NULL');
 *   copy      the offer's columns the invitation keeps (default invited_by and created_at).
 * @param {string} [options.permission]  its column of what the offer lets them do ('role' in Projects).
 * @param {string} [options.owner]  a column with the thing's owner, kept with each offer (Notes' owner_id).
 * @param {boolean} [options.retype]  an offer made again is whoever typed it now's (invited_by follows); false keeps the first.
 * @param {boolean} [options.stamp]  false leaves created_at to the column's default.
 */
export function createAddressOffers({
  db, table, kinds, permission = 'permission', owner = null, retype = true, stamp = true,
  clock = () => new Date().toISOString(),
}) {
  const { get, all, run } = db;
  for (const [kind, spec] of Object.entries(kinds)) {
    if (spec.shares && !spec.things && !owner) throw new TypeError(`address offers: "${kind}" is claimed without saying whose its things are (things or owner)`);
  }
  const keyOf = (kind) => {
    const spec = kinds[kind];
    if (!spec) throw new TypeError(`address offers: no kind "${kind}"`);
    return spec.key;
  };

  /** One offer by its id, of that thing (anything else is no offer of it). */
  const find = (kind, thingId, offerId) => get(`SELECT * FROM ${table} WHERE id = ? AND ${keyOf(kind)} = ?`, offerId, thingId);
  /** The offer of that thing waiting under an address. */
  const under = (kind, thingId, email) => get(`SELECT * FROM ${table} WHERE ${keyOf(kind)} = ? AND email = ?`, thingId, email);
  /** The offers of a thing, oldest first. */
  const list = (kind, thingId) => all(
    `SELECT id, email, ${permission}, invited_by, created_at FROM ${table} WHERE ${keyOf(kind)} = ? ORDER BY created_at, id`, thingId,
  );
  /**
   * An offer as the owner's list shows it to `viewerId`: by its address —whole to whoever typed it,
   * masked to anyone else— under the offer's id made negative, no account's: that would tell there is one.
   */
  const row = (offer, viewerId) => {
    const shown = addressFor(viewerId, offer.email, offer.invited_by);
    return { user: { id: -offer.id, name: shown, email: shown }, permission: offer[permission], accepted: false, created_at: offer.created_at };
  };

  /** An offer made, or made again with what it lets them do now. → { invited } true when it is new. */
  function keep(kind, thingId, actorId, email, value) {
    const key = keyOf(kind);
    const sets = [`${permission} = ?`, ...(retype ? ['invited_by = ?'] : []), ...(owner ? [`${owner} = ?`] : [])];
    const setValues = [value, ...(retype ? [actorId] : []), ...(owner ? [actorId] : [])];
    if (run(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${key} = ? AND email = ?`, ...setValues, thingId, email).changes) {
      return { invited: false };
    }
    const columns = [key, 'email', permission, 'invited_by', ...(owner ? [owner] : []), ...(stamp ? ['created_at'] : [])];
    const values = [thingId, email, value, actorId, ...(owner ? [actorId] : []), ...(stamp ? [clock()] : [])];
    run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...values);
    return { invited: true };
  }

  const drop = (kind, thingId, email) => {
    if (email) run(`DELETE FROM ${table} WHERE ${keyOf(kind)} = ? AND email = ?`, thingId, email);
  };

  /**
   * The offers by email someone's address waits for become their invitations, to accept or decline:
   * for an account made after the offer, when it looks at what waits for it or takes one up. Only with
   * its email confirmed, so that signing up with someone else's address doesn't bring what was offered
   * to them; never their own things, nor what they have already. Asked on every start: it looks first,
   * and writes only when something waits.
   */
  function claim(userId) {
    const user = get('SELECT email, email_verified_at FROM users WHERE id = ?', userId);
    if (!user?.email || !user.email_verified_at) return;
    if (!get(`SELECT 1 AS x FROM ${table} WHERE email = ?${owner ? ` AND ${owner} <> ?` : ''} LIMIT 1`, user.email, ...(owner ? [userId] : []))) return;
    for (const { key, shares, things, where, copy = ['invited_by', 'created_at'] } of Object.values(kinds)) {
      if (!shares) continue;
      const theirs = owner ? `o.${owner}` : 't.owner_id';
      run(`INSERT INTO ${shares} (${[key, 'user_id', permission, 'accepted', ...copy].join(', ')})
        SELECT ${[`o.${key}`, '?', `o.${permission}`, '0', ...copy.map((column) => `o.${column}`)].join(', ')}
        FROM ${table} o${things ? ` JOIN ${things} t ON t.id = o.${key}` : ''}
        WHERE o.${key} IS NOT NULL AND o.email = ? AND ${theirs} <> ?${where ? ` AND ${where}` : ''}
          AND NOT EXISTS (SELECT 1 FROM ${shares} s WHERE s.${key} = o.${key} AND s.user_id = ?)`,
      userId, user.email, userId, userId);
    }
  }

  return {
    table, kinds: Object.keys(kinds), keyOf,
    find, under, list, row,
    /** The offers of a thing as the owner's list shows them to `viewerId` (row). */
    rows: (kind, thingId, viewerId) => list(kind, thingId).map((offer) => row(offer, viewerId)),
    keep,
    /** What an offer lets them do, changed by its id. */
    setPermission: (offerId, value) => run(`UPDATE ${table} SET ${permission} = ? WHERE id = ?`, value, offerId),
    drop,
    /** The offer of that thing waiting under someone's address: they answered it, or show by their name from now on. */
    dropOf: (kind, thingId, userId) => drop(kind, thingId, get('SELECT email FROM users WHERE id = ?', userId)?.email ?? null),
    /** An offer taken back, by its id. */
    withdraw: (offerId) => run(`DELETE FROM ${table} WHERE id = ?`, offerId),
    /** The offer waiting under someone's address takes what their share lets them do now. */
    follow: (kind, thingId, userId, value) => run(`UPDATE ${table} SET ${permission} = ?
      WHERE ${keyOf(kind)} = ? AND email = (SELECT email FROM users WHERE id = ?)`, value, thingId, userId),
    claim,
  };
}

/** What the audit log calls each step of sharing (admin.actions.share_*). */
export const SHARE_ACTIONS = Object.freeze({
  offer: 'share.offer', permission: 'share.permission', withdraw: 'share.withdraw', leave: 'share.leave',
});

/**
 * One line in the audit log for a step of sharing, the same from every module (audit authz-8):
 * from the web as from an assistant, who opened something to someone else is in /admin › Activity.
 * The engine below writes it; a module that shares without the engine (Projects' team) calls it
 * itself. Who did it, what (the kind and its id) and who it was for (`user`, an account's id; an
 * address without an account only as `stranger`), never a name, a title or an email.
 *   step  offer | permission | withdraw (its owner took it back) | leave (they declined or left)
 */
export function auditShare(audit, { step, actor, req = null, kind, id, targetId = null, permission = null, stranger = false, module = null }) {
  const action = SHARE_ACTIONS[step];
  if (!audit?.record || !action) return;
  audit.record({
    action, actor, req, targetType: kind, targetId: id,
    meta: {
      ...(module ? { module } : {}),
      ...(targetId != null ? { user: Number(targetId) } : {}),
      ...(stranger ? { stranger: true } : {}),
      ...(permission ? { permission } : {}),
    },
  });
}

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
 *   byId: 'by_id'         with `addresses`, the column (INTEGER 0/1) of an offer row that says it
 *                         was made by picking the person (by id), not by typing an address. With
 *                         it, a share waits behind an offer by address only while nobody picked
 *                         them by id, and an offer by email to someone who has it already (accepted,
 *                         or picked) waits under its address like one to an address without an
 *                         account: two leaks of how an address and an account go together close
 *                         (Martin, 14/11/2026; see the top of the file). Without it, as before;
 *   addressOffers         the module's createAddressOffers, with this kind: the engine keeps its
 *                         offers by email itself (see the top of the file), `addresses` from it;
 *   offerGoes: 'theirs'   with addressOffers, the offer under someone's address goes whenever they
 *                         accept, decline or leave (Tasks), not only when they answer the invitation
 *                         it brought, which one picked by id never was (default 'answered');
 *   offerFollows: true    with addressOffers, that offer takes the new permission of their share,
 *                         given by name to whoever wasn't picked by id, waiting or a member (Notes);
 *   strictRemove: false   taking back a share that isn't there answers done, not 404;
 *   path, routes: { segment, list, patch }   its routes (see routes()).
 * @param {object|Function} [options.notify]  { push(n), email(n), stranger?(n) }, or one function for every
 *   notice to an account. `stranger` gets { kind, thing, name, actorId, email, permission }.
 *   n = { kind, thing, name, actorId, targetId, permission }.
 * @param {object} [options.push]  the suite's push service: who has a device (subscriptionsOf).
 * @param {Function} [options.hasPush]  (userId) → whether a push reaches them; overrides `push`.
 * @param {object} [options.brake]  { offer(actorId), notice(actorId, targetId) }; default createShareBrake().
 * @param {Function} [options.requirePlan]  (userId) → throws when the person's plan doesn't share.
 * @param {boolean} [options.byUsername]  also by `username`, for an open directory (directoryClosed).
 * @param {object} [options.codes]  { unknown: 'email_not_found', noTarget: null }: the codes of
 *   a person not found and of an offer that names nobody (null: the email is required).
 * @param {Function} [options.log]
 * @param {object} [options.audit]  the suite's audit log: every offer, change, withdrawal and leave
 *   goes in it (auditShare), with the request's address when a route made it.
 * @param {string} [options.module]  the module's name in those lines, where kinds of two modules
 *   share a name (Next's and Projects' `project`).
 */
export function createSharing({
  db, kinds, notify = null, push = null, hasPush = null, brake = createShareBrake(), requirePlan = null,
  byUsername = false, codes = {}, clock = () => new Date().toISOString(), log = console.error,
  audit = null, module = null,
}) {
  const noted = (step, details) => auditShare(audit, { ...details, step, module });
  const { get, all, run } = db;
  const UNKNOWN = codes.unknown || 'email_not_found';
  const NO_TARGET = codes.noTarget || null;

  const KINDS = Object.fromEntries(Object.entries(kinds).map(([kind, spec]) => [kind, {
    invitedBy: 'invited_by', createdAt: 'created_at', stamp: true, offerGoes: 'answered',
    ...(spec.addressOffers ? { addresses: { table: spec.addressOffers.table, key: spec.addressOffers.keyOf(kind) } } : {}),
    ...spec,
  }]));
  const specOf = (kind) => {
    const spec = KINDS[kind];
    if (!spec) throw new TypeError(`sharing: no kind "${kind}"`);
    return spec;
  };
  const permissionOf = (value) => oneOf(value, PERMISSIONS, 'permission', 'edit');

  /* ------------------------------- people ------------------------------- */

  /**
   * Someone as the sharing screens show them; with `email`, their account's email too, which only
   * the owner of a kind without `addresses` is shown (sharesOf).
   */
  function personOf(userId, { email = false } = {}) {
    const user = get(`SELECT id, display_name, username, email${hasColor() ? ', avatar_color' : ''} FROM users WHERE id = ?`, userId);
    if (!user) return null;
    return {
      id: user.id, name: user.display_name || user.username,
      // The colour they chose, where accounts keep one (Tasks, Projects): the kit's avatar paints it.
      ...(user.avatar_color ? { avatar_color: user.avatar_color } : {}),
      ...(email ? { email: user.email ?? null } : {}),
    };
  }
  /** Whether this app's users have a colour of their own (`users.avatar_color`), asked once. */
  let colorColumn = null;
  function hasColor() {
    colorColumn ??= all("SELECT name FROM pragma_table_info('users')").some((column) => column.name === 'avatar_color');
    return colorColumn;
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
    // Picked by id too, the owner knows them by name: that offer shows, and so does the address's.
    const byId = spec.byId ? ` AND s.${spec.byId} = 0` : '';
    return Boolean(get(`SELECT 1 AS x FROM ${spec.table} s JOIN users u ON u.id = s.user_id
      JOIN ${table} a ON a.${key} = s.${spec.key} AND a.email = u.email COLLATE NOCASE
      WHERE s.${spec.key} = ? AND s.user_id = ? AND s.accepted = 0${byId}`, id, targetId));
  }

  /**
   * Whoever something was offered to; only its owner (`owner`) sees the
   * invitations not yet answered. Of a kind with `addresses`, the owner sees each
   * account by its name, and none waiting behind an offer by address (the module
   * lists the offer); of any other, the emails too, and the address an invitation
   * went to in place of the name. With `viewer` (the owner who asks), a kind with
   * `addressOffers` lists those offers too, by their address as that person is
   * shown it, accepted first and then as they were made.
   * → [{ user, permission, accepted, created_at }].
   */
  function sharesOf(kind, id, { owner = false, viewer = null } = {}) {
    const spec = specOf(kind);
    const { table, key, createdAt } = spec;
    const created = createdAt ? createdAt : 'NULL';
    const typed = owner ? addressesOf(spec, id) : null;
    const picked = spec.byId ? spec.byId : '0';
    const shares = all(`SELECT user_id, permission, accepted, ${picked} AS by_id, ${created} AS created_at FROM ${table}
      WHERE ${key} = ? ${owner ? '' : 'AND accepted = 1'} ORDER BY accepted DESC, ${createdAt ? `${createdAt}, ` : ''}user_id`, id)
      .flatMap((s) => {
        const share = { permission: s.permission, accepted: Boolean(s.accepted), created_at: s.created_at };
        if (!typed) return [{ user: pendingMask(personOf(s.user_id, { email: owner }), s.accepted), ...share }];
        const person = personOf(s.user_id, { email: true });
        // Waiting behind an offer by address: the module lists that offer in its place.
        if (!s.accepted && !s.by_id && person?.email && typed.has(person.email.toLowerCase())) return [];
        // Picked by id, or accepted: by the name the owner already knew, or they showed by
        // accepting. Their email stays theirs.
        return [{ user: person && { id: person.id, name: person.name, ...(person.avatar_color ? { avatar_color: person.avatar_color } : {}) }, ...share }];
      });
    if (!owner || viewer == null || !spec.addressOffers) return shares;
    const offers = spec.addressOffers.rows(kind, id, viewer);
    if (!offers.length) return shares;
    return [...shares, ...offers]
      .sort((a, b) => Number(b.accepted) - Number(a.accepted) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
  }

  /** The account waiting behind an offer by address: its share not accepted (nor picked by id), by that address. */
  function waitingBehind(spec, id, email) {
    const byId = spec.byId ? ` AND s.${spec.byId} = 0` : '';
    return get(`SELECT s.user_id FROM ${spec.table} s JOIN users u ON u.id = s.user_id
      WHERE s.${spec.key} = ? AND s.accepted = 0${byId} AND u.email = ? COLLATE NOCASE`, id, email)?.user_id ?? null;
  }

  /**
   * Who the person may name by id (`user_id`): whoever accepted something of
   * theirs, whoever offered them something (its invitation shows them by name),
   * and whoever else has what they accepted, of every kind; never themselves. Not
   * whoever they only offered something to: an offer by email makes a share for an
   * account and none for an address without one, so naming that account by its id
   * told which addresses have one (audit sc-data-1). With `offered: false`, whoever
   * offered them something only once they accepted it (peopleOf). → a Set of ids.
   */
  function knownTo(userId, { offered = true } = {}) {
    const parts = [];
    const params = [];
    for (const { table, key, owner } of Object.values(KINDS)) {
      if (!owner) continue;
      parts.push(
        // Whoever accepted something of theirs.
        `SELECT s.user_id AS id FROM ${table} s ${owner.join} WHERE ${owner.column} = ? AND s.accepted = 1`,
        // Whoever offered them something.
        `SELECT ${owner.column} FROM ${table} s ${owner.join} WHERE s.user_id = ?${offered ? '' : ' AND s.accepted = 1'}`,
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
   * is for it to show by accepting (#693). Whoever offered them something only
   * once they accepted it: an offer not answered makes nobody known to anybody, in
   * every module. → [{ id, name }].
   */
  function peopleOf(userId) {
    return [...knownTo(userId, { offered: false })].map((id) => personOf(id)).filter(Boolean)
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

  /**
   * One offer of the person's towards the brake: past its limit, 429 share_limit. The engine's
   * own, and `countOffer` for a module that changes an offer by address itself
   * (setPermission's `byAddress`): it counts it before it changes anything, the same whether an
   * account waits behind the offer or none, or the limit would tell them apart.
   */
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
  function offerRow(kind, id, userId, targetId, permission, { picked = false } = {}) {
    const { table, key, invitedBy, createdAt, stamp, byId } = specOf(kind);
    const columns = [key, 'user_id', 'permission', 'accepted'];
    const values = [id, targetId, permission, 0];
    if (invitedBy) { columns.push(invitedBy); values.push(userId); }
    if (createdAt && stamp) { columns.push(createdAt); values.push(clock()); }
    if (byId) { columns.push(byId); values.push(picked ? 1 : 0); }
    // Once picked by id, it stays so: an offer by address made after it changes nothing of that.
    // Picked now after an offer typed to their address: dated now, as a new offer, or its date and
    // place in the owner's list next to the address's would tell whose address it is.
    let keep = '';
    if (byId) {
      keep = `, ${byId} = MAX(${table}.${byId}, excluded.${byId})`;
      if (createdAt) {
        const now = stamp ? `excluded.${createdAt}` : "datetime('now')";
        keep += `, ${createdAt} = CASE WHEN ${table}.accepted = 0 AND ${table}.${byId} = 0 AND excluded.${byId} = 1
          THEN ${now} ELSE ${table}.${createdAt} END`;
      }
    }
    run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
      ON CONFLICT (${key}, user_id) DO UPDATE SET permission = excluded.permission${keep}`, ...values);
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
    const req = ctx?.req ?? null;
    // With `addressOffers`, kept under its address; where nothing else was made, its owner's tabs get
    // the very notices an account's offer gives them: the live channel numbers every notice.
    const waitsUnder = (email) => {
      if (!spec.addressOffers) return;
      spec.addressOffers.keep(kind, thing.id, userId, email, permission);
      spec.offered?.({ userId, thing, targetId: null, permission, invited: true, ctx });
    };
    if (who.ghost) {
      waitsUnder(who.email);
      const answered = answer({ kind, userId, thing, target: who, permission, invited: true, ctx });
      tellStranger(kind, thing, userId, who.email, permission);
      noted('offer', { actor: userId, req, kind, id: thing.id, stranger: true, permission });
      return answered;
    }
    const row = shareRow(kind, thing.id, who.id);
    // By email to someone who has it already —accepted, or picked by id—, nothing of theirs changes:
    // it waits under the address, as for one without an account, and answers the same. Else the
    // answer ("accepted", its date) or a permission changing on their row told the owner that the
    // address they typed is that person's (Martin, 14/11/2026; `byId`).
    if (spec.byId && who.email && row && (row.accepted || row[spec.byId])) {
      count(userId);
      const shadow = { ghost: true, email: who.email };
      waitsUnder(who.email);
      const answered = answer({ kind, userId, thing, target: shadow, permission, invited: true, ctx });
      noted('offer', { actor: userId, req, kind, id: thing.id, stranger: true, permission });
      return answered;
    }
    const picked = !who.email;
    // Picked by id after an offer by address only: a new offer to them by name, told as one.
    const invited = !row || Boolean(spec.byId && picked && !row.accepted && !row[spec.byId]);
    // An offer not yet accepted counts every time, by email as by id: each one tells them
    // (`offered`), and one counted offer by id, made again and again, made their tabs reload
    // without limit (audit sc-data-6). By email it also finds the limit as soon as an address
    // without an account does, which counts every time.
    if (invited || !row.accepted) count(userId);
    offerRow(kind, thing.id, userId, who.id, permission, { picked });
    // In the log once it is made: a new offer, or one made again while unanswered; for someone who
    // accepted, what they may do, when it changed.
    if (invited || !row.accepted) noted('offer', { actor: userId, req, kind, id: thing.id, targetId: who.id, permission });
    else if (row.permission !== permission) noted('permission', { actor: userId, req, kind, id: thing.id, targetId: who.id, permission });
    follow(spec, kind, thing, who.id, permission);
    spec.offered?.({ userId, thing, targetId: who.id, permission, invited, ctx });
    if (invited) tell(kind, thing, userId, who.id, permission);
    // By email it waits under the address as well, as for an address without an account; accepted
    // already, only what they may do changed: they show by their name, with nothing waiting.
    if (spec.addressOffers && who.email) {
      if (row?.accepted) spec.addressOffers.drop(kind, thing.id, who.email);
      else spec.addressOffers.keep(kind, thing.id, userId, who.email, permission);
    }
    return answer({ kind, userId, thing, target: who, permission, invited, ctx });
  }

  /**
   * With `offerFollows`, the offer under someone's address takes the permission their share was
   * given by name, unless they were picked by id: that offer is another, of their name.
   */
  function follow(spec, kind, thing, targetId, permission) {
    if (!spec.offerFollows || !spec.addressOffers || !targetId) return;
    if (spec.byId && shareRow(kind, thing.id, targetId)?.[spec.byId]) return;
    spec.addressOffers.follow(kind, thing.id, targetId, permission);
  }

  /** Who has something: its owner and whoever it was offered to (and, for its owner, its offers by address). → { role, owner, shares }. */
  function list(kind, userId, id) {
    const { thing, role, ownerId } = specOf(kind).read(userId, id);
    return { role, owner: personOf(ownerId), shares: sharesOf(kind, thing.id, { owner: role === 'owner', viewer: userId }) };
  }

  /**
   * Changes what someone it was offered to may do. Only its owner. → their share.
   * Someone waiting behind an offer by address answers as a share that isn't there
   * (behindAddress), unless the module changes that offer (`byAddress`). Not
   * accepted yet, the change counts as an offer made again: it tells them as one
   * does (`changed`). By address the module counted it already (countOffer). Of a
   * kind with `addressOffers`, a negative id is an offer by address (changeOffer).
   */
  function setPermission(kind, userId, id, targetId, permission, { byAddress = false, req = null } = {}) {
    const spec = specOf(kind);
    if (spec.addressOffers && Number(targetId) < 0) return changeOffer(kind, userId, id, -Number(targetId), permission);
    const thing = spec.own(userId, id);
    const perm = permissionOf(permission);
    const { table, key } = spec;
    if (!byAddress && behindAddress(spec, thing.id, targetId)) throw notFound();
    const row = shareRow(kind, thing.id, targetId);
    if (!row) throw notFound();
    if (!row.accepted && !byAddress) count(userId);
    run(`UPDATE ${table} SET permission = ? WHERE ${key} = ? AND user_id = ?`, perm, thing.id, targetId);
    if (row.permission !== perm) noted('permission', { actor: userId, req, kind, id: thing.id, targetId, permission: perm });
    follow(spec, kind, thing, targetId, perm);
    spec.changed?.({ userId, thing, targetId, permission: perm });
    return sharesOf(kind, thing.id, { owner: true }).find((s) => s.user.id === targetId);
  }

  /**
   * A new permission for an offer by address, named by its id (`-<id>`, as the owner's list shows
   * it): counted as an offer made again before anything changes, whether an account waits behind it
   * or none, or the limit would tell them apart; that account's share takes it too, and with none the
   * kind's `changed` runs for nobody. → its row, as the owner's list shows it.
   */
  function changeOffer(kind, userId, id, offerId, permission) {
    const spec = specOf(kind);
    const offers = spec.addressOffers;
    const thing = spec.own(userId, id);
    const perm = permissionOf(permission);
    const offer = offers.find(kind, thing.id, offerId);
    if (!offer) throw notFound();
    count(userId);
    offers.setPermission(offer.id, perm);
    const waiting = waitingBehind(spec, thing.id, offer.email);
    if (waiting) setPermission(kind, userId, thing.id, waiting, perm, { byAddress: true });
    else spec.changed?.({ userId, thing, targetId: null, permission: perm });
    return offers.rows(kind, thing.id, userId).find((s) => s.user.id === -offer.id);
  }

  /**
   * Takes back an offer by address, named by its id: only the thing's owner (`leaving` with someone
   * else's id). With an account waiting behind it, as any share is taken back (its hooks, its
   * notices); with none, the row alone and the same hooks for nobody, so nothing tells them apart.
   * One that isn't there is a 404, or done with `strictRemove: false`.
   */
  function withdrawOffer(kind, userId, id, offerId) {
    const spec = specOf(kind);
    const offers = spec.addressOffers;
    const { thing, ownerId } = spec.leaving(userId, id, -offerId);
    const offer = offers.find(kind, thing.id, offerId);
    if (!offer) {
      if (spec.strictRemove !== false) throw notFound();
      return;
    }
    const waiting = waitingBehind(spec, thing.id, offer.email);
    // Gone first: by its own id, an account waiting behind it would be a share that isn't there.
    offers.withdraw(offer.id);
    if (waiting) {
      remove(kind, userId, thing.id, waiting);
      return;
    }
    const info = { userId, thing, ownerId, targetId: null, row: null };
    spec.removing?.(info);
    spec.removed?.(info);
  }

  /**
   * Whether the offer under someone's address goes with what they did to their share (`offerGoes`):
   * by default when they answer the invitation it brought —accepting or declining one typed, never
   * one they were picked for by id—; 'theirs', whenever they accept, decline or leave.
   */
  const offerGoes = (spec, row, targetId, userId) => (spec.offerGoes === 'theirs'
    ? Number(targetId) === Number(userId)
    : !row.accepted && !(spec.byId && row[spec.byId]));

  /**
   * Ends someone's access: its owner takes it back from anyone; anyone else,
   * only from themselves (declining an invitation, or leaving what they had
   * accepted). With `strictRemove: false` a share that isn't there is not a 404.
   * A share that isn't there runs no hook either: nothing changed, so nobody is
   * told. It used to tell whoever the id named, and Tasks' tabs reload on that,
   * so anyone could make anyone's reload, as often as they liked (audit
   * sc-data-6); now every notice a removal sends is for a share an offer made,
   * and offers are what the brake counts. Of a kind with `addressOffers`, a
   * negative id is an offer by address (withdrawOffer).
   */
  function remove(kind, userId, id, targetId, { req = null } = {}) {
    const spec = specOf(kind);
    if (spec.addressOffers && Number(targetId) < 0) return withdrawOffer(kind, userId, id, -Number(targetId));
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
    noted(Number(targetId) === Number(userId) ? 'leave' : 'withdraw', { actor: userId, req, kind, id: thing.id, targetId });
    if (spec.addressOffers && offerGoes(spec, row, targetId, userId)) spec.addressOffers.dropOf(kind, thing.id, targetId);
    spec.removed?.(info);
  }

  /** Takes up an invitation. → what the kind answers (`accepted`), else the thing. */
  function accept(kind, userId, id, body = {}, ctx = null) {
    const spec = specOf(kind);
    // An account made after an offer to its address takes it up without having looked first.
    spec.addressOffers?.claim(userId);
    const thing = spec.pending(userId, id);
    spec.accepting?.({ userId, thing, body, ctx });
    acceptOffer(kind, thing.id, userId);
    // From now on they show by their name: the address it went to waits no more (`offerGoes`).
    if (spec.addressOffers && (spec.offerGoes === 'theirs' || !(spec.byId && shareRow(kind, thing.id, userId)?.[spec.byId]))) {
      spec.addressOffers.dropOf(kind, thing.id, userId);
    }
    return spec.accepted ? spec.accepted({ userId, thing, body, ctx }) : thing;
  }

  /** What waits under this person's address, of every kind with `addressOffers`, becomes their invitations. */
  function claimAddressOffers(userId) {
    for (const offers of new Set(Object.values(KINDS).map((spec) => spec.addressOffers).filter(Boolean))) offers.claim(userId);
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
   * `id(ctx, name)` its reading of an id in the path. Of a kind with
   * `addressOffers`, a negative :userId is an offer by address.
   */
  function routes(router, { user, id, people = null }) {
    for (const [kind, spec] of Object.entries(KINDS)) {
      if (!spec.path) continue;
      const { segment = 'shares', list: withList = true, patch: withPatch = true } = spec.routes || {};
      const at = `${spec.path}/${segment}`;
      const targetIn = (ctx) => {
        const raw = Number(ctx.params.userId);
        return spec.addressOffers && Number.isSafeInteger(raw) && raw < 0 ? raw : id(ctx, 'userId');
      };
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
          sendJson(ctx.res, 200, setPermission(kind, me.id, id(ctx, 'id'), targetIn(ctx), body.permission, { req: ctx.req }));
        });
      }
      router.delete(`${at}/:userId`, async (ctx) => {
        const me = user(ctx);
        remove(kind, me.id, id(ctx, 'id'), targetIn(ctx), { req: ctx.req });
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
    personOf, sharesOf, peopleOf, knownTo, target, shareRow, emailAnswer, countOffer: count,
    share, list, setPermission, remove, accept, pending, claimAddressOffers, routes,
  };
}
