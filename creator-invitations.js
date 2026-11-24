/**
 * Invitations with the plan: a link the admin makes for someone who has no account yet, a creator
 * above all (their Pro and their creator's code), but also a friend (Pro for good), or the people of a
 * forum who gave no email (a month of Pro, one link for many). The admin says only what they know:
 *
 *   name, email   both optional. With an email, the page has it written and fixed, and the account is
 *                 born with it confirmed (the link reached that inbox); without one, the person writes
 *                 theirs, which the identity provider confirms as it confirms any
 *   the plan      for some months, until a date, or for good
 *   a creator     with their creator's code and the campaign's terms (the creators' own by default),
 *                 or the plan alone (`creator: false`)
 *   uses          how many accounts the link makes: one, unless it names no email and no creator
 *
 * Nothing of theirs exists until they open the link and enter, and only then:
 *
 *   accept   on the invitation's page, with a password: their login is made and they are signed in
 *   claim    signed in another way (an account they already had, Google through the identity
 *            provider): the invitation goes to that account
 *
 * Either way, in one transaction: the plan (a grant of the admin's, `source: 'admin'`, with its end or
 * none), for a creator their code with its campaign (affiliates.js campaignFor) and its discount at the
 * provider made just before, and the use noted. If the person asked for it and the install has them,
 * the sample data comes after (`sampleData().seed`).
 *
 * An invitation's states:
 *   pending   its link opens the page, until `expires_at` (affiliates.invitations.days, 30), while it
 *             has uses left
 *   claimed   all its uses taken: the accounts it went to (and the code it made, for a creator)
 *   revoked   the admin took it back
 *   expired   its days are over
 *
 * Its link is `<baseUrl>/i/<token>`. The token is made from a random seed and the install's secret
 * (sessions.sign), so the admin can copy the link again while it is pending, the database alone opens
 * nothing, and only its hash is looked up. A new SESSION_SECRET ends the links still pending.
 *
 * What is kept of someone who never came: nothing but a keyed hash of their email, when it named one.
 * Once its days are over, an invitation loses its name, email, link and terms (`sweep`, every hour);
 * the hash stays so the admin sees «already invited» and doesn't invite the same person twice. One
 * for one person forgets their name and email as soon as it is used: the account has them.
 *
 * Its email is never sent from here: create() returns the link, and someone writes to them in
 * person. An install's own mail stays for the people who asked for something.
 *
 *   const invitations = createCreatorInvitations({ database, affiliates, accounts, entitlements, sign, config, ... });
 *   registerCreatorInvitationsApi(api, { invitations, limiter, baseUrl });   // the page's and the admin's routes
 *   setInterval(() => invitations.sweep(), HOUR);                          // runtime.js
 */
import { randomToken, sha256 } from './crypto.js';
import {
  HttpError, badRequest, conflict, notFound, sendJson, readJson, requireUser, requireAdmin, checkOrigin,
} from './http.js';
import { answeredOnce } from './idempotency.js';
import { normalizeCode } from './affiliates.js';
import { WorkosUnavailable } from './workos.js';
import { iso } from './time.js';

const DAY = 24 * 3600 * 1000;
/** The link's address under the app: `/i/<token>`. */
export const INVITATION_PATH = '/i/';
/** What a token looks like: its prefix, then the HMAC in base64url. */
const TOKEN = /^ci_[A-Za-z0-9_-]{20,100}$/;
const NAME_MAX = 80;
/** The most accounts one link makes. */
export const USES_MAX = 1000;
export const STATUSES = Object.freeze(['pending', 'claimed', 'revoked', 'expired']);

/**
 * Migration 39: the invitations, and the accounts each one went to. Everything but an invitation's
 * state, dates, uses and its email's hash goes once it is over (see the top of this file).
 */
