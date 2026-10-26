/**
 * The suite's test kit: what every app's tests need to start a server of its own and talk to it,
 * in one place instead of a copy in each smoke test that drifts from the others (audit tests-4).
 * Plain Node, nothing to install; it imports nothing else of the suite but its two fakes.
 *
 *   import { createHarness, startApp, client, mcp } from '../server/suite/tools/test-kit.mjs';
 *
 *   const { check, section, fail, finish } = createHarness();
 *   const app = await startApp(path.join(ROOT, 'server', 'index.js'), { prefix: 'tasks-test-', env: { ADMIN_USER: 'admin', … } });
 *   try {
 *     if (app.down) throw new Error(`The server did not start: ${app.down}\n${app.log}`);
 *     section('1. Authentication');
 *     const admin = client(app.base, { cookieName: 'tasks_sid' });
 *     check('Signs in', (await admin('POST', '/api/auth/login', { … })).status === 200);
 *   } catch (err) { fail(err); } finally { await finish({ log: app.log, root: ROOT, cleanup: app.stop }); }
 *
 * The same pieces serve `node --test` files: one server per file (`startApp`, `stop` in
 * `t.after`), and `createHarness().assertPassed()` at the end of a test that uses `check`.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export { fakeRevenueCat, webhook as revenueCatWebhook, subscription as revenueCatSubscription } from '../test/fake-revenuecat.js';
export { installFakeDom, FakeElement, FakeEventTarget } from '../test/fake-dom.js';

/** How long one request may take before the test says which one hung, instead of CI's own timeout. */
export const REQUEST_MS = 15000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------- ports ---------------------------------- */

/**
 * Ports for the servers a test starts, chosen by the OS. A random port in a fixed range used to
 * land, now and then, on one fetch() refuses outright (the Fetch standard's "bad ports": 4045,
 * 4190, 5060…), or on one another run had: the server listened, every request failed, and the
 * check waited out its 30 s. The OS hands out ephemeral ports, free and above those (all at or
 * below 10080). The probes stay open until all n are chosen, so one call never gives the same
 * port twice.
 */
export async function freePorts(n) {
  const probes = [];
  try {
    while (probes.length < n) {
      const probe = net.createServer();
      await new Promise((resolve, reject) => probe.once('error', reject).listen(0, resolve));
      if (probe.address().port > 10080) probes.push(probe);
      else probe.close();
    }
    return probes.map((probe) => probe.address().port);
  } finally {
    await Promise.all(probes.map((probe) => new Promise((resolve) => probe.close(resolve))));
  }
}

export async function freePort() { return (await freePorts(1))[0]; }

/* --------------------------------- servers --------------------------------- */

const exited = (child) => Boolean(child) && (child.exitCode !== null || child.signalCode !== null);

/**
 * Waits until a server answers `/health`. It polls until a deadline rather than a fixed number of
 * tries: a busy CI runner can take several seconds just to apply the migrations. Each request has
 * its own short timeout, so one that hangs cannot use up the budget, and if `child` (the spawned
 * process, optional) exits first it stops right away instead of waiting out the clock.
 *
 * → '' once the server is up, or why it is not (for a check's detail, next to the server's log).
 */
