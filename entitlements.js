/**
 * Entitlements: what each person may do, and why.
 *
 * The app never asks whether someone pays. It asks what they may do —
 * `can(user, 'attachments')`, `limit(user, 'lists.max')`— and the answer
 * comes from here. Where it comes from is someone else's business: the free
 * plan, a subscription, a one-off or lifetime purchase, a trial, a gift from the
 * admin, a license. All of them are *grants*: rows that give a plan, or a single
 * feature, to a user or an organization, from a source, for a window.
 *
 * Three pieces, none of which knows the others:
 *
 * · The catalog: the features the app can limit (declared in its code, typed)
 *   and the plans (in suite.config.js, or PLANS for one install). Validated on
 *   start: a misspelled key must never leave a barrier open silently.
 * · The grants (`entitlement_grants`), written by the admin panel today and by a
 *   billing webhook or a central service tomorrow. Enforcement only ever reads
 *   this table, so no app depends on another service being up to answer.
 * · The barriers: `require()` where the app does something a plan may not
 *   include, and `allows()` for MCP tools.
 *
 * When sources disagree, the most generous wins: a flag is on if any source
 * turns it on, and a limit is the largest (no limit beats any number). The
 * instance admin is never limited. Nothing is ever deleted when someone drops
 * to a smaller plan: they just can't add more.
 *
 * Inside an app, features have short names (`attachments`). Across apps —a
 * product that covers the whole suite— they carry the app's id
 * (`tasks.attachments`); grants for other apps are ignored here.
 */
import { HttpError } from './http.js';

const iso = (ms) => new Date(ms).toISOString();

