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
 *
 * Every table is created whether the app uses its module or not (an app without
 * organizations just leaves theirs empty): switching a module on later is then
 * a setting, never a migration.
 */
import { sessionsSchema } from './sessions.js';
import { rateLimitSchema } from './rate-limit.js';
import { entitlementsSchema } from './entitlements.js';
import { usersSchema, identitiesSchema } from './accounts.js';
import { organizationsSchema } from './organizations.js';
import { auditSchema } from './audit.js';
import { tokensSchema } from './tokens.js';
import { billingSchema } from './billing.js';
import { OAUTH_SCHEMA } from './oauth.js';
import { accountTokensSchema } from './account-mail.js';
import { twoFactorSchema } from './two-factor.js';
import { pushSchema } from './push.js';
import { dataImportsSchema } from './portability.js';
import { idempotencySchema } from './idempotency.js';
import { connectionsSchema, connectionConsentsSchema } from './workos-accounts.js';

export const SUITE_MIGRATIONS = Object.freeze([
  { version: 1, name: 'sessions', up: sessionsSchema },
  { version: 2, name: 'login-attempts', up: rateLimitSchema },
  { version: 3, name: 'entitlement-grants', up: entitlementsSchema },
  { version: 4, name: 'users', up: usersSchema },
  { version: 5, name: 'organizations', up: organizationsSchema },
  // After organizations: its entries point at them.
  { version: 6, name: 'audit-log', up: auditSchema },
  { version: 7, name: 'user-identities', up: identitiesSchema },
  { version: 8, name: 'api-tokens', up: tokensSchema },
  { version: 9, name: 'billing', up: billingSchema },
  // The built-in OAuth's tables; Next and Tasks had them in their own baseline already.
  { version: 10, name: 'oauth', up: (d) => d.exec(OAUTH_SCHEMA) },
  { version: 11, name: 'account-tokens', up: accountTokensSchema },
  { version: 12, name: 'two-factor', up: twoFactorSchema },
  // Tasks' table as it was: its subscriptions (people's phones) keep working.
  { version: 13, name: 'push-subscriptions', up: pushSchema },
  // Copies imported here, so none is applied twice (portability.js).
  { version: 14, name: 'data-imports', up: dataImportsSchema },
  // Writes sent twice by the web kit's outbox answer once (idempotency.js).
  { version: 15, name: 'idempotency-keys', up: idempotencySchema },
  // The AI clients that come with an AuthKit token: last use, and disconnected here (workos-accounts.js).
  { version: 16, name: 'idp-connections', up: connectionsSchema },
  // And the consent behind each one: Claude is one client for every app (workos-accounts.js).
  { version: 17, name: 'idp-connection-consents', up: connectionConsentsSchema },
]);