export async function waitForHealth(base, child = null, { timeoutMs = 30000, everyMs = 150, requestMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // What the last try got, so a timeout says why ("bad port", ECONNREFUSED, a 503…).
  let last = 'nothing';
  while (Date.now() < deadline) {
    if (exited(child)) break;
    try {
      const signal = AbortSignal.timeout(Math.max(Math.min(requestMs, deadline - Date.now()), 1));
      const res = await fetch(`${base}/health`, { signal });
      if (res.ok) return '';
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.cause?.message || err.cause?.code || err.message;
    }
    await sleep(everyMs);
  }
  if (exited(child)) {
    return `the server exited (${child.exitCode !== null ? `code ${child.exitCode}` : child.signalCode}) before answering ${base}/health`;
  }
  return `no answer from ${base}/health within ${timeoutMs / 1000} s (last try: ${last})`;
}

/**
 * Starts a server as an install starts it: `node <entry>` with a temporary DATA_DIR, a port of
 * its own, BASE_URL at that port, cookies without `Secure` and no file watcher. `env` goes on top
 * (a value of `undefined` removes that variable). Doesn't wait: `ready()` does, or use startApp.
 *
 * → { child, port, base, dataDir, log, ready(options), stop() }. `stop()` kills the process,
 * waits until it is gone (Windows keeps the database open until then) and deletes the DATA_DIR it
 * made; one passed in as `dataDir` is the caller's, and stays (to start again on the same data).
 */
export async function startServer(entry, { env = {}, dataDir = null, prefix = 'suite-test-', port = null, args = [], cwd } = {}) {
  const own = !dataDir;
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const at = port ?? await freePort();
  const base = `http://127.0.0.1:${at}`;
  const merged = {
    ...process.env, DATA_DIR: dir, PORT: String(at), BASE_URL: base, SECURE_COOKIES: 'false', HOT_RELOAD: 'false', ...env,
  };
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
  const child = spawn(process.execPath, [...args, entry], { env: merged, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  let stopping = null;
  const stop = () => (stopping ||= (async () => {
    if (!exited(child)) {
      const gone = once(child, 'exit');
      child.kill();
      await gone;
    }
    if (own) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  })());
  return {
    child, port: at, base, dataDir: dir,
    get log() { return log; },
    ready: (options) => waitForHealth(base, child, options),
    stop,
    [Symbol.asyncDispose]: stop,
  };
}

/** startServer, then waits for /health: `down` is '' when it answers, or why it doesn't. */
export async function startApp(entry, options = {}) {
  const app = await startServer(entry, options);
  app.down = await app.ready(options.health);
  return app;
}

/* ---------------------------------- clients -------------------------------- */

/** fetch with a deadline that names the request when it passes, instead of hanging the run. */
async function timed(method, url, init, timeoutMs) {
  try {
    return await fetch(url, { ...init, method, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new Error(`${method} ${url}: no answer within ${timeoutMs / 1000} s`, { cause: err });
    throw err;
  }
}

const parsed = (text) => {
  try { return JSON.parse(text); } catch { return text; }
};

/**
 * A browser of `base`: keeps its session cookie (`cookieName`, e.g. `tasks_sid`; every cookie when
 * none is named), sends and reads JSON, doesn't follow redirects, and gives up on a request after
 * `timeoutMs`. `cookie` starts it signed in. `headers` go on every request (an `Origin`, say);
 * `onAnswer({ method, url, status, data, headers })` sees every answer.
 *
 *   const admin = client(base, { cookieName: 'tasks_sid' });
 *   const { status, data, headers } = await admin('POST', '/api/lists', { name: 'Compra' }, { 'X-Extra': '1' });
 *   admin.cookie   // 'tasks_sid=…', for a fetch of one's own
 */
export function client(base, { cookieName = null, cookie = '', headers: always = {}, timeoutMs = REQUEST_MS, onAnswer = null } = {}) {
  const jar = new Map();
  for (const pair of String(cookie || '').split(/;\s*/).filter(Boolean)) jar.set(pair.split('=')[0], pair);
  const call = async function call(method, url, body, headers = {}) {
    const res = await timed(method, base + url, {
      headers: {
        ...always,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.size ? { Cookie: [...jar.values()].join('; ') } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    }, timeoutMs);
    for (const set of res.headers.getSetCookie?.() || []) {
      const [pair] = set.split(';');
      const name = pair.split('=')[0];
      if (!cookieName || name === cookieName) jar.set(name, pair);
    }
    const data = parsed(await res.text());
    onAnswer?.({ method, url, status: res.status, data, headers: res.headers });
    return { status: res.status, data, headers: res.headers };
  };
  Object.defineProperty(call, 'cookie', { get: () => [...jar.values()].join('; ') });
  Object.defineProperty(call, 'base', { value: base });
  return call;
}

/**
 * A raw JSON-RPC call to the app's MCP, for what isn't a tool: → { status, json, text }, `json`
 * null when the answer isn't JSON (`text` is what came, for a check's detail).
 */
export async function rpc(base, token, method, params = {}, { path: at = '/mcp', id = 7, timeoutMs = REQUEST_MS, headers = {} } = {}) {
  const res = await timed('POST', base + at, {
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  }, timeoutMs);
  const text = await res.text().catch((err) => `(the answer broke off: ${err.cause?.message || err.message})`);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON: `text` says what came */ }
  return { status: res.status, json, text };
}

/**
 * An assistant with `token`: → async (tool, args) => { isError, text, json, status }, `text` being
 * the answer's text parts joined (the whole JSON when there are none, so a check's detail says why).
 */
export function mcp(base, token, options = {}) {
  return async (name, args = {}) => {
    const { status, json, text } = await rpc(base, token, 'tools/call', { name, arguments: args }, { id: 1, ...options });
    return {
      isError: Boolean(json?.result?.isError),
      text: json?.result?.content?.map((c) => c.text).join('\n') || (json ? JSON.stringify(json) : `HTTP ${status}: ${text}`),
      json,
      status,
    };
  };
}

/* ------------------------------- live channel ------------------------------ */

/** Reads server-sent events from `res` in the background: → { frames, greeted, close }. */
function readFrames(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = '';
  let greet;
  const greeted = new Promise((resolve) => { greet = resolve; });
  (async () => {
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true }));
      if (chunk.done) return greet(false);
      buffer += decoder.decode(chunk.value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (/^event: hello$/m.test(frame)) greet(true);
        frames.push(frame);
      }
    }
  })();
  return { frames, greeted, close: () => reader.cancel().catch(() => {}) };
}

/**
 * Someone's live channel (`GET <base><path>` with their `cookie`), read in the background from the
 * greeting on. `mark()` is where it stands; `after(mark, test, ms)` waits for a `change` notice
 * that came after the mark and passes `test` (its data, parsed), or null after `ms`.
 */
export async function liveChannel(base, cookie, { path: at = '/api/events', greetMs = 2000 } = {}) {
  const res = await fetch(base + at, { headers: { Cookie: cookie } });
  const { frames, greeted, close } = readFrames(res);
  await Promise.race([greeted, sleep(greetMs)]);
  const notices = () => frames.filter((f) => /^event: change$/m.test(f)).map((f) => parsed(f.match(/^data: (.*)$/m)?.[1]));
  return {
    frames,
    mark: () => notices().length,
    async after(from, test, ms = 4000) {
      for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(50)) {
        const found = notices().slice(from).find(test);
        if (found) return found;
      }
      return null;
    },
    close,
  };
}

