/**
 * Days as the person's browser counts them, the same in every module: the day a moment falls on
 * here, as 'YYYY-MM-DD' (dayKey), a day moved by some days (addDays) and the days from one day to
 * another (daysBetween). Today is
 * `dayKey(new Date())`: the day on this device's clock, the one the person sees. UTC's is not it:
 * in Madrid it is still yesterday until one in the morning, two in summer.
 *
 * Nothing here touches the page, the network or the device, and nothing is imported: a module's
 * offline model and Cronum Work's calendar run it in Node too.
 *
 * A day has no time and no zone, so it is moved in UTC: there, no summer time change makes a day
 * 23 or 25 hours long. The same answers as the server's addDays (suite-core time.js).
 */

const pad = (n) => String(n).padStart(2, '0');

/** The day `date` falls on here (a Date, its milliseconds, or a moment Date reads), as 'YYYY-MM-DD'. */
export function dayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `day` ('YYYY-MM-DD') moved by `n` days, back when n is negative. No day (null, '') stays as it is. */
export function addDays(day, n) {
  if (!day) return day;
  const moved = new Date(`${day}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + n);
  return moved.toISOString().slice(0, 10);
}

/** Days from `a` to `b` (each 'YYYY-MM-DD'): 0 for the same day, negative when b comes first. */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
