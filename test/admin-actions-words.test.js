/**
 * Every action the server writes to the audit log has its words in Administration › Activity, in
 * every language (`admin.actions.*`, web/admin.js actionText): without them the row and the filter
 * show the identifier (sc-ui-7).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);

test('each audit action the server records has its words in all five catalogs', () => {
  const actions = new Set();
  for (const file of fs.readdirSync(root).filter((name) => name.endsWith('.js'))) {
    const code = fs.readFileSync(new URL(file, root), 'utf8');
    for (const [, action] of code.matchAll(/(?:\brecord\w*\((?:ctx, )?|\baction: )'([a-z_]+\.[a-z_.]+)'/g)) actions.add(action);
  }
  assert.ok(actions.size > 40, `the actions are found (${actions.size})`);
  for (const action of ['auth.revoke_everything', 'oauth.connection.revoke', 'billing.customer_conflict', 'billing.customer_unvouched']) {
    assert.ok(actions.has(action), action);
  }
  for (const lang of ['en', 'es', 'fr', 'de', 'it']) {
    const words = JSON.parse(fs.readFileSync(new URL(`i18n/${lang}.json`, root), 'utf8'));
    const missing = [...actions].filter((action) => typeof words[`admin.actions.${action.replace(/\./g, '_')}`] !== 'string');
    assert.deepEqual(missing, [], lang);
  }
});