/**
 * Someone's live channel (`url`, with their `cookie`), open before `act()` runs: → the first
 * frame after the greeting that matches `pattern` within `ms`, or null.
 */
export async function liveNotice(url, cookie, pattern, act, ms = 4000) {
  const res = await fetch(url, { headers: { Cookie: cookie } }).catch(() => null);
  if (!res?.body) return null;
  const { frames, greeted, close } = readFrames(res);
  try {
    if (!await Promise.race([greeted, sleep(ms).then(() => false)])) return null;
    const from = frames.length;
    await act();
    for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(25)) {
      const found = frames.slice(from).find((frame) => pattern.test(frame));
      if (found) return found;
    }
    return null;
  } finally {
    close();
  }
}

/* ---------------------------------- harness -------------------------------- */

/**
 * Thrown by started() when a section's own server did not come up: its check has already failed
 * with the reason and the log, so the rest of the section is skipped and the run goes on.
 */
export class NotStarted extends Error {}

/**
 * Where CI and a local run would test different suites: → a warning when the suite-core checked
 * out at `<root>/<dir>` is not the commit `root`'s HEAD records (CI tests that one), or ''.
 */
export function submoduleWarning(root, dir = 'server/suite') {
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout?.trim();
  const recorded = git('rev-parse', `HEAD:${dir}`);
  const checkedOut = git('-C', dir, 'rev-parse', 'HEAD');
  if (!recorded || !checkedOut || recorded === checkedOut) return '';
  return `⚠ ${dir} is at ${checkedOut.slice(0, 7)}, but this commit records ${recorded.slice(0, 7)}:`
    + ' CI tests that one. Commit the submodule (and push it to suite-core) before pushing.\n';
}

/**
 * The checks of a run: `check(name, ok, detail)` and `section(title)` collect the report, which
 * `finish()` writes at the end, failures repeated last; while it runs each section's title and
 * each ✗ go to stderr as they happen (`live`, off under `node --test`), so a run that hangs
 * says where.
 */
