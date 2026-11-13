/**
 * What an app on its own (app.js createApp) and a host of modules (host.js createHost) run the
 * same way: the HTTP server around their handler, the jobs every install has, the process signals
 * and the lines said once it listens. Written once, so the two can't drift apart again (audit
 * sc-host-12: each had its own copy, and they had started to differ). What only one of them has
 * (an app's sweep, a host's modules and daily summary) stays where it is.
 */
import http from 'node:http';
import path from 'node:path';
import { sendJson } from './http.js';
import { watchCode } from './watcher.js';

const HOUR = 3600 * 1000;
/** The jobs that wait a minute after the start, so a start is never slowed by them. */
export const MINUTE_BEFORE_SWEEP = 60 * 1000;

/**
 * The server for a handler: whatever escapes it is a 500, so that one request can never leave a
 * rejection nobody awaits, and every answer is counted for the alerts (a 5xx burst).
 */
export function serverFor(handle, alerts) {
  const server = http.createServer((req, res) => {
    // Its answer is counted if it is a 5xx (ALERT_EMAIL): first, before anything rewrites req.url.
    alerts.watch(req, res);
    handle(req, res).catch((err) => {
      alerts.noteError(req, err);
      console.error(`[error] ${req.method} ${req.url}`, err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      else res.end();
    });
  });
  server.headersTimeout = 65000;
  // Receiving the request, not answering it: a live channel stays open all the same.
  server.requestTimeout = 600_000;
  return server;
}

/**
 * How a job reports a failure. → { failed(name) → (err) => …, safely(name, fn) → () => … }:
 * a job that fails is logged, emailed (ALERT_EMAIL), and tried again next time; one run through
 * `safely` never takes the server down.
 */
export function jobRunner({ log, tag, alerts }) {
  const failed = (name) => (err) => {
    log(`${tag} ${name} failed: ${err?.stack || err}`);
    alerts.jobFailed(name, err);
  };
  const safely = (name, fn) => () => {
    try { fn(); } catch (err) { failed(name)(err); }
  };
  return { failed, safely };
}

/**
 * The jobs of every install, on `timers`: the clean-up (`purge`, now and every 6 hours, with the
 * planner's statistics), OAuth's,
 * the accounts whose days are over, the WorkOS users told of this app, the passwords reset on
 * AuthKit's page, and the groups' renewals asked to stop. Each only where the suite has it.
 */
export function startSuiteJobs(suite, { purge, timers, failed, safely }) {
  const purgeAll = safely('clean-up', purge);
  // With the clean-ups, the planner's statistics (db.js optimize): every table at the start, then
  // what changed. Without them it chose blind (audit of 6/11, perf-srv-6).
  let first = true;
  const optimize = safely('optimize', () => {
    suite.database.optimize?.({ first });
    first = false;
  });
  const cleanUp = () => { purgeAll(); optimize(); };
  cleanUp();
  timers.push(setInterval(cleanUp, 6 * HOUR).unref());
  if (suite.oauth) {
    const purgeOAuth = safely('OAuth clean-up', () => suite.oauth.purge());
    purgeOAuth();
    timers.push(setInterval(purgeOAuth, HOUR).unref());
  }
  if (suite.deletion) {
    // The accounts whose owners asked to delete them, once their days are over: every hour.
    const sweepAccounts = () => suite.deletion.sweep().catch(failed('account deletion'));
    timers.push(setTimeout(sweepAccounts, MINUTE_BEFORE_SWEEP).unref());
    timers.push(setInterval(sweepAccounts, HOUR).unref());
  }
  if (suite.workos?.markAll) {
    // Who signed in before this app noted itself on their WorkOS user (accounts.sharedIdentity): told once.
    const markAll = () => suite.workos.markAll().catch(failed('noting this app at WorkOS'));
    timers.push(setTimeout(markAll, MINUTE_BEFORE_SWEEP).unref());
  }
  if (suite.workosResets) {
    // Passwords reset on AuthKit's own page (workos-events.js): everything that let that person in
    // here, revoked. Every minute.
    const resets = () => suite.workosResets.poll();
    timers.push(setTimeout(resets, MINUTE_BEFORE_SWEEP).unref());
    timers.push(setInterval(resets, MINUTE_BEFORE_SWEEP).unref());
  }
  if (suite.billing?.enabled) {
    // Groups' renewals asked to stop that the provider didn't take yet: every hour (nothing without any).
    const sendStops = () => suite.billing.sendStops().catch(failed("stopping groups' renewals"));
    timers.push(setTimeout(sendStops, MINUTE_BEFORE_SWEEP).unref());
    timers.push(setInterval(sendStops, HOUR).unref());
  }
}

/**
 * SIGTERM and SIGINT close and exit; a rejection that nothing awaited belongs to one task (a
 * notice, a timer): it is logged and the rest goes on. An exception that reached the top leaves
 * the process in a state nobody knows: it is logged and the process ends, for Docker to start it
 * again. Both are emailed with ALERT_EMAIL.
 */
export function handleProcessSignals({ log, tag, alerts, close }) {
  // close() also ends the live channels, which would otherwise keep the server open until the timeout.
  // `waitFor`: the crash's alert, which gives itself less than those 5 s (alerts.js).
  const shutdown = (reason, code = 0, waitFor = null) => {
    log(`${tag} ${reason}, closing…`);
    Promise.all([close(), waitFor]).then(() => process.exit(code), () => process.exit(code));
    setTimeout(() => process.exit(code), 5000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM received'));
  process.once('SIGINT', () => shutdown('SIGINT received'));
  process.on('unhandledRejection', (err) => {
    log(`${tag} unhandled rejection: ${err?.stack || err}`);
    alerts.report('rejection', err);
  });
  process.once('uncaughtException', (err) => {
    log(`${tag} uncaught exception: ${err?.stack || err}`);
    shutdown('uncaught exception', 1, alerts.crashed(err));
  });
}

/**
 * Listens, and says so: `lines` after the address, then whether mail can go out (a wrong MAIL_*
 * shows up here instead of in the first message that never arrives), and hot reload's watcher on
 * `timers`. → the server, listening.
 */
export function listenAndSay(server, { install, mailer, log, tag, lines = [], timers, watchRoot = null }) {
  return new Promise((resolve) => {
    server.listen(install.port, install.host, () => {
      log(`${tag} listening on http://${install.host}:${server.address().port}`);
      for (const line of lines) log(line);
      if (mailer?.provider === 'smtp') {
        mailer.verify().then(
          () => log(`[mail] SMTP ready: ${install.mail.host}:${install.mail.port} (${install.mail.secure})`),
          (err) => log(`[mail] SMTP check failed, nothing will be sent until MAIL_* are fixed: ${err.message}`),
        );
      }
      if (install.hotReload) {
        timers.push(watchCode({ root: watchRoot || path.dirname(path.resolve(process.argv[1] || '.')), log }));
      }
      resolve(server);
    });
  });
}
