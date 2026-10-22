/**
 * The connect page (web/connect.js) on a fake page: the consent, its two
 * buttons and what the core may answer, with the server's call and the
 * browser's navigation stood in for.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

const document = installFakeDom();
const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });
const { loadLanguage } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
const {
  connectRequestOf, cancelAddress, showConnect, anotherAccountAddress, accountLabel,
} = await import('../web/connect.js');
const { ApiError, SessionExpired } = await import('../web/api.js');

const BACK = 'com.example.work:/auth';
const CHALLENGE = 'A'.repeat(43);
const REQUEST = { code_challenge: CHALLENGE, state: 'st-1', redirect_uri: BACK, name: 'Ana’s iPhone', platform: 'ios' };
const app = { name: 'Work', icon: '/icons/work.svg' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The page drawn for `request`, with `answer` standing in for POST /api/devices/codes. */
function page(request, answer = async () => ({ redirect_to: `${BACK}?code=c0de&state=st-1` }), {
  user = { username: 'ana', email: 'ana@example.com' }, signOut = async () => ({ ok: true }),
} = {}) {
  const root = document.createElement('div');
  const sent = [];
  const went = [];
  let reloaded = 0;
  let signedOut = 0;
  showConnect({
    app, user, request, root,
    send: async (body) => { sent.push(body); return answer(body); },
    go: (href) => went.push(href), reload: () => { reloaded += 1; },
    signOut: async () => { signedOut += 1; return signOut(); },
  });
  const button = (action) => root.all().find((node) => node.getAttribute('data-action') === action);
  return { root, sent, went, button, reloaded: () => reloaded, signedOut: () => signedOut, text: () => root.textContent };
}

test('the request in the address: the core’s shapes, one of each field', () => {
  assert.deepEqual(connectRequestOf(`?${new URLSearchParams(REQUEST)}`), REQUEST);
  assert.equal(connectRequestOf(''), null);
  assert.equal(connectRequestOf(`?${new URLSearchParams({ ...REQUEST, code_challenge: 'short' })}`), null);
  assert.equal(connectRequestOf(`?${new URLSearchParams(REQUEST)}&state=again`), null);
  assert.equal(cancelAddress(REQUEST), `${BACK}?error=access_denied&state=st-1`);
});

test('Allow asks for a code and goes back to the app with it; Cancel goes back with access_denied', async () => {
  const allowed = page(REQUEST);
  assert.match(allowed.text(), /Connect this device to Work/);
  assert.match(allowed.text(), /Signed in as ana@example\.com\./);
  assert.ok(allowed.root.all().some((node) => node.className === 'kit-connect__device' && node.textContent === 'Ana’s iPhone'),
    'the device’s name in an element of its own');
  allowed.button('allow').dispatch('click');
  await tick();
  assert.deepEqual(allowed.sent, [{ ...REQUEST, code_challenge_method: 'S256' }]);
  assert.deepEqual(allowed.went, [`${BACK}?code=c0de&state=st-1`]);
  assert.ok(allowed.root.all().some((node) => node.tagName === 'A' && node.getAttribute('href') === `${BACK}?code=c0de&state=st-1`),
    'a link that does the same, for a browser that didn’t follow');

  const cancelled = page(REQUEST);
  cancelled.button('cancel').dispatch('click');
  assert.deepEqual(cancelled.sent, []);
  assert.deepEqual(cancelled.went, [`${BACK}?error=access_denied&state=st-1`]);
});

test('what the core answers: elsewhere, a bad request, a refusal, an ended session', async () => {
  // An answer that goes anywhere but the request's own address is never followed.
  const elsewhere = page(REQUEST, async () => ({ redirect_to: 'https://evil.example/?code=x' }));
  elsewhere.button('allow').dispatch('click');
  await tick();
  assert.deepEqual(elsewhere.went, []);
  assert.match(elsewhere.text(), /This link can’t connect a device/);

  const refusedLink = page(REQUEST, async () => { throw new ApiError(400, 'redirect_uri_not_allowed'); });
  refusedLink.button('allow').dispatch('click');
  await tick();
  assert.match(refusedLink.text(), /This link can’t connect a device/);

  // A person the app keeps out: said, and the buttons stay off.
  const kept = page(REQUEST, async () => { throw new ApiError(403, 'device_not_allowed'); });
  kept.button('allow').dispatch('click');
  await tick();
  assert.deepEqual(kept.went, []);
  assert.match(kept.text(), /This account can’t connect devices here\./);
  assert.equal(kept.button('allow').disabled, true);
  // Too many at once: said, and tried again.
  const busy = page(REQUEST, async () => { throw new ApiError(429, 'too_many_attempts'); });
  busy.button('allow').dispatch('click');
  await tick();
  assert.equal(busy.button('allow').disabled, false);

  const ended = page(REQUEST, async () => { throw new SessionExpired(401, 'unauthorized'); });
  ended.button('allow').dispatch('click');
  await tick();
  assert.equal(ended.reloaded(), 1, 'the page again, which signs in');

  const bare = page(null);
  assert.match(bare.text(), /Open Work on the device and sign in from there again\./);
  assert.equal(bare.button('allow'), undefined);
});

