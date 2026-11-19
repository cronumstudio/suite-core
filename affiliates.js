/**
 * Affiliates: people who bring buyers, and what they earn for it. Two kinds of code in one system:
 *
 *   referral  any account's own, made the first time it opens its panel (`WORK-7KQ2`: the app's
 *             prefix and four letters nobody misreads). The buyer pays less on their first payment
 *             (a flat amount: the monthly's first month free, a month off the yearly) and the
 *             referrer gets a month of the plan for each buyer who pays, up to `yearlyCap` a year
 *   creator   a campaign the admin makes for a chosen account (`MARIA20`). The buyer gets a share
 *             off the first year of the yearly; the creator earns money for each yearly paid,
 *             recorded here and paid by hand (a payout the admin notes down)
 *
 * The suite takes and pays no money. The provider (billing.js's adapter) holds the discounts: each
 * code is one at the provider when the adapter can make them (`createDiscount`), so it can be typed
 * at its checkout, and billing.js passes it to a checkout of someone a code brought. Without
 * `createDiscount` a code still works by its link alone: nobody pays less, the code still earns.
 *
 * Who brought whom (an attribution, one per buyer):
 *   link      the code's link (`/r/<CODE>`, or `?codigo=<CODE>` on any page of the app or of the
 *             website) leaves it in the `cw_ref` cookie for 60 days, and an account made with it
 *             in the browser is the code's (`whenCreated`, read from the sign-in's request)
 *   checkout  the provider's `payment` event says which discount the buyer used (typed at the
 *             checkout, or passed by billing.js): that code, which wins over a link, since it is
 *             the last thing the buyer did
 *
 * What a code earns, a commission, one per buyer ever (unique per code, buyer and entry):
 *   - on the buyer's first payment that charges something (`amount > 0`): the monthly's first
 *     month is free with a referral, so that one is its second payment. Renewals never count, nor
 *     a buyer who had paid this install before (a subscription or purchase of theirs here)
 *   - only for a product of the code (a creator's: the yearly alone)
 *   - never for the code's owner: not the same account, nor the same customer at the provider,
 *     nor the same email (letters after a `+` left out)
 *   - `pending` until `confirmDays` after the payment, then `confirmed` by the hourly `sweep()`;
 *     a refund before that makes it `reversed`. A refund after: a creator's earns a negative entry
 *     (`adjustment`), taken from the next payout; a referral's month already given stays, and the
 *     refund is only noted (`refunded_at`), as Martin decided (19/11/2026: taking it back costs
 *     more than it saves, and annoys)
 *   - `paid`: a creator's, once a payout covered everything confirmed
 *
 * A referral's month (`affiliate_rewards`), queued when its commission is confirmed, as billing.js
 * queues the stops it asks of the provider:
 *   pending   to give
 *   sending   being given; one whose sweep never said how it went is taken again after 15 minutes
 *   granted   a grant of the plan for 30 days (`source: 'referral'`), chained after the last of the
 *             person's: twelve months earned at once are twelve months in a row
 *   postponed the person pays on the web (a live subscription that renews): its next charge moves
 *             30 days later instead (`postponeRenewal`), and a grant would give them nothing
 *   failed    the account went, or the provider refused 48 times in a row (two days of sweeps)
 * Only `yearlyCap` months a calendar year: a commission confirmed past them is confirmed with
 * `reason: 'yearly_cap'` and gives nothing.
 *
 * The program is off until the app says `affiliates.enabled` (config.js): no referral codes, no
 * link, no discount passed at a checkout, no panel. The admin can still make creator campaigns and
 * see the tab, and a discount typed at the provider's checkout (one of a campaign made in Admin)
 * still earns: that buyer did use the creator's code. Payments are noted whatever it says (who
 * paid for the first time), so that turning it on later knows who is not a first buyer.
 *
 *   const affiliates = createAffiliates({ database, billing, provider, entitlements, accounts, audit, config });
 *   billing.whenPaid(affiliates.paid); billing.whenRefunded(affiliates.refunded);
 *   billing.discountWith(affiliates.discountFor); accounts.whenCreated(affiliates.attributeLink);
 *   registerAffiliatesApi(api, { affiliates, audit });   // /api/affiliates/me, /api/admin/affiliates…
 *   setInterval(() => affiliates.sweep(), HOUR);         // runtime.js
 */
import crypto from 'node:crypto';
import {
  HttpError, badRequest, conflict, notFound, unauthorized, forbidden, sendJson, readJson, parseCookies, serializeCookie, appendHeader,
} from './http.js';
import { currentRequest } from './request-scope.js';

const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/** The cookie a code's link leaves in the browser (CONTRACT.md §3): the web's pages set it too. */
export const REF_COOKIE = 'cw_ref';
/** 60 days. */
export const REF_COOKIE_SECONDS = 60 * 24 * 3600;
/** A code: uppercase letters, digits and -, as the provider takes it. */
export const CODE_PATTERN = /^[A-Z0-9-]{3,32}$/;
/** Letters nobody misreads on a screen or says wrong out loud: no 0/O, 1/I/L. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** What a referral's reward gives: this many days of the plan, or the next charge this many days later. */
export const REWARD_DAYS = 30;
/** A reward taken by a sweep that never said how it went is taken again after this. */
const SENDING_MS = 15 * 60 * 1000;
/** After this many refusals in a row, a reward is `failed` and left to the admin. */
const REWARD_TRIES = 48;
/** The longest note: a payout's, the creator's own of how they want to be paid, a campaign's. */
const NOTE_MAX = 500;
/** Paddle's `percent` takes up to 100; a flat amount up to what a price may be. */
const AMOUNT_MAX = 10_000_000;

/** The code as the tables keep it, or null when it can't be one. */
export function normalizeCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

/** An offer's problem, or null: `{ type: 'flat', amount, currency }` or `{ type: 'percent', percent }`. */
function offerProblem(offer) {
  if (!offer || typeof offer !== 'object') return 'an offer is { type: \'flat\', amount, currency } or { type: \'percent\', percent }';
  if (offer.type === 'flat') {
    if (!Number.isInteger(offer.amount) || offer.amount <= 0 || offer.amount > AMOUNT_MAX) return 'a flat offer\'s amount is a whole number of cents above 0';
    if (!/^[A-Z]{3}$/.test(String(offer.currency ?? ''))) return 'a flat offer needs its currency (EUR)';
    return null;
  }
  if (offer.type === 'percent') {
    return Number.isInteger(offer.percent) && offer.percent > 0 && offer.percent <= 100 ? null : 'a percent offer\'s percent is a whole number from 1 to 100';
  }
  return 'an offer\'s type is flat or percent';
}

const cleanOffer = (offer) => (offer.type === 'flat'
  ? { type: 'flat', amount: offer.amount, currency: offer.currency }
  : { type: 'percent', percent: offer.percent });

/** A creator's reward: `{ cash: 600, currency: 'EUR' }` (cents), or its problem. */
function cashProblem(reward) {
  if (!reward || typeof reward !== 'object') return 'a creator\'s reward is { cash: <cents>, currency }';
  if (!Number.isInteger(reward.cash) || reward.cash <= 0 || reward.cash > AMOUNT_MAX) return 'reward.cash is a whole number of cents above 0';
  if (!/^[A-Z]{3}$/.test(String(reward.currency ?? ''))) return 'reward.currency is a currency code (EUR)';
  return null;
}

