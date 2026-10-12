/**
 * The plans of the hosted suite, written once for every app.
 *
 * An app's plans could come from a JSON in each install's PLANS, but then the
 * same decision lives in four places, copied by hand, and an app that gains a
 * feature needs its install changed the moment it is deployed. Instead, an
 * install says `PLANS=cronum-work` and reads the catalog from here: one place,
 * versioned and tested with the code that enforces it, and ready for the day
 * the apps become one. A product sold on its own has a catalog of its own
 * (`PLANS=cronum-focus`, `PLANS=cronum-tracker`), which its installs name
 * instead, so the plans of one product are read in no other's installs.
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

/*
 * Cronum Focus is a product of its own, outside Cronum Work and its subscription: its installs
 * name this catalog, so none of the plans above gives anything there, and these give nothing
 * elsewhere (an app that declares a key the named catalog lacks doesn't start). Its plans are a
 * family's, not a person's: a family is an organization (kind `family`), Pro is granted to it
 * —bought by its owner or an admin, or the 14-day trial a new family starts with, a grant with an
 * end— and reaches its adults, who are its members; a child has a profile, not an account. Pro is
 * 2.99 EUR a month or 24 a year per family; the prices live with the provider, and are here only
 * to say what each plan is. A key means what its catalog says, because an install reads only the
 * catalog it names: `history.days` is Focus's History here, and a note's earlier versions above.
 */
const FOCUS_FREE = {
  // Saved routines a family keeps; History's don't count, and creating and running them has no cap.
  'routines.max': 5,
  'history.days': 7,        // days an unsaved routine stays in History unused before it goes
  'devices.per_child': 1,   // paired devices per child profile; adults sign in on any number
  live: false,              // the live view, an adult's control of a run and remote launch
  // Days of the adult summary; 0 is the last run of each routine only, not "no summary". Read it
  // with limit() alone: can(), require() and a tool's `feature` take 0 as "not included".
  'summary.days': 0,
  'runner.views': false,    // the other runner and home views (Big clock, Bars, People first)
  mcp: true,                // the AI connector, in every plan
  'mcp.calls_per_day': 100, // the same brake on abuse as Cronum Work's
};

const FOCUS_PRO = {
  ...FOCUS_FREE,
  'routines.max': null,
  'history.days': null,
  'devices.per_child': null,
  live: true,
  'summary.days': 14,
  'runner.views': true,
  'mcp.calls_per_day': 1000,
};

/*
 * Cronum Tracker is a product of its own, outside Cronum Work and its subscription: its installs
 * name this catalog, so none of the plans above gives anything there, and these give nothing
 * elsewhere (an app that declares a key the named catalog lacks doesn't start). Free is the trips
 * without an account (on the web, and in the app while it is on screen), whose caps are the
 * install's settings, not plan keys. Pro is one person's, bought in the stores (3.99 EUR a month
 * or 34.99 a year at launch); Fleet an organization's, bought on the web per driver (3.90 EUR a
 * month or 39 a year), where a driver is a member who sends GPS for it: its seats are its drivers
 * (`organizations.seatRoles`), and admins and viewers take none. The prices live with the
 * provider and the stores; they are here only to say what each plan is.
 */
const TRACKER_FREE = {
  mcp: false,               // the assistant's connector is designed for but off in Tracker
  'capture.native': false,  // the native app sending GPS in the background
  'links.max': 0,           // lasting links, one per vehicle, that keep their address
  'track.days': 1,          // days a track is kept; never more than the install's own ceiling
  'viewers.max': 0,         // people watching someone's vehicle at once
};

const TRACKER_PRO = {
  ...TRACKER_FREE,
  'capture.native': true,
  'links.max': 1,
  'track.days': 30,
  'viewers.max': 30,
};

/** Catalogs an install can name in PLANS, each from the least to the most a plan includes. */
export const PLAN_CATALOGS = Object.freeze({
  'cronum-work': Object.freeze({
    free: Object.freeze({ name: 'Free', features: Object.freeze(FREE) }),
    pro: Object.freeze({ name: 'Pro', features: Object.freeze(PRO) }),
    // With organizations (a later phase): Pro, with 10 GB per person and the activity log.
    team: Object.freeze({ name: 'Team', features: Object.freeze({ ...PRO, 'storage.mb': 10240, activity: true }) }),
  }),
  'cronum-focus': Object.freeze({
    // Granted to a family's organization, a plan gives each of its adults what it has.
    free: Object.freeze({ name: 'Free', features: Object.freeze(FOCUS_FREE) }),
    pro: Object.freeze({ name: 'Pro', features: Object.freeze(FOCUS_PRO) }),
  }),
  'cronum-tracker': Object.freeze({
    free: Object.freeze({ name: 'Free', features: Object.freeze(TRACKER_FREE) }),
    // An organization's plan reaches every member, its admins and viewers too, so Fleet gives each
    // person what Free gives: what a fleet pays for sits on what the organization owns (its
    // vehicles' links, its drivers' capture), which the app checks against the organization's
    // grant. Hence its place before Pro: someone with both is shown Pro, which gives them more.
    org: Object.freeze({ name: 'Fleet', features: Object.freeze({ ...TRACKER_FREE }) }),
    pro: Object.freeze({ name: 'Pro', features: Object.freeze(TRACKER_PRO) }),
  }),
});
