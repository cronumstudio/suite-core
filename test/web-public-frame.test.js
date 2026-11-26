/**
 * A module's public page started by the kit (web/public-frame.js), in the fake DOM with no catalog
 * (each text shows its key): what it asks, and what it draws for each answer, framed by the bar and
 * the foot or embedded without them; a page that couldn't load, for a module that says so; a frame
 * its owner's plan doesn't allow, in either look; and reading it again while it is in sight.
 *
 *   node --test test/web-public-frame.test.js
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installPublicPage, drawn } from './public-page-dom.js';
import { el } from '../web/dom.js';
import { embeddedPage, CRONUM_WORK } from '../web/public-frame.js';

const SCRIPT = new URL('./fixtures/public-frame-page.js', import.meta.url);
const page = installPublicPage({ path: '/tasks/shared.html', title: 'Tasks' });
const WORDS = { brand: 'shared.bar.brand', pitch: 'shared.bar.pitch', made: 'shared.made', makeYours: 'shared.makeYours' };
const drawList = (data) => [el('h2', { text: data.list.name }), null, el('p', { text: 'the rest' })];

/** The page started with these options (the module's), its server answering `answer`. */
const open = (options = {}, how = {}) => {
  globalThis.publicPage = { key: 'list', icon: 'icons/favicon.svg?v=2', words: WORDS, draw: drawList, ...options };
  return page.open(SCRIPT, how);
};

const BAR = '<header class="sp-bar">'
  + `<a aria-label="shared.bar.brand" class="sp-bar__brand" href="${CRONUM_WORK}" rel="noopener">`
  + '<img alt="" height="22" src="icons/favicon.svg?v=2" width="22"></img><span class="sp-bar__name">shared.bar.brand</span></a>'
  + '<span class="sp-bar__pitch">shared.bar.pitch</span>'
  + `<a class="sp-bar__cta" href="${CRONUM_WORK}" rel="noopener">kit.public.startFree</a></header>`;
const FOOT = '<footer class="sp-foot">'
  + '<span class="sp-foot__made"><img alt="" height="18" src="icons/favicon.svg?v=2" width="18"></img>shared.made</span>'
  + `<a class="sp-foot__link" href="${CRONUM_WORK}" rel="noopener">shared.makeYours</a></footer>`;
const GONE = '<div class="sp-gone"><span aria-hidden="true" class="sp-hero__dot"></span>'
  + '<h1>kit.public.goneTitle</h1><p>errors.public_not_found</p></div>';
const FAILED = '<div class="sp-gone"><span aria-hidden="true" class="sp-hero__dot"></span>'
  + '<h1>shared.failedTitle</h1><p>shared.failedText</p>'
  + '<button class="kit-btn kit-btn--primary" on="click" type="button">kit.retry</button></div>';
const OWN = 'https://work.example/tasks/shared.html?p=a-page-link';
const CARD = '<div class="sp-refused"><img alt="" height="28" src="icons/favicon.svg?v=2" width="28"></img>'
  + `<p>kit.public.cantEmbed</p><a class="sp-foot__link" href="${OWN}" rel="noopener" target="_blank">kit.public.openPage</a></div>`;
const PLAIN = '<div class="sp-gone sp-not-here"><span aria-hidden="true" class="sp-hero__dot"></span>'
  + `<p>kit.public.cantEmbed</p><a class="kit-btn kit-btn--primary" href="${OWN}" rel="noopener" target="_blank">kit.public.openPage</a></div>`;
const FAILED_WORDS = { title: 'shared.failedTitle', text: 'shared.failedText' };

const LIST = { list: { name: 'Garden', icon: '🌱' } };
const ok = (body) => ({ status: 200, body });
const FAILURES = ['offline', { status: 503, body: { error: 'unavailable' } }, { status: 429, body: { error: 'rate_limited' } }, { status: 200, text: 'not json' }];

