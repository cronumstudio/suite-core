/**
 * The payment providers an install can name: BILLING_PROVIDER, the web's checkout (billing.js),
 * and STORE_BILLING, purchases in the App Store and Google Play (stores.js). The suite knows them
 * only by what is registered here, never by name, so a provider may live outside this repository:
 * the hosted suite's image registers its own before the app starts (a module given to
 * `node --import` that calls `registerBillingProvider`), and an install without it just can't
 * name it. Registering again under the same id replaces the one before.
 *
 * A web provider:
 *   {
 *     id: 'acme', name: 'Acme Pay',
 *     fromEnv(env, { baseUrl, errors, warnings }) → the install's billing ({ provider: id, … }) or null,
 *         reading only its own variables; what is wrong goes to `errors`, never a secret's value
 *     create(install, { products, rules, log }) → the adapter billing.js describes
 *     environment?(install) → 'sandbox' | 'production', the side kept of a price given per environment
 *     priceId?: { pattern, name }   what its price ids look like, checked at the start
 *     rules?: { keys: ['acmeAccounts'], read(given, install, errors) → rules of its own }
 *         settings of suite.config.js `billing` that only it reads; `install` is the install's
 *         billing, whichever provider it is, or null
 *     honors?: ['app', 'strictPrices']   the suite's own `billing` settings that only it applies
 *     catalog?(appId) → { products?: { key: { price, founderPrice?, oldPrices? } }, billing?: {…} } | null
 *         the ids it sells an app's products by, and its own settings for that app, kept with the
 *         provider instead of in the app's suite.config.js: when it is the install's provider, they
 *         count as if the app whose `app.id` it is given had written them (config.js)
 *   }
 * A store provider:
 *   { id, fromEnv(env, { errors }) → the install's stores ({ provider: id, … }) or null,
 *     create(install, { products, log }) → the adapter stores.js describes }
 *
 * This copy registers `stripe` and `remote` (the hosted suite's accounts service), and no store
 * provider. The hosted suite registers its own (Paddle, RevenueCat) from a private repository.
 */
import { signedProvider } from './billing.js';
import { stripeBilling } from './stripe.js';

const web = new Map();
const stores = new Map();

function checked(kind, provider) {
  if (!provider || typeof provider.id !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(provider.id)) {
    throw new Error(`${kind}: an id of lowercase letters, digits and -`);
  }
  for (const name of ['fromEnv', 'create']) {
    if (typeof provider[name] !== 'function') throw new Error(`${kind} "${provider.id}": ${name}() is missing`);
  }
  return Object.freeze({ ...provider });
}

/** Adds a provider BILLING_PROVIDER may name. */
export function registerBillingProvider(provider) {
  const def = checked('registerBillingProvider', provider);
  web.set(def.id, def);
  return def;
}

/** Adds a provider STORE_BILLING may name. */
export function registerStoreProvider(provider) {
  const def = checked('registerStoreProvider', provider);
  stores.set(def.id, def);
  return def;
}

export const billingProviderOf = (id) => web.get(id) ?? null;
export const storeProviderOf = (id) => stores.get(id) ?? null;
export const billingProviders = () => [...web.values()];
export const storeProviders = () => [...stores.values()];

/** The private accounts service of the hosted suite: checkouts and events signed with a shared secret. */
export const remoteBilling = Object.freeze({
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

registerBillingProvider(stripeBilling);
registerBillingProvider(remoteBilling);
