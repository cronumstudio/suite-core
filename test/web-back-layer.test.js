/**
 * The layers the system's Back closes (web/ui.js backLayer): Settings and the pages over Work's
 * desk, each with an entry in the history while it is open (audit of 6/11, work-web-8). A window
 * with a history of its own, driven from node.
 *
 *   node --test test/web-back-layer.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';

installFakeDom();
const { backLayer, afterBackLayers } = await import('../web/ui.js');

/** A window's history: entries, where it is, and Back as the browser does it (a popstate a moment later). */
function fakeWindow(href = 'https://work.example.com/?w=tasks:') {
  const listeners = [];
  const win = {
    location: { href },
    addEventListener: (type, fn, capture = false) => listeners.push({ type, fn, capture: Boolean(capture) }),
  };
  const entries = [{ state: null, url: href }];
  let at = 0;
  win.history = {
    get state() { return entries[at].state; },
    get length() { return entries.length; },
    pushState(state, _title, url) {
      entries.splice(at + 1, Infinity, { state: state ?? null, url: url ?? win.location.href });
      at += 1;
      win.location.href = entries[at].url;
    },
    replaceState(state, _title, url) {
      entries[at] = { state: state ?? null, url: url ?? win.location.href };
      win.location.href = entries[at].url;
    },
    back() {
      if (at === 0) return;
      setTimeout(() => {
        at -= 1;
        win.location.href = entries[at].url;
        // At the target, the capture phase's listeners first, then the others, as the browser does.
        const ev = { type: 'popstate', state: entries[at].state, stopped: false, stopImmediatePropagation() { this.stopped = true; } };
        for (const l of [...listeners.filter((x) => x.capture), ...listeners.filter((x) => !x.capture)]) {
          if (l.type !== 'popstate') continue;
          l.fn(ev);
          if (ev.stopped) break;
        }
      }, 0);
    },
  };
  win.entries = entries;
  win.at = () => at;
  return win;
}
const tick = () => new Promise((resolve) => { setTimeout(resolve, 5); });

test('Back closes the layer on top, and the page under it hears nothing', async () => {
  const win = fakeWindow();
  const page = [];
  win.addEventListener('popstate', () => page.push('page walked back'));
  const closed = [];
  backLayer(() => { closed.push('calendar'); }, { win });
  backLayer(() => { closed.push('settings'); }, { win });
  assert.equal(win.history.length, 3, 'an entry each, at the same address');
  assert.ok(win.entries.every((entry) => entry.url === 'https://work.example.com/?w=tasks:'));
  win.history.back();
  await tick();
  assert.deepEqual(closed, ['settings'], 'the one on top');
  win.history.back();
  await tick();
  assert.deepEqual(closed, ['settings', 'calendar']);
  assert.deepEqual(page, [], 'the windows under them stayed');
  win.history.pushState(null, '', 'https://work.example.com/?w=notes:');
  win.history.back();
  await tick();
  assert.deepEqual(page, ['page walked back'], 'with none open, Back is the page’s again');
});

test('a layer that only steps back inside itself keeps its entry; closed by its ×, its entry goes back unheard', async () => {
  const win = fakeWindow();
  const page = [];
  win.addEventListener('popstate', () => page.push('moved'));
  let section = true;
  const layer = backLayer(() => {
    if (section) { section = false; return 'stay'; }
    return null;
  }, { win });
  win.history.back();
  await tick();
  assert.equal(section, false, 'from a section to the list');
  assert.equal(win.history.state?.kitLayer > 0, true, 'still open, with its entry');
  layer.close();
  await tick();
  assert.equal(win.at(), 0, 'its entry taken back');
  assert.deepEqual(page, [], 'nobody under it heard that');
  layer.close();
  await tick();
  assert.equal(win.at(), 0, 'once only');
});

test('what writes the address waits for a layer’s entry to be taken back, and a layer closed by Back has nothing to take', async () => {
  const win = fakeWindow();
  const layer = backLayer(() => null, { win });
  layer.close();
  const order = [];
  afterBackLayers(() => {
    order.push('the shell writes its address');
    win.history.pushState(null, '', 'https://work.example.com/?w=notes:');
  }, { win });
  assert.deepEqual(order, [], 'not before the history went back');
  await tick();
  assert.deepEqual(order, ['the shell writes its address']);
  assert.deepEqual(win.entries.map((e) => e.url), ['https://work.example.com/?w=tasks:', 'https://work.example.com/?w=notes:'], 'no entry left of the layer');
  // Closed by Back: closing it again (its own close() as it goes) takes nothing more back.
  const again = backLayer(() => { again.close(); }, { win });
  win.history.back();
  await tick();
  assert.equal(win.location.href, 'https://work.example.com/?w=notes:');
  assert.equal(win.at(), 1);
  // No history to write in (a page outside a browser): nothing at all.
  assert.doesNotThrow(() => backLayer(() => null, { win: {} }).close());
});

test('Settings in Work’s shell are such a layer: Back from a section to the list on a phone, then out; closed, its entry goes', async () => {
  const fs = await import('node:fs');
  const settings = fs.readFileSync(new URL('../web/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /const layer = workRegistry\(\) \? backLayer\(\(\) => \{\n\s+const stays = !wide\(\) && frame\.hasAttribute\('data-open'\);\n\s+back\(\);\n\s+return stays \? 'stay' : null;\n\s+\}\) : null;/);
  assert.match(settings, /overlay\.remove\(\);\n\s+layer\?\.close\(\);/);
});
