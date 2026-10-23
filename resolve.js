/**
 * Loose name resolution, for the MCP servers of every module.
 *
 * Whoever talks to an AI doesn't say "list 7", they say "the shopping". This
 * turns that into an item, and when there is more than one reasonable
 * candidate it doesn't pick at random: it throws a ResolveError with the
 * options, so the AI asks. Tasks, Projects and Next each had a copy of this
 * scoring (audit 2026-10-23, A4); this one starts from Next's, the strictest.
 *
 * What people write may be in Spanish, English, French or German (the
 * languages of the apps): the MCP doesn't know which one the person speaks, so
 * the filler words of all four are understood at once. They don't collide.
 */

/** A resolution that went nowhere: it reaches the AI as useful text (the message and the options to ask about), not as a failure. */
export class ResolveError extends Error {
  constructor(message, options = []) {
    super(message);
    this.name = 'ResolveError';
    this.options = options;
  }
}

/** A ResolveError as the text the AI reads: the message, then up to 25 options, one per line. */
export function resolveErrorText(error) {
  const options = error.options?.length
    ? `\nOptions:\n${error.options.slice(0, 25).map((o) => `- ${o}`).join('\n')}`
    : '';
  return `${error.message}${options}`;
}

/**
 * Words that carry no meaning in a name ("the online shop" → "online shop"):
 * articles, possessives and some prepositions, in Spanish, English, French and
 * German, as nameKey() leaves them (lowercase, no accents: "für" is "fur").
 * Each module adds its own nouns ("list", "project", "branch"…) with stopwords().
 *
 * Words that are also names or quantities elsewhere are left out on purpose, or
 * two different names would collapse into one: "to" and "on" ("Send to Ana" is
 * not "Send Ana"), the French elisions "l" and "d" ("Vitamin D") and "mes", the
 * Spanish word for month ("Cerrar el mes").
 */
export const STOPWORDS = Object.freeze(new Set([
  // Spanish
  'la', 'las', 'el', 'los', 'de', 'del', 'mi', 'mis', 'una', 'un', 'para', 'en', 'a',
  // English
  'the', 'an', 'my', 'of', 'for', 'in',
  // French
  'le', 'les', 'une', 'des', 'du', 'au', 'aux', 'mon', 'ma', 'pour', 'dans',
  // German
  'der', 'die', 'das', 'dem', 'den', 'ein', 'eine', 'einen', 'mein', 'meine', 'meiner', 'meinen',
  'fur', 'im', 'auf', 'von', 'zum', 'zur',
]));

/** The shared filler words plus a module's own: `stopwords('list', 'lista', 'liste')`. */
export const stopwords = (...words) => Object.freeze(new Set([...STOPWORDS, ...words.flat()]));

/**
 * Lowercase, without accents or punctuation, keeping every alphabet's letters,
 * digits and emoji: "Café  Molido!" → "cafe molido". Kept to a–z, "Магазин",
 * "買い物" or "🎂" came out empty, and an empty name starts every reference.
 */
