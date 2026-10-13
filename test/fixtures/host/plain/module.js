/**
 * A module made from its own address, for the cases a host refuses:
 * `module.js?id=gamma&uses=push` joins as the app "gamma" with modules.push on;
 * `&table=things` keeps its data in a table "things" (declared for copies);
 * `&kinds=family` manages the kind "family" (one per person) and hears of its members and groups going.
 */
import { joinHost } from '../../../../host.js';

const query = new URL(import.meta.url).searchParams;
const id = query.get('id') || 'plain';
const uses = (query.get('uses') || '').split(',').filter(Boolean);
const table = query.get('table');
const kinds = (query.get('kinds') || '').split(',').filter(Boolean);
/** What the module's hooks heard. */
export const heard = [];

export const suite = joinHost({
  config: {
    app: { id, name: id }, modules: Object.fromEntries(uses.map((name) => [name, true])),
    ...(kinds.length ? { organizations: { kinds: Object.fromEntries(kinds.map((kind) => [kind, { managed: true, maxPerUser: 1 }])) } } : {}),
  },
  hooks: kinds.length ? {
    onMemberRemoved: ({ organization, userId, reason }) => heard.push(['member', organization.kind, userId, reason]),
    onOrganizationDeleted: ({ organization, reason }) => heard.push(['deleted', organization.kind, reason]),
    onDeletionRequested: (user) => heard.push(['deletion requested', user.id]),
    onDeletionCancelled: (user) => heard.push(['deletion cancelled', user.id]),
  } : {},
  migrations: table ? [{
    version: 1,
    name: 'things',
    up: (d) => d.exec(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id))`),
  }] : [],
});

export function createModule() {
  return table ? { portable: { tables: { [table]: { refs: { user_id: 'users' } } } } } : {};
}
