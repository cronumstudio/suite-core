/**
 * The plans of the hosted suite, written once for every app.
 *
 * An app's plans could come from a JSON in each install's PLANS, but then the
 * same decision lives in four places, copied by hand, and an app that gains a
 * feature needs its install changed the moment it is deployed. Instead, an
 * install says `PLANS=cronum-work` and reads the catalog from here: one place,
 * versioned and tested with the code that enforces it, and ready for the day
 * the apps become one.
 *
 * Each app reads only the features it declares; the rest of a plan is ignored
 * there. The other way round is a mistake: a feature an app declares and the
 * catalog doesn't set would fall back to its default —no limit— and stops the
 * start (entitlements.js), so a new barrier always comes with its value here.
 *
 * Without PLANS nothing of this applies: a self-hosted copy has one plan with
 * every default, free and unlimited.
 */

/**
 * The features every app names the same, for an app's `features` to take from
 * (`{ ...pick(COMMON_FEATURES, ['retention.days']), … }`). Defaults are no
 * limit: what a plan doesn't restrict, it allows.
 */
export const COMMON_FEATURES = Object.freeze({
  // What was done or deleted (completed tasks, the trash, closed projects) goes after these days.
  'retention.days': { type: 'limit', default: null, label: 'keeping what is done or deleted' },
  // Photos and files a person keeps, trash included, in MB.
  'storage.mb': { type: 'limit', default: null, label: 'storage for photos and files (MB)' },
  assign: { type: 'flag', default: true, label: 'assigning work to other people' },
  publish: { type: 'flag', default: true, label: 'public read-only links' },
  templates: { type: 'flag', default: true, label: 'templates' },
  mcp: { type: 'flag', default: true, label: 'using the app from an assistant' },
  // Tool calls from assistants per person and day (UTC); listing tools and prompts doesn't count.
  'mcp.calls_per_day': { type: 'limit', default: null, label: 'calls from an assistant per day' },
});

/** The common features named, as an app's `features` wants them. */
export const pick = (features, keys) => Object.fromEntries(keys.map((key) => {
  if (!features[key]) throw new Error(`pick: "${key}" is not a common feature`);
  return [key, features[key]];
}));

const FREE = {
  // Common to every app (the note «Beneficios de cada plan», 8 Oct 2026).
  'retention.days': 90,
  'storage.mb': 50,
  assign: false,
  publish: false,
  templates: false,
  mcp: true,
  'mcp.calls_per_day': 100,
  sharing: true,
  attachments: true,
  activity: false,
  // Each app's own caps: only what a person owns and is active counts.
  'lists.max': 20,          // Tasks
  'projects.max': 10,       // Next and Projects
  'notebooks.max': 10,      // Notes
  'history.days': 7,        // Notes: earlier versions of a note
};

const PRO = {
  ...FREE,
  'retention.days': null,
  'storage.mb': 5120,
  assign: true,
  publish: true,
  templates: true,
  'mcp.calls_per_day': 1000,
  'lists.max': null,
  'projects.max': null,
  'notebooks.max': null,
  'history.days': null,
};

/** Catalogs an install can name in PLANS, each from the least to the most a plan includes. */
export const PLAN_CATALOGS = Object.freeze({
  'cronum-work': Object.freeze({
    free: Object.freeze({ name: 'Free', features: Object.freeze(FREE) }),
    pro: Object.freeze({ name: 'Pro', features: Object.freeze(PRO) }),
    // With organizations (a later phase): Pro, with 10 GB per person and the activity log.
    team: Object.freeze({ name: 'Team', features: Object.freeze({ ...PRO, 'storage.mb': 10240, activity: true }) }),
  }),
});
