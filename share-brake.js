/**
 * The brake on invitations, for sharing.js (audit 2026-10-23, A3).
 *
 * Sharing by email is open to every account that shares. Without a brake anyone
 * could try addresses to see who has an account, and make the app ring someone's
 * phone or send them an email with a name of the sender's choosing, as often as
 * they liked. Two limits:
 *
 *   · offers: how many new offers one person may make in an hour (a new offer,
 *     or an address that turns out not to be known: both count, or the refusal
 *     would tell them apart), then 429 share_limit;
 *   · notices: one notice (push or email) per sender and recipient every 24
 *     hours, however often the offer is withdrawn and made again, for anything.
 *
 * This one lives in memory, as Notes' did (notes/server/invite-brake.js, where it
 * comes from): a restart forgets it, which gives an attacker nothing worth the
 * wait. The suite's limiter (rate-limit.js) keeps a 15-minute window, so it can't
 * count a day. A module that wants the brake to outlive restarts passes its own
 * to createSharing({ brake }) with the same two methods (Tasks keeps a table).
 */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** More than this many entries and the oldest go: a bound on memory, not a rule. */
const MAX_ENTRIES = 50_000;

export const OFFERS_PER_HOUR = 20;

/**
 * → { offer(actorId) → { allowed, retryAfter? }, notice(actorId, targetId) → boolean }.
 * `retryAfter` is in seconds; `notice` says yes once and counts it as sent.
 */
export function createShareBrake({ clock = () => Date.now(), offersPerHour = OFFERS_PER_HOUR } = {}) {
  /** sender → times of their offers in the last hour. */
  const offers = new Map();
  /** "sender:recipient" → when the last notice went. */
  const notices = new Map();

  function prune(now) {
    for (const [key, times] of offers) {
      const recent = times.filter((at) => now - at < HOUR_MS);
      if (recent.length) offers.set(key, recent);
      else offers.delete(key);
    }
    for (const [key, at] of notices) if (now - at >= DAY_MS) notices.delete(key);
    while (notices.size > MAX_ENTRIES) notices.delete(notices.keys().next().value);
  }

  let swept = 0;
  const sweepIfDue = (now) => {
    if (now - swept < HOUR_MS / 4 && offers.size + notices.size < MAX_ENTRIES) return;
    swept = now;
    prune(now);
  };

  return {
    offer(actorId) {
      const now = clock();
      sweepIfDue(now);
      const times = (offers.get(actorId) || []).filter((at) => now - at < HOUR_MS);
      if (times.length >= offersPerHour) {
        offers.set(actorId, times);
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((times[0] + HOUR_MS - now) / 1000)) };
      }
      times.push(now);
      offers.set(actorId, times);
      return { allowed: true };
    },

    notice(actorId, targetId) {
      const now = clock();
      sweepIfDue(now);
      const key = `${actorId}:${targetId}`;
      const last = notices.get(key);
      if (last !== undefined && now - last < DAY_MS) return false;
      notices.delete(key);
      notices.set(key, now);
      return true;
    },
  };
}
