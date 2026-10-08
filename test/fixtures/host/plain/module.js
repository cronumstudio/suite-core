/**
 * A module made from its own address, for the cases a host refuses:
 * `module.js?id=gamma&uses=push` joins as the app "gamma" with modules.push on.
 */
import { joinHost } from '../../../../host.js';

const query = new URL(import.meta.url).searchParams;
const id = query.get('id') || 'plain';
const uses = (query.get('uses') || '').split(',').filter(Boolean);

export const suite = joinHost({
  config: { app: { id, name: id }, modules: Object.fromEntries(uses.map((name) => [name, true])) },
});

export function createModule() {
  return query.get('nothing') ? null : {};
}
