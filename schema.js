/**
 * The suite's own tables, as numbered migrations under the scope `suite`.
 *
 * An app runs its own migrations first and then these:
 *
 *   migrate(database, APP_MIGRATIONS, { scope: 'app' });
 *   migrate(database, SUITE_MIGRATIONS, { scope: 'suite' });
 *
 * so that each step here finds the tables the app already had and brings them
 * to the suite's shape, instead of creating them next to the old ones. On a new
 * database they create the tables whole.
 */
import { sessionsSchema } from './sessions.js';
import { rateLimitSchema } from './rate-limit.js';
import { entitlementsSchema } from './entitlements.js';

export const SUITE_MIGRATIONS = Object.freeze([
  { version: 1, name: 'sessions', up: sessionsSchema },
  { version: 2, name: 'login-attempts', up: rateLimitSchema },
  { version: 3, name: 'entitlement-grants', up: entitlementsSchema },
]);
