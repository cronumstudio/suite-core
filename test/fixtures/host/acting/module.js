/**
 * A module that acts from a phone's notification (`deviceActions`), for the
 * tests of POST /api/devices/actions: Complete and Snooze on its reminders,
 * as Tasks will, through the same code as its web route. `?bad=…` declares
 * them wrong, for the host to refuse it at the start.
 */
import { joinHost } from '../../../../host.js';
import { sendJson, unauthorized, notFound, badRequest } from '../../../../http.js';

const query = new URL(import.meta.url).searchParams;
/** What each handler was handed, for the tests to look at. */
export const received = [];

export const suite = joinHost({
  config: { app: { id: 'acting', name: 'Acting', languages: ['en'] }, modules: { live: true } },
  migrations: [{
    version: 1,
    name: 'reminders',
    up: (d) => d.exec(`CREATE TABLE acting_reminders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, snoozed_until TEXT)`),
  }],
});

/** The one place a reminder changes, from the web or from a phone: permission, write, live notice. */
function complete(user, id) {
  const row = suite.database.get('SELECT * FROM acting_reminders WHERE id = ?', Number(id));
  // Someone else's is not there for this person: 404, as the web route says.
  if (!row || row.user_id !== user.id) throw notFound();
  suite.database.run('UPDATE acting_reminders SET done = 1 WHERE id = ?', row.id);
  suite.live.publish({ audience: [user.id], event: 'reminders', data: { id: row.id } });
  return { id: row.id, done: true };
}

function snooze(user, id, minutes) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw badRequest('field_invalid', { field: 'minutes' });
  const row = suite.database.get('SELECT * FROM acting_reminders WHERE id = ? AND user_id = ?', Number(id), user.id);
  if (!row) throw notFound();
  const until = new Date(Date.parse('2026-10-21T08:00:00.000Z') + minutes * 60000).toISOString();
  suite.database.run('UPDATE acting_reminders SET snoozed_until = ? WHERE id = ?', until, row.id);
  suite.live.publish({ audience: [user.id], event: 'reminders', data: { id: row.id } });
  return { id: row.id, snoozed_until: until };
}

const DECLARED = {
  complete: ({ user, id, params, suite: given, action }) => {
    received.push({ user, id, params, suite: given, action });
    return complete(user, id);
  },
  snooze: async ({ user, id, params }) => snooze(user, id, params.minutes),
  // What it answers that isn't an object still answers { ok: true }.
  ping: () => 'pong',
  // Not an HttpError: a fault of the module's, a 500 that says nothing of it.
  explode: () => { throw new Error('the module broke'); },
};

const WRONG = { array: [], name: { 'Complete!': () => null }, handler: { complete: 'yes' } };

export function createModule() {
  return {
    routes: (api) => {
      api.post('/api/reminders/:id/complete', (ctx) => {
        if (!ctx.user) throw unauthorized();
        sendJson(ctx.res, 200, complete(ctx.user, ctx.params.id));
      });
    },
    deviceActions: query.has('bad') ? WRONG[query.get('bad')] : DECLARED,
  };
}