const productsProblem = (products) => (Array.isArray(products) && products.length
  && products.every((p) => typeof p === 'string' && /^[a-z0-9_-]{1,40}$/.test(p)) ? null : 'products is a list of the catalog\'s product keys');

/**
 * suite.config.js `affiliates`, resolved over the program's defaults (CONTRACT.md §4). `appId` gives
 * the referral codes' prefix when the app names none (`work` → `WORK-7KQ2`). → { affiliates, errors }
 */
export function resolveAffiliates(given, { appId = 'app' } = {}) {
  const errors = [];
  const prefix = String(appId).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'REF';
  const out = {
    enabled: false,
    confirmDays: 30,
    cookieDomain: null,
    pressKitUrl: null,
    referral: {
      prefix,
      offer: { type: 'flat', amount: 390, currency: 'EUR' },
      products: ['pro-monthly', 'pro-yearly'],
      reward: 'pro_month',
      yearlyCap: 12,
    },
    creator: {
      offer: { type: 'percent', percent: 20 },
      products: ['pro-yearly'],
      reward: { cash: 600, currency: 'EUR' },
      payoutMinimum: 3000,
    },
  };
  if (given === undefined || given === null) return { affiliates: out, errors };
  if (typeof given !== 'object' || Array.isArray(given)) return { affiliates: out, errors: ['affiliates: an object, such as { enabled: true }'] };
  const known = new Set(['enabled', 'confirmDays', 'cookieDomain', 'pressKitUrl', 'referral', 'creator']);
  for (const key of Object.keys(given)) if (!known.has(key)) errors.push(`affiliates.${key} is not a setting (a typo?)`);
  if (given.enabled !== undefined) {
    if (typeof given.enabled !== 'boolean') errors.push('affiliates.enabled must be true or false');
    else out.enabled = given.enabled;
  }
  if (given.confirmDays !== undefined) {
    if (!Number.isInteger(given.confirmDays) || given.confirmDays < 0 || given.confirmDays > 365) errors.push('affiliates.confirmDays: whole days, 0 to 365');
    else out.confirmDays = given.confirmDays;
  }
  if (given.cookieDomain != null) {
    // The website and the app share the cookie on their common domain (`.cronumstudio.com`).
    if (!/^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(String(given.cookieDomain))) errors.push('affiliates.cookieDomain: a domain, such as .example.com');
    else out.cookieDomain = String(given.cookieDomain);
  }
  if (given.pressKitUrl != null) {
    if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(String(given.pressKitUrl))) errors.push('affiliates.pressKitUrl: an https address');
    else out.pressKitUrl = String(given.pressKitUrl);
  }
  const part = (name, keys, read) => {
    const value = given[name];
    if (value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`affiliates.${name}: an object`);
      return;
    }
    for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(`affiliates.${name}.${key} is not a setting (a typo?)`);
    read(value);
  };
  part('referral', ['prefix', 'offer', 'products', 'reward', 'yearlyCap'], (r) => {
    if (r.prefix !== undefined) {
      if (!/^[A-Z0-9]{1,8}$/.test(String(r.prefix))) errors.push('affiliates.referral.prefix: 1 to 8 uppercase letters or digits');
      else out.referral.prefix = r.prefix;
    }
    if (r.offer !== undefined) {
      const problem = offerProblem(r.offer);
      if (problem) errors.push(`affiliates.referral.offer: ${problem}`);
      else out.referral.offer = cleanOffer(r.offer);
    }
    if (r.products !== undefined) {
      const problem = productsProblem(r.products);
      if (problem) errors.push(`affiliates.referral.products: ${problem}`);
      else out.referral.products = [...r.products];
    }
    // The one reward a referral has: a month of the plan.
    if (r.reward !== undefined && r.reward !== 'pro_month') errors.push('affiliates.referral.reward: pro_month');
    if (r.yearlyCap !== undefined) {
      if (!Number.isInteger(r.yearlyCap) || r.yearlyCap < 0 || r.yearlyCap > 120) errors.push('affiliates.referral.yearlyCap: a whole number of months, 0 to 120');
      else out.referral.yearlyCap = r.yearlyCap;
    }
  });
  part('creator', ['offer', 'products', 'reward', 'payoutMinimum'], (c) => {
    if (c.offer !== undefined) {
      const problem = offerProblem(c.offer);
      if (problem) errors.push(`affiliates.creator.offer: ${problem}`);
      else out.creator.offer = cleanOffer(c.offer);
    }
    if (c.products !== undefined) {
      const problem = productsProblem(c.products);
      if (problem) errors.push(`affiliates.creator.products: ${problem}`);
      else out.creator.products = [...c.products];
    }
    if (c.reward !== undefined) {
      const problem = cashProblem(c.reward);
      if (problem) errors.push(`affiliates.creator.reward: ${problem}`);
      else out.creator.reward = { cash: c.reward.cash, currency: c.reward.currency };
    }
    if (c.payoutMinimum !== undefined) {
      if (!Number.isInteger(c.payoutMinimum) || c.payoutMinimum < 0) errors.push('affiliates.creator.payoutMinimum: whole cents, 0 or more');
      else out.creator.payoutMinimum = c.payoutMinimum;
    }
  });
  return { affiliates: out, errors };
}

/**
 * Migration 35: the codes, the discounts each has at a provider (one per provider and environment:
 * a sandbox's ids aren't the live account's), who brought whom, who has paid once, the
 * commissions, the payouts and the referrals' months to give.
 */
export function affiliatesSchema(d) {
  d.exec(`CREATE TABLE IF NOT EXISTS affiliate_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL,
    user_id     INTEGER NOT NULL,
    campaign    TEXT,
    offer       TEXT NOT NULL,
    products    TEXT NOT NULL,
    reward      TEXT NOT NULL,
    currency    TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    note        TEXT,
    payout_note TEXT,
    created_by  INTEGER,
    created_at  TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ix_affiliate_codes_referral ON affiliate_codes (user_id) WHERE kind = 'referral';
  CREATE INDEX IF NOT EXISTS ix_affiliate_codes_user ON affiliate_codes (user_id);
  CREATE TABLE IF NOT EXISTS affiliate_discounts (
    code_id     INTEGER NOT NULL,
    provider    TEXT NOT NULL,
    discount_id TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (code_id, provider)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ix_affiliate_discounts_id ON affiliate_discounts (provider, discount_id);
  CREATE INDEX IF NOT EXISTS ix_affiliate_discounts_any ON affiliate_discounts (discount_id);
  CREATE TABLE IF NOT EXISTS affiliate_attributions (
    user_id INTEGER PRIMARY KEY,
    code_id INTEGER NOT NULL,
    source  TEXT NOT NULL,
    at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_affiliate_attributions_code ON affiliate_attributions (code_id);
  CREATE TABLE IF NOT EXISTS affiliate_buyers (
    user_id       INTEGER PRIMARY KEY,
    first_paid_at TEXT NOT NULL,
    event_id      TEXT
  );
  CREATE TABLE IF NOT EXISTS affiliate_commissions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code_id       INTEGER NOT NULL,
    buyer_id      INTEGER NOT NULL,
    entry         TEXT NOT NULL DEFAULT 'sale',
    provider      TEXT NOT NULL,
    ref           TEXT,
    subscription  TEXT,
    event_id      TEXT,
    product       TEXT,
    reward        TEXT NOT NULL,
    amount        INTEGER NOT NULL DEFAULT 0,
    currency      TEXT,
    status        TEXT NOT NULL,
    paid_at       TEXT NOT NULL,
    confirm_after TEXT NOT NULL,
    confirmed_at  TEXT,
    reversed_at   TEXT,
    refunded_at   TEXT,
    reason        TEXT,
    payout_id     INTEGER,
    created_at    TEXT NOT NULL,
    UNIQUE (code_id, buyer_id, entry)
  );
  CREATE INDEX IF NOT EXISTS ix_affiliate_commissions_due ON affiliate_commissions (status, confirm_after);
  CREATE INDEX IF NOT EXISTS ix_affiliate_commissions_ref ON affiliate_commissions (ref);
  CREATE INDEX IF NOT EXISTS ix_affiliate_commissions_subscription ON affiliate_commissions (subscription);
  CREATE TABLE IF NOT EXISTS affiliate_payouts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code_id    INTEGER NOT NULL,
    amount     INTEGER NOT NULL,
    currency   TEXT,
    method     TEXT,
    reference  TEXT,
    note       TEXT,
    paid_at    TEXT NOT NULL,
    by_user    INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_affiliate_payouts_code ON affiliate_payouts (code_id);
  CREATE TABLE IF NOT EXISTS affiliate_rewards (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    commission_id INTEGER NOT NULL UNIQUE,
    code_id       INTEGER NOT NULL,
    user_id       INTEGER NOT NULL,
    status        TEXT NOT NULL,
    tries         INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    grant_id      INTEGER,
    ref           TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    done_at       TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_affiliate_rewards_status ON affiliate_rewards (status, updated_at)`);
}