export function createHarness({ live = !process.env.NODE_TEST_CONTEXT, out = process.stderr } = {}) {
  let passed = 0;
  let failed = 0;
  const results = [];
  const say = (line) => { if (live) out.write(`${line}\n`); };

  function check(name, condition, detail = '') {
    if (condition) {
      passed++;
      results.push(`  ✓ ${name}`);
    } else {
      failed++;
      const line = `  ✗ ${name}${detail ? ` → ${detail}` : ''}`;
      results.push(line);
      say(line);
    }
    return Boolean(condition);
  }

  function section(title) {
    results.push(`\n${title}`);
    say(title);
  }

  function started(name, down, log = '') {
    check(name, !down, `${down}\n${log}`);
    if (down) throw new NotStarted(name);
  }

  /** An error the run didn't expect: a failure with its stack, the run's last line. */
  function fail(err) {
    if (err instanceof NotStarted) return;
    failed++;
    const line = `\n✗ Unexpected error: ${err?.stack || err}${err?.cause ? `\n    cause: ${err.cause.message || err.cause}` : ''}`;
    results.push(line);
    say(line);
  }

  const failures = () => results.filter((r) => /^\s*✗/.test(r)).map((r) => r.trim());

  /** The whole report: every line, the server's `log` if anything failed, the failures again, the count. */
  function report({ log = '', root = null } = {}) {
    let text = results.join('\n');
    if (failed && log) text += `\n\n--- server log ---\n${log}`;
    // What failed again at the very end, after hundreds of ✓ and the server's log.
    if (failed) text += `\n\nFailed:\n${failures().join('\n')}`;
    text += `\n\n${passed} passed, ${failed} failed\n`;
    if (root) text += submoduleWarning(root);
    return text;
  }

  /**
   * Ends the run: `cleanup()` (stop the servers), then the report on stdout and the exit code.
   * Written in one go and only then exit: into a pipe (CI) stdout is asynchronous, and
   * process.exit() right after console.log cut the report at 64 KiB, failures and summary included.
   */
  async function finish({ log = '', root = null, cleanup = null } = {}) {
    const text = report({ log, root });
    try { await cleanup?.(); } catch { /* the report matters more */ }
    await new Promise((resolve) => process.stdout.write(text, resolve));
    process.exit(failed ? 1 : 0);
  }

  /** Under node:test: fails the test with every ✗ so far, if any. */
  function assertPassed(message = 'checks failed') {
    if (failed) throw new assert.AssertionError({ message: `${message}:\n${failures().join('\n')}` });
  }

  return {
    check, section, started, fail, report, finish, assertPassed, results,
    get passed() { return passed; },
    get failed() { return failed; },
  };
}

/* ---------------------------------- fakes ---------------------------------- */

/**
 * A stand-in for another service on 127.0.0.1, at a port the OS gives: `handler(req, res, { url,
 * body, json })` with the body already read (`body` raw, `json(status, payload)` to answer). Every
 * request is kept in `requests` as { method, path, body }. → { url, port, server, requests, close }.
 */
export async function fakeServer(handler) {
  const requests = [];
  let url = '';
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: req.url, body: parsed(body || 'null'), headers: req.headers });
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    try {
      await handler(req, res, { url: new URL(req.url, url), body, json });
    } catch (err) {
      if (!res.headersSent) json(500, { error: String(err?.message || err) });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  url = `http://127.0.0.1:${port}`;
  const close = () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return { url, port, server, requests, close, [Symbol.asyncDispose]: close };
}

/**
 * A fake WorkOS with the real one's contract for what the suite asks: AuthKit's metadata, JWKS,
 * the code exchange with PKCE (`/user_management/authenticate`, checking `clientId`/`apiKey`) and
 * the users API. `accounts` are WorkOS users by id. `signIn(base, id, { app })` does a whole round
 * trip for the app at `base` whose id is `app` (its `<app>_auth` and `<app>_sid` cookies):
 * /auth/login → "AuthKit" → /auth/callback, → { back, cookie, client }.
 * The app runs with AUTH_PROVIDER=workos, WORKOS_API_URL and WORKOS_AUTHKIT_DOMAIN at `url`.
 */
