/**
 * A module made from its own address, for the cases a host refuses:
 * `module.js?id=gamma&uses=push` joins as the app "gamma" with modules.push on;
 * `&table=things` keeps its data in a table "things" (declared for copies).
 */
import { joinHost } from '../../../../host.js';

const query = new URL(import.meta.url).searchParams;
const id = query.get('id') || 'plain';
const uses = (query.get('uses') || '').split(',').filter(Boolean);
const table = query.get('table');

export const suite = joinHost({
  config: { app: { id, name: id }, modules: Object.fromEntries(uses.map((name) => [name, true])) },
  migrations: table ? [{
    version: 1,
    name: 'things',
    up: (d) => d.exec(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id))`),
  }] : [],
});

export function createModule() {
  return table ? { portable: { tables: { [table]: { refs: { user_id: 'users' } } } } } : {};
}
