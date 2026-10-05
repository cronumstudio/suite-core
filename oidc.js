/**
 * Signing in with any OpenID Connect provider (AUTH_PROVIDER=oidc):
 * Authentik, Keycloak, Zitadel, Google, Microsoft Entra… One account for
 * every app of the suite installed side by side, without passwords of their
 * own, 2FA and recovery included — whatever the provider offers.
 *
 * The browser goes to the provider with PKCE (S256), a state and a nonce, and
 * comes back to /auth/callback. The code is exchanged server to server, and
 * the ID token is checked against the provider's published keys (jwt.js):
 * issuer, audience (this client), dates and the nonce of this very sign-in.
 * The person then becomes an account through the suite's identities
 * (accounts.fromIdentity): linked by a verified email to the account they
 * had, the admin email taking over the first administrator, or a new one.
 *
 * AI clients keep using the app's built-in OAuth, whose consent screen sends
 * whoever isn't signed in to the provider and back.
 */
import crypto from 'node:crypto';
import { createKeySet, verifyJwt } from './jwt.js';

const TIMEOUT_MS = 8000;
const DISCOVERY_TTL_MS = 3600 * 1000;

/** The provider doesn't answer: signing in can't be completed right now. */
export class OidcUnavailable extends Error {}

export function oidcConfigFromEnv(env = process.env) {
  return {
    enabled: env.AUTH_PROVIDER === 'oidc',
    issuer: String(env.OIDC_ISSUER || '').replace(/\/+$/, ''),
    clientId: env.OIDC_CLIENT_ID || '',
    clientSecret: env.OIDC_CLIENT_SECRET || '',
    scopes: env.OIDC_SCOPES || 'openid email profile',
    // How the sign-in button names it: "Sign in with Authentik".
    name: env.OIDC_NAME || 'OpenID Connect',
  };
}

const noSlash = (value) => String(value || '').replace(/\/+$/, '');
/** Why a fetch failed: "fetch failed" alone says nothing, its cause does (ECONNREFUSED, ECONNRESET…). */
const fetchFailure = (err) => [err.message, err.cause?.code || err.cause?.message].filter(Boolean).join(': ');

/**
 * @param {object} config
 * @param {string} config.issuer        e.g. https://auth.example.com/application/o/next
 * @param {string} config.clientId
 * @param {string} [config.clientSecret] empty for a public client (PKCE only)
 * @param {string} [config.scopes]
 */
export function createOidcClient({
  issuer, clientId, clientSecret = '', scopes = 'openid email profile', name = 'OpenID Connect',
  clock = () => Date.now(),
}) {
  const ISSUER = noSlash(issuer);

  async function request(url, options = {}) {
    let res;
    try {
      res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new OidcUnavailable(`${name} does not answer (${fetchFailure(err)})`);
    }
    const body = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body };
  }

  /** The provider's discovery document, kept an hour. Its issuer must be the one configured. */
  let discovery = { doc: null, at: 0 };
  async function metadata() {
    if (discovery.doc && clock() - discovery.at < DISCOVERY_TTL_MS) return discovery.doc;
    const { ok, status, body } = await request(`${ISSUER}/.well-known/openid-configuration`);
    if (!ok || !body?.authorization_endpoint || !body.token_endpoint || !body.jwks_uri) {
      throw new OidcUnavailable(`${name}: no discovery document (${status})`);
    }
    if (noSlash(body.issuer) !== ISSUER) throw new Error(`${name}: the discovery document is for another issuer (${body.issuer})`);
    discovery = { doc: body, at: clock() };
    return body;
  }

  const keys = createKeySet({
    load: async () => {
      const { jwks_uri: uri } = await metadata();
      const { ok, status, body } = await request(uri);
      if (!ok || !Array.isArray(body?.keys) || !body.keys.length) throw new OidcUnavailable(`${name} JWKS: ${status}`);
      return body.keys;
    },
    unavailable: (message) => new OidcUnavailable(`${name} JWKS: ${message}`),
    clock,
  });

  /** PKCE pair: the verifier is kept, the challenge travels to the provider. */
  function pkcePair() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
  }

  /** Where to send the browser to sign in. */
  async function authorizationUrl({ redirectUri, state, challenge, nonce }) {
    const { authorization_endpoint: endpoint } = await metadata();
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: scopes,
      state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
    })) url.searchParams.set(key, value);
    return url.toString();
  }

  /**
   * Exchanges the code for the person: the ID token's claims, checked, plus
   * what the userinfo endpoint adds when the token says little (some providers
   * leave the email out of it).
   */
  async function exchangeCode({ code, verifier, redirectUri, nonce }) {
    const doc = await metadata();
    const form = new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier,
    });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (clientSecret) {
      const methods = doc.token_endpoint_auth_methods_supported || ['client_secret_basic'];
      if (methods.includes('client_secret_post') && !methods.includes('client_secret_basic')) {
        form.set('client_secret', clientSecret);
      } else {
        const pair = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
        headers.Authorization = `Basic ${Buffer.from(pair).toString('base64')}`;
      }
    }
    const { ok, status, body } = await request(doc.token_endpoint, { method: 'POST', headers, body: form.toString() });
    if (!ok || !body?.id_token) {
      if (status >= 500) throw new OidcUnavailable(`${name} answered ${status}`);
      throw new Error(body?.error_description || body?.error || `${name} rejected the code (${status})`);
    }
    const claims = await verifyJwt(body.id_token, { keys, issuer: ISSUER, audience: clientId, nonce, clock });
    if (!claims) throw new Error(`${name}: the ID token is not valid`);
    if (!claims.email && doc.userinfo_endpoint && body.access_token) {
      const info = await request(doc.userinfo_endpoint, { headers: { Authorization: `Bearer ${body.access_token}` } });
      if (info.ok && info.body?.sub === claims.sub) {
        for (const key of ['email', 'email_verified', 'name', 'preferred_username']) {
          if (claims[key] === undefined && info.body[key] !== undefined) claims[key] = info.body[key];
        }
      }
    }
    return claims;
  }

  /** The provider's sign-out, back to `postLogoutRedirectUri`; null when it has none. */
  async function signOutUrl({ postLogoutRedirectUri }) {
    let doc;
    try { doc = await metadata(); } catch { return null; }
    if (!doc.end_session_endpoint) return null;
    const url = new URL(doc.end_session_endpoint);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
    return url.toString();
  }

  const missingConfig = () => [['OIDC_ISSUER', ISSUER], ['OIDC_CLIENT_ID', clientId]]
    .filter(([, value]) => !value).map(([key]) => key);

  return { name, issuer: ISSUER, metadata, pkcePair, authorizationUrl, exchangeCode, signOutUrl, missingConfig };
}

