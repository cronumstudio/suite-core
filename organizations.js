/**
 * Organizations: groups of people who share data, roles and a subscription —
 * a household in Tasks or Focus, a school in Tracker, a team in Projects.
 *
 * Optional per app (`modules.organizations`). The suite keeps who belongs to
 * which group and with what role, and the invitations; which records belong to
 * a group instead of a person is decided in the app's own tables.
 *
 * Roles: `owner`, `admin` and `member`, in that order of power, plus the app's
 * own (Tracker's drivers), which rank as members. A group never loses its
 * last owner. A grant with a quantity on an organization is its seats: when
 * `seatsOf` says how many, joining beyond them is refused. Every member takes a
 * seat, unless the app names the roles that do (`seatRoles`: Tracker pays per
 * driver, and its admins and viewers are free); then only those roles count,
 * and a role change into one of them needs a free seat as joining does.
 *
 * Kinds an app manages (`kinds`, suite.config.js `organizations.kinds`): a kind
 * can be the app's own to manage (`managed`: Focus's families), and then the
 * suite's generic routes (/api/orgs) refuse to create one, to join one by an
 * invitation, and to leave or remove its members, answering 403
 * `organization_managed`: the app's own routes do it, through these same
 * functions, with its own rules. A kind may cap how many of its groups one
 * person is in (`maxPerUser`, 409 `organization_limit`), enforced here
 * whoever calls. And a group of a kind that says so (`onEmpty: 'delete'`, the
 * default of a managed kind) is deleted when its last member goes, instead of
 * archived. The app hears, inside the same transaction, of each member who
 * goes (`whenMemberRemoved`) and of each group deleted (`whenDeleted`), so it
 * deletes its own rows with them; a hook that throws undoes the whole change.
 * Each membership that goes is told once: by `whenMemberRemoved`, except the
 * memberships a group still has when it is deleted whole (`remove`), which
 * `whenDeleted` tells. Without kinds everything behaves as before.
 *
 * Not to be confused with a data copy's `copyKinds` (portability.js): the kinds
 * of group a copy carries, a list, where these are the rules of each kind.
 */
import { randomToken, sha256 } from './crypto.js';
import { HttpError, badRequest, notFound, forbidden, conflict } from './http.js';

const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
/**
 * How long an expired invitation is kept after it expires: whoever opens its link a few days
 * late still hears that it expired and to ask for a new one (410 `invitation_expired`), not that
 * it was used or withdrawn (404), which is all a link nobody knows can be told. One accepted or
 * withdrawn answers 404 either way, so it goes at the next clean-up.
 */
const INVITATION_GRACE_DAYS = 14;

/** What a kind may say, and what a kind nobody declared does: what every group did before kinds. */
const KIND_KEYS = ['managed', 'maxPerUser', 'onEmpty'];
/** A kind's name, as the configuration and a data copy write it: one rule for both (portability.js). */
export const KIND_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
/**
 * Why a member goes, as `whenMemberRemoved` says it: they left, someone (or the app) removed them,
 * their account was deleted, or an import that replaces what they have handed the group over to
 * those who stay (`handed_over`, portability.js's hand-over).
 */
