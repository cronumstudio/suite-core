/**
 * A module for the host's tests: what an app's server/platform.js and
 * server/module.js do, in one file. Imported with a query (`?case=…`) so each
 * test gets a fresh one.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinHost } from '../../../../host.js';
import { itemRoutes, itemTools, itemCards, itemCalendar, doneRoute } from '../items.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const events = { created: [], removed: [], started: 0, stopped: 0 };

export const suite = joinHost({
  config: {
    app: { id: 'alpha', name: 'Alpha', color: '#EF4B2A', icon: '/icons/alpha.svg?v=1', languages: ['en', 'es'] },
    modules: { live: true, uploads: true },
    features: { 'items.max': { type: 'limit', default: null, label: 'more items' } },
  },
  migrations: [{
    version: 1,
    name: 'items',
    up: (d) => {
      d.exec('CREATE TABLE alpha_items (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)');
      d.exec('ALTER TABLE users ADD COLUMN alpha_badge TEXT');
    },
  }],
  hooks: {
    extraColumns: () => ({ alpha_badge: 'new' }),
    onUserCreated: (user) => events.created.push(user.id),
  },
});

export function createModule({ mount }) {
  return {
    publicDir: path.join(HERE, 'public'),
    // A page any site may frame (app.js `embeds`), as Next's public page.
    embeds: ['/shown.html'],
    version: '1.0.0',
    routes: (api) => {
      itemRoutes(api, { suite, table: 'alpha_items', mount, name: 'alpha' });
      doneRoute(api, { suite, table: 'alpha_items' });
    },
    cards: itemCards({ suite, table: 'alpha_items' }),
    // Its items with a date, for a host with a calendar.
    calendar: itemCalendar({ suite, table: 'alpha_items' }),
    // Its sections of Settings, for the other modules' Settings to list them.
    settings: { sections: [{ id: 'items', icon: 'notes', label: 'settings.items.title' }], about: true },
    // As if each item were a 1000-byte photo: what the host adds up for storage.mb.
    storage: (userId) => 1000 * suite.database.get('SELECT COUNT(*) AS n FROM alpha_items WHERE user_id = ?', userId).n,
    // Its items against items.max, each one a file too; an id the admin has no words for is left out.
    // One called 'Locked' makes it fail.
    usage: (userId) => {
      if (suite.database.get("SELECT 1 FROM alpha_items WHERE user_id = ? AND text = 'Locked'", userId)) throw new Error('locked');
      const n = suite.database.get('SELECT COUNT(*) AS n FROM alpha_items WHERE user_id = ?', userId).n;
      return {
        counts: [{ id: 'tasks', count: n, feature: 'items.max' }, { id: 'files', count: n }, { id: 'gizmos', count: 3 }],
        active_at: n ? '2026-10-21T18:22:00.000Z' : null,
      };
    },
    mcp: {
      instructions: ['Alpha keeps items.', 'A second paragraph a host leaves out.'].join(String.fromCharCode(10, 10)),
      // What a host says of alpha, with its tools named as the host names them.
      brief: (name) => `Alpha keeps items: ${name('add_item')} adds one, ${name('list_items')} lists them.`,
      tools: itemTools({ suite, table: 'alpha_items', name: 'alpha', add: true }),
      describeError: (error) => (error.code === 'item_exploded' ? 'That item cannot be added.' : null),
    },
    start: () => {
      events.started += 1;
      return () => { events.stopped += 1; };
    },
  };
}
