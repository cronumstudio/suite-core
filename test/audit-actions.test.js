/**
 * The admin's Activity (web/admin.js): every action the suite writes to the log reads as a sentence
 * in every language, not as its code (audit sc-auth-11), and the log is read by action through its
 * index, not whole (sc-auth-12).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';
import { SUITE_MIGRATIONS } from '../schema.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LANGUAGES = ['en', 'es', 'fr', 'de', 'it'];

/**
 * The actions the server code records, read from it: every literal of the shape `scope.what` in a
 * call that records one (`audit?.record({ action: … })`, `record(ctx, …)`, `record(…)`,
 * `recordStop(…)`), both sides of a `? :` included. Billing's `billing.${outcome}` is the outcomes
 * it writes down (billing.js handleWebhook: every one but those it leaves out).
 */
function recordedActions() {
  const found = new Set();
  const files = fs.readdirSync(ROOT).filter((name) => name.endsWith('.js'));
  const call = /(?:\baction:\s*|\brecord(?:Stop)?\(\s*(?:ctx,\s*)?)([^,{}]+?)(?=,|\s*\}|\))/g;
  const literal = /'([a-z_]+(?:\.[a-z_]+)+)'/g;
  for (const name of files) {
    const source = fs.readFileSync(path.join(ROOT, name), 'utf8');
    for (const [, expression] of source.matchAll(call)) {
      for (const [, action] of expression.matchAll(literal)) found.add(action);
    }
  }
  for (const outcome of ['granted', 'extended', 'changed', 'revoked', 'refunded', 'unchanged', 'unsigned']) {
    found.add(`billing.${outcome}`);
  }
  return [...found].sort();
}

test('every action the suite records is a sentence in Activity, in every language (audit sc-auth-11)', () => {
  const actions = recordedActions();
  // The reading itself: the ones the audit found missing, and some of every kind of call.
  for (const known of ['auth.revoke_everything', 'oauth.connection.revoke', 'billing.customer_unvouched',
    'billing.customer_conflict', 'auth.login', 'org.leave', 'org.member.remove', 'calendar_feed.renewed',
    'billing.organization.stop', 'mcp.tool', 'device.web_session_failed']) {
    assert.ok(actions.includes(known), `read from the code: ${known}`);
  }
  for (const lang of LANGUAGES) {
    const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', `${lang}.json`), 'utf8'));
    // As web/admin.js actionText names it.
    const missing = actions.filter((action) => !catalog[`admin.actions.${action.replace(/\./g, '_')}`]);
    assert.deepEqual(missing, [], `${lang}: actions without a sentence`);
  }
});

test('the log is read by action through its index (audit sc-auth-12)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-audit-'));
  const database = openDatabase({ dataDir: dir, name: 'audit' });
  migrate(database, SUITE_MIGRATIONS, { scope: 'suite', log: () => {} });
  const plan = (sql, ...params) => database.all(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((row) => row.detail).join(' | ');
  assert.match(plan('SELECT DISTINCT action FROM audit_log ORDER BY action'), /ix_audit_action/);
  assert.match(plan(`SELECT a.* FROM audit_log a WHERE a.action = ? ORDER BY a.id DESC LIMIT 50`, 'auth.login'), /ix_audit_action/);
  assert.doesNotMatch(plan(`SELECT a.* FROM audit_log a WHERE a.action = ? ORDER BY a.id DESC LIMIT 50`, 'auth.login'), /TEMP B-TREE/);
  database.close?.();
});
