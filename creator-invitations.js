/**
 * Creators invited before they have an account. The admin names someone (a name, an email), how long
 * their plan lasts and the terms of their campaign, and gets a link to send them in person. Nothing of
 * theirs exists yet: no account, no code, no discount at the payment provider. All of it is made when
 * they open the link and enter, and only then:
 *
 *   accept   on the invitation's page, with a password: their login is made with the invitation's
 *            email, taken as confirmed (the link reached that inbox), and they are signed in
 *   claim    signed in another way (an account they already had, Google through the identity
 *            provider): the invitation goes to that account
 *
 * Either way, in one transaction: the plan (a grant of the admin's, `source: 'admin'`, ending after
 * the months given, or never), their creator's code with its campaign (affiliates.js campaignFor),
 * its discount at the provider made just before, and the invitation marked as used. If the person
 * asked for it and the install has them, the sample data comes after (`sampleData().seed`).
 *
 * An invitation's states:
 *   pending   its link opens the page, until `expires_at` (affiliates.invitations.days, 30)
 *   claimed   someone entered with it: the account it went to and the code it made
 *   revoked   the admin took it back before anyone used it
 *   expired   nobody used it in its days
 *
 * Its link is `<baseUrl>/i/<token>`. The token is made from a random seed and the install's secret
 * (sessions.sign), so the admin can copy the link again while it is pending, the database alone opens
 * nothing, and only its hash is looked up. A new SESSION_SECRET ends the links still pending.
 *
 * What is kept of someone who never came: nothing but a keyed hash of their email. Once its days are
 * over, an invitation nobody used loses its name, email, link and terms (`sweep`, every hour); the hash
 * stays so the admin sees «already invited» and doesn't invite the same person twice. A claimed one
 * forgets the name and the email at once: the account has them.
 *
 * Its email is never sent from here: create() returns the link, and someone writes to the creator in
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
const NOTE_MAX = 500;
export const STATUSES = Object.freeze(['pending', 'claimed', 'revoked', 'expired']);

/**
 * Migration 38: the invitations. Everything but their state, dates and the email's hash goes once
 * they are over (see the top of this file), so those are the only columns that are never empty.
 */
