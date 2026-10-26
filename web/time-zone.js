/**
 * The person's time zone, told to the server like the language their browser
 * resolved (prefs.lang_seen): what runs without a browser —an assistant's
 * "tomorrow at 9", a daily note, what is overdue today— reads their day in it
 * (suite-core time.js). Every module of the suite shares `prefs.tz` in the same
 * account, and the server keeps it canonical ("Europe/Madrid").
 *
 * Once per change: nothing is sent while the account already has this zone.
 * It is only a hint, so a failure is not an error for anyone.
 */
import { api } from './api.js';

/** The browser's zone ("Europe/Madrid"), as the runtime names it, or null. */
export function browserTimeZone(intl = globalThis.Intl) {
  try {
    return intl?.DateTimeFormat?.().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * Tells the server `user`'s zone when it isn't the one their account has, and
 * keeps it in `user.prefs` so the next call sends nothing. `send` is how the
 * app writes `PATCH /api/me` (the kit's api by default).
 * @returns {string|null} the zone sent, or null when nothing went
 */
export function reportTimeZone(user, { zone = browserTimeZone(), send = (body) => api.patch('/api/me', body) } = {}) {
  if (!user || !zone || user.prefs?.tz === zone) return null;
  user.prefs = { ...user.prefs, tz: zone };
  Promise.resolve().then(() => send({ prefs: { tz: zone } })).catch(() => { /* it is only a hint */ });
  return zone;
}