test('another account: the one signed in is named, and the page signs out and asks for the sign-in again', async () => {
  assert.equal(accountLabel({ username: 'ana', email: 'ana@example.com', display_name: 'Ana Ruiz' }), 'Ana Ruiz (ana@example.com)');
  assert.equal(accountLabel({ username: 'ana', display_name: 'Ana Ruiz' }), 'Ana Ruiz (ana)');
  assert.equal(accountLabel({ username: 'ana', email: 'ana@example.com' }), 'ana@example.com');
  assert.equal(accountLabel({ display_name: 'Ana' }), 'Ana');
  assert.equal(accountLabel(null), '');
  assert.equal(anotherAccountAddress(REQUEST), `/devices/connect?${new URLSearchParams({ ...REQUEST, prompt: 'login' })}`);
  assert.equal(anotherAccountAddress({ ...REQUEST, platform: null }),
    `/devices/connect?${new URLSearchParams({ code_challenge: CHALLENGE, state: 'st-1', redirect_uri: BACK, name: 'Ana’s iPhone', prompt: 'login' })}`);

  const named = page(REQUEST, undefined, { user: { username: 'ana', email: 'ana@example.com', display_name: 'Ana Ruiz' } });
  assert.match(named.text(), /Signed in as Ana Ruiz \(ana@example\.com\)\. Use another account/);
  assert.equal(named.button('other-account').className, 'kit-link');

  // Signed out first (the provider's logout_url left aside), then the same request, signing in anew.
  let finish;
  const switching = page(REQUEST, undefined, {
    signOut: () => new Promise((resolve) => { finish = resolve; }),
  });
  switching.button('other-account').dispatch('click');
  assert.equal(switching.signedOut(), 1);
  assert.match(switching.text(), /Signing out…/);
  assert.deepEqual(['allow', 'cancel', 'other-account'].map((a) => switching.button(a).disabled), [true, true, true]);
  assert.deepEqual(switching.went, [], 'not before the session is gone');
  finish({ ok: true, logout_url: 'https://auth.example/logout' });
  await tick();
  assert.deepEqual(switching.went, [anotherAccountAddress(REQUEST)], 'never to the provider’s logout');
  assert.deepEqual(switching.sent, [], 'no code was asked for');

  // A session that had ended already is as good as signed out.
  const ended = page(REQUEST, undefined, { signOut: async () => { throw new SessionExpired(401, 'unauthorized'); } });
  ended.button('other-account').dispatch('click');
  await tick();
  assert.deepEqual(ended.went, [anotherAccountAddress(REQUEST)]);

  // The sign-out failed: said, nothing followed, and the buttons back.
  const failed = page(REQUEST, undefined, { signOut: async () => { throw new ApiError(429, 'too_many_attempts'); } });
  failed.button('other-account').dispatch('click');
  await tick();
  assert.deepEqual(failed.went, []);
  assert.deepEqual(['allow', 'cancel', 'other-account'].map((a) => failed.button(a).disabled), [false, false, false]);

  // An account the app keeps out: Allow stays off, another account is still offered.
  const kept = page(REQUEST, async () => { throw new ApiError(403, 'device_not_allowed'); });
  kept.button('allow').dispatch('click');
  await tick();
  assert.deepEqual([kept.button('allow').disabled, kept.button('other-account').disabled], [true, false]);
  kept.button('other-account').dispatch('click');
  await tick();
  assert.deepEqual(kept.went, [anotherAccountAddress(REQUEST)]);

  // No request, no switch: the bare page only says the link can't connect a device.
  assert.equal(page(null).button('other-account'), undefined);
});