export async function fakeWorkos({ accounts = {}, clientId = 'client_test', apiKey = 'sk_test' } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  /** A JWT as WorkOS signs one (`alg: 'none'` or another `key` for the ones it must refuse). */
  const sign = (payload, { kid = 'k1', key = privateKey, alg = 'RS256' } = {}) => {
    const head = b64({ alg, kid, typ: 'JWT' });
    const body = b64(payload);
    const signature = alg === 'none' ? '' : crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
    return `${head}.${body}.${signature}`;
  };
  const codes = new Map();
  const fake = await fakeServer((req, res, { url, body, json }) => {
    const issuer = fake.url;
    if (url.pathname === '/oauth2/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, { issuer, authorization_endpoint: `${issuer}/oauth2/authorize`, client_id_metadata_document_supported: true });
    }
    if (url.pathname === '/user_management/authenticate' && req.method === 'POST') {
      const asked = parsed(body || '{}');
      const code = codes.get(asked.code);
      const challenge = crypto.createHash('sha256').update(String(asked.code_verifier || '')).digest('base64url');
      if (asked.client_id !== clientId || asked.client_secret !== apiKey || !code || code.challenge !== challenge) {
        return json(400, { error: 'invalid_grant', error_description: 'Invalid code or PKCE' });
      }
      codes.delete(asked.code);
      return json(200, {
        user: accounts[code.id],
        access_token: sign({ sid: `session_${code.id}`, sub: code.id, iss: `${issuer}/user_management/${clientId}` }),
        refresh_token: 'rt',
      });
    }
    const user = url.pathname.match(/^\/user_management\/users\/([\w-]+)$/);
    if (user) {
      if (req.headers.authorization !== `Bearer ${apiKey}`) return json(401, { message: 'Unauthorized' });
      return accounts[user[1]] ? json(200, accounts[user[1]]) : json(404, { message: 'Not found' });
    }
    return json(404, { message: 'Not found' });
  });

  /** A code AuthKit would hand back for `id` after the app's redirect to `authorizeUrl`. */
  function grant(id, authorizeUrl) {
    const code = `code-${id}-${crypto.randomUUID()}`;
    codes.set(code, { id, challenge: new URL(authorizeUrl).searchParams.get('code_challenge') });
    return code;
  }

  async function signIn(base, id, { app, timeoutMs = REQUEST_MS } = {}) {
    const out = await timed('GET', `${base}/auth/login`, { redirect: 'manual' }, timeoutMs);
    const target = out.headers.get('location');
    const state = (out.headers.getSetCookie?.() || []).find((c) => c.startsWith(`${app}_auth=`))?.split(';')[0] ?? '';
    const code = grant(id, target);
    const back = await timed('GET', `${base}/auth/callback?code=${encodeURIComponent(code)}&state=${new URL(target).searchParams.get('state')}`,
      { redirect: 'manual', headers: { Cookie: state } }, timeoutMs);
    const cookie = (back.headers.getSetCookie?.() || []).find((c) => c.startsWith(`${app}_sid=`))?.split(';')[0];
    return { back, cookie, client: client(base, { cookieName: `${app}_sid`, cookie, timeoutMs }) };
  }

  return { ...fake, accounts, codes, jwk, sign, grant, signIn, clientId, apiKey };
}

/**
 * A fake of Paddle's API that keeps what it is asked (`asked`: { call: 'POST /transactions', body })
 * and answers as Paddle does: a transaction with its checkout link, or the subscription asked about.
 * `answer(call, body)` may answer instead (→ { status, body }); the app runs with PADDLE_API_BASE at `url`.
 */
export async function fakePaddle({ answer = null } = {}) {
  const asked = [];
  const fake = await fakeServer(async (req, res, { url, body, json }) => {
    const call = `${req.method} ${url.pathname}`;
    const sent = parsed(body || 'null');
    asked.push({ call, body: sent });
    const own = await answer?.(call, sent);
    if (own) return json(own.status ?? 200, own.body ?? {});
    if (call === 'POST /transactions') {
      const id = `txn_test_${asked.length}`;
      return json(200, { data: { id, checkout: { url: `${fake.url}/pay?_ptxn=${id}` } } });
    }
    return json(200, { data: { id: url.pathname.split('/')[2] ?? null } });
  });
  return { ...fake, asked };
}