export function creatorInvitationsSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS creator_invitations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    status      TEXT NOT NULL,
    email_hash  TEXT,
    name        TEXT,
    email       TEXT,
    seed        TEXT,
    token_hash  TEXT UNIQUE,
    creator     INTEGER NOT NULL DEFAULT 1,
    pro_months  INTEGER,
    pro_until   TEXT,
    uses        INTEGER NOT NULL DEFAULT 1,
    used        INTEGER NOT NULL DEFAULT 0,
    code        TEXT,
    campaign    TEXT,
    offer       TEXT,
    products    TEXT,
    reward      TEXT,
    note        TEXT,
    created_by  INTEGER,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    claimed_at  TEXT,
    revoked_at  TEXT,
    ended_at    TEXT,
    user_id     INTEGER,
    code_id     INTEGER,
    grant_id    INTEGER
  );
  CREATE INDEX IF NOT EXISTS ix_creator_invitations_email ON creator_invitations (email_hash);
  CREATE INDEX IF NOT EXISTS ix_creator_invitations_due ON creator_invitations (status, expires_at);
  CREATE INDEX IF NOT EXISTS ix_creator_invitations_user ON creator_invitations (user_id);
  CREATE TABLE IF NOT EXISTS creator_invitation_uses (
    invitation_id INTEGER NOT NULL,
    user_id       INTEGER NOT NULL,
    grant_id      INTEGER,
    code_id       INTEGER,
    at            TEXT NOT NULL,
    PRIMARY KEY (invitation_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS ix_creator_invitation_uses_user ON creator_invitation_uses (user_id)`);
}

/** `months` calendar months after `ms`, the day kept where the month has it (31 Jan + 1 → 28/29 Feb). */
export function addMonths(ms, months) {
  const at = new Date(ms);
  const target = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + months, 1,
    at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds(), at.getUTCMilliseconds()));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(at.getUTCDate(), last));
  return target.getTime();
}

/**
 * A code from someone's name, as creators' codes are made by hand (`MARIA20`): the first word, its
 * accents taken off, in capitals, and the share off when the offer is a percent. Null when nothing of
 * the name can be one. A first word too short for a code (Jo) gives way to the next (ANN).
 */
export function codeFromName(name, offer = null) {
  const parts = String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .split(/[^A-Z0-9]+/).filter(Boolean);
  const word = parts.find((part) => part.length >= 3) || parts.join('');
  const tail = offer?.type === 'percent' ? String(offer.percent) : '';
  return normalizeCode(`${word.slice(0, 32 - tail.length)}${tail}`);
}

/**
 * @param {object} options
 * @param {object} options.database
 * @param {object} options.affiliates   from createAffiliates(): campaignFor, campaignTerms, freeCode, codeOf, settings
 * @param {object} options.accounts
 * @param {object} options.entitlements
 * @param {Function} options.sign       sessions.sign: the install's keyed hash, for the token and the email's hash
 * @param {object} options.config       resolveAffiliates()'s `invitations` (days, proMonths, google, terms, privacy)
 * @param {object} [options.billing]    for the plan the invitation gives: the plan of the creators' products
 * @param {Function} [options.signUp]   async ({ email, password, name, verified, locale, req, res }) → { user, signedIn }:
 *   a login made with a password and that email (confirmed when `verified`: the invitation named it),
 *   and its session opened when it can be (the identity provider may want one more step first, such
 *   as confirming an email the invitation didn't name). Null where no password can be given here (OIDC)
 * @param {Function} [options.taken]    async (email) → 'here' | 'provider' | null: whether that email
 *   has an account here, or a login at the identity provider (another app of the suite's)
 * @param {Function} [options.signInUrl]  (back, { provider, hint, src }) → where to sign in elsewhere and
 *   come back to `back`, or null where sign-in is this app's own form
 * @param {Function} [options.origins]  () → origins.js, or null: the account a password makes has `creator` (or
 *   `invitation`, for the plan alone) as its tag
 * @param {Function} [options.sampleData]  () → the install's sample data (`seed(user, { locale })`), or null
 * @param {number} [options.passwordMin]
 * @param {object} [options.audit]
 */
export function createCreatorInvitations({
  database, affiliates, accounts, entitlements, sign, config, billing = null, signUp = null, taken = async () => null,
  signInUrl = null, origins = null, sampleData = () => null, passwordMin = 10, audit = null, baseUrl = '',
  clock = () => Date.now(), log = console.log,
}) {
  const settings = config;
  const home = String(baseUrl).replace(/\/+$/, '');
  const creatorTerms = () => affiliates.settings.creator;

  /** The plan an invitation gives: the plan of the creators' products, else `pro`. */
  const plan = () => {
    const products = billing?.offer?.() ?? [];
    return products.find((p) => creatorTerms().products.includes(p.key))?.plan ?? 'pro';
  };

  const record = (action, { actor = null, req = null, targetId = null, meta = {} } = {}) => {
    try {
      audit?.record({ action, actor, req, targetType: 'creator_invitation', targetId, meta });
    } catch (err) {
      log(`[invitations] could not note ${action}: ${err?.message || err}`);
    }
  };

  const tokenOf = (row) => `ci_${sign(`creator-invitation|${row.seed}`)}`;
  const linkOf = (row) => `${home}${INVITATION_PATH}${tokenOf(row)}`;
  const emailHash = (email) => sign(`creator-invitation|email|${String(email).trim().toLowerCase()}`);

  /** Its state now: a pending one past its days is expired, whether the sweep came by or not. */
  const statusOf = (row, now = iso(clock())) => (row.status === 'pending' && row.expires_at <= now ? 'expired' : row.status);
  const isCreator = (row) => Boolean(row.creator);

  const parse = (text, fallback = null) => {
    try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
  };

  /** The accounts an invitation went to, newest first. */
  const usesOf = (row) => database.all(`SELECT u.user_id, u.at, u.code_id, a.email, a.display_name, a.username FROM creator_invitation_uses u
    LEFT JOIN users a ON a.id = u.user_id WHERE u.invitation_id = ? ORDER BY u.at DESC`, row.id)
    .map((use) => ({
      at: use.at, code_id: use.code_id ?? null,
      user: use.username ? { id: use.user_id, email: use.email ?? null, display_name: use.display_name ?? use.username } : null,
    }));

  /** An invitation as the admin sees it: its link only while it is pending. */
  function view(row, { all = false } = {}) {
    const status = statusOf(row);
    const account = row.user_id ? accounts.byId(row.user_id) : null;
    return {
      id: row.id, status, name: row.name ?? null, email: row.email ?? null, creator: isCreator(row),
      pro_months: row.pro_months ?? null, pro_until: row.pro_until ?? null, uses: row.uses, used: row.used,
      code: row.code ?? null, campaign: row.campaign ?? null, offer: parse(row.offer), products: row.products ? row.products.split(',') : null,
      reward: parse(row.reward), note: row.note ?? null, created_at: row.created_at, expires_at: row.expires_at,
      claimed_at: row.claimed_at ?? null, revoked_at: row.revoked_at ?? null, ended: Boolean(row.ended_at),
      // The account it went to last (its only one, for one person).
      user: account ? { id: account.id, email: account.email ?? null, display_name: account.display_name ?? account.username } : null,
      code_id: row.code_id ?? null,
      ...(status === 'pending' && row.seed ? { link: linkOf(row) } : {}),
      ...(all ? { accounts: usesOf(row) } : {}),
    };
  }

  const byId = (id) => database.get('SELECT * FROM creator_invitations WHERE id = ?', Number(id)) ?? null;
  const byToken = (token) => (TOKEN.test(String(token ?? ''))
    ? database.get('SELECT * FROM creator_invitations WHERE token_hash = ?', sha256(token)) ?? null : null);

  /** The plan's end it gives, for a use now: a date, months from now, or null for good. */
  const endOf = (row, now) => (row.pro_until ? row.pro_until : row.pro_months == null ? null : iso(addMonths(now, row.pro_months)));

  /** The invitation of a link, still open to enter with, or the reason it isn't. */
  function openRow(token) {
    const row = byToken(token);
    if (!row) throw notFound('invitation_not_found');
    const status = statusOf(row);
    // A plan «until» a day that has come gives nothing: the invitation is over too.
    if (status === 'expired' || (row.pro_until && row.pro_until <= iso(clock()))) throw new HttpError(410, 'invitation_expired');
    if (status === 'revoked') throw new HttpError(410, 'invitation_invalid');
    if (status === 'claimed') throw conflict('invitation_claimed');
    return row;
  }

  const legal = () => ({ terms: settings.terms ?? null, privacy: settings.privacy ?? null });
  const defaults = () => ({
    days: settings.days, pro_months: settings.proMonths, offer: creatorTerms().offer, products: creatorTerms().products,
    reward: creatorTerms().reward, google: Boolean(settings.google && signInUrl), sample_data: Boolean(sampleData()),
    password: Boolean(signUp), uses_max: USES_MAX,
  });

  /* --------------------------------- the admin --------------------------------- */

  /** What the admin's body says, checked, before anything is kept. */
  function termsOf(body) {
    const name = String(body?.name ?? '').trim() || null;
    if (name && name.length > NAME_MAX) throw badRequest('field_too_long', { field: 'name', max: NAME_MAX });
    const email = accounts.checkEmail(body?.email);
    // How long the plan lasts: until a date, some months, or for good (null); the install's months
    // when it says nothing.
    let months = settings.proMonths;
    let until = null;
    if (body?.pro_until != null && body.pro_until !== '') {
      const at = Date.parse(body.pro_until);
      if (Number.isNaN(at) || at <= clock() || body?.pro_months != null) throw badRequest('field_invalid', { field: 'pro_until' });
      until = iso(at);
      months = null;
    } else if (body?.pro_months !== undefined) {
      if (body.pro_months !== null && (!Number.isInteger(body.pro_months) || body.pro_months < 1 || body.pro_months > 120)) {
        throw badRequest('field_invalid', { field: 'pro_months' });
      }
      months = body.pro_months;
    }
    const days = body?.days ?? settings.days;
    if (!Number.isInteger(days) || days < 1 || days > 90) throw badRequest('field_invalid', { field: 'days' });
    if (body?.creator !== undefined && typeof body.creator !== 'boolean') throw badRequest('field_invalid', { field: 'creator' });
    const creator = body?.creator !== false;
    // Several accounts from one link only for the plan alone, and for nobody named by their email.
    const uses = body?.uses ?? 1;
    if (!Number.isInteger(uses) || uses < 1 || uses > USES_MAX || (uses > 1 && (creator || email))) {
      throw badRequest('field_invalid', { field: 'uses' });
    }
    if (!creator) return { name, email, months, until, days, creator, uses, code: null, terms: null, note: noteOf(body) };
    // The code the page starts with: the admin's, else one from the name; without either, the
    // person writes it there. They may change it either way.
    const offer = body?.offer ?? creatorTerms().offer;
    const given = body?.code == null || body.code === '' ? null : normalizeCode(body.code);
    if (body?.code != null && body.code !== '' && !given) throw badRequest('field_invalid', { field: 'code' });
    const code = given ?? codeFromName(name, offer);
    // The campaign's terms as a campaign is checked (offer, products, reward, its name and note).
    const terms = affiliates.campaignTerms({
      code: code ?? 'CREATOR', campaign: body?.campaign, note: body?.note, offer: body?.offer, products: body?.products, reward: body?.reward,
    });
    if (given && affiliates.codeOf(given)) throw conflict('affiliate_code_taken', { suggestion: affiliates.freeCode(given) });
    return { name, email, months, until, days, creator, uses, code, terms, note: terms.note };
  }

  const noteOf = (body) => {
    const note = String(body?.note ?? '').trim();
    if (note.length > 500) throw badRequest('field_too_long', { field: 'note', max: 500 });
    return note || null;
  };

  /**
   * Whether that email was invited before (`{ status, at }` of the last one), or already has a
   * creator's code here; null when neither.
   */
  function invitedBefore(email) {
    const last = database.get('SELECT status, expires_at, created_at FROM creator_invitations WHERE email_hash = ? ORDER BY id DESC LIMIT 1',
      emailHash(email));
    if (last) return { status: statusOf(last), at: last.created_at };
    const owner = accounts.byEmail(email);
    const code = owner ? database.get("SELECT code, created_at FROM affiliate_codes WHERE user_id = ? AND kind = 'creator' ORDER BY id DESC LIMIT 1", owner.id) : null;
    return code ? { status: 'creator', at: code.created_at, code: code.code } : null;
  }

  /**
   * A new invitation, and its link to send by hand. An email invited before, or whose account is
   * already a creator's, is 409 `already_invited` (with what came of it) unless `force`. `via`: who
   * acted through what (the admin's connector), kept in its entry of the log.
   */
  function create(body, admin = null, { req = null, via = null } = {}) {
    const wanted = termsOf(body);
    const before = wanted.email ? invitedBefore(wanted.email) : null;
    if (before && body?.force !== true) throw conflict('already_invited', before);
    const now = clock();
    const seed = randomToken(18);
    const { terms } = wanted;
    const id = Number(database.run(`INSERT INTO creator_invitations (status, email_hash, name, email, seed, token_hash, creator, pro_months,
        pro_until, uses, code, campaign, offer, products, reward, note, created_by, created_at, expires_at)
      VALUES ('pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    wanted.email ? emailHash(wanted.email) : null, wanted.name, wanted.email, seed, sha256(tokenOf({ seed })), wanted.creator ? 1 : 0,
    wanted.months, wanted.until, wanted.uses, wanted.code, terms?.campaign ?? null, terms ? JSON.stringify(terms.offer) : null,
    terms ? terms.products.join(',') : null, terms ? JSON.stringify({ cash: terms.reward.cash, currency: terms.reward.currency }) : null,
    wanted.note, admin?.id ?? null, iso(now), iso(now + wanted.days * DAY)).lastInsertRowid);
    record('admin.creator_invitation.create', {
      actor: admin, req, targetId: id,
      meta: {
        creator: wanted.creator, pro_months: wanted.months, pro_until: wanted.until, uses: wanted.uses, again: Boolean(before),
        ...(via ? { via } : {}),
      },
    });
    return view(byId(id));
  }

  /** Every invitation (or those in one state), newest first, and what a new one starts with. */
  function list({ status = null } = {}) {
    if (status && !STATUSES.includes(status)) throw badRequest('field_invalid', { field: 'status' });
    const now = iso(clock());
    const rows = database.all('SELECT * FROM creator_invitations ORDER BY id DESC')
      .filter((row) => !status || statusOf(row, now) === status);
    return { invitations: rows.map((row) => view(row)), defaults: defaults() };
  }

  /** One invitation, with every account it went to. */
  function get(id) {
    const row = byId(id);
    if (!row) throw notFound('invitation_not_found');
    return view(row, { all: true });
  }

  /** A pending invitation taken back: its link opens nothing from now on. `via`: who acted through what (the connector), for the log. */
  function revoke(id, admin = null, { req = null, via = null } = {}) {
    const row = byId(id);
    if (!row) throw notFound('invitation_not_found');
    if (statusOf(row) !== 'pending') throw conflict('invitation_not_pending', { status: statusOf(row) });
    database.run("UPDATE creator_invitations SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'pending'", iso(clock()), row.id);
    record('admin.creator_invitation.revoke', { actor: admin, req, targetId: row.id, meta: via ? { via } : {} });
    return view(byId(row.id));
  }

  /* ---------------------------------- the page ---------------------------------- */

  /** Whether an email has an account here or a login at the identity provider; null when that can't be known now. */
  async function existingOf(email) {
    if (accounts.byEmail(email)) return 'here';
    try {
      return (await taken(email)) || null;
    } catch (err) {
      // Not known now: the password is offered, and a login already there is found when it is made.
      if (err instanceof WorkosUnavailable) return null;
      throw err;
    }
  }

  /**
   * What the invitation's page shows: whom it is for (a link for many names nobody), the plan it
   * gives, for a creator the code it starts with (a free one), whether its email already has an
   * account (`existing`), whoever is signed in in that browser, and what the page can offer (a
   * password here, Google, the sample data). Only `{ status }` once it is over.
   */
  async function page(token, viewer = null) {
    const row = byToken(token);
    if (!row) throw notFound('invitation_not_found');
    let status = statusOf(row);
    if (status === 'pending' && row.pro_until && row.pro_until <= iso(clock())) status = 'expired';
    if (status !== 'pending') return { status };
    const creator = isCreator(row);
    const offer = creator ? parse(row.offer, creatorTerms().offer) : null;
    return {
      status, name: row.uses === 1 ? row.name : null, email: row.email ?? null, creator,
      pro_months: row.pro_until ? null : row.pro_months, pro_until: row.pro_until ?? null, expires_at: row.expires_at,
      ...(creator ? {
        code: row.code ? affiliates.freeCode(row.code) ?? row.code : null, offer,
        reward: parse(row.reward, creatorTerms().reward), products: row.products ? row.products.split(',') : creatorTerms().products,
      } : {}),
      existing: row.email ? await existingOf(row.email) : null,
      // Whoever is signed in in that browser, by their email or, without one, their name.
      signed_in: viewer ? {
        email: viewer.email ?? null, name: viewer.display_name || viewer.username || null,
        same: Boolean(row.email && viewer.email && viewer.email.toLowerCase() === row.email),
      } : null,
      password: Boolean(signUp), password_min: passwordMin, google: Boolean(settings.google && signInUrl),
      sample_data: Boolean(sampleData()), ...legal(),
    };
  }

  /** Whether a code can be theirs: its form, and whether a code here has it (then a free one like it). */
  function checkCode(token, value) {
    const row = openRow(token);
    if (!isCreator(row)) throw notFound('not_found');
    const code = normalizeCode(value);
    if (!code) return { valid: false, available: false, code: null, suggestion: null };
    if (affiliates.codeOf(code)) return { valid: true, available: false, code, suggestion: affiliates.freeCode(code) };
    return { valid: true, available: true, code, suggestion: null };
  }

  const codeWanted = (row, value) => {
    if (!isCreator(row)) return null;
    const code = normalizeCode(value ?? row.code);
    if (!code) throw badRequest('field_invalid', { field: 'code' });
    if (affiliates.codeOf(code)) throw conflict('affiliate_code_taken', { suggestion: affiliates.freeCode(code) });
    return code;
  };

  /**
   * The invitation given to an account: the plan, for a creator the code and its discount (made in
   * the transaction that keeps the code: campaignFor `also`), and the use noted. A code the provider
   * already has is 409 `discount_code_taken` with a free one to try, and nothing is kept. An account
   * that used this link before is 409 `invitation_claimed`. Then the sample data.
   */
  async function settle(row, user, { code, sample = false, locale = null, req = null }) {
    const wanted = codeWanted(row, code);
    if (database.get('SELECT 1 FROM creator_invitation_uses WHERE invitation_id = ? AND user_id = ?', row.id, user.id)) {
      throw conflict('invitation_claimed');
    }
    const now = clock();
    const ends = endOf(row, now);
    /** In the transaction: the plan, and the use, once, while the invitation has one left. */
    const use = (codeId = null) => {
      const grantId = Number(entitlements.grant({
        subjectType: 'user', subjectId: user.id, plan: plan(), source: 'admin', externalRef: `creator-invitation:${row.id}`,
        startsAt: iso(now), endsAt: ends, note: wanted ? `Creator invitation · ${wanted}` : 'Invitation',
      }));
      // One person's invitation forgets their name and email as it is used: the account has them now.
      const done = database.run(`UPDATE creator_invitations SET used = used + 1,
          status = CASE WHEN used + 1 >= uses THEN 'claimed' ELSE status END,
          claimed_at = ?, user_id = ?, code_id = ?, grant_id = ?, code = COALESCE(?, code),
          name = CASE WHEN uses = 1 THEN NULL ELSE name END, email = CASE WHEN uses = 1 THEN NULL ELSE email END
        WHERE id = ? AND status = 'pending' AND used < uses AND expires_at > ?`,
      iso(now), user.id, codeId, grantId, wanted, row.id, iso(now)).changes;
      if (!done) throw conflict('invitation_claimed');
      database.run(`INSERT INTO creator_invitation_uses (invitation_id, user_id, grant_id, code_id, at) VALUES (?, ?, ?, ?, ?)`,
        row.id, user.id, grantId, codeId, iso(now));
    };
    let made = null;
    if (wanted) {
      const terms = {
        code: wanted, campaign: row.campaign, note: row.note, offer: parse(row.offer, creatorTerms().offer),
        products: row.products ? row.products.split(',') : creatorTerms().products, reward: parse(row.reward, creatorTerms().reward),
      };
      try {
        made = await affiliates.campaignFor(user, terms, null, { also: (codeId) => use(codeId) });
      } catch (err) {
        if (err?.code === 'discount_code_taken' || err?.code === 'affiliate_code_taken') {
          throw conflict(err.code, { suggestion: affiliates.freeCode(`${wanted}${err.code === 'discount_code_taken' ? '2' : ''}`) });
        }
        throw err;
      }
    } else {
      database.tx(() => use());
    }
    record('creator_invitation.claim', {
      actor: user, req, targetId: row.id, meta: { code: made?.code ?? null, pro_months: row.pro_months, pro_until: row.pro_until },
    });
    // Their live tabs repaint with the plan.
    accounts.changed?.(user.id);
    let seeded = false;
    const samples = sample === true ? sampleData() : null;
    if (samples?.seed) {
      try {
        await samples.seed(user, { locale });
        seeded = true;
      } catch (err) {
        log(`[invitations] the sample data could not be made for user #${user.id}: ${err?.message || err}`);
      }
    }
    return {
      code: made?.code ?? null, discount: Boolean(made?.discount), plan: plan(), plan_ends: ends, sample_data: seeded,
    };
  }

  /**
   * On the page, with a password: their login is made with the invitation's email (confirmed: the
   * link reached it) or, when it names none, the one they write, and the invitation is theirs. The
   * code is checked before anything is made; an email that already has an account is 409
   * `account_exists` (the page then asks them to sign in with it). `before()` runs once all of that
   * passed, just before the account is made (the route's brake, which then counts accounts, not
   * typing mistakes). → what settle() says, and `signed_in`.
   */
  async function accept(token, { password, email = null, code = null, sample = false, locale = null } = {},
    { req = null, res = null, before = null } = {}) {
    if (!signUp) throw badRequest('password_not_here');
    const row = openRow(token);
    codeWanted(row, code);
    const address = row.email ?? accounts.checkEmail(email);
    if (!address) throw badRequest('field_required', { field: 'email' });
    if (typeof password !== 'string' || !password) throw badRequest('field_required', { field: 'password' });
    accounts.checkPassword(password, passwordMin);
    if (await existingOf(address)) throw conflict('account_exists');
    before?.();
    // Its origin, for the figures by origin: an invitation, whatever link brought the page.
    const kept = typeof origins === 'function' ? origins() : origins;
    if (kept?.arriving && kept?.pack) kept.arriving(req, kept.pack({ src: isCreator(row) ? 'creator' : 'invitation' }));
    const { user, signedIn } = await signUp({
      email: address, password, name: row.uses === 1 ? row.name : null, verified: Boolean(row.email), locale, req, res,
    });
    const done = await settle(row, user, { code, sample, locale, req });
    return { ...done, signed_in: Boolean(signedIn) };
  }

  /** Signed in already (their account, or Google's way back): the invitation goes to that account. */
  async function claim(token, user, { code = null, sample = false, locale = null } = {}, { req = null } = {}) {
    const row = openRow(token);
    return { ...(await settle(row, user, { code, sample, locale, req })), signed_in: true };
  }

  /** Where the page sends someone to sign in elsewhere and come back to claim it, or null. */
  function signInFor(token, { provider = null, code = null, sample = false, email = null } = {}) {
    if (!signInUrl) return null;
    const row = openRow(token);
    const back = new URLSearchParams({ claim: '1' });
    const wanted = normalizeCode(code);
    if (wanted && isCreator(row)) back.set('code', wanted);
    if (sample) back.set('sample', '1');
    let hint = row.email;
    if (!hint && email) {
      try { hint = accounts.checkEmail(email); } catch { hint = null; }
    }
    return signInUrl(`${INVITATION_PATH}${token}?${back}`, {
      provider: provider === 'google' && settings.google ? 'google' : null, hint, src: isCreator(row) ? 'creator' : 'invitation',
    });
  }

  /* --------------------------------- over time --------------------------------- */

  /**
   * Every hour: an invitation past its days loses what it held (pending ones become expired), but
   * its state, dates, uses and email's hash; one fully used keeps its code and terms, as the code's.
   * → how many ended
   */
  function sweep() {
    const now = iso(clock());
    return database.tx(() => {
      const gone = database.run(`UPDATE creator_invitations SET status = CASE WHEN status = 'pending' THEN 'expired' ELSE status END,
          ended_at = ?, name = NULL, email = NULL, seed = NULL, token_hash = NULL, code = CASE WHEN used > 0 THEN code ELSE NULL END,
          campaign = NULL, offer = NULL, products = NULL, reward = NULL, note = NULL, pro_months = NULL, pro_until = NULL
        WHERE status IN ('pending', 'revoked') AND expires_at <= ? AND ended_at IS NULL`, now, now).changes;
      const used = database.run(`UPDATE creator_invitations SET ended_at = ?, seed = NULL, token_hash = NULL, name = NULL, email = NULL
        WHERE status = 'claimed' AND expires_at <= ? AND ended_at IS NULL`, now, now).changes;
      return gone + used;
    });
  }

  /** An account that goes: the invitations it took no longer name it. */
  const forget = (userId) => {
    database.run('DELETE FROM creator_invitation_uses WHERE user_id = ?', userId);
    return database.run('UPDATE creator_invitations SET user_id = NULL WHERE user_id = ?', userId).changes;
  };

  return {
    settings, defaults, create, list, get, revoke, page, checkCode, accept, claim, signInFor, sweep, forget,
    linkOf: (id) => {
      const row = byId(id);
      return row && statusOf(row) === 'pending' && row.seed ? linkOf(row) : null;
    },
  };
}

