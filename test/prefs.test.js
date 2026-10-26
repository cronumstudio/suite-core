/**
 * A person's preferences and profile (prefs.js, api.js registerMeApi): each
 * module keeps its own keys of the one `users.prefs` and never drops
 * another's; the shared ones (lang, lang_seen, tz) are checked and kept
 * canonical; PATCH /api/me writes through accounts.update (its tabs hear of
 * it) and refuses a password; an app without `prefs` keeps its own /api/me;
 * and the browser's zone is told once (web/time-zone.js).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSuite, createApp } from '../app.js';
import { createRouter, sendJson } from '../http.js';
import { definePrefs, combinePrefs, readPrefs, sharedPrefs, userSerializer } from '../prefs.js';
import { reportTimeZone, browserTimeZone } from '../web/time-zone.js';

const LANGUAGES = ['en', 'es'];

/** Next's: one key of its own. */
const NEXT = { defaults: { stepAges: false }, normalize: (raw) => ({ stepAges: raw.stepAges === true }) };
/** Projects': a half object for its notices, merged into what was there. */
const PROJECTS = {
  defaults: { gantt_zoom: 'week', notices: { assigned: true, due: true } },
  normalize: (raw) => ({
    gantt_zoom: ['day', 'week', 'month'].includes(raw.gantt_zoom) ? raw.gantt_zoom : 'week',
    notices: { assigned: raw.notices?.assigned !== false, due: raw.notices?.due !== false },
  }),
  merge: (current, patch) => ({ ...current, ...patch, notices: { ...current.notices, ...(patch.notices || {}) } }),
};

test('the shared keys: read from what is stored, refused when unknown, the zone canonical', () => {
  assert.deepEqual(readPrefs('{"a":1}'), { a: 1 });
  assert.deepEqual(readPrefs('not json'), {});
  assert.deepEqual(readPrefs('[1]'), {});
  assert.deepEqual(readPrefs(null), {});
  assert.deepEqual(sharedPrefs('{"lang":"fr","lang_seen":"es","tz":"europe/madrid"}', LANGUAGES),
    { lang: 'auto', lang_seen: 'es', tz: 'Europe/Madrid' });

  const prefs = definePrefs(NEXT, { languages: LANGUAGES });
  assert.throws(() => prefs.next('{}', { lang: 'xx' }), (err) => err.code === 'field_invalid' && err.extra.field === 'lang');
  assert.throws(() => prefs.next('{}', { lang_seen: 'auto' }), (err) => err.extra.field === 'lang_seen');
  assert.throws(() => prefs.next('{}', { tz: 'Mars/Olympus' }), (err) => err.extra.field === 'tz');
  assert.equal(JSON.parse(prefs.next('{}', { tz: 'america/new_york' })).tz, 'America/New_York', 'kept as the runtime names it');
});

test('each module keeps its own keys and leaves the others’, flat as they were', () => {
  const stored = JSON.stringify({ stepAges: true, sort: 'title', list_defaults: { dates: false }, lang: 'es' });
  const projects = definePrefs(PROJECTS, { languages: LANGUAGES });
  const written = JSON.parse(projects.next(stored, { notices: { due: false } }));
  assert.deepEqual(written, {
    stepAges: true, sort: 'title', list_defaults: { dates: false },
    gantt_zoom: 'week', notices: { assigned: true, due: false }, lang: 'es', lang_seen: null, tz: null,
  }, 'Next’s and Notes’ and Tasks’ keys stay; a half object of notices keeps the rest');
  assert.deepEqual(projects.view({ prefs: JSON.stringify(written) }), {
    gantt_zoom: 'week', notices: { assigned: true, due: false }, lang: 'es', lang_seen: null, tz: null,
  }, 'the browser sees only the module’s own, and the shared ones');

  // A module's key sent to another is not that one's to keep.
  const next = definePrefs(NEXT, { languages: LANGUAGES });
  assert.equal(JSON.parse(next.next('{}', { gantt_zoom: 'day' })).gantt_zoom, undefined);

  // Without a normalize of its own, its defaults say its keys and their kind.
  const plain = definePrefs({ defaults: { sort: 'updated', compact: false } }, { languages: LANGUAGES });
  assert.deepEqual(plain.view({ prefs: '{"sort":"title","compact":"yes","other":1}' }),
    { sort: 'title', compact: false, lang: 'auto', lang_seen: null, tz: null });

  // A host's own /api/me has every module's, one after another on the same row.
  const both = definePrefs(combinePrefs([NEXT, null, PROJECTS]), { languages: LANGUAGES });
  const all = JSON.parse(both.next(stored, { stepAges: false, gantt_zoom: 'month' }));
  assert.equal(all.stepAges, false);
  assert.equal(all.gantt_zoom, 'month');
  assert.equal(all.sort, 'title', 'and still nobody else’s goes');
  assert.equal(combinePrefs([null, undefined]), null, 'no module with preferences: none');
});

test('the account as the browser sees it: public fields, has_password always, auth_provider, the module’s own', () => {
  const suite = {
    config: { app: { languages: LANGUAGES }, install: { authProvider: 'workos' } },
    accounts: { publicUser: (u) => ({ id: u.id, has_password: Boolean(u.password_hash) }) },
  };
  const serialize = userSerializer(suite, { prefs: NEXT, fields: (u) => ({ plan: `plan-${u.id}` }) });
  assert.deepEqual(serialize({ id: 7, prefs: '{"stepAges":true}' }), {
    id: 7, has_password: false, auth_provider: 'workos', plan: 'plan-7',
    prefs: { stepAges: true, lang: 'auto', lang_seen: null, tz: null },
  });
  assert.equal(serialize(null), null);
});

