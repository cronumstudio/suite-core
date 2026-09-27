/**
 * Organizations: groups of people who share data, roles and a subscription —
 * a household in Tasks or Focus, a school in Tracker, a team in Projects.
 *
 * Optional per app (`modules.organizations`). The suite keeps who belongs to
 * which group and with what role, and the invitations; which records belong to
 * a group instead of a person is decided in the app's own tables.
 *
 * Roles: `owner`, `admin` and `member`, in that order of power, plus the app's
 * own (a monitor in Tracker), which rank as members. A group never loses its
 * last owner. A grant with a quantity on an organization is its seats: when
 * `seatsOf` says how many, joining beyond them is refused.
 */
import { randomToken, sha256 } from './crypto.js';
import { HttpError, badRequest, notFound, forbidden, conflict } from './http.js';

const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

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
 * @param {number} [options.invitationDays]
 */
export function createOrganizations({
  database, roles = ['owner', 'admin', 'member'], seatsOf = () => null, invitationDays = 7,
  clock = () => Date.now(),
}) {
  const checkRole = (role) => {
    if (!roles.includes(role)) throw badRequest('field_invalid', { field: 'role', options: roles });
    return role;
  };
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
    mustExist(organizationId);
    checkRole(role);
    if (roleOf(organizationId, userId)) throw conflict('already_member');
    const seats = seatsOf(organizationId);
    if (seats != null && memberCount(organizationId) >= seats) {
      throw new HttpError(402, 'seats_full', { seats });
    }
    database.run('INSERT INTO memberships (organization_id, user_id, role, invited_by, joined_at) VALUES (?, ?, ?, ?, ?)',
      organizationId, userId, role, invitedBy, iso(clock()));
  }

  function setRole(organizationId, userId, role) {
    checkRole(role);
    const current = roleOf(organizationId, userId);
    if (!current) throw notFound('member_not_found');
    if (current === 'owner' && role !== 'owner' && owners(organizationId) <= 1) throw conflict('last_owner');
    database.run('UPDATE memberships SET role = ? WHERE organization_id = ? AND user_id = ?', role, organizationId, userId);
  }

  function removeMember(organizationId, userId) {
    const current = roleOf(organizationId, userId);
    if (!current) throw notFound('member_not_found');
    if (current === 'owner' && owners(organizationId) <= 1) throw conflict('last_owner');
    database.run('DELETE FROM memberships WHERE organization_id = ? AND user_id = ?', organizationId, userId);
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

  /**
   * Before an account is deleted (hook it with `accounts.whenRemoved`): each
   * group it was the last owner of passes to its oldest admin, or else its
   * oldest member; a group left with nobody is archived.
   */
  function forgetUser(userId) {
    const owned = database.all(`SELECT organization_id AS id FROM memberships
      WHERE user_id = ? AND role = 'owner'`, userId);
    for (const { id } of owned) {
      if (owners(id) > 1) continue;
      const heir = database.get(`SELECT user_id FROM memberships WHERE organization_id = ? AND user_id <> ?
        ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at, user_id LIMIT 1`, id, userId);
      if (heir) {
        database.run("UPDATE memberships SET role = 'owner' WHERE organization_id = ? AND user_id = ?", id, heir.user_id);
      } else {
        archive(id);
      }
    }
    database.run('DELETE FROM memberships WHERE user_id = ?', userId);
  }

  const list = () => database.all(`SELECT o.*, (SELECT COUNT(*) FROM memberships m WHERE m.organization_id = o.id) AS members
    FROM organizations o WHERE o.archived_at IS NULL ORDER BY o.name`);

  return {
    create, get, list, update, archive, roleOf, requireRole, addMember, setRole, removeMember,
    invite, accept, revokeInvitation, invitationsOf, membersOf, ofUser, organizationsOf, forgetUser,
  };
}