/**
 * The /auth routes of OIDC and how the person becomes an account.
 *
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {object} options.oidc         from createOidcClient()
 * @param {object} options.accounts     from createAccounts(): fromIdentity() does the rest
 * @param {string} [options.adminEmail] whoever signs in with this verified email administers
 * @param {object} options.sessions     open(res, userId, { idpSessionId, req }) opens the app's session
 */
export function createOidcAccounts({
  baseUrl, oidc, accounts, adminEmail = '', sessions, secureCookies = false, stateCookie = 'suite_oidc',
  log = console.log,
}) {
  const BASE_URL = noSlash(baseUrl);
  const REDIRECT = `${BASE_URL}/auth/callback`;
  // One provider per issuer: moving to another one links people again by their email.
  const PROVIDER = `oidc:${new URL(oidc.issuer || 'https://unset').host}`;

  const cookieHeader = (value, maxAge) => [
    `${stateCookie}=${encodeURIComponent(value)}`, `Max-Age=${maxAge}`, 'Path=/auth',
    'HttpOnly', 'SameSite=Lax', ...(secureCookies ? ['Secure'] : []),
  ].join('; ');
  const addCookie = (res, cookie) => {
    const previous = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', previous == null ? cookie : [].concat(previous, cookie));
  };
  const cookieValue = (req) => {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === stateCookie) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  };
  const redirect = (res, target) => {
    res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
    res.end();
  };
  const same = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  /** Only a path of this app: never another site, whatever the link says. */
  const localPath = (value) => (typeof value === 'string' && /^\/(?!\/)[^\\\s]*$/.test(value) ? value : '/');

  async function handle(req, res, url) {
    if (url.pathname === '/auth/login') {
      try {
        const { verifier, challenge } = oidc.pkcePair();
        const state = crypto.randomBytes(16).toString('base64url');
        const nonce = crypto.randomBytes(16).toString('base64url');
        const back = Buffer.from(localPath(url.searchParams.get('return'))).toString('base64url');
        addCookie(res, cookieHeader([state, verifier, nonce, back].join('.'), 600));
        redirect(res, await oidc.authorizationUrl({ redirectUri: REDIRECT, state, challenge, nonce }));
      } catch (err) {
        log(`[oidc] sign-in could not start: ${err.message}`);
        redirect(res, `/?auth_error=${err instanceof OidcUnavailable ? 'unavailable' : 'failed'}`);
      }
      return true;
    }

    if (url.pathname === '/auth/callback') {
      const [state, verifier, nonce, back] = String(cookieValue(req) || '').split('.');
      addCookie(res, cookieHeader('', 0));
      const code = url.searchParams.get('code');
      // Without a state matching the cookie's, this return wasn't started by
      // this browser: it could be someone slipping their own account into it.
      if (url.searchParams.get('error') || !code || !state || !verifier || !nonce
        || !same(state, url.searchParams.get('state') || '')) {
        redirect(res, '/?auth_error=failed');
        return true;
      }
      try {
        const claims = await oidc.exchangeCode({ code, verifier, redirectUri: REDIRECT, nonce });
        const user = accounts.fromIdentity({
          provider: PROVIDER, subject: claims.sub, email: claims.email ?? null,
          emailVerified: claims.email_verified === true || claims.email_verified === 'true',
          displayName: claims.name ?? null, username: claims.preferred_username ?? null,
        }, { adminEmail });
        // An account the admin disabled stays out, whatever the provider says.
        if (user.disabled_at) {
          log(`[oidc] user #${user.id} is disabled: not signed in`);
          redirect(res, '/?auth_error=disabled');
          return true;
        }
        sessions.open(res, user.id, { idpSessionId: `oidc:${claims.sid || '-'}`, req });
        redirect(res, localPath(Buffer.from(back || '', 'base64url').toString('utf8') || '/'));
      } catch (err) {
        log(`[oidc] sign-in could not be completed: ${err.message}`);
        redirect(res, `/?auth_error=${err instanceof OidcUnavailable ? 'unavailable' : 'failed'}`);
      }
      return true;
    }
    return false;
  }

  return {
    id: 'oidc',
    name: oidc.name,
    provider: PROVIDER,
    handle,
    /** Where signing out also closes the provider's session, when it offers one. */
    signOutUrl: () => oidc.signOutUrl({ postLogoutRedirectUri: `${BASE_URL}/` }),
    /** For the built-in OAuth's consent screen: sign in here and come back. */
    signInUrl: (returnTo) => `/auth/login?return=${encodeURIComponent(localPath(returnTo))}`,
  };
}
