/** The second module of the host's tests: the same routes as alpha's, on its own table. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinHost } from '../../../../host.js';
import { itemRoutes } from '../items.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const events = { removed: [] };

export const suite = joinHost({
  config: {
    app: { id: 'beta', name: 'Beta', color: '#7C3AED', languages: ['en'] },
    modules: { live: true, uploads: true },
  },
  migrations: [{
    version: 1,
    name: 'items',
    up: (d) => d.exec('CREATE TABLE beta_items (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL)'),
  }],
  hooks: { onUserRemoved: (id) => events.removed.push(id) },
});

export function createModule({ mount }) {
  return {
    publicDir: path.join(HERE, 'public'),
    version: '2.0.0',
    routes: (api) => itemRoutes(api, { suite, table: 'beta_items', mount, name: 'beta' }),
  };
}