export function entitlementsSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS entitlement_grants (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'organization')),
    subject_id   INTEGER NOT NULL,
    plan         TEXT,
    feature      TEXT,
    value        TEXT,
    quantity     INTEGER,
    source       TEXT NOT NULL,
    external_ref TEXT,
    starts_at    TEXT NOT NULL,
    ends_at      TEXT,
    revoked_at   TEXT,
    created_at   TEXT NOT NULL,
    note         TEXT,
    CHECK ((plan IS NULL) <> (feature IS NULL))
  );
  CREATE INDEX IF NOT EXISTS ix_grants_subject ON entitlement_grants (subject_type, subject_id);
  CREATE INDEX IF NOT EXISTS ix_grants_ref ON entitlement_grants (source, external_ref)`);
}

/** The most generous of two values of one feature. */
function generous(type, a, b) {
  if (type === 'flag') return Boolean(a) || Boolean(b);
  if (a === null || b === null) return null;
  return Math.max(a, b);
}

const unlimitedValue = (type) => (type === 'flag' ? true : null);

/**
 * @param {object} options
 * @param {object} options.database
 * @param {string} options.appId          namespaces feature keys across apps
 * @param {object} options.features       { key: { type: 'flag'|'limit', default, label?, aliases? } }
 * @param {object} [options.plans]        { id: { name, features: { key: value } } }; the flat form
 *                                        { id: { name, key: value } } is read too
 * @param {string} [options.defaultPlan]
 * @param {string} [options.plansJson]    PLANS from the environment, overriding `plans`
 * @param {string} [options.defaultPlanOverride]   DEFAULT_PLAN from the environment
 * @param {(user) => boolean} [options.isUnlimited]   by default, the instance admin
 * @param {(user) => number[]} [options.organizationsOf]   organizations whose grants count
 */
export function createEntitlements({
  database, appId, features = {}, plans = null, defaultPlan = null,
  plansJson = process.env.PLANS, defaultPlanOverride = process.env.DEFAULT_PLAN,
  isUnlimited = (user) => user?.role === 'admin', organizationsOf = () => [],
  clock = () => Date.now(),
}) {
  const errors = [];

  /* ---------------------------- the features ---------------------------- */

  const declared = {};
  const aliasOf = {};
  for (const [key, spec] of Object.entries(features)) {
    if (!['flag', 'limit'].includes(spec?.type)) {
      errors.push(`Feature "${key}": type must be "flag" or "limit"`);
      continue;
    }
    const fallback = spec.default === undefined ? unlimitedValue(spec.type) : spec.default;
    declared[key] = { type: spec.type, default: fallback, label: spec.label || key };
    for (const alias of spec.aliases || []) aliasOf[alias] = key;
  }
  const allDefaults = () => Object.fromEntries(Object.entries(declared).map(([k, s]) => [k, s.default]));

  function checkValue(where, key, value) {
    const spec = declared[key];
    if (spec.type === 'flag' && typeof value !== 'boolean') {
      errors.push(`${where}: "${key}" must be true or false`);
      return false;
    }
    if (spec.type === 'limit' && value !== null && !(Number.isInteger(value) && value >= 0)) {
      errors.push(`${where}: "${key}" must be a whole number ≥ 0, or null for no limit`);
      return false;
    }
    return true;
  }

  /* ----------------------------- the catalog ---------------------------- */

  let source = plans;
  if (plansJson) {
    try {
      source = JSON.parse(plansJson);
    } catch (err) {
      errors.push(`PLANS is not valid JSON (${err.message})`);
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source) || !Object.keys(source).length) {
    if (plansJson) errors.push('PLANS must be an object with at least one plan: {"free": {…}, "pro": {…}}');
    source = { free: { name: 'Free', features: {} } };
  }

  const catalog = {};
  for (const [id, raw] of Object.entries(source)) {
    if (!/^[a-z0-9_-]{1,30}$/.test(id)) errors.push(`Plan "${id}": ids take lowercase letters, digits, - and _`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`Plan "${id}": must be an object`);
      continue;
    }
    const { name, nombre, features: nested, ...flat } = raw;
    const given = nested && typeof nested === 'object' ? nested : flat;
    const values = allDefaults();
    for (const [rawKey, value] of Object.entries(given)) {
      const key = aliasOf[rawKey] || rawKey;
      if (!(key in declared)) {
        errors.push(`Plan "${id}": "${rawKey}" is nothing that can be limited (${Object.keys(declared).join(', ') || 'no features declared'})`);
        continue;
      }
      if (checkValue(`Plan "${id}"`, key, value)) values[key] = value;
    }
    const label = name ?? nombre ?? id;
    if (typeof label !== 'string' || !label.trim()) errors.push(`Plan "${id}": "name" must be a text`);
    catalog[id] = Object.freeze({ id, name: String(label), features: Object.freeze(values) });
  }
  const planIds = Object.keys(catalog);
  const fallbackPlan = defaultPlanOverride || defaultPlan || planIds[0];
  if (!catalog[fallbackPlan]) {
    errors.push(`The default plan "${fallbackPlan}" is not in the catalog (${planIds.join(', ')})`);
  }
  /** Catalog order is from least to most: with two plans active, the later one is the one shown. */
  const rank = (planId) => planIds.indexOf(planId);

  /* ------------------------------- grants ------------------------------- */

  const localKey = (key) => (key?.startsWith(`${appId}.`) ? key.slice(appId.length + 1) : key);

  function activeGrants(user, organizationId) {
    const now = iso(clock());
    const organizations = [...new Set([...(organizationsOf(user) || []), ...(organizationId ? [organizationId] : [])])];
    const subjects = [['user', user.id], ...organizations.map((id) => ['organization', id])];
    const clauses = subjects.map(() => '(subject_type = ? AND subject_id = ?)').join(' OR ');
    return database.all(`SELECT * FROM entitlement_grants WHERE (${clauses})
      AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?) AND revoked_at IS NULL
      ORDER BY id`, ...subjects.flat(), now, now);
  }

  /**
   * Everything someone is entitled to: `{ plan: { id, name }, ends, features, unlimited }`.
   * `ends` is when the shown plan lapses (null: it doesn't).
   */
  function of(user, { organizationId = null } = {}) {
    if (!user) return { plan: { id: fallbackPlan, name: catalog[fallbackPlan]?.name }, ends: null, features: allDefaults(), unlimited: false };
    if (isUnlimited(user)) {
      const features = Object.fromEntries(Object.entries(declared).map(([k, s]) => [k, unlimitedValue(s.type)]));
      return { plan: { id: fallbackPlan, name: catalog[fallbackPlan]?.name }, ends: null, features, unlimited: true };
    }
    const features = { ...(catalog[fallbackPlan]?.features || allDefaults()) };
    let shown = { plan: catalog[fallbackPlan], ends: null };
    for (const grant of activeGrants(user, organizationId)) {
      if (grant.plan) {
        const plan = catalog[localKey(grant.plan)];
        if (!plan) continue;   // a plan that left the catalog counts as the default one
        for (const [key, value] of Object.entries(plan.features)) {
          features[key] = generous(declared[key].type, features[key], value);
        }
        if (rank(plan.id) >= rank(shown.plan?.id)) shown = { plan, ends: grant.ends_at };
      } else {
        const key = localKey(grant.feature);
        if (!(key in declared)) continue;   // another app's feature
        let value;
        try { value = JSON.parse(grant.value); } catch { continue; }
        if (declared[key].type === 'flag' ? typeof value !== 'boolean'
          : !(value === null || (Number.isInteger(value) && value >= 0))) continue;
        features[key] = generous(declared[key].type, features[key], value);
      }
    }
    return { plan: { id: shown.plan?.id, name: shown.plan?.name }, ends: shown.ends, features, unlimited: false };
  }

  const known = (feature) => {
    if (!(feature in declared)) throw new Error(`Unknown feature "${feature}"`);
    return declared[feature];
  };

  /** Whether a flag is on (for a limit: whether it isn't zero). */
  function can(user, feature, context) {
    const spec = known(feature);
    const value = of(user, context).features[feature];
    return spec.type === 'flag' ? value === true : value !== 0;
  }

  /** The limit of a feature: a number, or null for none. */
  function limit(user, feature, context) {
    known(feature);
    return of(user, context).features[feature];
  }

  /**
   * The barrier. For a flag, throws 402 `plan_feature` when it is off; for a
   * limit, 402 `plan_limit` when `current` has reached it. The details let the
   * interface and the assistant say which plan and which limit.
   */
  function require(user, feature, { current = 0, organizationId = null } = {}) {
    const spec = known(feature);
    const entitled = of(user, { organizationId });
    const value = entitled.features[feature];
    if (spec.type === 'flag' && value !== true) {
      throw new HttpError(402, 'plan_feature', { feature, plan: entitled.plan.id, plan_name: entitled.plan.name });
    }
    if (spec.type === 'limit' && value !== null && current >= value) {
      throw new HttpError(402, 'plan_limit', { feature, limit: value, current, plan: entitled.plan.id, plan_name: entitled.plan.name });
    }
  }

  /** For the MCP transport: true, or the sentence the assistant can pass on. */
  function allows(user, tool) {
    if (!tool?.feature) return true;
    if (can(user, tool.feature)) return true;
    const entitled = of(user);
    return `The ${entitled.plan.name} plan does not include ${declared[tool.feature].label}.`;
  }

  /* ------------------------------- writing ------------------------------ */

  /** Adds a grant and returns its id. */
  function grant({
    subjectType = 'user', subjectId, plan = null, feature = null, value, quantity = null,
    source = 'admin', externalRef = null, startsAt = null, endsAt = null, note = null,
  }) {
    if (!Number.isInteger(subjectId)) throw new Error('grant: subjectId must be an integer');
    if (!plan === !feature) throw new Error('grant: give a plan or a feature, not both');
    if (plan && !catalog[localKey(plan)]) throw new HttpError(400, 'plan_unknown', { plan });
    if (feature) {
      const key = localKey(feature);
      if (!(key in declared)) throw new HttpError(400, 'feature_unknown', { feature });
      const before = errors.length;
      if (!checkValue('Grant', key, value)) { errors.length = before; throw new HttpError(400, 'field_invalid', { field: 'value' }); }
    }
    const when = (text, field) => {
      if (text == null) return null;
      const ms = Date.parse(text);
      if (Number.isNaN(ms)) throw new HttpError(400, 'field_invalid', { field });
      return iso(ms);
    };
    const now = iso(clock());
    return database.run(`INSERT INTO entitlement_grants (subject_type, subject_id, plan, feature, value, quantity,
        source, external_ref, starts_at, ends_at, created_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    subjectType, subjectId, plan, feature, feature ? JSON.stringify(value) : null, quantity, source, externalRef,
    when(startsAt, 'starts_at') || now, when(endsAt, 'ends_at'), now, note).lastInsertRowid;
  }

  /** Revokes grants by id, or by where they came from (a cancelled subscription). */
  function revoke({ id = null, source = null, externalRef = null } = {}) {
    const now = iso(clock());
    if (id != null) return database.run('UPDATE entitlement_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now, id).changes;
    return database.run(`UPDATE entitlement_grants SET revoked_at = ?
      WHERE source = ? AND external_ref IS ? AND revoked_at IS NULL`, now, source, externalRef).changes;
  }

  /**
   * The admin's way to set someone's plan: their previous admin plan grants
   * end and, unless `planId` is null (back to the default), a new one starts.
   * Grants from other sources (a subscription) are left alone.
   */
  function setPlan(userId, planId, { endsAt = null, source = 'admin', note = null } = {}) {
    return database.tx(() => {
      const now = iso(clock());
      database.run(`UPDATE entitlement_grants SET revoked_at = ? WHERE subject_type = 'user' AND subject_id = ?
        AND plan IS NOT NULL AND source = ? AND revoked_at IS NULL`, now, userId, source);
      return planId == null ? null : grant({ subjectId: userId, plan: planId, endsAt, source, note });
    });
  }

  /** The grants of a user or an organization, newest first, for the admin panel. */
  const grantsOf = (subjectType, subjectId) => database.all(`SELECT * FROM entitlement_grants
    WHERE subject_type = ? AND subject_id = ? ORDER BY id DESC`, subjectType, subjectId);

  /** The catalog, for settings and the admin panel. */
  const describe = () => ({
    defaultPlan: fallbackPlan,
    plans: planIds.map((id) => catalog[id]),
    features: declared,
    several: planIds.length > 1,
  });

  return { errors, of, can, limit, require, allows, grant, revoke, setPlan, grantsOf, describe };
}

