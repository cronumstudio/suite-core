/**
 * A module that says which time zone it runs in (time.js currentZone), from a route, a tool and
 * the card of its one thing, for the tests of the person's zone (zones.test.js). `?id=…` names it;
 * `&zoned` asks for its routes in the zone of whoever asks (`zonedRoutes`), as Tasks and Projects do.
 */
import { joinHost } from '../../../../host.js';
import { sendJson } from '../../../../http.js';
import { currentZone } from '../../../../time.js';

const query = new URL(import.meta.url).searchParams;
const id = query.get('id') || 'clock';

export const suite = joinHost({ config: { app: { id, name: id, languages: ['en'] } } });

/** The zone it runs in after an await: the zone holds through them. */
const later = async () => {
  await new Promise((resolve) => { setImmediate(resolve); });
  return currentZone();
};

export function createModule() {
  return {
    routes: (api) => api.get('/api/zone', async (ctx) => sendJson(ctx.res, 200, { zone: await later() })),
    zonedRoutes: query.has('zoned'),
    mcp: {
      instructions: `${id} says where it is.`,
      tools: [{
        name: 'zone', title: 'Which zone', description: 'The time zone the tool runs in.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        handler: async () => ({ content: [{ type: 'text', text: await later() }] }),
      }],
    },
    // Its one thing, titled with the zone it is read in: what the host's own link tools show of it.
    cards: { clock: { read: () => ({ id: '1', title: currentZone(), state: 'open', where: id }) } },
  };
}
