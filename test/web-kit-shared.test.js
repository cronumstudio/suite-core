/**
 * The small pieces Cronum Work's shell and the modules share from the kit, each written once: a
 * page's ground as `rgb()` for its status bar, and the attributes that say how a page is painted
 * (app-start.js); the live dot in words (live.js paintLive); the shell's `/?open=` address of a page
 * (native.js openAddress); a module's mount read from its base (links.js mountOf, mount.js ownerOf).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom } from './fake-dom.js';

const document = installFakeDom();
const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });
const { loadLanguage, t } = await import('../web/i18n.js');
await loadLanguage('en', { remember: false });
globalThis.fetch = realFetch;

const { PAINT_ATTRIBUTES, rgbOf } = await import('../web/app-start.js');

const read = (file) => fs.readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');

test('a ground as rgb(), as a theme-color takes it; one with nothing showing is nothing, or what the caller says', () => {
  const create = document.createElement;
  let pixel = [12, 34, 56, 255];
  const filled = [];
  const pen = { fillStyle: '', fillRect() { filled.push(this.fillStyle); }, getImageData: () => ({ data: pixel }) };
  document.createElement = (tag) => (tag === 'canvas' ? { getContext: () => pen } : create(tag));
  try {
    assert.equal(rgbOf('oklab(0.9 0 0)'), 'rgb(12, 34, 56)');
    assert.deepEqual(filled, ['oklab(0.9 0 0)']);
    pixel = [0, 0, 0, 0];
    assert.equal(rgbOf('transparent'), null, 'nothing to paint');
    assert.equal(rgbOf('transparent', { transparent: 'rgb(0, 0, 0)' }), 'rgb(0, 0, 0)', 'Work’s rail: black, as it always was');
    document.createElement = (tag) => (tag === 'canvas' ? { getContext: () => null } : create(tag));
    assert.equal(rgbOf('red'), null, 'no canvas to read it with');
  } finally {
    document.createElement = create;
  }
  assert.deepEqual(PAINT_ATTRIBUTES, ['data-theme', 'data-look']);
  assert.ok(read('theme.js').includes('app-start.js rgbOf'), 'theme.js, a classic script, says whose its copy is');
});

test('the live dot says its state in words, the frame’s and Cronum Work’s rail’s alike', async () => {
  const { paintLive } = await import('../web/live.js');
  const dot = document.createElement('span');
  for (const state of ['open', 'connecting', 'closed']) {
    paintLive(dot, state);
    assert.equal(dot.getAttribute('data-state'), state);
    assert.equal(dot.title, t(`kit.live.${state}`));
    assert.equal(dot.getAttribute('aria-label'), dot.title);
  }
  assert.match(read('shell.js'), /function setLive\(state\) \{\s*paintLive\(live, state\);\s*\}/, 'the frame’s dot');
});

test('the shell’s address that opens something has one writer, the hash kept unless left out', async () => {
  const { openAddress } = await import('../web/native.js');
  assert.equal(openAddress('/today/?v=done'), '/?open=%2Ftoday%2F%3Fv%3Ddone', 'a path, as it is');
  const url = new URL('https://work.example/notes/?a=1#/n/55');
  assert.equal(openAddress(url), `/?open=${encodeURIComponent('/notes/?a=1#/n/55')}`);
  assert.equal(openAddress(url, { hash: false }), `/?open=${encodeURIComponent('/notes/?a=1')}`);
  assert.match(read('settings.js'), /href: shell \? openAddress\(url\) : url,/, 'Settings’ link to the day');
  assert.match(read('native.js'), /return `\$\{openAddress\(url\)\}\$\{billing \?/, 'a module’s page alone, back from paying too');
  const writers = (file) => (read(file).match(/`\/\?open=\$\{/g) || []).length;
  assert.equal(writers('native.js'), 1, 'openAddress itself');
  assert.equal(writers('settings.js'), 0);
});

test('a module’s mount is read from its base by one rule: links.js asks mount.js, with the same answers as before', async () => {
  const { mountOf } = await import('../web/links.js');
  const { ownerOf } = await import('../web/mount.js');
  const before = (base) => /^\/([a-z][a-z0-9-]{1,30})\/$/.exec(base)?.[1] || null;
  for (const base of ['/tasks/', '/notes/', '/x-1/', '/', '/a/', '/Tasks/', '/tasks/list/', 'tasks', '', null, undefined, 7]) {
    assert.equal(mountOf(base), before(base), String(base));
  }
  assert.equal(ownerOf('/next/'), mountOf('/next/'));
  assert.ok(!read('links.js').includes('{1,30})\\/$/'), 'no rule of its own');
});