/**
 * Turns the per-user plan columns an app had (Tasks: `users.plan` and
 * `users.plan_expires_at`) into grants from the admin. Meant for one of the
 * app's migrations; the columns stay, unused.
 */
export function importUserPlans(d, { planColumn = 'plan', endsColumn = 'plan_expires_at', now = Date.now() } = {}) {
  const columns = d.columnsOf('users');
  if (!columns.includes(planColumn)) return 0;
  const rows = d.all(`SELECT id, ${planColumn} AS plan${columns.includes(endsColumn) ? `, ${endsColumn} AS ends` : ''}
    FROM users WHERE ${planColumn} IS NOT NULL AND ${planColumn} != ''`);
  for (const row of rows) {
    const ends = row.ends ? new Date(`${String(row.ends).replace(' ', 'T')}${/Z$/.test(row.ends) ? '' : 'Z'}`) : null;
    d.run(`INSERT INTO entitlement_grants (subject_type, subject_id, plan, source, starts_at, ends_at, created_at, note)
      VALUES ('user', ?, ?, 'admin', ?, ?, ?, 'imported from users.${planColumn}')`,
    row.id, row.plan, iso(now), ends && !Number.isNaN(ends.getTime()) ? ends.toISOString() : null, iso(now));
  }
  return rows.length;
}
