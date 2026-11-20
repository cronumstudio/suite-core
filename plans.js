/**
 * The plans of the hosted suite, written once for every app.
 *
 * An app's plans could come from a JSON in each install's PLANS, but then the
 * same decision lives in four places, copied by hand, and an app that gains a
 * feature needs its install changed the moment it is deployed. Instead, an
 * install says `PLANS=cronum-work` and reads the catalog from here: one place,
 * versioned and tested with the code that enforces it, and ready for the day
 * the apps become one. An app outside Cronum Work's subscription names another
 * catalog instead (`PLANS=cronum-per-group`, `PLANS=cronum-per-seat`, below,
 * named after how their plans are held), so the plans of one are read in no
 * other's installs. What a plan costs lives with the payment provider and the
 * stores, never here.
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
  // A public page embedded in another site (an <iframe>), without the Cronum Work mark.
  embed: { type: 'flag', default: true, label: 'embedding public pages in other websites' },
  templates: { type: 'flag', default: true, label: 'templates' },
  mcp: { type: 'flag', default: true, label: 'using the app from an assistant' },
  // Tool calls from assistants per person and day (UTC); listing tools and prompts doesn't count.
  'mcp.calls_per_day': { type: 'limit', default: null, label: 'calls from an assistant per day' },
  // The same calls per person and week, from Monday (UTC): an app declares this one or the daily one.
  'mcp.calls_per_week': { type: 'limit', default: null, label: 'calls from an assistant per week' },
  // A host's calendar in the person's own calendar app, by a secret link (calendar-feed.js): the host declares it.
  'calendar.feed': { type: 'flag', default: true, label: 'the calendar in Google Calendar, Outlook or Apple Calendar' },
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
  // A public page of a project, a note or a list (Next, Projects, Notes, Tasks), with its own link;
  // putting it in another website is Pro's.
  publish: true,
  embed: false,
  templates: false,
  mcp: true,
  // Cronum Work's calendar in Google Calendar, Outlook or Apple Calendar: Pro's (Martin, 12 Nov 2026).
  'calendar.feed': false,
  'mcp.calls_per_day': 100,
  // What Cronum Work declares since 0.203.0: a week evens out a busy day, and a daily 100 was
  // more than almost anyone uses, so nobody needed Pro for it.
  'mcp.calls_per_week': 100,
  sharing: true,
  attachments: true,
  activity: false,
  // Each app's own caps: only what a person owns and is active counts.
  'lists.max': 20,          // Tasks
  'projects.max': 10,       // Next and Projects
  'notebooks.max': 10,      // Notes
  'history.days': 7,        // Notes: earlier versions of a note
  'files.per_note': 10,     // Notes: pictures and PDFs in one note, counted for its notebook's owner
};

const PRO = {
  ...FREE,
  'retention.days': null,
  'storage.mb': 5120,
  assign: true,
  publish: true,
  embed: true,
  templates: true,
  'calendar.feed': true,
  'mcp.calls_per_day': 1000,
  'mcp.calls_per_week': 2000,
  'lists.max': null,
  'projects.max': null,
  'notebooks.max': null,
  'history.days': null,
  'files.per_note': null,
};

/*
 * `cronum-per-group`: plans that belong to a group, not to a person. The group is an organization
 * (`modules.organizations`); a plan is granted to it —bought by its owner or an admin, or a trial,
 * which is a grant with an end— and reaches every member. What acts for the group with nobody
 * behind it reads the group's own plan (`ofOrganization()`, entitlements.js). Its keys are the
 * app's own: none of the plans above gives anything there, and these give nothing elsewhere (an
 * app that declares a key the named catalog lacks doesn't start). A key means what its catalog
 * says, because an install reads only the catalog it names: `history.days` here is the app's own,
 * not a note's earlier versions as above.
 */
const PER_GROUP_FREE = {
  'routines.max': 5,
  'history.days': 7,
  'devices.per_child': 1,
  live: false,
  // 0 is a value of its own here, not "not included": read it with limit() alone, since can(),
  // require() and a tool's `feature` take 0 as "not included".
  'summary.days': 0,
  'runner.views': false,
  mcp: true,                // the assistant's connector, in every plan
  'mcp.calls_per_day': 100, // the same brake on abuse as Cronum Work's
};

const PER_GROUP_PRO = {
  ...PER_GROUP_FREE,
  'routines.max': null,
  'history.days': null,
  'devices.per_child': null,
  live: true,
  'summary.days': 14,
  'runner.views': true,
  'mcp.calls_per_day': 1000,
};

/*
 * `cronum-per-seat`: a person's plan, and an organization's paid per seat. Free is what everyone
 * has; Pro is one person's; `org` is an organization's, and the quantity granted is its seats:
 * only the roles the app names take one (`organizations.seatRoles`), its admins and viewers none.
 * Its keys are the app's own, as above.
 */
const PER_SEAT_FREE = {
  mcp: false,               // the assistant's connector: off in every plan of this catalog
  'capture.native': false,
  'links.max': 0,
  'track.days': 1,
  'viewers.max': 0,
};

const PER_SEAT_PRO = {
  ...PER_SEAT_FREE,
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
  'cronum-per-group': Object.freeze({
    // Granted to a group's organization, a plan gives each of its members what it has.
    free: Object.freeze({ name: 'Free', features: Object.freeze(PER_GROUP_FREE) }),
    pro: Object.freeze({ name: 'Pro', features: Object.freeze(PER_GROUP_PRO) }),
  }),
  'cronum-per-seat': Object.freeze({
    free: Object.freeze({ name: 'Free', features: Object.freeze(PER_SEAT_FREE) }),
    // An organization's plan reaches every member, admins and viewers too, so `org` gives each
    // person what Free gives: what the organization pays for sits on what it owns, which the app
    // checks against the organization's grant. Hence its place before Pro: someone with both is
    // shown Pro, which gives them more.
    org: Object.freeze({ name: 'Team', features: Object.freeze({ ...PER_SEAT_FREE }) }),
    pro: Object.freeze({ name: 'Pro', features: Object.freeze(PER_SEAT_PRO) }),
  }),
});
