/**
 * Deleting one's own account in Settings (web/settings.js) where the install sells in the stores: a
 * subscription bought in the App Store or Google Play goes on after the account, since no server
 * can stop it, so the question says it first, with where to cancel it; one cancelled there already
 * renews no more and isn't said; what they pay unknown, nothing is asked. On a fake page, with the
 * core's English catalog.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

const document = installFakeDom();
// Settings › Modules marks its rows with classList, which the fake DOM leaves out.
Object.defineProperty(Object.getPrototypeOf(document.createElement('div')), 'classList', {
  configurable: true,
  get() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (...more) => { this.className = [...new Set([...names(), ...more])].join(' '); },
      remove: (...gone) => { this.className = names().filter((n) => !gone.includes(n)).join(' '); },
      contains: (name) => names().includes(name),
      toggle: (name, on = !names().includes(name)) => { if (on) this.classList.add(name); else this.classList.remove(name); return on; },
    };
  },
});
const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => { memory.set(key, String(value)); },
  removeItem: (key) => { memory.delete(key); },
};
const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });
const { loadLanguage, t } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
globalThis.fetch = realFetch;

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const HOST = { id: 'work', name: 'Cronum Work', mount: 'tasks', base: '/tasks/', push: true, plans: false };
const STORE = {
  kind: 'store', provider: 'revenuecat', product: 'store-pro-monthly', plan: 'pro', plan_name: 'Pro', status: 'active',
  period_end: '2026-12-11T00:00:00.000Z', ending: false, store: 'app_store', sandbox: false,
  manage: { via: 'store', store: 'app_store', url: 'https://apps.apple.com/account/subscriptions' },
};
// One she cancelled in Google Play already: it renews no more, so there is nothing to warn of.
const CANCELLED = {
  ...STORE, product: 'store-pro-yearly', period_end: '2026-12-01T00:00:00.000Z', ending: true, store: 'play_store',
  manage: { via: 'store', store: 'play_store', url: 'https://play.google.com/store/account/subscriptions' },
};
// A group's, which she manages but doesn't pay herself: not hers to cancel before going.
const GROUP = {
  kind: 'web', provider: 'paddle', organization_id: 3, product: 'team-yearly', plan: 'pro', plan_name: 'Pro', status: 'active',
  period_end: '2027-11-11T00:00:00.000Z', ending: false, manage: { via: 'portal', organization_id: 3 },
};

test('deleting one’s account while paying in a store: said first, with where to cancel it; unknown, nothing is asked', async () => {
  memory.clear();
  const { openSettings, settingsConfig } = await import('../web/settings.js');
  settingsConfig({ app: { modules: { billing: true, stores: true }, host: HOST }, deletion_days: 30 });
  memory.set('host.modules', JSON.stringify({ host: { name: 'Cronum Work' }, modules: [{ mount: 'tasks', path: '/tasks/', name: 'Tasks', active: true }] }));
  let overview = { status: 503, body: { error: 'billing_provider_unavailable' } };
  globalThis.fetch = async (path, { method = 'GET' } = {}) => {
    const answer = method === 'GET' && path === '/api/billing/overview' ? overview : { status: 404, body: { error: 'not_found' } };
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
  };
  globalThis.window = { location: { origin: 'https://work.example', href: 'https://work.example/tasks/' } };
  Object.assign(document, { addEventListener: () => {}, removeEventListener: () => {} });
  const root = document.createElement('div');
  const settings = openSettings({ app: { id: 'tasks', name: 'Tasks' }, user: { id: 7, username: 'ada', role: 'user' }, config: {}, root, start: 'account' });
  const questions = () => document.body.all().filter((node) => node.tagName === 'DIALOG' && node.open);
  const errors = () => document.body.all().filter((node) => /kit-toast--error/.test(node.className || '')).map((node) => node.textContent);
  const press = async () => {
    root.all().find((node) => node.tagName === 'BUTTON' && node.textContent === t('kit.data.deleteButton')).click();
    await settle();
  };
  try {
    await settle();
    await press();
    assert.equal(questions().length, 0, 'what she pays unknown: no question');
    assert.ok(errors().includes(t('errors.billing_provider_unavailable')), errors().join(' | '));

    overview = { status: 200, body: { plan: { id: 'pro', name: 'Pro', ends: STORE.period_end }, sources: [STORE, CANCELLED, GROUP] } };
    await press();
    const [question] = questions();
    const said = question.textContent;
    assert.ok(said.includes(t('kit.data.deleteStore', { plan: 'Pro' })), said);
    assert.ok(said.includes(t('kit.plan.store.app_store', { app: 'Cronum Work' })), 'where to cancel it');
    assert.ok(said.includes(t('kit.data.deleteBilling')), 'and what the web’s does, as before');
    assert.equal(question.all().filter((node) => node.className === 'kit-warning').length, 1,
      'once: the one cancelled in Google Play renews no more, and the group’s is not hers to cancel');
    assert.ok(!said.includes(t('kit.plan.store.play_store', { app: 'Cronum Work' })), said);
  } finally {
    settings.close();
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete document.addEventListener;
    delete document.removeEventListener;
  }
});
