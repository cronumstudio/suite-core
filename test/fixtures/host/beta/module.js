/** The second module of the host's tests: the same routes as alpha's, on its own table. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinHost } from '../../../../host.js';
import { itemRoutes, itemTools, itemCards, doneRoute } from '../items.js';

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
    up: (d) => d.exec('CREATE TABLE beta_items (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)'),
  }],
  hooks: { onUserRemoved: (id) => events.removed.push(id) },
});

export function createModule({ mount }) {
  return {
    publicDir: path.join(HERE, 'public'),
    version: '2.0.0',
    routes: (api) => {
      itemRoutes(api, { suite, table: 'beta_items', mount, name: 'beta' });
      doneRoute(api, { suite, table: 'beta_items' });
    },
    cards: itemCards({ suite, table: 'beta_items' }),
    // 500 bytes an item; one called 'Unreadable' makes it fail, which counts as nothing.
    storage: (userId) => {
      if (suite.database.get("SELECT 1 FROM beta_items WHERE user_id = ? AND text = 'Unreadable'", userId)) throw new Error('unreadable');
      return 500 * suite.database.get('SELECT COUNT(*) AS n FROM beta_items WHERE user_id = ?', userId).n;
    },
    mcp: {
      instructions: ['Beta keeps other items.', 'This paragraph stays out in a host.'].join(String.fromCharCode(10, 10)),
      tools: itemTools({ suite, table: 'beta_items', name: 'beta' }),
      prompts: {
        list: () => [{ name: 'setup', description: 'Set Beta up.' }],
        get: (name) => (name === 'setup' ? { messages: [{ role: 'user', content: { type: 'text', text: 'Set Beta up.' } }] } : null),
      },
    },
  };
}
