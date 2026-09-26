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

const withScheme = (url) => (url && !/^https?:\/\//.test(url) ? `https://${url}` : url);
const noSlash = (url) => String(url || '').replace(/\/+$/, '');

/** WorkOS doesn't answer, or answers badly: not the fault of whoever asks. */
export class WorkosUnavailable extends Error {}

const TIMEOUT_MS = 8000;              // Claude gives up at 10 s: better to fail first
const KEYS_TTL_MS = 3600 * 1000;
const KEYS_RETRY_MS = 5 * 60 * 1000;
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
      throw new WorkosUnavailable(`WorkOS does not answer (${err.message})`);
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

  /* ----------------------------- MCP tokens ----------------------------- */

  /** What a JWT says, without checking its signature. Only for what already comes from WorkOS. */
  function claims(jwt) {
    try {
      return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }

  /**
   * AuthKit's public keys, by `kid`. Kept an hour; an unknown key forces a new
   * fetch —that is how a rotation is picked up— but at most every five
   * minutes, so a made-up token can't be used to hammer WorkOS through here.
   */
  const keys = { byKid: new Map(), at: 0, loading: null };

  async function loadKeys() {
    const { ok, status, body } = await request(`${AUTHKIT}/oauth2/jwks`);
    if (!ok || !Array.isArray(body?.keys)) throw new WorkosUnavailable(`AuthKit JWKS: ${status}`);
    const byKid = new Map();
    for (const jwk of body.keys) {
      if (jwk.kty !== 'RSA' || !jwk.kid || (jwk.use && jwk.use !== 'sig')) continue;
      try { byKid.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch { /* odd key: out */ }
    }
    keys.byKid = byKid;
    keys.at = Date.now();
  }

  async function keyFor(kid) {
    const age = Date.now() - keys.at;
    if (keys.byKid.has(kid) && age < KEYS_TTL_MS) return keys.byKid.get(kid);
    if (keys.at && age < KEYS_RETRY_MS) return keys.byKid.get(kid) || null;
    keys.loading ??= loadKeys().finally(() => { keys.loading = null; });
    await keys.loading;
    return keys.byKid.get(kid) || null;
  }

  /**
   * Checks an access token issued by AuthKit for the MCP.
   * @returns {object|null} its claims if valid; null if not.
   * @throws {WorkosUnavailable} if the keys can't be fetched.
   */
  async function verifyToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    let header;
    let data;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      data = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    // RS256 only: neither `none`, nor HS256 with the public key as the secret.
    if (header?.alg !== 'RS256' || !header.kid) return null;
    const key = await keyFor(header.kid);
    if (!key) return null;
    const valid = crypto.verify(
      'RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'),
    );
    if (!valid) return null;

    const now = Math.floor(Date.now() / 1000);
    if (noSlash(data.iss) !== AUTHKIT) return null;
    if (typeof data.exp !== 'number' || data.exp < now - CLOCK_SKEW_S) return null;
    if (typeof data.nbf === 'number' && data.nbf > now + CLOCK_SKEW_S) return null;
    if (mcpAudience && ![].concat(data.aud ?? []).includes(mcpAudience)) return null;
    if (!data.sub) return null;
    return data;
  }

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
    if (asMetadata.value && Date.now() - asMetadata.at < KEYS_TTL_MS) return asMetadata.value;
    const { ok, status, body } = await request(`${AUTHKIT}/.well-known/oauth-authorization-server`);
    if (!ok || !body?.issuer) throw new WorkosUnavailable(`AuthKit metadata: ${status}`);
    asMetadata = { value: body, at: Date.now() };
    return body;
  }

  return {
    authkitDomain: AUTHKIT,
    missingConfig, pkcePair, signInUrl, exchangeCode, signOutUrl, account,
    verifyToken, resourceMetadata, authorizationServerMetadata,
  };
}