test('there: the bar, what the module draws (its nulls left out), the foot; the tab says its emoji and name', async () => {
  let given = null;
  const shown = await open({ draw: (data, context) => { given = context; return drawList(data); } }, { answer: ok(LIST), token: 'the token' });
  assert.deepEqual(shown.asked.map((a) => [a.url, a.options]), [
    ['https://work.example/tasks/api/public/the%20token', { credentials: 'omit', cache: 'no-store' }],
  ]);
  assert.deepEqual(shown.parts, [BAR, '<h2>Garden</h2>', '<p>the rest</p>', FOOT]);
  assert.equal(shown.title, '🌱 Garden');
  assert.equal(given.page, shown.page);
  assert.equal(given.embedded, false);
  assert.equal(shown.busy, false);
  assert.equal(shown.htmlClass, '');
  assert.equal(shown.head, '<head></head>');
  assert.equal((await open({}, { answer: ok({ list: { name: 'Bare', icon: null } }) })).title, 'Bare', 'no emoji: its name');
  assert.equal((await open({ title: () => 'Its own' }, { answer: ok(LIST) })).title, 'Its own', 'the module’s title');
});

test('embedded (`embed=1`, or framed without it): asked so, only what the module draws, its links outside the frame', async () => {
  for (const how of [{ embed: true }, { framed: true }]) {
    let embedded = null;
    const shown = await open({ draw: (data, context) => { embedded = context.embedded; return drawList(data); } }, { answer: ok(LIST), ...how });
    assert.equal(shown.asked[0].url, 'https://work.example/tasks/api/public/a-page-link?embed=1');
    assert.deepEqual(shown.parts, ['<h2>Garden</h2>', '<p>the rest</p>']);
    assert.equal(embedded, true);
    assert.equal(shown.htmlClass, 'sp-embedded');
    assert.equal(shown.head, '<head><base target="_blank"></base></head>');
  }
});

test('the way to start one’s own is where the install invites (SIGNUP_URL): none, no «Start free» and no link in the foot', async () => {
  const plain = await open({}, { answer: ok(LIST), signup: null });
  assert.deepEqual(plain.parts, [
    BAR.replace(/<a class="sp-bar__cta"[^]*?<\/a>/, ''), '<h2>Garden</h2>', '<p>the rest</p>',
    FOOT.replace(/<a class="sp-foot__link"[^]*?<\/a>/, ''),
  ], 'an install that invites nobody: the bar’s name and the foot’s line stay');
  const own = await open({}, { answer: ok(LIST), signup: 'https://tasks.example.org/join' });
  assert.deepEqual([own.parts[0], own.parts.at(-1)], [
    BAR.replace(`class="sp-bar__cta" href="${CRONUM_WORK}"`, 'class="sp-bar__cta" href="https://tasks.example.org/join"'),
    FOOT.replace(`class="sp-foot__link" href="${CRONUM_WORK}"`, 'class="sp-foot__link" href="https://tasks.example.org/join"'),
  ], 'an install’s own sign-up');
  assert.notEqual(own.parts[0], BAR);
  const odd = await open({}, { answer: ok(LIST), signup: 'javascript:alert(1)' });
  assert.ok(!odd.html.includes('sp-bar__cta') && !odd.html.includes('javascript'), 'only an http(s) address leads anywhere');
});

test('whether it is embedded: by the address, or by a frame, whoever’s it is; never an error', () => {
  const win = { location: {} };
  win.self = win;
  win.top = win;
  assert.equal(embeddedPage(win, '?p=x'), false);
  assert.equal(embeddedPage(win, '?p=x&embed=1'), true);
  assert.equal(embeddedPage(win, '?p=x&embed=0'), false);
  assert.equal(embeddedPage({ ...win, self: win, top: { another: 'site' } }, '?p=x'), true);
});

test('gone: a 404, another 403, an answer without what the page shows, and without `failed` any failure too', async () => {
  const answers = [{ status: 404, body: { error: 'public_not_found' } }, { status: 403, body: { error: 'forbidden' } }, ok({ nothing: true }), ...FAILURES];
  for (const answer of answers) {
    const shown = await open({}, { answer });
    assert.deepEqual(shown.parts, [BAR, GONE, FOOT], JSON.stringify(answer));
    assert.equal(shown.title, 'kit.public.goneTitle');
    assert.equal(shown.busy, false);
  }
  assert.deepEqual((await open({}, { embed: true })).parts, [GONE], 'embedded: no bar, no foot');
});

