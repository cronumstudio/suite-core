/**
 * A module for the host's tests: what an app's server/platform.js and
 * server/module.js do, in one file. Imported with a query (`?case=…`) so each
 * test gets a fresh one.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinHost } from '../../../../host.js';
import { itemRoutes } from '../items.js';

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
      d.exec('CREATE TABLE alpha_items (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL)');
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
    version: '1.0.0',
    routes: (api) => itemRoutes(api, { suite, table: 'alpha_items', mount, name: 'alpha' }),
    start: () => {
      events.started += 1;
      return () => { events.stopped += 1; };
    },
  };
}
