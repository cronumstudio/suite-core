/**
 * The banner of a module without a signal (web/ui.js offlineBanner, web-kit.md rule 10), without a
 * browser: shown the moment the browser says the signal went, with no request failing first;
 * gone when it is back and nothing waits; while what waits is sent, how many; a discreet
 * «Reintentar» only when the module gives one; the same words never drawn twice; and the notice
 * of what only the server can show (offlineNotice).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';

installFakeDom();
const events = new EventTarget();
globalThis.addEventListener = events.addEventListener.bind(events);
globalThis.removeEventListener = events.removeEventListener.bind(events);
const signal = { onLine: true };
Object.defineProperty(globalThis, 'navigator', { value: signal, configurable: true, writable: true });
const go = (online) => { signal.onLine = online; events.dispatchEvent(new Event(online ? 'online' : 'offline')); };

const { offlineBanner, offlineNotice } = await import('../web/ui.js');

/** A shell's banner row, as shell.js gives it: one banner per id. */
function fakeShell() {
  const shown = new Map();
  let draws = 0;
  return {
    shown,
    get draws() { return draws; },
    showBanner(id, options) { draws += 1; shown.set(id, options); },
    hideBanner(id) { shown.delete(id); },
  };
}

test('offlineBanner: shown as the browser says the signal went, gone when it is back', () => {
  signal.onLine = true;
  const shell = fakeShell();
  const banner = offlineBanner({ shell, pending: () => 2 });
  try {
    assert.equal(shell.shown.has('offline'), true, 'online with changes waiting: how many are being sent');
    assert.equal(shell.shown.get('offline').text, 'kit.offline.pending');
    assert.equal(shell.shown.get('offline').iconName, 'upload');
    banner.stop();
    const quiet = offlineBanner({ shell: fakeShell(), pending: () => 0 });
    quiet.stop();

    const idle = fakeShell();
    const watch = offlineBanner({ shell: idle });
    assert.equal(idle.shown.has('offline'), false, 'online, nothing waiting: no banner');
    go(false);
    const shown = idle.shown.get('offline');
    assert.ok(shown, 'the offline event alone shows it: no request had to fail');
    assert.equal(shown.kind, 'warn');
    assert.equal(shown.iconName, 'wifi-off');
    assert.equal(shown.text, 'kit.offline.banner');
    assert.equal(shown.action, null, 'no retry unless the module gives one');
    go(true);
    assert.equal(idle.shown.has('offline'), false, 'back, with nothing waiting: gone');
    watch.stop();
    go(false);
    assert.equal(idle.shown.has('offline'), false, 'stopped, it listens no more');
  } finally {
    go(true);
  }
});

test('offlineBanner: what the module knows counts too, «Reintentar» is discreet, nothing loaded says only the server', () => {
  signal.onLine = true;
  let lost = true;
  let loaded = false;
  let retried = 0;
  const shell = fakeShell();
  const banner = offlineBanner({
    shell: () => shell, offline: () => lost, empty: () => !loaded, retry: () => { retried += 1; },
  });
  try {
    const shown = shell.shown.get('offline');
    assert.ok(shown, 'a request found no signal, though the browser says online');
    assert.equal(shown.text, 'errors.offline', 'nothing loaded yet: only that the server can’t be reached');
    assert.equal(shown.action.label, 'kit.retry');
    assert.equal(shown.action.primary, false, '«Reintentar» is not the primary button');
    shown.action.onClick();
    assert.equal(retried, 1);
    loaded = true;
    banner.paint();
    assert.equal(shell.shown.get('offline').text, 'kit.offline.banner');
    lost = false;
    banner.paint();
    assert.equal(shell.shown.has('offline'), false);
  } finally {
    banner.stop();
  }
});

test('offlineBanner: the same words aren’t drawn again, a new language is, and show() gets a way to ask them again', () => {
  signal.onLine = false;
  const shell = fakeShell();
  const banner = offlineBanner({ shell });
  try {
    const first = shell.draws;
    banner.paint();
    banner.paint();
    assert.equal(shell.draws, first, 'the same words: left as they are');
    events.dispatchEvent(new Event('app:language'));
    assert.equal(shell.draws, first + 1, 'a new language: drawn again');
    banner.paint(true);
    assert.equal(shell.draws, first + 2, 'paint(true): drawn again (a new shell)');
  } finally {
    banner.stop();
  }

  let built = null;
  let hidden = 0;
  const own = offlineBanner({ show: (options) => { built = options; }, hide: () => { hidden += 1; } });
  try {
    assert.equal(typeof built, 'function', 'show() gets the options as a function, to ask again');
    assert.equal(built().text, 'kit.offline.banner');
    go(true);
    assert.equal(hidden, 1);
  } finally {
    own.stop();
    signal.onLine = true;
  }
});

test('offlineBanner: sent(n) says the changes arrived, and paints again', () => {
  signal.onLine = true;
  let waiting = 3;
  const shell = fakeShell();
  const banner = offlineBanner({ shell, pending: () => waiting });
  try {
    assert.equal(shell.shown.get('offline').text, 'kit.offline.pending');
    waiting = 0;
    banner.sent(3);
    assert.equal(shell.shown.has('offline'), false, 'nothing waits: gone');
    const notices = () => document.body.all().filter((node) => (node.getAttribute?.('class') || '').split(/\s+/).includes('kit-toast'));
    assert.equal(notices().length, 1, 'a notice');
    assert.match(notices()[0].textContent, /kit\.offline\.sent/);
    banner.sent(0);
    assert.equal(notices().length, 1, 'nothing sent: nothing said');
  } finally {
    banner.stop();
  }
});

test('offlineNotice: «Necesita conexión» and that it shows once the signal is back', () => {
  const notice = offlineNotice({ className: 'kit-settings__offline' });
  assert.equal(notice.getAttribute('class'), 'kit-notice kit-settings__offline');
  assert.equal(notice.getAttribute('role'), 'status');
  assert.equal(notice.querySelector('strong').textContent, 'kit.offline.title');
  assert.equal(notice.querySelector('p').textContent, 'kit.offline.server');
  assert.equal(offlineNotice().getAttribute('class'), 'kit-notice');
});
