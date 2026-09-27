# suite-core

Code shared by the self-hosted apps of the Cronum Studio suite (Next, Tasks, Projects, Focus).
Each app is independent and can be installed on its own, but they all sign people in and
connect AI clients the same way; that shared part lives here, once.

- **Zero dependencies.** Plain Node 24 (`node:crypto`, `node:dns`, `node:net`) and native ES
  modules, like the apps. No build.
- **No app code.** Nothing here imports from an app. Whatever is the app's own —its database,
  users, sessions, texts, page layout— is passed in when a module is created.
- **Included as a git submodule** in each app, usually at `server/suite/`.

## Modules

| File | What it does |
| --- | --- |
| `oauth.js` | Built-in OAuth 2.1 authorization server for an app's MCP endpoint, so Claude or ChatGPT connect by pasting the URL |
| `workos.js` | WorkOS AuthKit client: web sign-in with PKCE, sign-out, and verification of the JWTs AuthKit issues for the MCP |
| `workos-accounts.js` | Accounts with WorkOS: the `/auth/login` and `/auth/callback` routes, the MCP metadata, and how a WorkOS account becomes a user of the app |

## Using it in an app

### Add it

```bash
git submodule add https://github.com/cronumstudio/suite-core.git server/suite
git -C server/suite checkout v0.1.0
git add .gitmodules server/suite
```

Whoever clones the app needs `git clone --recursive`, or `git submodule update --init` after
cloning. GitHub's *Download ZIP* does not include submodules. In CI, `actions/checkout` needs
`submodules: true`. On a server that deploys with `git pull`, set
`git config submodule.recurse true` once, so pulls update it too.

### Update it

```bash
git -C server/suite fetch --tags
git -C server/suite checkout v0.2.0
git add server/suite
git commit -m "Suite: update suite-core to v0.2.0"
```

Then run the app's own tests.

### Change it

Changes are made here, never inside an app's copy. From an app, `server/suite` is a checkout of
this repository: edit, test (`npm test` here), commit and push from inside it, tag a version,
and then commit the new pointer in the app. Every other app picks the change up with the update
steps above.

## `oauth.js`

```js
import { OAUTH_SCHEMA, createOAuthServer } from './suite/oauth.js';

db.exec(OAUTH_SCHEMA);  // three tables, idempotent

export const oauth = createOAuthServer({
  baseUrl: process.env.BASE_URL,        // public URL: the issuer; BASE_URL/mcp is the resource
  appName: 'Next',
  enabled: process.env.MCP_OAUTH !== 'off',
  db: { all, get, run },                // run() returns { changes, lastInsertRowid }
  users: {
    login(username, password),          // → user | null
    fromRequest(req),                   // user of the browser session, or null
    byId(id),                           // → user | null
    handle(user),                       // how the consent screen names them, e.g. "@martin"
  },
  sessions: {
    open(res, userId),                  // opens a browser session (sets the cookie)
    tokenFrom(req),                     // the session token of the request, or null
    sign(value),                        // keyed signature, for the consent CSRF
  },
  limits: {
    checkLogin(req, name), loginFailed(req, name), loginSucceeded(req, name),
    allowRegistration(req),             // → { allowed, retryAfter? } for dynamic registration
  },
  texts: (req, user) => ({ lang, t }),  // t(key, vars) with {placeholders}
  page: ({ lang, title, body }) => html,
});
```

Then, in the app:

- `await oauth.handle(req, res, url)` in the HTTP server, before anything else that could answer
  `/oauth/…` or `/.well-known/…`. It returns `false` for paths that aren't its own.
- On the MCP endpoint: `oauth.userFromAccessToken(token)` for the user of a token, and a `401`
  with `WWW-Authenticate: oauth.challenge(hadToken)` when there is none.
- In the app's settings: `oauth.grantsOf(userId)` and `oauth.revokeGrant(grantId, userId)`.
- `oauth.forgetUser(userId)` when an account is deleted, and `oauth.purge()` every hour.

The consent and error screens use these text keys, which the app provides in every language:
`oauth.connectTitle`, `wants`, `unverified`, `returnTo`, `loopback`, `signedInAs`, `username`,
`password`, `allow`, `signInAndAllow`, `cancel`, `cannotConnect`, `goBack`, `badCredentials`,
`tooManyAttempts` and `oauth.error.<code>` for every code of `OAuthScreenError`. Their markup
uses the classes `oauth__text`, `oauth__note`, `oauth__warning`, `oauth__error`,
`oauth__form`, `oauth__actions`, `field`, `btn` and `btn--primary`.

What it implements and why is explained at the top of `oauth.js`.

## `workos.js` and `workos-accounts.js`

For a hosted service, people sign up and sign in on WorkOS AuthKit (sign-up, 2FA, Google,
recovery) and AuthKit is also the authorization server for the MCP. The app keeps its session
cookie and a `users` row per person, with the WorkOS id next to it.

```js
import { createWorkosClient, workosConfigFromEnv, WorkosUnavailable } from './suite/workos.js';
import { createWorkosAccounts } from './suite/workos-accounts.js';

const config = workosConfigFromEnv();   // AUTH_PROVIDER, WORKOS_API_KEY, WORKOS_CLIENT_ID,
                                        // WORKOS_AUTHKIT_DOMAIN, WORKOS_MCP_AUDIENCE, WORKOS_API_URL
const workos = createWorkosClient(config);
if (config.enabled && workos.missingConfig().length) process.exit(1);   // say which ones

const accounts = createWorkosAccounts({
  baseUrl: process.env.BASE_URL,
  appName: 'Next',
  workos,
  adminEmail: process.env.ADMIN_EMAIL,  // this verified email administers
  secureCookies: true,
  stateCookie: 'next_auth',             // holds state and PKCE verifier, Path=/auth
  users: {
    byWorkosId(id), unlinkedByEmail(email), firstUnlinkedAdmin(),   // → user | null
    link(userId, { workosId, email }), setEmail(userId, email),
    usernameTaken(name),                                             // → boolean
    create({ username, displayName, role, email, workosId }),        // → user
  },
  sessions: { open(res, userId, { workosSessionId }) },
});
```

Then, in the app:

- `await accounts.handle(req, res, url)` before other routes: `/auth/login` (`?signup=1` for
  the sign-up screen), `/auth/callback` and the `/.well-known/…` metadata. A failed return goes
  to `/?auth_error=failed` or `/?auth_error=unavailable`.
- On the MCP endpoint: `await accounts.userFromToken(token)` and `accounts.challenge(hadToken)`
  for the `401`. `WorkosUnavailable` means the token couldn't be checked: answer `503`, not `401`.
- On sign-out, keep the AuthKit session id stored with the app's session and send the browser to
  `accounts.signOutUrl(id)`.
- Close password sign-in and password changes while `config.enabled`.

Account policy: an existing user is linked only through a **verified** email; `adminEmail`
takes over the first admin not yet linked; anyone else gets a new account, also when their first
contact is connecting an AI client. The users table needs a unique index on the WorkOS id.

## Tests

```bash
npm test
```

Runs the whole OAuth dance against an in-memory database, with fake users and sessions, and no
app around it.

## License

Copyright (C) 2026 Cronum Studio.

Released under the GNU Affero General Public License, version 3 only (AGPL-3.0-only): see
[LICENSE](LICENSE). You may use, study, change and self-host it freely; if you offer a modified
version to other people over a network, you must make its source code available to them too.

Versions up to v0.2.0 were published under the MIT license.