export const MEMBER_REASONS = Object.freeze(['left', 'removed', 'account_deleted', 'handed_over']);
const PLAIN_KIND = Object.freeze({ managed: false, maxPerUser: null, onEmpty: 'archive' });
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The kinds of suite.config.js `organizations.kinds`, checked and filled in:
 *   { family: { managed: true, maxPerUser: 1 } } → { family: { managed: true, maxPerUser: 1, onEmpty: 'delete' } }
 * A managed kind is deleted when empty unless it says `onEmpty: 'archive'`; any other kind is
 * archived, as before, unless it says `onEmpty: 'delete'`. → { kinds, errors } (config.js's wording)
 */
export function organizationKinds(given, { prefix = 'organizations.kinds' } = {}) {
  const kinds = {};
  const errors = [];
  if (given === undefined || given === null) return { kinds, errors };
  if (!isObject(given)) {
    errors.push(`${prefix}: an object of kinds, such as { family: { managed: true, maxPerUser: 1 } }`);
    return { kinds, errors };
  }
  for (const [kind, spec] of Object.entries(given)) {
    // The same names a group's kind is written with; never one of Object's own (constructor…).
    if (!KIND_NAME.test(kind) || Object.hasOwn(Object.prototype, kind)) {
      errors.push(`${prefix}: "${kind}" is not a kind's name (up to 40 lowercase letters, digits, - and _, starting with a letter)`);
      continue;
    }
    if (!isObject(spec)) {
      errors.push(`${prefix}.${kind}: an object, such as { managed: true, maxPerUser: 1 }`);
      continue;
    }
    // A misspelt key would leave a barrier open without a word: `manage` would let the generic routes in.
    for (const key of Object.keys(spec)) {
      if (!KIND_KEYS.includes(key)) errors.push(`${prefix}.${kind}.${key} is not a setting (${KIND_KEYS.join(', ')})`);
    }
    const managed = spec.managed ?? false;
    const maxPerUser = spec.maxPerUser ?? null;
    const onEmpty = spec.onEmpty ?? (managed === true ? 'delete' : 'archive');
    if (typeof managed !== 'boolean') errors.push(`${prefix}.${kind}.managed must be true or false`);
    if (maxPerUser !== null && !(Number.isInteger(maxPerUser) && maxPerUser >= 1 && maxPerUser <= 1000)) {
      errors.push(`${prefix}.${kind}.maxPerUser: a whole number from 1 to 1000, or left out for no limit`);
    }
    if (!['archive', 'delete'].includes(onEmpty)) errors.push(`${prefix}.${kind}.onEmpty: 'archive' or 'delete'`);
    kinds[kind] = { managed: managed === true, maxPerUser, onEmpty };
  }
  return { kinds, errors };
}

export function organizationsSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS organizations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    kind        TEXT,
    settings    TEXT NOT NULL DEFAULT '{}',
    branding    TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE TABLE IF NOT EXISTS memberships (
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    invited_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    joined_at       TEXT NOT NULL,
    PRIMARY KEY (organization_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS ix_memberships_user ON memberships (user_id);
  CREATE TABLE IF NOT EXISTS invitations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email           TEXT,
    role            TEXT NOT NULL,
    token_hash      TEXT NOT NULL UNIQUE,
    invited_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at      TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    accepted_at     TEXT,
    accepted_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    revoked_at      TEXT
  )`);
}

const POWER = { owner: 3, admin: 2 };
const power = (role) => POWER[role] ?? (role ? 1 : 0);

/** A slug from a name: "Casa Andersen" → "casa-andersen", made unique by the caller. */
const slugOf = (name) => String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'group';

/**
 * @param {object} options
 * @param {object} options.database
 * @param {string[]} [options.roles]   every role, the app's own included
 * @param {(organizationId) => number|null} [options.seatsOf]   how many members fit; null = no limit
 * @param {string[]|null} [options.seatRoles]   the roles that take a seat; null = every member
 * @param {number} [options.invitationDays]
 * @param {object} [options.kinds]   { family: { managed, maxPerUser, onEmpty } } (organizationKinds above)
 * @param {object} [options.audit]   for what happens without a route: a group deleted (`org.delete`)
 */
export function createOrganizations({
  database, roles = ['owner', 'admin', 'member'], seatsOf = () => null, seatRoles = null, invitationDays = 7,
  kinds: givenKinds = {}, audit = null, clock = () => Date.now(),
}) {
  if (seatRoles !== null && !(Array.isArray(seatRoles) && seatRoles.length && seatRoles.every((r) => roles.includes(r)))) {
    throw new Error(`createOrganizations: seatRoles must be some of the roles (${roles.join(', ')}), or null for every member`);
  }
  const { kinds: checked, errors: kindErrors } = organizationKinds(givenKinds);
  if (kindErrors.length) throw new Error(`createOrganizations: ${kindErrors.join('; ')}`);
  // Frozen: what rulesFor() hands out can't open a barrier by being changed.
  const kinds = Object.freeze(Object.fromEntries(Object.entries(checked).map(([kind, rules]) => [kind, Object.freeze({ ...rules })])));
  /** What a kind says: a kind nobody declared (and a group without one) is as every group was before kinds. */
  const rulesFor = (kind) => (kind != null && Object.hasOwn(kinds, String(kind)) ? kinds[String(kind)] : PLAIN_KIND);
  const isManaged = (kind) => rulesFor(kind).managed;
  /** Who hears of a member who goes, and of a group deleted: inside the change's transaction. */
  const memberHooks = [];
  const addedHooks = [];
  const deletedHooks = [];
  /** Billing's: after every app's, whenever each joined (a host's modules join after the suite). */
  const lastDeletedHooks = [];
  const checkRole = (role) => {
    if (!roles.includes(role)) throw badRequest('field_invalid', { field: 'role', options: roles });
    return role;
  };
  const takesSeat = (role) => seatRoles === null || seatRoles.includes(role);
  const get = (id) => database.get('SELECT * FROM organizations WHERE id = ? AND archived_at IS NULL', id) || null;
  const mustExist = (id) => {
    const organization = get(id);
    if (!organization) throw notFound('organization_not_found');
    return organization;
  };
  const roleOf = (organizationId, userId) => database.get(
    'SELECT role FROM memberships WHERE organization_id = ? AND user_id = ?', organizationId, userId)?.role ?? null;
  const owners = (organizationId) => Number(database.get(
    "SELECT COUNT(*) AS n FROM memberships WHERE organization_id = ? AND role = 'owner'", organizationId).n);
  const memberCount = (organizationId) => Number(database.get(
    'SELECT COUNT(*) AS n FROM memberships WHERE organization_id = ?', organizationId).n);
  /** A group's row, archived or not: what is deleted, and what its hooks are told. */
  const rowOf = (organizationId) => database.get('SELECT * FROM organizations WHERE id = ?', organizationId) || null;
  /** The members who take a seat: all of them, or those with one of `seatRoles`. */
  const seatsTaken = (organizationId) => Number((seatRoles === null
    ? database.get('SELECT COUNT(*) AS n FROM memberships WHERE organization_id = ?', organizationId)
    : database.get(`SELECT COUNT(*) AS n FROM memberships WHERE organization_id = ?
      AND role IN (${seatRoles.map(() => '?').join(', ')})`, organizationId, ...seatRoles)).n);

  /**
   * Refuses a person one more group of a kind with `maxPerUser` when they are in as many already
   * (archived groups don't count: nobody sees them). Whoever calls: the generic routes, the app's.
   */
  function checkLimit(userId, kind) {
    const { maxPerUser } = rulesFor(kind);
    if (maxPerUser == null) return;
    const count = Number(database.get(`SELECT COUNT(*) AS n FROM memberships m JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = ? AND o.kind = ? AND o.archived_at IS NULL`, userId, String(kind)).n);
    if (count >= maxPerUser) throw conflict('organization_limit', { kind: String(kind), max: maxPerUser });
  }

  /** Refuses one more member in a seat when the seats `seatsOf` gives are all taken. */
  function checkSeat(organizationId) {
    const seats = seatsOf(organizationId);
    if (seats != null && seatsTaken(organizationId) >= seats) throw new HttpError(402, 'seats_full', { seats });
  }

  /**
   * Refuses whoever is not in the group (404: a group someone can't see
   * doesn't exist for them) or has less than `needed` (403).
   */
  function requireRole(organizationId, userId, needed = 'member') {
    const role = roleOf(organizationId, userId);
    if (!role || !get(organizationId)) throw notFound('organization_not_found');
    if (power(role) < power(needed)) throw forbidden('organization_role');
    return role;
  }

  function create({ name, kind = null, ownerId }) {
    const clean = String(name ?? '').trim();
    if (!clean) throw badRequest('field_required', { field: 'name' });
    if (clean.length > 80) throw badRequest('field_too_long', { field: 'name', max: 80 });
    return database.tx(() => {
      if (ownerId != null) checkLimit(ownerId, kind);
      const base = slugOf(clean);
      let slug = base;
      for (let n = 2; database.get('SELECT 1 FROM organizations WHERE slug = ?', slug); n++) slug = `${base}-${n}`;
      const now = iso(clock());
      const { lastInsertRowid: id } = database.run(
        'INSERT INTO organizations (slug, name, kind, created_at) VALUES (?, ?, ?, ?)', slug, clean, kind, now);
      if (ownerId != null) {
        database.run("INSERT INTO memberships (organization_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
          id, ownerId, now);
      }
      return get(id);
    });
  }

  function addMember(organizationId, userId, role = 'member', { invitedBy = null } = {}) {
    return database.tx(() => {
      const organization = mustExist(organizationId);
      checkRole(role);
      if (roleOf(organizationId, userId)) throw conflict('already_member');
      checkLimit(userId, organization.kind);
      if (takesSeat(role)) checkSeat(organizationId);
      database.run('INSERT INTO memberships (organization_id, user_id, role, invited_by, joined_at) VALUES (?, ?, ?, ?, ?)',
        organizationId, userId, role, invitedBy, iso(clock()));
      for (const hook of addedHooks) hook({ organization, userId, role, invitedBy });
    });
  }

  function setRole(organizationId, userId, role) {
    checkRole(role);
    const current = roleOf(organizationId, userId);
    if (!current) throw notFound('member_not_found');
    if (current === 'owner' && role !== 'owner' && owners(organizationId) <= 1) throw conflict('last_owner');
    // A viewer made a driver takes a seat as one who joins as a driver does. With every member in a
    // seat (no seatRoles) a role change takes none: the person already had theirs.
    if (!takesSeat(current) && takesSeat(role)) checkSeat(organizationId);
    database.run('UPDATE memberships SET role = ? WHERE organization_id = ? AND user_id = ?', role, organizationId, userId);
  }

  /**
   * Tells the app's hooks that a member goes, before their membership does: every path that takes
   * one membership away calls it once, right before its DELETE and inside its transaction (a
   * hand-over included: reason `handed_over`).
   */
  const memberGoes = (organization, userId, role, reason, by) => {
    if (!MEMBER_REASONS.includes(reason)) throw new TypeError(`memberGoes: "${reason}" is not one of ${MEMBER_REASONS.join(', ')}`);
    for (const hook of memberHooks) hook({ organization, userId, role, reason, by });
  };

  /**
   * A member goes: they leave (`by` is themselves) or are removed (by someone else, or by the app
   * with no `by`). The app's hooks hear it first, in the same transaction. A group never loses its
   * last owner, except the last member of a kind deleted when empty: they take the group with them.
   * → { organizationDeleted }
   */
  function removeMember(organizationId, userId, { by = null } = {}) {
    return database.tx(() => {
      const current = roleOf(organizationId, userId);
      if (!current) throw notFound('member_not_found');
      const organization = rowOf(organizationId);
      const empties = memberCount(organizationId) === 1 && rulesFor(organization.kind).onEmpty === 'delete';
      if (!empties && current === 'owner' && owners(organizationId) <= 1) throw conflict('last_owner');
      const reason = by != null && Number(by) === Number(userId) ? 'left' : 'removed';
      memberGoes(organization, userId, current, reason, by);
      database.run('DELETE FROM memberships WHERE organization_id = ? AND user_id = ?', organizationId, userId);
      if (empties) remove(organizationId, { reason: 'empty', by });
      return { organizationDeleted: empties };
    });
  }

  /**
   * A group goes for good, whatever it holds: the app's hooks first (`whenDeleted`, to delete its
   * own rows of it), then its plan grants (which name it by id, with no reference to cascade by),
   * invitations, memberships and the group itself, in one transaction. Its audit entries stay,
   * without the reference. Billing's rows are billing's to keep or let go (createSuite hooks it).
   * `reason`: 'empty' when its last member went, else the caller's. → whether there was one
   */
  function remove(organizationId, { reason = 'deleted', by = null } = {}) {
    return database.tx(() => {
      const organization = rowOf(organizationId);
      if (!organization) return false;
      for (const hook of [...deletedHooks, ...lastDeletedHooks]) hook({ organization, reason, by });
      database.run("DELETE FROM entitlement_grants WHERE subject_type = 'organization' AND subject_id = ?", organizationId);
      database.run('DELETE FROM invitations WHERE organization_id = ?', organizationId);
      database.run('DELETE FROM memberships WHERE organization_id = ?', organizationId);
      database.run('DELETE FROM organizations WHERE id = ?', organizationId);
      audit?.record({
        action: 'org.delete', actor: by, targetType: 'organization', targetId: organizationId,
        meta: { kind: organization.kind ?? null, reason },
      });
      return true;
    });
  }

  /** An invitation link: the token is returned once and only its hash is kept. */
  function invite(organizationId, { role = 'member', email = null, invitedBy = null, days = invitationDays } = {}) {
    mustExist(organizationId);
    checkRole(role);
    const token = `inv_${randomToken(24)}`;
    const now = clock();
    const { lastInsertRowid: id } = database.run(`INSERT INTO invitations (organization_id, email, role, token_hash,
        invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    organizationId, email ? String(email).trim().toLowerCase() : null, role, sha256(token), invitedBy,
    iso(now), iso(now + days * DAY));
    return { token, invitation: database.get('SELECT * FROM invitations WHERE id = ?', id) };
  }

  /**
   * Joins the group of an invitation: once, before it expires, unless revoked.
   * The link is what admits; the email it was sent to is only a note of whom for.
   */
  function accept(token, userId) {
    return database.tx(() => {
      const invitation = database.get('SELECT * FROM invitations WHERE token_hash = ?', sha256(String(token || '')));
      if (!invitation || invitation.revoked_at || invitation.accepted_at) throw notFound('invitation_invalid');
      if (invitation.expires_at <= iso(clock())) throw new HttpError(410, 'invitation_expired');
      addMember(invitation.organization_id, userId, invitation.role, { invitedBy: invitation.invited_by });
      database.run('UPDATE invitations SET accepted_at = ?, accepted_by = ? WHERE id = ?', iso(clock()), userId, invitation.id);
      return get(invitation.organization_id);
    });
  }

  /** The kind of the group an invitation is for, whatever its state: what the generic join route asks first. */
  const invitationKind = (token) => database.get(`SELECT o.kind FROM invitations i JOIN organizations o ON o.id = i.organization_id
    WHERE i.token_hash = ?`, sha256(String(token || '')))?.kind ?? null;

  /**
   * The clean-up (suite.purge): invitations accepted or withdrawn, and those expired more than
   * `graceDays` ago. They hold the email they were sent to, and none can let anyone in any more.
   * → how many went
   */
  const purge = ({ graceDays = INVITATION_GRACE_DAYS } = {}) => database.run(`DELETE FROM invitations
    WHERE accepted_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at < ?`, iso(clock() - graceDays * DAY)).changes;

  const revokeInvitation = (organizationId, id) => database.run(
    'UPDATE invitations SET revoked_at = ? WHERE id = ? AND organization_id = ? AND revoked_at IS NULL AND accepted_at IS NULL',
    iso(clock()), id, organizationId).changes > 0;

  const invitationsOf = (organizationId) => database.all(`SELECT id, email, role, invited_by, created_at, expires_at,
      accepted_at, accepted_by, revoked_at FROM invitations WHERE organization_id = ? ORDER BY id DESC`, organizationId);

  const membersOf = (organizationId) => database.all(`SELECT m.user_id, u.username, u.display_name, m.role, m.joined_at
    FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? ORDER BY m.joined_at`, organizationId);

  /** The groups of a person, with their role in each. */
  const ofUser = (userId) => database.all(`SELECT o.*, m.role FROM memberships m
    JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? AND o.archived_at IS NULL ORDER BY o.name`, userId);

  /** For entitlements: the ids of a person's groups. */
  const organizationsOf = (user) => (user?.id ? ofUser(user.id).map((o) => o.id) : []);

  function update(organizationId, { name, settings, branding } = {}) {
    mustExist(organizationId);
    if (name !== undefined) {
      const clean = String(name ?? '').trim();
      if (!clean) throw badRequest('field_required', { field: 'name' });
      database.run('UPDATE organizations SET name = ? WHERE id = ?', clean.slice(0, 80), organizationId);
    }
    if (settings !== undefined) database.run('UPDATE organizations SET settings = ? WHERE id = ?', JSON.stringify(settings || {}), organizationId);
    if (branding !== undefined) database.run('UPDATE organizations SET branding = ? WHERE id = ?', JSON.stringify(branding || {}), organizationId);
    return get(organizationId);
  }

  /** Archived, not deleted: the app's records that point at it keep their meaning. */
  const archive = (organizationId) => database.run(
    'UPDATE organizations SET archived_at = ? WHERE id = ? AND archived_at IS NULL', iso(clock()), organizationId).changes > 0;

  /*
   * A membership has one role, so whoever becomes owner leaves the one they had: with `seatRoles`,
   * a driver made owner would stop driving and free a seat. Those whose seat doesn't change come
   * first; a driver inherits only when nobody else is left, and the group keeps an owner.
   */
  const seatShifting = roles.filter((r) => takesSeat(r) !== takesSeat('owner'));
  const heirOrder = seatShifting.length
    ? `CASE WHEN role IN (${seatShifting.map(() => '?').join(', ')}) THEN 1 ELSE 0 END, ` : '';

  /**
   * Before an account is deleted (hook it with `accounts.whenRemoved`): each
   * group it was the last owner of passes to its oldest admin, or else its
   * oldest member, those in a seat role last; a group left with nobody is
   * archived, or deleted when its kind says so (`onEmpty: 'delete'`). The app's
   * hooks hear of each membership that goes (reason `account_deleted`) and of
   * each group deleted, inside the removal's transaction.
   */
  function forgetUser(userId) {
    return database.tx(() => {
      const memberships = database.all(`SELECT o.*, m.role AS member_role FROM memberships m
        JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? ORDER BY o.id`, userId);
      const emptied = [];
      for (const { member_role: role, ...organization } of memberships) {
        const { id } = organization;
        if (memberCount(id) <= 1 && rulesFor(organization.kind).onEmpty === 'delete') {
          emptied.push(id);
        } else if (role === 'owner' && owners(id) <= 1) {
          const heir = database.get(`SELECT user_id FROM memberships WHERE organization_id = ? AND user_id <> ?
            ORDER BY ${heirOrder}CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at, user_id LIMIT 1`, id, userId, ...seatShifting);
          if (heir) {
            database.run("UPDATE memberships SET role = 'owner' WHERE organization_id = ? AND user_id = ?", id, heir.user_id);
          } else {
            archive(id);
          }
        }
        memberGoes(organization, userId, role, 'account_deleted', null);
      }
      database.run('DELETE FROM memberships WHERE user_id = ?', userId);
      for (const id of emptied) remove(id, { reason: 'empty' });
    });
  }

  const list = () => database.all(`SELECT o.*, (SELECT COUNT(*) FROM memberships m WHERE m.organization_id = o.id) AS members
    FROM organizations o WHERE o.archived_at IS NULL ORDER BY o.name`);

  /** A person's groups of a kind deleted when empty (`onEmpty: 'delete'`), archived ones too. */
  const deletableOf = (userId) => database.all(`SELECT o.id, o.kind FROM memberships m
    JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? ORDER BY o.id`, userId)
    .filter((o) => rulesFor(o.kind).onEmpty === 'delete').map((o) => o.id);

  /**
   * Whether a group goes once the accounts waiting to be deleted go: of a kind deleted when empty,
   * with members, and every one of them waiting (`users.delete_after`, account-deletion.js). What
   * createSuite stops renewing as soon as it is so, and renews again when it no longer is.
   */
  function leaving(organizationId) {
    const organization = rowOf(organizationId);
    if (!organization || rulesFor(organization.kind).onEmpty !== 'delete') return false;
    const { members, staying } = database.get(`SELECT COUNT(*) AS members,
        COALESCE(SUM(CASE WHEN u.delete_after IS NULL THEN 1 ELSE 0 END), 0) AS staying
      FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ?`, organizationId);
    return Number(members) > 0 && Number(staying) === 0;
  }

  /**
   * Whether a group was here once and was deleted: its id is one this table gave out (AUTOINCREMENT
   * never gives one twice) and it is no longer here. Billing stops a subscription that names one.
   */
  function wasDeleted(organizationId) {
    const id = Number(organizationId);
    if (!Number.isSafeInteger(id) || id < 1 || rowOf(id)) return false;
    let last = 0;
    try {
      last = Number(database.get("SELECT seq FROM sqlite_sequence WHERE name = 'organizations'")?.seq ?? 0);
    } catch { /* no group was ever made here */ }
    return id <= last;
  }

  return {
    create, get, list, update, archive, remove, roleOf, requireRole, addMember, setRole, removeMember,
    invite, accept, revokeInvitation, invitationsOf, invitationKind, membersOf, ofUser, organizationsOf, forgetUser,
    seatsTaken, takesSeat, purge, isManaged, rulesFor, deletableOf, leaving, wasDeleted,
    /** Whether a group is here, archived or not (billing asks, for one deleted). */
    exists: (organizationId) => Boolean(rowOf(organizationId)),
    /**
     * `hook({ organization, userId, role, reason, by })`, before a membership goes: reason `left`,
     * `removed`, `account_deleted` or `handed_over` (MEMBER_REASONS); `by`, who removed them (null
     * for the app, an account deletion or a hand-over).
     */
    whenMemberRemoved: (hook) => { memberHooks.push(hook); },
    /** `hook({ organization, userId, role, invitedBy })`, after a membership is made, in its transaction. */
    whenMemberAdded: (hook) => { addedHooks.push(hook); },
    /**
     * `hook({ organization, reason, by })`, before a group is deleted: reason `empty`, or the
     * caller's. `{ last: true }`: after every other's, whenever they were added (billing's).
     */
    whenDeleted: (hook, { last = false } = {}) => { (last ? lastDeletedHooks : deletedHooks).push(hook); },
  };
}
