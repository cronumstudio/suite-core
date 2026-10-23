/**
 * A password reset on AuthKit's own page ("Forgot your password?"), heard here.
 *
 * With WorkOS that page is how people get back into an account they think
 * someone else got into, and it happens at WorkOS: the app is never told, so
 * the sessions, tokens, phones and AI clients here (revoke.js) outlived the
 * reset. Instead of a webhook (a new public address to register in WorkOS's
 * dashboard) the app asks WorkOS's Events API every minute for
 * `password_reset.succeeded` and, for each one about an account here, calls
 * revokeEverything with nothing kept: the reset happened elsewhere, so no
 * session here is the one to keep.
 *
 * Where it got to is the last event's id, kept in `app_meta`. The first time
 * it starts from now: the newest reset there is (or this minute, if there is
 * none) is where it begins, and nothing older is acted on. A WorkOS that fails
 * or refuses is logged and asked again next minute; nothing here throws. An
 * event is only passed once it was acted on, so a failure in between asks for
 * it again.
 *
 * Only the process that owns the accounts asks: createApp's listen() for an
 * app on its own, the host's once for all its modules.
 */
export const PASSWORD_RESET = 'password_reset.succeeded';

const KEY = 'suite.workos_password_resets';
const LIMIT = 100;
const PAGES = 10;                          // a thousand resets a minute is more than will ever come
const MARGIN_MS = 5 * 60 * 1000;           // this clock and WorkOS's may differ a little
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');   // WorkOS wants no milliseconds
const byTime = (a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));

/**
 * @param {object} deps
 * @param {object} deps.workos            from createWorkosClient(): listEvents
 * @param {object} deps.users             from workosUsers(): byWorkosId
 * @param {object} deps.database          getMeta, setMeta
 * @param {Function} deps.revokeEverything  from createRevoker()
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.clock]
 */
export function watchPasswordResets({ workos, users, database, revokeEverything, log = console.log, clock = () => Date.now() }) {
  let running = null;
  let lastError = null;

  const read = () => {
    try { return JSON.parse(database.getMeta(KEY) || 'null'); } catch { return null; }
  };
  const save = (state) => database.setMeta(KEY, JSON.stringify(state));

  /** The first time: where to start, without acting on what came before. */
  async function begin() {
    const started = clock();
    const { data } = await workos.listEvents({ events: [PASSWORD_RESET], order: 'desc', limit: 1 });
    save(data[0]?.id ? { after: data[0].id } : { since: iso(started - MARGIN_MS) });
    return { revoked: 0, started: true };
  }

  /** One reset: everything that lets that person in here, ended. → 1 if they have an account here. */
  function reset(event) {
    const subject = event.data?.user_id;
    const user = subject ? users.byWorkosId(String(subject)) : null;
    if (!user) return 0;
    revokeEverything(user.id, { keep: null, reason: 'workos_password_reset' });
    log(`[auth] user #${user.id} reset their password at WorkOS: their sessions, tokens, phones and AI clients here were revoked`);
    return 1;
  }

  async function step() {
    const state = read();
    if (!state?.after && !state?.since) return begin();
    let after = state.after || null;
    const since = after ? null : state.since;
    const started = clock();
    let revoked = 0;
    for (let page = 0; page < PAGES; page++) {
      const { data } = await workos.listEvents({ events: [PASSWORD_RESET], after, rangeStart: since, order: 'asc', limit: LIMIT });
      // Oldest first, whatever order the page came in.
      for (const event of [...data].sort(byTime)) {
        if (event.event === PASSWORD_RESET) revoked += reset(event);
        after = event.id;
        save({ after });
      }
      if (data.length < LIMIT || !after) break;
    }
    // Nothing yet: move the start along, so it never falls outside what WorkOS keeps.
    if (!after && since) {
      const now = iso(started - MARGIN_MS);
      if (now > since) save({ since: now });
    }
    return { revoked };
  }

  /** WorkOS failed or refused: logged once until it changes, asked again next time. */
  function failed(err) {
    // A start it no longer takes (an event past its 90 days, say): start again from now.
    if ([400, 404, 422].includes(err.status) && read()) {
      log(`[auth] WorkOS's password resets: ${err.message}; starting again from now`);
      save(null);
    } else if (err.message !== lastError) {
      log(`[auth] WorkOS's password resets aren't heard for now: ${err.message}`);
    }
    lastError = err.message;
    return { revoked: 0, error: err.message };
  }

  /**
   * Asks WorkOS for the resets since the last time and revokes. Never throws;
   * one at a time.
   * @returns {Promise<{ revoked: number, started?: boolean, error?: string }>}
   */
  function poll() {
    if (!running) {
      running = step()
        .then((result) => {
          if (lastError) log("[auth] WorkOS's password resets are heard again");
          lastError = null;
          return result;
        }, failed)
        .finally(() => { running = null; });
    }
    return running;
  }

  return { poll };
}