export function creatorInvitationsSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS creator_invitations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    status      TEXT NOT NULL,
    email_hash  TEXT NOT NULL,
    name        TEXT,
    email       TEXT,
    seed        TEXT,
    token_hash  TEXT UNIQUE,
    pro_months  INTEGER,
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
  CREATE INDEX IF NOT EXISTS ix_creator_invitations_user ON creator_invitations (user_id)`);
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
 * @param {Function} [options.signUp]   async ({ email, password, name, locale, req, res }) → { user, signedIn }: a
 *   login made with a password and that email confirmed, and its session opened when it can be (the
 *   identity provider may want one more step first). Null where no password can be given here (OIDC)
 * @param {Function} [options.taken]    async (email) → 'here' | 'provider' | null: whether that email
 *   has an account here, or a login at the identity provider (another app of the suite's)
 * @param {Function} [options.signInUrl]  (back, { provider, hint }) → where to sign in elsewhere and come
 *   back to `back`, or null where sign-in is this app's own form
 * @param {object} [options.origins]    origins.js: the account a password makes has `creator` as its tag
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
  const creator = () => affiliates.settings.creator;

  /** The plan an invitation gives: the plan of the creators' products, else `pro`. */
  const plan = () => {
    const products = billing?.offer?.() ?? [];
    return products.find((p) => creator().products.includes(p.key))?.plan ?? 'pro';
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

  const parse = (text, fallback = null) => {
    try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
  };

  /** An invitation as the admin sees it: its link only while it is pending. */
  function view(row) {
    const status = statusOf(row);
    const account = row.user_id ? accounts.byId(row.user_id) : null;
    return {
      id: row.id, status, name: row.name ?? null, email: row.email ?? null, pro_months: row.pro_months ?? null,
      code: row.code ?? null, campaign: row.campaign ?? null, offer: parse(row.offer), products: row.products ? row.products.split(',') : null,
      reward: parse(row.reward), note: row.note ?? null, created_at: row.created_at, expires_at: row.expires_at,
      claimed_at: row.claimed_at ?? null, revoked_at: row.revoked_at ?? null, ended: Boolean(row.ended_at),
      user: account ? { id: account.id, email: account.email ?? null, display_name: account.display_name ?? account.username } : null,
      code_id: row.code_id ?? null,
      ...(status === 'pending' && row.seed ? { link: linkOf(row) } : {}),
    };
  }

  const byId = (id) => database.get('SELECT * FROM creator_invitations WHERE id = ?', Number(id)) ?? null;
  const byToken = (token) => (TOKEN.test(String(token ?? ''))
    ? database.get('SELECT * FROM creator_invitations WHERE token_hash = ?', sha256(token)) ?? null : null);

  /** The invitation of a link, still open to enter with, or the reason it isn't. */
  function openRow(token) {
    const row = byToken(token);
    if (!row) throw notFound('invitation_not_found');
    const status = statusOf(row);
    if (status === 'expired') throw new HttpError(410, 'invitation_expired');
    if (status === 'revoked') throw new HttpError(410, 'invitation_invalid');
    if (status === 'claimed') throw conflict('invitation_claimed');
    return row;
  }

  const legal = () => ({ terms: settings.terms ?? null, privacy: settings.privacy ?? null });
  const defaults = () => ({
    days: settings.days, pro_months: settings.proMonths, offer: creator().offer, products: creator().products,
    reward: creator().reward, google: Boolean(settings.google && signInUrl), sample_data: Boolean(sampleData()),
    password: Boolean(signUp),
  });

  /* --------------------------------- the admin --------------------------------- */

  /** What the admin's body says, checked, before anything is kept. */
  function termsOf(body) {
    const name = String(body?.name ?? '').trim();
    if (!name) throw badRequest('field_required', { field: 'name' });
    if (name.length > NAME_MAX) throw badRequest('field_too_long', { field: 'name', max: NAME_MAX });
    const email = accounts.checkEmail(body?.email);
    if (!email) throw badRequest('field_required', { field: 'email' });
    let months = settings.proMonths;
    if (body?.pro_months !== undefined) {
      if (body.pro_months !== null && (!Number.isInteger(body.pro_months) || body.pro_months < 1 || body.pro_months > 120)) {
        throw badRequest('field_invalid', { field: 'pro_months' });
      }
      months = body.pro_months;
    }
    const days = body?.days ?? settings.days;
    if (!Number.isInteger(days) || days < 1 || days > 90) throw badRequest('field_invalid', { field: 'days' });
    // The code the page starts with: the admin's, else one from the name. The person may change it.
    const offer = body?.offer ?? creator().offer;
    const given = body?.code == null || body.code === '' ? null : normalizeCode(body.code);
    if (body?.code != null && body.code !== '' && !given) throw badRequest('field_invalid', { field: 'code' });
    const code = given ?? codeFromName(name, offer) ?? 'CREATOR';
    // The campaign's terms as a campaign is checked (offer, products, reward, its name and note).
    const terms = affiliates.campaignTerms({
      code, campaign: body?.campaign, note: body?.note, offer: body?.offer, products: body?.products, reward: body?.reward,
    });
    if (given && affiliates.codeOf(given)) throw conflict('affiliate_code_taken', { suggestion: affiliates.freeCode(given) });
    return { name, email, months, days, code, terms };
  }

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
   * already a creator's, is 409 `already_invited` (with what came of it) unless `force`.
   */
  function create(body, admin = null, { req = null } = {}) {
    const wanted = termsOf(body);
    const before = invitedBefore(wanted.email);
    if (before && body?.force !== true) throw conflict('already_invited', before);
    const now = clock();
    const seed = randomToken(18);
    const id = Number(database.run(`INSERT INTO creator_invitations (status, email_hash, name, email, seed, token_hash, pro_months, code,
        campaign, offer, products, reward, note, created_by, created_at, expires_at)
      VALUES ('pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    emailHash(wanted.email), wanted.name, wanted.email, seed, sha256(tokenOf({ seed })), wanted.months, wanted.code,
    wanted.terms.campaign, JSON.stringify(wanted.terms.offer), wanted.terms.products.join(','),
    JSON.stringify({ cash: wanted.terms.reward.cash, currency: wanted.terms.reward.currency }), wanted.terms.note,
    admin?.id ?? null, iso(now), iso(now + wanted.days * DAY)).lastInsertRowid);
    record('admin.creator_invitation.create', { actor: admin, req, targetId: id, meta: { pro_months: wanted.months, again: Boolean(before) } });
    return view(byId(id));
  }

  /** Every invitation (or those in one state), newest first, and what a new one starts with. */
  function list({ status = null } = {}) {
    if (status && !STATUSES.includes(status)) throw badRequest('field_invalid', { field: 'status' });
    const now = iso(clock());
    const rows = database.all('SELECT * FROM creator_invitations ORDER BY id DESC')
      .filter((row) => !status || statusOf(row, now) === status);
    return { invitations: rows.map(view), defaults: defaults() };
  }

  function get(id) {
    const row = byId(id);
    if (!row) throw notFound('invitation_not_found');
    return view(row);
  }

  /** A pending invitation taken back: its link opens nothing from now on. */
  function revoke(id, admin = null, { req = null } = {}) {
    const row = byId(id);
    if (!row) throw notFound('invitation_not_found');
    if (statusOf(row) !== 'pending') throw conflict('invitation_not_pending', { status: statusOf(row) });
    database.run("UPDATE creator_invitations SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'pending'", iso(clock()), row.id);
    record('admin.creator_invitation.revoke', { actor: admin, req, targetId: row.id });
    return view(byId(row.id));
  }

  /* ---------------------------------- the page ---------------------------------- */

  /**
   * What the invitation's page shows: whom it is for, the code it starts with (a free one), whether
   * that email already has an account (`existing`), whoever is signed in in that browser, and what
   * the page can offer (a password here, Google, the sample data). Only `{ status }` once it was used.
   */
  async function page(token, viewer = null) {
    const row = byToken(token);
    if (!row) throw notFound('invitation_not_found');
    const status = statusOf(row);
    if (status !== 'pending') return { status };
    let existing = accounts.byEmail(row.email) ? 'here' : null;
    if (!existing) {
      try {
        existing = await taken(row.email);
      } catch (err) {
        // Not known now: the password is offered, and a login already there is found when it is made.
        if (!(err instanceof WorkosUnavailable)) throw err;
        existing = null;
      }
    }
    const offer = parse(row.offer, creator().offer);
    const reward = parse(row.reward, creator().reward);
    return {
      status, name: row.name, email: row.email, code: affiliates.freeCode(row.code) ?? row.code, pro_months: row.pro_months,
      expires_at: row.expires_at, offer, reward, products: row.products ? row.products.split(',') : creator().products,
      existing: existing || null,
      signed_in: viewer ? { email: viewer.email ?? null, same: Boolean(viewer.email && viewer.email.toLowerCase() === row.email) } : null,
      password: Boolean(signUp), password_min: passwordMin, google: Boolean(settings.google && signInUrl),
      sample_data: Boolean(sampleData()), ...legal(),
    };
  }

  /** Whether a code can be theirs: its form, and whether a code here has it (then a free one like it). */
  function checkCode(token, value) {
    openRow(token);
    const code = normalizeCode(value);
    if (!code) return { valid: false, available: false, code: null, suggestion: null };
    if (affiliates.codeOf(code)) return { valid: true, available: false, code, suggestion: affiliates.freeCode(code) };
    return { valid: true, available: true, code, suggestion: null };
  }

  const codeWanted = (row, value) => {
    const code = normalizeCode(value ?? row.code);
    if (!code) throw badRequest('field_invalid', { field: 'code' });
    if (affiliates.codeOf(code)) throw conflict('affiliate_code_taken', { suggestion: affiliates.freeCode(code) });
    return code;
  };

  /**
   * The invitation given to an account: the plan, the code and its discount, and the invitation used,
   * in the transaction that keeps the code (campaignFor `also`). A code the provider already has is
   * 409 `discount_code_taken` with a free one to try, and nothing is kept. Then the sample data.
   */
  async function settle(row, user, { code, sample = false, locale = null, req = null }) {
    const wanted = codeWanted(row, code);
    const terms = {
      code: wanted, campaign: row.campaign, note: row.note, offer: parse(row.offer, creator().offer),
      products: row.products ? row.products.split(',') : creator().products, reward: parse(row.reward, creator().reward),
    };
    const now = clock();
    const ends = row.pro_months == null ? null : iso(addMonths(now, row.pro_months));
    let made;
    try {
      made = await affiliates.campaignFor(user, terms, null, {
        also: (codeId) => {
          const grantId = entitlements.grant({
            subjectType: 'user', subjectId: user.id, plan: plan(), source: 'admin', externalRef: `creator-invitation:${row.id}`,
            startsAt: iso(now), endsAt: ends, note: `Creator invitation · ${wanted}`,
          });
          // One account per invitation, whoever enters first; the name and the email are the account's now.
          const used = database.run(`UPDATE creator_invitations SET status = 'claimed', claimed_at = ?, user_id = ?, code_id = ?, grant_id = ?,
              code = ?, name = NULL, email = NULL WHERE id = ? AND status = 'pending' AND expires_at > ?`,
          iso(now), user.id, codeId, Number(grantId), wanted, row.id, iso(now)).changes;
          if (!used) throw conflict('invitation_claimed');
        },
      });
    } catch (err) {
      if (err?.code === 'discount_code_taken' || err?.code === 'affiliate_code_taken') {
        throw conflict(err.code, { suggestion: affiliates.freeCode(`${wanted}${err.code === 'discount_code_taken' ? '2' : ''}`) });
      }
      throw err;
    }
    record('creator_invitation.claim', { actor: user, req, targetId: row.id, meta: { code: made.code, pro_months: row.pro_months } });
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
    return { code: made.code, discount: made.discount, plan: plan(), plan_ends: ends, sample_data: seeded };
  }

  /**
   * On the page, with a password: their login is made with the invitation's email (confirmed: the
   * link reached it) and their name, they are signed in, and the invitation is theirs. The code is
   * checked before anything is made; an email that already has an account is 409 `account_exists`
   * (the page then asks them to sign in with it). `before()` runs once all of that passed, just before
   * the account is made (the route's brake, which then counts only accounts, not typing mistakes).
   * → what settle() says, and `signed_in`.
   */
  async function accept(token, { password, code = null, sample = false, locale = null } = {}, { req = null, res = null, before = null } = {}) {
    if (!signUp) throw badRequest('password_not_here');
    const row = openRow(token);
    codeWanted(row, code);
    if (typeof password !== 'string' || !password) throw badRequest('field_required', { field: 'password' });
    accounts.checkPassword(password, passwordMin);
    if (accounts.byEmail(row.email) || await taken(row.email)) throw conflict('account_exists');
    before?.();
    // Its origin, for the figures by origin: a creator's invitation, whatever link brought the page.
    if (origins?.arriving && origins?.pack) origins.arriving(req, origins.pack({ src: 'creator' }));
    const { user, signedIn } = await signUp({ email: row.email, password, name: row.name, locale, req, res });
    const done = await settle(row, user, { code, sample, locale, req });
    return { ...done, signed_in: Boolean(signedIn) };
  }

  /** Signed in already (their account, or Google's way back): the invitation goes to that account. */
  async function claim(token, user, { code = null, sample = false, locale = null } = {}, { req = null } = {}) {
    const row = openRow(token);
    return { ...(await settle(row, user, { code, sample, locale, req })), signed_in: true };
  }

  /** Where the page sends someone to sign in elsewhere and come back to claim it, or null. */
  function signInFor(token, { provider = null, code = null, sample = false } = {}) {
    if (!signInUrl) return null;
    const row = openRow(token);
    const back = new URLSearchParams({ claim: '1' });
    const wanted = normalizeCode(code);
    if (wanted) back.set('code', wanted);
    if (sample) back.set('sample', '1');
    return signInUrl(`${INVITATION_PATH}${token}?${back}`, {
      provider: provider === 'google' && settings.google ? 'google' : null, hint: row.email, src: 'creator',
    });
  }

  /* --------------------------------- over time --------------------------------- */

  /**
   * Every hour: a pending invitation past its days is expired and keeps only its email's hash; a
   * revoked one past its days the same; a claimed one loses its link (its code and terms stay, as
   * the code's). → how many ended
   */
  function sweep() {
    const now = iso(clock());
    return database.tx(() => {
      const gone = database.run(`UPDATE creator_invitations SET status = CASE WHEN status = 'pending' THEN 'expired' ELSE status END,
          ended_at = ?, name = NULL, email = NULL, seed = NULL, token_hash = NULL, code = NULL, campaign = NULL, offer = NULL,
          products = NULL, reward = NULL, note = NULL, pro_months = NULL
        WHERE status IN ('pending', 'revoked') AND expires_at <= ? AND ended_at IS NULL`, now, now).changes;
      const used = database.run(`UPDATE creator_invitations SET ended_at = ?, seed = NULL, token_hash = NULL, name = NULL, email = NULL
        WHERE status = 'claimed' AND expires_at <= ? AND ended_at IS NULL`, now, now).changes;
      return gone + used;
    });
  }

  /** An account that goes: the invitation it took no longer names it. */
  const forget = (userId) => database.run('UPDATE creator_invitations SET user_id = NULL WHERE user_id = ?', userId).changes;

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
    });
    if (!url) throw notFound('not_found');
    sendJson(ctx.res, 200, { url });
  });
  router.post('/api/creator-invitations/:token/accept', answeredOnce(provider(async (ctx) => {
    fromHere(ctx);
    const body = await readJson(ctx.req);
    const done = await invitations.accept(ctx.params.token, { password: body.password, ...choices(body) }, {
      req: ctx.req, res: ctx.res, before: () => brake(ctx),
    });
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