/** An email as one person has it: lowercase, without what comes after a `+` (ana+2@ is ana@). */
const sameMailbox = (email) => {
  const text = String(email || '').trim().toLowerCase();
  const at = text.lastIndexOf('@');
  if (at < 1) return text;
  return `${text.slice(0, at).split('+')[0]}${text.slice(at)}`;
};

/** A cell of a CSV, quoted when it must be, and never a formula a spreadsheet would run. */
const csvCell = (value) => {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * @param {object} options
 * @param {object} options.database
 * @param {object} [options.billing]       from createBilling(): its source, its catalog, its hooks
 * @param {object} [options.provider]      billing's adapter, for createDiscount, setDiscountActive,
 *   postponeRenewal (all optional, CONTRACT.md §1); null when billing is off
 * @param {string} [options.discountKey]   which of the provider's accounts a discount id belongs to
 *   (`paddle:sandbox`, `paddle:production`); by default the provider's id
 * @param {object} options.entitlements
 * @param {object} options.accounts
 * @param {object} [options.audit]
 * @param {object} options.config          resolveAffiliates()'s
 * @param {string} [options.baseUrl]       for the code's link (`<baseUrl>/r/<CODE>`)
 * @param {boolean} [options.secureCookies]
 */
export function createAffiliates({
  database, billing = null, provider = null, discountKey = null, entitlements, accounts, audit = null, config,
  baseUrl = '', secureCookies = false, clock = () => Date.now(), log = console.log, random = crypto.randomInt,
}) {
  const settings = config ?? resolveAffiliates(undefined).affiliates;
  const enabled = settings.enabled === true;
  const source = billing?.provider || provider?.id || 'billing';
  const key = discountKey || source;
  const on = (name) => Boolean(billing?.enabled) && typeof provider?.[name] === 'function';
  const home = String(baseUrl).replace(/\/+$/, '');
  /** The plan a referral's month gives: the plan of the referral's first product, else `pro`. */
  const rewardPlan = () => {
    const products = billing?.offer?.() ?? [];
    return products.find((p) => settings.referral.products.includes(p.key))?.plan ?? 'pro';
  };

  const record = (action, { actor = null, req = null, targetId = null, meta = {} } = {}) => {
    try {
      audit?.record({ action, actor, req, targetType: 'affiliate_code', targetId, meta });
    } catch (err) {
      log(`[affiliates] could not note ${action}: ${err?.message || err}`);
    }
  };

  /* -------------------------------- codes ------------------------------- */

  const shape = (row) => (row ? {
    id: row.id, code: row.code, kind: row.kind, user_id: row.user_id, campaign: row.campaign ?? null,
    offer: JSON.parse(row.offer), products: String(row.products).split(',').filter(Boolean),
    reward: row.reward, currency: row.currency ?? null, active: Boolean(row.active), note: row.note ?? null,
    payout_note: row.payout_note ?? null, created_at: row.created_at,
    cash: row.reward.startsWith('cash:') ? Number(row.reward.slice(5)) : null,
  } : null);
  const byCode = (code) => shape(database.get('SELECT * FROM affiliate_codes WHERE code = ?', code));
  const byId = (id) => shape(database.get('SELECT * FROM affiliate_codes WHERE id = ?', Number(id)));
  /** The code a provider's discount id is, whichever of its accounts made it. */
  const byDiscount = (discountId) => shape(discountId ? database.get(`SELECT c.* FROM affiliate_discounts d
    JOIN affiliate_codes c ON c.id = d.code_id WHERE d.discount_id = ? ORDER BY d.provider = ? DESC LIMIT 1`, String(discountId), key) : null);
  const discountOf = (codeId) => database.get('SELECT discount_id FROM affiliate_discounts WHERE code_id = ? AND provider = ?',
    codeId, key)?.discount_id ?? null;
  const referralRow = (userId) => shape(database.get("SELECT * FROM affiliate_codes WHERE user_id = ? AND kind = 'referral'", userId));

  const linkOf = (code) => `${home}/r/${code}`;
  const descriptionOf = (code) => `${code.kind === 'creator' ? 'Creator' : 'Referral'} ${code.code}`;

  /**
   * The code's discount at the provider, made now: its id, or null when the provider can't make one
   * or failed (logged; asked again the next time). A code the provider already has is thrown
   * (409 discount_code_taken): the caller decides.
   */
  async function makeDiscount(code) {
    if (!on('createDiscount')) return null;
    let made;
    try {
      made = await provider.createDiscount({ code: code.code, offer: code.offer, products: code.products, description: descriptionOf(code) });
    } catch (err) {
      if (err?.status === 409) throw err;
      log(`[affiliates] the provider could not make the discount of ${code.code}: ${err?.message || err}`);
      return null;
    }
    if (!made?.id) return null;
    database.run(`INSERT OR IGNORE INTO affiliate_discounts (code_id, provider, discount_id, created_at) VALUES (?, ?, ?, ?)`,
      code.id, key, String(made.id), iso(clock()));
    return String(made.id);
  }

  const randomCode = () => `${settings.referral.prefix}-${Array.from({ length: 4 }, () => ALPHABET[random(ALPHABET.length)]).join('')}`;
  const making = new Map();

  /**
   * Someone's referral code, made the first time (the code first at the provider, then here, so a
   * code the provider already has is never kept), and its discount asked again when it has none.
   * One at a time per person in this process: two tabs opening the panel make one code.
   */
  function referralOf(user) {
    const before = making.get(user.id);
    if (before) return before;
    const job = (async () => {
      const known = referralRow(user.id);
      if (known) {
        if (!discountOf(known.id) && on('createDiscount')) {
          await makeDiscount(known).catch((err) => log(`[affiliates] ${known.code} is taken at the provider: it works by its link alone (${err?.code || err})`));
        }
        return known;
      }
      for (let attempt = 0; attempt < 8; attempt++) {
        const text = randomCode();
        if (byCode(text)) continue;
        const draft = {
          id: null, code: text, kind: 'referral', offer: settings.referral.offer, products: settings.referral.products,
        };
        let discount = null;
        if (on('createDiscount')) {
          try {
            discount = (await provider.createDiscount({
              code: text, offer: draft.offer, products: draft.products, description: descriptionOf(draft),
            }))?.id ?? null;
          } catch (err) {
            if (err?.status === 409) continue;
            log(`[affiliates] the provider could not make the discount of ${text}: ${err?.message || err}`);
          }
        }
        const made = database.tx(() => {
          const id = database.run(`INSERT OR IGNORE INTO affiliate_codes (code, kind, user_id, offer, products, reward, active, created_at)
            VALUES (?, 'referral', ?, ?, ?, 'pro_month', 1, ?)`, text, user.id, JSON.stringify(draft.offer),
          draft.products.join(','), iso(clock())).lastInsertRowid;
          const row = referralRow(user.id);
          if (row?.code === text && discount) {
            database.run(`INSERT OR IGNORE INTO affiliate_discounts (code_id, provider, discount_id, created_at) VALUES (?, ?, ?, ?)`,
              row.id, key, String(discount), iso(clock()));
          }
          return id ? row : null;
        });
        if (made) return made;
        const other = referralRow(user.id);
        if (other) return other;
      }
      throw new HttpError(503, 'affiliate_code_unavailable');
    })();
    making.set(user.id, job);
    job.finally(() => making.delete(user.id)).catch(() => {});
    return job;
  }

  /* ---------------------------- who brought whom ------------------------- */

  const attributionOf = (userId) => database.get('SELECT * FROM affiliate_attributions WHERE user_id = ?', userId) ?? null;

  function attribute(userId, codeId, how) {
    if (how === 'checkout') {
      // The paid one wins: what the buyer did last.
      database.run(`INSERT INTO affiliate_attributions (user_id, code_id, source, at) VALUES (?, ?, 'checkout', ?)
        ON CONFLICT (user_id) DO UPDATE SET code_id = excluded.code_id, source = 'checkout', at = excluded.at`, userId, codeId, iso(clock()));
    } else {
      database.run(`INSERT OR IGNORE INTO affiliate_attributions (user_id, code_id, source, at) VALUES (?, ?, 'link', ?)`, userId, codeId, iso(clock()));
    }
  }

  const cookieHeader = (value, maxAge) => serializeCookie(REF_COOKIE, value, {
    maxAge, path: '/', httpOnly: false, sameSite: 'Lax', secure: secureCookies, domain: settings.cookieDomain,
  });
  /** The code's cookie, for 60 days, on the domain the website shares (`cookieDomain`). */
  const setCookie = (res, code) => appendHeader(res, 'Set-Cookie', cookieHeader(code, REF_COOKIE_SECONDS));

  /** A live code by what a link or a cookie says, or null. */
  function liveCode(value) {
    const text = normalizeCode(value);
    const code = text ? byCode(text) : null;
    return code?.active ? code : null;
  }

  /**
   * accounts.whenCreated: an account made in a browser that carries a code's cookie is that code's
   * (`link`), unless it is the owner's own, and the cookie goes. Inside the account's transaction, so
   * it never throws; never for an account the admin makes (the admin's own browser may carry one).
   */
  function attributeLink(user) {
    if (!enabled || !user?.id) return;
    const scope = currentRequest();
    if (!scope?.req || scope.path.startsWith('/api/admin/')) return;
    try {
      const value = parseCookies(scope.req)[REF_COOKIE];
      if (!value) return;
      if (scope.res && !scope.res.headersSent) appendHeader(scope.res, 'Set-Cookie', cookieHeader('', 0));
      const code = liveCode(value);
      if (!code || code.user_id === user.id) return;
      attribute(user.id, code.id, 'link');
    } catch (err) {
      log(`[affiliates] a new account's code could not be noted: ${err?.stack || err}`);
    }
  }

  /** `?codigo=<CODE>` on a page of the app: its cookie, once per request. */
  const seen = new WeakSet();
  function refFromQuery(req, res, url) {
    if (!enabled || seen.has(req)) return;
    seen.add(req);
    if (!['GET', 'HEAD'].includes(req.method)) return;
    if (/^\/(api|auth|oauth|mcp|\.well-known)(\/|$)/.test(url.pathname)) return;
    const value = url.searchParams.get('codigo');
    if (!value) return;
    const code = liveCode(value);
    if (code) setCookie(res, code.code);
  }

  /** `GET /r/<CODE>`: its cookie and the app's page. → whether it was such an address */
  function redirect(req, res, pathname) {
    const match = /^\/r\/([^/]+)\/?$/.exec(pathname);
    if (!match) return false;
    let value = '';
    try { value = decodeURIComponent(match[1]); } catch { /* none */ }
    const code = enabled ? liveCode(value) : null;
    if (code) setCookie(res, code.code);
    seen.add(req);
    res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  /* ---------------------------- first payments --------------------------- */

  /**
   * Whether someone already paid this install for something: their first payment noted here, or a
   * subscription or purchase of theirs at this provider other than the one being paid (one from
   * before the program noted payments).
   */
  function paidBefore(userId, { except = [] } = {}) {
    if (database.get('SELECT 1 FROM affiliate_buyers WHERE user_id = ?', userId)) return true;
    const refs = except.filter(Boolean).map(String);
    const not = refs.length ? ` AND ref NOT IN (${refs.map(() => '?').join(', ')})` : '';
    const notGrant = refs.length ? ` AND external_ref NOT IN (${refs.map(() => '?').join(', ')})` : '';
    return Boolean(database.get(`SELECT 1 FROM billing_subscriptions WHERE provider = ? AND subject_type = 'user'
      AND subject_id = ?${not} LIMIT 1`, source, userId, ...refs)
      || database.get(`SELECT 1 FROM entitlement_grants WHERE source = ? AND subject_type = 'user' AND subject_id = ?
        AND external_ref IS NOT NULL${notGrant} LIMIT 1`, source, userId, ...refs));
  }

  /**
   * billing.discountWith: the discount a checkout gets, for someone a code brought who never paid:
   * the code's, at this provider, when it is live, covers the product and isn't their own.
   */
  function discountFor({ subject, product }) {
    if (!enabled || subject?.type !== 'user') return null;
    const brought = attributionOf(subject.id);
    const code = brought ? byId(brought.code_id) : null;
    if (!code?.active || code.user_id === subject.id || !code.products.includes(product)) return null;
    if (paidBefore(subject.id)) return null;
    return discountOf(code.id);
  }

  /** Whether a buyer is the code's owner: the same account, the same customer, the same email. */
  function ownBuyer(code, buyer, event) {
    if (code.user_id === buyer.id) return 'same_account';
    const owner = accounts.byId(code.user_id);
    if (!owner) return null;
    const ownersCustomer = database.get(`SELECT customer_id FROM billing_customers WHERE subject_type = 'user'
      AND subject_id = ? AND provider = ?`, owner.id, source)?.customer_id;
    if (ownersCustomer && event.customer && ownersCustomer === String(event.customer)) return 'same_customer';
    if (owner.email && buyer.email && sameMailbox(owner.email) === sameMailbox(buyer.email)) return 'same_email';
    return null;
  }

  /**
   * billing.whenPaid: a payment of a person (a group's is no one's code). Its discount, when it is a
   * code's, attributes the buyer to it; their first payment that charged something, when a code
   * brought them, makes the code's commission, pending until `confirmDays` after it.
   * → what it did: 'none', 'attributed', 'noted', 'own', 'commission'
   */
  function paid({ user, organization = null, event }) {
    if (!user?.id || organization || event?.type !== 'payment') return 'none';
    const buyer = accounts.byId(user.id) ?? user;
    return database.tx(() => {
      let outcome = 'none';
      const typed = event.discount ? byDiscount(event.discount) : null;
      if (typed && typed.user_id !== buyer.id && (enabled || typed.kind === 'creator')) {
        attribute(buyer.id, typed.id, 'checkout');
        outcome = 'attributed';
      }
      const amount = Number(event.amount) || 0;
      if (amount <= 0) return outcome;
      if (paidBefore(buyer.id, { except: [event.ref, event.subscription] })) {
        database.run('INSERT OR IGNORE INTO affiliate_buyers (user_id, first_paid_at, event_id) VALUES (?, ?, ?)',
          buyer.id, event.occurredAt ?? iso(clock()), event.id ?? null);
        return outcome;
      }
      database.run('INSERT OR IGNORE INTO affiliate_buyers (user_id, first_paid_at, event_id) VALUES (?, ?, ?)',
        buyer.id, event.occurredAt ?? iso(clock()), event.id ?? null);
      const brought = attributionOf(buyer.id);
      const code = brought ? byId(brought.code_id) : null;
      // Off, only a creator's code typed at the checkout earns: that buyer did use it.
      if (!code?.active || (!enabled && !(brought.source === 'checkout' && code.kind === 'creator'))) return 'noted';
      if (!code.products.includes(String(event.product ?? ''))) return 'noted';
      const own = ownBuyer(code, buyer, event);
      if (own) {
        record('affiliates.self_referral', { targetId: code.id, meta: { code: code.code, why: own } });
        return 'own';
      }
      const paidAt = Date.parse(event.occurredAt) || clock();
      const made = database.run(`INSERT OR IGNORE INTO affiliate_commissions (code_id, buyer_id, entry, provider, ref, subscription,
          event_id, product, reward, amount, currency, status, paid_at, confirm_after, created_at)
        VALUES (?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      code.id, buyer.id, source, event.ref ?? null, event.subscription ?? null, event.id ?? null, event.product ?? null,
      code.reward, code.cash ?? 0, code.cash ? code.currency : null, iso(paidAt),
      iso(paidAt + settings.confirmDays * DAY), iso(clock())).changes;
      if (!made) return 'noted';
      record('affiliates.commission', { targetId: code.id, meta: { code: code.code, product: event.product ?? null } });
      return 'commission';
    });
  }

  /**
   * billing.whenRefunded: a refund of a payment that made a commission (its transaction, or its
   * subscription). Before it is confirmed it is reversed; after, a creator's earns a negative
   * entry and a referral's is only noted (see the top of this file). → how many it touched
   */
  function refunded({ event }) {
    const ref = event?.ref ? String(event.ref) : null;
    if (!ref) return 0;
    return database.tx(() => {
      const rows = database.all(`SELECT * FROM affiliate_commissions WHERE entry = 'sale' AND (ref = ? OR subscription = ?)`, ref, ref);
      const now = iso(clock());
      for (const row of rows) {
        if (row.status === 'pending') {
          database.run(`UPDATE affiliate_commissions SET status = 'reversed', reversed_at = ?, reason = 'refund' WHERE id = ?`, now, row.id);
          record('affiliates.reverse', { targetId: row.code_id, meta: { commission: row.id } });
        } else if (['confirmed', 'paid'].includes(row.status) && !row.refunded_at) {
          database.run('UPDATE affiliate_commissions SET refunded_at = ? WHERE id = ?', now, row.id);
          if (row.amount > 0) {
            database.run(`INSERT OR IGNORE INTO affiliate_commissions (code_id, buyer_id, entry, provider, ref, subscription, event_id,
                product, reward, amount, currency, status, paid_at, confirm_after, confirmed_at, reason, created_at)
              VALUES (?, ?, 'adjustment', ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, 'refund', ?)`,
            row.code_id, row.buyer_id, row.provider, row.ref, row.subscription, event.id ?? null, row.product, row.reward,
            -row.amount, row.currency, now, now, now, now);
          }
          record('affiliates.reverse', { targetId: row.code_id, meta: { commission: row.id, late: true } });
        }
      }
      return rows.length;
    });
  }

  /* -------------------------- confirmation, rewards ----------------------- */

  const yearOf = (ms) => new Date(ms).getUTCFullYear();
  /** The months a code gave (or is giving) in a calendar year. */
  const monthsIn = (codeId, year) => database.get(`SELECT COUNT(*) AS n FROM affiliate_rewards WHERE code_id = ?
    AND status != 'failed' AND created_at >= ? AND created_at < ?`, codeId, `${year}-01-01T00:00:00.000Z`, `${year + 1}-01-01T00:00:00.000Z`).n;

  /** Pending commissions past their days, confirmed; a referral's month queued, up to its cap. → how many */
  function confirmDue() {
    return database.tx(() => {
      const now = clock();
      const due = database.all(`SELECT c.*, k.kind FROM affiliate_commissions c JOIN affiliate_codes k ON k.id = c.code_id
        WHERE c.status = 'pending' AND c.confirm_after <= ? ORDER BY c.confirm_after, c.id`, iso(now));
      for (const row of due) {
        let reason = null;
        if (row.reward === 'pro_month') {
          const owner = database.get('SELECT user_id FROM affiliate_codes WHERE id = ?', row.code_id)?.user_id;
          if (monthsIn(row.code_id, yearOf(now)) >= settings.referral.yearlyCap) reason = 'yearly_cap';
          else {
            database.run(`INSERT OR IGNORE INTO affiliate_rewards (commission_id, code_id, user_id, status, created_at, updated_at)
              VALUES (?, ?, ?, 'pending', ?, ?)`, row.id, row.code_id, owner, iso(now), iso(now));
          }
        }
        database.run(`UPDATE affiliate_commissions SET status = 'confirmed', confirmed_at = ?, reason = COALESCE(?, reason)
          WHERE id = ? AND status = 'pending'`, iso(now), reason, row.id);
      }
      return due.length;
    });
  }

  /** The end of the person's last referral grant still to come, or now. */
  const chainedStart = (userId) => {
    const now = clock();
    const last = database.get(`SELECT MAX(ends_at) AS ends FROM entitlement_grants WHERE source = 'referral' AND subject_type = 'user'
      AND subject_id = ? AND revoked_at IS NULL`, userId)?.ends;
    const end = last ? Date.parse(last) : NaN;
    return Number.isNaN(end) || end < now ? now : end;
  };

  /** The person's live web subscription that renews (not one cancelled for its period's end), or null. */
  const renewingSubscription = (userId) => database.get(`SELECT ref FROM billing_subscriptions WHERE provider = ? AND subject_type = 'user'
    AND subject_id = ? AND status IN ('active', 'trialing') AND (ending IS NULL OR ending = 0) ORDER BY updated_at DESC LIMIT 1`, source, userId)?.ref ?? null;

  const moveReward = (id, from, fields) => {
    const sets = Object.keys(fields).map((name) => `${name} = ?`).join(', ');
    return database.run(`UPDATE affiliate_rewards SET ${sets}, updated_at = ? WHERE id = ? AND status = ?`,
      ...Object.values(fields), iso(clock()), id, from).changes > 0;
  };

  function grantMonth(reward) {
    const start = chainedStart(reward.user_id);
    const code = byId(reward.code_id);
    return entitlements.grant({
      subjectType: 'user', subjectId: reward.user_id, plan: rewardPlan(), source: 'referral', externalRef: `reward:${reward.id}`,
      startsAt: iso(start), endsAt: iso(start + REWARD_DAYS * DAY), note: code?.code ?? null,
    });
  }

  /** One reward given, taken first (`sending`) so two sweeps never give it twice. */
  async function giveReward(reward, stale) {
    const taken = database.run(`UPDATE affiliate_rewards SET status = 'sending', updated_at = ? WHERE id = ?
      AND (status = 'pending' OR (status = 'sending' AND updated_at < ?))`, iso(clock()), reward.id, stale).changes;
    if (!taken) return null;
    const now = iso(clock());
    if (!accounts.byId(reward.user_id)) {
      moveReward(reward.id, 'sending', { status: 'failed', last_error: 'account_gone', done_at: now });
      return 'failed';
    }
    const ref = on('postponeRenewal') ? renewingSubscription(reward.user_id) : null;
    if (ref) {
      let answer;
      try {
        answer = await provider.postponeRenewal(ref, REWARD_DAYS);
      } catch (err) {
        const tries = reward.tries + 1;
        const failed = tries >= REWARD_TRIES;
        moveReward(reward.id, 'sending', {
          status: failed ? 'failed' : 'pending', tries, last_error: String(err?.code || err?.message || err).slice(0, 200),
          done_at: failed ? iso(clock()) : null,
        });
        log(`[affiliates] the renewal of ${ref} could not be put off yet${failed ? ', given up' : ', tried again later'}: ${err?.message || err}`);
        return failed ? 'failed' : 'waiting';
      }
      if (!answer?.ended) {
        moveReward(reward.id, 'sending', { status: 'postponed', ref, done_at: iso(clock()) });
        record('affiliates.reward', { targetId: reward.code_id, meta: { how: 'postponed' } });
        return 'postponed';
      }
      // It no longer renews there: the month is a grant, as for someone who doesn't pay.
    }
    const grantId = database.tx(() => {
      const id = grantMonth(reward);
      moveReward(reward.id, 'sending', { status: 'granted', grant_id: id, done_at: iso(clock()) });
      return id;
    });
    record('affiliates.reward', { targetId: reward.code_id, meta: { how: 'granted', grant: grantId } });
    return 'granted';
  }

  /**
   * The hourly sweep: commissions past their days confirmed, then each month due given (a grant, or
   * the next renewal put off). → { confirmed, granted, postponed, failed, waiting }
   */
  async function sweep() {
    const confirmed = confirmDue();
    const stale = iso(clock() - SENDING_MS);
    const due = database.all(`SELECT * FROM affiliate_rewards WHERE status = 'pending' OR (status = 'sending' AND updated_at < ?)
      ORDER BY id`, stale);
    const counts = { confirmed, granted: 0, postponed: 0, failed: 0, waiting: 0 };
    for (const reward of due) {
      const done = await giveReward(reward, stale);
      if (done) counts[done] += 1;
    }
    return counts;
  }

  /* -------------------------------- figures ------------------------------ */

  /** A code's figures: accounts brought, its sales by state, what it earned, what was paid, months given. */
  function figuresOf(codeId) {
    const counts = Object.fromEntries(database.all(`SELECT status, COUNT(*) AS n FROM affiliate_commissions
      WHERE code_id = ? AND entry = 'sale' GROUP BY status`, codeId).map((r) => [r.status, r.n]));
    const sums = database.get(`SELECT
        COALESCE(SUM(CASE WHEN status = 'pending' AND entry = 'sale' THEN amount END), 0) AS pending_amount,
        COALESCE(SUM(CASE WHEN status IN ('confirmed', 'paid') THEN amount END), 0) AS earned
      FROM affiliate_commissions WHERE code_id = ?`, codeId);
    const paidOut = database.get('SELECT COALESCE(SUM(amount), 0) AS n FROM affiliate_payouts WHERE code_id = ?', codeId).n;
    const year = yearOf(clock());
    return {
      accounts: database.get('SELECT COUNT(*) AS n FROM affiliate_attributions WHERE code_id = ?', codeId).n,
      pending: counts.pending ?? 0,
      confirmed: (counts.confirmed ?? 0) + (counts.paid ?? 0),
      reversed: counts.reversed ?? 0,
      pending_amount: sums.pending_amount,
      earned: sums.earned,
      paid: paidOut,
      balance: sums.earned - paidOut,
      months: database.get(`SELECT COUNT(*) AS n FROM affiliate_rewards WHERE code_id = ? AND status IN ('granted', 'postponed')`, codeId).n,
      months_this_year: monthsIn(codeId, year),
    };
  }

  const payoutsOf = (codeId) => database.all(`SELECT id, amount, currency, method, reference, note, paid_at, created_at
    FROM affiliate_payouts WHERE code_id = ? ORDER BY paid_at DESC, id DESC`, codeId);

  /** The rules, as the panel says them. */
  const rules = () => ({
    enabled,
    confirm_days: settings.confirmDays,
    referral: {
      offer: settings.referral.offer, products: settings.referral.products, reward: 'pro_month', reward_days: REWARD_DAYS,
      yearly_cap: settings.referral.yearlyCap,
    },
    creator: {
      offer: settings.creator.offer, products: settings.creator.products, reward: settings.creator.reward,
      payout_minimum: settings.creator.payoutMinimum,
    },
    press_kit_url: settings.pressKitUrl,
  });

  /* ----------------------------- the panel --------------------------------- */

  /** What `/afiliados` shows the person: their codes, each with its link and figures, and the rules. */
  async function me(user) {
    if (!enabled) throw notFound('affiliates_off');
    await referralOf(user);
    const codes = database.all(`SELECT * FROM affiliate_codes WHERE user_id = ? ORDER BY kind = 'referral' DESC, id`, user.id).map(shape);
    return {
      codes: codes.map((code) => ({
        code: code.code, kind: code.kind, campaign: code.campaign, active: code.active, link: linkOf(code.code),
        offer: code.offer, products: code.products, reward: code.cash ? { cash: code.cash, currency: code.currency } : code.reward,
        discount: Boolean(discountOf(code.id)), figures: figuresOf(code.id),
        ...(code.cash ? { payouts: payoutsOf(code.id), payout_note: code.payout_note } : {}),
      })),
      rules: rules(),
    };
  }

  /** The creator's own note of how they want to be paid, on each of their campaigns. */
  function setPayoutNote(user, note) {
    if (!enabled) throw notFound('affiliates_off');
    if (note != null && typeof note !== 'string') throw badRequest('field_invalid', { field: 'payout_note' });
    const text = String(note ?? '').trim();
    if (text.length > NOTE_MAX) throw badRequest('field_too_long', { field: 'payout_note', max: NOTE_MAX });
    const changed = database.run(`UPDATE affiliate_codes SET payout_note = ? WHERE user_id = ? AND kind = 'creator'`,
      text || null, user.id).changes;
    if (!changed) throw notFound('affiliate_code_not_found');
    return text || null;
  }

  /* --------------------------------- admin --------------------------------- */

  const ownerOf = (userId) => {
    const owner = accounts.byId(userId);
    return owner ? { id: owner.id, email: owner.email ?? null, display_name: owner.display_name ?? owner.username } : null;
  };

  /** Every code (or one kind), with its owner and figures, newest first; and the totals. */
  function list({ kind = null } = {}) {
    const rows = database.all(`SELECT * FROM affiliate_codes ${kind ? 'WHERE kind = ?' : ''} ORDER BY id DESC`, ...(kind ? [kind] : []))
      .map(shape);
    const codes = rows.map((code) => ({
      ...code, owner: ownerOf(code.user_id), discount: Boolean(discountOf(code.id)), link: linkOf(code.code), figures: figuresOf(code.id),
    }));
    const totals = { accounts: 0, pending: 0, confirmed: 0, reversed: 0, earned: 0, paid: 0, balance: 0, months: 0 };
    for (const code of codes) for (const name of Object.keys(totals)) totals[name] += code.figures[name];
    return {
      enabled, discounts: on('createDiscount'), rules: rules(), products: (billing?.offer?.() ?? []).map((p) => p.key), codes, totals,
    };
  }

  /** What a campaign the admin makes says, checked; the program's own for what it leaves out. */
  function campaignOf(body) {
    const code = normalizeCode(body.code);
    if (!code) throw badRequest('field_invalid', { field: 'code' });
    const campaign = String(body.campaign ?? '').trim();
    if (campaign.length > 80) throw badRequest('field_too_long', { field: 'campaign', max: 80 });
    const note = String(body.note ?? '').trim();
    if (note.length > NOTE_MAX) throw badRequest('field_too_long', { field: 'note', max: NOTE_MAX });
    const offer = body.offer ?? settings.creator.offer;
    if (offerProblem(offer)) throw badRequest('field_invalid', { field: 'offer' });
    const products = body.products ?? settings.creator.products;
    if (productsProblem(products)) throw badRequest('field_invalid', { field: 'products' });
    const known = new Set((billing?.offer?.() ?? []).map((p) => p.key));
    if (known.size && products.some((p) => !known.has(p))) throw badRequest('field_invalid', { field: 'products' });
    const reward = body.reward ?? settings.creator.reward;
    if (cashProblem(reward)) throw badRequest('field_invalid', { field: 'reward' });
    return { code, campaign: campaign || null, note: note || null, offer: cleanOffer(offer), products: [...new Set(products)], reward };
  }

  /**
   * A creator's campaign for the account with that email: the code at the provider first (a code it
   * already has is 409 discount_code_taken, and nothing is kept), then here. Without
   * `createDiscount`, the code works by its link alone.
   */
  async function createCampaign(body, admin) {
    const wanted = campaignOf(body || {});
    const email = String(body?.email ?? '').trim();
    if (!email) throw badRequest('field_required', { field: 'email' });
    const owner = accounts.byEmail(email);
    if (!owner) throw notFound('user_not_found');
    if (byCode(wanted.code)) throw conflict('affiliate_code_taken');
    const draft = { code: wanted.code, kind: 'creator', offer: wanted.offer, products: wanted.products };
    let discount = null;
    if (on('createDiscount')) {
      try {
        discount = (await provider.createDiscount({
          code: wanted.code, offer: wanted.offer, products: wanted.products, description: descriptionOf(draft),
        }))?.id ?? null;
      } catch (err) {
        if (err?.status === 409) throw conflict('discount_code_taken');
        log(`[affiliates] the provider could not make the discount of ${wanted.code}: ${err?.message || err}`);
        throw new HttpError(502, 'discount_failed');
      }
    }
    const id = database.tx(() => {
      if (byCode(wanted.code)) throw conflict('affiliate_code_taken');
      const made = database.run(`INSERT INTO affiliate_codes (code, kind, user_id, campaign, offer, products, reward, currency, active, note,
          created_by, created_at) VALUES (?, 'creator', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`, wanted.code, owner.id, wanted.campaign,
      JSON.stringify(wanted.offer), wanted.products.join(','), `cash:${wanted.reward.cash}`, wanted.reward.currency, wanted.note,
      admin?.id ?? null, iso(clock())).lastInsertRowid;
      if (discount) {
        database.run('INSERT INTO affiliate_discounts (code_id, provider, discount_id, created_at) VALUES (?, ?, ?, ?)',
          Number(made), key, String(discount), iso(clock()));
      }
      return Number(made);
    });
    return { ...byId(id), owner: ownerOf(owner.id), discount: Boolean(discount), link: linkOf(wanted.code), figures: figuresOf(id) };
  }

  /** A code on or off, at the provider too when it can (its discount archived or active again). */
  async function setActive(id, active) {
    if (typeof active !== 'boolean') throw badRequest('field_invalid', { field: 'active' });
    const code = byId(id);
    if (!code) throw notFound('affiliate_code_not_found');
    const discount = discountOf(code.id);
    if (discount && on('setDiscountActive') && code.active !== active) {
      try {
        await provider.setDiscountActive(discount, active);
      } catch (err) {
        log(`[affiliates] the provider could not turn ${code.code} ${active ? 'on' : 'off'}: ${err?.message || err}`);
        throw new HttpError(502, 'discount_failed');
      }
    }
    database.run('UPDATE affiliate_codes SET active = ? WHERE id = ?', active ? 1 : 0, code.id);
    return { ...byId(code.id), owner: ownerOf(code.user_id), discount: Boolean(discount), link: linkOf(code.code), figures: figuresOf(code.id) };
  }

  /** A code's commissions, newest first, each with its buyer, and its payouts. */
  function commissionsOf(id) {
    const code = byId(id);
    if (!code) throw notFound('affiliate_code_not_found');
    const commissions = database.all(`SELECT c.*, u.email AS buyer_email, u.display_name AS buyer_name FROM affiliate_commissions c
      LEFT JOIN users u ON u.id = c.buyer_id WHERE c.code_id = ? ORDER BY c.paid_at DESC, c.id DESC`, code.id).map((row) => ({
      id: row.id, entry: row.entry, buyer: { id: row.buyer_id, email: row.buyer_email ?? null, display_name: row.buyer_name ?? null },
      product: row.product, reward: row.reward, amount: row.amount, currency: row.currency, status: row.status, paid_at: row.paid_at,
      confirm_after: row.confirm_after, confirmed_at: row.confirmed_at, reversed_at: row.reversed_at, refunded_at: row.refunded_at,
      reason: row.reason, payout_id: row.payout_id,
    }));
    return { code: { ...code, owner: ownerOf(code.user_id), figures: figuresOf(code.id) }, commissions, payouts: payoutsOf(code.id) };
  }

  /**
   * A payout the admin made to a creator, noted: what, how and its reference. When it covers all that
   * was confirmed, those entries are `paid` with it; a smaller one only lowers the balance. Never
   * more than the balance.
   */
  function recordPayout(id, body, admin) {
    const code = byId(id);
    if (!code) throw notFound('affiliate_code_not_found');
    if (!code.cash) throw conflict('payout_not_cash');
    const amount = body?.amount;
    if (!Number.isInteger(amount) || amount <= 0 || amount > AMOUNT_MAX) throw badRequest('field_invalid', { field: 'amount' });
    const text = (name, max) => {
      const value = String(body?.[name] ?? '').trim();
      if (value.length > max) throw badRequest('field_too_long', { field: name, max });
      return value || null;
    };
    const method = text('method', 80);
    const reference = text('reference', 120);
    const note = text('note', NOTE_MAX);
    let paidAt = iso(clock());
    if (body?.paid_at != null) {
      const at = Date.parse(body.paid_at);
      if (Number.isNaN(at)) throw badRequest('field_invalid', { field: 'paid_at' });
      paidAt = iso(at);
    }
    return database.tx(() => {
      const { balance } = figuresOf(code.id);
      if (amount > balance) throw conflict('payout_over_balance', { balance });
      const payoutId = Number(database.run(`INSERT INTO affiliate_payouts (code_id, amount, currency, method, reference, note, paid_at,
          by_user, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, code.id, amount, code.currency, method, reference, note, paidAt,
      admin?.id ?? null, iso(clock())).lastInsertRowid);
      if (amount === balance) {
        database.run(`UPDATE affiliate_commissions SET status = 'paid', payout_id = ? WHERE code_id = ? AND status = 'confirmed'`,
          payoutId, code.id);
      }
      return { id: payoutId, amount, currency: code.currency, method, reference, note, paid_at: paidAt, figures: figuresOf(code.id) };
    });
  }

  /** Every commission and payout as CSV (one kind, or all), for the books. */
  function exportCsv({ kind = null } = {}) {
    const lines = [['type', 'code', 'kind', 'campaign', 'owner_email', 'buyer_id', 'product', 'status', 'amount', 'currency',
      'paid_at', 'confirmed_at', 'reversed_at', 'refunded_at', 'reason', 'method', 'reference'].join(',')];
    const where = kind ? 'WHERE k.kind = ?' : '';
    const args = kind ? [kind] : [];
    for (const row of database.all(`SELECT c.*, k.code, k.kind, k.campaign, u.email AS owner_email FROM affiliate_commissions c
      JOIN affiliate_codes k ON k.id = c.code_id LEFT JOIN users u ON u.id = k.user_id ${where} ORDER BY c.paid_at, c.id`, ...args)) {
      lines.push([row.entry, row.code, row.kind, row.campaign, row.owner_email, row.buyer_id, row.product, row.status, row.amount,
        row.currency, row.paid_at, row.confirmed_at, row.reversed_at, row.refunded_at, row.reason, '', ''].map(csvCell).join(','));
    }
    for (const row of database.all(`SELECT p.*, k.code, k.kind, k.campaign, u.email AS owner_email FROM affiliate_payouts p
      JOIN affiliate_codes k ON k.id = p.code_id LEFT JOIN users u ON u.id = k.user_id ${where} ORDER BY p.paid_at, p.id`, ...args)) {
      lines.push(['payout', row.code, row.kind, row.campaign, row.owner_email, '', '', 'paid', row.amount, row.currency, row.paid_at,
        '', '', '', row.note, row.method, row.reference].map(csvCell).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  /**
   * An account that goes: who brought it and its first payment are forgotten; its codes stop (at the
   * provider too, once this is over) and stay, with their commissions and payouts, for the books.
   */
  function forget(userId) {
    database.run('DELETE FROM affiliate_attributions WHERE user_id = ?', userId);
    database.run('DELETE FROM affiliate_buyers WHERE user_id = ?', userId);
    const live = database.all('SELECT id FROM affiliate_codes WHERE user_id = ? AND active = 1', userId);
    if (!live.length) return 0;
    database.run('UPDATE affiliate_codes SET active = 0 WHERE user_id = ?', userId);
    if (on('setDiscountActive')) {
      const discounts = live.map(({ id }) => discountOf(id)).filter(Boolean);
      setImmediate(async () => {
        for (const discount of discounts) {
          await provider.setDiscountActive(discount, false).catch((err) => log(`[affiliates] a gone account's discount stays on at the provider: ${err?.message || err}`));
        }
      });
    }
    return live.length;
  }

  return {
    enabled, settings, rules, me, setPayoutNote, list, createCampaign, setActive, commissionsOf, recordPayout, exportCsv,
    referralOf, attributeLink, refFromQuery, redirect, discountFor, paid, refunded, sweep, forget, figuresOf,
    codeOf: (text) => byCode(normalizeCode(text)),
  };
}

/**
 * The routes: the person's own panel (`/api/affiliates/me`) and the admin's (`/api/admin/affiliates`),
 * administrators only, guarded as the rest of /api/admin is (401 without a session, 403 admin_only).
 */
export function registerAffiliatesApi(router, { affiliates, audit = null, admin = true }) {
  const requireUser = (ctx) => {
    if (!ctx.user) throw unauthorized();
    return ctx.user;
  };
  const requireAdmin = (ctx) => {
    const user = requireUser(ctx);
    if (user.role !== 'admin') throw forbidden('admin_only');
    return user;
  };
  const kindOf = (ctx) => {
    const kind = ctx.query?.get('kind') || null;
    if (kind && !['referral', 'creator'].includes(kind)) throw badRequest('field_invalid', { field: 'kind' });
    return kind;
  };

  router.get('/api/affiliates/me', async (ctx) => {
    sendJson(ctx.res, 200, await affiliates.me(requireUser(ctx)));
  });
  router.put('/api/affiliates/me', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    const note = affiliates.setPayoutNote(user, body.payout_note);
    audit?.record({ action: 'affiliates.payout_note', actor: user, req: ctx.req, targetType: 'user', targetId: user.id });
    sendJson(ctx.res, 200, { payout_note: note });
  });
  if (!admin) return;

  router.get('/api/admin/affiliates', (ctx) => {
    requireAdmin(ctx);
    sendJson(ctx.res, 200, affiliates.list({ kind: kindOf(ctx) }));
  });
  router.get('/api/admin/affiliates/export', (ctx) => {
    requireAdmin(ctx);
    const body = affiliates.exportCsv({ kind: kindOf(ctx) });
    ctx.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="affiliates.csv"',
    });
    ctx.res.end(body);
  });
  router.post('/api/admin/affiliates', async (ctx) => {
    const admin = requireAdmin(ctx);
    const body = await readJson(ctx.req);
    const code = await affiliates.createCampaign(body, admin);
    audit?.record({ action: 'admin.affiliates.create', actor: admin, req: ctx.req, targetType: 'affiliate_code', targetId: code.id, meta: { code: code.code } });
    sendJson(ctx.res, 201, { code });
  });
  router.put('/api/admin/affiliates/:id', async (ctx) => {
    const admin = requireAdmin(ctx);
    const body = await readJson(ctx.req);
    const code = await affiliates.setActive(Number(ctx.params.id), body.active);
    audit?.record({ action: 'admin.affiliates.update', actor: admin, req: ctx.req, targetType: 'affiliate_code', targetId: code.id, meta: { active: code.active } });
    sendJson(ctx.res, 200, { code });
  });
  router.get('/api/admin/affiliates/:id/commissions', (ctx) => {
    requireAdmin(ctx);
    sendJson(ctx.res, 200, affiliates.commissionsOf(Number(ctx.params.id)));
  });
  router.post('/api/admin/affiliates/:id/payouts', async (ctx) => {
    const admin = requireAdmin(ctx);
    const body = await readJson(ctx.req);
    const payout = affiliates.recordPayout(Number(ctx.params.id), body, admin);
    audit?.record({ action: 'admin.affiliates.payout', actor: admin, req: ctx.req, targetType: 'affiliate_code', targetId: Number(ctx.params.id), meta: { amount: payout.amount } });
    sendJson(ctx.res, 201, { payout });
  });
}
