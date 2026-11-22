/**
 * The tests' web billing provider by the name they give it (BILLING_PROVIDER=remote): the suite's
 * own events signed with a shared secret (billing.js signedProvider), registered as providers.js
 * takes one. Importing this file registers it.
 */
import { registerBillingProvider } from '../providers.js';
import { signedProvider } from '../billing.js';

export const remoteBilling = registerBillingProvider({
  id: 'remote',
  fromEnv(env, { errors }) {
    if (!env.BILLING_SECRET || env.BILLING_SECRET.length < 16) {
      errors.push('BILLING_PROVIDER=remote needs BILLING_SECRET (16 characters or more)');
      return null;
    }
    return { provider: 'remote', secret: env.BILLING_SECRET, url: String(env.BILLING_URL || '').replace(/\/+$/, '') };
  },
  create: (install) => signedProvider({ id: 'remote', secret: install.secret, baseUrl: install.url }),
});