test('with `failed`: no network, a 5xx, a 429 or an answer that isn’t JSON say it couldn’t load, and the retry reads again', async () => {
  for (const answer of FAILURES) {
    const shown = await open({ failed: FAILED_WORDS }, { answer });
    assert.deepEqual(shown.parts, [BAR, FAILED, FOOT], JSON.stringify(answer));
    assert.equal(shown.title, 'Tasks', 'the tab keeps its title');
  }
  const gone = await open({ failed: FAILED_WORDS }, { answer: { status: 404, body: {} } });
  assert.deepEqual(gone.parts, [BAR, GONE, FOOT], 'a 404 is still gone');
  let answer = 'offline';
  const shown = await open({ failed: FAILED_WORDS }, { embed: true, answer: () => answer });
  assert.deepEqual(shown.parts, [FAILED]);
  answer = ok(LIST);
  shown.page.querySelector('button').click();
  await page.settle();
  assert.deepEqual(shown.page.children.map(drawn), ['<h2>Garden</h2>', '<p>the rest</p>']);
  assert.equal(shown.asked.length, 2);
});

test('refused (403 embed_not_allowed): the card with the module’s mark, or as the gone page says it; the foot under either', async () => {
  const refused = { status: 403, body: { error: 'embed_not_allowed' } };
  const card = await open({}, { embed: true, answer: refused });
  assert.deepEqual(card.parts, [CARD, FOOT]);
  assert.equal(card.title, 'Tasks', 'the tab keeps its title');
  const plain = await open({ refusedAs: 'gone', openClass: 'kit-btn kit-btn--primary' }, { embed: true, answer: refused });
  assert.deepEqual(plain.parts, [PLAIN, FOOT]);
  const own = await open({ openClass: 'sp-refused__open' }, { embed: true, answer: refused });
  assert.match(own.parts[0], /<a class="sp-refused__open" href=/, 'the link in the module’s look');
});

test('with `reread`: read again while in sight, drawn only when it changed; a failing reading leaves it; hidden, nothing', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let answer = ok(LIST);
    let draws = 0;
    const shown = await open({ reread: 1000, failed: FAILED_WORDS, draw: (data) => { draws += 1; return drawList(data); } }, { answer: () => answer });
    const first = shown.page.children[0];
    mock.timers.tick(1000);
    await page.settle();
    assert.equal(shown.asked.length, 2);
    assert.equal(draws, 1, 'the same answer draws nothing');
    assert.equal(shown.page.children[0], first);
    answer = ok({ list: { name: 'Orchard', icon: null } });
    mock.timers.tick(1000);
    await page.settle();
    assert.match(drawn(shown.page), /<h2>Orchard<\/h2>/);
    assert.equal(globalThis.document.title, 'Orchard');
    answer = { status: 503, body: {} };
    mock.timers.tick(1000);
    await page.settle();
    assert.match(drawn(shown.page), /<h2>Orchard<\/h2>/, 'a failing reading leaves the page');
    globalThis.document.visibilityState = 'hidden';
    mock.timers.tick(5000);
    await page.settle();
    assert.equal(shown.asked.length, 4, 'hidden, it asks nothing');
    globalThis.document.visibilityState = 'visible';
    answer = { status: 404, body: {} };
    globalThis.document.dispatch('visibilitychange');
    await page.settle();
    assert.equal(shown.asked.length, 5, 'back in sight, at once');
    assert.deepEqual(shown.page.children.map(drawn), [BAR, GONE, FOOT]);
  } finally {
    mock.timers.reset();
    globalThis.document.visibilityState = 'visible';
  }
});

test('the page’s sheet: the refused page as the gone page says it, and one rule for the foot under either look', () => {
  const css = fs.readFileSync(new URL('../web/public-page.css', import.meta.url), 'utf8');
  assert.match(css, /\.sp-gone\.sp-not-here \{[^}]*display: grid;/);
  assert.match(css, /^\.sp-refused \+ \.sp-foot, \.sp-not-here \+ \.sp-foot \{ margin-top: 20px; padding-top: 14px; justify-content: center; \}$/m);
  assert.match(css, /^\.sp-gone \.sp-hero__dot \{/m, 'the gone page’s dot is the hero’s, in the yolk');
});
