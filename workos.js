/**
 * WorkOS AuthKit client: accounts and MCP OAuth, delegated.
 *
 * Part of the shared suite code: it imports nothing from any app and only
 * needs `fetch` and `node:crypto`. What an account becomes inside an app lives
 * in `workos-accounts.js`.
 *
 * With WorkOS an app stops storing passwords. People sign in on AuthKit's page
 * —sign-up, passwords, 2FA, recovery, "Sign in with Google"— and the app only
 * receives who they are. The same for AI clients: Claude or ChatGPT discover
 * AuthKit through the metadata the app publishes, the user gives permission
 * there, and what reaches /mcp is a JWT signed by AuthKit, checked here
 * against its public keys.
 *
 * It is the delicate part, which is why it isn't written at home: signing
 * tokens, keeping OAuth client secrets or registering Claude (CIMD/DCR) is
 * done by WorkOS. Here a signature is verified and the browser is redirected.
 */
import crypto from 'node:crypto';
import { createKeySet, decodeJwt, verifyJwt } from './jwt.js';

const withScheme = (url) => (url && !/^https?:\/\//.test(url) ? `https://${url}` : url);
const noSlash = (url) => String(url || '').replace(/\/+$/, '');
/** Why a fetch failed: "fetch failed" alone says nothing, its cause does (ECONNREFUSED, ECONNRESET…). */
const fetchFailure = (err) => [err.message, err.cause?.code || err.cause?.message].filter(Boolean).join(': ');

/** WorkOS doesn't answer, or answers badly: not the fault of whoever asks. */
export class WorkosUnavailable extends Error {}

const TIMEOUT_MS = 8000;              // Claude gives up at 10 s: better to fail first
const METADATA_TTL_MS = 3600 * 1000;  // AuthKit's metadata, copied for the clients that ask here
const CLOCK_SKEW_S = 30;              // clocks that don't tick exactly together

/** Configuration from the usual environment variables. */
export function workosConfigFromEnv(env = process.env) {
  return {
    enabled: env.AUTH_PROVIDER === 'workos',
    apiUrl: env.WORKOS_API_URL || 'https://api.workos.com',
    apiKey: env.WORKOS_API_KEY || '',
    clientId: env.WORKOS_CLIENT_ID || '',
    authkitDomain: env.WORKOS_AUTHKIT_DOMAIN || '',
    mcpAudience: env.WORKOS_MCP_AUDIENCE || '',
  };
}

/**
 * @param {object} config
 * @param {string} config.apiKey         secret key (sk_…)
 * @param {string} config.clientId       client_…
 * @param {string} config.authkitDomain  https://<something>.authkit.app, issuer of MCP tokens
 * @param {string} [config.apiUrl]
 * @param {string} [config.mcpAudience]  audience required from MCP tokens. Empty accepts any
 *   token of this AuthKit, as the official example does; with several apps on one WorkOS
 *   environment it should be set, so a token asked for one app doesn't open another.
 */
export function createWorkosClient({
  apiUrl = 'https://api.workos.com', apiKey = '', clientId = '', authkitDomain = '', mcpAudience = '',
} = {}) {
  const API_URL = noSlash(apiUrl);
  const AUTHKIT = noSlash(withScheme(authkitDomain));

  /** What is missing to start in WorkOS mode; empty if nothing. */
  const missingConfig = () => [
    ['WORKOS_API_KEY', apiKey],
    ['WORKOS_CLIENT_ID', clientId],
    ['WORKOS_AUTHKIT_DOMAIN', AUTHKIT],
  ].filter(([, value]) => !value).map(([name]) => name);

  async function request(url, options = {}) {
    let res;
    try {
      res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new WorkosUnavailable(`WorkOS does not answer (${fetchFailure(err)})`);
    }
    const body = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body };
  }

  /* ---------------------------- web sign-in ----------------------------- */

  /** PKCE pair: the verifier is kept, the challenge travels to AuthKit. */
  function pkcePair() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }

  /** Where to send the browser to sign in (or sign up, with `signUp`). */
  function signInUrl({ redirectUri, state, challenge, signUp = false }) {
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      provider: 'authkit',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (signUp) q.set('screen_hint', 'sign-up');
    return `${API_URL}/user_management/authorize?${q}`;
  }

  /**
   * Exchanges the code coming back for the user. It goes server to server and
   * with the secret, so what WorkOS answers can be trusted as it is.
   * @returns {{ account: object, sessionId: string|null }} `sessionId` is AuthKit's
   *   `sid`, needed to close the session there too.
   */
  async function exchangeCode({ code, verifier }) {
    const { ok, status, body } = await request(`${API_URL}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: apiKey,
        code,
        code_verifier: verifier,
      }),
    });
    if (!ok || !body?.user?.id) {
      if (status >= 500) throw new WorkosUnavailable(`WorkOS answered ${status}`);
      throw new Error(body?.error_description || body?.message || `WorkOS rejected the code (${status})`);
    }
    return { account: body.user, sessionId: claims(body.access_token)?.sid || null };
  }

  /** Closes the AuthKit session; WorkOS then goes to the address set in its dashboard. */
  function signOutUrl(sessionId) {
    const url = new URL('/user_management/sessions/logout', API_URL);
    url.searchParams.set('session_id', sessionId);
    return url.toString();
  }

  /** Ends an AuthKit session from here (signing someone out of a device they don't have at hand). */
  async function revokeSession(sessionId) {
    const { ok, status } = await request(`${API_URL}/user_management/sessions/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    if (!ok && status !== 404) throw new Error(`WorkOS did not revoke the session (${status})`);
  }

  /**
   * Deletes a WorkOS user (`user_…`): their sign-in, sessions and the clients
   * they authorized go with it. Gone already (404) is done too.
   */
  async function deleteUser(id) {
    const { ok, status } = await request(`${API_URL}/user_management/users/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (ok || status === 404) return;
    if (status >= 500 || status === 429) throw new WorkosUnavailable(`WorkOS answered ${status}`);
    throw new Error(`WorkOS did not delete the user (${status})`);
  }

  /** A WorkOS user by id (`user_…`), or null. */
  async function account(id) {
    const { ok, status, body } = await request(
      `${API_URL}/user_management/users/${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (ok && body?.id) return body;
    if (status >= 500) throw new WorkosUnavailable(`WorkOS answered ${status}`);
    return null;
  }

  /**
   * Whether WorkOS still has a user with that id: false only when it says so
   * (404). Any other answer is no answer, since false hands that person's
   * account to someone else.
   * @throws {WorkosUnavailable}
   */
  async function knows(id) {
    const { ok, status } = await request(
      `${API_URL}/user_management/users/${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (ok) return true;
    if (status === 404) return false;
    throw new WorkosUnavailable(`WorkOS answered ${status}`);
  }

  /* ------------------------ authorized applications ---------------------- */

  /**
   * The OAuth clients a user has authorized (Claude, ChatGPT…), every page:
   * `{ id, application_id, client_id, name, resource, scopes }` each. What AuthKit gave them
   * is a consent, not a sign-in, so it isn't among the user's sessions.
   * @throws {WorkosUnavailable}
   */
  async function authorizedApplications(userId) {
    const found = [];
    let after = null;
    // A hundred a page: ten pages is more than anyone authorizes.
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ limit: '100', ...(after ? { after } : {}) });
      const { ok, status, body } = await request(
        `${API_URL}/user_management/users/${encodeURIComponent(userId)}/authorized_applications?${q}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      if (status === 404) return found;
      if (!ok || !Array.isArray(body?.data)) throw new WorkosUnavailable(`WorkOS answered ${status}`);
      for (const item of body.data) {
        found.push({
          id: item.id,
          application_id: item.application?.id || null,
          client_id: item.application?.client_id || null,
          name: item.application?.name || null,
          resource: item.oauth_resource || null,
          scopes: item.granted_scopes || [],
        });
      }
      after = body.list_metadata?.after;
      if (!after || !body.data.length) break;
    }
    return found;
  }

  /**
   * Withdraws a user's authorization of a client (its id or client id): its
   * refresh tokens stop working; the access tokens it already has live until
   * they expire, which is why the app refuses them too (workos-accounts.js).
   */
  async function revokeApplication(userId, applicationId) {
    const { ok, status } = await request(
      `${API_URL}/user_management/users/${encodeURIComponent(userId)}/authorized_applications/${encodeURIComponent(applicationId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (ok || status === 404) return;
    if (status >= 500 || status === 429) throw new WorkosUnavailable(`WorkOS answered ${status}`);
    throw new Error(`WorkOS did not revoke the authorization (${status})`);
  }

  /* ----------------------------- MCP tokens ----------------------------- */

  /** What a JWT says, without checking its signature. Only for what already comes from WorkOS. */
  const claims = (jwt) => decodeJwt(jwt)?.payload ?? null;

  /** AuthKit's public keys (jwt.js keeps them an hour and refetches on an unknown one, at most every five minutes). */
  const keys = createKeySet({
    load: async () => {
      const { ok, status, body } = await request(`${AUTHKIT}/oauth2/jwks`);
      // An empty set is an outage too: taken as it is, every token would be refused as invalid.
      if (!ok || !Array.isArray(body?.keys) || !body.keys.length) throw new WorkosUnavailable(`AuthKit JWKS: ${status}`);
      return body.keys;
    },
    unavailable: (message) => new WorkosUnavailable(`AuthKit JWKS: ${message}`),
  });

  /**
   * Checks an access token issued by AuthKit for the MCP: RS256 with one of its
   * keys, its issuer, in date and, when set, for this app's audience.
   * @returns {object|null} its claims if valid; null if not.
   * @throws {WorkosUnavailable} if the keys can't be fetched.
   */
  const verifyToken = (token) => verifyJwt(token, {
    keys, issuer: AUTHKIT, audience: mcpAudience || null, algorithms: ['RS256'], clockSkew: CLOCK_SKEW_S,
  });

  /* ------------------------------ metadata ------------------------------ */

  /**
   * Protected resource metadata (RFC 9728): tells Claude or ChatGPT that this
   * /mcp is opened with AuthKit tokens. `resource` has to be the exact URL the
   * user pastes into the client.
   */
  const resourceMetadata = ({ resource, name }) => ({
    resource,
    authorization_servers: [AUTHKIT],
    bearer_methods_supported: ['header'],
    ...(name ? { resource_name: name } : {}),
  });

  /**
   * The authorization server metadata (RFC 8414), copied from AuthKit. Current
   * clients ask for it there; this is for those still looking for it on the
   * MCP server itself.
   */
  let asMetadata = { value: null, at: 0 };
  async function authorizationServerMetadata() {
    if (asMetadata.value && Date.now() - asMetadata.at < METADATA_TTL_MS) return asMetadata.value;
    const { ok, status, body } = await request(`${AUTHKIT}/.well-known/oauth-authorization-server`);
    if (!ok || !body?.issuer) throw new WorkosUnavailable(`AuthKit metadata: ${status}`);
    asMetadata = { value: body, at: Date.now() };
    return body;
  }

  return {
    authkitDomain: AUTHKIT,
    missingConfig, pkcePair, signInUrl, exchangeCode, signOutUrl, revokeSession, deleteUser, account, knows,
    authorizedApplications, revokeApplication, verifyToken, resourceMetadata, authorizationServerMetadata,
  };
}
