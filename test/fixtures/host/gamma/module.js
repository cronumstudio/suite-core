/**
 * A third module for the host's MCP tests (mcp-on-demand.test.js): it declares the `mcp` plan
 * feature, as the apps do, and its texts name its own tools without the host's prefix.
 */
import { joinHost } from '../../../../host.js';
import { itemTools } from '../items.js';

export const suite = joinHost({
  config: {
    app: { id: 'gamma', name: 'Gamma', color: '#0E9F6E', languages: ['en'] },
    modules: { live: true },
    features: { mcp: { type: 'flag', default: true, label: 'using Gamma from an assistant' } },
  },
  migrations: [{
    version: 1,
    name: 'items',
    up: (d) => d.exec('CREATE TABLE gamma_items (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)'),
  }],
});

export function createModule() {
  const tools = itemTools({ suite, table: 'gamma_items', name: 'gamma', add: true }).map((tool) => (tool.name === 'add_item' ? {
    ...tool,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: 'Adds an item. To see them, list_items; for several, call add_item again. A summary_items is no tool.',
    inputSchema: { ...tool.inputSchema, properties: { text: { type: 'string', description: 'What it says, as list_items shows it' } } },
  } : tool));
  return {
    publicDir: null,
    version: '3.0.0',
    mcp: {
      instructions: 'Gamma keeps a third kind of items.',
      brief: (name) => `Gamma: ${name('add_item')} adds an item.`,
      tools,
      prompts: {
        list: () => [{ name: 'tidy', description: 'Tidy with list_items.' }],
        get: (name) => (name === 'tidy' ? { messages: [{ role: 'user', content: { type: 'text', text: 'Call list_items, then add_item.' } }] } : null),
      },
    },
  };
}