/**
 * The page's routes, by the invitation's token (no session needed), and the admin's, guarded as the
 * rest of /api/admin is. Entering makes an account: braked per address as an open sign-up is, and
 * only from the app's own page (its Origin), whether a session cookie rides along or not.
 */
export function registerCreatorInvitationsApi(router, { invitations, limiter = null, baseUrl = '', admin = true }) {
  // The identity provider not answering is not the request's fault: try again in a while.
  const provider = (fn) => async (ctx) => {
    try {
      return await fn(ctx);
    } catch (err) {
      if (err instanceof WorkosUnavailable) throw new HttpError(503, 'provider_unavailable');
      throw err;
    }
  };
  const fromHere = (ctx) => checkOrigin(ctx.req, { baseUrl, cookieName: null });
  const brake = (ctx) => {
    const allowed = limiter?.allow('signup', ctx.req);
    if (allowed && !allowed.allowed) throw new HttpError(429, 'too_many_attempts', { retry_after: allowed.retryAfter });
  };
  const choices = (body) => ({
    code: typeof body.code === 'string' ? body.code : null, sample: body.sample_data === true,
    locale: typeof body.locale === 'string' && /^[a-z]{2}$/.test(body.locale) ? body.locale : null,
  });

  router.get('/api/creator-invitations/:token', provider(async (ctx) => {
    sendJson(ctx.res, 200, await invitations.page(ctx.params.token, ctx.user ?? null), { 'Cache-Control': 'no-store' });
  }));
  router.get('/api/creator-invitations/:token/code', (ctx) => {
    sendJson(ctx.res, 200, invitations.checkCode(ctx.params.token, ctx.query.get('code')));
  });
  router.get('/api/creator-invitations/:token/sign-in', (ctx) => {
    const url = invitations.signInFor(ctx.params.token, {
      provider: ctx.query.get('provider'), code: ctx.query.get('code'), sample: ctx.query.get('sample') === '1',
      email: ctx.query.get('email'),
    });
    if (!url) throw notFound('not_found');
    sendJson(ctx.res, 200, { url });
  });
  router.post('/api/creator-invitations/:token/accept', answeredOnce(provider(async (ctx) => {
    fromHere(ctx);
    const body = await readJson(ctx.req);
    const done = await invitations.accept(ctx.params.token, {
      password: body.password, email: typeof body.email === 'string' ? body.email : null, ...choices(body),
    }, { req: ctx.req, res: ctx.res, before: () => brake(ctx) });
    sendJson(ctx.res, 200, done);
  })));
  router.post('/api/creator-invitations/:token/claim', answeredOnce(provider(async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    sendJson(ctx.res, 200, await invitations.claim(ctx.params.token, user, choices(body), { req: ctx.req }));
  })));
  if (!admin) return;

  router.get('/api/admin/creator-invitations', (ctx) => {
    requireAdmin(ctx);
    sendJson(ctx.res, 200, invitations.list({ status: ctx.query?.get('status') || null }));
  });
  // Its answer holds the link: never kept for a replay.
  router.post('/api/admin/creator-invitations', answeredOnce(async (ctx) => {
    const by = requireAdmin(ctx);
    const body = await readJson(ctx.req);
    sendJson(ctx.res, 201, { invitation: invitations.create(body, by, { req: ctx.req }) });
  }));
  router.get('/api/admin/creator-invitations/:id', (ctx) => {
    requireAdmin(ctx);
    sendJson(ctx.res, 200, { invitation: invitations.get(Number(ctx.params.id)) });
  });
  router.delete('/api/admin/creator-invitations/:id', (ctx) => {
    const by = requireAdmin(ctx);
    sendJson(ctx.res, 200, { invitation: invitations.revoke(Number(ctx.params.id), by, { req: ctx.req }) });
  });
}
