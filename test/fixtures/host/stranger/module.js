/** A module whose server/suite is another copy of suite-core: it joins from elsewhere. */
const host = globalThis[Symbol.for('suite-core.host')];
export const suite = host.join({ config: { app: { id: 'stranger', name: 'Stranger' } } }, 'file:///elsewhere/suite/host.js');
export function createModule() {
  return {};
}