export function nameKey(text) {
  return String(text ?? '')
    .toLowerCase()
    // Letters that are not a base letter plus an accent, so the NFD strip below
    // would drop them whole ("Straße" → "stra e"): spelled the way people type them.
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    // Accents, already split off by NFD, go with the combining-marks range.
    // Written with escapes on purpose: as literals they would be invisible
    // characters that any later edit could break.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\p{Extended_Pictographic}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The meaningful words of a name: "the online shop" → ["online", "shop"]. Only filler words → all of them. */
export function keywords(text, words = STOPWORDS) {
  const all = nameKey(text).split(' ').filter(Boolean);
  const kept = all.filter((w) => !words.has(w));
  return kept.length ? kept : all;
}

/** Score from which a match is taken without asking, when writing. */
export const CLEAR_MATCH = 70;

/**
 * Scores every item against `ref`, best first, dropping those that don't look
 * alike at all. In order: exact name (100) → same words (95) → prefix (80) →
 * contains (70) → word overlap (30–60).
 *
 * `inside` marks a prefix or "contains" that only holds the other way round:
 * the item's name inside a longer reference ("Go" in "Google Ads campaign").
 * Reading can take it; writing can't, because that reference is usually a new
 * item that merely starts like an old one.
 * @returns {{item, points: number, inside: boolean}[]}
 */
export function score(items, ref, { getName = (i) => i.name, stopwords: words = STOPWORDS } = {}) {
  const needle = nameKey(ref);
  if (!needle) return [];
  const needleWords = keywords(ref, words);
  // Prefix and "contains" are also checked without filler words: otherwise
  // "the shop" doesn't start like "Shop online" and ends up as a mere word
  // overlap, which forces a question when writing.
  const needleKey = needleWords.join(' ');
  const startsWith = (a, b) => a.startsWith(b) || b.startsWith(a);
  const contains = (a, b) => a.includes(b) || b.includes(a);
  return items.map((item) => {
    const name = nameKey(getName(item));
    const itemWords = keywords(getName(item), words);
    const key = itemWords.join(' ');
    // The reference within the name: "the shop" in "Online shop".
    const within = name.includes(needle) || key.includes(needleKey);
    let points = 0;
    let inside = false;
    // Nothing left of a name matches nothing: '' starts every text.
    if (!name) points = 0;
    else if (name === needle) points = 100;
    else if (key === needleKey) points = 95;
    else if (startsWith(name, needle) || startsWith(key, needleKey)) { points = 80; inside = !within; }
    else if (contains(name, needle) || contains(key, needleKey)) { points = 70; inside = !within; }
    else {
      const common = needleWords.filter((w) => itemWords.some((n) => n.startsWith(w) || w.startsWith(n))).length;
      if (common) points = 30 + (common / Math.max(needleWords.length, itemWords.length)) * 30;
    }
    return { item, points, inside };
  }).filter((s) => s.points > 0).sort((a, b) => b.points - a.points);
}

/** Whether a scored match is good enough to write on without asking. */
export const isClear = (match) => match.points >= CLEAR_MATCH && !match.inside;

/** An option the AI can repeat as it is: the name, and its #id for when names look alike. */
export const optionOf = (item, getName = (i) => i.name) =>
  (item.id != null ? `${getName(item)} (#${item.id})` : getName(item));

/**
 * "#12", "12" or "id 12": a reference that is only a number, the #id the tools
 * show. → its digits, or null. ("nº7", a number counted within a list, is a
 * module's own: Tasks.)
 */
export function numberRef(ref) {
  const match = String(ref ?? '').trim().match(/^(?:#|id\s*)?\s*(\d+)$/i);
  return match ? match[1] : null;
}

/**
 * What a bare number names: the item with that id, else the only one whose
 * whole name is that number ("2026"). Never one with the number somewhere in
 * its name: "#5" would find "5. Web" or "Phase 1" ("1" starts "12"), and
 * writing on it changes something nobody touched. → the item, or null.
 */
export function byNumber(items, number, getName = (i) => i.name) {
  const digits = String(number);
  const byId = items.find((i) => String(i.id) === digits);
  if (byId) return byId;
  const named = items.filter((i) => nameKey(getName(i)) === digits);
  return named.length === 1 ? named[0] : null;
}

/**
 * The best match for `ref` among `items`. A bare number ("#12", "12") is an id
 * and nothing else (byNumber); a name is matched approximately (score).
 *
 * `strict`, for the tools that write: only a clear match counts, and any tie
 * is asked about, even between names that read the same ("Cafe" and "Café",
 * "C++" and "C#"). Acting on the wrong item changes something nobody touched,
 * and only the tool's answer would tell.
 *
 * `create`, for the tools that write and may create (Next's log_progress): a
 * name that looks like nothing is a new item → null; one that only looks a bit
 * like some is asked about, with `create` (when a string) appended to say how
 * to create it anyway ("If it is a new project, call again with new=true.").
 * It implies `strict`.
 * @throws {ResolveError} when there is none, several tie, or (strict) none is clear
 */
export function matchByName(items, ref, {
  label = 'item', getName = (i) => i.name, strict = false, create = false, stopwords: words = STOPWORDS,
} = {}) {
  const raw = String(ref ?? '').trim();
  if (!raw) throw new ResolveError(`Missing ${label}.`);
  const hint = typeof create === 'string' ? ` ${create}` : '';
  const options = (list) => list.map((i) => optionOf(i, getName));

  const number = numberRef(raw);
  if (number != null) {
    const found = byNumber(items, number, getName);
    if (found) return found;
    throw new ResolveError(`Nothing is #${number} (${label}). A bare number is the #id the tools show, `
      + `never part of a name: say which one, by its #id or its name.${hint}`, options(items));
  }

  const scored = score(items, raw, { getName, stopwords: words });
  if (!scored.length) {
    if (create) return null;
    throw new ResolveError(`Can't find ${label} "${raw}".`, items.map(getName));
  }
  const best = scored[0];
  const tied = scored.filter((s) => s.points === best.points);
  if (tied.length > 1 && (strict || create || best.points < 95)) {
    throw new ResolveError(`"${raw}" is ambiguous: several match (${label}). Say which one, by its name or its #id.${isClear(best) ? '' : hint}`,
      options(tied.map((s) => s.item)));
  }
  if ((strict || create) && !isClear(best)) {
    throw new ResolveError(`Nothing is clearly "${raw}" (${label}). Is it one of these? `
      + `Say which one, by its name or its #id.${hint}`, options(scored.slice(0, 8).map((s) => s.item)));
  }
  return best.item;
}