const PRODUCT = { app: { id: 'demo', name: 'Demo', port: 3999, languages: LANGUAGES }, accounts: { minPasswordLength: 8 } };

async function serve(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-core-prefs-'));
  const suite = createSuite({
    config: PRODUCT, log: () => {}, exitOnError: false,
    env: { DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: 'root-password', BASE_URL: 'http://127.0.0.1' },
  });
  const app = createApp({ suite, version: '1.0.0', handleSignals: false, log: () => {}, ...options });
  const server = await app.listen();
  t.after(async () => { await app.close(); suite.database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, pathname, body) => {
    const res = await fetch(base + pathname, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('demo_sid='));
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { suite, call };
}

test('PATCH /api/me: checked whole, written once through accounts.update, never a password', async (t) => {
  const { suite, call } = await serve(t, { prefs: PROJECTS });
  const ana = suite.accounts.create({ username: 'ana', displayName: 'Ana', password: 'ana-password' });
  suite.database.run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify({ stepAges: true }), ana.id);
  const heard = [];
  suite.accounts.whenChanged((id) => heard.push(id));

  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'ana', password: 'ana-password' })).status, 200);

  const me = await call('GET', '/api/me');
  assert.equal(me.data.user.has_password, true);
  assert.equal(me.data.user.auth_provider, 'local');
  assert.deepEqual(me.data.user.prefs, { gantt_zoom: 'week', notices: { assigned: true, due: true }, lang: 'auto', lang_seen: null, tz: null });

  // The password is the suite's route's: refused before anything is written.
  const refused = await call('PATCH', '/api/me', { display_name: 'Ana B', password: 'new-password-1', current_password: 'ana-password' });
  assert.equal(refused.status, 400);
  assert.equal(refused.data.error, 'use_me_password');
  assert.equal(suite.accounts.byId(ana.id).display_name, 'Ana', 'nothing written');

  // A bad field anywhere: nothing of the rest is written either.
  const bad = await call('PATCH', '/api/me', { display_name: 'Ana B', prefs: { tz: 'Nowhere/Land' } });
  assert.equal(bad.data.error, 'field_invalid');
  assert.equal(suite.accounts.byId(ana.id).display_name, 'Ana');
  assert.equal((await call('PATCH', '/api/me', { theme: 'pink' })).data.error, 'field_invalid');

  heard.length = 0;
  const changed = await call('PATCH', '/api/me', {
    display_name: ' Ana B ', theme: 'dark', email: 'ana@example.com', prefs: { notices: { due: false }, tz: 'europe/madrid', lang: 'es' },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.user.display_name, 'Ana B');
  assert.equal(changed.data.user.theme, 'dark');
  assert.equal(changed.data.user.email, 'ana@example.com');
  assert.equal(changed.data.verification, 'sent', 'a new address gets its link');
  assert.deepEqual(changed.data.user.prefs, { gantt_zoom: 'week', notices: { assigned: true, due: false }, lang: 'es', lang_seen: null, tz: 'Europe/Madrid' });
  assert.equal(JSON.parse(suite.accounts.byId(ana.id).prefs).stepAges, true, 'another module’s key stays');
  assert.deepEqual(heard, [ana.id], 'one change, heard once (the person’s other tabs reload it)');

  heard.length = 0;
  assert.equal((await call('PATCH', '/api/me', { prefs: { tz: 'Europe/Madrid' } })).status, 200);
  assert.deepEqual(heard, [], 'what doesn’t change is not written');
});

test('an app without prefs keeps its own /api/me, and its own account', async (t) => {
  const routes = createRouter();
  routes.patch('/api/me', (ctx) => sendJson(ctx.res, 200, { own: true }));
  const { suite, call } = await serve(t, { routes });
  suite.accounts.create({ username: 'ana', displayName: 'Ana', password: 'ana-password' });
  const signedIn = await call('POST', '/api/auth/login', { username: 'ana', password: 'ana-password' });
  assert.equal(signedIn.data.user.prefs, undefined, 'publicUser, as before');
  assert.deepEqual((await call('PATCH', '/api/me', { password: 'x' })).data, { own: true });
  assert.equal((await call('GET', '/api/me')).status, 405, 'no GET of the suite’s next to the app’s own PATCH');
});

test('the browser’s zone is told once per change', async () => {
  const sent = [];
  const send = async (body) => { sent.push(body); };
  const user = { prefs: { tz: null, lang: 'auto' } };
  assert.equal(reportTimeZone(user, { zone: 'Europe/Madrid', send }), 'Europe/Madrid');
  assert.equal(reportTimeZone(user, { zone: 'Europe/Madrid', send }), null, 'already told');
  assert.equal(reportTimeZone(null, { zone: 'Europe/Madrid', send }), null);
  assert.equal(reportTimeZone({ prefs: {} }, { zone: null, send }), null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent, [{ prefs: { tz: 'Europe/Madrid' } }]);
  assert.deepEqual(user.prefs, { tz: 'Europe/Madrid', lang: 'auto' });
  // A failure is only a lost hint.
  assert.equal(reportTimeZone({ prefs: {} }, { zone: 'Asia/Tokyo', send: () => Promise.reject(new Error('offline')) }), 'Asia/Tokyo');
  assert.equal(browserTimeZone({ DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Asia/Tokyo' }) }) }), 'Asia/Tokyo');
  assert.equal(browserTimeZone({ DateTimeFormat: () => { throw new Error('no Intl'); } }), null);
});
